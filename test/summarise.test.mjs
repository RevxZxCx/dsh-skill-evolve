/**
 * Tests for the summariser, the one module that spends money.
 *
 * Most of these are about *not* calling the model: a disabled panel, an empty
 * turn, a repeated repaint, and four concurrent requests for the same turn all
 * have to end with at most one call. The rest pin the failure paths, because a
 * sidebar that throws when the model route is unset would break the panel it is
 * supposed to populate.
 */

import {
  MAX_SUMMARY_CHARS,
  SYSTEM_PROMPT,
  Summariser,
  collectText,
  finishFailure,
  renderPromptBody,
  summaryKey
} from '../lib/summarise.js'

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

/** Build a chunk stream from a list of chunks. */
async function* stream(chunks) {
  for (const chunk of chunks) yield chunk
}

/**
 * A fake llm service that records calls.
 *
 * @param {object} [options] - behaviour switches.
 * @returns {object} the fake service plus its call log.
 */
function fakeLlm({ chunks = [{ type: 'text-delta', text: 'A summary.' }], finish = { kind: 'stop' }, providers = [{ id: 'prov-a' }], models = [{ id: 'model-a', name: 'A' }], prepareThrows = undefined, streamThrows = undefined } = {}) {
  const log = { prepare: [], listProviders: 0, listModels: [] }
  return {
    log,
    listProviders() {
      log.listProviders += 1
      return providers
    },
    async listModels(provider) {
      log.listModels.push(provider)
      return models
    },
    async prepareCall(route, signal) {
      log.prepare.push(route)
      if (prepareThrows !== undefined) throw prepareThrows
      return {
        config: { provider: route.provider, model: route.model, maxTokens: route.maxTokens },
        async *stream(options) {
          log.stream = options
          if (streamThrows !== undefined) throw streamThrows
          yield* stream(chunks.map((chunk) => (chunk.type === 'finish' ? chunk : chunk)))
          yield { type: 'finish', reason: finish }
          signal?.throwIfAborted?.()
        },
      }
    },
  }
}

const snapshot = {
  turn: 3,
  calls: 4,
  failed: 1,
  paths: ['F:/a.js'],
  commands: ['npm test'],
  tools: [{ name: 'bash', count: 3 }, { name: 'edit', count: 1 }],
  said: 'The test fails because the fixture is stale.',
}

// ---------------------------------------------------------------------------
// collectText
// ---------------------------------------------------------------------------

{
  const { text, finish } = await collectText(stream([{ type: 'text-delta', text: 'one ' }, { type: 'text-delta', text: 'two' }, { type: 'finish', reason: { kind: 'stop' } }]), undefined)
  check('text deltas are joined', text === 'one two', String(text))
  check('the finish reason is captured', finish.kind === 'stop', JSON.stringify(finish))
}

{
  const { text, finish } = await collectText(stream([{ type: 'other', data: 1 }]), undefined)
  check('non-text chunks contribute nothing', text === '', String(text))
  check('an absent finish stays undefined', finish === undefined, JSON.stringify(finish))
}

{
  const controller = new AbortController()
  controller.abort()
  let threw = false
  try {
    await collectText(stream([{ type: 'text-delta', text: 'x' }]), controller.signal)
  } catch {
    threw = true
  }
  check('an aborted signal stops the read', threw === true)
}

// ---------------------------------------------------------------------------
// finishFailure
// ---------------------------------------------------------------------------

check('a clean finish is not a failure', finishFailure({ kind: 'stop' }) === undefined, String(finishFailure({ kind: 'stop' })))
check('an absent finish is not a failure', finishFailure(undefined) === undefined)
check('a null finish is not a failure', finishFailure(null) === undefined)
check('a token cap is not a failure', finishFailure({ kind: 'max-tokens' }) === undefined, String(finishFailure({ kind: 'max-tokens' })))
check('an error finish reports its message', finishFailure({ kind: 'error', failure: { message: 'rate limited' } }) === 'rate limited', String(finishFailure({ kind: 'error', failure: { message: 'rate limited' } })))
check('an error finish without a message reports the kind', finishFailure({ kind: 'error' }) === 'error', String(finishFailure({ kind: 'error' })))
check('an abort finish is a failure', finishFailure({ kind: 'aborted' }) === 'aborted', String(finishFailure({ kind: 'aborted' })))

// ---------------------------------------------------------------------------
// renderPromptBody
// ---------------------------------------------------------------------------

