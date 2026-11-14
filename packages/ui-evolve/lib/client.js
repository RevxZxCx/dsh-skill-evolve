window.__ModuleLoader__.load({
  id: "@revxz/dsh-ui-evolve",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require("react")
    const { jsx, jsxs } = require("react/jsx-runtime")

    /**
     * Client half of @revxz/dsh-ui-evolve.
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

    const NS = "@revxz/dsh-ui-evolve"
    const PANEL_ID = "@revxz/dsh-ui-evolve:cards"
    const TOGGLE_ID = "@revxz/dsh-ui-evolve:toggle"
    const REFRESH_MS = 8000
    const CARD_WIDTH = 288

    /**
     * How many output files the card lists before the fold.
     *
     * Four, the same number the Host's own changed-files card uses for the
     * summary above a closing message. The card sits in a narrow column beside
     * the conversation and has to leave the other two cards in view, so the
     * folded state is the state it will be read in most of the time.
     */
    const FOLDED_FILES = 4

    /**
     * The tallest the expanded file list may get before it scrolls.
     *
     * Only applies once the reader has opened the card: at that point the list
     * is the thing being read, and a session with forty files should not push
     * the other cards off the column. Eight rows is two folded states' worth,
     * which is enough that opening a five-file list never scrolls.
     *
     * Written as rows rather than pixels so it stays tied to the row height the
     * stylesheet sets: eight rows of 28px with a 3px gap is 8 × 28 + 7 × 3.
     *
     * The row got shorter in S2, and this constant has to follow it: the height
     * here is a promise about how many rows fit before the list scrolls, and a
     * stale number would either scroll early (leaving a gap) or scroll late
     * (hiding a row that the count says is visible).
     */
    const FILE_LIST_MAX_PX = 8 * 28 + 7 * 3

    /**
     * How often the speed badge asks while the model is writing.
     *
     * A quarter of a second: the number moves once per delta, and anything
     * slower than about four updates a second reads as a stutter rather than as
     * a rate. It is also cheap — the answer is two integers computed from a
     * two-second window, not a document.
     */
    const SPEED_FAST_MS = 250

    /**
     * How often it asks back while a reply is arriving but no text is.
     *
     * A reply pauses between paragraphs and while a tool call is assembled, so
     * the window empties for a second or two in the middle of a turn. Asking
     * again after two seconds is quick enough to catch the next paragraph and
     * slow enough not to be the reason a quiet second is expensive.
     */
    const SPEED_SLOW_MS = 2000

    /**
     * How long the server is willing to hold a speed request open.
     *
     * The client has to agree with the server on this, or one of them gives up
     * on a request the other is still deliberately not answering. Matching the
     * server's `SPEED_WAIT_MS` is the whole of the contract, and it is also the
     * signal read back off a response: an answer that took about this long
     * means the request really was held, so the host honours `after` and the
     * next one can be sent at once. An answer that came back immediately means
     * this host answered without waiting, and asking again at once would spin.
     *
     * It is not a poll interval. An idle badge holds one request open rather
     * than making thirty small ones, which is what makes it free to be late
     * never rather than late by up to a poll interval: the server answers the
     * moment the meter moves.
     */
    const SPEED_WAIT_MS = 25000

    /**
     * How often it asks after a failure.
     *
     * A failed request means the route is missing (an older host half) or the
     * host is restarting. Knocking on either at the live rate is a waste, and
     * knocking at the idle rate would still be a request every ten seconds
     * forever for an answer that is never coming — but stopping is worse,
     * because a restart is temporary and the badge has to come back on its own.
     *
     * Deliberately not `REFRESH_MS`: two timers on the same beat are one timer
     * you cannot reason about. Anything that later has to tell "the panel
     * polled" from "the badge polled" — a test filtering recorded timers by
     * delay, a profile of who is asking — has only the number to go on.
     */
    const SPEED_IDLE_MS = 10000

    /**
     * How long the last real number stays on screen after the window empties.
     *
     * The moment a person most wants to read the speed is the moment the reply
     * stops, and clearing it on the last delta takes it away exactly then.
     */
    const SPEED_LINGER_MS = 4000

    /**
     * Resolve a plugin route against the page's own base.
     *
     * The GUI can be mounted under a path prefix, so `/api/...` is not
     * necessarily rooted at the origin. `document.baseURI` is the host's own
     * answer to "where am I served from", which is why the round-trip below
     * strips the leading slash before resolving: `new URL("/api", base)` would
     * throw the prefix away, `new URL("api", base)` keeps it.
     *
     * @param {string} path - an absolute-looking route, e.g. `/api/ui-evolve/panel`.
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
     * @param {string} path - the route below `/api/ui-evolve`.
     * @param {object} [options] - fetch options.
     * @returns {Promise<any>} the payload.
     */
    async function call(path, options) {
      const response = await fetch(resolveUrl(`/api/ui-evolve${path}`), {
        credentials: "same-origin",
        ...options,
      })
      return unwrap(response)
    }

    /**
     * Format a tokens-per-second reading for the badge.
     *
     * Two significant-ish digits under ten, whole numbers above it, matching
     * what the host's own pill does — a live number that flickers between `47.3`
     * and `47` is noise, and one that reads `3` instead of `2.7` is a worse
     * answer to "is it moving".
     *
     * @param {number} tps - tokens per second.
     * @returns {string} e.g. `47`, `2.7`.
     */
    function formatSpeed(tps) {
      const value = Math.max(0, tps)
      if (value >= 10) return String(Math.round(value))
      return String(Math.round(value * 10) / 10)
    }

    /**
     * Turn a summary's failure reason into something the reader can act on.
     *
     * The reasons come from `summarise.js` and are English prose written for a
     * log: "no model route is available", "the summary call failed: 401". Shown
     * verbatim in a Chinese card they read as a crash, so the card says what to
     * do instead and keeps the original in the row's title, where it costs no
     * space and is still reachable.
     *
     * Prefix matching, not equality, and that is the whole reason this is a
     * function rather than a lookup table: the failure path interpolates the
     * provider's message (`the summary call failed: ${message}`), so an exact
     * match would miss every real failure and silently fall through to the
     * generic line. The generic line is a floor, not an answer.
     *
     * @param {string} reason - the reason from the panel payload.
     * @returns {{ text: string, detail: string }} what to show, and the original.
     */
    function summaryReasonText(reason) {
      const raw = typeof reason === "string" ? reason.trim() : ""
      const detail = raw === "" ? "" : raw
      if (raw === "") return { text: "暂无摘要", detail }
      if (raw.startsWith("turned off")) return { text: "摘要已在设置中关闭", detail }
      if (raw.startsWith("no completed turn")) return { text: "还没有完成的回合", detail }
      if (raw.startsWith("the turn left nothing")) return { text: "这一轮没有可总结的内容", detail }
      if (raw.startsWith("no model service")) return { text: "宿主没有可用的模型服务", detail }
      if (raw.startsWith("no model route")) return { text: "没有可用的模型路由，请先在设置里指定摘要模型", detail }
      if (raw.startsWith("the summary call timed out")) return { text: "摘要生成超时，稍后会自动重试", detail }
      if (raw.startsWith("the model returned nothing")) return { text: "模型没有返回内容", detail }
      if (raw.startsWith("the summary call failed")) return { text: "摘要生成失败", detail }
      if (raw.startsWith("the model call failed")) return { text: "摘要生成失败", detail }
      if (raw === "open a conversation first") return { text: "先打开一个会话", detail: "" }
      return { text: "暂无摘要", detail }
    }

    /**
     * Render a timestamp as how long ago it was.
     *
     * Relative rather than absolute because the only question the card answers
     * is whether the summary still describes the work in front of you — "3 分钟
     * 前" answers it, "14:32" makes the reader do arithmetic against a clock
     * they then have to find.
     *
     * `Intl.RelativeTimeFormat` is used when the host has it and a plain floor
     * of minutes otherwise; an unknown `at` yields `""` so the caller can drop
     * the whole line rather than print a placeholder.
     *
     * @param {number | undefined} at - epoch milliseconds.
     * @returns {string} e.g. `刚刚`, or `""`.
     */
    function formatAgo(at) {
      if (typeof at !== "number" || Number.isFinite(at) === false || at <= 0) return ""
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (seconds < 45) return "刚刚"
      const steps = [
        { limit: 45 * 60, divisor: 60, unit: "minute" },
        { limit: 22 * 3600, divisor: 3600, unit: "hour" },
        { limit: 26 * 86400, divisor: 86400, unit: "day" },
      ]
      for (const step of steps) {
        if (seconds < step.limit) {
          const value = -Math.round(seconds / step.divisor)
          try {
            if (typeof Intl === "object" && typeof Intl.RelativeTimeFormat === "function") {
              return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(value, step.unit)
            }
          } catch {
            // A host whose Intl lacks the unit data is not a reason to lose the
            // line; fall through to the arithmetic below.
          }
          const unitText = step.unit === "minute" ? "分钟前" : step.unit === "hour" ? "小时前" : "天前"
          return `${Math.abs(value)} ${unitText}`
        }
      }
      const days = Math.round(seconds / 86400)
      return `${days} 天前`
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

    /**
     * The name of a file and the directory it sits in, as the row shows them.
     *
     * Same question as `splitPath`, with one more thing to answer it from: the
     * session's workspace. When the file is inside it, the directory is the one
     * the reader would type — `src/lib`, not `Users/me/projects/app/src/lib`.
     * Three tail segments are a guess at what disambiguates; the workspace is the
     * answer. A file at the workspace root has no directory to show, so the row
     * spends that width on the name instead.
     *
     * Falling back to `splitPath` matters: `cwd` is a field a newer server sends,
     * and a client talking to an older one still has to draw something sane.
     *
     * @param {string} path - an absolute path.
     * @param {string} cwd - the workspace root, or `""` when it is unknown.
     * @returns {{ name: string, where: string }} the two halves.
     */
    function fileParts(path, cwd) {
      if (typeof path !== "string" || path.length === 0) return { name: "", where: "" }
      const normal = path.split("\\").join("/")
      const root = typeof cwd === "string" && cwd.length > 0 ? cwd.split("\\").join("/").replace(/\/+$/u, "") : ""
      if (root !== "") {
        const prefix = root + "/"
        // Compared without case, sliced with it. Windows paths are
        // case-insensitive and the two halves arrive from different places: the
        // workspace from the session header, the file from whatever a tool was
        // handed. A turn that writes `C:/Work/src/a.ts` into a session whose
        // header says `c:\work` means the same file, and would otherwise show its
        // whole absolute path as the directory — beside rows showing `src`.
        if (normal.toLowerCase().startsWith(prefix.toLowerCase()) === true) {
          const inside = normal.slice(prefix.length).split("/").filter((part) => part.length > 0)
          if (inside.length > 0) {
            return { name: inside[inside.length - 1], where: inside.slice(0, inside.length - 1).join("/") }
          }
        }
      }
      return splitPath(path)
    }

    /**
     * Which glyph a file gets, by extension.
     *
     * Eight buckets, not eighty: the row is 28 pixels tall and the icon answers
     * "what kind of thing is this" at a glance, not "which language exactly". The
     * buckets are chosen so that a wrong guess is impossible to make — a `.json`
     * and a `.yaml` really are both structured data — and everything unlisted
     * lands on the blank page rather than on a guess. A wrong icon is worse than a
     * generic one: it tells the reader something false about a file they wrote.
     *
     * @param {string} name - the file name, extension included.
     * @returns {string} one of `code`, `markup`, `style`, `data`, `doc`, `image`,
     *   `archive`, `file`.
     */
    function fileBucket(name) {
      if (typeof name !== "string") return "file"
      const dot = name.lastIndexOf(".")
      if (dot <= 0 || dot === name.length - 1) return "file"
      const ext = name.slice(dot + 1).toLowerCase()
      if (CODE_EXTENSIONS.has(ext) === true) return "code"
      if (MARKUP_EXTENSIONS.has(ext) === true) return "markup"
      if (STYLE_EXTENSIONS.has(ext) === true) return "style"
      if (DATA_EXTENSIONS.has(ext) === true) return "data"
      if (DOC_EXTENSIONS.has(ext) === true) return "doc"
      if (IMAGE_EXTENSIONS.has(ext) === true) return "image"
      if (ARCHIVE_EXTENSIONS.has(ext) === true) return "archive"
      return "file"
    }

    // Extensions are the only evidence a row has, so these lists are the whole
    // classifier. They are deliberately generous inside a bucket and deliberately
    // empty across them: a name appears in exactly one set, so the answer cannot
    // depend on the order the checks run in.
    const CODE_EXTENSIONS = new Set([
      "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "py", "rb", "go", "rs",
      "java", "kt", "kts", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "php",
      "swift", "m", "mm", "scala", "clj", "cljs", "ex", "exs", "erl", "hs", "lua",
      "pl", "pm", "r", "jl", "dart", "vue", "svelte", "astro", "sh", "bash", "zsh",
      "fish", "ps1", "bat", "cmd", "asm", "sol", "zig", "nim", "cr",
    ])
    const MARKUP_EXTENSIONS = new Set(["html", "htm", "xhtml", "xml", "xsl", "xslt", "plist", "rss", "atom"])
    const STYLE_EXTENSIONS = new Set(["css", "scss", "sass", "less", "styl", "stylus", "pcss"])
    const DATA_EXTENSIONS = new Set([
      "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
      "csv", "tsv", "sql", "db", "sqlite", "lock", "ndjson", "jsonl", "avro", "parquet",
    ])
    const DOC_EXTENSIONS = new Set(["md", "markdown", "mdx", "txt", "rst", "adoc", "asciidoc", "tex", "pdf", "doc", "docx", "rtf", "odt", "org"])
    const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "avif", "svg", "tif", "tiff", "psd", "heic"])
    const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "jar", "war", "whl", "nupkg", "vsix", "apk", "ipa"])

    /**
     * One outline per bucket, on the same 24-unit grid as `Icon`.
     *
     * These used to share a page silhouette and differ only in a small mark on
     * it. At fourteen pixels that mark was under four pixels wide — the eight
     * buckets were, in practice, one page. So the silhouettes themselves differ
     * now: braces for code, angle brackets for markup, a hash for style, a grid
     * for data, ruled lines for prose, a hill and a sun for pictures, a box for
     * archives, and the page kept for the bucket that knows nothing.
     *
     * @type {Record<string, string[]>}
     */
    const FILE_MARKS = {
      code: ['M10 4.5c-2.6 0-2.6 7.5-5.4 7.5 2.8 0 2.8 7.5 5.4 7.5M14 4.5c2.6 0 2.6 7.5 5.4 7.5-2.8 0-2.8 7.5-5.4 7.5'],
      markup: ['M9.5 4.5L3.5 12l6 7.5M14.5 4.5l6 7.5-6 7.5'],
      style: ['M10.4 3.5L7.6 20.5M16.4 3.5l-2.8 17M3.5 9h17M3.5 15h17'],
      data: ['M3.5 5h17v14h-17zM3.5 10h17M3.5 14.5h17M9.2 5v14M14.8 5v14'],
      doc: ['M5 3.5h14v17H5zM8.5 8h7M8.5 12h7M8.5 16h4'],
      image: ['M3.5 18.5l4.8-6.2 3.7 4.4 2.9-3.5 5.6 5.3z'],
      archive: ['M4 8.5h16M4 8.5v11h16v-11M10 8.5V4.5h4v4M12 11.5v5M10.8 11.5h2.4'],
      file: ['M5 3.5h10l4 4v13H5zM15 3.5v4h4'],
    }

    /**
     * The glyph for one file row.
     *
     * Kept apart from `Icon` on purpose. `Icon` is the panel's own vocabulary —
     * close, refresh, settings — and it is a chain of `if`s that returns one of a
     * dozen marks. Eight file types spliced into that chain would turn one list of
     * controls into two unrelated ones and make every future lookup slower.
     *
     * Drawn in the same grammar as `Icon` — a 24-unit grid, no fill, `currentColor`
     * inherited from the row, round caps and joins — but one step bolder: a sixth
     * of a pixel more stroke, at sixteen rather than fourteen. The bucket also
     * picks a colour, which is the one place this card stops being monochrome.
     * Colour is carried by the class name's sibling attribute rather than by the
     * `stroke` attribute so a missing row can drop it back to grey in CSS; an
     * inline attribute would win the cascade and leave a bright icon beside
     * struck-through grey text.
     *
     * @param {{ name: string }} props - the file name, extension included.
     * @returns {any} the svg.
     */
    function FileIcon(props) {
      const bucket = fileBucket(props?.name)
      const marks = Object.prototype.hasOwnProperty.call(FILE_MARKS, bucket) === true ? FILE_MARKS[bucket] : FILE_MARKS.file
      const children = marks.map((d, index) => jsx('path', { key: `mark${index}`, d }))
      if (bucket === 'image') {
        children.push(jsx('circle', { key: 'sun', cx: '7.8', cy: '7.4', r: '2.2' }))
      }
      return jsxs('svg', { className: 'dsse-fileicon', 'data-bucket': bucket, viewBox: '0 0 24 24', 'aria-hidden': 'true', children })
    }

    const CSS = `
.dsse-toggle{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--dsse-font-family,inherit);font-size:var(--dsse-font-size,inherit);line-height:var(--dsse-line-height,inherit);font-weight:500;cursor:pointer;white-space:nowrap}
.dsse-toggle:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-toggle[data-active="true"],.dsse-toggle-count{background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.12));color:var(--dsw-alias-state-business-primary,#2f4bd8)}
.dsse-toggle[data-active="true"]{border-color:var(--dsw-alias-state-business-primary,rgba(77,107,254,.5))}
.dsse-toggle-count{display:inline-block;min-width:20px;padding:1px 6px;border-radius:999px;font-size:max(.85em,11px);text-align:center}
.dsse-rail{position:absolute;display:flex;flex-direction:column;gap:12px;overflow-y:auto;overflow-x:hidden;padding:0 2px 0 0;scrollbar-width:thin;font-family:var(--dsse-font-family,inherit);font-size:var(--dsse-font-size,inherit);line-height:var(--dsse-line-height,inherit);color:var(--dsw-alias-label-primary,#0f1115)}
.dsse-rail::-webkit-scrollbar,.dsse-candidates::-webkit-scrollbar,.dsse-detail-body::-webkit-scrollbar{width:6px}
.dsse-rail::-webkit-scrollbar-thumb,.dsse-candidates::-webkit-scrollbar-thumb,.dsse-detail-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(15,17,21,.16));border-radius:3px}
.dsse-top-row{flex:0 0 auto;display:flex;align-items:center;gap:6px;min-height:40px;padding:2px 4px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 2px 8px rgba(15,17,21,.04)}
.dsse-top-row .dsse-queue{width:auto;min-height:32px;margin-left:auto;padding:0 12px}
.dsse-top-row .dsse-speed{flex:0 0 auto;margin-left:auto;display:inline-flex;align-items:baseline;gap:3px;min-width:44px;justify-content:center;padding:0 4px;color:var(--dsw-alias-label-secondary,#5b6270);font-size:max(.78em,11px);font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;user-select:none;white-space:nowrap}
.dsse-top-row .dsse-speed-idle{color:var(--dsw-alias-label-tertiary,#8b92a1);opacity:.7}
.dsse-top-row .dsse-speed-previous{opacity:.85}
.dsse-top-row .dsse-speed-unit{color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.68em,9px)}
.dsse-icon-btn{width:36px;height:36px;display:inline-grid;place-items:center;flex:0 0 auto;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6270);cursor:pointer;transition:background-color 160ms ease,color 160ms ease}
.dsse-icon-btn:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-primary,#0f1115)}
.dsse-icon{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.dsse-queue{flex:0 0 auto;min-height:44px;display:flex;align-items:center;gap:8px;width:100%;padding:8px 11px;border:1px solid var(--dsw-alias-state-business-primary,rgba(77,107,254,.25));border-radius:10px;background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.07));color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-weight:500;text-align:left;cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease}
.dsse-queue:hover{background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.13));border-color:var(--dsw-alias-state-business-primary,rgba(77,107,254,.5))}
.dsse-review-root{display:contents}
.dsse-count{display:inline-block;min-width:22px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.14));color:var(--dsw-alias-state-business-primary,#2f4bd8);font-size:max(.85em,11px);text-align:center}
.dsse-card[data-clickable="true"]{cursor:pointer}
.dsse-card[data-clickable="true"]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2f4bd8);outline-offset:-2px}
.dsse-card{position:relative;flex:0 0 auto;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.1));border-radius:11px;box-shadow:0 2px 8px rgba(15,17,21,.04);overflow:hidden}
.dsse-card-head{display:flex;align-items:baseline;gap:8px;padding:7px 11px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.07))}
.dsse-card-title{margin:0;font-size:.94em;line-height:1.4;font-weight:600;white-space:nowrap}
.dsse-card-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px);text-align:right}
.dsse-card-head .dsse-icon-btn{width:30px;height:30px;border-radius:7px;align-self:center}
.dsse-head-stats{display:flex;align-items:baseline;gap:8px;margin-left:auto;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px);white-space:nowrap;min-width:0;overflow:hidden}
.dsse-head-stat{display:inline-flex;align-items:baseline;gap:3px;flex:0 0 auto}
.dsse-head-stat b{color:var(--dsw-alias-label-primary,#0f1115);font-weight:600;font-variant-numeric:tabular-nums}
.dsse-head-ago{color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.78em,10px);white-space:nowrap;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsse-clip{position:relative;overflow:hidden}
.dsse-clip[data-clipped="true"][data-expanded="false"]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:34px;pointer-events:none;background:linear-gradient(to bottom,transparent,var(--dsw-alias-bg-layer-1,#fff))}
.dsse-clip .dsse-text{max-height:9.3em;overflow:hidden}
.dsse-clip[data-expanded="true"] .dsse-text{max-height:none}
.dsse-card-body{padding:11px}
.dsse-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dsse-summary-title{margin:0 0 6px;font-size:1em;line-height:1.45;font-weight:500}
.dsse-muted{color:var(--dsw-alias-label-secondary,#5b6270)}
.dsse-tiny{font-size:.86em;line-height:1.55}
.dsse-expand{box-sizing:border-box;position:absolute;left:50%;transform:translateX(-50%);bottom:8px;display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#5b6270);box-shadow:0 1px 3px rgba(15,17,21,.10);user-select:none;pointer-events:none}
.dsse-expand .dsse-icon{width:15px;height:15px}
.dsse-card[aria-expanded="true"] .dsse-card-body{padding-bottom:44px}
.dsse-expand-action{pointer-events:auto;cursor:pointer;padding:0;font:inherit}
.dsse-expand-action:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-expand-action:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#2f4bd8);outline-offset:2px}
.dsse-card[data-badge="true"] .dsse-card-body{padding-bottom:44px}
.dsse-loading{margin:0;padding:8px 4px;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px)}
.dsse-list{display:grid;gap:3px}
.dsse-row{display:flex;align-items:center;gap:6px;min-width:0;min-height:28px;padding:2px 6px;border-radius:7px;box-sizing:border-box}
.dsse-row:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
/* .dsse-row-icon deliberately has no rule: it is the wrapper the skill rows put
   around Icon, and Icon already sizes itself. An earlier pass gave this class
   a width here and quietly shrank those rows to 14px. */
/* The glyph is the only colour on this card, and only as a grouping cue: eight
   buckets, eight hues, all at low saturation so they read as tints of grey rather
   than as a second palette. Size goes to 16px here because a 14px row cannot show
   an outline's shape — the shape is the whole point of having eight of them. */
.dsse-fileicon{width:16px;height:16px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;color:var(--dsw-alias-label-tertiary,#8b92a1)}
.dsse-fileicon[data-bucket="code"]{color:#4c7fb8}
.dsse-fileicon[data-bucket="markup"]{color:#b06a4a}
.dsse-fileicon[data-bucket="style"]{color:#8a6aa8}
.dsse-fileicon[data-bucket="data"]{color:#2f8a72}
.dsse-fileicon[data-bucket="image"]{color:#a8654f}
.dsse-fileicon[data-bucket="archive"]{color:#b08a3e}
/* doc and file stay grey on purpose: they are the two buckets that make no claim
   about what the file is worth reading as. */
.dsse-row[data-status="missing"] .dsse-fileicon,.dsse-row[data-status="invalid"] .dsse-fileicon{color:var(--dsw-alias-label-tertiary,#8b92a1)}
.dsse-row-main{flex:1;min-width:0}
.dsse-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsse-font-mono,var(--dsse-font-family,inherit));font-size:max(.9em,12px)}
/* The directory is not drawn on the row any more: at 320px it cost the name
   more than it was worth, and two rows with one name are rare enough that a
   hover can answer "which one" on the one occasion it comes up. It stays in
   the markup, hidden from sight but not from assistive technology, because the
   tooltip is a pointer-only affordance and a screen reader still needs to hear
   which directory a row came from. */
.dsse-where{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.dsse-size{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px);white-space:nowrap}
.dsse-files{display:grid;gap:3px}
.dsse-files[data-open="true"]{max-height:${FILE_LIST_MAX_PX}px;overflow-y:auto;overscroll-behavior:contain}
.dsse-row-open{width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsse-row-open:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#2f4bd8);outline-offset:-2px}
.dsse-group{display:grid;gap:3px}
.dsse-group + .dsse-group{margin-top:6px}
.dsse-group-label{margin:0;padding:2px 6px 0;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.8em,10px);letter-spacing:.02em}
.dsse-row[data-noise="true"] .dsse-name{color:var(--dsw-alias-label-tertiary,#8b92a1)}
.dsse-row[data-status="missing"] .dsse-name,.dsse-row[data-status="invalid"] .dsse-name{color:var(--dsw-alias-label-tertiary,#8b92a1);text-decoration:line-through}

.dsse-row[data-status="missing"],.dsse-row[data-status="invalid"]{cursor:default}
.dsse-row[data-status="missing"]:hover,.dsse-row[data-status="invalid"]:hover{background:transparent}
.dsse-size-gone{font-style:italic}
.dsse-badge{display:inline-block;flex:0 0 auto;padding:2px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f2f4f8);color:var(--dsw-alias-label-secondary,#5b6270);font-size:max(.85em,11px)}
.dsse-badge-own{background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.14));color:var(--dsw-alias-state-business-primary,#2f4bd8)}
.dsse-btn{min-height:36px;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:7px 11px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color 160ms ease,opacity 160ms ease}
.dsse-btn:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-btn-primary{border-color:var(--dsw-alias-brand-text,#2f4bd8);background:var(--dsw-alias-brand-primary,#2f4bd8);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsse-btn-primary:hover{background:var(--dsw-alias-brand-primary,#2f4bd8);opacity:.9}
.dsse-btn:disabled{opacity:.5;cursor:default}
.dsse-note{margin:7px 0 0;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px);text-align:center}
.dsse-empty{margin:0;padding:12px 4px;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:.9em;text-align:center}
.dsse-err{flex:0 0 auto;margin:0;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-primary,#0f1115);overflow-wrap:anywhere;font-size:.9em}
.dsse-layer{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:20px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 22%,transparent);opacity:1;transition:opacity 180ms ease}
.dsse-layer[data-closing="true"]{opacity:0;pointer-events:none}
.dsse-dialog{width:min(860px,100%);max-height:min(720px,calc(100vh - 40px));display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.14));border-radius:15px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:0 24px 70px rgba(15,17,21,.2);font-family:var(--dsse-font-family,inherit);font-size:var(--dsse-font-size,inherit);line-height:var(--dsse-line-height,inherit);opacity:1;transform:translateY(0) scale(1);transition:opacity 180ms ease,transform 180ms ease}
.dsse-layer[data-closing="true"] .dsse-dialog{opacity:0;transform:translateY(8px) scale(.985)}
.dsse-settings-dialog{width:min(440px,100%)}
.dsse-dialog-head{display:flex;align-items:flex-start;gap:12px;padding:15px 16px 13px 20px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.08))}
.dsse-dialog-heading{flex:1;min-width:0}
.dsse-dialog-title{margin:0;font-size:1.08em;font-weight:600}
.dsse-dialog-subtitle{margin:3px 0 0;color:var(--dsw-alias-label-secondary,#5b6270);font-size:max(.85em,11px)}
.dsse-review-grid{display:grid;grid-template-columns:280px minmax(0,1fr);flex:1;height:min(620px,calc(100vh - 140px));min-height:0;overflow:hidden}
.dsse-candidates{min-width:0;padding:12px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.08));background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-search{width:100%;min-height:38px;margin-bottom:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit}
.dsse-candidate-list{display:grid;gap:5px}
.dsse-candidate{width:100%;min-height:64px;padding:9px 10px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;text-align:left;cursor:pointer}
.dsse-candidate:hover{background:var(--dsw-alias-bg-layer-1,#fff)}
.dsse-candidate[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary,rgba(77,107,254,.4));background:var(--dsw-alias-bg-layer-1,#fff)}
.dsse-candidate-name{display:block;overflow-wrap:anywhere;font-family:var(--dsse-font-mono,var(--dsse-font-family,inherit));font-size:max(.9em,12px);font-weight:500}
.dsse-candidate-desc{display:-webkit-box;overflow:hidden;margin-top:3px;color:var(--dsw-alias-label-secondary,#5b6270);font-size:max(.85em,11px);-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dsse-candidate-status{display:inline-block;margin-top:5px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,#eceef2);color:var(--dsw-alias-label-secondary,#5b6270);font-size:max(.85em,11px)}
.dsse-detail{min-width:0;min-height:0;display:flex;flex-direction:column}
.dsse-detail-body{flex:1;min-height:0;overflow-y:auto;padding:18px 20px 14px}
.dsse-detail-title{margin:0 0 7px;overflow-wrap:anywhere;font-family:var(--dsse-font-mono,var(--dsse-font-family,inherit));font-size:1em;font-weight:600}
.dsse-detail-desc{margin:0 0 14px;color:var(--dsw-alias-label-secondary,#5b6270);font-size:.9em}
.dsse-detail-badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.dsse-field{margin-top:13px}
.dsse-field-label{margin:0 0 5px;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px);font-weight:500}
.dsse-field-copy{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.9em}
.dsse-quote{margin:6px 0 0;padding:7px 9px;border-left:2px solid var(--dsw-alias-state-business-primary,rgba(77,107,254,.4));border-radius:0 7px 7px 0;background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-secondary,#5b6270);overflow-wrap:anywhere;font-size:max(.85em,11px)}
.dsse-detail-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:11px 16px 11px 20px;border-top:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.08));background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-detail-note{flex:1;min-width:150px;color:var(--dsw-alias-label-secondary,#5b6270);font-size:max(.85em,11px)}
.dsse-settings-body{display:grid;gap:2px;padding:10px 20px 16px;overflow-y:auto}
.dsse-setting{display:flex;align-items:center;gap:14px;min-height:58px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.07))}
.dsse-setting-copy{flex:1;min-width:0}
.dsse-setting-label{display:block;font-weight:500}
.dsse-setting-desc{display:block;margin-top:2px;color:var(--dsw-alias-label-secondary,#5b6270);font-size:max(.85em,11px)}
.dsse-check{width:19px;height:19px;accent-color:var(--dsw-alias-brand-primary,#2f4bd8)}
.dsse-select{max-width:180px;min-height:36px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit}
.dsse-side-options{display:flex;gap:4px;padding:3px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f2f4f8)}
.dsse-side-option{min-width:50px;min-height:32px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;cursor:pointer}
.dsse-side-option[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-brand-text,#2f4bd8)}
.dsse-settings-note{margin:7px 0 0;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-secondary,#5b6270);font-size:max(.85em,11px)}
.dsse-settings-foot{display:flex;justify-content:flex-end;padding:11px 16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.08))}
.dsse-handle{position:absolute;width:16px;height:54px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-tertiary,#8b92a1);font-family:var(--dsse-font-family,inherit);font-size:var(--dsse-font-size,inherit);padding:0;box-shadow:0 1px 4px rgba(15,17,21,.07)}
.dsse-handle[data-side="left"]{border-radius:0 7px 7px 0;border-left:0}
.dsse-handle[data-side="right"]{border-radius:7px 0 0 7px;border-right:0}
.dsse-handle:hover{color:var(--dsw-alias-brand-text,#2f4bd8);border-color:var(--dsw-alias-state-business-primary,rgba(77,107,254,.5))}
@media(max-width:680px){.dsse-review-grid{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.dsse-candidates{max-height:min(220px,35vh);border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.08))}.dsse-layer{padding:10px}.dsse-dialog{max-height:calc(100vh - 20px)}.dsse-detail-body{padding:15px}.dsse-detail-foot{padding:11px 14px}}
@media(max-height:520px){.dsse-dialog-head{padding-top:10px;padding-bottom:10px}.dsse-review-grid{height:calc(100vh - 110px)}.dsse-candidates{max-height:30vh}.dsse-detail-note{display:none}}
@media(prefers-reduced-motion:reduce){.dsse-layer,.dsse-dialog,.dsse-icon-btn,.dsse-queue,.dsse-btn{transition:none}}
`

    let typographyObserver = null
    let typographyContent = null

    function typographyChanged(mutations) {
      if (!Array.isArray(mutations)) return true
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') return true
        const nodes = [...(mutation.addedNodes ?? []), ...(mutation.removedNodes ?? [])]
        for (const node of nodes) {
          if (typeof node?.matches === 'function' && node.matches('code, pre')) return true
          if (typeof node?.querySelector === 'function' && node.querySelector('code, pre')) return true
        }
      }
      return false
    }

    function observeTypography(content) {
      if (typographyObserver === null) return
      typographyObserver.disconnect()
      typographyContent = content
      const options = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-font'] }
      if (document.documentElement) typographyObserver.observe(document.documentElement, options)
      if (document.body) typographyObserver.observe(document.body, options)
      if (content) typographyObserver.observe(content, { ...options, childList: true, subtree: true })
    }

    function syncHostTypography() {
      if (typeof document === 'undefined' || !document.documentElement) return
      const content = document.querySelector('[data-conversation-content]')
      if (typographyObserver !== null && content !== typographyContent) observeTypography(content)
      if (!content) return
      const style = getComputedStyle(content)
      const code = typeof content.querySelector === 'function' ? content.querySelector('code, pre') : null
      const codeStyle = code ? getComputedStyle(code) : style
      const rootStyle = document.documentElement.style
      const publish = (name, value) => {
        if (value && rootStyle.getPropertyValue(name) !== value) rootStyle.setProperty(name, value)
      }
      publish('--dsse-font-family', style.fontFamily)
      publish('--dsse-font-size', style.fontSize)
      publish('--dsse-line-height', style.lineHeight)
      publish('--dsse-font-mono', codeStyle.fontFamily)
    }

    function ensureHostTypography() {
      syncHostTypography()
      if (typographyObserver !== null || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
      typographyObserver = new MutationObserver((mutations) => {
        if (typographyChanged(mutations)) syncHostTypography()
      })
      observeTypography(document.querySelector('[data-conversation-content]'))
    }

    function stopHostTypography() {
      typographyObserver?.disconnect()
      typographyObserver = null
      typographyContent = null
      if (typeof document === 'undefined' || !document.documentElement) return
      const style = document.documentElement.style
      style.removeProperty('--dsse-font-family')
      style.removeProperty('--dsse-font-size')
      style.removeProperty('--dsse-line-height')
      style.removeProperty('--dsse-font-mono')
    }

    /** Inject the stylesheet once per page, not once per render. */
    function ensureStyle() {
      if (typeof document === "undefined") return
      ensureHostTypography()
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
     * Where output-file rows ask for a preview.
     *
     * The overlay runs in root scope and cannot reach a session-scoped service,
     * so `apply` publishes the sidebar here once (and only if the Host has one).
     * It stays `undefined` on a Host without `sidebarRight`, which is what makes
     * the rows plain text instead of buttons that do nothing.
     *
     * @type {((address: string) => void) | undefined}
     */
    let openResource = undefined

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
     * Space kept between any popover and the edge of the viewport.
     *
     * Named for the edge rather than for a box: the cards, the list and the detail
     * layer all use it, and it reads wrong on three of those if it is called a
     * bubble's margin.
     */
    const EDGE_MARGIN = 8

    /**
     * Width of the candidate review list.
     *
     * Wide enough for a kebab-case skill name plus a one-line description, which
     * is what the list row shows. Narrower and every row truncates the name, which
     * is the one field a person needs in order to decide.
     *
     * Named for the panel, not for a control that opens it. An earlier version named
     * a button that has since been deleted, and the sentence outlived it: the comment
     * kept pointing at something the code no longer had, and it survived review
     * because a stale noun is not a behavior. A comment that names no trigger cannot
     * go stale when the trigger is renamed or removed.
     */
    const PANEL_WIDTH = 320

    /** Width of the detail card that opens off a list row. */
    const DETAIL_WIDTH = 380

    /**
     * Gap between two layers of popover.
     *
     * Small on purpose. The pointer has to cross it to reach the second layer, and
     * the client gives the crossing a grace period — but a wide gap plus a slow
     * move still closes the card, so this is a compromise between "visibly two
     * cards" and "reachable".
     */
    const POPOVER_GAP = 8

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
     * Settle a vertical position inside the viewport.
     *
     * Shared by both popover layers. The three branches are the same for both, and a
     * second copy of this arithmetic is how the previous hover bubble ended up with a
     * clamp the list and the detail card did not share.
     *
     * @param {number} desired - where the caller would put the box if it fit.
     * @param {number} height - the box height.
     * @param {number | undefined} viewportHeight - the window height, if measurable.
     * @returns {number} the settled top edge.
     */
    function clampTop(desired, height, viewportHeight) {
      const foot = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : undefined
      // Tall enough to hold the box: clamp both edges.
      if (foot !== undefined && foot >= height + EDGE_MARGIN * 2) {
        return Math.max(EDGE_MARGIN, Math.min(desired, foot - height - EDGE_MARGIN))
      }
      // Too short to hold it: some of it must hang out. Keep the *top* edge on
      // screen, because the first line is the part that says what the box is.
      // Without the inner guard the two bounds invert below 2 * EDGE_MARGIN and
      // Math.min silently picks the negative one; the outer max then repairs it,
      // which is why the inner one is defensive rather than load-bearing.
      if (foot !== undefined) {
        return Math.max(EDGE_MARGIN, Math.min(desired, Math.max(EDGE_MARGIN, foot - EDGE_MARGIN)))
      }
      // No measurable height: the only boundary left is the top margin. Treating
      // "unknown" as "no limit" is what puts a box above the viewport.
      return Math.max(EDGE_MARGIN, desired)
    }

    /**
     * Whether a box covers any part of a rectangle.
     *
     * @param {number} left - box left.
     * @param {number} top - box top.
     * @param {number} width - box width.
     * @param {number} height - box height.
     * @param {{left: number, right: number, top: number, bottom: number} | undefined} rect - the rectangle, if any.
     * @returns {boolean} true when the two intersect.
     */
    function covers(left, top, width, height, rect) {
      if (rect === undefined || rect === null) return false
      if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return false
      const right = Number.isFinite(rect.right) ? rect.right : rect.left
      const bottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.top
      return left < right && left + width > rect.left && top < bottom && top + height > rect.top
    }

    /**
     * Place a popover beside an anchor.
     *
     * The requested side is a preference, not a constraint. If it does not fit, the
     * other side is tried before the box is allowed to leave the viewport — and if
     * neither fits, the side with more room wins and the box is clamped into the
     * window. For a hover card that is the right trade: covering the conversation is
     * allowed (it is not permanent content).
     *
     * Horizontally the box stays on screen. Vertically it may not: a window shorter
     * than the box has nowhere to put it, and `clampTop` keeps the top visible rather
     * than pretending otherwise. That asymmetry is deliberate — a box that starts
     * above the viewport is unreachable, one that runs past the bottom is merely cut.
     *
     * `avoid` is the one rectangle the box must not cover when that is possible. The
     * detail card uses it for the list it hangs off: without it, a narrow window
     * clamped the detail card back over the list's own approve/ignore column, so
     * hovering a row to read it made that row impossible to press.
     *
     * @param {object} input - the placement input.
     * @param {{left: number, right: number, top: number, bottom: number}} input.anchor - the anchor box, in viewport coordinates.
     * @param {number} input.width - the popover width.
     * @param {number} input.height - the popover height, for the vertical settle.
     * @param {'left'|'right'|'auto'} [input.side] - the preferred side.
     * @param {{left: number, right: number, top: number, bottom: number}} [input.avoid] - a rectangle to keep clear when any arrangement allows it.
     * @param {number | undefined} input.viewportWidth - the window width, if measurable.
     * @param {number | undefined} input.viewportHeight - the window height, if measurable.
     * @returns {{visible: boolean, left: number, top: number, width: number, side: 'left'|'right'}} the box.
     */
    function placeNear(input) {
      const anchor = input?.anchor
      const width = Number.isFinite(input?.width) && input.width > 0 ? input.width : PANEL_WIDTH
      const fallback = { visible: false, left: 0, top: 0, width, side: 'right' }
      // `right` is required as well: both candidate sides are measured from it, so an
      // anchor known only by its left edge would produce a box at `left: NaN` that
      // the browser silently drops. Hiding is the honest answer to "I cannot see
      // where this goes".
      if (
        anchor === null ||
        anchor === undefined ||
        !Number.isFinite(anchor.left) ||
        !Number.isFinite(anchor.right) ||
        !Number.isFinite(anchor.top)
      ) {
        return fallback
      }

      const measured = input?.viewportWidth
      const edge = Number.isFinite(measured) && measured > 0 ? measured : undefined
      const preferred = input?.side === 'left' || input?.side === 'right' ? input.side : 'auto'

      // Room is measured to the viewport edge, because the box only has to clear
      // the screen — the conversation underneath is fair game.
      const roomRight = edge === undefined ? Number.POSITIVE_INFINITY : edge - anchor.right - EDGE_MARGIN - POPOVER_GAP
      const roomLeft = anchor.left - EDGE_MARGIN - POPOVER_GAP
      const fitsRight = roomRight >= width
      const fitsLeft = roomLeft >= width

      // Two branches, not four. Written the long way there were also
      // `else if (fitsRight)` and `else if (fitsLeft)` before this tiebreak, and a
      // mutation deleting either one changed nothing: when the preference has not
      // already decided, the side with more room is necessarily the one that fits,
      // because both sides were measured against the same width. Removing them is
      // honest — a branch no input can distinguish is not a branch.
      let side
      if (preferred === 'right' && fitsRight) side = 'right'
      else if (preferred === 'left' && fitsLeft) side = 'left'
      else side = roomRight >= roomLeft ? 'right' : 'left'

      let left = side === 'right' ? anchor.right + POPOVER_GAP : anchor.left - POPOVER_GAP - width
      if (edge !== undefined) left = Math.max(EDGE_MARGIN, Math.min(left, edge - width - EDGE_MARGIN))
      else left = Math.max(EDGE_MARGIN, left)

      // One settle, not two. There used to be an `alignTop` parameter choosing
      // between "start at the anchor's top" and "settle first"; both arms passed
      // through this same call, so the parameter could not be observed. A popover
      // that opens BESIDE its anchor has no "below" to align with.
      const height = Number.isFinite(input?.height) ? input.height : 0
      let top = clampTop(anchor.top, height, input?.viewportHeight)

      // Step out of the way of `avoid`, vertically. The side is already decided and
      // staying on it matters — the detail card belongs next to the list, not on the
      // other side of the window — so the escape is up or down past the rectangle.
      // When neither clears it (a window barely taller than the two boxes) the plain
      // placement stands: covering the list is bad, drawing the card off screen or
      // not at all is worse.
      const avoid = input?.avoid
      if (covers(left, top, width, height, avoid) === true) {
        // Same tolerance `covers` applies: a rectangle missing its bottom edge is
        // treated as a point, so the escape arithmetic must not read `undefined` and
        // hand back `top: NaN`.
        const foot = Number.isFinite(avoid.bottom) ? avoid.bottom : avoid.top
        const above = avoid.top - POPOVER_GAP - height
        const below = foot + POPOVER_GAP
        const options = [
          clampTop(above, height, input?.viewportHeight),
          clampTop(below, height, input?.viewportHeight),
        ]
        const clear = options.find((candidate) => covers(left, candidate, width, height, avoid) === false)
        if (clear !== undefined) top = clear
      }

      return { visible: true, left, top, width, side }
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

      // Which of the host's three conversation states this is. The same element is
      // drawn for all three — it is the conversation *body*, not the conversation —
      // so its presence says nothing about whether someone is looking at a
      // conversation. `data-content-phase` does: `active` for a real conversation,
      // `settling` while one is being opened, `hero` for the launcher and the
      // new-session page. Empty means the attribute is not published, which is a
      // host whose layout we cannot read; callers must treat that as "unknown"
      // rather than as one of the three.
      const phase = content.getAttribute("data-content-phase") ?? ""

      return {
        phase,
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


    /**
     * Cap the summary and fade only the part that is actually hidden.
     *
     * The cap is unconditional — it is the height budget the header was sized
     * against. The gradient is not: a two-line summary is shorter than the 34px
     * mask, so drawing it unconditionally washes out text that was never
     * truncated. Whether there is more to see is a layout fact, so it is measured
     * after paint rather than assumed.
     *
     * `expanded` lifts the cap; it arrives as a prop because the card, not this
     * box, is what the pointer and the click land on.
     *
     * Growth is not animated. The uncapped height is only known to layout and
     * `max-height` cannot be transitioned to `none`; the usual dodge — a sentinel
     * like `max-height:200em` — makes the duration proportional to how much text
     * happens to be hidden, so a two-line overrun snaps while a forty-line one
     * crawls. Instant is the honest version of "it grew".
     */
    function Clip(props) {
      const ref = React.useRef(null)
      const [overflowing, setOverflowing] = React.useState(false)
      const expanded = props.expanded === true
      // Measure before paint, not after. A passive effect runs after the browser has
      // already painted the frame, so a clipped summary would show one frame with
      // its text cut and no fade over it — a visible flicker on every first render.
      // The fallback exists for renderers with no layout phase (the test harness,
      // and any environment that only implements the passive hook).
      const useLayout = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect
      useLayout(() => {
        // Skipped while expanded, and this is the load-bearing part: with the cap
        // lifted `scrollHeight` and `clientHeight` agree by construction, so the
        // comparison would answer "nothing is hidden" and overwrite the one fact
        // that makes the card expandable at all. The last capped reading stands
        // until the card collapses and measures again.
        if (expanded) return
        const node = ref.current
        if (node === null) return
        const hidden = node.scrollHeight > node.clientHeight + 1
        setOverflowing(hidden)
        // The parent owns the click, so it needs the same answer this box uses to
        // decide whether there is anything to reveal. Reported rather than
        // re-measured there: two measurements of the same box would eventually
        // disagree, and the one that drives `aria-expanded` should be the one that
        // drives the fade.
        if (props.onClipped !== undefined) props.onClipped(hidden)
      })
      return jsx('div', {
        className: 'dsse-clip',
        'data-clipped': overflowing === true ? 'true' : 'false',
        'data-expanded': expanded === true ? 'true' : 'false',
        children: jsx('p', { ref, className: 'dsse-text dsse-tiny', title: props.title, children: props.text }),
      })
    }

    function Icon(props) {
      if (props.name === 'close') return jsx('svg', { className: 'dsse-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', children: jsx('path', { d: 'M6 6l12 12M18 6L6 18' }) })
      if (props.name === 'refresh') return jsxs('svg', { className: 'dsse-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', children: [jsx('path', { d: 'M20 11a8 8 0 10-2 5.3' }), jsx('path', { d: 'M20 5v6h-6' })] })
      if (props.name === 'settings') return jsxs('svg', { className: 'dsse-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', children: [jsx('circle', { cx: '12', cy: '12', r: '3' }), jsx('path', { d: 'M19 12a7 7 0 00-.1-1l2-1.5-2-3.4-2.4 1a7 7 0 00-1.7-1L14.5 3h-5L9 6a7 7 0 00-1.7 1l-2.4-1-2 3.4 2 1.5a7 7 0 000 2l-2 1.5 2 3.4 2.4-1a7 7 0 001.7 1l.5 3.1h5l.5-3.1a7 7 0 001.7-1l2.4 1 2-3.4-2-1.5a7 7 0 00.1-1z' })] })
      // A cover with a spine. The cover alone is a rounded rectangle at 17px, which
      // reads as a missing glyph rather than a book; the spine is what makes it one.
      if (props.name === 'skill') return jsxs('svg', { className: 'dsse-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', children: [jsx('path', { d: 'M4 5.5A2.5 2.5 0 016.5 3H20v15H6.5A2.5 2.5 0 004 20.5v-15z' }), jsx('path', { d: 'M8 3v15' })] })
      if (props.name === 'mcp') return jsxs('svg', { className: 'dsse-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', children: [jsx('path', { d: 'M9 3v5M15 3v5' }), jsx('path', { d: 'M6 8h12v4a6 6 0 01-12 0V8z' }), jsx('path', { d: 'M12 18v3' })] })
      if (props.name === 'collapse') return jsx('svg', { className: 'dsse-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', children: jsx('path', { d: props.side === 'right' ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6' }) })
      // The round button in the middle of a card's bottom edge. Drawn as one
      // chevron rather than a glyph turned by a `transform`: inside a round badge a
      // rotated shape reads as a spinner caught mid-animation. The direction is the
      // promise about what the click does — down means there is more below, up means
      // the card is already open and the click puts it back.
      if (props.name === 'chevron') return jsx('svg', { className: 'dsse-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', children: jsx('path', { d: props.up === true ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6' }) })
      return jsxs('svg', { className: 'dsse-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', children: [jsx('path', { d: 'M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z' }), jsx('path', { d: 'M18.5 15l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3z' })] })
    }

    function Modal(props) {
      const ref = React.useRef(null)
      const closeTimer = React.useRef(null)
      const closing = React.useRef(false)
      const [leaving, setLeaving] = React.useState(false)
      const requestClose = React.useCallback(() => {
        if (closing.current) return
        closing.current = true
        setLeaving(true)
        closeTimer.current = setTimeout(props.onClose, 180)
      }, [props.onClose])

      React.useEffect(() => {
        const previous = typeof document === 'undefined' ? null : document.activeElement
        const node = ref.current
        const initial = node?.querySelector?.('[data-autofocus]') ?? node?.querySelector?.('button, input, select') ?? node
        initial?.focus?.()
        const onKey = (event) => {
          if (event?.key === 'Escape') {
            event.preventDefault?.()
            requestClose()
            return
          }
          if (event?.key !== 'Tab' || !node || typeof node.querySelectorAll !== 'function') return
          const focusable = Array.from(node.querySelectorAll('button:not([disabled]), input, select, [href]')).filter((item) => !item.disabled && item.offsetParent !== null)
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (typeof node.contains === 'function' && !node.contains(document.activeElement)) {
            event.preventDefault()
            ;(event.shiftKey ? last : first).focus()
            return
          }
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => {
          if (closeTimer.current !== null) clearTimeout(closeTimer.current)
          window.removeEventListener('keydown', onKey)
          previous?.focus?.()
        }
      }, [requestClose])

      return jsx('div', {
        className: 'dsse-layer',
        'data-closing': String(leaving),
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) requestClose()
        },
        children: jsxs('section', {
          ref,
          id: props.id,
          className: `dsse-dialog ${props.className ?? ''}`,
          role: 'dialog',
          tabIndex: -1,
          'aria-modal': 'true',
          'aria-labelledby': `${props.id}-title`,
          children: [
            jsxs('header', {
              className: 'dsse-dialog-head',
              children: [
                jsxs('div', {
                  className: 'dsse-dialog-heading',
                  children: [
                    jsx('h2', { className: 'dsse-dialog-title', id: `${props.id}-title`, children: props.title }),
                    props.subtitle ? jsx('p', { className: 'dsse-dialog-subtitle', children: props.subtitle }) : null,
                  ],
                }),
                jsx('button', { className: 'dsse-icon-btn', type: 'button', 'aria-label': '关闭', title: '关闭', onClick: requestClose, children: jsx(Icon, { name: 'close' }) }),
              ],
            }),
            props.children,
          ],
        }),
      })
    }

    /**
     * How fast the answer is arriving, and how fast it went, in one place.
     *
     * The host already shows a tok/s pill, but it is the session's average: by
     * the twentieth turn it is mostly describing the first nineteen. This one
     * answers the question a person actually asks, which changes with the
     * moment: while a reply arrives it is "is this moving and how fast", and
     * after it ends it is "how fast was that one".
     *
     * Three states, two numbers:
     *   live     — text is arriving right now; the last two seconds
     *   previous — the reply is over; the speed of that whole message, which
     *              stays until the next one starts
     *   idle     — nothing has been measured yet in this conversation
     * The middle state is why this widget is findable. A readout that only
     * exists while a reply is arriving is a readout nobody sees: the moment a
     * reader looks up is the moment it stops.
     *
     * Asking, not polling, and the difference is the whole reason it works. An
     * idle badge holds the request open (`&after=<revision>`) and the server
     * answers the instant the meter changes, so the first number of a reply
     * appears within a fraction of a second rather than up to one poll interval
     * later — which, for the ten-second interval this used to have, was usually
     * after the reply had already finished. While text is arriving it asks four
     * times a second instead, because a number that updates once every two
     * seconds is not a live reading.
     *
     * @param {object} props - props.
     * @param {string} props.sessionId - the conversation to measure.
     * @returns {object} the element, or nothing on a host that cannot measure.
     */
    function SpeedBadge(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      // The number on screen and the last moment it was real live in refs, not
      // state, and the difference is not stylistic. `ask` closes over whatever
      // the effect saw when it was created, and the effect's only dependency is
      // the session id — so a `seenAt` held in state would be frozen at its mount
      // value for the life of the conversation. That turned the "warm" branch
      // into dead code and, worse, made the linger below unreachable: by the time
      // a reading comes back inactive the number is already gone.
      const [reading, setReading] = React.useState(null)
      // Whether this host has ever answered. The distinction matters: a host
      // without the route must not get a permanent dash in its header, but a
      // host that answered once — even with "idle" — keeps the widget on
      // screen. A readout that only appears while a reply is arriving is a
      // readout nobody can find.
      const [known, setKnown] = React.useState(false)
      // A repaint ticket, and it is load-bearing. The held number outlives the
      // reading that produced it, so when the linger runs out something has to
      // re-render the badge to fall back from it — and nothing else fires at
      // that moment: the pending long poll is waiting on the meter, and an idle
      // meter does not move.
      const [, setTick] = React.useState(0)
      const held = React.useRef({ tps: 0, at: 0 })
      const request = React.useRef(0)
      // The revision the server last reported. Sent back as `after`, this is what
      // turns the next request into a long poll: the server holds it until the
      // meter moves, so the badge learns about a reply starting without having to
      // ask again and again to find out.
      const revision = React.useRef(null)

      React.useEffect(() => {
        if (sessionId === '') return undefined
        let live = true
        let timer = null
        let repaint = null
        let stopped = false
        // The request in flight, so the cleanup can take it back. A long poll is
        // deliberately unanswered for up to twenty-five seconds; without this the
        // server keeps one connection and one hundred-millisecond interval alive
        // per conversation the reader has already left, and switching a few times
        // in a row leaves the new conversation's first request queued behind
        // them.
        let pending = null
        // A different conversation shares this component instance, so anything
        // held from the previous one has to go before the first request: the
        // badge would otherwise show the last conversation's number for up to
        // the linger, which reads as this one's speed and is not. The revision
        // goes with it — it names a position in another conversation's meter.
        held.current = { tps: 0, at: 0 }
        revision.current = null
        setReading(null)
        // `known` deliberately survives the reset: the question it answers is
        // about the host, not the conversation.

        const schedule = (ms) => {
          if (stopped) return
          timer = setTimeout(ask, ms)
        }

        const ask = async () => {
          const ticket = ++request.current
          try {
            // The first request has no revision to name, so it is answered at
            // once — the panel must paint. Every later one waits for a change.
            const after = revision.current
            const query = after === null ? '' : `&after=${after}`
            const flight = new AbortController()
            pending = flight
            const askedAt = Date.now()
            const answer = await call(`/speed?agent=${encodeURIComponent(sessionId)}${query}`, { signal: flight.signal })
            if (live === false || ticket !== request.current) return
            const next = answer
            const heldFor = Date.now() - askedAt
            if (typeof next?.revision === 'number' && Number.isFinite(next.revision)) revision.current = next.revision
            const now = Date.now()
            if (next?.active === true && typeof next.tps === 'number' && Number.isFinite(next.tps) && next.tps > 0) {
              held.current = { tps: next.tps, at: now }
            }
            setReading(next)
            setKnown(true)
            // The held number outlives the reading that produced it, so the badge
            // has to repaint when it expires — nothing else will. One timer, kept
            // in a variable: two polls in a row while warm would otherwise stack
            // a timer each, and none of them would be cancelled by the cleanup.
            // It is armed for every reading, including a live one: a reply can go
            // quiet for longer than the grace period between paragraphs or while a
            // tool call is assembled, and without this the last live number would
            // stay on screen in the live style until the next answer arrives —
            // which, with a held request, can be most of a minute.
            if (held.current.at !== 0) {
              if (repaint !== null) clearTimeout(repaint)
              repaint = setTimeout(() => { repaint = null; setTick((count) => count + 1) }, SPEED_LINGER_MS)
            }
            if (next?.active === true) {
              schedule(SPEED_FAST_MS)
              return
            }
            const warm = held.current.at !== 0 && now - held.current.at < SPEED_LINGER_MS * 4
            // How the next request is scheduled depends on what the last one did,
            // not on a constant. `schedule()` runs after the await, so any delay
            // chosen here is dead time *after* an answer has already arrived.
            // A reply that took about the server's whole window was held on
            // purpose: the meter had not moved, and the right move is to ask
            // again now, so the next change is caught the instant it happens.
            // Anything else — a near-instant answer — means this host ignored
            // `after` and is a plain read; then a slow clock is the only thing
            // between the badge and a spin loop.
            const wasHeld = heldFor >= SPEED_WAIT_MS / 2
            if (wasHeld === true) {
              schedule(0)
              return
            }
            schedule(warm === true ? SPEED_SLOW_MS : SPEED_IDLE_MS)
          } catch {
            if (live === false) return
            // A panel that vanishes because one request failed is worse than a
            // stale number: keep the last reading and try again on the idle
            // clock, which is also what happens when the route is simply absent
            // (an older host half). Retrying on the slow clock instead would knock
            // on a host that is merely restarting once every two seconds — five
            // times as often — for as long as the restart takes.
            schedule(SPEED_IDLE_MS)
          }
        }

        ask()
        return () => {
          live = false
          stopped = true
          request.current += 1
          if (timer !== null) clearTimeout(timer)
          if (repaint !== null) clearTimeout(repaint)
          // Aborting wakes the server's `close` listener, which is the one path
          // out of the wait that does not cost the deadline.
          if (pending !== null) pending.abort()
        }
      }, [sessionId])

      const now = Date.now()
      // Three states, and which number they show is the whole point:
      //   live     — text is arriving; the last two seconds, which is "now"
      //   previous — the last message has settled; its whole speed, which is
      //              "how fast that one went" and stays until the next starts
      //   idle     — nothing has settled in this conversation yet
      // There is a fourth shape on screen but not a fourth state: for a few
      // seconds after a reply ends the held live number is still fresher than
      // the settled one, so it wins. That is the linger, and it is shorter than
      // the gap between two replies by design.
      const liveReading = reading?.active === true ? reading : null
      const last = reading?.last !== null && typeof reading?.last?.tps === 'number' && Number.isFinite(reading.last.tps) && reading.last.tps > 0 ? reading.last : null
      const heldFresh = held.current.at !== 0 && now - held.current.at < SPEED_LINGER_MS
      if (known === false) return null
      const shown = liveReading !== null ? liveReading.tps : heldFresh === true ? held.current.tps : last !== null ? last.tps : 0
      const measured = typeof shown === 'number' && Number.isFinite(shown) === true && shown > 0
      const idle = measured === false
      // `last !== null && liveReading === null`: a settled number, not one that
      // happened to come from the same reading. It is dimmer than a live number
      // because it describes a finished reply, and `aria-label` says so — a
      // reader who lands on it should not think the reply is still going.
      const previous = liveReading === null && last !== null && heldFresh === false
      const label = idle === true
        ? '输出速度：当前没有输出'
        : previous === true
          ? `上一轮输出速度 ${formatSpeed(shown)} tok/s`
          : `输出速度 ${formatSpeed(shown)} tok/s`
      const hint = idle === true
        ? '当前没有输出'
        : previous === true
          ? '上一轮这条回复的平均速度'
          : '最近两秒的输出速度'
      return jsxs('span', {
        className: idle === true ? 'dsse-speed dsse-speed-idle' : previous === true ? 'dsse-speed dsse-speed-previous' : 'dsse-speed',
        // Not `role="status"`. That implies `aria-live="polite"`, and this number
        // changes up to four times a second while a reply arrives — a screen
        // reader would announce it continuously for the whole generation, which
        // makes the panel unusable for the people the attribute is meant to help.
        // The label stays for anyone who lands on it deliberately.
        'aria-live': 'off',
        'aria-label': label,
        title: hint,
        children: [
          jsx('span', { children: idle === true ? '—' : formatSpeed(shown) }),
          idle === true ? null : jsx('span', { className: 'dsse-speed-unit', children: 'tok/s' }),
        ],
      })
    }

    function Checklist(props) {
      const [open, setOpen] = React.useState(false)
      const [epoch, setEpoch] = React.useState(0)
      const [rows, setRows] = React.useState({ status: 'idle', list: [], reason: '' })
      const [selected, setSelected] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [failure, setFailure] = React.useState('')
      const [staged, setStaged] = React.useState({})
      const [confirming, setConfirming] = React.useState('')
      const loadRequest = React.useRef(0)

      const load = React.useCallback(async () => {
        const request = ++loadRequest.current
        setRows((previous) => ({ ...previous, status: 'loading' }))
        try {
          const payload = await call('/candidates')
          if (request !== loadRequest.current) return
          if (payload?.available === false) {
            setRows({ status: 'unavailable', list: [], reason: String(payload.reason ?? '') })
            setSelected('')
            return
          }
          const list = Array.isArray(payload?.candidates) ? payload.candidates : []
          setRows({ status: 'ready', list, reason: '' })
          setSelected((current) => list.some((row) => row.id === current) ? current : String(list[0]?.id ?? ''))
        } catch (thrown) {
          if (request !== loadRequest.current) return
          setRows({ status: 'error', list: [], reason: String(thrown?.message ?? thrown) })
          setSelected('')
        }
      }, [])

      const show = React.useCallback(() => {
        setEpoch((current) => current + 1)
        setOpen(true)
        setFailure('')
        setConfirming('')
        load()
      }, [load])
      const close = React.useCallback(() => {
        loadRequest.current += 1
        setOpen(false)
      }, [])
      React.useEffect(() => () => {
        loadRequest.current += 1
      }, [])

      const decide = React.useCallback(async (id, name, action) => {
        setBusy(id)
        setFailure('')
        try {
          const path = props.sessionId === undefined ? '/candidates' : `/candidates?agent=${encodeURIComponent(props.sessionId)}`
          const outcome = await call(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, name, action }),
          })
          if (outcome?.ok === false) {
            setFailure(String(outcome.error ?? 'the request was refused'))
            return
          }
          if (outcome?.staged === true) {
            setStaged((previous) => ({ ...previous, [id]: true }))
            if (typeof props.onDecided === 'function') props.onDecided()
            return
          }
          const remaining = rows.list.filter((row) => row.id !== id)
          setRows((previous) => ({
            ...previous,
            list: previous.list.filter((row) => row.id !== id),
          }))
          if (selected === id) setSelected(String(remaining[0]?.id ?? ''))
          setConfirming('')
          if (typeof props.onDecided === 'function') props.onDecided()
        } catch (thrown) {
          setFailure(String(thrown?.message ?? thrown))
        } finally {
          setBusy('')
        }
      }, [props, rows.list, selected])

      const chosen = rows.list.find((row) => row.id === selected)
      const child = React.isValidElement(props.children)
        ? React.cloneElement(props.children, {
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-controls': 'dsse-candidate-dialog',
            onClick: show,
          })
        : props.children

      return jsxs('span', {
        className: 'dsse-review-root',
        children: [
          child,
          open === false ? null : jsx(Modal, {
            key: epoch,
            id: 'dsse-candidate-dialog',
            title: '候选审核',
            subtitle: '先核对做法与证据；批准后仍需模型写出定稿。',
            onClose: close,
            children: jsxs('div', {
              className: 'dsse-review-grid',
              'aria-busy': String(rows.status === 'loading'),
              children: [
                jsxs('div', {
                  className: 'dsse-candidates',
                  children: [
                    jsx('input', {
                      className: 'dsse-search',
                      type: 'search',
                      value: query,
                      placeholder: '搜索名称或描述',
                      'aria-label': '搜索候选技能',
                      'data-autofocus': true,
                      onChange: (event) => setQuery(String(event.target.value ?? '')),
                    }),
                    failure === '' ? null : jsx('p', { className: 'dsse-err', role: 'alert', children: failure }),
                    jsx('div', {
                      className: 'dsse-candidate-list',
                      children: checklistBody({ rows, selected, query, staged, busy, onSelect: setSelected }),
                    }),
                  ],
                }),
                detailBody(chosen, {
                  busy,
                  staged,
                  confirming,
                  onDecide: decide,
                  onConfirm: setConfirming,
                  onCancel: () => setConfirming(''),
                }),
              ],
            }),
          }),
        ],
      })
    }

    /**
     * The one-line heading of the checklist.
     *
     * @param {string} status - the load state.
     * @param {number} count - how many candidates are listed.
     * @returns {string} the heading text.
     */
    function checklistHead(status, count) {
      if (status === 'loading') return '正在读取待批准技能…'
      if (status === 'error') return '待批准技能读取失败'
      if (status === 'unavailable') return '待批准技能不可用'
      if (count === 0) return '没有待批准的技能'
      return `${count} 个待批准`
    }

    function checklistBody(input) {
      const { rows, selected, query, staged, busy, onSelect } = input
      if (rows.status === 'error' || rows.status === 'unavailable') {
        const heading = rows.status === 'error' ? '待批准技能读取失败' : '待批准技能不可用'
        return jsx('p', { className: 'dsse-empty', children: `${heading}：${rows.reason === '' ? '原因未知' : rows.reason}` })
      }
      if (rows.status === 'loading' && rows.list.length === 0) {
        return jsx('p', { className: 'dsse-empty', children: checklistHead(rows.status, 0) })
      }
      if (rows.status !== 'ready' && rows.status !== 'loading') return null
      if (rows.list.length === 0) {
        return jsx('p', { className: 'dsse-empty', children: '没有待批准的技能。从本轮提炼后，候选会出现在这里。' })
      }
      const needle = query.trim().toLowerCase()
      const visible = needle === ''
        ? rows.list
        : rows.list.filter((row) => `${row.name} ${row.description ?? ''}`.toLowerCase().includes(needle))
      if (visible.length === 0) return jsx('p', { className: 'dsse-empty', children: '没有匹配的候选。' })
      return visible.map((row) => {
        const status = staged[row.id] === true ? '等待定稿' : row.stale !== undefined ? '已失效' : row.kind === 'update' ? '修订已有技能' : '新建技能'
        return jsxs('button', {
          className: 'dsse-candidate',
          type: 'button',
          'aria-pressed': row.id === selected,
          disabled: busy !== '',
          onClick: () => onSelect(row.id),
          children: [
            jsx('span', { className: 'dsse-candidate-name', title: String(row.name), children: row.name }),
            jsx('span', {
              className: 'dsse-candidate-desc',
              children: String(row.description ?? '') === '' ? status : String(row.description),
            }),
            jsx('span', {
              className: 'dsse-candidate-status',
              'data-stage': staged[row.id] === true ? 'confirmed' : undefined,
              children: status,
            }),
          ],
        }, `cand:${row.id}:${row.name}`)
      })
    }

    /**
     * Why a candidate can no longer be approved.
     *
     * @param {string} reason - the staleness code.
     * @returns {string} one short line for the row.
     */
    function staleLabel(reason) {
      if (reason === 'expired') return '已过期，只能忽略'
      if (reason === 'source-missing') return '来源会话已不在，只能忽略'
      if (reason === 'name-taken') return '同名技能已被别人占用'
      if (reason === 'base-changed') return '技能文件已被改动'
      return `不可批准：${reason}`
    }

    function detailBody(row, input) {
      if (row === undefined) {
        return jsx('article', { className: 'dsse-detail', children: jsx('p', { className: 'dsse-empty', children: '选择一条候选查看详情。' }) })
      }
      const { busy, staged, confirming, onDecide, onConfirm, onCancel } = input
      const blocks = []
      if (row.whenToUse !== undefined && String(row.whenToUse) !== '') {
        blocks.push(jsxs('section', {
          className: 'dsse-field',
          children: [jsx('h4', { className: 'dsse-field-label', children: '何时使用' }), jsx('p', { className: 'dsse-field-copy', children: String(row.whenToUse) })],
        }))
      }
      blocks.push(jsxs('section', {
        className: 'dsse-field',
        children: [jsx('h4', { className: 'dsse-field-label', children: '做法' }), jsx('p', { className: 'dsse-field-copy', children: String(row.body ?? '') })],
      }))
      if (Array.isArray(row.evidence) && row.evidence.length > 0) {
        blocks.push(jsxs('section', {
          className: 'dsse-field',
          children: [
            jsx('h4', { className: 'dsse-field-label', children: `证据 · ${row.evidence.length} 条` }),
            ...row.evidence.map((entry, index) => {
              const label = ({ user: '用户', tool: '工具', action: '操作', self: '模型' })[entry?.class] ?? String(entry?.class ?? '证据')
              return jsx('blockquote', { className: 'dsse-quote', children: `${label} · ${String(entry?.quote ?? '')}` }, `ev:${row.id}:${index}`)
            }),
          ],
        }))
      }

      let footer
      if (staged[row.id] === true) {
        footer = jsxs('footer', {
          className: 'dsse-detail-foot',
          children: [
            jsx('span', { className: 'dsse-detail-note', 'data-stage': 'confirmed', children: '已记录批准，正在等待模型定稿；技能尚未写入。' }),
            jsx('button', { className: 'dsse-btn', type: 'button', 'data-action': 'discard', disabled: busy !== '', onClick: () => onConfirm(row.id), children: '忽略候选' }),
            jsx('button', { className: 'dsse-btn dsse-btn-primary', type: 'button', disabled: true, children: '等待定稿' }),
          ],
        })
      } else if (confirming === row.id) {
        footer = jsxs('footer', {
          className: 'dsse-detail-foot',
          children: [
            jsx('span', { className: 'dsse-detail-note', children: '确认忽略这条候选？此操作会移除队列条目。' }),
            jsx('button', { className: 'dsse-btn', type: 'button', onClick: onCancel, children: '取消' }),
            jsx('button', { className: 'dsse-btn dsse-btn-primary', type: 'button', 'data-action': 'confirm-discard', disabled: busy !== '', onClick: () => onDecide(row.id, row.name, 'discard'), children: '确认忽略' }),
          ],
        })
      } else {
        footer = jsxs('footer', {
          className: 'dsse-detail-foot',
          children: [
            jsx('span', { className: 'dsse-detail-note', children: row.stale === undefined ? '证据已在提案时通过校验' : staleLabel(row.stale.reason) }),
            jsx('button', { className: 'dsse-btn', type: 'button', 'data-action': 'discard', disabled: busy !== '', onClick: () => onConfirm(row.id), children: '忽略' }),
            jsx('button', {
              className: 'dsse-btn dsse-btn-primary',
              type: 'button',
              'data-action': 'approve',
              disabled: busy !== '' || row.stale !== undefined,
              onClick: () => onDecide(row.id, row.name, 'approve'),
              children: '批准候选',
            }),
          ],
        })
      }

      return jsxs('article', {
        className: 'dsse-detail',
        children: [
          jsxs('div', {
            className: 'dsse-detail-body',
            children: [
              jsxs('div', {
                className: 'dsse-detail-badges',
                children: [
                  jsx('span', { className: 'dsse-badge', children: row.kind === 'update' ? '修订已有技能' : '新建技能' }),
                  jsx('span', { className: 'dsse-badge', children: row.stale === undefined ? '证据已验证' : '不可批准' }),
                ],
              }),
              jsx('h3', { className: 'dsse-detail-title', children: row.name }),
              jsx('p', { className: 'dsse-detail-desc', children: String(row.description ?? '') }),
              ...blocks,
            ],
          }),
          footer,
        ],
      })
    }

    function Card(props) {
      // Only 上一轮 passes these; the other two cards leave them undefined, which
      // React treats as "no listener" instead of a prop to forward.
      //
      // `clickable` is the caller saying there is something to reveal. A card whose
      // summary already fits gets no pointer cursor, no tab stop and no role, so the
      // panel never invites a click that would change nothing visible.
      //
      // `onClick` is gated too, and that is not tidiness. Forwarding it while the rest
      // of the interaction was suppressed let a click on a short summary flip the
      // caller's pin with nothing on screen to show for it; the pin outlived the turn,
      // and the next turn's long summary arrived already open but impossible to close
      // (no pointer cursor, no tab stop, no role) — the same dead end the measurement
      // guard exists to prevent, reached through the other door. A control that looks
      // inert has to be inert.
      const interactive = typeof props.onClick === 'function' && props.clickable === true
      return jsxs('section', {
        className: 'dsse-card',
        'data-clickable': interactive === true ? 'true' : 'false',
        // Whether the expand button is on screen. The attribute is what the tests
        // read; the button itself is mounted and unmounted with `expandHint` above.
        // Showing it costs no layout — it is positioned against the card, not placed
        // under the summary — so the old trade-off this comment used to explain
        // (twenty-six pixels of growth was tolerable) no longer applies to a hover.
        // The one case that does reserve space is the open card, and that height is
        // already changing for reasons of its own.
        'data-hint': props.expandHint === undefined ? 'false' : 'true',
        // The reserved strip at the bottom belongs to the badge, so it is on only
        // while a badge is drawn. A card that fits needs none of it.
        'data-badge': props.badgeAction === undefined ? 'false' : 'true',
        onMouseEnter: props.onMouseEnter,
        onMouseLeave: props.onMouseLeave,
        onClick: interactive === true ? props.onClick : undefined,
        // A card that answers only to a mouse is unreachable for anyone driving
        // this panel from the keyboard. Enter and Space are what a button answers
        // to, so the same handler runs for both.
        onKeyDown: interactive === false
          ? undefined
          : (event) => {
              if (event === null || event === undefined) return
              if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
              if (typeof event.preventDefault === 'function') event.preventDefault()
              props.onClick()
            },
        tabIndex: interactive === true ? 0 : undefined,
        role: interactive === true ? 'button' : undefined,
        'aria-expanded': interactive === true ? props.expanded : undefined,
        children: [
          jsxs('header', {
            className: 'dsse-card-head',
            children: [
              jsx('h3', { className: 'dsse-card-title', children: props.title }),
              props.head === undefined || props.head === null
                ? (props.meta === undefined || props.meta === '' ? null : jsx('span', { className: 'dsse-card-meta', children: props.meta }))
                : props.head,
            ],
          }),
          jsx('div', { className: 'dsse-card-body', children: props.children }),
          // A round button centred on the card's bottom edge, showing a chevron that
          // points down when there is more to read and up once the card is open.
          //
          // Two shapes, because two cards need two different things. The 上一轮 card
          // lets the whole card take the click, so its badge is decoration:
          // `pointer-events` off, no tab stop, `role="img"`. The 产出文件 card cannot
          // do that — every row in it is already a button, and a card that also
          // answered clicks would swallow the row presses. So that card passes
          // `badgeAction` and the badge becomes the control itself: a real
          // `<button>` with its own focus ring and its own `aria-expanded`.
          //
          // Either way it is one badge in the same place with the same geometry,
          // which is the point: the two cards should read as the same object.
          props.badgeAction === undefined
            ? (props.expandHint === undefined
              ? null
              : jsxs('div', {
                  className: 'dsse-expand',
                  // Named for a screen reader: the badge is the only visual cue that
                  // something is folded away, and a decorative div announces nothing.
                  // No `title`: `pointer-events` is off, so this element is never hit
                  // and the browser has nothing to hang a native tooltip on. A `title`
                  // here would be a line of code that reads as a feature and does
                  // nothing — the card owns the pointer, so the card would have to
                  // carry it, and `aria-label` already says the same words.
                  role: 'img',
                  'aria-label': props.expandHint,
                  children: jsx(Icon, { name: 'chevron', up: props.expanded === true }),
                }))
            : jsx('button', {
                className: 'dsse-expand dsse-expand-action',
                type: 'button',
                // A live hit target, so the tooltip works here and is worth having:
                // the chevron alone says "there is a direction", not how many rows
                // are behind it.
                title: props.badgeAction.label,
                onClick: props.badgeAction.onClick,
                'aria-label': props.badgeAction.label,
                'aria-expanded': props.badgeAction.open === true,
                children: jsx(Icon, { name: 'chevron', up: props.badgeAction.open === true }),
              }),
        ],
      })
    }

    /**
     * The three cards plus the chrome around them.
     *
     * Every field is read from one `/panel` response on purpose: the summary
     * belongs to a turn, and fetching the modules separately would let the
     * column show turn 4's summary beside turn 3's files.
     *
     * @param {object} props - injected props.
     * @param {object} props.place - where to draw, from `gutter.js`.
     * @returns {object} the element.
     */
    function Cards(props) {
      const [state, setState] = React.useState({ status: "loading" })
      const [config, setConfig] = React.useState(undefined)
      const [models, setModels] = React.useState([])
      const [error, setError] = React.useState("")
      // Two write-paths, not one, because hover and click are independent reasons for
      // the 上一轮 card to be open and a click must not disturb the pointer's reason.
      // The pointer writes only `turnHover`, the click writes only `pinnedTurn`. A
      // single slot would make a click while hovering close the card under the
      // pointer — exactly the conflict this split exists to prevent.
      //
      // Every one of these three is stored *with the turn it describes* rather than
      // as a bare boolean, and that includes the pointer. A reason for being open
      // that outlives the text it was about opens something nobody asked for — and
      // when the next measurement says that text had nothing to reveal, it opens on
      // a card with no pointer cursor, no tab stop and no click handler: open, with
      // no way to close it.
      //
      // Hover needs the tag for the same reason as the click, and the reason is not
      // obvious: the pointer cannot un-hover a card it is no longer over. Refreshing
      // unmounts the 上一轮 card while `status` is `loading`, so the `onMouseLeave`
      // that would have cleared a bare boolean never fires, and the next turn's card
      // arrived already open under a pointer that had left long ago.
      //
      // `clippedTurn` is a measurement, not a reason to expand: it only says whether
      // expanding would reveal anything, and which turn it looked at. "Measured and
      // nothing hidden" is stored as no tag at all, so one string carries both facts
      // and they cannot disagree.
      const [hoverTurn, setHoverTurn] = React.useState("")
      const [pinnedTurn, setPinnedTurn] = React.useState("")
      const [clippedTurn, setClippedTurn] = React.useState("")
      const [filesOpen, setFilesOpen] = React.useState(false)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [settingsEpoch, setSettingsEpoch] = React.useState(0)
      const panelRequest = React.useRef(0)
      const configRequest = React.useRef(0)

      const sessionId = bridge.sessionId
      const closeSettings = React.useCallback(() => setSettingsOpen(false), [])

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
          const request = ++panelRequest.current
          if (sessionId === "") {
            setState({ status: "no-session" })
            return
          }
          // A refresh keeps whatever is already on screen. The loading state is for
          // a session whose answer has never arrived; dropping the payload on a
          // manual refresh emptied the whole rail for the length of the request, and
          // the open settings dialog went with it.
          if (quiet !== true) setState((prior) => (prior.status === "ready" ? prior : { ...prior, status: "loading" }))
          try {
            const data = await call(`/panel?agent=${encodeURIComponent(sessionId)}`)
            if (request !== panelRequest.current || sessionId !== bridge.sessionId) return
            setState({ status: "ready", data })
            setError("")
          } catch (failure) {
            if (request !== panelRequest.current || sessionId !== bridge.sessionId) return
            setState((prior) => ({ status: "ready", data: prior.data }))
            setError(String(failure?.message ?? failure))
          }
        },
        [sessionId],
      )

      React.useEffect(() => {
        ensureStyle()
      }, [])

      React.useEffect(() => {
        setState((prior) => ({ ...prior, status: 'loading' }))
        setError('')
        // The three turn tags are scoped by name, and a turn number is only unique
        // inside its own session: each transcript counts from zero, so two sessions
        // at turn 7 is ordinary. Left alone, a tag written in one session matches a
        // turn in the next and opens a card for a conversation nobody is looking at
        // — and since an open card skips the measurement, that stale tag is never
        // measured away. Clearing here is not the "compare against last render" that
        // D-23 ruled out: switching sessions is one event, not a per-render question.
        setHoverTurn("")
        setPinnedTurn("")
        setClippedTurn("")
      }, [sessionId])

      React.useEffect(() => {
        load(false)
        // A timer, not a subscription. The counts on these cards change when a
        // turn ends and when a file on disk is touched, and neither of those is
        // something this bundle can be told about: it renders from whatever
        // `/panel` answers, and asks again every few seconds.
        const timer = setInterval(() => load(true), REFRESH_MS)
        return () => clearInterval(timer)
      }, [load, sessionId])

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
        const request = ++configRequest.current
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
          if (request !== configRequest.current) return
          if (saved?.ok === false) throw new Error(String(saved.reason ?? saved.error ?? 'the setting was refused'))
          setConfig(saved && typeof saved === "object" ? saved : { ...prior, ...patch })
          setError("")
          load(true)
        } catch (failure) {
          if (request !== configRequest.current) return
          setConfig(prior)
          if (patch.panelSide !== undefined) {
            bridge.side = prior?.panelSide === 'right' ? 'right' : 'left'
            notify()
          }
          setError(String(failure?.message ?? failure))
        }
      }

      // The tag that scopes every reason for being open to one turn. An empty
      // string never matches, so a session that has not reported a turn yet cannot
      // inherit anything from the one before it.
      const turnId = state.status === "ready" ? String(state.data?.turn ?? "") : ""
      const turnHovered = turnId !== "" && hoverTurn === turnId
      const turnPinned = turnId !== "" && pinnedTurn === turnId
      const turnExpandable = turnId !== "" && clippedTurn === turnId
      // Only the click opens the card now. Pointing at it used to open it, which
      // made the card jump in height whenever the pointer crossed the column —
      // motion the reader did not ask for and could not stop without moving away.
      // Hover now offers instead of acting: it reveals a label on the card, and the
      // card still has to be clicked.
      //
      // Expanded is still gated on the measurement, not just on the click. Without
      // that gate the two channels disagree: `turnExpandable` alone decides whether
      // the card gets a click handler, so any stale reason for being open would
      // produce a card that rendered open and offered nothing to close it with.
      // Requiring the measurement makes "open implies closable" hold by construction
      // rather than by every write path staying correct. A card with nothing hidden
      // loses nothing: expanding it would not have revealed anything.
      const expanded = turnExpandable === true && turnPinned === true
      // The hint exists only where it would lead somewhere: over a card with
      // something hidden. An open card keeps its badge regardless of the pointer —
      // closing has to stay reachable, and the pointer is exactly the thing that
      // may already have left by the time the reader wants out. A closed one still
      // waits to be hovered, because an offer to open is not news on every card in
      // the column.
      const turnHinted = turnExpandable === true && (turnPinned === true || turnHovered === true)

      const data = state.status === "ready" ? state.data : undefined
      const summary = data?.summary
      const skills = Array.isArray(data?.skills?.skills) ? data.skills.skills : []
      const mcp = Array.isArray(data?.mcp) ? data.mcp : []
      const files = Array.isArray(data?.files) ? data.files : []
      // The workspace the paths are relative to. The server sends it once per
      // payload rather than turning every path into a relative one, because the
      // absolute path is also what the row's tooltip shows and what the copy
      // action would need. Absent on an older server, in which case the row falls
      // back to the last three directory segments.
      const cwd = typeof data?.cwd === "string" ? data.cwd : ""
      // The order is the one the conversation wrote them in, newest first, and it
      // arrives that way — `pathsSeen` walks session state's path map backwards.
      // Sorting by mtime here was a second answer to the same question and a
      // different one: a build step touching an old file would jump it to the top
      // of a list about editing.
      const ordered = files
      // Three groups, because the card is asked three different questions and
      // answers the narrowest one first. `fresh` is the turn that just ended —
      // "what did you just do". `earlier` is the rest of the session — "what has
      // this conversation produced". `noisy` is what a tool wrote rather than a
      // person: lockfiles, build output, dependency trees.
      //
      // Noise is separated rather than dropped. A turn that runs `npm install`
      // can record two hundred files, and they would push the three that matter
      // out of the four rows on screen; but a session that only ever touched a
      // lockfile still has to say so, and being able to look is what makes the
      // filtering trustworthy. So the fold counts people's files, and opening the
      // card shows everything with the generated ones labelled in their own
      // group.
      const noisy = ordered.filter((file) => file.noise === true)
      const people = ordered.filter((file) => file.noise !== true)
      const fresh = people.filter((file) => file.turn === true)
      const earlier = people.filter((file) => file.turn !== true)
      // Folded, the four rows are the reader's own work, this turn's first. Open,
      // the whole session is there in three labelled groups, so nothing is
      // hidden without a way to see it.
      const groups = filesOpen === true
        ? [
            { key: 'fresh', label: '', files: fresh },
            { key: 'earlier', label: earlier.length > 0 && fresh.length > 0 ? '更早' : '', files: earlier },
            { key: 'noise', label: noisy.length > 0 ? '生成文件' : '', files: noisy },
          ]
        : [{ key: 'folded', label: '', files: fresh.concat(earlier).slice(0, FOLDED_FILES) }]
      // What the header promises, and it promises one thing: how much this
      // session produced. It counts the generated files too, because they were
      // produced. The old header counted people's files and then named the
      // generated ones beside it — two numbers about two lists, sitting next to a
      // badge naming a third, so a reader had to work out which pair agreed. The
      // generated files are now labelled by their own group (visible on opening),
      // and the badge says how many rows are not on screen, which is the other
      // question a folded card raises.
      const fileMeta = `${ordered.length} 个文件`
      // How many rows the folded card actually draws. Equality with
      // `FOLDED_FILES` is not assumed: a session with two written files shows two.
      const foldedRows = fresh.concat(earlier).slice(0, FOLDED_FILES).length
      const hiddenFiles = ordered.length - (filesOpen === true ? ordered.length : foldedRows)
      // What the sweep could see, said out loud. `paths` empty reads as "this turn
      // produced nothing", and that is a different sentence from "nothing I could
      // see" — only the collector knows which one happened, so it sends `sweep`
      // and the card repeats it rather than guessing. `complete` says nothing:
      // a caveat on every card is a caveat nobody reads.
      const sweep = typeof data?.sweep === 'object' && data.sweep !== null ? data.sweep : undefined
      const coverage = typeof sweep?.coverage === 'string' ? sweep.coverage : ''
      const blindNote = coverage === 'partial'
        ? '目录没读完，可能还有文件没列出'
        : coverage === 'none'
          ? '这一轮没有检查目录，列表可能不全'
          : ''
      // How many files the turn that just ended wrote. `files` is the whole
      // session's work now, so it cannot answer that question, and the two other
      // numbers on the same row are turn-scoped.
      const turnFiles = Number.isFinite(data?.turnFiles) ? data.turnFiles : 0

      // Opening a preview is a side effect on someone else's surface, so a throw
      // from the sidebar must not take the whole card column down with it. The
      // Host's own `openResource` throws when no conversation is adopted yet —
      // which is a normal state for a panel that outlives a session switch.
      const openFile = (address) => {
        if (typeof openResource !== 'function') return
        try {
          openResource(address)
        } catch {}
      }
      // Whether this Host can preview at all. It is read here, in the closure that
      // owns the channel, rather than in the `Card` body: `Card` never receives the
      // opener as a prop, so a row that tested its own props for one would answer
      // "no" on every Host and quietly render plain text everywhere.
      const canPreview = typeof openResource === 'function'

      // Three cases, and the third is why this is not a one-line ternary.
      //
      // A `reason` is a log line, not a sentence for a reader: it is English,
      // it names the failing subsystem, and several of them are conditions the
      // person can fix in the settings dialog next to this card. `summaryReason`
      // translates them and keeps the original for the row's `title`.
      const hasSummaryText = summary?.text !== undefined && String(summary.text).length > 0
      const summaryReason = hasSummaryText
        ? { text: "", detail: "" }
        : summaryReasonText(summary?.reason ?? (state.status === "no-session" ? "open a conversation first" : "no completed turn yet"))
      const summaryText = state.status === 'loading'
        ? '正在读取本轮数据…'
        : hasSummaryText
          ? String(summary.text)
          : summaryReason.text
      // Only a summary that exists has a time. A failure reason is not dated:
      // "生成失败 · 3 分钟前" would imply the retry is stale.
      const summaryAgo = hasSummaryText ? formatAgo(summary?.at) : ""

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

      const commands = Array.isArray(data?.commands) ? data.commands.length : 0
      const settings = settingsOpen === false ? null : jsx(Modal, {
        key: settingsEpoch,
        id: 'dsse-settings-dialog',
        className: 'dsse-settings-dialog',
        title: '面板设置',
        subtitle: '只保留与当前阅读体验有关的选项。',
        onClose: closeSettings,
        children: jsxs('div', {
          children: [
            jsxs('div', {
              className: 'dsse-settings-body',
              children: [
                error === '' ? null : jsx('p', { className: 'dsse-err', role: 'alert', children: error }),
                jsxs('label', {
                  className: 'dsse-setting',
                  children: [
                    jsxs('span', {
                      className: 'dsse-setting-copy',
                      children: [
                        jsx('span', { className: 'dsse-setting-label', children: '每轮自动总结' }),
                        jsx('span', { className: 'dsse-setting-desc', children: '关闭后不再为面板调用模型。' }),
                      ],
                    }),
                    jsx('input', {
                      className: 'dsse-check',
                      type: 'checkbox',
                      checked: config?.panelSummary === true,
                      disabled: config === undefined,
                      onChange: (event) => saveConfig({ panelSummary: event.target.checked === true }),
                    }),
                  ],
                }),
                jsxs('label', {
                  className: 'dsse-setting',
                  children: [
                    jsxs('span', {
                      className: 'dsse-setting-copy',
                      children: [
                        jsx('span', { className: 'dsse-setting-label', children: '总结模型' }),
                        jsx('span', { className: 'dsse-setting-desc', children: '默认沿用当前会话已验证的路由。' }),
                      ],
                    }),
                    jsxs('select', {
                      className: 'dsse-select',
                      value: selectedModel,
                      disabled: config === undefined || providerOptions.length === 0,
                      onChange: (event) => {
                        const raw = String(event.target.value ?? '')
                        if (raw === '') {
                          saveConfig({ summaryProvider: '', summaryModel: '' })
                          return
                        }
                        const [provider, model] = raw.split('\u0000')
                        saveConfig({ summaryProvider: provider, summaryModel: model })
                      },
                      children: [
                        jsx('option', { value: '', children: '跟随当前会话' }),
                        ...providerOptions.map((option) => jsx('option', { value: option.value, children: option.label }, option.value)),
                      ],
                    }),
                  ],
                }),
                jsxs('div', {
                  className: 'dsse-setting',
                  children: [
                    jsxs('span', {
                      className: 'dsse-setting-copy',
                      children: [
                        jsx('span', { className: 'dsse-setting-label', children: '面板位置' }),
                        jsx('span', { className: 'dsse-setting-desc', children: '空间不足时自动切换到另一侧。' }),
                      ],
                    }),
                    jsx('div', {
                      className: 'dsse-side-options',
                      role: 'group',
                      'aria-label': '面板位置',
                      children: ['left', 'right'].map((side) => jsx('button', {
                        className: 'dsse-side-option',
                        type: 'button',
                        'aria-pressed': bridge.side === side,
                        onClick: () => {
                          bridge.side = side
                          notify()
                          saveConfig({ panelSide: side })
                        },
                        children: side === 'left' ? '左侧' : '右侧',
                      }, side)),
                    }),
                  ],
                }),
                jsx('p', { className: 'dsse-settings-note', children: '此处修改立即生效，重启宿主后恢复。永久修改请前往插件设置。' }),
              ],
            }),
            jsx('footer', { className: 'dsse-settings-foot', children: jsx('button', { className: 'dsse-btn dsse-btn-primary', type: 'button', onClick: closeSettings, children: '完成' }) }),
          ],
        }),
      })

      const activity = [
        ...skills.map((skill) => ({ kind: 'skill', name: skill.name, owned: skill.owned === true, lastUsed: skill.lastUsed ?? 0 })),
        ...mcp.map((server) => ({ kind: 'mcp', name: server.server, tools: server.tools, lastUsed: server.lastUsed ?? 0 })),
      ].sort((a, b) => b.lastUsed - a.lastUsed)
      // A card is drawn only when it has something to say. Loading used to count
      // as content, which meant switching to a session with nothing in it showed a
      // column of empty cards with a "reading…" line, then hid them a moment later
      // — a flash that reads as a glitch. Waiting costs nothing: the cards appear
      // when the answer arrives, and a session that produced nothing shows nothing.
      const turnHasContent =
        data !== undefined &&
        ((summary?.text !== undefined && String(summary.text).length > 0) || (data.calls ?? 0) > 0 || (data.failed ?? 0) > 0 || turnFiles > 0)
      const showTurn = turnHasContent
      const showActivity = activity.length > 0
      const showFiles = ordered.length > 0
      const pendingCandidates = Number.isFinite(data?.pendingCandidates) ? data.pendingCandidates : 0
      // Pending candidates count as content too. The header button is the panel's
      // only route to the review dialog, so hiding it while the queue holds work
      // would leave those decisions reachable only through the slash command.
      const hasAnyCard = showTurn || showActivity || showFiles || pendingCandidates > 0

      // Nothing to show and nothing wrong: draw a single line saying so while the
      // answer is still on its way, and nothing at all once it has arrived and the
      // session genuinely produced nothing.
      //
      // This is narrower than the "loading counts as content" rule that was removed
      // earlier. That one drew a whole column of empty cards around a "reading…"
      // line, and the column then vanished a moment later — the flash that reads as
      // a glitch. One line, in a rail that would otherwise be blank, has nothing to
      // flash away from: opening the panel on a session that has not answered yet
      // currently shows a stranger nothing at all, and the difference between "still
      // reading" and "this conversation has done nothing" is worth one line.
      const stillLoading = data === undefined
      if (hasAnyCard === false && error === '') {
        return stillLoading === false
          ? settings
          : jsxs('div', {
              className: 'dsse-rail',
              'data-dsse-rail': '1',
              'data-side': props.place.side,
              style: {
                left: `${props.place.left}px`,
                top: `${props.place.top}px`,
                width: `${props.place.width}px`,
                height: `${props.place.height}px`,
              },
              children: [
                jsx('p', { className: 'dsse-loading', role: 'status', children: '正在加载…' }),
                settings,
              ],
            })
      }

      return jsxs('div', {
        className: 'dsse-rail',
        'data-dsse-rail': '1',
        'data-side': props.place.side,
        style: {
          left: `${props.place.left}px`,
          top: `${props.place.top}px`,
          width: `${props.place.width}px`,
          height: `${props.place.height}px`,
        },
        children: [
          jsxs('div', {
            className: 'dsse-top-row',
            children: [
              jsx('button', {
                className: 'dsse-icon-btn dsse-refresh',
                type: 'button',
                'aria-label': '刷新面板',
                title: '刷新面板',
                onClick: () => load(false),
                children: jsx(Icon, { name: 'refresh' }),
              }),
              jsx('button', {
                className: 'dsse-icon-btn dsse-settings-open',
                type: 'button',
                'aria-label': '面板设置',
                title: '面板设置',
                onClick: () => {
                  setSettingsEpoch((current) => current + 1)
                  setSettingsOpen(true)
                },
                children: jsx(Icon, { name: 'settings' }),
              }),
              // Between the two controls and the queue: the empty stretch in this
              // row is the only place a number can appear and disappear without
              // moving anything a person aims at, and reading order puts it after
              // the two buttons that act on the panel rather than before them.
              jsx(SpeedBadge, { sessionId }),
              jsx(Checklist, {
                sessionId,
                onDecided: () => load(true),
                children: jsxs('button', {
                  className: 'dsse-queue',
                  type: 'button',
                  'aria-label': '建议 候选审核',
                  title: '候选审核',
                  children: [
                    jsx('span', { children: '建议' }),
                    jsx('span', { className: 'dsse-count', children: String(data?.pendingCandidates ?? 0) }),
                  ],
                }),
              }),
            ],
          }),
          error === '' ? null : jsx('p', { className: 'dsse-err', role: 'alert', children: error }),
          showTurn === false
            ? null
            : jsxs(Card, {
                title: '上一轮',
                // Hover and click are wired separately on purpose. Both arrive on
                // the same element, and neither handler reads the other's state.
                onMouseEnter: () => setHoverTurn(turnId),
                onMouseLeave: () => setHoverTurn(""),
                onClick: () => setPinnedTurn(turnPinned === true ? "" : turnId),
                expanded,
                clickable: turnExpandable,
                // Two wordings, and both are reachable now: an open card offers the
                // click that closes it, and it offers it whether or not the pointer
                // is still on the card. Making the badge hover-only while open would
                // hide the one control that leads back out at the moment the pointer
                // drifts away from the card it just opened.
                expandHint: turnHinted === true ? (expanded === true ? '点击收起全文' : '点击展开全文') : undefined,
                head: jsxs('div', {
                  className: 'dsse-head-stats',
                  children: [
                    jsxs('span', { className: 'dsse-head-stat', children: [jsx('b', { children: String(data?.calls ?? 0) }), jsx('span', { children: '调用' })] }),
                    jsxs('span', { className: 'dsse-head-stat', children: [jsx('b', { children: String(commands) }), jsx('span', { children: '命令' })] }),
                    jsxs('span', { className: 'dsse-head-stat', children: [jsx('b', { children: String(turnFiles) }), jsx('span', { children: '文件' })] }),
                    // Dated only when there is a summary to date. Placed after the
                    // counts rather than before them because the counts are what
                    // the turn *was* and the time is only how fresh the telling of
                    // it is — the card is about the work, not about the model call.
                    summaryAgo === ''
                      ? null
                      : jsx('span', { className: 'dsse-head-ago', title: `摘要生成于 ${new Date(summary.at).toLocaleString()}`, children: `更新于 ${summaryAgo}` }),
                  ],
                }),
                children: jsx(Clip, {
                  text: summaryText,
                  // The English original, reachable without spending card space on
                  // it. Empty when the card is showing a real summary.
                  title: summaryReason.detail === '' ? undefined : summaryReason.detail,
                  expanded,
                  // The measurement is reported with the turn it measured, so a late
                  // report cannot describe text that is no longer on screen. A hidden
                  // report still records the turn: "measured, and nothing hidden" is a
                  // fact about this turn, and the empty tag is what says so.
                  onClipped: (hidden) => {
                    setClippedTurn(hidden === true ? turnId : "")
                  },
                }),
              }),
          showActivity === false
            ? null
            : jsxs(Card, {
                title: '技能与 MCP',
                meta: `${skills.length} 技能 · ${mcp.length} 服务`,
                children: [
                  jsx('div', {
                    className: 'dsse-list',
                    children: activity.map((item) => jsxs('div', {
                      className: 'dsse-row',
                      children: [
                        jsx('span', { className: 'dsse-row-icon', 'data-kind': item.kind, children: jsx(Icon, { name: item.kind }) }),
                        jsx('span', { className: 'dsse-row-main', children: jsx('span', { className: 'dsse-name', title: String(item.name), children: item.name }) }),
                        item.kind === 'skill'
                          ? item.owned === true ? jsx('span', { className: 'dsse-badge dsse-badge-own', children: '本插件' }) : jsx('span', { className: 'dsse-badge', children: '技能' })
                          : jsx('span', { className: 'dsse-badge', children: `${item.tools} 工具` }),
                      ],
                    }, `${item.kind}:${item.name}`)),
                  }),
                ],
              }),
          showFiles === false
            ? null
            : jsxs(Card, {
                title: '产出文件',
                // The folded count has to be visible without opening anything, and
                // the open state has to say what is on screen rather than repeat the
                // total. Both numbers sit in the header, where they cannot be scrolled
                // out of view — that was the whole of DEF-51.
                meta: fileMeta,
                // The fold's control is the same round badge the 上一轮 card uses,
                // in the same place and the same size — two cards in one column
                // should not teach the reader two shapes for one gesture. It has to
                // be a real button here rather than card decoration: the rows are
                // buttons too, and a card that swallowed clicks would eat them.
                //
                // It appears while the generated files are hidden too, even when
                // people's files fit in four rows. A filter with no route to the
                // filtered thing is indistinguishable from deletion, and the header
                // would be naming a number the reader cannot reach.
                //
                // Its label answers a different question from the header now: the
                // header says how much was produced, the badge says how many rows
                // are missing from what is on screen. Those are the two things a
                // reader of a folded list wants, and "展开全部 7 个" answered
                // neither — it repeated the header's total in a control whose job
                // was the remainder.
                badgeAction: hiddenFiles > 0 || filesOpen
                  ? {
                      label: filesOpen ? '收起文件' : `显示其余 ${hiddenFiles} 个`,
                      open: filesOpen === true,
                      onClick: () => setFilesOpen((open) => open === false),
                    }
                  : undefined,
                children: [
                  jsx('div', {
                    className: 'dsse-list dsse-files',
                    'data-open': filesOpen === true ? 'true' : 'false',
                    children: groups.map((group) => group.files.length === 0 ? null : jsxs('div', {
                      className: 'dsse-group',
                      'data-group': group.key,
                      children: [
                        group.label === '' ? null : jsx('p', { className: 'dsse-group-label', children: group.label }),
                        group.files.map((file) => {
                          const parts = fileParts(file.path, cwd)
                          // A row is a button, not a div with a handler: it has to be
                          // reachable by keyboard and announced as something that does
                          // something. `canPreview` is false when this Host has no right
                          // sidebar, in which case the row is not interactive at all
                          // rather than looking clickable and doing nothing.
                          //
                          // These children are built in `Cards` and passed down, so `props`
                          // in this closure is `Cards`' own — not `Card`'s. Reading the
                          // opener off props here is how the first draft made every row
                          // inert on every Host.
                          // A row is openable only when the file is really there.
                          // `missing` and `invalid` both mean "the thing you
                          // edited is not a file I can open right now", and a row
                          // that looks clickable but does nothing is worse than
                          // one that says so. An absent status means available:
                          // that is what every row meant before the three states
                          // existed, and a client may talk to an older server.
                          const status = typeof file.status === 'string' ? file.status : 'available'
                          // Only the two states this build knows how to explain count as
                          // gone. A fourth name from a newer server would otherwise render
                          // a row with no reason, no size and no click — the worst of both
                          // outcomes — so it falls back to what every row meant before the
                          // states existed.
                          const gone = status === 'missing' || status === 'invalid'
                          const openable = gone === false && canPreview === true && typeof file.address === 'string' && file.address.length > 0
                          const note = status === 'missing' ? '文件已被删除或移动' : status === 'invalid' ? '文件存在但无法读取' : ''
                          return jsxs(openable === true ? 'button' : 'div', {
                            className: openable === true ? 'dsse-row dsse-row-open' : 'dsse-row',
                            type: openable === true ? 'button' : undefined,
                            'data-noise': file.noise === true ? 'true' : 'false',
                            'data-status': status,
                            title: note === '' ? `${String(file.path)}${openable === true ? '\n点击在侧栏预览' : ''}` : `${String(file.path)}\n${note}`,
                            onClick: openable === true ? () => openFile(file.address) : undefined,
                            children: [
                              jsx(FileIcon, { name: parts.name }),
                              jsx('span', {
                                className: 'dsse-row-main',
                                children: [
                                  jsx('span', { className: 'dsse-name', children: parts.name }),
                                  parts.where === '' ? null : jsx('span', { className: 'dsse-where', children: parts.where }),
                                ],
                              }),
                              jsx('span', {
                                className: gone === true ? 'dsse-size dsse-size-gone' : 'dsse-size',
                                children: status === 'missing' ? '已删除' : status === 'invalid' ? '无法读取' : formatBytes(file.bytes),
                              }),
                            ],
                          }, `file:${file.path}`)
                        }),
                      ],
                    }, group.key)),
                  }),
                  // The caveat sits under the rows, where it explains them. It is
                  // the collector's doubt, repeated verbatim rather than softened:
                  // "nothing was produced" and "nothing was produced that I could
                  // see" look identical in a list, and only this line tells them
                  // apart. Nothing is drawn for a complete sweep.
                  blindNote === '' ? null : jsx('p', { className: 'dsse-note', children: blindNote }),
                ],
              }),
          settings,
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
        syncHostTypography()
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
        setPlace({ ...next, phase: geometry.phase })
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

        // The host publishes which page it is on as an attribute of the
        // conversation body, and that value decides whether the cards are drawn
        // at all. `ResizeObserver` cannot see it: the same element stays mounted
        // across the launcher, a settling conversation and a live one, and the
        // three phases only restyle its children — so switching pages can change
        // the attribute without changing the element's size. Without a listener
        // for it, a session that became a conversation would stay hidden until
        // something unrelated moved.
        //
        // Attributes only. A `childList` observer here would fire on every
        // streamed token, which is the one thing this overlay must not pay for.
        let phaseObserver = null
        if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.documentElement) {
          phaseObserver = new MutationObserver(() => remeasure())
          phaseObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-content-phase"],
            subtree: true,
          })
        }

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
          if (phaseObserver !== null) phaseObserver.disconnect()
          if (typeof window !== "undefined") window.removeEventListener("resize", onResize)
          if (timer !== null) clearInterval(timer)
        }
      }, [remeasure])

      // Re-place when the setting changes side or the column is collapsed.
      React.useEffect(() => {
        remeasure()
      }, [remeasure, place.side])

      if (bridge.open !== true || bridge.sessionId === "") return null

      // The overlay is mounted at the shell, so it is on screen on every page the
      // host has, not only on a conversation. The conversation *body* element is
      // drawn for all of them, which is why asking for it was not enough: on the
      // launcher and the new-session page it is there, empty, and the cards floated
      // over it. `phase` is the host's own answer, so the cards follow the page
      // rather than guessing from the DOM. An unpublished phase is a host we cannot
      // read; the cards stay, because hiding them on a version that does publish
      // nothing would remove the feature entirely.
      const phase = place.phase ?? ""
      if (phase === "hero") return null

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
          children: jsx(Cards, { place }),
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
        title: "技能面板：上一轮 / 技能与 MCP / 产出文件",
        onClick: () => {
          bridge.sessionId = sessionId
          bridge.open = open === false
          // Opening always clears a collapse: a person who clicked the button is
          // asking to see the cards, not to be shown a handle.
          if (bridge.open === true) bridge.collapsed = false
          notify()
        },
        children: ["技能", jsx("span", { className: "dsse-toggle-count", children: "3" })],
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
          openResource = undefined
          stopHostTypography()
          if (typeof document !== "undefined") {
            document.getElementById(`${NS}:style`)?.remove()
          }
        },
        "skill-evolve: panel teardown",
      )

      // Optional on purpose. `sidebarRight` is absent on a Host that ships no
      // sidebar, and putting it in `inject` would make that Host refuse this
      // plugin entirely — a panel that loses one affordance must still load.
      ctx.inject(["sidebarRight"], (child) => {
        const sidebar = child.sidebarRight
        if (sidebar === undefined || typeof sidebar.openResource !== "function") return
        openResource = (address) => sidebar.openResource(address)
        child.effect(
          () => () => {
            if (openResource !== undefined) openResource = undefined
          },
          "skill-evolve: sidebar preview",
        )
      })
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
