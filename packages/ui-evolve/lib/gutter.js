/**
 * Where the floating cards sit, worked out from geometry rather than guesswork.
 *
 * The conversation column is centred and capped (`--dsh-chat-content-width` is
 * `clamp(680px, column × 0.64, 920px)`), so on a wide window there is real empty
 * space either side of the prose. That space is the only place a plugin can draw
 * a column without taking layout from the host — see the note in `client.js`.
 *
 * Everything here is pure: a rect in, a rect out. The measuring, the observers
 * and the DOM all live in `client.js`, which means the arithmetic that decides
 * "does this even fit" can be tested without a browser, and the awkward cases
 * (window too narrow, sidebar open, one gutter smaller than the other) can be
 * pinned down as assertions instead of trusted to a screenshot.
 */

/** Narrowest column worth drawing. Below this the text wraps to unreadable. */
export const MIN_CARD_WIDTH = 168

/** Widest column. Wider than this and it stops reading as a sidebar. */
export const MAX_CARD_WIDTH = 300

/** Space kept between the prose and the cards, and between cards and the edge. */
export const CARD_GAP = 16

/** Space kept above the cards, so they never touch the tab strip. */
export const TOP_INSET = 12

/** Space kept below the cards, so they never sit on the composer. */
export const BOTTOM_INSET = 12

/**
 * Width of the collapsed handle, matching `.dsse-handle` in the bundle.
 *
 * It has its own placement rule rather than reusing the cards' edge, because it
 * is wider than the gap between the cards and the prose: anchored on the cards'
 * edge it would either land on the text (left side) or float in the middle of
 * nothing (right side). Anchored to the prose it reads as a tab attached to the
 * card and can never cover a word.
 *
 * Kept equal to the CSS width: the number is used for geometry, so a drift here
 * is a visible misalignment that no other assertion would catch.
 */
export const HANDLE_WIDTH = 16

/**
 * Space kept between any popover and the edge of the viewport.
 *
 * Named for the edge rather than for a box: the cards, the list and the detail
 * layer all use it, and it reads wrong on three of those if it is called a
 * bubble's margin.
 */
export const EDGE_MARGIN = 8

/**
 * Width of the candidate list that opens off the propose button.
 *
 * Wide enough for a kebab-case skill name plus a one-line description, which
 * is what the list row shows. Narrower and every row truncates the name, which
 * is the one field a person needs in order to decide.
 */
export const PANEL_WIDTH = 320

/** Width of the detail card that opens off a list row. */
export const DETAIL_WIDTH = 380

/**
 * Gap between two layers of popover.
 *
 * Small on purpose. The pointer has to cross it to reach the second layer, and
 * the client gives the crossing a grace period — but a wide gap plus a slow
 * move still closes the card, so this is a compromise between "visibly two
 * cards" and "reachable".
 */
export const POPOVER_GAP = 8

/**
 * A rect is only usable when all four edges are real numbers.
 *
 * The alternative — defaulting a missing edge — reads well and is wrong: `right`
 * missing means the measurement failed, not that the box is zero-wide, and the
 * two callers below used to fill that gap differently (`gutters` fell back to
 * `left`, `placeCards` to `0`). The result was a card that the gutter arithmetic
 * believed had 1420px of room on the right and that the placement arithmetic put
 * at x=16 — a card on the wrong side of the window, which is exactly the class of
 * bug this module exists to prevent. One rule, checked once.
 *
 * @param {unknown} rect - the candidate.
 * @param {string[]} edges - which edges this caller actually needs.
 * @returns {boolean} whether every required edge is a finite number.
 */
function usableRect(rect, edges) {
  if (rect === null || typeof rect !== 'object') return false
  return edges.every((edge) => Number.isFinite(rect[edge]))
}

/** The horizontal pair, which is all a gutter measurement needs. */
const HORIZONTAL = ['left', 'right']

/** All four edges, which is what a placement needs. */
const ALL_EDGES = ['left', 'right', 'top', 'bottom']

