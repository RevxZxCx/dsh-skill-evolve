// Prove the checklist assertions can fail.
//
// Each mutation is applied to an in-memory copy, the relevant suites are run, and
// the file is restored from the bytes that were on disk. `git checkout` is never
// used: an earlier review lost a whole round of uncommitted work that way.
//
// Two things in this script exist because they bit me:
//   * anchors are written with LF, so both sides are normalised before matching
//     and each file's own endings are put back afterwards. The tree is all-LF
//     today, but a checkout with core.autocrlf on is not.
//   * a mutation whose anchor does not match is reported as NOT APPLIED and counts
//     as a failure. Otherwise "survived" (a real coverage gap) and "never ran"
//     (a broken script) look identical in the output.

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file, not hard-coded: a fixed path makes the script patch one
// checkout while running another checkout's tests, which reports a genuinely
// killed mutation as SURVIVED.
const repo = fileURLToPath(new URL('..', import.meta.url))

const mutations = [
  {
    label: 'an empty session still draws its chrome',
    file: 'packages/ui-evolve/lib/client.js',
    from: `      if (hasAnyCard === false && error === '') {
        return stillLoading === false`,
    to: `      if (false) {
        return stillLoading === false`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'loading counts as content again',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'const showTurn = turnHasContent',
    to: "const showTurn = state.status === 'loading' || turnHasContent",
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the header stats fall back to the old title-only metadata',
    file: 'packages/ui-evolve/lib/client.js',
    from: "className: 'dsse-head-stats',",
    to: "className: 'dsse-head-stats-gone',",
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the candidates button loses its label',
    file: 'packages/ui-evolve/lib/client.js',
    from: "jsx('span', { children: '建议' }),",
    to: "jsx('span', { children: '' }),",
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a staged approval deletes its row anyway',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'if (outcome?.staged === true) {',
    to: 'if (false) {',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'deciding a row filters by name instead of id',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'list: previous.list.filter((row) => row.id !== id),',
    to: 'list: previous.list.filter((row) => row.name !== name),',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the decide request forgets the session',
    file: 'packages/ui-evolve/lib/client.js',
    from: "const path = props.sessionId === undefined ? '/candidates' : `/candidates?agent=${encodeURIComponent(props.sessionId)}`",
    to: "const path = '/candidates'",
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the dialog close transition collapses to nothing',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'closeTimer.current = setTimeout(props.onClose, 180)',
    to: 'closeTimer.current = setTimeout(props.onClose, 0)',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'candidate search no longer filters the queue',
    file: 'packages/ui-evolve/lib/client.js',
    from: "const visible = needle === ''\n        ? rows.list\n        : rows.list.filter((row) => `${row.name} ${row.description ?? ''}`.toLowerCase().includes(needle))",
    to: 'const visible = rows.list',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the trigger stops announcing that the dialog expanded',
    file: 'packages/ui-evolve/lib/client.js',
    from: "'aria-expanded': open,",
    to: "'aria-expanded': false,",
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a stale row becomes approvable again',
    file: 'packages/ui-evolve/lib/client.js',
    from: "disabled: busy !== '' || row.stale !== undefined",
    to: "disabled: busy !== ''",
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the decide route accepts any content type',
    file: 'packages/ui-evolve/lib/api.js',
    from: 'if (declaredType.length > 0 && !isJson) {',
    to: 'if (false) {',
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'a nameless decision is allowed through',
    file: 'packages/ui-evolve/lib/api.js',
    from: 'if (name.length === 0 && id === undefined) {',
    to: 'if (false) {',
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'the description is sent untruncated',
    file: 'packages/ui-evolve/lib/api.js',
    from: 'description: clampText(row.description, 160),',
    to: "description: String(row.description ?? ''),",
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'the body is sent untruncated',
    file: 'packages/ui-evolve/lib/api.js',
    from: 'body: clampText(row.body, 4000),',
    to: "body: String(row.body ?? ''),",
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'the evidence list stops being capped',
    file: 'packages/ui-evolve/lib/api.js',
    from: '? row.evidence.slice(0, 6).map((entry) => ({',
    to: '? row.evidence.map((entry) => ({',
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'Escape no longer closes the dialog',
    file: 'packages/ui-evolve/lib/client.js',
    from: "if (event?.key === 'Escape') {",
    to: 'if (false) {',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'selecting another candidate stops switching the detail',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'onClick: () => onSelect(row.id),',
    to: 'onClick: () => {},',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the panel stops reading the host font family',
    file: 'packages/ui-evolve/lib/client.js',
    from: "publish('--dsse-font-family', style.fontFamily)",
    to: "publish('--dsse-font-family', '')",
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a refresh failure discards the last good cards',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'setState((prior) => ({ status: "ready", data: prior.data }))',
    to: 'setState({ status: "ready", data: undefined })',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'Tab can escape when focus is outside the dialog',
    file: 'packages/ui-evolve/lib/client.js',
    from: "if (typeof node.contains === 'function' && !node.contains(document.activeElement)) {",
    to: 'if (false) {',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'an older panel response overwrites the newer session',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'if (request !== panelRequest.current || sessionId !== bridge.sessionId) return',
    to: 'if (false) return',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'an older candidate response replaces the latest queue',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'if (request !== loadRequest.current) return',
    to: 'if (false) return',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'an older config response rolls back the latest choice',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'if (request !== configRequest.current) return',
    to: 'if (false) return',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'identical typography is written back and re-triggers the observer',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'if (value && rootStyle.getPropertyValue(name) !== value) rootStyle.setProperty(name, value)',
    to: 'if (value) rootStyle.setProperty(name, value)',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'code element mutations no longer refresh typography',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'if (typographyChanged(mutations)) syncHostTypography()',
    to: 'if (false) syncHostTypography()',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'plugin teardown leaves typography observers and variables behind',
    file: 'packages/ui-evolve/lib/client.js',
    from: '          stopHostTypography()\n',
    to: '',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'MCP servers ignore the shared recency clock',
    file: 'packages/ui-evolve/lib/api.js',
    from: '.sort((a, b) => (b.lastUsed - a.lastUsed) || a.server.localeCompare(b.server))',
    to: '.sort((a, b) => a.server.localeCompare(b.server))',
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'MCP tool calls stop updating recency',
    // The server-name parsing and the recency stamp moved into
    // `lib/session-state.js`; `lib/index.js` now just hands over the full tool
    // name. The anchor moved with the code rather than being loosened.
    file: 'packages/ui-evolve/lib/session-state.js',
    from: '    if (server.length > 0) entry.servers.set(server, ++entry.sequence)',
    to: '    if (false) entry.servers.set(server, ++entry.sequence)',
    suites: ['test/index.test.mjs'],
  },
  {
    label: 'the merged activity list stops sorting by recency',
    file: 'packages/ui-evolve/lib/client.js',
    from: '].sort((a, b) => b.lastUsed - a.lastUsed)',
    to: '].sort(() => 0)',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'an empty activity card is still drawn',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'const showActivity = activity.length > 0',
    to: 'const showActivity = true',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a refused side change leaves the panel on the refused side',
    file: 'packages/ui-evolve/lib/client.js',
    from: "bridge.side = prior?.panelSide === 'right' ? 'right' : 'left'",
    to: 'bridge.side = patch.panelSide',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the decide request forgets which row it came from',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'body: JSON.stringify({ id, name, action }),',
    to: 'body: JSON.stringify({ name, action }),',
    suites: ['test/client.test.mjs'],
  },
  {
    // Two candidates can share a name, and `findByName` prefers the live one, so
    // dropping the id lookup makes a discard aimed at a stale row hit its twin.
    label: 'the decision resolves by name and ignores the id',
    file: 'packages/skill-evolve/lib/index.js',
    from: [
      '    return queue.find((entry) => entry.id === id)',
      '  }',
      '  return findByName(queue, name)',
    ].join('\n'),
    to: [
      '    const exact = queue.find((entry) => entry.id === id)',
      '    if (exact !== undefined) return exact',
      '  }',
      '  return findByName(queue, name)',
    ].join('\n'),
    suites: ['test/review-fixes.test.mjs'],
  },
  // P1 from the review: a manual refresh must not drop the payload it already has.
  {
    label: 'a manual refresh empties the rail while the new answer is in flight',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'if (quiet !== true) setState((prior) => (prior.status === "ready" ? prior : { ...prior, status: "loading" }))',
    to: 'if (quiet !== true) setState((prior) => ({ ...prior, status: "loading" }))',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the queue button is named by something other than the word on it',
    file: 'packages/ui-evolve/lib/client.js',
    from: "'aria-label': '建议 候选审核',",
    to: "'aria-label': '候选审核',",
    suites: ['test/client.test.mjs'],
  },
  // Round two: the fade is a measurement, not a constant, and hidden chrome must
  // not take the settings dialog down with it.
  {
    label: 'the fade is drawn whether or not anything is hidden',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'const hidden = node.scrollHeight > node.clientHeight + 1',
    to: 'const hidden = true',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the fade is never drawn, so clipped text just stops',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'const hidden = node.scrollHeight > node.clientHeight + 1',
    to: 'const hidden = false',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'an empty rail takes the settings dialog down with it',
    file: 'packages/ui-evolve/lib/client.js',
    from: `      if (hasAnyCard === false && error === '') {
        return stillLoading === false
          ? settings`,
    to: `      if (hasAnyCard === false && error === '') {
        return stillLoading === false
          ? null`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'pending candidates stop counting as content',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'const hasAnyCard = showTurn || showActivity || showFiles || pendingCandidates > 0',
    to: 'const hasAnyCard = showTurn || showActivity || showFiles',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the command count is reported as the file count',
    file: 'packages/ui-evolve/lib/client.js',
    from: "jsx('b', { children: String(commands) })",
    to: "jsx('b', { children: String(ordered.length) })",
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'an absent skill half is reported as an empty queue',
    file: 'packages/ui-evolve/lib/api.js',
    from: '    if (Array.isArray(rows) === false) {',
    to: '    if (false) {',
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'a propose with no skill half reports success again',
    file: 'packages/ui-evolve/lib/api.js',
    from: '    if (outcome === undefined) return { ok: false, reason: THE_SKILL_HALF_IS_ABSENT }',
    to: '    if (false) return { ok: false, reason: THE_SKILL_HALF_IS_ABSENT }',
    suites: ['test/api.test.mjs'],
  },
  // Round three: the 上一轮 card grew two reasons to open, the header lost its
  // button, and the cap moved from three lines to five.
  {
    label: 'the summary is capped at three lines again',
    file: 'packages/ui-evolve/lib/client.js',
    from: '.dsse-clip .dsse-text{max-height:9.3em;overflow:hidden}',
    to: '.dsse-clip .dsse-text{max-height:5.2em;overflow:hidden}',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'expanding no longer lifts the cap',
    file: 'packages/ui-evolve/lib/client.js',
    from: '.dsse-clip[data-expanded="true"] .dsse-text{max-height:none}',
    to: '.dsse-clip[data-expanded="true"] .dsse-text{max-height:7.75em}',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the fade is drawn over an expanded summary too',
    file: 'packages/ui-evolve/lib/client.js',
    from: '.dsse-clip[data-clipped="true"][data-expanded="false"]::after{',
    to: '.dsse-clip[data-clipped="true"]::after{',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the click writes the pointer tag, so moving away unpins the card',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'onClick: () => setPinnedTurn(turnPinned === true ? "" : turnId),',
    to: 'onClick: () => setHoverTurn(turnPinned === false ? "" : turnId),',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'hovering no longer expands the card',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'onMouseEnter: () => setHoverTurn(turnId),',
    to: 'onMouseEnter: () => undefined,',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'leaving the card leaves it expanded',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'onMouseLeave: () => setHoverTurn(""),',
    to: 'onMouseLeave: () => undefined,',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a card with nothing hidden still invites a click',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'clickable: turnExpandable,',
    to: 'clickable: true,',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the clip reports its measurement to nobody',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'if (props.onClipped !== undefined) props.onClipped(hidden)',
    to: 'if (false) props.onClipped(hidden)',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'an expanded summary is measured anyway and forgets it was clipped',
    file: 'packages/ui-evolve/lib/client.js',
    from: '        // until the card collapses and measures again.\n        if (expanded) return',
    to: '        // until the card collapses and measures again.\n        if (false) return',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the keyboard cannot reach the card',
    file: 'packages/ui-evolve/lib/client.js',
    from: "if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return",
    to: 'return',
    suites: ['test/client.test.mjs'],
  },
  // Round three: what the first review found. A control that looks inert has to be
  // inert, and the click's reason for being open has to belong to one turn.
  {
    label: 'an inert card still swallows the click and flips a pin nobody can see',
    file: 'packages/ui-evolve/lib/client.js',
    from: '        onClick: interactive === true ? props.onClick : undefined,',
    to: '        onClick: props.onClick,',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the pin outlives the turn it was set on',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'const turnPinned = turnId !== "" && pinnedTurn === turnId',
    to: 'const turnPinned = pinnedTurn !== ""',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the pin is never recorded, so a click cannot hold the card open',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'onClick: () => setPinnedTurn(turnPinned === true ? "" : turnId),',
    to: 'onClick: () => setPinnedTurn(""),',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a measurement of the old summary decides the new card is expandable',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'const turnExpandable = turnId !== "" && clippedTurn === turnId',
    to: 'const turnExpandable = turnId !== ""',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a measurement of nothing hidden never clears, so the card stays clickable',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'setClippedTurn(hidden === true ? turnId : "")',
    to: 'setClippedTurn(turnId)',
    suites: ['test/client.test.mjs'],
  },
  // Round four: what the second review found. The pointer needed the same turn tag
  // the click got, and being open had to depend on the measurement rather than only
  // on a reason for wanting it open.
  {
    label: 'a hover outlives its turn and opens a card nobody is pointing at',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'const turnHovered = turnId !== "" && hoverTurn === turnId',
    to: 'const turnHovered = hoverTurn !== ""',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'hovering records no turn, so the tag can never match',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'onMouseEnter: () => setHoverTurn(turnId),',
    to: 'onMouseEnter: () => setHoverTurn(""),',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a stale reason to open survives because being open ignores the measurement',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'const expanded = turnExpandable === true && turnPinned === true',
    to: 'const expanded = turnHovered === true || turnPinned',
    suites: ['test/client.test.mjs'],
  },
  {
    // The watchdog for the defect the two cards above keep coming back to: a card
    // that renders open has to be closable. It reached the point of passing for a
    // round while checking nothing at all, because the pairs it compared were both
    // closed once hover stopped opening cards. The assertion now states its own
    // premise, so removing the way out has to fail rather than skip.
    label: 'an open card renders without the click that would close it',
    file: 'packages/ui-evolve/lib/client.js',
    from: '        onClick: interactive === true ? props.onClick : undefined,',
    to: '        onClick: undefined,',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a pin ignores which turn it was set on',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'const turnPinned = turnId !== "" && pinnedTurn === turnId',
    to: 'const turnPinned = turnId !== "" && pinnedTurn !== ""',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the measurement is reported without the turn it measured',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'setClippedTurn(hidden === true ? turnId : "")',
    to: 'setClippedTurn("")',
    suites: ['test/client.test.mjs'],
  },
  {
    // A turn number is only unique inside its own session. Without the clear, a tag
    // from one conversation matches the same-numbered turn in the next, and because
    // an open card skips the measurement, nothing ever measures the stale tag away.
    label: 'a turn tag survives into the next conversation',
    file: 'packages/ui-evolve/lib/client.js',
    from: `        setHoverTurn("")
        setPinnedTurn("")
        setClippedTurn("")`,
    to: '',
    suites: ['test/client.test.mjs'],
  },
]

/**
 * Write a source file, retrying briefly when the OS reports the file as busy.
 *
 * A watcher or indexer holding the file made a plain `writeFileSync` throw in the
 * middle of a mutation, which left the mutated source on disk. The restore path
 * matters more than the mutate path: a failed restore is a corrupted checkout.
 *
 * @param {string} path - the file to write.
 * @param {string} content - the exact bytes to restore.
 */
function writeWithRetry(path, content) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(path, content, 'utf8')
      return
    } catch (error) {
      if (attempt === 4) throw error
      const spin = new Date.now() + 200
      while (Date.now() < spin) { /* wait out the transient lock */ }
    }
  }
}

