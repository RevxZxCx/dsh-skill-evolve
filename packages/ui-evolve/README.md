# @revxz/dsh-ui-evolve

A DeepSeek Harness plugin that puts three cards in the empty space beside the
conversation, showing the state of **this conversation**: a summary of the last
finished turn, the skills and MCP servers it touched, and the files it changed.

That state survives a restart. It is written to
`$DSH_HOME/plugin-data/skill-evolve/sessions/<sessionId>.json`, one file per
conversation, and read back when the panel is opened in a conversation this
process has not seen before. The file is deleted when the conversation is
archived or deleted from the host, so what the plugin keeps never outlives what
it describes. See **What the panel remembers** below for the shape and the
cleanup rules.

It is the presentation half of the `dsh-evolve` suite. It reads the session and
never writes to the skill directory; when the skill half is installed it also
draws the **建议** entry in its header, which opens the candidate queue, because
`@revxz/dsh-skill-evolve` publishes that queue as a service and this package only
consumes it. Without that service the entry is absent, not broken.

## Install

```bash
dsh plugin --profile desktop add @revxz/dsh-ui-evolve
```

Or from a checkout of this repository:

```bash
dsh plugin --profile desktop add F:/dsh-plugin/dsh-skill-evolve/packages/ui-evolve
```

The package ships its own `cordis.patch.yml`, so the bundle registers itself.
**Do not also insert it manually into the profile's `cordis.patch.yml`** — a
duplicate loader entry id prevents the host from starting.

The client half is loaded by the host's own module loader: `lib/client.js` is a
hand-written bundle that registers itself as `@revxz/dsh-ui-evolve`. That id has to
equal the package name, because the host refuses a bundle whose registration id
does not match, and throws on a duplicate. A new or renamed client bundle needs a
**host restart** to be scanned; a `package.json` change alone does not trigger it.

## Configuration

Five keys, all optional. They are the panel's own; the detection settings live in
`@revxz/dsh-skill-evolve`.

| Key | Default | Meaning |
|---|---|---|
| `panelSummary` | `true` | Summarise the previous turn in the cards. Turning this off stops the panel from spending any model call |
| `summaryProvider` | `""` | Provider for the summary. Empty means borrow the session's own route — the one already proven to work for this account |
| `summaryModel` | `""` | Model for that summary. Only read together with `summaryProvider`; setting one alone pins nothing |
| `panelSide` | `left` | Which side of the conversation column the cards occupy. Measured against the column, not the window, so the host sidebar is never covered |
| `panelCollapsed` | `false` | Start folded into a handle instead of showing the cards |

## The routes

The panel talks to the host over a prefix route registered at
`/api/ui-evolve`: `GET|HEAD /panel`, `GET /models`, `GET|POST /config`,
`GET|POST /candidates`, and `POST /propose`.

Every route answers `HEAD` with a body-less 200.

The browser side and the host side cannot share a constant — `lib/client.js` is a
hand-written bundle with no `import` and no build step — so the prefix appears as a
literal in both files. `test/route-prefix.test.mjs` is what keeps them equal, and it
exists because a mismatch is the quietest failure this plugin can have: the client
mounts, renders, and gets a 404 on every request, which looks exactly like a session
with nothing to show.

## What the panel remembers

Three kinds of fact, all describing one conversation, all in one file:

| Fact | Why it is kept |
|---|---|
| The skills this session loaded, and by which path | the second card; a "load" is either the `skill` tool or a `/name` gesture |
| The MCP tool names this session called | the second card; server names are parsed out of `mcp__<server>__<tool>` |
| The last finished turn's snapshot | the first and third cards; counts, commands, paths, the prose source |

The file also carries the shared recency clock those rows sort by, so the order a
person saw is the order they see again.

**One file per conversation**, at
`$DSH_HOME/plugin-data/skill-evolve/sessions/<sessionId>.json` — beside
`candidates.json` and `ledger.jsonl`, which the core package already writes
there. The name is the host's own session id, checked against an allowlist
before it is used as a path: an id that cannot be stored safely is refused rather
than escaped, which costs that one conversation's panel state and cannot write
outside the directory.

**A file this build cannot read is left alone.** `read` answering "nothing" covers
two different facts: there is no file, and there is a file this build refuses —
a newer `state` version, a torn body, a name inside that is not this session. The
two must not be merged, because the delete that follows an empty read is only
authorised by the first one. A build that treats "I cannot read it" as "it is
not there" erases every session the first time a user rolls back to it, one
shutdown at a time. So the loader asks the filesystem separately whether
something is there, and when it is, the record it installs owns the id without
owning the file: it writes nothing over it, and the shutdown delete does not
apply.

