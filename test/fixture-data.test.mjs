// The scrubbed fixtures, through the same chain the panel uses.
//
// `real-data.test.mjs` reads whatever sessions happen to be on the machine, so on
// a clean checkout it skips and asserts nothing. This suite reads the fixtures in
// `test/fixtures/` instead: small documents copied mechanically out of real
// session files by `scripts/make-fixture.mjs`, one per shape a shipped build
// wrote. Every path in them is a stand-in root, so the answers here are the same
// on any machine.
//
// The chain under test is the real one, start to finish:
//
//   fixture file on disk → SessionStore reads it → readPanel → the JSON the route
//   sends → the card's own renderer
//
// The only stand-ins are the ones Node cannot provide: a host object with the
// handful of members `apply()` uses, and a DOM with React in it. The point of the
// suite is that the fixtures were not written by hand, so a shape the card gets
// wrong fails here instead of on someone's machine.
//
// Three behaviours are pinned, each of which was once a real defect:
//   * a directory stat succeeded on is a directory, not a deleted file;
//   * a record spelled like a shell redirection is not a row at all;
//   * a row with no recorded time is not filed under the stale heading.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply as applyPanel, Config as PanelConfig } from '../packages/ui-evolve/lib/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..')
const FIXTURES = join(repo, 'test', 'fixtures')

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

let reported = false

// Printed both on the happy path and from the crash handlers below. Without the
// handlers a throw exits the process before the tally line, and a runner that
// only parses the tally reads that silence as "survived" — six defects in this
// repository arrived that way.
function report(extra) {
  if (reported === true) return
  reported = true
  if (extra !== undefined) {
    failed += 1
    failures.push(extra)
  }
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  console.log(`\n${passed} passed, ${failed} failed`)
}

// The message says what broke; the first stack frame says where. Without the
// frame, a crash inside the renderer reads as "the suite threw" and the only way
// to find it is to run the suite with the handler removed.
function where(error) {
  const frame = String(error?.stack ?? '').split('\n')[1] ?? ''
  return frame.trim()
}

process.on('uncaughtException', (error) => {
  report(`the suite threw before it finished — ${error?.message ?? error} [${where(error)}]`)
  process.exit(1)
})
process.on('unhandledRejection', (error) => {
  report(`the suite rejected before it finished — ${error?.message ?? error} [${where(error)}]`)
  process.exit(1)
})

const cleaning = []

function makeTempRoot(prefix) {
  return mkdtemp(join(tmpdir(), prefix)).then((path) => {
    cleaning.push(path)
    return path
  })
}

// ---------------------------------------------------------------------------
// The host half: the members `apply()` touches, and the real route.
// ---------------------------------------------------------------------------

function fakeHost() {
  const handlers = new Map()
  const routes = new Map()
  const agents = new Map()
  const services = new Map()

  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(register) {
      return register()
    },
    inject(names, callback) {
      if (names.every((name) => ctx[name] !== undefined || services.has(name))) return callback(ctx)
      return undefined
    },
    webServer: {
      register({ path, handler }) {
        routes.set(path, { handler })
        return () => routes.delete(path)
      },
    },
    agents: {
      roots: () => [...agents.values()],
      get: (id) => agents.get(id),
    },
    skills: {
      async snapshot() {
        return { complete: true, skills: [] }
      },
      async get() {
        return undefined
      },
    },
    services,
    get(name) {
      return services.has(name) ? services.get(name) : ctx[name]
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
  }

  return {
    ctx,
    routes,
    agents,
    async panel(agentId) {
      const route = routes.get('/api/ui-evolve')
      if (route === undefined) throw new Error('the panel route was never registered')
      const res = {
        statusCode: undefined,
        writableEnded: false,
        once() {
          return this
        },
        writeHead(code) {
          this.statusCode = code
          return this
        },
        end(body) {
          this.writableEnded = true
          this.body = body
          return this
        },
      }
      await route.handler(
        {
          url: `/api/ui-evolve/panel?agent=${encodeURIComponent(agentId)}`,
          method: 'GET',
          headers: { host: '127.0.0.1:19387' },
        },
        res,
      )
      return JSON.parse(res.body)
    },
  }
}

// ---------------------------------------------------------------------------
// Mount one fixture as a session and ask the real route about it.
// ---------------------------------------------------------------------------

const load = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

