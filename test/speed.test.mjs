/**
 * Tests for the live output-speed meter.
 *
 * The host already reports a speed, but it is `decodeTokens / decodeMs` summed
 * over every step of the conversation: by the twentieth turn it is mostly
 * describing the first nineteen, which is the right answer to "how did this go"
 * and the wrong one to "is it moving right now". This module answers the second
 * question, and the facts it has to work with are unhelpful:
 *
 * - no event carries a live token count. `usage` arrives once, after the message
 *   is over, which is exactly when nobody needs a live number any more;
 * - so the count during generation is an estimate, and an estimate that is never
 *   corrected is a permanent fiction;
 * - and the first delta of a message arrives with almost no time behind it, so a
 *   naive division reports hundreds of tokens a second in the one moment a
 *   person is most likely to be looking.
 *
 * The clock is injected rather than slept through: every assertion here is about
 * what the meter does at a particular instant, and a test that waits two seconds
 * to find out is a test nobody runs.
 */

import {
  CHARS_PER_TOKEN,
  MIN_SPAN_MS,
  SpeedMeter,
  WINDOW_MS,
  estimateTokens,
} from '../packages/ui-evolve/lib/speed.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

/**
 * A meter on a clock the test moves by hand.
 *
 * @returns {{ meter: SpeedMeter, at: (ms: number) => void, advance: (ms: number) => void, time: () => number }} the meter and its controls.
 */
function clocked() {
  let current = 1_000_000
  const meter = new SpeedMeter({ now: () => current })
  return {
    meter,
    at: (ms) => {
      current = ms
    },
    advance: (ms) => {
      current += ms
    },
    time: () => current,
  }
}

// ---- counting what arrived ----

check('a text of forty characters is ten tokens', estimateTokens('x'.repeat(40)) === 10, String(estimateTokens('x'.repeat(40))))
check('and the divisor is the host\'s own', CHARS_PER_TOKEN === 4, String(CHARS_PER_TOKEN))
check('a partial token rounds up rather than down', estimateTokens('xxxxx') === 2, String(estimateTokens('xxxxx')))
check('nothing is not a token', estimateTokens('') === 0, String(estimateTokens('')))
check('and neither is a missing delta', estimateTokens(undefined) === 0, String(estimateTokens(undefined)))

// ---- an idle meter ----

{
  const { meter } = clocked()
  const cold = meter.read('never-seen')
  check('a session nobody has streamed reads as zero', cold.tps === 0 && cold.tokens === 0, JSON.stringify(cold))
  check('and it says it is not active', cold.active === false, JSON.stringify(cold))
  // Reading a session that has never pushed must not create an entry: the map
  // would then grow with every id a health check or a stale panel asks about.
  check('reading does not create the session it read', meter.sessions.size === 0, String(meter.sessions.size))
}

// ---- the speed of a steady stream ----

{
  const { meter, advance } = clocked()
  for (let step = 0; step < 10; step += 1) {
    meter.push('s1', 'x'.repeat(40))
    advance(100)
  }
  const reading = meter.read('s1')
  check('ten deltas of ten tokens is a hundred tokens', reading.tokens === 100, JSON.stringify(reading))
  check('over the second they took to arrive', Math.round(reading.ms) === 1000, JSON.stringify(reading))
  check('which is a hundred tokens a second', Math.round(reading.tps) === 100, JSON.stringify(reading))
  check('and the meter calls that active', reading.active === true, JSON.stringify(reading))
}

// ---- the first delta has no time behind it ----

{
  const { meter, advance } = clocked()
  meter.push('fast', 'x'.repeat(400))
  advance(3)
  const reading = meter.read('fast')
  // Four hundred characters is a hundred tokens in three milliseconds, which is
  // thirty-three thousand a second. The floor exists so the number is wrong in a
  // direction a reader can still believe.
  check('one delta is not divided by its own three milliseconds', reading.tps < 1000, JSON.stringify(reading))
  check('it is divided by the shortest span instead', Math.round(reading.ms) === MIN_SPAN_MS, JSON.stringify(reading))
  check('which reports two hundred a second', Math.round(reading.tps) === 200, JSON.stringify(reading))
}

// ---- the window slides ----

{
  const { meter, advance } = clocked()
  meter.push('slide', 'x'.repeat(40))
  // Two and a half seconds, written out rather than written as `WINDOW_MS + 1`.
  // A test that builds its expectation out of the constant under test moves with
  // it: stretch the window to two minutes and the suite still passes, which is
  // the one thing this assertion exists to prevent.
  advance(2500)
  const stale = meter.read('slide')
  check('a delta older than the window is no longer a speed', stale.active === false, JSON.stringify(stale))
  check('and it reads as zero rather than as its last value', stale.tps === 0, JSON.stringify(stale))
  check('the mark is dropped rather than kept for ever', meter.sessions.get('slide').marks.length === 0, String(meter.sessions.get('slide').marks.length))
}

