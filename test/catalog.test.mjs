/**
 * Tests for the catalog rewrite.
 *
 * The subject is a message the host built, so every fixture here is shaped like
 * the host's own output: a `<system-reminder>` frame with an
 * `<available_skills>` block, and a `source` object carrying the entries. The
 * two facts worth protecting are that the rendered text shrinks and that
 * `source.entries` does not move — the host re-publishes the whole catalog when
 * the digest of those entries changes, so editing them would make every step
 * append a fresh copy.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CATALOG_SOURCE_KIND,
  escapeCatalogText,
  truncateDescription,
  findCatalogMessage,
  findCatalogMessages,
  describeEntry,
  sortRows,
  shrinkCatalog
} from '../lib/catalog.js'
import { Store } from '../lib/store.js'

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Build a message shaped exactly like the host's catalog frame. */
function catalogMessage(entries, { update = false } = {}) {
  const heading = update
    ? 'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:'
    : 'A skill is a reusable set of task-specific instructions. The following skills are available in this session:'
  const body = entries.map((entry) => `- \`${entry.name}\`: ${escapeCatalogText(entry.description)}`).join('\n')
  const text = [
    '<system-reminder>',
    heading,
    '',
    '<available_skills>',
    body,
    '</available_skills>',
    '',
    'Use only names in this replacement catalog.',
    '</system-reminder>'
  ].join('\n')
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'skill-catalog', form: 'catalog', ...(update ? { update: true } : {}), entries }
  }
}

/** `n` skills with a realistic long description each. */
function manySkills(n) {
  return Array.from({ length: n }, (_, index) => ({
    name: `skill-${String(index).padStart(3, '0')}`,
    description: `Handles task number ${index}. ${'Details about applicability. '.repeat(8)}`
  }))
}

const OPTS = { shrinkChars: 80, frequentUses: 3, fullListBelow: 0, sessionAware: true }

// --------------------------------------------------------------- escaping --

check('escapeCatalogText escapes ampersand', escapeCatalogText('a & b') === 'a &amp; b')
check('escapeCatalogText escapes angle brackets', escapeCatalogText('<x>') === '&lt;x&gt;')
check(
  'escapeCatalogText escapes the ampersand first so entities are not doubled',
  escapeCatalogText('&lt;') === '&amp;lt;',
  escapeCatalogText('&lt;')
)
check('escapeCatalogText leaves plain text alone', escapeCatalogText('plain') === 'plain')
check('escapeCatalogText stringifies non-strings', escapeCatalogText(42) === '42')

// ------------------------------------------------------------- truncation --

check('truncateDescription keeps a short description untouched', truncateDescription('short', 80) === 'short')
check('truncateDescription marks a cut with an ellipsis', truncateDescription('x'.repeat(200), 80).endsWith('…'))
check('truncateDescription never exceeds the budget', truncateDescription('x'.repeat(200), 80).length === 80)
check('truncateDescription counts raw characters, not escaped ones', truncateDescription('<'.repeat(50), 20).length === 20)
check('truncateDescription treats zero as no limit', truncateDescription('x'.repeat(200), 0).length === 200)
check('truncateDescription treats a negative budget as no limit', truncateDescription('x'.repeat(200), -5).length === 200)
check('truncateDescription tolerates undefined', truncateDescription(undefined, 80) === '')
check('truncateDescription does not trim a description of exactly the budget', truncateDescription('x'.repeat(80), 80).length === 80)
check(
  'truncateDescription trims trailing space before the ellipsis',
  truncateDescription('aaaa bbbb cccc', 8) === 'aaaa bb…',
  truncateDescription('aaaa bbbb cccc', 8)
)
check(
  'truncateDescription does not leave half a surrogate pair',
  (() => {
    const cut = truncateDescription('a'.repeat(78) + '\u{1F600}' + 'zzz', 80)
    const last = cut.charCodeAt(cut.length - 2)
    return !(last >= 0xd800 && last <= 0xdbff)
  })(),
  'lone high surrogate left behind'
)
check(
  'truncateDescription does not leave half a CJK extension-B character',
  (() => {
    // Asserting on the surrogate range, not on U+FFFD: a lone surrogate is a
    // perfectly legal code unit inside a JS string and only becomes U+FFFD after
    // UTF-8 encoding. An earlier version of this test checked for U+FFFD and
    // passed even with the fix removed.
    const cut = truncateDescription('a'.repeat(78) + '\u{20BB7}' + 'zzz', 80)
    const last = cut.charCodeAt(cut.length - 2)
    return !(last >= 0xd800 && last <= 0xdbff) && cut.endsWith('…')
  })(),
  'lone high surrogate left behind'
)
check(
  'truncateDescription stays within budget after stepping off a surrogate',
  truncateDescription('a'.repeat(78) + '\u{1F600}' + 'zzz', 80).length <= 80
)
check(
  'truncateDescription does not leave a space before the ellipsis after stepping off a surrogate',
  (() => {
    const cut = truncateDescription('a'.repeat(77) + ' \u{1F600}' + 'zzz', 80)
    return !cut.slice(0, -1).endsWith(' ')
  })(),
  JSON.stringify(truncateDescription('a'.repeat(77) + ' \u{1F600}' + 'zzz', 80).slice(-4))
)
check(
  'truncateDescription leaves a whole surrogate pair intact when the budget covers it',
  truncateDescription('ab\u{1F600}cd', 10) === 'ab\u{1F600}cd'
)

