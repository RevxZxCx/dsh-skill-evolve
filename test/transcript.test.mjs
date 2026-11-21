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
  MAX_CALLS_PER_TURN,
  MAX_REPORTED_PATHS,
  MAX_SAID_BLOCKS,
  MAX_SAID_CHARS,
  PRESENT_TOOLS,
  PRESENTED_EVENT,
  REPORT_TOOLS,
  SHELL_TOOLS,
  Transcript,
  TranscriptStore,
  readCommandArgument,
  readPathArgument,
  readPathListArgument,
  readPresentedEntries,
  readPresentedEvent,
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
  // Neither a read nor an edit is a delivered file any more. The card answers
  // "what did this turn hand me", and a model editing `a.js` handed nobody
  // anything -- it changed the repository, which is what git is for.
  check('an edited path is not a delivered file', view.previous.paths.includes('F:\\src\\a.js') === false, JSON.stringify(view.previous.paths))
  check('a read-only path is not reported either', view.previous.paths.includes('F:\\src\\read-only.js') === false, JSON.stringify(view.previous.paths))
  check('and a turn that delivered nothing has an empty list', view.previous.paths.length === 0, JSON.stringify(view.previous.paths))
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
  // A shell call names a command, not a path, and this build deliberately does
  // not read paths out of one. The old rule did -- it parsed redirects, `tee`,
  // `curl -o` -- and on one real 175-file session that produced 130 rows of
  // scripts nobody would ever open. What replaced it is a declaration: the model
  // says which files it is delivering, and the card believes it.
  const store = new TranscriptStore()
  store.record('a', human('write a probe'))
  store.record('a', call('bash', { command: "cat > scripts/probe.py <<'EOF'\nprint(1)\nEOF" }, 's1'))
  store.record('a', result('s1', true))
  store.record('a', said('Written.'))
  store.record('a', endTurn())

  const view = store.view('a')
  check('a redirect names no delivered file', view.previous.paths.length === 0, JSON.stringify(view.previous.paths))

  // The same turn, but the model declared the file. Now it is on the card.
  const declared = new TranscriptStore()
  declared.record('b', human('write a probe'))
  declared.record('b', call('report_output_files', { paths: ['scripts/probe.py'] }, 'r1'))
  declared.record('b', result('r1', true))
  declared.record('b', endTurn())
  check('a declared file is', declared.view('b').previous.paths.includes('scripts/probe.py'), JSON.stringify(declared.view('b').previous.paths))
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
// Reading a delivery: the event, the call, and the entries neither may invent
// ---------------------------------------------------------------------------
//
// Both the host's `deliverables/presented` event and a `present` call carry the
// same `{ files: [{ path, description }] }` bag, and both are read by one
// function so they cannot drift. The failure modes below are all about a bag
// that is *nearly* right: the model wrote a path with a newline, the host sent a
// string where an array belongs, an entry arrived without a description.

