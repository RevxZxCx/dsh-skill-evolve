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
 *   - **payload bytes** — what the `files` array costs on the wire, counted as
 *     UTF-8 bytes of the serialized rows. Not the whole `/panel` body: the summary
 *     text, skills and tool names are bounded by their own rules (a 6,000-character
 *     summary cap, one row per skill) and do not grow with the path count, which is
 *     the only thing this budget is about.
 *   - **elapsed** — wall time for the whole `statTouchedFiles` pass. This is the first
 *     pass over those files in this process, so it includes the cold read; the label in
 *     the output says `ms` and the manual says which pass it is.
 *
 * Three inputs, because they answer different questions:
 *
 *   1. **the real sessions on this disk** — what the reader can feed it. Up to eight
 *      sessions are measured (the largest by row count and the largest by deliverable
 *      row count) and each budget is judged on the worst of them: a budget that
 *      passes on the cheap session and fails on the expensive one passed on nothing.
 *      The rows carry their stored description, because the payload does.
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
 * Exit codes:
 *
 *     0  every budget was measured and holds
 *     1  at least one budget is over
 *     2  nothing is over, but at least one budget could not be measured here
 *        (no session data, no writable temp directory). `docs/28` says a budget
 *        that was not measured is not a pass, and a green line nobody printed is
 *        worse: it reads as a pass.
 *
 * Sessions are read from `$DSH_HOME/plugin-data/skill-evolve/sessions`, or
 * `~/.dsh/...` when `DSH_HOME` is unset.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { isDeliverable, statTouchedFiles } from '../packages/ui-evolve/lib/api.js'

const VERBOSE = process.argv.includes('--verbose')

