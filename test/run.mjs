/**
 * Run every test file and report one total.
 *
 * Each suite is a standalone script that exits non-zero on failure, so this
 * runner spawns them in order and collects the tallies.
 *
 * The tally is not trusted on its own. A suite that printed "4 passed, 0
 * failed" and then threw — or exited 1, or left a promise pending so node exited
 * 13 — used to be reported as ok, because the only thing this file looked at was
 * the printed numbers. A suite's own count is therefore accepted only when its
 * process exited cleanly *and* reported no failures; anything else is a failure
 * of that suite regardless of what it printed.
 *
 * Usage:
 *   node test/run.mjs            # every suite
 *   node test/run.mjs signal     # suites whose name contains "signal"
 *
 * SKILL_EVOLVE_TEST_DIR points the runner at a different directory of suites;
 * test/runner.test.mjs uses it to exercise this file against fixtures.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suitesDir = process.env.SKILL_EVOLVE_TEST_DIR ?? here
const filter = process.argv[2]
// A suite that loops forever (not a pending promise - the host would report
// that - but a real spin) would otherwise wedge the runner with no output.
// The budget is generous because the slowest suite here spawns children.
const SUITE_TIMEOUT_MS = Number(process.env.SKILL_EVOLVE_TEST_TIMEOUT_MS ?? 120000)

const files = readdirSync(suitesDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => filter === undefined || name.includes(filter))
  .sort()

if (files.length === 0) {
  console.error(`no test files matched ${JSON.stringify(filter)} in ${suitesDir}`)
  process.exit(1)
}

let passed = 0
let failed = 0
const broken = []

for (const file of files) {
  const result = spawnSync(process.execPath, [join(suitesDir, file)], {
    encoding: 'utf8',
    timeout: SUITE_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const tally = output.match(/(\d+) passed, (\d+) failed/)
  // `status` is null when the child died on a signal, which is a failure too.
  const cleanExit = result.status === 0 && result.signal === null

  if (cleanExit && tally !== null && Number(tally[2]) === 0) {
    passed += Number(tally[1])
    console.log(`  ok   ${file.padEnd(24)} ${tally[1]} passed, 0 failed`)
    continue
  }

  // Either the process did not exit cleanly, or it exited 0 while claiming
  // failures. Trust the reported failure count when there is one, because it is
  // usually the more informative number; otherwise this suite counts as one
  // failure, since something went wrong that it did not report.
  const claimed = tally === null ? 0 : Number(tally[2])
  failed += cleanExit ? Math.max(1, claimed) : 1
  // The spawnSync error code is the only reliable timeout signal: a child
  // killed for running too long also reports a signal, so checking signals
  // alone would report a timeout as an ordinary crash.
  const how = result.error?.code === 'ETIMEDOUT'
    ? `timed out after ${SUITE_TIMEOUT_MS}ms`
    : cleanExit
      ? `exit 0 but reported ${claimed} failure(s)`
      : result.signal !== null
        ? `killed by ${result.signal}`
        : `exit ${result.status}`
  console.log(`  FAIL ${file.padEnd(24)} ${how}${tally === null ? ', no tally' : ''}`)
  broken.push({ file, how, output: output.trim().split('\n').slice(-12).join('\n') })
}

for (const item of broken) {
  console.log(`\n--- ${item.file} (${item.how}) ---\n${item.output}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
