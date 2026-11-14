/**
 * What the panel remembers about one conversation, and when it writes it down.
 *
 * `session-store.js` knows how to put a document on disk and take it off again.
 * This is the layer above it: the three accumulators the panel actually reads
 * from — the skills a session loaded, the MCP servers it reached, and the single
 * recency clock those two share — plus the transcript's finished turn, gathered
 * into one document and written as one.
 *
 * ## Why one document rather than three
 *
 * All of it describes the same conversation at the same moment, and the panel
 * reads all of it in one `GET /panel`. Writing three files would mean three
 * renames per update, three chances to be half-written, and three chances for
 * the halves to disagree about which turn they describe. One file, one rename,
 * one answer.
 *
 * ## Why the accumulators became per-session
 *
 * They used to be process-wide, which was wrong before it was slow: a Set of MCP
 * tool names and a Map of skill recency shared by every conversation in the host
 * meant the panel showed one conversation's work under another's name. The
 * panel's promise is "this conversation", so the state is keyed by session, and
 * the old process-wide shape is gone rather than kept beside it.
 *
 * ## When it writes
 *
 * Not on every event. A turn produces a tool call per file read, and rewriting
 * the document per call would put a file write inside the event loop for work
 * nobody has asked to see yet. Writes are therefore coalesced: an event marks
 * the session dirty and schedules one write, and everything that must be on disk
 * before the process goes away — the end of a turn, an agent being disposed, the
 * panel being read — flushes immediately.
 *
 * The timer is unref'd. A panel that kept the host process alive for a
 * pending write would be a worse bug than the one it was written to fix.
 *
 * @module @revxz/dsh-ui-evolve/session-state
 */

import { SessionStore } from './session-store.js'

/**
 * How long an event may sit in memory before it is written.
 *
 * One second: long enough that a burst of tool calls is one write, short enough
 * that a person who restarts the host right after reading the panel loses at
 * most the last second of a turn they were watching happen anyway.
 */
const WRITE_DELAY_MS = 1000

/**
 * The shape written to disk is a version of its own.
 *
 * Separate from the store's version, which describes the envelope. This one
 * describes the fields inside it: adding a field does not need a bump, but
 * changing what an existing field means does, because an old file would then be
 * read as if its values meant what they say now.
 */
const STATE_VERSION = 2

/**
 * The versions this build can read.
 *
 * v1 stored `paths` as `{ [file]: position }`. v2 stores
 * `{ [file]: { seq, turn, at } }`, because a number cannot say which turn edited
 * the file or when — and the card needs both: `turn` decides whether a file
 * belongs under "this turn" or "earlier" after a restart, and `at` is when the
 * file was produced rather than when it was last written to disk.
 *
 * The bump is a *reader* change, not a migration: `readState` normalises either
 * shape into the v2 one, and every write emits v2. So an old file is upgraded by
 * being read once and written once, with no migration step and no backup — the
 * data it held is exactly the data the v2 record holds, minus the two facts v1
 * never had.
 *
 * Going backwards is deliberately unsupported: a build that only knows v1 reads
 * a v2 file as "not mine" and starts from empty, which looks the same as a
 * session that has not edited anything yet. Losing history to a downgrade is
 * cheaper than holding the format back for it.
 */
const READABLE_VERSIONS = new Set([1, STATE_VERSION])

/**
 * How many edited files a session remembers.
 *
 * Enough for the "all files" view of a long session without turning every panel
 * read into a directory walk. The transcript's own cap is 40 per turn; this one
 * is per session, so it is larger.
 */
const MAX_PATHS = 200

/**
 * @param {any} value - anything.
 * @returns {boolean} true for a plain object, false for arrays and null.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one session's remembered state, or an empty one.
 *
 * Every field is validated rather than trusted: this document was written by an
 * older build of this plugin, or by a newer one, or by a partial write that the
 * store's own guards let through because its envelope was intact. A field that
 * is not the shape this build expects is dropped, not coerced — a name that is
 * not a string is not a skill name, and keeping it would put an invented row in
 * front of the person reading the panel.
 *
 * @param {any} stored - what `SessionStore.read` returned.
 * @returns {{ skills: Map<string, { via: string, at: number }>, tools: Set<string>, servers: Map<string, number>, sequence: number } | undefined}
 */
function readState(stored) {
  if (!isRecord(stored)) return undefined
  if (READABLE_VERSIONS.has(stored.state) === false) return undefined
  const skills = new Map()
  if (isRecord(stored.skills)) {
    for (const [name, entry] of Object.entries(stored.skills)) {
      if (!isRecord(entry)) continue
      if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) continue
      const via = entry.via === 'tool' ? 'tool' : entry.via === 'gesture' ? 'gesture' : undefined
      if (via === undefined) continue
      skills.set(name, { via, at: entry.at })
    }
  }
  const tools = new Set()
  if (Array.isArray(stored.tools)) {
    for (const name of stored.tools) if (typeof name === 'string' && name.length > 0) tools.add(name)
  }
  const servers = new Map()
  if (isRecord(stored.servers)) {
    for (const [server, at] of Object.entries(stored.servers)) {
      if (typeof at !== 'number' || !Number.isFinite(at)) continue
      servers.set(server, at)
    }
  }
  const sequence = typeof stored.sequence === 'number' && Number.isFinite(stored.sequence) && stored.sequence > 0 ? stored.sequence : 0
  // Absent in every file written before the output card became cumulative, and
  // that is a readable state, not a broken one: an older session simply has no
  // remembered paths and starts accumulating from its next turn.
  //
  // Two shapes arrive here. v2 writes an object per file; v1 wrote a bare
  // number, which says where the file sits in recency order and nothing else.
  // Both are normalised to the object shape so nothing downstream has to ask
  // which version it is reading — a bare number becomes
  // `{ seq, turn: undefined, at: undefined }`, and `undefined` is the honest
  // value for two facts a v1 file never recorded. The card treats an unknown
  // turn as "earlier" and an unknown time as "no timestamp to show", which is
  // what a session from before this change should look like.
  const paths = new Map()
  if (isRecord(stored.paths)) {
    for (const [file, raw] of Object.entries(stored.paths)) {
      const entry = readPathEntry(raw)
      if (entry !== undefined) paths.set(file, entry)
    }
  }
  // A file written by an older build that had no cap, or by the merge path
  // before it trimmed, can hold more than this version would ever write. Keeping
  // it whole would carry the excess through every read: `pathsSeen` is what the
  // panel asks for, and each entry is one `fs.stat` on every poll. Trim to the
  // newest `MAX_PATHS` on the way in, so the file shrinks on the next write
  // instead of staying large forever.
  if (paths.size > MAX_PATHS) {
    const newest = [...paths.entries()].sort((a, b) => b[1].seq - a[1].seq).slice(0, MAX_PATHS)
    paths.clear()
    for (const [file, entry] of newest) paths.set(file, entry)
  }
  return { skills, tools, servers, paths, sweep: readSweep(stored.sweep), sequence }
}

