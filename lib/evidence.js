/**
 * The evidence gate.
 *
 * An agent that writes down its own conclusions poisons the store: it asserts
 * something, a naive distiller records it as fact, the next session reads it
 * back as truth and becomes more confident. Prompt instructions do not stop
 * this — the failure is structural, because the writer and the reader are the
 * same kind of thing.
 *
 * The fix is a deterministic gate the model cannot talk its way past. Every
 * candidate skill must carry evidence drawn from the session, and each piece
 * of evidence must be a quote that appears **character for character** in the
 * session text **of the lane its class claims**. A quote that cannot be found
 * is discarded. A candidate whose surviving evidence is empty is rejected.
 *
 * The lanes are the load-bearing part, and they exist because a single flat
 * corpus does not work: the model's own reasoning, its tool calls and the
 * machine's output all end up in the same string, so the model can quote
 * itself and label the quote `tool`. That passes a flat check while proving
 * nothing, which is the exact failure the gate was supposed to prevent.
 *
 * | lane     | built from                                            |
 * |----------|-------------------------------------------------------|
 * | `user`   | `user/message` authored by the human                   |
 * | `tool`   | `tool/result` payloads (machine output)                |
 * | `action` | `tool/call` records: the name and the arguments the host logged |
 * | `self`   | assistant prose only                                   |
 *
 * The `action` lane holds the arguments as the **host logged them**, not as
 * the model narrated them. Two properties decide this shape:
 *
 * - A tool name on its own is nearly worthless as evidence. `bash` is four
 *   characters, below the minimum quotable length, so a name-only lane makes
 *   the class unusable and pushes the model to relabel the same fact as `tool`
 *   — the precise abuse the lanes exist to stop.
 * - Arguments recorded on `tool/call` are the ones the host actually
 *   dispatched. They prove the call was made; they do not prove it succeeded,
 *   which is why `action` is not authoritative.
 *
 * The model's argument text also appears under `assistant/message`'s
 * `tool-call` block. That copy is deliberately *not* collected: it is the
 * model's draft, it exists whether or not the call was ever dispatched, and
 * admitting it would let a hallucinated call manufacture its own evidence.
 *
 * Host injected context (runtime reminders, skill catalogs) lands nowhere
 * citable, and neither does the system prompt.
 *
 * Evidence is also *classed*, because the classes are not equally
 * authoritative:
 *
 * | class     | what it is                | what it may support            |
 * |-----------|---------------------------|--------------------------------|
 * | `user`    | the human's own words     | decisions, requirements        |
 * | `tool`    | machine output            | numbers, observed facts        |
 * | `action`  | a tool that was called    | "this was done"                |
 * | `self`    | the agent's own words     | first-person judgement only    |
 *
 * A claim about what the human decided needs a `user` quote. A number needs a
 * `tool` quote. `self` quotes can never support a bare factual claim, so a
 * candidate made only of `self` quotes is downgraded rather than trusted.
 *
 * @module dsh-skill-evolve/evidence
 */

/** The evidence classes, in descending authority. */
export const EVIDENCE_CLASSES = /** @type {const} */ (['user', 'tool', 'action', 'self'])

/** Shortest quote worth verifying; below this, matches are coincidental. */
const MIN_QUOTE_LENGTH = 8

/** Newline, spelled out so no source edit can swallow it. */
const NL = String.fromCharCode(10)

/**
 * Normalize text for comparison without weakening the check.
 *
 * Only line endings and the whitespace that a transcript legitimately
 * reflows are touched. Case and punctuation are preserved so that "do not"
 * cannot match "do not delete".
 *
 * @param {string} text - raw text.
 * @returns {string} comparable text.
 */
export function normalize(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
}

/**
 * Validate the shape of a single evidence entry.
 *
 * @param {unknown} entry - the proposed evidence.
 * @returns {{ok: true, value: {class: string, quote: string, note?: string}} | {ok: false, reason: string}} result
 */
