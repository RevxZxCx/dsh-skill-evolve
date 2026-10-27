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
     * Draws the three-module panel: what the last turn produced, what skills and
     * MCP servers are on offer, and which files that turn touched.
     *
     * ## Why a fixed column rather than a layout child
     *
     * The host exposes no slot that is a *column inside the conversation region*.
     * `conversation.content` is a single-occupancy factory — registering there
     * replaces the entire conversation body, which is the host's own thing to
     * draw, not a plugin's. Everything else in the conversation is a row or a
     * corner.
     *
     * So the panel docks to the right edge and reserves its own width by adding
     * padding to `[data-conversation-content]` while it is open. The effect is
     * the one the user asked for — the panel reads as part of the conversation,
     * not as a drawer laid over it — using only a selector the host already
     * publishes as a stable hook. When the panel is closed the padding rule is
     * inert, so nothing about the host's layout changes in the default state.
     *
     * ## What it may require
     *
     * Only the baseline the shared module table carries: `react` and
     * `react/jsx-runtime`. A bundle that reaches for anything else fails to
     * materialise, and the failure surfaces as a broken entry on the Plugins
     * page rather than as a blank panel.
     */

    const NS = "dsh-skill-evolve"
    const PANEL_ID = "dsh-skill-evolve:panel"
    const TOGGLE_ID = "dsh-skill-evolve:toggle"
    const GUTTER = 332
    const REFRESH_MS = 8000

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
.dsse-panel{position:fixed;top:0;right:0;bottom:0;width:${GUTTER}px;z-index:60;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);border-left:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.1));font:400 12px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#0f1115)}
body[data-dsse-panel="open"] [data-conversation-content]{padding-right:${GUTTER}px}
.dsse-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.08))}
.dsse-title{flex:1;font:600 12px/1.2 inherit}
.dsse-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5a6274);cursor:pointer;font:400 15px/1 inherit;padding:2px 4px;border-radius:5px}
.dsse-close:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-scroll{flex:1;overflow-y:auto;padding:10px 12px 24px}
.dsse-mod{margin-bottom:16px}
.dsse-mod-head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.dsse-mod-name{flex:1;font:600 11px/1.2 inherit;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#5a6274)}
.dsse-badge{display:inline-block;padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-secondary,#5a6274);font:500 10px/15px inherit}
.dsse-badge-own{background:var(--dsw-alias-bg-brand,rgba(77,107,254,.14));color:var(--dsw-alias-label-brand,#2f4bd8)}
.dsse-text{margin:0;color:var(--dsw-alias-label-primary,#0f1115);white-space:pre-wrap;word-break:break-word}
.dsse-muted{color:var(--dsw-alias-label-secondary,#5a6274)}
.dsse-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.05))}
.dsse-row:last-child{border-bottom:0}
.dsse-row-main{flex:1;min-width:0}
.dsse-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsse-where{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary,#8b93a3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsse-size{font:500 10px/1 inherit;color:var(--dsw-alias-label-tertiary,#8b93a3);white-space:nowrap}
.dsse-btn{border:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);border-radius:6px;padding:3px 8px;font:500 11px/1.4 inherit;cursor:pointer;white-space:nowrap}
.dsse-btn:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-btn:disabled{opacity:.5;cursor:default}
.dsse-more{border:0;background:transparent;color:var(--dsw-alias-label-brand,#2f4bd8);font:500 11px/1.4 inherit;cursor:pointer;padding:4px 0}
.dsse-foot{display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.08));font-size:10px;color:var(--dsw-alias-label-tertiary,#8b93a3)}
.dsse-select{max-width:150px;border:1px solid var(--dsw-alias-border-secondary,rgba(15,17,21,.12));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:400 11px/1.4 inherit;padding:2px 4px}
.dsse-err{margin:0 0 8px;padding:7px 9px;border-radius:7px;background:var(--dsw-alias-bg-danger-subtle,rgba(214,58,58,.09));color:var(--dsw-alias-label-danger,#c02b2b);word-break:break-word}
.dsse-label{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#5a6274);margin-top:6px}
.dsse-check{accent-color:var(--dsw-alias-label-brand,#2f4bd8)}
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
     * Which session the panel is describing.
     *
     * The toggle sits in a session-scoped slot and therefore knows the session
     * id, while the panel itself is mounted outside the conversation and does
     * not. This module-level value bridges the two: the toggle publishes, the
     * panel subscribes. It is a plain variable rather than state because the
     * panel re-reads it on every fetch, and a stale id would only cost one
     * discarded response.
     */
    const bridge = { sessionId: "", open: false, listeners: new Set() }

    /**
     * Publish a change to everything drawing the panel.
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

    /**
     * The panel's three modules plus the chrome around them.
     *
     * Every field is read from one `/panel` response on purpose: the summary
     * belongs to a turn, and fetching the modules separately would let the
     * panel show turn 4's summary beside turn 3's files.
     *
     * @returns {object} the element.
     */
    function Panel() {
      const [state, setState] = React.useState({ status: "loading" })
      const [config, setConfig] = React.useState(undefined)
      const [models, setModels] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState("")
      const [filesOpen, setFilesOpen] = React.useState(false)

      const sessionId = bridge.sessionId

      /**
       * Pull the current panel payload.
       *
       * Failures are shown rather than swallowed: a panel that silently renders
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
            // The panel works without them; only the two settings controls are
            // unavailable, and they render disabled rather than missing.
          })
        return () => {
          live = false
        }
      }, [])

      /**
       * Persist one panel setting.
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
      const shown = filesOpen ? ordered : ordered.slice(0, 6)

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
        className: "dsse-panel",
        "data-dsse-panel": "1",
        children: [
          jsxs("div", {
            className: "dsse-head",
            children: [
              jsx("span", { className: "dsse-title", children: "Skill Evolve" }),
              jsx("button", {
                className: "dsse-close",
                type: "button",
                title: "Hide panel",
                onClick: () => {
                  bridge.open = false
                  if (typeof document !== "undefined") document.body.removeAttribute("data-dsse-panel")
                  notify()
                },
                children: "\u00d7",
              }),
            ],
          }),
          jsxs("div", {
            className: "dsse-scroll",
            children: [
              error === "" ? null : jsx("p", { className: "dsse-err", children: error }),

              jsxs("div", {
                className: "dsse-mod",
                children: [
                  jsxs("div", {
                    className: "dsse-mod-head",
                    children: [
                      jsx("span", { className: "dsse-mod-name", children: "Last turn" }),
                      jsx("span", {
                        className: "dsse-badge",
                        children:
                          data === undefined
                            ? "-"
                            : `turn ${data.turn ?? 0} \u00b7 ${data.calls ?? 0} calls${data.failed > 0 ? ` \u00b7 ${data.failed} failed` : ""}`,
                      }),
                    ],
                  }),
                  jsx("p", { className: "dsse-text", children: summaryText }),
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
                          "summarise each turn",
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
                            jsx("option", { value: "", children: "summariser: default model" }),
                            ...providerOptions.map((option) =>
                              jsx("option", { value: option.value, children: option.label }, option.value),
                            ),
                          ],
                        }),
                      }),
                ],
              }),

              jsxs("div", {
                className: "dsse-mod",
                children: [
                  jsxs("div", {
                    className: "dsse-mod-head",
                    children: [
                      jsx("span", { className: "dsse-mod-name", children: "Skills" }),
                      jsx("span", {
                        className: "dsse-badge",
                        children:
                          data?.skills?.available === false
                            ? "unavailable"
                            : `${skills.length}${data?.pendingCandidates > 0 ? ` \u00b7 ${data.pendingCandidates} queued` : ""}`,
                      }),
                      jsx("button", {
                        className: "dsse-btn",
                        type: "button",
                        disabled: busy || sessionId === "",
                        title: "Ask the model whether this turn taught it a reusable procedure",
                        onClick: propose,
                        children: busy ? "asking\u2026" : "suggest a skill",
                      }),
                    ],
                  }),
                  data?.skills?.available === false
                    ? jsx("p", { className: "dsse-muted", children: String(data.skills.reason ?? "no skill registry") })
                    : null,
                  skills.length === 0 && data?.skills?.available !== false
                    ? jsx("p", { className: "dsse-muted", children: "No skills on offer." })
                    : null,
                  ...skills.map((skill) =>
                    jsxs(
                      "div",
                      {
                        className: "dsse-row",
                        children: [
                          jsxs("span", {
                            className: "dsse-row-main",
                            children: [
                              jsx("span", { className: "dsse-name", children: skill.name }),
                              skill.description === ""
                                ? null
                                : jsx("span", {
                                    className: "dsse-where",
                                    children:
                                      String(skill.description).length > 90
                                        ? `${String(skill.description).slice(0, 89)}\u2026`
                                        : skill.description,
                                  }),
                            ],
                          }),
                          skill.owned === true
                            ? jsx("span", { className: "dsse-badge dsse-badge-own", children: "captured" })
                            : null,
                        ],
                      },
                      `skill:${skill.name}`,
                    ),
                  ),
                ],
              }),

              jsxs("div", {
                className: "dsse-mod",
                children: [
                  jsxs("div", {
                    className: "dsse-mod-head",
                    children: [
                      jsx("span", { className: "dsse-mod-name", children: "MCP" }),
                      jsx("span", { className: "dsse-badge", children: String(mcp.length) }),
                    ],
                  }),
                  mcp.length === 0
                    ? jsx("p", { className: "dsse-muted", children: "No MCP server answered in this session." })
                    : null,
                  ...mcp.map((server) =>
                    jsxs(
                      "div",
                      {
                        className: "dsse-row",
                        children: [
                          jsx("span", { className: "dsse-row-main", children: jsx("span", { className: "dsse-name", children: server.server }) }),
                          jsx("span", { className: "dsse-size", children: `${server.tools} tools` }),
                        ],
                      },
                      `mcp:${server.server}`,
                    ),
                  ),
                ],
              }),

              jsxs("div", {
                className: "dsse-mod",
                children: [
                  jsxs("div", {
                    className: "dsse-mod-head",
                    children: [
                      jsx("span", { className: "dsse-mod-name", children: "Files touched" }),
                      jsx("span", { className: "dsse-badge", children: String(ordered.length) }),
                    ],
                  }),
                  ordered.length === 0
                    ? jsx("p", { className: "dsse-muted", children: "The last turn did not name a file." })
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
                              jsx("span", {
                                className: "dsse-name",
                                title: String(file.path),
                                children: parts.name,
                              }),
                              parts.where === ""
                                ? null
                                : jsx("span", { className: "dsse-where", children: parts.where }),
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
                        children: filesOpen ? "show fewer" : `show all ${ordered.length}`,
                      })
                    : null,
                ],
              }),
            ],
          }),
          jsxs("div", {
            className: "dsse-foot",
            children: [
              jsx("span", {
                children: state.status === "loading" ? "refreshing\u2026" : `refreshed ${new Date().toLocaleTimeString()}`,
              }),
            ],
          }),
        ],
      })
    }

    /**
     * The header button that opens the panel.
     *
     * Session-scoped, so it exists only while a conversation is on screen — the
     * panel describes a conversation and has nothing to say on the launcher.
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
        // The panel is mounted outside the conversation, so the header is where
        // it learns which session is on screen. Doing this on render rather than
        // on click keeps the panel correct when the user switches conversation
        // with it already open.
        if (sessionId !== "" && bridge.sessionId !== sessionId) {
          bridge.sessionId = sessionId
          notify()
        }
      }, [sessionId])

      const open = bridge.open === true && bridge.sessionId === sessionId

      return jsxs("button", {
        className: "dsse-toggle",
        type: "button",
        "data-active": String(open),
        title: "Skill Evolve panel: last turn, skills, files",
        onClick: () => {
          bridge.sessionId = sessionId
          const next = open === false
          bridge.open = next
          if (typeof document !== "undefined") {
            if (next) document.body.setAttribute("data-dsse-panel", "open")
            else document.body.removeAttribute("data-dsse-panel")
          }
          notify()
        },
        children: ["Skills", jsx("span", { className: "dsse-toggle-count", children: "3" })],
      })
    }

    /**
     * Draw the panel only while it is open, and never without a session.
     *
     * Mounted in `shell.overlay`, which is a root-scope layer: it renders whether
     * or not a conversation is open, so this wrapper is what keeps the panel from
     * floating over the launcher.
     *
     * @returns {object | null} the element, or null when closed.
     */
    function Overlay() {
      const [tick, force] = React.useState(0)
      React.useEffect(() => subscribe(() => force((value) => value + 1)), [])
      React.useEffect(() => {
        if (bridge.open !== true && typeof document !== "undefined") {
          document.body.removeAttribute("data-dsse-panel")
        }
      }, [tick])
      if (bridge.open !== true || bridge.sessionId === "") return null
      return jsx(Panel, {})
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
        "skill-evolve: panel overlay",
      )

      ctx.effect(
        () => () => {
          bridge.open = false
          bridge.listeners.clear()
          if (typeof document !== "undefined") {
            document.body.removeAttribute("data-dsse-panel")
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
