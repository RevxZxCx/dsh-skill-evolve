/**
 * Compare name-level detection against command-level detection on real traffic.
 *
 * This is the measurement that decides whether the command signature ships. It
 * replays the same transcript twice — once recording bare tool names, once
 * expanding shell calls into their commands — and reports what the user would
 * actually see: how many hints get *published*, not how many procedures the raw
 * detector can enumerate.
 *
 * That distinction matters. `detect()` returns every procedure-shaped window it
 * can find, including rotations and truncations of one cycle; the hint channel's
 * dedup is what turns those into a handful of announcements. Counting raw
 * `detect()` output overstates noise by an order of magnitude and was the source
 * of a wrong conclusion on the first run.
 *
 * Usage: `node test/replay-commands.mjs <dump.jsonl> [threshold...]`
 */

import { readFileSync } from 'node:fs'
import { createDetector } from '../lib/signal.js'
import { stepsFor } from '../lib/command.js'
import { HintChannel } from '../lib/hint.js'

const path = process.argv[2]
if (path === undefined) {
  console.error('usage: node test/replay-commands.mjs <dump.jsonl> [threshold...]')
  process.exit(1)
}
const thresholds = process.argv.slice(3).map(Number)
const counts = thresholds.length > 0 ? thresholds : [2, 3, 4]
const MAX_HINTS = Number(process.env.MAX_HINTS ?? 4)

const events = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const calls = []
for (const event of events) {
  if (event?.type !== 'tool/call') continue
  const name = event?.data?.name
  if (typeof name !== 'string') continue
  calls.push({ name, arguments: event?.data?.arguments })
}

/**
 * Replay one transcript and report published hints.
 *
 * @param {boolean} expand - expand shell calls into commands.
 * @param {number} minRepeatCount - repetition threshold under test.
 * @returns {{published: string[], suppressed: number}} what the user would see.
 */
function replay(expand, minRepeatCount) {
  const detector = createDetector({ minRepeatCount, minWindow: 3, repeatWindowMax: 6 })
  const hints = new HintChannel({ maxHintsPerSession: MAX_HINTS })
  const published = []
  let suppressed = 0
  const agentId = 'replay'

  for (const call of calls) {
    const steps = expand ? stepsFor(call.name, call.arguments) : [call.name]
    if (steps.length === 0) continue
    for (const step of steps) detector.record(step)

    const fresh = detector.detect().filter((procedure) => !hints.alreadyShown(agentId, procedure.steps))
    if (fresh.length === 0) continue
    const [primary] = fresh
    const outcome = hints.publish({
      agentId,
      signature: primary.signature,
      steps: primary.steps,
      text: ''
    })
    if (outcome === 'published') published.push(primary.steps.join(' > '))
    else suppressed += 1
  }
  return { published, suppressed }
}

console.log(`transcript: ${path}`)
console.log(`tool calls: ${calls.length}   hint budget: ${MAX_HINTS}\n`)

for (const threshold of counts) {
  const names = replay(false, threshold)
  const commands = replay(true, threshold)
  console.log(`minRepeatCount ${threshold}`)
  console.log(`  tool names     : ${names.published.length} published (${names.suppressed} suppressed)`)
  for (const shape of names.published) console.log(`      ${shape}`)
  console.log(`  command labels : ${commands.published.length} published (${commands.suppressed} suppressed)`)
  for (const shape of commands.published) console.log(`      ${shape}`)
  console.log()
}