/**
 * One remembered file, in whichever shape the file on disk used.
 *
 * @param {any} raw - a `{ seq, turn, at }` object (v2) or a bare position (v1).
 * @returns {{ seq: number, turn: number | undefined, at: number | undefined } | undefined} the entry, or undefined when the value says nothing usable.
 */
function readPathEntry(raw) {
  const finite = value => typeof value === 'number' && Number.isFinite(value)
  if (finite(raw)) return { seq: raw, turn: undefined, at: undefined }
  if (isRecord(raw) === false) return undefined
  if (finite(raw.seq) === false) return undefined
  // A wrong-typed `turn` or `at` is dropped to undefined rather than clamped: a
  // turn of `"3"` is not turn 3, and inventing one would move a file into this
  // turn's group on the strength of a value the writer never meant as a number.
  return {
    seq: raw.seq,
    turn: finite(raw.turn) ? raw.turn : undefined,
    at: finite(raw.at) ? raw.at : undefined,
  }
}

/**
 * The sweep's own account of the last turn, in whichever shape the file used.
 *
 * Two fields only: which turn was swept and whether the sweep could see all of
 * it. A document written before this existed has no `sweep` at all, and that is
 * not an error — it means "this turn made no claim about completeness", which is
 * exactly what an older build could honestly say.
 *
 * @param {any} raw - the stored value.
 * @returns {{ turn: number | undefined, coverage: 'complete' | 'partial' | 'none' } | undefined} the entry, or undefined when unusable.
 */
function readSweep(raw) {
  if (isRecord(raw) === false) return undefined
  const turn = typeof raw.turn === 'number' && Number.isFinite(raw.turn) ? raw.turn : undefined
  // `none` and `partial` survive a round trip; anything else is read as
  // `complete`. The asymmetry is deliberate: a value this build does not
  // recognise is not evidence that something was skipped, and claiming doubt the
  // writer never expressed would put an apology on the card — but the two words
  // that DO carry doubt must not be lost, or the field would only ever weaken.
  const coverage = raw.coverage === 'partial' || raw.coverage === 'none' ? raw.coverage : 'complete'
  return { turn, coverage }
}

/**
 * A record for a session, holding nothing yet.
 *
 * Every field a record needs is here and in one place. There are four callers —
 * first use, a load that found nothing, a load that found a file this build
 * refuses, and a load whose body it could not use — and they all want the same
 * shape. Writing the literal out four times is how one of them ends up missing
 * the field that was added last.
 *
 * `loaded` is false: nothing has read the disk for this id yet. `flush` awaits a
 * load before writing, so a record made here cannot be the one that overwrites a
 * file nobody has read. See `load`.
 *
 * @returns {object} the empty record.
 */
function blankRecord() {
  return {
    skills: new Map(),
    tools: new Set(),
    servers: new Map(),
    /**
     * Files this session edited, each with the tick of its last edit.
     *
     * The output card used to describe the turn that just ended, which meant a
     * turn that changed nothing emptied the card and a turn that re-edited one
     * file left the others looking untouched. The card is now a list of the
     * session's work in recency order, so the fact to keep is per file and
     * survives the turn ending. Same clock as `skills` and `servers`: the map
     * holds a position, `sequence` hands out the next one.
     */
    paths: new Map(),
    /**
     * What the last turn's git sweep could see.
     *
     * Not a file list — `paths` is that. This is the sweep's own admission about
     * its reach: a turn that produced nothing inside a repository the sweep could
     * only half read is a different fact from a turn that produced nothing at
     * all. Both look identical in `paths`, so the doubt has to be stored beside
     * it or it is lost.
     *
     * `undefined` until a sweep reports, and that means "no claim", not "clean".
     */
    sweep: undefined,
    sequence: 0,
    snapshot: undefined,
    timer: undefined,
    writing: undefined,
    dirty: false,
    loaded: false,
  }
}

/**
 * Whether a set of facts is worth a file.
 *
 * This is one test with three readers. `document()` asks it about a record
 * before returning a document; `load()` asks it before marking a record `empty`;
 * `dropIfOrphan()` asks it about a file on disk before unlinking it. They have to
 * agree, and they only agree because they call this.
 *
 * They have disagreed twice. The first time, a session that had only talked was
 * judged empty by one reader and populated by the other, and the file it wrote
 * was deleted by the write that followed. The second time, a conversation whose
 * turns had all been abandoned was content by one reader and an orphan by the
 * other, so the file was deleted on the way out. Both times the fix is the same
 * and in the same place.
 *
 * `previous` is the half that keeps getting forgotten: `rememberTurn` records no
 * skill and calls no tool, it only saves the turn that just ended. A conversation
 * whose whole value is the sentence it just finished looks like an empty record
 * to every counter-based test. `turns` is the other: a conversation whose turns
 * were all abandoned has no sentence at all, only a count, and the count cannot
 * be rebuilt from live events after a restart.
 *
 * @param {object} facts - the four things a document can carry.
 * @param {Map<string, object>} facts.skills - skills seen, by name.
 * @param {Set<string>} facts.tools - MCP tool names seen.
 * @param {object} [facts.previous] - the finished turn, if one finished.
 * @param {number} [facts.turns] - how many turns the conversation has had.
 * @returns {boolean} true when a document would not be empty.
 */
function keepsDocument(facts) {
  if (facts.skills.size > 0 || facts.tools.size > 0) return true
  // A session whose only output is files it wrote is a session with something to
  // show, and it is exactly the shape a conversation leaves behind when all it
  // did was edit code: no skill loaded, no MCP tool called, the summary turned
  // off in settings. Leaving paths out of this answer would make `document()`
  // refuse the file that holds the one card the person is reading.
  if (facts.paths instanceof Map && facts.paths.size > 0) return true
  if (facts.previous !== undefined && facts.previous !== null) return true
  // A count on its own is still something the panel prints, and the one field
  // that cannot be rebuilt from live events after a restart. Leaving it out of
  // this answer meant a conversation whose turns had all been abandoned never
  // wrote again: the file kept the count it had when the process started, so
  // every restart lost the turns since.
  return Number.isFinite(facts.turns) && facts.turns > 0
}

