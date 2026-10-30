/**
 * Tests for the HTTP surface the sidebar panel talks to.
 *
 * Two things here are security-relevant rather than cosmetic. The panel serves
 * the user's own conversation, so `checkOrigin` is what stops another page from
 * reading it through the loopback port; and `readJsonBody` is what stops a
 * request from growing until the host runs out of memory. Both are tested
 * against the shapes an attacker would actually send, not against the happy
 * path with one field flipped.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_BODY_BYTES,
  ROUTE_PREFIX,
  checkOrigin,
  createPanelApi,
  describeMcp,
  describeSkills,
  json,
  readJsonBody,
  readCandidates,
  decideCandidate,
  readPanel,
  statTouchedFiles
} from '../lib/api.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

const tempDirs = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort: a leftover temp dir is not worth failing a test run over.
    }
  }
})

/** A response object that records what was written. */
function fakeRes() {
  const res = {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    ended: false,
    headOnly: undefined,
    destroyed: false,
    writableEnded: false,
    listeners: [],
    once(event, handler) {
      res.listeners.push([event, handler])
      return res
    },
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
      return res
    },
    end(body) {
      res.ended = true
      res.writableEnded = true
      res.body = body
      return res
    },
    destroy() {
      res.destroyed = true
      return res
    },
  }
  return res
}

