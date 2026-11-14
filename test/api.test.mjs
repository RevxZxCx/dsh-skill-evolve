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
import { dirname, join } from 'node:path'

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
  statTouchedFiles,
  isNoisePath
} from '../packages/ui-evolve/lib/api.js'

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
  // Where a row came from is recorded by the collector, and this layer's only job
  // is to pass it through. A bare string is what the legacy `previous.paths`
  // fallback holds and what documents written before the field existed contain;
  // both must arrive as `null`, because "nobody wrote it down" and "git found it"
  // are different sentences on a card, and inventing the second one is a claim
  // nobody made.
  const dir = tempDir('skill-evolve-stat-source-')
  const present = join(dir, 'present.js')
  writeFileSync(present, 'x')

  const legacy = await statTouchedFiles({ paths: [present] })
  check('a path with no recorded provenance says null', legacy[0]?.source === null, JSON.stringify(legacy[0]))

  const credited = await statTouchedFiles({ paths: [{ path: present, source: 'git' }] })
  check('a recorded provenance is passed through', credited[0]?.source === 'git', JSON.stringify(credited[0]))

  const walked = await statTouchedFiles({ paths: [{ path: present, source: 'scan' }] })
  check('and the walk is its own word', walked[0]?.source === 'scan', JSON.stringify(walked[0]))

  const nonsense = await statTouchedFiles({ paths: [{ path: present, source: 'guess' }] })
  check('a word this build does not know is not repeated', nonsense[0]?.source === null, JSON.stringify(nonsense[0]))
}

// ---------------------------------------------------------------------------

{
  const dir = tempDir('skill-evolve-stat-')
  const present = join(dir, 'present.js')
  writeFileSync(present, 'x'.repeat(42))

  const files = await statTouchedFiles({ paths: [present, join(dir, 'absent.js')] })
  // Two rows, not one: the card lists what the session did, and writing a file
  // and then deleting it does not undo the writing. A missing path used to be
  // dropped, which made "I deleted it" and "I never touched it" look the same.
  check('every candidate is listed', files.length === 2, JSON.stringify(files))
  check('an existing file is available', files[0]?.status === 'available', JSON.stringify(files[0]))
  check('the size is reported', files[0]?.bytes === 42, String(files[0]?.bytes))
  check('the modification time is reported', typeof files[0]?.mtimeMs === 'number', String(files[0]?.mtimeMs))
  check('a deleted file is missing, not absent', files[1]?.status === 'missing', JSON.stringify(files[1]))
  check('a missing file reports no size', files[1]?.bytes === null, String(files[1]?.bytes))
  check(
    'a missing file still has an address',
    typeof files[1]?.address === 'string' && typeof files[0]?.address === 'string' && files[1].address === files[0].address.replace('present.js', 'absent.js'),
    String(files[1]?.address),
  )
}

{
  // The one distinction the reader can act on: something they deleted versus
  // something they cannot read. Collapsing the two would tell a person with a
  // permissions problem to stop looking for a file that is still there.
  const dir = tempDir('skill-evolve-stat-invalid-')
  const blocked = join(dir, 'blocked.js')
  writeFileSync(blocked, 'code')
  const files = await statTouchedFiles({
    paths: [blocked],
    // Injected rather than achieved with chmod: Windows has no mode bits that
    // make a readable file unreadable, so the only way to exercise this branch
    // on the platform the plugin ships for is to make `stat` itself fail.
    readStat: async () => {
      const error = new Error('permission denied')
      error.code = 'EACCES'
      throw error
    },
  })
  check('an unreadable file is invalid', files.length === 1 && files[0].status === 'invalid', JSON.stringify(files))
  // Independent of the check above: it names the value the reader's next step
  // depends on. A deleted file can be recreated; an unreadable one cannot, and
  // the two lines of copy say different things.
  check('an unreadable file says unreadable, not deleted', files[0]?.status === 'invalid', JSON.stringify(files))
}

{
  // A parent that is a file, not a directory. `stat` reports ENOTDIR rather than
  // ENOENT, and treating only ENOENT as gone would call a plainly absent path
  // "unreadable", which sends the reader looking for a permission problem.
  const dir = tempDir('skill-evolve-stat-notdir-')
  const files = await statTouchedFiles({
    paths: [join(dir, 'file.txt', 'child.js')],
    readStat: async () => {
      const error = new Error('not a directory')
      error.code = 'ENOTDIR'
      throw error
    },
  })
  check('a path under a file is missing, not unreadable', files.length === 1 && files[0].status === 'missing', JSON.stringify(files))
}

{
  const dir = tempDir('skill-evolve-stat-gone-')
  const files = await statTouchedFiles({
    paths: [join(dir, 'nowhere.js')],
    readStat: async () => {
      const error = new Error('no such file')
      error.code = 'ENOENT'
      throw error
    },
  })
  check('a vanished file is missing', files.length === 1 && files[0].status === 'missing', JSON.stringify(files))
}

{
  const dir = tempDir('skill-evolve-stat-cwd-')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'rel.js'), 'y')
  const files = await statTouchedFiles({ paths: ['src/rel.js'], cwd: dir })
  check('a relative path resolves against the cwd', files.length === 1, JSON.stringify(files))
  check('and it is available', files[0].status === 'available', JSON.stringify(files[0]))
}

