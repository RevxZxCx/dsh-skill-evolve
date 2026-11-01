# @revxz/dsh-ui-evolve

A DeepSeek Harness plugin that puts three cards in the empty space beside the
conversation, showing what the turn you just finished actually did: a summary of
the previous turn, the skills and MCP tools it touched, and the files it changed.

It is the presentation half of the `dsh-evolve` suite. It reads the session and
never writes to the skill directory; when the skill half is installed it also
offers a **Suggest** button that opens the candidate queue, because
`@revxz/dsh-skill-evolve` publishes that queue as a service and this package only
consumes it. Without that service the button is absent, not broken.

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
`/api/ui-evolve`: `GET /panel`, `GET /models`, `GET|POST /config`,
`GET|POST /candidates`, `POST /propose`.

The browser side and the host side cannot share a constant — `lib/client.js` is a
hand-written bundle with no `import` and no build step — so the prefix appears as a
literal in both files. `test/route-prefix.test.mjs` is what keeps them equal, and it
exists because a mismatch is the quietest failure this plugin can have: the client
mounts, renders, and gets a 404 on every request, which looks exactly like a session
with nothing to show.

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
   that gesture is not a load and is not listed. Each row that looks like a
   reusable procedure has a **propose** action: it opens a new conversation
   pre-filled with the steps, so the skill is drafted with a full context rather
   than from a one-line prompt.
3. **Produced files.** Files this conversation wrote, newest first, with the
   added and removed line counts. Sourced from the same turn transcript the
   other two modules read, so all three agree on which turn they describe.

The panel can write, but only through the routes that already had a gate behind
them. It calls `GET /api/skill-evolve/panel` to read the three modules,
`GET /api/skill-evolve/candidates` to read the queue, `POST /config` for its own
switches, `POST /propose` to open a draft conversation, and
`POST /candidates` to approve or discard one candidate. That last route does not
implement approval: it calls the same `approve()` the `/skill-capture` command
calls, so the evidence gate and the confirm handshake are not re-implemented
behind a second entrance. A route that wrote the skill file itself would be a way
in that skips both.

### Candidate review and panel settings

The three cards stay visible together: **Last turn**, **Skills and MCP**, and
**Produced files**. A card with no content is hidden rather than drawn empty, and
if none of the three has anything to say the rail hides entirely — header row
included, because an empty panel with buttons on it still looks like a panel.
Skills and MCP servers share one list ordered by most recent use on a single
recency clock, with a different icon per type.

The header row is ordered **refresh, settings, review**. The review entry is
labelled with the word 建议 rather than an icon, and it carries the pending count
as a badge; it is the only way into the queue from the panel, so a session whose
cards are all empty but whose queue holds work still draws the header. Its
accessible name starts with the visible word (`建议 候选审核`), because a name that
replaces the label rather than containing it fails WCAG's label-in-name rule. The
whole row sits on its own card surface — border, radius, background — instead of
three bare buttons floating over the conversation.

The last-turn card carries its counts in the header, not in a strip below the
text: calls, commands, and files as labelled numbers, with **propose** as a small
button beside them. That button writes a hint into this conversation; it does not
create anything. The summary below it is capped at 5.2em and fades out when — and
only when — there is more text than the cap shows.

The fade is measured, not assumed. A `Clip` component compares `scrollHeight`
against `clientHeight` in a layout effect and sets `data-clipped` on the result;
the stylesheet draws the gradient only for `data-clipped="true"`. Two things go
wrong when the flag is hard-coded instead: a one-line summary shorter than the
34px mask gets washed out by a fade covering text that was never truncated, and a
long summary is cut with no indication that anything follows. A layout effect
rather than a passive one, because a passive effect runs after the browser has
painted — every first render would show one frame with clipped text and no fade.

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
route. The client holds no copy of the transcript and re-reads `/panel` on open and
on a timer, so the three modules always describe the same turn. A failed background
refresh keeps the last good cards visible beside the error instead of replacing
them with an empty panel — and a *manual* refresh keeps them too: the loading state
belongs to a session whose answer has never arrived, not to a reload of an answer
already on screen. Dropping the payload there emptied the whole rail for the length
of the request, and an open settings dialog went with it. The rail still uses measured geometry: `measure()` falls
back to the documented clamp formula when the host does not publish a width, and
the placement function reports `no-room` rather than overlapping the text. On a
narrow window the cards disappear and the handle remains, because a panel that
cannot fit should not squeeze the thing it is annotating.