/** A request carrying the given headers and body. */
function fakeReq({ url = '/', method = 'GET', headers = {}, body = undefined } = {}) {
  const merged = { host: '127.0.0.1:19387', ...headers }
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    url,
    method,
    headers: merged,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Parse the JSON a response carries. */
function bodyOf(res) {
  return res.body === undefined ? undefined : JSON.parse(res.body)
}

// ---------------------------------------------------------------------------
// checkOrigin
// ---------------------------------------------------------------------------

check('a loopback host is accepted', checkOrigin(fakeReq()) === undefined, String(checkOrigin(fakeReq())))
check('a localhost host is accepted', checkOrigin(fakeReq({ headers: { host: 'localhost:19387' } })) === undefined)
check('an ipv6 loopback host is accepted', checkOrigin(fakeReq({ headers: { host: '[::1]:19387' } })) === undefined, String(checkOrigin(fakeReq({ headers: { host: '[::1]:19387' } }))))

check('a missing host is refused', checkOrigin({ headers: {} }) === 'missing host header', String(checkOrigin({ headers: {} })))
check('a malformed host is refused', checkOrigin({ headers: { host: 'not a host' } }) === 'malformed host header', String(checkOrigin({ headers: { host: 'not a host' } })))
check(
  'a public hostname is refused',
  (() => {
    const reason = checkOrigin(fakeReq({ headers: { host: 'example.com:19387' } }))
    return typeof reason === 'string' && reason.includes('example.com')
  })(),
  String(checkOrigin(fakeReq({ headers: { host: 'example.com:19387' } }))),
)
check(
  'a cross-site fetch is refused',
  checkOrigin(fakeReq({ headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:19387' } })) === 'cross-site request',
)
check('a same-site fetch is accepted', checkOrigin(fakeReq({ headers: { 'sec-fetch-site': 'same-origin' } })) === undefined)
check(
  'an origin on another host is refused',
  checkOrigin(fakeReq({ headers: { origin: 'http://evil.example' } })) === 'origin does not match host',
)
check('an origin on the same host is accepted', checkOrigin(fakeReq({ headers: { origin: 'http://127.0.0.1:19387' } })) === undefined)
check('a malformed origin is refused', checkOrigin(fakeReq({ headers: { origin: 'not a url' } })) === 'malformed origin')

// ---------------------------------------------------------------------------
// json
// ---------------------------------------------------------------------------

{
  const res = fakeRes()
  json(res, 200, { ok: true })
  check('json sets the status', res.statusCode === 200, String(res.statusCode))
  check('json sets a json content type', res.headers['content-type'].startsWith('application/json'), res.headers['content-type'])
  check('json declares the body length', res.headers['content-length'] === Buffer.byteLength('{"ok":true}'), String(res.headers['content-length']))
  check('json asks not to be cached', res.headers['cache-control'] === 'no-store', res.headers['cache-control'])
  check('json ends the response', res.ended === true)
}

{
  const res = fakeRes()
  json(res, 204, { ok: true }, true)
  check('a head response carries no body', res.body === undefined, String(res.body))
  check('a head response still sets the length', res.headers['content-length'] === Buffer.byteLength('{"ok":true}'), String(res.headers['content-length']))
}

{
  const res = fakeRes()
  res.writableEnded = true
  json(res, 200, { ok: true })
  check('json does nothing on an ended response', res.statusCode === undefined, String(res.statusCode))
}

{
  const res = fakeRes()
  const cyclic = {}
  cyclic.self = cyclic
  json(res, 200, cyclic)
  check('an unserialisable payload drops the socket', res.destroyed === true)
  check('an unserialisable payload writes no headers', res.statusCode === undefined, String(res.statusCode))
}

{
  const res = fakeRes()
  json(res, 200, { ok: true })
  check('json subscribes to its own error event', res.listeners.length === 1 && res.listeners[0][0] === 'error', JSON.stringify(res.listeners.map((row) => row[0])))
}

// ---------------------------------------------------------------------------
// readJsonBody
// ---------------------------------------------------------------------------

{
  const result = await readJsonBody(fakeReq({ body: '{"a":1}' }))
  check('a json body is parsed', result.ok === true && result.value.a === 1, JSON.stringify(result))
}

{
  const result = await readJsonBody(fakeReq({ body: '' }))
  check('an empty body is an empty object', result.ok === true && JSON.stringify(result.value) === '{}', JSON.stringify(result))
}

{
  const result = await readJsonBody(fakeReq({ body: 'not json' }))
  check('a malformed body is a 400', result.ok === false && result.status === 400, JSON.stringify(result))
  check('a malformed body names its code', result.code === 'error.body.malformed', String(result.code))
}

{
  const result = await readJsonBody(fakeReq({ headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }))
  check('a declared oversize body is a 413', result.ok === false && result.status === 413, JSON.stringify(result))
}

{
  // No content-length: the cap has to be enforced while reading, or a chunked
  // request walks past it.
  const huge = 'x'.repeat(MAX_BODY_BYTES + 10)
  const result = await readJsonBody(fakeReq({ body: `{"a":"${huge}"}` }))
  check('a streamed oversize body is a 413', result.ok === false && result.status === 413, JSON.stringify(result))
  check('a streamed oversize body names its code', result.code === 'error.body.too-large', String(result.code))
}

{
  const req = {
    headers: {},
    async *[Symbol.asyncIterator]() {
      throw new Error('socket hang up')
    },
  }
  const result = await readJsonBody(req)
  check('an unreadable body is a 400', result.ok === false && result.status === 400, JSON.stringify(result))
  check('an unreadable body names its code', result.code === 'error.body.unreadable', String(result.code))
}

// ---------------------------------------------------------------------------
// describeMcp
// ---------------------------------------------------------------------------

{
  const described = describeMcp(new Set(['mcp__github__search_code', 'mcp__github__get_me', 'mcp__files__read']))
  check('two servers are described', described.length === 2, JSON.stringify(described))
  check('servers without recency fall back to name order', described[0].server === 'files' && described[1].server === 'github', JSON.stringify(described))
  check('tools are counted per server', described[1].tools === 2, JSON.stringify(described))
  check('a server that answered tools is marked used', described.every((row) => row.used === true), JSON.stringify(described))
}

{
  const recency = new Map([['mcp:zeta', 9], ['mcp:alpha', 3]])
  const described = describeMcp(new Set(['mcp__alpha__read', 'mcp__zeta__read']), recency)
  check('the most recently used server beats alphabetical order', described[0].server === 'zeta' && described[1].server === 'alpha', JSON.stringify(described.map((row) => row.server)))
  check('each server carries its recency', described[0].lastUsed === 9 && described[1].lastUsed === 3, JSON.stringify(described.map((row) => row.lastUsed)))
}

{
  check('no mcp tools means no servers', describeMcp(new Set()).length === 0)
  check('a non-mcp tool is ignored', describeMcp(new Set(['bash', 'read'])).length === 0, JSON.stringify(describeMcp(new Set(['bash', 'read']))))
  check('a bare mcp prefix is ignored', describeMcp(new Set(['mcp__'])).length === 0, JSON.stringify(describeMcp(new Set(['mcp__']))))
  check('a name with no server is ignored', describeMcp(new Set(['mcp____tool'])).length === 0, JSON.stringify(describeMcp(new Set(['mcp____tool']))))
}

// ---------------------------------------------------------------------------
// describeSkills
// ---------------------------------------------------------------------------

{
  const described = await describeSkills({ skills: undefined, isOwned: () => false })
  check('a host without a registry says so', described.available === false, JSON.stringify(described))
  check('a host without a registry lists no skills', described.skills.length === 0)
}

{
  const described = await describeSkills({
    skills: {
      async snapshot() {
        throw new Error('registry is down')
      },
    },
    isOwned: () => false,
  })
  check('a failing registry is reported, not thrown', described.available === false, JSON.stringify(described))
  check('a failing registry keeps the reason', String(described.reason).includes('registry is down'), String(described.reason))
}

{
  // The module answers "what has this session used", so a skill the registry
  // advertises but the session never loaded must not appear. `gamma` below is
  // the control: present in the snapshot, absent from `used`, absent in output.
  const described = await describeSkills({
    skills: {
      async snapshot() {
        return {
          complete: true,
          skills: [
            { name: 'alpha', description: 'first' },
            { name: 'beta', description: 'second', invocation: { modelInvocable: false, userInvocable: true } },
            { name: 'gamma', description: 'never loaded' },
            { description: 'nameless' },
          ],
        }
      },
    },
    isOwned: (name) => name === 'beta',
    used: new Map([
      ['alpha', 'tool'],
      ['beta', 'gesture'],
    ]),
  })
  check('the registry is reported available', described.available === true, JSON.stringify(described))
  check('only the skills this session loaded are described', described.skills.length === 2, JSON.stringify(described))
  check('the most recently loaded skill comes first', described.skills[0].name === 'beta', JSON.stringify(described.skills))
  check('a loaded skill the registry does not list is dropped', described.skills.every((row) => row.name !== 'gamma'), JSON.stringify(described.skills))
  check('a nameless registry row is never described', described.skills.every((row) => row.name !== ''), JSON.stringify(described.skills))
  check('ownership is resolved per row', described.skills[0].owned === true && described.skills[1].owned === false, JSON.stringify(described.skills))
  check('invocation is read as the policy object the host actually sends', described.skills[0].modelInvocable === false, JSON.stringify(described.skills[0]))
  check('a missing invocation policy defaults to model-invocable', described.skills[1].modelInvocable === true, JSON.stringify(described.skills[1]))
  check('completeness is carried through', described.complete === true, String(described.complete))
}

{
  const described = await describeSkills({
    skills: { async snapshot() { return { complete: true, skills: [{ name: 'alpha' }, { name: 'beta' }] } } },
    isOwned: () => false,
    used: new Map([['alpha', 'tool'], ['beta', 'tool']]),
    recency: new Map([['skill:alpha', 4], ['skill:beta', 8]]),
  })
  check('each skill carries its recency for the merged panel list', described.skills.find((row) => row.name === 'beta')?.lastUsed === 8 && described.skills.find((row) => row.name === 'alpha')?.lastUsed === 4, JSON.stringify(described.skills))
}

{
  // No `used` at all: the host may call this before the first skill is loaded.
  const described = await describeSkills({
    skills: { async snapshot() { return { complete: true, skills: [{ name: 'alpha', description: 'first' }] } } },
    isOwned: () => false,
  })
  check('without a used set nothing is described', described.skills.length === 0, JSON.stringify(described.skills))
  check('but the registry is still reported available', described.available === true, JSON.stringify(described))
}

{
  const described = await describeSkills({
    skills: { async snapshot() { return { complete: false, skills: [] } } },
    isOwned: () => false,
  })
  check('an incomplete snapshot says it is incomplete', described.complete === false, String(described.complete))
}

{
  const described = await describeSkills({
    skills: { async snapshot() { return {} } },
    isOwned: () => false,
  })
  check('a snapshot without skills lists none', described.skills.length === 0, JSON.stringify(described))
}

{
  // A gesture only loads what the host considers user-invocable. The host runs
  // `if (skill === void 0 || !isUserInvocable(skill)) continue`, so a gesture at
  // a model-only skill injects nothing and must not appear in the module.
  const rows = [
    { name: 'both', invocation: { modelInvocable: true, userInvocable: true } },
    { name: 'model-only', invocation: { modelInvocable: true, userInvocable: false } },
    { name: 'user-only', invocation: { modelInvocable: false, userInvocable: true } },
  ]
  const described = await describeSkills({
    skills: { async snapshot() { return { complete: true, skills: rows } } },
    isOwned: () => false,
    used: new Map([
      ['both', 'gesture'],
      ['model-only', 'gesture'],
      ['user-only', 'gesture'],
    ]),
  })
  check(
    'a gesture at a model-only skill does not count as a load',
    !described.skills.some((row) => row.name === 'model-only'),
    JSON.stringify(described.skills),
  )
  check(
    'a gesture at a user-invocable skill does count',
    described.skills.some((row) => row.name === 'both') && described.skills.some((row) => row.name === 'user-only'),
    JSON.stringify(described.skills),
  )
}

{
  // The tool path is filtered by the host's model-invocable check instead, so a
  // skill the model loaded through `skill` stays listed even when a person could
  // not have typed it.
  const described = await describeSkills({
    skills: {
      async snapshot() {
        return { complete: true, skills: [{ name: 'model-only', invocation: { modelInvocable: true, userInvocable: false } }] }
      },
    },
    isOwned: () => false,
    used: new Map([['model-only', 'tool']]),
  })
  check(
    'a tool load survives the user-invocable filter',
    described.skills.length === 1 && described.skills[0].name === 'model-only',
    JSON.stringify(described.skills),
  )
}

{
  // A name in both sets was loaded through the tool at least once, so the
  // stricter gesture rule must not remove it.
  const described = await describeSkills({
    skills: {
      async snapshot() {
        return { complete: true, skills: [{ name: 'both', invocation: { modelInvocable: true, userInvocable: false } }] }
      },
    },
    isOwned: () => false,
    used: new Map([['both', 'tool']]),
  })
  check(
    'a skill loaded by tool and typed as well is kept',
    described.skills.length === 1,
    JSON.stringify(described.skills),
  )
}

{
  // Names arrive from two sets; the union must not list the same skill twice.
  const described = await describeSkills({
    skills: {
      async snapshot() {
        return { complete: true, skills: [{ name: 'dup', invocation: { modelInvocable: true, userInvocable: true } }] }
      },
    },
    isOwned: () => false,
    used: new Map([['dup', 'tool']]),
  })
  check('a skill in both sets is listed once', described.skills.length === 1, JSON.stringify(described.skills))
}

// ---------------------------------------------------------------------------
// statTouchedFiles
// ---------------------------------------------------------------------------

{
  const dir = tempDir('skill-evolve-stat-')
  const present = join(dir, 'present.js')
  writeFileSync(present, 'x'.repeat(42))

  const files = await statTouchedFiles({ paths: [present, join(dir, 'absent.js')] })
  check('an existing file is listed', files.length === 1, JSON.stringify(files))
  check('the size is reported', files[0].bytes === 42, String(files[0].bytes))
  check('the modification time is reported', typeof files[0].mtimeMs === 'number', String(files[0].mtimeMs))
}

{
  const dir = tempDir('skill-evolve-stat-cwd-')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'rel.js'), 'y')
  const files = await statTouchedFiles({ paths: ['src/rel.js'], cwd: dir })
  check('a relative path resolves against the cwd', files.length === 1, JSON.stringify(files))
}

{
  const dir = tempDir('skill-evolve-stat-dir-')
  mkdirSync(join(dir, 'folder'))
  const files = await statTouchedFiles({ paths: [join(dir, 'folder')] })
  check('a directory is not a touched file', files.length === 0, JSON.stringify(files))
}

{
  const dir = tempDir('skill-evolve-stat-dup-')
  const file = join(dir, 'once.js')
  writeFileSync(file, 'z')
  const files = await statTouchedFiles({ paths: [file, file, file] })
  check('a path listed three times appears once', files.length === 1, JSON.stringify(files))
}

{
  const files = await statTouchedFiles({ paths: [undefined, null, '', 42] })
  check('junk paths are skipped', files.length === 0, JSON.stringify(files))
}

// ---------------------------------------------------------------------------
// readPanel
// ---------------------------------------------------------------------------

/** A deps object with quiet defaults. */
function deps(overrides = {}) {
  return {
    config: () => ({}),
    transcripts: { view: () => undefined },
    summariser: { summarise: async () => ({ enabled: true, reason: 'stub' }), reset: () => {} },
    execFor: () => ({}),
    skills: () => undefined,
    isOwned: () => false,
    cwdFor: () => process.cwd(),
    requestProposal: () => {},
    mcpTools: () => new Set(),
    modelCatalog: () => [],
    pendingCandidates: async () => 0,
    log: () => {},
    ...overrides,
  }
}

{
  const payload = await readPanel(deps(), 'agent-1')
  check('a session with no turns reports turn zero', payload.turn === 0, String(payload.turn))
  check('a session with no turns lists no files', payload.files.length === 0, JSON.stringify(payload.files))
  check('a session with no turns lists no commands', payload.commands.length === 0, JSON.stringify(payload.commands))
  check('a session with no turns still names the agent', payload.agent === 'agent-1', String(payload.agent))
}

{
  const summarised = []
  const payload = await readPanel(
    deps({
      config: () => ({ panelSummary: true }),
      transcripts: {
        view: () => ({
          turns: 4,
          previous: { turn: 3, calls: 9, failed: 1, paths: [], commands: ['npm test'], tools: [{ name: 'bash', count: 9 }], said: 'done' },
        }),
      },
      summariser: {
        summarise: async ({ agentId, snapshot }) => {
          summarised.push({ agentId, turn: snapshot.turn })
          return { enabled: true, text: 'It ran the tests.' }
        },
        reset: () => {},
      },
    }),
    'agent-1',
  )
  check('the summary is produced for the previous turn', summarised.length === 1 && summarised[0].turn === 3, JSON.stringify(summarised))
  check('the summary is carried into the payload', payload.summary.text === 'It ran the tests.', JSON.stringify(payload.summary))
  check('commands come from the previous turn', payload.commands[0] === 'npm test', JSON.stringify(payload.commands))
  check('the call count comes from the previous turn', payload.calls === 9, String(payload.calls))
  check('the failure count comes from the previous turn', payload.failed === 1, String(payload.failed))
}

{
  const summarised = []
  const payload = await readPanel(
    deps({
      config: () => ({ panelSummary: false }),
      transcripts: { view: () => ({ turns: 2, previous: { turn: 1, calls: 1, failed: 0, paths: [], commands: [], tools: [], said: '' } }) },
      summariser: {
        summarise: async () => {
          summarised.push(1)
          return { enabled: true, text: 'should not appear' }
        },
        reset: () => {},
      },
    }),
    'agent-1',
  )
  check('a disabled summary costs no model call', summarised.length === 0, String(summarised.length))
  check('a disabled summary says why', payload.summary.enabled === false, JSON.stringify(payload.summary))
}

{
  const payload = await readPanel(
    deps({
      config: () => ({ panelSummary: true }),
      transcripts: { view: () => ({ turns: 1 }) },
      summariser: {
        summarise: async () => {
          throw new Error('should never be called')
        },
        reset: () => {},
      },
    }),
    'agent-1',
  )
  check('a session with no finished turn asks for no summary', payload.summary.enabled === true, JSON.stringify(payload.summary))
  check('an unfinished first turn says there is nothing yet', String(payload.summary.reason).includes('no completed turn'), String(payload.summary.reason))
}

{
  const payload = await readPanel(deps({ pendingCandidates: async () => 3 }), 'agent-1')
  check('pending candidates are reported', payload.pendingCandidates === 3, String(payload.pendingCandidates))
}

{
  const payload = await readPanel(deps(), '')
  check('an unnamed session is handled', payload.turn === 0 && payload.agent === '', JSON.stringify(payload.agent))
}

// ---------------------------------------------------------------------------
// Handler routing
// ---------------------------------------------------------------------------

/** Run one request through the handler and return the response. */
async function route(overrides, req) {
  const handler = createPanelApi(deps(overrides))
  const res = fakeRes()
  await handler(req, res)
  return res
}

{
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/panel?agent=a` }))
  check('the panel route answers 200', res.statusCode === 200, String(res.statusCode))
  check('the panel route uses the ok envelope', bodyOf(res).ok === true, String(res.body))
  check('the panel route names the requested agent', bodyOf(res).data.agent === 'a', String(res.body))
}

{
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/panel?agent=a`, method: 'HEAD' }))
  check('a head request answers 200', res.statusCode === 200, String(res.statusCode))
  check('a head request carries no body', res.body === undefined, String(res.body))
}

