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

Seven keys, all optional. They are the panel's own; the detection settings live in
`@revxz/dsh-skill-evolve`.

| Key | Default | Meaning |
|---|---|---|
| `panelSummary` | `true` | Summarise the previous turn in the cards. Turning this off stops the panel from spending any model call |
| `summaryProvider` | `""` | Provider for the summary. Empty means borrow the session's own route — the one already proven to work for this account |
| `summaryModel` | `""` | Model for that summary. Only read together with `summaryProvider`; setting one alone pins nothing |
| `monitorColumn` | `true` | Draw the cards in the column. This is the only layout there is: turning it off leaves no panel, which is what the header switch does |
| `monitorWidth` | `300` | Width of that column in px. The grip writes it back; the ends are clamped to 220–460 in `lib/gutter.js` |

## The routes

The panel talks to the host over a prefix route registered at
`/api/ui-evolve`: `GET|HEAD /panel`, `GET|HEAD /speed`, `GET /models`,
`GET|POST /config`, `GET|POST /candidates`, and `POST /propose`.

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
components — not a drawn mock — in a reserved strip on the right of the conversation
column, so it moves with the column instead of covering it.

**Why cards and not a sidebar tab.** The host exposes a right-hand sidebar, but it
is already the place file previews open, and taking it would mean the panel and a
preview cannot be on screen together. A tab would also page the cards out of sight,
and this panel is meant to be watched, not visited.

**So the column is reserved rather than overlaid.** The panel is still mounted in
`shell.overlay`, but it no longer floats in whatever gap is left over. The
conversation body hands over a strip on its right — `margin-right` on the host's
own scroll container, sized by `--dsse-monitor-reserve` — and the cards draw inside
that strip. `placeMonitor()` in `lib/gutter.js` decides the geometry from the
measured column rectangle; nothing is hard-coded, because a fixed offset is wrong
the next time the window resizes. There is no fallback layout: if the column does
not fit, the prose reflows instead. An earlier version degraded to the old floating
cards below a threshold, and because the degraded width had been saved to the
config, dragging the grip narrow once left the panel stuck in that layout with no
way back.

Five consequences worth knowing, because each one is a deliberate choice:

- **It never covers the top bar.** The column spans the conversation body's own
  band, not the frame's full height.
- **It borrows width instead of covering it.** The prose is a centred
  `max-width` box, so narrowing the container by W narrows the text by exactly W
  and re-centres it. That is why the reserve is a plain `margin-right` and not
  padding: padding would have moved the text by half and left the scrollbar under
  the column.
- **It gives the width back.** Closing the column, tearing the plugin down, and
  every path that draws nothing all set the reserve to `0px`. Forgetting that on
  any one path means a user who merely tried the switch gets a permanently
  narrower conversation — this was a real defect, caught by an assertion.
- **The host's own right width handle is hidden while the column is on.** It is
  positioned from `--dsh-chat-content-width` against the frame centre, so it would
  drift on top of the cards. The host already does the same thing when a composer
  overlay is present.
- **The column draws no edges at all.** It used to rule its left and top sides and cast a
  shadow leftwards over the gutter. The verdict was that the ruling makes the panel read as a
  separate window rather than part of the conversation, so both borders and the shadow are
  gone; the column is told apart by its own surface and the cards' outlines. It keeps a
  `border-radius` on the two corners that face the conversation, and deliberately keeps
  `overflow` visible so the grab strip that hangs 12px outside the left edge is not clipped.
- **The last turn is in the header card, not in a card of its own.** It used to be the first
  card, with a title and three counters beside it (calls, commands, files). It is now the
  second line of the column's sticky header card: the queue row is the first line, a
  `border-top` divides them, and the summary is a quiet "written when" line followed by the
  text — five lines of it, which is five times the line height and no magic number.
  The header and the card list share one scroll container, and the header is its first child
  with `position:sticky; top:0`, so it stays put while the cards scroll under it — and there
  is still only one scrollbar.
  The surface sits on an **inner** box, not on the sticky wrapper. The wrapper carries the
  column's own background so it can cover the cards sliding beneath it, and that background
  has to reach the column's edges; a border and a radius on the same element would draw a
  band of card floating over a strip of page. So the wrapper is edge to edge and the card is
  inside it, which is what makes its width match the cards below it instead of being 20px
  wider than them.
