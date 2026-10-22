/**
 * Slash commands: the human's side of the loop.
 *
 * The plugin's whole claim is that a skill is authoritative only after a
 * person has looked at it. These four commands are that look:
 *
 * - `/skill-review` — see the queue and approve or discard.
 * - `/skill-capture` — approve, preview, or discard one candidate.
 *
 * Approval is a two-step handshake by default: the approval is recorded here,
 * and the model writes the final body on its next step (`approvalMode:
 * 'confirm'`). Set `approvalMode: 'direct'` to write the queued body at once.
 * - `/skill-feedback` — record that a skill helped or hurt.
 * - `/skill-stats` — see the health of the whole catalog.
 *
 * The host's contract is narrow and unforgiving: a handler receives a frozen
 * invocation `{commandId, agent, rawInput, attachments, signal}` and must
 * return `{kind: 'success', text}` or `{kind: 'error', text}`. Returning a
 * bare string throws `handler must return a CommandResult`, so every branch
 * below is wrapped.
 *
 * @module dsh-skill-evolve/commands
 */

import { describeStale } from './candidates.js'

/**
 * Truncate text on a word boundary.
 *
 * @param {string} text - the text.
 * @param {number} limit - maximum characters.
 * @returns {string} possibly shortened text.
 */
function clamp(text, limit) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length <= limit) return trimmed
  const slice = trimmed.slice(0, limit)
  const cut = slice.lastIndexOf(' ')
  return `${cut > limit * 0.6 ? slice.slice(0, cut) : slice}…`
}

/**
 * Wrap a body so that every outcome is a valid `CommandResult`.
 *
 * @param {(invocation: object) => Promise<string>} body - the handler body.
 * @returns {(invocation: object) => Promise<{kind: string, text: string}>} a host-compatible handler.
 */
function command(body) {
  return async (invocation) => {
    try {
      return { kind: 'success', text: await body(invocation ?? {}) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `skill-evolve: ${message}` }
    }
  }
}

/**
 * Split a raw command line into a name and flags.
 *
 * @param {unknown} rawInput - the text after the command name.
 * @returns {{name: string | undefined, flags: Set<string>, rest: string[]}} parsed tokens.
 */
function parseArgs(rawInput) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter((token) => token.length > 0)
  const flags = new Set(tokens.filter((token) => token.startsWith('--')))
  const bare = tokens.filter((token) => !token.startsWith('--'))
  return { name: bare[0], flags, rest: bare.slice(1) }
}

/**
 * Build the command definitions.
 *
 * @param {object} deps - collaborators.
 * @param {import('./store.js').Store} deps.store - persistent state.
 * @param {() => Promise<Array<object>>} deps.loadQueue - the annotated candidate queue.
 * @param {(input: object) => Promise<object>} deps.approve - approval workflow.
 * @param {(name: string, verdict: string, note?: string) => Promise<object>} deps.feedback - feedback workflow.
 * @param {() => Promise<Array<object>>} deps.stats - catalog statistics.
 * @param {(...parts: any[]) => void} [deps.log] - logger sink.
 * @returns {Array<object>} command definitions for `ctx.commands.register`.
 */
