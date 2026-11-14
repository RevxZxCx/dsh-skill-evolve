/**
 * `git-changes` — the A path of the output-file sweep: ask git what a turn
 * touched inside a repository.
 *
 * ## Why git, when `report_output_files` already exists
 *
 * The declaring tool only works if the model remembers to call it. Measured on
 * one real session: eight files on disk, three declared. Git answers the other
 * question without asking anybody — inside a repository, "what changed" is a
 * fact the working tree already holds.
 *
 * Qoder does the same thing (`turn_file_change_sets`, populated from
 * `git status --porcelain=v1 -z --untracked-files=all`). The command is copied
 * for the same reason its authors chose it: `-z` separates records with NUL and
 * never quotes a path, so a name with a space, a quote or a newline arrives
 * intact and needs no unescaping.
 *
 * ## What this deliberately does not do
 *
 * No `git diff`. The card shows which files a turn produced, not what changed
 * inside them, and a diff of a large turn would be megabytes for one row of
 * text.
 *
 * No staging, no committing, no `git add`. Reading is the whole job; a plugin
 * that silently wrote to somebody's index would be a much larger decision than
 * a side panel should make.
 *
 * @module @revxz/dsh-ui-evolve/git-changes
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** How long `git status` may take before the A path gives up for this turn. */
export const GIT_TIMEOUT_MS = 2000

/**
 * How many records the A path will read before deciding the answer is noise.
 *
 * A turn that touched two thousand paths in one repository did not produce two
 * thousand deliverables — it ran a formatter over the tree, or checked out a
 * branch. Such a list is not a list of anything, so it is dropped rather than
 * shown.
 */
export const MAX_CHANGED_FILES = 2000

/** `C` and `R` consume the next record as the original path. */
const PAIRED_CODES = new Set(['R', 'C'])

/**
 * How many child repositories a workspace may hold before discovery gives up.
 *
 * A directory of twenty checkouts is a monorepo working set; a directory of two
 * hundred is a home folder someone opened by accident. Past the cap the answer
 * stops being "these are the repositories" and starts being "here is a pile of
 * folders", so the sweep reports `partial` instead of pretending.
 */
export const MAX_CHILD_ROOTS = 20

/**
 * Directories that are never a repository the user meant to open.
 *
 * `findChildRepositories` looks one level down for `.git`. Dependency trees are
 * full of them — every package in `node_modules` may carry a `.git` — and
 * walking into that would turn one workspace into a thousand roots.
 */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv'])

/**
 * Split one `git status --porcelain=v1 -z` stream into records.
 *
 * Each record is `XY<space><path>` where `XY` is two status characters. When
 * the first of them is `R` or `C`, the record is followed by a second one
 * holding the original path — a rename is two NUL-terminated strings.
 *
 * A rename keeps the **new** path and drops the old one: the old path no longer
 * exists, and a card row for it would be a row for a file the turn removed
 * while hiding the one it created.
 *
 * @param {string} text - the raw stdout, NUL separated.
 * @returns {Array<{ path: string, status: string }>} repository-relative paths.
 */
export function parsePorcelain(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const records = text.split('\u0000')
  const found = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    // A trailing NUL leaves one empty string at the end; a malformed short
    // record means git wrote something this reader does not understand, and
    // guessing at it would invent a filename.
    if (record.length < 4) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (path.length === 0) continue
    found.push({ path, status })
    if (PAIRED_CODES.has(status.charAt(0)) === true) index += 1
  }
  return found
}

/**
 * Run git and hand back the exit code and stdout.
 *
 * Kept injectable so the parser can be tested without a repository, and so a
 * test can simulate a timeout or an oversized answer without waiting two
 * seconds or checking out a large tree.
 *
 * @param {string[]} args - arguments after `git`.
 * @param {string} cwd - where to run it.
 * @returns {Promise<{ code: number, stdout: string }>} never rejects.
 */
export function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        // Three different failures land here and all of them mean the same
        // thing to this caller: git could not answer. A directory that is not a
        // repository exits non-zero; a missing binary leaves `error` set with no
        // status at all. Neither is worth a log line, because "not a repository"
        // is the normal case for most workspaces.
        const code = error === null || error === undefined ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' })
      }
    )
  })
}

/**
 * Turn repository-relative paths into absolute ones.
 *
 * `git status` prints paths relative to the **repository root**, not to the
 * directory it ran in, so the root is what they get joined to. Slashes are
 * already `/` on every platform; `join` normalises them for Windows.
 *
 * @param {string} root - absolute repository root.
 * @param {string} relative - a path from `parsePorcelain`.
 * @returns {string} absolute path.
 */
export function toAbsolute(root, relative) {
  return join(root, relative)
}

