/**
 * Repeated-procedure detection over the tool-call stream.
 *
 * The detector deliberately sees only tool NAMES, never arguments. Two
 * different `read` calls on two different files belong to the same procedure
 * as far as repetition is concerned; the model supplies the meaning later
 * when it decides whether the procedure is worth writing down.
 *
 * Three rules, each of which exists because the naive version misfires:
 *
 * 1. **Non-overlapping counts.** `a,b,c,a,b,c` is two occurrences of one
 *    procedure, not four overlapping windows. Counting overlapping windows
 *    makes every long run look explosive.
 * 2. **A floor on window width.** A single tool repeated six times
 *    (`read,read,read,read,read,read`) is a habit, not a workflow. Windows
 *    narrower than `minWindow` are never reported.
 * 3. **Widest match wins.** Widths are scanned from the largest down, so a
 *    6-step procedure is reported as one procedure instead of being shredded
 *    into two 3-step halves.
 *
 * @module dsh-skill-evolve/signal
 */

/** Tools that observe state and therefore carry little procedural meaning. */
const OBSERVER_TOOLS = new Set(['read', 'glob', 'grep', 'list_agents', 'todo_write'])

/**
 * Fewest distinct tool names a window must contain to count as a procedure.
 *
 * Measured, not guessed: replaying a real 487-call coding session with a
 * threshold of 2 produced four hints, all of them variations of
 * `bash × 5 → todo_write`. At 3 the same session produces none, which is the
 * honest answer — that session repeated habits, not workflows.
 */
const MIN_DISTINCT_STEPS = 3

/**
 * Create one per-session detector.
 *
 * @param {object} options - detector configuration.
 * @param {number} options.minRepeatCount - occurrences required to report.
 * @param {number} options.minWindow - narrowest window considered.
 * @param {number} options.repeatWindowMax - widest window considered.
 * @param {(name: string) => boolean} [options.ignoreTool] - tool names never recorded.
 * @returns {{record: (name: string) => void, detect: () => Array<object>, size: () => number, reset: () => void}} detector
 */
export function createDetector(options) {
  const minRepeatCount = options.minRepeatCount
  const minWindow = options.minWindow
  const maxWindow = options.repeatWindowMax
  const ignoreTool = options.ignoreTool ?? (() => false)
  /** @type {string[]} */
  let history = []

  /** Strip the arguments down to the bare tool name; record nothing else. */
  function record(name) {
    if (typeof name !== 'string' || name.length === 0) return
    if (ignoreTool(name)) return
    history.push(name)
    // Keep memory bounded: the widest window times a handful of repeats is
    // all the context any detection needs.
    const cap = maxWindow * (minRepeatCount + 2)
    if (history.length > cap) history = history.slice(-cap)
  }

  /**
   * Find the best-scoring repeated procedure in the current history.
   *
   * @returns {Array<object>} candidate procedures, widest first.
   */
  function detect() {
    /** @type {Array<object>} */
    const found = []
    const n = history.length
    if (n < minWindow * minRepeatCount) return found

    for (let width = Math.min(maxWindow, Math.floor(n / minRepeatCount)); width >= minWindow; width -= 1) {
      // Count non-overlapping occurrences of every width-length window.
      /** @type {Map<string, {count: number, first: number, positions: number[]}>} */
      const counts = new Map()
      for (let start = 0; start + width <= n; start += 1) {
        const key = history.slice(start, start + width).join('>')
        const entry = counts.get(key)
        if (entry === undefined) {
          counts.set(key, { count: 1, first: start, positions: [start] })
        } else {
          entry.count += 1
          entry.positions.push(start)
        }
      }

      for (const [key, entry] of counts) {
        if (entry.count < minRepeatCount) continue
        const steps = key.split('>')

        // Rule 2: a single distinct tool name is a habit, not a procedure.
        // Two is not enough either: replaying a real 487-call session showed
        // the detector spending its whole hint budget on `bash,bash,bash,
        // bash,bash,todo_write`, which is "I ran several commands and ticked
        // a box", not a workflow anyone should write down. A procedure worth
        // naming has at least three distinct actions in it.
        const distinct = new Set(steps)
        if (distinct.size < MIN_DISTINCT_STEPS) continue

        // Rule 2b: one tool dominating the window is the same habit in a
        // different shape. `bash,bash,read,bash,bash,write` has three distinct
        // tools but is still one long command session.
        const tallest = Math.max(...[...distinct].map((step) => steps.filter((each) => each === step).length))
        if (tallest > Math.floor(width / 2)) continue

        // A window that is itself a repetition of a shorter block is not a
        // wider procedure — `a,b,c,a,b,c` is the `a,b,c` procedure twice, and
        // the narrower width already reports it with the full occurrence
        // count. Skipping here keeps rule 3 from promoting it.
        if (basePeriod(steps) < steps.length) continue

        // Rule 1: non-overlapping occurrences. Walk positions in order and
        // skip any that begin before the previous accepted occurrence ended.
        let accepted = 0
        let cursor = -1
        /** @type {Array<[number, number]>} */
        const spans = []
        for (const position of entry.positions) {
          if (position <= cursor) continue
          accepted += 1
          spans.push([position, position + width - 1])
          cursor = position + width - 1
        }
        if (accepted < minRepeatCount) continue

        found.push({
          steps,
          width,
          occurrences: accepted,
          spans,
          /** Total tool calls this procedure accounts for. */
          coverage: accepted * width,
          /** Share of the observed calls that are pure observation. */
          observerRatio: steps.filter((step) => OBSERVER_TOOLS.has(step)).length / width,
          signature: key
        })
      }
    }

    // Rank by how much of the call stream the procedure explains, not by raw
    // width: a 5-wide slice of a 3-periodic stream covers less than the 3-wide
    // procedure it was cut from, and must not outrank it. Ranking happens
    // BEFORE the pruning below, because which window is "the" procedure
    // depends on this order.
    // Prune narrowest-first, then keep only procedures that occupy *different*
    // parts of the call stream.
    //
    // Signature comparison alone is not enough, which a real trace made
    // obvious: a period-3 stream also yields a width-5 window, and a
    // `bash,read,edit,bash` cycle yields a width-3 window plus a width-4
    // rotation that shares no signature with it. Both are the same habit seen
    // through a different lens, and hinting both means the model is told about
    // one workflow twice within a few steps and learns to ignore the channel.
    //
    // Spans are the ground truth for that: two procedures covering mostly the
    // same tool calls are one procedure.
    // Rank by how often the shape recurred first, then by how much of the
    // session it explains. Frequency must lead: a period-3 cycle seen three
    // times and a width-5 window straddling it seen twice are the same habit,
    // and coverage alone prefers the straddling window whenever its two
    // occurrences happen to cover more calls than the three short ones.
    found.sort((a, b) => b.occurrences - a.occurrences || b.coverage - a.coverage || b.width - a.width)
    /** @type {Array<object>} */
    const pruned = []
    for (const candidate of found) {
      const redundant = pruned.some((kept) => {
        // Same cycle, longer lens: `a,b,c,a,b` is not a second procedure.
        if (isCycleSlice(candidate.steps, kept.steps)) return true
        if (isCycleSlice(kept.steps, candidate.steps)) return true
        // Different shape that sits on the same calls, without explaining more
        // of the session than the procedure already reported. If it DID explain
        // more it would have been ranked first, so reaching here means it is
        // the narrower view of something already covered.
        return spansOverlap(candidate.spans, kept.spans) && candidate.coverage <= kept.coverage
      })
      if (redundant) continue
      pruned.push(candidate)
      if (pruned.length >= 3) break
    }
    return pruned
  }

  return {
    record,
    detect,
    size: () => history.length,
    reset: () => {
      history = []
    }
  }
}