{
  const body = renderPromptBody(snapshot)
  check('the body reports the call count', body.includes('4 total'), body)
  check('the body reports the failure count', body.includes('1 failed'), body)
  check('the body tallies tools', body.includes('bash×3'), body)
  check('the body lists edited files', body.includes('F:/a.js'), body)
  check('the body lists commands', body.includes('npm test'), body)
  check('the body carries the assistant text', body.includes('fixture is stale'), body)
}

{
  // A turn that did nothing must render *nothing*: an empty body is what makes
  // 'summarise' skip the model call, so emitting a '0 total' line here would
  // turn every silent turn into a paid request.
  const body = renderPromptBody({ turn: 1, calls: 0, failed: 0, paths: [], commands: [], tools: [], said: '' })
  check('an empty turn renders an empty body', body === '', body)
  check('an empty turn mentions no files', body.includes('Files edited') === false, body)
}

check('a non-object snapshot renders nothing', renderPromptBody(undefined) === '', String(renderPromptBody(undefined)))
check('a null snapshot renders nothing', renderPromptBody(null) === '')
check('a string snapshot renders nothing', renderPromptBody('nope') === '')

{
  const many = renderPromptBody({ turn: 1, calls: 1, failed: 0, paths: Array.from({ length: 20 }, (_, i) => `F:/f${i}.js`), commands: [], tools: [], said: '' })
  check('a long file list is truncated with a count', many.includes('+8 more'), many)
}

{
  const huge = renderPromptBody({ turn: 1, calls: 1, failed: 0, paths: [], commands: [], tools: [], said: 'y'.repeat(9000) })
  check('a huge transcript is truncated', huge.length <= 6000, String(huge.length))
}

{
  const body = renderPromptBody({ turn: 1, calls: 1, failed: 0, paths: [undefined, 42, 'F:/real.js'], commands: [null, 'ls'], tools: [], said: '' })
  check('non-string paths are filtered', body.includes('F:/real.js') && body.includes('undefined') === false, body)
}

// ---------------------------------------------------------------------------
// summaryKey
// ---------------------------------------------------------------------------

check('the same turn and body give the same key', summaryKey(3, 'abc') === summaryKey(3, 'abc'), summaryKey(3, 'abc'))
check('a different turn gives a different key', summaryKey(3, 'abc') !== summaryKey(4, 'abc'))
check('a different body gives a different key', summaryKey(3, 'abc') !== summaryKey(3, 'abd'))
check('a missing turn is represented', summaryKey(undefined, 'abc').startsWith('?:'), summaryKey(undefined, 'abc'))

// ---------------------------------------------------------------------------
// resolveRoute
// ---------------------------------------------------------------------------

{
  const summariser = new Summariser({ llm: () => undefined, config: () => ({ summaryProvider: 'p', summaryModel: 'm' }) })
  const route = await summariser.resolveRoute()
  check('a pinned route is used verbatim', route.provider === 'p' && route.model === 'm', JSON.stringify(route))
  check('a pinned route is marked pinned', route.pinned === true, JSON.stringify(route))
}

{
  const llm = fakeLlm()
  const summariser = new Summariser({ llm: () => llm, config: () => ({}) })
  const route = await summariser.resolveRoute()
  check('an unpinned route falls back to the first provider', route.provider === 'prov-a', JSON.stringify(route))
  check('an unpinned route falls back to the first model', route.model === 'model-a', JSON.stringify(route))
  check('a fallback route is marked unpinned', route.pinned === false, JSON.stringify(route))
}

{
  const summariser = new Summariser({ llm: () => fakeLlm({ providers: [] }), config: () => ({}) })
  check('no providers means no route', (await summariser.resolveRoute()) === undefined)
}

{
  const summariser = new Summariser({ llm: () => fakeLlm({ models: [] }), config: () => ({}) })
  check('no models means no route', (await summariser.resolveRoute()) === undefined)
}

{
  const summariser = new Summariser({ llm: () => ({ listProviders: () => [{ id: '' }] }), config: () => ({}) })
  check('a provider without an id means no route', (await summariser.resolveRoute()) === undefined)
}

{
  const summariser = new Summariser({ llm: () => ({ listProviders: () => [{ id: 'p' }], listModels: async () => [{ name: 'no id' }] }), config: () => ({}) })
  check('a model without an id means no route', (await summariser.resolveRoute()) === undefined)
}

{
  const summariser = new Summariser({ llm: () => ({ listProviders: () => [{ id: 'p' }] }), config: () => ({}) })
  check('a provider list without listModels means no route', (await summariser.resolveRoute()) === undefined)
}

