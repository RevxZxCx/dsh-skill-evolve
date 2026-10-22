/**
 * The turn trigger: reflect once at the end of a real conversation turn.
 *
 * Why this exists next to the repetition detector. The detector sees
 * structure — "these three tool names appeared again in this order" — and is
 * therefore blind to everything that is not structural: which API returned
 * zero rows, why the first approach was abandoned, what the person said they
 * actually wanted. Those are the most valuable things to write down, and they
 * only exist in the conversation text.
 *
 * Qoder solves this by reflecting at task end and letting the model summarise
 * what it learned. That is affordable here for a specific reason: **the model
 * is already in the conversation**. It is not a second pass over the
 * transcript, it is one more instruction attached to a step the model was
 * going to take anyway. The expensive shape — fork a subagent, replay the
 * transcript, ask it to distil — is what `@loserfox/distill` did, and it is
 * both costly and broken on this host.
 *
 * The two triggers are complementary, not alternative:
 *
 * - **Turn end** catches semantic knowledge: a project convention, a library
 *   pitfall, a correction the person made. Wide coverage, no structure needed.
 * - **Repetition** catches procedures: a multi-step loop worth re-running.
 *   Narrow but precise, and it needs no turn boundary to fire.
 *
 * Both write into the same hint channel so the prompt sees one stable string.
 *
 * @module dsh-skill-evolve/reflection
 */

/**
 * Event source values that mean "a person typed this".
 *
 * The others are the host talking to itself: `agent-instructions` is the
 * AGENTS.md baseline, `runtime-context` is the per-step snapshot,
 * `user-approval` is a tool approval receipt. Counting those as turns would
 * make every step look like a fresh conversation. Verified against a real
 * session log, where all four kinds appear.
 */
const HUMAN_SOURCES = new Set(['user'])

/**
 * Track per-session turn counts and decide when a reflection is due.
 */
export class ReflectionPacer {
  /**
   * @param {object} options - construction options.
   * @param {number} options.cadence - human turns between reflections.
   * @param {number} options.minToolCalls - tool calls a turn needs to be worth reflecting on.
   * @param {number} options.maxPerSession - hard cap per session.
   * @param {(...parts: any[]) => void} [options.log] - logger sink.
   */
  constructor(options) {
    this.cadence = options.cadence
    this.minToolCalls = options.minToolCalls
    this.maxPerSession = options.maxPerSession
    this.log = options.log ?? (() => {})
    /** @type {Map<string, {turns: number, sinceReflection: number, toolCalls: number, reflected: number, lastAt: number}>} */
    this.state = new Map()
  }

  /**
   * Read (and lazily create) one session's counter.
   *
   * @param {string} sessionId - the session id.
   * @returns {{turns: number, sinceReflection: number, toolCalls: number, reflected: number, lastAt: number}} the counter.
   */
  counter(sessionId) {
    let counter = this.state.get(sessionId)
    if (counter === undefined) {
      counter = { turns: 0, sinceReflection: 0, toolCalls: 0, reflected: 0, lastAt: 0 }
      this.state.set(sessionId, counter)
    }
    return counter
  }

  /**
   * Whether a `user/message` event is a real human turn.
   *
   * @param {object} event - the session event.
   * @returns {boolean} true for a person typing.
   */
  static isHumanMessage(event) {
    if (event?.type !== 'user/message') return false
    const kind = event?.data?.source?.kind
    return typeof kind === 'string' && HUMAN_SOURCES.has(kind)
  }

  /**
   * Count one human message.
   *
   * @param {string} sessionId - the session id.
   * @returns {void}
   */
  countHumanMessage(sessionId) {
    const counter = this.counter(sessionId)
    counter.turns += 1
    // Cadence is measured from the last reflection, not from session start.
    // Without this, a session that reflects once at turn 3 is due again on
    // every subsequent turn and the checkpoint becomes a metronome.
    counter.sinceReflection += 1
    counter.toolCalls = 0
  }

  /**
   * Count one tool call inside the current turn.
   *
   * @param {string} sessionId - the session id.
   * @returns {void}
   */
  countToolCall(sessionId) {
    this.counter(sessionId).toolCalls += 1
  }