- **The expand badge waits to be looked at, and changes places with the state.** It starts
  invisible and fades in when the pointer reaches the card, when the card has keyboard focus,
  or once the card is open. Folded, it floats on the fade at the list's foot — a folded list
  has no spare line to give it, and the disc marks how many rows are behind the fold. Open, it
  becomes a centred row under the revealed content, because floating there would park it on
  the last file name and a row that shifts down reads as the list having gained an item.
  One shared placement for both states is what kept putting the circle on a file name.
  The placement is keyed on `data-open`, which every card publishes, and not on
  `aria-expanded`: the files card hands its expansion to a real button, so it never carries
  `aria-expanded` itself, and rules hung on that attribute matched nothing on the one card
  that needed them.
  The summary block is a twin, not a card: it is `.dsse-recap` and carries `data-expanded`
  instead of `data-open`, so the card's rules never reached it and it kept drifting back to
  one placement for both states. It now has the same pair of rules under its own attribute.
  Two elements holding the same state is exactly where a rule set goes half-missing -- the
  assertion that guards it is `ruleOf('.dsse-recap .dsse-expand') === ''`, because both of
  the two-state rules can be correct while a leftover unconditional rule still wins.
  While hidden it also gives up `pointer-events`, because a disc at `opacity:0` would
  otherwise swallow the click meant for the file row underneath it. The reveal covers
  `.dsse-col-top` as well as `.dsse-card`, since the summary now lives inside the header card
  and a pointer on the queue row is still a pointer on the card that answers it.
- **A folded file list says it is folded.** Four rows and a fade under them, then the badge.
  The `max-height` only became a fold once it came with `overflow:hidden`: before that the
  cap cut nothing, every row was still drawn, and the badge landed on the last one. The fade
  is a `::after` on the list itself, on `bg-layer-1` so it reads as the card turning
  transparent rather than a grey bar.
- **A folded card says nothing about a partial directory listing.** The note about the
  directory not being read to the end is about a list the reader cannot see yet, so it is
  drawn only while the card is open — or when the folded card really does have rows left over.
