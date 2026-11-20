/**
 * Tests for the warmed summary: the panel's one model call moved to the moment
 * the turn ends.
 *
 * `Summariser.warm` used to be dead code. Its doc promised "start writing a
 * summary before anybody asks for one", and nothing in production called it, so
 * the first person to open the panel after a turn paid for the model call inside
 * their own request — up to the summariser's 20-second timeout. These tests pin
 * the wiring rather than the method: they drive `apply` with a real host, emit
 * the events the host emits, and count model calls.
 *
 * A test of `warm` in isolation would have passed all along. That is the point.
 */

import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { apply as applyPanel, Config as PanelConfig } from '../packages/ui-evolve/lib/index.js'

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

/** A model service whose calls are counted, and which answers with `text`. */
function countingLlm(text = 'It ran the tests.') {
  const log = { prepared: 0 }
  return {
    log,
    listProviders: () => [{ id: 'prov-a' }],
    async listModels() {
      return [{ id: 'model-a', name: 'A' }]
    },
    async prepareCall() {
      log.prepared += 1
      return { stream: () => chunks([{ type: 'text-delta', text }, { type: 'finish', finish: { kind: 'stop' } }]) }
    }
  }
}

async function* chunks(list) {
  for (const chunk of list) yield chunk
}

/**
 * The services this plugin reaches for, in the shape `apply` uses.
 *
 * `get` answers per name so a test can raise or drop a single service without
 * building a whole host, and `inject` runs the callback when every named service
 * is present — which is the timing that decides whether the panel registers its
 * route at all.
 */
function fakeHost({ llm } = {}) {
  const handlers = new Map()
  const routes = []
  const agents = new Map()
  const provided = new Map()
  // Services that exist in the runtime but are not resolvable yet. A lenient
  // lookup still reports them, which is how the admission gate detects a boot
  // window instead of mistaking it for a host that has no such service.
  const pending = new Map()
  if (llm !== undefined) provided.set('llm', llm)
  const ctx = {
    tools: { register: (tool) => () => void tool },
    commands: { register: (command) => () => void command },
    systemPrompt: { context: (entry) => () => void entry },
    webServer: { register: (route) => (routes.push(route), () => {}) },
    provide(name, value) {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    // A service that is installed but whose provider fiber has not settled yet
    // reads as absent under a strict lookup and as present under a lenient one --
    // that is the boot window the admission gate has to tell apart from a host
    // that simply has no such service.
    get: (name, strict = true) => {
      if (name === 'agents') return { get: (id) => agents.get(id) }
      const value = provided.get(name)
      if (value !== undefined) return value
      if (strict !== false) return undefined
      return pending.get(name)
    },
    inject(names, callback) {
      if (names.some((name) => ctx[name] === undefined && provided.get(name) === undefined)) return undefined
      return callback(ctx)
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  }
  return {
    ctx,
    routes,
    agents,
    handlers,
    provided,
    pending,
    emit(event, ...payload) {
      for (const handler of handlers.get(event) ?? []) handler(...payload)
    }
  }
}

/** An agent with the session shape the transcript store reads. */
function fakeAgent(id, cwd) {
  const events = []
  return {
    id,
    session: {
      id,
      header: { id, cwd, version: 4, createdAt: Date.now(), isSeeded: false },
      ownEvents: () => events,
      snapshotEvents: () => events,
      log: events,
      // `routeFor` reads this; a session that has made a request has a route.
      requestContext: () => ({ provider: 'prov-a', model: 'model-a' })
    },
    push(event) {
      events.push(event)
      return event
    }
  }
}

/**
 * Drive one whole turn through the host, one event at a time.
 *
 * Each event is delivered on its own, in the order the host delivers them. A
 * transcription that pushed all four and delivered only `turn/end` would leave
 * the turn with no request and no reply — and an empty turn is deliberately
 * never sent to the model, so the warm-up would be skipped for a reason that has
 * nothing to do with the code under test.
 */
function playTurn(host, agent, turn, { reason = { kind: 'completed' }, text = 'I ran the tests.' } = {}) {
  const events = [
    { type: 'turn/start', seq: turn * 10, data: { turn } },
    {
      type: 'user/message',
      seq: turn * 10 + 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'run the tests' }] }
    },
    // `record` reads the reply from `data.message.content`, which is the shape
    // the host emits.
    { type: 'assistant/message', seq: turn * 10 + 2, data: { message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', seq: turn * 10 + 3, data: { reason } }
  ]
  for (const event of events) {
    agent.push(event)
    host.emit('session/event', agent.session, event)
  }
}

async function makeRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  process.env.DSH_HOME = root
  await mkdir(join(root, 'plugin-data', 'skill-evolve'), { recursive: true })
  return root
}

