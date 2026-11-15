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

// Three spellings of "a directory this module cannot know". The shell has left
// the base and the command does not say where it went, so the location becomes
// unknown rather than stale: the target comes back exactly as written, and the
// card reports it as unplaceable instead of inventing a directory. Saying "I
// cannot tell you which directory" is recoverable; saying "F:\work\app" when
// the file is in `$DIR` is a wrong claim that nothing downstream can check.
same('cd - leaves the directory unknown', writtenPaths('cd - && cat > notes.txt', BASE), ['notes.txt'])
same('a cd through a variable leaves it unknown', writtenPaths('cd $DIR && cat > notes.txt', BASE), ['notes.txt'])
same('a cd through a home shortcut leaves it unknown', writtenPaths('cd ~/x && cat > notes.txt', BASE), ['notes.txt'])
// `popd` needs the stack, and the stack is not kept. Falling back to the base is
// right only when exactly one pushd happened, which this function cannot count.
same('popd leaves the directory unknown', writtenPaths('pushd sub && popd && cat > back.txt', BASE), ['back.txt'])
// A subshell changes directory in a scope that is not modelled.
same('a subshell resolves inside its own directory', writtenPaths('(cd /tmp && cat > note.txt)', BASE), ['F:\\tmp\\note.txt'])

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

// The filter has to run on what the command spelled, not on the result. Every
// test in recordable() looks at the start of the string: `&1` begins with `&`,
// `NUL` is a device name, `-a` begins with `-`. Resolving first turns `&1` into
// `F:\work\app\&1`, which begins with `F`, so all three slip through and the card
// offers to open a file nobody named. These four need a base to fail: without
// one the old order happened to give the right answer.
same('a descriptor merge is not a file', writtenPaths('node build.js 2>&1 | tail -2', BASE), [])
same('a device sink is not a file', writtenPaths('echo hi > NUL', BASE), [])
same('a bare flag after tee is not a file', writtenPaths('tee -a log.txt', BASE), ['F:\\work\\app\\log.txt'])
same('a descriptor merge beside a real target', writtenPaths('make >> build.log 2>&1', BASE), ['F:\\work\\app\\build.log'])
check(
  'and the same command without a base agrees',
  JSON.stringify(writtenPaths('node build.js 2>&1 | tail -2')) === '[]',
  JSON.stringify(writtenPaths('node build.js 2>&1 | tail -2')),
)

// A subshell's closing paren sits where a space would be, so it arrives glued to
// the last target. Trimming it is only correct when a subshell was opened — a
// file may legitimately end in a paren.
same('a subshell does not put its paren in the file name', writtenPaths('(cd /tmp && cat > note.txt)', '/tmp'), ['F:\\tmp\\note.txt'])
same('but a real paren in a name survives', writtenPaths('cat > notes(1).txt', BASE), ['F:\\work\\app\\notes(1).txt'])

// ------------------------------------------ separators without spaces --
//
// A command is not obliged to put spaces around its own punctuation, and `a;b`
// was read as one word until this round. The failure is silent: the segment scan
// never sees the boundary, so a `cd` in the middle of the line does not move the
// directory, and everything after it is resolved against the directory from
// before -- naming files that do not exist while looking entirely confident.
same('a spaced semicolon starts a new command', writtenPaths('cat > a.txt; cd sub && cat > b.txt', BASE), ['F:\\work\\app\\a.txt', 'F:\\work\\app\\sub\\b.txt'])
same('a glued semicolon starts one too', writtenPaths('cat > a.txt;cd sub && cat > b.txt', BASE), ['F:\\work\\app\\a.txt', 'F:\\work\\app\\sub\\b.txt'])
same('a glued and is a boundary', writtenPaths('cd sub&&cat > b.txt', BASE), ['F:\\work\\app\\sub\\b.txt'])
same('a glued or is a boundary', writtenPaths('cd sub||cat > b.txt', BASE), ['F:\\work\\app\\sub\\b.txt'])
same('a glued pipe does not let its left side move the parent', writtenPaths('cd sub|cat > b.txt', BASE), ['F:\\work\\app\\b.txt'])
// `&` is the exception: it lives inside two redirection forms. Splitting `2>&1`
// would invent a file called `1`.
same('a descriptor duplicate keeps its ampersand', writtenPaths('cmd 2>&1', BASE), [])
same('an ampersand redirect keeps its ampersand', writtenPaths('cmd &> both.txt', BASE), ['F:\\work\\app\\both.txt'])
same('a background job does not move the parent', writtenPaths('cd sub & cat > b.txt', BASE), ['F:\\work\\app\\b.txt'])

// `>&2` is the spelling that reaches the descriptor guard: in `2>&1` the leading
// digit lets the glued-redirect rule claim it first, and the `&1` is dropped for
// starting with `&`. Reading `2` as a file name is the failure this guards.
same('a bare descriptor after >& is not a file', writtenPaths('cat >&2', BASE), [])
same('and stays empty without a base', writtenPaths('cat >&2'), [])
same('but a name after >& is a file', writtenPaths('cat >&2.log', BASE), ['F:\\work\\app\\2.log'])