const floorTo = (value) => (Number.isFinite(value) ? Math.floor(value) : value)
const ceilTo = (value) => (Number.isFinite(value) ? Math.ceil(value) : value)

/**
 * Whole-pixel copies of a measurement, rounded so that every derived box stays put.
 *
 * The browser reports fractional layout coordinates. Rounding the *inputs* is the
 * only way to keep the arithmetic integer, but which way to round each edge is not
 * a style choice — it is what makes "inside the column" true rather than nearly
 * true. There are two rects, and they round towards each other:
 *
 * - **The prose rounds outward.** Its left edge goes down, its right edge goes up.
 *   The rounded prose is never narrower than the real one, so a box placed beside
 *   it never lands on a word.
 * - **The column rounds inward.** Its left edge goes up, its right edge goes down.
 *   The rounded column is never wider than the real one, so a box placed inside it
 *   never spills onto host UI.
 *
 * Both directions shrink the measured gutter, which is the safe direction: the
 * number can understate the space, never overstate it. That is what lets
 * `gutter >= HANDLE_WIDTH` mean the handle really fits.
 *
 * The first version of this file rounded everything the same way. It looked
 * tidier and was wrong twice: `column.left = 0.4, prose.left = 16.8` rounded to
 * `0` and `16`, measuring a 16px gutter and then anchoring the handle at x=0 —
 * 0.4px outside the column the measurement had just called wide enough — and
 * `column.right = 890.4, prose.right = 689.0` measured a 201px gutter for a card
 * that ended at 891, 0.6px onto the host's side. Both cases are pinned in
 * `test/gutter-fractional.test.mjs`.
 *
 * @param {{ left: number, top: number, right: number, bottom: number }} rect - the prose measurement.
 * @param {{ left: number, top: number, right: number, bottom: number }} column - the column measurement.
 * @returns {{ prose: object, column: object }} rounded copies.
 */
function snap(rect, column) {
  return {
    prose: { left: floorTo(rect.left), top: floorTo(rect.top), right: ceilTo(rect.right), bottom: ceilTo(rect.bottom) },
    column: { left: ceilTo(column.left), top: floorTo(column.top), right: floorTo(column.right), bottom: ceilTo(column.bottom) },
  }
}

/**
 * Measure the two gutters beside the prose, within the conversation column.
 *
 * The column is the outer bound, not the frame: everything outside the
 * conversation column belongs to the host (its sidebar, its tab strip), and
 * drawing there puts plugin UI on top of host UI. The prose is centred inside
 * the column, so the usable space on a side is the gap between the two.
 *
 * Both arguments are expected to be already snapped by {@link snap}; treated as
 * integers the two subtractions are exact, and flooring them again is a no-op
 * that only documents the intent.
 *
 * @param {{ left: number, right: number }} chatRect - the prose's horizontal extent.
 * @param {{ left: number, right: number }} [columnRect] - the conversation column; defaults to the prose when absent.
 * @returns {{ left: number, right: number }} empty space on each side, never negative.
 */
export function gutters(chatRect, columnRect) {
  const clean = (value) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)
  // No usable prose means no space that is provably ours. Returning a zero gutter
  // rather than guessing keeps the failure mode "no panel" instead of "panel on
  // top of the sidebar".
  if (!usableRect(chatRect, HORIZONTAL)) return { left: 0, right: 0 }
  const proseLeft = chatRect.left
  const proseRight = chatRect.right
  // Falling back to the prose rather than to the window keeps the failure mode
  // "no room" instead of "draw over the sidebar": with no column known there is
  // no space that is provably ours.
  const columnLeft = Number.isFinite(columnRect?.left) ? columnRect.left : proseLeft
  const columnRight = Number.isFinite(columnRect?.right) ? columnRect.right : proseRight
  return {
    left: clean(proseLeft - columnLeft),
    right: clean(columnRight - proseRight),
  }
}

