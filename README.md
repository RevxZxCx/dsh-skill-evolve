# dsh-skill-evolve

A DeepSeek Harness plugin that notices when a session produced something worth remembering — a procedure that repeated, or a lesson a turn taught — asks the model whether it is worth writing down, checks that the model's evidence is real, and then ages the resulting skill out when it stops being useful.

It is not a memory system and not an autonomous self-improvement loop. It adds two things:

1. **An alarm clock** with two independent triggers: a repeated tool procedure, and a finished conversation turn. Both are rationed per session.
2. **A ledger** — verifies that a proposed skill's evidence actually appears in the transcript, and tracks whether the skill later helped or hurt.

Everything the model wants to save goes through a human unless `mode` is explicitly `auto`.

---

## Why it is built this way

Five findings from the research in `docs/` shaped every decision here. They are worth reading before changing the code.

**Do not run a second LLM to distil the conversation.** The model is already in the conversation holding the full context. A second pass pays for the whole transcript again to produce something worse. `@loserfox/distill` took that route and is broken on this host — it calls `ctx.subagents.start()`, which does not exist in DSH 0.2.1 (`SubagentRuntime` exposes `startActivation`). It fails silently in a `try/catch`, so it looks installed and does nothing.

**Prompt injection must be static.** The host re-assembles dynamic contexts every step, so any change to the injected text invalidates the prefix cache for the whole conversation. Hermes freezes its memory snapshot at session start for exactly this reason, and `hermes-agent-self-evolution` lists "no mid-conversation changes" as a hard guardrail. This plugin renders one hint string that stays byte-identical until a new procedure is worth mentioning, and renders `''` — fully absent, zero tokens — otherwise.

**Evidence gates beat prompt instructions.** `distill-kura` found that telling an agent "don't hallucinate" does not work; a deterministic check does. Every evidence quote submitted here is searched for character-for-character in the session transcript — but only in the lane its class claims, because a flat corpus lets the model quote itself and call it a tool result. Fabricated quotes are rejected and echoed back so the model can see what it invented.

**A skill that hurt should become a warning, not disappear.** `cass-memory` inverts repeatedly-harmful rules into `PITFALL:` anti-patterns: "Bad rules don't just get deleted — they become warnings." The same rule applies here at `invertAfterHarmful`.

**Zero uses is not proof of uselessness.** Hermes Curator's wording: "Zero uses is absence of evidence, not proof the skill is disposable." So nothing here deletes a skill. The worst outcome is `inverted`.

---

## What it does, concretely

### Two triggers, because they see different things

The plugin has two independent reasons to speak up, and they are complementary rather than alternative. This matters enough to state before the mechanics:

| Trigger | Sees | Misses |
|---|---|---|
| **Turn end** (`turn`) | Meaning: a correction the person made, a library pitfall, a dead end and the way through | Anything happening mid-turn |
| **Repetition** (`repeat`) | Structure: a multi-step procedure worth re-running | Everything semantic — it knows `read`,`grep`,`edit` repeated, not what was being fixed |

A repetition detector alone is blind to the most valuable thing a session produces, because "the pager API is zero-indexed" is not a tool sequence. A turn-end reflection alone never fires until a turn is over, so a long turn that repeats a procedure six times says nothing until it ends.

Qoder calls its version **Skill evolution suggestions** and this plugin's turn trigger is modelled on it: reflect when a task finishes, let the model decide whether anything generalises. That is affordable here for a specific reason — **the model is already in the conversation**. It is not a second pass over the transcript; it is one more instruction attached to a step the model was going to take anyway. The expensive shape — fork a subagent, replay the transcript, ask it to distil — is what `@loserfox/distill` did, and it is both costly and broken on this host.

Set `triggers: []` to disable both, `['turn']` or `['repeat']` to keep one.

### Detection

The detector sees **tool names only**, never arguments. A `read` of `a.txt` and a `read` of `b.txt` are the same step.