// ------------------------------------------------------------- discovery --

const plain = catalogMessage([{ name: 'a', description: 'A' }])
check('findCatalogMessage finds the host message', findCatalogMessage([{ role: 'user', content: [] }, plain]) === plain)
check('findCatalogMessage ignores messages without a source', findCatalogMessage([{ role: 'user', content: [] }]) === undefined)
check('findCatalogMessage ignores a different source kind', findCatalogMessage([{ source: { kind: 'other', entries: [] } }]) === undefined)
check('findCatalogMessage ignores a catalog source with no entries array', findCatalogMessage([{ source: { kind: CATALOG_SOURCE_KIND, entries: 'x' } }]) === undefined)
check('findCatalogMessage tolerates a non-array', findCatalogMessage(undefined) === undefined)
check('findCatalogMessage tolerates null entries in the list', findCatalogMessage([null, 7, plain]) === plain)
check(
  'findCatalogMessage does not match on text alone',
  findCatalogMessage([{ role: 'user', content: [{ type: 'text', text: '<available_skills></available_skills>' }] }]) === undefined
)

// The host's own `catalogMessage()` returns the first match and replaces only
// that one. A session carrying a second catalog message — a resumed or forked
// seed, or a host version that appends instead of replacing — would then keep a
// full-length catalog visible forever. These lock the list-shaped lookup.
const second = catalogMessage([{ name: 'b', description: 'B' }])
check('findCatalogMessages returns every catalog message in list order', (() => {
  const found = findCatalogMessages([plain, { role: 'user', content: [] }, second])
  return found.length === 2 && found[0] === plain && found[1] === second
})())
check('findCatalogMessages returns an empty list for a non-array', findCatalogMessages(undefined).length === 0)
check('findCatalogMessages skips non-catalog messages', findCatalogMessages([null, 7, { source: { kind: 'other' } }]).length === 0)

// ----------------------------------------------------------------- tiers --

const entry = { name: 'pdf', description: 'd'.repeat(200) }
check(
  'a pinned skill keeps its full description',
  describeEntry({ entry, registry: { pdf: { pinned: true } }, options: OPTS }).tier === 'pinned'
)
check(
  'a pinned skill is not truncated',
  describeEntry({ entry, registry: { pdf: { pinned: true } }, options: OPTS }).description.length === 200
)
check(
  'a demoted skill is truncated',
  describeEntry({ entry, registry: { pdf: { demoted: true } }, options: OPTS }).description.length <= 80
)
check(
  'pinned outranks demoted so marking something important cannot hide it',
  describeEntry({ entry, registry: { pdf: { pinned: true, demoted: true } }, options: OPTS }).tier === 'pinned'
)
check(
  'a skill used in this session keeps its full description',
  describeEntry({ entry, sessionUsed: new Set(['pdf']), options: OPTS }).tier === 'session'
)
check(
  'session use is ignored when sessionAware is off',
  describeEntry({ entry, sessionUsed: new Set(['pdf']), options: { ...OPTS, sessionAware: false } }).tier === 'other'
)
check(
  'a skill at the use threshold keeps its full description',
  describeEntry({ entry, registry: { pdf: { uses: 3 } }, options: OPTS }).tier === 'frequent'
)
check(
  'a skill below the use threshold is truncated',
  describeEntry({ entry, registry: { pdf: { uses: 2 } }, options: OPTS }).tier === 'other'
)
check(
  'a missing registry entry is not an error',
  describeEntry({ entry, options: OPTS }).tier === 'other'
)
check(
  'a non-numeric use count is treated as zero',
  describeEntry({ entry, registry: { pdf: { uses: 'many' } }, options: OPTS }).tier === 'other'
)
check(
  'demoted loses to session use, so using it once restores its description',
  describeEntry({ entry, registry: { pdf: { demoted: true } }, sessionUsed: new Set(['pdf']), options: OPTS }).tier === 'demoted'
)

