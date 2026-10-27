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
