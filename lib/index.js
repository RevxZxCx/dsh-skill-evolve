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
import { createTools } from './tools.js'
import { createCommands } from './commands.js'
import { HintChannel, renderHint } from './hint.js'
import { ReflectionPacer, renderReflection } from './reflection.js'
import { Store } from './store.js'
import { OWNER_MARKER, parseFrontmatter, SKILL_FILE, listOwnedSkills, readSkillFile, renderSkillFile, readState } from './skillfile.js'
import { confidence, decideStage, invertBody, stateToFrontmatter } from './lifecycle.js'
import { annotateQueue, describeStale, findByName, isLive } from './candidates.js'

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
  }))

  ctx.on('agent/disposed', safe('disposal', ({ agent }) => {
    const agentId = sessionIdFor(agent)
    if (agentId.length > 0) {
      hints.forget(agentId)
      detectors.delete(agentId)
      pacer.forget(agentId)
    }
  }))

  // Clear the hint as soon as the model acts on it, so the next steps stop
  // paying for text that has already been read.
  ctx.on('session/event', safe('hint clear', (session, event) => {
    if (event?.type !== 'tool/call') return
    const toolName = event?.data?.name
    if (typeof toolName !== 'string' || !toolName.startsWith('skill_candidate')) return
    const agentId = session?.id
    if (typeof agentId === 'string') hints.clear(agentId)
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
    const agent = ctx.agents?.get?.(agentId)
    // Subagents are counted even though they are excluded from hints: unlike a
    // hint, which a subagent cannot act on because it must not write skills, a
    // load is a real load regardless of which agent performed it. Excluding
    // them here would systematically under-count exactly the delegated work
    // that makes a procedure worth codifying in the first place.
    return countUse({ name: skillName, agent, agentId: typeof agentId === 'string' ? agentId : undefined })
  }))

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
    const root = rootFor(input.agent)
    const path = join(root, input.name, SKILL_FILE)
    const parsed = await readSkillFile(path).catch(() => undefined)
    if (parsed === undefined || !parsed.owned) return
    const now = new Date().toISOString()
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

  async function applyLifecycle(input) {
    const decision = decideStage({
      state: input.state,
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
      ...input.state,
      id: input.state.id ?? onFile.id,
      created: input.state.created ?? onFile.created,
      evidence: input.state.evidence ?? onFile.evidence,
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
      return { stage: input.state.stage ?? 'unverified', changed: false }
    }
    // The registry is the read path for every other surface, so a stage that
    // only reached the file would be reported as the old one by `/skill-stats`
    // until something else happened to rewrite it. The counters are written by
    // the caller under the same lock, so only the stage is set here.
    if (decision.changed) {
      await store.mutateRegistry(async (registry) => {
        const known = registry[input.name] ?? {}
        registry[input.name] = {
          ...known,
          name: input.name,
          stage: decision.stage,
          created: next.created,
          uses: Number(next.uses ?? 0),
          helpful: Number(next.helpful ?? 0),
          harmful: Number(next.harmful ?? 0),
          validated: next.validated
        }
        return { registry, result: undefined }
      })
      log(`lifecycle: ${input.name} → ${decision.stage} (${decision.reason})`)
      await store.record({
        at: new Date().toISOString(),
        actor: 'curator',
        action: decision.stage,
        skill: input.name,
        evidence: decision.reason
      })
    }
    return { stage: decision.stage, changed: decision.changed }
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
      const staged = await store.mutateCandidates(async (queue) => {
        const index = queue.findIndex((entry) => entry.id === candidate.id)
        if (index === -1) return { result: false }
        const next = queue.slice()
        next[index] = { ...next[index], approvedAt: now, awaitingFinal: true }
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
    const candidate = input.transform === undefined ? input.candidate : input.transform(input.candidate)
    // The registry read is only a fallback source for lifecycle counters, so it
    // happens before the lock; the write itself is a transform under the lock
    // so a concurrent feedback write is not erased.
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

    await store.mutateRegistry(async (current) => {
      current[candidate.name] = {
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
    await store.mutateCandidates(async (current) => ({
      candidates: current.filter((entry) => entry.id !== candidate.id),
      result: undefined
    }))
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

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `skill-evolve ${tool.name} tool`)
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