{
  const read = (raw) => readPresentedEntries(raw)
  // A reader that throws on the shape it is supposed to reject is a bug, and
  // the test has to say so. Calling it bare would let the throw escape and end
  // the file before the tally prints -- the runner calls that CRASHED, and a
  // crash looks like a broken fixture rather than a caught defect.
  const survives = (raw) => {
    try {
      return read(raw)
    } catch {
      return 'threw'
    }
  }

  // A well-formed bag is read whole, description and all.
  const good = read(JSON.stringify({ files: [{ path: 'a.md', description: 'the plan' }] }))
  check('a delivery is read from a JSON string', good.length === 1 && good[0].path === 'a.md', JSON.stringify(good))
  check('and it keeps the sentence it carried', good[0]?.description === 'the plan', JSON.stringify(good))

  const fromObject = read({ files: [{ path: 'b.md' }] })
  check('a delivery is read from an object too', fromObject.length === 1, JSON.stringify(fromObject))
  check('and a missing description becomes nothing, not the word undefined', fromObject[0]?.description === '', JSON.stringify(fromObject))

  // A path with whitespace around it is the same file. Keeping the whitespace
  // would make it a different key from the same path without it, and the card
  // would list one file twice.
  const padded = read({ files: [{ path: '  c.md\n', description: '  padded  ' }] })
  check('a padded path is trimmed', padded[0]?.path === 'c.md', JSON.stringify(padded))
  check('and so is the sentence beside it', padded[0]?.description === 'padded', JSON.stringify(padded))

  // A blank path names no file, so it is not a row.
  check('a blank path is not a row', read({ files: [{ path: '   ' }] }).length === 0)
  check('a non-string path is not a row', read({ files: [{ path: 42 }] }).length === 0, JSON.stringify(read({ files: [{ path: 42 }] })))
  check('a bare string entry is not a row', read({ files: ['a.md'] }).length === 0, JSON.stringify(read({ files: ['a.md'] })))
  // A null entry is the shape that separates the object guard from a crash:
  // `typeof null === 'object'`, so a guard that forgets the null check reaches
  // `row.path` and throws inside the event handler.
  const nullEntry = survives({ files: [null] })
  check('a null entry is not a row', Array.isArray(nullEntry) && nullEntry.length === 0, JSON.stringify(nullEntry))

  // The bag itself: `files` has to be an array, and the value has to be an
  // object. A string where an array belongs is a shape no host sends, and
  // reading it anyway would turn a malformed event into rows.
  check('a missing files field yields nothing', read({ other: 1 }).length === 0)
  check('a files field that is not an array yields nothing', read({ files: 'a.md' }).length === 0, JSON.stringify(read({ files: 'a.md' })))
  // An object under `files` is not iterable, so `for..of` throws. The string
  // above iterates into characters and answers [] with or without the array
  // check, which makes it the weaker of the two inputs.
  const objectBag = survives({ files: { a: 1 } })
  check('and an object under files yields nothing rather than throwing', Array.isArray(objectBag) && objectBag.length === 0, JSON.stringify(objectBag))
  const nulled = survives(null)
  check('a null argument yields nothing', Array.isArray(nulled) && nulled.length === 0, JSON.stringify(nulled))
  const arrayed = survives([{ path: 'a.md' }])
  check('an array argument yields nothing', Array.isArray(arrayed) && arrayed.length === 0, JSON.stringify(arrayed))
  check('unparseable text yields nothing', read('not json').length === 0)
  check('the list is capped', read({ files: Array.from({ length: MAX_REPORTED_PATHS + 20 }, (_, at) => ({ path: `f${at}.md` })) }).length === MAX_REPORTED_PATHS, String(read({ files: Array.from({ length: MAX_REPORTED_PATHS + 20 }, (_, at) => ({ path: `f${at}.md` })) }).length))
}

{
  // The event is the host's own announcement, and it is read through the same
  // reader as the call. The event is the structured copy: the call's arguments
  // are text the host may have truncated, the event is data.
  const fromEvent = readPresentedEvent({ turn: 3, callId: 'c1', files: [{ path: 'from-event.md', description: 'the event' }] })
  check('a delivery is read from the event', fromEvent.length === 1 && fromEvent[0].path === 'from-event.md', JSON.stringify(fromEvent))
  check('and the event carries the sentence too', fromEvent[0]?.description === 'the event', JSON.stringify(fromEvent))
  check('an event with no files yields nothing', readPresentedEvent({ turn: 3 }).length === 0)
  check('an undefined event payload yields nothing', readPresentedEvent(undefined).length === 0)

  // A turn that ends after the event has the file on the card. This is the
  // whole path: the event arrives mid-turn, the turn ends, the snapshot is read.
  const store = new TranscriptStore()
  store.record('e', human('hand over the plan'))
  store.record('e', { type: PRESENTED_EVENT, data: { turn: 1, callId: 'c1', files: [{ path: 'F:/work/plan.md', description: '定稿方案' }] } })
  store.record('e', endTurn())
  const view = store.view('e')
  check('the event reaches the card', view.previous.paths.includes('F:\\work\\plan.md'), JSON.stringify(view.previous.paths))
  check('and the sentence reaches it with the path', view.previous.delivered?.[0]?.description === '定稿方案', JSON.stringify(view.previous.delivered))
}

