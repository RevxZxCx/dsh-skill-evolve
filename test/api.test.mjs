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
import { basename, dirname, join } from 'node:path'

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
  isDeliverable
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
    // What the stream has written so far, unparsed. A stream is the one route
    // whose answer is not a single body, so `body` alone cannot describe it.
    written: [],
    once(event, handler) {
      res.listeners.push([event, handler])
      return res
    },
    on(event, handler) {
      res.listeners.push([event, handler])
      return res
    },
    removeListener(event, handler) {
      const at = res.listeners.findIndex((row) => row[0] === event && row[1] === handler)
      if (at >= 0) res.listeners.splice(at, 1)
      return res
    },
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
      return res
    },
    write(chunk) {
      res.written.push(String(chunk))
      return true
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
  const listeners = []
  return {
    url,
    method,
    headers: merged,
    listeners,
    once(event, handler) {
      listeners.push([event, handler])
      return this
    },
    on(event, handler) {
      listeners.push([event, handler])
      return this
    },
    removeListener(event, handler) {
      const at = listeners.findIndex((row) => row[0] === event && row[1] === handler)
      if (at >= 0) listeners.splice(at, 1)
      return this
    },
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
  // What the model said about a file is recorded by the collector, and this
  // layer's only job is to pass it through. A bare string is what the legacy
  // `previous.paths` fallback holds and what documents written before the field
  // existed contain; both must arrive as an empty string, because "nobody said
  // anything about it" is not the same as "the model called it X", and inventing
  // the second one is a claim nobody made.
  const dir = tempDir('skill-evolve-stat-source-')
  const present = join(dir, 'report.docx')
  writeFileSync(present, 'x')

  const legacy = await statTouchedFiles({ paths: [present] })
  check('a path with no recorded description says so with an empty one', legacy[0]?.description === '', JSON.stringify(legacy[0]))

  const described = await statTouchedFiles({ paths: [{ path: present, description: 'the onboarding deck' }] })
  check('a recorded description is passed through', described[0]?.description === 'the onboarding deck', JSON.stringify(described[0]))

  // A description that is not text is dropped rather than coerced: a row
  // quoting `[object Object]` under a filename is worse than a row with one line.
  const nonsense = await statTouchedFiles({ paths: [{ path: present, description: { said: 'x' } }] })
  check('a description that is not text becomes empty', nonsense[0]?.description === '', JSON.stringify(nonsense[0]))

  // And the same file named twice is one row, carrying the *first* description
  // it was handed -- because the caller has already resolved which visit wins.
  // `pathsSeen` sorts by `seq` descending, so the first entry in the list it
  // returns is the newest thing said about that file. Reading past it would let
  // an older visit's words overwrite the newest ones.
  const twice = await statTouchedFiles({ paths: [{ path: present, description: 'newest' }, { path: present, description: 'older' }] })
  check('a file named twice is one row', twice.length === 1, String(twice.length))
  check('and it carries the first description it was handed', twice[0]?.description === 'newest', JSON.stringify(twice[0]))
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
  // A directory was claimed as an edited file. Nothing to open — but nothing was
  // deleted either, and this used to say `missing`, which is a claim about the
  // past tense. The folder is right there, so the row says so.
  check('a directory is reported as a folder rather than a file', files.length === 1 && files[0].status === 'folder', JSON.stringify(files))
  check('and it is not reported as deleted', files[0]?.status !== 'missing', JSON.stringify(files))
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
  const written = join(dir, 'docs', 'guide.md')
  const bundled = join(dir, 'node_modules', 'lib', 'README.md')
  const script = join(dir, 'src', 'app.js')
  const image = join(dir, 'shots', 'card.png')
  const built = join(dir, 'src', 'out', 'report.pdf')
  const temporary = join(dir, 'tmp', 'notes.md')
  for (const file of [written, bundled, script, image, built, temporary]) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'e')
  }
  const payload = await readPanel(
    deps({
      transcripts: { view: () => ({ turns: 1, previous: { turn: 1, calls: 5, failed: 0, paths: [written, bundled], commands: [], said: 'wrote five', tools: [] } }) },
      filesSeen: () => [written, bundled, script, image, built, temporary],
      cwdFor: () => dir,
    }),
    'agent-1',
  )
  const byPath = new Map(payload.files.map((file) => [file.path, file]))
  check('a file this turn delivered says so', byPath.get(written)?.turn === true, JSON.stringify(byPath.get(written)))
  check('and a file it did not deliver says so too', byPath.get(image)?.turn === false, JSON.stringify(byPath.get(image)))
  // Every row carries the flag, whatever its value. The fixtures live under the OS
  // temp dir, and a `.md` there is a delivery: the directory list names dependency
  // and build scratch, not wherever a test happens to run. The rules themselves
  // are asserted on synthetic paths below, where the directory is part of the
  // input instead of an accident of the machine.
  for (const file of payload.files) {
    check(`the row for ${basename(file.path)} answers the flag`, typeof file.deliverable === 'boolean', JSON.stringify(file.deliverable))
  }
  check('and the document written here is one, wherever the test runs', byPath.get(written)?.deliverable === true, JSON.stringify(byPath.get(written)))
  // The card subtracts this from every absolute path to show the directory under
  // each name, so the panel has to send it; a client cannot guess it.
  check('the payload carries the workspace the paths are relative to', payload.cwd === dir, String(payload.cwd))
}

