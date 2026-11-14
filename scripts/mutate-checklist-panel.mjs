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
    // This guard stands at both ends of the same loader — the try arm keeps a
    // stale reply from landing, the catch arm keeps a stale failure from landing.
    // The anchor carries the line below it so that it names the try arm alone; a
    // bare guard line matches twice and `split/join` would disable both while
    // claiming to test one.
    from: `if (request !== panelRequest.current || sessionId !== bridge.sessionId) return
            setState({ status: "ready", data })`,
    to: `if (false) return
            setState({ status: "ready", data })`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'an older candidate response replaces the latest queue',
    file: 'packages/ui-evolve/lib/client.js',
    // Matched twice for the same reason as the panel loader above.
    from: `if (request !== loadRequest.current) return
          if (payload?.available === false) {`,
    to: `if (false) return
          if (payload?.available === false) {`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'an older config response rolls back the latest choice',
    file: 'packages/ui-evolve/lib/client.js',
    // Matched twice for the same reason as the panel loader above.
    from: `if (request !== configRequest.current) return
          if (saved?.ok === false) throw new Error(String(saved.reason ?? saved.error ?? 'the setting was refused'))`,
    to: `if (false) return
          if (saved?.ok === false) throw new Error(String(saved.reason ?? saved.error ?? 'the setting was refused'))`,
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
    from: `    return queue.find((entry) => entry.id === id)
  }
  return findByName(queue, name)`,
    to: `    const exact = queue.find((entry) => entry.id === id)
    if (exact !== undefined) return exact
  }
  return findByName(queue, name)`,
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
  // Round: the output card became the session's list of edited files, folded at
  // four rows with the way out on the card, and every row opens a preview.
  {
    label: 'the output card folds at five rows again',
    file: 'packages/ui-evolve/lib/client.js',
    from: '        : [{ key: \'folded\', label: \'\', files: fresh.concat(earlier).slice(0, FOLDED_FILES) }]',
    to: '        : [{ key: \'folded\', label: \'\', files: fresh.concat(earlier).slice(0, 5) }]',
    suites: ['test/client.test.mjs'],
  },
  {
    // Replacing the folded branch outright is not a mutation, it is a syntax
    // error: the ternary keeps a `?` arm and loses its `:`. A suite that cannot
    // parse prints no tally, and the runner records that as "not testable" —
    // which reads exactly like "nothing noticed". So the mutant keeps both arms
    // and simply never takes the open one.
    label: 'the output card is folded even once it is open',
    file: 'packages/ui-evolve/lib/client.js',
    from: '      const groups = filesOpen === true',
    to: '      const groups = false',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the rows are re-sorted by modification time',
    file: 'packages/ui-evolve/lib/client.js',
    from: '      const ordered = files\n',
    to: '      const ordered = files.slice().sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))\n',
    suites: ['test/client.test.mjs'],
  },
  {
    // The list keeps claiming to be open, so a folded card gets a scroll box it
    // does not need and the CSS rule stops matching the state it describes.
    label: 'a folded list claims to be open',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                    className: 'dsse-list dsse-files',
                    'data-open': filesOpen === true ? 'true' : 'false',`,
    to: `                    className: 'dsse-list dsse-files',
                    'data-open': 'true',`,
    suites: ['test/client.test.mjs'],
  },
  {
    // The control disappears. This is the shape DEF-51 described: the header still
    // says how many there are, the list shows four, and nothing says the rest exist.
    label: 'the way out is never drawn at all',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                badgeAction: hiddenFiles > 0 || filesOpen`,
    to: `                badgeAction: false`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a card that already fits still offers to expand',
    file: 'packages/ui-evolve/lib/client.js',
    from: '                badgeAction: hiddenFiles > 0 || filesOpen',
    to: '                badgeAction: ordered.length > 0 || filesOpen',
    suites: ['test/client.test.mjs'],
  },
  {
    // A button that does nothing when pressed promises what the Host cannot do.
    label: 'every row is a button, whether or not it can open anything',
    file: 'packages/ui-evolve/lib/client.js',
    from: '                          const openable = gone === false && canPreview === true && typeof file.address === \'string\' && file.address.length > 0',
    to: '                          const openable = gone === false && typeof file.address === \'string\' && file.address.length > 0',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the rows are never clickable at all',
    file: 'packages/ui-evolve/lib/client.js',
    from: '                          const openable = gone === false && canPreview === true && typeof file.address === \'string\' && file.address.length > 0',
    to: '                          const openable = false',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a row opens the first file instead of its own',
    file: 'packages/ui-evolve/lib/client.js',
    from: '                                    onClick: () => openFile(file.address),',
    to: '                                    onClick: () => openFile(ordered[0].address),',
    suites: ['test/client.test.mjs'],
  },
  {
    // The sidebar throws whenever no conversation is adopted, which happens on
    // every session switch. Without the guard the throw escapes into the render.
    label: 'a preview that fails takes the cards with it',
    file: 'packages/ui-evolve/lib/client.js',
    from: `        try {
          openResource(address)
        } catch {}`,
    to: `        openResource(address)`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the rows advertise a preview they cannot open',
    file: 'packages/ui-evolve/lib/client.js',
    from: '      const canPreview = typeof openResource === \'function\'',
    to: '      const canPreview = true',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the panel never asks whether this host has a sidebar',
    file: 'packages/ui-evolve/lib/client.js',
    from: '      ctx.inject(["sidebarRight"], (child) => {',
    to: '      ctx.inject(["nothingAtAll"], (child) => {',
    suites: ['test/client.test.mjs'],
  },
  {
    // Two resets, one channel. `apply` clears it on the plugin's own teardown and
    // the injected effect clears it on the sidebar's; losing either one leaves the
    // channel bound to a service the Host has already taken away, so a later click
    // reaches an interface that is no longer there. Neither was covered before:
    // the old assertion counted an empty log, which is the same shape as "nothing
    // was ever opened".
    label: 'a torn-down panel keeps its preview channel',
    file: 'packages/ui-evolve/lib/client.js',
    from: `          bridge.open = false
          bridge.listeners.clear()
          openResource = undefined`,
    to: `          bridge.open = false
          bridge.listeners.clear()`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the sidebar effect gives back nothing on teardown',
    file: 'packages/ui-evolve/lib/client.js',
    from: `          () => () => {
            if (openResource !== undefined) openResource = undefined
          },`,
    to: `          () => () => {},`,
    suites: ['test/client.test.mjs'],
  },
  {
    // The card is allowed to hide generated files only because it says so and
    // keeps a way to show them. Each of the three parts is load-bearing: without
    // the flag nothing is classified, without the count the header claims a list
    // it is not showing, and without the gate on the badge a session whose only
    // files are generated would show "0 个文件" with no way in.
    label: 'a dependency is listed as the reader\'s own work',
    file: 'packages/ui-evolve/lib/api.js',
    from: `  if (segments.slice(0, -1).some((segment) => GENERATED_DIRS.has(segment) || scratchName(segment))) return true`,
    to: `  if (false) return true`,
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'a lockfile is listed as the reader\'s own work',
    file: 'packages/ui-evolve/lib/api.js',
    from: `  if (GENERATED_FILES.has(lowerName)) return true`,
    to: `  if (false) return true`,
    suites: ['test/api.test.mjs'],
  },
  {
    // Lowercasing is not length-preserving, so folding the prefix and then cutting
    // the original by the folded length eats a character of the first segment:
    // `node_modules/` reads as `ode_modules/`, matches nothing, and a dependency is
    // listed as the reader's own work.
    label: 'the folded prefix is measured against the original path',
    file: 'packages/ui-evolve/lib/api.js',
    from: '  const scoped = foldedRoot.length > 0 && folded.startsWith(`${foldedRoot}/`) ? folded.slice(foldedRoot.length + 1) : folded',
    to: '  const scoped = foldedRoot.length > 0 && folded.startsWith(`${foldedRoot}/`) ? normalized.slice(foldedRoot.length + 1) : folded',
    suites: ['test/api.test.mjs'],
  },
  {
    // The two halves come from different places and neither normalises: `cwd` is
    // whatever the session header says, the path is whatever the tool argument
    // said. Comparing them case-sensitively declines to strip, falls through to
    // judging every ancestor, and hides the whole list.
    label: 'the workspace prefix is compared case-sensitively',
    file: 'packages/ui-evolve/lib/api.js',
    from: '  const scoped = foldedRoot.length > 0 && folded.startsWith(`${foldedRoot}/`) ? folded.slice(foldedRoot.length + 1) : folded',
    to: '  const scoped = root.length > 0 && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized',
    suites: ['test/api.test.mjs'],
  },
  {
    // The workspace can sit anywhere. `D:/build/mine`, `/build/<repo>` in CI, or
    // the output folder opened directly as a project are all ordinary, and
    // judging the ancestors calls every file inside generated — the card then
    // draws no rows and says "0 个文件" about a session that edited a dozen.
    // The workspace can sit anywhere. `D:/build/mine`, `/build/<repo>` in CI, or
    // the output folder opened directly as a project are all ordinary, and
    // judging the ancestors calls every file inside generated.
    label: 'the directories above the workspace decide too',
    file: 'packages/ui-evolve/lib/api.js',
    from: '  const scoped = foldedRoot.length > 0 && folded.startsWith(`${foldedRoot}/`) ? folded.slice(foldedRoot.length + 1) : folded',
    to: '  const scoped = folded',
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'a directory name only has to contain a generated one',
    file: 'packages/ui-evolve/lib/api.js',
    from: `  if (segments.slice(0, -1).some((segment) => GENERATED_DIRS.has(segment) || scratchName(segment))) return true`,
    to: `  if (normalized.split('/').some((segment) => segment.includes('build'))) return true`,
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'every file counts as written this turn',
    file: 'packages/ui-evolve/lib/api.js',
    from: `    const turn =
      turnPaths !== undefined
        ? turnPaths.has(absolute)
        : Number.isFinite(recordedTurn) && Number.isFinite(turnNow)
          ? recordedTurn === turnNow
          : false`,
    to: `    const turn = true`,
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'a relative path is compared without being resolved',
    file: 'packages/ui-evolve/lib/api.js',
    from: `    turnPaths.add(raw.startsWith('/') || /^[A-Za-z]:[\\\\/]/.test(raw) ? raw : join(cwd ?? process.cwd(), raw))`,
    to: `    turnPaths.add(raw)`,
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'the folded card keeps the list order instead of this turn first',
    file: 'packages/ui-evolve/lib/client.js',
    from: `        : [{ key: 'folded', label: '', files: fresh.concat(earlier).slice(0, FOLDED_FILES) }]`,
    to: `        : [{ key: 'folded', label: '', files: people.slice(0, FOLDED_FILES) }]`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the generated files are mixed in with the reader\'s work',
    file: 'packages/ui-evolve/lib/client.js',
    from: `      const noisy = ordered.filter((file) => file.noise === true)`,
    to: `      const noisy = []`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a card holding only generated files offers no way in',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                badgeAction: hiddenFiles > 0 || filesOpen`,
    to: `                badgeAction: ordered.length > FOLDED_FILES || filesOpen`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the card never opens into groups',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                      'data-group': group.key,`,
    to: `                      'data-group': 'folded',`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the older files are dropped instead of grouped',
    file: 'packages/ui-evolve/lib/client.js',
    from: `            { key: 'earlier', label: earlier.length > 0 && fresh.length > 0 ? '更早' : '', files: earlier },`,
    to: `            { key: 'earlier', label: earlier.length > 0 && fresh.length > 0 ? '更早' : '', files: [] },`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the older group has no heading at all',
    file: 'packages/ui-evolve/lib/client.js',
    from: `            { key: 'earlier', label: earlier.length > 0 && fresh.length > 0 ? '更早' : '', files: earlier },`,
    to: `            { key: 'earlier', label: '', files: earlier },`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the generated group has no heading at all',
    file: 'packages/ui-evolve/lib/client.js',
    from: `            { key: 'noise', label: noisy.length > 0 ? '生成文件' : '', files: noisy },`,
    to: `            { key: 'noise', label: '', files: noisy },`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'every row claims to be generated',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                            'data-noise': file.noise === true ? 'true' : 'false',`,
    to: `                            'data-noise': 'true',`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the group heading is styled as loud as a row',
    file: 'packages/ui-evolve/lib/client.js',
    from: `.dsse-group-label{margin:0;padding:2px 6px 0;color:var(--dsw-alias-label-tertiary,#8b92a1);`,
    to: `.dsse-group-label{margin:0;padding:2px 6px 0;color:red;`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'a generated row looks like every other row',
    file: 'packages/ui-evolve/lib/client.js',
    from: `.dsse-row[data-noise="true"] .dsse-name{color:var(--dsw-alias-label-tertiary,#8b92a1)}`,
    to: ``,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the groups run together with no gap',
    file: 'packages/ui-evolve/lib/client.js',
    from: `.dsse-group + .dsse-group{margin-top:6px}`,
    to: ``,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'an orphaned file is listed with no address',
    file: 'packages/ui-evolve/lib/api.js',
    from: 'address: resourceAddress(sessionId ?? \'\', cwd, absolute),',
    to: 'address: \'\',',
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'a path outside the workspace keeps its absolute form with the separators intact',
    file: 'packages/ui-evolve/lib/api.js',
    // Double-quoted on purpose: the anchor has to contain two literal
    // backslashes, and in a single-quoted literal each pair would already have
    // collapsed to one by the time the anchor is built.
    from: "  const normalized = path.replace(/\\\\/g, '/')",
    to: '  const normalized = path',
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'the session id goes into the address unencoded',
    file: 'packages/ui-evolve/lib/api.js',
    from: '  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encoded}`',
    to: '  return `dsh-resource://file/session/${sessionId}/${encoded}`',
    suites: ['test/api.test.mjs'],
  },
  {
    label: 'the turn fallback is listed oldest first',
    file: 'packages/ui-evolve/lib/api.js',
    from: '  const fallback = newestFirstOf(previous === undefined ? [] : (previous.paths ?? []), false)',
    to: '  const fallback = newestFirstOf(previous === undefined ? [] : (previous.paths ?? []), true)',
    suites: ['test/api.test.mjs'],
  },
  // Round three: the 上一轮 card grew two reasons to open, the header lost its
  // button, and the cap moved from three lines to five.
  {
    label: 'the cards are hidden on every page that is not a conversation',
    file: 'packages/ui-evolve/lib/client.js',
    from: '      if (phase === "hero") return null',
    to: '      if (phase !== "active") return null',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the cards are hidden while a conversation is opening',
    file: 'packages/ui-evolve/lib/client.js',
    from: '      if (phase === "hero") return null',
    to: '      if (phase === "hero" || phase === "settling") return null',
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the cards are drawn on the launcher as well',
    file: 'packages/ui-evolve/lib/client.js',
    from: '      if (phase === "hero") return null',
    to: '      if (phase === "nowhere") return null',
    suites: ['test/client.test.mjs'],
  },
  {
    // The badge is the only visual cue that a summary is folded away. Its words
    // moved onto `aria-label` when it became an icon, so a build that dropped that
    // label would still look right and would announce nothing.
    label: 'the expand button carries no words for a screen reader',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                'aria-label': props.expandHint,`,
    to: `                'aria-label': '',`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the expand button is a line of text again',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                children: jsx(Icon, { name: 'chevron', up: props.expanded === true }),`,
    to: `                children: props.expandHint,`,
    suites: ['test/client.test.mjs'],
  },
  {
    // Positioned against the card, so showing it costs no layout. Putting it back
    // in the flow is the change that used to grow a hovered card by twenty-six
    // pixels and nudge the text below it.
    label: 'the expand button pushes the card taller when it appears',
    file: 'packages/ui-evolve/lib/client.js',
    from: `.dsse-expand{box-sizing:border-box;position:absolute;left:50%;`,
    to: `.dsse-expand{box-sizing:border-box;position:static;`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the expand button is pushed back to the corner',
    file: 'packages/ui-evolve/lib/client.js',
    from: `.dsse-expand{box-sizing:border-box;position:absolute;left:50%;transform:translateX(-50%);`,
    to: `.dsse-expand{box-sizing:border-box;position:absolute;right:8px;`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the expand button is a square',
    file: 'packages/ui-evolve/lib/client.js',
    from: `display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:999px;`,
    to: `display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:4px;`,
    suites: ['test/client.test.mjs'],
  },
  {
    // `pointer-events:none` is what makes a click on the badge a click on the card.
    // Without it the badge is a dead patch inside the one target the card offers.
    label: 'a click on the expand button lands on nothing',
    file: 'packages/ui-evolve/lib/client.js',
    from: `box-shadow:0 1px 3px rgba(15,17,21,.10);user-select:none;pointer-events:none}`,
    to: `box-shadow:0 1px 3px rgba(15,17,21,.10);user-select:none}`,
    suites: ['test/client.test.mjs'],
  },
  {
    // The two badges are different elements — a `div` and a `button` — and the
    // browser gives a button `border-box` but a div `content-box`. Without this
    // declaration the same `width:26px` renders 26px in one card and 28px in the
    // other, which is exactly the mismatch this round was asked to remove.
    label: 'the two badges stop measuring the box the same way',
    file: 'packages/ui-evolve/lib/client.js',
    from: `.dsse-expand{box-sizing:border-box;`,
    to: `.dsse-expand{`,
    suites: ['test/client.test.mjs'],
  },
  {
    // The badge is a real button on this card, not a picture of one. Losing the
    // class takes it out of the lookup entirely, which is what a reader with a
    // keyboard would experience: something on screen that cannot be reached.
    label: 'the badge stops being a control at all',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                className: 'dsse-expand dsse-expand-action',`,
    to: `                className: 'dsse-expand',`,
    suites: ['test/client.test.mjs'],
  },
  {
    // Without the flip the only difference between open and closed is the row
    // count, and the arrow keeps pointing down at a list that is already showing.
    label: 'the badge never turns its chevron over',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                children: jsx(Icon, { name: 'chevron', up: props.badgeAction.open === true }),`,
    to: `                children: jsx(Icon, { name: 'chevron', up: false }),`,
    suites: ['test/client.test.mjs'],
  },
  {
    // Open and closed would announce the same words over a control that does two
    // different things, and "how many more" would stop being said anywhere.
    label: 'the badge says the same thing open and closed',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                'aria-label': props.badgeAction.label,`,
    to: `                'aria-label': '展开',`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the badge forgets whether it is open',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                'aria-expanded': props.badgeAction.open === true,`,
    to: `                'aria-expanded': false,`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the badge answers no click',
    file: 'packages/ui-evolve/lib/client.js',
    from: `                onClick: props.badgeAction.onClick,`,
    to: `                onClick: undefined,`,
    suites: ['test/client.test.mjs'],
  },
  {
    // The strip is only for cards that have a badge. Reserving it unconditionally
    // takes forty-four pixels off every card that fits, which is the empty band
    // the 上一轮 card lost in the same round of work.
    label: 'every card reserves a strip for a badge it may not have',
    file: 'packages/ui-evolve/lib/client.js',
    from: `        'data-badge': props.badgeAction === undefined ? 'false' : 'true',`,
    to: `        'data-badge': 'true',`,
    suites: ['test/client.test.mjs'],
  },
  {
    // The shared rule switches the pointer off so the card-level badge is
    // see-through. This card's badge is the click target, so it has to take the
    // pointer back — without it the badge is a dead patch on a live card.
    label: 'the badge never takes the pointer back',
    file: 'packages/ui-evolve/lib/client.js',
    from: `.dsse-expand-action{pointer-events:auto;`,
    to: `.dsse-expand-action{`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'the badge does not look pressable',
    file: 'packages/ui-evolve/lib/client.js',
    from: `.dsse-expand-action{pointer-events:auto;cursor:pointer;`,
    to: `.dsse-expand-action{pointer-events:auto;`,
    suites: ['test/client.test.mjs'],
  },
  {
    // Same defect as the 上一轮 card's reservation, wearing the new selector: the
    // badge hangs on the bottom edge, which is where the last row of the list it
    // just revealed ends.
    label: 'a card with a badge lets the badge cover its last row',
    file: 'packages/ui-evolve/lib/client.js',
    from: `.dsse-card[data-badge="true"] .dsse-card-body{padding-bottom:44px}`,
    to: ``,
    suites: ['test/client.test.mjs'],
  },
  {
    // The badge hangs on the bottom edge of the card, which is exactly where the
    // last line of a summarised paragraph ends. The open card reserves room for it;
    // without the reservation the badge sits on top of the line it just revealed.
    label: 'an open card lets the badge cover its last line',
    file: 'packages/ui-evolve/lib/client.js',
    from: `.dsse-card[aria-expanded="true"] .dsse-card-body{padding-bottom:44px}`,
    to: ``,
    suites: ['test/client.test.mjs'],
  },
  {
    // Closing has to stay reachable. Gating the badge on the pointer while the card
    // is open hides the way out at the moment the reader is looking for it.
    label: 'an open card hides the way out while the pointer is elsewhere',
    file: 'packages/ui-evolve/lib/client.js',
    from: `      const turnHinted = turnExpandable === true && (turnPinned === true || turnHovered === true)`,
    to: `      const turnHinted = turnExpandable === true && turnHovered === true`,
    suites: ['test/client.test.mjs'],
  },
  {
    label: 'an open card offers to open itself again',
    file: 'packages/ui-evolve/lib/client.js',
    from: `expandHint: turnHinted === true ? (expanded === true ? '点击收起全文' : '点击展开全文') : undefined,`,
    to: `expandHint: turnHinted === true ? '点击展开全文' : undefined,`,
    suites: ['test/client.test.mjs'],
  },
  {
    // The row beside the title describes the turn that just ended, so its file
    // count has to come from `turnFiles`. Reading the cumulative list instead is
    // what shipped the first time, and it made the three numbers beside the title
    // look like one set while one of them was about the whole session.
    label: "the turn header counts the whole session's files",
    file: 'packages/ui-evolve/lib/client.js',
    from: `const turnFiles = Number.isFinite(data?.turnFiles) ? data.turnFiles : 0`,
    to: `const turnFiles = Array.isArray(data?.files) ? data.files.length : 0`,
    suites: ['test/client.test.mjs'],
  },
  {
    // A chevron that points the same way in both states is decoration; the direction
    // is the only thing saying whether the next click opens or closes.
    label: 'the chevron points down even when the card is open',
    file: 'packages/ui-evolve/lib/client.js',
    from: `children: jsx('path', { d: props.up === true ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6' })`,
    to: `children: jsx('path', { d: 'M6 9l6 6 6-6' })`,
    suites: ['test/client.test.mjs'],
  },
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
  {
    // The timer is the panel's only source of news. Shortening the delay turns a
    // glanceable column into a request every tenth of a second, and nothing else
    // in the suite can tell the difference between 8000 and 100.
    label: 'the panel asks again ten times a second',
    file: 'packages/ui-evolve/lib/client.js',
    from: 'const REFRESH_MS = 8000',
    to: 'const REFRESH_MS = 100',
    suites: ['test/client.test.mjs'],
  },
  {
    // A timer that nobody clears keeps polling the session the reader left.
    label: 'the timer outlives the panel that started it',
    file: 'packages/ui-evolve/lib/client.js',
    from: `        const timer = setInterval(() => load(true), REFRESH_MS)
        return () => clearInterval(timer)`,
    to: `        const timer = setInterval(() => load(true), REFRESH_MS)
        return () => {}`,
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
      // `Date.now()` is a number, not a constructor: `new Date.now()` threw here,
      // which is the one branch whose whole job is to keep a lock from leaving
      // mutated source on disk. A throw in the restore path is a corrupted
      // checkout, so this had to be a spin, not a new object.
      const spin = Date.now() + 200
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
