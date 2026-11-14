/**
 * Tests for `report_output_files` — the tool a model calls to say what it made.
 *
 * The tool's own `execute` looks like a no-op, because the recording happens in
 * `transcript.js` off the `tool/call` event. That is exactly why it needs its
 * own suite: the only thing `execute` does is *reject*, and a rejection that
 * silently succeeds is invisible from the card. A model that passes sixty paths
 * and is told "60 recorded" will not report the remaining ten.
 *
 * The counterpart assertions — that a legal call really does reach the card —
 * live in `test/transcript.test.mjs`, next to the other collection rules.
 */

import { createReportTool } from '../packages/ui-evolve/lib/report-tool.js'
import { MAX_REPORTED_PATHS } from '../packages/ui-evolve/lib/transcript.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    failures.push(detail === undefined ? label : `${label} — ${detail}`)
  }
}

/**
 * Run the tool's `execute` and fail loudly if it throws instead of answering.
 *
 * Returning a failure is the contract: a thrown error reaches the model as a
 * generic tool crash, which says nothing about which argument was wrong.
 */
async function run(args) {
  const tool = createReportTool()
  try {
    return await tool.execute(args, {})
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) }
  }
}

// --------------------------------------------------------------- the shape --

{
  const tool = createReportTool()

  check('the tool is named for what it does', tool.name === 'report_output_files', tool.name)
  check('it has a description', typeof tool.description === 'string' && tool.description.length > 80, String(tool.description?.length))
  check('the description says not to report written files', /write or edit/i.test(tool.description) === true, 'does not warn about duplicates')

  // The description has one job beyond naming the tool: stop the model from
  // doing what it actually did on the first real run, which was to answer with
  // `present` and three files. `present` is the host's own deliverable tool, so
  // a description that never mentions it gives the model no way to tell the two
  // apart — and it will pick the name it already knows.
  //
  // Asserting the presence of the comparison, not its wording: the sentence can
  // be rewritten, but a revision that drops it entirely is the regression.
  check('the description says it is not present', /\bnot\b[^.]*\bpresent\b/i.test(tool.description) === true, 'never distinguishes itself from present')
  check('the description names present so the model can tell them apart', tool.description.includes('present') === true, 'does not mention present at all')

  const parameters = tool.parameters
  check('paths is required', Array.isArray(parameters.required) && parameters.required.includes('paths') === true, JSON.stringify(parameters.required))
  check('paths is an array of strings', parameters.properties?.paths?.type === 'array' && parameters.properties?.paths?.items?.type === 'string', JSON.stringify(parameters.properties?.paths))
  check('the schema states the same cap the code enforces', parameters.properties?.paths?.maxItems === MAX_REPORTED_PATHS, String(parameters.properties?.paths?.maxItems))
  check('a note is allowed but not required', parameters.properties?.note !== undefined && parameters.required.includes('note') === false, 'note is mandatory')
  check('nothing else may be passed', parameters.additionalProperties === false, 'additional properties allowed')

  check('the output schema is an object', tool.output?.schema?.type === 'object', JSON.stringify(tool.output?.schema))
  check('there is a render for the result', typeof tool.output?.render === 'function', 'no render')

  // A render that says "recorded" when nothing was recorded is the one lie that
  // matters here: the model would stop looking for the files it failed to list.
  const rejected = tool.output.render({}, { ok: false, code: 'no-paths', error: 'nothing' })
  check('a rejection is rendered as a rejection', JSON.stringify(rejected).includes('Not recorded') === true, JSON.stringify(rejected))
  const empty = tool.output.render({}, { ok: true, recorded: 0, ignored: [] })
  check('recording nothing does not read as success', JSON.stringify(empty).includes('Nothing to record') === true, JSON.stringify(empty))
  const one = tool.output.render({}, { ok: true, recorded: 1, ignored: [] })
  check('one file is described in the singular', JSON.stringify(one).includes('1 file recorded') === true, JSON.stringify(one))
  const many = tool.output.render({}, { ok: true, recorded: 3, ignored: [] })
  check('three files are described in the plural', JSON.stringify(many).includes('3 files recorded') === true, JSON.stringify(many))
  const partial = tool.output.render({}, { ok: true, recorded: 2, ignored: ['x'] })
  check('a dropped entry is reported, not swallowed', JSON.stringify(partial).includes('1 entry was') === true, JSON.stringify(partial))
}

