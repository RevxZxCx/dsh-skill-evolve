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
import { placeCards } from '../lib/gutter.js'

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
  const focusable = frame.focusable ?? []
  return {
    getBoundingClientRect: () => ({ left: frame.left, top: frame.top, right: frame.left + frame.width, bottom: frame.top + frame.height, width: frame.width, height: frame.height }),
    offsetWidth: frame.width,
    // `Clip` reads these two to decide whether there is hidden text. Defaulting to
    // equality means "nothing hidden", which is the common case; a test that wants
    // the fade says so with `overflowHeight`.
    scrollHeight: frame.overflowHeight ?? frame.height,
    clientHeight: frame.height,
    contains: (node) => inside.includes(node),
    querySelector: () => focusable[0] ?? null,
    querySelectorAll: () => focusable,
    focus: () => frame.onFocus?.(),
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
    /**
     * Layout effects, run in the same phase as passive ones.
     *
     * The harness has no paint step, so "before paint" and "after paint" are the
     * same moment here. Providing the hook keeps the bundle on its real path rather
     * than its no-layout fallback, which would leave the pre-paint branch untested.
     */
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
  const mutationObservers = []
  const hostStyle = new Map()
  const hostWrites = []
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

  const code = rect === null ? null : {}
  const conversation =
    rect === null ? null : {
      getBoundingClientRect: () => ({ ...rect }),
      offsetWidth: rect.width,
      querySelector: (selector) => (selector === 'code, pre' ? code : null),
    }

  const documentStub = {
    baseURI: 'http://127.0.0.1:19387/',
    head: { appendChild: (node) => styles.push(node) },
    body: { attributes: new Map() },
    documentElement: {
      style: {
        getPropertyValue: (name) => hostStyle.get(name) ?? '',
        setProperty: (name, value) => { hostWrites.push([name, String(value)]); hostStyle.set(name, String(value)) },
        removeProperty: (name) => hostStyle.delete(name),
      },
    },
    activeElement: null,
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
      const payload = typeof answer === 'function' ? answer(init, target) : answer
      return { ok: true, status: 200, json: async () => payload }
    }
    throw new Error(`no route for ${path}`)
  }

  const computed = (node) => ({
    // The default body is wide enough to leave a real gutter: 1920 body, 920
    // prose, 500 either side. A fixture with no gutter would exercise the handle
    // branch in every test and quietly never test the cards at all.
    getPropertyValue: () => settings.proseWidth ?? '920px',
    fontFamily: node === code ? settings.monoFontFamily ?? 'Host Mono' : settings.fontFamily ?? 'Host Sans',
    fontSize: settings.fontSize ?? '14px',
    lineHeight: settings.lineHeight ?? '21px',
  })

  class MutationObserverStub {
    constructor(callback) {
      this.callback = callback
      this.targets = []
      this.disconnected = false
      mutationObservers.push(this)
    }
    observe(target, options) {
      this.targets.push({ target, options })
    }
    disconnect() {
      this.disconnected = true
      this.targets = []
    }
  }

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
    'MutationObserver',
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
    MutationObserverStub,
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
    hostStyle,
    hostWrites,
    mutationObservers,
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
  check('the toggle counts the three cards', textOf(firstByClass(tree, 'dsse-toggle-count')) === '3', textOf(tree).slice(0, 40))
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

  check('three cards are rendered together', byClass(tree, 'dsse-card').length === 3, String(byClass(tree, 'dsse-card').length))
  check('skills and MCP share the second card', textOf(byClass(tree, 'dsse-card')[1]).includes('技能与 MCP') && textOf(byClass(tree, 'dsse-card')[1]).includes('github'), textOf(byClass(tree, 'dsse-card')[1]).slice(0, 160))
  check(
    'the first card is the last turn',
    textOf(byClass(tree, 'dsse-card')[0]).includes('上一轮'),
    textOf(byClass(tree, 'dsse-card')[0]).slice(0, 60),
  )
  check('the summary text is shown', textOf(tree).includes('Read three files and edited one'), textOf(tree).slice(0, 120))
  {
    const firstHead = firstByClass(tree, 'dsse-head-stats')
    {
    const clipped = firstByClass(tree, 'dsse-clip')
    check('the summary is wrapped in a clip', clipped !== undefined, textOf(tree).slice(0, 120))
    const queue = firstByClass(tree, 'dsse-queue')
    check('the candidates button is labelled in words', queue !== undefined && textOf(queue).includes('建议'), textOf(queue))
    // The fake DOM does not parse CSS, so a claim about the background has to be
    // made against the stylesheet itself; asserting the element exists proves
    // nothing about its appearance.
    const sheet = readFileSync(join(repo, 'lib', 'client.js'), 'utf8')
    check('the top row carries a background, a border and a radius', /\.dsse-top-row\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(sheet) && /\.dsse-top-row\{[^}]*border:1px solid/.test(sheet) && /\.dsse-top-row\{[^}]*border-radius:10px/.test(sheet), 'top-row rule')
  }
  check('the card header carries the call count', firstHead !== undefined && textOf(firstHead).includes('12'), textOf(tree).slice(0, 120))
    // Numbers, not just labels: swapping the command count for the file count used
    // to leave every assertion green because both were labelled.
    const headStats = firstHead === undefined ? [] : byClass(firstHead, 'dsse-head-stat').map((node) => textOf(node))
    check('the card header carries the command count', headStats.some((row) => /^0\s*命令$/.test(row)), JSON.stringify(headStats))
    check('the card header carries the file count', headStats.some((row) => /^1\s*文件$/.test(row)), JSON.stringify(headStats))
    check('the old stat strip is gone', firstByClass(tree, 'dsse-facts') === undefined, textOf(tree).slice(0, 160))
    check('the propose button moved into the header', firstHead !== undefined && firstByClass(firstHead, 'dsse-propose') !== undefined, textOf(tree).slice(0, 160))
    // Cards without a `head` still get their metadata from `meta`. Both paths have
    // to be pinned: removing the fallback would silently empty two headers.
    const metas = byClass(tree, 'dsse-card-meta').map((node) => textOf(node))
    check('a card without a custom head still shows its meta', metas.includes('2 技能 · 1 服务') && metas.includes('1 个文件'), JSON.stringify(metas))
  }
  check('the candidate badge is shown', textOf(firstByClass(tree, 'dsse-queue')).includes('2'), textOf(firstByClass(tree, 'dsse-queue')).slice(0, 80))
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
// The compact top row, merged activity list, and empty-card hiding
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/panel'] = {
    ok: true,
    data: {
      turn: 4,
      calls: 3,
      failed: 0,
      summary: { text: 'used one skill and two servers' },
      pendingCandidates: 1,
      skills: {
        available: true,
        skills: [
          { name: 'skill-old', description: 'old', owned: false, lastUsed: 1 },
          { name: 'skill-new', description: 'new', owned: true, lastUsed: 5 },
        ],
      },
      mcp: [
        { server: 'mcp-old', tools: 1, lastUsed: 2 },
        { server: 'mcp-new', tools: 2, lastUsed: 7 },
      ],
      files: [{ path: '/tmp/out/report.md', bytes: 2048, mtimeMs: 20 }],
      commands: ['a'],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const activityCard = byClass(tree, 'dsse-card')[1]
  const names = byClass(activityCard, 'dsse-name').map((node) => textOf(node))
  const kinds = byClass(activityCard, 'dsse-row-icon').map((node) => node.props['data-kind'])
  check('skills and MCP share one recency-ordered list', JSON.stringify(names) === '["mcp-new","skill-new","mcp-old","skill-old"]', JSON.stringify(names))
  check('each row carries a type icon', JSON.stringify(kinds) === '["mcp","skill","mcp","skill"]', JSON.stringify(kinds))
  check('the top row does not repeat the plugin title', textOf(firstByClass(tree, 'dsse-top-row')).includes('Skill Evolve') === false, textOf(firstByClass(tree, 'dsse-top-row')))
  // The name starts with the visible word: WCAG's "label in name" means the text a
  // person sees has to be findable inside the name a screen reader announces.
  const queueLabel = firstByClass(tree, 'dsse-queue')?.props?.['aria-label'] ?? ''
  check('the queue entry stays reachable from the top row', firstByClass(tree, 'dsse-top-row') !== undefined && firstByClass(firstByClass(tree, 'dsse-top-row'), 'dsse-queue') !== undefined, String(queueLabel))
  check('the queue entry is named by the word on it', queueLabel.startsWith('建议'), String(queueLabel))
  check('the propose button no longer carries an explanatory note', textOf(tree).includes('不会直接写入技能') === false, textOf(tree).slice(0, 200))
}

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/panel'] = {
    ok: true,
    data: { turn: 0, calls: 0, failed: 0, summary: { reason: 'no completed turn yet' }, pendingCandidates: 0, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [] },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  // `Overlay` always returns *some* node — a display:none wrapper when it has
  // nowhere to draw — so lookups against a null tree are the vacuous case, and
  // asserting the tree is null was simply the wrong claim. Pin the wrapper's own
  // state as well as the absence of the rail, or "hidden correctly" and "crashed
  // to nothing" would be indistinguishable here.
  // `Overlay` keeps one absolutely-positioned, pointer-transparent wrapper and
  // draws nothing inside it. That empty wrapper is the whole node: no class, no
  // children, no rail. Asserting on the absence of content rather than on `null`
  // is what makes "hidden" distinguishable from "nothing rendered at all".
  // `Overlay` keeps one absolutely-positioned, pointer-transparent wrapper and puts
  // nothing inside it. The claim worth pinning is that this wrapper carries no
  // panel content — no rail, no card, no header button — not that the tree is
  // `null`, which it never is.
  check('a session with nothing in it still draws the overlay wrapper', tree !== null && tree.props?.style?.inset === 0, JSON.stringify(tree === null ? null : tree.props?.style))
  check('a session with nothing in it draws no rail at all', firstByClass(tree, 'dsse-rail') === undefined, textOf(tree).slice(0, 120))
  check('a session with nothing in it draws no header buttons', firstByClass(tree, 'dsse-refresh') === undefined && firstByClass(tree, 'dsse-settings-open') === undefined && firstByClass(tree, 'dsse-queue') === undefined, textOf(tree).slice(0, 120))
  check('a session with nothing in it draws no text at all', textOf(tree) === '', textOf(tree).slice(0, 120))
  check('cards with no content are hidden', byClass(tree, 'dsse-card').length === 0, String(byClass(tree, 'dsse-card').length))
  check('an empty rail hides the header buttons too', firstByClass(tree, 'dsse-refresh') === undefined && firstByClass(tree, 'dsse-queue') === undefined && firstByClass(tree, 'dsse-settings-open') === undefined, textOf(tree).slice(0, 120))
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
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-settings-open').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  const checkbox = byClass(tree, 'dsse-check')[0]
  check('the summary switch reflects the config in settings', checkbox?.props?.checked === true, String(checkbox?.props?.checked))
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
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-settings-open').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  const select = firstByClass(tree, 'dsse-select')
  check('the model picker is offered in settings', select !== undefined, textOf(tree).slice(0, 200))
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
  const propose = firstByClass(tree, 'dsse-propose')
  check('the propose button exists', propose !== undefined && textOf(propose).includes('提炼'), textOf(tree).slice(0, 120))
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
  check('teardown disconnects typography observers', instance.mutationObservers.every((observer) => observer.disconnected), JSON.stringify(instance.mutationObservers.map((observer) => observer.disconnected)))
  check('teardown removes host typography variables', instance.hostStyle.size === 0, JSON.stringify([...instance.hostStyle.entries()]))
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
// Candidate review is a click-open modal. The write path still uses the exact
// candidate id and the existing approve/discard routes.
// ---------------------------------------------------------------------------

