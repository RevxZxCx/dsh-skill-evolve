/**
 * Local skill search, and the reason it exists at all.
 *
 * Stage 1 shrank the catalog: unranked skills lose their description, and past
 * `catalogFullListBelow` every skill but a pinned one is reduced to a bare name.
 * That is the right trade for the token budget, but it creates a debt — a model
 * that can no longer read what a skill does cannot decide to use it. This module
 * pays that debt. Shrinking without a search path would be strictly worse than
 * not shrinking: the catalog would be cheap and the skills invisible.
 *
 * The search runs against the host's own catalog rather than the directory tree.
 * `ctx.skills.snapshot()` already merges every provider (project `.dsh/skills`,
 * project `.agents/skills`, custom dirs, `$DSH_HOME/skills`, `~/.agents/skills`,
 * bundled) and resolves shadowing between them. Re-implementing that here would
 * mean a search that can disagree with what the model is actually allowed to
 * load — the worst possible outcome for a tool whose only job is to say "this
 * skill exists".
 *
 * Scoring is keyword-based and deliberately dumb. Embedding search needs a
 * vector store, a model, and a threshold nobody can tune; at a few hundred
 * skills, matching the words the person actually typed is both cheaper and
 * easier to explain when it returns nothing.
 */

/** Fields are searched in this order of authority, so a name hit outranks a body hit. */
const FIELD_WEIGHTS = { name: 10, whenToUse: 4, description: 3, content: 1 }

/** A body can be 40 KB; scoring all of it would drown the signals above it. */
const CONTENT_SCAN_LIMIT = 4000

/**
 * Bodies loaded per search when the caller does not say.
 *
 * Every loaded body is a file read plus a frontmatter parse. Twenty is enough to
 * cover the plausible matches in a large library while keeping the worst case
 * bounded; raising it costs latency, not tokens.
 */
const DEFAULT_LOAD_BODIES = 20

/**
 * Split a query into lowercase search terms.
 *
 * Every term is kept, including short ones: "pdf" is three characters and is
 * the entire query. Nothing is stemmed, because a stemmer that turns "triage"
 * into "triag" is a source of silent misses with no upside at this scale.
 *
 * @param {string} query - raw user or model input.
 * @returns {string[]} unique lowercase terms, in first-seen order.
 */
export function terms(query) {
  const text = String(query ?? '').toLowerCase()
  const found = text.split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 0)
  return [...new Set(found)]
}

/**
 * Count how many terms a haystack contains, and where the first one landed.
 *
 * Counting distinct terms rather than occurrences is deliberate: a skill whose
 * body repeats "pdf" forty times is not forty times more relevant than one that
 * mentions it once, and occurrence counts make long bodies win by length alone.
 *
 * @param {string} haystack - text to scan.
 * @param {string[]} needles - lowercase terms.
 * @returns {{hits: number, first: number}} distinct hits and index of the first.
 */
function countHits(haystack, needles) {
  const text = haystack.toLowerCase()
  let hits = 0
  let first = -1
  for (const needle of needles) {
    const at = text.indexOf(needle)
    if (at < 0) continue
    hits += 1
    if (first < 0 || at < first) first = at
  }
  return { hits, first }
}

/**
 * Score one skill against the query terms.
 *
 * A skill matching every term is worth far more than one matching half of them,
 * so coverage is squared rather than added: this makes "pdf form fill" rank the
 * skill that does all three above one that only says "pdf" repeatedly.
 *
 * @param {object} skill - summary from `ctx.skills.snapshot()`.
 * @param {object} detail - optional loaded skill; supplies the body text.
 * @param {string[]} needles - lowercase terms.
 * @returns {{score: number, matched: string[]}} score and the fields that hit.
 */
export function scoreSkill(skill, detail, needles) {
  if (needles.length === 0) return { score: 0, matched: [] }

  const haystacks = [
    ['name', String(skill?.name ?? '')],
    ['whenToUse', String(skill?.whenToUse ?? '')],
    ['description', String(skill?.description ?? '')],
    ['content', String(detail?.content ?? '').slice(0, CONTENT_SCAN_LIMIT)]
  ]

  let score = 0
  const matched = new Set()
  for (const [field, text] of haystacks) {
    if (text.length === 0) continue
    const { hits } = countHits(text, needles)
    if (hits === 0) continue
    matched.add(field)
    score += FIELD_WEIGHTS[field] * hits
  }

  if (matched.size === 0) return { score: 0, matched: [] }

  // Coverage dominates: matching every term in a weak field still beats matching
  // one term in the strongest field, which is what a person means by "find me
  // something that does this".
  const coverage = (countCovered(haystacks, needles) / needles.length) ** 2
  return { score: score * coverage, matched: [...matched] }
}

/**
 * How many query terms appear anywhere in this skill.
 *
 * @param {Array<[string, string]>} haystacks - field name and text pairs.
 * @param {string[]} needles - lowercase terms.
 * @returns {number} count of terms found in at least one field.
 */
function countCovered(haystacks, needles) {
  let covered = 0
  for (const needle of needles) {
    if (haystacks.some(([, text]) => text.toLowerCase().includes(needle))) covered += 1
  }
  return covered
}

