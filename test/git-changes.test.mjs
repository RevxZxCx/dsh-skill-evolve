/**
 * Tests for the A path — git as a collector.
 *
 * Two halves, tested separately because they fail for different reasons:
 *
 *   1. {@link parsePorcelain} reads bytes. Its bugs are about record boundaries
 *      — a rename is two records, a path may contain a space, the stream ends
 *      with a NUL. All of that can be tested with string literals, and the
 *      literals here were copied out of a real `git status` run rather than
 *      invented, because a parser tested against made-up input agrees with the
 *      test author's misunderstanding.
 *   2. {@link changedFiles} runs git. Its bugs are about failure: no repository,
 *      no binary, an answer too large to be a list. Every one of those has to
 *      come back as `[]` rather than as a throw, so the fake runner below can
 *      produce them without a filesystem.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GIT_TIMEOUT_MS,
  MAX_CHANGED_FILES,
  changedFiles,
  ignoredPaths,
  sweepChanges,
  newestChanges,
  parsePorcelain,
  toAbsolute,
} from '../packages/ui-evolve/lib/git-changes.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    failures.push(detail === undefined ? label : `${label} — ${detail}`)
  }
}

/** Build a fake runner from a list of `[code, stdout]` answers, in order. */
function runner(answers) {
  const calls = []
  const run = async (args, cwd) => {
    calls.push({ args, cwd })
    const next = answers.shift()
    if (next === undefined) return { code: 1, stdout: '' }
    return { code: next[0], stdout: next[1] }
  }
  return { run, calls }
}

// ------------------------------------------------------------- the parser --

{
  // Copied from a real repository holding: one modified file, one rename, one
  // untracked file whose name contains a space.
  const raw = '\u0000'.concat([
    ' M keep.txt',
    'R  new.txt',
    'old.txt',
    '?? space name.txt',
    '',
  ].join('\u0000'))

  const records = parsePorcelain(raw)

  check('every record is read', records.length === 3, String(records.length))
  check('a modification is one record', records[0]?.path === 'keep.txt', JSON.stringify(records[0]))
  check('the status travels with the path', records[0]?.status === ' M', JSON.stringify(records[0]?.status))

  // The whole point of `-z`: a name with a space arrives whole. Under the
  // default porcelain format it would be quoted and escaped, and a reader that
  // forgot would show `"space` and `name.txt"`.
  check('a path with a space is not split', records[2]?.path === 'space name.txt', JSON.stringify(records[2]))
  check('an untracked file is read too', records[2]?.status === '??', JSON.stringify(records[2]?.status))

  // A rename occupies two records. The second holds the name the file had, and
  // must not become a row: that path no longer exists.
  const paths = records.map((record) => record.path)
  check('a rename keeps the new name', paths.includes('new.txt') === true, JSON.stringify(paths))
  check('and drops the old one', paths.includes('old.txt') === false, JSON.stringify(paths))
  check('so three records come from four strings', paths.length === 3, JSON.stringify(paths))
}

{
  // A copy is the other paired code, and the pairing is decided by the first
  // status character, not by the string "R" appearing anywhere.
  const records = parsePorcelain('C  copy.txt\u0000source.txt\u0000')
  check('a copy is paired like a rename', records.length === 1, String(records.length))
  check('and keeps the copy', records[0]?.path === 'copy.txt', JSON.stringify(records[0]))
}

{
  // `RM` — renamed and then modified — still pairs: the first character is what
  // decides, not the whole status.
  const records = parsePorcelain('RM staged.txt\u0000gone.txt\u0000')
  check('a renamed-and-modified file still pairs', records.length === 1, String(records.length))
  check('and still keeps only the new name', records[0]?.path === 'staged.txt', JSON.stringify(records[0]))
}

{
  check('empty input yields nothing', parsePorcelain('').length === 0)
  check('a non-string yields nothing', parsePorcelain(undefined).length === 0)
  // A truncated record is not guessed at: inventing a filename from three
  // characters would put a file on the card that does not exist.
  check('a short record is skipped', parsePorcelain('M\u0000').length === 0)
  check('a record with an empty path is skipped', parsePorcelain(' M \u0000').length === 0)
  // Only a trailing NUL leaves an empty string; the length guard is what makes
  // it harmless, so this asserts the guard rather than the split.
  check('a trailing separator is not a record', parsePorcelain(' M a.txt\u0000').length === 1)
}

