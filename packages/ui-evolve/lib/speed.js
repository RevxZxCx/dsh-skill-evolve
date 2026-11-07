/**
 * How fast the model is writing right now.
 *
 * The host reports output speed as one number for the whole session
 * (`decodeTokens / decodeMs`, summed over every step that reported usage), which
 * is the right number for "how did this conversation go" and the wrong number
 * for "is it moving right now": by the twentieth turn it is mostly describing
 * the first nineteen.
 *
 * Nothing in the event stream carries a live token count. A `usage` chunk
 * arrives once, after `message_stop`, which is exactly when the interesting part
 * is over. So the only way to say anything *during* generation is to count what
 * has arrived and convert it — and the host itself does that conversion the same
 * way, `Math.ceil(length / 4)`, wherever it needs a token estimate before the
 * provider answers.
 *
 * What follows from those two facts:
 *
 *   1. every `text-delta` records (timestamp, estimated tokens) in a short
 *      window, and the speed is the window's tokens over the window's seconds —
 *      a sliding average, not a session average;
 *   2. when the real `usage` lands, the ratio between the provider's count and
 *      ours is kept, and applied to later estimates, so the number is not a
 *      permanent four-characters-per-token fiction;
 *   3. the window is bounded by time rather than by count, because a burst of
 *      small deltas and a trickle of large ones are the same speed and must not
 *      be weighed differently.
 *
 * @module @revxz/dsh-ui-evolve/speed
 */

/**
 * How much recent history the sliding window keeps.
 *
 * Two seconds is long enough that the number does not jump with every delta (a
 * delta arrives every few milliseconds) and short enough that it answers "now"
 * rather than "a moment ago".
 */
const WINDOW_MS = 2000

/**
 * The shortest span a reading may be divided by.
 *
 * The first delta of a message has zero elapsed time behind it, and dividing one
 * token by three milliseconds reports three hundred tokens a second. The window
 * cannot be trusted until it has something in it, so the divisor starts at half
 * a second and reaches `WINDOW_MS` as the marks accumulate. Without this the
 * number on screen is wildly high for the first fraction of every message —
 * which is the one moment a person is most likely to look.
 */
const MIN_SPAN_MS = 500

/**
 * Characters per token, as the host divides them.
 *
 * Not a real tokenizer: the host accepts approximate counts where a real count
 * would cost a round trip, and using the same divisor means the live estimate
 * and the provider's number disagree only where tokenization itself does.
 */
const CHARS_PER_TOKEN = 4

/**
 * How far the estimate may be scaled by a measured ratio.
 *
 * A provider that reports a tenth of what arrived is not describing the same
 * thing this meter counts (cached prompt tokens, a different tokenizer, a
 * message the host assembled differently). Correcting by an unbounded ratio
 * would let one odd turn redefine every later reading.
 */
const RATIO_FLOOR = 0.25
const RATIO_CEILING = 4

/**
 * Estimate the tokens in a piece of text.
 *
 * @param {string} text - the delta as it arrived.
 * @returns {number} estimated tokens, never negative.
 */
function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Track output speed for the sessions this process is serving.
 *
 * One instance lives for the whole plugin, like the transcript store: a session
 * id is a key, and a session nobody is watching costs one small entry. Nothing
 * here touches disk — a speed is a fact about the last two seconds, and the last
 * two seconds are not worth persisting.
 */