{
  // A host that rejects when asked for its catalogue is a host we cannot route
  // on. Degrading to "no route" keeps the panel working; throwing would turn a
  // model-list hiccup into a broken sidebar.
  const summariser = new Summariser({
    llm: () => ({ listProviders: () => [{ id: 'p' }], listModels: async () => { throw new Error('catalogue down') } }),
    config: () => ({}),
  })
  let threw = null
  let route
  try {
    route = await summariser.resolveRoute()
  } catch (error) {
    threw = error
  }
  check('a rejecting catalogue degrades instead of throwing', threw === null && route === undefined, String(threw))
}

{
  // The same catch must not swallow a cancellation. An abort is the caller
  // saying "stop", and reporting "no model route is available" instead would
  // make a cancelled summary look like a broken host.
  const controller = new AbortController()
  controller.abort()
  const summariser = new Summariser({
    llm: () => ({
      listProviders: () => [{ id: 'p' }],
      listModels: async () => {
        controller.signal.throwIfAborted()
        throw new Error('unreachable')
      },
    }),
    config: () => ({}),
  })
  let threw = null
  try {
    await summariser.resolveRoute(controller.signal)
  } catch (error) {
    threw = error
  }
  check('an abort reaches the caller instead of becoming "no route"', threw?.name === 'AbortError', String(threw))
}

{
  const summariser = new Summariser({ llm: () => fakeLlm(), config: () => ({ summaryProvider: 'only-provider' }) })
  const route = await summariser.resolveRoute()
  check('a half-configured pair falls back rather than half-using it', route.pinned === false, JSON.stringify(route))
}

// ---------------------------------------------------------------------------
// summarise: the cheap paths
// ---------------------------------------------------------------------------

{
  const llm = fakeLlm()
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: false }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot })
  check('a disabled panel reports disabled', result.enabled === false, JSON.stringify(result))
  check('a disabled panel calls no model', llm.log.prepare.length === 0, String(llm.log.prepare.length))
}

{
  const llm = fakeLlm()
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot: undefined })
  check('no finished turn reports a reason', String(result.reason).includes('no completed turn'), JSON.stringify(result))
  check('no finished turn calls no model', llm.log.prepare.length === 0, String(llm.log.prepare.length))
}

{
  const llm = fakeLlm()
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot: { turn: 1, calls: 0, failed: 0, paths: [], commands: [], tools: [], said: '' } })
  check('an empty turn reports nothing to summarise', String(result.reason).includes('nothing to summarise'), JSON.stringify(result))
  check('an empty turn calls no model', llm.log.prepare.length === 0, String(llm.log.prepare.length))
}

// ---------------------------------------------------------------------------
// summarise: the call itself
// ---------------------------------------------------------------------------

{
  const llm = fakeLlm()
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot })
  check('a summary is returned', result.text === 'A summary.', JSON.stringify(result))
  check('the summary names its model', result.model === 'prov-a/model-a', String(result.model))
  check('one model call is made', llm.log.prepare.length === 1, String(llm.log.prepare.length))
  check('the call names the chosen route', llm.log.prepare[0].provider === 'prov-a' && llm.log.prepare[0].model === 'model-a', JSON.stringify(llm.log.prepare[0]))
  check('the call sets a purpose', llm.log.stream.purpose === 'skill-evolve-panel-summary', String(llm.log.stream.purpose))
  check('the call sends the system prompt', llm.log.stream.system === SYSTEM_PROMPT, String(llm.log.stream.system))
  check('the call tags its message source', llm.log.stream.messages[0].source.kind === 'dsh-skill-evolve-panel', JSON.stringify(llm.log.stream.messages[0].source))
  check('the prompt body reaches the model', llm.log.stream.messages[0].content[0].text.includes('bash×3'), llm.log.stream.messages[0].content[0].text)
}

{
  // The whole reason the cache exists: the panel repaints on every stream
  // chunk, and each repaint re-requests the same turn.
  const llm = fakeLlm()
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const first = await summariser.summarise({ agentId: 'a', snapshot })
  const second = await summariser.summarise({ agentId: 'a', snapshot })
  check('a repeated request is served from cache', second.cached === true, JSON.stringify(second))
  check('a repeated request costs one call in total', llm.log.prepare.length === 1, String(llm.log.prepare.length))
  check('the cached text equals the first answer', second.text === first.text, `${second.text} vs ${first.text}`)
}

