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
import { placeMonitor, MONITOR_MIN_WIDTH, MONITOR_MAX_WIDTH } from '../packages/ui-evolve/lib/gutter.js'

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

// A crash is not a failure to anything that greps output for failures. Before
// this, a TypeError anywhere in this file exited with code 1 and no tally line,
// and the mutation runner -- which decides KILLED by looking for a failing suite
// -- read that as SURVIVED. Silently. Five separately-recorded defects (DEF-122,
// DEF-134, DEF-139, DEF-145, DEF-146) all have that same shape: "did not run"
// reported as "ran and found nothing".
//
// The tally is the contract with the runner, so print it however the run ends,
// and name the throw. Exiting is deliberate: after an uncaught throw the blocks
// below have lost their state, and carrying on would report assertions that
// never had a chance to run as though they had passed.
let reported = false

function report(extra) {
  if (reported === true) return
  reported = true
  if (extra !== undefined) {
    failed += 1
    failures.push(extra)
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  for (const failure of failures) console.log(`  FAIL ${failure}`)
}

/**
 * Click the header toggle only when the panel is not already showing.
 *
 * The panel opens by default now, so an unconditional click *closes* it. Every
 * fixture that wanted the cards on screen used to say "click the toggle", and
 * after the default flipped that sentence meant the opposite of what it read.
 * The intent was always "make sure the panel is showing", so the helper states
 * the intent and the read-then-click guard makes it true regardless of default.
 */
function pressToggle(button) {
  if (button === undefined || button === null) return
  if (button.props?.['data-active'] === 'true') return
  if (typeof button.props?.onClick === 'function') button.props.onClick()
}

process.on('uncaughtException', (error) => {
  if (process.env.DS_SE_TRACE === '1') console.error(error.stack)
  report(`the suite threw before it finished — ${error === undefined || error === null ? 'unknown' : error.message ?? String(error)}`)
  process.exit(1)
})

process.on('unhandledRejection', (error) => {
  report(`the suite rejected before it finished — ${error === undefined || error === null ? 'unknown' : error.message ?? String(error)}`)
  process.exit(1)
})

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
    // A real node has this; a double only has it when the test says so, which is
    // what separates "the panel asked to be scrolled into view" from "the panel
    // called a method on layout that does not exist here".
    scrollIntoView: (options) => frame.onScrollIntoView?.(options),
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
// A nav stub whose `style` behaves like the real thing. In a browser,
// `element.style` is a proxy over the CSSOM: it has no own `display` property,
// so `delete node.style.display` returns true and removes nothing -- measured on
// the live page, where a nav carried `display:block` after exactly that call and
// the rail stayed on after the column closed. A plain object cannot fail that
// way, which is why the first version of this file passed the very regression it
// was meant to pin. `removeProperty` replicates the mapping a real declaration
// applies between the CSS name and the JS field.
function navStub(label) {
  const fields = { display: 'display', 'z-index': 'zIndex', visibility: 'visibility', 'pointer-events': 'pointerEvents' }
  const style = {
    removeProperty(name) {
      const field = fields[name]
      if (field !== undefined) style[field] = ''
    },
  }
  // Non-configurable, exactly like the CSSOM's own accessors. `delete
  // element.style.display` on a real element returns false and removes nothing;
  // on a plain object it returns true and the field really is gone, which is why
  // a stub made of literals passed the very regression this file exists to pin.
  for (const field of Object.values(fields)) {
    Object.defineProperty(style, field, { value: '', writable: true, enumerable: true, configurable: false })
  }
  return { style, getAttribute: (n) => (n === 'aria-label' ? label : null) }
}

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
  // How many times a setter actually replaced its slot. React compares state by
  // identity and does nothing when the value is the same object, so this counts
  // the updates React would have acted on -- which is the thing a poll that
  // changes nothing must not produce.
  let stateChanges = 0

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
        stateChanges += 1
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

  return {
    hooks,
    render,
    deepRender,
    unmount,
    setNodeForRef,
    setTriggerForRef,
    /** @returns {number} state replacements so far, the ones React would act on. */
    stateChanges: () => stateChanges,
  }
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
  // ---------------------------------------------------------------------------
  // `EventSource`, which is how the panel learns that something changed
  // ---------------------------------------------------------------------------
  //
  // The plugin opens one stream per watched session and fetches on each frame.
  // A suite with no `EventSource` at all would take the "this environment cannot
  // stream" branch and quietly test only the sixty-second fallback, which is the
  // path the feature exists to avoid.
  //
  // Records rather than a live server: the interesting question is never "did
  // the bytes arrive" but "did the component ask again when the host said
  // something changed", and only a suite can stage that ordering.
  const eventSources = []

  class EventSourceStub {
    constructor(url) {
      this.url = String(url)
      this.listeners = new Map()
      this.closed = false
      this.readyState = 0
      eventSources.push(this)
    }
    addEventListener(type, handler) {
      if (this.closed === true) return
      const list = this.listeners.get(type) ?? []
      list.push(handler)
      this.listeners.set(type, list)
    }
    removeEventListener(type, handler) {
      const list = this.listeners.get(type)
      if (list === undefined) return
      const at = list.indexOf(handler)
      if (at >= 0) list.splice(at, 1)
    }
    close() {
      this.closed = true
      this.readyState = 2
    }
    // Stands in for the host writing one frame. Only a suite can decide when.
    emit(payload) {
      if (this.closed === true) return
      const list = this.listeners.get('message') ?? []
      for (const handler of list.slice()) handler({ data: JSON.stringify(payload) })
    }
    // Stands in for the browser reporting that the connection dropped. Nothing
    // may happen here: `EventSource` retries by itself, and a plugin that closed
    // the source on error would never learn about the next change.
    fail() {
      if (this.closed === true) return
      const list = this.listeners.get('error') ?? []
      for (const handler of list.slice()) handler({})
    }
    // Stands in for a failure the browser will not retry: a 404 from a host that
    // does not serve the route, or a response that is not
    // `text/event-stream`. `EventSource` reports `error` with `readyState`
    // CLOSED and never comes back -- which is the half the client has to act on.
    //
    // `closed` is left false so a suite can tell the two apart: the browser
    // giving up (`readyState === 2`, still open from the plugin's side) versus
    // the plugin having closed it. Without that distinction this stub could only
    // ever reach the CONNECTING branch, which is why the fatal branch shipped
    // with no test that could fail.
    failFatal() {
      if (this.closed === true) return
      this.readyState = 2
      const list = this.listeners.get('error') ?? []
      for (const handler of list.slice()) handler({})
    }

    // An `error` that was already on its way when the plugin closed this source.
    // `close()` does not cancel a queued event, and this is the only shape in
    // which a handler can run against a source that is no longer the current
    // one -- so it is the only shape that can catch a handler closing the wrong
    // stream. `failFatal` deliberately returns early on a closed source and
    // therefore cannot.
    failFatalQueued() {
      this.readyState = 2
      const list = this.listeners.get('error') ?? []
      for (const handler of list.slice()) handler({})
    }
  }

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
  // The host also publishes *which* conversation is on screen, on the same
  // element. That attribute is the column's authority for "what am I looking
  // at", so a fixture that cannot move it independently of the header button's
  // prop cannot describe the bug it guards: the whole failure is those two
  // disagreeing for one render. `null` means a page that publishes nothing,
  // which is what every suite that does not ask for it should keep seeing.
  let sessionValue = settings.conversationSession ?? null
  // The host does not edit the conversation element when the person switches
  // sessions: it unmounts the whole tree and mounts a fresh one inside the slot
  // that owns it. Measured on the live page — the old node reports
  // `isConnected === false` and no attribute record is delivered anywhere. A
  // fixture that only moved the attribute described a host that does not exist,
  // which is exactly how a fix that could never fire on the real page passed
  // its own suite.
  //
  // So the node itself is replaceable here, and `swapConversation` below models
  // the swap: new object, new identity, one childList record on the slot.
  const slot = { hasAttribute: (name) => name === 'data-slot', parentElement: null, children: [] }
  // How many nodes sit between the slot and the content. The live page has two
  // -- `[data-slot="main.conversation"] > .root > .body > [data-conversation-content]`,
  // measured on the running host -- and the difference is not cosmetic: a host
  // that replaces only the content writes a `childList` record on the content's
  // parent and *nothing* on the slot, so an observer parked on the slot alone
  // never hears about the switch.
  //
  // The fixture used to put the content directly under the slot, which is a
  // host that does not exist, and that is why a switch could go unnoticed on
  // the real page while every assertion here stayed green.
  let contentParent = slot
  const wrappers = []
  const wrapperCount = settings.conversationDepth ?? 2
  for (let level = 0; level < wrapperCount; level += 1) {
    const wrapper = { hasAttribute: () => false, parentElement: contentParent, children: [] }
    contentParent.children = [wrapper]
    contentParent = wrapper
    wrappers.push(wrapper)
  }
  let conversation =
    rect === null ? null : {
      getBoundingClientRect: () => ({ ...rect }),
      offsetWidth: rect.width,
      // The host publishes which of its three pages this is on the conversation
      // body. The fixture defaults to a real conversation, which is what most
      // suites are describing; a suite that cares about the launcher passes
      // `phase: 'hero'` or `phase: 'settling'`, and `phase: null` is a host that
      // does not publish the attribute at all.
      getAttribute: (name) => {
        if (name === 'data-content-phase') return phaseValue === null ? null : (phaseValue ?? 'active')
        if (name === 'data-conversation-session') return sessionValue
        return null
      },
      // The column climbs from here to `data-slot`. This node is not the slot,
      // and a stub that answered `true` would stop the climb at the conversation
      // and leave the fixture watching a node the host throws away.
      hasAttribute: () => false,
      setPhase: (next) => { phaseValue = next },
      setSession: (next) => { sessionValue = next },
      querySelector: (selector) => (selector === 'code, pre' ? code : null),
      // The parent is where the host writes the replacement: it unmounts this
      // node and mounts a new one in its place. The slot further up is kept, so
      // a replacement here is invisible from there.
      parentElement: contentParent,
    }
  if (conversation !== null) contentParent.children = [conversation]

  // One session switch, the way the page performs it: throw the node away and
  // put a different one in its place. Every observer parked on the slot hears
  // about it; nothing edits an attribute.
  const makeConversation = (session) =>
    conversation === null ? null : {
      ...conversation,
      getAttribute: (name) => {
        if (name === 'data-content-phase') return phaseValue === null ? null : (phaseValue ?? 'active')
        if (name === 'data-conversation-session') return session
        return null
      },
      parentElement: contentParent,
    }
  // The swap the live page performs: a new content node in the parent it lived
  // in, and one `childList` record **on that parent**. The slot above keeps its
  // child -- the wrapper is not replaced -- so a suite can tell an observer that
  // watches the right node from one that only watches an ancestor.
  const swapConversation = (session) => {
    sessionValue = session
    const next = makeConversation(session)
    const previous = conversation
    conversation = next
    contentParent.children = next === null ? [] : [next]
    for (const observer of mutationObservers) {
      const watching = observer.targets.some((row) => row.target === contentParent && row.options?.childList === true)
      if (watching) {
        observer.trigger([{ type: 'childList', target: contentParent, addedNodes: next === null ? [] : [next], removedNodes: previous === null ? [] : [previous] }])
      }
    }
    return next
  }

  // The scrolling area is the box the prose is centred in *and* the box the
  // monitor column's reservation is a margin on, so the fixture models the one
  // fact that matters about it: reserving width shrinks its client width. A stub
  // that reported a constant width would describe a world where the column costs
  // nothing, and the rail test could never fail there.
  //
  // Opt-in through `settings.scrollWidth`: suites that do not care about the rail
  // keep the previous behaviour (no scrolling area), so nothing that already
  // passed is re-measured against a new number.
  const scrollArea = settings.scrollWidth === undefined ? null : {
    getBoundingClientRect: () => {
      const reserved = Number.parseFloat(hostStyle.get('--dsse-monitor-reserve') ?? '0') || 0
      const width = Math.max(0, settings.scrollWidth - reserved)
      return { left: rect.left, top: rect.top, right: rect.left + width, bottom: rect.bottom, width, height: rect.height }
    },
    get clientWidth() {
      const reserved = Number.parseFloat(hostStyle.get('--dsse-monitor-reserve') ?? '0') || 0
      return Math.max(0, Math.round(settings.scrollWidth - reserved - (settings.scrollbar ?? 0)))
    },
  }

  // The host's turn rail is a <nav> inside the conversation scroll body. The
  // plugin finds it with querySelectorAll and pins an inline style on it, so the
  // fixture exposes an opt-in list of nav nodes for suites that care about the
  // rail. Nodes are plain objects with the two things forceTurnRail touches.
  const navNodes = settings.navNodes ?? []

  // The shell frame is what publishes whether the host's RIGHT column is open:
  // React writes `data-rightbar-collapsed` only while it is closed, so the
  // presence of the attribute *is* the closed state. The plugin reads it to get
  // out of the way, and the fixture models it as two plain objects so a suite
  // can flip the column without a DOM.
  //
  // It must be the right column and not the left one. `data-sidebar-collapsed`
  // describes the session list, which is open in the default layout -- binding
  // to it answered "open" on every ordinary screen and skipped this column on
  // every render, which is how the panel disappeared everywhere at once.
  //
  // `settings.sidebar === false` is a host that never renders the overlay at
  // all; that has to read as "the column is not open", because a panel that
  // closed itself over an unknown page would be hiding for a reason nobody can
  // see.
  const sidebarOpen = settings.sidebarOpen
  const shellFrame = {
    hasAttribute: (name) => (name === 'data-rightbar-collapsed' ? (sidebarOpen === true ? false : true) : false),
    getAttribute: (name) => (name === 'data-rightbar-collapsed' ? (sidebarOpen === true ? null : '') : null),
  }
  const shellOverlay = settings.sidebar === false ? null : { parentElement: shellFrame }

  const rootAttributes = new Map()
  const documentStub = {
    // The GUI can be served under a path prefix, and every request the plugin
    // makes has to resolve against the page rather than the origin. A fixture
    // without a prefix cannot tell those apart: with `baseURI` at the root,
    // `/api/x` and `api/x` resolve to the same string.
    baseURI: settings.baseURI ?? 'http://127.0.0.1:19387/',
    head: { appendChild: (node) => styles.push(node) },
    body: { attributes: new Map() },
    documentElement: {
      lang: settings.lang ?? '',
      attributes: rootAttributes,
      // `applyMonitorReserve` publishes two switches on <html>, and the CSS that
      // reads them is what makes the rail visible or not. A document element
      // without these methods makes that path dead code, which is exactly how the
      // double-subtracted reservation survived: nothing could observe the answer.
      setAttribute: (name, value) => { rootAttributes.set(name, String(value)) },
      getAttribute: (name) => rootAttributes.get(name) ?? null,
      style: {
        getPropertyValue: (name) => hostStyle.get(name) ?? '',
        setProperty: (name, value) => { hostWrites.push([name, String(value)]); hostStyle.set(name, String(value)) },
        removeProperty: (name) => hostStyle.delete(name),
      },
    },
    activeElement: null,
    // A backgrounded page is a real state the panel has to behave differently in,
    // and a stub without these made that path unreachable: the code guards on
    // `document.hidden`, so a document object lacking the field was
    // indistinguishable from a visible one and no assertion could be written.
    hidden: settings.hidden === true,
    visibilityListeners: [],
    addEventListener: (type, handler) => {
      if (type === 'visibilitychange') documentStub.visibilityListeners.push(handler)
    },
    removeEventListener: (type, handler) => {
      if (type !== 'visibilitychange') return
      documentStub.visibilityListeners = documentStub.visibilityListeners.filter((entry) => entry !== handler)
    },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    querySelector: (selector) => {
      if (selector === '[data-conversation-content]') return conversation
      if (selector === '[data-conversation-scroll]') return scrollArea
      if (selector === '[data-shell-overlay]') return shellOverlay
      // The column reads the live session off the page rather than off the
      // header button's prop, so the selector has to resolve to the same
      // element the host would use. A stub that answered `null` here would
      // silently make every suite fall back to the value under test.
      if (selector === '[data-conversation-session]') return conversation
      return null
    },
    querySelectorAll: (selector) => {
      if (selector === '[data-conversation-scroll] nav') return navNodes
      return []
    },
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
  // The rail observer coalesces to one pass per frame. A window without
  // `requestAnimationFrame` is a window the observer can never attach to, so the
  // suite would pass while the mechanism stayed dead: that is how a timing bug
  // survives six rounds of "fixed". The fixture drives frames by hand.
  const rafQueue = []
  let rafSeq = 0
  if (settings.requestAnimationFrame !== false) {
    windowStub.requestAnimationFrame = (callback) => {
      rafSeq += 1
      rafQueue.push({ id: rafSeq, callback })
      return rafSeq
    }
    windowStub.cancelAnimationFrame = (id) => {
      const at = rafQueue.findIndex((row) => row.id === id)
      if (at >= 0) rafQueue.splice(at, 1)
    }
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
    // Stands in for the browser delivering a mutation record. The rail observer
    // exists to react to a nav that mounts after the first measurement, and only
    // a suite can stage that ordering — nothing about a static DOM is late.
    trigger() {
      if (this.disconnected === true) return
      this.callback([], this)
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
    'EventSource',
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
    // `settings.EventSource` lets a suite boot in an environment that has no
    // `EventSource` at all. Without that switch the guard in `startStream` is
    // unobservable: every suite would hand the bundle a working stub and the
    // fallback would never be exercised, which is exactly how a guard that
    // throws on the way to the timer survives a whole mutation run.
    settings.EventSource === undefined ? EventSourceStub : settings.EventSource,
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
    eventSources,
    // The stream this session is watching, if the panel has opened one. Suites
    // that want to prove the panel reacts to a push rather than to a clock need
    // a handle on it, and "whichever one is open for this id" is the only stable
    // way to name it -- the panel closes and reopens as sessions change.
    streamFor(session) {
      return eventSources.find((row) => row.closed === false && row.url.includes(encodeURIComponent(session)) === true)
    },
    clock,
    document: documentStub,
    // The two switches the plugin publishes on <html>. The turn-rail one is the
    // whole answer to "is the host's rail allowed to draw", so a suite that
    // cannot read it can only test the pure function and never the wiring.
    rootAttributes,
    navNodes,
    conversation,
    // `conversation` is a snapshot of the node at boot; after a swap the page
    // holds a different object, so suites that need the current one read this.
    get liveConversation() { return conversation },
    swapConversation,
    // The nearest `data-slot` ancestor and the node the host actually replaces
    // inside. They are two different nodes on purpose -- see the comment where
    // they are built.
    slot,
    get contentParent() { return contentParent },
    scrollArea,
    rafQueue,
    // One frame's worth of work: the observer schedules into this queue, so a
    // suite that never flushes it observes nothing.
    flushRaf() {
      const pending = rafQueue.splice(0, rafQueue.length)
      for (const row of pending) row.callback(0)
    },
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
          { path: '/tmp/out/report.md', deliverable: true, bytes: 2048, mtimeMs: 20 },
          { path: '/tmp/out/older.md', deliverable: true, bytes: 1024, mtimeMs: 10 },
        ],
      },
    },
    // The monitor column is the only layout there is. Fixtures that want cards
    // rendered ask for it by leaving `monitorColumn` on; one block near the end
    // of this file turns it off to pin what a closed column looks like.
    '/api/ui-evolve/config': {
      ok: true,
      data: { panelSummary: true, monitorColumn: true },
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
// `utilities` is the right-aligned run in the session header; `actions` is the
// left half beside the tab strip. The switch has to be next to the window
// buttons, so this names the seat it must land in rather than just its presence.
check(
  'the toggle goes into the session header utilities',
  booted.injectedNames.includes('conversation.session.header.utilities'),
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
  const expected = spec.id.endsWith(':toggle') ? 'conversation.session.header.utilities' : 'shell.overlay'
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
  // The control is a glyph in the header's action row, so it is named by an
  // accessible label rather than by visible text: there is no room for a word in
  // a 24px square, and the row it joined is made of icon buttons.
  check(
    'the toggle names itself for people who cannot see the glyph',
    button?.props?.['aria-label'] === '收起任务监控',
    String(button?.props?.['aria-label']),
  )
  check(
    'the toggle explains itself on hover',
    button?.props?.title === '收起任务监控',
    String(button?.props?.title),
  )
  // The count badge went with the word. The column lists the queue itself, so a
  // number beside the icon repeated what the panel already showed.
  check('the toggle carries no count badge any more', firstByClass(tree, 'dsse-toggle-count') === undefined, textOf(tree).slice(0, 40))
  // On by default: the monitor column is the panel's default shape, so the header
  // glyph starts lit. A person who has never opened the settings should see the
  // cards without hunting for a button first.
  check('the toggle starts on, because the panel does', button?.props?.['data-active'] === 'true', String(button?.props?.['data-active']))
  check('the toggle reports its pressed state', button?.props?.['aria-pressed'] === 'true', String(button?.props?.['aria-pressed']))
  check(
    'the toggle reads the config on mount so the side setting is honoured',
    instance.calls.some((row) => row.url.endsWith('/api/ui-evolve/config')),
    JSON.stringify(instance.calls.map((row) => row.url)),
  )
}

{
  // Removing a config key from readConfig kept every assertion green once before
  // this kind of block existed, which means the setting could have shipped dead.
  // This drives the surviving one end to end: the route answers 260, and the
  // column is drawn at 260 rather than at the design default.
  const instance = boot({
    rect: { left: 280, top: 120, right: 1920, bottom: 900, width: 1640, height: 780 },
    proseWidth: '920px',
    routes: {
      ...panelRoutes(),
      '/api/ui-evolve/config': {
        ok: true,
        data: { panelSummary: true, monitorColumn: true, monitorWidth: 260 },
      },
    },
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  const handle = firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle')
  // Guarded. Unguarded, a missing control throws here and the rest of the file
  // never runs, so every later assertion is reported as absent rather than as
  // passing or failing -- which a runner reads as 'no failures'.
  check('the panel renders a control to open it with', handle !== undefined, String(handle === undefined))
  pressToggle(handle)
  const tree = await instance.renderer.deepRender(cards)
  const column = firstByClass(tree, 'dsse-monitor')
  const width = Number.parseFloat(String(column?.props?.style?.width ?? 'NaN'))
  check('a configured width from the config sizes the column', width === 260, String(column?.props?.style?.width))
  check('and the width it holds is what the conversation gives up', instance.hostStyle.get('--dsse-monitor-reserve') === '260px', JSON.stringify(instance.hostStyle.get('--dsse-monitor-reserve')))
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
  pressToggle(firstByClass(header, 'dsse-toggle'))

  // The overlay measures now, on the default (left) side.
  const first = await instance.renderer.deepRender(cards)
  // With the answer still in flight the panel keeps its own default, which is the
  // monitor column. This is the state a person sees on the first frame, so it is
  // the one worth pinning: a column, reserving width, naming itself.
  const firstColumn = firstByClass(first, 'dsse-monitor')
  check('the panel measures before the setting arrives', firstColumn !== undefined, textOf(first).slice(0, 60))
  const firstReserve = Number.parseFloat(String(instance.hostStyle.get('--dsse-monitor-reserve') ?? 'NaN'))
  check(
    'and claims width for the column it drew',
    Number.isFinite(firstReserve) && firstReserve > 0,
    JSON.stringify(instance.hostStyle.get('--dsse-monitor-reserve')),
  )

  // Now the setting arrives, which notifies the already-mounted overlay. A saved
  // "off" is the case that has to be honoured late: the panel drew itself and
  // took the width before it knew, so the arrival must both stop the drawing and
  // hand the width back.
  releaseConfig({ ok: true, data: { panelSummary: true, monitorColumn: false } })
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()

  const after = await instance.renderer.deepRender(cards)
  check('a switched-off column that arrives late is dropped', firstByClass(after, 'dsse-monitor') === undefined, textOf(after).slice(0, 60))
  check('and no cards are drawn in its place', firstByClass(after, 'dsse-rail') === undefined, textOf(after).slice(0, 60))
  check(
    'and the width the column held goes back to the conversation',
    instance.hostStyle.get('--dsse-monitor-reserve') === '0px',
    JSON.stringify(instance.hostStyle.get('--dsse-monitor-reserve')),
  )
}
{
  // A saved "off" must start the panel closed, not just become closed after the
  // first click. The switch is the only way the panel is visible, so a config
  // that says off and a panel that draws anyway is the bug worth pinning: the
  // person turned it off, and it came back on the next restart.
  const instance = boot({
    rect: { left: 280, top: 120, right: 1920, bottom: 900, width: 1640, height: 780 },
    proseWidth: '920px',
    routes: {
      ...panelRoutes(),
      '/api/ui-evolve/config': { ok: true, data: { panelSummary: true, monitorColumn: false } },
    },
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  // Let the saved config land before pressing anything: the claim is that a saved
  // off is in effect at mount, not that a click wins a race with a request.
  await settle()
  const closedTree = await instance.renderer.deepRender(cards)
  check(
    'a switched-off config starts the panel closed',
    firstByClass(closedTree, 'dsse-monitor') === undefined && firstByClass(closedTree, 'dsse-rail') === undefined,
    textOf(closedTree).slice(0, 60),
  )
  check(
    'and reserves no width while it is closed',
    instance.hostStyle.get('--dsse-monitor-reserve') === '0px',
    JSON.stringify(instance.hostStyle.get('--dsse-monitor-reserve')),
  )
  const closedToggle = firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle')
  check('and the switch reads as off', closedToggle?.props?.['data-active'] === 'false', String(closedToggle?.props?.['data-active']))
  // A real click, not pressToggle: the panel is closed, so this press is what
  // opens it, and the column has to appear and claim its width.
  closedToggle.props.onClick()
  const openTree = await instance.renderer.deepRender(cards)
  check('and a click opens the column the config closed', firstByClass(openTree, 'dsse-monitor') !== undefined, textOf(openTree).slice(0, 60))
  const openedReserve = Number.parseFloat(String(instance.hostStyle.get('--dsse-monitor-reserve') ?? 'NaN'))
  check('and it claims width on the way in', Number.isFinite(openedReserve) && openedReserve > 0, String(openedReserve))
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
    pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
    ['cancelled', { word: '取消', reasons: ['the summary call was cancelled'] }],
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
      pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const ago = firstByClass(tree, 'dsse-recap-when')
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  check('a failure is not given a time', firstByClass(tree, 'dsse-recap-when') === undefined, textOf(tree).slice(0, 160))
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
  pressToggle(firstByClass(toggleTree, 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(cards)

  // The previous turn is no longer a card. It lives in the column's header, so
  // the list below holds only what is still changing: skills, and files.
  check('two cards are rendered together', byClass(tree, 'dsse-card').length === 2, String(byClass(tree, 'dsse-card').length))
  check('skills and MCP share the first card', textOf(byClass(tree, 'dsse-card')[0]).includes('技能与 MCP') && textOf(byClass(tree, 'dsse-card')[0]).includes('github'), textOf(byClass(tree, 'dsse-card')[0]).slice(0, 160))
  check(
    'the last turn is in the header instead',
    firstByClass(tree, 'dsse-col-top') !== undefined && textOf(firstByClass(tree, 'dsse-col-top')).includes('Read three files and edited one'),
    textOf(firstByClass(tree, 'dsse-col-top')).slice(0, 80),
  )
  check(
    'and it is not a card any more',
    textOf(tree).includes('上一轮') === false,
    textOf(tree).slice(0, 80),
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
    // The row is a line inside the header card now. A second border and a second
  // shadow around it would read as two boxes stacked, which is the thing the
  // merge was for, so the surface belongs to the header alone.
  check('the top row no longer wears a surface of its own', /\.dsse-top-row\{[^}]*border:/.test(sheet) === false && /\.dsse-top-row\{[^}]*box-shadow:/.test(sheet) === false && /\.dsse-top-row\{[^}]*background:/.test(sheet) === false, (sheet.match(/\.dsse-top-row\{[^}]*\}/) ?? [''])[0].slice(0, 200))
  // The card inside the header wears it, not the sticky wrapper around it. The
  // wrapper has to stay full-bleed so its fill covers the cards sliding under
  // it; carrying the outline there made the header 20px wider than every card
  // below it, which is the broken edge the merge was meant to remove.
  check('and the card inside it wears it instead', /\.dsse-col-card\{[^}]*border:1px solid/.test(sheet) && /\.dsse-col-card\{[^}]*border-radius:11px/.test(sheet) && /\.dsse-col-card\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(sheet), (sheet.match(/\.dsse-col-card\{[^}]*\}/) ?? [''])[0].slice(0, 200))
  // Five lines of summary, and no strip reserved under them. The recap used to
  // cap at 6.6em — four lines at its own line-height — with 24px of empty card
  // beneath it for a badge that is invisible until hover, so four lines looked
  // like a mistake rather than a decision.
  const recapText = /[.]dsse-recap [.]dsse-text[{][^}]*max-height:([^;}]+)/.exec(sheet)
  check('the summary shows five lines, not four', recapText !== null && recapText[1].includes('5 * 1.55 * 1em'), recapText === null ? 'no rule' : recapText[1])
  check('and reserves nothing under the last of them', /[.]dsse-recap\[data-clickable="true"\] \{[^}]*padding-bottom/.test(sheet) === false, 'the recap still reserves a strip')

  // A folded file list says it is folded. The rows simply stopped after four,
  // and the only hint was a badge that is invisible until the pointer arrives —
  // useless to someone deciding whether to look.
  const foldedFiles = /[.]dsse-files\[data-open="false"\]::after\{[^}]*linear-gradient/.exec(sheet)
  check('a folded file list fades its last row', foldedFiles !== null, 'no fade under the folded list')
  // A max-height on its own clips nothing: the overflow stays visible, so every
  // row was still drawn and the badge that follows the list landed on top of the
  // last one. The cap has to come with overflow hidden to be a fold at all.
  const foldedClip = /[.]dsse-files\[data-open="false"\]\{[^}]*overflow:hidden/.exec(sheet)
  check('and a folded list actually stops drawing rows', foldedClip !== null, 'max-height without overflow hidden')
  check('and the header is no wider than the cards under it', /\.dsse-col-top\{[^}]*margin:0 0 8px/.test(sheet), (sheet.match(/\.dsse-col-top\{[^}]*\}/) ?? [''])[0].slice(0, 200))
  }
    // The counts are gone with the card that carried them. What the header says
    // now is how fresh the telling is, and nothing about the size of the turn:
    // "12 calls, 0 commands, 1 file" answered a question about cost, and the
    // column is a monitor, not an invoice.
    check('the header carries no call count', firstByClass(firstByClass(tree, 'dsse-col-top'), 'dsse-head-stat') === undefined, textOf(tree).slice(0, 120))
    check('the header carries no command count', textOf(tree).includes('命令') === false, textOf(tree).slice(0, 120))
    check('the header carries no file count', /\d\s*文件/.test(textOf(tree)) === false, textOf(tree).slice(0, 120))
    check('the old stat strip is gone', firstByClass(tree, 'dsse-facts') === undefined, textOf(tree).slice(0, 160))
    check('the header carries no action button', firstHead !== undefined && firstByClass(firstHead, 'dsse-propose') === undefined && firstByClass(firstHead, 'dsse-head-btn') === undefined, textOf(tree).slice(0, 160))
    // Cards without a `head` still get their metadata from `meta`. Both paths have
    // to be pinned: removing the fallback would silently empty two headers. The
    // skills card is the one that still takes the `meta` route; the output card
    // now builds its own head, so it is not in this list any more.
    const metas = byClass(tree, 'dsse-card-meta').map((node) => textOf(node))
    check('a card without a custom head still shows its meta', metas.includes('2 技能 · 1 服务'), JSON.stringify(metas))
    check('and the output card no longer takes that route', metas.some((row) => row.includes('个文件')) === false, JSON.stringify(metas))
    // Its own head is two numbers: what a person wrote, then the remainder.
    const heads = byClass(tree, 'dsse-head-stats').map((node) => textOf(node))
    check('a card with a custom head builds it', heads.some((row) => row.includes('2 个文件')), JSON.stringify(heads))
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
  // The clock is now the fallback, not the mechanism. Two claims have to hold
  // together, and asserting only one of them is how a suite ends up blessing a
  // panel that has quietly stopped listening: the stream is open, and the timer
  // that backs it up is a minute rather than a few seconds.
  //
  // The delay is still part of the contract. It used to be eight seconds and was
  // the only way the panel learned anything; it is now what covers the three
  // things no session event can announce, and a constant nobody asserts is a
  // constant anybody can shorten to 100ms.
  const stream = instance.streamFor('session-a')
  check(
    'the panel opens a stream for the session on screen',
    stream !== undefined && stream.url.includes('/api/ui-evolve/events?agent=session-a'),
    JSON.stringify(instance.eventSources.map((row) => row.url)),
  )
  const polls = instance.timers.filter((row) => row.ms === 60000 && row.cleared === false)
  check(
    'the fallback timer is a minute',
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
  // The whole point: a frame on the stream is an answer without waiting for any
  // clock. This is the assertion the feature exists for.
  if (stream !== undefined) {
    const before = instance.calls.length
    stream.emit({ agent: 'session-a', revision: 2 })
    await settle()
    check(
      'a frame on the stream asks straight away',
      instance.calls.length > before,
      `${before} -> ${instance.calls.length}`,
    )
    // A frame that arrives while an answer is still out cannot be dropped: a
    // clock tick asks the same question again in a minute, but a frame is the
    // only announcement that change is ever going to get, so losing it means
    // staying on the previous state until something unrelated happens. The
    // assertion above passes either way -- nothing is in flight when it runs --
    // which is exactly how this one survived a mutation run with `mustAsk`
    // deleted.
    const held = deferred()
    let holding = true
    const routesHeld = panelRoutes()
    routesHeld['/api/ui-evolve/panel'] = () => (holding === true ? held.promise : { ok: true, data: {
      turn: 4, calls: 1, failed: 0, summary: { text: 'AFTER THE FRAME' }, pendingCandidates: 0,
      skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
    } })
    const busy = await openPanel(routesHeld)
    const busyStream = busy.instance.streamFor('session-a')
    if (busyStream !== undefined) {
      // The first load is still out, so the frame has nowhere to go but the
      // wanted flag.
      const askedWhileBusy = busy.instance.calls.filter((row) => row.url.includes('/panel?')).length
      busyStream.emit({ agent: 'session-a', revision: 3 })
      await settle()
      check(
        'a frame that arrives while a request is out waits its turn',
        busy.instance.calls.filter((row) => row.url.includes('/panel?')).length === askedWhileBusy,
        `${askedWhileBusy} -> ${busy.instance.calls.filter((row) => row.url.includes('/panel?')).length}`,
      )
      holding = false
      held.resolve({ ok: true, data: {
        turn: 3, calls: 0, failed: 0, summary: { text: 'BEFORE THE FRAME' }, pendingCandidates: 0,
        skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
      } })
      await settle()
      const redrawn = await busy.instance.renderer.deepRender(busy.instance.seat('cards'))
      check(
        'and it is asked the moment that request lands',
        textOf(redrawn).includes('AFTER THE FRAME'),
        textOf(redrawn).slice(0, 140),
      )
    }
    // A dropped connection must not close the source: `EventSource` retries on
    // its own, and a plugin that shut it down on `error` would never hear about
    // the next change while still passing every other test in this file.
    stream.fail()
    check(
      'and a dropped connection is left to retry itself',
      stream.closed === false,
      stream.closed === true ? 'the source was closed on error' : 'still open',
    )
    // The other half of `error`, and the one that shipped untested: a fatal
    // failure leaves `readyState` CLOSED and the browser never retries, so the
    // plugin has to give the slot back or the fast path is dead for the rest of
    // the session. Deleting `stopStream()` from the error handler used to leave
    // every suite green.
    stream.failFatal()
    check(
      'and a fatal failure is closed rather than waited on',
      stream.closed === true,
      stream.closed === true ? 'closed' : 'left open for a retry that will not come',
    )
    // ...and the minute clock is what picks it up again. A stream given up on
    // that nothing retries is the same outcome as no stream at all.
    const sourcesBeforeRetry = instance.eventSources.length
    const fallback = instance.timers.filter((row) => row.ms === 60000 && row.cleared === false)
    if (fallback.length > 0) fallback[fallback.length - 1].fn()
    await settle()
    check(
      'and the minute clock opens a new one',
      instance.eventSources.length === sourcesBeforeRetry + 1 && instance.streamFor('session-a') !== undefined,
      `${sourcesBeforeRetry} -> ${instance.eventSources.length}`,
    )
  }
  // A stream that outlives its component keeps a switched-away session's panel
  // polling forever, and each one holds a response open for the life of the
  // window.
  instance.renderer.unmount()
  check(
    'unmounting stops the stream',
    stream === undefined || stream.closed === true,
    stream === undefined ? 'no stream' : `closed=${stream.closed}`,
  )
  check(
    'and unmounting stops the timer',
    instance.timers.every((row) => row.ms !== 60000 || row.cleared === true),
    JSON.stringify(instance.timers.filter((row) => row.ms === 60000).map((row) => row.cleared)),
  )
}

{
  // Unmounting while a request is out and a frame has already arrived: the frame
  // set the wanted flag, the request is still going to land, and its `finally`
  // reads that flag. Clearing it on unmount is the only thing that stops a
  // second read for a column that is no longer on screen -- and deleting that
  // line survived a mutation run, because every other unmount test resolves its
  // requests before unmounting, so the flag is never set at that moment.
  const held = deferred()
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = () => held.promise
  const { instance } = await openPanel(routes)
  const stream = instance.streamFor('session-a')
  const before = instance.calls.filter((row) => row.url.includes('/panel?')).length
  if (stream !== undefined) stream.emit({ agent: 'session-a', revision: 4 })
  await settle()
  check(
    'a frame that lands while a request is out does not ask yet',
    instance.calls.filter((row) => row.url.includes('/panel?')).length === before,
    `${before} -> ${instance.calls.filter((row) => row.url.includes('/panel?')).length}`,
  )
  instance.renderer.unmount()
  held.resolve({ ok: true, data: {
    turn: 1, calls: 0, failed: 0, summary: { text: 'UNMOUNTED' }, pendingCandidates: 0,
    skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
  } })
  await settle()
  check(
    'and a frame that outlives the panel does not ask again',
    instance.calls.filter((row) => row.url.includes('/panel?')).length === before,
    `${before} -> ${instance.calls.filter((row) => row.url.includes('/panel?')).length}`,
  )
}

{
  // Served under a path prefix, a root-relative stream URL misses the route
  // entirely. That failure is invisible: a 404 makes `EventSource` give up for
  // good, so the column keeps working off the minute clock while looking
  // completely healthy. Every other request in this bundle goes through
  // `resolveUrl`; the fixture at the origin cannot see the difference, which is
  // why skipping the resolver survived a mutation run.
  const { instance } = await openPanel({ ...panelRoutes() }, { baseURI: 'http://127.0.0.1:19387/gui/' })
  const opened = instance.streamFor('session-a')
  check(
    'the stream is resolved against the page, not the origin',
    opened !== undefined && opened.url.startsWith('http://127.0.0.1:19387/gui/api/ui-evolve/events') === true,
    opened === undefined ? 'no stream' : opened.url,
  )
}

// A stream is a server-side resource: one open response per watching tab. The
// three ways it can be left open by accident are all invisible from the page --
// a hidden tab looks the same, a missing `EventSource` looks the same, and an
// empty session id looks the same. Each is asserted here because each one
// survived a mutation run with the guard deleted.
{
  // Going away must close it. A hidden tab that keeps its stream open costs a
  // response writer on the host for as long as the tab is buried, and a reader
  // who leaves twenty tabs open pays for twenty.
  const { instance } = await openPanel({ ...panelRoutes() })
  const opened = instance.streamFor('session-a')
  check('a page that is being watched holds a stream', opened !== undefined, JSON.stringify(instance.eventSources.map((row) => row.url)))
  instance.document.hidden = true
  for (const listener of instance.document.visibilityListeners) listener()
  await settle()
  check(
    'a page that goes away closes its stream',
    opened === undefined || opened.closed === true,
    opened === undefined ? 'no stream to check' : `closed=${opened.closed}`,
  )
  // Coming back has to reopen it, or the fast path stays dead for the rest of
  // the session and the minute clock is all that is left -- which is exactly the
  // state this change exists to get out of. Only the closing half was asserted
  // before, and the reopening half survived a mutation run with `startStream`
  // deleted from `onVisible`.
  instance.document.hidden = false
  for (const listener of instance.document.visibilityListeners) listener()
  await settle()
  const reopened = instance.streamFor('session-a')
  check(
    'and coming back opens a new one',
    reopened !== undefined && reopened !== opened,
    reopened === undefined ? 'no stream after coming back' : `same source: ${reopened === opened}`,
  )
  check(
    'and there is exactly one of them',
    instance.eventSources.filter((row) => row.closed === false && row.url.includes('agent=session-a') === true).length === 1,
    JSON.stringify(instance.eventSources.map((row) => [row.url, row.closed])),
  )
  // A `visibilitychange` that does not mean the tab went away (a window merely
  // uncovered) must not tear down a healthy stream: the frame it was about to
  // deliver would be lost, and reconnecting costs a round trip. Asserted by
  // identity, because "still one open stream" is also true of a stream that was
  // closed and immediately replaced.
  for (const listener of instance.document.visibilityListeners) listener()
  await settle()
  check(
    'and a second visible notice keeps the stream it already has',
    instance.streamFor('session-a') === reopened,
    reopened === undefined ? 'nothing to compare' : `replaced: ${instance.streamFor('session-a') !== reopened}`,
  )
}

{
  // Mounting into a hidden page must not open a stream either. The guard is a
  // one-line early return, and deleting it survived a mutation run: every other
  // case mounts into a visible page, so nothing ever asked this question.
  const { instance } = await openPanel({ ...panelRoutes() }, { hidden: true })
  check(
    'a hidden page opens no stream at all',
    instance.eventSources.length === 0,
    JSON.stringify(instance.eventSources.map((row) => row.url)),
  )
  check(
    'and the fallback clock is still running for it',
    instance.timers.some((row) => row.ms === 60000 && row.cleared === false),
    JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])),
  )
}

{
  // No `EventSource` in this environment: a headless renderer, an older browser.
  // The column still has to work off the slow clock, and nothing may throw on
  // the way there -- a `ReferenceError` inside the effect would take the whole
  // panel down rather than degrade it.
  const { instance } = await openPanel({ ...panelRoutes() }, { EventSource: null })
  check('an environment without a stream opens none', instance.eventSources.length === 0, String(instance.eventSources.length))
  const polls = instance.timers.filter((row) => row.ms === 60000 && row.cleared === false)
  check(
    'and the slow clock still backs it',
    polls.length === 1,
    JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])),
  )
  if (polls.length === 1) {
    const before = instance.calls.filter((row) => row.url.includes('/panel?')).length
    polls[0].fn()
    await settle()
    const after = instance.calls.filter((row) => row.url.includes('/panel?')).length
    check('and firing it still asks', after > before, `${before} -> ${after}`)
  }
}

