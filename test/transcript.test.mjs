/**
 * Tests for the per-agent transcript that feeds the panel.
 *
 * The panel's whole promise is "here is what the turn before this one did". The
 * failure modes worth testing are all about *which* events that sentence counts,
 * not about the data structure: the host delivers runtime-context snapshots and
 * tool results as `user` messages, and a transcript that counted those would
 * announce a new turn every time the plugin itself injected a hint.
 */

import {
  EDIT_TOOLS,
  MAX_CALLS_PER_TURN,
  MAX_SAID_BLOCKS,
  MAX_SAID_CHARS,
  SHELL_TOOLS,
  Transcript,
  TranscriptStore,
  readCommandArgument,
  readPathArgument,
  readToolCallBlock,
  tallyNames
} from '../lib/transcript.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

/** A human message, as the host shapes it. */
const human = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text }] } } })

/** A runtime-context snapshot, which the host also delivers as a user message. */
const runtimeContext = () => ({ type: 'user/message', data: { source: { kind: 'runtime-context' }, message: { content: [{ type: 'text', text: 'Current runtime context.' }] } } })

/** A tool result, which the host also delivers as a user message. */
const toolResult = () => ({ type: 'user/message', data: { source: { kind: 'tool' }, message: { content: [] } } })

/** A tool call event. */
const call = (name, args, id) => ({ type: 'tool/call', data: { name, arguments: args === undefined ? undefined : JSON.stringify(args), callId: id } })

/**
 * A tool result event for the matching call.
 *
 * Uses the host's real nesting: the verdict and the id live under
 * `data.message`, and the top of `data` holds only `turn`, `step` and the
 * message. A flat fixture here would let the module pass while reading a shape
 * that no session ever produces.
 */
const result = (id, ok, error) => ({
  type: 'tool/result',
  data: {
    turn: 1,
    step: 1,
    message: { role: 'tool', source: { callId: id }, toolCallId: id, content: [], isError: !ok, id: `m-${id}` },
    ...(error === undefined ? {} : { error: { message: error } })
  }
})

/** An assistant message carrying text blocks. */
const said = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })

/** A turn end. */
const endTurn = (kind) => ({ type: 'turn/end', data: { reason: { kind: kind ?? 'completed' } } })

// ---------------------------------------------------------------------------
// Argument readers
// ---------------------------------------------------------------------------

check('a path is read from a JSON string', readPathArgument('{"file_path":"F:/a/b.js"}') === 'F:/a/b.js', String(readPathArgument('{"file_path":"F:/a/b.js"}')))
check('a path is read from an object', readPathArgument({ path: '/tmp/x' }) === '/tmp/x', String(readPathArgument({ path: '/tmp/x' })))
check('a missing path is undefined', readPathArgument({ other: 1 }) === undefined)
check('a non-object argument is undefined', readPathArgument('not json') === undefined, String(readPathArgument('not json')))

check('a command is read from a JSON string', readCommandArgument('{"command":"npm test"}') === 'npm test', String(readCommandArgument('{"command":"npm test"}')))
check('a command is read from an object', readCommandArgument({ cmd: 'ls -la' }) === 'ls -la', String(readCommandArgument({ cmd: 'ls -la' })))
check('a shell tool set includes bash', SHELL_TOOLS.has('bash'), [...SHELL_TOOLS].join(','))
check('an edit tool set includes edit', EDIT_TOOLS.has('edit'), [...EDIT_TOOLS].join(','))

check(
  'a tool-call block is recognised',
  readToolCallBlock({ type: 'tool-call', id: 'c1', name: 'bash', arguments: { command: 'x' } })?.name === 'bash',
)
check('a tool_use block is recognised too', readToolCallBlock({ type: 'tool_use', name: 'read', input: { path: 'a' } })?.name === 'read')
check('a block without a name is ignored', readToolCallBlock({ type: 'tool-call' }) === undefined)
check('a non-call block is ignored', readToolCallBlock({ type: 'text', text: 'hi' }) === undefined)
check('a null block is ignored', readToolCallBlock(null) === undefined)

