/**
 * Path spelling and heredoc scanning.
 *
 * This file used to test a shell command reader as well: which words in a
 * `bash` call name a file that will exist afterwards. That reader is gone -- the
 * card lists delivered documents now, and a delivery is a declaration rather
 * than something inferred from a command line -- so its assertions went with it
 * instead of being kept green against a module nothing calls.
 *
 * What is left is the two things still in use: `canonicalPath`, which the
 * transcript applies to every declared path, and `stripHeredocs`, which the
 * workflow command reader needs so a heredoc body is not read as commands.
 */

import { canonicalPath, stripHeredocs } from '../packages/core/lib/shellpaths.js'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) passed += 1
  else {
    failed += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
  }
}

function same(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ----------------------------------------------------------- heredocs --
check(
  'a heredoc body is dropped and the command kept',
  stripHeredocs("cat > f.md <<'EOF'\nhello\nEOF") === 'cat > f.md ',
  JSON.stringify(stripHeredocs("cat > f.md <<'EOF'\nhello\nEOF")),
)
check(
  'an unquoted marker ends the body too',
  stripHeredocs('cat > g.md <<EOF\n> inner\ntext\nEOF') === 'cat > g.md ',
  JSON.stringify(stripHeredocs('cat > g.md <<EOF\n> inner\ntext\nEOF')),
)
check(
  'an unterminated heredoc leaves nothing behind it',
  stripHeredocs('cat > h.md <<EOF\nbody without end') === 'cat > h.md ',
  JSON.stringify(stripHeredocs('cat > h.md <<EOF\nbody without end')),
)
check(
  'two heredocs in one call both go',
  stripHeredocs("a <<'A'\none\nA\nb <<'B'\ntwo\nB") === 'a b ',
  JSON.stringify(stripHeredocs("a <<'A'\none\nA\nb <<'B'\ntwo\nB")),
)
check(
  'a command with no heredoc comes back unchanged',
  stripHeredocs('git status --porcelain') === 'git status --porcelain',
  JSON.stringify(stripHeredocs('git status --porcelain')),
)
check(
  'the marker itself is not left in the output',
  stripHeredocs("x <<'END'\nbody\nEND").includes('END') === false,
  JSON.stringify(stripHeredocs("x <<'END'\nbody\nEND")),
)

// ------------------------------------------------------- canonicalPath --
// One file, one entry. `path.join` spells separators with backslashes while a
// model typing a path writes forward slashes; both name the same file, and the
// delivered list is keyed by the string, so without this the card draws two rows
// and one of them is a ghost.
same('canonicalPath folds a drive path', canonicalPath('F:/a/b.js'), 'F:\\a\\b.js')
same('canonicalPath leaves a posix path alone', canonicalPath('/home/u/a.js'), '/home/u/a.js')
same('canonicalPath is a no-op on what it has already done', canonicalPath('F:\\a\\b.js'), 'F:\\a\\b.js')
check('the same file has one spelling', canonicalPath('F:/a/b.js') === canonicalPath('F:\\a\\b.js'))
check('an empty string survives', canonicalPath('') === '')
check('a non-string survives as itself', canonicalPath(undefined) === undefined)
check('a drive root keeps its separator', canonicalPath('F:/') === 'F:\\')

console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