/**
 * Decide where a card column goes, or that it cannot go anywhere.
 *
 * Deliberately picks one side and never both: two columns of small text flanking
 * the prose compete with the prose, and the point of these cards is to be
 * glanceable, not to be a second reading surface.
 *
 * @param {object} input - the measurement.
 * @param {{ left: number, top: number, right: number, bottom: number }} input.chatRect - the prose block.
 * @param {{ left: number, top: number, right: number, bottom: number }} [input.columnRect] - the conversation column; defaults to the prose.
 * @param {'left'|'right'} [input.side] - the preferred side; ignored when it has no room.
 * @param {number} [input.cardWidth] - desired width before clamping.
 * @returns {{ visible: boolean, side: 'left'|'right', left: number, top: number, width: number, height: number, reason?: string }} the box, or `visible: false` with a reason.
 */
export function placeCards(input) {
  const chatRect = input?.chatRect
  const columnRect = input?.columnRect ?? chatRect
  const side = input?.side === 'right' ? 'right' : 'left'
  const wanted = Number(input?.cardWidth ?? MAX_CARD_WIDTH)

  // Every edge must be a real number. A rect missing one of them is a failed
  // measurement, not a box at zero — and treating it as the latter put a card at
  // x=16 while the gutter arithmetic believed there was room to the right.
  if (!usableRect(chatRect, ALL_EDGES)) {
    return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-conversation' }
  }
  if (columnRect !== null && columnRect !== undefined && !usableRect(columnRect, ALL_EDGES)) {
    return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-conversation' }
  }

  const { prose, column } = snap(chatRect, columnRect ?? chatRect)
  const room = gutters(prose, column)
  const preferred = side
  const other = side === 'left' ? 'right' : 'left'

  // The requested side wins while it fits; the other side is only a fallback for
  // when it does not. Ordering by "whichever is wider" looked reasonable and was
  // wrong: the left gutter is wider than the right on any window with a left
  // sidebar, which is the default, so a 'right' preference was silently flipped
  // back to 'left' almost everywhere. Cards that vanish when the window shrinks
  // still look like a bug, hence the fallback rather than nothing.
  const order = [preferred, other]

  for (const candidate of order) {
    // Both gaps come out of the gutter, not one:
    //
    //   [ column edge | CARD_GAP | card | CARD_GAP | prose ]
    //
    // An earlier version of this line subtracted a single gap, which let the card
    // grow until it touched the column edge: on 1100–1400px windows the card sat
    // at x=0 with a 0px margin, contradicting both the `CARD_GAP` doc comment and
    // the "cards do not touch the column edge" assertion.
    const usable = room[candidate] - CARD_GAP * 2
    if (usable < MIN_CARD_WIDTH) continue
    // `wanted` is caller input, so it cannot be trusted to be a width. A NaN
    // passes `usable < MIN_CARD_WIDTH` untouched (NaN compares false to
    // everything), and a negative number survives Math.min — both then reach the
    // DOM as `width:NaNpx` / a negative width, which the browser discards, leaving
    // a card that collapsed to its content. The left side was accidentally immune
    // because a `left` finiteness check caught the NaN; the right side was not,
    // which is exactly the kind of one-sided accident that hides until the caller
    // changes. Rejecting a non-width here makes both sides agree.
    //
    // A *positive* width below MIN_CARD_WIDTH is honoured rather than rejected:
    // the gutter check above already guarantees the card fits, and a caller asking
    // for something narrower than the default is asking for something narrower than
    // the default. Only values that cannot be a width are refused.
    //
    // `Math.floor` rather than a round: the width must not exceed the budget, or
    // the card grows past the column edge the budget came from.
    const width = Math.floor(Math.min(MAX_CARD_WIDTH, wanted, usable))
    if (!Number.isFinite(width) || width <= 0) continue
    // Hugging the prose, not the frame edge. The gap is the only thing between
    // the cards and the text, which is what makes them read as an annotation of
    // the conversation rather than as a second sidebar.
    //
    // The prose edges are already rounded outward, so `prose.left - CARD_GAP -
    // width` is at most the real value: the card cannot reach the text. On the
    // right, `prose.right + CARD_GAP` is at least the real value for the same
    // reason.
    const left = candidate === 'left' ? prose.left - CARD_GAP - width : prose.right + CARD_GAP
    const top = prose.top + TOP_INSET
    const bottom = prose.bottom - BOTTOM_INSET
    return {
      visible: true,
      side: candidate,
      // Not clamped to zero: a negative `left` would mean the column starts off
      // screen, and silently moving the card to 0 is what put it over the host's
      // sidebar. If the arithmetic says negative, the measurement was wrong.
      left,
      top: Math.max(0, top),
      width,
      height: Math.max(0, bottom - top),
    }
  }

  return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-room' }
}

