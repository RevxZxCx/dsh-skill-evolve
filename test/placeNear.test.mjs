// Tests for `placeNear` — the two-layer popover geometry.
//
// The invariant that matters is not "the list opens to the right". It is that
// neither layer leaves the viewport, and that the detail card is anchored to the
// LIST rather than to the row (anchoring to the row drew the detail on top of
// the list, because a row's right edge is inside the popover).
import { placeNear, PANEL_WIDTH, DETAIL_WIDTH, POPOVER_GAP, EDGE_MARGIN } from '../lib/gutter.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) passed += 1
  else {
    failed += 1
    failures.push(`${label} — ${detail}`)
  }
}

const anchor = (left, top, width = 40, height = 26) => ({
  left,
  right: left + width,
  top,
  bottom: top + height,
})

// --- a popover opens beside its anchor, on the requested side when it fits ---
{
  const box = placeNear({ anchor: anchor(300, 200), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  check('it opens to the right when asked', box.side === 'right', box.side)
  check('clear of the anchor by the gap', box.left === 340 + POPOVER_GAP, String(box.left))
  check('top-aligned with the anchor', box.top === 200, String(box.top))
  check('it kept the requested width', box.width === PANEL_WIDTH, String(box.width))
}

{
  const box = placeNear({ anchor: anchor(1200, 200), width: PANEL_WIDTH, height: 200, side: 'left', viewportWidth: 1600, viewportHeight: 1000 })
  check('it opens to the left when asked', box.side === 'left', box.side)
  check('right edge is one gap from the anchor', box.left + box.width === 1200 - POPOVER_GAP, String(box.left))
}

// --- a side that does not fit is a preference, not a constraint -------------
{
  // 300px from the right edge cannot hold a 320px list.
  const box = placeNear({ anchor: anchor(1270, 200), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  check('a side without room falls back to the other', box.side === 'left', box.side)
  check('the fallback is still on screen', box.left >= EDGE_MARGIN && box.left + box.width <= 1600 - EDGE_MARGIN, String(box.left))
}

// --- neither side fits: cover the conversation, never leave the screen ------
{
  const box = placeNear({ anchor: anchor(700, 300), width: DETAIL_WIDTH, height: 240, side: 'right', viewportWidth: 760, viewportHeight: 1000 })
  check('a narrow window still places the box', box.visible === true)
  check('and clamps it inside the left edge', box.left >= EDGE_MARGIN, String(box.left))
  check('and inside the right edge', box.left + box.width <= 760 - EDGE_MARGIN, String(box.left + box.width))
}

// --- the anchor box is what is honoured, not the row ------------------------
{
  // A detail card anchored to a row's own right edge would start inside the
  // list. Anchored to the list box, it starts to the right of it.
  const listBox = { left: 300, right: 620, top: 180, bottom: 420 }
  const box = placeNear({ anchor: listBox, width: DETAIL_WIDTH, height: 300, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  check('the detail clears the list it is anchored to', box.left >= listBox.right + POPOVER_GAP, String(box.left))
}

// --- degenerate anchors hide rather than draw in a corner -------------------
for (const bad of [
  undefined,
  null,
  {},
  { left: Number.NaN, right: 10, top: 10 },
  { left: 10, top: Number.NaN },
]) {
  const box = placeNear({ anchor: bad, width: PANEL_WIDTH, height: 200, viewportWidth: 1600, viewportHeight: 1000 })
  check(`an unusable anchor hides the popover (${JSON.stringify(bad)})`, box.visible === false, JSON.stringify(box))
}

// --- an unmeasurable viewport still refuses to leave the left edge ---------
{
  const box = placeNear({ anchor: anchor(900, 300), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: undefined, viewportHeight: undefined })
  check('an unmeasurable viewport still places it', box.visible === true)
  check('it prefers the requested side when room is unknown', box.side === 'right', box.side)
  check('and it does not start left of the margin', box.left >= EDGE_MARGIN, String(box.left))
}

// --- the vertical settle is shared, so prove placeNear inherits it ---------
{
  const low = placeNear({ anchor: anchor(300, 980), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  check('a box near the bottom is pulled up', low.top + 200 <= 1000 - EDGE_MARGIN, String(low.top))

  const high = placeNear({ anchor: anchor(300, -200), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  check('a box above the viewport is pulled down', high.top >= EDGE_MARGIN, String(high.top))

  const short = placeNear({ anchor: anchor(300, 300), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 1600, viewportHeight: 120 })
  check('a window too short keeps the top edge visible', short.top >= EDGE_MARGIN, String(short.top))
  check('and does not push it past the window', short.top <= 120 - EDGE_MARGIN, String(short.top))
}

// --- sweep: nothing leaves the viewport, at any window or anchor position ---
{
  let escapes = 0
  let detail = ''
  let placed = 0
  let flipped = 0
  for (const viewportWidth of [320, 400, 600, 760, 900, 1200, 1600, 1920, 2560]) {
    for (const viewportHeight of [120, 176, 240, 400, 600, 800, 1000, 1440]) {
      for (const top of [-300, -8, 0, 40, 300, viewportHeight - 120, viewportHeight + 200]) {
        for (const left of [0, 2, 200, 380, viewportWidth - 60, viewportWidth + 80]) {
          for (const width of [PANEL_WIDTH, DETAIL_WIDTH]) {
            for (const side of ['left', 'right']) {
              const box = placeNear({ anchor: anchor(left, top), width, height: 240, side, viewportWidth, viewportHeight })
              if (box.visible === false) continue
              placed += 1
              if (box.side !== side) flipped += 1
              if (box.left < EDGE_MARGIN) {
                escapes += 1
                detail = `left ${box.left} at ${viewportWidth}x${viewportHeight} anchor ${left},${top} w${width}`
              }
              if (box.top < EDGE_MARGIN) {
                escapes += 1
                detail = `top ${box.top} at ${viewportWidth}x${viewportHeight} anchor ${left},${top}`
              }
              // The bottom edge is only owed when the window can hold the box.
              if (viewportHeight >= 240 + EDGE_MARGIN * 2 && box.top + 240 > viewportHeight - EDGE_MARGIN) {
                escapes += 1
                detail = `bottom ${box.top + 240} at ${viewportWidth}x${viewportHeight}`
              }
              // The right edge is only owed when the window is wider than the box.
              if (viewportWidth >= width + EDGE_MARGIN * 2 && box.left + width > viewportWidth - EDGE_MARGIN) {
                escapes += 1
                detail = `right ${box.left + width} at ${viewportWidth}x${viewportHeight} w${width}`
              }
            }
          }
        }
      }
    }
  }
  check('no window or anchor puts a popover off screen', escapes === 0, detail)
  // Guard against the sweep collapsing to "everything hidden": a visible:false
  // everywhere would satisfy the assertions above without placing anything.
  check('the sweep actually placed popovers', placed > 0, String(placed))
  // And against it never exercising the fallback: the requested side must lose
  // sometimes, or the branch that handles it is dead.
  check('the sweep reached the side-fallback branch', flipped > 0, `${flipped} of ${placed} flipped`)
}

// --- the two layers stack without overlapping ------------------------------
{
  const button = anchor(300, 200)
  const list = placeNear({ anchor: button, width: PANEL_WIDTH, height: 260, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  const detail = placeNear({ anchor: { left: list.left, right: list.left + list.width, top: list.top, bottom: list.top + 260 }, width: DETAIL_WIDTH, height: 300, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  check('the detail starts right of the list', detail.left >= list.left + list.width + POPOVER_GAP, `${list.left}+${list.width} vs ${detail.left}`)
  check('the two layers do not overlap horizontally', detail.left >= list.left + list.width, `${detail.left}`)
}


// --- the settle applies at the edges: a popover may not leave the window ---
//
// The first version of this file only ever placed anchors that were already
// inside the window, so deleting the settle changed nothing and the mutation
// survived. An anchor near an edge is exactly the case the settle exists for.
//
// These fixtures no longer pass `alignTop`. That parameter was removed because
// both of its arms were the same expression — see the note in lib/gutter.js.
{
  const low = placeNear({ anchor: anchor(300, 980), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  check('a popover whose anchor is near the bottom is pulled inside', low.top + 200 <= 1000 - EDGE_MARGIN, String(low.top))

  const high = placeNear({ anchor: anchor(300, -200), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  check('a popover whose anchor is above the window is pulled down', high.top >= EDGE_MARGIN, String(high.top))

  const short = placeNear({ anchor: anchor(300, 300), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 1600, viewportHeight: 120 })
  check('a popover in a short window keeps its top edge', short.top >= EDGE_MARGIN, String(short.top))
  check('and stays inside that window', short.top <= 120 - EDGE_MARGIN, String(short.top))
}


// The mirror of the case above. Both directions have to be covered: removing
// only the right-hand fallback left this suite green, because the only
// fallback it exercised went right-to-left.
{
  const box = placeNear({ anchor: anchor(120, 200), width: PANEL_WIDTH, height: 200, side: 'left', viewportWidth: 1600, viewportHeight: 1000 })
  check('a left preference with no room on the left falls back right', box.side === 'right', box.side)
  check('the fallback still clears the anchor', box.left >= 120 + 40 + POPOVER_GAP, String(box.left))
}


// The preference has to beat the room tiebreak, not merely agree with it.
// Every other fixture puts the anchor on the side where the preferred
// direction also has more room, so `preferred = auto` produced identical
// output and the mutation survived. An anchor in the right half with the
// list opening right is the case where the two rules disagree.
{
  const box = placeNear({ anchor: anchor(1200, 200), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  check('the preferred side wins even when the other side has more room', box.side === 'right', box.side)
  check('and it opened clear of the anchor', box.left === 1200 + 40 + POPOVER_GAP, String(box.left))
}

// --- the exact gate between "tall enough" and "too short" ------------------
//
// `clampTop` has three branches and the gate between the first two is
// `viewportHeight >= height + 2 * EDGE_MARGIN`. The sweep above only visits
// window heights that sit far from that line, so a mutation moving the gate by
// a single pixel would survive it. These fixtures sit exactly on the line, one
// below it and one above it.
{
  const height = 160
  const tall = height + EDGE_MARGIN * 2

  // Exactly tall enough: the bottom edge is owed, so the box is pulled up to
  // the top margin rather than left hanging off the bottom.
  const exact = placeNear({ anchor: anchor(300, 900), width: PANEL_WIDTH, height, side: 'right', viewportWidth: 1600, viewportHeight: tall })
  check('a window exactly tall enough pulls the box to the top margin', exact.top === EDGE_MARGIN, `${exact.top} at ${tall}`)
  check('and its bottom edge stays inside', exact.top + height === tall - EDGE_MARGIN, `${exact.top + height} vs ${tall - EDGE_MARGIN}`)

  // One pixel shorter: the bottom edge can no longer be owed. The box settles
  // against the bottom of the window instead, so the first line of text stays
  // readable; the overflow is accepted and pushed off the bottom, not the top.
  const short = placeNear({ anchor: anchor(300, 900), width: PANEL_WIDTH, height, side: 'right', viewportWidth: 1600, viewportHeight: tall - 1 })
  check('one pixel shorter keeps the top edge visible', short.top >= EDGE_MARGIN, `${short.top} at ${tall - 1}`)
  check('and parks against the bottom of the window', short.top === tall - 1 - EDGE_MARGIN, `${short.top} vs ${tall - 1 - EDGE_MARGIN}`)

  // One pixel taller: the bottom bound comes back.
  const over = placeNear({ anchor: anchor(300, 900), width: PANEL_WIDTH, height, side: 'right', viewportWidth: 1600, viewportHeight: tall + 1 })
  check('one pixel taller restores the bottom bound', over.top + height === tall + 1 - EDGE_MARGIN, `${over.top + height}`)
}

// --- degenerate viewports mean "unknown", not "zero" ----------------------
//
// A `0` reaching the arithmetic produces a box pinned to the top-left corner,
// which reads as a bug rather than as "the window could not be measured". Each
// of these three used to be its own branch in the retired hover-bubble test.
{
  const zeroWidth = placeNear({ anchor: anchor(900, 300), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 0, viewportHeight: 1000 })
  check('a zero-width window is treated as unmeasurable', zeroWidth.visible === true && zeroWidth.left >= EDGE_MARGIN, JSON.stringify(zeroWidth))

  const zeroHeight = placeNear({ anchor: anchor(300, 300), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 1600, viewportHeight: 0 })
  check('a zero-height window does not pin the box to the top', zeroHeight.top === 300, String(zeroHeight.top))

  // Shorter than two margins: there is no band left to clamp into, so only the
  // top margin survives. Cross-clamping here would invert the bounds.
  const tiny = placeNear({ anchor: anchor(300, 300), width: PANEL_WIDTH, height: 200, side: 'right', viewportWidth: 1600, viewportHeight: 15 })
  check('a window shorter than two margins still keeps the top edge', tiny.top === EDGE_MARGIN, String(tiny.top))
}

// --- per-height sweep: the bottom is owed only when the window can hold it --
//
// The main sweep fixes the box height at 240, so for each window height it only
// ever visits one side of the gate. Sweeping the height too is what turns "the
// bottom bound is conditional, the top bound is not" into a real invariant
// rather than a coincidence of the one height that was picked.
{
  let escapes = 0
  let detail = ''
  for (const height of [80, 160, 240, 300]) {
    const tall = height + EDGE_MARGIN * 2
    for (const viewportHeight of [tall - 1, tall, tall + 1, 1000]) {
      for (const top of [-400, 0, viewportHeight - 40, viewportHeight + 200]) {
        const box = placeNear({ anchor: anchor(300, top), width: PANEL_WIDTH, height, side: 'right', viewportWidth: 1600, viewportHeight })
        if (box.visible === false) continue
        if (box.top < EDGE_MARGIN) {
          escapes += 1
          detail = `top ${box.top} h${height} at vh${viewportHeight} anchor ${top}`
        }
        if (viewportHeight >= tall && box.top + height > viewportHeight - EDGE_MARGIN) {
          escapes += 1
          detail = `bottom ${box.top + height} h${height} at vh${viewportHeight} anchor ${top}`
        }
      }
    }
  }
  check('every box height keeps the top edge, and the bottom when it can', escapes === 0, detail)
}

// --- the detail card steps around the list it belongs to --------------------
//
// The first version only clamped the card into the viewport. In any window
// narrower than about 1280px that put the card back over the list's own
// approve/ignore column, so hovering a row to read its detail made the buttons
// on that row unreachable. `avoid` is what stops it, and the assertion has to be
// "the two do not intersect" — being on screen and on top of the buttons is
// exactly the failure.
{
  // Both arguments carry left/top/width/height. The first version mixed a
  // {left,right,top,bottom} box into a predicate that added `width`, so every
  // product was NaN, every comparison was false, and the assertion passed no
  // matter what the geometry did — the mutation proved it.
  const overlaps = (a, b) =>
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top

  const stuck = []
  for (const viewportWidth of [768, 900, 1024, 1280, 1440, 1920]) {
    for (const side of ['left', 'right']) {
      const button = anchor(600, 300)
      const list = placeNear({ anchor: button, width: PANEL_WIDTH, height: 260, side, viewportWidth, viewportHeight: 1000 })
      // Carries both shapes on purpose: `avoid` reads right/bottom, the overlap
      // predicate reads width/height. Handing `avoid` a box without right/bottom
      // made it a point, which is how the first version of this test passed with
      // the feature removed.
      const listBox = { left: list.left, top: list.top, width: list.width, height: 260, right: list.left + list.width, bottom: list.top + 260 }
      const detail = placeNear({
        anchor: { left: listBox.left, right: listBox.right, top: listBox.top, bottom: listBox.bottom },
        width: DETAIL_WIDTH,
        height: 300,
        side: list.side === 'left' ? 'left' : 'right',
        avoid: listBox,
        viewportWidth,
        viewportHeight: 1000,
      })
      const detailBox = { left: detail.left, top: detail.top, width: detail.width, height: 300 }
      if (overlaps(detailBox, listBox)) stuck.push(`vw${viewportWidth} ${side} detail=${JSON.stringify(detailBox)} list=${JSON.stringify(listBox)}`)
      if (detail.top < EDGE_MARGIN) stuck.push(`vw${viewportWidth} ${side} detail off the top at ${detail.top}`)
    }
  }
  check('the detail card never covers the list it hangs off', stuck.length === 0, stuck.join(' | '))

  // The sweep above would also pass if `avoid` simply pushed the card off the
  // bottom of the window, so the arrangement it chose has to be on screen too.
  const probe = placeNear({
    anchor: { left: 648, right: 968, top: 300, bottom: 560 },
    width: DETAIL_WIDTH,
    height: 300,
    side: 'left',
    avoid: { left: 648, right: 968, top: 300, bottom: 560 },
    viewportWidth: 900,
    viewportHeight: 1000,
  })
  check('the card it settles on is itself inside the viewport', probe.top >= EDGE_MARGIN && probe.top + 300 <= 1000 - EDGE_MARGIN, JSON.stringify(probe))
}

{
  // A window barely tall enough for both boxes has nowhere to go. Covering the
  // list is the fallback then — but the card still has to exist and keep its top
  // on screen rather than being drawn at a negative offset.
  const button = anchor(600, 20)
  const list = placeNear({ anchor: button, width: PANEL_WIDTH, height: 260, side: 'right', viewportWidth: 1600, viewportHeight: 320 })
  const listBox = { left: list.left, right: list.left + list.width, top: list.top, bottom: list.top + 260 }
  const detail = placeNear({
    anchor: { left: listBox.left, right: listBox.right, top: listBox.top, bottom: listBox.bottom },
    width: DETAIL_WIDTH,
    height: 300,
    side: 'right',
    avoid: listBox,
    viewportWidth: 1600,
    viewportHeight: 320,
  })
  check('a too-short window still places the detail card', detail.visible === true, JSON.stringify(detail))
  check('and keeps its top edge on screen', detail.top >= EDGE_MARGIN, String(detail.top))
}

{
  // `avoid` must not move a card that is already clear of the rectangle.
  const button = anchor(600, 300)
  const list = placeNear({ anchor: button, width: PANEL_WIDTH, height: 260, side: 'right', viewportWidth: 1920, viewportHeight: 1000 })
  const listBox = { left: list.left, right: list.left + list.width, top: list.top, bottom: list.top + 260 }
  const anchorBox = { left: listBox.left, right: listBox.right, top: listBox.top, bottom: listBox.bottom }
  const plain = placeNear({ anchor: anchorBox, width: DETAIL_WIDTH, height: 300, side: 'right', viewportWidth: 1920, viewportHeight: 1000 })
  const avoided = placeNear({ anchor: anchorBox, width: DETAIL_WIDTH, height: 300, side: 'right', avoid: listBox, viewportWidth: 1920, viewportHeight: 1000 })
  check('a card with room beside the list is left where it was', avoided.left === plain.left && avoided.top === plain.top, `${JSON.stringify(plain)} vs ${JSON.stringify(avoided)}`)
}

{
  // The rectangle is optional, and a degenerate one must not throw.
  const box = placeNear({ anchor: anchor(300, 200), width: PANEL_WIDTH, height: 200, side: 'right', avoid: null, viewportWidth: 1600, viewportHeight: 1000 })
  check('a null avoid rectangle is ignored', box.visible === true && box.top === 200, JSON.stringify(box))
  const partial = placeNear({
    anchor: anchor(300, 200),
    width: PANEL_WIDTH,
    height: 200,
    side: 'right',
    avoid: { left: 300 },
    viewportWidth: 1600,
    viewportHeight: 1000,
  })
  check('a rectangle without a right edge is treated as a point', partial.visible === true, JSON.stringify(partial))
}


// --- An anchor known only by its left edge cannot be placed -----------------
//
// Both candidate sides are measured from `anchor.right`, so an anchor without one
// used to produce `left: NaN`: not hidden, not placed, but a box the browser
// quietly drops at a static position. Requiring the right edge was the honest
// fix; this pins it so it cannot regress into a NaN.
{
  const box = placeNear({ anchor: { left: 10, top: 10 }, width: PANEL_WIDTH, height: 260, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  check('an anchor without a right edge is not placed', box.visible === false, JSON.stringify(box))

  const rect = placeNear({ anchor: { left: 10, right: 60, top: 10 }, width: PANEL_WIDTH, height: 260, side: 'right', viewportWidth: 1600, viewportHeight: 1000 })
  check('a missing bottom edge does not stop placement', rect.visible === true, JSON.stringify(rect))
  check('and the resulting top is a finite number', Number.isFinite(rect.top), JSON.stringify(rect))
}

// --- A rectangle to avoid with no bottom edge still escapes cleanly ---------
//
// `covers` tolerates a missing bottom by treating the rectangle as a point; the
// escape arithmetic used to read `avoid.bottom` directly and produce `top: NaN`
// for exactly that input, so the two disagreed about what "missing edge" means.
{
  const avoided = placeNear({
    anchor: { left: 488, right: 900, top: 400, bottom: 460 },
    width: DETAIL_WIDTH,
    height: 300,
    side: 'right',
    avoid: { left: 488, right: 900, top: 200 },
    viewportWidth: 1200,
    viewportHeight: 1000,
  })
  check('an avoid rectangle without a bottom edge still yields a number', Number.isFinite(avoided.top), JSON.stringify(avoided))
  check('and the box is not placed at the top of the window by accident', avoided.top >= EDGE_MARGIN, JSON.stringify(avoided))
}

console.log(`
${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failed === 0 ? 0 : 1)