- **The host's turn rail rides on the column, not on a measurement.** The rail is hidden by
  `@container (width<=900px)`, a query on the scroll *area* — which is a different number from
  the *gutter* the rail actually needs (40px). On a 1440px window with the sidebar open, the
  area is 1160px and the prose 742px, so 209px a side stands empty and the host hides the rail
  anyway. Measuring that area to decide "is there room" answered the wrong question and kept
  the rail invisible through two fixes; it is gone. Instead `placeMonitor()` spends the rail's
  80px out of the column's width budget up front, and a drawn column *is* the promise that the
  rail has its room. `applyMonitorReserve()` writes `html[data-dsse-turn-rail]` from the same
  number as the column's own flag, so the two can never disagree. With the column off we took
  no width, so the attribute drops and the host's own threshold applies.
  (Qoder calls the same feature "message anchors": `hidden md:flex` on viewport width alone,
  never a width measurement — which is why a right-hand column never crowds it there.)
  **The attribute-driven CSS rule alone was not enough.** Three selectors keyed on a CSS
  module hash (`SNx2jG_frame`) and two locale translations; all matched in an isolated Chrome
  but none matched the running build, so the rail stayed hidden until the column narrowed.
  Two drift-proof backstops now carry it: a structural CSS selector
  (`[data-conversation-scroll] nav` — TurnNavigator is the only nav in the scroll body; the
  breadcrumb nav lives in the header) and a `forceTurnRail()` JS pass that sets inline
  `display:block` on that nav while the column is open. Inline style beats the host's
  non-important container query regardless of hashing or locale, and the inline hold is
  released again when the column closes.
  **The rail also mounts later than the first measurement.** The host gates it behind
  `scroll.initialized && items.length >= 2`, and a nav appearing changes neither the
  conversation body nor the overlay's size — so `ResizeObserver` never saw it, the inline hold
  was never written, and the rail only showed up after some unrelated resize. A
  `MutationObserver` on `[data-conversation-scroll]` (`childList`, `subtree`) now replays the
  pass, coalesced to one `requestAnimationFrame` per frame so a streaming conversation costs a
  variable check per token rather than a layout read. It attaches lazily — the overlay mounts
  before the conversation does — and is disconnected on teardown.
  **The rail also has to declare its own `visibility`.** In the desktop app the nav was
  present with a real 28×192 box, 19 marks and correct `::before` colours, yet
  `elementFromPoint` fell straight through it: an ancestor held the conversation subtree at
  `visibility:hidden`, which inherits down and that `display` and `z-index` cannot override.
  Both the structural CSS rule and the inline hold now set `visibility:visible`, which beats
  the inherited value without touching an ancestor that may be hiding other things on purpose.
  (A `z-index` bump on the nav's slot was tried and removed: it rested on a probe where the
  column had been resized by hand without moving the reservation, which manufactured an
  overlap. Measured cleanly the two never overlap — `scroll 280..475`, `rail 425..453`,
  `column 475..695`.)
  **A theme's stand-in rail is retired, not realigned.** The claude-style theme can hide the
  host nav and paint its own `.dsh-claude-turn-rail` into the same slot. Re-showing the host
  nav leaves two rails drawn on top of each other, and they disagree: measured together they
  shared x `1263..1291` but ran y `281..543` against `292..532` — an 11px offset that reads as
  the rail being misaligned. The stand-in also carries its own `@container (width<=900px)`, so
  the doubling appeared exactly when the column was dragged narrow (slot 978 − 64 padding =
  914, just over its threshold) and vanished when it went under. The stand-in is retired
  unconditionally, leaving exactly one rail at every width and in every column state; its
  markup is `aria-hidden`, so nothing is lost for screen readers. Scoping the rule to our
  column was the bug: closing the column widens the scroll area from 764px back to ~984px,
  over the stand-in's own 900px query, so the moment the rule went inert the theme drew its
  rail beside the host's again.
  **When the right sidebar opens, the column steps aside.** The host frame carries
  `data-rightbar-collapsed` only while *that* column is collapsed (React drops a
  `false`/`undefined` attribute), so its absence means "open". `data-sidebar-collapsed` is the
  left session list and is absent on an ordinary screen, so reading it pinned the answer to
  "open" forever. While the right sidebar is open the column is not drawn at all and
  the width goes back to the conversation: the prose is already at its 560px floor, and a
  half-width panel would have to be re-learned every time. Reading the attribute needs the frame
  element, which is found through its `[data-shell-overlay]` child — the layer this overlay
  lives in. If that fails, the plugin assumes the sidebar is closed and keeps drawing, because a
  blank column with no visible reason is worse than one that occupies space.
  **And it has to take the mouse back.** The host's slot is `pointer-events:none` on purpose
  — it spans the whole scroll area and must not swallow clicks meant for the conversation —
  and the nav only becomes clickable because the host stylesheet sets `auto` on it. On the
  desktop build that computed to `none` anyway: the rail measured 28×222, `elementFromPoint`
  fell through to the scroll body, and hover previews appeared only for synthesized events.
  Both the structural rule and the inline hold now declare `pointer-events:auto` on the nav
  itself, which is the element that should be clickable — raising it on the slot instead
  would make the full-width transparent layer eat the conversation's clicks.
- **The column scrolls its own body, and the resize strip is wider than it looks.**
  **Releasing the inline styles takes `removeProperty`, not `delete`.** Closing the column
  hands the nav back to the host, and the first version of that release was `delete
  node.style.display`. It returns `true` and removes nothing: `element.style` is a proxy over
  the CSSOM and `display` is never one of its own properties. Measured on the live page, the
  nav still carried `display: block; z-index: 21` after the delete and stayed on screen with
  the column closed, while the theme's stand-in came back — two rails. `style.removeProperty`
  is the call that actually clears a declaration.
  `.dsse-monitor-body` owns `overflow-y:auto` and the leftover height, and the embedded rail
  goes back to `position:static` inside it — otherwise the column's own `overflow:hidden`
  clips the cards and the rail inherits the old overlay's absolute positioning. The grab strip
  reaches 12px outside the edge and is 20px wide, with the visible 3px line drawn by `::after`;
  at 8px it sat under the 1px border and was nearly impossible to hit.
