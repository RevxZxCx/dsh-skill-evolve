/**
 * Shrink the session skill catalog the host publishes.
 *
 * `@deepseek-ai/dsh-tool-skill` renders every model-invocable skill into one
 * durable user message on every `agent/pre-step`, and re-renders the whole list
 * whenever any name or description changes. Nothing in that path is bounded by
 * relevance: a library of 500 skills costs ~31K tokens of catalog per session,
 * and every later change appends a second complete copy.
 *
 * This module rewrites the *rendered text* of that message. It deliberately
 * does not touch `source.entries`, and the reason is not stylistic:
 *
 *   `dsh-tool-skill` decides whether to republish by hashing
 *   `[name, description]` pairs from the registry and comparing against the
 *   entries recorded on the newest visible `skill-catalog` event. If this
 *   plugin edited `source.entries`, the next step would recompute a digest that
 *   no longer matches the log, conclude the catalog had changed, and append a
 *   fresh copy — every step, forever. Text is not part of that digest, so text
 *   is the only safe surface to rewrite.
 *
 * The consequence is that the log keeps the full descriptions and the model
 * sees the shortened ones. That is the intended split: the log is an audit
 * record, the message is a working set.
 *
 * @module dsh-skill-evolve/catalog
 */

/** Source kind the host stamps on its catalog messages. */
export const CATALOG_SOURCE_KIND = 'skill-catalog'

/**
 * Match the host's own escaping.
 *
 * A catalog entry is rendered as `- \`name\`: description` inside a
 * `<available_skills>` block, so a description containing markup would close
 * the block early. The host escapes `&`, `<` and `>`; the replacement must
 * escape identically or a description that renders safely today would render
 * unsafely after being rewritten here.
 *
 * @param {string} value - raw description text.
 * @returns {string} escaped text.
 */
export function escapeCatalogText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Truncate a description to a character budget.
 *
 * Counts the *raw* description, not the escaped form, so the configured number
 * means the same thing regardless of how much markup a description happens to
 * contain. The ellipsis is added only when something was actually removed, so a
 * short description is not marked as truncated.
 *
 * @param {string} description - raw description.
 * @param {number} max - character budget; `0` or negative disables truncation.
 * @returns {string} the description, possibly shortened.
 */
export function truncateDescription(description, max) {
  const text = String(description ?? '')
  if (!Number.isFinite(max) || max <= 0) return text
  if (text.length <= max) return text
  // `max - 1` leaves room for the ellipsis so the result never exceeds `max`.
  let cut = text.slice(0, max - 1).trimEnd()
  // Step back off a lone high surrogate. `slice` counts UTF-16 code units, so a
  // budget that lands inside an emoji or a CJK extension-B character leaves the
  // first half of a surrogate pair, and the model then reads U+FFFD where a
  // character used to be. Dropping one more unit keeps the text valid; the
  // budget is a soft target and one character is cheaper than mojibake.
  //
  // The second `trimEnd()` matters: the unit just removed may have been the
  // only thing standing between a trailing space and the ellipsis, and the
  // invariant this shares with the plain path is that the ellipsis never
  // follows a space.
  if (cut.length > 0) {
    const last = cut.charCodeAt(cut.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1).trimEnd()
  }
  return cut + '…'
}

/**
 * Locate every catalog message inside a pre-step message list.
 *
 * Matched on `source.kind`, not on text: the frame around the entries differs
 * between the first catalog and later replacements, and a text match would also
 * fire on a user who pasted a catalog into the conversation.
 *
 * Returns a list rather than one message because the host's own lookup does not
 * guarantee there is only one. `catalogMessage()` in
 * `@deepseek-ai/dsh-tool-skill` returns the *first* match and replaces only
 * that one, so a session that already carries a second catalog message — a
 * resumed or forked session whose seed contains one, or a host version that
 * appends instead of replacing — keeps the stale copy visible forever. Rewriting
 * every match is the only version that cannot leave a full-length catalog behind.
 *
 * @param {Array<object>} messages - the pre-step message list.
 * @returns {Array<object>} catalog messages, in list order.
 */