/**
 * Where the collapsed handle goes: the same edge as the cards, hugging the prose.
 *
 * The handle is anchored to the prose edge rather than to the cards' edge. While
 * `HANDLE_WIDTH` equals `CARD_GAP` the two rules agree, but they stop agreeing the
 * moment either constant moves: anchored to the cards, a wider handle would sit on
 * the text and a narrower one would leave a gap that reads as a misalignment.
 * Anchored to the prose, the handle's outer edge *is* the text's edge at any width,
 * so the one thing that must never happen — a control on top of a paragraph —
 * cannot.
 *
 * With no cards at all there is no card edge to tuck under, so the handle needs its
 * full width of clear gutter — otherwise a narrow window would strand the panel
 * with no way to reopen it. That is why the fallback checks *both* gutters: on an
 * asymmetric window the requested side can be too narrow while the other is not,
 * and refusing outright would leave the panel unreachable.
 *
 * @param {object} input - the same measurement `placeCards` takes.
 * @returns {{ visible: boolean, side: 'left'|'right', left: number, top: number }} the handle's box.
 */
export function placeHandle(input) {
  const chatRect = input?.chatRect
  const columnRect = input?.columnRect ?? chatRect
  const preferred = input?.side === 'right' ? 'right' : 'left'
  const other = preferred === 'left' ? 'right' : 'left'

  // Same rule as `placeCards`, for the same reason: a rect missing an edge is a
  // failed measurement, not a box at zero. Diverging here meant one function
  // refused an incomplete rect while the other silently drew a handle at top 60.
  if (!usableRect(chatRect, ALL_EDGES)) {
    return { visible: false, side: preferred, left: 0, top: 0 }
  }
  if (columnRect !== null && columnRect !== undefined && !usableRect(columnRect, ALL_EDGES)) {
    return { visible: false, side: preferred, left: 0, top: 0 }
  }

  // The same rounding the cards used, so the fallback gutter check and the anchor
  // below divide the same integers.
  const { prose, column } = snap(chatRect, columnRect ?? chatRect)
  const room = gutters(prose, column)

  const placed = placeCards(input)
  let side = preferred
  if (placed.visible) {
    side = placed.side
  } else if (room[preferred] >= HANDLE_WIDTH) {
    side = preferred
  } else if (room[other] >= HANDLE_WIDTH) {
    side = other
  } else {
    return { visible: false, side: preferred, left: 0, top: 0 }
  }

  // Anchored to the prose: the handle's outer edge *is* the prose edge, so it can
  // never cover a word. On the left that means starting HANDLE_WIDTH before the
  // text; on the right it means starting exactly at the text.
  //
  // Containment is a consequence of the gutter check above rather than a clamp
  // here, and that is worth stating because a clamp used to be here. On integers
  // `room.left >= HANDLE_WIDTH` means `prose.left - column.left >= HANDLE_WIDTH`,
  // so `prose.left - HANDLE_WIDTH >= column.left`: the anchor is inside the
  // column by construction. The clamp was unreachable then and is unreachable now,
  // so the invariant is asserted in the sweeps instead of guarded by dead code.
  const left = side === 'left' ? prose.left - HANDLE_WIDTH : prose.right

  return {
    visible: true,
    side,
    left,
    top: Math.max(0, placed.visible ? placed.top + 48 : prose.top + TOP_INSET + 48),
  }
}

