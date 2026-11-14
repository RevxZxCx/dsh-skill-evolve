// Prove the language path and the cumulative output list are guarded.
//
// Two features landed together and they fail in the same quiet way: nothing
// throws, the panel keeps drawing, and the wrong answer looks right.
//
//   * The summary's language. A prompt that never names a language produces a
//     perfectly good summary in whatever language the model felt like, and the
//     reader — who set their interface to Chinese — has to translate it. Every
//     guard on that path is a `return undefined` for input that must not reach a
//     prompt, so breaking one changes nothing observable except the language of
//     the output.
//   * The output list. It used to describe one turn; a mutation that puts it
//     back there empties the card on a turn that wrote nothing and hides 19 of
//     20 files on a turn that re-edited one. Both look like a working panel.
//
// The two failure modes this repo's mutation scripts have been burned by are
// handled the same way every other script here handles them: an anchor that no
// longer matches is its own outcome (NOT APPLIED) rather than a survival, and a
// run with no tally line is CRASHED rather than either answer.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))

const api = path.join(repo, 'packages', 'ui-evolve', 'lib', 'api.js')
const client = path.join(repo, 'packages', 'ui-evolve', 'lib', 'client.js')
const index = path.join(repo, 'packages', 'ui-evolve', 'lib', 'index.js')
const state = path.join(repo, 'packages', 'ui-evolve', 'lib', 'session-state.js')
const summarise = path.join(repo, 'packages', 'ui-evolve', 'lib', 'summarise.js')
const transcript = path.join(repo, 'packages', 'ui-evolve', 'lib', 'transcript.js')
const report = path.join(repo, 'packages', 'ui-evolve', 'lib', 'report-tool.js')
const coverage = path.join(repo, 'packages', 'ui-evolve', 'lib', 'coverage.js')
const gitChanges = path.join(repo, 'packages', 'ui-evolve', 'lib', 'git-changes.js')
const gitWatch = path.join(repo, 'packages', 'ui-evolve', 'lib', 'git-watch.js')
const scanChanges = path.join(repo, 'packages', 'ui-evolve', 'lib', 'scan-changes.js')
const scanWatch = path.join(repo, 'packages', 'ui-evolve', 'lib', 'scan-watch.js')

/**
 * Failures reported by a suite, or -1 when it printed no tally at all.
 *
 * The tally is the only honest source: a crash prints no `FAIL` row, so counting
 * rows would call a crashed run a survival.
 */
/**
 * Write a file, retrying while the platform holds it.
 *
 * Windows returns `EBUSY`/`UNKNOWN` (`errno -4094`) when a watcher or indexer
 * has the file open for a moment. A plain `writeFileSync` throws, and the throw
 * comes from inside the `try` that restored the original file — so the mutated
 * source stayed on disk and the next run baked it in permanently. That is how a
 * crash stops being a crash and becomes a corrupted checkout. The restore path
 * matters more than the mutate path: a failed mutate is a skipped mutation, a
 * failed restore is a wrong file.
 *
 * @param {string} path - the file to write.
 * @param {string} content - the exact bytes to write.
 */
function writeWithRetry(path, content) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.writeFileSync(path, content, 'utf8')
      return
    } catch (error) {
      if (attempt === 5) throw error
      const until = Date.now() + 60 * (attempt + 1)
      while (Date.now() < until) { /* wait out the transient lock */ }
    }
  }
}

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
        timeout: 120000,
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

