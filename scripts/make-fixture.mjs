// Turn a handful of real session files into small, scrubbed fixtures.
//
// Why this exists: `test/real-data.test.mjs` reads the sessions on the machine it
// runs on, so on a clean checkout it skips and proves nothing. The interesting
// shapes — a directory that stat succeeded on, a record spelled like a shell
// redirection, a v1 file whose paths are bare numbers — only occur in records
// that were written by specific builds, and no hand-written fixture would have
// known to include them. So they are copied out of real files, mechanically,
// rather than described from memory.
//
// What is kept: `version`, `state`, `paths`, `sweep`, `turns`, `updated`. That is
// what the store and the panel read. `version` and `state` are not decoration:
// `SessionStore.inspect` refuses a document whose `version` is not its own, and
// `readState` refuses one whose `state` is not a version it reads. A fixture
// missing either is skipped in silence, and every assertion under it then passes
// while testing nothing — which happened once already.
//
// What is dropped: commands, prompts, skill names, tool names, the session id.
// Those are the parts that would carry a person's words into a public repository,
// and no test needs them.
//
// How paths are scrubbed: every absolute root is replaced by a stand-in, chosen
// by the same rule for all of them rather than from a list of the roots I
// happened to think of. The first attempt enumerated two roots and left a third
// (`F:\bot`) untouched, so nine fixture paths pointed at files that really exist
// on this machine and were reported `available` here while being `missing`
// anywhere else. A fixture whose answer depends on the machine is worse than no
// fixture. So: collect every distinct root first, rewrite each to a numbered
// stand-in under a drive that does not exist, and then verify the result — the
// check at the bottom refuses to write anything that still resolves to a real
// path.
//
// Output is stable: keys sorted, two-space indent, one trailing newline. Running
// this twice on the same session files produces byte-identical output, which
// `test/fixture-data.test.mjs` asserts so the extraction cannot drift into hand
// editing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file, not from a hard-coded checkout path.
const repo = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(repo, 'test', 'fixtures')
const SESSIONS = join(process.env.USERPROFILE ?? process.env.HOME, '.dsh', 'plugin-data', 'skill-evolve', 'sessions')

const BS = String.fromCharCode(92)

// Stand-in roots. `D:` is used because the drive does not exist on the machine
// these were taken from, so every stand-in path answers "not there" — which is
// the answer the tests want for a row recorded on a machine that has moved on.
// POSIX stand-ins live under `/fixtures/`, which exists nowhere.
const DRIVE = 'D:'
const POSIX = '/fixtures'

// Sessions to copy, and why each one is here. The reason travels with the
// fixture so a later reader knows which behaviour it is holding down.
const PICKED = [
  {
    source: '31c24e34-a48f-47c4-8a3c-a20ac1439047.json',
    name: 'mixed-states.json',
    state: 3,
    why: 'Six rows, one of each awkward kind: two directories, one record spelled like a shell redirection, one spelled like a glob, one row the diff found, one that is simply gone. This is the file the folder defect was found on.',
  },
  {
    source: '18ca9fd5-3b4d-42c2-bce5-e6690d62ae92.json',
    name: 'relative-paths.json',
    state: 3,
    why: 'Both brackets and both spellings: git-found rows beside scan-found ones, absolute beside relative, a POSIX path beside a Windows one, and a directory reached through a relative guess.',
  },
  {
    source: 'session-fd4b0778-5513-47e7-82aa-e552b7d2612a.json',
    name: 'no-timestamps.json',
    state: 3,
    why: 'Twenty-eight rows carry no recorded time at all, which is the "unknown is not old" branch: they must not be filed under the stale heading.',
  },
  {
    source: '31c0ce26-8dd8-4624-bf41-e27fa7b0a903.json',
    name: 'v1-numbers.json',
    why: 'A document written before per-file records existed: `state: 1`, one path whose value is a bare number, and no sweep at all. It must render, not be refused.',
  },
  {
    source: '001c4812-ec9a-4e1e-8e7b-dff4070f3f45.json',
    name: 'v1-empty.json',
    why: 'The other v1 shape: a document that remembers nothing. The card has to draw nothing rather than an empty box.',
  },
]

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const isSeparator = (character) => character === BS || character === '/'

// The root of an absolute path: the part that names a machine. Written as a scan
// rather than a regular expression because the separators are backslashes, and a
// pattern built by concatenating them is the kind of thing that compiles into
// something other than what it looks like.
//
// A drive path's root is its drive plus the first segment, so two projects on one
// drive stay distinct; a UNC root is server plus share; a POSIX root is the first
// segment; a bare backslash is its own root.
// Directories whose immediate children are people rather than projects. Their
// own name carries no information worth keeping, and the segment under them is
// an account name -- so the root has to reach one level deeper, or the fixture
// ships a username while looking scrubbed.
const HOMES = new Set(['users', 'home', 'documents and settings'])

// Reads one segment of a path, assuming the character before `start` is a
// separator. Returns where the segment ends.
function segmentEnd(path, start) {
  let end = start
  while (end < path.length && isSeparator(path.charAt(end)) === false) end += 1
  return end
}

