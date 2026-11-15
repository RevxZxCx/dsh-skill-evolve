/**
 * The whole chain, end to end, with nothing faked in the middle.
 *
 * Every other file in this suite stops at a boundary. `persistence.test.mjs`
 * mounts the real host half, drives real `session/event` traffic through it and
 * reads the real `/panel` route — and then stops, because it has nothing that can
 * draw. `client.test.mjs` evaluates the real client bundle and renders the real
 * component tree — but against `panelRoutes()`, a hand-written fixture shaped
 * like a panel payload. Neither file can answer the question this one exists for:
 *
 *   does what the host actually produces, when drawn by the client, look right?
 *
 * A fixture agrees with the client by construction. It was written by the same
 * person, in the same hour, reading the same code. The production payload is
 * written by `readPanel`, which reads `SessionState`, which reads what
 * `turn/end` recorded — four modules and one filesystem round trip away from any
 * fixture. Field renames, unit changes (milliseconds against seconds), a `null`
 * where the client expects an absent key, an enum that gained a fourth member:
 * all of those survive a fixture and break a user's card.
 *
 * So this file runs the real chain once, from a mounted plugin to a rendered
 * tree:
 *
 *   applyPanel(real) -> emit session/event (real) -> state file (real)
 *     -> /panel route (real) -> readPanel (real) -> JSON envelope (real)
 *     -> client.js (real, evaluated) -> component tree
 *
 * The only stand-ins are the ones a Node process cannot have: a DOM, a React, and
 * the browser's `fetch`. Those are the same stand-ins `client.test.mjs` already
 * uses, and the point of this file is *not* to test them again.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// A crash must not read as "ran and found nothing". This is the seventh file to
// need the guard and the reason is the same each time: the mutation runner calls
// a suite KILLED when it sees a failing assertion, and a process that dies before
// printing a tally has printed no failing assertion. See DEF-122, DEF-134,
// DEF-139, DEF-145, DEF-146, DEF-149.
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

const tempRoots = []
process.on('exit', () => {
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A leftover directory is better than hiding the failure that explains the run.
    }
  }
})

async function makeTempRoot(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

console.log('end-to-end — the host writes it, the client draws it')

// ---------------------------------------------------------------------------
// A host, mounted for real
// ---------------------------------------------------------------------------

/**
 * The surface the panel touches, and nothing else.
 *
 * Shaped from `persistence.test.mjs`, deliberately not copied wholesale: a
 * fixture that provides everything cannot show a missing method, and the point
 * of mounting the real host half is that it decides what it needs.
 */
function fakeHost() {
  const handlers = new Map()
  const routes = new Map()
  const agents = new Map()
  const services = new Map()
  const logs = []

  const ctx = {
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line) },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const at = handlers.get(event)?.indexOf(handler) ?? -1
        if (at >= 0) handlers.get(event).splice(at, 1)
      }
    },
    effect(register) {
      const result = register()
      return result
    },
    inject(names, callback) {
      if (names.every((name) => ctx[name] !== undefined || services.has(name))) return callback(ctx)
      return undefined
    },
    webServer: {
      register({ kind, path, handler }) {
        routes.set(path, { kind, handler })
        return () => routes.delete(path)
      },
    },
    agents: {
      roots: () => [...agents.values()],
      get: (id) => agents.get(id),
    },
    skills: {
      async snapshot() {
        return {
          complete: true,
          skills: [
            { name: 'alpha', description: 'the first', invocation: { modelInvocable: true, userInvocable: true } },
            { name: 'beta', description: 'the second', invocation: { modelInvocable: true, userInvocable: true } },
          ],
        }
      },
      async get(name) {
        return { name, description: name, content: 'body' }
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
    handlers,
    routes,
    agents,
    logs,
    emit(event, ...payload) {
      for (const handler of handlers.get(event) ?? []) handler(...payload)
    },
    /**
     * Ask the real route for one session's panel, the way the browser does.
     *
     * The response object is a stub because there is no socket here; everything
     * between the URL and the JSON body is the production path, including origin
     * checking, `readPanel`, the filesystem, and the envelope.
     */
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

/**
 * Wait until the turn's collectors have written their answer down.
 *
 * The sweep is deliberately not awaited by the plugin (a `git status` must not
 * hold up the turn that just ended), so it lands after `turn/end` returns. The
 * file appears first and the sweep is filled in second, so both have to be seen.
 *
 * @param {string} path - the session state file.
 * @returns {Promise<void>} resolves once a sweep with a coverage is recorded.
 */
async function waitForSweep(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (existsSync(path) === false) continue
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof stored?.sweep?.coverage === 'string' && stored.sweep.coverage !== '') return
  }
}

