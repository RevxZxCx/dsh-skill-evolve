/**
 * Session transcript bookkeeping for the panel.
 *
 * The panel shows three things about the session a person is looking at: what
 * the previous turn did, which skills and MCP servers are on offer, and which
 * files the work touched. None of that needs the host's session store: the
 * plugin already receives every `session/event`, so this module keeps a small
 * per-agent transcript as those events arrive.
 *
 * Why not read the host's log instead:
 *
 * - `sessionQuery` is built for searching *past* sessions across the corpus,
 *   not for the live one a person is watching. Asking it to observe the
 *   current session means re-reading a file the process is still appending to.
 * - A live transcript is already in this process's memory by the time the
 *   panel asks. Re-deriving it would be slower and could disagree with what the
 *   plugin itself acted on this turn.
 *
 * The cost is bounded on purpose. A session that runs for hours must not
 * accumulate an unbounded copy of itself, so only the current turn is kept in
 * full and everything older is reduced to a one-line summary as soon as the
 * turn ends.
 */

import { canonicalPath } from '@revxz/dsh-evolve-core'

/** How many tool calls one turn keeps before it stops recording detail. */
const MAX_CALLS_PER_TURN = 200

/**
 * How much assistant text one turn keeps.
 *
 * The panel shows a two-paragraph summary of the turn; anything past this is
 * never rendered, so holding it is pure cost. A long turn emits hundreds of
 * text blocks and the plugin kept every one of them for the whole session.
 */
const MAX_SAID_BLOCKS = 40

/** Longest single assistant text block that is kept, in characters. */
const MAX_SAID_CHARS = 2000

/**
 * How much of the user's own message one turn keeps, in characters.
 *
 * Same order as the per-message cap the prompt already applies to transcript
 * material, and deliberately small: a person asking a question types a sentence
 * or two, and a turn that opened by pasting a file is not asking anything the
 * rest of the body does not already describe. Keeping more would only push
 * assistant prose out of `MAX_INPUT_CHARS`.
 */
const MAX_ASKED_CHARS = 600

/**
 * Shell tools, kept only so the summary can quote what a turn ran.
 *
 * This used to be a file source as well: `writtenPaths` parsed the command for
 * redirects and `tee` targets. That is gone with the rest of the inference, but
 * the command text still belongs in the turn summary, which describes what
 * happened rather than what was handed over.
 */
const SHELL_TOOLS = new Set(['bash', 'ops_bash', 'shell', 'terminal', 'exec', 'run', 'pwsh', 'powershell'])

/**
 * The tools through which a turn says what it delivered.
 *
 * Two, because a turn can say it in two ways and the host gives each one a
 * different amount of structure.
 *
 * `present` is the host's own delivery call: it emits a `deliverables/presented`
 * event carrying `{ path, description }` for each file, and the host's own
 * `ui-deliverables` plugin renders those same events in the conversation. Its
 * arguments are read here as a fallback for a host build that does not emit the
 * event, and the event is preferred when both exist because the event carries
 * the description the model wrote and cannot be truncated by argument limits.
 *
 * `report_output_files` is this plugin's own tool, for the case the host's does
 * not cover: more than four files.
 *
 * ## What is deliberately gone
 *
 * An earlier version also read `edit` arguments and parsed shell commands for
 * redirects, so a turn that never declared anything still produced rows. Both
 * were removed when the card was narrowed to delivered documents, and the
 * measurement that justified removing them is worth keeping: on one session
 * the three collectors produced thirty-nine rows, of which three were documents
 * a person would open, twenty-four no longer existed, and eleven belonged to a
 * different conversation. Reading a path out of an `edit` answers "what did this
 * turn touch", which is a different question from "what did this turn hand me",
 * and the card only ever meant to answer the second.
 */
const REPORT_TOOLS = new Set(['report_output_files'])

/**
 * How many file rows one turn's card can hold.
 *
 * This is the sink: {@link Transcript#snapshot} merges declarations and
 * inferences and keeps this many. Every other limit in the system is this
 * number, not an independent one — a declaration cap above it would accept a
 * call, report success, and then quietly lose the tail. That is the specific
 * bug this constant exists to make impossible: one budget, stated once.
 */
