/**
 * Mutation tests for the live stream.
 *
 * `test/live.test.mjs` proves the hub and the route behave; `persistence.test.mjs`
 * proves the *join* — which host events are allowed to become a notification.
 * What neither can prove on its own is that either suite would notice if the
 * behaviour were removed, so this script breaks the stream one deliberate way at
 * a time and requires a red test for each.
 *
 * Every mutation below is expected to turn a test red. When one does not, that is
 * reported as SURVIVED together with the argument its `why` makes, so a coverage
 * gap stays visible instead of being quietly renamed an equivalent.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Resolved from this script, never from the caller's cwd: a hard-coded path lets
// one checkout patch a file while another checkout's tests run, which reports a
// killed mutation as survived.
const repo = fileURLToPath(new URL('..', import.meta.url))

const TARGETS = {
  hub: path.join(repo, 'packages', 'ui-evolve', 'lib', 'live.js'),
  api: path.join(repo, 'packages', 'ui-evolve', 'lib', 'api.js'),
  host: path.join(repo, 'packages', 'ui-evolve', 'lib', 'index.js'),
  store: path.join(repo, 'packages', 'ui-evolve', 'lib', 'transcript.js'),
  view: path.join(repo, 'packages', 'ui-evolve', 'lib', 'client.js')
}

/**
 * Count the failures a test run admitted to.
 *
 * The suites print one `FAIL ...` line per failure and one tally line. Reading
 * the tally is the only way to tell "passed" from "crashed before it could
 * report": a run that throws prints no FAIL lines at all, and counting FAIL
 * lines alone would record that as a surviving mutation. `-1` means the tally
 * was never reached, which is its own outcome.
 *
 * @param {string} output - the combined stdout and stderr of one run.
 * @returns {number} the failure count, or -1 when the run did not finish.
 */
function failures(output) {
  const match = /(\d+) passed, (\d+) failed/.exec(output)
  if (match === null) return -1
  return Number(match[2])
}

