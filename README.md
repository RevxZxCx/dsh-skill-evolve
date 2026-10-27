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

That is not enough on its own, and the failure is not subtle. On a real 6,145-call session — six days of driving an Android emulator — 85% of the calls were `bash`, so the detector saw `bash, bash, bash` and reported nothing. The most valuable workflow in that session (screenshot → parse the UI dump → look at the image → tap → screenshot again) was structurally invisible.

So a shell call is expanded into the commands it runs before it joins the history:

| Command | Recorded as |
|---|---|
| `cd /f/bot && pnpm test && git diff --stat` | `pkg test`, `git diff` |
| `adb -s emulator-5554 shell input tap 100 200` | `adb shell` |
| `python parse_ui.py s.png` | `py` |
| `npx tsc --noEmit` | `build` |

Four rules then apply, each of which exists because the naive version misfired on a real transcript:

| Rule | Why |
|---|---|
| Non-overlapping occurrence counting | `a,b,c,a,b,c` is two procedures, not four overlapping windows |
| At least 3 distinct steps | A real 487-call session spent its entire hint budget on `bash × 5 → todo_write`, which is "I ran commands and ticked a box" |
| No single step filling half the window | Same habit, longer lens |
| The same habit is announced once | `read,edit,bash` and later `read,edit,bash,grep` are one workflow; so are the rotations `read,edit,bash` and `bash,read,edit` |

The command expansion is deliberately coarse. `npm test` and `pnpm test` are the same step, because the question a procedure answers is "what did the work", not "which binary was on PATH". Programming-language payloads stay opaque: `python x.py` is one `py` step, never the forty lines inside it. Heredocs and inline scripts are stripped before splitting, because a real session turned `node -e "..."` into steps named `n.cd` and `['+n.cd+']')).slice(0,54).padEnd(56)` before that was fixed. Set `commandSignature: false` for the older name-only behaviour.

Replaying a real 487-call coding session through the final rules publishes **0 hints** — correctly, because that session repeated habits rather than workflows. A synthetic session containing a genuine inspect→patch→verify loop publishes **1**. Replaying the 6,145-call emulator session at `minRepeatCount: 3` publishes 1 hint from tool names and 4 from commands, and one of those four is the screenshot loop that name-level detection could not see at all.

Threshold 2 is available but noisy on long sessions: the same 6,145-call transcript publishes four hints at threshold 3 and spends its whole budget of four at threshold 2, one of them on `bash,bash,todo_write,read`. Threshold 3 is the recommended setting on long sessions; the default is left at 2 because a short session may not produce three clean repetitions of anything.

### The hint

Rendered as one dynamic prompt context at order `121`, capped at `maxHintsPerSession` (default 4). It names the procedure, gives the occurrence count, and tells the model three things:

- call `skill_candidate_submit` with a **verbatim quote** as evidence, or ignore the message;
- **nothing will be written on your behalf** either way;
- **write down what failed**, not just the happy path.

That last line is the one that matters most. `self-learning-skills` puts it plainly: skipping a known dead end next session is often worth more than the win itself.

The hint is cleared the moment the model calls one of this plugin's own tools, so the next steps stop paying for text that has already been read.

A hint has two fates and only one of them is loud: the model either acts on it, or it reads it, decides the procedure is not worth keeping, and carries on. Nothing announces the second decision, so a channel that only cleared on tool calls kept the text in every subsequent snapshot. On a complete real transcript that was 132 snapshots and 79,896 characters (~20K tokens) of hint text re-sent, with one hint riding along for 106 consecutive steps.

The obvious fix — delete the text after N steps — is wrong, and the same transcript is the proof. That session did eventually submit a skill, and it did so **412 model steps after the hint first appeared**, from a model that re-read the still-present text (`Should I also consider submitting a skill candidate? The reminder suggests it.`). A hard deadline would have deleted the one hint that worked.

So ageing happens in two stages, each independently switchable:

| Option | Default | Effect |
|---|---|---|
| `hintShrinkAfterSteps` | `8` | The full text becomes a one-line pointer that still names the procedure and `skill_candidate_submit` |
| `hintExpiresAfterSteps` | `0` (off) | After this many steps the pointer is removed entirely |