// ---------------------------------------------------------------- rejecting --

{
  const noArray = await run({ paths: 'F:/a.txt' })
  check('a string is not a list of paths', noArray.ok === false && noArray.code === 'no-paths', JSON.stringify(noArray))
  check('and the answer says what to pass instead', typeof noArray.error === 'string' && noArray.error.includes('array') === true, String(noArray.error))

  const missing = await run({})
  check('no paths at all is refused', missing.ok === false && missing.code === 'no-paths', JSON.stringify(missing))

  const blanks = await run({ paths: ['', '   ', 7, null] })
  check('a list of nothing usable is refused', blanks.ok === false && blanks.code === 'no-paths', JSON.stringify(blanks))

  // An oversized list is not a mistake to refuse. The reader has already taken
  // the first entries off the `tool/call` event by the time `execute` runs, so
  // answering `ok: false` would be a claim the code cannot make good on. What it
  // can do is say exactly how many fit and how many were dropped.
  const over = await run({ paths: Array.from({ length: MAX_REPORTED_PATHS + 1 }, (_, i) => `f${i}.txt`) })
  check('a list over the cap still succeeds', over.ok === true, JSON.stringify({ code: over.code, ok: over.ok }))
  check('and it reports only the rows that fit', over.recorded === MAX_REPORTED_PATHS, String(over.recorded))
  check('and it says how many were dropped', over.dropped === 1, String(over.dropped))
  check('the dropped count reaches the model', JSON.stringify(createReportTool().output.render({}, over)).includes('1 later entry') === true, JSON.stringify(createReportTool().output.render({}, over)))

  // The cap is counted after cleaning, not before: fifty paths plus ten blanks
  // is still a legal call, and refusing it would teach the model to count.
  const padded = await run({ paths: [...Array.from({ length: MAX_REPORTED_PATHS }, (_, i) => `f${i}.txt`), '', '  '] })
  check('blanks do not count against the cap', padded.ok === true && padded.recorded === MAX_REPORTED_PATHS, JSON.stringify({ ok: padded.ok, recorded: padded.recorded }))
  check('and a call at the cap drops nothing', padded.dropped === 0, String(padded.dropped))
}

// ---------------------------------------------------------------- accepting --

{
  const ok = await run({ paths: ['F:/test/test8/doc.docx', 'F:/test/test8/image.png'] })
  check('two usable paths are accepted', ok.ok === true && ok.recorded === 2, JSON.stringify(ok))
  check('nothing is reported as ignored', Array.isArray(ok.ignored) && ok.ignored.length === 0, JSON.stringify(ok.ignored))

  const padded = await run({ paths: ['  F:/test/padded.txt  ', 7, ''] })
  check('a padded path is trimmed and kept', padded.ok === true && padded.recorded === 1, JSON.stringify(padded))
  check('the unusable entries are listed', Array.isArray(padded.ignored) && padded.ignored.length === 2, JSON.stringify(padded.ignored))

  const relative = await run({ paths: ['out/relative.pdf', '../above.txt'] })
  check('relative paths are accepted as written', relative.ok === true && relative.recorded === 2, JSON.stringify(relative))

  const withNote = await run({ paths: ['a.bin'], note: 'written by make.py' })
  check('a note does not change the outcome', withNote.ok === true && withNote.recorded === 1, JSON.stringify(withNote))

  // Exactly at the cap is legal. An off-by-one in the comparison would refuse
  // the fiftieth file of a fifty-file declaration, which is the one case the
  // limit is documented to allow.
  const atCap = await run({ paths: Array.from({ length: MAX_REPORTED_PATHS }, (_, i) => `f${i}.txt`) })
  check('exactly the cap is accepted', atCap.ok === true && atCap.recorded === MAX_REPORTED_PATHS, JSON.stringify({ ok: atCap.ok, code: atCap.code }))
}

// ------------------------------------------------------------- not throwing --

{
  const thrown = await run(undefined)
  check('a call with no arguments is refused, not thrown', thrown.threw === undefined && thrown.ok === false, JSON.stringify(thrown))

  const arrayArgs = await run(['a.txt'])
  check('an array instead of an object is refused', arrayArgs.threw === undefined && arrayArgs.ok === false, JSON.stringify(arrayArgs))

  const nested = await run({ paths: [['a.txt']] })
  check('a nested array is not a path', nested.ok === false && nested.code === 'no-paths', JSON.stringify(nested))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
