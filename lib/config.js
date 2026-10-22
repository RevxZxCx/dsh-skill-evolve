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

  /** Upper bound on hints per session; prevents nagging. */
  maxHintsPerSession: z.number().step(1).min(0).max(50).default(4),

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