Shrinking keeps everything that matters: the procedure stays marked "already shown" so it is never offered twice, the budget is not charged again, and `skill_candidate_submit` remains callable. On the same transcript the default cuts re-sent hint text from 79,896 to 24,407 characters — **69% less** — while every one of the 132 snapshots still carries a hint. Retirement is off by default because nothing measured supports a deadline: the longest observed life was 106 steps, so `hintExpiresAfterSteps` values of 120 or 200 saved nothing at all, and the conversion at step 412 is evidence that long life is sometimes the point.

The unit is the assistant message, not the tool call: one message is one time the model read the prompt, whether it carried one tool call or four. Ageing is tracked per agent, so one session's messages never age another session's hint.

Both triggers write into this one channel, so the prompt sees a single stable string rather than two competing ones. The turn reflection bypasses the procedure-dedup check (`distinct: true` in `hint.publish`): that check exists to stop one growing procedure being announced twice, and a reflection has no steps of its own to compare, so it would collide with the previous reflection on nothing but a placeholder marker. Its own throttle is the pacer's budget, which is the better fit.

Sharing one channel has a cost that only shows up in the data. On a real session the pacer ruled two reflections due, the first reached the model, and the second was overwritten by a repeat hint one step later — every snapshot after it carried the repeat hint instead. A reflection is rationed to two per session and is the only path that can see non-structural lessons (which approach was abandoned, which API answered with nothing); losing one to a repeat hint spends the scarce resource on the abundant one.

So a reflection holds the channel briefly:

| Option | Default | Effect |
|---|---|---|
| `reflectionHoldSteps` | `8` | Model steps a reflection keeps the channel to itself; repeat hints are deferred until it lets go |

Briefly, not permanently: a permanent reservation would starve the repeat detector instead, and that detector is what notices work the model is doing right now.

A deferred repeat hint is **not** simply re-derived later. The detector's history is bounded — `repeatWindowMax * (minRepeatCount + 2)`, 24 entries by default — and a held procedure is by definition one the model has stopped repeating, so the window evicts it long before an 8-step hold ends. The rendered hint is therefore kept in a per-agent slot and retried on the tick that releases the hold. `hint.publish` returns `'held'` for the deferral (distinct from `'duplicate'` and `'exhausted'`), and both the deferral and the eventual retry are logged, so "the detector went quiet" stays distinguishable from "the detector found nothing".

The slot is dropped the moment the model calls any `skill_candidate*` tool. That is not a nicety: `hints.clear()` resets the channel's `kind`, which ends the reflection's hold, so without the drop the retry fires on the very next step and resurrects a hint the model just dealt with — spending a second unit of budget to re-say something already answered. The obvious guard, re-checking `alreadyShown` before the retry, does **not** work: a hint turned away by the hold returns before `channel.shown` is written, so that check reports false no matter what the model did. Both of these were caught in review, not by the tests as first written; the tests only began to cover the resurrection once a fixture acted on a *still-pending* deferral and then took another step.

When a reflection fires, the detector's findings ride along in the same message as supporting evidence — "you repeated these three steps" is a much stronger prompt next to "what did this turn teach you".

### The catalog budget

The host re-sends every visible skill's name and description on **every pre-step**, and its own cap on a description is 500 characters. That is fine at ten skills and ruinous at three hundred: the catalog is a fixed cost paid per step, whether or not any of it is used.

Measured on a real session with 13 skills: 3,390 characters per snapshot. Extrapolating with the same average description length, 200 skills cost about 12.9k tokens and 500 about 31.6k — per step.

A prepended `agent/pre-step` handler rewrites the catalog message down to the shortest form that still routes. It changes only `content[0].text` and leaves `source.entries` untouched, because the host digests `[name, description]` pairs to decide whether the catalog changed. Rewriting the entries would make the host conclude it changed on every step and append a new catalog message each time.

Lines are ordered by evidence, then by user override:

| Tier | Gets | Source |
|---|---|---|
| `pinned` | full description, first | `/skill-rank <name> pin` |
| `session` | full description | a `skill` call in this session |
| `frequent` | full description | `uses >= catalogFrequentUses` globally |
| `other` | truncated to `catalogShrinkChars` | — |
| `demoted` | truncated, last | `/skill-rank <name> demote` |

