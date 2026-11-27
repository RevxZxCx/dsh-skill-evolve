// Prove the next-step offer is guarded on both sides of the wire.
//
// The feature has the same shape as the speed badge and a worse failure mode.
// Every part of it can be wrong and still look like a working panel: chips that
// appear during a running turn look like enthusiasm, a ghost that fills the box
// and sends looks like a feature that misunderstood its own key, and a route
// that buys an answer nobody reads costs money silently. None of those throw,
// and none are visible in a screenshot taken a second after the row appeared.
//
// Two layers, three suites:
//
//   * `suggest.js` — the arithmetic. What is quoted into the prompt, what comes
//     back, and the five gates that decide whether a call happens at all.
//     `test/suggest.test.mjs`.
//   * `api.js` — the wire. The one read that spends a model call, and the three
//     answers a caller can get without one. `test/api.test.mjs`.
//   * `client.js` — the two surfaces. A chip is a decision, a key is a start,
//     and the difference is one microtask between `setDraft` and `submit`.
//     `test/client.test.mjs`.
//
// The two failure modes this repo's mutation scripts have been burned by are
// handled the way every other script here handles them: an anchor that no
// longer matches is its own outcome (NOT APPLIED) rather than a survival, and a
// run with no tally line is CRASHED rather than either answer. A green run with
// no baseline check means nothing, so the baseline runs first.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))

const suggest = path.join(repo, 'packages', 'ui-evolve', 'lib', 'suggest.js')
const api = path.join(repo, 'packages', 'ui-evolve', 'lib', 'api.js')
const client = path.join(repo, 'packages', 'ui-evolve', 'lib', 'client.js')
const transcript = path.join(repo, 'packages', 'ui-evolve', 'lib', 'transcript.js')
const summarise = path.join(repo, 'packages', 'ui-evolve', 'lib', 'summarise.js')

/**
 * Failures reported by a suite, or -1 when it printed no tally at all.
 *
 * The tally is the only honest source: a crash prints no `FAIL` row, so counting
 * rows would call a crashed run a survival.
 */
function failures(output) {
  const match = /(\d+) passed, (\d+) failed/.exec(output)
  return match === null ? -1 : Number(match[2])
}

function run(suites) {
  const outputs = []
  for (const suite of suites) {
    try {
      outputs.push(execFileSync(process.execPath, [path.join(repo, suite)], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180000,
        env: { ...process.env, TMPDIR: path.join(repo, '.tmp-test'), TEMP: path.join(repo, '.tmp-test'), TMP: path.join(repo, '.tmp-test') },
      }))
    } catch (error) {
      outputs.push(`${error.stdout ?? ''}${error.stderr ?? ''}`)
    }
  }
  // Every suite has to have reported. A run that names two and only hears from
  // one has not established anything about the other.
  let total = 0
  for (const output of outputs) {
    const count = failures(output)
    if (count < 0) return -1
    total += count
  }
  return total
}

/**
 * Write a file, retrying while the platform holds it.
 *
 * Windows returns `EBUSY`/`UNKNOWN` (`errno -4094`) when a watcher or indexer
 * has the file open for a moment. A plain `writeFileSync` throws, and the throw
 * comes from inside the `try` that restored the original file -- so the mutated
 * source stayed on disk and the next run baked it in permanently. That is how a
 * crash stops being a crash and becomes a corrupted checkout. The restore path
 * matters more than the mutate path: a failed mutate is a skipped mutation, a
 * failed restore is a wrong file. The first run of this script after the excerpt
 * work left `const truncated = false` behind in `suggest.js` for exactly this
 * reason, and the next baseline then failed on three assertions that looked like
 * a product bug.
 *
 * @param {string} file - the file to write.
 * @param {string} content - the exact bytes to write.
 */
function writeWithRetry(file, content) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.writeFileSync(file, content, 'utf8')
      return
    } catch (error) {
      if (attempt === 5) throw error
      const until = Date.now() + 60 * (attempt + 1)
      while (Date.now() < until) { /* wait out the transient lock */ }
    }
  }
}

const engine = ['test/suggest.test.mjs']
const wire = ['test/api.test.mjs']
const view = ['test/client.test.mjs']
const transcriptSuite = ['test/transcript.test.mjs']

