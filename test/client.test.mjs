/**
 * Tests for the client half.
 *
 * The client bundle is not a module the host imports — it is a script the
 * browser evaluates, which registers two slots through `window.__ModuleLoader__`.
 * Node cannot evaluate it as ESM, and the component tree it produces is made by
 * the host's own React. So this file runs the real bundle body under a fake
 * loader, with a React stand-in that actually re-renders, a fake DOM that answers
 * the one measurement the cards need, and a `fetch` that returns the plugin's own
 * envelopes.
 *
 * What that cannot cover: whether the styles read well, whether the host's React
 * accepts the element shapes, whether the geometry lines up on a real window.
 * Those are browser facts. What it does cover is everything that fails silently:
 * a component that throws on an empty payload, a slot name the host does not
 * publish, a `require` the shared table does not carry, a response whose envelope
 * is unwrapped wrongly, a switch that looks saved but never posts.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { placeCards, PANEL_WIDTH, DETAIL_WIDTH } from '../lib/gutter.js'

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

/**
 * Element stub for the jsx runtime.
 *
 * @param {any} type - the element type.
 * @param {object} [props] - its props.
 * @returns {object} a plain object a test can walk.
 */
function element(type, props) {
  const component = typeof type === 'function' ? type : undefined
  return {
    // React identifies elements by this marker, not by their shape. Carrying it
    // lets `isValidElement` below make the same judgement the real runtime does
    // instead of accepting anything that happens to have `type` and `props`.
    $$typeof: Symbol.for('react.element'),
    type: component === undefined ? type : component.name || 'anonymous',
    component,
    props: props ?? {},
  }
}

/**
 * The fake DOM node a ref resolves to.
 *
 * Only the overlay wrapper carries a ref, and the only thing read off it is
 * `getBoundingClientRect`. Returning a node that spans the frame is what makes
 * the coordinate conversion in `measure` testable at all — without it the
 * harness exercised the zero-origin fallback on every assertion.
 *
 * @param {{ left: number, top: number, width: number, height: number }} frame - the overlay's rect.
 * @returns {object} the node.
 */
function fakeNode(frame) {
  // `contains` is part of the real node's surface that the bundle actually uses:
  // a focus move that stays inside the card must not close it. Without it here,
  // every `onBlur` took the "focus left" branch no matter where focus went, which
  // made the behaviour untestable rather than merely untested.
  const inside = frame.contains ?? []
  return {
    getBoundingClientRect: () => ({ left: frame.left, top: frame.top, right: frame.left + frame.width, bottom: frame.top + frame.height, width: frame.width, height: frame.height }),
    offsetWidth: frame.width,
    contains: (node) => inside.includes(node),
  }
}

/**
 * Walk a tree, calling `visit` on every element node.
 *
 * @param {any} node - the root.
 * @param {(node: any) => void} visit - the callback.
 */
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}

/**
 * Collect the text of every string child in a tree.
 *
 * @param {any} node - the root.
 * @returns {string} all text joined.
 */
function textOf(node) {
  const out = []
  walk(node, (row) => {
    const children = row.props?.children
    for (const child of Array.isArray(children) ? children : [children]) {
      if (typeof child === 'string' || typeof child === 'number') out.push(String(child))
    }
  })
  return out.join(' ')
}

/**
 * All nodes whose `className` contains the given class.
 *
 * @param {any} node - the root.
 * @param {string} className - the class to look for.
 * @returns {object[]} the matches.
 */
function byClass(node, className) {
  const out = []
  walk(node, (row) => {
    const value = row.props?.className
    if (typeof value === 'string' && value.split(/\s+/).includes(className)) out.push(row)
  })
  return out
}

/**
 * The first node whose `className` contains the given class.
 *
 * @param {any} node - the root.
 * @param {string} className - the class to look for.
 * @returns {object | undefined} the match.
 */
function firstByClass(node, className) {
  return byClass(node, className)[0]
}

/**
 * A React stand-in that keeps hook state across renders and runs effects.
 *
 * The previous version returned initial state and no-op setters, so every
 * assertion described the first render — the pass least likely to be wrong. The
 * interesting behaviour (data arriving, an error replacing an empty card, a
 * refilling catalogue) only exists after an effect resolves, and that is what
 * this drives.
 *
 * @returns {object} `{ hooks, render, unmount }`.
 */
function createRenderer() {
  // Hook state belongs to a component, not to the renderer: a parent and a child
  // both start their hooks at index 0 and would otherwise share slots.
  const perComponent = new WeakMap()
  const pending = []
  const cleanups = []
  let hookIndex = 0
  let rerenderNeeded = false

  /**
   * The state buckets for one component.
   *
   * @param {any} Component - the component function.
   * @returns {{ slots: Map<number, any>, deps: Map<number, any> }} its buckets.
   */
  function bucketsFor(Component) {
    if (typeof Component !== 'function') {
      throw new Error('this harness can only render function components')
    }
    let bucket = perComponent.get(Component)
    if (bucket === undefined) {
      bucket = { slots: new Map(), deps: new Map() }
      perComponent.set(Component, bucket)
    }
    return bucket
  }

  let slots = new Map()
  let deps = new Map()

  const hooks = {
    useState(initial) {
      const key = hookIndex++
      if (!slots.has(key)) slots.set(key, { value: typeof initial === 'function' ? initial() : initial })
      const slot = slots.get(key)
      const setter = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        rerenderNeeded = true
      }
      return [slot.value, setter]
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
      // React tears down the previous effect before running the new one. Without
      // this, an effect with non-empty deps that subscribes to something leaks its
      // first subscription — and a leak is exactly what the tooltip assertions
      // are trying to detect.
      if (prior !== undefined && typeof prior.cleanup === 'function') prior.cleanup()
      const record = { deps: list, cleanup: undefined }
      deps.set(key, record)
      pending.push(() => {
        const cleanup = effect()
        record.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        // Return it so the renderer can collect it. Without this the renderer's
        // own `typeof cleanup === 'function'` check sees undefined, `cleanups`
        // stays empty, and `unmount()` quietly does nothing.
        return record.cleanup
      })
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
    createElement: element,
    /**
     * Merge props into an existing element.
     *
     * Only the shallow merge of object props that this bundle relies on; a real
     * React also remounts on a changed key and re-resolves refs, neither of which
     * is observable here.
     *
     * @param {object} node - the element to copy.
     * @param {object} props - the props to merge in.
     * @returns {object} the new element.
     */
    cloneElement(node, props) {
      return { ...node, props: { ...node.props, ...props } }
    },
    /**
     * Tell an element literal from a string or null.
     *
     * The test is `$$typeof`, not the shape: an earlier version recognised an
     * element by having `type` and `props`, which accepted plain objects that were
     * never rendered and rejected nothing a real element needs. React itself keys
     * off this symbol, so the double does too.
     *
     * @param {unknown} value - the candidate.
     * @returns {boolean} whether it is an element.
     */
    isValidElement(value) {
      return typeof value === 'object' && value !== null && value.$$typeof === Symbol.for('react.element')
    },
  }

  /**
   * Render a component, running queued effects until it settles.
   *
   * @param {any} Component - the component.
   * @param {object} [props] - its props.
   * @param {number} [rounds] - how many settle passes to allow.
   * @returns {Promise<object>} the last rendered tree.
   */
  async function render(Component, props, rounds = 6) {
    const bucket = bucketsFor(Component)
    const outerSlots = slots
    const outerDeps = deps
    slots = bucket.slots
    deps = bucket.deps
    let tree
    for (let round = 0; round < rounds; round += 1) {
      hookIndex = 0
      rerenderNeeded = false
      tree = Component(props ?? {})
      // React attaches refs during the commit, before effects run. Doing it after
      // the effect phase instead meant the overlay's mount effect always measured
      // with a null host and took the zero-origin fallback path.
      attachRefs(tree)
      const queued = pending.splice(0, pending.length)
      for (const effect of queued) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      // Let promises started by those effects land before deciding to stop.
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
      if (rerenderNeeded === false && pending.length === 0) break
    }
    slots = outerSlots
    deps = outerDeps
    return tree
  }

  /**
   * Resolve every `ref` prop in a tree to the fake node.
   *
   * React attaches refs after the commit; this does the same, which is what makes
   * the second render see a non-null `hostRef.current`. Without it, `measure`
   * always took the fallback path and the geometry assertions were vacuous.
   *
   * @param {any} node - the tree.
   */
  function attachRefs(node) {
    walk(node, (row) => {
      const ref = row.props?.ref
      if (ref !== null && typeof ref === 'object' && 'current' in ref && ref.current === null) {
        // The tooltip trigger has its own node when a test supplies one: the
        // clamp only differs from a lower bound once the button sits near the
        // right edge, so the trigger's position has to be settable.
        const isTrigger = String(row.props?.className ?? '').includes('dsse-tip-anchor')
        ref.current = isTrigger && nodeForTrigger !== null ? nodeForTrigger : nodeForRef
      }
    })
  }

  let nodeForRef = null
  let nodeForTrigger = null

  /**
   * Give every tooltip trigger a node at a fixed screen position.
   *
   * @param {object | null} node - the fake DOM node, or null to share the frame.
   */
  function setTriggerForRef(node) {
    nodeForTrigger = node
  }

  /**
   * Tell the renderer what a ref should resolve to.
   *
   * @param {object} node - the fake DOM node.
   */
  function setNodeForRef(node) {
    nodeForRef = node
  }

  /** Run every recorded cleanup, as an unmount would. */
  function unmount() {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()
      try {
        cleanup()
      } catch {
        // A failing cleanup is the host's to report; here it must not mask the
        // assertion that follows it.
      }
    }
  }

  /**
   * Render a component and everything it composes.
   *
   * React expands function components during render; this harness has to do it
   * by hand because its jsx is a plain object. Children marked with a
   * `component` field are rendered here and their output spliced in, so an
   * assertion about a grandchild sees the tree React would have produced.
   *
   * @param {any} Component - the seat component.
   * @param {object} [props] - its props.
   * @returns {Promise<any>} the fully expanded tree.
   */
  async function deepRender(Component, props) {
    const tree = await render(Component, props)
    return expand(tree)
  }

  /**
   * Expand every function component in place.
   *
   * @param {any} node - the tree.
   * @returns {Promise<any>} the same shape with components replaced by their output.
   */
  async function expand(node) {
    if (node === null || node === undefined) return node
    if (Array.isArray(node)) {
      const out = []
      for (const child of node) out.push(await expand(child))
      return out
    }
    if (typeof node !== 'object') return node
    if (typeof node.component === 'function') {
      const inner = await render(node.component, node.props)
      return expand(inner)
    }
    if (node.props !== undefined && node.props.children !== undefined) {
      return { ...node, props: { ...node.props, children: await expand(node.props.children) } }
    }
    return node
  }

  return { hooks, render, deepRender, unmount, setNodeForRef, setTriggerForRef }
}