{
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/config` }))
  check('the config route answers 200', res.statusCode === 200, String(res.statusCode))
  check('the config route reports the summary switch', typeof bodyOf(res).data.panelSummary === 'boolean', String(res.body))
  // The panel reads these to decide where it draws and whether it starts
  // collapsed. When they were missing the client's guards never fired, so both
  // settings were inert — and nothing failed, because the client test fakes this
  // route rather than calling it.
  check(
    'the config route reports which side the cards go on',
    bodyOf(res).data.panelSide === 'left' || bodyOf(res).data.panelSide === 'right',
    String(res.body),
  )
  check(
    'the config route reports whether the cards start collapsed',
    typeof bodyOf(res).data.panelCollapsed === 'boolean',
    String(res.body),
  )
}

{
  // A configured 'right' must come back as 'right'. A payload that hard-coded
  // 'left' would satisfy the shape assertions above and still ignore the setting.
  const res = await route({ config: { panelSide: 'right', panelCollapsed: true } }, fakeReq({ url: `${ROUTE_PREFIX}/config` }))
  check('a right-side setting is reported as right', bodyOf(res).data.panelSide === 'right', String(res.body))
  check('a collapsed setting is reported as collapsed', bodyOf(res).data.panelCollapsed === true, String(res.body))
}

{
  // And a POST must carry the change back.
  // The write path needs an override sink, and the sink has to be the thing
  // config() reads: writeConfig replies with the config it re-reads, which is
  // what makes the switches stick instead of springing back. A sink that only
  // recorded the patch left readConfig returning the old object, so the reply
  // said 'left' right after accepting 'right'.
  const applied = {}
  const res = await route(
    { config: () => ({ ...applied }), applyOverride: (patch) => Object.assign(applied, patch) },
    fakeReq({ url: `${ROUTE_PREFIX}/config`, method: 'POST', body: JSON.stringify({ panelSide: 'right' }) }),
  )
  check('posting the side applies it', bodyOf(res).data.panelSide === 'right', String(res.body))
  check('posting the side reports success', bodyOf(res).ok === true, String(res.body))
  check('posting the side reaches the override sink', applied.panelSide === 'right', JSON.stringify(applied))
}

{
  const res = await route({ modelCatalog: () => [{ provider: 'p', models: [{ id: 'm', name: 'M' }] }] }, fakeReq({ url: `${ROUTE_PREFIX}/models` }))
  check('the models route answers 200', res.statusCode === 200, String(res.statusCode))
  check('the models route returns the catalog', bodyOf(res).data.providers[0].provider === 'p', String(res.body))
}

{
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/unknown` }))
  check('an unknown route is a 404', res.statusCode === 404, String(res.statusCode))
  check('an unknown route names its code', bodyOf(res).code === 'error.route.unknown', String(res.body))
}

