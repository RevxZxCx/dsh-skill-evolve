import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_SCAN_DEPTH,
  MAX_SCAN_MS,
  MAX_SCANNED_ENTRIES,
  scanChanges,
} from '../packages/ui-evolve/lib/scan-changes.js'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

async function makeTree(names) {
  const root = await mkdtemp(join(tmpdir(), 'dsse-scan-'))
  for (const name of names) {
    const absolute = join(root, name)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, 'x')
  }
  return root
}

/** Sets a file's mtime to an exact millisecond value. */
async function stamp(absolute, ms) {
  await utimes(absolute, ms / 1000, ms / 1000)
}

// ---- the limits themselves --------------------------------------------------
check('the entry budget is a real number', Number.isFinite(MAX_SCANNED_ENTRIES) && MAX_SCANNED_ENTRIES > 0, String(MAX_SCANNED_ENTRIES))
check('the depth budget is a real number', Number.isFinite(MAX_SCAN_DEPTH) && MAX_SCAN_DEPTH > 0, String(MAX_SCAN_DEPTH))
check('the time budget is a real number', Number.isFinite(MAX_SCAN_MS) && MAX_SCAN_MS > 0, String(MAX_SCAN_MS))
check('the time budget stays under two seconds', MAX_SCAN_MS <= 2000, String(MAX_SCAN_MS))
check('the depth budget is enough for an ordinary source tree', MAX_SCAN_DEPTH >= 6, String(MAX_SCAN_DEPTH))
check('the entry budget is far more than the card can show', MAX_SCANNED_ENTRIES >= 1000, String(MAX_SCANNED_ENTRIES))

// ---- refusing to guess ------------------------------------------------------
{
  const nothing = await scanChanges({ since: 0 })
  check('no workspace means no answer', nothing.paths.length === 0)
  check('and nothing was looked at', nothing.scanned === 0)
  check('and it does not claim to be truncated', nothing.truncated === false)

  const noTime = await scanChanges({ cwd: tmpdir() })
  check('no point in time means no answer', noTime.paths.length === 0)
  check('and nothing was looked at either', noTime.scanned === 0)

  const nan = await scanChanges({ cwd: tmpdir(), since: Number.NaN })
  check('a NaN timestamp is not a point in time', nan.paths.length === 0)
}

// ---- one file, one answer ---------------------------------------------------
{
  const root = await makeTree(['src/a.txt'])
  const absolute = join(root, 'src', 'a.txt')
  await stamp(absolute, 5000)
  const found = await scanChanges({ cwd: root, since: 4000 })
  check('a file newer than the turn is found', found.paths.length === 1, found.paths.join('|'))
  check('and it is reported as an absolute path', found.paths[0] === absolute, found.paths[0])
  check('and it is not truncated', found.truncated === false)

  const older = await scanChanges({ cwd: root, since: 6000 })
  check('a file older than the turn is not', older.paths.length === 0, older.paths.join('|'))

  const same = await scanChanges({ cwd: root, since: 5000 })
  check('a file at exactly the turn boundary counts', same.paths.length === 1)
  check('because a filesystem that cannot resolve the tick would otherwise report nothing', same.paths[0] === absolute)

  await rm(root, { recursive: true, force: true })
}

// ---- directories it must not read -------------------------------------------
{
  const root = await makeTree([
    'node_modules/pkg/index.js',
    'dist/bundle.js',
    'src/keep.ts',
    '_scratch/notes.md',
    '__tests__/real.test.ts',
  ])
  for (const name of ['node_modules/pkg/index.js', 'dist/bundle.js', 'src/keep.ts', '_scratch/notes.md', '__tests__/real.test.ts']) {
    await stamp(join(root, name), 5000)
  }
  const skipped = []
  const found = await scanChanges({
    cwd: root,
    since: 4000,
    skipDirectory: (name) => {
      skipped.push(name)
      return name === 'node_modules' || name === 'dist' || name === '_scratch'
    },
  })
  const names = found.paths.map((path) => path.slice(root.length + 1).split('\\').join('/')).sort()
  check('a generated directory is skipped', names.includes('node_modules/pkg/index.js') === false, names.join('|'))
  check('build output is skipped', names.includes('dist/bundle.js') === false)
  check('a scratch directory is skipped', names.includes('_scratch/notes.md') === false)
  check('a source file is kept', names.includes('src/keep.ts') === true, names.join('|'))
  check('a test directory is not treated as generated', names.includes('__tests__/real.test.ts') === true, names.join('|'))
  check('the walk asks about every directory it meets', skipped.length >= 4, skipped.join('|'))

  await rm(root, { recursive: true, force: true })
}

// ---- the entry budget -------------------------------------------------------
{
  const many = []
  for (let i = 0; i < 12; i += 1) many.push(`f${i}.txt`)
  const root = await makeTree(many)
  for (let i = 0; i < 12; i += 1) await stamp(join(root, `f${i}.txt`), 5000)
  const capped = await scanChanges({ cwd: root, since: 4000, maxEntries: 5 })
  check('the entry budget stops the walk', capped.scanned <= 5, String(capped.scanned))
  check('and says so', capped.truncated === true)
  check('and keeps what it had already found', capped.paths.length > 0, String(capped.paths.length))

  const roomy = await scanChanges({ cwd: root, since: 4000, maxEntries: 100 })
  check('a budget larger than the tree truncates nothing', roomy.truncated === false)
  check('and reports every file', roomy.paths.length === 12, String(roomy.paths.length))

  // Exactly at the budget with nothing left over is a complete answer.
  const exact = await scanChanges({ cwd: root, since: 4000, maxEntries: 12 })
  check('a walk that lands exactly on the budget is complete, not truncated', exact.truncated === false, String(exact.scanned))

  await rm(root, { recursive: true, force: true })
}

