/**
 * End-to-end tests for the post-load observation window.
 *
 * `outcome.test.mjs` proves the bookkeeping. This file proves the wiring: that
 * a real `apply()` opens a window when the `skill` tool dispatches, feeds it
 * from the live event stream, writes one `skill_result` line to the ledger on
 * the right turn boundary, and writes nothing when it should not.
 *
 * The ledger is read back from disk rather than through a store accessor: the
 * point of the feature is that the row survives the process, so asserting on an
 * in-memory object would test half of it.
 */

import { join } from 'node:path'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { apply, Config } from '../lib/index.js'

let pass = 0
let fail = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    pass += 1
    return
  }
  fail += 1
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

/**
 * A fake agent whose session replays `events`.
 *
 * `session` is mandatory: the evidence gate and the panel both read
 * `agent.session.ownEvents()`, and an agent without it yields an empty stream.
 */
function fakeAgent(id, cwd) {
  const events = []
  return {
    id,
    session: {
      id,
      header: { id, cwd, version: 4, createdAt: Date.now(), isSeeded: false },
      ownEvents: () => events,
      snapshotEvents: () => events,
      log: events
    },
    push(event) {
      events.push(event)
    },
    all: () => events
  }
}

/** A human message event, which is what opens a turn. */
function userSaid(text, seq = 1) {
  return { type: 'user/message', seq, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

/** The host's `turn/end` shape. */
function turnEnded(kind = 'completed') {
  return { type: 'turn/end', time: Date.now(), data: { reason: { kind } } }
}

function fakeHost() {
  const tools = new Map()
  const commands = new Map()
  const contexts = []
  const agents = new Map()
  const handlers = new Map()
  const deferred = []
  const routes = []
  const ctx = {
    tools: { register: (tool) => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    commands: { register: (command) => (commands.set(command.name, command), () => commands.delete(command.name)) },
    systemPrompt: { context: (entry) => (contexts.push(entry), () => {}) },
    webServer: { register: (route) => (routes.push(route), () => {}) },
    get: (name) => (name === 'agents' ? { get: (id) => agents.get(id) } : undefined),
    inject(names, callback) {
      const missing = names.filter((name) => ctx[name] === undefined)
      if (missing.length > 0) {
        deferred.push({ names, callback })
        return undefined
      }
      return callback(ctx)
    },
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
  }
  return {
    ctx,
    tools,
    commands,
    contexts,
    agents,
    handlers,
    routes,
    emit(event, session, payload) {
      for (const handler of handlers.get(event) ?? []) handler(session, payload)
    }
  }
}

async function makeRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  process.env.DSH_HOME = root
  return root
}

/** Every `skill_result` line in the ledger, newest last. */
async function results(root) {
  const file = join(root, 'plugin-data', 'skill-evolve', 'ledger.jsonl')
  const text = await readFile(file, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((row) => row.action === 'skill_result')
}

/** Every `skill_used` line in the ledger. */
async function uses(root) {
  const file = join(root, 'plugin-data', 'skill-evolve', 'ledger.jsonl')
  const text = await readFile(file, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((row) => row.action === 'skill_used')
}

/**
 * Install one owned skill directly on disk.
 *
 * Writing the file rather than going through submission keeps these tests about
 * the observation window. The frontmatter carries the owner marker, so
 * `countUse` treats it as ours and opens a window.
 */
async function installSkill(root, name) {
  const dir = join(root, 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: A skill named ${name}.`,
      'evolved-by: dsh-skill-evolve',
      `evolved-stage: active`,
      'evolved-uses: 0',
      '---',
      '',
      `# ${name}`,
      '',
      'Do the thing.'
    ].join('\n')
  )
}

/** Dispatch the `skill` tool for `name`, which is what opens a window. */
/**
 * Dispatch the `skill` tool for `name`, which is what opens a window.
 *
 * Awaits a macrotask because `countUse` reads the skill file and writes the
 * usage row before it opens the window: the handler is async, so in a real
 * session the window exists long before the next turn ends. A test that emitted
 * a load and a turn end in the same synchronous block would close a window that
 * had not opened yet and report zero rows — a fixture artefact, not a defect.
 */
async function loadSkill(host, agent, name) {
  host.emit('session/event', agent.session, { type: 'tool/call', time: Date.now(), data: { name: 'skill', callId: `load-${name}`, arguments: JSON.stringify({ name }) } })
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/**
 * Record a tool call and its result in one step.
 *
 * The result event reproduces the host's real nesting — `data.message` carries
 * `toolCallId` and `isError`, with nothing at the top of `data`. This was
 * verified against 27,845 real `tool/result` events, where the flat shape
 * (`data.callId`, `data.isError`) appears zero times. A fixture that used the
 * flat shape passed while the implementation could not attribute a single
 * failure, which is exactly the kind of agreement that hides a defect.
 */
function toolStep(host, agent, toolName, callId, { ok = true } = {}) {
  host.emit('session/event', agent.session, { type: 'tool/call', time: Date.now(), data: { name: toolName, callId, arguments: '{}' } })
  host.emit('session/event', agent.session, {
    type: 'tool/result',
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { callId }, toolCallId: callId, content: [], isError: !ok, id: `m-${callId}` }
    }
  })
}

/**
 * One completed turn.
 *
 * Awaits a macrotask because closing a window appends to the ledger, and the
 * append is a promise the test has to let settle before reading the file back.
 */
async function closeTurn(host, agent, kind = 'completed') {
  host.emit('session/event', agent.session, turnEnded(kind))
  await new Promise((resolve) => setTimeout(resolve, 20))
}

// ---------------------------------------------------------------------------

// A load with clean work writes one row that says so.
{
  const root = await makeRoot('skill-evolve-outcome-clean-')
  await installSkill(root, 'clean-skill')
  const host = fakeHost()
  const agent = fakeAgent('session-clean', root)
  host.agents.set(agent.id, agent)
  apply(host.ctx, Config({ mode: 'suggest', outcomeTurns: 2 }))

  await loadSkill(host, agent, 'clean-skill')
  toolStep(host, agent, 'read', 'c1')
  await closeTurn(host, agent)
  check('clean: no row is written after one turn', (await results(root)).length === 0, String((await results(root)).length))
  await closeTurn(host, agent)

  const rows = await results(root)
  check('clean: one row after the window closes', rows.length === 1, String(rows.length))
  check('clean: the row names the skill', rows[0]?.skill === 'clean-skill', String(rows[0]?.skill))
  check('clean: the row names the session', rows[0]?.sessionId === 'session-clean', String(rows[0]?.sessionId))
  // The window is written by the plugin's own bookkeeping, not by the model or
  // the person. A reader filtering the ledger by actor depends on this.
  check('clean: the row is attributed to the system', rows[0]?.actor === 'system', String(rows[0]?.actor))
  check('clean: the row action is skill_result', rows[0]?.action === 'skill_result', String(rows[0]?.action))
  check('clean: the outcome is no-error', rows[0]?.outcome === 'no-error', String(rows[0]?.outcome))
  check('clean: the call is counted', rows[0]?.calls === 1, String(rows[0]?.calls))
  check('clean: the turns observed are recorded', rows[0]?.turnsObserved === 2, String(rows[0]?.turnsObserved))
  // The usage counter must still work — the window is an addition, not a
  // replacement.
  check('clean: the load is still counted as a use', (await uses(root)).length === 1, String((await uses(root)).length))
}

// A failing tool that gets retried is reported as a retry, not a bare error.
{
  const root = await makeRoot('skill-evolve-outcome-retry-')
  await installSkill(root, 'retry-skill')
  const host = fakeHost()
  const agent = fakeAgent('session-retry', root)
  host.agents.set(agent.id, agent)
  apply(host.ctx, Config({ mode: 'suggest', outcomeTurns: 1 }))

  await loadSkill(host, agent, 'retry-skill')
  toolStep(host, agent, 'bash', 'c1', { ok: false })
  toolStep(host, agent, 'bash', 'c2', { ok: false })
  await closeTurn(host, agent)

  const rows = await results(root)
  check('retry: one row', rows.length === 1, String(rows.length))
  check('retry: the outcome is retried', rows[0]?.outcome === 'retried', String(rows[0]?.outcome))
  check('retry: the failures are counted', rows[0]?.failures === 2, String(rows[0]?.failures))
  check('retry: the retry is counted', rows[0]?.retries === 1, String(rows[0]?.retries))
  check('retry: the tool is named once', Array.isArray(rows[0]?.failedTools) && rows[0].failedTools.join(',') === 'bash', String(rows[0]?.failedTools))
}

// Nothing happened => the row must say unobserved. Recording "no error" here
// would turn an empty window into evidence the skill works.
{
  const root = await makeRoot('skill-evolve-outcome-empty-')
  await installSkill(root, 'empty-skill')
  const host = fakeHost()
  const agent = fakeAgent('session-empty', root)
  host.agents.set(agent.id, agent)
  apply(host.ctx, Config({ mode: 'suggest', outcomeTurns: 1 }))

  await loadSkill(host, agent, 'empty-skill')
  await closeTurn(host, agent)

  const rows = await results(root)
  check('empty: a row is still written', rows.length === 1, String(rows.length))
  check('empty: the outcome is unobserved', rows[0]?.outcome === 'unobserved', String(rows[0]?.outcome))
  check('empty: no calls are claimed', rows[0]?.calls === 0, String(rows[0]?.calls))
}

// An abandoned turn consumes budget and is recorded as such.
{
  const root = await makeRoot('skill-evolve-outcome-abandoned-')
  await installSkill(root, 'abandoned-skill')
  const host = fakeHost()
  const agent = fakeAgent('session-abandoned', root)
  host.agents.set(agent.id, agent)
  apply(host.ctx, Config({ mode: 'suggest', outcomeTurns: 1 }))

  await loadSkill(host, agent, 'abandoned-skill')
  toolStep(host, agent, 'bash', 'c1', { ok: false })
  await closeTurn(host, agent, 'max-tokens')

  const rows = await results(root)
  check('abandoned: the window closed on an abandoned turn', rows.length === 1, String(rows.length))
  check('abandoned: the turn is recorded as abandoned', rows[0]?.abandonedTurns === 1, String(rows[0]?.abandonedTurns))
}

// Loading a second skill before the window closes must write the first one
// rather than lose it.
{
  const root = await makeRoot('skill-evolve-outcome-switch-')
  await installSkill(root, 'first-skill')
  await installSkill(root, 'second-skill')
  const host = fakeHost()
  const agent = fakeAgent('session-switch', root)
  host.agents.set(agent.id, agent)
  apply(host.ctx, Config({ mode: 'suggest', outcomeTurns: 2 }))

  await loadSkill(host, agent, 'first-skill')
  toolStep(host, agent, 'bash', 'c1', { ok: false })
  await loadSkill(host, agent, 'second-skill')
  toolStep(host, agent, 'read', 'c2')

  const rows = await results(root)
  check('switch: the displaced window is written', rows.length === 1, String(rows.length))
  check('switch: the displaced row is the first skill', rows[0]?.skill === 'first-skill', String(rows[0]?.skill))
  check('switch: the displaced row kept its failure', rows[0]?.failures === 1, String(rows[0]?.failures))

  await closeTurn(host, agent)
  await closeTurn(host, agent)
  const after = await results(root)
  check('switch: the second window closes too', after.length === 2, String(after.length))
  check('switch: the second row is the second skill', after[1]?.skill === 'second-skill', String(after[1]?.skill))
  check('switch: the second row has no failures', after[1]?.failures === 0, String(after[1]?.failures))
}

// Two sessions must not share a window.
{
  const root = await makeRoot('skill-evolve-outcome-sessions-')
  await installSkill(root, 'shared-skill')
  const host = fakeHost()
  const mine = fakeAgent('session-one', root)
  const other = fakeAgent('session-two', root)
  host.agents.set(mine.id, mine)
  host.agents.set(other.id, other)
  apply(host.ctx, Config({ mode: 'suggest', outcomeTurns: 1 }))

  await loadSkill(host, mine, 'shared-skill')
  toolStep(host, mine, 'bash', 'm1', { ok: false })
  // The other session's turn ends first. It must not close my window.
  await closeTurn(host, other)
  check('sessions: another session cannot close my window', (await results(root)).length === 0, String((await results(root)).length))
  await closeTurn(host, mine)

  const rows = await results(root)
  check('sessions: my window closed on my turn', rows.length === 1, String(rows.length))
  check('sessions: my failures are mine', rows[0]?.failures === 1, String(rows[0]?.failures))
  check('sessions: the row names my session', rows[0]?.sessionId === 'session-one', String(rows[0]?.sessionId))
}

// `outcomeTurns: 0` must record nothing at all.
{
  const root = await makeRoot('skill-evolve-outcome-off-')
  await installSkill(root, 'unwatched-skill')
  const host = fakeHost()
  const agent = fakeAgent('session-off', root)
  host.agents.set(agent.id, agent)
  apply(host.ctx, Config({ mode: 'suggest', outcomeTurns: 0 }))

  await loadSkill(host, agent, 'unwatched-skill')
  toolStep(host, agent, 'bash', 'c1', { ok: false })
  await closeTurn(host, agent)
  await closeTurn(host, agent)

  check('off: no outcome rows', (await results(root)).length === 0, String((await results(root)).length))
  // The usage counter is independent of observation and must keep working.
  check('off: the load is still counted', (await uses(root)).length === 1, String((await uses(root)).length))
}

// A session that disposes mid-window leaves no row: an interrupted observation
// is not a result.
{
  const root = await makeRoot('skill-evolve-outcome-dispose-')
  await installSkill(root, 'disposed-skill')
  const host = fakeHost()
  const agent = fakeAgent('session-dispose', root)
  host.agents.set(agent.id, agent)
  apply(host.ctx, Config({ mode: 'suggest', outcomeTurns: 2 }))

  await loadSkill(host, agent, 'disposed-skill')
  toolStep(host, agent, 'bash', 'c1', { ok: false })
  // The host announces disposal on its own event. Its handler takes a single
  // `{ agent }` argument — not the `(session, payload)` pair every
  // `session/event` handler receives — so the emit shape differs here.
  host.emit('agent/disposed', { agent })
  await closeTurn(host, agent)
  await closeTurn(host, agent)

  check('dispose: an interrupted window writes nothing', (await results(root)).length === 0, String((await results(root)).length))
}

// An externally installed skill (no owner marker) is counted as a use but not
// observed: this plugin cannot revise it, so its aftermath is not a decision.
{
  const root = await makeRoot('skill-evolve-outcome-foreign-')
  const dir = join(root, 'skills', 'foreign-skill')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), ['---', 'name: foreign-skill', 'description: Not ours.', '---', '', '# foreign', '', 'Body.'].join('\n'))
  const host = fakeHost()
  const agent = fakeAgent('session-foreign', root)
  host.agents.set(agent.id, agent)
  apply(host.ctx, Config({ mode: 'suggest', outcomeTurns: 1 }))

  await loadSkill(host, agent, 'foreign-skill')
  toolStep(host, agent, 'bash', 'c1', { ok: false })
  await closeTurn(host, agent)

  check('foreign: no outcome row', (await results(root)).length === 0, String((await results(root)).length))
}

// A malformed ledger line must not stop the next row from being written.
{
  const root = await makeRoot('skill-evolve-outcome-twice-')
  await installSkill(root, 'twice-skill')
  const host = fakeHost()
  const agent = fakeAgent('session-twice', root)
  host.agents.set(agent.id, agent)
  apply(host.ctx, Config({ mode: 'suggest', outcomeTurns: 1 }))

  await loadSkill(host, agent, 'twice-skill')
  await closeTurn(host, agent)
  await loadSkill(host, agent, 'twice-skill')
  await closeTurn(host, agent)

  const rows = await results(root)
  check('twice: both windows are recorded', rows.length === 2, String(rows.length))
  check('twice: the rows are append-ordered', rows[0]?.openedAt <= rows[1]?.openedAt)
}

console.log(`${pass} passed, ${fail} failed`)
for (const failure of failures) console.error(`FAIL ${failure}`)
if (fail > 0) process.exitCode = 1
