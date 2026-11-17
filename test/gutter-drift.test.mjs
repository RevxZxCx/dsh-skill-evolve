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
 * What is left to guard is the two placements that survived the card rail's
 * removal: `placeNear`, which positions the popover layers, and the monitor
 * column with its turn-rail budget. The card sweeps went with the cards.
 *
 * If this fails, run `node scripts/sync-gutter.mjs`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  placeNear,
  placeMonitor,
  EDGE_MARGIN,
  PANEL_WIDTH,
  DETAIL_WIDTH,
  POPOVER_GAP,
  MONITOR_MIN_WIDTH,
  MONITOR_MAX_WIDTH,
  MONITOR_MIN_PROSE,
  TURN_RAIL_WIDTH,
} from '../packages/ui-evolve/lib/gutter.js'

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
  const source = readFileSync(join(repo, 'packages', 'ui-evolve', 'lib', 'client.js'), 'utf8')
  const start = source.indexOf('// <gutter>')
  const end = source.indexOf('// </gutter>')
  if (start < 0 || end < 0) throw new Error('lib/client.js has no gutter markers — run scripts/sync-gutter.mjs')
  const block = source.slice(start, end)
  const exported = '{ placeNear, placeMonitor, EDGE_MARGIN, PANEL_WIDTH, DETAIL_WIDTH, POPOVER_GAP, MONITOR_MIN_WIDTH, MONITOR_MAX_WIDTH, MONITOR_MIN_PROSE, TURN_RAIL_WIDTH }'
  // eslint-disable-next-line no-new-func
  return new Function(`${block}\nreturn ${exported}`)()
}

const inlined = loadInlined()

check('the inlined minimum monitor width matches the module', inlined.MONITOR_MIN_WIDTH === MONITOR_MIN_WIDTH, String(inlined.MONITOR_MIN_WIDTH))
check('the inlined maximum monitor width matches the module', inlined.MONITOR_MAX_WIDTH === MONITOR_MAX_WIDTH, String(inlined.MONITOR_MAX_WIDTH))
check('the inlined prose floor matches the module', inlined.MONITOR_MIN_PROSE === MONITOR_MIN_PROSE, String(inlined.MONITOR_MIN_PROSE))
check('the inlined turn rail width matches the module', inlined.TURN_RAIL_WIDTH === TURN_RAIL_WIDTH, String(inlined.TURN_RAIL_WIDTH))
check('the inlined block exposes every geometry function', ['placeNear', 'placeMonitor'].every((name) => typeof inlined[name] === 'function'))
check('the inlined edge margin matches the module', inlined.EDGE_MARGIN === EDGE_MARGIN, String(inlined.EDGE_MARGIN))
check('the inlined panel width matches the module', inlined.PANEL_WIDTH === PANEL_WIDTH, String(inlined.PANEL_WIDTH))
check('the inlined detail width matches the module', inlined.DETAIL_WIDTH === DETAIL_WIDTH, String(inlined.DETAIL_WIDTH))
check('the inlined popover gap matches the module', inlined.POPOVER_GAP === POPOVER_GAP, String(inlined.POPOVER_GAP))

// The monitor column is a subtraction over three budgets and a floor that
// overrides them. The sweep crosses every branch: room for the requested width,
// the prose budget binding, the rail budget binding, and the floor landing.
{
  const mismatches = []
  let floorWon = 0
  let requestWon = 0
  let checked = 0
  for (const full of [0, 100, 219, 220, 400, 640, 800, 900, 1160, 1640, 2560]) {
    for (const width of [undefined, 0, 220, 300, 460, 900, Number.NaN, -40]) {
      for (const proseWidth of [undefined, 0, 560, 742, 920, 1200]) {
        for (const scrollbarWidth of [undefined, 0, 15]) {
          const input = { columnRect: { left: 0, top: 0, right: full, bottom: 800 }, width, proseWidth, scrollbarWidth }
          checked += 1
          const mine = JSON.stringify(placeMonitor(input))
          const theirs = JSON.stringify(inlined.placeMonitor(input))
          if (mine !== theirs) mismatches.push(`${full}/${width}/${proseWidth}/${scrollbarWidth}: ${mine} vs ${theirs}`)
          const placed = placeMonitor(input)
          if (placed.visible && placed.width === MONITOR_MIN_WIDTH) floorWon += 1
          if (placed.visible && width === 300 && placed.width === 300) requestWon += 1
        }
      }
    }
  }
  check('the inlined copy places the monitor column identically across a sweep', mismatches.length === 0, mismatches.slice(0, 3).join(' | '))
  check('the monitor sweep reached the floor', floorWon > 0, `${floorWon} of ${checked}`)
  // Without this the sweep could pass while the column simply always lands on
  // the floor — which is exactly the behaviour a copy that dropped the budgets
  // would produce.
  check('the monitor sweep also honoured a plain request', requestWon > 0, `${requestWon} of ${checked}`)
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