/**
 * Smallest period of a step sequence, or its length when it has none.
 *
 * `['a','b','c','a','b','c']` has period 3. A window whose period is shorter
 * than itself carries no information the narrower window does not already
 * carry, and promoting it would inflate both its width and its priority.
 *
 * @param {string[]} steps - tool names.
 * @returns {number} the smallest repeat period, or `steps.length`.
 */
export function basePeriod(steps) {
  for (let period = 1; period < steps.length; period += 1) {
    if (steps.length % period !== 0) continue
    let periodic = true
    for (let index = period; index < steps.length; index += 1) {
      if (steps[index] !== steps[index % period]) {
        periodic = false
        break
      }
    }
    if (periodic) return period
  }
  return steps.length
}

/**
 * Decide whether `candidate` is a slice of the cyclic stream `kept`.
 *
 * A periodic stream produces many windows that are just offsets into the same
 * cycle. Keeping them as separate procedures would report `a,b,c` and
 * `b,c,a` as two different workflows, which is exactly the fragmentation the
 * widest-match rule is meant to prevent.
 *
 * @param {string[]} candidate - the narrower window.
 * @param {string[]} kept - the already-accepted procedure.
 * @returns {boolean} true when the candidate carries no new information.
 */
/**
 * Whether two procedures mostly cover the same tool calls.
 *
 * Two windows are "the same procedure" when more than half of the narrower
 * one's calls already belong to the other. This catches the cases signature
 * comparison cannot: a longer window whose occurrences sit on top of a shorter
 * cycle, and rotations that share steps without being equal.
 *
 * @param {Array<[number, number]>} a - spans of the first procedure.
 * @param {Array<[number, number]>} b - spans of the second procedure.
 * @returns {boolean} true when they overlap substantially.
 */
export function spansOverlap(a, b) {
  let shared = 0
  for (const [startA, endA] of a) {
    for (const [startB, endB] of b) {
      shared += Math.max(0, Math.min(endA, endB) - Math.max(startA, startB) + 1)
    }
  }
  const narrower = Math.min(
    a.reduce((sum, [start, end]) => sum + (end - start + 1), 0),
    b.reduce((sum, [start, end]) => sum + (end - start + 1), 0)
  )
  return narrower > 0 && shared * 2 > narrower
}

export function isCycleSlice(candidate, kept) {
  if (kept.length === 0) return false
  // A window that equals a rotation of the kept cycle — including a longer
  // window that is the kept cycle plus a prefix of itself — adds nothing.
  return kept.some((_, offset) =>
    candidate.every((step, index) => step === kept[(offset + index) % kept.length])
  )
}

/**
 * Render a detected procedure as a compact human-readable arrow chain.
 *
 * @param {string[]} steps - tool names in call order.
 * @returns {string} e.g. `bash → read → edit`. 
 */
export function renderSteps(steps) {
  return steps.join(' → ')
}
