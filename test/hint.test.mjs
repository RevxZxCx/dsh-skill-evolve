/**
 * Unit tests for the hint channel.
 *
 * The interesting behaviour is not the rendering — it is the two ways this
 * channel can waste the model's attention:
 *
 * 1. repeating itself (the same habit announced twice in slightly different
 *    shapes), and
 * 2. spending its budget on procedures nobody asked about.
 */

import { HintChannel, isSameHabit, isSubRun, renderHint } from '../lib/hint.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

function channel(overrides = {}) {
  return new HintChannel({ maxHintsPerSession: 4, log: () => {}, ...overrides })
}

console.log('hint.js')

// ---- isSubRun -------------------------------------------------------------
check('a shorter run inside a longer one is found', isSubRun(['a', 'b'], ['a', 'b', 'c']))
check('a longer run is not inside a shorter one', !isSubRun(['a', 'b', 'c'], ['a', 'b']))
check('a non-contiguous match is not a sub-run', !isSubRun(['a', 'c'], ['a', 'b', 'c']))
check('identical runs match', isSubRun(['a', 'b'], ['a', 'b']))
check('an empty needle never matches', !isSubRun([], ['a']))

// ---- isSameHabit ----------------------------------------------------------
//
// These cases come from a real 6,145-call transcript: the same screenshot loop
// was announced twice because the detector observed it starting at different
// offsets, and the channel only compared contiguous runs.
check('equal sequences are one habit', isSameHabit(['a', 'b', 'c'], ['a', 'b', 'c']))
check('a run inside a longer one is one habit', isSameHabit(['a', 'b'], ['a', 'b', 'c']))
check('a rotation is one habit', isSameHabit(['a', 'b', 'c'], ['b', 'c', 'a']))
check('a rotation the other way is one habit', isSameHabit(['a', 'b', 'c'], ['c', 'a', 'b']))
check('a cycle seen through a shifted window is one habit', isSameHabit(['adb', 'py', 'read_image'], ['read_image', 'adb', 'py']))
check(
  'diverging after a shared prefix is two habits',
  !isSameHabit(['read', 'edit', 'bash'], ['read', 'edit', 'grep'])
)
check('unrelated procedures are two habits', !isSameHabit(['read', 'edit', 'bash'], ['adb', 'py', 'read_image']))
check('an empty sequence is never a habit', !isSameHabit([], ['a']))

// ---- dedupe ---------------------------------------------------------------
{
  const hints = channel()
  const first = hints.publish({ agentId: 's', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'first' })
  check('the first publication succeeds', first === 'published')
  check('the same procedure is refused', hints.publish({ agentId: 's', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'x' }) === 'duplicate')
  check(
    'a longer shape of the same habit is refused',
    hints.publish({ agentId: 's', signature: 'a>b>c>d', steps: ['a', 'b', 'c', 'd'], text: 'x' }) === 'duplicate'
  )
  check(
    'a shorter shape of the same habit is refused',
    hints.publish({ agentId: 's', signature: 'b>c', steps: ['b', 'c'], text: 'x' }) === 'duplicate'
  )
  check(
    'an unrelated procedure is allowed',
    hints.publish({ agentId: 's', signature: 'x>y>z', steps: ['x', 'y', 'z'], text: 'x' }) === 'published'
  )
}

// ---- per-agent isolation --------------------------------------------------
{
  const hints = channel()
  hints.publish({ agentId: 'a', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'x' })
  check(
    'another session still gets the hint',
    hints.publish({ agentId: 'b', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'x' }) === 'published'
  )
  check('the first session is unaffected', hints.alreadyShown('a', ['a', 'b', 'c']))
}

// ---- budget ---------------------------------------------------------------
{
  const hints = channel({ maxHintsPerSession: 2 })
  hints.publish({ agentId: 's', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'x' })
  hints.publish({ agentId: 's', signature: 'd>e>f', steps: ['d', 'e', 'f'], text: 'x' })
  check(
    'the budget caps the session',
    hints.publish({ agentId: 's', signature: 'g>h>i', steps: ['g', 'h', 'i'], text: 'x' }) === 'exhausted'
  )
}

