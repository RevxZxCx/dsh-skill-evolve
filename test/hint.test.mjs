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
