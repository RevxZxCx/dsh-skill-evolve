// Prove the checklist assertions can fail.
//
// Each mutation is applied to an in-memory copy, the relevant suites are run, and
// the file is restored from the bytes that were on disk. `git checkout` is never
// used: an earlier review lost a whole round of uncommitted work that way.
//
// Two things in this script exist because they bit me:
//   * anchors are written with LF, so both sides are normalised before matching
//     and each file's own endings are put back afterwards. The tree is all-LF
//     today, but a checkout with core.autocrlf on is not.
//   * a mutation whose anchor does not match is reported as NOT APPLIED and counts
//     as a failure. Otherwise "survived" (a real coverage gap) and "never ran"
//     (a broken script) look identical in the output.

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file, not hard-coded: a fixed path makes the script patch one
// checkout while running another checkout's tests, which reports a genuinely
// killed mutation as SURVIVED.
const repo = fileURLToPath(new URL('..', import.meta.url))

const mutations = [
  {
    label: 'a staged approval deletes its row anyway',
    file: 'lib/client.js',
    from: 'if (outcome?.staged === true) {',
    to: 'if (false) {',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'deciding a row filters by name instead of id',
    file: 'lib/client.js',
    from: 'list: previous.list.filter((row) => row.id !== id),',
    to: 'list: previous.list.filter((row) => row.name !== name),',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the decide request forgets the session',
    file: 'lib/client.js',
    from: "const path = props.sessionId === undefined ? '/candidates' : `/candidates?agent=${encodeURIComponent(props.sessionId)}`",
    to: "const path = '/candidates'",
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the hover grace period collapses to nothing',
    file: 'lib/client.js',
    from: 'const CLOSE_GRACE_MS = 220',
    to: 'const CLOSE_GRACE_MS = 0',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'entering the list no longer cancels the close',
    file: 'lib/client.js',
    from: 'onMouseEnter: cancelClose',
    to: 'onMouseEnter: () => {}',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the trigger stops announcing the list it opens',
    file: 'lib/client.js',
    from: "return React.cloneElement(child, { 'aria-haspopup': 'dialog', 'aria-expanded': true })",
    to: 'return child',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a stale row becomes approvable again',
    file: 'lib/client.js',
    from: "disabled: busy !== '' || row.stale !== undefined",
    to: "disabled: busy !== ''",
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the decide route accepts any content type',
    file: 'lib/api.js',
    from: 'if (declaredType.length > 0 && !isJson) {',
    to: 'if (false) {',
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'a nameless decision is allowed through',
    file: 'lib/api.js',
    from: 'if (name.length === 0 && id === undefined) {',
    to: 'if (false) {',
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'the description is sent untruncated',
    file: 'lib/api.js',
    from: 'description: clampText(row.description, 160),',
    to: "description: String(row.description ?? ''),",
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'the body is sent untruncated',
    file: 'lib/api.js',
    from: 'body: clampText(row.body, 4000),',
    to: "body: String(row.body ?? ''),",
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'the evidence list stops being capped',
    file: 'lib/api.js',
    from: '? row.evidence.slice(0, 6).map((entry) => ({',
    to: '? row.evidence.map((entry) => ({',
    suites: ['test/api.test.mjs'],
  },
  {
    // The list body scrolls whenever there are more candidates than fit, so a
    // capture-phase handler that does not check where the scroll came from closes
    // the card the moment somebody scrolls to the eighth candidate.
    label: 'a scroll inside the card closes it',
    file: 'lib/client.js',
    from: "if (inside !== null && typeof inside?.closest === 'function' && inside.closest('.dsse-ck, .dsse-ck-detail') !== null) return",
    to: 'if (false) return',
    suites: ['test/client.test.mjs'],
  },
  {
    // A row's approve button is a real <button>, so pressing it fires focusout.
    // Closing on that hides the confirm-mode notice exactly when it matters.
    label: 'moving focus inside the card closes it',
    file: 'lib/client.js',
    from: "if (next !== null && next !== undefined && held !== null && typeof held?.contains === 'function' && held.contains(next)) return",
    to: 'if (false) return',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the decide request forgets which row it came from',
    file: 'lib/client.js',
    from: 'body: JSON.stringify({ id, name, action }),',
    to: 'body: JSON.stringify({ name, action }),',
    suites: ['test/client.test.mjs'],
  },
  {
    // Two candidates can share a name, and `findByName` prefers the live one, so
    // dropping the id lookup makes a discard aimed at a stale row hit its twin.
    label: 'the decision resolves by name and ignores the id',
    file: 'lib/index.js',
    from: [
      '    return queue.find((entry) => entry.id === id)',
      '  }',
      '  return findByName(queue, name)',
    ].join('\n'),
    to: [
      '    const exact = queue.find((entry) => entry.id === id)',
      '    if (exact !== undefined) return exact',
      '  }',
      '  return findByName(queue, name)',
    ].join('\n'),
    suites: ['test/review-fixes.test.mjs'],
  },
]

function failures(output) {
  return output.split('\n').filter((line) => line.trimStart().startsWith('FAIL ')).length
}

function run(files) {
  let total = 0
  const detail = []
  for (const file of files) {
    let output = ''
    try {
      output = execFileSync(process.execPath, [join(repo, file)], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
    const count = failures(output)
    total += count
    if (count > 0) detail.push(`${file}: ${count}`)
  }
  return { total, detail: detail.join(' ') }
}

let killed = 0
let survived = 0
let failed = 0
const notes = []

for (const mutation of mutations) {
  const path = join(repo, mutation.file)
  const onDisk = readFileSync(path, 'utf8')
  const windows = onDisk.includes('\r\n')
  const original = windows ? onDisk.split('\r\n').join('\n') : onDisk
  if (original.includes(mutation.from) === false) {
    notes.push(`NOT APPLIED  ${mutation.label} — anchor not found in ${mutation.file}`)
    failed += 1
    continue
  }
  const mutated = original.split(mutation.from).join(mutation.to)
  if (mutated === original) {
    notes.push(`NOT APPLIED  ${mutation.label} — replacement produced identical text`)
    failed += 1
    continue
  }
  try {
    writeFileSync(path, windows ? mutated.split('\n').join('\r\n') : mutated, 'utf8')
    const result = run(mutation.suites)
    if (result.total > 0) {
      killed += 1
      notes.push(`KILLED       ${mutation.label} — ${result.detail}`)
    } else {
      survived += 1
      notes.push(`SURVIVED     ${mutation.label}`)
    }
  } finally {
    writeFileSync(path, onDisk, 'utf8')
  }
}

for (const note of notes) console.log(note)
console.log(`\n${killed} killed, ${survived} survived, ${failed} not applied`)
process.exit(survived === 0 && failed === 0 ? 0 : 1)
