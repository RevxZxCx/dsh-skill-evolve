/**
 * Validated configuration for `@revxz/dsh-ui-evolve`.
 *
 * These five switches describe a card, not a candidate: how the previous-turn
 * summary is produced, which gutter the cards float in, and whether they start
 * collapsed. They lived in `@revxz/dsh-skill-evolve` before the split, where a
 * profile that only wanted the panel still had to install the whole detector to
 * change them.
 *
 * Every field is optional so the bundle patch can mount the plugin with no
 * `config:` block at all.
 *
 * The summary route is borrowed from the session by default, because that route
 * is proven callable for this account; the catalogue is only a last resort.
 * See the `summaryProvider` doc below, and `lib/summarise.js` — which is the
 * file that actually decides this — before changing either one.
 *
 * @module @revxz/dsh-ui-evolve/config
 */

import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /**
   * Show the "previous turn" summary in the session panel.
   *
   * This is the only feature in this plugin that spends money on its own: every
   * completed turn becomes one small model call. It is on by default because the
   * summary is the panel's main reason to exist, but the switch is here so a
   * person who objects to the cost is not forced to uninstall the plugin to stop
   * it.
   */
  panelSummary: z.boolean().default(true),

  /**
   * Provider for the summary call. Set together with `summaryModel`.
   *
   * Left empty, the summary borrows the route this session is already using,
   * read from its own folded `request/context` events. That route is known to be
   * reachable and authorised for this account, while a catalogue entry only
   * proves some adapter advertised it. The catalogue is still consulted as a
   * last resort — a session that has not made its first request has no route to
   * borrow — and it walks every provider rather than the first one, because a
   * provider is registered as soon as its adapter activates regardless of
   * whether it has a model this account may call.
   *
   * Setting only one of this pair pins nothing: both are required.
   */
  summaryProvider: z.string().default(''),

  /** Model for the summary call. Set together with `summaryProvider`. */
  summaryModel: z.string().default(''),

  /**
   * Draw the monitor column.
   *
   * The monitor column is a reserved strip inside the conversation region: the
   * prose gives up width so the column can sit beside it, and the column stays
   * put for as long as the conversation is open. That is the arrangement this
   * panel was asked to match — something to glance at while working, not a
   * drawer that covers what is underneath.
   *
   * On by default. The gutter layout it replaces only appeared when the window
   * was wide enough to have empty space beside the prose, which on a 1440px
   * window with the sidebar open left 209px — narrower than the cards, so the
   * panel was squeezed or absent exactly where it was most wanted.
   *
   * This is the only layout there is: the gutter cards it replaced were removed,
   * because a panel that changes shape when a window is dragged has to be
   * learned twice. Turning the column off leaves no panel, which is what the
   * switch in the session header already means.
   */
  monitorColumn: z.boolean().default(true),

  /**
   * Width of the monitor column, in pixels.
   *
   * 300 is the width the column was designed at: enough for a file path plus
   * its state, and enough for the two-line summaries, without reading as a
   * second conversation. The drag handle beside it writes back here, so this is
   * both the starting width and the value a person last landed on.
   *
   * Clamped at both ends when used: below `MONITOR_MIN_WIDTH` the cards wrap to
   * unreadable, and past `MONITOR_MAX_WIDTH` the column stops being something
   * glanced at. The clamp lives in `gutter.js` beside the arithmetic that
   * depends on it, not here, so the two cannot drift.
   */
  monitorWidth: z.number().default(300)
})
