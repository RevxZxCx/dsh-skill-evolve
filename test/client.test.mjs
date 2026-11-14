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
import { placeCards } from '../packages/ui-evolve/lib/gutter.js'

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
  // Which optional service groups `apply` asked for. Recorded even when the
  // service is missing, so "the plugin asks and copes" can be told apart from
  // "the plugin never asked".
  const injectedServices = []
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

  // A clock the fixture can move. `Date` is injected rather than left global for
  // the same reason the timers are: the speed badge keeps its last number for
  // four seconds, and with the real clock the only way to observe the number
  // expiring is to sleep through those four seconds — in every case. A boot with
  // no `now` keeps the real clock, so nothing that does not ask for time travel
  // is affected.
  const clock = { at: settings.now ?? 0, real: settings.now === undefined }
  if (clock.real === false) clock.at = settings.now
  // `now()` is what the bundle reads for ages and grace periods, and freezing it
  // is why this stub exists. It also needs a constructor: the card formats a
  // summary's timestamp with `new Date(at).toLocaleString()` for its tooltip, and
  // a bare `{ now }` makes that throw at render time. The real `Date` is the right
  // thing to build — the point of the stub is a fixed clock, not a fake calendar.
  const DateStub = function DateStub(...args) {
    return args.length === 0 ? new Date(clock.real === true ? Date.now() : clock.at) : new Date(...args)
  }
  DateStub.now = () => (clock.real === true ? Date.now() : clock.at)
  DateStub.parse = Date.parse
  DateStub.UTC = Date.UTC
  DateStub.prototype = Date.prototype

  const moduleTable = (id) => {
    requested.push(id)
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' }
    throw new Error(`the bundle required "${id}", which the shared module table does not carry`)
  }

  const code = rect === null ? null : {}
  // A host changes page in place, without a navigation: the launcher sends its
  // first message and the same document becomes a conversation. So the phase is
  // mutable here and `setPhase` flips it, rather than being baked in at boot —
  // a constant could only ever describe the first moment of the page's life.
  let phaseValue = settings.phase
  const conversation =
    rect === null ? null : {
      getBoundingClientRect: () => ({ ...rect }),
      offsetWidth: rect.width,
      // The host publishes which of its three pages this is on the conversation
      // body. The fixture defaults to a real conversation, which is what most
      // suites are describing; a suite that cares about the launcher passes
      // `phase: 'hero'` or `phase: 'settling'`, and `phase: null` is a host that
      // does not publish the attribute at all.
      getAttribute: (name) => (name === 'data-content-phase' ? (phaseValue === null ? null : (phaseValue ?? 'active')) : null),
      setPhase: (next) => { phaseValue = next },
      querySelector: (selector) => (selector === 'code, pre' ? code : null),
    }

  const documentStub = {
    baseURI: 'http://127.0.0.1:19387/',
    head: { appendChild: (node) => styles.push(node) },
    body: { attributes: new Map() },
    documentElement: {
      lang: settings.lang ?? '',
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

  const openedResources = []
  const sidebarStub = settings.sidebar === false
    ? undefined
    : {
        openResource: (address) => {
          if (settings.sidebarThrows === true) throw new Error('sidebarRight: nothing is on screen')
          openedResources.push(address)
        },
      }

  const ctx = {
    effect(register, label) {
      effects.push(label)
      return register()
    },
    // Optional services only. A child context exists when the service does, and
    // its absence is what a Host without a right sidebar looks like — the plugin
    // has to load either way, which is the whole reason this is not in `inject`.
    inject(names, register) {
      injectedServices.push(names.slice())
      if (names.includes('sidebarRight') === false) return () => {}
      if (sidebarStub === undefined) return () => {}
      const child = {
        sidebarRight: sidebarStub,
        effect(inner, label) {
          effects.push(label)
          return inner()
        },
      }
      const dispose = register(child)
      return typeof dispose === 'function' ? dispose : () => {}
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
    // Absent unless a fixture supplies one, which is the state of a Host served
    // over plain http: navigator.clipboard lives in secure contexts only, so
    // the copy buttons must not be drawn at all. Tests that describe a clipboard
    // set this explicitly.
    navigator: settings.navigator,
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
      // A held request takes time, and the client measures that time with the
      // injected clock — `schedule()` runs after the answer arrives, so "how
      // long was the request held" is the whole input to the next delay. Making
      // the fixture advance the clock is how a test can say "this host held it
      // for the full window" without real waiting; a suite that slept 25
      // seconds per case would be neither fast nor deterministic.
      if (settings.latency !== undefined) {
        clock.at += typeof settings.latency === 'function' ? settings.latency(path) : settings.latency
      }
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


  const source = readFileSync(join(repo, 'packages', 'ui-evolve', 'lib', 'client.js'), 'utf8')
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
    source,
  )
  // `setTimeout` is injected rather than left global because the hover grace
  // period is a real close delay: with the global timer and assertions that only
  // await microtasks, the deferred close never runs and every assertion about it
  // passes whether or not the code schedules anything. Fixtures either drive
  // these by hand or wait on the real clock.
  //
  // `setInterval` gets the same treatment for a smaller reason: a fixture that
  // wants to assert the panel's delay has to see the handle it asked for, and a
  // stub returning a constant shows the delay to nobody.
  evaluate(
    windowStub,
    documentStub,
    fetchStub,
    computed,
    (fn, ms) => {
      const handle = (settings.setInterval ?? setInterval)(fn, ms)
      timers.push({ fn, ms, handle, cleared: false })
      return handle
    },
    (handle) => {
      const row = timers.find((entry) => entry.handle === handle)
      if (row !== undefined) row.cleared = true
      ;(settings.clearInterval ?? clearInterval)(handle)
    },
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
    DateStub,
  )

  const module = captured.factory(moduleTable)

  return {
    module,
    ctx,
    listeners,
    registrations,
    effects,
    injectedNames,
    injectedServices,
    openedResources,
    requested,
    calls,
    styles,
    timers,
    hostStyle,
    hostWrites,
    mutationObservers,
    clock,
    document: documentStub,
    conversation,
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
    '/api/ui-evolve/panel': {
      ok: true,
      data: {
        turn: 7,
        calls: 12,
        failed: 1,
        // Deliberately different from `files.length` below. The row of three
        // numbers beside the title describes the turn that ended, and `files` is
        // the whole session's work since the output card became cumulative; a
        // fixture where the two agree cannot tell the two apart.
        turnFiles: 1,
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
        // Two files, one turn-file. The row beside the title describes the turn
        // that ended, so its file count must come from `turnFiles`; the output
        // card below lists the whole session's work. A fixture where the two
        // numbers agree cannot tell an implementation that reads the cumulative
        // length apart from one that reads the turn's, which is the exact
        // substitution that shipped once already.
        files: [
          { path: '/tmp/out/report.md', bytes: 2048, mtimeMs: 20 },
          { path: '/tmp/out/older.md', bytes: 1024, mtimeMs: 10 },
        ],
      },
    },
    '/api/ui-evolve/config': {
      ok: true,
      data: { panelSummary: true, panelSide: 'left', panelCollapsed: false },
    },
    '/api/ui-evolve/models': { ok: true, data: { providers: [{ provider: 'p', models: [{ id: 'm', name: 'M' }] }] } },
    '/api/ui-evolve/propose': { ok: true, data: { hinted: true } },
    '/api/ui-evolve/candidates': { ok: true, data: { candidates: [] } },
  }
}

// ---------------------------------------------------------------------------
// Loader contract
// ---------------------------------------------------------------------------

const booted = boot()

check('the bundle registers itself under the plugin id', booted.captured.id === '@revxz/dsh-ui-evolve', String(booted.captured.id))
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
// Named rather than counted: the count alone passed while a new effect could be
// added anywhere, and what matters is that each one is registered under its own
// label so its dispose shows up as its own line in the plugin's lifetime.
check(
  'four effects are declared, each named',
  JSON.stringify(booted.effects) === JSON.stringify([
    'skill-evolve: panel toggle',
    'skill-evolve: card overlay',
    'skill-evolve: panel teardown',
    'skill-evolve: sidebar preview',
  ]),
  JSON.stringify(booted.effects),
)

for (const { spec } of booted.registrations) {
  const expected = spec.id.endsWith(':toggle') ? 'conversation.session.header.actions' : 'shell.overlay'
  check(`"${spec.id}" declares the slot it registers into`, spec.name === expected, `${spec.id} → ${spec.name}`)
  check(`"${spec.id}" names this plugin as registrant`, spec.registrant === '@revxz/dsh-ui-evolve', String(spec.registrant))
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
    instance.calls.some((row) => row.url.endsWith('/api/ui-evolve/config')),
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
      '/api/ui-evolve/config': {
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
      '/api/ui-evolve/config': () => configAnswer,
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
      '/api/ui-evolve/config': {
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
// A failed summary says so in the reader's language
//
// The reasons are English sentences produced by the summariser and matched here
// by prefix. That split is a hazard worth a test: the two files have no type
// between them, so a reason spelled one way and matched another way renders as
// the generic fallback and nothing fails. It shipped exactly once —
// `the summary call failed: …` was matched as `the model call failed` — and the
// card said "暂无摘要" for the one failure a person is most likely to hit.
//
// Every reason below is copied from a return statement in summarise.js. The
// assertion is that the panel does not show the generic fallback for it, which
// is the only claim that stays true as the wording evolves.
// ---------------------------------------------------------------------------

{
  const reasons = [
    'turned off',
    'turned off in settings',
    'no completed turn yet',
    'the turn left nothing to summarise',
    'no model service available',
    'no model route is available',
    'the summary call timed out',
    'the summary call failed: 401 Unauthorized',
    'the summary call failed: fetch failed',
    'the model call failed: stream ended early',
    'the model returned nothing',
  ]
  for (const reason of reasons) {
    const routes = panelRoutes()
    routes['/api/ui-evolve/panel'] = {
      ok: true,
      data: { turn: 7, calls: 1, failed: 0, turnFiles: 0, summary: { reason }, pendingCandidates: 0, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [] },
    }
    const instance = boot({ routes })
    instance.module.apply(instance.ctx)
    firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
    const tree = await instance.renderer.deepRender(instance.seat('cards'))
    check(`a failure reason is translated rather than shown raw: ${reason}`, textOf(tree).includes(reason) === false, textOf(tree).slice(0, 160))
    check(`and it does not fall through to the generic line: ${reason}`, textOf(tree).includes('暂无摘要') === false, textOf(tree).slice(0, 160))
  }

  // "Nothing was shown raw" is too weak on its own: a card that prints one fixed
  // sentence for every reason passes it, and so does a transposed mapping —
  // somebody reading "摘要生成超时" because the model returned nothing would wait
  // for a retry instead of re-running the turn. So the copy is grouped by what a
  // reader can act on, and the property asserted is the one that matters:
  // **different groups read differently, and every reason in a group reads the
  // same**. The second half is not redundant — it is what catches a transposition
  // that lands a specific sentence in the wrong group.
  //
  // The groups are deliberately coarse. A 401 and a dropped socket are one class
  // to the reader ("the call failed, try again"); the difference between them
  // belongs in the tooltip, which is asserted separately below.
  // Distinctness across groups alone is not enough: **swapping two branches'
  // sentences** keeps every group distinct while telling an idle reader
  // "摘要生成超时" when the model simply returned nothing. So each group also
  // carries the one word a reader could not do without — the meaning of that
  // failure, not its wording. A reworded sentence still contains it; a
  // transposed one does not.
  const copyGroups = new Map([
    ['turned off', { word: '关闭', reasons: ['turned off', 'turned off in settings'] }],
    ['no completed turn', { word: '回合', reasons: ['no completed turn yet'] }],
    ['nothing to summarise', { word: '可总结', reasons: ['the turn left nothing to summarise'] }],
    ['no model service', { word: '模型服务', reasons: ['no model service available'] }],
    ['no model route', { word: '路由', reasons: ['no model route is available'] }],
    ['timeout', { word: '超时', reasons: ['the summary call timed out'] }],
    ['call failed', { word: '失败', reasons: ['the summary call failed: 401 Unauthorized', 'the summary call failed: fetch failed', 'the model call failed: stream ended early'] }],
    ['empty', { word: '没有返回', reasons: ['the model returned nothing'] }],
  ])
  const rendered = new Map()
  for (const [group, entry] of copyGroups) {
    for (const reason of entry.reasons) {
      const routes = panelRoutes()
      routes['/api/ui-evolve/panel'] = {
        ok: true,
        data: { turn: 7, calls: 1, failed: 0, turnFiles: 0, summary: { reason }, pendingCandidates: 0, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [] },
      }
      const instance = boot({ routes })
      instance.module.apply(instance.ctx)
      firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
      const tree = await instance.renderer.deepRender(instance.seat('cards'))
      rendered.set(reason, { group, word: entry.word, text: textOf(tree) })
    }
  }

  const byGroup = new Map()
  for (const [reason, { group, word, text }] of rendered) {
    check(`the reader is told what kind of failure this is: ${reason}`, text.includes(word), `${JSON.stringify(reason)} renders ${JSON.stringify(text)}, which never says ${JSON.stringify(word)}`)
    const prior = byGroup.get(group)
    check(`a reason reads the same as its own class: ${reason}`, prior === undefined || prior.text === text, `${JSON.stringify(prior?.reason)} and ${JSON.stringify(reason)} differ inside ${group}`)
    if (prior === undefined) byGroup.set(group, { reason, text })
  }
  // Distinctness across classes, which is the only version of "specific" that
  // does not pin the wording.
  const groups = [...byGroup.keys()]
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const a = byGroup.get(groups[i])
      const b = byGroup.get(groups[j])
      check(`"${groups[i]}" and "${groups[j]}" do not read the same`, a.text !== b.text, `both render ${JSON.stringify(a.text)}`)
    }
  }
}

{
  // The English original is not thrown away — it is moved to a tooltip, which is
  // where a reader who wants to report a 401 can still find it.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: { turn: 7, calls: 1, failed: 0, turnFiles: 0, summary: { reason: 'the summary call failed: 401 Unauthorized' }, pendingCandidates: 0, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [] },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  check('the failure is stated in words', textOf(tree).includes('摘要生成失败'), textOf(tree).slice(0, 160))
  // The tooltip lives on the <p>, not on the .dsse-clip box: the box is what the
  // fade is drawn on, and a title there would cover the padding too.
  const paragraph = firstByClass(tree, 'dsse-text')
  check('the provider message survives in the tooltip', paragraph?.props?.title === 'the summary call failed: 401 Unauthorized', String(paragraph?.props?.title))
}

{
  // A dated card says how old the telling is. The timestamp has to come from the
  // payload: computing it at render time would make every 8-second poll claim a
  // fresh summary, which reads as the model having just run.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 7, calls: 1, failed: 0, turnFiles: 0,
      summary: { text: 'Fixed the fixture.', at: Date.now() - 5 * 60 * 1000 },
      pendingCandidates: 0, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const ago = firstByClass(tree, 'dsse-head-ago')
  check('a summary carries the time it was written', ago !== undefined && textOf(ago).includes('更新于'), textOf(ago))
  check('the age is relative, not a clock reading', /更新于\s*5\s*分钟前/u.test(textOf(ago)), textOf(ago))
}

{
  // A failed summary has no time, and producing one would be a lie of a specific
  // kind: "生成失败 · 3 分钟前" invites the reader to wait for a retry that is
  // never scheduled, because the only retry is the next completed turn.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: { turn: 7, calls: 1, failed: 0, turnFiles: 0, summary: { reason: 'the summary call timed out' }, pendingCandidates: 0, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [] },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  check('a failure is not given a time', firstByClass(tree, 'dsse-head-ago') === undefined, textOf(tree).slice(0, 160))
}

// ---------------------------------------------------------------------------
// Opening: the cards fetch, unwrap and render
// ---------------------------------------------------------------------------

{
  const instance = boot({ routes: panelRoutes(), lang: 'zh-CN' })
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
    const sheet = readFileSync(join(repo, 'packages', 'ui-evolve', 'lib', 'client.js'), 'utf8')
    check('the top row carries a background, a border and a radius', /\.dsse-top-row\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(sheet) && /\.dsse-top-row\{[^}]*border:1px solid/.test(sheet) && /\.dsse-top-row\{[^}]*border-radius:10px/.test(sheet), 'top-row rule')
  }
  check('the card header carries the call count', firstHead !== undefined && textOf(firstHead).includes('12'), textOf(tree).slice(0, 120))
    // Numbers, not just labels: swapping the command count for the file count used
    // to leave every assertion green because both were labelled.
    const headStats = firstHead === undefined ? [] : byClass(firstHead, 'dsse-head-stat').map((node) => textOf(node))
    check('the card header carries the command count', headStats.some((row) => /^0\s*命令$/.test(row)), JSON.stringify(headStats))
    check('the card header carries the file count', headStats.some((row) => /^1\s*文件$/.test(row)), JSON.stringify(headStats))
    check('the old stat strip is gone', firstByClass(tree, 'dsse-facts') === undefined, textOf(tree).slice(0, 160))
    check('the header carries no action button', firstHead !== undefined && firstByClass(firstHead, 'dsse-propose') === undefined && firstByClass(firstHead, 'dsse-head-btn') === undefined, textOf(tree).slice(0, 160))
    // Cards without a `head` still get their metadata from `meta`. Both paths have
    // to be pinned: removing the fallback would silently empty two headers. The
    // count here is the cumulative one, not `turnFiles` — this card lists the
    // session's work, and the fixture deliberately makes the two numbers differ.
    const metas = byClass(tree, 'dsse-card-meta').map((node) => textOf(node))
    check('a card without a custom head still shows its meta', metas.includes('2 技能 · 1 服务') && metas.includes('2 个文件'), JSON.stringify(metas))
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
  // The summary is written in the language of the conversation, which the model
  // reads out of the transcript, so the panel no longer sends the interface
  // language. `<html lang>` still exists for the host's own use; what this
  // asserts is that the bundle has stopped treating it as a second source of
  // truth for a question the transcript already answers.
  check(
    'the panel asks for no interface language',
    instance.calls.some((row) => row.url.includes('/panel?')) && instance.calls.every((row) => row.url.includes('lang=') === false),
    JSON.stringify(instance.calls.map((row) => row.url)),
  )
  // The timer is the panel's only way of learning anything. It cannot be told
  // that a turn ended or that a file on disk was touched, so the delay is part of
  // the contract rather than an implementation detail: a constant nobody asserts
  // is a constant anybody can shorten to 100ms, and the comment beside it would
  // still say "every few seconds". The fixture keeps the handle for exactly this.
  const polls = instance.timers.filter((row) => row.ms === 8000 && row.cleared === false)
  check(
    'the panel asks again on a timer',
    polls.length === 1,
    JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])),
  )
  if (polls.length === 1 && typeof polls[0].fn === 'function') {
    const before = instance.calls.length
    polls[0].fn()
    await settle()
    check(
      'and firing it asks the panel again',
      instance.calls.length > before,
      `${before} -> ${instance.calls.length}`,
    )
  }
  // A timer that outlives its component keeps a switched-away session's panel
  // polling forever, and each one adds up for the life of the window.
  instance.renderer.unmount()
  check(
    'unmounting stops the timer',
    instance.timers.every((row) => row.ms !== 8000 || row.cleared === true),
    JSON.stringify(instance.timers.filter((row) => row.ms === 8000).map((row) => row.cleared)),
  )
}

