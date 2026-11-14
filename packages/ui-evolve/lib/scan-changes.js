import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isUnwalkableDirectory } from './api.js'

/**
 * Finds files under a workspace that changed since a turn began.
 *
 * The third source for the output card, and the last one to arrive. The other
 * two miss most of what a session actually produces:
 *
 * - the tool call names one path, and a script that writes four files names
 *   none of them;
 * - git status sees what is uncommitted, which misses a non-repository, a
 *   checkout the turn committed to, and — measured on a real sample — a file
 *   that was already untracked and got rewritten, because `??` before and `??`
 *   after are the same word.
 *
 * A modification time is a weaker fact than either. It says a file was touched,
 * not by whom. `git checkout`, `npm install` and a build all touch files that
 * nobody chose to produce, and an editor that writes a temporary file and
 * renames it leaves a timestamp from the rename. So this answers "what looks
 * new", and the merge in S8 decides what to call it. On its own it is enough for
 * the case that motivated it: a working directory that is not a repository at
 * all, where neither of the other two can say anything.
 *
 * Nothing here reads a file. `stat` is cheap on every filesystem this runs on,
 * content hashing is not, and the card only needs paths.
 */

/**
 * How many files the walk may look at before it stops.
 *
 * Not a performance number. A workspace can hold a million files, and the panel
 * is one HTTP request away from the client every few seconds; a walk that took
 * ten seconds would make the panel slower than useless. Five thousand stats on a
 * warm cache is a few tens of milliseconds, and it is far more than the forty
 * rows the card can show.
 */
export const MAX_SCANNED_ENTRIES = 5000

/**
 * How deep the walk descends below the workspace root.
 *
 * Depth is counted in directories below the root, so a file at the root is depth
 * 0 and `src/lib/inner/file.ts` is depth 3. Eight covers every layout I have
 * seen (`src/a/b/c/d/e/file` is 6) while keeping a pathological symlink-free but
 * deeply nested tree from consuming the whole entry budget.
 */
export const MAX_SCAN_DEPTH = 8

/**
 * How long the walk may run before it reports what it has.
 *
 * The clock is checked between directories, not between files, because the
 * filesystem calls themselves are not interruptible; one slow directory can
 * still overshoot. That is deliberate — the alternative is a timer racing the
 * walk and mutating an array mid-iteration.
 */
export const MAX_SCAN_MS = 1500

/**
 * Walks `cwd` and returns the files whose modification time is at or after
 * `since`.
 *
 * The comparison is `>=` rather than `>`: a turn that starts and finishes inside
 * one filesystem timestamp tick (one second on some mounts, one millisecond on
 * NTFS) would otherwise report nothing at all. Reporting a file that was written
 * one millisecond before the turn began is a row too many; reporting nothing
 * because the clock could not resolve the difference is the whole feature
 * failing.
 *
 * @param {object} options - the walk.
 * @param {string} options.cwd - the workspace. Required; there is no default,
 *   because defaulting to `process.cwd()` would make the panel describe the
 *   host's own install directory.
 * @param {number} options.since - milliseconds; files at or after this are kept.
 * @param {(segment: string) => boolean} [options.skipDirectory] - consulted
 *   before descending. The production value is `isUnwalkableDirectory`, which
 *   is narrower than the card's filter on purpose: `dist` and `build` are
 *   generated rows, but they are also where scripts write, and git cannot see
 *   them, so a walk that skipped them would be blind exactly where it was added
 *   to help. The substitution point exists so a test can prove the walk asks at
 *   all.
 * @param {number} [options.maxEntries] - replaces `MAX_SCANNED_ENTRIES`.
 * @param {number} [options.maxDepth] - replaces `MAX_SCAN_DEPTH`.
 * @param {number} [options.maxMs] - replaces `MAX_SCAN_MS`.
 * @param {number} [options.now] - replaces `Date.now`, for the clock budget.
 * @returns {Promise<{ paths: string[], scanned: number, truncated: boolean }>}
 *   `truncated` is true when the walk stopped before finishing: an entry or
 *   depth or time limit was reached, or a directory could not be read. It is
 *   the scan's equivalent of git's `coverage: partial` — a truthful claim about
 *   how much of the workspace this answer covers.
 */
