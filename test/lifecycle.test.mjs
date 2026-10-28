import {
  HALF_LIFE_DAYS,
  HARMFUL_WEIGHT,
  STAGES,
  confidence,
  ageInDays,
  decideStage,
  stateToFrontmatter,
  invertBody,
  unwrapInverted,
  summarize
} from '../lib/lifecycle.js'

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

console.log('lifecycle.js')

const NOW = new Date('2026-03-01T00:00:00.000Z')
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

check('four stages are declared', STAGES.length === 4 && STAGES.includes('inverted'))

// Confidence math
{
  const fresh = confidence({ helpful: 4, harmful: 0, validated: daysAgo(0) }, NOW)
  check('fresh net evidence scores near its raw value', Math.abs(fresh - 4) < 0.01, String(fresh))

  const halfLife = confidence({ helpful: 4, harmful: 0, validated: daysAgo(HALF_LIFE_DAYS) }, NOW)
  check('one half-life halves the score', Math.abs(halfLife - 2) < 0.01, String(halfLife))

  const twoHalfLives = confidence({ helpful: 4, harmful: 0, validated: daysAgo(HALF_LIFE_DAYS * 2) }, NOW)
  check('two half-lives quarter the score', Math.abs(twoHalfLives - 1) < 0.01, String(twoHalfLives))

  const harmful = confidence({ helpful: 4, harmful: 1, validated: daysAgo(0) }, NOW)
  check('one harmful report cancels four helpful ones', harmful === 0, String(harmful))

  const netNegative = confidence({ helpful: 5, harmful: 3, validated: daysAgo(0) }, NOW)
  check('net-negative evidence scores zero, never negative', netNegative === 0, String(netNegative))
  check('harmful weight is four', HARMFUL_WEIGHT === 4)

  check('a missing validation date scores zero', confidence({ helpful: 5, harmful: 0 }, NOW) === 0)
  check('an unparsable validation date scores zero', confidence({ helpful: 5, harmful: 0, validated: 'not-a-date' }, NOW) === 0)
  check('a future validation date does not inflate the score', confidence({ helpful: 4, harmful: 0, validated: '2027-01-01T00:00:00.000Z' }, NOW) <= 4)
}

// Age
{
  check('ageInDays measures whole days', Math.round(ageInDays(daysAgo(10), NOW)) === 10)
  check('ageInDays of a missing stamp is infinite', ageInDays(undefined, NOW) === Number.POSITIVE_INFINITY)
  check('ageInDays of a future stamp clamps to zero', ageInDays('2027-01-01T00:00:00.000Z', NOW) === 0)
}

// Promotion
{
  const decision = decideStage({
    state: { stage: 'unverified', uses: 3, harmful: 0, validated: daysAgo(1) },
    promoteAfterUses: 3, invertAfterHarmful: 3, staleAfterDays: 90, now: NOW
  })
  check('three uses promotes unverified to active', decision.stage === 'active' && decision.changed, JSON.stringify(decision))
  check('promotion explains itself', decision.reason.includes('3'), decision.reason)

  const notYet = decideStage({
    state: { stage: 'unverified', uses: 2, harmful: 0, validated: daysAgo(1) },
    promoteAfterUses: 3, invertAfterHarmful: 3, staleAfterDays: 90, now: NOW
  })
  check('two uses does not promote', notYet.stage === 'unverified' && !notYet.changed, JSON.stringify(notYet))
}

// Inversion wins over promotion
{
  const decision = decideStage({
    state: { stage: 'unverified', uses: 50, harmful: 3, validated: daysAgo(1) },
    promoteAfterUses: 3, invertAfterHarmful: 3, staleAfterDays: 90, now: NOW
  })
  check('harmful reports invert rather than promote', decision.stage === 'inverted', JSON.stringify(decision))
  check('inversion explains itself', decision.reason.includes('3'), decision.reason)
}

// Inverted is terminal
{
  const decision = decideStage({
    state: { stage: 'inverted', uses: 100, harmful: 0, validated: daysAgo(0) },
    promoteAfterUses: 3, invertAfterHarmful: 3, staleAfterDays: 90, now: NOW
  })
  check('an inverted skill never comes back on its own', decision.stage === 'inverted' && !decision.changed, JSON.stringify(decision))
}

// Decay to stale
{
  const decision = decideStage({
    state: { stage: 'active', uses: 10, harmful: 0, validated: daysAgo(91) },
    promoteAfterUses: 3, invertAfterHarmful: 3, staleAfterDays: 90, now: NOW
  })
  check('an unvalidated active skill goes stale', decision.stage === 'stale' && decision.changed, JSON.stringify(decision))
  check('decay explains its age', decision.reason.includes('91'), decision.reason)

  const fresh = decideStage({
    state: { stage: 'active', uses: 10, harmful: 0, validated: daysAgo(89) },
    promoteAfterUses: 3, invertAfterHarmful: 3, staleAfterDays: 90, now: NOW
  })
  check('a recently validated skill stays active', fresh.stage === 'active' && !fresh.changed, JSON.stringify(fresh))
}