/**
 * Boot the bundle in a fake browser.
 *
 * @param {object} [options] - request.
 * @param {object | null} [options.rect] - the conversation body's rect; null for no conversation.
 * @param {string} [options.proseWidth] - the value of `--dsh-chat-content-width`.
 * @param {object} [options.routes] - path prefix → payload, or → Error.
 * @returns {object} the booted state.
 */
function boot(options) {
  const settings = options ?? {}
  const registrations = []
  const effects = []
  const injectedNames = []
  const styles = []
  const requested = []
  const calls = []
  // The default fixture has a 280px left sidebar, so the conversation column and
  // the overlay do not share an origin. A fixture with `left: 0` is the single
  // layout where a coordinate-space mistake is invisible, which is how the
  // viewport-width bug survived the first suite.
  const rect =
    settings.rect === undefined
      ? { left: 280, top: 120, right: 1920, bottom: 420, width: 1640, height: 300 }
      : settings.rect

  const renderer = createRenderer()
  const React = renderer.hooks

  const moduleTable = (id) => {
    requested.push(id)
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' }
    throw new Error(`the bundle required "${id}", which the shared module table does not carry`)
  }

  const conversation =
    rect === null ? null : { getBoundingClientRect: () => ({ ...rect }), offsetWidth: rect.width }

  const documentStub = {
    baseURI: 'http://127.0.0.1:19387/',
    head: { appendChild: (node) => styles.push(node) },
    body: { attributes: new Map() },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    querySelector: (selector) => (selector === '[data-conversation-content]' ? conversation : null),
  }

  const ctx = {
    effect(register, label) {
      effects.push(label)
      return register()
    },
    slots: {
      inject(name, register) {
        injectedNames.push(name)
        return register()
      },
      register(spec, Component) {
        registrations.push({ spec, Component })
        return () => {}
      },
    },
  }

  let captured
  // Recorded so a test can assert that every listener added is also removed.
  // A no-op stub cannot express a leak, which is why the review found the
  // resize/scroll pair untested rather than merely unasserted.
  const listeners = []
  const windowStub = {
    __ModuleLoader__: {
      load(entry) {
        captured = entry
      },
    },
    // Absent by default, exactly as in the test double the review used: the
    // clamp branch must behave when the viewport cannot be measured, and tests
    // that describe a narrow window set it explicitly.
    innerWidth: settings.innerWidth,
    // Set explicitly by the fixtures that exercise the vertical clamp. Left
    // undefined elsewhere so the "viewport cannot be measured" branch keeps being
    // exercised by everything that does not care about it.
    innerHeight: settings.innerHeight,
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, options })
    },
    removeEventListener(type, handler, options) {
      const at = listeners.findIndex(
        (row) => row.type === type && row.handler === handler && row.options === options,
      )
      if (at >= 0) listeners.splice(at, 1)
    },
  }

  const timers = []
  const routes = settings.routes ?? {}
  const fetchStub = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, init })
    const path = target.replace('http://127.0.0.1:19387', '')
    for (const [prefix, answer] of Object.entries(routes)) {
      if (path.startsWith(prefix) === false) continue
      if (answer instanceof Error) throw answer
      const payload = typeof answer === 'function' ? answer(init) : answer
      return { ok: true, status: 200, json: async () => payload }
    }
    throw new Error(`no route for ${path}`)
  }

  const computed = () => ({
    // The default body is wide enough to leave a real gutter: 1920 body, 920
    // prose, 500 either side. A fixture with no gutter would exercise the handle
    // branch in every test and quietly never test the cards at all.
    getPropertyValue: () => settings.proseWidth ?? '920px',
  })

  // The overlay spans the frame, so its width is the window's — not the
  // conversation column's. Tests that describe a narrow window must narrow both.
  const frame = settings.frame ?? { left: 0, top: 0, width: 1920, height: 1000 }
  renderer.setNodeForRef(fakeNode(frame))
  // Default: the trigger shares the frame node, so its rect starts at the
  // frame's left edge. Tests that care about placement set this. `triggerTop` is
  // separate because the vertical clamp only decides anything once the trigger is
  // close enough to the bottom edge that the bubble below it would overflow.
  renderer.setTriggerForRef(
    settings.triggerLeft === undefined
      ? null
      : fakeNode({ left: settings.triggerLeft, top: settings.triggerTop ?? 300, width: 40, height: 20, contains: settings.triggerContains ?? [] }),
  )


  const source = readFileSync(join(repo, 'lib', 'client.js'), 'utf8')
  const evaluate = new Function(
    'window',
    'document',
    'fetch',
    'getComputedStyle',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
    source,
  )
  // A fixed pair of interval stubs: the cards poll, and a real interval would keep
  // the test process alive after it has finished asserting.
  //
  // `setTimeout` is injected rather than left global because the hover grace
  // period is a real close delay: with the global timer and assertions that only
  // await microtasks, the deferred close never runs and every assertion about it
  // passes whether or not the code schedules anything. Fixtures either drive
  // these by hand or wait on the real clock.
  evaluate(
    windowStub,
    documentStub,
    fetchStub,
    computed,
    () => 0,
    () => {},
    (fn, ms) => {
      // Recorded so a fixture can assert on the delay the bundle asked for, and
      // so a test can fire the callback itself instead of waiting on the clock.
      const handle = (settings.setTimeout ?? setTimeout)(fn, ms)
      timers.push({ fn, ms, handle, cleared: false })
      return handle
    },
    (handle) => {
      const row = timers.find((entry) => entry.handle === handle)
      if (row !== undefined) row.cleared = true
      ;(settings.clearTimeout ?? clearTimeout)(handle)
    },
  )

  const module = captured.factory(moduleTable)

  return {
    module,
    ctx,
    listeners,
    registrations,
    effects,
    injectedNames,
    requested,
    calls,
    styles,
    timers,
    document: documentStub,
    captured,
    renderer,
    seat(name) {
      return registrations.find((row) => row.spec.id.endsWith(`:${name}`)).Component
    },
  }
}