export function createCommands(deps) {
  const review = {
    name: 'skill-review',
    description: 'List the skill candidates waiting for approval, with their evidence.',
    handler: command(async () => {
      const candidates = await deps.loadQueue()
      if (candidates.length === 0) return 'No skill candidates are waiting for approval.'
      const live = candidates.filter((entry) => entry.stale === undefined)
      const stalled = candidates.filter((entry) => entry.stale !== undefined)
      const lines = []
      if (live.length > 0) {
        lines.push(`${live.length} candidate(s) waiting:`, '')
        for (const [index, candidate] of live.entries()) {
          const kind = candidate.kind === 'update' ? 'revision of an existing skill' : 'new skill'
          lines.push(`${index + 1}. ${candidate.name}  — ${kind}`)
          lines.push(`   ${clamp(candidate.description, 160)}`)
          lines.push(`   ${candidate.evidence.length} verified quote(s) · proposed ${candidate.createdAt}`)
          if (candidate.awaitingFinal === true) lines.push('   APPROVED — waiting for the model to write the final version')
          const first = candidate.evidence[0]
          if (first !== undefined) lines.push(`   evidence [${first.class}]: "${clamp(first.quote, 140)}"`)
          lines.push('')
        }
      } else {
        lines.push('Nothing is waiting for approval.', '')
      }
      if (stalled.length > 0) {
        lines.push(`${stalled.length} stale candidate(s) — readable, not approvable:`)
        for (const candidate of stalled) {
          lines.push(`  ${candidate.name} — ${describeStale(candidate.stale)}`)
        }
        lines.push('')
      }
      lines.push('Full body: `/skill-capture <name> --preview`')
      lines.push('Approve:    `/skill-capture <name>`')
      lines.push('Discard:    `/skill-capture <name> --discard`')
      return lines.join('\n')
    })
  }

  const capture = {
    name: 'skill-capture',
    description: 'Approve a waiting skill candidate. Use --preview to read it first, --discard to drop it.',
    input: { hint: '<name> [--preview|--discard]', attachments: false },
    handler: command(async (invocation) => {
      const { name, flags } = parseArgs(invocation.rawInput)
      if (name === undefined) return 'Usage: /skill-capture <name> [--preview|--discard]'
      const candidates = await deps.loadQueue()
      const candidate = candidates.find((entry) => entry.name === name)
      if (candidate === undefined) {
        const available = candidates.map((entry) => entry.name).join(', ')
        return `No candidate named "${name}".${available.length > 0 ? ` Waiting: ${available}` : ' The queue is empty. Use /skill-review to see it.'}`
      }
      if (flags.has('--preview')) {
        const lines = [
          candidate.name,
          `description: ${candidate.description}`
        ]
        if (candidate.whenToUse !== undefined) lines.push(`when to use: ${candidate.whenToUse}`)
        if (candidate.kind === 'update') lines.push('kind: revision of an existing skill (its use counts are preserved)')
        if (candidate.stale !== undefined) lines.push(`STALE: ${describeStale(candidate.stale)}`)
        lines.push('', candidate.body, '', `evidence (${candidate.evidence.length}):`)
        for (const entry of candidate.evidence) lines.push(`  [${entry.class}] "${clamp(entry.quote, 200)}"`)
        return lines.join('\n')
      }
      if (flags.has('--discard')) {
        await deps.store.saveCandidates(candidates.filter((entry) => entry.id !== candidate.id))
        await deps.store.record({ at: new Date().toISOString(), actor: 'user', action: 'discard', skill: name })
        deps.log?.(`commands: discarded ${name}`)
        return `Discarded "${name}". Nothing was written to the skill directory.`
      }
      if (candidate.stale !== undefined) {
        return `"${name}" is ${describeStale(candidate.stale)} and cannot be approved. Discard it with \`/skill-capture ${name} --discard\`, or wait for the model to resubmit it.`
      }
      const result = await deps.approve({ candidate, agent: invocation.agent })
      if (result?.ok === false) return Promise.reject(new Error(`cannot approve "${name}": ${result.error}`))
      if (result?.staged === true) {
        return [
          `Approved "${name}".`,
          '',
          'The model writes the final version on its next step, so it can re-read the',
          'current catalog first and avoid duplicating a skill that appeared since',
          'this draft was proposed. Nothing is in the skill directory yet — this',
          'matches `/skill-capture --preview` at that point, not before.'
        ].join('\n')
      }
      return `Approved "${name}" and wrote ${result.path}.
The next step sees it in the skill catalog; no restart needed.`
    })
  }

  const feedback = {
    name: 'skill-feedback',
    description: 'Record whether a managed skill helped or hurt.',
    input: { hint: '<name> <helpful|harmful> [note]', attachments: false },
    handler: command(async (invocation) => {
      const { name, rest } = parseArgs(invocation.rawInput)
      const verdict = rest[0]
      if (name === undefined || (verdict !== 'helpful' && verdict !== 'harmful')) {
        return 'Usage: /skill-feedback <name> <helpful|harmful> [note]'
      }
      const result = await deps.feedback(name, verdict, rest.slice(1).join(' '))
      return `Recorded "${verdict}" for ${name}. Stage is now ${result.stage}.`
    })
  }

  const stats = {
    name: 'skill-stats',
    description: 'Show the health of every skill this plugin manages.',
    handler: command(async () => {
      const rows = await deps.stats()
      if (rows.length === 0) return 'No skills are managed by this plugin yet.'
      const lines = ['skill                          stage         uses  harmful  confidence']
      for (const row of rows) {
        lines.push(
          `${String(row.name).padEnd(30).slice(0, 30)} ${String(row.stage).padEnd(13).slice(0, 13)} ${String(row.uses).padStart(4)}  ${String(row.harmful).padStart(7)}  ${row.confidence.toFixed(2).padStart(10)}`
        )
      }
      lines.push('')
      lines.push('stale    = nobody confirmed it for a while; reported, never deleted')
      lines.push('inverted = carries a PITFALL warning; read it as things to avoid')
      return lines.join('\n')
    })
  }

  return [review, capture, feedback, stats]
}
