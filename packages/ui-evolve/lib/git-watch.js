/**
 * Per-session git baselines, for the output card.
 *
 * ## The gap this closes
 *
 * The card learned a turn's files from two places: the tools that name a path
 * (`write`, `edit`) and the model's own declaration (`present`,
 * `report_output_files`). Both are statements about intent. A script that
 * writes four files at runtime makes none of them — measured on a real session,
 * eight files landed on disk and five reached the card, and the missing ones
 * were not a display bug: they had never been recorded.
 *
 * ## Why a baseline and not a watch
 *
 * `git status` already answers "what differs from the last commit". Watching the
 * filesystem was rejected in `docs/19`: an event stream on a large workspace
 * costs more than the panel is worth, and it reports writes the turn did not
 * make.
 *
 * A commit boundary is not a turn boundary, though. A dirty working tree has
 * changes that predate the session. So each turn is bracketed: the set is read
 * when the turn starts and again when it ends, and only what appeared between
 * the two readings belongs to the turn.
 *
 * ## Why the baseline is a promise, not an array
 *
 * `git status` on a large repo takes longer than the gap between `turn/start`
 * and the first tool call. Storing the *array* would mean either blocking that
 * gap or racing it, and a reading that lands late would be installed over an
 * interval that had already closed. Storing the pending promise makes lateness
 * harmless: `finish` awaits it, so the two readings are always ordered however
 * long the first one takes.
 *
 * ## Why baselines are not persisted
 *
 * A baseline is a fact about this process's view of the repo. After a restart
 * the next reading has no honest predecessor, so the turn contributes nothing
 * from git — its files still come from the tools and the model, exactly as
 * before. Persisting a stale baseline would attribute last week's uncommitted
 * work to the turn after the restart, which is worse than a missing file.
 *
 * @module git-watch
 */

import { mergeCoverage } from './coverage.js'
import { newestChanges, sweepChanges } from './git-changes.js'

/**
 * One reading of the workspace, with an account of how complete it is.
 *
 * @typedef {object} Reading
 * @property {string[]} paths - absolute paths git reports as changed.
 * @property {'complete' | 'partial' | 'none'} coverage - whether anything was
 *   skipped, and whether the workspace was read at all. `none` means no reading
 *   was taken; it must not be flattened into `complete`.
 */

/**
 * The production reader: ask git what is changed in this workspace.
 *
 * Exists as a named export rather than a lambda at the call site so the seam in
 * `apply` reads as "inject this, or use the real one" instead of hiding the one
 * place a process is spawned inside an options object.
 *
 * @param {string} cwd - the workspace root.
 * @returns {Promise<Reading>} paths and coverage, empty when git cannot answer.
 */
export function readChanges(cwd) {
  return sweepChanges({ cwd })
}

/**
 * Coerce whatever a reader returned into a `Reading`.
 *
 * Accepts a bare array as well as an object: a test that only cares about paths
 * should not have to assemble a coverage field, and an injected reader written
 * before this shape existed still works. A bare array is treated as `complete`
 * because a reader that reports nothing about its own limits is claiming to
 * have none.
 *
 * @param {unknown} value - what the reader answered.
 * @returns {Reading} a well-formed reading.
 */
function asReading(value) {
  if (Array.isArray(value) === true) return { paths: value, coverage: 'complete' }
  const paths = Array.isArray(value?.paths) === true ? value.paths : []
  // Three words survive the trip, not two. `none` used to be folded into
  // `complete` here, which quietly turned "no baseline was ever taken" into
  // "the workspace was read and held nothing else" -- the exact claim
  // `coverage` exists to prevent. An unrecognised word still reads as
  // `complete`: a reader that says nothing about its own limits is claiming to
  // have none.
  const coverage = value?.coverage === 'partial' || value?.coverage === 'none' ? value.coverage : 'complete'
  return { paths, coverage }
}