{
  const dir = tempDir('skill-evolve-stat-dir-')
  mkdirSync(join(dir, 'folder'))
  const files = await statTouchedFiles({ paths: [join(dir, 'folder')] })
  // A directory was claimed as an edited file. Nothing to open, and nothing was
  // deleted either — but `missing` is the status that says "the file you named
  // is not there", which is exactly true of a directory.
  check('a directory is reported as missing rather than listed as a file', files.length === 1 && files[0].status === 'missing', JSON.stringify(files))
  check('a directory has no size', files[0]?.bytes === null, String(files[0]?.bytes))
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

{
  // "This turn" has to mean the turn the card is describing, and the card
  // describes `previous`, whose path list is `turnPaths`. The stored turn number
  // is a counter from whichever process wrote it; after a restart the live count
  // begins again at 1, so a stored `turn: 1` from months ago collides with it.
  // Preferring the number put old files under "this turn".
  const dir = tempDir('skill-evolve-stat-turn-')
  const old = join(dir, 'old.js')
  const fresh = join(dir, 'fresh.js')
  writeFileSync(old, 'x')
  writeFileSync(fresh, 'x')

  const numbers = await statTouchedFiles({
    paths: [{ path: old, turn: 1 }, { path: fresh, turn: 1 }],
    turnPaths: new Set([fresh]),
    turnNow: 1,
  })
  check('the turn snapshot outvotes a colliding stored turn number', numbers[0].turn === false, JSON.stringify(numbers[0]))
  check('and the file the snapshot lists is this turn\u2019s', numbers[1].turn === true, JSON.stringify(numbers[1]))

  const noSnapshot = await statTouchedFiles({
    paths: [{ path: old, turn: 3 }, { path: fresh, turn: 4 }],
    turnNow: 4,
  })
  check('with no snapshot the stored number is used', noSnapshot[0].turn === false, JSON.stringify(noSnapshot[0]))
  check('and it still marks the matching turn', noSnapshot[1].turn === true, JSON.stringify(noSnapshot[1]))
}

// ---------------------------------------------------------------------------
// The address that previews a file in the host's right sidebar
// ---------------------------------------------------------------------------

// `dsh-resource://file/session/<id>/<relative path>`, with the encoding the host's
// own address builder applies: segments percent-encoded, a drive colon kept.
{
  const dir = tempDir('skill-evolve-address-')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.js'), 'x')
  const [file] = await statTouchedFiles({ paths: [join(dir, 'src', 'a.js')], cwd: dir, sessionId: 'session-a' })
  check(
    'a file carries the address that previews it',
    file?.address === 'dsh-resource://file/session/session-a/src/a.js',
    String(file?.address),
  )
}

{
  // A path outside the workspace cannot be made relative, so it is carried whole.
  // Dropping it would leave the row un-clickable with no explanation.
  const dir = tempDir('skill-evolve-address-out-')
  const other = tempDir('skill-evolve-address-other-')
  writeFileSync(join(other, 'outside.js'), 'y')
  const [file] = await statTouchedFiles({ paths: [join(other, 'outside.js')], cwd: dir, sessionId: 'session-a' })
  // Spelled out in full rather than checked by prefix and suffix. Both of those
  // survive a truncation that slices the workspace root off anyway: the result
  // still starts with the session prefix and still ends with the file name, and
  // the branch that keeps an outside path whole is exactly the branch such a
  // slice would break.
  const expected = `dsh-resource://file/session/session-a/${join(other, 'outside.js')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/')}`
  check(
    'a file outside the workspace keeps its own coordinates',
    file?.address === expected,
    `${String(file?.address)} vs ${expected}`,
  )
}

{
  const dir = tempDir('skill-evolve-address-space-')
  writeFileSync(join(dir, 'two words.js'), 'z')
  const [file] = await statTouchedFiles({ paths: [join(dir, 'two words.js')], cwd: dir, sessionId: 'a b' })
  check(
    'spaces are encoded so the address stays one token',
    file?.address === 'dsh-resource://file/session/a%20b/two%20words.js',
    String(file?.address),
  )
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
  // The output card is the session's work, not the last turn's. The remembered
  // list wins outright: a turn that edited nothing must not empty the card, and
  // a turn that edited one file must not hide the rest.
  const dir = tempDir('skill-evolve-files-seen-')
  const earlier = join(dir, 'earlier.js')
  const later = join(dir, 'later.js')
  writeFileSync(earlier, 'a')
  writeFileSync(later, 'bb')

  const payload = await readPanel(
    deps({
      transcripts: { view: () => ({ turns: 5, previous: { turn: 5, calls: 0, failed: 0, paths: [], commands: [], said: 'nothing', tools: [] } }) },
      filesSeen: () => [later, earlier],
    }),
    'agent-1',
  )
  check('the remembered files are listed', payload.files.length === 2, JSON.stringify(payload.files))
  check('and the recency order is the order asked for', payload.files[0]?.path === later && payload.files[1]?.path === earlier, JSON.stringify(payload.files.map((file) => file.path)))
  check('a turn that touched nothing leaves the card standing', payload.files.length !== 0, JSON.stringify(payload.files))
}

{
  // Without a remembered list the old source is still read, so a host that has
  // not wired session state keeps showing something rather than going blank.
  const dir = tempDir('skill-evolve-files-fallback-')
  const only = join(dir, 'only.js')
  writeFileSync(only, 'c')
  const payload = await readPanel(
    deps({
      transcripts: { view: () => ({ turns: 2, previous: { turn: 2, calls: 1, failed: 0, paths: [only], commands: [], said: 'wrote it', tools: [] } }) },
    }),
    'agent-1',
  )
  check('the previous turn is still readable as a fallback', payload.files.length === 1 && payload.files[0].path === only, JSON.stringify(payload.files))
}

{
  // An empty remembered list is the same as no list: a session that has written
  // nothing yet is exactly the case where the fallback is the useful answer.
  const dir = tempDir('skill-evolve-files-empty-')
  const fromTurn = join(dir, 'from-turn.js')
  writeFileSync(fromTurn, 'd')
  const payload = await readPanel(
    deps({
      transcripts: { view: () => ({ turns: 1, previous: { turn: 1, calls: 1, failed: 0, paths: [fromTurn], commands: [], said: 'wrote it', tools: [] } }) },
      filesSeen: () => [],
    }),
    'agent-1',
  )
  check('an empty remembered list falls back to the turn', payload.files.length === 1 && payload.files[0].path === fromTurn, JSON.stringify(payload.files))
}

{
  // The fallback source has to mean the same thing as the primary one. The turn's
  // `paths` are appended in call order — oldest first — while the session's
  // remembered list is read newest first. Passing the turn's list through
  // unchanged would make the card's order depend on which source answered, and
  // the whole point of the ordering is that the file just edited is on top.
  const dir = tempDir('skill-evolve-files-fallback-order-')
  const first = join(dir, 'first.js')
  const second = join(dir, 'second.js')
  const third = join(dir, 'third.js')
  for (const file of [first, second, third]) writeFileSync(file, 'e')
  const payload = await readPanel(
    deps({
      transcripts: {
        view: () => ({
          turns: 1,
          previous: { turn: 1, calls: 3, failed: 0, paths: [first, second, third], commands: [], said: 'wrote three', tools: [] },
        }),
      },
    }),
    'agent-1',
  )
  check(
    'the fallback is listed newest first, like the remembered list',
    JSON.stringify(payload.files.map((file) => file.path)) === JSON.stringify([third, second, first]),
    JSON.stringify(payload.files.map((file) => file.path)),
  )
}

{
  // Two flags decide how the card may present a file, and the Host answers both
  // because only the Host holds the two inputs: the turn's own `paths` (what
  // "this turn" means) and the absolute paths the session state remembers. A
  // client that worked either out for itself would be guessing at path shapes it
  // never sees.
  const dir = tempDir('skill-evolve-files-flags-')
  const written = join(dir, 'src', 'app.js')
  const bundled = join(dir, 'node_modules', 'lib', 'index.js')
  const lockfile = join(dir, 'package-lock.json')
  const named = join(dir, 'docs', 'dist.md')
  const built = join(dir, 'src', 'build', 'gen.js')
  const builder = join(dir, 'src', 'builder', 'gen.js')
  for (const file of [written, bundled, lockfile, named, built, builder]) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'e')
  }
  const payload = await readPanel(
    deps({
      transcripts: { view: () => ({ turns: 1, previous: { turn: 1, calls: 5, failed: 0, paths: [written, bundled], commands: [], said: 'wrote five', tools: [] } }) },
      filesSeen: () => [written, bundled, lockfile, named, built, builder],
      // The fixtures live under the OS temp dir, which is not the workspace, so
      // `isNoisePath` cannot strip a prefix and falls back to judging every
      // segment — and `Temp` is a generated directory name. Declaring the temp
      // dir as the workspace is what makes this block assert noise rules rather
      // than where the tests happen to run.
      cwdFor: () => dir,
    }),
    'agent-1',
  )
  const byPath = new Map(payload.files.map((file) => [file.path, file]))
  check('a file this turn wrote says so', byPath.get(written)?.turn === true, JSON.stringify(byPath.get(written)))
  check('and a file it did not write says so too', byPath.get(named)?.turn === false, JSON.stringify(byPath.get(named)))
  // A build dependency is not the reader's work, and neither is a lockfile. The
  // judgement is made on whole path segments and whole file names, so a project
  // that owns `src/build/` or `docs/dist.md` keeps its files visible.
  check("a dependency of the build is not the reader's work", byPath.get(bundled)?.noise === true, JSON.stringify(byPath.get(bundled)))
  check('a lockfile is not either', byPath.get(lockfile)?.noise === true, JSON.stringify(byPath.get(lockfile)))
  check('an output directory is one wherever it sits', byPath.get(built)?.noise === true, JSON.stringify(byPath.get(built)))
  // The card subtracts this from every absolute path to show the directory under
  // each name, so the panel has to send it; a client cannot guess it.
  check('the payload carries the workspace the paths are relative to', payload.cwd === dir, String(payload.cwd))
  check("a directory that merely shares a prefix is still the reader's", byPath.get(builder)?.noise === false, JSON.stringify(byPath.get(builder)))
  check('and so is a file that merely shares one', byPath.get(named)?.noise === false, JSON.stringify(byPath.get(named)))
}