export function findCatalogMessages(messages) {
  if (!Array.isArray(messages)) return []
  const found = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.source?.kind !== CATALOG_SOURCE_KIND) continue
    if (!Array.isArray(message.source.entries)) continue
    found.push(message)
  }
  return found
}

/**
 * Locate the first catalog message inside a pre-step message list.
 *
 * @param {Array<object>} messages - the pre-step message list.
 * @returns {object|undefined} the catalog message, or `undefined`.
 */
export function findCatalogMessage(messages) {
  return findCatalogMessages(messages)[0]
}

/**
 * Decide how one skill is rendered.
 *
 * The tiers are ordered, and the order is the design:
 *
 * 1. `pinned` — a person said this one matters. It outranks every automatic
 *    signal because the automatic signals only know what has already been used,
 *    and a skill's most valuable moment is the one before its first use.
 * 2. `demoted` — a person said this one does not. It loses to everything,
 *    including the truncation default, because a manual demotion is the only
 *    way to silence a skill that keeps scoring well on history alone.
 * 3. used in this session — the strongest automatic signal available. It is
 *    also the one that makes the catalog text change between sessions.
 * 4. `uses >= frequentUses` — durable evidence from earlier sessions.
 * 5. everything else — shortened.
 *
 * Pinning beats demoting when a person has somehow set both, so the visible
 * outcome of "I marked this important" is never surprise suppression.
 *
 * @param {object} input - tier inputs.
 * @param {object} input.entry - `{ name, description }` from the catalog source.
 * @param {object} [input.registry] - per-skill ledger state keyed by name.
 * @param {Set<string>|undefined} [input.sessionUsed] - names loaded this session.
 * @param {object} input.options - resolved thresholds.
 * @param {number} input.options.shrinkChars - budget for unranked descriptions.
 * @param {number} input.options.frequentUses - use count that earns a full line.
 * @param {boolean} input.options.sessionAware - whether tier 3 is active.
 * @returns {{tier: string, description: string}} the chosen tier and text.
 */
export function describeEntry(input) {
  const { entry, registry, sessionUsed, options } = input
  const name = String(entry?.name ?? '')
  const state = registry?.[name]
  const shrink = options?.shrinkChars ?? 0

  if (state?.pinned === true) {
    return { tier: 'pinned', description: String(entry?.description ?? '') }
  }
  if (state?.demoted === true) {
    return { tier: 'demoted', description: truncateDescription(entry?.description, shrink) }
  }
  if (options?.sessionAware !== false && sessionUsed instanceof Set && sessionUsed.has(name)) {
    return { tier: 'session', description: String(entry?.description ?? '') }
  }
  const uses = Number(state?.uses ?? 0)
  if (Number.isFinite(uses) && uses >= (options?.frequentUses ?? 0) && (options?.frequentUses ?? 0) > 0) {
    return { tier: 'frequent', description: String(entry?.description ?? '') }
  }
  return { tier: 'other', description: truncateDescription(entry?.description, shrink) }
}

/** Order in which tiers are listed; earlier means higher up the catalog. */
const TIER_ORDER = ['pinned', 'session', 'frequent', 'other', 'demoted']

/**
 * Sort a rendered catalog into tiers.
 *
 * Sorting is stable within a tier and preserves the host's alphabetical order,
 * so the only thing that moves between steps is a skill crossing a tier
 * boundary — not the whole list reshuffling.
 *
 * @param {Array<{tier: string, name: string}>} rows - rendered rows.
 * @returns {Array<object>} rows sorted by tier then name.
 */
export function sortRows(rows) {
  const rank = (tier) => {
    const index = TIER_ORDER.indexOf(tier)
    return index === -1 ? TIER_ORDER.length : index
  }
  return [...rows].sort((a, b) => {
    const byTier = rank(a.tier) - rank(b.tier)
    if (byTier !== 0) return byTier
    return a.name.localeCompare(b.name)
  })
}

