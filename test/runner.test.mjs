// F12: the runner used to trust the tally text and ignore the child's exit
// status, so a suite that printed "5 passed, 0 failed" and then crashed was
// reported as ok. This reproduces that with real child processes.
//
// The runner reads its suite directory from SKILL_EVOLVE_TEST_DIR so it can be
// pointed at fixtures instead of at this directory.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const runner = join(here, 'run.mjs')

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const suites = {
  // A clean suite.
  'a-clean.test.mjs': `console.log('3 passed, 0 failed')\nprocess.exit(0)\n`,
  // Prints a reassuring tally, then dies. This is the case the old runner
  // reported as ok: the tally was the only thing it looked at.
  'b-tally-then-throw.test.mjs': `console.log('4 passed, 0 failed')\nthrow new Error('boom after the tally')\n`,
  // Same shape, but exits non-zero deliberately — an assertion helper that
  // called process.exit(1) without printing a failure count.
  'c-tally-then-exit.test.mjs': `console.log('2 passed, 0 failed')\nprocess.exit(1)\n`,
  // Prints a tally, then leaves a promise pending so node exits 13.
  'd-tally-then-unsettled.test.mjs': `console.log('1 passed, 0 failed')\nawait new Promise(() => {})\n`,
  // A genuine failure, which already worked.
  'e-real-failure.test.mjs': `console.log('1 passed, 2 failed')\nprocess.exit(1)\n`,
  // A suite that crashes before printing anything.
  'f-early-crash.test.mjs': `throw new Error('no tally here')\n`
}

/** Run the runner against a directory of suites and return its result. */
function runSuite(dir) {
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    env: { ...process.env, SKILL_EVOLVE_TEST_DIR: dir }
  })
  return {
    code: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  }
}

const root = await mkdtemp(join(tmpdir(), 'skill-evolve-runner-'))
try {
  console.log('runner — every non-zero exit is a failure')

  const dir = join(root, 'suites')
  await mkdir(dir, { recursive: true })
  for (const [name, source] of Object.entries(suites)) {
    await writeFile(join(dir, name), source, 'utf8')
  }

  const outcome = runSuite(dir)
  check('the runner exits non-zero when any suite dies', outcome.code === 1, `exit ${outcome.code}`)
  check('a suite that crashes after its tally is not reported ok',
    /FAIL b-tally-then-throw\.test\.mjs/.test(outcome.output), outcome.output.split('\n').find((line) => line.includes('b-tally')) ?? '')
  check('a suite that exits 1 after its tally is not reported ok',
    /FAIL c-tally-then-exit\.test\.mjs/.test(outcome.output), outcome.output.split('\n').find((line) => line.includes('c-tally')) ?? '')
  check('a suite that leaves a promise pending is not reported ok',
    /FAIL d-tally-then-unsettled\.test\.mjs/.test(outcome.output), outcome.output.split('\n').find((line) => line.includes('d-tally')) ?? '')
  check('a genuine failure is still reported', /FAIL e-real-failure\.test\.mjs/.test(outcome.output))
  check('a suite with no tally is still reported as crashed', /f-early-crash\.test\.mjs/.test(outcome.output) && /no tally/.test(outcome.output), outcome.output.split('\n').find((line) => line.includes('f-early')) ?? '')
  check('the clean suite is reported ok', /ok\s+a-clean\.test\.mjs/.test(outcome.output), outcome.output.split('\n').find((line) => line.includes('a-clean')) ?? '')
  // The tally must not be trusted: only the clean suite's 3 assertions count.
  check('only the clean suite contributes to the pass total', /\n3 passed, 5 failed/.test(outcome.output), outcome.output.slice(-80))
  // The reason has to be visible, not just the verdict.
  check('the crash reason is printed', /boom after the tally/.test(outcome.output), outcome.output.slice(-200))

  // A directory with only clean suites must still exit 0.
  const cleanDir = join(root, 'clean')
  await mkdir(cleanDir, { recursive: true })
  await writeFile(join(cleanDir, 'only.test.mjs'), `console.log('3 passed, 0 failed')\nprocess.exit(0)\n`, 'utf8')
  const cleanOutcome = runSuite(cleanDir)
  check('an all-clean run exits 0', cleanOutcome.code === 0, `exit ${cleanOutcome.code}`)
  check('an all-clean run totals its assertions', /\n3 passed, 0 failed/.test(cleanOutcome.output), cleanOutcome.output.slice(-60))
} catch (error) {
  console.error(error)
  process.exit(1)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