/**
 * Remembers, per session, the pending reading taken when the turn began.
 *
 * Holds no timer and no host handle: it is handed a function that answers "what
 * is changed right now", so the tests drive it without a repository.
 */
export class GitWatch {
  /**
   * @param {object} options
   * @param {Function} options.changes - `(cwd) => Promise<string[]>`. Injected so
   *   this module never owns the git call, and so a test can answer instantly.
   */
  constructor({ changes } = {}) {
    /** @type {Map<string, Promise<Reading>>} session id -> reading in flight. */
    this.baselines = new Map()
    this.changes = changes
  }

  /**
   * Take the reading this turn will be measured against.
   *
   * Called on `turn/start`, which the host emits before the first tool call, so
   * even the opening turn has an honest predecessor. Failures are swallowed: a
   * workspace that is not a repository is one we have nothing to say about, and
   * the card has two other sources.
   *
   * @param {string} agentId - the session.
   * @param {string} cwd - the workspace root.
   * @returns {void}
   */
  start(agentId, cwd) {
    if (typeof agentId !== 'string' || agentId.length === 0) return
    if (typeof cwd !== 'string' || cwd.length === 0) return
    if (typeof this.changes !== 'function') return
    // A rejected reading is caught here, not in `finish`: an unhandled rejection
    // would take the host down over a backstop the panel can live without.
    this.baselines.set(agentId, Promise.resolve().then(() => this.changes(cwd)).then(
      (value) => asReading(value),
      // A failed opening reading is not an empty one. `none` says the interval
      // has no first end, so `finish` can report that it never measured this
      // turn rather than measuring it against an imagined clean start.
      () => ({ paths: [], coverage: 'none' })
    ))
  }

  /**
   * Read the repo again and answer what this turn changed.
   *
   * The baseline is consumed whether or not this succeeds: the next turn
   * brackets its own interval, and a kept baseline would be one reading too old
   * to be true.
   *
   * @param {string} agentId - the session.
   * @param {string} cwd - the workspace root.
   * @returns {Promise<Reading>} paths and coverage, never a rejection.
   */
  async finish(agentId, cwd) {
    // `none`, not `complete`: every path that leaves through this local means
    // nobody looked at the workspace. Calling that `complete` would let the
    // card claim the turn produced nothing else when the truth is that the turn
    // was never swept — a different sentence, and the one this field exists to
    // keep apart.
    const nothing = { paths: [], coverage: 'none' }
    if (typeof agentId !== 'string' || agentId.length === 0) return nothing
    // The baseline is read and dropped before any other reason to decline. A
    // reading taken at the opening of a turn is worthless the moment that turn is
    // over, and keeping it would let the next `turn/end` — one whose `turn/start`
    // never arrived, e.g. across a host restart — measure itself from the
    // previous turn's opening reading and credit this turn with work that was
    // already dirty when it began.
    const pending = this.baselines.get(agentId)
    this.baselines.delete(agentId)
    if (typeof cwd !== 'string' || cwd.length === 0) return nothing
    if (typeof this.changes !== 'function') return nothing
    // No baseline means the turn began in another process, or before this
    // listener was installed. Answering "nothing changed" is honest; answering
    // the full dirty-tree list would credit the turn with work it did not do.
    if (pending === undefined) return nothing
    const before = await pending
    let after
    try {
      after = asReading(await this.changes(cwd))
    } catch {
      return nothing
    }
    // Coverage is the weaker of the two readings, by the same lattice the turn
    // level merge uses: if either end of the interval never looked, the
    // difference between them is not a measurement at all, and if either end
    // stopped early, it is a partial answer even when the subtraction was clean.
    const coverage = mergeCoverage(before.coverage, after.coverage)
    const fresh = newestChanges(before.paths, after.paths)
    return { paths: fresh, coverage }
  }

  /**
   * Drop a session's baseline. Called on disposal so the map follows host uptime.
   *
   * @param {string} agentId - the session.
   * @returns {void}
   */
  forget(agentId) {
    this.baselines.delete(agentId)
  }
}