/**
 * Does a record hold anything worth a file?
 *
 * Memory and disk answer the same question about the same four facts, so they
 * share one answer: `keepsDocument`. This function only maps a record's shape
 * onto it. There used to be a third copy of the test, in `dropIfOrphan`, and it
 * went on saying "a count is not content" for a whole round after this one
 * started saying it was — which turned a file the panel needed into an orphan
 * and deleted it.
 *
 * @param {object} entry - the record.
 * @returns {boolean} true when a document would not be empty.
 */
function hasFacts(entry) {
  return keepsDocument({
    skills: entry.skills,
    tools: entry.tools,
    paths: entry.paths,
    previous: entry.snapshot?.previous,
    turns: entry.snapshot?.turns,
  })
}

/**
 * The persisted half of the panel's per-session memory.
 */
class SessionState {
  /**
   * @param {object} options - the dependencies.
   * @param {SessionStore} [options.store] - the on-disk store.
   * @param {(sessionId: string) => { turn?: number, turns?: number, previous?: object } | undefined} [options.snapshotOf] - reads a session's finished turn from the transcript.
   * @param {(sessionId: string, state: object) => void} [options.restore] - hands a stored turn back to the transcript.
   * @param {(message: string, ...rest: any[]) => void} [options.log] - where problems go.
   * @param {() => number} [options.now] - the clock, for tests.
   * @param {number} [options.delayMs] - how long a write may wait; 0 writes at once.
   */
  constructor(options = {}) {
    this.store = options.store ?? new SessionStore()
    this.snapshotOf = options.snapshotOf
    this.restore = options.restore
    this.log = options.log ?? (() => {})
    this.now = options.now ?? (() => Date.now())
    this.delayMs = Number.isFinite(options.delayMs) ? options.delayMs : WRITE_DELAY_MS
    /** @type {Map<string, { skills: Map<string, { via: string, at: number }>, tools: Set<string>, servers: Map<string, number>, sequence: number, timer: any, writing: Promise<void> | undefined }>} */
    this.bySession = new Map()
    /** @type {Map<string, Promise<boolean>>} the read in flight per id, if any. */
    this.loading = new Map()
    /**
     * Ids a sweep has judged gone, for the rest of this process's life.
     *
     * A sweep can run while a write for the same id is parked inside the store,
     * and that write lands after the sweep and recreates the file it deleted. The
     * record that started the write is gone by then, so the only thing that can
     * take the file back down is a note that a decision was made — the file
     * cannot say so itself, because after the write lands it holds facts.
     *
     * That is why this is separate from `entry.empty`: `empty` means "I looked
     * and found nothing", which says nothing about a second process's file, and
     * deleting on it destroyed work (see `dropIfOrphan`). This set means "the
     * host said this session is archived or gone", which is a decision about the
     * session rather than an observation about a file, and it stands.
     *
     * @type {Set<string>}
     */
    this.condemned = new Set()
  }

  /**
   * The in-memory record for a session, created empty on first use.
   *
   * @param {string} sessionId - the session.
   * @returns {object | undefined} the record, or undefined for an id that cannot be stored.
   */
  entry(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    let entry = this.bySession.get(sessionId)
    if (entry !== undefined) return entry
    // An id the store will not turn into a path is an id whose state could never
    // be read back. Keeping it in memory would make the panel show, for this
    // process only, work that vanishes on restart — the exact asymmetry this
    // module exists to remove. So it is refused outright, visibly: one log line.
    if (this.store.pathFor(sessionId) === undefined) {
      this.log('session state: ignoring an id that cannot be stored', sessionId)
      return undefined
    }
    entry = blankRecord()
    this.bySession.set(sessionId, entry)
    return entry
  }

  /**
   * Bring a session's stored state into memory, once.
   *
   * Safe to call on every read and on every write. A record that has already read
   * the disk is left alone, and a read that is already in flight is joined rather
   * than repeated. Neither a second read nor a late one may overwrite what arrived
   * while the first was in flight: live events are always more current than a
   * file, so the read merges into whatever is there now.
   *
   * @param {string} sessionId - the session.
   * @returns {Promise<boolean>} true when something was read and installed.
   */
  async load(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    // The same allowlist `entry()` applies. A session id arrives here from a
    // query parameter; an id that cannot become a file name must not become a
    // memory entry either, or a caller can mint as many as it likes and none of
    // them can ever be written or pruned.
    if (this.store.pathFor(sessionId) === undefined) return false
    const before = this.bySession.get(sessionId)
    // A record that has already read the disk is left alone: live events are
    // newer than the file, and a second read would hand back what the file said
    // before them.
    if (before !== undefined && before.loaded === true) return false
    // One read per id, not one per caller. Every guard above is checked before any
    // await, so two callers that arrive in the same tick both pass them; both
    // would then merge the same file into the same record and shift its counters
    // twice. That doubles every `at` and `sequence`, hands the transcript two
    // copies of the same turn, and makes the second caller believe it read
    // something when the first one did. A panel poll every eight seconds and a
    // `flush` that loads before it writes are enough to overlap.
    const pending = this.loading.get(sessionId)
    if (pending !== undefined) return pending
    const attempt = this.readInto(sessionId)
    this.loading.set(sessionId, attempt)
    try {
      return await attempt
    } finally {
      // Only the read that registered may unregister: a later read may already
      // have replaced this one in the map.
      if (this.loading.get(sessionId) === attempt) this.loading.delete(sessionId)
    }
  }

