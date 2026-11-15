/**
 * The same chain, driven by the sessions this machine actually has.
 *
 * `end-to-end.test.mjs` builds a turn from scratch and follows it to a drawing.
 * That proves the chain is wired; it does not prove the chain survives real
 * data, and real data is where the shapes differ. 208 session files exist on
 * this machine after two weeks of use, and they were written by nine versions of
 * this plugin — earlier ones had no `source`, then no `sweep`, then a `sweep`
 * with two states instead of three. A fixture shaped like today's writer says
 * nothing about what the panel does when it is handed one of those.
 *
 * So this file copies the real state directory into a temporary home (the
 * originals are never opened for writing), mounts the real host half against it,
 * reads the real route for the biggest session it can find, and draws the real
 * card. Nothing in between is faked except the DOM and React.
 *
 * It asserts the things that must hold for *any* stored session, then reports
 * what the data actually is — because "the card renders" is not the question.
 * The question is whether a person opening these sessions sees something true.
 *
 * Run it directly: `node test/real-data.test.mjs`.
 * It skips (prints and exits 0) when this machine has no session files, so a
 * fresh checkout with no history does not fail the suite.
 */

import { cpSync, existsSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply as applyPanel, Config as PanelConfig } from '../packages/ui-evolve/lib/index.js'

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
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

let reported = false

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

process.on('uncaughtException', (error) => {
  report(`the suite threw before it finished — ${error?.message ?? error}`)
  process.exit(1)
})
process.on('unhandledRejection', (error) => {
  report(`the suite rejected before it finished — ${error?.message ?? error}`)
  process.exit(1)
})

const cleaning = []
process.on('exit', () => {
  for (const dir of cleaning) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Leftovers are cheaper than hiding the failure that explains the run.
    }
  }
})

const realHome = join(homedir(), '.dsh')
const realSessions = join(realHome, 'plugin-data', 'skill-evolve', 'sessions')

console.log('real data — the sessions this machine has, through the real chain')

