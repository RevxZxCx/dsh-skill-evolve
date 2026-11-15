/**
 * Shell write-target tests.
 *
 * The file card used to be blind to everything written through `bash`. These
 * assertions pin the recovery: which words in a command name a file that will
 * exist afterwards, and which words only look like one.
 *
 * The interesting cases are the ones a `split(' ')` gets wrong: a `>` inside
 * quotes, a heredoc body full of program text, `2>&1` next to `2>err.txt`, and
 * an operator glued to its target with no space.
 */

import { canonicalPath, writtenPaths, stripHeredocs } from '../packages/core/lib/shellpaths.js'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) passed += 1
  else {
    failed += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function same(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ------------------------------------------------------------ redirects --
same('a redirect names its target', writtenPaths('cat > scripts/probe.py'), ['scripts/probe.py'])
same('append names its target', writtenPaths('echo hi >> notes.md'), ['notes.md'])
same('a numbered descriptor still names the file', writtenPaths('cmd 2> err.txt'), ['err.txt'])
same('an operator glued to the target', writtenPaths('cat >out.txt'), ['out.txt'])
same('a glued append', writtenPaths('cmd >>log.txt'), ['log.txt'])
same('an ampersand redirect', writtenPaths('cmd &> both.txt'), ['both.txt'])
same('several redirects in one call', writtenPaths('cmd > a.txt 2> b.txt'), ['a.txt', 'b.txt'])
same('redirect through a pipe', writtenPaths('echo x | tee log.txt > /dev/null'), ['log.txt'])

// ------------------------------------------------- things that are not --
same('the null device is not a file', writtenPaths('python x.py 2>/dev/null'), [])
same('a descriptor duplicate is not a file', writtenPaths('cmd 2>&1'), [])
// `>&file` is csh shorthand that bash also accepts; `&>file` above is the bash
// spelling and is the one this scanner reads. The csh form is left unclaimed on
// purpose: supporting it means also distinguishing `>&2` (a duplicate) from
// `>&2.log` (a file), and a missed row is the cheap error here — the alternative
// is a card that claims a file named `2`.
same('a csh-style redirect is left unclaimed', writtenPaths('cmd >& out.txt'), [])
same('a redirect inside quotes names nothing', writtenPaths('echo "a > b"'), [])
same('a single-quoted redirect names nothing', writtenPaths("echo 'a > b'"), [])
same('a comment is not a command', writtenPaths('cat a.txt # > b.txt'), ['b.txt'])
same('an unparseable command returns nothing', writtenPaths(''), [])
same('a non-string returns nothing', writtenPaths(undefined), [])
same('a command that writes nothing returns nothing', writtenPaths('ls -la'), [])

// ----------------------------------------------------------- heredocs --
same(
  'a heredoc names the file, not the body',
  writtenPaths("cat > f.md <<'EOF'\nhello > notafile\nEOF"),
  ['f.md'],
)
same(
  'a heredoc with an unquoted marker',
  writtenPaths('cat > g.md <<EOF\n> inner\ntext\nEOF'),
  ['g.md'],
)
same(
  'an unterminated heredoc names only what came before',
  writtenPaths('cat > h.md <<EOF\nbody without end'),
  ['h.md'],
)
same(
  'two heredocs in one call',
  writtenPaths("cat > a.md <<'A'\none\nA\ncat > b.md <<'B'\ntwo\nB"),
  ['a.md', 'b.md'],
)
check(
  'stripHeredocs keeps the command and drops the body',
  stripHeredocs("cat > f.md <<'EOF'\nhello\nEOF") === 'cat > f.md ',
  JSON.stringify(stripHeredocs("cat > f.md <<'EOF'\nhello\nEOF")),
)

// -------------------------------------------------------- named tools --
same('tee names every file it writes', writtenPaths('tee a.txt b.txt'), ['a.txt', 'b.txt'])
same('tee skips its flags', writtenPaths('tee -a log.txt'), ['log.txt'])
same('touch names the file it creates', writtenPaths('touch new.md'), ['new.md'])
same('cp names its destination', writtenPaths('cp src/a.js dist/a.js'), ['dist/a.js'])
same('mv names its destination', writtenPaths('mv a.js b.js'), ['b.js'])
same('cp with flags still names its destination', writtenPaths('cp -r src/ dist/'), ['dist/'])
// One operand is not a copy: `cp a.js` fails, so no file appears. The scan
// cannot tell "one file, no flags" from "one flag, no files" without parsing
// every flag's arity, and naming the only word it was given would put the
// *source* of a broken copy on the card as if it had been written.
same('one operand is not a copy, so nothing appears', writtenPaths('cp a.js'), [])

// ------------------------------------------------------------ segments --
same('a chained command names both files', writtenPaths('mkdir -p x && cat > x/y.md'), ['x/y.md'])
same('a semicolon separates commands', writtenPaths('echo a > a.txt; echo b > b.txt'), ['a.txt', 'b.txt'])
same('a leading assignment is not the command', writtenPaths('FOO=1 cat > z.txt'), ['z.txt'])
same('two assignments are not the command', writtenPaths('A=1 B=2 cat > z.txt'), ['z.txt'])
same('a newline separates commands', writtenPaths('echo a > a.txt\ncat > b.txt'), ['a.txt', 'b.txt'])
same('a duplicate target is named once', writtenPaths('cat > a.txt && cat > a.txt'), ['a.txt'])

// --------------------------------------------------------------- shape --
check('a relative path stays relative', writtenPaths('cat > rel/x.md')[0] === 'rel/x.md', JSON.stringify(writtenPaths('cat > rel/x.md')))
check('an absolute path stays absolute', writtenPaths('cat > /tmp/x.md')[0] === '/tmp/x.md', JSON.stringify(writtenPaths('cat > /tmp/x.md')))
check('a spaced path survives as one word', writtenPaths('cat > "my notes.md"')[0] === 'my notes.md', JSON.stringify(writtenPaths('cat > "my notes.md"')))
check(
  'a trailing separator is not part of the name',
  writtenPaths('cat > a.txt &&')[0] === 'a.txt',
  JSON.stringify(writtenPaths('cat > a.txt &&')),
)

// A command assembled by a loop can name more files than a card can carry.
const many = Array.from({ length: 60 }, (_, index) => `cat > f${index}.txt`).join(' && ')
const capped = writtenPaths(many)
check('a huge command is capped', capped.length === 20, `got ${capped.length}`)
check('and the cap keeps the first targets', capped[0] === 'f0.txt' && capped[19] === 'f19.txt', JSON.stringify(capped.slice(0, 2)))

// A program name is not a promise about what it writes: `python build.py` may
// emit a hundred files and this module must name none of them.
same('a program that writes files is not guessed at', writtenPaths('python build.py'), [])
same('a package script is not guessed at', writtenPaths('pnpm build'), [])
same('a git command names no file', writtenPaths('git add -A'), [])

// ---------------------------------------------------------- a base to use --
//
// Without a base the paths come back exactly as the command spelled them, and
// that is what every assertion above pins. With one, the command's own `cd` is
// followed, because the panel stores absolute paths: a record that keeps
// `packages/lib/a.js` cannot be resolved later by anyone — the card joins it to
// the session root, which is not where the command ran, and then reports a file
// the turn just wrote as deleted.
const BASE = 'F:\\work\\app'

same('a relative target is resolved against the base', writtenPaths('cat > notes.txt', BASE), ['F:\\work\\app\\notes.txt'])
// A shell on Windows is usually an MSYS shell, and a model writing a Windows
// path into one writes forward slashes — that is the form that has to survive.
same('an absolute target is left alone', writtenPaths('cat > F:/elsewhere/x.txt', BASE), ['F:\\elsewhere\\x.txt'])
same('and single quotes preserve the backslashes', writtenPaths("cat > 'F:\\elsewhere\\y.txt'", BASE), ['F:\\elsewhere\\y.txt'])
// Not a bug, a shell fact: inside double quotes a backslash escapes the next
// character, so this command really does name `F:elsewherex.txt`.
same('a double-quoted path is unescaped by the shell, not resolved', writtenPaths('cat > "F:\\elsewhere\\x.txt"', BASE), ['F:\\work\\app\\F:elsewherex.txt'])
same('a cd moves the base for what follows', writtenPaths('cd sub && cat > notes.txt', BASE), ['F:\\work\\app\\sub\\notes.txt'])
same('a cd to an absolute path replaces the base', writtenPaths('cd F:/elsewhere && cat > notes.txt', BASE), ['F:\\elsewhere\\notes.txt'])
same('a nested cd composes', writtenPaths('cd a && cd b && cat > c.txt', BASE), ['F:\\work\\app\\a\\b\\c.txt'])
same('pushd is followed like cd', writtenPaths('pushd sub && cat > notes.txt', BASE), ['F:\\work\\app\\sub\\notes.txt'])
same(
  'a cd only moves what comes after it',
  writtenPaths('cat > before.txt && cd sub && cat > after.txt', BASE),
  ['F:\\work\\app\\before.txt', 'F:\\work\\app\\sub\\after.txt'],
)

// Three spellings of "a directory this module cannot know". Guessing at any of
// them would write a confidently wrong absolute path — worse than the relative
// one it replaced, because a relative path can still be resolved by a reader who
// knows more than this function does.
same('cd - is not followed', writtenPaths('cd - && cat > notes.txt', BASE), ['F:\\work\\app\\notes.txt'])
same('a cd through a variable is not followed', writtenPaths('cd $DIR && cat > notes.txt', BASE), ['F:\\work\\app\\notes.txt'])
same('a cd through a home shortcut is not followed', writtenPaths('cd ~/x && cat > notes.txt', BASE), ['F:\\work\\app\\notes.txt'])

// A shell on Windows is often an MSYS shell, which spells `F:\x` as `/f/x`. The
// two name one directory, and only the drive form is unambiguous — `/tmp` and
// `/usr/bin` are the shell's own roots and this module has no way to place them.
same(
  'an msys drive path is folded to the windows one',
  writtenPaths('cd /f/work/app && cat > notes.txt', 'F:\\work'),
  ['F:\\work\\app\\notes.txt'],
)
// The shell's own roots are not the project's. `/tmp` is absolute, so it is not
// joined to a Windows base — and it is not folded either, because only the
// drive form is unambiguous.
same('a shell path without a drive is not joined to the base', writtenPaths('cat > /tmp/x.txt', BASE), ['/tmp/x.txt'])

// One file, one entry. `path.join` spells separators with backslashes while a
// model writing an `edit` call types forward slashes; both name the same file
// and the list is keyed by the string, so without this the card draws two rows
// and one of them is a ghost.
same('canonicalPath folds a drive path', canonicalPath('F:/a/b.js'), 'F:\\a\\b.js')
same('canonicalPath leaves a posix path alone', canonicalPath('/home/u/a.js'), '/home/u/a.js')
same('canonicalPath is a no-op on what it has already done', canonicalPath('F:\\a\\b.js'), 'F:\\a\\b.js')
check('the same file has one spelling', canonicalPath('F:/a/b.js') === canonicalPath('F:\\a\\b.js'))
check('a redirect target comes back canonical', writtenPaths('cat > F:/a/b.txt', BASE)[0] === 'F:\\a\\b.txt', JSON.stringify(writtenPaths('cat > F:/a/b.txt', BASE)))

console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
