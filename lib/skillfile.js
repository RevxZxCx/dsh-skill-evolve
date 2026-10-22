/**
 * SKILL.md reading, writing, and ownership.
 *
 * Two decisions shape this module.
 *
 * **Flat, deterministic frontmatter.** The host parses frontmatter with
 * `js-yaml`, but a plugin should not depend on a transitively hoisted copy of
 * that library. Every field this plugin writes is a top-level scalar rendered
 * as a JSON-quoted string, which is valid YAML and needs no parser beyond a
 * regex and `JSON.parse`. Nested structures are avoided entirely.
 *
 * **Ownership, not permission.** A file this plugin wrote carries
 * `evolved-by: dsh-skill-evolve`. A file without that marker belongs to a
 * human (or to another plugin) and is never overwritten, renamed, or deleted —
 * regardless of what the model asks for. The marker is the boundary between
 * "I may maintain this" and "I may only read this".
 *
 * @module dsh-skill-evolve/skillfile
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Ownership marker written into every file this plugin creates. */
export const OWNER_MARKER = 'dsh-skill-evolve'

/** Frontmatter key that carries the ownership marker. */
const MARKER_KEY = 'evolved-by'

/** Host contract: skill names are kebab-case. Mirrors `isSkillName`. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The file name a directory-bundle skill must use. */
export const SKILL_FILE = 'SKILL.md'

/**
 * Validate a skill name against the host contract.
 *
 * @param {string} name - candidate name.
 * @returns {string} the name, unchanged.
 * @throws {Error} when the name is not kebab-case or exceeds the length cap.
 */
export function assertSkillName(name) {
  if (typeof name !== 'string') throw new TypeError('skill name must be a string')
  if (name.length > 64) throw new Error(`skill name "${name}" is longer than 64 characters`)
  if (!SKILL_NAME.test(name)) {
    throw new Error(`skill name "${name}" must be kebab-case (lowercase letters, digits, single hyphens)`)
  }
  return name
}

/**
 * Detect the frontmatter block at the start of a skill file.
 *
 * Mirrors the host's own rules closely enough to reject what it would reject:
 * the first line must be exactly `---`, and a closing `---` line must exist.
 *
 * @param {string} raw - file contents.
 * @returns {{data: Record<string, string>, body: string} | undefined} parsed parts.
 */
export function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  let lineStart = firstLineEnd + 1
  let closingStart = -1
  let bodyStart = -1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      closingStart = lineStart
      bodyStart = nextNewline < 0 ? raw.length : nextNewline + 1
      break
    }
    if (nextNewline < 0) break
    lineStart = nextNewline + 1
  }
  if (closingStart < 0) return undefined

  /** @type {Record<string, string>} */
  const data = {}
  for (const line of raw.slice(firstLineEnd + 1, closingStart).split('\n')) {
    const match = /^([a-z][a-z0-9-]*):[ \t]*(.*)$/.exec(line.replace(/\r$/, ''))
    if (match === null) continue
    const [, key, rawValue] = match
    data[key] = unquote(rawValue)
  }
  return { data, body: raw.slice(bodyStart) }
}

/**
 * Strip surrounding quotes from a scalar, decoding escapes when quoted.
 *
 * @param {string} rawValue - the text after the colon.
 * @returns {string} the scalar value.
 */
function unquote(rawValue) {
  const trimmed = rawValue.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  return trimmed
}

/**
 * Render a scalar as a JSON-quoted YAML string.
 *
 * @param {string} value - the value to render.
 * @returns {string} a double-quoted YAML scalar.
 */
function quote(value) {
  return JSON.stringify(String(value))
}

/**
 * Serialize a skill record into a complete SKILL.md document.
 *
 * @param {object} record - the skill to render.
 * @param {string} record.name - kebab-case skill name.
 * @param {string} record.description - routing description.
 * @param {string} record.body - markdown instructions.
 * @param {string} [record.whenToUse] - optional extra routing hint.
 * @param {Record<string, string|number>} [record.state] - ownership and lifecycle fields.
 * @returns {string} the file contents.
 */
export function renderSkillFile(record) {
  assertSkillName(record.name)
  if (typeof record.description !== 'string' || record.description.trim().length === 0) {
    throw new Error(`skill "${record.name}" requires a non-empty description`)
  }
  if (typeof record.body !== 'string' || record.body.trim().length === 0) {
    throw new Error(`skill "${record.name}" requires a non-empty body`)
  }

  /** @type {Array<[string, string]>} */
  const lines = [
    ['name', record.name],
    ['description', record.description]
  ]
  if (typeof record.whenToUse === 'string' && record.whenToUse.trim().length > 0) {
    lines.push(['when-to-use', record.whenToUse])
  }
  lines.push([MARKER_KEY, OWNER_MARKER])
  for (const [key, value] of Object.entries(record.state ?? {})) {
    if (value === undefined || value === null || value === '') continue
    lines.push([key, String(value)])
  }

  const front = lines.map(([key, value]) => `${key}: ${quote(value)}`).join('\n')
  return `---\n${front}\n---\n\n${record.body.trim()}\n`
}

/**
 * Read a skill file from disk and report whether this plugin owns it.
 *
 * @param {string} path - absolute path to a SKILL.md.
 * @returns {Promise<{owned: boolean, data: Record<string, string>, body: string, raw: string}>} the parsed file.
 * @throws {Error} when the file has no parsable frontmatter.
 */
export async function readSkillFile(path) {
  const raw = await readFile(path, 'utf8')
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) {
    throw new Error(`skill file ${path} has no parsable frontmatter`)
  }
  return {
    owned: parsed.data[MARKER_KEY] === OWNER_MARKER,
    data: parsed.data,
    body: parsed.body,
    raw
  }
}

/**
 * Read lifecycle state from a parsed skill file, with defaults.
 *
 * @param {Record<string, string>} data - parsed frontmatter.
 * @returns {{id: string, stage: string, created: string, uses: number, harmful: number, helpful: number, validated: string, evidence: string}} state
 */
export function readState(data) {
  const toInt = (value) => {
    const parsed = Number.parseInt(value ?? '', 10)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return {
    id: data['evolved-id'] ?? '',
    stage: data['evolved-stage'] ?? 'unverified',
    created: data['evolved-created'] ?? '',
    uses: toInt(data['evolved-uses']),
    harmful: toInt(data['evolved-harmful']),
    helpful: toInt(data['evolved-helpful']),
    validated: data['evolved-validated'] ?? '',
    evidence: data['evolved-evidence'] ?? ''
  }
}

/**
 * List every skill directory under a root that this plugin owns.
 *
 * @param {string} root - the skill root.
 * @returns {Promise<Array<{name: string, path: string, directory: string}>>} owned skills.
 */
export async function listOwnedSkills(root) {
  /** @type {Array<{name: string, path: string, directory: string}>} */
  const owned = []
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return owned
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name)
    const path = join(directory, SKILL_FILE)
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      const parsed = await readSkillFile(path)
      if (!parsed.owned) continue
      owned.push({ name: parsed.data.name ?? entry.name, path, directory })
    } catch {
      // An unreadable or malformed file is not this plugin's to repair.
      continue
    }
  }
  return owned
}

/**
 * Report whether a filesystem error means "absent" rather than "broken".
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} true for ENOENT/ENOTDIR.
 */
export function isMissing(error) {
  const code = /** @type {{code?: string}} */ (error)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
