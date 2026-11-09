/**
 * The mutation harnesses are only worth having if their anchors still apply.
 *
 * Twice while writing them, an anchor was written against the patch I *meant* to
 * land rather than the one that did: `var MIN_CARD_WIDTH` against a generator that
 * emits `const`, and a guard body that had already been restructured. Both times
 * the script printed `ANCHOR MISSING` and moved on, and both times the practical
 * effect was a mutation run that proved nothing while looking like it had run.
 *
 * This suite makes that failure loud and cheap. It does not run the mutations —
 * each one re-runs the whole test suite, so they stay a manual exercise — it only
 * asserts that every anchor still names code that exists, exactly once, in the file
 * the script claims to mutate.
 */

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The sync script's own builder, not a reimplementation: comparing the generated
// block against a second copy of the transformation would only prove that the two
// copies agree, which is how the first version of this check passed with a 412-
// character difference.
import { buildBlock, CLOSE, OPEN } from '../scripts/sync-gutter.mjs'

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
  failures.push(`${label} — ${detail}`)
}

/**
 * Pull `{ from, to, label }` objects out of a mutation script.
 *
 * The scripts are read as text rather than imported because importing them would
 * run the mutations. The parser is deliberately dumb — it looks for `from: '<...>'`
 * and `to: '<...>'` string literals — and the script below is written to stay
 * inside what it can see. A `from:` that spans lines would be missed, so the
 * check on `anchors.length` is what keeps this honest.
 *
 * @param {string} source - the script's text.
 * @returns {Array<{ from: string, to: string }>} the anchors found.
 */
function parseAnchors(source) {
  const anchors = []
  // Three quote styles. Anchors that contain `'` (a record with `reason:
  // 'no-conversation'`) are written with double quotes, so a single-quote-only
  // pattern silently found 3 of the 4 guard anchors. Backticks came later, for
  // anchors that span lines — `scripts/mutate-persistence.mjs` has one, and
  // while this pattern could not see it the script's 44 mutations looked like 43.
  //
  // Template interpolations are not supported: every existing backtick anchor is
  // a literal, and an anchor built by interpolation could not be checked against
  // its file without evaluating it. A `${` inside one is treated as text, which
  // makes the anchor fail to match and say so rather than match quietly.
  const pattern = /from:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g
  // Decoded in a single left-to-right pass. Chained replaces cannot do this
  // correctly in any order: turning `\\` into `\` first manufactures fresh `\n`
  // sequences that the next rule then eats, and running `\n` first eats half of a
  // literal `\\n`. Both orders are wrong, which is why this is a scanner rather
  // than three `.replace` calls. The parser's own edge cases are asserted below.
  const escapes = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '`': '`', '\\': '\\' }
  const unescape = (text) => {
    let out = ''
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]
      if (character !== '\\' || index + 1 >= text.length) {
        out += character
        continue
      }
      const next = text[index + 1]
      // An escape we do not model is left as written rather than dropped: the
      // anchor then fails to match and says so, instead of matching something
      // subtly different.
      out += Object.hasOwn(escapes, next) ? escapes[next] : character + next
      index += 1
    }
    return out
  }
  let match = pattern.exec(source)
  while (match !== null) {
    anchors.push({ from: unescape(match[1] ?? match[2] ?? match[3] ?? '') })
    match = pattern.exec(source)
  }
  return anchors
}