{
  const { meter, advance } = clocked()
  meter.push('edge', 'x'.repeat(40))
  // Just inside, so a window that shrank would fail here and a window that grew
  // would fail above. The two blocks bracket the length from both sides.
  advance(1500)
  check('a delta a second and a half old is still a speed', meter.read('edge').active === true, JSON.stringify(meter.read('edge')))
}

{
  const { meter } = clocked()
  check(
    'the window is two seconds, not a guess',
    WINDOW_MS === 2000,
    `${String(WINDOW_MS)}ms of history: long enough not to flicker, short enough to be now`,
  )
}

{
  const { meter, advance } = clocked()
  meter.push('mixed', 'x'.repeat(40))
  advance(1500)
  meter.push('mixed', 'x'.repeat(80))
  const reading = meter.read('mixed')
  // The old mark is inside the window, the new one is on top of it: ten plus
  // twenty tokens over 1.5 seconds, not twenty over zero.
  check('an older delta inside the window still counts', reading.tokens === 30, JSON.stringify(reading))
  check('and the span is measured from the oldest one kept', Math.round(reading.ms) === 1500, JSON.stringify(reading))
}

// ---- correction by the provider's real count ----

{
  const { meter } = clocked()
  // Ten deltas of ten estimated tokens, and the provider says thirty.
  for (let step = 0; step < 10; step += 1) meter.push('ratio', 'x'.repeat(40))
  meter.settle('ratio', 30)
  check('the measured ratio is kept, not the difference', Math.round((meter.ratios.get('ratio') ?? 0) * 100) === 30, String(meter.ratios.get('ratio')))
  const next = meter.read('ratio')
  check('and it scales the estimate', Math.round(next.tokens) === 30, JSON.stringify(next))
  check('without moving the time it took', Math.round(next.ms) === MIN_SPAN_MS, JSON.stringify(next))
}

{
  const { meter } = clocked()
  for (let step = 0; step < 10; step += 1) meter.push('again', 'x'.repeat(40))
  meter.settle('again', 30)
  // The next message streams through the same estimator, so the correction has
  // to survive it: a correction that only fixed the total would leave every
  // later reading wrong by the same factor.
  for (let step = 0; step < 10; step += 1) meter.push('again', 'x'.repeat(40))
  const reading = meter.read('again')
  check('the correction outlives the message it was measured on', Math.round(reading.tokens) === 60, JSON.stringify(reading))
}

{
  const { meter } = clocked()
  for (let step = 0; step < 10; step += 1) meter.push('weird', 'x'.repeat(40))
  // A provider that reports a tenth of what arrived is not describing the same
  // thing this meter counts. An unbounded correction would let one odd turn
  // redefine every later reading.
  meter.settle('weird', 1)
  check('an implausibly low ratio is clamped rather than obeyed', meter.ratios.get('weird') === 0.25, String(meter.ratios.get('weird')))
}

{
  const { meter } = clocked()
  for (let step = 0; step < 10; step += 1) meter.push('huge', 'x'.repeat(40))
  meter.settle('huge', 100000)
  check('an implausibly high ratio is clamped too', meter.ratios.get('huge') === 4, String(meter.ratios.get('huge')))
}

// ---- settles that describe nothing ----

{
  const { meter } = clocked()
  meter.settle('nothing', 100)
  check('a settle with no deltas behind it records no ratio', meter.ratios.has('nothing') === false, String(meter.ratios.get('nothing')))
  // Not `|| marks.length === 0`: an entry created merely to answer "is there
  // anything to divide" is a session left behind for every agent frame in the
  // process, and an assertion that accepts it can never notice.
  check('and it does not leave a session behind', meter.sessions.has('nothing') === false, JSON.stringify([...meter.sessions.keys()]))
}

{
  const { meter } = clocked()
  for (let step = 0; step < 10; step += 1) meter.push('bad', 'x'.repeat(40))
  meter.settle('bad', undefined)
  meter.settle('bad', Number.NaN)
  meter.settle('bad', -5)
  check('a message without a usage count teaches nothing', meter.ratios.has('bad') === false, String(meter.ratios.get('bad')))
  check('and the estimate is left at its own scale', Math.round(meter.read('bad').tokens) === 100, JSON.stringify(meter.read('bad')))
}

{
  const { meter } = clocked()
  for (let step = 0; step < 10; step += 1) meter.push('zero', 'x'.repeat(40))
  meter.settle('zero', 0)
  // Zero is a number the provider can legitimately report for a message it
  // assembled without generating (a replay, a cache hit). It is not a ratio.
  check('a reported zero is not a ratio of zero', meter.ratios.has('zero') === false, String(meter.ratios.get('zero')))
}