{
  const llm = fakeLlm()
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const [a, b, c] = await Promise.all([
    summariser.summarise({ agentId: 'a', snapshot }),
    summariser.summarise({ agentId: 'a', snapshot }),
    summariser.summarise({ agentId: 'a', snapshot }),
  ])
  check('three concurrent requests share one call', llm.log.prepare.length === 1, String(llm.log.prepare.length))
  check('all three concurrent callers get the text', a.text === b.text && b.text === c.text, `${a.text}/${b.text}/${c.text}`)
}

{
  const llm = fakeLlm()
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  await summariser.summarise({ agentId: 'a', snapshot })
  await summariser.summarise({ agentId: 'a', snapshot: { ...snapshot, turn: 4 } })
  check('a new turn costs a new call', llm.log.prepare.length === 2, String(llm.log.prepare.length))
}

{
  const llm = fakeLlm()
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  await summariser.summarise({ agentId: 'a', snapshot })
  summariser.reset()
  const again = await summariser.summarise({ agentId: 'a', snapshot })
  check('reset clears the cache', again.cached === undefined, JSON.stringify(again))
  check('reset makes the next request pay again', llm.log.prepare.length === 2, String(llm.log.prepare.length))
}

{
  const llm = fakeLlm()
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  await summariser.summarise({ agentId: 'a', snapshot })
  const other = await summariser.summarise({ agentId: 'b', snapshot })
  check('two agents do not share a cache entry', other.cached === undefined, JSON.stringify(other))
  check('two agents cost two calls', llm.log.prepare.length === 2, String(llm.log.prepare.length))
}

// ---------------------------------------------------------------------------
// summarise: failure paths
// ---------------------------------------------------------------------------

{
  const summariser = new Summariser({ llm: () => undefined, config: () => ({ panelSummary: true }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot })
  check('a host without a model service says so', String(result.reason).includes('no model service'), JSON.stringify(result))
  check('a host without a model service does not throw', result.enabled === true, JSON.stringify(result))
}

{
  const llm = fakeLlm({ providers: [] })
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot })
  check('no route is reported as a reason', String(result.reason).includes('no model route'), JSON.stringify(result))
  check('no route makes no call', llm.log.prepare.length === 0, String(llm.log.prepare.length))
}

{
  const llm = fakeLlm({ prepareThrows: new Error('provider offline') })
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot })
  check('a failed call is reported, not thrown', String(result.reason).includes('provider offline'), JSON.stringify(result))
}

{
  const llm = fakeLlm({ streamThrows: new Error('stream broke') })
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot })
  check('a broken stream is reported, not thrown', String(result.reason).includes('stream broke'), JSON.stringify(result))
}

{
  const llm = fakeLlm({ chunks: [], finish: { kind: 'error', failure: { message: 'quota exceeded' } } })
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot })
  check('an error finish is reported as a failed call', String(result.reason).includes('quota exceeded'), JSON.stringify(result))
}

{
  const llm = fakeLlm({ chunks: [{ type: 'text-delta', text: '   ' }] })
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot })
  check('whitespace-only output is not a summary', String(result.reason).includes('returned nothing'), JSON.stringify(result))
  check('whitespace-only output is not cached', summariser.cache.size === 0, String(summariser.cache.size))
}

{
  const llm = fakeLlm({ chunks: [{ type: 'text-delta', text: 'q'.repeat(MAX_SUMMARY_CHARS + 200) }] })
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot })
  check('a long summary is cut to the cap', result.text.length === MAX_SUMMARY_CHARS, String(result.text.length))
}

{
  const llm = fakeLlm({ chunks: [{ type: 'text-delta', text: '  padded  ' }] })
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  const result = await summariser.summarise({ agentId: 'a', snapshot })
  check('a summary is trimmed', result.text === 'padded', String(result.text))
}

{
  // A failed call must not be cached: the next repaint should be allowed to try
  // again, or a single blip would leave the panel blank for the whole turn.
  const llm = fakeLlm({ prepareThrows: new Error('blip') })
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  await summariser.summarise({ agentId: 'a', snapshot })
  check('a failed call leaves nothing cached', summariser.cache.size === 0, String(summariser.cache.size))
  check('a failed call clears its in-flight entry', summariser.inflight.size === 0, String(summariser.inflight.size))
}

// ---------------------------------------------------------------------------
// Cache eviction
// ---------------------------------------------------------------------------

{
  const llm = fakeLlm()
  const summariser = new Summariser({ llm: () => llm, config: () => ({ panelSummary: true }) })
  for (let i = 0; i < 70; i += 1) {
    await summariser.summarise({ agentId: 'a', snapshot: { ...snapshot, turn: i, said: `turn ${i}` } })
  }
  check('the cache is bounded', summariser.cache.size <= 64, String(summariser.cache.size))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