const mutations = [
  // ---------------------------------------------------------------------
  // The prompt: what the model is allowed to see
  // ---------------------------------------------------------------------
  {
    file: suggest,
    suites: engine,
    label: 'the report is quoted whole',
    from: 'export const MAX_REPORT_CHARS = 1200',
    to: 'export const MAX_REPORT_CHARS = 200000',
    why: 'one long turn then arrives whole, so the prompt grows with the session and a resumed conversation costs more than a new one — the ceiling the module claims by construction is gone',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the count is read as a list of turns',
    from: `  const previous = view?.previous
  if (previous === undefined || previous === null`,
    to: `  const previous = view?.turns
  if (previous === undefined || previous === null`,
    why: 'the transcript keeps a numerical count there, so reading it as a turn snapshot makes every real body empty and the row never appears (DEF-198); the fixtures that pass arrays cannot tell the two apart unless one of them passes a count',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the turn is dropped when it is long',
    from: '    const quoted = excerptOf(report, MAX_REPORT_CHARS, REPORT_CUT_MARK)',
    to: '    const quoted = report.slice(0, MAX_REPORT_CHARS)',
    why: 'dropping instead of clipping makes the row absent exactly when a turn got substantial, which is when a next step is worth most',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the request in progress is not quoted',
    from: "  if (latest.length > 0) sections.push(`${LATEST_OPEN}\\n${latest}\\n${LATEST_CLOSE}`)",
    to: "  if (false) sections.push(`${LATEST_OPEN}\\n${latest}\\n${LATEST_CLOSE}`)",
    why: 'the offer is built on the request that opened this turn; without it the model predicts from the report alone and suggests a step nobody asked for, which is the shape the reader rejected',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the quote carries no markers',
    from: "const SESSION_OPEN = '<session>'",
    to: "const SESSION_OPEN = ''",
    why: 'the instruction tells the model the turns are data; without the opening marker it cannot tell where the data starts, which is the injection boundary this prompt has',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the request does not say which purpose spent the money',
    from: "    purpose: 'skill-evolve-next-prompt',",
    to: "    purpose: 'skill-evolve-panel-summary',",
    why: 'the purpose is what a user reads in the log to tell the two paid features apart, and what a future budget check would key on',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the request is attributed to the summary',
    from: "          source: { kind: 'dsh-ui-evolve-suggest' },",
    to: "          source: { kind: 'dsh-ui-evolve-panel' },",
    why: 'both files buy a call, and the only thing that separates them in a transcript is this string',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the output budget is a paragraph',
    from: 'export const SUGGEST_MAX_TOKENS = 700',
    to: 'export const SUGGEST_MAX_TOKENS = 4096',
    why: 'three short sentences cost about sixty tokens; a four-thousand-token budget invites the prose this parser then has to throw away, and the caller pays for it',
  },

  {
    file: suggest,
    suites: engine,
    label: 'a cut-off answer looks like an empty turn',
    from: "      const truncated = finishKind !== '' && /length|max[_-]?tokens|truncat/i.test(finishKind)",
    to: '      const truncated = false',
    why: 'the whole output budget can go to the thinking of a reasoning model, and the answer then arrives empty with finish "length"; without this branch that is cached as a normal empty turn and the offer silently never appears (DEF-200)',
  },

  // ---------------------------------------------------------------------
  // The answer: what a chip may say
  // ---------------------------------------------------------------------
  {
    file: suggest,
    suites: engine,
    label: 'an over-long answer is cut at the chip width',
    from: 'export const MAX_SUGGESTION_CHARS = 40',
    to: 'export const MAX_SUGGESTION_CHARS = 600',
    why: 'a chip wider than the composer cannot be read or clicked, and the clip is the only thing standing between the model and a two-line button',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a paragraph is cut instead of dropped',
    from: 'export const HARD_SUGGESTION_CHARS = 400',
    to: 'export const HARD_SUGGESTION_CHARS = 100000',
    why: 'a paragraph whose first sentence describes what happened reads as an instruction once it is cut, which is the one kind of chip this feature must never draw',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the sentence end is ignored',
    from: '  if (end > 0 && end + 1 <= MAX_SUGGESTION_CHARS) return text.slice(0, end + 1).trim()',
    to: '  if (false) return text.slice(0, end + 1).trim()',
    why: 'without it a two-sentence answer is cut mid-clause and closed with an ellipsis, so the actionable first sentence loses its ending and the tail is what the person reads',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a word is split by the clip',
    from: '  const body = space > MAX_SUGGESTION_CHARS - 20 ? cut.slice(0, space) : cut',
    to: '  const body = cut',
    why: 'cutting inside a word is the difference between "…apply the mi…" and text a person can read; Latin scripts have the space to cut at and CJK deliberately does not',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a markdown bullet survives into the chip',
    from: "  text = text.replace(/^\\s*(?:[-*•]|\\d+[.)])\\s+/, '')",
    to: '  text = text',
    why: 'a chip starting with "- " or "1. " is read as a list item whose list has one item, and the dash is what a model adds when it was told not to',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a fenced block is kept',
    from: "  if (text.includes('```')) return ''",
    to: "  if (false) return ''",
    why: 'a chip cannot render a code block; a fence is the shape a model uses when it answered something other than a step',
  },
  {
    file: suggest,
    suites: engine,
    label: 'inline code is dropped instead of unwrapped',
    from: "  text = text.replace(/`([^`]+)`/g, '$1').trim()",
    to: "  if (/`[^`]+`/.test(text)) return ''",
    why: 'a coding agent names a command or a path in nearly every next step, so dropping those candidates is how a real session ends up with no offer at all while the suite stays green on prose fixtures (DEF-200)',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a suggestion that is a URL is kept',
    from: "  if (/^(?:https?|file):\\/\\//i.test(text)) return ''",
    to: '  if (false) return \'\'',
    why: 'a link has no verb to act on, and clicking the row would send the URL as the next prompt',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the hard length is not enforced',
    from: '  if (text.length > HARD_SUGGESTION_CHARS) return \'\'',
    to: '  if (false) return \'\'',
    why: 'the clip runs after this check and would happily cut a paragraph, which is the outcome the check exists to avoid',
  },
  {
    file: suggest,
    suites: engine,
    label: 'two identical answers are drawn as two chips',
    from: '    if (seen.has(identity)) continue',
    to: '    if (false) continue',
    why: 'a model that repeats itself would fill the row with one idea, and the row exists to offer a choice',
  },

  {
    file: suggest,
    suites: engine,
    label: 'the count is ignored when the model answers more',
    from: '    if (items.length >= limit) break',
    to: '    if (false) break',
    why: 'the configured count is what the row was signed off at; ignoring it draws however many the model felt like writing',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a configured count above the ceiling is honoured',
    from: '  if (number > MAX_SUGGESTIONS) return MAX_SUGGESTIONS',
    to: '  if (number > MAX_SUGGESTIONS) return number',
    why: 'the setting is a request, not a limit: without the clamp one config write puts ten chips under the composer',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a preamble survives into the parser',
    from: '  if (brace > 0) body = body.slice(brace)',
    to: '  if (false) body = body.slice(brace)',
    why: '"Here are three suggestions:" makes the JSON unparseable, so the answer falls through to the line reader and the preamble itself becomes an offer',
  },

  // ---------------------------------------------------------------------
  // The gates: what decides whether a call happens
  // ---------------------------------------------------------------------
  {
    file: suggest,
    suites: engine,
    label: 'an unset switch counts as on',
    from: "    if (config?.panelSuggestions !== true) return { enabled: false, items: [], reason: 'turned off in settings' }",
    to: "    if (config?.panelSuggestions === false) return { enabled: false, items: [], reason: 'turned off in settings' }",
    why: 'the switch has to be an explicit yes; reading absence as yes means a profile that never configured this plugin starts paying for it',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a session with no finished turn is asked anyway',
    from: "    if (previous === undefined) return { enabled: true, items: [], reason: 'no completed turn yet' }",
    to: '    if (false) return { enabled: true, items: [], reason: \'no completed turn yet\' }',
    why: 'the first turn of a conversation is the one Qoder also skips: there is nothing to infer from, so the call would buy a generic sentence and teach the reader to ignore the row',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a turn still running is offered the next step anyway',
    from: "    if (view?.current?.turn !== undefined) return { enabled: true, items: [], reason: 'a turn is running', busy: true }",
    to: '    if (false) return { enabled: true, items: [], reason: \'a turn is running\', busy: true }',
    why: 'the row names the step after the answer on screen; during a turn that answer is still arriving, and the composer the ghost sits in is the one the reader may interrupt -- the client cannot see this from the submit machine, which is plain for the whole turn',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a running turn is reported as merely empty',
    from: "    if (view?.current?.turn !== undefined) return { enabled: true, items: [], reason: 'a turn is running', busy: true }",
    to: '    if (view?.current?.turn !== undefined) return { enabled: true, items: [], reason: \'a turn is running\' }',
    why: 'without the flag the client reads an empty answer during a turn as the settling race and spends the one retry a session gets on it, so the real race at the end of that turn goes unretried (DEF-202)',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a cached answer is bought again',
    from: '    if (cached !== undefined) {',
    to: '    if (false) {',
    why: 'a closed turn does not improve by being asked for twice, and asking again bills the reader for a second reading of an answer they already own; the turn is in the key, so a genuinely new turn still gets its own call',
  },
  {
    file: suggest,
    suites: engine,
    label: 'an old answer is never marked stale',
    from: '      const stale = now - cached.at >= SUGGEST_TTL_MS',
    to: '      const stale = false',
    why: 'without the flag the composer draws three chips under a turn the reader has moved past; the chips are a claim about the answer on screen, and a stale answer is no longer about it',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the failure memory is not consulted',
    from: '    if (failed !== undefined && now - failed.at < SUGGEST_FAILURE_TTL_MS) {',
    to: '    if (false) {',
    why: 'a route that just refused for lack of credit is asked again on every repaint, which is a paid retry storm behind a composer that looks idle',
  },
  {
    file: suggest,
    suites: engine,
    label: 'two repaints buy two answers',
    from: `    const running = this.inflight.get(key)
    if (running !== undefined) return running`,
    to: `    const running = this.inflight.get(key)
    if (false) return running`,
    why: 'the composer asks on mount and again on every frame the stream pushes; without the in-flight map one turn is bought several times over',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the answer is keyed by turn alone',
    from: "  const text = `${typeof turn === 'number' ? turn : 0}:${body}`",
    to: "  const text = `${typeof turn === 'number' ? turn : 0}`",
    why: 'a retry inside one turn rewrites the transcript without ending it, so a turn-only key serves chips about text the person has already replaced',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a cancellation is remembered as a failure',
    from: '      if (!cancelled) this.noteFailure(key, reason)',
    to: '      this.noteFailure(key, reason)',
    why: 'the composer aborts the request when it unmounts; remembering that as the model verdict silences the next turn for a minute on no evidence',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the call has no deadline',
    from: '    const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS)',
    to: '    const timer = setTimeout(() => {}, SUGGEST_TIMEOUT_MS)',
    why: 'a stream that stalls holds the route open until the socket dies; the client gives up at twenty-five seconds and the answer is then paid for and dropped',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the deadline is a fraction of the wait',
    from: 'export const SUGGEST_TIMEOUT_MS = 20000',
    to: 'export const SUGGEST_TIMEOUT_MS = 1000',
    why: 'one 700-token call takes 12.6 s on the host gateway, so a one-second deadline is a route that never answers; the assertion names the value because both ends of this pair are latency measured on the machine, not constants that travel',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the pinned route is ignored',
    from: '    if (provider.length > 0 && model.length > 0) return { provider, model, pinned: true }',
    to: '    if (false) return { provider, model, pinned: true }',
    why: 'the pinned pair is what the person asked for; falling through to the session route silently spends money on a different model',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the session route is not preferred over the catalogue',
    from: '    if (sessionRoute !== undefined && typeof sessionRoute.provider === \'string\' && typeof sessionRoute.model === \'string\') {',
    to: '    if (false) {',
    why: 'a route the session is already running on is proven reachable and authorised; a catalogue entry only proves an adapter advertised it, which is how the first attempt fails on an account that cannot use it',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the last resort is not reached',
    from: '    const providers = Array.isArray(catalog?.providers) ? catalog.providers : Array.isArray(catalog) ? catalog : []',
    to: '    const providers = []',
    why: 'the catalogue walk is the only path when the session has no route of its own, which is the case for a session that has not called a model yet',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the cache grows without bound',
    from: '      if (this.cache.size > CACHE_LIMIT) {',
    to: '      if (false) {',
    why: 'one entry per turn per session, kept for the life of the process, is a leak that only shows up on a long-running host',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a closed session keeps its answers',
    from: '        if (key.startsWith(prefix)) map.delete(key)',
    to: '        if (false) map.delete(key)',
    why: 'the maps are otherwise bounded by sessions that have ever existed rather than by live ones, which is the difference between a cache and a leak',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a model change keeps the old answers',
    from: `  reset() {
    this.cache.clear()
    this.failed.clear()`,
    to: `  reset() {
    this.cache.clear()`,
    why: 'the failure memory is about a route; keeping it across a model change keeps a working route suppressed for a minute by a route that was removed',
  },

  // ---------------------------------------------------------------------
  // The wire: the one read that spends money
  // ---------------------------------------------------------------------
  {
    file: api,
    suites: wire,
    label: 'a POST to the paid read is accepted',
    from: `        if (req.method !== 'GET' && req.method !== 'HEAD') {`,
    to: '        if (false) {',
    why: 'the shared method gate lets POST through because most routes take a body; here a POST buys a set of chips for a caller that is not a composer',
  },
  {
    file: api,
    suites: wire,
    label: 'a HEAD probe pays for an answer',
    from: '        if (headOnly === true) return json(res, 200, { ok: true, data: { enabled: true, items: [] } }, true)',
    to: '        if (false) return json(res, 200, { ok: true, data: { enabled: true, items: [] } }, true)',
    why: 'a health check with HEAD would then cost a model call, and a probe is exactly what something does repeatedly',
  },
  {
    file: api,
    suites: wire,
    label: 'a request with no session is answered',
    from: "        if (typeof agentId !== 'string' || agentId.length === 0) {\n          return json(res, 400, { ok: false, code: 'error.agent.missing', error: 'the suggestions route needs a session id' }, headOnly)",
    to: "        if (false) {\n          return json(res, 400, { ok: false, code: 'error.agent.missing', error: 'the suggestions route needs a session id' }, headOnly)",
    why: 'without it the route calls `viewOf` with an empty id, which answers a transcript-free view and then buys a generic suggestion for no conversation',
  },
  {
    file: api,
    suites: wire,
    label: 'a panel without a suggestor answers nothing at all',
    from: `          return json(res, 200, { ok: true, data: { enabled: false, items: [], reason: 'this panel does not suggest' } }, headOnly)`,
    to: `          return json(res, 200, { ok: true, data: { enabled: true, items: [], reason: 'this panel does not suggest' } }, headOnly)`,
    why: '"off" has to be readable as off: a 404 leaves the composer retrying and unable to tell a disabled panel from a missing one',
  },
  {
    file: api,
    suites: wire,
    label: 'the suggestion route asks a model about no session',
    from: '        const answer = await deps.suggestor.suggestions({ agentId, view, sessionRoute })',
    to: '        const answer = await deps.suggestor.suggestions({ agentId: \'\', view, sessionRoute })',
    why: 'the cache key is prefixed with the session id, so an empty prefix collides every conversation into one entry and serves one session answers about another',
  },

  // ---------------------------------------------------------------------
  // The two surfaces
  // ---------------------------------------------------------------------
  {
    file: client,
    suites: view,
    label: 'the client gives up before the server does',
    from: '    const SUGGEST_REQUEST_MS = 25000',
    to: '    const SUGGEST_REQUEST_MS = 5000',
    why: 'a client deadline shorter than the server one cancels the request mid-flight, so the answer is bought and nobody reads it — and the abort is not a failure, so the next frame buys it again',
  },
  {
    label: 'the row is drawn while the page says a turn is running',
    file: client,
    suites: view,
    from: `        suggest.busy === false &&
        // Two signals for one fact: this one is read off the page and arrives
        // within half a second, where the server's answer takes seconds and
        // lands after the reader has already seen the row it was meant to hide.
        suggest.running === false &&`,
    to: `        suggest.busy === false &&`,
    why: 'the server cannot answer fast enough to be the only signal: measured on the live host the route took 3125 ms and 5017 ms during a turn, so the row stayed drawn for seconds after the reader had sent a message, and one of those answers carried no busy flag at all',
  },
  {
    label: 'the ghost is drawn while the page says a turn is running',
    file: client,
    suites: view,
    from: `        suggest.busy === false &&
        suggest.running === false &&`,
    to: `        suggest.busy === false &&`,
    why: 'the ghost sits in the box the reader may be about to interrupt, so leaving it up over a running turn reads as an instruction to type the next prompt now',
  },
  {
    label: 'the page is never watched for the control changing',
    file: client,
    suites: view,
    from: `      runningWatch = new MutationObserver(read)
      runningWatch.observe(document.documentElement, {`,
    to: `      runningWatch = new MutationObserver(read)
      void 0; void ({`,
    why: 'without the observer the page signal is read once at mount and never again, which is the state the live host shipped in: the row hid only if the turn happened to be running when the slot first rendered',
  },
  {
    file: client,
    suites: view,
    label: 'the row is drawn under every turn in the conversation',
    from: `        offer.length > 0 &&
        box !== null &&
        box.last === true`,
    to: `        offer.length > 0 &&
        true`,
    why: 'the seat is one-per-turn, so without the tail check the same three offers are drawn under every turn in the transcript -- each one a list of steps for a turn it did not describe',
  },
  {
    file: client,
    suites: view,
    label: 'the newest tail is never identified, so the row is drawn nowhere',
    from: '          const last = tails === null || tails.length === 0 || tails[tails.length - 1] === mine',
    to: '          const last = tails === null || tails.length === 0',
    why: 'the offers describe the step after the newest finished turn; a row that cannot tell which tail it is in either draws under all of them or, as here, under none of the ones that matter',
  },
  {
    file: client,
    suites: view,
    label: 'the row is not measured against the composer',
    from: "        style:\n          box === null || box.left === null ? undefined : { marginLeft: `${box.left}px`, width: `${box.width}px` },",
    to: '        style: undefined,',
    why: 'the transcript column is inset from the composer, so an unmeasured row starts 16px right of the box it is supposed to continue; the width and the left edge have to come from the composer, not from the column',
  },
  {
    file: client,
    suites: view,
    label: 'the row is measured against itself, so the margin chases its own rect',
    from: '          const left = Math.round(target.left - outer.left)',
    to: '          const left = Math.round(target.left - node.getBoundingClientRect().left)',
    why: 'marginLeft moves the very rect being read, so measuring the row instead of its parent turns one measurement into a loop: 16 in, 0 out, 16 in again until React refuses with "Maximum update depth exceeded"',
  },
  {
    file: client,
    suites: view,
    label: 'the ghost is painted under the editor it covers',
    from: '.dsse-ghost{position:absolute;display:flex;align-items:baseline;gap:6px;max-width:100%;pointer-events:none;z-index:4;',
    to: '.dsse-ghost{position:absolute;display:flex;align-items:baseline;gap:6px;max-width:100%;pointer-events:none;',
    why: 'the host scroll box is position:relative with z-index 2 and its button row has 3, while the overlay anchor this slot renders into has z-index auto: an unlayered absolute child paints underneath the editor sitting on the very coordinates it occupies, so the ghost is present, measured, and invisible',
  },
  {
    file: client,
    suites: view,
    label: 'the row gives up when its nearest wrapper has no box',
    from: `          let outer = null
          for (let up = node.parentElement; up !== null; up = up.parentElement) {`,
    to: `          let outer = null
          for (let up = node.parentElement; up !== null; up = null) {`,
    why: 'the host wraps every slot entry in div[data-slot]{display:contents}, which generates no box at all, so stopping at the nearest parent reads 0x0 and returns before box is ever set -- the row then never draws on the real host while a fake parent with a real width passes',
  },
  {
    file: client,
    suites: view,
    label: 'the return mark is left off the offer',
    from: '                    className: "dsse-suggest-enter",',
    to: '                    className: "dsse-suggest-enter-gone",',
    why: 'the mark is the only thing that says "Enter would send this"; without it the row is three sentences that look like a summary rather than three choices',
  },
  {
    file: client,
    suites: view,
    label: 'the ghost is drawn over a draft',
    from: `        gates.idle &&
        gates.empty &&
        gates.bare`,
    to: '        gates.idle',
    why: 'a ghost line under text someone is typing is not a suggestion, it is a collision; and with an attachment pending the box is not empty of intent either',
  },
  {
    file: client,
    suites: view,
    label: 'Tab no longer seeds the draft',
    from: '          const tab = event.key === "Tab" && event.shiftKey !== true',
    to: '          const tab = false',
    why: 'this is the whole second surface: the documented gesture, on the documented key, and the only path from the offer into the editor without sending',
  },
  {
    file: client,
    suites: view,
    label: 'the right arrow no longer seeds the draft',
    from: '          const arrow = event.key === "ArrowRight" && event.shiftKey !== true',
    to: '          const arrow = false',
    why: 'Qoder documents both keys and a reader coming from there will press the one they learned first',
  },
  {
    file: client,
    suites: view,
    label: 'shift+Tab is taken as an insertion',
    from: '          const tab = event.key === "Tab" && event.shiftKey !== true',
    to: '          const tab = event.key === "Tab"',
    why: 'shift+Tab is the host keystroke for moving focus backwards; swallowing it traps a keyboard user inside the composer',
  },
  {
    file: client,
    suites: view,
    label: 'the listener does not capture, so the editor eats the key',
    from: '        card.addEventListener("keydown", onKeyDown, true)',
    to: '        card.addEventListener("keydown", onKeyDown)',
    why: 'the Lexical editor underneath owns Tab for indentation and handles it first; without the capture phase the gesture never reaches this handler',
  },
  {
    file: client,
    suites: view,
    label: 'the key is not prevented, so Tab also indents',
    from: `          event.preventDefault()
          event.stopPropagation()`,
    to: '          event.stopPropagation()',
    why: 'without the prevent, one press both seeds the draft and inserts a tab character or moves focus, which is the double action this handler exists to prevent',
  },
  {
    file: client,
    suites: view,
    label: 'a click on a busy composer writes the draft it cannot send',
    from: `                onClick: () => {
                  if (armed) sendSuggestion(props?.inputActions, item.text)
                },`,
    to: `                onClick: () => {
                  sendSuggestion(props?.inputActions, item.text)
                },`,
    why: 'sendSuggestion seeds the draft first and submits on a microtask, so a click the machine will refuse still replaces whatever the reader had typed with a prompt that was never sent',
  },
  {
    file: client,
    suites: view,
    label: 'a chip is armed while the composer holds a draft',
    from: '      const armed = gates.idle === true && gates.empty === true',
    to: '      const armed = gates.idle === true',
    why: 'a non-empty draft is somebody half-written sentence; a chip that fires over it destroys their typing, and the ghost refuses on exactly this condition',
  },
  {
    file: client,
    suites: view,
    label: 'the send happens in the same tick as the seed',
    from: '      queueMicrotask(() => {',
    to: '      ;(() => {',
    why: '`submit()` reads the published input snapshot rather than the editor, so a synchronous send posts whatever was in the box before the seed — an empty message, or the previous draft',
  },
  {
    file: client,
    suites: view,
    label: 'the host placeholder is not masked',
    from: '        placeholder.setAttribute("data-dsse-ghosted", shown ? "true" : "false")',
    to: '        placeholder.setAttribute("data-dsse-ghosted", "false")',
    why: 'two lines of grey text land on the same coordinates, so the offer and the host placeholder are drawn on top of each other and neither is readable',
  },
  {
    file: client,
    suites: view,
    label: 'the ghost claims to be shown when it is not',
    from: '      const drawn = shown === true && place !== null',
    to: '      const drawn = shown === true',
    why: 'an element reporting itself shown while its inline style says visibility:hidden is a lie, and the case that produces it — no placeholder to measure against — is exactly the one a reader calls a bug',
  },
  {
    file: client,
    suites: view,
    label: 'the second surface buys the answer again',
    from: '      if (suggest.sessionId === sessionId && suggest.loaded === true) return undefined',
    to: '      if (false) return undefined',
    why: 'the chips and the ghost mount independently; without reading the shared store first, one session buys the same answer twice on every load',
  },
  {
    file: client,
    suites: view,
    label: 'a failed load blanks the offer',
    from: '        if (suggest.sessionId === sessionId) suggest.reason = error instanceof Error ? error.message : String(error)',
    to: '        if (suggest.sessionId === sessionId) { suggest.items = []; suggest.reason = error instanceof Error ? error.message : String(error) }',
    why: 'a single failed request would take the row away until the next stream frame, and the reason is something the person can do nothing about while the previous answer was still valid',
  },
  {
    file: client,
    suites: view,
    label: 'every turn tail opens its own stream',
    from: `      React.useEffect(() => {
        watchRunning()
        watchVisibility()
        ensureSuggest(sessionId)
      }, [sessionId])`,
    to: "      React.useEffect(() => {\n        if (typeof EventSource === 'function') {\n          new EventSource(resolveUrl(`/api/ui-evolve/events?agent=${encodeURIComponent(sessionId)}`))\n        }\n        ensureSuggest(sessionId)\n      }, [sessionId])",
    why: 'a turn tail is mounted once per turn, so a stream here is one per turn; at six the browser per-origin cap against the local host is spent and the host own requests queue behind them',
  },
  {
    file: client,
    suites: view,
    label: 'the stream is never closed on a fatal error',
    from: `        opened.addEventListener("error", () => {
          if (opened.readyState === 2) opened.close()
        })`,
    to: `        opened.addEventListener("error", () => {
          if (false) opened.close()
        })`,
    why: 'a route that a dispose removed leaves EventSource reconnecting forever; closing on CLOSED is what stops the retry storm and lets the slow timer take over',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a marker quoted inside a turn closes the data block',
    from: "${SESSION_OPEN}\\n${defuseMarkers(body, 'session')}",
    to:   "${SESSION_OPEN}\\n${body}",
    why: 'a turn that echoes a log line or a file containing the closing marker ends the block early, and the rest of the transcript is then read as instructions the guard above only promised to fence off',
  },
  {
    file: client,
    suites: view,
    label: 'a stale answer is drawn as the next step anyway',
    from: '        suggest.stale === false &&',
    to: '        true &&',
    why: 'past its window the answer no longer speaks for the turn in front of the reader; without this the row is a claim about work that is finished, which is the shape the reader reported as "old suggestions under the new answer"',
  },
  {
    file: client,
    suites: view,
    label: 'a turn boundary leaves the old answer on screen',
    from: '    function forgetOffer() {',
    to: '    function forgetOffer() {\n      return',
    why: 'the answer describes the turn before the one that just finished, so keeping it draws the previous turn chips under the new answer -- the reader saw this as the suggestions still being the last turn until the new ones arrive',
  },
  {
    file: client,
    suites: view,
    label: 'an unfocused window coming back is never noticed',
    from: '        window.addEventListener("focus", refreshOnReturn)',
    to: '        void 0',
    why: 'a desktop window covered by another application may never report `document.hidden`, so `visibilitychange` alone watches for a return that is never announced; the reader whose offer only appeared after switching sessions was in exactly that window',
  },
  {
    file: client,
    suites: view,
    label: 'one return is reported twice and buys twice',
    from: '        if (at - lastReturn < RETURN_QUIET_MS) return',
    to: '        if (false) return',
    why: 'the page and the window both report the same return, so without the echo window every return spends two identical requests on an answer that cannot have changed between them',
  },
  {
    file: client,
    suites: view,
    label: 'coming back to the page does not ask again',
    from: '        if (suggest.sessionId === "") return\n        void loadSuggest(suggest.sessionId)',
    to: '        void 0',
    why: 'a turn spent in the background leaves the store holding whatever the last frame said; without this the only way to see the offer was to switch sessions and come back, which is exactly the workaround the reader described',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the persisted sentence is never offered again',
    from: '    if (remembered !== undefined && remembered.turn === turn) {',
    to: '    if (false) {',
    why: 'the stored sentence is the whole point of persisting it: without reading it back, a restart opens with an empty composer and buys the same answer a second time for the same turn',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a restore about an older turn is offered anyway',
    from: '    if (remembered !== undefined && remembered.turn === turn) {',
    to: '    if (remembered !== undefined) {',
    why: 'a sentence about turn four drawn at turn nine is a claim about work that is finished; the turn check is what makes the restored line safe to show at all',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the sentence is never written down',
    from: "      if (typeof this.persist === 'function') this.persist(agent, { text: items[0], at, turn })",
    to: "      if (false) this.persist(agent, { text: items[0], at, turn })",
    why: 'an offer that only exists in the memory of the process that paid for it is not persisted at all: the ghost arrives in the composer only if a later process can read it back',
  },
  {
    file: client,
    suites: view,
    label: 'a chip that was already taken is drawn again',
    from: '      const offer = suggest.items.filter((item) => suggest.used.has(item.text) === false)',
    to: '      const offer = suggest.items.slice()',
    why: 'the row hides itself while a turn is in flight and comes back when the machine settles, so the sentence that was just sent is offered again and one click is worth two sends',
  },
  {
    file: client,
    suites: view,
    label: 'the send does not retire the chip it sent',
    from: `      suggest.used.add(text)
      notifySuggest()`,
    to: '      void 0',
    why: 'the same retirement from the other end: the gate filters on `used`, and a set that is never written gives the gate nothing to filter',
  },
  {
    file: client,
    suites: view,
    label: 'a new answer keeps the old retirements',
    from: '        if (stamp !== suggest.at) suggest.used.clear()',
    to: '        void 0',
    why: 'a suggestion retired under one answer is not retired under the next: the model may make the same point about a different turn, and never offering it again makes the feature shrink as the session runs',
  },
  {
    file: client,
    suites: view,
    label: 'a replayed answer brings a spent chip back',
    from: '        if (stamp !== suggest.at) suggest.used.clear()',
    to: '        suggest.used.clear()',
    why: 'the server answers a frame during a turn from its cache with the same items and the same at, so a read is not evidence that anything was re-bought: clearing on every read puts the chip the reader just clicked back on the row when the turn ends, and one click sends the same prompt twice',
  },
  {
    file: client,
    suites: view,
    label: 'a frame that arrives during a read is dropped',
    from: '        if (coalesce === false) suggest.again = true',
    to: '        void 0',
    why: 'the answer already on its way describes the turn before the one that just ended; swallowing the frame leaves the row describing a finished turn until the next one',
  },
  {
    file: client,
    suites: view,
    label: 'the input hook is called without a selector',
    from: '      return hook((state) => state)',
    to: '      return hook()',
    why: 'the host builds every provided use<Name> on useSyncExternalStoreWithSelector, so its first argument is a selector and calling it bare throws inside the slot error boundary, where nothing outside can see it: both surfaces go silently missing on a real host while a stub that ignores its argument keeps the suite green (DEF-197)',
  },
  {
    file: client,
    suites: view,
    label: 'an empty answer is never retried',
    from: '        if (suggest.items.length === 0 && suggest.enabled === true && suggest.retried === false && suggest.busy === false) {',
    to: '        if (false) {',
    why: 'the frame that arrives as a turn ends can be answered from a transcript that is still settling, and the route then reports nothing to go on; without the retry the row stays empty for the whole next turn and the feature looks broken (DEF-202)',
  },
  {
    file: client,
    suites: view,
    label: 'an empty answer becomes a poll',
    from: '          suggest.retried = true',
    to: '          void 0',
    why: 'one retry covers the settlement race; without the latch every empty answer arms another timer, and a session that genuinely has nothing to offer keeps buying calls past the server one-minute failure memory',
  },
  // ---------------------------------------------------------------------
  // The excerpt: a cut that says nothing is read as an interruption
  //
  // On the live host the model saw an excerpt that stopped mid-sentence and
  // proposed "finish the truncated second half of the answer" as the next step.
  // That suggestion describes our prompt budget, not the work, and it is the
  // most visible way this feature can be wrong. Four anchors: the snapshot mark,
  // the boundary the cut lands on, the prompt mark, and the instruction.
  // ---------------------------------------------------------------------
  {
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    label: 'the snapshot cuts the reply without saying so',
    from: '      said: excerptOf(this.said.join(\'\\n\\n\'), MAX_SAID_EXCERPT, SAID_CUT_MARK),',
    to: '      said: this.said.join(\'\\n\\n\').slice(0, MAX_SAID_EXCERPT),',
    why: 'a bare slice ends mid-sentence, and a reader of an unfinished sentence proposes finishing it -- this is the exact regression the mark was added for, and it is invisible to any assertion that only checks the length',
  },
  {
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    label: 'a question read from blocks is cut without saying so',
    from: "  return excerptOf(parts.join('\\n\\n'), MAX_ASKED_CHARS, ASKED_CUT_MARK)",
    to: "  return parts.join('\\n\\n').slice(0, MAX_ASKED_CHARS)",
    why: 'the same clip exists on two paths -- a plain string and an array of text blocks -- and a fix applied to one of them leaves the other silent',
  },
  {
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    label: 'the question is cut without saying so',
    from: "    this.asked = typeof asked === 'string' ? excerptOf(asked, MAX_ASKED_CHARS, ASKED_CUT_MARK) : ''",
    to: "    this.asked = typeof asked === 'string' ? Array.from(asked).slice(0, MAX_ASKED_CHARS).join('') : ''",
    why: 'the assistant half has carried a mark since DEF-206 and the user half did not, so a request over 600 characters reached both prompts ending mid-word with nothing to say so (DEF-209)',
  },
  {
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    label: 'the cut lands mid-word instead of on a boundary',
    from: '  const at = para > budget / 2 ? para : stop > budget / 2 ? stop + 1 : window.length',
    to: '  const at = window.length',
    why: 'the boundary preference is the difference between an excerpt and a truncation; without it the last thing the model reads is half a word, which reads as a broken stream rather than a long reply',
  },
  {
    file: transcript,
    suites: transcriptSuite,
    label: 'only a period ends a sentence, not a question or an exclamation',
    from: 'const SENTENCE_END = /[。！？]|[.!?](?=\\s)/g',
    to: 'const SENTENCE_END = /[。！？]|\\. /g',
    why: 'a reply that ends a sentence with ? or ! is ordinary; falling back to the raw budget cuts inside the next word, which is the reading this whole round exists to avoid',
  },
  {
    file: summarise,
    suites: ['test/summarise.test.mjs'],
    label: 'the prompt cuts the transcript without saying so',
    from: '  return excerptOf(lines.join(\'\\n\\n\'), limit, INPUT_CUT_MARK)',
    to: '  return lines.join(\'\\n\\n\').slice(0, limit)',
    why: 'the snapshot mark only covers the assistant prose; the assembled body is cut again on its own budget, so the same inference comes back through a different layer unless both are marked',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the instruction lets the model finish a cut answer',
    from: `  '- The report may end with a note saying it was cut for length. A sentence that',
  '  stops, or that note, is our budget rather than an unfinished task. Never',
  '  propose finishing, completing or restating an earlier answer: a chip that',
  '  says so is describing the prompt, not the work.',`,
    to: "  '- Read the report below.',",
    why: 'the mark in the text says the excerpt was cut; this rule says what to do about it. A model that is told the text is short but not told to ignore that will still propose completing it, which is what the live host showed',
  },
  {
    file: client,
    suites: view,
    label: 'the model picker names only the summary again',
    from: "                        jsx('span', { className: 'dsse-setting-label', children: '摘要与建议模型' }),",
    to: "                        jsx('span', { className: 'dsse-setting-label', children: '总结模型' }),",
    why: 'one pair of keys serves two paid calls, so a label naming only the summary tells the reader that changing it affects one feature when it changes two',
  },
  {
    file: client,
    suites: view,
    label: 'the note stops saying the two features share a model',
    from: "                        jsx('span', { className: 'dsse-setting-desc', children: '两处共用一个模型：面板摘要与下一轮建议。默认沿用当前会话已验证的路由。' }),",
    to: "                        jsx('span', { className: 'dsse-setting-desc', children: '默认沿用当前会话已验证的路由。' }),",
    why: 'the label can only name two features in a few characters; the sentence under it is where a reader learns the picker changes both, and it is the only place that says so',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the instruction leaves a fresh topic as the first idea',
    from: `  '- Build on the latest request and on the report of the last turn. The earlier',
  '  requests are background: they say what this session has been doing, they',
  '  are not the thing to answer.',`,
    to: "  '- Propose whatever seems useful next.',",
    why: 'the reader asked for offers that continue the work in front of them; a prompt that does not rank working on the turn above opening a new topic produces chips about work nobody asked for',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a question becomes a chip',
    from: '  if (QUESTION_OR_SHOUT.test(text)) return true',
    to: '  if (false) return true',
    why: 'a chip is a step the reader can send; a question or an exclamation is the assistant replying to them, and clicking it sends a question back to the model as if they had asked it',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the period stays on the chip',
    from: "  return text.replace(TRAILING_TERMINATOR, '').trim()",
    to: '  return text.trim()',
    why: 'nobody types a closing period into a prompt box; keeping it is the cheapest tell that the text was written as prose and pasted into the composer',
  },
  {
    file: suggest,
    suites: engine,
    label: 'two sentences are offered as one step',
    from: '  return INNER_SENTENCE_END.test(bare)',
    to: '  return false',
    why: 'a second sentence end inside the candidate means the model wrote prose, and prose is what the reader objected to; the trailing period alone is stripped rather than rejected, so this is the only rule that still rejects',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the assistant may narrate the next step',
    from: '  if (ASSISTANT_VOICE.test(bare) || ASSISTANT_VOICE_CJK.test(bare)) return true',
    to: '  if (false) return true',
    why: 'matching only the English list would leave the Chinese first person (我来 / 我会) in place, which is the whole reason the two lists exist separately',
  },
  {
    file: suggest,
    suites: engine,
    label: 'an evaluative reply becomes a chip',
    from: '  if (EVALUATIVE.test(bare)) return true',
    to: '  if (false) return true',
    why: '"looks good" is a reaction to the turn, not a request for more work, and a chip that sends it spends a turn to say nothing',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a model saying it has nothing becomes a chip',
    from: '  if (NOT_AN_ANSWER.test(bare)) return true',
    to: '  if (false) return true',
    why: 'a model with nothing to suggest writes one of these words instead of an empty array, and a chip reading "no suggestion" is worse than no chip at all',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the voice lists are matched against the text with its period still on',
    from: '  const bare = stripTerminator(text)',
    to: '  const bare = text',
    why: 'four of the five lists are anchored at the end of the string, so a candidate that closes its sentence politely defeats every one of them at once -- "Done.", "No suggestion." and "Looks good." all came back as chips',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a bang anywhere counts as a shout',
    from: 'const QUESTION_OR_SHOUT = /[?？！!](?=\\s|$)/',
    to: 'const QUESTION_OR_SHOUT = /[?？！!]/',
    why: 'without the lookahead every chip naming `!=`, `!important` or `?.` is dropped, and since a row needs two items the whole offer disappears rather than shrinking',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the effort id is looked up with a key that never matches',
    from: '    const exact = byId.get(wanted)',
    to: "    const exact = byId.get('nothing')",
    why: 'this is the shape of the original defect: a lookup that quietly returns undefined leaves every suggestion call at the model default effort, which is how a reasoning model came to spend its whole output budget thinking',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a small effort is preferred to an off switch',
    from: '  for (const wanted of DISABLE_EFFORTS) {',
    to: "  for (const wanted of ['minimal', 'disable', 'disabled', 'off', 'none']) {",
    why: 'the order is the requirement: any truthy effort is what the adapter reads as thinking ON, so asking for a small one instead of none is the difference between 221 ms and 12.6 s',
  },
  {
    file: suggest,
    suites: engine,
    label: "the model's own spelling of the effort is not used",
    from: '    if (exact !== undefined) return { ...relaxed, reasoningEffort: exact }',
    to: '    if (exact !== undefined) return { ...relaxed, reasoningEffort: wanted }',
    why: 'the host compares the requested id against the menu exactly and throws INVALID_MODEL_REASONING otherwise, so a list spelled "Disabled" has to be asked for as "Disabled"',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the instruction lets one chip carry two actions',
    from: `  '- ONE action per suggestion. Never join a second one with a comma, "and then",',
  '  "，", "并" or "然后". "Fix the cursor test, then explain the timing" is two',
  '  suggestions wearing one coat, and the reader cannot click half of it.',`,
    to: "  '- Propose one thing.',",
    why: 'the prompt is where the model decides whether to join two actions; the post-processing rule in firstAction cuts at the first verb, so a model that ignores this produces chips that silently lose their second half',
  },
  {
    file: suggest,
    suites: engine,
    label: 'an effort the resolver already chose is left in place',
    from: '  const relaxed = { ...controls }\n  delete relaxed.reasoningEffort',
    to: '  const relaxed = { ...controls }',
    why: 'this is the whole switch: a falsy effort is what the deepseek compat branch turns into thinking disabled, so leaving the resolved effort in place keeps thinking on and puts the 12-31 s back',
  },
  {
    file: suggest,
    suites: engine,
        label: 'an effort id the model never offered is invented',
    from: '  return relaxed\n}',
    to: "  return { ...relaxed, reasoningEffort: 'low' }\n}",
    why: 'the host validates the requested id against the menu it handed over and throws INVALID_MODEL_REASONING otherwise, so the fallback has to leave the request alone rather than guess',
  },

  // ---------------------------------------------------------------------
  // The three regions of the prompt, and the model's right to say nothing
  // ---------------------------------------------------------------------
  {
    file: suggest,
    suites: engine,
    label: 'the earlier requests are never quoted',
    from: '  if (earlier.length > 0) {',
    to: '  if (false) {',
    why: 'a follow-up like "good, now the other one" is only answerable if the model can see what the other ones were; without this region every offer is built from one request with no idea what the session has been doing',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the newest request is called the oldest',
    from: "    ? previous.asks.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)",
    to: "    ? previous.asks.slice().reverse().filter((entry) => typeof entry === 'string' && entry.trim().length > 0)",
    why: 'the section says oldest first because a conversation reads that way; reversed, the model reads the history backwards and treats the oldest request as the most recent thing that happened',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a refusal becomes a chip',
    from: '  if (REFUSAL.test(bare)) return true',
    to: '  if (false) return true',
    why: 'with one-chip answers allowed, "I cannot help with that" is no longer thrown away by a two-chip minimum: it has to be refused by a rule, or the row offers the reader the model declining',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the model is not allowed to decline',
    from: 'export const MIN_SUGGESTIONS = 1',
    to: 'export const MIN_SUGGESTIONS = 2',
    why: 'a model that is sure of one thing has to be able to say one thing; a floor of two makes it invent a second chip, which is the guessing the prompt asks it to avoid',
  },
  {
    file: transcript,
    suites: transcriptSuite,
    label: 'the store forgets that the last turn was interrupted',
    from: '      this.interrupted = true',
    to: '      this.interrupted = false',
    why: 'the offer route asks this flag instead of guessing from the previous turn, and an abandoned turn writes none -- without the flag the row describes the turn before the one on screen',
  },
  {
    file: transcript,
    suites: transcriptSuite,
    label: 'the view never reports an interrupted turn',
    from: '      interrupted: transcript.interrupted,',
    to: '      interrupted: false,',
    why: 'the flag is only useful if it reaches the reader; a view that hides it turns the whole gate into dead code that still passes every test written against the store',
  },
  {
    file: transcript,
    suites: transcriptSuite,
    label: 'a finished turn leaves the interrupted flag standing',
    from: '    this.interrupted = false\n    this.previous = this.snapshot()',
    to: '    this.previous = this.snapshot()',
    why: 'one interruption would silence every later offer in the session, because nothing else clears it -- the flag describes the last close, not the session',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the finish reason is only read when it is a string',
    from: "      const finishKind = typeof finish === 'string' ? finish : (finish?.kind ?? '')",
    to: "      const finishKind = typeof finish === 'string' ? finish : ''",
    why: 'the host streams an object, so this makes the truncation branch unreachable on the live host: a call that spent its whole budget thinking reads as a model that said nothing, and the failure is remembered as a normal empty answer',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a positive effort survives into the call',
    from: "      if (typeof chosen === 'string' && DISABLE_EFFORTS.includes(chosen.toLowerCase()) === false) {",
    to: '      if (false) {',
    why: 'a truthy effort is thinking on, whatever it is called, and the host may settle on one after the controls callback -- leaving it here means every suggestion call thinks first, which on a 700 token budget can leave nothing at all',
  },
  {
    file: suggest,
    suites: engine,
    label: 'an interrupted turn is offered the previous turn anyway',
    from: '    if (view?.interrupted === true) {',
    to: '    if (false) {',
    why: 'this is the defect the gate exists for: the row would sit under a reply the reader stopped, naming a next step for work that had already moved on',
  },
  {
    file: transcript,
    suites: transcriptSuite,
    label: 'a finished turn contributes no history',
    from: '    rememberEarlierAsk(this.asks, this.asked)',
    to: "    rememberEarlierAsk(this.asks, '')",
    why: 'the history is the only record of what the session has been asked, so losing it leaves every prompt with a single request and no background',
  },
  {
    file: transcript,
    suites: transcriptSuite,
    label: 'a past request is stored whole',
    from: '  list.push(excerptOf(trimmed, MAX_EARLIER_ASK_CHARS, EARLIER_CUT_MARK))',
    to: '  list.push(trimmed)',
    why: 'one pasted file in one past request would take the whole history budget, and the requests that came after it -- the ones the offer needs -- would be dropped instead',
  },
  {
    file: transcript,
    suites: transcriptSuite,
    label: 'the history is never trimmed',
    from: '  while (list.length > 1 && total > MAX_EARLIER_ASKS_CHARS) {',
    to: '  while (false) {',
    why: 'the notice says the history is bounded by characters; untrimmed it grows with the session until the prompt is mostly old requests about work that finished hours ago',
  },
  {
    file: transcript,
    suites: transcriptSuite,
    label: 'the report is the whole narration',
    from: "    report: this.said.length === 0 ? '' : this.said[this.said.length - 1],",
    to: "    report: this.said.join('\\n\\n'),",
    why: 'the reader asked for the paragraph the turn finished on, and that paragraph is the one that states the result; joining the narration sends the whole essay and buries it',
  },
  {
    file: transcript,
    suites: transcriptSuite,
    label: 'an abandoned turn is folded as if it finished',
    from: "    if (data?.reason?.kind !== undefined && data.reason.kind !== 'completed') {",
    to: '    if (false) {',
    why: 'a turn the host abandoned never reached a conclusion, so its question and its half-finished narration describe a plan that was not carried out; folded anyway, the offer is built on work that does not exist',
  },

  {
    file: suggest,
    suites: engine,
    label: 'a sentence about what was just done becomes a chip',
    from: '  if (NARRATED_DONE.test(bare)) return true',
    to: '  if (false) return true',
    why: 'the sampler came back with a narration of the turn it had just read and that narration rendered as the next step',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the Chinese past tense is not recognised',
    from: 'const NARRATED_DONE = /^(?:已|内容已|现已|',
    to: 'const NARRATED_DONE = /^(?:',
    why: 'every narration in the live sample was Chinese, so dropping the Chinese side leaves the English side passing its own tests',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the rejected line is not reported',
    from: '${text.length} characters, first: ${JSON.stringify(sample)}',
    to: '${text.length} characters',
    why: 'a live miss has to be readable without a debugger; without the sample the reason cannot tell prose from a refusal',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the same rename is offered twice',
    from: '    if (items.some((kept) => sameOffer(kept, text))) continue',
    to: '    if (false) continue',
    why: 'the reader gets two chips for one decision and cannot tell which to press',
  },
  {
    file: suggest,
    suites: engine,
    label: 'a rename of another file is folded into the first',
    from: '  if (target.length === 0 || target !== trailingTarget(b)) return false',
    to: '  if (target.length === 0) return false',
    why: 'two files, two renames, one chip: the target is the only thing telling them apart',
  },
]