{
  // A checkout can live under a directory that happens to be called `build`. CI
  // puts it at `/build/<repo>` and a developer may open `D:/build/mine` directly.
  // Judging the whole absolute path would call every file inside generated: the
  // card would draw no rows and announce "0 个文件" for a session that edited real
  // source, and the turn grouping would go with them. Only the segments below the
  // workspace may decide.
  const parent = tempDir('skill-evolve-noise-ancestor-')
  const dir = join(parent, 'build', 'project')
  const source = join(dir, 'src', 'app.js')
  const bundled = join(dir, 'node_modules', 'lib', 'index.js')
  for (const file of [source, bundled]) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'e')
  }
  const payload = await readPanel(
    deps({
      cwdFor: () => dir,
      filesSeen: () => [source, bundled],
    }),
    'agent-1',
  )
  const byPath = new Map(payload.files.map((file) => [file.path, file]))
  check('a workspace under a directory called build keeps its source', byPath.get(source)?.noise === false, JSON.stringify(byPath.get(source)))
  check('and still knows its own dependency directory', byPath.get(bundled)?.noise === true, JSON.stringify(byPath.get(bundled)))

  // The two halves of the comparison come from different places and neither
  // normalises its case: `cwd` is whatever the session header says, the file path
  // is whatever the tool argument said. On Windows and macOS they are routinely
  // the same directory written differently, and a case-sensitive prefix check
  // would fail to strip, fall back to judging every ancestor, and hide the list.
  const payloadCased = await readPanel(
    deps({
      // Uppercased on every platform: `cwd` only ever reaches string comparisons
      // here (the stat call uses the absolute `source` unchanged), so a Host that
      // reports one case and a tool argument that reports the other is ordinary
      // anywhere. Guarding this on `win32` made the assertion tautological
      // everywhere else, and the mutation it exists to kill would survive.
      cwdFor: () => dir.toUpperCase(),
      filesSeen: () => [source],
    }),
    'agent-1',
  )
  check('the workspace is recognised in either case', payloadCased.files[0]?.noise === false, JSON.stringify(payloadCased.files))

  // Folding is not length-preserving: `İ` lowercases to two code units. Comparing
  // folded while cutting the original by the folded prefix's length therefore
  // leaves a few characters of the workspace's own name at the front of the
  // remainder — and if that fragment happens to be a generated directory name, a
  // source file is hidden as though a build had written it. The five-`İ` prefix
  // and the workspace named `…build` are chosen so the fragment is exactly
  // `build`; one `İ` would leave a fragment the segment filter absorbs, and the
  // defect would not show.
  const dotted = '\u0130'.repeat(5)
  const plain = 'i\u0307'.repeat(5)
  const foldedParent = tempDir('skill-evolve-noise-fold-')
  const foldedDir = join(foldedParent, `${plain}build`)
  const foldedSource = join(foldedDir, 'src', 'app.js')
  mkdirSync(dirname(foldedSource), { recursive: true })
  writeFileSync(foldedSource, 'e')
  const payloadFolded = await readPanel(
    deps({
      cwdFor: () => join(foldedParent, `${dotted}build`),
      filesSeen: () => [foldedSource],
    }),
    'agent-1',
  )
  check('a folded prefix does not leave a fragment of its own name behind', payloadFolded.files[0]?.noise === false, JSON.stringify(payloadFolded.files))
}

