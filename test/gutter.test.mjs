/**
 * Tests for the geometry that decides where the floating cards sit.
 *
 * These are worth writing even though the module is small: the browser cannot be
 * asked "does the panel overlap the prose at 1400px with the sidebar open", and
 * a screenshot only proves what one window size looked like on one machine. The
 * numbers below come from the host's own layout rule —
 * `--dsh-chat-content-width: clamp(680px, column × 0.64, 920px)` — so they
 * describe the real app rather than a convenient fiction.
 *
 * The contract these pin down, and the one the first version got wrong:
 *
 *  - `columnRect` is the conversation column. `[data-conversation-content]` is
 *    that box, and it is *not* the window: on the default layout a host sidebar
 *    occupies the left edge of the frame. Cards may only use space inside the
 *    column.
 *  - `chatRect` is where the prose actually is, centred inside the column. Cards
 *    hug the prose, because the gap between them and the text is what makes them
 *    read as an annotation of the conversation.
 *
 * The first version measured the gutter against the window and pinned the cards
 * to the window border, so on a real screen they drew over the host's sidebar and
 * were clipped by it. Every test below that mentions the column exists because
 * of that bug.
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
import { readFileSync } from 'node:fs'
import { gutters, placeCards, placeHandle, placeTip, MIN_CARD_WIDTH, MAX_CARD_WIDTH, CARD_GAP, TOP_INSET, BOTTOM_INSET, HANDLE_WIDTH, TIP_WIDTH, TIP_MARGIN, TIP_OFFSET, TIP_HEIGHT } from '../lib/gutter.js'

/**
 * The default 1920px layout, which is what the screenshots were taken on.
 *
 * A ~250px host sidebar on the left, a 1670px conversation column, and 920px of
 * prose centred in that column. Returned as the boxes `measure()` produces, so
 * the tests exercise the same shape the browser hands over.
 */
function defaultLayout() {
  const columnRect = { left: 250, top: 90, right: 1920, bottom: 900 }
  const proseWidth = 920
  const inset = Math.round((columnRect.right - columnRect.left - proseWidth) / 2)
  const chatRect = {
    left: columnRect.left + inset,
    right: columnRect.left + inset + proseWidth,
    top: columnRect.top,
    bottom: columnRect.bottom,
  }
  return { columnRect, chatRect }
}

// ---------------------------------------------------------------------------
// gutters — measured against the column, not the window
// ---------------------------------------------------------------------------

{
  const { columnRect, chatRect } = defaultLayout()
  const room = gutters(chatRect, columnRect)
  // 1670 column, 920 prose: 375 of real space each side.
  check('both gutters are measured against the column', room.left === 375 && room.right === 375, JSON.stringify(room))
}

{
  // The bug this contract exists for. The prose is 500px from the window edge,
  // but 250px of that is the host's sidebar, which is not ours to draw on. A
  // window-relative measurement says 500; the true answer is 250.
  const room = gutters({ left: 500, right: 1420 }, { left: 250, right: 1670 })
  check('the host sidebar is not counted as usable space', room.left === 250, JSON.stringify(room))
}

{
  // Prose flush to the column edge: the gutter is zero, not negative.
  const room = gutters({ left: 250, right: 1250 }, { left: 250, right: 1920 })
  check('a flush gutter is zero rather than negative', room.left === 0 && room.right === 670, JSON.stringify(room))
}

{
  // Degenerate input must not produce NaN, which would silently become
  // `left: NaNpx` in CSS and drop the panel to the corner.
  const room = gutters(undefined, undefined)
  check('missing input yields zeros', room.left === 0 && room.right === 0, JSON.stringify(room))
}

{
  // With no column, the only space provably ours is none: falling back to the
  // window would re-introduce the sidebar bug in the one case where the layout
  // is unknown.
  const room = gutters({ left: 500, right: 1420 }, undefined)
  check('a missing column yields no gutter rather than the window', room.left === 0 && room.right === 0, JSON.stringify(room))
}

{
  const room = gutters({ left: 260.7, right: 1419.2 }, { left: 250, right: 1920 })
  check('fractional rects are floored', room.left === 10 && room.right === 500, JSON.stringify(room))
}

// ---------------------------------------------------------------------------
// placeCards — the happy path
// ---------------------------------------------------------------------------

