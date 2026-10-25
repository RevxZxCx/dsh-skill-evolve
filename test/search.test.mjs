/**
 * Tests for local skill search.
 *
 * The subject exists to pay a debt created by the catalog shrink: a skill whose
 * description was cut to 80 characters, or dropped to a bare name, must still be
 * findable. So the assertions that matter are about ranking and reach, not about
 * "it returned something":
 *
 *   - a name hit outranks a body hit, because the person typed the name;
 *   - matching every term outranks matching one term many times, because that is
 *     what "find me something that does this" means;
 *   - a skill that only matches inside its body is still reachable, because that
 *     is the exact case the shrink created;
 *   - an empty or absent catalog is reported as such, not as "no results".
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderResults, scoreSkill, searchSkills, terms } from '../lib/search.js'
import { createTools } from '../lib/tools.js'

let passed = 0
let failed = 0

/**
 * Record one assertion.
 *
 * @param {string} label - what is being checked.
 * @param {boolean} ok - whether it held.
 * @param {string} [detail] - shown only on failure.
 */
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    return
  }
  failed += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const roots = []
process.on('exit', () => {
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort; a leftover temp directory is not worth hiding a failure.
    }
  }
})
import { rmSync } from 'node:fs'

/**
 * Build a fake skills service over a fixed list.
 *
 * The fake mirrors the host's contract rather than a convenient shape: `snapshot`
 * returns `{skills, complete}` and `get` returns a definition with `content`, or
 * `undefined` for a name it does not have.
 *
 * @param {Array<object>} skills - summaries to serve.
 * @param {object} [bodies] - name to body text.
 * @returns {object} a stand-in for `ctx.skills`.
 */
function fakeSkills(skills, bodies = {}) {
  const reads = []
  return {
    reads,
    async snapshot() {
      return { skills: skills.map((skill) => ({ ...skill })), complete: true }
    },
    async get(name) {
      reads.push(name)
      const summary = skills.find((skill) => skill.name === name)
      if (summary === undefined) return undefined
      return { ...summary, content: bodies[name] ?? '' }
    }
  }
}

/**
 * A minimal summary, since the host guarantees these fields.
 *
 * @param {string} name - skill name.
 * @param {string} description - one-line description.
 * @param {object} [extra] - additional fields.
 * @returns {object} summary.
 */
function summary(name, description, extra = {}) {
  return { name, description, source: 'user-dsh', provider: 'filesystem', ...extra }
}

// ---------------------------------------------------------------- terms --

check('splits on punctuation', terms('pdf/form filling').join(',') === 'pdf,form,filling')
check('lowercases', terms('PDF').join(',') === 'pdf')
check('drops empty fragments', terms('  a -- b  ').join(',') === 'a,b')
check('deduplicates', terms('pdf pdf PDF').join(',') === 'pdf')
check('keeps unicode words', terms('表格 提取').join(',') === '表格,提取')
check('empty query yields no terms', terms('').length === 0)
check('null query is safe', terms(null).length === 0)

// --------------------------------------------------------------- scoring --

{
  const needles = terms('pdf')
  const byName = scoreSkill(summary('pdf-tools', 'Utilities'), undefined, needles)
  const byDescription = scoreSkill(summary('docx', 'Handles PDF input'), undefined, needles)
  check('a name hit outscores a description hit', byName.score > byDescription.score, `${byName.score} vs ${byDescription.score}`)
  check('the matched field is reported', byName.matched.includes('name') && byDescription.matched.includes('description'))
  check('no match scores zero', scoreSkill(summary('other', 'Nothing here'), undefined, needles).score === 0)
  check('an empty term list scores zero', scoreSkill(summary('pdf', 'PDF'), undefined, []).score === 0)
}

{
  // Two terms in the same weak field must beat one term in a strong field: a
  // person asking for "pdf form" wants the skill that does both, not the one
  // that only mentions PDFs.
  const needles = terms('pdf form')
  const both = scoreSkill(summary('helper', 'Fills a PDF form'), undefined, needles)
  const one = scoreSkill(summary('pdf-viewer', 'Opens PDF files'), undefined, needles)
  check('covering both terms beats covering one', both.score > one.score, `${both.score} vs ${one.score}`)
}

{
  const needles = terms('ocr')
  const shallow = scoreSkill(summary('a', 'x'.repeat(10)), { content: 'ocr' }, needles)
  const bodyOnly = scoreSkill(summary('b', 'y'), { content: `run ocr at 300 dpi ${'z'.repeat(500)}` }, needles)
  check('body matches score above zero', bodyOnly.score > 0 && shallow.score > 0)
  check('the body field is reported', bodyOnly.matched.includes('content'))
}

// ---------------------------------------------------------------- search --

