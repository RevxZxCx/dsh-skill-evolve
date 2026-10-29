/**
 * The bundle carries a generated copy of the geometry, and this is the guard.
 *
 * `lib/client.js` is a browser script: no imports, no module graph, so it cannot
 * reach `lib/gutter.js`. Copying the arithmetic by hand would rot the first time
 * a constant moved, and the failure would be a panel drawn in the wrong place —
 * a symptom with no obvious cause. So the module is the source of truth, the
 * bundle holds a generated block between `// <gutter>` markers, and this test
 * asserts the two agree across a sweep of window sizes rather than by comparing
 * text (comments and formatting are allowed to differ).
 *
 * If this fails, run `node scripts/sync-gutter.mjs`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  gutters,
  placeCards,
  placeHandle,
  placeNear,
  HANDLE_WIDTH,
  EDGE_MARGIN,
  PANEL_WIDTH,
  DETAIL_WIDTH,
  POPOVER_GAP,
  MIN_CARD_WIDTH,
  MAX_CARD_WIDTH,
  CARD_GAP,
} from '../lib/gutter.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..')

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

/**
 * Pull the generated block out of the bundle and evaluate it in isolation.
 *
 * Evaluated rather than diffed so that a comment or an indent change is not a
 * failure: what matters is that the functions behave identically.
 *
 * @returns {object} the functions the block defines.
 */
function loadInlined() {
  const source = readFileSync(join(repo, 'lib', 'client.js'), 'utf8')
  const start = source.indexOf('// <gutter>')
  const end = source.indexOf('// </gutter>')
  if (start < 0 || end < 0) throw new Error('lib/client.js has no gutter markers — run scripts/sync-gutter.mjs')
  const block = source.slice(start, end)
  const body = `${block}\nreturn { gutters, placeCards, placeHandle, placeNear, MIN_CARD_WIDTH, MAX_CARD_WIDTH, CARD_GAP, TOP_INSET, BOTTOM_INSET, HANDLE_WIDTH, EDGE_MARGIN, PANEL_WIDTH, DETAIL_WIDTH, POPOVER_GAP }`
  // eslint-disable-next-line no-new-func
  return new Function(body)()
}

const inlined = loadInlined()

check('the inlined minimum card width matches the module', inlined.MIN_CARD_WIDTH === MIN_CARD_WIDTH, String(inlined.MIN_CARD_WIDTH))
check('the inlined maximum card width matches the module', inlined.MAX_CARD_WIDTH === MAX_CARD_WIDTH, String(inlined.MAX_CARD_WIDTH))
check('the inlined card gap matches the module', inlined.CARD_GAP === CARD_GAP, String(inlined.CARD_GAP))
check('the inlined handle width matches the module', inlined.HANDLE_WIDTH === HANDLE_WIDTH, String(inlined.HANDLE_WIDTH))
check('the inlined block exposes every geometry function', ['gutters', 'placeCards', 'placeHandle', 'placeNear'].every((name) => typeof inlined[name] === 'function'))
check('the inlined edge margin matches the module', inlined.EDGE_MARGIN === EDGE_MARGIN, String(inlined.EDGE_MARGIN))
check('the inlined panel width matches the module', inlined.PANEL_WIDTH === PANEL_WIDTH, String(inlined.PANEL_WIDTH))
check('the inlined detail width matches the module', inlined.DETAIL_WIDTH === DETAIL_WIDTH, String(inlined.DETAIL_WIDTH))
check('the inlined popover gap matches the module', inlined.POPOVER_GAP === POPOVER_GAP, String(inlined.POPOVER_GAP))