async function mount(document, { cwd }) {
  const root = await makeTempRoot('dsse-fixture-')
  const dir = join(root, 'plugin-data', 'skill-evolve', 'sessions')
  mkdirSync(dir, { recursive: true })
  const sessionId = 'fixture-session'
  // The fixture node itself goes in, with the id the store keys on. `session` is
  // a string in the real documents, and `session-state.js` reads it as one.
  const body = { ...document, session: sessionId }
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(body))

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const host = fakeHost()
  applyPanel(host.ctx, PanelConfig({ panelSummary: false }))
  host.agents.set(sessionId, { id: sessionId, session: { id: sessionId, header: { id: sessionId, cwd } } })
  const payload = await host.panel(sessionId)
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  return { payload, root, sessionId }
}

const rowsOf = (payload) => (Array.isArray(payload?.data?.files) ? payload.data.files : [])

// A record whose spelling cannot be a file name. Copied from the guard's own
// rule rather than re-derived, so the suite asks the same question the code does.
function looksLikeShellLeftover(path) {
  if (/[>|*?]/u.test(path)) return true
  if (path.startsWith('/dev/')) return true
  const tail = path.split(/[\\/]/u).pop() ?? ''
  return /^&\d+\)*$/u.test(tail)
}

// ---------------------------------------------------------------------------
// 1. The directory that stat succeeded on
// ---------------------------------------------------------------------------

{
  const document = load('mixed-states.json')
  // The fixture's roots do not exist here, so the rows that were directories on
  // the machine they came from are now just absent paths. What is being pinned is
  // the rule, not this machine's disk: `readStat` is injected so the fixture can
  // say "this one is a directory" without anyone having to create it.
  const { payload } = await mount(document, { cwd: 'D:\\work' })
  const rows = rowsOf(payload)
  check('the fixture reaches the route', payload.ok === true, JSON.stringify(payload).slice(0, 300))
  // Not one of this fixture's six records is a document: two are directory
  // shapes, two are shell leftovers, two are source files. The panel filters by
  // the whitelist before it stats anything, so the card is handed nothing. That
  // is the new fact, and it is stated rather than left as a zero that could also
  // mean "the fixture broke".
  check('and the card is handed nothing, because none of them is a document', rows.length === 0, JSON.stringify(rows.map((row) => row.path)))

  // The four rules this fixture was built for still exist; they moved into
  // `statTouchedFiles`, which is what the panel calls with the filter on. Asking
  // that function directly is asking the same question the card asks, one layer
  // down -- and unlike `rows.every(...)` over an empty list, it cannot pass by
  // having nothing to look at.
  const { statTouchedFiles } = await import('../packages/ui-evolve/lib/api.js')
  const listed = Object.entries(document.paths).map(([path, raw]) => ({
    path,
    at: typeof raw === 'object' && raw !== null ? raw.at : undefined,
    turn: typeof raw === 'object' && raw !== null ? raw.turn : undefined,
  }))
  const statted = await statTouchedFiles({
    paths: listed,
    cwd: 'D:\\work',
    sessionId: 'fixture-session',
    turnPaths: new Set(),
    turnNow: 1,
    now: 1794720729999,
  })
  check('the rules still answer without the filter on', statted.length > 0, String(statted.length))
  check(
    'every row that survives is a status the card can draw',
    statted.every((row) => ['available', 'missing', 'invalid', 'unresolved', 'folder'].includes(row.status)),
    JSON.stringify(statted.map((row) => [row.path, row.status])),
  )

  // These roots are stand-ins, so on this machine the directories behind them do
  // not exist and `stat` fails. That is a different finding from "it was a
  // directory and we called it deleted": absent is `missing` when the spelling is
  // absolute and `unresolved` when we cannot even place it. What must never
  // happen is either of them claiming the path exists. The case that really is a
  // directory is pinned in section 2, where `readStat` is injected so the fixture
  // can say "this one is a directory" without anyone creating it on disk.
  const directoryish = statted.filter((row) => /[\\/]$/u.test(row.path) || row.path === '\\')
  check('the fixture still holds directory-looking records', directoryish.length > 0, String(directoryish.length))
  check(
    'a directory-looking record that is absent says so rather than claiming to exist',
    directoryish.every((row) => row.status === 'missing' || row.status === 'unresolved'),
    JSON.stringify(directoryish.map((row) => [row.path, row.status])),
  )

  // And the shell leftovers are not rows at all, whatever their status would be.
  const leftovers = statted.filter((row) => looksLikeShellLeftover(row.path))
  check('a record spelled like a redirection is not drawn', leftovers.length === 0, JSON.stringify(leftovers.map((row) => row.path)))
}

// ---------------------------------------------------------------------------
// 2. A directory that really is a directory
// ---------------------------------------------------------------------------