// Baseline first: a workspace that already fails turns every mutation into a
// false KILLED, because "the suite has failures after the mutation" is then true
// before the mutation as well.
{
  const suites = [...new Set(mutations.flatMap((mutation) => mutation.suites))]
  const before = run(suites)
  if (before !== 0) {
    console.log('\nBASELINE FAILED — the suites must pass before mutations mean anything')
    console.log('  ' + suites.join(', ') + ' reported ' + (before < 0 ? 'no tally line' : before + ' failed') + ' before any mutation')
    process.exit(1)
  }
}

let killed = 0
const survived = []
const notApplied = []
const crashed = []
const backups = new Map()

// Lines a mutation could target and no assertion would notice, printed with the
// run so a later reader knows the list is complete rather than merely green.
const known = [
  'the two `order:` values on the slot registrations are not mutated: they decide which row sits nearest the composer, and `test/client.test.mjs` asserts the registration shape rather than the drawing order it feeds',
  'the CSS block is not mutated: `test/tokens.test.mjs` already fails on an invented token, and a colour is not a behaviour',
  '`suggestGates` is exercised through both surfaces rather than directly, so its three fields are mutated where they are read',
  'the floor of one is not mutated to zero: `return items.length >= MIN_SUGGESTIONS ? items : []` and `return items` differ only when the list is empty, and an empty list survives either way. Before the floor became a floor of one the two differed on every single answer, which is why this anchor read as a live one. A guarded passthrough is not a behaviour once the guard is always true.',
  "`excerptOf`'s ASCII lookahead is not mutated to `(?=\\s|$)`: `$` can only add one match, at the very last character of the window, and there `stop + 1` is exactly `window.length` -- the same cut the hard fallback makes. The mutant is equivalent, not surviving. `suggest.js` carries the same rule and the same note.",
]

