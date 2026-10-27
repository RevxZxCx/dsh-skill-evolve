/**
 * Mutation check for the panel-wiring regressions.
 *
 * A regression test that passes both with and without the fix proves nothing.
 * Each case reintroduces one defect, runs the targeted test file, and asserts it
 * fails — then restores the file.
 *
 * The first version of this script was itself wrong in a way worth recording:
 * it parsed only the `N failed` summary line, so a mutation that made the test
 * *crash* (uncaught exception, no summary printed) was scored as `0 failed` and
 * reported as a survivor. Six of ten mutations were falsely reported as
 * surviving for exactly that reason. A mutation is now judged killed if the run
 * exits non-zero OR prints a non-zero failure count — a crash is a kill, because
 * the suite still detected that the programme had changed behaviour.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const cases = [
  {
    label: 'valueOf stops rejecting a primitive result',
    file: 'lib/api.js',
    from: `  if (value !== undefined && (typeof value !== 'object' || value === null)) {`,
    to: `  if (false) {`,
    test: 'test/panel-wiring.test.mjs',
  },
  {
    label: 'valueOf calls its dependency unconditionally again',
    file: 'lib/api.js',
    from: "  const value = typeof dependency === 'function' ? dependency() : dependency",
    to: '  const value = dependency()',
    test: 'test/panel-wiring.test.mjs',
  },
  {
    label: 'summarise readConfig reverted to this.config()',
    file: 'lib/summarise.js',
    from: '    const config = valueOf(this.config)\n    if (config?.panelSummary',
    to: '    const config = this.config()\n    if (config?.panelSummary',
    test: 'test/panel-wiring.test.mjs',
  },
  {
    label: 'summarise run reverted to this.llm()',
    file: 'lib/summarise.js',
    from: '  async run({ key, body, signal }) {\n    const llm = valueOf(this.llm)',
    to: '  async run({ key, body, signal }) {\n    const llm = this.llm()',
    test: 'test/panel-wiring.test.mjs',
  },
  {
    label: 'describeSkills stops awaiting isOwned',
    file: 'lib/api.js',
    from: `  const listed = await Promise.all(
    rows.map(async (row) => {
      const name = typeof row?.name === 'string' ? row.name : ''
      let owned = false
      try {
        owned = (await isOwned(name)) === true
      } catch {
        owned = false
      }
      return {
        name,
        description: typeof row?.description === 'string' ? row.description : '',
        invocation: typeof row?.invocation === 'string' ? row.invocation : undefined,
        owned,
      }
    }),
  )`,
    to: `  const listed = rows.map((row) => ({
    name: typeof row?.name === 'string' ? row.name : '',
    description: typeof row?.description === 'string' ? row.description : '',
    invocation: typeof row?.invocation === 'string' ? row.invocation : undefined,
    owned: isOwned(typeof row?.name === 'string' ? row.name : ''),
  }))`,
    test: 'test/panel-wiring.test.mjs',
  },
  {
    label: 'resolveRoute stops rethrowing an abort',
    file: 'lib/summarise.js',
    from: '      signal?.throwIfAborted()\n',
    to: '',
    test: 'test/summarise.test.mjs',
  },
  {
    label: 'writeConfig returns a receipt instead of the config',
    file: 'lib/api.js',
    from: `  return {
    ...readConfig(deps),
    ok: true,`,
    to: `  return {
    ok: true,`,
    test: 'test/panel-wiring.test.mjs',
  },
  {
    label: 'the empty-turn guard lets an empty body reach the model',
    file: 'lib/summarise.js',
    from: "    if (body.length === 0) return { enabled: true, reason: 'the turn left nothing to summarise' }",
    to: "    if (body.length === 0 && false) return { enabled: true, reason: 'the turn left nothing to summarise' }",
    test: 'test/panel-wiring.test.mjs',
  },
  {
    label: 'transcripts.forget dropped from agent disposal',
    file: 'lib/index.js',
    from: '      transcripts.forget(agentId)\n',
    to: '',
    test: 'test/index.test.mjs',
  },
  {
    label: 'publish called with steps: 0 again',
    file: 'lib/index.js',
    from: '          steps: [],',
    to: '          steps: 0,',
    test: 'test/index.test.mjs',
  },
]

/**
 * The file currently carrying an injected defect, so a signal handler can put
 * it back. `null` means the tree is clean.
 *
 * @type {{ file: string, original: string } | null}
 */
let pending = null

/** Restore whatever is currently mutated, then report. */
function restorePending() {
  if (pending === null) return
  writeFileSync(pending.file, pending.original)
  pending = null
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restorePending()
    console.log(`\ninterrupted (${signal}); source restored`)
    process.exit(130)
  })
}
// An uncaught throw outside the loop would otherwise leave the tree mutated.
process.on('uncaughtException', (error) => {
  restorePending()
  console.error(error)
  process.exit(1)
})

/** Bound one mutation's child, so a hang cannot block forever. */
const CHILD_TIMEOUT_MS = 120000

let survived = 0
let missing = 0
for (const entry of cases) {
  const original = readFileSync(entry.file, 'utf8')
  if (!original.includes(entry.from)) {
    console.log(`MISSING ANCHOR  ${entry.label}`)
    missing += 1
    continue
  }
  pending = { file: entry.file, original }
  writeFileSync(entry.file, original.replace(entry.from, entry.to))
  let output = ''
  let exitCode = 0
  try {
    const run = spawnSync('node', [entry.test], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS })
    output = String(run.stdout ?? '') + String(run.stderr ?? '')
    // A timeout returns status null; treat it as a failure to observe, not as a
    // survivor — an uninspected mutation is not a killed one.
    exitCode = run.status ?? (run.error === undefined ? 1 : 1)
  } finally {
    restorePending()
  }

  const summary = output.match(/(\d+) passed, (\d+) failed/)
  const failedCount = summary === null ? null : Number(summary[2])
  // A crash is a kill: the suite noticed the behaviour changed even if it could
  // not print a tally. Only "ran to completion and reported zero failures" is a
  // survivor.
  const killed = failedCount === null ? exitCode !== 0 : failedCount > 0
  if (killed) {
    console.log(`killed (${failedCount === null ? 'crashed' : `${failedCount} failed`})  ${entry.label}`)
  } else {
    console.log(`SURVIVED (test is decorative)  ${entry.label}`)
    survived += 1
  }
}

const total = cases.length
console.log(`\n${total - survived - missing}/${total} mutations killed${missing > 0 ? `, ${missing} anchor(s) missing` : ''}`)
if (survived > 0 || missing > 0) process.exit(1)