/**
 * Settle a vertical position inside the viewport.
 *
 * Shared by both popover layers. The three branches are the same for both, and a
 * second copy of this arithmetic is how the previous hover bubble ended up with a
 * clamp the list and the detail card did not share.
 *
 * @param {number} desired - where the caller would put the box if it fit.
 * @param {number} height - the box height.
 * @param {number | undefined} viewportHeight - the window height, if measurable.
 * @returns {number} the settled top edge.
 */
function clampTop(desired, height, viewportHeight) {
  const foot = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : undefined
  // Tall enough to hold the box: clamp both edges.
  if (foot !== undefined && foot >= height + EDGE_MARGIN * 2) {
    return Math.max(EDGE_MARGIN, Math.min(desired, foot - height - EDGE_MARGIN))
  }
  // Too short to hold it: some of it must hang out. Keep the *top* edge on
  // screen, because the first line is the part that says what the box is.
  // Without the inner guard the two bounds invert below 2 * EDGE_MARGIN and
  // Math.min silently picks the negative one; the outer max then repairs it,
  // which is why the inner one is defensive rather than load-bearing.
  if (foot !== undefined) {
    return Math.max(EDGE_MARGIN, Math.min(desired, Math.max(EDGE_MARGIN, foot - EDGE_MARGIN)))
  }
  // No measurable height: the only boundary left is the top margin. Treating
  // "unknown" as "no limit" is what puts a box above the viewport.
  return Math.max(EDGE_MARGIN, desired)
}

/**
 * Whether a box covers any part of a rectangle.
 *
 * @param {number} left - box left.
 * @param {number} top - box top.
 * @param {number} width - box width.
 * @param {number} height - box height.
 * @param {{left: number, right: number, top: number, bottom: number} | undefined} rect - the rectangle, if any.
 * @returns {boolean} true when the two intersect.
 */
function covers(left, top, width, height, rect) {
  if (rect === undefined || rect === null) return false
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return false
  const right = Number.isFinite(rect.right) ? rect.right : rect.left
  const bottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.top
  return left < right && left + width > rect.left && top < bottom && top + height > rect.top
}

/**
 * Place a popover beside an anchor.
 *
 * The requested side is a preference, not a constraint. If it does not fit, the
 * other side is tried before the box is allowed to leave the viewport — and if
 * neither fits, the side with more room wins and the box is clamped into the
 * window. For a hover card that is the right trade: covering the conversation is
 * allowed (it is not permanent content).
 *
 * Horizontally the box stays on screen. Vertically it may not: a window shorter
 * than the box has nowhere to put it, and `clampTop` keeps the top visible rather
 * than pretending otherwise. That asymmetry is deliberate — a box that starts
 * above the viewport is unreachable, one that runs past the bottom is merely cut.
 *
 * `avoid` is the one rectangle the box must not cover when that is possible. The
 * detail card uses it for the list it hangs off: without it, a narrow window
 * clamped the detail card back over the list's own approve/ignore column, so
 * hovering a row to read it made that row impossible to press.
 *
 * @param {object} input - the placement input.
 * @param {{left: number, right: number, top: number, bottom: number}} input.anchor - the anchor box, in viewport coordinates.
 * @param {number} input.width - the popover width.
 * @param {number} input.height - the popover height, for the vertical settle.
 * @param {'left'|'right'|'auto'} [input.side] - the preferred side.
 * @param {{left: number, right: number, top: number, bottom: number}} [input.avoid] - a rectangle to keep clear when any arrangement allows it.
 * @param {number | undefined} input.viewportWidth - the window width, if measurable.
 * @param {number | undefined} input.viewportHeight - the window height, if measurable.
 * @returns {{visible: boolean, left: number, top: number, width: number, side: 'left'|'right'}} the box.
 */
