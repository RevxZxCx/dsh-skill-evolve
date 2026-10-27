/**
 * The previous-turn summary shown in the panel.
 *
 * This is the one module that spends money on every turn, so most of the code
 * here is about not spending it: a summary is produced at most once per turn,
 * the result is cached against the turn number that produced it, and every
 * failure path returns "nothing to show" rather than retrying. A panel that
 * cost a model call per repaint would be a bad trade for a sidebar.
 *
 * Why a model at all: the transcript a turn leaves behind is a list of tool
 * names, commands, and paths. Rendering that list is what the panel's third
 * module already does. A summary earns its place only by saying something the
 * list cannot — what the turn was *for*, and whether it finished. That is a
 * language task, so it goes to a model.
 *
 * Why not the host's own summariser: `dsh-session-title-llm` and context
 * compaction both summarise, but they summarise *for the host* on the host's
 * schedule and write into the host's own state. This one is a view a person
 * asked for, must be switchable off from the plugin's own settings, and must be
 * free to use a cheaper model than the session's route.
 */

import { createHash } from 'node:crypto'

/**
 * Read a dependency handed over either as a live value or as a function.
 *
 * `lib/index.js` passes `config` and `llm` as thunks so they always reflect the
 * current session; an object literal built with `get config()` yields the value
 * directly. Calling the value crashed every summary, and a caller can regress,
 * so the tolerance lives on this side.
 *
 * @param {any} dependency - the value, or a function returning it.
 * @returns {any} the value.
 */
function valueOf(dependency) {
  return typeof dependency === 'function' ? dependency() : dependency
}

/**
 * Longest summary accepted, in characters.
 *
 * The panel renders this in a card roughly eight lines tall. A model asked for
 * "two sentences" occasionally returns twelve, and a hard cut is less surprising
 * than a card that grows and pushes the modules below it off screen.
 */
const MAX_SUMMARY_CHARS = 400

/** Longest prompt input, in characters, before the transcript is truncated. */
const MAX_INPUT_CHARS = 6000

/** Wall clock budget for one summary call. */
const SUMMARY_TIMEOUT_MS = 20000

/** Output token budget; a summary is short by construction. */
const SUMMARY_MAX_TOKENS = 300

const SYSTEM_PROMPT = [
  'You summarise one turn of an AI coding session for a sidebar panel.',
  'The person reading it already has the full transcript, so do not repeat',
  'individual commands or file paths unless they are the point.',
  '',
  'Write at most three sentences, in the language the user wrote in.',
  'Say what the turn set out to do, what it actually produced, and whether it',
  'finished or is still blocked. If the turn failed or was abandoned, say so',
  'plainly — a summary that implies success when the turn failed is worse than',
  'no summary at all.',
  '',
  'Do not open with "The assistant" or "This turn". Do not use bullet points.',
].join(' ')

/**
 * Render a transcript snapshot as the prompt body.
 *
 * Only what a summariser can use is included. Assistant prose is included
 * because it is where the turn states its own intent; tool names are reduced to
 * a frequency list because a turn with forty `bash` calls needs the shape, not
 * the roll call.
 *
 * @param {object | undefined} snapshot - the snapshot from `Transcript.snapshot`.
 * @returns {string} the prompt body, possibly empty.
 */
function renderPromptBody(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return ''
  const lines = []
  const tools = Array.isArray(snapshot.tools) ? snapshot.tools : []
  const calls = typeof snapshot.calls === 'number' ? snapshot.calls : 0
  const failed = typeof snapshot.failed === 'number' ? snapshot.failed : 0
  // A tally is only worth saying when there is something to tally. Emitting
  // "0 total" for a turn that did nothing made the empty-body guard in
  // `summarise` unreachable, so every silent turn paid for a model call that
  // could only be answered with "nothing happened".
  if (tools.length > 0) {
    const tally = tools.map((entry) => `${entry.name}×${entry.count}`).join(', ')
    lines.push(`Tool calls: ${calls} total (${tally}); ${failed} failed.`)
  } else if (calls > 0 || failed > 0) {
    lines.push(`Tool calls: ${calls} total; ${failed} failed.`)
  }

  const paths = Array.isArray(snapshot.paths) ? snapshot.paths.filter((p) => typeof p === 'string') : []
  if (paths.length > 0) lines.push(`Files edited: ${paths.slice(0, 12).join(', ')}${paths.length > 12 ? ` (+${paths.length - 12} more)` : ''}`)

  const commands = Array.isArray(snapshot.commands) ? snapshot.commands.filter((c) => typeof c === 'string') : []
  if (commands.length > 0) lines.push(`Last commands run:\n${commands.map((c) => `  $ ${c}`).join('\n')}`)

  const said = typeof snapshot.said === 'string' ? snapshot.said.trim() : ''
  if (said.length > 0) lines.push(`What the assistant said:\n${said}`)

  return lines.join('\n\n').slice(0, MAX_INPUT_CHARS)
}