  /**
   * The read itself: inspect the file, then merge it into the record.
   *
   * Split from `load` so that the single-flight guard has one place to live and
   * this has one job. Not to be called directly — it does no de-duplication.
   *
   * @param {string} sessionId - the session, already validated.
   * @returns {Promise<boolean>} true when the file had something to install.
   */
  async readInto(sessionId) {
    const before = this.bySession.get(sessionId)
    const found = await this.store.inspect(sessionId)
    // Anything that arrived while the read was in flight is newer than the file.
    // `entry()` may have created a record during the await — and it may already
    // hold facts. Merge into whatever is there now, never replace it.
    const current = this.bySession.get(sessionId) ?? before
    if (found.kind === 'absent') {
      // Nothing is on disk. If memory already has facts, they are the whole
      // truth and the record is a normal one; if not, this is the empty record
      // that must never become a file and must be reclaimable by a sweep.
      if (current === undefined) {
        const record = blankRecord()
        record.empty = true
        record.loaded = true
        this.bySession.set(sessionId, record)
        return false
      }
      // A record that existed before the read is memory-only; it has no facts to
      // lose and marking it `empty` is what lets a sweep reclaim it. Facts that
      // arrived during the read already cleared the flag via `schedule`.
      //
      // The question has to be the one `document` asks. Counting skills, tools and
      // sequence but not the snapshot marked a turn-only record empty; the write
      // that followed then went out from a record the sweeper believed nobody
      // owned, and its landing branch deleted the file it had just written.
      if (hasFacts(current) === false) current.empty = true
      current.loaded = true
      // No re-install here. If the id is no longer in `bySession`, a sweep removed
      // it while this read was in flight, and that decision stands: putting the
      // record back would let the write it guards recreate a file the host has
      // already said is not wanted. `flush` re-reads the map after this await and
      // bails on undefined, which is exactly what should happen.
      return false
    }
    if (found.kind === 'foreign') {
      // A file is there and this build refuses it (another state version, a
      // newer envelope, a torn body, a body naming a different session, or a
      // real read error that is not ENOENT). It may belong to a build the user
      // can go back to, so this record is given no authority over it: it carries
      // no `empty` flag, and that flag is the only thing that licenses `flush`
      // to delete a file. Load, then shut down, and the bytes are untouched.
      //
      // What the record does not get is a veto. Once this process has facts of
      // its own, the next write replaces the file — that is the last-write-wins
      // rule the panel was built on (see `docs/handover/02-decisions.md`, the
      // entry on storing state per session). The alternative was tried and is
      // worse: a record forbidden to write would hold this conversation's skills
      // and tools in memory for as long as a file it cannot read sits under the
      // same name, which is the one thing this module exists to stop.
      //
      // A record that already holds facts is not replaced by this read: those
      // facts are this process's and the file is somebody else's, so the read
      // has nothing to add. Marking it loaded is all that is needed to stop the
      // read from repeating.
      if (current === undefined) {
        const record = blankRecord()
        record.loaded = true
        this.bySession.set(sessionId, record)
        return false
      }
      current.loaded = true
      return false
    }

    const stored = found.value
    const state = readState(stored)
    if (state === undefined) {
      // The envelope is ours but the body is not — a field this version cannot
      // use. Same rule as `foreign`: no authority over the file, so a shutdown
      // leaves it alone, and facts of our own eventually replace it.
      if (current === undefined) {
        const record = blankRecord()
        record.loaded = true
        this.bySession.set(sessionId, record)
        return false
      }
      current.loaded = true
      return false
    }

    // What goes back on disk has to describe the same conversation the file did.
    // The restore below hands `previous` and `turns` to the transcript so live
    // readers see them, but a write no longer asks the transcript — it uses
    // `entry.snapshot`. Leaving that undefined means "load, then shut down"
    // writes an empty turn over a finished one, which is the whole failure this
    // module exists to prevent. So the snapshot is installed here, from the same
    // bytes, and the next `schedule()` replaces it with a newer one.
    // `turns` is worth keeping on its own: a session whose last turn was
    // abandoned has no `previous` — an abandoned turn is deliberately not
    // summarised — but it still reached turn N, and the panel counts turns. A
    // snapshot built only when `previous` exists would drop that count on the
    // next write, so the number would go backwards for no reason the user could
    // see.
    const snapshot = Number.isFinite(stored.turns) || isRecord(stored.previous)
      ? { turns: stored.turns, previous: stored.previous }
      : undefined

    if (current === undefined) {
      this.bySession.set(sessionId, { ...state, snapshot, timer: undefined, writing: undefined, dirty: false, loaded: true })
    } else {
      // The file is what this conversation knew before this process started;
      // memory is what has happened since. Neither replaces the other, and
      // dropping either is data loss: replacing memory forgets the last minute,
      // and skipping the merge forgets every turn before the restart — the
      // record in memory makes `load` answer "already read" from then on, so
      // the history would never be read again.
      //
      // The two `at` counters cannot be compared: each started at zero in its
      // own process. Everything the file knew is shifted below everything that
      // has happened since, keeping each group's own order, so recency still
      // means what it says.
      const shift = state.sequence
      for (const [name, skill] of current.skills) current.skills.set(name, { ...skill, at: skill.at + shift })
      for (const [server, at] of current.servers) current.servers.set(server, at + shift)
      // Only the position moves. `turn` and `at` are facts about the work, not
      // about this process's counter, and shifting them would invent a turn
      // number and a timestamp the transcript never produced.
      for (const [file, entry] of current.paths) current.paths.set(file, { ...entry, seq: entry.seq + shift })
      // A skill both sides know keeps `tool` if either of them saw it. The two
      // routes are not equal evidence: `tool` means the model chose to load the
      // skill, `gesture` means a person typed its name. Letting memory's
      // `gesture` win would downgrade a `tool` the file recorded, and the panel
      // filters gesture-loaded skills by `userInvocable` — so a model-only skill
      // would vanish from the panel because someone had reloaded by hand.
      for (const [name, skill] of state.skills) {
        const mine = current.skills.get(name)
        if (mine === undefined) {
          current.skills.set(name, skill)
          continue
        }
        if (mine.via === 'gesture' && skill.via === 'tool') current.skills.set(name, { ...mine, via: 'tool' })
      }
      for (const tool of state.tools) current.tools.add(tool)
      for (const [server, at] of state.servers) if (current.servers.has(server) === false) current.servers.set(server, at)
      // A file both sides know keeps the newer position, which after the shift
      // above is always memory's: memory is what happened since the file was
      // written. The one thing not to do is add the file's entry under a fresh
      // tick, because that would claim this process saw an edit it did not.
      for (const [file, at] of state.paths) if (current.paths.has(file) === false) current.paths.set(file, at)
      // The cap has to be enforced here as well, not only in `rememberPaths`. A
      // process that records paths before its first `load` — the ordinary "event
      // arrives first, poll comes later" order — would otherwise hold the file's
      // list plus its own, and nothing downstream would bring the sum back down:
      // the document written on shutdown is the merged one, so the next restart
      // starts from a larger file. Three restarts of that shape measured 400,
      // 600, then 800 remembered paths against a cap of 200.
      //
      // Trimming is correct here because the shift above has already put every
      // file entry below every memory entry: ascending order deletes the file's
      // oldest first, which is exactly the order to lose them in.
      this.trimPaths(current)
      current.sequence = shift + current.sequence
      // A snapshot already in memory is left alone here. It came from the
      // transcript, and the transcript is the only thing that may add a stored
      // count to a live one: it does so once, guarded by `hydrated`. Adding here
      // as well counted the same file twice whenever this record outlived its
      // transcript — a release clears this map but not that store, so the second
      // read of one file wrote twice the turns it held. The snapshot is taken
      // again from the transcript below, after `restore` has had its say.
      if (current.snapshot === undefined) current.snapshot = snapshot
      current.empty = false
      current.loaded = true
    }
    // A finished turn is worth handing to the transcript, and so is a bare turn
    // count after a restart: the count is the only record that the conversation
    // had happened at all, and the panel prints it. Skipped when the record is
    // gone: the sweep said this session is not one the panel describes, and
    // handing its turn to the transcript would install the conversation the
    // sweep just dismissed.
    if ((isRecord(stored.previous) || Number.isFinite(stored.turns)) && typeof this.restore === 'function' && this.bySession.has(sessionId) === true) {
      this.restore(sessionId, { turns: stored.turns, previous: stored.previous })
    }
    // Now that the transcript has taken the stored count, its answer is the
    // whole conversation — what this process saw plus what the file remembered,
    // added once by whoever is allowed to add it. Asking it here keeps the next
    // write and the panel's count from ever disagreeing.
    const record = this.bySession.get(sessionId)
    const counted = typeof this.snapshotOf === 'function' ? this.snapshotOf(sessionId) : undefined
    if (record !== undefined && counted !== undefined) record.snapshot = counted
    return true
  }