/**
 * Rewrite one catalog message's text.
 *
 * Returns `undefined` when there is nothing to do, so the caller can skip
 * replacing the message and leave the host's object identity intact.
 *
 * The frame is rebuilt rather than patched because the host's entry block sits
 * between a heading and a closing instruction, and splicing lines out of a
 * `<system-reminder>` is more fragile than re-rendering the block the same way
 * the host does.
 *
 * @param {object} input - rewrite inputs.
 * @param {object} input.message - the host's catalog message.
 * @param {object} [input.registry] - per-skill ledger state keyed by name.
 * @param {Set<string>|undefined} [input.sessionUsed] - names loaded this session.
 * @param {object} input.options - resolved thresholds.
 * @param {number} input.options.shrinkChars - budget for unranked descriptions.
 * @param {number} input.options.frequentUses - use count that earns a full line.
 * @param {number} input.options.fullListBelow - list names only at or above this size; `0` disables.
 * @param {boolean} input.options.sessionAware - whether tier 3 is active.
 * @returns {{message: object, stats: object}|undefined} rewritten message and stats.
 */
export function shrinkCatalog(input) {
  const { message, registry, sessionUsed, options } = input
  const entries = message?.source?.entries
  if (!Array.isArray(entries) || entries.length === 0) return undefined

  const block = Array.isArray(message.content) ? message.content[0] : undefined
  if (block === undefined || block.type !== 'text' || typeof block.text !== 'string') return undefined

  const fullListBelow = Number(options?.fullListBelow ?? 0)
  const namesOnly = Number.isFinite(fullListBelow) && fullListBelow > 0 && entries.length >= fullListBelow

  const rows = entries.map((entry) => {
    const name = String(entry?.name ?? '')
    const described = describeEntry({ entry, registry, sessionUsed, options })
    // `raw` is carried only to answer "did this line lose text?" below. It is
    // never rendered, and it is not part of `stats` — the ledger records what
    // the model saw, and the raw description is what it did not.
    return { ...described, name, raw: String(entry?.description ?? '') }
  })
  const sorted = sortRows(rows)

  // A pinned skill keeps its line even in names-only mode. The whole point of
  // the cutoff is to stop paying for descriptions nobody chose, and a pin is
  // precisely a person choosing one — dropping it would make the command's
  // promise ("always shows in full") fail in the only situation that needs it.
  const lines = namesOnly
    ? sorted.map((row) => (row.tier === 'pinned'
      ? `- \`${row.name}\`: ${escapeCatalogText(row.description)}`
      : `- \`${row.name}\``))
    : sorted.map((row) => `- \`${row.name}\`: ${escapeCatalogText(row.description)}`)

  // Count what the model can no longer read here. In names-only mode every
  // non-pinned line is a bare name, so the whole description is gone; otherwise
  // a line lost text only if the renderer shortened it. Comparing rendered
  // against raw is what makes this exact: a description that happened to fit
  // the budget comes back identical and is not counted, so a library that hid
  // nothing gets no note at all.
  const hidden = namesOnly
    ? sorted.filter((row) => row.tier !== 'pinned').length
    : sorted.filter((row) => row.description !== row.raw).length

  const original = block.text
  const stripped = rebuildFrame(original, lines)
  if (stripped === undefined) return undefined

  // Measure against what the host would have rendered for these same entries,
  // not against `original`. Two reasons, and both were caught in review:
  //
  //   `original` may already carry a caption from an earlier pass, so comparing
  //   against it makes every decision depend on history — on a second pass the
  //   captioned candidate ties with the input and the caption silently vanishes.
  //
  //   `original` may also be shorter than the new text for a legitimate reason:
  //   the library grew. Treating that as a regression and returning `undefined`
  //   would freeze the catalog at the old entry list, so a skill added
  //   mid-session would never appear in it.
  const fullLines = sorted.map((row) => `- \`${row.name}\`: ${escapeCatalogText(row.raw)}`)
  const fullText = rebuildFrame(original, fullLines)
  const baseline = fullText === undefined ? undefined : fullText.length

  // The caption is a fixed 111 characters while the saving grows with the
  // library, so on a small library whose descriptions sit just over the budget
  // it can cost more than the truncation recovered. In that case the text is
  // still shortened and still searchable; the model is simply not told so until
  // the shrink is large enough to afford the sentence.
  const note = catalogNote(hidden)
  const withNote = note.length === 0 ? stripped : rebuildFrame(original, lines, note)
  const candidate = withNote !== undefined && baseline !== undefined && withNote.length < baseline
    ? withNote
    : stripped

  // Identical to what the host already wrote: skip replacing the message so the
  // host keeps its own object identity.
  if (candidate === original) return undefined
  const rebuilt = candidate

  const next = {
    ...message,
    content: message.content.map((item, index) => (index === 0 ? { ...item, text: rebuilt } : item))
  }

  const tiers = {}
  for (const row of rows) tiers[row.tier] = (tiers[row.tier] ?? 0) + 1

  return {
    message: next,
    stats: {
      entries: entries.length,
      namesOnly,
      before: original.length,
      after: rebuilt.length,
      tiers
    }
  }
}

