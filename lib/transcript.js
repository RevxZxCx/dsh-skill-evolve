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

/** How many tool calls one turn keeps before it stops recording detail. */
const MAX_CALLS_PER_TURN = 200

/** Tool names whose arguments describe a file the session touched. */
const EDIT_TOOLS = new Set(['edit', 'write', 'ops_write_file', 'ops_edit_file', 'ops_replace', 'ops_move', 'ops_copy', 'ops_remove'])

/** Shell tools: a command may create or modify files, but nobody knows which. */
const SHELL_TOOLS = new Set(['bash', 'ops_bash', 'shell', 'terminal', 'exec', 'run', 'pwsh', 'powershell'])

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
    /** @type {string[]} paths this turn wrote, in first-touch order. */
    this.paths = []
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
   */
  beginTurn(index) {
    this.turns = Number.isFinite(index) ? index : this.turns + 1
    this.calls.clear()
    this.paths = []
    this.commands = []
    this.said = []
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
      this.paths = []
      this.commands = []
      this.said = []
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
    return {
      turn: this.turn,
      calls: calls.length,
      failed: failed.length,
      // Deduplicated: a turn that edits one file eight times should list it once.
      paths: [...new Set(this.paths)].slice(0, 40),
      commands: this.commands.slice(-8),
      said: this.said.join('\n\n').slice(0, 1200),
      tools: tallyNames(calls),
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
    if (path !== undefined && EDIT_TOOLS.has(call.name)) this.paths.push(path)
    if (SHELL_TOOLS.has(call.name)) {
      const command = readCommandArgument(call.arguments)
      if (command !== undefined) this.commands.push(command.slice(0, 200))
    }
  }

  /**
   * Record the outcome of a tool call.
   *
   * Failure detection is deliberately shallow: the host reports a tool failure
   * as `isError` on the result, and a plugin that tried to parse every tool's
   * own error text would be wrong about most of them. "Did the host mark this
   * call as failed" is the only question this needs to answer.
   *
   * @param {any} data - the `tool/result` payload.
   */
  noteResult(data) {
    const id = typeof data?.callId === 'string' ? data.callId : typeof data?.id === 'string' ? data.id : undefined
    if (id === undefined) return
    const entry = this.calls.get(id)
    if (entry === undefined) return
    entry.ok = data?.isError !== true && data?.error === undefined
  }

  /**
   * Record assistant text.
   *
   * @param {any[]} content - the message content blocks.
   */
  noteText(content) {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      if (block.type !== 'text') continue
      if (typeof block.text === 'string' && block.text.trim().length > 0) this.said.push(block.text.trim())
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
   */
  record(agentId, event) {
    const type = event?.type
    const data = event?.data
    if (type === 'user/message') {
      if (data?.source?.kind !== 'user') return
      this.for(agentId).beginTurn()
      return
    }
    if (type === 'assistant/message') {
      this.for(agentId).noteText(data?.message?.content)
      return
    }
    if (type === 'tool/call') {
      const call = typeof data?.name === 'string' ? { id: typeof data.callId === 'string' ? data.callId : undefined, name: data.name, arguments: data.arguments } : undefined
      if (call !== undefined) this.for(agentId).noteCall(call)
      return
    }
    if (type === 'tool/result') {
      this.for(agentId).noteResult(data)
      return
    }
    if (type === 'turn/end') {
      this.for(agentId).endTurn(data)
    }
  }
}

export { Transcript, TranscriptStore, EDIT_TOOLS, SHELL_TOOLS, MAX_CALLS_PER_TURN, readPathArgument, readCommandArgument, readToolCallBlock, tallyNames }
