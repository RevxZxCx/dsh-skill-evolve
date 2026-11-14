/**
 * How two coverage claims combine.
 *
 * Coverage answers one question about a sweep: how much of the workspace did it
 * actually see. There are three answers and they are ordered by how little they
 * promise, which makes the merge a lattice rather than a preference:
 *
 *   `none`      nothing was looked at, so nothing can be claimed
 *   `partial`   something was looked at, and the sweep knows it stopped early
 *   `complete`  the walk finished
 *
 * Two sweeps in one turn can only tell the reader what *both* of them saw, so
 * the answer is the weaker of the two. `none` wins over `partial` because a
 * baseline that was never taken leaves the ending reading with nothing to be
 * compared against — the interval was not measured at all, even if the second
 * walk ran to the end.
 *
 * This lives in its own module because two callers need it: the turn-level merge
 * of the git and scan brackets in `index.js`, and the before/after merge inside
 * `GitWatch.finish`. Keeping one lattice in one place is the difference between
 * a rule and two guesses that happen to agree today.
 *
 * @param {unknown} left - one claim.
 * @param {unknown} right - the other claim.
 * @returns {'complete' | 'partial' | 'none'} the weaker claim.
 */
export function mergeCoverage(left, right) {
  if (left === 'none' || right === 'none') return 'none'
  if (left === 'partial' || right === 'partial') return 'partial'
  return 'complete'
}
