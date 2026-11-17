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

/**
 * Space kept between any popover and the edge of the viewport.
 *
 * Named for the edge rather than for a box: the cards, the list and the detail
 * layer all use it, and it reads wrong on three of those if it is called a
 * bubble's margin.
 */
export const EDGE_MARGIN = 8

/**
 * Width of the candidate review list.
 *
 * Wide enough for a kebab-case skill name plus a one-line description, which
 * is what the list row shows. Narrower and every row truncates the name, which
 * is the one field a person needs in order to decide.
 *
 * Named for the panel, not for a control that opens it. An earlier version named
 * a button that has since been deleted, and the sentence outlived it: the comment
 * kept pointing at something the code no longer had, and it survived review
 * because a stale noun is not a behavior. A comment that names no trigger cannot
 * go stale when the trigger is renamed or removed.
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


/**
 * The narrowest monitor column that still reads.
 *
 * Below this the cards' own padding and a file path's two halves stop fitting on
 * one line each, and a column that wraps every row is worse than no column: it
 * costs the prose width and gives back noise. Higher than `MIN_CARD_WIDTH`
 * because this column also carries its own header row.
 */
export const MONITOR_MIN_WIDTH = 220

/**
 * The widest monitor column before it stops reading as an annotation.
 *
 * Past this the column competes with the prose for attention, which is the thing
 * the gutter layout was already careful about. 460 is the widest the prototype
 * was measured at.
 */
export const MONITOR_MAX_WIDTH = 460

/**
 * The prose width the column refuses to go below.
 *
 * The host's own clamp bottoms out at 680px (`--dsh-chat-content-width:
 * clamp(680px, ...)`), and 560 is deliberately under that: on a window narrow
 * enough to matter, taking the column down to its minimum and keeping 560 of
 * prose is a better trade than dropping the column, because dropping it is what
 * left the panel invisible on the windows where it was wanted.
 */
export const MONITOR_MIN_PROSE = 560

/**
 * The width the host's own turn rail takes at the right edge of the scroll area.
 *
 * The rail's frame is 28px wide and sits 12px in from that edge, so its left
 * edge is 40px from it. The prose is centred in the scroll area, so each side
 * gets half of what the prose does not use and the rail sits on the right one —
 * which is why the column's budget below subtracts twice this number.
 *
 * This is a budget, not a measurement. The rail's visibility is not decided from
 * it: see the note on `placeMonitor`.
 */
export const TURN_RAIL_WIDTH = 40

/**
 * Work out the monitor column's box, and how much the prose must give up.
 *
 * The column is pinned to the conversation column's right edge and the prose is
 * asked to narrow by exactly the column's width, so the two never compete.
 *
 * The prose is measured by its *centred box*, so the caller implements the
 * reservation as `margin-right` on the scrolling container rather than as
 * padding: padding on a centred box only moves it left by half the amount, which
 * made an earlier version subtract the width twice and look correct in one
 * screenshot while being wrong at every other width. `reserve` below is the
 * number that goes into that margin, and it is the column width — not double.
 *
 * Three budgets decide the width, and the column takes the smallest:
 *
 * 1. What the person asked for, clamped to `[MONITOR_MIN_WIDTH, MONITOR_MAX_WIDTH]`.
 * 2. `MONITOR_MIN_PROSE` — the prose keeps a floor.
 * 3. The turn rail. The host's rail sits at the scroll area's right edge, which
 *    is exactly where this column starts, so a column that eats the whole area
 *    leaves the rail nowhere regardless of what the host's own query says. Where
 *    the two disagree, the rail wins the argument down to `MONITOR_MIN_WIDTH`:
 *    a slightly narrower column is worth having and a missing rail is not.
 *
 *    This is a *budget*, not a verdict: it decides how wide the column may be,
 *    never whether the rail is shown. The rail's visibility is decided in the
 *    bundle, which forces it on whenever this column is; asking here whether it
 *    "fits" and then hiding it on a no was the bug that kept it invisible.
 *
 * The column is *not* dropped when the budgets run out. It used to be, and that
 * was wrong twice over: it made the panel disappear on the windows where a
 * narrow column would still have been readable, and it handed the user a second
 * layout to be confused by — the one this column replaced. Below
 * `MONITOR_MIN_WIDTH` of available area there is genuinely nothing to draw, and
 * that is the only case that reports `visible: false`.
 *
 * @param {object} input - the measurement.
 * @param {{ left: number, top: number, right: number, bottom: number }} input.columnRect - the conversation column.
 * @param {number} [input.width] - the width the person last chose.
 * @param {number} [input.proseWidth] - the prose's measured width, if known.
 * @param {number} [input.scrollbarWidth] - the scroll area's scrollbar, if any.
 * @returns {{ visible: boolean, left: number, top: number, width: number, height: number, reserve: number, reason?: string }}
 *   the column's box relative to its own origin, and the width the prose must give up.
 */
export function placeMonitor(input) {
  const column = input?.columnRect
  const idle = { visible: false, left: 0, top: 0, width: 0, height: 0, reserve: 0 }

  // A column missing an edge is a failed measurement, not a box at zero — the
  // same rule the placement functions above follow, for the same reason.
  if (!usableRect(column, ALL_EDGES)) return { ...idle, reason: 'no-conversation' }

  const { column: snapped } = snap(column, column)
  const full = Math.max(0, snapped.right - snapped.left)
  const height = Math.max(0, snapped.bottom - snapped.top)
  if (full <= 0 || height <= 0) return { ...idle, reason: 'no-conversation' }
  // The one case with no answer: an area narrower than the narrowest column.
  if (full < MONITOR_MIN_WIDTH) return { ...idle, reason: 'too-narrow' }

  // What the person asked for. `wanted` cannot be trusted to be a width: a NaN
  // passes every comparison untouched and reaches the DOM as `width:NaNpx`, which
  // the browser discards, leaving a column that collapsed to its content.
  const asked = Number(input?.width)
  const wanted = Number.isFinite(asked) && asked > 0 ? asked : MONITOR_MAX_WIDTH

  // The prose's own width when it was measurable, and the floor when it was not.
  // The larger of the two is the one the column has to respect.
  const measured = Number(input?.proseWidth)
  const prose = Math.max(MONITOR_MIN_PROSE, Number.isFinite(measured) && measured > 0 ? measured : 0)
  const scrollbar = Number(input?.scrollbarWidth)
  const bar = Number.isFinite(scrollbar) && scrollbar > 0 ? scrollbar : 0

  // Budget 2 and budget 3, both as the widest column that leaves what they need.
  const forProse = full - prose
  const forRail = full - bar - prose - TURN_RAIL_WIDTH * 2

  let width = Math.floor(Math.min(MONITOR_MAX_WIDTH, wanted, forProse))
  // Give the rail its room back. Only downwards: a column narrower than the rail
  // needs does not make the rail need more.
  if (Number.isFinite(forRail) && width > forRail) width = Math.floor(forRail)
  // The floor wins over both budgets. A column at its minimum that pushes the
  // prose under its own floor is the lesser evil: the prose re-wraps, the panel
  // would otherwise vanish. At that size the rail may well sit on the gutter's
  // last few pixels, which is the trade the caller makes deliberately — see the
  // turn-rail rule in the bundle.
  if (width < MONITOR_MIN_WIDTH) width = MONITOR_MIN_WIDTH

  return {
    visible: true,
    left: snapped.right - width,
    top: snapped.top,
    width,
    height,
    // Not `width * 2`. See the doc comment: the prose is centred, so one
    // margin of exactly this much is what actually narrows it by this much.
    reserve: width,
  }
}
