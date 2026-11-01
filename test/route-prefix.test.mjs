/**
 * The route prefix has to agree between the two halves of the panel.
 *
 * The host half builds its routes from `ROUTE_PREFIX` in `lib/api.js`; the
 * browser half spells the same prefix into a template string in `lib/client.js`.
 * They cannot share a constant — `client.js` is a hand-written bundle with no
 * `import` and no build step, so the literal has to be written out — and the
 * failure mode of a mismatch is the quietest one in the plugin: the client
 * mounts, renders, and every request 404s. The rail then looks exactly like a
 * session with nothing to show.
 *
 * This suite exists only to make that mismatch a red test. It is deliberately
 * a text scan rather than a behavioural test: a behavioural one would need a
 * browser and a host, and the property being protected is a property of the
 * source, not of a running system.
 *
 * The prefix also has to be the *new* name. It was `/api/skill-evolve` while the
 * panel lived inside the detector; after the split the panel describes the
 * session, so it owns `ui-evolve`'s namespace and must not answer on the
 * detector's.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const uiLib = join(repo, 'packages', 'ui-evolve', 'lib')

let passed = 0
let failed = 0

/**
 * Run one assertion.
 *
 * @param {string} label - what is being asserted.
 * @param {boolean} ok - the result.
 * @param {string} [detail] - shown on failure.
 * @returns {void}
 */
function ok(label, ok, detail) {
  if (ok) {
    passed += 1
    return
  }
  failed += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const apiSource = readFileSync(join(uiLib, 'api.js'), 'utf8')
const clientSource = readFileSync(join(uiLib, 'client.js'), 'utf8')

// --- the host half -----------------------------------------------------------

const apiMatch = /const ROUTE_PREFIX = '([^']+)'/.exec(apiSource)
ok('api.js declares a route prefix', apiMatch !== null, 'no `const ROUTE_PREFIX = ...` line found')
const apiPrefix = apiMatch?.[1] ?? ''

ok('the api prefix names the ui-evolve namespace', apiPrefix === '/api/ui-evolve', `got ${JSON.stringify(apiPrefix)}`)

// The old name must be gone from both files. A leftover copy would not fail
// anything else — the handler simply never matches that path — so nothing except
// this assertion would notice.
// Only a *quoted* occurrence counts. `api.js` keeps one prose mention of the old
// name to explain the rename, and a test that forbade the string outright would
// punish the explanation while missing the thing it warns about.
ok(
  'api.js no longer answers on the detector namespace',
  apiSource.includes("'/api/skill-evolve'") === false && apiSource.includes('"/api/skill-evolve"') === false,
  'api.js still uses /api/skill-evolve as a route'
)
ok(
  'client.js no longer asks the detector namespace',
  clientSource.includes('/api/skill-evolve') === false,
  'client.js still mentions /api/skill-evolve'
)

// --- the browser half --------------------------------------------------------

// Every fetch in the bundle goes through one template. Assert on the shape
// rather than on a count: a second, differently spelled call site is exactly the
// mistake this guards against, and it would not be a second `/api/ui-evolve`
// literal.
const clientCalls = [...clientSource.matchAll(/\/api\/[a-z-]+/g)].map((match) => match[0])
ok('the bundle names at least one api path', clientCalls.length > 0, 'client.js has no /api/... string')

const clientPrefixes = [...new Set(clientCalls)]
ok(
  'the bundle names exactly one api prefix',
  clientPrefixes.length === 1,
  `found ${clientPrefixes.length}: ${clientPrefixes.join(', ')}`
)
ok(
  'the bundle prefix matches api.js',
  clientPrefixes.length === 1 && clientPrefixes[0] === apiPrefix,
  `client says ${clientPrefixes.join(', ')}, api says ${apiPrefix}`
)

// The bundle resolves the path against `document.baseURI` so a host mounted under
// a sub-path still routes correctly. Relative `/api/...` would escape that
// prefix, so the resolution itself is worth pinning: it is the difference
// between "works on the dev server" and "works where people actually run it".
ok(
  'the bundle resolves the path against the document base',
  /new URL\(\s*['"`]api['"`]?/.test(clientSource) || clientSource.includes('document.baseURI'),
  'no baseURI-relative resolution found in client.js'
)

// --- the endpoints the client expects ---------------------------------------

// Each path the browser fetches must have a branch in the handler. A typo on
// either side is invisible without this: the client shows its empty state, which
// is a legitimate thing to show.
// Endpoints are read from the `call('...')` sites, not from every string that
// looks like a path: the bundle also names paths in prose comments, and a scan
// that counted those would pass while a real call site was spelled differently.
const endpoints = [...clientSource.matchAll(/\bcall\(\s*['`"](\/[a-z]+)/g)].map((match) => match[1])
ok('the bundle names at least two endpoints', new Set(endpoints).size >= 2, `found ${[...new Set(endpoints)].join(', ') || 'none'}`)

for (const endpoint of new Set(endpoints)) {
  ok(
    `api.js routes ${endpoint}`,
    apiSource.includes(`\${ROUTE_PREFIX}${endpoint}\``),
    `the handler has no branch for ${endpoint}`
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