Four rules, each of which exists because the naive version misfired on a real transcript:

| Rule | Why |
|---|---|
| Non-overlapping occurrence counting | `a,b,c,a,b,c` is two procedures, not four overlapping windows |
| At least 3 distinct tool names | A real 487-call session spent its entire hint budget on `bash × 5 → todo_write`, which is "I ran commands and ticked a box" |
| No single tool filling half the window | Same habit, longer lens |
| The same habit is announced once | `read,edit,bash` and later `read,edit,bash,grep` are one workflow, not two |

Replaying a real 487-call coding session through the final rules publishes **0 hints** — correctly, because that session repeated habits rather than workflows. A synthetic session containing a genuine inspect→patch→verify loop publishes **1**.

### The hint

Rendered as one dynamic prompt context at order `121`, capped at `maxHintsPerSession` (default 4). It names the procedure, gives the occurrence count, and tells the model three things:

- call `skill_candidate_submit` with a **verbatim quote** as evidence, or ignore the message;
- **nothing will be written on your behalf** either way;
- **write down what failed**, not just the happy path.

That last line is the one that matters most. `self-learning-skills` puts it plainly: skipping a known dead end next session is often worth more than the win itself.

The hint is cleared the moment the model calls one of this plugin's own tools, so the next steps stop paying for text that has already been read.

Both triggers write into this one channel, so the prompt sees a single stable string rather than two competing ones. The turn reflection bypasses the procedure-dedup check (`distinct: true` in `hint.publish`): that check exists to stop one growing procedure being announced twice, and a reflection has no steps of its own to compare, so it would collide with the previous reflection on nothing but a placeholder marker. Its own throttle is the pacer's budget, which is the better fit.

When a reflection fires, the detector's findings ride along in the same message as supporting evidence — "you repeated these three steps" is a much stronger prompt next to "what did this turn teach you".

### The evidence gate

Four classes of evidence, each with different authority:

| Class | What it is | What it may support |
|---|---|---|
| `user` | Something the person said | "they decided / they asked for" |
| `tool` | Machine output | the only source for numbers |
| `action` | A tool that was invoked | "this was done" |
| `self` | The model's own narration | first-person judgement only, never a bare fact |

A submission survives only if at least one quote verifies **and** at least one `user` or `tool` quote survives. Self-narration alone is rejected with an explanation, because a skill is authoritative for future sessions.

Each class is checked against **its own lane** of the session, not against one concatenated blob:

| Lane | Built from |
|---|---|
| `user` | `user/message` authored by the human (`source.kind === "user"`) |
| `tool` | `tool/result` payloads — machine output |
| `action` | `tool/call` records: the name and the arguments the host dispatched |
| `self` | assistant prose only |

The revision that introduced lanes exists because a single corpus does not work. The model's reasoning, its tool calls and the machine's output all land in the same string, so it could quote itself and label the quote `tool` — a check that passes while proving nothing, which is the exact failure the gate is supposed to prevent.

Two details that look like nits and are not:

- **Tool arguments go in `action`, not `self`.** The text is a name and the arguments the host logged when it dispatched the call. That proves the call was made; it does not prove it succeeded, which is why `action` is not authoritative. Putting arguments in `self` instead would leave only tool names in `action` — `bash` is four characters, below the minimum quotable length, so the class would be unusable and the model would relabel the same fact as `tool`.
- **The model's `tool-call` block is not collected anywhere.** It is the model's *draft* of the call and exists whether or not dispatch ever happened. Admitting it would let a hallucinated call manufacture its own evidence.

Host-injected context (runtime reminders, skill catalogs, the system prompt) lands in a `system` lane that no evidence class may cite.

### Lifecycle

Four stages, driven by evidence rather than by a timer:

```
unverified --(promoteAfterUses loads)--> active
active     --(staleAfterDays without a load)--> stale
any        --(invertAfterHarmful harmful reports)--> inverted
```