{
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/panel`, method: 'DELETE' }))
  check('an unsupported method is a 405', res.statusCode === 405, String(res.statusCode))
}

{
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/panel`, headers: { 'sec-fetch-site': 'cross-site' } }))
  check('a cross-site request is a 403', res.statusCode === 403, String(res.statusCode))
  check('a cross-site request names its code', bodyOf(res).code === 'error.origin.forbidden', String(res.body))
}

{
  const hints = []
  const res = await route(
    { requestProposal: (id, skill) => hints.push({ id, skill }) },
    // Exactly what lib/client.js sends: the agent travels in the body here,
    // because the button knows its session id but the fetch URL is fixed.
    fakeReq({ url: `${ROUTE_PREFIX}/propose`, method: 'POST', body: JSON.stringify({ agent: 'agent-9', skill: 'alpha' }) }),
  )
  check('the propose route answers 200', res.statusCode === 200, String(res.statusCode))
  check('the propose route delivers a hint', hints.length === 1 && hints[0].skill === 'alpha', JSON.stringify(hints))
  check('the hint targets the session named in the body', hints[0].id === 'agent-9', JSON.stringify(hints))
}

{
  const res = await route(
    {},
    fakeReq({ url: `${ROUTE_PREFIX}/propose`, method: 'POST', body: 'not json' }),
  )
  check('a malformed propose body is a 400', res.statusCode === 400, String(res.statusCode))
}

