import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Resolved from this file, not from the caller's directory. `execFileSync` below
// runs with the repo root as its cwd, but `fs` does not follow that — so a run
// from anywhere else used to mutate one gutter.js and test another, which is how
// a mutation that genuinely fails the suite was reported SURVIVED.
const repo = fileURLToPath(new URL('..', import.meta.url))
const gutter = path.join(repo, 'lib', 'gutter.js')
const original = fs.readFileSync(gutter, 'utf8')

function run(cmd) {
  try {
    return execFileSync('node', [cmd.ref, ...(cmd.args ?? [])], { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
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
  {
    label: 'clampTop drops the bottom bound in a window tall enough to hold the box',
    from: [
      '  if (foot !== undefined && foot >= height + EDGE_MARGIN * 2) {',
      '    return Math.max(EDGE_MARGIN, Math.min(desired, foot - height - EDGE_MARGIN))',
      '  }',
    ].join('\n'),
    to: [
      '  if (false) {',
      '    return Math.max(EDGE_MARGIN, Math.min(desired, foot - height - EDGE_MARGIN))',
      '  }',
    ].join('\n'),
  },
  {
    label: 'clampTop drops the top bound in a window too short to hold the box',
    from: '    return Math.max(EDGE_MARGIN, Math.min(desired, Math.max(EDGE_MARGIN, foot - EDGE_MARGIN)))',
    to: '    return Math.max(EDGE_MARGIN, desired)',
  },
  {
    label: 'placeNear ignores the requested side',
    from: "  if (preferred === 'right' && fitsRight) side = 'right'",
    to: "  if (false) side = 'right'",
  },
  {
    label: 'placeNear lets a popover start past the left edge',
    from: '  if (edge !== undefined) left = Math.max(EDGE_MARGIN, Math.min(left, edge - width - EDGE_MARGIN))',
    to: '  if (edge !== undefined) left = left',
  },
  {
    label: 'placeNear skips the vertical settle',
    from: '  let top = clampTop(anchor.top, height, input?.viewportHeight)',
    to: '  let top = Number.isFinite(anchor.top) ? anchor.top : EDGE_MARGIN',
  },
  {
    // `avoid` is the only thing keeping the detail card off the list it hangs
    // off. Without it the card is merely clamped, which in any window narrower
    // than about 1280px puts it back over the list's approve/ignore column — so
    // hovering a row to read it makes that row impossible to press.
    label: 'placeNear ignores the rectangle it was told to keep clear',
    from: '  if (covers(left, top, width, height, avoid) === true) {',
    to: '  if (false) {',
  },
  {
    // This slot used to hold the hover bubble's text budget. The bubble is gone —
    // the checklist replaced it — so that anchor no longer exists and nothing
    // reserves a text height any more.
    // What replaces it: the settle has to use the box height. Passing 0 is how a
    // popover ends up parked past the bottom edge instead of inside the window.
    label: 'placeNear settles against a zero height',
    from: '  let top = clampTop(anchor.top, height, input?.viewportHeight)',
    to: '  let top = clampTop(anchor.top, 0, input?.viewportHeight)',
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
    // The client suite runs because it owns the call sites: a placement change
    // that only breaks what the bundle asks for shows up there, not in gutter.
    const clientOut = run({ ref: 'test/client.test.mjs' })
    // `placeNear` lives in its own suite. Leaving it out is how three of its
    // mutations reported SURVIVED: the suites that were run do not assert on it.
    const nearOut = run({ ref: 'test/placeNear.test.mjs' })
    const killed = failures(gutterOut) + failures(driftOut) + failures(clientOut) + failures(nearOut)
    results.push({
      label: mutation.label,
      outcome: killed > 0 ? `killed by ${killed}` : 'SURVIVED',
      detail: [gutterOut, driftOut, clientOut, nearOut].map((out) => out.trim().split('\n').pop()).join(' | '),
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
