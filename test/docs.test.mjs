/**
 * Tests for the documents a new session is told to read first.
 *
 * `docs/00-文档索引.md` says: read the development manual before touching code.
 * That instruction is worth nothing if the manual it names is missing, if the index
 * stopped linking it, or if a budget was added to the enforcing command and never
 * written down. Those are the three ways an entry point rots, and each is silent:
 * the prose still reads fine while the file it points at describes last month.
 *
 * Deliberately not tested here: whether the prose is true. A test can check that
 * the manual exists, that the index links it, and that every budget the command
 * enforces is named in the manual. It cannot check that the paragraph explaining a
 * budget still explains it correctly -- that is what the review step is for.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push({ label, detail })
}

// A missing file has to fail the checks below, not the process: a crash in the
// middle of the file reports nothing, and "the test blew up" is a worse message
// than "the index does not link the manual".
const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : '')

// --- the two manuals exist -------------------------------------------------

const MANUAL = 'docs/27-开发与集成手册.md'
const PERF = 'docs/28-性能审查手册.md'
const INDEX = 'docs/00-文档索引.md'
const README = 'README.md'

check('the development manual exists', existsSync(join(root, MANUAL)), MANUAL)
check('the performance manual exists', existsSync(join(root, PERF)), PERF)

// --- the index names them, and says to read the manual first -----------------

{
  const index = read(INDEX)
  check('the index links the development manual', index.includes('27-开发与集成手册.md'), INDEX)
  check('the index links the performance manual', index.includes('28-性能审查手册.md'), INDEX)
  check(
    'the index tells a new session to read the manual before anything else',
    index.includes('新会话先读什么') && index.indexOf('27-开发与集成手册.md') < index.indexOf('按目的进入'),
    'the reading order section has to come before the by-purpose section',
  )
  check(
    'the index still says the handover files are append-only',
    index.includes('只增不改'),
    'the append-only rule is the reason the handover files can be trusted',
  )
}

// --- every other entry point points at number 27 ------------------------------

for (const path of [README, 'docs/handover/index.md', 'packages/skill-evolve/README.md', 'packages/ui-evolve/README.md']) {
  check(`${path} points at the development manual`, read(path).includes('27-开发与集成手册.md'), path)
}

// --- the ten steps are all there -------------------------------------------

{
  const manual = read(MANUAL)
  for (const step of [
    '第 1 步',
    '第 2 步',
    '第 3 步',
    '第 4 步',
    '第 5 步',
    '第 6 步',
    '第 7 步',
    '第 8 步',
    '第 9 步',
    '第 10 步',
  ]) {
    check(`the manual has "${step}"`, manual.includes(step), MANUAL)
  }
  check(
    'the manual names the review skill it requires',
    manual.includes('bounded-diff-code-review'),
    'the review step is a procedure with a name, not a feeling',
  )
  check(
    'the manual says which command enforces the performance budget',
    manual.includes('scripts/perf-budget.mjs'),
    MANUAL,
  )
}

// --- every budget the command enforces is written down -----------------------

{
  // The command is the authority on which budgets exist: an `id` that only lives
  // in the script is a limit nobody was told about, and one that only lives in the
  // manual is a limit nobody enforces. `sse-frame-bytes` is the exception and is
  // named as one: it is structural, pinned by assertions, not measured here.
  const script = read('scripts/perf-budget.mjs')
  const manual = read(PERF)
  const budgets = [...script.matchAll(/^\s{4}id: '([a-z-]+)',/gm)].map((match) => match[1])
  const enforced = budgets.concat(script.includes('state-file-bytes') ? ['state-file-bytes'] : [])
  const structural = ['sse-frame-bytes']
  check('the budget command declares budgets', budgets.length >= 3, String(budgets.length))

  const section = manual.slice(manual.indexOf('## 1 · 预算表'), manual.indexOf('## 2 · 怎么跑'))
  const documented = [...section.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1])
  check('the manual lists its budgets by id', documented.length >= 5, String(documented.length))

  for (const id of enforced) {
    check(`the manual names the "${id}" budget`, documented.includes(id), PERF)
  }
  for (const id of documented) {
    check(
      `the manual's "${id}" is a budget something enforces`,
      enforced.includes(id) || structural.includes(id),
      id,
    )
  }
  for (const id of structural) {
    check(
      `the manual says "${id}" is not measured by the command`,
      section.includes(id) && section.includes('test/api.test.mjs'),
      PERF,
    )
  }
}

if (failed > 0) {
  for (const failure of failures) console.log(`FAIL ${failure.label} -- ${failure.detail ?? ''}`)
}
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