// ---- the anchor parser itself ------------------------------------------------
//
// Every check below depends on parseAnchors recovering the exact source text, so
// its edge cases are asserted rather than assumed. The backslash cases matter: an
// earlier version decoded `\n` before `\\`, so a literal backslash followed by an
// n was silently turned into a real newline and the anchor stopped matching.
for (const [label, source, want] of [
  ["single quotes", "from: 'a'", ["a"]],
  ["double quotes carrying an inner single quote", "from: \"reason: 'none'\"", ["reason: 'none'"]],
  ["an escaped newline becomes a real newline", "from: 'a\\nb'", ["a\nb"]],
  ["a literal backslash survives", "from: 'a\\\\nb'", ["a\\nb"]],
  ["an escaped quote is decoded", "from: 'it\\'s'", ["it's"]],
  ["backticks carry a real newline", "from: `a\nb`", ["a\nb"]],
  ["a multi-line backtick anchor keeps its indentation", "from: `  one\n  two\n`", ["  one\n  two\n"]],
  ["an escaped backtick is decoded", "from: `a\\`b`", ["a`b"]],
  // Not a claim that interpolation works — a claim that it is left visible. An
  // anchor built by interpolation cannot be checked against its file without
  // being evaluated, so it is meant to fail to match and say where.
  ["an interpolation is left as written", "from: `a${b}c`", ["a${b}c"]],
]) {
  const got = parseAnchors(source)
  check(
    `parseAnchors handles ${label}`,
    JSON.stringify(got) === JSON.stringify(want.map((text) => ({ from: text }))),
    `${JSON.stringify(got)} vs ${JSON.stringify(want)}`,
)
}
// ---- lib/gutter.js mutations -------------------------------------------------
{
  const script = readFileSync(join(repo, 'scripts/mutate-guards.mjs'), 'utf8')
  const target = readFileSync(join(repo, 'packages', 'ui-evolve', 'lib', 'gutter.js'), 'utf8')
  const anchors = parseAnchors(script)

  check('the guard mutation script declares anchors', anchors.length >= 4, `found ${anchors.length}`)

  let missing = 0
  let ambiguous = 0
  const detail = []
  for (const anchor of anchors) {
    const count = anchor.from === '' ? 0 : target.split(anchor.from).length - 1
    if (count === 0) {
      missing += 1
      detail.push(`missing: ${anchor.from.split('\n')[0].slice(0, 60)}`)
    } else if (count > 1) {
      ambiguous += 1
      detail.push(`ambiguous (${count}): ${anchor.from.split('\n')[0].slice(0, 60)}`)
    }
  }
  check('every guard mutation anchor still exists in lib/gutter.js', missing === 0, detail.join(' | '))
  check('no guard mutation anchor matches more than once', ambiguous === 0, detail.join(' | '))
}

// ---- lib/client.js mutations -------------------------------------------------
{
  const script = readFileSync(join(repo, 'scripts/mutate-bundle.mjs'), 'utf8')
  const target = readFileSync(join(repo, 'packages/ui-evolve/lib/client.js'), 'utf8')
  const anchors = parseAnchors(script)

  check('the bundle mutation script declares anchors', anchors.length >= 4, `found ${anchors.length}`)

  let missing = 0
  let ambiguous = 0
  const detail = []
  for (const anchor of anchors) {
    const count = anchor.from === '' ? 0 : target.split(anchor.from).length - 1
    if (count === 0) {
      missing += 1
      detail.push(`missing: ${anchor.from.split('\n')[0].slice(0, 60)}`)
    } else if (count > 1) {
      ambiguous += 1
      detail.push(`ambiguous (${count}): ${anchor.from.split('\n')[0].slice(0, 60)}`)
    }
  }
  check('every bundle mutation anchor still exists in lib/client.js', missing === 0, detail.join(' | '))
  check('no bundle mutation anchor matches more than once', ambiguous === 0, detail.join(' | '))

  // The bundle script's whole point is mutating the *generated* copy. Since that
  // copy is by definition identical to the module, every anchor necessarily
  // appears in both files — so the meaningful check is that each anchor lands
  // inside the `// <gutter>` region rather than elsewhere in the bundle, where it
  // would be mutating hand-written code the sync script cannot repair.
  const start = target.indexOf('// <gutter>')
  const end = target.indexOf('// </gutter>')
  check('the generated region is delimited', start >= 0 && end > start, `${start}..${end}`)
  const region = start >= 0 && end > start ? target.slice(start, end) : ''
  const outside = anchors
    .filter((anchor) => anchor.from !== '' && !region.includes(anchor.from))
    .map((anchor) => anchor.from.split('\n')[0].slice(0, 50))
  check('every bundle anchor lands inside the generated region', outside.length === 0, outside.join(' | '))
}