{
  // The whitelist is the whole answer to "what belongs on this card". It is
  // copied from Qoder's `C_0` set on purpose: a shared vocabulary is the only
  // way two products can mean the same thing by a delivered file, and inventing
  // a longer list would quietly make the card noisier than the one it models.
  const delivered = ['a.pdf', 'b.doc', 'c.docx', 'd.md', 'e.markdown', 'f.txt', 'g.xls', 'h.xlsx', 'i.xlsm', 'j.csv', 'k.tsv', 'l.ppt', 'm.pptx', 'n.html', 'o.htm', 'p.png', 'q.jpg', 'r.jpeg', 's.gif', 't.webp', 'u.svg', 'v.mp4', 'w.webm']
  for (const name of delivered) {
    check(`${name} is something a person reads`, isDeliverable(`/w/out/${name}`) === true, String(isDeliverable(`/w/out/${name}`)))
  }
  // Every extension this project itself writes, and every one a build leaves
  // behind, must stay off the card -- that is the entire point of the change.
  const refused = ['a.js', 'b.mjs', 'c.ts', 'd.tsx', 'e.json', 'f.jsonl', 'g.yaml', 'h.yml', 'i.toml', 'j.py', 'k.sh', 'l.ps1', 'm.bat', 'n.exe', 'o.log', 'p.zip', 'q.sha256', 'r.map', 's.css', 't.scss', 'u.xml', 'v.sql', 'w.diff', 'x.patch']
  for (const name of refused) {
    check(`${name} is not a delivery`, isDeliverable(`/w/out/${name}`) === false, String(isDeliverable(`/w/out/${name}`)))
  }
  // Case is not a decision: a build on Windows writes `REPORT.PDF`.
  check('an upper-case extension is the same extension', isDeliverable('/w/REPORT.PDF') === true, String(isDeliverable('/w/REPORT.PDF')))
  // A name with no extension at all is a directory, a binary, or a licence file;
  // none of the three is a document the reader opens from a card.
  check('a name with no extension is not a delivery', isDeliverable('/w/Makefile') === false, String(isDeliverable('/w/Makefile')))
  check('nor is a dot file', isDeliverable('/w/.gitignore') === false, String(isDeliverable('/w/.gitignore')))
  // A directory named `report.pdf` is not a document, and the trailing separator
  // is how the caller says so without a second argument.
  check('a directory is never a delivery, whatever it is called', isDeliverable('/w/report.pdf/') === false, String(isDeliverable('/w/report.pdf/')))
  // Qoder refuses office lock files by name prefix. They are real files with a
  // real extension, so only the name rule can catch them.
  check('an office lock file is not a delivery', isDeliverable('/w/~$report.docx') === false, String(isDeliverable('/w/~$report.docx')))
  // The directory rule is segment-wise, so a project that owns `src/build/`
  // keeps its documents: a build output directory is where a real delivery
  // lands, and refusing it was the old filter's mistake in the other direction.
  check('a document under a dependency tree is refused', isDeliverable('/w/node_modules/pkg/README.md') === false, String(isDeliverable('/w/node_modules/pkg/README.md')))
  check('a document under a temp directory is refused', isDeliverable('/w/tmp/notes.md') === false, String(isDeliverable('/w/tmp/notes.md')))
  check('a document under a cache is refused', isDeliverable('/w/.cache/x.png') === false, String(isDeliverable('/w/.cache/x.png')))
  // A scratch folder this build has never heard of is somebody's project
  // directory. The card is not allowed to have opinions about names it invented
  // for its own author's habits.
  check('a document under an unknown scratch folder is a delivery', isDeliverable('/w/.probe-x/report.md') === true, String(isDeliverable('/w/.probe-x/report.md')))
  check('a document under a git directory is refused', isDeliverable('/w/.git/notes.md') === false, String(isDeliverable('/w/.git/notes.md')))
  // A directory that merely starts with a listed name is somebody's source.
  check('a directory that merely starts like a cache is entered', isDeliverable('/w/cachetools/report.md') === true, String(isDeliverable('/w/cachetools/report.md')))
  check('and one that merely starts like a scratch folder too', isDeliverable('/w/.probing/report.md') === true, String(isDeliverable('/w/.probing/report.md')))
  check('a build output directory is not refused', isDeliverable('/w/dist/report.pdf') === true, String(isDeliverable('/w/dist/report.pdf')))
  check('nor is out', isDeliverable('/w/out/report.pdf') === true, String(isDeliverable('/w/out/report.pdf')))
  // Windows separators are the normal case here, not an edge case.
  check('a backslash path is read the same way', isDeliverable('F:\\work\\docs\\guide.md') === true, String(isDeliverable('F:\\work\\docs\\guide.md')))
  check('and a backslash path under a dependency is refused', isDeliverable('F:\\work\\node_modules\\x\\README.md') === false, String(isDeliverable('F:\\work\\node_modules\\x\\README.md')))
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

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------
//
// The panel used to ask every eight seconds because nothing could tell it that
// something had changed. This route is the answer to that, so the properties
// worth pinning are the ones a wrong implementation would still look fine
// without: the stream must be a stream, it must say the revision it is at the
// moment it opens, it must push only this conversation's changes, and it must
// let go of its subscription when the response closes.

{
  const res = await route(
    { panelRevision: () => 7, panelSubscribe: () => () => {} },
    fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-1` }),
  )
  check('the stream answers 200', res.statusCode === 200, String(res.statusCode))
  check(
    'and it is announced as an event stream',
    typeof res.headers?.['content-type'] === 'string' && res.headers['content-type'].startsWith('text/event-stream'),
    JSON.stringify(res.headers),
  )
  // A proxy that buffers would hold every frame until the response ended, which
  // for a stream is never. The header is the only lever a plugin has over that.
  check(
    'and asks not to be buffered',
    res.headers?.['cache-control'] === 'no-cache' && res.headers?.['x-accel-buffering'] === 'no',
    JSON.stringify(res.headers),
  )
  // The comment line is not noise: without a write, the headers sit in the
  // server's buffer and the browser's `EventSource` stays in `connecting` until
  // the first real frame, which may be minutes away.
  check('it opens with a comment so the headers leave the buffer', res.written[0] === ': connected\n\n', JSON.stringify(res.written.slice(0, 2)))
  const first = res.written.find((chunk) => chunk.startsWith('data: '))
  check('and the first frame already carries the reading', first !== undefined && JSON.parse(first.slice(6)).revision === 7, String(first))
  check('and it names the conversation it is about', first !== undefined && JSON.parse(first.slice(6)).agent === 'agent-1', String(first))
  check('the response is left open', res.ended === false, res.ended === true ? 'the stream ended on its own' : 'open')
  check('the first frame ends with a blank line', first !== undefined && first.endsWith('\n\n'), JSON.stringify(first))
}

{
  // A change to another conversation must not wake this stream. Without the
  // filter every open panel would fetch on every event in the application,
  // which is worse than the timer it replaced.
  let fire = () => {}
  const stops = []
  const res = await route(
    {
      panelRevision: () => 1,
      panelSubscribe(listener) {
        fire = listener
        return () => {
          stops.push('unsubscribed')
        }
      },
    },
    fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-1` }),
  )
  const before = res.written.length
  fire('agent-2', 9)
  check('another conversation does not write to this stream', res.written.length === before, String(res.written.length - before))
  fire('agent-1', 8)
  const frames = res.written.slice(before).filter((chunk) => chunk.startsWith('data: '))
  check('this conversation does write to it', frames.length === 1, JSON.stringify(res.written.slice(before)))
  check('and the frame carries the new revision', frames.length === 1 && JSON.parse(frames[0].slice(6)).revision === 8, String(frames[0]))
  // Releasing the subscription is the whole difference between a stream and a
  // leak: every closed tab would otherwise leave a listener writing into a dead
  // response for the life of the process.
  const closed = res.listeners.find((row) => row[0] === 'close')
  check('the response registers for its own close', closed !== undefined, JSON.stringify(res.listeners.map((row) => row[0])))
  closed?.[1]?.()
  check('and closing it unsubscribes', stops.length === 1, JSON.stringify(stops))
  check('and it stops writing afterwards', res.written.length === before + 1, String(res.written.length))
}

