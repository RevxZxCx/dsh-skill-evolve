/**
 * Resolve the directory that holds user-level DSH skills.
 *
 * The host's `dsh-skill-filesystem` provider watches `$DSH_HOME/skills`
 * (rank USER_DSH_RANK) and `~/.agents/skills` (rank USER_AGENTS_RANK). This
 * plugin writes into the first one because it is the location the Settings
 * UI and the installed skills-manager also use, so a skill written here is
 * discoverable by every surface.
 *
 * @module dsh-skill-evolve/paths
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment variable the host exports for the active DSH home. */
const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Resolve the DSH home directory.
 *
 * @returns {string} absolute path to the DSH home.
 */
export function dshHome() {
  const fromEnv = process.env[DSH_HOME_ENV]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * Resolve the user skill root this plugin writes into.
 *
 * @param {object} [config] - plugin configuration.
 * @param {string} [config.skillRoot] - explicit override, taken verbatim.
 * @returns {string} absolute path to the skill root.
 */
export function skillRoot(config = {}) {
  if (typeof config.skillRoot === 'string' && config.skillRoot.length > 0) {
    return resolve(config.skillRoot)
  }
  return join(dshHome(), 'skills')
}

/**
 * Resolve the plugin's private state directory (ledger, candidate queue).
 *
 * Kept outside the skill root on purpose: a candidate that has not been
 * approved yet must never be discoverable as a loadable skill.
 *
 * @returns {string} absolute path to the state directory.
 */
export function stateDir() {
  return join(dshHome(), 'plugin-data', 'skill-evolve')
}