**Written by overwrite, not by journal.** There is one copy of the state and it
is replaced whole on each write: write a temporary file, rename it over the old
one. No `.bak`, no version directory, no history. The panel shows a state, not a
ledger, and the cost of that choice is stated plainly — a process killed mid-write
loses the last change to that turn, not "the last known good version".

Writes are coalesced rather than issued per event. A turn produces a tool call
per file read; writing per call would put a disk write inside the event loop for
work nobody has asked to see yet. An event marks the session dirty and schedules
one write a second later; the two moments that must be on disk before the
process goes away — a turn ending and an agent being disposed — flush
immediately. A panel read is *not* one of them: it loads the stored state into
memory and answers from there, so a poll every few seconds would otherwise be a
write every few seconds. The timer is `unref`'d, so a pending write never keeps
the host alive.

**Deleted when the conversation is archived or deleted.** The host does not emit
an archive or delete event, and `session/disposed` is *not* a delete signal — it
also fires on a normal host shutdown, so using it would clear the panel on every
restart. The two real signals are `workspaceRegistry.archivedSessionIds` and
`workspaceRegistry.sessionKnown(id)`, read every minute through `ctx.effect` and
throttled to one sweep per five minutes. `sessionKnown` reports `false` only on a
*definite* miss — the host's own contract says a storage fault propagates rather
than masquerading as an unknown session — so a fault keeps everything. Two more
rules follow from that: if neither signal can be obtained, nothing is deleted at
all; and a cap of 500 files, applied independently of the host answers, drops the
oldest so the directory cannot grow with every conversation ever held.

Disposal is not deletion. When an agent is disposed the in-memory entry is
released and flushed but the **file stays** — the host disposes every agent on
shutdown, so deleting there would wipe the panel on each restart, which is the
whole thing this is meant to prevent.

## Theme contract

Every colour comes from the host's own `--dsw-*` tokens. This package ships no
palette of its own, so light and dark follow the host without a second source of
truth. `scripts/extract-host-tokens.mjs` writes the host's 403 defined token names
to `test/host-tokens.txt`, and `test/tokens.test.mjs` fails if the bundle ever names
a token the host does not define. That test exists because four invented aliases
once shipped: they resolved to nothing, fell back to a hard-coded light colour, and
only looked correct until someone switched the theme.

---

### The cards beside the conversation

This package is that client half. It is a real panel built from the host's own
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
   only part that can be switched off entirely (`panelSummary: false`). By
   default it runs on **the route this session is already using**, read from the
   session's own folded `request/context` events. That route is known to be
   reachable and authorised for this account; a catalogue entry only proves some
   adapter advertised it. An earlier version picked the first model the first
   provider listed and failed on the user's machine with "no model route is
   available", which is the failure mode of trusting a catalogue over a running
   session. Setting both `summaryProvider` and `summaryModel` overrides it, and
   only that pair pins anything.

   The call carries no `system` message. The host renders one as the `developer`
   role on the wire, and some providers reject that outright — the panel showed
   `400 unsupported message role: developer` on a model it had just chosen
   correctly. Instead the instruction is the opening of the single `user`
   message, which every wire protocol accepts. The instruction also names its own
   delimiters (`<transcript>`), and the body is scrubbed of any such tag before
   it goes in: a tool output that happened to contain `</transcript>` would
   otherwise end the block early and let the rest of it read as instructions.
   The scrub is case-insensitive and tolerates whitespace inside the tag, because
   `</TRANSCRIPT >` closes a block just as well as `</transcript>`.
2. **Skills and MCP.** The skills **this session has loaded**, newest first, and
   which MCP servers have been called. What is installed is not what was used:
   the library can hold dozens of skills, and listing them all answers a question
   nobody asked while burying the one that matters. A load is counted on either
   path the host supports — the model calling the `skill` tool, and a person
   typing `/name` — but the two paths are not interchangeable. The host refuses
   a gesture at a skill whose `userInvocable` is false and injects nothing, so
   that gesture is not a load and is not listed. Rows are read-only: a skill row
   used to carry a **propose** action that opened a new conversation pre-filled
   with the steps, and it was removed along with the header's propose button —
   drafting the next turn is not what a person is doing while reading the card.
   The route it called (`POST /propose`) remains part of the service contract.
3. **Produced files.** Files this conversation wrote, newest first, with the
   added and removed line counts. Sourced from the same turn transcript the
   other two modules read, so all three agree on which turn they describe.

Reading the panel may touch the disk: `GET /panel` falls back to the stored
session state when this process holds nothing for that conversation yet, so the
first open after a restart answers from the file rather than from an empty
transcript. The read is per conversation and happens once — the loaded document
is installed into the in-memory store, so a polled panel does not re-read.