{
  // Lowercasing is not length-preserving: `İ` (U+0130) becomes `i` plus a combining
  // dot, so the folded prefix is one code unit longer than the original. Cutting
  // the original by the folded length therefore lands past the separator and eats
  // the first character of the first segment — `node_modules/` reads as
  // `ode_modules/`, matches nothing, and a dependency is listed as the reader's own
  // work. Folding the remainder and cutting that instead costs nothing, because
  // every comparison below ignores case anyway.
  // The path carries the long form and the cwd the short one, so folding grows the
  // prefix by a code unit: the folded prefix measures six and the original path
  // only five before the separator. Cutting the original by six eats the `n`.
  check('a folded prefix does not eat the first segment', isNoisePath('/W/\u0130/node_modules/a.js', '/w/i\u0307') === true, String(isNoisePath('/W/\u0130/node_modules/a.js', '/w/i\u0307')))
  check('and the same path outside it is still the reader\'s', isNoisePath('/W/\u0130/src/a.js', '/w/i\u0307') === false, String(isNoisePath('/W/\u0130/src/a.js', '/w/i\u0307')))
}

{
  // Most of what a long session leaves behind is scratch: scripts written to
  // answer one question. Measured before this rule existed, across every stored
  // session, 276 tracked paths and zero classified as generated — the filter
  // looked broken and was, because no rule described the data. One 175-file
  // session was 130 rows of `_peek2.py`, `_r062_snapx.py`, `_dump.json`.
  check('a scratch script is not the reader\'s work', isNoisePath('/w/_peek2.py', '/w') === true, String(isNoisePath('/w/_peek2.py', '/w')))
  check('neither is one under a scratch folder', isNoisePath('/w/.research/x.md', '/w') === true, String(isNoisePath('/w/.research/x.md', '/w')))
  check('a tmp directory is scratch wherever it sits', isNoisePath('/w/src/tmp/a.js', '/w') === true, String(isNoisePath('/w/src/tmp/a.js', '/w')))
  check('a dotted scratch file is scratch too', isNoisePath('/w/.probe-slice.mjs', '/w') === true, String(isNoisePath('/w/.probe-slice.mjs', '/w')))

  // The underscore rule is only safe because of its exception. A dunder name
  // belongs to the project: `__tests__/` holds the tests, and `__init__.py` is
  // the one file every Python package has. The first draft required the segment
  // to *end* with `__`, which protected the directories and hid every package
  // marker — a hidden test suite and a hidden `__init__.py` are both worse than
  // no rule at all.
  check('a dunder directory keeps its files', isNoisePath('/w/tests/__tests__/a.test.js', '/w') === false, String(isNoisePath('/w/tests/__tests__/a.test.js', '/w')))
  check('and a dunder module is not scratch', isNoisePath('/w/mypkg/__init__.py', '/w') === false, String(isNoisePath('/w/mypkg/__init__.py', '/w')))
  check('nor is a dunder entry point', isNoisePath('/w/__main__.py', '/w') === false, String(isNoisePath('/w/__main__.py', '/w')))

  // A dot file is far more often part of the project than temporary, and the
  // cost is lopsided: hiding `.gitignore` hides something the reader may have
  // just asked for, while showing one stray dotted file costs a row.
  check('a config file is not scratch', isNoisePath('/w/.gitignore', '/w') === false, String(isNoisePath('/w/.gitignore', '/w')))
  check('a config prefix keeps its variants', isNoisePath('/w/.env.local', '/w') === false, String(isNoisePath('/w/.env.local', '/w')))
  check('a directory that merely shares a prefix is still the reader\'s', isNoisePath('/w/src/builder/gen.js', '/w') === false, String(isNoisePath('/w/src/builder/gen.js', '/w')))
}

