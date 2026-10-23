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
  hintRequired: z.boolean().default(false)
})
