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
    /**
     * How often the panel asks when nothing has told it to.
     *
     * This used to be eight seconds and was the panel's only clock. It is now a
     * fallback: an open `EventSource` on `/events` answers the moment the payload
     * could have changed, so the ordinary case is a frame within a round trip of
     * the thing happening rather than up to eight seconds after it.
     *
     * What the fallback is still for is the part no session event can announce,
     * and it is a short list: the global candidate queue (another conversation
     * or a slash command writes it), file sizes (read with `stat` at request
     * time, so another process editing a file raises no event here), and the
     * skill directory (whether a name is taken is a directory read). Sixty
     * seconds is slow enough to be nearly free, and the price it charges is
     * that one of those three can now be up to a minute stale -- that is the
     * trade, not an oversight.
     */
    const REFRESH_MS = 60000

    /**
     * How long one panel request may stay out before it is abandoned.
     *
     * The refresh is skipped while a request is in flight, so a request that
     * never settles would stop the column from ever updating again — and the
     * things that make a request hang (a half-open socket, a proxy that swallowed
     * the answer, a host that is wedged) all leave `fetch` pending forever rather
     * than rejecting. This is the ceiling that turns "in flight" back into "over".
     *
     * Generous compared with a healthy answer (the route is served from memory and
     * a cold one measured under a second after the queue cache landed) and short
     * compared with what a person would call stuck. Deliberately shorter than the
     * summariser's own 20-second ceiling, because this one has to give up before
     * the person concludes the column is broken.
     */
    const PANEL_TIMEOUT_MS = 15000

    /**
     * How wide the monitor column starts out.
     *
     * The design width: 300px is the narrowest column that holds a file path and
     * a skill name without wrapping, and it leaves 734px of prose on a 1440px
     * window with the host sidebar open — the width the prototype was signed off
     * at. `placeMonitor` clamps whatever is asked for; this is only the ask.
     */
    const MONITOR_DEFAULT_WIDTH = 300

    /**
     * The custom property the reserved column publishes to the host's scroller.
     *
     * The column is drawn in `shell.overlay`, which the host lays *over* the
     * conversation rather than inside it, so nothing makes room for it on its own.
     * The one lever that does is a margin on the host's scroll container, applied
     * by the rule keyed on `data-dsse-monitor` in the stylesheet above. The value
     * has to travel through a custom property on `documentElement` because that is
     * the only node both the overlay and the host's scroller can see.
     */
    const MONITOR_RESERVE_PROP = "--dsse-monitor-reserve"

    /**
     * The reservation currently written, as a string, so a re-measure that
     * produced the same number does not touch the DOM again.
     *
     * `element.style.setProperty` with an unchanged value still invalidates style
     * for the whole document, and this runs on every resize frame of a window
     * drag; the guard is what keeps a drag cheap.
     */
    let appliedReserve = ""

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
     * A comparable string for a `/panel` payload, or null when it is not worth
     * comparing.
     *
     * The point is to notice that a poll changed nothing, so the column can keep
     * the object it is already rendering. React compares state by identity, and
     * every answer used to be a fresh object even when its contents were
     * byte-identical -- so the whole column re-rendered every eight seconds to
     * produce the same output.
     *
     * `JSON.stringify` is not a canonical form: two objects with the same pairs in
     * a different order produce different strings. That is accepted rather than
     * fought. It only ever errs towards rendering, never towards skipping a
     * change, and the payloads compared here are built by one function on the
     * server, so their key order is stable in practice.
     *
     * @param {any} data - the payload.
     * @returns {string | null} the signature, or null if it could not be built.
     */
    function panelSignature(data) {
      try {
        // The payload is not the only thing on screen. `formatAgo` turns an
        // absolute `at` into "3 分钟前", and that string is derived from the clock
        // at render time -- the payload itself never changes as the minutes pass.
        // Left out of the signature, an unchanged poll would keep the object
        // identity and the label would freeze at whatever it read the first time,
        // which is the opposite of what the label is for.
        //
        // So the rendered label goes into the signature: it changes exactly when
        // the text on screen would change, and not more often.
        return JSON.stringify(data) + "\u0000" + formatAgo(data?.summary?.at)
      } catch {
        // A payload with a cycle or a BigInt cannot be serialised. Returning null
        // means "always render", which is the behaviour before this existed --
        // the safe answer, not an optimisation that silently stops updating.
        return null
      }
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
      if (raw.startsWith("the summary call was cancelled")) return { text: "摘要生成已取消", detail }
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
     * The path as the workspace sees it, or `undefined` when it is not inside.
     *
     * Separate from `fileParts` on purpose: that one answers "how do I show this
     * path", so it falls back to the last few directory segments when the file is
     * outside the workspace. A relative path is a claim about where the file *is*,
     * and a file outside the workspace has no such answer — inventing one would
     * copy `../../elsewhere.ts` onto a clipboard for a file the conversation never
     * had a workspace-relative name for. `undefined` is what makes the second copy
     * button disappear instead.
     *
     * Forward slashes, because that is what the thing being pasted into wants:
     * backslashes are a Windows path, not a path in source code.
     *
     * @param {string} path - the absolute path.
     * @param {string} cwd - the workspace root.
     * @returns {string | undefined} the path relative to `cwd`.
     */
    function relativePath(path, cwd) {
      if (typeof path !== "string" || path.length === 0) return undefined
      if (typeof cwd !== "string" || cwd.length === 0) return undefined
      const normal = path.split("\\").join("/")
      const root = cwd.split("\\").join("/").replace(/\/+$/u, "")
      if (root === "") return undefined
      // Compared without case — the workspace and the path come from different
      // parts of the Host and Windows does not care which case either used.
      //
      // But the cut cannot be taken by the prefix's length alone. `toLowerCase()`
      // is not length-preserving: `İ` (U+0130) is one code unit and folds to two,
      // and it is the only code point that does. Cut the original by the folded
      // prefix's length and a path under `F:/İst` loses its first character. Same
      // trap `isNoisePath` documents in `api.js` — which is where I should have
      // looked before writing this line again.
      const folded = normal.toLowerCase()
      const foldedRoot = root.toLowerCase()
      if (folded.startsWith(foldedRoot + "/") === false) return undefined
      // Where the fold kept the length, slice the original and keep its case: a
      // relative path pasted into a `require` has to match the file on a
      // case-sensitive disk. Where it did not, the case of the remainder is
      // already gone — return the folded form rather than a slice that is off by
      // a character. Only macOS normalisation can hand us the second case.
      const inside = folded.length === normal.length
        ? normal.slice(root.length + 1)
        : folded.slice(foldedRoot.length + 1)
      const parts = inside.split("/").filter((part) => part.length > 0)
      return parts.length > 0 ? parts.join("/") : undefined
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
/* A square glyph button, sized and padded to sit in the host's header action row
   without changing its height. Borderless until hover, because the host's own
   buttons in that row are borderless: a bordered box here reads as a control that
   belongs to a different toolbar. */
.dsse-toggle{display:inline-grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6270);font-family:var(--dsse-font-family,inherit);cursor:pointer}
.dsse-toggle:hover{background:var(--dsw-alias-bg-layer-2,rgba(15,17,21,.06));color:var(--dsw-alias-label-primary,#0f1115)}
.dsse-toggle[data-active="true"]{background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.12));color:var(--dsw-alias-state-business-primary,#2f4bd8)}
/* No state-business-secondary token exists in the theme, so hover keeps the
   tertiary fill rather than naming a variable that would fall through. */
.dsse-toggle[data-active="true"]:hover{background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.12))}
.dsse-rail{position:absolute;display:flex;flex-direction:column;gap:12px;overflow-y:auto;overflow-x:hidden;padding:0 2px 0 0;scrollbar-width:thin;font-family:var(--dsse-font-family,inherit);font-size:var(--dsse-font-size,inherit);line-height:var(--dsse-line-height,inherit);color:var(--dsw-alias-label-primary,#0f1115)}
.dsse-rail::-webkit-scrollbar,.dsse-candidates::-webkit-scrollbar,.dsse-detail-body::-webkit-scrollbar{width:6px}
.dsse-rail::-webkit-scrollbar-thumb,.dsse-candidates::-webkit-scrollbar-thumb,.dsse-detail-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(15,17,21,.16));border-radius:3px}
.dsse-top-row{flex:0 0 auto;display:flex;align-items:center;gap:6px;min-height:34px;padding:0}
/* The queue is first in the row, so it takes the left edge; the auto margin on
   the speed badge is what pushes the three controls to the right as one group. */
.dsse-top-row .dsse-queue{width:auto;min-height:32px;padding:0 12px}
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
.dsse-head-note{color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.78em,10px);white-space:nowrap;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsse-clip{position:relative;overflow:hidden}
.dsse-clip[data-clipped="true"][data-expanded="false"]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:34px;pointer-events:none;background:linear-gradient(to bottom,transparent,var(--dsw-alias-bg-layer-1,#fff))}
.dsse-clip .dsse-text{max-height:9.3em;overflow:hidden}
.dsse-clip[data-expanded="true"] .dsse-text{max-height:none}
.dsse-card-body{padding:11px}
.dsse-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dsse-summary-title{margin:0 0 6px;font-size:1em;line-height:1.45;font-weight:500}
.dsse-muted{color:var(--dsw-alias-label-secondary,#5b6270)}
.dsse-tiny{font-size:.86em;line-height:1.55}
/* Two states, two placements -- they are not the same gesture and they do not get
   the same box.
   Folded, the badge is a hint that there is more to see: it floats on the fade at
   the list's foot, because a folded list has no room to give it a line of its own.
   Open, there is nothing left to hint at and the list is not clipped any more, so
   the badge becomes a plain row under the content -- floating there would park the
   circle on the last file name, and a row that shifts down when you open it reads
   as the list having gained an item.
   The float is what the folded state needs; the row is what the open state needs.
   One rule for both is what kept putting the circle on top of a file name. */
.dsse-expand{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#5b6270);box-shadow:0 1px 3px rgba(15,17,21,.10);user-select:none;pointer-events:none;opacity:0;transition:opacity 160ms ease}
/* Folded: out of the flow, riding the fade band, centred like a page turn. */
.dsse-card[data-open="false"] .dsse-expand{position:absolute;left:50%;bottom:6px;transform:translateX(-50%)}
/* Open: a row under what it revealed. */
.dsse-card[data-open="true"] .dsse-expand{position:static;left:auto;bottom:auto;transform:none;margin:6px auto 0}
/* The badge is a hint, not furniture: it fades in when the pointer reaches the
   card and leaves when it goes. Two cards learnt one shape for one gesture, so
   both follow it — and the fade also means a folded list no longer carries a
   permanent circle over the last row it is hiding.
   It stays on screen while the card is open. The open state is the one place a
   reader needs the way back out without hunting for it with the pointer, and
   aria-expanded already says the card is in that state for a screen reader. */
.dsse-card:hover .dsse-expand,
.dsse-card:focus-within .dsse-expand,
.dsse-card[data-open="true"] .dsse-expand,
.dsse-recap:hover .dsse-expand,
.dsse-recap:focus-visible .dsse-expand,
.dsse-recap[data-expanded="true"] .dsse-expand,
/* The summary and the queue row are one card now, so the pointer reaching any
   part of it has to reveal the summary's badge. Without this the badge only
   answers a pointer that lands on the summary text itself, which reads as a
   card that has nothing to offer. Same for keyboard focus. */
.dsse-col-top:hover .dsse-expand,
.dsse-col-top:focus-within .dsse-expand{opacity:1}
.dsse-expand .dsse-icon{width:15px;height:15px}
/* Open, it stays visible without the pointer: closing is the one thing a reader
   should not have to hunt for. */
.dsse-card[data-open="true"] .dsse-expand{opacity:1;pointer-events:auto}
/* The summary gets the same two placements as the file card, and for the same
   reason. A cut-off summary is a folded list of lines: it already owns a fade
   over its last visible line, and there is no spare row under the text to park
   a circle in. Giving it a static row made every summary one line taller than
   the text it held, which is exactly the empty band this card was just rid of. */
.dsse-recap[data-expanded="false"] .dsse-expand{position:absolute;left:50%;bottom:6px;transform:translateX(-50%)}
/* Open, the text is no longer clipped, so the badge steps out of the fade and
   becomes a row under what it revealed. */
.dsse-recap[data-expanded="true"] .dsse-expand{position:static;left:auto;bottom:auto;transform:none;margin:6px auto 0}
/* Hidden means unreachable too: at opacity 0 a live button would still eat the
   clicks of the row underneath it, and the row underneath it is a file. */
.dsse-expand-action{pointer-events:none;cursor:pointer;padding:0;font:inherit}
.dsse-card:hover .dsse-expand-action,
.dsse-card:focus-within .dsse-expand-action,
.dsse-card[data-open="true"] .dsse-expand-action{pointer-events:auto}
.dsse-expand-action:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-expand-action:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#2f4bd8);outline-offset:2px}
.dsse-loading{margin:0;padding:8px 4px;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px)}
.dsse-list{display:grid;gap:3px}
.dsse-row{position:relative;display:flex;align-items:center;gap:6px;min-width:0;min-height:28px;padding:2px 6px;border-radius:7px;box-sizing:border-box}
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
.dsse-files{display:grid;gap:3px;position:relative}
/* A folded list has to show that it is folded. The rows simply stopped after
   four with nothing to say so, and the badge was the only hint — invisible
   until the pointer arrived, which is useless to someone deciding whether to
   look. The last row fades into the card and the edge is the message. */
/* Four rows and the half-row of fade under them. Overflow hidden is the part
   that does the clipping: a max-height alone leaves the overflow visible, so the
   list kept drawing every row and the badge that follows it landed on top of the
   last one. Rows are 28px with a 3px gap, so four of them measure 121. */
.dsse-files[data-open="false"]{max-height:calc(4 * 31px - 3px);overflow:hidden}
/* One row tall, so it covers the half row the fold cuts and no more. The badge
   rides this band; a taller one would wash out the whole last row instead of
   marking where the list stops. */
.dsse-files[data-open="false"]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:34px;pointer-events:none;background:linear-gradient(to bottom,transparent,var(--dsw-alias-bg-layer-1,#fff) 70%)}
.dsse-files[data-open="true"]{max-height:${FILE_LIST_MAX_PX}px;overflow-y:auto;overscroll-behavior:contain}
.dsse-row-open{display:flex;align-items:center;gap:6px;flex:1;min-width:0;margin:-2px -6px;padding:2px 6px;align-self:stretch;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsse-row-open:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#2f4bd8);outline-offset:-2px}
/* A row that cannot be opened still lays its parts out the same way: the
   difference between the two is whether the block is clickable, not where the
   name and the size sit. */
.dsse-row-body{display:flex;align-items:center;gap:6px;flex:1;min-width:0}
/* One control, on top of the size, and the menu it opens. Reserving room for a
   button that is invisible until hover would shorten every name in the list to
   pay for something the reader cannot see; overlaying it means the name keeps
   its width and nothing moves when the pointer arrives. The size hides by
   visibility, not by display, for the other half of that promise — it keeps
   its slot, so the name does not grow back either. */
.dsse-row-actions{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:flex;gap:2px;opacity:0;pointer-events:none;transition:opacity 120ms ease}
/* Both the reveal and the size it covers are scoped to rows that have
   actions. On a Host without a clipboard the actions never render, and a row
   that hid its size on hover to make room for nothing would be strictly worse
   than the row it replaced.
   The data-menu flag keeps both rules on while the menu is open: the pointer
   has to travel from the button down to the menu, and that trip leaves the row.
   Without it the control that was just clicked would fade out under the
   pointer that clicked it. */
.dsse-row[data-actions="true"]:hover .dsse-row-actions,.dsse-row[data-actions="true"]:focus-within .dsse-row-actions,.dsse-row[data-menu="true"] .dsse-row-actions{opacity:1;pointer-events:auto}
.dsse-row[data-actions="true"]:hover .dsse-size,.dsse-row[data-menu="true"] .dsse-size{visibility:hidden}
.dsse-row-copy{width:22px;height:22px;display:inline-grid;place-items:center;flex:0 0 auto;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6270);cursor:pointer}
/* A keyboard reader gets the button and the size at the same time, and the two
   occupy the same twenty pixels: the size is right-aligned to six pixels from the
   row edge and the button starts twenty-six from it. On hover the size steps out
   of the way; on focus it must not, because hiding it would drop it out of the
   accessibility tree and a keyboard reader has no other way to learn the file's
   size. So the button stays and covers its own footprint instead of sharing it,
   and the size keeps whatever is left of the line. The lighter stroke is the same
   correction at one pixel of scale: at 14px the shared 1.7 reads about 18 percent
   thinner than the 17px icons beside it. */
.dsse-row[data-actions="true"]:focus-within .dsse-row-copy:not([aria-expanded="true"]){background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-row-copy .dsse-icon{width:14px;height:14px;stroke-width:2}
.dsse-row-copy:hover{color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
/* Open is a state of the button, not a second button: the border is what tells
   a reader the menu below belongs to this row rather than to the one under it. */
.dsse-row-copy[aria-expanded="true"]{border-color:var(--dsw-alias-border-l2,#e3e6ec);background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#0f1115)}
.dsse-row-copy:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#2f4bd8);outline-offset:-2px}
/* The answer lives on the same control, as a colour rather than a word: the
   button is 22px and any text that fits there is too short to read. */
.dsse-row-copy[data-ok="true"]{color:var(--dsw-alias-state-success-primary,#1f7a4d)}
.dsse-row-copy[data-ok="false"]{color:var(--dsw-alias-state-error-primary,#b4232c)}
/* The menu is a block in the list, not a popup floating over it. The card is
   overflow:hidden and the list is overflow-y:auto, so anything positioned
   outside this box would be cut off exactly where the list is long enough to
   need it — which is the case where a reader is most likely to be looking.
   Staying in flow also means no measurement, no resize listener, and Tab
   reaches the items because they follow the button in document order. The shadow
   is a step lighter than the card's: this panel is drawn inside that card, and a
   surface nested in another does not cast the same shadow as the one holding it. */
.dsse-row-menu{display:grid;gap:1px;margin:0 0 2px 22px;padding:3px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.1));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 3px rgba(15,17,21,.06)}
.dsse-row-menuitem{display:flex;align-items:baseline;gap:8px;width:100%;padding:4px 7px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsse-row-menuitem:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-row-menuitem:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#2f4bd8);outline-offset:-2px}
.dsse-row-menuitem-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:max(.85em,11px)}
/* No path in the item. A long path can only be shown truncated, and a
   truncated path describes the clipboard's contents worse than the label does;
   it also makes the two entries different widths, which moves the eye. The
   value still goes where it is useful -- into the clipboard on click. */
.dsse-group{display:grid;gap:3px}
.dsse-group + .dsse-group{margin-top:6px}
.dsse-group-label{margin:0;padding:2px 6px 0;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.8em,10px);letter-spacing:.02em}
.dsse-row[data-noise="true"] .dsse-name{color:var(--dsw-alias-label-tertiary,#8b92a1)}
/* Older, not gone and not generated: the name steps back a shade, nothing else.
   No strikethrough — that belongs to the missing state, which means the file is
   not there. A stale row is still a live link to a real file, and drawing it like
   a deleted one would make the reader think the work was lost. */
.dsse-row[data-stale="true"] .dsse-name{color:var(--dsw-alias-label-secondary,#5b6270)}
.dsse-row[data-status="missing"] .dsse-name,.dsse-row[data-status="invalid"] .dsse-name{color:var(--dsw-alias-label-tertiary,#8b92a1);text-decoration:line-through}
.dsse-row[data-status="unresolved"] .dsse-name,.dsse-row[data-status="folder"] .dsse-name{color:var(--dsw-alias-label-tertiary,#8b92a1)}

.dsse-row[data-status="missing"],.dsse-row[data-status="invalid"],.dsse-row[data-status="unresolved"],.dsse-row[data-status="folder"]{cursor:default}
.dsse-row[data-status="missing"]:hover,.dsse-row[data-status="invalid"]:hover,.dsse-row[data-status="unresolved"]:hover,.dsse-row[data-status="folder"]:hover{background:transparent}
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
/* The column draws no edges of its own. Earlier versions ruled the left and top
   sides and cast a shadow leftwards; the verdict was that the ruling makes the
   panel look like a separate window rather than part of the conversation, so
   all three are gone and the column is told apart by its own surface and the
   cards' outlines instead.
   Overflow is left visible on purpose. The grab strip hangs 12px outside the
   left edge, and overflow:hidden was clipping that half away — the strip was
   20px wide but only 8px of it could be hit. The body below clips its own
   overflow, so nothing escapes the column. */
.dsse-monitor{position:absolute;display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-base,#fff);border-radius:var(--dsw-radius-md,12px) 0 0 var(--dsw-radius-md,12px);color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--dsse-font-family,inherit);font-size:var(--dsse-font-size,inherit);line-height:var(--dsse-line-height,inherit);pointer-events:auto}
/* The header is the list's first child, not a sibling above it, so it can be
   stuck to the top of the one scroller the column has. It carries the column's
   own surface: cards slide underneath as the list scrolls, and a transparent
   header would let them show through the queue row and the summary at once.
   The negative margins cancel the body's horizontal padding so the header's
   background spans the full column width; the padding puts the insets back. */
.dsse-col-top{position:sticky;top:0;z-index:2;margin:0 0 8px;padding:0;background:var(--dsw-alias-bg-base,#fff)}
/* The header's surface is a card, not a band. It used to be stretched past the
   body's padding with negative margins so its background covered the full
   column width while scrolling; that made it 20px wider than the cards below
   it, which is what the eye reads as a broken edge. The wrapper is now nothing
   but a sticky strip that carries the column's own surface, and the card inside
   it is sized like every other card: same width, same outline, same radius. */
.dsse-col-card{border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.1));border-radius:11px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 2px 8px rgba(15,17,21,.04);padding:8px 10px 6px}
.dsse-col-top .dsse-top-row{margin-bottom:0}
/* The previous turn, in the header. One quiet line saying how fresh the telling
   is, then the telling. The rules are the card's rules, moved: same fade, same
   cap, so a summary behaves the same way in either place. */
.dsse-recap{position:relative;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.06))}
.dsse-recap[data-clickable="true"]{cursor:pointer}
/* No strip reserved under the text. The badge floats over the last line the
   fade is already covering, so a folded summary is exactly five lines tall —
   it used to reserve 24px for a circle that only appears on hover, and the
   empty band under the text is what made four lines look like a mistake. */
.dsse-recap[data-clickable="true"] .dsse-clip::after{height:34px}
.dsse-recap-when{display:flex;align-items:center;gap:6px;margin:0 0 5px;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.78em,10px);line-height:1.4}
.dsse-recap-dot{flex:0 0 auto;width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-brand-primary,#2f4bd8);opacity:.55}
/* Five lines, not four. dsse-tiny is 0.86em with line-height 1.55, so one line
   is 1.333em and five is 6.67em; the cap is stated in the same unit as the text
   so the two cannot drift apart. */
.dsse-recap .dsse-text{max-height:calc(5 * 1.55 * 1em)}
.dsse-recap[data-expanded="true"] .dsse-text{max-height:none}
.dsse-recap .dsse-clip[data-clipped="true"][data-expanded="false"]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:30px;pointer-events:none;background:linear-gradient(to bottom,transparent,var(--dsw-alias-bg-layer-1,#fff))}
/* The scrolling body of the column, and the rail it holds. Both were casualties
   of the pass that deleted the old gutter layout: the body lost its own rule and
   kept only the two descendant ones below, so the column had no scroller at all,
   and the cards — which are a plain flex column when embedded — were cut off by
   the column's own overflow:hidden the moment the width was dragged in. The rail
   likewise kept its floating rule's position:absolute and collapsed. */
.dsse-monitor-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:8px 10px 10px;scrollbar-width:thin}
.dsse-rail[data-embedded="true"]{position:static;width:auto;height:auto;max-height:none;overflow:visible;padding:0;gap:10px}
.dsse-monitor-body .dsse-card{box-shadow:none}
.dsse-monitor-body .dsse-icon-btn{width:30px;height:30px;border-radius:7px}
/* The grab strip reaches well outside the column edge and is wider than it
   looks. At 8px it sat exactly under the border, which meant the pointer had to
   find a line one pixel wide between two things that both look like edges; the
   report was that dragging cards near the edge was awkward. The visible line
   stays 3px so the edge still reads as an edge. */
.dsse-monitor-grip{position:absolute;left:-12px;top:0;bottom:0;width:20px;cursor:col-resize;touch-action:none;display:flex;justify-content:flex-end;align-items:center}
.dsse-monitor-grip::after{content:"";width:3px;height:34px;border-radius:999px;background:transparent;transition:background-color 160ms ease}
.dsse-monitor-grip:hover::after,.dsse-monitor-grip[data-dragging="true"]::after{background:var(--dsw-alias-state-business-primary,rgba(77,107,254,.55))}
html[data-dsse-monitor="1"] [data-conversation-content] [data-conversation-scroll]{margin-right:var(--dsse-monitor-reserve,0px)}
html[data-dsse-monitor="1"] [data-conversation-content] [data-width-handle="right"]{display:none}
/* The host hides its turn rail whenever the scrolling container is 900px or
   narrower: @container (width<=900px){...display:none}. That container is the
   rail's own slot, and its width is the scroll area minus 32px of padding a
   side. The measurement is of the area, not of the room the prose leaves in it,
   and those differ by a lot: 1160px of area with 742px of prose leaves 209px a
   side, five times the 40 the rail spends, and the host hides it anyway.

   Our column narrows that area, which is why the rail vanished the moment the
   column was wide enough to be worth having, and came back when it was dragged
   thin again. That report is the whole reason this rule exists.

   A width query at 900px cannot answer the question either. Whether the rail
   has room is a question about the room the prose leaves beside itself, and the
   host's query never looks at the prose — so it hides the rail on windows that
   have five times the space the rail needs.

   An earlier version answered it anyway, measuring the gutter and publishing a
   yes/no. That was wrong for two reasons and both of them were the same bug:
   the measurement was taken against an area that already had this column's
   reservation subtracted from it, so on the default column it read as "no room"
   at every window size the panel was used at; and even measured correctly it
   would have hidden the rail in cases where the rail fits, because the prose's
   centred box leaves half of the leftover space a side and only the right half
   is the rail's to use.

   So this rule does not ask. While our column is on, we have already paid the
   rail's 40px out of the column's budget in placeMonitor — the budget goes to
   the rail first and the column takes what is left — and the rule below spends
   that budget by showing the rail the host decided to hide. When the column is
   off we have taken no width, the host's own threshold is the correct one, and
   we stay out of its way.

   The class is a CSS-module hash and will change when the host is rebuilt; the
   aria-label is the stable fallback. Matching neither costs the rail, never the
   conversation. */
html[data-dsse-turn-rail="1"] [data-conversation-scroll] nav[class*="SNx2jG_frame"],
html[data-dsse-turn-rail="1"] [data-conversation-scroll] nav[aria-label="轮次导航"],
html[data-dsse-turn-rail="1"] [data-conversation-scroll] nav[aria-label="Turn navigation"],
/* Structural fallback. TurnNavigator is the only nav inside the conversation
   scroll body (the breadcrumb nav lives in the header). The three selectors
   above key on a CSS-module hash and two translations, any of which can differ
   between the asar the bundle was read from and the build actually running; a
   mismatch there leaves only the host's 900px query, which hides the rail. This
   selector has nothing to drift, so the rule holds even when they do not match. */
html[data-dsse-turn-rail="1"] [data-conversation-scroll] nav{display:block !important;visibility:visible !important;pointer-events:auto !important}

/* Retire a stand-in rail once the host's own rail is back.
   The claude-style theme ships a "redraw the turn rail" feature that marks the
   host nav with data-dsh-claude-turn-nav-replaced, hides it with visibility and
   pointer-events, and paints its own .dsh-claude-turn-rail into the same slot.
   We re-show the host nav, so that stand-in is a second rail drawn over the
   first — and the two do not agree on geometry. Measured in the desktop app
   they shared x 1263..1291 but ran 281..543 against 292..532, an 11px offset
   that reads as the rail being misaligned. The stand-in carries its own
   @container (width<=900px){display:none}, which is why the doubling came and
   went as the column was dragged: a 978px slot minus 64px of padding is 914,
   just over its threshold, and narrowing the column pushed it back under.
   Hiding the stand-in leaves exactly one rail, the host's, at every width. Its
   own markup is aria-hidden, so nothing is lost for screen readers.

   Not scoped to the column being open. "One rail, not two" is an invariant of
   the page, not of our column: with the column closed the scroll area is back to
   its full width, which is exactly the case where the stand-in's 900px query
   lets it through -- and the host's own rail is visible at that width too, so
   the theme drew its rail beside the host's again. That was reported as "two
   rails the moment the column is closed". Scoping this rule to the column made
   it go inert at precisely that width, so it is retired unconditionally. */
[data-conversation-scroll] .dsh-claude-turn-rail{display:none !important}

/* No stacking lift is needed, and one was tried. The column is drawn beside the
   scroll area rather than over it: measured in a live session the scroll area
   ran 280..475, the rail 425..453, and the column 475..695 — the rail ends
   exactly where the column begins. An earlier rule raised the slot's z-index to
   30 on the theory that the column covered the rail. That theory came from a
   probe which had moved the column by hand without moving the reservation with
   it, so the overlap it measured was an artefact of the probe rather than a
   property of the layout. Keeping the rule would only disturb the host's
   stacking to fix a collision that does not happen. */
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
    const bridge = { sessionId: "", open: true, monitorWidth: 0, listeners: new Set() }

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

    /**
     * Which conversation the host is actually showing, read from the page.
     *
     * `bridge.sessionId` is written by the header button, which is a
     * session-scoped seat: its effect runs when its `sessionId` prop changes.
     * That is one render behind whatever the reader just clicked, and the
     * column reads the same variable from its own closure — so a switch that
     * did not produce a fresh render of the column left it polling the session
     * the reader had already left. The symptom is specific and was reproduced
     * on a live host: the conversation changes, the column keeps showing the
     * old one, and clicking the header button once fixes it (that click writes
     * `bridge.sessionId` directly).
     *
     * The host publishes the answer itself: the conversation body carries
     * `data-conversation-session`. Reading it is one `querySelector` on the
     * path that is about to make a request, which is the cheapest possible
     * place to be correct, and it does not depend on any effect having run.
     *
     * Returns `""` when the attribute is absent (launcher, a settling
     * conversation, or a test harness), which callers treat as "no opinion"
     * and fall back to `bridge.sessionId`.
     *
     * @returns {string} the session id on screen, or `""`.
     */
    function liveSessionId() {
      if (typeof document === "undefined" || typeof document.querySelector !== "function") return ""
      const node = document.querySelector("[data-conversation-session]")
      if (node === null || typeof node.getAttribute !== "function") return ""
      const value = node.getAttribute("data-conversation-session")
      return typeof value === "string" ? value : ""
    }

    /**
     * Hand prose width to the monitor column, or take it back.
     *
     * The column is drawn in `shell.overlay`, which the host lays *over* the
     * conversation rather than inside it, so nothing makes room for it on its own.
     * The one lever that does is a margin on the host's scroll container, applied
     * by the rule keyed on `data-dsse-monitor` in the stylesheet above; the value
     * travels through a custom property because that is the only thing both the
     * overlay and the host's scroller can see.
     *
     * Both writes are guarded. The attribute comes from `setAttribute`, which a
     * non-element root may not have — a Host (or a test harness) whose
     * `documentElement` carries only `style` still draws the column, it just
     * covers the prose instead of reserving room. The property is skipped when the
     * number did not change, because re-setting an identical custom property still
     * invalidates style for the document and this runs on every frame of a resize.
     *
     * The turn-rail attribute rides on the same write and is the column's own
     * state, not a second measurement: while there is a column, its width budget
     * has already been reduced to leave the rail its 40px, so the rail is shown.
     * See the rule keyed on `data-dsse-turn-rail` in the stylesheet for why the
     * bundle must answer that and the host's 900px query must not.
     *
     * @param {number} reserve - pixels of prose to hand over; 0 releases them.
     */
    function applyMonitorReserve(reserve) {
      if (typeof document === "undefined") return
      const root = document.documentElement
      if (root === undefined || root === null) return
      const width = Number.isFinite(reserve) && reserve > 0 ? Math.round(reserve) : 0
      if (typeof root.setAttribute === "function") {
        const wanted = width > 0 ? "1" : "0"
        if (typeof root.getAttribute !== "function" || root.getAttribute("data-dsse-monitor") !== wanted) {
          root.setAttribute("data-dsse-monitor", wanted)
        }
        // Same value as the reservation, so the two cannot disagree about whether
        // we are the reason the scroll area is narrow.
        if (typeof root.getAttribute !== "function" || root.getAttribute("data-dsse-turn-rail") !== wanted) {
          root.setAttribute("data-dsse-turn-rail", wanted)
        }
      }
      const value = `${width}px`
      if (value === appliedReserve) return
      appliedReserve = value
      if (root.style !== undefined && root.style !== null) root.style.setProperty(MONITOR_RESERVE_PROP, value)
    }

    /**
     * Force the host's turn rail to stay visible while our column is open.
     *
     * The stylesheet carries three selectors for this (plus a structural one),
     * but isolation proved the cascade is fine and the real GUI still hid the
     * rail: the running build's CSS-module hash or aria-label translation did
     * not match what the bundle was authored against, so only the host's own
     * 900px container query answered and the rail vanished until the column was
     * narrowed. An inline style wins over that non-important query regardless
     * of how the host hashes its classes or translates its labels, and searching
     * the document rather than a CSS selector removes the last thing that could
     * drift. TurnNavigator is the only nav inside the conversation scroll body;
     * the breadcrumb nav is in the header and is deliberately left alone.
     *
     * @param {boolean} visible - true to hold the rail open, false to release it.
     * @returns {number} how many rail nodes were touched (useful to tests).
     */
    /**
     * Whether the host has its right column open.
     *
     * The host publishes both facts on the frame, written with the
     * `flag || void 0` idiom -- React drops an `undefined` attribute -- so the
     * attribute's *absence* is what says "open":
     *
     *   data-sidebar-collapsed   the LEFT column, the session list
     *   data-rightbar-collapsed  the RIGHT column, where previews open
     *
     * This has to read the right one. The left column is open in the default
     * layout, so `data-sidebar-collapsed` is absent on an ordinary screen, and
     * binding to it answered "the sidebar is open" everywhere -- which skipped
     * the column on every render and is why the panel went missing in the
     * desktop app *and* in the browser.
     *
     * The right column is also the one that competes for the space: it takes
     * 400-570px out of the centre, which is the room this column wanted. The
     * left column costs nothing here; the conversation was never going to use
     * it.
     *
     * The frame has no stable class or id, so it is reached through the overlay
     * layer, which is a literal `data-shell-overlay` member of it.
     *
     * A frame that cannot be reached reads as "not open", which is the answer
     * that changes nothing: this overlay is mounted *inside* that layer, so its
     * absence means the host is not the one we know, and closing the panel on
     * that guess would hide it for reasons the reader could never see.
     *
     * @returns {boolean} true when the host's right column is open.
     */
    function sidebarOpen() {
      if (typeof document === "undefined") return false
      if (typeof document.querySelector !== "function") return false
      const overlay = document.querySelector("[data-shell-overlay]")
      if (overlay === null || overlay === undefined) return false
      const frame = overlay.parentElement
      if (frame === null || frame === undefined) return false
      if (typeof frame.hasAttribute !== "function") return false
      return frame.hasAttribute("data-rightbar-collapsed") === false
    }

    function forceTurnRail(visible) {
      if (typeof document === "undefined") return 0
      if (typeof document.querySelectorAll !== "function") return 0
      const nodes = document.querySelectorAll("[data-conversation-scroll] nav")
      let touched = 0
      for (const node of nodes) {
        if (node === null || node === undefined) continue
        // Leave the header breadcrumb nav alone even if a host nests one here.
        const label = typeof node.getAttribute === "function" ? (node.getAttribute("aria-label") ?? "") : ""
        if (/hierarchy|breadcrumb/i.test(label)) continue
        if (node.style === undefined || node.style === null) continue
        if (visible === true) {
          node.style.display = "block"
          node.style.zIndex = "21"
          // The host can hide the whole conversation subtree with
          // visibility:hidden, and visibility inherits: a nav carrying
          // display:block and full size is still invisible when an ancestor
          // says hidden. That is exactly what the desktop app showed — the rail
          // measured 28x192 with 19 marks and correct ::before colours, yet
          // elementFromPoint fell through to the scroll body. Declaring
          // visibility here re-shows the rail without touching the ancestor,
          // which may be hiding other things on purpose.
          node.style.visibility = "visible"
          // The rail also has to take the mouse back. Its parent slot is
          // pointer-events:none on purpose — the slot spans the whole scroll
          // area and must not swallow clicks meant for the conversation — and
          // the rail only becomes clickable because the host's own stylesheet
          // sets pointer-events:auto on it. On the desktop build that computed
          // to none anyway: the rail measured 28x222, hover previews only
          // appeared for synthesized events, and elementFromPoint fell through
          // to the scroll body, so the rail could not be hovered or clicked
          // with a real mouse. Declaring it here restores the behaviour the
          // host intended without making the slot opaque to the pointer.
          node.style.pointerEvents = "auto"
          touched++
        } else {
          // `delete node.style.display` is a no-op in a real browser: the style
          // declaration object is a proxy over the CSSOM, and `delete` removes a
          // JS property that was never an own property. It returns true and
          // leaves `display:block` in the inline style -- measured on the real
          // page, where a nav closed with the column kept its forced display and
          // the theme's stand-in rail came back beside it, giving two rails.
          // `removeProperty` is the call that actually clears the declaration.
          if (node.style.display === "block") node.style.removeProperty("display")
          if (node.style.zIndex === "21") node.style.removeProperty("z-index")
          if (node.style.visibility === "visible") node.style.removeProperty("visibility")
          if (node.style.pointerEvents === "auto") node.style.removeProperty("pointer-events")
        }
      }
      return touched
    }

    // <gutter>
    // Generated from lib/gutter.js by scripts/sync-gutter.mjs. Do not edit here:
    // edit the module, re-run the sync, and the drift test will confirm the two
    // agree. The bundle cannot import because it is a browser script.
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


    /**
     * The narrowest monitor column that still reads.
     *
     * Below this the cards' own padding and a file path's two halves stop fitting on
     * one line each, and a column that wraps every row is worse than no column: it
     * costs the prose width and gives back noise. Higher than `MIN_CARD_WIDTH`
     * because this column also carries its own header row.
     */
    const MONITOR_MIN_WIDTH = 220

    /**
     * The widest monitor column before it stops reading as an annotation.
     *
     * Past this the column competes with the prose for attention, which is the thing
     * the gutter layout was already careful about. 460 is the widest the prototype
     * was measured at.
     */
    const MONITOR_MAX_WIDTH = 460

    /**
     * The prose width the column refuses to go below.
     *
     * The host's own clamp bottoms out at 680px (`--dsh-chat-content-width:
     * clamp(680px, ...)`), and 560 is deliberately under that: on a window narrow
     * enough to matter, taking the column down to its minimum and keeping 560 of
     * prose is a better trade than dropping the column, because dropping it is what
     * left the panel invisible on the windows where it was wanted.
     */
    const MONITOR_MIN_PROSE = 560

    /**
     * The width the host's own turn rail takes at the right edge of the scroll area.
     *
     * The rail's frame is 28px wide and sits 12px in from that edge, so its left
     * edge is 40px from it. The prose is centred in the scroll area, so each side
     * gets half of what the prose does not use and the rail sits on the right one —
     * which is why the column's budget below subtracts twice this number.
     *
     * This is a budget, not a measurement. The rail's visibility is not decided from
     * it: see the note on `placeMonitor`.
     */
    const TURN_RAIL_WIDTH = 40

    /**
     * Work out the monitor column's box, and how much the prose must give up.
     *
     * The column is pinned to the conversation column's right edge and the prose is
     * asked to narrow by exactly the column's width, so the two never compete.
     *
     * The prose is measured by its *centred box*, so the caller implements the
     * reservation as `margin-right` on the scrolling container rather than as
     * padding: padding on a centred box only moves it left by half the amount, which
     * made an earlier version subtract the width twice and look correct in one
     * screenshot while being wrong at every other width. `reserve` below is the
     * number that goes into that margin, and it is the column width — not double.
     *
     * Three budgets decide the width, and the column takes the smallest:
     *
     * 1. What the person asked for, clamped to `[MONITOR_MIN_WIDTH, MONITOR_MAX_WIDTH]`.
     * 2. `MONITOR_MIN_PROSE` — the prose keeps a floor.
     * 3. The turn rail. The host's rail sits at the scroll area's right edge, which
     *    is exactly where this column starts, so a column that eats the whole area
     *    leaves the rail nowhere regardless of what the host's own query says. Where
     *    the two disagree, the rail wins the argument down to `MONITOR_MIN_WIDTH`:
     *    a slightly narrower column is worth having and a missing rail is not.
     *
     *    This is a *budget*, not a verdict: it decides how wide the column may be,
     *    never whether the rail is shown. The rail's visibility is decided in the
     *    bundle, which forces it on whenever this column is; asking here whether it
     *    "fits" and then hiding it on a no was the bug that kept it invisible.
     *
     * The column is *not* dropped when the budgets run out. It used to be, and that
     * was wrong twice over: it made the panel disappear on the windows where a
     * narrow column would still have been readable, and it handed the user a second
     * layout to be confused by — the one this column replaced. Below
     * `MONITOR_MIN_WIDTH` of available area there is genuinely nothing to draw, and
     * that is the only case that reports `visible: false`.
     *
     * @param {object} input - the measurement.
     * @param {{ left: number, top: number, right: number, bottom: number }} input.columnRect - the conversation column.
     * @param {number} [input.width] - the width the person last chose.
     * @param {number} [input.proseWidth] - the prose's measured width, if known.
     * @param {number} [input.scrollbarWidth] - the scroll area's scrollbar, if any.
     * @returns {{ visible: boolean, left: number, top: number, width: number, height: number, reserve: number, reason?: string }}
     *   the column's box relative to its own origin, and the width the prose must give up.
     */
    function placeMonitor(input) {
      const column = input?.columnRect
      const idle = { visible: false, left: 0, top: 0, width: 0, height: 0, reserve: 0 }

      // A column missing an edge is a failed measurement, not a box at zero — the
      // same rule the placement functions above follow, for the same reason.
      if (!usableRect(column, ALL_EDGES)) return { ...idle, reason: 'no-conversation' }

      const { column: snapped } = snap(column, column)
      const full = Math.max(0, snapped.right - snapped.left)
      const height = Math.max(0, snapped.bottom - snapped.top)
      if (full <= 0 || height <= 0) return { ...idle, reason: 'no-conversation' }
      // The one case with no answer: an area narrower than the narrowest column.
      if (full < MONITOR_MIN_WIDTH) return { ...idle, reason: 'too-narrow' }

      // What the person asked for. `wanted` cannot be trusted to be a width: a NaN
      // passes every comparison untouched and reaches the DOM as `width:NaNpx`, which
      // the browser discards, leaving a column that collapsed to its content.
      const asked = Number(input?.width)
      const wanted = Number.isFinite(asked) && asked > 0 ? asked : MONITOR_MAX_WIDTH

      // The prose's own width when it was measurable, and the floor when it was not.
      // The larger of the two is the one the column has to respect.
      const measured = Number(input?.proseWidth)
      const prose = Math.max(MONITOR_MIN_PROSE, Number.isFinite(measured) && measured > 0 ? measured : 0)
      const scrollbar = Number(input?.scrollbarWidth)
      const bar = Number.isFinite(scrollbar) && scrollbar > 0 ? scrollbar : 0

      // Budget 2 and budget 3, both as the widest column that leaves what they need.
      const forProse = full - prose
      const forRail = full - bar - prose - TURN_RAIL_WIDTH * 2

      let width = Math.floor(Math.min(MONITOR_MAX_WIDTH, wanted, forProse))
      // Give the rail its room back. Only downwards: a column narrower than the rail
      // needs does not make the rail need more.
      if (Number.isFinite(forRail) && width > forRail) width = Math.floor(forRail)
      // The floor wins over both budgets. A column at its minimum that pushes the
      // prose under its own floor is the lesser evil: the prose re-wraps, the panel
      // would otherwise vanish. At that size the rail may well sit on the gutter's
      // last few pixels, which is the trade the caller makes deliberately — see the
      // turn-rail rule in the bundle.
      if (width < MONITOR_MIN_WIDTH) width = MONITOR_MIN_WIDTH

      return {
        visible: true,
        left: snapped.right - width,
        top: snapped.top,
        width,
        height,
        // Not `width * 2`. See the doc comment: the prose is centred, so one
        // margin of exactly this much is what actually narrows it by this much.
        reserve: width,
      }
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

      // The scrolling area, which is the box the prose is centred in and the box
      // the host's turn rail positions itself against. It is *not* the same as the
      // conversation column: the column carries a two-pixel scroll gutter and the
      // area carries the scrollbar, and both are width the rail cannot use. An
      // earlier version of the rail test read the column's border-box width, over-
      // reported the gutter by half a scrollbar, and called a 38px gutter "40" —
      // the rail it then drew sat on the last line of the reply.
      const scrollArea = document.querySelector("[data-conversation-scroll]")
      let scrollClientWidth = 0
      let scrollbarWidth = 0
      if (scrollArea !== null && scrollArea !== undefined) {
        const areaNode = scrollArea
        const areaWidth = Number(areaNode.getBoundingClientRect().width)
        const inner = Number(areaNode.clientWidth)
        if (Number.isFinite(inner) && inner > 0) {
          scrollClientWidth = inner
          // `clientWidth` excludes the scrollbar and the border, `getBounding-
          // ClientRect().width` includes both. The difference is exactly what the
          // rail loses, and it is zero on a host that is not rendering one.
          if (Number.isFinite(areaWidth) && areaWidth > inner) {
            scrollbarWidth = Math.max(0, Math.round(areaWidth - inner))
          }
        } else if (Number.isFinite(areaWidth) && areaWidth > 0) {
          scrollClientWidth = Math.round(areaWidth)
        }
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
        // The area's inner width, with the scrollbar already taken out. It feeds
        // the column's width budget, which spends part of it on the rail. Zero
        // when the host did not publish an area, which callers read as "cannot
        // tell".
        scrollWidth: scrollClientWidth,
        scrollbarWidth,
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

    /**
     * The previous turn, written into the column's header instead of a card.
     *
     * It is the same summary the 上一轮 card used to draw, minus the card: the
     * title and the three counts (calls, commands, files) are gone because they
     * answered "how much did that turn cost", and the header answers "what
     * happened". What is left is one quiet line saying how fresh the telling is,
     * then the telling itself.
     *
     * The fade and the click are the same contract the card had, so the reader
     * does not have to learn a second one: nothing hidden means nothing to
     * click, and the block only takes a tab stop when there is something to
     * reveal.
     *
     * @param {object} props - injected props.
     * @returns {object} the element.
     */
    function Recap(props) {
      const ago = typeof props.ago === "string" ? props.ago : ""
      const detail = typeof props.detail === "string" ? props.detail : ""
      const expanded = props.expanded === true
      const interactive = typeof props.onClick === "function" && props.clickable === true
      return jsxs('div', {
        className: 'dsse-recap',
        'data-clickable': interactive === true ? 'true' : 'false',
        'data-expanded': expanded === true ? 'true' : 'false',
        // What the badge says, and whether it is drawn at all. The card this
        // replaces carried the same two facts; only the box around them moved.
        'data-hint': props.hint === undefined ? 'false' : 'true',
        onMouseEnter: typeof props.onMouseEnter === 'function' ? props.onMouseEnter : undefined,
        onMouseLeave: typeof props.onMouseLeave === 'function' ? props.onMouseLeave : undefined,
        onClick: interactive === true ? props.onClick : undefined,
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
        'aria-expanded': interactive === true ? expanded : undefined,
        'aria-label': interactive === true ? props.hint : undefined,
        children: [
          // Only dated when there is something dated. A failed summary has no
          // time, and inventing one would invite the reader to wait for a retry
          // that is never scheduled.
          ago === ''
            ? null
            : jsxs('p', {
                className: 'dsse-recap-when',
                children: [
                  jsx('span', { className: 'dsse-recap-dot', 'aria-hidden': 'true' }),
                  jsx('span', { title: props.stamp, children: `更新于 ${ago}` }),
                ],
              }),
          jsx(Clip, {
            text: props.text,
            title: detail === '' ? undefined : detail,
            expanded,
            onClipped: props.onClipped,
          }),
          // The same badge the card carried, in the same place. A summary that
          // fits draws none: an offer to reveal nothing is a lie the pointer pays
          // for. It is decoration -- the whole block takes the click -- so there is
          // no tab stop here and no `title`; `aria-label` carries the words.
          props.hint === undefined
            ? null
            : jsx('div', {
                className: 'dsse-expand',
                role: 'img',
                'aria-label': props.hint,
                children: jsx(Icon, { name: 'chevron', up: expanded }),
              }),
        ],
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
      // Two offset rectangles, the back one clipped at the top-left so the pair
      // reads as a copy rather than as a grid or a window. Drawn at the same
      // stroke weight as the rest of the set so a 14px button does not look
      // heavier than the 17px icons beside it.
      if (props.name === 'copy') return jsxs('svg', { className: 'dsse-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', children: [jsx('rect', { x: '9', y: '9', width: '11', height: '11', rx: '2.5' }), jsx('path', { d: 'M15 5.5A2.5 2.5 0 0012.5 3H6.5A2.5 2.5 0 004 5.5v6A2.5 2.5 0 006.5 14' })] })
      if (props.name === 'chevron') return jsx('svg', { className: 'dsse-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', children: jsx('path', { d: props.up === true ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6' }) })
      // A screen with a trace on it, not a star. The star was the panel's mark when
      // the panel held one card per skill; now it holds the turn, the files and the
      // queue, and the glyph has to say "something is being watched here" rather than
      // "skills". The trace is what makes the rectangle a monitor and not a window.
      if (props.name === 'monitor') return jsxs('svg', { className: 'dsse-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', children: [jsx('rect', { x: '2.5', y: '4', width: '19', height: '16', rx: '3.2' }), jsx('path', { d: 'M6.2 13h2.6l1.6-4 2.6 7.5 1.6-3.5h2.8' })] })
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
        // Where the badge goes, which is not the same convention in both states.
        // It has to be an attribute of its own rather than aria-expanded: the
        // files card hands its expansion to a real button, which means its own
        // `interactive` is false and aria-expanded is never written to the card.
        // Rules keyed off aria-expanded matched nothing on the one card that
        // needed them, and the badge stayed where the shared rule put it.
        'data-open': (props.badgeAction === undefined ? props.expanded : props.badgeAction.open) === true ? 'true' : 'false',
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
      // The rail never positions itself any more: the monitor column owns the
      // geometry and hands the rail a box to fill. It stays a separate element
      // because the scroll container inside it is what keeps the top row stuck to
      // the column's top edge, and that is a job the column's own box cannot do.
      const railBox = { 'data-embedded': 'true' }
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
      // `null` means the reader has not touched the badge, which is a different
      // fact from "they opened it" or "they closed it". The card needs that third
      // state to open itself when the alternative is showing no rows at all —
      // see `filesExpanded` below — without overriding a reader who then closes it.
      const [filesOpen, setFilesOpen] = React.useState(null)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [settingsEpoch, setSettingsEpoch] = React.useState(0)
      const panelRequest = React.useRef(0)
      const configRequest = React.useRef(0)
      // The ticket of the `/panel` request that is out right now, or null. A ref,
      // not state: it must be set the instant the request starts, not one render
      // later, or two refreshes in the same tick both read "idle" and both go out.
      //
      // Any request in flight blocks a new one, whatever session it belongs to.
      // A session switch is not rescued by this guard but by the reset effect
      // below, which clears the ref on every session change -- so the new
      // session's fetch goes out immediately instead of waiting for the
      // abandoned one. The ticket then keeps that abandoned request from
      // clearing the marker of whoever replaced it.
      const panelBusyRequest = React.useRef(null)
      // Set when a refresh arrives while one is already out. The answer in flight
      // was computed before this request existed, so waiting for it would leave the
      // panel one whole cycle behind. The interval tick does not care -- it is
      // asking the same question again -- but an approval that just returned and a
      // refresh the reader clicked do: for those the answer is from before the thing
      // they just did, so it has to be asked for again.
      const panelRefreshWanted = React.useRef(false)
      // The signature of the payload currently on screen, so an unchanged answer
      // can skip the render entirely. Null means "no comparable answer yet".
      const panelSignatureRef = React.useRef(null)

      // The host's attribute is the authority, and it is read here rather than
      // trusted from `bridge`. `bridge` only moves when an observer fires, and
      // the observer that watches for a swap can be parked above the node the
      // host actually replaces, so a switch can land with no notification at
      // all while this column keeps rendering. Reading on every render costs
      // one attribute query and cannot disagree with `load`, which reads the
      // same thing before every request.
      const liveId = liveSessionId()
      // `""` means the host is between conversations -- it removed the node and
      // has not mounted the next one yet. Falling back to `bridge` keeps this
      // render a no-op instead of a flicker to a third state, and the render
      // that follows the mount reads the new id for itself.
      const sessionId = liveId === "" ? bridge.sessionId : liveId
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
       * @param {boolean} [mustAsk] - re-ask if a request is already out. For a call
       *   made in response to something the reader just did, the answer in flight
       *   predates it, so dropping the call shows the state before their action.
       *   A periodic tick can be dropped: it asks the same question again.
       */
      const load = React.useCallback(
        async (quiet, mustAsk) => {
          // One request at a time. Two things can ask at once now: the minute
          // clock, which is predictable, and an `EventSource` frame, which is
          // not -- it arrives whenever something happened, including while an
          // answer is still out. Each request holds the server's mutation lock
          // for part of its life, so overlapping reads do not run in parallel,
          // they queue.
          //
          // The marker holds the ticket of the request that owns it, not the
          // session name. A name cannot tell two requests for the same session
          // apart: leave A for B and come back, and the abandoned A request's
          // finally sees its own name again and unlocks the new A request while
          // that one is still out -- exactly the stacking this guard prevents.
          // The ticket is unique per request, so it can only ever unlock itself.
          if (panelBusyRequest.current !== null) {
            // A clock tick can be dropped outright: it asks the same question
            // the request already out is asking, and the next tick is a minute
            // away. A call made in response to something the reader did cannot --
            // it follows an approval that has already returned, a saved setting or a
            // click on the button, and the answer in flight predates all of them.
            // Marking it wanted re-asks the moment the request out finishes.
            // That is also why a frame sets it: dropping a tick costs a minute,
            // dropping a frame loses the last change until something else
            // happens to announce itself, which may be never.
            //
            // The distinction is `mustAsk`, not `quiet`: quiet only decides whether
            // to show the loading state, and the approval callback is quiet because
            // the panel is already on screen -- which is exactly the call that must
            // not be dropped.
            if (mustAsk === true) panelRefreshWanted.current = true
            return
          }
          const request = ++panelRequest.current
          // Read the session now, not from the render that built this closure.
          // `sessionId` below is the value captured when this callback was
          // created; a switch that re-rendered the header but not this column
          // would leave it asking about the session the reader already left.
          // The host's own attribute is the authority; `bridge.sessionId` is
          // the fallback for a page that does not publish one.
          const target = liveSessionId() || bridge.sessionId
          if (target === "") {
            setState({ status: "no-session" })
            return
          }
          // A refresh keeps whatever is already on screen. The loading state is for
          // a session whose answer has never arrived; dropping the payload on a
          // manual refresh emptied the whole rail for the length of the request, and
          // the open settings dialog went with it.
          if (quiet !== true) setState((prior) => (prior.status === "ready" ? prior : { ...prior, status: "loading" }))
          try {
            // Claimed inside the try, not before it: the marker is what silences
            // every later poll, so anything that threw while it was set and before
            // the finally would freeze the column for good. The finally is the only
            // place the guard needs to hold, so the assignment lives inside the
            // same block the finally covers.
            panelBusyRequest.current = request
            // The timeout is not belt-and-braces: `fetch` has no default one, so
            // without this a request against a socket that never speaks keeps the
            // busy marker held and the column frozen. `AbortController` also makes
            // the abandonment observable — the `catch` below turns it into the same
            // visible error any other failure produces.
            const flight = new AbortController()
            const deadline = setTimeout(() => flight.abort(), PANEL_TIMEOUT_MS)
            let data
            try {
              data = await call(`/panel?agent=${encodeURIComponent(target)}`, { signal: flight.signal })
            } finally {
              clearTimeout(deadline)
            }
            // Two independent reasons to drop an answer. The first is that a
            // newer request has been issued. The second is that the reader has
            // moved to another conversation while this one was out — and that
            // is checked against the page, not against the variable this
            // closure captured, because the whole point is that the captured
            // value can be stale.
            if (request !== panelRequest.current) return
            if ((liveSessionId() || bridge.sessionId) !== target) return
            // A sanity assert, not the cross-session guard — that is the check
            // above. This server echoes the query string back as `agent`
            // (`api.js` reads `searchParams.get('agent')` and returns it as
            // `id`), so today the two always agree and this never fires. It is
            // kept for a server that normalises ids: silently painting such an
            // answer would be worse than dropping it.
            if (typeof data?.agent === "string" && data.agent !== "" && data.agent !== target) return
            // An unchanged answer keeps the object it already had. React compares
            // state by identity, so a fresh object with identical contents
            // re-renders the whole column: one hundred and fifty `jsx` calls to
            // produce exactly the same output. Under the eight-second clock an
            // unchanged answer was the common case, because the clock asked
            // whether or not anything had happened. A read now follows a bump,
            // so the answer has usually moved -- and the case this saves is the
            // one that remains: coalesced frames, floor ticks, and coming back
            // to a page that was hidden.
            //
            // The signature is the payload serialised. It costs a stringify of the
            // answer (the large field is the file list, bounded by MAX_PATHS) and
            // saves a full render of it, which is the cheaper side of that trade by
            // a wide margin.
            const signature = panelSignature(data)
            if (signature !== null && signature === panelSignatureRef.current) {
              // Nothing on screen changes, but a failed state has to clear: an
              // error that has since healed must not stay pinned above a fresh
              // answer. Setting the same empty string is a no-op for React, so
              // this costs nothing on the ordinary path.
              setError("")
              return
            }
            panelSignatureRef.current = signature
            setState({ status: "ready", data })
            setError("")
          } catch (failure) {
            // Same two checks as the success path, for the same reason: this
            // closure's `sessionId` may name a conversation the reader left.
            // Reporting its failure would put an error banner over a session
            // that is working.
            if (request !== panelRequest.current) return
            if ((liveSessionId() || bridge.sessionId) !== target) return
            // A failed poll invalidates the signature: the next success must be
            // rendered even if it happens to match the last good payload, because
            // the error banner in between is what changed.
            panelSignatureRef.current = null
            setState((prior) => ({ status: "ready", data: prior.data }))
            setError(String(failure?.message ?? failure))
          } finally {
            // Only clear the marker this call set. A response for a session that
            // has since been left must not unlock the session now on screen while
            // its own request is still out. Comparing the ticket rather than the
            // session name is what makes that true even for two requests on the
            // same session.
            if (panelBusyRequest.current === request) panelBusyRequest.current = null
            // A refresh that arrived while this one was out now gets the answer it
            // was asking for. Dropped instead, an approval would leave the panel
            // showing the queue from before it and a click would do nothing at all
            // until the next tick. The marker is already clear, so this call is the
            // one that owns the next ticket.
            if (panelRefreshWanted.current) {
              panelRefreshWanted.current = false
              load(false)
            }
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
        // The payload signature belongs to one session as much as the turn tags
        // do. Two sessions whose cards happen to render identically are entirely
        // ordinary -- a fresh conversation and an idle one look the same -- so
        // keeping the signature across a switch would let the new session's first
        // answer be judged "unchanged" and skipped, leaving the column on the
        // loading state it just entered.
        panelSignatureRef.current = null
        // Clearing the marker here is what lets a session switch proceed while a
        // request for the previous session is still out -- see the guard above.
        panelBusyRequest.current = null
        // A refresh wanted for the session being left must not fire against the
        // one being entered.
        panelRefreshWanted.current = false
      }, [sessionId])

      React.useEffect(() => {
        load(false)
        // One push stream, one slow clock, and neither runs while the page is
        // hidden.
        //
        // The stream is the fast path. The host knows when a turn ends, a skill is
        // used or an MCP server is called, and this plugin owns the only place
        // that knows the panel's payload changes at those moments (`Revisions`,
        // bumped at the six session-event sites on the plugin side, plus one for an
        // approval and one for a summary landing). So the page opens one
        // `EventSource` and the
        // server writes a frame when it has something to say. That is what the
        // host's own `/plugins/events` channel does, and matching its shape means
        // one long-lived-connection protocol in the page rather than two.
        //
        // This replaced a twenty-five-second parked request, which replaced an
        // eight-second timer. Both were polls: they had to be re-asked after every
        // answer, and the timer spent four hundred and fifty round trips an hour
        // to hear "still the same". A stream is opened once.
        //
        // `EventSource` reconnects on its own, so there is no retry logic here --
        // except that its first attempt is what discovers a host too old to serve
        // the route, and a failed `EventSource` retries on the browser's own
        // schedule. That is why the fallback below is not "retry the stream
        // often": it is the ordinary slow clock, which was always there for the
        // three things no event announces (the global candidate queue, file
        // sizes read with `stat`, and the skill directory).
        //
        // The interval is that slow clock: sixty seconds. See `REFRESH_MS`.
        //
        // Neither runs while the page is hidden. A backgrounded window is not
        // reading the column, and the honest cost of an answer is a full queue
        // read -- paying that for a tab nobody is looking at is the kind of quiet
        // expense that shows up as battery drain and as a host that never idles.
        // Coming back asks once, immediately, because the numbers on screen are
        // from before the tab went away.
        let stream = null
        // Which session the open stream is bound to. `stream` alone cannot say:
        // a stream bound to the session the reader left stays open, healthy and
        // silent, so `stream === null` never becomes true and the line that
        // reopens it never runs. Remembering the name is what lets the slow
        // clock and the visibility handler notice that the *binding*, not the
        // connection, is the thing that went stale.
        let streamFor = ""

        // The session on screen right now, by the same rule `load` uses.
        const watchTarget = () => liveSessionId() || bridge.sessionId

        const stopStream = () => {
          if (stream === null) return
          stream.close()
          stream = null
          streamFor = ""
        }

        const startStream = () => {
          if (typeof document !== 'undefined' && document.hidden === true) return
          // No `EventSource` in this environment (a headless renderer, an older
          // browser, a test harness): the slow clock still keeps the column
          // working, and starting a stream is not worth a polyfill.
          if (typeof EventSource !== 'function') return
          // No empty-id guard here: this effect lives in the card column, which
          // the overlay does not render at all until it has a session id, so a
          // blank target cannot reach this line. A guard that cannot fire is one
          // more branch to keep honest, and this one survived a mutation run
          // with the check deleted -- unreachable code looks identical to
          // untested code from the outside.
          const target = watchTarget()
          stopStream()
          // Through `resolveUrl` like every other request: the GUI can be
          // mounted under a path prefix, and a root-relative URL would miss the
          // route entirely. That failure is invisible -- a 404 makes
          // `EventSource` give up for good, so the panel would quietly fall back
          // to the minute clock while looking perfectly healthy.
          const opened = new EventSource(resolveUrl(`/api/ui-evolve/events?agent=${encodeURIComponent(target)}`))
          stream = opened
          streamFor = target
          // A notice means the payload could have changed, so fetch it. Not
          // droppable: this is the whole point of the stream.
          opened.addEventListener('message', () => {
            load(true, true)
          })
          // `error` covers two different outcomes, and they need opposite
          // handling. A dropped connection leaves `readyState` CONNECTING and
          // the browser retries by itself -- closing here would put a stop to
          // the only fast path there is. A fatal failure (a 404 from a host that
          // does not serve this route, a response that is not
          // `text/event-stream`) leaves it CLOSED and the browser never comes
          // back. That distinction is `readyState`, and getting it wrong is what
          // D-73 recorded the first time this route lost its stream: the panel
          // stayed on stale data until the reader switched conversations.
          opened.addEventListener('error', () => {
            if (opened.readyState !== 2) return
            // Only ever close the stream this handler was registered for. A
            // handler fires on its own source, but by the time it runs this may
            // no longer be the open one: a rebind closes `opened` and opens a
            // replacement, and a handler that then called `stopStream()` would
            // close the healthy new stream and drop the panel back to the slow
            // clock -- the same symptom this whole change exists to remove.
            if (stream !== opened) return
            // Given up for good, so give the slot back and let the slow clock
            // retry it rather than spinning here: the route may come back when
            // the plugin reloads, and a reconnect storm costs more than the
            // minute it was meant to replace.
            stopStream()
          })
        }

        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden === true) return
          load(true)
          // A stream that gave up is retried here rather than left dead. Without
          // this, a fatal failure -- a host that had not loaded the plugin yet,
          // a reload in progress -- cost the fast path for the rest of the
          // session, which is exactly the outcome `error` was written to avoid.
          if (stream === null || streamFor !== watchTarget()) startStream()
        }, REFRESH_MS)

        const onVisible = () => {
          if (typeof document !== 'undefined' && document.hidden === true) {
            // Going away: close the stream rather than leave a server slot
            // writing frames to a page nobody is looking at. Coming back reopens
            // it, and the first read on the way back catches up.
            stopStream()
            return
          }
          // Coming back is a reader action, and the numbers on screen are from
          // before the tab went away. Not droppable.
          load(true, true)
          // Two reasons to reopen, and both are checked before anything is
          // torn down. `stream === null`: it was closed on the way out, or never
          // opened, and the fast path would otherwise stay dead for the rest of
          // the session. `streamFor !== watchTarget()`: it is open and healthy
          // but bound to a conversation the reader has left -- the case a page
          // that never went away still hits, because `visibilitychange` also
          // fires for a window that is merely uncovered. A healthy stream bound
          // to the right session is left alone either way: tearing it down would
          // cost the frame it was about to deliver.
          if (stream === null || streamFor !== watchTarget()) startStream()
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisible)
        }

        startStream()

        return () => {
          clearInterval(timer)
          stopStream()
          // A switch between conversations already clears this; unmounting did
          // not. Without it, a frame that arrives while a request is out leaves
          // the flag set, and that request's `finally` then asks once more for a
          // column that is no longer on screen -- one wasted queue read and a
          // `setState` on an unmounted component.
          panelRefreshWanted.current = false
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisible)
          }
        }
        // `load` already depends on `sessionId`, so it is a new function on
        // every switch and this effect would rerun for that reason alone. The
        // name is kept because the effect reads `sessionId` directly as well,
        // and a list that omits something the body reads is a bug waiting for
        // the next person to trust it.
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
          // A setting just changed, so the answer in flight describes the panel as
          // it was configured before -- not droppable.
          load(true, true)
        } catch (failure) {
          if (request !== configRequest.current) return
          setConfig(prior)
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
      // Stale is a third question about the same rows: people wrote it, but not
      // any time recently. Measured on a real session, 197 of 200 remembered paths
      // were review copies and test scratch — the sort of thing that is real work
      // on the day and noise a week later.
      //
      // It is not deleted, and not merged into `generated`: a copy of a file that
      // a reviewer once asked about is still a copy *of a file someone wrote*, and
      // calling it machine output would be a second wrong label on top of the
      // first. It gets its own group, one shade quieter, and the header says how
      // many there are.
      const stale = people.filter((file) => file.stale === true)
      const current = people.filter((file) => file.stale !== true)
      const fresh = current.filter((file) => file.turn === true)
      const earlier = current.filter((file) => file.turn !== true)
      // Folded, the four rows are the reader's own work, this turn's first. Open,
      // the whole session is there in four labelled groups, so nothing is
      // hidden without a way to see it.
      //
      // The folded list is `fresh.concat(earlier)` and not `current`, even though
      // they hold the same rows: `current` is in the order the session remembered
      // them, which is oldest first, so slicing it would show the oldest four and
      // push this turn's work below the fold — the one thing a folded card exists
      // to prevent.
      // A card whose only rows are demoted ones has nothing to put behind a
      // disclosure: folded, it draws the first four of `fresh.concat(earlier)`,
      // which is empty, so the reader gets a header naming a number and no rows
      // under it. That is the same failure as a filter nobody can reach, one
      // step worse — the rows exist and the card declines to show them.
      //
      // So when the main number has nothing left to count, the card opens. The
      // reader can still fold it back; `filesOpen` remembers that and wins.
      const nothingStillStands = current.length === 0 && ordered.length > 0
      const filesExpanded = filesOpen === null ? nothingStillStands : filesOpen === true
      const groups = filesExpanded === true
        ? [
            { key: 'fresh', label: '', files: fresh },
            { key: 'earlier', label: earlier.length > 0 && fresh.length > 0 ? '更早' : '', files: earlier },
            { key: 'stale', label: stale.length > 0 ? '较早' : '', files: stale },
            { key: 'noise', label: noisy.length > 0 ? '生成文件' : '', files: noisy },
          ]
        : [{ key: 'folded', label: '', files: fresh.concat(earlier).slice(0, FOLDED_FILES) }]
      // What the header promises, and it promises one thing: how much of this list
      // still describes the session as it stands. It used to count everything,
      // which was truthful about the collector and a lie to the reader — one real
      // session showed `200 个文件` above four rows, and 197 of those rows were a
      // reviewer's copy of the repository.
      //
      // The main number leaves demoted rows out too (see `stale` below), which is
      // the same claim one step further: a path nobody has touched in a week is
      // part of the history, not of the current work.
      //
      // The other two numbers are still said, in the same breath and in a quieter
      // voice, because leaving them out would make the badge's remainder
      // unexplainable: a reader who adds up what the header says must arrive at
      // the same total the badge counts down from.
      const staleCount = stale.length
      const noiseCount = noisy.length
      const keptNotes = []
      // With nothing to put in the main number, the grey line has to carry the whole
      // header: `另有 200 个生成文件` says "besides" to a number that is not there.
      // A real session reached exactly this state — a reviewer's copy of the
      // repository left two hundred rows and not one of them a person's.
      //
      // Saying it about the whole list is not the same as leading with a count. One
      // real turn put every row in that group — fourteen files under `_prototype/`,
      // a preview someone had asked to see — so the header was a bare `N 个生成文件`
      // and the reader reported "产出文件是空的". The count was right and the sentence
      // was wrong. The rule that produced it is fixed elsewhere, but this line still
      // has to survive the next rule that is wrong, so it says what the list *is*
      // rather than repeating a number twice.
      if (nothingStillStands === true) {
        if (noiseCount > 0 && staleCount > 0) keptNotes.push(`全部 ${ordered.length} 个文件里，${noiseCount} 个生成文件 · ${staleCount} 个较早`)
        else if (noiseCount > 0) keptNotes.push(`全部 ${ordered.length} 个文件都是生成文件`)
        else if (staleCount > 0) keptNotes.push(`全部 ${ordered.length} 个文件都较早`)
      } else {
        if (noiseCount > 0) keptNotes.push(`另有 ${noiseCount} 个生成文件`)
        if (staleCount > 0) keptNotes.push(`${staleCount} 个较早`)
      }
      // How many rows the folded card actually draws. Equality with
      // `FOLDED_FILES` is not assumed: a session with two written files shows two.
      const foldedRows = fresh.concat(earlier).slice(0, FOLDED_FILES).length
      // Still counted against the whole list, not against the header's number.
      // The badge answers "how much of this list am I not seeing", and the list
      // is every row the card holds — saying `200 - 4 = 196` while the header
      // says 3 is only confusing if the two are read as the same quantity, so
      // the header states the remainder explicitly rather than leaving it to be
      // subtracted.
      const hiddenFiles = ordered.length - (filesExpanded === true ? ordered.length : foldedRows)
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

      // Whether this Host can put text on the clipboard at all. Answered here, in
      // the closure that owns the channel, for the same reason `canPreview` is: a
      // row that tested for it itself would need to reach outside its props, so
      // every row would repeat the same lookup and they could disagree.
      //
      // This is evaluated on each render, not once per mount — it is a plain
      // expression, not a hook. That is deliberate and costs nothing: the answer
      // cannot change without a new document, and there is no state derived from it
      // that would need to be kept in step.
      //
      // Not absent in practice: `navigator.clipboard` needs a secure context, and
      // browsers treat a loopback address as a trustworthy origin even over plain
      // http — measured on this listener, `window.isSecureContext` is true and
      // `writeText` exists. So this guard is a fallback, not the normal path: it
      // covers a Host reached through something that is not a secure context (a
      // relay, a LAN address). When it is missing the buttons are not drawn — a
      // control that cannot do its job is worse than no control, because it takes
      // the click and says nothing.
      const clipboard = (() => {
        try {
          const nav = window.navigator
          if (nav === undefined || nav === null) return undefined
          return typeof nav.clipboard?.writeText === 'function' ? nav.clipboard : undefined
        } catch {
          return undefined
        }
      })()
      // Which row just answered, and whether the answer was yes. It keys a flash
      // that lasts 1.5 seconds: there is no toast in this panel, and the button
      // under the pointer is the only surface a confirmation can appear on without
      // pushing the list around.
      const [copied, setCopied] = React.useState(undefined)
      const copyTimer = React.useRef(null)
      // `writeText` is asynchronous on every browser that has it, but a stub is
      // allowed to return nothing at all, and the two have to mean the same thing
      // here: the click was accepted. Treating a missing promise as a failure would
      // make a working clipboard look broken in exactly the fixtures that fake it.
      const copyPath = (key, text) => {
        if (clipboard === undefined) return
        const settle = (ok) => {
          setCopied({ key, ok })
          if (copyTimer.current !== null) clearTimeout(copyTimer.current)
          copyTimer.current = setTimeout(() => {
            copyTimer.current = null
            setCopied(undefined)
          }, 1500)
        }
        let answer
        try {
          answer = clipboard.writeText(text)
        } catch {
          settle(false)
          return
        }
        if (answer !== undefined && answer !== null && typeof answer.then === 'function') {
          answer.then(() => settle(true), () => settle(false))
          return
        }
        settle(true)
      }
      // The flash outlives no component. `copyTimer` is a ref, so it is not part of
      // any render and nothing else would notice it: without this the callback runs
      // against a `setCopied` whose component is gone, which in this hand-rolled
      // renderer means writing into a slot nobody reads — and a real timer left on
      // the host for 1.5 seconds after the panel closed.
      React.useEffect(() => () => {
        if (copyTimer.current !== null) {
          clearTimeout(copyTimer.current)
          copyTimer.current = null
        }
      }, [])
      // Which row has its menu open, as a row key. One at a time: two menus open
      // at once would mean two overlapping lists of paths in a column that is
      // already narrow, and the reader has to look at each one to tell them apart.
      const [menuFor, setMenuFor] = React.useState(undefined)
      const menuRef = React.useRef(null)
      // The list scrolls: eight rows fit, the rest are behind a scrollbar, and a
      // menu opened on the last visible row starts below the fold — the button
      // changes state and nothing appears. Bringing it into view is the only part
      // of this that has to ask the browser anything, so it is also the only part
      // that can be absent (a test double has no layout); `nearest` keeps the list
      // from jumping when the menu already fits.
      React.useEffect(() => {
        if (menuFor === undefined) return
        const node = menuRef.current
        if (node === null || typeof node.scrollIntoView !== 'function') return
        node.scrollIntoView({ block: 'nearest' })
      }, [menuFor])
      // The control of the row whose menu is open, so choosing an entry can put
      // focus back where the reader was. Without it the chosen entry is removed
      // from under the cursor, focus falls to the document body, and the answer
      // written into `aria-label` is announced to nobody.
      const copyRef = React.useRef(null)
      // Closing on Escape and on a click outside is the difference between a menu
      // and a mode the reader cannot leave without choosing something. Both are
      // listened for on `window`: the panel is a root-scope overlay, so there is no
      // ancestor to delegate to, and `mousedown` (not `click`) is what matches the
      // moment a pointer press lands elsewhere — waiting for the release would let
      // a drag that starts outside still count as being inside.
      //
      // The listener only exists while a menu is open. A permanently mounted one
      // would be a global handler on every Host surface for a control that is
      // usually closed.
      React.useEffect(() => {
        if (menuFor === undefined) return undefined
        const onDown = (event) => {
          const target = event?.target
          const node = menuRef.current
          const inside = node !== null && typeof node.contains === 'function' && node.contains(event?.target) === true
          // The button itself is outside the menu on purpose: pressing it again
          // has to be able to close what it opened, and treating that press as
          // "outside" would close and immediately reopen on the same gesture.
          // Which element the press lands on is not the control. The control is a
          // 22px box whose visible 14px is an <svg>, so the hit node is a <path>
          // inside it and carries no marker of its own. Reading the marker off the
          // hit node made a press on the icon look like a press in the list: the
          // menu closed on mousedown and the click behind it reopened it, so the
          // control could not close what it opened. Measured in Chrome, not
          // reasoned about. `closest` walks up the way the DOM does; the `dataset`
          // branch stays for a hit node that is itself the control, which is the
          // only shape a test double can express.
          const onButton = target != null && (
            typeof target.closest === 'function'
              ? target.closest('[data-dsse-copy="true"]') !== null
              : target?.dataset?.dsseCopy === 'true'
          )
          if (inside === false && onButton === false) setMenuFor(undefined)
        }
        const onKey = (event) => {
          if (event?.key === 'Escape') setMenuFor(undefined)
        }
        window.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('mousedown', onDown)
          window.removeEventListener('keydown', onKey)
        }
      }, [menuFor])

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
              ...railBox,
              children: [
                jsx('p', { className: 'dsse-loading', role: 'status', children: '正在加载…' }),
                settings,
              ],
            })
      }

      return jsxs('div', {
        className: 'dsse-rail',
        'data-dsse-rail': '1',
        ...railBox,
        children: [
          // The header and the list share one scroll container, and the header
          // is that container's first child, stuck to the top. One scroller
          // instead of two keeps a single scrollbar and lets the header's own
          // surface cover the cards sliding beneath it; putting the list in a
          // scroller of its own would draw a clip edge right under the header
          // and read as a seam.
          jsx('div', {
            className: 'dsse-col-top',
            children: jsxs('div', {
              className: 'dsse-col-card',
              children: [
          jsxs('div', {
            className: 'dsse-top-row',
            children: [
              // Reading order runs from what you look at to what you press: the
              // queue is the thing the panel exists to report, so it goes first
              // and takes the left edge where the eye lands. The three controls
              // sit together on the right (speed, refresh, settings) because they
              // are all "how am I doing" / "act on the panel", and separating them
              // by the counter would put a number between two buttons a person
              // aims at.
              jsx(Checklist, {
                sessionId,
                // Quiet (no loading state, the panel is on screen) but not
                // droppable: the approval has already returned, so an answer in
                // flight predates it.
                onDecided: () => load(true, true),
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
              // The stretch between the queue and the controls is the only place
              // a width-varying number can appear without moving anything a person
              // aims at.
              jsx(SpeedBadge, { sessionId }),
              jsx('button', {
                className: 'dsse-icon-btn dsse-refresh',
                type: 'button',
                'aria-label': '刷新面板',
                title: '刷新面板',
                onClick: () => load(false, true),
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
            ],
          }),
              error === '' ? null : jsx('p', { className: 'dsse-err', role: 'alert', children: error }),
              // The previous turn, written into the header rather than drawn as a
              // card of its own. The card used to lead the list, which meant the
              // thing you read first scrolled away first. In the header it stays
              // put, and the list below it is only what changed since.
              showTurn === false
                ? null
                : jsx(Recap, {
                    ago: summaryAgo,
                    detail: summaryReason.detail,
                    expanded,
                    clickable: turnExpandable,
                    hint: turnHinted === true ? (expanded === true ? '点击收起全文' : '点击展开全文') : undefined,
                    // Only dated when dated. The stamp is the tooltip on the
                    // relative time, so it is meaningless without one.
                    stamp: summaryAgo === '' ? undefined : `摘要生成于 ${new Date(summary.at).toLocaleString()}`,
                    text: summaryText,
                    onMouseEnter: () => setHoverTurn(turnId),
                    onMouseLeave: () => setHoverTurn(""),
                    onClick: () => setPinnedTurn(turnPinned === true ? "" : turnId),
                    onClipped: (hidden) => {
                      setClippedTurn(hidden === true ? turnId : "")
                    },
                  }),
            ],
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
                // Two numbers and a quieter pair, in the header where they cannot be
                // scrolled out of view — that was the whole of DEF-51.
                //
                // The bold one answers "how much did a person write"; the grey ones
                // answer "and what else is in here". They add up: bold + grey = every
                // row the card holds, which is the same total the badge counts down
                // from. A reader who checks the arithmetic finds it closes.
                //
                // Zero is written as a sentence rather than as `0 个文件`. A card
                // whose only rows are generated files has no honest subject to count,
                // and "0 个文件 另有 3 个生成文件" reads like something failed. When
                // nothing was written and nothing was generated the card is not drawn
                // at all (see `showFiles`), so this branch only runs with a remainder.
                head: jsxs('div', {
                  className: 'dsse-head-stats',
                  children: [
                    current.length > 0
                      ? jsxs('span', { className: 'dsse-head-stat', children: [jsx('b', { children: String(current.length) }), jsx('span', { children: '个文件' })] })
                      : null,
                    keptNotes.length === 0
                      ? null
                      : jsx('span', { className: 'dsse-head-note', children: keptNotes.join(' · ') }),
                  ].filter(Boolean),
                }),
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
                badgeAction: hiddenFiles > 0 || filesExpanded
                  ? {
                      label: filesExpanded ? '收起文件' : `显示其余 ${hiddenFiles} 个`,
                      open: filesExpanded === true,
                      onClick: () => setFilesOpen(filesExpanded === false),
                    }
                  : undefined,
                children: [
                  jsx('div', {
                    className: 'dsse-list dsse-files',
                    'data-open': filesExpanded === true ? 'true' : 'false',
                    children: groups.map((group) => group.files.length === 0 ? null : jsxs('div', {
                      className: 'dsse-group',
                      'data-group': group.key,
                      children: [
                        group.label === '' ? null : jsx('p', { className: 'dsse-group-label', children: group.label }),
                        group.files.map((file) => {
                          const parts = fileParts(file.path, cwd)
                          // The row is a container, not a button. It holds two
                          // siblings that each do one thing: the big one opens the
                          // file, the small ones copy its path. Nesting a button
                          // inside a button is not valid HTML, and the alternative
                          // — one button with a click target inside it — makes the
                          // inner control unreachable by keyboard and swallows its
                          // clicks in some browsers.
                          //
                          // These children are built in `Cards` and passed down, so
                          // `props` in this closure is `Cards`' own — not `Card`'s.
                          // Reading the opener off props here is how the first draft
                          // made every row inert on every Host.
                          const status = typeof file.status === 'string' ? file.status : 'available'
                          // Only the states this build knows how to explain count as
                          // gone. A fifth name from a newer server would otherwise render
                          // a row with no reason, no size and no click — the worst of both
                          // outcomes — so it falls back to what every row meant before the
                          // states existed.
                          //
                          // `unresolved` belongs on this side of the line for the same
                          // reason `missing` does: there is nothing here to open. What it
                          // does not share is the conclusion — the file may be right
                          // where the turn left it, and only the record lost the base.
                          // `folder` belongs on this side of the line for the same
                          // reason the others do: there is nothing here to open. What it
                          // does not share is the verdict. The path was found, and what
                          // was found is a directory — not a file that went away.
                          const gone =
                            status === 'missing' || status === 'invalid' || status === 'unresolved' || status === 'folder'
                          // A row is openable only when the file is really there.
                          // `missing` and `invalid` both mean "the thing you edited is
                          // not a file I can open right now", and a row that looks
                          // clickable but does nothing is worse than one that says so.
                          // An absent status means available: that is what every row
                          // meant before the three states existed, and a client may
                          // talk to an older server.
                          const openable = gone === false && canPreview === true && typeof file.address === 'string' && file.address.length > 0
                          const note =
                            status === 'missing'
                              ? '文件已被删除或移动'
                              : status === 'invalid'
                                ? '文件存在但无法读取'
                                : status === 'unresolved'
                                  ? '这条记录只存了相对路径，无法定位到具体文件'
                                  : status === 'folder'
                                    ? '这是一个目录，不是一个文件'
                                    : ''
                          const absolute = String(file.path)
                          // Which bracket found this file stays a value, not a sentence.
                          // `api.js` normalises the stored value to 'git' | 'scan' | null
                          // and the row carries it as a `data-source` attribute, so the two
                          // brackets stay tellable apart while developing or while triaging a
                          // report. A value is checkable; a sentence in a tooltip was read
                          // once and then had to stay true forever.
                          //
                          // It is deliberately not shown. Someone reading this card is asking
                          // what changed, not which of the collectors happened to notice it,
                          // and a sentence about provenance invites a question the card cannot
                          // answer. Worse, `source` is stored per path and outlives the turn
                          // that wrote it: the same file can gain the sentence on one turn
                          // and lose it on the next as the brackets disagree, which reads as a
                          // change in the file. The attribute keeps the fact without the claim.
                          //
                          // One place that assembles the tooltip, because the row and the
                          // opener are separate elements and each shows its own title. The
                          // opener covers most of the row's width, so anything added only to
                          // the row would be invisible over the part people actually point at.
                          // `note` is empty for the ordinary available row, so the empty parts
                          // are dropped rather than joined: a plain join would leave the path
                          // followed by a blank line.
                          const hint = [absolute, note].filter((part) => part !== '').join('\n')
                          // Undefined for a file outside the workspace, which is what
                          // makes the second copy button disappear rather than copy a
                          // path with `..` in it that no build system ever wrote.
                          const relative = relativePath(absolute, cwd)
                          const key = `file:${file.path}`
                          const body = [
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
                              children:
                                status === 'missing'
                                  ? '已删除'
                                  : status === 'invalid'
                                    ? '无法读取'
                                    : status === 'unresolved'
                                      ? '无法定位'
                                      : status === 'folder'
                                        ? '目录'
                                        : formatBytes(file.bytes),
                            }),
                          ]
                          // One control, and the choice behind it. Two buttons could only
                          // say 绝对 / 相对, which is the one thing the reader already knows;
                          // the menu can also show the two paths, which is the thing they
                          // cannot reconstruct — and the difference between them is the whole
                          // decision.
                          //
                          // The answer is a colour on the icon, not a word: the button is
                          // 22px wide, and any text that fits there is too short to read. The
                          // label still carries it, because colour is not available to a
                          // screen reader and this is the only feedback the feature has.
                          const open = menuFor === key
                          const copiedHere = copied !== undefined && copied.key === key
                          const copyTitle = copiedHere === false
                            ? '复制路径'
                            : copied.ok === true ? '已复制' : '复制失败，剪贴板不可写'
                          const copyButton = clipboard === undefined ? null : jsx('button', {
                            ref: open === true ? copyRef : undefined,
                            className: 'dsse-row-copy',
                            type: 'button',
                            'data-dsse-copy': 'true',
                            'data-ok': copiedHere === false ? undefined : (copied.ok === true ? 'true' : 'false'),
                            'aria-expanded': open === true ? 'true' : 'false',
                            'aria-label': copiedHere === false
                              ? '复制路径'
                              : copied.ok === true ? '已复制路径' : '复制路径失败',
                            title: copyTitle,
                            onClick: () => setMenuFor(open === true ? undefined : key),
                            children: jsx(Icon, { name: 'copy' }),
                          }, `${key}:copy`)
                          const menuItem = (which, label, target) => {
                            if (target === undefined) return null
                            return jsxs('button', {
                              className: 'dsse-row-menuitem',
                              type: 'button',
                              onClick: () => {
                                copyPath(key, target)
                                setMenuFor(undefined)
                                // The list is about to vanish from under the
                                // pointer; the control stays put, so the answer
                                // lands where the reader already is.
                                if (copyRef.current !== null) copyRef.current.focus()
                              },
                              children: jsx('span', { className: 'dsse-row-menuitem-label', children: label }),
                            }, `${key}:${which}`)
                          }
                          // Both items are derived from the same row, so the row can be
                          // missing neither: an unreadable file still has a path to copy,
                          // and the relative one is the only entry that can be absent.
                          const menuItems = [menuItem('abs', '绝对路径', absolute), menuItem('rel', '相对路径', relative)]
                          // The menu is a block in the list rather than a popup over it, and
                          // a sibling of the row rather than a child: inside the row it would
                          // be a flex item on a second line, which moves the row's middle and
                          // takes the copy button with it. The card is overflow:hidden and the
                          // list is overflow-y:auto, so anything positioned outside this box
                          // is cut off exactly when the list is long enough to need it. In
                          // flow it follows the row in document order, which is what lets Tab
                          // reach the items. That is a disclosure, and it is declared as
                          // one: `role="menu"` would promise arrow-key navigation, a
                          // focused entry on open, and Escape returning to the control
                          // -- none of which is here, and a promise the reader cannot
                          // keep is worse than a plainer role that is simply true.
                          const menu = open === false ? null : jsx('div', {
                            ref: menuRef,
                            className: 'dsse-row-menu',
                            role: 'group',
                            'aria-label': `复制 ${parts.name} 的路径`,
                            children: menuItems,
                          }, `${key}:menu`)
                          // A pair, not a single element: the menu has to sit under the
                          // row but outside it, so the row keeps its own height and the
                          // copy button keeps its place on the line.
                          return [jsxs('div', {
                            className: 'dsse-row',
                            'data-noise': file.noise === true ? 'true' : 'false',
                            'data-stale': file.stale === true ? 'true' : 'false',
                            'data-source': file.source === 'git' || file.source === 'scan' ? file.source : 'unknown',
                            'data-status': status,
                            'data-actions': copyButton === null ? 'false' : 'true',
                            'data-menu': open === true ? 'true' : 'false',
                            // The whole row carries the path, not just the opener:
                            // hovering the size or the gap between parts is still
                            // hovering this file, and the tooltip should not flicker
                            // as the pointer crosses an invisible boundary.
                            title: hint,
                            children: [
                              openable === true
                                ? jsx('button', {
                                    className: 'dsse-row-open',
                                    type: 'button',
                                    title: `${hint}\n点击在侧栏预览`,
                                    onClick: () => openFile(file.address),
                                    children: body,
                                  })
                                : jsx('div', { className: 'dsse-row-body', children: body }),
                              jsx('div', { className: 'dsse-row-actions', children: copyButton }),
                            ],
                          }, key), menu]
                        }),
                      ],
                    }, group.key)),
                  }),
                  // The caveat sits under the rows, where it explains them. It is
                  // the collector's doubt, repeated verbatim rather than softened:
                  // "nothing was produced" and "nothing was produced that I could
                  // see" look identical in a list, and only this line tells them
                  // apart. Nothing is drawn for a complete sweep.
                  //
                  // Folded away with the rows it explains. The note is a caveat
                  // about a list the reader is not looking at while the card is
                  // closed, and on a closed card it is the only line besides the
                  // rows that is always there — a permanent "the directory may not
                  // be complete" under a list of three files reads as a warning
                  // about the three files. Opened, it comes back with them.
                  blindNote === '' || (filesExpanded === false && hiddenFiles > 0) ? null : jsx('p', { className: 'dsse-note', children: blindNote }),
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
      const [monitor, setMonitor] = React.useState({ visible: false })
      const [, bump] = React.useState(0)
      // The column the reader is currently dragging, if any. Deliberately a ref:
      // the drag is a run of pointer events between two renders, and re-rendering
      // on every one of them to store a number the next event overwrites would put
      // a full column of cards through reconciliation sixty times a second.
      const drag = React.useRef(null)

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
          setMonitor({ visible: false })
          applyMonitorReserve(0)
          forceTurnRail(false)
          return
        }

        const prose = geometry.chatRect.right - geometry.chatRect.left
        const column = placeMonitor({
          columnRect: geometry.columnRect,
          width: bridge.monitorWidth > 0 ? bridge.monitorWidth : MONITOR_DEFAULT_WIDTH,
          proseWidth: prose,
          scrollbarWidth: geometry.scrollbarWidth,
        })
        // The rail needs no second look here. `placeMonitor` already spent 40px
        // of the column's budget on it, so a drawn column is a column that left
        // the rail its room — the reservation and the rail's visibility are the
        // same fact, which is why `applyMonitorReserve` writes both attributes
        // from one number instead of measuring a second time.
        // An open sidebar takes the width the panel would have used, so the
        // panel steps aside rather than squeezing the prose under its documented
        // minimum. Closed, not narrowed: a half-width panel is a panel the reader
        // would have to re-learn every time they open the sidebar, and the header
        // switch is still there waiting for them.
        const on = bridge.open === true && column.visible === true && sidebarOpen() === false
        if (on) {
          applyMonitorReserve(column.reserve)
          forceTurnRail(true)
          setMonitor({ ...column, phase: geometry.phase })
          setPlace({ visible: false })
          return
        }
        // Off, or a conversation column genuinely too narrow to hold the column.
        // There is no second layout to fall back to any more: the gutter cards
        // were removed with the reservation, because a panel that changes shape
        // when someone drags a handle is a panel that has to be learned twice.
        applyMonitorReserve(0)
        forceTurnRail(false)
        setMonitor({ visible: false })
        setPlace({ visible: false })
      }, [])

      // Re-measure on every notification, not just re-render. The notification
      // fires when the session switches, which changes what the geometry should
      // say — bumping a counter alone redrew the same box.
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
        //
        // `data-rightbar-collapsed` is on the list because it decides whether
        // the column may be drawn at all. It lives on the frame, a parent of the
        // element above, so `subtree` is what makes it visible from here — and
        // its arrival and removal are the two moments the panel has to change,
        // neither of which changes any box this overlay measures.
        // `data-conversation-session` is the host's own statement of which
        // conversation is on screen, and it is the only one that is always
        // current: the header button publishes `bridge.sessionId` from an
        // effect, so a switch that does not re-render that button leaves the
        // whole column on the previous session. Reading the attribute here,
        // in root scope and on every change of it, puts the authority where
        // the fact lives. The observer is attributes-only and clustered with
        // the phase observer below for the same reason: a `childList`
        // observer would fire on every streamed token.
        //
        // Publishing through `notify()` (rather than only assigning) is what
        // makes the switch reach the column's session-scoped effects, which
        // key on this value. `anchor` starts empty on purpose: seeding it with
        // `liveSessionId()` would make the mount-time call below compare the
        // attribute with itself and return, so the first publish could never
        // happen — every observer after it would be the only way in, and there
        // is no observer until a switch replaces the subtree.
        let anchor = ""
        const syncSession = () => {
          const now = liveSessionId()
          if (now === "" || now === anchor) return
          anchor = now
          bridge.sessionId = now
          // Notify on every change of the attribute, not only when `bridge` had
          // to move. `bridge` can already hold this id: `Toggle` publishes the
          // session the host handed it as a prop, and the host hands that over
          // before it replaces the conversation element. That earlier notify
          // reaches a `Cards` whose render still reads the *old* attribute, so
          // its `sessionId` never changed and no effect reran. By the time the
          // attribute catches up, `bridge` matches and this used to stay silent,
          // leaving the column on the previous conversation until some unrelated
          // render happened to save it. The attribute changing is the event; what
          // `bridge` already says is not a reason to swallow it.
          notify()
        }

        let phaseObserver = null
        if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.documentElement) {
          phaseObserver = new MutationObserver(() => {
            syncSession()
            remeasure()
          })
          phaseObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-content-phase", "data-rightbar-collapsed", "data-conversation-session"],
            subtree: true,
          })
        }

        // The attribute observer above only fires if the host *edits* the
        // conversation element in place. The live host does not: it unmounts
        // `[data-conversation-content]` and mounts a new one, so a switch shows
        // up as `childList` records and as zero attribute records anywhere. A
        // column that watched only the attribute kept asking the previous
        // session until something else re-rendered it — the reported bug, and
        // the reason this second observer exists.
        //
        // Which node receives that record depends on how much the host
        // replaces, and both depths were measured on the running page: once the
        // whole subtree below the slot was swapped and the slot saw two records
        // (one removed, one added); once only the content node was replaced,
        // three wrappers down, and the slot saw **nothing at all**. Watching the
        // slot alone is what let that second case go unnoticed until the slow
        // clock came round, so this watches the slot *and* the content's own
        // parent — see the comment where it is attached.
        //
        // It watches nodes rather than the document: the slot is the nearest
        // ancestor the host does not replace, so a swap is one record instead of
        // one per streamed token. `subtree` stays off for the same reason, and
        // `childList` alone is what an unmount/remount produces.
        let slotObserver = null
        let slotNode = null
        let parentNode = null
        const attachSlotObserver = () => {
          if (typeof MutationObserver === "undefined" || typeof document === "undefined") return
          const content = document.querySelector("[data-conversation-content]")
          if (content === null) return
          let slot = content
          // `hasAttribute` is not on every node a test double exposes, and a
          // missing one must mean "keep climbing", not "throw out of a mutation
          // callback" — the column would then never recover from the switch.
          while (slot !== null && slot !== undefined && typeof slot.hasAttribute === "function" && slot.hasAttribute("data-slot") !== true) {
            slot = slot.parentElement
          }
          if (slot === null || slot === undefined || typeof slot.hasAttribute !== "function") return
          // Two targets, because they catch two different replacements and
          // neither covers both. The slot is the nearest ancestor the host
          // keeps across a switch, so watching it survives a replacement of any
          // wrapper in between. The content's own parent is where the swap
          // actually happens: measured on the live page the tree is
          // `[data-slot="main.conversation"] > .root > .body >
          // [data-conversation-content]`, three levels apart, so a host that
          // replaces only the content writes one record on the parent and
          // nothing at all on the slot. Watching the slot alone is what let a
          // switch go unnoticed until the slow clock came round.
          const parent = content.parentElement ?? null
          if (slot === slotNode && parent === parentNode) return
          if (slotObserver !== null) slotObserver.disconnect()
          slotNode = slot
          parentNode = parent
          slotObserver = new MutationObserver(() => {
            syncSession()
            // The replacement also invalidates every measurement and both
            // observers attached to the old node, so the next pass has to
            // re-find them rather than trust what it attached before.
            remeasure()
            attachSlotObserver()
          })
          slotObserver.observe(slot, { childList: true })
          // In a tree where the content really does sit directly under the slot
          // these are the same node, and observing one node twice buys nothing.
          if (parent !== null && parent !== slot) slotObserver.observe(parent, { childList: true })
        }
        // The attribute can also be right already at mount — a reload, or a
        // conversation that was open before this overlay existed.
        syncSession()
        attachSlotObserver()

        // The conversation can appear after this mounts (launcher -> session),
        // and `ResizeObserver` cannot watch an element that did not exist yet.
        // A slow poll is the cheap, boring answer; it costs one layout read per
        // second and stops as soon as there is something to observe.
        let timer = setInterval(() => {
          remeasure()
          attachRailObserver()
          attachSlotObserver()
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

        // The rail is mounted by the host only once a conversation holds enough
        // turns, which is usually later than this overlay's first measurement.
        // Nothing `ResizeObserver` watches changes size when a nav appears, so
        // the inline hold written during `remeasure` could never reach a rail
        // that arrived afterwards: it waited for an unrelated resize, and the
        // reported symptom was exactly that — the rail came back only once the
        // column was dragged. Observe the scroll body's children instead, which
        // is the direct signal, and coalesce to one pass per frame so a
        // streaming conversation costs a membership test rather than a layout
        // read per token.
        let railObserver = null
        let railFrame = 0
        // Attached lazily: this effect runs while the overlay is still waiting
        // for a session, and the scroll body belongs to the conversation that
        // mounts afterwards. `attachRailObserver` is therefore called once here
        // and again from the poll below until it finds something to watch.
        const attachRailObserver = () => {
          if (railObserver !== null) return
          if (typeof MutationObserver === "undefined" || typeof document === "undefined") return
          if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return
          const scrollBody = document.querySelector("[data-conversation-scroll]")
          if (scrollBody === null) return
          railObserver = new MutationObserver(() => {
            if (railFrame !== 0) return
            railFrame = window.requestAnimationFrame(() => {
              railFrame = 0
              if (bridge.open !== true) return
              forceTurnRail(true)
            })
          })
          railObserver.observe(scrollBody, { childList: true, subtree: true })
        }
        attachRailObserver()

        return () => {
          if (observer !== null) observer.disconnect()
          if (phaseObserver !== null) phaseObserver.disconnect()
          if (slotObserver !== null) slotObserver.disconnect()
          if (railObserver !== null) railObserver.disconnect()
          if (railFrame !== 0 && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
            window.cancelAnimationFrame(railFrame)
            railFrame = 0
          }
          if (typeof window !== "undefined") window.removeEventListener("resize", onResize)
          if (timer !== null) clearInterval(timer)
        }
      }, [remeasure])

      // Re-place when the setting changes side or the column is collapsed.
      React.useEffect(() => {
        remeasure()
      }, [remeasure, place.side])

      // A closed panel reserves nothing. This return is the only path that draws
      // nothing at all, so it is also the only one where nothing else hands the
      // width back: leaving the reservation in place would narrow the
      // conversation for the rest of the session because someone used the
      // switch. `applyMonitorReserve` compares before writing, so the repeated
      // call during a re-render costs nothing.
      if (bridge.open !== true || bridge.sessionId === "") {
        applyMonitorReserve(0)
        forceTurnRail(false)
        return null
      }

      // The overlay is mounted at the shell, so it is on screen on every page the
      // host has, not only on a conversation. The conversation *body* element is
      // drawn for all of them, which is why asking for it was not enough: on the
      // launcher and the new-session page it is there, empty, and the cards floated
      // over it. `phase` is the host's own answer, so the cards follow the page
      // rather than guessing from the DOM. An unpublished phase is a host we cannot
      // read; the cards stay, because hiding them on a version that does publish
      // nothing would remove the feature entirely.
      // `place` keeps the phase only while the gutter layout owns the panel; the
      // monitor branch is the one that drew, so it is also the one that says which
      // page this is. Reading it from `place` alone let a launcher page through:
      // that branch clears `place` on its way out, so the phase read as "" and the
      // hero guard below never fired.
      const phase = (monitor.visible === true ? monitor.phase : place.phase) ?? ""
      if (phase === "hero") return null

      // The column belongs to one conversation, so it is keyed by the one on
      // screen. A switch then remounts it instead of asking React to notice a
      // changed dependency: a render whose effects never commit -- which React is
      // free to do -- would otherwise leave the column showing the previous
      // conversation, fetched under the previous `sessionId`, with nothing
      // scheduled to try again. Remounting does exactly the work those effects
      // would have done (fetch, open a stream, reset the turn tags), so this is
      // not a second code path, only a guarantee that the first one runs.
      const monitorKey = liveSessionId() || bridge.sessionId

      // The monitor column, when it is on and has room, is the whole panel: the
      // header toggle opened it, so there is no second thing to open. `collapsed`
      // is deliberately not read here — it started life as "the cards are folded
      // into a 16px handle at the edge of the prose", and a column that reserves
      // its own width has nothing to fold into; the header icon is its switch.
      if (monitor.visible === true) {
        const stopDrag = (event) => finishDrag(event)
        const onGripDown = (event) => {
          const current = monitor.width
          if (!Number.isFinite(current)) return
          drag.current = { startX: event?.clientX ?? 0, startWidth: current, pointerId: event?.pointerId }
          event?.preventDefault?.()
          try {
            event?.currentTarget?.setPointerCapture?.(event?.pointerId)
          } catch {
            // Not every pointer is capturable (and a synthetic one never is). The
            // move handler is on `window`, so losing capture costs nothing.
          }
        }
        const onGripMove = (event) => {
          const state = drag.current
          if (state === null) return
          const dx = (event?.clientX ?? 0) - state.startX
          const asked = state.startWidth - dx
          // Clamped here, at the only place a width ever originates, and clamped
          // to the column's own range rather than to the prose budget. The budget
          // moves with the window, so a drag performed on a narrow window used to
          // persist a width that a wide window would then honour — which is how a
          // handle dragged once left the panel pinned to its minimum for good. The
          // range does not move with the window, so the number a person chooses is
          // the number they get back.
          const clamped = Math.max(MONITOR_MIN_WIDTH, Math.min(MONITOR_MAX_WIDTH, Math.round(asked)))
          // Written straight to the bridge and re-measured rather than held in
          // state: `placeMonitor` needs the same inputs during a drag as after
          // one. Persisting happens once, on release — a POST per pixel would be a
          // POST per frame.
          bridge.monitorWidth = clamped
          remeasure()
        }
        const finishDrag = (event) => {
          if (drag.current === null) return
          drag.current = null
          try {
            event?.currentTarget?.releasePointerCapture?.(event?.pointerId)
          } catch {
            // Released already, or never captured. Nothing to undo.
          }
          const width = monitor.width
          if (!Number.isFinite(width) || width <= 0) return
          bridge.monitorWidth = width
          call("/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ monitorWidth: width }),
          }).catch(() => {
            // A refused width is not worth a visible error: the drag already took
            // effect in this window, and the next mount re-reads the saved value.
          })
        }
        return jsx("div", {
          ref: hostRef,
          style: { position: "absolute", inset: 0, pointerEvents: "none" },
          children: jsxs("div", {
            className: "dsse-monitor",
            "data-dsse-monitor": "1",
            style: {
              left: `${monitor.left}px`,
              top: `${monitor.top}px`,
              width: `${monitor.width}px`,
              height: `${monitor.height}px`,
            },
            children: [
              jsx("div", {
                className: "dsse-monitor-grip",
                "data-dragging": drag.current !== null ? "true" : "false",
                role: "separator",
                "aria-orientation": "vertical",
                "aria-label": "拖动调整监控列宽度",
                title: "拖动调整宽度",
                onPointerDown: onGripDown,
                onPointerMove: onGripMove,
                onPointerUp: stopDrag,
                onPointerCancel: stopDrag,
                onLostPointerCapture: stopDrag,
              }, "grip"),
              // No column header. A title saying "monitor" on a column whose only
              // content is the monitor is a caption on the obvious, and at 220px
              // the width it costs is a row of a card. The panel's switch is in
              // the session header, so closing does not need a control in here
              // either. What the old header carried — nothing but a label and a
              // close button — is exactly what the top row of the cards already
              // is once you stop separating them.
              jsx("div", { className: "dsse-monitor-body", children: jsx(Cards, { key: monitorKey, place: monitor, embedded: true }) }),
            ],
          }),
        })
      }

      // Nothing to draw, and no second layout to fall back to: the old gutter cards
      // and the 16px handle they folded into are gone with the reservation. A
      // conversation column too narrow to hold the column now simply has no panel,
      // which is the honest version of "there is not room" — a panel that changes
      // shape when someone drags a window edge has to be learned twice.
      if (place.visible === false) return jsx("div", { ref: hostRef, style: { display: "none" } })

      return jsx("div", {
        ref: hostRef,
        style: { position: "absolute", inset: 0, pointerEvents: "none" },
        children: jsx("div", {
          style: { pointerEvents: "auto", display: "contents" },
          children: jsx(Cards, { key: monitorKey, place }),
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
            // The monitor column is on by default; only an explicit `false` in the
            // saved config turns it off, which is also how `readConfig` reports it
            // (`monitorColumn: config.monitorColumn !== false`).
            //
            // This sets `bridge.open`, the same flag the switch in the header
            // flips. There were two flags until the card rail was removed — one
            // for "did the person turn the panel on", one for "is the column the
            // layout" — and with the cards gone they mean the same thing. Keeping
            // both is what let a saved "off" draw nothing while the switch stayed
            // lit, which is a worse lie than either state on its own.
            if (typeof next?.monitorColumn === "boolean") bridge.open = next.monitorColumn
            if (Number.isFinite(next?.monitorWidth) && next.monitorWidth > 0) bridge.monitorWidth = next.monitorWidth
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

      // A 24px glyph in the header's action row, not a labelled button. The row
      // already holds the host's sidebar toggle and whatever other plugins add,
      // and a word with a count badge reads as a tab beside icons for panels.
      // The count went with the label: the column shows the queue itself, and a
      // number that repeats it is the part that made the old button look busy.
      const label = open === true ? "收起任务监控" : "打开任务监控"
      return jsx("button", {
        className: "dsse-toggle",
        type: "button",
        "data-active": String(open),
        "aria-pressed": String(open),
        "aria-label": label,
        title: label,
        onClick: () => {
          bridge.sessionId = sessionId
          bridge.open = open === false
          notify()
        },
        children: jsx(Icon, { name: "monitor" }),
      })
    }

    const inject = ["slots"]

    /**
     * Register both seats.
     *
     * @param {any} ctx - the client plugin context.
     */
    function apply(ctx) {
      // `utilities`, not `actions`.
      //
      // `actions` ends before the header's flexible middle, so a switch
      // registered there lands among the conversation's own controls and reads
      // as one of them. `utilities` is the right-aligned run whose slot contract
      // calls it "session utilities in ascending order"; after it comes the
      // corner seat the sidebar-right package took for its expand button, and
      // after that the native window buttons. Registering here with a high order
      // puts the switch at the right edge of the document, one seat short of the
      // window controls — as close to them as a renderer-side plugin can get,
      // because those three buttons are drawn by Electron's titleBarOverlay and
      // are not elements in the DOM at all.
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.session.header.utilities", () =>
            ctx.slots.register(
              {
                name: "conversation.session.header.utilities",
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
          // The reservation is a modification of the host's own scroll container.
          // Leaving it behind keeps the conversation narrowed after the plugin is
          // gone — a width nobody is drawing into and nothing will give back.
          applyMonitorReserve(0)
          forceTurnRail(false)
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
