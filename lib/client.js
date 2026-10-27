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
     * Measure the two gutters beside the prose.
     *
     * @param {{ left: number, right: number }} chatRect - the prose's horizontal extent.
     * @param {number} viewportWidth - the frame's width.
     * @returns {{ left: number, right: number }} empty space on each side, never negative.
     */
    function gutters(chatRect, viewportWidth) {
      const left = Number(chatRect?.left ?? 0)
      const width = Number(viewportWidth ?? 0)
      // The right edge falls back to the viewport only when the viewport itself is
      // a real number; falling back to NaN would make the gutter NaN, which CSS
      // renders as 'left:NaNpx' and quietly drops the cards into the corner.
      const rawRight = chatRect?.right
      const right = Number(rawRight ?? (Number.isFinite(width) ? width : 0))
      const clean = (value) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)
      return {
        left: clean(left),
        right: clean(width - right),
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
     * @param {number} input.viewportWidth - the frame's width.
     * @param {'left'|'right'} [input.side] - the preferred side; ignored when it has no room.
     * @param {number} [input.cardWidth] - desired width before clamping.
     * @returns {{ visible: boolean, side: 'left'|'right', left: number, top: number, width: number, height: number, reason?: string }} the box, or `visible: false` with a reason.
     */
    function placeCards(input) {
      const chatRect = input?.chatRect
      const viewportWidth = Number(input?.viewportWidth ?? 0)
      const side = input?.side === 'right' ? 'right' : 'left'
      const wanted = Number(input?.cardWidth ?? MAX_CARD_WIDTH)

      if (chatRect === undefined || chatRect === null) {
        return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-conversation' }
      }

      const room = gutters(chatRect, viewportWidth)
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
        const usable = room[candidate] - CARD_GAP * 2
        if (usable < MIN_CARD_WIDTH) continue
        const width = Math.floor(Math.min(MAX_CARD_WIDTH, wanted, usable))
        const left =
          candidate === 'left' ? CARD_GAP : Math.floor(viewportWidth - CARD_GAP - width)
        const top = Math.floor(Number(chatRect.top ?? 0) + TOP_INSET)
        const bottom = Math.floor(Number(chatRect.bottom ?? 0) - BOTTOM_INSET)
        return {
          visible: true,
          side: candidate,
          left: Math.max(0, left),
          top: Math.max(0, top),
          width,
          height: Math.max(0, bottom - top),
        }
      }

      return { visible: false, side, left: 0, top: 0, width: 0, height: 0, reason: 'no-room' }
    }

    /**
     * Where the collapsed handle goes: the same edge, hugging the prose.
     *
     * The handle exists so a collapsed panel is still reachable. It is 22px wide and
     * vertically centred on the cards' span, which is enough to hit without becoming
     * a second thing competing for attention.
     *
     * @param {object} input - the same measurement `placeCards` takes.
     * @returns {{ visible: boolean, side: 'left'|'right', left: number, top: number }} the handle's box.
     */
    function placeHandle(input) {
      const placed = placeCards(input)
      const side = placed.side
      if (placed.visible === false) {
        // Even with no room for cards, keep a handle if there is room for 22px. This
        // is what stops a narrow window from silently losing the panel for good.
        const room = gutters(input?.chatRect, Number(input?.viewportWidth ?? 0))
        const candidate = room[side] >= 24 ? side : room.left >= 24 ? 'left' : room.right >= 24 ? 'right' : ''
        if (candidate === '') return { visible: false, side, left: 0, top: 0 }
        const left = candidate === 'left' ? 0 : Math.floor(Number(input.viewportWidth) - 22)
        const top = Math.floor(Number(input?.chatRect?.top ?? 0) + TOP_INSET + 48)
        return { visible: true, side: candidate, left: Math.max(0, left), top: Math.max(0, top) }
      }
      // The handle goes in the gap between the cards and the prose, not against the
      // window edge: that is the edge the eye is already on, and it stays reachable
      // when a wide window pushes the cards far from the window border.
      const left = side === 'left' ? placed.left + placed.width : Math.max(0, placed.left - 22)
      return { visible: true, side, left, top: placed.top + 48 }
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
        // The coordinate space, not the column: `chatRect` is relative to the
        // overlay (which spans the whole frame), so the far edge of the usable
        // area is the overlay's own width. Using the column's width here
        // under-reported the right gutter by one sidebar and made a 'right'
        // preference fail its width test on any window with a left sidebar.
        viewportWidth:
          frame === null || Number.isFinite(frame.width) === false || frame.width <= 0
            ? Math.round(contentRect.width)
            : Math.round(frame.width),
      }
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
                    title: "Collapse these cards",
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
                  jsx("button", {
                    className: "dsse-btn",
                    type: "button",
                    disabled: busy || sessionId === "",
                    title: "让模型判断这一轮是否值得沉淀成技能",
                    onClick: propose,
                    children: busy ? "询问中…" : "建议提炼",
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
                ? jsx("p", { className: "dsse-muted dsse-tiny", children: "没有可见技能。" })
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
          viewportWidth: geometry.viewportWidth,
          side: bridge.side,
          cardWidth: CARD_WIDTH,
        })
        setPlace(next)
        setHandle(placeHandle({ chatRect: geometry.chatRect, viewportWidth: geometry.viewportWidth, side: next.side }))
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
            title: "Show the skill-evolve cards",
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
