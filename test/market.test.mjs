/**
 * Tests for the external market, and for the two properties that make it safe
 * to ship: a market id or bundle path can never name a location outside the
 * skill directory, and an install can never happen without the host's approval
 * seam saying yes.
 *
 * No test here touches the network. `searchMarket` and `fetchMarketBundle` take
 * the fetch implementation as an argument precisely so that a test can hand them
 * a fake, which means the transport bugs a fake cannot model (TLS, redirects,
 * chunked encoding) stay uncovered — accepted, because the alternative is a test
 * suite that fails when skills.sh has a bad day.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  destinationFor,
  fetchMarketBundle,
  installMarketSkill,
  isSafeBundlePath,
  isValidMarketId,
  listInstalled,
  normaliseHit,
  previewMarketSkill,
  renderPreview,
  renderSearch,
  searchMarket
} from '../lib/market.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..')

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

async function throws(label, run) {
  try {
    await run()
    check(label, false, 'did not throw')
  } catch {
    check(label, true)
  }
}

/** A fetch that answers with the given JSON body, and records what it was asked. */
function fakeFetch(body, options = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    if (options.throws === true) throw new Error('network down')
    const status = options.status ?? 200
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      body: {
        getReader() {
          const bytes = new TextEncoder().encode(text)
          let done = false
          return {
            async read() {
              if (done) return { done: true, value: undefined }
              done = true
              return { done: false, value: bytes }
            },
            async cancel() {}
          }
        }
      }
    }
  }
  impl.calls = calls
  return impl
}

// --------------------------------------------------------------- identifiers

check('a well formed id is accepted', isValidMarketId('anthropics/skills/pdf'))
check('a two-part id is rejected', isValidMarketId('anthropics/skills') === false)
check('a four-part id is rejected', isValidMarketId('a/b/c/d') === false)
check('a traversal id is rejected', isValidMarketId('../etc/passwd') === false)
check('an encoded separator is rejected', isValidMarketId('a/b%2fc') === false)
check('a leading dot segment is rejected', isValidMarketId('./b/c') === false)
check('a non-string id is rejected', isValidMarketId(undefined) === false)
check('an empty segment is rejected', isValidMarketId('a//c') === false)

// -------------------------------------------------------------- bundle paths

check('a nested path is safe', isSafeBundlePath('scripts/x.py'))
check('a top level file is safe', isSafeBundlePath('SKILL.md'))
check('a dotfile directory is safe', isSafeBundlePath('.github/workflow.yml'))
check('a parent reference is refused', isSafeBundlePath('../x') === false)
check('a nested parent reference is refused', isSafeBundlePath('a/../b') === false)
check('a current-dir segment is refused', isSafeBundlePath('a/./b') === false)
check('an absolute posix path is refused', isSafeBundlePath('/etc/passwd') === false)
check('a backslash path is refused', isSafeBundlePath('a\\b') === false)
check('an empty path is refused', isSafeBundlePath('') === false)
check('a doubled separator is refused', isSafeBundlePath('a//b') === false)

// The platform `normalize` turns `scripts/x.py` into `scripts\\x.py` on Windows,
// which is why the check uses posix rules. This asserts the whole class stays
// working rather than one example of it.
check(
  'every well formed nested path survives the platform',
  ['a', 'a/b', 'a/b/c.md', 'scripts/check_x.py'].every((path) => isSafeBundlePath(path))
)

// ---------------------------------------------------------------- normalise

check('a market hit keeps its id', normaliseHit({ id: 'a/b/c', name: 'c', installs: 5 })?.id === 'a/b/c')
check('a market hit derives the name when absent', normaliseHit({ id: 'a/b/c' })?.name === 'c')
check(
  'a market hit derives the source when absent',
  normaliseHit({ id: 'a/b/c' })?.source === 'a/b'
)
check('a bad hit is dropped', normaliseHit({ id: 'nope' }) === undefined)
check('a null hit is dropped', normaliseHit(null) === undefined)
check('a negative install count is floored to zero', normaliseHit({ id: 'a/b/c', installs: -3 })?.installs === 0)
check('a non-numeric install count is floored to zero', normaliseHit({ id: 'a/b/c', installs: 'x' })?.installs === 0)

