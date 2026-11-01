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
 * The summary route is deliberately *not* the session's own route by default:
 * see the `summaryProvider` doc below for why that is cheaper and more
 * predictable rather than merely lower quality.
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
   * Left empty, the summary uses the first model the first registered provider
   * advertises. That is a deliberate choice to be cheap and predictable rather
   * than good: a sidebar summary does not warrant the session's own route, and
   * silently borrowing it would make the panel expensive in proportion to how
   * much the conversation matters.
   */
  summaryProvider: z.string().default(''),

  /** Model for the summary call. Set together with `summaryProvider`. */
  summaryModel: z.string().default(''),

  /**
   * Which gutter the cards float in.
   *
   * The conversation column is centred and narrower than the window, so both
   * sides have empty space. Cards live in one of them — never both — because two
   * columns of small text either side of the prose competes with the prose. The
   * left gutter is the default: the right one is where the host puts file
   * previews, so parking cards there means they are hidden exactly when a person
   * is reading something and most likely to want them.
   */
  panelSide: z.union(['left', 'right']).default('left'),

  /**
   * Start with the cards collapsed to a handle.
   *
   * Off by default so the panel is discoverable, but a person who has decided
   * they do not want it on screen can leave it collapsed permanently without
   * losing the toggle.
   */
  panelCollapsed: z.boolean().default(false)
})