// ---------------------------------------------------------------------------
// The compact top row, merged activity list, and empty-card hiding
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
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
  routes['/api/ui-evolve/panel'] = {
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
      '/api/ui-evolve/config': {
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
  const instance = boot({ routes: { ...panelRoutes(), '/api/ui-evolve/panel': new Error('the panel endpoint answered 500') } })
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
  const instance = boot({ routes: { ...panelRoutes(), '/api/ui-evolve/panel': { ok: false, code: 'internal', error: 'queue unreadable' } } })
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
  // A route whose files carry the preview address, because a row only becomes a
  // button when the Host handed it one. `panelRoutes()` predates addresses, so
  // clicking anything in it would prove nothing about the channel.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'].data.files = [
    { path: '/tmp/out/report.md', bytes: 2048, mtimeMs: 20, address: 'dsh-resource://file/session/session-a/tmp/out/report.md' },
    { path: '/tmp/out/older.md', bytes: 1024, mtimeMs: 10, address: 'dsh-resource://file/session/session-a/tmp/out/older.md' },
  ]
  const instance = boot({ routes })
  // Labelled, because the two owners of the preview channel have to be tried
  // separately: releasing both and checking the log afterwards cannot say which
  // one released it.
  const disposers = []
  const sidebarOpened = []
  // Built as a factory so the plugin can be loaded a second time later: the
  // channel is rebound by running `apply` again, not by hand, because a hand-made
  // rebind would test this file's idea of the contract instead of the plugin's.
  const makeCtx = () => ({
    effect(register, label) {
      const dispose = register()
      if (typeof dispose === 'function') disposers.push({ label, dispose })
      return () => {}
    },
    // The sidebar's own effect is registered through `child.effect`, so its
    // dispose has to land in the same list as the rest — otherwise this test
    // would report a clean teardown while leaving the preview channel bound.
    inject: (names, register) => {
      if (names.includes('sidebarRight') === false) return () => {}
      const child = {
        sidebarRight: { openResource: (address) => sidebarOpened.push(address) },
        effect(inner, label) {
          const dispose = inner()
          if (typeof dispose === 'function') disposers.push({ label, dispose })
          return () => {}
        },
      }
      const dispose = register(child)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: { inject: (name, register) => register(), register: (spec, Component) => {
      instance.registrations.push({ spec, Component })
      return () => {}
    } },
  })
  instance.module.apply(makeCtx())
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  check('open before teardown', (await instance.renderer.deepRender(cards)) !== null)
  // Click a row while the channel is still bound. Without this the assertion
  // below cannot tell "the preview channel was released" from "nothing was ever
  // opened" — an empty log is what both look like, which is why deleting both
  // resets used to keep this suite green.
  const beforeTeardown = await instance.renderer.deepRender(cards)
  const rowBefore = firstByClass(beforeTeardown, 'dsse-row-open')
  check('a row offers a preview before teardown', rowBefore !== undefined && typeof rowBefore.props?.onClick === 'function')
  rowBefore?.props?.onClick?.()
  check('the preview channel was bound before teardown', sidebarOpened.length === 1, JSON.stringify(sidebarOpened))
  // The two resets are exercised one at a time. Releasing both and then looking at
  // the log cannot say which one released the channel, and that is exactly how
  // both of them stayed untested while the suite was green.
  //
  // First the sidebar's own effect: a Host can take the service away while the
  // plugin is still loaded, and every row has to stop pretending it can open a
  // preview.
  const sidebarEffect = disposers.find((row) => row.label === 'skill-evolve: sidebar preview')
  check('the sidebar channel is registered as its own effect', sidebarEffect !== undefined, JSON.stringify(disposers.map((row) => row.label)))
  sidebarEffect?.dispose()
  const afterDrop = await instance.renderer.deepRender(cards)
  const rowAfterDrop = firstByClass(afterDrop, 'dsse-row-open')
  check('a row stops being a button when the sidebar goes away', rowAfterDrop === undefined, JSON.stringify(byClass(afterDrop, 'dsse-row').length))
  firstByClass(afterDrop, 'dsse-row')?.props?.onClick?.()
  check('and it cannot reach the service it no longer has', sidebarOpened.length === 1, JSON.stringify(sidebarOpened))
  // The service coming back has to restore the channel, not leave the panel
  // permanently degraded. Loading the plugin again is what a Host does when the
  // sidebar reappears, and it is the only path that can rebind `openResource`.
  instance.module.apply(makeCtx())
  const rebound = await instance.renderer.deepRender(cards)
  const rowRebound = firstByClass(rebound, 'dsse-row-open')
  check('and the rows come back when the sidebar does', rowRebound !== undefined, JSON.stringify(byClass(rebound, 'dsse-row').length))
  rowRebound?.props?.onClick?.()
  check('a rebound row reaches the sidebar again', sidebarOpened.length === 2, JSON.stringify(sidebarOpened))
  // Now the plugin's own teardown, with the channel bound again.
  const panelTeardown = disposers.find((row) => row.label === 'skill-evolve: panel teardown')
  check('the plugin registers its own teardown', panelTeardown !== undefined, JSON.stringify(disposers.map((row) => row.label)))
  panelTeardown?.dispose()
  check('teardown closes the cards', (await instance.renderer.deepRender(cards)) === null)
  // Re-open the panel after the teardown and click the same row again. The
  // plugin is gone, so nothing may reach the sidebar a second time; a channel
  // left bound by an incomplete teardown would answer here.
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const afterTeardown = await instance.renderer.deepRender(cards)
  const rowAfter = firstByClass(afterTeardown, 'dsse-row-open')
  rowAfter?.props?.onClick?.()
  check('a torn-down panel cannot open a preview', sidebarOpened.length === 2, JSON.stringify(sidebarOpened))
  for (const row of disposers) row.dispose()
  const phaseObservers = instance.mutationObservers.filter((observer) =>
    observer.targets.some((entry) => (entry.options?.attributeFilter ?? []).includes('data-content-phase')))
  const typographyObservers = instance.mutationObservers.filter((observer) => phaseObservers.includes(observer) === false)
  check('teardown disconnects typography observers', typographyObservers.length > 0 && typographyObservers.every((observer) => observer.disconnected), JSON.stringify(typographyObservers.map((observer) => observer.disconnected)))
  // The phase observer belongs to the overlay's own React effect, so it outlives
  // the service teardown above by design and is released when the overlay
  // unmounts. Two observers with two lifespans cannot share one assertion:
  // asking `every` here reported "the typography observer leaked" about a
  // component that was still mounted, which is the wrong sentence for the
  // failure — and it also meant nothing tested the unmount path.
  instance.renderer.unmount()
  check('unmounting disconnects every observer the overlay opened', instance.mutationObservers.every((observer) => observer.disconnected), JSON.stringify(instance.mutationObservers.map((observer) => observer.disconnected)))
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
  routes['/api/ui-evolve/candidates'] = {
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
    routes['/api/ui-evolve/candidates'] = item.route
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
  routes['/api/ui-evolve/candidates'] = {
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
  routes['/api/ui-evolve/candidates'] = {
    ok: true,
    data: {
      candidates: [
        { id: 'a', name: 'pdf-tools', description: 'work with pdfs', kind: 'create', body: 'BODY-A', whenToUse: '' },
        { id: 'b', name: 'office', description: '', kind: 'update', body: 'BODY-B', whenToUse: '' },
      ],
    },
  }
  routes['/api/ui-evolve/candidates'] = (init) => {
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
  routes['/api/ui-evolve/candidates'] = (init) =>
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
  routes['/api/ui-evolve/candidates'] = (init) =>
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
  routes['/api/ui-evolve/candidates'] = { ok: true, data: { candidates: [
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
  routes['/api/ui-evolve/candidates'] = { ok: true, data: { candidates: [
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
  routes['/api/ui-evolve/candidates'] = { ok: true, data: { candidates: [
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
  routes['/api/ui-evolve/candidates'] = { ok: true, data: { candidates: [
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
  routes['/api/ui-evolve/candidates'] = { ok: true, data: { candidates: [
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
  routes['/api/ui-evolve/panel'] = () => {
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
  routes['/api/ui-evolve/candidates'] = (init) => {
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
  routes['/api/ui-evolve/panel'] = (init, target) => {
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
  routes['/api/ui-evolve/candidates'] = () => {
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
  routes['/api/ui-evolve/config'] = (init) => {
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
  routes['/api/ui-evolve/config'] = (init) => {
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
// switching to an empty session looked like a glitch.
//
// The fix then was to draw nothing at all while the answer was in flight. That
// went too far the other way: opening the panel on a session that had not
// answered yet showed a stranger a blank column with no explanation, and "still
// reading" is not the same fact as "this conversation has done nothing". The
// narrow answer is one line, not one column: the loading line appears, the cards
// and the header buttons do not, so there is nothing to flash away from when the
// answer lands.
// ---------------------------------------------------------------------------

{
  const slowEmpty = deferred()
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = (init, target) => {
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
  check('a session still being read says so', textOf(during).includes('正在加载'), textOf(during).slice(0, 140))
  check('a session still being read draws no cards at all', byClass(during, 'dsse-card').length === 0, String(byClass(during, 'dsse-card').length))
  check('and it does not draw the header buttons over nothing', firstByClass(during, 'dsse-refresh') === undefined, textOf(during).slice(0, 120))

  slowEmpty.resolve({ ok: true, data: {
    turn: 0, calls: 0, failed: 0, summary: { reason: 'no completed turn yet' }, pendingCandidates: 0,
    skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
  } })
  await settle()
  const after = await instance.renderer.deepRender(cards)
  check('an empty session stays empty once the answer lands', byClass(after, 'dsse-card').length === 0, String(byClass(after, 'dsse-card').length))
  check('and the loading line goes when the answer lands', textOf(after).includes('正在加载') === false, textOf(after).slice(0, 140))
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
  const firstAnswer = routes['/api/ui-evolve/panel']
  let served = 0
  routes['/api/ui-evolve/panel'] = () => {
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
// The 上一轮 card opens for two separate reasons
//
// A pointer resting on the card opens it, and a click pins it open. Those are two
// independent facts, so the drop tests are not "the card is open" but "which
// reason is still standing": a click while hovering must not clear the pointer's
// reason and collapse the card under the pointer, and moving away while pinned
// must not clear the click's. The mutation that merges the two booleans is the
// one these assertions exist to kill, and it does not fail any test that only
// inspects "open".
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  const instance = boot({ routes })
  instance.renderer.setNodeForRef(fakeNode({ left: 280, top: 120, width: 1640, height: 300, overflowHeight: 900 }))
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const expandedOf = (tree) => firstByClass(tree, 'dsse-clip')?.props?.['data-expanded']
  const turnCard = (tree) => byClass(tree, 'dsse-card')[0]

  // The harness renders a child component in a pass of its own, so the clip's
  // measurement reaches `Cards` one render after the clip reports it. React does
  // not have that gap — a layout effect and the state it sets land in the same
  // commit — so this is the harness catching up, not the component settling.
  const settle = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }

  /**
   * Click the 上一轮 card, or fail the check that says it was clickable at all.
   *
   * A suite that throws prints no FAIL line and the mutation runner counts FAIL
   * lines, so an unguarded call turns every mutation that removes the handler into
   * a phantom survivor. The guard keeps the failure visible as a FAIL.
   *
   * @param {object} tree - the rendered panel.
   * @returns {boolean} whether a handler was there to call.
   */
  const press = (tree) => {
    const handler = turnCard(tree)?.props?.onClick
    check('the card answers a click', typeof handler === 'function', String(typeof handler))
    if (typeof handler !== 'function') return false
    handler()
    return true
  }

  const begin = await settle()
  check('a tall summary starts collapsed', expandedOf(begin) === 'false', textOf(begin).slice(0, 120))
  check('a collapsed summary with more to show fades', firstByClass(begin, 'dsse-clip')?.props?.['data-clipped'] === 'true', textOf(begin).slice(0, 120))
  check('a card with more to show invites a click', turnCard(begin)?.props?.['data-clickable'] === 'true', String(turnCard(begin)?.props?.['data-clickable']))
  check('and it is reachable from the keyboard', turnCard(begin)?.props?.tabIndex === 0 && turnCard(begin)?.props?.role === 'button', JSON.stringify([turnCard(begin)?.props?.tabIndex, turnCard(begin)?.props?.role]))
  check('a collapsed card says it is not expanded', turnCard(begin)?.props?.['aria-expanded'] === false, String(turnCard(begin)?.props?.['aria-expanded']))

  // Hovering offers, it does not open. Pointing at the card used to open it, which
  // moved the text under the pointer — motion the reader did not ask for and could
  // not stop without moving away. The pointer now only reveals a label saying the
  // card can be opened, and the card still has to be clicked.
  turnCard(begin).props.onMouseEnter()
  const hovered = await instance.renderer.deepRender(cards)
  check('hovering a clipped summary does not open it', expandedOf(hovered) === 'false', textOf(hovered).slice(0, 120))
  check('hovering offers to open it', turnCard(hovered)?.props?.['data-hint'] === 'true', String(turnCard(hovered)?.props?.['data-hint']))
  // The offer is a round badge with a chevron in it, so the words are no longer
  // text children — they live on `aria-label`, which is what a screen reader reads.
  // There is deliberately no `title`: the badge has `pointer-events: none`, so it
  // never becomes a hit target and a native tooltip on it could not appear. The
  // accessible name is the only thing carrying those words, which is exactly why
  // this assertion reads the label rather than the rendered text.
  const offer = firstByClass(hovered, 'dsse-expand')
  check('and the offer says what the click will do', offer?.props?.['aria-label'] === '点击展开全文', String(offer?.props?.['aria-label']))
  check('the offer is a button with an icon, not a line of text', (offer?.props?.children?.props?.className ?? '').includes('dsse-icon'), JSON.stringify(offer?.props?.children?.props?.className))
  // The badge sits centred on the card's bottom edge rather than under the summary,
  // so revealing it costs no layout. That is the whole reason it was moved out of
  // the flow: the older strip grew a hovered card by twenty-six pixels and every
  // pointer that crossed the column nudged the text below it.
  const expandSheet = instance.styles.map((node) => String(node.textContent)).join('\n')
  check('the offer is pinned to the bottom edge, out of the flow', /\.dsse-expand\{[^}]*position:absolute/.test(expandSheet), (expandSheet.match(/\.dsse-expand\{[^}]*\}/) ?? [''])[0].slice(0, 140))
  check('and it hangs in the middle of that edge', /\.dsse-expand\{[^}]*left:50%/.test(expandSheet) && /\.dsse-expand\{[^}]*translateX\(-50%\)/.test(expandSheet))
  check('and the card is the box it is pinned to', /\.dsse-card\{[^}]*position:relative/.test(expandSheet))
  check('the offer is round', /\.dsse-expand\{[^}]*border-radius:999px/.test(expandSheet))
  check('the offer takes no clicks of its own', /\.dsse-expand\{[^}]*pointer-events:none/.test(expandSheet))
  // An open card reserves room for the badge. Without the padding the badge would
  // sit on top of the last line of the summary it just revealed — the one part of
  // the card the click was for.
  check('an open card keeps its last line clear of the badge', /\.dsse-card\[aria-expanded="true"\] \.dsse-card-body\{[^}]*padding-bottom:44px\}/.test(expandSheet), (expandSheet.match(/\.dsse-card\[aria-expanded="true"\][^}]*\}/) ?? [''])[0].slice(0, 120))
  check('a hovered card still reports itself closed', turnCard(hovered)?.props?.['aria-expanded'] === false, String(turnCard(hovered)?.props?.['aria-expanded']))

  // Leaving takes the offer away with it, and only the offer: being able to open
  // the card is a fact about the text, not about the pointer. A card that lost
  // its `data-clickable` here would be the "open with no way out" defect wearing
  // a different hat — the pointer is not even over it any more.
  turnCard(hovered).props.onMouseLeave()
  const left = await instance.renderer.deepRender(cards)
  check('leaving the card withdraws the offer', turnCard(left)?.props?.['data-hint'] === 'false', String(turnCard(left)?.props?.['data-hint']))
  check('and the card can still be opened', turnCard(left)?.props?.['data-clickable'] === 'true', String(turnCard(left)?.props?.['data-clickable']))

  // Point at it again so the click below happens on a hovered card, which is the
  // arrangement whose two reasons must stay independent.
  turnCard(left).props.onMouseEnter()
  const rehovered = await instance.renderer.deepRender(cards)

  // The click is what opens it.
  press(rehovered)
  const opened = await instance.renderer.deepRender(cards)
  check('clicking a clipped summary opens it', expandedOf(opened) === 'true', textOf(opened).slice(0, 120))
  check('an open summary keeps its measurement', firstByClass(opened, 'dsse-clip')?.props?.['data-clipped'] === 'true', 'the measurement should survive the expansion')
  check('an open summary draws no fade', firstByClass(opened, 'dsse-clip')?.props?.['data-expanded'] === 'true', 'the fade is gated on data-expanded, so that is what says whether it is drawn')
  check('and it reports itself expanded', turnCard(opened)?.props?.['aria-expanded'] === true, String(turnCard(opened)?.props?.['aria-expanded']))
  // An open card keeps its badge and says what the next click will do. Hiding the
  // way out while the card is open is the worst possible moment for it: the pointer
  // is not a reliable witness — it may have left the card already — and the click
  // that opened the card is exactly what closed it before.
  const closing = firstByClass(opened, 'dsse-expand')
  check('an open card still shows the way out', closing !== undefined, String(closing === undefined))
  check('and it says the click will close it', closing?.props?.['aria-label'] === '点击收起全文', String(closing?.props?.['aria-label']))
  // The chevron points up when the card is open and down when it is not, so the
  // glyph is a promise about the click rather than decoration.
  const openedPath = firstByClass(opened, 'dsse-expand')?.props?.children?.props?.children?.props?.d
  const closedPath = firstByClass(hovered, 'dsse-expand')?.props?.children?.props?.children?.props?.d
  check('the open card points up', openedPath === 'M6 15l6-6 6 6', String(openedPath))
  check('and the closed card points down', closedPath === 'M6 9l6 6 6-6', String(closedPath))

  // The pointer leaving must not close a card that was clicked open: the click is
  // its own reason for being open, and this is the case a single shared boolean
  // gets wrong.
  turnCard(opened).props.onMouseLeave()
  const stillPinned = await instance.renderer.deepRender(cards)
  check('the pointer leaving does not close a clicked card', expandedOf(stillPinned) === 'true', textOf(stillPinned).slice(0, 120))
  // Still a toggle while it is open. The clip deliberately stops measuring once
  // the cap is lifted — a re-measure there would read "nothing hidden" and take the
  // card's interactivity away from under the person using it.
  check('an open card still invites the click that closes it', turnCard(stillPinned)?.props?.['data-clickable'] === 'true', String(turnCard(stillPinned)?.props?.['data-clickable']))
  check('and it keeps its keyboard affordances while open', turnCard(stillPinned)?.props?.tabIndex === 0 && turnCard(stillPinned)?.props?.role === 'button', JSON.stringify([turnCard(stillPinned)?.props?.tabIndex, turnCard(stillPinned)?.props?.role]))
  check('and it still reports itself expanded', turnCard(stillPinned)?.props?.['aria-expanded'] === true, String(turnCard(stillPinned)?.props?.['aria-expanded']))
  check('an open summary keeps its clipped reading', firstByClass(stillPinned, 'dsse-clip')?.props?.['data-clipped'] === 'true', String(firstByClass(stillPinned, 'dsse-clip')?.props?.['data-clipped']))
  // The point of the rule above: the way out does not depend on the pointer. This
  // is the frame where a hover-gated badge would be missing, and the card would be
  // open with nothing on it saying how to close it.
  check('the way out survives the pointer leaving', turnCard(stillPinned)?.props?.['data-hint'] === 'true', String(turnCard(stillPinned)?.props?.['data-hint']))
  check('and it still says the click will close it', firstByClass(stillPinned, 'dsse-expand')?.props?.['aria-label'] === '点击收起全文', String(firstByClass(stillPinned, 'dsse-expand')?.props?.['aria-label']))

  // A second click releases the pin, and with no pointer on the card it closes.
  press(stillPinned)
  const released = await instance.renderer.deepRender(cards)
  check('clicking again lets go of the pin', expandedOf(released) === 'false', textOf(released).slice(0, 120))
}

{
  // The other half of the split: hovering a card that was pinned, then clicking,
  // must leave the pointer's reason intact — the card stays open until the
  // pointer actually leaves.
  const routes = panelRoutes()
  const instance = boot({ routes })
  instance.renderer.setNodeForRef(fakeNode({ left: 280, top: 120, width: 1640, height: 300, overflowHeight: 900 }))
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const expandedOf = (tree) => firstByClass(tree, 'dsse-clip')?.props?.['data-expanded']
  const turnCard = (tree) => byClass(tree, 'dsse-card')[0]

  // The harness renders a child component in a pass of its own, so the clip's
  // measurement reaches `Cards` one render after the clip reports it. React does
  // not have that gap — a layout effect and the state it sets land in the same
  // commit — so this is the harness catching up, not the component settling.
  const settle = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }

  const start = await settle()
  // Guarded for the same reason as the block above: a mutation that removes the
  // handler must fail a check, not throw past the runner's FAIL-line count.
  const pressStart = turnCard(start)?.props?.onClick
  check('a clipped card answers a click', typeof pressStart === 'function', String(typeof pressStart))
  if (typeof pressStart === 'function') pressStart()
  const clicked = await instance.renderer.deepRender(cards)
  check('a click opens the card with no pointer on it', expandedOf(clicked) === 'true', textOf(clicked).slice(0, 120))

  if (typeof turnCard(clicked)?.props?.onMouseEnter === 'function') turnCard(clicked).props.onMouseEnter()
  const hovered = await instance.renderer.deepRender(cards)
  check('hovering a pinned card leaves it open', expandedOf(hovered) === 'true', textOf(hovered).slice(0, 120))

  if (typeof turnCard(hovered)?.props?.onMouseLeave === 'function') turnCard(hovered).props.onMouseLeave()
  const afterLeave = await instance.renderer.deepRender(cards)
  check('moving away from a pinned card leaves it open', expandedOf(afterLeave) === 'true', textOf(afterLeave).slice(0, 120))
}

{
  // A summary that already fits has nothing to reveal, so the card must not offer
  // a click that changes nothing: no tab stop, no pointer cursor, no button role.
  const routes = panelRoutes()
  const instance = boot({ routes })
  instance.renderer.setNodeForRef(fakeNode({ left: 280, top: 120, width: 1640, height: 300, overflowHeight: 300 }))
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  // The harness renders a child component in a pass of its own, so the clip's
  // measurement reaches `Cards` one render after the clip reports it. React does
  // not have that gap — a layout effect and the state it sets land in the same
  // commit — so this is the harness catching up, not the component settling.
  const settle = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }

  const tree = await settle()
  const card = byClass(tree, 'dsse-card')[0]
  check('a summary that fits is not clickable', card?.props?.['data-clickable'] === 'false', String(card?.props?.['data-clickable']))
  check('and it takes no tab stop', card?.props?.tabIndex === undefined, String(card?.props?.tabIndex))
  check('and it claims no button role', card?.props?.role === undefined, String(card?.props?.role))

  // The pointer handlers are attached whatever the measurement says — a card cannot
  // know it has nothing to reveal until after layout, and hover arrives before that.
  // So the measurement gate on `expanded` is the only thing standing between a
  // hovered-but-empty card and the state that must never exist: expanded, with no
  // click handler, no tab stop and no role to close it with. Being open is decided
  // by whether there is anything to open, not by whether someone pointed at it.
  const expandedOf = (tree) => firstByClass(tree, 'dsse-clip')?.props?.['data-expanded']
  card?.props?.onMouseEnter?.()
  const hovered = await settle()
  check('pointing at a card with nothing to reveal does not open it', expandedOf(hovered) === 'false', String(expandedOf(hovered)))
  check('and it is still not offering a way to close', byClass(hovered, 'dsse-card')[0]?.props?.['data-clickable'] === 'false', String(byClass(hovered, 'dsse-card')[0]?.props?.['data-clickable']))
}

{
  // The keyboard has to be able to do what the mouse does, and only Enter and
  // Space — a card that toggles on every keypress is a card that fights scrolling.
  const routes = panelRoutes()
  const instance = boot({ routes })
  instance.renderer.setNodeForRef(fakeNode({ left: 280, top: 120, width: 1640, height: 300, overflowHeight: 900 }))
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const expandedOf = (tree) => firstByClass(tree, 'dsse-clip')?.props?.['data-expanded']
  // The harness renders a child component in a pass of its own, so the clip's
  // measurement reaches `Cards` one render after the clip reports it. React does
  // not have that gap — a layout effect and the state it sets land in the same
  // commit — so this is the harness catching up, not the component settling.
  const settle = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }

  const start = await settle()
  const key = async (tree, name) => {
    let prevented = false
    // Guarded rather than called straight: a card whose handler went missing must
    // fail an assertion here. Calling it unguarded threw, and a thrown suite
    // prints no FAIL line — which made the mutation that removes the handler look
    // like a survivor.
    const handler = byClass(tree, 'dsse-card')[0]?.props?.onKeyDown
    check(`the card answers ${name} at all`, typeof handler === 'function', String(typeof handler))
    if (typeof handler !== 'function') return { prevented, next: tree }
    handler({ key: name, preventDefault: () => { prevented = true } })
    const next = await instance.renderer.deepRender(cards)
    return { prevented, next }
  }

  const ignored = await key(start, 'a')
  check('a letter does not toggle the card', expandedOf(ignored.next) === 'false', textOf(ignored.next).slice(0, 120))

  const enter = await key(ignored.next, 'Enter')
  check('Enter opens the card', expandedOf(enter.next) === 'true', textOf(enter.next).slice(0, 120))
  check('and Enter does not also scroll the page', enter.prevented === true, 'preventDefault was not called')

  const space = await key(enter.next, ' ')
  check('Space closes it again', expandedOf(space.next) === 'false', textOf(space.next).slice(0, 120))
}

// ---------------------------------------------------------------------------
// An open card must not re-measure itself shut
//
// Lifting the cap is a CSS change, so in a browser `scrollHeight` and
// `clientHeight` agree the moment the card is open. A clip that measures while
// expanded therefore reads "nothing is hidden" and overwrites the one fact that
// makes the card a toggle — it stays open but stops being clickable, stops taking
// a tab stop, and stops reporting `aria-expanded`, so the keyboard user who just
// opened it can no longer close it.
//
// Reproducing that needs a node whose `scrollHeight` follows the cap. The shared
// `fakeNode` reports a fixed overflow, which models the collapsed state only —
// against a fixed node the guard is invisible, and the mutation that deletes it
// survives.
// ---------------------------------------------------------------------------

{
  let capped = true
  let shrink = false
  const routes = panelRoutes()
  const instance = boot({ routes })
  instance.renderer.setNodeForRef({
    ...fakeNode({ left: 280, top: 120, width: 1640, height: 300 }),
    get scrollHeight() {
      // Uncapped, the box grows to fit: nothing is hidden, by construction.
      if (!capped) return 300
      // Capped and short: the case that only a fresh measurement can notice.
      return shrink ? 300 : 900
    },
    clientHeight: 300,
  })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const clipOf = (tree) => firstByClass(tree, 'dsse-clip')
  const turnCard = (tree) => byClass(tree, 'dsse-card')[0]
  const settle = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }
  // A suite that throws prints no FAIL line, and the mutation runner counts FAIL
  // lines, so an unguarded call turns every mutation that removes the handler into
  // a phantom survivor. The guard keeps the failure visible as a FAIL.
  const press = (tree) => {
    const handler = turnCard(tree)?.props?.onClick
    check('the card answers a click', typeof handler === 'function', String(typeof handler))
    if (typeof handler !== 'function') return false
    handler()
    return true
  }

  const collapsed = await settle()
  check('the capped summary measures as clipped', clipOf(collapsed)?.props?.['data-clipped'] === 'true', String(clipOf(collapsed)?.props?.['data-clipped']))

  // Opening lifts the cap, which is what makes the box stop overflowing. The order
  // matters: while the cap is still on the box overflows, so the card is expandable;
  // the uncapping is a consequence of opening, not a precondition. Doing it first
  // would let a fresh measurement report "nothing hidden" and take the click away
  // before there was anything to click.
  check('the card answers a click before it is opened', press(collapsed) === true, 'the collapsed card had no handler')
  capped = false
  const lifted = await settle()
  check('opening the card keeps its clipped reading', clipOf(lifted)?.props?.['data-clipped'] === 'true', String(clipOf(lifted)?.props?.['data-clipped']))
  check('opening the card keeps it clickable', turnCard(lifted)?.props?.['data-clickable'] === 'true', String(turnCard(lifted)?.props?.['data-clickable']))
  check('opening the card keeps its expanded report', turnCard(lifted)?.props?.['aria-expanded'] === true, String(turnCard(lifted)?.props?.['aria-expanded']))

  // Closing restores the cap, and with it the measurement starts running again.
  //
  // Proving that needs the new measurement to give a *different* answer. Leaving it
  // at 900 would be answered 'true' by the reading already on screen, so a component
  // that measured once and never again would pass — the assertion would be about the
  // old reading, not about measuring. Shrink the text instead, so only a clip that
  // actually re-runs the comparison can report 'false'.
  capped = true
  shrink = true
  press(lifted)
  const closed = await settle()
  check('closing the card measures it again', clipOf(closed)?.props?.['data-clipped'] === 'false', String(clipOf(closed)?.props?.['data-clipped']))
  check('and it collapses', clipOf(closed)?.props?.['data-expanded'] === 'false', String(clipOf(closed)?.props?.['data-expanded']))
}

// ---------------------------------------------------------------------------
// A card that is not interactive is inert, right down to its click
//
// The first version gated the cursor, the tab stop, the role and the keyboard but
// forwarded `onClick` unconditionally. That looked harmless — the card had nothing
// to reveal, so nothing appeared to happen — but the click still flipped the
// caller's pin, invisibly. The pin then outlived the turn: the next summary
// arrived long enough to truncate, so it rendered already open on a card the
// measurement marked as not expandable, which means open with no way to close it.
//
// Two assertions, because the defect had two halves: the click must not reach the
// handler at all, and a pin must not survive a change of turn.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  const instance = boot({ routes })
  // Nothing hidden, so nothing to reveal.
  instance.renderer.setNodeForRef(fakeNode({ left: 280, top: 120, width: 1640, height: 300, overflowHeight: 300 }))
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const settleInto = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }

  const resting = await settleInto()
  const card = byClass(resting, 'dsse-card')[0]
  check('a card with nothing to reveal carries no click handler', card?.props?.onClick === undefined, String(card?.props?.onClick))

  // Even if a click does arrive — a stray event, a host that replays one — the
  // card must not end up expanded.
  const expandedOf = (tree) => firstByClass(tree, 'dsse-clip')?.props?.['data-expanded']
  card?.props?.onClick?.()
  const afterClick = await settleInto()
  check('a click on an inert card does not expand it', expandedOf(afterClick) === 'false', String(expandedOf(afterClick)))
}

{
  // The pin belongs to the turn it was set on. A click on turn 7 must not open the
  // summary that arrives as turn 8.
  const routes = panelRoutes()
  let turn = 7
  let text = 'SHORT'
  const original = routes['/api/ui-evolve/panel']
  // Serve a different turn, and a different summary, on demand.
  const responder = () => ({
    ok: true,
    data: { ...original.data, turn, summary: { text } },
  })
  Object.defineProperty(routes, '/api/ui-evolve/panel', { get: responder, enumerable: true, configurable: true })

  const instance = boot({ routes })
  instance.renderer.setNodeForRef(fakeNode({ left: 280, top: 120, width: 1640, height: 300 }))
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const settleInto = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }
  const expandedOf = (tree) => firstByClass(tree, 'dsse-clip')?.props?.['data-expanded']
  const cardOf = (tree) => byClass(tree, 'dsse-card')[0]

  // Turn 7 shows a long summary; the card is expandable and gets pinned open.
  turn = 7
  text = 'LONG'
  const longNode = { ...fakeNode({ left: 280, top: 120, width: 1640, height: 300 }), scrollHeight: 900, clientHeight: 300 }
  instance.renderer.setNodeForRef(longNode)
  const first = await settleInto()
  check('the long summary on turn seven is expandable', cardOf(first)?.props?.['data-clickable'] === 'true', String(cardOf(first)?.props?.['data-clickable']))
  // A suite that throws prints no FAIL line, and the mutation runner counts FAIL
  // lines — so an unguarded call here would turn every mutation that removes the
  // measurement into a phantom survivor instead of a kill.
  const pin = cardOf(first)?.props?.onClick
  check('the expandable card answers a click', typeof pin === 'function', String(typeof pin))
  if (typeof pin === 'function') pin()
  const pinned = await settleInto()
  check('clicking pins turn seven open', expandedOf(pinned) === 'true', String(expandedOf(pinned)))

  // Turn 8 arrives with more text still, and a fresh measurement that also says
  // there is more to show. The pin from turn 7 must be gone all the same: nobody
  // asked to open this one.
  turn = 8
  text = 'LONGER'
  // The panel only re-reads when asked; without this the old answer stays and the
  // turn never changes, which would make the assertion describe turn 7 twice.
  firstByClass(pinned, 'dsse-refresh').props.onClick()
  const refreshed = await settleInto()
  check('a new turn does not inherit the previous pin', expandedOf(refreshed) === 'false', String(expandedOf(refreshed)))
}

{
  // The measurement is turn-scoped too: a report about the old summary must not
  // make the new card look expandable before anyone has measured it.
  const routes = panelRoutes()
  let turn = 7
  const original = routes['/api/ui-evolve/panel']
  Object.defineProperty(routes, '/api/ui-evolve/panel', {
    get: () => ({ ok: true, data: { ...original.data, turn } }),
    enumerable: true,
    configurable: true,
  })

  const instance = boot({ routes })
  // The harness binds a ref once and never rebinds it, so swapping the node for a
  // shorter one would leave the clip measuring the old object — the assertion would
  // pass or fail for the wrong reason. Keep one node and change what it reports.
  let overflow = 900
  instance.renderer.setNodeForRef({
    ...fakeNode({ left: 280, top: 120, width: 1640, height: 300 }),
    get scrollHeight() { return overflow },
    clientHeight: 300,
  })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const settleInto = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }
  const cardOf = (tree) => byClass(tree, 'dsse-card')[0]

  const measured = await settleInto()
  check('a measured overflow makes the card expandable', cardOf(measured)?.props?.['data-clickable'] === 'true', String(cardOf(measured)?.props?.['data-clickable']))

  // A new turn whose summary fits: the old measurement said "there is more", and
  // it must not be applied to text it never saw.
  turn = 8
  overflow = 300
  // Ask for the new answer; otherwise this still describes turn 7.
  firstByClass(measured, 'dsse-refresh').props.onClick()
  const remeasured = await settleInto()
  check('a new turn re-measures before offering a click', cardOf(remeasured)?.props?.['data-clickable'] === 'false', String(cardOf(remeasured)?.props?.['data-clickable']))
}

{
  // Hover is not turn-scoped, but the measurement still is. While the pointer is
  // on the card the clip stops measuring — that is the whole point of the guard —
  // so a turn change under a hovering pointer is the one moment where an old
  // measurement has nowhere to be corrected. It must not be reused: a card that
  // offers a click on text that fits offers a click that does nothing.
  const routes = panelRoutes()
  const original = routes['/api/ui-evolve/panel']
  let turn = 7
  Object.defineProperty(routes, '/api/ui-evolve/panel', {
    get: () => ({ ok: true, data: { ...original.data, turn } }),
    enumerable: true,
    configurable: true,
  })

  const instance = boot({ routes })
  // Tall to begin with, so the first measurement says there is more to show.
  let overflow = 900
  instance.renderer.setNodeForRef({
    ...fakeNode({ left: 280, top: 120, width: 1640, height: 300 }),
    get scrollHeight() { return overflow },
    clientHeight: 300,
  })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const settleInto = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }
  const cardOf = (tree) => byClass(tree, 'dsse-card')[0]

  const measured = await settleInto()
  check('the tall summary is expandable', cardOf(measured)?.props?.['data-clickable'] === 'true', String(cardOf(measured)?.props?.['data-clickable']))

  // Hover, then hand the panel a summary that fits. The clip is open, so it does
  // not measure; the only thing that can tell the card it has nothing to reveal is
  // the turn tag on the old measurement going stale.
  if (typeof cardOf(measured)?.props?.onMouseEnter === 'function') cardOf(measured).props.onMouseEnter()
  turn = 8
  overflow = 300
  // The panel re-reads on request only. The pointer is still on the card, so the
  // hover survives this refresh — which is exactly the window being tested.
  firstByClass(measured, 'dsse-refresh').props.onClick()
  const refreshed = await settleInto()
  check('a stale measurement does not survive into a turn it never saw', cardOf(refreshed)?.props?.['data-clickable'] === 'false', String(cardOf(refreshed)?.props?.['data-clickable']))
}

{
  // A panel that has not reported a turn yet has no turn id. An empty id must not
  // match the empty "nothing pinned" value — that would read as "this card was
  // pinned" and render every such panel open.
  const routes = panelRoutes()
  const original = routes['/api/ui-evolve/panel']
  Object.defineProperty(routes, '/api/ui-evolve/panel', {
    // No `turn` field at all, as a half-built or older payload would look.
    get: () => {
      const { turn, ...rest } = original.data
      return { ok: true, data: rest }
    },
    enumerable: true,
    configurable: true,
  })

  const instance = boot({ routes })
  instance.renderer.setNodeForRef({ ...fakeNode({ left: 280, top: 120, width: 1640, height: 300 }), scrollHeight: 900, clientHeight: 300 })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  await instance.renderer.deepRender(cards)
  const settled = await instance.renderer.deepRender(cards)
  check('a panel with no turn id does not render itself pinned open', firstByClass(settled, 'dsse-clip')?.props?.['data-expanded'] === 'false', String(firstByClass(settled, 'dsse-clip')?.props?.['data-expanded']))
}

{
  // The pointer cannot leave a card that no longer exists.
  //
  // A refresh empties the panel while it asks, so the 上一轮 card unmounts and the
  // `onMouseLeave` that would clear a bare hover boolean never fires. If hover is a
  // plain `true`, the next turn's card inherits it and renders open — under a pointer
  // that left the card several seconds ago, and with nothing to close it: a card the
  // measurement says has nothing hidden gets no click handler, no tab stop and no
  // role. Open, and unfixable by the person looking at it.
  //
  // Two separate things have to hold for this to stay fixed, and each has been
  // broken on its own during development, so both get an assertion: the hover tag
  // must belong to a turn, and being open must depend on the measurement.
  const routes = panelRoutes()
  const original = routes['/api/ui-evolve/panel']
  let turn = 7
  let text = 'LONG'
  Object.defineProperty(routes, '/api/ui-evolve/panel', {
    get: () => ({ ok: true, data: { ...original.data, turn, summary: { text } } }),
    enumerable: true,
    configurable: true,
  })

  const instance = boot({ routes })
  // The window is capped, so the summary really is too tall for it. One node whose
  // height follows the text: a fresh object per turn would not be rebound, since the
  // harness binds a ref once.
  let overflow = 900
  instance.renderer.setNodeForRef({
    ...fakeNode({ left: 280, top: 120, width: 1640, height: 300 }),
    get scrollHeight() { return overflow },
    clientHeight: 300,
  })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const settleInto = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }
  const clipOf = (tree) => firstByClass(tree, 'dsse-clip')
  const cardOf = (tree) => byClass(tree, 'dsse-card')[0]

  const begin = await settleInto()
  check('the long summary measures as too tall for its box', clipOf(begin)?.props?.['data-clipped'] === 'true', String(clipOf(begin)?.props?.['data-clipped']))
  check('and so it invites a click', cardOf(begin)?.props?.['data-clickable'] === 'true', String(cardOf(begin)?.props?.['data-clickable']))

  // Hover it, then take the card away without letting the pointer leave: refresh
  // into a turn whose summary fits.
  cardOf(begin)?.props?.onMouseEnter?.()
  const hovered = await settleInto()
  check('hovering the card offers the click', cardOf(hovered)?.props?.['data-hint'] === 'true', String(cardOf(hovered)?.props?.['data-hint']))
  check('and it does not open it', clipOf(hovered)?.props?.['data-expanded'] === 'false', String(clipOf(hovered)?.props?.['data-expanded']))

  turn = 8
  text = 'ALSO LONG'
  firstByClass(hovered, 'dsse-refresh').props.onClick()
  const swapped = await settleInto()
  check('a hover that outlived its turn does not offer the next card', cardOf(swapped)?.props?.['data-hint'] === 'false', String(cardOf(swapped)?.props?.['data-hint']))
  check('a hover that outlived its turn does not open the next card', clipOf(swapped)?.props?.['data-expanded'] === 'false', String(clipOf(swapped)?.props?.['data-expanded']))
  // The card must still offer the click, or the assertion above would be answered by
  // "there was nothing to open" instead of by the hover tag.
  check('the next card is still expandable in its own right', cardOf(swapped)?.props?.['data-clickable'] === 'true', String(cardOf(swapped)?.props?.['data-clickable']))

  // The invariant the two halves of this defect exist to protect: a card that
  // renders open can always be closed. Asserted as a pairing rather than as "it is
  // closed", because the way this went wrong was an open card with no way out —
  // `aria-expanded` true while `data-clickable`, the tab stop, the role and the click
  // handler were all absent.
  //
  // These pairs used to be read straight off trees that a hover had opened. Hover
  // no longer opens anything — only a click does — so a pair built the old way
  // would compare two closed cards and silently check nothing at all, which is
  // what it did for one round. The premise is now asserted instead of skipped:
  // if the interaction is redesigned again, an open card nobody can close has to
  // fail here rather than quietly leave nothing to look at.
  const pressCard = (tree, when) => {
    const handler = cardOf(tree)?.props?.onClick
    check(`a card answers a click ${when}`, typeof handler === 'function', String(typeof handler))
    if (typeof handler === 'function') handler()
  }

  pressCard(swapped, 'while its summary is too tall for the box')
  const opened = await settleInto()
  cardOf(opened)?.props?.onMouseLeave?.()
  const leftOpen = await settleInto()

  const openPairs = [
    ['after a click', opened],
    ['after the pointer left it again', leftOpen],
  ]
  for (const [when, tree] of openPairs) {
    const clip = clipOf(tree)
    const card = cardOf(tree)
    check(`a card that renders open ${when} says it is open`, clip?.props?.['data-expanded'] === 'true', String(clip?.props?.['data-expanded']))
    check(`an open card can be closed ${when}`, card?.props?.['data-clickable'] === 'true' && card?.props?.tabIndex === 0 && card?.props?.role === 'button' && typeof card?.props?.onClick === 'function', `${String(card?.props?.['data-clickable'])}/${String(card?.props?.tabIndex)}/${String(card?.props?.role)}/${typeof card?.props?.onClick}`)
  }
}

{
  // A turn number is only unique inside its own session.
  //
  // Every transcript counts from zero, so two conversations sitting at turn 7 is
  // ordinary — and a tag written in the first one then matches the second. The card
  // opens for a reason that belongs to a conversation nobody is looking at. An open
  // card skips the measurement, so the stale tag is never measured away, and the
  // card stays open until someone happens to click it.
  //
  // Both halves of the fixture matter. The shared turn number is what lets a stale
  // tag match at all; the summary that fits is what makes the wrong state visible,
  // since a card that genuinely has more to show is supposed to open.
  const routes = panelRoutes()
  const base = routes['/api/ui-evolve/panel'].data
  routes['/api/ui-evolve/panel'] = (init, url) => ({
    ok: true,
    data: {
      ...base,
      summary: { text: String(url).includes('agent=session-a') ? 'Long enough that the box cuts it.' : 'One line.', model: 'p/m' },
    },
  })

  const instance = boot({ routes })
  // One node for both conversations, with a height the test can change. A fresh
  // node would be an easy way out of the defect: the clip would remount, measure
  // again and quietly replace the stale answer. Keeping the node fixed to the
  // layout means the only thing that can clear the stale tag is the code.
  let overflow = 900
  instance.renderer.setNodeForRef({
    ...fakeNode({ left: 280, top: 120, width: 1640, height: 300 }),
    get scrollHeight() {
      return overflow
    },
    clientHeight: 300,
  })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  const toggle = instance.seat('toggle')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const settle = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }
  const clipOf = (tree) => firstByClass(tree, 'dsse-clip')
  const cardOf = (tree) => byClass(tree, 'dsse-card')[0]

  const begin = await settle()
  check('the first conversation has more to show than the box holds', clipOf(begin)?.props?.['data-clipped'] === 'true', String(clipOf(begin)?.props?.['data-clipped']))
  cardOf(begin)?.props?.onMouseEnter?.()
  const hovered = await settle()
  check('and pointing at it offers the click', cardOf(hovered)?.props?.['data-hint'] === 'true', String(cardOf(hovered)?.props?.['data-hint']))

  // The next conversation is also on turn 7, and its summary fits.
  overflow = 300
  await instance.renderer.render(toggle, { sessionId: 'session-b' })
  const switched = await settle()
  check('a tag from one conversation does not offer a card in the next', cardOf(switched)?.props?.['data-hint'] === 'false', String(cardOf(switched)?.props?.['data-hint']))
  check('a tag from one conversation does not open a card in the next', clipOf(switched)?.props?.['data-expanded'] === 'false', String(clipOf(switched)?.props?.['data-expanded']))
  check('and the new card is measured instead of inheriting the old answer', clipOf(switched)?.props?.['data-clipped'] === 'false', String(clipOf(switched)?.props?.['data-clipped']))
  check('with nothing to reveal, it stops offering a click', cardOf(switched)?.props?.['data-clickable'] === 'false', String(cardOf(switched)?.props?.['data-clickable']))

  // Coming back is the half that a short summary would hide. A fresh conversation
  // with nothing to show answers "no offer" for a reason that has nothing to do
  // with the stale tag, so the tag has to be carried back to a card that has
  // something to offer — same turn number, same long summary, no pointer on it.
  overflow = 900
  await instance.renderer.render(toggle, { sessionId: 'session-a' })
  const returned = await settle()
  check('a card that has something to offer does not offer it unasked', cardOf(returned)?.props?.['data-hint'] === 'false', String(cardOf(returned)?.props?.['data-hint']))
  check('and returning does not leave it open', clipOf(returned)?.props?.['data-expanded'] === 'false', String(clipOf(returned)?.props?.['data-expanded']))
}

// ---------------------------------------------------------------------------
// The cap is six lines, and only the parts that agree on that
//
// The rule is a single declaration, so the guard is a source assertion rather
// than a rendered one: `.dsse-tiny` sets line-height:1.55 with a font-size of
// .86em, which makes one line box 1.55em of this element, so six lines is
// 9.3em. It was five lines at 7.75em until the summary was asked to show one
// more line, and three lines at 5.2em (3.35 line boxes — an odd place to cut,
// since the last line came out shaved rather than omitted) before that. Both
// older values are asserted absent, because a stale cap left behind in the
// source would win or lose on rule order rather than on intent.
// ---------------------------------------------------------------------------

{
  const source = readFileSync(new URL('../packages/ui-evolve/lib/client.js', import.meta.url), 'utf8')
  check('the summary is capped at six lines', source.includes('.dsse-clip .dsse-text{max-height:9.3em;overflow:hidden}'), 'the cap is not 9.3em')
  check('the old five-line cap is gone', source.includes('max-height:7.75em') === false, 'a 7.75em cap survives somewhere')
  check('the old three-line cap is gone', source.includes('max-height:5.2em') === false, 'a 5.2em cap survives somewhere')
  check('one line box is still 1.55em', /\.dsse-tiny\{[^}]*line-height:1\.55/.test(source), 'the line box changed, so 9.3em is no longer six lines')
  check('the fade is gated on not being expanded', source.includes('.dsse-clip[data-clipped="true"][data-expanded="false"]::after{'), 'the fade ignores the expanded state')
  check('expanding lifts the cap', source.includes('.dsse-clip[data-expanded="true"] .dsse-text{max-height:none}'), 'expanding does not lift the cap')
}

// ---------------------------------------------------------------------------
// The card header lines up with its title
//
// Centring the row put the stats' optical centre on the title's box centre, which
// reads as a few pixels low because the digits sit on a smaller line box. Baseline
// alignment is what makes them share a line.
//
// The stats are pushed to the far edge on purpose. They were pulled next to the
// title once, reading "aligned" as "part of the same group", but the header reads
// better with the title on the left and its numbers on the right — two facts, two
// ends. The `min-height` went with the 提炼 button it was reserving room for: the
// row was 42px tall holding one 17px line, which is the gap that showed up under
// every card title.
// ---------------------------------------------------------------------------

{
  const source = readFileSync(new URL('../packages/ui-evolve/lib/client.js', import.meta.url), 'utf8')
  check('the card header aligns on the baseline', source.includes('.dsse-card-head{display:flex;align-items:baseline;'), 'the header still centres its row')
  check('the header no longer centres', source.includes('.dsse-card-head{display:flex;align-items:center;') === false, 'a centring header survives')
  check('the stats sit at the far edge', source.includes('.dsse-head-stats{display:flex;align-items:baseline;gap:8px;margin-left:auto;'), 'the stats are not pushed right')
  // The timestamp is the fourth thing in a row that already overflowed a narrow
  // card. An ellipsis on the child alone never engages: the flex parent keeps
  // `max-content` width, so the row runs past `.dsse-card{overflow:hidden}` and
  // the span is cut off at the card edge with no text-overflow at all. The
  // shrink has to be permitted on the parent, and the counts have to refuse it
  // so the thing that gives way is the timestamp, not the numbers.
  check('the stats row may shrink', source.includes('.dsse-head-stats{display:flex;align-items:baseline;gap:8px;margin-left:auto;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px);white-space:nowrap;min-width:0;overflow:hidden}'), 'the stats row still refuses to shrink, so the timestamp is clipped instead of ellipsized')
  check('a count never gives way', source.includes('.dsse-head-stat{display:inline-flex;align-items:baseline;gap:3px;flex:0 0 auto}'), 'a count can shrink, so the numbers lose digits before the timestamp loses letters')
  check('the timestamp is the part that gives way', source.includes('.dsse-head-ago{color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.78em,10px);white-space:nowrap;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}'), 'the timestamp cannot shrink into an ellipsis')
  check('the header keeps no room for a button that is gone', source.includes('.dsse-card-head{display:flex;align-items:baseline;gap:8px;min-height:') === false, 'the header still reserves a minimum height')
  check('the icon buttons keep their own centring', source.includes('.dsse-card-head .dsse-icon-btn{width:30px;height:30px;border-radius:7px;align-self:center}'), 'the icon buttons lost their vertical placement')
}

// ---------------------------------------------------------------------------
// The 提炼 button is gone, and the route it called is not
//
// Only the client lost the button. `POST /api/ui-evolve/propose` still exists and
// is still covered by the api suite; deleting the route would break a host that
// has the skill half installed and calls it from somewhere else.
// ---------------------------------------------------------------------------

{
  const client = readFileSync(new URL('../packages/ui-evolve/lib/client.js', import.meta.url), 'utf8')
  check('the client no longer draws a propose button', client.includes('dsse-propose') === false, 'a propose button survives in the client')
  check('the client no longer posts to the propose route', client.includes('"/propose"') === false, 'the client still calls the propose route')
  check('and it keeps no state for it', client.includes('setBusy(true)') === false, 'propose state survives in the client')
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
  routes['/api/ui-evolve/panel'] = {
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
  routes['/api/ui-evolve/panel'] = {
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

// ---------------------------------------------------------------------------
// The launcher page is not a conversation
//
// The overlay is registered on a root-level slot, so it is mounted whether or
// not a conversation is open. It used to find the conversation body and treat
// that as proof of a conversation — but the host renders that element on every
// page, including the launcher and the new-session hero. The host does publish
// which page it is on (`data-content-phase`), so this suite pins all four
// readings of it: an `active` conversation draws its cards, a `settling` one —
// a conversation in the middle of opening — draws them too, a `hero` page draws
// nothing, and a host that publishes no attribute at all keeps working.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: { turn: 4, calls: 3, failed: 0, summary: { text: 'SESSION FULL' }, pendingCandidates: 0, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [] },
  }
  // Two hosts, identical except for the page they say they are on. The phase is
  // read during measurement, and this harness has no live observer to fire a
  // second one, so the difference has to be in place from the mount.
  const launch = async (phase) => {
    const instance = boot({ routes, phase })
    instance.module.apply(instance.ctx)
    const cards = instance.seat('cards')
    firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
    return instance.renderer.deepRender(cards)
  }

  const onConversation = await launch('active')
  check('a conversation page draws the cards', textOf(onConversation).includes('SESSION FULL'), textOf(onConversation).slice(0, 100))

  const launcher = await launch('hero')
  check('the launcher page draws no cards at all', byClass(launcher, 'dsse-card').length === 0, textOf(launcher).slice(0, 140))
  check('and it does not draw a leftover rail either', firstByClass(launcher, 'dsse-rail') === undefined, textOf(launcher).slice(0, 140))

  // `settling` is the middle phase — a conversation the person has already asked
  // for, while the host is still assembling it. The cards belong on screen
  // there: hiding them would make every switch start with a blank strip that
  // fills in a moment later, which reads as a flicker rather than as a load.
  // Only the launcher, which is not a conversation yet, is answered with
  // nothing. `hero` alone is the rule; "anything that is not `active`" would
  // take the panel away during the one second it is most expected.
  const settling = await launch('settling')
  check('a conversation being opened draws its cards', textOf(settling).includes('SESSION FULL'), textOf(settling).slice(0, 120))

  // A host that never publishes the attribute is not a launcher. Reading a
  // missing attribute as "not a conversation" would take the panel away from
  // every older host at once, and the panel cannot tell that from a bug on its
  // own side.
  const unknown = await launch(null)
  check('a host that says nothing still gets its cards', textOf(unknown).includes('SESSION FULL'), textOf(unknown).slice(0, 120))

  // The phase is read during a measurement, and the three phases are not three
  // documents: the host switches between them in place, when a launcher page
  // sends its first message or a conversation is left. Nothing resizes at that
  // moment — the attribute is the whole event — so a size observer cannot see
  // it. Without a listener on the attribute itself, a session that starts on the
  // launcher keeps `hero` in `place` and the cards stay hidden for as long as
  // the page is open.
  const watched = boot({ routes })
  watched.module.apply(watched.ctx)
  firstByClass(await watched.renderer.render(watched.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  await watched.renderer.deepRender(watched.seat('cards'))
  const phaseObserver = watched.mutationObservers.find((observer) =>
    observer.targets.some((entry) => (entry.options?.attributeFilter ?? []).includes('data-content-phase')))
  check('something is listening for the page to change', phaseObserver !== undefined, JSON.stringify(watched.mutationObservers.length))
  const phaseTarget = phaseObserver?.targets.find((entry) => (entry.options?.attributeFilter ?? []).includes('data-content-phase'))
  check('and it watches the document, not the conversation body', phaseTarget?.target === watched.document.documentElement, String(phaseTarget?.target === watched.document.documentElement))
  // Attributes only. `childList` on the document subtree fires on every streamed
  // token, which would turn a rare page change into a per-token layout read.
  check('and it watches attributes alone', phaseTarget?.options?.attributes === true && phaseTarget?.options?.childList !== true, JSON.stringify(phaseTarget?.options))
  check('and it looks inside the document, not only at its root', phaseTarget?.options?.subtree === true, JSON.stringify(phaseTarget?.options))

  // The callback has to do the work, not just exist: flip the attribute the way
  // the host does and the cards must appear. The flip alone changes nothing —
  // the phase reaches `place` through a measurement, which is exactly the step
  // the observer exists to trigger, so the callback is part of the fixture here
  // rather than something the test can skip.
  watched.conversation.setPhase('hero')
  phaseObserver.callback([{ type: 'attributes', attributeName: 'data-content-phase' }])
  const hidden = await watched.renderer.deepRender(watched.seat('cards'))
  check('the cards leave when the page becomes a launcher', byClass(hidden, 'dsse-card').length === 0, textOf(hidden).slice(0, 140))
  watched.conversation.setPhase('active')
  phaseObserver.callback([{ type: 'attributes', attributeName: 'data-content-phase' }])
  const returnedTree = await watched.renderer.deepRender(watched.seat('cards'))
  check('and come back when it becomes a conversation again', textOf(returnedTree).includes('SESSION FULL'), textOf(returnedTree).slice(0, 140))
}

// ---------------------------------------------------------------------------
// The panel no longer asks the host what language to answer in
// ---------------------------------------------------------------------------
//
// It used to: the bundle read `<html lang>` and appended `?lang=`, and the
// summariser turned that tag into a prompt sentence. The summary is now written
// in the language of the conversation, which is the language the user typed in,
// and the model reads that directly from the transcript. Keeping the query would
// leave two answers to one question — and the interface language is the wrong
// one of the two: a person reading a Chinese UI while working in English asked
// for English work.
//
// These assertions are the removal's guard rail. They fail if somebody
// reintroduces the parameter, whether from `documentElement.lang` or anywhere
// else, because every panel request is inspected rather than one call site.
{
  const instance = boot({ routes: panelRoutes(), lang: 'en-GB' })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  await instance.renderer.deepRender(instance.seat('cards'))
  check(
    'the first ask carries no language',
    instance.calls.some((row) => row.url.includes('/panel?')) && instance.calls.every((row) => row.url.includes('lang=') === false),
    JSON.stringify(instance.calls.map((row) => row.url)),
  )

  // A host that names no language is the same case now, and it must stay the
  // same case: if the two ever diverge again, something is reading the
  // attribute. Written as its own boot because the fixture resolves the
  // attribute before the bundle runs.
  const unnamed = boot({ routes: panelRoutes(), lang: '' })
  unnamed.module.apply(unnamed.ctx)
  firstByClass(await unnamed.renderer.render(unnamed.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  await unnamed.renderer.deepRender(unnamed.seat('cards'))
  check(
    'a host that names no language asks the same way',
    unnamed.calls.some((row) => row.url.includes('/panel?')) && unnamed.calls.every((row) => row.url.includes('lang=') === false),
    JSON.stringify(unnamed.calls.map((row) => row.url)),
  )

  // The attribute is read (or not) when the panel asks, so changing it between
  // polls is the case that would catch a reintroduced read inside the polling
  // path. Called through `?.` rather than inside an `if`: a missing poll must
  // fail the assertion below rather than silently skip it while the suite stays
  // green.
  instance.document.documentElement.lang = 'ja'
  const poll = instance.timers.find((row) => row.ms === 8000 && row.cleared === false)
  check('the panel is still polling', poll !== undefined, JSON.stringify(instance.timers.map((row) => row.ms)))
  const before = instance.calls.length
  poll?.fn?.()
  await settle()
  const after = instance.calls.slice(before)
  check(
    'a host language changed between polls changes nothing',
    after.length > 0 && after.every((row) => row.url.includes('lang=') === false),
    JSON.stringify(after.map((row) => row.url)),
  )
}

// ---------------------------------------------------------------------------
// The live speed badge: three clocks, one number
// ---------------------------------------------------------------------------
//
// The badge is the only part of the panel that asks faster than the panel does,
// and it is the only part allowed to. Everything here is about the rate: a badge
// that asks every quarter second while idle is a cost the host pays forever for
// a number nobody is watching, and a badge that asks every eight seconds while
// generating is indistinguishable from one that is not live at all.

/**
 * A speed route that answers from a script, one payload per call.
 *
 * @param {Array<any>} script - payloads, in order; the last one repeats.
 * @param {object} [sink] - receives each call's index, for asserting the rate.
 * @returns {Function} the route.
 */
function speedScript(script, sink) {
  let at = 0
  return () => {
    const index = Math.min(at, script.length - 1)
    at += 1
    sink?.push(index)
    return script[index]
  }
}

/**
 * Boot, open the panel, and hand back the rendered cards.
 *
 * The badge lives in the panel's top row, and the top row does not exist until
 * the toggle has been clicked. A fixture that renders the toggle alone and looks
 * for `dsse-speed` finds nothing and every assertion about the badge passes for
 * the wrong reason.
 *
 * @param {object} routes - the route table.
 * @param {object} [options] - passed through to `boot`; `now` installs a clock
 *   the fixture can move.
 * @returns {Promise<{ instance: any, tree: any }>} the instance and the open tree.
 */
async function openPanel(routes, options) {
  const instance = boot({ ...options, routes })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(cards)
  return { instance, tree }
}

{
  const asked = []
  const { instance, tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': speedScript([{ ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true } }], asked),
  })
  const top = firstByClass(tree, 'dsse-top-row')
  const badge = firstByClass(tree, 'dsse-speed')
  check('a live reading is drawn in the top row', badge !== undefined, textOf(top).slice(0, 120))
  check('and it carries the number', textOf(badge).includes('100'), textOf(badge))
  check('and names the unit', textOf(badge).includes('tok/s'), textOf(badge))
  check('the number is announced with its unit', (badge?.props?.['aria-label'] ?? '').includes('100 tok/s'), String(badge?.props?.['aria-label']))
  // Not `role="status"`: that implies `aria-live="polite"`, and this number
  // changes up to four times a second — a screen reader would read it out
  // continuously for the whole generation. The label is there for whoever lands
  // on it on purpose; the announcements are not forced on everyone else.
  check('and it is not announced as it changes', badge?.props?.['aria-live'] === 'off', String(badge?.props?.['aria-live']))
  check('and it is not a live region in disguise', badge?.props?.role !== 'status', String(badge?.props?.role))
  check('the badge asked about this session', instance.calls.some((row) => row.url.includes('/speed?agent=session-a')), JSON.stringify(instance.calls.map((row) => row.url)))
}

{
  // The row order is the requirement: the number sits between the two controls
  // and the queue, so it can appear and disappear without moving a target.
  const { tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 100, ms: 1000, tps: 42, active: true } },
  })
  const top = firstByClass(tree, 'dsse-top-row')
  const children = (top?.props?.children ?? []).filter((node) => node !== null && node !== undefined && node !== false)
  const at = (name) => children.findIndex((node) => byClass(node, name).length > 0 || node.props?.className === name)
  const settings = at('dsse-settings-open')
  const speed = at('dsse-speed')
  const queue = at('dsse-queue')
  check('the badge sits after the settings button', settings >= 0 && speed > settings, `${settings} then ${speed}`)
  check('and before the queue', queue > speed, `${speed} then ${queue}`)
}

{
  // Active: ask again in a quarter of a second. This is the whole point of the
  // feature — a number that updates four times a second reads as a rate, and one
  // that updates every two seconds reads as a series of unrelated guesses.
  const { instance } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true } },
  })
  const fast = instance.timers.filter((row) => row.ms === 250 && row.cleared === false)
  check('a live reading asks again in a quarter second', fast.length >= 1, JSON.stringify(instance.timers.map((row) => row.ms)))
}

{
  // The long poll is the whole fix for "the badge only flashed". The first
  // request has no revision to name, so it is answered at once and the panel
  // paints; every request after that carries the last revision the server
  // reported, which is what makes the server hold it open until the meter moves.
  // Without the `after`, the server has nothing to compare against and answers
  // immediately every time — which is the polling this replaced.
  const { instance } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': speedScript([
      { ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true, revision: 7 } },
      { ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true, revision: 8 } },
    ]),
  })
  const urls = () => instance.calls.filter((row) => row.url.includes('/speed')).map((row) => row.url)
  check('the first request names no revision', urls()[0]?.includes('after=') === false, JSON.stringify(urls()))
  instance.timers.filter((row) => row.ms === 250 && row.cleared === false)[0]?.fn?.()
  await settle()
  check('and the next one waits past the revision it was given', urls()[1]?.includes('after=7'), JSON.stringify(urls()))
  instance.timers.filter((row) => row.ms === 250 && row.cleared === false)[0]?.fn?.()
  await settle()
  check('which moves on with the answer', urls()[2]?.includes('after=8'), JSON.stringify(urls()))
  // And it can be taken back. A long poll is unanswered for up to twenty-five
  // seconds by design, so a conversation the reader has left would otherwise
  // keep its connection — and the server's hundred-millisecond interval — alive
  // until the deadline. Switching a few times in a row would leave the new
  // conversation's first request queued behind the abandoned ones.
  const flight = instance.calls.filter((row) => row.url.includes('/speed')).at(-1)?.init?.signal
  check('every request is made with a way to cancel it', flight !== undefined, String(flight))
  const signal = flight
  check('and that signal is not already aborted', signal?.aborted === false, String(signal?.aborted))
  instance.renderer.unmount()
  check('unmounting cancels the request in flight', signal?.aborted === true, String(signal?.aborted))
}
{
  // Never active at all, and this host answered instantly. An instant answer is
  // the only evidence the client has that `after` was ignored — the request was
  // not held — so asking again at once would spin. The slow clock is wrong too:
  // there is nothing warm to watch. What is left is the idle spacing.
  const { instance } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
  })
  const ms = instance.timers.map((row) => row.ms)
  check('a session that has never streamed does not use the slow clock', instance.timers.filter((row) => row.ms === 2000 && row.cleared === false).length === 0, JSON.stringify(ms))
  check('and an answer that came back at once is not repeated at once', instance.timers.filter((row) => row.ms === 0).length === 0, JSON.stringify(ms))
  check('so it settles on the idle spacing until something changes', instance.timers.filter((row) => row.ms === 10000 && row.cleared === false).length === 1, JSON.stringify(ms))
}

{
  // The host held the request for the whole window, which is the only evidence
  // the client has that `after` is honoured. The next ask has to go out at once:
  // `schedule()` runs after the await, so any constant delay here is not a margin
  // around the server's deadline, it is a second quiet period as long as the
  // first — and a reply that lands inside it is one the badge never sees at all.
  // The held window is simulated by advancing the fixture clock by the latency
  // the route took, which is exactly the quantity the client measures.
  const asked = []
  const { instance } = await openPanel(
    {
      ...panelRoutes(),
      '/api/ui-evolve/speed': speedScript([{ ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } }], asked),
    },
    { now: 0, latency: 25000 },
  )
  const ms = instance.timers.map((row) => row.ms)
  check('a request that was held for the whole window is repeated at once', instance.timers.filter((row) => row.ms === 0 && row.cleared === false).length === 1, JSON.stringify(ms))
  check('and nothing waits out a deadline that has already passed', instance.timers.filter((row) => row.ms === 27000).length === 0, JSON.stringify(ms))
}