/** `MAX_TOUCHED_FILES` in `lib/api.js`, and the row cap in `lib/session-state.js`. */
const MAX_ROWS = 200
const MAX_STATE_BYTES = 64 * 1024
/** How many real sessions are measured; their worst result judges each budget. */
const SESSIONS_TO_MEASURE = 4

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
    unit: 'x rows',
    // Stats over zero reported rows is not zero: it is every row paid for and
    // dropped. Reported as infinity so the line cannot be green.
    value: (m) => (m.rows === 0 ? (m.statCalls === 0 ? 0 : Number.POSITIVE_INFINITY) : m.statCalls / m.rows),
    why: 'the deliverable filter runs before readStat, so a dropped row costs no syscall',
  },
  {
    id: 'payload-real-session',
    inputs: ['real'],
    limit: 32 * 1024,
    unit: 'bytes',
    value: (m) => m.bytes,
    why: 'a real session is a few dozen rows; 32 KB is 2x the worst case measured on 2026-11-23 (15,333 B with descriptions)',
  },
  {
    id: 'payload-ceiling-session',
    inputs: ['ceiling'],
    limit: 80 * 1024,
    unit: 'bytes',
    value: (m) => m.bytes,
    why: '200 rows x ~270 B measured = 54-61 KB depending on the temp path; 80 KB leaves room for a row to gain a field',
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

/**
 * The rows a session actually reports, in the order the panel reports them.
 *
 * `paths` is an object keyed by absolute path; the store keeps the newest
 * `MAX_PATHS` by `seq` and `pathsSeen` hands them back newest first, capped at
 * 200. Both halves are gated on state 3: the reader refuses `paths` from an older
 * file (`readState`) and the loader rewrites `previous.paths` to `[]` for one
 * (`restorable`), so a v2 file is a session the panel reports zero rows for.
 */
function rowsFromState(doc) {
  const stored = doc.paths && typeof doc.paths === 'object' ? Object.entries(doc.paths) : []
  const rows = stored
    .filter(([, at]) => at !== null && typeof at === 'object')
    .sort((a, b) => (b[1].seq ?? 0) - (a[1].seq ?? 0))
    .slice(0, MAX_ROWS)
    .map(([path, at]) => ({
      path,
      // The product serializes the stored description, and 51 of them were 1,744
      // characters on the worst session here: leaving it out read 10.7% low.
      description: typeof at.description === 'string' ? at.description : '',
    }))
  if (rows.length > 0) return rows
  // The fallback the panel uses when the memory list is empty. Bare strings:
  // the transcript's own list never carried a description.
  const prev = Array.isArray(doc.previous?.paths) ? doc.previous.paths : []
  return prev.slice(0, MAX_ROWS).map((path) => ({ path: String(path), description: '' }))
}

/** Rows per session, plus the biggest state file on disk. */
async function readSessions(dir) {
  let names
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'))
  } catch {
    return null
  }
  const sessions = []
  let maxBytes = 0
  for (const name of names) {
    let doc
    try {
      doc = JSON.parse(await readFile(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    // A file can parse to `null` or a number; `.state` on those throws and would
    // abort the whole run instead of skipping one unreadable session.
    if (doc === null || typeof doc !== 'object') continue
    // The budget is about what this file costs on disk, so ask the disk. Re-rolling
    // the bytes with `JSON.stringify` reads 3% low on the files here (40,518 against
    // 41,941 B) and would read far lower for a file some editor pretty-printed.
    let bytes = 0
    try {
      bytes = (await stat(join(dir, name))).size
    } catch {
      // Unlinked between `readdir` and this stat: the store sweeps old sessions
      // while a panel is open, and one missing file is not a broken budget.
      continue
    }
    if (bytes > maxBytes) maxBytes = bytes
    sessions.push({ name, rows: doc.state === 3 ? rowsFromState(doc) : [], bytes })
  }
  return { files: names.length, sessions, maxBytes }
}

const deliverableRows = (session) => session.rows.filter((row) => isDeliverable(row.path)).length

/**
 * The sessions worth measuring: the largest by row count (a stat-ratio regression) and
 * the largest by deliverable rows (a payload or elapsed regression). Choosing by row
 * count alone would judge the payload on a session whose rows are all dropped.
 */
function pickWorst(sessions, count) {
  const byRows = [...sessions].sort((a, b) => b.rows.length - a.rows.length).slice(0, count)
  const byDeliverable = [...sessions].sort((a, b) => deliverableRows(b) - deliverableRows(a)).slice(0, count)
  const seen = new Set()
  const picked = []
  for (const one of [...byRows, ...byDeliverable]) {
    if (seen.has(one.name)) continue
    seen.add(one.name)
    picked.push(one)
  }
  return picked
}

/** One measurement: rows in, and what the reader paid for them. */
async function measure(label, rows) {
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
    session: '',
    rows: kept.length,
    statCalls,
    // UTF-16 code units are not bytes: a Chinese project or user directory
    // under-reports the wire cost by up to 3x.
    bytes: Buffer.byteLength(JSON.stringify(kept), 'utf8'),
    elapsedMs,
    coldCalls,
    coldMs,
    dropped: all.length - kept.length,
  }
  if (VERBOSE) {
    console.log(
      `  ${label}${result.session === '' ? '' : ` [${result.session}]`}: ` +
        `${result.rows} rows / ${result.statCalls} stats / ${result.bytes} B / ` +
        `${result.elapsedMs.toFixed(1)} ms` +
        `   (no filter: ${result.coldCalls} stats / ${result.coldMs.toFixed(1)} ms, ${result.dropped} dropped)`,
    )
  }
  return result
}

/**
 * 200 files that really exist, so the ceiling input pays what a real session
 * would: one syscall per row, each row deliverable and resolvable.
 *
 * Created rather than borrowed: a list of paths that do not exist measures the
 * miss path (slower on Windows) and would let a payload regression hide behind
 * a stat that was never going to succeed.
 */
async function makeCeilingFiles(count) {
  const dir = await mkdtemp(join(tmpdir(), 'perf-budget-'))
  try {
    const paths = []
    for (let i = 0; i < count; i += 1) {
      const path = join(dir, `row-${i}.md`)
      await writeFile(path, `row ${i}`)
      paths.push(path)
    }
    return { dir, paths }
  } catch (error) {
    // Leaving the directory behind, or letting this abort a run whose real
    // measurement already succeeded, are both worse than one unmeasured input.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'skill-evolve', 'sessions')
const measurements = []

const sessions = await readSessions(dir)
if (sessions === null) {
  console.log(`no session directory at ${dir} — the real-session input cannot be measured here`)
} else {
  const withRows = sessions.sessions.filter((one) => one.rows.length > 0)
  if (withRows.length === 0) {
    console.log(`${sessions.files} session files under ${dir}, none reporting rows — the real-session input cannot be measured here`)
  } else {
    const picked = pickWorst(withRows, SESSIONS_TO_MEASURE)
    console.log(
      `real sessions: ${withRows.length} with rows, measuring ${picked.length}` +
        ` (largest by rows and by deliverable rows)`,
    )
    for (const one of picked) {
      const result = await measure('real', one.rows)
      result.session = one.name
      measurements.push(result)
    }
  }
}

let ceiling = null
try {
  ceiling = await makeCeilingFiles(MAX_ROWS)
} catch (error) {
  console.log(`could not create the ceiling input (${error.message}) — that input cannot be measured here`)
}
if (ceiling !== null) {
  try {
    measurements.push(await measure('ceiling', ceiling.paths))
  } finally {
    await rm(ceiling.dir, { recursive: true, force: true })
  }
}

measurements.push(await measure('nothing', Array.from({ length: MAX_ROWS }, (_, i) => `F:/nowhere/row-${i}.py`)))

let failed = false
let unmeasured = false
for (const budget of BUDGETS) {
  const matching = measurements.filter((one) => budget.inputs.includes(one.label))
  if (matching.length === 0) {
    // Printing nothing here is the one outcome that looks like a pass.
    unmeasured = true
    console.log(`  --    ${budget.id}  NOT measured (no input it applies to: ${budget.inputs.join(', ')})`)
    continue
  }
  let worst = matching[0]
  let worstValue = budget.value(worst)
  for (const one of matching.slice(1)) {
    const value = budget.value(one)
    if (value > worstValue) {
      worst = one
      worstValue = value
    }
  }
  // Compare the number, print one rounded: 57 stats over 55 rows is 1.036 and
  // rounds to 1.0, which is the regression this budget exists for.
  const over = worstValue > budget.limit
  if (over) failed = true
  const shown = Math.round(worstValue * 10) / 10
  console.log(
    `  ${over ? 'OVER' : ' ok '}  ${budget.id} [${worst.label}]  ${shown} ${budget.unit}  (limit ${budget.limit})`,
  )
  if (worst.session !== '') console.log(`        session: ${worst.session} (${worst.rows} rows reported)`)
  if (over) console.log(`        why the limit: ${budget.why}`)
}

if (sessions === null) {
  unmeasured = true
  console.log('  --    state-file-bytes  NOT measured (no session directory)')
} else if (sessions.maxBytes > MAX_STATE_BYTES) {
  failed = true
  console.log(`  OVER  state-file-bytes  ${sessions.maxBytes} bytes  (limit ${MAX_STATE_BYTES})`)
} else {
  console.log(`  ok    state-file-bytes  ${sessions.maxBytes} bytes  (limit ${MAX_STATE_BYTES})`)
}

process.exit(failed ? 1 : unmeasured ? 2 : 0)