// ---- text lifecycle -------------------------------------------------------
{
  const hints = channel()
  check('an unknown agent renders empty', hints.textFor('nobody') === '')
  hints.publish({ agentId: 's', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'hello' })
  check('a published hint renders its text', hints.textFor('s') === 'hello')
  hints.clear('s')
  check('clearing hides the text', hints.textFor('s') === '')
  check('clearing does not forget what was shown', hints.alreadyShown('s', ['a', 'b', 'c']))
  hints.forget('s')
  check('forgetting drops the agent', hints.textFor('s') === '')
  check('forgetting allows the hint again', !hints.alreadyShown('s', ['a', 'b', 'c']))
}

// ---- two-stage ageing -----------------------------------------------------
//
// A hint has two fates and only one of them is loud. When the model ignores a
// hint instead of acting on it, nothing clears the text, so without a deadline
// it rides along in every snapshot. Measured on a complete transcript that was
// 132 snapshots and 79,896 characters of hint text.
//
// The first fix — delete the text after N steps — was wrong, and the same
// transcript showed why: the session eventually submitted a skill 412 steps
// after the hint appeared, from a model that re-read the still-present text.
// So the text degrades to a pointer first and only retires as a separate,
// opt-in stage.
{
  const hints = channel({ shrinkAfterSteps: 2, expiresAfterSteps: 0 })
  hints.publish({ agentId: 's', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'the full hint', pointer: 'ptr' })
  check('a fresh hint shows its full text', hints.textFor('s') === 'the full hint')
  hints.tick('s')
  check('a hint below its shrink deadline keeps full text', hints.textFor('s') === 'the full hint')
  hints.tick('s')
  check('a hint shrinks to its pointer at the deadline', hints.textFor('s') === 'ptr')
  for (let i = 0; i < 100; i += 1) hints.tick('s')
  check('a shrunk hint never retires when retirement is off', hints.textFor('s') === 'ptr')
  check('shrinking keeps the procedure "already shown"', hints.alreadyShown('s', ['a', 'b', 'c']))
  check('shrinking spends no extra budget', hints.state.get('s').emitted === 1)
}
{
  // Retirement is a second, independent stage counted from publication.
  const hints = channel({ shrinkAfterSteps: 1, expiresAfterSteps: 3 })
  hints.publish({ agentId: 's', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'full', pointer: 'ptr' })
  hints.tick('s')
  check('stage one: the pointer', hints.textFor('s') === 'ptr')
  hints.tick('s')
  check('stage one persists', hints.textFor('s') === 'ptr')
  hints.tick('s')
  check('stage two: retired at the retirement deadline', hints.textFor('s') === '')
  check('a retired hint stays "already shown"', hints.alreadyShown('s', ['a', 'b', 'c']))
  check('a retired hint still counts against the budget', hints.state.get('s').emitted === 1)
  check('a retired channel does not keep ageing', hints.state.get('s').age === 0)
}
{
  // The bug this guards: a channel that keeps ageing after retirement would
  // make every later hint born already expired.
  const hints = channel({ shrinkAfterSteps: 0, expiresAfterSteps: 2 })
  hints.publish({ agentId: 's', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'first', pointer: 'p1' })
  hints.tick('s')
  hints.tick('s')
  check('the first hint retired', hints.textFor('s') === '')
  hints.publish({ agentId: 's', signature: 'd>e>f', steps: ['d', 'e', 'f'], text: 'second', pointer: 'p2' })
  check('a later hint starts a fresh window', hints.textFor('s') === 'second')
  hints.tick('s')
  check('the fresh window has its own budget', hints.textFor('s') === 'second')
}
{
  // The same bug, reached without ever calling `textFor`: the detector can
  // publish a replacement while the previous text is still in the channel, and
  // assembly may not have rendered it in between. Only `publish` resetting the
  // age saves this path, so the assertion must not touch `textFor` first.
  const hints = channel({ shrinkAfterSteps: 0, expiresAfterSteps: 2 })
  hints.publish({ agentId: 's', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'first', pointer: 'p1' })
  hints.tick('s')
  hints.tick('s')
  hints.publish({ agentId: 's', signature: 'd>e>f', steps: ['d', 'e', 'f'], text: 'second', pointer: 'p2' })
  check('publishing over a stale age resets it', hints.state.get('s').age === 0)
  check('the replacement is visible on the first render', hints.textFor('s') === 'second')
  hints.tick('s')
  check('the replacement is not born expired', hints.textFor('s') === 'second')
}
{
  const hints = channel({ shrinkAfterSteps: 0, expiresAfterSteps: 2 })
  hints.publish({ agentId: 's', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'hello', pointer: 'ptr' })
  hints.tick('s')
  hints.clear('s')
  check('clearing resets the age', hints.state.get('s').age === 0)
  hints.publish({ agentId: 's', signature: 'd>e>f', steps: ['d', 'e', 'f'], text: 'again', pointer: 'p2' })
  hints.tick('s')
  check('a cleared channel does not shorten the next hint', hints.textFor('s') === 'again')
}
{
  // `0` is the documented off switch for each stage independently. A session
  // with all of them off must not start accumulating ages it will never use.
  //
  // All three, not two: the reflection hold is expressed in the same unit, and
  // leaving it at its default while turning the other two off would keep the
  // counter running for a stage the caller believes is inactive.
  const off = channel({ shrinkAfterSteps: 0, expiresAfterSteps: 0, reflectionHoldSteps: 0 })
  off.publish({ agentId: 's', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'forever', pointer: 'ptr' })
  for (let i = 0; i < 50; i += 1) off.tick('s')
  check('zero disables all three stages', off.textFor('s') === 'forever')
  check('a disabled channel does not accumulate age', off.state.get('s').age === 0)

  const undef = channel({ reflectionHoldSteps: 0 })
  undef.publish({ agentId: 's', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'forever', pointer: 'ptr' })
  for (let i = 0; i < 50; i += 1) undef.tick('s')
  check('omitted shrink and expire keep the full text', undef.textFor('s') === 'forever')

  const idle = channel({ shrinkAfterSteps: 3 })
  for (let i = 0; i < 10; i += 1) idle.tick('s')
  check('ticking without a hint is harmless', idle.textFor('s') === '')
}
{
  // Two agents must age independently. A host runs several sessions at once,
  // and a global counter would let one session's messages age another session's
  // hint out from under a model that had not read it yet.
  const hints = channel({ shrinkAfterSteps: 2, expiresAfterSteps: 4 })
  hints.publish({ agentId: 'old', signature: 'a>b>c', steps: ['a', 'b', 'c'], text: 'old text', pointer: 'old ptr' })
  hints.publish({ agentId: 'new', signature: 'd>e>f', steps: ['d', 'e', 'f'], text: 'new text', pointer: 'new ptr' })
  hints.tick('old')
  hints.tick('old')
  check('an aged hint is a pointer', hints.textFor('old') === 'old ptr')
  check('another session\'s messages do not age this hint', hints.textFor('new') === 'new text')
  hints.tick('new')
  hints.tick('new')
  check('the second hint shrinks on its own messages', hints.textFor('new') === 'new ptr')
  hints.tick('new')
  hints.tick('new')
  check('the second hint retires on its own messages', hints.textFor('new') === '')
  check('ticking an unknown agent is harmless', (hints.tick('nobody'), hints.textFor('nobody') === ''))
}