// --------------------------------------------------------- joining the root --

{
  const root = join('C:', 'work', 'repo')
  check('paths are joined to the repository root', toAbsolute(root, 'src/a.ts') === join(root, 'src/a.ts'))
  check('a root-level file needs no directory', toAbsolute(root, 'readme.md') === join(root, 'readme.md'))
}

// ----------------------------------------------------------- running git --

{
  const fake = runner([
    [0, join('C:', 'work', 'repo') + '\n'],
    [0, ' M src/a.ts\u0000?? out/b.png\u0000'],
  ])
  const paths = await changedFiles({ cwd: join('C:', 'work', 'repo'), run: fake.run })

  check('the root is asked for first', fake.calls[0]?.args[0] === 'rev-parse', JSON.stringify(fake.calls[0]?.args))
  check('and the probe is the toplevel one', fake.calls[0]?.args.includes('--show-toplevel') === true, JSON.stringify(fake.calls[0]?.args))
  check('status runs in the repository root', fake.calls[1]?.cwd === join('C:', 'work', 'repo'), String(fake.calls[1]?.cwd))
  check('status asks for untracked files', fake.calls[1]?.args.includes('--untracked-files=all') === true, JSON.stringify(fake.calls[1]?.args))
  check('status asks for the NUL format', fake.calls[1]?.args.includes('--porcelain=v1') === true, JSON.stringify(fake.calls[1]?.args))
  check('both paths come back absolute', paths.every((p) => p.startsWith(join('C:', 'work', 'repo')) === true), JSON.stringify(paths))
  check('and there are two of them', paths.length === 2, JSON.stringify(paths))
}

{
  // Git's output is relative to the root, but the session may sit below it.
  // Joining to the session directory instead of the root is the mistake this
  // asserts against: it would produce a path that exists nowhere.
  const root = join('C:', 'work', 'repo')
  const fake = runner([
    [0, root + '\n'],
    [0, ' M deep/nested/a.txt\u0000'],
  ])
  const paths = await changedFiles({ cwd: join(root, 'deep'), run: fake.run })
  check('a session in a subdirectory still joins to the root', paths[0] === join(root, 'deep', 'nested', 'a.txt'), JSON.stringify(paths))
}

{
  const notRepo = runner([[128, '']])
  const paths = await changedFiles({ cwd: join('F:', 'test'), run: notRepo.run })
  check('a directory that is not a repository yields nothing', paths.length === 0, JSON.stringify(paths))
  check('and git is asked only once', notRepo.calls.length === 1, String(notRepo.calls.length))
  check('and status is never asked', notRepo.calls.every((call) => call.args[0] !== 'status') === true, JSON.stringify(notRepo.calls.map((call) => call.args[0])))
}

{
  // A missing binary sets `error` with no numeric `code`; the wrapper maps that
  // to a non-zero exit rather than to a crash.
  const empty = runner([[1, '']])
  check('a failed root probe does not throw', (await changedFiles({ cwd: 'F:/nowhere', run: empty.run })).length === 0)
  check('an empty cwd is refused without running anything', (await changedFiles({ cwd: '', run: empty.run })).length === 0)
  check('no options at all is refused too', (await changedFiles(undefined)).length === 0)
}

{
  // Distinct names, because the collector deduplicates: repeating one path
  // 2000 times measures the set, not the cap.
  const distinct = (count) => Array.from({ length: count }, (_, i) => ` M f${i}.txt\u0000`).join('')
  const huge = distinct(MAX_CHANGED_FILES + 1)
  const fake = runner([[0, join('F:', 'big') + '\n'], [0, huge]])
  const paths = await changedFiles({ cwd: join('F:', 'big'), run: fake.run })
  check('an answer too large to be a list is dropped', paths.length === 0, String(paths.length))
}

{
  // Exactly at the cap is still a list; the guard is "more than", not "at least".
  const distinct = (count) => Array.from({ length: count }, (_, i) => ` M f${i}.txt\u0000`).join('')
  const atCap = distinct(MAX_CHANGED_FILES)
  const fake = runner([[0, join('F:', 'big') + '\n'], [0, atCap]])
  const paths = await changedFiles({ cwd: join('F:', 'big'), run: fake.run })
  check('a list exactly at the cap is kept', paths.length === MAX_CHANGED_FILES, String(paths.length))
}