A pin outranks a demote, so marking something important cannot silently suppress it. Ties break on name, which keeps the table stable across steps — only skills that changed tier move.

What this actually saves depends on how long the descriptions are, and the honest answer for a small library is "some". On the same 13-skill session:

| `catalogShrinkChars` | Shrink only | Saved | As shipped (with the caption) | Saved |
|---|---|---|---|---|
| 500 (no shrink) | 3,390 | — | 3,390 | — |
| 200 | 2,531 | 25% | 2,642 | 22% |
| 120 | 2,061 | 39% | 2,172 | 36% |
| **80 (default)** | **1,776** | **48%** | **1,887** | **44%** |
| 40 | 1,307 | 61% | 1,418 | 58% |
| 80 + `catalogFullListBelow: 10` | 767 | 77% | 878 | 74% |

The caption costs 111 characters once, so it takes about 3 points off every row above. That is the price of the hidden descriptions staying reachable; a bigger shrink still wins, because the caption does not grow with the library while the descriptions do.

The saving grows with the library, because the fixed frame and the skill names are what remain. Above `catalogFullListBelow` skills the descriptions are dropped entirely and the list degrades to names, on the theory that a model facing 200 skills should search rather than read.

Whenever a line lost text — truncated at the budget, or reduced to a bare name — and the saving is large enough to pay for it, the block gets one caption after it:

> Descriptions above were shortened; call `skill_search` with keywords to read one in full before ruling it out.

That caption is not decoration. A list of bare names says "these skills are names"; nothing in the host's frame tells the model there is a description behind them, and a model that has already decided a name does not apply has no reason to go looking. The tool description alone is not enough for the same reason. It is one sentence on purpose: this text is re-sent on every step for the life of the catalog, so at the default 80-character budget it costs about 7% of what shrinking saves, and a longer version with a count would cost twice that to convey a number nothing acts on.

Two cases emit no caption at all. On a library where every description fits, there is nothing hidden, and pointing at a search that would return what is already on screen is pure overhead. On a small library whose descriptions sit just over the budget, the 111 characters can cost more than the truncation recovered — the text is still shortened and still searchable, the model is simply not told so until the shrink is worth advertising.

One cost is real and worth stating: tier `session` makes the catalog text change mid-session, which invalidates the prompt cache prefix once per new skill used. Set `catalogSessionAware: false` to trade that back for a catalog that only changes when the skill library does.

### Searching what was shrunk

Shrinking the catalog without a way to search it would be strictly worse than not shrinking: the catalog gets cheap and the skills become invisible. `skill_search` closes that loop.

It searches `ctx.skills.snapshot()` rather than walking the skill directory. The host already merges every provider — project `.dsh/skills`, project `.agents/skills`, custom directories, `$DSH_HOME/skills`, `~/.agents/skills`, bundled — and resolves shadowing between them. A search that disagreed with what the `skill` tool can actually load would be worse than no search at all.

Ranking is keyword-based, in this order of authority:

| Signal | Weight | Why |
|---|---|---|
| name | 10 | the person typed the name |
| `whenToUse` | 4 | written for routing |
| description | 3 | written for humans |
| body | 1 | the longest and least specific field |

Coverage is **squared**, not added: matching every query term in weak fields beats matching one term in a strong field. That is what "find me something that does this" means. Counting distinct terms rather than occurrences matters too — a body that says "pdf" forty times is not forty times more relevant, and occurrence counts make long documents win by length alone.

Bodies are the expensive part, so at most 20 are read per search: matched summaries first, then unmatched ones with whatever budget is left. That second half is the point. A skill stage 1 reduced to a bare name matches nothing on its summary, and its body is the only place its words survive — so probing the unmatched skills is exactly what makes the shrink recoverable. Loading all of them would mean one file read per skill in the library.

Measured on a real 13-skill catalog: `pdf` returns `office-export-pdf` first (name, description, and body all hit), then `office` (description only). `browser` returns `browser-skill` alone.

