/**
 * Tests for the panel's per-session state file.
 *
 * The panel used to describe a conversation only for as long as the process
 * lived. Restarting the host emptied the three cards even though the
 * conversation was still there, because nothing had written the panel's part of
 * it down. This module is that write-down, and what it has to get right is
 * narrow and unforgiving:
 *
 * - a stored session reads back as the same fields it was written with;
 * - the last write wins, because a version history answers a question nobody
 *   asks while turning every write into a merge;
 * - a file that is not this version, not this session, or not JSON at all is
 *   ignored rather than repaired — guessing at an old shape is how a reader
 *   shows a field that no longer means what it used to;
 * - a session id from an event payload becomes a file name, so an id that could
 *   escape the directory must be refused rather than sanitised;
 * - pruning only deletes on a definite answer from the host. "I could not tell"
 *   must never read as "they are all gone", because the answer in that case is
 *   every file the panel has.
 *
 * Every case runs against a temporary directory, so nothing here touches the
 * real plugin state.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MAX_FILES, PRUNE_INTERVAL_MS, SAFE_ID, SessionStore, VERSION } from '../packages/ui-evolve/lib/session-store.js'

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
 * A store rooted in a fresh temporary directory.
 *
 * @param {object} [options] - passed through to the store.
 * @returns {Promise<{ store: SessionStore, root: string, done: () => Promise<void> }>} the fixture.
 */
