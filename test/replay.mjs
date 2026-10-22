/**
 * Replay the procedure detector over a real session transcript.
 *
 * The synthetic tests in `signal.test.mjs` prove the rules do what the spec
 * says. They cannot answer the question that decides whether this plugin is
 * worth shipping: on a real conversation, does the detector fire a handful of
 * times or does it bury the model in noise?
 *
 * Usage: `node test/replay.mjs <session_dump.jsonl>`
 *
 * The dump is the plaintext JSONL produced by decompressing a real
 * `session.v4.jsonl.zstd`; each line is one session event.
 */

import { readFileSync } from 'node:fs'
import { createDetector, renderSteps } from '../lib/signal.js'
import { HintChannel } from '../lib/hint.js'

const path = process.argv[2] ?? 'F:/dsh-plugin/.research/session_dump.jsonl'
const maxHintsPerSession = Number(process.argv[3] ?? 4)

const lines = readFileSync(path, 'utf8').trim().split('\n')
const detector = createDetector({ minRepeatCount: 2, minWindow: 3, repeatWindowMax: 6 })

/** Tool calls in the order the host emitted them. */
const calls = []
for (const line of lines) {
  const event = JSON.parse(line)
  if (event.type !== 'tool/call') continue
  const name = event?.data?.name
  if (typeof name !== 'string') continue
  calls.push({ name, turn: event?.data?.turn, step: event?.data?.step })
}

console.log(`events:   ${lines.length}`)
console.log(`tool calls: ${calls.length}`)

/** Every hint this replay would have published. */
const published = []
// Drive the real channel rather than a stand-in Set: the dedupe rules live
// there (a workflow is not re-announced in a longer shape two calls later),
// and a replay that reimplements them can disagree with the shipped code.
const hints = new HintChannel({ maxHintsPerSession, log: () => {} })
for (const [index, call] of calls.entries()) {
  detector.record(call.name)
  const fresh = detector.detect().filter((procedure) => !hints.alreadyShown('replay', procedure.steps))
  const [primary] = fresh
  if (primary === undefined) continue
  const outcome = hints.publish({ agentId: 'replay', signature: primary.signature, steps: primary.steps, text: 'x' })
  if (outcome !== 'published') continue
  published.push({
    atCall: index + 1,
    turn: call.turn,
    steps: primary.steps,
    width: primary.width,
    occurrences: primary.occurrences,
    coverage: primary.coverage,
    observerRatio: primary.observerRatio
  })
}

const windowMinutes = (() => {
  const times = lines.map((line) => JSON.parse(line).time).filter((time) => typeof time === 'number')
  if (times.length < 2) return 0
  return Math.round((Math.max(...times) - Math.min(...times)) / 60000)
})()

console.log(`\nsession span: ${windowMinutes} min`)
console.log(`hints published: ${published.length} (cap ${maxHintsPerSession})`)
console.log(`calls per hint: ${published.length === 0 ? 'n/a' : Math.round(calls.length / published.length)}\n`)

for (const hint of published) {
  const share = Math.round((hint.coverage / calls.length) * 100)
  console.log(`after call ${String(hint.atCall).padStart(3)} (turn ${hint.turn}): ${renderSteps(hint.steps)}`)
  console.log(`  ${hint.occurrences}× · explains ${hint.coverage} calls = ${share}% of the session · observer ratio ${hint.observerRatio.toFixed(2)}`)
}

/** Distribution of tool names, to sanity-check what the detector is seeing. */
const counts = new Map()
for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
console.log(`\ntool mix: ${ranked.slice(0, 8).map(([name, count]) => `${name} ${count}`).join(', ')}`)

/** Whether the whole session was covered by the detector's memory window. */
console.log(`\nfinal history size: ${detector.size()} (bounded)`)
