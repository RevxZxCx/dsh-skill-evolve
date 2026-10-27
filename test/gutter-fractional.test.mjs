// Assert the sub-pixel invariant the reviewer found: with fractional layout
// coordinates, neither a card nor a handle may leave the column.
//
// The sweep in gutter.test.mjs uses whole pixels, so it could not see this. These
// cases are the ones that were wrong before snapRect: column.left just under a
// whole number, prose.left just over one, and a gutter that measures exactly the
// handle width.
import { placeCards, placeHandle, HANDLE_WIDTH } from '../lib/gutter.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(`${label} — ${detail}`)
}

// Every combination of a fractional column origin and a fractional prose origin,
// which is what a real measurement produces.
const offsets = [0, 0.1, 0.4, 0.5, 0.9, 0.99]
let cardViolations = []
let handleViolations = []
let cardsSeen = 0
let handlesSeen = 0

for (const columnOffset of offsets) {
  for (const proseOffset of offsets) {
    for (const gutter of [16, 17, 20, 40, 184, 200, 320]) {
      for (const side of ['left', 'right']) {
        // Left side: column starts at columnOffset, prose starts at
        // columnOffset + gutter, so the left gutter measures exactly `gutter`.
        // Right side: the same shape mirrored.
        const columnLeft = columnOffset
        const proseLeft = columnOffset + gutter + proseOffset
        const chatRect = { left: proseLeft, top: 100.3, right: proseLeft + 680, bottom: 900.7 }
        const columnRect = { left: columnLeft, top: 90.2, right: chatRect.right + gutter, bottom: 900.7 }

        const card = placeCards({ chatRect, columnRect, side })
        if (card.visible) {
          cardsSeen += 1
          // No tolerance. The earlier `- 1` gave a 1px licence to a bug that was
          // 0.9px wide, so the test passed on the implementation it was written to
          // catch. Containment is exact now that the rounding is directed.
          if (card.left < columnRect.left) {
            cardViolations.push(`${columnOffset}/${proseOffset}/${gutter}/${side}: card left ${card.left} < column ${columnRect.left}`)
          }
          if (card.left + card.width > columnRect.right) {
            cardViolations.push(`${columnOffset}/${proseOffset}/${gutter}/${side}: card right ${card.left + card.width} > column ${columnRect.right}`)
          }
          if (card.left < chatRect.right && card.left + card.width > chatRect.left) {
            cardViolations.push(`${columnOffset}/${proseOffset}/${gutter}/${side}: card ${card.left}..${card.left + card.width} covers prose ${chatRect.left}..${chatRect.right}`)
          }
        }

        const handle = placeHandle({ chatRect, columnRect, side })
        if (handle.visible) {
          handlesSeen += 1
          if (handle.left < columnRect.left) {
            handleViolations.push(`${columnOffset}/${proseOffset}/${gutter}/${side}: handle left ${handle.left} < column ${columnRect.left}`)
          }
          if (handle.left + HANDLE_WIDTH > columnRect.right) {
            handleViolations.push(`${columnOffset}/${proseOffset}/${gutter}/${side}: handle right ${handle.left + HANDLE_WIDTH} > column ${columnRect.right}`)
          }
          if (handle.left < chatRect.right && handle.left + HANDLE_WIDTH > chatRect.left) {
            handleViolations.push(`${columnOffset}/${proseOffset}/${gutter}/${side}: handle ${handle.left}..${handle.left + HANDLE_WIDTH} covers prose ${chatRect.left}..${chatRect.right}`)
          }
        }
      }
    }
  }
}

check('fractional coordinates never push a card outside the column', cardViolations.length === 0, cardViolations.slice(0, 3).join(' | '))
check('fractional coordinates never push a handle outside the column', handleViolations.length === 0, handleViolations.slice(0, 3).join(' | '))
check('the fractional sweep actually drew cards', cardsSeen > 0, `drew ${cardsSeen}`)
check('the fractional sweep actually drew handles', handlesSeen > 0, `drew ${handlesSeen}`)

// The specific case the reviewer cited, pinned so the fix cannot silently revert.
{
  const chatRect = { left: 16.8, top: 100, right: 696.8, bottom: 900 }
  const columnRect = { left: 0.4, top: 90, right: 713.2, bottom: 900 }
  const handle = placeHandle({ chatRect, columnRect, side: 'left' })
  check('the cited case keeps the handle inside the column', handle.visible && handle.left >= 0, JSON.stringify(handle))
  const card = placeCards({ chatRect, columnRect, side: 'left' })
  check('the cited case keeps the card inside the column', card.visible === false || card.left >= 0, JSON.stringify(card))
}


// The dangerous direction of rounding is *overstating* the room: a gutter that
// measures exactly HANDLE_WIDTH while the real gap is smaller draws a handle
// that overlaps the column edge or the text. Directed rounding is supposed to
// make that impossible, and these cases are the ones where it would show.
{
  // Real left gutter is 15.1px, which is less than the 16px handle. Rounded
  // naively (floor prose, floor column) it measures 16 and the handle is drawn.
  const chatRect = { left: 16.0, top: 100, right: 700, bottom: 900 }
  const columnRect = { left: 0.9, top: 90, right: 716, bottom: 900 }
  const handle = placeHandle({ chatRect, columnRect, side: 'left' })
  const fits = handle.visible === false || handle.left >= columnRect.left
  check('a gutter smaller than the handle does not draw one outside the column', fits, JSON.stringify(handle))

  // The case the reviewer cited: real gutter is 16.4px, so a handle does fit —
  // but only if the column edge is rounded inward.
  const citedChat = { left: 16.8, top: 100, right: 696.8, bottom: 900 }
  const citedColumn = { left: 0.4, top: 90, right: 713.2, bottom: 900 }
  const cited = placeHandle({ chatRect: citedChat, columnRect: citedColumn, side: 'left' })
  check('the cited sub-pixel case keeps the handle inside the column', cited.left >= citedColumn.left, JSON.stringify(cited))

  // And the right edge: a card must not end past the column's right edge even
  // when both the column and the prose have fractional edges.
  const rightChat = { left: 20, top: 100, right: 689.0, bottom: 900 }
  const rightColumn = { left: 0, top: 90, right: 890.4, bottom: 900 }
  const card = placeCards({ chatRect: rightChat, columnRect: rightColumn, side: 'right' })
  check(
    'a right-hand card does not end past the column',
    card.visible === false || card.left + card.width <= rightColumn.right,
    JSON.stringify(card),
  )
}
console.log(`
${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failed === 0 ? 0 : 1)