async function settle(turns = 12) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function openReview(instance, sessionId = 'session-a') {
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-queue').props.onClick()
  await settle()
  return instance.renderer.deepRender(cards)
}

function byAction(node, action) {
  const out = []
  walk(node, (row) => {
    if (row.props?.['data-action'] === action) out.push(row)
  })
  return out[0]
}

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
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const closed = await instance.renderer.deepRender(cards)
  check('no dialog is shown before the review button is clicked', firstByClass(closed, 'dsse-dialog') === undefined)
  const closedTrigger = firstByClass(closed, 'dsse-queue')
  check('the review trigger announces a dialog', closedTrigger?.props?.['aria-haspopup'] === 'dialog', JSON.stringify(closedTrigger?.props))
  check('the review trigger starts collapsed', closedTrigger?.props?.['aria-expanded'] === false, String(closedTrigger?.props?.['aria-expanded']))

  closedTrigger.props.onClick()
  await settle()
  const shown = await instance.renderer.deepRender(cards)
  const dialog = firstByClass(shown, 'dsse-dialog')
  check('clicking opens the review dialog', dialog !== undefined)
  check('the review dialog is modal for assistive tech', dialog?.props?.['aria-modal'] === 'true', String(dialog?.props?.['aria-modal']))
  check('the trigger expands when the dialog opens', firstByClass(shown, 'dsse-queue')?.props?.['aria-expanded'] === true)

  const names = byClass(shown, 'dsse-candidate-name').map((node) => textOf(node))
  check('every candidate is listed by name', JSON.stringify(names) === '["pdf-tools","office"]', JSON.stringify(names))
  const descs = byClass(shown, 'dsse-candidate-desc').map((node) => textOf(node))
  check('a row with a description shows it', descs[0] === 'work with pdfs', JSON.stringify(descs))
  check('a row without a description falls back to its kind', descs[1] === '修订已有技能', JSON.stringify(descs))
  check('the first candidate is selected initially', textOf(firstByClass(shown, 'dsse-detail')).includes('BODY-A'), textOf(firstByClass(shown, 'dsse-detail')).slice(0, 160))
  check('the detail carries when-to-use', textOf(firstByClass(shown, 'dsse-detail')).includes('WHEN-A'), textOf(firstByClass(shown, 'dsse-detail')).slice(0, 160))

  byClass(shown, 'dsse-candidate')[1].props.onClick()
  const detailed = await instance.renderer.deepRender(cards)
  check('clicking another candidate switches the detail', textOf(firstByClass(detailed, 'dsse-detail')).includes('BODY-B'), textOf(firstByClass(detailed, 'dsse-detail')).slice(0, 160))

  byClass(detailed, 'dsse-candidate')[0].props.onClick()
  const approving = await instance.renderer.deepRender(cards)
  const approve = byAction(approving, 'approve')
  check('the selected candidate offers approval', approve !== undefined)
  approve.props.onClick()
  await settle(16)
  const posted = instance.calls.filter((row) => row.url.includes('/candidates') && row.init?.method === 'POST')
  check('approving posts to the decide route', posted.length === 1, String(posted.length))
  check('the post names the row and the action', posted.length === 1 && String(posted[0].init.body).includes('"action":"approve"') && String(posted[0].init.body).includes('"id":"a"'), String(posted[0]?.init?.body))
  const afterDecide = await instance.renderer.deepRender(cards)
  const remainingNames = byClass(afterDecide, 'dsse-candidate-name').map((node) => textOf(node))
  check('the approved row leaves the list', JSON.stringify(remainingNames) === '["office"]', JSON.stringify(remainingNames))

  const sheet = instance.styles.map((node) => String(node.textContent)).join('\n')
  check('the modal layer is fixed above the host', /\.dsse-layer\{[^}]*position:fixed/.test(sheet))
  check('the modal inherits live host typography', /\.dsse-dialog\{[^}]*font-family:var\(--dsse-font-family,inherit\)/.test(sheet))
  check('no platform font stack is hard-coded', !/system-ui|Segoe UI|ui-monospace|Consolas/.test(sheet))
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
    const shown = await openReview(instance)
    const text = textOf(firstByClass(shown, 'dsse-dialog') ?? shown)
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
  const cards = instance.seat('cards')
  const shown = await openReview(instance)
  check('every stale and fresh row is listed', byClass(shown, 'dsse-candidate').length === 2)
  check('the stale row cannot be approved', byAction(shown, 'approve')?.props?.disabled === true, String(byAction(shown, 'approve')?.props?.disabled))
  check('the stale row can still be discarded', byAction(shown, 'discard')?.props?.disabled !== true, String(byAction(shown, 'discard')?.props?.disabled))
  check('the stale row explains why', textOf(firstByClass(shown, 'dsse-detail')).includes('已被改动'), textOf(firstByClass(shown, 'dsse-detail')).slice(0, 160))
  byClass(shown, 'dsse-candidate')[1].props.onClick()
  const fresh = await instance.renderer.deepRender(cards)
  check('the fresh row can still be approved', byAction(fresh, 'approve')?.props?.disabled !== true, String(byAction(fresh, 'approve')?.props?.disabled))
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
  const listed = await openReview(instance)
  check('both rows are listed before deciding', byClass(listed, 'dsse-candidate').length === 2, String(byClass(listed, 'dsse-candidate').length))
  byAction(listed, 'approve').props.onClick()
  await settle()
  const after = await instance.renderer.deepRender(cards)
  check('a staged approval keeps its row', byClass(after, 'dsse-candidate').length === 2, String(byClass(after, 'dsse-candidate').length))
  check('the staged row cannot be approved twice', byAction(after, 'approve') === undefined && textOf(firstByClass(after, 'dsse-detail')).includes('等待定稿'))
  const why = textOf(firstByClass(after, 'dsse-detail'))
  check('the staged row says the model still has to write the final draft', why.includes('等待模型定稿'), why)
  check('the staged row says it is not written yet', why.includes('尚未写入'), why)
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
  const before = await openReview(instance)
  check('two rows share a name', byClass(before, 'dsse-candidate').length === 2, String(byClass(before, 'dsse-candidate').length))
  byAction(before, 'discard').props.onClick()
  const confirming = await instance.renderer.deepRender(cards)
  check('discarding asks for confirmation first', byAction(confirming, 'confirm-discard') !== undefined)
  check('confirmation has not posted yet', instance.calls.some((row) => row.url.includes('/candidates') && row.init?.method === 'POST') === false)
  byAction(confirming, 'confirm-discard').props.onClick()
  await settle()
  const after = await instance.renderer.deepRender(cards)
  check('deciding one row removes exactly one row', byClass(after, 'dsse-candidate').length === 1, String(byClass(after, 'dsse-candidate').length))
  const left = byClass(after, 'dsse-candidate-name').map((node) => textOf(node)).join(' ')
  check('the row that stayed is the other one with the same name', byClass(after, 'dsse-candidate').length === 1 && left.includes('dup'), left)
  const survivor = textOf(firstByClass(after, 'dsse-detail'))
  check('the survivor is the stale row, still unapprovable', byAction(after, 'approve')?.props?.disabled === true, String(byAction(after, 'approve')?.props?.disabled))
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
  const listed = await openReview(instance, 'session-z')
  byAction(listed, 'discard').props.onClick()
  const confirming = await instance.renderer.deepRender(cards)
  byAction(confirming, 'confirm-discard').props.onClick()
  await settle()
  const posted = instance.calls.filter((entry) => entry.init?.method === 'POST')
  check('the decide call is a POST', posted.length === 1, String(posted.length))
  check('the decide call names the session', String(posted[0]?.url).includes('agent=session-z'), String(posted[0]?.url))
  const body = JSON.parse(String(posted[0]?.init?.body ?? '{}'))
  check('the decide call names the candidate', body.name === 'pdf-tools', JSON.stringify(body))
  check('the decide call names the action', body.action === 'discard', JSON.stringify(body))
}