/**
 * Walk up from a directory looking for `.git`.
 *
 * Returns the directory that contains it, or `undefined` when the walk reaches
 * the filesystem root. Purely a filesystem check — no process is spawned — so a
 * workspace that is not a repository costs one `stat` per level instead of two
 * `git` invocations.
 *
 * `existsSync` rather than a directory check because `.git` is a plain file in a
 * worktree (it holds `gitdir: …`) and in a submodule.
 *
 * @param {string} directory - where to start, normally the session workspace.
 * @returns {string | undefined} the containing directory, if any.
 */
export function findRepositoryRoot(directory) {
  if (typeof directory !== 'string' || directory.length === 0) return undefined
  let current = resolve(directory)
  for (;;) {
    // A failure here means the path is unreadable, which is not a repository we
    // can answer for. The walk stops rather than climbing past it.
    let marker
    try {
      marker = existsSync(join(current, '.git'))
    } catch {
      return undefined
    }
    if (marker === true) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Repositories one level below a directory.
 *
 * The workspace is not always the repository. Measured on a real session: the
 * user opened `F:\test`, ran `git init` inside `F:\test\test8`, and every file
 * of the turn landed in that child. Walking upwards from `F:\test` finds
 * nothing, so the whole turn looked like it produced no files.
 *
 * One level only. A deeper walk is a different feature with a different cost,
 * and the case that motivated this — "I opened the parent folder and made a
 * project inside it" — is one level by construction.
 *
 * @param {string} directory - where to look, normally the session workspace.
 * @returns {string[]} absolute paths of child repositories, possibly empty.
 */
export function findChildRepositories(directory) {
  if (typeof directory !== 'string' || directory.length === 0) return []
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (found.length >= MAX_CHILD_ROOTS) break
    if (entry.isDirectory() === false) continue
    if (SKIP_DIRECTORIES.has(entry.name) === true) continue
    const child = join(directory, entry.name)
    let isRepository = false
    try {
      isRepository = existsSync(join(child, '.git'))
    } catch {
      isRepository = false
    }
    if (isRepository === true) found.push(child)
  }
  return found
}

/**
 * What git says about one directory: where the root is, and which kind of root.
 *
 * The three answers come from a single `rev-parse`, because they are three lines
 * of one command's output and asking separately would spawn three processes per
 * repository per turn. `--absolute-git-dir` rather than `--git-dir`: the plain
 * form prints a path relative to the current directory, which is `.git` at the
 * root and `../../.git` two levels down, so a comparison against the common
 * directory would depend on where the process happened to stand.
 *
 * `gitDirectory === commonDirectory` in a normal checkout. They differ in a
 * worktree, whose git directory lives under the main repository's
 * `.git/worktrees/<name>`. That is the whole test Qoder uses to label a
 * workspace `local` or `worktree`.
 *
 * @param {(args: string[], cwd: string) => Promise<{ code: number, stdout: string }>} run
 * @param {string} directory - the directory to describe.
 * @returns {Promise<{ root: string, gitDirectory: string, commonDirectory: string, worktree: boolean } | undefined>}
 */
async function describeRepository(run, directory) {
  const answer = await run(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], directory)
  if (answer.code !== 0) return undefined
  const lines = answer.stdout.split('\n').map((line) => line.trim())
  const root = lines[0] ?? ''
  const gitDirectory = lines[1] ?? ''
  if (root.length === 0) return undefined
  // The common directory is printed relative to `directory`, not absolute, so it
  // is resolved the same way git means it: against where the command ran.
  const rawCommon = lines[2] ?? ''
  const commonDirectory = rawCommon.length === 0 ? gitDirectory : resolve(directory, rawCommon)
  return {
    root,
    gitDirectory,
    commonDirectory,
    // Compared as paths, not as strings: the two lines use different bases in a
    // worktree, and on Windows the separators can differ between them.
    worktree: resolve(gitDirectory) !== resolve(commonDirectory)
  }
}

/**
 * Ask git which paths differ from the last commit.
 *
 * Returns `[]` for every failure mode, and that is the contract: a workspace
 * that is not a repository, a machine without git, a repository so large the
 * answer was dropped, and a turn that changed nothing all mean "this path found
 * nothing", which the other two collectors are free to disagree with. None of
 * them is an error a panel should show.
 *
 * @param {object} options - the call.
 * @param {string} options.cwd - the session workspace.
 * @param {(args: string[], cwd: string) => Promise<{ code: number, stdout: string }>} [options.run]
 *   - how to run git; defaults to {@link runGit}.
 * @returns {Promise<string[]>} absolute paths, possibly empty.
 */
export async function changedFiles(options) {
  const swept = await sweepChanges(options)
  return swept.paths
}