// ---- every mutation anchor still exists in the file it names ---------------
//
// Three scripts, one check. It started as a block for the language script only,
// and `scripts/mutate-speed.mjs` was written afterwards without one — its
// fifty anchors could rot the same way the panel script's did and the only
// notice would be a `NOT APPLIED` line in a run nobody started. A list is what
// keeps the next script from being the fourth one to notice this late.
//
// The expected counts are the anchors each script actually has today, not a
// round number comfortably below it: paired deletions of a `from:` and its
// `file:` line keep `owners.length === anchors.length` true and the per-anchor
// checks silent, so a floor that is too low is the one gap a list like this
// cannot see.
for (const [name, expected] of [
  ['mutate-language-and-files.mjs', 21],
  ['mutate-speed.mjs', 58],
  ['mutate-persistence.mjs', 44],
]) {
  const script = readFileSync(join(repo, 'scripts', name), 'utf8')
  const anchors = parseAnchors(script)

  // These mutations do not all point at one file: the language path spans four
  // modules, the speed path four, the persistence path five. Each mutation names
  // its target with a module-scope constant (`const summarise = path.join(...)`)
  // rather than a path string, so the constant has to be resolved before the
  // anchor can be looked for anywhere. Reading both out of the same text keeps
  // this honest in the direction that matters: an anchor checked against the
  // wrong file would report a false MISSING, and a renamed constant would report
  // nothing at all if it were skipped instead of counted.
  const targets = new Map()
  {
    const declaration = /^\s*const (\w+) = path\.join\(repo,\s*([^)]*)\)/gm
    let found = declaration.exec(script)
    while (found !== null) {
      const segments = found[2].split(',').map((part) => part.trim().replace(/^'|'$/g, ''))
      targets.set(found[1], join(repo, ...segments))
      found = declaration.exec(script)
    }
  }
  // `parseAnchors` returns the `from:` literals in source order and the `file:`
  // lines sit one per mutation, so the two lists line up. Their lengths agreeing
  // is the check that the pairing is real rather than an accident of this text.
  const owners = []
  {
    const owner = /^\s{4}file: (\w+),$/gm
    let found = owner.exec(script)
    while (found !== null) {
      owners.push(found[1])
      found = owner.exec(script)
    }
  }

  check(`${name} declares the anchors it is supposed to`, anchors.length >= expected, `found ${anchors.length}, expected at least ${expected}`)
  const unresolved = owners.filter((owner) => !targets.has(owner))
  check(
    `every ${name} mutation names a target that resolves to a file`,
    owners.length === anchors.length && unresolved.length === 0,
    `${owners.length} owners vs ${anchors.length} anchors; unresolved: ${unresolved.join(',')}`,
  )

  // Read each target once. The same file is the target of several mutations, and
  // re-reading it per anchor turns a forty-anchor check into forty file reads.
  const contents = new Map()
  const textOf = (file) => {
    if (!contents.has(file)) contents.set(file, readFileSync(file, 'utf8'))
    return contents.get(file)
  }

  let missing = 0
  let ambiguous = 0
  const detail = []
  // A count mismatch is itself a failure of this check, not a reason to skip it.
  // Guarding the loop on the lengths agreeing made both assertions below vacuous
  // in exactly the case they exist for — a mutation gained or lost without its
  // anchor being re-checked — and left the only evidence in the other check's
  // message.
  if (owners.length !== anchors.length) {
    missing += 1
    detail.push(`${owners.length} owners vs ${anchors.length} anchors: the pairing cannot be checked`)
  }
  for (const [position, anchor] of anchors.entries()) {
    const file = targets.get(owners[position])
    if (file === undefined || anchor.from === '') continue
    const count = textOf(file).split(anchor.from).length - 1
    const where = basename(file)
    if (count === 0) {
      missing += 1
      detail.push(`missing in ${where}: ${anchor.from.split('\\n')[0].slice(0, 50)}`)
    } else if (count > 1) {
      ambiguous += 1
      detail.push(`ambiguous in ${where} (${count}): ${anchor.from.split('\\n')[0].slice(0, 50)}`)
    }
  }
  check(`every ${name} anchor still exists in the file it names`, missing === 0, detail.join(' | '))
  check(`no ${name} anchor matches more than once`, ambiguous === 0, detail.join(' | '))
}