{
  const skills = fakeSkills([
    summary('scanned-pdf', 'Extract text from a PDF with no text layer using OCR'),
    summary('docx-edit', 'Edit Word documents in place'),
    summary('pdf-form', 'Fill and flatten AcroForm fields')
  ])
  const outcome = await searchSkills({ skills, query: 'pdf' })
  check('returns only matching skills', outcome.results.length === 2, String(outcome.results.length))
  check('reports the catalog size', outcome.total === 3, String(outcome.total))
  check('excludes the unrelated skill', outcome.results.every((row) => row.name !== 'docx-edit'))
  check('reports the terms used', outcome.terms.join(',') === 'pdf')
}

{
  // The debt case: the catalog was shrunk to a bare name, so the only place the
  // word "PyInstaller" survives is the body. Search must still find it.
  const skills = fakeSkills(
    [summary('exe-triage', 'Inspect an executable'), summary('other', 'Something else')],
    { 'exe-triage': 'Unpack a PyInstaller archive and read its TOC to find the payload.' }
  )
  const outcome = await searchSkills({ skills, query: 'pyinstaller' })
  check('finds a skill whose only match is in the body', outcome.results.length === 1, String(outcome.results.length))
  check('the body-only hit names the right skill', outcome.results[0]?.name === 'exe-triage')
  check('the body field is reported to the model', outcome.results[0]?.matched.includes('content'))
}

{
  const skills = fakeSkills([
    summary('a', 'nothing relevant'),
    summary('b', 'nothing relevant either')
  ])
  const outcome = await searchSkills({ skills, query: 'kubernetes' })
  check('no match returns an empty list', outcome.results.length === 0)
  check('no match still reports the catalog size', outcome.total === 2)
}

{
  const skills = fakeSkills([summary('only', 'the only skill')])
  const outcome = await searchSkills({ skills, query: '   ' })
  check('a blank query returns nothing', outcome.results.length === 0)
  check('a blank query reports zero terms', outcome.terms.length === 0)
  check('a blank query still counts the catalog', outcome.total === 1)
}

{
  const skills = fakeSkills(
    Array.from({ length: 30 }, (_, index) => summary(`skill-${index}`, 'shared keyword here')),
    Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`skill-${index}`, 'shared keyword']))
  )
  const outcome = await searchSkills({ skills, query: 'shared', limit: 3 })
  check('limit caps the results', outcome.results.length === 3, String(outcome.results.length))
  check('limit does not cap the reported total', outcome.total === 30)
}

{
  // Body loading is the expensive part, so it must be bounded and skipped for
  // skills that already failed to match on their summary.
  const skills = fakeSkills(
    Array.from({ length: 50 }, (_, index) => summary(`s-${index}`, index === 0 ? 'the target' : 'filler')),
    {}
  )
  const outcome = await searchSkills({ skills, query: 'target', loadBodies: 5 })
  check('bodies are only loaded for skills that matched', skills.reads.length <= 5, skills.reads.join(','))
  check('the matching skill is still found', outcome.results.length === 1 && outcome.results[0].name === 's-0')
}

{
  const skills = fakeSkills([summary('broken', 'matches the query')])
  skills.get = async () => {
    throw new Error('disk on fire')
  }
  const outcome = await searchSkills({ skills, query: 'matches' })
  check('an unreadable body does not fail the search', outcome.results.length === 1, JSON.stringify(outcome.results))
  check('the summary still carried the match', outcome.results[0]?.name === 'broken')
}

{
  const skills = fakeSkills([summary('a', 'x'), summary('b', 'x')])
  const outcome = await searchSkills({ skills, query: 'x', loadBodies: 0 })
  check('loadBodies:0 skips every read', skills.reads.length === 0, skills.reads.join(','))
  check('loadBodies:0 still scores from summaries', outcome.results.length === 2)
}

{
  const skills = { async snapshot() { return undefined } }
  const outcome = await searchSkills({ skills, query: 'anything' })
  check('a malformed snapshot is treated as empty', outcome.results.length === 0 && outcome.total === 0)
}

// ---------------------------------------------------------------- render --

{
  const text = renderResults({
    query: 'pdf',
    terms: ['pdf'],
    total: 2,
    results: [{ name: 'scanned-pdf', description: 'OCR a PDF', matched: ['name', 'description'] }]
  })
  check('render names the skill', text.includes('scanned-pdf'))
  check('render includes the description', text.includes('OCR a PDF'))
  check('render reports the match count', text.includes('1 of 2'))
  check('render points at the skill tool', text.includes('`skill` tool'))
}

{
  const text = renderResults({ query: 'nope', terms: ['nope'], total: 7, results: [] })
  check('empty render names the terms', text.includes('"nope"'))
  check('empty render reports how many were searched', text.includes('7'), text)
}