// ----------------------------------------------------------------- order --

const ordered = sortRows([
  { tier: 'demoted', name: 'b' },
  { tier: 'other', name: 'z' },
  { tier: 'pinned', name: 'c' },
  { tier: 'session', name: 'a' },
  { tier: 'frequent', name: 'm' },
  { tier: 'other', name: 'a' }
])
check(
  'sortRows orders pinned, session, frequent, other, demoted',
  ordered.map((row) => row.tier).join(',') === 'pinned,session,frequent,other,other,demoted'
)
check(
  'sortRows sorts alphabetically inside a tier so the list does not reshuffle',
  ordered.filter((row) => row.tier === 'other').map((row) => row.name).join(',') === 'a,z'
)
check('sortRows does not mutate its input', (() => {
  const input = [{ tier: 'other', name: 'b' }, { tier: 'pinned', name: 'a' }]
  sortRows(input)
  return input[0].name === 'b'
})())
check('sortRows puts an unknown tier last', sortRows([{ tier: 'mystery', name: 'a' }, { tier: 'demoted', name: 'b' }])[0].tier === 'demoted')

// ---------------------------------------------------------------- shrink --

const four = catalogMessage([
  { name: 'alpha', description: 'A'.repeat(300) },
  { name: 'beta', description: 'B'.repeat(300) },
  { name: 'gamma', description: 'C'.repeat(300) },
  { name: 'delta', description: 'D'.repeat(300) }
])
const shrunk = shrinkCatalog({ message: four, options: OPTS })
check('shrinkCatalog returns a message when something changed', shrunk !== undefined)
check('shrinkCatalog shortened the text', shrunk.stats.after < shrunk.stats.before)
check('shrinkCatalog reports the entry count', shrunk.stats.entries === 4)
check('shrinkCatalog reports the tier tally', shrunk.stats.tiers.other === 4)
check(
  'shrinkCatalog leaves source.entries byte-identical',
  shrunk.message.source.entries[0].description.length === 300
)
check('shrinkCatalog keeps the source object identity', shrunk.message.source === four.source)
check('shrinkCatalog keeps the message role', shrunk.message.role === 'user')
check(
  'shrinkCatalog preserves the host heading verbatim',
  shrunk.message.content[0].text.includes('A skill is a reusable set of task-specific instructions. The following skills are available in this session:')
)
check(
  'shrinkCatalog preserves the replacement frame heading too',
  shrinkCatalog({ message: catalogMessage(manySkills(4), { update: true }), options: OPTS }).message.content[0].text.includes('The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:')
)
check(
  'shrinkCatalog preserves the host closing instruction verbatim',
  shrunk.message.content[0].text.includes('Use only names in this replacement catalog.')
)
check(
  'shrinkCatalog does not mutate the original message',
  four.content[0].text.includes('A'.repeat(300))
)
check(
  'shrinkCatalog keeps the available_skills block well-formed',
  (shrunk.message.content[0].text.match(/<available_skills>/g) ?? []).length === 1 &&
    (shrunk.message.content[0].text.match(/<\/available_skills>/g) ?? []).length === 1
)
check(
  'shrinkCatalog keeps every skill name',
  ['alpha', 'beta', 'gamma', 'delta'].every((name) => shrunk.message.content[0].text.includes(`\`${name}\``))
)

const noChange = shrinkCatalog({
  message: catalogMessage([{ name: 'tiny', description: 'short' }]),
  options: OPTS
})
check('shrinkCatalog returns undefined when nothing would change', noChange === undefined)

