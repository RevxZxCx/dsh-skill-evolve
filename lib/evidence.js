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
 * raw session text. A quote that cannot be found is discarded. A candidate
 * whose surviving evidence is empty is rejected outright.
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
 * @param {string} input.corpus - the raw text the evidence must be found in.
 * @returns {{survived: Array<{class: string, quote: string, note?: string}>, dropped: Array<{quote: string, reason: string}>, classes: Set<string>, authoritative: boolean}} outcome
 */
export function runGate(input) {
  /** @type {Array<{class: string, quote: string, note?: string}>} */
  const survived = []
  /** @type {Array<{quote: string, reason: string}>} */
  const dropped = []
  const corpus = normalize(input.corpus)

  for (const entry of input.evidence) {
    const validated = validateEvidenceEntry(entry)
    if (!validated.ok) {
      dropped.push({ quote: describeQuote(entry), reason: validated.reason })
      continue
    }
    if (!quoteAppears(validated.value.quote, corpus)) {
      dropped.push({
        quote: validated.value.quote,
        reason: 'quote does not appear in this session verbatim'
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
