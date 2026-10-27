/**
 * Tests for the geometry that decides where the floating cards sit.
 *
 * These are worth writing even though the module is small: the browser cannot be
 * asked "does the panel overlap the prose at 1400px with the sidebar open", and
 * a screenshot only proves what one window size looked like on one machine. The
 * numbers below come from the host's own layout rule —
 * `--dsh-chat-content-width: clamp(680px, column × 0.64, 920px)` — so they
 * describe the real app rather than a convenient fiction.
 */

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
import { gutters, placeCards, placeHandle, MIN_CARD_WIDTH, MAX_CARD_WIDTH, CARD_GAP, TOP_INSET, BOTTOM_INSET } from '../lib/gutter.js'

// ---------------------------------------------------------------------------
// gutters
// ---------------------------------------------------------------------------

{
  // 1920 window, 920 prose centred: 500 empty on each side. This is the case the
  // user drew boxes on.
  const room = gutters({ left: 500, right: 1420 }, 1920)
  check('both gutters are measured', room.left === 500 && room.right === 500, JSON.stringify(room))
}

{
  // Prose flush to the left edge (sidebar open, narrow window): the left gutter
  // is zero, not negative.
  const room = gutters({ left: 0, right: 900 }, 1000)
  check('a flush gutter is zero rather than negative', room.left === 0 && room.right === 100, JSON.stringify(room))
}

{
  // Degenerate input must not produce NaN, which would silently become
  // `left: NaNpx` in CSS and drop the panel to the corner.
  const room = gutters(undefined, undefined)
  check('missing input yields zeros', room.left === 0 && room.right === 0, JSON.stringify(room))
}

{
  const room = gutters({ left: 10.7, right: 1419.2 }, 1920)
  check('fractional rects are floored', room.left === 10 && room.right === 500, JSON.stringify(room))
}

// ---------------------------------------------------------------------------
// placeCards — the happy path
// ---------------------------------------------------------------------------

{
  const placed = placeCards({
    chatRect: { left: 500, top: 100, right: 1420, bottom: 900 },
    viewportWidth: 1920,
    side: 'left',
  })
  check('wide window shows cards', placed.visible === true, JSON.stringify(placed))
  check('cards honour the requested side', placed.side === 'left', placed.side)
  check('cards sit in the left gutter', placed.left === CARD_GAP, String(placed.left))
  check('card width is the maximum when there is room', placed.width === MAX_CARD_WIDTH, String(placed.width))
  check('cards start below the prose top', placed.top === 100 + TOP_INSET, String(placed.top))
  check('cards stop above the prose bottom', placed.height === 800 - TOP_INSET - BOTTOM_INSET, String(placed.height))
}

{
  const placed = placeCards({
    chatRect: { left: 500, top: 100, right: 1420, bottom: 900 },
    viewportWidth: 1920,
    side: 'right',
  })
  check('the right side is reachable', placed.side === 'right', placed.side)
  check(
    'right-side cards end one gap from the window edge',
    placed.left + placed.width === 1920 - CARD_GAP,
    `${placed.left}+${placed.width}`,
  )
}

// ---------------------------------------------------------------------------
// placeCards — never overlapping the prose
// ---------------------------------------------------------------------------

{
  // The invariant that matters: whatever the window size, the card box and the
  // prose box must not intersect horizontally. Run it across a sweep so a
  // future tweak to the clamp cannot quietly break one width and pass the rest.
  let overlap = ''
  for (let width = 900; width <= 2200; width += 50) {
    const prose = Math.min(920, Math.max(680, Math.round(width * 0.64)))
    const left = Math.round((width - prose) / 2)
    const rect = { left, top: 100, right: left + prose, bottom: 900 }
    const placed = placeCards({ chatRect: rect, viewportWidth: width, side: 'left' })
    if (placed.visible === false) continue
    const cardRight = placed.left + placed.width
    const cardLeft = placed.left
    const intersects = cardLeft < rect.right && cardRight > rect.left
    if (intersects) overlap = `${width}px: card ${cardLeft}..${cardRight} vs prose ${rect.left}..${rect.right}`
    if (placed.width < MIN_CARD_WIDTH) overlap = `${width}px: width ${placed.width} below the minimum`
  }
  check('no window width puts the cards on the prose', overlap === '', overlap)
}

// ---------------------------------------------------------------------------
// placeCards — degraded cases
// ---------------------------------------------------------------------------

{
  const placed = placeCards({ chatRect: undefined, viewportWidth: 1920, side: 'left' })
  check('no conversation means no cards', placed.visible === false, JSON.stringify(placed))
  check('and says why', placed.reason === 'no-conversation', String(placed.reason))
}

{
  // 700 window, 680 prose: 10px of gutter each side. Nothing fits, and the
  // answer must be "no" rather than a 10px-wide column.
  const placed = placeCards({
    chatRect: { left: 10, top: 100, right: 690, bottom: 900 },
    viewportWidth: 700,
    side: 'left',
  })
  check('a narrow window hides the cards', placed.visible === false, JSON.stringify(placed))
  check('and calls it no-room', placed.reason === 'no-room', String(placed.reason))
}

{
  // The preferred side is genuinely too tight (120px, below MIN_CARD_WIDTH plus
  // two gaps) while the other side fits: fall back rather than vanish.
  const placed = placeCards({
    chatRect: { left: 120, top: 100, right: 720, bottom: 900 },
    viewportWidth: 1920,
    side: 'left',
  })
  check('a too-tight preferred side falls back to the other side', placed.visible === true && placed.side === 'right', JSON.stringify(placed))
  check('and is placed against the far edge', placed.left + placed.width === 1920 - CARD_GAP, `${placed.left}+${placed.width}`)
}

