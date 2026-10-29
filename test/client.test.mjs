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
import { placeCards, TIP_WIDTH, TIP_HEIGHT } from '../lib/gutter.js'

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
  return {
    getBoundingClientRect: () => ({ left: frame.left, top: frame.top, right: frame.left + frame.width, bottom: frame.top + frame.height, width: frame.width, height: frame.height }),
    offsetWidth: frame.width,
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
      : fakeNode({ left: settings.triggerLeft, top: settings.triggerTop ?? 300, width: 40, height: 20 }),
  )


  const source = readFileSync(join(repo, 'lib', 'client.js'), 'utf8')
  const evaluate = new Function('window', 'document', 'fetch', 'getComputedStyle', 'setInterval', 'clearInterval', source)
  // A fixed pair of timer stubs: the cards poll, and a real interval would keep
  // the test process alive after it has finished asserting.
  evaluate(windowStub, documentStub, fetchStub, computed, () => 0, () => {})

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
      data: { panelSummary: true, panelSide: 'left', panelCollapsed: false, panelHelp: true },
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
        data: { panelSummary: true, panelSide: 'right', panelCollapsed: false, panelHelp: true },
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
  releaseConfig({ ok: true, data: { panelSummary: true, panelSide: 'right', panelCollapsed: false, panelHelp: true } })
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
        data: { panelSummary: true, panelSide: 'left', panelCollapsed: true, panelHelp: true },
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
        data: { panelSummary: true, panelSide: 'right', panelCollapsed: false, panelHelp: true },
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
// The explanation on the propose button
// ---------------------------------------------------------------------------