{
  // The turn's `paths` are whatever the tool call carried, which in real sessions
  // is routinely relative to the workspace. Resolving them against the same cwd
  // the stat call uses is what makes the comparison mean anything: skip it and
  // every relative path misses the absolute one session state remembers, leaving
  // the flag false for the whole session.
  const dir = tempDir('skill-evolve-files-relative-')
  const file = join(dir, 'src', 'app.js')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'e')
  const payload = await readPanel(
    deps({
      cwdFor: () => dir,
      transcripts: { view: () => ({ turns: 1, previous: { turn: 1, calls: 1, failed: 0, paths: ['src/app.js'], commands: [], said: 'wrote one', tools: [] } }) },
    }),
    'agent-1',
  )
  check("a relative path still counts as this turn's work", payload.files[0]?.turn === true, JSON.stringify(payload.files))
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
// Reading the stored state
// ---------------------------------------------------------------------------

{
  // A cache that cannot be read is not a conversation that does not exist. The
  // route has to answer: a panel that goes blank because a file was busy reads
  // as "this session did nothing", which is a worse lie than an empty card.
  const logged = []
  let payload
  try {
    payload = await readPanel(
      deps({
        transcripts: { view: () => undefined },
        sessionState: {
          async load() {
            throw new Error('storage unavailable')
          },
        },
        log: (line) => logged.push(line),
      }),
      'agent-1',
    )
  } catch (error) {
    // The fault is the point. Letting it reach here as a rejection would end the
    // suite instead of failing the assertions that describe the contract.
    payload = { rejected: String(error?.message ?? error) }
  }
  check('a fault reading the stored state still answers', payload?.turn === 0, JSON.stringify(payload))
  check('and it says what went wrong', logged.some((line) => line.includes('could not read the stored state')) === true, JSON.stringify(logged))
}

{
  // The facts are per session. Both lookups take the id; a panel that asked for
  // "the" recency and "the" tool names would describe whatever the host happened
  // to do most recently in some other conversation.
  const asked = []
  const payload = await readPanel(
    deps({
      recentUse: (agentId) => {
        asked.push(`recentUse:${agentId}`)
        return new Map()
      },
      mcpTools: (agentId) => {
        asked.push(`mcpTools:${agentId}`)
        return new Set()
      },
    }),
    'agent-7',
  )
  check('the recency clock is read for this session', asked.includes('recentUse:agent-7') === true, JSON.stringify(asked))
  check('the MCP tools are looked up for this session', asked.includes('mcpTools:agent-7') === true, JSON.stringify(asked))
  check('and the answer is still a panel', payload.agent === 'agent-7', String(payload.agent))
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
  // The panel route is the only place that can tell "a session exists" from "a
  // session somebody is watching", so it is where the summariser learns that a
  // reader showed up. Without this, `warm` refuses every turn and the card goes
  // back to costing a model call while the person waits for it.
  const seen = []
  const asked = {
    config: () => ({ panelSummary: true }),
    transcripts: {
      view: () => ({
        turns: 2,
        previous: { turn: 1, calls: 1, failed: 0, paths: [], commands: [], tools: [], said: 'done' },
      }),
    },
    summariser: {
      markViewed: (agentId) => { seen.push(agentId) },
      summarise: async () => ({ enabled: true, text: 'It ran.' }),
      reset: () => {},
    },
  }
  await route(asked, fakeReq({ url: `${ROUTE_PREFIX}/panel?agent=a` }))
  check('a panel request tells the summariser this session has a reader', seen[0] === 'a', JSON.stringify(seen))

  // A request that names no session is not a reader of anything. Recording the
  // empty string would put a nameless entry in the warm set.
  seen.length = 0
  await route(asked, fakeReq({ url: `${ROUTE_PREFIX}/panel` }))
  check('a request naming no session marks nothing viewed', seen.length === 0, JSON.stringify(seen))

  // The language used to travel as `?lang=`. It no longer does: the summary is
  // written in the language of the conversation, which the model reads out of
  // the transcript. A stale client still sending one must not break the route,
  // and must not reach the summariser as an argument it no longer takes.
  const languages = []
  const stale = {
    ...asked,
    summariser: {
      ...asked.summariser,
      summarise: async (input) => {
        languages.push(input.language)
        return { enabled: true, text: 'It ran.' }
      },
    },
  }
  seen.length = 0
  await route(stale, fakeReq({ url: `${ROUTE_PREFIX}/panel?agent=a&lang=zh-CN` }))
  check('a query language is ignored rather than forwarded', languages[0] === undefined, JSON.stringify(languages))
  check('the session is still marked viewed with a stale language present', seen[0] === 'a', JSON.stringify(seen))
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

// ---- the live speed route ----
//
// Its own route rather than a field on `/panel`, because the two answer on
// different clocks: the panel changes when a turn ends, this one changes while a
// turn is still running. Sharing a poll would either make the panel ask four
// times a second for numbers that cannot change that often, or make the badge
// answer up to eight seconds late — which is the whole generation.
{
  const asked = []
  const res = await route(
    { speedOf: (id) => { asked.push(id); return { tokens: 100, ms: 1000, tps: 100, active: true } } },
    fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-7` }),
  )
  check('the speed route answers 200', res.statusCode === 200, String(res.statusCode))
  check('and hands back the reading', bodyOf(res).data.tps === 100, String(res.body))
  check('and it asks about the session in the query', asked[0] === 'agent-7', JSON.stringify(asked))
  check('and it says the reading is active', bodyOf(res).data.active === true, String(res.body))
}

{
  // An idle session is a 200 with an inactive reading, not an error: the client
  // needs to tell "nothing is being written" from "this host cannot say", and
  // those are the same status code only if the body is read.
  const res = await route(
    { speedOf: () => ({ tokens: 0, ms: 0, tps: 0, active: false }) },
    fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=idle` }),
  )
  check('an idle session is not an error', res.statusCode === 200, String(res.statusCode))
  check('and it reports itself inactive rather than absent', bodyOf(res).ok === true && bodyOf(res).data.active === false, String(res.body))
}