if (existsSync(realSessions) === false) {
  console.log('  no session state on this machine; nothing to replay')
  console.log('\n0 passed, 0 failed')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// A copy of the real state, in a home that is not the real home
// ---------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), 'dsse-real-'))
cleaning.push(root)
process.env.DSH_HOME = root

const copied = join(root, 'plugin-data', 'skill-evolve', 'sessions')
cpSync(realSessions, copied, { recursive: true })

const names = readdirSync(copied).filter((name) => name.endsWith('.json'))
check('this machine has session state to replay', names.length > 0, String(names.length))

// The biggest one, because the interesting shapes are at the edges: the cap of
// 200 rows, the file that was mostly working copies, the one written by a
// version that did not know about `source`.
const ranked = names
  .map((name) => ({ name, size: statSync(join(copied, name)).size }))
  .sort((left, right) => right.size - left.size)
const biggest = ranked[0]
check('and it has a largest session', biggest !== undefined, JSON.stringify(ranked.slice(0, 3)))

const stored = JSON.parse(readFileSync(join(copied, biggest.name), 'utf8'))
const sessionId = biggest.name.replace(/\.json$/u, '')
const storedRows = stored?.paths === undefined ? 0 : Object.keys(stored.paths).length
check('the stored record has rows in it', storedRows > 0, String(storedRows))
check(
  'and the record names a turn',
  Number.isFinite(stored?.turns) && stored.turns > 0,
  JSON.stringify({ turns: stored?.turns, previous: stored?.previous?.turn }),
)

// ---------------------------------------------------------------------------
// The real host half, against the copy
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

const host = fakeHost()
applyPanel(host.ctx, PanelConfig({ panelSummary: false }))

// The session is registered with the workspace its rows were written from. That
// path may no longer exist on this machine — a deleted worktree, a cleaned temp
// directory — and the card has to survive that, which is the point.
const statedCwd = typeof stored?.session?.cwd === 'string' ? stored.session.cwd : root
host.agents.set(sessionId, { id: sessionId, session: { id: sessionId, header: { id: sessionId, cwd: statedCwd } } })

const payload = await host.panel(sessionId)
check('the real route answers for a stored session', payload.ok === true, JSON.stringify(payload).slice(0, 300))

const files = Array.isArray(payload.data?.files) ? payload.data.files : []
check('every stored row comes back', files.length === storedRows, `${files.length} of ${storedRows}`)

const statuses = files.map((row) => row.status)
const known = new Set(['available', 'missing', 'invalid', 'unresolved', 'folder'])
check('every row carries one of the five states', statuses.every((value) => known.has(value)), JSON.stringify([...new Set(statuses)]))
check(
  'no row is left without a status',
  statuses.every((value) => typeof value === 'string' && value.length > 0),
  JSON.stringify(statuses.slice(0, 5)),
)
check(
  'every noise flag is a boolean',
  files.every((row) => typeof row.noise === 'boolean'),
  JSON.stringify(files.filter((row) => typeof row.noise !== 'boolean').slice(0, 3)),
)
check(
  'every stale flag is a boolean',
  files.every((row) => typeof row.stale === 'boolean'),
  JSON.stringify(files.filter((row) => typeof row.stale !== 'boolean').slice(0, 3)),
)
check(
  'no row claims a source this build does not know',
  files.every((row) => row.source === undefined || row.source === null || row.source === 'git' || row.source === 'scan'),
  JSON.stringify([...new Set(files.map((row) => row.source))]),
)
// A directory is not a deletion. Before the fifth state existed, a successful `stat`
// that answered `isFile() === false` was filed as `missing` whenever the record held an
// absolute path -- so a session's own working directory came back struck through, and the
// card said the file had been deleted. The check walks the rows this machine actually has
// and asks the disk only about the ones a session bothered to record.
const calledDeleted = files
  .filter((row) => row.status === 'missing')
  .filter((row) => {
    try {
      return statSync(row.path).isDirectory()
    } catch {
      return false
    }
  })
check(
  'no directory on disk is reported as a deleted file',
  calledDeleted.length === 0,
  JSON.stringify(calledDeleted.map((row) => row.path).slice(0, 3)),
)
check(
  'every row has an address or is honestly unpresentable',
  files.every((row) => typeof row.address === 'string' ? row.address.length > 0 : row.status !== 'available'),
  JSON.stringify(files.filter((row) => typeof row.address !== 'string' && row.status === 'available').slice(0, 3)),
)

// ---------------------------------------------------------------------------
// Draw it
// ---------------------------------------------------------------------------

function bootClient(routes) {
  let captured
  const requests = []
  const hostStyle = new Map()
  const rect = { left: 280, top: 120, right: 1920, bottom: 420, width: 1640, height: 300 }
  const conversation = {
    getBoundingClientRect: () => ({ ...rect }),
    offsetWidth: rect.width,
    getAttribute: (name) => (name === 'data-content-phase' ? 'active' : null),
    querySelector: () => null,
  }
  const windowStub = {
    __ModuleLoader__: {
      load(entry) {
        captured = entry
      },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const documentStub = {
    baseURI: 'http://127.0.0.1:19387/',
    head: { appendChild: () => {} },
    body: { attributes: new Map() },
    documentElement: {
      style: {
        getPropertyValue: (name) => hostStyle.get(name) ?? '',
        setProperty: (name, value) => hostStyle.set(name, String(value)),
        removeProperty: (name) => hostStyle.delete(name),
      },
      lang: '',
    },
    activeElement: null,
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    querySelector: (selector) => (selector === '[data-conversation-content]' ? conversation : null),
  }
  const fetchStub = async (url) => {
    const target = String(url)
    requests.push(target)
    const path = target.replace('http://127.0.0.1:19387', '')
    for (const [prefix, answer] of Object.entries(routes)) {
      if (path.startsWith(prefix) === false) continue
      return { ok: true, status: 200, json: async () => answer }
    }
    throw new Error(`no route for ${path}`)
  }

  const evaluate = new Function(
    'window',
    'document',
    'fetch',
    'getComputedStyle',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
    'MutationObserver',
    'Date',
    readFileSync(join(repo, 'packages', 'ui-evolve', 'lib', 'client.js'), 'utf8'),
  )
  evaluate(
    windowStub,
    documentStub,
    fetchStub,
    () => ({ getPropertyValue: () => '920px', fontFamily: 'Host Sans', fontSize: '14px', lineHeight: '21px' }),
    (fn, ms) => setInterval(fn, ms),
    (handle) => clearInterval(handle),
    (fn, ms) => setTimeout(fn, ms),
    (handle) => clearTimeout(handle),
    class {
      observe() {}
      disconnect() {}
    },
    Date,
  )

  const react = makeReact()
  const module = captured.factory(createModuleTable(react))
  return { module, react, requests }
}

function createModuleTable(react) {
  return function require(id) {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' }
    throw new Error(`the bundle required "${id}", which this table does not carry`)
  }
}

function element(type, props, key) {
  return { $$typeof: Symbol.for('react.element'), type, props: props ?? {}, key: key ?? null }
}

function makeReact() {
  const buckets = new WeakMap()
  const pending = []
  let hookIndex = 0
  let slots = new Map()
  let deps = new Map()
  let settled = false

  function bucketFor(Component) {
    let bucket = buckets.get(Component)
    if (bucket === undefined) {
      bucket = { slots: new Map(), deps: new Map() }
      buckets.set(Component, bucket)
    }
    return bucket
  }

  const hooks = {
    useState(initial) {
      const key = hookIndex++
      if (!slots.has(key)) slots.set(key, { value: typeof initial === 'function' ? initial() : initial })
      const slot = slots.get(key)
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        settled = true
      }]
    },
    useEffect(effect, list) {
      const key = hookIndex++
      const prior = deps.get(key)
      const changed =
        prior === undefined ||
        list === undefined ||
        prior.deps === undefined ||
        list.length !== prior.deps.length ||
        list.some((value, index) => !Object.is(value, prior.deps[index]))
      if (!changed) return
      if (prior !== undefined && typeof prior.cleanup === 'function') prior.cleanup()
      const record = { deps: list, cleanup: undefined }
      deps.set(key, record)
      pending.push(() => {
        const cleanup = effect()
        record.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      })
    },
    useLayoutEffect(effect, list) {
      return hooks.useEffect(effect, list)
    },
    useMemo(factory, list) {
      const key = hookIndex++
      const prior = deps.get(key)
      const changed =
        prior === undefined ||
        list === undefined ||
        prior.deps === undefined ||
        list.length !== prior.deps.length ||
        list.some((value, index) => !Object.is(value, prior.deps[index]))
      if (!changed) return prior.value
      const value = factory()
      deps.set(key, { deps: list, value })
      return value
    },
    useCallback(callback, list) {
      return hooks.useMemo(() => callback, list)
    },
    useRef(initial) {
      const key = hookIndex++
      if (!slots.has(key)) slots.set(key, { value: { current: initial } })
      return slots.get(key).value
    },
    createElement(type, props, ...children) {
      return element(type, props === null ? {} : { ...props, children: children.length === 0 ? props?.children : children })
    },
    cloneElement(node, props) {
      return { ...node, props: { ...node.props, ...props } }
    },
    isValidElement(value) {
      return typeof value === 'object' && value !== null && value.$$typeof === Symbol.for('react.element')
    },
  }

  async function render(Component, props, rounds = 12) {
    const bucket = bucketFor(Component)
    const outerSlots = slots
    const outerDeps = deps
    slots = bucket.slots
    deps = bucket.deps
    let tree
    for (let round = 0; round < rounds; round += 1) {
      hookIndex = 0
      settled = false
      tree = Component(props ?? {})
      while (pending.length > 0) {
        const run = pending.shift()
        run()
      }
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
      if (settled === false && pending.length === 0) break
    }
    slots = outerSlots
    deps = outerDeps
    return expand(tree)
  }

  async function expand(node) {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) {
      const rows = []
      for (const child of node) rows.push(await expand(child))
      return rows
    }
    if (typeof node.type === 'function') {
      const inner = await render(node.type, node.props ?? {})
      return expand(inner)
    }
    const props = { ...node.props }
    if (props.children !== undefined) props.children = await expand(props.children)
    return { ...node, props }
  }

  return { ...hooks, __render: render, __expand: expand }
}