{
  // A frame written after the socket is gone is a write to a closed response,
  // which throws `ERR_STREAM_WRITE_AFTER_END` in the host's process. The guard
  // is cheap and its absence is loud only in production.
  let fire = () => {}
  const res = await route(
    { panelRevision: () => 1, panelSubscribe: (listener) => { fire = listener; return () => {} } },
    fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-1` }),
  )
  const before = res.written.length
  res.writableEnded = true
  fire('agent-1', 3)
  check('a change after the stream ended writes nothing', res.written.length === before, String(res.written.length - before))
}

{
  const res = await route({ panelRevision: () => 5, panelSubscribe: () => () => {} }, fakeReq({ url: `${ROUTE_PREFIX}/events` }))
  check('a stream with no agent is refused', res.statusCode === 400, String(res.statusCode))
  check('and it says what is missing', bodyOf(res).code === 'error.agent.missing', String(res.body))
}

{
  // A dispose has to reach streams opened by requests that are no longer on the
  // stack. Without it a reload leaves the browser holding responses nothing will
  // write to again, and `EventSource` retries against a route that now 404s.
  {
    let unsubscribed = 0
    const opened = createPanelApi({
      panelRevision: () => 1,
      panelSubscribe() {
        return () => {
          unsubscribed += 1
        }
      },
    })
    const first = fakeRes()
    await opened(fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-1` }), first)
    const second = fakeRes()
    await opened(fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-2` }), second)
    // Captured before the dispose: `stop` removes these listeners, so reading
    // them afterwards finds an empty list and the assertion below would pass
    // without running anything.
    const queuedClose = second.listeners.filter((row) => row[0] === 'close').map((row) => row[1])
    check('two streams are open before the dispose', first.ended === false && second.ended === false, `${first.ended}/${second.ended}`)
    opened.closeStreams()
    check('a dispose unsubscribes every stream it left open', unsubscribed === 2, `${unsubscribed} unsubscribe(s)`)
    // The dispose is not the only way a stream ends. A `close` event that was
    // already queued when the stream was stopped arrives afterwards, and it runs
    // the same teardown a second time. `Set.delete` is idempotent, so the only
    // thing that can go wrong is the unsubscribe being called twice -- and a
    // counter that is unhooked twice is how a listener survives the thing that
    // removed it. Firing the queued close by hand is the only way to reach it:
    // calling `closeStreams()` again iterates an empty set and proves nothing,
    // which is exactly what this assertion used to do.
    for (const handler of queuedClose) handler()
    check('and a close that arrives after the dispose is ignored', unsubscribed === 2, `${unsubscribed} unsubscribe(s)`)
  }

  {
    // A stream that closes on its own has to leave the set. Nothing observable
    // changes if it does not -- `stop` is idempotent, so a stale entry is
    // invisible until the process has held enough of them to matter. The count
    // is the only place that distinction shows, which is why it exists.
    let unsubscribed = 0
    const opened = createPanelApi({
      panelRevision: () => 1,
      panelSubscribe() {
        return () => {
          unsubscribed += 1
        }
      },
    })
    const res = fakeRes()
    await opened(fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-1` }), res)
    check('an open stream is counted', opened.openStreamCount() === 1, String(opened.openStreamCount()))
    for (const handler of res.listeners.filter((row) => row[0] === 'close').map((row) => row[1])) handler()
    check('a stream that closes is forgotten, not just stopped', opened.openStreamCount() === 0, String(opened.openStreamCount()))
    check('and it was unsubscribed once', unsubscribed === 1, `${unsubscribed} unsubscribe(s)`)
  }

  {
    // The request side of the teardown. A real client abort fires `close` on the
    // request before it fires one on the response, so `req.once('close', …)` is
    // the listener that actually runs on the common path -- and nothing asserted
    // it existed, so deleting both that line and its matching `removeListener`
    // left the suite green. Firing the request's own close is the only way to
    // reach it: the response never learns.
    let unsubscribed = 0
    const opened = createPanelApi({
      panelRevision: () => 1,
      panelSubscribe() {
        return () => {
          unsubscribed += 1
        }
      },
    })
    const req = fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-1` })
    const res = fakeRes()
    await opened(req, res)
    const reqClose = req.listeners.filter((row) => row[0] === 'close').map((row) => row[1])
    check('the request registers for its own close', reqClose.length === 1, JSON.stringify(req.listeners.map((row) => row[0])))
    check('and the stream is counted while it is open', opened.openStreamCount() === 1, String(opened.openStreamCount()))
    for (const handler of reqClose) handler()
    check('a client going away releases the subscription', unsubscribed === 1, `${unsubscribed} unsubscribe(s)`)
    check('and the stream is forgotten', opened.openStreamCount() === 0, String(opened.openStreamCount()))
    check(
      'and it is unhooked from both sides',
      req.listeners.filter((row) => row[0] === 'close').length === 0 && res.listeners.filter((row) => row[0] === 'close').length === 0,
      `${req.listeners.length}/${res.listeners.length}`,
    )
  }

  {
    // A dispose has to destroy the responses, not just stop writing to them. The
    // difference was measured against a real socket: with only the listeners
    // removed, the client's `read()` stayed pending and the server kept the
    // connection, while the set was already empty and nothing could reach those
    // responses again. `destroyed` is the observable half; `ended` is
    // deliberately not used -- an ordinary EOF makes `EventSource` reconnect to a
    // route the dispose just removed.
    const opened = createPanelApi({ panelRevision: () => 1, panelSubscribe: () => () => {} })
    const first = fakeRes()
    const second = fakeRes()
    await opened(fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-1` }), first)
    await opened(fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-2` }), second)
    check('a stream starts out neither ended nor destroyed', first.destroyed === false && first.writableEnded === false, `${first.destroyed}/${first.writableEnded}`)
    opened.closeStreams()
    check('a dispose destroys the responses it left open', first.destroyed === true && second.destroyed === true, `${first.destroyed}/${second.destroyed}`)
  }

  {
    // A socket that has already gone is the other way a response can be
    // finished: Node reports `destroyed` and leaves `writableEnded` false, so a
    // guard that only asked the second question would write into nothing and
    // call it success.
    let fire = () => {}
    const res = await route(
      { panelRevision: () => 1, panelSubscribe: (listener) => { fire = listener; return () => {} } },
      fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-1` }),
    )
    const before = res.written.length
    res.destroyed = true
    fire('agent-1', 3)
    check('a change after the socket died writes nothing', res.written.length === before, String(res.written.length - before))
  }

  {
    // The method gate lets POST through for the routes that take a body. A stream
    // has no body to take, and parking a POST here would leave the host waiting
    // for one nobody reads while the response wrote frames.
    const res = await route(
      { panelRevision: () => 1, panelSubscribe: () => () => {} },
      fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-1`, method: 'POST' }),
    )
    check('a post is refused on the stream route', res.statusCode === 405, String(res.statusCode))
    check('and no stream is opened', res.headers?.['content-type'] !== 'text/event-stream', JSON.stringify(res.headers))
  }

  {
    // The heartbeat. A response that says nothing for a minute is what a proxy
    // drops, and `EventSource` then reconnects in a loop, so the silence has to
    // be broken on purpose. The interval is injected short here rather than slept
    // through: the real one is thirty seconds.
    const opened = createPanelApi({ panelRevision: () => 1, panelSubscribe: () => () => {}, heartbeatMs: 5 })
    const res = fakeRes()
    await opened(fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-1` }), res)
    check('no beat has happened yet', res.written.filter((row) => row === ': heartbeat\n\n').length === 0, JSON.stringify(res.written.slice(0, 3)))
    await new Promise((resolve) => setTimeout(resolve, 40))
    const beats = res.written.filter((row) => row === ': heartbeat\n\n').length
    check('an idle stream breaks its own silence', beats > 0, `${beats} beat(s)`)
    // A beat is a comment, so it must not look like a frame to the client: a
    // `data:` line here would make the panel fetch on a timer under another name.
    check('and a beat carries no frame', res.written.filter((row) => row.startsWith('data: ')).length === 1, JSON.stringify(res.written.filter((row) => row.startsWith('data: '))))
    const stoppedAt = res.written.length
    for (const handler of res.listeners.filter((row) => row[0] === 'close').map((row) => row[1])) handler()
    await new Promise((resolve) => setTimeout(resolve, 40))
    check('and a stopped stream stops beating', res.written.length === stoppedAt, `${res.written.length - stoppedAt} beat(s) after the close`)
  }

  {
    // `clearInterval` in `stop` looks redundant: the callback already returns
    // early once `stopped` is set, so a deleted `clearInterval` changes nothing
    // a socket can observe. What it changes is that the interval keeps firing
    // for the life of the process -- one per closed stream, forever, since a
    // stream is reopened every time the page or the conversation changes.
    //
    // A leak with no visible symptom is exactly what a mutation entry finds and
    // a socket-level assertion cannot, so this watches the registration instead:
    // the handle `setInterval` returned for this stream has to come back through
    // `clearInterval` when the stream ends.
    const opened = createPanelApi({ panelRevision: () => 1, panelSubscribe: () => () => {}, heartbeatMs: 5 })
    const realSetInterval = globalThis.setInterval
    const realClearInterval = globalThis.clearInterval
    const registered = []
    const clearedHandles = []
    globalThis.setInterval = (...args) => {
      const handle = realSetInterval(...args)
      registered.push(handle)
      return handle
    }
    globalThis.clearInterval = (handle) => {
      clearedHandles.push(handle)
      return realClearInterval(handle)
    }
    try {
      const res = fakeRes()
      await opened(fakeReq({ url: `${ROUTE_PREFIX}/events?agent=agent-1` }), res)
      check('opening a stream registers one interval', registered.length === 1, String(registered.length))
      for (const handler of res.listeners.filter((row) => row[0] === 'close').map((row) => row[1])) handler()
      check('and ending it hands the interval back', clearedHandles.includes(registered[0]), `${clearedHandles.length} cleared`)
    } finally {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    }
  }

  // A host that never wired `panelSubscribe` must not leave the route hanging:
  // the frame at open time is still the useful half, and a HEAD probe has to
  // answer without opening a stream at all.
  const res = await route({ panelRevision: () => 2 }, fakeReq({ url: `${ROUTE_PREFIX}/events?agent=a`, method: 'HEAD' }))
  check('a head probe does not open a stream', res.ended === true, res.ended === false ? 'the stream was opened for a HEAD' : 'ended')
  // A HEAD answer carries no body by construction, so the assertion is that it
  // ended as an ordinary response with headers -- not that it announced a stream
  // in a payload nobody receives.
  check('and it still reports success', res.statusCode === 200 && res.headers?.['content-type'] !== 'text/event-stream', `${res.statusCode} ${res.headers?.['content-type']}`)
}

