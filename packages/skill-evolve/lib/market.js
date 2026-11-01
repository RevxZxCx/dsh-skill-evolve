/**
 * The external skill market, and the two things it must never do silently.
 *
 * Stage 2 made the local library searchable, which answers "which of my skills
 * does this". It does not answer "does anyone already have a skill for this",
 * and that is the question a session asks before writing a skill from scratch.
 * skills.sh carries a large public library; this module is the only place in the
 * plugin that talks to the network.
 *
 * Two rules shape everything below.
 *
 * **Nothing is installed without a human.** A market skill is not a document —
 * the pdf skill ships nine Python scripts and a licence. Downloading one writes
 * executable code into a directory the host will load without further checks, so
 * install is gated on the host's own approval seam (`tools/pre-execute` returning
 * `{ kind: 'ask' }`), not on a `confirm: true` argument the model can pass by
 * itself. A model-authored confirmation is not a confirmation.
 *
 * **A search result is metadata, not trust.** Search returns ids, names, install
 * counts. Preview returns the file list and the SKILL.md text so a person can
 * read what they are about to accept. Neither one writes anything.
 *
 * The transport is deliberately small: three GETs, a byte cap, a timeout, and
 * `redirect: 'error'`. No pagination loop, no retry storm — a market that is
 * down should cost one failed call, not a session.
 */

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'

const SEARCH_URL = 'https://skills.sh/api/search'
const DOWNLOAD_URL = 'https://skills.sh/api/download'

/** The market rejects anything longer, and a 100-char query is not a query. */
const MAX_QUERY_LENGTH = 100

/** One megabyte is roughly a thousand results; more than that is a bug. */
const MAX_RESPONSE_BYTES = 1 << 20

/** A market that does not answer in ten seconds is down. */
const REQUEST_TIMEOUT_MS = 10000

/** Cap on installs shown, so a broad query cannot flood the context. */
const DEFAULT_LIMIT = 10

/**
 * How much of a market SKILL.md a preview pastes into the conversation.
 *
 * Chosen to cover the whole of a typical skill header plus its first few
 * sections: enough to judge what it does, small enough that previewing three
 * candidates costs less than the skill would save.
 */
const PREVIEW_BODY_CHARS = 6000

/**
 * Identifiers come from a URL path, so they are validated, not escaped.
 *
 * skills.sh ids are `owner/repo/skill`. Each segment is restricted to the
 * character set the market itself accepts; anything else — `..`, `%2f`, a NUL —
 * fails here rather than becoming a path on disk.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** A file inside a skill bundle. Paths are relative and stay inside the root. */
const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/**
 * Order two strings the same way on every machine.
 *
 *  depends on the machine locale, so the same bundle would list
 * its files in a different order on a different host. A codepoint comparison is
 * stable, and the only place this ordering is visible is a list a person reads.
 * @param left - first string.
 * @param right - second string.
 * @returns a negative, zero, or positive number.
 */
function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Whether a market id is well formed.
 * @param id - the candidate `owner/repo/skill` string.
 * @returns true when every segment is a valid identifier.
 */
export function isValidMarketId(id) {
  if (typeof id !== 'string') return false
  const parts = id.split('/')
  if (parts.length !== 3) return false
  return parts.every((part) => SEGMENT.test(part))
}

/**
 * Whether a bundle-relative path is safe to write under a skill directory.
 *
 * The market controls these strings, so this is the boundary that stops a
 * bundle from writing outside the skill root. Rejecting is the only safe
 * answer: a path that needs repair is a path someone is attacking.
 *
 * The charset does the work. `SAFE_PATH` admits only alphanumerics, `.`, `_`,
 * `-` and single `/` separators, which already excludes a leading `/`, any
 * backslash, and any drive letter — so there is no separate absolute-path check
 * to keep in sync with it. The `..` test below is the one thing the charset
 * cannot express: `..` is a legal sequence of legal characters.
 *
 * @param path - the bundle-relative path.
 * @returns true when the path is relative, normalised, and inside the root.
 */
