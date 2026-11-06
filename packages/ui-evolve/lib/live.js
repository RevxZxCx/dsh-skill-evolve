/**
 * Who is listening for changes to a session's panel data.
 *
 * The panel used to poll `/panel` every eight seconds. That is both too slow to
 * feel live (the counts it shows change within a turn) and wasteful in the other
 * direction (a session that is thinking hard produces no new facts for minutes
 * at a time, and the poll keeps asking). A server-sent event stream turns both
 * halves around: the host says "something changed for this session" when it
 * changes, and the client fetches then.
 *
 * This module is the fan-out, and nothing more. It deliberately does not carry
 * the payload: what changed is a question for `/panel`, which already knows how
 * to assemble an answer for one session. Sending the payload down the stream
 * would mean two assembly paths that can disagree, and the panel's cards are
 * built from exactly one of them.
 *
 * One hub instance holds one set of listeners per session id. Publishing is
 * synchronous and never throws to the caller: it runs inside the host's own
 * `session/event` dispatch, where an exception would be logged against the host
 * rather than against this plugin.
 */

/**
 * @typedef {{ (): void }} Sink - called once per published change.
 */

export class LiveHub {
  /**
   * @param {object} [options] - wiring.
   * @param {(message: string) => void} [options.log] - diagnostics.
   */
  constructor(options = {}) {
    /** @type {Map<string, Set<Sink>>} listeners, by session id. */
    this.byAgent = new Map()
    this.log = typeof options.log === 'function' ? options.log : () => {}
    /** How many publishes have been delivered, for tests and diagnostics. */
    this.published = 0
  }

  /**
   * Listen for changes to one session.
   *
   * @param {string} agentId - the session id.
   * @param {Sink} sink - called on every publish for this id.
   * @returns {() => void} removes the listener. Safe to call twice.
   */
  subscribe(agentId, sink) {
    if (typeof agentId !== 'string' || agentId.length === 0) return () => {}
    if (typeof sink !== 'function') return () => {}
    const existing = this.byAgent.get(agentId)
    const set = existing === undefined ? new Set() : existing
    set.add(sink)
    this.byAgent.set(agentId, set)
    let live = true
    return () => {
      // Idempotent because a stream can be torn down from two directions: the
      // client closing it and the server noticing the socket is gone. Both run
      // the same cleanup, and the second one must not delete a listener that a
      // different stream registered for the same session.
      if (live === false) return
      live = false
      const current = this.byAgent.get(agentId)
      if (current === undefined) return
      current.delete(sink)
      if (current.size === 0) this.byAgent.delete(agentId)
    }
  }

  /**
   * Tell everyone watching one session that its facts moved.
   *
   * A listener that throws is dropped rather than allowed to break the host's
   * event dispatch: a half-closed socket would otherwise take the panel's other
   * listeners down with it, and the throw would be attributed to whatever the
   * host was doing at the time.
   *
   * @param {string} agentId - the session id.
   * @returns {number} how many listeners were told.
   */
  publish(agentId) {
    const set = this.byAgent.get(agentId)
    if (set === undefined) return 0
    let told = 0
    for (const sink of [...set]) {
      try {
        sink()
        told += 1
      } catch (error) {
        this.log(`live: a listener for ${agentId} failed — ${error?.message ?? error}`)
        set.delete(sink)
      }
    }
    if (set.size === 0) this.byAgent.delete(agentId)
    this.published += told > 0 ? 1 : 0
    return told
  }

  /**
   * How many listeners one session has. Used by the stream handler to decide
   * whether a session has any watchers at all.
   *
   * @param {string} agentId - the session id.
   * @returns {number} the listener count.
   */
  watching(agentId) {
    return this.byAgent.get(agentId)?.size ?? 0
  }
}
