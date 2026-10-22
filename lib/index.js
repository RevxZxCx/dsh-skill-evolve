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

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Config } from './config.js'
import { dshHome, skillRoot } from './paths.js'
import { createDetector, renderSteps } from './signal.js'
import { createTools } from './tools.js'
import { createCommands } from './commands.js'
import { HintChannel, renderHint } from './hint.js'
import { ReflectionPacer, renderReflection } from './reflection.js'
import { Store } from './store.js'
import { SKILL_FILE, listOwnedSkills, readSkillFile, renderSkillFile, readState } from './skillfile.js'
import { confidence, decideStage, invertBody, stateToFrontmatter } from './lifecycle.js'
import { annotateQueue, describeStale, findByName, isLive } from './candidates.js'

/** Cordis plugin name. */
export const name = 'skill-evolve'

/**
 * Services used when present.
 *
 * Every one of them is guarded at the call site: a host that mounts this
 * plugin without `commands` should lose the slash commands, not fail to
 * start.
 */
export const inject = ['tools', 'commands', 'systemPrompt']

export { Config }

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

  const store = new Store({ log })
  const hints = new HintChannel({ maxHintsPerSession: config.maxHintsPerSession, log })
  const pacer = new ReflectionPacer({
    cadence: config.reflectionCadence,
    minToolCalls: config.reflectionMinToolCalls,
    maxPerSession: config.maxReflectionsPerSession,
    log
  })
  const triggers = new Set(config.triggers)
  /** @type {Map<string, ReturnType<typeof createDetector>>} */
  const detectors = new Map()
  /** @type {WeakMap<object, string>} */
  const sessionOfAgent = new WeakMap()

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
    const registry = ctx.agents
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
    const query = ctx.sessionQuery ?? ctx.get?.('sessionQuery')
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
    const raw = await store.loadCandidates()
    const annotated = await annotateQueue({
      candidates: raw,
      options: {
        now: new Date(),
        ttlDays: config.candidateTtlDays,
        lookup: probeSkill,
        sessionExists: config.verifyCandidateSource ? sessionExists : undefined
      }
    })
    if (annotated.changed) await store.saveCandidates(annotated.candidates)
    return annotated.candidates
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
  if (ctx.systemPrompt !== undefined && typeof ctx.systemPrompt.context === 'function') {
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
  } else {
    log('systemPrompt unavailable: hints disabled')
  }

  // ------------------------------------------------------------- detection --

  ctx.on('session/event', (session, event) => {
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
    const agent = ctx.agents?.get?.(agentId)
    if (agent !== undefined && !isRoot(agent)) return
    const toolName = event?.data?.name
    if (typeof toolName !== 'string') return

    const detector = detectorFor(agentId)
    detector.record(toolName)
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
    const outcome = hints.publish({
      agentId,
      signature: primary.signature,
      steps: primary.steps,
      text
    })
    if (outcome === 'published') {
      log(`hint published for ${agentId}: ${renderSteps(primary.steps)} ×${primary.occurrences}`)
    }
  })

  // ------------------------------------------------------------ reflection --

  // Count real human turns and fire the reflection checkpoint at turn end.
  //
  // `user/message` covers four different sources: a person typing (`user`),
  // the AGENTS.md baseline (`agent-instructions`), the per-step runtime
  // snapshot (`runtime-context`), and an approval receipt (`user-approval`).
  // Only the first is a turn. Counting the others would make every step look
  // like a new conversation and fire the checkpoint continuously.
  ctx.on('session/event', (session, event) => {
    if (config.mode === 'off') return
    if (!triggers.has('turn')) return
    const agentId = session?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return
    const agent = ctx.agents?.get?.(agentId)
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
    const outcome = hints.publish({
      agentId,
      signature: `turn#${decision.turns}`,
      steps: [`__reflection_${decision.turns}__`],
      text,
      distinct: true
    })
    if (outcome === 'published') {
      pacer.markReflected(agentId)
      log(`reflection offered for ${agentId} after ${decision.turns} turns (${decision.toolCalls} tool calls)`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const agentId = sessionIdFor(agent)
    if (agentId.length > 0) {
      hints.forget(agentId)
      detectors.delete(agentId)
      pacer.forget(agentId)
    }
  })

  // Clear the hint as soon as the model acts on it, so the next steps stop
  // paying for text that has already been read.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'tool/call') return
    const toolName = event?.data?.name
    if (typeof toolName !== 'string' || !toolName.startsWith('skill_candidate')) return
    const agentId = session?.id
    if (typeof agentId === 'string') hints.clear(agentId)
  })

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
    try {
      const existing = await readSkillFile(input.path)
      if (!existing.owned) {
        throw new Error(`refusing to overwrite ${input.path}: it was not written by this plugin`)
      }
      await writeFile(input.path, rendered, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      // `wx` makes the "create, never clobber" intent atomic.
      await writeFile(input.path, rendered, { encoding: 'utf8', flag: 'wx' })
    }
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
    const decision = decideStage({
      state: input.state,
      promoteAfterUses: config.promoteAfterUses,
      invertAfterHarmful: config.invertAfterHarmful,
      staleAfterDays: config.staleAfterDays
    })
    const next = { ...input.state, stage: decision.stage }
    if (!decision.changed) return { stage: decision.stage, changed: false }

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
      return { stage: input.state.stage ?? 'unverified', changed: false }
    }
    log(`lifecycle: ${input.name} → ${decision.stage} (${decision.reason})`)
    await store.record({
      at: new Date().toISOString(),
      actor: 'curator',
      action: decision.stage,
      skill: input.name,
      evidence: decision.reason
    })
    return { stage: decision.stage, changed: true }
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
      const queue = await store.loadCandidates()
      await store.saveCandidates(queue.map((entry) => entry.id === candidate.id
        ? { ...entry, approvedAt: now, awaitingFinal: true }
        : entry))
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
    const candidate = input.transform === undefined ? input.candidate : input.transform(input.candidate)
    const registry = await store.loadRegistry()
    const previous = candidate.kind === 'update' ? (registry[candidate.name] ?? {}) : {}
    const base = candidate.base ?? {}
    const now = input.now

    const state = candidate.kind === 'update'
      ? {
          id: base.id ?? previous.id ?? candidate.id,
          stage: base.stage ?? previous.stage ?? 'unverified',
          created: base.created ?? previous.created ?? candidate.createdAt,
          uses: Number(base.uses ?? previous.uses ?? 0),
          helpful: Number(base.helpful ?? previous.helpful ?? 0),
          harmful: Number(base.harmful ?? previous.harmful ?? 0),
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

    registry[candidate.name] = {
      name: candidate.name,
      stage: state.stage,
      created: state.created,
      uses: state.uses,
      helpful: state.helpful,
      harmful: state.harmful,
      validated: now
    }
    await store.saveRegistry(registry)
    const remaining = await store.loadCandidates()
    await store.saveCandidates(remaining.filter((entry) => entry.id !== candidate.id))
    await store.record({
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
   * Called from the model's next step, after approval. The candidate goes back
   * through the evidence gate — a person approved a draft, not a licence to
   * write arbitrary text afterwards — and the base check is re-run so an edit
   * made in between is still noticed.
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
    const queue = await loadQueue()
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
    const result = await writeApproved({
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
    return { ok: true, path: result.path, kind: result.kind }
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
    log
  })

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    for (const tool of tools) {
      ctx.effect(() => ctx.tools.register(tool), `skill-evolve ${tool.name} tool`)
    }
  } else {
    log('tools unavailable: model-facing tools disabled')
  }

  // ------------------------------------------------------------- commands --

  const commands = createCommands({
    store,
    loadQueue,
    approve,
    feedback: async (skillName, verdict, note) => {
      const root = rootFor(undefined)
      const path = join(root, skillName, SKILL_FILE)
      const parsed = await readSkillFile(path)
      if (!parsed.owned) throw new Error(`"${skillName}" was not written by this plugin`)
      const registry = await store.loadRegistry()
      const state = registry[skillName] ?? {}
      const now = new Date().toISOString()
      const next = {
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
      registry[skillName] = next
      await store.saveRegistry(registry)
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

  if (ctx.commands !== undefined && typeof ctx.commands.register === 'function') {
    for (const command of commands) {
      ctx.effect(() => ctx.commands.register(command), `skill-evolve ${command.name} command`)
    }
  } else {
    log('commands unavailable: slash commands disabled')
  }

  log(`ready (mode=${config.mode}, state=${store.root}, skills=${rootFor(undefined)})`)
  void dshHome
  void readState
}
