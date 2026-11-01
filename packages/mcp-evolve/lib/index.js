/**
 * `@revxz/dsh-mcp-evolve` — reserved.
 *
 * This package exists so that MCP evolution can be added later without
 * splitting anything again: the shared engine (`@revxz/dsh-evolve-core`)
 * already owns the pieces an MCP lifecycle would need — a serialized store, a
 * proposal queue with staleness rules, an evidence gate and an aging ledger —
 * and all of them are written against "a name plus a body", not against skills
 * specifically.
 *
 * It is deliberately empty. Publishing a package that registers a plugin and
 * does nothing would put a line in every user's config that they cannot then
 * remove without wondering what broke.
 *
 * @module @revxz/dsh-mcp-evolve
 */

/** Cordis plugin name, as it would be registered. */
export const name = 'mcp-evolve'

/**
 * Not implemented.
 *
 * Deliberately throws rather than silently doing nothing: if someone wires this
 * package into a profile, they should find out at load time with a message that
 * says why, not by noticing months later that nothing ever happened.
 */
export function apply() {
  throw new Error('@revxz/dsh-mcp-evolve is a reserved placeholder and is not implemented yet')
}