// ---------------------------------------------------------------------------
// Search, Escape and the close animation
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = { ok: true, data: { candidates: [
    { id: 'a', name: 'pdf-tools', description: 'work with pdfs', kind: 'create', body: 'A', whenToUse: '' },
    { id: 'b', name: 'office', description: 'office documents', kind: 'update', body: 'B', whenToUse: '' },
  ] } }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const shown = await openReview(instance)
  firstByClass(shown, 'dsse-search').props.onChange({ target: { value: 'office' } })
  const filtered = await instance.renderer.deepRender(instance.seat('cards'))
  const listText = textOf(firstByClass(filtered, 'dsse-candidate-list'))
  check('search filters candidates by name and description', listText.includes('office') && listText.includes('pdf-tools') === false, listText)
  firstByClass(filtered, 'dsse-search').props.onChange({ target: { value: 'missing' } })
  const empty = await instance.renderer.deepRender(instance.seat('cards'))
  check('a search with no match says so', textOf(firstByClass(empty, 'dsse-candidate-list')).includes('没有匹配'), textOf(firstByClass(empty, 'dsse-candidate-list')))
}

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = { ok: true, data: { candidates: [
    { id: 'a', name: 'pdf-tools', description: 'd', kind: 'create', body: 'B', whenToUse: '' },
  ] } }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  const opened = await openReview(instance)
  const keydown = instance.listeners.find((row) => row.type === 'keydown')
  check('the open dialog listens for Escape', keydown !== undefined)
  keydown.handler({ key: 'Escape', preventDefault() {} })
  const leaving = await instance.renderer.deepRender(cards)
  check('Escape starts the close transition', firstByClass(leaving, 'dsse-layer')?.props?.['data-closing'] === 'true', String(firstByClass(leaving, 'dsse-layer')?.props?.['data-closing']))
  for (const entry of instance.timers.filter((row) => row.cleared === false && row.ms === 180)) entry.fn()
  await settle()
  const closed = await instance.renderer.deepRender(cards)
  check('the close transition unmounts the dialog', firstByClass(closed, 'dsse-dialog') === undefined)
  check('the trigger returns to its collapsed state', firstByClass(closed, 'dsse-queue')?.props?.['aria-expanded'] === false)
}