const mutations = [
  // ---------------------------------------------------------------------
  // The user's words reach the prompt
  // ---------------------------------------------------------------------
  //
  // These replaced a group that guarded the interface-language sentence. The
  // sentence is gone; its four cases are now covered by the assertions in
  // `test/summarise.test.mjs` that the prompt says nothing about languages at
  // all, and the mutations below are what prove those assertions bite.
  {
    file: summarise,
    label: 'the user question never reaches the prompt',
    suites: ['test/summarise.test.mjs'],
    from: '  if (asked.length > 0) lines.push(',
    to: '  if (false) lines.push(',
    why: 'the question is the one line in the prompt that carries a language the assistant did not choose, and the turn exists to answer it — a summary built only from consequences describes what happened without saying what was wanted',
  },
  {
    file: summarise,
    label: 'the question is quoted after the wrapper closes',
    suites: ['test/summarise.test.mjs'],
    from: '${TRANSCRIPT_CLOSE}` }],',
    to: '${TRANSCRIPT_CLOSE}\nWhat the user asked: none.` }],',
    why: 'a line after the closing marker sits level with the instruction, so it reads as a request rather than as the material to summarise',
  },
  {
    file: summarise,
    label: 'an empty question is announced anyway',
    suites: ['test/summarise.test.mjs'],
    from: '  if (asked.length > 0) lines.push',
    to: '  if (true) lines.push',
    why: 'an assistant-only turn would then carry a label followed by nothing, which asserts the user said nothing — a claim the code cannot make',
  },
  // ---------------------------------------------------------------------
  // The instruction names the right language source
  // ---------------------------------------------------------------------
  {
    file: summarise,
    label: 'the instruction stops pointing at the user words',
    suites: ['test/summarise.test.mjs'],
    from: "'what the user asked, not the language of the assistant text or of the',",
    to: "'the assistant text, and the commands, and nothing else at all, or of the',",
    why: 'the tool names and paths in this prompt are English whoever is reading, so a model pointed at anything but the question answers a Chinese question in English',
  },
  {
    file: summarise,
    label: 'the instruction stops forbidding a label',
    suites: ['test/summarise.test.mjs'],
    from: "'Do not write a preamble or a label such as \"Summary:\" — begin with the first',",
    to: "'Write a preamble or a label such as \"Summary:\" before the first',",
    why: 'a label costs a fifth of a three-hundred character card and says nothing; the instruction is the only place that can stop it before the cleaner has to',
  },
  // ---------------------------------------------------------------------
  // The output cleaner
  // ---------------------------------------------------------------------
  {
    file: summarise,
    label: 'a wrapping code fence is kept',
    suites: ['test/summarise.test.mjs'],
    from: '  if (fenced !== null && typeof fenced[1] === \'string\') out = fenced[2].trim()',
    to: '  if (false && fenced !== null) out = fenced[2].trim()',
    why: 'a fence inside the card is four lines of decoration around a paragraph that must fit in two',
  },
  {
    file: summarise,
    label: 'a Summary label is kept',
    suites: ['test/summarise.test.mjs'],
    from: "  out = out.replace(/^(?:Summary|Recap|摘要|总结|本轮总结)\\s*[:：]\\s*/iu, '')",
    to: "  out = out.replace(/^(?:NOTHINGMATCHES)\\s*[:：]\\s*/iu, '')",
    why: 'the instruction asks for no label and a model ships one often enough that the card would open with the word "Summary" most of the time',
  },
  {
    file: summarise,
    label: 'bold markers are kept',
    suites: ['test/summarise.test.mjs'],
    from: '  if (stars === 2) out = out.replace(/\\*\\*(?=\\S)([^\\n*]*?)(?<=\\S)\\*\\*/gu, \'$1\')',
    to: '  if (stars === 2) out = out.replace(/\\*\\*(?=\\S)([^\\n*]*?)(?<=\\S)\\*\\*/gu, \'**$1**\')',
    why: 'asterisks render as asterisks in the card, so emphasis the model intended as emphasis arrives as punctuation',
  },
  {
    file: summarise,
    label: 'the cleaner stops being applied at all',
    suites: ['test/summarise.test.mjs'],
    from: '    const trimmed = tidy(text)',
    to: '    const trimmed = text.trim().slice(0, MAX_SUMMARY_CHARS)',
    why: 'this is the whole point of the function: instructions are probabilistic, and a code path that is certain is the only place a rule can live',
  },
  {
    file: summarise,
    label: 'the cleaner eats identifiers',
    suites: ['test/summarise.test.mjs'],
    from: '  const chars = Array.from(out.trim())',
    to: '  const chars = Array.from(out.replace(/[*_`#]+/gu, \'\').trim())',
    why: 'this is the sweep copied from Qoder, whose output is Chinese prose with no identifiers in it; here it turns `my_file.py` into `myfile.py` in an otherwise correct summary',
  },
  // ---------------------------------------------------------------------
  // The panel marks a session as watched
  // ---------------------------------------------------------------------
  {
    file: api,
    label: 'the panel never records that a session has a reader',
    suites: ['test/api.test.mjs'],
    from: '  if (id.length > 0 && deps.summariser?.markViewed !== undefined) deps.summariser.markViewed(id)',
    to: '  if (false) deps.summariser?.markViewed?.(id)',
    why: '`warm` refuses every turn without this, so the card goes back to buying a summary while the person waits for it — the whole feature silently reverts to the old behaviour',
  },
  {
    file: client,
    label: 'the panel asks for interface language again',
    suites: ['test/client.test.mjs'],
    from: '            const data = await call(`/panel?agent=${encodeURIComponent(sessionId)}`)',
    to: '            const data = await call(`/panel?agent=${encodeURIComponent(sessionId)}&lang=zh-CN`)',
    why: 'the summary is written in the language of the conversation; a second source of truth for that question is the bug the removal fixed',
  },
  // ---------------------------------------------------------------------
  // The output list is the session's, not the turn's
  // ---------------------------------------------------------------------
  {
    file: state,
    label: 're-editing a file leaves it where it was',
    suites: ['test/session-state.test.mjs'],
    from: '      entry.paths.set(file, { seq: ++entry.sequence, turn: stamp, at, source: kept })',
    to: '      entry.paths.set(file, { seq: previous === undefined ? ++entry.sequence : previous.seq, turn: stamp, at, source: kept })',
    why: 'the list is ordered by this stamp, so reusing the old one leaves a file the agent just wrote sitting wherever it first appeared, and the card claims it was not touched this turn',
  },
  {
    file: state,
    label: 'a session that only wrote files has nothing worth keeping',
    suites: ['test/session-state.test.mjs', 'test/persistence.test.mjs'],
    from: '  if (facts.paths instanceof Map && facts.paths.size > 0) return true',
    to: '  if (false) return true',
    why: 'the document that holds the very list the reader is looking at would be refused as empty, and the card would reset on every restart',
  },
  {
    file: state,
    label: 'the file list dies with the turn',
    suites: ['test/session-state.test.mjs'],
    from: '    if (!Array.isArray(paths) || paths.length === 0) return\n    const entry = this.entry(sessionId)',
    to: '    if (!Array.isArray(paths) || paths.length === 0) return\n    const entry = this.entry(sessionId)\n    if (entry !== undefined) entry.paths.clear()',
    why: 'clearing per turn is exactly the old behaviour: a turn that wrote nothing empties the card',
  },
  {
    file: state,
    label: 'the file list grows for the life of the session',
    suites: ['test/session-state.test.mjs'],
    from: '    if (entry.paths.size <= MAX_PATHS) return',
    to: '    if (true) return',
    why: 'an uncapped list is one fs.stat per entry on every panel read, eight seconds apart, and a state file that never stops growing',
  },
  {
    file: state,
    label: 'the cap keeps the oldest edits',
    suites: ['test/session-state.test.mjs'],
    from: '    const ordered = [...entry.paths.entries()].sort((a, b) => a[1].seq - b[1].seq)',
    to: '    const ordered = [...entry.paths.entries()].sort((a, b) => b[1].seq - a[1].seq)',
    why: 'dropping the wrong end of the list leaves a card showing the start of a session while hiding what just happened',
  },
  {
    file: state,
    label: 'a restart forgets which file was edited last',
    suites: ['test/session-state.test.mjs'],
    from: '      for (const [file, at] of state.paths) if (current.paths.has(file) === false) current.paths.set(file, at)',
    to: '      for (const file of state.paths.keys()) if (current.paths.has(file) === false) current.paths.set(file, { seq: ++current.sequence, turn: undefined, at: undefined })',
    why: 'giving a remembered file a fresh tick claims this process saw an edit it did not, and flattens an order that was the whole point of storing it',
  },
  {
    file: index,
    label: 'the turn ends without its paths being kept',
    suites: ['test/persistence.test.mjs', 'test/index.test.mjs'],
    from: '      if (ended !== undefined) sessionState.rememberPaths(agentId, ended, endedTurn)',
    to: '      if (false) sessionState.rememberPaths(agentId, ended, endedTurn)',
    why: 'without this the list is never fed and the card stays empty however many files were written',
  },
  {
    label: 'the turn a file was written in never leaves the transcript',
    file: index,
    suites: ['test/persistence.test.mjs'],
    from: '      if (ended !== undefined) sessionState.rememberPaths(agentId, ended, endedTurn)',
    to: '      if (ended !== undefined) sessionState.rememberPaths(agentId, ended)',
    why: 'the turn number is the only durable answer to "this turn" — dropped, every file files under earlier after a restart, and nothing throws',
  },
  {
    file: api,
    label: 'the output card goes back to describing one turn',
    suites: ['test/api.test.mjs'],
    from: '  const files = await statTouchedFiles({\n    paths: remembered.length > 0 ? remembered : fallback,',
    to: '  const files = await statTouchedFiles({\n    paths: fallback,',
    why: 'the previous source describes the turn that just ended; using it again empties the card on a quiet turn',
  },
  {
    file: state,
    label: 'a merge carries two full file lists at once',
    suites: ['test/session-state.test.mjs'],
    from: '      this.trimPaths(current)\n      current.sequence = shift + current.sequence',
    to: '      current.sequence = shift + current.sequence',
    why: 'the cap lives in rememberPaths alone without this line, so a process that records before its first load keeps the file list plus its own and writes the sum back — three restarts measured 400, 600, then 800 against a cap of 200',
  },
  {
    file: state,
    label: 'an oversized file is read whole',
    suites: ['test/session-state.test.mjs'],
    from: '  if (paths.size > MAX_PATHS) {',
    to: '  if (false) {',
    why: 'a file written before the cap existed, or by the merge path before it trimmed, stays oversized through every read: every poll stats all of its entries and the next write preserves the excess',
  },
  {
    file: api,
    label: 'an empty remembered list is preferred over the turn',
    suites: ['test/api.test.mjs'],
    from: '  const files = await statTouchedFiles({\n    paths: remembered.length > 0 ? remembered : fallback,',
    to: '  const files = await statTouchedFiles({\n    paths: remembered.length > 0 || fallback.length > 0 ? remembered : fallback,',
    why: 'a host that wires session state but has not recorded a file yet would go blank instead of falling back',
  },
  // ---------------------------------------------------------------------
  // S1: three states and a turn number
  // ---------------------------------------------------------------------
  {
    file: api,
    label: 'a deleted file is dropped from the card again',
    suites: ['test/api.test.mjs', 'test/client.test.mjs'],
    from: "      const gone = error?.code === 'ENOENT' || error?.code === 'ENOTDIR'\n      out.push({ ...base, status: gone ? 'missing' : 'invalid', bytes: null, mtimeMs: null })\n      continue",
    to: '      continue',
    why: 'dropping the row is the old behaviour that made "edited then deleted" and "never touched" the same sentence; the whole of S1 exists to tell them apart',
  },
  {
    file: api,
    label: 'a file that cannot be read is reported as deleted',
    suites: ['test/api.test.mjs'],
    from: "status: gone ? 'missing' : 'invalid'",
    to: "status: gone ? 'missing' : 'missing'",
    why: 'the only distinction the reader can act on is "it is gone" versus "it is there but I cannot open it"; collapsing them tells the reader to rewrite a file that still exists',
  },
  {
    file: api,
    label: 'a directory is listed as a file',
    suites: ['test/api.test.mjs'],
    from: '    if (!info.isFile()) {',
    to: '    if (false) {',
    why: 'a directory that tools reported as a written path would be listed with a size and an open click, and clicking it can only fail',
  },
  {
    file: state,
    label: 'the turn a file was written in is not recorded',
    suites: ['test/session-state.test.mjs'],
    from: '      entry.paths.set(file, { seq: ++entry.sequence, turn: stamp, at, source: kept })',
    to: '      entry.paths.set(file, { seq: ++entry.sequence, turn: undefined, at, source: kept })',
    why: 'without the number the card can only compare against the previous turn snapshot, which is empty after a restart — every file silently becomes "earlier"',
  },
  {
    file: state,
    label: 'an older file format is refused',
    suites: ['test/session-state.test.mjs'],
    from: '  if (READABLE_VERSIONS.has(stored.state) === false) return undefined',
    to: '  if (stored.state !== STATE_VERSION) return undefined',
    why: 'refusing version 1 throws away every existing session file list on the first restart after the upgrade, for a shape that reads perfectly well',
  },
  {
    file: client,
    label: 'a file that is gone still offers a preview',
    suites: ['test/client.test.mjs'],
    from: "const openable = gone === false && canPreview === true && typeof file.address === 'string' && file.address.length > 0",
    to: "const openable = canPreview === true && typeof file.address === 'string' && file.address.length > 0",
    why: 'a click that opens an empty preview teaches the reader the click is broken; a struck-through row is the one case where the invitation must stop',
  },
  // ---------------------------------------------------------------------
  // A failed summary says so in the reader's language
  //
  // Every entry in this group stands in for a defect that was found by reading
  // the code, not by a failing test. The table lives in `client.js` and the
  // strings it matches live in `summarise.js`, with no type between them, so a
  // test is the only thing that keeps the two in step.
  // ---------------------------------------------------------------------
  {
    file: client,
    label: 'the failure copy matches a phrase the summariser never says',
    suites: ['test/client.test.mjs'],
    from: '      if (raw.startsWith("the summary call failed")) return { text: "摘要生成失败", detail }',
    to: '      if (raw.startsWith("the model call failed")) return { text: "摘要生成失败", detail }',
    why: 'this shipped once: the table matched `the model call failed` while the main failure path said `the summary call failed: …`, so a 401, an expired key or a dropped connection all rendered as the generic "暂无摘要" and the only clue lived in a hover title',
  },
  {
    file: client,
    label: 'the panel asks for interface language again',
    suites: ['test/client.test.mjs'],
    from: '            const data = await call(`/panel?agent=${encodeURIComponent(sessionId)}`)',
    to: '            const data = await call(`/panel?agent=${encodeURIComponent(sessionId)}&lang=zh-CN`)',
    why: 'the summary is written in the language of the conversation; a second source of truth for that question is the bug the removal fixed',
  },
  // ---------------------------------------------------------------------
  // A summary says how old it is
  // ---------------------------------------------------------------------
  {
    file: client,
    label: 'the timestamp is read off the clock instead of the payload',
    suites: ['test/client.test.mjs'],
    from: '                  : jsx(\'span\', { className: \'dsse-head-ago\', title: `摘要生成于 ${new Date(summary.at).toLocaleString()}`, children: `更新于 ${summaryAgo}` }),',
    to: '                  : jsx(\'span\', { className: \'dsse-head-ago\', title: `摘要生成于 ${new Date(Date.now()).toLocaleString()}`, children: `更新于 ${formatAgo(Date.now())}` }),',
    why: 'the panel repaints every eight seconds, so a render-time clock would have the card claim the summary was written "刚刚" forever and the age would never advance',
  },
  {
    file: client,
    label: 'a failed summary is given a time anyway',
    suites: ['test/client.test.mjs'],
    from: '                  summaryAgo === \'\'',
    to: '                  String(summaryAgo) === \'never\'',
    why: '"生成失败 · 3 分钟前" invites the reader to wait for a retry that is never scheduled — the only retry is the next completed turn, which may be hours away',
  },
  {
    file: summarise,
    label: 'a cached summary is re-dated every time it is read',
    suites: ['test/summarise.test.mjs'],
    from: '    if (hit !== undefined) return { enabled: true, text: hit.text, at: hit.at, cached: true }',
    to: '    if (hit !== undefined) return { enabled: true, text: hit.text, at: Date.now(), cached: true }',
    why: 'the cache is what makes the warm-up free; re-dating on read throws that away and makes the card look freshly written after every poll',
  },
  // ---------------------------------------------------------------------
  // The warm gate
  // ---------------------------------------------------------------------
  {
    file: summarise,
    label: 'the warm gate never lets go of a session',
    suites: ['test/summarise.test.mjs'],
    from: '    if (typeof agentId !== \'string\' || agentId.length === 0) return\n    this.viewed.delete(agentId)',
    to: '    if (true) return\n    this.viewed.delete(agentId)',
    why: 'without this the gate answers "has anyone ever opened this", and a host running for days pays a model call per turn for every session that was ever glanced at — exactly the spend the gate exists to avoid',
  },
  {
    file: api,
    label: 'the panel reads a session without recording that it was seen',
    suites: ['test/api.test.mjs'],
    from: '  if (id.length > 0 && deps.summariser?.markViewed !== undefined) deps.summariser.markViewed(id)',
    to: '  if (false) deps.summariser?.markViewed?.(id)',
    why: '`warm` refuses every turn without this, so the card goes back to buying a summary while the person waits for it — the whole feature silently reverts to the old behaviour',
  },
  // ---------------------------------------------------------------------
  // S2: the row became one line with a glyph, and the directory became a path
  // from the workspace instead of three tail segments.
  // ---------------------------------------------------------------------
  {
    file: client,
    label: 'every file row loses its glyph',
    suites: ['test/client.test.mjs'],
    from: "                              jsx(FileIcon, { name: parts.name }),",
    to: "",
    why: 'the glyph is the whole of S2 on the visual side; without it the row is the two-line row S1 shipped and nothing tells the reader what kind of file this is',
  },
  {
    file: client,
    label: 'every extension lands on the blank page',
    suites: ['test/client.test.mjs'],
    from: "      const bucket = fileBucket(props?.name)",
    to: "      const bucket = 'file'",
    why: 'a classifier that always answers "unknown" looks identical to no classifier at all, and the eight buckets are only worth having if they differ',
  },
  {
    file: client,
    label: 'the directory is never measured from the workspace',
    suites: ['test/client.test.mjs'],
    from: '      if (root !== "") {',
    to: '      if (false) {',
    why: 'this is the difference S2 was for: `src/lib` versus `Users/me/projects/app/src/lib`, and a row that silently falls back to the tail is the old behaviour wearing the new code',
  },
  {
    file: client,
    label: 'a workspace match is case-sensitive on a case-insensitive filesystem',
    suites: ['test/client.test.mjs'],
    from: '        if (normal.toLowerCase().startsWith(prefix.toLowerCase()) === true) {',
    to: '        if (normal.startsWith(prefix) === true) {',
    why: 'Windows paths are not case-sensitive, and the two halves arrive from different places — the workspace from the session header, the path from a tool call — so they disagree about case routinely. A row that misses the match draws its whole absolute path as its directory beside rows drawing `src`',
  },
  {
    file: client,
    label: 'a deep file is given three segments instead of its own directory',
    suites: ['test/client.test.mjs'],
    from: '            return { name: inside[inside.length - 1], where: inside.slice(0, inside.length - 1).join("/") }',
    to: '            return { name: inside[inside.length - 1], where: inside.slice(Math.max(0, inside.length - 3), inside.length - 1).join("/") }',
    why: 'inside the workspace there is no reason to truncate: the whole directory is short enough to read, and truncating it hides which branch of the tree the file is on',
  },
  {
    file: client,
    label: 'the directory is printed beside the name again',
    suites: ['test/client.test.mjs'],
    from: ".dsse-where{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}",
    to: ".dsse-where{color:#8b92a1;font-size:11px}",
    why: 'the directory at 320px costs the name more width than the disambiguation is worth; putting it back beside the name brings back the truncated filenames the row was rebuilt to stop truncating',
  },
  {
    file: client,
    label: 'the name is told to shrink against the directory again',
    suites: ['test/client.test.mjs'],
    from: ".dsse-name{display:block;overflow:hidden;",
    to: ".dsse-name{flex:0 1 auto;display:block;overflow:hidden;",
    why: 'a block name takes the whole width and ellipsises on its own; as a shrinking flex item it shares that width with whatever sits beside it, which is how long names started being cut short',
  },
  {
    file: client,
    label: 'the glyph is given a colour of its own',
    suites: ['test/client.test.mjs'],
    from: ".dsse-fileicon{width:16px;height:16px;flex:0 0 auto;fill:none;stroke:currentColor;",
    to: ".dsse-fileicon{width:16px;height:16px;flex:0 0 auto;fill:none;stroke:#333;",
    why: 'the row recolours its glyph in CSS when the file is gone, and that only works while the stroke is inherited; a glyph with a stroke of its own stays bright beside struck-through grey text',
  },
  {
    file: client,
    label: 'every bucket is painted the same colour',
    suites: ['test/client.test.mjs'],
    from: '.dsse-fileicon[data-bucket="style"]{color:#8a6aa8}',
    to: '.dsse-fileicon[data-bucket="style"]{color:#4c7fb8}',
    why: 'the six tints are the cue the reader scans by; two buckets sharing one hue puts a stylesheet and a source file in the same group, which is worse than no colour at all',
  },
  {
    file: client,
    label: 'a bucket that claims nothing is given a colour anyway',
    suites: ['test/client.test.mjs'],
    from: '.dsse-fileicon[data-bucket="archive"]{color:#b08a3e}',
    to: '.dsse-fileicon[data-bucket="archive"]{color:#b08a3e}\n.dsse-fileicon[data-bucket="file"]{color:#4c7fb8}',
    why: 'the bucket for unknown extensions deliberately makes no claim; tinting it says the reader should be able to tell what the file is, and there is nothing to tell',
  },
  {
    file: client,
    label: 'a missing file keeps its colour',
    suites: ['test/client.test.mjs'],
    from: ".dsse-row[data-status=\"missing\"] .dsse-fileicon,.dsse-row[data-status=\"invalid\"] .dsse-fileicon{color:var(--dsw-alias-label-tertiary,#8b92a1)}",
    to: "",
    why: 'colour is a claim about what the file is worth reading as; a bright glyph beside a struck-through grey name says two different things on the same line',
  },
  {
    file: client,
    label: 'every bucket is drawn on the same silhouette again',
    suites: ['test/client.test.mjs'],
    from: "      code: ['M10 4.5c-2.6 0-2.6 7.5-5.4 7.5 2.8 0 2.8 7.5 5.4 7.5M14 4.5c2.6 0 2.6 7.5 5.4 7.5-2.8 0-2.8 7.5-5.4 7.5'],",
    to: "      code: ['M5 3.5h10l4 4v13H5zM15 3.5v4h4'],",
    why: 'this is the defect the eight outlines exist to fix: one page silhouette told apart by a four-pixel mark was, at sixteen pixels, one glyph repeated eight times',
  },
  {
    file: client,
    label: 'the list reserves room for the rows it used to have',
    suites: ['test/client.test.mjs'],
    from: "const FILE_LIST_MAX_PX = 8 * 28 + 7 * 3",
    to: "const FILE_LIST_MAX_PX = 8 * 36 + 7 * 3",
    why: 'the height is a promise about how many rows fit before the list scrolls; a stale number scrolls early and leaves a gap where a row should have been',
  },
  {
    file: client,
    label: 'a row is taller than the height the reservation multiplies',
    suites: ['test/client.test.mjs'],
    from: '.dsse-row{display:flex;align-items:center;gap:6px;min-width:0;min-height:28px;padding:2px 6px;border-radius:7px;box-sizing:border-box}',
    to: '.dsse-row{display:flex;align-items:center;gap:6px;min-width:0;min-height:28px;padding:2px 6px;border-radius:7px}',
    why: 'the reservation is arithmetic over the row height, so the row has to be that height; without border-box the vertical padding is added on top and eight rows no longer fit in eight rows of space',
  },
  // ---------------------------------------------------------------------
  // A declared output reaches the card
  // ---------------------------------------------------------------------
  //
  // The collection rules above all infer a path from a call that named one.
  // These are about the opposite case: a turn that says what it made. The
  // measured session behind the tool had eight files on disk and four in the
  // card, and every one of the four missing was written by a script whose own
  // source named them only inside string literals — no inference could reach
  // them, which is why the tool exists and why each of these has to fail.
  {
    file: transcript,
    label: 'a declared output is collected like an edit, so nothing is collected',
    suites: ['test/transcript.test.mjs'],
    from: '    if (REPORT_TOOLS.has(call.name)) {',
    to: '    if (false) {',
    why: 'the report tool passes an array, and the edit rule reads a single path — dropping the branch leaves the tool answering success while the card stays empty, which is the exact failure the tool was added to fix',
  },
  {
    file: transcript,
    label: 'the declaration is read as one path instead of a list',
    suites: ['test/transcript.test.mjs'],
    from: '      for (const declared of readPathListArgument(call.arguments)) this.declared.push(declared)',
    to: '      for (const declared of [readPathArgument(call.arguments)].filter(Boolean)) this.declared.push(declared)',
    why: 'readPathArgument only looks at scalar fields, so an array-shaped argument yields nothing — the card would lose every declared file while the tool reported success',
  },
  {
    file: transcript,
    label: 'the declaration cap is not applied on the way in',
    suites: ['test/transcript.test.mjs'],
    from: '  const list = bag.paths\n  if (!Array.isArray(list)) return []\n  const found = []\n  for (const entry of list) {\n    if (found.length >= MAX_REPORTED_PATHS) break',
    to: '  const list = bag.paths\n  if (!Array.isArray(list)) return []\n  const found = []\n  for (const entry of list) {\n    if (false) break',
    why: 'without the break a single call can push thousands of entries into a map the panel reads on every repaint, and the snapshot slice would silently keep the wrong end of the list',
  },
  {
    file: transcript,
    label: 'an unusable entry is kept as a path',
    suites: ['test/transcript.test.mjs'],
    from: "    if (typeof entry !== 'string') continue\n    const trimmed = entry.trim()\n    if (trimmed.length > 0) found.push(trimmed)",
    to: "    if (typeof entry !== 'string') continue\n    const trimmed = entry.trim()\n    found.push(trimmed)",
    why: 'a blank row in the card has no name and no size and cannot be opened — it is a row that says a file exists where the argument said nothing',
  },
  {
    file: transcript,
    label: 'the report tool is not recognised as a report',
    suites: ['test/transcript.test.mjs'],
    from: "const REPORT_TOOLS = new Set(['report_output_files'])",
    to: "const REPORT_TOOLS = new Set(['present_files'])",
    why: 'the name is the whole contract: a set that lists a tool nobody calls collects nothing, and the tests above would pass on an empty card if they only ever asserted that the code ran',
  },
  {
    file: report,
    label: 'an oversized call says every path was recorded',
    suites: ['test/report-tool.test.mjs'],
    from: '      return { ok: true, recorded: kept.length, ignored, dropped }',
    to: '      return { ok: true, recorded: recorded.length, ignored, dropped }',
    why: 'the model is told sixty were recorded when forty fit, so it never learns the tail is gone and the ten files it cared about vanish with no notice anywhere',
  },
  {
    file: report,
    label: 'the dropped tail is not counted',
    suites: ['test/report-tool.test.mjs'],
    from: '      const dropped = recorded.length - kept.length',
    to: '      const dropped = 0',
    why: 'a row count without a dropped count reads as complete, which is the one thing an oversized declaration is not',
  },
  {
    file: report,
    label: 'a call with nothing usable answers success',
    suites: ['test/report-tool.test.mjs'],
    from: '      if (recorded.length === 0) {',
    to: '      if (false) {',
    why: 'a declaration that records nothing but answers ok makes the model stop looking for the files it failed to name — the panel stays empty and every party believes it worked',
  },
  {
    file: report,
    label: 'the schema does not state the cap it enforces',
    suites: ['test/report-tool.test.mjs'],
    from: '        maxItems: MAX_REPORTED_PATHS,',
    to: '        maxItems: 500,',
    why: 'the schema is what the model reads before it writes the call; a number that disagrees with the check is a rule nobody can follow',
  },
  {
    file: report,
    label: 'a rejected declaration is rendered as success',
    suites: ['test/report-tool.test.mjs'],
    from: "          return [{ type: 'text', text: `Not recorded (${value.code}).\\n\\n${value.error}` }]",
    to: "          return [{ type: 'text', text: `Recorded ${value.recorded ?? 0} file(s).` }]",
    why: 'the render is the only sentence the model reads about the outcome; a rejection that reads as success is worse than no answer, because the model stops trying',
  },
  {
    label: 'a presented file is no longer collected',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "    if (PRESENT_TOOLS.has(call.name)) {",
    to: "    if (false) {",
    why: 'this is the branch that exists because the model calls present instead of our tool; without it the eight-file turn keeps showing four and nothing says why',
  },
  {
    label: 'only the first presented file is collected',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "      for (const delivered of readPresentedPaths(call.arguments)) this.declared.push(delivered)",
    to: "      for (const delivered of readPresentedPaths(call.arguments).slice(0, 1)) this.declared.push(delivered)",
    why: 'present carries up to four files; keeping one is the failure mode that looks like it works',
  },
  {
    label: 'the presented list is read from the wrong field',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "  const list = bag.files",
    to: "  const list = bag.paths",
    why: 'present and report_output_files disagree on the field name, which is the entire reason for two readers; reading paths here returns nothing and the branch looks healthy',
  },
  {
    label: 'a presented entry is taken as a bare string',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue",
    to: "    if (typeof entry === 'string') { found.push(entry.trim()); continue }",
    why: 'present entries are objects; accepting bare strings would also accept the description field if a caller ever flattened the shape',
  },
  {
    label: 'a presentation replaces the turn instead of adding to it',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "      for (const delivered of readPresentedPaths(call.arguments)) this.declared.push(delivered)",
    to: "      this.paths = readPresentedPaths(call.arguments)",
    why: 'assigning instead of appending still shows the presented files, so the card looks right while every file the turn edited before the model spoke is gone',
  },
  {
    label: 'declared paths are kept in call order, so a busy turn drops them',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "      paths: [...new Set([...this.declared, ...this.paths])].slice(0, MAX_CARD_PATHS),",
    to: "      paths: [...new Set([...this.paths, ...this.declared])].slice(0, MAX_CARD_PATHS),",
    why: 'the cap keeps the first forty; shell redirects arrive early and declarations arrive last, so call order drops exactly the files the model named out loud',
  },
  {
    label: 'the files field is only checked for being present, not for being an array',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "  const list = bag.files\n  if (!Array.isArray(list)) return []",
    to: "  const list = bag.files\n  if (list === undefined) return []",
    why: 'a present call carrying an object under files then throws inside transcript recording, which takes the whole panel down with it',
  },
  {
    label: 'a blank presented path is kept as a row',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "    const candidate = /** @type {Record<string, unknown>} */ (entry).path\n    if (typeof candidate !== 'string') continue\n    const trimmed = candidate.trim()\n    if (trimmed.length > 0) found.push(trimmed)",
    to: "    const candidate = /** @type {Record<string, unknown>} */ (entry).path\n    if (typeof candidate !== 'string') continue\n    const trimmed = candidate.trim()\n    found.push(trimmed)",
    why: 'a blank path becomes a row with no name that cannot be opened; the stat that follows fails and the card shows a deleted file that never existed',
  },
  {
    label: 'a presented path is not trimmed',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "    const candidate = /** @type {Record<string, unknown>} */ (entry).path\n    if (typeof candidate !== 'string') continue\n    const trimmed = candidate.trim()",
    to: "    const candidate = /** @type {Record<string, unknown>} */ (entry).path\n    if (typeof candidate !== 'string') continue\n    const trimmed = candidate",
    why: 'the padded string is not a path, so the row records a file nobody can open and the real one never appears',
  },
  {
    label: 'null is read as a files bag',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []\n  const bag = /** @type {Record<string, unknown>} */ (value)\n  const list = bag.files",
    to: "  if (typeof value !== 'object' || Array.isArray(value)) return []\n  const bag = /** @type {Record<string, unknown>} */ (value)\n  const list = bag.files",
    why: 'reading files off null throws inside the event handler, and the panel stops updating for the rest of the turn',
  },
  {
    label: 'any tool carrying a files array is read as a presentation',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "    if (PRESENT_TOOLS.has(call.name)) {",
    to: "    if (true) {",
    why: 'without the name check every tool that happens to use a files array is recorded as a deliverable, so the card fills with files nothing presented',
  },
  {
    label: 'the report tool describes itself as the presentation tool',
    file: report,
    suites: ['test/report-tool.test.mjs'],
    from: "      'Record every file this turn produced, for the sidebar list that shows what a turn made. This is not `present`: `present` hands the few files a person should open (at most four) and is about delivery, while this records the full set — including the ones nobody needs to open — so the list is complete.",
    to: "      'Declare existing files as final deliverables for the user.",
    why: 'this sentence exists because the first version of this tool lost to present on a real run; a description that reads like present hands the model no reason to prefer either',
  },
  // ---------------------------------------------------------------------
  // Git is a third collector
  // ---------------------------------------------------------------------
  //
  // The two collectors above read what the tools and the model said. Neither can
  // see a script's output, which is what put eight files on disk and five in the
  // card. These guard the bracket that measures the turn instead of listening to
  // it: the readings, the subtraction between them, and the two places the
  // wiring can silently answer an empty workspace.
  {
    file: gitChanges,
    label: "the rename's old path is recorded as a change of its own",
    suites: ['test/git-changes.test.mjs'],
    from: "    if (PAIRED_CODES.has(status.charAt(0)) === true) index += 1",
    to: "    if (false) index += 1",
    why: 'a rename is two NUL records in -z output, new path then old; without the pairing the old path is reported as changed, so the card lists a file that no longer exists next to the one that replaced it',
  },
  {
    file: gitChanges,
    label: 'a path from a subdirectory is joined to the session instead of the repository',
    suites: ['test/git-changes.test.mjs'],
    from: '      const absolute = toAbsolute(described.root, record.path)',
    to: '      const absolute = toAbsolute(cwd, record.path)',
    why: 'git prints paths relative to the repository root, so joining to the session directory invents a path that exists nowhere whenever the session sits below the root',
  },
  {
    file: gitChanges,
    label: 'every uncommitted change is credited to the turn',
    suites: ['test/git-changes.test.mjs', 'test/git-watch.test.mjs'],
    from: "    if (known.has(path) === true) continue",
    to: "    if (false) continue",
    why: 'git status is cumulative; without the subtraction the whole dirty tree is recorded again every turn, pushing work from five turns ago to the top and calling it new',
  },
  {
    file: gitWatch,
    label: 'the baseline is kept after the turn that used it',
    suites: ['test/git-watch.test.mjs'],
    from: "    const pending = this.baselines.get(agentId)\n    this.baselines.delete(agentId)",
    to: "    const pending = this.baselines.get(agentId)",
    why: 'a kept baseline is one reading too old for the next turn, which then reports everything that changed since a turn it no longer matches',
  },
  {
    file: gitWatch,
    label: 'a turn with no baseline is measured against the whole dirty tree',
    suites: ['test/git-watch.test.mjs'],
    from: "    if (pending === undefined) return nothing",
    to: "    if (pending === undefined) return asReading(await this.changes(cwd))",
    why: 'no baseline means the turn began in another process; answering the full uncommitted set credits the turn with work it never did, and nothing in the panel would show the difference',
  },
  {
    file: gitWatch,
    label: 'a sweep that could only half see reports a clean interval',
    suites: ['test/git-watch.test.mjs'],
    from: "    const coverage = mergeCoverage(before.coverage, after.coverage)",
    to: "    const coverage = 'complete'",
    why: 'coverage has exactly one job: survive from the sweep to the card. Flattening it here means a turn that read half a workspace is indistinguishable from one that read all of it, and the caveat is lost silently because nothing throws',
  },
  {
    file: gitChanges,
    label: 'a root that cannot answer still counts as read',
    suites: ['test/git-changes.test.mjs'],
    from: "      // workspace itself is not a repository, nothing was expected anyway.\n      if (directory !== cwd) coverage = 'partial'",
    to: '      // workspace itself is not a repository, nothing was expected anyway.\n      coverage = coverage',
    why: 'a child repository that fails to answer is a hole in the answer; recording it as read is how a partial sweep silently claims to be complete',
  },
  {
    file: index,
    label: 'the workspace is only read from an agent, never from a session',
    suites: ['test/index.test.mjs'],
    from: '    const cwd = subject?.session?.header?.cwd ?? subject?.header?.cwd',
    to: '    const cwd = subject?.session?.header?.cwd',
    why: 'the git bracket is driven from the event stream, which hands over the session; reading only the agent shape answers an empty workspace for every session and disables the bracket with no error anywhere',
  },
  {
    file: index,
    label: 'the bracket opens and nothing is recorded from it',
    suites: ['test/index.test.mjs'],
    from: "            if (blind.length > 0) sessionState.rememberPaths(agentId, blind, endedTurn, 'scan')",
    to: "",
    why: 'measuring the turn and dropping the answer reads exactly like a workspace with no repository: the card simply never grows, and the collector is dead code that still costs two git calls per turn',
  },
  {
    file: index,
    label: 'a sweep that could only half see says nothing to the panel',
    suites: ['test/index.test.mjs'],
    from: '          sessionState.rememberSweep(agentId, endedTurn, claim)',
    to: "          sessionState.rememberSweep(agentId, endedTurn, 'complete')",
    why: 'the coverage is written before the early return for a reason: a turn that produced nothing in a half-read repository still has something to admit. Deleting the call turns doubt back into silence',
  },
  {
    file: state,
    label: 'a sweep of a half-read repository is remembered as a clean one',
    suites: ['test/session-state.test.mjs'],
    from: "    const claim = coverage === 'partial' || coverage === 'none' ? coverage : 'complete'\n    const next = { turn: stamp, coverage: claim }",
    to: "    const next = { turn: stamp, coverage: 'complete' }",
    why: 'the whole value of the field is that it survives a refresh. Flattening it on the way in makes a half-read turn indistinguishable from a complete one, and no caller can tell the difference afterwards',
  },
  {
    file: api,
    label: 'the panel is not told what the sweep could see',
    suites: ['test/index.test.mjs'],
    from: "    sweep: typeof deps.sweepSeen === 'function' ? (deps.sweepSeen(id) ?? null) : null,",
    to: '    sweep: null,',
    why: 'storing coverage and never reading it is the same defect as not storing it, and it survives every test that only inspects the store. The panel payload is the only path from the fact to the person',
  },

  {
    label: 'the scan reads directories the card hides',
    file: scanChanges,
    from: '        if (skipDirectory(entry.name) === true) continue',
    to: '        if (false) continue',
    why: 'The walk descends into node_modules and collects a thousand rows the card then filters out, so the entry budget is spent on files nobody will ever see.',
    suites: ['test/scan-changes.test.mjs'],
  },
  {
    label: 'the scan treats a directory as a file',
    file: scanChanges,
    from: '      if (entry.isDirectory() === true) {',
    to: '      if (false) {',
    why: 'Every subdirectory is stat-ed and reported as a produced file; the card shows a row for `src` next to a row for the file inside it.',
    suites: ['test/scan-changes.test.mjs'],
  },
  {
    label: 'a file written at the exact turn boundary is missed',
    file: scanChanges,
    from: '    if (typeof info.mtimeMs === \'number\' && info.mtimeMs >= since) paths.push(absolute)',
    to: '    if (typeof info.mtimeMs === \'number\' && info.mtimeMs > since) paths.push(absolute)',
    why: 'A turn that starts and finishes inside one filesystem tick reports nothing at all — the feature failing on the fastest turns.',
    suites: ['test/scan-changes.test.mjs'],
  },
  {
    label: 'the scan never admits it stopped early',
    file: scanChanges,
    from: '      if (outOfBudget()) {\n        truncated = true\n        return\n      }',
    to: '      if (outOfBudget()) {\n        return\n      }',
    why: 'The panel says the turn produced nothing rather than that the walk gave up, which is the one thing a partial read must not say.',
    suites: ['test/scan-changes.test.mjs'],
  },
  {
    label: 'the entry budget is never consulted',
    file: scanChanges,
    from: '  const outOfBudget = () => scanned >= maxEntries || now() - started >= maxMs',
    to: '  const outOfBudget = () => now() - started >= maxMs',
    why: 'A workspace with a hundred thousand files is walked to completion on every turn end; the panel request waits for all of it.',
    suites: ['test/scan-changes.test.mjs'],
  },
  {
    label: 'the depth budget is ignored',
    file: scanChanges,
    from: '    if (depth > maxDepth) {\n      truncated = true\n      return\n    }',
    to: '    if (false) {\n      truncated = true\n      return\n    }',
    why: 'A deeply nested tree consumes the whole entry budget in one branch, and every other part of the workspace goes unread.',
    suites: ['test/scan-changes.test.mjs'],
  },
  {
    label: 'a directory that cannot be read looks empty',
    file: scanChanges,
    from: '      truncated = true\n      return undefined',
    to: '      return undefined',
    why: 'A permission error or a vanished directory is reported as "I read it and found nothing", so a half-read workspace passes for a clean one.',
    suites: ['test/scan-changes.test.mjs'],
  },
  {
    label: 'the scan bracket opens after the turn already started',
    file: scanWatch,
    from: '    this.baselines.set(agentId, stamp)',
    to: '    this.baselines.set(agentId, stamp + 60000)',
    why: 'Everything the turn wrote in its first minute is older than the baseline and therefore reported as nothing.',
    suites: ['test/scan-watch.test.mjs'],
  },
  {
    label: 'the scan baseline survives the turn that consumed it',
    file: scanWatch,
    from: '    const since = this.baselines.get(agentId)\n    this.baselines.delete(agentId)',
    to: '    const since = this.baselines.get(agentId)',
    why: 'The next turn is measured from the previous turn opening, so old work is credited to a turn that never touched it.',
    suites: ['test/scan-watch.test.mjs'],
  },
  {
    label: 'a truncated walk is reported as a complete answer',
    file: scanWatch,
    from: "    coverage: found.truncated === true ? 'partial' : 'complete',",
    to: "    coverage: 'complete',",
    why: 'The caveat exists precisely so a partial read is not mistaken for a clean one; dropping it here makes the whole field decorative.',
    suites: ['test/scan-watch.test.mjs'],
  },
  {
    label: 'the scan is asked even when git already answered',
    file: index,
    from: '                blind = answer.known === true ? answer.ignored : fromScan',
    to: '                blind = fromScan',
    why: 'A modification time cannot tell a file this turn wrote from one a checkout rewrote, so the card fills with rows the turn did not produce.',
    suites: ['test/index.test.mjs'],
  },
  {
    label: 'the scan never contributes at all',
    file: index,
    from: '          const fromScan = Array.isArray(scan?.paths) ? scan.paths : []',
    to: '          const fromScan = []',
    why: 'A workspace that is not a repository goes back to reporting nothing, which is the exact gap S7 was built to close.',
    suites: ['test/index.test.mjs'],
  },
  {
    label: 'a partial scan is not allowed to taint the turn',
    file: index,
    from: "    return mergeCoverage(git, scan)",
    to: "    return 'complete'",
    why: 'A walk that gave up reports a clean turn, so the reader is told nothing was produced when the truth is that half the workspace was never read.',
    suites: ['test/index.test.mjs'],
  },
   {
    file: api,
    label: 'the walk is handed the card filter instead of its own',
    suites: ['test/scan-changes.test.mjs'],
    from: '  return UNWALKABLE_DIRS.has(segment.toLowerCase())',
    to: '  return GENERATED_DIRS.has(segment.toLowerCase())',
    why: 'This is the defect the two predicates were split to fix, and it is invisible from either file alone: the card is right to call `dist` generated, and the walk is right to want it anyway, because `dist` is where scripts write and it is in `.gitignore` in every project that has one. Collapsing the two back into one list makes the S8 bracket blind exactly where git is blind too -- measured on a real repository, four rows came back and neither ignored file that mattered was asked about.',
  },
  {
    file: api,
    label: 'the walk may enter a dependency tree',
    suites: ['test/scan-changes.test.mjs'],
    from: "  return UNWALKABLE_DIRS.has(segment.toLowerCase())",
    to: "  return false",
    why: 'The entry budget is 5000 for the whole workspace. `node_modules` alone routinely holds more, so a walk that descends into it spends the entire budget inside one dependency tree and reports those files as the turn output while the file that was actually written is never reached. This is also why the predicate defaults rather than being passed in: the caller did not pass one for two years.',
  },
 {
    file: api,
    label: 'the directory filter also hides source trees that start with an underscore',
    suites: ['test/scan-changes.test.mjs'],
    from: '  return UNWALKABLE_DIRS.has(segment.toLowerCase())',
    to: "  return UNWALKABLE_DIRS.has(segment.toLowerCase()) || segment.startsWith('_')",
    why: 'This is the exact mistake the predicate was narrowed to avoid: `scratchName` treats a leading underscore as scratch, which is right for temp FILES and wrong for directories. Re-admitting it quietly prunes `_posts`, `_layouts`, `_data` and `_build` -- source in Jekyll and Hugo -- and a pruned subtree is never recovered, so the card reports fewer files than the turn wrote with no way to notice.',
  },
  {
    file: scanWatch,
    label: 'a bracket that never looked reports a clean sweep',
    suites: ['test/scan-watch.test.mjs'],
    from: "const emptyReading = () => ({ paths: [], coverage: 'none' })",
    to: "const emptyReading = () => ({ paths: [], coverage: 'complete' })",
    why: 'No baseline means nobody looked, and `complete` claims somebody looked and found nothing. Collapsing the two lets the card vouch for a turn that was never swept -- after a host restart, for every session -- and it also overwrites a standing `partial` caveat from the turn before.',
  },
  {
    file: coverage,
    label: 'a half-read bracket is vouched for as complete',
    suites: ['test/index.test.mjs', 'test/coverage.test.mjs'],
    from: "  if (left === 'partial' || right === 'partial') return 'partial'",
    to: "  if (left === 'partial' || right === 'partial') return 'complete'",
    why: 'The merge is the only place both brackets are visible at once, so it is the only place the weaker claim can be lost. Returning `complete` here tells the reader nothing else was produced when half the workspace was never read.',
  },
  {
    file: client,
    label: 'the caveat about a half-read sweep is never drawn',
    suites: ['test/client.test.mjs'],
    from: "                  blindNote === '' ? null : jsx('p', { className: 'dsse-note', children: blindNote }),",
    to: "",
    why: 'The only place the collector\'s doubt reaches the reader. Without it "nothing was produced" and "nothing was produced that I could see" render identically, and the second one is the sentence that should worry somebody.',
  },
  {
    file: client,
    label: 'the card never reads what the sweep could see',
    suites: ['test/client.test.mjs'],
    from: "      const coverage = typeof sweep?.coverage === 'string' ? sweep.coverage : ''",
    to: "      const coverage = ''",
    why: 'The payload carries the caveat and the card must repeat it; reading the field and ignoring it is indistinguishable from never sending it, except that the serving side looks finished.',
  },
  {
    file: client,
    label: 'the header goes back to counting only the files a person wrote',
    suites: ['test/client.test.mjs'],
    from: "      const fileMeta = `${ordered.length} 个文件`",
    to: "      const fileMeta = `${people.length} 个文件`",
    why: 'The old header counted people\'s files and named the generated ones beside it, which left two counts of two lists next to a badge naming a third. The header is supposed to answer one question: how much did this session produce.',
  },
  {
    file: client,
    label: 'the badge repeats the total instead of naming the remainder',
    suites: ['test/client.test.mjs'],
    from: "              label: filesOpen ? '收起文件' : `显示其余 ${hiddenFiles} 个`,",
    to: "              label: filesOpen ? '收起文件' : `显示其余 ${ordered.length} 个`,",
    why: 'The badge exists to say how many rows are missing. Naming the total again makes it agree with the header and leave the reader to subtract, which is exactly the arithmetic a folded card is supposed to spare them.',
  },
  {
    file: client,
    label: 'the folded row count is assumed to be a full fold',
    suites: ['test/client.test.mjs'],
    from: "      const foldedRows = fresh.concat(earlier).slice(0, FOLDED_FILES).length",
    to: "      const foldedRows = FOLDED_FILES",
    why: 'A session with two written files draws two rows, not four. Assuming a full fold makes the badge claim four rows are hidden on a card that hides none, which is the "展开全部 1 个" bug wearing new words.',
  },
  {
    file: gitChanges,
    label: 'a workspace with no repository is answered as if it had one',
    suites: ['test/git-changes.test.mjs', 'test/index.test.mjs'],
    from: "  if (prefixes.length === 0) return { ignored: [], known: true, repository: false }",
    to: "  if (prefixes.length === 0) return { ignored: [], known: true, repository: true }",
    why: 'With `repository: true` and no ignored paths the merge treats the walk as fully redundant and drops it, so a session in a plain folder loses every file it wrote -- the exact turn where the walk is the only witness.',
  },
  {
    file: state,
    label: 'the bracket that found a file is not recorded',
    suites: ['test/session-state.test.mjs'],
    from: "    const origin = source === 'git' || source === 'scan' ? source : undefined",
    to: "    const origin = undefined",
    why: 'After the merge nothing else can say which bracket saw a file, and that is the only clue left when a row is surprising later. Dropping it at the write makes the field permanently null and the card cannot tell the two apart.',
  },
  {
    file: state,
    label: 'a late report about an older turn replaces the newer one',
    suites: ['test/session-state.test.mjs'],
    from: '      (stamp === undefined || previous.turn > stamp)',
    to: '      (stamp !== undefined && previous.turn > stamp)',
    why: 'the merge reports after awaiting a git subprocess, so an older turn can arrive last; without the number comparison its caveat becomes the one shown about the newer turn',
  },
  {
    file: state,
    label: 'a re-record forgets which bracket found the file',
    suites: ['test/session-state.test.mjs'],
    from: '      const kept = origin === undefined && previous !== undefined ? previous.source : origin',
    to: '      const kept = origin',
    why: 'turn/end re-records the whole path list every turn with no bracket named, so provenance would survive exactly one turn and the card would lose the only record of why a row is there',
  },
  {
    file: state,
    label: 'a bracket word this build does not know is carried anyway',
    suites: ['test/session-state.test.mjs'],
    from: '    source: raw.source === \'git\' || raw.source === \'scan\' ? raw.source : undefined,',
    to: '    source: raw.source,',
    why: 'the field exists to answer why this row is here; carrying a word no reader understands puts an uninterpretable claim in the document a future build must read',
  },
  {
    file: index,
    label: 'a failing ignore check costs the turn its diff',
    suites: ['test/index.test.mjs'],
    from: '              } catch {\n                answer = undefined\n              }',
    to: '              } catch {\n                throw new Error(\'no answer\')\n              }',
    why: 'the walk is a supplement to the diff; letting its failure escape empties the whole turn, including the half that had already arrived',
  },
]


// Baseline first: a workspace that already fails turns every mutation into a
// false KILLED, because "the suite has failures after the mutation" is then true
// before the mutation as well. The other scripts here check this for the same
// reason; this one has to as well, or a green run means nothing.
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

// One line in the source that a mutation could break and no assertion would
// notice. Printed with the run so a later reader knows the list is complete
// rather than merely green.
const known = [
  'the panel route\'s own `headOnly` argument is not mutated here; `test/api.test.mjs` owns HEAD separately',
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