try {
  for (const mutation of mutations) {
    if (backups.has(mutation.file) === false) backups.set(mutation.file, fs.readFileSync(mutation.file, 'utf8'))
    const original = backups.get(mutation.file)
    if (original.includes(mutation.from) === false) {
      notApplied.push(mutation.label)
      console.log(`NOT APPLIED  ${mutation.label}`)
      continue
    }
    if (original.split(mutation.from).length - 1 !== 1) {
      notApplied.push(mutation.label)
      console.log(`NOT APPLIED  ${mutation.label} — anchor is not unique`)
      continue
    }
    const mutated = original.split(mutation.from).join(mutation.to)
    try {
      writeWithRetry(mutation.file, mutated)
      const failed = run(mutation.suites)
      if (failed > 0) {
        killed += 1
        console.log(`KILLED      ${mutation.label} — ${failed} failed`)
      } else if (failed === 0) {
        survived.push(mutation.label)
        console.log(`SURVIVED    ${mutation.label}`)
      } else {
        crashed.push(mutation.label)
        console.log(`CRASHED     ${mutation.label}`)
      }
    } finally {
      writeWithRetry(mutation.file, original)
      if (fs.readFileSync(mutation.file, 'utf8') !== original) {
        crashed.push(`${mutation.label} (file was not restored)`)
        console.log(`CRASHED     ${mutation.label} (file was not restored)`)
      }
    }
  }
} finally {
  for (const [file, backup] of backups) writeWithRetry(file, backup)
}

for (const mutation of mutations) {
  if (survived.includes(mutation.label)) console.log(`\nUNCOVERED  ${mutation.label}\n  ${mutation.why}`)
  if (crashed.includes(mutation.label)) console.log(`\nCRASHED    ${mutation.label}\n  ${mutation.why}`)
}

for (const line of known) console.log(`\nNOT MUTATED  ${line}`)

const total = mutations.length
console.log(`\n${killed} killed, ${survived.length} survived, ${notApplied.length} not applied, ${crashed.length} crashed  (of ${total})`)
if (survived.length > 0 || notApplied.length > 0 || crashed.length > 0) process.exit(1)