{
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/speed` }))
  check('a speed request without a session is a 400', res.statusCode === 400, String(res.statusCode))
  check('and it says which id is missing', bodyOf(res).code === 'error.agent.missing', String(res.body))
}

{
  // `?agent=` parses to the empty string, not to undefined. That one case is the
  // whole reason the route checks the length as well as the type.
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=` }))
  check('an empty session id is rejected too', res.statusCode === 400, String(res.statusCode))
}

{
  // A host half that predates this route: the panel must still load rather than
  // fail the whole page because a badge is missing.
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-1` }))
  check('a panel without a meter answers 200', res.statusCode === 200, String(res.statusCode))
  check('and names the missing capability rather than throwing', bodyOf(res).code === 'error.speed.absent', String(res.body))
  check('and it is not ok', bodyOf(res).ok === false, String(res.body))
}

{
  // HEAD answers without a body, and — like `/panel` — it still runs the reader:
  // the work is what produces the numbers, and a HEAD that skipped it would answer
  // 200 for a session the GET path rejects. The assertion below is deliberately
  // about what comes back rather than about work avoided, because no route here
  // avoids the work.
  const asked = []
  const res = await route(
    { speedOf: (id) => { asked.push(id); return { tokens: 1, ms: 1, tps: 1, active: true } } },
    fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-1`, method: 'HEAD' }),
  )
  check('a head request to the speed route answers 200', res.statusCode === 200, String(res.statusCode))
  check('and it carries no body', res.body === '' || res.body === undefined, String(res.body))
  check('and it reads the session it was asked about', asked.length === 1 && asked[0] === 'agent-1', JSON.stringify(asked))
}

// ---- the long poll on the speed route ----
//
// The badge used to discover a reply by asking on a timer, and the timer had to
// be slow enough not to be traffic — which made it slower than most replies. The
// wait inverts that: the request stays open and is answered the moment the meter
// moves. What has to be true of it is checked here, because a wait that never
// ends is a hung panel and a wait that ends too early is the old polling again.
//
// These cases go through `routeHeld` rather than `route`. The wait's own interval
// is `unref`'d so a plugin cannot pin a headless host open, which in a test means
// a pending wait is the only handle left and node resolves the whole run instead
// of the promise — the "unsettled top-level await" warning, and no tally line at
// all. Holding the loop for the duration also gives every case a deadline, so a
// wait that never ends fails an assertion instead of hanging CI.
async function routeHeld(deps, req, limitMs = 5000) {
  const keepAlive = setInterval(() => {}, 1000)
  let deadline = null
  try {
    return await Promise.race([
      route(deps, req),
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve({ statusCode: 0, body: '', timedOut: true }), limitMs)
      }),
    ])
  } finally {
    clearInterval(keepAlive)
    if (deadline !== null) clearTimeout(deadline)
  }
}

/**
 * The body of a response that may never have been written.
 *
 * A case that goes through `routeHeld` can come back with `timedOut` and no
 * body at all, and reading it has to fail an assertion rather than throw: a
 * mutation that makes the wait hang is a broken wait, and it should be counted
 * as one. Parsing an empty string takes the whole suite down with it instead,
 * which reports nothing about the line that actually broke.
 */
function heldBodyOf(res) {
  return res.body === undefined || res.body === '' ? {} : JSON.parse(res.body)
}

