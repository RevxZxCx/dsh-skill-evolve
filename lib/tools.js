/**
 * The model-facing tools: submit a candidate, list the queue, report an outcome.
 *
 * None of these tools writes a skill file. A submission lands in the candidate
 * queue and waits for a human; that is the whole point of the plugin. The one
 * exception is `mode: 'auto'`, which is opt-in and still routes through the
 * same gate — auto only decides *whether to ask first*, never *whether the
 * evidence is real*.
 *
 * Tool shapes are plain objects rather than `defineTool(...)` output because
 * `@deepseek-ai/dsh-tools` is not resolvable from the plugin's install
 * location; the host's `ctx.tools.register` accepts the plain shape, which is
 * what the installed skills-manager does too.
 *
 * @module dsh-skill-evolve/tools
 */

import { randomUUID } from 'node:crypto'
import { lanesFromEvents, normalize, runGate } from './evidence.js'
import { listOwnedSkills, readSkillFile, readState, renderSkillFile, SKILL_FILE, SKILL_NAME } from './skillfile.js'
import { confidence, stateToFrontmatter } from './lifecycle.js'
import { annotateQueue, describeStale, digest, findByName, isLive } from './candidates.js'
import { join } from 'node:path'
import { renderResults, searchSkills } from './search.js'

/** Maximum body size accepted from the model, in characters. */
const MAX_BODY_CHARS = 24_000

/** Maximum description size; it rides in the system prompt, so it is expensive. */
const MAX_DESCRIPTION_CHARS = 280

/**
 * Build the `parameters` schema shared by the submit tool.
 *
 * @returns {object} JSON schema.
 */
function submitParameters() {
  return {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Kebab-case skill name, e.g. "scanned-pdf-table-extraction". Must match [a-z0-9]+(-[a-z0-9]+)*.'
      },
      description: {
        type: 'string',
        description: `One sentence describing WHEN to use this skill. Under ${MAX_DESCRIPTION_CHARS} characters; this text is what future sessions see in the skill catalog.`
      },
      whenToUse: {
        type: 'string',
        description: 'Optional extra routing hint, e.g. "when the PDF has no text layer".'
      },
      body: {
        type: 'string',
        description: 'The instructions, in markdown. Lead with the procedure and name the dead ends explicitly. Under 24000 characters.'
      },
      final: {
        type: 'boolean',
        description: 'Set this when writing the final version of a candidate a human already approved. It writes the skill instead of queueing it again, and requires the candidate to be in the approved state.'
      },
      evidence: {
        type: 'array',
        description: 'At least one quote copied verbatim from this session. Quotes are checked against the transcript; an invented quote is rejected.',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            class: {
              type: 'string',
              enum: ['user', 'tool', 'action', 'self'],
              description: 'user = the human said it; tool = a machine observation; action = a tool that was actually called; self = your own judgement.'
            },
            quote: {
              type: 'string',
              description: 'Exact text from this session. At least 12 characters, copied character for character.'
            },
            note: {
              type: 'string',
              description: 'Optional: what this quote establishes.'
            }
          },
          required: ['class', 'quote'],
          additionalProperties: false
        }
      }
    },
    required: ['name', 'description', 'body', 'evidence'],
    additionalProperties: false
  }
}

/**
 * Turn a gate outcome into the sentence the model reads when it fails.
 *
 * The failure message has to be actionable: naming which quote did not survive
 * is the difference between the model retrying with real text and the model
 * retrying with different invented text.
 *
 * @param {object} gate - the gate result.
 * @returns {string} a human-readable explanation.
 */
function describeGate(gate) {
  const lines = [
    `Evidence gate rejected the submission: none of the ${gate.dropped.length} quote(s) could be found in this session.`,
    ''
  ]
  for (const dropped of gate.dropped.slice(0, 5)) {
    lines.push(`- "${dropped.quote}" — ${dropped.reason}`)
  }
  lines.push(
    '',
    'Quotes must be copied character for character from this conversation. Do not paraphrase, do not',
    'reconstruct from memory, and do not quote text you wrote yourself as if the user had said it.'
  )
  return lines.join('\n')
}

