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

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `import.meta.dirname` needs Node 20.11 while package.json declares >= 20; on 20.0
// this file would throw before printing a single check.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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

/** The first heading matching `start`, up to the next `## ` heading. */
function sectionAt(text, start) {
  const from = text.search(start)
  if (from === -1) return { found: false, body: '' }
  const next = text.indexOf(String.fromCharCode(10) + '## ', from)
  return { found: true, body: next === -1 ? text.slice(from) : text.slice(from, next) }
}

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
  // Both needles occur earlier in the file than the sections they name: the manual is
  // named in the intro paragraph and `按目的进入` is forward-referenced by step 3. Comparing
  // offsets over the whole file therefore never looks at the reading-order list itself,
  // and it passes when that list stops naming the manual.
  const order = sectionAt(index, /^## 新会话先读什么/m)
  const purpose = index.search(/^## 按目的进入/m)
  check(
    'the index tells a new session to read the manual before anything else',
    order.found && purpose !== -1 && order.body.includes('27-开发与集成手册.md'),
    'the reading-order section has to exist, come before the by-purpose one, and name the manual',
  )
  check(
    'and the reading-order section comes first',
    order.found && purpose !== -1 && index.indexOf(order.body.slice(0, 2)) < purpose,
    'the reading order has to come before the by-purpose section',
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
  // The command is the authority on which budgets exist: an `id` that only lives in
  // the script is a limit nobody was told about, and one that only lives in the manual
  // is a limit nobody enforces.
  //
  // Both sides parse loosely on purpose. Pinning the script side to four spaces and single
  // quotes meant a budget reformatted to two spaces, or an id carrying a digit, was invisible
  // to the extractor -- so it existed in the command with no manual row and both sides stayed
  // green. What closes that is the count check below: the number of rows must match the
  // number of budgets, so a budget neither side could parse cannot pass as absent.
  const script = read('scripts/perf-budget.mjs')
  const manual = read(PERF)

  const slots = [...script.matchAll(/^[ \t]*id:[ \t]*['"]([A-Za-z0-9_-]+)['"]/gm)].map((match) => match[1])
  // `state-file-bytes` is checked after the loop over `BUDGETS` rather than listed in it;
  // it counts as enforced only where the limit is compared, not where the name appears.
  const enforced = slots.concat(script.includes('MAX_STATE_BYTES') ? ['state-file-bytes'] : [])
  const structural = ['sse-frame-bytes']

  check('the budget command declares budgets', slots.length >= 3, String(slots.length))
  check('and each budget it declares appears once', new Set(slots).size === slots.length, slots.join(', '))
  check(
    'and the state-file limit is a comparison, not a mention',
    script.includes('sessions.maxBytes > MAX_STATE_BYTES'),
    'a budget counts as enforced only where the limit is compared',
  )

  const table = sectionAt(manual, /^## 1 · /m)
  check('the performance manual has a budget table section', table.found, PERF)
  check(
    'and that section ends at a real heading',
    /^## 2 · /m.test(manual),
    'without an end marker the slice runs to the end of the file and swallows the next table',
  )
  const documented = [...table.body.matchAll(/^[ \t]*\|[ \t]*`([A-Za-z0-9_-]+)`[ \t]*\|/gm)].map((match) => match[1])
  check('the manual lists its budgets by id', documented.length >= 5, String(documented.length))
  check('and lists each of them once', new Set(documented).size === documented.length, documented.join(', '))

  const named = documented.filter((id) => !structural.includes(id))
  check(
    'and lists exactly the budgets the command enforces',
    named.length === enforced.length && enforced.every((id) => named.includes(id)),
    `${named.length} named in the manual, ${enforced.length} enforced by the command`,
  )

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
      table.body.includes(id) && table.body.includes('test/api.test.mjs'),
      PERF,
    )
  }
}

// --- multi-agent entrypoints, task handoff, active views, and anti-drift ---

{
  const agents = read('AGENTS.md')
  const agentsLines = agents.split(/\r?\n/).length
  check('AGENTS.md exists at repo root', existsSync(join(root, 'AGENTS.md')), 'AGENTS.md')
  check('AGENTS.md stays concise (<= 120 lines)', agentsLines <= 120, `${agentsLines} lines`)
  check('AGENTS.md links the development manual', agents.includes('docs/27-开发与集成手册.md'), 'AGENTS.md')
  check('AGENTS.md links ACTIVE-STATE.md', agents.includes('docs/handover/ACTIVE-STATE.md'), 'AGENTS.md')
  check(
    'AGENTS.md enforces one-shot review subagents and blocks on failure',
    agents.includes('一次性子代理') && agents.includes('严禁复用') && agents.includes('严禁降级为自审') && agents.includes('阻塞'),
    'AGENTS.md',
  )

  check('docs/tasks/README.md exists', existsSync(join(root, 'docs/tasks/README.md')), 'docs/tasks/README.md')
  check('docs/tasks/_template.md exists', existsSync(join(root, 'docs/tasks/_template.md')), 'docs/tasks/_template.md')

  const activeState = read('docs/handover/ACTIVE-STATE.md')
  const activeDecisions = read('docs/handover/ACTIVE-DECISIONS.md')
  check('docs/handover/ACTIVE-STATE.md exists and is auto-generated', activeState.includes('AUTO-GENERATED'), 'ACTIVE-STATE.md')
  check('docs/handover/ACTIVE-DECISIONS.md exists and is auto-generated', activeDecisions.includes('AUTO-GENERATED'), 'ACTIVE-DECISIONS.md')

  const indexBytes = Buffer.byteLength(read(INDEX), 'utf8')
  check('docs/00-文档索引.md stays lightweight (< 20 KB)', indexBytes < 20_000, `${indexBytes} bytes`)

  const manual = read(MANUAL)
  check(
    'docs/27 Step 10 does not instruct blind `git add -A && git commit`',
    !manual.includes('git add -A && git commit'),
    MANUAL,
  )

  const sec3 = sectionAt(manual, /^## 3 · /m)
  const sec3Suites = [...sec3.body.matchAll(/^[ \t]*\|[ \t]*`((?:scripts|test)\/mutate-[A-Za-z0-9_-]+\.mjs)`[ \t]*\|/gm)]
    .map((m) => m[1])
    .sort()
  const regBlockMatch = manual.match(/<!-- registration:mutation-suites -->([\s\S]*?)<!-- \/registration:mutation-suites -->/)
  const regSuites = regBlockMatch
    ? [...regBlockMatch[1].matchAll(/^[ \t]*\|[ \t]*`((?:scripts|test)\/mutate-[A-Za-z0-9_-]+\.mjs)`[ \t]*\|/gm)]
        .map((m) => m[1])
        .sort()
    : []
  const routerText = read('scripts/gate-mutate.mjs')
  const routerSuites = [...routerText.matchAll(/script:\s*'((?:scripts|test)\/mutate-[A-Za-z0-9_-]+\.mjs)'/g)]
    .map((m) => m[1])
    .sort()

  check(
    'docs/27 §3 mutation table matches §7 registration:mutation-suites',
    sec3Suites.length === regSuites.length && sec3Suites.every((s, i) => s === regSuites[i]),
    `§3=${sec3Suites.length} (${sec3Suites.join(', ')}) vs §7=${regSuites.length} (${regSuites.join(', ')})`,
  )
  check(
    'scripts/gate-mutate.mjs covers every mutation suite in §7',
    routerSuites.length === regSuites.length && routerSuites.every((s, i) => s === regSuites[i]),
    `router=${routerSuites.length} vs §7=${regSuites.length}`,
  )

  const sec8 = sectionAt(manual, /^## 8 · /m)
  check('docs/27 has §8 Bug Fix SOP section', sec8.found, MANUAL)
  check(
    'docs/27 §8 covers B1–B5 steps',
    ['### B1 · ', '### B2 · ', '### B3 · ', '### B4 · ', '### B5 · '].every((m) => sec8.body.includes(m)),
    MANUAL,
  )
  const firstStepIdx = manual.indexOf('### 第 1 步')
  const beforeStep1 = firstStepIdx > 0 ? manual.slice(0, firstStepIdx) : ''
  check(
    'docs/27 §2 intro routes bug fixes to §8',
    /Bug[^。]*§8/u.test(beforeStep1),
    MANUAL,
  )

  const sec1 = sectionAt(manual, /^## 1 · /m)
  check(
    'docs/27 §1 documents host environment prerequisites',
    sec1.found && sec1.body.includes('### 宿主机外部依赖与环境前置'),
    MANUAL,
  )
  const sec2 = sectionAt(manual, /^## 2 · /m)
  const step6Start = sec2.body.indexOf('### 第 6 步')
  const step7Start = sec2.body.indexOf('### 第 7 步')
  const step6Body =
    sec2.found && step6Start !== -1 && step7Start > step6Start
      ? sec2.body.slice(step6Start, step7Start)
      : ''
  check(
    'docs/27 §2 Step 6 requires ephemeral one-shot review subagents',
    step6Body.includes('一次性子代理') && step6Body.includes('严禁复用'),
    MANUAL,
  )
  check(
    'docs/27 §2 Step 6 blocks on review subagent failure instead of self-review',
    step6Body.includes('严禁降级为自审') && step6Body.includes('阻塞'),
    MANUAL,
  )

  // Frozen legacy handover ledgers: append new records under docs/handover/entries/ instead.
  const FROZEN_LEDGERS = {
    'docs/handover/01-status.md': 'e5c3fb7eb487e6c0942afb31178cc2825582334d0fe0b11a866bb3ae5f89453d',
    'docs/handover/02-decisions.md': '737ab008167a64029ea9fe31e1133a1c5de34c4b78bade8ea9a15cbf03e36d78',
    'docs/handover/03-defects.md': '638c6aa639eaae286303e2c5c0db6952f8b20f7f1c9f98d7756017abeee2481b',
    'docs/handover/04-reviews.md': '3322f287d731a3969e6137dbdac2e283fac404bea9f287a2c59f81e9339055fb',
  }
  for (const [relPath, expectedHash] of Object.entries(FROZEN_LEDGERS)) {
    const normalized = read(relPath).replace(/\r\n/g, '\n')
    const actualHash = createHash('sha256').update(normalized, 'utf8').digest('hex')
    check(
      `${relPath} remains frozen (append new records to docs/handover/entries/)`,
      actualHash === expectedHash,
      actualHash === expectedHash ? undefined : `expected ${expectedHash}, got ${actualHash}`,
    )
  }
}

if (failed > 0) {
  for (const failure of failures) console.log(`FAIL ${failure.label} -- ${failure.detail ?? ''}`)
}
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