/**
 * Stable identity for one turn's summary, so the cache cannot serve a summary
 * of turn 3 to a request about turn 4 that happens to have similar content.
 *
 * @param {number | undefined} turn - the turn number.
 * @param {string} body - the rendered prompt body.
 * @returns {string} the cache key.
 */
function summaryKey(turn, body) {
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16)
  return `${turn ?? '?'}:${digest}`
}

/**
 * Accumulate the text of one streamed response.
 *
 * The host's `BlockAssembler` would do this, but it lives in
 * `@deepseek-ai/dsh-llm`, which the plugin cannot resolve: the profile installs
 * `@deepseek-ai/schemastery` next to the plugin and nothing else. Depending on a
 * package only some profiles have would make this module fail to load on a
 * stock install, so the three chunk types that matter are handled here.
 *
 * @param {AsyncIterable<any>} stream - the host's chunk stream.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ text: string, finish: any }>} the joined text and finish reason.
 */
async function collectText(stream, signal) {
  let text = ''
  let finish
  for await (const chunk of stream) {
    signal?.throwIfAborted()
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  return { text, finish }
}

/**
 * Turn a finish reason into a human-readable failure, or undefined for success.
 *
 * `max-tokens` is not a failure here: a summary cut off at the token budget is
 * still a useful summary, and the character cap applies afterwards anyway.
 *
 * @param {any} finish - the finish reason from the stream.
 * @returns {string | undefined} the failure message.
 */
function finishFailure(finish) {
  if (finish === undefined || finish === null) return undefined
  if (finish.kind === 'error' || finish.kind === 'aborted') return finish.failure?.message ?? finish.kind
  return undefined
}

/**
 * Produce and cache per-turn summaries.
 */
class Summariser {
  /**
   * @param {object} deps - dependencies.
   * @param {() => any} deps.llm - returns the host's `llm` service, or undefined.
   * @param {() => object} deps.config - returns the live plugin config.
   * @param {(message: string) => void} [deps.log] - diagnostic sink.
   */
  constructor({ llm, config, log }) {
    this.llm = llm
    this.config = config
    this.log = log ?? (() => {})
    /** @type {Map<string, { text: string, at: number }>} */
    this.cache = new Map()
    /** @type {Map<string, Promise<object>>} in-flight calls, so one turn costs one call. */
    this.inflight = new Map()
  }

  /**
   * Resolve which model to summarise with.
   *
   * The configured pair wins. Without one there is no safe implicit choice:
   * picking the session's own model could mean paying frontier prices for a
   * sidebar, and picking the first advertised model could mean a route the
   * account cannot call. So the fallback is the first provider's first model,
   * and the panel shows which one was used — a person who dislikes it can pin a
   * different one in settings.
   *
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{ provider: string, model: string, pinned: boolean } | undefined>} the route.
   */
  async resolveRoute(signal) {
    const config = valueOf(this.config)
    const provider = typeof config?.summaryProvider === 'string' ? config.summaryProvider.trim() : ''
    const model = typeof config?.summaryModel === 'string' ? config.summaryModel.trim() : ''
    if (provider.length > 0 && model.length > 0) return { provider, model, pinned: true }
    const llm = valueOf(this.llm)
    if (llm === undefined || typeof llm.listProviders !== 'function') return undefined
    const providers = llm.listProviders()
    if (!Array.isArray(providers) || providers.length === 0) return undefined
    const first = providers[0]?.id ?? providers[0]?.provider
    if (typeof first !== 'string' || first.length === 0) return undefined
    // Guarded like `listProviders`: this method runs *outside* `run`'s try
    // block, so a host whose service lacks it would surface as an internal
    // panel error instead of as "no route available".
    if (typeof llm.listModels !== 'function') return undefined
    // `resolveRoute` runs outside `run`'s try block, so a rejection here would
    // escape as an internal panel error rather than degrade to "no summary".
    let models
    try {
      models = await llm.listModels(first)
    } catch (error) {
      // An abort is not a catalogue failure. Without this, cancelling a summary
      // reported "no model route is available" — the caller's cancellation
      // turned into a claim about the host's model list.
      signal?.throwIfAborted()
      this.log(`summary: could not list models for ${first}: ${error?.message ?? error}`)
      return undefined
    }
    if (!Array.isArray(models) || models.length === 0) return undefined
    const chosen = models[0]
    if (typeof chosen?.id !== 'string' || chosen.id.length === 0) return undefined
    signal?.throwIfAborted()
    return { provider: first, model: chosen.id, pinned: false }
  }

  /**
   * Summarise one turn, or return the cached summary.
   *
   * Concurrent callers for the same turn share one model call. The panel polls
   * on repaint and a person can flip panels quickly; without this, four repaints
   * in one second would be four paid calls for identical text.
   *
   * @param {object} input - the request.
   * @param {string} input.agentId - which agent the turn belongs to.
   * @param {object} input.snapshot - the turn snapshot to summarise.
   * @param {AbortSignal} [input.signal] - cancellation.
   * @returns {Promise<object>} `{ enabled, text?, model?, reason?, cached? }`.
   */
  async summarise({ agentId, snapshot, signal }) {
    const config = valueOf(this.config)
    if (config?.panelSummary !== true) return { enabled: false, reason: 'turned off' }
    if (snapshot === undefined || snapshot === null) return { enabled: true, reason: 'no completed turn yet' }

    const body = renderPromptBody(snapshot)
    if (body.length === 0) return { enabled: true, reason: 'the turn left nothing to summarise' }

    const key = `${agentId}:${summaryKey(snapshot.turn, body)}`
    const hit = this.cache.get(key)
    if (hit !== undefined) return { enabled: true, text: hit.text, cached: true }

    const running = this.inflight.get(key)
    if (running !== undefined) return running

    const task = this.run({ key, body, signal }).finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return task
  }

  /**
   * Perform one summary call and cache the result.
   *
   * @param {object} input - the request.
   * @param {string} input.key - cache key.
   * @param {string} input.body - prompt body.
   * @param {AbortSignal} [input.signal] - cancellation.
   * @returns {Promise<object>} the summary record.
   */
  async run({ key, body, signal }) {
    const llm = valueOf(this.llm)
    if (llm === undefined || typeof llm.prepareCall !== 'function') return { enabled: true, reason: 'no model service available' }
    const route = await this.resolveRoute(signal)
    if (route === undefined) return { enabled: true, reason: 'no model route is available' }

    const controller = new AbortController()
    const forward = () => controller.abort()
    signal?.addEventListener('abort', forward, { once: true })
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS)
    try {
      const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: SUMMARY_MAX_TOKENS }, controller.signal)
      const options = {
        ...call.config,
        messages: [{ role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'dsh-skill-evolve-panel' } }],
        system: SYSTEM_PROMPT,
        purpose: 'skill-evolve-panel-summary',
        signal: controller.signal,
      }
      const { text, finish } = await collectText(call.stream(options), controller.signal)
      const failure = finishFailure(finish)
      if (failure !== undefined) return { enabled: true, reason: `the model call failed: ${failure}` }
      const trimmed = text.trim().slice(0, MAX_SUMMARY_CHARS)
      if (trimmed.length === 0) return { enabled: true, reason: 'the model returned nothing' }
      this.cache.set(key, { text: trimmed, at: Date.now() })
      if (this.cache.size > 64) {
        // Oldest-first eviction: the panel only ever asks about the last turn,
        // so anything beyond the newest few dozen entries is unreachable.
        const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest !== undefined) this.cache.delete(oldest[0])
      }
      return { enabled: true, text: trimmed, model: `${route.provider}/${route.model}`, pinned: route.pinned }
    } catch (error) {
      const aborted = controller.signal.aborted
      return { enabled: true, reason: aborted ? 'the summary call timed out' : `the summary call failed: ${error?.message ?? error}` }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  }

  /** Drop every cached summary. Called when the configured model changes. */
  reset() {
    this.cache.clear()
  }
}

export {
  Summariser,
  MAX_SUMMARY_CHARS,
  MAX_INPUT_CHARS,
  SUMMARY_TIMEOUT_MS,
  SUMMARY_MAX_TOKENS,
  SYSTEM_PROMPT,
  renderPromptBody,
  summaryKey,
  collectText,
  finishFailure,
}
