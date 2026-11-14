/**
 * The layer between the accumulators and the disk.
 *
 * Every case here is about a decision the module makes rather than a value it
 * computes: when a write may wait, which fields a file from an older build is
 * allowed to contribute, and what happens to a session the host says is gone.
 * Those are the decisions that fail quietly — a wrong one leaves the panel
 * looking correct while describing a conversation that ended last week.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionStore, VERSION } from '../packages/ui-evolve/lib/session-store.js'
import { SessionState, STATE_VERSION, readState } from '../packages/ui-evolve/lib/session-state.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

/**
 * A state object wired to a throwaway directory.
 *
 * `delayMs: 0` writes at once, because a test that had to wait a second per
 * assertion would be a test nobody runs. The delay is exercised on its own,
 * once, further down.
 */
async function fixture(options = {}) {
  const root = join(tmpdir(), `dsse-session-state-${randomUUID()}`)
  await mkdirp(root)
  const log = []
  const restored = []
  const transcripts = new Map()
  const store = new SessionStore({ root, log: (message) => log.push(message) })
  const state = new SessionState({
    store,
    log: (message, ...rest) => log.push([message, ...rest].join(' ')),
    snapshotOf: (sessionId) => transcripts.get(sessionId),
    restore: (sessionId, snapshot) => restored.push({ sessionId, snapshot }),
    delayMs: options.delayMs ?? 0,
    now: options.now,
  })
  return { state, store, root, log, restored, transcripts }
}

async function mkdirp(path) {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { recursive: true })
}

async function done(root) {
  // A pending write can land between the unlink and the rmdir, which fails the
  // cleanup rather than the assertion. Retrying is honest: removal and the last
  // write really are concurrent here.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
}

async function waitFor(condition, timeoutMs = 4000) {
  // Gates are released by the code under test, so a `setTimeout` long enough
  // to be "sure" is a guess that fails about once in forty runs. Waiting for
  // the condition itself, with a ceiling that reports failure instead of
  // hanging, keeps the block deterministic and keeps a broken expectation
  // printing a FAIL line — a suite that never settles prints no tally, and the
  // mutation runner counts that as a crash rather than as a kill.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition() === true) return true
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return condition() === true
}