check(
  'tallyNames counts by name, descending',
  JSON.stringify(tallyNames([{ name: 'bash' }, { name: 'read' }, { name: 'bash' }])) === JSON.stringify([{ name: 'bash', count: 2 }, { name: 'read', count: 1 }]),
  JSON.stringify(tallyNames([{ name: 'bash' }, { name: 'read' }, { name: 'bash' }])),
)

// ---------------------------------------------------------------------------
// Which events open a turn
// ---------------------------------------------------------------------------

{
  const store = new TranscriptStore()
  store.record('a', human('do the thing'))
  store.record('a', runtimeContext())
  store.record('a', runtimeContext())
  store.record('a', toolResult())
  const view = store.view('a')
  check('one human message opens exactly one turn', view.turns === 1, String(view.turns))
  check('runtime context does not open a turn', view.current.turn === 1, String(view.current.turn))
}

{
  const store = new TranscriptStore()
  store.record('a', runtimeContext())
  // No transcript is allocated at all: context arriving before any human
  // message should not even create the record the panel would later read.
  check('a session that only sent context has no transcript', store.view('a') === undefined, JSON.stringify(store.view('a')))
  check('context alone creates nothing', store.byAgent.size === 0, String(store.byAgent.size))
}

{
  const store = new TranscriptStore()
  store.record('a', human('one'))
  store.record('a', human('two'))
  check('two human messages make two turns', store.view('a').turns === 2, String(store.view('a').turns))
}

// ---------------------------------------------------------------------------
// Folding a turn
// ---------------------------------------------------------------------------

{
  const store = new TranscriptStore()
  store.record('a', human('find the bug'))
  //  deliberately does not count: reading a file is not touching it, and
  // a panel that listed every file the turn looked at would be a file browser.
  store.record('a', call('read', { path: 'F:/src/read-only.js' }, 'c0'))
  store.record('a', call('edit', { file_path: 'F:/src/a.js' }, 'c1'))
  store.record('a', result('c1', true))
  store.record('a', call('bash', { command: 'npm test' }, 'c2'))
  store.record('a', result('c2', false, 'exit 1'))
  store.record('a', said('The test fails because the fixture is stale.'))
  store.record('a', endTurn())

  const view = store.view('a')
  check('the finished turn is reported as previous', view.previous !== undefined)
  check('no turn is open between turns', view.current.turn === undefined)
  check('call count is recorded', view.previous.calls === 3, String(view.previous.calls))
  check('failure count is recorded', view.previous.failed === 1, String(view.previous.failed))
  check('the edited path is recorded', view.previous.paths.includes('F:/src/a.js'), JSON.stringify(view.previous.paths))
  check('a read-only path is not reported as touched', view.previous.paths.includes('F:/src/read-only.js') === false, JSON.stringify(view.previous.paths))
  check('only the edit is a touched file', view.previous.paths.length === 1, JSON.stringify(view.previous.paths))
  check('the command is recorded', view.previous.commands.includes('npm test'), JSON.stringify(view.previous.commands))
  check('the assistant text is recorded', view.previous.said.includes('The test fails'), String(view.previous.said))
  check('the tool tally is recorded', view.previous.tools.some((row) => row.name === 'read'), JSON.stringify(view.previous.tools))
}

{
  // An abandoned turn is not a turn's worth of work: the model never reached its
  // own conclusion, so describing it would describe a plan nobody carried out.
  const store = new TranscriptStore()
  store.record('a', human('one'))
  store.record('a', call('bash', { command: 'danger' }, 'c1'))
  store.record('a', endTurn('completed'))
  check('the first turn is recorded', store.view('a').previous !== undefined)

  store.record('a', human('two'))
  store.record('a', call('bash', { command: 'aborted' }, 'c2'))
  store.record('a', endTurn('cancelled'))
  const view = store.view('a')
  check('an abandoned turn does not replace the last good one', view.previous.calls === 1, String(view.previous.calls))
  check('the abandoned turn leaves no open turn', view.current.turn === undefined)
  check('the abandoned turn is not reported at all', view.previous.commands.includes('aborted') === false, JSON.stringify(view.previous.commands))
}