{
  const { columnRect, chatRect } = defaultLayout()
  const placed = placeCards({ chatRect, columnRect, side: 'left' })
  check('wide window shows cards', placed.visible === true, JSON.stringify(placed))
  check('cards honour the requested side', placed.side === 'left', placed.side)
  // Hugging the prose means the card's right edge is one gap left of the text.
  check(
    'cards sit one gap left of the prose',
    placed.left + placed.width === chatRect.left - CARD_GAP,
    `${placed.left}+${placed.width} vs prose ${chatRect.left}`,
  )
  // The regression assertion: the old code put the left edge at CARD_GAP, i.e.
  // on top of the sidebar.
  check('cards do not touch the column edge', placed.left > columnRect.left, `${placed.left} vs column ${columnRect.left}`)
  check('card width is the maximum when there is room', placed.width === MAX_CARD_WIDTH, String(placed.width))
  check('cards start below the prose top', placed.top === chatRect.top + TOP_INSET, String(placed.top))
  check(
    'cards stop above the prose bottom',
    placed.height === chatRect.bottom - chatRect.top - TOP_INSET - BOTTOM_INSET,
    String(placed.height),
  )
}

{
  const { columnRect, chatRect } = defaultLayout()
  const placed = placeCards({ chatRect, columnRect, side: 'right' })
  check('the right side is reachable', placed.side === 'right', placed.side)
  check(
    'right-side cards start one gap right of the prose',
    placed.left === chatRect.right + CARD_GAP,
    `${placed.left} vs prose ends ${chatRect.right}`,
  )
  check('and stay inside the column', placed.left + placed.width <= columnRect.right, `${placed.left}+${placed.width}`)
}

// ---------------------------------------------------------------------------
// placeCards — never overlapping the prose, never leaving the column
// ---------------------------------------------------------------------------

{
  // The invariant that matters: whatever the window size, the card box and the
  // prose box must not intersect horizontally. Run it across a sweep so a
  // future tweak to the clamp cannot quietly break one width and pass the rest.
  // Two columns are swept — with and without a host sidebar — because the bug
  // only showed up in the first case.
  let overlap = ''
  for (let width = 900; width <= 2200; width += 50) {
    for (const sidebar of [0, 250]) {
      const columnRect = { left: sidebar, top: 90, right: width, bottom: 900 }
      const columnWidth = width - sidebar
      const prose = Math.min(920, Math.max(680, Math.round(columnWidth * 0.64)))
      // A column narrower than the prose clamp cannot hold the prose; skip it
      // rather than inventing a negative inset.
      if (prose > columnWidth) continue
      const inset = Math.round((columnWidth - prose) / 2)
      const chatRect = {
        left: sidebar + inset,
        right: sidebar + inset + prose,
        top: 90,
        bottom: 900,
      }
      for (const side of ['left', 'right']) {
        const placed = placeCards({ chatRect, columnRect, side })
        if (placed.visible === false) continue
        const cardLeft = placed.left
        const cardRight = placed.left + placed.width
        if (cardLeft < chatRect.right && cardRight > chatRect.left) {
          overlap = `${width}px sidebar=${sidebar} ${side}: card ${cardLeft}..${cardRight} vs prose ${chatRect.left}..${chatRect.right}`
        }
        if (cardLeft < columnRect.left || cardRight > columnRect.right) {
          overlap = `${width}px sidebar=${sidebar} ${side}: card ${cardLeft}..${cardRight} outside column ${columnRect.left}..${columnRect.right}`
        }
        if (placed.width < MIN_CARD_WIDTH) {
          overlap = `${width}px sidebar=${sidebar} ${side}: width ${placed.width} below the minimum`
        }
      }
    }
  }
  check('no window width puts the cards on the prose or outside the column', overlap === '', overlap)
}

// ---------------------------------------------------------------------------
// placeCards — degraded cases
// ---------------------------------------------------------------------------

{
  const placed = placeCards({ chatRect: undefined, columnRect: undefined, side: 'left' })
  check('no conversation means no cards', placed.visible === false, JSON.stringify(placed))
  check('and says why', placed.reason === 'no-conversation', String(placed.reason))
}

{
  // 700 column, 680 prose: 10px of gutter each side. Nothing fits, and the
  // answer must be "no" rather than a 10px-wide column.
  const placed = placeCards({
    chatRect: { left: 10, top: 100, right: 690, bottom: 900 },
    columnRect: { left: 0, top: 90, right: 700, bottom: 900 },
    side: 'left',
  })
  check('a narrow window hides the cards', placed.visible === false, JSON.stringify(placed))
  check('and calls it no-room', placed.reason === 'no-room', String(placed.reason))
}

{
  // A host sidebar wide enough to squeeze the left gutter below the minimum. The
  // prose starts at the column edge, which the old window-relative rule read as
  // "120px of room" and drew on the sidebar.
  const chatRect = { left: 120, top: 100, right: 720, bottom: 900 }
  const columnRect = { left: 120, top: 90, right: 1920, bottom: 900 }
  const placed = placeCards({ chatRect, columnRect, side: 'left' })
  check('a too-tight preferred side falls back to the other side', placed.visible === true && placed.side === 'right', JSON.stringify(placed))
  check(
    'and is placed against the prose, not the window edge',
    placed.left === chatRect.right + CARD_GAP,
    `${placed.left} vs prose ends ${chatRect.right}`,
  )
}

