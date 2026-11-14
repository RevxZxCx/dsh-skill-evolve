/**
 * The coverage lattice, on its own.
 *
 * This file exists because the same three-way merge is needed in two places --
 * the turn-level join in `index.js` and the before/after join inside
 * `GitWatch.finish` -- and the bug being fixed here was precisely that a copy of
 * it in a third place (`asReading`) had quietly lost one of the three words. A
 * rule with three implementations is three rules, and only the ones with tests
 * get to stay honest.
 */
import { mergeCoverage } from '../packages/ui-evolve/lib/coverage.js'

let pass = 0
let fail = 0

/**
 * Records one assertion.
 *
 * @param {string} name - what is being asserted.
 * @param {boolean} ok - whether it held.
 * @param {string} [detail] - shown only on failure.
 */
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
    return
  }
  fail += 1
  console.log(`  FAIL ${name}${detail === '' ? '' : ` ${detail}`}`)
}

check('two finished walks are complete', mergeCoverage('complete', 'complete') === 'complete')
check('one early stop makes the answer partial', mergeCoverage('complete', 'partial') === 'partial')
check('and order does not matter', mergeCoverage('partial', 'complete') === 'partial')
check('two partial walks stay partial', mergeCoverage('partial', 'partial') === 'partial')
check('a bracket that never looked dominates a finished one', mergeCoverage('none', 'complete') === 'none')
check('and it dominates a partial one too', mergeCoverage('partial', 'none') === 'none')
check('nothing looked at on either side is still none', mergeCoverage('none', 'none') === 'none')
// The shape of every real call site: one bracket may simply be absent, because a
// turn can end before the scan opened its bracket. Absent is not a claim, so it
// must not be read as `none` either -- otherwise every turn in a repository would
// be marked unread just because the scan watcher had nothing to do.
check('an absent bracket does not veto a complete one', mergeCoverage('complete', undefined) === 'complete')
check('an absent bracket does not soften a partial one', mergeCoverage('partial', undefined) === 'partial')
// An unrecognised word is what an older injected reader returns. It is not
// evidence that anything was skipped.
check('a word from an older reader counts as complete', mergeCoverage('mostly', 'complete') === 'complete')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