/** The caption added after the block when descriptions were shortened. */
export const CATALOG_NOTE = 'Descriptions above were shortened; call `skill_search` with keywords to read one in full before ruling it out.'

/**
 * Say where the removed descriptions went.
 *
 * Shrinking is only safe if the model knows the full text is still reachable.
 * Without this line a large library renders as a list of bare names, and
 * nothing in the message says those names have descriptions behind them. The
 * tool description alone is not enough: a model that has already concluded a
 * name tells it nothing does not go shopping through the tool list.
 *
 * Kept to one short sentence on purpose. This text is re-sent on every step for
 * the life of the catalog, so it competes with the very budget it is explaining:
 * at the default 80-character budget the note costs about 7% of what shrinking
 * saves, and a longer explanation (with a count, say) would cost twice that to
 * tell the model a number it never acts on.
 *
 * Emitted only when something was actually hidden. On a library where every
 * description fits, a pointer to a search that would return what is already on
 * screen is pure overhead.
 *
 * @param {number} hidden - how many entries lost their full description.
 * @returns {string} the guidance line, or `''` when nothing was hidden.
 */
export function catalogNote(hidden) {
  const count = Number.isFinite(hidden) && hidden > 0 ? hidden : 0
  return count === 0 ? '' : CATALOG_NOTE
}

/**
 * Drop a caption this module added on an earlier pass.
 *
 * `agent/pre-step` hands back a message list the host persists and replays, so a
 * message rewritten here can be presented again — a resumed or forked session
 * seeds exactly that. Appending without this would stack a second caption every
 * pass (measured: 282 → 393 → 504 characters over three calls), and because the
 * text keeps changing the `rebuilt === original` short circuit never fires.
 *
 * Only the module's own sentence is removed, matched per line, so host prose
 * that happens to sit in the same place survives untouched.
 *
 * @param {string} after - text following `</available_skills>`.
 * @returns {string} the same text with any previously added caption removed.
 */
function stripNote(after) {
  if (!after.includes(CATALOG_NOTE)) return after
  return after
    .split('\n')
    .filter((line) => line.trim() !== CATALOG_NOTE)
    .join('\n')
}

/**
 * Replace the `<available_skills>` body, keeping the host's surrounding prose.
 *
 * The host has two frames — an initial catalog and a replacement — and they
 * differ in their heading and closing instructions. Rebuilding the whole
 * message here would require duplicating both, and would silently go stale if
 * the host reworded either. Splicing only the block keeps whatever the host
 * actually wrote and changes only the part this plugin owns.
 *
 * The note sits between the block and the host's closing prose rather than at
 * the end of the message: it comments on the block, so it reads as a caption
 * where it is, and it stays ahead of the instruction the model acts on last.
 *
 * @param {string} text - the host's rendered catalog text.
 * @param {string[]} lines - rendered entry lines.
 * @param {string} [note] - caption placed after the block; omitted when empty.
 * @returns {string|undefined} the spliced text, or `undefined` when no block was found.
 */
function rebuildFrame(text, lines, note) {
  const open = '<available_skills>'
  const close = '</available_skills>'
  const start = text.indexOf(open)
  if (start === -1) return undefined
  const end = text.indexOf(close, start + open.length)
  if (end === -1) return undefined
  const head = text.slice(0, start + open.length)
  const after = stripNote(text.slice(end + close.length))
  const body = lines.length === 0 ? '' : `\n${lines.join('\n')}\n`
  const caption = typeof note === 'string' && note.length > 0 ? `\n${note}` : ''
  return `${head}${body}${close}${caption}${after}`
}