{
  // No `after`: a plain read, answered at once. This is the request the panel
  // makes when it opens, and delaying it would delay the first paint.
  const started = Date.now()
  const res = await routeHeld(
    { speedOf: () => ({ tokens: 0, ms: 0, tps: 0, active: false, last: null, revision: 3 }), speedRevision: () => 0 },
    fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-1` }),
  )
  check('a request with no revision is answered at once', res.timedOut !== true && Date.now() - started < 1000, String(Date.now() - started))
  check('and it still carries the reading', heldBodyOf(res).data?.revision === 3, String(res.body))
}

{
  // The caller is behind: it last saw revision 3 and the meter is already at 9.
  // There is something new to say, so the wait ends on the first look rather
  // than sitting out the whole deadline.
  //
  // The counter is constant on purpose. A stub that increments on every call
  // makes the first tick see a change whatever the request asked for, which
  // passes against a server that never reads `after` at all — the exact defect
  // this case exists to catch. The number has to be the thing compared.
  const started = Date.now()
  const res = await routeHeld(
    {
      speedOf: () => ({ tokens: 0, ms: 0, tps: 0, active: false, last: null, revision: 9 }),
      speedRevision: () => 9,
    },
    fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-1&after=3` }),
  )
  check('a revision that moved ends the wait early', res.timedOut !== true && Date.now() - started < 2000, String(Date.now() - started))
  check('and the answer is the new reading', heldBodyOf(res).data?.revision === 9, String(res.body))
}

{
  // The other half of the same comparison: the caller is up to date. Nothing has
  // happened since revision 9, so there is nothing to say and the wait has to sit
  // there. A server that answered anyway would be the old fast polling with an
  // open connection bolted onto it — and the panel would ask again immediately,
  // in a loop.
  const held = await routeHeld(
    {
      speedOf: () => ({ tokens: 0, ms: 0, tps: 0, active: false, last: null, revision: 9 }),
      speedRevision: () => 9,
    },
    fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-1&after=9` }),
    800,
  )
  check('a revision that has not moved keeps the request open', held.timedOut === true, String(held.timedOut))
  check('and nothing is written while it waits', held.body === '', String(held.body))
}

{
  // The client goes away — a panel closed, a conversation switched. The wait has
  // to end with it: an interval left ticking per abandoned request is a leak that
  // only shows up after an afternoon of use. The request here carries its own
  // `once`, because the shared fixture has no event plumbing and this is the one
  // case that needs it.
  const base = fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-1&after=1` })
  const listeners = new Map()
  const req = {
    ...base,
    once(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return req
    },
    fire(name) {
      for (const handler of listeners.get(name) ?? []) handler()
    },
  }
  let answered = false
  const pending = routeHeld(
    { speedOf: () => ({ tokens: 0, ms: 0, tps: 0, active: false, last: null, revision: 1 }), speedRevision: () => 1 },
    req,
  ).then((res) => { answered = true; return res })
  await new Promise((resolve) => setTimeout(resolve, 300))
  check('a wait with nothing to report is still waiting', answered === false, String(answered))
  req.fire('close')
  const res = await pending
  check('and closing the request ends it', answered === true, String(answered))
  check('with the reading it had', heldBodyOf(res).data?.revision === 1, String(res.body))
}

{
  // HEAD never waits. A health check or a `curl -I` holds no socket open for
  // twenty-five seconds, and there is no body to be fresher for. `routeHeld` is
  // what turns a broken version of this into a failed assertion: a HEAD that
  // waited would sit on the deadline, and awaiting it directly would take the
  // whole run down with it instead of saying which line broke.
  const started = Date.now()
  const res = await routeHeld(
    { speedOf: () => ({ tokens: 1, ms: 1, tps: 1, active: true, last: null, revision: 1 }), speedRevision: () => 1 },
    fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-1&after=1`, method: 'HEAD' }),
  )
  check('a head request does not wait', res.timedOut !== true && Date.now() - started < 1000, String(Date.now() - started))
  check('and it answers 200', res.statusCode === 200, String(res.statusCode))
}

{
  // A host half with no counter cannot support the wait. It must answer rather
  // than throw or hang: the badge has to keep working against an older server,
  // and the only thing it loses is the low latency.
  const started = Date.now()
  const res = await routeHeld(
    { speedOf: () => ({ tokens: 1, ms: 1, tps: 1, active: true, last: null, revision: 1 }) },
    fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-1&after=1` }),
  )
  check('a host with no revision answers the wait at once', res.timedOut !== true && Date.now() - started < 1000, String(Date.now() - started))
  check('and it still reports the reading', heldBodyOf(res).data?.tps === 1, String(res.body))
}

