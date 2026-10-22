/**
 * Tests for the candidate queue rules.
 *
 * These matter because a stale candidate that still looks approvable is worse
 * than no queue at all: a person would approve a rewrite against a file that
 * changed underneath it and never learn that the approval was meaningless.
 */
import assert from 'node:assert/strict'
import {
  ageInDays,
  annotateQueue,
  describeStale,
  digest,
  evaluateStaleness,
  findByName,
  isLive
} from '../lib/candidates.js'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const NOW = new Date('2026-01-31T00:00:00.000Z')

function daysAgo(days) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

/** A catalog probe that knows about exactly the names given. */
function catalog(entries = {}) {
  return async (name) => {
    const entry = entries[name]
    if (entry === undefined) return { exists: false }
    return { exists: true, owned: entry.owned ?? true, body: entry.body }
  }
}

const lookupNone = catalog()
const base = {
  ttlDays: 30,
  now: NOW,
  lookup: lookupNone
}

console.log('digest')
{
  check('is stable for the same text', digest('abc') === digest('abc'))
  check('differs for different text', digest('abc') !== digest('abd'))
  check('is eight hex characters', /^[0-9a-f]{8}$/.test(digest('anything')))
  check('handles empty text', /^[0-9a-f]{8}$/.test(digest('')))
  check('handles undefined', /^[0-9a-f]{8}$/.test(digest(undefined)))
}

console.log('ageInDays')
{
  check('counts whole days', ageInDays(daysAgo(10), NOW) === 10)
  check('handles today', ageInDays(NOW.toISOString(), NOW) === 0)
  check('returns zero for junk rather than NaN', ageInDays('not a date', NOW) === 0)
  check('never goes negative for a future timestamp', ageInDays(daysAgo(-5), NOW) === 0)
}

console.log('evaluateStaleness: expiry')
{
  const fresh = await evaluateStaleness({ name: 'a', createdAt: daysAgo(1), kind: 'create' }, base)
  check('a fresh candidate is live', fresh === undefined)

  const old = await evaluateStaleness({ name: 'a', createdAt: daysAgo(40), kind: 'create' }, base)
  check('an old candidate is expired', old?.reason === 'expired', JSON.stringify(old))
  check('the reason names the limit', old.detail.includes('30'), old.detail)

  const edge = await evaluateStaleness({ name: 'a', createdAt: daysAgo(30), kind: 'create' }, base)
  check('exactly at the limit is still live', edge === undefined, JSON.stringify(edge))

  const justOver = await evaluateStaleness({ name: 'a', createdAt: daysAgo(31), kind: 'create' }, base)
  check('one day over is expired', justOver?.reason === 'expired', JSON.stringify(justOver))
}

console.log('evaluateStaleness: source missing')
{
  const gone = await evaluateStaleness(
    { name: 'a', createdAt: daysAgo(0), kind: 'create', sessionId: 's1' },
    { ...base, sessionExists: async () => false }
  )
  check('a missing source session kills the candidate', gone?.reason === 'source-missing', JSON.stringify(gone))

  const live = await evaluateStaleness(
    { name: 'a', createdAt: daysAgo(0), kind: 'create', sessionId: 's1' },
    { ...base, sessionExists: async () => true }
  )
  check('a live source session is fine', live === undefined)

  const refusing = await evaluateStaleness(
    { name: 'a', createdAt: daysAgo(0), kind: 'create', sessionId: 's1' },
    { ...base, sessionExists: async () => { throw new Error('index offline') } }
  )
  check('a probe that throws does not condemn the candidate', refusing === undefined, JSON.stringify(refusing))

  const noProbe = await evaluateStaleness(
    { name: 'a', createdAt: daysAgo(0), kind: 'create', sessionId: 's1' },
    base
  )
  check('omitting the probe skips the check', noProbe === undefined)

  const noSession = await evaluateStaleness(
    { name: 'a', createdAt: daysAgo(0), kind: 'create' },
    { ...base, sessionExists: async () => false }
  )
  check('a candidate with no session id is not condemned', noSession === undefined, JSON.stringify(noSession))
}

console.log('evaluateStaleness: name taken')
{
  const taken = await evaluateStaleness(
    { name: 'a', createdAt: daysAgo(0), kind: 'create' },
    { ...base, lookup: catalog({ a: { owned: false } }) }
  )
  check('a name claimed by another owner is stale', taken?.reason === 'name-taken', JSON.stringify(taken))

  const takenByUs = await evaluateStaleness(
    { name: 'a', createdAt: daysAgo(0), kind: 'create' },
    { ...base, lookup: catalog({ a: { owned: true } }) }
  )
  check('a name claimed even by us blocks a fresh create', takenByUs?.reason === 'name-taken', JSON.stringify(takenByUs))
}

