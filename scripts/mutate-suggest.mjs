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

const engine = ['test/suggest.test.mjs']
const wire = ['test/api.test.mjs']
const view = ['test/client.test.mjs']

const mutations = [
  // ---------------------------------------------------------------------
  // The prompt: what the model is allowed to see
  // ---------------------------------------------------------------------
  {
    file: suggest,
    suites: engine,
    label: 'the quoted turn is not clipped',
    from: 'export const MAX_TURN_INPUT_CHARS = 4000',
    to: 'export const MAX_TURN_INPUT_CHARS = 100000',
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
    from: '  return renderPromptBody(previous).slice(0, MAX_TURN_INPUT_CHARS)',
    to: '  return renderPromptBody(previous).length > MAX_TURN_INPUT_CHARS ? "" : renderPromptBody(previous)',
    why: 'dropping instead of clipping makes the row absent exactly when a turn got substantial, which is when a next step is worth most',
  },
  {
    file: suggest,
    suites: engine,
    label: 'the quote carries no markers',
    from: "const TURNS_OPEN = '<turns>'",
    to: "const TURNS_OPEN = ''",
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
    from: "      const truncated = typeof finish === 'string' && /length|max[_-]?tokens|truncat/i.test(finish)",
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
    from: 'export const MAX_SUGGESTION_CHARS = 120',
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
    label: 'one usable answer is drawn as a row',
    from: '  return items.length >= MIN_SUGGESTIONS ? items : []',
    to: '  return items',
    why: 'a row of one is a button: the composer would sit above a single suggestion with nothing to choose between, which is the shape this file refuses',
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
    label: 'the cache never expires',
    from: '    if (cached !== undefined && now - cached.at < SUGGEST_TTL_MS) {',
    to: '    if (cached !== undefined) {',
    why: 'a session resumed the next morning would open with three chips about work that has moved on; the turn number catches the common case, this catches the clock',
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
    why: 'a stream that stalls holds the route open until the socket dies; the client gives up at fifteen seconds and the answer is then paid for and dropped',
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
    from: '    const SUGGEST_REQUEST_MS = 15000',
    to: '    const SUGGEST_REQUEST_MS = 5000',
    why: 'a client deadline shorter than the server one cancels the request mid-flight, so the answer is bought and nobody reads it — and the abort is not a failure, so the next frame buys it again',
  },
  {
    file: client,
    suites: view,
    label: 'the chips are drawn during a running turn',
    from: `        offer.length > 0 &&
        gates.idle`,
    to: '        offer.length > 0',
    why: 'offering the next step while the current one is being written is the one moment the row is noise; the gate is the only thing that separates the two',
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
    from: "${TURNS_OPEN}\\n${defuseMarkers(body, 'turns')}",
    to:   "${TURNS_OPEN}\\n${body}",
    why: 'a turn that echoes a log line or a file containing the closing marker ends the block early, and the rest of the transcript is then read as instructions the guard above only promised to fence off',
  },
  {
    file: client,
    suites: view,
    label: 'an answer past its lifetime is still drawn',
    from: `      const offer = suggest.items.filter((item) => suggest.used.has(item.text) === false)
      const fresh = suggest.at === 0 || Date.now() - suggest.at < SUGGEST_MAX_AGE_MS`,
    to: `      const offer = suggest.items.filter((item) => suggest.used.has(item.text) === false)
      const fresh = true`,
    why: 'a failed refresh keeps the last answer on purpose; without the age rule the offer for turn N is still on screen an hour and ten turns later, describing work that is finished',
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
      fs.writeFileSync(mutation.file, mutated, 'utf8')
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
      fs.writeFileSync(mutation.file, original, 'utf8')
      if (fs.readFileSync(mutation.file, 'utf8') !== original) {
        crashed.push(`${mutation.label} (file was not restored)`)
        console.log(`CRASHED     ${mutation.label} (file was not restored)`)
      }
    }
  }
} finally {
  for (const [file, backup] of backups) fs.writeFileSync(file, backup, 'utf8')
}

for (const mutation of mutations) {
  if (survived.includes(mutation.label)) console.log(`\nUNCOVERED  ${mutation.label}\n  ${mutation.why}`)
  if (crashed.includes(mutation.label)) console.log(`\nCRASHED    ${mutation.label}\n  ${mutation.why}`)
}

for (const line of known) console.log(`\nNOT MUTATED  ${line}`)

const total = mutations.length
console.log(`\n${killed} killed, ${survived.length} survived, ${notApplied.length} not applied, ${crashed.length} crashed  (of ${total})`)
if (survived.length > 0 || notApplied.length > 0 || crashed.length > 0) process.exit(1)