// ------------------------------- a subshell is a scope, not a property of the line --
//
// The first cut of this rule made `cwd` unknown for the *rest of the command* as
// soon as any `(` appeared, and trimmed a trailing `)` off *every* target. Both
// halves were wrong in opposite directions: one lost targets that were perfectly
// placeable, the other renamed files that really do end in a paren.
same('a subshell keeps the target inside its own segment', writtenPaths('(cat > a.txt)', BASE), ['F:\\work\\app\\a.txt'])
same('and both of them when the segment has two', writtenPaths('(cat > a.txt && cat > b.txt)', BASE), ['F:\\work\\app\\a.txt', 'F:\\work\\app\\b.txt'])
same('a subshell does not poison what follows it', writtenPaths('echo hi > a.txt; (cd /tmp && echo x > b.txt); echo y > c.txt', BASE), ['F:\\work\\app\\a.txt', 'F:\\tmp\\b.txt', 'F:\\work\\app\\c.txt'])
same('a real name ending in a paren survives', writtenPaths('cp app.zip "release (final)"', BASE), ['F:\\work\\app\\release (final)'])
same('and survives next to a subshell', writtenPaths('(echo a) && cat > "note)"', BASE), ['F:\\work\\app\\note)'])
same('a paren inside a heredoc body is not a subshell', writtenPaths("cat > notes(1) <<'EOF'\nif (x) {\n}\nEOF", BASE), ['F:\\work\\app\\notes(1)'])
same('arithmetic is not a subshell', writtenPaths('((count++)) && cat > n.txt', BASE), ['F:\\work\\app\\n.txt'])
same('and a command substitution is one', writtenPaths('cd /tmp && x=$(cat > n.txt)', BASE), ['F:\\tmp\\n.txt'])

// ------------------------------------------- commands that move nowhere at all --
same('dirs prints the stack, it does not move', writtenPaths('dirs > stack.txt', BASE), ['F:\\work\\app\\stack.txt'])
same('popd keeps the redirect it was given', writtenPaths('pushd sub && popd > stack.txt', BASE), ['F:\\work\\app\\sub\\stack.txt'])
same('a posix root after an unknown cd is still absolute', writtenPaths('cd $DIR && cd /tmp && cat > n.txt', BASE), ['F:\\tmp\\n.txt'])

// --------------------------------------------- both streams, one file, two spellings --
//
// `cmd &>out.log` and `cmd >&out.log` are the same redirect. Neither was read:
// the first was glued to the command name so no operator was ever seen, the second
// stopped parsing at `>` and handed back `&out.log` -- a file nobody wrote, on a
// card, looking exactly like a real one.
same('a glued both-stream redirect names its file', writtenPaths('cmd&>both.txt', BASE), ['F:\\work\\app\\both.txt'])
same('and the spaced spelling does the same', writtenPaths('cmd &>both.txt', BASE), ['F:\\work\\app\\both.txt'])
same('an ampersand redirect names its file, not the ampersand', writtenPaths('cmd >&out.log', BASE), ['F:\\work\\app\\out.log'])
same('a descriptor duplication still names nothing', writtenPaths('cmd 2>&1', BASE), [])
// And the whole point of splitting: a device sink before a cd must not survive
// as a file, and must not stop the cd from being seen.
same('a device sink before a boundary is still not a file', writtenPaths('echo hi > NUL; cd sub && cat > z.txt', BASE), ['F:\\work\\app\\sub\\z.txt'])
same('a noclobber redirect still names its file', writtenPaths('cat >| out.txt', BASE), ['F:\\work\\app\\out.txt'])
same('an appended noclobber redirect names its file', writtenPaths('cat >>| log.txt', BASE), ['F:\\work\\app\\log.txt'])
same('a numbered noclobber redirect names its file', writtenPaths('cat 2>| err.log', BASE), ['F:\\work\\app\\err.log'])
same('a pipe next to a word is still a pipe', writtenPaths('a|b', BASE), [])

// --------------------------------------- targets this module cannot place --
//
// The `cd` branch already refuses to guess where an unexpanded variable points.
// A write target has the same problem in the other direction: `$OUT/x.txt` is a
// file under whatever OUT holds, and joining the base to it produces
// `F:\\work\\app\\$OUT\\x.txt` -- resolved-looking, naming nothing. Same rule, same
// answer: hand it on as written.
same('a target under a variable keeps its spelling', writtenPaths('cat > $OUT/x.txt', BASE), ['$OUT/x.txt'])
same('a target under a braced variable keeps its spelling', writtenPaths('cat > ${OUT}/x.txt', BASE), ['${OUT}/x.txt'])
same('a home-relative target keeps its spelling', writtenPaths('cat > ~/notes.txt', BASE), ['~/notes.txt'])
// And the ordinary case still resolves: one unplaceable target does not make the
// whole command unreadable.
{
  const mixed = writtenPaths('cat > $OUT/a.txt 2> err.log', BASE)
  check('a variable target does not take the resolved one with it', JSON.stringify(mixed) === JSON.stringify(['$OUT/a.txt', 'F:\\work\\app\\err.log']), JSON.stringify(mixed))
}

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
