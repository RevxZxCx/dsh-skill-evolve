/**
 * Tests for the panel's change counter.
 *
 * The counter exists so the panel can stop asking "has anything changed" on a
 * clock. Three properties make that work, and each of them fails silently if it
 * breaks:
 *
 * - it has to go up. A counter that stops moving turns the push channel into a
 *   connection that delivers one frame and then nothing forever, which looks
 *   exactly like a quiet session;
 * - a session nobody has bumped has to read as a real position. Zero is "before
 *   the first event", not "unknown", so a client that read zero and waits for a
 *   different number is waiting for the right thing;
 * - a listener that throws must not take the other listeners with it, and must
 *   not travel back into the emit site. Callers bump from inside host event
 *   handlers, which cannot do anything about a broken stream.
 *
 * The map is also the only per-session state in this plugin that grows with the
 * number of conversations a person has ever opened, which is why `forget` is
 * tested rather than merely written.
 */

import { Revisions } from '../packages/ui-evolve/lib/revision.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push({ label, detail })
}

// --- the number ------------------------------------------------------------

{
  const revisions = new Revisions()
  check('a session nobody bumped reads zero', revisions.read('session-a') === 0, String(revisions.read('session-a')))
  // Zero has to mean "no events yet" rather than "no such session", because both
  // are the same thing to a client that has just opened the panel.
  check('and an unknown session is not a missing answer', revisions.read('never-seen') === 0, String(revisions.read('never-seen')))

  const first = revisions.bump('session-a')
  check('the first bump answers one', first === 1, String(first))
  check('and that is what a read returns', revisions.read('session-a') === 1, String(revisions.read('session-a')))
  const second = revisions.bump('session-a')
  check('the counter goes up by one each time', second === 2, String(second))
  // Strictly increasing is the property the client relies on: it compares for
  // "different", but a counter that went backwards would mean a session's
  // history was being rewritten.
  check('and never goes backwards', revisions.read('session-a') === 2, String(revisions.read('session-a')))

  // Per session, not per process: two conversations in one host must not wake
  // each other's panels.
  revisions.bump('session-b')
  check('another session starts at its own zero', revisions.read('session-b') === 1, String(revisions.read('session-b')))
  check('and does not disturb the first', revisions.read('session-a') === 2, String(revisions.read('session-a')))
}

// --- what a bump tells listeners -------------------------------------------

{
  const revisions = new Revisions()
  const heard = []
  revisions.subscribe((agentId, revision) => heard.push([agentId, revision]))
  revisions.bump('session-a')
  revisions.bump('session-a')
  revisions.bump('session-b')
  check(
    'a listener hears every bump with its session and new number',
    JSON.stringify(heard) === JSON.stringify([['session-a', 1], ['session-a', 2], ['session-b', 1]]),
    JSON.stringify(heard),
  )
}

{
  const revisions = new Revisions()
  let heard = 0
  const unsubscribe = revisions.subscribe(() => { heard += 1 })
  revisions.bump('session-a')
  unsubscribe()
  revisions.bump('session-a')
  check('an unsubscribed listener hears nothing more', heard === 1, `${heard} call(s)`)
}

{
  // Two streams on two sessions are two listeners on one counter. Unsubscribing
  // one must not unhook the other -- that would be a panel that stops updating
  // when a second tab is closed.
  const revisions = new Revisions()
  let first = 0
  let second = 0
  const stopFirst = revisions.subscribe(() => { first += 1 })
  revisions.subscribe(() => { second += 1 })
  revisions.bump('session-a')
  stopFirst()
  revisions.bump('session-a')
  check('closing one stream leaves the other subscribed', first === 1 && second === 2, `${first}/${second}`)
}

{
  // A listener that throws is a closed socket discovering itself. The bump has
  // already happened and the other listeners are still owed their frame.
  const revisions = new Revisions()
  const heard = []
  revisions.subscribe(() => { throw new Error('the socket is gone') })
  revisions.subscribe((agentId, revision) => heard.push([agentId, revision]))
  let next
  let threw = false
  try {
    next = revisions.bump('session-a')
  } catch {
    threw = true
  }
  check('a throwing listener does not reach the bump site', threw === false, threw ? 'the bump threw' : 'no throw')
  check('and the other listener still hears it', heard.length === 1 && heard[0][1] === 1, JSON.stringify(heard))
  check('and the counter moved anyway', next === 1 && revisions.read('session-a') === 1, `${next}/${revisions.read('session-a')}`)
}

// --- dropping a session ----------------------------------------------------

