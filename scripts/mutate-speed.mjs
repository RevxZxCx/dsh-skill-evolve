// Prove the live speed badge is guarded on both sides of the wire.
//
// The feature has an unusual failure mode: every part of it can be wrong and
// still look like a working panel, because the badge is the only thing on screen
// that appears and disappears on its own. A meter whose window never expires
// shows a number forever; a client that never asks again shows one number
// forever; a route that answers the wrong session shows a plausible number for
// the wrong conversation. None of those throw, and none of them are visible in a
// screenshot taken a second after the reply stopped.
//
// Three layers, three suites:
//
//   * `speed.js` — the arithmetic. Windows, the divisor floor, and the ratio the
//     meter learns from the provider. `test/speed.test.mjs`.
//   * `api.js` + `index.js` — the wire. A reading has to reach the route, and
//     the route has to refuse the requests it cannot answer.
//     `test/api.test.mjs` and `test/index.test.mjs`.
//   * `client.js` — the three clocks. A live reading is asked for four times a
//     second, a just-finished one every two seconds, an idle one every ten, and
//     the number outlives the reading by a few seconds instead of blinking out
//     the instant the window empties. `test/client.test.mjs`.
//
// The two failure modes this repo's mutation scripts have been burned by are
// handled the way every other script here handles them: an anchor that no
// longer matches is its own outcome (NOT APPLIED) rather than a survival, and a
// run with no tally line is CRASHED rather than either answer. A green run with
// no baseline check means nothing, so the baseline runs first.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))

const api = path.join(repo, 'packages', 'ui-evolve', 'lib', 'api.js')
const client = path.join(repo, 'packages', 'ui-evolve', 'lib', 'client.js')
const index = path.join(repo, 'packages', 'ui-evolve', 'lib', 'index.js')
const speed = path.join(repo, 'packages', 'ui-evolve', 'lib', 'speed.js')

/**
 * Failures reported by a suite, or -1 when it printed no tally at all.
 *
 * The tally is the only honest source: a crash prints no `FAIL` row, so counting
 * rows would call a crashed run a survival.
 */
function failures(output) {
  const match = /(\d+) passed, (\d+) failed/.exec(output)
  return match === null ? -1 : Number(match[2])
}

function run(suites) {
  const outputs = []
  for (const suite of suites) {
    try {
      outputs.push(execFileSync(process.execPath, [path.join(repo, suite)], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      }))
    } catch (error) {
      outputs.push(`${error.stdout ?? ''}${error.stderr ?? ''}`)
    }
  }
  // Every suite has to have reported. A run that names two and only hears from
  // one has not established anything about the other.
  let total = 0
  for (const output of outputs) {
    const count = failures(output)
    if (count < 0) return -1
    total += count
  }
  return total
}

const meter = ['test/speed.test.mjs']
const wire = ['test/api.test.mjs', 'test/index.test.mjs']
const view = ['test/client.test.mjs']