{
  // The button once carried a native `title`. That tooltip is browser-owned: it
  // waits about a second before appearing, cannot be styled, and inside a card
  // with `overflow:hidden` it is clipped to the card's width. So the sentence
  // explaining what the button does was effectively invisible.
  const instance = boot({ routes: panelRoutes() })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()

  const first = await instance.renderer.deepRender(cards)
  // The Overlay already watches `resize` to re-measure its geometry, so only a
  // delta around the hover describes the bubble's own listeners.
  const baseListeners = instance.listeners.length
  const trigger = firstByClass(first, 'dsse-tip-anchor')
  check('the propose button is wrapped in a hover trigger', trigger !== undefined, textOf(first).slice(0, 120))
  check('no tooltip is shown before hovering', firstByClass(first, 'dsse-tip') === undefined)

  const button = byClass(first, 'dsse-btn')[0]
  check('the button no longer asks the browser for a tooltip', button?.props?.title === undefined, String(button?.props?.title))

  // A disabled button receives no mouse events in Chrome, which is exactly when
  // someone wants to know why. The wrapper is what the handlers sit on, so this
  // asserts the wrapper — not the button — owns the interaction.
  check('the trigger carries the hover handler', typeof trigger?.props?.onMouseEnter === 'function')
  check('the trigger also reacts to keyboard focus', typeof trigger?.props?.onFocus === 'function')

  // Guard the whole interaction: without the wrapper there is nothing to hover,
  // and a `TypeError` here would be reported as "0 failing" — a crash dressed up
  // as a pass. Fail by name instead.
  check('the trigger can be hovered at all', trigger !== undefined && typeof trigger?.props?.onMouseEnter === 'function')
  if (trigger !== undefined && typeof trigger?.props?.onMouseEnter === 'function') {
    trigger.props.onMouseEnter()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  }

  const shown = await instance.renderer.deepRender(cards)
  const tip = firstByClass(shown, 'dsse-tip')
  check('hovering reveals the explanation', tip !== undefined)
  const words = textOf(tip)
  check('the explanation says what pressing the button does', words.includes('值不值得沉淀成技能'), words)
  check('the explanation says it will not create a file on its own', words.includes('不会自动新建技能文件'), words)
  check('the explanation is marked as a tooltip for assistive tech', tip?.props?.role === 'tooltip', String(tip?.props?.role))

  // The cards sit in a side gutter; an unclamped bubble opens past the window
  // edge. An unmeasured viewport would make this NaN, which reaches CSS as
  // `left:NaNpx` and parks the bubble at the origin instead of beside its button.
  const style = tip?.props?.style ?? {}
  check('the bubble is horizontally placed with a finite value', typeof style.left === 'string' && style.left.endsWith('px') && Number.isFinite(Number(style.left.slice(0, -2))), String(style.left))
  // `endsWith("px")` is satisfied by "NaNpx", so this has to read the number.
  check(
    'the bubble has a finite vertical placement',
    typeof style.top === 'string' && style.top.endsWith('px') && Number.isFinite(Number(style.top.slice(0, -2))),
    String(style.top),
  )
  // The attribute has to sit on the focusable element. Putting it on the wrapper
  // span leaves it inert, because that span never receives focus — which is the
  // mistake the second review caught.
  const described = byClass(shown, 'dsse-btn')[0]?.props?.['aria-describedby']
  check('the button points at the bubble it just opened', typeof described === 'string' && described.length > 0, String(described))
  check('and the bubble carries that same id', tip?.props?.id === described, String(tip?.props?.id))
  check(
    'the description is not put on the unfocusable wrapper',
    firstByClass(shown, 'dsse-tip-anchor')?.props?.['aria-describedby'] === undefined,
    String(firstByClass(shown, 'dsse-tip-anchor')?.props?.['aria-describedby']),
  )
  check(
    'the description is only advertised while the bubble exists',
    byClass(first, 'dsse-btn')[0]?.props?.['aria-describedby'] === undefined,
    String(byClass(first, 'dsse-btn')[0]?.props?.['aria-describedby']),
  )

  // Fixed positioning alone is not enough — the stylesheet must also carry the
  // rule, or the element inherits `position:static` and `top/left` are inert.
  // Whitespace-tolerant and comment-free for the same reason as the width check
  // below: formatting is not a behavioural change, and a comment is not a rule.
  const sheet = instance.styles
    .map((node) => String(node.textContent))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const fixedRule = (/\.dsse-tip\s*\{([^}]*)\}/.exec(sheet) ?? [])[1] ?? ''
  check('the stylesheet positions the bubble as fixed', fixedRule.includes('position:fixed'), fixedRule.slice(0, 80))

  // A listener that is never removed outlives the bubble. The stub records
  // every add/remove pair, so this can actually be checked.
  const added = instance.listeners.slice(baseListeners).filter((row) => row.type === 'resize' || row.type === 'scroll')
  check('an open bubble watches for resize and scroll', added.length === 2, String(added.length))
  check(
    'the scroll listener uses the capture phase so nested scrollers count',
    added.some((row) => row.type === 'scroll' && row.options === true),
    JSON.stringify(added.map((row) => [row.type, row.options])),
  )

  const hideTrigger = firstByClass(shown, 'dsse-tip-anchor')
  check('the trigger survives the hover', hideTrigger !== undefined)
  if (hideTrigger !== undefined) {
    hideTrigger.props.onMouseLeave()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  }
  const hidden = await instance.renderer.deepRender(cards)
  check('leaving the button dismisses the explanation', firstByClass(hidden, 'dsse-tip') === undefined)
  const remaining = instance.listeners.slice(baseListeners).filter((row) => row.type === 'resize' || row.type === 'scroll')
  check('dismissing also removes the listeners', remaining.length === 0, String(remaining.length))
}

// ---------------------------------------------------------------------------
// The bubble stays inside a measurable window
// ---------------------------------------------------------------------------

{
  // The button sits in the side gutter near the right edge of the frame, which is
  // the case an unclamped bubble gets wrong. 400px is narrower than the bubble,
  // so the only placement that keeps it on screen starts at the 8px margin.
  const instance = boot({ routes: panelRoutes(), innerWidth: 400, triggerLeft: 380 })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  // Guard the hover: without the wrapper there is nothing to hover, and a
  // `TypeError` here is reported as a crash rather than as a failing assertion.
  const trigger = firstByClass(first, 'dsse-tip-anchor')
  check('a narrow window still has a hoverable trigger', trigger !== undefined)
  if (trigger !== undefined) trigger.props.onMouseEnter()
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const tip = firstByClass(await instance.renderer.deepRender(cards), 'dsse-tip')
  const left = Number(String(tip?.props?.style?.left ?? '').replace('px', ''))
  check('a narrow window still places the bubble on screen', Number.isFinite(left) && left >= 8, String(tip?.props?.style?.left))
  check('and keeps its right edge inside the window', left + 230 <= 400, String(left))
}