{
  // Same fixture, but this time the stat answer is supplied: one path is a
  // directory on any machine. Without the `folder` state this row would come back
  // as `missing` and the card would draw it struck through, which is the defect
  // this fixture exists for.
  const { statTouchedFiles } = await import('../packages/ui-evolve/lib/api.js')
  const listed = [
    { path: 'D:\\work\\', at: 1794720725340, turn: 1, source: undefined },
    { path: 'D:\\work\\project\\client.js', at: 1794720726841, turn: 1, source: 'git' },
    { path: 'D:\\work\\project\\gone.js', at: 1794720726841, turn: 1, source: 'git' },
  ]
  const directory = new Set(['D:\\work\\'])
  const rows = await statTouchedFiles({
    paths: listed,
    cwd: 'D:\\work',
    sessionId: 'fixture-session',
    turnPaths: new Set(),
    turnNow: 1,
    now: 1794720729999,
    readStat: (absolute) => {
      if (directory.has(absolute)) return { isFile: () => false, size: 0, mtimeMs: 0 }
      if (absolute.endsWith('gone.js')) {
        const error = new Error('not there')
        error.code = 'ENOENT'
        throw error
      }
      return { isFile: () => true, size: 12, mtimeMs: 0 }
    },
  })
  const directoryRow = rows.find((row) => row.path === 'D:\\work\\')
  check('a directory is reported as a directory', directoryRow?.status === 'folder', String(directoryRow?.status))
  check('and is not called a deleted file', directoryRow?.status !== 'missing', String(directoryRow?.status))
  check('and carries no byte count', directoryRow?.bytes === null, String(directoryRow?.bytes))
  const goneRow = rows.find((row) => row.path.endsWith('gone.js'))
  check('a file that is really gone is still missing', goneRow?.status === 'missing', String(goneRow?.status))
}

// ---------------------------------------------------------------------------
// 3. Both brackets, both spellings
// ---------------------------------------------------------------------------

{
  const document = load('relative-paths.json')
  const { payload } = await mount(document, { cwd: 'D:\\work\\project' })
  const rows = rowsOf(payload)
  check('the mixed-bracket fixture reaches the route', rows.length > 0, String(rows.length))
  // The collector word is gone. A row now says one thing about itself: whether
  // its suffix is on the delivery whitelist. The fixture mixes `.js` with `.md`,
  // so both answers must appear -- a card that called everything deliverable, or
  // nothing, would pass a test that only looked at one of them.
  const verdicts = new Set(rows.map((row) => row.deliverable))
  check('the fixture holds a file the card would show', verdicts.has(true), JSON.stringify([...verdicts]))
  // The card is never handed a file it would not show: the panel drops those
  // before statting them, so a `false` here would be a row the renderer has to
  // defend against. The two answers of the whitelist are still pinned -- on
  // `isDeliverable` directly, in `api.test.mjs`, where both sides are asserted
  // over the same table.
  check('and never a file it would not', verdicts.has(false) === false, JSON.stringify([...verdicts]))
  check(
    'every row answers the whitelist with a boolean',
    rows.every((row) => typeof row.deliverable === 'boolean'),
    JSON.stringify(rows.filter((row) => typeof row.deliverable !== 'boolean').slice(0, 3)),
  )
  check(
    'no collector word survives on a row',
    rows.every((row) => row.source === undefined),
    JSON.stringify([...new Set(rows.map((row) => row.source))]),
  )
  // A relative record has no base in the document; `readPanel` resolves it against
  // the workspace, which is the only place that knows it. Whatever comes out must
  // be an absolute path — a row still relative would be the old bug.
  const relative = rows.filter((row) => /^([A-Za-z]:[\\/]|\/|\\\\)/u.test(row.path) === false)
  check('every row the card draws is absolute', relative.length === 0, JSON.stringify(relative.map((row) => row.path).slice(0, 5)))
}

// ---------------------------------------------------------------------------
// 4. A row with no recorded time is not old
// ---------------------------------------------------------------------------

{
  const document = load('no-timestamps.json')
  const withoutTime = Object.values(document.paths).filter((entry) => typeof entry === 'object' && entry.at === undefined)
  check('the fixture still holds rows with no time', withoutTime.length > 0, String(withoutTime.length))
  const { payload } = await mount(document, { cwd: 'D:\\work' })
  const rows = rowsOf(payload)
  check('the untimed fixture reaches the route', rows.length > 0, String(rows.length))
  const untimed = rows.filter((row) => row.at === null || row.at === undefined)
  check('the untimed rows survive the read', untimed.length > 0, String(untimed.length))
  // Unknown stays unknown. There is no "old" bucket any more -- the card groups
  // by turn, which every row has -- but a row written before the field existed
  // must still come back with `at: null` rather than a time this build made up.
  // The old card did invent one, and it moved live work under a "stale" heading.
  check(
    'a row with no recorded time reports no time',
    untimed.every((row) => row.at === null || row.at === undefined),
    JSON.stringify(untimed.map((row) => [row.path, row.at]).slice(0, 5)),
  )
}