console.log('evaluateStaleness: revisions')
{
  const body = 'the original procedure'
  const revision = {
    name: 'a',
    createdAt: daysAgo(0),
    kind: 'update',
    base: { digest: digest(body) }
  }

  const intact = await evaluateStaleness(revision, { ...base, lookup: catalog({ a: { body } }) })
  check('a revision against an untouched base is live', intact === undefined, JSON.stringify(intact))

  const edited = await evaluateStaleness(revision, { ...base, lookup: catalog({ a: { body: 'somebody changed this' } }) })
  check('a revision against an edited base is stale', edited?.reason === 'base-changed', JSON.stringify(edited))
  check('the detail says the base was edited', edited.detail.includes('edited'), edited.detail)

  const vanished = await evaluateStaleness(revision, { ...base, lookup: catalog() })
  check('a revision whose base vanished is stale', vanished?.reason === 'base-changed', JSON.stringify(vanished))
  check('the detail says it has nothing to update', vanished.detail.includes('no longer exists'), vanished.detail)

  const stolen = await evaluateStaleness(revision, { ...base, lookup: catalog({ a: { owned: false, body } }) })
  check('a revision whose base changed owner is stale', stolen?.reason === 'base-changed', JSON.stringify(stolen))
  check('the detail says ownership changed', stolen.detail.includes('owned by this plugin'), stolen.detail)

  const noDigest = await evaluateStaleness(
    { name: 'a', createdAt: daysAgo(0), kind: 'update' },
    { ...base, lookup: catalog({ a: { body: 'whatever' } }) }
  )
  check('a revision with no recorded base digest is not condemned', noDigest === undefined, JSON.stringify(noDigest))
}

console.log('evaluateStaleness: precedence')
{
  const both = await evaluateStaleness(
    { name: 'a', createdAt: daysAgo(99), kind: 'create' },
    { ...base, lookup: catalog({ a: { owned: false } }) }
  )
  check('expiry is reported before a name clash', both?.reason === 'expired', JSON.stringify(both))
}

console.log('annotateQueue')
{
  const queue = [
    { name: 'fresh', createdAt: daysAgo(0), kind: 'create' },
    { name: 'old', createdAt: daysAgo(90), kind: 'create' }
  ]
  const first = await annotateQueue({ candidates: queue, options: base })
  check('it marks the stale entry', first.candidates[1].stale?.reason === 'expired')
  check('it leaves the fresh entry unmarked', first.candidates[0].stale === undefined)
  check('the first pass reports a change', first.changed === true)

  const second = await annotateQueue({ candidates: first.candidates, options: base })
  check('re-running is idempotent', second.changed === false)

  const stamped = first.candidates[1].stale.at
  const later = await annotateQueue({
    candidates: first.candidates,
    options: { ...base, now: new Date(NOW.getTime() + 60 * 60 * 1000) }
  })
  check('a still-stale entry keeps its original timestamp', later.candidates[1].stale.at === stamped, later.candidates[1].stale.at)

  // Recovery: a name clash that clears. The catalog is re-probed every read, so
  // a candidate blocked by a skill that was since deleted becomes approvable
  // again without anybody resetting it by hand.
  const blocked = await annotateQueue({
    candidates: [{ name: 'x', createdAt: daysAgo(1), kind: 'create' }],
    options: { ...base, lookup: catalog({ x: { owned: false } }) }
  })
  check('a name clash marks the entry', blocked.candidates[0].stale?.reason === 'name-taken', JSON.stringify(blocked.candidates[0].stale))

  const recovered = await annotateQueue({
    candidates: blocked.candidates,
    options: { ...base, lookup: catalog() }
  })
  check('an entry that becomes live again loses the mark', recovered.candidates[0].stale === undefined, JSON.stringify(recovered.candidates[0].stale))
  check('recovering counts as a change', recovered.changed === true)

  const escalated = await annotateQueue({
    candidates: [{ name: 'x', createdAt: daysAgo(99), kind: 'create', stale: { reason: 'name-taken', detail: 'old reason', at: 'then' } }],
    options: { ...base, lookup: catalog() }
  })
  check('a different reason replaces the old verdict', escalated.candidates[0].stale?.reason === 'expired', JSON.stringify(escalated.candidates[0].stale))
  check('an escalated verdict restamps the time', escalated.candidates[0].stale.at === NOW.toISOString(), escalated.candidates[0].stale.at)
}

console.log('findByName')
{
  const queue = [
    { name: 'a', stale: { reason: 'expired', detail: 'x', at: 'y' } },
    { name: 'a' },
    { name: 'b' }
  ]
  check('it prefers the live entry over a stale namesake', findByName(queue, 'a') === queue[1])
  check('it finds a unique name', findByName(queue, 'b') === queue[2])
  check('it returns undefined when absent', findByName(queue, 'zzz') === undefined)

  const allStale = [{ name: 'a', stale: { reason: 'expired', detail: 'x', at: 'y' } }]
  check('it falls back to a stale entry when that is all there is', findByName(allStale, 'a') === allStale[0])
}

console.log('descriptions and liveness')
{
  check('expiry reads plainly', describeStale({ reason: 'expired', detail: 'd' }) === 'expired — d')
  check('a missing source reads plainly', describeStale({ reason: 'source-missing', detail: 'd' }) === 'source missing — d')
  check('a taken name reads plainly', describeStale({ reason: 'name-taken', detail: 'd' }) === 'name taken — d')
  check('a moved base reads plainly', describeStale({ reason: 'base-changed', detail: 'd' }) === 'base changed — d')
  check('an unmarked candidate is live', isLive({ name: 'a' }) === true)
  check('a marked candidate is not live', isLive({ name: 'a', stale: { reason: 'expired' } }) === false)
  check('a null mark still counts as live', isLive({ name: 'a', stale: null }) === true)
  check('a missing candidate is not live', isLive(undefined) === false)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
