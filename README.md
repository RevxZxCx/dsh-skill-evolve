# dsh-evolve

A suite of DeepSeek Harness plugins that watch a session and explain it back: one
that learns skills from what the session did, and one that shows the person what
just happened. They are separate plugins on purpose — either one works alone, and
the pair is better than either.

| Package | What it is | npm |
|---|---|---|
| [`packages/core`](packages/core) | Shared machinery: the candidate queue, the evidence gate, the skill file format, the lifecycle counters, the ledger. No host plugin, no `apply()`. | `@revxz/dsh-evolve-core` |
| [`packages/skill-evolve`](packages/skill-evolve) | Detects a repeated procedure or a finished turn worth remembering, proposes a skill, verifies the evidence, ages it out when it stops helping. | `@revxz/dsh-skill-evolve` |
| [`packages/ui-evolve`](packages/ui-evolve) | The three cards beside the conversation, the candidate review dialog, and the panel settings. | `@revxz/dsh-ui-evolve` |
| [`packages/mcp-evolve`](packages/mcp-evolve) | A reserved placeholder. `apply()` throws on purpose — see below. | `@revxz/dsh-mcp-evolve` |

## Why they are separate

The panel started inside the skill plugin, because the first thing it showed was
the candidate queue. Then the cards grew into a general "what just happened"
surface — files changed, MCP tools touched, the previous turn summarised — and
that has nothing to do with skill evolution. Keeping them in one package meant a
person who wanted the cards had to install a skill-learning engine, and a person
who wanted the engine got a bundled client bundle they never asked for.

The split is by **feature, not by layer**. `ui-evolve` is not the "front end" of
`skill-evolve`: it reads the host's own session events, owns its own transcript
bookkeeping and its own five configuration keys, and renders from data it collected
itself. The only thing it borrows is the candidate queue, and it borrows that at
runtime.

That borrow is a cordis service, published and consumed without a compile-time
dependency:

```js
// packages/skill-evolve/lib/index.js
ctx.provide('skillEvolve', { listCandidates, pendingCandidates, approveCandidate,
                             discardCandidate, isOwned, requestProposal })

// packages/ui-evolve/lib/index.js
function skillHalf() {
  const half = service('skillEvolve')   // service() goes through ctx.get
  return half !== null && typeof half === 'object' ? half : undefined
}
```

Every route that needs the queue treats its absence as `unavailable` rather than
as an error, which is why the panel's **Suggest** button is *absent* rather than
*broken* when the skill half is not installed. The lookup happens per request and
is never cached, because cordis may activate the sibling plugin after this one.

`core` exists because both halves need the same definition of what a candidate *is*
and what makes an edited file safe to write. Duplicating those would let the two
packages disagree about a queue row, and the disagreement would only surface as a
corrupted `SKILL.md`.

## Install

The two plugins are installed separately, and each ships its own
`cordis.patch.yml`:

```bash
dsh plugin --profile desktop add @revxz/dsh-skill-evolve
dsh plugin --profile desktop add @revxz/dsh-ui-evolve
```

`@revxz/dsh-evolve-core` is a library, not a plugin — it has no `dsh` block and no
`apply()`, and installing it on its own does nothing.

From a checkout, install the workspace links first, then point the profile at the
two package directories:

```bash
npm install                        # links packages/* under node_modules/@revxz
dsh plugin --profile desktop add F:/dsh-plugin/dsh-skill-evolve/packages/skill-evolve
dsh plugin --profile desktop add F:/dsh-plugin/dsh-skill-evolve/packages/ui-evolve
```

`npm install` is not optional for a checkout: `packages/skill-evolve` imports
`@revxz/dsh-evolve-core` by name, and without the workspace link the import fails
at load time.

Then restart the host and confirm both loaded:

```bash
dsh plugin --profile desktop list --depth=0
```

## Repository layout

```
packages/core/            shared library, no plugin entry
packages/skill-evolve/    plugin: detection, tools, commands, ledger
packages/ui-evolve/       plugin: cards, dialog, settings, client bundle
packages/mcp-evolve/      placeholder that refuses to load
test/                     every suite, across packages
scripts/                  generators and mutation harnesses
docs/                     research, design, reviews — and docs/handover/
prototypes/               static HTML prototypes used to settle the panel's layout
```

Tests live at the root rather than inside each package because a large share of them
cross package boundaries: they boot both plugins against one fake host and drive a
candidate from detection through approval to a written `SKILL.md`. Inside a package
those would become fragile cross-repository tests the day the halves were published
separately.

## Working on it

```bash
npm install                # required before anything imports core by name
npm test                   # every suite
node test/run.mjs signal   # one suite
```

Two generators keep generated content honest, and both are safe to re-run:

```bash
node scripts/sync-gutter.mjs          # inline packages/ui-evolve/lib/gutter.js into client.js
node scripts/extract-host-tokens.mjs  # refresh test/host-tokens.txt from the installed theme
```

`lib/client.js` is a hand-written bundle with no build step, so anything it needs
from another module has to be copied into it. `sync-gutter.mjs` is that copy, and
`test/gutter-drift.test.mjs` fails if the copy and the module disagree.

Three mutation harnesses prove the tests can fail at all:

```bash
node test/mutate-panel.mjs
node scripts/mutate-guards.mjs
node scripts/mutate-checklist-panel.mjs
```

Each re-introduces a defect a review found and fails if the suite stays green.
`mutate-guards.mjs` also refuses to start when `lib/gutter.js` differs from git
HEAD, because it holds a mutated copy on disk while running: an interrupted run
leaves the mutation behind, and the next run would read that file as its baseline
and report every anchor as missing.

## The placeholder

`@revxz/dsh-mcp-evolve` reserves the name and the slot for MCP evolution. Its
`apply()` throws. That is deliberate: a plugin that loads and silently does nothing
leaves a permanently inert line in the profile's config, which reads as "installed
and working". Failing at load time says what it is.

## License

MIT