The panel can write, but only through the routes that already had a gate behind
them. It calls `GET /api/ui-evolve/panel` to read the three modules,
`GET /api/ui-evolve/candidates` to read the queue, `POST /config` for its own
switches, and `POST /candidates` to approve or discard one candidate. The panel
itself no longer calls `POST /propose` — the button that did is gone, because a
hint into the next turn is not something a person reaches for while reading the
card. The route stays: it is part of the service contract and other callers may
use it. `POST /candidates` does not
implement approval either: it calls the same `approve()` the `/skill-capture`
command calls, so the evidence gate and the confirm handshake are not
re-implemented behind a second entrance. A route that wrote the skill file itself would be a way
in that skips both.

### Candidate review and panel settings

The three cards stay visible together: **Last turn**, **Skills and MCP**, and
**Produced files**. A card with no content is hidden rather than drawn empty, and
if none of the three has anything to say the rail hides entirely — header row
included, because an empty panel with buttons on it still looks like a panel. The
one thing that counts as content without being one of the three cards is a
non-empty candidate queue: a session whose cards are all empty but whose queue
holds work still draws the header, because that button is the panel's only way
into the review dialog.
Skills and MCP servers share one list ordered by most recent use on a single
recency clock, with a different icon per type.

There is one exception to that hiding, and it is a line rather than a column: while
the first answer for a session has not arrived, the rail draws **正在加载…**. The
history here is worth keeping. An earlier version drew a full column of empty cards
plus a "reading…" label and then replaced all of it, which reads as a flicker; the
correction after that drew *nothing at all* until the data landed, which goes too
far in the other direction — the panel simply is not there, and a person cannot tell
loading from empty. The narrow version keeps the answer honest: one line, only in
the slot where an empty panel would otherwise be, and gone the moment the answer
arrives. The distinction it relies on is `data === undefined` versus a data object
with nothing in it: "has not answered" and "answered, and the answer is empty" are
different states and must not share a rendering.

The header row is ordered **refresh, settings, review**. The review entry is
labelled with the word 建议 rather than an icon, and it carries the pending count
as a badge; it is the only way into the queue from the panel, so a session whose
cards are all empty but whose queue holds work still draws the header. Its
accessible name starts with the visible word (`建议 候选审核`), because a name that
replaces the label rather than containing it fails WCAG's label-in-name rule. The
whole row sits on its own card surface — border, radius, background — instead of
three bare buttons floating over the conversation.

The last-turn card carries its counts in the header, not in a strip below the
text: calls, commands, and files as labelled numbers, aligned on the title's
baseline so the row reads as one line rather than two that happen to sit at the
same height. The stats sit against the right edge — they are a readout about the
card, not a continuation of its title, and pushing them out leaves the title free
to use the width it has. This reverses an earlier version that kept them beside
the title; seeing the card in use settled it in favour of the edge. The header
carries no action button. It used to hold a **propose** button that wrote a hint
into the conversation; it was removed because the hint is not something a person
reaches for while reading the card, and a button nobody presses is a button that
steals width from the counts.

The header has no fixed height. It had one once, `min-height: 42px`, sized for
that propose button; when the button went the height stayed, and the title row —
which is one line of text — sat above roughly 40px of nothing. Three cards share
one `Card` component, so the leftover was in all three at once. Height now comes
from the content: one line plus 7px of padding on each side.

The summary below the header is capped at six lines (9.3em, against a 1.55em line
box) at 0.86em, and fades out when — and only when — there is more text than the
cap shows. The cap has been three lines, then five; five was still cutting
mid-thought often enough to matter, and six fits a typical turn's closing
paragraph. Smaller type is what pays for the extra line: the card sits beside the
conversation and should read as annotation, not as a second column of prose.

The cap lifts for exactly one reason: a click. Hovering does not open the card —
it reveals a centred line below the summary that says what a click will do
(`点击展开全文`), and clicking anywhere on the card opens it until it is clicked
again. The hint is not a button of its own: it is a `div` with
`pointer-events: none`, so a click on the hint is a click on the card beneath it,
and the whole card is the target. Making it a real button would have meant a
second thing to focus, a second click handler, and a second accessible name for
what is really just a line of text explaining the card.

That costs one deliberate trade. The hint is mounted and unmounted as the pointer
enters and leaves, so the card grows by 26px on hover. The alternatives are worse:
floating the hint over the text hides the line the person is reading, and lifting
the cap on hover — which is what this used to do — pushes the text six lines down
under the pointer. 26px is the cheaper surprise.

A card with nothing hidden does not offer the interaction at all: no pointer
cursor, no hint, no tab stop, no `role="button"`.

The fade is measured, not assumed. A `Clip` component compares `scrollHeight`
against `clientHeight` in a layout effect and sets `data-clipped` on the result;
the stylesheet draws the gradient only for `data-clipped="true"` and, now, only
while the card is collapsed. Two things go wrong when the flag is hard-coded
instead: a one-line summary shorter than the 34px mask gets washed out by a fade
covering text that was never truncated, and a long summary is cut with no
indication that anything follows. A layout effect rather than a passive one,
because a passive effect runs after the browser has painted — every first render
would show one frame with clipped text and no fade.