// Rect shapes that are incomplete in one edge at a time. The sweep below only
// builds complete rects, so without these the `edges` argument to `usableRect` is
// never asked for anything but ALL_EDGES — an inline copy weakened to a left/right
// check then compares equal on every input and the drift test still passes.
{
  const complete = { left: 300, top: 100, right: 900, bottom: 900 }
  const column = { left: 0, top: 90, right: 1920, bottom: 900 }
  const edges = ['left', 'right', 'top', 'bottom']
  let disagreements = 0
  const detail = []
  for (const edge of edges) {
    const partial = { ...complete, [edge]: undefined }
    for (const side of ['left', 'right']) {
      for (const cardWidth of [undefined, 288]) {
        const input = { chatRect: partial, columnRect: column, side, cardWidth }
        const mine = JSON.stringify(placeCards(input))
        const theirs = JSON.stringify(inlined.placeCards(input))
        if (mine !== theirs) {
          disagreements += 1
          detail.push(`card/${edge}/${side}: ${mine} vs ${theirs}`)
        }
        const myHandle = JSON.stringify(placeHandle(input))
        const theirHandle = JSON.stringify(inlined.placeHandle(input))
        if (myHandle !== theirHandle) {
          disagreements += 1
          detail.push(`handle/${edge}/${side}: ${myHandle} vs ${theirHandle}`)
        }
      }
    }
    // The same partial shape as the *column*. `gutters` needs only the horizontal
    // pair, so a broken `top` must be tolerated there while `placeCards` still
    // refuses it; both copies have to agree about which is which.
    const partialColumn = { ...column, [edge]: undefined }
    const mineG = JSON.stringify(gutters(complete, partialColumn))
    const theirsG = JSON.stringify(inlined.gutters(complete, partialColumn))
    if (mineG !== theirsG) {
      disagreements += 1
      detail.push(`gutters/${edge}: ${mineG} vs ${theirsG}`)
    }
  }
  const notAWidth = placeCards({
    chatRect: complete,
    columnRect: column,
    side: 'right',
    cardWidth: Number.NaN,
  })
  check('a cardWidth that is not a number is refused, not propagated', notAWidth.visible === false, JSON.stringify(notAWidth))
  const negative = placeCards({ chatRect: complete, columnRect: column, side: 'right', cardWidth: -50 })
  check('a negative cardWidth is refused rather than becoming a negative width', negative.visible === false, JSON.stringify(negative))
  check('partial rects behave identically in both copies', disagreements === 0, detail.slice(0, 4).join(' | '))
  // Prove the block reached the refusal branch rather than comparing two zeros.
  const refused = placeCards({ chatRect: { left: 300, top: undefined, right: 900, bottom: 900 }, columnRect: column })
  check('a rect missing its top edge is refused by the module too', refused.visible === false, JSON.stringify(refused))
}
// The behaviour comparison: a sweep wide enough to cross every branch —
// no gutter, one gutter, both gutters, fallback side, no measurement.
{
  const mismatches = []
  let placements = 0
  let checked = 0
  const sides = ['left', 'right']
  const widths = [700, 900, 1000, 1200, 1400, 1600, 1920, 2200, 2560]
  const proseWidths = [0, 680, 800, 920, 1200]

  // `columnRect` must be supplied. Without it every input resolves to "no room"
  // and the comparison passes while never executing the placement arithmetic at
  // all — which is what this test did after the geometry moved to column
  // coordinates, and why a mutated inline copy still passed.
  const sidebars = [0, 250, 400]
  for (const width of widths) {
    for (const sidebar of sidebars) {
      const columnWidth = width - sidebar
      if (columnWidth <= 0) continue
    for (const prose of proseWidths) {
      const effective = prose === 0 ? 0 : Math.min(prose, columnWidth)
      const inset = Math.round((columnWidth - effective) / 2)
      const rect = {
        left: sidebar + inset,
        top: 100,
        right: sidebar + inset + effective,
        bottom: 900,
      }
      const columnRect = { left: sidebar, top: 90, right: width, bottom: 900 }
      for (const side of sides) {
        // `NaN` and a negative number are here because `cardWidth` is caller input:
        // without them the width guard in the generated copy could be deleted and
        // the comparison would never produce a difference to report.
        for (const cardWidth of [undefined, 100, 288, 400, Number.NaN, -50, 0]) {
          const input = { chatRect: rect, columnRect, side, cardWidth }
          checked += 1
          if (placeCards(input).visible) placements += 1
          const mine = JSON.stringify(placeCards(input))
          const theirs = JSON.stringify(inlined.placeCards(input))
          if (mine !== theirs) mismatches.push(`${width}/${sidebar}/${effective}/${side}/${cardWidth}: ${mine} vs ${theirs}`)
          const myHandle = JSON.stringify(placeHandle(input))
          const theirHandle = JSON.stringify(inlined.placeHandle(input))
          if (myHandle !== theirHandle) mismatches.push(`handle ${width}/${sidebar}/${effective}/${side}: ${myHandle} vs ${theirHandle}`)
        }
      }
    }
    }
  }
  check('the inlined copy places cards identically across a sweep', mismatches.length === 0, mismatches.slice(0, 3).join(' | '))
  // Count the placements the sweep itself produced. The earlier version of this
  // assertion used hard-coded rects unrelated to the loop, so collapsing every
  // loop input to "no room" left it green — the guard failed in exactly the way
  // it was written to prevent.
  check('the sweep reached the placement branch', placements > 0, `only ${placements} of ${checked} inputs placed`)
}