- **One switch, and it is in the session header.** A 24×24 glyph (monitor screen
  plus a trace) sits in the header's `utilities` run, the right-aligned group whose
  slot contract calls it "session utilities in ascending order". After that run
  comes the corner seat the sidebar-right package took for its expand button, and
  after that the native window buttons — which are drawn by Electron's
  `titleBarOverlay` and are not elements in the document, so no renderer-side
  plugin can get between them. `utilities` is the closest seat that exists.
- **The column has no header of its own.** Its top row of cards starts flush at the
  top: a title saying "monitor" over the monitor, in a 220px column, costs a card's
  height to state the obvious, and closing does not need a control in there when
  the switch is already in the session header. Turning `monitorColumn` off leaves
  no panel at all — there is no second layout behind this one.

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

   **The language comes from what the user wrote.** The instruction asks for the
   summary in the language of *the user's own words*, not the assistant's prose
   and not the commands — a Chinese speaker working with an English-speaking
   model still wants a Chinese summary, and tool output is English regardless of
   who is reading. The transcript therefore carries the question itself: the
   prompt body opens with `What the user asked:` (see `renderPromptBody`), which
   is also the only line in there that says what the turn was *for* rather than
   what it produced. The block is omitted entirely when the ask is empty — an
   empty `What the user asked:` reads as "they said nothing", which is an
   assertion, not an absence.

   Nothing about the reader's interface language is sent. There used to be a
   `?lang=` parameter fed from `document.documentElement.lang`, with a
   closed table of eleven language names, a script split for `zh`, and a cache
   key built from the rendered sentence. All of it is gone, and it should not be
   reintroduced: the interface language is what a reader *reads*, while the
   summary has to match what they *wrote*, and those differ often enough to
   matter. Keeping the language out of the prompt also means the language never
   enters the cache key, so a warm-up started at turn end and a later panel
   request compute the same key without needing to agree on anything.

   **The result is written down.** A summary is the one thing here that costs
   money, and it used to live only in the summariser's memory: every host
   restart bought the same turn again, 2.8 seconds a time. It is now stored in
   the session's own document beside the skills and the file list
   (`summary: { key, text, at, model, routeKey }`), read back on the next
   process, and reused when the key matches. The key carries the turn number and
   a hash of the prompt body, so "the same key" means "the same question" — a new
   turn, or the same turn with a different transcript, is a miss. `routeKey` is
   what makes a model switch invalidate it, and **two absent route keys count as
   a match**: a plugin that never pinned `summaryProvider`/`summaryModel` resolves
   its route per session and may honestly have nothing to compare, and refusing
   those would take the stored text away from exactly the people who paid for it.

   Only the most recent summary is kept, because only the most recent turn is
   ever asked about — `readPanel` renders `previous`. Going back to an older turn
   of a session still costs a model call; what this fixes is one specific bill,
   the same turn being bought again after a restart. A failure to write is logged
   and nothing else: the text is already in memory and already paid for, so an
   unwritable disk must not turn a served answer into a failed one.

   Facts can arrive **after** the conversation they describe has been deleted.
   The summary is the clearest case — the pre-warm is not awaited and the model
   call may take twenty seconds, long enough for the host to archive the session
   and for a sweep to remove its file — but it is not the only one: a git reading
   and a directory scan are not awaited either. So the refusal lives in `entry()`,
   the one funnel every writer goes through, rather than in the one writer that
   was noticed first.

   The question that funnel asks is not "is this id still valid" but "does the
   record I am about to overwrite hold anything worth keeping". That is the same
   question `document()`, `flush()` and `dropIfOrphan()` already ask, and it is
   the one that survives the awkward case: a file written by a different build,
   or one whose body we cannot parse, still produces a record — an empty one —
   and an empty record must not be read as permission to replace somebody else's
   file. The mirror image is also true: a record that *does* hold facts proves
   the conversation was alive recently, so a write carrying new facts is allowed
   even while the verdict stands.

   Facts in memory, though, cannot tell you what is on the disk now. A file the
   other process wrote can be swept away again after we read it, and then our
   late write would rebuild it out of our half of the story alone. So before a
   dropped-id write is flushed, the file itself is inspected one more time, and
   an absent file ends the write. Only that verdict stops it: a file that is
   still there, or one we cannot read, is not ours to decide about.

   That last clause is the whole difficulty, and getting it wrong was a bug in
   two directions. The verdict has to be lifted *while a turn is running*, not
   when it ends: skills and MCP calls are written during the turn, so a resumed
   conversation used to lose every one of them to a verdict that would not be
   lifted until the turn was already over. And "lifted" cannot mean "any write
   from a live session" — the late git and scan callbacks are live too, they
   just belong to a turn that has ended.

   What separates the two is not a moment but a source. A skill load and an MCP
   call are the host saying "this conversation is running right now"; a late
   summary, a late git reading and a late scan are continuations this process
   scheduled itself, and a continuation has no claim to being current. So the
   lift is attached to those two host-dispatched events, which also covers the
   case that first broke it: a host may hand the plugin a conversation whose
   turn is *already* running, and then there is no `turn/start` to lift
   anything. `turn/start` is still there as a backstop for a future writer that
   arrives mid-turn by some other route — it is not what makes the current ones
   work, and a mutation that deletes it survives, which is why it is described
   here as a backstop rather than counted as covered.

   The merge that runs when an event arrives before the first read used to carry
   the file's skills, files and snapshot into memory but not its `summary` or its
   `sweep` — so the *first write after a restart* erased what the previous
   process had paid for and what it had been able to see. Both are carried now,
   but they do not share a rule. A summary is replaced whole and has no ordering,
   so memory wins when it has one. A sweep counts turns, so the newer claim wins
   whichever side it came from — and when both sides claim the same turn, neither
   gets to decide: the merge keeps whichever coverage saw less, because a turn
   corrected in two places is a turn we are less sure about, not more.
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
3. **Produced files.** The work of the **whole session**, in the order the
   conversation edited it, most recent first, with each file's size on the right.
   This is the one of the three that used to
   describe a single turn: the list came from the turn that had just ended, so a
   quiet turn emptied the card and re-editing one file hid the other nineteen.
   The list now lives in the stored session state (`paths`, a `Map` from file to
   the same `sequence` tick the skills and MCP rows use), survives restarts, and
   is capped at 200 entries — the transcript caps a turn at 40, this is per
   session, so it is larger, but it is still capped because every panel read is
   one `fs.stat` per entry — and that read now happens on every pushed frame, not
   only on a clock.

   The cap has to hold on three paths, not one: `rememberPaths`, the merge in
   `load` (a process that records a path before its first read would otherwise
   keep the file's list *and* its own, and the next shutdown would write the sum
   back), and `readState` (a file written by a build without the cap must shrink
   on the way in). An interrupted turn counts too, and its paths are read
   **before** `transcripts.record()` folds the turn — reading `previous` after
   the record returns the turn before it, because an abandoned turn is not
   folded into `previous` at all.

   **Order comes from the source, not from the filesystem.** The card is titled
   after what this conversation produced, so its order is "most recently edited
   by this session first" — the session state's tick, reversed. `fs.stat`'s
   `mtimeMs` still travels with each row but decides nothing: a build step, a
   `touch`, or another tool rewriting a file would hoist it to the top of a list
   that is supposed to describe the conversation. The fallback source needs one
   adjustment: `filesSeen` walks the path map backwards and is already newest
   first, while `previous.paths` is appended in call order (oldest first), so
   `newestFirstOf(paths, false)` reverses exactly that one.

   **Two lists in one: this turn, then everything before it.** Recency alone
   answers "what has this conversation worked on", but the question a reader
   actually asks at the end of a reply is narrower — "what did *this* one touch".
   So every row carries a `turn` flag, and the folded card draws the this-turn
   files first, then fills the remaining rows from the earlier ones. The Host
   computes the flag, not the Client, because the two lists live on different
   sides: the card's rows come from the session's accumulated path map (which
   outlives the turn), while the turn's own paths are on the transcript. Only the
   Host holds both, and only the Host knows the session `cwd` — without which a
   relative path in `previous.paths` compares unequal to the absolute path in the
   map and every file reads as "not touched this turn".

   **Four rows, and the way out is not inside the list.** `FOLDED_FILES = 4`,
   matching the Host's own changed-files card. The control that reveals the rest
   is the *same round badge* the 上一轮 card already draws, in the same place and
   the same size — two cards in one column should not teach the reader two shapes
   for one gesture. It is nonetheless a real `<button>` here, while the 上一轮
   card's badge is decoration: that card lets the whole card take the click, so
   its badge is a `role="img"` div with `pointer-events: none`; this card cannot
   copy that, because every row in it is already a button and a card that
   answered clicks too would swallow the row presses. So `Card` takes an optional
   `badgeAction` and the badge becomes the control itself, with its own focus
   ring, its own `aria-expanded` and a chevron that turns over when it opens.
   Both shapes are still `.dsse-expand`, so the geometry stays in one rule —
   including `box-sizing: border-box`, without which a `div` and a `button`
   render the same declaration two pixels apart.

   Because the badge is pinned to the card rather than laid out in the list, it
   cannot be clipped with the list it reveals — which is how "5 of 10" became
   "only 5" (`DEF-51`). Opening the card gives the list
   `max-height: FILE_LIST_MAX_PX` and `overflow-y: auto`, so expanding it never
   pushes the other two cards out of view. Only a card that actually draws a badge
   reserves the strip for it (`data-badge`), so a card that fits keeps its own
   padding. The header stops repeating the total once the list is showing it.

   Once open, the list is three groups rather than one: this turn, 更早, and
   生成文件, each with its own small heading and none drawn when empty. The
   headings only appear where there is something to contrast — a first reply that
   touched everything has no "更早" group to label.

   **Generated files are folded away, not deleted.** `node_modules/`, `dist/`,
   `build/`, the lockfiles, the minified bundles and source maps are things the
   session touched without anyone deciding to write them; a card whose first four
   rows are `node_modules` entries describes the build, not the work. So
   `isNoisePath` classifies each path on the Host and the folded card draws only
   the human files, with the header saying how many were set aside
   (`5 个文件 · 1 个生成`) and a 生成文件 group waiting inside.

   Two properties keep that from turning into the `DEF-51` mistake in reverse.
   The badge appears whenever *anything* is hidden — including the case where the
   only files are generated ones, `ordered.length > people.length` — because a
   filter with no way out is a deletion. And the classifier is deliberately
   conservative: it matches whole path segments and whole file names, never
   substrings, and it only looks at the path *inside* the session's `cwd`. A
   workspace that itself lives under `build/` would otherwise have every one of
   its files classified as generated (`DEF-70`), which is why the prefix is
   stripped first — case-insensitively and on the same folded string the slicing
   uses, since `cwd` and a tool's path argument are not normalised to one another
   (`DEF-71`, `DEF-72`).

   **A row opens the file in the right sidebar.** The panel asks for
   `sidebarRight` through `ctx.inject(["sidebarRight"], ...)` — an *optional*
   injection, not an entry in `module.exports.inject`, because a declared-but-
   missing service makes the whole plugin refuse to load on a Host without a
   right sidebar. When it is there, `openResource` is published to a module-level
   `openResource` and each row becomes a `<button>`; when it is not, the row is a
   plain `<div>` with no handler at all rather than a control that does nothing.
   The address is built on the Host side (`resourceAddress`) from the session's
   `cwd` and the absolute path, in the form `dsh-resource://file/session/<id>/
   <relative path>` — the same five branches as the Host's own `fileAddressFor`.
   A click is wrapped in `try/catch`: `openResource` throws while no session is
   adopted, which is normal in the instant between sessions, and a failed preview
   must not take the whole rail down with it.

   The row beside the "Last turn" title still describes **one** turn, so its
   file count comes from `turnFiles`, not from the length of this list. Three
   numbers sitting together read as one set; one of them describing the whole
   session while the other two describe the last turn is a thing the reader has
   no way to notice.