// ------------------------------------------------------------------ search

{
  const fetch = fakeFetch({
    skills: [
      { id: 'a/b/low', name: 'low', installs: 1 },
      { id: 'a/b/high', name: 'high', installs: 900 },
      { id: 'broken' }
    ]
  })
  const outcome = await searchMarket({ query: 'pdf', fetch })
  check('search keeps the valid hits', outcome.hits.length === 2)
  check('search sorts by installs descending', outcome.hits[0].id === 'a/b/high')
  check('search reports the total before slicing', outcome.total === 2)
  check('search asked the search endpoint', fetch.calls[0].url.includes('/api/search'))
  check('search encoded the query', fetch.calls[0].url.includes('q=pdf'))
  check('search asked for no redirects', fetch.calls[0].init.redirect === 'error')
  check('search sent an abort signal', fetch.calls[0].init.signal !== undefined)
}

{
  const fetch = fakeFetch({ skills: [] })
  const outcome = await searchMarket({ query: 'nothing', fetch })
  check('an empty market result is not an error', outcome.hits.length === 0)
}

{
  const fetch = fakeFetch({ skills: [] })
  await searchMarket({ query: 'q', limit: 999, fetch })
  check('the limit is capped at fifty', fetch.calls[0].url.includes('limit=50'))
}

{
  const fetch = fakeFetch({ skills: [] })
  await searchMarket({ query: 'q', limit: 0, fetch })
  check('a zero limit falls back to the default', fetch.calls[0].url.includes('limit=10'))
}

await throws('an empty query is refused', () => searchMarket({ query: '   ', fetch: fakeFetch({}) }))
await throws('an overlong query is refused', () => searchMarket({ query: 'x'.repeat(101), fetch: fakeFetch({}) }))
await throws('a throwing fetch surfaces as an error', () => searchMarket({ query: 'q', fetch: fakeFetch({}, { throws: true }) }))
await throws('a non-200 response is an error', () => searchMarket({ query: 'q', fetch: fakeFetch({}, { status: 500 }) }))

// ----------------------------------------------------------------- preview

{
  const fetch = fakeFetch({
    hash: 'abc',
    files: [
      { path: 'SKILL.md', contents: '# Pdf\n\nDo things.' },
      { path: 'scripts/run.py', contents: 'print(1)' },
      { path: '../escape.txt', contents: 'nope' }
    ]
  })
  const outcome = await previewMarketSkill({ id: 'a/b/pdf', fetch })
  check('preview keeps the safe files', outcome.files.length === 2)
  check('preview drops the escaping file', outcome.files.some((f) => f.path.includes('escape')) === false)
  check('preview extracts SKILL.md', outcome.skillMd.startsWith('# Pdf'))
  check('preview keeps the hash', outcome.hash === 'abc')
  check('preview sorts the file list', outcome.files[0].path === 'SKILL.md' && outcome.files[1].path === 'scripts/run.py')
  check('preview asked the download endpoint', fetch.calls[0].url.includes('/api/download/a/b/pdf'))
  check(
    'preview reports a file it refused to unpack',
    Array.isArray(outcome.dropped) && outcome.dropped.length === 1 && outcome.dropped[0].includes('escape'),
    JSON.stringify(outcome.dropped)
  )
}

// A skill body has no upstream size limit. Pasting one whole into the
// conversation spends the context the skill exists to save, so the render is
// capped and says so rather than ending silently.
{
  const huge = 'x'.repeat(20000)
  const fetch = fakeFetch({ hash: 'h', files: [{ path: 'SKILL.md', contents: huge }] })
  const outcome = await previewMarketSkill({ id: 'a/b/big', fetch })
  const text = renderPreview(outcome)
  check('a huge SKILL.md is truncated in the render', text.length < huge.length, String(text.length))
  check('the truncation says how much was withheld', text.includes('not shown'), text.slice(-200))
  check('the full body is still returned for install', outcome.skillMd.length === 20000, String(outcome.skillMd.length))
}

