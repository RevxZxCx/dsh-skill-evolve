/**
 * What happened after a skill was loaded.
 *
 * The plugin already counts loads (`registry.json` → `uses`), but a load is a
 * request, not a result. Eight loads spread across eight sessions is not
 * evidence that a skill helps; it is evidence that it was retrieved. The
 * `helpful`/`harmful` counters are no better as an effect signal: they come
 * from `skill_feedback`, which the model calls on itself, and a model that has
 * just spent a turn following a skill is the least reliable judge of whether
 * that skill was worth following. At the time this module was added the ledger
 * held eight `skill_used` entries and zero feedback entries — the effect side
 * of the ledger was not "bad", it was empty.
 *
 * This module records the mechanical half of the answer, and only the
 * mechanical half. Every judgement here is something the host already decided
 * before the plugin saw the event:
 *
 *   - a tool call happened, and which tool;
 *   - its result was an error (the host sets `isError`/`error`, the plugin does
 *     not read the text and does not ask a model what it meant);
 *   - the same tool was then called again, which is a retry;
 *   - the turn ended, and whether the host abandoned it.
 *
 * What it deliberately does NOT do is decide whether the task "succeeded".
 * Inferring success from a transcript means reading prose, and reading prose
 * with a model is the same self-assessment problem one level up. A window
 * therefore reports counts and a small closed set of shapes; the interpretation
 * is left to whoever reads the ledger, who has the task and the result in front
 * of them.
 *
 * The window closes on a turn boundary rather than a wall-clock timer, because
 * a turn is the unit in which the host does work. `outcomeTurns` completed
 * turns is long enough to see the next attempt and short enough that the window
 * cannot drift across unrelated work.
 */

/** Default number of completed turns a window stays open. */
const OUTCOME_TURNS = 2

/**
 * Upper bound on failed tool names kept per window.
 *
 * The names go into a ledger line, and one pathological window could fail
 * hundreds of distinct tools. Four is enough to see a pattern and small enough
 * that the line stays readable.
 */
const MAX_FAILED_TOOLS = 4

/**
 * Upper bound on `callId → tool` entries tracked per window.
 *
 * A window that opens on a busy agent can see thousands of calls before it
 * closes. The map only exists to attribute a failure back to a tool name, so
 * dropping the oldest entries loses precision on ancient calls but never
 * corrupts the counts.
 */
const MAX_TRACKED_CALLS = 200

/**
 * The shapes a window can report.
 *
 * These are not grades. `errors` does not mean the skill was bad — plenty of
 * good skills involve a failing command that the next step recovers from — it
 * means the window contained a failed tool call and no earlier load made that
 * normal. The reader decides.
 */
const OUTCOMES = Object.freeze([
  /** The window closed without the agent doing anything. */
  'unobserved',
  /** Work happened; no tool reported an error. */
  'no-error',
  /** A tool failed and was called again: the model retried rather than adapted. */
  'retried',
  /** Failures happened and were not retried. */
  'errors'
])

/**
 * One open window.
 *
 * Mutable by design and scoped to a single agent, exactly like `Transcript`:
 * these objects live only while their turn window is open and are replaced,
 * never shared.
 */
class Window {
  /**
   * @param {object} input - window identity.
   * @param {string} input.skill - the skill that was loaded.
   * @param {string} input.agentId - the agent that loaded it.
   * @param {string} input.at - ISO timestamp of the load.
   * @param {number} [input.turns] - completed turns to observe.
   */
  constructor(input) {
    this.skill = input.skill
    this.agentId = input.agentId
    this.at = input.at
    /** Completed turns still to observe before the window closes. */
    this.remaining = Number.isFinite(input.turns) && input.turns > 0 ? Math.floor(input.turns) : OUTCOME_TURNS
    /** Turns actually observed, which may be fewer than `turns` if displaced. */
    this.observed = 0
    this.calls = 0
    this.failures = 0
    this.retries = 0
    this.abandoned = 0
    /** @type {string[]} tool names that reported an error, deduplicated. */
    this.failedTools = []
    /** @type {Map<string, string>} callId → tool name, for attributing failures. */
    this.pending = new Map()
    /** @type {Set<string>} tools that have already failed at least once. */
    this.known = new Set()
  }

  /**
   * Note a dispatched tool call.
   *
   * A call to a tool that already failed is a retry: the model went back to
   * something it knew did not work. That is a narrower and more useful fact
   * than "an error occurred", because the first failure is often part of the
   * job and the retry is what suggests the skill did not help.
   *
   * @param {string} name - the tool name.
   * @param {string} [callId] - correlation id from the host.
   */
  noteCall(name, callId) {
    this.calls += 1
    if (typeof callId === 'string' && callId.length > 0) {
      // Bounded: drop the oldest insertion rather than refuse to track. A Map
      // preserves insertion order, so the first key is the oldest.
      if (this.pending.size >= MAX_TRACKED_CALLS) {
        const oldest = this.pending.keys().next()
        if (!oldest.done) this.pending.delete(oldest.value)
      }
      this.pending.set(callId, name)
    }
    if (this.known.has(name)) this.retries += 1
  }

  /**
   * Note the result of a tool call.
   *
   * The failure test is the host's own: `isError === true` or an `error` field.
   * The plugin does not parse result text, because "the command printed the
   * word error" and "the command failed" are different facts and only the
   * host's flag distinguishes them.
   *
   * @param {object} input - result facts.
   * @param {string} [input.callId] - correlation id.
   * @param {boolean} [input.isError] - the host's failure flag.
   * @param {unknown} [input.error] - the host's error payload, if any.
   */
  noteResult(input) {
    const failed = input.isError === true || input.error !== undefined
    const name = typeof input.callId === 'string' ? this.pending.get(input.callId) : undefined
    if (typeof input.callId === 'string') this.pending.delete(input.callId)
    // A failure whose call was never seen cannot be attributed to a tool. It is
    // still a failure, so it counts, but it cannot mark a tool as known-bad.
    if (!failed) return
    this.failures += 1
    if (name === undefined) return
    this.known.add(name)
    if (this.failedTools.length < MAX_FAILED_TOOLS && !this.failedTools.includes(name)) {
      this.failedTools.push(name)
    }
  }