{
  const store = new TranscriptStore()
  store.record('a', call('bash', { command: 'x' }, 'c1'))
  store.record('a', endTurn())
  check('a turn end without a turn start is ignored', store.view('a').previous === undefined)
}

// ---------------------------------------------------------------------------
// Deduplication and caps
// ---------------------------------------------------------------------------

{
  const store = new TranscriptStore()
  store.record('a', human('edit the same file'))
  for (let i = 0; i < 5; i += 1) {
    store.record('a', call('edit', { file_path: 'F:/same.js' }, `c${i}`))
    store.record('a', result(`c${i}`, true))
  }
  store.record('a', endTurn())
  const paths = store.view('a').previous.paths
  check('a file edited five times is listed once', paths.length === 1, JSON.stringify(paths))
  check('the five edits still count as five calls', store.view('a').previous.calls === 5, String(store.view('a').previous.calls))
}

{
  const store = new TranscriptStore()
  store.record('a', human('many calls'))
  for (let i = 0; i < MAX_CALLS_PER_TURN + 20; i += 1) store.record('a', call('read', { path: `/tmp/${i}` }, `c${i}`))
  store.record('a', endTurn())
  check('calls are capped per turn', store.view('a').previous.calls === MAX_CALLS_PER_TURN, `${store.view('a').previous.calls} vs ${MAX_CALLS_PER_TURN}`)
}

{
  const store = new TranscriptStore()
  store.record('a', human('long reply'))
  store.record('a', said('x'.repeat(5000)))
  store.record('a', endTurn())
  check('assistant text is capped', store.view('a').previous.said.length <= 1200, String(store.view('a').previous.said.length))
}

{
  const store = new TranscriptStore()
  store.record('a', human('many commands'))
  for (let i = 0; i < 20; i += 1) {
    store.record('a', call('bash', { command: `cmd ${i}` }, `c${i}`))
    store.record('a', result(`c${i}`, true))
  }
  store.record('a', endTurn())
  check('only the most recent commands survive', store.view('a').previous.commands.length === 8, String(store.view('a').previous.commands.length))
  check('the newest command is kept', store.view('a').previous.commands.includes('cmd 19'), JSON.stringify(store.view('a').previous.commands))
}

{
  const store = new TranscriptStore()
  store.record('a', human('huge command'))
  store.record('a', call('bash', { command: 'y'.repeat(900) }, 'c1'))
  store.record('a', result('c1', true))
  store.record('a', endTurn())
  check('a single command is capped', store.view('a').previous.commands[0].length === 200, String(store.view('a').previous.commands[0].length))
}

// ---------------------------------------------------------------------------
// Agents are separate
// ---------------------------------------------------------------------------

{
  const store = new TranscriptStore()
  store.record('a', human('a one'))
  store.record('b', human('b one'))
  store.record('b', human('b two'))
  check('agents do not share a turn count', store.view('a').turns === 1 && store.view('b').turns === 2, `${store.view('a').turns}/${store.view('b').turns}`)
  check('an unknown agent has no view', store.view('nobody') === undefined)
  store.forget('a')
  check('forget removes the transcript', store.view('a') === undefined)
}

// ---------------------------------------------------------------------------
// Unknown events
// ---------------------------------------------------------------------------

{
  const store = new TranscriptStore()
  store.record('a', human('one'))
  store.record('a', { type: 'something/new', data: { whatever: true } })
  store.record('a', { type: undefined })
  store.record('a', undefined)
  store.record('a', null)
  check('an unknown event does not disturb the transcript', store.view('a').turns === 1 && store.view('a').current.turn === 1, String(store.view('a').turns))
}

// ---------------------------------------------------------------------------
// Snapshot and empty transcript
// ---------------------------------------------------------------------------

{
  const transcript = new Transcript()
  const snapshot = transcript.snapshot()
  check('an empty snapshot has zero calls', snapshot.calls === 0, String(snapshot.calls))
  check('an empty snapshot has no paths', snapshot.paths.length === 0)
  check('an empty snapshot has empty text', snapshot.said === '', String(snapshot.said))
}