// ---- the mutation scripts must be runnable, not just parseable ---------------
{
  const script = readFileSync(join(repo, 'scripts/mutate-guards.mjs'), 'utf8')
  // They restore the file in a `finally`; without one a failed mutation leaves a
  // mutated source tree behind, which is worse than the bug it was looking for.
  check('the guard mutation script restores in a finally block', /finally\s*\{/.test(script), 'no finally')
  check(
    'the guard mutation script re-syncs after restoring',
    script.includes('sync-gutter.mjs'),
    'the bundle would keep the mutated copy',
  )
}

{
  const script = readFileSync(join(repo, 'scripts/mutate-bundle.mjs'), 'utf8')
  check('the bundle mutation script restores in a finally block', /finally\s*\{/.test(script), 'no finally')
}

// ---- the generated copy is present and marked -------------------------------
{
  const bundle = readFileSync(join(repo, 'packages/ui-evolve/lib/client.js'), 'utf8')
  check('the bundle carries the generated-geometry markers', bundle.includes('// <gutter>') && bundle.includes('// </gutter>'), 'markers missing')
  const sync = readFileSync(join(repo, 'scripts/sync-gutter.mjs'), 'utf8')
  check('the sync script writes the generated region', sync.includes('// <gutter>'), basename(sync))

  // The generated block must be exactly what the sync script would emit right now.
  // An earlier version of this comment claimed test/gutter-drift.test.mjs held this
  // invariant; it does not — that file evaluates the block and compares behaviour,
  // deliberately, so a comment or an indent change is not a failure. Between the
  // behaviour comparison and this byte comparison, a hand edit is caught by one of
  // them and only a behavioural change is caught by the other.
  {
    // Compare against the sync script's own builder rather than a second copy of
    // the same transformation: the first version of this check rebuilt the block by
    // hand, kept the file header the sync drops, and was off by 412 characters — the
    // same two-implementations drift the sync exists to prevent, one level up.
    const gutterSource = readFileSync(join(repo, 'packages', 'ui-evolve', 'lib', 'gutter.js'), 'utf8')
    const bundle = readFileSync(join(repo, 'packages/ui-evolve/lib/client.js'), 'utf8')
    const generated = buildBlock(gutterSource)
    const start = bundle.indexOf(OPEN)
    const end = bundle.indexOf(CLOSE)
    check('the generated block is delimited', start >= 0 && end > start, `${start}..${end}`)
    // Slice from the start of the line, and compare the body against the whole
    // generated block. Both include the markers' four-space indent, so a marker
    // that drifted to two spaces fails here rather than passing: with two spaces
    // replaceBlock's `{4}` regex stops matching and the sync becomes a silent
    // no-op that still prints "synced N lines".
    const lineStart = bundle.lastIndexOf('\n', start) + 1
    const actual = start >= 0 && end > start ? bundle.slice(lineStart, end + CLOSE.length) : ''
    const generatedBody = generated
    check(
      'the generated block is exactly what the sync would write',
      actual === generatedBody,
      `bundle ${actual.length} chars vs generated ${generatedBody.length}`,
    )
  }
}

console.log(`
${passed} passed, ${failed} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failed === 0 ? 0 : 1)
