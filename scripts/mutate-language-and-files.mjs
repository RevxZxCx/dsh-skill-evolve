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
const deliverable = path.join(repo, 'packages', 'ui-evolve', 'lib', 'deliverable.js')
const revision = path.join(repo, 'packages', 'ui-evolve', 'lib', 'revision.js')
const client = path.join(repo, 'packages', 'ui-evolve', 'lib', 'client.js')
const index = path.join(repo, 'packages', 'ui-evolve', 'lib', 'index.js')
const state = path.join(repo, 'packages', 'ui-evolve', 'lib', 'session-state.js')
const summarise = path.join(repo, 'packages', 'ui-evolve', 'lib', 'summarise.js')
const transcript = path.join(repo, 'packages', 'ui-evolve', 'lib', 'transcript.js')
const report = path.join(repo, 'packages', 'ui-evolve', 'lib', 'report-tool.js')

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
    from: '              data = await call(`/panel?agent=${encodeURIComponent(target)}`, { signal: flight.signal })',
    to: '              data = await call(`/panel?agent=${encodeURIComponent(target)}&lang=zh-CN`, { signal: flight.signal })',
    why: 'the summary is written in the language of the conversation; a second source of truth for that question is the bug the removal fixed',
  },
  // ---------------------------------------------------------------------
  // The output list is the session's, not the turn's
  // ---------------------------------------------------------------------
  {
    file: state,
    label: 're-editing a file leaves it where it was',
    suites: ['test/session-state.test.mjs'],
    from: '      entry.paths.set(file, { seq: ++entry.sequence, turn: stamp, at, description: kept })',
    to: '      entry.paths.set(file, { seq: ++entry.sequence, turn: undefined, at, description: kept })',
    why: 'the list is ordered by this stamp, so reusing the old one leaves a file the agent just wrote sitting wherever it first appeared, and the card claims it was not touched this turn',
  },
  {
    file: state,
    label: 'a session that only wrote files has nothing worth keeping',
    // Measured: only this suite fails under the mutation. The ones this
    // replaces passed with it in place, so they were paying for a run and
    // covering nothing.
    suites: ['test/session-state.test.mjs'],
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
    // Measured: only this suite fails under the mutation. The ones this
    // replaces passed with it in place, so they were paying for a run and
    // covering nothing.
    suites: ['test/persistence.test.mjs'],
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
    // Measured: only this suite fails under the mutation. The ones this
    // replaces passed with it in place, so they were paying for a run and
    // covering nothing.
    suites: ['test/api.test.mjs'],
    from: "      const gone = error?.code === 'ENOENT' || error?.code === 'ENOTDIR'\n      // A record can outlive the parser that wrote it. When the filesystem also says\n      // there is nothing there and the spelling could not be a path anyway, the record\n      // is a mis-parse rather than a deleted file -- drawing it would say \"you deleted\n      // this\" about something that was never a name. The state file is append-only, so\n      // the record survives for whoever works out later what the command meant; only\n      // the row is withheld.\n      //\n      // This sits here, after `stat`, and not before it: a real file may legitimately be\n      // called `a*b.txt`, `stat` would have found it, and refusing up front would hide a\n      // file the session had written -- the same lie in the opposite direction.\n      if (gone === true && cannotBeAPath(path) === true) return null\n      const status = gone === false ? 'invalid' : isAbsolute === true ? 'missing' : 'unresolved'",
    to: '      return null',
    why: 'dropping the row is the old behaviour that made "edited then deleted" and "never touched" the same sentence; the whole of S1 exists to tell them apart',
  },
  {
    file: api,
    label: 'a file that cannot be read is reported as deleted',
    suites: ['test/api.test.mjs'],
    from: "      const status = gone === false ? 'invalid' : isAbsolute === true ? 'missing' : 'unresolved'",
    to: "      const status = gone === false ? 'missing' : isAbsolute === true ? 'missing' : 'unresolved'",
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
    from: '      entry.paths.set(file, { seq: ++entry.sequence, turn: stamp, at, description: kept })',
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
  },  // ---------------------------------------------------------------------
  // A summary says how old it is
  // ---------------------------------------------------------------------
  {
    file: client,
    label: 'the timestamp is read off the clock instead of the payload',
    suites: ['test/client.test.mjs'],
    from: '                  jsx(\'span\', { title: props.stamp, children: `更新于 ${ago}` }),',
    to: '                  jsx(\'span\', { title: `摘要生成于 ${new Date(Date.now()).toLocaleString()}`, children: `更新于 ${formatAgo(Date.now())}` }),',
    why: 'the panel repaints every eight seconds, so a render-time clock would have the card claim the summary was written "刚刚" forever and the age would never advance',
  },
  {
    file: client,
    label: 'a failed summary is given a time anyway',
    suites: ['test/client.test.mjs'],
    from: '          ago === \'\'',
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
    from: "                            jsx(FileIcon, { name: parts.name }),",
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
    from: '.dsse-fileicon[data-bucket="sheet"]{color:#2f8a72}',
    to: '.dsse-fileicon[data-bucket="sheet"]{color:#4c7fb8}',
    why: 'the six tints are the cue the reader scans by; two buckets sharing one hue puts a stylesheet and a source file in the same group, which is worse than no colour at all',
  },
  {
    file: client,
    label: 'a bucket that claims nothing is given a colour anyway',
    suites: ['test/client.test.mjs'],
    from: '.dsse-fileicon[data-bucket="slide"]{color:#b08a3e}',
    to: '.dsse-fileicon[data-bucket="slide"]{color:#b08a3e}\n.dsse-fileicon[data-bucket="file"]{color:#4c7fb8}',
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
    from: "      doc: ['M5 3.5h14v17H5zM8.5 8h7M8.5 12h7M8.5 16h4'],",
    to: "      doc: ['M5 3.5h10l4 4v13H5zM15 3.5v4h4'],",
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
    from: '.dsse-row{position:relative;display:flex;align-items:center;gap:6px;min-width:0;min-height:28px;padding:2px 6px;border-radius:7px;box-sizing:border-box}',
    to: '.dsse-row{position:relative;display:flex;align-items:center;gap:6px;min-width:0;min-height:28px;padding:2px 6px;border-radius:7px}',
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
    from: "      for (const declared of readPathListArgument(call.arguments)) this.deliver(declared, '')",
    to: "      for (const declared of [readPathArgument(call.arguments)].filter(Boolean)) this.deliver(declared, '')",
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
    from: "      for (const entry of readPresentedEntries(call.arguments)) this.deliver(entry.path, entry.description)",
    to: "      this.delivered = readPresentedEntries(call.arguments).map((entry) => ({ path: canonicalPath(entry.path), description: entry.description }))",
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
    to: "    if (typeof entry === 'string') { found.push({ path: entry.trim(), description: '' }); continue }",
    why: 'present entries are objects; accepting bare strings would also accept the description field if a caller ever flattened the shape',
  },
  {
    label: 'a presentation replaces the turn instead of adding to it',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "      for (const entry of readPresentedEntries(call.arguments)) this.deliver(entry.path, entry.description)",
    to: "      this.delivered = readPresentedEntries(call.arguments)",
    why: 'assigning instead of appending still shows the presented files, so the card looks right while every file the turn edited before the model spoke is gone',
  },
  {
    label: 'declared paths are kept in call order, so a busy turn drops them',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "  const declared = delivered.slice(0, MAX_CARD_PATHS)",
    to: "  const declared = delivered.slice(-MAX_CARD_PATHS)",
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
    from: "    if (typeof row.path !== 'string') continue\n    const path = row.path.trim()\n    if (path.length === 0) continue",
    to: "    if (typeof row.path !== 'string') continue\n    const path = row.path.trim()",
    why: 'a blank path becomes a row with no name that cannot be opened; the stat that follows fails and the card shows a deleted file that never existed',
  },
  {
    label: 'a presented path is not trimmed',
    file: transcript,
    suites: ['test/transcript.test.mjs'],
    from: "    const path = row.path.trim()",
    to: "    const path = row.path",
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












  {
    file: client,
    label: 'the header goes back to counting only the files a person wrote',
    suites: ['test/client.test.mjs'],
    from: "                      ? jsxs('span', { className: 'dsse-head-stat', children: [jsx('b', { children: String(delivered.length) }), jsx('span', { children: '个文件' })] })",
    to: "                      ? jsxs('span', { className: 'dsse-head-stat', children: [jsx('b', { children: String(ordered.length) }), jsx('span', { children: '个文件' })] })",
    why: 'The old header counted people\'s files and named the generated ones beside it, which left two counts of two lists next to a badge naming a third. The header is supposed to answer one question: how much did this session produce.',
  },
  {
    file: client,
    label: 'the badge repeats the total instead of naming the remainder',
    suites: ['test/client.test.mjs'],
    from: "                      label: filesExpanded ? '收起文件' : `显示其余 ${hiddenFiles} 个`,",
    to: "                      label: filesExpanded ? '收起文件' : `显示其余 ${ordered.length} 个`,",
    why: 'The badge exists to say how many rows are missing. Naming the total again makes it agree with the header and leave the reader to subtract, which is exactly the arithmetic a folded card is supposed to spare them.',
  },
  {
    file: client,
    label: 'the card refuses files without saying how many',
    suites: ['test/client.test.mjs'],
    from: "                      ? jsxs('span', { className: 'dsse-head-stat', children: [jsx('b', { children: String(delivered.length) }), jsx('span', { children: '个文件' })] })",
    to: "                      ? jsxs('span', { className: 'dsse-head-stat', children: [jsx('b', { children: String(ordered.length) }), jsx('span', { children: '个文件' })] })",
    why: 'A session with two written files draws two rows, not four. Assuming a full fold makes the badge claim four rows are hidden on a card that hides none, which is the "展开全部 1 个" bug wearing new words.',
  },





  {
    file: client,
    label: 'the copy buttons offer a path the workspace does not contain',
    suites: ['test/client.test.mjs'],
    from: 'const relative = relativePath(absolute, cwd)',
    to: 'const relative = absolute',
    why: 'the second button exists to give a path that can be pasted into a source file; handing it the absolute one makes both buttons do the same thing and nothing about the panel looks wrong',
  },
  {
    file: client,
    label: "a relative path is only relative when the case agrees",
    suites: ['test/client.test.mjs'],
    from: "if (folded.startsWith(foldedRoot + \"/\") === false) return undefined",
    to: "if (normal.startsWith(root + \"/\") === false) return undefined",
    why: "the workspace and the path are recorded by different parts of the Host and Windows does not care which case either used; comparing with case hides the relative entry on files that are plainly inside",
  },
  {
    file: client,
    label: "the relative path is folded, losing the case on disk",
    suites: ['test/client.test.mjs'],
    from: "      const inside = folded.length === normal.length\n        ? normal.slice(root.length + 1)\n        : folded.slice(foldedRoot.length + 1)",
    to: "      const inside = folded.slice(foldedRoot.length + 1)",
    why: "pasting src/cased.ts where the file is Src/Cased.ts breaks on a case-sensitive disk; a fixture that differs only in the drive letter cannot see it",
  },
  {
    file: client,
    label: "a panel without a clipboard still draws the control",
    suites: ['test/client.test.mjs'],
    from: "const copyButton = clipboard === undefined ? null : jsx('button', {",
    to: "const copyButton = jsx('button', {",
    why: "navigator.clipboard is absent outside a secure context, which is exactly how this panel is served over a relay; a control that cannot do its job reads as a broken panel, and this one also makes the row hide its size to make room for it",
  },
  {
    file: client,
    label: "the row claims an action it did not draw",
    suites: ['test/client.test.mjs'],
    from: "'data-actions': copyButton === null ? 'false' : 'true',",
    to: "'data-actions': 'true',",
    why: "the flag scopes the reveal rule; claiming an action on a row with no control hides the file size to uncover nothing, and on a Host without a clipboard that is every row",
  },
  {
    file: client,
    label: "the control reports success it did not have",
    suites: ['test/client.test.mjs'],
    from: "'data-ok': copiedHere === false ? undefined : (copied.ok === true ? 'true' : 'false'),",
    to: "'data-ok': 'true',",
    why: "the colour is the only visible confirmation this feature has; always painting it green tells the reader the path is on the clipboard after a write that was refused",
  },
  {
    file: client,
    label: "the reveal rule matches and then shows nothing",
    suites: ['test/client.test.mjs'],
    from: ".dsse-row[data-actions=\"true\"]:hover .dsse-row-actions,.dsse-row[data-actions=\"true\"]:focus-within .dsse-row-actions,.dsse-row[data-menu=\"true\"] .dsse-row-actions{opacity:1;pointer-events:auto}",
    to: ".dsse-row[data-actions=\"true\"]:hover .dsse-row-actions,.dsse-row[data-actions=\"true\"]:focus-within .dsse-row-actions,.dsse-row[data-menu=\"true\"] .dsse-row-actions{opacity:0;pointer-events:auto}",
    why: "a selector-only assertion passes this; the rule has to be checked for what it sets, or a visible-looking panel has buttons nobody can see",
  },
  {
    file: client,
    label: "a keyboard user never sees the control",
    suites: ['test/client.test.mjs'],
    from: ".dsse-row[data-actions=\"true\"]:hover .dsse-row-actions,.dsse-row[data-actions=\"true\"]:focus-within .dsse-row-actions,.dsse-row[data-menu=\"true\"] .dsse-row-actions{opacity:1;pointer-events:auto}",
    to: ".dsse-row[data-actions=\"true\"]:hover .dsse-row-actions,.dsse-row[data-menu=\"true\"] .dsse-row-actions{opacity:1;pointer-events:auto}",
    why: "Dropping the :focus-within half leaves copy for mouse users only, and nothing about the layout would look wrong. The tab order would still reach an invisible control.",
  },
  {
    file: client,
    label: "an open menu hides the control that opened it",
    suites: ['test/client.test.mjs'],
    from: ".dsse-row[data-actions=\"true\"]:hover .dsse-row-actions,.dsse-row[data-actions=\"true\"]:focus-within .dsse-row-actions,.dsse-row[data-menu=\"true\"] .dsse-row-actions{opacity:1;pointer-events:auto}",
    to: ".dsse-row[data-actions=\"true\"]:hover .dsse-row-actions,.dsse-row[data-actions=\"true\"]:focus-within .dsse-row-actions{opacity:1;pointer-events:auto}",
    why: "the pointer travels from the control down to the menu it just opened, and that trip leaves the row: without the data-menu half the control fades out under the hand that is using it",
  },
  {
    file: client,
    label: "focusing a row takes the file size away from a screen reader",
    suites: ['test/client.test.mjs'],
    from: ".dsse-row[data-actions=\"true\"]:hover .dsse-size,.dsse-row[data-menu=\"true\"] .dsse-size{visibility:hidden}",
    to: ".dsse-row[data-actions=\"true\"]:hover .dsse-size,.dsse-row[data-actions=\"true\"]:focus-within .dsse-size,.dsse-row[data-menu=\"true\"] .dsse-size{visibility:hidden}",
    why: "visibility:hidden leaves the accessibility tree, so the keyboard user loses the number precisely when they arrive at the row -- and they never hover, so the size they \"save\" is one they would never have seen",
  },
  {
    file: client,
    label: "an open menu hides the size behind nothing",
    suites: ['test/client.test.mjs'],
    from: ".dsse-row[data-actions=\"true\"]:hover .dsse-size,.dsse-row[data-menu=\"true\"] .dsse-size{visibility:hidden}",
    to: ".dsse-row[data-actions=\"true\"]:hover .dsse-size{visibility:hidden}",
    why: "with the menu open the control is pinned on screen, so the size has to give way too; otherwise the number sits under the icon and leaks out through the gap like a double image",
  },
  {
    file: client,
    label: "a clipboard that refuses the call outright is called a success",
    suites: ['test/client.test.mjs'],
    from: "        } catch {\n          settle(false)\n          return\n        }",
    to: "        } catch {\n          settle(true)\n          return\n        }",
    why: "S3 review (s3e): the throw branch was covered by tests but not by this table. A clipboard can refuse synchronously -- no writeText at all, a permission policy -- and that is the same failure as a rejected promise.",
  },
  {
    file: client,
    label: "a rejected clipboard write is reported as a success",
    suites: ['test/client.test.mjs'],
    from: "answer.then(() => settle(true), () => settle(false))",
    to: "answer.then(() => settle(true), () => settle(true))",
    why: "writeText rejects when the document is not focused or the permission was refused; reporting that as copied tells the reader the path is on the clipboard when it is not",
  },
  {
    file: client,
    label: "the answer never clears itself",
    suites: ['test/client.test.mjs'],
    from: "          }, 1500)",
    to: "          }, 15000000)",
    why: "the flash is a temporary state; a timer that never fires leaves the control permanently green, so the next press on the same file looks like it did nothing",
  },
  {
    file: client,
    label: "the flash timer outlives the panel that started it",
    suites: ['test/client.test.mjs'],
    from: "        if (copyTimer.current !== null) {\n          clearTimeout(copyTimer.current)\n          copyTimer.current = null\n        }",
    to: "        copyTimer.current = copyTimer.current",
    why: "the timer is held in a ref, so nothing in the rendered tree and no existing cleanup notices it; leaving it running writes state into a component that is gone",
  },
  {
    file: client,
    label: "the copy outcome is only visible, never announced",
    suites: ['test/client.test.mjs'],
    from: "                            'aria-label': copiedHere === false\n                              ? '复制路径'\n                              : copied.ok === true ? '已复制路径' : '复制路径失败',",
    to: "'aria-label': '复制路径',",
    why: "a fixed name means the one piece of feedback this feature has reaches sighted users only; every visible-text assertion still passes",
  },
  {
    file: client,
    label: "a press outside leaves the menu open",
    suites: ['test/client.test.mjs'],
    from: "if (inside === false && onButton === false) setMenuFor(undefined)",
    to: "if (false) setMenuFor(undefined)",
    why: "the menu is not modal and has no backdrop; a press anywhere else on the panel is the only way out for a pointer user who does not want either entry",
  },
  {
    file: client,
    label: "escape is a key like any other",
    suites: ['test/client.test.mjs'],
    from: "if (event?.key === 'Escape') setMenuFor(undefined)",
    to: "if (event?.key === 'Esc') setMenuFor(undefined)",
    why: "Escape is the way out that does not move the pointer or the focus; a handler watching for a key name nothing sends is indistinguishable from no handler until someone presses it",
  },
  {
    file: client,
    label: "the menu opens as a popup over the list",
    suites: ['test/client.test.mjs'],
    from: ".dsse-row-menu{display:grid;gap:1px;margin:0 0 2px 22px;padding:3px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.1));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 3px rgba(15,17,21,.06)}",
    to: ".dsse-row-menu{position:absolute;display:grid;gap:1px;margin:0 0 2px 22px;padding:3px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.1));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 3px rgba(15,17,21,.06)}",
    why: "the card is overflow:hidden and the list is overflow-y:auto, so a menu positioned outside that box is cut off exactly when the list is long enough to need it -- and the long list is the case this exists for",
  },
  {
    file: client,
    label: "the menu prints the path beside the label again",
    suites: ['test/client.test.mjs'],
    from: "                              children: jsx('span', { className: 'dsse-row-menuitem-label', children: label }),",
    to: "                              children: [jsx('span', { className: 'dsse-row-menuitem-label', children: label }), jsx('span', { className: 'dsse-row-menuitem-value', children: target })],",
    why: "a long path can only be shown truncated, and a truncated path describes the clipboard's contents worse than the label does; it also makes the two entries different widths, which moves the eye away from the choice",
  },
  {
    file: client,
    label: "the menu stays open behind the choice",
    suites: ['test/client.test.mjs'],
    from: "                                copyPath(key, target)\n                                setMenuFor(undefined)",
    to: "                                copyPath(key, target)",
    why: "after choosing, the menu covers the rows below the one it belongs to and the flash lands on a control the reader cannot see; leaving it open also makes the second entry look unresponsive",
  },
  {
    file: client,
    label: "the row highlight promises a click the opener does not take",
    suites: ['test/client.test.mjs'],
    from: ".dsse-row-open{display:flex;align-items:center;gap:6px;flex:1;min-width:0;margin:-2px -6px;padding:2px 6px;align-self:stretch;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
    to: ".dsse-row-open{display:flex;align-items:center;gap:6px;flex:1;min-width:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
    why: "splitting the row moved the click target inward; without the negative margin the 28px highlight covers about 20px of button. No layout-free renderer can see it, so the sheet is the only witness.",
  },
  {
    file: client,
    label: "the control cannot recognise its own icon as itself",
    suites: ['test/client.test.mjs'],
    from: `          const onButton = target != null && (
            typeof target.closest === 'function'
              ? target.closest('[data-dsse-copy="true"]') !== null
              : target?.dataset?.dsseCopy === 'true'
          )`,
    to: "          const onButton = target?.dataset?.dsseCopy === 'true'",
    why: "the only thing a browser ever hands over is a <path> inside the 22px box, so reading the marker off the hit node makes the icon look like a press elsewhere: the menu closes on mousedown and the click behind it reopens, and the control can no longer close what it opened",
  },
  {
    file: client,
    label: "choosing an entry drops focus on the floor",
    suites: ['test/client.test.mjs'],
    from: "                                if (copyRef.current !== null) copyRef.current.focus()",
    to: "                                copyRef.current = copyRef.current",
    why: "the entry under the cursor is removed by the choice, so without this focus falls to the document body and the outcome written into aria-label is announced to nobody",
  },
  {
    file: client,
    label: "the container claims a widget it does not implement",
    suites: ['test/client.test.mjs'],
    from: "                            role: 'group',",
    to: "                            role: 'menu',",
    why: "role=menu promises arrow-key navigation, a focused entry on open, and Escape returning to the control; none of those exist, and a screen reader that believes the promise stops offering the navigation it would otherwise use",
  },
  {
    file: client,
    label: "the control never says whether its menu is open",
    suites: ['test/client.test.mjs'],
    from: "                            'aria-expanded': open === true ? 'true' : 'false',",
    to: "                            'aria-expanded': 'true',",
    why: "the control keeps a menu behind it, and this attribute is the only thing that tells a screen reader whether the thing it toggles is showing; a constant reads as 'always open', so the reader announces state that is not there",
  },
  {
    file: client,
    label: "the row forgets that its menu is open while the menu is showing",
    suites: ['test/client.test.mjs'],
    from: "                            'data-menu': open === true ? 'true' : 'false',",
    to: "                            'data-menu': 'false',",
    why: "the reveal rule keys off this attribute so the control stays visible while the pointer travels down to the menu; with a constant the button fades out under the cursor and the row stops being able to say what is on screen",
  },
  {
    file: client,
    label: "the tooltip keeps promising a copy after the copy failed",
    suites: ['test/client.test.mjs'],
    from: "                            : copied.ok === true ? '已复制' : '复制失败，剪贴板不可写'",
    to: "                            : '已复制'",
    why: "the icon turns a colour and colour is invisible to a screen reader and to anyone who cannot tell these two hues apart; the tooltip is where the reason ('the clipboard cannot be written') survives, and promising success in it is the one wrong answer",
  },
  {
    file: client,
    label: "the menu opens below the fold and stays there",
    suites: ['test/client.test.mjs'],
    from: "        node.scrollIntoView({ block: 'nearest' })",
    to: "        node.scrollIntoView = node.scrollIntoView",
    why: "the list fits eight rows and scrolls, and the menu is a block under its row, so on the last visible row it is drawn outside the box: the button changes state and nothing appears, and a reader with no scrollbar to grab is looking at a control that seems to do nothing",
  },
  {
    file: client,
    label: "a focused control draws on top of the size it covers",
    suites: ['test/client.test.mjs'],
    from: ".dsse-row[data-actions=\"true\"]:focus-within .dsse-row-copy:not([aria-expanded=\"true\"]){background:var(--dsw-alias-bg-layer-2,#f6f7f9)}",
    to: ".dsse-row[data-actions=\"true\"]:focus-within .dsse-row-copy:not([aria-expanded=\"true\"]){}",
    why: "the twenty-two pixels the button occupies are the same twenty-two the size is right-aligned into, and the button is transparent until hover; with no background of its own a focused row draws the glyph over the number, and '1.2 KB' reads as '1.2 <icon>B'",
  },










  {
    file: api,
    label: 'a guessed path that is not there is called deleted',
    // Measured: only this suite fails under the mutation. The ones this
    // replaces passed with it in place, so they were paying for a run and
    // covering nothing.
    suites: ['test/api.test.mjs'],
    from: '      const status = gone === false ? \'invalid\' : isAbsolute === true ? \'missing\' : \'unresolved\'',
    to: '      const status = gone === false ? \'invalid\' : \'missing\'',
    why: 'this is exactly the defect the fourth status exists for: a record that only kept a relative path was joined to the session root, and ENOENT on that guess was reported as the user having deleted the file',
  },
  {
    file: api,
    label: 'an absolute path that is not there is called unlocatable',
    suites: ['test/api.test.mjs'],
    from: '      const status = gone === false ? \'invalid\' : isAbsolute === true ? \'missing\' : \'unresolved\'',
    to: '      const status = gone === false ? \'invalid\' : \'unresolved\'',
    why: 'the new word must not swallow the case that already worked — an absolute path is not a guess, so ENOENT on it really does mean the file is gone',
  },
  {
    file: api,
    label: 'a directory is called deleted again',
    suites: ['test/api.test.mjs'],
    from: "      return { ...base, status: 'folder', bytes: null, mtimeMs: null }",
    to: "      return { ...base, status: 'missing', bytes: null, mtimeMs: null }",
    why: 'this is the bug the end-to-end run found: a real session listed its own working directory with a line through it, because a folder standing where a file was claimed was reported as a deletion',
  },
  {
    file: client,
    label: 'a folder is drawn as a row you can open',
    suites: ['test/client.test.mjs'],
    from: "                          const gone =\n                            status === 'missing' || status === 'invalid' || status === 'unresolved' || status === 'folder'",
    to: "                          const gone = status === 'missing' || status === 'invalid' || status === 'unresolved'",
    why: 'the row would offer a preview of a directory, and the click would open nothing -- the same promise `unresolved` was stopped from making',
  
  },
  {
    file: client,
    label: 'a folder is struck through like a deleted one',
    suites: ['test/client.test.mjs'],
    from: ".dsse-row[data-status=\"unresolved\"] .dsse-name,.dsse-row[data-status=\"folder\"] .dsse-name{color:var(--dsw-alias-label-tertiary,#8b92a1)}",
    to: ".dsse-row[data-status=\"unresolved\"] .dsse-name,.dsse-row[data-status=\"folder\"] .dsse-name{text-decoration:line-through;color:var(--dsw-alias-label-tertiary,#8b92a1)}",
    why: 'the strike-through is the claim "this is gone"; a real session got exactly that over its own working directory',
  
  },
  {
    file: client,
    label: 'an unplaceable row reports the size it does not have',
    suites: ['test/client.test.mjs'],
    from: "                                      ? '无法定位'\n                                      : status === 'folder'",
    to: "                                      ? formatBytes(file.bytes)\n                                      : status === 'folder'",
    why: 'a row with no size would print `null` or `0 B` where the reason belongs, telling the reader the file is empty rather than unplaced',
  },
  {
    file: client,
    label: 'a folder reports the size it does not have',
    suites: ['test/client.test.mjs'],
    from: "? '目录'",
    to: '? formatBytes(file.bytes)',
    why: 'a directory has no size to print, and formatBytes(null) renders as a number: the row would claim a folder is an empty file',
  
  },




  {
    file: client,
    suites: ["test/client.test.mjs"],
    label: "the opener invites the click before it says where the file is",
    from: "                                    title: `${hint}\\n点击在侧栏预览`,",
    to: "                                    title: `点击在侧栏预览\\n${hint}`,",
    why: "The invitation belongs last: the path is what a reader hunts for, and a tooltip that opens with a verb buries it. Membership checks cannot see the order, which is why the assertion asks where the sentence ends rather than whether it is present.",
  },

  {
    file: api,
    suites: ['test/api.test.mjs'],
    label: "a record spelled like a redirection is drawn as a deleted file",
    from: "      if (gone === true && cannotBeAPath(path) === true) return null",
    to: "",
    why: "The state file keeps rows the parser no longer produces. Counting with the same predicate this guard uses, the live state directory holds 20 such records in 12 spellings across 12 sessions (`&1`, `/dev/null)`, `2>\\dev\\null`, `--include=*.md`, `&1|head`). Without the refusal they come back as missing, which tells the reader they deleted a file whose name was never a name.",
  },
  {
    file: api,
    suites: ['test/api.test.mjs'],
    label: "a descriptor like &1 is judged to be a file name",
    from: "  return /^&\\d+\\)*$/u.test(tail)",
    to: "  return false",
    why: "Spanning: this is the only clause that stops `&1` from being treated as a name. Measured against the broad mutation that drops the whole row (17 failures), this one fails a check that mutation never fails, so the two are not alternates. Dropping the clause puts `&1` and `&1)` back on the card as deleted files.",
  },
  {
    file: api,
    suites: ["test/api.test.mjs"],
    label: "the spelling is judged before the filesystem is asked",
    from: "    let info\n    try {",
    to: "      if (cannotBeAPath(path) === true) return null\n    let info\n    try {",
    why: "Refusing before stat hides a file the session really wrote whenever its name merely looks like an operator. The injected-readStat assertion fails only under this reordering, so it is the one check standing between the narrow guard and a wide one.",
  },
  {
    file: api,
    suites: ["test/api.test.mjs"],
    label: "a device path is recorded as a deleted file",
    from: "  if (path.startsWith('/dev/') === true) return true",
    to: "",
    why: "The glued-paren spelling `/dev/null)` is what a subshell redirection leaves behind and it exists nowhere, so nothing else in the function catches it once this clause is gone.",
  },




  {
    file: client,
    label: "the card decides for the reader and never lets go",
    suites: ["test/client.test.mjs"],
    from: "      const filesExpanded = filesOpen === null ? nothingStillStands : filesOpen === true",
    to: "      const filesExpanded = filesOpen === null ? false : filesOpen === true",
    why: "Opening itself is a default, not a rule. Starting from `false` instead of `null` means the badge cannot close a card whose rows are all generated — the one card where the reader most wants it out of the way.",
  },
  {
    file: client,
    label: "a card with nothing to count folds anyway",
    suites: ["test/client.test.mjs"],
    from: "      const filesExpanded = filesOpen === null ? nothingStillStands : filesOpen === true",
    to: "      const filesExpanded = filesOpen === true",
    why: "This is the reported failure exactly: every row generated, so the folded list is the first four of an empty list, and the header names a count above nothing. The reader said \"产出文件是空的\" about a turn that produced fourteen files.",
  },
  {
    file: client,
    label: "the grey line says \"besides\" with nothing before it",
    suites: ["test/client.test.mjs"],
    from: "      const filesExpanded = filesOpen === null ? nothingStillStands : filesOpen === true",
    to: "      if (false) {",
    why: "`另有` points at the number before it. With every row generated there is no such number, and the line has to state the whole list instead of referring back to a count the card did not draw.",
  },
  {
    // A stream that answers someone else's conversation wakes every open panel
    // on every event in the application, which is worse than the timer it
    // replaced.
    label: 'a stream forwards changes from another conversation',
    file: api,
    from: `          if (changed !== agentId) return`,
    to: `          if (false) return`,
    suites: ['test/api.test.mjs'],
  },
  {
    // Without the opening frame the client has to ask `/panel` for the number it
    // just subscribed to, and an event landing between the two is lost.
    label: 'a stream opens without saying where it stands',
    file: api,
    from: `  send()

  // \`?? (() => {})\` because`,
    to: `
  // \`?? (() => {})\` because`,
    suites: ['test/api.test.mjs'],
  },
  {
    // The comment line is what commits the headers; without it a browser may not
    // treat the stream as open until the first real frame, which for an idle
    // conversation can be minutes.
    label: 'a stream never commits its headers',
    file: api,
    from: "  res.write(': connected\\n\\n')",
    to: `  void res`,
    suites: ['test/api.test.mjs'],
  },
  {
    // A closed tab that stays subscribed is a listener writing frames into a dead
    // response for the life of the process, once per closed tab.
    label: 'a closed stream keeps its subscription',
    file: api,
    from: `    if (heartbeat !== undefined) clearInterval(heartbeat)
    openStreams.delete(stop)`,
    to: `    if (heartbeat !== undefined) clearInterval(heartbeat)`,
    suites: ['test/api.test.mjs'],
  },
  {
    // Writing after the socket is gone throws inside the host's process.
    label: 'a change after the stream ended is written anyway',
    file: api,
    from: `          if (changed !== agentId) return
          if (finished() === true) return`,
    to: `          if (changed !== agentId) return`,
    suites: ['test/api.test.mjs'],
  },
  {
    // A dispose that leaves streams open hands the browser responses nothing will
    // ever write to again, and `EventSource` retries against a route that has
    // just stopped existing.
    label: 'a dispose leaves its streams open',
    file: api,
    from: `  handle.closeStreams = () => {
    for (const stop of [...openStreams]) stop()`,
    to: `  handle.closeStreams = () => {`,
    suites: ['test/api.test.mjs'],
  },
  {
    // Stopping twice is not hypothetical: the client going away and the dispose
    // both arrive for the same stream.
    label: 'a stopped stream is stopped a second time',
    file: api,
    from: `  const stop = () => {
    if (stopped === true) return
    stopped = true`,
    to: `  const stop = () => {`,
    suites: ['test/api.test.mjs'],
  },
  {
    // Unhooking the listeners is not ending the response. Without this the socket
    // stays open with nothing left holding a reference to it: the server keeps a
    // TCP connection, the browser's `read()` never returns done, and no amount of
    // bookkeeping can reach it again because the `Set` entry is already gone.
    // Measured: `openStreamCount()` was 0 and the connection was still there.
    label: 'a stream is unhooked but never ended',
    file: api,
    from: `    if (typeof res.destroy === 'function' && finished() === false) res.destroy()`,
    to: ``,
    suites: ['test/api.test.mjs'],
  },
  {
    // A POST has nothing to do with a push channel, and the host's own reference
    // implementation answers 405. Accepting one means a caller can hold a stream
    // open with a request body it never finishes sending.
    label: 'a stream answers a POST',
    file: api,
    from: `        if (req.method !== 'GET') {
          return json(res, 405`,
    to: `        if (req.method === 'POST') {
          return json(res, 200`,
    suites: ['test/api.test.mjs'],
  },
  {
    // A stream with nothing to say for an hour is a connection every proxy in
    // between has a reason to drop, and `EventSource` then reconnects in a loop.
    // The comment frame is the only thing keeping it alive, and it is invisible to
    // every client-side test.
    label: 'a stream never says anything while idle',
    file: api,
    from: `    res.write(': heartbeat\\n\\n')`,
    to: ``,
    suites: ['test/api.test.mjs'],
  },
  {
    // The heartbeat is the one timer a stream owns. Left running it keeps writing
    // to a destroyed response for as long as the process lives -- one interval per
    // stream ever opened.
    label: 'a heartbeat outlives the stream that started it',
    file: api,
    from: `    if (heartbeat !== undefined) clearInterval(heartbeat)
    openStreams.delete(stop)`,
    to: `    openStreams.delete(stop)`,
    suites: ['test/api.test.mjs'],
  },

  {
    // A turn beginning moves the payload's `turn` field, so it is a visible change
    // even before anything happens inside the turn.
    label: 'a turn starting wakes nobody',
    file: index,
    from: `      // a fresh turn is a visible change even before anything happens inside it.
      revisions.bump(agentId)`,
    to: `      // a fresh turn is a visible change even before anything happens inside it.`,
    suites: ['test/index.test.mjs'],
  },
  {
    // A turn ending is the event that changes more of the payload than any other.
    label: 'a turn ending wakes nobody',
    file: index,
    from: `      revisions.bump(agentId)
      sessionState.rememberTurn(agentId)`,
    to: `      sessionState.rememberTurn(agentId)`,
    suites: ['test/index.test.mjs'],
  },
  {
    // The MCP module is written by `rememberTool`, and this is its only call site.
    label: 'an MCP tool call wakes nobody',
    file: index,
    from: `    sessionState.rememberTool(agentId, toolName)`,
    to: `    sessionState.rememberTool(agentId, toolName)
    if (false)`,
    suites: ['test/index.test.mjs'],
  },
  {
    // Nothing closes the browser's stream when a session ends -- the page is still
    // there -- so this bump is the only notice the panel ever gets that the
    // conversation it is describing is gone.
    label: 'a session ending wakes nobody',
    file: index,
    from: `    revisions.bump(agentId)
    // Same reason as the speed window`,
    to: `    // Same reason as the speed window`,
    suites: ['test/index.test.mjs'],
  },
  {
    // Approving a candidate moves `pendingCandidates`, which the card draws, and
    // that path touches no session at all -- so the session bus cannot carry it.
    label: 'an approval wakes nobody',
    file: api,
    from: `    if (decision?.ok !== false && typeof deps.panelBump === 'function') deps.panelBump(agentId)`,
    to: ``,
    suites: ['test/api.test.mjs'],
  },
  // ---------------------------------------------------------------------
  // The change counter behind the stream
  // ---------------------------------------------------------------------
  //
  // Every entry here removes something a stream cannot see from the outside:
  // the counter is read once when the stream opens, and after that only its
  // listeners matter, so a broken counter looks exactly like a quiet
  // conversation.
  {
    file: revision,
    label: 'a bump counts without remembering',
    suites: ['test/revision.test.mjs'],
    from: '    const next = (this.sessions.get(agentId) ?? 0) + 1',
    to: '    const next = 1',
    why: 'the counter never advances, so every frame carries the same number and a reader that compared them would never fetch again',
  },
  {
    file: revision,
    label: 'a session nobody bumped reports a position that does not exist',
    suites: ['test/revision.test.mjs'],
    from: '    return this.sessions.get(agentId) ?? 0',
    to: '    return this.sessions.get(agentId) ?? -1',
    why: 'the first frame would announce a position the counter has never been in, and the panel would render a negative revision',
  },
  {
    file: revision,
    label: 'forgetting a session keeps its counter',
    suites: ['test/revision.test.mjs'],
    from: '    this.sessions.delete(agentId)',
    to: '',
    why: 'the map grows by one entry per conversation the person ever opened and never shrinks; nothing throws and nothing looks wrong',
  },
  {
    file: revision,
    label: 'unsubscribing leaves the listener attached',
    suites: ['test/revision.test.mjs'],
    from: '    return () => {\n      this.listeners.delete(listener)\n    }',
    to: '    return () => {}',
    why: 'a closed stream keeps being written to, so the listener set grows with every reconnect that follows a page reload',
  },
  {
    file: revision,
    label: 'a bump with no session is counted anyway',
    suites: ['test/revision.test.mjs'],
    from: "    if (typeof agentId !== 'string' || agentId.length === 0) return 0\n    const next",
    to: '    const next',
    why: 'undefined lands in the map as a key, and every malformed event adds a frame no stream can match to a conversation',
  },
  {
    // The catch is only honest if something hears it. `onError` is the link: a
    // listener that throws goes to the plugin's log, where a person can find it.
    // Deleting the call leaves every suite green before this entry existed, which
    // is how the field ended up declared, documented and never assigned.
    file: revision,
    label: 'a listener that throws fails without saying so',
    suites: ['test/index.test.mjs'],
    from: `        this.onError?.(error, agentId)`,
    to: `        void error`,
    why: 'a stream whose socket died throws on every write; swallowed, the only evidence is a panel that stops updating',
  },
  {
    // The field itself. A plugin that builds the counter without passing its log
    // has an `onError` that is always undefined -- the same defect one layer up.
    file: index,
    label: 'the counter is built without anywhere to report',
    suites: ['test/index.test.mjs'],
    from: `  const revisions = new Revisions({ onError: (error, agentId) => log('stream listener failed for', agentId, '-', error?.message ?? error) })`,
    to: `  const revisions = new Revisions()`,
    why: 'the failing listener is reported to a function nobody supplied, so the catch in bump and the catch in the emit site are the same silence',
  },
  {
    // The opening frame. Without it a client that opens the stream has to also
    // ask `/panel` for the number, and a change landing between the two is a
    // change that never gets reported.
    file: api,
    label: 'a stream never says where it stands',
    suites: ['test/api.test.mjs'],
    from: `  send()
`,
    to: ``,
  },
  {
    // A stream that is stopped twice would unsubscribe a second time and, worse,
    // destroy a response another stream is now using.
    file: api,
    label: 'a stream registered after it could have thrown',
    suites: ['test/api.test.mjs'],
    from: `  openStreams.add(stop)
  if (typeof req.once === 'function') req.once('close', stop)`,
    to: `  if (typeof req.once === 'function') req.once('close', stop)`,
    why: 'the set is the only record a stream has; a response that throws before it goes in can never be ended by a dispose',
  },
  {
    file: revision,
    label: 'one broken listener stops the others',
    suites: ['test/revision.test.mjs'],
    from: '      try {\n        listener(agentId, next)\n      } catch (error) {',
    to: '      if (false) {',
    why: 'the first stream writing into a socket that just died throws out of bump and takes every other listener with it, plus the emit site',
  },
  {
    file: revision,
    label: 'a session is never tracked',
    suites: ['test/revision.test.mjs'],
    from: '    return this.sessions.has(agentId)',
    to: '    return false',
    why: 'the two late answers on the plugin side act on this answer, so always false silently drops the sweep and the summary landing and neither ever reaches the panel',
  },
  {
    file: revision,
    label: 'a session is always tracked',
    suites: ['test/revision.test.mjs'],
    from: '    return this.sessions.has(agentId)',
    to: '    return true',
    why: 'always true resurrects a forgotten counter from every late answer, which is the leak the method exists to prevent',
  },
  {
    file: revision,
    label: 'a reporting callback that throws takes the rest with it',
    suites: ['test/revision.test.mjs'],
    from: `        try {
          this.onError?.(error, agentId)
        } catch {
          // Nothing left to report to, and this is not the emit site's problem.
        }`,
    to: '        this.onError?.(error, agentId)',
    why: 'onError is the caller code too: a logger that throws stops the listeners after it and lands in the host event handler',
  },
  {
    file: index,
    label: 'the summary landing announces nothing',
    suites: ['test/index.test.mjs'],
    from: '            if (revisions.has(agentId) === false) return\n            revisions.bump(agentId)',
    to: '            if (revisions.has(agentId) === false) return',
    why: 'the summary is a field the panel draws, and the frame that carried the turn end still shows the previous turn text: without this the new one waits for the minute clock',
  },
  {
    file: index,
    label: 'a landing after disposal is announced anyway',
    suites: ['test/index.test.mjs'],
    from: '            if (revisions.has(agentId) === false) return\n            revisions.bump(agentId)',
    to: '            revisions.bump(agentId)',
    why: 'the model call outlives its session, and bumping a forgotten counter recreates an entry nothing will ever forget again',
  },
  {
    file: index,
    label: 'a landing with no text still wakes the reader',
    suites: ['test/index.test.mjs'],
    from: "            if (typeof answer?.text !== 'string' || answer.text.length === 0) return",
    to: '            if (answer === null) return',
    why: 'a refusal, a timeout and a cancellation all answer with a value and no text: announcing them redraws a card that already says the summary failed',
  },

  // -------------------------------------------------------------------------
  // The delivery card: a declared document, and nothing else
  // -------------------------------------------------------------------------

  {
    file: deliverable,
    label: 'every declared file is a document',
    suites: ['test/api.test.mjs'],
    from: `  return DELIVERABLE_SUFFIXES.has(name.slice(dot + 1).toLowerCase())`,
    to: `  return true`,
    why: 'the whitelist is the only thing keeping source files off a card whose job is to hand the reader something to open; without it every path the model mentions comes back',
  },
  {
    file: deliverable,
    label: 'a document with no extension is a document',
    suites: ['test/api.test.mjs'],
    from: `  if (dot <= 0) return false`,
    to: `  if (dot <= 0) return true`,
    why: 'a bare name like `Makefile` has no suffix to match, so the whitelist cannot answer for it; letting it through reopens the door the whitelist closes',
  },
  {
    file: deliverable,
    label: 'a directory that only ends in a suffix is a document',
    suites: ['test/api.test.mjs'],
    from: `  if (slashed.endsWith('/') === true) return false`,
    to: `  if (false) return false`,
    why: '`/w/report.pdf/` is a directory named like a document; the trailing slash is the only evidence, because splitting on slashes throws it away',
  },
  {
    file: deliverable,
    label: 'a dependency tree ships its contents',
    suites: ['test/api.test.mjs'],
    from: `    if (UNDELIVERABLE_DIRS.has(folded) === true) return false`,
    to: `    if (false) return false`,
    why: 'a document inside node_modules is a dependency, not something the reader asked for; the directory check is what keeps a package README off the card',
  },
  {
    file: deliverable,
    label: 'an office lock file is a document',
    suites: ['test/api.test.mjs'],
    from: `  if (TEMPORARY_NAME.test(name) === true) return false`,
    to: `  if (false) return false`,
    why: 'a `.docx` being edited leaves a `~$name.docx` beside it; it matches the whitelist, so only the temporary-name rule refuses it',
  },
  {
    file: transcript,
    label: 'a presented path keeps the whitespace around it',
    suites: ['test/transcript.test.mjs'],
    from: `    const path = row.path.trim()`,
    to: `    const path = row.path`,
    why: 'a path with a trailing newline is a different key from the same path without one, so the card would list one file twice',
  },
  {
    file: transcript,
    label: 'a declaration without a description is described as undefined',
    suites: ['test/transcript.test.mjs'],
    from: `    const description = typeof row.description === 'string' ? row.description.trim() : ''`,
    to: `    const description = String(row.description)`,
    why: 'the string "undefined" is truthy, so it reaches the tooltip and the card says the file was delivered as undefined',
  },
  {
    file: transcript,
    label: 'the same file declared twice is two rows',
    suites: ['test/transcript.test.mjs'],
    from: `    const existing = this.delivered.find((entry) => entry.path === absolute)`,
    to: `    const existing = undefined`,
    why: 'a turn that declares a file in two steps would list it twice, and the second row would carry the empty description',
  },

  {
    file: transcript,
    label: 'the declaration no longer outranks the write',
    suites: ['test/transcript.test.mjs'],
    from: `  if (hasDeliverable(declared.map((row) => row.path)) === true) return declared`,
    to: `  if (hasDeliverable(declared.map((row) => row.path)) === true) return [...declared, ...written]`,
    why: 'a turn that hands over two documents and also rewrites thirty sources handed over two; merging the channels buries the two in the thirty',
  },
  {
    file: transcript,
    label: 'a failed write counts as a written file',
    suites: ['test/transcript.test.mjs'],
    from: `    if (entry.ok === false) return
    if (MUTATION_TOOLS.has(entry.name) === false) return`,
    to: `    if (MUTATION_TOOLS.has(entry.name) === false) return`,
    why: 'write against a file the model has not read fails with FS_NOT_OBSERVED; a row for it would name a file that was never written',
  },
  {
    file: transcript,
    label: 'every tool that reported a path is treated as a write',
    suites: ['test/transcript.test.mjs'],
    from: `    if (MUTATION_TOOLS.has(entry.name) === false) return
    const path = readProducedPath(data)`,
    to: `    const path = readProducedPath(data)`,
    why: 'a read result carries meta.path too, and recording it puts every file the turn looked at on the card',
  },
  {
    file: transcript,
    label: 'a path the host did not resolve is guessed at',
    suites: ['test/transcript.test.mjs'],
    from: `  if (ABSOLUTE_PATH.test(trimmed) === false) return undefined
  return trimmed`,
    to: `  return trimmed`,
    why: 'a relative path has no known base here; joining it against a guessed working directory puts the row at a location that has nothing to do with the file',
  },
  {
    file: transcript,
    label: 'the write channel has no ceiling of its own',
    suites: ['test/transcript.test.mjs'],
    from: `    if (this.produced.length < MAX_CARD_PATHS) this.produced.push(absolute)`,
    to: `    this.produced.push(absolute)`,
    why: 'a budget above the sink accepts work it then drops silently; the two numbers have to be one',
  },
  {
    file: transcript,
    label: 'the same file written twice takes two rows',
    suites: ['test/transcript.test.mjs'],
    from: `    if (this.produced.includes(absolute)) return`,
    to: `    if (false) return`,
    why: 'a write followed by an edit is one file, and two rows would claim the turn touched two',
  },
  {
    file: transcript,
    label: 'a new turn inherits the writes of the last one',
    suites: ['test/transcript.test.mjs'],
    from: `    this.calls.clear()
    this.delivered = []
    this.produced = []
    this.commands = []
    this.said = []`,
    to: `    this.calls.clear()
    this.delivered = []
    this.commands = []
    this.said = []`,
    why: 'the list describes one turn; carrying it over makes the card grow backwards through the session',
  },
  {
    file: transcript,
    label: 'the event and the call are not both read',
    suites: ['test/transcript.test.mjs'],
    from: `  if (type === PRESENTED_EVENT) {`,
    to: `  if (false) {`,
    why: 'the event is the structured announcement and the call is the fallback; dropping the event leaves only the argument text, which the host may truncate',
  },
  {
    file: client,
    label: 'the card draws the files it declined',
    suites: ['test/client.test.mjs'],
    from: `      const delivered = ordered.filter((file) => file.deliverable === true)`,
    to: `      const delivered = ordered`,
    why: 'the whole point of the change is that a source file does not reach this card; drawing every row puts it back',
  },
  {
    file: client,
    label: 'a session that delivered nothing still draws a card',
    suites: ['test/client.test.mjs'],
    from: `  const showFiles = delivered.length > 0`,
    to: `  const showFiles = ordered.length > 0`,
    why: 'a card saying "0 个文件 另有 12 个文件不是交付文档" is about what it is not showing; a conversation with nothing to hand over should draw nothing',
  },
  {
    file: client,
    label: 'the header counts the whole record instead of what it drew',
    suites: ['test/client.test.mjs'],
    from: `children: [jsx('b', { children: String(delivered.length) })`,
    to: `children: [jsx('b', { children: String(ordered.length) })`,
    why: 'the number beside the card has to be the rows behind the badge; counting the refused files too makes the two halves not add up',
  },
  {
    file: client,
    label: 'a spreadsheet is drawn as a blank page',
    suites: ['test/client.test.mjs'],
    from: `      if (SHEET_EXTENSIONS.has(ext) === true) return "sheet"`,
    to: `      if (SHEET_EXTENSIONS.has(ext) === true) return "file"`,
    why: 'the card is for documents people open, and a spreadsheet is one of the six shapes it can draw; falling back to the blank page loses the only cue the icon carries',
  },
  {
    file: client,
    label: 'a row hides the sentence it was delivered with',
    suites: ['test/client.test.mjs'],
    from: `const hint = [absolute, said, note].filter((part) => part !== '')`,
    to: `const hint = [absolute, note].filter((part) => part !== '')`,
    why: 'the description is the one field the host gives that Qoder does not have; dropping it leaves the row with a path and nothing about why the file exists',
  },

  {
    file: api,
    label: 'the panel stats the files it is about to throw away',
    suites: ['test/api.test.mjs'],
    from: '    if (onlyDeliverable === true && base.deliverable === false) continue',
    to: '    if (false) continue',
    why: 'nine of every ten rows the panel used to stat were discarded by the card, so the whole cost of the endpoint was spent deciding what not to answer with; the assertion counts stat calls rather than rows, because rows change with the whitelist and the calls only change with the switch',
  },
  {
    file: api,
    label: 'the panel forgets to ask for the switch',
    suites: ['test/api.test.mjs'],
    from: 'onlyDeliverable: true',
    to: 'onlyDeliverable: false',
    why: 'a switch nobody turns on is a comment; the default stays off because the unit tests of statTouchedFiles itself call it with source files and expect them back',
  },
  {
    file: api,
    label: 'a head request reads the whole panel before dropping it',
    suites: ['test/api.test.mjs'],
    from: '        if (headOnly === true) return json(res, 200, { ok: true }, true)',
    to: '        if (false) return json(res, 200, { ok: true }, true)',
    why: 'HEAD exists so a client can ask whether the panel changed without paying for it; answering it by building the panel and discarding the body spends the whole cost to produce nothing',
  },
  {
    file: transcript,
    label: 'the delivered list grows without a ceiling',
    suites: ['test/transcript.test.mjs'],
    from: '      if (this.delivered.length < MAX_DELIVERED_ENTRIES) this.delivered.push({ path: absolute, description: said })',
    to: '      this.delivered.push({ path: absolute, description: said })',
    why: 'the card shows forty rows, and a turn that announces four hundred should not make every later lookup walk four hundred entries; the ceiling keeps the first ones because evicting the oldest would silently change rows the card has already promised',
  },
  {
    file: transcript,
    label: 'the ceiling keeps the last files instead of the first',
    suites: ['test/transcript.test.mjs'],
    from: '      if (this.delivered.length < MAX_DELIVERED_ENTRIES) this.delivered.push({ path: absolute, description: said })',
    to: '      this.delivered.unshift({ path: absolute, description: said })',
    why: 'a ceiling that keeps the newest entries turns the card upside down once a turn is long enough, and the two orders are only distinguishable at the boundary',
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
