/**
 * Validated plugin configuration.
 *
 * Every field is optional so the bundle patch can mount the plugin with no
 * `config:` block at all. Defaults mirror the values argued for in
 * `docs/05-设计方案.md`: the plugin proposes by default, writes only through
 * the model's own tool call, and never grows the catalog on its own.
 *
 * @module dsh-skill-evolve/config
 */

import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /**
   * `suggest` — inject a hint and let the model decide.
   * `auto` — write the skill as soon as the model submits it, with no
   * approval step. Still routes through the evidence gate.
   * `off` — no detection at all: no hints, no submissions, no writes. The
   * tools and commands stay registered so an existing queue can still be
   * reviewed and approved.
   */
  mode: z.union([z.const('suggest'), z.const('auto'), z.const('off')]).default('suggest'),

  /** How many times one procedure must recur before it is worth a hint. */
  minRepeatCount: z.number().step(1).min(2).max(20).default(2),

  /** Longest tool-name window the detector considers a single procedure. */
  repeatWindowMax: z.number().step(1).min(3).max(20).default(6),

  /** Shortest window that can count as a procedure. */
  minWindow: z.number().step(1).min(2).max(10).default(3),

  /**
   * Expand shell calls into the commands they run.
   *
   * A session can spend two hundred calls doing 截图 → 解析 → 看图 through
   * nothing but `bash`. Name-level detection sees "bash, bash, bash" there and
   * reports either nothing or a habit. With this on, one call contributes one
   * step per command, so the workflow becomes visible.
   *
   * Off means pure tool names, which is the older, weaker behaviour.
   */
  commandSignature: z.boolean().default(true),

  /** Upper bound on hints per session; prevents nagging. */
  maxHintsPerSession: z.number().step(1).min(0).max(50).default(4),

  /**
   * Model steps a published hint keeps its full text before degrading to a
   * one-line pointer.
   *
   * A hint has two fates: the model acts on it, or the model reads it and
   * decides the procedure is not worth keeping. The second fate is silent, so
   * a naive channel leaves the whole text in every later snapshot. Measured on
   * a complete 44,931-event transcript: 132 snapshots, 79,896 characters
   * (~20K tokens) of hint text, with one procedure riding along for 106
   * consecutive steps.
   *
   * Deleting the text on a deadline was the first attempt and it was wrong.
   * That same session did eventually submit a skill — 412 steps after the hint
   * first appeared — because the text was still there to be re-read. A
   * deadline short enough to save tokens would have removed the hint before
   * the one time it worked. So the full text degrades to a pointer that still
   * names the procedure and the tool: 604 characters become ~100, the measured
   * cost drops 69% (79,896 -> 24,407 characters, replayed through this class),
   * and all 132 snapshots still carry an actionable hint.
   *
   * `0` keeps the full text for the hint's whole life.
   */
  hintShrinkAfterSteps: z.number().step(1).min(0).max(500).default(8),

  /**
   * Model steps after which a hint disappears entirely, pointer included.
   *
   * Off by default. No measurement supports a deadline: the one recorded
   * case of a long-lived hint finally working happened at step 412, and
   * `hintShrinkAfterSteps` already removes 69% of the cost without giving up
   * that possibility. The longest observed life was 106 steps, so deadlines of
   * 120 and 200 both saved nothing over shrinking alone. Retirement stays available for sessions that want a hard
   * floor.
   *
   * `0` disables retirement.
   */
  hintExpiresAfterSteps: z.number().step(1).min(0).max(2000).default(0),

  /**
   * Model steps a reflection keeps the hint channel to itself.
   *
   * Both triggers write into one slot, so a repeat hint that fires one step
   * after a reflection silently replaces it: the model reads the repeat hint
   * and never sees the checkpoint. On a real session the pacer ruled two
   * reflections due, the first reached the model, and the second was overwritten
   * before it was ever assembled.
   *
   * The hold is short on purpose. A reflection is rationed to two per session,
   * so it is the scarce signal; but the repeat detector is what notices work the
   * model is doing right now, and reserving the channel forever would starve
   * that instead. Eight steps is the same unit `hintShrinkAfterSteps` uses — the
   * point by which the model has had a full-text read of the hint.
   *
   * `0` disables the hold and lets either kind replace the other freely.
   */
  reflectionHoldSteps: z.number().step(1).min(0).max(500).default(8),

  /**
   * Which triggers are active.
   *
   * `turn` — reflect at the end of a real conversation turn (wide, semantic).
   * `repeat` — announce a repeated tool procedure (narrow, structural).
   *
   * Both can be on at once. They see different things: a turn-end reflection
   * can notice a corrected preference or a library pitfall, which no tool-name
   * window will ever reveal; a repetition can notice a procedure mid-turn,
   * before any turn ends at all.
   */
  triggers: z.array(z.union([z.const('turn'), z.const('repeat')])).default(['turn', 'repeat']),

  /** Human turns between turn-end reflections. */
  reflectionCadence: z.number().step(1).min(1).max(50).default(3),

  /** Tool calls a turn needs before it is worth reflecting on. */
  reflectionMinToolCalls: z.number().step(1).min(0).max(200).default(4),

  /** Hard cap on reflections per session; keeps the checkpoint from becoming noise. */
  maxReflectionsPerSession: z.number().step(1).min(0).max(20).default(2),

  /** Override for the user skill root. Empty means `$DSH_HOME/skills`. */
  skillRoot: z.string().default(''),

  /** Maximum number of unapproved candidates kept before further ones are refused. */
  maxCandidates: z.number().step(1).min(1).max(500).default(50),

  /**
   * Days before an unapproved candidate expires.
   *
   * A candidate is a snapshot of a moment: the session it came from, the
   * catalog as it stood, the body the model had in mind. Approving an old one
   * means signing off on a decision made against state that has since moved.
   * Expired candidates are never deleted — they stay readable — but they
   * cannot be approved until regenerated.
   */
  candidateTtlDays: z.number().step(1).min(1).max(3650).default(30),

  /**
   * `confirm` — approving stages the candidate and asks the model to re-check
   * it against the current catalog before the file is written. This is Qoder's
   * behaviour: "accepting opens a new conversation to confirm the plan before
   * creating or updating a Skill; task creation does not mean the Skill has
   * already changed."
   *
   * `direct` — approving writes the file immediately, as earlier versions did.
   * One step, less to go wrong, but it writes a body nobody re-read.
   */
  approvalMode: z.union([z.const('confirm'), z.const('direct')]).default('confirm'),

  /**
   * Cross-check a candidate's source session against the session index before
   * letting it be approved. A candidate whose transcript is gone cannot be
   * audited, and its quotes can no longer be re-verified.
   */
  verifyCandidateSource: z.boolean().default(true),

  /** Uses needed before an `unverified` candidate is promoted to `active`. */
  promoteAfterUses: z.number().step(1).min(1).max(50).default(3),

  /** Harmful reports needed before an `active` skill is inverted into a warning. */
  invertAfterHarmful: z.number().step(1).min(1).max(20).default(3),

  /** Days without a validation before an `active` skill is reported stale. */
  staleAfterDays: z.number().step(1).min(1).max(3650).default(90),

  /** Show the hint as a `required` runtime context (survives suppression). */
  hintRequired: z.boolean().default(false),

  /**
   * Rewrite the host's skill catalog so an unranked library does not cost
   * tokens on every step.
   *
   * The host renders every model-invocable skill into one durable message and
   * republishes the whole list whenever a name or description changes. At 500
   * skills that is ~31K tokens before the conversation has said anything, and
   * a second full copy for each later change. This switch shortens the
   * descriptions of skills nothing has vouched for, while leaving the ranking
   * evidence — pins, demotions, session use, durable use counts — readable in
   * full.
   *
   * On by default: a library small enough not to need it is also small enough
   * that the rewrite is a no-op (the measured saving is 0% at four entries), so
   * the switch only costs anything when it is also earning its keep.
   */
  catalogEnabled: z.boolean().default(true),

  /**
   * Character budget for a description that no ranking rule promoted.
   *
   * 80 is the smallest value that still says what a skill does in one line
   * ("Fill and flatten PDF forms with field-level precision") while dropping
   * the caveats and examples that make up most of a long description. It is
   * deliberately not smaller: at 40 the remaining text is usually a noun
   * phrase, and two skills that differ only in applicability become
   * indistinguishable — which is worse than paying for the words, because the
   * model then loads the wrong one.
   */
  catalogShrinkChars: z.number().step(1).min(0).max(2000).default(80),

  /**
   * At or above this many skills, list names only.
   *
   * Beyond a few hundred entries, even 80 characters each is a large fixed
   * cost per step, and no model reads a list that long before acting. Names
   * plus the `skill_search` tool is the cheaper trade: the model sees that a
   * library exists and can look inside it on demand.
   *
   * `0` disables the cutoff and always keeps descriptions.
   */
  catalogFullListBelow: z.number().step(1).min(0).max(100000).default(40),

  /**
   * Count a skill as in-use for this session once the model loads it, and show
   * that skill's full description for the rest of the session.
   *
   * This is the one rule that makes the catalog text differ between sessions,
   * so it invalidates the prompt cache at the start of each new session. Turn
   * it off if that cost outweighs seeing what the session actually uses.
   */
  catalogSessionAware: z.boolean().default(true),

  /**
   * Durable use count that earns a full description.
   *
   * Matches `promoteAfterUses` by default so that "proven enough to promote"
   * and "proven enough to stay readable" are the same threshold. Keeping them
   * different would mean a skill could be `active` and still truncated, which
   * reads like a bug even when it is intended.
   */
  catalogFrequentUses: z.number().step(1).min(1).max(1000).default(3)
})
