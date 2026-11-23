#!/usr/bin/env node
/**
 * The panel's performance budget, as a command rather than a paragraph.
 *
 * `docs/28-性能审查手册.md` states what one `/panel` assembly is allowed to cost.
 * A budget nobody runs is a wish, so this script measures the same numbers on this
 * machine and exits non-zero when one is over:
 *
 *   - **stat calls** — one per row the payload will report, never one per path
 *     handed in. This is structural: the filter runs before the syscall, so a
 *     session whose paths are 92% non-deliverable must not pay for them.
 *   - **payload bytes** — what the `files` array costs on the wire. Not the whole
 *     `/panel` body: the summary text, skills and tool names are bounded by their own
 *     rules (a 6,000-character summary cap, one row per skill) and do not grow with
 *     the path count, which is the only thing this budget is about.
 *   - **elapsed** — wall time for the whole `statTouchedFiles` pass. This is the first
 *     pass over those files in this process, so it includes the cold read; the label in
 *     the output says `ms` and the manual says which pass it is.
 *
 * Three inputs, because they answer different questions:
 *
 *   1. **the worst real session on this disk** — what the reader can feed it.
 *      This measures the product, and it is the number that decides whether a
 *      person waits.
 *   2. **200 real files, every row deliverable** — the arithmetic ceiling
 *      (`MAX_TOUCHED_FILES`). No real session looks like this; it exists so a
 *      change cannot pass by being fast only on small inputs.
 *   3. **200 rows, none deliverable** — the case the filter exists for. Every
 *      syscall here is one that should not have happened.
 *
 * Usage:
 *
 *     node scripts/perf-budget.mjs            # measure and judge
 *     node scripts/perf-budget.mjs --verbose  # also show the unfiltered pass
 *
 * Exit code 0 means every budget holds; any other code means at least one line
 * below says OVER.
 *
 * Sessions are read from `$DSH_HOME/plugin-data/skill-evolve/sessions`, or
 * `~/.dsh/...` when `DSH_HOME` is unset. With no files there, input 1 is
 * reported as not measured rather than silently skipped and passing.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { statTouchedFiles } from '../packages/ui-evolve/lib/api.js'

const VERBOSE = process.argv.includes('--verbose')

/**
 * What one assembly may cost, in the units the contract names.
 *
 * Every row carries `inputs`: which measurements it judges. A budget that applied
 * to every input would fail on the one input it is not about (a ratio of 0 stats
 * over 38 rows is not "over 0").
 */
const BUDGETS = [
  {
    id: 'stat-per-reported-row',
    inputs: ['real', 'ceiling'],
    limit: 1,
    unit: '× rows',
    value: (m) => (m.rows === 0 ? 0 : m.statCalls / m.rows),
    why: 'the deliverable filter runs before readStat, so a dropped row costs no syscall',
  },
  {
    id: 'payload-real-session',
    inputs: ['real'],
    limit: 32 * 1024,
    unit: 'bytes',
    value: (m) => m.bytes,
    why: 'a real session is a few dozen rows; 32 KB is 2.4× the worst case measured on 2026-11-23 (13,699 B)',
  },
  {
    id: 'payload-ceiling-session',
    inputs: ['ceiling'],
    limit: 80 * 1024,
    unit: 'bytes',
    value: (m) => m.bytes,
    why: '200 rows x ~305 B measured = 60,941 B; 80 KB leaves room for a row to gain a field before the row count itself is the cost',
  },
  {
    id: 'elapsed-real-session',
    inputs: ['real'],
    limit: 200,
    unit: 'ms',
    value: (m) => m.elapsedMs,
    why: 'one assembly sits on the path to opening a panel; 200 ms is where a person notices',
  },
  {
    id: 'stat-when-nothing-is-deliverable',
    inputs: ['nothing'],
    limit: 0,
    unit: 'calls',
    value: (m) => m.statCalls,
    why: 'a session with no deliverable row has nothing to stat — the case the filter exists for',
  },
]

/** One measurement: rows in, and what the reader paid for them. */
async function measure(label, paths) {
  const rows = paths.map((p) => (typeof p === 'string' ? { path: p } : p))

  // The panel's own call: deliverable rows only, which is the number that matters.
  let statCalls = 0
  const started = process.hrtime.bigint()
  const kept = await statTouchedFiles({
    paths: rows,
    onlyDeliverable: true,
    readStat: async (path) => {
      statCalls += 1
      return stat(path)
    },
  })
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

  // Same input without the switch, to show what the filter is worth. Not judged.
  let coldCalls = 0
  const coldStart = process.hrtime.bigint()
  const all = await statTouchedFiles({
    paths: rows,
    readStat: async (path) => {
      coldCalls += 1
      return stat(path)
    },
  })
  const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6

  const result = {
    label,
    rows: kept.length,
    statCalls,
    bytes: JSON.stringify(kept).length,
    elapsedMs: Math.round(elapsedMs * 10) / 10,
    coldCalls,
    coldMs: Math.round(coldMs * 10) / 10,
    dropped: all.length - kept.length,
  }
  if (VERBOSE) {
    console.log(
      `  ${label}: ${result.rows} rows / ${result.statCalls} stats / ${result.bytes} B / ${result.elapsedMs} ms` +
        `   (no filter: ${result.coldCalls} stats / ${result.coldMs} ms, ${result.dropped} dropped)`,
    )
  }
  return result
}