{
  // The case the previous rule got wrong. The left gutter (300) fits a card and
  // is narrower than the right one (620), yet 'left' was requested. Ordering by
  // width flipped this to the right, which meant a right-side preference was
  // flipped to the left on the default layout and vice versa — the setting could
  // never be trusted. The requested side has to win while it fits.
  const columnRect = { left: 0, top: 90, right: 1920, bottom: 900 }
  const placed = placeCards({
    chatRect: { left: 300, top: 100, right: 1300, bottom: 900 },
    columnRect,
    side: 'left',
  })
  check('a fitting preference wins over a wider opposite side', placed.side === 'left', JSON.stringify(placed))

  const mirrored = placeCards({
    chatRect: { left: 620, top: 100, right: 1300, bottom: 900 },
    columnRect,
    side: 'right',
  })
  check('and the same holds for a right preference', mirrored.side === 'right', JSON.stringify(mirrored))
}

{
  // NaN must not survive: Math.max(0, Math.floor(NaN)) is NaN, and NaN is not
  // less than MIN_CARD_WIDTH, so an unguarded gutter produced a visible card of
  // width NaN — rendered as 'left:NaNpx' in the corner.
  const room = gutters({ left: Number.NaN, right: Number.NaN }, { left: 0, right: 1000 })
  check('a NaN gutter is zeroed rather than passed through', room.left === 0 && room.right === 0, JSON.stringify(room))

  const placed = placeCards({
    chatRect: { left: Number.NaN, top: 100, right: Number.NaN, bottom: 900 },
    columnRect: { left: 0, top: 90, right: 1000, bottom: 900 },
    side: 'left',
  })
  check('a NaN rect yields no cards rather than a NaN box', placed.visible === false, JSON.stringify(placed))
  check('and never reports a NaN width', Number.isFinite(placed.width), String(placed.width))
}

{
  // Both sides exactly at the minimum. Written out longhand rather than by calling
  // placeCards to build the expectation: an expectation computed by the function
  // under test asserts nothing.
  //
  // The gutter has to hold the card plus *two* gaps — one to the prose, one to the
  // column edge. The fixture originally budgeted a single gap, which only passed
  // while `usable` subtracted one, i.e. while the card was allowed to touch the
  // column edge.
  const prose = 600
  const gutterEach = MIN_CARD_WIDTH + CARD_GAP * 2 // 200
  const proseLeft = gutterEach
  const placed = placeCards({
    chatRect: { left: proseLeft, top: 100, right: proseLeft + prose, bottom: 900 },
    columnRect: { left: 0, top: 90, right: gutterEach * 2 + prose, bottom: 900 },
    side: 'left',
  })
  check('a gutter exactly at the minimum is used', placed.visible === true, JSON.stringify(placed))
  check('at exactly the minimum width', placed.width === MIN_CARD_WIDTH, String(placed.width))
  check(
    'and its right edge stops one gap short of the prose',
    placed.left === proseLeft - CARD_GAP - MIN_CARD_WIDTH,
    `${placed.left} vs ${proseLeft - CARD_GAP - MIN_CARD_WIDTH}`,
  )
}

{
  // `cardWidth` is a request, not a command: it is clamped to the room.
  const chatRect = { left: 350, top: 100, right: 1670, bottom: 900 }
  const columnRect = { left: 0, top: 90, right: 1920, bottom: 900 }
  const placed = placeCards({ chatRect, columnRect, side: 'left', cardWidth: 400 })
  // Room is 350 - 16 = 334, but the column cap is 300; the smaller of the two wins.
  check('a wider request is clamped to the room and the cap', placed.width === MAX_CARD_WIDTH, String(placed.width))
}

{
  const placed = placeCards({
    chatRect: { left: 800, top: 100, right: 1120, bottom: 900 },
    columnRect: { left: 0, top: 90, right: 1920, bottom: 900 },
    side: 'left',
    cardWidth: 100,
  })
  check('a narrower request is honoured', placed.width === 100, String(placed.width))
}

// ---------------------------------------------------------------------------
// placeHandle
// ---------------------------------------------------------------------------