export function isSafeBundlePath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  if (path.length > 200) return false
  if (!SAFE_PATH.test(path)) return false
  // Bundle paths are always `/`-separated, so the check must use posix rules:
  // the platform `normalize` turns them into backslashes on Windows and would
  // reject every valid path.
  const normalised = posix.normalize(path)
  if (normalised.startsWith('..') || normalised !== path) return false
  return true
}

/**
 * Normalise a search hit into the shape this plugin renders.
 *
 * The market's own field names are kept (`source`, `skillId`) because they are
 * what `preview` and `install` take, and losing them would mean reconstructing
 * the id by string surgery.
 * @param raw - one entry from the market's `skills` array.
 * @returns a normalised hit, or undefined when the entry is unusable.
 */
export function normaliseHit(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!isValidMarketId(id)) return undefined
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id.split('/')[2]
  const installs = Number(raw.installs)
  return {
    id,
    name,
    source: typeof raw.source === 'string' ? raw.source : id.split('/').slice(0, 2).join('/'),
    skillId: typeof raw.skillId === 'string' ? raw.skillId : id.split('/')[2],
    installs: Number.isFinite(installs) && installs > 0 ? Math.floor(installs) : 0
  }
}

/**
 * Fetch JSON with a size cap, a timeout, and no redirects.
 *
 * `redirect: 'error'` matters: a redirect would let the market move the request
 * somewhere the id check never saw, and the cap is enforced by reading the body
 * as a stream rather than trusting `Content-Length`.
 * @param url - the absolute URL to read.
 * @param fetchImpl - the fetch to use (injected so tests need no network).
 * @returns the parsed JSON body.
 */
async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`market returned HTTP ${response.status}`)
  const reader = response.body?.getReader?.()
  if (reader === undefined) {
    // Measured in bytes, not code units. `text.length` counts UTF-16 units, so a
    // response of Chinese text would pass a 1 MB check at roughly 3 MB of UTF-8 —
    // a cap that quietly means a different number depending on the alphabet.
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('market response exceeded the size cap')
    return JSON.parse(text)
  }
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done === true) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel?.()
      throw new Error('market response exceeded the size cap')
    }
    chunks.push(value)
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  return JSON.parse(buffer.toString('utf8'))
}

/**
 * Search the public market.
 *
 * Returns metadata only. Nothing is downloaded, and the caller is expected to
 * treat the result as a lead rather than a recommendation — install counts say
 * how often a skill was pulled, not whether it is any good.
 * @param input - `{ query, limit, fetch }`.
 * @returns `{ query, hits, total }` or throws on transport failure.
 */
