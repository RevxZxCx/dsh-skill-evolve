/**
 * `@revxz/dsh-ui-evolve` — the session panel.
 *
 * What this package is: three cards in the gutter beside the conversation, a
 * dialog that reviews pending skill candidates, and the settings that control
 * both. What it is **not**: a skill detector. It never writes a skill, never
 * decides that a procedure is worth codifying, and never touches the candidate
 * queue except through the service `@revxz/dsh-skill-evolve` publishes.
 *
 * ## Why the two halves are separate packages
 *
 * The panel's content is mostly *session* news — what the last turn did, which
 * files it touched, how many calls it made. Only one of the three cards is about
 * skills. Bundling them meant a person who wanted the cards had to install a
 * detector that interrupts their sessions, and a person who wanted the detector
 * carried a web route they never opened.
 *
 * ## The optional half
 *
 * `skillEvolve` is read through `ctx.get`, not declared in `inject`:
 *
 * - Declared, a profile without the detector would refuse to load this plugin
 *   entirely — the default error for a missing cordis dependency.
 * - Read eagerly off `ctx.skillEvolve`, cordis throws on the *property read*
 *   itself, so optional chaining never runs (verified against cordis 4.0.5).
 *
 * Missing it costs exactly one button. Every candidate-related dependency is
 * already optional in `createPanelApi` — each one is guarded with
 * `typeof deps.x !== 'function'` and answers `{available:false, reason}` — so the
 * panel renders, the queue dialog says why it is empty, and the rest works.
 *
 * @module @revxz/dsh-ui-evolve
 */

import { Config } from './config.js'
import { TranscriptStore, readToolCallBlock } from './transcript.js'
import { Summariser } from './summarise.js'
import { createPanelApi, ROUTE_PREFIX } from './api.js'
import { SessionState } from './session-state.js'
import { SpeedMeter } from './speed.js'
import { SKILL_GESTURE, readSkillArgument } from '@revxz/dsh-evolve-core'

/** Cordis plugin name. */
export const name = 'ui-evolve'

/**
 * Required services.
 *
 * Only `webServer` is required. `systemPrompt` was declared here by mistake when
 * the panel was split out of the detector: the one context the plugin still
 * registers is the hint channel, and that belongs to `@revxz/dsh-skill-evolve`.
 * Declaring a service this package never touches makes it fail to load in a
 * profile that does not serve it, for no reason at all.
 *
 * Dropped: `systemPrompt` renders the style overrides that
 * keep the cards legible, and `webServer` is the only documented bridge between
 * a client half and a host half. A profile missing either cannot show a panel at
 * all, so failing at load is the honest outcome rather than a silent blank rail.
 */
export const inject = ['webServer']

export { Config }

/**
 * Mount the panel.
 *
 * @param {any} ctx - the cordis context.
 * @param {object} config - validated {@link Config} values.
 * @returns {void}
 */