// ---- the depth budget -------------------------------------------------------
{
  const deep = join('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'deep.txt')
  const root = await makeTree([deep])
  await stamp(join(root, deep), 5000)
  const shallow = await scanChanges({ cwd: root, since: 4000, maxDepth: 3 })
  check('a file below the depth budget is not reported', shallow.paths.length === 0, shallow.paths.join('|'))
  check('and the walk admits it stopped early', shallow.truncated === true)

  const enough = await scanChanges({ cwd: root, since: 4000, maxDepth: 8 })
  check('a depth budget that reaches it finds the file', enough.paths.length === 1, enough.paths.join('|'))
  check('and nothing was left unread', enough.truncated === false)

  await rm(root, { recursive: true, force: true })
}

// ---- the time budget --------------------------------------------------------
{
  const root = await makeTree(['a.txt'])
  await stamp(join(root, 'a.txt'), 5000)
  let clock = 0
  const slow = await scanChanges({
    cwd: root,
    since: 4000,
    maxMs: 10,
    now: () => {
      clock += 100
      return clock
    },
  })
  check('a walk that runs out of time stops', slow.truncated === true)
  check('and does not claim a full answer', slow.paths.length === 0, slow.paths.join('|'))

  let steady = 0
  const quick = await scanChanges({
    cwd: root,
    since: 4000,
    maxMs: 10_000,
    now: () => {
      steady += 1
      return steady
    },
  })
  check('a walk inside the time budget finishes', quick.truncated === false)
  check('and finds the file', quick.paths.length === 1)

  await rm(root, { recursive: true, force: true })
}

// ---- a directory that cannot be read ----------------------------------------
{
  const missing = await scanChanges({ cwd: join(tmpdir(), 'dsse-scan-does-not-exist'), since: 0 })
  check('a workspace that is not there produces nothing to report', missing.paths.length === 0)
  check('but it does not pretend to have read it', missing.truncated === true)
}

// ---- what is not a produced file --------------------------------------------
{
  const root = await makeTree(['real.txt'])
  await stamp(join(root, 'real.txt'), 5000)
  // A directory whose name looks like a file must not become a row.
  await mkdir(join(root, 'looks-like.txt'), { recursive: true })
  const found = await scanChanges({ cwd: root, since: 4000 })
  check('a directory is not a file', found.paths.length === 1, found.paths.join('|'))
  check('only the real file is listed', found.paths[0] === join(root, 'real.txt'))
  await rm(root, { recursive: true, force: true })
}

// ---- the production default, not an injected one ---------------------------
//
// Every other block here passes `skipDirectory` explicitly, which proves the
// hook is asked. None of them proves production ever supplies it -- and that is
// exactly the shape of the defect this default exists to close: a filter that
// exists, is tested through injection, and is never reached by the real call
// path. So this block omits the option on purpose and asserts the default.
{
  const root = await makeTree(['real.txt', 'node_modules/lib/index.js', '.git/objects/ab/cdef'])
  for (const file of ['real.txt', 'node_modules/lib/index.js', '.git/objects/ab/cdef']) {
    await stamp(join(root, file), 5000)
  }
  const found = await scanChanges({ cwd: root, since: 4000 })
  check('a dependency tree is skipped without being asked to', found.paths.includes(join(root, 'node_modules/lib/index.js')) === false, found.paths.join('|'))
  check('a git object directory is skipped without being asked to', found.paths.includes(join(root, '.git/objects/ab/cdef')) === false, found.paths.join('|'))
  check('the real file is still the one row', found.paths.length === 1 && found.paths[0] === join(root, 'real.txt'), found.paths.join('|'))
  check('and skipping is not the same as giving up', found.truncated === false)
  await rm(root, { recursive: true, force: true })
}

// ---- a source directory whose name starts with an underscore ---------------
//
// `scratchName`'s leading-underscore rule was written for scratch FILES. If the
// walker reused it for directories it would prune every Jekyll `_posts` and Hugo
// `_build`, which are source. The card can hide a row after reading it; a walk
// that never descended cannot be undone.
{
  const root = await makeTree(['_posts/welcome.md', '_build/out.js', 'src/app.js'])
  for (const file of ['_posts/welcome.md', '_build/out.js', 'src/app.js']) {
    await stamp(join(root, file), 5000)
  }
  const found = await scanChanges({ cwd: root, since: 4000 })
  check('an underscore source directory is walked', found.paths.includes(join(root, '_posts/welcome.md')), found.paths.join('|'))
  check('and so is another one', found.paths.includes(join(root, '_build/out.js')), found.paths.join('|'))
  check('so all three are rows', found.paths.length === 3, found.paths.join('|'))
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
