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
.dsse-icon-btn{width:36px;height:36px;display:inline-grid;place-items:center;flex:0 0 auto;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6270);cursor:pointer;transition:background-color 160ms ease,color 160ms ease}
.dsse-icon-btn:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-primary,#0f1115)}
.dsse-icon{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.dsse-queue{flex:0 0 auto;min-height:44px;display:flex;align-items:center;gap:8px;width:100%;padding:8px 11px;border:1px solid var(--dsw-alias-state-business-primary,rgba(77,107,254,.25));border-radius:10px;background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.07));color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-weight:500;text-align:left;cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease}
.dsse-queue:hover{background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.13));border-color:var(--dsw-alias-state-business-primary,rgba(77,107,254,.5))}
.dsse-review-root{display:contents}
.dsse-count{display:inline-block;min-width:22px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.14));color:var(--dsw-alias-state-business-primary,#2f4bd8);font-size:max(.85em,11px);text-align:center}
.dsse-card{flex:0 0 auto;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.1));border-radius:11px;box-shadow:0 2px 8px rgba(15,17,21,.04);overflow:hidden}
.dsse-card-head{display:flex;align-items:center;gap:8px;min-height:42px;padding:9px 11px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.07))}
.dsse-card-title{margin:0;font-size:.94em;line-height:1.4;font-weight:600;white-space:nowrap}
.dsse-card-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px);text-align:right}
.dsse-card-head .dsse-icon-btn{width:30px;height:30px;border-radius:7px}
.dsse-head-stats{display:flex;align-items:baseline;gap:8px;margin-left:auto;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px);white-space:nowrap}
.dsse-head-stat{display:inline-flex;align-items:baseline;gap:3px}
.dsse-head-stat b{color:var(--dsw-alias-label-primary,#0f1115);font-weight:600;font-variant-numeric:tabular-nums}
.dsse-head-btn{flex:0 0 auto;min-height:26px;display:inline-flex;align-items:center;gap:5px;margin-left:8px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:max(.85em,11px);font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color 160ms ease,opacity 160ms ease}
.dsse-head-btn:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-head-btn:disabled{opacity:.5;cursor:default}
.dsse-clip{position:relative;overflow:hidden}
.dsse-clip[data-clipped="true"]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:34px;pointer-events:none;background:linear-gradient(to bottom,transparent,var(--dsw-alias-bg-layer-1,#fff))}
.dsse-clip .dsse-text{max-height:5.2em;overflow:hidden}
.dsse-card-body{padding:11px}
.dsse-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dsse-summary-title{margin:0 0 6px;font-size:1em;line-height:1.45;font-weight:500}
.dsse-muted{color:var(--dsw-alias-label-secondary,#5b6270)}
.dsse-tiny{font-size:.9em;line-height:1.55}
.dsse-list{display:grid;gap:3px}
.dsse-row{display:flex;align-items:center;gap:7px;min-width:0;min-height:36px;padding:5px 6px;border-radius:7px}
.dsse-row:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-row-main{flex:1;min-width:0}
.dsse-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsse-font-mono,var(--dsse-font-family,inherit));font-size:max(.9em,12px)}
.dsse-where{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px)}
.dsse-size{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8b92a1);font-size:max(.85em,11px);white-space:nowrap}
.dsse-badge{display:inline-block;flex:0 0 auto;padding:2px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f2f4f8);color:var(--dsw-alias-label-secondary,#5b6270);font-size:max(.85em,11px)}
.dsse-badge-own{background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.14));color:var(--dsw-alias-state-business-primary,#2f4bd8)}
.dsse-btn{min-height:36px;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:7px 11px;border:1px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color 160ms ease,opacity 160ms ease}
.dsse-btn:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.dsse-btn-primary{border-color:var(--dsw-alias-brand-text,#2f4bd8);background:var(--dsw-alias-brand-primary,#2f4bd8);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsse-btn-primary:hover{background:var(--dsw-alias-brand-primary,#2f4bd8);opacity:.9}
.dsse-btn:disabled{opacity:.5;cursor:default}
.dsse-more{border:0;background:transparent;color:var(--dsw-alias-brand-text,#2f4bd8);font:inherit;font-size:max(.85em,11px);cursor:pointer;padding:6px 0}
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
     * Width of the candidate list that opens off the propose button.
     *
     * Wide enough for a kebab-case skill name plus a one-line description, which
     * is what the list row shows. Narrower and every row truncates the name, which
     * is the one field a person needs in order to decide.
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


    /**
     * Cap the summary and fade only the part that is actually hidden.
     *
     * The cap is unconditional — it is the height budget the header was sized
     * against. The gradient is not: a two-line summary is shorter than the 34px
     * mask, so drawing it unconditionally washes out text that was never
     * truncated. Whether there is more to see is a layout fact, so it is measured
     * after paint rather than assumed.
     */
    function Clip(props) {
      const ref = React.useRef(null)
      const [overflowing, setOverflowing] = React.useState(false)
      // Measure before paint, not after. A passive effect runs after the browser has
      // already painted the frame, so a clipped summary would show one frame with
      // its text cut and no fade over it — a visible flicker on every first render.
      // The fallback exists for renderers with no layout phase (the test harness,
      // and any environment that only implements the passive hook).
      const useLayout = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect
      useLayout(() => {
        const node = ref.current
        if (node === null) return
        const hidden = node.scrollHeight > node.clientHeight + 1
        setOverflowing(hidden)
      })
      return jsx('div', {
        className: 'dsse-clip',
        'data-clipped': overflowing === true ? 'true' : 'false',
        children: jsx('p', { ref, className: 'dsse-text dsse-tiny', children: props.text }),
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
      return jsxs('section', {
        className: 'dsse-card',
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
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState("")
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
      }, [sessionId])

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

      const summaryText = state.status === 'loading'
        ? '正在读取本轮数据…'
        : summary?.text !== undefined && String(summary.text).length > 0
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
        ((summary?.text !== undefined && String(summary.text).length > 0) || (data.calls ?? 0) > 0 || (data.failed ?? 0) > 0 || ordered.length > 0)
      const showTurn = turnHasContent
      const showActivity = activity.length > 0
      const showFiles = ordered.length > 0
      const pendingCandidates = Number.isFinite(data?.pendingCandidates) ? data.pendingCandidates : 0
      // Pending candidates count as content too. The header button is the panel's
      // only route to the review dialog, so hiding it while the queue holds work
      // would leave those decisions reachable only through the slash command.
      const hasAnyCard = showTurn || showActivity || showFiles || pendingCandidates > 0

      // Nothing to show and nothing wrong: draw nothing at all, chrome included.
      // Leaving the three header buttons floating over an empty rail was the
      // reported bug — an empty panel still looked like a panel.
      if (hasAnyCard === false && error === '') return settings

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
                head: jsxs('div', {
                  className: 'dsse-head-stats',
                  children: [
                    jsxs('span', { className: 'dsse-head-stat', children: [jsx('b', { children: String(data?.calls ?? 0) }), jsx('span', { children: '调用' })] }),
                    jsxs('span', { className: 'dsse-head-stat', children: [jsx('b', { children: String(commands) }), jsx('span', { children: '命令' })] }),
                    jsxs('span', { className: 'dsse-head-stat', children: [jsx('b', { children: String(ordered.length) }), jsx('span', { children: '文件' })] }),
                    jsxs('button', {
                      className: 'dsse-head-btn dsse-propose',
                      type: 'button',
                      disabled: busy || sessionId === '',
                      onClick: propose,
                      children: [jsx(Icon, { name: 'spark' }), busy ? '已发送' : '提炼'],
                    }),
                  ],
                }),
                children: jsx(Clip, { text: summaryText }),
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
                meta: `${ordered.length} 个文件`,
                children: [
                  jsx('div', {
                    className: 'dsse-list',
                    children: shown.map((file) => {
                      const parts = splitPath(file.path)
                      return jsxs('div', {
                        className: 'dsse-row',
                        children: [
                          jsxs('span', {
                            className: 'dsse-row-main',
                            children: [
                              jsx('span', { className: 'dsse-name', title: String(file.path), children: parts.name }),
                              parts.where === '' ? null : jsx('span', { className: 'dsse-where', children: parts.where }),
                            ],
                          }),
                          jsx('span', { className: 'dsse-size', children: formatBytes(file.bytes) }),
                        ],
                      }, `file:${file.path}`)
                    }),
                  }),
                  ordered.length > shown.length || filesOpen
                    ? jsx('button', {
                        className: 'dsse-more',
                        type: 'button',
                        onClick: () => setFilesOpen((open) => open === false),
                        children: filesOpen ? '收起' : `全部 ${ordered.length} 个`,
                      })
                    : null,
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
          stopHostTypography()
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
