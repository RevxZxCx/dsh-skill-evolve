/**
 * Unit tests for the turn-end reflection trigger.
 *
 * The failure modes this suite exists to catch are the ones that would make
 * the plugin either silent or unbearable:
 *
 * 1. Counting a host-injected message as a human turn, which would fire the
 *    checkpoint on every step.
 * 2. Reflecting on a turn that did nothing, which spends tokens to be told
 *    "nothing happened".
 * 3. Reflecting forever in a long session, which turns a checkpoint into noise.
 */

import { ReflectionPacer, renderReflection } from '../lib/reflection.js'

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

function pacer(options = {}) {
  return new ReflectionPacer({
    cadence: options.cadence ?? 3,
    minToolCalls: options.minToolCalls ?? 4,
    maxPerSession: options.maxPerSession ?? 2
  })
}

// ---------------------------------------------------------------- humans ---

check(
  'a person typing is a human turn',
  ReflectionPacer.isHumanMessage({ type: 'user/message', data: { source: { kind: 'user' } } }) === true
)
check(
  'the AGENTS.md baseline is not a human turn',
  ReflectionPacer.isHumanMessage({ type: 'user/message', data: { source: { kind: 'agent-instructions' } } }) === false
)
check(
  'the runtime snapshot is not a human turn',
  ReflectionPacer.isHumanMessage({ type: 'user/message', data: { source: { kind: 'runtime-context' } } }) === false
)
check(
  'an approval receipt is not a human turn',
  ReflectionPacer.isHumanMessage({ type: 'user/message', data: { source: { kind: 'user-approval' } } }) === false
)
check(
  'a tool result is not a human turn',
  ReflectionPacer.isHumanMessage({ type: 'tool/result', data: { source: { kind: 'user' } } }) === false
)
check('a message with no source is not a human turn', ReflectionPacer.isHumanMessage({ type: 'user/message', data: {} }) === false)
check('null is not a human turn', ReflectionPacer.isHumanMessage(null) === false)

// ---------------------------------------------------------------- cadence ---

{
  const p = pacer({ cadence: 3, minToolCalls: 4 })
  check('a fresh session is not due', p.evaluate('s1').due === false)
  p.countHumanMessage('s1')
  for (let i = 0; i < 10; i += 1) p.countToolCall('s1')
  check('the first turn is not due under cadence 3', p.evaluate('s1').due === false, p.evaluate('s1').reason)
  p.countHumanMessage('s1')
  for (let i = 0; i < 10; i += 1) p.countToolCall('s1')
  check('the second turn is not due under cadence 3', p.evaluate('s1').due === false)
  p.countHumanMessage('s1')
  for (let i = 0; i < 10; i += 1) p.countToolCall('s1')
  check('the third turn is due', p.evaluate('s1').due === true, p.evaluate('s1').reason)
}

// --------------------------------------------------------------- substance ---

{
  const p = pacer({ cadence: 1, minToolCalls: 4 })
  p.countHumanMessage('s2')
  p.countToolCall('s2')
  check('a one-call turn is not worth reflecting on', p.evaluate('s2').due === false, p.evaluate('s2').reason)
  for (let i = 0; i < 3; i += 1) p.countToolCall('s2')
  check('a four-call turn is worth reflecting on', p.evaluate('s2').due === true)
}
{
  const p = pacer({ cadence: 1, minToolCalls: 4 })
  p.countHumanMessage('s3')
  check(
    'substance can be overridden by the caller',
    p.evaluate('s3', { hasSubstance: true }).due === true
  )
}
{
  const p = pacer({ cadence: 1, minToolCalls: 0 })
  p.countHumanMessage('s4')
  check('minToolCalls 0 lets a pure conversation reflect', p.evaluate('s4').due === true)
}

// ---------------------------------------------------------------- budget ---