const mutations = [
  // ---------------------------------------------------------------------
  // The meter: what the window counts and what it divides by
  // ---------------------------------------------------------------------
  {
    file: speed,
    suites: meter,
    label: 'the window keeps the whole session',
    from: 'const WINDOW_MS = 2000',
    to: 'const WINDOW_MS = 120000',
    why: 'a two-minute window is a session average wearing the word "now": it stops moving during a reply, which is the only time anyone reads it',
  },
  {
    file: speed,
    suites: meter,
    label: 'the window forgets everything immediately',
    from: 'const WINDOW_MS = 2000',
    to: 'const WINDOW_MS = 0',
    why: 'a window of zero expires every mark as it arrives, so the meter reads inactive for a stream that is visibly streaming',
  },
  {
    file: speed,
    suites: meter,
    label: 'marks that fell out of the window are kept',
    from: '    while (drop < entry.marks.length && entry.marks[drop].at < cutoff) drop += 1',
    to: '    while (false) drop += 1',
    why: 'a window that only ever grows reports the average since the session opened, so the number stops responding and the entry grows without bound',
  },
  {
    file: speed,
    suites: meter,
    label: 'the span is not floored, so the first delta reads as a thousand tokens a second',
    from: '    const ms = Math.max(MIN_SPAN_MS, at - oldest)',
    to: '    const ms = Math.max(1, at - oldest)',
    why: 'one delta divided by the three milliseconds since it arrived is the largest number the meter can ever print, and it prints it at the one moment a person is most likely to be looking',
  },
  {
    file: speed,
    suites: meter,
    label: 'the span is floored at a whole window',
    from: '    const ms = Math.max(MIN_SPAN_MS, at - oldest)',
    to: '    const ms = WINDOW_MS',
    why: 'dividing by a fixed two seconds makes the reading a lagging average rather than a measurement: a reply that doubles its rate takes two seconds to say so, and a reply that stops takes two seconds longer to stop',
  },
  {
    file: speed,
    suites: meter,
    label: 'every character counts as a token',
    from: 'const CHARS_PER_TOKEN = 4',
    to: 'const CHARS_PER_TOKEN = 1',
    why: 'the divisor is the whole estimate: four characters per token is what the host itself assumes, and a meter that assumes something else disagrees with the number the provider reports one second later',
  },
  {
    file: speed,
    suites: meter,
    label: 'the estimate rounds down to nothing',
    from: '  return Math.ceil(text.length / CHARS_PER_TOKEN)',
    to: '  return Math.floor(text.length / CHARS_PER_TOKEN)',
    why: 'a stream of one- and two-character deltas rounds to zero tokens each, so a reply that is visibly typing measures as idle',
  },
  {
    file: speed,
    suites: meter,
    label: 'a delta of no tokens still moves the window',
    from: '    if (tokens === 0) return',
    to: '    if (false) return',
    why: 'an empty delta would push a mark with no tokens, moving the oldest timestamp forward and lowering the reported speed with no text to explain it',
  },
  {
    file: speed,
    suites: meter,
    label: 'a real token count is not remembered',
    from: '    this.ratios.set(agentId, Math.min(RATIO_CEILING, Math.max(RATIO_FLOOR, ratio)))',
    to: '    this.ratios.set(agentId, 1)',
    why: 'this is the only thing standing between the estimate and a permanent four-characters-per-token fiction; ignoring it makes every future reading wrong by however far the tokenizer differs, and wrong in the same direction forever',
  },
  {
    file: speed,
    suites: meter,
    label: 'the scale is unbounded',
    from: '    this.ratios.set(agentId, Math.min(RATIO_CEILING, Math.max(RATIO_FLOOR, ratio)))',
    to: '    this.ratios.set(agentId, ratio)',
    why: 'one message the host assembled differently — a replay, a resumed turn, a provider reporting cached tokens — would redefine every later reading by that factor, and a single bad turn would poison the session',
  },
  {
    file: speed,
    suites: meter,
    label: 'the scale has no floor',
    from: '    this.ratios.set(agentId, Math.min(RATIO_CEILING, Math.max(RATIO_FLOOR, ratio)))',
    to: '    this.ratios.set(agentId, Math.min(RATIO_CEILING, ratio))',
    why: 'a provider reporting almost no tokens for a long message drives the scale to zero, and every later reading divides the estimate down to a number that never appears',
  },
  {
    file: speed,
    suites: meter,
    label: 'a negative token count is recorded as a scale',
    from: "    if (!Number.isFinite(ratio) || ratio <= 0) return",
    to: "    if (!Number.isFinite(ratio)) return",
    why: 'a negative count is not a measurement, and letting it through clamps to the floor and shrinks every later reading by four',
  },
  {
    file: speed,
    suites: meter,
    label: 'a settle with nothing behind it is recorded as a scale',
    from: "    if (!Number.isFinite(ratio) || ratio <= 0) return",
    to: "    if (!Number.isFinite(ratio) || ratio < 0) return",
    why: 'a message the host assembled without streaming anything lands on a ratio of exactly zero, and recording that as the scale pushes every later reading under the floor',
  },
  {
    file: speed,
    suites: meter,
    label: 'a settle for a session that never streamed creates one',
    from: '    const entry = this.sessions.get(agentId)\n    if (entry === undefined) return\n    const measured = entry.message',
    to: '    const entry = this.entryOf(agentId)\n    if (entry === undefined) return\n    const measured = entry.message',
    why: '`settle` runs for every finished message in the process; creating an entry to divide nothing by leaves one session per agent that ever produced a message, and `forget` only clears those that were disposed',
  },
  {
    file: speed,
    suites: meter,
    label: 'the measured scale is never applied',
    from: '    const scaled = estimated * (this.ratios.get(agentId) ?? 1)',
    to: '    const scaled = estimated',
    why: 'the ratio is recorded and then ignored, which is worse than not recording it: the correction exists and nothing benefits from it',
  },
  {
    file: speed,
    suites: meter,
    label: 'a forgotten session keeps its scale',
    from: '    this.ratios.delete(agentId)',
    to: '    if (false) this.ratios.delete(agentId)',
    why: 'a session id reused after a restart would inherit a scale learned in a different conversation, and the map grows for the life of the process',
  },
  {
    file: speed,
    suites: meter,
    label: 'a forgotten session keeps its window',
    from: '    this.sessions.delete(agentId)',
    to: '    if (false) this.sessions.delete(agentId)',
    why: 'the same unbounded growth, and the worse half: a reused id starts with the previous conversation\'s marks and reports a speed for text it never saw',
  },
  {
    file: speed,
    suites: meter,
    label: 'an idle session still reads as active',
    from: '    if (entry.marks.length === 0) return { tokens: 0, ms: 0, tps: 0, active: false, last, revision }',
    to: '    if (entry.marks.length === 0) return { tokens: 0, ms: 0, tps: 0, active: true, last, revision }',
    why: '`active: true` is the client\'s instruction to keep asking four times a second; an idle session that claims it is live is a poll a quarter second for the life of the window',
  },
  {
    file: speed,
    suites: meter,
    label: 'a session that never streamed allocates an entry to say so',
    from: '    const entry = this.sessions.get(agentId)\n    if (entry === undefined) return { tokens: 0, ms: 0, tps: 0, active: false, last: null, revision: 0 }',
    to: '    const entry = this.entryOf(agentId)\n    if (entry === undefined) return { tokens: 0, ms: 0, tps: 0, active: false, last: null, revision: 0 }',
    why: 'reading is the most frequent thing that happens to a meter — four times a second per open panel — and a read that writes makes the map grow with every conversation the user merely looked at',
  },

  // ---------------------------------------------------------------------
  // The wire: from the event stream to the route
  // ---------------------------------------------------------------------
  {
    file: index,
    suites: wire,
    label: 'text deltas are never fed to the meter',
    from: '    speeds.push(agentId, chunk.text)',
    to: '    if (false) speeds.push(agentId, chunk.text)',
    why: 'the meter is constructed and wired and never fed, so every reading is inactive and the badge never appears — a feature that looks absent rather than broken',
  },
  {
    file: index,
    suites: wire,
    label: 'thinking counts as output',
    from: '    if (chunk?.type !== \'text-delta\') return',
    to: '    if (chunk?.type !== \'text-delta\' && chunk?.type !== \'reasoning-delta\') return',
    why: 'reasoning streams at its own rate and is not what the reader is watching; folding it in makes the number jump when the model starts thinking and drop when it starts answering',
  },
  {
    file: index,
    suites: wire,
    label: 'the provider\'s count never corrects the estimate',
    from: '    speeds.settle(agentId, text)',
    to: '    if (false) speeds.settle(agentId, text)',
    why: 'without this the estimate is the answer forever: a tokenizer that disagrees by a third disagrees by a third in every reading for the rest of the session',
  },
  {
    file: index,
    suites: wire,
    label: 'reasoning tokens are counted as text',
    from: '    speeds.settle(agentId, text)',
    to: '    speeds.settle(agentId, output)',
    why: '`outputTokens` includes reasoning, and this meter counts only what the reader sees; settling on the whole completion scales every later reading by however much the model thought, which on a reasoning-heavy turn is most of the token budget',
  },
  {
    file: index,
    suites: wire,
    label: 'a tool-call message teaches the scale too',
    from: '    if (Array.isArray(content) && content.some((block) => readToolCallBlock(block) !== undefined)) return',
    to: '    if (false) return',
    why: 'a message that also called a tool reports the tool arguments in `outputTokens` while the deltas behind it are text only, so one long file write in the same message clamps the learned scale to the ceiling and leaves every later reading several times too fast',
  },
  {
    file: index,
    suites: wire,
    label: 'a new attempt keeps the abandoned one\'s text',
    from: '    if (frame?.type === \'start\') {\n      speeds.begin(agentId)\n      return\n    }',
    to: '    if (frame?.type === \'start\') return',
    why: 'an attempt the user abandons never produces a usage block, so its deltas would still be in the accumulator when the retry settles and the scale would come out a quarter of the truth for the rest of the session',
  },
  {
    file: speed,
    suites: meter,
    label: 'starting again throws away the last two seconds',
    from: '    const entry = this.sessions.get(agentId)\n    if (entry === undefined) return\n    entry.message = 0',
    to: '    this.sessions.delete(agentId)\n    return',
    why: 'the window holds text that really did arrive; clearing it makes the badge blink out on every retry and every second step, which is exactly when someone is watching',
  },
  {
    file: speed,
    suites: meter,
    label: 'a begin for a session that never streamed creates one',
    from: '    const entry = this.sessions.get(agentId)\n    if (entry === undefined) return\n    entry.message = 0',
    to: '    const entry = this.entryOf(agentId)\n    entry.message = 0',
    why: 'this runs for every agent frame in the process, and an entry per agent that ever emitted a start frame is an unbounded map of nothing',
  },
  {
    file: index,
    suites: wire,
    label: 'chunk frames are the ones skipped',
    from: '    if (frame?.type !== \'chunk\') return',
    to: '    if (frame?.type === \'chunk\') return',
    why: 'inverting the frame filter keeps every start and end frame and throws away every delta, so the meter never hears about text at all — the same silence as not wiring it, reached from the other side',
  },
  {
    file: index,
    suites: wire,
    label: 'a disposed session keeps its window',
    from: '    speeds.forget(agentId)',
    to: '    if (false) speeds.forget(agentId)',
    why: 'the entry and its learned scale outlive the conversation, and a host running for a week holds one for every session it ever opened',
  },
  {
    file: api,
    suites: wire,
    label: 'the speed route answers a session it was not asked about',
    from: '        return json(res, 200, { ok: true, data: deps.speedOf(agentId) }, headOnly)',
    to: '        return json(res, 200, { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } }, headOnly)',
    why: 'a route that always answers "idle" is indistinguishable from a quiet conversation, so every panel shows nothing and nothing anywhere reports a fault',
  },
  {
    file: api,
    suites: wire,
    label: 'the speed route accepts a request with no session',
    from: '        if (typeof agentId !== \'string\' || agentId.length === 0) {\n          return json(res, 400, { ok: false, code: \'error.agent.missing\', error: \'the speed route needs a session id\' }, headOnly)',
    to: '        if (false) {\n          return json(res, 400, { ok: false, code: \'error.agent.missing\', error: \'the speed route needs a session id\' }, headOnly)',
    why: '`speedOf(undefined)` reads an entry keyed by a non-existent session; at best it answers zero and at worst it grows the map with a key that is not an id',
  },
  {
    file: api,
    suites: wire,
    label: 'a host with no meter answers as though it had one',
    from: '        if (typeof deps.speedOf !== \'function\') {\n          return json(res, 200, { ok: false, code: \'error.speed.absent\', error: \'this panel does not measure output speed\' }, headOnly)',
    to: '        if (false) {\n          return json(res, 200, { ok: false, code: \'error.speed.absent\', error: \'this panel does not measure output speed\' }, headOnly)',
    why: 'the absent-meter answer exists so a client can tell "no speed" from "speed zero"; without it the route throws into the host\'s error path and the badge cannot distinguish the two either',
  },
  {
    file: api,
    suites: wire,
    label: 'the wait is skipped entirely',
    from: '        if (headOnly !== true) await speedWait(deps, req, agentId, url.searchParams)',
    to: '        if (false) await speedWait(deps, req, agentId, url.searchParams)',
    why: 'every request is then answered at once, so the client is back to asking on a timer — and a timer slow enough to be polite is slower than most replies, which is the whole reason the wait exists',
  },
  {
    file: api,
    suites: wire,
    label: 'a head request holds the socket open',
    from: '        if (headOnly !== true) await speedWait(deps, req, agentId, url.searchParams)',
    to: '        await speedWait(deps, req, agentId, url.searchParams)',
    why: 'a health check or a curl -I would then hold a connection for twenty-five seconds with no body to be fresher for, once per probe',
  },
  {
    file: api,
    suites: wire,
    label: 'the wait compares against the meter rather than the caller',
    from: '  const moved = () => deps.speedRevision(agentId) !== after',
    to: `  const started = deps.speedRevision(agentId)
  const moved = () => deps.speedRevision(agentId) !== started`,
    why: 'the caller names the revision it last saw, and that number is what a change is measured against. Comparing with the meter as it stands when the request arrives makes a change that landed between two polls invisible — which is what happening at the end of a reply looks like from the other side of a 250ms gap — so the request sits out the whole deadline for a number that was already final when it asked',
  },
  {
    file: api,
    suites: wire,
    label: 'a wait that starts up to date is answered anyway',
    from: '  if (moved() === true) return Promise.resolve()',
    to: '  if (false) return Promise.resolve()',
    why: 'a caller already at the current revision has nothing to collect, and answering it returns the old fast polling with an open connection bolted on: the panel asks again at once, sees the same revision, and asks again',
  },
  {
    file: api,
    suites: wire,
    label: 'a host with no revision holds every request',
    from: '  if (typeof deps.speedRevision !== \'function\') return Promise.resolve()',
    to: '  if (typeof deps.speedRevision !== \'function\') return new Promise(() => {})',
    why: 'an older host half has no counter to watch, and a promise that never settles is a panel that never paints again — the badge would hang on the first request against such a host',
  },
  {
    file: api,
    suites: wire,
    label: 'the wait ignores the deadline',
    from: '  const deadline = Date.now() + SPEED_WAIT_MS',
    to: '  const deadline = Infinity',
    why: 'a conversation that never produces text would then hold a request forever, so the panel would never learn that the reply it is waiting for was abandoned',
  },
  {
    file: api,
    suites: wire,
    label: 'a change before the deadline is not enough to end the wait',
    from: '      if (moved() === true || Date.now() >= deadline) finish()',
    to: '      if (moved() === true && Date.now() >= deadline) finish()',
    why: 'with an `and` the loop only ends when both are true at once, so a change seen before the deadline is not enough to end the wait — every request sits out its full twenty-five seconds whatever happens',
  },
  {
    file: api,
    suites: wire,
    label: 'a wait that is never answered keeps its timer',
    from: '    const finish = () => {\n      clearInterval(timer)\n      resolve()\n    }',
    to: '    const finish = () => {\n      resolve()\n    }',
    why: 'the interval is not unref\'d in a running host, so an abandoned wait leaves a hundred-millisecond timer ticking for the life of the process — one per request, and a closed panel produces one',
  },

  // ---------------------------------------------------------------------
  // The badge: three clocks and a number that outlives its reading
  // ---------------------------------------------------------------------
  {
    file: client,
    suites: view,
    label: 'a live reading is asked for twice a second',
    from: '    const SPEED_FAST_MS = 250',
    to: '    const SPEED_FAST_MS = 500',
    why: 'the number has to move faster than the eye reads it or it reads as a series of unrelated samples; twice a second is visibly stepped at the speeds a reply actually runs',
  },
  {
    file: client,
    suites: view,
    label: 'a live reading is asked for once every two seconds',
    from: '    const SPEED_FAST_MS = 250',
    to: '    const SPEED_FAST_MS = 2000',
    why: 'the fast clock is the feature: at the slow rate the badge shows the same average the host already shows, one more time, in a place that costs a request',
  },
  {
    file: client,
    suites: view,
    label: 'an active reading is scheduled on the idle clock',
    from: '              schedule(SPEED_FAST_MS)',
    to: '              schedule(SPEED_IDLE_MS)',
    why: 'the reading says the model is typing and the client goes quiet for ten seconds, so the number freezes while the text keeps arriving',
  },
  {
    file: client,
    suites: view,
    label: 'a just-finished reply is watched at the idle rate',
    from: '            schedule(warm === true ? SPEED_SLOW_MS : SPEED_IDLE_MS)',
    to: '            schedule(SPEED_IDLE_MS)',
    why: 'the moment after a paragraph ends is exactly when the next one may start; dropping straight to the idle clock misses the beginning of every second paragraph',
  },
  {
    file: client,
    suites: view,
    label: 'a session that never streamed polls as though it had',
    from: '            schedule(warm === true ? SPEED_SLOW_MS : SPEED_IDLE_MS)',
    to: '            schedule(SPEED_SLOW_MS)',
    why: 'every open panel would ask for a speed every two seconds for a conversation that has never produced one; the long poll is what makes an idle badge cost one request per deadline instead of a request per two seconds',
  },
  {
    file: client,
    suites: view,
    label: 'the long poll never names a revision',
    from: "            const query = after === null ? '' : `&after=${after}`",
    to: "            const query = ''",
    why: 'without the revision the server has nothing to wait for and answers at once, so the client is back to a timer with a two-second floor — the exact behaviour the long poll replaced, at the exact moment a reply begins',
  },
  {
    file: client,
    suites: view,
    label: 'the badge keeps waiting on the revision it first saw',
    from: "            if (typeof next?.revision === 'number' && Number.isFinite(next.revision)) revision.current = next.revision",
    to: '            if (false) revision.current = next.revision',
    why: 'a wait that names a stale revision is answered immediately and forever after, so every request turns into a spin: the panel asks, is told the same old thing changed, and asks again with no delay at all',
  },
  {
    file: client,
    suites: view,
    label: 'the last number vanishes the instant the window empties',
    from: '      const heldFresh = held.current.at !== 0 && now - held.current.at < SPEED_LINGER_MS',
    to: '      const heldFresh = false',
    why: 'the moment the reply stops is the moment the reader looks up; a badge that blinks out exactly then reports nothing at the only time it was wanted',
  },
  {
    file: client,
    suites: view,
    label: 'the last number never expires',
    from: '      const heldFresh = held.current.at !== 0 && now - held.current.at < SPEED_LINGER_MS',
    to: '      const heldFresh = held.current.at !== 0',
    why: 'a number that never expires is a badge that is always there, reporting the speed of a reply that finished an hour ago',
  },
  {
    file: client,
    suites: view,
    label: 'a new conversation inherits the last one\'s number',
    from: '        held.current = { tps: 0, at: 0 }\n        revision.current = null\n        setReading(null)',
    to: '        held.current = held.current\n        revision.current = revision.current',
    why: 'this component instance is reused across conversations, so the held number outlives the one it belongs to and paints for up to four seconds as the next conversation\'s speed — and a stale revision makes the next long poll name a position in a meter the user is no longer looking at',
  },
  {
    file: client,
    suites: view,
    label: 'an abandoned request keeps its connection',
    from: `          if (pending !== null) pending.abort()`,
    to: `          if (pending !== null) pending = null`,
    why: 'a long poll is unanswered for up to twenty-five seconds on purpose, so one left behind by a conversation the reader has left holds a socket and a hundred-millisecond interval on the server until the deadline — and switching a few times in a row stacks them in front of the new conversation',
  },
  {
    file: client,
    suites: view,
    label: 'the repaint timer outlives the panel',
    from: '          if (timer !== null) clearTimeout(timer)\n          if (repaint !== null) clearTimeout(repaint)',
    to: '          if (timer !== null) clearTimeout(timer)',
    why: 'the cleanup is the only place that knows about this timer; leaving it behind means a fired repaint calls a setState on an unmounted component every time a conversation is closed inside the grace period',
  },
  {
    file: client,
    suites: view,
    label: 'each warm poll stacks another repaint timer',
    from: '              if (repaint !== null) clearTimeout(repaint)\n              repaint = setTimeout(',
    to: '              repaint = setTimeout(',
    why: 'a warm window is polled every two seconds and the grace period is four, so two timers are always in flight; without the clear the older one fires first and the second one is the only one that can ever be cancelled',
  },
  {
    file: client,
    suites: view,
    label: 'an expired number is never repainted away',
    from: '            if (held.current.at !== 0) {',
    to: '            if (false) {',
    why: 'nothing else fires at that moment — the next poll is two seconds away — so without this timer the number stays on screen until something unrelated re-renders the panel',
  },
  {
    file: client,
    suites: view,
    label: 'a live reading does not arm the repaint',
    from: '            if (held.current.at !== 0) {',
    to: '            if (next?.active !== true && held.current.at !== 0) {',
    why: 'a reply goes quiet between paragraphs and while a tool call is assembled, and with a held request the next answer can be half a minute away; with the repaint armed only on the non-active path the last live number stays on screen in the live style for the whole pause',
  },
  {
    file: client,
    suites: view,
    label: 'a held request is followed by a wait as long as the hold',
    from: '            const wasHeld = heldFor >= SPEED_WAIT_MS / 2',
    to: '            const wasHeld = false',
    why: 'schedule() runs after the answer arrives, so a delay chosen there is not a margin around the server deadline but a second quiet period of the same length; a reply that lands inside it is one the badge never sees, which is the symptom this whole change exists to remove',
  },
  {
    file: client,
    suites: view,
    label: 'every answer is treated as if it had been held',
    from: '            const wasHeld = heldFor >= SPEED_WAIT_MS / 2',
    to: '            const wasHeld = true',
    why: 'a host that answers at once and ignores `after` would then be asked again with no delay at all, turning the badge into a spin loop against a route that never waits',
  },
  {
    file: client,
    suites: view,
    label: 'the hold is measured from the wrong end',
    from: '            const heldFor = Date.now() - askedAt',
    to: '            const heldFor = 0',
    why: 'a request that really was held then looks instant, so the client falls back to a timer and stops using the long poll it just proved works — the delay is back to being chosen by the client instead of by the event',
  },
  {
    file: client,
    suites: view,
    label: 'a zero reading is shown as a number',
    from: "      const idle = measured === false",
    to: "      const idle = false",
    why: 'a dash and a zero are different statements: the first says nothing is arriving, the second says something arrived at a rate of nothing. Here the number is zero, so the last real reading is replaced by a claim that output is happening at zero speed — a stale number kept on screen is a different mutation, and a different failure',
  },
  {
    file: client,
    suites: view,
    label: 'a host that has no speed route gets a permanent dash',
    from: "      if (known === false) return null",
    to: "      if (false) return null",
    why: 'an older host half has the panel but not the route, and a permanent dash in its header is a widget that will never say anything — the one case where drawing nothing is the honest answer',
  },
  {
    file: speed,
    suites: meter,
    label: 'a message that arrived at once is the fastest ever',
    from: '    const span = Math.max(MIN_SPAN_MS, this.now() - startedAt)',
    to: '    const span = Math.max(1, this.now() - startedAt)',
    why: 'a four-delta message can arrive inside twenty milliseconds, and dividing by that reports five thousand tokens a second — one such message makes the standing number claim a speed the provider never reached, which is the same floor the live window already applies',
  },
  {
    file: speed,
    suites: meter,
    label: 'a settle with no text behind it is recorded as a message',
    from: `    const ratio = outputTokens / measured
    if (!Number.isFinite(ratio) || ratio <= 0) return`,
    to: `    const ratio = outputTokens / measured
    if (!Number.isFinite(ratio) || ratio <= 0) {
      entry.last = { tokens: outputTokens, ms: span }
      return
    }`,
    why: 'a settle nothing streamed behind has no duration to divide by, so recording it would put a message on the badge whose speed is a number the provider never ran at — and it would replace the real last message while doing it',
  },
  {
    file: speed,
    suites: meter,
    label: 'the last message outlives the session that produced it',
    from: `    this.sessions.delete(agentId)
    this.ratios.delete(agentId)`,
    to: `    this.sessions.delete(agentId)`,
    why: 'the ratios map is keyed by session too, so one leaked entry per conversation ever opened, and a reused id inherits a scale learned in a different conversation',
  },
  {
    file: client,
    suites: view,
    label: 'the last message outranks the reading that just stopped',
    from: '      const shown = liveReading !== null ? liveReading.tps : heldFresh === true ? held.current.tps : last !== null ? last.tps : 0',
    to: '      const shown = liveReading !== null ? liveReading.tps : last !== null ? last.tps : heldFresh === true ? held.current.tps : 0',
    why: 'the freshest statement about a reply that just ended is that reply own window, not the previous message; putting the previous message first makes a fast answer look slower the moment it finishes',
  },
  {
    file: client,
    suites: view,
    label: 'a failed ask blanks the badge',
    from: '            schedule(SPEED_IDLE_MS)\n          }\n        }',
    to: '            held.current = { tps: 0, at: 0 }\n            setReading(null)\n            schedule(SPEED_IDLE_MS)\n          }\n        }',
    why: 'one failed request — a reload mid-request, a route that is briefly absent while the host reloads the plugin — would take the number away until the next successful read, and the retry is ten seconds out',
  },
  {
    file: client,
    suites: view,
    label: 'the badge asks about no particular session',
    from: "            const answer = await call(`/speed?agent=${encodeURIComponent(sessionId)}${query}`, { signal: flight.signal })",
    to: '            const answer = await call(`/speed`)',
    why: 'the route answers 400 for a request with no session, and every conversation would then show the same absence while the network log looked healthy',
  },
  {
    file: client,
    suites: view,
    label: 'a slow reading is rounded to zero',
    from: '      if (value >= 10) return String(Math.round(value))\n      return String(Math.round(value * 10) / 10)',
    to: '      return String(Math.round(value))',
    why: 'a reply running at 2.7 tokens a second would print "3" then "2" then "3", and one at 0.4 would print the zero this badge exists never to print',
  },
  {
    file: client,
    suites: view,
    label: 'a fast reading keeps a decimal',
    from: '      if (value >= 10) return String(Math.round(value))\n      return String(Math.round(value * 10) / 10)',
    to: '      return String(Math.round(value * 10) / 10)',
    why: 'at four readings a second a decimal place is a digit that changes for no reason the reader can see, and it makes the badge jump between two widths',
  },
  {
    file: client,
    suites: view,
    label: 'the badge stops asking when the panel closes, only later',
    from: '          request.current += 1\n          if (timer !== null) clearTimeout(timer)',
    to: '          request.current += 1',
    why: 'a timer left armed after unmount asks a route for a session nobody is looking at, and the answer then sets state on a component that is gone',
  },
]