const MAX_CARD_PATHS = 40

/**
 * How many deliveries one turn may hold in memory.
 *
 * `MAX_CARD_PATHS` trims the snapshot, not the list, so a turn that announces
 * the same set repeatedly kept growing the array while the card showed forty
 * rows. Four times the card is the room given: enough that a busy turn is not
 * truncated, small enough that the linear dedupe in `deliver` cannot be made to
 * walk a list a model grew on purpose.
 */
const MAX_DELIVERED_ENTRIES = MAX_CARD_PATHS * 4

/**
 * How many declared paths one call may contribute.
 *
 * A model that lists two hundred files has misunderstood the tool, and a card
 * that grew by two hundred rows would be the wrong answer to that. The limit is
 * applied per call rather than per turn so a session that declares in three
 * batches still records all three — each batch gets the same room, and the card
 * decides what survives.
 *
 * Equal to {@link MAX_CARD_PATHS} on purpose. When these were two numbers (50
 * here, 40 downstream) a schema-legal fifty-item call was truncated by the card
 * while the tool answered `{ ok: true, recorded: 50 }`. One number, or the
 * promise is written by one module and broken by another.
 */
const MAX_REPORTED_PATHS = MAX_CARD_PATHS

/**
 * Pull a list of filesystem paths out of a tool's arguments.
 *
 * Separate from {@link readPathArgument} on purpose. That one answers "which
 * single file does this call name", and a `paths` array is not that question —
 * teaching it to return an array would change the type every existing caller
 * already branches on.
 *
 * Accepts the same JSON-in-a-string shape, drops anything that is not a
 * non-empty string, and stops at {@link MAX_REPORTED_PATHS}. Duplicates are not
 * removed here: the transcript already de-duplicates on snapshot, and doing it
 * twice would hide which call declared what.
 *
 * @param {unknown} raw - the tool call arguments.
 * @returns {string[]} the paths found, possibly empty.
 */
function readPathListArgument(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const bag = /** @type {Record<string, unknown>} */ (value)
  const list = bag.paths
  if (!Array.isArray(list)) return []
  const found = []
  for (const entry of list) {
    if (found.length >= MAX_REPORTED_PATHS) break
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length > 0) found.push(trimmed)
  }
  return found
}

/**
 * The host's delivery call, read from the call as well as from its event.
 *
 * Added after a real run rather than in theory. A turn that wrote eight files
 * through a script was given `report_output_files` and did not call it once; it
 * called `present` with three of them instead. That is not disobedience — the
 * host's own `present` means "declare existing files as final deliverables",
 * which is exactly what the model was trying to say. Two tools with overlapping
 * meaning is a design mistake, and the fix is not to argue with the model: it is
 * to read the call it already makes.
 */
const PRESENT_TOOLS = new Set(['present'])

/**
 * The event the host emits when a turn presents files.
 *
 * Preferred over the call's arguments whenever it arrives, for three reasons:
 * it is already parsed, so a call whose arguments were truncated by a log cap
 * still reports every file; it carries `description`, which the model wrote and
 * nothing else in the transcript knows; and it is the same event the host's own
 * deliverables plugin reads, so the sidebar and the conversation tail cannot
 * disagree about what was delivered.
 */
const PRESENTED_EVENT = 'deliverables/presented'

/**
 * The tools that write a file, used only when a turn declared nothing.
 *
 * ## Why this is back after being removed
 *
 * The removal was justified by a measurement: on one session three collectors
 * produced thirty-nine rows, of which three were documents, and reading a path
 * out of an `edit` answers "what did this turn touch" rather than "what did
 * this turn hand me". That reasoning was right about the question and never
 * measured the cost of the answer, and the cost turned out to be most of the
 * card: across eighteen turns of six real sessions, eight wrote a deliverable
 * document and four of them declared it. The other four wrote the document and
 * said nothing, so the card was blank for a turn that plainly produced
 * something.
 *
 * So this is not the old collector coming back. The old one ran on every turn
 * and merged with the declarations. This one answers only the question a blank
 * card cannot: "the turn said nothing -- did it write anything at all?" A turn
 * that declares even one file ignores this channel entirely, which is the shape
 * Qoder settled on: its entry point returns the declared set as soon as that
 * set is non-empty and never merges the two.
 *
 * ## What it reads, and what it refuses
 *
 * The path comes from the result, never from the arguments. `tool/result`
 * carries `meta.path`, an absolute path the host resolved; the call's
 * `file_path` is whatever the model typed and is frequently relative to a
 * working directory this module does not know. A result the host marked as
 * failed contributes nothing -- `write` against a file the model has not read
 * fails with `FS_NOT_OBSERVED`, and recording that call would put a row on the
 * card for a file that was never written.
 */