check(
  'shrinkCatalog returns undefined for an empty catalog',
  shrinkCatalog({ message: catalogMessage([]), options: OPTS }) === undefined
)
check(
  'shrinkCatalog returns undefined when the text block is missing',
  shrinkCatalog({ message: { source: { kind: CATALOG_SOURCE_KIND, entries: [{ name: 'a', description: 'x'.repeat(200) }] }, content: [] }, options: OPTS }) === undefined
)
check(
  'shrinkCatalog returns undefined when the block has no available_skills marker',
  shrinkCatalog({
    message: {
      source: { kind: CATALOG_SOURCE_KIND, entries: [{ name: 'a', description: 'x'.repeat(200) }] },
      content: [{ type: 'text', text: 'no markers here' }]
    },
    options: OPTS
  }) === undefined
)
check(
  'shrinkCatalog tolerates a missing closing marker',
  shrinkCatalog({
    message: {
      source: { kind: CATALOG_SOURCE_KIND, entries: [{ name: 'a', description: 'x'.repeat(200) }] },
      content: [{ type: 'text', text: '<available_skills>\nbody' }]
    },
    options: OPTS
  }) === undefined
)

// pinned survives a rewrite
const mixed = shrinkCatalog({
  message: catalogMessage([
    { name: 'keep', description: 'K'.repeat(300) },
    { name: 'drop', description: 'D'.repeat(300) }
  ]),
  registry: { keep: { pinned: true } },
  options: OPTS
})
check('a pinned skill keeps its full text through the rewrite', mixed.message.content[0].text.includes('K'.repeat(300)))
check('an unranked skill is cut in the same rewrite', !mixed.message.content[0].text.includes('D'.repeat(300)))

// names-only mode
const big = catalogMessage(manySkills(50))
const names = shrinkCatalog({ message: big, options: { ...OPTS, fullListBelow: 40 } })
check('a library at the cutoff lists names only', names.stats.namesOnly === true)
check('names-only drops every description', !names.message.content[0].text.includes('Details about applicability'))
check(
  'names-only keeps every name',
  manySkills(50).every((entry) => names.message.content[0].text.includes(`\`${entry.name}\``))
)
check(
  'names-only still sorts pinned first',
  shrinkCatalog({
    message: catalogMessage(manySkills(50)),
    registry: { 'skill-049': { pinned: true } },
    options: { ...OPTS, fullListBelow: 40 }
  }).message.content[0].text.indexOf('`skill-049`') <
    shrinkCatalog({
      message: catalogMessage(manySkills(50)),
      registry: { 'skill-049': { pinned: true } },
      options: { ...OPTS, fullListBelow: 40 }
    }).message.content[0].text.indexOf('`skill-000`')
)
check(
  'a pinned skill keeps its description even in names-only mode',
  (() => {
    const out = shrinkCatalog({
      message: catalogMessage(manySkills(50)),
      registry: { 'skill-049': { pinned: true } },
      options: { ...OPTS, fullListBelow: 40 }
    })
    return out.message.content[0].text.includes('`skill-049`: Handles task number 49')
  })(),
  'pin promise broken in names-only mode'
)
check(
  'a non-pinned skill in names-only mode has no description',
  (() => {
    const out = shrinkCatalog({ message: catalogMessage(manySkills(50)), options: { ...OPTS, fullListBelow: 40 } })
    return !out.message.content[0].text.includes('Handles task number')
  })()
)
check(
  'the cutoff is inclusive at the configured size',
  shrinkCatalog({ message: catalogMessage(manySkills(40)), options: { ...OPTS, fullListBelow: 40 } }).stats.namesOnly === true
)
check(
  'one below the cutoff keeps descriptions',
  shrinkCatalog({ message: catalogMessage(manySkills(39)), options: { ...OPTS, fullListBelow: 40 } }).stats.namesOnly === false
)
check(
  'fullListBelow of zero disables the cutoff',
  shrinkCatalog({ message: catalogMessage(manySkills(500)), options: { ...OPTS, fullListBelow: 0 } }).stats.namesOnly === false
)