export function validateEvidenceEntry(entry) {
  if (typeof entry !== 'object' || entry === null) {
    return { ok: false, reason: 'evidence entry must be an object' }
  }
  const record = /** @type {Record<string, unknown>} */ (entry)
  const quote = record.quote
  if (typeof quote !== 'string' || normalize(quote).length === 0) {
    return { ok: false, reason: 'evidence entry requires a non-empty quote' }
  }
  if (normalize(quote).length < MIN_QUOTE_LENGTH) {
    return { ok: false, reason: `evidence quote is shorter than ${MIN_QUOTE_LENGTH} characters and cannot be verified` }
  }
  const klass = record.class
  if (typeof klass !== 'string' || !EVIDENCE_CLASSES.includes(/** @type {any} */ (klass))) {
    return { ok: false, reason: `evidence class must be one of ${EVIDENCE_CLASSES.join(', ')}` }
  }
  const note = record.note
  return {
    ok: true,
    value: {
      class: klass,
      quote,
      ...typeof note === 'string' && note.length > 0 ? { note } : {}
    }
  }
}

/**
 * Decide whether a quote appears in the supplied corpus.
 *
 * @param {string} quote - the quote to look for.
 * @param {string} corpus - already-normalized text to search.
 * @returns {boolean} true when the quote appears verbatim.
 */
export function quoteAppears(quote, corpus) {
  const needle = normalize(quote)
  if (needle.length < MIN_QUOTE_LENGTH) return false
  return corpus.includes(needle)
}

/**
 * Run the gate over a set of proposed evidence.
 *
 * @param {object} input - the gate input.
 * @param {Array<unknown>} input.evidence - proposed evidence entries.
 * @param {Record<string, string>} [input.lanes] - per-class text, from `lanesFromEvents`.
 * @param {string} [input.corpus] - pre-verified text; only for tests and for
 *   callers that have already established who wrote it. When `lanes` is given
 *   it wins, because an unsegmented corpus cannot tell the model's words from
 *   the machine's.
 * @returns {{survived: Array<{class: string, quote: string, note?: string}>, dropped: Array<{quote: string, reason: string}>, classes: Set<string>, authoritative: boolean}} outcome
 */
export function runGate(input) {
  /** @type {Array<{class: string, quote: string, note?: string}>} */
  const survived = []
  /** @type {Array<{quote: string, reason: string}>} */
  const dropped = []
  const flat = input.corpus ?? ''
  const raw = input.lanes ?? { user: flat, tool: flat, action: flat, self: flat }
  /** @type {Record<string, string>} */
  const laneText = {
    user: normalize(raw.user ?? ''),
    tool: normalize(raw.tool ?? ''),
    action: normalize(raw.action ?? ''),
    self: normalize(raw.self ?? '')
  }

  for (const entry of input.evidence) {
    const validated = validateEvidenceEntry(entry)
    if (!validated.ok) {
      dropped.push({ quote: describeQuote(entry), reason: validated.reason })
      continue
    }
    const lane = laneText[validated.value.class]
    if (lane === undefined) {
      dropped.push({
        quote: validated.value.quote,
        reason: `no transcription lane exists for class "${validated.value.class}"`
      })
      continue
    }
    // The `action` lane holds two shapes and needs two matching rules.
    //
    // A tool name is a whole line and may be shorter than MIN_QUOTE_LENGTH
    // (`bash` is four characters), so it is matched by exact line equality:
    // the vocabulary is closed, an exact name cannot match by coincidence, and
    // a substring rule would wrongly accept `read` inside `thread-read`.
    //
    // An argument string is long prose-in-JSON where the model will naturally
    // quote one command out of a larger blob, so it gets the same substring
    // rule as every other lane — with the minimum length doing the work.
    const quote = normalize(validated.value.quote)
    const found = validated.value.class === 'action'
      ? lane.split(NL).some((line) => {
          const normalized = normalize(line)
          return normalized === quote || normalized.includes(quote)
        })
      : quoteAppears(validated.value.quote, lane)
    if (!found) {
      dropped.push({
        quote: validated.value.quote,
        reason: `quote does not appear in this session's ${validated.value.class} text verbatim`
      })
      continue
    }
    survived.push(validated.value)
  }

  const classes = new Set(survived.map((entry) => entry.class))
  return {
    survived,
    dropped,
    classes,
    // At least one quote from the human or from a machine observation: the two
    // classes that can support a claim about how the world is.
    authoritative: classes.has('user') || classes.has('tool')
  }
}

