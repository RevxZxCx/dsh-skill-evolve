import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

// The reviewer's [P1]: `lib/client.js` holds a generated copy of the geometry, and
// the drift test is the only thing standing between a hand-edited bundle and a
// panel drawn in the wrong place. Mutating the *module* is caught by
// test/gutter.test.mjs; mutating only the generated copy is a different question,
// and it is the one that matters for a browser-only file.
const bundle = 'lib/client.js'
const original = fs.readFileSync(bundle, 'utf8')

function run(ref) {
  try {
    return execFileSync('node', [ref], { encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    return (error.stdout ?? '') + (error.stderr ?? '')
  }
}

function failures(output) {
  const match = /(\d+) passed, (\d+) failed/.exec(output)
  return match === null ? -1 : Number(match[2])
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
    const drift = run('test/gutter-drift.test.mjs')
    const full = run('test/run.mjs')
    const killed = failures(drift) + failures(full)
    results.push({
      label: mutation.label,
      equivalent: mutation.equivalent,
      occurrence: count,
      outcome: killed > 0 ? `killed by ${killed}` : mutation.equivalent === true ? 'EQUIVALENT' : 'SURVIVED',
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