{
  const { columnRect, chatRect } = defaultLayout()
  const placed = placeCards({ chatRect, columnRect, side: 'left' })
  const handle = placeHandle({ chatRect, columnRect, side: 'left' })
  check('the handle is visible when cards are', handle.visible === true, JSON.stringify(handle))
  check(
    'the handle ends exactly where the prose begins',
    handle.left + HANDLE_WIDTH === chatRect.left,
    `handle ends ${handle.left + HANDLE_WIDTH} vs prose ${chatRect.left}`,
  )
  check(
    'and is flush with the card rather than overlapping it',
    handle.left === placed.left + placed.width,
    `handle ${handle.left} vs card ends ${placed.left + placed.width}`,
  )
  check('the handle sits below the first card', handle.top > placed.top, `${handle.top} vs ${placed.top}`)
}

{
  const { columnRect, chatRect } = defaultLayout()
  const handle = placeHandle({ chatRect, columnRect, side: 'right' })
  const placed = placeCards({ chatRect, columnRect, side: 'right' })
  check('a right-side handle is on the right', handle.side === 'right', JSON.stringify(handle))
  check(
    'and starts exactly at the prose edge, not against the window edge',
    handle.left === chatRect.right,
    `handle ${handle.left} vs prose ends ${chatRect.right}`,
  )
  check(
    'and is flush between the prose and the card',
    handle.left === chatRect.right && handle.left + HANDLE_WIDTH === placed.left,
    `handle ${handle.left}..${handle.left + HANDLE_WIDTH} vs prose ${chatRect.right} and card ${placed.left}`,
  )
}

{
  // No room for cards, but 30px of gutter: the handle must survive, otherwise a
  // narrow window would strand the panel with no way to reopen it.
  const chatRect = { left: 30, top: 100, right: 970, bottom: 900 }
  const columnRect = { left: 0, top: 90, right: 1000, bottom: 900 }
  const handle = placeHandle({ chatRect, columnRect, side: 'left' })
  check('a handle survives when cards cannot fit', handle.visible === true, JSON.stringify(handle))
  check('and stays on the requested side', handle.side === 'left', handle.side)
  check(
    'and hugs the prose rather than the window edge',
    handle.left === 30 - HANDLE_WIDTH,
    `${handle.left} vs prose ${30}`,
  )
  check('and never crosses into the prose', handle.left + HANDLE_WIDTH <= 30, `${handle.left + HANDLE_WIDTH}`)
}

{
  // No room at all, not even for a handle.
  const handle = placeHandle({
    chatRect: { left: 5, top: 100, right: 695, bottom: 900 },
    columnRect: { left: 0, top: 90, right: 700, bottom: 900 },
    side: 'left',
  })
  check('no gutter means no handle', handle.visible === false, JSON.stringify(handle))
}

{
  // Missing rect: the handle must not invent a position.
  const handle = placeHandle({ chatRect: undefined, columnRect: undefined, side: 'left' })
  check('no conversation means no handle', handle.visible === false, JSON.stringify(handle))
}


// ---------------------------------------------------------------------------
// Guards added after the geometry was reviewed
// ---------------------------------------------------------------------------

{
  // A rect whose right edge is missing used to produce `left: NaNpx`, which the
  // browser drops outright — putting the rail back at the origin, the exact bug
  // this module exists to prevent. A NaN edge must refuse, not draw.
  const placed = placeCards({
    chatRect: { left: 500, top: 100, bottom: 900 },
    columnRect: { left: 0, top: 90, right: 1920, bottom: 900 },
    side: 'right',
  })
  check('a missing right edge refuses to place', placed.visible === false, JSON.stringify(placed))
  check('and never emits a NaN left', Number.isFinite(placed.left), String(placed.left))
}

