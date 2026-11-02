# @revxz/dsh-evolve-core

The engine the evolve plugins share. Not a plugin: it has no `apply()`, registers
nothing, and is never added to a profile.

It exists because two plugins need the same seven things and copying them would
let them drift. The rules about what counts as evidence, when a candidate goes
stale, and what stage a skill has reached are the same rules whether they are
applied while detecting a repeated tool sequence or while rendering a review
dialog. A second copy of that logic is how the detector and the panel would come
to disagree about whether a candidate is still live.

## Install

As a dependency, not a plugin:

```bash
npm install @revxz/dsh-evolve-core
```

In this repository it is a workspace member, so `npm install` at the root links
it. Nothing resolves `@revxz/dsh-evolve-core` until that has run once.

## What is in it

| module | what it owns | why it is here rather than in a plugin |
| --- | --- | --- |
| `paths.js` | where state lives on disk (`dshHome`, `skillRoot`, `stateDir`) | both halves must agree on the location or the panel shows an empty queue forever |
| `skillfile.js` | reading and writing `SKILL.md`, the `evolved-by` ownership marker, frontmatter parse/render | the writer is in the detector and the reader is in the panel; a mismatch writes files nobody can read back |
| `store.js` | the serialized read-modify-write store, the append-only ledger, `procedureSignature` | two processes appending to one queue is the bug this serialization exists to prevent |
| `candidates.js` | the proposal queue, staleness rules, content digests | staleness is computed by the detector on submit and re-checked by the panel on approve |
| `evidence.js` | the gate that decides whether a quote is real evidence | the same gate has to run for the CLI tool and the panel button, or one path accepts what the other rejects |
| `lifecycle.js` | stage decisions (`unverified` → `active` → `stale` / `inverted`) and confidence | the ledger writes it and the panel displays it |
| `outcome.js` | the post-load observation window | it observes the same session events the detector subscribes to |
| `skillcall.js` | the `/name` gesture pattern and `skill` tool argument parsing | one caller counts usage, the other displays it; two regexes would disagree on edge cases |

Re-exported from `lib/index.js` as a single named barrel — 51 exports. Import
from the package, not from a file path, so a module can be moved without
rewriting callers.

## Two decisions worth knowing before you change it

### The two `ageInDays` are not the same function

`candidates.js` and `lifecycle.js` both compute "how many days old is this", and
they deliberately disagree on the unreadable case:

- a **candidate** whose timestamp cannot be parsed is `0` days old, so it does
  **not** expire — a damaged queue file should not silently discard proposals
- a **skill** whose validation stamp is missing is `Infinity` days old, so it
  **is** overdue — an unverifiable skill should not keep its `active` stage

Both are load-bearing. Merging them would either expire every candidate with a
damaged file or never age a skill again. They are exported as `ageInDays`
(lifecycle) and `candidateAgeInDays` (candidates) so a caller has to pick one on
purpose.

### `SKILL_GESTURE` carries the `g` flag

It is global because `matchAll` requires it. That also means `test()` and
`exec()` advance its `lastIndex` on the shared instance. Callers should pass it
to `matchAll` and not hold on to a partially-consumed state.

## What it deliberately does not contain

No detector, no hint channel, no HTTP route, no React. Those belong to
`@revxz/dsh-skill-evolve` and `@revxz/dsh-ui-evolve`, which both read this
package instead of reading each other.

The test for whether something belongs here: **would a future `mcp-evolve` want
it too?** The engine is written against "a name plus a body", not against skills
specifically, which is what makes the placeholder package a real reservation
rather than a wish.

## Tests

The suites live at the repository root, not in this package:
`test/candidates.test.mjs`, `test/evidence.test.mjs`, `test/lifecycle.test.mjs`,
`test/outcome.test.mjs`, `test/skillfile.test.mjs`, `test/store.test.mjs`.

```bash
npm test                   # from the repository root
```

## License

MIT