// ---------------------------------------------------------------------------
// Modal listeners are removed when the dialog closes
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
  const baseline = instance.listeners.slice()

  firstByClass(first, 'dsse-queue').props.onClick()
  await settle()
  await instance.renderer.deepRender(cards)
  const added = instance.listeners.filter((row) => baseline.includes(row) === false)
  check('opening the dialog adds one keydown listener', added.length === 1 && added[0].type === 'keydown', JSON.stringify(added.map((row) => row.type)))
  added[0].handler({ key: 'Escape', preventDefault() {} })
  for (const entry of instance.timers.filter((row) => row.cleared === false && row.ms === 180)) entry.fn()
  await settle()
  const after = await instance.renderer.deepRender(cards)
  check('the dialog is gone after closing', firstByClass(after, 'dsse-dialog') === undefined)
  instance.renderer.unmount()
  check('unmounting removes both modal and overlay listeners', instance.listeners.length === 0, JSON.stringify(instance.listeners.map((row) => row.type)))
}

// ---------------------------------------------------------------------------
// The trigger and dialog share an accessible relationship
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
  const closedButton = firstByClass(closed, 'dsse-queue')
  check('a closed dialog is not expanded', closedButton?.props?.['aria-expanded'] === false, JSON.stringify(closedButton?.props?.['aria-expanded']))
  check('the trigger names its dialog', closedButton?.props?.['aria-controls'] === 'dsse-candidate-dialog', JSON.stringify(closedButton?.props?.['aria-controls']))

  firstByClass(closed, 'dsse-queue').props.onClick()
  await settle()
  const opened = await instance.renderer.deepRender(cards)
  const openButton = firstByClass(opened, 'dsse-queue')
  check('an open dialog tells the trigger it is expanded', openButton?.props?.['aria-expanded'] === true, JSON.stringify(openButton?.props?.['aria-expanded']))
  check('the dialog id matches the trigger controls', firstByClass(opened, 'dsse-dialog')?.props?.id === openButton?.props?.['aria-controls'])
}

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = { ok: true, data: { candidates: [
    { id: 'a', name: 'pdf-tools', description: 'd', kind: 'create', body: 'B', whenToUse: '' },
  ] } }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const first = { disabled: false, offsetParent: {}, focus: () => { instance.document.activeElement = first } }
  const last = { disabled: false, offsetParent: {}, focus: () => { instance.document.activeElement = last } }
  instance.renderer.setNodeForRef(fakeNode({ left: 0, top: 0, width: 1920, height: 1000, focusable: [first, last], contains: [first, last] }))
  await openReview(instance)
  const keydown = instance.listeners.find((row) => row.type === 'keydown')
  check('the dialog focuses its first control on open', instance.document.activeElement === first)

  instance.document.activeElement = { tag: 'body' }
  keydown.handler({ key: 'Tab', preventDefault() {} })
  check('Tab from outside the dialog returns to the first control', instance.document.activeElement === first)
  instance.document.activeElement = { tag: 'body' }
  keydown.handler({ key: 'Tab', shiftKey: true, preventDefault() {} })
  check('Shift+Tab from outside returns to the last control', instance.document.activeElement === last)
  keydown.handler({ key: 'Tab', preventDefault() {} })
  check('Tab wraps from last to first', instance.document.activeElement === first)
  keydown.handler({ key: 'Tab', shiftKey: true, preventDefault() {} })
  check('Shift+Tab wraps from first to last', instance.document.activeElement === last)
}

