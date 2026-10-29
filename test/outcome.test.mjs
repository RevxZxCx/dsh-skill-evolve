/**
 * Tests for the post-load observation window.
 *
 * The module's whole claim is that it records only facts the host already
 * decided. So these tests are mostly about what must NOT be recorded: a
 * successful call is not a failure, an empty window is not a success, an
 * abandoned turn is not a completed turn, and a session that closes mid-window
 * leaves no row at all.
 */

import assert from 'node:assert/strict'
import { Window, OutcomeStore, OUTCOMES, OUTCOME_TURNS, MAX_FAILED_TOOLS, MAX_TRACKED_CALLS } from '../lib/outcome.js'

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.error(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const fixed = '2026-10-29T00:00:00.000Z'

function makeWindow(overrides = {}) {
  return new Window({ skill: 'demo', agentId: 'session-a', at: fixed, ...overrides })
}

// ---------------------------------------------------------------- the shapes

{
  const window = makeWindow()
  check('an untouched window is unobserved, not a success', window.outcome() === 'unobserved', window.outcome())
  check('unobserved is one of the declared shapes', OUTCOMES.includes('unobserved'))
}

{
  const window = makeWindow()
  window.noteCall('read', 'c1')
  window.noteResult({ callId: 'c1', isError: false })
  check('a clean call is no-error', window.outcome() === 'no-error', window.outcome())
}

{
  const window = makeWindow()
  window.noteCall('bash', 'c1')
  window.noteResult({ callId: 'c1', isError: true })
  window.noteCall('edit', 'c2')
  window.noteResult({ callId: 'c2', isError: false })
  check('a failure with no retry is errors', window.outcome() === 'errors', window.outcome())
  check('the failing tool is named', window.failedTools.join(',') === 'bash', window.failedTools.join(','))
  check('the failure is counted', window.failures === 1, String(window.failures))
}

{
  const window = makeWindow()
  window.noteCall('bash', 'c1')
  window.noteResult({ callId: 'c1', isError: true })
  window.noteCall('bash', 'c2')
  window.noteResult({ callId: 'c2', isError: false })
  check('calling a failed tool again is a retry', window.outcome() === 'retried', window.outcome())
  check('the retry is counted', window.retries === 1, String(window.retries))
}

// A retry is the more specific finding, so it must win over a bare warning.
{
  const window = makeWindow()
  window.noteCall('bash', 'c1')
  window.noteResult({ callId: 'c1', isError: true })
  window.noteCall('bash', 'c2')
  window.noteResult({ callId: 'c2', isError: true })
  check('repeated failure still reports retried', window.outcome() === 'retried', window.outcome())
  check('both failures are counted even though the tool is named once', window.failures === 2, String(window.failures))
  check('a repeated tool is named once', window.failedTools.length === 1, window.failedTools.join(','))
}

// ---------------------------------------------------- failure attribution

{
  const window = makeWindow()
  // A result with no matching call: the failure counts, but nothing can be
  // named. Recording a tool name here would invent one.
  window.noteResult({ callId: 'ghost', isError: true })
  check('an unattributable failure still counts', window.failures === 1, String(window.failures))
  check('an unattributable failure names no tool', window.failedTools.length === 0, window.failedTools.join(','))
  check('a failure with no calls seen is errors', window.outcome() === 'errors', window.outcome())
}

{
  const window = makeWindow()
  window.noteCall('bash', 'c1')
  // The host reports failures with an `error` payload in some paths and with
  // `isError` in others. Both must count, because the plugin reads the flag the
  // host set, not the text.
  window.noteResult({ callId: 'c1', error: { message: 'boom' } })
  check('an error payload counts as a failure', window.failures === 1, String(window.failures))
  check('an error payload names its tool', window.failedTools.join(',') === 'bash', window.failedTools.join(','))
}

{
  const window = makeWindow()
  window.noteCall('read', 'c1')
  // A result carrying `isError: false` and no error must not count. This is the
  // case that would silently make every window look like a failure.
  window.noteResult({ callId: 'c1', isError: false, error: undefined })
  check('a success is not a failure', window.failures === 0, String(window.failures))
}

// --------------------------------------------------------- the turn budget

{
  const window = makeWindow({ turns: 2 })
  check('the first turn does not close the window', window.noteTurnEnd({ kind: 'completed' }) === false)
  check('the second turn closes the window', window.noteTurnEnd({ kind: 'completed' }) === true)
  check('the observed count matches', window.observed === 2, String(window.observed))
}

{
  const window = makeWindow({ turns: 2 })
  window.noteTurnEnd({ kind: 'max-tokens' })
  check('an abandoned turn still consumes the budget', window.remaining === 1, String(window.remaining))
  check('an abandoned turn is recorded', window.abandoned === 1, String(window.abandoned))
}

{
  const window = makeWindow({ turns: 0 })
  check('a zero-turn config falls back to the default rather than closing instantly', window.remaining === OUTCOME_TURNS, String(window.remaining))
}

{
  const window = makeWindow({ turns: undefined })
  check('a missing turn count uses the default', window.remaining === OUTCOME_TURNS, String(window.remaining))
}

{
  const window = makeWindow({ turns: -3 })
  check('a negative turn count is not trusted', window.remaining === OUTCOME_TURNS, String(window.remaining))
}

// ------------------------------------------------------------------ bounds

{
  const window = makeWindow()
  for (let index = 0; index < 20; index += 1) {
    window.noteCall(`tool-${index}`, `c${index}`)
    window.noteResult({ callId: `c${index}`, isError: true })
  }
  check('the failed tool list is capped', window.failedTools.length === MAX_FAILED_TOOLS, String(window.failedTools.length))
  check('the failure count is not capped', window.failures === 20, String(window.failures))
}

{
  const window = makeWindow()
  for (let index = 0; index < MAX_TRACKED_CALLS + 50; index += 1) window.noteCall('bash', `c${index}`)
  check('the pending call map is capped', window.pending.size === MAX_TRACKED_CALLS, String(window.pending.size))
  // The newest call must survive: dropping from the front is what keeps the
  // map useful, and dropping from the back would lose every result that is
  // still in flight.
  check('the newest call is still tracked', window.pending.has(`c${MAX_TRACKED_CALLS + 49}`) === true)
}

// -------------------------------------------------------------- the record

{
  const window = makeWindow({ turns: 1 })
  window.noteCall('bash', 'c1')
  window.noteResult({ callId: 'c1', isError: true })
  window.noteCall('bash', 'c2')
  window.noteTurnEnd({ kind: 'completed' })
  const record = window.finish('2026-10-29T00:05:00.000Z')
  check('the record carries the skill', record.skill === 'demo', record.skill)
  check('the record carries the session', record.sessionId === 'session-a', record.sessionId)
  check('the record carries both timestamps', record.openedAt === fixed && record.closedAt === '2026-10-29T00:05:00.000Z')
  check('the record carries the turns observed', record.turnsObserved === 1, String(record.turnsObserved))
  check('the record carries the counts', record.calls === 2 && record.failures === 1 && record.retries === 1)
  check('the record carries the outcome', record.outcome === 'retried', record.outcome)
  check('the record carries the failed tools', Array.isArray(record.failedTools) && record.failedTools.join(',') === 'bash')
  // The ledger is JSONL; a Map or Set leaking in would serialise as `{}`.
  const round = JSON.parse(JSON.stringify(record))
  check('the record survives a JSON round trip', round.outcome === 'retried' && round.calls === 2)
}

// --------------------------------------------------------------- the store

{
  const store = new OutcomeStore()
  store.begin({ skill: 'alpha', agentId: 'a', at: fixed })
  check('a window is open', store.size === 1, String(store.size))
  store.record('a', { type: 'tool/call', data: { name: 'bash', callId: 'c1' } })
  // The host nests a result in `data.message`; a flat `data.callId` never occurs
  // in a real session. `store.record` takes raw events, so this fixture must use
  // the real shape or the store could pass while attributing nothing.
  store.record('a', { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } })
  const closed = store.record('a', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  check('the first turn end does not close a two-turn window', closed.length === 0, String(closed.length))
  const closed2 = store.record('a', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  check('the second closes it', closed2.length === 1, String(closed2.length))
  check('the closed record reports the failure', closed2[0].outcome === 'errors', closed2[0].outcome)
  check('the store forgets the closed window', store.size === 0, String(store.size))
}

{
  const store = new OutcomeStore()
  store.begin({ skill: 'alpha', agentId: 'a', at: fixed })
  // Loading a second skill means the model decided the first was not what it
  // needed. The first window must still be written, not dropped.
  const displaced = store.begin({ skill: 'beta', agentId: 'a', at: fixed })
  check('a second load displaces the first', displaced !== undefined && displaced.skill === 'alpha', String(displaced?.skill))
  check('the displaced window is not left open', store.size === 1, String(store.size))
}

{
  const store = new OutcomeStore()
  const closed = store.record('nobody', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  check('events for an agent with no window are ignored', closed.length === 0)
}

{
  const store = new OutcomeStore()
  store.begin({ skill: 'alpha', agentId: 'a', at: fixed })
  store.forget('a')
  check('forget drops the window', store.size === 0, String(store.size))
  check('forget writes nothing', store.close('a') === undefined)
}

{
  const store = new OutcomeStore()
  store.begin({ skill: 'alpha', agentId: 'a', at: fixed })
  const closed = store.close('a', fixed)
  check('close returns the record', closed !== undefined && closed.skill === 'alpha')
  check('close twice yields nothing the second time', store.close('a') === undefined)
}

// Two agents must not share a window. This is the failure that would attribute
// one session's mistakes to another session's skill.
{
  const store = new OutcomeStore()
  store.begin({ skill: 'alpha', agentId: 'a', at: fixed })
  store.begin({ skill: 'beta', agentId: 'b', at: fixed })
  store.record('a', { type: 'tool/call', data: { name: 'bash', callId: 'c1' } })
  store.record('a', { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } })
  const closed = store.record('b', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  check('one agent cannot close another agent\'s window', closed.length === 0)
  const mine = store.close('a', fixed)
  check('the other window kept its own facts', mine.failures === 1, String(mine.failures))
}

// An unknown event type must not disturb the counts.
{
  const store = new OutcomeStore()
  store.begin({ skill: 'alpha', agentId: 'a', at: fixed })
  store.record('a', { type: 'user/message', data: { content: [] } })
  store.record('a', { type: 'assistant/message', data: {} })
  const record = store.close('a', fixed)
  check('unrelated events leave the window untouched', record.calls === 0 && record.failures === 0)
  check('an untouched window closes as unobserved', record.outcome === 'unobserved', record.outcome)
}

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