{
  // A live reading arms the repaint too. A reply goes quiet for longer than the
  // grace period between paragraphs and while a tool call is being assembled,
  // and with a held request the next answer can be a long way off. Without the
  // repaint the badge would keep the last live number, drawn in the live style,
  // for the whole pause — which is the number telling the reader something that
  // stopped being true.
  const { instance } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true } },
  })
  const ms = instance.timers.map((row) => row.ms)
  check('a live reading still schedules the ask that keeps it moving', instance.timers.filter((row) => row.ms === 250 && row.cleared === false).length === 1, JSON.stringify(ms))
  check('and a live reading arms a repaint as well', instance.timers.filter((row) => row.ms === 4000 && row.cleared === false).length === 1, JSON.stringify(ms))
}

{
  // A reading that went active and then inactive: the next ask is close, because
  // the reply may be between paragraphs rather than finished.
  const asked = []
  const { instance } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': speedScript(
      [{ ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true } }, { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } }],
      asked,
    ),
  })
  const first = instance.timers.filter((row) => row.ms === 250 && row.cleared === false)
  check('the live reading scheduled another ask', first.length === 1, JSON.stringify(instance.timers.map((row) => row.ms)))
  first[0]?.fn?.()
  await settle()
  const warm = instance.timers.filter((row) => row.ms === 2000 && row.cleared === false)
  check('a reply that stopped a moment ago is watched at the slow rate', warm.length === 1, JSON.stringify(instance.timers.map((row) => row.ms)))
  // The number has to leave on its own. Without a repaint scheduled for the end of
  // the grace period, the badge keeps whatever it drew until the next ask — which
  // on the slow clock is two seconds after it should already be gone.
  const repaint = instance.timers.filter((row) => row.ms === 4000 && row.cleared === false)
  check('and a repaint is scheduled for when the grace period ends', repaint.length === 1, JSON.stringify(instance.timers.map((row) => row.ms)))
  check('and it does not fall all the way to the idle rate yet', instance.timers.filter((row) => row.ms === 10000 && row.cleared === false).length === 0, JSON.stringify(instance.timers.map((row) => row.ms)))
  check('both asks happened', asked.length >= 2, JSON.stringify(asked))
}