Reading the panel may touch the disk: `GET /panel` falls back to the stored
session state when this process holds nothing for that conversation yet, so the
first open after a restart answers from the file rather than from an empty
transcript. The read is per conversation and happens once — the loaded document
is installed into the in-memory store, so a polled panel does not re-read.

The panel can write, but only through the routes that already had a gate behind
them. It calls `GET /api/ui-evolve/panel?agent=<id>` to read the
three modules — that is the whole query string; there is no language parameter
because the summary's language comes from the user's own words rather than from
the interface —
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

The header row is ordered **review, speed, refresh, settings**, reading from what
you look at to what you press. The review entry is labelled with the word 建议
rather than an icon, and it carries the pending count as a badge; it is the only
way into the queue from the panel, so a session whose cards are all empty but
whose queue holds work still draws the header. Its accessible name starts with the
visible word (`建议 候选审核`), because a name that replaces the label rather than
containing it fails WCAG's label-in-name rule. The whole row sits on its own card
surface — border, radius, background — instead of bare buttons floating over the
conversation, and in the monitor column it sticks to the top: a column that is
always on screen should not scroll its controls away with the cards.

Between settings and review sits the **output-speed readout**. It answers one
question at a time and always answers it about something the reader just watched.
While text is arriving it shows the last two seconds — "how fast is this going
right now". Once the reply stops, the same badge becomes **the rate of the whole
reply that just finished**, labelled 上一轮, and stays there until the next turn
starts. Nothing is averaged across earlier messages: a reader who just watched one
answer wants that answer's number, and a mean over five replies describes a
history they did not read. It also differs from the host's own capsule, which
averages the whole conversation: by the twentieth turn that mostly describes the
first nineteen.