{
  // The case the previous rule got wrong. The left gutter (300) fits a card and
  // is narrower than the right one (620), yet 'left' was requested. Ordering by
  // width flipped this to the right, which meant a right-side preference was
  // flipped to the left on the default layout and vice versa — the setting could
  // never be trusted. The requested side has to win while it fits.
  const placed = placeCards({
    chatRect: { left: 300, top: 100, right: 1300, bottom: 900 },
    viewportWidth: 1920,
    side: 'left',
  })
  check('a fitting preference wins over a wider opposite side', placed.side === 'left', JSON.stringify(placed))

  const mirrored = placeCards({
    chatRect: { left: 620, top: 100, right: 1300, bottom: 900 },
    viewportWidth: 1920,
    side: 'right',
  })
  check('and the same holds for a right preference', mirrored.side === 'right', JSON.stringify(mirrored))
}

{
  // NaN must not survive: Math.max(0, Math.floor(NaN)) is NaN, and NaN is not
  // less than MIN_CARD_WIDTH, so an unguarded gutter produced a visible card of
  // width NaN — rendered as 'left:NaNpx' in the corner.
  const room = gutters({ left: Number.NaN, right: Number.NaN }, 1000)
  check('a NaN gutter is zeroed rather than passed through', room.left === 0 && room.right === 0, JSON.stringify(room))

  const placed = placeCards({
    chatRect: { left: Number.NaN, top: 100, right: Number.NaN, bottom: 900 },
    viewportWidth: 1000,
    side: 'left',
  })
  check('a NaN rect yields no cards rather than a NaN box', placed.visible === false, JSON.stringify(placed))
  check('and never reports a NaN width', Number.isFinite(placed.width), String(placed.width))
}

{
  // Both sides exactly at the minimum: must still show, at the minimum width.
  // gutter = MIN_CARD_WIDTH + 2*CARD_GAP = 200 on each side.
  const gutterWidth = MIN_CARD_WIDTH + CARD_GAP * 2
  const placed = placeCards({
    chatRect: { left: gutterWidth, top: 100, right: gutterWidth + 600, bottom: 900 },
    viewportWidth: gutterWidth * 2 + 600,
    side: 'left',
  })
  check('a gutter exactly at the minimum is used', placed.visible === true, JSON.stringify(placed))
  check('at exactly the minimum width', placed.width === MIN_CARD_WIDTH, String(placed.width))
}

{
  // `cardWidth` is a request, not a command: it is clamped to the room.
  const placed = placeCards({
    chatRect: { left: 250, top: 100, right: 1670, bottom: 900 },
    viewportWidth: 1920,
    side: 'left',
    cardWidth: 400,
  })
  check('a wider request is clamped to the room', placed.width === 250 - CARD_GAP * 2, String(placed.width))
}

{
  const placed = placeCards({
    chatRect: { left: 800, top: 100, right: 1120, bottom: 900 },
    viewportWidth: 1920,
    side: 'left',
    cardWidth: 100,
  })
  check('a narrower request is honoured', placed.width === 100, String(placed.width))
}

// ---------------------------------------------------------------------------
// placeHandle
// ---------------------------------------------------------------------------

{
  const placed = placeCards({
    chatRect: { left: 500, top: 100, right: 1420, bottom: 900 },
    viewportWidth: 1920,
    side: 'left',
  })
  const handle = placeHandle({ chatRect: { left: 500, top: 100, right: 1420, bottom: 900 }, viewportWidth: 1920, side: 'left' })
  check('the handle is visible when cards are', handle.visible === true, JSON.stringify(handle))
  check(
    'the handle sits between the cards and the prose',
    handle.left === placed.left + placed.width,
    String(handle.left),
  )
  check('the handle sits below the first card', handle.top > placed.top, `${handle.top} vs ${placed.top}`)
}

{
  const rect = { left: 500, top: 100, right: 1420, bottom: 900 }
  const handle = placeHandle({ chatRect: rect, viewportWidth: 1920, side: 'right' })
  const placed = placeCards({ chatRect: rect, viewportWidth: 1920, side: 'right' })
  check('a right-side handle is on the right', handle.side === 'right', JSON.stringify(handle))
  check(
    'and sits between the prose and the cards, not against the window edge',
    handle.left >= rect.right && handle.left + 22 <= placed.left,
    `handle ${handle.left}..${handle.left + 22} vs prose ends ${rect.right}, cards start ${placed.left}`,
  )
}

{
  // No room for cards, but 30px of gutter: the handle must survive, otherwise a
  // narrow window would strand the panel with no way to reopen it.
  const handle = placeHandle({
    chatRect: { left: 30, top: 100, right: 970, bottom: 900 },
    viewportWidth: 1000,
    side: 'left',
  })
  check('a handle survives when cards cannot fit', handle.visible === true, JSON.stringify(handle))
  check('and stays on the requested side', handle.side === 'left', handle.side)
}

{
  // No room at all, not even for a handle.
  const handle = placeHandle({
    chatRect: { left: 5, top: 100, right: 695, bottom: 900 },
    viewportWidth: 700,
    side: 'left',
  })
  check('no gutter means no handle', handle.visible === false, JSON.stringify(handle))
}

{
  // Missing rect: the handle must not invent a position.
  const handle = placeHandle({ chatRect: undefined, viewportWidth: 1920, side: 'left' })
  check('no conversation means no handle', handle.visible === false, JSON.stringify(handle))
}

console.log(`
${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
