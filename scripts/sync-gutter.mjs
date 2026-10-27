// Inline the geometry from lib/gutter.js into lib/client.js between markers.
//
// Why this exists: the client bundle is a browser script with no import
// mechanism, so it cannot `import` gutter.js. But the geometry is the part worth
// testing in Node, so duplicating it by hand would rot. Instead the ESM module is
// the source of truth and a generated copy lives inside the bundle between
// `// <gutter>` and `// </gutter>`. A test extracts that block and asserts it
// agrees with the module across a sweep, so drift fails the suite instead of
// shipping.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file, not from a hard-coded checkout path: the whole point of
// a checked-in script is that it runs after a clone.
const repo = fileURLToPath(new URL('..', import.meta.url))
const GUTTER = join(repo, 'lib', 'gutter.js')
const CLIENT = join(repo, 'lib', 'client.js')

const source = readFileSync(GUTTER, 'utf8')

// Drop the module-only trimmings. `export` is a syntax error in the bundle, but
// the declarations it decorates are exactly what the bundle needs, so the keyword
// goes and the rest of the line stays.
const body = source.replace(/^export /gm, '')

// Keep the constants and the three functions; drop the file header, which talks
// about testing rather than about the bundle.
const start = body.indexOf('/** Narrowest column worth drawing')
if (start < 0) {
  console.error('could not find the constants in gutter.js')
  process.exit(1)
}
const inlined = body
  .slice(start)
  .trimEnd()
  // `export` on the constants was filtered above, so re-add nothing; the bundle
  // just needs the declarations in scope.
  .split('\n')
  .map((line) => (line.trim() === '' ? '' : `    ${line}`))
  .join('\n')

const block = `    // <gutter>\n    // Generated from lib/gutter.js by scripts/sync-gutter.mjs. Do not edit here:\n    // edit the module, re-run the sync, and the drift test will confirm the two\n    // agree. The bundle cannot import because it is a browser script.\n${inlined}\n    // </gutter>`

let client = readFileSync(CLIENT, 'utf8')
if (client.includes('// <gutter>') === false) {
  console.error('lib/client.js has no gutter markers')
  process.exit(1)
}
client = client.replace(/ {4}\/\/ <gutter>[\s\S]*? {4}\/\/ <\/gutter>/, block)
writeFileSync(CLIENT, client)
console.log('synced', inlined.split('\n').length, 'lines of geometry into lib/client.js')
