/**
 * Skill lifecycle: promotion, decay, inversion, and retirement.
 *
 * The premise of this module is that **growth is not the problem, rot is**. A
 * catalog that only grows becomes a set of unverified lenses: every
 * `description` rides in the system prompt and colours how the model reads
 * every later task, and nothing ever checks whether a given lens still helps.
 * So a skill carries its own evidence of usefulness, and the numbers decide
 * what happens to it:
 *
 * ```
 * unverified ──(uses ≥ promoteAfterUses)──► active
 *                                              │
 *              ┌──(harmful ≥ invert)──► inverted (kept as a warning)
 *              └──(no validation for staleAfterDays)──► stale
 * ```
 *
 * A harmful rule is **not deleted**. It becomes an anti-pattern — a warning
 * that names the failure it caused. Deleting it would make a future agent
 * re-discover the same mistake; inverting it teaches the next session what to
 * avoid, which is worth more than the original rule was.
 *
 * Decay uses a 90-day half-life on the *validation* timestamp, and a harmful
 * report weighs four times a helpful one. Both numbers come from `cass-memory`,
 * which arrived at them empirically.
 *
 * @module dsh-skill-evolve/lifecycle
 */

/** Days after which an unvalidated skill is reported stale. */
export const HALF_LIFE_DAYS = 90

/** Weight of one harmful report relative to one helpful report. */
export const HARMFUL_WEIGHT = 4

/** The lifecycle stages a skill can occupy. */
export const STAGES = /** @type {const} */ (['unverified', 'active', 'stale', 'inverted'])

/**
 * Compute the confidence score for one skill.
 *
 * The score is `net evidence × recency`, where recency halves every
 * {@link HALF_LIFE_DAYS} since the last validation. A skill nobody has
 * confirmed in half a year is worth half as much as one confirmed today,
 * which is exactly the intent: absence of re-confirmation is weak evidence
 * of continuing usefulness.
 *
 * @param {object} state - the lifecycle state.
 * @param {number} [state.helpful] - helpful reports.
 * @param {number} [state.harmful] - harmful reports.
 * @param {string} [state.validated] - ISO timestamp of the last validation.
 * @param {Date} [now] - reference time.
 * @returns {number} a non-negative confidence score.
 */
export function confidence(state, now = new Date()) {
  const helpful = Math.max(0, Number(state.helpful ?? 0))
  const harmful = Math.max(0, Number(state.harmful ?? 0))
  const net = helpful - harmful * HARMFUL_WEIGHT
  if (net <= 0) return 0
  const ageDays = ageInDays(state.validated, now)
  const decay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
  return net * decay
}

/**
 * Compute how many whole days have passed since an ISO timestamp.
 *
 * @param {string | undefined} timestamp - ISO timestamp.
 * @param {Date} now - reference time.
 * @returns {number} whole days; `Infinity` when the timestamp is unusable.
 */
export function ageInDays(timestamp, now = new Date()) {
  if (typeof timestamp !== 'string' || timestamp.length === 0) return Number.POSITIVE_INFINITY
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY
  const delta = now.getTime() - parsed
  if (delta <= 0) return 0
  return delta / 86_400_000
}

/**
 * Decide the next stage for one skill.
 *
 * Pure: it reads the state and the configuration and returns a decision, so
 * every branch is testable without touching the filesystem.
 *
 * @param {object} input - decision input.
 * @param {object} input.state - current lifecycle state.
 * @param {number} input.promoteAfterUses - uses needed to leave `unverified`.
 * @param {number} input.invertAfterHarmful - harmful reports that trigger inversion.
 * @param {number} input.staleAfterDays - validation age that triggers `stale`.
 * @param {Date} [input.now] - reference time.
 * @returns {{stage: string, changed: boolean, reason: string}} the decision.
 */
export function decideStage(input) {
  const state = input.state
  const now = input.now ?? new Date()
  const uses = Number(state.uses ?? 0)
  const harmful = Number(state.harmful ?? 0)
  const current = String(state.stage ?? 'unverified')

  if (current === 'inverted') {
    return { stage: 'inverted', changed: false, reason: 'inverted skills stay inverted until rewritten' }
  }
  if (harmful >= input.invertAfterHarmful) {
    return {
      stage: 'inverted',
      changed: current !== 'inverted',
      reason: `${harmful} harmful reports reached the inversion threshold of ${input.invertAfterHarmful}`
    }
  }
  if (uses >= input.promoteAfterUses && (current === 'unverified' || current === 'stale')) {
    return {
      stage: 'active',
      changed: true,
      reason: `${uses} successful uses reached the promotion threshold of ${input.promoteAfterUses}`
    }
  }
  if (current === 'active') {
    const age = ageInDays(state.validated, now)
    if (age >= input.staleAfterDays) {
      return {
        stage: 'stale',
        changed: true,
        reason: `no validation for ${Math.floor(age)} days, past the ${input.staleAfterDays}-day threshold`
      }
    }
  }
  return { stage: current, changed: false, reason: 'no transition applies' }
}

/**
 * Build the frontmatter state block for a skill file.
 *
 * @param {object} state - the lifecycle state.
 * @param {object} [overrides] - fields to force.
 * @returns {Record<string, string|number>} frontmatter fields.
 */
export function stateToFrontmatter(state, overrides = {}) {
  const merged = { ...state, ...overrides }
  return {
    'evolved-id': String(merged.id ?? ''),
    'evolved-stage': String(merged.stage ?? 'unverified'),
    'evolved-created': String(merged.created ?? ''),
    'evolved-uses': Number(merged.uses ?? 0),
    'evolved-helpful': Number(merged.helpful ?? 0),
    'evolved-harmful': Number(merged.harmful ?? 0),
    'evolved-validated': String(merged.validated ?? ''),
    'evolved-evidence': String(merged.evidence ?? '')
  }
}

/**
 * Rewrite a skill body as an anti-pattern warning.
 *
 * The original instructions are preserved under a collapsed section rather
 * than deleted: the warning is only trustworthy if a reader can see what it
 * is warning about.
 *
 * @param {object} input - rewrite input.
 * @param {string} input.name - skill name.
 * @param {string} input.originalBody - the instructions as originally written.
 * @param {number} input.harmful - how many harmful reports triggered this.
 * @returns {string} the replacement body.
 */
export function invertBody(input) {
  return [
    `> **PITFALL — do not follow this skill as written.**`,
    `>`,
    `> It was reported harmful ${input.harmful} time${input.harmful === 1 ? '' : 's'}. The instructions below`,
    `> led to a worse outcome than the obvious alternative. Read them as a list of`,
    `> things to avoid, not as a procedure to follow. If you can identify the defect,`,
    `> rewrite this skill rather than deleting it: a named failure is worth more than`,
    `> an empty slot.`,
    ``,
    `# ${input.name} — retired instructions`,
    ``,
    input.originalBody.trim()
  ].join('\n')
}

/**
 * Render a one-line summary of a skill's health for human-facing output.
 *
 * @param {object} state - the lifecycle state.
 * @param {Date} [now] - reference time.
 * @returns {string} e.g. `active · 7 uses · confidence 1.4`.
 */
export function summarize(state, now = new Date()) {
  const score = confidence(state, now)
  return [
    String(state.stage ?? 'unverified'),
    `${Number(state.uses ?? 0)} uses`,
    Number(state.harmful ?? 0) > 0 ? `${Number(state.harmful)} harmful` : undefined,
    `confidence ${score.toFixed(1)}`
  ].filter((part) => part !== undefined).join(' · ')
}