{
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/propose` }))
  check('a get to propose is a 404', res.statusCode === 404, String(res.statusCode))
}

{
  const applied = []
  const res = await route(
    { applyOverride: (patch) => applied.push(patch) },
    fakeReq({ url: `${ROUTE_PREFIX}/config`, method: 'POST', body: JSON.stringify({ panelSummary: false }) }),
  )
  check('the config route applies an override', applied.length === 1 && applied[0].panelSummary === false, JSON.stringify(applied))
  check('the config route answers 200', res.statusCode === 200, String(res.statusCode))
}

{
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/config`, method: 'POST', body: JSON.stringify({ panelSummary: false }) }))
  check('a host that cannot override says so', bodyOf(res).data.ok === false, String(res.body))
}

{
  // The handler's own failure path must answer, not throw: an exception here
  // would leave the panel's fetch pending forever.
  const res = await route(
    {
      config: () => {
        throw new Error('config exploded')
      },
    },
    fakeReq({ url: `${ROUTE_PREFIX}/panel` }),
  )
  check('an internal failure answers with a code', bodyOf(res).code === 'error.internal', String(res.body))
  check('an internal failure does not throw out of the handler', res.ended === true)
}

{
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/panel////` }))
  check('trailing slashes are tolerated', res.statusCode === 200, String(res.statusCode))
}