It reads from the `speed` route, which is a route of its own rather than a field on
`/panel`: the panel changes at turn boundaries, the speed changes while a turn
is running, and one refresh cadence cannot serve both. Nothing in the event stream
carries a token count during generation — the `usage` block arrives once, after
`message_stop` — so the live number is `ceil(characters / 4)` per `text-delta` over
a two-second window, rescaled by a ratio learned from the provider's real count
each time a message settles. The ratio is clamped to 0.25..4, because one odd turn
should not redefine every number after it. Text only: `reasoningTokens` are
subtracted and a message that called a tool teaches no ratio at all — its
`argumentsDelta` counts toward `outputTokens` but never flowed as text. The divisor
is floored at 500ms, because the first delta of a reply arrives with almost no
elapsed time and dividing by it would print three hundred tokens a second at
exactly the moment somebody looks.

**How the badge learns that something happened.** Polling on a fixed clock was the
first version, and it failed for a reason worth writing down: a reply takes three to
eight seconds, an idle timer fires every ten, so the badge was usually asked after
the thing it measures had already ended. A readout that only exists while a reply is
arriving is one nobody can find. The route therefore takes an `after=<revision>`
parameter and **holds the request open** until the meter moves or twenty-five
seconds pass — one request instead of thirty, and the answer arrives when the fact
does, not up to a period later. The revision moves on the first `text-delta` and
again when the message settles, so the wait ends at both ends of a reply. The
client's first request carries no `after` and comes back immediately, so the badge
draws on the first frame; every later one carries the revision it last saw. While
the window still holds text the client polls at 250ms instead, because there the
answer is changing faster than any hold could report it.