{
  // No session on screen: there is nothing to watch, and asking the host to
  // watch nothing would either open a stream for a guessed id or open one per
  // keystroke of a session that is being created.
  const instance = boot({ routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  // `sessionId: ''` is the host's "no conversation yet" state, and the toggle
  // already skips publishing an empty id, so this is the same door the real
  // application goes through on a cold start.
  await instance.renderer.render(toggle, { sessionId: '' })
  await instance.renderer.deepRender(cards)
  check(
    'a cold start opens no stream',
    instance.eventSources.length === 0,
    JSON.stringify(instance.eventSources.map((row) => row.url)),
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
      files: [{ path: '/tmp/out/report.md', deliverable: true, bytes: 2048, mtimeMs: 20 }],
      commands: ['a'],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const activityCard = byClass(tree, 'dsse-card')[0]
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
// ---------------------------------------------------------------------------
// Geometry: the column is placed from the measurement, never from the window
// ---------------------------------------------------------------------------

{
  // A 1920 frame with a 280px left sidebar. The prose is 920px centred in the
  // 1640px column, and the monitor column hangs off the column's right edge.
  // Only one number has to be derived: the column's left edge is the measured
  // right edge minus its width. An earlier version measured from the window and
  // put the cards at x=16, which on a real screen is on top of the host sidebar —
  // that 280px difference is what this block pins down.
  const rect = { left: 280, top: 120, right: 1920, bottom: 900, width: 1640, height: 780 }
  const instance = boot({ rect, proseWidth: '920px', routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(cards)
  const column = firstByClass(tree, 'dsse-monitor')
  const expected = placeMonitor({ columnRect: rect, width: 300, proseWidth: 920 })
  check('the column exists', column !== undefined, String(tree?.type))
  check('the column starts at the measured left edge', column?.props?.style?.left === `${expected.left}px`, `${column?.props?.style?.left} vs ${expected.left}`)
  check('the column is as wide as the geometry says', column?.props?.style?.width === `${expected.width}px`, String(column?.props?.style?.width))
  check('the column starts below the conversation top', column?.props?.style?.top === `${expected.top}px`, String(column?.props?.style?.top))
  check('the column reaches the conversation bottom', Number.parseFloat(String(column?.props?.style?.height ?? 'NaN')) === rect.height, String(column?.props?.style?.height))
  // The behavioural assertion, independent of the arithmetic above: the column
  // hangs off the conversation column's own right edge, which is not the
  // window's right edge whenever the host draws a sidebar.
  const colLeft = Number.parseFloat(String(column?.props?.style?.left ?? 'NaN'))
  const colWidth = Number.parseFloat(String(column?.props?.style?.width ?? 'NaN'))
  check(
    'the column is flush with the conversation column, not the window',
    Number.isFinite(colLeft) && Number.isFinite(colWidth) && colLeft + colWidth === rect.right,
    `${colLeft}+${colWidth} vs column ends ${rect.right}`
  )
  check('the column reserves exactly its own width', instance.hostStyle.get('--dsse-monitor-reserve') === `${expected.width}px`, String(instance.hostStyle.get('--dsse-monitor-reserve')))
}

{
  // A body barely wider than the prose leaves no room for a column, and the
  // column is drawn anyway. Degrading to the old floating cards is not an
  // option: it is the layout the column replaced, and it made the panel vanish
  // with no way back once the width had been saved. The prose reflows instead.
  const rect = { left: 0, top: 120, right: 700, bottom: 900, width: 700, height: 780 }
  const instance = boot({ rect, proseWidth: '680px', routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(cards)
  const column = firstByClass(tree, 'dsse-monitor')
  const gutter = rect.width - 680
  check('a body with no gutter still draws the column', column !== undefined, textOf(tree).slice(0, 80))
  check('and the column keeps its own minimum rather than a sliver', column?.props?.style?.width === `${MONITOR_MIN_WIDTH}px`, `${column?.props?.style?.width} with a ${gutter}px gutter`)
  // The rail element survives as the card list, but it is a plain flow block
  // inside the column now: no `data-side`, no absolute coordinates, and the
  // collapse handle that used to stand in for a hidden panel is gone too.
  const rail = firstByClass(tree, 'dsse-rail')
  check('and the rail is a flow block inside the column', rail?.props?.['data-embedded'] === 'true' && rail?.props?.style === undefined, String(rail?.props?.style))
  check('and the collapse handle the old layout needed is gone', firstByClass(tree, 'dsse-handle') === undefined, textOf(tree).slice(0, 80))
}

{
  // No measurable prose width published by the host: the fallback clamp must be
  // used rather than a zero-width column.
  const rect = { left: 0, top: 120, right: 1920, bottom: 900, width: 1920, height: 780 }
  const instance = boot({ rect, proseWidth: 'not-a-number', routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(cards)
  check('an unreadable width falls back to the documented clamp', firstByClass(tree, 'dsse-monitor') !== undefined, textOf(tree).slice(0, 80))
}

// The turn rail is not measured. Its room is spent out of the column's width
// budget by `placeMonitor`, so a drawn column is a column that already left the
// rail its 40px, and the attribute that reveals it is the reservation's own
// value rather than a second opinion. The case below is the one that was broken
// for three rounds: a default column on a 1440px window, where a measured
// verdict said "no room" at every window size the panel was ever used at.
// ---------------------------------------------------------------------------

{
  const rect = { left: 280, top: 120, right: 1440, bottom: 900, width: 1160, height: 780 }
  const instance = boot({ rect, proseWidth: '742px', scrollWidth: rect.width, routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  // The toggle is the seat that carries the session id, and the overlay draws
  // nothing until it has one; rendering the panel alone measures an empty page.
  await instance.renderer.render(toggle, { sessionId: 'session-a' })
  await instance.renderer.deepRender(cards)
  check(
    'the rail is shown while the column is',
    instance.rootAttributes.get('data-dsse-turn-rail') === '1',
    `${instance.rootAttributes.get('data-dsse-turn-rail')} with a ${rect.width}px column and 742px prose`,
  )

  // The reservation is on the area now, so `clientWidth` has it taken out. An
  // earlier version subtracted the reservation from that width a second time and
  // concluded there was no room; this pass is the one that caught it.
  const resize = instance.listeners.filter((row) => row.type === 'resize').map((row) => row.handler)
  for (const handler of resize) handler()
  await instance.renderer.deepRender(cards)
  check(
    'and still is once the reservation is on the area',
    instance.rootAttributes.get('data-dsse-turn-rail') === '1',
    `${instance.rootAttributes.get('data-dsse-turn-rail')} after re-measuring with ${instance.hostStyle.get('--dsse-monitor-reserve')} reserved`,
  )
}

{
  // The deliberate half of the same decision: a window whose gutter is too tight
  // for the rail still gets the rail, because the column's budget already paid
  // for it and hiding it on a second opinion is what made it invisible. The rail
  // overlapping the last few pixels of gutter is the cheaper wrong here — the
  // alternative was no rail at all on most windows.
  const rect = { left: 0, top: 120, right: 1000, bottom: 900, width: 1000, height: 780 }
  const instance = boot({ rect, proseWidth: '960px', scrollWidth: rect.width, routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  await instance.renderer.render(toggle, { sessionId: 'session-a' })
  await instance.renderer.deepRender(cards)
  const resize = instance.listeners.filter((row) => row.type === 'resize').map((row) => row.handler)
  for (const handler of resize) handler()
  await instance.renderer.deepRender(cards)
  check(
    'a window with no gutter left still keeps the rail',
    instance.rootAttributes.get('data-dsse-turn-rail') === '1',
    `${instance.rootAttributes.get('data-dsse-turn-rail')} with ${instance.hostStyle.get('--dsse-monitor-reserve')} reserved`,
  )
}

{
  // The other side of the switch: with the column off we have taken no width, so
  // the host's own 900px query is the correct answer and we stay out of its way.
  // Without this the attribute could be hard-coded on and every case above would
  // still pass.
  const rect = { left: 280, top: 120, right: 1440, bottom: 900, width: 1160, height: 780 }
  const instance = boot({
    rect,
    proseWidth: '742px',
    scrollWidth: rect.width,
    routes: { ...panelRoutes(), '/api/ui-evolve/config': { ok: true, data: { panelSummary: true, monitorColumn: false } } },
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  await instance.renderer.render(toggle, { sessionId: 'session-a' })
  await instance.renderer.deepRender(cards)
  const resize = instance.listeners.filter((row) => row.type === 'resize').map((row) => row.handler)
  for (const handler of resize) handler()
  await instance.renderer.deepRender(cards)
  check(
    'a closed column leaves the rail to the host',
    instance.rootAttributes.get('data-dsse-turn-rail') === '0',
    `${instance.rootAttributes.get('data-dsse-turn-rail')} with the column off`,
  )
}

// The host's own sidebar and this column want the same room. When the sidebar
// opens, the column steps aside rather than squeezing the prose below the
// reading floor — and it steps aside by closing, not by shrinking, because a
// half-width panel would have to be re-learnt every time the sidebar opened.
//
// The signal is the frame's `data-rightbar-collapsed`, which React writes only
// while the right column is closed: the attribute's presence is the closed state.
// Reading the left column's flag instead (`data-sidebar-collapsed`) is the defect
// this block replaced: that column is open by default, so it never said "closed"
// and this panel never drew.
// ---------------------------------------------------------------------------
{
  const rect = { left: 280, top: 120, right: 1920, bottom: 900, width: 1640, height: 780 }
  const instance = boot({ rect, proseWidth: '920px', routes: panelRoutes(), sidebarOpen: true })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(cards)
  check('an open sidebar costs the column its place', firstByClass(tree, 'dsse-monitor') === undefined, textOf(tree).slice(0, 60))
  check('and the width goes back to the conversation', instance.hostStyle.get('--dsse-monitor-reserve') === '0px', String(instance.hostStyle.get('--dsse-monitor-reserve')))
  check('and the rail is left to the host again', instance.rootAttributes.get('data-dsse-turn-rail') === '0', String(instance.rootAttributes.get('data-dsse-turn-rail')))
}
{
  // The other side: with the sidebar closed the column is drawn as usual, so the
  // assertion above cannot pass by drawing nothing ever.
  const rect = { left: 280, top: 120, right: 1920, bottom: 900, width: 1640, height: 780 }
  const instance = boot({ rect, proseWidth: '920px', routes: panelRoutes(), sidebarOpen: false })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(cards)
  check('a closed sidebar leaves the column its place', firstByClass(tree, 'dsse-monitor') !== undefined, textOf(tree).slice(0, 60))
  check('and it charges the conversation for it', Number.parseFloat(String(instance.hostStyle.get('--dsse-monitor-reserve') ?? '0')) > 0, String(instance.hostStyle.get('--dsse-monitor-reserve')))
}
{
  // A host that renders no shell overlay at all is not evidence that its
  // sidebar is open. Reading "unknown" as "open" would hide the column on every
  // host whose shell we do not recognise, with nothing on screen to explain it.
  const rect = { left: 280, top: 120, right: 1920, bottom: 900, width: 1640, height: 780 }
  const instance = boot({ rect, proseWidth: '920px', routes: panelRoutes(), sidebar: false })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(cards)
  check('a shell we cannot read is not a sidebar we can see', firstByClass(tree, 'dsse-monitor') !== undefined, textOf(tree).slice(0, 60))
}

// The structural CSS fallback covers a nav that appears late, but the inline
// force is the belt-and-braces half: it finds the nav by structure, not by a
// hashed class or a translated label, and pins a display that no host container
// query can undo. It must leave the header breadcrumb nav alone and release
// everything it pinned when the column closes.
// ---------------------------------------------------------------------------

{
  const railNode = navStub('轮次导航')
  const breadcrumbNode = navStub('session.hierarchy')
  const rect = { left: 280, top: 120, right: 1440, bottom: 900, width: 1160, height: 780 }
  const instance = boot({
    rect,
    proseWidth: '742px',
    scrollWidth: rect.width,
    navNodes: [railNode, breadcrumbNode],
    routes: panelRoutes(),
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  await instance.renderer.render(toggle, { sessionId: 'session-a' })
  await instance.renderer.deepRender(cards)

  check(
    'the rail nav is forced to display with the column open',
    railNode.style.display === 'block',
    JSON.stringify(railNode.style),
  )
  check(
    'and lifted above the overlay so the column cannot cover it',
    railNode.style.zIndex === '21',
    JSON.stringify(railNode.style),
  )
  // The desktop app proved a third property is needed. There the rail measured
  // 28x192 with 19 marks and correct ::before colours, yet elementFromPoint fell
  // through to the scroll body: an ancestor had it at visibility:hidden, and
  // visibility inherits, so display:block alone still painted nothing. The rail
  // declares its own visibility to win that inheritance back.
  check(
    'and made visible over an ancestor that hides the whole subtree',
    railNode.style.visibility === 'visible',
    'visibility was not forced',
  )
  check(
    'and takes the pointer events the slot leaves to nobody',
    railNode.style.pointerEvents === 'auto',
    JSON.stringify(railNode.style),
  )
  check(
    'the header breadcrumb nav is left alone',
    breadcrumbNode.style.display === '' && breadcrumbNode.style.zIndex === '' && breadcrumbNode.style.visibility === '',
    JSON.stringify(breadcrumbNode.style),
  )

  // Closing the column must give the nav back to the host, or a session that
  // once opened the rail keeps a stray inline display after it closes.
  // A raw click: pressToggle intentionally refuses to click an active toggle.
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  await instance.renderer.deepRender(cards)
  check(
    'closing the column releases the forced rail',
    !railNode.style.display && !railNode.style.zIndex && !railNode.style.visibility && !railNode.style.pointerEvents,
    JSON.stringify(railNode.style),
  )
}

// The host mounts its rail only once a conversation holds enough turns, which is
// later than this overlay's first measurement. Nothing the plugin already
// observes changes size at that moment, so a rail that arrives late used to wait
// for an unrelated resize before its inline display was ever written — the
// reported symptom was exactly that the rail came back only once the column was
// dragged. The fix watches the scroll body's children, and this block pins it.
// ---------------------------------------------------------------------------

{
  const railNode = navStub('轮次导航')
  // Mutable on purpose: the point is a nav that did not exist at mount time.
  const navs = []
  const rect = { left: 280, top: 120, right: 1440, bottom: 900, width: 1160, height: 780 }
  const instance = boot({
    rect,
    proseWidth: '742px',
    scrollWidth: rect.width,
    navNodes: navs,
    routes: panelRoutes(),
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  await instance.renderer.render(toggle, { sessionId: 'session-a' })
  await instance.renderer.deepRender(cards)

  // It has to watch children, not attributes: a nav that arrives is a new node,
  // and the scroll body's own attributes are exactly what do not change when
  // the host decides to draw the rail.
  const railWatch = instance.mutationObservers
    .flatMap((row) => row.targets)
    .find((t) => t.target === instance.scrollArea)
  check(
    'the rail observer watches the scroll body rather than the frame',
    railWatch !== undefined,
    `${instance.mutationObservers.length} observers`,
  )
  check(
    'and it watches the children that appear, not the body own attributes',
    railWatch?.options?.childList === true && railWatch?.options?.subtree === true,
    JSON.stringify(railWatch?.options),
  )

  // The nav arrives after the measurement that would have styled it.
  navs.push(railNode)
  const railObserver = instance.mutationObservers.find((row) => row.targets.some((t) => t.target === instance.scrollArea))
  railObserver.trigger()
  check(
    'a late rail waits for a frame before being touched',
    railNode.style.display === '' && instance.rafQueue.length > 0,
    JSON.stringify(railNode.style),
  )
  instance.flushRaf()
  check(
    'a rail that arrives late is forced without waiting for a resize',
    railNode.style.display === 'block' && railNode.style.zIndex === '21',
    JSON.stringify(railNode.style),
  )

  // One pass per frame: a streaming conversation delivers mutations far faster
  // than frames, and each pass reads layout.
  railObserver.trigger()
  railObserver.trigger()
  railObserver.trigger()
  check(
    'repeated mutations collapse into one scheduled pass',
    instance.rafQueue.length === 1,
    `${instance.rafQueue.length} frames queued`,
  )
  instance.flushRaf()

  // A closed column must not resurrect the rail.
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  await instance.renderer.deepRender(cards)
  railNode.style.display = ''
  railNode.style.zIndex = ''
  railObserver.trigger()
  instance.flushRaf()
  check(
    'a closed column does not force a late rail back on',
    railNode.style.display === '' && railNode.style.zIndex === '',
    JSON.stringify(railNode.style),
  )

  // An observer left attached to a body that the next session reuses would keep
  // forcing a display onto a rail the plugin no longer owns.
  instance.renderer.unmount()
  check(
    'teardown stops watching the scroll body',
    railObserver.disconnected === true,
    'still observing',
  )
}


// Failures are surfaced, not swallowed
// ---------------------------------------------------------------------------

{
  const instance = boot({ routes: { ...panelRoutes(), '/api/ui-evolve/panel': new Error('the panel endpoint answered 500') } })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(instance.renderer.hooks && (await instance.renderer.render(toggle, { sessionId: 'session-a' })), 'dsse-toggle'))
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
    { path: '/tmp/out/report.md', deliverable: true, bytes: 2048, mtimeMs: 20, address: 'dsh-resource://file/session/session-a/tmp/out/report.md' },
    { path: '/tmp/out/older.md', deliverable: true, bytes: 1024, mtimeMs: 10, address: 'dsh-resource://file/session/session-a/tmp/out/older.md' },
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
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
  const afterTeardown = await instance.renderer.deepRender(cards)
  const rowAfter = firstByClass(afterTeardown, 'dsse-row-open')
  rowAfter?.props?.onClick?.()
  check('a torn-down panel cannot open a preview', sidebarOpened.length === 2, JSON.stringify(sidebarOpened))
  for (const row of disposers) row.dispose()
  const phaseObservers = instance.mutationObservers.filter((observer) =>
    observer.targets.some((entry) => (entry.options?.attributeFilter ?? []).includes('data-content-phase')))
  // Three observers are alive by teardown: the phase observer, the slot observer
  // that catches a conversation being replaced, and typography. The first is
  // named by its attribute filter; the second by `childList` without `subtree`
  // (that pair is the swap signal and nothing else); what remains is typography.
  const slotObservers = instance.mutationObservers.filter((observer) =>
    observer.targets.some((entry) => entry.options?.childList === true && entry.options?.subtree !== true))
  const typographyObservers = instance.mutationObservers.filter(
    (observer) => phaseObservers.includes(observer) === false && slotObservers.includes(observer) === false)
  check('teardown disconnects typography observers', typographyObservers.length > 0 && typographyObservers.every((observer) => observer.disconnected), JSON.stringify(typographyObservers.map((observer) => observer.disconnected)))
  // The phase observer belongs to the overlay's own React effect, so it outlives
  // the service teardown above by design and is released when the overlay
  // unmounts. Two observers with two lifespans cannot share one assertion:
  // asking `every` here reported "the typography observer leaked" about a
  // component that was still mounted, which is the wrong sentence for the
  // failure — and it also meant nothing tested the unmount path.
  instance.renderer.unmount()
  check('unmounting disconnects every observer the overlay opened', instance.mutationObservers.every((observer) => observer.disconnected), JSON.stringify(instance.mutationObservers.map((observer) => observer.disconnected)))
  // Every variable this plugin wrote to the host document is gone. The reservation
  // is checked too: it narrows the conversation, so a leak here is a layout change
  // nobody can undo once the plugin has unloaded.
  const leftBehind = [...instance.hostStyle.entries()].filter(([, value]) => String(value) !== '0px')
  check(
    'teardown removes every variable it wrote to the host',
    leftBehind.length === 0,
    JSON.stringify(leftBehind),
  )
  check(
    'teardown gives the conversation its width back',
    instance.hostStyle.get('--dsse-monitor-reserve') === '0px' ||
      instance.hostStyle.has('--dsse-monitor-reserve') === false,
    JSON.stringify(instance.hostStyle.get('--dsse-monitor-reserve')),
  )
}

// ---------------------------------------------------------------------------
// Every host slot this bundle names must be one the host publishes
// ---------------------------------------------------------------------------

{
  // The list is transcribed from the host's own registrations; a typo in a slot
  // name is not a crash, it is a seat nothing ever draws into — the quietest
  // possible failure.
  const published = new Set(['conversation.session.header.utilities', 'shell.overlay'])
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
      files: [{ path: '/tmp/kept.md', deliverable: true, bytes: 10, mtimeMs: 1 }],
      commands: [],
    } }
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const first = await instance.renderer.deepRender(cards)
  check('the first panel payload is visible', textOf(first).includes('keep this summary'), textOf(first).slice(0, 120))
  firstByClass(first, 'dsse-refresh').props.onClick()
  await settle()
  const failed = await instance.renderer.deepRender(cards)
  check('the refresh error is visible', textOf(failed).includes('panel temporarily offline'), textOf(failed).slice(0, 180))
  check('the last good summary remains visible', textOf(failed).includes('keep this summary'), textOf(failed).slice(0, 180))
  check('both cards remain visible', byClass(failed, 'dsse-card').length === 2, String(byClass(failed, 'dsse-card').length))
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
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
    if (init?.method !== 'POST') return { ok: true, data: { panelSummary: true, monitorColumn: true } }
    const body = JSON.parse(String(init.body))
    return body.panelSummary === false ? firstSave.promise : secondSave.promise
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-settings-open').props.onClick()
  const settings = await instance.renderer.deepRender(cards)
  firstByClass(settings, 'dsse-check').props.onChange({ target: { checked: false } })
  const changedAgain = await instance.renderer.deepRender(cards)
  firstByClass(changedAgain, 'dsse-check').props.onChange({ target: { checked: true } })
  secondSave.resolve({ ok: true, data: { panelSummary: true, monitorColumn: true } })
  await settle()
  firstSave.resolve({ ok: true, data: { panelSummary: false, panelSide: 'left', panelCollapsed: false } })
  await settle()
  const after = await instance.renderer.deepRender(cards)
  check('an older config response cannot roll back the latest choice', firstByClass(after, 'dsse-check')?.props?.checked === true, String(firstByClass(after, 'dsse-check')?.props?.checked))
}

{
  const routes = panelRoutes()
  routes['/api/ui-evolve/config'] = (init) => {
    if (init?.method === 'POST') return { ok: true, data: { panelSummary: true, monitorColumn: false, ok: false, reason: 'settings are read only' } }
    return { ok: true, data: { panelSummary: true, monitorColumn: false } }
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const first = await instance.renderer.deepRender(cards)
  firstByClass(first, 'dsse-settings-open').props.onClick()
  const settings = await instance.renderer.deepRender(cards)
  firstByClass(settings, 'dsse-check').props.onChange({ target: { checked: false } })
  await settle()
  const refused = await instance.renderer.deepRender(cards)
  // The only setting left is the summary switch, so that is the one the host
  // refuses here. What the block pins is unchanged by which setting it is: a
  // rejected write must say so and must not take the loaded cards with it.
  check('a refused write is shown to the user', textOf(refused).includes('settings are read only'), textOf(refused).slice(0, 180))
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
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'full-session' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))

  const expandedOf = (tree) => firstByClass(tree, 'dsse-clip')?.props?.['data-expanded']
  // The 上一轮 block is the header's recap now, not a card. Everything these
  // blocks assert about it -- clickable, tab stop, role, aria-expanded, hover --
  // is unchanged; only where it is drawn has moved.
  const turnCard = (tree) => firstByClass(tree, 'dsse-recap')

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
  check('the offer takes a line of its own under the list', /\.dsse-expand\{[^}]*margin:6px auto 0/.test(expandSheet), (expandSheet.match(/\.dsse-expand\{[^}]*\}/) ?? [''])[0].slice(0, 140))
  // The row stays; only the circle fades. Collapsing the line would make the card
  // grow by 32px the moment a pointer crossed it and shove every card below down.
  check('and the row it needs is already there', /\.dsse-expand\{[^}]*margin:6px auto 0/.test(expandSheet) && /\.dsse-expand\{[^}]*max-height/.test(expandSheet) === false)
  check('and the card is the box it is pinned to', /\.dsse-card\{[^}]*position:relative/.test(expandSheet))
  check('the offer is round', /\.dsse-expand\{[^}]*border-radius:999px/.test(expandSheet))
  check('the offer takes no clicks of its own', /\.dsse-expand\{[^}]*pointer-events:none/.test(expandSheet))
  // An open card reserves room for the badge. Without the padding the badge would
  // sit on top of the last line of the summary it just revealed — the one part of
  // the card the click was for.
  check('an open card gives the badge a line instead of padding for it', /\.dsse-card\[data-open="true"\] \.dsse-expand\{[^}]*opacity:1/.test(expandSheet), (expandSheet.match(/\.dsse-card\[data-open="true"\] \.dsse-expand\{[^}]*\}/) ?? [''])[0].slice(0, 160))
  check('a hovered card still reports itself closed', turnCard(hovered)?.props?.['aria-expanded'] === false, String(turnCard(hovered)?.props?.['aria-expanded']))

  // The header's summary draws its own fade, and it is a different rule from the
  // card's 34px one. Asserting only the card's text would still pass with the
  // recap's rule mutated, because the card's selector is a substring of it --
  // which is exactly how the mutation of the recap fade survived once.
  check('the folded summary fades out where it is cut', /\.dsse-recap \.dsse-clip\[data-clipped="true"\]\[data-expanded="false"\]::after\{[^}]*height:30px/.test(expandSheet), (expandSheet.match(/\.dsse-recap \.dsse-clip[^}]*\}/) ?? [''])[0].slice(0, 160))
  check('and the fade goes away once the summary is open', /\.dsse-recap \.dsse-clip\[data-clipped="true"\]::after\{/.test(expandSheet) === false, 'the recap fade is not gated on data-expanded')

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
  // The header block carries the same badge as the card it replaced, so the
  // chevron's direction has to be pinned here too: the card copy is only reachable
  // through the 产出文件 badge now, and a mutation of the turn's chevron would slip
  // through otherwise.
  const recapIcon = (tree) => firstByClass(firstByClass(tree, 'dsse-recap'), 'dsse-expand')?.props?.children
  const recapUp = (tree) => {
    const icon = recapIcon(tree)
    if (icon?.props?.up !== undefined) return icon.props.up === true
    const d = typeof icon?.props?.children?.props?.d === 'string' ? icon.props.children.props.d : ''
    return d === '' ? undefined : d.startsWith('M6 15')
  }
  check('the header offers the way out with the same badge', firstByClass(opened, 'dsse-expand') !== undefined, String(firstByClass(opened, 'dsse-expand') === undefined))
  check('and its chevron points up while the summary is open', recapUp(opened) === true, String(recapUp(opened)))
  check('and down while it is folded', recapUp(hovered) === false, String(recapUp(hovered)))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))

  const expandedOf = (tree) => firstByClass(tree, 'dsse-clip')?.props?.['data-expanded']
  // The 上一轮 block is the header's recap now, not a card. Everything these
  // blocks assert about it -- clickable, tab stop, role, aria-expanded, hover --
  // is unchanged; only where it is drawn has moved.
  const turnCard = (tree) => firstByClass(tree, 'dsse-recap')

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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))

  // The harness renders a child component in a pass of its own, so the clip's
  // measurement reaches `Cards` one render after the clip reports it. React does
  // not have that gap — a layout effect and the state it sets land in the same
  // commit — so this is the harness catching up, not the component settling.
  const settle = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }

  // The block being measured is the header's recap, not a card: since the last
  // turn moved into the header there is no 上一轮 card to read, and the first
  // `.dsse-card` is the file list, which never was clickable and so proved nothing.
  const tree = await settle()
  const card = firstByClass(tree, 'dsse-recap')
  check('a summary that fits is not clickable', card?.props?.['data-clickable'] === 'false', String(card?.props?.['data-clickable']))
  check('and it takes no tab stop', card?.props?.tabIndex === undefined, String(card?.props?.tabIndex))
  check('and it claims no button role', card?.props?.role === undefined, String(card?.props?.role))
  // A block that offers nothing must not answer a click either. Leaving the
  // handler mounted hands the pointer a control whose only effect is a pin on a
  // summary that cannot open, which is the same defect as a tab stop on nothing.
  check('and it does not answer a click it cannot honour', card?.props?.onClick === undefined, String(typeof card?.props?.onClick))

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
  check('and it is still not offering a way to close', firstByClass(hovered, 'dsse-recap')?.props?.['data-clickable'] === 'false', String(firstByClass(hovered, 'dsse-recap')?.props?.['data-clickable']))
}

{
  // The keyboard has to be able to do what the mouse does, and only Enter and
  // Space — a card that toggles on every keypress is a card that fights scrolling.
  const routes = panelRoutes()
  const instance = boot({ routes })
  instance.renderer.setNodeForRef(fakeNode({ left: 280, top: 120, width: 1640, height: 300, overflowHeight: 900 }))
  instance.module.apply(instance.ctx)
  const cards = instance.seat('cards')
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))

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
    const handler = firstByClass(tree, 'dsse-recap')?.props?.onKeyDown
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))

  const clipOf = (tree) => firstByClass(tree, 'dsse-clip')
  // The 上一轮 block is the header's recap now, not a card. Everything these
  // blocks assert about it -- clickable, tab stop, role, aria-expanded, hover --
  // is unchanged; only where it is drawn has moved.
  const turnCard = (tree) => firstByClass(tree, 'dsse-recap')
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))

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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))

  const settleInto = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }
  const expandedOf = (tree) => firstByClass(tree, 'dsse-clip')?.props?.['data-expanded']
  const cardOf = (tree) => firstByClass(tree, 'dsse-recap')

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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))

  const settleInto = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }
  const cardOf = (tree) => firstByClass(tree, 'dsse-recap')

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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))

  const settleInto = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }
  const cardOf = (tree) => firstByClass(tree, 'dsse-recap')

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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))

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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))

  const settleInto = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }
  const clipOf = (tree) => firstByClass(tree, 'dsse-clip')
  const cardOf = (tree) => firstByClass(tree, 'dsse-recap')

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
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))

  const settle = async () => {
    await instance.renderer.deepRender(cards)
    return instance.renderer.deepRender(cards)
  }
  const clipOf = (tree) => firstByClass(tree, 'dsse-clip')
  const cardOf = (tree) => firstByClass(tree, 'dsse-recap')

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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
    pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await watched.renderer.render(watched.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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

{
  // The same observer also carries the conversation's identity, and that is the
  // part the live host got wrong: the header button publishes the id from an
  // effect, so a switch that did not re-render that button left the whole column
  // — including its session-scoped effects, which key on this value — on the
  // previous conversation. Publishing it from root scope, where the page's own
  // attribute is watched, is what makes the switch reach those effects at all.
  //
  // Without the fix the column keeps asking the old session forever; with it,
  // one attribute change is enough, and no click is needed.
  const asked = []
  const routes = {
    ...panelRoutes(),
    '/api/ui-evolve/panel': (init, target) => {
      const agent = decodeURIComponent(String(target).split('agent=')[1] ?? '')
      asked.push(agent)
      return { ok: true, data: { ...panelRoutes()['/api/ui-evolve/panel'].data, agent } }
    },
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
  }
  const watched = boot({ routes, conversationSession: 'session-a' })
  watched.module.apply(watched.ctx)
  pressToggle(firstByClass(await watched.renderer.render(watched.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  await watched.renderer.deepRender(watched.seat('cards'))
  check('the column opened on the conversation it was told about', asked[0] === 'session-a', JSON.stringify(asked))
  const slotObserver = watched.mutationObservers.find((entry) =>
    entry.targets.some((row) => row.options?.childList === true && row.options?.subtree !== true))
  check('something watches the slot the conversation is replaced inside', slotObserver !== undefined, JSON.stringify(watched.mutationObservers.map((entry) => entry.targets[0]?.options)))
  // The page moves; the button is never re-rendered, exactly the state the host
  // was caught in. `swapConversation` is what the live page does: a new node in
  // the old slot, not an edit to the old node. The slot observer is the only
  // thing that can notice, which is why the swap is modelled rather than nudged.
  watched.swapConversation('session-b')
  await settle()
  await watched.renderer.deepRender(watched.seat('cards'))
  // `syncSession` also calls `notify()`, and that call is deliberately not
  // asserted here: this harness only renders when a test asks it to, so nothing
  // it could observe distinguishes "assigned and notified" from "assigned
  // quietly" — `Cards` re-reads `bridge.sessionId` on any render, and the slot
  // observer's own `remeasure()` already moves the change counter. On the live
  // page `notify()` is what re-renders without an external trigger. Recorded as
  // a coverage gap in R-102 rather than papered over with a green assertion.
  // The column polls on a timer, so "did it notice" cannot be answered by
  // waiting for one — a fix that only corrected the request would still need
  // the timer, and the reader would stare at the old conversation for eight
  // seconds. Publishing the id changes `sessionId`, which rebuilds the loader and
  // restarts the polling effect, so the first request for the new conversation
  // is issued at once. That is the difference being asserted.
  check('the switch reaches the column without waiting for a timer', asked[asked.length - 1] === 'session-b', JSON.stringify(asked))
  // Weak on purpose, and labelled: this ticks the sixty-second callback and
  // asserts the same expression as the line above, so it would still pass if the
  // callback were emptied out. It is here to prove the timer does not *undo* a
  // switch that already happened, which is all it claims.
  const poll = watched.timers.filter((row) => row.ms === 60000 && row.cleared === false)
  if (poll.length >= 1) poll[poll.length - 1].fn()
  await settle()
  check('a later tick does not undo the switch', asked[asked.length - 1] === 'session-b', JSON.stringify(asked))
}

// ---------------------------------------------------------------------------
// A switch the slot cannot see still has to reach the column
// ---------------------------------------------------------------------------
//
// The host does not edit the conversation when somebody switches sessions: it
// unmounts `[data-conversation-content]` and mounts a new one. The question
// this suite answers is *where* that record lands.
//
// Measured on the running page, the tree is
// `[data-slot="main.conversation"] > .root > .body > [data-conversation-content]`
// — the content is three levels below the slot, and the wrappers between them
// keep their children. So a host that replaces only the content writes one
// `childList` record on the content's parent and **nothing on the slot**.
//
// The fixture used to model the content as a direct child of the slot, which is
// a host that does not exist, and an observer parked on the slot looked correct
// in every assertion while missing the real switch. It now nests them the way
// the page does, and the two suites below hold the two halves of the fix:
// noticing the switch, and rebinding the stream that a switch invalidates.
{
  const asked = []
  const routes = {
    ...panelRoutes(),
    '/api/ui-evolve/panel': (init, target) => {
      const agent = decodeURIComponent(String(target).split('agent=')[1] ?? '')
      asked.push(agent)
      return { ok: true, data: { ...panelRoutes()['/api/ui-evolve/panel'].data, agent } }
    },
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
  }
  const instance = boot({ routes, conversationSession: 'session-a', conversationDepth: 2 })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  await instance.renderer.deepRender(instance.seat('cards'))
  check('the column opens on the conversation on screen', asked[0] === 'session-a', JSON.stringify(asked))
  // The premise of the whole suite: the two nodes are not the same, so an
  // observer of the slot is not an observer of the replacement.
  check(
    'the fixture separates the slot from the node the host replaces',
    instance.slot !== instance.contentParent && instance.contentParent.parentElement !== instance.slot,
    'the content sat directly under the slot',
  )
  // Structural, not behavioural, and named that way on purpose. The check below
  // this one is the behaviour — but it passes whether or not this observer
  // exists, because change 1 re-reads the host attribute on the next render and
  // rescues the switch either way. So this is the only assertion that fails when
  // the parent observer is deleted, and a test that names itself behavioural
  // while being carried by a different mechanism is worse than one that says
  // what it is. (Same reasoning as the `notify()` gap recorded above.)
  const watchingParent = instance.mutationObservers.find((observer) =>
    observer.targets.some((row) => row.target === instance.contentParent && row.options?.childList === true))
  check(
    'structurally, something watches the node the conversation is replaced in',
    watchingParent !== undefined,
    JSON.stringify(instance.mutationObservers.map((observer) => observer.targets.map((row) => row.options))),
  )
  // A swap writes its record on the parent and nowhere else — the slot keeps
  // its wrappers, which is exactly what happens on the page.
  instance.swapConversation('session-b')
  await settle()
  await instance.renderer.deepRender(instance.seat('cards'))
  check('a switch three levels down still reaches the column', asked[asked.length - 1] === 'session-b', JSON.stringify(asked))
}

{
  // The other half. Noticing the switch is not enough: the push stream was
  // opened for the session the reader left, and a stream bound to an abandoned
  // session stays open, healthy and silent. `stream === null` never becomes
  // true, so the line that reopens it never runs, and the column waits for the
  // sixty-second clock after every switch.
  //
  // The assertion that matters is on the *stream's* url rather than on a fetch:
  // the failure mode is a stream that looks fine and answers nothing.
  const routes = {
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
  }
  const instance = boot({ routes, conversationSession: 'session-a', conversationDepth: 2 })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  await instance.renderer.deepRender(instance.seat('cards'))
  const first = instance.streamFor('session-a')
  check('the column watches the conversation it opened on', first !== undefined, JSON.stringify(instance.eventSources.map((row) => row.url)))
  instance.swapConversation('session-b')
  await settle()
  await instance.renderer.deepRender(instance.seat('cards'))
  check('and follows it to the next one', instance.streamFor('session-b') !== undefined, JSON.stringify(instance.eventSources.map((row) => row.url)))
  check('leaving no stream behind on the one it left', instance.streamFor('session-a') === undefined, JSON.stringify(instance.eventSources.map((row) => row.url)))
}

{
  // A switch the observers miss entirely — the case that produced the report.
  // The attribute moves and the node is replaced, but no record is delivered,
  // so `bridge.sessionId` stays behind. Every render of the column re-reads the
  // host's attribute, which is the only thing that can still rescue it, and the
  // slow clock is what eventually notices that the stream is bound to the wrong
  // session.
  const routes = {
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
  }
  const instance = boot({ routes, conversationSession: 'session-a', conversationDepth: 2 })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  await instance.renderer.deepRender(instance.seat('cards'))
  check('the column opened on the first conversation', instance.streamFor('session-a') !== undefined, JSON.stringify(instance.eventSources.map((row) => row.url)))
  // Move the page without telling any observer: no record, no notify, and
  // `bridge.sessionId` still says `session-a`.
  instance.conversation.setSession('session-b')
  // No clock tick here, and nothing else announces the switch: the only thing
  // that can move the stream is the column rendering again and reading the host
  // attribute for itself. That is the first of the two rescues, and it is
  // asserted on its own because the other one would otherwise stand in for it.
  await instance.renderer.deepRender(instance.seat('cards'))
  await settle()
  check(
    'a switch nobody announced is picked up by the next render',
    instance.streamFor('session-b') !== undefined,
    JSON.stringify(instance.eventSources.map((row) => row.url)),
  )
}

{
  // The same missed switch, with no render to rescue it. A column nobody has
  // asked to draw again is the ordinary state of a background tab, and the slow
  // clock is the only thing left that can notice the stream is bound to a
  // session the reader left. Asserted before any render so the render cannot
  // take the credit: under a mutation that drops the clock's rebind, the stream
  // stays where it was and this fails.
  const routes = {
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
  }
  const instance = boot({ routes, conversationSession: 'session-a', conversationDepth: 2 })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  await instance.renderer.deepRender(instance.seat('cards'))
  instance.conversation.setSession('session-b')
  const clock = instance.timers.filter((row) => row.ms === 60000 && row.cleared === false)
  check('a slow clock is running behind the stream', clock.length >= 1, JSON.stringify(instance.timers.map((row) => row.ms)))
  clock[clock.length - 1].fn()
  await settle()
  check(
    'a switch nobody announced still rebinds the stream when the clock comes round',
    instance.streamFor('session-b') !== undefined,
    JSON.stringify(instance.eventSources.map((row) => row.url)),
  )
  check(
    'leaving no stream behind on the one it left',
    instance.streamFor('session-a') === undefined,
    JSON.stringify(instance.eventSources.map((row) => row.url)),
  )
}

{
  // The third rescue, asserted on its own for the same reason as the other two.
  //
  // It is written against the case that actually needs it, and the obvious
  // version of this test does not: if the page really went away, `onVisible`
  // closed the stream on the way out, so on the way back `stream === null` is
  // already true and the rebind would happen with or without the session check.
  // The case that needs the check is a page that never went away -- a window
  // merely uncovered, a tab brought forward -- where `visibilitychange` fires
  // with `document.hidden` already false and the stream is open, healthy, and
  // bound to the session the reader left. Nothing here renders the column, so
  // the render-time read cannot take the credit either.
  const routes = {
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
  }
  const instance = boot({ routes, conversationSession: 'session-a', conversationDepth: 2 })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  await instance.renderer.deepRender(instance.seat('cards'))
  const opened = instance.streamFor('session-a')
  check('the column opened on the first conversation', opened !== undefined, JSON.stringify(instance.eventSources.map((row) => row.url)))
  // The session moves while the page stays visible, and no observer reports it.
  instance.conversation.setSession('session-b')
  // A visibilitychange with `hidden` still false: the stream was never closed,
  // so it is still open and still bound to `session-a`.
  instance.document.hidden = false
  for (const listener of instance.document.visibilityListeners) listener()
  await settle()
  check(
    'a stream left open on the old session is rebound when the page is looked at again',
    instance.streamFor('session-b') !== undefined,
    JSON.stringify(instance.eventSources.map((row) => row.url)),
  )
  check(
    'leaving no stream behind on the one it left',
    instance.streamFor('session-a') === undefined,
    JSON.stringify(instance.eventSources.map((row) => row.url)),
  )
}

{
  // A queued failure from a stream this effect has already replaced.
  //
  // `close()` does not cancel an `error` that was already on its way, so a
  // handler registered on the replaced source can still run afterwards. It
  // shares this effect's `stream` binding, so without a guard it would call
  // `stopStream()` and close the healthy replacement -- silently costing the
  // fast path and dropping the column back to the minute clock, which is the
  // exact symptom this change exists to remove.
  //
  // The replacement has to happen *inside one effect run*. A conversation switch
  // does not qualify: it re-runs the effect, and the old handlers then close over
  // the old run's bindings, which no longer name the open stream. Reopening from
  // the visibility path does qualify -- same closure, same `stream`, new source.
  const routes = {
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
  }
  const instance = boot({ routes, conversationSession: 'session-a', conversationDepth: 2 })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  await instance.renderer.deepRender(instance.seat('cards'))
  const abandoned = instance.streamFor('session-a')
  // The page was never hidden -- the window was covered, or the tab came back to
  // the foreground -- so nothing closed the stream, and only the rebind check
  // inside the visibility handler can notice it is bound to the old session.
  instance.conversation.setSession('session-b')
  for (const listener of instance.document.visibilityListeners) listener()
  await settle()
  const current = instance.streamFor('session-b')
  check(
    'the reopen left a replacement stream open',
    abandoned !== undefined && current !== undefined && current !== abandoned,
    JSON.stringify(instance.eventSources.map((row) => row.url)),
  )
  abandoned.failFatalQueued()
  await settle()
  check(
    'a failure queued on a replaced stream does not close its replacement',
    current.closed === false && instance.streamFor('session-b') !== undefined,
    JSON.stringify(instance.eventSources.map((row) => ({ url: row.url, closed: row.closed }))),
  )
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
  pressToggle(firstByClass(await unnamed.renderer.render(unnamed.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
  const poll = instance.timers.find((row) => row.ms === 60000 && row.cleared === false)
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
// A backgrounded page, and a second refresh that would stack on the first
// ---------------------------------------------------------------------------
//
// Both are about the same cost: this plugin pays a full queue read for every
// answer it gets, so an answer nobody asked for is not free the way a rendered
// div is. The refresh interval is eight seconds, and a cold answer used to take
// longer than that, so the timer could start a second request before the first
// returned -- and each request holds a lock for part of its life, which turns
// overlap into a queue.

{
  // Hidden: the poll fires into nothing. Not merely "does not render" -- it must
  // not ask, because asking is the expense.
  const { instance } = await openPanel({ ...panelRoutes() }, { hidden: true })
  const cards = instance.seat('cards')
  await instance.renderer.deepRender(cards)
  const poll = instance.timers.find((row) => row.ms === 60000 && row.cleared === false)
  check('a hidden page still schedules the refresh', poll !== undefined, JSON.stringify(instance.timers.map((row) => row.ms)))
  const before = instance.calls.filter((row) => row.url.includes('/panel?')).length
  poll?.fn?.()
  await settle()
  const after = instance.calls.filter((row) => row.url.includes('/panel?')).length
  check('a hidden page does not ask', after === before, `${after - before} extra request(s)`)

  // Coming back asks once, immediately: the numbers on screen are stale by then,
  // and waiting up to eight more seconds would show a column that is visibly
  // behind the conversation next to it.
  instance.document.hidden = false
  const listeners = instance.document.visibilityListeners
  check('the bundle watches for the page coming back', listeners.length > 0, String(listeners.length))
  for (const listener of listeners) listener()
  await settle()
  const returned = instance.calls.filter((row) => row.url.includes('/panel?')).length
  check('coming back asks again at once', returned > after, `${returned - after} request(s)`)

  // The listener has to be unregistered, not just registered. `load` depends on
  // `sessionId`, so the polling effect re-runs on every switch; left behind, each
  // switch would add a listener that fires its own `load(true)` on every return
  // to the tab. Deleting `removeEventListener` from the cleanup kept all of this
  // suite green, because nothing asserted the removal.
  //
  // One listener is the correct count, not zero: the new session's effect
  // registers its own. What must not happen is growth -- two listeners means the
  // old one was never removed, and both would fire a fetch on every return.
  // The switch only tears anything down when the panel itself renders again --
  // rendering the toggle sets the session the cards read, but the cards' own
  // effect runs on their next render. Asserting right after the toggle measured a
  // component that had not re-run yet, which is why deleting `removeEventListener`
  // survived this check at first.
  await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-b' })
  await instance.renderer.deepRender(cards)
  const afterSwitch = instance.document.visibilityListeners.length
  await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-c' })
  await instance.renderer.deepRender(cards)
  const afterSecondSwitch = instance.document.visibilityListeners.length
  check(
    'the page-back listener does not accumulate across session switches',
    afterSwitch === 1 && afterSecondSwitch === 1,
    `${afterSwitch} then ${afterSecondSwitch} listener(s)`
  )
}

{
  // Overlap: the second refresh is skipped, not queued behind the first.
  const slow = deferred()
  const routes = panelRoutes()
  let asked = 0
  routes['/api/ui-evolve/panel'] = () => {
    asked += 1
    return asked === 1 ? slow.promise : { ok: true, data: {
      turn: 1, calls: 1, failed: 0, summary: { text: 'SECOND' }, pendingCandidates: 0,
      skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
    } }
  }
  const { instance } = await openPanel(routes)
  const cards = instance.seat('cards')
  await instance.renderer.deepRender(cards)
  const poll = instance.timers.find((row) => row.ms === 60000 && row.cleared === false)
  check('a slow first answer leaves a live timer to collide with', poll !== undefined && asked === 1, JSON.stringify({ asked, timers: instance.timers.map((row) => row.ms) }))
  poll?.fn?.()
  await settle()
  check('a refresh that would stack on a request in flight is skipped', asked === 1, `${asked} request(s)`)
  slow.resolve({ ok: true, data: {
    turn: 1, calls: 1, failed: 0, summary: { text: 'FIRST' }, pendingCandidates: 0,
    skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
  } })
  await settle()
  const settled = await instance.renderer.deepRender(cards)
  check('the first answer still lands', textOf(settled).includes('FIRST'), textOf(settled).slice(0, 120))
  // And the skip was not a permanent lock: the next refresh goes out.
  const next = instance.timers.find((row) => row.ms === 60000 && row.cleared === false)
  next?.fn?.()
  await settle()
  check('the next refresh is not blocked by the one that completed', asked === 2, `${asked} request(s)`)
}

{
  // A refresh the reader caused must not be swallowed by one already out. The
  // approval callback is quiet -- the panel is on screen, so there is no loading
  // state to show -- and the first version of the guard keyed on that, which
  // dropped exactly the calls that mattered: a poll in flight when an approval
  // returned left the queue on screen as it was *before* the approval, for up to
  // eight seconds, with nothing queued to fix it.
  const routes = panelRoutes()
  const slow = deferred()
  const decision = deferred()
  let asked = 0
  // One candidate, so the dialog has something to approve. The decide route is
  // left hanging until the test says otherwise: an approval that has *returned* is
  // what triggers the refresh, so the ordering has to be the test's to control.
  routes['/api/ui-evolve/candidates'] = { ok: true, data: { candidates: [
    { id: 'a', name: 'pdf-tools', description: 'work with pdfs', kind: 'create', body: 'BODY-A', whenToUse: 'WHEN-A', uses: 0 },
  ] } }
  routes['/api/ui-evolve/panel'] = () => {
    asked += 1
    if (asked === 1) return { ok: true, data: {
      turn: 1, calls: 1, failed: 0, summary: { text: 'FIRST' }, pendingCandidates: 0,
      skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
    } }
    if (asked === 2) return slow.promise
    return { ok: true, data: {
      turn: 1, calls: 1, failed: 0, summary: { text: 'AFTER-DECISION' }, pendingCandidates: 0,
      skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
    } }
  }
  const { instance } = await openPanel(routes)
  const cards = instance.seat('cards')
  await instance.renderer.deepRender(cards)
  check('the first answer is on screen', asked === 1, String(asked))

  // A poll goes out and is left hanging.
  const poll = instance.timers.find((row) => row.ms === 60000 && row.cleared === false)
  poll?.fn?.()
  await settle()
  check('a poll is out', asked === 2, String(asked))

  // The reader approves a candidate while that poll is still out. This is the
  // call the first version dropped: the approval callback is quiet (the panel is
  // already on screen, so there is no loading state to show) and the guard keyed
  // on that, which dropped exactly the calls that mattered. The refresh button
  // would not catch this -- it is not quiet -- so the test has to go through the
  // quiet one.
  const tree = await instance.renderer.deepRender(cards)
  firstByClass(tree, 'dsse-queue').props.onClick()
  await settle()
  const listed = await instance.renderer.deepRender(cards)
  byClass(listed, 'dsse-candidate')[0].props.onClick()
  const detailed = await instance.renderer.deepRender(cards)
  const approve = byAction(detailed, 'approve')
  check('the dialog offers an approval to press while a poll is out', approve !== undefined)
  approve?.props?.onClick?.()
  await settle(16)
  check('the approval does not stack a second request on the one out', asked === 2, `${asked} request(s)`)

  slow.resolve({ ok: true, data: {
    turn: 1, calls: 1, failed: 0, summary: { text: 'STALE-POLL' }, pendingCandidates: 0,
    skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
  } })
  await settle()
  check('the dropped refresh is asked for once the poll lands', asked === 3, `${asked} request(s)`)
  const settled = await instance.renderer.deepRender(cards)
  check('and the panel shows what the refresh asked for, not the poll it was waiting on', textOf(settled).includes('AFTER-DECISION'), textOf(settled).slice(0, 160))
}

{
  // An unchanged poll must not re-render the column. This is the defect the user
  // feels as "it stutters when there are many files": the refresh runs every eight
  // seconds whether or not anything happened, and a fresh payload object meant the
  // whole card tree was rebuilt each time.
  const routes = panelRoutes()
  let served = 0
  routes['/api/ui-evolve/panel'] = () => {
    served += 1
    return { ok: true, data: {
      turn: 1, calls: 1, failed: 0, summary: { text: 'SAME' }, pendingCandidates: 0,
      skills: { available: true, skills: [] }, mcp: [], commands: [],
      files: Array.from({ length: 12 }, (_, at) => ({ path: `src/file-${at}.md`, deliverable: true, bytes: 1000 + at })),
    } }
  }
  const { instance } = await openPanel(routes)
  const cards = instance.seat('cards')
  await instance.renderer.deepRender(cards)
  const poll = instance.timers.find((row) => row.ms === 60000 && row.cleared === false)
  check('the first answer is on screen before the refresh', served === 1, String(served))
  const before = instance.renderer.stateChanges()
  poll?.fn?.()
  await settle()
  const after = instance.renderer.stateChanges()
  check('a poll that changes nothing asks again', served === 2, String(served))
  // Not "renders less" -- renders not at all. Keeping the old payload object is
  // what makes React skip the update, so a replaced state here means the whole
  // column is about to be rebuilt from an answer identical to the one on screen.
  check('and it does not replace the state', after === before, `${after - before} state replacement(s)`)

  // A poll that does change something must render. The guard is a signature
  // comparison, and a comparison that never fires is indistinguishable from an
  // optimisation that swallows updates.
  routes['/api/ui-evolve/panel'] = () => ({ ok: true, data: {
    turn: 2, calls: 2, failed: 0, summary: { text: 'CHANGED' }, pendingCandidates: 0,
    skills: { available: true, skills: [] }, mcp: [], commands: [],
    files: [{ path: 'src/file-0.js', deliverable: true, bytes: 1000 }],
  } })
  const again = instance.timers.find((row) => row.ms === 60000 && row.cleared === false)
  const beforeChange = instance.renderer.stateChanges()
  again?.fn?.()
  await settle()
  const changed = await instance.renderer.deepRender(cards)
  check('a poll that changes something renders', textOf(changed).includes('CHANGED'), textOf(changed).slice(0, 120))
  check('and it replaces the state', instance.renderer.stateChanges() > beforeChange, `${instance.renderer.stateChanges() - beforeChange} state replacement(s)`)
}

{
  // The payload is not everything on screen: "3 分钟前" is derived from the clock
  // at render time, so an unchanged payload can still describe a changed screen.
  // A signature that compares only the payload freezes that label at whatever it
  // read first -- for hours, since nothing about the answer ever changes again.
  const started = 1_700_000_000_000
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = { ok: true, data: {
    turn: 1, calls: 1, failed: 0, pendingCandidates: 0,
    summary: { text: 'TEXT', at: started },
    skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
  } }
  const { instance } = await openPanel(routes, { now: started })
  const cards = instance.seat('cards')
  const first = await instance.renderer.deepRender(cards)
  check('a summary carries how long ago it was made', textOf(first).includes('刚刚'), textOf(first).slice(0, 160))
  const before = instance.renderer.stateChanges()
  // Five minutes later, the same answer. Nothing in the payload moved; the line
  // on screen did.
  instance.clock.at = started + 5 * 60 * 1000
  instance.timers.find((row) => row.ms === 60000 && row.cleared === false)?.fn?.()
  await settle()
  const later = await instance.renderer.deepRender(cards)
  check('an unchanged answer still ages on screen', textOf(later).includes('5分钟前'), textOf(later).slice(0, 160))
  check('and the ageing is a render, not a skipped poll', instance.renderer.stateChanges() > before, `${instance.renderer.stateChanges() - before} state replacement(s)`)
}

{
  // Leave a session and come back while its first request is still out. The
  // abandoned request must not unlock the one now on screen: session names cannot
  // tell two requests for the same session apart, a per-request ticket can.
  const slowFirst = deferred()
  const slowThird = deferred()
  const routes = panelRoutes()
  let asked = 0
  routes['/api/ui-evolve/panel'] = () => {
    asked += 1
    if (asked === 1) return slowFirst.promise
    if (asked === 3) return slowThird.promise
    return { ok: true, data: {
      turn: 1, calls: 1, failed: 0, pendingCandidates: 0,
      summary: { text: 'B' }, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
    } }
  }
  const { instance } = await openPanel(routes)
  const cards = instance.seat('cards')
  const toggle = instance.seat('toggle')
  check('the first request for A is out', asked === 1, `${asked} request(s)`)
  await instance.renderer.render(toggle, { sessionId: 'session-b' })
  await instance.renderer.deepRender(cards)
  await instance.renderer.render(toggle, { sessionId: 'session-a' })
  await instance.renderer.deepRender(cards)
  check('coming back to A asks again', asked === 3, `${asked} request(s)`)
  // The abandoned first request settles now, while the third is still out.
  slowFirst.resolve({ ok: true, data: {
    turn: 1, calls: 1, failed: 0, pendingCandidates: 0,
    summary: { text: 'A-OLD' }, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
  } })
  await settle()
  const poll = instance.timers.find((row) => row.ms === 60000 && row.cleared === false)
  poll?.fn?.()
  await settle()
  check('an abandoned request does not unlock the one that replaced it', asked === 3, `${asked} request(s)`)
  slowThird.resolve({ ok: true, data: {
    turn: 1, calls: 1, failed: 0, pendingCandidates: 0,
    summary: { text: 'A-NEW' }, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
  } })
  await settle()
  const settled = await instance.renderer.deepRender(cards)
  check('and the answer that replaced it lands', textOf(settled).includes('A-NEW'), textOf(settled).slice(0, 160))
}

{
  // The other half of the same guard, and the one a request ticket cannot cover:
  // the abandoned request arriving *last*. Switching away and back issues a new
  // request for the same conversation, so a reply issued before the switch can
  // still name the conversation the reader is on now — the busy ticket has
  // already been cleared by the switch, and the session check passes because the
  // names match. Only the request counter can tell the two apart. Without it the
  // older answer lands on top of the newer one, and the column shows a state
  // that was already superseded.
  const slowFirst = deferred()
  const slowThird = deferred()
  const routes = panelRoutes()
  let asked = 0
  routes['/api/ui-evolve/panel'] = () => {
    asked += 1
    if (asked === 1) return slowFirst.promise
    if (asked === 3) return slowThird.promise
    return { ok: true, data: {
      turn: 1, calls: 1, failed: 0, pendingCandidates: 0,
      summary: { text: 'B' }, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
    } }
  }
  const { instance } = await openPanel(routes)
  const cards = instance.seat('cards')
  const toggle = instance.seat('toggle')
  await instance.renderer.render(toggle, { sessionId: 'session-b' })
  await instance.renderer.deepRender(cards)
  await instance.renderer.render(toggle, { sessionId: 'session-a' })
  await instance.renderer.deepRender(cards)
  check('the third request replaced the abandoned first', asked === 3, `${asked} request(s)`)
  // The newest answer lands first.
  slowThird.resolve({ ok: true, data: {
    turn: 1, calls: 1, failed: 0, pendingCandidates: 0,
    summary: { text: 'A-NEW' }, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
  } })
  await settle()
  const fresh = await instance.renderer.deepRender(cards)
  check('the newest answer is on screen', textOf(fresh).includes('A-NEW'), textOf(fresh).slice(0, 160))
  // Then the abandoned one, arriving late with the same session name.
  slowFirst.resolve({ ok: true, data: {
    turn: 1, calls: 1, failed: 0, pendingCandidates: 0,
    summary: { text: 'A-OLD' }, skills: { available: true, skills: [] }, mcp: [], files: [], commands: [],
  } })
  await settle()
  const late = await instance.renderer.deepRender(cards)
  // This pair is about the request counter that predates the session work: an
  // abandoned request must not land on top of the one that replaced it. It is
  // not regression coverage for the switch bug — it passes on the pre-fix file.
  check('a reply that arrives after its replacement does not overwrite it', textOf(late).includes('A-OLD') === false, textOf(late).slice(0, 160))
  check('the newer answer is still the one on screen', textOf(late).includes('A-NEW'), textOf(late).slice(0, 160))
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
  pressToggle(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle'))
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
  // The row order is the requirement, and it runs from what you read to what you
  // press: the queue first, then the three controls as one group (speed,
  // refresh, settings). The number is between them so it can appear and
  // disappear without moving a target — it is the only thing in the row whose
  // width changes on its own.
  const { tree } = await openPanel({
    ...panelRoutes(),
    '/api/ui-evolve/speed': { ok: true, data: { tokens: 100, ms: 1000, tps: 42, active: true } },
  })
  const top = firstByClass(tree, 'dsse-top-row')
  const children = (top?.props?.children ?? []).filter((node) => node !== null && node !== undefined && node !== false)
  const at = (name) => children.findIndex((node) => byClass(node, name).length > 0 || node.props?.className === name)
  const queue = at('dsse-queue')
  const speed = at('dsse-speed')
  const refresh = at('dsse-refresh')
  const settings = at('dsse-settings-open')
  check('the queue comes first, where the eye lands', queue === 0, `${queue} then ${speed}`)
  check('the badge sits between the queue and the controls', queue >= 0 && speed > queue, `${queue} then ${speed}`)
  check('the refresh button follows the badge', refresh > speed, `${speed} then ${refresh}`)
  check('and settings closes the row', settings > refresh, `${refresh} then ${settings}`)
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
  // The column's session identity has to come from the page, not from the header
  // button's prop. Reproduced on a live host: switching conversation moved the
  // title, the selected row and `data-conversation-session`, but the column kept
  // asking about the session the reader had left — and clicking the header
  // button once fixed it, because that click writes the id an effect was
  // supposed to write. The window is one render wide, so it only shows up as a
  // race; here it is staged on purpose by moving the attribute and never
  // re-rendering the button.
  const asked = []
  const { instance } = await openPanel(
    {
      ...panelRoutes(),
      '/api/ui-evolve/panel': (init, target) => {
        const agent = decodeURIComponent(String(target).split('agent=')[1] ?? '')
        asked.push(agent)
        return { ok: true, data: { ...panelRoutes()['/api/ui-evolve/panel'].data, agent } }
      },
      '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
    },
    { conversationSession: 'session-a' },
  )
  const cards = instance.seat('cards')
  await instance.renderer.deepRender(cards)
  check('the first request names the conversation on screen', asked[0] === 'session-a', JSON.stringify(asked))
  // The page moves to another conversation; the button is not re-rendered, so
  // the value it published is still the old one. This is the exact state the
  // host was caught in.
  instance.swapConversation('session-b')
  const poll = instance.timers.filter((row) => row.ms === 60000 && row.cleared === false)
  check('a refresh is waiting to run', poll.length === 1, JSON.stringify(instance.timers.map((row) => [row.ms, row.cleared])))
  if (poll.length === 1) poll[0].fn()
  await settle()
  check('the refresh asks about the conversation on screen, not the one this closure captured', asked[1] === 'session-b', JSON.stringify(asked))
}

{
  // The answer says which conversation it describes. If that disagrees with what
  // was asked for, believing it would paint one conversation's cards under
  // another's title — the same visible failure as the switch bug, arriving by a
  // different route. The payload's own field is the only self-check available,
  // and until this guard existed the client never read it.
  const { instance, tree } = await openPanel(
    {
      ...panelRoutes(),
      '/api/ui-evolve/panel': () => ({
        ok: true,
        data: {
          ...panelRoutes()['/api/ui-evolve/panel'].data,
          agent: 'session-somewhere-else',
          summary: { text: 'PAINTED-FROM-THE-WRONG-SESSION' },
          files: [],
        },
      }),
      '/api/ui-evolve/speed': { ok: true, data: { tokens: 0, ms: 0, tps: 0, active: false } },
    },
    { conversationSession: 'session-a' },
  )
  const cards = instance.seat('cards')
  const before = instance.renderer.stateChanges()
  const poll = instance.timers.filter((row) => row.ms === 60000 && row.cleared === false)
  if (poll.length === 1) poll[0].fn()
  await settle()
  const after = await instance.renderer.deepRender(cards)
  check('an answer about another conversation is not painted', textOf(after).includes('PAINTED-FROM-THE-WRONG-SESSION') === false, textOf(after).slice(0, 160))
  check('and it does not replace the state it was dropped for', instance.renderer.stateChanges() === before, `${before} -> ${instance.renderer.stateChanges()}`)
  check('the first answer on screen is still the real one', tree !== undefined, '')
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
  // The badge must not share the panel's beat: two timers on the same delay are
  // one delay, and nothing that filters recorded timers can tell them apart.
  //
  // The panel's own number changed twice in one week -- eight seconds, then a
  // sixty-second fallback beside a stream -- so what this asserts is the
  // relationship rather than a literal. A literal here would have to be edited
  // every time the panel's clock legitimately changes, and would then fail for a
  // reason that has nothing to do with the badge.
  const source = readFileSync(join(repo, 'packages', 'ui-evolve', 'lib', 'client.js'), 'utf8')
  const idle = /const SPEED_IDLE_MS = (\d+)/.exec(source)
  const panel = /const REFRESH_MS = (\d+)/.exec(source)
  check('the idle badge clock is its own number', idle !== null && idle[1] === '10000', idle === null ? 'no constant' : idle[1])
  check(
    'and the panel keeps a beat of its own',
    panel !== null && panel[1] !== (idle?.[1] ?? ''),
    panel === null ? 'no constant' : panel[1],
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
    deliverable: true,
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  const list = firstByClass(card, 'dsse-files')
  const names = () => byClass(card, 'dsse-name').map((node) => textOf(node))

  check('the output card lists four rows before anybody opens it', names().length === 4, JSON.stringify(names()))
  // The four shown are the first four edited, not the four newest on disk.
  check('the rows are the ones edited last, in that order', JSON.stringify(names()) === JSON.stringify(['f1.md', 'f2.md', 'f3.md', 'f4.md']), JSON.stringify(names()))
  check('the header says how many there are', textOf(firstByClass(card, 'dsse-head-stats')).includes('7 个文件'), textOf(firstByClass(card, 'dsse-head-stats')))
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
    return shared.includes('border-radius:999px') && shared.includes('width:26px') && shared.includes('height:26px')
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
  // The badge is drawn on hover and on an open card, and only then does it accept a
  // press. Leaving `auto` on unconditionally made an invisible 26px circle eat the
  // clicks meant for the row underneath it.
  check(
    'the badge takes the pointer back so it can be pressed',
    /\.dsse-card:hover \.dsse-expand-action[^{]*\{[^}]*pointer-events:auto/.test(sheetOf()) && /\.dsse-card\[data-open="true"\] \.dsse-expand-action[^{]*\{[^}]*pointer-events:auto/.test(sheetOf()),
    (sheetOf().match(/\.dsse-expand-action[^{]*\{[^}]*\}/) ?? [''])[0].slice(0, 160),
  )
  check('and it looks pressable', ruleOf('.dsse-expand-action').includes('cursor:pointer'), ruleOf('.dsse-expand-action').slice(0, 160))
  // The badge floats over the content rather than reserving a strip under it.
  // Reserving one drew a permanent empty row under a folded list — the same
  // amount of blank whether or not the pointer ever arrived — and the row was
  // the largest thing on a three-row card.
  check('and a folded badge reserves no row of its own', ruleOf('.dsse-card[data-badge="true"] .dsse-card-body') === '', ruleOf('.dsse-card[data-badge="true"] .dsse-card-body').slice(0, 160))
  // Open, the badge stops floating and becomes a row of its own. Floating is
  // only right while there is a line under it for the fade to cover; over an
  // open list the circle hangs mid-row and reads as a control that fell off.
  // Keyed on data-open, not aria-expanded: the files card hands its expansion to
  // a real button, so its own aria-expanded is never written. Rules hung on
  // aria-expanded matched nothing on the one card that needed them.
  check('and an open badge leaves the content alone', ruleOf('.dsse-card[data-open="true"] .dsse-card-body') === '', ruleOf('.dsse-card[data-open="true"] .dsse-card-body').slice(0, 160))
  const openSpot = ruleOf('.dsse-card[data-open="true"] .dsse-expand')
  check('and an open card gives it a row instead of a spot on the last file', openSpot.includes('position:static') && openSpot.includes('margin:6px auto 0'), openSpot.slice(0, 200))
  const foldedSpot = ruleOf('.dsse-card[data-open="false"] .dsse-expand')
  check('and a folded card floats it on the fade, where there is no room for a row', foldedSpot.includes('position:absolute') && foldedSpot.includes('bottom:6px'), foldedSpot.slice(0, 200))
  // The files card hands its expansion to a real button, so it never carries
  // aria-expanded itself. Keying placement on that attribute left the badge
  // exactly where the shared rule put it, on the one card that needed the split.
  const declared = readFileSync(new URL('../packages/ui-evolve/lib/client.js', import.meta.url), 'utf8')
  check('the placement is keyed on an attribute every card carries', declared.includes("'data-open': (props.badgeAction === undefined ? props.expanded : props.badgeAction.open)"), 'data-open not published on the card')
  check('and centres it on the fade rather than against a corner', foldedSpot.includes('left:50%') && foldedSpot.includes('translateX(-50%)'), foldedSpot.slice(0, 200))

  // The summary in the header is a .dsse-recap, not a .dsse-card, so none of the
  // card rules above reach it. It carried one unconditional margin rule instead
  // and that is what turned into a permanent extra row under every summary --
  // the same regression the card split was written to fix, on the other element.
  // Both halves are pinned here so a single shared rule cannot come back.
  const recapFolded = ruleOf('.dsse-recap[data-expanded="false"] .dsse-expand')
  const recapOpen = ruleOf('.dsse-recap[data-expanded="true"] .dsse-expand')
  check('the summary badge floats while the summary is cut off', recapFolded.includes('position:absolute') && recapFolded.includes('bottom:6px') && recapFolded.includes('left:50%'), recapFolded.slice(0, 200))
  check('and becomes a row once the summary is open', recapOpen.includes('position:static') && recapOpen.includes('margin:6px auto 0'), recapOpen.slice(0, 200))
  check('and no unconditional rule parks it in a row in both states', ruleOf('.dsse-recap .dsse-expand') === '', ruleOf('.dsse-recap .dsse-expand').slice(0, 200))

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
  check('the header keeps meaning the same thing when the card opens', textOf(firstByClass(openCard, 'dsse-head-stats')).includes('7 个文件'), textOf(firstByClass(openCard, 'dsse-head-stats')))
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
    { path: '/work/a.md', deliverable: true, bytes: 10, mtimeMs: 100, turn: false, noise: false, address: 'dsh-resource://file/session/session-a/work/a.md' },
    { path: '/work/b.md', deliverable: true, bytes: 20, mtimeMs: 200, turn: true, noise: false, address: 'dsh-resource://file/session/session-a/work/b.md' },
    { path: '/work/node_modules/x.js', deliverable: false, bytes: 30, mtimeMs: 300, turn: false, noise: true, address: 'dsh-resource://file/session/session-a/work/node_modules/x.js' },
    { path: '/work/c.md', deliverable: true, bytes: 40, mtimeMs: 400, turn: true, noise: false, address: 'dsh-resource://file/session/session-a/work/c.md' },
    { path: '/work/d.md', deliverable: true, bytes: 50, mtimeMs: 500, turn: false, noise: false, address: 'dsh-resource://file/session/session-a/work/d.md' },
    { path: '/work/e.md', deliverable: true, bytes: 60, mtimeMs: 600, turn: true, noise: false, address: 'dsh-resource://file/session/session-a/work/e.md' },
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  const names = () => byClass(card, 'dsse-name').map((node) => textOf(node))
  const meta = () => textOf(firstByClass(card, 'dsse-head-stats'))
  // The two halves of the header, read separately: the bold count and the quiet
  // remainder. Adding them back together is the arithmetic the header promises.
  const countHead = (text) => Number((String(text).match(/(\d+) 个文件/u) ?? [])[1])
  // One remainder now, not two: a row the card declines to draw is a row whose
  // extension is not a delivery format, and there is no second reason to hide one.
  const countNote = (node) => {
    const text = textOf(firstByClass(node, 'dsse-head-note'))
    const skipped = Number((text.match(/另有 (\d+) 个文件不是交付文档/u) ?? [])[1])
    return Number.isFinite(skipped) ? skipped : 0
  }

  // Folded, the four rows are this turn's files first, then the session's older
  // ones. Keeping the handed order would give a.md first, and that is precisely
  // the reading the card is supposed to spare the reader.
  check('the folded card shows this turn before the rest', JSON.stringify(names()) === JSON.stringify(['b.md', 'c.md', 'e.md', 'a.md']), JSON.stringify(names()))
  check('the generated files are not among the folded rows', names().includes('x.js') === false, JSON.stringify(names()))
  // The header counts people's files and names the generated remainder in a
  // quieter voice. The reverse was tried and reversed: counting everything was
  // truthful about the collector and a lie to the reader — one real session said
  // `200 个文件` over four rows, and 197 of the rows behind it were a reviewer's
  // copy of the repository. Both numbers are still said, because a reader who adds
  // the header up must land on the total the badge counts down from.
  check('the header counts the files a person wrote', meta().includes('5 个文件'), meta())
  check('and names the rows it did not draw', textOf(firstByClass(card, 'dsse-head-note')) === '另有 1 个文件不是交付文档', textOf(firstByClass(card, 'dsse-head-note')))
  check('and the two halves are the whole list', countHead(meta()) + countNote(card) === 6, `${meta()} / ${textOf(firstByClass(card, 'dsse-head-note'))}`)
  // A card whose only hidden rows are generated files still needs a way to see
  // them: filtering without an exit is deletion with extra steps. Four of the six
  // rows are drawn (three this turn, then a.md), so two are missing — one written
  // file and one generated one.
  const badge = firstByClass(card, 'dsse-expand-action')
  check('the badge names the rows that are not on screen', String(badge?.props?.['aria-label'] ?? '') === '显示其余 1 个', String(badge?.props?.['aria-label']))

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

  check('opening the card shows every delivered file', openNames.length === 5, JSON.stringify(openNames))
  // The filtered row does not come back when the card opens. Opening is the exit
  // from the fold, not from the filter: a source file is not a delivered document
  // whether the reader is looking at four rows or at all of them.
  check('and not the one it declined to draw', openNames.includes('x.js') === false, JSON.stringify(openNames))
  check('this turn comes first', JSON.stringify(groupNames('fresh')) === JSON.stringify(['b.md', 'c.md', 'e.md']), JSON.stringify(groupNames('fresh')))
  check('then the rest of the session', JSON.stringify(groupNames('earlier')) === JSON.stringify(['a.md', 'd.md']), JSON.stringify(groupNames('earlier')))
  // No third group: the files that are gone get one, and this fixture has none.
  check('the groups are drawn in that order', JSON.stringify(groups.map((node) => node.props?.['data-group'])) === JSON.stringify(['fresh', 'earlier']), JSON.stringify(groups.map((node) => node.props?.['data-group'])))
  // Only a group that sits beside another one needs a name: a heading over the
  // only list on the card says nothing the card head has not already said.
  check('the older group is labelled', textOf(groups.find((node) => node.props?.['data-group'] === 'earlier')).includes('更早'), textOf(groups.find((node) => node.props?.['data-group'] === 'earlier')).slice(0, 60))
  check('the rows this turn wrote carry no heading', firstByClass(groups.find((node) => node.props?.['data-group'] === 'fresh'), 'dsse-group-label') === undefined, textOf(groups[0]).slice(0, 60))
  // A row used to carry `data-noise` so a dimming rule could match it after the
  // reader scrolled past the group heading. There is no such row to dim now, and
  // the attribute went with the rule.
  check('no row carries a collector word', byClass(openCard, 'dsse-row').every((node) => node.props?.['data-noise'] === undefined && node.props?.['data-stale'] === undefined && node.props?.['data-source'] === undefined), String(byClass(openCard, 'dsse-row').length))

  const sheet = instance.styles.map((node) => String(node.textContent)).join('\n')
  check('the groups are spaced as separate blocks', /\.dsse-group\{[^}]*display:grid/.test(sheet), '')
  check('and the gap between them is drawn once', /\.dsse-group \+ \.dsse-group\{[^}]*margin-top/.test(sheet), '')
  check('a group heading is quieter than a row', /\.dsse-group-label\{[^}]*label-tertiary/.test(sheet), '')
  check('and the dimming rules went with them', sheet.includes('data-noise') === false && sheet.includes('data-stale') === false, '')
}

{
  // A session that delivered nothing but source files gets no card at all. This
  // block used to assert the opposite: the card folded to zero rows and then had
  // to open itself so the reader could see the generated files. With the card
  // scoped to delivered documents there is nothing to show, and a card saying
  // `0 个文件 另有 2 个文件不是交付文档` would be a card about its own filter.
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
        { path: '/work/dist/out.js', deliverable: false, bytes: 1, mtimeMs: 1, turn: false, address: 'dsh-resource://file/session/session-a/work/dist/out.js' },
        { path: '/work/package-lock.json', deliverable: false, bytes: 2, mtimeMs: 2, turn: false, address: 'dsh-resource://file/session/session-a/work/package-lock.json' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  check('a session that delivered no document gets no card', card === undefined, textOf(tree).slice(0, 120))
  // The rest of the panel still works: this is a card that is absent, not a panel
  // that failed to render.
  // The panel itself is still there: a card that is absent is not a panel that
  // failed to render, so the assertion reads the row that is always drawn.
  check('and the rest of the panel is still drawn', firstByClass(tree, 'dsse-top-row') !== undefined, textOf(tree).slice(0, 120))
}

{
  // One delivered document beside five refused ones. The card draws one row, so
  // nothing is hidden and there is nothing to expand. Counting the whole record
  // instead of the delivered rows would see six and offer a badge that reveals
  // nothing -- the same defect the all-refused block cannot see, because a card
  // that is not drawn has no badge in either world.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 1,
      summary: { text: 'wrote one note' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: [
        { path: '/work/note.md', deliverable: true, bytes: 9, mtimeMs: 1, turn: true, address: 'dsh-resource://file/session/session-a/work/note.md' },
        { path: '/work/a.js', deliverable: false, bytes: 1, mtimeMs: 1, turn: true, address: 'dsh-resource://file/session/session-a/work/a.js' },
        { path: '/work/b.js', deliverable: false, bytes: 1, mtimeMs: 1, turn: true, address: 'dsh-resource://file/session/session-a/work/b.js' },
        { path: '/work/c.js', deliverable: false, bytes: 1, mtimeMs: 1, turn: true, address: 'dsh-resource://file/session/session-a/work/c.js' },
        { path: '/work/d.js', deliverable: false, bytes: 1, mtimeMs: 1, turn: true, address: 'dsh-resource://file/session/session-a/work/d.js' },
        { path: '/work/e.js', deliverable: false, bytes: 1, mtimeMs: 1, turn: true, address: 'dsh-resource://file/session/session-a/work/e.js' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  check('one delivered document still draws the card', card !== undefined, textOf(tree).slice(0, 120))
  check('and it draws exactly that one row', byClass(card, 'dsse-row').length === 1, String(byClass(card, 'dsse-row').length))
  // The refused five are named in the head, not counted towards the fold: the
  // badge is about rows behind the fold, and none of these are rows.
  check('the five it refused are named rather than counted', textOf(firstByClass(card, 'dsse-head-note')) === '另有 5 个文件不是交付文档', textOf(firstByClass(card, 'dsse-head-note')))
  check('and a card whose one row fits offers no badge', firstByClass(card, 'dsse-expand') === undefined && firstByClass(card, 'dsse-expand-action') === undefined, textOf(card).slice(0, 160))
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
      files: [{ path: '/work/only.md', deliverable: true, bytes: 12, mtimeMs: 1, address: 'dsh-resource://file/session/session-a/work/only.md' }],
      commands: [],
    },
  }
  const instance = boot({ routes, sidebar: false })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
      files: [{ path: '/work/x.md', deliverable: true, bytes: 5, mtimeMs: 1, address: 'dsh-resource://file/session/session-a/work/x.md' }],
      commands: [],
    },
  }
  const instance = boot({ routes, sidebarThrows: true })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
    { path: '/work/there.md', deliverable: true, bytes: 10, mtimeMs: 100, turn: true, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/there.md' },
    { path: '/work/gone.md', deliverable: true, bytes: null, mtimeMs: null, turn: true, noise: false, status: 'missing', address: 'dsh-resource://file/session/session-a/work/gone.md' },
    { path: '/work/locked.md', deliverable: true, bytes: null, mtimeMs: null, turn: false, noise: false, status: 'invalid', address: 'dsh-resource://file/session/session-a/work/locked.md' },
    { path: '/work/unsure.md', deliverable: true, bytes: null, mtimeMs: null, turn: true, noise: false, status: 'unresolved', address: 'dsh-resource://file/session/session-a/work/unsure.md' },
    { path: '/work/folder', deliverable: true, bytes: null, mtimeMs: null, turn: true, noise: false, status: 'folder', address: 'dsh-resource://file/session/session-a/work/folder' },
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const folded = await instance.renderer.deepRender(instance.seat('cards'))
  // Five rows no longer fit the folded list, and this block is about the states a
  // row can be in rather than about which rows survive folding. Expanding first
  // keeps it from depending on the fold threshold.
  const expand = firstByClass(folded, 'dsse-expand-action')
  check('the fixture offers a way to show every row', typeof expand?.props?.onClick === 'function', String(expand === undefined))
  if (typeof expand?.props?.onClick === 'function') expand.props.onClick()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  const names = byClass(card, 'dsse-name').map((node) => textOf(node))
  const rowOf = (name) => byClass(card, 'dsse-row').find((node) => textOf(node).includes(name))

  check('a deleted file is still listed', names.includes('gone.md'), JSON.stringify(names))
  check('and so is one that cannot be read', names.includes('locked.md'), JSON.stringify(names))
  check('so every row is drawn', byClass(card, 'dsse-row').length === 5, String(byClass(card, 'dsse-row').length))
  check('including the one that cannot be placed', names.includes('unsure.md'), JSON.stringify(names))

  // The state travels on the row, because the dimming and the strike-through are
  // CSS and a mock renderer lays nothing out: asserting the attribute is the only
  // way to know the rule has something to match.
  check('a deleted row says it is deleted', rowOf('gone.md')?.props?.['data-status'] === 'missing', String(rowOf('gone.md')?.props?.['data-status']))
  check('an unreadable row says that instead', rowOf('locked.md')?.props?.['data-status'] === 'invalid', String(rowOf('locked.md')?.props?.['data-status']))
  check('a present row says it is available', rowOf('there.md')?.props?.['data-status'] === 'available', String(rowOf('there.md')?.props?.['data-status']))
  check('a row this build cannot place says so', rowOf('unsure.md')?.props?.['data-status'] === 'unresolved', String(rowOf('unsure.md')?.props?.['data-status']))
  check('a directory is called a directory, not a deletion', rowOf('folder')?.props?.['data-status'] === 'folder', String(rowOf('folder')?.props?.['data-status']))

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
  // Not "已删除": the file may be exactly where the turn left it, and what was
  // lost is the base the record should have carried.
  check('the unplaceable row says it cannot be located', textOf(rowOf('unsure.md')).includes('无法定位'), textOf(rowOf('unsure.md')))
  check('and it does not claim the file was deleted', textOf(rowOf('unsure.md')).includes('已删除') === false, textOf(rowOf('unsure.md')))
  // A folder is a real thing that is really there. The row says which thing it
  // is; it does not borrow the sentence that means "what you wrote is gone".
  check('the folder row says it is a directory', rowOf('folder') !== undefined && textOf(rowOf('folder')).includes('目录'), textOf(rowOf('folder')))
  check('and it does not say the file was deleted', textOf(rowOf('folder')).includes('已删除') === false, textOf(rowOf('folder')))
  // `formatBytes(null)` renders a number, so a folder drawn through the ordinary
  // size path would read "0 B" -- a claim about an empty file.
  check('and it reports no size at all', /\d/.test(textOf(rowOf('folder')).replace('目录', '')) === false, textOf(rowOf('folder')))
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
  check(
    'the unplaceable row explains the record, not the file',
    String(rowOf('unsure.md')?.props?.title ?? '').includes('只存了相对路径') && String(rowOf('unsure.md')?.props?.title ?? '').includes('已删除') === false,
    String(rowOf('unsure.md')?.props?.title),
  )
  check('and it offers no preview to a file it cannot find', firstByClass(rowOf('unsure.md'), 'dsse-row-open') === undefined, String(firstByClass(rowOf('unsure.md'), 'dsse-row-open') !== undefined))
  // Nothing to preview: a directory cannot be opened in the sidebar's file view,
  // and a control that promises it would be the same broken click.
  check('a folder row offers no preview', rowOf('folder') !== undefined && firstByClass(rowOf('folder'), 'dsse-row-open') === undefined, String(firstByClass(rowOf('folder'), 'dsse-row-open') !== undefined))
  check(
    'and its title explains instead of inviting',
    String(rowOf('folder')?.props?.title ?? '').includes('目录') && String(rowOf('folder')?.props?.title ?? '').includes('点击在侧栏预览') === false,
    String(rowOf('folder')?.props?.title),
  )
  check('a present row still invites the click', String(firstByClass(rowOf('there.md'), 'dsse-row-open')?.props?.title ?? '').includes('点击在侧栏预览'), String(firstByClass(rowOf('there.md'), 'dsse-row-open')?.props?.title))
  // The invitation belongs last. The path is what a reader hunts for, and a
  // tooltip that opens with a verb buries it under the one line nobody needs to
  // read twice. A membership check cannot see the order, so this asks where the
  // sentence ends.
  {
    const title = String(firstByClass(rowOf('there.md'), 'dsse-row-open')?.props?.title ?? '')
    check('the invitation is the last line of the tooltip', title.endsWith('点击在侧栏预览'), JSON.stringify(title))
    check('and the path comes before it', title.startsWith('/work/there.md'), JSON.stringify(title))
  }

  const sheet = instance.styles.map((node) => String(node.textContent)).join('\n')
  check('a row that is gone is struck through', /\.dsse-row\[data-status="missing"\][^{]*\.dsse-name\{[^}]*line-through/.test(sheet), '')
  check('the strike-through covers unreadable rows too', /\.dsse-row\[data-status="invalid"\][^{]*\.dsse-name\{[^}]*line-through/.test(sheet), '')
  // Dimmed, not struck through. The strike-through means "this is gone"; this row
  // means "I cannot say", and the two must not be drawn the same way.
  check('an unplaceable row is dimmed', /\.dsse-row\[data-status="unresolved"\][^{]*\.dsse-name\{[^}]*label-tertiary/.test(sheet), '')
  check('and it is not struck through', /\.dsse-row\[data-status="unresolved"\][^{]*\.dsse-name\{[^}]*line-through/.test(sheet) === false, '')
  check('a folder row is dimmed too', /\.dsse-row\[data-status="folder"\][^{]*\.dsse-name\{[^}]*label-tertiary/.test(sheet), '')
  // Never struck through. That line is the claim "this is gone", and it was drawn
  // over a real session's own working directory until this status existed.
  check('and a folder is never struck through', /\.dsse-row\[data-status="folder"\][^{]*\.dsse-name\{[^}]*line-through/.test(sheet) === false, '')
  check('a gone row does not highlight under the pointer', /\.dsse-row\[data-status="missing"\]:hover[^{]*\{background:transparent\}/.test(sheet), '')
  check('and the reason takes the place of the size in italics', /\.dsse-size-gone\{font-style:italic\}/.test(sheet), '')
}

{
  // The sentence the file was handed over with. It is the one field the host
  // supplies that Qoder's rows do not have, and it is the only thing on the card
  // that answers "why is this file here". It goes in the tooltip rather than a
  // second line: rows are 28px and the card can be 168px wide.
  const routes = panelRoutes()
  routes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 2,
      summary: { text: 'handed over two documents' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: [
        { path: '/work/plan.md', deliverable: true, bytes: 40, mtimeMs: 2, turn: true, status: 'available', description: '定稿方案：对照四份实现后的施工版', address: 'dsh-resource://file/session/session-a/work/plan.md' },
        { path: '/work/shot.png', deliverable: true, bytes: 90, mtimeMs: 1, turn: true, status: 'available', description: '', address: 'dsh-resource://file/session/session-a/work/shot.png' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  const rowOf = (name) => byClass(card, 'dsse-row').find((node) => textOf(node).includes(name))
  const titleOf = (name) => String(rowOf(name)?.props?.title ?? '')

  check('the sentence the file was handed over with is on the row', titleOf('plan.md').includes('定稿方案：对照四份实现后的施工版'), JSON.stringify(titleOf('plan.md')))
  // The invitation lives on the opener, not on the row: the row is the whole
  // line and the opener is the part that promises the click.
  const openerOf = (name) => String(firstByClass(rowOf(name), 'dsse-row-open')?.props?.title ?? '')
  check('and the sentence sits between the path and the invitation', openerOf('plan.md') === '/work/plan.md\n定稿方案：对照四份实现后的施工版\n点击在侧栏预览', JSON.stringify(openerOf('plan.md')))
  check('a file handed over without a sentence says nothing extra', titleOf('shot.png').includes('定稿方案') === false, JSON.stringify(titleOf('shot.png')))
  check('and its tooltip is still the path and the invitation', openerOf('shot.png') === '/work/shot.png\n点击在侧栏预览', JSON.stringify(openerOf('shot.png')))
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
      files: [{ path: '/work/old.md', deliverable: true, bytes: 9, mtimeMs: 1, turn: true, address: 'dsh-resource://file/session/session-a/work/old.md' }],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
    { path: '/work/a.md', deliverable: true, bytes: 1, mtimeMs: 1, turn: true, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/a.md' },
    { path: '/work/b.md', deliverable: true, bytes: 1, mtimeMs: 1, turn: true, noise: false, status: 'missing', address: 'dsh-resource://file/session/session-a/work/b.md' },
    { path: '/work/c.md', deliverable: true, bytes: 1, mtimeMs: 1, turn: false, noise: false, status: 'invalid', address: 'dsh-resource://file/session/session-a/work/c.md' },
    { path: '/work/d.md', deliverable: true, bytes: 1, mtimeMs: 1, turn: false, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/d.md' },
    { path: '/work/e.md', deliverable: true, bytes: 1, mtimeMs: 1, turn: false, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/e.md' },
    { path: '/work/f.md', deliverable: true, bytes: 1, mtimeMs: 1, turn: false, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/f.md' },
    { path: '/work/node_modules/g.js', deliverable: false, bytes: 1, mtimeMs: 1, turn: false, noise: true, status: 'available', address: 'dsh-resource://file/session/session-a/work/node_modules/g.js' },
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
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  const meta = textOf(firstByClass(card, 'dsse-head-stats'))
  const note = textOf(firstByClass(card, 'dsse-head-note'))
  const badge = firstByClass(card, 'dsse-expand-action')

  // The one arithmetic the card has to get right: what the header claims was
  // produced must equal what is on screen plus what the badge says is missing.
  // Two independent counts that never get added up are exactly how a card can say
  // "7 个文件" over a list of four with no way to see the rest.
  // The header states itself in two parts now — the bold count and the quiet
  // remainder — so this adds both before comparing. That is the reader's own
  // arithmetic, and stating the remainder is only worth doing if it closes.
  const written = Number((meta.match(/(\d+) 个文件/u) ?? [])[1]) + Number((note.match(/另有 (\d+) 个生成文件/u) ?? [])[1] ?? 0)
  const shown = byClass(card, 'dsse-name').length
  const missing = Number((String(badge?.props?.['aria-label'] ?? '').match(/(\d+) 个/u) ?? [])[1])
  check('the header, the rows and the badge add up', written === shown + missing, `${meta} ${note} / shown ${String(shown)} / badge ${String(badge?.props?.['aria-label'])}`)
  // Six documents were delivered and one row is a source file: the header names
  // six, and the note names the one it did not draw. Seven was the old total,
  // back when the card counted every file the session touched.
  check('and the filtered row is named but not counted', written === 6, `${meta} ${note} / ${String(badge?.props?.['aria-label'])}`)
  // The fold shows four rows; the badge names the remainder, not the whole list,
  // because the header already names the whole list. Two numbers that each name
  // the total leave the reader to subtract.
  check('the folded card draws four rows', shown === 4, String(shown))
  // Four of the six are on screen and the fifth row (c.md) is not: the badge
  // counts rows the reader cannot see, and the filtered one was never a row.
  check('and the badge names only what is left over', missing === 2, String(missing))
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
        { path: '/work/notes.md', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' },
        { path: '/work/page.html', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://b' },
        { path: '/work/costs.xlsx', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://c' },
        { path: '/work/deck.pptx', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://d' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))

  const docRow = rowNamed(tree, 'notes.md')
  const markupRow = rowNamed(tree, 'page.html')
  const sheetRow = rowNamed(tree, 'costs.xlsx')
  const slideRow = rowNamed(tree, 'deck.pptx')

  check('a file row carries a glyph', docRow !== undefined && iconOf(docRow) !== undefined, String(iconOf(docRow)))
  // Each bucket is a different outline, not a different mark on one page. The
  // assertions name the stroke that only that bucket draws — a single shared
  // silhouette would produce identical arrays and fail all four.
  check('prose is marked with ruled lines', bucketOf(docRow) === 'doc' && markOf(docRow).includes('M5 3.5h14v17H5zM8.5 8h7'), markOf(docRow))
  check('a page is marked as markup', bucketOf(markupRow) === 'markup' && markOf(markupRow).includes('M9.5 4.5L3.5 12l6 7.5'), markOf(markupRow))
  check('a spreadsheet is marked as a grid', bucketOf(sheetRow) === 'sheet' && markOf(sheetRow).includes('M3.5 5h17v14h-17zM3.5 10h17'), markOf(sheetRow))
  check('a deck is marked as a screen', bucketOf(slideRow) === 'slide' && markOf(slideRow).includes('M12 16.5v3'), markOf(slideRow))
  check('the four marks are not all the same', new Set([markOf(docRow), markOf(markupRow), markOf(sheetRow), markOf(slideRow)]).size === 4, 'marks collapsed together')

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
  check('a spreadsheet is tinted', ruleFor('sheet').includes('#2f8a72'), ruleFor('sheet'))
  check('the five tints are five different colours', (() => {
    const values = ['markup', 'sheet', 'image', 'slide', 'video']
      .map((bucket) => (/color:(#[0-9a-f]{6})/u.exec(ruleFor(bucket)) ?? [])[1])
    return values.every((value) => typeof value === 'string') && new Set(values).size === 5
  })(), ['markup', 'sheet', 'image', 'slide', 'video'].map(ruleFor).join(' | '))
  // The two buckets that make no claim about the document keep the neutral grey: a
  // card of six rows should not be six colours deep.
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
        { path: '/work/notes.md', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' },
        { path: '/work/shot.png', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://b' },
        { path: '/work/demo.mp4', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://c' },
        { path: '/work/Makefile.qqq', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://d' },
        { path: '/work/report.pdf', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://e' },
        { path: '/work/page.html', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://f' },
        { path: '/work/costs.xlsx', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://g' },
        { path: '/work/deck.pptx', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://h' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))

  const docRow = rowNamed(tree, 'notes.md')
  const imageRow = rowNamed(tree, 'shot.png')
  const videoRow = rowNamed(tree, 'demo.mp4')
  const unknownRow = rowNamed(tree, 'Makefile.qqq')

  const marksOf = (row) => JSON.stringify(iconOf(row)?.props?.children ?? [])
  const bucketOf = (row) => iconOf(row)?.props?.['data-bucket']

  check('prose is marked as a document', bucketOf(docRow) === 'doc' && marksOf(docRow).includes('M5 3.5h14v17H5z'), marksOf(docRow))
  check('a picture is marked with a picture', bucketOf(imageRow) === 'image' && marksOf(imageRow).includes('"circle"'), marksOf(imageRow))
  check('a recording is marked with a play mark', bucketOf(videoRow) === 'video' && marksOf(videoRow).includes('M10.2 9.4l4.6 2.6'), marksOf(videoRow))
  // The blank page is the point: an unknown extension must produce the page outline
  // and nothing else, because a wrong mark tells the reader something false about a
  // file they wrote. The page and its fold are one path here, not two.
  const unknownMarks = iconOf(unknownRow)?.props?.children
  check('an extension nobody knows gets the blank page', Array.isArray(unknownMarks) && unknownMarks.length === 1, JSON.stringify(unknownMarks))
  check('and that page is the one outline that claims nothing', bucketOf(unknownRow) === 'file' && marksOf(unknownRow).includes('M5 3.5h10l4 4v13H5zM15 3.5v4h4'), marksOf(unknownRow))
  // Seven buckets, seven outlines, and no bucket borrowing another's shape. Three
  // are read from this block's rows and four from the block above; every one is
  // named across the two blocks so a fallback to the generic page cannot pass
  // unnoticed.
  check('the four buckets here are four different shapes', new Set([marksOf(docRow), marksOf(imageRow), marksOf(videoRow), marksOf(unknownRow)]).size === 4, [marksOf(docRow), marksOf(imageRow), marksOf(videoRow), marksOf(unknownRow)].join(' | '))
  // The coverage assertion. Every suffix the delivery whitelist accepts has to land
  // on a bucket that is not the blank page — the bug this block was written for was
  // exactly six whitelisted suffixes falling through to it (xlsx, xlsm, ppt, pptx,
  // mp4, webm). Reading the whitelist from `api.js` and the buckets from the
  // rendered rows would need the whole pipeline; naming the list here is enough,
  // because a suffix added to one table and not the other now fails this line.
  const WHITELIST = ['pdf', 'doc', 'docx', 'md', 'markdown', 'txt', 'xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ppt', 'pptx', 'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm']
  const bucketForSuffix = {
    pdf: 'doc', doc: 'doc', docx: 'doc', md: 'doc', markdown: 'doc', txt: 'doc',
    xls: 'sheet', xlsx: 'sheet', xlsm: 'sheet', csv: 'sheet', tsv: 'sheet',
    ppt: 'slide', pptx: 'slide',
    html: 'markup', htm: 'markup',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
    mp4: 'video', webm: 'video',
  }
  check('every delivered suffix has a bucket', WHITELIST.every((suffix) => typeof bucketForSuffix[suffix] === 'string' && bucketForSuffix[suffix] !== 'file'), WHITELIST.filter((suffix) => bucketForSuffix[suffix] === undefined).join(','))
  check('and no bucket is claimed by a suffix the card would refuse', Object.keys(bucketForSuffix).every((suffix) => WHITELIST.includes(suffix)), Object.keys(bucketForSuffix).filter((suffix) => WHITELIST.includes(suffix) === false).join(','))
  // The card has to draw each of those buckets with a different outline, or the
  // mapping above is a table with no effect. Rendered one row per bucket.
  const bucketRows = [
    { path: '/work/x.pdf', deliverable: true, bytes: 1, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://p' },
    { path: '/work/x.csv', deliverable: true, bytes: 1, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://q' },
    { path: '/work/x.ppt', deliverable: true, bytes: 1, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://r' },
    { path: '/work/x.htm', deliverable: true, bytes: 1, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://s' },
    { path: '/work/x.svg', deliverable: true, bytes: 1, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://t' },
    { path: '/work/x.webm', deliverable: true, bytes: 1, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://u' },
  ]
  const coverageRoutes = panelRoutes()
  coverageRoutes['/api/ui-evolve/panel'] = {
    ok: true,
    data: {
      turn: 1, calls: 1, failed: 0, turnFiles: 6,
      summary: { text: 'delivered six documents' },
      pendingCandidates: 0,
      skills: { available: true, skills: [] },
      mcp: [],
      files: bucketRows,
      commands: [],
    },
  }
  const coverageInstance = boot({ routes: coverageRoutes })
  coverageInstance.module.apply(coverageInstance.ctx)
  pressToggle(firstByClass(await coverageInstance.renderer.render(coverageInstance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  // Six rows over a fold of four, so the card has to be opened before every bucket
  // is on screen. Reading it folded would assert the first four and call it coverage.
  const coverageBadge = firstByClass(await coverageInstance.renderer.deepRender(coverageInstance.seat('cards')), 'dsse-expand-action')
  if (typeof coverageBadge?.props?.onClick === 'function') coverageBadge.props.onClick()
  const coverageTree = await coverageInstance.renderer.deepRender(coverageInstance.seat('cards'))
  const drawn = byClass(coverageTree, 'dsse-row').map((row) => iconOf(row)?.props?.['data-bucket'])
  check('and each of them is drawn with its own outline', JSON.stringify(drawn) === JSON.stringify(['doc', 'sheet', 'slide', 'markup', 'image', 'video']), JSON.stringify(drawn))
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
        { path: '/work/src/lib/inner.ts', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' },
        { path: '/work/top.md', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://b' },
        { path: '/work/deep/a/b/c/d.ts', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://c' },
        { path: '/elsewhere/x/y/z/e.ts', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://d' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
      files: [{ path: '/work/src/lib/inner.ts', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' }],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
        { path: 'c:\\Work\\src\\a.ts', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' },
        { path: 'C:\\WORK\\b.md', deliverable: true, bytes: 10, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://b' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
        { path: 'C:\\work\\test8\\code.py', deliverable: true, bytes: 1314, mtimeMs: 1, turn: true, status: 'available', address: 'dsh-resource://a' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
        { path: '/work/a.md', deliverable: true, bytes: 1, mtimeMs: 1, turn: true, noise: false, address: 'dsh-resource://file/session/session-a/work/a.md' },
        { path: '/work/b.md', deliverable: true, bytes: 1, mtimeMs: 1, turn: false, noise: false, address: 'dsh-resource://file/session/session-a/work/b.md' },
        { path: '/work/c.md', deliverable: true, bytes: 1, mtimeMs: 1, turn: false, noise: false, address: 'dsh-resource://file/session/session-a/work/c.md' },
      ],
      commands: [],
    },
  }
  const instance = boot({ routes })
  instance.module.apply(instance.ctx)
  pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
  check('a card that hides nothing offers no remainder', firstByClass(card, 'dsse-expand-action') === undefined, String(textOf(card).slice(0, 80)))
  check('and its header still names the total', textOf(firstByClass(card, 'dsse-head-stats')).includes('3 个文件'), textOf(firstByClass(card, 'dsse-head-stats')))
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
    { path: 'F:\\work\\src\\inside.ts', deliverable: true, bytes: 10, mtimeMs: 100, turn: true, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/src/inside.ts' },
    { path: 'F:\\elsewhere\\outside.ts', deliverable: true, bytes: 20, mtimeMs: 200, turn: true, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/elsewhere/outside.ts' },
    // Spelled by a different part of the Host than the workspace was, in the
    // other case. On Windows this is the same directory, so the row is inside
    // and both buttons must exist.
    { path: 'f:\\WORK\\Src\\Cased.ts', deliverable: true, bytes: 30, mtimeMs: 300, turn: true, noise: false, status: 'available', address: 'dsh-resource://file/session/session-a/work/Src/Cased.ts' },
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
    pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
    const tree = await instance.renderer.deepRender(instance.seat('cards'))
    const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const rowOf = (name) => byClass(card, 'dsse-row').find((node) => textOf(node).includes(name))
    return { instance, tree, card, rowOf }
  }

  // Getting at a node that may not be there.
  //
  // Reading `byClass(...)[0].props.onClick` throws when the node is absent, and a
  // throw exits the suite before its tally line -- which the mutation runner
  // reports as CRASHED, a different verdict from the KILLED these assertions exist
  // to produce. A missing node has to read as one red assertion, so every press
  // below goes through these two. They live out here, at the level the fixtures
  // share, because the blocks that use them are siblings rather than nested.
  const nodeOf = (tree, className, index = 0) => {
    if (tree === undefined || tree === null) return undefined
    return byClass(tree, className)[index]
  }

  const press = (tree, className, index = 0) => {
    const found = nodeOf(tree, className, index)
    if (found === undefined || typeof found.props?.onClick !== 'function') {
      check(`a ${className} to press`, false, `no ${className} at ${index}`)
      return false
    }
    found.props.onClick()
    return true
  }

  // The Host that has no clipboard: nothing is drawn, and the row must not have
  // made room for a control it did not draw. `data-actions="false"` is what keeps
  // the hover rule from hiding the size to make room for nothing at all.
  {
    const { card, rowOf } = await open({ routes: routesFor() })
    check('a host without a clipboard draws no copy button', byClass(card, 'dsse-row-copy').length === 0, String(byClass(card, 'dsse-row-copy').length))
    check('and the row does not claim to have actions', rowOf('inside.ts')?.props?.['data-actions'] === 'false', String(rowOf('inside.ts')?.props?.['data-actions']))
    check('and there is no menu to open', byClass(card, 'dsse-row-menu').length === 0, String(byClass(card, 'dsse-row-menu').length))
  }

  // A Host that does have one: a single control per row, and the menu behind it.
  {
    const written = []
    const navigator = { clipboard: { writeText: (value) => { written.push(value); return Promise.resolve() } } }
    const { card, rowOf, instance } = await open({ routes: routesFor(), navigator })
    // Every assertion below reads the tree it was rendered with. The renderer keeps
    // hook state, so a menu opens on one render and is closed on the next; reaching
    // into the tree from before a click is how these tests go quietly stale.
    const redraw = () => instance.renderer.deepRender(instance.seat('cards'))
    const cardOf = (tree) => byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const rowIn = (tree, name) => byClass(cardOf(tree), 'dsse-row').find((node) => textOf(node).includes(name))
    const menuIn = (tree, name) => byClass(cardOf(tree), 'dsse-row-menu').find((node) => String(node.props?.['aria-label'] ?? '').includes(name))
    const listenersNow = () => instance.listeners.filter((row) => row.type === 'mousedown' || row.type === 'keydown')

    const inside = rowIn(await redraw(), 'inside.ts')
    const buttons = byClass(inside, 'dsse-row-copy')
    check('the row renders a control to open its menu', buttons.length > 0, String(buttons.length))
    check('a host with a clipboard draws one control per row', buttons.length === 1, String(buttons.length))
    check('and the row says it has actions', inside?.props?.['data-actions'] === 'true', String(inside?.props?.['data-actions']))
    // The control is a sibling of the opener, not a child: nesting one button in
    // another is invalid HTML, and the inner one becomes unreachable by keyboard.
    check('the opener and the actions are siblings', byClass(inside, 'dsse-row-actions').length === 1 && byClass(inside, 'dsse-row-open').length === 1, JSON.stringify([byClass(inside, 'dsse-row-actions').length, byClass(inside, 'dsse-row-open').length]))
    check('and the row itself is not a click target', inside?.props?.onClick === undefined && inside?.props?.type === undefined, JSON.stringify([typeof inside?.props?.onClick, String(inside?.props?.type)]))
    check('and the control lives in the actions block', byClass(firstByClass(inside, 'dsse-row-actions'), 'dsse-row-copy').length === 1, String(byClass(firstByClass(inside, 'dsse-row-actions'), 'dsse-row-copy').length))
    check('and the opener does not contain it', byClass(firstByClass(inside, 'dsse-row-open'), 'dsse-row-copy').length === 0, String(byClass(firstByClass(inside, 'dsse-row-open'), 'dsse-row-copy').length))
    check('the menu starts closed', byClass(cardOf(await redraw()), 'dsse-row-menu').length === 0, String(byClass(cardOf(await redraw()), 'dsse-row-menu').length))
    check('and the control says so', buttons[0]?.props?.['aria-expanded'] === 'false', String(buttons[0]?.props?.['aria-expanded']))
    check('and the control names what it does', String(buttons[0]?.props?.['aria-label'] ?? '') === '复制路径', String(buttons[0]?.props?.['aria-label']))
    // Nothing is listening until something is open. A permanent global handler for
    // a control that is usually closed is a cost every Host surface would pay.
    check('nothing listens while the menu is closed', listenersNow().length === 0, JSON.stringify(listenersNow().map((row) => row.type)))

    // Opening it. Guarded for the same reason as the handle above: a missing
    // control has to fail here rather than take the rest of the file with it.
    if (buttons.length > 0 && typeof buttons[0].props?.onClick === 'function') buttons[0].props.onClick()
    const opened = await redraw()
    const openedRow = rowIn(opened, 'inside.ts')
    const openedMenu = menuIn(opened, 'inside.ts')
    check('pressing the control opens its menu', openedMenu !== undefined, 'no menu')
    check('and the control says it is open', nodeOf(openedRow, 'dsse-row-copy', 0)?.props?.['aria-expanded'] === 'true', String(nodeOf(openedRow, 'dsse-row-copy', 0)?.props?.['aria-expanded']))
    // The row carries the open state so the reveal rules can keep the control on
    // screen while the pointer travels down to the menu it just opened.
    check('and the row knows its menu is open', openedRow?.props?.['data-menu'] === 'true', String(openedRow?.props?.['data-menu']))
    check('the menu declares what it is', openedMenu?.props?.role === 'group', String(openedMenu?.props?.role))
    // A child of the row would be a second flex line, which moves the row's middle
    // and takes the control with it. It has to be a sibling.
    check('and the menu is not inside the row', byClass(openedRow, 'dsse-row-menu').length === 0, String(byClass(openedRow, 'dsse-row-menu').length))
    const items = byClass(openedMenu, 'dsse-row-menuitem')
    check('the menu offers both paths', items.length === 2, String(items.length))
    // The label is the whole item. An earlier version printed the path next to
    // it; a long path can only be truncated there, and a truncated path says
    // less about what will be copied than the two words do.
    check('and the first names the absolute route', textOf(items[0]) === '绝对路径', textOf(items[0]))
    check('and the second names the relative route', textOf(items[1]) === '相对路径', textOf(items[1]))
    // The path is not on screen, but it is still what lands on the clipboard --
    // that is the half of the contract the label cannot show.
    check('and neither item prints a path', items.every((item) => textOf(item).includes('\\') === false && textOf(item).includes('/') === false), JSON.stringify(items.map(textOf)))
    check('opening a menu adds both listeners', listenersNow().length === 2, JSON.stringify(listenersNow().map((row) => row.type)))

    // Escape closes it, and takes the listeners with it.
    const escape = listenersNow().find((row) => row.type === 'keydown')
    if (escape === undefined) {
      check('escape closes the menu', false, 'no keydown listener')
    } else {
      escape.handler({ key: 'Escape' })
      const escaped = await redraw()
      check('escape closes the menu', menuIn(escaped, 'inside.ts') === undefined, 'menu still open')
      check('and the row stops claiming to be open', rowIn(escaped, 'inside.ts')?.props?.['data-menu'] === 'false', String(rowIn(escaped, 'inside.ts')?.props?.['data-menu']))
      check('and nothing is left listening', listenersNow().length === 0, JSON.stringify(listenersNow().map((row) => row.type)))
    }

    // A press anywhere else closes it. `mousedown` rather than `click`: a drag
    // that starts outside must not count as having been inside.
    press(rowIn(await redraw(), 'inside.ts'), 'dsse-row-copy', 0)
    await redraw()
    const outside = listenersNow().find((row) => row.type === 'mousedown')
    if (outside === undefined) {
      check('a press outside closes the menu', false, 'no mousedown listener')
    } else {
      outside.handler({ target: { dataset: {} } })
      const closed = await redraw()
      check('a press outside closes the menu', menuIn(closed, 'inside.ts') === undefined, 'menu still open')
    }

    // Pressing the control itself is not "outside": that gesture has to be able to
    // close what it opened, and treating it as outside would close and reopen on
    // the same press.
    press(rowIn(await redraw(), 'inside.ts'), 'dsse-row-copy', 0)
    await redraw()
    const pressOnButton = listenersNow().find((row) => row.type === 'mousedown')
    if (pressOnButton === undefined) {
      check('a press on the control does not close the menu twice', false, 'no mousedown listener')
    } else {
      pressOnButton.handler({ target: { dataset: { dsseCopy: 'true' } } })
      check('a press on the control does not close the menu twice', menuIn(await redraw(), 'inside.ts') !== undefined, 'menu closed')
    }
    // Pressing it again is the second way to close, and the one a pointer user
    // reaches for first.
    press(rowIn(await redraw(), 'inside.ts'), 'dsse-row-copy', 0)
    check('pressing the control again closes it', menuIn(await redraw(), 'inside.ts') === undefined, 'menu still open')

    // A file outside the workspace has no workspace-relative name. Copying one
    // would be copying `..` segments no build ever wrote, so that entry is absent
    // instead of being wrong -- and the row still counts as having an action.
    const outsideRow = rowIn(await redraw(), 'outside.ts')
    check('a file outside the workspace still has one control', byClass(outsideRow, 'dsse-row-copy').length === 1, String(byClass(outsideRow, 'dsse-row-copy').length))
    check('and the row still says it has an action', outsideRow?.props?.['data-actions'] === 'true', String(outsideRow?.props?.['data-actions']))
    press(outsideRow, 'dsse-row-copy', 0)
    const outsideMenu = menuIn(await redraw(), 'outside.ts')
    check('and its menu offers only the absolute path', byClass(outsideMenu, 'dsse-row-menuitem').length === 1, String(byClass(outsideMenu, 'dsse-row-menuitem')?.length))
    press(outsideMenu, 'dsse-row-menuitem', 0)
    await redraw()
    check('and copying it writes the absolute path', written[written.length - 1] === 'F:\\elsewhere\\outside.ts', JSON.stringify(written[written.length - 1]))

    // The workspace is `F:\work` and this file is recorded as `f:\WORK\Src\Cased.ts`.
    // Windows resolves both to the same directory and the two spellings come from
    // different parts of the Host, so the comparison cannot care about case. Only
    // the middle segment differs here, so a fixture that only exercised the drive
    // letter would pass even if the whole relative path came back lowercased.
    const casedRow = rowIn(await redraw(), 'Cased.ts')
    press(casedRow, 'dsse-row-copy', 0)
    const casedMenu = menuIn(await redraw(), 'Cased.ts')
    const casedItems = byClass(casedMenu, 'dsse-row-menuitem')
    if (casedItems.length === 2) {
      check('a file spelled in another case is still inside the workspace', casedItems.length === 2, String(casedItems.length))
      casedItems[1].props.onClick()
      await redraw()
      check('and its relative path is cut at the workspace root', written[written.length - 1] === 'Src/Cased.ts', JSON.stringify(written[written.length - 1]))
    } else {
      // A failed check, not a throw: a throw leaves no tally line and the mutation
      // runner reports CRASHED, which is a different verdict from the KILLED this
      // assertion exists to produce.
      check('a file spelled in another case is still inside the workspace', false, String(casedItems.length))
      check('and its relative path is cut at the workspace root', false, 'no relative entry to press')
    }

    // Copying answers on the control that was pressed: it is the only surface in
    // this panel a confirmation can appear on.
    press(rowIn(await redraw(), 'inside.ts'), 'dsse-row-copy', 0)
    const chosen = menuIn(await redraw(), 'inside.ts')
    press(chosen, 'dsse-row-menuitem', 0)
    const answered = await redraw()
    check('pressing a menu entry writes its path', written[written.length - 1] === 'F:\\work\\src\\inside.ts', JSON.stringify(written[written.length - 1]))
    check('and the menu closes behind the choice', menuIn(answered, 'inside.ts') === undefined, 'menu still open')
    const answeredButton = nodeOf(rowIn(answered, 'inside.ts'), 'dsse-row-copy', 0)
    // Colour is the visible answer and the name is the announced one; neither
    // alone reaches both kinds of reader.
    check('and the control reports success', answeredButton?.props?.['data-ok'] === 'true', String(answeredButton?.props?.['data-ok']))
    check('and a screen reader hears it', String(answeredButton?.props?.['aria-label'] ?? '') === '已复制路径', String(answeredButton?.props?.['aria-label']))
    // The tooltip is the second surface the answer appears on, and it carries the
    // reason when there is one -- a reader who hovers to ask "did that work?" gets
    // told without having to move to the menu again. Nothing checked either string
    // before, so both could have been swapped or blanked in silence.
    check('and the tooltip says what happened', answeredButton?.props?.title === '已复制', String(answeredButton?.props?.title))
    const neighbour = nodeOf(rowIn(answered, 'Cased.ts'), 'dsse-row-copy', 0)
    check('while an untouched row keeps its name', String(neighbour?.props?.['aria-label'] ?? '') === '复制路径', String(neighbour?.props?.['aria-label']))
    check('and an untouched row keeps the instruction', neighbour?.props?.title === '复制路径', String(neighbour?.props?.title))

    // The relative entry writes a forward-slash path: backslashes are a Windows
    // path, not a path in source code.
    press(rowIn(await redraw(), 'inside.ts'), 'dsse-row-copy', 0)
    const relativeMenu = menuIn(await redraw(), 'inside.ts')
    const relativeItems = relativeMenu === undefined ? [] : byClass(relativeMenu, 'dsse-row-menuitem')
    // Length first. Reaching into `[1]` of a menu that never opened throws, and a
    // throw exits the suite before the tally line -- which the mutation runner
    // reports as CRASHED, a different verdict from the KILLED this is meant to give.
    if (relativeItems.length === 2) {
      relativeItems[1].props.onClick()
      await redraw()
      check('the relative entry writes the workspace-relative path', written[written.length - 1] === 'src/inside.ts', JSON.stringify(written[written.length - 1]))
    } else {
      check('the relative entry writes the workspace-relative path', false, `${relativeItems.length} entries in the menu`)
    }

    // The confirmation is a flash, not a state: 1.5 seconds later the control is
    // back to its resting name. Asserting the delay is what separates a flash from
    // a control that permanently claims to have copied something.
    const pending = instance.timers.filter((entry) => entry.ms === 1500 && entry.cleared === false)
    // Exactly one. Two presses must leave one timer, and `> 0` cannot tell that
    // apart from the leak this is here to catch.
    check('the confirmation is scheduled to clear', pending.length === 1, String(pending.length))
    for (const entry of pending) entry.fn()
    const cleared = await redraw()
    const clearedButton = nodeOf(rowIn(cleared, 'inside.ts'), 'dsse-row-copy', 0)
    check('and it does clear, back to the resting name', String(clearedButton?.props?.['aria-label'] ?? '') === '复制路径', String(clearedButton?.props?.['aria-label']))
    check('and drops the outcome colour', clearedButton?.props?.['data-ok'] === undefined, String(clearedButton?.props?.['data-ok']))
  }

  // A timer scheduled on a ref is invisible: it is not in the rendered tree, and
  // no cleanup the panel already has would notice it. Unmounting while the flash is
  // pending has to cancel it, or the callback writes state into a component that is
  // gone and the Host keeps a timer for a panel nobody is looking at.
  //
  // Its own instance: unmounting is terminal for the renderer, so it cannot share a
  // fixture with assertions that still want to render.
  {
    // `writeText` returning nothing settles synchronously, which is the only way to
    // see the timer before the microtask a resolved promise would need.
    const kept = { clipboard: { writeText: () => undefined } }
    const own = await open({ routes: routesFor(), navigator: kept })
    press(own.rowOf('inside.ts'), 'dsse-row-copy', 0)
    // Redrawn, not reused: `card` is the tree from before the click, and the menu
    // only exists in the tree after it.
    const openedForTimer = await own.instance.renderer.deepRender(own.instance.seat('cards'))
    const timerCard = byClass(openedForTimer, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    press(nodeOf(timerCard, 'dsse-row-menu', 0), 'dsse-row-menuitem', 0)
    const scheduled = own.instance.timers.filter((entry) => entry.ms === 1500 && entry.cleared === false)
    check('the flash leaves one timer pending', scheduled.length === 1, String(scheduled.length))
    own.instance.renderer.unmount()
    check('and closing the panel cancels the flash timer', scheduled.every((entry) => entry.cleared === true), JSON.stringify(scheduled.map((entry) => entry.cleared)))
  }

  // A write that throws, and a write that rejects. Both mean the same thing to the
  // person who pressed the entry, and neither may be reported as success.
  {
    const throwing = { clipboard: { writeText: () => { throw new Error('denied') } } }
    const first = await open({ routes: routesFor(), navigator: throwing })
    press(first.rowOf('inside.ts'), 'dsse-row-copy', 0)
    const openTree = await first.instance.renderer.deepRender(first.instance.seat('cards'))
    const openCard = byClass(openTree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    press(nodeOf(openCard, 'dsse-row-menu', 0), 'dsse-row-menuitem', 0)
    const afterThrow = await first.instance.renderer.deepRender(first.instance.seat('cards'))
    const throwCard = byClass(afterThrow, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const throwRow = byClass(throwCard, 'dsse-row').find((node) => textOf(node).includes('inside.ts'))
    const throwButton = nodeOf(throwRow, 'dsse-row-copy', 0)
    check('a clipboard that throws is not reported as success', throwButton?.props?.['data-ok'] === 'false', String(throwButton?.props?.['data-ok']))
    check('and the tooltip says why', String(throwButton?.props?.title ?? '').includes('复制失败'), String(throwButton?.props?.title))
    check('and a screen reader hears the failure', String(throwButton?.props?.['aria-label'] ?? '') === '复制路径失败', String(throwButton?.props?.['aria-label']))

    const rejecting = { clipboard: { writeText: () => Promise.reject(new Error('denied')) } }
    const second = await open({ routes: routesFor(), navigator: rejecting })
    press(second.rowOf('inside.ts'), 'dsse-row-copy', 0)
    const rejectOpen = await second.instance.renderer.deepRender(second.instance.seat('cards'))
    const rejectOpenCard = byClass(rejectOpen, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    press(nodeOf(rejectOpenCard, 'dsse-row-menu', 0), 'dsse-row-menuitem', 0)
    // A rejected promise settles on a microtask, and the renderer drains those
    // between rounds -- so the failure is on screen by the next deep render.
    const afterReject = await second.instance.renderer.deepRender(second.instance.seat('cards'))
    const rejectCard = byClass(afterReject, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const rejectRow = byClass(rejectCard, 'dsse-row').find((node) => textOf(node).includes('inside.ts'))
    check('a rejected write is not reported as success either', nodeOf(rejectRow, 'dsse-row-copy', 0)?.props?.['data-ok'] === 'false', String(nodeOf(rejectRow, 'dsse-row-copy', 0)?.props?.['data-ok']))
  }

  // A stub is allowed to return nothing at all, and that has to mean the same as a
  // resolved promise. The harness's own clipboard double is written by hand, so
  // this is the shape a future fixture is most likely to have -- treating it as a
  // failure would make a working clipboard look broken in exactly the tests that
  // fake it.
  {
    const silent = { clipboard: { writeText: () => undefined } }
    const { instance, rowOf } = await open({ routes: routesFor(), navigator: silent })
    press(rowOf('inside.ts'), 'dsse-row-copy', 0)
    const silentCard = byClass(await instance.renderer.deepRender(instance.seat('cards')), 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    press(nodeOf(silentCard, 'dsse-row-menu', 0), 'dsse-row-menuitem', 0)
    const tree = await instance.renderer.deepRender(instance.seat('cards'))
    const card2 = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const row = byClass(card2, 'dsse-row').find((node) => textOf(node).includes('inside.ts'))
    check('a clipboard that returns nothing counts as success', nodeOf(row, 'dsse-row-copy', 0)?.props?.['data-ok'] === 'true', String(nodeOf(row, 'dsse-row-copy', 0)?.props?.['data-ok']))
  }

  // Copying on a file that is gone: the row still names the file, and the path it
  // would copy is still the path it used to have, so the control stays. What must
  // not happen is an opener appearing beside it.
  {
    const goneRows = [{ path: 'F:\\work\\gone.ts', deliverable: true, bytes: null, mtimeMs: null, turn: true, noise: false, status: 'missing', address: 'dsh-resource://file/session/session-a/work/gone.ts' }]
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
    pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
    const tree = await instance.renderer.deepRender(instance.seat('cards'))
    const card = byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    check('a gone file still offers its path', byClass(card, 'dsse-row-copy').length === 1, String(byClass(card, 'dsse-row-copy').length))
    check('and still offers no way to open it', firstByClass(card, 'dsse-row-open') === undefined, 'opener present')
    press(card, 'dsse-row-copy', 0)
    const goneMenu = await instance.renderer.deepRender(instance.seat('cards'))
    const goneCard = byClass(goneMenu, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    check('and its menu still offers both routes', byClass(nodeOf(goneCard, 'dsse-row-menu', 0), 'dsse-row-menuitem').length === 2, String(byClass(nodeOf(goneCard, 'dsse-row-menu', 0), 'dsse-row-menuitem').length))
    press(nodeOf(goneCard, 'dsse-row-menu', 0), 'dsse-row-menuitem', 0)
    await instance.renderer.deepRender(instance.seat('cards'))
    check('copying a gone path writes the path it had', written[written.length - 1] === 'F:\\work\\gone.ts', JSON.stringify(written))
  }

  // The layout promise. The control is absolutely positioned over the size rather
  // than laid out beside it, and the size keeps its slot when hidden, so a name
  // does not change width when the pointer arrives. The mock renderer lays nothing
  // out, so the sheet is the only place this can be asserted.
  {
    const instance = boot({ routes: routesFor() })
    // The sheet is written when the panel renders, not when the bundle is evaluated
    // or the plugin is applied: a boot with no render has an empty style list, and
    // every rule below would then be a regex against nothing.
    instance.module.apply(instance.ctx)
    pressToggle(firstByClass(await instance.renderer.render(instance.seat('toggle'), { sessionId: 'session-a' }), 'dsse-toggle'))
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
    // The selector is half of it: a rule that matches and then sets opacity:0 would
    // never show a control, and every check above would still pass.
    check('and the reveal sets the actions visible', /\.dsse-row\[data-actions="true"\]:hover \.dsse-row-actions[^{]*\{[^}]*opacity:1/.test(sheet), '')
    check('and makes them take clicks', /\.dsse-row\[data-actions="true"\]:focus-within \.dsse-row-actions[^{]*\{[^}]*pointer-events:auto/.test(sheet), '')
    // An open menu has to keep the control on screen: the pointer travels from the
    // control down to the menu, and that trip leaves the row.
    check('and an open menu keeps the control visible', /\[data-menu="true"\] \.dsse-row-actions[^{]*\{[^}]*opacity:1/.test(sheet), '')
    check('and the size it covers hides by slot, not by layout', /\.dsse-row\[data-actions="true"\]:hover \.dsse-size[^{]*\{visibility:hidden\}/.test(sheet), '')
    check('and an open menu hides the size too', /\.dsse-row\[data-menu="true"\] \.dsse-size[^{]*\{visibility:hidden\}/.test(sheet), '')
    // Focus must NOT hide the size. `visibility:hidden` also leaves the
    // accessibility tree, so a keyboard or screen-reader user would lose the file
    // size the moment they focused the row -- and they never hover, so the size
    // they "save" by not covering is a number they would never have seen.
    check('and focus does not hide the size from the accessibility tree', /\.dsse-row\[data-actions="true"\]:focus-within \.dsse-size[^{]*\{visibility:hidden\}/.test(sheet) === false, '')
    // ...because the control covers its own footprint instead. Measured in Chrome:
    // the size is right-aligned sixteen pixels from the button's left edge and the
    // button is transparent, so without an opaque background of its own the two
    // draw on top of each other and "1.2 KB" reads as "1.2 ⊗B". Hiding the size
    // was the wrong fix -- the accessibility tree is exactly why it stays -- so the
    // button has to stop sharing the pixels it sits on.
    check('and a focused control covers what it sits on', /\.dsse-row\[data-actions="true"\]:focus-within \.dsse-row-copy[^{]*\{[^}]*background:var\(--dsw-alias-bg-layer-2/.test(sheet), '')
    check('the hiding rule never uses display', /\.dsse-row\[data-actions="true"\][^{]*\.dsse-size[^{]*\{[^}]*display:none/.test(sheet) === false, '')
    // Keyboard reachability: hiding the actions from the pointer must not hide them
    // from the tab order, or the feature only exists for mouse users.
    check('a focused row reveals them too', /\.dsse-row\[data-actions="true"\]:focus-within \.dsse-row-actions/.test(sheet), '')
    check('and the control has its own focus ring', /\.dsse-row-copy:focus-visible\{[^}]*outline/.test(sheet), '')
    check('the control looks like a control', /\.dsse-row-copy\{[^}]*cursor:pointer/.test(sheet), '')
    // The menu is a block in the card, wearing the card's own surfaces. A popup
    // floating outside the list would be cut off by the card's overflow exactly
    // when the list is long enough to need it.
    check('the menu is laid out in the list, not floated over it', /\.dsse-row-menu\{[^}]*display:grid/.test(sheet) && /\.dsse-row-menu\{[^}]*position:absolute/.test(sheet) === false, '')
    check('and wears the card radius', /\.dsse-row-menu\{[^}]*border-radius:9px/.test(sheet), '')
    check('and the card surface', /\.dsse-row-menu\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(sheet), '')
    check('and a menu item is a full-width row', /\.dsse-row-menuitem\{[^}]*width:100%/.test(sheet), '')
    // Items are as wide as the menu, and the menu is inset from the card, so a
    // long label ellipsises instead of pushing the layout wider.
    check('and a long label cannot widen the menu', /\.dsse-row-menuitem-label\{[^}]*overflow:hidden/.test(sheet) && sheet.includes('dsse-row-menuitem-value') === false, '')
    // The outcome is a colour on the icon, because the control is 22px and no word
    // that fits there is long enough to read.
    check('success and failure are distinguishable without text', /\.dsse-row-copy\[data-ok="true"\]\{[^}]*color:/.test(sheet) && /\.dsse-row-copy\[data-ok="false"\]\{[^}]*color:/.test(sheet), '')
    check('and the open state is a border, not a second control', /\.dsse-row-copy\[aria-expanded="true"\]\{[^}]*border-color/.test(sheet), '')
    // The opener has to fill the row, or the row's padding becomes dead space: the
    // highlight says "click here" over pixels that do nothing.
    check('the opener stretches over the row\'s padding', /\.dsse-row-open\{[^}]*align-self:stretch/.test(sheet) && /\.dsse-row-open\{[^}]*margin:-2px -6px/.test(sheet), '')
  }

  // A press *inside* the menu is not outside either, and this needs its own
  // instance rather than a node swapped in later: `attachRefs` only fills a ref
  // that is still null (`test/client.test.mjs:347`), so by the time the menu is
  // open `menuRef.current` is already the default node and handing the renderer a
  // new one changes nothing. The two failures this guards against point in
  // opposite directions -- treat the menu as outside and its own entries stop
  // working; treat everything as inside and it never closes -- so the check has to
  // exist on both sides. It did not: the fixtures never gave the node a `contains`
  // list, the call was always false, and deleting the term entirely stayed green.
  {
    const navigator = { clipboard: { writeText: () => undefined } }
    const insideTarget = { id: 'pressed-inside-the-menu' }
    const seeded = await open({
      routes: routesFor(),
      navigator,
      frame: { left: 0, top: 0, width: 1920, height: 1000, contains: [insideTarget] },
    })
    const redraw = () => seeded.instance.renderer.deepRender(seeded.instance.seat('cards'))
    const cardOf = (tree) => byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const rowIn = (tree, name) => byClass(cardOf(tree), 'dsse-row').find((node) => textOf(node).includes(name))
    const menuIn = (tree, name) => byClass(cardOf(tree), 'dsse-row-menu').find((node) => String(node.props?.['aria-label'] ?? '').includes(name))
    press(rowIn(await redraw(), 'inside.ts'), 'dsse-row-copy', 0)
    check('the menu is open before the press inside it', menuIn(await redraw(), 'inside.ts') !== undefined, 'menu never opened')
    const inner = seeded.instance.listeners.find((row) => row.type === 'mousedown')
    if (inner === undefined) {
      check('a press inside the menu leaves it open', false, 'no mousedown listener')
    } else {
      inner.handler({ target: insideTarget })
      check('a press inside the menu leaves it open', menuIn(await redraw(), 'inside.ts') !== undefined, 'menu closed on a press inside it')
      // And the same listener still closes it for a press that is genuinely
      // elsewhere, so "stays open" is not the only thing it can say.
      const stillOpen = seeded.instance.listeners.find((row) => row.type === 'mousedown')
      if (stillOpen === undefined) {
        check('and still closes on a press elsewhere', false, 'no mousedown listener left')
      } else {
        // The hit node as a browser hands it over: a <path> inside the control,
        // with no marker of its own but able to say who its ancestors are.
        // Everything above this point feeds the panel a node that *is* the
        // control, which is the one shape a real press never has -- so the
        // `closest` branch was never entered, and dropping it entirely left the
        // suite green. This is the case the icon press actually produces, and the
        // one that made the control unable to close its own menu.
        const realHit = {
          tagName: 'path',
          closest: (selector) => (selector === '[data-dsse-copy="true"]' ? { tagName: 'button' } : null),
        }
        const afterIcon = seeded.instance.listeners.find((row) => row.type === 'mousedown')
        if (afterIcon === undefined) {
          check('and the control is found by walking up', false, 'no mousedown listener left')
          check('and a press elsewhere still closes it', false, 'no mousedown listener left')
        } else {
          afterIcon.handler({ target: realHit })
          check('and the control is found by walking up', menuIn(await redraw(), 'inside.ts') !== undefined, 'menu closed although the press was on its own control')
          const afterWalk = seeded.instance.listeners.find((row) => row.type === 'mousedown')
          if (afterWalk === undefined) {
            check('and a press elsewhere still closes it', false, 'no mousedown listener left')
          } else {
            afterWalk.handler({ target: { closest: () => null, dataset: {} } })
            check('and a press elsewhere still closes it', menuIn(await redraw(), 'inside.ts') === undefined, 'menu survived a press elsewhere')
          }
        }
      }
    }
  }

  // The focus comes back to the control that opened the menu.
  //
  // Choosing an entry removes the entry -- the menu closes -- so without an
  // explicit hand-back the focus falls to the document body: the next Tab starts
  // from the top of the page again, and the outcome written into `aria-label`
  // (`已复制路径`) is announced to nobody, because the button no longer holds
  // focus by the time it changes. The mutation `choosing an entry drops focus on
  // the floor` survived the entire suite before this block existed, which is
  // exactly what running the mutations is for: the line was there, the reason was
  // written next to it, and nothing checked that it ran.
  {
    let focused = 0
    const navigator = { clipboard: { writeText: () => undefined } }
    const seeded = await open({
      routes: routesFor(),
      navigator,
      frame: { left: 0, top: 0, width: 1920, height: 1000, onFocus: () => { focused += 1 } },
    })
    const redraw = () => seeded.instance.renderer.deepRender(seeded.instance.seat('cards'))
    const cardOf = (tree) => byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const rowIn = (tree, name) => byClass(cardOf(tree), 'dsse-row').find((node) => textOf(node).includes(name))
    press(rowIn(await redraw(), 'inside.ts'), 'dsse-row-copy', 0)
    const opened = await redraw()
    const menu = byClass(cardOf(opened), 'dsse-row-menu')[0]
    if (menu === undefined) {
      check('choosing an entry hands focus back to the control', false, 'the menu never opened')
      check('and the menu is gone after the choice', false, 'the menu never opened')
    } else {
      const before = focused
      press(menu, 'dsse-row-menuitem', 0)
      check('choosing an entry hands focus back to the control', focused === before + 1, `${focused - before} focus calls`)
      check('and the menu is gone after the choice', byClass(cardOf(await redraw()), 'dsse-row-menu').length === 0, 'the menu outlived the choice')
    }
  }

  // Every menu says which file it belongs to.
  // Two menus can be open in two different sessions of the same panel, and a
  // screen reader announces the container by its name; a nameless one is just
  // "group" with two buttons in it. Nothing checked this string before, so
  // deleting it left the suite green.
  {
    const navigator = { clipboard: { writeText: () => undefined } }
    const seeded = await open({ routes: routesFor(), navigator })
    const redraw = () => seeded.instance.renderer.deepRender(seeded.instance.seat('cards'))
    const cardOf = (tree) => byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const rowIn = (tree, name) => byClass(cardOf(tree), 'dsse-row').find((node) => textOf(node).includes(name))
    press(rowIn(await redraw(), 'inside.ts'), 'dsse-row-copy', 0)
    const opened = await redraw()
    const menu = byClass(cardOf(opened), 'dsse-row-menu')[0]
    if (menu === undefined) {
      check('the menu names the file it belongs to', false, 'no menu to read')
      check('and it declares itself a group, not a menu widget', false, 'no menu to read')
    } else {
      check('the menu names the file it belongs to', menu.props?.['aria-label'] === '复制 inside.ts 的路径', String(menu.props?.['aria-label']))
      check('and it declares itself a group, not a menu widget', menu.props?.role === 'group', String(menu.props?.role))
    }
  }

  // A menu opened on the last visible row has to be brought into view.
  //
  // The list fits eight rows and scrolls; a menu is a block under its row, so on
  // the eighth row it starts below the fold. Nothing else in this file can notice
  // that: the assertions read a tree, and a tree has no scroll position. This is
  // the one place where the panel asks the browser a question about layout, so it
  // is also the one place a test double can watch it ask.
  {
    const scrolled = []
    const navigator = { clipboard: { writeText: () => undefined } }
    const seeded = await open({
      routes: routesFor(),
      navigator,
      frame: { left: 0, top: 0, width: 1920, height: 1000, onScrollIntoView: (options) => { scrolled.push(options) } },
    })
    const redraw = () => seeded.instance.renderer.deepRender(seeded.instance.seat('cards'))
    const cardOf = (tree) => byClass(tree, 'dsse-card').find((node) => textOf(node).includes('产出文件'))
    const rowIn = (tree, name) => byClass(cardOf(tree), 'dsse-row').find((node) => textOf(node).includes(name))
    const before = scrolled.length
    press(rowIn(await redraw(), 'inside.ts'), 'dsse-row-copy', 0)
    await redraw()
    check('opening a menu asks the list to make room for it', scrolled.length === before + 1, `${scrolled.length - before} calls`)
    // `nearest` and not `center`: a menu that already fits must not drag the list.
    check('and asks for the smallest scroll that shows it', scrolled[scrolled.length - 1]?.block === 'nearest', JSON.stringify(scrolled[scrolled.length - 1]))
    const openCount = scrolled.length
    press(rowIn(await redraw(), 'inside.ts'), 'dsse-row-copy', 0)
    await redraw()
    check('and closing it asks for nothing', scrolled.length === openCount, `${scrolled.length - openCount} calls on close`)
  }

}

// ---------------------------------------------------------------------------
// The monitor column is where the cards live now
//
// The cards used to be absolutely positioned into whichever gutter the prose
// left over. That layout only existed when the window was wide enough to have a
// gutter at all: on a 1440px window with the host sidebar open, each side got
// 209px, which is narrower than the cards, so the panel was squeezed or absent
// exactly where it was most wanted. The column is the replacement, and it is on
// by default -- so the default has to be pinned here, not left to whichever
// fixture happens to turn it off.
// ---------------------------------------------------------------------------

{
  const routes = panelRoutes()
  routes['/api/ui-evolve/config'] = {
    ok: true,
    data: { panelSummary: true, monitorColumn: true },
  }
  const instance = boot({
    rect: { left: 280, top: 120, right: 1920, bottom: 420, width: 1640, height: 300 },
    proseWidth: '920px',
    routes,
  })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')

  // No click: the point of the default is that the panel is already there.
  const toggleTree = await instance.renderer.render(toggle, { sessionId: 'session-a' })
  check(
    'the toggle starts pressed, because the panel starts open',
    firstByClass(toggleTree, 'dsse-toggle')?.props?.['data-active'] === 'true',
    String(firstByClass(toggleTree, 'dsse-toggle')?.props?.['data-active']),
  )

  const tree = await instance.renderer.deepRender(cards)
  const column = firstByClass(tree, 'dsse-monitor')
  check('the panel draws a column without being asked', column !== undefined, textOf(tree).slice(0, 80))

  // The box must be a real rectangle. A missing width is the failure mode worth
  // catching: an undefined or NaN width renders as `width: NaNpx`, which the
  // browser drops, and the column collapses to the width of its content while
  // still claiming to reserve 300px of the conversation.
  const box = column?.props?.style ?? {}
  const numbers = ['left', 'top', 'width', 'height'].map((key) => Number.parseFloat(String(box[key] ?? 'NaN')))
  check(
    'and gives the column four real edges',
    numbers.every((value) => Number.isFinite(value) && value >= 0),
    JSON.stringify(box),
  )
  // The fixture puts the conversation at x=280 and 1640 wide, so its right edge is
  // 1920. The column is measured in the same space as the gutter rail (see "the
  // rail clears the host sidebar"), which is why this number is the viewport one
  // and not 1640.
  check(
    'and puts it against the right edge of the conversation',
    Math.abs(numbers[0] + numbers[2] - 1920) <= 1 && numbers[0] > 920,
    JSON.stringify({ left: numbers[0], width: numbers[2] }),
  )

  // The reservation is the whole point: without it the column would cover the
  // conversation instead of sitting beside it.
  const reserve = Number.parseFloat(String(instance.hostStyle.get('--dsse-monitor-reserve') ?? 'NaN'))
  check(
    'and takes that width away from the conversation',
    Number.isFinite(reserve) && reserve === numbers[2],
    JSON.stringify({ reserve, columnWidth: numbers[2] }),
  )

  // The rail no longer positions itself inside the column; the column is the box.
  const rail = firstByClass(tree, 'dsse-rail')
  check(
    'the cards fill the column instead of positioning themselves',
    rail?.props?.['data-embedded'] === 'true' && rail?.props?.style === undefined,
    JSON.stringify(rail?.props?.['data-embedded'] ?? null),
  )
  // No column header. A title saying "monitor" on the column whose only content
  // is the monitor is a caption on the obvious, and at 220px it costs a card's
  // worth of height. The switch lives in the session header, so closing does not
  // need a second control in here either.
  check(
    'the column draws no header of its own',
    firstByClass(tree, 'dsse-monitor-head') === undefined && firstByClass(tree, 'dsse-monitor-title') === undefined,
    textOf(tree).slice(0, 80),
  )
  check(
    'the top row is the first thing in the column',
    firstByClass(tree, 'dsse-monitor-body') !== undefined && firstByClass(tree, 'dsse-top-row') !== undefined,
    textOf(tree).slice(0, 80),
  )

  // Closing the column has to hand the width back. A reservation left behind
  // narrows the conversation for the rest of the session, which is worse than
  // the layout it replaced. The close path is the header switch now: there is no
  // control inside the column to press.
  const openToggle = firstByClass(toggleTree, 'dsse-toggle')
  check(
    'the switch is the only way to close the column',
    openToggle?.props?.['data-active'] === 'true' && typeof openToggle?.props?.onClick === 'function',
    String(openToggle?.props?.['data-active']),
  )
  openToggle?.props?.onClick?.()
  const closed = await instance.renderer.deepRender(cards)
  check('closing the column removes it', closed === null, textOf(closed ?? {}).slice(0, 60))
  check(
    'and returns the width to the conversation',
    instance.hostStyle.get('--dsse-monitor-reserve') === '0px',
    JSON.stringify(instance.hostStyle.get('--dsse-monitor-reserve')),
  )
  check(
    'and the toggle reports the panel is closed',
    firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle')?.props?.['data-active'] === 'false',
    String(firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle')?.props?.['data-active']),
  )
}

{
  // Turning the column off leaves no panel. There is no second layout to fall
  // back to any more: the floating cards it used to fall back to are the layout
  // the column replaced, and that fallback is exactly what made the panel
  // disappear with no way back once a narrow width had been saved.
  const instance = boot({
    rect: { left: 280, top: 120, right: 1920, bottom: 420, width: 1640, height: 300 },
    proseWidth: '920px',
    routes: {
      ...panelRoutes(),
      '/api/ui-evolve/config': { ok: true, data: { panelSummary: true, monitorColumn: false } },
    },
  })
  instance.module.apply(instance.ctx)
  await settle()
  const tree = await instance.renderer.deepRender(instance.seat('cards'))
  check('a saved off draws no column', firstByClass(tree, 'dsse-monitor') === undefined, textOf(tree).slice(0, 60))
  check('and draws no cards either, because there is no other layout', firstByClass(tree, 'dsse-rail') === undefined, textOf(tree).slice(0, 60))
  check(
    'and reserves nothing',
    instance.hostStyle.get('--dsse-monitor-reserve') === '0px',
    JSON.stringify(instance.hostStyle.get('--dsse-monitor-reserve')),
  )
}

// ---------------------------------------------------------------------------
// The monitor column's edges, and the turn rail it used to take with them
//
// Two things a person can see and no component assertion can: whether the column
// has a top edge, and whether the host's turn rail is still drawn beside the
// prose. Both are CSS, so they are asserted against the stylesheet text the
// bundle installs — the same way the handle width is.
// ---------------------------------------------------------------------------

{
  const source = readFileSync(new URL('../packages/ui-evolve/lib/client.js', import.meta.url), 'utf8')
  const rule = /[.]dsse-monitor[{]([^}]*)[}]/.exec(source)
  const body = rule === null ? '' : rule[1]
  check('the monitor column has a rule of its own', rule !== null, 'no .dsse-monitor rule found')
  // No edges and no shadow. The ruling made the panel read as a separate window
  // floating over the conversation; without it the column is told apart by its own
  // surface and by the cards' outlines. A `border-*` or a `box-shadow` reappearing
  // here is the regression, so all three are asserted absent rather than present.
  check('and draws no top edge', /border-top/.test(body) === false, body.slice(0, 120))
  check('and no left edge', /border-left/.test(body) === false, body.slice(0, 120))
  check('and casts no shadow', /box-shadow/.test(body) === false, body.slice(0, 120))
  // The grab strip hangs outside the left edge, so the column must not clip it.
  check('and does not clip the grab strip that hangs outside it', /overflow:hidden/.test(body) === false, body.slice(0, 120))
}

// The header holds the standing answer ("what happened last turn"), so it has to
// stay put while the cards below it scroll. That is `position:sticky` on the
// block that wraps the tools row and the recap — not `fixed`, which would need
// the column's left edge recomputed by hand every time the column is resized.
// ---------------------------------------------------------------------------
{
  const source = readFileSync(new URL('../packages/ui-evolve/lib/client.js', import.meta.url), 'utf8')
  const rule = /[.]dsse-col-top[{]([^}]*)[}]/.exec(source)
  const body = rule === null ? '' : rule[1]
  check('the header is a block of its own', rule !== null, 'no .dsse-col-top rule found')
  check('and it is stuck to the top of the scroller', /position:sticky/.test(body), body.slice(0, 120))
  check('and it sticks at zero, not at some offset', /top:0/.test(body), body.slice(0, 120))
  // Opaque, because the cards scroll underneath it. A translucent header would
  // show the file rows sliding through the recap.
  // Opaque and card-coloured: the header is the top card now, so its fill has to
  // be the one the cards below use, not the column's page fill.
  // Opaque is what matters here, and the wrapper is allowed the column's page
  // fill: it is a band under the card, not the card. The card itself is what
  // matches the list below.
  check('and it hides what slides underneath it', /background:var\(--dsw-alias-bg-(base|layer-1)/.test(body), body.slice(0, 160))
}

// The badge on a folded card is a hint, not furniture: it fades in when the
// pointer reaches the card. Two cards answer the same gesture with the same
// shape, which is the whole point of the change that put it there.
// ---------------------------------------------------------------------------
{
  const source = readFileSync(new URL('../packages/ui-evolve/lib/client.js', import.meta.url), 'utf8')
  const rule = /[.]dsse-expand[{]([^}]*)[}]/.exec(source)
  const body = rule === null ? '' : rule[1]
  check('the badge still has a rule', rule !== null, 'no .dsse-expand rule found')
  check('and starts invisible', /opacity:0/.test(body), body.slice(-160))
  check('and keeps its line while it is hidden', /height:26px/.test(body) && /max-height/.test(body) === false, body.slice(0, 160))
  const reveal = /[.]dsse-card:hover [.]dsse-expand[^{]*[{][^}]*opacity:1/.exec(source)
  check('and appears when the pointer reaches the card', reveal !== null, 'no hover reveal rule')
  const keyboard = /[.]dsse-card:focus-within [.]dsse-expand[^{]*[{][^}]*opacity:1/.exec(source)
  check('and appears for a reader who never touches a mouse', keyboard !== null, 'no focus-within reveal rule')
  const open = /[.]dsse-card\[data-open="true"\] [.]dsse-expand[^{]*[{][^}]*opacity:1/.exec(source)
  check('and stays while the card is open', open !== null, 'no open-state reveal rule')
  // The queue row and the summary are one card now. The pointer reaching the
  // queue row has to reveal the summary's badge too, or the card answers only
  // the half of itself that happens to be text and reads as one with nothing to
  // offer -- which is what "hovering the summary shows no button" looked like.
  const merged = /[.]dsse-col-top:hover [.]dsse-expand[^{]*[{][^}]*opacity:1/.exec(source)
  check('and the merged header reveals it from anywhere in the card', merged !== null, 'no header-wide reveal rule')
  check(
    'and a hidden badge cannot swallow the click meant for the row under it',
    /[.]dsse-expand-action[{]pointer-events:none/.test(source),
    'the resting badge takes the pointer',
  )
}

{
  const source = readFileSync(new URL('../packages/ui-evolve/lib/client.js', import.meta.url), 'utf8')
  // The host hides its turn rail with a container query on the scroll *area*,
  // which is not the same as the gutter the rail occupies. Overruling that needs
  // `!important` on the same element, and the bundle earns it from the column
  // being open rather than from a second measurement — so the rule must be keyed
  // on our own attribute and must not carry a width of its own to compare
  // against.
  const rule = /html\[data-dsse-turn-rail="1"\][^{]*\{[^}]*display:block !important[^}]*\}/.exec(source)
  check('the turn rail rule is keyed on a measurement, not a width', rule !== null, 'no attribute-keyed rule found')
  check(
    'and it beats the host container query',
    rule !== null && /display:block !important/.test(rule[0]),
    rule === null ? 'no rule' : rule[0].slice(-40),
  )
  // The desktop app added a second half to this rule. An ancestor there holds
  // the conversation subtree at visibility:hidden, and because visibility
  // inherits, display:block alone still painted an invisible rail: the node had
  // a real 28x192 box, 19 marks and correct colours, and elementFromPoint fell
  // straight through it to the scroll body. The rule has to restore visibility
  // on the nav itself, which does not disturb whatever else the ancestor means
  // to hide.
  check(
    'and restores the visibility an ancestor took away',
    rule !== null && /visibility:visible !important/.test(rule[0]),
    rule === null ? 'no rule' : rule[0].slice(-60),
  )
  // A rail nobody can point at is still broken. The slot is pointer-events:none
  // by design and the nav only becomes clickable because the host stylesheet
  // sets auto on it; on the desktop build that computed to none, so hover
  // previews appeared only for synthesized events and a real mouse went
  // straight through to the scroll body.
  check(
    'and takes the pointer back from the slot that ignores it',
    rule !== null && /pointer-events:auto !important/.test(rule[0]),
    rule === null ? 'no rule' : rule[0].slice(-80),
  )
  // A theme can paint its own stand-in rail into the same slot after hiding the
  // host's. Once we re-show the host rail, that stand-in becomes a second rail
  // drawn over it, and the two disagree on geometry: in the desktop app they
  // shared x 1263..1291 but ran 281..543 against 292..532, an 11px offset the
  // reader sees as the rail being misaligned. The stand-in also carries its own
  // 900px container query, so the doubling came and went as the column was
  // dragged. Exactly one rail must survive.
  // Anchored at the start of the line on purpose: an unanchored pattern still
  // matches `html[data-dsse-turn-rail="1"] [data-conversation-scroll] ...`,
  // which is precisely the scoped form that went inert when the column closed.
  const standIn = /^\[data-conversation-scroll\] \.dsh-claude-turn-rail\{display:none !important\}/m.exec(source)
  check(
    'and retires a theme stand-in rail so only one is drawn',
    standIn !== null,
    standIn === null ? 'no stand-in rule' : standIn[0],
  )
  // "One rail, not two" is an invariant of the page, not of our column. Scoped
  // to the column being open, the rule went inert the moment the column closed
  // -- and closing the column widens the scroll area back over the stand-in's
  // own 900px threshold, which is exactly when it comes back and doubles the
  // host rail. The rule must therefore not name the column attribute at all.
  check(
    'and retires it whether or not the column is on',
    standIn !== null && standIn[0].indexOf('data-dsse-turn-rail') === -1 && standIn[0].indexOf('data-dsse-monitor') === -1,
    standIn === null ? 'no stand-in rule' : standIn[0],
  )
  check(
    'and the rule sits inside the stylesheet',
    standIn !== null && source.indexOf('let typographyObserver') > source.indexOf('.dsh-claude-turn-rail{display:none !important}'),
    'the stand-in rule is outside the stylesheet',
  )
  // The class is a CSS-module hash, so the aria-label is the stable half. Both
  // are named, and matching neither costs only the rail.
  check('and it knows the rail by its stable label', source.includes('nav[aria-label="轮次导航"]'), 'no zh label selector')
  check('and by its English label', source.includes('nav[aria-label="Turn navigation"]'), 'no en label selector')
  check('and still by the hashed class', source.includes('nav[class*="SNx2jG_frame"]'), 'no class selector')
  // The scoping is load-bearing: with the column off we took no width, so the
  // host's own threshold is right and we must stay out of its way.
  check(
    'and only fires while the column is on',
    /html\[data-dsse-turn-rail="1"\]/.test(source) && /html\[data-dsse-turn-rail="1"\]/.test(source.slice(0, source.indexOf('let typographyObserver'))),
    'the rule is not scoped to the column being on',
  )
}

// ---------------------------------------------------------------------------
// The two rules that let the column scroll, and the strip that lets it be dragged
//
// Both were deleted whole by the pass that removed the old gutter layout: what
// survived were the derived rules (`.dsse-monitor-body .dsse-card`), which kept
// looking right while the base rules they modify were gone. The symptom was a
// column that cut its own content off at 220px with no scrollbar, and a card rail
// that inherited `position:absolute` from the old overlay and collapsed inside
// its parent. Neither is visible to a component assertion — the tree is correct,
// the stylesheet is not — so they are asserted against the bundle text.
// ---------------------------------------------------------------------------

{
  const source = readFileSync(new URL('../packages/ui-evolve/lib/client.js', import.meta.url), 'utf8')
  const body = /[.]dsse-monitor-body[{]([^}]*)[}]/.exec(source)
  check('the column has a body rule of its own', body !== null, 'no .dsse-monitor-body rule found')
  const css = body === null ? '' : body[1]
  // Without this the body is a plain block: `.dsse-monitor`'s own `overflow:hidden`
  // clips everything past the first screenful and no scrollbar ever appears.
  check('and it scrolls instead of clipping', /overflow-y:auto/.test(css), css.slice(0, 120))
  check('and it takes the leftover height rather than its content height', /(^|;)\s*flex:1/.test(css), css.slice(0, 120))
  check('and it may shrink below its content height', /min-height:0/.test(css), css.slice(0, 120))

  const rail = /[.]dsse-rail\[data-embedded="true"\][{]([^}]*)[}]/.exec(source)
  check('the embedded rail has its own rule', rail !== null, 'no .dsse-rail[data-embedded="true"] rule found')
  const railCss = rail === null ? '' : rail[1]
  // The base `.dsse-rail` is absolutely positioned for the old overlay. Inside the
  // column it has to go back to being a flow block, or all the cards stack on top
  // of each other in the column's top-left corner.
  check('and goes back to a flow block', /position:static/.test(railCss), railCss.slice(0, 120))
  check('and stops sizing itself to the window', /width:auto/.test(railCss) && /height:auto/.test(railCss), railCss.slice(0, 120))
  // A leftover max-height would clip the cards a second time, below the body rule.
  check('and drops the height cap it carried as an overlay', /max-height:none/.test(railCss), railCss.slice(0, 120))

  // The grab strip is the only way to resize the column, and at its old 8px it
  // sat exactly under the column's own border: the pointer had to land on a 1px
  // line to find it, which is what "hard to drag" was. It now reaches outside the
  // edge, so the assertion is a floor rather than an exact number.
  const grip = /[.]dsse-monitor-grip[{]([^}]*)[}]/.exec(source)
  check('the grab strip has a rule', grip !== null, 'no .dsse-monitor-grip rule found')
  const gripCss = grip === null ? '' : grip[1]
  const width = /width:(\d+)px/.exec(gripCss)
  check('and is wide enough to hit without aiming', width !== null && Number(width[1]) >= 16, width === null ? 'no width' : width[1])
  check('and reaches outside the column edge', /left:-\d+px/.test(gripCss), gripCss.slice(0, 120))
  check('and still shows where the edge is', source.includes('.dsse-monitor-grip::after'), 'no visible line on the strip')
}

report()
process.exit(failed === 0 ? 0 : 1)
