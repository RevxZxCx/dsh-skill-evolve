/**
 * Command signature tests.
 *
 * The interesting cases here are the ones a naive `command.split(' ')[0]`
 * gets wrong: heredocs full of program text, inline scripts, runner wrappers,
 * and windows where the same command repeats.
 */

import { signatureOf, stepsFor, stripHeredocs, SHELL_TOOLS } from '../lib/command.js'
import { createDetector } from '../lib/signal.js'

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

// ---------------------------------------------------------------- basics --
same('git subcommand kept', signatureOf('git commit -m "x"'), ['git commit'])
same('git subcommand differs', signatureOf('git diff --stat'), ['git diff'])
same('package manager verb', signatureOf('pnpm test'), ['pkg test'])
same('npm and pnpm collapse', signatureOf('npm run build'), ['pkg run'])
same('compound command splits', signatureOf('cd /f/bot && pnpm test && git diff --stat'), ['pkg test', 'git diff'])
same('semicolon splits', signatureOf('pnpm build; git status'), ['pkg build', 'git status'])
same('pipe is not a split point', signatureOf('grep -r foo src | head -5'), ['search'])
same('semicolon inside quotes still splits', signatureOf('echo "a;b"'), [])
same('noise commands drop out', signatureOf('cd /tmp && echo hi && sleep 1'), [])
same('empty input', signatureOf(''), [])
same('undefined input', signatureOf(undefined), [])

// ------------------------------------------------------------- wrapping --
same('npx unwraps to its target', signatureOf('npx tsc --noEmit'), ['build'])
same('path command keeps its name', signatureOf('./gradlew :app:test'), ['build'])
same('absolute path command', signatureOf('F:/Android/Sdk/platform-tools/adb.exe exec-out screencap -p'), ['adb exec-out'])
same('windows extension stripped', signatureOf('powershell.exe -Command Get-Process'), ['pwsh get-process'])
same('subshell unwraps', signatureOf('(git status)'), ['git status'])
same('env assignment unwraps', signatureOf('FOO=1 node app.js'), ['node'])

// --------------------------------------------------------------- opaque --
same('interpreter is one step', signatureOf('python analyze.py --input a.csv'), ['py'])
same('node script is one step', signatureOf('node -e "console.log(1)"'), ['node'])
same('interpreter in a chain', signatureOf('pnpm build && python gen.py && cp out.txt dist/'), ['pkg build', 'py', 'copy'])

// -------------------------------------------------------------- heredocs --
check('heredoc body stripped', stripHeredocs('cat <<EOF\nline1\nline2\nEOF\nafter').includes('after'))
check('heredoc body gone', !stripHeredocs('cat <<EOF\nline1\nEOF').includes('line1'))
same('heredoc yields no bogus steps', signatureOf('python x.py <<EOF\nprint(1)\nEOF'), ['py'])
same('js heredoc yields no syntax steps', signatureOf('node <<EOF\nconst a = 1\nconsole.log(a)\nEOF'), ['node'])
// An unterminated heredoc swallows the body, but the command before it still
// ran — `cat` here really does read, it just reads from stdin.
same('unterminated heredoc keeps the command', signatureOf('cat <<EOF\nstill body'), ['read'])
same('unterminated heredoc leaves no body labels', signatureOf('node <<EOF\nconst a = 1'), ['node'])

// ---------------------------------------------------------- inline scripts --
same('inline loop header dropped', signatureOf('for f in *.js; do node $f; done'), ['node'])
same('inline js body is not a step', signatureOf('for (const n of ns) { console.log(n) }'), [])
same('syntax word never becomes a step', signatureOf('await send()'), [])
same('comment skipped', signatureOf('# just a note'), [])

// ------------------------------------------------------------- stepsFor --
check('shell tool set has bash', SHELL_TOOLS.has('bash'))
same('structured tool passes through', stepsFor('read', '{"file_path":"a.js"}'), ['read'])
same('shell call expands', stepsFor('bash', '{"command":"pnpm test"}'), ['pkg test'])
same('script field accepted', stepsFor('bash', '{"script":"pnpm build"}'), ['pkg build'])
same('input field accepted', stepsFor('pwsh', '{"input":"git status"}'), ['git status'])
same('unparsable arguments fall back to the tool', stepsFor('bash', 'not json'), ['bash'])
same('missing command falls back to the tool', stepsFor('bash', '{}'), ['bash'])
same('object arguments accepted', stepsFor('bash', { command: 'git status' }), ['git status'])
same('pure glue records nothing', stepsFor('bash', '{"command":"cd /tmp && echo hi"}'), [])

// The regression that matters: a screenshot workflow must become visible
// even though every call is `bash`.
{
  const calls = []
  for (let i = 0; i < 3; i += 1) {
    calls.push({ name: 'bash', arguments: '{"command":"adb exec-out screencap -p > s.png"}' })
    calls.push({ name: 'bash', arguments: '{"command":"python parse_ui.py s.png"}' })
    calls.push({ name: 'read_image', arguments: '{"file_path":"s.png"}' })
  }
  const detector = createDetector({ minRepeatCount: 3, minWindow: 3, repeatWindowMax: 6 })
  for (const call of calls) for (const step of stepsFor(call.name, call.arguments)) detector.record(step)
  const found = detector.detect()
  check('screenshot workflow detected', found.length > 0)
  same('screenshot workflow shape', found[0]?.steps, ['adb exec-out', 'py', 'read_image'])
  check('screenshot workflow counted three times', found[0]?.occurrences === 3, `got ${found[0]?.occurrences}`)
}

// With the feature off, the same traffic is invisible — this is the bug the
// command signature fixes, kept as an assertion so nobody reintroduces it.
{
  const detector = createDetector({ minRepeatCount: 3, minWindow: 3, repeatWindowMax: 6 })
  for (let i = 0; i < 3; i += 1) {
    detector.record('bash')
    detector.record('bash')
    detector.record('read_image')
  }
  check('name-level detection misses it', detector.detect().length === 0)
}

// ---------------------------------------------------------------- noise --
{
  // A long real-ish shell workload must not bury the detector in hints.
  const noisy = [
    'cd /f/bot && git status --short',
    'ls -la',
    'cat README.md | head -40',
    'grep -rn "TODO" src | head',
    'pnpm build',
    'pnpm test',
    'git diff --stat',
    'git add -A',
    'git commit -m "wip"'
  ]
  const labels = noisy.flatMap((command) => signatureOf(command))
  check('noise stays bounded', labels.length <= noisy.length, `got ${labels.length} labels from ${noisy.length} commands`)
  check('no code fragments leaked', labels.every((label) => !/[{}()=]/.test(label)), JSON.stringify(labels))
  check('no empty labels', labels.every((label) => label.length > 0), JSON.stringify(labels))
}

console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