export function apply(ctx, config) {
  const log = (...parts) => {
    try {
      ctx.logger?.info?.(`[ui-evolve] ${parts.join(' ')}`)
    } catch {
      /* logging must never break the plugin */
    }
  }

  /**
   * Read a service this plugin did not declare in `inject`.
   *
   * `ctx.get(name)` resolves through the same registry as `ctx.name` but returns
   * `undefined` for a name nobody provides instead of throwing.
   *
   * @param {string} name - the service name.
   * @returns {any} the service, or `undefined` when nobody provides it.
   */
  function service(name) {
    try {
      if (typeof ctx.get === 'function') return ctx.get(name)
      return ctx[name]
    } catch {
      return undefined
    }
  }

  /**
   * Wrap a handler so a throw cannot escape into the host's event loop.
   *
   * The promise guard is not redundant with the try/catch: handlers are meant to
   * be synchronous, but an accidental `async` would return a rejected promise the
   * try/catch never sees, and Node treats an unhandled rejection as fatal.
   *
   * @param {string} label - what to name in the log line.
   * @param {(...args: any[]) => any} handler - the handler.
   * @returns {(...args: any[]) => void} the guarded handler.
   */
  function safe(label, handler) {
    return (...args) => {
      try {
        const result = handler(...args)
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result.then(undefined, (error) => log(`${label}: ignored ${error?.message ?? error}`))
        }
      } catch (error) {
        log(`${label}: ignored ${error?.message ?? error}`)
      }
    }
  }

  /**
   * Settings changed from inside the panel, honoured for this process only.
   *
   * The host owns the config file. A plugin that rewrote it could corrupt the
   * settings of every other plugin in the profile, so panel switches live here
   * until restart and the panel says so.
   *
   * @type {Record<string, unknown>}
   */
  const overrides = {}

  /**
   * The live config: the host's resolved values with panel overrides on top.
   *
   * @returns {object} the effective config.
   */
  function liveConfig() {
    return Object.keys(overrides).length === 0 ? config : { ...config, ...overrides }
  }

  /**
   * The workspace root for an agent, taken from the session header.
   *
   * @param {any} agent - the agent.
   * @returns {string} absolute path, or `''` when unknown.
   */
  function workspaceFor(agent) {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' ? cwd : ''
  }

  // ------------------------------------------------------------ collection --
  //
  // Everything the three cards draw is collected here, from the same event
  // stream the detector reads. This half owns its own copy of every map: the
  // detector keeps its own, and sharing them would make two packages depend on
  // one another's internals for data that is cheap to derive twice.
  //
  // The duplication is deliberate and bounded — a few short strings per session,
  // dropped on disposal. The alternative was a service call on every event, which
  // would put the detector on the panel's critical path for no gain.

  /**
   * Per-agent transcripts, for the panel's previous-turn card.
   *
   * Populated from the live `session/event` stream, so the panel describes the
   * session this process is actually running rather than whatever the on-disk
   * log last flushed.
   */
  const transcripts = new TranscriptStore()

  /**
   * How fast each session is writing right now.
   *
   * Separate from `transcripts` because it answers a different question on a
   * different clock: the transcript wants the turn that finished, this wants the
   * last two seconds of the turn that is still arriving. Nothing is persisted —
   * a speed describes a moment, and a moment from a previous process is not a
   * speed, it is a number with no meaning.
   */
  const speeds = new SpeedMeter()

  /**
   * What the panel remembers about each conversation.
   *
   * Three accumulators used to live here as process-wide containers: the MCP
   * tool names ever dispatched, a recency clock, and the skills each session
   * loaded. Being process-wide made them wrong before it made them slow — with
   * two conversations open, each panel listed the other's work — and it is also
   * what stood in the way of writing any of it down, since a file per session
   * needs state per session.
   *
   * They now live in `SessionState`, keyed by session id, written behind a
   * one-second coalescing delay and read back when this process has not seen the
   * conversation (a restart, a reload, a panel opened on an older session).
   * What stays in this file is only the wiring: which host event means which
   * fact.
   */
  const sessionState = new SessionState({
    snapshotOf(sessionId) {
      const view = transcripts.view(sessionId)
      if (view === undefined) return undefined
      return { turns: view.turns, previous: view.previous }
    },
    restore(sessionId, state) {
      // Installs the finished turn this process never saw, and the count of turns
      // before the restart. A transcript that already exists is not rejected any
      // more: it keeps its own facts and takes the stored count on top, once, which
      // is why the transcript carries a `hydrated` flag. Refusing outright was what
      // let the first event of a restarted session overwrite the whole history.
      transcripts.hydrate(sessionId, state)
    },
    log
  })

  /**
   * The route this session is running on.
   *
   * Read from the session's own folded `request/context` events rather than from
   * the model catalogue: the session's route is proven reachable and authorised
   * against this account, while a catalogue entry only proves an adapter
   * advertised it. Summaries borrow this so the panel cannot fail on a route the
   * conversation itself is not using.
   *
   * @param {string} agentId - the session.
   * @returns {{ provider: string, model: string } | undefined} the route.
   */
  function routeFor(agentId) {
    try {
      const session = service('agents')?.get?.(agentId)?.session
      const context = session?.requestContext?.()
      if (typeof context?.provider === 'string' && typeof context?.model === 'string') {
        return { provider: context.provider, model: context.model }
      }
    } catch {
      /* a session that has not made its first request has no route yet */
    }
    return undefined
  }

  /**
   * Record one load, and move it to the front of the recency order.
   *
   * Bounded by the number of skills this session loads, which cannot exceed the
   * size of the library.
   *
   * @param {string} agentId - the loading session.
   * @param {string} name - the skill name.
   * @param {'tool' | 'gesture'} via - the path that loaded it.
   * @returns {void}
   */
  function rememberSkillUse(agentId, name, via) {
    // The one-directional rule (gesture → tool, never back) and the delete-then-
    // set that moves a reload to the back of the recency order both live in
    // `SessionState` now, because the same rules have to hold for a state read
    // back off disk — a rule enforced only on the way in would be a rule that
    // changes depending on whether the process had restarted.
    sessionState.rememberSkill(agentId, name, via)
  }

  // ------------------------------------------------------------ live speed --
  //
  // The one number the host does not already have while a message is arriving.
  //
  // Two channels, because the host splits them: text arrives as transient
  // frames and the token count arrives as a durable event.
  //
  // `agent/assistant-stream` is where live text comes from. `assistant/chunk`
  // looks like the obvious event for this and is not: the agent loop never
  // appends one (there is no `append("assistant/chunk")` anywhere in the host),
  // it exists only in the v1→v2 session-format migration, whose retained filter
  // drops it. An earlier version of this file listened for it and was therefore
  // silent in production while every test passed, because the tests emitted the
  // event themselves.
  //
  // The provider sends no token count until `message_stop`, so during generation
  // the count has to come from the text; `usage` on the durable
  // `assistant/message` corrects the scale afterwards.
  ctx.on('agent/assistant-stream', safe('speed-stream', (payload) => {
    const agentId = payload?.agent?.session?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return
    const frame = payload?.frame
    // A new attempt starts every time the provider is asked again: the first
    // step of a turn, a retry after a failure, the second step after a tool
    // result. Whatever the previous attempt streamed is not part of this one's
    // token count, and a settle that divided by both would learn a scale a
    // quarter of the truth.
    if (frame?.type === 'start') {
      speeds.begin(agentId)
      return
    }
    if (frame?.type !== 'chunk') return
    const chunk = frame.chunk
    // Only text deltas count. Reasoning deltas stream at their own rate and the
    // panel is describing how fast the answer is appearing, not how fast the
    // model is thinking — a reader watching an empty reply does not want to be
    // told it is going well.
    if (chunk?.type !== 'text-delta') return
    speeds.push(agentId, chunk.text)
  }))

  ctx.on('session/event', safe('speed', (session, event) => {
    const agentId = session?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return
    if (event?.type !== 'assistant/message') return
    // `usage` rides on the message rather than inside it, and a message the host
    // assembled without asking a provider (a replay, a resumed turn) carries
    // none. Settling on a missing number would divide by a total no provider
    // ever reported.
    const usage = event?.data?.usage
    if (usage === undefined || usage === null) return
    const output = usage.outputTokens
    if (typeof output !== 'number') return
    // A message that also asked for a tool is not a pure-text sample. The count
    // covers everything the step generated — the tool's arguments included — while
    // the deltas behind it are text only, so one long `str_replace` in the same
    // message would push the learned scale to the ceiling and leave every later
    // reading several times too high. Waiting for a text-only message costs
    // nothing: a turn has one of those eventually.
    const content = event?.data?.message?.content
    if (Array.isArray(content) && content.some((block) => readToolCallBlock(block) !== undefined)) return
    // `outputTokens` counts the reasoning blocks too — the host's own usage
    // dialog shows them as `（其中推理 N）`, a subset. This meter counts text
    // only, so settling on the whole completion would inflate the scale by
    // however much the model thought, and a reasoning-heavy turn would leave
    // every later reading several times too high. Subtract when the provider
    // says how much of the total was reasoning.
    const reasoning = usage.reasoningTokens
    const text = typeof reasoning === 'number' && Number.isFinite(reasoning) && reasoning > 0 ? output - reasoning : output
    speeds.settle(agentId, text)
  }))

  // ------------------------------------------------------------ transcript --
  //
  // Feed the panel's per-turn record from the same event stream the detector
  // reads.
  //
  // Registered for every event type because the panel needs four different ones
  // (human message, assistant message, tool call, turn end) and the store itself
  // decides what each means. The cost is one function call per event, and the
  // store drops anything older than the last few turns — the panel only ever
  // shows the turn that just ended.
  //
  // This runs regardless of the detector's `mode`: `off` means "do not interrupt
  // the model", not "do not let the person see what happened". A panel that went
  // blank because hints were silenced would be indistinguishable from a broken
  // one — and now that the two are separate packages, a person may not even have
  // the detector installed.
  ctx.on('session/event', safe('transcript', (session, event) => {
    const agentId = session?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return

    // The output card lists the session's work, not this turn's, so the paths a
    // turn touched have to outlive it. Read *before* `record` folds the turn:
    // `endTurn` either moves the paths into `previous` or — for a turn the host
    // abandoned — clears them outright, so reading afterwards names the turn
    // before this one in both cases. That read the wrong turn twice: it re-issued
    // a fresh tick for files an interrupted turn never touched, pushing stale
    // work to the top of the list, and it dropped the edits that turn did make.
    const ended = event?.type === 'turn/end' ? transcripts.view(agentId)?.current?.paths : undefined

    transcripts.record(agentId, event)

    // A finished turn is the moment the panel has something worth writing down.
    // Mid-turn events are not: the panel describes the turn that *ended*, and
    // rewriting the file once per tool call would be a write per file read for a
    // document that had not changed.
    if (event?.type === 'turn/end') {
      sessionState.rememberTurn(agentId)
      if (ended !== undefined) sessionState.rememberPaths(agentId, ended)
    }

    // Remember MCP tool names as they are dispatched. Presence is proved by
    // traffic: a configured server that never connected contributes no calls, and
    // the panel's job is to describe what the session actually reached.
    if (event?.type !== 'tool/call') return
    const toolName = event?.data?.name
    if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return
    // The whole tool name, not just the server. The reader splits it, so this
    // side never has to decide what a bare string means — and it can count how
    // many tools each server actually contributed.
    sessionState.rememberTool(agentId, toolName)
  }))

  // ------------------------------------------------------ visible skill use --
  //
  // The panel's skill module answers "what has this session actually loaded", and
  // the host records a load on two paths that share nothing:
  //
  //   1. the model calls the `skill` tool -> a `tool/call` named `skill`;
  //   2. a person types `/name` -> the host matches `SKILL_GESTURE` against the
  //      text blocks of a `user/message` whose `source.kind` is `user`, and
  //      injects the body without dispatching any tool at all.
  //
  // Path 2 is why this cannot be folded into the tool/call branch above: scanning
  // the same messages the host scans, with the same boundary rules, is the only
  // way the panel agrees with what the session actually did. The rule itself is
  // imported from `core` rather than copied, because the detector keeps the same
  // answer for a different reason and the two must not drift.
  ctx.on('session/event', safe('skills-visible', (session, event) => {
    const agentId = session?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return

    if (event?.type === 'tool/call') {
      if (event?.data?.name !== 'skill') return
      const name = readSkillArgument(event?.data?.arguments)
      if (typeof name === 'string' && name.length > 0) rememberSkillUse(agentId, name, 'tool')
      return
    }

    if (event?.type !== 'user/message') return
    if (event?.data?.source?.kind !== 'user') return
    const content = event?.data?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match?.[2]
        if (typeof name === 'string' && name.length > 0) rememberSkillUse(agentId, name, 'gesture')
      }
    }
  }))

  // Drop everything held for a session that has closed, so the maps cannot grow
  // with host uptime.
  // The host hands this event `{ agent }`; the detector's own handler destructures
  // the same shape. Accepting both here is not defensive coding — the panel is
  // the side that has to be right, because a missed disposal leaves the last
  // session's skills and transcript on screen after the person closes it.
  ctx.on('agent/disposed', safe('agent-disposed', (payload) => {
    const agent = payload?.agent ?? payload
    const agentId = agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return
    // Write the session down before dropping it. Disposal is not deletion: the
    // host disposes every agent when it shuts down, so forgetting the file here
    // would empty the panel on every restart — the exact failure this work
    // removes. `release` flushes, then lets go of the memory.
    //
    // The transcript is dropped twice on purpose, and the two drops answer
    // different problems.
    //
    // Now, because the panel is read as soon as disposal returns: a closed
    // session that stays on screen until a promise settles is the bug this
    // handler exists to fix, and the read does not wait for us.
    //
    // Again when the release settles, because `release` can await a read of the
    // disk — a record that has never read must read before it writes — and that
    // read ends in `restore`, which hands the stored turn back to the transcript.
    // Dropping only afterwards would leave the closed session in memory for the
    // life of the process; dropping only now would let that same restore put it
    // back. Both paths drop it, so a failed write leaves nothing behind either.
    void sessionState
      .release(agentId)
      .then(() => { transcripts.forget(agentId) }, () => { transcripts.forget(agentId) })
    transcripts.forget(agentId)
    // A speed has no afterlife: the window is two seconds and the client stops
    // asking as soon as it reads `active: false`. Dropping the entry here is
    // about the map, not about the number — a host that runs for a week and
    // opens a thousand sessions should not hold a thousand empty windows.
    speeds.forget(agentId)
  }))

  // ------------------------------------------------------------- summariser --
  //
  // The only part of this package that spends money: one small model call per
  // completed turn. Built here rather than handed in because it belongs to the
  // panel's config, not the detector's.
  const summariser = new Summariser({
    config: () => liveConfig(),
    llm: () => service('llm'),
    log
  })

  // ------------------------------------------------------------- the pruner --
  //
  // A state file outlives the process that wrote it, so something has to notice
  // when its session is gone. Nothing announces that: the host emits no archive
  // or delete event, and `session/disposed` fires on an ordinary shutdown as
  // well, so listening to it would delete the file of every session on quit —
  // the opposite of the point.
  //
  // So the pruner asks the host instead of waiting to be told. Two questions,
  // both answered by the workspace registry:
  //
  //   * `archivedSessionIds` — sessions hidden from every grouping surface. The
  //     host keeps their directory on disk, so this is the only record that a
  //     person asked for them to go away.
  //   * `sessionKnown(id)` — whether the session still exists at all. Its own
  //     doc says a definite miss is the only thing that returns false, so a
  //     storage fault is never mistaken for a deleted session.
  //
  // Asked on a timer rather than once at mount: a session can be archived while
  // the host is running, and the file has to go then, not at the next restart.
  // The store gates the work itself (`PRUNE_INTERVAL_MS`), so a frequent timer
  // costs a timestamp comparison between sweeps.
  const PRUNE_TICK_MS = 60 * 1000

  /**
   * The two questions, in the shape the store takes them.
   *
   * Read through `service()` on every sweep, never held: the registry may be
   * activated after this plugin, and it is deliberately not in `inject` — an
   * optional dependency declared there stops the whole panel loading on a host
   * that does not have it, which is exactly the failure the panel's `inject`
   * list exists to avoid.
   *
   * @returns {object} the sources. Total by construction: a question the
   *   registry cannot answer yet is left out, and an unasked question removes
   *   nothing.
   */
  function pruneSources() {
    const registry = service('workspaceRegistry')
    if (registry === null || typeof registry !== 'object') return {}
    const sources = {}
    // Assigning a closure cannot throw; `service()` already swallows a lookup
    // that does. So the deletion check is always available.
    if (typeof registry.sessionKnown === 'function') {
      sources.known = (sessionId) => registry.sessionKnown(sessionId)
    }
    // This read is the one expression here that can throw. A cordis service is
    // provided before its `init` resolves, and this getter refuses to answer
    // until the registry's state is assigned — so "the service exists" does not
    // yet mean "it can answer".
    //
    // The failure is contained to this question rather than to the whole sweep.
    // Without an archive list there are no grounds to remove a file for being
    // archived; but "does this session still exist" is a different question, and
    // a session the host has deleted must not survive because a different
    // question went unanswered on the same tick.
    try {
      const archived = registry.archivedSessionIds
      if (Array.isArray(archived)) sources.archived = () => archived
    } catch {
      // Nothing to add. The deletion check above still runs.
    }
    return sources
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      // The sources are read here rather than inline as `prune`'s argument: an
      // argument is evaluated before `.catch` can be attached, so anything that
      // throws synchronously on the way in escapes the rejection guard and
      // becomes an `uncaughtException` in the host process.
      // `pruneSources` is total — it guards the one read able to throw — so this
      // needs no try of its own. `prune` is not: the deletion check it calls can
      // still fail asynchronously, and that is what the `.catch` below is for.
      const sources = pruneSources()
      // Never awaited by the tick: a slow sweep must not stack up behind itself.
      void sessionState.prune(sources).catch((error) => {
        log('session state: the sweep failed —', error instanceof Error ? error.message : String(error))
      })
    }, PRUNE_TICK_MS)
    // A pending sweep is not a reason to keep the host alive.
    if (typeof timer?.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'ui-evolve: session state pruner')

  // ----------------------------------------------------------- panel route --
  //
  // `webServer` is declared in `inject`, so this runs only when the service is
  // really up. Reading it eagerly through `service()` was wrong: cordis hands
  // back a service whose fiber is already active, so `register` from the plugin's
  // own `apply` could see `undefined` and silently skip — the client then
  // rendered and every request 404'd.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return

    /**
     * The skill half, when it is installed.
     *
     * Read on every request rather than once at mount: cordis may activate a
     * sibling plugin after this one, and caching the first answer would leave the
     * panel permanently without a candidate button depending on load order.
     *
     * @returns {object | undefined} the service.
     */
    function skillHalf() {
      const half = service('skillEvolve')
      return half !== null && typeof half === 'object' ? half : undefined
    }

    /**
     * A pass-through to one member of the skill half, or nothing.
     *
     * Returns `undefined` when the other package is not installed, so `api.js`
     * takes its own "not wired up" branch. Every route already has one: the
     * candidate dialog shows *unavailable* rather than an empty queue, and the
     * Suggest button reports a reason instead of success.
     *
     * Substituting a plausible value here — `[]`, `0`, `'unavailable'` — destroys
     * the only signal those branches have. `'unavailable'` was the worst of the
     * three: it is a string that matches none of the four refusals `api.js`
     * knows, so it fell through to `{ ok: true }` and the button reported success
     * for a hint that was never queued.
     *
     * The closure looks the service up on every call rather than capturing it
     * once, because cordis may activate the sibling plugin after this one.
     *
     * @param {string} member - method name on the `skillEvolve` service.
     * @returns {((...args: unknown[]) => unknown) | undefined} the forwarder.
     */
    function halfDependency(member) {
      return (...args) => {
        const half = skillHalf()
        if (half === undefined || typeof half[member] !== 'function') return undefined
        try {
          return half[member](...args)
        } catch (error) {
          log(`panel: ${member} failed:`, error instanceof Error ? error.message : String(error))
          return undefined
        }
      }
    }

    const api = createPanelApi({
      config: () => liveConfig(),

      /** Panel switches, honoured for this process only. */
      applyOverride(next) {
        Object.assign(overrides, next)
      },

      transcripts,
      summariser,
      sessionState,

      /**
       * The live speed reading for one session.
       *
       * A function rather than the meter itself so the route cannot reach
       * `push`/`settle`: the only writer to a speed is the event stream, and a
       * route that could also write one would be a second author for a number
       * whose whole meaning is "this is what arrived".
       */
      speedOf(agentId) {
        return speeds.read(agentId)
      },

      /**
       * MCP tool names this session called.
       *
       * Per session, not per process: two conversations in one host have
       * different servers in play, and a panel that listed the union was
       * describing the host rather than the conversation it belongs to.
       */
      mcpTools(agentId) {
        return sessionState.toolsSeen(agentId)
      },

      /**
       * Recency sequence for skills and MCP servers, on one shared clock.
       *
       * Built on read rather than stored: the entry holds each thing's position,
       * and deriving the map keeps a caller from mutating the record the next
       * write will persist.
       */
      recentUse(agentId) {
        return sessionState.recency(agentId)
      },

      /**
       * Skill names this session loaded, each with the path that loaded it.
       *
       * Handed to the panel as-is: which of them the host would actually have
       * injected depends on the registry row, and `describeSkills` is the layer
       * that holds the snapshot.
       */
      skillsUsed(agentId) {
        return sessionState.skillsUsed(agentId)
      },

      /**
       * Files this session edited, newest first.
       *
       * Per session and cumulative, because the output card describes the
       * conversation's work rather than the last turn's. The list is paths
       * only: whether a file still exists, how big it is and when it was last
       * written are answered by the route that reads it, which stats each path
       * at read time instead of trusting a size remembered from a turn that has
       * long since ended.
       */
      filesSeen(agentId) {
        return sessionState.pathsSeen(agentId)
      },

      routeFor,

      /**
       * The host's own skill registry.
       *
       * Deliberately not a second discovery implementation: a separate walk of
       * the skill roots would drift from what the model can actually load, and
       * the panel's claim is "these are the skills this session has".
       */
      skills() {
        return service('skills')
      },

      /** A scope object the host's skill APIs accept for one agent. */
      execFor(agentId) {
        const agent = service('agents')?.get?.(agentId)
        return { scope: agent, cwd: workspaceFor(agent) }
      },

      cwdFor(agentId) {
        return workspaceFor(service('agents')?.get?.(agentId))
      },

      /**
       * Whether the skill half wrote a skill.
       *
       * Delegated rather than reimplemented: ownership is a marker in the file,
       * and the package that writes that marker is the one that should decide
       * what it means. Without the detector nothing is owned by it, so `false`
       * is the correct answer rather than an error.
       */
      async isOwned(skillName) {
        const half = skillHalf()
        if (typeof half?.isOwned !== 'function') return false
        try {
          return (await half.isOwned(skillName)) === true
        } catch {
          return false
        }
      },

      /**
       * Ask the model to propose a skill.
       *
       * The panel cannot file a candidate itself — only the model knows what the
       * procedure was — so the button queues a hint into the next step and the
       * model decides whether there is anything worth submitting.
       */
      requestProposal: halfDependency('requestProposal'),

      /**
       * The queue as rows, for the panel's candidate dialog.
       *
       * `listCandidates` on the far side is the annotated view: it recomputes
       * staleness, so a row whose base file changed since it was proposed arrives
       * marked. Passing the raw file through would show every row as live and let
       * the card offer an approve that `approve()` is about to refuse.
       */
      listCandidates: halfDependency('listCandidates'),

      /**
       * Approve one candidate by id, then by name.
       *
       * Delegated whole: the confirm handshake, the evidence gate and the
       * digest check all live behind that call, and a second implementation here
       * would be a second set of rules for the same file.
       */
      approveCandidate: halfDependency('approveCandidate'),

      /**
       * Discard one candidate by id, then by name.
       *
       * Same rule as `approveCandidate`: a stale row and a live row can share a
       * name, and the dialog offers a ✕ on both.
       */
      discardCandidate: halfDependency('discardCandidate'),

      /**
       * Candidates waiting for approval, for the panel's badge.
       *
       * Read from the queue on disk on the far side rather than from a counter
       * kept in memory: a second session, a slash command and the panel all write
       * the same file, and a cached count would be wrong the moment any of them
       * ran.
       */
      pendingCandidates: halfDependency('pendingCandidates'),

      /**
       * The routes a summary may be built with.
       *
       * Listed from the host's model registry rather than hard-coded, because
       * which providers an account can actually call is the host's knowledge,
       * not this plugin's.
       */
      modelCatalog() {
        const llm = service('llm')
        if (llm === undefined || typeof llm.listProviders !== 'function') return []
        try {
          return llm.listProviders().map((provider) => ({
            provider: provider.id ?? provider.name,
            models: (provider.models ?? []).map((model) => ({ id: model.id, name: model.name ?? model.id }))
          }))
        } catch (error) {
          log('panel: could not list models:', error instanceof Error ? error.message : String(error))
          return []
        }
      },

      log
    })

    webCtx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: api }),
      'ui-evolve: panel api'
    )
  })

}
