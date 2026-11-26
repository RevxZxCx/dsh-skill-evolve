#!/usr/bin/env node
/**
 * Fast pre-review / pre-commit gate:
 *   1. Full unit & contract test suite (`node test/run.mjs`)
 *      (includes docs.test.mjs, registration.test.mjs, mutations.test.mjs, gutter-drift.test.mjs)
 *   2. Handover active views freshness check (`node scripts/build-handover-views.mjs --check`)
 *   3. Performance budget check (`node scripts/perf-budget.mjs`)
 *
 * Flags:
 *   --strict-perf   Treat perf-budget exit code 2 (missing local session dir) as failure.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const strictPerf = process.argv.includes('--strict-perf')

function runStep(label, args) {
  console.log(`\n=== [gate:fast] ${label} ===`)
  const res = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  })
  return res.status ?? 1
}

const testExit = runStep('Full test suite (test/run.mjs)', ['test/run.mjs'])
if (testExit !== 0) {
  console.error('\nFAIL [gate:fast] test suite failed.')
  process.exit(testExit)
}

const viewsExit = runStep('Handover active views check', ['scripts/build-handover-views.mjs', '--check'])
if (viewsExit !== 0) {
  console.error('\nFAIL [gate:fast] handover views are stale — run `npm run handover:build`.')
  process.exit(viewsExit)
}

const perfExit = runStep('Performance budget (scripts/perf-budget.mjs)', ['scripts/perf-budget.mjs'])
if (perfExit === 1) {
  console.error('\nFAIL [gate:fast] performance budget breached.')
  process.exit(1)
}
if (perfExit === 2) {
  if (strictPerf) {
    console.error('\nFAIL [gate:fast] perf-budget returned 2 (unmeasured inputs) under --strict-perf.')
    process.exit(2)
  }
  console.warn('\nWARN [gate:fast] perf-budget returned 2 (some real-session inputs unavailable in this environment; measurable ceiling/nothing budgets passed).')
}

console.log('\nPASS [gate:fast] all checks succeeded.')
process.exit(0)
