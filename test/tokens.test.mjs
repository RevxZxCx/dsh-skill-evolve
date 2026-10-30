// Every CSS custom property the bundle references must be one the host defines.
//
// The panel styles itself entirely with host tokens so it follows the light and dark
// palettes without shipping a second theme. That only works if the names are real: an
// undefined property makes the declaration fall back to the literal colour written
// beside it, which looks fine in one theme and wrong in the other. Four invented
// names shipped that way once, and no test could see it — the fallbacks were plausible
// light-mode colours, so every screen looked right in the one mode anyone checked.
//
// test/host-tokens.txt is dumped from the installed theme by
// scripts/extract-host-tokens.mjs. Regenerate it after a host upgrade.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repo = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

const listed = readFileSync(path.join(repo, 'test', 'host-tokens.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('--dsw-'))
const defined = new Set(listed)

const bundle = readFileSync(path.join(repo, 'lib', 'client.js'), 'utf8')

check('the host token list is not empty', defined.size > 100, `${defined.size} tokens`)
check('the host token list has no duplicates', defined.size === listed.length, `${listed.length} lines, ${defined.size} unique`)

// `var(--dsw-x, fallback)` is the only way the bundle names a token.
const used = [...new Set([...bundle.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))].sort()
check('the bundle names at least a few host tokens', used.length >= 5, `${used.length} tokens`)

const missing = used.filter((token) => !defined.has(token))
check(
  'every token the bundle names is defined by the host theme',
  missing.length === 0,
  missing.length === 0 ? undefined : `undefined in this theme: ${missing.join(', ')}`,
)

// The alias the panel uses for its own typography is set by the shell per session, so
// it is deliberately not in the theme's static list.
const own = used.filter((token) => token.startsWith('--dsse-'))
check('the token audit does not count the bundle owning its own variables', own.length === 0, own.join(', '))

// A `var()` with no fallback breaks the declaration outright when the token is gone;
// one with a fallback merely degrades. Both are checked above, but the fallback should
// exist wherever the colour is load-bearing.
const bare = [...bundle.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)\s*\)/g)].map((match) => match[1])
check('host tokens are referenced with a fallback colour', bare.length === 0, bare.join(', '))

// Four names that never existed in this theme. Listed so a future edit that
// reintroduces one fails with the reason rather than a bare "undefined token".
const invented = ['--dsw-alias-bg-brand', '--dsw-alias-label-brand', '--dsw-alias-border-brand', '--dsw-alias-border-secondary']
const reintroduced = invented.filter((token) => used.includes(token))
check('the invented aliases stay gone', reintroduced.length === 0, reintroduced.join(', '))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