  /**
   * Note a completed turn.
   *
   * @param {any} reason - the host's `turn/end` reason payload.
   * @returns {boolean} whether the window has closed.
   */
  noteTurnEnd(reason) {
    // An abandoned turn still consumed the observation budget. The model got a
    // turn and did not reach a conclusion; pretending the turn did not happen
    // would let a window that keeps hitting max-tokens stay open forever.
    if (reason?.kind !== undefined && reason.kind !== 'completed') this.abandoned += 1
    this.observed += 1
    this.remaining -= 1
    return this.remaining <= 0
  }

  /**
   * Close the window and produce the ledger line.
   *
   * @param {string} closedAt - ISO timestamp of the close.
   * @returns {object} the record to append.
   */
  finish(closedAt) {
    return {
      skill: this.skill,
      sessionId: this.agentId,
      openedAt: this.at,
      closedAt,
      turnsObserved: this.observed,
      calls: this.calls,
      failures: this.failures,
      retries: this.retries,
      abandonedTurns: this.abandoned,
      failedTools: this.failedTools,
      outcome: this.outcome()
    }
  }

  /**
   * Reduce the counts to one of the four shapes.
   *
   * Order matters: a retry is reported before a bare error because the retry is
   * the more specific finding, and an empty window is reported before anything
   * else because "we saw nothing" must never be recorded as "no error".
   *
   * @returns {string} one of `OUTCOMES`.
   */
  outcome() {
    // "Nothing observed" must mean nothing at all. A failure whose call was
    // never seen leaves `calls` at zero, and treating that as unobserved would
    // record a window that saw an error as a window that saw nothing.
    if (this.calls === 0 && this.failures === 0) return 'unobserved'
    if (this.failures === 0) return 'no-error'
    if (this.retries > 0) return 'retried'
    return 'errors'
  }
}

/**
 * All open windows, keyed by agent.
 *
 * One window per agent: loading a second skill closes the first, because the
 * second load means the model has already decided the first one was not what it
 * needed and attributing the following work to both would be a guess.
 */
class OutcomeStore {
  constructor() {
    /** @type {Map<string, Window>} */
    this.open = new Map()
  }

  /**
   * Open a window, closing any window already open for this agent.
   *
   * The displaced window is returned rather than dropped so the caller can
   * write it: an agent that switches skills mid-turn must not lose the record
   * of the skill it abandoned.
   *
   * @param {object} input - load facts.
   * @returns {object|undefined} the displaced window's record, if any.
   */
  begin(input) {
    const displaced = this.close(input.agentId, input.at)
    this.open.set(input.agentId, new Window(input))
    return displaced
  }

  /**
   * Close one agent's window.
   *
   * @param {string} agentId - the agent.
   * @param {string} [closedAt] - ISO timestamp; defaults to now.
   * @returns {object|undefined} the record, if a window was open.
   */
  close(agentId, closedAt) {
    const window = this.open.get(agentId)
    if (window === undefined) return undefined
    this.open.delete(agentId)
    return window.finish(closedAt ?? new Date().toISOString())
  }

  /**
   * Feed an event and collect any window that closed as a result.
   *
   * Returns an array because one event can only close one window, but the shape
   * keeps the caller's loop uniform with the other stores.
   *
   * @param {string} agentId - the agent that produced the event.
   * @param {any} event - the `session/event` payload.
   * @returns {object[]} records for windows that just closed.
   */
  record(agentId, event) {
    const window = this.open.get(agentId)
    if (window === undefined) return []
    const type = event?.type
    const data = event?.data
    if (type === 'tool/call') {
      window.noteCall(data?.name, data?.callId)
      return []
    }
    if (type === 'tool/result') {
      // The host nests the result inside `data.message`, not at the top of
      // `data`. Verified against 27,845 real `tool/result` events: the top of
      // `data` never carries `callId` or `isError`, while
      // `data.message.toolCallId` carries the id on every one of them and
      // `data.message.isError` is `true` on the failures. Reading the flat
      // shape silently made every retry invisible and turned real failures into
      // `no-error`, which is the one outcome this module must never invent.
      //
      // `data.error` stays checked as well: on some failures the host puts an
      // error payload beside the message instead of setting `isError`.
      const message = data?.message
      window.noteResult({
        callId: message?.toolCallId ?? message?.source?.callId ?? data?.callId ?? data?.id,
        isError: message?.isError ?? data?.isError,
        error: data?.error
      })
      return []
    }
    if (type === 'turn/end') {
      if (!window.noteTurnEnd(data?.reason)) return []
      this.open.delete(agentId)
      return [window.finish(new Date().toISOString())]
    }
    return []
  }

  /**
   * Drop one agent's open window without recording it.
   *
   * Used when an agent is disposed: a window that closes because the session
   * ended is not evidence about the skill, and writing it would put rows in the
   * ledger that describe an interrupted observation rather than a result.
   *
   * @param {string} agentId - the agent.
   */
  forget(agentId) {
    this.open.delete(agentId)
  }

  /** @returns {number} how many windows are open. */
  get size() {
    return this.open.size
  }
}

export { Window, OutcomeStore, OUTCOMES, OUTCOME_TURNS, MAX_FAILED_TOOLS, MAX_TRACKED_CALLS }