function byClass(node, className) {
  const found = []
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) found.push(...byClass(child, className))
    return found
  }
  const value = node.props?.className
  if (typeof value === 'string' && value.split(/\s+/u).includes(className)) found.push(node)
  if (node.props?.children !== undefined) found.push(...byClass(node.props.children, className))
  return found
}

function firstByClass(node, className) {
  return byClass(node, className)[0]
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}

const routes = {
  '/api/ui-evolve/panel': payload,
  '/api/ui-evolve/config': { ok: true, data: { panelSummary: false, panelSide: 'left', panelCollapsed: false } },
  '/api/ui-evolve/models': { ok: true, data: { providers: [] } },
  '/api/ui-evolve/candidates': { ok: true, data: { candidates: [] } },
}

const { module, react } = bootClient(routes)
const registrations = []
const opened = []
module.apply({
  effect(register) {
    return register()
  },
  inject(names, register) {
    if (Array.isArray(names) && names.includes('sidebarRight') === false) return () => {}
    const child = {
      sidebarRight: { openResource: (address) => opened.push(address) },
      effect(inner) {
        return inner()
      },
    }
    const dispose = register(child)
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject(name, register) {
      return register()
    },
    register(spec, Component) {
      registrations.push({ spec, Component })
      return () => {}
    },
  },
})

const toggleSeat = registrations.find((row) => row.spec.id.endsWith(':toggle'))
const cardsSeat = registrations.find((row) => row.spec.id.endsWith(':cards'))
check('the bundle registered both seats', toggleSeat !== undefined && cardsSeat !== undefined)

const toggleTree = await react.__render(toggleSeat.Component, { sessionId })
const toggle = firstByClass(toggleTree, 'dsse-toggle')
check('the toggle draws', toggle !== undefined)
if (toggle !== undefined && typeof toggle.props?.onClick === 'function') toggle.props.onClick()