// ---------------------------------------------------------------------------
// writeConfig through the route
// ---------------------------------------------------------------------------

{
  let reset = 0
  const applied = []
  const res = await route(
    {
      summariser: { summarise: async () => ({}), reset: () => { reset += 1 } },
      applyOverride: (patch) => applied.push(patch),
    },
    fakeReq({ url: `${ROUTE_PREFIX}/config`, method: 'POST', body: JSON.stringify({ summaryProvider: 'p', summaryModel: 'm' }) }),
  )
  check('changing the summary model clears the cache', reset === 1, String(reset))
  check('the applied patch carries the model', applied[0].summaryModel === 'm', JSON.stringify(applied))
  check('the applied patch carries the provider', applied[0].summaryProvider === 'p', JSON.stringify(applied))
  check('the response mentions the restart caveat', String(bodyOf(res).data.note).includes('restart'), String(res.body))
}

{
  const applied = []
  const res = await route(
    { applyOverride: (patch) => applied.push(patch) },
    fakeReq({ url: `${ROUTE_PREFIX}/config`, method: 'POST', body: JSON.stringify({ somethingElse: 1 }) }),
  )
  check('an empty patch applies nothing', applied.length === 0, JSON.stringify(applied))
  check('an empty patch says there is nothing to change', bodyOf(res).data.ok === false, String(res.body))
}