const MUTATION_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/**
 * Whether a path already names a place without a working directory.
 *
 * Only paths the host resolved are joined against the session's cwd, so a
 * relative path here means the host did not resolve it -- and guessing a base
 * would put a row on the card at a location that has nothing to do with the
 * file. Backslash-first is included because a UNC path has no drive letter.
 */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/

/**
 * Read `meta.path` off a `tool/result`, when it names an absolute path.
 *
 * @param {any} data - the `tool/result` payload.
 * @returns {string | undefined} the path, when the host resolved one.
 */
function readProducedPath(data) {
  const path = data?.meta?.path
  if (typeof path !== 'string') return undefined
  const trimmed = path.trim()
  if (trimmed.length === 0) return undefined
  if (ABSOLUTE_PATH.test(trimmed) === false) return undefined
  return trimmed
}


/**
 * Pull delivered files out of a `present`-shaped argument bag, with what was
 * said about each one.
 *
 * The shape is `{ files: [{ path, description }] }`. `description` is optional
 * and becomes `''` when absent or wrong-typed: a row with no second line is
 * correct, and one quoting `[object Object]` is not.
 *
 * @param {unknown} raw - the tool call arguments.
 * @returns {Array<{ path: string, description: string }>} the entries, possibly empty.
 */
function readPresentedEntries(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const bag = /** @type {Record<string, unknown>} */ (value)
  const list = bag.files
  if (!Array.isArray(list)) return []
  const found = []
  for (const entry of list) {
    if (found.length >= MAX_REPORTED_PATHS) break
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = /** @type {Record<string, unknown>} */ (entry)
    if (typeof row.path !== 'string') continue
    const path = row.path.trim()
    if (path.length === 0) continue
    const description = typeof row.description === 'string' ? row.description.trim() : ''
    found.push({ path, description })
  }
  return found
}

/**
 * Read the files out of a `deliverables/presented` event.
 *
 * The same shape as the call's arguments, and read by the same function, so the
 * two cannot drift: the event is the host's copy of what the model said, and a
 * host build that validates one but not the other would otherwise produce a row
 * from the event that the call would have refused.
 *
 * @param {any} data - the event payload.
 * @returns {Array<{ path: string, description: string }>} the entries, possibly empty.
 */
function readPresentedEvent(data) {
  return readPresentedEntries(data?.files === undefined ? undefined : { files: data.files })
}

/**
 * Pull a filesystem path out of a tool's arguments.
 *
 * Tools disagree about the field name (`path`, `file_path`, `filePath`), and
 * the value is frequently JSON-in-a-string because `tool/call` carries raw
 * model output rather than a parsed object. Both shapes are accepted, and
 * anything that does not yield a string is simply "no path" — a panel row that
 * guesses would be worse than one that says nothing.
 *
 * @param {unknown} raw - the tool call arguments.
 * @returns {string | undefined} the path, when one can be read.
 */
