/**
 * Persistent state: the candidate queue, the lifecycle registry, and the
 * append-only ledger.
 *
 * All three live under `$DSH_HOME/plugin-data/skill-evolve/`, deliberately
 * outside the skill root: an unapproved candidate must never be discoverable
 * as a loadable skill, and the ledger must survive a user deleting a skill.
 *
 * Writes are atomic (temp file + rename) because a half-written JSON file
 * would take the whole plugin offline on the next start, and this plugin is
 * supposed to be invisible when it fails.
 *
 * @module dsh-skill-evolve/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stateDir } from './paths.js'
import { isMissing } from './skillfile.js'

/** Upper bound on ledger size before the oldest entries are dropped. */
const LEDGER_MAX_BYTES = 5 * 1024 * 1024

/**
 * Read and parse a JSON file, returning `undefined` when it is absent or
 * corrupt.
 *
 * A corrupt file is not repaired: silently discarding a bad ledger is a data
 * loss, so the caller decides. In practice both callers log and continue with
 * an empty value, which is the safe direction — the plugin forgets history,
 * but it never invents it.
 *
 * @template T
 * @param {string} path - absolute path.
 * @returns {Promise<T | undefined>} parsed value.
 */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissing(error)) return undefined
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * Write a JSON file atomically.
 *
 * @param {string} path - absolute path.
 * @param {unknown} value - value to serialize.
 * @returns {Promise<void>}
 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * Append one line to a JSONL ledger, dropping the oldest lines past the cap.
 *
 * @param {string} path - absolute path to the ledger.
 * @param {object} entry - the entry to append.
 * @param {number} [maxBytes] - size cap.
 * @returns {Promise<void>}
 */
export async function appendLedger(path, entry, maxBytes = LEDGER_MAX_BYTES) {
  await mkdir(dirname(path), { recursive: true })
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  let next = `${existing}${JSON.stringify(entry)}\n`
  if (Buffer.byteLength(next, 'utf8') > maxBytes) {
    // Keep the tail: recent history is what rollback needs.
    const lines = next.split('\n').filter((line) => line.length > 0)
    const kept = []
    let total = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const size = Buffer.byteLength(lines[index], 'utf8') + 1
      if (total + size > maxBytes) break
      kept.unshift(lines[index])
      total += size
    }
    next = kept.length > 0 ? `${kept.join('\n')}\n` : ''
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, next, 'utf8')
  await rename(temporary, path)
}

/**
 * The plugin's persistent state, rooted at one directory.
 */
export class Store {
  /**
   * @param {object} [options] - construction options.
   * @param {string} [options.root] - override for the state root.
   * @param {(...parts: string[]) => void} [options.log] - logger sink.
   */
  constructor(options = {}) {
    this.root = options.root ?? stateDir()
    this.log = options.log ?? (() => {})
    this.candidatesPath = join(this.root, 'candidates.json')
    this.registryPath = join(this.root, 'registry.json')
    this.ledgerPath = join(this.root, 'ledger.jsonl')
  }

  /**
   * Load the pending candidate queue.
   *
   * @returns {Promise<Array<object>>} candidates, newest last.
   */
  async loadCandidates() {
    const value = await readJson(this.candidatesPath)
    if (!Array.isArray(value)) {
      if (value !== undefined) this.log('store: candidates.json was not an array, starting empty')
      return []
    }
    return value
  }

  /**
   * Replace the pending candidate queue.
   *
   * @param {Array<object>} candidates - the new queue.
   * @returns {Promise<void>}
   */
  async saveCandidates(candidates) {
    await writeJson(this.candidatesPath, candidates)
  }

  /**
   * Load the lifecycle registry.
   *
   * @returns {Promise<Record<string, object>>} registry keyed by skill name.
   */
  async loadRegistry() {
    const value = await readJson(this.registryPath)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      if (value !== undefined) this.log('store: registry.json was not an object, starting empty')
      return {}
    }
    return /** @type {Record<string, object>} */ (value)
  }

  /**
   * Replace the lifecycle registry.
   *
   * @param {Record<string, object>} registry - the new registry.
   * @returns {Promise<void>}
   */
  async saveRegistry(registry) {
    await writeJson(this.registryPath, registry)
  }

  /**
   * Append one audit entry.
   *
   * @param {object} entry - the audit record.
   * @returns {Promise<void>}
   */
  async record(entry) {
    await appendLedger(this.ledgerPath, entry)
  }
}

/**
 * Build a compact, stable identity for a detected procedure.
 *
 * Two sessions that hit the same tool sequence should land on the same
 * candidate slot; the signature is deliberately derived from the tool names
 * alone so that a rename of the model's own prose does not fork it.
 *
 * @param {string[]} steps - tool names.
 * @returns {string} a short hex signature.
 */
export function procedureSignature(steps) {
  // FNV-1a: enough to avoid collisions between a handful of procedures, and
  // it keeps the candidate file readable without pulling in crypto.
  let hash = 0x811c9dc5
  const input = steps.join('\u0000')
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