{
  const revisions = new Revisions()
  revisions.bump('session-a')
  revisions.bump('session-a')
  revisions.forget('session-a')
  check('a forgotten session reads zero again', revisions.read('session-a') === 0, String(revisions.read('session-a')))
  // The entry is dropped, not reset: a host that runs for a week must not hold a
  // number for every conversation ever opened.
  check('and it left nothing behind', revisions.sessions.has('session-a') === false, JSON.stringify([...revisions.sessions.keys()]))
  const restarted = revisions.bump('session-a')
  check('and a new agent with the same id starts over', restarted === 1, String(restarted))
  // `read` answers zero for an unknown id whether or not `forget` ran, so it can
  // never be evidence about `forget`. What `forget` can break is the restart: a
  // tombstone left behind would make the next bump count up from somewhere
  // instead of from one.
  revisions.forget('never-seen')
  check('forgetting a session nobody bumped is harmless', revisions.bump('never-seen') === 1, 'bump')
  revisions.forget('never-seen')
  check('and forgetting it again is harmless', revisions.bump('never-seen') === 1, 'bump')
}

// --- asking whether a session is still tracked ------------------------------
//
// `read` cannot answer this: a forgotten session and one that was never bumped
// both read zero. The two late answers on the plugin side (the git sweep and the
// summary landing) need the difference -- they may arrive after `agent/disposed`
// has forgotten the counter, and bumping then would recreate an entry nothing
// will ever remove and let a closed session announce itself twice.
//
// The `read`-based checks below are the point: they would pass if `has` were
// written in terms of `read`, which is the mistake this method exists to avoid.

{
  const revisions = new Revisions()
  check('a session nobody bumped is not tracked', revisions.has('session-a') === false, 'has')

  const next = revisions.bump('session-a')
  check('and bumping it starts tracking it', next === 1 && revisions.has('session-a') === true, `${next}/${revisions.has('session-a')}`)

  revisions.forget('session-a')
  check('and forgetting it stops tracking it', revisions.has('session-a') === false, 'has')
  // Same answer as `read`, different reason: this one is asking about presence,
  // and it distinguishes the two states that `read` collapses into zero.
  check('while the counter reads the same zero it did before it existed', revisions.read('session-a') === 0, String(revisions.read('session-a')))

  // Malformed ids are answered, not thrown at: a late callback can carry an id
  // that has already been discarded.
  check('an id that is not a string is not tracked', revisions.has(undefined) === false && revisions.has(42) === false, 'has')
  check('and an empty id is not tracked', revisions.has('') === false, 'has')
}

// --- a listener that throws must not stop the ones after it ----------------

{
  const revisions = new Revisions()
  const heard = []
  revisions.subscribe(() => {
    throw new Error('this listener is broken')
  })
  revisions.subscribe((agentId, next) => {
    heard.push([agentId, next])
  })
  const next = revisions.bump('session-a')
  check('a broken listener does not stop the next one', heard.length === 1 && heard[0][1] === 1, JSON.stringify(heard))
  check('and the counter moved anyway', next === 1 && revisions.read('session-a') === 1, `${next}/${revisions.read('session-a')}`)
}

// --- and a listener that throws must not reach the emit site ---------------

{
  const failures = []
  const revisions = new Revisions({
    onError: (error, agentId) => {
      failures.push([agentId, error.message])
    },
  })
  revisions.subscribe(() => {
    throw new Error('write EPIPE')
  })
  let threw = false
  try {
    revisions.bump('session-a')
  } catch {
    threw = true
  }
  check('a broken listener does not travel back to the caller', threw === false, String(threw))
  check('and the failure is reported where the caller asked it to be', failures.length === 1 && failures[0][0] === 'session-a' && failures[0][1] === 'write EPIPE', JSON.stringify(failures))
}

// --- a reporting callback that itself throws is still contained ------------

{
  const revisions = new Revisions({
    onError: () => {
      throw new Error('the log threw too')
    },
  })
  const heard = []
  revisions.subscribe(() => {
    throw new Error('broken')
  })
  revisions.subscribe((agentId, next) => {
    heard.push([agentId, next])
  })
  let threw = false
  try {
    revisions.bump('session-a')
  } catch {
    threw = true
  }
  check('a reporting callback that throws does not escape either', threw === false, String(threw))
  // The listener after the broken one still ran: `onError` is the caller's code
  // too, and the promise this module makes is that one bad callback cannot stop
  // the others.
  check('and the next listener still heard it', heard.length === 1 && heard[0][1] === 1, JSON.stringify(heard))
}

// --- malformed ids ---------------------------------------------------------

{
  // Session ids arrive from the host, so the counter cannot assume they are
  // usable. `__proto__` in particular: keyed by an object this would change the
  // container rather than add a row.
  const revisions = new Revisions()
  check('a missing id does not bump', revisions.bump(undefined) === 0 && revisions.read(undefined) === 0, 'undefined')
  check('and neither does an empty one', revisions.bump('') === 0 && revisions.read('') === 0, 'empty')
  check('and neither does a non-string', revisions.bump(42) === 0 && revisions.read(42) === 0, 'number')
  const protoBump = revisions.bump('__proto__')
  check('a proto-shaped id is just a key', protoBump === 1, String(protoBump))
  check('and reading it finds the counter', revisions.read('__proto__') === 1, String(revisions.read('__proto__')))
  check('and the map is still a map', revisions.sessions instanceof Map, String(typeof revisions.sessions))
}

if (failed > 0) {
  for (const failure of failures) console.log(`FAIL ${failure.label} -- ${failure.detail ?? ''}`)
}
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
