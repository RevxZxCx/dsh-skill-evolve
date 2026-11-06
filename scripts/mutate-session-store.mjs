// Prove the session-state guards actually guard something.
//
// This module is where the panel's remembered state touches the filesystem, so
// its guards are the kind that fail silently rather than loudly: an unvalidated
// session id becomes a path, a version check that stopped checking reads a shape
// nobody wrote, and a prune that treats "the host did not answer" as "they are
// all gone" deletes every file the panel has. None of those throw. A suite that
// merely runs the happy path stays green through all of them, which is why each
// guard below is broken on purpose to see whether an assertion notices.
//
// Two failure modes have burned this repo's mutation scripts before, and both
// are handled here:
//
//   * An anchor that no longer matches. String.replace silently returns the input
//     unchanged, so the mutation never happened while the suite still passed, and
//     the run reports SURVIVED — which reads as "no test covers this" when the
//     truth is "nothing was tested at all". A non-match is therefore fatal and
//     its own outcome.
//   * A suite that crashes rather than failing. The tally line is printed only on
//     a clean path, so a crash yields no `FAIL` rows and used to be counted as a
//     surviving mutation. Failures are counted from the tally here, and a missing
//     tally is reported as a crash rather than folded into either answer.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const target = path.join(repo, 'packages', 'ui-evolve', 'lib', 'session-store.js')
const original = fs.readFileSync(target, 'utf8')

function failures(output) {
  const match = /(\d+) passed, (\d+) failed/.exec(output)
  return match === null ? -1 : Number(match[2])
}

function run() {
  try {
    return execFileSync('node', ['test/session-store.test.mjs'], { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    return (error.stdout ?? '') + (error.stderr ?? '')
  }
}

const mutations = [
  {
    label: 'an id reaches a path join unchecked',
    from: "if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return undefined",
    to: "if (typeof sessionId !== 'string') return undefined",
    why: 'a session id arrives from an event payload; `..` would write outside the directory',
  },
  {
    label: 'a file from another version is believed anyway',
    from: "if (value.version !== VERSION) return { kind: 'foreign' }",
    to: "if (false) return { kind: 'foreign' }",
    why: 'an older or newer shape would be read as if its fields meant what they say now',
  },
  {
    label: 'a file that names another session is believed anyway',
    from: "if (value.session !== sessionId) return { kind: 'foreign' }",
    to: "if (false) return { kind: 'foreign' }",
    why: 'the file name is the identity; two panels would show each other’s work',
  },
  {
    label: 'a file that is not a record is believed anyway',
    from: "    if (!isRecord(value)) return { kind: 'foreign' }",
    to: "    if (false) return { kind: 'foreign' }",
    why: 'a missing or null file would be read past the guard and throw at the panel',
  },
  {
    label: 'a host that faults is read as a session that is gone',
    from:
      "          this.log('session state: keeping everything, the host could not answer', error?.message ?? error)\n          return removed",
    to: "          this.log('session state: keeping everything, the host could not answer', error?.message ?? error)\n          alive = false",
    why: 'the host contract propagates storage faults; carrying on would delete every remaining file',
  },
  {
    label: 'the oldest files are the ones kept',
    from: 'dated.sort((a, b) => a.at - b.at)',
    to: 'dated.sort((a, b) => b.at - a.at)',
    why: 'the cap is meant to drop the conversations least likely to be reopened',
  },
  {
    label: 'the prune interval is ignored',
    from: 'if (this.prunedAt !== 0 && now - this.prunedAt < intervalMs) {',
    to: 'if (this.prunedAt !== 0 && now - this.prunedAt < intervalMs && false) {',
    why: 'the panel polls; a directory listing per poll is the cost the interval avoids',
  },
  {
    label: 'pruning with no host answer deletes everything',
    from: '      if (archived !== undefined && archived.has(id)) {',
    to: '      if (archived === undefined || archived.has(id)) {',
    why: 'with no sources the archive set is undefined, and deleting on that guess takes every file',
  },
  {
    label: 'a failed write is thrown at the panel',
    from: "      this.log('session state: could not write', sessionId, error?.message ?? error)",
    to: '      throw error',
    why: 'a disk problem must cost one log line, not the panel that is drawing from memory',
  },
  {
    label: 'the temp file is never published',
    from: '  await rename(temporary, path)',
    to: '  await rename(temporary, `${path}.never`)',
    why: 'without the rename the new state is written and then left unreadable',
  },
  {
    label: 'the trailing newline is dropped',
    from: "await writeFile(temporary, `${JSON.stringify(value)}\\n`, 'utf8')",
    to: "await writeFile(temporary, JSON.stringify(value), 'utf8')",
    why: 'the file is a line of JSON; a missing newline makes it not a line',
  },
  {
    label: 'an archived session keeps its file',
    from: '      if (archived !== undefined && archived.has(id)) {',
    to: '      if (false) {',
    why: 'archiving is the one signal that has nothing to do with the session being gone',
  },
  {
    label: 'a deleted session keeps its file',
    from: '        if (alive === false) {',
    to: '        if (false) {',
    why: 'the host’s own "does this session exist" test is the official answer',
  },
  {
    label: 'the cap is ignored',
    from: '    if (excess > 0) {',
    to: '    if (false) {',
    why: 'an uncapped directory grows with every conversation ever held',
  },
  {
    label: 'forgetting is not targeted',
    from: '    await unlink(path)',
    to: '    await unlink(this.root)',
    why: 'forget must drop one session, not the directory',
  },
]

let killed = 0
const survived = []
const notApplied = []
const crashed = []

try {
  for (const mutation of mutations) {
    if (original.split(mutation.from).length - 1 !== 1) {
      notApplied.push(mutation.label)
      continue
    }
    fs.writeFileSync(target, original.replace(mutation.from, mutation.to), 'utf8')
    const output = run()
    const failed = failures(output)
    if (failed > 0) {
      killed += 1
      console.log(`KILLED      ${mutation.label}  (${failed} failed)`)
    } else if (failed === 0) {
      survived.push(mutation.label)
      console.log(`SURVIVED    ${mutation.label}`)
    } else {
      crashed.push(mutation.label)
      console.log(`CRASHED     ${mutation.label}`)
    }
  }
} finally {
  // Unconditional, because the moment this script is holding a mutated file is
  // exactly the moment an interrupt is most likely. The alternatives — a `&&`
  // chain, or restoring only on the success path — have both left a mutated file
  // on disk in this repo before.
  fs.writeFileSync(target, original, 'utf8')
}

for (const mutation of mutations) {
  if (notApplied.includes(mutation.label)) console.log(`\nANCHOR MISSING  ${mutation.label}\n  ${mutation.why}`)
  if (survived.includes(mutation.label)) console.log(`\nUNCOVERED       ${mutation.label}\n  ${mutation.why}`)
  if (crashed.includes(mutation.label)) console.log(`\nCRASHED         ${mutation.label}\n  ${mutation.why}`)
}

const total = mutations.length
console.log(`\n${killed} killed, ${survived.length} survived, ${notApplied.length} not applied, ${crashed.length} crashed  (of ${total})`)
if (survived.length > 0 || notApplied.length > 0 || crashed.length > 0) process.exit(1)