// ---------------------------------------------------------------------------
// Typography follows the host's computed style and subsequent mutations
// ---------------------------------------------------------------------------

{
  const typography = {
    routes: panelRoutes(),
    fontFamily: 'Host Font A',
    monoFontFamily: 'Host Code A',
    fontSize: '15px',
    lineHeight: '24px',
  }
  const instance = boot(typography)
  instance.module.apply(instance.ctx)
  await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' })
  check('the panel reads the host font family', instance.hostStyle.get('--dsse-font-family') === 'Host Font A', String(instance.hostStyle.get('--dsse-font-family')))
  check('the panel reads the host mono font', instance.hostStyle.get('--dsse-font-mono') === 'Host Code A', String(instance.hostStyle.get('--dsse-font-mono')))
  check('the panel reads the host font size', instance.hostStyle.get('--dsse-font-size') === '15px', String(instance.hostStyle.get('--dsse-font-size')))
  check('the panel reads the host line height', instance.hostStyle.get('--dsse-line-height') === '24px', String(instance.hostStyle.get('--dsse-line-height')))
  check('typography watches the host root, body and conversation', instance.mutationObservers[0]?.targets.length === 3, String(instance.mutationObservers[0]?.targets.length))

  typography.fontFamily = 'Host Font B'
  typography.monoFontFamily = 'Host Code B'
  typography.fontSize = '17px'
  typography.lineHeight = '28px'
  instance.mutationObservers[0].callback()
  check('a host font mutation updates the panel', instance.hostStyle.get('--dsse-font-family') === 'Host Font B', String(instance.hostStyle.get('--dsse-font-family')))
  check('a host mono mutation updates code labels', instance.hostStyle.get('--dsse-font-mono') === 'Host Code B', String(instance.hostStyle.get('--dsse-font-mono')))
  check('a host size mutation updates the panel', instance.hostStyle.get('--dsse-font-size') === '17px', String(instance.hostStyle.get('--dsse-font-size')))
  check('a host line-height mutation updates the panel', instance.hostStyle.get('--dsse-line-height') === '28px', String(instance.hostStyle.get('--dsse-line-height')))
  const writesBeforeRepeat = instance.hostWrites.length
  instance.mutationObservers[0].callback([{ type: 'attributes' }])
  check('repeated sync does not rewrite identical typography', instance.hostWrites.length === writesBeforeRepeat, `${writesBeforeRepeat} → ${instance.hostWrites.length}`)
  typography.monoFontFamily = 'Host Code C'
  instance.mutationObservers[0].callback([{ type: 'childList', addedNodes: [{ matches: (selector) => selector === 'code, pre' }] }])
  check('inserting a code element refreshes the mono font', instance.hostStyle.get('--dsse-font-mono') === 'Host Code C', String(instance.hostStyle.get('--dsse-font-mono')))
  typography.monoFontFamily = 'Should Not Apply'
  instance.mutationObservers[0].callback([{ type: 'childList', addedNodes: [{ matches: () => false, querySelector: () => null }] }])
  check('ordinary transcript insertions do not trigger a typography write', instance.hostStyle.get('--dsse-font-mono') === 'Host Code C', String(instance.hostStyle.get('--dsse-font-mono')))
}