{
  // The other end of the clamp. A button at x=2 — the collapsed handle on the
  // left rail, or a very narrow window — would otherwise open the bubble at x=2
  // with its text touching the frame edge. Without this fixture the `Math.max(8,
  // …)` bound is never the deciding term, so deleting it stays green.
  const instance = boot({ routes: panelRoutes(), innerWidth: 1200, triggerLeft: 2 })
  instance.module.apply(instance.ctx)
  const toggle = instance.seat('toggle')
  const cards = instance.seat('cards')
  firstByClass(await instance.renderer.render(toggle, { sessionId: 'session-a' }), 'dsse-toggle').props.onClick()
  const first = await instance.renderer.deepRender(cards)
  const trigger = firstByClass(first, 'dsse-tip-anchor')
  check('a left-edge button is still hoverable', trigger !== undefined)
  if (trigger !== undefined) trigger.props.onMouseEnter()
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const tip = firstByClass(await instance.renderer.deepRender(cards), 'dsse-tip')
  const left = Number(String(tip?.props?.style?.left ?? '').replace('px', ''))
  check('the bubble never starts closer than the margin', Number.isFinite(left) && left >= 8, String(tip?.props?.style?.left))
  // The clamp reserves the declared width, so the declared width has to be the
  // outer width. Without `border-box` the 16px of padding and the 1px border are
  // added on top and the bubble overflows by 18px — invisible to every other
  // assertion here, because the harness does not lay anything out.
  // Strip comments before matching, and allow whitespace before the brace. Searching
  // the raw sheet let a comment satisfy the assertion (a false pass) and made a
  // single added space cancel it (a false failure) — neither is a layout change.
  const tipSheet = instance.styles
    .map(node => String(node.textContent))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const tipRule = (/\.dsse-tip\s*\{([^}]*)\}/.exec(tipSheet) ?? [])[1] ?? ''
  check(
    'the width the clamp reserves is the bubble\'s outer width',
    tipRule.includes('box-sizing:border-box') && tipRule.includes('max-width:230px'),
    tipRule.slice(0, 80),
  )
  check('the rule was actually found', tipRule.length > 0, String(tipRule.length))
  check('the margin pushes it away from the edge', left === 8, String(left))

  // Unmounting has to unhook the listeners. This is the assertion that would have
  // caught the harness regression the third review found: the effect wrapper
  // returned nothing, so `cleanups` stayed empty, `unmount()` was a no-op, and
  // every other test passed anyway.
  // The overlay subscribes to `resize` on mount too, and unmounting tears that
  // down as well — so this delta proves the listeners are released, not that all
  // of them belonged to the bubble. The bubble's own pair is covered separately by
  // "an open bubble watches for resize and scroll"; this one guards against the
  // harness going back to an `unmount()` that does nothing at all.
  const isDismiss = row => row.type === 'resize' || row.type === 'scroll'
  const held = instance.listeners.filter(isDismiss).length
  instance.renderer.unmount()
  const afterUnmount = instance.listeners.filter(isDismiss).length
  check('unmounting drops the listeners the bubble hooked', afterUnmount < held, `${held} → ${afterUnmount}`)
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
// TIP_HEIGHT has to stay an upper bound on the real call sites.
//
// The geometry reserves TIP_HEIGHT rather than measuring the bubble, because the
// bubble is placed before it is laid out and reading its rect would give the size
// of the previous bubble. That trade only holds while every call site text fits,
// and nothing else in the suite would notice a longer string being added: it would
// simply clamp against a height smaller than the thing it is clamping. So the
// heights are computed here from the bundle source itself.
// ---------------------------------------------------------------------------
{
  const bundle = readFileSync(join(repo, "lib", "client.js"), "utf8")
  const texts = []
  const callSite = /jsx\(Hint,\s*\{[\s\S]{0,120}?text:\s*"([^"]+)"/g
  for (let hit = callSite.exec(bundle); hit !== null; hit = callSite.exec(bundle)) texts.push(hit[1])

  check("at least one Hint call site was found", texts.length > 0, String(texts.length))

  // The width budget is the outer 230px minus 8px of padding and 1px of border on
  // each side; 10.5px is the font size the stylesheet sets.
  const perLine = Math.floor((TIP_WIDTH - 20) / 10.5)
  for (const text of texts) {
    const lines = Math.max(1, Math.ceil(text.length / perLine))
    // 15.75 is the 1.5 line-height at 10.5px; +12 padding, +2 border.
    const needed = lines * 15.75 + 14
    check(
      `TIP_HEIGHT covers the call site text (${text.length} chars, ${lines} line(s))`,
      needed <= TIP_HEIGHT,
      `needed ${needed.toFixed(2)}px, reserved ${TIP_HEIGHT}px`,
    )
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failed === 0 ? 0 : 1)