export class SpeedMeter {
  /**
   * @param {object} [options] - options.
   * @param {() => number} [options.now] - clock, injectable so a test can move
   *   time without sleeping.
   */
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    /** @type {Map<string, { marks: Array<{ at: number, tokens: number }>, message: number }>} */
    this.sessions = new Map()
    /** @type {Map<string, number>} */
    this.ratios = new Map()
  }

  /**
   * One entry per session, created on first use.
   *
   * @param {string} agentId - the session.
   * @returns {{ marks: Array<{ at: number, tokens: number }>, message: number } | undefined} the entry.
   */
  entryOf(agentId) {
    if (typeof agentId !== 'string' || agentId.length === 0) return undefined
    const existing = this.sessions.get(agentId)
    if (existing !== undefined) return existing
    const created = { marks: [], message: 0 }
    this.sessions.set(agentId, created)
    return created
  }

  /**
   * Record one streaming delta.
   *
   * Called for every `agent/assistant-stream` chunk frame whose chunk is a text
   * delta. Deliberately
   * *not* called for reasoning deltas: thinking streams at its own rate, and
   * mixing the two would report a speed the reader is not watching.
   *
   * @param {string} agentId - the session.
   * @param {string} text - the delta's text.
   * @returns {void}
   */
  push(agentId, text) {
    const entry = this.entryOf(agentId)
    if (entry === undefined) return
    const tokens = estimateTokens(text)
    if (tokens === 0) return
    const at = this.now()
    entry.marks.push({ at, tokens })
    entry.message += tokens
    this.prune(entry, at)
  }

  /**
   * Forget what the current attempt has streamed, keeping the window.
   *
   * `settle` is the only thing that clears this accumulator, and a settle only
   * arrives when a message is committed with a usage report. An attempt the user
   * abandons never produces one, and neither does a request that fails before the
   * provider answers — so without this the text of the abandoned attempt would
   * still be sitting in `message` when the retry's usage arrives, and the scale
   * learned from that division would be a quarter of the truth for the rest of
   * the session.
   *
   * The window is deliberately left alone: those deltas really did arrive, and a
   * reading over the last two seconds is about text appearing on screen, not about
   * which attempt produced it.
   *
   * @param {string} agentId - the session.
   * @returns {void}
   */
  begin(agentId) {
    const entry = this.sessions.get(agentId)
    if (entry === undefined) return
    entry.message = 0
  }

  /**
   * Fold the provider's real token count into this session's scale.
   *
   * The ratio, not the difference: the next message streams through the same
   * estimator, so a correction that only fixed the total would leave every later
   * reading wrong by the same factor. `message` also resets here, so a settle
   * that arrives without any deltas (a message the host assembled from nothing)
   * divides zero by zero and is ignored rather than recorded as a ratio of one.
   *
   * @param {string} agentId - the session.
   * @param {number} outputTokens - the provider's count for the message that just ended.
   * @returns {void}
   */
  settle(agentId, outputTokens) {
    // `get`, not `entryOf`: a message for a session that never streamed text has
    // nothing to divide, and creating an entry to discover that would leave a
    // session behind for every agent frame in the process — the same unbounded
    // map `begin` avoids, and `forget` only clears it when a session is disposed
    // rather than when it was never there.
    const entry = this.sessions.get(agentId)
    if (entry === undefined) return
    const measured = entry.message
    entry.message = 0
    // One judge, not four. A count the provider never sent, a negative count, and
    // a settle with no deltas behind it all produce a quotient that is not a
    // positive finite number, and that is the only thing a scale may be. The
    // separate guards that used to stand here were each shadowed by this line:
    // mutation testing reported every one of them as surviving, because removing
    // any of them could not change an answer. They are gone rather than kept as
    // decoration that reads like protection.
    const ratio = outputTokens / measured
    if (!Number.isFinite(ratio) || ratio <= 0) return
    this.ratios.set(agentId, Math.min(RATIO_CEILING, Math.max(RATIO_FLOOR, ratio)))
  }

  /**
   * Take one session's speed reading.
   *
   * @param {string} agentId - the session.
   * @returns {{ tokens: number, ms: number, tps: number, active: boolean }} the
   *   reading. `active` is false when the window is empty, which is the client's
   *   signal to stop asking — a finished turn decays to zero over one window
   *   rather than snapping to empty on the last delta.
   */
  read(agentId) {
    const entry = this.sessions.get(agentId)
    if (entry === undefined) return { tokens: 0, ms: 0, tps: 0, active: false }
    const at = this.now()
    this.prune(entry, at)
    if (entry.marks.length === 0) return { tokens: 0, ms: 0, tps: 0, active: false }

    let estimated = 0
    let oldest = at
    for (const mark of entry.marks) {
      estimated += mark.tokens
      if (mark.at < oldest) oldest = mark.at
    }
    const ms = Math.max(MIN_SPAN_MS, at - oldest)
    const scaled = estimated * (this.ratios.get(agentId) ?? 1)
    return {
      tokens: Math.round(scaled),
      ms: Math.round(ms),
      tps: scaled / (ms / 1000),
      active: true,
    }
  }

  /**
   * Drop the marks that have fallen out of the window.
   *
   * The marks arrive in order, so the scan stops at the first one still inside
   * the window rather than filtering the whole array on every delta.
   *
   * @param {{ marks: Array<{ at: number, tokens: number }>, message: number }} entry - one session's entry.
   * @param {number} at - the current time.
   * @returns {void}
   */
  prune(entry, at) {
    const cutoff = at - WINDOW_MS
    let drop = 0
    while (drop < entry.marks.length && entry.marks[drop].at < cutoff) drop += 1
    if (drop === 0) return
    entry.marks.splice(0, drop)
  }

  /**
   * Forget a session.
   *
   * @param {string} agentId - the session.
   * @returns {void}
   */
  forget(agentId) {
    this.sessions.delete(agentId)
    this.ratios.delete(agentId)
  }
}

export { WINDOW_MS, MIN_SPAN_MS, CHARS_PER_TOKEN, estimateTokens }
