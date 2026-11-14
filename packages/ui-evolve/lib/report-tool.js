/**
 * `report_output_files` — the one tool that asks the model what it made.
 *
 * ## Why this exists
 *
 * The panel's file card is built from `tool/call` events: an `edit` names a
 * path, a shell command may name one in a redirect. Both are inferences, and
 * both miss the same thing — a turn that runs a program which itself writes
 * files. Measured on one real session: eight files on disk at the end of the
 * turn, four in the card. The other four were written by a Python script the
 * turn executed, and the script's own source named them only inside string
 * literals. No amount of reading the command line would have found them.
 *
 * Qoder answers this with git (it diffs the worktree at turn end) and with a
 * `present_files` tool (the model declares). Git is right for repositories and
 * blind outside one; a directory that is not a repository gets nothing at all.
 * This tool is the declaration half, which works everywhere.
 *
 * ## Why `execute` does not record anything
 *
 * The paths are read by {@link module:./transcript} from the `tool/call` event,
 * exactly like every other collection rule, so all of them live in one file and
 * the panel keeps working if a tool result is slow or never arrives.
 *
 * That makes this `execute` look like a no-op. It is not: it is the only place
 * that can tell the model its declaration was wrong, and the model is the only
 * party that can fix it. Rejecting an empty or oversized list here is what
 * stops the model from believing it recorded something.
 *
 * ## What it deliberately is not
 *
 * Not `present_files`: in Qoder that name triggers a preview and a delivery
 * chain. This only writes down that a file exists and belongs to this turn, so
 * the name says what happens — a record — and not what a reader might hope for.
 *
 * @module @revxz/dsh-ui-evolve/report-tool
 */

import { MAX_REPORTED_PATHS } from './transcript.js'

/**
 * The JSON schema the model sees.
 *
 * `maxItems` is stated twice — in the schema and in `execute` — because they
 * fail differently. The schema is what the model is told before it writes the
 * call; the check is what happens when a model ignores it. Only one of those
 * two can be relied on, and it is not the first.
 *
 * @returns {object} the parameter schema.
 */
function reportParameters() {
  return {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_REPORTED_PATHS,
        description:
          'Files this turn produced that no edit tool wrote directly, as absolute paths or paths relative to the workspace. Most often the outputs of a script the turn ran: generated images, archives, converted documents, an empty file created only to be checked.'
      },
      note: {
        type: 'string',
        description: 'Optional one-line reason, e.g. "written by tools/make_fixtures.py". Shown to nobody yet; recorded in the call for debugging.'
      }
    },
    required: ['paths'],
    additionalProperties: false
  }
}

/**
 * Build the tool definition.
 *
 * Kept as a factory rather than a constant so a test can hand it a spy and
 * because every other tool in this workspace is built the same way; a bare
 * object here would be the one shape a reader has to look up.
 *
 * @returns {object} a definition for `ctx.tools.register`.
 */
export function createReportTool() {
  return {
    name: 'report_output_files',
    description:
      'Record every file this turn produced, for the sidebar list that shows what a turn made. This is not `present`: `present` hands the few files a person should open (at most four) and is about delivery, while this records the full set — including the ones nobody needs to open — so the list is complete. Call it once near the end of a turn, after the files exist, listing every file the turn produced that no write or edit call named directly: outputs of a script you ran, generated images, archives, converted documents, a file created only to be checked. Do not list files created by a write/edit tool (already recorded), and do not list files that do not exist. If the turn produced nothing like that, do not call it at all.',
    parameters: reportParameters(),
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value && value.ok === false) {
          return [{ type: 'text', text: `Not recorded (${value.code}).\n\n${value.error}` }]
        }
        const count = value?.recorded ?? 0
        if (count === 0) {
          return [{ type: 'text', text: 'Nothing to record: no usable paths were given.' }]
        }
        const ignored = Array.isArray(value?.ignored) ? value.ignored.length : 0
        const tail = ignored > 0 ? ` ${ignored} entr${ignored === 1 ? 'y was' : 'ies were'} not a usable path.` : ''
        const dropped = typeof value?.dropped === 'number' && value.dropped > 0 ? value.dropped : 0
        const cut = dropped > 0
          ? ` ${dropped} later entr${dropped === 1 ? 'y' : 'ies'} did not fit the card and ${dropped === 1 ? 'was' : 'were'} dropped.`
          : ''
        return [{
          type: 'text',
          text: `${count} file${count === 1 ? '' : 's'} recorded for this turn.${tail}${cut} They will appear in the output file card after the turn ends.`
        }]
      }
    },
    async execute(args) {
      const raw = args?.paths
      if (!Array.isArray(raw)) {
        return {
          ok: false,
          code: 'no-paths',
          error: '`paths` must be an array of file paths. Pass at least one path, or do not call this tool.'
        }
      }
      const recorded = []
      const ignored = []
      for (const entry of raw) {
        if (typeof entry !== 'string') {
          ignored.push(String(entry))
          continue
        }
        const trimmed = entry.trim()
        if (trimmed.length === 0) {
          ignored.push(entry)
          continue
        }
        recorded.push(trimmed)
      }
      if (recorded.length === 0) {
        return {
          ok: false,
          code: 'no-paths',
          error: `None of the ${raw.length} entries was a non-empty string. Pass file paths, e.g. ["out/report.pdf"].`
        }
      }
      // The card holds a fixed number of rows per turn, so an oversized list is
      // not a mistake to refuse — the tail simply does not fit. Saying "recorded
      // 200" would be a lie and refusing outright would be a worse one, because
      // the reader has already taken the first entries by the time `execute`
      // runs. So keep what fits and state what was dropped.
      const kept = recorded.length > MAX_REPORTED_PATHS ? recorded.slice(0, MAX_REPORTED_PATHS) : recorded
      const dropped = recorded.length - kept.length
      return { ok: true, recorded: kept.length, ignored, dropped }
    }
  }
}
