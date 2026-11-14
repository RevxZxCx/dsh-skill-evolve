/**
 * `GitWatch` brackets one turn: a reading when it starts, another when it ends,
 * and the difference between them.
 *
 * The class takes its reader by injection, so every test here answers instantly
 * and none of them needs a repository on disk.
 */

import { GitWatch } from '../packages/ui-evolve/lib/git-watch.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

/**
 * A reader that answers from a queue, one array per call.
 *
 * Records the cwd of every call so the tests can assert which workspace was
 * measured.
 */
function reader(answers) {
  const calls = []
  const changes = async (cwd) => {
    calls.push(cwd)
    const next = answers.shift()
    if (next === undefined) return []
    if (next instanceof Error) throw next
    return next
  }
  return { changes, calls }
}

/** Let the fire-and-forget baseline promise settle. */
const settle = () => new Promise((done) => { setTimeout(done, 0) })

/**
 * The paths a finish answered with.
 *
 * `finish` reports two things — what changed and how completely the sweep could
 * see. Most of these tests are about the first; naming the extraction keeps each
 * assertion about the bracket rather than about the wrapper.
 */
const pathsOf = (reading) => (Array.isArray(reading?.paths) ? reading.paths : reading)

// --------------------------------------------------------------- the bracket --

{
  const fake = reader([['a', 'b'], ['a', 'b', 'c']])
  const watch = new GitWatch({ changes: fake.changes })
  watch.start('s', 'F:/repo')
  await settle()
  const fresh = pathsOf(await watch.finish('s', 'F:/repo'))
  check('a file that appeared during the turn is the turn\'s', fresh.length === 1 && fresh[0] === 'c', JSON.stringify(fresh))
  check('the baseline and the ending are read from the same workspace', fake.calls.length === 2 && fake.calls[0] === 'F:/repo' && fake.calls[1] === 'F:/repo', JSON.stringify(fake.calls))
}

{
  // The reason the baseline is a promise and not an array: `git status` can take
  // longer than the gap it brackets. A late reading must still be the one the
  // turn is measured against.
  const slow = reader([['a'], ['a', 'b']])
  const delayed = (cwd) => new Promise((done) => { setTimeout(() => { void slow.changes(cwd).then(done) }, 20) })
  const watch = new GitWatch({ changes: delayed })
  watch.start('s', 'F:/repo')
  const fresh = pathsOf(await watch.finish('s', 'F:/repo'))
  check('a slow baseline still measures this turn', fresh.length === 1 && fresh[0] === 'b', JSON.stringify(fresh))
}

{
  const watch = new GitWatch({ changes: reader([['a'], ['a']]).changes })
  watch.start('s', 'F:/repo')
  await settle()
  const fresh = pathsOf(await watch.finish('s', 'F:/repo'))
  check('a turn that changed nothing yields nothing', fresh.length === 0, JSON.stringify(fresh))
}

{
  // Files changed before the turn started belong to the dirty tree, not to this
  // turn. This is the whole reason for a baseline rather than a bare status.
  const watch = new GitWatch({ changes: reader([['old1', 'old2'], ['old1', 'old2']]).changes })
  watch.start('s', 'F:/repo')
  await settle()
  check('work that predates the turn is not the turn\'s', pathsOf(await watch.finish('s', 'F:/repo')).length === 0)
}

// -------------------------------------------------------------- the absences --

{
  const fake = reader([])
  const watch = new GitWatch({ changes: fake.changes })
  const fresh = pathsOf(await watch.finish('s', 'F:/repo'))
  check('a turn with no baseline contributes nothing', fresh.length === 0, JSON.stringify(fresh))
  check('and nothing is read for it', fake.calls.length === 0, JSON.stringify(fake.calls))
}

{
  // The baseline is consumed by the turn that used it. Keeping it would measure
  // the next turn against a reading one turn too old.
  const fake = reader([['a'], ['a', 'b'], ['a', 'b', 'c']])
  const watch = new GitWatch({ changes: fake.changes })
  watch.start('s', 'F:/repo')
  await settle()
  await watch.finish('s', 'F:/repo')
  check('the baseline is not reused by the next turn', pathsOf(await watch.finish('s', 'F:/repo')).length === 0)
}

{
  const watch = new GitWatch({ changes: reader([['a'], ['a']]).changes })
  watch.start('s', 'F:/repo')
  await settle()
  watch.forget('s')
  check('a forgotten session has no baseline', watch.baselines.has('s') === false)
  check('and its next finish contributes nothing', pathsOf(await watch.finish('s', 'F:/repo')).length === 0)
}

// ---------------------------------------------------------------- the guards --

{
  const fake = reader([])
  const watch = new GitWatch({ changes: fake.changes })
  watch.start('', 'F:/repo')
  watch.start('s', '')
  watch.start(undefined, 'F:/repo')
  await settle()
  check('a session with no id opens no baseline', watch.baselines.size === 0, String(watch.baselines.size))
  check('and no workspace is measured', fake.calls.length === 0, JSON.stringify(fake.calls))
}