  /**
   * A skill this session loaded, by either route.
   *
   * @param {string} sessionId - the session.
   * @param {string} name - the skill name.
   * @param {'tool' | 'gesture'} via - how it was loaded.
   * @returns {void}
   */
  rememberSkill(sessionId, name, via) {
    if (typeof name !== 'string' || name.length === 0) return
    const entry = this.entry(sessionId)
    if (entry === undefined) return
    const previous = entry.skills.get(name)
    // Delete before set so a reload moves to the end of the insertion order, and
    // keep `tool` once seen: a skill that has been called by name and also
    // gestured at is still a skill this session used as a tool, and letting a
    // later gesture demote it would hide it from a panel that filters gestures.
    entry.skills.delete(name)
    entry.skills.set(name, { via: previous?.via === 'tool' ? 'tool' : via, at: ++entry.sequence })
    this.schedule(sessionId)
  }

  /**
   * An MCP tool this session called.
   *
   * Presence is proved by traffic: a configured server that never connected
   * contributes no calls, and the panel describes what is available. The server
   * name is taken from the tool name the host uses, `mcp__<server>__<tool>`.
   *
   * @param {string} sessionId - the session.
   * @param {string} toolName - the tool name from the call.
   * @returns {void}
   */
  rememberTool(sessionId, toolName) {
    if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return
    const entry = this.entry(sessionId)
    if (entry === undefined) return
    entry.tools.add(toolName)
    const cut = toolName.indexOf('__', 'mcp__'.length)
    const server = cut === -1 ? toolName.slice('mcp__'.length) : toolName.slice('mcp__'.length, cut)
    if (server.length > 0) entry.servers.set(server, ++entry.sequence)
    this.schedule(sessionId)
  }

  /**
   * Files a turn edited, folded into the session's running list.
   *
   * Called when a turn ends, because that is the only moment the transcript's
   * own path list is complete. Each file gets a fresh position: re-editing a
   * file already in the list moves it to the front rather than leaving it where
   * it was on first touch, which is what "the work I just did" means to someone
   * reading the card.
   *
   * `turn` is the number of the turn that just ended. It is written down rather
   * than recomputed, because the only other source is the transcript's previous
   * snapshot — which the panel can still see for the newest turn but not for any
   * turn after the next one ends. Without it, a restart turned every file into
   * "earlier" and the card quietly forgot which work was the latest.
   *
   * @param {string} sessionId - the session.
   * @param {string[]} paths - the paths the finished turn wrote.
   * @param {number | undefined} [turn] - the turn that wrote them, when known.
   * @returns {void}
   */
  rememberPaths(sessionId, paths, turn) {
    if (!Array.isArray(paths) || paths.length === 0) return
    const entry = this.entry(sessionId)
    if (entry === undefined) return
    const stamp = Number.isFinite(turn) ? turn : undefined
    // Through the injected clock, like every other timestamp this module writes.
    // Reading `Date.now()` directly let one document carry two contradictory
    // times — the paths' `at` in real wall-clock time while `updated` followed the
    // clock the tests (and any future caller) supply.
    const at = this.now()
    let touched = false
    for (const file of paths) {
      if (typeof file !== 'string' || file.length === 0) continue
      // Delete before set, the same way `rememberSkill` does: a Map keeps
      // insertion order and a re-set keeps the old slot, and this list's whole
      // order is "most recently edited first".
      entry.paths.delete(file)
      entry.paths.set(file, { seq: ++entry.sequence, turn: stamp, at })
      touched = true
    }
    if (touched === true) {
      this.trimPaths(entry)
      this.schedule(sessionId)
    }
  }

  /**
   * Keep the path list down to the size the card can use.
   *
   * The transcript caps its own per-turn list at 40 and the client draws five;
   * this list had no cap at all, so it grew for the life of the session. That is
   * not a display problem — it is one `fs.stat` per entry on every panel read,
   * eight seconds apart, and a JSON object in the state file that never stops
   * growing. Dropping the oldest edits costs nothing visible: the card shows the
   * newest five, and "all" is a scroll through a session's work rather than an
   * archive of it.
   *
   * @param {object} entry - the record to trim in place.
   * @returns {void}
   */
  trimPaths(entry) {
    if (entry.paths.size <= MAX_PATHS) return
    const ordered = [...entry.paths.entries()].sort((a, b) => a[1].seq - b[1].seq)
    const excess = entry.paths.size - MAX_PATHS
    for (let index = 0; index < excess; index += 1) {
      const oldest = ordered[index]
      if (oldest !== undefined) entry.paths.delete(oldest[0])
    }
  }