export async function searchMarket(input) {
  const query = String(input?.query ?? '').trim()
  if (query === '') throw new Error('query must not be empty')
  if (query.length > MAX_QUERY_LENGTH) throw new Error(`query must be at most ${MAX_QUERY_LENGTH} characters`)
  const limit = Math.max(1, Math.min(50, Math.floor(Number(input?.limit ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT))
  const fetchImpl = input?.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation is available')

  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${limit}`
  const body = await getJson(url, fetchImpl)
  const raw = Array.isArray(body?.skills) ? body.skills : []
  const hits = []
  for (const entry of raw) {
    const hit = normaliseHit(entry)
    if (hit !== undefined) hits.push(hit)
  }
  hits.sort((left, right) => right.installs - left.installs || compareText(left.name, right.name))
  return { query, hits: hits.slice(0, limit), total: hits.length }
}

/**
 * Fetch one skill bundle into memory, with every file's contents.
 *
 * This is the only download path. `previewMarketSkill` renders from it and
 * `installMarketSkill` writes from it, so what a person approved and what lands
 * on disk cannot diverge — a preview that fetched one version and an install that
 * fetched another would make the approval meaningless.
 * @param input - `{ id, fetch }`.
 * @returns `{ id, files, skillMd, hash }` where each file has `path`, `contents`, `bytes`.
 */
export async function fetchMarketBundle(input) {
  const id = String(input?.id ?? '').trim()
  if (!isValidMarketId(id)) throw new Error(`"${id}" is not a market id of the form owner/repo/skill`)
  const fetchImpl = input?.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation is available')

  const body = await getJson(`${DOWNLOAD_URL}/${id}`, fetchImpl)
  const raw = Array.isArray(body?.files) ? body.files : []
  const files = []
  const dropped = []
  let skillMd = ''
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const path = entry.path
    // Recorded rather than silently skipped. A bundle whose `scripts/setup.py`
    // was dropped would install "successfully" and be missing the file that made
    // it work, with nothing in the output saying so.
    if (!isSafeBundlePath(path)) {
      dropped.push(typeof path === 'string' ? path.slice(0, 80) : '(unreadable path)')
      continue
    }
    const contents = typeof entry.contents === 'string' ? entry.contents : ''
    files.push({ path, contents, bytes: Buffer.byteLength(contents, 'utf8') })
    if (path === 'SKILL.md') skillMd = contents
  }
  if (files.length === 0) throw new Error(`market skill "${id}" has no readable files`)
  // A skill is discovered by `<root>/<name>/SKILL.md`. A bundle without one would
  // install, be recorded in the ledger, and then be invisible to both the catalog
  // and `skill_search` — reported as installed and permanently unreachable.
  if (skillMd === '') throw new Error(`market skill "${id}" has no SKILL.md, so the host would never load it`)
  files.sort((left, right) => compareText(left.path, right.path))
  return { id, files, skillMd, dropped, hash: typeof body?.hash === 'string' ? body.hash : '' }
}

/**
 * Fetch one skill bundle without writing anything.
 *
 * The bundle is the whole skill — SKILL.md plus whatever scripts it ships — so
 * preview has to show the file list. A person approving an install needs to know
 * they are accepting a Python script, not a paragraph.
 * @param input - `{ id, fetch }`.
 * @returns `{ id, files, skillMd, hash }`.
 */
export async function previewMarketSkill(input) {
  return fetchMarketBundle(input)
}

/**
 * Where a bundle file goes, or undefined when it would escape the root.
 *
 * Containment is enforced by `isSafeBundlePath`, not here: a path that passes
 * that gate has no `..` segment and no separator outside the charset, so
 * `resolve(root, path)` cannot land above `root`. A second lexical prefix check
 * would be unreachable, and an unreachable guard is worse than none — it reads
 * as protection while never running. The gap this function genuinely cannot
 * close is a symlink already present inside `root`; that is a known limit, not
 * something a prefix comparison would have caught either.
 * @param root - the skill directory being written.
 * @param path - the validated bundle-relative path.
 * @returns the absolute destination, or undefined.
 */
export function destinationFor(root, path) {
  // A non-string root is refused rather than coerced. Stringifying a promise
  // yields the perfectly valid-looking relative path "[object Promise]", so the
  // install would succeed into the process's working directory and report that
  // as the skill root. Writing a skill somewhere unexpected is the one failure a
  // caller cannot notice from the return value.
  if (typeof root !== 'string' || root.trim() === '') return undefined
  if (!isSafeBundlePath(path)) return undefined
  return resolve(root, path)
}

/**
 * Write a bundle into a skill directory.
 *
 * Callers must have obtained human approval first — this function has no gate of
 * its own, by design: the gate belongs on the tool, where the host's approval
 * seam lives. Keeping it there means there is exactly one place to audit.
 * @param input - `{ root, files, overwrite }`.
 * @returns `{ root, written, skipped }`.
 */
export async function installMarketSkill(input) {
  if (typeof input?.root !== 'string') throw new Error('a destination root must be a string')
  const root = input.root.trim()
  if (root === '') throw new Error('a destination root is required')
  const files = Array.isArray(input?.files) ? input.files : []
  if (files.length === 0) throw new Error('nothing to install')
  const overwrite = input?.overwrite === true

  const written = []
  const skipped = []
  for (const entry of files) {
    const path = typeof entry?.path === 'string' ? entry.path : ''
    const target = destinationFor(root, path)
    if (target === undefined) throw new Error(`refusing to write "${path}": it would escape the skill directory`)
    const contents = typeof entry.contents === 'string' ? entry.contents : ''
    if (overwrite !== true) {
      try {
        await stat(target)
        skipped.push(path)
        continue
      } catch {
        // Not there yet, which is the normal case.
      }
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents, 'utf8')
    written.push(path)
  }
  return { root, written, skipped }
}

/**
 * List what is already installed under a root, so install can refuse to clobber.
 *
 * A missing root means "nothing installed" and returns `[]`. Every other readdir
 * failure is rethrown: treating an unreadable directory as empty would let the
 * install proceed into a skill that already exists, which is the one outcome the
 * caller checks this function to prevent.
 * @param root - the skill directory.
 * @returns the file paths found, relative to the root.
 */
export async function listInstalled(root) {
  const found = []
  const walk = async (directory, prefix) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(directory, entry.name), path)
      else found.push(path)
    }
  }
  await walk(root, '')
  return found.sort(compareText)
}

/**
 * Render a search result for the model.
 * @param outcome - the value returned by `searchMarket`.
 * @returns the text to show.
 */
export function renderSearch(outcome) {
  const { query, hits, total } = outcome
  if (hits.length === 0) return `No market skill matched "${query}".`
  const lines = [`${hits.length} of ${total} market skill(s) matched "${query}":`]
  for (const hit of hits) {
    const installs = hit.installs === 0 ? 'no installs' : `${hit.installs.toLocaleString('en-US')} installs`
    lines.push(`- \`${hit.id}\` (${installs})`)
  }
  lines.push('Call `skill_market_preview` with one id to see its files and read its SKILL.md before installing.')
  return lines.join('\n')
}