// A stale skill can be re-promoted by use.
{
  const decision = decideStage({
    state: { stage: 'stale', uses: 4, harmful: 0, validated: daysAgo(200) },
    promoteAfterUses: 3, invertAfterHarmful: 3, staleAfterDays: 90, now: NOW
  })
  check('a stale skill revives on use', decision.stage === 'active', JSON.stringify(decision))
}

// Frontmatter mapping
{
  const fields = stateToFrontmatter({ id: 'abc', stage: 'active', uses: 7, harmful: 1, helpful: 9, created: 'x', validated: 'y', evidence: 'z' })
  check('maps id', fields['evolved-id'] === 'abc')
  check('maps stage', fields['evolved-stage'] === 'active')
  check('maps counters to numbers', fields['evolved-uses'] === 7 && fields['evolved-harmful'] === 1 && fields['evolved-helpful'] === 9)
  check('defaults a missing stage to unverified', stateToFrontmatter({})['evolved-stage'] === 'unverified')
  check('defaults counters to zero', stateToFrontmatter({})['evolved-uses'] === 0)
  check('an override wins', stateToFrontmatter({ stage: 'active' }, { stage: 'stale' })['evolved-stage'] === 'stale')
}

// Inversion preserves the original text
{
  const body = invertBody({ name: 'cache-auth-tokens', originalBody: 'Cache auth tokens for performance.', harmful: 3 })
  check('inversion warns in the first line', body.split('\n')[0].includes('PITFALL'))
  check('inversion states the harmful count', body.includes('3 times'), body.slice(0, 200))
  check('inversion keeps the original instructions', body.includes('Cache auth tokens for performance.'))
  check('inversion names the original skill', body.includes('cache-auth-tokens'))
  const single = invertBody({ name: 'x-y', originalBody: 'b', harmful: 1 })
  check('singular wording for one report', single.includes('1 time') && !single.includes('1 times'))
}

// Summary line
{
  const line = summarize({ stage: 'active', uses: 7, harmful: 0, helpful: 7, validated: daysAgo(0) }, NOW)
  check('summary names the stage', line.includes('active'), line)
  check('summary names the use count', line.includes('7 uses'), line)
  check('summary omits harmful when zero', !line.includes('harmful'), line)
  const withHarm = summarize({ stage: 'inverted', uses: 7, harmful: 3, helpful: 2, validated: daysAgo(0) }, NOW)
  check('summary includes harmful when present', withHarm.includes('3 harmful'), withHarm)
}

// --- inversion is idempotent ---------------------------------------------
//
// The lifecycle keeps calling `invertBody` on every harmful report for a skill
// that is already inverted. Without unwrapping first, each call stacked another
// PITFALL block and pushed the original instructions further down the file.
{
  const once = invertBody({ name: 'pdftotext-ocr', originalBody: '1. Run OCR at 300 dpi.', harmful: 3 })
  check('the first inversion opens with the warning', once.includes('PITFALL'), once.slice(0, 60))
  check('the first inversion keeps the instructions', once.includes('Run OCR at 300 dpi'))
  check('the first inversion states the count', once.includes('3 times'), once.split('\n')[2])

  const twice = invertBody({ name: 'pdftotext-ocr', originalBody: once, harmful: 4 })
  check('re-inverting does not stack a second warning', (twice.match(/PITFALL/g) ?? []).length === 1, String((twice.match(/PITFALL/g) ?? []).length))
  check('re-inverting still updates the count', twice.includes('4 times'), twice.split('\n')[2])
  check('re-inverting keeps the instructions exactly once', (twice.match(/Run OCR at 300 dpi/g) ?? []).length === 1, String((twice.match(/Run OCR at 300 dpi/g) ?? []).length))

  let many = once
  for (let n = 4; n <= 12; n += 1) many = invertBody({ name: 'pdftotext-ocr', originalBody: many, harmful: n })
  check('twelve reports leave exactly one warning', (many.match(/PITFALL/g) ?? []).length === 1, String((many.match(/PITFALL/g) ?? []).length))
  check('twelve reports leave exactly one copy of the instructions', (many.match(/Run OCR at 300 dpi/g) ?? []).length === 1, String((many.match(/Run OCR at 300 dpi/g) ?? []).length))
  check('twelve reports leave the latest count', many.includes('12 times'), many.split('\n')[2])
  check('the file does not grow with the report count', many.length < once.length + 40, [once.length, many.length].join(' < '))

  // A body that was never inverted must come back untouched, not emptied.
  check('a plain body passes through the unwrapper unchanged', unwrapInverted('1. Do the thing.') === '1. Do the thing.')
  check('an empty body does not throw', unwrapInverted(undefined) === '')
  // A person may edit the warning prose; the heading is what marks a wrapper.
  const handEdited = once.replace('do not follow this skill as written', 'DO NOT FOLLOW THIS')
  const rewrapped = invertBody({ name: 'pdftotext-ocr', originalBody: handEdited, harmful: 5 })
  check('an edited warning is still recognised as one layer', (rewrapped.match(/PITFALL/g) ?? []).length === 1, String((rewrapped.match(/PITFALL/g) ?? []).length))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