function rootOf(path) {
  // A bare backslash is the root of whichever drive the process is on. It names
  // no machine and no directory, so there is nothing to scrub and nothing that
  // could differ between machines — handing it back as "no root" leaves it alone.
  if (path === BS) return undefined
  if (path.length > 2 && /[A-Za-z]/u.test(path.charAt(0)) === true && path.charAt(1) === ':' && isSeparator(path.charAt(2)) === true) {
    let end = segmentEnd(path, 3)
    // The account name lives one level below a home directory. Stopping at the
    // home would keep `Users` and hand the fixture a username in its place.
    if (HOMES.has(path.slice(3, end).toLowerCase()) === true && end < path.length) {
      end = segmentEnd(path, end + 1)
    }
    return path.slice(0, end)
  }
  if (path.length > 3 && path.startsWith(BS + BS) === true) {
    let share = 0
    let end = 2
    while (end < path.length) {
      if (isSeparator(path.charAt(end)) === true) {
        share += 1
        if (share === 2) break
      }
      end += 1
    }
    return path.slice(0, end)
  }
  if (path.startsWith('/') === true) {
    let end = 1
    while (end < path.length && path.charAt(end) !== '/') end += 1
    return path.slice(0, end)
  }
  return undefined
}

// The stand-in keeps the root's shape and its separator style, so a trailing
// separator stays trailing and a path that was relative stays relative.
function standInFor(root, index) {
  if (root === BS) return DRIVE + BS
  if (/^[A-Za-z]:/u.test(root) === true) {
    const separator = root.charAt(2)
    return `${DRIVE}${separator}fixture-${index}`
  }
  if (root.startsWith(BS + BS) === true) return `${BS}${BS}fixture-${index}`
  return `${POSIX}${index}`
}

function scrubTargets(documents) {
  // One pass to learn every root, then a stable order, so two runs agree and two
  // roots can never collapse onto one name.
  const roots = new Set()
  for (const document of documents) {
    for (const path of Object.keys(document.paths ?? {})) {
      const root = rootOf(path)
      if (root !== undefined) roots.add(root)
    }
  }
  const ordered = [...roots].sort()
  const table = new Map()
  ordered.forEach((root, index) => table.set(root, standInFor(root, index)))
  return table
}

function scrubPath(path, table) {
  const root = rootOf(path)
  if (root === undefined) return path
  const replaced = table.get(root) ?? root
  return replaced + path.slice(root.length)
}

function stablePathEntry(raw) {
  if (finite(raw) === true) return raw
  const entry = {}
  if (finite(raw.seq) === true) entry.seq = raw.seq
  if (finite(raw.turn) === true) entry.turn = raw.turn
  if (finite(raw.at) === true) entry.at = raw.at
  if (raw.source !== undefined) entry.source = String(raw.source)
  return entry
}

function read(source) {
  return JSON.parse(readFileSync(join(SESSIONS, source), 'utf8'))
}

// Read everything first: the root table is global, so one session's roots must
// not decide how another session's paths are spelled.
const loaded = []
for (const pick of PICKED) {
  try {
    loaded.push({ pick, raw: read(pick.source) })
  } catch (error) {
    console.error(`skipped ${pick.name}: ${error.message}`)
  }
}

const table = scrubTargets(loaded.map((entry) => entry.raw))

let written = 0
let refused = 0
for (const { pick, raw } of loaded) {
  const paths = {}
  for (const key of Object.keys(raw.paths ?? {}).sort()) {
    paths[scrubPath(key, table)] = stablePathEntry(raw.paths[key])
  }
  const document = {
    fixture: {
      why: pick.why,
      extractedFrom: 'a session file under ~/.dsh/plugin-data/skill-evolve/sessions on 2026-11-15',
      scrubbed: 'every absolute root is replaced by a numbered stand-in under D:\\fixture-N or /fixturesN; relative paths, separators and trailing slashes are unchanged',
      dropped: 'previous.commands, previous.said, skills, tools, servers, session id',
      regenerate: 'node scripts/make-fixture.mjs',
    },
    version: raw.version,
    // Three of these fixtures exist to exercise the row pipeline, and this build
    // reads rows only from a document it wrote itself (see `STATE_VERSION` in
    // session-state.js). They are stamped v3 so the pipeline has rows to read at
    // all; the `why` says so, because a fixture claiming to be this build's data
    // while holding a collector's rows is exactly the kind of lie a test cannot
    // see. The two v1 fixtures keep their own version: they prove the legacy path
    // is refused rather than guessed at.
    state: pick.state ?? raw.state,
    turns: finite(raw.turns) === true ? raw.turns : 0,
    paths,
  }
  if (raw.sweep !== undefined) document.sweep = { coverage: raw.sweep.coverage, turn: raw.sweep.turn }
  if (typeof raw.updated === 'string') document.updated = raw.updated

  const body = JSON.stringify(document, null, 2) + '\n'

  // The check that would have caught `F:\bot` on the first attempt. A stand-in
  // that resolves to a real path makes the fixture answer differently on this
  // machine than on any other, and that is the one thing a fixture must not do.
  const resolved = Object.keys(paths).filter((path) => {
    if (/^([A-Za-z]:[\\/]|\/)/u.test(path) === false) return false
    return existsSync(path) === true
  })
  if (resolved.length > 0) {
    console.error(`refused to write ${pick.name}: ${resolved.length} path(s) still resolve on this machine — ${JSON.stringify(resolved.slice(0, 3))}`)
    refused += 1
    continue
  }

  writeFileSync(join(OUT, pick.name), body)
  written += 1
  console.log(`wrote ${pick.name} (${Object.keys(paths).length} paths)`)
}

console.log(`${written} of ${PICKED.length} fixtures written${refused > 0 ? `, ${refused} refused` : ''}`)
if (refused > 0) process.exitCode = 1
