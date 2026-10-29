/**
 * Mutation check for the observation window.
 *
 * A passing test proves the code does what the test says; it does not prove the
 * test would notice the code doing something else. Each mutation below breaks
 * one specific promise the feature makes, runs the two outcome suites, and
 * expects a failure. A mutation that survives means the promise is untested.
 *
 * Restoration is in-memory: the original text is kept in this process and
 * written back in a `finally`. Never `git checkout` here — an uncommitted
 * working tree is the normal state while iterating, and discarding it would
 * destroy work that has nothing to do with this script.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const LIB = 'lib/outcome.js'
const WIRING = 'lib/index.js'

/**
 * One mutation: a promise, the text that breaks it, and the suites to run.
 */
const MUTATIONS = [
  {
    name: 'an empty window reports success',
    file: LIB,
    from: "if (this.calls === 0 && this.failures === 0) return 'unobserved'",
    to: "if (this.calls === 0 && this.failures === 0) return 'no-error'",
    suites: ['test/outcome.test.mjs', 'test/outcome-wiring.test.mjs']
  },
  {
    name: 'a retry is reported as a bare error',
    file: LIB,
    from: "if (this.retries > 0) return 'retried'",
    to: "if (this.retries > 0) return 'errors'",
    suites: ['test/outcome.test.mjs', 'test/outcome-wiring.test.mjs']
  },
  {
    name: 'an unattributed failure is called unobserved',
    file: LIB,
    from: 'if (this.calls === 0 && this.failures === 0) return',
    to: 'if (this.calls === 0) return',
    suites: ['test/outcome.test.mjs', 'test/outcome-wiring.test.mjs']
  },
  {
    name: 'a failed tool is not named',
    file: LIB,
    from: 'this.known.add(name)',
    to: 'void name',
    suites: ['test/outcome.test.mjs', 'test/outcome-wiring.test.mjs']
  },
  {
    name: 'the pending call map is unbounded',
    file: LIB,
    from: 'if (this.pending.size >= MAX_TRACKED_CALLS) {',
    to: 'if (false) {',
    suites: ['test/outcome.test.mjs']
  },
  {
    name: 'the failed tool list is unbounded',
    file: LIB,
    from: 'if (this.failedTools.length < MAX_FAILED_TOOLS && !this.failedTools.includes(name)) {',
    to: 'if (!this.failedTools.includes(name)) {',
    suites: ['test/outcome.test.mjs']
  },
  {
    name: 'an abandoned turn does not consume the budget',
    file: LIB,
    from: 'this.remaining -= 1',
    to: 'this.remaining -= reason?.kind === "completed" ? 1 : 0',
    suites: ['test/outcome.test.mjs', 'test/outcome-wiring.test.mjs']
  },
  {
    name: 'loading a second skill drops the first window',
    file: LIB,
    from: 'const displaced = this.close(input.agentId, input.at)',
    to: 'void 0',
    suites: ['test/outcome.test.mjs', 'test/outcome-wiring.test.mjs']
  },
  {
    // The first version of this mutation deleted the window and then set an
    // unused field, which changed no observable behaviour — an equivalent
    // mutation, not an unkilled one. This version leaves the window reachable.
    name: 'forget leaves the window open',
    file: LIB,
    from: 'forget(agentId) {\n    this.open.delete(agentId)\n  }',
    to: 'forget(agentId) {\n    void agentId\n  }',
    suites: ['test/outcome.test.mjs', 'test/outcome-wiring.test.mjs']
  },
  {
    name: 'the window is not opened on a load',
    file: WIRING,
    from: 'const displaced = outcomes.begin({',
    to: 'const displaced = undefined; void ({',
    suites: ['test/outcome-wiring.test.mjs']
  },
  {
    name: 'the window is not fed from the event stream',
    file: WIRING,
    from: 'const closed = outcomes.record(agentId, event)',
    to: 'const closed = []',
    suites: ['test/outcome-wiring.test.mjs']
  },
  {
    name: 'the closed window is not written',
    file: WIRING,
    from: 'if (closed.length > 0) return recordOutcome(closed[0])',
    to: 'if (closed.length > 0) return undefined',
    suites: ['test/outcome-wiring.test.mjs']
  },
  {
    name: 'disposal leaves the window open',
    file: WIRING,
    from: 'outcomes.forget(agentId)',
    to: 'void agentId',
    suites: ['test/outcome-wiring.test.mjs']
  },
  {
    name: 'a foreign skill is observed too',
    file: WIRING,
    from: 'if (parsed === undefined || !parsed.owned) return',
    to: 'if (parsed === undefined) return',
    suites: ['test/outcome-wiring.test.mjs']
  },
  {
    name: 'outcomeTurns: 0 still observes',
    file: WIRING,
    from: "if (typeof input.agentId === 'string' && config.outcomeTurns > 0) {",
    to: "if (typeof input.agentId === 'string') {",
    suites: ['test/outcome-wiring.test.mjs']
  },
  {
    // The exact defect code review found: the result is nested in
    // `data.message`, and reading the top of `data` makes every retry
    // invisible while turning real failures into `no-error`.
    name: 'the result is read from the top of data',
    file: LIB,
    from: '        callId: message?.toolCallId ?? message?.source?.callId ?? data?.callId ?? data?.id,\n        isError: message?.isError ?? data?.isError,',
    to: '        callId: data?.callId ?? data?.id,\n        isError: data?.isError,',
    suites: ['test/outcome.test.mjs', 'test/outcome-wiring.test.mjs']
  },
  {
    name: 'the system actor is recorded as the model',    file: WIRING,
    from: "actor: 'system',",
    to: "actor: 'model',",
    suites: ['test/outcome-wiring.test.mjs']
  }
]