**A load counts as a use.** When the model calls the host's `skill` tool with the name of a skill this plugin wrote, that is the one reliable signal that the skill was actually read — the catalog is served from memory, so nothing else fires. Each load increments `uses`, appends a `skill_used` line to the ledger, and refreshes `validated`. Counting is skipped for any name whose file does not exist or is not ours, so a model cannot inflate a counter by naming somebody else's skill.

Counting happens at dispatch rather than at result. Pairing a call with its result means holding a `callId → name` map and hoping the result always arrives; an interrupted call would silently drop a use, and an under-count is the failure that matters — it keeps a good skill `unverified` forever. The ownership check already rules out the common false load, so the residual error leans toward counting one that went on to fail.

This is *not* gated on `mode`. `mode` governs detection and creation; bookkeeping of skills that already exist is a separate question, and turning hints off does not mean the approved skills stopped being used.

`skill_feedback` remains the explicit signal — a person or the model saying "this helped" or "this hurt" — and it alone can raise `helpful` or `harmful`. Usage says a skill was *reached*; only feedback says it *worked*.

Counters live in two places on purpose: `registry.json` is the read path, and the skill file's frontmatter is the durable copy. If the registry is lost, the next load rebuilds the entry from the file — which is why every load rewrites the file rather than only rewriting it when the stage moves.

`inverted` is terminal until rewritten: the file gains a `PITFALL` section at the top and keeps the original procedure underneath, because a warning is only trustworthy if a reader can see what it warns about.

Confidence decays with a 90-day half-life, and one harmful report costs four helpful ones (`helpful - 4 × harmful`).

### Proposing a revision

A submission whose name matches a skill **this plugin** wrote is not a collision — it is a revision. The first version was written in a session that did not know what the current one knows; refusing the update is how a catalog ends up full of skills whose first draft is all anybody ever gets.

The revision records the base it was written against (a hash of the body, plus the lifecycle record). It is applied only if that base is still there, still owned, and still unchanged at approval time — so an edit made in between is noticed instead of silently reverted. Use counts and harmful counts survive the edit; resetting them would erase the evidence that says whether the skill is worth keeping at all.

A skill somebody else wrote is still a hard refusal.

### Candidates go stale

A queue entry is approvable only while the world it describes still exists. Four things can end that, checked every time the queue is read rather than on a timer:

| Reason | Triggered by |
|---|---|
| `expired` | older than `candidateTtlDays` |
| `source-missing` | the session it cites is gone |
| `name-taken` | a skill with that name appeared while it waited |
| `base-changed` | a revision whose target was edited or removed |

Stale entries are **reported, never deleted**: they hold the evidence and the body somebody already wrote. A stale candidate can be read with `--preview` and discarded with `--discard`, and resubmitting under the same name refreshes it.

### Approval is a handshake

`approvalMode: 'confirm'` (the default) splits approval in two:

1. `/skill-capture <name>` records the human's yes. Nothing is written.
2. The model writes the final body on its next step, via `skill_candidate_submit` with `final: true` — which gives it one more look at the current catalog before committing.

This is Qoder's behaviour and its wording: "task creation does not mean the Skill has already changed." The point is that a draft can age between being proposed and being approved, and the model is the only party who can notice.

`approvalMode: 'direct'` writes the queued body at once, which is what earlier versions of this plugin did. Both modes route through the same evidence gate: approval is permission to write *this draft*, not permission to write anything.

### The ownership fence

Every file this plugin writes carries `evolved-by: dsh-skill-evolve` in its frontmatter. A file without that marker is **never** modified — not by approval, not by inversion, not by feedback. Submission against an existing hand-written skill name is refused outright with an explanation.

### Storage

| What | Where |
|---|---|
| Approved skills | `$DSH_HOME/skills/<name>/SKILL.md` |
| Pending candidates | `$DSH_HOME/plugin-data/skill-evolve/candidates.json` |
| Lifecycle registry | `$DSH_HOME/plugin-data/skill-evolve/registry.json` |
| Audit ledger (append-only JSONL) | `$DSH_HOME/plugin-data/skill-evolve/ledger.jsonl` |