{
  // The same file can appear under two statuses (staged and unstaged), and the
  // card must show one row.
  const fake = runner([[0, join('F:', 'dup') + '\n'], [0, 'MM a.txt\u0000 M a.txt\u0000']])
  const paths = await changedFiles({ cwd: join('F:', 'dup'), run: fake.run })
  check('a file reported twice becomes one path', paths.length === 1, JSON.stringify(paths))
}

{
  check('the timeout is short enough to be invisible', GIT_TIMEOUT_MS <= 5000 === true, String(GIT_TIMEOUT_MS))
}

// ------------------------------------------------- against the last reading --

{
  const before = ['a.ts', 'b.ts']
  const after = ['a.ts', 'b.ts', 'c.ts']
  const fresh = newestChanges(before, after)
  check('only the new path is this turn', fresh.length === 1 && fresh[0] === 'c.ts', JSON.stringify(fresh))
  check('an unchanged reading yields nothing', newestChanges(before, before).length === 0)
  check('no baseline means the whole reading counts', newestChanges(undefined, after).length === 3)
  check('a missing reading yields nothing', newestChanges(before, undefined).length === 0)
  // A path that disappears and comes back is new again; the set comparison is
  // between two readings, not a history of everything ever seen.
  check('a path that reappears counts as new', newestChanges(before, ['a.ts', 'c.ts']).length === 1)
}

// ------------------------------------------------------- the sweep, not one repo --

{
  // A workspace that IS a repository root. One `rev-parse` both locates it and
  // decides whether it is a worktree, so the answer has three lines and the status
  // is asked in the root the answer named — not in the cwd that was handed over.
  const repo = join('F:', 'solo')
  const fake = runner([
    [0, `${repo}\n${join(repo, '.git')}\n${join(repo, '.git')}\n`],
    [0, ' M code.py\u0000'],
  ])
  const swept = await sweepChanges({ cwd: repo, run: fake.run })
  check('a repository root is read once', fake.calls.length === 2, JSON.stringify(fake.calls.map((call) => call.args)))
  check('and its files are the sweep', swept.paths.length === 1 && swept.paths[0] === join(repo, 'code.py'), JSON.stringify(swept.paths))
  check('and it claims full coverage', swept.coverage === 'complete', swept.coverage)
  // The origins are reported so the card can say where a file came from without
  // re-asking git, and so a later phase can group by root.
  check('and the root it read is named', swept.roots.length === 1 && swept.roots[0] === repo, JSON.stringify(swept.roots))
}

{
  // A worktree: `--absolute-git-dir` lives under another repository's `.git`,
  // while `--git-common-dir` is that shared `.git`. Same content, different
  // bookkeeping — the distinction exists so a reader can tell them apart later.
  const worktree = join('F:', 'wt')
  const common = join('F:', 'main', '.git')
  const fake = runner([
    [0, `${worktree}\n${join(common, 'worktrees', 'wt')}\n${common}\n`],
    [0, '?? new.txt\u0000'],
  ])
  const swept = await sweepChanges({ cwd: worktree, run: fake.run })
  check('a worktree is still read', swept.paths.length === 1, JSON.stringify(swept.paths))
  // A relative `--git-common-dir` is resolved against the directory the command
  // ran in, not against the repository root — the two differ for a worktree.
  const relative = runner([
    [0, `${worktree}\n${join(common, 'worktrees', 'wt')}\n../main/.git\n`],
    [0, ''],
  ])
  const fromRelative = await sweepChanges({ cwd: worktree, run: relative.run })
  check('a relative common directory is resolved against the cwd', fromRelative.coverage === 'complete', fromRelative.coverage)
}

{
  // A workspace that is NOT a repository but CONTAINS them — the case that started
  // this phase. `findChildRepositories` needs a real directory, so this half is
  // tested through the injected runner where the discovery step is skipped: the
  // roots arrive as the sweep's own answer and each is read in turn.
  const one = join('F:', 'parent', 'one')
  const two = join('F:', 'parent', 'two')
  const fake = runner([
    [0, `${one}\n${join(one, '.git')}\n${join(one, '.git')}\n`],
    [0, ' M a.py\u0000'],
    [0, `${two}\n${join(two, '.git')}\n${join(two, '.git')}\n`],
    [0, '?? b.zip\u0000'],
  ])
  // `paths` from two roots cannot both be right unless the join used each
  // repository's own root: one shared prefix would put a file in the wrong folder.
  const swept = await sweepChanges({ cwd: join('F:', 'parent'), roots: [one, two], run: fake.run })
  check('two roots are each read', fake.calls.length === 4, String(fake.calls.length))
  check('and their files land under their own roots', swept.paths.includes(join(one, 'a.py')) && swept.paths.includes(join(two, 'b.zip')), JSON.stringify(swept.paths))
  check('and both are named', swept.roots.length === 2, JSON.stringify(swept.roots))
}