function readPathArgument(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const bag = /** @type {Record<string, unknown>} */ (value)
  for (const key of ['path', 'file_path', 'filePath', 'target']) {
    const candidate = bag[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  return undefined
}

/**
 * Pull the command string out of a shell tool's arguments.
 *
 * Shell tools name this differently from the file tools (`command` rather than
 * `path`), and one of them accepts a bare string instead of an object. Both are
 * handled here so the panel can show "what this turn ran" without knowing which
 * shell it was.
 *
 * @param {unknown} raw - the tool call arguments.
 * @returns {string | undefined} the command, when one can be read.
 */
function readCommandArgument(raw) {
  let value = raw
  if (typeof raw === 'string') {
    // A shell tool given `{"command": "..."}` arrives as a JSON string like
    // every other call; one given the command directly arrives as the command.
    try {
      value = JSON.parse(raw)
    } catch {
      return raw.trim().length > 0 ? raw.trim() : undefined
    }
  }
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const bag = /** @type {Record<string, unknown>} */ (value)
  for (const key of ['command', 'cmd', 'script']) {
    const candidate = bag[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  return undefined
}

/**
 * Trim text to a budget counted in code points.
 *
 * `String#slice` counts UTF-16 units, so cutting between the two halves of an
 * astral character (an emoji, a rare CJK ideograph) leaves a lone surrogate —
 * which reaches the prompt as U+FFFD. The budget is a character budget, so it
 * has to be spent in characters.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function clipCodePoints(text, limit) {
  const chars = Array.from(text)
  return chars.length <= limit ? text : chars.slice(0, limit).join('')
}

/**
 * Read the text of a human message out of its content blocks.
 *
 * The host ships a user message as an array of typed blocks, and only the
 * `text` ones are what the person typed — attachments, images and runtime
 * context ride along in the same array. Non-text blocks are skipped rather than
 * stringified: a summary that quotes "[object Object]" as the user's question is
 * worse than one that quotes nothing.
 *
 * @param {unknown} content - the message content.
 * @returns {string} the text, or '' when there is none.
 */
function readUserText(content) {
  if (typeof content === 'string') return clipCodePoints(content.trim(), MAX_ASKED_CHARS)
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type !== 'text') continue
    const text = typeof block.text === 'string' ? block.text.trim() : ''
    if (text.length > 0) parts.push(text)
  }
  return clipCodePoints(parts.join('\n\n'), MAX_ASKED_CHARS)
}

/**
 * Read a tool name out of an `assistant/message` content block.
 *
 * The host records tool calls in at least two shapes depending on version: a
 * `tool-call` content block, or a `tool_use` block on the model-side schema.
 * Both are accepted; the first one seen wins because a message does not
 * normally carry both.
 *
 * @param {any} block - one content block.
 * @returns {{ id?: string, name: string, arguments: unknown } | undefined} the call.
 */
function readToolCallBlock(block) {
  if (typeof block !== 'object' || block === null) return undefined
  const kind = block.type
  if (kind !== 'tool-call' && kind !== 'tool_use' && kind !== 'tool-call-start') return undefined
  const name = typeof block.name === 'string' ? block.name : undefined
  if (name === undefined || name.length === 0) return undefined
  return {
    id: typeof block.id === 'string' ? block.id : typeof block.callId === 'string' ? block.callId : undefined,
    name,
    arguments: block.arguments ?? block.input ?? block.args,
  }
}

/**
 * One agent's transcript, reduced to what the panel can show.
 */
class Transcript {
  constructor() {
    /** @type {Map<string, { id: string, name: string, path?: string, ok?: boolean, error?: string }>} */
    this.calls = new Map()
    /**
     * What the turn delivered, in first-mention order.
     *
     * The card's primary file source. Each entry is `{ path, description }`,
     * where `description` is what the model wrote next to the file and may be
     * `''` — `present` carries one, `report_output_files` does not.
     *
     * @type {Array<{ path: string, description: string }>}
     */
    this.delivered = []
    /**
     * Files this turn wrote, named only by results the host resolved.
     *
     * Kept apart from {@link delivered} rather than pushed into it, because the
     * two answer different questions and only one of them is a promise: a
     * delivery is the model saying "here, this is for you", while this is "a
     * write succeeded". `snapshot` uses this list only when `delivered` is
     * empty, and that decision lives in one place so a later reader cannot
     * mistake the fallback for the rule.
     *
     * @type {string[]}
     */
    this.produced = []
    /** @type {string[]} shell commands the turn ran, newest last. */
    this.commands = []
    /** @type {string[]} assistant text blocks from this turn, in order. */
    this.said = []
    /** The turn that is currently open, or undefined between turns. */
    this.turn = undefined
    /** One-line record of the turn that ended most recently. */
    this.previous = undefined
    /** How many human turns this transcript has seen. */
    this.turns = 0
    /**
     * Whether the count in `turns` already includes what a stored file knew.
     *
     * The count is local by design: `beginTurn` numbers from zero so the panel
     * can promise "the turn before this one" instead of the host's absolute
     * number. That makes a live count and a stored count measure different
     * spans, and they can only be added once. Without this flag the second
     * `hydrate` for the same agent would add the file's turns in again.
     */
    this.hydrated = false
    /**
     * What the person asked to start this turn, or '' between turns.
     *
     * The panel's own rows never show this — the transcript is on screen right
     * above the sidebar. It exists because the summary needs it twice over: the
     * turn's intent is the user's, and every other line the prompt carries
     * describes consequences, so without this the model is told what happened
     * and never what was wanted. It is also the only signal in the body that
     * says which language to answer in, since the request to write in the
     * conversation's language cannot be followed from machine output alone.
     */
    this.asked = ''
  }

  /**
   * Start a new turn.
   *
   * A turn is opened by a human message, not by the host's turn counter. The
   * host numbers turns from the start of the session, and resuming an old
   * conversation begins mid-sequence — using its number would make the panel
   * announce "turn 41" for the first turn a person actually saw. What the panel
   * promises is "the turn before this one", so a local count is the honest one.
   *
   * @param {number} [index] - the turn number, when the caller has one.
   * @param {string} [asked] - what the person said to open the turn.
   */
  beginTurn(index, asked) {
    this.turns = Number.isFinite(index) ? index : this.turns + 1
    this.calls.clear()
    this.delivered = []
    this.produced = []
    this.commands = []
    this.said = []
    this.asked = typeof asked === 'string' ? clipCodePoints(asked, MAX_ASKED_CHARS) : ''
    this.turn = this.turns
  }

  /**
   * Close the open turn, folding it down to what the panel reports.
   *
   * Folding happens here rather than at the next turn's start so that the
   * window between turns — which is exactly when a person reads the sidebar —
   * shows the turn that just finished, not the one before it.
   *
   * @param {any} [data] - the `turn/end` payload.
   * @returns {void}
   */
  endTurn(data) {
    if (this.turn === undefined) return
    // A turn the host abandoned is not a turn's worth of work to summarise.
    // The model did not reach its own conclusion, so any "what happened" text
    // would describe a plan that was never carried out.
    if (data?.reason?.kind !== undefined && data.reason.kind !== 'completed') {
      this.calls.clear()
      this.delivered = []
      this.produced = []
      this.commands = []
      this.said = []
      // Cleared with the rest: this turn produces no `previous`, so a question
      // left here would ride along on whichever turn is folded next.
      this.asked = ''
      this.turn = undefined
      return
    }
    this.previous = this.snapshot()
    this.turn = undefined
  }

  /**
   * Reduce the current turn to the shape the panel renders.
   *
   * Text is capped: a single assistant message can run to tens of thousands of
   * characters, and the panel is a sidebar, not a transcript viewer. The cap is
   * generous enough for a normal two-paragraph reply and short enough that a
   * wall of text cannot push the other two modules off screen.
   *
   * @returns {object} the turn summary.
   */
  snapshot() {
    const calls = [...this.calls.values()]
    const failed = calls.filter((call) => call.ok === false)
    // Which files this turn reports. A declaration outranks a write, and one
    // declaration is enough to outrank every write: a turn that says "here are
    // the two documents" and also rewrote thirty source files handed over two,
    // and mixing the two lists would bury the two in the thirty. Only when the
    // turn said nothing does a successful write stand in for it -- see
    // {@link MUTATION_TOOLS}.
    const rows =
      this.delivered.length > 0
        ? this.delivered.slice(0, MAX_CARD_PATHS)
        : this.produced.slice(0, MAX_CARD_PATHS).map((path) => ({ path, description: '' }))
    return {
      turn: this.turn,
      calls: calls.length,
      failed: failed.length,
      // Deduplicated by path, first mention wins: a turn that presents the same
      // file twice should list it once, and the description that survives is the
      // one written the first time — a later mention with no description must
      // not erase it.
      paths: rows.map((entry) => entry.path),
      delivered: rows,
      commands: this.commands.slice(-8),
      said: this.said.join('\n\n').slice(0, 1200),
      tools: tallyNames(calls),
      asked: this.asked,
    }
  }

  /**
   * Record one tool call.
   *
   * @param {{ id?: string, name: string, arguments: unknown }} call - the call.
   */
  noteCall(call) {
    if (this.calls.size >= MAX_CALLS_PER_TURN) return
    const key = call.id ?? `${call.name}#${this.calls.size}`
    const path = readPathArgument(call.arguments)
    this.calls.set(key, { id: key, name: call.name, path })
    if (REPORT_TOOLS.has(call.name)) {
      // No description: the tool's schema has none, and inventing one here would
      // put words in the model's mouth.
      for (const declared of readPathListArgument(call.arguments)) this.deliver(declared, '')
    }
    if (PRESENT_TOOLS.has(call.name)) {
      // Read from the call as well as from the event, and see
      // {@link PRESENTED_EVENT}: a host build that emits the event makes this a
      // duplicate that `deliver` ignores, and one that does not still works.
      for (const entry of readPresentedEntries(call.arguments)) this.deliver(entry.path, entry.description)
    }
    if (SHELL_TOOLS.has(call.name)) {
      const command = readCommandArgument(call.arguments)
      // Kept for the summary's "what this turn ran". No paths are read out of
      // it: a redirect names a file the turn wrote, not one it handed over.
      if (command !== undefined) this.commands.push(command.slice(0, 200))
    }
  }

  /**
   * Record one delivered file.
   *
   * A file can arrive twice in one turn — the `present` call and the host's own
   * event, or the same file presented in two batches — and the two mentions
   * disagree in exactly one field. The path is deduplicated, and the newest
   * *sentence* wins: a later announcement carrying a description replaces the
   * older one, because the most recent thing the model said about the file is
   * the true one. A later announcement carrying nothing does not erase it — the
   * host emits one event per call and only the first tends to carry a
   * description, so the blank one is usually the same delivery arriving again.
   *
   * @param {string} path - the path as the model wrote it.
   * @param {string} description - what the model said about it, or ''.
   * @returns {void}
   */
  deliver(path, description) {
    if (typeof path !== 'string' || path.length === 0) return
    const absolute = canonicalPath(path)
    if (absolute.length === 0) return
    const said = typeof description === 'string' ? description.trim() : ''
    const existing = this.delivered.find((entry) => entry.path === absolute)
    if (existing === undefined) {
      // Full, so a new path is dropped rather than growing the list. Dropping
      // rather than evicting is deliberate: the entries already here were
      // announced first, and `snapshot` keeps the first `MAX_CARD_PATHS` -- an
      // eviction would quietly change rows the card had already committed to.
      if (this.delivered.length < MAX_DELIVERED_ENTRIES) this.delivered.push({ path: absolute, description: said })
      return
    }
    // A later announcement carrying a sentence replaces the older one: the
    // newest thing the model said about the file is the true one. A later
    // announcement carrying nothing does not erase it -- the host emits one
    // event per call and only the first tends to have a description, so the
    // blank one is usually the same delivery arriving again.
    if (said.length > 0) existing.description = said
  }

  /**
   * Record the outcome of a tool call.
   *
   * Failure detection is deliberately shallow: the host reports a tool failure
   * as `isError` on the result, and a plugin that tried to parse every tool's
   * own error text would be wrong about most of them. "Did the host mark this
   * call as failed" is the only question this needs to answer.
   *
   * The host nests the result in `data.message`; `data.message.toolCallId` and
   * `data.message.source.callId` carry the id, and `data.message.isError` the
   * verdict. Reading the top of `data` left `id` undefined, so this returned
   * early on every real event and the panel's failure count was always zero.
   *
   * @param {any} data - the `tool/result` payload.
   */
  noteResult(data) {
    const message = data?.message
    const id = [message?.toolCallId, message?.source?.callId, data?.callId, data?.id].find(
      (candidate) => typeof candidate === 'string' && candidate.length > 0
    )
    if (id === undefined) return
    const entry = this.calls.get(id)
    if (entry === undefined) return
    entry.ok = message?.isError !== true && data?.isError !== true && data?.error === undefined
    if (entry.ok === false) return
    if (MUTATION_TOOLS.has(entry.name) === false) return
    const path = readProducedPath(data)
    if (path === undefined) return
    const absolute = canonicalPath(path)
    if (absolute.length === 0) return
    if (this.produced.includes(absolute)) return
    // Stopped at the card's own width rather than at a second number, for the
    // same reason `MAX_REPORTED_PATHS` equals `MAX_CARD_PATHS`: a budget above
    // the sink accepts work it then silently drops.
    if (this.produced.length < MAX_CARD_PATHS) this.produced.push(absolute)
  }

  /**
   * Record assistant text.
   *
   * @param {any[]} content - the message content blocks.
   */
  noteText(content) {
    if (!Array.isArray(content)) return
    if (this.said.length >= MAX_SAID_BLOCKS) return
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      if (block.type !== 'text') continue
      if (this.said.length >= MAX_SAID_BLOCKS) return
      // Sliced on the way in, not on the way out: the point is to not hold the
      // text at all. Cutting at render time would keep the whole block alive
      // for the life of the session and only hide it.
      const text = typeof block.text === 'string' ? block.text.trim().slice(0, MAX_SAID_CHARS) : ''
      if (text.length > 0) this.said.push(text)
    }
  }
}

/**
 * Count calls by tool name, sorted by frequency.
 *
 * @param {Array<{ name: string }>} calls - the calls.
 * @returns {Array<{ name: string, count: number }>} the tally.
 */
function tallyNames(calls) {
  const counts = new Map()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8)
}