/**
 * Render a preview for the model.
 *
 * The file list is always complete — it is what a person is deciding about — but
 * the SKILL.md body is capped. A skill body has no size limit upstream, and
 * `anthropics/skills/pdf` alone ships an 8 KB SKILL.md; pasting a large one into
 * the conversation spends the context the skill is meant to save, on a document
 * the model can read from disk after installing. The cap is generous enough to
 * judge what the skill does and short enough to leave room for the decision.
 * @param outcome - the value returned by `previewMarketSkill`.
 * @returns the text to show.
 */
export function renderPreview(outcome) {
  const { id, files, skillMd } = outcome
  const executables = files.filter((file) => /\.(py|sh|ps1|js|mjs|rb|pl|exe|dll)$/i.test(file.path))
  const lines = [`\`${id}\` contains ${files.length} file(s):`]
  for (const file of files) lines.push(`- ${file.path} (${file.bytes} bytes)`)
  if (executables.length > 0) {
    lines.push('')
    lines.push(`This skill ships ${executables.length} executable file(s). Read them before installing.`)
  }
  if (Array.isArray(outcome.dropped) && outcome.dropped.length > 0) {
    lines.push('')
    lines.push(`Skipped ${outcome.dropped.length} file(s) whose paths would escape the skill directory: ${outcome.dropped.join(', ')}.`)
  }
  lines.push('')
  if (skillMd === '') {
    lines.push('It has no SKILL.md.')
  } else {
    const shown = skillMd.slice(0, PREVIEW_BODY_CHARS)
    lines.push(`--- SKILL.md ---\n${shown}`)
    if (shown.length < skillMd.length) {
      lines.push('')
      lines.push(
        `[truncated: ${skillMd.length - shown.length} of ${skillMd.length} characters not shown. Install it, then read the file to see the rest.]`
      )
    }
  }
  return lines.join('\n')
}