{
  // The handle sits on the prose edge by construction, which is stronger than a
  // clamp: it cannot drift out of the column because it never moves away from the
  // text. An earlier version of this block asserted that a clamp pulled the handle
  // back inside the column. That clamp was unreachable — the branch that reaches
  // this code already guarantees at least HANDLE_WIDTH of clear gutter — so the
  // assertions could be satisfied by any implementation. These cannot.

  const rightHandle = placeHandle({
    chatRect: { left: 100, top: 100, right: 980, bottom: 900 },
    columnRect: { left: 0, top: 90, right: 1000, bottom: 900 },
    side: 'right',
  })
  check('a right handle is visible in this layout', rightHandle.visible === true, JSON.stringify(rightHandle))
  check('a right handle starts exactly at the prose edge', rightHandle.left === 980, String(rightHandle.left))
  check('and follows the cards to the right side', rightHandle.side === 'right', rightHandle.side)

  // The prose starts far enough from the column edge for cards to fit on the left,
  // so the handle stays on the requested side. (With only 20px of left gutter the
  // cards would not fit and the handle would correctly follow them to the right,
  // which is a different behaviour and is covered by the sweep below.)
  const leftHandle = placeHandle({
    chatRect: { left: 200, top: 100, right: 900, bottom: 900 },
    columnRect: { left: 0, top: 90, right: 1920, bottom: 900 },
    side: 'left',
  })
  check('a left handle is visible in this layout', leftHandle.visible === true, JSON.stringify(leftHandle))
  check('a left handle stays on the requested side', leftHandle.side === 'left', leftHandle.side)
  check(
    'a left handle ends exactly at the prose edge',
    leftHandle.left + HANDLE_WIDTH === 200,
    `${leftHandle.left}+${HANDLE_WIDTH} vs prose starts 200`,
  )
}
{
  // A rect whose horizontal edges are fine but whose \`top\` is missing is the one
  // shape that reaches placeHandle's own completeness check: placeCards rejects it
  // (it needs all four), and gutters accepts it (it needs only left/right), so the
  // handle is assigned a side and would then compute \`top\` from NaN.
  //
  // Nothing tested this, which is why deleting placeHandle's guard produced no
  // failure — the guard was load-bearing but unobserved.
  const handle = placeHandle({
    chatRect: { left: 300, top: undefined, right: 900, bottom: 900 },
    columnRect: { left: 0, top: 90, right: 1920, bottom: 900 },
    side: 'left',
  })
  check('a rect missing only its top edge yields no handle', handle.visible === false, JSON.stringify(handle))
  check('and never emits a NaN top', Number.isFinite(handle.top), String(handle.top))
}

{
  // `gutters` is exported and consumed directly, so its own contract needs its own
  // test. Every existing caller went through placeCards, which rejects incomplete
  // rects first — so the gutter check could be deleted and nothing noticed.
  const partial = gutters(
    { left: 300, top: 100, right: undefined, bottom: 900 },
    { left: 0, right: 1920 },
  )
  check('a half-measured rect yields no gutter at all', partial.left === 0 && partial.right === 0, JSON.stringify(partial))
}

{
  // The case the guard on placeCards exists for: a rect with a good left edge and a
  // missing right one. Without the guard, the left gutter measures 300px, which is
  // roomier than MIN_CARD_WIDTH — so a card would be placed using a `right` that was
  // never measured. That is the original bug in miniature, and no existing input
  // distinguished it from refusal.
  const placed = placeCards({
    chatRect: { left: 300, top: 100, right: undefined, bottom: 900 },
    columnRect: { left: 0, right: 1920 },
    side: 'left',
  })
  check('a rect missing its right edge does not place a card', placed.visible === false, JSON.stringify(placed))
  check('and says the conversation was never measured', placed.reason === 'no-conversation', String(placed.reason))
}
{
  // HANDLE_WIDTH is geometry, so it has to equal what the bundle draws.
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const css = /[.]dsse-handle[{][^}]*width:([0-9]+)px/.exec(bundle)
  check('the handle width constant matches the CSS', css !== null && Number(css[1]) === HANDLE_WIDTH, css === null ? 'no rule found' : `css ${css[1]} vs const ${HANDLE_WIDTH}`)
}

{
  // The invariants the deleted clamp was meant to protect, asserted directly
  // rather than argued: for every column width and every prose inset, neither a
  // card nor a handle may leave the column or touch the text.
  //
  // Both paths are swept, and the counts are asserted at the end. The first
  // version of this block only swept insets up to 120, which never leaves enough
  // room to draw a card — so it proved a property of the handle path while its
  // comment claimed the card path, which is the same shape of mistake as the
  // clamp it was supposed to justify removing.
  const insets = [0, 8, 12, 20, 40, 120, 240, 360]
  const columnWidths = [40, 60, 80, 120, 200, 320, 480, 640, 900, 1200, 1600, 2200]
  let violation = ''
  let drawnCards = 0
  let drawnHandles = 0
  const cardsBySide = { left: 0, right: 0 }
  const handlesBySide = { left: 0, right: 0 }

  for (const columnWidth of columnWidths) {
    for (const inset of insets) {
      if (inset * 2 + 200 > columnWidth) continue
      const chatRect = { left: inset, top: 100, right: columnWidth - inset, bottom: 900 }
      const columnRect = { left: 0, top: 90, right: columnWidth, bottom: 900 }

      for (const side of ['left', 'right']) {
        const card = placeCards({ chatRect, columnRect, side })
        if (card.visible) {
          drawnCards += 1
          cardsBySide[card.side] += 1
          if (card.left < 0 || card.left + card.width > columnWidth) {
            violation = `card ${columnWidth}/${inset}/${side}: ${card.left}..${card.left + card.width} outside 0..${columnWidth}`
          }
          if (card.left < chatRect.right && card.left + card.width > chatRect.left) {
            violation = `card ${columnWidth}/${inset}/${side}: ${card.left}..${card.left + card.width} covers prose ${chatRect.left}..${chatRect.right}`
          }
        }

        const handle = placeHandle({ chatRect, columnRect, side })
        if (handle.visible === false) continue
        drawnHandles += 1
        handlesBySide[handle.side] += 1
        if (handle.left < 0 || handle.left + HANDLE_WIDTH > columnWidth) {
          violation = `handle ${columnWidth}/${inset}/${side}: ${handle.left}..${handle.left + HANDLE_WIDTH} outside 0..${columnWidth}`
        }
        if (handle.left < chatRect.right && handle.left + HANDLE_WIDTH > chatRect.left) {
          violation = `handle ${columnWidth}/${inset}/${side}: ${handle.left}..${handle.left + HANDLE_WIDTH} covers prose ${chatRect.left}..${chatRect.right}`
        }
      }
    }
  }

  check('neither a card nor a handle leaves the column or covers the prose', violation === '', violation)
  // Without this the sweep can silently degrade to one branch again, and a green
  // run would say nothing about the branch that was dropped.
  check('the sweep actually drew cards', drawnCards > 0, `drew ${drawnCards}`)
  // Per side, not just in total: deleting one branch left the other side drawing
  // cards, so a bare > 0 stayed green while half the geometry was gone.
  check('the sweep drew cards on both sides', cardsBySide.left > 0 && cardsBySide.right > 0, JSON.stringify(cardsBySide))
  check('the sweep actually drew handles', drawnHandles > 0, `drew ${drawnHandles}`)
  check('the sweep drew handles on both sides', handlesBySide.left > 0 && handlesBySide.right > 0, JSON.stringify(handlesBySide))
}