{
  const watch = new GitWatch({})
  watch.start('s', 'F:/repo')
  await settle()
  check('without a reader there is nothing to remember', watch.baselines.size === 0)
  check('and finishing answers nothing rather than throwing', pathsOf(await watch.finish('s', 'F:/repo')).length === 0)
}

{
  const watch = new GitWatch({ changes: async () => { throw new Error('git exploded') } })
  watch.start('s', 'F:/repo')
  await settle()
  const fresh = pathsOf(await watch.finish('s', 'F:/repo'))
  check('a reader that throws at the end is not an error', fresh.length === 0)
}

{
  const blocked = new GitWatch({ changes: async () => { throw new Error('git exploded') } })
  blocked.start('s', 'F:/repo')
  // An unhandled rejection here would take the host down over a backstop the
  // panel can live without, so `start` catches it rather than leaving it to
  // whoever awaited.
  let unhandled = 0
  const onUnhandled = () => { unhandled += 1 }
  process.on('unhandledRejection', onUnhandled)
  blocked.start('s', 'F:/repo')
  await settle()
  await settle()
  process.removeListener('unhandledRejection', onUnhandled)
  check('a reader that throws at the start does not reject loose', unhandled === 0, String(unhandled))
}

{
  const watch = new GitWatch({ changes: async () => 'not an array' })
  watch.start('s', 'F:/repo')
  await settle()
  check('a reader answering garbage yields nothing', pathsOf(await watch.finish('s', 'F:/repo')).length === 0)
}

{
  // A second `turn/start` before the first turn ended must not leave two
  // baselines in play. The later reading wins, so the interval measured is the
  // one that actually contains the work: `['a','b']` to `['a','b','c']`.
  const fake = reader([['a'], ['a', 'b'], ['a', 'b', 'c']])
  const watch = new GitWatch({ changes: fake.changes })
  watch.start('s', 'F:/repo')
  await settle()
  watch.start('s', 'F:/repo')
  await settle()
  const fresh = pathsOf(await watch.finish('s', 'F:/repo'))
  check('a second start replaces the baseline rather than stacking', fresh.length === 1 && fresh[0] === 'c', JSON.stringify(fresh))
  check('and only one baseline was ever held', watch.baselines.size === 0, String(watch.baselines.size))
}

// ----------------------------------------------------------------- coverage --
//
// `finish` reports how completely the sweep could see, not only what it saw. A
// panel that cannot tell "nothing changed" from "I stopped looking" will hide
// work and blame the turn, so the weaker of the two readings wins.

{
  const complete = { paths: ['a'], coverage: 'complete' }
  const later = { paths: ['a', 'b'], coverage: 'complete' }
  const watch = new GitWatch({ changes: reader([complete, later]).changes })
  watch.start('s', 'F:/repo')
  await settle()
  const reading = await watch.finish('s', 'F:/repo')
  check('a clean sweep says so', reading.coverage === 'complete', JSON.stringify(reading))
}

{
  // The baseline stopped at the root cap, so the interval has a hole in it that
  // no amount of clean subtraction at the far end can repair.
  const partial = { paths: ['a'], coverage: 'partial' }
  const later = { paths: ['a', 'b'], coverage: 'complete' }
  const watch = new GitWatch({ changes: reader([partial, later]).changes })
  watch.start('s', 'F:/repo')
  await settle()
  const reading = await watch.finish('s', 'F:/repo')
  check('a partial baseline taints the whole interval', reading.coverage === 'partial', JSON.stringify(reading))
}

{
  const complete = { paths: ['a'], coverage: 'complete' }
  const partial = { paths: ['a', 'b'], coverage: 'partial' }
  const watch = new GitWatch({ changes: reader([complete, partial]).changes })
  watch.start('s', 'F:/repo')
  await settle()
  const reading = await watch.finish('s', 'F:/repo')
  check('a partial ending taints the interval too', reading.coverage === 'partial', JSON.stringify(reading))
}

{
  // A reader written before coverage existed answers a bare array. Reading that
  // as `complete` is the only honest choice: it said nothing about a limit, so
  // there is no limit to report.
  const watch = new GitWatch({ changes: reader([['a'], ['a', 'b']]).changes })
  watch.start('s', 'F:/repo')
  await settle()
  const reading = await watch.finish('s', 'F:/repo')
  check('a bare array is read as a complete answer', reading.coverage === 'complete', JSON.stringify(reading))
  check('and its paths still subtract normally', reading.paths.length === 1 && reading.paths[0] === 'b', JSON.stringify(reading))
}

{
  // No baseline means no interval was ever bracketed. That is `none`, not
  // `complete`: nobody looked, so nobody may vouch. Calling it `complete` would
  // let the card say "nothing else was produced" about a turn that was never
  // swept, and would also flatten a standing `partial` caveat from an earlier
  // turn — the exact inversion the coverage field exists to prevent.
  const watch = new GitWatch({ changes: reader([]).changes })
  const reading = await watch.finish('s', 'F:/repo')
  check('a turn with no baseline claims nothing at all', reading.coverage === 'none', JSON.stringify(reading))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
