/**
 * Regression tests for the defects a code review found after the panel's first
 * test pass was green.
 *
 * Every case here was a real defect that the existing suite could not see,
 * because the suite built its dependencies in a shape production never uses:
 * it passed `config: () => ({...})` as a plain function while `lib/index.js`
 * passes `{ get config() { return liveConfig() } }`. A test that constructs its
 * subject differently from the caller tests a different subject.
 *
 * So each test below builds the dependency object the way the plugin does, and
 * asserts the observable consequence rather than the fix's shape.
 */

import { Summariser } from '../lib/summarise.js'
import { createPanelApi, describeMcp, describeSkills } from '../lib/api.js'
import { HintChannel } from '../lib/hint.js'
import { TranscriptStore } from '../lib/transcript.js'

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

/** A response object that records what was written. */
function fakeRes() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writableEnded: false,
    destroyed: false,
    once() {
      return this
    },
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
      return this
    },
    end(body) {
      this.writableEnded = true
      this.body = body
      return this
    },
    destroy() {
      this.destroyed = true
      return this
    },
  }
}

function fakeReq(url, method = 'GET', body = undefined) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    url,
    method,
    headers: { host: '127.0.0.1:19387' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

// ---------------------------------------------------------------------------
// [P0] Dependencies must be usable in the shape lib/index.js passes them
// ---------------------------------------------------------------------------

{
  // Exactly how `lib/index.js` builds it: getters, not functions. Before the
  // fix every route answered `deps.config is not a function`.
  const live = { panelSummary: true, panelSide: 'left' }
  const deps = {
    get config() {
      return live
    },
    transcripts: new TranscriptStore(),
    summariser: { summarise: async () => ({ enabled: true }), reset: () => {} },
    execFor: () => ({}),
    skills: () => undefined,
    isOwned: () => false,
    cwdFor: () => process.cwd(),
    requestProposal: () => {},
    mcpTools: () => new Set(),
    modelCatalog: () => [],
    pendingCandidates: async () => 0,
    log: () => {},
  }

  const handler = createPanelApi(deps)
  const res = fakeRes()
  await handler(fakeReq('/api/skill-evolve/panel?agent=a'), res)
  const payload = JSON.parse(res.body)
  check('a getter-shaped config does not break the panel route', payload.ok === true, res.body)
  check('the panel route still names the agent', payload.data?.agent === 'a', res.body)

  const configRes = fakeRes()
  await handler(fakeReq('/api/skill-evolve/config'), configRes)
  const configPayload = JSON.parse(configRes.body)
  check('a getter-shaped config does not break the config route', configPayload.ok === true, configRes.body)
  check('the config route reflects the live value', configPayload.data.panelSummary === true, configRes.body)
}

{
  // The summariser receives `{ get llm() { return service('llm') } }`. Reading
  // it as a function made every summary fail with "this.llm is not a function".
  const llm = {
    listProviders: () => [{ id: 'prov-a' }],
    async listModels() {
      return [{ id: 'model-a' }]
    },
    async prepareCall(route) {
      return {
        config: { provider: route.provider, model: route.model },
        async *stream() {
          yield { type: 'text-delta', text: 'It ran the tests.' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const summariser = new Summariser({
    get config() {
      return { panelSummary: true }
    },
    get llm() {
      return llm
    },
  })
  const result = await summariser.summarise({
    agentId: 'a',
    snapshot: { turn: 1, calls: 2, failed: 0, paths: [], commands: [], tools: [{ name: 'bash', count: 2 }], said: 'done' },
  })
  check('a getter-shaped llm reaches the model', result.text === 'It ran the tests.', JSON.stringify(result))
  check('a getter-shaped config enables the summary', result.enabled === true, JSON.stringify(result))
}

// ---------------------------------------------------------------------------
// [P1] The panel's "propose" button must actually publish a hint
// ---------------------------------------------------------------------------

{
  const channel = new HintChannel({ maxHintsPerSession: 4 })
  let result
  let threw
  try {
    // `publish` spreads steps into the shown list. A number here threw
    // `0 is not iterable`, so the button failed every time it was pressed.
    result = channel.publish({
      agentId: 'a',
      signature: 'panel:any',
      steps: [],
      text: 'The person reading the sidebar asked whether this session produced a reusable skill.',
      pointer: undefined,
      kind: 'repeat',
    })
  } catch (error) {
    threw = error
  }
  check('publishing a hint with no steps does not throw', threw === undefined, String(threw))
  check('publishing a hint with no steps succeeds', result === 'published', String(result))
  check('the hint text reaches the model', channel.textFor('a').includes('reusable skill'), channel.textFor('a'))
}

{
  // And the defect itself, pinned: spreading a number is what threw.
  let threw = false
  try {
    // eslint-disable-next-line no-unused-expressions
    ;[...0]
  } catch {
    threw = true
  }
  check('a number is not spreadable, which is why steps had to be an array', threw === true)
}

// ---------------------------------------------------------------------------
// [P2] `owned` must be a boolean, even though resolving it is async
// ---------------------------------------------------------------------------

{
  const described = await describeSkills({
    skills: {
      async snapshot() {
        return { complete: true, skills: [{ name: 'alpha', description: 'a' }, { name: 'beta', description: 'b' }] }
      },
    },
    async isOwned(name) {
      return name === 'beta'
    },
    used: new Map([['alpha', 'tool'], ['beta', 'tool']]),
  })
  // Asserted by name, not index: the list is ordered by load recency, and this
  // block is about `owned`, not about ordering.
  const alpha = described.skills.find((row) => row.name === 'alpha')
  const beta = described.skills.find((row) => row.name === 'beta')
  check('an async isOwned resolves to a boolean', alpha?.owned === false, JSON.stringify(alpha))
  check('an async isOwned marks the owned skill true', beta?.owned === true, JSON.stringify(beta))
  check('no ownership field is a thenable', described.skills.every((row) => typeof row.owned === 'boolean'), JSON.stringify(described.skills))
}

{
  const described = await describeSkills({
    skills: { async snapshot() { return { skills: [{ name: 'alpha' }] } } },
    async isOwned() {
      throw new Error('the skill file is unreadable')
    },
    used: new Map([['alpha', 'tool']]),
  })
  check('a failing ownership probe does not fail the panel', described.available === true, JSON.stringify(described))
  check('a failing ownership probe reports not-owned', described.skills[0].owned === false, JSON.stringify(described.skills[0]))
}

{
  // A Promise in this field serialises to `{}`, which is truthy — so before the
  // fix every skill would have been badged as captured rather than none.
  const described = await describeSkills({
    skills: { async snapshot() { return { skills: [{ name: 'alpha' }] } } },
    isOwned: () => Promise.resolve(true),
    used: new Map([['alpha', 'tool']]),
  })
  check('a synchronous isOwned returning a Promise is awaited too', described.skills[0].owned === true, JSON.stringify(described.skills[0]))
}

// ---------------------------------------------------------------------------
// [P2] The MCP module must not be permanently empty
// ---------------------------------------------------------------------------

{
  // What the collector stores: full tool names.
  const described = describeMcp(new Set(['mcp__github__search_code', 'mcp__github__get_me', 'mcp__files__read']))
  check('full tool names produce servers', described.length === 2, JSON.stringify(described))
  check('the tool count is per server', described.find((row) => row.server === 'github')?.tools === 2, JSON.stringify(described))
}

{
  // The specificity test: a bare name must NOT be read as an MCP server.
  const described = describeMcp(new Set(['bash', 'read', 'github']))
  check('a bare tool name is not an MCP server', described.length === 0, JSON.stringify(described))
}

// ---------------------------------------------------------------------------
// [P2] A saved setting must come back in the shape the client stores
// ---------------------------------------------------------------------------

{
  const live = { panelSummary: true, panelSide: 'left' }
  const applied = []
  const deps = {
    get config() {
      return live
    },
    applyOverride(patch) {
      applied.push(patch)
      Object.assign(live, patch)
    },
    transcripts: new TranscriptStore(),
    summariser: { summarise: async () => ({ enabled: true }), reset: () => {} },
    execFor: () => ({}),
    skills: () => undefined,
    isOwned: () => false,
    cwdFor: () => process.cwd(),
    requestProposal: () => {},
    mcpTools: () => new Set(),
    modelCatalog: () => [],
    pendingCandidates: async () => 0,
    log: () => {},
  }
  const handler = createPanelApi(deps)
  const res = fakeRes()
  await handler(fakeReq('/api/skill-evolve/config', 'POST', JSON.stringify({ panelSummary: false })), res)
  const payload = JSON.parse(res.body)
  check('saving applies the patch', applied.length === 1 && applied[0].panelSummary === false, JSON.stringify(applied))
  check('the reply carries the config fields, not just a receipt', payload.data.panelSummary === false, res.body)
  check('the reply keeps the fields the patch did not touch', payload.data.panelSide === 'left', res.body)
  check('the reply still reports success', payload.data.ok === true, res.body)
}

{
  // With no override channel the reply still has to be the config shape, or the
  // client blanks its settings state on a failed save.
  const deps = {
    get config() {
      return { panelSummary: true, panelSide: 'left' }
    },
    transcripts: new TranscriptStore(),
    summariser: { summarise: async () => ({ enabled: true }), reset: () => {} },
    log: () => {},
  }
  const handler = createPanelApi(deps)
  const res = fakeRes()
  await handler(fakeReq('/api/skill-evolve/config', 'POST', JSON.stringify({ panelSummary: false })), res)
  const payload = JSON.parse(res.body)
  check('a refused save still returns the config shape', payload.data.panelSummary === true, res.body)
  check('a refused save says why', typeof payload.data.reason === 'string', res.body)
}

// ---------------------------------------------------------------------------
// [P2] A rejecting model catalogue must degrade, not break the panel
// ---------------------------------------------------------------------------

{
  const llm = {
    listProviders: () => [{ id: 'prov-a' }],
    async listModels() {
      throw new Error('the catalogue is unreachable')
    },
    // Without this, `run` bails at "no model service available" and the
    // rejection path this test is named after is never reached.
    async prepareCall() {
      throw new Error('the model must not be called when no route resolved')
    },
  }
  const summariser = new Summariser({
    config: () => ({ panelSummary: true }),
    llm: () => llm,
  })
  let threw
  let result
  try {
    result = await summariser.summarise({
      agentId: 'a',
      snapshot: { turn: 1, calls: 1, failed: 0, paths: [], commands: [], tools: [{ name: 'bash', count: 1 }], said: 'x' },
    })
  } catch (error) {
    threw = error
  }
  check('a rejecting model catalogue does not throw', threw === undefined, String(threw))
  check('a rejecting model catalogue reports no route', String(result?.reason).includes('no model route'), JSON.stringify(result))
}

// ---------------------------------------------------------------------------
// [P2] Transcripts must be released with the agent
// ---------------------------------------------------------------------------

{
  const store = new TranscriptStore()
  store.record('a', { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'hi' }] } } })
  check('a transcript exists before disposal', store.view('a') !== undefined)
  store.forget('a')
  check('forget releases the transcript', store.view('a') === undefined)
}

// ---------------------------------------------------------------------------
// The empty-turn guard has to survive the render, not just the config
// ---------------------------------------------------------------------------

{
  const llm = {
    listProviders: () => [{ id: 'p' }],
    async listModels() {
      return [{ id: 'm' }]
    },
    async prepareCall() {
      throw new Error('the model must not be called for an empty turn')
    },
  }
  const summariser = new Summariser({ config: () => ({ panelSummary: true }), llm: () => llm })
  const result = await summariser.summarise({
    agentId: 'a',
    snapshot: { turn: 2, calls: 0, failed: 0, paths: [], commands: [], tools: [], said: '' },
  })
  check('an empty turn never reaches the model', String(result.reason).includes('nothing to summarise'), JSON.stringify(result))
}

// ---------------------------------------------------------------------------
// [P2] A mis-wired dependency must be an error, not a preference
// ---------------------------------------------------------------------------

{
  // Production passes `config: () => liveConfig()`. A guard that inspects the
  // dependency only ever sees a function, so it has to run on the result — which
  // is what this case checks by making the getter return a primitive.
  const deps = {
    config: () => 'oops',
    transcripts: new TranscriptStore(),
    summariser: { summarise: async () => ({ enabled: true }), reset: () => {} },
    execFor: () => ({}),
    skills: () => undefined,
    isOwned: () => false,
    cwdFor: () => process.cwd(),
    requestProposal: () => {},
    mcpTools: () => new Set(),
    modelCatalog: () => [],
    pendingCandidates: async () => 0,
    log: () => {},
  }

  const handler = createPanelApi(deps)

  const panelRes = fakeRes()
  await handler(fakeReq('/api/skill-evolve/panel?agent=a'), panelRes)
  const panelPayload = JSON.parse(panelRes.body)
  check(
    'a getter returning a primitive is an internal error, not "off in settings"',
    panelPayload.ok === false && panelPayload.code === 'error.internal',
    panelRes.body,
  )

  const configRes = fakeRes()
  await handler(fakeReq('/api/skill-evolve/config'), configRes)
  const configPayload = JSON.parse(configRes.body)
  check(
    'the config route reports the same wiring mistake',
    configPayload.ok === false && configPayload.code === 'error.internal',
    configRes.body,
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