{
  // Asymmetric gutters, so the fallback side is the only side that fits. Without
  // this case the branch in placeHandle that switches sides is unreachable in
  // every other test here, and deleting it entirely stays green — which is how a
  // narrow window ends up with no way to reopen the panel.
  const chatRect = { left: 20, top: 100, right: 620, bottom: 900 }
  const columnRect = { left: 0, top: 90, right: 630, bottom: 900 }
  const placed = placeCards({ chatRect, columnRect, side: 'right' })
  check('the asymmetric case has no room for a card', placed.visible === false, JSON.stringify(placed))

  const handle = placeHandle({ chatRect, columnRect, side: 'right' })
  check('and the handle falls back to the side that fits', handle.visible === true, JSON.stringify(handle))
  check('which is not the requested side', handle.side === 'left', String(handle.side))
  check('and it is still inside the column', handle.left >= columnRect.left, String(handle.left))

  // The mirror: the requested side works, so no fallback should be taken.
  const mirrored = { left: 20, top: 100, right: 610, bottom: 900 }
  const mirroredColumn = { left: 0, top: 90, right: 620, bottom: 900 }
  const kept = placeHandle({ chatRect: mirrored, columnRect: mirroredColumn, side: 'left' })
  check('a request that fits is not moved to the other side', kept.visible === true && kept.side === 'left', JSON.stringify(kept))
}
// ---------------------------------------------------------------------------
// placeTip: where the hover bubble goes.
//
// Every other fixture in this file puts the trigger at top 300 on a 1000px
// window, where a bubble below it always fits. That is why the vertical clamp was
// missing for several review rounds while the horizontal one had already been
// fixed: nothing in the suite could see the difference. These cases exist to make
// it visible.
// ---------------------------------------------------------------------------

{
  const trigger = { left: 100, right: 140, top: 296, bottom: 316 }
  const placed = placeTip({ trigger, viewportWidth: 1600, viewportHeight: 1000 })
  check('a bubble with room below opens below its trigger', placed.visible === true && placed.top === trigger.bottom + TIP_OFFSET, String(placed.top))
  check('and keeps the trigger left edge when it fits', placed.left === trigger.left, String(placed.left))
  check('and declares the width the stylesheet declares', placed.width === TIP_WIDTH, String(placed.width))
}

{
  // The case the sixth review found: the trigger sits near the bottom of a short
  // window, so `bottom + TIP_OFFSET` is within a bubble's height of the edge.
  const trigger = { left: 900, right: 940, top: 900, bottom: 920 }
  const placed = placeTip({ trigger, viewportWidth: 1600, viewportHeight: 1000 })
  check('a bubble with no room below flips above its trigger', placed.visible === true && placed.top === trigger.top - TIP_OFFSET - TIP_HEIGHT, String(placed.top))
  check('and the flipped bubble is entirely on screen', placed.top >= TIP_MARGIN && placed.top + TIP_HEIGHT <= 1000 - TIP_MARGIN, `${placed.top}..${placed.top + TIP_HEIGHT}`)
}

