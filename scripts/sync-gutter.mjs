// Inline the geometry from lib/gutter.js into lib/client.js between markers.
//
// Why this exists: the client bundle is a browser script with no import
// mechanism, so it cannot `import` gutter.js. But the geometry is the part worth
// testing in Node, so duplicating it by hand would rot. Instead the ESM module is
// the source of truth and a generated copy lives inside the bundle between
// `// <gutter>` and `// </gutter>`. A test extracts that block and asserts it
// agrees with the module across a sweep, so drift fails the suite instead of
// shipping.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file, not from a hard-coded checkout path: the whole point of
// a checked-in script is that it runs after a clone.
const repo = fileURLToPath(new URL('..', import.meta.url))
const GUTTER = join(repo, 'lib', 'gutter.js')
const CLIENT = join(repo, 'lib', 'client.js')

/** Where the generated block starts inside lib/client.js. */
export const OPEN = '// <gutter>'

/** Where the generated block ends inside lib/client.js. */
export const CLOSE = '// </gutter>'

/**
 * Build the block that belongs between the markers.
 *
 * Exported so the test can compare against *this* function rather than against a
 * second copy of the same transformation. The first version of that test rebuilt
 * the block by hand and was off by 412 characters — it had kept the file header
 * the sync drops — which is the same two-implementations-drift problem the sync
 * script exists to prevent, just moved up a level.
 *
 * @param {string} source - the text of lib/gutter.js.
 * @returns {string} the indented block, markers included.
 */
export function buildBlock(source) {
  // Drop the module-only trimmings. `export` is a syntax error in the bundle, but
  // the declarations it decorates are exactly what the bundle needs, so the keyword
  // goes and the rest of the line stays.
  const body = source.replace(/^export /gm, '')

  // Keep the constants and the functions; drop the file header, which talks about
  // testing rather than about the bundle.
  const start = body.indexOf('/** Narrowest column worth drawing')
  if (start < 0) throw new Error('could not find the constants in gutter.js')

  const inlined = body
    .slice(start)
    .trimEnd()
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `    ${line}`))
    .join('\n')

  return [
    `    ${OPEN}`,
    '    // Generated from lib/gutter.js by scripts/sync-gutter.mjs. Do not edit here:',
    '    // edit the module, re-run the sync, and the drift test will confirm the two',
    '    // agree. The bundle cannot import because it is a browser script.',
    inlined,
    `    ${CLOSE}`,
  ].join('\n')
}

/**
 * Replace the generated block in a bundle.
 *
 * @param {string} client - the bundle's text.
 * @param {string} block - what {@link buildBlock} returned.
 * @returns {string} the bundle with its generated block replaced.
 */
export function replaceBlock(client, block) {
  if (client.includes(OPEN) === false) throw new Error('lib/client.js has no gutter markers')
  return client.replace(/ {4}\/\/ <gutter>[\s\S]*? {4}\/\/ <\/gutter>/, block)
}

// Only write when run as a script: importing this file must not touch lib/client.js.
//
// Both sides are resolved to a real path before comparing, because they are not
// the same string even when they are the same file:
//
// - `import.meta.url` is Node's own resolution, which is already realpath'd.
// - `process.argv[1]` is whatever the user typed: possibly relative, possibly
//   through a junction or a symlink.
//
// Comparing the two directly meant that running the script through a junction —
// which is exactly how this repo is installed into the DSH profile — matched
// nothing, skipped the write, and still printed "synced" and exited 0. A sync
// script that silently does nothing is worse than one that fails: the generated
// geometry drifts and the drift test blames the module.
// realpathSync on both sides, guarded: argv[1] is not always a path. Running
// through stdin (`node --input-type=module - < script.mjs`) makes it "-", and
// realpathSync would throw ENOENT out of a script whose whole job is to write a
// file. Not being able to resolve it just means this is not the main module.
function samePath(maybeArgv1) {
  if (maybeArgv1 === undefined) return false
  try {
    return realpathSync(maybeArgv1) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (samePath(process.argv[1])) {
  const source = readFileSync(GUTTER, 'utf8')
  const block = buildBlock(source)
  writeFileSync(CLIENT, replaceBlock(readFileSync(CLIENT, 'utf8'), block))
  console.log('synced', block.split('\n').length - 5, 'lines of geometry into lib/client.js')
}