/**
 * Keep one transcript per agent.
 */
class TranscriptStore {
  constructor() {
    /** @type {Map<string, Transcript>} */
    this.byAgent = new Map()
  }

  /**
   * @param {string} agentId - the agent id.
   * @returns {Transcript} the transcript, created on first use.
   */
  for(agentId) {
    let transcript = this.byAgent.get(agentId)
    if (transcript === undefined) {
      transcript = new Transcript()
      this.byAgent.set(agentId, transcript)
    }
    return transcript
  }

  /**
   * Install a snapshot read back from disk.
   *
   * The snapshot is the panel's own description of a finished turn, so it goes
   * straight into `previous` — the field the live path fills at `turn/end` —
   * and `turns` carries the count the session had reached. Nothing else is
   * restored, because nothing else is on disk: the open turn's calls and text
   * are deliberately not persisted, since a turn that was still running when
   * the host stopped did not finish and the panel does not describe half a
   * turn.
   *
   * A transcript that already holds live events is not replaced, but it is not
   * ignored either. Live events are always more current than a file, so the
   * file loses on `previous`; the turn *count* is the one thing that cannot be
   * recovered from events, because this process started counting at zero. A
   * restart therefore lands here with `turns: 1` in memory and `turns: 7` on
   * disk, and refusing the file made the panel announce turn 1 for a
   * conversation that had reached turn 7. So the counts are added, once — see
   * `hydrated` — and `previous` is taken only when memory has no finished turn
   * to describe.
   *
   * `previous` is optional, because a finished turn is not the only thing worth
   * remembering. A session whose last turn was abandoned keeps its count and has
   * no turn to describe — the host never completed the work, so there is nothing
   * honest to summarise — and the file records exactly that. Demanding `previous`
   * threw the count away with it, and the panel then reported turn 0 for a
   * conversation that had reached turn 4.
   *
   * @param {string} agentId - the agent id.
   * @param {{ turn?: number, turns?: number, previous?: object }} state - what was stored.
   * @returns {boolean} true when something was taken from `state`.
   */
  hydrate(agentId, state) {
    const raw = state?.previous
    const previous = raw !== undefined && raw !== null && typeof raw === 'object' && Array.isArray(raw) === false ? raw : undefined
    const turns = Number.isFinite(state?.turns) ? state.turns : Number.isFinite(previous?.turn) ? previous.turn : 0
    if (previous === undefined && turns === 0) return false

    const existing = this.byAgent.get(agentId)
    if (existing === undefined) {
      const transcript = new Transcript()
      transcript.previous = previous
      transcript.turns = turns
      transcript.hydrated = true
      this.byAgent.set(agentId, transcript)
      return true
    }

    // Events have arrived since the restart. They own `previous` — whatever
    // finished while this process was running is newer than anything on disk —
    // but they know nothing about the turns before it.
    if (existing.hydrated === true) return false
    existing.hydrated = true
    existing.turns += turns
    // The turn that opened before this read was numbered from zero, because the
    // file had not been read yet. Now that it has, the open turn's real number
    // is the whole count. Renumbering it here is what keeps `turn/end` honest:
    // it copies `turn` into `previous.turn` and into the sweep record, so a
    // number one too small makes a restarted process file this turn's work
    // under the previous turn's number — the card then shows the work it just
    // did as "earlier", and the sweep claims to have described a turn that
    // finished before the process started.
    if (existing.turn !== undefined) existing.turn = existing.turns
    if (existing.previous === undefined) existing.previous = previous
    return true
  }

