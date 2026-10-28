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
import { describeStale, digest, isLive } from './candidates.js'
import { join } from 'node:path'
import { renderResults, searchSkills } from './search.js'
import {
  installMarketSkill,
  isValidMarketId,
  listInstalled,
  previewMarketSkill,
  renderPreview as renderMarketPreview,
  renderSearch as renderMarketSearch,
  searchMarket
} from './market.js'

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
        description: 'Required when proposing a skill; leave it out when writing an approved one with `final: true`. At least one quote copied verbatim from the session that produced the skill. Quotes are checked against that transcript at submission time; an invented quote is rejected. A final write reuses the quotes already stored on the candidate, so restating them is not needed and not checked.',
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
    // `evidence` is deliberately not required at the schema level: the final
    // write of an approved candidate has nothing to quote. The propose path
    // enforces it in code, where the failure message can tell the model what a
    // usable quote looks like.
    required: ['name', 'description', 'body'],
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

      // `mode: 'off'` is documented as "no detection at all: no hints, no
      // submissions, no writes". Only the two detectors checked it, so a model
      // that called this tool directly (or replayed a hint from an earlier
      // session) could still propose a candidate while the user believed the
      // plugin was dormant. The tools stay registered on purpose, so the guard
      // is here rather than at registration: an existing queue must still be
      // reviewable and approvable, and approving is what `final` does.
      if (deps.config.mode === 'off' && args?.final !== true) {
        return {
          ok: false,
          code: 'mode-off',
          error: 'This plugin is configured with mode "off", so it does not accept new skill candidates. Detection, proposals and writes are all disabled. Only a candidate that is already queued can still be approved. The user can re-enable it by changing `mode` in the plugin settings.'
        }
      }

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
      // Evidence is required to *propose*, not to finalise. The final call is the
      // second half of an approval for a candidate that already carries its
      // verified quotes; demanding them again would ask the model to restate
      // evidence it cannot restate — those quotes belong to the session that
      // produced them, and the approving session is a different one. The gate
      // below therefore only runs on the propose path.
      if (args?.final !== true && (!Array.isArray(args?.evidence) || args.evidence.length === 0)) {
        return { ok: false, code: 'no-evidence', error: 'At least one evidence quote is required. Copy a sentence verbatim from this conversation that shows the procedure worked, or that a dead end was real.' }
      }

      const sessionId = deps.sessionIdFor(agent)
      const root = rootFor(agent)
      // A final write is the second half of a two-step approval: a person has
      // already said yes to this draft, and the model had one more step to
      // re-read it against the catalog.
      //
      // The gate is deliberately NOT re-run here. Its job is to establish that
      // the evidence was real in the session the skill was distilled from, and
      // that is a fact about the past: re-checking it against whichever session
      // happens to be approving asks a question with no bearing on the answer,
      // and rejects every candidate approved from a later session because those
      // quotes were never spoken in it. Submission is where evidence is
      // verified; the queue carries the result forward.
      if (args?.final === true) {
        // Normalise `whenToUse` the way the propose branch does, so whitespace
        // alone cannot make an unchanged draft digest differently and be sent
        // back as "changed since approval".
        //
        // A blank string stays a blank string rather than becoming `undefined`:
        // during finalisation `undefined` means "carry the approved value
        // forward", so folding an explicit clear into it would report success
        // while writing the old hint back. `contentDigest` hashes `''` and
        // `undefined` alike, so the two cases still agree with the approval.
        const whenToUse = typeof args?.whenToUse === 'string' ? args.whenToUse.trim() : undefined
        const written = await deps.finalize({ name, description, body, whenToUse, agent })
        if (written?.ok === false) return { ok: false, code: written.code ?? 'finalize-failed', error: written.error }
        return { ok: true, name, path: written.path, kind: written.kind, survived: written.survived, autoWritten: true, final: true }
      }

      // Verification belongs to submission, not to approval: a candidate is
      // evidence-checked once, in the session that produced it.
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
        : {
            path: existing.path,
            digest: digest(existing.body ?? ''),
            stage: existing.stage,
            uses: existing.uses,
            created: existing.created,
            // The lifecycle counters and the identity travel with the revision.
            // Leaving them out does not fail loudly: each one falls back to a
            // default in `stateToFrontmatter`, and the file it writes is what the
            // registry is rebuilt from on the next load. In `mode: 'auto'` every
            // edit takes this branch, so an omission resets the record of whether
            // the skill is worth keeping, permanently and silently.
            helpful: existing.helpful,
            harmful: existing.harmful,
            id: existing.id,
            evidence: existing.evidence
          }

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
        verifiedAt: now,
        verifiedInSession: sessionId,
        // Record where and when the gate actually ran. The approval path cannot
        // re-run it (see the comment above), so this line is the only durable
        // answer to "was this evidence ever checked, and against what" — and a
        // human reading the queue can see which session to go and look in.
        workspace: deps.workspaceFor(agent),
        createdAt: now,
        source: 'model'
      }
      if (revision !== undefined) {
        // Record what the revision was written against. If that base moves or
        // disappears before somebody approves, the revision is stale and must
        // be regenerated: applying it blind would silently revert whoever
        // edited the file in between.
        //
        // The whole record travels, not just `digest`. `writeApprovedWithin`
        // rebuilds the lifecycle state from `candidate.base` when the registry
        // row is thinner than the file (see `lib/index.js:1622`), so trimming
        // this object to the fields the staleness check reads would make an
        // approved revision silently reset `uses`/`helpful`/`stage`.
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
          // whether the skill is worth keeping - and in auto mode every
          // revision takes this branch, so the loss would be silent and
          // permanent rather than a one-off.
          //
          // The identity fields matter as much as the counters: this object is
          // what reaches stateToFrontmatter, and the written file is what the
          // registry is rebuilt from on the next load. An edit that drops the
          // id forks the skill into a new identity, and one that drops the
          // evidence deletes the record of why the skill exists at all.
          //
          // `??` is the wrong operator for the string fields. `readState` reports
          // a missing frontmatter key as `''`, not `undefined`, so `revision.id
          // ?? record.id` keeps the empty string and writes a skill whose id is
          // blank — which then reads back as `''` forever and can never be
          // matched to its own history. Only a non-empty string counts as a
          // value worth preserving.
          : {
              id: revision.id || record.id,
              stage: revision.stage || 'unverified',
              uses: Number(revision.uses ?? 0),
              helpful: Number(revision.helpful ?? 0),
              harmful: Number(revision.harmful ?? 0),
              created: revision.created || now,
              validated: now,
              evidence: revision.evidence
                || gate.survived.map((entry) => entry.quote).join(' | ').slice(0, 500)
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
          const verified = typeof candidate.verifiedInSession === 'string' ? `, verified in ${candidate.verifiedInSession}` : ''
          lines.push(`- ${candidate.name} — ${candidate.description} (${kind}, ${candidate.evidence.length} quote(s), proposed ${candidate.createdAt}${verified}${state})`)
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

  // ---- market -----------------------------------------------------------------

  // The market tools are the only ones that leave the machine, so they are the
  // only ones that need the network and the approval seam. Both are read from
  // the host lazily rather than captured at apply time: a deployment can mount
  // or unmount either one mid-session, and the failure mode we want is a clear
  // error on this call, not a dead tool for the rest of the session.

  const marketFetch = () => deps.fetch ?? globalThis.fetch

  const marketSearch = {
    name: 'skill_market_search',
    description:
      'Search the public skills.sh market for a skill someone else already wrote. Use it before writing a new skill from scratch. Returns ids, names and install counts only — nothing is downloaded. Call `skill_market_preview` before `skill_market_install`.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the skill should do, in a few words.' },
        limit: { type: 'number', description: 'Maximum results. Defaults to 10, capped at 50.' }
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
    async execute(args) {
      const query = String(args?.query ?? '').trim()
      if (query.length === 0) return { ok: false, error: 'Give a query to search the market for.' }
      let outcome
      try {
        outcome = await searchMarket({ query, limit: args?.limit, fetch: marketFetch() })
      } catch (error) {
        return { ok: false, error: `Market search failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      log('skill_market_search', { query, hits: outcome.hits.length })
      return { ok: true, text: renderMarketSearch(outcome), hits: outcome.hits }
    }
  }

  const marketPreview = {
    name: 'skill_market_preview',
    description:
      'Download a market skill into memory and show its file list plus its SKILL.md, without writing anything. Always preview before installing: a market skill can ship executable scripts.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The market id from `skill_market_search`, of the form owner/repo/skill.' }
      },
      required: ['id'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value && value.ok === false) return [{ type: 'text', text: value.error }]
        return [{ type: 'text', text: value.text }]
      }
    },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (id.length === 0) return { ok: false, error: 'Give the market id to preview.' }
      let outcome
      try {
        outcome = await previewMarketSkill({ id, fetch: marketFetch() })
      } catch (error) {
        return { ok: false, error: `Market preview failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      log('skill_market_preview', { id, files: outcome.files.length })
      return { ok: true, text: renderMarketPreview(outcome), files: outcome.files, skillMd: outcome.skillMd }
    }
  }

  const marketInstall = {
    name: 'skill_market_install',
    description:
      'Install a market skill into the local skill library. This writes files to disk, including any scripts the skill ships, so it asks the human for approval before writing anything. Preview first. The host rejects this call when the approval policy is "never".',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The market id to install.' },
        name: {
          type: 'string',
          description: 'Local kebab-case skill name to install as. Defaults to the market skill id.'
        }
      },
      required: ['id'],
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
      const id = String(args?.id ?? '').trim()
      if (!isValidMarketId(id)) {
        return { ok: false, error: `"${id}" is not a market id of the form owner/repo/skill.` }
      }
      const requested = String(args?.name ?? '').trim()
      const name = requested === '' ? id.split('/')[2].toLowerCase() : requested
      if (!SKILL_NAME.test(name)) {
        return {
          ok: false,
          code: 'bad-name',
          error: `"${name}" is not a valid skill name. Use kebab-case: lowercase letters, digits and single hyphens.`
        }
      }

      const root = join(rootFor(exec?.agent), name)

      // The gate downloaded this bundle before it asked, so the bytes written
      // here are the bytes the person approved. A missing entry means no approval
      // was recorded for this call — re-fetching would silently turn a missing
      // approval into a successful install of something nobody saw.
      const bundle = deps.takeApprovedBundle?.(exec?.callId)
      if (bundle === undefined || bundle.id !== id) {
        return {
          ok: false,
          error: `No approved download is waiting for this call, so nothing was installed. Call \`skill_market_install\` again so the approval can show you the files first.`
        }
      }

      // Refuse to merge into an existing directory. A half-overwritten skill is
      // worse than no install: the host would load a mixture of two versions and
      // the ledger would record a use count for something that never existed.
      let existing
      try {
        existing = await listInstalled(root)
      } catch (error) {
        // An unreadable directory is not an empty one. Continuing would install
        // into whatever is already there, which is the exact collision this check
        // exists to prevent.
        return {
          ok: false,
          error: `Could not check whether "${name}" already exists at ${root}, so nothing was installed: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      if (existing.length > 0) {
        return {
          ok: false,
          error: `A skill named "${name}" already exists at ${root}. Remove it or install under a different name.`
        }
      }

      let outcome
      try {
        outcome = await installMarketSkill({
          root,
          files: bundle.files,
          overwrite: false
        })
      } catch (error) {
        return {
          ok: false,
          error: `Install failed after ${bundle.files.length} file(s) were attempted, so ${root} may be partially written: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      await deps.store.record({ at: new Date().toISOString(), actor: 'agent', action: 'skill_installed', skill: name, source: id })
      log('skill_market_install', { id, name, files: outcome.written.length })
      const executable = outcome.written.filter((path) => /\.(py|sh|ps1|js|mjs|rb|pl|exe|dll)$/i.test(path))
      const lines = [`Installed \`${id}\` as \`${name}\` (${outcome.written.length} file(s)).`]
      if (executable.length > 0) {
        lines.push('')
        lines.push(`This skill ships ${executable.length} executable file(s): ${executable.join(', ')}.`)
        lines.push('Read them before letting the skill run.')
      }
      if (bundle.dropped.length > 0) {
        lines.push('')
        lines.push(`Skipped ${bundle.dropped.length} file(s) whose paths would escape the skill directory: ${bundle.dropped.join(', ')}.`)
      }
      lines.push('')
      lines.push('It is in the library now; `skill_search` and the catalog will see it.')
      return { ok: true, text: lines.join('\n'), root, files: outcome.written }
    }
  }

  return [submit, list, feedback, search, marketSearch, marketPreview, marketInstall]
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
      // The rest of the lifecycle record is handed over whole rather than
      // field by field: a caller that forgets one silently resets it on write,
      // and nothing fails. `stage`/`uses`/`created` were the only three any
      // caller needed until auto-mode revisions started preserving the record.
      stage: state.stage,
      uses: state.uses,
      created: state.created,
      helpful: state.helpful,
      harmful: state.harmful,
      id: state.id,
      evidence: state.evidence
    }
  } catch {
    return undefined
  }
}


/**
 * Export the normalization helper so the index can reuse the same comparison.
 */
export { normalize, renderSkillFile, stateToFrontmatter }