export function placeNear(input) {
  const anchor = input?.anchor
  const width = Number.isFinite(input?.width) && input.width > 0 ? input.width : PANEL_WIDTH
  const fallback = { visible: false, left: 0, top: 0, width, side: 'right' }
  // `right` is required as well: both candidate sides are measured from it, so an
  // anchor known only by its left edge would produce a box at `left: NaN` that
  // the browser silently drops. Hiding is the honest answer to "I cannot see
  // where this goes".
  if (
    anchor === null ||
    anchor === undefined ||
    !Number.isFinite(anchor.left) ||
    !Number.isFinite(anchor.right) ||
    !Number.isFinite(anchor.top)
  ) {
    return fallback
  }

  const measured = input?.viewportWidth
  const edge = Number.isFinite(measured) && measured > 0 ? measured : undefined
  const preferred = input?.side === 'left' || input?.side === 'right' ? input.side : 'auto'

  // Room is measured to the viewport edge, because the box only has to clear
  // the screen — the conversation underneath is fair game.
  const roomRight = edge === undefined ? Number.POSITIVE_INFINITY : edge - anchor.right - EDGE_MARGIN - POPOVER_GAP
  const roomLeft = anchor.left - EDGE_MARGIN - POPOVER_GAP
  const fitsRight = roomRight >= width
  const fitsLeft = roomLeft >= width

  // Two branches, not four. Written the long way there were also
  // `else if (fitsRight)` and `else if (fitsLeft)` before this tiebreak, and a
  // mutation deleting either one changed nothing: when the preference has not
  // already decided, the side with more room is necessarily the one that fits,
  // because both sides were measured against the same width. Removing them is
  // honest — a branch no input can distinguish is not a branch.
  let side
  if (preferred === 'right' && fitsRight) side = 'right'
  else if (preferred === 'left' && fitsLeft) side = 'left'
  else side = roomRight >= roomLeft ? 'right' : 'left'

  let left = side === 'right' ? anchor.right + POPOVER_GAP : anchor.left - POPOVER_GAP - width
  if (edge !== undefined) left = Math.max(EDGE_MARGIN, Math.min(left, edge - width - EDGE_MARGIN))
  else left = Math.max(EDGE_MARGIN, left)

  // One settle, not two. There used to be an `alignTop` parameter choosing
  // between "start at the anchor's top" and "settle first"; both arms passed
  // through this same call, so the parameter could not be observed. A popover
  // that opens BESIDE its anchor has no "below" to align with.
  const height = Number.isFinite(input?.height) ? input.height : 0
  let top = clampTop(anchor.top, height, input?.viewportHeight)

  // Step out of the way of `avoid`, vertically. The side is already decided and
  // staying on it matters — the detail card belongs next to the list, not on the
  // other side of the window — so the escape is up or down past the rectangle.
  // When neither clears it (a window barely taller than the two boxes) the plain
  // placement stands: covering the list is bad, drawing the card off screen or
  // not at all is worse.
  const avoid = input?.avoid
  if (covers(left, top, width, height, avoid) === true) {
    // Same tolerance `covers` applies: a rectangle missing its bottom edge is
    // treated as a point, so the escape arithmetic must not read `undefined` and
    // hand back `top: NaN`.
    const foot = Number.isFinite(avoid.bottom) ? avoid.bottom : avoid.top
    const above = avoid.top - POPOVER_GAP - height
    const below = foot + POPOVER_GAP
    const options = [
      clampTop(above, height, input?.viewportHeight),
      clampTop(below, height, input?.viewportHeight),
    ]
    const clear = options.find((candidate) => covers(left, candidate, width, height, avoid) === false)
    if (clear !== undefined) top = clear
  }

  return { visible: true, left, top, width, side }
}