  /**
   * @param {string} agentId - the agent id.
   * @returns {object | undefined} the panel view, or undefined for an unknown agent.
   */
  view(agentId) {
    const transcript = this.byAgent.get(agentId)
    if (transcript === undefined) return undefined
    return {
      turns: transcript.turns,
      current: transcript.snapshot(),
      previous: transcript.previous,
    }
  }

  /** @param {string} agentId - the agent id. */
  forget(agentId) {
    this.byAgent.delete(agentId)
  }

  /**
   * Fold one host event into an agent's transcript.
   *
   * This is the only entry point the plugin uses, so the mapping from the
   * host's event vocabulary to the panel's four fields lives in one place. An
   * event type this does not recognise is dropped rather than guessed at: a
   * wrong guess would put invented rows in front of the person reading them.
   *
   * `user/message` opens a turn only for a real human message. The host also
   * delivers runtime-context snapshots and tool results as `user` turns, and
   * counting those as turns would make the panel's "last turn" mean "last
   * prompt fragment", which is never what the reader wants.
   *
   * @param {string} agentId - the agent id.
   * @param {any} event - the `session/event` payload.
   * @returns {void}
   */
  record(agentId, event) {
    const type = event?.type
    const data = event?.data
    if (type === 'user/message') {
      if (data?.source?.kind !== 'user') return
      this.for(agentId).beginTurn(undefined, readUserText(data?.content))
      return
    }
    if (type === 'assistant/message') {
      this.for(agentId).noteText(data?.message?.content)
      return
    }
    if (type === 'tool/call') {
      const call = typeof data?.name === 'string' ? { id: typeof data.callId === 'string' ? data.callId : undefined, name: data.name, arguments: data.arguments } : undefined
      if (call === undefined) return
      this.for(agentId).noteCall(call)
      return
    }
    if (type === 'tool/result') {
      this.for(agentId).noteResult(data)
      return
    }
    if (type === PRESENTED_EVENT) {
      // The host's own record of what the turn handed over. Read as well as the
      // call rather than instead of it — see {@link PRESENTED_EVENT} — and
      // `deliver` drops the duplicate.
      const transcript = this.for(agentId)
      for (const entry of readPresentedEvent(data)) transcript.deliver(entry.path, entry.description)
      return
    }
    if (type === 'turn/end') {
      this.for(agentId).endTurn(data)
    }
  }
}

export { Transcript, TranscriptStore, SHELL_TOOLS, REPORT_TOOLS, PRESENT_TOOLS, PRESENTED_EVENT, MUTATION_TOOLS, MAX_REPORTED_PATHS, MAX_CALLS_PER_TURN, MAX_SAID_BLOCKS, MAX_SAID_CHARS, MAX_ASKED_CHARS, readPathArgument, readPathListArgument, readPresentedEntries, readPresentedEvent, readCommandArgument, readToolCallBlock, readUserText, tallyNames }
