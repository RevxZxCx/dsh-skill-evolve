/**
 * Per-session panel state on disk.
 *
 * The panel describes a conversation, not a process. Everything it draws —
 * the turn that just ended, the files that turn touched, the skills it loaded,
 * the MCP servers it reached — used to live only in memory, so restarting the
 * host emptied the panel for a conversation that was still there. The
 * conversation survived because the host owns it; the panel's description of it
 * did not, because nothing wrote it down.
 *
 * ## One file per session, rewritten whole
 *
 * There is no history and no rollback. Each write replaces the file, so the
 * last write wins. That is a deliberate trade rather than an omission: the
 * panel's job is to say what this conversation looks like *now*, and a version
 * history would answer a question nobody asks while making every write a
 * merge problem. A torn write is the only failure that would matter, and the
 * temp-file-plus-rename below rules it out.
 *
 * ## Why the plugin's own directory rather than the session directory
 *
 * The tempting shortcut is to write next to `session.v4.jsonl.zstd` and let the
 * host's own archive and delete take the file with it. Two measurements say no.
 * Archiving a session only hides it from the workspace surfaces — every one of
 * the archived session directories was still on disk afterwards — and the
 * sessions directory is the host's private store, not a place a plugin should
 * be adding files. So the panel keeps its own directory and removes entries on
 * its own terms, using the host's own test for whether a session still exists.
 *
 * @module @revxz/dsh-ui-evolve/session-store
 */

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { stateDir } from '@revxz/dsh-evolve-core'

/** Bumped when the on-disk shape changes in a way old files cannot satisfy. */
const VERSION = 1

/**
 * Session ids the host produces are uuids, sometimes behind a `session-` prefix.
 *
 * The test is deliberately an allowlist rather than a strip-anything-odd: a
 * session id reaches this module from an event payload and becomes a file name,
 * and a `..` that slipped through would write outside the directory. Anything
 * that does not match is treated as "this session cannot be stored", which
 * costs one session's panel state and cannot damage anything else.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * How many session files to keep before the oldest are dropped.
 *
 * A cap rather than unbounded growth: sessions are cheap to recreate by talking
 * to the host, and a directory that grows with every conversation ever held is
 * a slow leak in a plugin that is supposed to be invisible.
 */
const MAX_FILES = 500

/**
 * How long a prune result stands before the next one is allowed.
 *
 * Long enough that a polled panel does not walk the directory on every request,
 * short enough that a session archived mid-conversation loses its file while
 * the person who archived it is still looking at the screen.
 */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000

/**
 * Write a JSON file so that a reader never sees half of one.
 *
 * The temp name carries a random component rather than just the pid: two writes
 * in the same tick would otherwise pick the same name and the loser would
 * rename a file the winner was still filling.
 *
 * @param {string} path - absolute path.
 * @param {unknown} value - value to serialize.
 * @returns {Promise<void>}
 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * Whether a value is a plain object.
 *
 * @param {unknown} value - the value.
 * @returns {boolean} true for objects that are not arrays or null.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The panel's per-session state, kept in one file per conversation.
 */
export class SessionStore {
  /**
   * @param {object} [options] - construction options.
   * @param {string} [options.root] - directory override, for tests.
   * @param {(...parts: any[]) => void} [options.log] - logger sink.
   * @param {number} [options.maxFiles] - how many session files to keep.
   */
  constructor(options = {}) {
    /** @type {string} */
    this.root = typeof options.root === 'string' && options.root.length > 0 ? options.root : join(stateDir(), 'sessions')
    /** @type {(...parts: any[]) => void} */
    this.log = typeof options.log === 'function' ? options.log : () => {}
    /** @type {number} */
    this.maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : MAX_FILES
    /**
     * The in-flight or completed prune.
     *
     * Held so that a panel read cannot start a second directory listing while
     * the first is still walking: the panel is polled, and pruning is not
     * something to do once per poll.
     *
     * @type {Promise<number> | undefined}
     */
    this.pruned = undefined
    /** @type {number} */
    this.prunedAt = 0
    /**
     * The ids the most recent completed sweep considered — that is, every id it
     * found a file for.
     *
     * A caller that also keeps memory entries needs to know which ids this sweep
     * has an opinion about, so that it asks the host about the others and only
     * the others. Undefined when the last call was skipped by the interval: no
     * sweep ran, so nothing was judged.
     *
     * @type {string[] | undefined}
     */
    this.considered = undefined
  }

  /**
   * The file one session is stored in.
   *
   * @param {string} sessionId - the session.
   * @returns {string | undefined} the path, or undefined for an id that is not safe.
   */
  pathFor(sessionId) {
    if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return undefined
    return join(this.root, `${sessionId}.json`)
  }