{
  // A turn that announces the same file twice lists it once. The host emits one
  // event per `present` call, and a model that hands over the same document in
  // two steps should not produce two rows -- the second row would also carry an
  // empty description, so the card would show the file twice, once described
  // and once not.
  const store = new TranscriptStore()
  store.record('d', human('hand it over twice'))
  store.record('d', { type: PRESENTED_EVENT, data: { files: [{ path: 'F:/work/plan.md', description: '第一次说' }] } })
  store.record('d', { type: PRESENTED_EVENT, data: { files: [{ path: 'F:/work/plan.md' }] } })
  store.record('d', endTurn())
  const view = store.view('d')
  check('the same file announced twice is one row', view.previous.paths.length === 1, JSON.stringify(view.previous.paths))

  // The blank announcement must not erase what the first one said. The host
  // announces per call and only the first carries the description; a later one
  // with no description arriving second would wipe the sentence.
  check('and the later blank announcement keeps the sentence', view.previous.delivered?.[0]?.description === '第一次说', JSON.stringify(view.previous.delivered))

  // A later announcement that does carry a description replaces it: the newest
  // thing the model said about the file is the true one.
  const replaced = new TranscriptStore()
  replaced.record('r', human('hand it over twice'))
  replaced.record('r', { type: PRESENTED_EVENT, data: { files: [{ path: 'F:/work/plan.md', description: '旧' }] } })
  replaced.record('r', { type: PRESENTED_EVENT, data: { files: [{ path: 'F:/work/plan.md', description: '新' }] } })
  replaced.record('r', endTurn())
  check('a newer sentence replaces the older one', replaced.view('r').previous.delivered?.[0]?.description === '新', JSON.stringify(replaced.view('r').previous.delivered))
}

{
  // The call and the event are both read, and `deliver` drops the duplicate.
  // Reading only one of them would mean a host build that emits the event and a
  // build that does not each lose half the deliveries; the event is the
  // structured copy and the call is the fallback, so both paths are live.
  const store = new TranscriptStore()
  store.record('b', human('declare then announce'))
  // The host's event is its own copy of the same call, so the sentence is the
  // same in both. A fixture that gave them different text would be testing
  // which of two copies wins, and no host produces that.
  store.record('b', call('present', { files: [{ path: 'F:/work/a.md', description: 'the plan' }] }, 'p1'))
  store.record('b', { type: PRESENTED_EVENT, data: { files: [{ path: 'F:/work/a.md', description: 'the plan' }] } })
  store.record('b', endTurn())
  const view = store.view('b')
  check('the call alone puts the file on the card', view.previous.paths.includes('F:\\work\\a.md'), JSON.stringify(view.previous.paths))
  check('and the event does not add a second row', view.previous.paths.length === 1, JSON.stringify(view.previous.paths))
  check('the sentence survives the duplicate', view.previous.delivered?.[0]?.description === 'the plan', JSON.stringify(view.previous.delivered))
}

// ---------------------------------------------------------------------------
// Deduplication and caps
// ---------------------------------------------------------------------------

{
  // Only the tools whose arguments *are* a delivery are read as one. Several
  // tools take an array of files for their own reasons, and reading all of them
  // would fill the card with files nothing handed over.
  const store = new TranscriptStore()
  store.record('n', human('run something that happens to name files'))
  store.record('n', call('bash', { command: 'ls', files: [{ path: 'F:/work/incidental.md' }] }, 'x1'))
  store.record('n', call('todo_write', { files: [{ path: 'F:/work/also-not.md' }] }, 'x2'))
  store.record('n', endTurn())
  const view = store.view('n')
  check('a tool that is not a delivery tool contributes no row', view.previous.paths.length === 0, JSON.stringify(view.previous.paths))

  // The cap keeps the first forty in the order they were announced. A busy turn
  // announces early and late, and the late ones are the model's own words.
  const capped = new TranscriptStore()
  capped.record('c', human('hand over more than the card can hold'))
  for (let i = 0; i < MAX_REPORTED_PATHS + 5; i += 1) capped.record('c', call('report_output_files', { paths: [`F:/work/f${i}.md`] }, `p${i}`))
  capped.record('c', endTurn())
  const kept = capped.view('c').previous.paths
  check('the cap keeps the first files announced, not the last', kept.length === MAX_REPORTED_PATHS && kept[0] === 'F:\\work\\f0.md' && kept.includes('F:\\work\\f44.md') === false, JSON.stringify([kept.length, kept[0], kept.includes('F:\\work\\f44.md')]))
}

