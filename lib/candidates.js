/**
 * Candidate-queue rules: staleness, and telling a fresh proposal apart from a
 * revision of something already in the catalog.
 *
 * A queue that only ever grows is the same failure as a catalog that only ever
 * grows, one step earlier. A candidate captures a moment: the session it came
 * from, the catalog as it stood, the body the model had in mind. By the time a
 * person reads the queue, any of those can be gone, and approving against a
 * stale snapshot writes a skill nobody checked against the current state.
 *
 * Qoder names exactly these three ways a suggestion goes bad — "If a suggestion
 * expires, its source is unavailable, or Skill files have changed, regenerate
 * or handle it against the latest state" — and this module implements them as
 * checks that run every time the queue is read, not as a background sweeper.
 * Recomputing is idempotent and self-correcting; a sweeper needs a scheduler,
 * a clock, and a reason to run, and gets all three wrong eventually.
 *
 * Nothing here deletes. A stale candidate keeps its evidence and its body so a
 * person can still read what was proposed and why it lapsed; it simply cannot
 * be approved without being regenerated.
 *
 * @module dsh-skill-evolve/candidates
 */

/** The ways a candidate stops being approvable, in the order they are checked. */
export const STALE_REASONS = ['expired', 'source-missing', 'name-taken', 'base-changed']

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A short stable digest of a text body.
 *
 * Used to tell "the skill file still says what this revision was written
 * against" from "somebody edited it since". FNV-1a is enough: this compares a
 * handful of local strings, it is not a security boundary.
 *
 * @param {string} text - the text to digest.
 * @returns {string} eight hex characters.
 */
export function digest(text) {
  let hash = 0x811c9dc5
  const input = String(text ?? '')
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * How old a candidate is, in whole days.
 *
 * @param {string} createdAt - ISO timestamp.
 * @param {Date} now - the current time.
 * @returns {number} age in days, or 0 when the timestamp is unreadable.
 */
export function ageInDays(createdAt, now) {
  const then = Date.parse(String(createdAt ?? ''))
  if (!Number.isFinite(then)) return 0
  return Math.max(0, (now.getTime() - then) / DAY_MS)
}

/**
 * Decide whether one candidate can still be approved, and why not.
 *
 * @param {object} candidate - the queued candidate.
 * @param {object} options - evaluation context.
 * @param {Date} options.now - the current time.
 * @param {number} options.ttlDays - days before a proposal expires.
 * @param {(name: string) => Promise<{exists: boolean, owned?: boolean, body?: string}>} options.lookup - catalog probe.
 * @param {(sessionId: string) => Promise<boolean>} [options.sessionExists] - source probe; omitted means "cannot check".
 * @returns {Promise<{reason: string, detail: string, at: string} | undefined>} the verdict.
 */
export async function evaluateStaleness(candidate, options) {
  const now = options.now
  const at = now.toISOString()

  // The cheap checks come first: age needs nothing but the clock, and it is the
  // reason most queues go bad.
  const age = ageInDays(candidate.createdAt, now)
  if (age > options.ttlDays) {
    return {
      reason: 'expired',
      detail: `proposed ${Math.floor(age)} day(s) ago; the limit is ${options.ttlDays}`,
      at
    }
  }

  if (options.sessionExists !== undefined && typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0) {
    let live = true
    try {
      live = await options.sessionExists(candidate.sessionId)
    } catch {
      // A probe that cannot answer must not condemn a candidate: the session
      // may well exist and simply not be listed right now.
      live = true
    }
    if (!live) {
      return { reason: 'source-missing', detail: `session ${candidate.sessionId} is no longer available`, at }
    }
  }

  const found = await options.lookup(candidate.name)

  // A revision expects its base to be there. The base changing underneath is
  // precisely what makes a staged rewrite unsafe to apply.
  if (candidate.kind === 'update') {
    if (!found.exists) {
      return { reason: 'base-changed', detail: `"${candidate.name}" no longer exists, so this revision has nothing to update`, at }
    }
    if (found.owned === false) {
      return { reason: 'base-changed', detail: `"${candidate.name}" is no longer owned by this plugin`, at }
    }
    const recorded = candidate.base?.digest
    if (typeof recorded === 'string' && typeof found.body === 'string' && digest(found.body) !== recorded) {
      return { reason: 'base-changed', detail: `"${candidate.name}" was edited after this revision was staged`, at }
    }
    return undefined
  }

  // A fresh proposal is dead the moment something else claims the name: the
  // whole point of staging was to avoid shadowing a skill that turns out to
  // belong to somebody else.
  if (found.exists) {
    return { reason: 'name-taken', detail: `a skill named "${candidate.name}" exists now`, at }
  }

  return undefined
}

/**
 * Re-evaluate a whole queue and persist the verdicts.
 *
 * The previous verdict is passed through when it still holds so the recorded
 * timestamp means "when this first went stale", not "when we last looked".
 *
 * @param {object} input - batch input.
 * @param {Array<object>} input.candidates - the queue.
 * @param {object} input.options - the same options `evaluateStaleness` takes.
 * @returns {Promise<{candidates: Array<object>, changed: boolean}>} the annotated queue.
 */
export async function annotateQueue(input) {
  let changed = false
  const candidates = []
  for (const candidate of input.candidates) {
    const verdict = await evaluateStaleness(candidate, input.options)
    const previous = candidate.stale
    const same = verdict === undefined
      ? previous === undefined
      : previous !== undefined && previous.reason === verdict.reason
    if (!same) changed = true
    candidates.push({
      ...candidate,
      stale: same ? previous : verdict
    })
  }
  return { candidates, changed }
}

/**
 * Find one candidate by name, preferring a live one over a stale one.
 *
 * Two candidates can share a name when an earlier one went stale and the model
 * proposed again. Picking the stale one would refuse an approval the queue is
 * visibly offering.
 *
 * @param {Array<object>} candidates - the queue.
 * @param {string} name - the skill name.
 * @returns {object | undefined} the best match.
 */
export function findByName(candidates, name) {
  const matches = candidates.filter((entry) => entry.name === name)
  if (matches.length === 0) return undefined
  return matches.find((entry) => entry.stale === undefined) ?? matches[0]
}

/**
 * Human-readable explanation of a stale verdict.
 *
 * @param {{reason: string, detail: string}} stale - the verdict.
 * @returns {string} one line.
 */
export function describeStale(stale) {
  const label = stale.reason === 'expired'
    ? 'expired'
    : stale.reason === 'source-missing'
      ? 'source missing'
      : stale.reason === 'name-taken'
        ? 'name taken'
        : 'base changed'
  return `${label} — ${stale.detail}`
}

/**
 * Whether a candidate can still be acted on.
 *
 * @param {object} candidate - the queued candidate.
 * @returns {boolean} true when it is approvable.
 */
export function isLive(candidate) {
  if (candidate === undefined || candidate === null) return false
  // A null verdict and an absent one mean the same thing: nobody has condemned
  // this candidate. Only a verdict object is a refusal.
  return candidate.stale === undefined || candidate.stale === null
}
