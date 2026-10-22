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
 * Atomicity is not consistency. `writeJson` guarantees the file is never
 * half-written, but a read-modify-write cycle that spans two awaits still
 * loses one writer's work when two sessions interleave — the later rename
 * publishes a snapshot that predates the other writer's change. The host runs
 * every session in one process, so serialising on a promise chain
 * (`#serialize`) is enough to make the queue and the registry consistent;
 * every mutation below goes through it rather than exposing a load/save pair.
 *
 * Not covered: two DSH hosts sharing one `DSH_HOME` at the same time. That is
 * out of scope for a single-user plugin, and the failure mode is a lost
 * candidate (recoverable) rather than a corrupt skill (not recoverable).
 *
 * @module dsh-skill-evolve/store
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
 * The temp name carries a random component: `pid` plus a millisecond clock is
 * not unique when two writes land in the same tick, and the loser would rename
 * a file the winner was still filling.
 *
 * @param {string} path - absolute path.
 * @param {unknown} value - value to serialize.
 * @returns {Promise<void>}
 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * Append one line to a JSONL ledger, dropping the oldest lines past the cap.
 *
 * The normal path is a real append (`O_APPEND`), not "read everything, add a
 * line, rename over the original". The previous shape silently lost entries:
 * two concurrent writers both read the same original bytes, and the later
 * rename erased the earlier entry from an audit trail that claims to be
 * append-only.
 *
 * The cap is generous precisely because falling over it needs the one
 * read-modify-write that is not concurrency-safe; it is rare enough that the
 * serialised `Store.record` is sufficient cover.
 *
 * @param {string} path - absolute path to the ledger.
 * @param {object} entry - the entry to append.
 * @param {number} [maxBytes] - size cap.
 * @returns {Promise<void>}
 */
export async function appendLedger(path, entry, maxBytes = LEDGER_MAX_BYTES) {
  await mkdir(dirname(path), { recursive: true })
  const line = `${JSON.stringify(entry)}\n`

  // Measure first, append second, so the common case never reads the file.
  let size = 0
  try {
    size = (await stat(path)).size
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  if (size + Buffer.byteLength(line, 'utf8') <= maxBytes) {
    // O_APPEND: the kernel positions each write at the current end of file, so
    // concurrent appends interleave whole lines instead of clobbering.
    await appendFile(path, line, 'utf8')
    return
  }

  // Over the cap. Keep the tail rather than the head: recent history is what
  // rollback needs, and the newest entry is always the most informative.
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const lines = `${existing}${line}`.split('\n').filter((item) => item.length > 0)
  const kept = []
  let total = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const bytes = Buffer.byteLength(lines[index], 'utf8') + 1
    if (total + bytes > maxBytes) break
    kept.unshift(lines[index])
    total += bytes
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8')
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
    /** @type {Promise<unknown>} tail of the mutation queue. */
    this.#queue = Promise.resolve()
  }

  /** @type {Promise<unknown>} */
  #queue

  /**
   * Run one mutation after every mutation queued before it.
   *
   * Read-modify-write cycles must be queued as a whole, so callers pass a
   * function rather than a load/save pair. A failure rejects only its own
   * `run`; the chain continues so one bad mutation cannot wedge the plugin.
   *
   * @template T
   * @param {() => Promise<T>} run - the critical section.
   * @returns {Promise<T>} whatever `run` returned.
   */
  serialize(run) {
    const started = this.#queue.then(run, run)
    this.#queue = started.catch(() => {})
    return started
  }

  /**
   * Load the pending candidate queue.
   *
   * Callers that intend to write the queue back must do so inside
   * {@link Store.mutateCandidates} instead: a bare load cannot participate in
   * the serialisation, so a save built on it can erase concurrent work.
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
   * Prefer {@link Store.mutateCandidates}; this exists for the one caller that
   * already holds the critical section.
   *
   * @param {Array<object>} candidates - the new queue.
   * @returns {Promise<void>}
   */
  async saveCandidates(candidates) {
    await writeJson(this.candidatesPath, candidates)
  }

  /**
   * Read, transform and write the queue as one atomic step.
   *
   * @template T
   * @param {(candidates: Array<object>) => Promise<{candidates?: Array<object>, result: T}>} transform - receives a fresh copy of the queue; return new contents plus the caller's result.
   * @returns {Promise<T>} the caller's result.
   */
  async mutateCandidates(transform) {
    return this.serialize(async () => {
      const current = await this.loadCandidates()
      const outcome = await transform(current)
      if (outcome.candidates !== undefined) await writeJson(this.candidatesPath, outcome.candidates)
      return outcome.result
    })
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
   * Read, transform and write the registry as one atomic step.
   *
   * @template T
   * @param {(registry: Record<string, object>) => Promise<{registry?: Record<string, object>, result: T}>} transform - receives the current registry.
   * @returns {Promise<T>} the caller's result.
   */
  async mutateRegistry(transform) {
    return this.serialize(async () => {
      const current = await this.loadRegistry()
      const outcome = await transform(current)
      if (outcome.registry !== undefined) await writeJson(this.registryPath, outcome.registry)
      return outcome.result
    })
  }

  /**
   * Append one audit entry.
   *
   * Serialised with the mutations above so that a truncation rewrite cannot
   * race an append and drop the line that was being added.
   *
   * @param {object} entry - the audit record.
   * @returns {Promise<void>}
   */
  async record(entry) {
    await this.serialize(() => appendLedger(this.ledgerPath, entry))
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
