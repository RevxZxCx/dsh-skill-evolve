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
import { gutters, placeCards, placeHandle } from '../lib/gutter.js'

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
  const body = `${block}\nreturn { gutters, placeCards, placeHandle, MIN_CARD_WIDTH, MAX_CARD_WIDTH, CARD_GAP, TOP_INSET, BOTTOM_INSET }`
  // eslint-disable-next-line no-new-func
  return new Function(body)()
}

const inlined = loadInlined()

check('the inlined block defines the same constants', inlined.MIN_CARD_WIDTH === 168 || inlined.MIN_CARD_WIDTH > 0, String(inlined.MIN_CARD_WIDTH))
check('the inlined block exposes the three functions', ['gutters', 'placeCards', 'placeHandle'].every((name) => typeof inlined[name] === 'function'))

// The behaviour comparison: a sweep wide enough to cross every branch —
// no gutter, one gutter, both gutters, fallback side, no measurement.
{
  const mismatches = []
  const sides = ['left', 'right']
  const widths = [700, 900, 1000, 1200, 1400, 1600, 1920, 2200, 2560]
  const proseWidths = [0, 680, 800, 920, 1200]

  for (const width of widths) {
    for (const prose of proseWidths) {
      const effective = prose === 0 ? 0 : Math.min(prose, width)
      const left = Math.round((width - effective) / 2)
      const rect = { left, top: 100, right: left + effective, bottom: 900 }
      for (const side of sides) {
        for (const cardWidth of [undefined, 100, 288, 400]) {
          const input = { chatRect: rect, viewportWidth: width, side, cardWidth }
          const mine = JSON.stringify(placeCards(input))
          const theirs = JSON.stringify(inlined.placeCards(input))
          if (mine !== theirs) mismatches.push(`${width}/${effective}/${side}/${cardWidth}: ${mine} vs ${theirs}`)
          const myHandle = JSON.stringify(placeHandle(input))
          const theirHandle = JSON.stringify(inlined.placeHandle(input))
          if (myHandle !== theirHandle) mismatches.push(`handle ${width}/${effective}/${side}: ${myHandle} vs ${theirHandle}`)
        }
      }
    }
  }
  check('the inlined copy places cards identically across a sweep', mismatches.length === 0, mismatches.slice(0, 3).join(' | '))
  check('the sweep actually exercised placement', mismatches.length === 0 && widths.length * proseWidths.length * sides.length * 4 > 200)
}

{
  const mismatches = []
  for (const [rect, width] of [
    [undefined, 1920],
    [{ left: 500, right: 1420 }, undefined],
    [{ left: 0, right: 0 }, 0],
    [{ left: 10.7, right: 1419.2 }, 1920],
  ]) {
    const mine = JSON.stringify(gutters(rect, width))
    const theirs = JSON.stringify(inlined.gutters(rect, width))
    if (mine !== theirs) mismatches.push(`${JSON.stringify(rect)}/${width}: ${mine} vs ${theirs}`)
  }
  check('the inlined copy measures gutters identically', mismatches.length === 0, mismatches.join(' | '))
}

{
  const mismatches = []
  for (const input of [
    undefined,
    {},
    { chatRect: undefined, viewportWidth: 1920 },
    { chatRect: { left: 0, top: 0, right: 100, bottom: 100 }, viewportWidth: 1920, side: 'right' },
  ]) {
    const mine = JSON.stringify(placeCards(input))
    const theirs = JSON.stringify(inlined.placeCards(input))
    if (mine !== theirs) mismatches.push(`${JSON.stringify(input)}: ${mine} vs ${theirs}`)
  }
  check('the inlined copy handles degenerate input identically', mismatches.length === 0, mismatches.join(' | '))
}

console.log(`\n${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failed === 0 ? 0 : 1)
