/**
 * How the host records that a skill was loaded.
 *
 * Two packages need this and they need it for different reasons, which is why
 * it lives in `core` rather than in either of them:
 *
 * - `@revxz/dsh-skill-evolve` counts loads against a registry entry, and a load
 *   it cannot parse must not increment a counter.
 * - `@revxz/dsh-ui-evolve` lists what the session actually used, and a load it
 *   cannot parse must not be listed.
 *
 * The parse is the host's shape, not either plugin's opinion, so duplicating it
 * would be a way to drift: one side would accept a payload the other rejects and
 * the counter and the panel would disagree about the same event.
 *
 * @module @revxz/dsh-evolve-core/skillcall
 */

/**
 * The host's own `/name` gesture for invoking a skill from a message body.
 *
 * Copied from `dsh-tool-skill` (`SKILL_GESTURE` in its `lib/index.js`) rather
 * than invented, because both plugins make claims about what the session did. If
 * the two rules drifted, they would either invent loads the host never performed
 * or miss ones it did. The boundary lookarounds keep file paths (`/usr/bin`) and
 * fractions (`5/8`) out, exactly as they do upstream.
 *
 * The `g` flag is load-bearing and also a hazard: `matchAll` requires it, while
 * `test()` and `exec()` advance `lastIndex` on a shared instance. Callers pass
 * this to `matchAll` only.
 */
export const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * Read the skill name out of a `skill` tool call.
 *
 * `tool/call` carries the model's raw, still-streaming argument text, so this is
 * a string in the normal case and an object only when the host handed us a
 * pre-parsed payload. Anything else — malformed JSON, a partial fragment
 * captured mid-stream, the wrong field — is not a load and must not count.
 *
 * @param {unknown} raw - `event.data.arguments`.
 * @returns {string | undefined} the skill name, when there is one.
 */
export function readSkillArgument(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const name = /** @type {Record<string, unknown>} */ (value).name
  return typeof name === 'string' ? name.trim() : undefined
}