/**
 * Search the host's skill catalog and return the best matches, most relevant first.
 *
 * Loading a body is optional and bounded by `loadBodies`: `ctx.skills.get()` reads
 * and parses a file, so scoring 300 skills with bodies would mean 300 file reads
 * for a query that returns five. Bodies are therefore loaded only for skills that
 * already matched on name, description, or whenToUse — the ones that can plausibly
 * rank — and only up to the limit.
 *
 * @param {object} input - search input.
 * @param {object} input.skills - the skills service (`ctx.skills`).
 * @param {string} input.query - what to look for.
 * @param {object} [input.options] - view options passed to the skills service.
 * @param {number} [input.limit] - maximum results; defaults to 5.
 * @param {number} [input.loadBodies] - how many bodies to load for scoring; defaults to 20.
 * @param {(name: string) => Promise<object|undefined>} [input.load] - overrides body loading.
 * @returns {Promise<{query: string, terms: string[], total: number, results: object[]}>}
 */
export async function searchSkills(input) {
  const { skills, query, options } = input
  const limit = Math.max(1, Math.floor(Number(input.limit) || 5))
  const loadBodies = Math.max(0, Math.floor(Number(input.loadBodies ?? DEFAULT_LOAD_BODIES)))
  const needles = terms(query)

  const snapshot = await skills.snapshot(options ?? {})
  const all = Array.isArray(snapshot?.skills) ? snapshot.skills : []

  if (needles.length === 0) {
    return { query: String(query ?? ''), terms: [], total: all.length, results: [] }
  }

  const load = input.load ?? ((name) => skills.get(name, options ?? {}))

  // Pass one: score on the fields the snapshot already carries. This is free —
  // no file is opened — and it is what decides which bodies are worth loading.
  const scored = all.map((skill) => {
    const { score, matched } = scoreSkill(skill, undefined, needles)
    return { skill, score, matched }
  })

  // Which skills get their body read, and in what order.
  //
  // Skills that already matched on their summary come first: they can rank
  // higher with a body, and they are the ones a person expects to see. But the
  // whole reason this module exists is that stage 1 strips descriptions — a
  // skill reduced to a bare name matches nothing on its summary, and its body is
  // the only place the words survive. So when the summary pass finds fewer than
  // `limit` skills, the remaining budget is spent probing the unmatched ones.
  // Loading all of them would mean one file read per skill in the library.
  const byScore = [...scored].sort((left, right) => right.score - left.score)
  const matchedRows = byScore.filter((row) => row.matched.length > 0)
  const unmatchedRows = byScore.filter((row) => row.matched.length === 0)
  const loadable = loadBodies === 0
    ? []
    : [
        ...matchedRows.slice(0, loadBodies),
        ...unmatchedRows.slice(0, Math.max(0, loadBodies - Math.min(matchedRows.length, loadBodies)))
      ]

  // Pass two: for the plausible ones, add the body to the score. A skill that
  // only matches in its body is reachable this way, which is the case that
  // matters when the description was truncated to nothing by stage 1.
  for (const row of loadable) {
    let detail
    try {
      detail = await load(row.skill.name)
    } catch {
      // An unreadable body must not fail the search; the summary already scored.
      detail = undefined
    }
    if (detail === undefined) continue
    const withBody = scoreSkill(row.skill, detail, needles)
    if (withBody.score <= row.score) continue
    row.score = withBody.score
    row.matched = [...new Set([...row.matched, ...withBody.matched])]
  }

  const results = scored
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || String(left.skill.name).localeCompare(String(right.skill.name)))
    .slice(0, limit)
    .map((row) => ({
      name: String(row.skill.name ?? ''),
      description: String(row.skill.description ?? ''),
      ...row.skill.whenToUse === undefined ? {} : { whenToUse: String(row.skill.whenToUse) },
      source: String(row.skill.source ?? ''),
      matched: row.matched
    }))

  return {
    query: String(query ?? ''),
    terms: needles,
    total: all.length,
    results
  }
}

/**
 * Render search results as the text a model reads.
 *
 * An empty result says how many skills were searched, because "nothing matched"
 * and "the catalog is empty" are different problems and the model cannot tell
 * them apart from a bare "no results".
 *
 * @param {object} outcome - value returned by `searchSkills`.
 * @returns {string} rendered text, never empty.
 */
export function renderResults(outcome) {
  const results = Array.isArray(outcome?.results) ? outcome.results : []
  const total = Number(outcome?.total) || 0

  if (results.length === 0) {
    const terms = Array.isArray(outcome?.terms) ? outcome.terms : []
    if (terms.length === 0) return `No searchable terms in "${outcome?.query ?? ''}". Searched ${total} skill(s).`
    return `No skill matched ${terms.map((term) => `"${term}"`).join(' ')}. Searched ${total} skill(s).`
  }

  const lines = results.map((row) => {
    const fields = row.matched.length > 0 ? ` [matched: ${row.matched.join(', ')}]` : ''
    const when = row.whenToUse === undefined ? '' : `\n  when: ${row.whenToUse}`
    return `- \`${row.name}\`${fields}\n  ${row.description}${when}`
  })

  return [
    `${results.length} of ${total} skill(s) matched ${outcome.terms.map((term) => `"${term}"`).join(' ')}:`,
    ...lines,
    'Load one with the `skill` tool before using it.'
  ].join('\n')
}
