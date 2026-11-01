/**
 * `@revxz/dsh-evolve-core` — the engine the evolve plugins share.
 *
 * This package holds exactly the parts that are about *skills and candidates*,
 * with no opinion about how they are presented or how they are detected:
 *
 * - `paths.js`     where state lives on disk
 * - `skillfile.js` reading and writing a `SKILL.md`, and the ownership marker
 * - `store.js`     the serialized read-modify-write store and the ledger
 * - `candidates.js` the proposal queue and its staleness rules
 * - `evidence.js`  the gate that decides whether a quote is real evidence
 * - `lifecycle.js` stage decisions (`unverified` → `active` → `stale`/`inverted`)
 * - `outcome.js`   the post-load observation window
 *
 * It deliberately contains no detector, no hint channel, no HTTP route and no
 * React. Those belong to `@revxz/dsh-skill-evolve` and `@revxz/dsh-ui-evolve`,
 * which both read this package instead of each other.
 *
 * ## One name collision, kept rather than merged
 *
 * `candidates.js` and `lifecycle.js` each compute "how many days old is this",
 * and they disagree on the unreadable case: a candidate whose timestamp cannot
 * be parsed is `0` days old (so it is not expired), while a skill whose
 * validation stamp is missing is `Infinity` days old (so it is overdue). Both
 * answers are load-bearing — merging them would silently either expire every
 * candidate with a damaged file or never age a skill again. They are re-exported
 * here as `ageInDays` (lifecycle) and `candidateAgeInDays` (candidates) so that
 * a caller has to pick one on purpose.
 *
 * @module @revxz/dsh-evolve-core
 */

export { dshHome, skillRoot, stateDir } from './paths.js'

export {
  assertSkillName,
  isMissing,
  listOwnedSkills,
  OWNER_MARKER,
  parseFrontmatter,
  readSkillFile,
  readState,
  renderSkillFile,
  SKILL_FILE,
  SKILL_NAME
} from './skillfile.js'

export { appendLedger, procedureSignature, Store } from './store.js'

// The host's own rule for what counts as "a skill was loaded". Shared rather
// than copied: the detector counts these loads and the panel lists them, and two
// copies of the parse would eventually disagree about the same event.
export { readSkillArgument, SKILL_GESTURE } from './skillcall.js'

export {
  annotateQueue,
  candidateAgeInDays,
  contentDigest,
  describeStale,
  digest,
  evaluateStaleness,
  findByName,
  isLive,
  STALE_REASONS
} from './candidates.js'

export {
  corpusFromEvents,
  EVIDENCE_CLASSES,
  lanesFromEvents,
  normalize,
  ownCallIds,
  quoteAppears,
  runGate,
  validateEvidenceEntry
} from './evidence.js'

export {
  ageInDays,
  confidence,
  decideStage,
  HALF_LIFE_DAYS,
  HARMFUL_WEIGHT,
  invertBody,
  STAGES,
  stateToFrontmatter,
  summarize,
  unwrapInverted
} from './lifecycle.js'

export {
  MAX_FAILED_TOOLS,
  MAX_TRACKED_CALLS,
  OUTCOMES,
  OUTCOME_TURNS,
  OutcomeStore,
  Window
} from './outcome.js'