  /**
   * What is on disk for one session, without collapsing the refusals together.
   *
   * `read` answers a document or nothing, which is the right question for a
   * caller that only wants to draw. A caller about to *delete* a file has to ask
   * a different one: "there is nothing here" authorises the delete, while "there
   * is something I will not read" forbids it. One `undefined` cannot say which,
   * so this returns the verdict instead:
   *
   * - `absent` — nothing is stored. Only ENOENT earns this verdict. Every other
   *   failure to open the file means something is there and could not be read,
   *   and reading that as absence deletes a file that merely could not be opened
   *   at that moment.
   * - `foreign` — a file is there and this build will not vouch for it: not JSON,
   *   not a record, another state version, another session's name, or a read
   *   error that is not ENOENT. It may belong to a build the user can go back to,
   *   so it is left exactly as it is.
   * - `present` — a document this build can read, returned whole.
   *
   * @param {string} sessionId - the session.
   * @returns {Promise<{ kind: 'absent' } | { kind: 'foreign' } | { kind: 'present', value: object }>} the verdict.
   */
  async inspect(sessionId) {
    const path = this.pathFor(sessionId)
    // An id that cannot be stored has no file. Nothing is stored, and nothing
    // can be deleted either — `forget` is a no-op for the same id.
    if (path === undefined) return { kind: 'absent' }
    let value
    try {
      value = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return { kind: 'absent' }
      return { kind: 'foreign' }
    }
    if (!isRecord(value)) return { kind: 'foreign' }
    // A file from another version is not repaired, it is ignored. Guessing how
    // to read an older shape is how a reader ends up showing a field that no
    // longer means what it used to.
    if (value.version !== VERSION) return { kind: 'foreign' }
    // The file name is the identity. A file whose contents name another session
    // is a bug or a copy, and either way it must not be attributed to this one.
    if (value.session !== sessionId) return { kind: 'foreign' }
    return { kind: 'present', value }
  }

  /**
   * The stored state for one session.
   *
   * Every refusal collapses into `undefined` here on purpose: a caller drawing
   * the panel has the same thing to show for a torn file, an old one and a
   * missing one — nothing. Ask {@link inspect} when the difference matters,
   * which is exactly when a delete is on the table.
   *
   * @param {string} sessionId - the session.
   * @returns {Promise<object | undefined>} the state, or undefined when nothing usable is stored.
   */
  async read(sessionId) {
    const found = await this.inspect(sessionId)
    return found.kind === 'present' ? found.value : undefined
  }

  /**
   * Replace one session's state.
   *
   * @param {string} sessionId - the session.
   * @param {object} state - the state to store; `version` and `session` are added here.
   * @returns {Promise<void>}
   */
  async write(sessionId, state) {
    const path = this.pathFor(sessionId)
    if (path === undefined) return
    const payload = { version: VERSION, session: sessionId, updated: new Date().toISOString(), ...state }
    try {
      await writeJson(path, payload)
    } catch (error) {
      // A failed write is not a reason to break the panel that is drawing from
      // memory right now. It is worth one log line because the next restart is
      // when the loss becomes visible.
      this.log('session state: could not write', sessionId, error?.message ?? error)
    }
  }

  /**
   * Drop one session's state.
   *
   * @param {string} sessionId - the session.
   * @returns {Promise<void>}
   */
  async forget(sessionId) {
    const path = this.pathFor(sessionId)
    if (path === undefined) return
    try {
      await unlink(path)
    } catch {
      /* already gone is the outcome we wanted */
    }
  }