Candidates live outside the skill root on purpose: an unapproved candidate must never be discoverable as a loadable skill.

---

## Install

From this directory:

```bash
dsh plugin --profile desktop add F:/dsh-plugin/dsh-skill-evolve
```

The package ships its own `cordis.patch.yml`, so the bundle registers itself. **Do not also insert it manually into the profile's `cordis.patch.yml`** — a duplicate loader entry id prevents the host from starting.

Then restart the host (a Host restart is enough) and confirm the plugin loaded:

```bash
dsh plugin --profile desktop list --depth=0
```

To disable it without uninstalling, set `disabled: true` on its entry in the profile patch:

```yaml
- id: skill-evolve
  disabled: true
```

### Configuration

All fields are optional. The defaults are deliberate: **propose, do not write.**

| Key | Default | Meaning |
|---|---|---|
| `mode` | `suggest` | `suggest` = hint only; `auto` = write on submit; `off` = detect and log, never hint |
| `triggers` | `['turn','repeat']` | Which triggers are active; `[]` disables both |
| `reflectionCadence` | `3` | Human turns before the first reflection; doubles after each one |
| `reflectionMinToolCalls` | `4` | Tool calls a turn needs before reflecting on it |
| `maxReflectionsPerSession` | `2` | Hard cap on turn-end reflections |
| `minRepeatCount` | `2` | Occurrences before a procedure is reported |
| `repeatWindowMax` | `6` | Widest window treated as one procedure |
| `minWindow` | `3` | Narrowest window considered |
| `maxHintsPerSession` | `4` | Hint budget per session |
| `skillRoot` | `""` | Override the skill directory; empty means `$DSH_HOME/skills` |
| `maxCandidates` | `50` | Queue cap before further submissions are refused |
| `candidateTtlDays` | `30` | Days a candidate stays approvable; older ones are reported stale, never deleted |
| `approvalMode` | `confirm` | `confirm` = approve, then the model writes the final body on its next step; `direct` = write at once |
| `verifyCandidateSource` | `true` | Refuse to approve a candidate whose source session no longer exists |
| `promoteAfterUses` | `3` | Helpful reports needed for `unverified` → `active` |
| `invertAfterHarmful` | `3` | Harmful reports needed to invert into a warning |
| `staleAfterDays` | `90` | Days without validation before `active` → `stale` |
| `hintRequired` | `false` | Make the hint a `required` context (survives suppression) |

`mode: auto` is the only setting that writes without a person seeing it first. It is not the default and should not become one.

### Reflection budget

A fixed cadence spends its whole budget early. Replaying the real 15-turn session documented below with `reflectionCadence: 3` and `maxReflectionsPerSession: 2` fired both checkpoints by turn 7, leaving the last eight turns uncovered. The cadence therefore **doubles after each reflection**, which puts the second checkpoint near the middle of a long session instead of right after the first:

```
reflection 1 → after 3 turns
reflection 2 → after 3 + 6 = 9 turns
reflection 3 → after 3 + 6 + 12 = 21 turns   (only reachable if the cap allows it)
```

That is rationing, not throttling. The cap is what ultimately bounds the noise; the backoff is what makes the cap land in useful places.

### What counts as a human turn

The host writes four different kinds of `user/message` into a session, and only one of them is a person:

| `source.kind` | What it is | Counts as a turn |
|---|---|---|
| `user` | A person typing | yes |
| `agent-instructions` | The `AGENTS.md` baseline | no |
| `runtime-context` | The per-step runtime snapshot | no |
| `user-approval` | A tool approval receipt | no |

All four were observed in a real session log. Counting the injected ones would make every step look like a new conversation and fire the checkpoint continuously.

---

## Use

The plugin adds three model-facing tools and four slash commands.

### Tools