{
  // The last number survives the window emptying — and then it goes. The second
  // half is the one that needs a clock: "kept for four seconds" and "kept
  // forever" look identical at t=0, and only time tells them apart. The fixture
  // moves `Date.now()` by hand because sleeping through the grace period in every
  // case would make the suite slower than the feature it is checking.
  const { instance, tree: live } = await openPanel(
    {
      ...panelRoutes(),
      '/api/ui-evolve/speed': speedScript([
        { ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true } },
        { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
      ]),
    },
    { now: 1000 },
  )
  check('a live reading is on screen', firstByClass(live, 'dsse-speed') !== undefined, textOf(live).slice(0, 120))
  instance.timers.filter((row) => row.ms === 250 && row.cleared === false)[0]?.fn?.()
  await settle()
  const emptied = await instance.renderer.deepRender(instance.seat('cards'))
  check('the last number survives the window emptying', firstByClass(emptied, 'dsse-speed') !== undefined, textOf(emptied).slice(0, 160))
  check('and it is still the last real number', textOf(firstByClass(emptied, 'dsse-speed')).includes('100'), textOf(firstByClass(emptied, 'dsse-speed')))

  instance.clock.at = 1000 + 3999
  const justInside = await instance.renderer.deepRender(instance.seat('cards'))
  check('a number one millisecond short of the grace period is still shown', firstByClass(justInside, 'dsse-speed') !== undefined, textOf(justInside).slice(0, 160))

  instance.clock.at = 1000 + 4001
  const expired = await instance.renderer.deepRender(instance.seat('cards'))
  // The widget stays; the number does not. A readout that vanishes when nothing
  // is happening is a readout nobody can find — and the dash is a different
  // statement from a stale number, which would be read as a fact about now.
  check('the badge is still there once the grace period is over', firstByClass(expired, 'dsse-speed') !== undefined, textOf(firstByClass(expired, 'dsse-top-row')).slice(0, 160))
  check('and it stops claiming a speed', textOf(firstByClass(expired, 'dsse-speed')).includes('100') === false, textOf(firstByClass(expired, 'dsse-speed')))
  check('and it says it is idle instead', textOf(firstByClass(expired, 'dsse-speed')).includes('—'), textOf(firstByClass(expired, 'dsse-speed')))
  check('and it is drawn as the quiet kind', (firstByClass(expired, 'dsse-speed')?.props?.className ?? '').includes('dsse-speed-idle'), String(firstByClass(expired, 'dsse-speed')?.props?.className))
}