**The honest limit:** this is lexical, not semantic. A query in Chinese will not find a skill whose description is in English, and a synonym the description does not contain will not match. On the real catalog, `记忆 memory` returned nothing while `browser` returned the right skill — the first is a vocabulary gap, the second is the system working. Semantic search would close the first and needs a vector store, an embedding model, and a threshold nobody can tune; at a few hundred skills the keyword version is cheaper and, when it fails, fails visibly rather than plausibly.

### The market, and why installing asks

`skill_search` answers "what do I already have". It cannot answer "has someone already solved this", which is the question that matters when the library is small and the problem is not.

Three tools cover skills.sh: `search`, `preview`, `install`. Only install is gated, because only install writes. Search and preview are read-only network calls, and asking permission to look something up would train the person to approve without reading — exactly the reflex the gate exists to prevent.

**The download happens before the question, not after it.** An approval that names only an id asks the person to trust a bundle they have not seen; the file list and the executable warning would be empty. So the gate fetches once, renders what it found into the question, caches the bytes under the tool call's id, and hands that same bundle to `execute`. If the cache entry is missing, the install is refused rather than re-downloaded: the whole point is that the person approved *those* bytes, and a second fetch could serve different ones.

The cache entry is removed on take, so one approval covers one write. It is also bounded: a person who denies several installs in a row must not accumulate megabytes of bundles nobody will use.

Two checks run **before** the download rather than after, because both are decidable from the arguments alone and a rejection must not cost a request:

- the id must be `owner/repo/skill`, since it becomes a URL path segment;
- the target name must be kebab-case, and it is derived from the id when the caller does not supply one.

A third short-circuit exists because of a measured host behaviour: under the `never` approval policy the host rejects every request without consulting anyone, so downloading first would spend a real request and cache a megabyte that is discarded for certain. The gate reads the session policy through the `approval` service and denies immediately in that case.

What arrives is a **complete file tree**, not a markdown file. `anthropics/skills/pdf` alone ships twelve files including seven Python scripts. That is why the preview lists every path with its size, calls out executables separately, and truncates only the `SKILL.md` body — the list is what the decision rests on, the body is a convenience.

Paths are validated before anything is written: alphanumerics, dots, underscores, hyphens, and single forward slashes only. The character set is what refuses absolute paths and drive letters; `..` is the one case the set cannot express, so it is checked separately. Files that fail are reported as skipped rather than silently dropped — a bundle that quietly installs 9 of 12 files is worse than one that refuses.

A bundle without a `SKILL.md` is refused outright: the host discovers skills at `<root>/<name>/SKILL.md`, so installing anything else produces files that no session will ever load.

**Known limit:** the market is third-party code with no review step. The gate tells you what will be written and whether it is executable; it cannot tell you whether running it is safe.

### The cards beside the conversation

The plugin ships a client half. It is a real panel built from the host's own
components — not a drawn mock — floating in the empty space on one side of the
conversation column, so it moves with the column instead of covering it.

**Why cards and not a sidebar.** The host exposes a right-hand sidebar, but it is
already the place file previews open, and taking it would mean the panel and a
preview cannot be on screen together. There is no extension point *inside* the
conversation column either — the host's only conversation-scoped slots are the
header and the composer. So the panel is mounted in `shell.overlay` and positions
itself against the measured conversation body: it reads the column's rectangle and
the host's own `--dsh-chat-content-width`, then places itself in whichever gutter
fits. Nothing about the layout is hard-coded, because a fixed offset is wrong the
next time the window resizes or the width handle is dragged.

Three consequences worth knowing, because each one is a deliberate choice:

- **It never covers the top bar.** The overlay starts below the host's top
  clearance and the cards are placed in the horizontal band the conversation body
  occupies, not in the frame's full height.
- **It is covered by the sidebar, not on top of it.** The cards set no `z-index`,
  so the host decides the order and an opened sidebar naturally hides them. A
  panel that punched through the sidebar would be a bug, not a feature.
- **It can be collapsed to a handle.** Clicking the handle, or the header button,
  folds the cards into a narrow strip against the same edge. The side
  (`left`/`right`) and the starting collapsed state are plugin settings.

Three modules, top to bottom:

1. **Last turn.** What the previous turn actually did: the tool calls, the
   commands, the files touched, and a summary in prose. The summary is generated
   by a model call, so it is the one part of this plugin that costs money and the
   only part that can be switched off entirely (`panelSummary: false`). It uses
   `summaryModel` — by default the cheapest model the provider lists, because
   summarising one turn is not a task that needs the model doing the work.
2. **Skills and MCP.** What skills are installed and which MCP servers have been
   called in this session. Each row that looks like a reusable procedure has a
   **propose** action: it opens a new conversation pre-filled with the steps, so
   the skill is drafted with a full context rather than from a one-line prompt.
3. **Produced files.** Files this conversation wrote, newest first, with the
   added and removed line counts. Sourced from the same turn transcript the
   other two modules read, so all three agree on which turn they describe.

The panel is read-only over HTTP: it calls `GET /api/skill-evolve/panel`, and
the only writes it can make are `POST /config` (its own switches) and
`POST /propose` (opening a draft conversation). It cannot install a skill, write
a skill file, or approve a candidate. Those stay behind the tools and the human
handshake described above.

**It needs a host restart.** The host discovers client bundles when its plugin
graph is rebuilt, and editing `package.json` does not trigger that. If the panel
does not appear after restarting, the Plugins page names the reason per entry.

**What it cannot do, on purpose.** The geometry is the only thing the client
computes; every number in the cards comes from the host route. The client holds no
copy of the transcript and re-reads `/panel` on open and on a timer, so the three
modules always describe the same turn. It also cannot decide where the column is:
`measure()` falls back to the documented clamp formula when the host does not
publish a width, and the placement function reports `no-room` rather than
overlapping the text. On a narrow window the cards disappear and the handle
remains, because a panel that cannot fit should not squeeze the thing it is
annotating.

### The evidence gate

Four classes of evidence, each with different authority:

| Class | What it is | What it may support |
|---|---|---|
| `user` | Something the person said | "they decided / they asked for" |
| `tool` | Machine output | the only source for numbers |
| `action` | A tool that was invoked | "this was done" |
| `self` | The model's own narration | first-person judgement only, never a bare fact |

A submission survives only if at least one quote verifies **and** at least one `user` or `tool` quote survives. Self-narration alone is rejected with an explanation, because a skill is authoritative for future sessions.