// ---------------------------------------------------------------------------
// The candidate routes the hover card talks to
//
// These functions are the only way the browser can approve or discard a skill,
// and they were reachable with zero tests: the client suite fakes this route with
// a stub, so nothing exercised the real shapes. What is worth pinning down is not
// the happy path but the edges — a missing dependency has to answer "unavailable"
// rather than throw, a stale row has to arrive marked, and a refusal has to travel
// as data so the card can print it instead of "unknown error".
// ---------------------------------------------------------------------------

{
  const rows = [
    {
      id: 'a',
      name: 'pdf-tools',
      description: `work with pdfs ${'d'.repeat(300)}`,
      kind: 'create',
      whenToUse: 'when a pdf appears',
      body: 'B'.repeat(5000),
      evidence: Array.from({ length: 9 }, (_, index) => ({ class: 'tool', quote: `quote ${index} ${'x'.repeat(400)}` })),
    },
    { id: 'b', name: 'stale-one', kind: 'create', description: '', body: 'B', stale: { reason: 'base-changed' } },
  ]
  const payload = await readCandidates(deps({ listCandidates: async () => rows }))
  check('the candidate route reports itself available', payload.available === true, JSON.stringify(payload.available))
  check('every candidate is listed', payload.candidates.length === 2, String(payload.candidates.length))
  const first = payload.candidates[0]
  check('a candidate keeps its id', first.id === 'a', String(first.id))
  check('the description is truncated for transport', first.description.length <= 161, String(first.description.length))
  check('a truncated description ends in an ellipsis', first.description.endsWith('…'), first.description.slice(-3))
  check('the body is truncated for transport', first.body.length <= 4001, String(first.body.length))
  check('evidence is capped at six quotes', first.evidence.length === 6, String(first.evidence.length))
  check('each quote is truncated', first.evidence.every((entry) => entry.quote.length <= 301), JSON.stringify(first.evidence.map((entry) => entry.quote.length)))
  check('a truncated string ends in an ellipsis', first.body.endsWith('…'), first.body.slice(-3))
  const stale = payload.candidates[1]
  check('a stale row arrives with its reason', stale.stale?.reason === 'base-changed', JSON.stringify(stale.stale))
  check('a live row carries no stale field', first.stale === undefined, JSON.stringify(first.stale))
  check('a candidate without a description still renders', stale.description === '', JSON.stringify(stale.description))
}

{
  const payload = await readCandidates(deps({ listCandidates: undefined }))
  check('an unwired queue says unavailable rather than throwing', payload.available === false, JSON.stringify(payload.available))
  check('and it explains why', String(payload.reason).includes('not wired up'), String(payload.reason))
  check('an unwired queue lists nothing', payload.candidates.length === 0, JSON.stringify(payload.candidates))
}

