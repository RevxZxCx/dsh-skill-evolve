/**
 * Run every test file and report one total.
 *
 * Each suite is a standalone script that exits non-zero on failure, so this
 * runner only needs to spawn them in order and collect the tallies.
 *
 * Usage:
 *   node test/run.mjs            # every suite
 *   node test/run.mjs signal     # suites whose name contains "signal"
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2]
const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => filter === undefined || name.includes(filter))
  .sort()

if (files.length === 0) {
  console.error(`no test files matched ${JSON.stringify(filter)}`)
  process.exit(1)
}

let passed = 0
let failed = 0
const broken = []

for (const file of files) {
  const result = spawnSync(process.execPath, [join(here, file)], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const tally = output.match(/(\d+) passed, (\d+) failed/)
  if (tally === null) {
    // No tally means the suite crashed before finishing; show why.
    broken.push({ file, output: output.trim().split('\n').slice(-12).join('\n') })
    failed += 1
    console.log(`  ??   ${file} (crashed)`)
    continue
  }
  passed += Number(tally[1])
  failed += Number(tally[2])
  const mark = Number(tally[2]) === 0 ? 'ok  ' : 'FAIL'
  console.log(`  ${mark} ${file.padEnd(24)} ${tally[1]} passed, ${tally[2]} failed`)
}

for (const item of broken) {
  console.log(`\n--- ${item.file} ---\n${item.output}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