{
  // A turn that hands over one file, then another, has two rows. Assigning the
  // second announcement over the first still leaves a card that looks right --
  // it shows a file -- while the first one is gone.
  const store = new TranscriptStore()
  store.record('s', human('hand over two things'))
  store.record('s', call('present', { files: [{ path: 'F:/work/first.md', description: '第一份' }] }, 'q1'))
  store.record('s', call('present', { files: [{ path: 'F:/work/second.md', description: '第二份' }] }, 'q2'))
  store.record('s', endTurn())
  const view = store.view('s')
  check('two announcements leave two rows', view.previous.paths.length === 2, JSON.stringify(view.previous.paths))
  check('and the first one is still there', view.previous.paths.includes('F:\\work\\first.md'), JSON.stringify(view.previous.paths))
  check('with the sentence it was handed over with', view.previous.delivered?.map((one) => one.description).join('|') === '第一份|第二份', JSON.stringify(view.previous.delivered))
}


{
  const store = new TranscriptStore()
  store.record('a', human('deliver the same file'))
  for (let i = 0; i < 5; i += 1) {
    store.record('a', call('report_output_files', { paths: ['F:/same.md'] }, `c${i}`))
    store.record('a', result(`c${i}`, true))
  }
  store.record('a', endTurn())
  const paths = store.view('a').previous.paths
  check('a file delivered five times is listed once', paths.length === 1, JSON.stringify(paths))
  check('the five declarations still count as five calls', store.view('a').previous.calls === 5, String(store.view('a').previous.calls))
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
  check('and it keeps the whole list, not just the first', reported?.paths?.includes('F:\\test\\test8\\image.png') === true, 'dropped the second path')

  // A shell call in the same turn adds nothing. The redirect parser that used to
  // read `echo hi > x.txt` is gone: a command says what it ran, not what it
  // delivered, and the model is the only thing that knows the difference.
  store.record('a', { type: 'tool/call', data: { callId: 'call-2', name: 'bash', arguments: { command: 'echo hi > F:/test/redirected.txt' } } })
  const both = store.view('a')?.current
  check('a redirect adds no row of its own', both?.paths?.includes('F:\\test\\redirected.txt') === false, JSON.stringify(both?.paths))
  check('and the declaration is still there', both?.paths?.includes('F:\\test\\test8\\doc.docx') === true, JSON.stringify(both?.paths))

  // The arguments arrive as raw model output, so the array shape has to be
  // read out of a JSON string too — this is the same trap `readPathArgument`
  // documents, and the same answer.
  store.record('a', { type: 'tool/call', data: { callId: 'call-3', name: 'report_output_files', arguments: '{"paths":["F:/test/from-json.txt"]}' } })
  check('an argument string is parsed before it is read', store.view('a')?.current?.paths?.includes('F:\\test\\from-json.txt') === true, JSON.stringify(store.view('a')?.current?.paths))

  // A relative path is kept relative. Resolving it needs a workspace, and the
  // transcript does not have one — `api.js` resolves on the way out, where the
  // cwd is known. Recording an unresolved guess here would put a wrong absolute
  // path in a tooltip.
  store.record('a', { type: 'tool/call', data: { callId: 'call-4', name: 'report_output_files', arguments: { paths: ['out/relative.pdf'] } } })
  check('a relative path is recorded as written', store.view('a')?.current?.paths?.includes('out/relative.pdf') === true, JSON.stringify(store.view('a')?.current?.paths))

  // An edit call names nothing. This is the change that matters most: a model
  // rewriting `client.js` twelve times used to put twelve rows on the card, and
  // none of them was something a reader would open.
  const shaped = new TranscriptStore()
  shaped.record('b', { type: 'tool/call', data: { callId: 'x', name: 'write', arguments: { path: 'a.js', paths: ['ignored.js'] } } })
  check('an edit call is not read as a declaration', (shaped.view('b')?.current?.paths?.length ?? 0) === 0, JSON.stringify(shaped.view('b')?.current?.paths))
  const edited = new TranscriptStore()
  edited.record('b', { type: 'tool/call', data: { callId: 'y', name: 'edit', arguments: { file_path: 'a.js' } } })
  check('nor is an edit call', (edited.view('b')?.current?.paths?.length ?? 0) === 0, JSON.stringify(edited.view('b')?.current?.paths))

  // Declaring the same file twice is a model mistake, not a second file.
  const twice = new TranscriptStore()
  twice.record('c', { type: 'tool/call', data: { callId: 'd1', name: 'report_output_files', arguments: { paths: ['F:/test/one.txt', 'F:/test/one.txt'] } } })
  check('the same path declared twice counts once', twice.view('c')?.current?.paths?.length === 1, JSON.stringify(twice.view('c')?.current?.paths))

  // A report is not a substitute for the shell rule, and it is not a licence to
  // record anything at all: non-strings and blanks are dropped on the way in.
  const messy = new TranscriptStore()
  messy.record('d', { type: 'tool/call', data: { callId: 'e1', name: 'report_output_files', arguments: { paths: ['  ', 7, null, 'F:/test/kept.txt'] } } })
  check('only usable entries are recorded', messy.view('d')?.current?.paths?.join(',') === 'F:\\test\\kept.txt', JSON.stringify(messy.view('d')?.current?.paths))

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
  check('and the paths kept are the first ones declared', many.view('f')?.current?.paths?.[0] === 'F:\\test\\many-0.txt', many.view('f')?.current?.paths?.[0])

  // `readPathListArgument` is exported because the cap and the parsing are the
  // two things `report-tool.js` documents and cannot test from the outside.
  check('the list reader stops at the cap', readPathListArgument({ paths: fifty }).length === MAX_REPORTED_PATHS, String(readPathListArgument({ paths: fifty }).length))
  check('the list reader rejects a non-array', readPathListArgument({ paths: 'nope' }).length === 0, 'read a string as a list')
  check('the list reader survives unparseable arguments', readPathListArgument('{not json').length === 0, 'threw on bad json')
  check('the list reader does not read a single path field', readPathListArgument({ path: 'a.js' }).length === 0, 'a single path is not a list')

  // A blank entry is not a file, and the list reader needs its own assertion
  // for that: the object reader's blank check is a different line in a
  // different function, so proving one of them says nothing about the other.
  const withBlanks = readPathListArgument({ paths: ['', '   ', 'F:/work/real.md'] })
  check('the list reader drops a blank entry', withBlanks.length === 1, JSON.stringify(withBlanks))
  check('and keeps the one that names a file', withBlanks[0] === 'F:/work/real.md', JSON.stringify(withBlanks))
  check('a list of nothing but blanks is empty', readPathListArgument({ paths: ['', '  '] }).length === 0, JSON.stringify(readPathListArgument({ paths: ['', '  '] })))
}