{
  // Sliding is the fallback for a viewport too short to fit the bubble either way.
  // Some overlap beats an invisible bubble, but it still may not leave the screen.
  const trigger = { left: 100, right: 140, top: 20, bottom: 40 }
  const placed = placeTip({ trigger, viewportWidth: 1600, viewportHeight: 120 })
  check('a viewport too short to fit either way still places the bubble', placed.visible === true, JSON.stringify(placed))
  check('and never pushes it above the top margin', placed.top >= TIP_MARGIN, String(placed.top))
}

{
  // Unmeasurable inputs must not become coordinates: a zero trigger would draw the
  // bubble in the corner, which reads as a bug rather than as "unknown".
  check('an unmeasurable trigger hides the bubble', placeTip({ trigger: null, viewportWidth: 1600 }).visible === false)
  check('a trigger missing a horizontal edge hides the bubble', placeTip({ trigger: { left: NaN, top: 1, bottom: 2 }, viewportWidth: 1600 }).visible === false)
  check('a trigger missing a vertical edge hides the bubble', placeTip({ trigger: { left: 1, top: undefined, bottom: 2 }, viewportWidth: 1600 }).visible === false)
}

{
  // Same fallback rule as the horizontal clamp, and the same reason: an
  // unmeasurable viewport means "unknown", not "no limit". With no window to clamp
  // against, the bubble's own right edge is the boundary, which puts its left edge
  // one margin to the left of the trigger.
  const trigger = { left: 900, right: 940, top: 300, bottom: 320 }
  const placed = placeTip({ trigger, viewportWidth: undefined, viewportHeight: undefined })
  check('an unmeasurable viewport still opens the bubble below', placed.visible === true && placed.top === trigger.bottom + TIP_OFFSET, String(placed.top))
  check('and clamps it against the trigger instead of the window', placed.left === trigger.left - TIP_MARGIN, String(placed.left))

  // With no height to clamp against, the top margin is the only boundary left.
  // Without it a trigger reported above the window — a rect read mid-scroll —
  // puts the bubble at a negative `top`, i.e. rendered but invisible.
  const stranded = placeTip({
    trigger: { left: 900, right: 940, top: -400, bottom: -380 },
    viewportWidth: undefined,
    viewportHeight: undefined,
  })
  check(
    'and never places it above the top margin when the height is unknown',
    stranded.visible === true && stranded.top === TIP_MARGIN,
    String(stranded.top),
  )
}

{
  // The invariant: whatever the window size and wherever the trigger is, a placed
  // bubble is on screen. This sweep is what a single-axis fixture cannot express,
  // and it is what would have caught the missing vertical clamp.
  let escapes = 0
  let escapesDetail = ''
  for (const viewportWidth of [400, 720, 900, 1200, 1600, 1920, 2560]) {
    // 120 and 170 are below TIP_HEIGHT + 2 * TIP_MARGIN on purpose. The six round
    // numbers above all leave room for the bubble, so the "too short to fit"
    // branch was never entered and a mutation that deleted its clamp survived.
    for (const viewportHeight of [120, 170, 200, 400, 600, 800, 1000, 1440]) {
      // Negative and past-the-bottom positions are not hypothetical: a rect read
      // while the rail is mid-scroll reports exactly those. The seventh review
      // found that the sweep only ever used in-window positions, so the one-sided
      // clamp it exposed was invisible to 1575 passing assertions.
      for (const top of [-300, -8, 0, 40, 300, viewportHeight - 120, viewportHeight - 60, viewportHeight + 200]) {
        const trigger = { left: 120, right: 160, top, bottom: top + 20 }
        const placed = placeTip({ trigger, viewportWidth, viewportHeight })
        if (placed.visible === false) {
          escapes += 1
          escapesDetail = `hidden at ${viewportWidth}x${viewportHeight} top ${top}`
          continue
        }
        if (placed.left < TIP_MARGIN) {
          escapes += 1
          escapesDetail = `left ${placed.left} at ${viewportWidth}x${viewportHeight}`
        }
        // A window narrower than the bubble cannot hold it with margins, so the
        // right edge is only asserted when the bubble could fit at all.
        if (viewportWidth >= TIP_WIDTH + TIP_MARGIN * 2) {
          if (placed.left + placed.width > viewportWidth - TIP_MARGIN) {
            escapes += 1
            escapesDetail = `right edge ${placed.left + placed.width} at ${viewportWidth}x${viewportHeight}`
          }
        }
        if (placed.top < TIP_MARGIN) {
          escapes += 1
          escapesDetail = `top ${placed.top} at ${viewportWidth}x${viewportHeight}`
        }
        if (viewportHeight >= TIP_HEIGHT + TIP_MARGIN * 2) {
          if (placed.top + TIP_HEIGHT > viewportHeight - TIP_MARGIN) {
            escapes += 1
            escapesDetail = `bottom ${placed.top + TIP_HEIGHT} at ${viewportWidth}x${viewportHeight}`
          }
        } else {
          // Too short to hold the bubble: the lower edge must hang out, by
          // construction. What is still owed is that the bubble's own top edge is
          // on screen, so the first line — the part that says what the button
          // does — is readable. Without this the "too short" branch could return
          // any large number for a trigger reported below the window and pass.
          if (placed.top > viewportHeight - TIP_MARGIN) {
            escapes += 1
            escapesDetail = `top edge ${placed.top} past ${viewportHeight} at ${viewportWidth}x${viewportHeight} top ${top}`
          }
        }
      }
    }
  }
  check('no window size or trigger position puts the bubble off screen', escapes === 0, escapesDetail)
}