{
  // A garbage `after` is a plain read, not a 400: the value is an optimisation,
  // and a client that sends something unexpected should lose the optimisation
  // rather than the badge.
  const started = Date.now()
  const res = await routeHeld(
    { speedOf: () => ({ tokens: 1, ms: 1, tps: 1, active: true, last: null, revision: 1 }), speedRevision: () => 1 },
    fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-1&after=later` }),
  )
  check('a nonsense revision answers the wait at once', res.timedOut !== true && Date.now() - started < 1000, String(Date.now() - started))
  check('and it does not become an error', res.statusCode === 200, String(res.statusCode))
}

{
  // The deadline is the whole difference between "a long poll" and "a hung
  // request": a conversation that never produces another token would otherwise
  // hold the connection open forever, and a panel that went quiet would never
  // find out that the reply it is waiting for was abandoned an hour ago. Waiting
  // the real `SPEED_WAIT_MS` out is twenty-five seconds of test run, so the clock
  // is moved instead — `setInterval` is what the wait actually calls, and a stub
  // that runs the callback while reporting a time past the deadline is the same
  // situation the real timer reaches on its own.
  const realNow = Date.now
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  let ticks = 0
  let offset = 0
  try {
    Date.now = () => realNow() + offset
    globalThis.setInterval = (fn, ms) => {
      ticks += 1
      // Step past the deadline on the first tick. The wait computes `deadline`
      // from the same clock it later compares against, so a clock that merely
      // stands still can never reach it, and a stub that never ticks would make
      // this block hang rather than fail.
      offset += 60000
      // Deferred, not immediate: `speedWait` assigns the handle *after* calling
      // `setInterval`, so a tick that ran synchronously would reach `finish`
      // while `timer` is still in its temporal dead zone and throw instead of
      // testing the deadline.
      Promise.resolve().then(fn)
      return { stub: true, ms }
    }
    globalThis.clearInterval = () => {}
    const started = realNow()
    const res = await routeHeld(
      { speedOf: () => ({ tokens: 0, ms: 0, tps: 0, active: false, last: null, revision: 4 }), speedRevision: () => 4 },
      fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-1&after=4` }),
      2000,
    )
    const parsed = res.body === '' ? {} : JSON.parse(res.body)
    check('a wait with nothing to report ends at its deadline', res.timedOut !== true, String(res.timedOut))
    check('and the deadline is the only thing that ended it', ticks > 0 && realNow() - started < 2000, String(ticks))
    check('and it answers with the reading rather than nothing', parsed.data?.revision === 4, String(res.body))
  } finally {
    Date.now = realNow
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
}

{
  // The interval is cleared on the way out, on every path out. In a running host
  // the timer is not `unref`'d — that is for a headless process — so one left
  // armed per request ticks a hundred times a second for the life of the plugin,
  // and a closed panel produces one of these per open.
  //
  // The counter moves between the read that opens the wait (`started`) and the
  // first tick, which is exactly what a token arriving does. The stub runs the
  // tick straight away, so the answer comes back without waiting out a step.
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const scheduled = []
  const cleared = []
  let reads = 0
  try {
    globalThis.setInterval = (fn, ms) => {
      const handle = { fn, ms, stub: true }
      scheduled.push(handle)
      // Same reason as the deadline block: the handle exists before the callback
      // may run, so the tick has to wait a microtask.
      Promise.resolve().then(fn)
      return handle
    }
    globalThis.clearInterval = (handle) => { cleared.push(handle) }
    const res = await routeHeld(
      {
        speedOf: () => ({ tokens: 1, ms: 1, tps: 1, active: true, last: null, revision: 2 }),
        speedRevision: () => {
          reads += 1
          return reads === 1 ? 2 : 3
        },
      },
      fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-1&after=2` }),
      2000,
    )
    check('a wait that is answered schedules one timer', scheduled.filter((row) => row.ms === 100).length === 1, String(scheduled.length))
    const waited = scheduled.filter((row) => row.ms === 100)
    check('and it takes that timer away again', cleared.length >= 1 && cleared.includes(waited[0]), `${scheduled.length} vs ${cleared.length}`)
    check('and the answer still arrives', heldBodyOf(res).data?.revision === 2, String(res.body))
  } finally {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
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
{
  // The dependency is wired up but the package that owns the queue is not
  // installed. Before this was distinguished, the panel reported `available:
  // true` with zero rows, which reads as "you have no candidates" rather than
  // "you have not installed the package that has candidates".
  const payload = await readCandidates(deps({ listCandidates: async () => undefined }))
  check('an absent skill half is not an empty queue', payload.available === false, JSON.stringify(payload.available))
  check('and it names the missing package', String(payload.reason).includes('skill half is not installed'), String(payload.reason))
  check('an absent skill half still lists nothing', payload.candidates.length === 0, JSON.stringify(payload.candidates))
}

{
  const absent = await decideCandidate(
    deps({ discardCandidate: async () => undefined }),
    { name: 'pdf-tools', action: 'discard' },
    'agent-1',
  )
  check('discarding without a skill half is refused', absent.ok === false, JSON.stringify(absent.ok))
  check('and the refusal is unavailable, not not-found', absent.code === 'unavailable', String(absent.code))
}

{
  const absent = await decideCandidate(
    deps({ approveCandidate: async () => undefined }),
    { name: 'pdf-tools', action: 'approve' },
    'agent-1',
  )
  check('approving without a skill half is refused', absent.ok === false, JSON.stringify(absent.ok))
  check('and approving reports unavailable too', absent.code === 'unavailable', String(absent.code))
}

{
  // `'unavailable'` used to be returned by the wiring layer and matched none of
  // the four refusals the route knows, so it fell through to `{ ok: true }`. The
  // absent case is now `undefined`, and the route has to say so.
  const res = await route(deps({ requestProposal: () => undefined }), fakeReq({
    url: `${ROUTE_PREFIX}/propose?agent=agent-1`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"agent":"agent-1"}',
  }))
  const body = JSON.parse(res.body)
  check('a propose with no skill half is not reported as success', body.data?.ok === false, JSON.stringify(body.data))
  check('and it says why', String(body.data?.reason).includes('skill half is not installed'), String(body.data?.reason))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