function failures(output) {
  return output.split('\n').filter((line) => line.trimStart().startsWith('FAIL ')).length
}

function run(files) {
  let total = 0
  const detail = []
  for (const file of files) {
    let output = ''
    try {
      output = execFileSync(process.execPath, [join(repo, file)], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
    const count = failures(output)
    total += count
    if (count > 0) detail.push(`${file}: ${count}`)
  }
  return { total, detail: detail.join(' ') }
}

let killed = 0
let survived = 0
let failed = 0
const notes = []

for (const mutation of mutations) {
  const path = join(repo, mutation.file)
  const onDisk = readFileSync(path, 'utf8')
  const windows = onDisk.includes('\r\n')
  const original = windows ? onDisk.split('\r\n').join('\n') : onDisk
  if (original.includes(mutation.from) === false) {
    notes.push(`NOT APPLIED  ${mutation.label} — anchor not found in ${mutation.file}`)
    failed += 1
    continue
  }
  const mutated = original.split(mutation.from).join(mutation.to)
  if (mutated === original) {
    notes.push(`NOT APPLIED  ${mutation.label} — replacement produced identical text`)
    failed += 1
    continue
  }
  try {
    writeWithRetry(path, windows ? mutated.split('\n').join('\r\n') : mutated)
    const result = run(mutation.suites)
    if (result.total > 0) {
      killed += 1
      notes.push(`KILLED       ${mutation.label} — ${result.detail}`)
    } else {
      survived += 1
      notes.push(`SURVIVED     ${mutation.label}`)
    }
  } finally {
    writeWithRetry(path, onDisk)
  }
}

for (const note of notes) console.log(note)
console.log(`\n${killed} killed, ${survived} survived, ${failed} not applied`)
process.exit(survived === 0 && failed === 0 ? 0 : 1)