{
  // The sweep above proves the invariant, not the arithmetic that upholds it: a
  // window sized 176 (exactly TIP_HEIGHT + 2 * TIP_MARGIN) is the boundary between
  // the two vertical branches, and no sweep value lands on it. Each assertion
  // below is one the reviewer's mutations survived before it existed.
  const tall = TIP_HEIGHT + TIP_MARGIN * 2
  const below = { left: 100, right: 140, top: 2000, bottom: 2020 }

  // Just under the gate the bubble hugs the bottom edge; at the gate it snaps to
  // the top one. Both numbers are stated so a 1px shift of the gate is visible.
  check(
    'a window 1px too short keeps the bubble against the bottom edge',
    placeTip({ trigger: below, viewportWidth: 1600, viewportHeight: tall - 1 }).top === tall - 1 - TIP_MARGIN,
    String(placeTip({ trigger: below, viewportWidth: 1600, viewportHeight: tall - 1 }).top),
  )
  check(
    'a window exactly tall enough uses the full clamp',
    placeTip({ trigger: below, viewportWidth: 1600, viewportHeight: tall }).top === TIP_MARGIN,
    String(placeTip({ trigger: below, viewportWidth: 1600, viewportHeight: tall }).top),
  )
  // The too-short branch must not be reachable from a window that can hold the
  // bubble: pinning it to TIP_MARGIN would pass the tall case and fail this one.
  check(
    'a window tall enough still places a trigger high on screen below it',
    placeTip({ trigger: { left: 100, right: 140, top: 40, bottom: 60 }, viewportWidth: 1600, viewportHeight: 1000 }).top === 64,
    String(placeTip({ trigger: { left: 100, right: 140, top: 40, bottom: 60 }, viewportWidth: 1600, viewportHeight: 1000 }).top),
  )
  // A viewport of 0 is not a viewport. Treating it as one collapses edge to 0 and
  // clamps a 900px-left trigger to the left margin; the unmeasurable path instead
  // reserves the bubble to the right of the trigger.
  check(
    'a zero-width viewport is treated as unmeasurable, not as zero',
    placeTip({ trigger: { left: 900, right: 940, top: 300, bottom: 320 }, viewportWidth: 0, viewportHeight: 800 }).left === 892,
    String(placeTip({ trigger: { left: 900, right: 940, top: 300, bottom: 320 }, viewportWidth: 0, viewportHeight: 800 }).left),
  )
  check(
    'a zero-height viewport is treated as unmeasurable, not as zero',
    placeTip({ trigger: below, viewportWidth: 1600, viewportHeight: 0 }).top === below.bottom + TIP_OFFSET,
    String(placeTip({ trigger: below, viewportWidth: 1600, viewportHeight: 0 }).top),
  )
  // foot < 2 * TIP_MARGIN is where the two bounds would cross: without the inner
  // Math.max the floor wins and Math.min returns a negative bound.
  check(
    'a viewport shorter than twice the margin does not cross the clamp',
    placeTip({ trigger: { left: 100, right: 140, top: 300, bottom: 320 }, viewportWidth: 1600, viewportHeight: 15 }).top === TIP_MARGIN,
    String(placeTip({ trigger: { left: 100, right: 140, top: 300, bottom: 320 }, viewportWidth: 1600, viewportHeight: 15 }).top),
  )
  // The left clamp was only ever exercised by one fixture with a positive left.
  check(
    'a trigger scrolled off the left edge is clamped to the margin',
    placeTip({ trigger: { left: -500, right: -460, top: 300, bottom: 320 }, viewportWidth: 400, viewportHeight: 800 }).left === TIP_MARGIN,
    String(placeTip({ trigger: { left: -500, right: -460, top: 300, bottom: 320 }, viewportWidth: 400, viewportHeight: 800 }).left),
  )
}

console.log(`
${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