// ---- sessions do not grow without bound ----

{
  const { meter } = clocked()
  meter.push('gone', 'x'.repeat(40))
  meter.settle('gone', 10)
  meter.forget('gone')
  check('a disposed session keeps no speed', meter.sessions.has('gone') === false, String(meter.sessions.size))
  check('and no correction either', meter.ratios.has('gone') === false, String(meter.ratios.size))
  check('forgetting a session that was never seen is not an error', meter.forget('never') === undefined, 'threw')
}

// ---- the meter refuses ids it cannot key on ----

{
  const { meter } = clocked()
  meter.push('', 'x'.repeat(40))
  meter.push(undefined, 'x'.repeat(40))
  meter.settle('', 10)
  check('an empty id is not a session', meter.sessions.size === 0, String(meter.sessions.size))
  const reading = meter.read('')
  check('and reading it is not active', reading.active === false && reading.tps === 0, JSON.stringify(reading))
}

// ---- a delta that carries no text ----

{
  const { meter } = clocked()
  meter.push('blank', '')
  meter.push('blank', undefined)
  check('a delta with no text is not a mark', meter.sessions.get('blank')?.marks.length === 0, JSON.stringify(meter.sessions.get('blank')))
  check('and it is not an active reading', meter.read('blank').active === false, JSON.stringify(meter.read('blank')))
}

// Reasoning streams at its own rate and the caller does not feed it here; what
// this meter must not do is treat an empty text as a zero-token event that keeps
// the window alive. That is asserted above. What it also must not do is divide by
// a window that only just opened, which is asserted below.

{
  const { meter, advance } = clocked()
  meter.push('slow', 'x'.repeat(4))
  advance(MIN_SPAN_MS)
  const reading = meter.read('slow')
  // One token in five hundred milliseconds is two a second, and a number that
  // small has to survive rounding in the badge rather than being reported as
  // zero by the meter.
  check('a trickle is still a positive speed', reading.tps > 0, JSON.stringify(reading))
  check('and it is the trickle it should be', Math.round(reading.tps) === 2, JSON.stringify(reading))
}

{
  // An attempt that is abandoned never gets a settle: the provider never sent a
  // usage block, so `message` would keep the abandoned text and the retry's
  // division would come out at a quarter of the truth. `begin` is the only thing
  // that clears it without a provider count, and it must leave the window alone —
  // those deltas really did arrive and the reading is about the last two seconds.
  const { meter, advance } = clocked()
  meter.push('retry', 'x'.repeat(400))
  advance(600)
  const before = meter.read('retry')
  check('the abandoned attempt left a reading', before.tokens > 0 && before.active === true, JSON.stringify(before))
  meter.begin('retry')
  const after = meter.read('retry')
  check('starting again keeps the last two seconds on screen', after.tokens === before.tokens && after.active === true, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
  // Fifty tokens reported against the ten estimated ones of the retry is a scale
  // of five, clamped to four. Without the reset the denominator would also carry
  // the abandoned attempt's hundred, and the scale would come out at a fifth of
  // the truth.
  meter.push('retry', 'x'.repeat(40))
  meter.settle('retry', 50)
  const scaled = meter.read('retry')
  check('and the scale is learned from this attempt alone', scaled.tokens > after.tokens, `${after.tokens} -> ${scaled.tokens}`)
  check('at the rate the retry actually produced', Math.round(scaled.tps) > 100, JSON.stringify(scaled))
}

{
  const { meter } = clocked()
  meter.push('empty', 'x'.repeat(40))
  meter.begin('empty')
  meter.settle('empty', 10)
  const reading = meter.read('empty')
  // The window still holds the ten tokens, but the scale learned nothing: a
  // settle with an empty accumulator is not a measurement and must leave the
  // ratio at whatever it was (here, one).
  check('a begin with nothing behind it learns no scale', reading.tokens === 10, JSON.stringify(reading))
  check('and it does not divide by zero into infinity', Number.isFinite(reading.tps), JSON.stringify(reading))
}

{
  const fresh = clocked()
  // A begin for a session that never streamed is not an error and not an entry.
  fresh.meter.begin('never-seen')
  check('a begin for an unknown session allocates nothing', fresh.meter.sessions.has('never-seen') === false, JSON.stringify([...fresh.meter.sessions.keys()]))
}
const summary = `${passed} passed, ${failed} failed`

if (failed > 0) {
  for (const failure of failures) console.log(`FAIL ${failure}`)
  console.log(summary)
  process.exit(1)
}
console.log(summary)
