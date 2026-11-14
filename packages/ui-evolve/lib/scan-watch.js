import { scanChanges } from './scan-changes.js'

/**
 * The modification-time bracket, held per session.
 *
 * Shaped like `GitWatch` on purpose: both answer "what changed during this
 * turn", both open on `turn/start` and close on `turn/end`, and both return the
 * same `{ paths, coverage }` shape so the merge in S8 does not have to know
 * which one it is holding. The difference is what they remember: git keeps a
 * reading, this keeps a timestamp, because a modification time can only be
 * compared against the moment the turn began.
 *
 * The timestamp is taken when `turn/start` arrives, not when the first tool
 * call does. A turn that spends its first second thinking still owns those
 * seconds; starting the clock later would excuse anything a tool wrote before
 * the model asked for it, and the model is not required to ask.
 */

/**
 * `none` means the bracket never looked: no baseline, no workspace, or a reader
 * that was never wired. It is not `complete` — see `emptyReading`.
 *
 * @typedef {{ paths: string[], coverage: 'complete' | 'partial' | 'none' }} Reading
 */

/**
 * Reads the workspace for files touched since `since`.
 *
 * The production reader. Exported for the same reason `readChanges` is: the
 * wiring is the only place that can be wrong in a way the units cannot see, and
 * a substitution point that only exists in tests proves nothing.
 *
 * The third argument is the budgets, passed through rather than fixed here. It
 * exists so a test can drive a walk into its ceiling without building a tree
 * large enough to reach the production limit — the translation from `truncated`
 * to `partial` below is a claim about a real walk, and asserting it against a
 * stub would assert nothing.
 *
 * @param {string} cwd - the workspace.
 * @param {number} since - milliseconds.
 * @param {{ maxEntries?: number, maxDepth?: number, maxMs?: number }} [budgets] -
 *   replaces the module's own limits.
 * @returns {Promise<Reading>}
 */
export async function scanReading(cwd, since, budgets) {
  const found = await scanChanges({ cwd, since, ...budgets })
  return {
    paths: found.paths,
    // A truncated walk saw part of the workspace, so the honest word is
    // `partial` — the same word the git sweep uses, for the same reason.
    coverage: found.truncated === true ? 'partial' : 'complete',
  }
}

/**
 * What a bracket reports when it never looked at the workspace.
 *
 * `coverage: 'none'` is a third state, not a synonym for `complete`. "I looked
 * and there was nothing" and "I never got the chance to look" are different
 * claims about the same empty list, and only the first one licenses the card to
 * say the turn produced nothing else. Collapsing the second into `complete`
 * would make every host restart silently vouch for a turn nobody swept — the
 * exact thing the coverage field exists to prevent.
 *
 * A fresh object per call, not a shared constant: this value is handed to the
 * wiring and then into `rememberPaths`, and a consumer that sorted or spliced
 * `reading.paths` would corrupt every later empty answer in every session.
 *
 * @returns {Reading}
 */
const emptyReading = () => ({ paths: [], coverage: 'none' })

export class ScanWatch {
  /**
   * @param {object} [options] - the reader.
   * @param {(cwd: string, since: number) => Promise<Reading | string[]>} [options.read] -
   *   substitutes `scanReading`. Tests use it; production does not.
   */
  constructor({ read } = {}) {
    /**
     * The turn's opening time, per session.
     *
     * A plain number rather than a promise: unlike `git status`, nothing runs at
     * `turn/start`, so there is nothing to await. Storing a promise here would
     * be imitating the shape of the other bracket without its reason.
     *
     * @type {Map<string, number>}
     */
    this.baselines = new Map()
    this.read = read
  }

  /**
   * Opens the bracket for a turn.
   *
   * @param {string} agentId - the session.
   * @param {number} [openedAt] - the wall clock; defaults to now.
   */
  start(agentId, openedAt) {
    if (typeof agentId !== 'string' || agentId.length === 0) return
    const stamp = typeof openedAt === 'number' && Number.isFinite(openedAt) ? openedAt : Date.now()
    this.baselines.set(agentId, stamp)
  }

  /**
   * Closes the bracket and reports what it saw.
   *
   * No baseline is not an error: a host that restarted mid-turn has no opening
   * time, and inventing one (say, "the last hour") would report work from turns
   * nobody asked about. Saying nothing is the smaller mistake — the other two
   * sources still answer for that turn.
   *
   * @param {string} agentId - the session.
   * @param {string} cwd - the workspace.
   * @returns {Promise<Reading>}
   */
  async finish(agentId, cwd) {
    if (typeof agentId !== 'string' || agentId.length === 0) return emptyReading()
    // Read and drop the baseline before anything can decline to use it. A
    // baseline whose turn is over must not survive: if the next `turn/end`
    // arrives without a `turn/start` (a host that restarted mid-turn), the
    // leftover would measure that turn from *this* turn's opening second and
    // credit work nobody asked about to the turn that just finished. Dropping it
    // on the way out costs one map entry and removes that whole class of mistake.
    const since = this.baselines.get(agentId)
    this.baselines.delete(agentId)
    if (typeof cwd !== 'string' || cwd.length === 0) return emptyReading()
    if (since === undefined) return emptyReading()
    const reader = this.read
    if (typeof reader !== 'function') return emptyReading()
    let answer
    try {
      answer = await reader(cwd, since)
    } catch {
      // A walk that threw did not see the workspace, so the honest word is
      // `partial`, not `complete`. `complete` means "I looked and this is all of
      // it"; a crashed scan (a file handle limit, a disconnected share, a race in
      // the walker) is exactly the case that must not be reported as a clean
      // empty turn. The caveat is the whole point of the coverage field.
      return { paths: [], coverage: 'partial' }
    }
    if (Array.isArray(answer) === true) return { paths: answer.slice(), coverage: 'complete' }
    return {
      paths: Array.isArray(answer?.paths) ? answer.paths.slice() : [],
      // Three words survive, not two. Folding `none` into `complete` here would
      // let an injected reader that never looked be reported as a finished walk.
      coverage: answer?.coverage === 'partial' || answer?.coverage === 'none' ? answer.coverage : 'complete',
    }
  }

  /**
   * Drops a session's baseline.
   *
   * @param {string} agentId - the session.
   */
  forget(agentId) {
    this.baselines.delete(agentId)
  }
}