{
  const p = pacer({ cadence: 1, minToolCalls: 1, maxPerSession: 2 })
  p.countHumanMessage('s5')
  p.countToolCall('s5')
  check('first reflection is due', p.evaluate('s5').due === true)
  p.markReflected('s5')
  check('after reflecting, it is not due again immediately', p.evaluate('s5').due === false, p.evaluate('s5').reason)
  // Cadence doubles after each reflection, so the second checkpoint needs two
  // turns, not one. This is the rationing behaviour, not a regression.
  p.countHumanMessage('s5')
  p.countToolCall('s5')
  check('the second reflection is not due after only one turn', p.evaluate('s5').due === false, p.evaluate('s5').reason)
  p.countHumanMessage('s5')
  p.countToolCall('s5')
  check('the second reflection is due after two turns', p.evaluate('s5').due === true, p.evaluate('s5').reason)
  p.markReflected('s5')
  for (let i = 0; i < 8; i += 1) {
    p.countHumanMessage('s5')
    p.countToolCall('s5')
  }
  const spent = p.evaluate('s5')
  check('the budget stops further reflections', spent.due === false && spent.reason.includes('budget'), spent.reason)
}
{
  const p = pacer({ maxPerSession: 0 })
  p.countHumanMessage('s6')
  for (let i = 0; i < 10; i += 1) p.countToolCall('s6')
  check('a zero budget never fires', p.evaluate('s6').due === false)
}

// ------------------------------------------------------------ turn resets ---

{
  const p = pacer({ cadence: 1, minToolCalls: 4 })
  p.countHumanMessage('s7')
  for (let i = 0; i < 6; i += 1) p.countToolCall('s7')
  check('a busy turn is due', p.evaluate('s7').due === true)
  p.countHumanMessage('s7')
  check('a new human message resets the per-turn call count', p.evaluate('s7').due === false, p.evaluate('s7').reason)
}

// -------------------------------------------------------------- isolation ---

{
  const p = pacer({ cadence: 1, minToolCalls: 1 })
  p.countHumanMessage('a')
  p.countToolCall('a')
  check('sessions are counted independently', p.evaluate('a').due === true && p.evaluate('b').due === false)
  p.forget('a')
  check('forgetting clears the counters', p.evaluate('a').due === false)
}

// -------------------------------------------------------------- rendering ---

{
  const text = renderReflection({ turns: 3 })
  check('the reflection names the three questions', text.includes('Did the person correct me') && text.includes('dead end') && text.includes('not obvious'))
  check('the reflection licenses doing nothing', text.includes('nothing') && text.includes('ignore this message'))
  check('the reflection names the submit tool', text.includes('skill_candidate_submit'))
  check('the reflection asks for verbatim evidence', text.includes('verbatim'))
  check('the reflection asks for failures, not just the happy path', text.includes('what failed'))
  check('without procedures it does not mention them', text.includes('repeated this session') === false)
}
{
  const text = renderReflection({
    turns: 3,
    procedures: [
      { steps: ['read', 'grep', 'edit'], occurrences: 2 },
      { steps: ['bash', 'read'], occurrences: 3 }
    ],
    renderSteps: (steps) => steps.join(' → ')
  })
  check('procedures are folded in as evidence', text.includes('read → grep → edit') && text.includes('×2'))
  check('the procedure block is introduced', text.includes('repeated this session'))
}
{
  const many = Array.from({ length: 9 }, (_, i) => ({ steps: [`t${i}`, 'x'], occurrences: 2 }))
  const text = renderReflection({ turns: 5, procedures: many, renderSteps: (steps) => steps.join(' → ') })
  check('at most three procedures are listed', text.includes('t2 → x') && text.includes('t3 → x') === false)
}
{
  const text = renderReflection({ turns: 2, procedures: [{ steps: ['a', 'b'], occurrences: 2 }] })
  check('a missing renderSteps does not crash', typeof text === 'string' && text.includes('Did the person correct me'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
