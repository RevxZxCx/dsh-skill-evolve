/**
 * The hint channel: one dynamic prompt context per agent, plus the throttle
 * that keeps it quiet.
 *
 * This is the only place the plugin touches the model's prompt, and prompt
 * text is expensive in a specific way: the host re-assembles dynamic contexts
 * on every step (`refreshContext`), so any change to the rendered text
 * invalidates the request prefix cache for the whole conversation. Two
 * consequences shape the design:
 *
 * 1. The text is **stable between changes**. It is not a per-step stream; it
 *    is a single string that stays byte-identical until a new procedure is
 *    worth mentioning, and then stays byte-identical again.
 * 2. **Empty means absent.** Rendering `''` makes the host drop the context
 *    entirely (`filter(section => section.text.length > 0)`), so a session
 *    with nothing to say contributes zero tokens and zero cache churn.
 *
 * The throttle is per session, not per step: a model that is told "you just
 * repeated a procedure" on every single step learns to ignore it.
 *
 * @module dsh-skill-evolve/hint
 */

/**
 * Manage hint text for a set of agents.
 */
export class HintChannel {
  /**
   * @param {object} options - construction options.
   * @param {number} options.maxHintsPerSession - hard cap per session.
   * @param {(...parts: any[]) => void} [options.log] - logger sink.
   */
  constructor(options) {
    this.maxHintsPerSession = options.maxHintsPerSession
    this.log = options.log ?? (() => {})
    /** @type {Map<string, {text: string, emitted: number, shown: string[][]}>} */
    this.state = new Map()
  }

  /**
   * Read (and lazily create) one agent's channel.
   *
   * @param {string} agentId - the agent id.
   * @returns {{text: string, emitted: number, shown: Set<string>}} the channel state.
   */
  channel(agentId) {
    let channel = this.state.get(agentId)
    if (channel === undefined) {
      channel = { text: '', emitted: 0, shown: [] }
      this.state.set(agentId, channel)
    }
    return channel
  }

  /**
   * Render the hint text for one agent.
   *
   * Called synchronously during assembly, so it must not await anything: it
   * only reads the already-computed string.
   *
   * @param {string} agentId - the agent id.
   * @returns {string} the text, or `''` for no contribution.
   */
  textFor(agentId) {
    return this.state.get(agentId)?.text ?? ''
  }

  /**
   * Whether this agent has already been told about a given procedure.
   *
   * Equality is not enough here. The detector observes a growing stream, so a
   * workflow that is still in progress gets reported first in the shape it has
   * today and again in the shape it has two calls later: `read,edit,bash`
   * followed by `read,edit,bash,grep`. Both are one habit, and publishing the
   * second teaches the model that these hints repeat themselves.
   *
   * A procedure counts as already shown when its steps appear as a contiguous
   * run inside one already shown, or when a shown run appears inside it. The
   * rotation cases are pruned inside the detector and never reach here.
   *
   * @param {string} agentId - the agent id.
   * @param {string[]} steps - the procedure's tool names in order.
   * @returns {boolean} true when it has.
   */
  alreadyShown(agentId, steps) {
    return this.channel(agentId).shown.some((shown) => isSubRun(steps, shown) || isSubRun(shown, steps))
  }

  /**
   * Publish a hint for one agent, if the session budget allows it.
   *
   * @param {object} input - the hint.
   * @param {string} input.agentId - the agent id.
   * @param {string} input.signature - the procedure signature, for logging.
   * @param {string[]} input.steps - the procedure's tool names in order.
   * @param {string} input.text - the rendered hint body.
   * @param {boolean} [input.distinct] - skip the procedure dedup check.
   * @returns {'published' | 'duplicate' | 'exhausted'} what happened.
   */
  publish(input) {
    const channel = this.channel(input.agentId)
    // The dedup check exists to stop one *procedure* being announced in
    // successive shapes as its tool stream grows. A turn-end reflection is not
    // a procedure: it has no steps of its own, so it would collide with the
    // previous reflection on nothing but its placeholder marker. Its own
    // throttle is the pacer's per-session budget, which is a better fit.
    if (input.distinct !== true && this.alreadyShown(input.agentId, input.steps)) return 'duplicate'
    if (channel.emitted >= this.maxHintsPerSession) return 'exhausted'
    channel.shown.push([...input.steps])
    channel.emitted += 1
    channel.text = input.text
    this.log(`hint: published ${input.signature} to ${input.agentId} (${channel.emitted}/${this.maxHintsPerSession})`)
    return 'published'
  }

  /**
   * Clear the visible text without forgetting what was already shown.
   *
   * Used when the model acts on a hint: the text disappears so the next step
   * does not keep paying for it, but the procedure stays "already mentioned"
   * so it is not offered again.
   *
   * @param {string} agentId - the agent id.
   * @returns {void}
   */
  clear(agentId) {
    const channel = this.state.get(agentId)
    if (channel !== undefined) channel.text = ''
  }

  /**
   * Drop all state for one agent.
   *
   * @param {string} agentId - the agent id.
   * @returns {void}
   */
  forget(agentId) {
    this.state.delete(agentId)
  }
}

/**
 * Whether `needle` appears as a contiguous run inside `haystack`.
 *
 * @param {string[]} needle - the shorter sequence.
 * @param {string[]} haystack - the longer sequence.
 * @returns {boolean} true when present.
 */
export function isSubRun(needle, haystack) {
  if (needle.length === 0 || needle.length > haystack.length) return false
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) { matched = false; break }
    }
    if (matched) return true
  }
  return false
}

/**
 * Render the hint body for one detected procedure.
 *
 * The wording matters more than the plumbing here. Three things are stated
 * explicitly because leaving them implicit produced skills that were either
 * duplicate or useless in the surveyed implementations:
 *
 * - **Check the catalog first.** A second skill covering an existing one is
 *   noise, and the catalog is already visible to the model.
 * - **"Without being asked" is wrong.** The user must not discover that a
 *   skill was written on their behalf.
 * - **Dead ends carry the value.** A procedure that does not name what failed
 *   teaches the next session nothing it could not have guessed.
 *
 * @param {object} input - render input.
 * @param {Array<{steps: string[], occurrences: number, coverage: number}>} input.procedures - detected procedures.
 * @param {(steps: string[]) => string} input.renderSteps - arrow renderer.
 * @param {number} input.observerRatioWarn - ratio above which observation-only procedures are discouraged.
 * @returns {string} the hint text.
 */
export function renderHint(input) {
  const lines = [
    '[skill-evolve] The tool sequence below repeated in this conversation. If it embodies a',
    'procedure worth reusing, call `skill_candidate_submit` with the procedure and at least',
    'one quote copied verbatim from this conversation as evidence. If it does not, ignore this',
    'message — nothing will be written on your behalf either way.'
  ]
  for (const procedure of input.procedures) {
    lines.push('')
    lines.push(`  ${input.renderSteps(procedure.steps)}`)
    lines.push(`  ${procedure.occurrences}× · ${procedure.coverage} tool calls`)
    if (procedure.observerRatio >= input.observerRatioWarn) {
      lines.push('  Mostly reading. A workflow that only gathers information usually is not a skill;')
      lines.push('  skip it unless the ORDER of the reads is the whole point.')
    }
  }
  lines.push('')
  lines.push('Write down what failed, not just what worked: a named dead end is worth more to the')
  lines.push('next session than a description of the happy path. Generalise — this skill will be')
  lines.push('read by a session that does not share your memory of what happened here.')
  return lines.join('\n')
}