{
  // One root readable, one not. The turn did produce files, but the sweep cannot
  // claim to have seen the whole workspace — that has to reach the card, because
  // "nothing else was produced" would be a lie the reader cannot check.
  const good = join('F:', 'mix', 'good')
  const bad = join('F:', 'mix', 'bad')
  const fake = runner([
    [0, `${good}\n${join(good, '.git')}\n${join(good, '.git')}\n`],
    [0, ' M ok.py\u0000'],
    [128, ''],
  ])
  const swept = await sweepChanges({ cwd: join('F:', 'mix'), roots: [good, bad], run: fake.run })
  check('the readable root still contributes', swept.paths.length === 1, JSON.stringify(swept.paths))
  check('but the sweep admits it is partial', swept.coverage === 'partial', swept.coverage)
  check('and only the readable root is named', swept.roots.length === 1, JSON.stringify(swept.roots))
}

{
  // Too many changes to list is not "nothing changed". The files exist; this
  // sweep declined to enumerate them, and the difference is exactly what the
  // coverage field is for.
  const repo = join('F:', 'huge2')
  const many = Array.from({ length: MAX_CHANGED_FILES + 1 }, (_, i) => ` M g${i}.txt\u0000`).join('')
  const fake = runner([[0, `${repo}\n${join(repo, '.git')}\n${join(repo, '.git')}\n`], [0, many]])
  const swept = await sweepChanges({ cwd: repo, run: fake.run })
  check('a sweep that gave up lists nothing', swept.paths.length === 0, String(swept.paths.length))
  check('and says it gave up', swept.coverage === 'partial', swept.coverage)
}

{
  // A directory that is neither a repository nor holds one. `complete` is the
  // honest answer: the sweep looked, and there was nothing to see. Saying
  // `partial` here would put a caveat on every session in a plain folder.
  const plain = join('F:', 'plain')
  const fake = runner([[128, '']])
  const swept = await sweepChanges({ cwd: plain, run: fake.run })
  check('a plain folder produces no files', swept.paths.length === 0, String(swept.paths.length))
  check('and no caveat either', swept.coverage === 'complete', swept.coverage)
}

// -------------------------------------------------------- the ignore test --

{
  // No paths, no question. Spawning git to be told "nothing" is the cost this
  // whole module is careful about, and the scanner can legitimately hand over
  // an empty list.
  const fake = runner([])
  const { ignored: quiet } = await ignoredPaths({ cwd: join('F:', 'repo'), paths: [], run: fake.run })
  check('no paths asks git nothing', quiet.length === 0, String(quiet.length))
  check('and spawns nothing either', fake.calls.length === 0, String(fake.calls.length))
}

{
  // The whole point: git status cannot see this file, check-ignore can.
  const root = join('F:', 'repo')
  const bundle = join(root, 'dist', 'bundle.js')
  const fake = runner([
    [0, `${root}\n${join(root, '.git')}\n${join(root, '.git')}\n`],
    [0, `${bundle}\u0000`],
  ])
  const { ignored: found } = await ignoredPaths({ cwd: root, paths: [bundle], run: fake.run })
  check('one ignored path is reported', found.length === 1, String(found.length))
  check('and it is the path it was given', found[0] === bundle, String(found[0]))
}

{
  // `check-ignore` exits 1 when nothing in the batch is ignored. That is the
  // common answer and it is not an error: the sweep simply gains nothing.
  const root = join('F:', 'repo')
  const fake = runner([
    [0, `${root}\n${join(root, '.git')}\n${join(root, '.git')}\n`],
    [1, ''],
  ])
  const { ignored: found, known } = await ignoredPaths({ cwd: root, paths: [join(root, 'src', 'new.js')], run: fake.run })
  check('a batch nothing ignores answers nothing', found.length === 0, String(found.length))
  // Exit 1 is an answer: git looked, and nothing matched.
  check('and exit 1 still counts as an answer', known === true, String(known))
}