**What decides the next delay is the last answer's duration, not a constant.** Every
scheduling call happens after the response has arrived, so a number chosen there is
not a margin around the server's deadline — it is dead time in which nothing is
listening. A reply that lands in that gap is one the badge never sees, which is the
original symptom. So the client times each request: one that took about the full
window really was held, meaning this host honours `after`, and the next request goes
out at once so the next change is caught the instant it happens. One that came back
instantly was answered without waiting, and asking again at once would spin — that
host gets the idle spacing. A failed request retries after ten seconds: a missing
route or a restarting host is worth knocking on again, but not at either of the other
two rates.

The number is held for four seconds past the end of the window before the reply's
own rate replaces it, because the moment a person most wants to read the speed is
the moment the text stops. That repaint is armed for every reading, live ones
included: a reply goes quiet between paragraphs and while a tool call is being
assembled, and with a held request the next answer can be half a minute away, so
without it the last live number would sit there in the live style long after it
stopped being true. That rate is drawn in a slightly quieter style, so it
reads as a description of the reply rather than of this instant. A dash appears only
when no message has ever settled: a zero is a measurement, and the honest statement
about a session that has produced nothing yet is that there is no number. The badge
stays in the header for the life of the session. Only a host that has never once
answered draws nothing: no `/speed` route at all, a first request that failed, or a
`200` carrying `ok: false` because that host cannot measure. Switching conversations
keeps the badge — whether a host can measure is a fact about the host — but clears
the number, and aborts the request still in flight so an abandoned conversation
does not keep a connection open until the hold expires. It is deliberately not a
`role="status"`: a value that changes four times a second would be read aloud over
the answer itself, so it is `aria-live="off"` with the number in `aria-label` for
anyone who wants it.

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
it reveals a round badge on the card's bottom edge, centred, with a chevron
pointing down, and clicking anywhere on the card opens it until it is clicked
again. Once open the badge stays put, whatever the pointer is doing, and points up
(`点击收起全文`): closing has to remain reachable at the moment the reader is
looking for it. The hint is not a button of its own: it is a `div` with
`pointer-events: none`, so a click on the hint is a click on the card beneath it,
and the whole card is the target. Making it a real button would have meant a
second thing to focus, a second click handler, and a second accessible name for
what is really just a line of text explaining the card.