/** Open the panel once, so the summariser counts this session as watched. */
async function openPanel(host, agentId) {
  const route = host.routes.find((candidate) => candidate.handler !== undefined)
  const res = {
    statusCode: undefined,
    writableEnded: false,
    destroyed: false,
    once() {
      return res
    },
    writeHead(code) {
      res.statusCode = code
      return res
    },
    end() {
      res.writableEnded = true
      return res
    }
  }
  // The loopback `host` header is not decoration: the route refuses a request
  // without it (`error.origin.forbidden`), and a refused panel never marks the
  // session watched — which would leave the warm-up correctly switched off for a
  // reason that has nothing to do with the code under test.
  await route.handler(
    { url: `/api/ui-evolve/panel?agent=${encodeURIComponent(agentId)}`, method: 'GET', headers: { host: '127.0.0.1:19387' } },
    res
  )
  if (res.statusCode !== 200) throw new Error(`opening the panel answered ${res.statusCode}`)
  return res
}

/** Let the fire-and-forget warm-up finish before counting. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

console.log('warm.js — the summary is written when the turn ends, not when the panel opens')

// ---------------------------------------------------------------------------
// The wiring itself: a finished turn reaches the model without anybody asking
// ---------------------------------------------------------------------------

{
  await makeRoot('skill-evolve-warm-')
  const llm = countingLlm()
  const host = fakeHost({ llm })
  applyPanel(host.ctx, PanelConfig({ panelSummary: true }))
  const agent = fakeAgent('session-warm', 'F:/proj')
  host.agents.set(agent.id, agent)

  // Nobody has looked at this session, so the gate must hold: a host running
  // background sessions must not pay a model call per turn for each of them.
  playTurn(host, agent, 1)
  await settle()
  check('a session nobody has opened is not warmed', llm.log.prepared === 0, `${llm.log.prepared} call(s)`)

  await openPanel(host, agent.id)
  // No assertion here. "The panel opened" cannot be checked from this side: the
  // route list proves only that applying the plugin registered a route, which
  // stays true with `markViewed` deleted. The load-bearing observation is the
  // next finished turn warming — that is the gate opening, and it is the delta
  // asserted immediately below.

  // The next finished turn is the moment worth paying for. Counted as a delta,
  // not a total: opening the panel above already paid for turn 1, so a total
  // would read "at least one call" whether or not this turn warmed anything —
  // an assertion that can only fail if the whole feature is missing.
  const beforeTurn = llm.log.prepared
  playTurn(host, agent, 2)
  await settle()
  check(
    'a watched session is warmed when its turn ends',
    llm.log.prepared === beforeTurn + 1,
    `${llm.log.prepared} after ${beforeTurn}`
  )

  // And the panel now answers from the cache rather than paying again.
  const before = llm.log.prepared
  await openPanel(host, agent.id)
  await settle()
  check('the panel does not pay twice for the turn it warmed', llm.log.prepared === before, `${llm.log.prepared} vs ${before}`)
}

// ---------------------------------------------------------------------------
// An abandoned turn is not a turn worth describing
// ---------------------------------------------------------------------------

{
  await makeRoot('skill-evolve-warm-abandoned-')
  const llm = countingLlm()
  const host = fakeHost({ llm })
  applyPanel(host.ctx, PanelConfig({ panelSummary: true }))
  const agent = fakeAgent('session-abandoned', 'F:/proj')
  host.agents.set(agent.id, agent)
  await openPanel(host, agent.id)
  const before = llm.log.prepared

  // `endTurn` clears an abandoned turn and sets no `previous`, so there is no
  // finished turn to describe. The warm-up must not invent one.
  playTurn(host, agent, 1, { reason: { kind: 'aborted' } })
  await settle()
  check('an abandoned turn is not warmed', llm.log.prepared === before, `${llm.log.prepared} vs ${before}`)
}

// ---------------------------------------------------------------------------
// The gate must be released with the session, or it stops being a gate
// ---------------------------------------------------------------------------

{
  await makeRoot('skill-evolve-warm-forget-')
  const llm = countingLlm()
  const host = fakeHost({ llm })
  applyPanel(host.ctx, PanelConfig({ panelSummary: true }))
  const agent = fakeAgent('session-forgotten', 'F:/proj')
  host.agents.set(agent.id, agent)
  await openPanel(host, agent.id)

  // Disposal releases every per-session record. The summariser's watched-set is
  // one of them: left behind, the question stops being "is somebody watching"
  // and becomes "did anybody ever open it".
  host.emit('agent/disposed', { agent })
  await settle()

  const before = llm.log.prepared
  playTurn(host, agent, 2)
  await settle()
  check('a disposed session is not warmed any more', llm.log.prepared === before, `${llm.log.prepared} vs ${before}`)
}

// ---------------------------------------------------------------------------
// The setting still wins: no summary configured, no money spent
// ---------------------------------------------------------------------------

{
  await makeRoot('skill-evolve-warm-off-')
  const llm = countingLlm()
  const host = fakeHost({ llm })
  applyPanel(host.ctx, PanelConfig({ panelSummary: false }))
  const agent = fakeAgent('session-off', 'F:/proj')
  host.agents.set(agent.id, agent)
  await openPanel(host, agent.id)

  playTurn(host, agent, 1)
  await settle()
  check('a disabled summary is never warmed', llm.log.prepared === 0, `${llm.log.prepared} call(s)`)
}

// ---------------------------------------------------------------------------
// A host with no model service must not break the turn
// ---------------------------------------------------------------------------

{
  await makeRoot('skill-evolve-warm-nollm-')
  const host = fakeHost()
  applyPanel(host.ctx, PanelConfig({ panelSummary: true }))
  const agent = fakeAgent('session-nollm', 'F:/proj')
  host.agents.set(agent.id, agent)
  await openPanel(host, agent.id)

  let threw
  try {
    playTurn(host, agent, 1)
    await settle()
  } catch (error) {
    threw = error
  }
  check('a host without a model service still finishes the turn', threw === undefined, String(threw))
}

// ---------------------------------------------------------------------------
// The summary survives the process that paid for it
// ---------------------------------------------------------------------------
//
// The whole point of storing the text is that a restart must not buy it again.
// Every other test in this repo runs inside one process, so every one of them
// passes with the dependency wired to nothing: `stored` defaults to "never
// anything there" and `persist` defaults to "throw it away". Only a second
// `apply` over the same home directory can tell the difference.

{
  const root = await makeRoot('skill-evolve-warm-restart-')
  const first = countingLlm()
  const before = fakeHost({ llm: first })
  applyPanel(before.ctx, PanelConfig({ panelSummary: true }))
  const agent = fakeAgent('session-restart', 'F:/proj')
  before.agents.set(agent.id, agent)
  await openPanel(before, agent.id)

  playTurn(before, agent, 1)
  await settle()
  check('the first process paid for the turn', first.log.prepared >= 1, `${first.log.prepared} call(s)`)

  // `rememberSummary` goes through the store's one-second coalescing timer, so
  // the file does not exist the moment the model answers. Waiting is the honest
  // version of this test; reaching into the store to flush it would assert on a
  // private path the production code never takes.
  await new Promise((resolve) => setTimeout(resolve, 1400))

  // A second process: new host, new summariser, new in-memory cache, same disk.
  const second = countingLlm()
  const after = fakeHost({ llm: second })
  applyPanel(after.ctx, PanelConfig({ panelSummary: true }))
  const again = fakeAgent('session-restart', 'F:/proj')
  again.push({ type: 'turn/start', seq: 10, data: { turn: 1 } })
  again.push({ type: 'user/message', seq: 11, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'run the tests' }] } })
  again.push({ type: 'assistant/message', seq: 12, data: { message: { content: [{ type: 'text', text: 'I ran the tests.' }] } } })
  again.push({ type: 'turn/end', seq: 13, data: { reason: { kind: 'completed' } } })
  after.agents.set(again.id, again)

  await openPanel(after, again.id)
  await settle()
  check(
    'a restarted process answers the same turn without paying again',
    second.log.prepared === 0,
    `${second.log.prepared} call(s) after the restart`
  )

  // And the text is the one that was stored, not an empty convenience answer.
  const route = after.routes.find((candidate) => candidate.handler !== undefined)
  let body = ''
  const res = {
    statusCode: undefined,
    writableEnded: false,
    destroyed: false,
    once() { return res },
    writeHead(code) { res.statusCode = code; return res },
    end(chunk) { body = String(chunk ?? ''); res.writableEnded = true; return res }
  }
  await route.handler(
    { url: `/api/ui-evolve/panel?agent=${encodeURIComponent(again.id)}`, method: 'GET', headers: { host: '127.0.0.1:19387' } },
    res
  )
  const payload = JSON.parse(body)
  check(
    'the text that survived is the text the old process bought',
    payload?.data?.summary?.text === 'It ran the tests.',
    JSON.stringify(payload?.data?.summary)
  )

  void root
}

// ---------------------------------------------------------------------------
// The admission gate, through the production wiring rather than a stub
// ---------------------------------------------------------------------------
//
// `test/api.test.mjs` covers the gate itself by handing `createPanelApi` an
// `admission` function. That says nothing about whether the plugin ever supplies
// one: every one of those cases would still pass with `admission()` deleted from
// `index.js`. This block asks the wired route instead.

{
  await makeRoot('skill-evolve-warm-gate-')
  const host = fakeHost({ llm: countingLlm() })
  applyPanel(host.ctx, PanelConfig({ panelSummary: true }))
  const agent = fakeAgent('session-gate', 'F:/proj')
  host.agents.set(agent.id, agent)

  const ask = async (admission) => {
    const route = host.routes.find((candidate) => candidate.handler !== undefined)
    const res = {
      statusCode: undefined,
      writableEnded: false,
      destroyed: false,
      once() { return res },
      writeHead(code) { res.statusCode = code; return res },
      end() { res.writableEnded = true; return res }
    }
    await route.handler(
      { url: `/api/ui-evolve/panel?agent=${encodeURIComponent(agent.id)}`, method: 'GET', headers: { host: '127.0.0.1:19387' } },
      res
    )
    return res.statusCode
  }

  // A host that does have a connection service says no: the route must relay it.
  host.provided.set('connection', { requestRejection: () => 401 })
  check('a refusal from the host reaches the client', (await ask()) === 401, 'the route answered without the host')

  host.provided.set('connection', { requestRejection: () => undefined })
  check('and a host that allows the request is served', (await ask()) === 200, 'the route refused an allowed request')

  // A connection service that exists but is not resolvable yet is a boot window,
  // not a host without one. Serving the panel open for that interval is the hole
  // the gate closes, so it must not be mistaken for "nobody to ask".
  host.provided.delete('connection')
  host.pending.set('connection', { requestRejection: () => undefined })
  check('a service that is not ready yet is not read as absent', (await ask()) === 503, 'the route served a boot window open')

  // And a host that genuinely has no connection service still gets its panel.
  host.pending.delete('connection')
  check('a host without the service still has a panel', (await ask()) === 200, 'the optional dependency became required')
}

console.log(`\n${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
if (failed > 0) process.exitCode = 1
