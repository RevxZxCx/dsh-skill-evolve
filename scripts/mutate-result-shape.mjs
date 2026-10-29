/**
 * Mutation check for the two modules that shared the `tool/result` reading bug.
 *
 * `lib/evidence.js` and `lib/transcript.js` both read a call id from the top of
 * `data`, which no real session produces. The evidence bug was the worse of the
 * two: with the id permanently undefined, the check that drops this plugin's own
 * refusal text could never fire, so a rejected quote became quotable on retry.
 *
 * These mutations put that flat read back and expect each suite to fail.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const MUTATIONS = [
  {
    name: 'evidence reads the call id from the top of data',
    file: 'lib/evidence.js',
    from: '  const message = data?.message\n  const candidates = [message?.toolCallId, message?.source?.callId, data?.callId, data?.id]',
    to: '  const candidates = [data?.callId, data?.id]',
    suites: ['test/evidence.test.mjs']
  },
  {
    name: 'evidence ignores the echo check',
    file: 'lib/evidence.js',
    from: '      if (callId !== undefined && echoed.has(callId)) continue',
    to: '      if (false) continue',
    suites: ['test/evidence.test.mjs']
  },
  {
    // The over-filtering direction: drop every real result from the lane. Code
    // review reproduced this surviving against a flat fixture, which is what
    // makes it worth its own mutation — the guard against it has to be written
    // in the host's real shape to be a guard at all.
    name: 'evidence drops every real tool result',
    file: 'lib/evidence.js',
    from: '      if (callId !== undefined && echoed.has(callId)) continue',
    to: '      if (callId !== undefined) continue',
    suites: ['test/evidence.test.mjs']
  },
  {
    name: 'transcript reads the call id from the top of data',
    file: 'lib/transcript.js',
    from: '    const message = data?.message\n    const id = [message?.toolCallId, message?.source?.callId, data?.callId, data?.id].find(',
    to: '    const message = data?.message\n    const id = [data?.callId, data?.id].find(',
    suites: ['test/transcript.test.mjs']
  },
  {
    name: 'transcript ignores a result-level error payload',
    file: 'lib/transcript.js',
    from: 'entry.ok = message?.isError !== true && data?.isError !== true && data?.error === undefined',
    to: 'entry.ok = message?.isError !== true && data?.isError !== true',
    suites: ['test/transcript.test.mjs']
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

const files = [...new Set(MUTATIONS.map((mutation) => mutation.file))]
const originals = new Map()
for (const file of files) originals.set(file, readFileSync(file, 'utf8'))

{
  const baseline = run([...new Set(MUTATIONS.flatMap((mutation) => mutation.suites))])
  if (!baseline.ok) {
    console.error('BASELINE FAILED — suites must pass before mutations mean anything')
    console.error(baseline.text.split('\n').filter((line) => line.includes('FAIL')).slice(0, 10).join('\n'))
    process.exit(1)
  }
  console.log('baseline: suites pass')
}

let killed = 0
let survived = 0
let notApplied = 0

try {
  for (const mutation of MUTATIONS) {
    const original = originals.get(mutation.file)
    if (!original.includes(mutation.from)) {
      notApplied += 1
      console.error(`NOT APPLIED  ${mutation.name} — anchor not found`)
      continue
    }
    const mutated = original.replace(mutation.from, mutation.to)
    if (mutated === original) {
      notApplied += 1
      console.error(`NOT APPLIED  ${mutation.name} — replacement changed nothing`)
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
  console.log('restored: originals written back from memory')
}

console.log(`\n${killed} killed, ${survived} survived, ${notApplied} not applied`)
if (survived > 0 || notApplied > 0) process.exitCode = 1
