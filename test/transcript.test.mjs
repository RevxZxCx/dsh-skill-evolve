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
  MAX_REPORTED_PATHS,
  MAX_SAID_BLOCKS,
  MAX_SAID_CHARS,
  PRESENT_TOOLS,
  REPORT_TOOLS,
  SHELL_TOOLS,
  Transcript,
  TranscriptStore,
  readCommandArgument,
  readPathArgument,
  readPathListArgument,
  readPresentedPaths,
  readToolCallBlock,
  tallyNames
} from '../packages/ui-evolve/lib/transcript.js'

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

/**
 * A human message, as the host shapes it.
 *
 * The content hangs off `data.content`, not `data.message.content`. That is not
 * a guess: it was checked against a real `session.v4.jsonl` archive, where a
 * person's message is `{ id, role, source, content }`. Assistant messages are
 * the other way round — `data.message.content` — and the two shapes having one
 * field in common is exactly how a fixture can be wrong for years without a
 * test failing, because until the summary started quoting the question nothing
 * in this module ever read a user message's body.
 */
const human = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

/** A runtime-context snapshot, which the host also delivers as a user message. */
const runtimeContext = () => ({ type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context.' }] } })

/** A tool result, which the host also delivers as a user message. */
const toolResult = () => ({ type: 'user/message', data: { source: { kind: 'tool' }, content: [] } })

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

// ---------------------------------------------------------------------------
// The question the turn exists to answer
// ---------------------------------------------------------------------------

{
  // The summary is written in the language the *user* wrote in, so the one
  // thing the prompt needs from this module is the user's own words. Nothing
  // else here records them: the panel does not draw them (the transcript is
  // already on screen above the card), so before this field existed the model
  // was asked to answer a question it had never been shown.
  const store = new TranscriptStore()
  store.record('a', human('修好那个测试'))
  store.record('a', call('edit', { file_path: 'F:/src/a.js' }, 'c1'))
  store.record('a', result('c1', true))
  store.record('a', said('Fixed the fixture.'))
  store.record('a', endTurn())

  const view = store.view('a')
  check('the question is kept with the turn it opened', view.previous.asked === '修好那个测试', JSON.stringify(view.previous.asked))
  check('the question is not confused with what the assistant said', view.previous.said.includes('修好那个测试') === false, JSON.stringify(view.previous.said))
}

{
  // A human message can arrive as a bare string instead of a block array, and
  // the two shapes must not disagree about what the user said.
  const store = new TranscriptStore()
  store.record('a', { type: 'user/message', data: { source: { kind: 'user' }, content: 'do the thing' } })
  store.record('a', endTurn())
  check('a string body is read as the question', store.view('a').previous?.asked === 'do the thing', JSON.stringify(store.view('a').previous?.asked))
}

{
  // Attachments travel in the same array as the text. Stringifying the whole
  // array would put `[object Object]` into the prompt, which is worse than
  // quoting nothing: it looks like the user asked for a serialised blob.
  const store = new TranscriptStore()
  store.record('a', {
    type: 'user/message',
    data: {
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', source: { kind: 'file', path: 'x.png' } },
        { type: 'file', path: 'y.log' }
      ]
    }
  })
  store.record('a', endTurn())
  const asked = store.view('a').previous?.asked ?? ''
  check('only the text blocks become the question', asked === 'look at this', JSON.stringify(asked))
  check('an attachment is never stringified into the question', asked.includes('[object') === false, JSON.stringify(asked))
}

{
  // Context and tool results also arrive as user messages. They are not the
  // user talking, and a turn that recorded them as the question would tell the
  // model that the person asked for a runtime snapshot.
  const store = new TranscriptStore()
  store.record('a', human('real question'))
  store.record('a', runtimeContext())
  store.record('a', toolResult())
  store.record('a', endTurn())
  check('context does not replace the question', store.view('a').previous?.asked === 'real question', JSON.stringify(store.view('a').previous?.asked))
}

{
  // The budget is a number of characters, so it has to be spent in characters.
  // `String#slice` counts UTF-16 units: a 600-unit cut that lands between the
  // halves of an astral character leaves a lone surrogate, which the model reads
  // as U+FFFD — a corrupted quote of something the person actually typed.
  const limit = 600
  const fill = 'a'.repeat(limit - 1)
  const store = new TranscriptStore()
  store.record('a', human(`${fill}😀 tail`))
  store.record('a', endTurn())
  const asked = store.view('a').previous?.asked ?? ''
  check('an astral character is never cut in half', /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(asked) === false, JSON.stringify(asked.slice(-6)))
  check('the question still spends its whole budget', Array.from(asked).length === limit, String(Array.from(asked).length))
  check('and it keeps the emoji whole rather than dropping it', asked.endsWith('😀'), JSON.stringify(asked.slice(-4)))
}

{
  // A shell call names a command, not a path — but the command usually says
  // which file it writes. Without this the card was blind to everything the
  // session produced with a redirect: on one real 175-file session, 130 of the
  // rows were scripts created by `cat > x <<'EOF'`, and the file list held none
  // of them because no `edit`-family call ever named them.
  const store = new TranscriptStore()
  store.record('a', human('write a probe'))
  store.record('a', call('bash', { command: "cat > scripts/probe.py <<'EOF'\nprint(1)\nEOF" }, 's1'))
  store.record('a', result('s1', true))
  store.record('a', said('Written.'))
  store.record('a', endTurn())

  const view = store.view('a')
  check('a file written by a redirect is reported', view.previous.paths.includes('scripts/probe.py'), JSON.stringify(view.previous.paths))
  check('the heredoc body is not a file', view.previous.paths.some((path) => path.includes('print')) === false, JSON.stringify(view.previous.paths))
}

{
  // The same rule as reading: a command that writes nothing names no file.
  // `npm test` may create a hundred files and this scan will name none of them,
  // because guessing from a program's name is how a card starts claiming files
  // that were never touched.
  const store = new TranscriptStore()
  store.record('a', human('run the tests'))
  store.record('a', call('bash', { command: 'npm test 2>&1' }, 'n1'))
  store.record('a', result('n1', true))
  store.record('a', said('Green.'))
  store.record('a', endTurn())

  const view = store.view('a')
  check('a command that names no file adds none', view.previous.paths.length === 0, JSON.stringify(view.previous.paths))
  check('and the command itself is still recorded', view.previous.commands.includes('npm test 2>&1'), JSON.stringify(view.previous.commands))
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

// ---------------------------------------------------------------------------
// Installing a stored session
// ---------------------------------------------------------------------------

{
  // A file read takes milliseconds and events arrive during it. Whatever arrived
  // is newer than the file, so the file loses on the finished turn — but it is
  // the only record of the turns before the restart, and this process started
  // counting at zero. Refusing the file outright made the panel announce turn 1
  // for a conversation that had reached turn 7.
  const store = new TranscriptStore()
  store.record('a', human('one'))
  store.record('a', human('two'))
  const created = store.hydrate('a', { turns: 9, previous: { turn: 8, calls: 4, said: 'from another process' } })
  check('a stored count is added to the count from live events', created === true, String(created))
  check('and the sum is what the panel counts', store.view('a').turns === 11, String(store.view('a').turns))
  check(
    'and the stored turn is shown, because nothing has finished here yet',
    store.view('a').previous?.turn === 8,
    JSON.stringify(store.view('a').previous),
  )
  check('a second read does not add the count again', store.hydrate('a', { turns: 9 }) === false, 'added again')
  check('and the count did not move', store.view('a').turns === 11, String(store.view('a').turns))
}

{
  // The case the whole feature exists for: this process has no memory of the
  // session, and the file is the only thing that knows it happened.
  const store = new TranscriptStore()
  const created = store.hydrate('a', { turns: 7, previous: { turn: 6, calls: 3, paths: ['a.js'], commands: [], tools: [], said: 'earlier' } })
  check('an unstarted transcript accepts a stored one', created === true, String(created))
  check('the stored turn is the one the panel shows', store.view('a').previous?.turn === 6, JSON.stringify(store.view('a').previous))
  check('the turn counter comes back with it', store.view('a').turns === 7, String(store.view('a').turns))
}

{
  const store = new TranscriptStore()
  store.hydrate('a', { previous: { turn: 4, calls: 0, paths: [], commands: [], tools: [], said: '' } })
  check('a stored turn without a counter still sets the counter', store.view('a').turns === 4, String(store.view('a').turns))
}

{
  // A count is worth keeping on its own: a session whose last turn was abandoned
  // has no finished turn — an abandoned turn is deliberately not summarised —
  // but it still reached turn N, and the panel prints N. Refusing the state for
  // want of `previous` threw the count away and the panel reported turn 0 for a
  // conversation that had reached turn 4.
  const store = new TranscriptStore()
  check('a stored count with no finished turn is installed', store.hydrate('a', { turns: 3 }) === true, 'installed nothing')
  check('and the panel shows the turn it reached', store.view('a').turns === 3, String(store.view('a')?.turns))
  check('and there is no turn to present', store.view('a').previous === undefined, JSON.stringify(store.view('a')?.previous))
  check('a stored state that is not a record installs nothing', store.hydrate('b', { previous: 7 }) === false, 'installed a number')
  check('no record is created for that either', store.view('b') === undefined, JSON.stringify(store.view('b')))
  check('an empty stored state installs nothing', store.hydrate('c', { turns: 0 }) === false, 'installed nothing to say')
}

{
  // A restart lands here with the file unread and a sentence already typed: the
  // host delivers `user/message` before the store's async read comes back, so the
  // open turn is numbered from zero while the file says the conversation had
  // already reached turn one. Adding the count without moving the open turn left
  // `turns: 2` beside an open turn of `1` — and every consumer of that number
  // (`previous.turn`, the sweep record, each path's `turn`) then filed the work
  // under the previous turn. The turn did not exist yet when the process started;
  // the file is what knows it did.
  const store = new TranscriptStore()
  store.record('a', human('one more thing'))
  const opened = store.view('a')
  check('a message before the file is read opens turn one', opened.current?.turn === 1, JSON.stringify(opened.current?.turn))
  store.hydrate('a', { turns: 1, previous: { turn: 1, calls: 2, paths: ['old.js'], commands: [], tools: [], said: 'before the restart' } })
  const renumbered = store.view('a')
  check('the count takes the stored turn on top', renumbered.turns === 2, String(renumbered.turns))
  check(
    'and the open turn is renumbered, not left on the one the file already had',
    renumbered.current?.turn === 2,
    JSON.stringify(renumbered.current?.turn),
  )
  store.record('a', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const folded = store.view('a')
  check(
    'so the finished turn is filed under its own number',
    folded.previous?.turn === 2,
    JSON.stringify(folded.previous?.turn),
  )
  check(
    'and it does not overwrite the turn the file described',
    folded.previous?.said !== 'before the restart',
    JSON.stringify(folded.previous?.said),
  )
}

{
  // The other side of the same guard: with no turn open there is nothing to
  // renumber, and the count must still be taken. A first event that is not a
  // human message is the ordinary case — a reopened session replays its history
  // before anyone types.
  const store = new TranscriptStore()
  store.record('a', { type: 'assistant/message', data: { message: { content: 'replayed' } } })
  store.hydrate('a', { turns: 6, previous: { turn: 6, calls: 0, paths: [], commands: [], tools: [], said: 'earlier' } })
  check('a count is taken with no turn open', store.view('a').turns === 6, String(store.view('a').turns))
  check('and nothing is renumbered', store.view('a').current?.turn === undefined, JSON.stringify(store.view('a').current?.turn))
}

// ---------------------------------------------------------------------------
// Declared outputs.
//
// Everything above is the transcript inferring a path from a call that named
// one. This block is the opposite: a turn that says what it made, because
// nothing it ran named the file. The measured case that started it — a Python
// script writing four files, none of them named on any command line — is what
// the first check below reproduces in miniature.
// ---------------------------------------------------------------------------

{
  check('the report tool is the one name the transcript listens for', REPORT_TOOLS.has('report_output_files') === true, [...REPORT_TOOLS].join(','))

  const store = new TranscriptStore()
  const run = {
    id: 'call-1',
    name: 'report_output_files',
    arguments: { paths: ['F:/test/test8/doc.docx', 'F:/test/test8/image.png'] }
  }
  store.record('a', { type: 'tool/call', data: { callId: run.id, name: run.name, arguments: run.arguments } })
  const reported = store.view('a')?.current
  check('a declared file is recorded', Array.isArray(reported?.paths) && reported.paths.length === 2, JSON.stringify(reported?.paths))
  check('and it keeps the whole list, not just the first', reported?.paths?.includes('F:/test/test8/image.png') === true, 'dropped the second path')

  // A shell call in the same turn stays a separate rule. The report does not
  // replace the redirect parser; both feed the same list.
  store.record('a', { type: 'tool/call', data: { callId: 'call-2', name: 'bash', arguments: { command: 'echo hi > F:/test/redirected.txt' } } })
  const both = store.view('a')?.current
  check('a redirect and a declaration both reach the card', both?.paths?.includes('F:/test/redirected.txt') === true && both?.paths?.includes('F:/test/test8/doc.docx') === true, JSON.stringify(both?.paths))

  // The arguments arrive as raw model output, so the array shape has to be
  // read out of a JSON string too — this is the same trap `readPathArgument`
  // documents, and the same answer.
  store.record('a', { type: 'tool/call', data: { callId: 'call-3', name: 'report_output_files', arguments: '{"paths":["F:/test/from-json.txt"]}' } })
  check('an argument string is parsed before it is read', store.view('a')?.current?.paths?.includes('F:/test/from-json.txt') === true, JSON.stringify(store.view('a')?.current?.paths))

  // A relative path is kept relative. Resolving it needs a workspace, and the
  // transcript does not have one — `api.js` resolves on the way out, where the
  // cwd is known. Recording an unresolved guess here would put a wrong absolute
  // path in a tooltip.
  store.record('a', { type: 'tool/call', data: { callId: 'call-4', name: 'report_output_files', arguments: { paths: ['out/relative.pdf'] } } })
  check('a relative path is recorded as written', store.view('a')?.current?.paths?.includes('out/relative.pdf') === true, JSON.stringify(store.view('a')?.current?.paths))

  // None of the existing rules had to change for the new one to work, and the
  // reverse is also true: the new rule must not fire on an edit call.
  const shaped = new TranscriptStore()
  shaped.record('b', { type: 'tool/call', data: { callId: 'x', name: 'write', arguments: { path: 'a.js', paths: ['ignored.js'] } } })
  check('an edit call is not read as a declaration', shaped.view('b')?.current?.paths?.join(',') === 'a.js', JSON.stringify(shaped.view('b')?.current?.paths))

  // Declaring the same file twice is a model mistake, not a second file.
  const twice = new TranscriptStore()
  twice.record('c', { type: 'tool/call', data: { callId: 'd1', name: 'report_output_files', arguments: { paths: ['F:/test/one.txt', 'F:/test/one.txt'] } } })
  check('the same path declared twice counts once', twice.view('c')?.current?.paths?.length === 1, JSON.stringify(twice.view('c')?.current?.paths))

  // A report is not a substitute for the shell rule, and it is not a licence to
  // record anything at all: non-strings and blanks are dropped on the way in.
  const messy = new TranscriptStore()
  messy.record('d', { type: 'tool/call', data: { callId: 'e1', name: 'report_output_files', arguments: { paths: ['  ', 7, null, 'F:/test/kept.txt'] } } })
  check('only usable entries are recorded', messy.view('d')?.current?.paths?.join(',') === 'F:/test/kept.txt', JSON.stringify(messy.view('d')?.current?.paths))

  // Missing arguments are not an error at collection time — `execute` is what
  // tells the model. The transcript just records nothing.
  const bare = new TranscriptStore()
  bare.record('e', { type: 'tool/call', data: { callId: 'f1', name: 'report_output_files', arguments: {} } })
  check('a declaration with no paths records nothing and does not throw', (bare.view('e')?.current?.paths?.length ?? 0) === 0, JSON.stringify(bare.view('e')?.current?.paths))

  // The per-call cap is 50, but the snapshot keeps 40 — the smaller number is
  // the one a reader sees, and a test that only knew about 50 would be
  // describing a list the panel never receives.
  const many = new TranscriptStore()
  const fifty = Array.from({ length: 60 }, (_, index) => `F:/test/many-${index}.txt`)
  many.record('f', { type: 'tool/call', data: { callId: 'g1', name: 'report_output_files', arguments: { paths: fifty } } })
  check('one declaration stops at the per-call cap', many.view('f')?.current?.paths?.length === 40, String(many.view('f')?.current?.paths?.length))
  check('and the paths kept are the first ones declared', many.view('f')?.current?.paths?.[0] === 'F:/test/many-0.txt', many.view('f')?.current?.paths?.[0])

  // `readPathListArgument` is exported because the cap and the parsing are the
  // two things `report-tool.js` documents and cannot test from the outside.
  check('the list reader stops at the cap', readPathListArgument({ paths: fifty }).length === MAX_REPORTED_PATHS, String(readPathListArgument({ paths: fifty }).length))
  check('the list reader rejects a non-array', readPathListArgument({ paths: 'nope' }).length === 0, 'read a string as a list')
  check('the list reader survives unparseable arguments', readPathListArgument('{not json').length === 0, 'threw on bad json')
  check('the list reader does not read a single path field', readPathListArgument({ path: 'a.js' }).length === 0, 'a single path is not a list')
}

// Presented outputs.
//
// The block above assumes the model calls the tool we gave it. A real run
// showed it does not: asked to produce eight files, it called the host's own
// `present` with three of them and never touched `report_output_files`. That is
// a design mistake on our side, not disobedience — `present` already means
// "these are my deliverables" — so the fix is to read the call that arrives.
//
// The shape differs and that is the whole point of a second reader: `present`
// carries `files: [{ path, description }]`, not `paths: string[]`.
{
  check('the presentation tool is a name the transcript listens for', PRESENT_TOOLS.has('present') === true, [...PRESENT_TOOLS].join(','))

  const store = new TranscriptStore()
  store.record('f', {
    type: 'tool/call',
    data: {
      callId: 'p1',
      name: 'present',
      arguments: {
        files: [
          { path: 'test8/doc.docx', description: 'generated by python-docx' },
          { path: 'test8/archive.zip', description: 'six files' },
        ],
      },
    },
  })
  const shown = store.view('f')?.current?.paths ?? []
  check('a presented file is recorded like a declared one', shown.includes('test8/doc.docx'), JSON.stringify(shown))
  check('every presented file is recorded, not just the first', shown.includes('test8/archive.zip'), JSON.stringify(shown))
  check('the description is not mistaken for a path', shown.every((entry) => entry !== 'generated by python-docx'), JSON.stringify(shown))

  // Both in one turn. They must merge rather than replace: `present` covers the
  // deliverables, `report_output_files` covers everything the turn made, and a
  // turn can legitimately do both.
  const both = new TranscriptStore()
  both.record('f', { type: 'tool/call', data: { callId: 'b1', name: 'present', arguments: { files: [{ path: 'F:/test/one.docx' }] } } })
  both.record('f', { type: 'tool/call', data: { callId: 'b2', name: 'report_output_files', arguments: { paths: ['F:/test/two.png', 'F:/test/three.zip'] } } })
  const merged = both.view('f')?.current?.paths ?? []
  check('a presentation and a declaration both land', merged.includes('F:/test/one.docx') && merged.includes('F:/test/two.png'), JSON.stringify(merged))
  check('and neither is dropped for the other', merged.length === 3, JSON.stringify(merged))

  // A path presented twice is still one row: the snapshot de-duplicates, as it
  // does for every other source.
  const twice = new TranscriptStore()
  twice.record('f', { type: 'tool/call', data: { callId: 't1', name: 'present', arguments: { files: [{ path: 'F:/test/same.txt' }] } } })
  twice.record('f', { type: 'tool/call', data: { callId: 't2', name: 'present', arguments: { files: [{ path: 'F:/test/same.txt' }] } } })
  check('a file presented twice is one row', (twice.view('f')?.current?.paths ?? []).length === 1, JSON.stringify(twice.view('f')?.current?.paths))

  // A path the turn had already collected must survive the presentation. This
  // is the failure that looks fine: replacing the list instead of adding to it
  // still shows the presented files, and quietly forgets every file the turn
  // edited before the model said anything.
  const keeps = new TranscriptStore()
  keeps.record('f', { type: 'tool/call', data: { callId: 'k1', name: 'write', arguments: { path: 'F:/src/keep.js' } } })
  keeps.record('f', { type: 'tool/call', data: { callId: 'k2', name: 'present', arguments: { files: [{ path: 'F:/out/card.docx' }] } } })
  const kept = keeps.view('f')?.current?.paths ?? []
  check('a presentation adds to the turn, it does not replace it', kept.includes('F:/src/keep.js') && kept.includes('F:/out/card.docx'), JSON.stringify(kept))

  // Order matters at the cap, and it matters against the obvious reading.
  // `snapshot` keeps the first forty; a shell redirect is seen early, a
  // declaration is the last call of the turn. Keeping call order would drop the
  // declared files of exactly the busiest turns.
  const busy = new TranscriptStore()
  for (let index = 0; index < 45; index += 1) {
    busy.record('f', { type: 'tool/call', data: { callId: `s${index}`, name: 'write', arguments: { path: `F:/filled/${index}.txt` } } })
  }
  busy.record('f', { type: 'tool/call', data: { callId: 'last', name: 'present', arguments: { files: [{ path: 'F:/out/named.docx' }] } } })
  const crowded = busy.view('f')?.current?.paths ?? []
  check('a busy turn still shows what the model named', crowded.includes('F:/out/named.docx'), JSON.stringify(crowded.slice(-3)))
  check('and the cap is still forty rows', crowded.length === 40, String(crowded.length))

  // The reader itself. JSON-in-a-string is the shape `tool/call` actually
  // carries, so it is the shape that has to work.
  check('the presentation reader accepts JSON in a string', readPresentedPaths(JSON.stringify({ files: [{ path: 'a/b.png' }] })).length === 1, 'did not parse the string form')
  check('and a call carrying a JSON string is read end to end', (() => {
    const wire = new TranscriptStore()
    wire.record('f', { type: 'tool/call', data: { callId: 'w1', name: 'present', arguments: JSON.stringify({ files: [{ path: 'F:/out/wired.pdf' }] }) } })
    return (wire.view('f')?.current?.paths ?? []).includes('F:/out/wired.pdf')
  })(), 'the string form works in isolation but not through a call')
  check('the presentation reader skips entries without a path', readPresentedPaths({ files: [{ description: 'no path here' }, { path: 'ok.txt' }] }).length === 1, 'kept a pathless entry')
  check('the presentation reader skips a bare string entry', readPresentedPaths({ files: ['nope.txt'] }).length === 0, 'read a string as a file object')
  check('the presentation reader rejects a missing files array', readPresentedPaths({ paths: ['a.txt'] }).length === 0, 'read the wrong field name')
  // Not just absent: present with the wrong *type* under the right key. The
  // guard has to be `Array.isArray`, not `=== undefined`, or this throws inside
  // transcript recording and takes the whole panel down with it.
  //
  // These three call the reader through `survives` rather than directly. A
  // guard that is too weak throws, and a direct call would take the whole test
  // file down with it — the suite would report CRASHED, which a mutation runner
  // counts as neither killed nor clean. Catching here turns the same regression
  // into an ordinary failed assertion, which is what it is.
  const survives = (fn) => {
    try {
      return { threw: false, value: fn() }
    } catch (error) {
      return { threw: true, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const wrongType = survives(() => readPresentedPaths({ files: {} }))
  check('the presentation reader rejects a files field that is not an array', wrongType.threw === false && wrongType.value.length === 0, wrongType.threw === true ? `threw: ${wrongType.error}` : 'iterated a non-array')
  const arrayish = survives(() => readPresentedPaths({ files: 'nope' }))
  check('and one that is an array-shaped string', arrayish.threw === false && arrayish.value.length === 0, arrayish.threw === true ? `threw: ${arrayish.error}` : 'iterated a string')
  check('the presentation reader survives unparseable arguments', readPresentedPaths('{not json').length === 0, 'threw on bad json')
  check('the presentation reader survives a non-object', readPresentedPaths('5').length === 0, 'threw on a number')
  const nulled = survives(() => readPresentedPaths(null))
  check('the presentation reader survives null', nulled.threw === false && nulled.value.length === 0, nulled.threw === true ? `threw: ${nulled.error}` : 'threw on null')
  check('a whitespace path is not a file', readPresentedPaths({ files: [{ path: '   ' }] }).length === 0, 'kept a blank path')
  check('a presented path is trimmed before it is recorded', readPresentedPaths({ files: [{ path: '  F:/out/report.docx  ' }] })[0] === 'F:/out/report.docx', 'kept the padding, which no longer opens')
  // Only `present` is a presentation. A tool that happens to carry a `files`
  // array is not, and a branch that skips the name check records it anyway.
  check('a tool that is not present is not read as one', (() => {
    const other = new TranscriptStore()
    other.record('f', { type: 'tool/call', data: { callId: 'o1', name: 'report_output_files', arguments: { files: [{ path: 'F:/out/other.txt' }] } } })
    return (other.view('f')?.current?.paths ?? []).includes('F:/out/other.txt') === false
  })(), 'read files from a tool that is not the presentation tool')
  check('a present call with no arguments does not throw', (() => {
    const empty = new TranscriptStore()
    empty.record('f', { type: 'tool/call', data: { callId: 'e1', name: 'present' } })
    return (empty.view('f')?.current?.paths ?? []).length === 0
  })(), 'threw or invented a path')
  check('a present call with more entries than the cap keeps the cap', readPresentedPaths({ files: Array.from({ length: 60 }, (unused, index) => ({ path: `p/${index}.txt` })) }).length === MAX_REPORTED_PATHS, 'did not stop at the cap')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