await throws('preview refuses a bad id', () => previewMarketSkill({ id: '../x', fetch: fakeFetch({}) }))
await throws('preview refuses an empty bundle', () => previewMarketSkill({ id: 'a/b/c', fetch: fakeFetch({ files: [] }) }))
await throws(
  'preview refuses a bundle with no safe files',
  () => previewMarketSkill({ id: 'a/b/c', fetch: fakeFetch({ files: [{ path: '../x', contents: 'y' }] }) })
)

// A bundle that carries contents through to install. The point of splitting
// fetch from render is that preview and install read the same payload, so this
// asserts the contents survive the trip.
{
  const fetch = fakeFetch({ files: [{ path: 'SKILL.md', contents: '# X' }] })
  const bundle = await fetchMarketBundle({ id: 'a/b/c', fetch })
  check('the bundle carries contents for install', bundle.files[0].contents === '# X')
  check('the bundle measures bytes', bundle.files[0].bytes === 3)
}

// -------------------------------------------------------------- destination

{
  const root = join(tmpdir(), 'skill-root')
  check('a safe path resolves under the root', destinationFor(root, 'a/b.md')?.startsWith(root) === true)
  check('an escaping path has no destination', destinationFor(root, '../x') === undefined)
  check('an absolute path has no destination', destinationFor(root, '/x') === undefined)
}

// ---------------------------------------------------------------- install