This check runs at proposal time and its verdict is stored with the candidate — see [Evidence is checked once, at submission](#evidence-is-checked-once-at-submission). Running it again at write time would ask the approving session to reproduce quotes from a different session.

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

`approvalMode: 'direct'` writes the queued body at once, which is what earlier versions of this plugin did.

Approval is permission to write *this draft*, not permission to write anything: the ownership fence still applies, and a draft whose base changed since it was queued is refused rather than merged.

### Evidence is checked once, at submission

The evidence gate runs when a skill is **proposed**, not when it is approved. This is not an optimisation; running it at approval time makes approval impossible in the situation approval actually happens in.

Evidence is a fact about the session a skill was distilled from: "this transcript contains the sentence *Zip the build with 7z*". Approval usually happens in a *different* session — often days later, after the original has been trimmed away. Re-running the gate there asks the current session whether it once said those words, which is the wrong question and has a guaranteed answer of "no". The quotes live in the source session; the approving session has an empty transcript and cannot reproduce them.

So the order is:

1. `skill_candidate_submit` (propose) verifies every quote against the live transcript and records `verifiedAt` and `verifiedInSession` on the candidate.
2. `/skill-capture` records the human's yes. The candidate's stored quotes carry forward; nothing is re-verified.
3. `skill_candidate_submit` with `final: true` writes the draft. It does **not** require an `evidence` argument — asking for one would ask the model to restate quotes from a session it is not in, and the honest reply is "I cannot". The count it reports (`survived`) is the number of quotes already accepted for that candidate.

Two consequences worth stating plainly. A candidate that passed the gate once keeps that verdict for its lifetime; there is no re-check at write time. And `/skill-capture` on a candidate that predates this field will still work — its stored quotes are used as-is.

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
| `commandSignature` | `true` | Expand shell calls into their commands (`pnpm test && git diff` → two steps) instead of recording one `bash` |
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
| `hintExpiresAfterSteps` | `0` | Model steps a hint stays visible before it retires on its own; `0` disables |
| `reflectionHoldSteps` | `8` | Model steps a reflection keeps the hint channel to itself before a repeat hint may replace it; `0` disables |
| `hintRequired` | `false` | Make the hint a `required` context (survives suppression) |
| `catalogEnabled` | `true` | Rewrite the host's skill catalog to the shortest form that still routes |
| `catalogShrinkChars` | `80` | Character budget for a skill nobody pinned, used, or promoted |
| `catalogFullListBelow` | `40` | At or above this many skills, list names only; `0` disables |
| `catalogFrequentUses` | `3` | Global use count that earns a full description |
| `catalogSessionAware` | `true` | Give a full description to skills already used in this session |
| `panelSummary` | `true` | Summarise the previous turn in the cards. Turning this off stops the panel from spending any model call |
| `summaryProvider` | `""` | Provider for that summary. Empty means the session's own provider |
| `summaryModel` | `""` | Model for that summary. Empty means the cheapest model the provider lists — a summary of one turn does not need the model doing the work |
| `panelHelp` | `true` | Show the one-line explanation under each panel heading |
| `panelSide` | `left` | Which gutter the cards occupy. `right` puts them on the other side of the conversation column |
| `panelCollapsed` | `false` | Start folded into a handle instead of showing the cards |

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

The plugin adds seven model-facing tools and five slash commands.

### Tools

| Tool | Purpose |
|---|---|
| `skill_candidate_submit` | Propose a skill. Validates name, description, body, and evidence; queues it (or writes it in `auto` mode). Set `final: true` to write the approved final version — that call needs no `evidence`, because the quotes were verified when it was queued. |
| `skill_candidate_list` | Show what is waiting for approval, including entries that went stale. |
| `skill_feedback` | Record that a managed skill helped or hurt. Drives the lifecycle. |
| `skill_search` | Find an installed skill by keyword, including ones whose description the catalog shrank. |
| `skill_market_search` | Search skills.sh for a published skill. Returns id, source, and install count only — nothing is downloaded. |
| `skill_market_preview` | Show a market skill's file list and the head of its `SKILL.md` before deciding. |
| `skill_market_install` | Install a market skill. **Always asks the person first**, and the question lists the bytes it would write. |

### Commands

| Command | Purpose |
|---|---|
| `/skill-review` | List pending candidates with their verified evidence |
| `/skill-capture <name> [--preview\|--discard]` | Approve, preview, or drop a candidate |
| `/skill-feedback <name> <helpful\|harmful> [note]` | Record an outcome |
| `/skill-stats` | Show stage, confidence, and use counts for every managed skill |
| `/skill-rank <name> <pin\|unpin\|demote\|undemote>` | Mark a skill as always-visible or always-last in the catalog; `unpin` / `undemote` remove one flag and leave the other alone |

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

Two suites exist beyond the unit tests. `test/real-mount.test.mjs` boots the
plugin against a real cordis container, because several defects only appear when
the framework's own service lookup is exercised. `test/mutate-panel.mjs`
deliberately re-introduces each defect the panel's reviews found, one at a time,
and fails if the suite stays green — a test that cannot fail is a test that is
not testing. All ten mutations are currently killed.

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
| Search external skill marketplaces | `skill_market_search` / `_preview` / `_install` against skills.sh. Not wired to ClawHub: its search API did not answer from this host |
| Edit `AGENTS.md` | A different, more invasive surface; this plugin only writes SKILL.md files it owns |
| Session-scoped temporary skills | Not needed: writing to disk and letting the existing `dsh-skill-filesystem` provider discover it is simpler and survives restarts |
| Open a new conversation to confirm a skill | Qoder does this because a skill is authoritative. This plugin splits approval in two (approve, then write with the catalog in view) but keeps it inside the running conversation — a fresh context would cost a whole prompt cache for a step the model can take anyway |

---

## Honest limits

**The cards float; they do not take space.** The host exposes no slot for a real
column beside the message list, so the panel is an absolutely positioned overlay
that places itself in whatever gutter the conversation column leaves. That has one
consequence worth stating plainly: it cannot push the text aside to make room. On
a window narrow enough that neither gutter fits a card, the cards disappear and
only the handle remains — a panel that cannot fit should not squeeze the thing it
is annotating. Widening the window or collapsing the host's own left sidebar
brings them back.


- **The core hypothesis is unproven.** The value depends on tasks recurring. If your work is genuinely one-off, this plugin will correctly stay silent and be worth nothing. That is the honest failure mode, and it is better than writing 50 useless skills.
- **Detection is structural, not semantic.** It knows `bash,read,edit` repeated; it does not know whether the repetition was a good idea. The model supplies that judgement, which is why the hint asks rather than writes. The turn-end trigger exists specifically to cover what structure cannot see, but it can only reflect on what the model notices — a session that learned something and failed to articulate it teaches nothing.
- **The reflection competes with the answer.** It fires at turn end, which is exactly when the model is about to reply. Four calls per session is the whole budget, and each one is a judgement call the model may get wrong in either direction: skipping a real lesson or writing a thin one.
- **Quality cannot be verified on a single machine.** `SkillClaw` needs multiple clients voting to eliminate self-assessment bias. A one-person installation can track whether a skill was used and whether it was reported harmful, but cannot independently confirm it works. Treat `active` as "reported used", not "proven correct".
- **Decay is time-based, not evidence-based.** 90 days is a guess borrowed from `cass-memory`. It will be wrong for some people in both directions.
- **A revision can overwrite a good edit.** It is refused when the base hash changed, which catches the common case. It does not catch a concurrent edit that lands between the check and the write — the window is milliseconds, but it exists.
- **Writes are serialised in one process, not across hosts.** The candidate queue, the registry and the ledger each take a lock, so two sessions in the same host cannot erase each other's work. Two DSH hosts sharing one `DSH_HOME` at the same time are not covered; the failure mode is a lost candidate (recoverable) rather than a corrupt skill (not recoverable).
- **A tool is not a result.** `action` evidence proves the call was dispatched, never that it worked. A skill citing only `action` quotes is not authoritative, and a submission built only from them is rejected.
- **Reading an undeclared service throws, and the throw is silent.** Cordis resolves `ctx.someService` through a proxy that raises `cannot get property "someService" without inject` unless the name is listed in `inject`. Optional chaining does not help — the throw happens on the property read, before `?.` is reached. This plugin shipped a version that read `ctx.agents?.get?.(agentId)` on every `tool/call`; the exception was swallowed by the handler guard, so the detector never saw a single call. It loaded, its tools answered, and nothing ever triggered — for a full session, while 412 assertions passed. The fix is `ctx.get(name)`, which returns `undefined` for an unprovided name instead of throwing. `test/real-mount.test.mjs` now mounts the plugin on the real cordis with `agents` absent, which is the only shape of test that could have caught it: a hand-built fake context defines `agents` as a plain property and never throws.

- **Prompt cache cost is real but bounded.** Each hint is a single stable string, cleared as soon as it is acted on or retired by `hintExpiresAfterSteps`, and a session may see at most `maxReflectionsPerSession + maxHintsPerSession` of them. The costs that are *not* bounded: every hint invalidates the prefix cache once when it appears and once when it clears, and a hint that arrives while the model is mid-response is paid for by every step until it expires — at most 8 of them by default, which is the whole point of the deadline.
- **A hint that was read but not acted on is indistinguishable from one that was never read.** Expiry is a cost control, not evidence. The plugin does not know whether the model ignored the hint, judged the procedure worthless, or simply had other work; it only knows the text has been in front of the model long enough. Treat a retired hint as "no answer", not as "rejected".
- **The catalog shrink is a heuristic about descriptions, not a measurement of routing.** The tiers assume a truncated description still carries enough signal for the model to pick the right skill. That holds for "fills PDF forms" and fails for anything whose distinguishing detail is at the end of the sentence. A pinned skill is the escape hatch, and a model that cannot tell two skills apart can still search once stage 2 lands.
- **The catalog rewrite is coupled to a host implementation detail.** It works because the host digests `[name, description]` pairs rather than the rendered text, so changing `content[0].text` is invisible to its change detection. A host version that digests the rendered message instead would make this handler append a catalog on every step. `test/catalog.test.mjs` pins the assumption; it cannot make the host keep it.

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