The badge is positioned against the card (`position: absolute` inside a
`position: relative` card) rather than laid out under the summary, so revealing it
on hover costs no layout at all — the card does not grow, and the text below it in
the column does not move. The one case that reserves room is the open card:
`.dsse-card-body` gets `padding-bottom: 44px`, which clears the 26px badge and its
8px offset with 10px to spare. That height was already changing when the card
opened, so it adds no new class of jitter. Floating the badge over the text without
reserving anything was the alternative, and it hides the last line of the summary
the click was for.

There is no `title` on the badge. It has `pointer-events: none`, so it is never a
hit target and a native tooltip could not appear on it; `aria-label` carries the
same words for anyone reading the card with a screen reader.

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
panel opens, on every frame the stream pushes, and on a 60-second timer behind
those. A failed background refresh keeps the last good cards visible beside the
error instead of replacing them with an empty panel — and a *manual* refresh keeps
them too: the loading state belongs to a session whose answer has never arrived,
not to a reload of an answer already on screen. Dropping the payload there emptied
the whole rail for the length of the request, and an open settings dialog went with
it. The rail still uses measured geometry: `measure()` falls back to the documented
clamp formula when the host does not publish a width, and the placement function
reports `no-room` rather than overlapping the text. On a narrow window the cards
disappear and the handle remains, because a panel that cannot fit should not
squeeze the thing it is annotating.

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

**How it learns: a pushed stream, with a slow timer behind it.** The client holds
one `EventSource` open on `GET /api/ui-evolve/events?agent=…` and calls
`GET /api/ui-evolve/panel` whenever a frame arrives (`D-216`). A frame carries an
agent id and a counter and nothing else — it says only *that* this conversation may
have changed — so `/panel` is still the single place that decides what the panel
looks like. `REFRESH_MS` in `lib/client.js` is 60 seconds and is a
floor, not the mechanism: it covers three things no event in this process can
report — the pending-candidate count (read from a **global** queue that another
session's detector writes), touched-file sizes (a `stat` taken at read time, so a
file changed by another process produces no event at all), and the skill
*catalog* — a skill appearing, disappearing or being shadowed on disk. A skill
being **used** is a session event and does push; what the timer covers is the
registry those uses are described against.

An earlier stream is worth knowing about (`D-70` → `D-73` → `D-74`). It reported
the same thing and was removed: back then it *was* the fast path, so the only
channel that saw those three things had to be slowed from 8 seconds to 60, and
nothing else got faster to make up for it — a narrower view of the world, not a
fresher one.

The trade here has the same shape, and it is worth stating rather than hiding:
those three blind spots are still on a 60-second timer, so a change to the global
candidate queue can now take up to a minute to appear where it used to take eight
seconds. What the stream buys is the session-driven changes — a turn starting or
ending, a skill use, an MCP call, a summary landing — which now arrive within a
round trip instead of within eight seconds. The interval could have stayed at 8
seconds and the blind spots would have kept their old latency for free; it did not
because paying a request every 8 seconds forever to catch something rare is the
cost this whole change exists to remove. `D-219` records why this is not a re-run
of that decision.
