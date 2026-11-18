/**
 * Change counters behind the panel's push stream.
 *
 * `bump` is the write: something in this process noticed a change the payload is
 * built from. `subscribe` is how the stream hears about it, and `read` is what a
 * stream is told when it opens, so its first frame already says where things
 * stand. All three exist because the panel cannot see this process's events --
 * it can only open a connection.
 *
 * There is no waiter any more. This module used to also park a request until the
 * counter moved (`/watch`); the stream replaced it, because a parked request has
 * to be re-asked with a fresh `after` on every answer and a connection does not.
 *
 * What counts is not "an event happened" but "an event that can change the
 * payload happened". The difference is not academic: measured over a real
 * 655-hour session, the host emitted 0.394 events per second overall and 0.057
 * `tool/call` per second. Feeding every event to this counter would wake the
 * panel about every two and a half seconds — busier than the eight-second timer
 * it replaces, and for a payload that had not changed. So the callers bump on
 * the event types the payload is actually built from, and nothing else.
 *
 * The counter is per session and process-local. It is not persisted, and it is
 * not compared across a restart: a client that opens the stream is told the
 * current number in its first frame and then fetches whenever any frame arrives.
 * The number is carried in the frame for the log, not
 * because the reader compares it -- the client deliberately does not, so a
 * counter that restarts at zero costs nothing.
 */
export class Revisions {
  constructor(options) {
    /**
     * Session id -> counter.
     *
     * A `Map` rather than an object so a session id that happens to look like
     * `__proto__` cannot change the shape of the container. The same reasoning
     * applies everywhere this plugin keys by a host-supplied string.
     *
     * @type {Map<string, number>}
     */
    this.sessions = new Map()

    /**
     * Listeners told about every bump, with the session and its new number.
     *
     * This is what turns the counter into a push channel: a request that would
     * otherwise have to ask "has it moved" on a clock can instead be answered
     * the moment it moves. A `Set` because unsubscribing is the common case
     * (every closed stream) and order does not matter.
     *
     * @type {Set<(agentId: string, revision: number) => void>}
     */
    this.listeners = new Set()

    /**
     * Told about a listener that threw, so the failure is not silent.
     *
     * A constructor argument rather than a field the plugin assigns
     * afterwards: the plugin built one of these and never set the field, so
     * the call in `bump` was a documented no-op -- exactly the catch that
     * `bump` own comment promises is not silent. Passing it at construction
     * makes an unconnected sink a visible hole in the call site instead of a
     * missing assignment nobody looks for.
     *
     * Optional because a bare `new Revisions()` is a legitimate standalone
     * object (the test suite builds several). What is not legitimate is
     * claiming the plugin wires it when the plugin does not.
     *
     * @type {((error: unknown, agentId: string) => void) | undefined}
     */
    this.onError = options?.onError
  }

  /**
   * Hear about every bump.
   *
   * @param {(agentId: string, revision: number) => void} listener - called synchronously inside `bump`.
   * @returns {() => void} the unsubscribe.
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Record that something which can change this session's payload happened.
   *
   * Bumping an unknown session creates the entry. That is deliberate: the first
   * event of a session is usually the one that makes the panel exist at all, and
   * a counter that refuses to start counting until someone reads it would miss
   * exactly that event.
   *
   * @param {string} agentId - the session.
   * @returns {number} the new counter, mostly so a test can assert on it.
   */
  bump(agentId) {
    if (typeof agentId !== 'string' || agentId.length === 0) return 0
    const next = (this.sessions.get(agentId) ?? 0) + 1
    this.sessions.set(agentId, next)
    // A listener that throws must not stop the others, and must not travel back
    // into the emit site: those callers are mid-event and cannot do anything
    // about a broken stream.
    //
    // The catch is the one place in this module that could hide a real defect, so
    // it does not swallow silently: the failing listener goes to `onError`, which
    // the plugin passes in as its own log (see the constructor). A write to a
    // socket that died between the check and the write is genuinely nothing to
    // act on -- the stream removes itself on close -- but "nothing to act on" and
    // "nothing worth knowing" are different claims, and only the first is true.
    for (const listener of this.listeners) {
      try {
        listener(agentId, next)
      } catch (error) {
        // `onError` is the caller's code too. A loop whose whole promise is that
        // one bad callback cannot stop the others cannot hand the failover to a
        // second callback without containing it -- a bare call here means a
        // logging function that throws takes the remaining listeners with it and
        // lands in the host's event handler.
        try {
          this.onError?.(error, agentId)
        } catch {
          // Nothing left to report to, and this is not the emit site's problem.
        }
      }
    }
    return next
  }

  /**
   * Whether this session has a counter at all.
   *
   * `read` cannot answer this: it says 0 both for a session that was forgotten
   * and for one nothing has bumped yet. The difference matters to a callback that
   * lands late -- a summary arriving after its session was disposed would create
   * a counter with `bump`, and nothing would ever forget it again, which is the
   * one thing `forget` exists to prevent.
   *
   * @param {string} agentId - the session.
   * @returns {boolean} true while a bump is remembered for it.
   */
  has(agentId) {
    if (typeof agentId !== 'string' || agentId.length === 0) return false
    return this.sessions.has(agentId)
  }

  /**
   * The number a stream reports when it opens.
   *
   * A session nobody has bumped answers zero. That is a real position and not a
   * missing answer -- but it also means "this session was forgotten", because
   * `forget` drops the entry rather than marking it, and the next reader cannot
   * tell the two apart.
   *
   * That ambiguity is deliberate and harmless *here*, because the client does not
   * compare the number: it fetches the payload on every frame it receives. A
   * client that started comparing would have to be told which of the two zeros it
   * was looking at, which is why the frame carries the number as a fact about
   * this process rather than as a contract to be reasoned about.
   *
   * @param {string} agentId - the session.
   * @returns {number} the counter.
   */
  read(agentId) {
    if (typeof agentId !== 'string' || agentId.length === 0) return 0
    return this.sessions.get(agentId) ?? 0
  }

  /**
   * Drop one session's counter.
   *
   * Called when the host disposes the agent. Without it this map grows by one
   * entry per conversation the person has ever opened and never shrinks — small,
   * but unbounded, and the fix is a line.
   *
   * A disposed session that comes back is a new agent with the same id, whose
   * counter starts at zero again. The panel is told before this runs (the bump
   * above it in the plugin is what closes a column whose conversation ended), so
   * the reset is never observed by a reader that was already watching.
   *
   * @param {string} agentId - the session.
   */
  forget(agentId) {
    this.sessions.delete(agentId)
  }
}