/**
 * Describe a rejected entry for the diagnostic message.
 *
 * @param {unknown} entry - the rejected entry.
 * @returns {string} a short human-readable quote.
 */
function describeQuote(entry) {
  if (typeof entry !== 'object' || entry === null) return String(entry)
  const quote = /** @type {Record<string, unknown>} */ (entry).quote
  return typeof quote === 'string' ? quote.slice(0, 120) : '(no quote)'
}

/**
 * Flatten host session events into the text the gate searches.
 *
 * The gate deliberately sees the *whole* session rather than a curated
 * excerpt: a model that could choose the corpus could choose a corpus that
 * contains whatever it wanted to say.
 *
 * @param {Iterable<object>} events - raw session events.
 * @returns {string} concatenated text.
 */
export function corpusFromEvents(events) {
  /** @type {string[]} */
  const parts = []
  for (const event of events) {
    const data = /** @type {any} */ (event)?.data
    if (data === undefined || data === null) continue
    collectText(data, parts)
  }
  return parts.join('\n')
}

/**
 * Sort a session's text into the lanes each evidence class is allowed to cite.
 *
 * This is what makes the gate real. A single concatenated corpus lets the
 * model quote its own reasoning — or the arguments of the very call it is
 * making — and label that quote `tool`, which verifies nothing while looking
 * like it verified everything. Keeping the lanes separate means a `tool`
 * quote has to come out of an actual tool result.
 *
 * Tool arguments go to `self`, not to `action`: the model authored them, so
 * they prove intent, not occurrence. Host-injected messages land in `system`,
 * which no evidence class can cite.
 *
 * @param {Iterable<object>} events - raw session events.
 * @returns {{user: string, tool: string, action: string, self: string}} lane text.
 */
export function lanesFromEvents(events) {
  /** @type {{user: string[], tool: string[], action: string[], self: string[], system: string[]}} */
  const lanes = { user: [], tool: [], action: [], self: [], system: [] }

  for (const event of events ?? []) {
    const type = /** @type {any} */ (event)?.type
    const data = /** @type {any} */ (event)?.data
    if (data === undefined || data === null) continue

    if (type === 'user/message') {
      const kind = data?.source?.kind
      const human = kind === 'user' || kind === 'user-approval'
      collectText(data.content, human ? lanes.user : lanes.system)
      continue
    }

    if (type === 'assistant/message') {
      const content = data?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        // Tool-call blocks are the model's *draft* of the call, not a record
        // that it happened. Their text lands nowhere: admitting them would let
        // a hallucinated call quote itself as an `action`.
        if (block?.type === 'tool-call') continue
        collectText(block, lanes.self)
      }
      continue
    }

    if (type === 'tool/call') {
      // The host's own dispatch record. Both halves are quotable here, because
      // this is the host saying "this is the call I made", not the model.
      if (typeof data.name === 'string') lanes.action.push(data.name)
      if (typeof data.arguments === 'string') lanes.action.push(data.arguments)
      else if (data.arguments !== undefined) collectText(data.arguments, lanes.action)
      continue
    }

    if (type === 'tool/result') {
      collectText(data, lanes.tool)
    }
  }

  return {
    user: lanes.user.join(NL),
    tool: lanes.tool.join(NL),
    action: lanes.action.join(NL),
    self: lanes.self.join(NL)
  }
}

/**
 * Recursively collect every string under a `text` key.
 *
 * @param {unknown} node - the value to walk.
 * @param {string[]} out - accumulator.
 * @param {number} [depth] - recursion guard.
 */
function collectText(node, out, depth = 0) {
  if (depth > 6 || node === null || node === undefined) return
  if (typeof node === 'string') return
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'text' && typeof value === 'string') {
      out.push(value)
      continue
    }
    if (key === 'arguments' && typeof value === 'string') {
      out.push(value)
      continue
    }
    collectText(value, out, depth + 1)
  }
}