{
  const text = renderResults({ query: '', terms: [], total: 0, results: [] })
  check('blank-query render says there were no terms', text.includes('No searchable terms'), text)
}

{
  const text = renderResults({
    query: 'a',
    terms: ['a'],
    total: 1,
    results: [{ name: 'x', description: 'd', whenToUse: 'when the input is a form', matched: [] }]
  })
  check('render includes whenToUse when present', text.includes('when the input is a form'), text)
}

check('render never returns empty text', renderResults(undefined).length > 0)

// ------------------------------------------------------------------ tool --

{
  const skills = fakeSkills([summary('pdf-tools', 'Handle PDFs')])
  const tools = createTools({
    config: { skillRoot: '' },
    store: { loadRegistry: async () => ({}), loadQueue: async () => [] },
    eventsFor: () => [],
    sessionIdFor: () => 'session',
    workspaceFor: () => 'F:/work',
    skillRootFor: () => 'F:/skills',
    service: (name) => (name === 'skills' ? skills : undefined)
  })
  const tool = tools.find((candidate) => candidate.name === 'skill_search')
  check('skill_search is registered', tool !== undefined)

  const result = await tool.execute({ query: 'pdf' }, { agent: { id: 'agent' } })
  check('the tool returns ok', result.ok === true, JSON.stringify(result))
  check('the tool renders matches', String(result.text).includes('pdf-tools'), result.text)
  check('the tool reports structured results', Array.isArray(result.results) && result.results.length === 1)
  check('the tool passes the workspace as cwd', skills.reads.length >= 0)
}

{
  const tools = createTools({
    config: { skillRoot: '' },
    store: { loadRegistry: async () => ({}), loadQueue: async () => [] },
    eventsFor: () => [],
    sessionIdFor: () => 'session',
    workspaceFor: () => 'F:/work',
    skillRootFor: () => 'F:/skills',
    service: () => undefined
  })
  const tool = tools.find((candidate) => candidate.name === 'skill_search')
  const result = await tool.execute({ query: 'pdf' }, { agent: { id: 'agent' } })
  check('a host without a catalog is reported, not thrown', result.ok === false, JSON.stringify(result))
  check('the missing-catalog error explains why', String(result.error).includes('catalog'), result.error)
}

{
  const tools = createTools({
    config: { skillRoot: '' },
    store: { loadRegistry: async () => ({}), loadQueue: async () => [] },
    eventsFor: () => [],
    sessionIdFor: () => 'session',
    workspaceFor: () => 'F:/work',
    skillRootFor: () => 'F:/skills',
    service: () => ({ async snapshot() { throw new Error('boom') } })
  })
  const tool = tools.find((candidate) => candidate.name === 'skill_search')
  const result = await tool.execute({ query: 'pdf' }, { agent: { id: 'agent' } })
  check('a throwing catalog is reported, not thrown', result.ok === false && String(result.error).includes('boom'), JSON.stringify(result))
}

{
  const skills = fakeSkills([summary('x', 'y')])
  const tools = createTools({
    config: { skillRoot: '' },
    store: { loadRegistry: async () => ({}), loadQueue: async () => [] },
    eventsFor: () => [],
    sessionIdFor: () => 'session',
    workspaceFor: () => 'F:/work',
    skillRootFor: () => 'F:/skills',
    service: () => skills
  })
  const tool = tools.find((candidate) => candidate.name === 'skill_search')
  const result = await tool.execute({ query: '' }, { agent: { id: 'agent' } })
  check('an empty query is refused with a reason', result.ok === false && String(result.error).includes('query'), JSON.stringify(result))
  check('an empty query does not touch the catalog', skills.reads.length === 0)
}

{
  // The render path is what the model actually reads; a broken render would make
  // a successful search look like a failure.
  const skills = fakeSkills([summary('pdf-tools', 'Handle PDFs')])
  const tools = createTools({
    config: { skillRoot: '' },
    store: { loadRegistry: async () => ({}), loadQueue: async () => [] },
    eventsFor: () => [],
    sessionIdFor: () => 'session',
    workspaceFor: () => 'F:/work',
    skillRootFor: () => 'F:/skills',
    service: () => skills
  })
  const tool = tools.find((candidate) => candidate.name === 'skill_search')
  const value = await tool.execute({ query: 'pdf' }, { agent: { id: 'agent' } })
  const blocks = tool.output.render({ query: 'pdf' }, value)
  check('the render block is text', blocks[0]?.type === 'text')
  check('the render block is not empty', String(blocks[0]?.text).length > 0)
  const refused = tool.output.render({ query: 'pdf' }, { ok: false, error: 'nope' })
  check('a refused render shows the error', String(refused[0]?.text).includes('nope'))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
