// Prove the geometry guards actually guard something.
//
// Each entry mutates lib/gutter.js, re-syncs the generated copy inside the bundle,
// and runs the suites that could notice. A mutation that changes behaviour but kills
// no assertion is a coverage gap, so it is reported as SURVIVED and fails the run.
//
// Two failure modes have burned this script before, and both are guarded now:
//
//   * An anchor that no longer matches. String.replace silently returns the input
//     unchanged, so the mutation never happened while the suites still passed. That
//     used to be reported as SURVIVED, which reads as "no test covers this" when the
//     truth is "nothing was tested at all". It is now its own outcome, and a
//     non-match is fatal.
//   * A run interrupted before its finally block. Killing this script while it holds
//     a mutated file leaves `if (false)` on disk, and the *next* run then reads that
//     as its baseline and reports every anchor as missing. The script therefore
//     refuses to start unless the file still matches git HEAD.
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

// A baseline that differs from HEAD is almost always a previous run killed
// mid-flight. Continuing from it produces a cascade of ANCHOR MISSING that looks
// like stale anchors when the file is simply still mutated.
try {
  const head = execFileSync('git', ['show', 'HEAD:lib/gutter.js'], { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
  if (head !== original) {
    console.error('lib/gutter.js differs from HEAD before any mutation ran.')
    console.error('A previous run was probably interrupted holding a mutated file. Restore it first:')
    console.error('  git checkout -- lib/gutter.js && node scripts/sync-gutter.mjs')
    process.exit(1)
  }
} catch {
  // git may be unavailable (a tarball checkout); the anchor checks below still apply.
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
    ].join('\n'),
    to: '  if (foot !== undefined && foot >= height + EDGE_MARGIN * 2) {\n    return Math.max(EDGE_MARGIN, desired)',
  },
  {
    label: 'clampTop drops the top bound in a window too short to hold the box',
    from: [
      '  if (foot !== undefined) {',
      '    return Math.max(EDGE_MARGIN, Math.min(desired, Math.max(EDGE_MARGIN, foot - EDGE_MARGIN)))',
    ].join('\n'),
    to: '  if (foot !== undefined) {\n    return Math.min(desired, foot - EDGE_MARGIN)',
  },
  {
    label: 'placeNear ignores the requested side',
    from: "  if (preferred === 'right' && fitsRight) side = 'right'",
    to: "  if (false) side = 'right'",
  },
  {
    // Dropping only the floor: the ceiling still keeps the box on screen to the
    // right, so the mutation shows up as a negative `left` rather than as an
    // obviously broken box.
    label: 'placeNear lets a popover start past the left edge',
    from: '  if (edge !== undefined) left = Math.max(EDGE_MARGIN, Math.min(left, edge - width - EDGE_MARGIN))',
    to: '  if (edge !== undefined) left = Math.min(left, edge - width - EDGE_MARGIN)',
  },
  {
    label: 'placeNear skips the vertical settle',
    from: '  let top = clampTop(anchor.top, height, input?.viewportHeight)',
    to: '  let top = anchor.top',
  },
  {
    label: 'placeNear settles against a zero height',
    from: '  let top = clampTop(anchor.top, height, input?.viewportHeight)',
    to: '  let top = clampTop(anchor.top, 0, input?.viewportHeight)',
  },
  {
    label: 'placeNear ignores the rectangle it was told to keep clear',
    from: '  if (covers(left, top, width, height, avoid) === true) {',
    to: '  if (false) {',
  },
]

const results = []
let fatal = 0

for (const mutation of mutations) {
  if (!original.includes(mutation.from)) {
    results.push({ label: mutation.label, outcome: 'ANCHOR MISSING' })
    fatal += 1
    continue
  }
  const mutated = original.replace(mutation.from, mutation.to)
  if (mutated === original) {
    // Belt and braces: an identical result means the anchor matched nothing useful.
    results.push({ label: mutation.label, outcome: 'NOT APPLIED' })
    fatal += 1
    continue
  }
  fs.writeFileSync(gutter, mutated)
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

// The generated copy inside the bundle is still holding the last mutation.
run({ ref: 'scripts/sync-gutter.mjs' })

for (const result of results) {
  console.log(`${result.outcome.padEnd(16)} ${result.label}`)
  if (result.detail !== undefined) console.log(`                 ${result.detail}`)
}

const killedCount = results.filter((result) => result.outcome.startsWith('killed')).length
const survivors = results.filter((result) => result.outcome === 'SURVIVED').length
console.log(`\n${killedCount}/${results.length} mutations killed`)

const after = run({ ref: 'test/run.mjs' })
const afterFailures = failures(after)
console.log('after restore:', after.trim().split('\n').pop())

// A survivor is a coverage gap. So is a fatal anchor problem, and so is a suite that
// fails after the restore — that last one is how this script once looked green while
// two assertions were failing, because it printed the tally and exited 0 regardless.
if (killedCount !== results.length || fatal > 0 || afterFailures !== 0) process.exitCode = 1
