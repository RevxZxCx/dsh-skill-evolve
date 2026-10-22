import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertSkillName,
  parseFrontmatter,
  renderSkillFile,
  readSkillFile,
  readState,
  listOwnedSkills
} from '../lib/skillfile.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

console.log('skillfile.js')

// Names
check('accepts kebab-case', assertSkillName('pdf-table-extract') === 'pdf-table-extract')
for (const bad of ['Pdf-Table', 'pdf_table', '-lead', 'trail-', 'a--b', '', 'a b']) {
  let threw = false
  try {
    assertSkillName(bad)
  } catch {
    threw = true
  }
  check(`rejects "${bad}"`, threw)
}

// Render + parse round trip
{
  const text = renderSkillFile({
    name: 'pdf-table-extract',
    description: 'Extract tables from a PDF into a spreadsheet.',
    body: '# Steps\n\n1. Run pdftotext.\n2. Parse.\n',
    state: { 'evolved-stage': 'unverified', 'evolved-uses': 0 }
  })
  check('starts with a frontmatter fence', text.startsWith('---\n'))
  const parsed = parseFrontmatter(text)
  check('round-trips the name', parsed?.data.name === 'pdf-table-extract', parsed?.data.name)
  check('round-trips the description', parsed?.data.description === 'Extract tables from a PDF into a spreadsheet.', parsed?.data.description)
  check('records the ownership marker', parsed?.data['evolved-by'] === 'dsh-skill-evolve', parsed?.data['evolved-by'])
  check('round-trips lifecycle state', parsed?.data['evolved-stage'] === 'unverified', parsed?.data['evolved-stage'])
  check('preserves the body', parsed?.body.includes('Run pdftotext'), JSON.stringify(parsed?.body))
}

// Descriptions containing quotes, colons, and newlines survive.
{
  const description = 'Handles "quoted" words: colons, #hashes, and \\ backslashes.'
  const text = renderSkillFile({ name: 'tricky-desc', description, body: 'body' })
  const parsed = parseFrontmatter(text)
  check('survives quotes/colons/backslashes in description', parsed?.data.description === description, parsed?.data.description)
}

// Empty fields are refused.
{
  let threw = 0
  try {
    renderSkillFile({ name: 'x-y', description: '', body: 'b' })
  } catch {
    threw += 1
  }
  try {
    renderSkillFile({ name: 'x-y', description: 'd', body: '   ' })
  } catch {
    threw += 1
  }
  check('refuses empty description and body', threw === 2, String(threw))
}

// Missing frontmatter is reported.
check('rejects a file with no frontmatter', parseFrontmatter('# just markdown\n') === undefined)
check('rejects an unterminated fence', parseFrontmatter('---\nname: x\n') === undefined)

// Ownership
{
  const root = await mkdtemp(join(tmpdir(), 'skill-evolve-'))
  try {
    const owned = join(root, 'owned-one')
    await mkdir(owned, { recursive: true })
    await writeFile(join(owned, 'SKILL.md'), renderSkillFile({
      name: 'owned-one', description: 'mine', body: 'body', state: { 'evolved-stage': 'active', 'evolved-uses': 7 }
    }))

    const foreign = join(root, 'human-one')
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'SKILL.md'), '---\nname: human-one\ndescription: hand written\n---\n\nbody\n')

    const read = await readSkillFile(join(owned, 'SKILL.md'))
    check('marks this plugin files as owned', read.owned === true)
    const foreignRead = await readSkillFile(join(foreign, 'SKILL.md'))
    check('marks hand-written files as not owned', foreignRead.owned === false)

    const state = readState(read.data)
    check('reads lifecycle counters back', state.uses === 7 && state.stage === 'active', JSON.stringify(state))
    check('defaults stage when absent', readState(foreignRead.data).stage === 'unverified')

    const listed = await listOwnedSkills(root)
    check('lists only owned skills', listed.length === 1 && listed[0].name === 'owned-one', JSON.stringify(listed.map((s) => s.name)))

    const missing = await listOwnedSkills(join(root, 'does-not-exist'))
    check('a missing root lists nothing', missing.length === 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