/** @returns {{failed: number, output: string}} the outcome of one test file. */
function run(file) {
  try {
    const output = execFileSync('node', [file], { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
    return { failed: failures(output), output }
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    return { failed: failures(output), output }
  }
}

/**
 * Apply one mutation, run the suite, and put the file back.
 *
 * The restore is in a `finally` so a throwing test cannot leave the tree
 * mutated — the one failure mode that turns a later, unrelated debugging
 * session into a hunt for a change nobody made.
 */
function attempt(target, mutation, original) {
  fs.writeFileSync(target, original.replace(mutation.from, mutation.to), 'utf8')
  try {
    return run(mutation.file)
  } finally {
    fs.writeFileSync(target, original, 'utf8')
  }
}

const mutations = [
  // ---------------------------------------------------------------- the hub --
  {
    label: 'a subscription with no session is accepted',
    file: 'test/live.test.mjs',
    target: 'hub',
    from: `    if (typeof agentId !== 'string' || agentId.length === 0) return () => {}`,
    to: `    if (typeof agentId !== 'string') return () => {}`,
    why: 'an empty id would key the map on "", so every sessionless stream would land in one bucket'
  },
  {
    label: 'a subscription with no sink is accepted',
    file: 'test/live.test.mjs',
    target: 'hub',
    from: `    if (typeof sink !== 'function') return () => {}`,
    to: `    if (sink === undefined) return () => {}`,
    why: 'publish would then call a non-function and throw inside the host dispatch'
  },
  {
    label: 'an emptied bucket is left in the map',
    file: 'test/live.test.mjs',
    target: 'hub',
    from: `    if (current.size === 0) this.byAgent.delete(agentId)`,
    to: `    if (current.size === -1) this.byAgent.delete(agentId)`,
    why: 'the plugin holds one hub for the life of the process, so a bucket per conversation never collected grows without bound'
  },
  {
    label: 'a throwing listener takes the publish with it',
    file: 'test/live.test.mjs',
    target: 'hub',
    from: `      try {\n        sink()\n        told += 1\n      } catch (error) {`,
    to: `      try {\n        sink()\n        told += 1\n      } catch (error) {\n        throw error`,
    why: "publish runs inside the host's own event dispatch, so a listener that throws must not become a host error"
  },
  {
    label: 'a throwing listener is kept',
    file: 'test/live.test.mjs',
    target: 'hub',
    from: `        this.log(\`live: a listener for \${agentId} failed — \${error?.message ?? error}\`)\n        set.delete(sink)`,
    to: `        this.log(\`live: a listener for \${agentId} failed — \${error?.message ?? error}\`)`,
    why: 'a listener that throws once throws on every publish; keeping it repeats the failure forever'
  },
  {
    label: 'a failed delivery still counts as published',
    file: 'test/live.test.mjs',
    target: 'hub',
    from: `    this.published += told > 0 ? 1 : 0`,
    to: `    this.published += 1`,
    why: 'published is the only evidence the stream is doing anything, and it must not count a change nobody heard'
  },
  {
    label: 'a session with no listeners reports one',
    file: 'test/live.test.mjs',
    target: 'hub',
    from: `    return this.byAgent.get(agentId)?.size ?? 0`,
    to: `    return this.byAgent.get(agentId)?.size ?? 1`,
    why: 'watching is what the tests use to tell a live session from a forgotten one'
  },

  // ---------------------------------------------------------------- the route --
  {
    label: 'a host without a hub gets a stream anyway',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `  if (hub === undefined || typeof hub.subscribe !== 'function') {`,
    to: `  if (hub === undefined) {`,
    why: 'a hub that cannot subscribe would be trusted, and the route would write a header for a stream nobody publishes to'
  },
  {
    label: 'a stream without a session is opened',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `  if (typeof agentId !== 'string' || agentId.length === 0) {`,
    to: `  if (typeof agentId !== 'string') {`,
    why: 'the stream would subscribe to a session id that cannot exist, and the client would wait forever'
  },
  {
    label: 'an event stream is sent cacheable',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `    'cache-control': 'no-store, no-transform',`,
    to: `    'cache-control': 'no-transform',`,
    why: 'a cached event stream replays a stale notification and hides the live one'
  },
  {
    label: 'an event stream is left to the proxy buffer',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `    'x-accel-buffering': 'no'`,
    to: `    'x-accel-buffering': 'yes'`,
    why: 'a buffering proxy holds the notification until the socket closes, which is never'
  },
  {
    label: 'writes are not flushed',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `    res.flush?.()`,
    to: `    void 0`,
    why: 'node buffers small writes; a buffered event is an event the client does not have'
  },
  {
    label: 'a head request falls through to the unknown-route answer',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `      if (path === \`\${ROUTE_PREFIX}/live\` && req.method === 'HEAD') {
        return json(res, 200, { ok: true, data: { stream: true } }, true)
      }
`,
    to: '',
    why: 'every other route here answers HEAD, so a 404 tells a health check the plugin is missing from a route that exists'
  },
  {
    label: 'a head request opens the stream anyway',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `if (path === \`\${ROUTE_PREFIX}/live\` && req.method === 'GET') return streamLive(deps, req, res, agentId)`,
    to: `if (path === \`\${ROUTE_PREFIX}/live\` && req.method !== 'POST') return streamLive(deps, req, res, agentId)`,
    why: 'HEAD admits no body and nothing ever closes it, so opening a stream for it leaks one subscription per probe'
  },
  {
    label: 'the stream opens without saying hello',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `  write(': connected\\n\\n')`,
    to: `  void 0`,
    why: 'EventSource does not fire its open event until the first byte arrives, so this is what retires the fallback poll'
  },
  {
    label: 'the heartbeat is too eager to be invisible',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `const LIVE_PING_MS = 25 * 1000`,
    to: `const LIVE_PING_MS = 250`,
    why: 'a ping every quarter second is traffic in a stream that is supposed to be silent between events'
  },
  {
    label: 'the heartbeat is never sent',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `  const beat = setInterval(() => write(': ping\\n\\n'), LIVE_PING_MS)`,
    to: `  const beat = setInterval(() => {}, LIVE_PING_MS)`,
    why: 'an idle connection is dropped by intermediaries, and the client would not notice until the next event'
  },
  {
    label: 'the heartbeat keeps the process alive',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `  if (typeof beat.unref === 'function') beat.unref()`,
    to: `  void 0`,
    why: 'a referenced timer holds the host open after every client has gone'
  },
  {
    label: 'the heartbeat outlives the stream',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `    clearInterval(beat)`,
    to: `    void 0`,
    why: 'the timer would keep writing to a finished response, one per closed stream'
  },
  {
    label: 'closing a stream leaves it subscribed',
    file: 'test/live.test.mjs',
    target: 'api',
    from: `  req.once('close', close)`,
    to: `  void 0`,
    why: 'the hub would publish to a dead response for as long as the process runs'
  },

  // ------------------------------------------------- the route, from the join --
  {
    label: 'a closed stream keeps being written to',
    file: 'test/persistence.test.mjs',
    target: 'api',
    from: `  req.once('close', close)`,
    to: `  void 0`,
    why: 'the same removal as above, observed from the far side: what the client sees is a write after end'
  },

  // --------------------------------------------------- the gate in the host --
  {
    label: 'every event wakes the stream',
    file: 'test/persistence.test.mjs',
    target: 'host',
    from: `    if (transcripts.record(agentId, event) === true) publish(agentId)`,
    to: `    transcripts.record(agentId, event)\n    publish(agentId)`,
    why: 'the host dispatches every event here; notifying for a token count makes the stream a slower poll'
  },
  {
    label: 'no event wakes the stream',
    file: 'test/persistence.test.mjs',
    target: 'host',
    from: `    if (transcripts.record(agentId, event) === true) publish(agentId)`,
    to: `    transcripts.record(agentId, event)`,
    why: 'a stream that never announces a change is indistinguishable from one that is broken'
  },

  // ------------------------------------------------------- the client's end --
  {
    label: 'opening the stream retires polling altogether',
    file: 'test/client.test.mjs',
    target: 'view',
    from: '          onOpen: slowDown,',
    to: '          onOpen: stopPolling,',
    why: "the stream cannot see the candidate queue, which any session writes to, and `EventSource` gives up for good on a response it cannot use — with no timer the panel would sit on stale counts until the person changed sessions"
  },
  {
    label: 'the slow poll is as fast as the one it replaced',
    file: 'test/client.test.mjs',
    target: 'view',
    from: '    const IDLE_REFRESH_MS = 60000',
    to: '    const IDLE_REFRESH_MS = 8000',
    why: 'the point of slowing down is to stop paying the eight-second rate once events arrive; at the same rate the stream buys nothing'
  },

  // ------------------------------------------------------- the gate's answer --
  {
    label: 'an event no card draws from is reported',
    file: 'test/live.test.mjs',
    target: 'store',
    from: `    return false\n  }\n}`,
    to: `    return true\n  }\n}`,
    why: "record's answer is the gate; an answer that is always true turns the filter off"
  }
]

let killed = 0
const survived = []
const notApplied = []
const crashed = []

const originals = new Map()
for (const [name, target] of Object.entries(TARGETS)) originals.set(name, fs.readFileSync(target, 'utf8'))

console.log(`mutation testing the live stream (${mutations.length} mutations)`)

for (const mutation of mutations) {
  const target = TARGETS[mutation.target]
  const original = originals.get(mutation.target)
  const occurrences = original.split(mutation.from).length - 1
  if (occurrences !== 1) {
    notApplied.push(`${mutation.label} (${occurrences} matches)`)
    console.log(`  NOT APPLIED  ${mutation.label} — ${occurrences} matches`)
    continue
  }
  const { failed, output } = attempt(target, mutation, original)
  const restored = fs.readFileSync(target, 'utf8')
  if (restored !== original) {
    // Louder than a failed mutation: the tree is now different from the one the
    // next run will read.
    crashed.push(`${mutation.label} (file was not restored)`)
    console.log(`  CRASHED      ${mutation.label} — file was not restored`)
    continue
  }
  if (failed > 0) {
    killed += 1
    continue
  }
  if (failed === -1) {
    crashed.push(mutation.label)
    console.log(`  CRASHED      ${mutation.label} — the suite never reached its tally`)
    continue
  }
  survived.push({ label: mutation.label, why: mutation.why })
  console.log(`  SURVIVED     ${mutation.label}`)
}

console.log(
  `\n${killed} killed, ${survived.length} survived, ${notApplied.length} not applied, ${crashed.length} crashed  (of ${mutations.length})`
)
if (survived.length > 0) {
  console.log('\nsurvived, with the argument each one makes:')
  for (const row of survived) console.log(`  - ${row.label}\n      ${row.why}`)
}

if (survived.length > 0 || notApplied.length > 0 || crashed.length > 0) process.exit(1)