{
  // The delivered list is bounded, and it is bounded by dropping the newest
  // rather than evicting the oldest. That direction is deliberate: `snapshot()`
  // takes the first `MAX_CARD_PATHS`, so an eviction would change rows the card
  // has already been showing, while a drop only loses rows that never appeared.
  const capped = new TranscriptStore()
  capped.record('agent-cap', human('hand over more than the card can hold'))
  const ceiling = MAX_REPORTED_PATHS * 4
  for (let i = 0; i < ceiling + 30; i += 1) {
    capped.record('agent-cap', call('report_output_files', { paths: [`F:/work/f${i}.md`] }, `p${i}`))
  }
  // Read from the transcript itself, not from the snapshot: the snapshot is
  // capped at MAX_CARD_PATHS by design, so it reports 40 whatever the store
  // holds, and an assertion against it can never see whether the store has a
  // ceiling at all.
  const held = capped.for('agent-cap').delivered
  const kept = capped.view('agent-cap').current.delivered
  check('the delivered list has a ceiling', held.length === ceiling, String(held.length))
  check('and the card still sees only the first page of it', kept.length === MAX_REPORTED_PATHS, String(kept.length))
  // Read the ends only after proving there are ends. `held[0].path` on an empty
  // list throws, and a throw here ends the file before the tally prints -- which
  // the mutation runner reports as CRASHED, a different verdict from KILLED.
  const first = held[0]?.path
  const last = held[held.length - 1]?.path
  check(
    'and the ceiling keeps the first files rather than the last',
    first === 'F:\\work\\f0.md' && last === `F:\\work\\f${ceiling - 1}.md`,
    JSON.stringify([first, last]),
  )
  check(
    'and a file past the ceiling is not silently in the list',
    held.some((entry) => entry.path === `F:\\work\\f${ceiling + 29}.md`) === false,
    'a file past the ceiling got in',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
