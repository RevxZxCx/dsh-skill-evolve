import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const gutter = 'lib/gutter.js'
const original = fs.readFileSync(gutter, 'utf8')

function run(cmd) {
  try {
    return execFileSync('node', [cmd.ref, ...(cmd.args ?? [])], { encoding: 'utf8', stdio: 'pipe' })
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
    label: 'usableRect accepts a rect with one missing edge (the original bug)',
    from: '  return edges.every((edge) => Number.isFinite(rect[edge]))',
    to: '  return Number.isFinite(rect.left) && Number.isFinite(rect.right)',
  },
  {
    label: 'gutters falls back to the prose for a missing right edge',
    from: '  if (!usableRect(chatRect, HORIZONTAL)) return { left: 0, right: 0 }',
    to: '  if (chatRect == null) return { left: 0, right: 0 }',
  },
  {
    label: 'placeCards accepts an incomplete rect, so a stale frame still draws',
    from: "  if (!usableRect(chatRect, ALL_EDGES)) {\n    return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-conversation' }\n  }",
    to: "  if (chatRect == null) {\n    return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-conversation' }\n  }",
  },
  {
    label: 'placeHandle accepts an incomplete rect',
    from: '  if (!usableRect(chatRect, ALL_EDGES)) {\n    return { visible: false, side: preferred, left: 0, top: 0 }\n  }',
    to: '  if (chatRect == null) {\n    return { visible: false, side: preferred, left: 0, top: 0 }\n  }',
  },
]

const results = []
for (const mutation of mutations) {
  if (!original.includes(mutation.from)) {
    results.push({ label: mutation.label, outcome: 'ANCHOR MISSING' })
    continue
  }
  fs.writeFileSync(gutter, original.replace(mutation.from, mutation.to))
  try {
    run({ ref: 'scripts/sync-gutter.mjs' })
    const gutterOut = run({ ref: 'test/gutter.test.mjs' })
    const driftOut = run({ ref: 'test/gutter-drift.test.mjs' })
    const killed = failures(gutterOut) + failures(driftOut)
    results.push({
      label: mutation.label,
      outcome: killed > 0 ? `killed by ${killed}` : 'SURVIVED',
      detail: [gutterOut.trim().split('\n').pop(), driftOut.trim().split('\n').pop()].join(' | '),
    })
  } finally {
    fs.writeFileSync(gutter, original)
  }
}

run({ ref: 'scripts/sync-gutter.mjs' })

for (const result of results) {
  console.log(`${result.outcome.padEnd(16)} ${result.label}`)
  if (result.detail !== undefined) console.log(`                 ${result.detail}`)
}

const survivors = results.filter((r) => r.outcome !== 'killed' && !r.outcome.startsWith('killed')).length
console.log(`\n${results.length - survivors}/${results.length} mutations killed`)
const after = run({ ref: 'test/run.mjs' })
console.log('after restore:', after.trim().split('\n').pop())
