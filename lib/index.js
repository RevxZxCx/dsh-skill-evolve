/**
 * dsh-skill-evolve — the alarm clock and the ledger.
 *
 * The plugin adds two things to a session and nothing else:
 *
 * 1. **An alarm clock.** It watches the tool-call stream (names only, never
 *    arguments) and, when a procedure repeats, tells the model once that the
 *    procedure might be worth writing down.
 * 2. **A ledger.** It checks whether a proposed skill's evidence is real,
 *    and it tracks whether the resulting skill later helped or hurt.
 *
 * What it deliberately does **not** do:
 *
 * - It does not run a second LLM to "distil" the conversation. The model is
 *   already in the conversation and holding the context; a second pass pays
 *   the whole transcript again to produce something worse. Every surveyed
 *   implementation that took that route either abandoned it or had to solve
 *   cache-invalidation problems the inline model does not have.
 * - It does not write a skill without a person seeing it, unless `mode` is
 *   explicitly set to `auto`.
 * - It never modifies a skill it did not write. `OWNER_MARKER` in the
 *   frontmatter is the fence.
 *
 * @module dsh-skill-evolve
 */

import { lstat, mkdir, open, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Config } from './config.js'
import { dshHome, skillRoot } from './paths.js'
import { createDetector, renderSteps } from './signal.js'
import { stepsFor } from './command.js'
import { createTools } from './tools.js'
import { createCommands } from './commands.js'
import { HintChannel, renderHint, renderHintPointer } from './hint.js'
import { ReflectionPacer, renderReflection, renderReflectionPointer } from './reflection.js'
import { Store } from './store.js'
import { OWNER_MARKER, parseFrontmatter, SKILL_FILE, SKILL_NAME, listOwnedSkills, readSkillFile, renderSkillFile, readState } from './skillfile.js'
import { confidence, decideStage, invertBody, stateToFrontmatter } from './lifecycle.js'
import { annotateQueue, contentDigest, describeStale, findByName, isLive } from './candidates.js'
import { OutcomeStore } from './outcome.js'
import { findCatalogMessages, shrinkCatalog } from './catalog.js'
import { fetchMarketBundle, isValidMarketId } from './market.js'
import { TranscriptStore, readToolCallBlock } from './transcript.js'
import { Summariser } from './summarise.js'
import { createPanelApi, ROUTE_PREFIX } from './api.js'

/** Cordis plugin name. */
export const name = 'skill-evolve'

/**
 * Required services.
 *
 * `tools` (the model-facing tools) and `systemPrompt` (the hint channel) are
 * the two halves that make the plugin do anything at all, so they are required
 * and listed here.
 *
 * `commands` is deliberately absent: cordis has no optional dependency, so
 * every name listed here must resolve or `apply` never runs. The slash commands
 * are reached through `ctx.inject(['commands'], ...)` instead, which lets a
 * host without `dsh-commands` keep everything else.
 */
export const inject = ['tools', 'systemPrompt']

/**
 * The host's own `/name` gesture for invoking a skill from a message body.
 *
 * Copied from `dsh-tool-skill` (`SKILL_GESTURE` in its `lib/index.js`) rather
 * than invented, because the panel's claim is "this session loaded this skill".
 * If the two rules drifted, the panel would either invent loads the host never
 * performed or miss ones it did. The boundary lookarounds keep file paths
 * (`/usr/bin`) and fractions (`5/8`) out, exactly as they do upstream.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

export { Config }

/**
 * Resolve the candidate the card pointed at.
 *
 * By id when the card sent one, by name otherwise. The name path has to stay --
 * the command layer and older clients only ever knew names -- but it is the wrong
 * answer for "act on the row I am pointing at", because `findByName` prefers the
 * live candidate and a stale row can share its name.
 *
 * An id that matches nothing is a miss, not a cue to look the name up again.
 * Falling back there would undo the whole point of sending the id: a card still
 * showing a row another session already discarded would resolve to its live twin,
 * so a discard would delete the row the person was about to approve, and an
 * approve would publish a candidate nobody looked at.
 *
 * @param {Array<object>} queue - the annotated candidate queue.
 * @param {string} [id] - the candidate id from the card, if any.
 * @param {string} name - the candidate name.
 * @returns {object | undefined} the candidate, if it is still queued.
 */
function byIdThenName(queue, id, name) {
  if (typeof id === 'string' && id.length > 0) {
    return queue.find((entry) => entry.id === id)
  }
  return findByName(queue, name)
}