function fakeSession(id, cwd) {
  return { id, session: { id, header: { id, cwd, version: 4, createdAt: Date.now(), isSeeded: false } } }
}

/**
 * One finished turn that wrote files, through the real event stream.
 *
 * The paths are absolute and inside `cwd`, because that is what the host's tools
 * record once `writtenPaths` is given a base — and a relative path here would
 * exercise the `unresolved` branch instead of the main one.
 *
 * @param {object} host - the mounted host.
 * @param {object} session - the session record.
 * @param {object} options - what the turn did.
 */
function turn(host, session, { edits = [], turnNumber = 1, said = 'did the work' } = {}) {
  const base = turnNumber * 100
  host.emit('session/event', session.session, {
    type: 'turn/start',
    seq: base - 1,
    time: Date.now(),
    data: { turn: turnNumber },
  })
  host.emit('session/event', session.session, {
    type: 'user/message',
    seq: base,
    time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] },
  })
  let step = 1
  for (const path of edits) {
    host.emit('session/event', session.session, {
      type: 'tool/call',
      seq: base + step,
      time: Date.now(),
      data: { turn: turnNumber, step, callId: `c-edit-${turnNumber}-${step}`, name: 'edit', arguments: JSON.stringify({ path }) },
    })
    step += 1
  }
  host.emit('session/event', session.session, {
    type: 'assistant/message',
    seq: base + step,
    time: Date.now(),
    data: { message: { role: 'assistant', content: [{ type: 'text', text: said }] } },
  })
  host.emit('session/event', session.session, {
    type: 'turn/end',
    seq: base + step + 1,
    time: Date.now(),
    data: { turn: turnNumber, reason: { kind: 'completed' } },
  })
}

// ---------------------------------------------------------------------------
// The client, evaluated for real
// ---------------------------------------------------------------------------

/**
 * Evaluate the real `client.js` under a DOM and a React, and give back a tree.
 *
 * This is `client.test.mjs`'s harness reduced to what a chain test needs: no
 * measurement, no layout, no window geometry. The panel's cards do not measure
 * anything to decide what to draw — that is `gutter.js` and the toggle — so a
 * renderer without geometry is honest here.
 */
function bootClient(routes) {
  let captured
  const requests = []
  const listeners = []

  const windowStub = {
    __ModuleLoader__: {
      load(entry) {
        captured = entry
      },
    },
    addEventListener(type, handler) {
      listeners.push({ type, handler })
    },
    removeEventListener() {},
  }

  const hostStyle = new Map()
  const rect = { left: 280, top: 120, right: 1920, bottom: 420, width: 1640, height: 300 }
  const conversation = {
    // No `ref` resolution in this harness, so the overlay measures with a null
    // host and uses the conversation rect as its origin -- the path `measure`
    // documents for a wrapper spanning the overlay with inset 0.
    getBoundingClientRect: () => ({ ...rect }),
    offsetWidth: rect.width,
    getAttribute: (name) => (name === 'data-content-phase' ? 'active' : null),
    querySelector: () => null,
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

  // The production client talks to the real listener; here the "network" is the
  // JSON body the real route just produced, wrapped in the same envelope the
  // client already parses. Nothing about the payload is edited on the way in.
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

  const timers = []
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
    (fn, ms) => {
      const handle = setInterval(fn, ms)
      timers.push({ fn, ms, handle, cleared: false })
      return handle
    },
    (handle) => {
      const row = timers.find((entry) => entry.handle === handle)
      if (row !== undefined) row.cleared = true
      clearInterval(handle)
    },
    (fn, ms) => {
      const handle = setTimeout(fn, ms)
      timers.push({ fn, ms, handle, cleared: false })
      return handle
    },
    (handle) => {
      const row = timers.find((entry) => entry.handle === handle)
      if (row !== undefined) row.cleared = true
      clearTimeout(handle)
    },
    class {
      constructor(callback) {
        this.callback = callback
      }
      observe() {}
      disconnect() {}
    },
    Date,
  )

  const react = makeReact()
  const module = captured.factory(createModuleTable(requests, react))
  return { module, requests, react }
}

/**
 * The shared module table the client's `require` resolves against.
 *
 * The React here re-renders and tracks hooks; it does not paint. Everything the
 * card needs from React is a function component, `useState`, `useEffect` and
 * `useRef`, and the builder below provides exactly those.
 */