{
  const payload = await readCandidates(
    deps({
      listCandidates: async () => {
        throw new Error('the queue file is corrupt')
      },
    }),
  )
  check('a queue that fails to read says unavailable', payload.available === false, JSON.stringify(payload.available))
  check('and the reason travels to the card', String(payload.reason).includes('corrupt'), String(payload.reason))
}

{
  const refused = await decideCandidate(deps(), { name: '', action: 'approve' })
  check('a nameless decision is refused', refused.ok === false && refused.code === 'no-name', JSON.stringify(refused))

  const badAction = await decideCandidate(deps(), { name: 'alpha', action: 'delete' })
  check('an unknown action is refused', badAction.ok === false && badAction.code === 'no-action', JSON.stringify(badAction))

  const unwired = await decideCandidate(deps(), { name: 'alpha', action: 'approve' })
  check('approving without a handler says unavailable', unwired.ok === false && unwired.code === 'unavailable', JSON.stringify(unwired))

  const unwiredDiscard = await decideCandidate(deps(), { name: 'alpha', action: 'discard' })
  check('discarding without a handler says unavailable', unwiredDiscard.ok === false && unwiredDiscard.code === 'unavailable', JSON.stringify(unwiredDiscard))
}

{
  const seen = []
  const approved = await decideCandidate(
    deps({
      approveCandidate: async (name, agentId) => {
        seen.push([name, agentId])
        return { ok: true, staged: true }
      },
    }),
    { name: ' alpha ', action: 'approve' },
    'agent-7',
  )
  check('an approve reaches the handler', approved.ok === true, JSON.stringify(approved))
  check('the name is trimmed before use', seen[0]?.[0] === 'alpha', JSON.stringify(seen))
  check('the deciding session travels with the request', seen[0]?.[1] === 'agent-7', JSON.stringify(seen))
  check('the staged flag survives the hop', approved.staged === true, JSON.stringify(approved))
}

{
  const refused = await decideCandidate(
    deps({ approveCandidate: async () => ({ ok: false, code: 'refused', error: 'the evidence gate said no' }) }),
    { name: 'alpha', action: 'approve' },
  )
  check('a refusal from the gate stays a refusal', refused.ok === false && refused.code === 'refused', JSON.stringify(refused))
  check('the gate message survives so the card can print it', String(refused.error).includes('evidence gate'), JSON.stringify(refused))
}

{
  const thrown = await decideCandidate(
    deps({
      approveCandidate: async () => {
        throw new Error('the disk is full')
      },
    }),
    { name: 'alpha', action: 'approve' },
  )
  check('a handler that throws still answers with data', thrown.ok === false, JSON.stringify(thrown))
  check('the thrown message is preserved', String(thrown.error).includes('disk is full'), JSON.stringify(thrown))
}

{
  const res = await route(
    { approveCandidate: async () => ({ ok: true }) },
    fakeReq({
      url: `${ROUTE_PREFIX}/candidates?agent=agent-9`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alpha', action: 'approve' }),
    }),
  )
  check('the decide route answers 200', res.statusCode === 200, String(res.statusCode))
  check('the decide route uses the ok envelope', bodyOf(res).ok === true, String(res.body))
  check('the decide route reports the outcome as data', bodyOf(res).data?.ok === true, String(res.body))
}

{
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/candidates?agent=a`, method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))
  check('the decide route refuses a non-json body', res.statusCode === 415, String(res.statusCode))
  check('and it names the type it got', String(bodyOf(res).error).includes('text/plain'), String(res.body))
}

{
  // A structured-suffix type is still JSON; a form post is not. Both directions
  // matter: refusing too much would break a client the host itself ships.
  const suffix = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/candidates`, method: 'POST', headers: { 'content-type': 'application/vnd.api+json' }, body: '{"name":"a","action":"discard"}' }))
  check('a +json content type is accepted', suffix.statusCode === 200, String(suffix.statusCode))

  const charset = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/candidates`, method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"name":"a","action":"discard"}' }))
  check('a charset parameter does not hide the type', charset.statusCode === 200, String(charset.statusCode))

  const form = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/candidates`, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=a' }))
  check('a form post is refused', form.statusCode === 415, String(form.statusCode))

  const bare = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/candidates`, method: 'POST', body: '{"name":"a","action":"discard"}' }))
  check('an untyped body is still parsed, so curl and the tests keep working', bare.statusCode === 200, String(bare.statusCode))
}
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