{
  const mismatches = []
  for (const [rect, column] of [
    [undefined, undefined],
    [{ left: 500, right: 1420 }, undefined],
    [{ left: 0, right: 0 }, { left: 0, right: 0 }],
    [{ left: 10.7, right: 1419.2 }, { left: 0, right: 1920 }],
    [{ left: 640, right: 1560 }, { left: 280, right: 1920 }],
  ]) {
    const mine = JSON.stringify(gutters(rect, column))
    const theirs = JSON.stringify(inlined.gutters(rect, column))
    if (mine !== theirs) mismatches.push(`${JSON.stringify(rect)}/${JSON.stringify(column)}: ${mine} vs ${theirs}`)
  }
  check('the inlined copy measures gutters identically', mismatches.length === 0, mismatches.join(' | '))
}

{
  const mismatches = []
  for (const input of [
    undefined,
    {},
    // `viewportWidth` used to be passed here. Neither function reads it any more,
    // so it only made the block look like it covered more than it did.
    { chatRect: undefined },
    { chatRect: { left: 0, top: 0, right: 100, bottom: 100 }, side: 'right' },
    // A column known only by its left edge: `gutters` can proceed (it needs the
    // horizontal pair and falls back to the prose for a missing right).
    { chatRect: { left: 300, top: 100, right: 900, bottom: 900 }, columnRect: { left: 0 }, side: 'left' },
    { chatRect: { left: 300, top: 100, right: 900, bottom: 900 }, columnRect: undefined, side: 'left' },
  ]) {
    const mine = JSON.stringify(placeCards(input))
    const theirs = JSON.stringify(inlined.placeCards(input))
    if (mine !== theirs) mismatches.push(`${JSON.stringify(input)}: ${mine} vs ${theirs}`)
  }
  check('the inlined copy handles degenerate input identically', mismatches.length === 0, mismatches.join(' | '))
}

// `placeNear` is what positions both panel layers, and it was missing from this
// file entirely — the same gap the bubble had before a review found it. Copying
// the arithmetic into the bundle and forgetting to re-run the sync left every
// other check green.
{
  let mismatches = []
  let checked = 0
  let swapped = 0
  let visible = 0
  for (const viewportWidth of [400, 760, 1200, 1600, 2560]) {
    for (const viewportHeight of [120, 400, 1000]) {
      for (const top of [-300, 0, 300, viewportHeight - 120, viewportHeight + 200]) {
        for (const left of [2, 380, viewportWidth - 60]) {
          for (const side of ['left', 'right', 'auto']) {
            for (const width of [320, 380]) {
              {
                const input = {
                  anchor: { left, right: left + 40, top, bottom: top + 26 },
                  width,
                  height: 240,
                  side,
                  viewportWidth,
                  viewportHeight,
                }
                checked += 1
                const mine = placeNear(input)
                const theirs = inlined.placeNear(input)
                if (mine.visible) visible += 1
                if (side !== 'auto' && mine.visible && mine.side !== side) swapped += 1
                const a = JSON.stringify(mine)
                const b = JSON.stringify(theirs)
                if (a !== b) mismatches.push(`${JSON.stringify(input)}: ${a} vs ${b}`)
              }
            }
          }
        }
      }
    }
  }
  for (const input of [
    {},
    { anchor: undefined, width: 320, height: 240, viewportWidth: 1600, viewportHeight: 1000 },
    { anchor: { left: 100, top: 300 }, width: 320, height: 240, viewportWidth: 1600, viewportHeight: 1000 },
    { anchor: { left: Number.NaN, top: 300, right: 140 }, width: 320, height: 240, viewportWidth: 1600, viewportHeight: 1000 },
    { anchor: { left: 100, top: 300, right: 140, bottom: 326 }, width: 320, height: 240, viewportWidth: undefined, viewportHeight: undefined },
    { anchor: { left: 100, top: 300, right: 140, bottom: 326 }, width: 320, height: 240, side: 'left', viewportWidth: 400, viewportHeight: 120 },
  ]) {
    checked += 1
    const a = JSON.stringify(placeNear(input))
    const b = JSON.stringify(inlined.placeNear(input))
    if (a !== b) mismatches.push(`degenerate ${JSON.stringify(input)}: ${a} vs ${b}`)
  }
  check('the inlined copy places a popover identically across a sweep', mismatches.length === 0, mismatches.slice(0, 3).join(' | '))
  check('the popover sweep produced visible placements', visible > 0, `only ${visible} of ${checked} were visible`)
  // A copy whose side selection collapsed to the tiebreak alone would match any
  // module collapsed the same way, so prove the requested side is sometimes
  // refused as well as sometimes honoured.
  check('the popover sweep reached the side fallback', swapped > 0, `only ${swapped} of ${visible} ignored the request`)
}

console.log(`\n${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failed === 0 ? 0 : 1)