/**
 * The same sweep as {@link changedFiles}, with an account of how complete it is.
 *
 * Two answers the plain list cannot give:
 *
 * - `roots`: which repositories were read. A workspace may hold several (the
 *   session root plus one level of child checkouts), and a caller that wants to
 *   say "3 files from test8" needs to know the root existed.
 * - `coverage`: `'complete'` when everything readable was read, `'partial'`
 *   when something was skipped on purpose — too many roots, a root whose status
 *   failed, a listing that hit the cap. Qoder carries the same distinction
 *   (`coverage TEXT CHECK (coverage IN ('complete','partial'))`) because a panel
 *   that cannot tell "nothing changed" from "I stopped looking" will eventually
 *   hide work and blame the turn.
 *
 * `paths` keeps the old contract: absolute, deduplicated, possibly empty.
 *
 * @param {object} options - the call; same shape as {@link changedFiles}.
 * @returns {Promise<{ paths: string[], roots: string[], coverage: 'complete' | 'partial' }>}
 */
export async function sweepChanges(options) {
  const empty = { paths: [], roots: [], coverage: 'complete' }
  const cwd = options?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return empty
  const injected = typeof options?.run === 'function'
  const run = injected === true ? options.run : runGit

  // A directory walk before any process is spawned. Every panel read happens in
  // a workspace, most workspaces are not repositories, and the panel is mounted
  // in a test harness hundreds of times — spawning two `git` processes per
  // mounted turn to discover "no repository" would be a real cost paid on the
  // normal path. `.git` is a directory in a normal checkout and a *file* in a
  // worktree or a submodule, which is why this asks "does it exist" rather than
  // "is it a directory".
  //
  // Skipped when `run` was injected: a caller that supplied its own runner is
  // describing a repository that need not exist on this disk, and applying the
  // filesystem check to it would answer a different question than the one asked.
  let roots = [cwd]
  let capped = false
  // An explicit list of roots, used instead of discovery. This is the seam that
  // makes multi-root testable without putting several real repositories on disk:
  // the discovery below is a filesystem walk, and a test that had to build four
  // repositories to check "two roots are each joined to their own base" would be
  // testing npm's ability to run `git init` more than this file's arithmetic.
  const listed = Array.isArray(options?.roots) ? options.roots.filter((directory) => typeof directory === 'string' && directory.length > 0) : undefined
  if (listed !== undefined && listed.length > 0) {
    roots = listed
  } else if (injected === false) {
    if (existsSync(cwd) === false) return empty
    const own = findRepositoryRoot(cwd)
    if (own !== undefined) {
      // The workspace sits inside a repository; that one answers for everything
      // below it, and looking for children as well would read the same files
      // twice under two different bases.
      roots = [own]
    } else {
      const children = findChildRepositories(cwd)
      if (children.length === 0) return empty
      // Discovery stops at the cap, so a full result means there was at least
      // one more child directory this sweep will not describe. Decided here,
      // from the one listing, rather than by asking for a second listing later.
      capped = children.length >= MAX_CHILD_ROOTS
      roots = children
    }
  }

  const seen = new Set()
  const paths = []
  const read = []
  let coverage = 'complete'

  for (const directory of roots) {
    const described = await describeRepository(run, directory)
    if (described === undefined) {
      // A child that looked like a repository but cannot answer is a hole in the
      // answer, not an error. Only the top-level failure is silent: if the
      // workspace itself is not a repository, nothing was expected anyway.
      if (directory !== cwd) coverage = 'partial'
      continue
    }
    const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], described.root)
    if (status.code !== 0) {
      if (directory !== cwd) coverage = 'partial'
      continue
    }
    const records = parsePorcelain(status.stdout)
    if (records.length > MAX_CHANGED_FILES) {
      // The answer was dropped as noise. That is a partial answer by definition:
      // the turn did change things, this sweep just refuses to list them.
      coverage = 'partial'
      continue
    }
    read.push(described.root)
    for (const record of records) {
      const absolute = toAbsolute(described.root, record.path)
      if (seen.has(absolute) === true) continue
      seen.add(absolute)
      paths.push(absolute)
    }
  }

  // Discovery stopped at the cap, so there are repositories this sweep never
  // described. The repository count is the honest signal here, not the file
  // count.
  if (capped === true) coverage = 'partial'

  return { paths, roots: read, coverage }
}

/**
 * The paths in `after` that `before` did not already list.
 *
 * `git status` is cumulative: it reports every uncommitted change, including
 * the ones made five turns ago. Recording that set each turn would push old
 * work back to the top of the card and label it as this turn's — so the turn
 * takes a reading when it starts and keeps only what is new at the end.
 *
 * The known cost: a file that was already modified before the turn started and
 * then modified again during it appears in both readings, so this turn does not
 * claim it. That is the safe direction. The file is already on the card from
 * the turn that touched it first; claiming it again would be a lie about which
 * turn did the work, and the card's only job is to say which turn did.
 *
 * @param {string[]} before - the baseline reading, or undefined if not taken.
 * @param {string[]} after - the reading at turn end.
 * @returns {string[]} paths worth recording for this turn.
 */
export function newestChanges(before, after) {
  if (Array.isArray(after) === false) return []
  if (Array.isArray(before) === false) return after.slice()
  const known = new Set(before)
  const fresh = []
  for (const path of after) {
    if (known.has(path) === true) continue
    fresh.push(path)
  }
  return fresh
}