function createModuleTable(requests, react) {
  return function require(id) {
    requests.push(id)
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return { jsx: makeElement, jsxs: makeElement, Fragment: 'Fragment' }
    throw new Error(`the bundle required "${id}", which the shared module table does not carry`)
  }
}

function makeElement(type, props, key) {
  return { $$typeof: Symbol.for('react.element'), type, props: props ?? {}, key: key ?? null }
}

/**
 * Enough React to render the cards: hooks per component, effects that run, and
 * a stable element shape.
 */
function makeReact() {
  const buckets = new WeakMap()
  const pendingEffects = []
  let hookIndex = 0

  function bucketFor(Component) {
    if (typeof Component !== 'function') throw new Error('this harness can only render function components')
    let bucket = buckets.get(Component)
    if (bucket === undefined) {
      bucket = { slots: new Map(), deps: new Map() }
      buckets.set(Component, bucket)
    }
    return bucket
  }

  let slots = new Map()
  let deps = new Map()
  let settled = false

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
      pendingEffects.push(() => {
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
      return makeElement(type, props === null ? {} : { ...props, children: children.length === 0 ? props?.children : children })
    },
    cloneElement(node, props) {
      return { ...node, props: { ...node.props, ...props } }
    },
    isValidElement(value) {
      return typeof value === 'object' && value !== null && value.$$typeof === Symbol.for('react.element')
    },
  }

  /**
   * Render a component until it stops asking to re-render, then resolve the tree.
   */
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
      while (pendingEffects.length > 0) {
        const run = pendingEffects.shift()
        run()
      }
      // Let the fetches this round started resolve before deciding to stop. A
      // card is empty until its payload lands, so stopping here would capture
      // the loading state and call it the answer.
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
      if (settled === false && pendingEffects.length === 0) break
    }
    slots = outerSlots
    deps = outerDeps
    return expand(tree)
  }

  /**
   * Replace every `{ type: fn }` node with what it renders, depth first.
   */
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

  return {
    ...hooks,
    useState: hooks.useState,
    useEffect: hooks.useEffect,
    useLayoutEffect: hooks.useLayoutEffect,
    useMemo: hooks.useMemo,
    useCallback: hooks.useCallback,
    useRef: hooks.useRef,
    createElement: hooks.createElement,
    cloneElement: hooks.cloneElement,
    isValidElement: hooks.isValidElement,
    __render: render,
    __expand: expand,
  }
}

/**
 * Walk a rendered tree for nodes carrying a class.
 */
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

/** All the text inside a node, in document order. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}

/**
 * Mount the client and open the panel, the way the real page does.
 *
 * `apply` registers the two slots; the toggle has to be clicked because the
 * cards poll only while the panel is open — a card tree rendered without the
 * click would be the closed state, which draws nothing.
 */