async function fixture(options = {}) {
  const root = join(tmpdir(), `dsse-session-store-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  const store = new SessionStore({ root, ...options })
  return {
    store,
    root,
    done: () => rm(root, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------------------
// A stored session reads back
// ---------------------------------------------------------------------------

{
  const { store, root, done } = await fixture()
  const state = {
    turns: 7,
    previous: { turn: 7, calls: 21, failed: 0, paths: ['/a.ts'], commands: ['npm test'], said: 'did the thing', tools: [{ name: 'bash', count: 3 }] },
    skills: ['alpha', 'beta'],
    mcpTools: ['mcp__zeta__search'],
  }
  await store.write('session-abc', state)

  const names = await readdir(root)
  check('the file is named after the session', names.length === 1 && names[0] === 'session-abc.json', JSON.stringify(names))

  const back = await store.read('session-abc')
  check('a stored session reads back', back !== undefined)
  check('the turn count survives', back?.turns === 7, String(back?.turns))
  check('the previous turn survives whole', back?.previous?.calls === 21 && back?.previous?.said === 'did the thing', JSON.stringify(back?.previous))
  check('the file records its own version', back?.version === VERSION, String(back?.version))
  check('the file records which session it is', back?.session === 'session-abc', String(back?.session))
  check('the file records when it was written', typeof back?.updated === 'string' && back.updated.length > 0, String(back?.updated))

  await done()
}

// ---------------------------------------------------------------------------
// Unknown sessions answer nothing rather than guessing
// ---------------------------------------------------------------------------

{
  const { store, done } = await fixture()
  // The file is not there at all, which is the ordinary case for a session the
  // panel has never drawn. Reading it must answer "nothing stored" rather than
  // throw: the panel asks about sessions it has no history for all the time.
  const missing = await readSettled(store, 'never-stored')
  check('a session that was never stored reads as nothing', missing.ok === true && missing.value === undefined, String(missing.error))
  await done()
}

// ---------------------------------------------------------------------------
// The last write wins: there is one snapshot, not a history
// ---------------------------------------------------------------------------

{
  const { store, root, done } = await fixture()
  await store.write('session-lww', { turns: 1, previous: { said: 'first' } })
  await store.write('session-lww', { turns: 2, previous: { said: 'second' } })
  await store.write('session-lww', { turns: 3, previous: { said: 'third' } })

  const back = await store.read('session-lww')
  check('the newest write is the one that reads back', back?.turns === 3 && back?.previous?.said === 'third', JSON.stringify(back))

  // Not "no old file anywhere": a history would be extra files under any naming
  // this module might invent. There is exactly one, and it holds one state.
  const names = await readdir(root)
  check('a rewrite leaves one file, not a version per write', names.filter((name) => !name.endsWith('.tmp')).length === 1, JSON.stringify(names))

  // A torn write would leave a temp file behind; the rename means a reader
  // either sees the old file or the new one, never a partial one.
  check('no temporary file survives a completed write', names.every((name) => !name.endsWith('.tmp')), JSON.stringify(names))

  await done()
}

/**
 * Read a session through a wrapper that survives a throw.
 *
 * A guard whose only observable effect is "this does not crash" is invisible to
 * a test that crashes instead of failing: the mutation runner counts `FAIL`
 * lines, and a suite that dies prints none, so the guard looks unnecessary. So
 * the reading is wrapped and the crash becomes an ordinary failed check.
 *
 * @param {SessionStore} store - the store.
 * @param {string} id - the session.
 * @returns {Promise<{ ok: boolean, value?: object, error?: Error }>} the reading.
 */
async function readSettled(store, id) {
  try {
    return { ok: true, value: await store.read(id) }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * The same guard around `inspect`, so a throw is a failure a `check` reports
 * rather than one that ends the suite without printing anything.
 *
 * @param {SessionStore} store - the store.
 * @param {string} id - the session.
 * @returns {Promise<{ ok: boolean, value?: object, error?: Error }>} what was found.
 */
async function inspectSettled(store, id) {
  try {
    return { ok: true, value: await store.inspect(id) }
  } catch (error) {
    return { ok: false, error }
  }
}

// ---------------------------------------------------------------------------
// Files this module cannot vouch for are ignored, not repaired
// ---------------------------------------------------------------------------

{
  const { store, root, done } = await fixture()

  await writeFile(join(root, 'not-json.json'), 'this is not json{{{', 'utf8')
  const broken = await readSettled(store, 'not-json')
  check('a file that is not JSON reads as nothing', broken.ok === true && broken.value === undefined, String(broken.error))

  // `null` parses fine, so this one reaches the record check rather than the
  // parser. Reading it must answer "nothing stored", not throw at a caller who
  // is drawing a panel.
  await writeFile(join(root, 'null.json'), 'null', 'utf8')
  const empty = await readSettled(store, 'null')
  check('a file holding null reads as nothing instead of throwing', empty.ok === true && empty.value === undefined, String(empty.error))

  await writeFile(join(root, 'scalar.json'), '42', 'utf8')
  const scalar = await readSettled(store, 'scalar')
  check('a file holding a scalar reads as nothing', scalar.ok === true && scalar.value === undefined, String(scalar.error))

  await writeFile(join(root, 'future.json'), JSON.stringify({ version: VERSION + 1, session: 'future', turns: 99 }), 'utf8')
  check('a file from a newer version is ignored', (await store.read('future')) === undefined)

  await writeFile(join(root, 'wrong-session.json'), JSON.stringify({ version: VERSION, session: 'somebody-else', turns: 5 }), 'utf8')
  // The file name is the identity. A copy or a bug that names another session
  // must not be attributed to this one, or two panels would show each other's
  // work.
  check('a file that names another session is ignored', (await store.read('wrong-session')) === undefined)

  await writeFile(join(root, 'array.json'), JSON.stringify([1, 2, 3]), 'utf8')
  const array = await readSettled(store, 'array')
  check('a file holding an array reads as nothing', array.ok === true && array.value === undefined, String(array.error))

  // `read` collapses every refusal into `undefined`, which is right for a caller
  // that only wants a document and wrong for a caller about to delete a file:
  // "there is nothing here" authorises the delete and "there is something I will
  // not read" forbids it. `inspect` is what keeps those apart, so each shape is
  // checked for the verdict it earns rather than for the fact that it was
  // refused.
  const verdicts = {
    future: 'foreign',
    'wrong-session': 'foreign',
    array: 'foreign',
    null: 'foreign',
    scalar: 'foreign',
    missing: 'absent',
  }
  for (const [id, expected] of Object.entries(verdicts)) {
    const found = await inspectSettled(store, id)
    check(`${id}: the store says what it found instead of only what it can use`, found.ok === true && found.value?.kind === expected, JSON.stringify(found.value))
  }

  // A real file with the right envelope is the one case `read` and `inspect`
  // agree on, and the document has to come back whole.
  await writeFile(join(root, 'good.json'), JSON.stringify({ version: VERSION, session: 'good', state: 1, turns: 4 }), 'utf8')
  const good = await store.inspect('good')
  check('a usable file comes back as a document', good.kind === 'present' && good.value?.turns === 4, JSON.stringify(good))

  // A file that is there but cannot be opened is not an empty directory. Only
  // ENOENT means "nothing is stored"; EACCES, EPERM, EBUSY and the rest all mean
  // something is there, and a caller who reads them as absence will delete it.
  // The shape used here is a directory where the file should be, because that is
  // the one form of that failure a test can produce on every platform: opening
  // it for reading fails with EISDIR.
  await mkdir(join(root, 'blocked.json'), { recursive: true })
  const blocked = await inspectSettled(store, 'blocked')
  check('a file that cannot be opened is not reported as absent', blocked.ok === true && blocked.value?.kind === 'foreign', JSON.stringify(blocked.value))

  await done()
}

// ---------------------------------------------------------------------------
// A session id becomes a file name, so unsafe ids are refused
// ---------------------------------------------------------------------------

{
  const { store, root, done } = await fixture()

  const unsafe = ['../escape', 'a/b', 'a\\b', '', '.hidden', 'with space', 'x'.repeat(300), 'nul\u0000byte']
  const written = []
  for (const id of unsafe) {
    const path = store.pathFor(id)
    if (path !== undefined) written.push({ id, path })
    await store.write(id, { turns: 1 })
  }
  // The check that matters is not the string test but the filesystem: nothing
  // may exist outside the root, and nothing at all may be created for these.
  check('an unsafe session id resolves to no path', unsafe.every((id) => store.pathFor(id) === undefined), JSON.stringify(written))
  const names = await readdir(root)
  check('an unsafe session id writes no file', names.length === 0, JSON.stringify(names))

  // The allowlist has to accept what the host actually produces, or the whole
  // feature silently stores nothing.
  const hostShaped = [
    'session-4ac7eab0-59b2-46dd-9436-e168e3d03317',
    '2a72c9fe-c684-4c8c-88ed-51ec09bd5091',
    'abc_DEF.123',
  ]
  check('the ids the host produces are accepted', hostShaped.every((id) => store.pathFor(id) !== undefined), JSON.stringify(hostShaped.map((id) => store.pathFor(id))))

  // `.` and `..` are the two names a path join would follow out of the
  // directory, and neither is a session id.
  check('dot names are refused', store.pathFor('.') === undefined && store.pathFor('..') === undefined)
  check('the allowlist rejects a leading dot', SAFE_ID.test('.hidden') === false)

  await done()
}

// ---------------------------------------------------------------------------
// Forgetting removes exactly one session
// ---------------------------------------------------------------------------

{
  const { store, root, done } = await fixture()
  await store.write('keep-me', { turns: 1 })
  await store.write('drop-me', { turns: 2 })

  await store.forget('drop-me')
  const gone = await readSettled(store, 'drop-me')
  check('forgetting removes the named session', gone.ok === true && gone.value === undefined, String(gone.error))
  check('forgetting leaves the others alone', (await store.read('keep-me'))?.turns === 1)
  check('forgetting a session that is not there is not an error', (await store.forget('drop-me')) === undefined)

  const names = await readdir(root)
  check('the forgotten file is gone from disk', names.includes('drop-me.json') === false, JSON.stringify(names))

  await done()
}

// ---------------------------------------------------------------------------
// Pruning deletes only on a definite answer
// ---------------------------------------------------------------------------

{
  const { store, root, done } = await fixture()
  await store.write('alive', { turns: 1 })
  await store.write('dead', { turns: 1 })
  await store.write('archived', { turns: 1 })

  const removed = await store.prune({
    known: async (id) => id !== 'dead',
    archived: () => ['archived'],
  })
  const dead = await readSettled(store, 'dead')
  check('pruning removes the deleted session', dead.ok === true && dead.value === undefined, String(dead.error))
  const archived = await readSettled(store, 'archived')
  check('pruning removes the archived session', archived.ok === true && archived.value === undefined, String(archived.error))
  check('pruning keeps the live session', (await store.read('alive'))?.turns === 1)
  check('pruning reports how many it removed', removed === 2, String(removed))

  await done()
}

{
  const { store, done } = await fixture()
  await store.write('one', { turns: 1 })
  await store.write('two', { turns: 1 })

  // Neither source: nothing says any session is gone, and deleting on a guess
  // would throw away every session's state at once.
  const removed = await store.prune({})
  check('pruning with no host answer removes nothing', removed === 0, String(removed))
  check('and keeps both sessions', (await store.read('one')) !== undefined && (await store.read('two')) !== undefined)

  await done()
}

{
  // Without a host to answer, the cap still applies. It drops the oldest files
  // without claiming any session is gone, so it is not the same judgement as
  // "this session was deleted" and must not wait for a registry that may never
  // answer — otherwise an unanswered host becomes an unbounded directory.
  const { store, root, done } = await fixture({ maxFiles: 2 })
  for (const id of ['a', 'b', 'c']) {
    await store.write(id, { turns: 1 })
    await new Promise((resolve) => setTimeout(resolve, 12))
  }
  const removed = await store.prune({})
  const names = (await readdir(root)).filter((name) => name.endsWith('.json')).sort()
  check('the cap applies when the host answers nothing', removed === 1, String(removed))
  check('and the newest files are the ones kept', names.join(',') === 'b.json,c.json', JSON.stringify(names))

  await done()
}

{
  const { store, done } = await fixture()
  await store.write('one', { turns: 1 })
  await store.write('two', { turns: 1 })

  // The host's own contract says a storage fault propagates rather than
  // reporting an unknown session. When it does, the panel must keep everything:
  // a listing that failed is not a listing that came back empty.
  let asked = 0
  const removed = await store.prune({
    known: async () => {
      asked += 1
      throw new Error('sessionPersistence.list() failed')
    },
  })
  check('a host that cannot answer causes no deletions', removed === 0, String(removed))
  check('and the sessions are still there', (await store.read('one')) !== undefined && (await store.read('two')) !== undefined)
  check('and it stopped asking after the first fault', asked === 1, String(asked))

  await done()
}

// ---------------------------------------------------------------------------
// The cap keeps the newest, not the first alphabetically
// ---------------------------------------------------------------------------

{
  const { store, root, done } = await fixture({ maxFiles: 3 })
  for (const id of ['s1', 's2', 's3', 's4', 's5']) {
    await store.write(id, { turns: 1 })
    // The timestamps decide which three survive, so they must differ.
    await new Promise((resolve) => setTimeout(resolve, 12))
  }

  const removed = await store.prune({ known: async () => true })
  const names = (await readdir(root)).filter((name) => name.endsWith('.json')).sort()
  check('the cap removes the excess', removed === 2, String(removed))
  check('the cap keeps the newest files', names.join(',') === 's3.json,s4.json,s5.json', JSON.stringify(names))

  await done()
}

// ---------------------------------------------------------------------------
// A name that cannot be dated is counted but never dated
// ---------------------------------------------------------------------------

{
  // The cap counts from the listing, but can only order the names it can stat: a
  // file that vanished between the listing and the stat is skipped. Taking the
  // subtraction from the shorter, dated list makes the tail argument negative,
  // and `slice(0, -3)` means "everything except the last three" — so the files
  // deleted would be the newest conversations, the ones most likely to be
  // reopened, while the oldest survived.
  //
  // The listing is widened rather than the filesystem bent: a name in the
  // directory but not on disk is exactly what a vanished file looks like to the
  // code, and it is the same seam on every platform.
  //
  // Four real files against a cap of three, so the cap has to engage; the ghost
  // must be invisible to it — neither taking a slot nor adding a deletion.
  const { store, root, done } = await fixture({ maxFiles: 3 })
  for (const id of ['a', 'b', 'c', 'd']) {
    await store.write(id, { turns: 1 })
    await new Promise((resolve) => setTimeout(resolve, 12))
  }
  const real = store.list.bind(store)
  store.list = async () => [...(await real()), 'ghost']

  const removed = await store.prune({})
  const names = (await readdir(root)).filter((name) => name.endsWith('.json')).sort()
  check('a name that cannot be dated does not stop the cap', removed === 1, String(removed))
  check('and the oldest file is the one that goes', names.join(',') === 'b.json,c.json,d.json', JSON.stringify(names))

  await done()
}

{
  // The same arithmetic with the dated list shorter than the cap. Nothing here is
  // over the cap in file terms, so nothing may be deleted: a name that cannot be
  // stat-ed has no bytes behind it and cannot push a real file out. The older
  // version of this block asserted the opposite — that a cap of three over two
  // files plus three ghosts leaves nothing — which pinned the arithmetic to the
  // wrong list and would have blessed deleting live conversations.
  const { store, root, done } = await fixture({ maxFiles: 3 })
  for (const id of ['a', 'b']) {
    await store.write(id, { turns: 1 })
    await new Promise((resolve) => setTimeout(resolve, 12))
  }
  const real = store.list.bind(store)
  store.list = async () => [...(await real()), 'ghost-a', 'ghost-b', 'ghost-c']

  const removed = await store.prune({})
  const names = (await readdir(root)).filter((name) => name.endsWith('.json')).sort()
  check('a name that cannot be dated does not fill a slot in the cap', removed === 0, String(removed))
  check('and every file that is under the cap is still there', names.join(',') === 'a.json,b.json', JSON.stringify(names))

  await done()
}

// ---------------------------------------------------------------------------
// Pruning is rate limited, but not to once per process
// ---------------------------------------------------------------------------

{
  const { store, done } = await fixture()
  await store.write('archived', { turns: 1 })
  // A live session too, so the host is actually consulted once: an archived
  // name is settled by the archive list alone, and would not exercise the
  // question this test is about.
  await store.write('alive', { turns: 1 })

  // The session still exists — the file goes because it was archived, which is
  // the one reason that has nothing to do with the session being gone.
  let calls = 0
  const sources = {
    known: async () => {
      calls += 1
      return true
    },
    archived: () => ['archived'],
  }
  const first = await store.pruneIfDue(sources, 60_000)
  check('the first prune runs', first === 1, String(first))
  const gone = await readSettled(store, 'archived')
  check('and the archived file is gone', gone.ok === true && gone.value === undefined, String(gone.error))

  // A second call inside the interval must not walk the directory again: the
  // panel polls, and a listing per poll is the cost this avoids.
  const after = await store.pruneIfDue(sources, 60_000)
  check('a second prune inside the interval does nothing', after === 0, String(after))
  check('and it did not ask the host again', calls === 1, String(calls))

  // But it must run again once the interval passes. A session archived while the
  // host is running has to lose its file then, not at the next restart.
  await store.write('archived-later', { turns: 1 })
  const later = await store.pruneIfDue({ known: async () => true, archived: () => ['archived-later'] }, 0)
  check('a prune after the interval runs again', later === 1, String(later))
  const laterGone = await readSettled(store, 'archived-later')
  check('and it removes the session archived since', laterGone.ok === true && laterGone.value === undefined, String(laterGone.error))

  await done()
}

{
  const { store, done } = await fixture()
  check('the default interval is a positive number', Number.isFinite(PRUNE_INTERVAL_MS) && PRUNE_INTERVAL_MS > 0, String(PRUNE_INTERVAL_MS))
  check('the default cap is a positive number', Number.isFinite(MAX_FILES) && MAX_FILES > 0, String(MAX_FILES))
  await done()
}

// ---------------------------------------------------------------------------
// A failed write is a log line, not a thrown error
// ---------------------------------------------------------------------------

{
  const root = join(tmpdir(), `dsse-session-store-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  const lines = []
  // A directory where the file should be: the rename cannot replace it, so the
  // write fails the way a real permission or disk problem would.
  await mkdir(join(root, 'blocked.json'), { recursive: true })
  const store = new SessionStore({ root, log: (...parts) => lines.push(parts.join(' ')) })

  let threw = false
  try {
    await store.write('blocked', { turns: 1 })
  } catch {
    threw = true
  }
  check('a failed write does not throw into the panel', threw === false)
  check('a failed write is logged once', lines.length === 1 && lines[0].includes('blocked'), JSON.stringify(lines))

  await rm(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// The file is a line of JSON, not pretty-printed
// ---------------------------------------------------------------------------

{
  const { store, root, done } = await fixture()
  await store.write('compact', { turns: 1, skills: ['alpha'] })
  // Read through a settle: if the write never published its file, this must show
  // up as a failed assertion, not as an exception that hides which guard broke.
  let raw
  try {
    raw = await readFile(join(root, 'compact.json'), 'utf8')
  } catch (error) {
    raw = `<unreadable: ${error?.code ?? error}>`
  }
  // One line plus the trailing newline. This is state the panel rewrites on
  // every turn, and pretty-printing it would triple the bytes for no reader.
  check('the file is one line', raw.trimEnd().split('\n').length === 1, JSON.stringify(raw.slice(0, 80)))
  check('the file ends with a newline', raw.endsWith('\n'), JSON.stringify(raw.slice(-4)))

  await done()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