| Tool | Purpose |
|---|---|
| `skill_candidate_submit` | Propose a skill. Validates name, description, body, and evidence; queues it (or writes it in `auto` mode). Set `final: true` to write the approved final version. |
| `skill_candidate_list` | Show what is waiting for approval, including entries that went stale. |
| `skill_feedback` | Record that a managed skill helped or hurt. Drives the lifecycle. |

### Commands

| Command | Purpose |
|---|---|
| `/skill-review` | List pending candidates with their verified evidence |
| `/skill-capture <name> [--preview\|--discard]` | Approve, preview, or drop a candidate |
| `/skill-feedback <name> <helpful\|harmful> [note]` | Record an outcome |
| `/skill-stats` | Show stage, confidence, and use counts for every managed skill |

A typical cycle:

```
(a long turn ends, third human turn of the session)
[skill-evolve] This turn is a checkpoint. Before you answer, decide whether it taught you
something a future session would need...

  1. Did the person correct me, or state a preference...
  2. Did I hit a dead end and find the way through?...
  3. Did I learn a fact about this project or library...

→ model calls skill_candidate_submit with two verbatim quotes

(next session, in the CLI)
/skill-review                    # candidate is waiting
/skill-capture scanned-pdf --preview
/skill-capture scanned-pdf       # approves it; the model writes the final body
                                 # on its next step, which lands
                                 # $DSH_HOME/skills/scanned-pdf/SKILL.md

(later, after using it three times)
/skill-feedback scanned-pdf helpful
/skill-stats                     # scanned-pdf is now active
```

The repetition trigger produces a differently shaped message when it fires first:

```
[skill-evolve] The tool sequence below repeated in this conversation...
  read → edit → bash
  2× · 6 tool calls
```

---

## Tests

```bash
node test/run.mjs          # every suite
node test/run.mjs signal   # one suite
```

335 assertions across nine suites. They are plain Node scripts with no test framework, so they also double as executable documentation.

| Suite | Covers |
|---|---|
| `signal.test.mjs` | The four detection rules, including the regressions that motivated each one |
| `evidence.test.mjs` | Verbatim matching, the four classes, fabrication rejection |
| `skillfile.test.mjs` | Frontmatter round-trip, ownership fence, malformed input |
| `lifecycle.test.mjs` | Promotion, inversion, staleness, confidence decay |
| `hint.test.mjs` | Sub-run dedupe, per-agent isolation, budget, rendering |
| `reflection.test.mjs` | Human-turn detection, cadence backoff, substance filter, budget, rendering |
| `candidates.test.mjs` | The four staleness rules and the queue annotation that keeps a recorded verdict meaningful |
| `index.test.mjs` | The whole plugin against a fake host: detect → hint → submit → queue → approve → promote → invert, plus both triggers together |
| `gaps.test.mjs` | The three later additions end to end: revisions, staleness in a real queue, and both approval modes |

### Replay against a real session

`test/replay.mjs` runs the detector over a decompressed `session.v4.jsonl.zstd`:

```bash
node test/replay.mjs /path/to/session_dump.jsonl
```

This is the check that matters most, because the synthetic tests cannot answer "does this fire on a real conversation or does it bury the model in noise". Run it before changing any detection threshold — the current values were chosen from its output, not from intuition.

To produce a dump from a real session log:

```js
// Multi-frame zstd: decompress frame by frame, not in one call.
const raw = fs.readFileSync(path)
const offsets = []
for (let i = 0; i + 4 <= raw.length; i++) {
  if (raw[i] === 0x28 && raw[i+1] === 0xb5 && raw[i+2] === 0x2f && raw[i+3] === 0xfd) offsets.push(i)
}
const text = offsets.map((start, k) =>
  zlib.zstdDecompressSync(raw.subarray(start, offsets[k+1] ?? raw.length)).toString('utf8')
).join('')
```

---

## What this plugin does not do

Each of these was considered and rejected, with the reason:

| Not done | Why |
|---|---|
| Run a second LLM to distil the session | Pays for the transcript twice to produce something worse; the inline model already has the context |
| Fork a subagent to re-read the conversation | Same cost, plus the fork does not share the parent's prompt cache |
| Write a skill without approval | The default is `suggest`; `auto` exists but is opt-in |
| Delete unused skills | Zero uses is absence of evidence, not proof of uselessness; worst case is `inverted` |
| Semantic (embedding) deduplication | Needs a vector store and a threshold nobody can tune; the catalog itself is the dedupe surface |
| Search external skill marketplaces | Out of scope — install `dsh-skill-hub` for that |
| Edit `AGENTS.md` | A different, more invasive surface; this plugin only writes SKILL.md files it owns |
| Session-scoped temporary skills | Not needed: writing to disk and letting the existing `dsh-skill-filesystem` provider discover it is simpler and survives restarts |
| Open a new conversation to confirm a skill | Qoder does this because a skill is authoritative. This plugin splits approval in two (approve, then write with the catalog in view) but keeps it inside the running conversation — a fresh context would cost a whole prompt cache for a step the model can take anyway |

---

## Honest limits

- **The core hypothesis is unproven.** The value depends on tasks recurring. If your work is genuinely one-off, this plugin will correctly stay silent and be worth nothing. That is the honest failure mode, and it is better than writing 50 useless skills.
- **Detection is structural, not semantic.** It knows `bash,read,edit` repeated; it does not know whether the repetition was a good idea. The model supplies that judgement, which is why the hint asks rather than writes. The turn-end trigger exists specifically to cover what structure cannot see, but it can only reflect on what the model notices — a session that learned something and failed to articulate it teaches nothing.
- **The reflection competes with the answer.** It fires at turn end, which is exactly when the model is about to reply. Four calls per session is the whole budget, and each one is a judgement call the model may get wrong in either direction: skipping a real lesson or writing a thin one.
- **Quality cannot be verified on a single machine.** `SkillClaw` needs multiple clients voting to eliminate self-assessment bias. A one-person installation can track whether a skill was used and whether it was reported harmful, but cannot independently confirm it works. Treat `active` as "reported used", not "proven correct".
- **Decay is time-based, not evidence-based.** 90 days is a guess borrowed from `cass-memory`. It will be wrong for some people in both directions.
- **A revision can overwrite a good edit.** It is refused when the base hash changed, which catches the common case. It does not catch a concurrent edit that lands between the check and the write — the window is milliseconds, but it exists.
- **Writes are serialised in one process, not across hosts.** The candidate queue, the registry and the ledger each take a lock, so two sessions in the same host cannot erase each other's work. Two DSH hosts sharing one `DSH_HOME` at the same time are not covered; the failure mode is a lost candidate (recoverable) rather than a corrupt skill (not recoverable).
- **A tool is not a result.** `action` evidence proves the call was dispatched, never that it worked. A skill citing only `action` quotes is not authoritative, and a submission built only from them is rejected.
- **Prompt cache cost is real but bounded.** Each hint is a single stable string, cleared as soon as it is acted on, and a session may see at most `maxReflectionsPerSession + maxHintsPerSession` of them. The costs that are *not* bounded: every hint invalidates the prefix cache once when it appears and once when it clears, and a hint that arrives while the model is mid-response is paid for by every remaining step until cleared.

---

## Background

The research that produced these decisions is in `docs/`:

| File | Contents |
|---|---|
| `01-调研报告.md` | Commercial IDEs, open-source frameworks, DSH-ecosystem plugins, an 11×8 capability matrix |
| `02-可行性分析.md` | Host capability verification, F1–F7 requirements, risks, effort estimate |
| `03-Hermes与开源生态补充.md` | Hermes in depth: `skill_manage`, Curator, frozen memory snapshots |
| `04-开源实现横向对比.md` | 14 open-source implementations, four architectural shapes, five mechanisms worth copying |
| `05-设计方案.md` | The design this code implements, including what was rejected and why |