// ---------------------------------------------------------------------------
// A background refresh failure keeps the last good cards on screen
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  let reads = 0
  routes['/api/skill-evolve/panel'] = () => {
    reads += 1
    if (reads > 1) throw new Error('panel temporarily offline')
    return { ok: true, data: {
      turn: 7,
      calls: 12,
      failed: 0,
      summary: { text: 'keep this summary' },
      pendingCandidates: 0,
      skills: { available: true, skills: [{ name: 'kept-skill', owned: true, lastUsed: 2 }] },
      mcp: [{ server: 'kept-mcp', tools: 1, lastUsed: 1 }],
      files: [{ path: '/tmp/kept.md', bytes: 10, mtimeMs: 1 }],
      commands: [],
    } }
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  check('the first panel payload is visible', textOf(first).includes('keep this summary'), textOf(first).slice(0, 120))
  firstByClass(first, 'dsse-refresh').props.onClick()
  await settle()
  const failed = await instance.renderer.deepRender(cards)
  check('the refresh error is visible', textOf(failed).includes('panel temporarily offline'), textOf(failed).slice(0, 180))
  check('the last good summary remains visible', textOf(failed).includes('keep this summary'), textOf(failed).slice(0, 180))
  check('all three cards remain visible', byClass(failed, 'dsse-card').length === 3, String(byClass(failed, 'dsse-card').length))
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
  const opened = await openReview(instance)
  byAction(opened, 'discard').props.onClick()
  const confirming = await instance.renderer.deepRender(cards)
  byAction(confirming, 'confirm-discard').props.onClick()
  await settle()
  const body = JSON.parse(sent[0] ?? '{}')
  check('the decide call carries the id of the row that was clicked', body.id === 'stale', JSON.stringify(body))
  check('the decide call still carries the name', body.name === 'dup', JSON.stringify(body))
  check('the decide call says which action it was', body.action === 'discard', JSON.stringify(body))
}


// ---------------------------------------------------------------------------
// Slow responses cannot overwrite a newer session, queue, or config change
// ---------------------------------------------------------------------------