  /**
   * The files this session edited, newest first.
   *
   * The order is the record's own positions, descending — the panel sorts by
   * mtime when it can and falls back to this, so the two agree.
   *
   * Each entry carries the turn that last wrote the file and when that happened,
   * because the panel cannot reconstruct either: `turn` is what puts a file in
   * "this turn" after a restart, and `at` is when the file was produced rather
   * than when it was last written to disk, which is what `mtimeMs` reports.
   *
   * @param {string} sessionId - the session.
   * @returns {Array<{ path: string, turn: number | undefined, at: number | undefined }>} the files, or an empty list.
   */
  pathsSeen(sessionId) {
    const entry = this.bySession.get(sessionId)
    if (entry === undefined || entry.paths.size === 0) return []
    return [...entry.paths.entries()]
      .sort((a, b) => b[1].seq - a[1].seq)
      .map(([file, at]) => ({ path: file, turn: at.turn, at: at.at }))
  }

  /**
   * A turn finished, so the snapshot is worth writing down.
   *
   * The other accumulators record a fact when it arrives. This one records
   * nothing: it exists because the panel describes the turn that *ended*, and
   * until that turn ends there is no snapshot to save. Writing only when a fact
   * arrived would leave the file a turn behind — a refreshed panel would show
   * the skills and MCP servers of the current turn beside the summary of the
   * previous one.
   *
   * Mid-turn events deliberately do not write. The panel is not a log, and
   * rewriting the document once per tool call would be a write per poll for a
   * document whose interesting half had not changed.
   *
   * @param {string} sessionId - the session.
   * @returns {void}
   */
  rememberTurn(sessionId) {
    const entry = this.entry(sessionId)
    if (entry === undefined) return
    this.schedule(sessionId)
  }

  /**
   * A turn was swept, and this is how much of it the sweep could see.
   *
   * Written even when the sweep found no files, because the two facts it can
   * record — "clean" and "could only half see" — are both invisible in `paths`.
   * A turn that produced nothing inside a repository the sweep could only
   * partially read looks exactly like a turn that produced nothing at all, and
   * only one of those deserves to be believed without a caveat.
   *
   * Deliberately not subject to `keepsDocument`: coverage with no files is a
   * claim about a turn, not content of its own. A session whose only fact is
   * "I could not see everything" still has nothing to show.
   *
   * @param {string} sessionId - the session.
   * @param {number | undefined} turn - the turn that was swept, when known.
   * @param {'complete' | 'partial' | 'none'} coverage - how much the sweep could see, or `none` when no sweep ran.
   * @returns {void}
   */
  rememberSweep(sessionId, turn, coverage) {
    const entry = this.entry(sessionId)
    if (entry === undefined) return
    const stamp = typeof turn === 'number' && Number.isFinite(turn) ? turn : undefined
    // Both words that carry doubt are stored as given. `complete` is the plain
    // case, and writing it for every ordinary turn would grow the file to say
    // nothing. Same vocabulary as `readSweep`, from the other side.
    const claim = coverage === 'partial' || coverage === 'none' ? coverage : 'complete'
    const next = { turn: stamp, coverage: claim }
    // Replacing rather than accumulating: this describes the newest sweep, and a
    // list of historical coverage claims is not something any reader wants.
    entry.sweep = next
    this.schedule(sessionId)
  }

  /**
   * What the last sweep could see, for the panel to caveat its own file list.
   *
   * @param {string} sessionId - the session.
   * @returns {{ turn: number | undefined, coverage: 'complete' | 'partial' | 'none' } | undefined} the claim, or undefined when no sweep has reported.
   */
  sweepSeen(sessionId) {
    const entry = this.bySession.get(sessionId)
    return entry === undefined ? undefined : entry.sweep
  }

  /**
   * The skills a session loaded, as `describeSkills` wants them.
   *
   * @param {string} sessionId - the session.
   * @returns {Map<string, 'tool' | 'gesture'> | undefined} name to route, or undefined when nothing is known.
   */
  skillsUsed(sessionId) {
    const entry = this.bySession.get(sessionId)
    if (entry === undefined) return undefined
    const used = new Map()
    for (const [name, skill] of entry.skills) used.set(name, skill.via)
    return used
  }

  /**
   * The MCP tool names a session called.
   *
   * @param {string} sessionId - the session.
   * @returns {Set<string>} the tool names, possibly empty.
   */
  toolsSeen(sessionId) {
    const entry = this.bySession.get(sessionId)
    return entry === undefined ? new Set() : new Set(entry.tools)
  }

  /**
   * The recency clock, as one map over both lists.
   *
   * Built on read rather than maintained, so the map cannot drift from the
   * entries it describes: there is one number per entry and it is the entry's
   * own `at`.
   *
   * @param {string} sessionId - the session.
   * @returns {Map<string, number>} key to position, newest last.
   */
  recency(sessionId) {
    const entry = this.bySession.get(sessionId)
    if (entry === undefined) return new Map()
    const clock = new Map()
    for (const [name, skill] of entry.skills) clock.set(`skill:${name}`, skill.at)
    for (const [server, at] of entry.servers) clock.set(`mcp:${server}`, at)
    return clock
  }

  /**
   * The document to write for a session.
   *
   * @param {string} sessionId - the session.
   * @returns {object | undefined} the document, or undefined when there is nothing worth writing.
   */
  document(sessionId) {
    const entry = this.bySession.get(sessionId)
    if (entry === undefined) return undefined
    // Captured when the session became dirty, not asked again here. A write can
    // be in flight while the next fact arrives; asking the transcript now would
    // let a transcript dropped in the meantime turn a finished turn into "no
    // turn yet" and overwrite a good snapshot. See `schedule`.
    const snapshot = entry.snapshot
    // A session that has loaded nothing, called no MCP tool and finished no turn
    // has nothing to say. Writing an empty document would create a file for every
    // conversation that was ever opened, which the pruner would then have to
    // carry — so absence is recorded as absence.
    //
    // `hasFacts` rather than a second copy of the test: the same question is asked
    // by `load` when it decides whether a record may be marked `empty`, and two
    // copies of it drifted apart once already.
    if (hasFacts(entry) === false) return undefined
    const skills = {}
    for (const [name, skill] of entry.skills) skills[name] = { via: skill.via, at: skill.at }
    const servers = {}
    for (const [server, at] of entry.servers) servers[server] = at
    const paths = {}
    for (const [file, remembered] of entry.paths) paths[file] = { seq: remembered.seq, turn: remembered.turn, at: remembered.at }
    return {
      state: STATE_VERSION,
      turns: snapshot?.turns,
      previous: snapshot?.previous,
      skills,
      tools: [...entry.tools],
      servers,
      paths,
      sweep: entry.sweep === undefined ? undefined : { turn: entry.sweep.turn, coverage: entry.sweep.coverage },
      sequence: entry.sequence,
    }
  }