{
  // A failed ask keeps the number rather than blanking the badge: a panel that
  // disappears because one request failed is worse than a stale reading, and it
  // is also what an older host half looks like — no route at all. The reading has
  // to be earned first, which is why this fixture answers once and then fails:
  // a badge that never had a number cannot be said to have kept one.
  let asked = 0
  const { instance, tree: earned } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': () => {
      asked += 1
      if (asked > 1) throw new Error('the speed route answered 500')
      return { ok: true, data: { tokens: 100, ms: 1000, tps: 123, active: true } }
    },
  })
  check('a reading is on screen before the failure', textOf(firstByClass(earned, 'dsse-speed')).includes('123'), textOf(firstByClass(earned, 'dsse-speed')))
  instance.timers.filter((row) => row.ms === 250 && row.cleared === false)[0]?.fn?.()
  await settle()
  const afterFailure = await instance.renderer.deepRender(instance.seat('cards'))
  check('a failed ask keeps the number it had', textOf(firstByClass(afterFailure, 'dsse-speed')).includes('123'), textOf(afterFailure).slice(0, 160))
  check('and the badge is still there at all', firstByClass(afterFailure, 'dsse-speed') !== undefined, textOf(afterFailure).slice(0, 160))
  check('and it went back to asking', instance.timers.some((row) => row.cleared === false && row.ms > 0), JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])))
}

{
  // The same shape from the other end: a route that never answers with a reading.
  const { instance, tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': new Error('the speed route answered 500'),
  })
  check('a failed first ask draws no badge', firstByClass(tree, 'dsse-speed') === undefined, textOf(tree).slice(0, 120))
  check('but it still schedules another try', instance.timers.some((row) => row.cleared === false && row.ms > 0), JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])))
  check('and the panel itself still renders', firstByClass(tree, 'dsse-queue') !== undefined, textOf(tree).slice(0, 120))
}

{
  // An older host half: the route answers, but it cannot measure.
  const { tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: false, code: 'error.speed.absent', error: 'this panel does not measure output speed' },
  })
  check('a host that cannot measure draws no badge', firstByClass(tree, 'dsse-speed') === undefined, textOf(tree).slice(0, 120))
  check('and says nothing about it in the panel', textOf(tree).includes('does not measure') === false, textOf(tree).slice(0, 200))
}

{
  // The route answered, and the answer was "nothing has streamed". The widget
  // still has to be there: a readout that only exists during a reply is one
  // nobody can locate, and the whole reason it was asked for is the second
  // before the number appears. `known` is what separates this from an older
  // host that has no route at all — that one must not get a permanent dash.
  const { tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 500, tps: 0, active: true } },
  })
  const badge = firstByClass(tree, 'dsse-speed')
  check('a measured-but-idle session still draws the badge', badge !== undefined, textOf(firstByClass(tree, 'dsse-top-row')).slice(0, 120))
  check('and it does not invent a number', textOf(badge).includes('0 tok/s') === false, textOf(badge))
  check('and it draws the idle form', (badge?.props?.className ?? '').includes('dsse-speed-idle'), String(badge?.props?.className))
}

{
  // A settled session: nothing arriving, but the last reply reported its own token
  // count. This is the state a reader is in almost all the time — they look up
  // after the reply ends — so the widget has to carry that reply's number, not a
  // dash and not a stale window.
  const { tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': {
      ok: true,
      data: { tokens: 0, ms: 0, tps: 0, active: false, last: { tokens: 1500, ms: 30_000, tps: 50 }, revision: 3 },
    },
  })
  const badge = firstByClass(tree, 'dsse-speed')
  check('a settled session shows the last reply', badge !== undefined, textOf(firstByClass(tree, 'dsse-top-row')).slice(0, 120))
  check('and the number is that reply, not a dash', textOf(badge).includes('50'), textOf(badge))
  check('and it still carries the unit', textOf(badge).includes('tok/s'), textOf(badge))
  check('and it is drawn as the settled kind', (badge?.props?.className ?? '').includes('dsse-speed-previous'), String(badge?.props?.className))
  // Which number this is has to reach someone who cannot see the colour: the same
  // digits mean different things live and settled, and "50 tok/s" with no subject
  // is the sentence this whole state exists to avoid.
  check('and the label says it describes the previous reply', (badge?.props?.['aria-label'] ?? '').includes('上一轮'), String(badge?.props?.['aria-label']))
  check('and the tooltip says the same', (badge?.props?.title ?? '').includes('上一轮'), String(badge?.props?.title))
}

{
  // While text is arriving the live window wins: it is the sharper statement about
  // right now, and the settled number is still there underneath.
  const { tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': {
      ok: true,
      data: { tokens: 30, ms: 1000, tps: 30, active: true, last: { tokens: 1500, ms: 30_000, tps: 50 }, revision: 4 },
    },
  })
  const badge = firstByClass(tree, 'dsse-speed')
  check('a live reading beats the last one', textOf(badge).includes('30'), textOf(badge))
  check('and it is not drawn as the settled kind', (badge?.props?.className ?? '').includes('dsse-speed-previous') === false, String(badge?.props?.className))
  check('and the label does not claim a previous reply', (badge?.props?.['aria-label'] ?? '').includes('上一轮') === false, String(badge?.props?.['aria-label']))
}

{
  // Just after a reply ends the freshest statement is the window that closed, not
  // the settled whole-message number. Held wins inside the linger; the settled
  // number takes over only once that reading is stale.
  const { instance } = await openPanel(
    {
      ...panelRoutes(),
      '/api/ui-evolve/speed': speedScript([
        { ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true, last: null, revision: 1 } },
        { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false, last: { tokens: 1500, ms: 30_000, tps: 50 }, revision: 2 } },
      ]),
    },
    { now: 1000 },
  )
  instance.timers.filter((row) => row.ms === 250 && row.cleared === false)[0]?.fn?.()
  await settle()
  const during = await instance.renderer.deepRender(instance.seat('cards'))
  check('the window that just closed outranks the last reply', textOf(firstByClass(during, 'dsse-speed')).includes('100'), textOf(firstByClass(during, 'dsse-speed')))
  check('and it is not labelled as a previous reply yet', (firstByClass(during, 'dsse-speed')?.props?.['aria-label'] ?? '').includes('上一轮') === false, String(firstByClass(during, 'dsse-speed')?.props?.['aria-label']))

  instance.clock.at = 1000 + 4001
  const after = await instance.renderer.deepRender(instance.seat('cards'))
  const settled = firstByClass(after, 'dsse-speed')
  check('once that reading is stale the last reply takes over', textOf(settled).includes('50'), textOf(settled))
  check('and it says so', (settled?.props?.className ?? '').includes('dsse-speed-previous'), String(settled?.props?.className))
}

{
  // Leaving the conversation stops the badge asking. Two sessions' badges left
  // running is a timer per session for the life of the window.
  const { instance } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true } },
  })
  instance.renderer.unmount()
  check('unmounting stops the badge', instance.timers.filter((row) => row.cleared === false).length === 0, JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])))
}

{
  // Switching conversation reuses this component instance, so the number held
  // for the old one has to go before the first request for the new one. Held on
  // across the switch it reads as the new conversation's speed, and it is not.
  const { instance } = await openPanel(
    {
      ...panelRoutes(),
      '/api/ui-evolve/speed': speedScript([
        { ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true } },
        { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
      ]),
    },
    { now: 5000 },
  )
  const cards = instance.seat('cards')
  const toggle = instance.seat('toggle')
  const first = await instance.renderer.deepRender(cards)
  check('the old conversation has a number on screen', textOf(firstByClass(first, 'dsse-speed')).includes('100'), textOf(firstByClass(first, 'dsse-speed')))
  // The new conversation answers "nothing yet", and the clock is still well
  // inside the old number's grace period — so without the reset the old reading
  // is still fresh and paints for the new conversation.
  await instance.renderer.render(toggle, { sessionId: 'session-b' })
  const switched = await instance.renderer.deepRender(cards)
  check('and it does not carry the old number into the new conversation', textOf(firstByClass(switched, 'dsse-speed')).includes('100') === false, textOf(firstByClass(switched, 'dsse-top-row')).slice(0, 160))
  check('so the new conversation reads as idle', textOf(firstByClass(switched, 'dsse-speed')).includes('—'), textOf(firstByClass(switched, 'dsse-speed')))
}

{
  // The linger repaint is a timer like any other, and a poll that finds the
  // window warm can schedule one every two seconds. Left unregistered they stack,
  // and the cleanup that runs on unmount cancels none of them.
  const { instance } = await openPanel(
    {
      ...panelRoutes(),
      '/api/ui-evolve/speed': speedScript([{ ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true } }, { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } }]),
    },
    { now: 5000 },
  )
  const repaints = () => instance.timers.filter((row) => row.ms === 4000)
  // First the live reading arms a repaint and schedules the fast poll; firing it
  // asks again and the answer is "empty but warm", which cancels that repaint and
  // arms a fresh one. Two entries in the log is the expected shape — what matters
  // is that only one of them is still live.
  const fast = instance.timers.filter((row) => row.ms === 250 && row.cleared === false)
  check('a live reading is being watched closely', fast.length === 1, JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])))
  if (fast.length === 1 && typeof fast[0].fn === 'function') fast[0].fn()
  await settle()
  check('an emptied window schedules the repaint', repaints().filter((row) => row.cleared === false).length === 1, JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])))
  // The slow poll fires next and finds the window still warm, scheduling another
  // repaint. Two live repaint timers would mean the first is never cancelled.
  const slow = instance.timers.filter((row) => row.ms === 2000 && row.cleared === false)
  if (slow.length >= 1 && typeof slow[slow.length - 1].fn === 'function') slow[slow.length - 1].fn()
  await settle()
  check('a second warm poll replaces the repaint rather than stacking one', repaints().filter((row) => row.cleared === false).length === 1, JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])))
  instance.renderer.unmount()
  check('unmounting cancels the repaint too', repaints().every((row) => row.cleared === true), JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])))
}

{
  // The number is formatted like the host's own pill: whole numbers above ten so
  // it does not flicker between 47.3 and 47, one decimal below so a slow reply
  // is not reported as zero.
  const { tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 27, ms: 1000, tps: 2.74, active: true } },
  })
  const badge = firstByClass(tree, 'dsse-speed')
  const slow = textOf(badge)
  check('a slow reading keeps one decimal', slow.startsWith('2.7 '), slow)
  check('and it is rounded to that decimal, not printed whole', slow.includes('2.74') === false, slow)
  check('and it does not round to zero', slow.startsWith('0 ') === false, slow)
}

{
  const { tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 473, ms: 1000, tps: 47.35, active: true } },
  })
  const fast = textOf(firstByClass(tree, 'dsse-speed'))
  // Exactly `47`, not `47.3`. The looser assertion this replaced — "the text
  // contains 47" — is satisfied by `47.3` as well, so it could not tell the
  // whole-number branch from the one-decimal branch, and a mutation that deleted
  // the branch survived it.
  check('a fast reading is a whole number', fast.startsWith('47 '), fast)
  check('and it carries no decimal point', fast.includes('47.') === false, fast)
}

{
  // The badge must not share the panel's 8s beat: two timers on the same delay
  // are one delay, and nothing that filters recorded timers can tell them apart.
  const source = readFileSync(join(repo, 'packages', 'ui-evolve', 'lib', 'client.js'), 'utf8')
  check(
    'the idle badge clock is its own number',
    /const SPEED_IDLE_MS = 10000/.test(source),
    (source.match(/const SPEED_IDLE_MS = \d+/) ?? ['none'])[0],
  )
  check(
    'and the panel keeps its eight seconds',
    /const REFRESH_MS = 8000/.test(source),
    (source.match(/const REFRESH_MS = \d+/) ?? ['none'])[0],
  )
}

// ---------------------------------------------------------------------------
// The output card: four rows, the way out visible, and every row a preview
// ---------------------------------------------------------------------------

