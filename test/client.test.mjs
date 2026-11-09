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
  const DateStub = { now: () => (clock.real === true ? Date.now() : clock.at) }

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
check('three effects are declared', booted.effects.length === 3, String(booted.effects.length))

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
  // The reader's language is the host's, and the host writes it to `<html lang>`.
  // Without it the model picks a language from the transcript, which is how a
  // Chinese reader kept getting English summaries. The attribute is read at ask
  // time rather than captured once, so the fixture sets it before boot.
  check(
    'the panel is told which language the reader uses',
    instance.calls.some((row) => row.url.includes('lang=zh-CN')),
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
// The language is read from the host, and read again every time
// ---------------------------------------------------------------------------

// `<html lang>` is the only place the bundle can find out what language the
// reader uses: the host's locale preference lives in settings, which the client
// does not get, and an unset preference is resolved by the browser. The host
// writes the result of that resolution to the attribute, so the attribute is the
// answer whether the reader chose a language or left it to the browser.
{
  // No attribute is not a reason to guess. A wrong language is obeyed, while a
  // missing one lets the model read the transcript and decide for itself, which
  // is the behaviour that predates this path.
  const instance = boot({ routes: panelRoutes(), lang: '' })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  await instance.renderer.deepRender(instance.seat('cards'))
  check(
    'a host that names no language asks without one',
    instance.calls.some((row) => row.url.includes('/panel?')) && instance.calls.every((row) => row.url.includes('lang=') === false),
    JSON.stringify(instance.calls.map((row) => row.url)),
  )
}

{
  // The attribute is read when the panel asks, not when the bundle loads: a
  // reader who changes the interface language gets the new one on the next poll
  // rather than after a restart.
  const instance = boot({ routes: panelRoutes(), lang: 'en-GB' })
  instance.module.apply(instance.ctx)
  firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  await instance.renderer.deepRender(instance.seat('cards'))
  check(
    'the first ask carries the language the host set',
    instance.calls.some((row) => row.url.includes('lang=en-GB')),
    JSON.stringify(instance.calls.map((row) => row.url)),
  )
  instance.document.documentElement.lang = 'ja'
  const poll = instance.timers.find((row) => row.ms === 8000 && row.cleared === false)
  check('the panel is still polling', poll !== undefined, JSON.stringify(instance.timers.map((row) => row.ms)))
  // Called through `?.` rather than inside an `if`: the assertion below is the
  // only thing that reads the language of a later poll. Guarding it on `poll`
  // turns a fixture change into no assertion at all while the suite stays green,
  // and calling it bare turns the same change into a crash the mutation scripts
  // score as "survived". A missing poll must fail the assertion, not skip it and
  // not take the tally line with it.
  const before = instance.calls.length
  poll?.fn?.()
  await settle()
  const after = instance.calls.slice(before)
  check(
    'a language changed between polls is picked up',
    after.length > 0 && after.every((row) => row.url.includes('lang=ja')),
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
  // Never active at all: straight to the idle clock. The two-second clock is for
  // a reading that was live a moment ago, not for one that never existed.
  const { instance } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
  })
  const slow = instance.timers.filter((row) => row.ms === 2000 && row.cleared === false)
  const idle = instance.timers.filter((row) => row.ms === 10000 && row.cleared === false)
  check('a session that has never streamed goes straight to the idle clock', slow.length === 0 && idle.length >= 1, JSON.stringify(instance.timers.map((row) => row.ms)))
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
  // A settled session: nothing arriving, but five messages have reported their
  // own token counts. This is the state a reader is in almost all the time —
  // they look up after the reply ends — so the widget has to carry the standing
  // number, not a dash and not a stale window.
  const { tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': {
      ok: true,
      data: { tokens: 0, ms: 0, tps: 0, active: false, average: { tokens: 1500, ms: 30_000, tps: 50, samples: 5 } },
    },
  })
  const badge = firstByClass(tree, 'dsse-speed')
  check('a settled session shows the standing average', badge !== undefined, textOf(firstByClass(tree, 'dsse-top-row')).slice(0, 120))
  check('and the number is the average, not a dash', textOf(badge).includes('50'), textOf(badge))
  check('and it still carries the unit', textOf(badge).includes('tok/s'), textOf(badge))
  check('and it is drawn as the standing kind', (badge?.props?.className ?? '').includes('dsse-speed-average'), String(badge?.props?.className))
  // Which number this is has to reach someone who cannot see the colour: the
  // same digits mean different things live and settled.
  check('and the label says how many messages it covers', (badge?.props?.['aria-label'] ?? '').includes('最近 5 次'), String(badge?.props?.['aria-label']))
  check('and the tooltip says it is an average', (badge?.props?.title ?? '').includes('平均'), String(badge?.props?.title))
}

{
  // While text is arriving the live window wins: it is the sharper statement
  // about right now, and the average is still there underneath.
  const { tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': {
      ok: true,
      data: { tokens: 30, ms: 1000, tps: 30, active: true, average: { tokens: 1500, ms: 30_000, tps: 50, samples: 5 } },
    },
  })
  const badge = firstByClass(tree, 'dsse-speed')
  check('a live reading beats the standing average', textOf(badge).includes('30'), textOf(badge))
  check('and it is not drawn as the standing kind', (badge?.props?.className ?? '').includes('dsse-speed-average') === false, String(badge?.props?.className))
  check('and the label does not claim an average', (badge?.props?.['aria-label'] ?? '').includes('平均') === false, String(badge?.props?.['aria-label']))
}

{
  // Just after a reply ends the freshest statement is the window that closed,
  // not the mean over five messages. Held wins inside the linger; the average
  // takes over only once that reading is stale.
  const { instance } = await openPanel(
    {
      ...panelRoutes(),
      '/api/ui-evolve/speed': speedScript([
        { ok: true, data: { tokens: 100, ms: 1000, tps: 100, active: true, average: null } },
        { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false, average: { tokens: 1500, ms: 30_000, tps: 50, samples: 5 } } },
      ]),
    },
    { now: 1000 },
  )
  instance.timers.filter((row) => row.ms === 250 && row.cleared === false)[0]?.fn?.()
  await settle()
  const during = await instance.renderer.deepRender(instance.seat('cards'))
  check('the window that just closed outranks the average', textOf(firstByClass(during, 'dsse-speed')).includes('100'), textOf(firstByClass(during, 'dsse-speed')))
  check('and it is not labelled as an average yet', (firstByClass(during, 'dsse-speed')?.props?.['aria-label'] ?? '').includes('平均') === false, String(firstByClass(during, 'dsse-speed')?.props?.['aria-label']))

  instance.clock.at = 1000 + 4001
  const after = await instance.renderer.deepRender(instance.seat('cards'))
  const standing = firstByClass(after, 'dsse-speed')
  check('once that reading is stale the average takes over', textOf(standing).includes('50'), textOf(standing))
  check('and it says so', (standing?.props?.className ?? '').includes('dsse-speed-average'), String(standing?.props?.className))
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
  // First the live reading schedules the fast poll; firing it asks again and the
  // answer is "empty but warm", which is what schedules the repaint.
  const fast = instance.timers.filter((row) => row.ms === 250 && row.cleared === false)
  check('a live reading is being watched closely', fast.length === 1, JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])))
  if (fast.length === 1 && typeof fast[0].fn === 'function') fast[0].fn()
  await settle()
  check('an emptied window schedules the repaint', repaints().length === 1, JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])))
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

console.log(`\n${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failed === 0 ? 0 : 1)
