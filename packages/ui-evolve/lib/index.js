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
import { TranscriptStore } from './transcript.js'
import { Summariser } from './summarise.js'
import { createPanelApi, ROUTE_PREFIX } from './api.js'
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
   * MCP tool names seen this session.
   *
   * A configured server that never connected contributes no tool calls, and the
   * panel's job is to describe what is available — so presence is proved by
   * traffic, not by reading the connector's own configuration.
   *
   * @type {Set<string>}
   */
  const mcpToolsSeen = new Set()

  /**
   * A single recency clock for everything the panel lists as "used".
   *
   * Skills already carry recency through `loadedInSession` insertion order, but
   * that order cannot be compared with an MCP server's order: the panel lists
   * skills and MCP servers in one stream, so both need the same unit. One
   * counter, one map, keyed by what was used rather than by which list it
   * belongs to.
   */
  const recentUse = new Map()
  let useSequence = 0

  /**
   * Skill names this session actually loaded, for the panel's skill module.
   *
   * The module answers "what has this session used", not "what could it use", so
   * this is a record of two events only: a `skill` tool call, and a `/name`
   * gesture in a human message.
   *
   * One map, not two: a skill can arrive by either path, and the panel answers
   * "most recently loaded first" across both. Two parallel sets cannot express
   * that — a union of `[...tool, ...gesture]` sorts every gesture load after
   * every tool load, so reloading a tool skill would still list a later gesture
   * above it.
   *
   * @type {Map<string, Map<string, 'tool' | 'gesture'>>}
   */
  const loadedInSession = new Map()

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
    const names = loadedInSession.get(agentId) ?? new Map()
    // Delete before adding, so a skill loaded twice moves to the back of the
    // insertion order instead of keeping its first position. A Map keeps the
    // position of an existing key, and the panel renders this order reversed as
    // "most recently loaded first" — without the delete, the common
    // alpha → beta → alpha sequence would still list beta first.
    //
    // The stored path only ever moves in one direction: gesture → tool. The two
    // paths are held to different halves of the host's invocation policy (a
    // gesture needs `userInvocable`, the tool needs `modelInvocable`), so a name
    // that arrived through the tool stays loaded through it even if a human later
    // types `/name` in passing. Writing the newest path unconditionally made that
    // a downgrade: a model-only skill the model had loaded disappeared from the
    // panel the moment its name followed a slash in someone's sentence. Recency
    // and permission are separate facts — the move to the back is recency, and
    // this line is permission, so it must not be able to lower.
    const previous = names.get(name)
    names.delete(name)
    names.set(name, previous === 'tool' ? 'tool' : via)
    loadedInSession.set(agentId, names)
    recentUse.set(`skill:${name}`, ++useSequence)
  }

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
    transcripts.record(agentId, event)

    // Remember MCP tool names as they are dispatched. Bounded by the distinct
    // tool names the connected servers actually expose in one session — the set
    // is not cleared on disposal, so a long-lived host accumulates one short
    // string per distinct `mcp__<server>__<tool>` it has ever dispatched.
    if (event?.type !== 'tool/call') return
    const toolName = event?.data?.name
    if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return
    // The whole tool name, not just the server. The reader splits it, so this
    // side never has to decide what a bare string means — and it can count how
    // many tools each server actually contributed.
    mcpToolsSeen.add(toolName)
    const rest = toolName.slice('mcp__'.length)
    const cut = rest.indexOf('__')
    const server = cut > 0 ? rest.slice(0, cut) : ''
    if (server.length > 0) recentUse.set(`mcp:${server}`, ++useSequence)
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
    loadedInSession.delete(agentId)
    transcripts.forget(agentId)
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

      /** MCP server names observed in this session's tool traffic. */
      mcpTools() {
        return mcpToolsSeen
      },

      /** Recency sequence for skills and MCP servers, on one shared clock. */
      recentUse() {
        return recentUse
      },

      /**
       * Skill names this session loaded, each with the path that loaded it.
       *
       * Handed to the panel as-is: which of them the host would actually have
       * injected depends on the registry row, and `describeSkills` is the layer
       * that holds the snapshot.
       */
      skillsUsed(agentId) {
        return loadedInSession.get(agentId)
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