// Baseline first: a workspace that already fails turns every mutation into a
// false KILLED, because "the suite has failures after the mutation" is then true
// before the mutation as well. The other scripts here check this for the same
// reason; this one has to as well, or a green run means nothing.
{
  const suites = [...new Set(mutations.flatMap((mutation) => mutation.suites))]
  const before = run(suites)
  if (before !== 0) {
    console.log('\nBASELINE FAILED — the suites must pass before mutations mean anything')
    console.log('  ' + suites.join(', ') + ' reported ' + (before < 0 ? 'no tally line' : before + ' failed') + ' before any mutation')
    process.exit(1)
  }
}

let killed = 0
const survived = []
const notApplied = []
const crashed = []
const backups = new Map()

// Lines a mutation could target and no assertion would notice, printed with the
// run so a later reader knows the list is complete rather than merely green.
const known = [
  '`estimateTokens` on a non-string is covered by `speed.test.mjs` but not mutated here: the only caller passes `chunk.text`, whose type the host already validated',
  'the `title` attribute on the badge is not mutated: it is decoration, and `test/client.test.mjs` asserts the `aria-label` instead',
]

try {
  for (const mutation of mutations) {
    if (backups.has(mutation.file) === false) backups.set(mutation.file, fs.readFileSync(mutation.file, 'utf8'))
    const original = backups.get(mutation.file)
    if (original.includes(mutation.from) === false) {
      notApplied.push(mutation.label)
      console.log(`NOT APPLIED  ${mutation.label}`)
      continue
    }
    if (original.split(mutation.from).length - 1 !== 1) {
      notApplied.push(mutation.label)
      console.log(`NOT APPLIED  ${mutation.label} — anchor is not unique`)
      continue
    }
    const mutated = original.split(mutation.from).join(mutation.to)
    try {
      fs.writeFileSync(mutation.file, mutated, 'utf8')
      const failed = run(mutation.suites)
      if (failed > 0) {
        killed += 1
        console.log(`KILLED      ${mutation.label} — ${failed} failed`)
      } else if (failed === 0) {
        survived.push(mutation.label)
        console.log(`SURVIVED    ${mutation.label}`)
      } else {
        crashed.push(mutation.label)
        console.log(`CRASHED     ${mutation.label}`)
      }
    } finally {
      fs.writeFileSync(mutation.file, original, 'utf8')
      if (fs.readFileSync(mutation.file, 'utf8') !== original) {
        crashed.push(`${mutation.label} (file was not restored)`)
        console.log(`CRASHED     ${mutation.label} (file was not restored)`)
      }
    }
  }
} finally {
  for (const [file, backup] of backups) fs.writeFileSync(file, backup, 'utf8')
}

for (const mutation of mutations) {
  if (survived.includes(mutation.label)) console.log(`\nUNCOVERED  ${mutation.label}\n  ${mutation.why}`)
  if (crashed.includes(mutation.label)) console.log(`\nCRASHED    ${mutation.label}\n  ${mutation.why}`)
}

for (const line of known) console.log(`\nNOT MUTATED  ${line}`)

const total = mutations.length
console.log(`\n${killed} killed, ${survived.length} survived, ${notApplied.length} not applied, ${crashed.length} crashed  (of ${total})`)
if (survived.length > 0 || notApplied.length > 0 || crashed.length > 0) process.exit(1)