export async function scanChanges(options) {
  const empty = { paths: [], scanned: 0, truncated: false }
  const cwd = options?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return empty
  const since = options?.since
  if (typeof since !== 'number' || Number.isFinite(since) === false) return empty

  // Defaults to a predicate narrower than the card's, never to "descend into
  // everything". Two different questions are being answered: the card asks "is
  // this row worth showing", the walk asks "could a turn's output be inside".
  // `node_modules` answers no to the second — it alone can hold more files than
  // the entire budget, so descending would spend the 5000 entries inside one
  // dependency tree and report those files as the turn's output while the real
  // file was never reached. `dist` and `build` answer yes to the second: they are
  // where scripts write, and they are in `.gitignore` in every project of the
  // kind that has them, which makes them the exact overlap between the card's
  // filter and git's blind spot. Skipping them made this bracket useless there.
  const skipDirectory = typeof options?.skipDirectory === 'function' ? options.skipDirectory : isUnwalkableDirectory
  const maxEntries = Number.isFinite(options?.maxEntries) === true ? options.maxEntries : MAX_SCANNED_ENTRIES
  const maxDepth = Number.isFinite(options?.maxDepth) === true ? options.maxDepth : MAX_SCAN_DEPTH
  const maxMs = Number.isFinite(options?.maxMs) === true ? options.maxMs : MAX_SCAN_MS
  const now = typeof options?.now === 'function' ? options.now : Date.now

  const started = now()
  const paths = []
  let scanned = 0
  let truncated = false

  /**
   * Whether to stop before doing any more work.
   *
   * The entry budget is checked here rather than after the increment so that a
   * walk which is exactly at the limit finishes cleanly: stopping at
   * `scanned === maxEntries` when there was nothing left to read would report
   * `truncated` for a complete answer, and a caller that trusts `truncated` would
   * then show a caveat about a workspace it read entirely.
   */
  const outOfBudget = () => scanned >= maxEntries || now() - started >= maxMs

  /** One directory's children, or nothing when it cannot be read. */
  async function readDirectory(directory) {
    try {
      return await readdir(directory, { withFileTypes: true })
    } catch {
      // A directory can vanish mid-walk, or be a link we are not allowed to
      // follow. Either way the walk's answer is now incomplete, and saying so is
      // more useful than pretending the subtree was empty.
      truncated = true
      return undefined
    }
  }

  /** Records one file if it is new enough. */
  async function consider(absolute) {
    let info
    try {
      info = await stat(absolute)
    } catch {
      // Deleted between the listing and the stat. Not truncated: the walk did
      // see this entry and correctly found nothing to report.
      return
    }
    if (info.isFile() === false) return
    if (typeof info.mtimeMs === 'number' && info.mtimeMs >= since) paths.push(absolute)
  }

  async function walk(directory, depth) {
    if (depth > maxDepth) {
      truncated = true
      return
    }
    const entries = await readDirectory(directory)
    if (entries === undefined) return
    for (const entry of entries) {
      if (outOfBudget()) {
        truncated = true
        return
      }
      scanned += 1
      const absolute = join(directory, entry.name)
      if (entry.isDirectory() === true) {
        if (skipDirectory(entry.name) === true) continue
        await walk(absolute, depth + 1)
        continue
      }
      if (entry.isFile() === true) await consider(absolute)
      // Anything else — a socket, a fifo, a symlink — is not a produced file.
      // Symlinks are skipped rather than followed: a link to the parent directory
      // would otherwise make this a walk of the whole disk.
    }
  }

  await walk(cwd, 0)
  return { paths, scanned, truncated }
}
