/**
 * Tests for the resident monitor column's geometry.
 *
 * The monitor column is not the card rail. The cards are annotations that hug
 * the prose inside whatever gutter is left over; the monitor column is a strip
 * the conversation *makes room for*, so its geometry is a subtraction problem:
 * the column gets `width`, the prose keeps `column - width`.
 *
 * That difference is why these live in their own file. `placeCards` can legally
 * return `visible: false` whenever the gutters are tight — the panel degrades to
 * a handle and the user clicks it. The monitor column must not do that on any
 * window where the column physically fits, because "the panel is not there" is
 * the exact complaint the column exists to fix. On a 1440px window with the host
 * sidebar open the gutter is 209px, narrower than the 288px cards, so the old
 * layout squeezed the panel or dropped it precisely where it was wanted.
 *
 * The numbers used below come from the host's own rule, so they describe the
 * real app: `--dsh-chat-content-width: clamp(680px, column × 0.64, 920px)` and a
 * 1440px viewport with the sidebar open leaves a 1160px conversation column.
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

import {
  placeMonitor,
  TURN_RAIL_WIDTH,
  MONITOR_MIN_WIDTH,
  MONITOR_MAX_WIDTH,
  MONITOR_MIN_PROSE
} from '../packages/ui-evolve/lib/gutter.js'

const column = (overrides) => ({ left: 0, top: 0, right: 1160, bottom: 800, ...overrides })

// The constants are load-bearing, so pin them. If MIN_WIDTH ever rises above
// MAX_WIDTH the clamp silently inverts and every window gets the same width.
check('the width floor is below the ceiling', MONITOR_MIN_WIDTH < MONITOR_MAX_WIDTH, `${MONITOR_MIN_WIDTH}..${MONITOR_MAX_WIDTH}`)
check('the prose floor is below the host clamp floor', MONITOR_MIN_PROSE < 680, String(MONITOR_MIN_PROSE))

{
  // The design case: 1160px of column, a 300px monitor, 860px of prose.
  const placed = placeMonitor({ columnRect: column(), width: 300 })
  check('a 300px monitor fits a 1160px column', placed.visible === true, JSON.stringify(placed))
  check('it sits against the right edge', placed.left === 860 && placed.left + placed.width === 1160, JSON.stringify(placed))
  check('it spans the column vertically', placed.top === 0 && placed.height === 800, JSON.stringify(placed))
  // `reserve` is what the caller subtracts from the prose. It must equal the
  // column width, not twice it: the prose is a centred box, so a margin of W
  // narrows it by exactly W. An earlier version reserved 2W, which looked right
  // in the one screenshot it was checked against and was wrong at every other
  // width.
  check('the reserved width is the column width', placed.reserve === 300, String(placed.reserve))
}

{
  // Asking for more than the ceiling is a request, not an instruction.
  const placed = placeMonitor({ columnRect: column({ right: 1400 }), width: 900 })
  check('a width above the ceiling is clamped', placed.width === MONITOR_MAX_WIDTH, String(placed.width))
  check('and it is still flush with the right edge', placed.left + placed.width === 1400, JSON.stringify(placed))
}

{
  // A missing width means "use the design default", not "zero".
  const absent = placeMonitor({ columnRect: column(), width: undefined })
  check('a missing width falls back to the ceiling', absent.width === MONITOR_MAX_WIDTH, String(absent.width))

  // NaN reaches the DOM as `width:NaNpx`, where the box collapses to its content
  // and the column looks like it vanished. `placeCards` learned this the hard way.
  const nan = placeMonitor({ columnRect: column(), width: Number.NaN })
  check('a NaN width falls back to the ceiling', nan.width === MONITOR_MAX_WIDTH, String(nan.width))
  const zero = placeMonitor({ columnRect: column(), width: 0 })
  check('a zero width falls back to the ceiling', zero.width === MONITOR_MAX_WIDTH, String(zero.width))
  const negative = placeMonitor({ columnRect: column(), width: -40 })
  check('a negative width falls back to the ceiling', negative.width === MONITOR_MAX_WIDTH, String(negative.width))
}

{
  // The minimum width is a floor, not a ceiling on the prose budget. With 640px
  // of column and a 560px prose floor there are only 80px left, which is under
  // the 220px minimum — and the column is still drawn at 220. Dropping it here
  // was the defect this guards: it happened while someone dragged the handle,
  // and the panel that vanished could not be brought back because the width it
  // persisted was the one the budget had refused.
  const tight = placeMonitor({ columnRect: column({ right: 640 }), width: 300 })
  check('a column with no room left of the prose floor is still drawn', tight.visible === true, JSON.stringify(tight))
  check('at the minimum width rather than dropped', tight.width === MONITOR_MIN_WIDTH, String(tight.width))
  check('and it holds the right edge', tight.left + tight.width === 640, JSON.stringify(tight))
  check('accepting that the prose goes under its floor', tight.width + MONITOR_MIN_PROSE > 640, String(tight.width + MONITOR_MIN_PROSE))
}

{
  // 800px of column, 560px of prose and the rail's 40px a side: the widest
  // column that keeps all three is 160, which is under the minimum, so the floor
  // is what lands. The prose floor is not the binding budget here — the rail is —
  // and that is why they are two budgets rather than one subtraction.
  const squeezed = placeMonitor({ columnRect: column({ right: 800 }), width: 300 })
  check('a tight column shrinks the monitor instead of dropping it', squeezed.visible === true, JSON.stringify(squeezed))
  check('the rail is the budget that binds first', 800 - MONITOR_MIN_PROSE - TURN_RAIL_WIDTH * 2 === 160, 'arithmetic')
  check('so the floor is what lands', squeezed.width === MONITOR_MIN_WIDTH, String(squeezed.width))
  check('and it is still flush with the right edge', squeezed.left + squeezed.width === 800, JSON.stringify(squeezed))
}

{
  // Exactly at the floor is still a column: the boundary must be inclusive, or
  // the one window size everybody tests by hand is the one that fails.
  const exact = placeMonitor({ columnRect: column({ right: MONITOR_MIN_PROSE + MONITOR_MIN_WIDTH }), width: 300 })
  check('a column exactly at the floor still draws', exact.visible === true, JSON.stringify(exact))
  check('at the minimum width', exact.width === MONITOR_MIN_WIDTH, String(exact.width))

  // One pixel under the floor and the column no longer shrinks with the window:
  // the floor takes over, and the prose is the thing that gives way.
  const below = placeMonitor({ columnRect: column({ right: MONITOR_MIN_PROSE + MONITOR_MIN_WIDTH - 1 }), width: 300 })
  check('one pixel below the floor still draws', below.visible === true, JSON.stringify(below))
  check('at the minimum width', below.width === MONITOR_MIN_WIDTH, String(below.width))
}

{
  // Measurement failures are not zero boxes. A missing rect means "not measured
  // yet", which must read as "no column", not as "column of width 0".
  const nothing = placeMonitor({})
  check('an unmeasured column draws nothing', nothing.visible === false, JSON.stringify(nothing))
  check('and blames the conversation', nothing.reason === 'no-conversation', String(nothing.reason))

  const partial = placeMonitor({ columnRect: { left: 0, top: 0, right: 1160 } })
  check('a rect missing an edge draws nothing', partial.visible === false, JSON.stringify(partial))

  const nanRect = placeMonitor({ columnRect: { left: 0, top: 0, right: Number.NaN, bottom: 800 } })
  check('a rect with a NaN edge draws nothing', nanRect.visible === false, JSON.stringify(nanRect))

  const empty = placeMonitor({ columnRect: { left: 0, top: 0, right: 0, bottom: 0 } })
  check('a zero-area column draws nothing', empty.visible === false, JSON.stringify(empty))
}

{
  // The rect is in overlay coordinates, which can be offset from the window —
  // the host sidebar shifts it right. An implementation that assumed a 0 origin
  // would put the column at the wrong x on every real screen.
  const placed = placeMonitor({ columnRect: { left: 264, top: 120, right: 1424, bottom: 920 }, width: 300 })
  check('an offset column keeps its offset', placed.left === 1124, String(placed.left))
  check('and its own top', placed.top === 120, String(placed.top))
  check('and its own height', placed.height === 800, String(placed.height))
}

{
  // Fractional rects arrive from `getBoundingClientRect` on scaled displays.
  // The column's right edge must land on the column's right edge exactly, or a
  // 1px gap opens between the panel and the side of the window.
  const placed = placeMonitor({ columnRect: { left: 0.5, top: 0.5, right: 1160.5, bottom: 800.5 }, width: 300 })
  check('fractional edges still yield whole pixels', Number.isInteger(placed.width) && Number.isInteger(placed.left), JSON.stringify(placed))
  check('and the column still reaches the edge', placed.left + placed.width === 1160, `${placed.left}+${placed.width}`)
}

{
  // The turn rail is paid for out of the column's budget, not measured afterwards.
  //
  // The host answers "does the rail fit" with a container query on the scroll
  // area, 900px wide, which is why the rail vanished when our column narrowed
  // the area and came back when the column was dragged thin. The rail needs 40px
  // of gutter and the gutter is half of what the prose does not use, so that
  // query is answering a different question than the one that matters.
  //
  // The answer here is a budget: `placeMonitor` takes the rail's 80px off the
  // area before it decides how wide the column may be, so a drawn column is one
  // that already left the rail its room. Nothing measures the result; asking
  // twice is what kept the rail hidden for three rounds.
  check('the rail needs 40px of gutter', TURN_RAIL_WIDTH === 40, String(TURN_RAIL_WIDTH))

  // 1000 of area, 560 of prose: 440 is available for the column, but the rail
  // takes 80 of it first, so the column stops at 360 rather than 440.
  const bounded = placeMonitor({ columnRect: { left: 0, top: 0, right: 1000, bottom: 800 }, width: 460, proseWidth: 560 })
  check('the rail is taken out of the column budget', bounded.width === 360, `${bounded.width} of 1000`)
  check('and the column still reaches the edge', bounded.left + bounded.width === 1000, `${bounded.left}+${bounded.width}`)
  check('and the reservation is the width it drew', bounded.reserve === bounded.width, `${bounded.reserve} vs ${bounded.width}`)

  // The scrollbar is part of the same subtraction: it eats the area's inner
  // width, so a column that ignores it hangs 15px over the gutter.
  const scrolled = placeMonitor({ columnRect: { left: 0, top: 0, right: 1000, bottom: 800 }, width: 460, proseWidth: 560, scrollbarWidth: 15 })
  check('the scrollbar comes off the same budget', scrolled.width === 345, `${scrolled.width} of 1000 with a 15px bar`)

  // The floor wins over the rail. A column at its minimum that crowds the rail
  // is the cheaper wrong: the prose re-wraps and the rail may sit on the gutter's
  // last pixels, where dropping the column left the panel invisible.
  const floored = placeMonitor({ columnRect: { left: 0, top: 0, right: 800, bottom: 800 }, width: 460, proseWidth: 560 })
  check('the floor wins over the rail budget', floored.width === MONITOR_MIN_WIDTH, `${floored.width} of 800`)

  // A person who asks for less than the rail costs still gets their number: the
  // budget only ever pulls the width down, never up.
  const modest = placeMonitor({ columnRect: { left: 0, top: 0, right: 1600, bottom: 800 }, width: 240, proseWidth: 560 })
  check('a narrow ask is honoured when the rail costs more', modest.width === 240, String(modest.width))
}

console.log(`
${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