  /**
   * The session ids that have a stored file.
   *
   * @returns {Promise<string[]>} the ids.
   */
  async list() {
    let names
    try {
      names = await readdir(this.root)
    } catch {
      return []
    }
    const ids = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (SAFE_ID.test(id)) ids.push(id)
    }
    return ids
  }

  /**
   * Remove state for sessions the host no longer knows, and trim to the cap.
   *
   * The two questions are answered by the caller because they belong to the
   * host: `known` is the host's own "does this session exist" test, and
   * `archived` is its archived-id list. Only a definite answer deletes a file —
   * "I could not tell" must never read as "they are all gone", because the
   * answer in that case is every file the panel has.
   *
   * The cap is the exception, and it is a different kind of judgement: dropping
   * the oldest files claims nothing about any session, so it needs no host to
   * answer and applies either way. That is why there is no early return for the
   * no-sources case — the per-id deletions below are already guarded, and
   * returning early would quietly exempt an unanswered host from the cap too.
   *
   * @param {object} sources - what the host says.
   * @param {(id: string) => Promise<boolean>} [sources.known] - resolves true when the session exists.
   * @param {() => string[] | undefined} [sources.archived] - archived ids, when the host exposes them.
   * @param {(id: string) => void} [sources.onRemoved] - told as each file goes, not at the end.
   * @returns {Promise<number>} how many files were removed.
   */
  async prune(sources = {}) {
    const ids = await this.list()
    this.considered = ids
    if (ids.length === 0) return 0
    const archivedFrom = typeof sources.archived === 'function' ? sources.archived() : undefined
    const archived = Array.isArray(archivedFrom) ? new Set(archivedFrom) : undefined
    const known = typeof sources.known === 'function' ? sources.known : undefined

    let removed = 0
    const survivors = []

    // Settle one id: delete its file, count it, and tell the caller *now*.
    //
    // The notification is the point. This loop awaits the host between ids, and a
    // write landing inside that gap would look at the caller's memory, find the
    // entry still there, conclude the id is still wanted and let its file stand —
    // after this loop had already decided the session was gone. Reporting each
    // deletion as it happens removes the gap instead of papering over it at the
    // end.
    // The reason travels with the notification. A file removed because the host
    // said its session is gone, and a file removed because the directory outgrew
    // the cap, are the same unlink but not the same decision: only the first
    // says anything about the session. A caller that cleared its memory for both
    // would drop a conversation that is still running the first time the cache
    // filled up.
    const drop = async (id, reason) => {
      await this.forget(id)
      removed += 1
      if (typeof sources.onRemoved === 'function') sources.onRemoved(id, reason)
    }

    for (const id of ids) {
      if (archived !== undefined && archived.has(id)) {
        await drop(id, 'gone')
        continue
      }
      if (known !== undefined) {
        let alive
        try {
          alive = await known(id)
        } catch (error) {
          // The host's own contract says a storage fault propagates rather than
          // reporting an unknown session. Honour that: stop asking and keep
          // every remaining file.
          this.log('session state: keeping everything, the host could not answer', error?.message ?? error)
          return removed
        }
        if (alive === false) {
          await drop(id, 'gone')
          continue
        }
      }
      survivors.push(id)
    }

    // Oldest first, so the cap drops the conversations least likely to be
    // reopened.
    //
    // The cap counts files, so it is measured against `dated` — the names that
    // turned out to be files — and not against `survivors`. A name that cannot
    // be stat-ed has nothing behind it: it occupies no space, so it neither
    // fills a slot nor becomes a deletion candidate. Counting it would make the
    // cap drop one extra file per vanished name; measuring the subtraction on
    // `survivors` while slicing the shorter `dated` is worse still, because
    // `slice(0, 3)` on a two-element list takes both — the cap would delete
    // everything it could date instead of the oldest of them.
    const dated = []
    for (const id of survivors) {
      const path = this.pathFor(id)
      if (path === undefined) continue
      try {
        dated.push({ id, at: (await stat(path)).mtimeMs })
      } catch {
        /* vanished between listing and stating */
      }
    }
    const excess = dated.length - this.maxFiles
    if (excess > 0) {
      dated.sort((a, b) => a.at - b.at)
      for (const entry of dated.slice(0, excess)) {
        await drop(entry.id, 'cap')
      }
    }

    return removed
  }

  /**
   * Run {@link prune} if enough time has passed since the last run.
   *
   * The panel is polled, so this is called far more often than pruning is
   * warranted, and the work it needs — a directory listing plus one answer per
   * session — is exactly the wrong thing to do per poll. It cannot run once for
   * the life of the process either: a session can be archived while the host is
   * running, and the file must go when it does, not at the next restart. So the
   * interval sits between those two, and a caller that knows something changed
   * can pass zero to prune now.
   *
   * @param {object} sources - see {@link prune}.
   * @param {number} [intervalMs] - minimum time between runs.
   * @returns {Promise<number>} how many files were removed by the run this
   *   returns, or 0 when the previous run was recent enough to reuse.
   */
  async pruneIfDue(sources = {}, intervalMs = PRUNE_INTERVAL_MS) {
    const now = Date.now()
    if (this.pruned !== undefined) return this.pruned
    if (this.prunedAt !== 0 && now - this.prunedAt < intervalMs) {
      // No sweep ran, so no id was judged. `considered` keeps whatever the last
      // real sweep left, but a caller must not read it as this call's answer —
      // clearing it is what says so.
      this.considered = undefined
      return 0
    }
    const run = this.prune(sources).then(
      (removed) => {
        this.prunedAt = Date.now()
        return removed
      },
      (error) => {
        this.pruned = undefined
        throw error
      }
    )
    this.pruned = run
    try {
      return await run
    } finally {
      // Cleared so that the next call after the interval prunes again. The
      // pairing with `prunedAt` is what makes concurrent callers share one run
      // while still allowing a later one.
      this.pruned = undefined
    }
  }
}

export { MAX_FILES, PRUNE_INTERVAL_MS, SAFE_ID, VERSION }