/**
 * The routes the cards read, with envelopes shaped like the real ones.
 *
 * @returns {object} path prefix → payload.
 */
function panelRoutes() {
  return {
    '/api/skill-evolve/panel': {
      ok: true,
      data: {
        turn: 7,
        calls: 12,
        failed: 1,
        summary: { text: 'Read three files and edited one.', model: 'p/m' },
        pendingCandidates: 2,
        skills: {
          available: true,
          skills: [
            { name: 'pdf-tools', description: 'work with pdfs', owned: true },
            { name: 'office', description: 'office files', owned: false },
          ],
        },
        mcp: [{ server: 'github', tools: 3 }],
        files: [{ path: '/tmp/out/report.md', bytes: 2048, mtimeMs: 20 }],
      },
    },
    '/api/skill-evolve/config': {
      ok: true,
      data: { panelSummary: true, panelSide: 'left', panelCollapsed: false },
    },
    '/api/skill-evolve/models': { ok: true, data: { providers: [{ provider: 'p', models: [{ id: 'm', name: 'M' }] }] } },
    '/api/skill-evolve/propose': { ok: true, data: { hinted: true } },
    '/api/skill-evolve/candidates': { ok: true, data: { candidates: [] } },
  }
}

// ---------------------------------------------------------------------------
// Loader contract
// ---------------------------------------------------------------------------

const booted = boot()

check('the bundle registers itself under the plugin id', booted.captured.id === 'dsh-skill-evolve', String(booted.captured.id))
check('apply is exported as a function', typeof booted.module.apply === 'function')
check('inject names the slots service', JSON.stringify(booted.module.inject) === '["slots"]', JSON.stringify(booted.module.inject))
check(
  'the bundle requires only modules the shared table carries',
  (() => {
    // Anything outside this set makes the bundle fail to materialise, which the
    // host reports as a broken Plugins entry rather than as a blank panel.
    const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives'])
    return booted.requested.every((id) => allowed.has(id))
  })(),
  JSON.stringify(booted.requested),
)
check('the bundle requires react', booted.requested.includes('react'), JSON.stringify(booted.requested))

// ---------------------------------------------------------------------------
// Registration shape
// ---------------------------------------------------------------------------

booted.module.apply(booted.ctx)

check('two slots are injected', booted.injectedNames.length === 2, JSON.stringify(booted.injectedNames))
check(
  'the toggle goes into the session header',
  booted.injectedNames.includes('conversation.session.header.actions'),
  JSON.stringify(booted.injectedNames),
)
check('the cards go into the shell overlay', booted.injectedNames.includes('shell.overlay'), JSON.stringify(booted.injectedNames))
check('both seats registered', booted.registrations.length === 2, String(booted.registrations.length))
check('three effects are declared', booted.effects.length === 3, String(booted.effects.length))

for (const { spec } of booted.registrations) {
  const expected = spec.id.endsWith(':toggle') ? 'conversation.session.header.actions' : 'shell.overlay'
  check(`"${spec.id}" declares the slot it registers into`, spec.name === expected, `${spec.id} → ${spec.name}`)
  check(`"${spec.id}" names this plugin as registrant`, spec.registrant === 'dsh-skill-evolve', String(spec.registrant))
  check(`"${spec.id}" carries a numeric order`, Number.isFinite(spec.order), String(spec.order))
  check(`"${spec.id}" exposes an inject function`, typeof spec.inject === 'function', typeof spec.inject)
}

check(
  'the toggle is injected with the session id',
  booted.registrations.find((row) => row.spec.id.endsWith(':toggle')).spec.inject('session-xyz')?.sessionId === 'session-xyz',
)
check(
  'the cards declare no injected props',
  JSON.stringify(booted.registrations.find((row) => row.spec.id.endsWith(':cards')).spec.inject('session-xyz')) === '{}',
)

// ---------------------------------------------------------------------------
// Closed by default
// ---------------------------------------------------------------------------

{
  const tree = await booted.renderer.deepRender(booted.seat('cards'))
  check('the cards draw nothing until the toggle is clicked', tree === null, String(tree))
}

// ---------------------------------------------------------------------------
// No conversation on screen
// ---------------------------------------------------------------------------