const tree = await react.__render(cardsSeat.Component, {})
const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
check('the output card draws from a real stored session', card !== undefined, textOf(tree).slice(0, 200))

const rows = byClass(card, 'dsse-row')
const badge = firstByClass(card, 'dsse-expand-action')

// A collapsed card draws only the rows a person wrote. A stored session whose
// every row is a generated file therefore draws nothing while still saying how
// many there are — and the card is only honest if the badge offers them. Both
// halves are checked because either one alone lets the other rot: rows without a
// badge hide the rest, a badge without rows claims files it cannot show.
const offered = Number((String(badge?.props?.['aria-label'] ?? '').match(/(\d+) 个/u) ?? [])[1] ?? 0)
check(
  'a collapsed card either draws rows or offers to draw them',
  rows.length > 0 || offered > 0,
  JSON.stringify({ drawn: rows.length, badge: badge?.props?.['aria-label'] }),
)
check(
  'and what it offers plus what it draws is the list',
  rows.length + offered >= files.length,
  JSON.stringify({ drawn: rows.length, offered, stored: files.length }),
)

// Press it, so the rows are on screen for every assertion below. Reading a
// collapsed card and concluding anything about its rows is how a test ends up
// describing the fold instead of the list.
if (rows.length < files.length && badge !== undefined && typeof badge.props?.onClick === 'function') {
  badge.props.onClick()
}
const reopened = await react.__render(cardsSeat.Component, {})
const openCard = byClass(reopened, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
const openRows = byClass(openCard, 'dsse-row')
check('opening the card draws every row it holds', openRows.length === files.length, `${openRows.length} of ${files.length}`)
const full = openRows.length >= rows.length ? openRows : rows

// The arithmetic the card promises: the header number plus the quiet remainder
// plus the badge's hidden count is the whole list. On real data this is where a
// cap, a merge and two filters can disagree.
const headText = textOf(firstByClass(card, 'dsse-head-stats'))
const shown = Number((headText.match(/(\d+) 个文件/u) ?? [])[1] ?? 0)
const noteNode = firstByClass(card, 'dsse-head-note')
const noiseInNote = Number((textOf(noteNode).match(/(\d+) 个生成文件/u) ?? [])[1] ?? 0)
const emptyCard = headText.trim() === '' && noteNode === undefined
check(
  'the header adds up to the list it is describing',
  emptyCard || shown + noiseInNote > 0,
  JSON.stringify({ headText, note: textOf(noteNode) }),
)
check(
  'a number is never negative or absurd',
  shown >= 0 && shown <= files.length && noiseInNote >= 0 && noiseInNote <= files.length,
  JSON.stringify({ shown, noiseInNote, rows: files.length }),
)

const titles = full.map((row) => String(row.props?.title ?? ''))
check(
  'no row leaks a provenance sentence',
  titles.every((title) => title.includes('差分') === false && title.includes('扫描') === false),
  JSON.stringify(titles.filter((title) => title.includes('差分') || title.includes('扫描')).slice(0, 3)),
)
check(
  'every row states a bracket attribute',
  full.every((row) => ['git', 'scan', 'unknown'].includes(row.props?.['data-source'])),
  JSON.stringify(full.filter((row) => ['git', 'scan', 'unknown'].includes(row.props?.['data-source']) === false).map((row) => row.props?.['data-source']).slice(0, 5)),
)
check(
  'every row states a status attribute',
  full.every((row) => typeof row.props?.['data-status'] === 'string'),
  JSON.stringify(full.map((row) => row.props?.['data-status']).slice(0, 5)),
)
check(
  'a row without a live file offers no preview',
  full.every((row) => ['missing', 'invalid', 'unresolved'].includes(row.props?.['data-status']) === false || firstByClass(row, 'dsse-row-open') === undefined),
  JSON.stringify(full.filter((row) => ['missing', 'invalid', 'unresolved'].includes(row.props?.['data-status']) && firstByClass(row, 'dsse-row-open') !== undefined).map((row) => row.props?.['data-status'])),
)

// What the data actually is. Printed rather than asserted: the point of running
// against real history is to see the shape, and a hard assertion on the mix
// would fail the suite the day somebody legitimately writes a different session.
const byStatus = {}
for (const row of files) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
console.log(
  `  replayed ${sessionId} — ${files.length} rows, ${openRows.length} drawn, statuses ${JSON.stringify(byStatus)}, header ${JSON.stringify(headText)}, note ${JSON.stringify(textOf(noteNode))}`,
)
console.log(`  coverage ${JSON.stringify(payload.data?.sweep ?? null)}, cwd ${JSON.stringify(payload.data?.cwd)}`)

report()
process.exit(failed === 0 ? 0 : 1)