{
  const slowA = deferred()
  const routes = panelRoutes()
  routes['/api/skill-evolve/panel'] = (init, target) => {
    if (target.includes('agent=session-a')) return slowA.promise
    return { ok: true, data: {
      turn: 9, calls: 2, failed: 0, summary: { text: 'SESSION B' }, pendingCandidates: 0,
      skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
    } }
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  await instance.renderer.deepRender(cards)
  await instance.renderer.render(toggle, { sessionId: 'session-b' })
  const fastB = await instance.renderer.deepRender(cards)
  check('the newer session renders its own payload', textOf(fastB).includes('SESSION B'), textOf(fastB).slice(0, 100))
  slowA.resolve({ ok: true, data: {
    turn: 1, calls: 99, failed: 0, summary: { text: 'STALE SESSION A' }, pendingCandidates: 0,
    skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
  } })
  await settle()
  const after = await instance.renderer.deepRender(cards)
  check('a slow older session cannot overwrite the newer one', textOf(after).includes('SESSION B') && textOf(after).includes('STALE SESSION A') === false, textOf(after).slice(0, 140))
}

{
  const slowFirst = deferred()
  let reads = 0
  const routes = panelRoutes()
  routes['/api/skill-evolve/candidates'] = () => {
    reads += 1
    if (reads === 1) return slowFirst.promise
    return { ok: true, data: { candidates: [{ id: 'new', name: 'new-queue', description: 'new', kind: 'create', body: 'NEW', whenToUse: '' }] } }
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-queue').props.onClick()
  await instance.renderer.deepRender(cards)
  const reopened = await instance.renderer.deepRender(cards)
  firstByClass(reopened, 'dsse-queue').props.onClick()
  await settle()
  const fresh = await instance.renderer.deepRender(cards)
  check('the newest candidate response is visible', textOf(fresh).includes('new-queue'), textOf(fresh).slice(0, 120))
  slowFirst.resolve({ ok: true, data: { candidates: [{ id: 'old', name: 'stale-queue', description: 'old', kind: 'create', body: 'OLD', whenToUse: '' }] } })
  await settle()
  const after = await instance.renderer.deepRender(cards)
  check('a slow older candidate response cannot replace it', textOf(after).includes('new-queue') && textOf(after).includes('stale-queue') === false, textOf(after).slice(0, 140))
}

{
  const firstSave = deferred()
  const secondSave = deferred()
  const routes = panelRoutes()
  routes['/api/skill-evolve/config'] = (init) => {
    if (init?.method !== 'POST') return { ok: true, data: { panelSummary: true, panelSide: 'left', panelCollapsed: false } }
    const body = JSON.parse(String(init.body))
    return body.panelSummary === false ? firstSave.promise : secondSave.promise
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-settings-open').props.onClick()
  const settings = await instance.renderer.deepRender(cards)
  firstByClass(settings, 'dsse-check').props.onChange({ target: { checked: false } })
  const changedAgain = await instance.renderer.deepRender(cards)
  firstByClass(changedAgain, 'dsse-check').props.onChange({ target: { checked: true } })
  secondSave.resolve({ ok: true, data: { panelSummary: true, panelSide: 'left', panelCollapsed: false } })
  await settle()
  firstSave.resolve({ ok: true, data: { panelSummary: false, panelSide: 'left', panelCollapsed: false } })
  await settle()
  const after = await instance.renderer.deepRender(cards)
  check('an older config response cannot roll back the latest choice', firstByClass(after, 'dsse-check')?.props?.checked === true, String(firstByClass(after, 'dsse-check')?.props?.checked))
}

{
  const instance = boot({ routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-settings-open').props.onClick()
  const settings = await instance.renderer.deepRender(cards)
  const right = byClass(settings, 'dsse-side-option').find((node) => textOf(node) === '右侧')
  right.props.onClick()
  const moved = await instance.renderer.deepRender(cards)
  check('moving the panel keeps the loaded summary', textOf(moved).includes('Read three files and edited one'), textOf(moved).slice(0, 140))
  check('moving the panel still changes its side', firstByClass(moved, 'dsse-rail')?.props?.['data-side'] === 'right', String(firstByClass(moved, 'dsse-rail')?.props?.['data-side']))
}

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/config'] = (init) => {
    if (init?.method === 'POST') return { ok: true, data: { panelSummary: true, panelSide: 'left', panelCollapsed: false, ok: false, reason: 'settings are read only' } }
    return { ok: true, data: { panelSummary: true, panelSide: 'left', panelCollapsed: false } }
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-settings-open').props.onClick()
  const settings = await instance.renderer.deepRender(cards)
  byClass(settings, 'dsse-side-option').find((node) => textOf(node) === '右侧').props.onClick()
  await settle()
  const refused = await instance.renderer.deepRender(cards)
  check('a refused side change returns to the previous side', firstByClass(refused, 'dsse-rail')?.props?.['data-side'] === 'left', String(firstByClass(refused, 'dsse-rail')?.props?.['data-side']))
  check('the refusal is shown to the user', textOf(refused).includes('settings are read only'), textOf(refused).slice(0, 180))
  check('the refusal does not clear the loaded cards', textOf(refused).includes('Read three files and edited one'), textOf(refused).slice(0, 180))
}


// ---------------------------------------------------------------------------
// Switching to a session with nothing in it must not flash empty cards
//
// The reported bug: while a session was still being read, the panel drew its
// cards with placeholder text ("reading…") and then hid them a moment later, so
// switching to an empty session looked like a glitch. Nothing has to be drawn
// while the answer is in flight — the cards appear when it lands.
// ---------------------------------------------------------------------------

{
  const slowEmpty = deferred()
  const routes = panelRoutes()
  routes['/api/skill-evolve/panel'] = (init, target) => {
    if (target.includes('agent=empty-session')) return slowEmpty.promise
    return { ok: true, data: {
      turn: 4, calls: 3, failed: 0, summary: { text: 'SESSION FULL' }, pendingCandidates: 0,
      skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
    } }
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'full-session' }), 'dsse-toggle').props.onClick()
  const full = await instance.renderer.deepRender(cards)
  check('the filled session draws its card', textOf(full).includes('SESSION FULL'), textOf(full).slice(0, 100))

  await instance.renderer.render(toggle, { sessionId: 'empty-session' })
  const during = await instance.renderer.deepRender(cards)
  const duringHollow = during === null || (byClass(during, 'dsse-rail').length === 0 && byClass(during, 'dsse-card').length === 0)
  check('a session still being read leaves only an empty wrapper', duringHollow, JSON.stringify(during === null ? null : during.props?.style))
  check('a session still being read draws no cards at all', byClass(during, 'dsse-card').length === 0, String(byClass(during, 'dsse-card').length))
  check('and it does not draw the header buttons over nothing', firstByClass(during, 'dsse-refresh') === undefined, textOf(during).slice(0, 120))
  check('no loading placeholder is shown while it waits', textOf(during).includes('正在读取') === false, textOf(during).slice(0, 140))

  slowEmpty.resolve({ ok: true, data: {
    turn: 0, calls: 0, failed: 0, summary: { reason: 'no completed turn yet' }, pendingCandidates: 0,
    skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
  } })
  await settle()
  const after = await instance.renderer.deepRender(cards)
  check('an empty session stays empty once the answer lands', byClass(after, 'dsse-card').length === 0, String(byClass(after, 'dsse-card').length))
  check('and it reveals no chrome afterwards either', firstByClass(after, 'dsse-refresh') === undefined, textOf(after).slice(0, 120))
}

// ---------------------------------------------------------------------------
// A manual refresh keeps what is already on screen
//
// The reported regression: clicking refresh dropped the payload while the new
// answer was in flight, so every card vanished and the header buttons went with
// it. The loading state belongs to a session whose answer has never arrived; a
// refresh is not that.
//
// The route table holds plain envelopes, not functions — an earlier version of
// this block called the stored envelope as if it were a handler, so the panel
// rendered the resulting TypeError and "before" and "during" were the same error
// string. Assert on a real answer or the comparison is vacuous.
// ---------------------------------------------------------------------------

{
  const slow = deferred()
  const routes = panelRoutes()
  const firstAnswer = routes['/api/skill-evolve/panel']
  let served = 0
  routes['/api/skill-evolve/panel'] = () => {
    served += 1
    return served === 1 ? firstAnswer : slow.promise
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const settled = await instance.renderer.deepRender(cards)
  const beforeText = textOf(settled)
  check('the first answer is drawn before the refresh', beforeText.includes('Read three files and edited one.'), beforeText.slice(0, 120))

  const refresh = firstByClass(settled, 'dsse-refresh')
  check('the refresh button is on screen to click', refresh !== undefined, beforeText.slice(0, 120))
  refresh.props.onClick()
  const during = await instance.renderer.deepRender(cards)
  const duringText = textOf(during)
  check('a refresh in flight keeps the text it already drew', duringText.includes('Read three files and edited one.'), duringText.slice(0, 140))
  check('a refresh in flight keeps the header buttons', firstByClass(during, 'dsse-refresh') !== undefined && firstByClass(during, 'dsse-settings-open') !== undefined, duringText.slice(0, 140))
  check('a refresh in flight keeps the cards it already drew', byClass(during, 'dsse-card').length > 0, duringText.slice(0, 140))
  check('a refresh in flight shows no loading placeholder', duringText.includes('正在读取') === false, duringText.slice(0, 140))
}

// ---------------------------------------------------------------------------
// The summary fades only what it actually hides
//
// `data-clipped` used to be hardcoded true, so the 34px gradient was drawn over
// every summary — including one-liners, which are shorter than the gradient and
// came out half washed out. The mask is a claim about overflow, and overflow is a
// layout fact, so the fake node has to be able to report a difference between the
// scroll height and the box.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  const instance = boot({ routes, rect: { left: 280, top: 120, right: 1920, bottom: 420, width: 1640, height: 300 } })
  // A summary far taller than its box: this is the case that must fade.
  instance.renderer.setNodeForRef(fakeNode({ left: 280, top: 120, width: 1640, height: 300, overflowHeight: 900 }))
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const overflowing = await instance.renderer.deepRender(cards)
  check('a summary taller than its box is marked as clipped', firstByClass(overflowing, 'dsse-clip')?.props?.['data-clipped'] === 'true', textOf(overflowing).slice(0, 120))
}

{
  const routes = panelRoutes()
  const instance = boot({ routes, rect: { left: 280, top: 120, right: 1920, bottom: 420, width: 1640, height: 300 } })
  // The same tree with nothing hidden: no fade may be drawn.
  instance.renderer.setNodeForRef(fakeNode({ left: 280, top: 120, width: 1640, height: 300, overflowHeight: 300 }))
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const resting = await instance.renderer.deepRender(cards)
  check('a summary that fits is not marked as clipped', firstByClass(resting, 'dsse-clip')?.props?.['data-clipped'] === 'false', textOf(resting).slice(0, 120))
}

// ---------------------------------------------------------------------------
// Hidden chrome must not take the settings dialog with it
//
// The dialog is state-driven. Unmounting it while `settingsOpen` stays true means
// it reappears untouched the moment a later answer draws cards again — a dialog
// the user never reopened.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const open = await instance.renderer.deepRender(cards)
  firstByClass(open, 'dsse-settings-open').props.onClick()
  const withDialog = await instance.renderer.deepRender(cards)
  check('the settings dialog opens from the header', firstByClass(withDialog, 'dsse-settings-dialog') !== undefined, textOf(withDialog).slice(0, 120))

  // Now make every card disappear underneath the open dialog. The rail goes, but
  // the dialog must not: it is the thing the person is looking at, and unmounting
  // it here left `settingsOpen` true, so it reappeared on its own once cards came
  // back. Reachability is not the issue — nobody can reopen a dialog they believe
  // is already open.
  routes['/api/skill-evolve/panel'] = {
    ok: true,
    data: { turn: 0, calls: 0, failed: 0, summary: { reason: 'no completed turn yet' }, pendingCandidates: 0, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [] },
  }
  firstByClass(withDialog, 'dsse-refresh').props.onClick()
  await settle()
  const emptied = await instance.renderer.deepRender(cards)
  check('emptying the cards leaves the open settings dialog alone', firstByClass(emptied, 'dsse-settings-dialog') !== undefined, textOf(emptied).slice(0, 140))
  check('emptying the cards still hides the rail', firstByClass(emptied, 'dsse-rail') === undefined, textOf(emptied).slice(0, 140))
}

// ---------------------------------------------------------------------------
// Pending candidates are content
//
// The header button is the panel's only route to the review dialog. An empty
// session with work in the queue would otherwise hide the one control that shows
// there is work to do.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/skill-evolve/panel'] = {
    ok: true,
    data: { turn: 0, calls: 0, failed: 0, summary: { reason: 'no completed turn yet' }, pendingCandidates: 3, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [] },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  check('a queue with work in it keeps the header visible', firstByClass(tree, 'dsse-queue') !== undefined, textOf(tree).slice(0, 120))
  check('the queue button reports how much work there is', textOf(firstByClass(tree, 'dsse-queue')).includes('3'), textOf(tree).slice(0, 120))
}

console.log(`\n${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failed === 0 ? 0 : 1)