  /**
   * Mark a session dirty and schedule one write.
   *
   * @param {string} sessionId - the session.
   * @returns {void}
   */
  schedule(sessionId) {
    const entry = this.bySession.get(sessionId)
    if (entry === undefined) return
    // Read the transcript here, while the fact that made this session dirty is
    // still true of it. `document()` must not ask again: it may run a second
    // time after this one, long after the caller dropped the transcript.
    const snapshot = typeof this.snapshotOf === 'function' ? this.snapshotOf(sessionId) : undefined
    if (snapshot !== undefined) entry.snapshot = snapshot
    // It has facts now, so it is no longer one of the records that can never be
    // written and therefore never be pruned.
    entry.empty = false
    entry.dirty = true
    if (this.delayMs <= 0) {
      this.flush(sessionId)
      return
    }
    if (entry.timer !== undefined || entry.writing !== undefined) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      this.flush(sessionId)
    }, this.delayMs)
    // A pending write is not a reason to keep the host alive.
    if (typeof entry.timer?.unref === 'function') entry.timer.unref()
  }

  /**
   * Write a session's document now.
   *
   * Concurrent calls share one write rather than queueing two: the second would
   * write the same document and could finish first, leaving the older of two
   * identical writes in place and the newer one discarded by rename order.
   *
   * @param {string} sessionId - the session.
   * @returns {Promise<void>} resolves when the write settled, never rejects.
   */
  async flush(sessionId) {
    let entry = this.bySession.get(sessionId)
    if (entry === undefined) return
    // A record that has never read the disk must read it before it writes. The
    // events that made it dirty can arrive before the panel's first poll — the
    // host replays a turn before anything asks for the panel — and a record made
    // by the first event knows nothing about the turns and skills already on
    // disk under this id. Writing that record as-is replaces somebody's history
    // with the last few seconds of it, and because the record then counts as
    // read, nothing ever goes back for the rest.
    //
    // The merge happens in `load`, which keeps what is in memory and adds what
    // was on disk; it is a no-op for a record that has already read.
    //
    // This runs before the timer is cleared and before `writing` is claimed,
    // then both are re-read: the await can hand the id to a different record
    // (a sweep, a `release`, a newer event), and a claim taken on the old one
    // would guard the wrong object — two flushes would then both write.
    if (entry.loaded !== true) {
      await this.load(sessionId)
      entry = this.bySession.get(sessionId)
      if (entry === undefined) return
    }
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (entry.writing !== undefined) return entry.writing
    entry.dirty = false
    const document = this.document(sessionId)
    if (document === undefined) {
      // An `empty` record is the panel's own note that it looked and found
      // nothing. A file under this id is then either the leftover of a write by
      // a record the sweep already deleted, or something this process never
      // wrote at all. Deleting the first keeps the file from outliving the
      // session by a whole prune interval — a window in which `load` reads it
      // back and describes a conversation that is gone. Deleting the second
      // destroys another process's work: `empty` was recorded before that
      // process wrote, and says nothing about the file as it stands now. So ask
      // the file instead of the flag.
      if (entry.empty === true) await this.dropIfOrphan(sessionId)
      return
    }
    entry.writing = this.store
      // One `updated` format across both writers. `SessionStore.write` stamps an
      // ISO string of its own when the caller does not; this side's clock is
      // milliseconds because that is what a clock is, and handing the number
      // through meant a file's `updated` was a string or a number depending on
      // which layer wrote it last. Anything reading the field would have to
      // handle both, and nothing did.
      .write(sessionId, { ...document, updated: new Date(this.now()).toISOString() })
      .then(undefined, (error) => this.log('session state: could not write', sessionId, error?.message ?? error))
      .then(async () => {
        entry.writing = undefined
        // Three things can be true of this id now, and they are not the same
        // thing. Treating them as one is what turned a fix into a deletion.
        const current = this.bySession.get(sessionId)
        if (current === undefined) {
          // Nothing owns the id any more. A sweep deleted it while this write
          // was in flight, so the file this write just created is one the sweep
          // decided against: it goes with the decision, and the deferred
          // "something changed" pass is not run for an entry nobody has.
          await this.store.forget(sessionId)
          return
        }
        if (current !== entry) {
          // A *newer* record took the same id over while this write was in
          // flight — the session came back after the sweep, or `release` dropped
          // the record and the next event rebuilt it. Deleting the file here
          // would destroy what it just saved, which is the opposite of cleaning
          // up after a deleted session.
          //
          // But this write did land, and it carried the older record's facts. So
          // the file now describes the conversation as it was before it came
          // back. Hand the write to whoever owns the id now: one more pass puts
          // what the panel is actually showing on disk.
          current.dirty = true
          return this.flush(sessionId)
        }
        // Something changed while the file was being replaced. Writing it now
        // rather than waiting for the next event is what makes "the last write
        // wins" describe the last change instead of the last-but-one.
        if (entry.dirty === true) return this.flush(sessionId)
      })
    return entry.writing
  }

  /**
   * Delete a file under an id this process has decided it owns nothing of.
   *
   * `empty` is a statement about the past: this process looked at the disk and
   * found nothing. It is not a statement about the file as it stands now, and
   * the two come apart as soon as a second host process is running — which it
   * can be, since the `sequence` shift in `load` exists precisely so two
   * processes' counters can be compared. One process records "nothing stored",
   * the other writes a document, and only then does the first shut down. The
   * flag still says empty; the file says otherwise.
   *
   * So the delete asks the file, not the flag. It goes only when the file is
   * gone already or is recognisably a document with nothing in it — the two
   * cases where removing it destroys nothing.
   *
   * @param {string} sessionId - the session.
   * @returns {Promise<void>} resolves when the question settled.
   */
  async dropIfOrphan(sessionId) {
    // A sweep already answered this question about the session, and its answer
    // was no. The file cannot override it: whatever is on disk now was put there
    // by a write that was already in flight when the sweep ran, and letting the
    // file speak for itself would reverse a decision the host made.
    if (this.condemned.has(sessionId)) {
      await this.store.forget(sessionId)
      return
    }
    const found = await this.store.inspect(sessionId)
    if (found.kind === 'absent') {
      // Nothing is there; the unlink is a no-op that also clears any directory
      // entry left behind by a partial write.
      await this.store.forget(sessionId)
      return
    }
    // A file this build will not read is not an orphan. It may belong to a build
    // the user can go back to, and nothing here can tell whether it holds facts.
    if (found.kind !== 'present') return
    const stored = readState(found.value)
    if (stored === undefined) return
    // A document with no skills, no tools, no finished turn and no turn count
    // says exactly what the `empty` record said, only about the file. That is
    // the leftover worth removing.
    //
    // The turn and its count are read from the document itself rather than from
    // `readState`: that function answers "what may this build use", and both are
    // kept at the top level, outside the shape it returns. Reading
    // `stored.previous` would be undefined for every file and make this function
    // delete documents it should keep.
    //
    // The decision itself is `keepsDocument` — the same one memory uses. Asking
    // it in two places is how the file this module exists to protect ended up
    // being deleted as an orphan.
    const keep = keepsDocument({
      skills: stored.skills,
      tools: stored.tools,
      paths: stored.paths,
      previous: found.value.previous,
      turns: found.value.turns,
    })
    if (keep === true) return
    await this.store.forget(sessionId)
  }

  /**
   * Write a session down and drop it from memory.
   *
   * Dropping is not forgetting: the file stays. Disposal is not deletion — the
   * host disposes every agent when it shuts down, so a `forget` here would empty
   * the panel on every restart, which is the bug this module was written to fix.
   *
   * @param {string} sessionId - the session.
   * @returns {Promise<void>} resolves when the write settled.
   */
  async release(sessionId) {
    await this.flush(sessionId)
    this.bySession.delete(sessionId)
  }

  /**
   * Remove a session's file and its memory.
   *
   * @param {string} sessionId - the session.
   * @returns {Promise<void>} resolves when the file is gone.
   */
  async forget(sessionId) {
    const entry = this.bySession.get(sessionId)
    if (entry !== undefined) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      this.bySession.delete(sessionId)
    }
    await this.store.forget(sessionId)
  }

  /**
   * Remove the files whose sessions the host says are gone.
   *
   * Only files are removed here; memory follows the agent's own lifetime. A
   * session removed while this process is still holding its transcript is left
   * to `release` — the panel is describing a conversation that exists.
   *
   * @param {object} sources - what the host can say about its sessions.
   * @param {() => string[] | undefined} [sources.archived] - session ids hidden from every surface.
   * @param {(sessionId: string) => Promise<boolean>} [sources.known] - whether a session still exists.
   * @returns {Promise<number>} how many files were removed.
   */
  async prune(sources = {}) {
    // Records that never had a fact are dropped on every sweep, before the store
    // is asked anything. They are the one kind of entry with no file behind it:
    // a panel poll for a well-formed id that was never a session installs one so
    // the next tick does not re-read the disk, and nothing else would ever
    // remove it. Leaving them to the "removed > 0" branch below would let them
    // outlive their own file forever.
    for (const [sessionId, entry] of [...this.bySession.entries()]) {
      if (entry.empty === true) this.bySession.delete(sessionId)
    }

    // Deletions are reported one at a time rather than as a list read
    // afterwards. The store awaits the host between ids; a write landing in that
    // gap would find the entry still in memory, take it for "still wanted" and
    // leave its file behind — an orphan this sweep had already decided against.
    const swept = {
      ...sources,
      onRemoved: (sessionId, reason) => {
        // Only one of the two ways a file goes away says anything about the
        // session. `gone` is the host's judgement that this conversation is
        // over: the record goes with it, and the id is marked condemned so a
        // write still in flight cannot put the file back. `cap` is about the
        // directory having grown, not about any conversation — the session may
        // be running right now, and clearing its memory would throw away facts
        // it is still producing and make the next write spell a fragment of the
        // truth. So the file goes and the record stays.
        if (reason === 'cap') return
        this.bySession.delete(sessionId)
        this.condemned.add(sessionId)
      },
    }
    const removed = await this.store.pruneIfDue(swept)
    // No sweep ran: the interval had not elapsed. `considered` is the store's
    // own way of saying so, because a skipped call judges nothing — and asking
    // the host now would turn every panel poll into a round-trip, which is the
    // throttle this whole path exists to avoid.
    if (this.store.considered === undefined) return 0

    // The store works from the directory listing, so it cannot see an entry
    // whose write is still in flight — there is no file to find yet. Such an
    // entry would recreate its file as soon as the write lands, reversing the
    // sweep's decision. So the host is asked about these directly: a session the
    // host says is archived or gone is not one the panel should still be
    // describing, written or not.
    //
    // Only entries this sweep has no opinion about are asked about. Everything
    // the store judged was already settled through `onRemoved`, and asking again
    // would double the host round-trips per sweep for the same answer.
    const judged = new Set(this.store.considered ?? [])
    const archived = new Set(typeof sources.archived === 'function' ? sources.archived() ?? [] : [])
    const known = typeof sources.known === 'function' ? sources.known : undefined
    for (const sessionId of [...this.bySession.keys()]) {
      if (judged.has(sessionId)) continue
      if (archived.has(sessionId)) {
        this.bySession.delete(sessionId)
        this.condemned.add(sessionId)
        continue
      }
      if (known === undefined) continue
      let alive
      try {
        alive = await known(sessionId)
      } catch (error) {
        // Same contract the store honours: a host that cannot answer is not a
        // host that said no. Stop asking and keep what is left.
        this.log('session state: keeping the rest, the host could not answer', error?.message ?? error)
        return removed
      }
      if (alive === false) {
        this.bySession.delete(sessionId)
        this.condemned.add(sessionId)
      }
    }

    return removed
  }
}

export { SessionState, STATE_VERSION, WRITE_DELAY_MS, readState }