/**
 * Mount the plugin.
 *
 * @param {any} ctx - the Cordis context.
 * @param {any} config - resolved configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const log = (...parts) => {
    // The host logger is namespaced; fall back to nothing rather than throwing
    // inside an event handler.
    try {
      ctx.logger?.info?.(`[skill-evolve] ${parts.join(' ')}`)
    } catch {
      /* logging must never break the plugin */
    }
  }

  /**
   * Read a service this plugin did not declare in `inject`.
   *
   * Cordis throws `cannot get property "X" without inject` on the *property
   * read itself*, so optional chaining does not help: `ctx.agents?.get?.()`
   * throws before the `?.` is reached. Left unguarded, that exception fired on
   * every `tool/call` and was swallowed by `safe()`, which made the whole
   * detector look as though it had never seen a tool call: the plugin loaded, its
   * tools worked, and nothing ever triggered.
   *
   * `ctx.get(name)` is the sanctioned way out. It resolves through the same
   * registry but returns `undefined` for a name nobody provides instead of
   * throwing. Verified against cordis 4.0.5 (`@deepseek-ai/cordis`): with only
   * `systemPrompt` declared, `ctx.agents` throws while `ctx.get('agents')`
   * returns the live registry and `ctx.get('nope')` returns `undefined`.
   *
   * Declaring these names in `inject` instead would make them required, so a host
   * without `dsh-agent` would refuse to load the plugin entirely. Probing is the
   * better trade — a missing service should degrade one check, not the plugin.
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

  const store = new Store({ log })
  const hints = new HintChannel({
    maxHintsPerSession: config.maxHintsPerSession,
    shrinkAfterSteps: config.hintShrinkAfterSteps,
    expiresAfterSteps: config.hintExpiresAfterSteps,
    reflectionHoldSteps: config.reflectionHoldSteps,
    log
  })
  const pacer = new ReflectionPacer({
    cadence: config.reflectionCadence,
    minToolCalls: config.reflectionMinToolCalls,
    maxPerSession: config.maxReflectionsPerSession,
    log
  })
  const triggers = new Set(config.triggers)
  /** @type {Map<string, ReturnType<typeof createDetector>>} */
  const detectors = new Map()
  /**
   * Hints a reflection's hold turned away, kept until the hold expires.
   *
   * The detector cannot be relied on to re-offer them: its history is bounded
   * to 24 entries, and a held procedure is by definition one the model stopped
   * repeating, so the window evicts it long before the hold ends.
   *
   * @type {Map<string, {primary: object, text: string, pointer: string}>}
   */
  const deferred = new Map()
  /** @type {WeakMap<object, string>} */
  const sessionOfAgent = new WeakMap()
  /**
   * Skill names loaded during each session.
   *
   * Feeds the catalog rewrite: a skill the model actually loaded is worth a
   * full description for the rest of the session, because the model has
   * already decided it is relevant. Bounded by the number of skills in the
   * library and dropped when the session is disposed, so it cannot grow with
   * conversation length.
   *
   * @type {Map<string, Set<string>>}
   */
  const usedInSession = new Map()

  /**
   * Per-agent transcripts, for the panel.
   *
   * Populated from the same `session/event` stream the detector reads, so the
   * panel describes the session this process is actually running rather than
   * whatever the on-disk log last flushed.
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
   * Skill names this session actually loaded, for the panel's skill module.
   *
   * The module answers "what has this session used", not "what could it use", so
   * this is a record of two events only: a `skill` tool call, and a `/name`
   * gesture in a human message. It is deliberately a different map from
   * `usedInSession`, which drives catalog truncation — the panel must stay
   * correct when that feature is switched off.
   *
   * Dropped when the session closes, so it cannot grow with host uptime.
   *
   * One map, not two: a skill can arrive by either path, and the panel answers
   * "most recently loaded first" across both. Two parallel sets cannot express
   * that — a union of `[...tool, ...gesture]` sorts every gesture load after
   * every tool load, so reloading a tool skill would still list a later gesture
   * above it. Insertion order here is the single source of recency, and the
   * value records which path granted the load because the two paths do not grant
   * the same permission: the `skill` tool loads what the host advertises as
   * model-invocable, while a gesture is filtered by `isUserInvocable` and
   * injects nothing when it fails.
   *
   * @type {Map<string, Map<string, 'tool' | 'gesture'>>}
   */
  const loadedInSession = new Map()

  /**
   * Open observation windows, one per agent, opened when a skill is loaded.
   *
   * Separate from the counters in `registry.json` because a count answers "was
   * it retrieved" while a window answers "what happened next". See
   * `lib/outcome.js` for why only mechanical facts are recorded, and why the
   * window closes on turn boundaries rather than on a timer.
   */
  const outcomes = new OutcomeStore()


  /**
   * Settings the panel changed for this process only.
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
   * The skill root for a given agent.
   *
   * @param {any} agent - the agent, or `undefined` for the default root.
   * @returns {string} absolute skill root.
   */
  function rootFor(agent) {
    void agent
    return skillRoot(config)
  }

  /**
   * The session id for an agent. In this host the agent id and the session id
   * are the same value, but it is read from the session when available.
   *
   * @param {any} agent - the agent.
   * @returns {string} the session id, or `''`.
   */
  function sessionIdFor(agent) {
    if (agent === undefined || agent === null) return ''
    const cached = sessionOfAgent.get(agent)
    if (cached !== undefined) return cached
    const fromSession = agent.session?.id ?? agent.session?.header?.id
    const id = typeof fromSession === 'string' ? fromSession : String(agent.id ?? '')
    if (id.length > 0) sessionOfAgent.set(agent, id)
    return id
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

  /**
   * Session events for an agent, read through the accessor this host still
   * exposes. `ownEvents()` is marked deprecated for new call sites but is the
   * only supported way to read a live session's log; the fallback keeps the
   * plugin working if it disappears.
   *
   * @param {any} agent - the agent.
   * @returns {Array<object>} the events.
   */
  function eventsFor(agent) {
    const session = agent?.session
    if (session === undefined || session === null) return []
    try {
      if (typeof session.ownEvents === 'function') return session.ownEvents()
      if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
      if (Array.isArray(session.log)) return session.log
    } catch {
      return []
    }
    return []
  }

  /**
   * Whether this agent is a root session rather than a subagent.
   *
   * Only root sessions get hints: a subagent's procedure belongs to its
   * parent's transcript, and offering the subagent a place to save a skill
   * would produce duplicates of the parent's work.
   *
   * @param {any} agent - the agent.
   * @returns {boolean} true for roots.
   */
  function isRoot(agent) {
    const registry = service('agents')
    if (registry === undefined || typeof registry.roots !== 'function') return true
    try {
      return registry.roots().some((root) => root.id === agent?.id)
    } catch {
      return true
    }
  }

  /**
   * Whether a session id is still known to the host.
   *
   * Used to refuse candidates whose transcript is gone: a quote nobody can
   * re-read is not evidence, it is a claim. A probe that cannot answer counts
   * as "still there" — losing the index is not the same as losing the session.
   *
   * @param {string} sessionId - the session id to look for.
   * @returns {Promise<boolean>} true when it exists.
   */
  async function sessionExists(sessionId) {
    const query = service('sessionQuery')
    if (query === undefined || typeof query.listSessions !== 'function') return true
    const records = await query.listSessions()
    return records.some((record) => record?.header?.id === sessionId)
  }

  /**
   * Probe the catalog for one skill name, as the staleness rules need it.
   *
   * @param {string} skillName - the name to look for.
   * @returns {Promise<{exists: boolean, owned?: boolean, body?: string}>} what is there.
   */
  async function probeSkill(skillName) {
    try {
      const parsed = await readSkillFile(join(rootFor(undefined), skillName, SKILL_FILE))
      return { exists: true, owned: parsed.owned, body: parsed.body }
    } catch {
      return { exists: false }
    }
  }

  /**
   * Re-evaluate the whole candidate queue and persist any verdict changes.
   *
   * Runs on every read rather than on a timer: recomputing is idempotent and
   * needs no scheduler, and a queue that is only swept periodically spends most
   * of its life lying about which entries are still approvable.
   *
   * @returns {Promise<Array<object>>} the annotated queue.
   */
  async function loadQueue() {
    // Annotate inside the mutation lock: the verdicts are derived from the
    // queue itself, so computing them outside and then writing would overwrite
    // a candidate another session appended in between.
    return store.mutateCandidates(async (raw) => {
      const annotated = await annotateQueue({
        candidates: raw,
        options: {
          now: new Date(),
          ttlDays: config.candidateTtlDays,
          lookup: probeSkill,
          sessionExists: config.verifyCandidateSource ? sessionExists : undefined
        }
      })
      return {
        candidates: annotated.changed ? annotated.candidates : undefined,
        result: annotated.candidates
      }
    })
  }

  /**
   * Get or create the detector for one agent.
   *
   * @param {string} agentId - the agent id.
   * @returns {ReturnType<typeof createDetector>} the detector.
   */
  function detectorFor(agentId) {
    let detector = detectors.get(agentId)
    if (detector === undefined) {
      detector = createDetector({
        minRepeatCount: config.minRepeatCount,
        minWindow: config.minWindow,
        repeatWindowMax: config.repeatWindowMax,
        // The plugin's own tools must never feed the detector: forging a skill
        // is not a procedure worth forging a skill about.
        ignoreTool: (toolName) => toolName.startsWith('skill_candidate') || toolName === 'skill_feedback'
      })
      detectors.set(agentId, detector)
    }
    return detector
  }

  // ---------------------------------------------------------------- hints --

  // Registered globally, but the text is keyed by the agent in the assembly
  // context, so an agent that was never recorded renders `''` and the host
  // drops the contribution entirely.
  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: 'skill-evolve:hint',
        order: 121,
        required: config.hintRequired,
        text: (assembly) => {
          const agentId = assembly?.agent?.id
          return typeof agentId === 'string' ? hints.textFor(agentId) : ''
        }
      }),
    'skill-evolve hint context'
  )

  // ------------------------------------------------------------- detection --

  /**
   * Wrap an event handler so a bug in this plugin cannot break the session.
   *
   * `session/event` is emitted inside the host's own turn loop, synchronously.
   * An exception thrown here propagates into that loop and takes the user's
   * conversation down with it — for a plugin whose entire job is to be
   * unnoticed, that is the worst possible failure. Everything below is
   * convenience: a detector that throws should lose one hint, not the turn.
   *
   * The promise guard is not redundant with the try/catch: handlers are meant
   * to be synchronous, but an accidental `async` would return a rejected
   * promise that the try/catch never sees, and Node treats an unhandled
   * rejection as fatal.
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

  ctx.on('session/event', safe('detection', (session, event) => {
    if (config.mode === 'off') return
    const agentId = session?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return

    // The pacer counts every tool call regardless of which triggers are
    // enabled: whether a turn did enough to be worth reflecting on is a
    // separate question from which trigger notices it.
    if (event?.type === 'tool/call') pacer.countToolCall(agentId)

    if (!triggers.has('repeat')) return
    const type = event?.type
    if (type !== 'tool/call') return
    const agent = service('agents')?.get?.(agentId)
    if (agent !== undefined && !isRoot(agent)) return
    const toolName = event?.data?.name
    if (typeof toolName !== 'string') return

    const detector = detectorFor(agentId)
    // One shell call can be a whole procedure (`pnpm test && git diff`), so it
    // contributes one history entry per command it runs. Without this the
    // detector only ever sees "bash, bash, bash" in sessions where the shell is
    // the main actor, which is most of them.
    if (config.commandSignature === true) {
      for (const step of stepsFor(toolName, event?.data?.arguments)) detector.record(step)
    } else {
      detector.record(toolName)
    }
    const procedures = detector.detect().filter((procedure) => !hints.alreadyShown(agentId, procedure.steps))
    if (procedures.length === 0) return

    // Only one procedure per hint. A single message naming two workflows
    // asks the model to decide which one this conversation is about, and in
    // practice it writes down whichever came first. The next detection round
    // can raise the second one.
    const [primary] = procedures
    const text = renderHint({
      procedures: [primary],
      renderSteps,
      observerRatioWarn: 0.8
    })
    const pointer = renderHintPointer({ procedures: [primary], renderSteps })
    const outcome = hints.publish({
      agentId,
      signature: primary.signature,
      steps: primary.steps,
      text,
      pointer,
      kind: 'repeat'
    })
    if (outcome === 'published') {
      deferred.delete(agentId)
      log(`hint published for ${agentId}: ${renderSteps(primary.steps)} ×${primary.occurrences}`)
    } else if (outcome === 'held') {
      // Deferral is not free. `detect()` recomputes from the whole history on
      // every tool call, but that history is bounded: `createDetector` keeps
      // only `repeatWindowMax * (minRepeatCount + 2)` entries, 24 by default.
      // The hold lasts 8 model steps, and a step with three tool calls replaces
      // the entire window — so by the time the channel frees up the procedure
      // this hint was about may no longer be detectable at all.
      //
      // Holding the rendered hint instead of re-deriving it costs one string
      // and survives the eviction. The slot holds at most one hint per agent and
      // is dropped on four events, none of which inspects the model's intent:
      //   1. a repeat hint published (the slot's own job is done),
      //   2. a reflection published (it takes the channel; by the time the new
      //      hold ends the deferral is two holds stale),
      //   3. the model called a `skill_candidate*` tool -- see the clear
      //      handler, that is the strongest evidence it has finished with what
      //      is on screen,
      //   4. the agent went away.
      //
      // Do not add an `alreadyShown` guard as a fifth check. It looks right and
      // does nothing: a held hint returns before `channel.shown` is written, so
      // the guard reports false whatever the model did. That mistake survived
      // one full review round.
      deferred.set(agentId, { primary, text, pointer })
      log(`hint deferred for ${agentId} (reflection holds the channel): ${renderSteps(primary.steps)}`)
    }
  }))

  // ------------------------------------------------------------ reflection --

  // Count real human turns and fire the reflection checkpoint at turn end.
  //
  // `user/message` covers four different sources: a person typing (`user`),
  // the AGENTS.md baseline (`agent-instructions`), the per-step runtime
  // snapshot (`runtime-context`), and an approval receipt (`user-approval`).
  // Only the first is a turn. Counting the others would make every step look
  // like a new conversation and fire the checkpoint continuously.
  ctx.on('session/event', safe('reflection', (session, event) => {
    if (config.mode === 'off') return
    if (!triggers.has('turn')) return
    const agentId = session?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return
    const agent = service('agents')?.get?.(agentId)
    if (agent !== undefined && !isRoot(agent)) return

    if (ReflectionPacer.isHumanMessage(event)) {
      pacer.countHumanMessage(agentId)
      return
    }
    if (event?.type !== 'turn/end') return
    // A turn that was interrupted or failed is not a moment the model is
    // thinking clearly about what it learned.
    if (event?.data?.reason?.kind !== 'completed') return

    const decision = pacer.evaluate(agentId)
    if (!decision.due) {
      log(`reflection skipped for ${agentId}: ${decision.reason}`)
      return
    }

    // The detector's findings ride along as supporting evidence rather than as
    // the trigger: "you repeated these three steps" is a much stronger prompt
    // when it arrives next to "what did this turn teach you".
    const seen = triggers.has('repeat') ? detectors.get(agentId) : undefined
    const procedures = (seen?.detect() ?? []).filter((procedure) => !hints.alreadyShown(agentId, procedure.steps))

    const text = renderReflection({ turns: decision.turns, procedures, renderSteps })
    const pointer = renderReflectionPointer({ turns: decision.turns })
    const outcome = hints.publish({
      agentId,
      signature: `turn#${decision.turns}`,
      steps: [`__reflection_${decision.turns}__`],
      text,
      pointer,
      distinct: true,
      kind: 'reflection'
    })
    if (outcome === 'published') {
      pacer.markReflected(agentId)
      // A second reflection taking the channel means the deferral is now two
      // holds old. The retry fires on the tick that ends the *current* hold, and
      // by then the procedure it names is long gone from the model's working
      // set — resurrecting it spends a budget unit to say something stale.
      // Dropping it here is the same rule as the `skill_candidate*` handler:
      // whoever takes the channel discards what was waiting for it.
      deferred.delete(agentId)
      log(`reflection offered for ${agentId} after ${decision.turns} turns (${decision.toolCalls} tool calls)`)
    }
  }))

  ctx.on('agent/disposed', safe('disposal', ({ agent }) => {
    const agentId = sessionIdFor(agent)
    if (agentId.length > 0) {
      hints.forget(agentId)
      detectors.delete(agentId)
      deferred.delete(agentId)
      pacer.forget(agentId)
      usedInSession.delete(agentId)
      loadedInSession.delete(agentId)
      transcripts.forget(agentId)
      // An open window at disposal describes an observation that was cut short,
      // not a result. Writing it would put rows in the ledger whose counts
      // depend on when the person closed the window.
      outcomes.forget(agentId)
    }
  }))

  // Clear the hint as soon as the model acts on it, so the next steps stop
  // paying for text that has already been read.
  ctx.on('session/event', safe('hint clear', (session, event) => {
    if (event?.type !== 'tool/call') return
    const toolName = event?.data?.name
    if (typeof toolName !== 'string' || !toolName.startsWith('skill_candidate')) return
    const agentId = session?.id
    if (typeof agentId !== 'string') return
    hints.clear(agentId)
    // Drop any deferred copy with it. Acting on the channel is the strongest
    // evidence the model has seen what it needs to see, and `clear()` resets
    // `kind`, which also ends the reflection's hold — so without this the retry
    // fires on the very next step and resurrects a hint the model just dealt
    // with. `alreadyShown` cannot stand in for this: a held hint never reached
    // `channel.shown`, so it reports false no matter what the model did.
    deferred.delete(agentId)
  }))

  // Age hints that the model has read but not acted on.
  //
  // The other fate of a hint is silence: the model reads it, decides the
  // procedure is not worth keeping, and carries on. Nothing announces that
  // decision, so without ageing the text stays in every following snapshot. On
  // a complete real transcript that was 132 snapshots and 79,896 characters of
  // hint text, with one hint riding along for 106 steps.
  //
  // Ageing is two-stage (shrink, then optionally retire) because the same
  // transcript shows why a hard deadline is wrong: the session's only
  // successful submission came 412 steps after its hint appeared, reading text
  // a deadline would have deleted.
  //
  // The unit is the assistant message, not the tool call: one message is one
  // time the model read the prompt, whether it carried one tool call or four.
  // Counting tool calls would burn a four-call message's worth of budget in a
  // single step.
  ctx.on('session/event', safe('hint ageing', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const agentId = session?.id
    if (typeof agentId === 'string') hints.tick(agentId)
  }))

  // Retry a hint that the reflection's hold turned away.
  //
  // Registered *after* ageing so the tick that expires the hold is the same
  // tick that releases the retry. Order matters here: `ctx.on` fires handlers in
  // registration order, so a retry placed before `hints.tick` would always run
  // one step late and the hold would appear to last `reflectionHoldSteps + 1`.
  //
  // The retry cannot wait for the next detection round instead. A held
  // procedure is by definition one the model has stopped repeating, so its
  // window entries age out (24 max, at 8 steps x 3 calls) before the hold ends
  // and `detect()` never offers it again.
  ctx.on('session/event', safe('deferred hint', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const agentId = session?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return
    const waiting = deferred.get(agentId)
    if (waiting === undefined) return
    if (hints.isHeld(hints.channel(agentId))) return
    deferred.delete(agentId)
    // The `alreadyShown` re-check that used to sit here was dead code: a hint
    // turned away by the hold returns before `channel.shown` is written, so
    // this test could only ever report false. Acting on the channel is handled
    // where it actually happens -- the `skill_candidate*` handler deletes the
    // deferred entry, because that same handler clears the hint and so ends the
    // hold immediately.
    const outcome = hints.publish({
      agentId,
      signature: waiting.primary.signature,
      steps: waiting.primary.steps,
      text: waiting.text,
      pointer: waiting.pointer,
      kind: 'repeat'
    })
    if (outcome === 'published') {
      log(`deferred hint published for ${agentId}: ${renderSteps(waiting.primary.steps)}`)
    }
  }))

  // Count a real load of one of our skills.
  //
  // The skill tool is the only reliable signal that a skill was *used*: the
  // model reading a skill from the catalog does not touch the filesystem, so
  // no provider callback fires. Its argument is `{ name }`, delivered as a
  // JSON string rather than an object because `tool/call` carries the raw
  // streamed text.
  //
  // Counting happens at dispatch, not at result. Pairing a call with its
  // result would mean holding a map from `callId` to skill name and hoping the
  // result always arrives; an interrupted call would then silently drop a use,
  // and an under-count keeps a good skill `unverified` forever. A dispatch
  // that goes on to fail is rare — the name is checked against a file that
  // exists and is ours before anything is counted — so the error leans toward
  // one extra use rather than one missing.
  //
  // Deliberately not gated on `mode`. `mode` governs *detection and creation*:
  // whether the plugin may interrupt a session or add a skill. Bookkeeping of
  // skills that already exist is a different question, and a person who turned
  // hints off did not thereby stop using the skills they already approved.
  // Gating here would freeze every counter at whatever value it held when the
  // switch was flipped, which is worse than silence because `/skill-stats`
  // would keep reporting the stale numbers as if they were current.
  ctx.on('session/event', safe('usage', (session, event) => {
    if (event?.type !== 'tool/call') return
    if (event?.data?.name !== 'skill') return
    const skillName = readSkillArgument(event?.data?.arguments)
    if (typeof skillName !== 'string' || skillName.length === 0) return
    const agentId = session?.id
    const agent = service('agents')?.get?.(agentId)
    // Subagents are counted even though they are excluded from hints: unlike a
    // hint, which a subagent cannot act on because it must not write skills, a
    // load is a real load regardless of which agent performed it. Excluding
    // them here would systematically under-count exactly the delegated work
    // that makes a procedure worth codifying in the first place.
    return countUse({ name: skillName, agent, agentId: typeof agentId === 'string' ? agentId : undefined })
  }))

  // ----------------------------------------------------------- transcript --
  //
  // Feed the panel's per-turn record from the same event stream the detector
  // reads.
  //
  // Registered for every event type because the panel needs four different
  // ones (human message, assistant message, tool call, turn end) and the store
  // itself decides what each means. The cost is one function call per event,
  // and the store drops anything older than the last few turns — the panel only
  // ever shows the turn that just ended.
  //
  // This runs regardless of `mode`: `off` means "do not interrupt the model",
  // not "do not let the person see what happened". A panel that went blank
  // because hints were silenced would be indistinguishable from a broken one.
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
  }))

  // Feed the post-load observation windows.
  //
  // A separate handler rather than another branch inside the transcript one:
  // that handler returns early on everything that is not a `tool/call`, and the
  // window needs `tool/result` and `turn/end` too. Splitting them keeps each
  // handler's early exit honest about what it consumes.
  ctx.on('session/event', safe('outcome', (session, event) => {
    const agentId = session?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return
    const closed = outcomes.record(agentId, event)
    // At most one window can close per event: `record` only closes on the turn
    // boundary for its own agent.
    if (closed.length > 0) return recordOutcome(closed[0])
  }))

  // ----------------------------------------------------- visible skill use --
  //
  // The panel's skill module answers "what has this session actually loaded",
  // and the host records a load on two paths that share nothing:
  //
  //   1. the model calls the `skill` tool -> a `tool/call` named `skill`;
  //   2. a person types `/name` -> the host matches `SKILL_GESTURE`
  //      (`/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`) against the text
  //      blocks of a `user/message` whose `source.kind` is `user`, and injects
  //      the body without dispatching any tool at all.
  //
  // Path 2 is why this cannot be folded into the usage counter above: that one
  // is deliberately narrow (it also writes bookkeeping for skills this plugin
  // owns) while this one is the panel's view and must see both. Scanning the
  // same messages the host scans, with the same boundary rules, is the only way
  // the panel agrees with what the session actually did.
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

  // ------------------------------------------------------------- panel api --
  //
  // The client half talks to the host over plain HTTP rather than a bespoke
  // channel, because that is what `@michengai/dsh-skills-manager` does and it
  // is the only client/host bridge this host version documents.
  //
  // The route is registered through `webServer`, which is an *optional*
  // dependency: `dsh web` provides it, a headless `dsh run` does not. Reading
  // it through `ctx.get` rather than declaring it required keeps the plugin
  // loadable in a terminal session, where the panel is simply absent.
  // Passed as functions, not as getters: both consumers *call* them, so a getter
  // would hand a function to code expecting the value, and every request would
  // read `undefined` instead of the live config.
  const summariser = new Summariser({
    config: () => liveConfig(),
    llm: () => service('llm'),
    log
  })

  // The panel's HTTP route is registered through `webServer`, which is an
  // *optional* dependency: `dsh web` provides it, a headless `dsh run` does not.
  //
  // Reached through `ctx.inject` rather than declared in the module's `inject`
  // array, so a terminal session keeps everything except the panel. Reading it
  // eagerly through `service()` was wrong for a second reason: Cordis only hands
  // back a service whose fiber is already active, so calling `register` from the
  // plugin's own `apply` can see `undefined` and silently skip registration —
  // the client then renders and every request 404s. `inject` defers the callback
  // until the service is actually up.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
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

      /**
       * The route this session is running on.
       *
       * Read from the session's own folded `request/context` events rather than
       * from the model catalogue: the session's route is proven reachable and
       * authorised against this account, while a catalogue entry only proves an
       * adapter advertised it. Summaries borrow this so the panel cannot fail on
       * a route the conversation itself is not using.
       */
      routeFor(agentId) {
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
      },

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
       * Whether this plugin wrote a skill.
       *
       * Read from the file's own marker rather than from the registry: the
       * registry reports where a skill came from, not who may rewrite it.
       */
      async isOwned(name) {
        try {
          const file = await readSkillFile(join(rootFor(undefined), name, SKILL_FILE))
          return file?.data?.['evolved-by'] === OWNER_MARKER
        } catch {
          return false
        }
      },

      /**
       * Ask the model to propose a skill.
       *
       * The panel cannot file a candidate itself — only the model knows what
       * the procedure was — so the button queues a hint into the next step and
       * the model decides whether there is anything worth submitting.
       */
      requestProposal(agentId, skillName) {
        // `off` means the plugin does nothing at all, and that has to include
        // this path: a hint published here reaches the model through the same
        // system-prompt contribution the detectors use, so allowing it would
        // make "off" mean "no detection but still injected text".
        if (config.mode === 'off') return 'off'
        return hints.publish({
          agentId,
          signature: `panel:${skillName ?? 'any'}`,
          // An empty list, not `0`: `publish` spreads steps into the shown
          // list, and the panel's request is not a procedure — it has no steps
          // to remember or to de-duplicate against.
          steps: [],
          text: [
            'The person reading the sidebar asked whether this session produced a reusable skill.',
            skillName === undefined ? '' : `They pointed at "${skillName}".`,
            'If it did, call `skill_candidate_submit` with the name, a one-line description, the steps, and evidence quoted from this conversation.',
            'If it did not, say so in one sentence and carry on — do not invent a skill.'
          ].filter(Boolean).join(' '),
          pointer: undefined,
          kind: 'repeat'
        })
      },

      /**
       * The queue as rows, for the panel's hover card.
       *
       * `loadQueue()` is the annotated view: it recomputes staleness, so a row
       * whose base file changed since it was proposed arrives marked. Passing the
       * raw file through would show every row as live and let the card offer an
       * approve that `approve()` is about to refuse.
       */
      async listCandidates() {
        const queue = await loadQueue()
        return queue.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          description: candidate.description,
          kind: candidate.kind,
          whenToUse: candidate.whenToUse,
          body: candidate.body,
          evidence: candidate.evidence,
          stale: candidate.stale,
        }))
      },

      /**
       * Approve one candidate by name, exactly as `/skill-capture` does.
       *
       * `findByName` rather than a plain find: an older candidate for the same
       * name may have gone stale while a newer live one waits behind it, and
       * picking the first match would refuse an approval the queue is visibly
       * offering.
       *
       * `id` wins when the card sends one. Two candidates can share a name — an
       * older one goes stale and the model proposes the name again — and
       * `findByName` always answers with the live one, so acting on the stale row
       * by name would hit its live twin and leave the stale row in the queue.
       * The name is resolved only when no id was supplied, which is how
       * `/skill-capture` and older clients keep working. An id that matches
       * nothing is a miss: falling back to the name there would act on a row the
       * person never saw.
       *
       * @param {string} name - the candidate name.
       * @param {string} [agentId] - the session doing the approving.
       * @param {string} [id] - the exact candidate id, when the caller has it.
       * @returns {Promise<object>} the outcome.
       */
      async approveCandidate(name, agentId, id) {
        const queue = await loadQueue()
        const candidate = byIdThenName(queue, id, name)
        if (candidate === undefined) {
          return { ok: false, code: 'not-found', error: `"${name || id || 'that candidate'}" is no longer in the candidate queue` }
        }
        const agent = agentId === undefined ? undefined : service('agents')?.get?.(agentId)
        const result = await approve({ candidate, agent })
        if (result?.ok === false) {
          return { ok: false, code: 'refused', error: String(result.error ?? 'the candidate could not be approved') }
        }
        return {
          ok: true,
          // `staged` is the confirm handshake: nothing was written, the model is
          // about to be asked for a final draft. The card has to say so, or a
          // person sees the row disappear and assumes the file exists.
          staged: result?.staged === true,
          kind: result?.kind,
          path: result?.path,
        }
      },

      /**
       * Discard one candidate by name.
       *
       * The filter runs inside the mutation lock. Filtering a snapshot read
       * outside it would drop any candidate another session appended between the
       * read and the write, which is the same defect the command branch carries a
       * comment about.
       *
       * `id` first, for the same reason `approveCandidate` takes one: a stale row
       * and a live row can share a name, and the card offers a ✕ on both.
       *
       * @param {string} name - the candidate name.
       * @param {string} [id] - the exact candidate id, when the caller has it.
       * @returns {Promise<object>} the outcome.
       */
      async discardCandidate(name, id) {
        const queue = await loadQueue()
        const candidate = byIdThenName(queue, id, name)
        if (candidate === undefined) {
          return { ok: false, code: 'not-found', error: `"${name || id || 'that candidate'}" is no longer in the candidate queue` }
        }
        const removed = await store.mutateCandidates(async (entries) => {
          const next = entries.filter((entry) => entry.id !== candidate.id)
          return { candidates: next, result: next.length !== entries.length }
        })
        // The row's own name, not the caller's: an id-only request carries an
        // empty name, and writing that into the ledger would record a discard of
        // nothing.
        if (!removed) {
          return { ok: false, code: 'not-found', error: `"${candidate.name}" was removed while it was being discarded` }
        }
        await store.record({ at: new Date().toISOString(), actor: 'user', action: 'discard', skill: candidate.name })
        log(`panel: discarded ${candidate.name}`)
        return { ok: true }
      },

      /**
       * Candidates waiting for approval, for the panel's badge.
       *
       * Read from the queue on disk rather than from a counter kept in memory:
       * a second session, a slash command and the panel all write the same
       * file, and a cached count would be wrong the moment any of them ran.
       */
      async pendingCandidates() {
        try {
          const queue = await loadQueue()
          return queue.filter((candidate) => candidate.stale === undefined).length
        } catch (error) {
          log('panel: could not read the candidate queue:', error instanceof Error ? error.message : String(error))
          return 0
        }
      },

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
      'skill-evolve: panel api'
    )
  })

  // ------------------------------------------------------------- catalog --
  //
  // Shorten the skill catalog the host publishes each step.
  //
  // The host (`@deepseek-ai/dsh-tool-skill`) renders every model-invocable
  // skill into one durable message and republishes the whole list whenever any
  // name or description changes. Nothing in that path is bounded by relevance:
  // a 500-skill library costs ~31K tokens before the conversation says
  // anything, and a second complete copy for each later change.
  //
  // This handler runs *after* the host built the message (`{prepend: true}`
  // means it is called first, and `await next()` reaches the host's own
  // handlers). Rewriting before `next()` would do nothing: the message does not
  // exist yet.
  //
  // Only `content[0].text` is rewritten. `source.entries` must stay byte-identical
  // to what the host recorded: the host decides whether to republish by hashing
  // `[name, description]` from the registry and comparing it against the entries
  // on the newest visible catalog event. Editing the entries would make the next
  // step's digest disagree with the log, and the host would then append a fresh
  // catalog on every single step.
  //
  // `registry.json` is read through a short-lived cache. A read per step would
  // be a disk hit on the critical path of every model turn, and the only fields
  // consulted are pins and use counts, which a person changes by hand at most a
  // few times a session.
  let registryCache = { at: 0, value: {} }
  const REGISTRY_TTL_MS = 5000
  async function registryForCatalog() {
    const now = Date.now()
    if (now - registryCache.at < REGISTRY_TTL_MS) return registryCache.value
    const value = await store.loadRegistry().catch(() => ({}))
    registryCache = { at: now, value }
    return value
  }

  if (config.catalogEnabled) {
    // Not wrapped in `safe()`: that helper is for fire-and-forget listeners and
    // discards the return value, which for a waterfall handler would replace the
    // step's decision with `undefined` and break the turn. The guard here is
    // narrower instead — the host's own `next()` is allowed to throw, and only
    // this plugin's rewriting is caught.
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        const messages = decision?.messages
        if (!Array.isArray(messages)) return decision
        const catalogs = findCatalogMessages(messages)
        if (catalogs.length === 0) return decision

        const agent = payload?.agent
        const agentId = sessionIdFor(agent)
        const registry = await registryForCatalog()
        const shrunk = new Map()
        const totals = { entries: 0, namesOnly: false, before: 0, after: 0 }
        for (const catalog of catalogs) {
          const outcome = shrinkCatalog({
            message: catalog,
            registry,
            sessionUsed: usedInSession.get(agentId),
            options: {
              shrinkChars: config.catalogShrinkChars,
              frequentUses: config.catalogFrequentUses,
              fullListBelow: config.catalogFullListBelow,
              sessionAware: config.catalogSessionAware
            }
          })
          if (outcome === undefined) continue
          shrunk.set(catalog, outcome.message)
          // Summed, not assigned: a session can carry more than one catalog
          // message, and reporting only the last one's entry count would make the
          // log line describe a catalog that is not the one the model sees.
          totals.entries += outcome.stats.entries
          totals.namesOnly = totals.namesOnly || outcome.stats.namesOnly
          totals.before += outcome.stats.before
          totals.after += outcome.stats.after
        }
        if (shrunk.size === 0) return decision

        const replaced = messages.map((message) => shrunk.get(message) ?? message)
        if (totals.before > totals.after) {
          const { entries, namesOnly, before, after } = totals
          log(`catalog: ${entries} skill(s)${namesOnly ? ' (names only)' : ''}, ${before} → ${after} chars`)
        }
        return { ...decision, messages: replaced }
      } catch (error) {
        log(`catalog: ignored ${error?.message ?? error}`)
        return decision
      }
    }, { prepend: true })
  }

  // ------------------------------------------------------- market approval --

  /**
   * Bundles downloaded by the gate, waiting for the approved call to write them.
   *
   * Keyed by `callId` so the bytes a person approved are the bytes that land on
   * disk. Without this the gate would show one fetch and `execute` would perform
   * another: the market could serve a different bundle, and the approval would
   * have been given for something that was never installed. Bounded because a
   * bundle is held in memory and a denied install never comes back to claim it.
   */
  const approvedBundles = new Map()
  const MAX_APPROVED_BUNDLES = 4

  /**
   * The fetch used for market calls.
   *
   * Read from `globalThis` at call time rather than captured at apply time, so a
   * test can substitute it and a host that patches the global still takes effect.
   * @returns {Function} the fetch implementation.
   */
  const marketFetch = () => globalThis.fetch

  /**
   * Ask the human before an external skill is written to disk.
   *
   * The approval seam is the host's, not ours: returning `{ kind: 'ask' }` from
   * `tools/pre-execute` makes `dsh-tools` route the decision through
   * `ctx.get('approval').request(...)`, where only `'allowed-once'` proceeds and
   * a `'never'` policy rejects without asking. A `confirm: true` argument would
   * be worthless here — the model writes its own arguments, so a model-authored
   * confirmation confirms nothing. This handler is the gate, and it is the only
   * one: `installMarketSkill` deliberately has no check of its own, so there is
   * exactly one place to audit.
   *
   * The download happens *here*, before the question is asked, for the same
   * reason: an approval that names only an id asks the person to trust a bundle
   * they have not seen. Fetching first means the question can list the files and
   * call out the executables, and the cached bundle means the answer applies to
   * exactly those bytes.
   *
   * Nothing else is gated. Search and preview are read-only network calls, and
   * asking permission to look something up would train the person to approve
   * without reading.
   */
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.name !== 'skill_market_install') return next()
    const raw = exec.arguments?.id
    const id = typeof raw === 'string' ? raw.trim() : ''
    // Validated before the download, not after: `id` becomes a URL path segment,
    // and the rejection message is the only thing the person sees for a bad call.
    if (!isValidMarketId(id)) {
      return {
        kind: 'deny',
        reason: `"${id === '' ? '(no id)' : id}" is not a market id of the form owner/repo/skill, so nothing was installed.`
      }
    }
    const requested = typeof exec.arguments?.name === 'string' ? exec.arguments.name.trim() : ''
    const name = requested === '' ? id.split('/')[2].toLowerCase() : requested
    // Before the download, like the id: the name is derivable from the id alone,
    // so a call that cannot possibly install must not cost a megabyte of network.
    if (!SKILL_NAME.test(name)) {
      return {
        kind: 'deny',
        reason: `"${name}" is not a valid skill name. Use kebab-case: lowercase letters, digits and single hyphens. Nothing was installed.`
      }
    }
    // An approval that cannot be given is a denial, and it is knowable before
    // asking. Under the "never" policy the host rejects every request without
    // consulting anyone, so downloading first would spend a real request and
    // cache a megabyte that is discarded for certain.
    const policy = service('approval')?.effectivePolicy?.(exec?.agent?.session)
    if (policy === 'never') {
      return {
        kind: 'deny',
        reason: `Approval prompts are disabled in this session, so installing "${id}" cannot be approved. Nothing was installed.`
      }
    }
    let bundle
    try {
      bundle = await fetchMarketBundle({ id, fetch: marketFetch() })
    } catch (error) {
      // Denied rather than asked: there is nothing to approve when the bundle
      // could not be read, and asking would let a person approve an install that
      // is guaranteed to fail afterwards.
      return {
        kind: 'deny',
        reason: `Could not download "${id}", so nothing was installed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (exec.callId !== undefined) {
      // Oldest first: a Map preserves insertion order, and a stale entry is one
      // whose call was denied or abandoned.
      while (approvedBundles.size >= MAX_APPROVED_BUNDLES) {
        const oldest = approvedBundles.keys().next()
        if (oldest.done === true) break
        approvedBundles.delete(oldest.value)
      }
      approvedBundles.set(exec.callId, bundle)
    }
    const executables = bundle.files.filter((file) => /\.(py|sh|ps1|js|mjs|rb|pl|exe|dll)$/i.test(file.path))
    const lines = [
      `Install ${id} as \`${name}\`? It writes ${bundle.files.length} file(s) to your skill directory:`,
      ...bundle.files.slice(0, 20).map((file) => `  ${file.path} (${file.bytes} bytes)`),
      ...(bundle.files.length > 20 ? [`  …and ${bundle.files.length - 20} more`] : [])
    ]
    if (executables.length > 0) {
      lines.push('', `It ships ${executables.length} executable file(s): ${executables.map((file) => file.path).join(', ')}`)
    }
    if (bundle.dropped.length > 0) {
      lines.push('', `${bundle.dropped.length} file(s) with unsafe paths will be skipped: ${bundle.dropped.join(', ')}`)
    }
    return {
      kind: 'ask',
      reason: `install the market skill "${id}" as \`${name}\` into the local skill library`,
      displayReason: lines.join('\n')
    }
  }, { prepend: true })

  /**
   * Hand the approved bundle to the install tool, or `undefined` when absent.
   *
   * Taking the entry out makes the approval single-use: a second write from the
   * same call cannot reuse bytes a person approved once.
   * @param {string} callId - the tool call id the gate keyed the bundle under.
   * @returns {object | undefined} the bundle the person approved.
   */
  function takeApprovedBundle(callId) {
    if (callId === undefined) return undefined
    const bundle = approvedBundles.get(callId)
    approvedBundles.delete(callId)
    return bundle
  }

  // ------------------------------------------------------------ workflows --

  /**
   * Write a skill file, refusing to overwrite anything this plugin does not own.
   *
   * The ownership check is repeated here rather than trusted from the caller:
   * approval is reachable from two entry points (tool and command), and the
   * fence is the one invariant that must not depend on either of them.
   *
   * @param {object} input - write request.
   * @param {string} input.path - absolute path to the SKILL.md.
   * @param {string} input.name - skill name.
   * @param {string} input.description - routing description.
   * @param {string} input.body - instructions.
   * @param {string} [input.whenToUse] - optional routing hint.
   * @param {Record<string, string|number>} input.state - lifecycle fields.
   * @returns {Promise<void>}
   */
  async function writeSkill(input) {
    const rendered = renderSkillFile({
      name: input.name,
      description: input.description,
      whenToUse: input.whenToUse,
      body: input.body,
      state: input.state
    })
    await mkdir(dirname(input.path), { recursive: true })

    // Everything below guards one property: the bytes land in a regular file
    // inside the skill root, and that file is ours to replace.
    //
    // `lstat` refuses a symlinked SKILL.md: without it, writing "through" a link
    // that appeared after the ownership check would rewrite whatever it points
    // at — and the ownership check reads the target, so it would happily agree.
    // `nlink !== 1` refuses a hard link for the same reason: the file we would
    // overwrite has another name elsewhere.
    const check = async (path) => {
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`refusing to write ${path}: it is a symbolic link`)
      if (!info.isFile()) throw new Error(`refusing to write ${path}: it is not a regular file`)
      if (info.nlink !== 1) throw new Error(`refusing to write ${path}: it has ${info.nlink} hard links`)
      return info
    }

    let created = false
    try {
      await check(input.path)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      // `wx` makes the "create, never clobber" intent atomic: the O_EXCL open
      // either produces a new file or fails because one appeared meanwhile.
      await writeFile(input.path, rendered, { encoding: 'utf8', flag: 'wx' })
      created = true
    }
    if (created) return

    // Validate and overwrite through one descriptor. Re-checking the path and
    // then writing by name is a time-of-check/time-of-use gap: the entry can be
    // swapped for a link between the two calls, and the check passes for the
    // old inode while the write lands on the new one.
    const handle = await open(input.path, 'r+')
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error(`refusing to write ${input.path}: it is not a regular file`)
      if (info.nlink !== 1) throw new Error(`refusing to write ${input.path}: it has ${info.nlink} hard links`)
      const current = await handle.readFile({ encoding: 'utf8' })
      const existing = parseFrontmatter(current)
      if (existing.data?.['evolved-by'] !== OWNER_MARKER) {
        throw new Error(`refusing to overwrite ${input.path}: it was not written by this plugin`)
      }
      await handle.truncate(0)
      // Write from an explicit offset 0. Two traps live here:
      //   * `FileHandle.writeFile` continues from the descriptor's current
      //     offset, and reading the old contents left it at the old end of
      //     file. Truncating does not rewind it, so the new text lands after
      //     `current.length` bytes of NUL padding.
      //   * Passing `{ position: 0 }` to `writeFile` does not help: the option
      //     is silently ignored and the same padding appears.
      // `write` with an explicit position is the call that actually honours it.
      // A single `write` may be short, so loop until the buffer is drained.
      const bytes = Buffer.from(rendered, 'utf8')
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
        if (bytesWritten <= 0) throw new Error(`refusing to write ${input.path}: the write stalled`)
        offset += bytesWritten
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * Remember that this session loaded a skill, for the panel's skill module.
   *
   * Separate from `usedInSession`, which exists to decide catalog truncation and
   * is keyed by the same name but for a different question. Keeping them apart
   * avoids one feature's bookkeeping silently changing another's behaviour —
   * the panel must count a load the model performed even when the catalog
   * rewrite is switched off.
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
  }

  /**
   * Read the skill name out of a `skill` tool call.
   *
   * `tool/call` carries the model's raw, still-streaming argument text, so this
   * is a string in the normal case and an object only when the host handed us
   * a pre-parsed payload. Anything else — malformed JSON, a partial fragment
   * captured mid-stream, the wrong field — is not a load and must not count.
   *
   * @param {unknown} raw - `event.data.arguments`.
   * @returns {string | undefined} the skill name, when there is one.
   */
  function readSkillArgument(raw) {
    let value = raw
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw)
      } catch {
        return undefined
      }
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const name = /** @type {Record<string, unknown>} */ (value).name
    return typeof name === 'string' ? name.trim() : undefined
  }

  /**
   * Record one load of a skill this plugin manages.
   *
   * Ownership is checked against the file, not the registry: a name that is
   * not ours must never be counted, and a registry-only check would let a
   * model inflate a counter by naming somebody else's skill.
   *
   * @param {object} input - the load.
   * @param {string} input.name - the skill name.
   * @param {any} [input.agent] - the loading agent.
   * @param {string} [input.agentId] - the loading session id.
   * @returns {Promise<void>}
   */
  async function countUse(input) {
    // Recorded before the ownership check: the catalog rewrite cares whether
    // the model loaded a skill at all, and an externally installed skill has no
    // `OWNER_MARKER` to pass the check below. Restricting this to our own
    // skills would leave exactly the imported half of a large library always
    // truncated, which is the half a person is least able to judge by name.
    if (typeof input.agentId === 'string') {
      const names = usedInSession.get(input.agentId) ?? new Set()
      names.add(input.name)
      usedInSession.set(input.agentId, names)
    }
    const root = rootFor(input.agent)
    const path = join(root, input.name, SKILL_FILE)
    const parsed = await readSkillFile(path).catch(() => undefined)
    if (parsed === undefined || !parsed.owned) return
    const now = new Date().toISOString()
    // Open the observation window before the counter is written. Only owned
    // skills are observed: an external skill is not something this plugin
    // proposed, revised or can invert, so a row describing its aftermath would
    // add volume without adding a decision. It also keeps the ledger's
    // `skill_result` rows comparable to the `skill_used` rows above them.
    //
    // A load with no session id cannot be attributed to a later turn, so it is
    // not observed at all. Keying a window on `undefined` would make every
    // anonymous load share one window and report the union of their aftermaths.
    //
    // `outcomeTurns: 0` means observation is off. It is checked here rather than
    // inside the window because the window's default is "two turns", and a zero
    // that fell through to that default would silently turn the feature on.
    if (typeof input.agentId === 'string' && config.outcomeTurns > 0) {
      const displaced = outcomes.begin({
        skill: input.name,
        agentId: input.agentId,
        at: now,
        turns: config.outcomeTurns
      })
      if (displaced !== undefined) await recordOutcome(displaced)
    }
    const state = readState(parsed.data)
    const updated = await store.noteUse({
      name: input.name,
      sessionId: input.agentId,
      at: now,
      fallback: {
        stage: state.stage,
        created: state.created,
        uses: state.uses,
        helpful: state.helpful,
        harmful: state.harmful
      }
    })
    // The counter lives in two places: `registry.json` (fast reads) and the
    // skill file's frontmatter (survives a lost registry). They are written
    // separately, so the file is only rewritten when the stage actually moves —
    // otherwise a hot skill would take a full rewrite on every single load.
    const decided = await applyLifecycle({ name: input.name, root, parsed, state: updated })
    if (decided.changed) log(`usage: ${input.name} → ${decided.stage} after ${updated.uses} uses`)
  }

  /**
   * Write a closed observation window to the ledger.
   *
   * A distinct action (`skill_result`) rather than a field on `skill_used`:
   * the two lines are written minutes and sometimes sessions apart, and a
   * single mutable row would have to be rewritten in place — which an
   * append-only ledger cannot do. Two rows joined by `skill` and `sessionId`
   * also survive the case where the window never closes at all, and the reader
   * can see that absence for what it is.
   *
   * @param {object} record - the window's `finish()` output.
   * @returns {Promise<void>}
   */
  async function recordOutcome(record) {
    await store.record({
      at: record.closedAt,
      actor: 'system',
      action: 'skill_result',
      skill: record.skill,
      sessionId: record.sessionId,
      outcome: record.outcome,
      turnsObserved: record.turnsObserved,
      calls: record.calls,
      failures: record.failures,
      retries: record.retries,
      abandonedTurns: record.abandonedTurns,
      failedTools: record.failedTools,
      openedAt: record.openedAt
    })
  }

  /**
   * Apply the lifecycle decision to one skill, rewriting its file if the
   * stage changed.
   *
   * @param {object} input - lifecycle input.
   * @param {string} input.name - skill name.
   * @param {string} input.root - skill root.
   * @param {{data: Record<string, string>, body: string, owned: boolean}} input.parsed - the parsed file.
   * @param {object} input.state - the updated lifecycle state.
   * @returns {Promise<{stage: string, changed: boolean}>} the outcome.
   */
  async function applyLifecycle(input) {
    // Everything below runs inside one critical section. The caller has already
    // written its counters under the registry lock, but the *decision* and the
    // file rewrite used to happen in two later, separate steps: two feedback
    // reports landing together could both decide from their own snapshot and
    // then write the file in the reverse order to the registry, leaving the
    // durable copy (the file, which the next load rebuilds from) one use behind.
    return store.serialize(async () => {
      // Read the live row rather than trusting the caller's snapshot: a
      // concurrent report may have reached a threshold this one does not know
      // about. Counters only move forward, so the larger number is the truth.
      const registry = await store.loadRegistry()
      const live = registry[input.name] ?? {}
      const state = {
        ...input.state,
        uses: Math.max(Number(live.uses ?? 0), Number(input.state.uses ?? 0)),
        helpful: Math.max(Number(live.helpful ?? 0), Number(input.state.helpful ?? 0)),
        harmful: Math.max(Number(live.harmful ?? 0), Number(input.state.harmful ?? 0))
      }

      const decision = decideStage({
        state,
        promoteAfterUses: config.promoteAfterUses,
        invertAfterHarmful: config.invertAfterHarmful,
        staleAfterDays: config.staleAfterDays
      })
      // The caller's state is the lifecycle counters, which do not include the
      // identity fields. Rebuilding the frontmatter from it alone would blank
      // `evolved-id` and `evolved-evidence` on every rewrite, so the file's own
      // values are merged back in underneath.
      const onFile = readState(input.parsed.data)
      const next = {
        ...onFile,
        ...state,
        id: state.id ?? onFile.id,
        created: state.created ?? onFile.created,
        evidence: state.evidence ?? onFile.evidence,
        stage: decision.stage
      }
      // The file is the durable copy of the counters: if `registry.json` is lost,
      // this is what the next load rebuilds from. Writing it only when the stage
      // moves would leave every use between two promotions uncounted on disk, so
      // a lost registry would silently rewind the counter to its last boundary —
      // exactly the evidence the promotion decision depends on.
      const countersMoved =
        onFile.uses !== Number(next.uses ?? 0) ||
        onFile.helpful !== Number(next.helpful ?? 0) ||
        onFile.harmful !== Number(next.harmful ?? 0) ||
        onFile.validated !== String(next.validated ?? '')
      if (!decision.changed && !countersMoved) return { stage: decision.stage, changed: false }

      const path = join(input.root, input.name, SKILL_FILE)
      const body = decision.stage === 'inverted'
        ? invertBody({ name: input.name, originalBody: input.parsed.body, harmful: Number(next.harmful ?? 0) })
        : input.parsed.body
      try {
        await writeSkill({
          path,
          name: input.name,
          description: input.parsed.data.description ?? input.name,
          whenToUse: input.parsed.data['when-to-use'],
          body,
          state: stateToFrontmatter(next)
        })
      } catch (error) {
        log(`lifecycle: failed to rewrite ${input.name}: ${error?.message ?? error}`)
        return { stage: state.stage ?? 'unverified', changed: false }
      }
      // The registry is the read path for every other surface, so a stage that
      // only reached the file would be reported as the old one by `/skill-stats`
      // until something else happened to rewrite it. Spread the live row so
      // flags this write does not own (`pinned`/`demoted`) survive it.
      await store.mutateRegistryWithin(async (current) => {
        const known = current[input.name] ?? {}
        current[input.name] = {
          ...known,
          name: input.name,
          stage: decision.stage,
          created: next.created,
          uses: Number(next.uses ?? 0),
          helpful: Number(next.helpful ?? 0),
          harmful: Number(next.harmful ?? 0),
          validated: next.validated
        }
        return { registry: current, result: undefined }
      })
      if (decision.changed) {
        log(`lifecycle: ${input.name} → ${decision.stage} (${decision.reason})`)
        await store.recordWithin({
          at: new Date().toISOString(),
          actor: 'curator',
          action: decision.stage,
          skill: input.name,
          evidence: decision.reason
        })
      }
      return { stage: decision.stage, changed: decision.changed }
    })
  }

  /**
   * Move one candidate out of the queue and into the skill root.
   *
   * Two approval shapes are supported, and the difference is not cosmetic:
   *
   * - `direct` writes the file now. One step, and the body that lands on disk
   *   is the one the model wrote in a session that has since ended.
   * - `confirm` (the default) stages the candidate as approved and hands the
   *   model the body to re-read against the current catalog before it writes
   *   the final file on its next step. This is Qoder's behaviour; its docs are
   *   explicit that "task creation does not mean the Skill has already
   *   changed."
   *
   * A revision carries its base forward: the lifecycle record survives an edit,
   * because resetting uses and harmful counts on every change would erase the
   * evidence that says whether the skill is worth keeping at all.
   *
   * @param {object} input - approval input.
   * @param {object} input.candidate - the queued candidate.
   * @param {any} [input.agent] - the approving agent.
   * @returns {Promise<{ok: boolean, path?: string, staged?: boolean, error?: string}>} the outcome.
   */
  async function approve(input) {
    const candidate = input.candidate
    const now = new Date().toISOString()

    if (candidate.stale !== undefined && candidate.stale !== null) {
      return { ok: false, error: `this candidate is ${describeStale(candidate.stale)}; regenerate it before approving` }
    }

    if (config.approvalMode === 'confirm') {
      // Staging must report whether it actually staged something: claiming
      // success for a candidate that is no longer in the queue leaves the user
      // waiting for a final step that can never happen.
      //
      // `approvedDigest` records *what* was approved, not just that something
      // was. The confirm flow exists so the model can write a better final
      // draft with the session in front of it, so a changed draft is expected
      // — but a change nobody looked at is not an approval, and without this
      // digest there is nothing to tell the two apart.
      const digest = contentDigest(candidate)
      const staged = await store.mutateCandidates(async (queue) => {
        const index = queue.findIndex((entry) => entry.id === candidate.id)
        if (index === -1) return { result: false }
        const next = queue.slice()
        next[index] = { ...next[index], approvedAt: now, awaitingFinal: true, approvedDigest: digest }
        return { candidates: next, result: true }
      })
      if (!staged) {
        return { ok: false, error: `"${candidate.name}" is no longer in the candidate queue; it may have been approved or discarded already` }
      }
      await store.record({ at: now, actor: 'user', action: 'approve-staged', skill: candidate.name, sessionId: candidate.sessionId })
      log(`approve: staged ${candidate.name} for final confirmation`)
      return { ok: true, staged: true }
    }

    return writeApproved({ candidate, agent: input.agent, now })
  }

  /**
   * Write a candidate that has been approved, either straight away in `direct`
   * mode or as the second half of `confirm`.
   *
   * @param {object} input - write input.
   * @param {object} input.candidate - the approved candidate.
   * @param {any} [input.agent] - the approving agent.
   * @param {string} input.now - ISO timestamp.
   * @param {(value: any) => any} [input.transform] - adjusts the candidate before writing.
   * @returns {Promise<{ok: boolean, path?: string, kind?: string, error?: string}>} the outcome.
   */
  async function writeApproved(input) {
    return store.serialize(() => writeApprovedWithin(input))
  }

  /**
   * The body of {@link writeApproved}, called with the lock already held.
   *
   * @param {object} input - write input.
   * @returns {Promise<{ok: boolean, path?: string, kind?: string, error?: string}>} the outcome.
   */
  async function writeApprovedWithin(input) {
    const candidate = input.transform === undefined ? input.candidate : input.transform(input.candidate)
    // The registry read is inside the critical section because the counters it
    // supplies are written back below; reading it outside would let a feedback
    // collected in between be overwritten with the older number.
    const registry = await store.loadRegistry()
    const previous = candidate.kind === 'update' ? (registry[candidate.name] ?? {}) : {}
    const base = candidate.base ?? {}
    const now = input.now

    const state = candidate.kind === 'update'
      ? {
          // `||`, not `??`, for the string fields: `readState` reports a blank
          // frontmatter value as `''`, so `base.id ?? previous.id` keeps `''`
          // and writes a skill whose identity is empty. Numbers below keep `??`
          // because `0` is a value, not an absence.
          id: base.id || previous.id || candidate.id,
          // Same rule as the counters below: the live row wins. A revision that
          // proposed while the skill was `unverified` must not drag a skill that
          // was promoted in the meantime back down to `unverified`.
          stage: previous.stage || base.stage || 'unverified',
          created: base.created || previous.created || candidate.createdAt,
          // The registry is the live record; `base` is the snapshot the proposal
          // saw. Preferring the base rolled feedback collected between proposal
          // and approval back to the older number.
          uses: Number(previous.uses ?? base.uses ?? 0),
          helpful: Number(previous.helpful ?? base.helpful ?? 0),
          harmful: Number(previous.harmful ?? base.harmful ?? 0),
          validated: now,
          evidence: candidate.evidence.map((entry) => entry.quote).join(' | ').slice(0, 500)
        }
      : {
          id: candidate.id,
          stage: 'unverified',
          created: candidate.createdAt,
          uses: 0,
          helpful: 0,
          harmful: 0,
          validated: now,
          evidence: candidate.evidence.map((entry) => entry.quote).join(' | ').slice(0, 500)
        }

    const path = join(rootFor(input.agent), candidate.name, SKILL_FILE)
    try {
      await writeSkill({
        path,
        name: candidate.name,
        description: candidate.description,
        whenToUse: candidate.whenToUse,
        body: candidate.body,
        state: stateToFrontmatter(state)
      })
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) }
    }

    await store.mutateRegistryWithin(async (current) => {
      // Spread the existing row so flags this write does not own survive it.
      // The literal object that used to be here listed seven fields and so
      // silently erased `pinned` / `demoted` — a person's only manual signal —
      // on every revision.
      current[candidate.name] = {
        ...(current[candidate.name] ?? {}),
        name: candidate.name,
        stage: state.stage,
        created: state.created,
        uses: state.uses,
        helpful: state.helpful,
        harmful: state.harmful,
        validated: now
      }
      return { registry: current, result: undefined }
    })
    await store.mutateCandidatesWithin(async (current) => ({
      candidates: current.filter((entry) => entry.id !== candidate.id),
      result: undefined
    }))
    await store.recordWithin({
      at: now,
      actor: candidate.kind === 'update' ? 'agent' : 'user',
      action: candidate.kind === 'update' ? 'revise' : 'approve',
      skill: candidate.name,
      sessionId: candidate.sessionId
    })
    log(`approve: wrote ${path} (${candidate.kind})`)
    return { ok: true, path, kind: candidate.kind }
  }

  /**
   * Write the final version of a staged candidate.
   *
   * Called from the model's next step, after approval. The evidence gate is
   * NOT re-run here: it ran when the skill was proposed, and its verdict is
   * stored on the candidate (`verifiedAt` / `verifiedInSession`). Re-running it
   * would test the approving session, which is usually a different session and
   * has none of the quotes — every cross-session approval would be rejected.
   * What IS re-checked is the base: a person approved a draft, and an edit made
   * between proposal and approval must still be noticed rather than overwritten.
   *
   * @param {object} input - finalisation input.
   * @param {string} input.name - the skill name.
   * @param {string} input.description - the final description.
   * @param {string} input.body - the final body.
   * @param {string} [input.whenToUse] - optional routing hint.
   * @param {any} [input.agent] - the writing agent.
   * @returns {Promise<object>} the outcome.
   */
  async function finalize(input) {
    // The whole of finalize is one critical section: it reads the queue,
    // decides whether the approval still covers this text, and writes the
    // skill. Split across separate locks, two callers both see
    // `awaitingFinal === true`, both pass the digest check, and both write —
    // the queue filter only makes the second one fail to remove its entry,
    // which is after the file has already been overwritten.
    return store.serialize(() => finalizeWithin(input))
  }

  /**
   * The body of {@link finalize}, called with the lock already held.
   *
   * @param {object} input - finalisation input.
   * @returns {Promise<object>} the outcome.
   */
  async function finalizeWithin(input) {
    // Recompute the staleness verdicts here rather than trusting the ones on
    // disk. `store.loadCandidates()` returns the snapshot exactly as the last
    // writer left it, and `isLive` below only asks whether a `stale` field is
    // present — so a candidate that went stale *after* it was approved (the
    // file it revises was edited, or it aged past the TTL) would look live and
    // be written over somebody else's change.
    //
    // `annotateQueue` runs inside `mutateCandidatesWithin`, not through
    // `loadQueue()`: `loadQueue` takes the mutation lock itself, and the whole
    // of `finalize` already holds it, so calling it here would wait on a queue
    // that cannot drain until this function returns.
    const queue = await store.mutateCandidatesWithin(async (raw) => {
      const annotated = await annotateQueue({
        candidates: raw,
        options: {
          now: new Date(),
          ttlDays: config.candidateTtlDays,
          lookup: probeSkill,
          sessionExists: config.verifyCandidateSource ? sessionExists : undefined
        }
      })
      return {
        candidates: annotated.changed ? annotated.candidates : undefined,
        result: annotated.candidates
      }
    })
    const candidate = findByName(queue, input.name)
    if (candidate === undefined) {
      return { ok: false, code: 'not-pending', error: `"${input.name}" is not in the candidate queue. Submit it with skill_candidate_submit first.` }
    }
    if (candidate.awaitingFinal !== true) {
      return { ok: false, code: 'not-approved', error: `"${input.name}" has not been approved yet. Ask the user to approve it with /skill-capture ${input.name}.` }
    }
    if (!isLive(candidate)) {
      return { ok: false, code: 'stale', error: `"${input.name}" went stale after approval: ${describeStale(candidate.stale)}. Submit it again.` }
    }

    // Approval covers a specific draft. The confirm flow lets the model improve
    // that draft with the session in front of it, so a difference is expected —
    // what is not allowed is publishing the difference under the old yes. When
    // the text moved, the candidate goes back for one more look with the new
    // text in it, and this call reports that rather than writing.
    const finalised = {
      name: candidate.name,
      description: input.description,
      body: input.body,
      whenToUse: input.whenToUse ?? candidate.whenToUse
    }
    const approvedDigest = typeof candidate.approvedDigest === 'string' ? candidate.approvedDigest : undefined
    const finalDigest = contentDigest(finalised)
    if (approvedDigest !== undefined && approvedDigest !== finalDigest) {
      const requeued = await store.mutateCandidatesWithin(async (queue) => {
        const index = queue.findIndex((entry) => entry.id === candidate.id)
        if (index === -1) return { result: false }
        const next = queue.slice()
        next[index] = {
          ...next[index],
          description: finalised.description,
          body: finalised.body,
          whenToUse: finalised.whenToUse,
          awaitingFinal: false,
          approvedAt: undefined,
          approvedDigest: undefined
        }
        return { candidates: next, result: true }
      })
      if (!requeued) {
        return { ok: false, code: 'not-pending', error: `"${input.name}" left the queue while its final draft was being checked. Nothing was written.` }
      }
      await store.recordWithin({ at: new Date().toISOString(), actor: 'agent', action: 'reapproval-required', skill: candidate.name, sessionId: candidate.sessionId })
      log(`finalize: ${candidate.name} changed since approval; staged the new text for another look`)
      return {
        ok: false,
        code: 'changed-since-approval',
        error: [
          'The draft changed after it was approved, so nobody has seen this version yet and nothing was written.',
          `The queue now holds the new text under "${candidate.name}".`,
          'Ask the user to approve it again once they have read the description and body above.'
        ].join(' ')
      }
    }

    const result = await writeApprovedWithin({
      candidate,
      agent: input.agent,
      now: new Date().toISOString(),
      transform: (entry) => ({
        ...entry,
        description: input.description,
        body: input.body,
        whenToUse: input.whenToUse ?? entry.whenToUse
      })
    })
    if (result.ok === false) return { ok: false, code: 'write-failed', error: result.error }
    // Report the count the candidate was *accepted* with. The finalise path
    // cannot re-verify evidence — those quotes belong to the session that
    // produced them, not to this one — so what it can honestly say is how many
    // verified quotes came with the draft a person approved.
    return { ok: true, path: result.path, kind: result.kind, survived: candidate.evidence?.length ?? 0 }
  }

  /**
   * The tools, with their collaborators wired up.
   */
  const tools = createTools({
    config,
    store,
    eventsFor,
    sessionIdFor,
    workspaceFor,
    skillRootFor: rootFor,
    loadQueue,
    finalize,
    writeSkill,
    applyLifecycle,
    // `skill_search` reads the host's skill catalog through this. Omitting it
    // does not fail loudly: `createTools` defaults the dependency to a function
    // returning `undefined`, so the tool stays registered and answers "the host
    // does not expose a skill catalog" on every call. Only a wiring test — one
    // that goes through `apply` — catches that; unit tests inject the service.
    service,
    // The install tool writes the bundle the gate downloaded and the person
    // approved. Re-fetching here would make the approval apply to whatever the
    // market served the second time.
    takeApprovedBundle,
    log
  })

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `skill-evolve ${tool.name} tool`)
  }

  // ------------------------------------------------------------- commands --

  const commands = createCommands({
    store,
    loadQueue,
    approve,
    rank: async (skillName, change) => store.markSkill({
      name: skillName,
      pinned: change.pinned,
      demoted: change.demoted,
      at: new Date().toISOString()
    }),
    feedback: async (skillName, verdict, note) => {
      const root = rootFor(undefined)
      const path = join(root, skillName, SKILL_FILE)
      const parsed = await readSkillFile(path)
      if (!parsed.owned) throw new Error(`"${skillName}" was not written by this plugin`)
      const now = new Date().toISOString()
      const next = await store.mutateRegistry(async (registry) => {
        const state = registry[skillName] ?? {}
        const updated = {
          ...state,
          name: skillName,
          stage: state.stage ?? 'unverified',
          created: state.created ?? parsed.data['evolved-created'] ?? now,
          uses: Number(state.uses ?? 0) + (verdict === 'helpful' ? 1 : 0),
          helpful: Number(state.helpful ?? 0) + (verdict === 'helpful' ? 1 : 0),
          harmful: Number(state.harmful ?? 0) + (verdict === 'harmful' ? 1 : 0),
          validated: now,
          note: note.length > 0 ? note.slice(0, 500) : state.note
        }
        registry[skillName] = updated
        return { registry, result: updated }
      })
      await store.record({ at: now, actor: 'user', action: verdict, skill: skillName, evidence: note })
      const decided = await applyLifecycle({ name: skillName, root, parsed, state: next })
      return { ok: true, stage: decided.stage }
    },
    stats: async () => {
      const root = rootFor(undefined)
      const managed = await listOwnedSkills(root)
      const registry = await store.loadRegistry()
      const rows = []
      for (const skill of managed) {
        const state = registry[skill.name] ?? {}
        rows.push({
          name: skill.name,
          stage: state.stage ?? 'unverified',
          uses: Number(state.uses ?? 0),
          harmful: Number(state.harmful ?? 0),
          confidence: confidence(state)
        })
      }
      return rows.sort((a, b) => b.confidence - a.confidence)
    },
    log
  })

  // `commands` is reached through `ctx.inject` rather than the plugin's own
  // `inject` list, because cordis has no "optional dependency": every name in
  // `inject` is required, and a missing one means `apply` never runs at all.
  // Delegating the dependency here lets a host without `dsh-commands` keep the
  // tools and the detector and lose only the slash commands — which is what the
  // comment on `inject` promises.
  ctx.inject(['commands'], (commandCtx) => {
    for (const command of commands) {
      commandCtx.effect(() => commandCtx.commands.register(command), `skill-evolve ${command.name} command`)
    }
  })

  log(`ready (mode=${config.mode}, state=${store.root}, skills=${rootFor(undefined)})`)
  void dshHome
  void readState
}