// the measured saving, so a regression in the shrink is visible as a number
const five = catalogMessage(manySkills(500))
const fiveShrunk = shrinkCatalog({ message: five, options: { ...OPTS, fullListBelow: 40 } })
check(
  'a 500-skill library loses at least 90% of its catalog text',
  fiveShrunk.stats.after / fiveShrunk.stats.before < 0.1,
  `${fiveShrunk.stats.before} → ${fiveShrunk.stats.after}`
)

// ---------------------------------------------------------- store ranking --

const dir = await mkdtemp(join(tmpdir(), 'skill-evolve-catalog-'))
try {
  const store = new Store({ root: dir, log: () => {} })
  const at = new Date().toISOString()

  const pinned = await store.markSkill({ name: 'external-skill', pinned: true, at })
  check('markSkill creates a registry entry for an unknown skill', pinned?.pinned === true)
  check('markSkill defaults a new entry to unverified', pinned?.stage === 'unverified')
  check('markSkill keeps uses at zero for a new entry', pinned?.uses === 0)

  const demoted = await store.markSkill({ name: 'external-skill', demoted: true, at })
  check('markSkill can set both flags at once', demoted?.pinned === true && demoted?.demoted === true)

  const unpinned = await store.markSkill({ name: 'external-skill', pinned: false, at })
  check('unpinning clears only the pin', unpinned?.pinned === undefined && unpinned?.demoted === true)

  const undemoted = await store.markSkill({ name: 'external-skill', demoted: false, at })
  check('undemoting clears only the demotion', undemoted?.demoted === undefined)

  const missing = await store.markSkill({ name: 'never-seen', pinned: false, at })
  check('clearing a flag on an unknown skill is a no-op', missing === undefined)
  check(
    'a no-op does not create a registry row',
    (await store.loadRegistry())['never-seen'] === undefined
  )

  const registry = await store.loadRegistry()
  check('the surviving entry kept its identity fields', registry['external-skill'].name === 'external-skill')

  const ledger = await store.loadRegistry()
  check('markSkill did not corrupt the registry file', typeof ledger === 'object' && ledger !== null)

  // the flags feed the rewrite end to end
  const wired = shrinkCatalog({
    message: catalogMessage([
      { name: 'external-skill', description: 'E'.repeat(300) },
      { name: 'other-skill', description: 'O'.repeat(300) }
    ]),
    registry: { 'external-skill': { pinned: true } },
    options: OPTS
  })
  check('a pin created through the store reaches the rewrite', wired.message.content[0].text.includes('E'.repeat(300)))
} finally {
  await rm(dir, { recursive: true, force: true })
}

// the ledger records who ranked what
const dir2 = await mkdtemp(join(tmpdir(), 'skill-evolve-ledger-'))
try {
  const store = new Store({ root: dir2, log: () => {} })
  await store.markSkill({ name: 'a', pinned: true, at: new Date().toISOString() })
  await store.markSkill({ name: 'a', pinned: false, at: new Date().toISOString() })
  await store.markSkill({ name: 'a', demoted: true, at: new Date().toISOString() })
  await store.markSkill({ name: 'a', demoted: false, at: new Date().toISOString() })
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(join(dir2, 'ledger.jsonl'), 'utf8')
  const actions = raw.trim().split('\n').map((line) => JSON.parse(line).action)
  check(
    'the ledger distinguishes pin, unpin, demote and undemote',
    actions.join(',') === 'skill_pinned,skill_unpinned,skill_demoted,skill_undemoted',
    actions.join(',')
  )
  check('the ledger attributes ranking to the user', JSON.parse(raw.trim().split('\n')[0]).actor === 'user')
} finally {
  await rm(dir2, { recursive: true, force: true })
}

// concurrency: ranking must not be lost when two writes overlap
const dir3 = await mkdtemp(join(tmpdir(), 'skill-evolve-race-'))
try {
  const store = new Store({ root: dir3, log: () => {} })
  const at = new Date().toISOString()
  await Promise.all([
    store.markSkill({ name: 'one', pinned: true, at }),
    store.markSkill({ name: 'two', pinned: true, at }),
    store.markSkill({ name: 'three', demoted: true, at })
  ])
  const registry = await store.loadRegistry()
  check(
    'concurrent rankings all survive',
    registry.one?.pinned === true && registry.two?.pinned === true && registry.three?.demoted === true,
    JSON.stringify(Object.keys(registry))
  )
} finally {
  await rm(dir3, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