async function openPanel(routes, sessionId) {
  const { module, requests, react } = bootClient(routes)
  const registrations = []
  const opened = []
  const ctx = {
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
  }
  module.apply(ctx)
  const toggle = registrations.find((row) => row.spec.id.endsWith(':toggle'))
  const cards = registrations.find((row) => row.spec.id.endsWith(':cards'))
  if (toggle === undefined || cards === undefined) throw new Error('the bundle did not register both seats')
  const toggleTree = await react.__render(toggle.Component, { sessionId })
  const button = firstByClass(toggleTree, 'dsse-toggle')
  if (button === undefined || typeof button.props?.onClick !== 'function') {
    throw new Error('the toggle rendered no clickable button')
  }
  button.props.onClick()
  const tree = await react.__render(cards.Component, {})
  return { tree, requests, registrations, opened }
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

{
  const root = await makeTempRoot('dsse-e2e-')
  process.env.DSH_HOME = root

  const host = fakeHost()
  applyPanel(host.ctx, PanelConfig({ panelSummary: false }))
  check('the mounted host registered the panel route', host.routes.has('/api/ui-evolve') === true)

  // A workspace on disk, so every row can be stat'd for real. Rows are what the
  // card is; a payload whose paths do not exist would exercise the deleted-row
  // branch and prove nothing about the normal one.
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(join(workspace, 'test'), { recursive: true })
  const written = [
    join(workspace, 'src', 'alpha.js'),
    join(workspace, 'src', 'beta.js'),
    join(workspace, 'test', 'alpha.test.js'),
  ]
  for (const path of written) await writeFile(path, 'export const x = 1\n', 'utf8')

  const session = fakeSession('session-e2e', workspace)
  host.agents.set(session.id, session)
  turn(host, session, { edits: written })

  const statePath = join(root, 'plugin-data', 'skill-evolve', 'sessions', `${session.id}.json`)
  await waitForSweep(statePath)
  const payload = await host.panel(session.id)
  check('the real route answers in the envelope the client parses', payload.ok === true, JSON.stringify(payload).slice(0, 200))
  check('and names the session', payload.data?.agent === session.id, String(payload.data?.agent))
  check('and sends the workspace the rows are relative to', typeof payload.data?.cwd === 'string' && payload.data.cwd.length > 0, String(payload.data?.cwd))

  // The three rows the host actually produced. If this is empty, everything
  // below fails for one reason and it is worth seeing that first.
  const files = Array.isArray(payload.data?.files) ? payload.data.files : []
  check('the turn it wrote produced rows', files.length === 3, JSON.stringify(files.map((row) => row.path)))
  check(
    'every row is a real file it can stat',
    files.every((row) => row.status === 'available'),
    JSON.stringify(files.map((row) => [row.path, row.status])),
  )
  check(
    'every row carries an absolute path',
    files.every((row) => /^[A-Za-z]:[\\/]|^\//u.test(String(row.path))),
    JSON.stringify(files.map((row) => row.path)),
  )
  check(
    'every row carries a byte count it read from disk',
    files.every((row) => typeof row.bytes === 'number' && row.bytes > 0),
    JSON.stringify(files.map((row) => row.bytes)),
  )

  // Now draw it. This is the step no other file takes: the payload above goes
  // into the real client with nothing rewritten.
  const routes = {
    '/api/ui-evolve/panel': payload,
    '/api/ui-evolve/config': { ok: true, data: { panelSummary: false, panelSide: 'left', panelCollapsed: false } },
    '/api/ui-evolve/models': { ok: true, data: { providers: [] } },
    '/api/ui-evolve/candidates': { ok: true, data: { candidates: [] } },
  }
  const { tree, requests, opened } = await openPanel(routes, session.id)

  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  check('the client draws the output card from the real payload', card !== undefined, textOf(tree).slice(0, 200))

  const rows = byClass(card, 'dsse-row')
  check('with one row per file the host reported', rows.length === 3, String(rows.length))

  const names = byClass(card, 'dsse-name').map(textOf)
  check('named as the files are named', names.includes('alpha.js') && names.includes('beta.js') && names.includes('alpha.test.js'), JSON.stringify(names))

  // The header arithmetic is the one place a real payload can disagree with a
  // fixture: the counts come from three different filters over the same list.
  // Both collectors ran, so the card owes the reader no caveat. A `none` or
  // `partial` here means the chain lost the turn's start or its sweep, which is
  // exactly what a hand-written fixture could never show.
  const sweepNote = firstByClass(card, 'dsse-note')
  check(
    'the card does not apologise for a sweep that ran',
    sweepNote === undefined || textOf(sweepNote).includes('没有检查') === false,
    textOf(sweepNote),
  )

  const head = textOf(firstByClass(card, 'dsse-head-stats'))
  check('the header counts the files a person wrote', head.includes('3 个文件'), head)
  check('and there is no quiet remainder when nothing was generated', firstByClass(card, 'dsse-head-note') === undefined, textOf(firstByClass(card, 'dsse-head-note')))

  // Rows are openable because the host sent an address for a file that exists.
  // A fixture supplies that string itself; here it came from the resource
  // resolver, so a broken resolver shows up as three dead rows.
  check(
    'every row is openable, because the host resolved an address for it',
    rows.every((row) => firstByClass(row, 'dsse-row-open') !== undefined),
    JSON.stringify(rows.map((row) => row.props?.['data-status'])),
  )
  check('and none of them claims to be deleted', rows.every((row) => row.props?.['data-status'] === 'available'), JSON.stringify(rows.map((row) => row.props?.['data-status'])))

  // No provenance sentence, which is the change this whole round was about: the
  // attribute stays, the sentence does not. A real payload is where a leaked
  // sentence would show, because `source` is populated by the collectors and a
  // fixture often is not.
  const titles = rows.map((row) => String(row.props?.title ?? ''))
  check('no row says where it came from', titles.every((title) => title.includes('差分') === false && title.includes('扫描') === false), JSON.stringify(titles))
  check('and the bracket is still an attribute', rows.every((row) => ['git', 'scan', 'unknown'].includes(row.props?.['data-source'])), JSON.stringify(rows.map((row) => row.props?.['data-source'])))
}

report()
process.exit(failed === 0 ? 0 : 1)
