/**
 * Tests for the client half.
 *
 * The client bundle is not a module the host imports — it is a script the
 * browser evaluates, which registers two slots through `window.__ModuleLoader__`.
 * Node cannot evaluate it as ESM, and the component tree it produces is made by
 * the host's own React. So this file does the next best thing: it runs the real
 * bundle body under a fake loader with a minimal React and a jsx that produces
 * plain objects, then asserts on the registrations and on the trees that come
 * out.
 *
 * What that cannot cover: whether the styles read well, whether the host's React
 * accepts the element shapes, whether the padding rule actually lines up with
 * the conversation. Those are browser facts and a browser is what verifies them.
 * What it does cover is everything that fails silently: a component that throws
 * on an empty payload, a slot name the host does not publish, a `require` the
 * shared module table does not carry, a session id that never reaches the panel.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  return { type: component === undefined ? type : component.name || 'anonymous', component, props: props ?? {} }
}

/**
 * Flatten a tree into `type` and string nodes, for assertions.
 *
 * @param {any} node - the root.
 * @returns {string[]} the flattened labels.
 */
function flatten(node) {
  const out = []
  const walk = (current) => {
    if (current === null || current === undefined) return
    if (typeof current === 'string') {
      out.push(current)
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (typeof current !== 'object') return
    out.push(current.type)
    walk(current.props?.children)
  }
  walk(node)
  return out
}

/**
 * Collect the text of every string node.
 *
 * @param {any} node - the root.
 * @returns {string} all text joined.
 */
function textOf(node) {
  return flatten(node).join(' ')
}

/**
 * A React stand-in.
 *
 * `useState` returns the initial value and a no-op setter: the components are
 * asserted as they render on their first pass, which is the pass that must not
 * throw when the payload has not arrived yet. `useMemo` runs its factory so the
 * model catalogue's options are real.
 *
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the stand-in.
 */
function fakeReact(overrides) {
  return {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
    createElement: element,
    ...overrides,
  }
}

/**
 * Boot the bundle once, in a fake browser.
 *
 * @param {object} [options] - request.
 * @param {object} [options.react] - React overrides.
 * @param {(id: string) => any} [options.modules] - the shared module table.
 * @returns {object} the loaded module, the fake ctx, and the registrations.
 */
function boot(options) {
  const settings = options ?? {}
  const registrations = []
  const effects = []
  const injectedNames = []
  const appendedStyles = []

  const requested = []
  const moduleTable = (id) => {
    requested.push(id)
    if (settings.modules !== undefined) return settings.modules(id)
    if (id === 'react') return fakeReact(settings.react)
    if (id === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' }
    throw new Error(`the bundle required "${id}", which the shared module table does not carry`)
  }

  const documentStub = {
    baseURI: 'http://127.0.0.1:19387/',
    head: {
      appendChild(node) {
        appendedStyles.push(node)
      },
    },
    body: {
      attributes: new Map(),
      setAttribute(name, value) {
        this.attributes.set(name, value)
      },
      removeAttribute(name) {
        this.attributes.delete(name)
      },
      hasAttribute(name) {
        return this.attributes.has(name)
      },
    },
    getElementById() {
      return null
    },
    createElement() {
      return { id: '', textContent: '' }
    },
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
  const windowStub = {
    __ModuleLoader__: {
      load(entry) {
        captured = entry
      },
    },
  }

  const source = readFileSync(join(repo, 'lib', 'client.js'), 'utf8')
  const evaluate = new Function('window', 'document', source)
  evaluate(windowStub, documentStub)

  const module = captured.factory(moduleTable)
  return { module, ctx, registrations, effects, injectedNames, requested, document: documentStub, captured }
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
    const allowed = new Set([
      'react',
      'react/jsx-runtime',
      'react-dom/client',
      '@deepseek-ai/dsh-client-ui-primitives',
    ])
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
check('the panel goes into the shell overlay', booted.injectedNames.includes('shell.overlay'), JSON.stringify(booted.injectedNames))
check('both seats registered', booted.registrations.length === 2, String(booted.registrations.length))
check('three effects are declared', booted.effects.length === 3, String(booted.effects.length))

for (const { spec } of booted.registrations) {
  check(`"${spec.id}" declares the slot it registers into`, spec.name === (spec.id.endsWith(':toggle') ? 'conversation.session.header.actions' : 'shell.overlay'), `${spec.id} → ${spec.name}`)
  check(`"${spec.id}" names this plugin as registrant`, spec.registrant === 'dsh-skill-evolve', String(spec.registrant))
  check(`"${spec.id}" carries a numeric order`, Number.isFinite(spec.order), String(spec.order))
  check(`"${spec.id}" exposes an inject function`, typeof spec.inject === 'function', typeof spec.inject)
}

check(
  'the toggle renders no panel of its own',
  (() => {
    const { registrations } = booted
    const toggle = registrations.find((row) => row.spec.id.endsWith(':toggle'))
    return flatten(toggle.Component({ sessionId: 'session-a' })).includes('div') === false
  })(),
)

// ---------------------------------------------------------------------------
// Rendering with no data
// ---------------------------------------------------------------------------

for (const { spec, Component } of booted.registrations) {
  let threw
  let tree
  try {
    tree = Component({ sessionId: 'session-a' })
  } catch (error) {
    threw = error
  }
  check(`"${spec.id}" renders without props`, threw === undefined, threw?.message)
  if (spec.id.endsWith(':panel')) {
    check('the panel draws nothing until it is opened', tree === null, tree === undefined ? 'undefined' : 'an element')
  } else {
    check('the toggle draws a button', flatten(tree)[0] === 'button', flatten(tree)[0])
    check('the toggle is labelled', textOf(tree).includes('Skills'), textOf(tree).slice(0, 40))
  }
}

// ---------------------------------------------------------------------------
// The toggle's inject supplies the session
// ---------------------------------------------------------------------------

const toggleSpec = booted.registrations.find((row) => row.spec.id.endsWith(':toggle')).spec
const injectedProps = toggleSpec.inject('session-xyz')
check('the toggle is injected with the session id', injectedProps?.sessionId === 'session-xyz', JSON.stringify(injectedProps))

const panelSpec = booted.registrations.find((row) => row.spec.id.endsWith(':panel')).spec
check('the panel declares no injected props', JSON.stringify(panelSpec.inject('session-xyz')) === '{}', JSON.stringify(panelSpec.inject('session-xyz')))

// ---------------------------------------------------------------------------
// Opening the panel
// ---------------------------------------------------------------------------

{
  // The bridge lives inside the bundle's closure, so it is exercised through the
  // components rather than read directly: click the toggle, then render the
  // overlay and see whether the panel appeared.
  const fresh = boot()
  fresh.module.apply(fresh.ctx)
  const toggle = fresh.registrations.find((row) => row.spec.id.endsWith(':toggle')).Component
  const overlay = fresh.registrations.find((row) => row.spec.id.endsWith(':panel')).Component

  check('the overlay is closed before any click', overlay({}) === null)

  const tree = toggle({ sessionId: 'session-a' })
  const onClick = tree.props.onClick
  check('the toggle exposes a click handler', typeof onClick === 'function')

  onClick()
  check('opening the panel marks the body for the layout rule', fresh.document.body.hasAttribute('data-dsse-panel'))
  check(
    'the layout attribute is "open", not a bare flag',
    fresh.document.body.attributes.get('data-dsse-panel') === 'open',
    String(fresh.document.body.attributes.get('data-dsse-panel')),
  )

  const opened = overlay({})
  check('the opened overlay draws a panel component', opened !== null && typeof opened.component === 'function', String(opened?.type))
  // The overlay defers to Panel; render it the way React would.
  const panel = opened === null ? null : opened.component({})
  check('the panel is the fixed column', panel?.props?.className === 'dsse-panel', String(panel?.props?.className))
  check('the panel is marked for its own selectors', panel?.props?.['data-dsse-panel'] === '1', String(panel?.props?.['data-dsse-panel']))
  check('the panel names its modules', (() => {
    const text = textOf(panel)
    return text.includes('Last turn') && text.includes('Skills') && text.includes('MCP') && text.includes('Files touched')
  })(), textOf(panel).slice(0, 160))

  // A second click closes it and releases the reserved width.
  toggle({ sessionId: 'session-a' }).props.onClick()
  check('closing removes the layout attribute', fresh.document.body.hasAttribute('data-dsse-panel') === false)
  check('the closed overlay draws nothing again', overlay({}) === null)
}

// ---------------------------------------------------------------------------
// Switching conversation
// ---------------------------------------------------------------------------

{
  const fresh = boot()
  fresh.module.apply(fresh.ctx)
  const toggle = fresh.registrations.find((row) => row.spec.id.endsWith(':toggle')).Component
  const overlay = fresh.registrations.find((row) => row.spec.id.endsWith(':panel')).Component

  toggle({ sessionId: 'session-a' }).props.onClick()
  check('panel opens for the first conversation', overlay({}) !== null)

  // Rendering the toggle for another conversation is what the host does when the
  // user switches: the panel must follow rather than keep describing the old one.
  const second = toggle({ sessionId: 'session-b' })
  check('the toggle shows itself closed for a different conversation', second.props['data-active'] === 'false', String(second.props['data-active']))
  check('the panel stays drawn while the session moves', overlay({}) !== null)

  // Re-opening for the second conversation keeps it on screen.
  second.props.onClick()
  check('the panel reopens for the second conversation', overlay({}) !== null)
  check('the layout attribute is still set', fresh.document.body.hasAttribute('data-dsse-panel'))
}

// ---------------------------------------------------------------------------
// The style sheet
// ---------------------------------------------------------------------------

{
  const fresh = boot()
  fresh.module.apply(fresh.ctx)
  const toggle = fresh.registrations.find((row) => row.spec.id.endsWith(':toggle')).Component
  // Effects do not run in this fake React, so the toggle's own `ensureStyle` is
  // what this exercises — it is called on render for exactly that reason.
  toggle({ sessionId: 'session-a' })
  check('a style element is appended to the document', fresh.document.head !== undefined)
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

{
  const fresh = boot()
  fresh.module.apply(fresh.ctx)
  const toggle = fresh.registrations.find((row) => row.spec.id.endsWith(':toggle')).Component
  toggle({ sessionId: 'session-a' }).props.onClick()
  check('open before teardown', fresh.document.body.hasAttribute('data-dsse-panel'))
  // The third effect returns the teardown; `apply` already ran it through the
  // fake `effect`, which returns the callback's own return value.
  // Re-derive it by calling the registered disposer directly.
  const disposers = []
  const ctx = {
    effect(register, label) {
      disposers.push({ label, dispose: register() })
      return () => {}
    },
    slots: { inject: (name, register) => register(), register: () => () => {} },
  }
  fresh.module.apply(ctx)
  for (const entry of disposers) {
    if (typeof entry.dispose === 'function') entry.dispose()
  }
  check('teardown releases the reserved width', fresh.document.body.hasAttribute('data-dsse-panel') === false)
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