{
  // Without the reader the stream can only ever say "now", once. The fallback is
  // what a host that cannot subscribe falls back to, so its absence must be a
  // working stream rather than an exception.
  const res = await route({ panelRevision: () => 4 }, fakeReq({ url: `${ROUTE_PREFIX}/events?agent=a` }))
  check('a host with no subscriber still opens a stream', res.statusCode === 200 && res.headers?.['content-type'] === 'text/event-stream', String(res.statusCode))
  check('and it still says where it stands', res.written.some((chunk) => chunk.includes('"revision":4')), JSON.stringify(res.written))
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
  // The panel reads these to decide whether it draws at all and how wide it
  // starts. When they were missing the client's guards never fired, so both
  // settings were inert — and nothing failed, because the client test fakes this
  // route rather than calling it.
  check(
    'the config route reports the monitor column switch',
    typeof bodyOf(res).data.monitorColumn === 'boolean',
    String(res.body),
  )
  check(
    'and no longer reports the removed side setting',
    bodyOf(res).data.panelSide === undefined,
    String(res.body),
  )
  check(
    'nor the removed collapsed setting',
    bodyOf(res).data.panelCollapsed === undefined,
    String(res.body),
  )
}

{
  // A configured 'false' must come back as 'false', and a width as a number. A
  // payload that hard-coded the defaults would satisfy the shape assertions
  // above and still ignore the setting.
  const res = await route(
    { config: { monitorColumn: false, monitorWidth: 260 } },
    fakeReq({ url: `${ROUTE_PREFIX}/config` }),
  )
  check('a switched-off column is reported as off', bodyOf(res).data.monitorColumn === false, String(res.body))
  check('a configured width is reported', bodyOf(res).data.monitorWidth === 260, String(res.body))
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
    fakeReq({ url: `${ROUTE_PREFIX}/config`, method: 'POST', body: JSON.stringify({ monitorWidth: 240 }) }),
  )
  check('posting a width applies it', bodyOf(res).data.monitorWidth === 240, String(res.body))
  check('posting a width reports success', bodyOf(res).ok === true, String(res.body))
  check('posting a width reaches the override sink', applied.monitorWidth === 240, JSON.stringify(applied))
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
  // Held, not bare: this host half has no `speedRevision`, and a wait that never
  // settles would leave the top-level await pending forever. Node then prints
  // "unsettled top-level await" and the suite ends with no tally line at all --
  // which the mutation runner reports as CRASHED rather than as the caught
  // defect it is. `routeHeld` turns the same bug into one red assertion.
  const res = await routeHeld(
    { speedOf: (id) => { asked.push(id); return { tokens: 100, ms: 1000, tps: 100, active: true } } },
    fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=agent-7` }),
  )
  check('the speed route answers 200', res.statusCode === 200, String(res.statusCode))
  check('and hands back the reading', heldBodyOf(res).data?.tps === 100, String(res.body))
  check('and it asks about the session in the query', asked[0] === 'agent-7', JSON.stringify(asked))
  check('and it says the reading is active', heldBodyOf(res).data?.active === true, String(res.body))
}

{
  // An idle session is a 200 with an inactive reading, not an error: the client
  // needs to tell "nothing is being written" from "this host cannot say", and
  // those are the same status code only if the body is read.
  // Held for the same reason as the block above: this host half has no counter,
  // so a wait that never settles must fail an assertion rather than leave the
  // top-level await pending and the suite without a tally.
  const res = await routeHeld(
    { speedOf: () => ({ tokens: 0, ms: 0, tps: 0, active: false }) },
    fakeReq({ url: `${ROUTE_PREFIX}/speed?agent=idle` }),
  )
  check('an idle session is not an error', res.statusCode === 200, String(res.statusCode))
  check('and it reports itself inactive rather than absent', heldBodyOf(res).ok === true && heldBodyOf(res).data?.active === false, String(res.body))
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

// ---------------------------------------------------------------------------
// The host's admission
//
// `checkOrigin` above answers "did this arrive from a page allowed to talk to
// this server". It does not answer "who is asking", and a loopback listener is
// reachable by every process and every user on the machine. The route therefore
// asks the host the same question its own `/api` route asks, and these tests pin
// the three answers it can give plus the two failure shapes.
// ---------------------------------------------------------------------------

{
  // No connection service on this host: the plugin cannot invent an identity
  // check it was not given, so the route stays open. This is the shape every
  // existing test above relies on.
  const res = await route({}, fakeReq({ url: `${ROUTE_PREFIX}/panel?agent=a` }))
  check('a host with no admission still serves the panel', res.statusCode === 200, String(res.statusCode))
}

{
  const asked = []
  const res = await route(
    {
      admission: (req) => {
        asked.push(req)
        return undefined
      }
    },
    fakeReq({ url: `${ROUTE_PREFIX}/panel?agent=a` }),
  )
  check('a host that vouches serves the panel', res.statusCode === 200, String(res.statusCode))
  check('the host is asked exactly once', asked.length === 1, `${asked.length} ask(s)`)
}

{
  const res = await route({ admission: () => 401 }, fakeReq({ url: `${ROUTE_PREFIX}/panel?agent=a` }))
  check('an unauthenticated request is a 401', res.statusCode === 401, String(res.statusCode))
  check('and it names its code', bodyOf(res).code === 'error.auth.required', String(res.body))
  check('and it carries no payload', bodyOf(res).data === undefined, String(res.body))
}

{
  // 403 is the untrusted-host answer. It has to survive as 403 rather than being
  // flattened to 401: the two say different things to whoever is debugging.
  const res = await route({ admission: () => 403 }, fakeReq({ url: `${ROUTE_PREFIX}/panel?agent=a` }))
  check('an untrusted host keeps its own status', res.statusCode === 403, String(res.statusCode))
}

{
  // A host that can answer and then fails is refused, not waved through. This is
  // the direction that matters: the route serves the person's own conversation,
  // so "the question was hard" must not be the same answer as "yes".
  const res = await route(
    {
      admission: () => {
        throw new Error('the credentials store is unreadable')
      }
    },
    fakeReq({ url: `${ROUTE_PREFIX}/panel?agent=a` }),
  )
  check('an admission that throws is a refusal', res.statusCode === 401, String(res.statusCode))
}

{
  // The gate covers every route, not only the one that lists files: `/candidates`
  // returns the queue, and `/propose` writes into the session.
  const refused = []
  for (const path of ['/panel', '/candidates', '/models', '/config', '/speed']) {
    const res = await route({ admission: () => 401 }, fakeReq({ url: `${ROUTE_PREFIX}${path}` }))
    refused.push({ path, status: res.statusCode })
  }
  check(
    'every read route is behind the same gate',
    refused.every((row) => row.status === 401),
    JSON.stringify(refused)
  )

  const post = await route(
    { admission: () => 401 },
    fakeReq({ url: `${ROUTE_PREFIX}/propose`, method: 'POST', body: JSON.stringify({ agent: 'a', skill: 's' }) })
  )
  check('the writing route is behind it too', post.statusCode === 401, String(post.statusCode))
}

{
  // Order matters: the origin check runs first, so a cross-site request is
  // reported as cross-site rather than as a missing credential. Both refuse, but
  // only one of them names the actual problem.
  const asked = []
  const res = await route(
    {
      admission: () => {
        asked.push(1)
        return undefined
      }
    },
    fakeReq({ url: `${ROUTE_PREFIX}/panel`, headers: { 'sec-fetch-site': 'cross-site' } }),
  )
  check('a cross-site request still reads as cross-site', bodyOf(res).code === 'error.origin.forbidden', String(res.body))
  check('and the host is not even asked', asked.length === 0, `${asked.length} ask(s)`)
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
  // Approving moves `pendingCandidates`, which is part of every panel payload on
  // this conversation -- and this path never touches a session event, so nothing
  // else would notice. The stream is the only channel that carries it, which is
  // why the assertion below counts bumps rather than trusting the route to have
  // called one: `deps()` supplies no `panelBump`, so a mutation that deletes the
  // call would otherwise have nothing to fail against.
  const bumps = []
  const res = await route(
    {
      approveCandidate: async () => ({ ok: true }),
      panelBump: (id) => { bumps.push(id) },
    },
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
  check('a realised decision wakes the panel', bumps.length === 1, JSON.stringify(bumps))
  check('and it wakes the conversation the decision was made for', bumps[0] === 'agent-9', JSON.stringify(bumps))

  // The other direction: a refusal changes no count, so waking every other tab
  // would be a frame that says "look again" about nothing.
  const refusedBumps = []
  const refused = await route(
    {
      approveCandidate: async () => ({ ok: false, code: 'not-found', error: 'no such candidate' }),
      panelBump: (id) => { refusedBumps.push(id) },
    },
    fakeReq({
      url: `${ROUTE_PREFIX}/candidates?agent=agent-9`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'gone', action: 'approve' }),
    }),
  )
  check('a refused decision still answers 200', refused.statusCode === 200, String(refused.statusCode))
  check('a refused decision wakes nobody', refusedBumps.length === 0, JSON.stringify(refusedBumps))
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





{
  // The fourth answer, and the reason it exists: a record that only kept a
  // relative path gets joined to the session root here, and that base is a guess
  // — the command may well have run somewhere else. Reporting ENOENT on a guess
  // as "deleted" put a line through a file the turn had just written.
  const dir = tempDir('skill-evolve-stat-unresolved-')
  const files = await statTouchedFiles({
    paths: ['packages/ui-evolve/lib/client.js'],
    cwd: dir,
    readStat: async () => {
      const error = new Error('no such file')
      error.code = 'ENOENT'
      throw error
    },
  })
  check('a guessed path that is not there is unresolved', files.length === 1 && files[0].status === 'unresolved', JSON.stringify(files))
  check('and it is not reported as deleted', files[0]?.status !== 'missing', JSON.stringify(files))
  check('an unresolved row has no size to show', files[0]?.bytes === null, String(files[0]?.bytes))
  check('and it still carries the path that was recorded', files[0]?.path === join(dir, 'packages', 'ui-evolve', 'lib', 'client.js'), String(files[0]?.path))
}

{
  // The other half of the same rule. An absolute path was not a guess, so ENOENT
  // on it means the file really is gone and the reader should be told so —
  // otherwise the new state would swallow the one case that was already right.
  const dir = tempDir('skill-evolve-stat-absolute-gone-')
  const files = await statTouchedFiles({
    paths: [join(dir, 'gone.js')],
    cwd: dir,
    readStat: async () => {
      const error = new Error('no such file')
      error.code = 'ENOENT'
      throw error
    },
  })
  check('an absolute path that is not there is still missing', files.length === 1 && files[0].status === 'missing', JSON.stringify(files))
}

{
  // A path that exists but cannot be read is not a guess about location — the
  // path resolved, and something else is wrong. That distinction must survive
  // the new status too.
  const dir = tempDir('skill-evolve-stat-guess-invalid-')
  const files = await statTouchedFiles({
    paths: ['lib/blocked.js'],
    cwd: dir,
    readStat: async () => {
      const error = new Error('permission denied')
      error.code = 'EACCES'
      throw error
    },
  })
  check('a guessed path that cannot be read is invalid, not unresolved', files.length === 1 && files[0].status === 'invalid', JSON.stringify(files))
}

{
  // A directory found through a guess. The guess is irrelevant here: `stat`
  // succeeded, so the record's uncertainty about the base never mattered — what
  // was found is a folder either way. This is the pair that used to disagree
  // with itself: the same answer meant `missing` for an absolute path and
  // `unresolved` for a relative one, so neither word said "a folder".
  const dir = tempDir('skill-evolve-stat-dir-guess-')
  const files = await statTouchedFiles({
    paths: ['src'],
    cwd: dir,
    readStat: async () => ({ isFile: () => false, size: 0, mtimeMs: 0 }),
  })
  check('a directory reached through a guess is a folder too', files.length === 1 && files[0].status === 'folder', JSON.stringify(files))
}

{
  // And an absolute directory lands on the same word as a relative one. Before,
  // these two blocks asserted different statuses for the same finding, which is
  // how the bug survived: each assertion was locally reasonable and together
  // they said the card reports on where the path came from rather than on what
  // is at it.
  const dir = tempDir('skill-evolve-stat-dir-absolute-')
  const files = await statTouchedFiles({
    paths: [dir],
    cwd: dir,
    readStat: async () => ({ isFile: () => false, size: 0, mtimeMs: 0 }),
  })
  check('an absolute directory is a folder as well', files.length === 1 && files[0].status === 'folder', JSON.stringify(files))
  check('and an absent absolute path is still missing, which is a different finding', (
    await statTouchedFiles({ paths: [join(dir, 'never-existed')], cwd: dir })
  )[0]?.status === 'missing', '')
}

{
  // A record can outlive the parser that wrote it. `2>&1` used to leave `&1` behind, a
  // glob in an argument could arrive as a target, and one real state file still holds
  // `F:\dsh-plugin\&1` from that era. Those rows were drawn as `missing`, which says
  // "you deleted this" about something that was never a file name.
  //
  // The refusal has to be narrow in both directions, so all three checks below are
  // load-bearing: refuse the impossible, keep the odd-but-real, and do not turn into
  // "hide everything absent".
  const dir = tempDir('skill-evolve-stat-junk-')
  const junk = await statTouchedFiles({
    paths: [join(dir, '&1'), join(dir, '2>'), join(dir, 'notes*.md'), '&1)'],
    cwd: dir,
  })
  check('a record spelled like a redirection is not drawn as a deleted file', junk.length === 0, JSON.stringify(junk.map((row) => row.path)))

  // A file anyone may legitimately name. `stat` finds it, so the row is drawn whatever
  // it is called -- refusing the spelling up front would hide a file the session wrote,
  // which is the same lie in the opposite direction.
  const odd = join(dir, 'a&b.txt')
  writeFileSync(odd, 'x')
  const drawn = await statTouchedFiles({ paths: [odd], cwd: dir })
  check('a file with an ampersand in its name is drawn, not refused', drawn.length === 1 && drawn[0].status === 'available', JSON.stringify(drawn))

  // `&1` is a descriptor to a shell and a perfectly legal file name to a filesystem.
  // This one really exists, so the refusal must never see it: it is only consulted after
  // `stat` has already reported the path absent.
  const descriptor = join(dir, '&1')
  writeFileSync(descriptor, 'x')
  const descriptorRow = await statTouchedFiles({ paths: [descriptor], cwd: dir })
  check('a file literally named &1 is drawn when it exists', descriptorRow.length === 1 && descriptorRow[0].status === 'available', JSON.stringify(descriptorRow))

  // The reordering the check above cannot see: a path whose spelling looks like a glob
  // but which `stat` reports as present. Refusing before asking would drop this row; the
  // guard runs afterwards, so the answer is `available`. `readStat` is injected because
  // what matters is the order, not whether this platform can create such a file.
  const globish = join(dir, 'notes*.md')
  const shown = await statTouchedFiles({
    paths: [globish],
    cwd: dir,
    readStat: async () => ({ isFile: () => true, size: 1, mtimeMs: 1 }),
  })
  check('a path that exists is drawn even when it is spelled like a glob', shown.length === 1 && shown[0].status === 'available', JSON.stringify(shown))

  // A bare `&` is a legal file name, so the descriptor rule must require digits. Without
  // that, an absent file called `&` would be withheld as if it had never been a name.
  const bare = await statTouchedFiles({ paths: [join(dir, '&')], cwd: dir })
  check('a missing file called & is reported missing, not withheld', bare.length === 1 && bare[0].status === 'missing', JSON.stringify(bare))

  // A spelling that cannot be a name is still only withheld when the filesystem says it
  // is absent. When `stat` fails for another reason the row survives as `invalid` --
  // "I could not read it" is true, and `missing` is what would be the lie.
  const unreadable = await statTouchedFiles({
    paths: [join(dir, 'notes*.md')],
    cwd: dir,
    readStat: async () => {
      const error = new Error('permission denied')
      error.code = 'EACCES'
      throw error
    },
  })
  check('an impossible spelling that stat could not read is kept as invalid', unreadable.length === 1 && unreadable[0].status === 'invalid', JSON.stringify(unreadable))

  // The `/dev/` clause on its own: no fixture above contains a device path.
  const device = await statTouchedFiles({ paths: ['/dev/null)', '/dev/tty'], cwd: dir })
  check('a device path left behind by a redirection is withheld', device.length === 0, JSON.stringify(device.map((row) => row.path)))

  // The real shape: `pathsSeen` hands over objects, and `cwd` can be undefined.
  const shaped = await statTouchedFiles({
    paths: [{ path: join(dir, '&1'), turn: 1, at: 1, source: 'git' }],
    cwd: undefined,
    turnPaths: new Set(),
    turnNow: 1,
  })
  check('a record handed over as an object is read the same way', shaped.length === 1 && shaped[0].status === 'available', JSON.stringify(shaped))

  // The cheapest way to pass the first check is to drop every absent row, which would
  // delete the reason the card exists.
  const absent = await statTouchedFiles({ paths: [join(dir, 'never-existed.txt')], cwd: dir })
  check('an absent ordinary path is still reported as missing', absent.length === 1 && absent[0].status === 'missing', JSON.stringify(absent))

  // Two hundred paths, one stat each, awaited one at a time, was measured at
  // 17.5ms against 2.6ms for the same set issued together. The observable
  // difference is how many probes are in flight at once, so that is what this
  // asserts -- an implementation that awaits each one before starting the next
  // never sees a peak above one.
  let inFlight = 0
  let peak = 0
  const burst = Array.from({ length: 24 }, (_, index) => join(dir, `burst-${index}.txt`))
  // Later paths are answered sooner, so completion order is the reverse of arrival
  // order. With one shared delay the two orders are identical and an
  // implementation that pushed rows as each answer landed would pass the ordering
  // check while scrambling the card.
  const delayFor = (absolute) => {
    const index = burst.findIndex((candidate) => absolute.endsWith(basename(candidate)))
    return 24 - index
  }
  const measured = await statTouchedFiles({
    paths: burst,
    cwd: dir,
    readStat: async (absolute) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      // Yield to the event loop so the other probes get a chance to start; a
      // synchronous resolve would collapse the peak back to one no matter how
      // the caller awaits.
      await new Promise((resolve) => setTimeout(resolve, delayFor(absolute)))
      inFlight -= 1
      return { isFile: () => true, size: 1, mtimeMs: 1 }
    },
  })
  check('probes are issued together, not one after another', peak > 1, `peak concurrency ${peak}`)
  check('every burst path still gets its row', measured.length === burst.length, `${measured.length} of ${burst.length}`)
  check('the rows keep the order the paths arrived in', measured.every((row, index) => row.path === burst[index]), JSON.stringify(measured.map((row) => row.path).slice(0, 3)))

  // The fallback source is the transcript's per-turn path list, which has no cap
  // of its own -- a command that writes many files appends every one. Asking
  // about all of them at once would put an unbounded burst on the thread pool the
  // rest of the host shares, so the function trims to the same number session
  // state already uses. Bounded by the callee, not by trusting the caller.
  let asked = 0
  const flood = Array.from({ length: 260 }, (_, index) => join(dir, `flood-${index}.txt`))
  const trimmed = await statTouchedFiles({
    paths: flood,
    cwd: dir,
    readStat: async () => {
      asked += 1
      return { isFile: () => true, size: 1, mtimeMs: 1 }
    },
  })
  check('a path list longer than the batch is trimmed, not issued whole', asked <= 200, `${asked} probe(s) for 260 paths`)
  check('the trim keeps the first rows, so the newest stay', trimmed.length === asked, `${trimmed.length} row(s) for ${asked} probe(s)`)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