// ---- reflection hold ------------------------------------------------------
//
// Both triggers write into one slot. A repeat hint firing one step after a
// reflection used to replace it silently: the model read the repeat hint and
// never saw the checkpoint. On a real session the pacer ruled two reflections
// due, the first reached the model, the second was overwritten before it was
// ever assembled.
{
  const hints = channel({ reflectionHoldSteps: 3 })
  const reflect = (agentId, turns) => hints.publish({
    agentId,
    signature: `turn#${turns}`,
    steps: [`__reflection_${turns}__`],
    text: 'REFLECT',
    pointer: 'R-PTR',
    distinct: true,
    kind: 'reflection'
  })
  const repeat = (agentId) => hints.publish({
    agentId,
    signature: 'sig',
    steps: ['read', 'edit'],
    text: 'REPEAT',
    pointer: 'P-PTR',
    kind: 'repeat'
  })

  check('a reflection publishes', reflect('held', 3) === 'published')
  check('a repeat hint is turned away during the hold', repeat('held') === 'held')
  check('the reflection stays visible instead', hints.textFor('held') === 'REFLECT')

  hints.tick('held')
  check('one step in, the repeat hint is still held', repeat('held') === 'held')
  hints.tick('held')
  check('two steps in, still held', repeat('held') === 'held')
  hints.tick('held')
  check('the hold releases on the third step', repeat('held') === 'published')
  check('the repeat hint is now what the model reads', hints.textFor('held') === 'REPEAT')

  check('a held repeat hint does not spend the budget', (() => {
    const fresh = channel({ reflectionHoldSteps: 5 })
    fresh.publish({ agentId: 'b', signature: 't', steps: ['__r__'], text: 'R', distinct: true, kind: 'reflection' })
    fresh.publish({ agentId: 'b', signature: 's', steps: ['read', 'edit'], text: 'REP', kind: 'repeat' })
    return fresh.channel('b').emitted === 1
  })())

  check('a reflection may replace a reflection', (() => {
    const fresh = channel({ reflectionHoldSteps: 5 })
    fresh.publish({ agentId: 'c', signature: 't3', steps: ['__r1__'], text: 'R1', distinct: true, kind: 'reflection' })
    return fresh.publish({ agentId: 'c', signature: 't6', steps: ['__r2__'], text: 'R2', distinct: true, kind: 'reflection' }) === 'published'
  })())

  check('clearing the hint releases the hold', (() => {
    const fresh = channel({ reflectionHoldSteps: 5 })
    fresh.publish({ agentId: 'd', signature: 't', steps: ['__r__'], text: 'R', distinct: true, kind: 'reflection' })
    fresh.clear('d')
    return fresh.publish({ agentId: 'd', signature: 's', steps: ['read', 'edit'], text: 'REP', kind: 'repeat' }) === 'published'
  })())

  check('hold 0 lets either kind replace the other', (() => {
    const fresh = channel({ reflectionHoldSteps: 0 })
    fresh.publish({ agentId: 'e', signature: 't', steps: ['__r__'], text: 'R', distinct: true, kind: 'reflection' })
    return fresh.publish({ agentId: 'e', signature: 's', steps: ['read', 'edit'], text: 'REP', kind: 'repeat' }) === 'published'
  })())

  check('another agent stepping does not release the hold', (() => {
    const fresh = channel({ reflectionHoldSteps: 3 })
    fresh.publish({ agentId: 'f', signature: 't', steps: ['__r__'], text: 'R', distinct: true, kind: 'reflection' })
    fresh.tick('other')
    return fresh.publish({ agentId: 'f', signature: 's', steps: ['read', 'edit'], text: 'REP', kind: 'repeat' }) === 'held'
  })())

  check('the hold ages even with shrink and retire off', (() => {
    const fresh = channel({ reflectionHoldSteps: 2, shrinkAfterSteps: 0, expiresAfterSteps: 0 })
    fresh.publish({ agentId: 'g', signature: 't', steps: ['__r__'], text: 'R', distinct: true, kind: 'reflection' })
    fresh.tick('g')
    fresh.tick('g')
    return fresh.publish({ agentId: 'g', signature: 's', steps: ['read', 'edit'], text: 'REP', kind: 'repeat' }) === 'published'
  })())
}

// ---- rendering ------------------------------------------------------------
{
  const text = renderHint({
    procedures: [{ steps: ['bash', 'read', 'edit'], occurrences: 2, coverage: 6, observerRatio: 0.33 }],
    renderSteps: (steps) => steps.join(' → '),
    observerRatioWarn: 0.8
  })
  check('the hint names the submit tool', text.includes('skill_candidate_submit'))
  check('the hint gives the arrow chain', text.includes('bash → read → edit'))
  check('the hint gives the occurrence count', text.includes('2×'))
  check('the hint demands a verbatim quote', text.includes('verbatim'))
  check('the hint asks what failed', text.toLowerCase().includes('what failed'))
  check('the hint promises nothing is written unasked', text.includes('nothing will be written on your behalf'))
  check('a read-heavy procedure earns a caveat', renderHint({
    procedures: [{ steps: ['read', 'grep', 'glob'], occurrences: 2, coverage: 6, observerRatio: 0.99 }],
    renderSteps: (steps) => steps.join(' → '),
    observerRatioWarn: 0.8
  }).includes('skip it unless'))
  check('a balanced procedure earns no caveat', !text.includes('skip it unless'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