async function filesIn(root) {
  try {
    return (await readdir(root)).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// The accumulators are per-session now
// ---------------------------------------------------------------------------

{
  const { state, root } = await fixture()
  state.rememberSkill('s1', 'alpha', 'tool')
  state.rememberTool('s1', 'mcp__zeta__search')
  state.rememberSkill('s2', 'beta', 'gesture')

  check('a skill belongs to the session that loaded it', [...state.skillsUsed('s1').keys()].join(',') === 'alpha', [...(state.skillsUsed('s1') ?? new Map()).keys()].join(','))
  check('another session does not inherit it', [...state.skillsUsed('s2').keys()].join(',') === 'beta', [...(state.skillsUsed('s2') ?? new Map()).keys()].join(','))
  check('an MCP tool belongs to the session that called it', state.toolsSeen('s1').has('mcp__zeta__search') === true)
  check('and not to the other one', state.toolsSeen('s2').has('mcp__zeta__search') === false)
  check('a session nobody touched reports no tools', state.toolsSeen('s3').size === 0)
  check('a session nobody touched reports no skills', state.skillsUsed('s3') === undefined)
  await done(root)
}

{
  // The recency clock is the one thing both lists share, and the panel sorts by
  // it across both. A per-list counter would put every skill below every server
  // regardless of when either was used.
  const { state, root } = await fixture()
  state.rememberSkill('s1', 'alpha', 'tool')
  state.rememberTool('s1', 'mcp__zeta__search')
  state.rememberSkill('s1', 'beta', 'gesture')
  const clock = state.recency('s1')
  check('both lists live on one clock', clock.size === 3, String(clock.size))
  check('the newest skill is the newest entry', (clock.get('skill:beta') ?? 0) > (clock.get('mcp:zeta') ?? 0), `${clock.get('skill:beta')} vs ${clock.get('mcp:zeta')}`)
  check('the server is behind the skill used after it', (clock.get('mcp:zeta') ?? 0) > (clock.get('skill:alpha') ?? 0), `${clock.get('mcp:zeta')} vs ${clock.get('skill:alpha')}`)
  check('an untouched session has an empty clock', state.recency('s2').size === 0)
  await done(root)
}

{
  // A skill first called and then gestured at stays a tool load. The gesture is
  // the weaker evidence: it says the name appeared in a message, not that the
  // skill was invoked, and demoting it would hide it from a panel that filters
  // gestures out.
  const { state, root } = await fixture()
  state.rememberSkill('s1', 'alpha', 'tool')
  state.rememberSkill('s1', 'alpha', 'gesture')
  check('a skill called by name is not demoted by a later gesture', state.skillsUsed('s1').get('alpha') === 'tool', state.skillsUsed('s1').get('alpha'))
  const before = state.recency('s1').get('skill:alpha')
  state.rememberSkill('s1', 'alpha', 'gesture')
  check('but reloading it does move it to the front', (state.recency('s1').get('skill:alpha') ?? 0) > before, `${state.recency('s1').get('skill:alpha')} vs ${before}`)
  await done(root)
}

{
  const { state, root } = await fixture()
  state.rememberSkill('s1', 'alpha', 'gesture')
  state.rememberSkill('s1', 'alpha', 'tool')
  check('a gesture becomes a tool once the skill is actually called', state.skillsUsed('s1').get('alpha') === 'tool', state.skillsUsed('s1').get('alpha'))
  await done(root)
}

{
  const { state, root } = await fixture()
  state.rememberTool('s1', 'not-an-mcp-tool')
  check('a tool that is not an MCP tool is not recorded', state.toolsSeen('s1').size === 0, String(state.toolsSeen('s1').size))
  state.rememberTool('s1', 'mcp__alpha-server__do')
  check('the server name is the middle segment', [...state.recency('s1').keys()].join(',') === 'mcp:alpha-server', [...state.recency('s1').keys()].join(','))
  await done(root)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

{
  const { state, store, root, transcripts } = await fixture()
  transcripts.set('s1', { turns: 3, previous: { turn: 3, calls: 2, paths: ['a.js'], commands: [], said: 'did a thing', tools: [{ name: 'write', count: 2 }] } })
  state.rememberSkill('s1', 'alpha', 'tool')
  state.rememberTool('s1', 'mcp__zeta__search')
  await state.flush('s1')

  const stored = await store.read('s1')
  check('the document carries a version of its own', stored?.state === STATE_VERSION, String(stored?.state))
  check('the finished turn is written down', stored?.previous?.said === 'did a thing', String(stored?.previous?.said))
  check('the turn count is written down', stored?.turns === 3, String(stored?.turns))
  check('the skills are written down', stored?.skills?.alpha?.via === 'tool', JSON.stringify(stored?.skills))
  check('the MCP tools are written down', Array.isArray(stored?.tools) && stored.tools.includes('mcp__zeta__search'), JSON.stringify(stored?.tools))
  check('the servers are written down', typeof stored?.servers?.zeta === 'number', JSON.stringify(stored?.servers))
  await done(root)
}

{
  // A session that loaded nothing and finished no turn has nothing to say. A
  // file per opened conversation is a file the pruner then has to carry.
  const { state, root } = await fixture()
  // Load first: `flush` on an id the module has never heard of returns before it
  // asks for a document, so a test that only flushes would pass for an
  // implementation that wrote a file for every opened conversation.
  await state.load('s1')
  check('loading a session nobody stored installs an empty record', state.skillsUsed('s1').size === 0, String(state.skillsUsed('s1').size))
  await state.flush('s1')
  check('a session with nothing to say writes no file', (await filesIn(root)).length === 0, (await filesIn(root)).join(','))
  await done(root)
}

{
  // Last write wins, with no history beside it.
  const { state, store, root, transcripts } = await fixture()
  transcripts.set('s1', { turns: 1, previous: { turn: 1, calls: 1, paths: [], commands: [], said: 'first', tools: [] } })
  state.rememberSkill('s1', 'alpha', 'tool')
  await state.flush('s1')
  transcripts.set('s1', { turns: 2, previous: { turn: 2, calls: 1, paths: [], commands: [], said: 'second', tools: [] } })
  state.rememberSkill('s1', 'beta', 'tool')
  await state.flush('s1')

  const stored = await store.read('s1')
  check('the newest write is the only one there', stored?.previous?.said === 'second', String(stored?.previous?.said))
  check('and it carries the newest skill set', Object.keys(stored?.skills ?? {}).sort().join(',') === 'alpha,beta', Object.keys(stored?.skills ?? {}).join(','))
  check('there is exactly one file for the session', (await filesIn(root)).length === 1, (await filesIn(root)).join(','))
  check('each write replaces the file rather than growing it', (await readFile(join(root, 's1.json'), 'utf8')).split('\n').filter((line) => line.length > 0).length === 1)
  await done(root)
}

{
  // One second is the promise: a burst of calls is one write, and a write that
  // is still pending does not keep the host alive.
  const { state, root, transcripts } = await fixture({ delayMs: 40 })
  transcripts.set('s1', { turns: 1, previous: { turn: 1, calls: 0, paths: [], commands: [], said: 'x', tools: [] } })
  state.rememberSkill('s1', 'alpha', 'tool')
  state.rememberSkill('s1', 'beta', 'tool')
  state.rememberSkill('s1', 'gamma', 'tool')
  check('nothing is written before the delay elapses', (await filesIn(root)).length === 0, (await filesIn(root)).join(','))
  await new Promise((resolve) => setTimeout(resolve, 120))
  check('one write carries the whole burst', (await filesIn(root)).length === 1, (await filesIn(root)).join(','))
  const stored = await state.store.read('s1')
  check('and it carries all three skills', Object.keys(stored?.skills ?? {}).length === 3, JSON.stringify(Object.keys(stored?.skills ?? {})))
  await done(root)
}

{
  // A flush must not race a pending timer into two writes of the same document.
  // An async method always returns a fresh promise, so identity cannot be the
  // assertion; what matters is how many writes reached the store.
  const { state, root, transcripts } = await fixture({ delayMs: 40 })
  transcripts.set('s1', { turns: 1, previous: { turn: 1, calls: 0, paths: [], commands: [], said: 'x', tools: [] } })
  state.rememberSkill('s1', 'alpha', 'tool')
  let writes = 0
  const write = state.store.write.bind(state.store)
  state.store.write = async (...args) => {
    writes += 1
    return write(...args)
  }
  await Promise.all([state.flush('s1'), state.flush('s1')])
  check('concurrent flushes share one write', writes === 1, `${writes} writes`)
  await new Promise((resolve) => setTimeout(resolve, 80))
  check('and the cancelled timer does not write again', writes === 1, `${writes} writes`)
  check('and there is one file', (await filesIn(root)).length === 1, (await filesIn(root)).join(','))
  await done(root)
}

{
  // A write that fails must not reach the panel: the panel is drawing from
  // memory and a disk problem is not its problem.
  const { state, root, log, transcripts } = await fixture()
  transcripts.set('s1', { turns: 1, previous: { turn: 1, calls: 0, paths: [], commands: [], said: 'x', tools: [] } })
  state.rememberSkill('s1', 'alpha', 'tool')
  // Make the rename fail by putting a directory where the file must go.
  await mkdirp(join(root, 's1.json', 'occupied'))
  await state.flush('s1')
  check('a failed write is logged', log.some((line) => line.includes('could not write')), log.join(' | '))
  check('and the panel can still read what it has', state.skillsUsed('s1')?.get('alpha') === 'tool')
  await done(root)
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

{
  const { state, store, root, restored } = await fixture()
  await store.write('s1', {
    state: STATE_VERSION,
    turns: 7,
    previous: { turn: 7, calls: 4, paths: ['b.js'], commands: ['ls'], said: 'from disk', tools: [] },
    skills: { alpha: { via: 'gesture', at: 3 }, beta: { via: 'tool', at: 9 } },
    tools: ['mcp__zeta__search'],
    servers: { zeta: 9 },
    sequence: 9,
  })

  const loaded = await state.load('s1')
  check('a stored session loads', loaded === true, String(loaded))
  check('its skills come back', [...(state.skillsUsed('s1') ?? new Map()).keys()].sort().join(',') === 'alpha,beta', [...(state.skillsUsed('s1') ?? new Map()).keys()].join(','))
  check('the routes come back with them', (state.skillsUsed('s1') ?? new Map()).get('alpha') === 'gesture', (state.skillsUsed('s1') ?? new Map()).get('alpha'))
  check('its MCP tools come back', state.toolsSeen('s1').has('mcp__zeta__search') === true)
  check('the recency clock is rebuilt from the stored positions', state.recency('s1').get('mcp:zeta') === 9, String(state.recency('s1').get('mcp:zeta')))
  check('the finished turn is handed to the transcript', restored.length === 1 && restored[0].snapshot.previous.said === 'from disk', JSON.stringify(restored))
  check('and it carries the turn count', restored[0]?.snapshot?.turns === 7, String(restored[0]?.snapshot?.turns))
  await done(root)
}

{
  const { state, root } = await fixture()
  const loaded = await state.load('never-stored')
  check('a session with no file loads as nothing', loaded === false, String(loaded))
  check('and reports no skills', (state.skillsUsed('never-stored') ?? new Map()).size === 0, String(state.skillsUsed('never-stored')?.size))
  check('and no tools', state.toolsSeen('never-stored').size === 0)
  await done(root)
}

{
  // Loading is not a reset *and not a fresh start*: events that arrived before
  // the load survive it, and so does everything the file knew. Which of the two
  // used to be lost depended on whether an event or a poll got there first,
  // because a record built by the first event made the load answer "already
  // read" from then on. History was the case that lost.
  const { state, store, root } = await fixture()
  await store.write('s1', { state: STATE_VERSION, skills: { alpha: { via: 'tool', at: 1 } }, tools: ['mcp__zeta__x'], servers: { zeta: 1 }, sequence: 5 })
  state.rememberSkill('s1', 'live', 'tool')
  const loaded = await state.load('s1')
  check('a load merges into a record that already holds facts', loaded === true, String(loaded))
  check('and neither side is dropped', state.skillsUsed('s1')?.has('live') === true && state.skillsUsed('s1')?.has('alpha') === true, [...(state.skillsUsed('s1') ?? new Map()).keys()].join(','))
  check('and the tool the file named is kept', state.toolsSeen('s1').has('mcp__zeta__x') === true, [...state.toolsSeen('s1')].join(','))
  // Recency is one clock per record, and the two did not start together. What
  // the file knew is older than what has happened since, so it is shifted below
  // it rather than compared with it.
  check('and the live fact is still the newest', (state.skillsUsed('s1')?.get('live')) !== undefined && (state.recency('s1')?.get('skill:live') ?? 0) > (state.recency('s1')?.get('skill:alpha') ?? 0), JSON.stringify([...(state.recency('s1') ?? new Map())]))
  const again = await state.load('s1')
  check('and a record that has read is not read again', again === false, String(again))
  await done(root)
}

{
  // A file this build does not understand contributes nothing at all, rather
  // than contributing the fields it happens to share.
  const { state, store, root, restored } = await fixture()
  await store.write('s1', { state: 99, turns: 3, previous: { said: 'future' }, skills: { alpha: { via: 'tool', at: 1 } }, tools: ['mcp__zeta__x'], servers: { zeta: 1 }, sequence: 1 })
  const loaded = await state.load('s1')
  check('a file from another version loads as nothing', loaded === false, String(loaded))
  check('its skills are not believed', (state.skillsUsed('s1') ?? new Map()).size === 0, [...(state.skillsUsed('s1') ?? new Map()).keys()].join(','))
  check('its turn is not restored', restored.length === 0, JSON.stringify(restored))
  await done(root)
}

{
  // Fields are validated one by one. A record with one bad field keeps the
  // others: the alternative is throwing away a whole turn because one skill name
  // arrived as a number.
  const stored = readState({
    state: STATE_VERSION,
    skills: { good: { via: 'tool', at: 1 }, badRoute: { via: 'telepathy', at: 2 }, badAt: { via: 'tool', at: 'later' }, notAnEntry: 5 },
    tools: ['mcp__a__b', 7, ''],
    servers: { a: 1, b: 'nope' },
    sequence: 4,
  })
  check('a good skill survives its bad neighbours', stored.skills.has('good') === true, [...stored.skills.keys()].join(','))
  check('a skill with an unknown route is dropped', stored.skills.has('badRoute') === false, [...stored.skills.keys()].join(','))
  check('a skill with an unusable position is dropped', stored.skills.has('badAt') === false, [...stored.skills.keys()].join(','))
  check('a skill entry that is not a record is dropped', stored.skills.has('notAnEntry') === false, [...stored.skills.keys()].join(','))
  check('a tool name that is not a string is dropped', stored.tools.size === 1 && stored.tools.has('mcp__a__b'), [...stored.tools].join(','))
  check('a server position that is not a number is dropped', stored.servers.size === 1 && stored.servers.has('a'), [...stored.servers.keys()].join(','))
}

{
  const { state, root, log } = await fixture()
  state.rememberSkill('../../escape', 'alpha', 'tool')
  check('an id that cannot be a file name is refused', state.skillsUsed('../../escape') === undefined, String(state.skillsUsed('../../escape')))
  check('and the refusal is visible', log.some((line) => line.includes('cannot be stored')), log.join(' | '))
  check('nothing was written outside the directory', (await filesIn(root)).length === 0, (await filesIn(root)).join(','))
  await done(root)
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

{
  // Disposal is not deletion. The host disposes every agent when it shuts down,
  // so a release that forgot would empty the panel on every restart.
  const { state, store, root, transcripts } = await fixture()
  transcripts.set('s1', { turns: 1, previous: { turn: 1, calls: 0, paths: [], commands: [], said: 'kept', tools: [] } })
  state.rememberSkill('s1', 'alpha', 'tool')
  await state.release('s1')
  check('a released session leaves its file behind', (await filesIn(root)).length === 1, (await filesIn(root)).join(','))
  check('and the file still describes the turn', (await store.read('s1'))?.previous?.said === 'kept', String((await store.read('s1'))?.previous?.said))
  check('but it is gone from memory', state.skillsUsed('s1') === undefined)
  await done(root)
}

{
  const { state, store, root, transcripts } = await fixture()
  transcripts.set('s1', { turns: 1, previous: { turn: 1, calls: 0, paths: [], commands: [], said: 'gone', tools: [] } })
  state.rememberSkill('s1', 'alpha', 'tool')
  await state.flush('s1')
  await state.forget('s1')
  check('forgetting removes the file', (await filesIn(root)).length === 0, (await filesIn(root)).join(','))
  check('forgetting removes the memory too', state.skillsUsed('s1') === undefined)
  check('a forgotten session reads as nothing', (await store.read('s1')) === undefined)
  await done(root)
}

{
  // The host's two answers, wired the way `lib/index.js` wires them.
  const { state, store, root, transcripts } = await fixture()
  for (const id of ['kept', 'archived', 'deleted']) {
    transcripts.set(id, { turns: 1, previous: { turn: 1, calls: 0, paths: [], commands: [], said: id, tools: [] } })
    state.rememberSkill(id, 'alpha', 'tool')
    await state.flush(id)
  }
  check('three files were written', (await filesIn(root)).length === 3, (await filesIn(root)).join(','))

  const removed = await state.prune({
    archived: () => ['archived'],
    known: async (id) => id !== 'deleted',
  })
  check('prune reports what it removed', removed === 2, String(removed))
  check('an archived session loses its file', (await store.read('archived')) === undefined)
  check('a deleted session loses its file', (await store.read('deleted')) === undefined)
  check('a live session keeps its file', (await store.read('kept'))?.previous?.said === 'kept', String((await store.read('kept'))?.previous?.said))
  check('pruning also drops the archived session from memory', state.skillsUsed('archived') === undefined)
  await done(root)
}

{
  // The one failure that would be silent and total: a host that cannot answer
  // being read as a host that says every session is gone.
  const { state, store, root, transcripts, log } = await fixture()
  transcripts.set('s1', { turns: 1, previous: { turn: 1, calls: 0, paths: [], commands: [], said: 'keep me', tools: [] } })
  state.rememberSkill('s1', 'alpha', 'tool')
  await state.flush('s1')

  let asked = 0
  const removed = await state.prune({
    known: async () => {
      asked += 1
      throw new Error('the session list is unavailable')
    },
  })
  check('a host that faults removes nothing', removed === 0, String(removed))
  check('the file is still there', (await store.read('s1'))?.previous?.said === 'keep me', String((await store.read('s1'))?.previous?.said))
  check('the host is asked once, not once per file', asked === 1, String(asked))
  check('and the reason is logged', log.some((line) => line.includes('could not answer')), log.join(' | '))
  await done(root)
}

{
  // The store's own interval applies: pruning everything again on every read
  // would stat the directory per panel poll.
  const { state, store, root, transcripts } = await fixture()
  transcripts.set('s1', { turns: 1, previous: { turn: 1, calls: 0, paths: [], commands: [], said: 'x', tools: [] } })
  state.rememberSkill('s1', 'alpha', 'tool')
  await state.flush('s1')
  let asked = 0
  const sources = {
    known: async () => {
      asked += 1
      return true
    },
  }
  await state.prune(sources)
  await state.prune(sources)
  check('a second prune inside the interval does not ask again', asked === 1, String(asked))
  await done(root)
}

{
  // release and forget are the two the host's shutdown path reaches — one per
  // disposed agent, so two sessions mean two files and neither write waits on
  // the other.
  const { state, store, root, transcripts } = await fixture({ delayMs: 60 })
  for (const id of ['a', 'b']) {
    transcripts.set(id, { turns: 1, previous: { turn: 1, calls: 0, paths: [], commands: [], said: id, tools: [] } })
    state.rememberSkill(id, 'alpha', 'tool')
  }
  await state.release('a')
  await state.release('b')
  check('releasing each session writes its own file', (await filesIn(root)).length === 2, (await filesIn(root)).join(','))
  check('and the first session is readable', (await store.read('a'))?.previous?.said === 'a', String((await store.read('a'))?.previous?.said))
  check('and the second one is too', (await store.read('b'))?.previous?.said === 'b', String((await store.read('b'))?.previous?.said))
  await done(root)
}

{
  // The snapshot a write describes must be the session as it was when the fact
  // arrived, not as it is when the rename happens.
  //
  // The host disposes an agent by calling `release()` and then, synchronously,
  // dropping the transcript. `release()` awaits a flush that may already be in
  // flight; when that write finishes it finds the entry dirty again and writes a
  // second time — by which point the transcript is gone. Asking the transcript
  // in `document()` therefore lets a shutdown turn a finished turn into "no turn
  // yet" and replace a good file with an empty one. Silently: an empty document
  // is a legal document.
  const { state, store, root, transcripts } = await fixture({ delayMs: 40 })
  transcripts.set('s1', { turns: 3, previous: { turn: 3, calls: 2, paths: [], commands: [], said: 'what happened', tools: [] } })
  state.rememberSkill('s1', 'alpha', 'tool')
  // A second fact while the first write is on its way: this is what marks the
  // entry dirty again and makes the second write happen at all.
  state.rememberSkill('s1', 'beta', 'gesture')
  transcripts.delete('s1')
  await state.release('s1')
  const stored = await store.read('s1')
  check('a shutdown still writes the turn it was told about', stored?.previous?.said === 'what happened', String(stored?.previous?.said))
  check('and the count of turns survives with it', stored?.turns === 3, String(stored?.turns))
  check('and the skills are not lost to the same race', Object.keys(stored?.skills ?? {}).sort().join(',') === 'alpha,beta', Object.keys(stored?.skills ?? {}).join(','))
  await done(root)
}

{
  // A session id reaches this module from a query parameter. The store refuses to
  // turn an unsafe one into a path; the memory must refuse it by the same rule, or
  // a caller can mint entries that can never be written and never be pruned — each
  // one a permanent resident of a map nobody can see.
  const { state, store, root } = await fixture({ delayMs: 0 })
  const loaded = await state.load('../../junk-a')
  check('an id that cannot be a file name is not loaded', loaded === false, String(loaded))
  // `skillsUsed` answers undefined for a session with no entry, which is exactly
  // what "did not become a memory entry" looks like from the outside.
  check('and it did not become a memory entry', state.skillsUsed('../../junk-a') === undefined, String(state.skillsUsed('../../junk-a')))
  check('and nothing was written for it', (await store.list()).length === 0, (await store.list()).join(','))
  // A thousand polls with the same junk id must leave the map the size it was.
  // Without the guard each one installed an entry that nothing could ever write
  // or remove: `prune` only drops memory for ids the host calls archived.
  for (let i = 0; i < 1000; i += 1) await state.load('../../junk-a')
  for (let i = 0; i < 50; i += 1) await state.load(`../../junk-${i}`)
  check('and polling it does not accumulate anything', state.bySession.size === 0, String(state.bySession.size))
  // The same id through the accumulator path is refused by `entry()`.
  state.rememberSkill('../../junk-b', 'alpha', 'tool')
  check('the accumulator refuses it too', state.skillsUsed('../../junk-b') === undefined, String(state.skillsUsed('../../junk-b')))
  await done(root)
}

// ---------------------------------------------------------------------------
// A session that was read back and then dropped still remembers its turn
// ---------------------------------------------------------------------------

{
  // The path nobody walks: the panel polls (which loads from disk), then the
  // host shuts down (which disposes the agent, and disposal releases). No new
  // fact arrives in between, so nothing refreshes the snapshot. If `load` left
  // it undefined, the write at disposal is composed from nothing and replaces a
  // finished turn with "no turn yet" — one look at the panel destroys its
  // history, silently, because an empty document is a legal document.
  const { state, store, root } = await fixture()

  const { SessionStore: Store } = await import('../packages/ui-evolve/lib/session-store.js')
  await store.write('s1', {
    state: 1,
    session: 's1',
    turns: 7,
    previous: { turn: 7, said: 'what I did yesterday', calls: 4 },
    skills: { alpha: { via: 'tool', at: 1 } },
    tools: ['mcp__zeta__search'],
    servers: { zeta: 1 },
    sequence: 9
  })
  check('the seed file is on disk', (await filesIn(root)).length === 1, (await filesIn(root)).join(','))

  const loaded = await state.load('s1')
  check('the session is read back', loaded === true, String(loaded))

  // Disposal, with no fact in between.
  await state.release('s1')

  const after = await store.read('s1')
  check('reading a session back and dropping it keeps its finished turn', after?.previous?.said === 'what I did yesterday', JSON.stringify(after?.previous))
  check('and keeps the turn count', after?.turns === 7, String(after?.turns))
  check('and keeps the skills', after?.skills?.alpha?.via === 'tool', JSON.stringify(after?.skills))
  await done(root)
}

// ---------------------------------------------------------------------------
// A pruned file does not come back the next time the agent is disposed
// ---------------------------------------------------------------------------

{
  // The store deletes a file for either of two reasons: the session was
  // archived, or the host says it no longer exists. Memory was only dropped for
  // the first. So the second kind stayed resident, outlived its own file, and
  // the next flush wrote the whole document back — the pruner's work undone by
  // an unrelated disposal.
  const { state, store, root } = await fixture()
  await store.write('gone', {
    state: 1,
    session: 'gone',
    turns: 3,
    previous: { turn: 3, said: 'worth keeping' },
    skills: { beta: { via: 'tool', at: 1 } },
    tools: [],
    servers: {},
    sequence: 2
  })
  await state.load('gone')
  check('the session is in memory after the load', state.bySession.has('gone') === true, String(state.bySession.size))

  const removed = await state.prune({ known: async () => false })
  check('the sweep removed the file', removed === 1, String(removed))
  check('and the file is really gone', (await store.read('gone')) === undefined)
  check('and the memory went with it', state.bySession.has('gone') === false, String(state.bySession.size))

  // The disposal that used to resurrect it.
  await state.release('gone')
  check('disposal does not write the pruned session back', (await store.read('gone')) === undefined, JSON.stringify(await store.read('gone')))
  await done(root)
}

// ---------------------------------------------------------------------------
// A well-formed id that was never a session does not live in memory forever
// ---------------------------------------------------------------------------

{
  // `load` installs an empty record for an id with no file so that a panel poll
  // does not re-read the disk every tick. That record can never be written — it
  // has no facts — so the store never sees it, and no agent will ever dispose it
  // because no agent ever had it. Without the pruner reclaiming it, a caller
  // asking for well-formed but imaginary ids grows that map without bound.
  const { state, store, root } = await fixture()

  await store.write('real', {
    state: 1,
    session: 'real',
    turns: 2,
    previous: { turn: 2, said: 'genuinely here' },
    skills: {},
    tools: [],
    servers: {},
    sequence: 1
  })
  await state.load('real')
  for (let i = 0; i < 200; i += 1) await state.load(`ghost-${i}`)
  check('the ghost ids are installed so the next poll is cheap', state.bySession.size === 201, String(state.bySession.size))

  await state.prune({ known: async () => true })
  check('a sweep reclaims every id that was never a session', state.bySession.has('ghost-0') === false, String(state.bySession.size))
  check('and the one that was a session is still resident', state.bySession.has('real') === true, String(state.bySession.size))

  await done(root)
}

{
  // A record that acquires a fact before its first sweep is no longer
  // discardable. This is the assertion that guards `entry.empty = false`: the
  // record is installed by `load` (so it carries the flag), a fact arrives, and
  // the sweep that follows must keep it. Writing it as "sweep, then give it a
  // fact" would pass either way — the sweep would have deleted the entry, and
  // `entry()` would then build a fresh record with no flag left to clear, so the
  // test would be checking that `entry()` works rather than that the flag does.
  const { state, store, root } = await fixture({ delayMs: 60000 })
  await state.load('later')
  check('a poll installs an empty record for an id with no file', state.bySession.has('later') === true, String(state.bySession.size))
  state.rememberSkill('later', 'gamma', 'tool')
  await state.prune({ known: async () => true })
  check('a record that has a fact survives the sweep that follows it', state.bySession.has('later') === true, String(state.bySession.size))
  check('and the fact is still there to be written', state.skillsUsed('later')?.get('gamma') === 'tool', JSON.stringify([...(state.skillsUsed('later') ?? [])]))
  await state.flush('later')
  const written = await store.read('later')
  check('so the fact reaches the disk', written?.skills?.gamma?.via === 'tool', JSON.stringify(written?.skills))
  await done(root)
}

// ---------------------------------------------------------------------------
// A session that comes back while an older write is still in flight
// ---------------------------------------------------------------------------

{
  // The sweep deleted the session, so the in-flight write's file has to go with
  // it. But the session can be reopened before that write lands, and then the id
  // belongs to a new record that has facts of its own. The two entries are not
  // the same thing as "nobody owns this id": treating them alike deletes what
  // the new record just saved, which is the sweep's job done twice and the
  // panel's memory and its file disagreeing forever after.
  const { state, store, root } = await fixture({ delayMs: 60000 })
  const realWrite = store.write.bind(store)
  // The gate is built before the write that waits on it. Assigning the
  // resolver from inside the write means `openGate` is only a function once
  // the write has arrived; a block that releases the gate on its own timing
  // then throws `TypeError: openGate is not a function` instead of printing a
  // FAIL line. The mutation runner reads a suite with no tally as CRASHED, so
  // the flake would surface as an unkillable mutation rather than as the test
  // bug it is.
  let openGate
  const gate = new Promise((resolve) => { openGate = resolve })
  let parked = false
  let held = false
  store.write = async (sessionId, document) => {
    if (!held && sessionId === 'arms') {
      held = true
      parked = true
      await gate
    }
    return realWrite(sessionId, document)
  }

  state.rememberSkill('arms', 'alpha', 'tool')
  const older = state.flush('arms')
  // The flush loads the disk before it writes, so the record can be swept in
  // that window and the write never starts at all. The case under test is the
  // other order: the write is already at the gate when the sweep arrives.
  const armed = await waitFor(() => parked === true)
  check('the write reached the gate before the sweep ran', armed === true, String(parked))
  await state.prune({ known: async () => false })
  check('the sweep took the record away while its write was in flight', state.bySession.has('arms') === false, String(state.bySession.size))

  state.rememberSkill('arms', 'beta', 'tool')
  await state.flush('arms')
  check('the earlier write parked at the gate', parked === true, String(parked))
  openGate()
  await older

  const after = await store.read('arms')
  check('the older write does not delete the file the newer record saved', after !== undefined, JSON.stringify(after))
  check('and the file describes the facts the panel is showing', after?.skills?.beta?.via === 'tool', JSON.stringify(after?.skills))
  await done(root)
}

// ---------------------------------------------------------------------------
// A write that lands halfway through a sweep does not leave an orphan file
// ---------------------------------------------------------------------------

{
  // The sweep awaits the host between ids. A write landing inside that gap used
  // to see its record still in memory, take that for "still wanted", and leave
  // the file the sweep had already deleted. The record is dropped the moment the
  // file is, so there is no gap to land in.
  const { state, store, root } = await fixture({ delayMs: 60000 })
  await store.write('gone', { skills: {}, tools: [], servers: {}, sequence: 0 })
  await store.write('kept', { skills: {}, tools: [], servers: {}, sequence: 0 })

  const realWrite = store.write.bind(store)
  // Same shape as the gate above, for the same reason: releasing a gate whose
  // resolver has not been assigned yet is a TypeError, and a TypeError prints
  // no tally.
  let openGate
  const gate = new Promise((resolve) => { openGate = resolve })
  let parked = false
  let held = false
  store.write = async (sessionId, document) => {
    if (!held && sessionId === 'gone') {
      held = true
      parked = true
      await gate
    }
    return realWrite(sessionId, document)
  }

  state.rememberSkill('gone', 'alpha', 'tool')
  const landing = state.flush('gone')
  // Same reason as the block above: wait for the write to be in flight before
  // the sweep can remove the record out from under it.
  const armed = await waitFor(() => parked === true)
  check('the write is in flight when the sweep starts', armed === true, String(parked))

  let openSweep
  const sweepGate = new Promise((resolve) => {
    openSweep = resolve
  })
  let sweptFirst = false
  const sweeping = state.prune({
    known: async (sessionId) => {
      if (sessionId === 'kept') await sweepGate
      // Reaching the second id means the first one has been dealt with and the
      // file is gone. That is the gap the held write has to land in.
      sweptFirst = true
      return sessionId !== 'gone'
    },
  })

  // The sweep has to be past the first id and parked on the second before the
  // held write is allowed to land: that gap is the whole subject of the block.
  const swept = await waitFor(() => sweptFirst === true)
  check('the sweep got past the session it deletes', swept === true, String(sweptFirst))
  openGate()
  await landing
  openSweep()
  await sweeping

  check('a write that lands mid-sweep does not leave an orphan file', (await store.read('gone')) === undefined, JSON.stringify(await store.read('gone')))
  check('and the record it belonged to is still gone', state.bySession.has('gone') === false, String(state.bySession.size))
  check('the session the host kept is untouched', (await store.read('kept')) !== undefined, 'missing')
  await done(root)
}

// ---------------------------------------------------------------------------
// A fact that arrives while the load is in flight is the newer truth
// ---------------------------------------------------------------------------

{
  // The load reads the disk, and reading is the only thing it does that takes
  // time. An event landing in that window has already been recorded by
  // `rememberSkill`, which means a record exists in memory holding a fact the
  // file does not have. Installing the file's version over it would be a write
  // of older information, and in the `absent` branch it is worse than that: the
  // replacement record is `empty`, so the fact would not merely be forgotten —
  // the next flush would delete the file it was already written to.
  //
  // The store is wrapped so the fact is delivered from inside the read, which
  // is the exact window and not an approximation of it.
  const { state, store, root } = await fixture({ delayMs: 60000 })
  const realInspect = store.inspect.bind(store)
  let fired = false
  store.inspect = async (sessionId) => {
    const found = await realInspect(sessionId)
    if (fired === false) {
      fired = true
      state.rememberSkill(sessionId, 'alpha', 'tool')
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    return found
  }

  const loaded = await state.load('racing')
  check('a load does not install a record over one that arrived while it read', loaded === false, String(loaded))
  check('and the fact is still there', state.skillsUsed('racing')?.get('alpha') === 'tool', String(state.skillsUsed('racing')?.get('alpha')))
  check('and the record was not downgraded to empty', state.bySession.get('racing')?.empty !== true, String(state.bySession.get('racing')?.empty))

  // The file is written by the record that holds the fact, so shutdown must not
  // take it away.
  await state.release('racing')
  const after = await store.inspect('racing')
  check('and the shutdown kept the file the fact was written to', after.kind === 'present', after.kind)
  check('and the file has the fact in it', after.kind === 'present' ? after.value?.skills?.alpha?.via === 'tool' : false, JSON.stringify(after))
}

// ---------------------------------------------------------------------------
// One read answers both questions, so the two answers cannot disagree
// ---------------------------------------------------------------------------

{
  // The questions are "is a file there?" and "can I use it?". Asking them
  // separately leaves a window where the answers disagree, and both ways of
  // disagreeing are data loss: read "absent" after a file appears and the record
  // installs delete authority over somebody else's state; read "present" after
  // one disappears and a session the sweep already judged keeps its file for the
  // life of the process. `inspect` answers both from one `readFile`, so what the
  // record believes and what the disk said are the same fact by construction.
  //
  // Both halves are here. Without the first, a merged answer that is wrong in
  // the permissive direction looks fine; without the second, one that is wrong
  // in the destructive direction does.
  const { state, store, root } = await fixture({ delayMs: 60000 })

  // A file this build refuses installs a record that owns the id and not the
  // file.
  await writeFile(join(root, 'outsider.json'), JSON.stringify({ version: 1, session: 'outsider', state: 77, skills: { alpha: { via: 'tool', at: 1 } } }), 'utf8')
  await state.load('outsider')
  check('a refused file installs a record with no delete authority', state.bySession.get('outsider')?.empty !== true, String(state.bySession.get('outsider')?.empty))

  // Nothing at all installs a record that does have it — that is what keeps a
  // well-formed id that was never a session from living in memory forever.
  await state.load('never-was')
  check('an absent file installs a record that does', state.bySession.get('never-was')?.empty === true, String(state.bySession.get('never-was')?.empty))

  // An unreadable-but-present file is not "absent". A permission error on a file
  // that is there must be treated like a foreign file: the caller is about to
  // consider deleting it, and "I could not look" is not "there is nothing".
  const realInspect = store.inspect.bind(store)
  store.inspect = async (sessionId) => {
    if (sessionId === 'unreadable') {
      const found = await realInspect(sessionId)
      return found.kind === 'absent' ? { kind: 'foreign' } : found
    }
    return realInspect(sessionId)
  }
  await state.load('unreadable')
  check('a read error is not taken for an empty directory', state.bySession.get('unreadable')?.empty !== true, String(state.bySession.get('unreadable')?.empty))
}

{
  // What a foreign file is owed is that a mere shutdown leaves it alone. What it
  // is not owed is a veto over facts this process goes on to collect: the panel
  // was built on last-write-wins, and a record that refused to write would keep
  // a whole conversation in memory for as long as a file it cannot parse sat
  // under the same name. Both halves are checked here, in that order, because it
  // is the first half that people assume covers the second.
  const { state, store, root } = await fixture()
  const seed = { version: VERSION, session: 's1', state: 99, skills: { older: { via: 'tool', at: 1 } } }
  await store.write('s1', seed)
  const before = await readFile(join(root, 's1.json'), 'utf8')

  await state.load('s1')
  await state.release('s1')
  let after = '<missing>'
  try {
    after = await readFile(join(root, 's1.json'), 'utf8')
  } catch (error) {
    after = `<missing: ${error?.code ?? error}>`
  }
  check('a shutdown leaves a file this build cannot read untouched', after === before, after)

  await state.load('s1')
  state.rememberSkill('s1', 'gamma', 'tool')
  await state.flush('s1')
  const rewritten = await readFile(join(root, 's1.json'), 'utf8').catch((error) => `<missing: ${error?.code ?? error}>`)
  let parsed
  try {
    parsed = JSON.parse(rewritten)
  } catch {
    parsed = undefined
  }
  check('but a fact of its own does replace it', parsed?.state === STATE_VERSION, rewritten)
  check('and the fact is in the file', parsed?.skills?.gamma?.via === 'tool', JSON.stringify(parsed?.skills))
  await done(root)
}

// ---------------------------------------------------------------------------
// A file this build cannot read is somebody else's, and is left alone
// ---------------------------------------------------------------------------

{
  // `readState` answering undefined covers two facts: there is no file, and
  // there is a file this build refuses. Merging them is how a version rollback
  // destroys every session — the older build loads, finds the file unreadable,
  // and deletes it on the next shutdown. Every shape below is one a *different*
  // build could have legitimately written.
  const shapes = {
    'future-state': JSON.stringify({ version: 1, session: 'future-state', state: 999, skills: { alpha: { via: 'tool', at: 1 } } }),
    'future-envelope': JSON.stringify({ version: 2, session: 'future-envelope', skills: { alpha: { via: 'tool', at: 1 } } }),
    'torn-body': '{"version":1,"session":"torn-body","state":1,"skills":{"alp',
    'other-session': JSON.stringify({ version: 1, session: 'not-this-one', state: 1, skills: { alpha: { via: 'tool', at: 1 } } }),
  }
  for (const [name, body] of Object.entries(shapes)) {
    const { state, store, root } = await fixture({ delayMs: 60000 })
    await writeFile(join(root, `${name}.json`), body, 'utf8')

    const loaded = await state.load(name)
    check(`${name}: the file is not believed`, loaded === false, String(loaded))
    check(`${name}: the record that owns the id is not marked empty`, state.bySession.get(name)?.empty !== true, String(state.bySession.get(name)?.empty))

    // Shutdown: `agent/disposed` calls `release`, which flushes before dropping
    // the record. That flush must not carry the delete that an `empty` record
    // would.
    await state.release(name)
    // Read once into a value a `check` can judge. A bare `readFile` throws ENOENT
    // here when the fix is broken, and a suite that dies without printing a FAIL
    // line reads as "nothing was broken" to anything counting failures.
    let after = '<unreadable>'
    try {
      after = await readFile(join(root, `${name}.json`), 'utf8')
    } catch (error) {
      after = `<missing: ${error?.code ?? error}>`
    }
    check(`${name}: the file is still there after shutdown`, after === body, after)
    await done(root)
  }
}

{
  // The other half of the same distinction: with no file at all, the record is
  // marked `empty`, and that is what keeps a well-formed id that was never a
  // session from becoming an unbounded memory entry.
  const { state, root } = await fixture({ delayMs: 60000 })
  const loaded = await state.load('never-here')
  check('a missing file still gets an empty record', loaded === false && state.bySession.get('never-here')?.empty === true, String(loaded))
  await done(root)
}

// ---------------------------------------------------------------------------
// A poll between the sweep and the landing write does not save the file either
// ---------------------------------------------------------------------------

for (const reason of ['gone', 'archived']) {
  const { root, store, state } = await fixture({ delayMs: 60000 })
  const realWrite = store.write.bind(store)
  let openGate
  const gate = new Promise((resolveOfGate) => { openGate = resolveOfGate })
  let armed = false
  store.write = async (sessionId, document) => {
    if (sessionId === 'polled' && armed === false) {
      armed = true
      await gate
    }
    return realWrite(sessionId, document)
  }

  // Remembered, and the write is parked before it can rename.
  state.rememberSkill('polled', 'alpha', 'tool')
  const landing = state.flush('polled')

  // The sweep judges the session dead and removes the file.
  const sources = reason === 'gone' ? { known: async () => false } : { archived: () => ['polled'] }
  await state.prune(sources)
  check(`${reason}: the sweep removed the file`, (await store.read('polled')) === undefined, JSON.stringify(await store.read('polled')))

  // A poll lands in the window. `load` finds nothing and installs an empty
  // record: it has to, or every tick would go back to the file.
  const loaded = await state.load('polled')
  check(`${reason}: the poll installs an empty record`, loaded === false && state.bySession.get('polled')?.empty === true, String(loaded))

  // The parked write lands now. It recreates the file the sweep deleted, and the
  // record that owns the id cannot write anything to say otherwise.
  openGate()
  await landing

  check(`${reason}: the file does not come back`, (await store.read('polled')) === undefined, JSON.stringify(await store.read('polled')))
  check(`${reason}: and no file is left behind`, (await store.list()).length === 0, JSON.stringify(await store.list()))
  await done(root)
}

// ---------------------------------------------------------------------------
// A write that lands after the session was pruned does not put the file back
// ---------------------------------------------------------------------------

{
  // The sweep deletes a file; a write that was already in flight lands after it
  // and recreates the file. The entry being gone is the authority — the panel no
  // longer describes this session — so the write has to take its file with it,
  // or the pruner's decision is quietly reversed and the file lives on for
  // another whole interval.
  for (const sources of [{ known: async () => false }, { archived: () => ['dead'] }]) {
    const { state, store, root } = await fixture({ delayMs: 60000 })
    state.rememberSkill('dead', 'alpha', 'tool')
    // Start the write without waiting for it, so the sweep runs inside it.
    const pending = state.flush('dead')
    await state.prune(sources)
    await pending
    check(`a write in flight does not recreate a pruned file — ${JSON.stringify(Object.keys(sources))}`, (await store.read('dead')) === undefined, JSON.stringify(await store.read('dead')))
    await done(root)
  }
}

// ---------------------------------------------------------------------------
// A turn count with no finished turn is still worth keeping
// ---------------------------------------------------------------------------

{
  // An abandoned turn is deliberately not summarised, so a session can reach
  // turn 4 having never produced a `previous`. The count still belongs to the
  // conversation, and the panel counts turns — so a load that dropped it would
  // make the number go backwards on the next write, for no visible reason.
  const { state, store, root } = await fixture({ delayMs: 60000 })
  await store.write('abandoned', {
    state: 1,
    session: 'abandoned',
    turns: 4,
    skills: { alpha: { via: 'tool', at: 1 } },
    tools: [],
    servers: {},
    sequence: 2
  })
  const loaded = await state.load('abandoned')
  check('a document with only a turn count is loaded', loaded === true, String(loaded))
  state.rememberTool('abandoned', 'mcp__zeta__search')
  await state.flush('abandoned')
  const after = await store.read('abandoned')
  check('the turn count survives a write after loading', after?.turns === 4, String(after?.turns))
  check('and the fact that triggered the write is there too', after?.skills?.alpha?.via === 'tool', JSON.stringify(after?.skills))
  await done(root)
}

// ---------------------------------------------------------------------------
// The output card lists the session's work, so its files outlive the turn
// ---------------------------------------------------------------------------

// These paths used to live in the transcript and described one turn: a turn
// that edited nothing emptied the card, and a turn that touched one file hid
// the rest. The list below is per session, ordered by recency, and has to
// survive both the turn boundary and a restart.
{
  const { state, root } = await fixture()
  state.rememberPaths('files', ['a.js', 'b.js'])
  const names = () => state.pathsSeen('files').map((file) => file.path)
  check('a file is remembered', names().includes('a.js'), JSON.stringify(state.pathsSeen('files')))
  check('the newest file comes first', names()[0] === 'b.js', JSON.stringify(state.pathsSeen('files')))

  // The whole point: a later turn that touches something else does not retire
  // what the earlier turns did.
  state.rememberPaths('files', ['c.js'])
  check('a later turn keeps the earlier files', state.pathsSeen('files').length === 3, JSON.stringify(state.pathsSeen('files')))
  check('and the newest is still first', names()[0] === 'c.js', JSON.stringify(state.pathsSeen('files')))

  // Editing something again moves it forward instead of duplicating it. The
  // delete-before-set is what makes this true: a Map that never deletes keeps
  // the file in its original slot and the list stops being a recency order.
  state.rememberPaths('files', ['a.js'])
  const reordered = state.pathsSeen('files')
  const reorderedNames = reordered.map((file) => file.path)
  check('editing a file again moves it to the front', reorderedNames[0] === 'a.js', JSON.stringify(reordered))
  check('and does not list it twice', reorderedNames.filter((file) => file === 'a.js').length === 1, JSON.stringify(reordered))
  check('and the others keep their order', reorderedNames[1] === 'c.js' && reorderedNames[2] === 'b.js', JSON.stringify(reordered))
  await done(root)
}

{
  // Nothing to record is not a record with a hole in it: values that are not
  // paths are skipped rather than turned into filenames that would be stat'ed
  // later against the working directory.
  const { state, root } = await fixture()
  state.rememberPaths('junk', [null, 42, '', 'kept.js', undefined, {}])
  const seen = state.pathsSeen('junk')
  check('only strings count as paths', seen.length === 1 && seen[0].path === 'kept.js', JSON.stringify(seen))
  state.rememberPaths('junk', [])
  check('an empty list changes nothing', state.pathsSeen('junk').length === 1, JSON.stringify(state.pathsSeen('junk')))
  state.rememberPaths('junk', undefined)
  check('a missing list changes nothing', state.pathsSeen('junk').length === 1, JSON.stringify(state.pathsSeen('junk')))
  check('an unknown session has no files', state.pathsSeen('nobody').length === 0, JSON.stringify(state.pathsSeen('nobody')))
  await done(root)
}

{
  // A session whose only contribution is a written file still has a card to
  // draw. Without paths in `keepsDocument`, the document that holds the very
  // list the reader is looking at would be refused as empty.
  const { state, store, root } = await fixture()
  state.rememberPaths('writes-only', ['out.txt'])
  await state.flush('writes-only')
  const stored = await store.read('writes-only')
  check('a session that only wrote files gets a file', stored !== undefined, String(stored))
  check('and the file it wrote is in it', stored?.paths?.['out.txt'] !== undefined, JSON.stringify(stored?.paths))
  await done(root)
}

{
  // The list has to come back after a restart, in the same order, or the card
  // resets every time the host reloads.
  //
  // The seed's ticks are deliberately not in insertion order: the insertion
  // order of the map is `one, two, three` and the ticks are 9, 2, 5. A merge
  // that hands every remembered file a fresh tick in the order it reads them
  // reproduces the insertion order and nothing else, and with consecutive
  // numbers it would even land on the right values by accident — which is
  // exactly what an earlier version of this fixture did, so the mutation that
  // breaks the shift passed here for a whole run.
  const { state, store, root } = await fixture()
  await store.write('restart', {
    state: STATE_VERSION,
    turns: 1,
    previous: null,
    skills: {},
    tools: [],
    servers: {},
    sequence: 9,
    paths: { 'one.js': 9, 'two.js': 2, 'three.js': 5 }
  })
  // The merge only runs when memory already holds a fact: a brand-new record
  // adopts the file wholesale, and an assertion made after that adoption passes
  // for a merge that never happened. So the restart is driven the way the host
  // drives it — an event first, the read second.
  state.rememberPaths('restart', ['later.js'])
  await state.load('restart')
  const seen = state.pathsSeen('restart')
  check('files survive a restart', seen.length === 4, JSON.stringify(seen))
  const seenNames = seen.map((file) => file.path)
  check(
    'and they keep their order',
    seenNames[0] === 'later.js' && seenNames[1] === 'one.js' && seenNames[2] === 'three.js' && seenNames[3] === 'two.js',
    JSON.stringify(seen)
  )
  // The merge shifts what memory knew above what the file knew, and adds the
  // file's entries at the ticks they were written with. Handing a remembered
  // file a fresh tick instead would claim this process watched an edit it never
  // saw, and the next real edit would have to outbid that claim.
  const merged = state.document('restart')
  check(
    'and they come back on the ticks they were written with',
    merged?.paths?.['one.js']?.seq === 9 && merged?.paths?.['two.js']?.seq === 2 && merged?.paths?.['three.js']?.seq === 5,
    JSON.stringify(merged?.paths)
  )
  check(
    'and the file written before the load is lifted above all of them',
    merged?.paths?.['later.js']?.seq === 10,
    JSON.stringify(merged?.paths)
  )
  check(
    'and the sequence ends one past the file it read',
    state.bySession.get('restart')?.sequence === 10,
    String(state.bySession.get('restart')?.sequence)
  )
  await done(root)
}

{
  // The list had no cap, so it grew for the life of the session — which is one
  // `fs.stat` per entry on every panel read, eight seconds apart, plus a JSON
  // object in the state file that never stops growing. Nothing on screen can use
  // more than a screenful, so the oldest edits are dropped and the newest kept.
  const { state, root } = await fixture()
  const many = []
  for (let index = 0; index < 260; index += 1) many.push(`file-${index}.js`)
  state.rememberPaths('capped', many)
  const kept = state.pathsSeen('capped')
  check('a long session does not remember every file it ever touched', kept.length < many.length, String(kept.length))
  check('and it keeps a screenful worth', kept.length >= 100, String(kept.length))
  check('and the newest edit is the one it keeps first', kept[0]?.path === 'file-259.js', JSON.stringify(kept[0]))
  check('and the oldest is the one that goes', kept.some((file) => file.path === 'file-0.js') === false, JSON.stringify(kept[kept.length - 1]))
  await done(root)
}

{
  // The cap used to live only in `rememberPaths`, so a process that recorded
  // paths before its first `load` — the ordinary "event first, poll later" order
  // — held the file's list plus its own and nothing brought the sum back down.
  // The shutdown write is the merged document, so each restart started from a
  // larger file: three of them measured 400, 600, then 800 paths against a cap of
  // 200, and every panel read was one `fs.stat` per entry.
  const { root } = await fixture()
  const store = new SessionStore({ root, log: () => {} })
  const files = {}
  for (let index = 0; index < 200; index += 1) files[`disk-${index}.js`] = index + 1
  await store.write('merged-cap', { state: STATE_VERSION, turns: 1, previous: null, skills: {}, tools: [], servers: {}, sequence: 300, paths: files })
  const state = new SessionState({
    store,
    log: () => {},
    snapshotOf: () => undefined,
    restore: () => {},
    delayMs: 0,
  })
  const mine = []
  for (let index = 0; index < 200; index += 1) mine.push(`memory-${index}.js`)
  state.rememberPaths('merged-cap', mine)
  await state.load('merged-cap')
  const merged = state.pathsSeen('merged-cap')
  check('a merge does not carry two full lists at once', merged.length <= 200, String(merged.length))
  check('and the memory entries are the ones that survive it', merged.some((file) => file.path === 'memory-199.js'), JSON.stringify(merged[0]))
  const written = state.document('merged-cap')
  check(
    'and the document written back is capped too',
    Object.keys(written?.paths ?? {}).length <= 200,
    String(Object.keys(written?.paths ?? {}).length)
  )
  await done(root)
}

{
  // A file written by a build without the cap — or by the merge path above before
  // it trimmed — must shrink on the way in. Reading it whole would keep it whole:
  // every poll would stat all of its entries and the next write would preserve
  // the excess.
  const { root } = await fixture()
  const store = new SessionStore({ root, log: () => {} })
  const huge = {}
  for (let index = 0; index < 600; index += 1) huge[`stale-${index}.js`] = index + 1
  await store.write('huge-file', { state: STATE_VERSION, turns: 1, previous: null, skills: {}, tools: [], servers: {}, sequence: 700, paths: huge })
  const state = new SessionState({
    store,
    log: () => {},
    snapshotOf: () => undefined,
    restore: () => {},
    delayMs: 0,
  })
  await state.load('huge-file')
  const read = state.pathsSeen('huge-file')
  check('an oversized file is read down to the cap', read.length <= 200, String(read.length))
  check('and the newest entries are the ones kept', read[0]?.path === 'stale-599.js', JSON.stringify(read[0]))
  check('and the oldest are the ones dropped', read.some((file) => file.path === 'stale-0.js') === false, JSON.stringify(read[read.length - 1]))
  await done(root)
}

{
  // A file from an older build was written before this field existed. It is
  // readable, not corrupt: everything it does carry has to load.
  const { root } = await fixture()
  const store = new SessionStore({ root, log: () => {} })
  await store.write('old-build', { state: STATE_VERSION, turns: 3, previous: null, skills: {}, tools: [], servers: {}, sequence: 2 })
  const restored = []
  const state = new SessionState({
    store,
    log: () => {},
    snapshotOf: () => undefined,
    restore: (sessionId, snapshot) => restored.push({ sessionId, snapshot }),
    delayMs: 0,
  })
  await state.load('old-build')
  check('a file without paths still loads its turn count', restored[0]?.snapshot?.turns === 3, JSON.stringify(restored))
  check('and it simply has no files', state.pathsSeen('old-build').length === 0, JSON.stringify(state.pathsSeen('old-build')))
  await done(root)
}

// ---------------------------------------------------------------------------
// A record is empty when there is nothing to write, not when nothing was counted
// ---------------------------------------------------------------------------

// `rememberTurn` records no skill and calls no tool: a conversation whose whole
// value is the sentence it just finished leaves every counter at zero. The sweep
// reads `empty` to decide what nobody authorised, and `flush` reads it to decide
// whether a file under this id was ever authorised. Two different notions of
// "empty" in one record is how a turn-only session ended up writing a file and
// then deleting it inside the same write.
{
  const { state, store, root, transcripts } = await fixture()
  transcripts.set('plain', { turns: 1, previous: { turn: 1, calls: 0, failed: 0, paths: [], commands: [], said: 'hello', tools: [] } })
  state.rememberTurn('plain')
  await state.flush('plain')
  const stored = await store.read('plain')
  check('a session that only talked still gets a file', stored !== undefined, String(stored))
  check('and the turn it finished is in it', stored?.previous?.said === 'hello', JSON.stringify(stored?.previous))
  await done(root)
}

{
  // The same session, swept while its write is in flight. The sweep must not
  // believe it owns a record it is about to authorise writing.
  const { state, store, root, transcripts } = await fixture({ delayMs: 60000 })
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })
  const realWrite = store.write.bind(store)
  store.write = async (sessionId, document) => {
    await gate
    return realWrite(sessionId, document)
  }
  transcripts.set('only-words', { turns: 1, previous: { turn: 1, calls: 0, failed: 0, paths: [], commands: [], said: 'words worth keeping', tools: [] } })
  state.rememberTurn('only-words')
  const pending = state.flush('only-words')
  await new Promise((resolve) => setTimeout(resolve, 10))
  // The host says this session is alive; only the record's own `empty` flag can
  // get it evicted here.
  await state.prune({ known: async () => true })
  check('a sweep keeps a record that only finished a turn', state.bySession.has('only-words') === true, String(state.bySession.size))
  release()
  await pending
  const stored = await store.read('only-words')
  check('and the file it wrote survives its own write', stored !== undefined, String(stored))
  check('with the turn it described', stored?.previous?.said === 'words worth keeping', JSON.stringify(stored?.previous))
  await done(root)
}

// ---------------------------------------------------------------------------
// A read in flight is joined, not repeated
// ---------------------------------------------------------------------------

{
  const { state, store, root, transcripts, restored } = await fixture()
  await store.write('shared', {
    version: 1,
    session: 'shared',
    state: 1,
    turns: 2,
    previous: { turn: 2, calls: 1, failed: 0, paths: [], commands: [], said: 'from the file', tools: [] },
    skills: { alpha: { via: 'tool', at: 1 } },
    tools: [],
    servers: {},
    sequence: 5
  })
  transcripts.set('shared', { turns: 3, previous: { turn: 3, calls: 0, failed: 0, paths: [], commands: [], said: 'from this process', tools: [] } })
  state.rememberSkill('shared', 'live', 'tool')
  const [first, second] = await Promise.all([state.load('shared'), state.load('shared')])
  check('two loads in the same tick both finish', first === true && second === true, `${first}/${second}`)
  const clocks = state.recency('shared')
  // One merge, one shift. Two merges would put `live` at 11 rather than 6.
  check('the merge happened once, not once per caller', clocks.get('skill:live') === 6, String(clocks.get('skill:live')))
  check('the sequence was shifted once', state.bySession.get('shared')?.sequence === 6, String(state.bySession.get('shared')?.sequence))
  check('the turn was handed to the transcript once', restored.filter((item) => item.sessionId === 'shared').length === 1, String(restored.length))
  await done(root)
}

// ---------------------------------------------------------------------------
// A sweep is not undone by the load it waits behind
// ---------------------------------------------------------------------------

{
  const { state, store, root } = await fixture({ delayMs: 60000 })
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })
  const realInspect = store.inspect.bind(store)
  let gated = false
  store.inspect = async (sessionId) => {
    if (sessionId === 'dead' && gated === false) {
      gated = true
      await gate
    }
    return realInspect(sessionId)
  }
  state.rememberSkill('dead', 'alpha', 'tool')
  const pending = state.flush('dead')
  await new Promise((resolve) => setTimeout(resolve, 10))
  await state.prune({ known: async () => false })
  check('a sweep removes a session the host says is gone', state.bySession.has('dead') === false, String(state.bySession.size))
  release()
  await pending
  check('and the write it waited behind does not put it back', state.bySession.has('dead') === false, String(state.bySession.size))
  check('and no file is left behind for it', (await filesIn(root)).length === 0, JSON.stringify(await filesIn(root)))
  await done(root)
}

// ---------------------------------------------------------------------------
// A record that read an empty disk does not delete what another process wrote
// ---------------------------------------------------------------------------

{
  // Two hosts can run against the same `plugin-data` directory: the desktop
  // profile and a CLI session, or two windows. What one process knows about the
  // file is what it read, and that knowledge goes stale the moment anyone else
  // writes. `empty` is a memory of the past, not a claim about the present, so
  // the departure of the process that holds it must not be what decides whether
  // the file is still wanted.
  const root = join(tmpdir(), `dsse-session-state-two-${randomUUID()}`)
  await mkdirp(root)
  const storeA = new SessionStore({ root })
  const storeB = new SessionStore({ root })
  const stateA = new SessionState({ store: storeA, snapshotOf: () => undefined, restore: () => {}, delayMs: 0 })
  const stateB = new SessionState({ store: storeB, snapshotOf: () => undefined, restore: () => {}, delayMs: 0 })

  const loaded = await stateA.load('shared')
  check('the first process finds nothing and remembers that', loaded === false, String(loaded))

  stateB.rememberSkill('shared', 'alpha', 'tool')
  await stateB.flush('shared')
  check('the second process writes the session down', (await storeB.list()).length === 1, JSON.stringify(await storeB.list()))

  await stateA.release('shared')
  const after = await filesIn(root)
  check('the first process does not delete what it never saw', after.length === 1, JSON.stringify(after))
  const kept = await storeB.read('shared')
  check('and the skill the second process recorded is still readable', kept?.skills?.alpha?.via === 'tool', JSON.stringify(kept?.skills))

  await done(root)
}

{
  // The same two processes, and a document whose only content is a turn count.
  // This is the shape D-66 exists for: every turn of the conversation was
  // abandoned, so there is no finished turn and no skill, only the count. The
  // first process read an empty disk before the second wrote, so it holds an
  // `empty` record and on the way out it asks whether the file is an orphan.
  // The answer has to be no — the count is content.
  const root = join(tmpdir(), `dsse-session-state-only-count-${randomUUID()}`)
  await mkdirp(root)
  const storeA = new SessionStore({ root })
  const storeB = new SessionStore({ root })
  const stateA = new SessionState({ store: storeA, snapshotOf: () => undefined, restore: () => {}, delayMs: 0 })
  // The second process finished nothing, so it has no turn to hand back — only
  // a count, which is what `snapshotOf` reports here.
  const stateB = new SessionState({ store: storeB, snapshotOf: () => ({ turns: 4 }), restore: () => {}, delayMs: 0 })

  const loaded = await stateA.load('counted')
  check('the first process reads an empty disk', loaded === false, String(loaded))

  // A turn that ended without completing: `rememberTurn` sees a count, no turn.
  stateB.rememberTurn('counted')
  await stateB.flush('counted')
  const written = await storeB.read('counted')
  check('the second process writes the count down', written?.turns === 4, JSON.stringify(written?.turns))

  await stateA.release('counted')
  const after = await filesIn(root)
  check('a count is not an orphan', after.includes('counted.json') === true, JSON.stringify(after))
  const kept = await storeB.read('counted')
  check('and the count survived the other process leaving', kept?.turns === 4, JSON.stringify(kept?.turns))

  await done(root)
}

{
  // The same shape as the count above, for the newest field: a document whose
  // only fact is the files the session edited. That is a whole class of real
  // session — edits code, loads no skill, calls no MCP tool, has the summary
  // turned off — and it is the file that holds the output card the person is
  // reading. `dropIfOrphan` asks `keepsDocument`, and `keepsDocument` only
  // answers for the fields it is handed: leaving `paths` out of that call made
  // this file deletable by the other process releasing a session it never wrote.
  const root = join(tmpdir(), `dsse-session-state-only-paths-${randomUUID()}`)
  await mkdirp(root)
  const storeA = new SessionStore({ root })
  const storeB = new SessionStore({ root })
  const stateA = new SessionState({ store: storeA, snapshotOf: () => undefined, restore: () => {}, delayMs: 0 })
  const stateB = new SessionState({ store: storeB, snapshotOf: () => undefined, restore: () => {}, delayMs: 0 })

  const loaded = await stateA.load('edited')
  check('the first process reads an empty disk for the edited session', loaded === false, String(loaded))

  stateB.rememberPaths('edited', ['src/a.js'])
  await stateB.flush('edited')
  const written = await storeB.read('edited')
  check('the second process writes only files down', written?.paths?.['src/a.js']?.seq === 1, JSON.stringify(written?.paths))

  await stateA.release('edited')
  const after = await filesIn(root)
  check('a file list is not an orphan', after.includes('edited.json') === true, JSON.stringify(after))
  const kept = await storeB.read('edited')
  check('and the file list survived the other process leaving', kept?.paths?.['src/a.js']?.seq === 1, JSON.stringify(kept?.paths))

  await done(root)
}

{
  const { state, root } = await fixture()
  await state.load('quiet')
  await state.release('quiet')
  check('a session with nothing on disk leaves no file behind', (await filesIn(root)).length === 0, JSON.stringify(await filesIn(root)))

  await done(root)
}

{
  // The third thing a file can hold: a finished turn, and nothing else. A
  // session that only talked has no skills and no tools, so the counters the
  // record used to judge emptiness say "empty" about a document with work in
  // it. The turn is therefore read from the document itself — `readState`
  // answers "what may this build use" and keeps the turn at the top level,
  // outside the shape it returns, so reading it from there would make the
  // guard undefined for every file and this process would unlink a
  // conversation it merely looked at once.
  const root = join(tmpdir(), `dsse-session-state-turn-${randomUUID()}`)
  await mkdirp(root)
  const storeA = new SessionStore({ root })
  const storeB = new SessionStore({ root })
  const stateA = new SessionState({ store: storeA, snapshotOf: () => undefined, restore: () => {}, delayMs: 0 })
  // No second `SessionState` here: the other process writes the document through
  // the store directly, because no live event can produce a file with a finished
  // turn and a count of zero — `counters` only move up, and a turn that finished
  // is the one that ended a turn. A whole document of that shape can still exist
  // on disk, and it does get rewritten unchanged when this build loads and
  // releases it; the seed is written straight through the store because this is
  // the one block that needs the shape without a writer that produces it.
  // Declaring a second `SessionState` anyway read as though both blocks modelled
  // two live processes, and only the block above does.

  const loaded = await stateA.load('talked')
  check('a process that looked at an empty disk remembers that too', loaded === false, String(loaded))

  await storeB.write('talked', {
    version: VERSION,
    session: 'talked',
    state: 1,
    // Zero on purpose. Every file this build writes carries both a count and the
    // turn, so the count normally answers for the turn and hides it. A document
    // that holds the turn and no count is the shape that proves the finished
    // turn is judged on its own merits.
    turns: 0,
    previous: { turn: 3, calls: 1, failed: 0, paths: [], commands: [], said: 'something worth keeping', tools: [] },
    skills: {},
    tools: [],
    servers: {},
    sequence: 0,
  })

  await stateA.release('talked')
  const after = await filesIn(root)
  check('a file that holds only a finished turn is not an orphan', after.length === 1, JSON.stringify(after))
  const kept = await storeB.read('talked')
  check('and the turn it held is still there', kept?.previous?.said === 'something worth keeping', JSON.stringify(kept?.previous?.said))

  await done(root)
}

{
  // The cap is about the directory, not about any conversation. A sweep that
  // dropped the memory record of a *running* session would lose every fact that
  // session has produced and make its next write spell a fragment — a file that
  // looks like a whole document and describes five seconds. So a removal for the
  // cap deletes the file and leaves the record alone; only the host's own
  // judgement that a session is gone clears memory.
  const { state, root } = await fixture()
  const store = state.store
  store.maxFiles = 2

  state.rememberSkill('older', 'alpha', 'tool')
  await state.flush('older')
  await new Promise((resolve) => setTimeout(resolve, 12))
  state.rememberSkill('newer', 'beta', 'tool')
  await state.flush('newer')
  await new Promise((resolve) => setTimeout(resolve, 12))
  state.rememberSkill('running', 'gamma', 'tool')
  await state.flush('running')

  check('all three sessions are on disk', (await filesIn(root)).length === 3, JSON.stringify(await filesIn(root)))

  const removed = await state.prune({ known: async () => true })
  const left = await filesIn(root)
  check('the cap removed the oldest file', removed === 1, String(removed))
  check('and left the two it was allowed to keep', left.join(',') === 'newer.json,running.json', JSON.stringify(left))
  check(
    'but the session whose file went is still remembered here',
    state.skillsUsed('older')?.get('alpha') === 'tool',
    JSON.stringify([...(state.skillsUsed('older') ?? new Map())]),
  )

  await done(root)
}

{
  // A cap removal must also not mark the id condemned. Condemned means "the
  // session is over, do not let a late write put its file back" — saying that
  // about a running session would make every fact it produces get deleted on
  // the way out.
  const { state, root } = await fixture()
  state.store.maxFiles = 1
  // Order matters: the cap keeps the newest file, so the session that has to be
  // squeezed out is the one written first.
  state.rememberSkill('squeezed', 'beta', 'tool')
  await state.flush('squeezed')
  await new Promise((resolve) => setTimeout(resolve, 12))
  state.rememberSkill('kept', 'alpha', 'tool')
  await state.flush('kept')

  await state.prune({ known: async () => true })
  check('the squeezed session lost its file', (await filesIn(root)).includes('squeezed.json') === false, JSON.stringify(await filesIn(root)))

  // The session speaks again, which is what a running session does.
  state.rememberSkill('squeezed', 'delta', 'tool')
  await state.flush('squeezed')
  const back = await state.store.read('squeezed')
  check(
    'and a fact after the cap still writes its file',
    back?.skills?.delta?.via === 'tool',
    JSON.stringify(back?.skills),
  )
  check(
    'and it remembered what it knew before the cap',
    back?.skills?.beta?.via === 'tool',
    JSON.stringify(Object.keys(back?.skills ?? {})),
  )

  await done(root)
}

{
  // Two routes record a skill, and they are not equal evidence: `tool` means the
  // model chose to load it, `gesture` means a person typed its name. When a file
  // says `tool` and memory says `gesture`, memory winning would downgrade the
  // record — and the panel hides gesture-loaded skills from the model-only list,
  // so a skill the model actually uses would disappear because someone had
  // reloaded it by hand.
  const root = join(tmpdir(), `dsse-session-state-via-${randomUUID()}`)
  await mkdirp(root)
  const storeA = new SessionStore({ root })
  const storeB = new SessionStore({ root })
  const stateA = new SessionState({ store: storeA, snapshotOf: () => undefined, restore: () => {}, delayMs: 0 })
  const stateB = new SessionState({ store: storeB, snapshotOf: () => undefined, restore: () => {}, delayMs: 0 })

  await storeB.write('s1', {
    version: VERSION,
    session: 's1',
    state: 1,
    skills: { alpha: { via: 'tool', at: 3 } },
    tools: [],
    servers: {},
    sequence: 3,
  })

  // This process saw the same skill, but by the weaker route, before reading.
  stateA.rememberSkill('s1', 'alpha', 'gesture')
  await stateA.load('s1')
  check('the skill is still recorded once', stateA.skillsUsed('s1')?.size === 1, JSON.stringify([...(stateA.skillsUsed('s1') ?? new Map())]))
  check('and the stronger route survived the merge', stateA.skillsUsed('s1')?.get('alpha') === 'tool', String(stateA.skillsUsed('s1')?.get('alpha')))

  await stateA.flush('s1')
  const after = await storeA.read('s1')
  check('and the file was not downgraded', after?.skills?.alpha?.via === 'tool', JSON.stringify(after?.skills?.alpha))

  await done(root)
}

{
  // Both writers stamp `updated`, and a reader should not have to ask which one
  // wrote the file. The clock in this module counts milliseconds because that is
  // what a clock does; the store writes an ISO string. Passing the number
  // straight through meant the field's type depended on the last writer.
  const { state, root } = await fixture({ now: () => 1700000000000 })
  state.rememberSkill('stamped', 'alpha', 'tool')
  await state.flush('stamped')
  const written = await state.store.read('stamped')
  check('the document carries a timestamp string', typeof written?.updated === 'string', typeof written?.updated)
  check('and it is the instant the clock reported', written?.updated === new Date(1700000000000).toISOString(), String(written?.updated))

  await done(root)
}

{
  // A turn count without a finished turn is a real state: the last turn was
  // abandoned, so there is nothing honest to summarise, but the conversation did
  // reach turn 4. Restoring only files that carried a finished turn made the
  // panel print turn 0 for it.
  const root = join(tmpdir(), `dsse-session-state-count-${randomUUID()}`)
  await mkdirp(root)
  const store = new SessionStore({ root })
  const restored = []
  const state = new SessionState({
    store,
    snapshotOf: () => undefined,
    restore: (sessionId, snapshot) => restored.push({ sessionId, snapshot }),
    delayMs: 0,
  })

  await store.write('counted', {
    version: VERSION,
    session: 'counted',
    state: 1,
    turns: 4,
    skills: {},
    tools: [],
    servers: {},
    sequence: 0,
  })

  const loaded = await state.load('counted')
  check('a file holding only a turn count is read', loaded === true, String(loaded))
  check('and the count is handed to the transcript', restored[0]?.snapshot?.turns === 4, JSON.stringify(restored[0]?.snapshot))
  check('and there is no turn to describe', restored[0]?.snapshot?.previous === undefined, JSON.stringify(restored[0]?.snapshot?.previous))

  await done(root)
}

{
  // A count is a fact. Three of them can be true at once and leave nothing to
  // summarise: every turn ended early, no skill was loaded, no tool was called.
  // `hasFacts` used to answer no to that shape, so `document()` returned
  // undefined and the write was skipped — the file kept the count from whenever
  // the process started, and every restart lost the turns since. Nothing looked
  // broken; the number just stopped moving.
  const root = join(tmpdir(), `dsse-session-state-count-${randomUUID()}`)
  await mkdirp(root)
  const store = new SessionStore({ root })
  const state = new SessionState({
    store,
    snapshotOf: () => ({ turns: 5, previous: undefined }),
    restore: () => {},
    delayMs: 0,
  })
  state.rememberTurn('abandoned')
  await state.flush('abandoned')

  const written = await state.store.read('abandoned')
  check('a conversation with nothing but a count is written down', written !== undefined, JSON.stringify(written))
  check('and the count it reached is in the file', written?.turns === 5, JSON.stringify(written?.turns))
  check('and it is not pretending a turn finished', written?.previous === undefined, JSON.stringify(written?.previous))

  await done(root)
}

{
  // The transcript is the only thing allowed to add a stored count to a live
  // one: it does so once, behind `hydrated`. This module adding as well meant
  // the same file was counted twice whenever a record outlived its transcript —
  // `release` clears the record but not the store — so the second read wrote
  // twice the turns the file held, and the panel went on printing the right
  // number while the disk said double.
  const root = join(tmpdir(), `dsse-session-state-reuse-${randomUUID()}`)
  await mkdirp(root)
  const store = new SessionStore({ root })
  await store.write('reused', {
    version: VERSION,
    session: 'reused',
    state: 1,
    turns: 8,
    previous: { turn: 8, calls: 1, failed: 0, paths: [], commands: [], said: 'eight turns, from before', tools: [] },
    skills: {},
    tools: [],
    servers: {},
    sequence: 0,
  })

  // This process has counted one turn so far. `restore` behaves like the
  // transcript: it takes the stored count exactly once.
  const live = { turns: 1, previous: undefined }
  let hydrated = false
  const state = new SessionState({
    store,
    // A fresh object every time, as the real one does. Handing out the same
    // object would let the record and the transcript share their answer, and a
    // stale snapshot would never look stale.
    snapshotOf: () => ({ turns: live.turns, previous: live.previous }),
    restore: (sessionId, snapshot) => {
      if (hydrated === true) return
      hydrated = true
      live.turns += Number.isFinite(snapshot?.turns) ? snapshot.turns : 0
      if (live.previous === undefined) live.previous = snapshot?.previous
    },
    delayMs: 0,
  })

  state.rememberSkill('reused', 'alpha', 'tool')
  await state.load('reused')
  await state.flush('reused')
  const first = await store.read('reused')
  check('the file holds the whole conversation after the first read', first?.turns === 9, JSON.stringify(first?.turns))

  await state.release('reused')
  state.rememberSkill('reused', 'alpha', 'tool')
  await state.load('reused')
  await state.flush('reused')
  const second = await store.read('reused')
  check('and reading it again does not count it twice', second?.turns === 9, JSON.stringify(second?.turns))
  check('and the two counts agree after release', second?.turns === live.turns, `${second?.turns} versus ${live.turns}`)

  await done(root)
}

{
  // A record can hold a snapshot older than the transcript. The record is built
  // before the read — `schedule` takes one the moment a fact arrives — and the
  // read is what brings the turns from before the restart, so whatever the
  // record grabbed is missing them. Writing that snapshot back would move the
  // count backwards: the file would say three turns for a conversation the panel
  // is showing eight of. The count is asked of the transcript again after the
  // restore, which is the only place it is ever assembled.
  const root = join(tmpdir(), `dsse-session-state-stale-${randomUUID()}`)
  await mkdirp(root)
  const store = new SessionStore({ root })
  await store.write('stale', {
    version: VERSION,
    session: 'stale',
    state: 1,
    turns: 5,
    previous: { turn: 5, calls: 0, failed: 0, paths: [], commands: [], said: 'five turns before the restart', tools: [] },
    skills: {},
    tools: [],
    servers: {},
    sequence: 0,
  })

  // The transcript already holds the whole conversation — three turns this
  // process saw, five from the file, added once when the restore ran.
  const live = { turns: 3, previous: undefined }
  const state = new SessionState({
    store,
    snapshotOf: () => ({ turns: live.turns, previous: live.previous }),
    restore: (sessionId, snapshot) => {
      if (sessionId === 'stale' && live.turns === 3) live.turns += Number.isFinite(snapshot?.turns) ? snapshot.turns : 0
    },
    delayMs: 0,
  })

  // The fact lands first, so the record's snapshot is taken before the read.
  state.rememberSkill('stale', 'alpha', 'tool')
  await state.load('stale')
  await state.flush('stale')

  const written = await store.read('stale')
  check('the count written back is the one the transcript holds', written?.turns === 8, JSON.stringify(written?.turns))
  check('and it is not the count the record grabbed before the read', written?.turns !== 3, JSON.stringify(written?.turns))

  await done(root)
}

// ---------------------------------------------------------------------------
// The file list gained two facts: which turn wrote a file, and when
// ---------------------------------------------------------------------------

// A bare position cannot say either of them, so the stored shape changed. What
// must not change is the readability of files written before it: a session from
// an older build still has its order, and the two facts it never recorded come
// back as "unknown" rather than as an invented zero.
{
  const { state, store, root } = await fixture()
  await store.write('v1', {
    state: 1,
    turns: 1,
    previous: null,
    skills: {},
    tools: [],
    servers: {},
    sequence: 9,
    paths: { 'one.js': 9, 'two.js': 2, 'three.js': 5 },
  })
  await state.load('v1')
  const seen = state.pathsSeen('v1')
  const names = seen.map((file) => file.path)
  check('a version 1 file still loads', seen.length === 3, JSON.stringify(seen))
  check('and it keeps the order it was written with', names[0] === 'one.js' && names[1] === 'three.js' && names[2] === 'two.js', JSON.stringify(names))
  check(
    'and the turn it cannot know is unknown rather than zero',
    seen.every((file) => file.turn === undefined),
    JSON.stringify(seen)
  )
  check(
    'and the time it cannot know is unknown too',
    seen.every((file) => file.at === undefined),
    JSON.stringify(seen)
  )
  await done(root)
}

{
  // The turn number is what lets the card say "this turn" after a restart. The
  // only other source is the previous turn's snapshot, which is gone once the
  // next turn ends — so a number that is not written down is a number the card
  // can never recover.
  const { state, store, root } = await fixture()
  state.rememberPaths('turns', ['a.js'], 7)
  state.rememberPaths('turns', ['b.js'], 8)
  const seen = state.pathsSeen('turns')
  check('the newest file carries its turn', seen[0]?.path === 'b.js' && seen[0]?.turn === 8, JSON.stringify(seen))
  check('and the older one carries its own', seen[1]?.path === 'a.js' && seen[1]?.turn === 7, JSON.stringify(seen))

  await state.flush('turns')
  const stored = await store.read('turns')
  check('the turn is written down', stored?.paths?.['b.js']?.turn === 8, JSON.stringify(stored?.paths))
  check('and the position is kept beside it', stored?.paths?.['b.js']?.seq === 2, JSON.stringify(stored?.paths))

  // Read back by a second process: the numbers have to survive the round trip,
  // not just the in-memory record.
  const second = new SessionState({ store, snapshotOf: () => undefined, restore: () => {}, delayMs: 0 })
  await second.load('turns')
  const reloaded = second.pathsSeen('turns')
  check('the turn survives a restart', reloaded[0]?.turn === 8, JSON.stringify(reloaded))
  // Equal to what went to disk, not merely numeric: a reader that re-stamps
  // `at` on load would satisfy `typeof === 'number'` while destroying the fact
  // the field exists to record.
  check('and so does the time', reloaded[0]?.at === stored?.paths?.['b.js']?.at, JSON.stringify([reloaded[0], stored?.paths?.['b.js']]))
  await done(root)
}

{
  // A number that arrives as a string is not a turn. Coercing it would move a
  // file into this turn's group on the strength of a value the writer never
  // meant as a number, which is worse than admitting the file has no opinion.
  const { state, store, root } = await fixture()
  await store.write('bad-turn', {
    state: 2,
    turns: 1,
    previous: null,
    skills: {},
    tools: [],
    servers: {},
    sequence: 4,
    paths: {
      'good.js': { seq: 4, turn: 3, at: 1000 },
      'stringly.js': { seq: 3, turn: '3', at: '1000' },
      'numberless.js': { seq: 2 },
      'junk.js': 17,
    },
  })
  await state.load('bad-turn')
  const byPath = new Map(state.pathsSeen('bad-turn').map((file) => [file.path, file]))
  check('a well-formed entry keeps both facts', byPath.get('good.js')?.turn === 3 && byPath.get('good.js')?.at === 1000, JSON.stringify([...byPath]))
  // Present-but-blank and silently-dropped look identical through `?.turn`, and
  // dropping the entry would erase a file the reader edited. Both are asserted.
  check('a string entry is kept, not dropped', byPath.get('stringly.js') !== undefined, JSON.stringify([...byPath.keys()]))
  check('a string is not a turn', byPath.get('stringly.js')?.turn === undefined, JSON.stringify(byPath.get('stringly.js')))
  check('and a string is not a time either', byPath.get('stringly.js')?.at === undefined, JSON.stringify(byPath.get('stringly.js')))
  check('an entry with no facts is kept too', byPath.get('numberless.js') !== undefined, JSON.stringify([...byPath.keys()]))
  check('an entry without the facts still keeps its position', byPath.get('numberless.js')?.turn === undefined, JSON.stringify(byPath.get('numberless.js')))
  // The value, not merely the presence. `pathsSeen` reports no `seq`, so the
  // position is observable only through order: 17 is the largest in this fixture,
  // and `seq: 0` would sort the file last instead of first.
  check('a bare number is still readable as its own position', state.pathsSeen('bad-turn')[0]?.path === 'junk.js', JSON.stringify(state.pathsSeen('bad-turn')))
  await done(root)
}

{
  // A fresh write is version 2, whatever the file it replaced said. This is the
  // whole migration: read either, write the new one, and the old file upgrades
  // itself on the next write without a migration step.
  const { state, store, root } = await fixture()
  await store.write('upgrade', {
    state: 1,
    turns: 2,
    previous: null,
    skills: {},
    tools: [],
    servers: {},
    // Deliberately not equal to the document counter: a migration that stamps
    // the old entry with `sequence` instead of its own position would pass if
    // the two numbers happened to match.
    sequence: 4,
    paths: { 'kept.js': 7 },
  })
  await state.load('upgrade')
  state.rememberPaths('upgrade', ['added.js'], 2)
  await state.flush('upgrade')
  const stored = await store.read('upgrade')
  check('an old file is upgraded by being written once', stored?.state === 2, String(stored?.state))
  check('and the file it knew is still there', stored?.paths?.['kept.js'] !== undefined, JSON.stringify(stored?.paths))
  check(
    'and the upgraded entry is the new shape',
    typeof stored?.paths?.['kept.js'] === 'object' && stored?.paths?.['kept.js']?.seq === 7,
    JSON.stringify(stored?.paths)
  )
  await done(root)
}

{
  // A version this build does not know is not guessed at. Refusing it costs one
  // session's file list; reading it as if it were version 2 would put invented
  // rows in front of the reader.
  const { state, store, root } = await fixture()
  await store.write('future', { state: 99, turns: 1, previous: null, skills: {}, tools: [], servers: {}, sequence: 1, paths: { 'x.js': 1 } })
  await state.load('future')
  check('a version from the future is refused', state.pathsSeen('future').length === 0, JSON.stringify(state.pathsSeen('future')))
  // An empty list is also what a session with no record at all returns, so the
  // refusal alone cannot be told apart from "this session was never seen". A
  // write has to prove the record exists and is usable.
  state.rememberPaths('future', ['later.js'], 1)
  check('and the refused session still records what happens next', state.pathsSeen('future').length === 1, JSON.stringify(state.pathsSeen('future')))
  await done(root)
}

{
  // What a sweep could see is a fact about a turn, not a file. It has to survive a
  // refresh — the whole point is that a later reader can caveat the file list it
  // was handed — so the same round trip `paths` gets is asserted here.
  const { state, store, root } = await fixture()
  check('a session nothing has swept claims nothing', state.sweepSeen('swept') === undefined, JSON.stringify(state.sweepSeen('swept')))
  state.rememberSweep('swept', 3, 'partial')
  // A path too: coverage alone is not content, so without one `document()` refuses
  // the file and the round trip below would prove nothing.
  state.rememberPaths('swept', ['out/doc.docx'], 3)
  check('a partial sweep is remembered', state.sweepSeen('swept')?.coverage === 'partial', JSON.stringify(state.sweepSeen('swept')))
  check('and it names the turn it swept', state.sweepSeen('swept')?.turn === 3, JSON.stringify(state.sweepSeen('swept')))
  await state.flush('swept')
  const stored = await store.read('swept')
  check('the doubt is written down, not just held in memory', stored?.sweep?.coverage === 'partial', JSON.stringify(stored?.sweep))
  // A second sweep replaces the first: this describes the newest turn, and a
  // history of coverage claims is something no reader asks for.
  state.rememberSweep('swept', 4, 'complete')
  check('a later clean sweep replaces the caveat', state.sweepSeen('swept')?.coverage === 'complete', JSON.stringify(state.sweepSeen('swept')))
  await state.flush('swept')
  const replaced = await store.read('swept')
  check('and the file agrees', replaced?.sweep?.coverage === 'complete' && replaced?.sweep?.turn === 4, JSON.stringify(replaced?.sweep))
  const reloaded = new SessionState({ store, delayMs: 0, now: () => 1000, snapshotOf: async () => ({ turns: 0, previous: null }) })
  await reloaded.load('swept')
  check('coverage survives a reload', reloaded.sweepSeen('swept')?.coverage === 'complete', JSON.stringify(reloaded.sweepSeen('swept')))
  await done(root)
}

{
  // Coverage on its own is not content. A session whose only recorded fact is
  // "I could not see everything" has nothing to show, and giving it a file would
  // make the pruner carry a document that says nothing for every session that
  // ever finished a turn in a half-readable repository.
  const { state, store, root } = await fixture()
  state.rememberSweep('only-coverage', 1, 'partial')
  check('coverage alone is not a reason to write a file', state.document('only-coverage') === undefined, JSON.stringify(state.document('only-coverage')))
  await done(root)
}

{
  // A stored value this build does not recognise is read as the plain case: not
  // knowing a word is not evidence that something was skipped, and inventing a
  // caveat would put an apology on a card that has nothing to apologise for.
  const { state, store, root } = await fixture()
  await store.write('odd-coverage', {
    state: 2,
    turns: 1,
    previous: null,
    skills: {},
    tools: [],
    servers: {},
    sequence: 1,
    paths: {},
    sweep: { turn: 2, coverage: 'mostly' },
  })
  await state.load('odd-coverage')
  check('an unknown coverage word reads as complete', state.sweepSeen('odd-coverage')?.coverage === 'complete', JSON.stringify(state.sweepSeen('odd-coverage')))
  check('and the turn it names is kept', state.sweepSeen('odd-coverage')?.turn === 2, JSON.stringify(state.sweepSeen('odd-coverage')))
  // A sweep entry that is not an object at all is refused rather than guessed at,
  // for the same reason `readPathEntry` refuses a non-number position.
  await store.write('bad-sweep', { state: 2, turns: 1, previous: null, skills: {}, tools: [], servers: {}, sequence: 1, paths: {}, sweep: 'partial' })
  const other = new SessionState({ store, delayMs: 0, now: () => 1000, snapshotOf: async () => ({ turns: 0, previous: null }) })
  await other.load('bad-sweep')
  check('a sweep that is not an object is not read as one', other.sweepSeen('bad-sweep') === undefined, JSON.stringify(other.sweepSeen('bad-sweep')))
  await done(root)
}


{
  // Which bracket found a file survives the round trip. After the merge this is
  // the only record of it: the diff's list and the walk's list are folded into one
  // map keyed by path, so a row that surprises somebody later cannot be traced
  // back to the collector that produced it unless the write kept the name.
  const { state, store, root } = await fixture()
  state.rememberPaths('sourced', ['/work/a.ts'], 3, 'git')
  state.rememberPaths('sourced', ['/work/dist/c.js'], 3, 'scan')
  check('the bracket that found a file is kept', state.pathsSeen('sourced').find((one) => one.path === '/work/a.ts')?.source === 'git', JSON.stringify(state.pathsSeen('sourced')))
  check('and the other bracket is kept too', state.pathsSeen('sourced').find((one) => one.path === '/work/dist/c.js')?.source === 'scan', JSON.stringify(state.pathsSeen('sourced')))
  // A name this build does not know is not a third provenance, and it is not
  // guessed into one either.
  state.rememberPaths('sourced', ['/work/d.ts'], 4, 'screenshot')
  check('a bracket name this build does not know is not stored', state.pathsSeen('sourced').find((one) => one.path === '/work/d.ts')?.source === undefined, JSON.stringify(state.pathsSeen('sourced')))
  await state.flush('sourced')

  const second = new SessionState({ store, snapshotOf: () => undefined, restore: () => {}, delayMs: 0 })
  await second.load('sourced')
  check('and the bracket survives a reload', second.pathsSeen('sourced').find((one) => one.path === '/work/dist/c.js')?.source === 'scan', JSON.stringify(second.pathsSeen('sourced')))
  check('the unknown one is still unknown after a reload', second.pathsSeen('sourced').find((one) => one.path === '/work/d.ts')?.source === undefined, JSON.stringify(second.pathsSeen('sourced')))
  await done(root)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
