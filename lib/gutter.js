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
 * Measure the two gutters beside the prose.
 *
 * @param {{ left: number, right: number }} chatRect - the prose's horizontal extent.
 * @param {number} viewportWidth - the frame's width.
 * @returns {{ left: number, right: number }} empty space on each side, never negative.
 */
export function gutters(chatRect, viewportWidth) {
  const left = Number(chatRect?.left ?? 0)
  const width = Number(viewportWidth ?? 0)
  // The right edge falls back to the viewport only when the viewport itself is
  // a real number; falling back to NaN would make the gutter NaN, which CSS
  // renders as 'left:NaNpx' and quietly drops the cards into the corner.
  const rawRight = chatRect?.right
  const right = Number(rawRight ?? (Number.isFinite(width) ? width : 0))
  const clean = (value) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)
  return {
    left: clean(left),
    right: clean(width - right),
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
 * @param {number} input.viewportWidth - the frame's width.
 * @param {'left'|'right'} [input.side] - the preferred side; ignored when it has no room.
 * @param {number} [input.cardWidth] - desired width before clamping.
 * @returns {{ visible: boolean, side: 'left'|'right', left: number, top: number, width: number, height: number, reason?: string }} the box, or `visible: false` with a reason.
 */
export function placeCards(input) {
  const chatRect = input?.chatRect
  const viewportWidth = Number(input?.viewportWidth ?? 0)
  const side = input?.side === 'right' ? 'right' : 'left'
  const wanted = Number(input?.cardWidth ?? MAX_CARD_WIDTH)

  if (chatRect === undefined || chatRect === null) {
    return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-conversation' }
  }

  const room = gutters(chatRect, viewportWidth)
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
    const usable = room[candidate] - CARD_GAP * 2
    if (usable < MIN_CARD_WIDTH) continue
    const width = Math.floor(Math.min(MAX_CARD_WIDTH, wanted, usable))
    const left =
      candidate === 'left' ? CARD_GAP : Math.floor(viewportWidth - CARD_GAP - width)
    const top = Math.floor(Number(chatRect.top ?? 0) + TOP_INSET)
    const bottom = Math.floor(Number(chatRect.bottom ?? 0) - BOTTOM_INSET)
    return {
      visible: true,
      side: candidate,
      left: Math.max(0, left),
      top: Math.max(0, top),
      width,
      height: Math.max(0, bottom - top),
    }
  }

  return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-room' }
}

/**
 * Where the collapsed handle goes: the same edge, hugging the prose.
 *
 * The handle exists so a collapsed panel is still reachable. It is 22px wide and
 * vertically centred on the cards' span, which is enough to hit without becoming
 * a second thing competing for attention.
 *
 * @param {object} input - the same measurement `placeCards` takes.
 * @returns {{ visible: boolean, side: 'left'|'right', left: number, top: number }} the handle's box.
 */
export function placeHandle(input) {
  const placed = placeCards(input)
  const side = placed.side
  if (placed.visible === false) {
    // Even with no room for cards, keep a handle if there is room for 22px. This
    // is what stops a narrow window from silently losing the panel for good.
    const room = gutters(input?.chatRect, Number(input?.viewportWidth ?? 0))
    const candidate = room[side] >= 24 ? side : room.left >= 24 ? 'left' : room.right >= 24 ? 'right' : ''
    if (candidate === '') return { visible: false, side, left: 0, top: 0 }
    const left = candidate === 'left' ? 0 : Math.floor(Number(input.viewportWidth) - 22)
    const top = Math.floor(Number(input?.chatRect?.top ?? 0) + TOP_INSET + 48)
    return { visible: true, side: candidate, left: Math.max(0, left), top: Math.max(0, top) }
  }
  // The handle goes in the gap between the cards and the prose, not against the
  // window edge: that is the edge the eye is already on, and it stays reachable
  // when a wide window pushes the cards far from the window border.
  const left = side === 'left' ? placed.left + placed.width : Math.max(0, placed.left - 22)
  return { visible: true, side, left, top: placed.top + 48 }
}
