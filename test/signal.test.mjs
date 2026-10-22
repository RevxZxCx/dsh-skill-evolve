import { createDetector, renderSteps } from '../lib/signal.js'

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

function makeDetector(overrides = {}) {
  return createDetector({ minRepeatCount: 2, minWindow: 3, repeatWindowMax: 6, ...overrides })
}

console.log('signal.js')

// 1. Two identical 3-step procedures are detected.
{
  const d = makeDetector()
  for (const name of ['bash', 'read', 'edit', 'bash', 'read', 'edit']) d.record(name)
  const found = d.detect()
  check('detects a twice-repeated 3-step procedure', found.length === 1, JSON.stringify(found))
  check('reports the right occurrence count', found[0]?.occurrences === 2, String(found[0]?.occurrences))
  check('reports the right steps', renderSteps(found[0]?.steps ?? []) === 'bash → read → edit')
}

// 2. A single occurrence is not reported.
{
  const d = makeDetector()
  for (const name of ['bash', 'read', 'edit']) d.record(name)
  check('ignores a single occurrence', d.detect().length === 0)
}

// 3. Overlapping windows are not double counted.
{
  const d = makeDetector()
  for (let i = 0; i < 4; i += 1) for (const name of ['a', 'b', 'c']) d.record(name)
  const found = d.detect()
  check('a,b,c repeated four times yields one procedure', found.length === 1, JSON.stringify(found.map((f) => f.signature)))
  check('counts four non-overlapping occurrences', found[0]?.occurrences === 4, String(found[0]?.occurrences))
}

// 4. A single tool repeated many times is rejected as a habit.
{
  const d = makeDetector()
  for (let i = 0; i < 8; i += 1) d.record('read')
  check('rejects one tool repeated eight times', d.detect().length === 0)
}

// 5. Widest match wins over two narrower halves.
{
  const d = makeDetector()
  const proc = ['bash', 'read', 'edit', 'bash', 'grep', 'write']
  for (const name of [...proc, ...proc]) d.record(name)
  const found = d.detect()
  check('picks the 6-wide window', found[0]?.width === 6, JSON.stringify(found.map((f) => f.width)))
  check('does not also report 3-wide halves', found.length === 1, JSON.stringify(found.map((f) => f.signature)))
}

// 6. ignoreTool suppresses recording.
{
  const d = makeDetector({ ignoreTool: (name) => name === 'todo_write' })
  for (const name of ['bash', 'todo_write', 'read', 'bash', 'todo_write', 'read']) d.record(name)
  const found = d.detect()
  check('ignored tools do not break the procedure', found[0]?.signature === 'bash>read' || found.length === 0, JSON.stringify(found.map((f) => f.signature)))
}

// 7. Memory stays bounded.
{
  const d = makeDetector()
  for (let i = 0; i < 500; i += 1) d.record(i % 2 === 0 ? 'bash' : 'read')
  check('history stays bounded', d.size() <= 48, String(d.size()))
}

// 8. Observer ratio is computed.
{
  const d = makeDetector()
  const proc = ['read', 'grep', 'bash']
  for (const name of [...proc, ...proc]) d.record(name)
  const found = d.detect()
  check('observer ratio reflects read-heavy windows', (found[0]?.observerRatio ?? 0) > 0.5, String(found[0]?.observerRatio))
}

// 8b. A window needs at least three distinct tools to be a procedure.
{
  const d = makeDetector()
  for (let i = 0; i < 4; i += 1) for (const name of ['bash', 'todo_write']) d.record(name)
  check('two distinct tools is a habit, not a procedure', d.detect().length === 0, JSON.stringify(d.detect()))
}

// 8c. One tool dominating a window is the same habit in another shape. The
// long command burst must not be reported as the procedure; a narrower window
// that happens to survive is fine, as long as no reported window is dominated
// by a single tool.
{
  const d = makeDetector()
  for (let i = 0; i < 3; i += 1) for (const name of ['bash', 'bash', 'bash', 'read', 'bash', 'write']) d.record(name)
  const found = d.detect()
  const dominated = found.filter((procedure) => {
    const tallest = Math.max(...procedure.steps.map((step) => procedure.steps.filter((each) => each === step).length))
    return tallest > Math.floor(procedure.width / 2)
  })
  check('no reported window is dominated by one tool', dominated.length === 0, JSON.stringify(found.map((f) => f.signature)))
  check('the six-wide burst is not reported', found.every((procedure) => procedure.width < 6), JSON.stringify(found.map((f) => f.width)))
}

// 8d. The same habit is never hinted twice through a longer lens.
{
  const d = makeDetector()
  const seen = new Set()
  const published = []
  // A period-3 stream also yields a width-5 window; only one may be reported.
  for (let i = 0; i < 4; i += 1) {
    for (const name of ['bash', 'read', 'edit']) {
      d.record(name)
      for (const found of d.detect()) {
        if (seen.has(found.signature)) continue
        seen.add(found.signature)
        published.push(found.signature)
      }
    }
  }
  check('a periodic stream is published once', published.length === 1, JSON.stringify(published))
}

// 8e. A real coding loop keeps its true cycle rather than being shredded.
{
  const d = makeDetector()
  for (let i = 0; i < 3; i += 1) for (const name of ['bash', 'read', 'edit', 'bash']) d.record(name)
  const found = d.detect()
  check('a 4-step cycle is reported as one 4-wide procedure', found.length === 1 && found[0].width === 4, JSON.stringify(found.map((f) => f.width)))
}

// 9. Empty and short streams are safe.
{
  const d = makeDetector()
  check('empty history yields nothing', d.detect().length === 0)
  d.record('bash')
  check('single call yields nothing', d.detect().length === 0)
}

// 10. reset clears state.
{
  const d = makeDetector()
  for (const name of ['a', 'b', 'c', 'a', 'b', 'c']) d.record(name)
  const before = d.detect().length
  d.reset()
  check('reset clears history', before === 1 && d.detect().length === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
