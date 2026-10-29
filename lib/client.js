window.__ModuleLoader__.load({
  id: "dsh-skill-evolve",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require("react")
    const { jsx, jsxs } = require("react/jsx-runtime")

    /**
     * Client half of dsh-skill-evolve.
     *
     * Draws a column of small cards beside the conversation: what the last turn
     * produced, what skills and MCP servers are on offer, and which files that
     * turn touched.
     *
     * ## Why floating cards rather than a docked column
     *
     * The host publishes no slot that is a *column inside the conversation
     * region*. `conversation.content` is a single-occupancy factory — taking it
     * would replace the host's own conversation body. Everything else in the
     * conversation is a row or a corner.
     *
     * The first version docked to the window's right edge and reserved width by
     * padding `[data-conversation-content]`. That was rejected on sight: it
     * pushed the tab strip, cost layout the host owns, and read as a drawer laid
     * over the app rather than as part of the conversation.
     *
     * What the host *does* leave is empty space. The prose is centred and capped
     * (`--dsh-chat-content-width: clamp(680px, column × 0.64, 920px)`), so on any
     * reasonably wide window there are a few hundred pixels of nothing on each
     * side. Cards live there, absolutely positioned inside `shell.overlay`, which
     * is `position:absolute; inset:0; pointer-events:none` — it takes no layout
     * at all. Nothing about the host's own arrangement changes.
     *
     * The geometry lives in `gutter.js` so it can be tested without a browser.
     *
     * ## Why one side, not both
     *
     * Two columns of small text flanking the prose compete with the prose. The
     * cards are meant to be glanced at. Which side is a setting.
     *
     * ## What it may require
     *
     * Only the baseline the shared module table carries: `react` and
     * `react/jsx-runtime`. A bundle that reaches for anything else fails to
     * materialise, and the failure surfaces as a broken entry on the Plugins
     * page rather than as a blank panel.
     */

    const NS = "dsh-skill-evolve"
    const PANEL_ID = "dsh-skill-evolve:cards"
    const TOGGLE_ID = "dsh-skill-evolve:toggle"
    const REFRESH_MS = 8000
    const CARD_WIDTH = 288

    /**
     * Resolve a plugin route against the page's own base.
     *
     * The GUI can be mounted under a path prefix, so `/api/...` is not
     * necessarily rooted at the origin. `document.baseURI` is the host's own
     * answer to "where am I served from", which is why the round-trip below
     * strips the leading slash before resolving: `new URL("/api", base)` would
     * throw the prefix away, `new URL("api", base)` keeps it.
     *
     * @param {string} path - an absolute-looking route, e.g. `/api/skill-evolve/panel`.
     * @returns {string} a URL usable from this page.
     */
    function resolveUrl(path) {
      if (typeof document === "undefined") return path
      const base = document.baseURI
      if (typeof base !== "string" || base === "") return path
      try {
        return new URL(path.replace(/^\/+/, ""), base).href
      } catch {
        return path
      }
    }

    /**
     * Unwrap the plugin's response envelope.
     *
     * The handler answers `{ ok: true, data }` or `{ ok: false, code, error }`,
     * and answers 200 even for a failure it produced itself (the route was
     * reached, the work failed). Both layers are checked here so a caller only
     * ever sees data or an exception.
     *
     * @param {Response} response - the fetch result.
     * @returns {Promise<any>} the payload inside the envelope.
     */
    async function unwrap(response) {
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`the panel endpoint answered ${response.status} without JSON`)
      }
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error ?? `the panel endpoint answered ${response.status}`)
      }
      return body?.data
    }

    /**
     * Call one of the plugin's routes.
     *
     * @param {string} path - the route below `/api/skill-evolve`.
     * @param {object} [options] - fetch options.
     * @returns {Promise<any>} the payload.
     */
    async function call(path, options) {
      const response = await fetch(resolveUrl(`/api/skill-evolve${path}`), {
        credentials: "same-origin",
        ...options,
      })
      return unwrap(response)
    }

    /**
     * Format a byte count for a file row.
     *
     * @param {number} bytes - the size.
     * @returns {string} e.g. `1.2 kB`.
     */
    function formatBytes(bytes) {
      if (typeof bytes !== "number" || Number.isFinite(bytes) === false) return ""
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * Split a path into the name to show and the directory that disambiguates it.
     *
     * Two files called `index.js` from different folders must not look identical,
     * so the tail of the directory travels with the name.
     *
     * @param {string} path - an absolute path.
     * @returns {{ name: string, where: string }} the two halves.
     */
    function splitPath(path) {
      if (typeof path !== "string" || path.length === 0) return { name: "", where: "" }
      const parts = path.split(/[\\/]/).filter((part) => part.length > 0)
      if (parts.length === 0) return { name: path, where: "" }
      const name = parts[parts.length - 1]
      const where = parts.slice(Math.max(0, parts.length - 3), parts.length - 1).join("/")
      return { name, where }
    }

    const CSS = `
.dsse-toggle{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.12));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:500 12px/1 inherit;cursor:pointer;white-space:nowrap}
.dsse-toggle:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-toggle[data-active="true"]{background:var(--dsw-alias-bg-brand,rgba(77,107,254,.12));border-color:var(--dsw-alias-border-brand,rgba(77,107,254,.5));color:var(--dsw-alias-label-brand,#2f4bd8)}
.dsse-toggle-count{display:inline-block;min-width:15px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-bg-brand,rgba(77,107,254,.16));color:var(--dsw-alias-label-brand,#2f4bd8);font:600 10px/15px inherit;text-align:center}
.dsse-rail{position:absolute;display:flex;flex-direction:column;gap:10px;overflow-y:auto;overflow-x:hidden;padding:0 1px 0 0;scrollbar-width:thin;font:400 12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#0f1115)}
.dsse-rail::-webkit-scrollbar{width:6px}
.dsse-rail::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-secondary,rgba(15,17,21,.16));border-radius:3px}
.dsse-card{flex:0 0 auto;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.1));border-radius:10px;box-shadow:0 1px 2px rgba(15,17,21,.05),0 4px 14px rgba(15,17,21,.05);overflow:hidden}
.dsse-card-head{display:flex;align-items:center;gap:6px;padding:8px 10px 7px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.07))}
.dsse-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-brand,#3b6cf6)}
.dsse-dot[data-tone="ok"]{background:#1a7f4b}
.dsse-dot[data-tone="warn"]{background:#9a6400}
.dsse-card-title{font:600 12px/1.2 inherit}
.dsse-card-meta{margin-left:auto;font:500 10px/1.2 inherit;color:var(--dsw-alias-label-tertiary,#8b92a1);white-space:nowrap}
.dsse-card-body{padding:8px 10px 10px}
.dsse-text{margin:0;white-space:pre-wrap;word-break:break-word}
.dsse-muted{color:var(--dsw-alias-label-secondary,#5b6270)}
.dsse-tiny{font-size:11px;line-height:1.45}
.dsse-kv{display:flex;gap:6px;margin:0 0 3px;font-size:11px}
.dsse-kv b{flex:0 0 34px;font-weight:500;color:var(--dsw-alias-label-tertiary,#8b92a1)}
.dsse-kv span{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#5b6270)}
.dsse-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.dsse-chip{font:400 10px/1.5 ui-monospace,Consolas,monospace;padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,#f2f4f8);color:var(--dsw-alias-label-secondary,#5b6270);border:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.06))}
.dsse-row{display:flex;align-items:baseline;gap:6px;padding:3px 0;border-bottom:1px dashed rgba(15,17,21,.06)}
.dsse-row:last-child{border-bottom:0}
.dsse-row-main{flex:1;min-width:0}
.dsse-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 11px/1.45 ui-monospace,Consolas,monospace}
.dsse-where{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary,#8b92a1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsse-size{font:500 10px/1.4 inherit;color:var(--dsw-alias-label-tertiary,#8b92a1);white-space:nowrap}
.dsse-add{color:#1a7f4b;font:500 10px/1.4 inherit}
.dsse-del{color:#b4232c;font:500 10px/1.4 inherit}
.dsse-badge{display:inline-block;padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,#f2f4f8);color:var(--dsw-alias-label-secondary,#5b6270);font:500 10px/15px inherit}
.dsse-badge-own{background:var(--dsw-alias-bg-brand,rgba(77,107,254,.14));color:var(--dsw-alias-label-brand,#2f4bd8)}
.dsse-btn{border:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);border-radius:6px;padding:2px 7px;font:500 10px/1.5 inherit;cursor:pointer;white-space:nowrap}
.dsse-btn:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-btn:disabled{opacity:.5;cursor:default}
.dsse-tip-anchor{display:inline-flex;flex:0 0 auto}
/* border-box so the 230px below is the OUTER width: the clamp arithmetic uses
   that number as the space the bubble occupies, and without this the 16px of
   padding plus the 1px border made the rendered bubble 18px wider than the
   space reserved for it, pushing it past the right edge it was clamped to. */
.dsse-tip{position:fixed;z-index:40;box-sizing:border-box;max-width:230px;padding:6px 8px;border-radius:7px;
background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);
border:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.14));
box-shadow:0 2px 6px rgba(15,17,21,.08),0 8px 22px rgba(15,17,21,.10);
font:400 10.5px/1.5 inherit;pointer-events:none;white-space:normal;word-break:break-word}
.dsse-more{border:0;background:transparent;color:var(--dsw-alias-label-brand,#2f4bd8);font:500 10px/1.5 inherit;cursor:pointer;padding:3px 0}
.dsse-err{margin:0 0 6px;padding:6px 8px;border-radius:7px;background:rgba(214,58,58,.09);color:#c02b2b;word-break:break-word;font-size:11px}
.dsse-label{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5b6270);margin-top:5px}
.dsse-check{accent-color:var(--dsw-alias-label-brand,#2f4bd8);margin:0}
.dsse-select{max-width:100%;border:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.12));border-radius:5px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:400 10.5px/1.4 inherit;padding:1px 3px}
.dsse-handle{position:absolute;width:16px;height:54px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-tertiary,#8b92a1);font:400 10px/1 inherit;padding:0;box-shadow:0 1px 4px rgba(15,17,21,.07)}
.dsse-handle[data-side="left"]{border-radius:0 7px 7px 0;border-left:0}
.dsse-handle[data-side="right"]{border-radius:7px 0 0 7px;border-right:0}
.dsse-handle:hover{color:var(--dsw-alias-label-brand,#2f4bd8);border-color:var(--dsw-alias-border-brand,rgba(77,107,254,.5))}
.dsse-fold{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b92a1);cursor:pointer;font:400 13px/1 inherit;padding:1px 3px;border-radius:4px}
.dsse-fold:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-primary,#0f1115)}
`

    /** Inject the stylesheet once per page, not once per render. */
    function ensureStyle() {
      if (typeof document === "undefined") return
      if (document.getElementById(`${NS}:style`) !== null) return
      const node = document.createElement("style")
      node.id = `${NS}:style`
      node.textContent = CSS
      document.head.appendChild(node)
    }

    /**
     * Which session the cards are describing.
     *
     * The toggle sits in a session-scoped slot and therefore knows the session
     * id, while the card column is mounted in a root-scope overlay and does not.
     * This module-level value bridges the two: the toggle publishes, the column
     * subscribes. It is a plain variable rather than state because the column
     * re-reads it on every fetch, and a stale id would only cost one discarded
     * response.
     */
    const bridge = { sessionId: "", open: false, side: "left", collapsed: false, listeners: new Set() }

    /**
     * Publish a change to everything drawing the cards.
     *
     * @param {() => void} listener - a subscriber.
     * @returns {() => void} the unsubscribe function.
     */
    function subscribe(listener) {
      bridge.listeners.add(listener)
      return () => bridge.listeners.delete(listener)
    }

    /** Notify subscribers that the panel state moved. */
    function notify() {
      for (const listener of bridge.listeners) listener()
    }

    // <gutter>
    // Generated from lib/gutter.js by scripts/sync-gutter.mjs. Do not edit here:
    // edit the module, re-run the sync, and the drift test will confirm the two
    // agree. The bundle cannot import because it is a browser script.
    /** Narrowest column worth drawing. Below this the text wraps to unreadable. */
    const MIN_CARD_WIDTH = 168

    /** Widest column. Wider than this and it stops reading as a sidebar. */
    const MAX_CARD_WIDTH = 300

    /** Space kept between the prose and the cards, and between cards and the edge. */
    const CARD_GAP = 16

    /** Space kept above the cards, so they never touch the tab strip. */
    const TOP_INSET = 12

    /** Space kept below the cards, so they never sit on the composer. */
    const BOTTOM_INSET = 12

    /**
     * Width of the collapsed handle, matching `.dsse-handle` in the bundle.
     *
     * It has its own placement rule rather than reusing the cards' edge, because it
     * is wider than the gap between the cards and the prose: anchored on the cards'
     * edge it would either land on the text (left side) or float in the middle of
     * nothing (right side). Anchored to the prose it reads as a tab attached to the
     * card and can never cover a word.
     *
     * Kept equal to the CSS width: the number is used for geometry, so a drift here
     * is a visible misalignment that no other assertion would catch.
     */
    const HANDLE_WIDTH = 16

    /**
     * Width the hover bubble declares for itself, matching `.dsse-tip` in the bundle.
     *
     * Declared rather than measured because a bubble is repositioned every time its
     * trigger is hovered, and reading its own rect at that moment gives the previous
     * bubble's size. Same reason the rule below says the declared width has to be the
     * *outer* width: the bundle sets `box-sizing:border-box` so 230 includes the
     * padding and border.
     */
    const TIP_WIDTH = 230

    /** Space kept between the bubble and any edge of the viewport. */
    const TIP_MARGIN = 8

    /** Gap between the bubble and the trigger it describes. */
    const TIP_OFFSET = 4

    /**
     * Height reserved for the bubble when deciding whether it fits below its trigger.
     *
     * The bubble's real height depends on how its text wraps, which cannot be known
     * before layout, so it is reserved instead of measured — the same trade the width
     * makes. This is an *upper bound* for the strings this plugin actually writes, and
     * `test/client.test.mjs` asserts every call site stays under it, so the assumption
     * is checked rather than hoped for. Over-reserving only means a bubble flips above
     * its trigger slightly sooner than strictly necessary, which costs nothing.
     */
    const TIP_HEIGHT = 160

    /**
     * A rect is only usable when all four edges are real numbers.
     *
     * The alternative — defaulting a missing edge — reads well and is wrong: `right`
     * missing means the measurement failed, not that the box is zero-wide, and the
     * two callers below used to fill that gap differently (`gutters` fell back to
     * `left`, `placeCards` to `0`). The result was a card that the gutter arithmetic
     * believed had 1420px of room on the right and that the placement arithmetic put
     * at x=16 — a card on the wrong side of the window, which is exactly the class of
     * bug this module exists to prevent. One rule, checked once.
     *
     * @param {unknown} rect - the candidate.
     * @param {string[]} edges - which edges this caller actually needs.
     * @returns {boolean} whether every required edge is a finite number.
     */
    function usableRect(rect, edges) {
      if (rect === null || typeof rect !== 'object') return false
      return edges.every((edge) => Number.isFinite(rect[edge]))
    }

    /** The horizontal pair, which is all a gutter measurement needs. */
    const HORIZONTAL = ['left', 'right']

    /** All four edges, which is what a placement needs. */
    const ALL_EDGES = ['left', 'right', 'top', 'bottom']

    const floorTo = (value) => (Number.isFinite(value) ? Math.floor(value) : value)
    const ceilTo = (value) => (Number.isFinite(value) ? Math.ceil(value) : value)

    /**
     * Whole-pixel copies of a measurement, rounded so that every derived box stays put.
     *
     * The browser reports fractional layout coordinates. Rounding the *inputs* is the
     * only way to keep the arithmetic integer, but which way to round each edge is not
     * a style choice — it is what makes "inside the column" true rather than nearly
     * true. There are two rects, and they round towards each other:
     *
     * - **The prose rounds outward.** Its left edge goes down, its right edge goes up.
     *   The rounded prose is never narrower than the real one, so a box placed beside
     *   it never lands on a word.
     * - **The column rounds inward.** Its left edge goes up, its right edge goes down.
     *   The rounded column is never wider than the real one, so a box placed inside it
     *   never spills onto host UI.
     *
     * Both directions shrink the measured gutter, which is the safe direction: the
     * number can understate the space, never overstate it. That is what lets
     * `gutter >= HANDLE_WIDTH` mean the handle really fits.
     *
     * The first version of this file rounded everything the same way. It looked
     * tidier and was wrong twice: `column.left = 0.4, prose.left = 16.8` rounded to
     * `0` and `16`, measuring a 16px gutter and then anchoring the handle at x=0 —
     * 0.4px outside the column the measurement had just called wide enough — and
     * `column.right = 890.4, prose.right = 689.0` measured a 201px gutter for a card
     * that ended at 891, 0.6px onto the host's side. Both cases are pinned in
     * `test/gutter-fractional.test.mjs`.
     *
     * @param {{ left: number, top: number, right: number, bottom: number }} rect - the prose measurement.
     * @param {{ left: number, top: number, right: number, bottom: number }} column - the column measurement.
     * @returns {{ prose: object, column: object }} rounded copies.
     */
    function snap(rect, column) {
      return {
        prose: { left: floorTo(rect.left), top: floorTo(rect.top), right: ceilTo(rect.right), bottom: ceilTo(rect.bottom) },
        column: { left: ceilTo(column.left), top: floorTo(column.top), right: floorTo(column.right), bottom: ceilTo(column.bottom) },
      }
    }

    /**
     * Measure the two gutters beside the prose, within the conversation column.
     *
     * The column is the outer bound, not the frame: everything outside the
     * conversation column belongs to the host (its sidebar, its tab strip), and
     * drawing there puts plugin UI on top of host UI. The prose is centred inside
     * the column, so the usable space on a side is the gap between the two.
     *
     * Both arguments are expected to be already snapped by {@link snap}; treated as
     * integers the two subtractions are exact, and flooring them again is a no-op
     * that only documents the intent.
     *
     * @param {{ left: number, right: number }} chatRect - the prose's horizontal extent.
     * @param {{ left: number, right: number }} [columnRect] - the conversation column; defaults to the prose when absent.
     * @returns {{ left: number, right: number }} empty space on each side, never negative.
     */
    function gutters(chatRect, columnRect) {
      const clean = (value) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)
      // No usable prose means no space that is provably ours. Returning a zero gutter
      // rather than guessing keeps the failure mode "no panel" instead of "panel on
      // top of the sidebar".
      if (!usableRect(chatRect, HORIZONTAL)) return { left: 0, right: 0 }
      const proseLeft = chatRect.left
      const proseRight = chatRect.right
      // Falling back to the prose rather than to the window keeps the failure mode
      // "no room" instead of "draw over the sidebar": with no column known there is
      // no space that is provably ours.
      const columnLeft = Number.isFinite(columnRect?.left) ? columnRect.left : proseLeft
      const columnRight = Number.isFinite(columnRect?.right) ? columnRect.right : proseRight
      return {
        left: clean(proseLeft - columnLeft),
        right: clean(columnRight - proseRight),
      }
    }

    /**
     * Decide where a card column goes, or that it cannot go anywhere.
     *
     * Deliberately picks one side and never both: two columns of small text flanking
     * the prose compete with the prose, and the point of these cards is to be
     * glanceable, not to be a second reading surface.
     *
     * @param {object} input - the measurement.
     * @param {{ left: number, top: number, right: number, bottom: number }} input.chatRect - the prose block.
     * @param {{ left: number, top: number, right: number, bottom: number }} [input.columnRect] - the conversation column; defaults to the prose.
     * @param {'left'|'right'} [input.side] - the preferred side; ignored when it has no room.
     * @param {number} [input.cardWidth] - desired width before clamping.
     * @returns {{ visible: boolean, side: 'left'|'right', left: number, top: number, width: number, height: number, reason?: string }} the box, or `visible: false` with a reason.
     */
    function placeCards(input) {
      const chatRect = input?.chatRect
      const columnRect = input?.columnRect ?? chatRect
      const side = input?.side === 'right' ? 'right' : 'left'
      const wanted = Number(input?.cardWidth ?? MAX_CARD_WIDTH)

      // Every edge must be a real number. A rect missing one of them is a failed
      // measurement, not a box at zero — and treating it as the latter put a card at
      // x=16 while the gutter arithmetic believed there was room to the right.
      if (!usableRect(chatRect, ALL_EDGES)) {
        return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-conversation' }
      }
      if (columnRect !== null && columnRect !== undefined && !usableRect(columnRect, ALL_EDGES)) {
        return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-conversation' }
      }

      const { prose, column } = snap(chatRect, columnRect ?? chatRect)
      const room = gutters(prose, column)
      const preferred = side
      const other = side === 'left' ? 'right' : 'left'

      // The requested side wins while it fits; the other side is only a fallback for
      // when it does not. Ordering by "whichever is wider" looked reasonable and was
      // wrong: the left gutter is wider than the right on any window with a left
      // sidebar, which is the default, so a 'right' preference was silently flipped
      // back to 'left' almost everywhere. Cards that vanish when the window shrinks
      // still look like a bug, hence the fallback rather than nothing.
      const order = [preferred, other]

      for (const candidate of order) {
        // Both gaps come out of the gutter, not one:
        //
        //   [ column edge | CARD_GAP | card | CARD_GAP | prose ]
        //
        // An earlier version of this line subtracted a single gap, which let the card
        // grow until it touched the column edge: on 1100–1400px windows the card sat
        // at x=0 with a 0px margin, contradicting both the `CARD_GAP` doc comment and
        // the "cards do not touch the column edge" assertion.
        const usable = room[candidate] - CARD_GAP * 2
        if (usable < MIN_CARD_WIDTH) continue
        // `wanted` is caller input, so it cannot be trusted to be a width. A NaN
        // passes `usable < MIN_CARD_WIDTH` untouched (NaN compares false to
        // everything), and a negative number survives Math.min — both then reach the
        // DOM as `width:NaNpx` / a negative width, which the browser discards, leaving
        // a card that collapsed to its content. The left side was accidentally immune
        // because a `left` finiteness check caught the NaN; the right side was not,
        // which is exactly the kind of one-sided accident that hides until the caller
        // changes. Rejecting a non-width here makes both sides agree.
        //
        // A *positive* width below MIN_CARD_WIDTH is honoured rather than rejected:
        // the gutter check above already guarantees the card fits, and a caller asking
        // for something narrower than the default is asking for something narrower than
        // the default. Only values that cannot be a width are refused.
        //
        // `Math.floor` rather than a round: the width must not exceed the budget, or
        // the card grows past the column edge the budget came from.
        const width = Math.floor(Math.min(MAX_CARD_WIDTH, wanted, usable))
        if (!Number.isFinite(width) || width <= 0) continue
        // Hugging the prose, not the frame edge. The gap is the only thing between
        // the cards and the text, which is what makes them read as an annotation of
        // the conversation rather than as a second sidebar.
        //
        // The prose edges are already rounded outward, so `prose.left - CARD_GAP -
        // width` is at most the real value: the card cannot reach the text. On the
        // right, `prose.right + CARD_GAP` is at least the real value for the same
        // reason.
        const left = candidate === 'left' ? prose.left - CARD_GAP - width : prose.right + CARD_GAP
        const top = prose.top + TOP_INSET
        const bottom = prose.bottom - BOTTOM_INSET
        return {
          visible: true,
          side: candidate,
          // Not clamped to zero: a negative `left` would mean the column starts off
          // screen, and silently moving the card to 0 is what put it over the host's
          // sidebar. If the arithmetic says negative, the measurement was wrong.
          left,
          top: Math.max(0, top),
          width,
          height: Math.max(0, bottom - top),
        }
      }

      return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-room' }
    }

    /**
     * Where the collapsed handle goes: the same edge as the cards, hugging the prose.
     *
     * The handle is anchored to the prose edge rather than to the cards' edge. While
     * `HANDLE_WIDTH` equals `CARD_GAP` the two rules agree, but they stop agreeing the
     * moment either constant moves: anchored to the cards, a wider handle would sit on
     * the text and a narrower one would leave a gap that reads as a misalignment.
     * Anchored to the prose, the handle's outer edge *is* the text's edge at any width,
     * so the one thing that must never happen — a control on top of a paragraph —
     * cannot.
     *
     * With no cards at all there is no card edge to tuck under, so the handle needs its
     * full width of clear gutter — otherwise a narrow window would strand the panel
     * with no way to reopen it. That is why the fallback checks *both* gutters: on an
     * asymmetric window the requested side can be too narrow while the other is not,
     * and refusing outright would leave the panel unreachable.
     *
     * @param {object} input - the same measurement `placeCards` takes.
     * @returns {{ visible: boolean, side: 'left'|'right', left: number, top: number }} the handle's box.
     */
    function placeHandle(input) {
      const chatRect = input?.chatRect
      const columnRect = input?.columnRect ?? chatRect
      const preferred = input?.side === 'right' ? 'right' : 'left'
      const other = preferred === 'left' ? 'right' : 'left'

      // Same rule as `placeCards`, for the same reason: a rect missing an edge is a
      // failed measurement, not a box at zero. Diverging here meant one function
      // refused an incomplete rect while the other silently drew a handle at top 60.
      if (!usableRect(chatRect, ALL_EDGES)) {
        return { visible: false, side: preferred, left: 0, top: 0 }
      }
      if (columnRect !== null && columnRect !== undefined && !usableRect(columnRect, ALL_EDGES)) {
        return { visible: false, side: preferred, left: 0, top: 0 }
      }

      // The same rounding the cards used, so the fallback gutter check and the anchor
      // below divide the same integers.
      const { prose, column } = snap(chatRect, columnRect ?? chatRect)
      const room = gutters(prose, column)

      const placed = placeCards(input)
      let side = preferred
      if (placed.visible) {
        side = placed.side
      } else if (room[preferred] >= HANDLE_WIDTH) {
        side = preferred
      } else if (room[other] >= HANDLE_WIDTH) {
        side = other
      } else {
        return { visible: false, side: preferred, left: 0, top: 0 }
      }

      // Anchored to the prose: the handle's outer edge *is* the prose edge, so it can
      // never cover a word. On the left that means starting HANDLE_WIDTH before the
      // text; on the right it means starting exactly at the text.
      //
      // Containment is a consequence of the gutter check above rather than a clamp
      // here, and that is worth stating because a clamp used to be here. On integers
      // `room.left >= HANDLE_WIDTH` means `prose.left - column.left >= HANDLE_WIDTH`,
      // so `prose.left - HANDLE_WIDTH >= column.left`: the anchor is inside the
      // column by construction. The clamp was unreachable then and is unreachable now,
      // so the invariant is asserted in the sweeps instead of guarded by dead code.
      const left = side === 'left' ? prose.left - HANDLE_WIDTH : prose.right

      return {
        visible: true,
        side,
        left,
        top: Math.max(0, placed.visible ? placed.top + 48 : prose.top + TOP_INSET + 48),
      }
    }

    /**
     * Where a hover bubble goes, given where its trigger is.
     *
     * Both axes are clamped. The horizontal clamp was written first, after a review
     * found the bubble opening past the right edge; the vertical one was missing for
     * several more rounds because every fixture set the trigger at `top: 300` on a
     * 1000px-tall window, where nothing can overflow. It is the same failure one axis
     * over: the rail is a scrolling container pinned between the top and bottom of the
     * prose, so a trigger near its bottom edge puts `bottom + TIP_OFFSET` within a
     * bubble's height of the viewport bottom, and the whole bubble is off screen.
     *
     * Flipping above the trigger is preferred over sliding the bubble up: sliding
     * leaves it overlapping the button it describes (and can cover the very text the
     * button sits next to), whereas a bubble above the trigger still points at it.
     * Sliding is only the fallback for a viewport too short to fit either way, where
     * some overlap beats an invisible bubble.
     *
     * The trigger is read as `{left, top, bottom}`. `right` is deliberately not
     * consulted: the bubble is placed from the left edge plus `TIP_WIDTH`, so a
     * caller that omits `right` still gets a correct placement.
     *
     * @param {object} input - `{ trigger: {left, top, bottom}, viewportWidth, viewportHeight }`.
     *   `right` is accepted and ignored.
     * @returns {{visible: boolean, left: number, top: number, width: number}} placement.
     */
    function placeTip(input) {
      const trigger = input?.trigger
      const width = TIP_WIDTH
      const fallback = { visible: false, left: 0, top: 0, width }

      // A trigger that cannot be measured has no meaningful position: returning zeros
      // would draw the bubble in the top-left corner, which reads as a bug rather
      // than as "unknown". Callers hide it instead.
      if (
        trigger === null ||
        trigger === undefined ||
        !Number.isFinite(trigger.left) ||
        !Number.isFinite(trigger.bottom) ||
        !Number.isFinite(trigger.top)
      ) {
        return fallback
      }

      // Horizontal: prefer the trigger's left edge, then pull back until the bubble's
      // right edge clears the viewport. When the viewport itself cannot be measured
      // (`NaN`, a test double, an embedded webview) the anchor plus the bubble width
      // stands in for it — treating "unknown" as "no limit" is what put the bubble off
      // screen in the first place.
      const measured = input?.viewportWidth
      const edge = Number.isFinite(measured) && measured > 0 ? measured : trigger.left + width
      const highest = Math.max(TIP_MARGIN, edge - width - TIP_MARGIN)
      const left = Math.max(TIP_MARGIN, Math.min(trigger.left, highest))

      // Vertical: below the trigger when it fits, above it otherwise, offset inside
      // the viewport only when neither fits.
      const below = trigger.bottom + TIP_OFFSET
      const above = trigger.top - TIP_OFFSET - TIP_HEIGHT
      const measuredHeight = input?.viewportHeight
      const foot = Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : undefined

      let top = below
      if (foot !== undefined && below + TIP_HEIGHT > foot - TIP_MARGIN) {
        // `Math.max` guards the case where the trigger is near the top edge and there
        // is no room above either; the bubble then overlaps the trigger by as much as
        // it must, which is the least bad option available.
        top = above >= TIP_MARGIN ? above : Math.max(TIP_MARGIN, foot - TIP_HEIGHT - TIP_MARGIN)
      }

      // Last resort: keep the bubble inside the viewport whatever the trigger says.
      // The branch above assumes the trigger is inside the window. A trigger can
      // report a position outside it — a rect measured mid-scroll, or a caller passing
      // a stale one — and then `below` itself is off screen: a trigger above the
      // viewport leaves `top` negative, and one below it leaves `top` past the bottom
      // while the overflow test above never fires. Both produce a bubble that is
      // rendered but invisible, which is the failure this function exists to prevent.
      //
      // Both bounds are applied only when the viewport is tall enough to hold the
      // bubble. In a shorter window they would cross, and a crossed clamp silently
      // picks whichever bound it compares last; the top margin wins instead, because a
      // bubble hanging out of the top edge is worse than one overlapping its trigger.
      if (foot !== undefined && foot >= TIP_HEIGHT + TIP_MARGIN * 2) {
        top = Math.max(TIP_MARGIN, Math.min(top, foot - TIP_HEIGHT - TIP_MARGIN))
      } else if (foot !== undefined) {
        // Too short to hold the bubble: some of it must hang out. Keep its *top* edge
        // on screen so the first line is readable, which is the part that says what the
        // button does. Clamping only to the top margin would not do that for a trigger
        // reported below the viewport, where `top` is large and positive.
        //
        // The inner `Math.max` is defensive, not load-bearing: the outer `Math.max`
        // already restores TIP_MARGIN when the two bounds invert, so deleting the inner
        // one changes no output. It stays because reading "clamp between two bounds" is
        // easier to check than "clamp, then repair" — the reviewer verified the two
        // forms agree on every input, and a mutation that removes the inner max survives
        // the suite for exactly that reason. Equivalence is not a coverage gap.
        top = Math.max(TIP_MARGIN, Math.min(top, Math.max(TIP_MARGIN, foot - TIP_MARGIN)))
      } else {
        // No measurable height. Following the rule the horizontal axis set above,
        // "unknown" is not treated as "no limit" — but the axes cannot mirror each
        // other exactly here: without a height there is no bottom edge to clamp
        // against, so the only boundary left is the top margin. A trigger reported
        // above the window would otherwise place the bubble at a negative `top`.
        top = Math.max(TIP_MARGIN, top)
      }

      return { visible: true, left, top, width }
    }
    // </gutter>

    /**
     * The conversation's geometry, in the overlay's own coordinates.
     *
     * Two boxes matter and they are not the same box:
     *  - `content` is `[data-conversation-content]`, the full width the
     *    conversation was given. Its left/right edges are the outermost a card
     *    may reach — beyond that is the host's sidebar, which the cards must not
     *    sit on top of.
     *  - `prose` is where the text actually is, centred within `content` at
     *    `--dsh-chat-content-width`.
     *
     * Reading the custom property rather than recomputing the clamp means a user
     * who drags the host's width handle is tracked exactly, including the
     * `--dsh-chat-user-width` override that the drag writes.
     *
     * @param {Element | null} host - the overlay's own container, for the origin.
     * @returns {object | null} the measurement, or null when there is no conversation.
     */
    function measure(host) {
      if (typeof document === "undefined") return null
      const content = document.querySelector("[data-conversation-content]")
      if (content === null || content === undefined) return null
      const contentRect = content.getBoundingClientRect()
      if (contentRect.width <= 0 || contentRect.height <= 0) return null

      let proseWidth = 0
      try {
        const declared = getComputedStyle(content).getPropertyValue("--dsh-chat-content-width")
        proseWidth = Math.round(Number.parseFloat(declared))
      } catch {
        proseWidth = 0
      }
      if (Number.isFinite(proseWidth) === false || proseWidth <= 0) {
        // The property is always set on this element by the host's own
        // stylesheet; if it is missing we are on a version whose layout we do
        // not know, so fall back to the same clamp the host documents.
        proseWidth = Math.min(920, Math.max(680, Math.round(contentRect.width * 0.64)))
      }

      const inset = Math.max(0, Math.round((contentRect.width - proseWidth) / 2))
      const frame = host === null || host === undefined ? null : host.getBoundingClientRect()
      const originLeft = frame === null ? contentRect.left : contentRect.left - frame.left
      const originTop = frame === null ? contentRect.top : contentRect.top - frame.top

      return {
        // Relative to the overlay container, which is what absolute positioning
        // inside it uses.
        chatRect: {
          left: originLeft + inset,
          right: originLeft + inset + proseWidth,
          top: originTop,
          bottom: originTop + contentRect.height,
        },
        // The column, not the frame. Cards may only occupy the space between the
        // prose and this box; outside it the host draws its own sidebar and tab
        // strip, and plugin UI on top of those is a bug, not a layout choice.
        columnRect: {
          left: originLeft,
          right: originLeft + contentRect.width,
          top: originTop,
          bottom: originTop + contentRect.height,
        },
      }
    }

    /** Monotonic source of unique ids for the bubble/highlight association. */
    let tipSeq = 0

    /**
     * A hover/focus explanation bubble.
     *
     * Wraps its child in a span rather than attaching to the control itself:
     * a disabled button does not receive mouse events in Chrome, so a tooltip
     * bound to the button would disappear exactly when the user is most likely
     * to wonder why it is unavailable.
     *
     * @param {object} props - injected props.
     * @param {string} props.text - the explanation.
     * @returns {object} the element.
     */
    function Hint(props) {
      const [anchor, setAnchor] = React.useState(null)
      const ref = React.useRef(null)
      // A stable, unique id so the bubble can be pointed at from its trigger.
      // Without the association `role="tooltip"` is a label attached to
      // nothing, and a screen reader announces nothing.
      const [id] = React.useState(() => {
        tipSeq += 1
        return `dsse-tip-${tipSeq}`
      })

      const show = React.useCallback(() => {
        const node = ref.current
        if (node === null) return
        const box = node.getBoundingClientRect()
        setAnchor({
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        })
      }, [])

      const hide = React.useCallback(() => setAnchor(null), [])

      React.useEffect(() => {
        if (anchor === null) return undefined
        // The card is repositioned by a ResizeObserver whenever the window or
        // the conversation column changes. A bubble pinned to old coordinates
        // would float away from its button, so any of those dismisses it.
        const dismiss = () => setAnchor(null)
        window.addEventListener("resize", dismiss)
        window.addEventListener("scroll", dismiss, true)
        return () => {
          window.removeEventListener("resize", dismiss)
          window.removeEventListener("scroll", dismiss, true)
        }
      }, [anchor])

      // Both axes are clamped, and both clamps live in lib/gutter.js so they can be
      // tested in Node instead of being asserted against a hand-computed number
      // here. The horizontal clamp came first, after a review found the bubble
      // opening past the right edge; the vertical one was missing for several more
      // rounds because every fixture set the trigger at top 300 on a 1000px window,
      // where nothing can overflow.
      const placed =
        anchor === null
          ? { visible: false, left: 0, top: 0, width: TIP_WIDTH }
          : placeTip({
              trigger: anchor,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
            })
      const width = placed.width

      // The description has to be on the element that actually takes focus. A
      // wrapper span has no `tabindex`, so focus always lands on the button
      // inside it, and `aria-describedby` is not inherited — putting it on the
      // span left the association inert. Only advertise it while the bubble is
      // on screen: pointing at one that does not exist makes a screen reader
      // read an empty string in place of the label.
      // `cloneElement` needs an element, not just a children slot: it throws on
      // `null`/`undefined` and silently loses the injected prop on strings. A
      // caller that renders its button conditionally would otherwise take the
      // whole card down the moment the bubble opens.
      const labelled =
        placed.visible === false ||
        typeof React.cloneElement !== "function" ||
        typeof React.isValidElement !== "function" ||
        !React.isValidElement(props.children)
          ? props.children
          : React.cloneElement(props.children, { "aria-describedby": id })

      return jsxs("span", {
        ref,
        className: "dsse-tip-anchor",
        onMouseEnter: show,
        onMouseLeave: hide,
        onFocus: show,
        onBlur: hide,
        children: [
          labelled,
          anchor === null || placed.visible === false
            ? null
            : jsx("span", {
                id,
                className: "dsse-tip",
                role: "tooltip",
                style: { left: `${placed.left}px`, top: `${placed.top}px`, width: `${width}px` },
                children: props.text,
              }),
        ],
      })
    }

    /**
     * One card: a coloured dot, a title, a meta line on the right, and a body.
     *
     * @param {object} props - the card contents.
     * @returns {object} the element.
     */
    function Card(props) {
      return jsxs("section", {
        className: "dsse-card",
        children: [
          jsxs("header", {
            className: "dsse-card-head",
            children: [
              jsx("span", { className: "dsse-dot", "data-tone": props.tone ?? "" }),
              jsx("span", { className: "dsse-card-title", children: props.title }),
              props.meta === undefined || props.meta === ""
                ? null
                : jsx("span", { className: "dsse-card-meta", children: props.meta }),
              props.onFold === undefined
                ? null
                : jsx("button", {
                    className: "dsse-fold",
                    type: "button",
                    title: "收起面板",
                    onClick: props.onFold,
                    children: "\u2039",
                  }),
            ],
          }),
          jsx("div", { className: "dsse-card-body", children: props.children }),
        ],
      })
    }

    /**
     * The four cards plus the chrome around them.
     *
     * Every field is read from one `/panel` response on purpose: the summary
     * belongs to a turn, and fetching the modules separately would let the
     * column show turn 4's summary beside turn 3's files.
     *
     * @param {object} props - injected props.
     * @param {object} props.place - where to draw, from `gutter.js`.
     * @param {() => void} props.onCollapse - collapse the column to a handle.
     * @returns {object} the element.
     */
    function Cards(props) {
      const [state, setState] = React.useState({ status: "loading" })
      const [config, setConfig] = React.useState(undefined)
      const [models, setModels] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState("")
      const [filesOpen, setFilesOpen] = React.useState(false)

      const sessionId = bridge.sessionId

      /**
       * Pull the current card payload.
       *
       * Failures are shown rather than swallowed: a column that silently renders
       * "nothing yet" when the route is unreachable is indistinguishable from a
       * session that genuinely produced nothing, and that ambiguity is worse
       * than a visible error.
       *
       * @param {boolean} quiet - suppress the loading state on a background refresh.
       */
      const load = React.useCallback(
        async (quiet) => {
          if (sessionId === "") {
            setState({ status: "no-session" })
            return
          }
          if (quiet !== true) setState((prior) => ({ ...prior, status: "loading" }))
          try {
            const data = await call(`/panel?agent=${encodeURIComponent(sessionId)}`)
            setState({ status: "ready", data })
            setError("")
          } catch (failure) {
            setState({ status: "ready", data: undefined })
            setError(String(failure?.message ?? failure))
          }
        },
        [sessionId],
      )

      React.useEffect(() => {
        ensureStyle()
        return subscribe(() => {
          setState({ status: "loading" })
        })
      }, [])

      React.useEffect(() => {
        load(false)
        const timer = setInterval(() => load(true), REFRESH_MS)
        return () => clearInterval(timer)
      }, [load])

      React.useEffect(() => {
        let live = true
        Promise.all([call("/config"), call("/models")])
          .then(([nextConfig, catalogue]) => {
            if (live === false) return
            setConfig(nextConfig)
            const providers = Array.isArray(catalogue?.providers) ? catalogue.providers : []
            setModels(providers)
          })
          .catch(() => {
            // The cards work without them; only the two settings controls are
            // unavailable, and they render disabled rather than missing.
          })
        return () => {
          live = false
        }
      }, [])

      /**
       * Persist one setting.
       *
       * @param {object} patch - the fields to change.
       */
      const saveConfig = async (patch) => {
        const prior = config
        setConfig({ ...(config ?? {}), ...patch })
        try {
          // The reply is the config itself, so it replaces the optimistic
          // patch. Storing a receipt here would blank every field it omitted.
          const saved = await call("/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          })
          setConfig(saved && typeof saved === "object" && saved.ok !== false ? saved : { ...prior, ...patch })
          setError("")
          load(true)
        } catch (failure) {
          setConfig(prior)
          setError(String(failure?.message ?? failure))
        }
      }

      /** Ask the plugin to hint the model about capturing a skill. */
      const propose = async () => {
        setBusy(true)
        try {
          await call("/propose", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: sessionId }),
          })
          setError("")
          load(true)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const data = state.status === "ready" ? state.data : undefined
      const summary = data?.summary
      const skills = Array.isArray(data?.skills?.skills) ? data.skills.skills : []
      const mcp = Array.isArray(data?.mcp) ? data.mcp : []
      const files = Array.isArray(data?.files) ? data.files : []
      const ordered = files.slice().sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
      const shown = filesOpen ? ordered : ordered.slice(0, 5)

      const summaryText =
        summary?.text !== undefined && String(summary.text).length > 0
          ? String(summary.text)
          : String(summary?.reason ?? (state.status === "no-session" ? "open a conversation first" : "no completed turn yet"))

      const providerOptions = React.useMemo(() => {
        const rows = []
        for (const provider of models) {
          const id = String(provider?.provider ?? provider?.id ?? "")
          const modelList = Array.isArray(provider?.models) ? provider.models : []
          for (const model of modelList) {
            const modelId = String(model?.id ?? model?.model ?? "")
            if (id === "" || modelId === "") continue
            rows.push({ value: `${id}\u0000${modelId}`, label: `${id} / ${String(model?.name ?? modelId)}` })
          }
        }
        return rows
      }, [models])

      const selectedModel =
        typeof config?.panelSummaryProvider === "string" && config.panelSummaryProvider.length > 0
          ? `${config.panelSummaryProvider}\u0000${String(config.panelSummaryModel ?? "")}`
          : ""

      return jsxs("div", {
        className: "dsse-rail",
        "data-dsse-rail": "1",
        "data-side": props.place.side,
        style: {
          left: `${props.place.left}px`,
          top: `${props.place.top}px`,
          width: `${props.place.width}px`,
          height: `${props.place.height}px`,
        },
        children: [
          error === "" ? null : jsx("p", { className: "dsse-err", children: error }),

          jsxs(Card, {
            title: "上一轮",
            tone: "",
            meta:
              data === undefined
                ? ""
                : `第 ${data.turn ?? 0} 轮${data.calls > 0 ? ` \u00b7 ${data.calls} 次调用` : ""}${data.failed > 0 ? ` \u00b7 ${data.failed} 失败` : ""}`,
            onFold: props.onCollapse,
            children: [
              jsx("p", { className: "dsse-text dsse-tiny", children: summaryText }),
              data === undefined
                ? null
                : jsxs("div", {
                    children: [
                      data.files?.length > 0
                        ? jsxs("div", { className: "dsse-kv", children: [jsx("b", { children: "改动" }), jsx("span", { children: `${data.files.length} 个文件` })] })
                        : null,
                      config === undefined
                        ? null
                        : jsxs("label", {
                            className: "dsse-label",
                            children: [
                              jsx("input", {
                                className: "dsse-check",
                                type: "checkbox",
                                checked: config.panelSummary === true,
                                onChange: (event) => saveConfig({ panelSummary: event.target.checked === true }),
                              }),
                              "每轮自动总结",
                            ],
                          }),
                      config === undefined || providerOptions.length === 0
                        ? null
                        : jsx("label", {
                            className: "dsse-label",
                            children: jsx("select", {
                              className: "dsse-select",
                              value: selectedModel,
                              onChange: (event) => {
                                const raw = String(event.target.value ?? "")
                                if (raw === "") {
                                  saveConfig({ summaryProvider: "", summaryModel: "" })
                                  return
                                }
                                const [provider, model] = raw.split("\u0000")
                                saveConfig({ summaryProvider: provider, summaryModel: model })
                              },
                              children: [
                                jsx("option", { value: "", children: "总结模型：跟随默认" }),
                                ...providerOptions.map((option) =>
                                  jsx("option", { value: option.value, children: option.label }, option.value),
                                ),
                              ],
                            }),
                          }),
                    ],
                  }),
            ],
          }),

          jsxs(Card, {
            title: "技能",
            meta: data?.skills?.available === false ? "不可用" : String(skills.length),
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "5px" },
                children: [
                  jsx(Hint, {
                    text: "让模型看一眼这一轮做了什么，判断值不值得沉淀成技能。只在当前对话里写一条提示，不会自动新建技能文件。",
                    children: jsx("button", {
                      className: "dsse-btn",
                      type: "button",
                      disabled: busy || sessionId === "",
                      onClick: propose,
                      children: busy ? "询问中…" : "建议提炼",
                    }),
                  }),
                  data?.pendingCandidates > 0
                    ? jsx("span", { className: "dsse-badge", children: `${data.pendingCandidates} 待批` })
                    : null,
                ],
              }),
              data?.skills?.available === false
                ? jsx("p", { className: "dsse-muted dsse-tiny", children: String(data.skills.reason ?? "no skill registry") })
                : null,
              skills.length === 0 && data?.skills?.available !== false
                ? jsx("p", { className: "dsse-muted dsse-tiny", children: "本会话还没有用过技能。用技能时这里会列出来。" })
                : null,
              ...skills.slice(0, 6).map((skill) =>
                jsxs(
                  "div",
                  {
                    className: "dsse-row",
                    children: [
                      jsx("span", { className: "dsse-row-main", children: jsx("span", { className: "dsse-name", children: skill.name }) }),
                      skill.owned === true ? jsx("span", { className: "dsse-badge dsse-badge-own", children: "本插件" }) : null,
                    ],
                  },
                  `skill:${skill.name}`,
                ),
              ),
              skills.length > 6
                ? jsx("p", { className: "dsse-muted dsse-tiny", style: { margin: "4px 0 0" }, children: `另有 ${skills.length - 6} 个，用 skill_search 查` })
                : null,
            ],
          }),

          jsxs(Card, {
            title: "MCP",
            tone: "ok",
            meta: `${mcp.length} 个在用`,
            children: [
              mcp.length === 0
                ? jsx("p", { className: "dsse-muted dsse-tiny", children: "本会话没有 MCP 调用。" })
                : null,
              ...mcp.map((server) =>
                jsxs(
                  "div",
                  {
                    className: "dsse-row",
                    children: [
                      jsx("span", { className: "dsse-row-main", children: jsx("span", { className: "dsse-name", children: server.server }) }),
                      jsx("span", { className: "dsse-size", children: `${server.tools} 工具` }),
                    ],
                  },
                  `mcp:${server.server}`,
                ),
              ),
            ],
          }),

          jsxs(Card, {
            title: "产出文件",
            tone: "ok",
            meta: String(ordered.length),
            children: [
              ordered.length === 0
                ? jsx("p", { className: "dsse-muted dsse-tiny", children: "上一轮没有点名文件。" })
                : null,
              ...shown.map((file) => {
                const parts = splitPath(file.path)
                return jsxs(
                  "div",
                  {
                    className: "dsse-row",
                    children: [
                      jsxs("span", {
                        className: "dsse-row-main",
                        children: [
                          jsx("span", { className: "dsse-name", title: String(file.path), children: parts.name }),
                          parts.where === "" ? null : jsx("span", { className: "dsse-where", children: parts.where }),
                        ],
                      }),
                      jsx("span", { className: "dsse-size", children: formatBytes(file.bytes) }),
                    ],
                  },
                  `file:${file.path}`,
                )
              }),
              ordered.length > shown.length || filesOpen
                ? jsx("button", {
                    className: "dsse-more",
                    type: "button",
                    onClick: () => setFilesOpen((open) => open === false),
                    children: filesOpen ? "收起" : `全部 ${ordered.length} 个`,
                  })
                : null,
            ],
          }),
        ],
      })
    }

    /**
     * Draw the cards, or the handle, or nothing.
     *
     * Mounted in `shell.overlay`, which is a root-scope layer: it renders whether
     * or not a conversation is open, so this wrapper is what keeps the cards from
     * floating over the launcher.
     *
     * The measurement is re-run on every frame that could have moved the layout —
     * window resize, the host's own sidebar collapsing, the width handle being
     * dragged — because a hard-coded pixel offset would be wrong on the next
     * window size. `ResizeObserver` on the conversation body covers all three
     * without listening to any of them individually.
     *
     * @returns {object | null} the element, or null when there is nothing to draw.
     */
    function Overlay() {
      const hostRef = React.useRef(null)
      const [place, setPlace] = React.useState({ visible: false })
      const [handle, setHandle] = React.useState({ visible: false })
      const [, bump] = React.useState(0)

      const remeasure = React.useCallback(() => {
        // No early return on a null ref: React attaches refs after render, so the
        // first pass always has none, and bailing here left both boxes invisible
        // for good. `measure` treats a missing host as a zero origin, which is
        // right because this wrapper spans the overlay with `inset: 0`.
        const host = hostRef.current
        const geometry = measure(host)
        if (geometry === null) {
          setPlace({ visible: false })
          setHandle({ visible: false })
          return
        }
        const next = placeCards({
          chatRect: geometry.chatRect,
          columnRect: geometry.columnRect,
          side: bridge.side,
          cardWidth: CARD_WIDTH,
        })
        setPlace(next)
        setHandle(placeHandle({ chatRect: geometry.chatRect, columnRect: geometry.columnRect, side: next.side }))
      }, [])

      // Re-measure on every notification, not just re-render. The notification
      // fires when the side changes or the session switches, and both change what
      // the geometry should say — bumping a counter alone redrew the same box.
      React.useEffect(() =>
        subscribe(() => {
          remeasure()
          bump((value) => value + 1)
        }),
      [remeasure])

      React.useEffect(() => {
        ensureStyle()
        remeasure()

        const host = hostRef.current
        const target = typeof document === "undefined" ? null : document.querySelector("[data-conversation-content]")

        let observer = null
        if (typeof ResizeObserver !== "undefined" && target !== null) {
          observer = new ResizeObserver(() => remeasure())
          observer.observe(target)
          if (host !== null) observer.observe(host)
        }

        const onResize = () => remeasure()
        if (typeof window !== "undefined") window.addEventListener("resize", onResize)

        // The conversation can appear after this mounts (launcher -> session),
        // and `ResizeObserver` cannot watch an element that did not exist yet.
        // A slow poll is the cheap, boring answer; it costs one layout read per
        // second and stops as soon as there is something to observe.
        let timer = setInterval(() => {
          remeasure()
          if (observer !== null) {
            // Nothing left to wait for: the conversation exists and is observed,
            // so the per-second layout read has done its job.
            clearInterval(timer)
            timer = null
            return
          }
          if (typeof ResizeObserver === "undefined") return
          const late = typeof document === "undefined" ? null : document.querySelector("[data-conversation-content]")
          if (late === null) return
          observer = new ResizeObserver(() => remeasure())
          observer.observe(late)
          if (host !== null) observer.observe(host)
          clearInterval(timer)
          timer = null
        }, 1000)

        return () => {
          if (observer !== null) observer.disconnect()
          if (typeof window !== "undefined") window.removeEventListener("resize", onResize)
          if (timer !== null) clearInterval(timer)
        }
      }, [remeasure])

      // Re-place when the setting changes side or the column is collapsed.
      React.useEffect(() => {
        remeasure()
      }, [remeasure, place.side])

      const collapse = () => {
        bridge.collapsed = true
        remeasure()
        bump((value) => value + 1)
      }

      if (bridge.open !== true || bridge.sessionId === "") return null

      if (bridge.collapsed === true || place.visible === false) {
        if (handle.visible === false) return jsx("div", { ref: hostRef, style: { display: "none" } })
        return jsx("div", {
          ref: hostRef,
          style: { position: "absolute", inset: 0, pointerEvents: "none" },
          children: jsx("button", {
            className: "dsse-handle",
            type: "button",
            "data-side": handle.side,
            style: { left: `${handle.left}px`, top: `${handle.top}px`, pointerEvents: "auto" },
            title: "展开技能面板",
            onClick: () => {
              bridge.collapsed = false
              remeasure()
              bump((value) => value + 1)
            },
            children: handle.side === "left" ? "\u203a" : "\u2039",
          }),
        })
      }

      return jsx("div", {
        ref: hostRef,
        style: { position: "absolute", inset: 0, pointerEvents: "none" },
        children: jsx("div", {
          style: { pointerEvents: "auto", display: "contents" },
          children: jsx(Cards, { place, onCollapse: collapse }),
        }),
      })
    }

    /**
     * The header button that opens the cards.
     *
     * Session-scoped, so it exists only while a conversation is on screen — the
     * cards describe a conversation and have nothing to say on the launcher.
     *
     * @param {object} props - injected props.
     * @param {string} props.sessionId - the conversation this button belongs to.
     * @returns {object} the element.
     */
    function Toggle(props) {
      const sessionId = typeof props?.sessionId === "string" ? props.sessionId : ""
      const [, force] = React.useState(0)

      React.useEffect(() => {
        ensureStyle()
        return subscribe(() => force((value) => value + 1))
      }, [])

      React.useEffect(() => {
        // The cards are mounted outside the conversation, so the header is where
        // they learn which session is on screen. Doing this on render rather
        // than on click keeps the cards correct when the user switches
        // conversation with them already open.
        if (sessionId !== "" && bridge.sessionId !== sessionId) {
          bridge.sessionId = sessionId
          notify()
        }
      }, [sessionId])

      React.useEffect(() => {
        let live = true
        call("/config")
          .then((next) => {
            if (live === false) return
            if (next?.panelSide === "left" || next?.panelSide === "right") bridge.side = next.panelSide
            if (typeof next?.panelCollapsed === "boolean") bridge.collapsed = next.panelCollapsed
            notify()
          })
          .catch(() => {
            // Opening the panel still works; it just uses the defaults.
          })
        return () => {
          live = false
        }
      }, [])

      const open = bridge.open === true && bridge.sessionId === sessionId

      return jsxs("button", {
        className: "dsse-toggle",
        type: "button",
        "data-active": String(open),
        title: "技能面板：上一轮 / 技能 / MCP / 产出文件",
        onClick: () => {
          bridge.sessionId = sessionId
          bridge.open = open === false
          // Opening always clears a collapse: a person who clicked the button is
          // asking to see the cards, not to be shown a handle.
          if (bridge.open === true) bridge.collapsed = false
          notify()
        },
        children: ["技能", jsx("span", { className: "dsse-toggle-count", children: "4" })],
      })
    }

    const inject = ["slots"]

    /**
     * Register both seats.
     *
     * @param {any} ctx - the client plugin context.
     */
    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.session.header.actions", () =>
            ctx.slots.register(
              {
                name: "conversation.session.header.actions",
                id: TOGGLE_ID,
                order: 40,
                registrant: NS,
                inject: (sessionId) => ({ sessionId }),
              },
              Toggle,
            ),
          ),
        "skill-evolve: panel toggle",
      )

      ctx.effect(
        () =>
          ctx.slots.inject("shell.overlay", () =>
            ctx.slots.register(
              {
                name: "shell.overlay",
                id: PANEL_ID,
                order: 60,
                registrant: NS,
                inject: () => ({}),
              },
              Overlay,
            ),
          ),
        "skill-evolve: card overlay",
      )

      ctx.effect(
        () => () => {
          bridge.open = false
          bridge.listeners.clear()
          if (typeof document !== "undefined") {
            document.getElementById(`${NS}:style`)?.remove()
          }
        },
        "skill-evolve: panel teardown",
      )
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