{
  const store = new TranscriptStore()
  const view = store.view('never-seen')
  check('viewing an unknown agent does not create one', view === undefined && store.byAgent.size === 0, String(store.byAgent.size))
  store.for('never-seen')
  check('asking for a transcript does create one', store.byAgent.size === 1, String(store.byAgent.size))
}

// ---------------------------------------------------------------------------
// A result for a call that was never recorded
// ---------------------------------------------------------------------------

{
  const store = new TranscriptStore()
  store.record('a', human('one'))
  store.record('a', result('missing', false, 'boom'))
  store.record('a', endTurn())
  check('a result without a call does not fabricate a row', store.view('a').previous.calls === 0, String(store.view('a').previous.calls))
  check('a result without a call does not fabricate a failure', store.view('a').previous.failed === 0, String(store.view('a').previous.failed))
}

// ---------------------------------------------------------------------------
// A failure the host marks only through the error payload
// ---------------------------------------------------------------------------
//
// Real failures almost always carry `message.isError: true`, but the host also
// records some of them as a result that merely has an `error` object. Both are
// failures, and a window that saw one must not be reported as clean.

{
  const store = new TranscriptStore()
  store.record('a', human('one'))
  store.record('a', call('bash', { command: 'npm test' }, 'e1'))
  store.record('a', {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { callId: 'e1' }, toolCallId: 'e1', content: [], isError: false, id: 'm-e1' },
      error: { message: 'spawn failed' }
    }
  })
  store.record('a', endTurn())
  check('a result-level error payload still counts as a failure', store.view('a').previous.failed === 1, String(store.view('a').previous.failed))
}

// --- what the transcript refuses to hold ---------------------------------
//
// The panel renders a two-paragraph summary of one turn, so the text is capped
// on the way in. The failure is invisible from the outside — the panel looks
// right either way and only the process grows — which is exactly why the bound
// needs an assertion rather than a code review.
{
  const transcript = new Transcript()
  transcript.beginTurn(1)
  for (let index = 0; index < MAX_SAID_BLOCKS * 3; index += 1) {
    transcript.noteText([{ type: 'text', text: `block ${index}` }])
  }
  check('the text block count is capped', transcript.said.length === MAX_SAID_BLOCKS, String(transcript.said.length))
  check('the earliest blocks are kept', transcript.said[0] === 'block 0', transcript.said[0])

  const long = new Transcript()
  long.beginTurn(1)
  long.noteText([{ type: 'text', text: 'y'.repeat(MAX_SAID_CHARS * 4) }])
  check('one oversized block is cut on the way in', long.said[0].length === MAX_SAID_CHARS, String(long.said[0].length))

  const normal = new Transcript()
  normal.beginTurn(1)
  normal.noteText([{ type: 'text', text: '  short reply  ' }])
  check('short text is stored trimmed and unmodified', normal.said[0] === 'short reply', JSON.stringify(normal.said[0]))

  const empty = new Transcript()
  empty.beginTurn(1)
  empty.noteText([{ type: 'text', text: '   ' }, { type: 'thinking', text: 'skip me' }])
  check('blank and non-text blocks are still skipped', empty.said.length === 0, String(empty.said.length))

  transcript.beginTurn(2)
  check('a new turn clears the text buffer', transcript.said.length === 0, String(transcript.said.length))
  transcript.noteText([{ type: 'text', text: 'fresh' }])
  check('a new turn gets its own budget', transcript.said.length === 1, String(transcript.said.length))

  // The snapshot caps independently, so even a full buffer cannot produce an
  // unbounded panel payload.
  const full = new Transcript()
  full.beginTurn(1)
  for (let index = 0; index < MAX_SAID_BLOCKS; index += 1) {
    full.noteText([{ type: 'text', text: 'z'.repeat(MAX_SAID_CHARS) }])
  }
  check('the snapshot text stays bounded', full.snapshot().said.length <= 1200, String(full.snapshot().said.length))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