// ---------------------------------------------------------------------------
// 5. A document from before per-file records existed
// ---------------------------------------------------------------------------

{
  const document = load('v1-numbers.json')
  check('the v1 fixture is really v1', document.state === 1, String(document.state))
  check('and spells its one path as a bare number', typeof Object.values(document.paths)[0] === 'number', typeof Object.values(document.paths)[0])
  const { payload } = await mount(document, { cwd: 'D:\\work' })
  // Read, not refused: the document is well-formed and its skills, tools and
  // sequence are still worth having. What it no longer contributes is rows.
  check('a v1 document is read rather than refused', payload.ok === true, JSON.stringify(payload).slice(0, 300))
  check('and its path does not reach the card', rowsOf(payload).length === 0, JSON.stringify(rowsOf(payload).map((row) => row.path)))
}

{
  const document = load('v1-empty.json')
  const { payload } = await mount(document, { cwd: 'D:\\work' })
  check('a v1 document that remembers nothing still answers', payload.ok === true, JSON.stringify(payload).slice(0, 300))
  check('and draws no rows', rowsOf(payload).length === 0, String(rowsOf(payload).length))
}

// ---------------------------------------------------------------------------
// 6. The fixtures are what the extractor produces, not what someone typed
// ---------------------------------------------------------------------------

{
  const names = readdirSync(FIXTURES).filter((name) => name.endsWith('.json')).sort()
  check('there are fixtures to read', names.length > 0, String(names.length))
  const leaks = []
  for (const name of names) {
    const body = readFileSync(join(FIXTURES, name), 'utf8')
    // The two roots that identify the machine these came from. Both must be gone:
    // a fixture in a public repository is not the place for them.
    for (const secret of ['26903', 'dsh-plugin', 'F:\\\\dsh-plugin']) {
      if (body.includes(secret) === true) leaks.push(`${name}: ${secret}`)
    }
    check(`${name} says where it came from`, body.includes('extractedFrom') === true)
    check(`${name} says what was dropped`, body.includes('dropped') === true)
  }
  check('no fixture repeats a path from the machine it was taken from', leaks.length === 0, JSON.stringify(leaks))
  // Every fixture is one line of JSON per field with a trailing newline, which is
  // what makes the extractor's output reproducible byte for byte.
  for (const name of names) {
    const body = readFileSync(join(FIXTURES, name), 'utf8')
    check(`${name} ends with a single newline`, body.endsWith('}\n') === true && body.endsWith('}\n\n') === false)
    check(`${name} is stable JSON`, JSON.stringify(JSON.parse(body), null, 2) + '\n' === body)
  }
}

// ---------------------------------------------------------------------------
// 7. What the card would be handed
// ---------------------------------------------------------------------------

// The renderer is not exercised here. It has its own suites -- `client.test.mjs`
// for the shapes it draws and `end-to-end.test.mjs` for the one path from a real
// event to a real component tree -- and a third copy of that harness in this file
// was two hundred lines of DOM that kept failing for reasons that had nothing to
// do with fixtures. What this section pins is the payload the card is given, which
// is the part a fixture can answer and the other suites cannot: a real document,
// through the real route, with the real `readPanel`.
{
  // `relative-paths.json` rather than `mixed-states.json`: the latter holds no
  // documents at all, so it would pin this section to an empty payload. This one
  // mixes Windows and POSIX spellings and still carries four real documents.
  const document = load('relative-paths.json')
  const { payload } = await mount(document, { cwd: 'D:\\work\\project' })
  const rows = rowsOf(payload)
  const statuses = rows.map((row) => row.status)
  check('the fixture reaches the card as a payload', payload.ok === true)
  check('and carries rows for it to draw', rows.length > 0, String(rows.length))
  // The two things the card must be able to tell apart, expressed on the payload:
  // a row that is a directory says `folder`, and none of them claims to be
  // `available` when the path behind it cannot be read on any machine.
  check('every row states a status the card knows how to draw', statuses.every((status) => ['available', 'missing', 'invalid', 'unresolved', 'folder'].includes(status)), JSON.stringify(statuses))
  check('and no row is handed over without one', statuses.every((status) => typeof status === 'string' && status.length > 0), JSON.stringify(statuses))
  check('the rows carry no provenance sentence for the card to print', rows.every((row) => typeof row.source === 'string' || row.source === null || row.source === undefined), JSON.stringify(rows.map((row) => row.source)))
}

for (const path of cleaning) {
  try {
    await rm(path, { recursive: true, force: true })
  } catch {}
}

report()
process.exit(failed === 0 ? 0 : 1)