function run(suites) {
  let text = ''
  let ok = true
  for (const suite of suites) {
    try {
      text += execFileSync(process.execPath, [suite], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      ok = false
      text += `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
  }
  return { ok, text }
}

const originals = new Map()
for (const file of [LIB, WIRING]) originals.set(file, readFileSync(file, 'utf8'))

// The baseline must pass, or every "killed" result below would be meaningless.
{
  const baseline = run(['test/outcome.test.mjs', 'test/outcome-wiring.test.mjs'])
  if (!baseline.ok) {
    console.error('BASELINE FAILED — the suites must pass before mutations mean anything')
    console.error(baseline.text.split('\n').filter((line) => line.includes('FAIL')).slice(0, 10).join('\n'))
    process.exit(1)
  }
  console.log('baseline: both suites pass')
}

let killed = 0
let survived = 0
let notApplied = 0

try {
  for (const mutation of MUTATIONS) {
    const original = originals.get(mutation.file)
    if (!original.includes(mutation.from)) {
      notApplied += 1
      console.error(`NOT APPLIED  ${mutation.name} — anchor not found in ${mutation.file}`)
      continue
    }
    // Anchor uniqueness matters: replacing the first of several occurrences
    // would mutate something other than the line the test claims to cover.
    const occurrences = original.split(mutation.from).length - 1
    if (occurrences > 1) {
      console.error(`  note: "${mutation.name}" anchor appears ${occurrences}× — replacing the first only`)
    }
    const mutated = original.replace(mutation.from, mutation.to)
    if (mutated === original) {
      notApplied += 1
      console.error(`NOT APPLIED  ${mutation.name} — the replacement changed nothing`)
      continue
    }
    writeFileSync(mutation.file, mutated)
    const result = run(mutation.suites)
    writeFileSync(mutation.file, original)
    if (result.ok) {
      survived += 1
      console.error(`SURVIVED     ${mutation.name}`)
    } else {
      killed += 1
      const first = result.text.split('\n').find((line) => line.includes('FAIL')) ?? '(no FAIL line)'
      console.log(`KILLED       ${mutation.name}\n               ${first.trim()}`)
    }
  }
} finally {
  for (const [file, text] of originals) writeFileSync(file, text)
  console.log('restored: both files written back from memory')
}

console.log(`\n${killed} killed, ${survived} survived, ${notApplied} not applied`)
if (survived > 0 || notApplied > 0) process.exitCode = 1