{
  const root = mkdtempSync(join(tmpdir(), 'skill-evolve-market-'))
  try {
    const outcome = await installMarketSkill({
      root,
      files: [
        { path: 'SKILL.md', contents: '# Installed' },
        { path: 'scripts/run.py', contents: 'print(2)' }
      ]
    })
    check('install writes every file', outcome.written.length === 2)
    check('install creates nested directories', existsSync(join(root, 'scripts', 'run.py')))
    check('install writes the contents', readFileSync(join(root, 'SKILL.md'), 'utf8') === '# Installed')
    check('install reports no skips', outcome.skipped.length === 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'skill-evolve-market-'))
  try {
    await installMarketSkill({ root, files: [{ path: 'SKILL.md', contents: 'first' }] })
    const second = await installMarketSkill({ root, files: [{ path: 'SKILL.md', contents: 'second' }] })
    check('a second install without overwrite skips the file', second.skipped.includes('SKILL.md'))
    check('a skipped file keeps its original contents', readFileSync(join(root, 'SKILL.md'), 'utf8') === 'first')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'skill-evolve-market-'))
  try {
    await throws('install refuses an escaping path', () =>
      installMarketSkill({ root, files: [{ path: '../escape.txt', contents: 'x' }] })
    )
    check('the escaping file was not written', existsSync(join(root, '..', 'escape.txt')) === false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await throws('install refuses an empty file list', () => installMarketSkill({ root: tmpdir(), files: [] }))
await throws('install refuses an empty root', () => installMarketSkill({ root: '', files: [{ path: 'a', contents: '' }] }))
await throws('install refuses a non-string root', () => installMarketSkill({ root: Promise.resolve('/tmp/x'), files: [{ path: 'a', contents: '' }] }))
// Coercing a promise gives "[object Promise]", a relative path that resolves
// against the process working directory. The install would then succeed
// somewhere nobody asked for and report it as the skill root.
check('a non-string root has no destination', destinationFor(Promise.resolve('/tmp/x'), 'a/b.md') === undefined)
check('a whitespace root has no destination', destinationFor('   ', 'a/b.md') === undefined)
// The guard exists so a caller sees a value it can branch on, not a thrown
// ERR_INVALID_ARG_TYPE from deep inside path.resolve. Without it the only
// symptom is a crash whose stack points at string coercion, not at the caller
// that passed the promise.
check(
  'a non-string root is a value, not a thrown type error',
  (() => {
    try {
      return destinationFor(Promise.resolve('/tmp/x'), 'a/b.md') === undefined
    } catch {
      return false
    }
  })()
)

// ------------------------------------------------------------- listInstalled

{
  const root = mkdtempSync(join(tmpdir(), 'skill-evolve-market-'))
  try {
    check('an absent directory lists as empty', (await listInstalled(join(root, 'nope'))).length === 0)
    await installMarketSkill({ root, files: [{ path: 'SKILL.md', contents: 'x' }, { path: 'a/b.md', contents: 'y' }] })
    const found = await listInstalled(root)
    check('listing finds every file', found.length === 2)
    check('listing is sorted', found[0] === 'SKILL.md' && found[1] === 'a/b.md')
    check('listing uses forward slashes', found.includes('a/b.md'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ----------------------------------------------------------------- render

{
  const text = renderSearch({
    query: 'pdf',
    hits: [
      { id: 'a/b/pdf', name: 'pdf', installs: 1234 },
      { id: 'a/b/x', name: 'x', installs: 0 }
    ],
    total: 2
  })
  check('search render names each id', text.includes('`a/b/pdf`'))
  check('search render formats installs', text.includes('1,234 installs'))
  check('search render says when there are none', text.includes('no installs'))
  check('search render points at preview', text.includes('skill_market_preview'))
}

check(
  'an empty search render says so',
  renderSearch({ query: 'zzz', hits: [], total: 0 }).includes('No market skill matched')
)

{
  const text = renderPreview({
    id: 'a/b/pdf',
    files: [
      { path: 'SKILL.md', bytes: 10 },
      { path: 'scripts/run.py', bytes: 20 }
    ],
    skillMd: '# Pdf'
  })
  check('preview render lists the files', text.includes('scripts/run.py (20 bytes)'))
  check('preview render flags executables', text.includes('executable file(s)'))
  check('preview render includes SKILL.md', text.includes('# Pdf'))
}

check(
  'preview render says when SKILL.md is missing',
  renderPreview({ id: 'a/b/c', files: [{ path: 'x.md', bytes: 1 }], skillMd: '' }).includes('no SKILL.md')
)

// --------------------------------------- the approval gate is not self-granted

// The gate's *behaviour* is covered in `index.test.mjs`, which drives the real
// `tools/pre-execute` chain. What cannot be checked there is the shape of the
// install tool's schema, and that shape is the whole argument: if the tool
// declared a `confirm` parameter, the model would fill it in itself and the host
// gate would become decorative. Asserting on the live schema instead of grepping
// source means a comment mentioning "confirm" cannot satisfy it, and a real
// parameter cannot hide behind one.
{
  const { createTools } = await import('../lib/tools.js')
  const tools = createTools({
    config: {},
    store: {},
    service: () => undefined,
    workspaceFor: () => 'F:/nonexistent',
    rootFor: () => 'F:/nonexistent'
  })
  const install = tools.find((tool) => tool.name === 'skill_market_install')
  check('the install tool exists', install !== undefined)
  const properties = Object.keys(install?.parameters?.properties ?? {})
  check(
    'the install tool offers no model-supplied confirmation',
    properties.every((name) => name !== 'confirm' && name !== 'approved' && name !== 'force'),
    properties.join(',')
  )
  check(
    'the install tool requires an id',
    Array.isArray(install?.parameters?.required) && install.parameters.required.includes('id'),
    JSON.stringify(install?.parameters?.required)
  )
  // Every market tool, not just install: a `confirm` on search would be harmless
  // today and a habit tomorrow.
  const marketTools = tools.filter((tool) => tool.name.startsWith('skill_market_'))
  check('three market tools are registered', marketTools.length === 3, String(marketTools.length))
  for (const tool of marketTools) {
    const names = Object.keys(tool.parameters?.properties ?? {})
    check(
      `"${tool.name}" takes no self-granted approval`,
      names.every((name) => !['confirm', 'approved', 'force', 'yes'].includes(name)),
      names.join(',')
    )
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