/**
 * Build the tool definitions.
 *
 * @param {object} deps - collaborators.
 * @param {object} deps.config - resolved plugin configuration.
 * @param {import('./store.js').Store} deps.store - persistent state.
 * @param {(agent: any) => Iterable<object>} deps.eventsFor - session events for an agent.
 * @param {(agent: any) => string} deps.sessionIdFor - the session id for an agent.
 * @param {(agent: any) => string} deps.workspaceFor - workspace root for an agent.
 * @param {(parts?: any[]) => string} [deps.cwdFor] - current working directory.
 * @param {(name: string) => any} [deps.service] - resolve an optional host service.
 * @param {(...parts: any[]) => void} [deps.log] - logger sink.
 * @returns {Array<object>} tool definitions for `ctx.tools.register`.
 */
export function createTools(deps) {
  const log = deps.log ?? (() => {})
  const service = deps.service ?? (() => undefined)

  /**
   * Resolve the skill root for the agent making the request.
   *
   * @param {any} agent - the calling agent.
   * @returns {string} absolute skill root.
   */
  function rootFor(agent) {
    return deps.skillRootFor(agent)
  }

  const submit = {
    name: 'skill_candidate_submit',
    description:
      'Propose a reusable skill distilled from THIS conversation. The submission is checked for real evidence and then queued for human approval; it does not write anything yet. Use it when you found a procedure worth repeating, especially when you hit a dead end and then found the working path. Do not use it for one-off answers, and do not propose a skill that duplicates one already in the catalog.',
    parameters: submitParameters(),
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value && value.ok === false) {
          return [{ type: 'text', text: `Candidate rejected (${value.code}).\n\n${value.error}` }]
        }
        const where = value.autoWritten ? 'written to' : 'queued for approval at'
        return [{
          type: 'text',
          text: [
            `Candidate "${value.name}" ${where} ${value.path}.`,
            `${value.survived} evidence quote(s) verified.`,
            value.autoWritten
              ? 'It is now discoverable by future sessions.'
              : 'Nothing is loadable until a human approves it. Tell the user it is waiting, and do not describe it as saved.'
          ].join(' ')
        }]
      }
    },
    async execute(args, exec) {
      const agent = exec?.agent
      const name = String(args?.name ?? '').trim()
      const description = String(args?.description ?? '').trim()
      const body = String(args?.body ?? '').trim()

      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        return { ok: false, code: 'bad-name', error: `"${name}" is not a valid skill name. Use kebab-case: lowercase letters, digits and single hyphens, e.g. "scanned-pdf-table-extraction".` }
      }
      if (description.length === 0) {
        return { ok: false, code: 'no-description', error: 'A description is required: it is the text future sessions use to decide whether to load this skill.' }
      }
      if (description.length > MAX_DESCRIPTION_CHARS) {
        return { ok: false, code: 'long-description', error: `The description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_CHARS}. One sentence is enough.` }
      }
      if (body.length === 0) {
        return { ok: false, code: 'no-body', error: 'A body is required: the procedure itself.' }
      }
      if (body.length > MAX_BODY_CHARS) {
        return { ok: false, code: 'long-body', error: `The body is ${body.length} characters; the limit is ${MAX_BODY_CHARS}. Generalise instead of transcribing the whole session.` }
      }
      if (!Array.isArray(args?.evidence) || args.evidence.length === 0) {
        return { ok: false, code: 'no-evidence', error: 'At least one evidence quote is required. Copy a sentence verbatim from this conversation that shows the procedure worked, or that a dead end was real.' }
      }

      const events = deps.eventsFor(agent)
      // Lanes, not a flat corpus: the model authors tool arguments and its own
      // reasoning, so a merged corpus lets it cite itself under any label.
      const gate = runGate({ evidence: args.evidence, lanes: lanesFromEvents(events) })
      if (gate.survived.length === 0) {
        return { ok: false, code: 'no-verified-evidence', error: describeGate(gate) }
      }
      if (!gate.authoritative) {
        return {
          ok: false,
          code: 'self-only-evidence',
          error: [
            'Every surviving quote came from your own narration. A skill is authoritative for future sessions,',
            'so it needs at least one quote the user said, or one machine observation that shows a command really',
            'ran and what it printed. Cite the user\'s words or a tool result.'
          ].join(' ')
        }
      }

      const sessionId = deps.sessionIdFor(agent)
      const root = rootFor(agent)
      // A final write is the second half of a two-step approval: a person has
      // already said yes to this draft, and the model had one more step to
      // re-read it against the catalog. It still goes through the gate above —
      // approval is permission to write this draft, not to write anything.
      if (args?.final === true) {
        const written = await deps.finalize({ name, description, body, whenToUse: typeof args?.whenToUse === 'string' ? args.whenToUse : undefined, evidence: gate.survived, agent })
        if (written?.ok === false) return { ok: false, code: written.code ?? 'finalize-failed', error: written.error }
        return { ok: true, name, path: written.path, kind: written.kind, survived: gate.survived.length, autoWritten: true, final: true }
      }


      // Collision check against the live catalog, not just this plugin's queue.
      // Two very different situations hide behind "the name exists":
      //
      // - Somebody else owns it (hand-written, another plugin, a marketplace
      //   install). Shadowing it would silently change what future sessions
      //   load, so this is a hard refusal.
      // - This plugin owns it. That is not a collision, it is a revision: the
      //   first version was written in a session that did not know what this
      //   one knows. Refusing it is how a catalog fills up with skills whose
      //   first draft is all anybody ever got.
      const existing = await findExistingSkill(root, name)
      if (existing !== undefined && !existing.owned) {
        return {
          ok: false,
          code: 'exists',
          error: `A skill named "${name}" already exists and was NOT written by this plugin (${existing.path}). This plugin never rewrites a skill it does not own. Choose a different name.`
        }
      }

      const revision = existing === undefined
        ? undefined
        : { path: existing.path, digest: digest(existing.body ?? ''), stage: existing.stage, uses: existing.uses, created: existing.created }

      const now = new Date().toISOString()
      const record = {
        id: randomUUID(),
        name,
        kind: revision === undefined ? 'create' : 'update',
        description,
        whenToUse: typeof args?.whenToUse === 'string' && args.whenToUse.trim().length > 0 ? args.whenToUse.trim() : undefined,
        body,
        evidence: gate.survived,
        droppedEvidence: gate.dropped,
        sessionId,
        workspace: deps.workspaceFor(agent),
        createdAt: now,
        source: 'model'
      }
      if (revision !== undefined) {
        // Record what the revision was written against. If that base moves or
        // disappears before somebody approves, the revision is stale and must
        // be regenerated: applying it blind would silently revert whoever
        // edited the file in between.
        record.base = revision
      }

      if (deps.config.mode === 'auto') {
        const state = revision === undefined
          ? {
              id: record.id,
              stage: 'unverified',
              created: now,
              uses: 0,
              helpful: 0,
              harmful: 0,
              validated: now,
              evidence: gate.survived.map((entry) => entry.quote).join(' | ').slice(0, 500)
            }
          // A revision keeps the lifecycle record. Resetting uses and harmful
          // counts on every edit would erase exactly the evidence that says
          // whether the skill is worth keeping.
          : {
              stage: revision.stage ?? 'unverified',
              uses: Number(revision.uses ?? 0),
              created: revision.created ?? now,
              validated: now
            }
        const path = join(root, name, SKILL_FILE)
        await deps.writeSkill({ path, name, description: record.description, body: record.body, whenToUse: record.whenToUse, state: stateToFrontmatter(state) })
        await deps.store.record({ at: now, actor: 'agent', action: revision === undefined ? 'create' : 'revise', skill: name, sessionId, evidence: record.evidence.length })
        log(`tools: auto-wrote ${name} (${gate.survived.length} quotes, ${record.kind})`)
        return { ok: true, name, path, survived: gate.survived.length, autoWritten: true, kind: record.kind }
      }

      // Duplicate detection and the append happen under one lock. Doing the
      // check against a snapshot and appending afterwards lets two sessions
      // submit the same name in between, leaving the queue with two live
      // entries for one skill — one of which silently loses on approval.
      const appended = await deps.store.mutateCandidates(async (queue) => {
        // A stale candidate with this name must not block a fresh submission:
        // the whole reason it went stale is that it no longer describes reality.
        const blocking = queue.find((entry) => entry.name === name && isLive(entry))
        if (blocking !== undefined) {
          return {
            result: {
              ok: false,
              code: 'already-pending',
              error: `"${name}" is already waiting for approval${blocking.kind === 'update' ? ' as a revision' : ''}. Use skill_candidate_list to review the queue instead of submitting it twice.`
            }
          }
        }
        const live = queue.filter((entry) => isLive(entry)).length
        if (live >= deps.config.maxCandidates) {
          return {
            result: {
              ok: false,
              code: 'queue-full',
              error: `The candidate queue already holds ${live} live entries, which is the configured maximum. Ask the user to review it with /skill-review before adding more.`
            }
          }
        }
        return { candidates: [...queue, record], result: { ok: true } }
      })
      if (appended.ok === false) return appended

      await deps.store.record({ at: now, actor: 'agent', action: revision === undefined ? 'propose' : 'propose-revision', skill: name, sessionId, evidence: record.evidence.length })
      log(`tools: queued candidate ${name} (${gate.survived.length} quotes, ${record.kind})`)
      return {
        ok: true,
        name,
        kind: record.kind,
        // The queue is one JSON array, not a directory of per-name files.
        // Reporting a path that does not exist teaches the model to cite a
        // file it can never open.
        path: deps.store.candidatesPath,
        survived: gate.survived.length,
        autoWritten: false
      }
    },
    presentCall(args) {
      return { card: 'generic', title: 'Propose skill', kind: 'edit', rawInput: args?.name ? String(args.name) : undefined }
    }
  }

  const list = {
    name: 'skill_candidate_list',
    description: 'List skill candidates waiting for approval, plus the skills this plugin already manages and their health. Use it before submitting a candidate, to avoid proposing something that already exists.',
    parameters: {
      type: 'object',
      properties: {
        includeManaged: {
          type: 'boolean',
          description: 'Also list skills already written and managed by this plugin. Defaults to true.'
        }
      },
      additionalProperties: false
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: value?.text ?? 'No skills.' }]
      }
    },
    async execute(args, exec) {
      const agent = exec?.agent
      const lines = []
      const candidates = await deps.loadQueue()
      const live = candidates.filter((entry) => isLive(entry))
      const stalled = candidates.filter((entry) => !isLive(entry))
      if (live.length === 0) {
        lines.push('No candidates are waiting for approval.')
      } else {
        lines.push(`${live.length} candidate(s) waiting for approval:`)
        for (const candidate of live) {
          const kind = candidate.kind === 'update' ? 'revision' : 'new'
          const state = candidate.awaitingFinal === true ? ', APPROVED and awaiting its final write' : ''
          lines.push(`- ${candidate.name} — ${candidate.description} (${kind}, ${candidate.evidence.length} quote(s), proposed ${candidate.createdAt}${state})`)
        }
      }
      // Stale entries stay visible: they hold the evidence that was collected and
      // the body somebody proposed. Hiding them would make the queue look clean
      // while quietly throwing away work.
      if (stalled.length > 0) {
        lines.push('', `${stalled.length} stale candidate(s) — readable, not approvable:`)
        for (const candidate of stalled) {
          lines.push(`- ${candidate.name} — ${describeStale(candidate.stale)}; resubmit it to refresh`)
        }
      }
      if (args?.includeManaged !== false) {
        const managed = await listOwnedSkills(rootFor(agent))
        if (managed.length === 0) {
          lines.push('', 'No skills are managed by this plugin yet.')
        } else {
          const registry = await deps.store.loadRegistry()
          lines.push('', `${managed.length} managed skill(s):`)
          for (const skill of managed) {
            const parsed = await readSkillFile(skill.path).catch(() => undefined)
            const state = parsed === undefined ? {} : (registry[skill.name] ?? {})
            const stage = state.stage ?? parsed?.data?.['evolved-stage'] ?? 'unverified'
            const uses = Number(state.uses ?? parsed?.data?.['evolved-uses'] ?? 0)
            const harmful = Number(state.harmful ?? parsed?.data?.['evolved-harmful'] ?? 0)
            lines.push(`- ${skill.name} — ${stage}, ${uses} use(s), ${harmful} harmful, confidence ${confidence(state).toFixed(1)}`)
          }
        }
      }
      return { text: lines.join('\n') }
    }
  }

  const feedback = {
    name: 'skill_feedback',
    description: 'Record whether a skill this plugin manages actually helped or hurt, after you used it. Harmful reports weigh four times a helpful one and eventually invert the skill into a warning, so report honestly.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name.' },
        verdict: { type: 'string', enum: ['helpful', 'harmful'], description: 'Did following this skill help or hurt?' },
        note: { type: 'string', description: 'Optional short reason, used when a harmful skill is turned into a warning.' }
      },
      required: ['name', 'verdict'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value && value.ok === false) return [{ type: 'text', text: `Could not record feedback: ${value.error}` }]
        return [{ type: 'text', text: `Recorded "${value.verdict}" for ${value.name}. Stage is now ${value.stage}.` }]
      }
    },
    async execute(args, exec) {
      const agent = exec?.agent
      const name = String(args?.name ?? '').trim()
      const verdict = args?.verdict
      if (verdict !== 'helpful' && verdict !== 'harmful') {
        return { ok: false, error: 'verdict must be "helpful" or "harmful"' }
      }
      // The name becomes a path segment. Without this the model could report
      // feedback for `../../AGENTS` and the plugin would happily read a file
      // outside the skill root and treat its frontmatter as a skill record.
      if (!SKILL_NAME.test(name)) {
        return { ok: false, error: `"${name}" is not a valid skill name (lowercase letters, digits and single dashes)` }
      }
      const root = rootFor(agent)
      const path = join(root, name, SKILL_FILE)
      const parsed = await readSkillFile(path).catch(() => undefined)
      if (parsed === undefined) {
        return { ok: false, error: `no skill named "${name}" exists under ${root}` }
      }
      if (!parsed.owned) {
        return { ok: false, error: `"${name}" was not written by this plugin, so its record is not ours to change` }
      }
      const now = new Date().toISOString()
      // Read-modify-write under the registry lock: two feedback reports landing
      // together would otherwise both start from the same counters and the
      // second would erase the first, losing exactly the evidence the lifecycle
      // depends on.
      const next = await deps.store.mutateRegistry(async (registry) => {
        const state = registry[name] ?? {}
        const updated = {
          ...state,
          name,
          stage: state.stage ?? 'unverified',
          created: state.created ?? parsed.data['evolved-created'] ?? now,
          uses: Number(state.uses ?? 0) + (verdict === 'helpful' ? 1 : 0),
          helpful: Number(state.helpful ?? 0) + (verdict === 'helpful' ? 1 : 0),
          harmful: Number(state.harmful ?? 0) + (verdict === 'harmful' ? 1 : 0),
          validated: now,
          note: typeof args?.note === 'string' ? args.note.slice(0, 500) : state.note
        }
        registry[name] = updated
        return { registry, result: updated }
      })
      await deps.store.record({ at: now, actor: 'agent', action: verdict, skill: name })
      const decided = await deps.applyLifecycle({ name, root, parsed, state: next })
      return { ok: true, name, verdict, stage: decided.stage }
    }
  }

  const search = {
    name: 'skill_search',
    description:
      'Search the installed skill library by keyword. Use it when the catalog shows a skill name you do not recognise, when a description was truncated, or when the library is too large to read through. Returns the best matches with their full descriptions; load one with the `skill` tool before following it.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What you are trying to do, in a few words. Matched against skill names, descriptions, whenToUse, and bodies.'
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return. Defaults to 5.'
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value && value.ok === false) return [{ type: 'text', text: value.error }]
        return [{ type: 'text', text: value.text }]
      }
    },
    async execute(args, exec) {
      const agent = exec?.agent
      const query = String(args?.query ?? '').trim()
      if (query.length === 0) return { ok: false, error: 'Give a query to search for.' }

      const skills = service('skills')
      if (skills === undefined) {
        // Not fatal, and worth saying plainly: without the host's catalog this
        // tool would have to guess at provider shadowing, and a search that
        // disagrees with what `skill` can load is worse than no search.
        return { ok: false, error: 'The host does not expose a skill catalog, so there is nothing to search.' }
      }

      let outcome
      try {
        outcome = await searchSkills({
          skills,
          query,
          limit: args?.limit,
          options: { scope: agent, cwd: deps.workspaceFor(agent) }
        })
      } catch (error) {
        return { ok: false, error: `Search failed: ${error instanceof Error ? error.message : String(error)}` }
      }

      log('skill_search', { query, results: outcome.results.length, total: outcome.total })
      return { ok: true, text: renderResults(outcome), results: outcome.results }
    }
  }

  return [submit, list, feedback, search]
}

/**
 * Find an existing skill directory with this name, whoever wrote it.
 *
 * @param {string} root - the skill root.
 * @param {string} name - the proposed skill name.
 * @returns {Promise<{owned: boolean, path: string} | undefined>} the collision.
 */
async function findExistingSkill(root, name) {
  const path = join(root, name, SKILL_FILE)
  try {
    const parsed = await readSkillFile(path)
    const state = readState(parsed.data)
    return {
      owned: parsed.owned,
      path,
      // A revision needs the exact text it was written against, so it can
      // notice that somebody edited the file in between.
      body: parsed.body,
      stage: state.stage,
      uses: state.uses,
      created: state.created
    }
  } catch {
    return undefined
  }
}


/**
 * Export the normalization helper so the index can reuse the same comparison.
 */
export { normalize, renderSkillFile, stateToFrontmatter }