{
  const instance = boot({ rect: null, routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const tree = await instance.renderer.render(instance.seat('cards'))
  check('no conversation means nothing is drawn', tree === null, String(tree))
}

// ---------------------------------------------------------------------------
// The toggle
// ---------------------------------------------------------------------------

{
  const instance = boot({ routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const tree = await instance.renderer.render(toggle, { sessionId: 'session-a' })
  const button = firstByClass(tree, 'dsse-toggle')
  check('the toggle is a button', button?.type === 'button', String(button?.type))
  check('the toggle is labelled', textOf(tree).includes('技能'), textOf(tree).slice(0, 40))
  check('the toggle starts inactive', button?.props?.['data-active'] === 'false', String(button?.props?.['data-active']))
  check(
    'the toggle reads the config on mount so the side setting is honoured',
    instance.calls.some((row) => row.url.endsWith('/api/skill-evolve/config')),
    JSON.stringify(instance.calls.map((row) => row.url)),
  )
}

{
  // Removing panelSide from readConfig kept every assertion green before this
  // block existed, which means the setting could have shipped dead. This drives
  // the path end to end: the route answers 'right', the toggle applies it, and
  // the cards come out on the right.
  const instance = boot({
    rect: { left: 280, top: 120, right: 1920, bottom: 900, width: 1640, height: 780 },
    proseWidth: '920px',
    routes: {
      ...panelRoutes(),
      '/api/skill-evolve/config': {
        ok: true,
        data: { panelSummary: true, panelSide: 'right', panelCollapsed: false },
      },
    },
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  const rail = firstByClass(tree, 'dsse-rail')
  check('a right-side setting from the config puts the rail on the right', rail?.props?.['data-side'] === 'right', String(rail?.props?.['data-side']))
}

{
  // The side changes after the overlay has measured.
  //
  // Mounting measures unconditionally, so a config that arrives *before* the
  // overlay mounts never exercises the subscription. The subscription is what
  // handles the real case: the panel is already on screen and something moves
  // the setting. Holding the config response open and releasing it afterwards is
  // the only way to reach that path — resolving it early leaves the mount effect
  // to cover for a missing `remeasure()` and the test passes either way.
  let releaseConfig = () => {}
  const configAnswer = new Promise((resolve) => {
    releaseConfig = resolve
  })
  const instance = boot({
    rect: { left: 280, top: 120, right: 1920, bottom: 900, width: 1640, height: 780 },
    proseWidth: '920px',
    routes: {
      ...panelRoutes(),
      '/api/skill-evolve/config': () => configAnswer,
    },
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')

  // Mount the header but leave the config request unanswered.
  const header = await instance.renderer.deepRender(toggle, { sessionId: 'session-a' })
  firstByClass(header, 'dsse-toggle').props.onClick()

  // The overlay measures now, on the default (left) side.
  const first = await instance.renderer.deepRender(cards)
  const firstRail = firstByClass(first, 'dsse-rail')
  check('the overlay measures before the setting arrives', firstRail?.props?.['data-side'] === 'left', String(firstRail?.props?.['data-side']))
  const firstLeft = Number.parseFloat(String(firstRail?.props?.style?.left ?? 'NaN'))
  check(
    'and starts in the left gutter',
    Number.isFinite(firstLeft) && firstLeft < 960,
    JSON.stringify(firstRail?.props?.style ?? null),
  )

  // Now the setting arrives, which notifies the already-mounted overlay.
  releaseConfig({ ok: true, data: { panelSummary: true, panelSide: 'right', panelCollapsed: false } })
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()

  const after = await instance.renderer.deepRender(cards)
  const rail = firstByClass(after, 'dsse-rail')
  check('a side that arrives after the first measure moves the cards', rail?.props?.['data-side'] === 'right', String(rail?.props?.['data-side']))
  const placedLeft = Number.parseFloat(String(rail?.props?.style?.left ?? "NaN"))
  check(
    'and the box is re-measured into the right gutter',
    Number.isFinite(placedLeft) && placedLeft > 960,
    JSON.stringify(rail?.props?.style ?? null),
  )
}
{
  // panelCollapsed: true must start the column as a handle, not as cards.
  const instance = boot({
    rect: { left: 280, top: 120, right: 1920, bottom: 900, width: 1640, height: 780 },
    proseWidth: '920px',
    routes: {
      ...panelRoutes(),
      '/api/skill-evolve/config': {
        ok: true,
        data: { panelSummary: true, panelSide: 'left', panelCollapsed: true },
      },
    },
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  const toggleTree = await instance.renderer.render(toggle, { sessionId: 'session-a' })
  // The toggle clears a collapse on an explicit click: a person clicking the
  // button is asking to see the cards, not to be shown a handle again.
  firstByClass(toggleTree, 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  check('clicking the toggle overrides a collapsed config', firstByClass(tree, 'dsse-rail') !== undefined, textOf(tree).slice(0, 60))
}

// ---------------------------------------------------------------------------
// Opening: the cards fetch, unwrap and render
// ---------------------------------------------------------------------------

{
  const instance = boot({ routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')

  const toggleTree = await instance.renderer.render(toggle, { sessionId: 'session-a' })
  firstByClass(toggleTree, 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)

  check('four cards are rendered', byClass(tree, 'dsse-card').length === 4, String(byClass(tree, 'dsse-card').length))
  check(
    'the first card is the last turn',
    textOf(byClass(tree, 'dsse-card')[0]).includes('上一轮'),
    textOf(byClass(tree, 'dsse-card')[0]).slice(0, 60),
  )
  check('the summary text is shown', textOf(tree).includes('Read three files and edited one'), textOf(tree).slice(0, 120))
  check('the turn counter is shown', textOf(tree).includes('第 7 轮'), textOf(tree).slice(0, 120))
  check('the candidate badge is shown', textOf(tree).includes('2 待批'), textOf(tree).slice(0, 200))
  check('skills are listed', textOf(tree).includes('pdf-tools'), textOf(tree).slice(0, 200))
  check('a captured skill is marked', textOf(tree).includes('本插件'), textOf(tree).slice(0, 200))
  check('MCP servers are listed', textOf(tree).includes('github'), textOf(tree).slice(0, 200))
  check('files are listed by name', textOf(tree).includes('report.md'), textOf(tree).slice(0, 300))
  check('a file carries its directory', textOf(tree).includes('out'), textOf(tree).slice(0, 300))
  check('a file carries its size', textOf(tree).includes('2.0 kB'), textOf(tree).slice(0, 300))
  check(
    'the panel route was asked with the session id',
    instance.calls.some((row) => row.url.includes('agent=session-a')),
    JSON.stringify(instance.calls.map((row) => row.url)),
  )
  check(
    'the model catalogue was fetched',
    instance.calls.some((row) => row.url.endsWith('/models')),
    JSON.stringify(instance.calls.map((row) => row.url)),
  )
}

// ---------------------------------------------------------------------------
// Geometry: the rail is placed from the measurement, never from the window
// ---------------------------------------------------------------------------

{
  // A 1920 frame with a 280px left sidebar. The prose is 920px centred in the
  // 1640px column, so it spans 640..1560 and the column's own left edge is 280.
  // The gutter is 360 — the prose's distance from the *column* edge, not from the
  // window's. That difference of 280 is the whole bug this pins down: the earlier
  // version measured from the window, placed the cards at x=16, and on a real
  // screen they landed on top of the host's sidebar.
  const rect = { left: 280, top: 120, right: 1920, bottom: 900, width: 1640, height: 780 }
  const instance = boot({ rect, proseWidth: '920px', routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  const rail = firstByClass(tree, 'dsse-rail')
  const expected = placeCards({
    chatRect: { left: 640, top: 120, right: 1560, bottom: 900 },
    columnRect: rect,
    side: 'left',
    cardWidth: 288,
  })
  check('the rail exists', rail !== undefined, String(tree?.type))
  check('the rail is placed where the geometry says', rail?.props?.style?.left === `${expected.left}px`, `${rail?.props?.style?.left} vs ${expected.left}`)
  check('the rail is as wide as the geometry says', rail?.props?.style?.width === `${expected.width}px`, String(rail?.props?.style?.width))
  check('the rail starts below the conversation top', rail?.props?.style?.top === `${expected.top}px`, String(rail?.props?.style?.top))
  check('the rail marks its side', rail?.props?.['data-side'] === 'left', String(rail?.props?.['data-side']))
  // The behavioural assertion, independent of the arithmetic above: wherever the
  // cards end up, they must be clear of the host sidebar on the left.
  const railLeft = Number.parseFloat(String(rail?.props?.style?.left ?? 'NaN'))
  check(
    'the rail clears the host sidebar',
    Number.isFinite(railLeft) && railLeft >= rect.left,
    `${railLeft} vs column starts ${rect.left}`,
  )
}

{
  // The right side mirrors the left: 360 of gutter inside the column, so the cards
  // sit immediately right of the prose rather than at the window's right edge. The
  // distinction only matters on a right preference — the default layout has a left
  // sidebar, so a window-relative measurement leaves the right gutter correct by
  // accident while wrecking the left one.
  const rect = { left: 280, top: 120, right: 1920, bottom: 900, width: 1640, height: 780 }
  const instance = boot({
    rect,
    proseWidth: '920px',
    routes: {
      ...panelRoutes(),
      '/api/skill-evolve/config': {
        ok: true,
        data: { panelSummary: true, panelSide: 'right', panelCollapsed: false },
      },
    },
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  const rail = firstByClass(tree, 'dsse-rail')

  const expected = placeCards({
    chatRect: { left: 640, top: 120, right: 1560, bottom: 900 },
    columnRect: rect,
    side: 'right',
    cardWidth: 288,
  })
  // What a window-relative rule would have said: the prose ends 360 from the right
  // edge either way, but from the window it reads the same number for the wrong
  // reason. The assertion below therefore checks the relationship, not the number:
  // the cards begin exactly one gap after the prose, inside the column.
  const proseRight = 1560
  check('the rail honours the right setting', rail?.props?.['data-side'] === 'right', String(rail?.props?.['data-side']))
  check(
    'and is placed one gap right of the prose',
    rail?.props?.style?.left === `${expected.left}px`,
    `${rail?.props?.style?.left} vs computed ${expected.left}`,
  )
  const railLeft = Number.parseFloat(String(rail?.props?.style?.left ?? 'NaN'))
  check(
    'and clears the prose',
    Number.isFinite(railLeft) && railLeft >= proseRight,
    `${railLeft} vs prose ends ${proseRight}`,
  )
  const railWidth = Number.parseFloat(String(rail?.props?.style?.width ?? 'NaN'))
  check(
    'and stays inside the column',
    Number.isFinite(railLeft) && Number.isFinite(railWidth) && railLeft + railWidth <= rect.right,
    `${railLeft}+${railWidth} vs column ends ${rect.right}`,
  )
}

{
  // A body narrower than the prose cap leaves no gutter at all: the cards must
  // fall back to the handle rather than draw a 10px column over the text.
  const instance = boot({
    frame: { left: 0, top: 0, width: 700, height: 1000 },
    rect: { left: 0, top: 120, right: 700, bottom: 900, width: 700, height: 780 },
    proseWidth: '680px',
    routes: panelRoutes(),
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  check('no gutter means no rail', firstByClass(tree, 'dsse-rail') === undefined, textOf(tree).slice(0, 80))
}

{
  // No measurable prose width published by the host: the fallback clamp must be
  // used rather than a zero-width column.
  const instance = boot({
    rect: { left: 0, top: 120, right: 1920, bottom: 900, width: 1920, height: 780 },
    proseWidth: 'not-a-number',
    routes: panelRoutes(),
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  check('an unreadable width falls back to the documented clamp', firstByClass(tree, 'dsse-rail') !== undefined, textOf(tree).slice(0, 80))
}

// ---------------------------------------------------------------------------
// Failures are surfaced, not swallowed
// ---------------------------------------------------------------------------

{
  const instance = boot({ routes: { ...panelRoutes(), '/api/skill-evolve/panel': new Error('the panel endpoint answered 500') } })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  check('a failed fetch is shown as an error', firstByClass(tree, 'dsse-err') !== undefined, textOf(tree).slice(0, 120))
  check('the error carries the message', textOf(tree).includes('answered 500'), textOf(tree).slice(0, 160))
}

{
  // The handler answers 200 even when it produced the failure itself. Treating
  // the envelope as data would render an empty panel over a broken queue.
  const instance = boot({ routes: { ...panelRoutes(), '/api/skill-evolve/panel': { ok: false, code: 'internal', error: 'queue unreadable' } } })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  check('a 200 with ok:false is an error, not data', textOf(tree).includes('queue unreadable'), textOf(tree).slice(0, 160))
}

// ---------------------------------------------------------------------------
// The summary switch posts what it shows
// ---------------------------------------------------------------------------

{
  const instance = boot({ routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  const checkbox = byClass(tree, 'dsse-check')[0]
  check('the summary switch reflects the config', checkbox?.props?.checked === true, String(checkbox?.props?.checked))
  checkbox.props.onChange({ target: { checked: false } })
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const post = instance.calls.find((row) => row.url.endsWith('/config') && row.init?.method === 'POST')
  check('flipping the switch posts to the config route', post !== undefined, JSON.stringify(instance.calls.map((row) => row.url)))
  check(
    'and posts the new value',
    post !== undefined && String(post.init.body).includes('"panelSummary":false'),
    String(post?.init?.body),
  )
}

// ---------------------------------------------------------------------------
// The model picker
// ---------------------------------------------------------------------------

{
  const instance = boot({ routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  const select = firstByClass(tree, 'dsse-select')
  check('the model picker is offered', select !== undefined, textOf(tree).slice(0, 200))
  const options = Array.isArray(select?.props?.children) ? select.props.children : [select?.props?.children]
  check('the picker has a default plus one real model', options.length === 2, String(options.length))
  check('the default follows the plugin default', String(options[0]?.props?.value) === '', String(options[0]?.props?.value))
  select.props.onChange({ target: { value: 'p\u0000m' } })
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const post = instance.calls.find((row) => row.url.endsWith('/config') && row.init?.method === 'POST')
  check(
    'choosing a model posts the pair',
    post !== undefined && String(post.init.body).includes('"summaryProvider":"p"') && String(post.init.body).includes('"summaryModel":"m"'),
    String(post?.init?.body),
  )
}

// ---------------------------------------------------------------------------
// The propose button
// ---------------------------------------------------------------------------

{
  const instance = boot({ routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  const propose = byClass(tree, 'dsse-btn')[0]
  check('the propose button exists', propose !== undefined && textOf(propose).includes('建议提炼'), textOf(tree).slice(0, 120))
  propose.props.onClick()
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const post = instance.calls.find((row) => row.url.endsWith('/propose') && row.init?.method === 'POST')
  check('proposing posts the agent', post !== undefined && String(post.init.body).includes('session-a'), String(post?.init?.body))
}

// ---------------------------------------------------------------------------
// Switching conversation
// ---------------------------------------------------------------------------

{
  const instance = boot({ routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  await instance.renderer.render(toggle, { sessionId: 'session-a' })
  firstByClass(instance.renderer.hooks && (await instance.renderer.render(toggle, { sessionId: 'session-a' })), 'dsse-toggle').props.onClick()
  check('the cards open for the first conversation', (await instance.renderer.deepRender(cards)) !== null)
  // Switching conversation with the cards open keeps them open and re-points
  // them. Closing on switch would hide a panel the person just asked for, for a
  // reason they never expressed.
  const second = await instance.renderer.render(toggle, { sessionId: 'session-b' })
  const secondButton = firstByClass(second, 'dsse-toggle')
  check(
    'the toggle stays active when the conversation switches',
    secondButton?.props?.['data-active'] === 'true',
    String(secondButton?.props?.['data-active']),
  )
  const before = instance.calls.length
  const switched = await instance.renderer.deepRender(await instance.seat('cards'))
  check('the cards redraw for the new conversation', switched !== null)
  const asked = instance.calls.slice(before).map((row) => row.url)
  check(
    'and ask the new conversation, not the old one',
    asked.some((url) => url.includes('agent=session-b')) && asked.every((url) => url.includes('agent=session-a') === false),
    JSON.stringify(asked),
  )
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

{
  const instance = boot({ routes: panelRoutes() })
  const disposers = []
  const ctx = {
    effect(register) {
      const dispose = register()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    slots: { inject: (name, register) => register(), register: (spec, Component) => {
      instance.registrations.push({ spec, Component })
      return () => {}
    } },
  }
  instance.module.apply(ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  check('open before teardown', (await instance.renderer.deepRender(cards)) !== null)
  for (const dispose of disposers) dispose()
  check('teardown closes the cards', (await instance.renderer.deepRender(cards)) === null)
}

// ---------------------------------------------------------------------------
// Every host slot this bundle names must be one the host publishes
// ---------------------------------------------------------------------------

{
  // The list is transcribed from the host's own registrations; a typo in a slot
  // name is not a crash, it is a seat nothing ever draws into — the quietest
  // possible failure.
  const published = new Set(['conversation.session.header.actions', 'shell.overlay'])
  for (const name of booted.injectedNames) {
    check(`"${name}" is a slot the host publishes`, published.has(name), name)
  }
}

// ---------------------------------------------------------------------------
// The checklist on the propose button
//
// The button once carried a native `title`, then a one-sentence hover bubble.
// What it must show now is the list of candidates: name plus a one-line
// description per row, a detail card on row hover, and approve/ignore per row.
// The failures worth catching here are the silent ones — a list that renders
// "no candidates" when the queue actually failed to load, a decide button that
// posts nothing, a row that stays on screen after it was decided.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = {
    ok: true,
    data: {
      candidates: [
        { id: 'a', name: 'pdf-tools', description: 'work with pdfs', kind: 'create', body: 'BODY-A', whenToUse: 'WHEN-A', uses: 0 },
        { id: 'b', name: 'office', description: '', kind: 'update', body: 'BODY-B', whenToUse: 'WHEN-B', uses: 2 },
      ],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const first = await instance.renderer.deepRender(cards)
  check('no checklist is shown before hovering', firstByClass(first, 'dsse-ck') === undefined)

  const trigger = firstByClass(first, 'dsse-tip-anchor')
  check('the propose button still sits in a hover trigger', trigger !== undefined, textOf(first).slice(0, 120))
  const button = byClass(first, 'dsse-btn')[0]
  check('the button no longer asks the browser for a tooltip', button?.props?.title === undefined, String(button?.props?.title))
  // A disabled button receives no mouse events in Chrome, which is exactly when
  // someone wants to know what the button would do. The wrapper owns the hover.
  check('the wrapper carries the hover handler', typeof trigger?.props?.onMouseEnter === 'function')
  check('the wrapper also reacts to keyboard focus', typeof trigger?.props?.onFocus === 'function')

  if (trigger !== undefined && typeof trigger?.props?.onMouseEnter === 'function') {
    trigger.props.onMouseEnter()
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  }

  const shown = await instance.renderer.deepRender(cards)
  const list = firstByClass(shown, 'dsse-ck')
  check('hovering opens the checklist', list !== undefined)
  check('the checklist is a dialog for assistive tech', list?.props?.role === 'dialog', String(list?.props?.role))

  const names = byClass(shown, 'dsse-ck-name').map((node) => textOf(node))
  check('every candidate is listed by name', JSON.stringify(names) === '["pdf-tools","office"]', JSON.stringify(names))
  const descs = byClass(shown, 'dsse-ck-desc').map((node) => textOf(node))
  check('a row with a description shows it', descs[0] === 'work with pdfs', JSON.stringify(descs))
  // An update with no description still has to say something: an empty line under
  // a name reads as a rendering bug rather than as "this one had no summary".
  check('a row without a description falls back to its kind', descs[1] === '修改已有技能', JSON.stringify(descs))
  check('each row offers approve and ignore', byClass(shown, 'dsse-ck-yes').length === 2 && byClass(shown, 'dsse-ck-no').length === 2)

  const head = textOf(byClass(shown, 'dsse-ck-head')[0])
  check('the heading counts the candidates', head.includes('2'), head)

  // The list is fixed-position outside the card, so it has to carry the rule.
  const sheet = instance.styles
    .map((node) => String(node.textContent))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const listRule = (/\.dsse-ck\s*\{([^}]*)\}/.exec(sheet) ?? [])[1] ?? ''
  check('the stylesheet positions the checklist as fixed', listRule.includes('position:fixed'), listRule.slice(0, 80))
  check('the checklist rule was actually found', listRule.length > 0, String(listRule.length))

  const styleText = String(list?.props?.style?.left ?? '')
  check('the checklist is placed with a finite value', styleText.endsWith('px') && Number.isFinite(Number(styleText.slice(0, -2))), styleText)
  check('and reserves the declared panel width', list?.props?.style?.width === `${PANEL_WIDTH}px`, String(list?.props?.style?.width))

  // --- hovering a row opens the detail card -------------------------------
  const rows = byClass(shown, 'dsse-ck-item')
  check('the rows are hoverable', rows.length === 2)
  if (rows.length > 0 && typeof rows[0].props?.onMouseEnter === 'function') {
    rows[0].props.onMouseEnter()
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  }
  const detailed = await instance.renderer.deepRender(cards)
  const detail = firstByClass(detailed, 'dsse-ck-detail')
  check('hovering a row opens the detail card', detail !== undefined)
  const detailText = textOf(detail)
  check('the detail card carries the body', detailText.includes('BODY-A'), detailText.slice(0, 160))
  check('the detail card carries when-to-use', detailText.includes('WHEN-A'), detailText.slice(0, 160))
  // Anchored to the LIST, not to the row: a row's right edge is inside the list,
  // so anchoring there drew the card on top of it.
  const detailLeft = Number(String(detail?.props?.style?.left ?? '').replace('px', ''))
  const listLeft = Number(String(list?.props?.style?.left ?? '').replace('px', ''))
  const listWidth = Number(String(list?.props?.style?.width ?? '').replace('px', ''))
  check(
    'the detail card opens beside the checklist, not over it',
    Number.isFinite(detailLeft) && Number.isFinite(listLeft) && Number.isFinite(listWidth) && detailLeft >= listLeft + listWidth,
    `detail ${detailLeft} vs list ${listLeft}+${listWidth}`,
  )
  check('the detail card reserves the declared width', detail?.props?.style?.width === `${DETAIL_WIDTH}px`, String(detail?.props?.style?.width))

  // --- moving into the list must not close it -----------------------------
  // The pointer crosses a gap between the button and the list, so closing is
  // deferred. Without the grace period the list vanishes the moment the pointer
  // leaves the button and nobody can ever reach the approve buttons.
  const shownAgain = firstByClass(detailed, 'dsse-tip-anchor')
  if (shownAgain !== undefined && typeof shownAgain.props?.onMouseLeave === 'function') {
    shownAgain.props.onMouseLeave()
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
  }
  const stillOpen = await instance.renderer.deepRender(cards)
  check('leaving the button does not close the list immediately', firstByClass(stillOpen, 'dsse-ck') !== undefined)

  // Entering the list cancels the pending close.
  const listNode = firstByClass(stillOpen, 'dsse-ck')
  if (listNode !== undefined && typeof listNode.props?.onMouseEnter === 'function') {
    listNode.props.onMouseEnter()
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
  }
  const afterGrace = await instance.renderer.deepRender(cards)
  check('entering the list keeps it open past the grace period', firstByClass(afterGrace, 'dsse-ck') !== undefined)

  // --- deciding a row ----------------------------------------------------
  const approve = byClass(afterGrace, 'dsse-ck-yes')[0]
  check('the approve button is rendered', approve !== undefined)
  check('the approve button shows a check mark', textOf(approve).length === 1, textOf(approve))
  if (approve !== undefined && typeof approve.props?.onClick === 'function') {
    approve.props.onClick({ stopPropagation() {} })
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve()
  }
  const posted = instance.calls.filter((row) => row.url.includes('/candidates') && row.init?.method === 'POST')
  check('approving posts to the decide route', posted.length === 1, String(posted.length))
  check('the post names the row and the action', posted.length === 1 && String(posted[0].init.body).includes('"action":"approve"') && String(posted[0].init.body).includes('pdf-tools'), String(posted[0]?.init?.body))
  // The row leaves without a refetch: refetching reorders the list under the
  // pointer, and the decide request is what the user is watching.
  const afterDecide = await instance.renderer.deepRender(cards)
  const remainingNames = byClass(afterDecide, 'dsse-ck-name').map((node) => textOf(node))
  check('the approved row leaves the list', JSON.stringify(remainingNames) === '["office"]', JSON.stringify(remainingNames))
}

// ---------------------------------------------------------------------------
// Empty, loading and failed look different from each other
//
// This is the point of the module. "Nothing is waiting" and "the queue could not
// be read" both render an empty list if the states are collapsed, and only one of
// them means the button is useless.
// ---------------------------------------------------------------------------

{
  const cases = [
    { label: 'empty', route: { ok: true, data: { candidates: [] } }, expect: '没有待批准', forbid: '失败' },
    { label: 'unavailable', route: { ok: true, data: { available: false, reason: 'the queue needs a host' } }, expect: '不可用', forbid: '没有待批准' },
    { label: 'refused', route: { ok: false, code: 'boom', error: 'the queue is unreadable' }, expect: '读取失败', forbid: '没有待批准' },
  ]
  for (const item of cases) {
    const routes = panelRoutes()
    routes['/api/skill-evolve/candidates'] = item.route
    const instance = boot({ routes })
    instance.module.apply(instance.ctx)
    const toggle = instance.seat('toggle')
    const cards = instance.seat('cards')
    firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
    const first = await instance.renderer.deepRender(cards)
    const trigger = firstByClass(first, 'dsse-tip-anchor')
    if (trigger !== undefined) {
      trigger.props.onMouseEnter()
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
    }
    const shown = await instance.renderer.deepRender(cards)
    const text = textOf(firstByClass(shown, 'dsse-ck') ?? shown)
    check(`the ${item.label} state says so`, text.includes(item.expect), text.slice(0, 160))
    check(`the ${item.label} state is not mistaken for an empty queue`, text.includes(item.forbid) === false, text.slice(0, 160))
  }
}

// ---------------------------------------------------------------------------
// A stale row cannot be approved, but can be discarded
//
// Stale rows are listed rather than hidden: a candidate that lost its name to
// another skill still occupies the name, and hiding it leaves no way to clear it.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = {
    ok: true,
    data: {
      candidates: [
        { id: 's', name: 'stale-one', description: 'gone', kind: 'create', body: 'B', whenToUse: '', stale: { reason: 'base-changed' } },
        { id: 'f', name: 'fresh-one', description: 'fine', kind: 'create', body: 'B', whenToUse: '' },
      ],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  const trigger = firstByClass(first, 'dsse-tip-anchor')
  if (trigger !== undefined) {
    trigger.props.onMouseEnter()
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  }
  const shown = await instance.renderer.deepRender(cards)
  const yes = byClass(shown, 'dsse-ck-yes')
  const no = byClass(shown, 'dsse-ck-no')
  check('every stale and fresh row is listed', byClass(shown, 'dsse-ck-item').length === 2)
  check('the stale row cannot be approved', yes[0]?.props?.disabled === true, String(yes[0]?.props?.disabled))
  check('the stale row can still be discarded', no[0]?.props?.disabled !== true, String(no[0]?.props?.disabled))
  check('the fresh row can still be approved', yes[1]?.props?.disabled !== true, String(yes[1]?.props?.disabled))
  const why = byClass(shown, 'dsse-ck-why').map((node) => textOf(node)).join(' ')
  check('the stale row explains why', why.includes('已被改动'), why)
}



// ---------------------------------------------------------------------------
// A staged approval keeps its row, and says what happened
//
// In `confirm` mode (the default) pressing approve writes no file: it marks the
// candidate `awaitingFinal` and asks the model to produce the final wording. The
// row used to vanish anyway, which said "done" about work that had not started
// and left the queue badge still counting it. The row must stay, must be
// disabled, and must say why; only a real write may remove a row.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = {
    ok: true,
    data: {
      candidates: [
        { id: 'a', name: 'pdf-tools', description: 'work with pdfs', kind: 'create', body: 'BODY-A', whenToUse: '' },
        { id: 'b', name: 'office', description: '', kind: 'update', body: 'BODY-B', whenToUse: '' },
      ],
    },
  }
  routes['/api/skill-evolve/candidates'] = (init) => {
    if (init?.method !== 'POST') return { ok: true, data: { candidates: [
      { id: 'a', name: 'pdf-tools', description: 'work with pdfs', kind: 'create', body: 'BODY-A', whenToUse: '' },
      { id: 'b', name: 'office', description: '', kind: 'update', body: 'BODY-B', whenToUse: '' },
    ] } }
    return { ok: true, data: { ok: true, staged: true } }
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-tip-anchor').props.onMouseEnter()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const listed = await instance.renderer.deepRender(cards)
  check('both rows are listed before deciding', byClass(listed, 'dsse-ck-item').length === 2, String(byClass(listed, 'dsse-ck-item').length))
  byClass(listed, 'dsse-ck-yes')[0].props.onClick()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const after = await instance.renderer.deepRender(cards)
  check('a staged approval keeps its row', byClass(after, 'dsse-ck-item').length === 2, String(byClass(after, 'dsse-ck-item').length))
  check('the staged row cannot be approved twice', byClass(after, 'dsse-ck-yes')[0]?.props?.disabled === true, String(byClass(after, 'dsse-ck-yes')[0]?.props?.disabled))
  const why = byClass(after, 'dsse-ck-why').map((node) => textOf(node)).join(' ')
  check('the staged row says the file is not written yet', why.includes('等模型写出定稿'), why)
  check('the staged row says it is not in the skill directory', why.includes('还不在技能目录里'), why)
}

{
  // The other half of the same rule: a decided-and-written row does go away, and
  // it goes away by id. Removing by name would also take a stale row that happens
  // to share the name, which the queue explicitly allows to exist.
  const listed = [
    { id: 'live', name: 'dup', description: 'live one', kind: 'create', body: 'B', whenToUse: '' },
    { id: 'stale', name: 'dup', description: 'stale one', kind: 'create', body: 'B', whenToUse: '', stale: { reason: 'expired' } },
  ]
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = (init) =>
    init?.method === 'POST' ? { ok: true, data: { ok: true } } : { ok: true, data: { candidates: listed } }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-tip-anchor').props.onMouseEnter()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const before = await instance.renderer.deepRender(cards)
  check('two rows share a name', byClass(before, 'dsse-ck-item').length === 2, String(byClass(before, 'dsse-ck-item').length))
  byClass(before, 'dsse-ck-no')[0].props.onClick()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const after = await instance.renderer.deepRender(cards)
  check('deciding one row removes exactly one row', byClass(after, 'dsse-ck-item').length === 1, String(byClass(after, 'dsse-ck-item').length))
  const left = byClass(after, 'dsse-ck-name').map((node) => textOf(node)).join(' ')
  check('the row that stayed is the other one with the same name', byClass(after, 'dsse-ck-item').length === 1 && left.includes('dup'), left)
  // The discarded row was the live one, so the survivor is the stale entry — and
  // a stale entry must stay unapprovable. Asserting the wrong survivor would pass
  // for the wrong reason and hide a filter that took both rows.
  const survivor = byClass(after, 'dsse-ck-why').map((node) => textOf(node)).join(' ')
  check('the survivor is the stale row, still unapprovable', byClass(after, 'dsse-ck-yes')[0]?.props?.disabled === true, String(byClass(after, 'dsse-ck-yes')[0]?.props?.disabled))
  check('the survivor still explains why it cannot be approved', survivor.includes('已过期') || survivor.includes('过期'), survivor)
}

// ---------------------------------------------------------------------------
// The decide request carries the session
//
// Every other write the card makes appends `?agent=`. The decide call did not, so
// the host resolved the candidate against no session at all. There is no visible
// symptom today — the root is config-only — which is exactly why it needs a test
// rather than an eyeball.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = (init) =>
    init?.method === 'POST'
      ? { ok: true, data: { ok: true } }
      : { ok: true, data: { candidates: [{ id: 'a', name: 'pdf-tools', description: 'd', kind: 'create', body: 'B', whenToUse: '' }] } }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-z' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-tip-anchor').props.onMouseEnter()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const listed = await instance.renderer.deepRender(cards)
  byClass(listed, 'dsse-ck-no')[0].props.onClick()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const posted = instance.calls.filter((entry) => entry.init?.method === 'POST')
  check('the decide call is a POST', posted.length === 1, String(posted.length))
  check('the decide call names the session', String(posted[0]?.url).includes('agent=session-z'), String(posted[0]?.url))
  const body = JSON.parse(String(posted[0]?.init?.body ?? '{}'))
  check('the decide call names the candidate', body.name === 'pdf-tools', JSON.stringify(body))
  check('the decide call names the action', body.action === 'discard', JSON.stringify(body))
}

// ---------------------------------------------------------------------------
// The hover grace period is a real delay, not a claim about one
//
// The bubble and the list are separate fixed-position layers with a gap between
// them, so the pointer necessarily leaves the button before it reaches the list.
// Without the delay the list closes in that gap and cannot be used at all. With
// the global timer un-injected, the deferred close never ran during a test and
// every assertion about it passed either way.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = { ok: true, data: { candidates: [
    { id: 'a', name: 'pdf-tools', description: 'd', kind: 'create', body: 'B', whenToUse: '' },
  ] } }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  const trigger = firstByClass(first, 'dsse-tip-anchor')
  trigger.props.onMouseEnter()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const opened = await instance.renderer.deepRender(cards)
  check('the list is open before the pointer leaves', byClass(opened, 'dsse-ck').length === 1, String(byClass(opened, 'dsse-ck').length))

  firstByClass(opened, 'dsse-tip-anchor').props.onMouseLeave()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const still = await instance.renderer.deepRender(cards)
  check('leaving the button does not close the list straight away', byClass(still, 'dsse-ck').length === 1, String(byClass(still, 'dsse-ck').length))
  const pending = instance.timers.filter((entry) => entry.cleared === false && entry.ms > 0)
  check('leaving the button schedules a close', pending.length === 1, String(pending.length))
  check('the close delay is long enough to cross the gap', (pending[0]?.ms ?? 0) >= 150, String(pending[0]?.ms))

  // Entering the list must cancel that pending close, or the list shuts while the
  // pointer is inside it.
  const list = byClass(still, 'dsse-ck')[0]
  list?.props?.onMouseEnter?.()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  check('entering the list cancels the pending close', instance.timers.some((entry) => entry.cleared === true), JSON.stringify(instance.timers.map((entry) => entry.cleared)))
  const kept = await instance.renderer.deepRender(cards)
  check('the list is still open after the pointer enters it', byClass(kept, 'dsse-ck').length === 1, String(byClass(kept, 'dsse-ck').length))
}

{
  // And the delay must actually elapse into a close, or it is just a timer that
  // nobody reads. Driven by hand so the suite stays fast and deterministic.
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = { ok: true, data: { candidates: [
    { id: 'a', name: 'pdf-tools', description: 'd', kind: 'create', body: 'B', whenToUse: '' },
  ] } }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-tip-anchor').props.onMouseEnter()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const opened = await instance.renderer.deepRender(cards)
  firstByClass(opened, 'dsse-tip-anchor').props.onMouseLeave()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const armed = instance.timers.filter((entry) => entry.cleared === false && entry.ms > 0)
  for (const entry of armed) entry.fn()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const closed = await instance.renderer.deepRender(cards)
  check('the scheduled close really closes the list', byClass(closed, 'dsse-ck').length === 0, String(byClass(closed, 'dsse-ck').length))
}

// ---------------------------------------------------------------------------
// Listeners added while open are removed when it closes
//
// The window stub records every listener precisely so this can be asserted; the
// invariant had dropped out when the bubble was replaced and nothing noticed. The
// scroll listener must also be on the capture phase, because the conversation
// scrolls inside nested elements and a bubble-phase listener on window never
// hears it.
//
// The baseline is the set attached before the list opened, not an empty list: the
// overlay keeps its own `resize` listener for as long as it is mounted, so
// asserting "nothing is attached afterwards" would fail on correct code.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = { ok: true, data: { candidates: [
    { id: 'a', name: 'pdf-tools', description: 'd', kind: 'create', body: 'B', whenToUse: '' },
  ] } }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  const beforeHover = instance.listeners.slice()

  const trigger = firstByClass(first, 'dsse-tip-anchor')
  trigger.props.onMouseEnter()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const opened = await instance.renderer.deepRender(cards)
  const added = instance.listeners.filter((row) => beforeHover.includes(row) === false)
  check('opening the list adds listeners', added.length >= 2, JSON.stringify(added.map((row) => row.type)))
  const scroll = added.find((row) => row.type === 'scroll')
  check('the scroll listener sits on the capture phase', scroll?.options === true || scroll?.options?.capture === true, JSON.stringify(scroll?.options))
  const keydown = added.find((row) => row.type === 'keydown')
  check('opening the list also listens for Escape', keydown !== undefined, JSON.stringify(added.map((row) => row.type)))

  firstByClass(opened, 'dsse-tip-anchor').props.onMouseLeave()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  for (const entry of instance.timers.filter((row) => row.cleared === false && row.ms > 0)) entry.fn()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  // A re-render is what lets the effect's cleanup run; without it the listeners
  // are still attached and the assertion would report a leak that has only not
  // been torn down yet.
  const after = await instance.renderer.deepRender(cards)
  check('the scheduled close emptied the list', byClass(after, 'dsse-ck').length === 0, String(byClass(after, 'dsse-ck').length))
  const leaked = added.filter((row) => instance.listeners.includes(row))
  check('closing the list removes every listener it added', leaked.length === 0, JSON.stringify(leaked.map((row) => row.type)))
  const kept = beforeHover.filter((row) => instance.listeners.includes(row))
  check('closing the list keeps the listeners it did not add', kept.length === beforeHover.length, `${kept.length} of ${beforeHover.length}`)

  instance.renderer.unmount()
  check('unmounting leaves nothing hooked', instance.listeners.length === 0, JSON.stringify(instance.listeners.map((row) => row.type)))
}

// ---------------------------------------------------------------------------
// The trigger announces the list it opens
//
// `role="dialog"` on the list alone is not enough: a screen reader reaches the
// button and has no idea anything opened. ARIA is not inherited from an ancestor,
// so the attributes have to land on the button itself.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = { ok: true, data: { candidates: [
    { id: 'a', name: 'pdf-tools', description: 'd', kind: 'create', body: 'B', whenToUse: '' },
  ] } }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const closed = await instance.renderer.deepRender(cards)
  const closedButton = byClass(closed, 'dsse-btn')[0]
  check('a closed list claims no popup', closedButton?.props?.['aria-expanded'] === undefined, JSON.stringify(closedButton?.props?.['aria-expanded']))

  firstByClass(closed, 'dsse-tip-anchor').props.onMouseEnter()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const opened = await instance.renderer.deepRender(cards)
  const openButton = byClass(opened, 'dsse-btn')[0]
  check('an open list tells the button it is expanded', openButton?.props?.['aria-expanded'] === true, JSON.stringify(openButton?.props?.['aria-expanded']))
  check('the button names the kind of thing it opens', openButton?.props?.['aria-haspopup'] === 'dialog', JSON.stringify(openButton?.props?.['aria-haspopup']))
}
// ---------------------------------------------------------------------------
// The card must survive its own contents
//
// Both of these were real: the list scrolls whenever it holds more candidates
// than fit, and every row has two real <button>s, so the two things a person
// naturally does to a card — scroll it, press a row's button — used to close it.
// In confirm mode the button press closed the card before the "approved, waiting
// for the draft" notice could be read, which is the one case where the notice
// matters.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = { ok: true, data: { candidates: [
    { id: 'a', name: 'pdf-tools', description: 'd', kind: 'create', body: 'B', whenToUse: '' },
    { id: 'b', name: 'office', description: 'd', kind: 'create', body: 'B', whenToUse: '' },
  ] } }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-tip-anchor').props.onMouseEnter()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const opened = await instance.renderer.deepRender(cards)
  check('the list is open before the scroll test', byClass(opened, 'dsse-ck').length === 1, String(byClass(opened, 'dsse-ck').length))

  const scroll = instance.listeners.find((row) => row.type === 'scroll')
  check('a scroll listener exists to test', scroll !== undefined, JSON.stringify(instance.listeners.map((row) => row.type)))

  // A scroll inside the list body is the person reading further down the list.
  scroll.handler({ target: { closest: (selector) => (selector.includes('.dsse-ck') ? { className: 'dsse-ck' } : null) } })
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const stillOpen = await instance.renderer.deepRender(cards)
  check('scrolling inside the list does not close it', byClass(stillOpen, 'dsse-ck').length === 1, String(byClass(stillOpen, 'dsse-ck').length))

  // A scroll anywhere else still means the anchor moved out from under the card.
  scroll.handler({ target: { closest: () => null } })
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const closed = await instance.renderer.deepRender(cards)
  check('scrolling the conversation still closes it', byClass(closed, 'dsse-ck').length === 0, String(byClass(closed, 'dsse-ck').length))
}

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = { ok: true, data: { candidates: [
    { id: 'a', name: 'pdf-tools', description: 'd', kind: 'create', body: 'B', whenToUse: '' },
  ] } }
  // Pressing a row's ✓ moves focus to a button that lives inside the wrapper,
  // so the fixture has to declare that button as contained — that is exactly the
  // predicate the handler asks about.
  const inner = { tag: 'button' }
  const instance = boot({ routes, triggerLeft: 400, triggerContains: [inner] })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-tip-anchor').props.onMouseEnter()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const opened = await instance.renderer.deepRender(cards)
  const wrapper = firstByClass(opened, 'dsse-tip-anchor')
  check('the wrapper handles blur', typeof wrapper.props.onBlur === 'function', typeof wrapper.props.onBlur)
  wrapper.props.onBlur({ relatedTarget: inner })
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  for (const entry of instance.timers.filter((row) => row.cleared === false && row.ms > 0)) entry.fn()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const held = await instance.renderer.deepRender(cards)
  check('moving focus inside the card does not close it', byClass(held, 'dsse-ck').length === 1, String(byClass(held, 'dsse-ck').length))

  // Focus leaving for somewhere else is the real "walked away".
  const outside = { tag: 'body' }
  const fresh = firstByClass(held, 'dsse-tip-anchor')
  fresh.props.onBlur({ relatedTarget: outside })
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  for (const entry of instance.timers.filter((row) => row.cleared === false && row.ms > 0)) entry.fn()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const gone = await instance.renderer.deepRender(cards)
  check('focus leaving the card closes it', byClass(gone, 'dsse-ck').length === 0, String(byClass(gone, 'dsse-ck').length))
}

{
  // The decide call has to name the row by id. Two candidates can share a name,
  // and the host resolves a bare name to the live one — so a name-only request
  // aimed at a stale row acts on its live twin instead.
  const sent = []
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = (init) => {
    if (init?.method === 'POST') {
      sent.push(String(init.body))
      return { ok: true, data: { ok: true } }
    }
    return { ok: true, data: { candidates: [
      { id: 'stale', name: 'dup', description: 'stale one', kind: 'create', body: 'B', whenToUse: '', stale: { reason: 'expired' } },
      { id: 'live', name: 'dup', description: 'live one', kind: 'create', body: 'B', whenToUse: '' },
    ] } }
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-tip-anchor').props.onMouseEnter()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const opened = await instance.renderer.deepRender(cards)
  const staleRow = byClass(opened, 'dsse-ck-item')[0]
  firstByClass(staleRow, 'dsse-ck-no').props.onClick()
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  const body = JSON.parse(sent[0] ?? '{}')
  check('the decide call carries the id of the row that was clicked', body.id === 'stale', JSON.stringify(body))
  check('the decide call still carries the name', body.name === 'dup', JSON.stringify(body))
  check('the decide call says which action it was', body.action === 'discard', JSON.stringify(body))
}


console.log(`\n${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failed === 0 ? 0 : 1)