{
  // Seven files, and the modification times run the *other* way: `f1.md` was
  // edited first in the conversation and is also the *oldest* on disk. Array
  // order is the order they were edited in, newest first — that is what the card
  // claims to show, so the times must disagree with it. A fixture whose times
  // agree cannot tell a sort by `mtimeMs` from no sort at all, and an earlier
  // draft of this block made exactly that mistake: both orders came out the same
  // and the probe survived.
  const rows = Array.from({ length: 7 }, (_, index) => ({
    path: `/work/f${index + 1}.md`,
    bytes: 100 * (index + 1),
    mtimeMs: index * 1000,
    address: `dsh-resource://file/session/session-a/${encodeURIComponent(`work/f${index + 1}.md`)}`,
  }))
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 3, calls: 4, failed: 0, turnFiles: 7,
      summary: { text: 'edited seven files' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: rows,
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  const list = firstByClass(card, 'dsse-files')
  const names = () => byClass(card, 'dsse-name').map((node) => textOf(node))

  check('the output card lists four rows before anybody opens it', names().length === 4, JSON.stringify(names()))
  // The four shown are the first four edited, not the four newest on disk.
  check('the rows are the ones edited last, in that order', JSON.stringify(names()) === JSON.stringify(['f1.md', 'f2.md', 'f3.md', 'f4.md']), JSON.stringify(names()))
  check('the header says how many there are', textOf(firstByClass(card, 'dsse-card-meta')).includes('7 个文件'), textOf(firstByClass(card, 'dsse-card-meta')))
  // The attribute is what switches the scroll box on, so a folded card has to say
  // so. Asserting only the open state let a list that always claimed to be open
  // pass — and that would give a four-row card a scrollbar it does not need.
  check('a folded list does not claim to be open', list?.props?.['data-open'] === 'false', String(list?.props?.['data-open']))
  // The way out must not live inside the list it reveals, or it is clipped with
  // it — which is exactly how "5 of 10" shipped as "only 5". It is now the same
  // round badge the 上一轮 card uses, in the same corner: one column, one gesture,
  // one shape.
  const sheetOf = () => instance.styles.map((node) => String(node.textContent)).join(' ')
  const ruleOf = (selector) => {
    const sheet = sheetOf()
    const at = sheet.indexOf(`${selector}{`)
    if (at < 0) return ''
    const end = sheet.indexOf('}', at)
    return end < 0 ? '' : sheet.slice(at, end + 1)
  }
  // Which way the chevron points. `Icon` is a component, so the rendered tree may
  // hand back the element (carrying `up`) or the `<svg>` it became (carrying the
  // path); read whichever is there rather than pinning the harness's expansion.
  const pointsUp = (tree) => {
    const icon = firstByClass(tree, 'dsse-expand')?.props?.children
    if (icon?.props?.up !== undefined) return icon.props.up === true
    const path = icon?.props?.children
    const d = typeof path?.props?.d === 'string' ? path.props.d : ''
    if (d === '') return undefined
    return d.startsWith('M6 15')
  }
  const badge = firstByClass(card, 'dsse-expand-action')
  // The count is what makes the fold honest: four rows out of seven is a promise
  // that three more exist, and the only thing that says so is this control. A
  // mutation that deletes it outright used to take the suite down with a
  // TypeError at the click below, which the mutation runner records as a crash
  // rather than a kill — so the count is asserted, not just the label.
  check('the control that reveals the rest is a badge on the card', badge !== undefined, JSON.stringify(Object.keys(card ?? {})))
  check('and it is not inside the list it reveals', firstByClass(list, 'dsse-expand') === undefined && firstByClass(list, 'dsse-expand-action') === undefined)
  // The badge answers the question a folded list raises: how many rows are missing
  // from what is on screen. It used to repeat the header's total ("展开全部 7 个"),
  // which answered a question the header had already answered and left the reader
  // to subtract.
  check('it says how many rows are missing', String(badge?.props?.['aria-label'] ?? '') === '显示其余 3 个', String(badge?.props?.['aria-label']))
  // The badge is the control here, not a picture of one. In the 上一轮 card the
  // whole card takes the click, so its badge is a `role="img"` div with the
  // pointer switched off. This card cannot copy that — every row in it is already
  // a button, and a card that answered clicks too would swallow the row presses —
  // so the badge has to carry the click itself.
  check('the badge is the control, not a picture of one', badge?.type === 'button', String(badge?.type))
  check('and it carries its own state', badge?.props?.['aria-expanded'] === false, String(badge?.props?.['aria-expanded']))
  check('and its chevron points down while the card is closed', pointsUp(card) === false, String(pointsUp(card)))
  check('a badge is what reserves the strip at the bottom', card?.props?.['data-badge'] === 'true', String(card?.props?.['data-badge']))
  // Order, not presence. `textOf(card)` walks every descendant, so any check that
  // the label appears somewhere in the card passes whether the control is above
  // the list, below it, or floating over it. `Card` renders `[head, body, badge]`,
  // so the badge's index is the one honest answer.
  check('and it comes after the body it belongs to', (() => {
    const children = Array.isArray(card?.props?.children) ? card.props.children : []
    const bodyAt = children.findIndex((node) => node?.props?.className === 'dsse-card-body')
    const badgeAt = children.findIndex((node) => String(node?.props?.className ?? '').startsWith('dsse-expand'))
    return bodyAt >= 0 && badgeAt > bodyAt
  })(), JSON.stringify((card?.props?.children ?? []).map((node) => node?.props?.className ?? node?.type ?? '')))
  // Exactly one way out. Two of them would be two answers to "how do I see the
  // rest", and the one in the list is the one that gets clipped.
  check('the card offers exactly one way out', byClass(card, 'dsse-expand-action').length === 1, String(byClass(card, 'dsse-expand-action').length))
  // Same circle as the 上一轮 badge — that is the whole request. The shared
  // `.dsse-expand` rule draws it; the action rule is allowed to add behaviour but
  // not to move it or reshape it, so the geometry is asserted on that rule alone.
  check('the badge is the same circle the other card draws', (() => {
    const shared = ruleOf('.dsse-expand')
    return shared.includes('border-radius:999px') && shared.includes('width:26px') && shared.includes('height:26px') && shared.includes('left:50%') && shared.includes('translateX(-50%)') && shared.includes('bottom:8px')
  })(), ruleOf('.dsse-expand').slice(0, 160))
  // `width: 26px` on a 1px-bordered box is not one size, it is two. The 上一轮
  // badge is a `div`, so those 26px are the content box and the border sits
  // outside it — 28px across. This badge is a `button`, and the browser's own
  // stylesheet puts buttons in `border-box`, so its 26px already include the
  // border — 26px across. Same declaration, two diameters, and the whole point of
  // this change was that the two badges read as one object. Pinning the box model
  // in the shared rule is the only place that fixes both at once; the assertion
  // reads that rule because a mock renderer never lays anything out, so a test
  // that only measured the elements would pass on both sizes.
  check('and both badges measure the box the same way', ruleOf('.dsse-expand').includes('box-sizing:border-box'), ruleOf('.dsse-expand').slice(0, 160))
  // It is pressable now, so it has to take the pointer back from the shared rule
  // that switches it off for the card-level badge.
  check('the badge takes the pointer back so it can be pressed', ruleOf('.dsse-expand-action').includes('pointer-events:auto'), ruleOf('.dsse-expand-action').slice(0, 160))
  check('and it looks pressable', ruleOf('.dsse-expand-action').includes('cursor:pointer'), ruleOf('.dsse-expand-action').slice(0, 160))
  // The reserved strip follows the badge rather than the card's other state: a
  // card with no badge needs no room, and an open card whose badge sits on top of
  // its last line would hide the one thing the click was for.
  check('and a badge reserves room for itself below the body', ruleOf('.dsse-card[data-badge="true"] .dsse-card-body').includes('padding-bottom:44px'), ruleOf('.dsse-card[data-badge="true"] .dsse-card-body').slice(0, 160))

  // Every row is a button, because clicking one opens a preview.
  const openRow = firstByClass(list, 'dsse-row-open')
  check('a row is a button, not a div with a handler', openRow?.type === 'button', String(openRow?.type))
  check('and it says what clicking does', String(openRow?.props?.title ?? '').includes('侧栏预览'), String(openRow?.props?.title))
  check('a click opens that file and no other', (() => {
    // The third row on purpose. A click on the first row cannot tell "opens the
    // row it belongs to" from "opens the first file" — both land on the same
    // address, and the mutation that swapped them survived for exactly that
    // reason until this used a row that is not first.
    const row = byClass(list, 'dsse-row-open')[2]
    const handler = row?.props?.onClick
    check('the row answers a click', typeof handler === 'function', String(typeof handler))
    handler?.()
    return instance.openedResources.length === 1 && instance.openedResources[0] === rows[2].address
  })(), JSON.stringify(instance.openedResources))

  // Opening the card scrolls instead of growing without bound.
  //
  // The height is pinned to the number instead of matched as a bare `\d+`:
  // eight rows is the promise, and a row that shrank from 36px to 28px has to
  // take the reservation with it or the list scrolls with a gap below the last
  // row. `\d+` accepted both numbers, so the assertion could not tell that the
  // row height and the reservation had drifted apart.
  check('the list scrolls once it is open, and only then', (() => {
    const sheet = instance.styles.map((node) => String(node.textContent)).join('\n')
    const closed = /\.dsse-files\{/.test(sheet)
    const open = /\.dsse-files\[data-open="true"\]\{[^}]*max-height:245px/.test(sheet) && /\.dsse-files\[data-open="true"\]\{[^}]*overflow-y:auto/.test(sheet)
    return closed && open
  })())
  check('the rows look clickable', /\.dsse-row-open\{[^}]*cursor:pointer/.test(instance.styles.map((node) => String(node.textContent)).join('\n')))

  // The reservation above is arithmetic over the row height, so the row has to
  // *be* that height. Without `border-box` the 2px of vertical padding is added
  // to `min-height` and every row is 32px, which quietly makes the 245px
  // reservation hold seven rows instead of eight.
  check('a row measures what the reservation assumes', /\.dsse-row\{[^}]*box-sizing:border-box/.test(instance.styles.map((node) => String(node.textContent)).join('\n')))

  // The control is pressed through a guard rather than dereferenced: with the
  // badge gone, `byClass(...)[0].props` throws, and a suite that throws prints no
  // tally — the mutation runner records that as a crash instead of a kill, which
  // reads as "this mutation was not testable" rather than "the card lost its only
  // way out".
  const press = (tree) => {
    const control = byClass(tree, 'dsse-expand-action')[0]
    check('the card offers a control to press', control !== undefined && typeof control.props?.onClick === 'function')
    control?.props?.onClick?.()
  }
  press(card)
  const opened = await instance.renderer.deepRender(instance.seat('cards'))
  const openCard = byClass(opened, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  const openNames = byClass(openCard, 'dsse-name').map((node) => textOf(node))
  check('opening the card shows every file', openNames.length === 7, JSON.stringify(openNames))
  check('and the order did not change', JSON.stringify(openNames) === JSON.stringify(rows.map((_, index) => `f${index + 1}.md`)), JSON.stringify(openNames))
  check('the list says it is open', firstByClass(openCard, 'dsse-files')?.props?.['data-open'] === 'true', String(firstByClass(openCard, 'dsse-files')?.props?.['data-open']))
  // An open badge turns its chevron over and says what pressing it again will do.
  // Without the flip the only difference between open and closed is the row count,
  // and without the new label a screen reader keeps announcing "expand" over a
  // control that now collapses.
  check('and the badge now offers the way back', String(firstByClass(openCard, 'dsse-expand-action')?.props?.['aria-label'] ?? '') === '收起文件', String(firstByClass(openCard, 'dsse-expand-action')?.props?.['aria-label']))
  check('and it reports itself open', firstByClass(openCard, 'dsse-expand-action')?.props?.['aria-expanded'] === true, String(firstByClass(openCard, 'dsse-expand-action')?.props?.['aria-expanded']))
  check('and its chevron turned over', pointsUp(openCard) === true, String(pointsUp(openCard)))
  // The header keeps saying how much was produced whether the card is folded or
  // open. It is a statement about the session, not about the viewport, so opening
  // the list must not change it — that would make the total look like it grew.
  check('the header keeps meaning the same thing when the card opens', textOf(firstByClass(openCard, 'dsse-card-meta')).includes('7 个文件'), textOf(firstByClass(openCard, 'dsse-card-meta')))
  check('and the open badge no longer names a remainder', String(firstByClass(openCard, 'dsse-expand-action')?.props?.['aria-label'] ?? '').includes('显示其余') === false, String(firstByClass(openCard, 'dsse-expand-action')?.props?.['aria-label']))

  press(openCard)
  const closed = await instance.renderer.deepRender(instance.seat('cards'))
  const closedCard = byClass(closed, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  check('closing the card puts the fold back', byClass(closedCard, 'dsse-name').length === 4, String(byClass(closedCard, 'dsse-name').length))
}

{
  // Two things the Host's own changed-files card has done for a while and this one
  // did not: files no human wrote are named and counted separately instead of
  // being mixed into the reader's work, and the files this turn touched come
  // before the rest of the session. The fixture is built so that both choices are
  // observable — the array order runs opposite to the turn order, so a card that
  // merely drew the list it was handed fails on the first row.
  const rows = [
    { path: '/work/a.md', bytes: 10, mtimeMs: 100, turn: false, noise: false, address: 'dsh-resource://file/session/session-a/work/a.md' },
    { path: '/work/b.md', bytes: 20, mtimeMs: 200, turn: true, noise: false, address: 'dsh-resource://file/session/session-a/work/b.md' },
    { path: '/work/node_modules/x.js', bytes: 30, mtimeMs: 300, turn: false, noise: true, address: 'dsh-resource://file/session/session-a/work/node_modules/x.js' },
    { path: '/work/c.md', bytes: 40, mtimeMs: 400, turn: true, noise: false, address: 'dsh-resource://file/session/session-a/work/c.md' },
    { path: '/work/d.md', bytes: 50, mtimeMs: 500, turn: false, noise: false, address: 'dsh-resource://file/session/session-a/work/d.md' },
    { path: '/work/e.md', bytes: 60, mtimeMs: 600, turn: true, noise: false, address: 'dsh-resource://file/session/session-a/work/e.md' },
  ]
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 2, calls: 3, failed: 0, turnFiles: 3,
      summary: { text: 'edited three files' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: rows,
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  const names = () => byClass(card, 'dsse-name').map((node) => textOf(node))
  const meta = () => textOf(firstByClass(card, 'dsse-card-meta'))

  // Folded, the four rows are this turn's files first, then the session's older
  // ones. Keeping the handed order would give a.md first, and that is precisely
  // the reading the card is supposed to spare the reader.
  check('the folded card shows this turn before the rest', JSON.stringify(names()) === JSON.stringify(['b.md', 'c.md', 'e.md', 'a.md']), JSON.stringify(names()))
  check('the generated files are not among the folded rows', names().includes('x.js') === false, JSON.stringify(names()))
  // The header counts everything this session produced, generated files included:
  // they were produced. The old header counted only the files a person wrote and
  // then named the generated ones beside it, so the card carried two counts of two
  // different lists next to a badge carrying a third. The generated files are
  // labelled by their own group now, which is where that distinction belongs.
  check('the header counts everything the session produced', meta().includes('6 个文件'), meta())
  check('and it no longer splits the count into two numbers', meta().includes('个生成') === false, meta())
  // A card whose only hidden rows are generated files still needs a way to see
  // them: filtering without an exit is deletion with extra steps. Four of the six
  // rows are drawn (three this turn, then a.md), so two are missing — one written
  // file and one generated one.
  const badge = firstByClass(card, 'dsse-expand-action')
  check('the badge names the rows that are not on screen', String(badge?.props?.['aria-label'] ?? '') === '显示其余 2 个', String(badge?.props?.['aria-label']))

  const press = (tree) => {
    const control = byClass(tree, 'dsse-expand-action')[0]
    check('the card offers a control to press', control !== undefined && typeof control.props?.onClick === 'function')
    control?.props?.onClick?.()
  }
  press(card)
  const opened = await instance.renderer.deepRender(instance.seat('cards'))
  const openCard = byClass(opened, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  const openNames = byClass(openCard, 'dsse-name').map((node) => textOf(node))
  const groups = byClass(openCard, 'dsse-group')
  const groupNames = (key) => {
    const group = groups.find((node) => node.props?.['data-group'] === key)
    return byClass(group, 'dsse-name').map((node) => textOf(node))
  }

  check('opening the card shows every file, generated ones included', openNames.length === 6, JSON.stringify(openNames))
  check('this turn comes first', JSON.stringify(groupNames('fresh')) === JSON.stringify(['b.md', 'c.md', 'e.md']), JSON.stringify(groupNames('fresh')))
  check('then the rest of the session', JSON.stringify(groupNames('earlier')) === JSON.stringify(['a.md', 'd.md']), JSON.stringify(groupNames('earlier')))
  check('and the generated files last', JSON.stringify(groupNames('noise')) === JSON.stringify(['x.js']), JSON.stringify(groupNames('noise')))
  check('the groups are drawn in that order', JSON.stringify(groups.map((node) => node.props?.['data-group'])) === JSON.stringify(['fresh', 'earlier', 'noise']), JSON.stringify(groups.map((node) => node.props?.['data-group'])))
  // Only a group that sits beside another one needs a name: a heading over the
  // only list on the card says nothing the card head has not already said.
  check('the older group is labelled', textOf(groups.find((node) => node.props?.['data-group'] === 'earlier')).includes('更早'), textOf(groups.find((node) => node.props?.['data-group'] === 'earlier')).slice(0, 60))
  check('the generated group is labelled', textOf(groups.find((node) => node.props?.['data-group'] === 'noise')).includes('生成文件'), textOf(groups.find((node) => node.props?.['data-group'] === 'noise')).slice(0, 60))
  check('the rows this turn wrote carry no heading', firstByClass(groups.find((node) => node.props?.['data-group'] === 'fresh'), 'dsse-group-label') === undefined, textOf(groups[0]).slice(0, 60))
  // The row says which kind of file it is, so the dimming rule has something to
  // match even when the reader has scrolled past the group heading.
  const noiseRow = byClass(openCard, 'dsse-row').find((node) => textOf(node).includes('x.js'))
  check('a generated row says so on itself', noiseRow?.props?.['data-noise'] === 'true', String(noiseRow?.props?.['data-noise']))
  check('and a written row does not', byClass(openCard, 'dsse-row').filter((node) => node.props?.['data-noise'] === 'true').length === 1, String(byClass(openCard, 'dsse-row').filter((node) => node.props?.['data-noise'] === 'true').length))

  const sheet = instance.styles.map((node) => String(node.textContent)).join('\n')
  check('the groups are spaced as separate blocks', /\.dsse-group\{[^}]*display:grid/.test(sheet), '')
  check('and the gap between them is drawn once', /\.dsse-group \+ \.dsse-group\{[^}]*margin-top/.test(sheet), '')
  check('a group heading is quieter than a row', /\.dsse-group-label\{[^}]*label-tertiary/.test(sheet), '')
  check('a generated row is dimmed', /\.dsse-row\[data-noise="true"\] \.dsse-name\{[^}]*label-tertiary/.test(sheet), '')
}

{
  // The generated files can be the whole list — a build that touched nothing but
  // its own output. The card still has to offer the way in, because the four
  // written rows it can show number zero and the reader would otherwise be told
  // "0 个文件" with no hint that six exist.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 0,
      summary: { text: 'rebuilt' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: [
        { path: '/work/dist/out.js', bytes: 1, mtimeMs: 1, turn: false, noise: true, address: 'dsh-resource://file/session/session-a/work/dist/out.js' },
        { path: '/work/package-lock.json', bytes: 2, mtimeMs: 2, turn: false, noise: true, address: 'dsh-resource://file/session/session-a/work/package-lock.json' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  check('a card with nothing but generated files shows no rows', byClass(card, 'dsse-name').length === 0, JSON.stringify(byClass(card, 'dsse-name').map((node) => textOf(node))))
  check('and still offers the way to them', byClass(card, 'dsse-expand-action').length === 1, String(byClass(card, 'dsse-expand-action').length))
  check('counting them rather than claiming there are none', textOf(firstByClass(card, 'dsse-card-meta')).includes('2 个文件'), textOf(firstByClass(card, 'dsse-card-meta')))
}

{
  // A Host without a right sidebar must still get a readable list. The row is a
  // plain div in that case: a button that does nothing when pressed is worse
  // than text, because it promises something the Host cannot deliver.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 1,
      summary: { text: 'edited one file' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: [{ path: '/work/only.md', bytes: 12, mtimeMs: 1, address: 'dsh-resource://file/session/session-a/work/only.md' }],
      commands: [],
    },
  }
  const instance = boot({ routes, sidebar: false })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const row = byClass(tree, 'dsse-row')[0]
  check('the file is still listed without a sidebar', row !== undefined && textOf(row).includes('only.md'), textOf(tree).slice(0, 160))
  check('but it is not dressed up as a button', row?.type !== 'button' && row?.props?.onClick === undefined, String(row?.type))
  check('and the plugin still asked for the service it could not get', JSON.stringify(instance.injectedServices).includes('sidebarRight'), JSON.stringify(instance.injectedServices))
  check('the missing sidebar is not a load failure', instance.registrations.length === 2, String(instance.registrations.length))
  // A card that already fits gets no control at all. Rendering one whenever the
  // list is non-empty would put a badge labelled "展开全部 1 个" on a card with
  // nothing behind it — a control that cannot reveal anything. And with no badge
  // there is no strip to reserve, so the body keeps its normal padding.
  check('a card that already fits offers nothing to expand', firstByClass(tree, 'dsse-expand') === undefined && firstByClass(tree, 'dsse-expand-action') === undefined, textOf(tree).slice(0, 160))
  check('and it reserves no room for a badge it does not have', byClass(tree, 'dsse-card').every((node) => node.props?.['data-badge'] === 'false'), JSON.stringify(byClass(tree, 'dsse-card').map((node) => node.props?.['data-badge'])))
}

{
  // The Host throws when no session is mounted, which is an ordinary moment: the
  // panel outlives a session switch. A preview that cannot be opened must not
  // take the whole column of cards down with it.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 1,
      summary: { text: 'a summary worth keeping' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: [{ path: '/work/x.md', bytes: 5, mtimeMs: 1, address: 'dsh-resource://file/session/session-a/work/x.md' }],
      commands: [],
    },
  }
  const instance = boot({ routes, sidebarThrows: true })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const openRow = firstByClass(tree, 'dsse-row-open')
  check('the row still offers a preview', openRow !== undefined, JSON.stringify(byClass(tree, 'dsse-row').length))
  let threw = false
  try {
    openRow?.props?.onClick?.()
  } catch {
    threw = true
  }
  check('a preview that cannot open does not throw into the cards', threw === false)
  check('and the cards are still on screen afterwards', textOf(tree).includes('a summary worth keeping'), textOf(tree).slice(0, 160))
}

{
  // A file that was edited and then deleted is still something this turn did. The
  // old card dropped it, because a row only existed once `stat` agreed the file
  // did — which made "deleted after editing" and "never touched" the same
  // sentence. Three states are the whole point of the change; the row survives,
  // and it says which of the three it is.
  const rows = [
    { path: '/work/there.md', bytes: 10, mtimeMs: 100, turn: true, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/there.md' },
    { path: '/work/gone.md', bytes: null, mtimeMs: null, turn: true, noise: false, status: 'missing', address: 'dsh-resource://file/session/session-a/work/gone.md' },
    { path: '/work/locked.md', bytes: null, mtimeMs: null, turn: false, noise: false, status: 'invalid', address: 'dsh-resource://file/session/session-a/work/locked.md' },
  ]
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 2, calls: 4, failed: 0, turnFiles: 2,
      summary: { text: 'wrote one file and removed another' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: rows,
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  const names = byClass(card, 'dsse-name').map((node) => textOf(node))
  const rowOf = (name) => byClass(card, 'dsse-row').find((node) => textOf(node).includes(name))

  check('a deleted file is still listed', names.includes('gone.md'), JSON.stringify(names))
  check('and so is one that cannot be read', names.includes('locked.md'), JSON.stringify(names))
  check('so all three rows are drawn', byClass(card, 'dsse-row').length === 3, String(byClass(card, 'dsse-row').length))

  // The state travels on the row, because the dimming and the strike-through are
  // CSS and a mock renderer lays nothing out: asserting the attribute is the only
  // way to know the rule has something to match.
  check('a deleted row says it is deleted', rowOf('gone.md')?.props?.['data-status'] === 'missing', String(rowOf('gone.md')?.props?.['data-status']))
  check('an unreadable row says that instead', rowOf('locked.md')?.props?.['data-status'] === 'invalid', String(rowOf('locked.md')?.props?.['data-status']))
  check('a present row says it is available', rowOf('there.md')?.props?.['data-status'] === 'available', String(rowOf('there.md')?.props?.['data-status']))

  // A selector only paints something if the element it names is really there. The
  // rule below needs a `.dsse-name` *inside* the row; the tree has to contain that
  // relationship, or the CSS assertion is testing text nobody matches. Asserting
  // both halves rules out the descendant combinator being dropped from the
  // selector as well: the row itself must not carry `.dsse-name`.
  check('the deleted row still carries its own name element', byClass(rowOf('gone.md'), 'dsse-name').length === 1, String(byClass(rowOf('gone.md'), 'dsse-name').length))
  check('and the row element is not the name element', String(rowOf('gone.md')?.props?.className ?? '').includes('dsse-name') === false, String(rowOf('gone.md')?.props?.className))

  // Where the size used to be, the reason it is not a size any more.
  check('the deleted row does not report a size', textOf(rowOf('gone.md')).includes('已删除'), textOf(rowOf('gone.md')))
  check('the unreadable row says it cannot be read', textOf(rowOf('locked.md')).includes('无法读取'), textOf(rowOf('locked.md')))
  // The exact figure, not a loose unit match: `/B|K|M/` accepts a broken `formatBytes`
  // that returns the letter `B` alone, which is not a size anyone can use.
  check('and the present row still reports its size', textOf(rowOf('there.md')).includes('10 B'), textOf(rowOf('there.md')))

  // Clicking a row that is not there would open an empty preview and teach the
  // reader that the click is broken. It is a div, and it says why.
  // The `rowOf(...) !== undefined` guard is load-bearing: `?.props?.onClick` is
  // also undefined when the row was never drawn, so without it these two checks
  // would pass on a card that dropped missing files entirely — the very defect
  // the three states exist to prevent.
  check('the deleted row is drawn at all', rowOf('gone.md') !== undefined, String(rowOf('gone.md')))
  check('the deleted row offers no preview', rowOf('gone.md') !== undefined && firstByClass(rowOf('gone.md'), 'dsse-row-open') === undefined, String(firstByClass(rowOf('gone.md'), 'dsse-row-open') !== undefined))
  check('and it is not dressed as a button', rowOf('gone.md') !== undefined && rowOf('gone.md')?.type !== 'button', String(rowOf('gone.md')?.type))
  check('its title carries the reason instead of the invitation', String(rowOf('gone.md')?.props?.title ?? '').includes('已被删除或移动') && String(rowOf('gone.md')?.props?.title ?? '').includes('点击在侧栏预览') === false, String(rowOf('gone.md')?.props?.title))
  check('the unreadable row gives its own reason', String(rowOf('locked.md')?.props?.title ?? '').includes('文件存在但无法读取'), String(rowOf('locked.md')?.props?.title))
  check('a present row still invites the click', String(firstByClass(rowOf('there.md'), 'dsse-row-open')?.props?.title ?? '').includes('点击在侧栏预览'), String(firstByClass(rowOf('there.md'), 'dsse-row-open')?.props?.title))

  const sheet = instance.styles.map((node) => String(node.textContent)).join('\n')
  check('a row that is gone is struck through', /\.dsse-row\[data-status="missing"\][^{]*\.dsse-name\{[^}]*line-through/.test(sheet), '')
  check('the strike-through covers unreadable rows too', /\.dsse-row\[data-status="invalid"\][^{]*\.dsse-name\{[^}]*line-through/.test(sheet), '')
  check('a gone row does not highlight under the pointer', /\.dsse-row\[data-status="missing"\]:hover[^{]*\{background:transparent\}/.test(sheet), '')
  check('and the reason takes the place of the size in italics', /\.dsse-size-gone\{font-style:italic\}/.test(sheet), '')
}

{
  // A row from an older Host has no status field at all. Reading it as "gone"
  // would strike through every file on the card the first time the panel is
  // opened against a build that predates the three states.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 1,
      summary: { text: 'edited one file' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: [{ path: '/work/old.md', bytes: 9, mtimeMs: 1, turn: true, address: 'dsh-resource://file/session/session-a/work/old.md' }],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const row = firstByClass(tree, 'dsse-row')
  check('a row with no status is treated as present', row?.props?.['data-status'] === 'available', String(row?.props?.['data-status']))
  check('and it is still openable', typeof firstByClass(row, 'dsse-row-open')?.props?.onClick === 'function', String(typeof firstByClass(row, 'dsse-row-open')?.props?.onClick))
  check('and it still reports its size rather than a reason', textOf(row).includes('9 B'), textOf(row))
}

{
  // Two numbers describe one list, so they have to add up. The header names what a
  // person wrote (and, separately, what was generated); the badge names the size of
  // the whole list. If they disagree the reader has no way to tell which one lied —
  // and a file that is only missing would vanish from the header but stay in the
  // list, which is exactly how the counts drifted before.
  const rows = [
    { path: '/work/a.md', bytes: 1, mtimeMs: 1, turn: true, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/a.md' },
    { path: '/work/b.md', bytes: 1, mtimeMs: 1, turn: true, noise: false, status: 'missing', address: 'dsh-resource://file/session/session-a/work/b.md' },
    { path: '/work/c.md', bytes: 1, mtimeMs: 1, turn: false, noise: false, status: 'invalid', address: 'dsh-resource://file/session/session-a/work/c.md' },
    { path: '/work/d.md', bytes: 1, mtimeMs: 1, turn: false, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/d.md' },
    { path: '/work/e.md', bytes: 1, mtimeMs: 1, turn: false, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/e.md' },
    { path: '/work/f.md', bytes: 1, mtimeMs: 1, turn: false, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/f.md' },
    { path: '/work/node_modules/g.js', bytes: 1, mtimeMs: 1, turn: false, noise: true, status: 'available', address: 'dsh-resource://file/session/session-a/work/node_modules/g.js' },
  ]
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 2, failed: 0, turnFiles: 2,
      summary: { text: 'touched seven files' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: rows,
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  const meta = textOf(firstByClass(card, 'dsse-card-meta'))
  const badge = firstByClass(card, 'dsse-expand-action')

  // The one arithmetic the card has to get right: what the header claims was
  // produced must equal what is on screen plus what the badge says is missing.
  // Two independent counts that never get added up are exactly how a card can say
  // "7 个文件" over a list of four with no way to see the rest.
  const written = Number((meta.match(/(\d+) 个文件/u) ?? [])[1])
  const shown = byClass(card, 'dsse-name').length
  const missing = Number((String(badge?.props?.['aria-label'] ?? '').match(/(\d+) 个/u) ?? [])[1])
  check('the header, the rows and the badge add up', written === shown + missing, `${meta} / shown ${String(shown)} / badge ${String(badge?.props?.['aria-label'])}`)
  check('and the missing and unreadable files are still counted in it', written === 7, `${meta} / ${String(badge?.props?.['aria-label'])}`)
  // The fold shows four rows; the badge names the remainder, not the whole list,
  // because the header already names the whole list. Two numbers that each name
  // the total leave the reader to subtract.
  check('the folded card draws four rows', shown === 4, String(shown))
  check('and the badge names only what is left over', missing === 3, String(missing))
}

// ---------------------------------------------------------------------------
// S2: the row became one line with a glyph, and the directory became relative to
// the workspace. Nothing before this block noticed either change — the card drew
// the same names and the same sizes, so 597 assertions stayed green while the
// whole feature could have been absent. That is the shape of DEF-80: a change is
// only covered when something asserts the new thing exists.
// ---------------------------------------------------------------------------
{
  // The glyph is a function component, so the harness expands it into real nodes
  // before these assertions can see it. Asking for `dsse-row-icon` is therefore
  // asking the question the reader asks: is there a mark here at all.
  //
  // `rowNamed` walks outwards from the name to its row. The name element is the
  // one that carries the visible text, so it is the easiest thing to find; but
  // the glyph is a **sibling** of the name inside `dsse-row-main`, not a child of
  // the name. Searching the name for an icon finds nothing and the assertion
  // reads as "no icons anywhere", which is how the first draft of this block
  // failed twelve checks against working code.
  const rowNamed = (tree, name) => byClass(tree, 'dsse-row').find((row) => textOf(firstByClass(row, 'dsse-name')) === name)
  const iconOf = (row) => byClass(row, 'dsse-fileicon')[0]
  const markOf = (row) => JSON.stringify(iconOf(row)?.props?.children ?? [])
  const bucketOf = (row) => iconOf(row)?.props?.['data-bucket']

  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 4,
      summary: { text: 'wrote four kinds of file' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      cwd: '/work',
      files: [
        { path: '/work/run.ts', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' },
        { path: '/work/page.html', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://b' },
        { path: '/work/theme.css', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://c' },
        { path: '/work/data.json', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://d' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))

  const codeRow = rowNamed(tree, 'run.ts')
  const markupRow = rowNamed(tree, 'page.html')
  const styleRow = rowNamed(tree, 'theme.css')
  const dataRow = rowNamed(tree, 'data.json')

  check('a file row carries a glyph', codeRow !== undefined && iconOf(codeRow) !== undefined, String(iconOf(codeRow)))
  // Each bucket is a different outline now, not a different mark on one page. The
  // assertions name the stroke that only that bucket draws — a single shared
  // silhouette would produce eight identical arrays and fail all four.
  check('a source file is marked as code', bucketOf(codeRow) === 'code' && markOf(codeRow).includes('M10 4.5c-2.6 0-2.6 7.5-5.4 7.5'), markOf(codeRow))
  check('a page is marked as markup', bucketOf(markupRow) === 'markup' && markOf(markupRow).includes('M9.5 4.5L3.5 12l6 7.5'), markOf(markupRow))
  check('a stylesheet is marked as style', bucketOf(styleRow) === 'style' && markOf(styleRow).includes('M10.4 3.5L7.6 20.5'), markOf(styleRow))
  check('structured data is marked as data', bucketOf(dataRow) === 'data' && markOf(dataRow).includes('M3.5 5h17v14h-17z'), markOf(dataRow))
  check('the four marks are not all the same', new Set([markOf(codeRow), markOf(markupRow), markOf(styleRow), markOf(dataRow)]).size === 4, 'marks collapsed together')

  // The stroke colour is inherited rather than set on the svg, so that a row can
  // recolour its glyph in CSS when the file is gone.
  //
  // Scoped to the `.dsse-fileicon` rule on purpose. Searching the whole sheet for
  // `stroke:currentColor` found `.dsse-icon` — the panel's own control glyphs —
  // and passed happily with the file glyph painted `#333`, so the assertion was
  // about the sheet, not about the thing it named.
  const sheet = String(instance.styles.map((node) => String(node.textContent)).join('\n'))
  check('the glyph inherits the colour instead of setting one', (() => {
    const rule = /\.dsse-fileicon\{[^}]*\}/u.exec(sheet)
    return rule !== null && rule[0].includes('stroke:currentColor')
  })(), '')
  // Colour is a grouping cue and nothing else, so it is asserted per bucket. The
  // sheet-wide search this block used to do matched `.dsse-icon` and would pass
  // with every file glyph painted one flat colour.
  const ruleFor = (bucket) => {
    // Sliced rather than matched: this selector contains `[`, `]` and `{`, and a
    // template literal quietly eats the backslashes that would have escaped them.
    const marker = `.dsse-fileicon[data-bucket="${bucket}"]{`
    const at = sheet.indexOf(marker)
    if (at < 0) return ''
    const close = sheet.indexOf('}', at)
    return close < 0 ? '' : sheet.slice(at, close + 1)
  }
  check('a source file is tinted', ruleFor('code').includes('#4c7fb8'), ruleFor('code'))
  check('the six tints are six different colours', (() => {
    const values = ['code', 'markup', 'style', 'data', 'image', 'archive']
      .map((bucket) => (/color:(#[0-9a-f]{6})/u.exec(ruleFor(bucket)) ?? [])[1])
    return values.every((value) => typeof value === 'string') && new Set(values).size === 6
  })(), ['code', 'markup', 'style', 'data', 'image', 'archive'].map(ruleFor).join(' | '))
  // The two buckets that make no claim about the file keep the neutral grey: a card
  // of eight rows should not be eight colours deep.
  check('the buckets that claim nothing stay grey', ruleFor('doc') === '' && ruleFor('file') === '', ruleFor('doc') + ruleFor('file'))
  // A missing file must lose its tint. Colour is a claim about what the file is
  // worth reading as, and a struck-through grey name beside a bright blue glyph
  // says two different things on one line.
  check('a row whose file is gone drops its colour', /\.dsse-row\[data-status="missing"\] \.dsse-fileicon[^{]*\{[^}]*color:var\(--dsw-alias-label-tertiary/u.test(sheet), '')
}

{
  // The remaining buckets, plus the one that must not guess. Each of these has a
  // distinct outline, so the assertion can name it.
  const rowNamed = (tree, name) => byClass(tree, 'dsse-row').find((row) => textOf(firstByClass(row, 'dsse-name')) === name)
  const iconOf = (row) => byClass(row, 'dsse-fileicon')[0]
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 4,
      summary: { text: 'wrote more files' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      cwd: '/work',
      files: [
        { path: '/work/notes.md', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' },
        { path: '/work/shot.png', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://b' },
        { path: '/work/dist.zip', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://c' },
        { path: '/work/Makefile.qqq', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://d' },
        { path: '/work/run.ts', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://e' },
        { path: '/work/page.html', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://f' },
        { path: '/work/theme.css', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://g' },
        { path: '/work/data.json', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://h' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))

  const docRow = rowNamed(tree, 'notes.md')
  const imageRow = rowNamed(tree, 'shot.png')
  const archiveRow = rowNamed(tree, 'dist.zip')
  const unknownRow = rowNamed(tree, 'Makefile.qqq')

  const marksOf = (row) => JSON.stringify(iconOf(row)?.props?.children ?? [])
  const bucketOf = (row) => iconOf(row)?.props?.['data-bucket']

  check('prose is marked as a document', bucketOf(docRow) === 'doc' && marksOf(docRow).includes('M5 3.5h14v17H5z'), marksOf(docRow))
  check('a picture is marked with a picture', bucketOf(imageRow) === 'image' && marksOf(imageRow).includes('"circle"'), marksOf(imageRow))
  check('a bundle is marked as an archive', bucketOf(archiveRow) === 'archive' && marksOf(archiveRow).includes('M4 8.5h16'), marksOf(archiveRow))
  // The blank page is the point: an unknown extension must produce the page outline
  // and nothing else, because a wrong mark tells the reader something false about a
  // file they wrote. The page and its fold are one path here, not two.
  const unknownMarks = iconOf(unknownRow)?.props?.children
  check('an extension nobody knows gets the blank page', Array.isArray(unknownMarks) && unknownMarks.length === 1, JSON.stringify(unknownMarks))
  check('and that page is the one outline that claims nothing', bucketOf(unknownRow) === 'file' && marksOf(unknownRow).includes('M5 3.5h10l4 4v13H5zM15 3.5v4h4'), marksOf(unknownRow))
  // Eight buckets, eight outlines, and no bucket borrowing another's shape. Four are
  // read from this block's rows and four from the block above; every one of the eight
  // is named here so a fallback to the generic page cannot pass unnoticed.
  check('the four buckets here are four different shapes', new Set([marksOf(docRow), marksOf(imageRow), marksOf(archiveRow), marksOf(unknownRow)]).size === 4, [marksOf(docRow), marksOf(imageRow), marksOf(archiveRow), marksOf(unknownRow)].join(' | '))
}

{
  // The directory beside the name: relative to the workspace when the file is
  // inside it, and the last three segments when it is not — or when the server is
  // old enough not to send a workspace at all.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 3,
      summary: { text: 'wrote files in three places' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      cwd: '/work',
      files: [
        { path: '/work/src/lib/inner.ts', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' },
        { path: '/work/top.md', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://b' },
        { path: '/work/deep/a/b/c/d.ts', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://c' },
        { path: '/elsewhere/x/y/z/e.ts', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://d' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))

  const rowOf = (name) => byClass(tree, 'dsse-name').find((node) => textOf(node) === name)?.props?.children
  const whereOf = (name) => {
    const rows = byClass(tree, 'dsse-row')
    for (const row of rows) {
      const nameNode = firstByClass(row, 'dsse-name')
      if (textOf(nameNode) !== name) continue
      const where = firstByClass(row, 'dsse-where')
      return where === undefined ? '' : textOf(where)
    }
    return undefined
  }

  check('a nested file shows the path from the workspace', whereOf('inner.ts') === 'src/lib', String(whereOf('inner.ts')))
  check('a file at the workspace root shows no directory at all', whereOf('top.md') === '', String(whereOf('top.md')))
  check('a deeper file keeps its whole directory, not three segments', whereOf('d.ts') === 'deep/a/b/c', String(whereOf('d.ts')))
  // Outside the workspace there is no relative path to compute, so the row falls
  // back to the tail. Three segments is a guess, but it is the guess every build
  // before S2 made, and a row that suddenly showed nothing would be a regression
  // dressed as a fix.
  check('a file outside the workspace falls back to its tail', whereOf('e.ts') === 'y/z', String(whereOf('e.ts')))
  // The name is still the whole name: shortening the directory must not eat it.
  check('the name survives the directory being shortened', whereOf('inner.ts') !== undefined && rowOf('inner.ts') !== undefined, '')
}

{
  // An older server sends no workspace. The row must still draw a directory —
  // falling back to the last three segments — rather than collapsing to names
  // that two files can share.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 1,
      summary: { text: 'one file' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: [{ path: '/work/src/lib/inner.ts', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' }],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const where = firstByClass(tree, 'dsse-where')
  check('without a workspace the directory is the tail of the path', where !== undefined && textOf(where) === 'src/lib', String(textOf(where)))
}

{
  // Windows paths are case-insensitive, and the two halves arrive from different
  // places: the workspace from the session header, the file from whatever a tool
  // was handed. Without folding case, this row draws its whole absolute path as
  // its directory, right beside rows drawing `src`.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 1,
      summary: { text: 'one file' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      cwd: 'C:\\work',
      files: [
        { path: 'c:\\Work\\src\\a.ts', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' },
        { path: 'C:\\WORK\\b.md', bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://b' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const rows = byClass(tree, 'dsse-row')
  const inner = rows.find((row) => textOf(firstByClass(row, 'dsse-name')) === 'a.ts')
  const root = rows.find((row) => textOf(firstByClass(row, 'dsse-name')) === 'b.md')
  const where = (row) => textOf(firstByClass(row, 'dsse-where'))
  check('a file under the workspace in another case shows the same directory', inner !== undefined && where(inner) === 'src', String(where(inner)))
  check('and it never repeats the absolute path it was matched against', inner !== undefined && String(where(inner)).includes('C:') === false, String(where(inner)))
  check('a root file has no directory even when its case differs', root !== undefined && where(root) === '', String(where(root)))
}

// The directory left the visible row: at 320px it was taking width from the
// name, which is the thing being scanned. It is still rendered — a screen
// reader has no hover — but it must not paint. These assertions are the only
// thing keeping a future layout edit from quietly putting it back.
{
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 3, calls: 4, failed: 0, turnFiles: 3,
      summary: { text: 'eight files' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      cwd: 'C:\\work',
      files: [
        { path: 'C:\\work\\test8\\code.py', bytes: 1314, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const sheet = instance.styles.map((node) => String(node.textContent)).join('\n')
  const dirRule = /\.dsse-where\{[^}]*\}/u.exec(sheet)?.[0] ?? ''
  const nameRule = /\.dsse-name\{[^}]*\}/u.exec(sheet)?.[0] ?? ''
  const row = byClass(tree, 'dsse-row').find((node) => textOf(firstByClass(node, 'dsse-name')) === 'code.py')
  check('the directory is clipped away instead of printed', dirRule.includes('clip:rect(0,0,0,0)'), dirRule)
  check('and it takes no width from the name', dirRule.includes('position:absolute') && dirRule.includes('width:1px'), dirRule)
  check('the name is a block of its own again, not a shrinking sibling', nameRule.includes('display:block'), nameRule)
  check('the name is never told to shrink against a sibling', nameRule.includes('flex:0 1 auto') === false, nameRule)
  const title = String(row?.props?.title ?? '')
  check('the full path is still reachable, on the row tooltip', title.includes('test8') && title.includes('code.py'), title)
}


// ---------------------------------------------------------------------------
// S8: what the sweep could see, and the fold's arithmetic.
//
// The collector can admit that it did not finish looking — `sweep.coverage` is
// `complete`, `partial` or `none`. Until this block nothing on the card read it,
// so a turn where the walk gave up on a big workspace looked exactly like a turn
// that genuinely produced nothing. These assertions are the only thing standing
// between "nothing was produced" and "nothing was produced that I could see".
//
// The fold's numbers are asserted together on purpose: the header says how much
// was produced, the badge says how many rows are missing, and the rows are what
// is on screen. Three numbers about one list have to add up, and only an
// assertion that reads all three at once can catch a card that names two totals.
// ---------------------------------------------------------------------------
{
  const rows = [
    { path: '/work/a.md', bytes: 1, mtimeMs: 1, turn: true, noise: false, address: 'dsh-resource://file/session/session-a/work/a.md' },
    { path: '/work/b.md', bytes: 1, mtimeMs: 1, turn: true, noise: false, address: 'dsh-resource://file/session/session-a/work/b.md' },
  ]
  const withSweep = (sweep) => {
    const routes = panelRoutes()
    routes['/api/ui-evolve/panel'] = {
      ok: true,
      data: {
        turn: 1, calls: 2, failed: 0, turnFiles: 2,
        summary: { text: 'wrote two files' },
        pendingCandidates: 0,
        skills: { available: true, skills: [] },
        mcp: [],
        files: rows,
        sweep,
        commands: [],
      },
    }
    return routes
  }
  const cardFor = async (sweep) => {
    const routes = withSweep(sweep)
    const instance = boot({ routes })
    instance.module.apply(instance.ctx)
    firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
    const tree = await instance.renderer.deepRender(instance.seat('cards'))
    return byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  }
  const noteOf = (card) => {
    const note = firstByClass(card, 'dsse-note')
    return note === undefined ? undefined : textOf(note)
  }

  const partial = await cardFor({ turn: 1, coverage: 'partial' })
  check('a sweep that did not finish says so on the card', noteOf(partial)?.includes('没读完') === true, String(noteOf(partial)))

  const unnamed = await cardFor({ turn: 1, coverage: 'none' })
  check('a sweep that never looked says that instead', noteOf(unnamed)?.includes('没有检查') === true, String(noteOf(unnamed)))
  // The two caveats have to be different sentences. They are different claims:
  // one says there may be more, the other says nobody knows.
  check('and the two caveats are not the same sentence', noteOf(unnamed) !== noteOf(partial), `${String(noteOf(unnamed))} / ${String(noteOf(partial))}`)

  const complete = await cardFor({ turn: 1, coverage: 'complete' })
  // A caveat on every card is a caveat nobody reads. A complete sweep says
  // nothing at all — not "checked", not "complete", nothing.
  check('a sweep that finished says nothing at all', noteOf(complete) === undefined, String(noteOf(complete)))
  check('and the rows are still drawn', byClass(complete, 'dsse-name').length === 2, String(byClass(complete, 'dsse-name').length))

  // A host that never sent `sweep` (an older build) must not have its card
  // decorated with a caveat about a sweep that was never described.
  const noField = await cardFor(undefined)
  check('a payload with no sweep field says nothing either', noteOf(noField) === undefined, String(noteOf(noField)))
  // A `sweep` whose word this build does not know is not read as `partial`: the
  // card can repeat a doubt it was told about, not invent one.
  const unknown = await cardFor({ turn: 1, coverage: 'mostly' })
  check('a coverage word this build does not know draws no caveat', noteOf(unknown) === undefined, String(noteOf(unknown)))
}

{
  // Three rows, so nothing is hidden and the card fits: no badge, and the header
  // still names the total. The badge is a control for a remainder, and there is
  // no remainder — one labelled "显示其余 0 个" would be a control that reveals
  // nothing.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 1,
      summary: { text: 'wrote three files' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: [
        { path: '/work/a.md', bytes: 1, mtimeMs: 1, turn: true, noise: false, address: 'dsh-resource://file/session/session-a/work/a.md' },
        { path: '/work/b.md', bytes: 1, mtimeMs: 1, turn: false, noise: false, address: 'dsh-resource://file/session/session-a/work/b.md' },
        { path: '/work/c.md', bytes: 1, mtimeMs: 1, turn: false, noise: false, address: 'dsh-resource://file/session/session-a/work/c.md' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  check('a card that hides nothing offers no remainder', firstByClass(card, 'dsse-expand-action') === undefined, String(textOf(card).slice(0, 80)))
  check('and its header still names the total', textOf(firstByClass(card, 'dsse-card-meta')).includes('3 个文件'), textOf(firstByClass(card, 'dsse-card-meta')))
  check('and every row is on screen', byClass(card, 'dsse-name').length === 3, String(byClass(card, 'dsse-name').length))
}

{
  // Copying a path is the one row action this panel can offer without asking the
  // Host for a capability it does not expose: `navigator.clipboard.writeText` is
  // the whole requirement. Everything here is about the two ways that turns out
  // to be wrong — a clipboard this Host does not have, and a write that fails.
  //
  // The fixture writes into a workspace so both copy targets exist, and puts one
  // file outside it so the second button has to disappear rather than invent a
  // relative path with `..` in it.
  const rows = [
    { path: 'F:\\work\\src\\inside.ts', bytes: 10, mtimeMs: 100, turn: true, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/src/inside.ts' },
    { path: 'F:\\elsewhere\\outside.ts', bytes: 20, mtimeMs: 200, turn: true, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/elsewhere/outside.ts' },
    // Spelled by a different part of the Host than the workspace was, in the
    // other case. On Windows this is the same directory, so the row is inside
    // and both buttons must exist.
    { path: 'f:\\WORK\\Src\\Cased.ts', bytes: 30, mtimeMs: 300, turn: true, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/Src/Cased.ts' },
  ]
  const routesFor = () => {
    const routes = panelRoutes()
    routes['/api/ui-evolve/panel'] = {
      ok: true,
      data: {
        turn: 2, calls: 4, failed: 0, turnFiles: 2,
        summary: { text: 'wrote two files' },
        pendingCandidates: 0,
        skills: { available: true, skills: [] },
        mcp: [],
        cwd: 'F:\\work',
        files: rows,
        commands: [],
      },
    }
    return routes
  }
  const open = async (settings) => {
    const instance = boot(settings)
    instance.module.apply(instance.ctx)
    firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
    const tree = await instance.renderer.deepRender(instance.seat('cards'))
    const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const rowOf = (name) => byClass(card, 'dsse-row').find((node) => textOf(node).includes(name))
    return { instance, tree, card, rowOf }
  }

  // The Host that has no clipboard is the common one, not the edge case: this
  // panel is served over plain http on the loopback, and `navigator.clipboard`
  // only exists in a secure context. Nothing is drawn, and — the half that is easy
  // to forget — the row must not have made room for the control it did not draw.
  {
    const { card, rowOf } = await open({ routes: routesFor() })
    check('a host without a clipboard draws no copy button', byClass(card, 'dsse-row-copy').length === 0, String(byClass(card, 'dsse-row-copy').length))
    check('and the row does not claim to have actions', rowOf('inside.ts')?.props?.['data-actions'] === 'false', String(rowOf('inside.ts')?.props?.['data-actions']))
    // The size is the thing the control would have covered. On a row with no
    // actions it has to stay visible, or the hover rule is trading the size for
    // nothing at all — asserted on the sheet in the layout block below.
  }

  // A Host that does have one: two buttons on the row that is inside the
  // workspace, one on the row that is not.
  {
    const written = []
    const navigator = { clipboard: { writeText: (value) => { written.push(value); return Promise.resolve() } } }
    const { card, rowOf, instance } = await open({ routes: routesFor(), navigator })
    const inside = rowOf('inside.ts')
    const buttons = byClass(inside, 'dsse-row-copy')
    check('a host with a clipboard draws both copy buttons', buttons.length === 2, String(buttons.length))
    check('and the row says it has actions', inside?.props?.['data-actions'] === 'true', String(inside?.props?.['data-actions']))
    // The buttons are siblings of the opener, not children: nesting one button in
    // another is invalid HTML, and the inner one becomes unreachable by keyboard.
    check('the opener and the actions are siblings', byClass(inside, 'dsse-row-actions').length === 1 && byClass(inside, 'dsse-row-open').length === 1, JSON.stringify([byClass(inside, 'dsse-row-actions').length, byClass(inside, 'dsse-row-open').length]))
    // The row is not itself a click target any more. If it carried a handler
    // again, the actions inside it would fire both -- but the reason to say it
    // out loud is the opposite bug: a row that looks clickable and is not.
    check('and the row itself is not a click target', inside?.props?.onClick === undefined && inside?.props?.type === undefined, JSON.stringify([typeof inside?.props?.onClick, String(inside?.props?.type)]))
    check('and the buttons live in the actions block', byClass(firstByClass(inside, 'dsse-row-actions'), 'dsse-row-copy').length === 2, String(byClass(firstByClass(inside, 'dsse-row-actions'), 'dsse-row-copy').length))
    check('and the opener does not contain them', byClass(firstByClass(inside, 'dsse-row-open'), 'dsse-row-copy').length === 0, String(byClass(firstByClass(inside, 'dsse-row-open'), 'dsse-row-copy').length))

    // A file outside the workspace has no workspace-relative name. Copying one
    // would be copying a path with `..` segments that no build ever wrote, so the
    // button is absent instead of being wrong.
    const outside = rowOf('outside.ts')
    check('a file outside the workspace offers only the absolute path', byClass(outside, 'dsse-row-copy').length === 1, String(byClass(outside, 'dsse-row-copy').length))
    // One button still counts as "has actions": deriving the flag from the
    // relative button instead would mark this row action-less, and the CSS
    // reveal rule would then keep its one button invisible forever.
    check('and the row still says it has an action', outside?.props?.['data-actions'] === 'true', String(outside?.props?.['data-actions']))
    const outsideButton = byClass(outside, 'dsse-row-copy')[0]
    if (outsideButton === undefined) {
      check('and copying it writes the absolute path', false, 'no copy button on the outside row')
    } else {
      outsideButton.props.onClick()
      await instance.renderer.deepRender(instance.seat('cards'))
      check('and copying it writes the absolute path', written[written.length - 1] === 'F:\\elsewhere\\outside.ts', JSON.stringify(written[written.length - 1]))
    }

    // The workspace is `F:\\work` and this file is recorded as `f:\\WORK\\src\\cased.ts`.
    // Windows resolves both to the same directory, and the two spellings come from
    // different parts of the Host, so the comparison cannot care about case.
    const cased = rowOf('Cased.ts')
    const casedButtons = byClass(cased, 'dsse-row-copy')
    check('a file spelled in another case is still inside the workspace', casedButtons.length === 2, String(casedButtons.length))
    // Indexed defensively: when the button is missing this has to be a failed
    // check, not a throw. A throw takes the whole suite down with no tally line,
    // and the mutation runner then reports CRASHED — a different verdict from the
    // KILLED this assertion is here to produce.
    if (casedButtons.length === 2) {
      casedButtons[1].props.onClick()
      check('and its relative path is cut at the workspace root', written[written.length - 1] === 'Src/Cased.ts', JSON.stringify(written[written.length - 1]))
    } else {
      check('and its relative path is cut at the workspace root', false, 'no relative button to press')
    }

    // Clicking copies, and says so on the button that was pressed.
    const [absolute, relative] = buttons
    check('the first button names the absolute path', String(absolute?.props?.['aria-label'] ?? '') === '复制绝对路径', String(absolute?.props?.['aria-label']))
    check('the second names the relative one', String(relative?.props?.['aria-label'] ?? '') === '复制相对路径', String(relative?.props?.['aria-label']))
    absolute.props.onClick()
    await instance.renderer.deepRender(instance.seat('cards'))
    check('pressing it writes the absolute path', written[written.length - 1] === 'F:\\work\\src\\inside.ts', JSON.stringify(written))
    const answered = await instance.renderer.deepRender(instance.seat('cards'))
    const answeredCard = byClass(answered, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const answeredRow = byClass(answeredCard, 'dsse-row').find((node) => textOf(node).includes('inside.ts'))
    const answeredButtons = byClass(answeredRow, 'dsse-row-copy')
    check('and the button says it worked', textOf(answeredButtons[0]) === '已复制', textOf(answeredButtons[0]))
    check('while its neighbour is unchanged', textOf(answeredButtons[1]) === '相对', textOf(answeredButtons[1]))
    // What a screen reader hears. The visible text alone is not the answer: the
    // name is what gets announced, and a fixed name means a blind user never
    // learns whether the copy worked.
    check('and the button name says it worked', String(answeredButtons[0]?.props?.['aria-label'] ?? '') === '已复制绝对路径', String(answeredButtons[0]?.props?.['aria-label']))
    check('and the untouched neighbour keeps its name', String(answeredButtons[1]?.props?.['aria-label'] ?? '') === '复制相对路径', String(answeredButtons[1]?.props?.['aria-label']))


    // The relative button writes a forward-slash path relative to the workspace:
    // backslashes are a Windows path, not a path in source code.
    answeredButtons[1].props.onClick()
    await instance.renderer.deepRender(instance.seat('cards'))
    check('the relative button writes the workspace-relative path', written[written.length - 1] === 'src/inside.ts', JSON.stringify(written))

  // A timer scheduled on a ref is invisible: it is not in the rendered tree, and
  // no cleanup the panel already has would notice it. Unmounting while the flash
  // is pending has to cancel it, or the callback writes state into a component
  // that is gone and the host keeps a timer for a panel nobody is looking at.
  //
  // This needs its own instance: unmounting is terminal for the renderer, so it
  // cannot share a fixture with the assertions above that still want to render.
  {
    // `writeText` returning nothing settles synchronously, which is the only way
    // to see the timer before the microtask that a resolved promise would need.
    const kept = { clipboard: { writeText: () => undefined } }
    const own = await open({ routes: routesFor(), navigator: kept })
    byClass(own.rowOf('inside.ts'), 'dsse-row-copy')[0].props.onClick()
    const scheduled = own.instance.timers.filter((entry) => entry.ms === 1500 && entry.cleared === false)
    check('the flash leaves one timer pending', scheduled.length === 1, String(scheduled.length))
    own.instance.renderer.unmount()
    check('and closing the panel cancels the flash timer', scheduled.every((entry) => entry.cleared === true), JSON.stringify(scheduled.map((entry) => entry.cleared)))
  }

    // The confirmation is a flash, not a state: 1.5 seconds later the button is a
    // label again. Asserting the delay is the difference between a flash and a
    // button that permanently reads "已复制" after one click.
    const pending = instance.timers.filter((entry) => entry.ms === 1500 && entry.cleared === false)
    // Exactly one: two clicks in a row must cancel the first timer, and `> 0`
    // cannot tell that apart from the leak it is here to catch.
    check('the confirmation is scheduled to clear', pending.length === 1, String(pending.length))
    for (const entry of pending) entry.fn()
    const cleared = await instance.renderer.deepRender(instance.seat('cards'))
    const clearedCard = byClass(cleared, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const clearedRow = byClass(clearedCard, 'dsse-row').find((node) => textOf(node).includes('inside.ts'))
    // Both buttons, and index 1 first: that is the one whose timer is pending.
    // Reading index 0 here would pass either way, because the absolute button's
    // timer was cancelled by the second press and its resting label is already
    // "绝对" -- the check would be green with the callback deleted outright.
    const clearedButtons = byClass(clearedRow, 'dsse-row-copy')
    check('and it does clear, back to the label', textOf(clearedButtons[1]) === '相对' && textOf(clearedButtons[0]) === '绝对', JSON.stringify(clearedButtons.map((node) => textOf(node))))
  }

  // A write that throws, and a write that rejects. Both mean the same thing to the
  // person who pressed the button, and neither may be reported as success.
  {
    const throwing = { clipboard: { writeText: () => { throw new Error('denied') } } }
    const first = await open({ routes: routesFor(), navigator: throwing })
    byClass(first.rowOf('inside.ts'), 'dsse-row-copy')[0].props.onClick()
    const afterThrow = await first.instance.renderer.deepRender(first.instance.seat('cards'))
    const throwCard = byClass(afterThrow, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const throwRow = byClass(throwCard, 'dsse-row').find((node) => textOf(node).includes('inside.ts'))
    check('a clipboard that throws is not reported as success', textOf(byClass(throwRow, 'dsse-row-copy')[0]) === '失败', textOf(byClass(throwRow, 'dsse-row-copy')[0]))
    check('and the tooltip says why', String(byClass(throwRow, 'dsse-row-copy')[0]?.props?.title ?? '').includes('复制失败'), String(byClass(throwRow, 'dsse-row-copy')[0]?.props?.title))
    check('and a screen reader hears the failure', String(byClass(throwRow, 'dsse-row-copy')[0]?.props?.['aria-label'] ?? '') === '复制绝对路径失败', String(byClass(throwRow, 'dsse-row-copy')[0]?.props?.['aria-label']))

    const rejecting = { clipboard: { writeText: () => Promise.reject(new Error('denied')) } }
    const second = await open({ routes: routesFor(), navigator: rejecting })
    const secondButtons = byClass(second.rowOf('inside.ts'), 'dsse-row-copy')
    secondButtons[0].props.onClick()
    // A rejected promise settles on a microtask, and the renderer drains those
    // between rounds — so the failure is on screen by the next deep render.
    const afterReject = await second.instance.renderer.deepRender(second.instance.seat('cards'))
    const rejectCard = byClass(afterReject, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const rejectRow = byClass(rejectCard, 'dsse-row').find((node) => textOf(node).includes('inside.ts'))
    check('a rejected write is not reported as success either', textOf(byClass(rejectRow, 'dsse-row-copy')[0]) === '失败', textOf(byClass(rejectRow, 'dsse-row-copy')[0]))
  }

  // A stub is allowed to return nothing at all, and that has to mean the same as
  // a resolved promise. The harness's own clipboard double is written by hand, so
  // this is the shape a future fixture is most likely to have — treating it as a
  // failure would make a working clipboard look broken in exactly the tests that
  // fake it.
  {
    const silent = { clipboard: { writeText: () => undefined } }
    const { instance, rowOf } = await open({ routes: routesFor(), navigator: silent })
    byClass(rowOf('inside.ts'), 'dsse-row-copy')[0].props.onClick()
    const tree = await instance.renderer.deepRender(instance.seat('cards'))
    const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const row = byClass(card, 'dsse-row').find((node) => textOf(node).includes('inside.ts'))
    check('a clipboard that returns nothing counts as success', textOf(byClass(row, 'dsse-row-copy')[0]) === '已复制', textOf(byClass(row, 'dsse-row-copy')[0]))
  }

  // Copying on a file that is gone: the row still names the file, and the path it
  // would copy is still the path it used to have, so the button stays. What must
  // not happen is an opener appearing beside it.
  {
    const goneRows = [{ path: 'F:\\work\\gone.ts', bytes: null, mtimeMs: null, turn: true, noise: false, status: 'missing', address: 'dsh-resource://file/session/session-a/work/gone.ts' }]
    const routes = panelRoutes()
    routes['/api/ui-evolve/panel'] = {
      ok: true,
      data: {
        turn: 1, calls: 2, failed: 0, turnFiles: 1,
        summary: { text: 'wrote one file' },
        pendingCandidates: 0,
        skills: { available: true, skills: [] },
        mcp: [],
        cwd: 'F:\\work',
        files: goneRows,
        commands: [],
      },
    }
    const written = []
    const navigator = { clipboard: { writeText: (value) => { written.push(value); return Promise.resolve() } } }
    const instance = boot({ routes, navigator })
    instance.module.apply(instance.ctx)
    firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
    const tree = await instance.renderer.deepRender(instance.seat('cards'))
    const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    check('a gone file still offers its path', byClass(card, 'dsse-row-copy').length === 2, String(byClass(card, 'dsse-row-copy').length))
    check('and still offers no way to open it', firstByClass(card, 'dsse-row-open') === undefined, 'opener present')
    byClass(card, 'dsse-row-copy')[0].props.onClick()
    await instance.renderer.deepRender(instance.seat('cards'))
    check('copying a gone path writes the path it had', written[written.length - 1] === 'F:\\work\\gone.ts', JSON.stringify(written))
  }

  // The layout promise. The action block is absolutely positioned over the size
  // rather than laid out beside it, and the size keeps its slot when hidden, so a
  // name does not change width when the pointer arrives. The mock renderer lays
  // nothing out, so the sheet is the only place this can be asserted.
  {
    const instance = boot({ routes: routesFor() })
    // The sheet is written when the panel renders, not when the bundle is
    // evaluated or the plugin is applied: a boot with no render has an empty
    // style list, and every rule below would then be a regex against nothing.
    instance.module.apply(instance.ctx)
    firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
    await instance.renderer.deepRender(instance.seat('cards'))
    const sheet = instance.styles.map((node) => String(node.textContent)).join('\n')
    check('the sheet this block asserts against is not empty', sheet.includes('dsse-row-copy'), `${instance.styles.length} sheets`)
    check('the actions are taken out of the row flow', /\.dsse-row-actions\{[^}]*position:absolute/.test(sheet), '')
    check('and the row is their positioning context', /\.dsse-row\{[^}]*position:relative/.test(sheet), '')
    check('they are invisible until the row is pointed at', /\.dsse-row-actions\{[^}]*opacity:0/.test(sheet), '')
    check('and they do not take clicks while invisible', /\.dsse-row-actions\{[^}]*pointer-events:none/.test(sheet), '')
    // Scoped to rows that have actions. On a Host without a clipboard the rule
    // would otherwise hide the size to make room for nothing.
    check('the reveal only applies where there is something to reveal', /\.dsse-row\[data-actions="true"\]:hover \.dsse-row-actions/.test(sheet), '')
    // The selector is half of it: a rule that matches and then sets opacity:0
    // would never show a button, and every check above would still pass.
    check('and the reveal sets the actions visible', /\.dsse-row\[data-actions="true"\]:hover \.dsse-row-actions[^{]*\{[^}]*opacity:1/.test(sheet), '')
    check('and makes them take clicks', /\.dsse-row\[data-actions="true"\]:focus-within \.dsse-row-actions[^{]*\{[^}]*pointer-events:auto/.test(sheet), '')
    check('and the size it covers hides by slot, not by layout', /\.dsse-row\[data-actions="true"\]:hover \.dsse-size[^{]*\{visibility:hidden\}/.test(sheet), '')
    // Focus must NOT hide the size. `visibility:hidden` also leaves the
    // accessibility tree, so a keyboard or screen-reader user would lose the file
    // size the moment they focused the row -- and they never hover, so the size
    // they "save" by not covering is a number they would never have seen. The
    // actions cover it visually; the value stays in the name.
    check('and focus does not hide the size from the accessibility tree', /\.dsse-row\[data-actions="true"\]:focus-within \.dsse-size[^{]*\{visibility:hidden\}/.test(sheet) === false, '')
    check('the hiding rule never uses display', /\.dsse-row\[data-actions="true"\][^{]*\.dsse-size[^{]*\{[^}]*display:none/.test(sheet) === false, '')
    // Keyboard reachability: hiding the actions from the pointer must not hide
    // them from the tab order, or the feature only exists for mouse users.
    check('a focused row reveals them too', /\.dsse-row\[data-actions="true"\]:focus-within \.dsse-row-actions/.test(sheet), '')
    check('and the copy button has its own focus ring', /\.dsse-row-copy:focus-visible\{[^}]*outline/.test(sheet), '')
    check('the button looks like a button', /\.dsse-row-copy\{[^}]*cursor:pointer/.test(sheet), '')
    // The opener has to fill the row, or the row's padding becomes dead space:
    // the highlight says "click here" over pixels that do nothing. The mock
    // renderer lays nothing out, so this is the only place the fix can be pinned.
    check('the opener stretches over the row\'s padding', /\.dsse-row-open\{[^}]*align-self:stretch/.test(sheet) && /\.dsse-row-open\{[^}]*margin:-2px -6px/.test(sheet), '')
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failed === 0 ? 0 : 1)