The measurement stops while the card is open, deliberately. Lifting the cap is a
CSS change, so `scrollHeight` and `clientHeight` agree the moment the card opens;
a clip that measured there would read "nothing is hidden" and overwrite the one
fact that makes the card a toggle. The card would stay open but stop being
clickable, stop taking focus, and stop reporting `aria-expanded` — the keyboard
user who just opened it could no longer close it.

Candidate review is a click-open modal, not a pair of hover cards. The queue is on
the left and the selected candidate's description, body, `whenToUse`, and evidence
are on the right. It supports search, explicit approval and discard, and a second
confirmation before a discard removes a queue entry. Stale entries stay readable
but cannot be approved.

With `approvalMode: 'confirm'` the default, approving does not write a file — it
marks the candidate as awaiting a final draft. The row therefore stays visible
with a waiting notice and cannot be approved twice. Only a direct write or a
discard removes it, and removal is always by `id`: two candidates can share a name
once an older one goes stale.

The modal traps Tab focus while it is open, closes on Escape or the backdrop, and
returns focus to the review button. Its close transition leaves the controls
unreachable while it is fading out. Panel settings use the same modal pattern and
hold the summary switch, model picker, and side preference instead of interrupting
the cards themselves.

Typography follows the host rather than naming a platform font. The client reads
`fontFamily`, `fontSize`, and `lineHeight` from the conversation's computed style,
reads the code font from a host `code` or `pre` element when one exists, and watches
host class and inline-style mutations so a live font or size change reaches the
cards and both modals. Code labels use the host code font; everything else uses the
host conversation font.

**It needs a host restart.** The host discovers client bundles when its plugin
graph is rebuilt, and editing `package.json` does not trigger that. If the panel
does not appear after restarting, the Plugins page names the reason per entry.

**What it cannot do, on purpose.** Every number in the cards comes from the host
route. The client holds no copy of the transcript; it re-reads `/panel` when the
panel opens and on a timer thereafter. A failed
background refresh keeps the last good cards visible beside the error instead of
replacing them with an empty panel — and a *manual* refresh keeps them too: the
loading state belongs to a session whose answer has never arrived, not to a reload
of an answer already on screen. Dropping the payload there emptied the whole rail
for the length of the request, and an open settings dialog went with it. The rail
still uses measured geometry: `measure()` falls
back to the documented clamp formula when the host does not publish a width, and
the placement function reports `no-room` rather than overlapping the text. On a
narrow window the cards disappear and the handle remains, because a panel that
cannot fit should not squeeze the thing it is annotating.

### When the panel is shown, and how it learns

**Only in a conversation.** The host renders `[data-conversation-content]` on
*every* page — the conversation, the settling state while one opens, and the
launcher for a new one — so "I found the conversation body" says nothing about
which page this is. The same element carries `data-content-phase`, which the host
sets to `active`, `settling`, or `hero`. The overlay reads that attribute during
every measurement and draws nothing when it is `hero`.

A missing attribute keeps the cards. The check is `phase === "hero"`, not
`phase !== "active"`, and that asymmetry is deliberate: a host older than this
plugin does not publish the attribute at all, and for that host the honest answer
is to behave as it did before rather than to silently remove the panel everywhere.

Sizes are watched with a `ResizeObserver`, but the phase is not a size — the host's
three variants change the styles of children, not necessarily the rectangle of
the element that carries the attribute. So a `MutationObserver` watches
`documentElement` for attribute changes filtered to `data-content-phase`, and a
change triggers one re-measurement. It filters on attributes alone: a `childList`
observer on the conversation would fire once per streamed token, which is the one
cost this overlay cannot pay.

`settling` draws the cards. So does a host that publishes no attribute at all.

**How it learns: a timer.** The panel calls `GET /api/ui-evolve/panel` every eight
seconds (`REFRESH_MS` in `lib/client.js`) and renders whatever comes back. There is
no subscription and no server push; the numbers are re-derived on the host for each
request, so there is nothing to invalidate and nothing to keep in sync.

An event stream was tried here and removed (`D-74`). It reported *that* this
conversation changed, and the client answered with one `/panel` call — no payload,
one place deciding what the panel looks like. It was taken out because the thing it
replaced covered more than it did: the stream only spoke for one session, while the
pending-candidate count is read from a **global** queue, and the touched-file sizes
come from a `stat` taken at read time — a file changed by another process produced
no event at all. Making the stream the fast path meant slowing the only channel that
saw those changes from 8 seconds to 60, which is a narrower view of the world, not a
fresher one.