/** The session whose `paths` the reader can hand over today, plus the biggest state file. */
async function readSessions(dir) {
  let names
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
  } catch {
    return null
  }
  let worst = null
  let biggest = 0
  let maxBytes = 0
  for (const name of names) {
    let doc
    try {
      doc = JSON.parse(await readFile(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    // `paths` is an object keyed by absolute path and only state 3 is read at
    // all; `previous.paths` is the fallback used when the memory list is empty,
    // which is how a rewrite of the collector walked back in (DEF-180).
    const map = doc.state === 3 && doc.paths && typeof doc.paths === 'object' ? Object.keys(doc.paths) : []
    const prev = Array.isArray(doc.previous?.paths) ? doc.previous.paths : []
    const rows = map.length > 0 ? map : prev
    if (rows.length > biggest) {
      biggest = rows.length
      worst = { name, rows }
    }
    // The budget is about what this file costs on disk, so ask the disk. Re-rolling
    // the bytes with `JSON.stringify` reads 3% low on the files here (40,518 against
    // 41,941 B) and would read far lower for a file some editor pretty-printed.
    const size = (await stat(join(dir, name))).size
    if (size > maxBytes) maxBytes = size
  }
  return { files: names.length, worst, maxBytes }
}

/**
 * 200 files that really exist, so the ceiling input pays what a real session
 * would: one syscall per row, each row deliverable and resolvable.
 *
 * Created rather than borrowed: a list of paths that do not exist measures the
 * miss path (slower on Windows) and would let a payload regression hide behind
 * a stat that was never going to succeed. The files are deleted by the caller.
 */
async function makeCeilingFiles(count) {
  const dir = await mkdtemp(join(tmpdir(), 'perf-budget-'))
  const paths = []
  for (let i = 0; i < count; i += 1) {
    const path = join(dir, `row-${i}.md`)
    await writeFile(path, `row ${i}`)
    paths.push(path)
  }
  return { dir, paths }
}

const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'skill-evolve', 'sessions')
const measurements = []

const sessions = await readSessions(dir)
if (sessions === null) {
  console.log(`no session files under ${dir} — the real-session input was NOT measured`)
} else if (sessions.worst === null) {
  console.log(`${sessions.files} session files under ${dir}, none with paths — real-session input not measured`)
} else {
  console.log(`real worst session: ${sessions.worst.name} (${sessions.worst.rows.length} rows, biggest state file ${sessions.maxBytes} B)`)
  measurements.push(await measure('real', sessions.worst.rows))
}

const ceiling = await makeCeilingFiles(200)
try {
  measurements.push(await measure('ceiling', ceiling.paths))
  console.log('ceiling session: 200 deliverable rows on real files')
} finally {
  await rm(ceiling.dir, { recursive: true, force: true })
}

measurements.push(await measure('nothing', Array.from({ length: 200 }, (_, i) => `F:/nowhere/row-${i}.py`)))

let failed = false
for (const budget of BUDGETS) {
  for (const m of measurements.filter((one) => budget.inputs.includes(one.label))) {
    const value = Math.round(budget.value(m) * 10) / 10
    const over = value > budget.limit
    if (over) failed = true
    console.log(
      `  ${over ? 'OVER' : ' ok '}  ${budget.id} [${m.label}]  ${value} ${budget.unit}  (limit ${budget.limit})`,
    )
    if (over) console.log(`        why the limit: ${budget.why}`)
  }
}

if (sessions === null) {
  // Printing nothing here is the one outcome that looks like a pass: a CI run with no
  // session directory would show five green lines and no sixth, and nobody counts lines.
  console.log('  --    state-file-bytes  NOT measured (no session files)')
} else if (sessions.maxBytes > 64 * 1024) {
  failed = true
  console.log(`  OVER  state-file-bytes  ${sessions.maxBytes} bytes  (limit 65536)`)
} else {
  console.log(`  ok    state-file-bytes  ${sessions.maxBytes} bytes  (limit 65536)`)
}

process.exit(failed ? 1 : 0)
