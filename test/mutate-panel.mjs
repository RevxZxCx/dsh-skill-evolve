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
    from: '  async run({ key, body, signal, sessionRoute }) {\n    const llm = valueOf(this.llm)',
    to: '  async run({ key, body, signal, sessionRoute }) {\n    const llm = this.llm()',
    test: 'test/panel-wiring.test.mjs',
  },
  {
    label: 'describeSkills stops awaiting isOwned',
    file: 'lib/api.js',
    // Drop only the inner `await`, not the `Promise.all` wrapper. An earlier
    // version replaced the whole `const listed = await Promise.all(...)` block
    // and left an orphan `)` behind, so `lib/api.js` no longer parsed; the
    // harness counted the resulting crash as "killed" and this mutation could
    // not tell a working `owned` assertion from a missing one. Kept minimal so
    // the only thing broken is the behaviour under test.
    from: `        owned = (await isOwned(name)) === true`,
    to: `        owned = isOwned(name) === true`,
    test: 'test/panel-wiring.test.mjs',
  },
  {
    label: 'resolveRoute stops rethrowing an abort',
    file: 'lib/summarise.js',
    // Anchored on the surrounding comment: a bare `signal?.throwIfAborted()`
    // matches the `listProviders` guard first, so the mutation used to land on
    // a line no test covers and survived while looking like coverage.
    from: '        // turned into a claim about the host\'s model list.\n        signal?.throwIfAborted()\n',
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
  {
    // The panel used to report every gestured name, including skills the host
    // refuses to load. Without this filter a model-only skill typed as /x
    // appears in the module although nothing was injected.
    label: 'gesture permission filter removed',
    file: 'lib/api.js',
    from: '      if (!userInvocable) continue',
    to: '      void userInvocable',
    test: 'test/api.test.mjs',
  },
  {
    // Recency across the two load paths is one ordered Map; without the delete a
    // Map keeps the first position, so alpha -> beta -> alpha still lists beta
    // first.
    label: 'reloading a skill no longer moves it to the front',
    file: 'lib/index.js',
    from: `    const previous = names.get(name)
    names.delete(name)
    names.set(name, previous === 'tool' ? 'tool' : via)`,
    to: `    const previous = names.get(name)
    names.set(name, previous === 'tool' ? 'tool' : via)`,
    test: 'test/index.test.mjs',
  },
  {
    // Writing the newest path unconditionally demotes a tool load to a gesture
    // one, and describeSkills then drops a model-only skill the session is using.
    label: 'a later gesture demotes a tool load',
    file: 'lib/index.js',
    from: `    names.set(name, previous === 'tool' ? 'tool' : via)`,
    to: `    names.set(name, via)`,
    test: 'test/index.test.mjs',
  },
  {
    // A gesture recorded as a tool load escapes the stricter user-invocable
    // rule, which is the whole reason the path is recorded at all.
    label: 'gesture loads recorded as tool loads',
    file: 'lib/index.js',
    from: "rememberSkillUse(agentId, name, 'gesture')",
    to: "rememberSkillUse(agentId, name, 'tool')",
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
let broken = 0
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
    // A mutation that does not parse proves nothing about the tests: the child
    // dies before running a single assertion, and every harness that reads
    // "non-zero exit" as "killed" then reports coverage it does not have. This
    // happened here — a `Promise.all` wrapper was mutated away and left an
    // orphan `)`, so `lib/api.js` stopped parsing and the case passed as killed
    // even with its four `owned` assertions deleted. Check parseability first.
    const syntax = spawnSync('node', ['--check', entry.file], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS })
    if (syntax.status !== 0) {
      console.log(`BROKEN MUTATION (does not parse)  ${entry.label}`)
      broken += 1
      continue
    }
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
  // survivor. Parseability is already ruled out above, so a crash here means a
  // real throw from the mutated behaviour.
  const killed = failedCount === null ? exitCode !== 0 : failedCount > 0
  if (killed) {
    console.log(`killed (${failedCount === null ? 'crashed' : `${failedCount} failed`})  ${entry.label}`)
  } else {
    console.log(`SURVIVED (test is decorative)  ${entry.label}`)
    survived += 1
  }
}

const total = cases.length
console.log(
  `\n${total - survived - missing - broken}/${total} mutations killed` +
    `${missing > 0 ? `, ${missing} anchor(s) missing` : ''}` +
    `${broken > 0 ? `, ${broken} mutation(s) did not parse` : ''}`,
)
if (survived > 0 || missing > 0 || broken > 0) process.exit(1)