  /**
   * Decide whether a reflection is due at the end of a completed turn.
   *
   * Three conditions, all of which exist to keep the plugin quiet:
   *
   * 1. **Cadence.** At least `cadence` human turns since the last reflection.
   * 2. **Substance.** The turn did real work. A question answered in one
   *    sentence teaches nothing worth saving, and Qoder's own documentation
   *    says the same thing: "Not every task generates a suggestion."
   * 3. **Budget.** A session that keeps reflecting becomes the noise it was
   *    meant to cut through.
   *
   * @param {string} sessionId - the session id.
   * @param {object} [options] - evaluation options.
   * @param {boolean} [options.hasSubstance] - override the tool-call test.
   * @returns {{due: boolean, reason: string, turns: number, toolCalls: number}} the decision.
   */
  evaluate(sessionId, options = {}) {
    const counter = this.counter(sessionId)
    if (counter.reflected >= this.maxPerSession) {
      return { due: false, reason: `reflection budget spent (${counter.reflected}/${this.maxPerSession})`, turns: counter.turns, toolCalls: counter.toolCalls }
    }
    // Ration, do not spend. A fixed cadence spends the whole budget in the
    // first few turns of a long session: replaying a real 15-turn session with
    // cadence 3 and budget 2 fired both reflections by turn 7 and left the
    // last eight turns uncovered. Each reflection now doubles the wait, so a
    // second checkpoint lands near the middle of the session instead of just
    // after the first.
    const effective = this.cadence * 2 ** counter.reflected
    if (counter.sinceReflection < effective) {
      return { due: false, reason: `${counter.sinceReflection} turn(s) since the last reflection, waiting for ${effective}`, turns: counter.turns, toolCalls: counter.toolCalls }
    }
    const substance = options.hasSubstance ?? counter.toolCalls >= this.minToolCalls
    if (!substance) {
      return { due: false, reason: `only ${counter.toolCalls} tool call(s) this turn`, turns: counter.turns, toolCalls: counter.toolCalls }
    }
    return { due: true, reason: `${counter.sinceReflection} turn(s) since the last reflection, ${counter.toolCalls} tool calls this turn`, turns: counter.turns, toolCalls: counter.toolCalls }
  }

  /**
   * Record that a reflection was offered, resetting the cadence clock.
   *
   * @param {string} sessionId - the session id.
   * @returns {void}
   */
  markReflected(sessionId) {
    const counter = this.counter(sessionId)
    counter.reflected += 1
    counter.sinceReflection = 0
    counter.lastAt = Date.now()
  }

  /**
   * Drop one session's counters.
   *
   * @param {string} sessionId - the session id.
   * @returns {void}
   */
  forget(sessionId) {
    this.state.delete(sessionId)
  }
}

/**
 * Render the reflection prompt.
 *
 * Deliberately short. This text is prepended to a step the model was going to
 * take anyway, so every line costs tokens in every subsequent request in the
 * session until it is cleared. It names the three questions that produce a
 * usable skill and explicitly licenses "nothing" as an answer — a reflection
 * that always finds something is a reflection that writes noise.
 *
 * @param {object} input - rendering input.
 * @param {number} [input.turns] - human turns so far, for context.
 * @param {Array<{steps: string[], occurrences: number}>} [input.procedures] - repeated procedures the detector saw.
 * @param {(steps: string[]) => string} [input.renderSteps] - step renderer.
 * @returns {string} the hint text.
 */
export function renderReflection(input) {
  const lines = [
    '[skill-evolve] This turn is a checkpoint. Before you answer, decide whether it taught you',
    'something a future session would need and could not rediscover cheaply.',
    '',
    'Ask yourself:',
    '  1. Did the person correct me, or state a preference about how this work should be done?',
    '  2. Did I hit a dead end and find the way through? Name the dead end explicitly.',
    '  3. Did I learn a fact about this project or library that is not obvious from its code?'
  ]
  if (Array.isArray(input.procedures) && input.procedures.length > 0 && typeof input.renderSteps === 'function') {
    lines.push('')
    lines.push('Independently of the above, these tool sequences repeated this session and may be')
    lines.push('worth capturing as a procedure:')
    for (const procedure of input.procedures.slice(0, 3)) {
      lines.push(`  ${input.renderSteps(procedure.steps)}  ×${procedure.occurrences}`)
    }
  }
  lines.push('')
  lines.push('If the answer to all three is no, reply normally and ignore this message — **nothing')
  lines.push('is written on your behalf either way**. If the answer is yes, call')
  lines.push('`skill_candidate_submit` with the lesson and at least one quote copied verbatim')
  lines.push('from this conversation as evidence. Record what failed, not just what worked: a named')
  lines.push('dead end is worth more to the next session than a description of the happy path.')
  return lines.join('\n')
}