{
  // `check-ignore` fails the *whole batch* on one path outside the repository,
  // so the caller must never pass one. Dropping it here is also the honest
  // answer: a file belonging to no repository is not something git was hiding.
  const root = join('F:', 'repo')
  const outside = join('F:', 'elsewhere', 'stray.txt')
  const fake = runner([
    [0, `${root}\n${join(root, '.git')}\n${join(root, '.git')}\n`],
  ])
  const { ignored: found } = await ignoredPaths({ cwd: root, paths: [outside], run: fake.run })
  check('a path outside the repository is not asked about', found.length === 0, String(found.length))
  check('so only the description ran', fake.calls.length === 1, String(fake.calls.length))
}

{
  // The list goes in on stdin, NUL separated and NUL terminated: `-z` is refused
  // as an argument (`fatal: -z only makes sense with --stdin`), and git waits
  // for end-of-input before answering.
  const root = join('F:', 'repo')
  const seen = []
  const run = async (args, cwd, input) => {
    seen.push({ args, cwd, input })
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${root}\n${join(root, '.git')}\n${join(root, '.git')}\n` }
    return { code: 1, stdout: '' }
  }
  const one = join(root, 'dist', 'a.js')
  const two = join(root, 'debug.log')
  const { ignored: _unused } = await ignoredPaths({ cwd: root, paths: [one, two], run })
  const asked = seen[1]
  check('the ignore call asks stdin for its list', asked?.args.includes('--stdin') === true, String(asked?.args))
  check('and separates the paths with NUL', asked?.input === `${one}\u0000${two}\u0000`, String(asked?.input))
}

{
  // A workspace that is not a repository: nothing to ask, no process spent.
  const plain = join('F:', 'plain')
  const fake = runner([[128, '']])
  const answer = await ignoredPaths({ cwd: plain, paths: [join(plain, 'x.js')], run: fake.run })
  check('outside a repository nothing is ignored', answer.ignored.length === 0, String(answer.ignored.length))
  // Nothing ignored and "no repository to ignore in" are different answers, and
  // the merge reads this one to decide whether the walk's list is redundant. A
  // plain folder reporting `repository: true` would make the merge discard the
  // walk's whole list -- in exactly the workspace where the walk is the only
  // witness. The empty list alone cannot tell the two cases apart.
  check('and it says the question did not apply here', answer.repository === false, String(answer.repository))
  check('and it still counts as asked', answer.known === true, String(answer.known))
}

{
  // The fake runner above proves the arithmetic; it cannot prove that the real
  // command accepts its list on stdin, and that is exactly where the last
  // version of this idea would have failed: `-z` is refused as an argument, and
  // a child process that never closes stdin waits for a timeout instead of
  // answering. So this one builds a real repository and uses the real runner.
  const root = await mkdtemp(join(tmpdir(), 'dsse-ignore-'))
  try {
    const git = (args) =>
      new Promise((done) => {
        execFile('git', args, { cwd: root, windowsHide: true }, (error) => done(error === null))
      })
    const ready = await git(['init', '-q', '.'])
    if (ready === true) {
      await writeFile(join(root, '.gitignore'), 'dist/\n*.log\n')
      await mkdir(join(root, 'dist'), { recursive: true })
      await mkdir(join(root, 'src'), { recursive: true })
      const ignored = join(root, 'dist', 'bundle.js')
      const visible = join(root, 'src', 'new.js')
      const trailing = join(root, 'debug.log')
      await writeFile(ignored, 'x')
      await writeFile(visible, 'x')
      await writeFile(trailing, 'x')
      // `dist/` holds an ignored file and `src/` a visible one; the third is
      // ignored by a pattern that matches any directory.
      const { ignored: found, known } = await ignoredPaths({ cwd: root, paths: [ignored, visible, trailing] })
      check('a real repository is answered, not guessed', known === true, String(known))
      check('the real git names the ignored files', found.includes(ignored) === true, JSON.stringify(found))
      check('and it does not name the visible one', found.includes(visible) === false, JSON.stringify(found))
      check('a pattern matching any directory also counts', found.includes(trailing) === true, JSON.stringify(found))
      // The premise of the whole merge: the same file is invisible to status.
      const swept = await sweepChanges({ cwd: root })
      check('git status cannot see the ignored file', swept.paths.includes(ignored) === false, JSON.stringify(swept.paths))
      check('but it does see the visible one', swept.paths.includes(visible) === true, JSON.stringify(swept.paths))
    }
    check('the repository was built', ready === true, String(ready))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
