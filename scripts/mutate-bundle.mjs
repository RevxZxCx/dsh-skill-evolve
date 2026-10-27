import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

// The reviewer's [P1]: `lib/client.js` holds a generated copy of the geometry, and
// the drift test is the only thing standing between a hand-edited bundle and a
// panel drawn in the wrong place. Mutating the *module* is caught by
// test/gutter.test.mjs; mutating only the generated copy is a different question,
// and it is the one that matters for a browser-only file.
const bundle = 'lib/client.js'
const original = fs.readFileSync(bundle, 'utf8')

function run(ref, ...args) {
  try {
    return execFileSync('node', [ref, ...args], { encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    return (error.stdout ?? '') + (error.stderr ?? '')
  }
}

/**
 * Failures reported by a test run, or -1 when the output is not a test summary.
 *
 * Takes the **last** `passed/failed` line, not the first. `test/run.mjs` prints one
 * summary per file and then a total, so the first match is whichever file happened
 * to run first — usually `111 passed, 0 failed` — and every mutation looked
 * uncaught. That is worse than a wrong count: the script reported "4/4 killed"
 * while the aggregate half of its own evidence was reading zero, and it labelled a
 * live line as EQUIVALENT because its detail line contradicted the verdict.
 *
 * @param {string} output - stdout of a test run.
 * @returns {number} failure count, or -1 if the output carried no summary.
 */
function failures(output) {
  const matches = [...output.matchAll(/(\d+) passed, (\d+) failed/g)]
  if (matches.length === 0) return -1
  return Number(matches[matches.length - 1][2])
}

/**
 * Whether a run's output is evidence the mutation was caught.
 *
 * A crash is a kill, and counting only the summary line missed that. A suite that
 * throws on the mutated input is the loudest possible failure, but it prints no
 * tally, so the first version read it as "no summary, therefore no failures,
 * therefore survived" — and reported two mutations as SURVIVED whose own detail
 * line showed a FAIL.
 *
 * @param {string} output - stdout plus stderr from the run.
 * @returns {{ killed: boolean, count: number, crashed: boolean }} the verdict.
 */
function verdict(output) {
  const count = failures(output)
  if (count === -1) return { killed: true, count: 0, crashed: true }
  return { killed: count > 0, count, crashed: false }
}

const mutations = [
  {
    label: 'inlined usableRect checks only the horizontal pair',
    from: 'return edges.every((edge) => Number.isFinite(rect[edge]))',
    to: 'return Number.isFinite(rect.left) && Number.isFinite(rect.right)',
  },
  {
    label: 'inlined MIN_CARD_WIDTH drifts to 176',
    from: 'const MIN_CARD_WIDTH = 168',
    to: 'const MIN_CARD_WIDTH = 176',
  },
  {
    label: 'inlined CARD_GAP drifts to 20',
    from: 'const CARD_GAP = 16',
    to: 'const CARD_GAP = 20',
  },
  {
    label: 'inlined width guard drops the finiteness check',
    from: 'if (!Number.isFinite(width) || width <= 0) continue',
    to: 'if (width <= 0) continue',
  },
  {
    label: 'inlined gutters defaults a missing right edge to 0',
    from: 'const proseRight = chatRect.right',
    to: 'const proseRight = chatRect.right ?? 0',
    // Equivalent: `usableRect(chatRect, HORIZONTAL)` already returned for that
    // input, so this line never sees undefined. Listed to prove it is dead, not
    // to claim coverage.
    equivalent: true,
  },
]

const results = []
for (const mutation of mutations) {
  const count = original.split(mutation.from).length - 1
  if (count === 0) {
    results.push({ label: mutation.label, outcome: 'ANCHOR MISSING' })
    continue
  }
  // Replace every occurrence: the generated block is the only place these appear,
  // but a partial replacement would leave the test passing for the wrong reason.
  fs.writeFileSync(bundle, original.split(mutation.from).join(mutation.to))
  try {
    // Behavioural suites only. `test/mutations.test.mjs` compares the inlined block
    // byte-for-byte against `buildBlock()`, so it catches *every* edit to client.js
    // regardless of what the edit does — including it here made all five mutations
    // look killed and left the behaviour sweeps with no work to do. The byte guard
    // is real and useful; it is just not evidence that the inlined copy is
    // behaviourally tested, which is what this script exists to measure.
    const drift = run('test/gutter-drift.test.mjs')
    const full = run('test/run.mjs', 'gutter')
    const a = verdict(drift)
    const b = verdict(full)
    // The drift suite also runs under `run.mjs gutter`, so summing the two counts
    // the same failures twice. The union is what matters, and a crash in either run
    // is a kill on its own.
    const crashed = a.crashed || b.crashed
    const killed = a.killed || b.killed
    const counted = Math.max(a.count, b.count)
    results.push({
      label: mutation.label,
      equivalent: mutation.equivalent,
      occurrence: count,
      outcome: killed
        ? `killed by ${crashed ? 'crash' : counted}`
        : mutation.equivalent === true
          ? 'EQUIVALENT'
          : 'SURVIVED',
      detail: `${drift.trim().split('\n').pop()} | ${full.trim().split('\n').pop()}`,
    })
  } finally {
    fs.writeFileSync(bundle, original)
  }
}

for (const result of results) {
  console.log(`${result.outcome.padEnd(15)} ${result.label}${result.occurrence ? ` (×${result.occurrence})` : ''}`)
  if (result.detail !== undefined) console.log(`                ${result.detail}`)
}

const killed = results.filter((r) => r.outcome.startsWith('killed')).length
const equivalent = results.filter((r) => r.equivalent === true).length
console.log(`\n${killed}/${results.length - equivalent} bundle mutations killed (${equivalent} known-equivalent)`)
console.log('after restore:', run('test/run.mjs').trim().split('\n').pop())
