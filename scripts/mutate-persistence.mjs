// Prove the persistence wiring is wired to something.
//
// `mutate-session-store.mjs` covers the file layer: ids, versions, atomic
// writes, the pruner's answers. What it cannot see is whether anything in the
// plugin uses any of it — a store that is written and never read passes every
// test in that suite. The failures here are all of the quiet kind:
//
//   * the panel answers from memory only, so a restart shows an empty card and
//     the store is a write-only diary;
//   * disposal forgets the file, so every shutdown erases every panel — which
//     looks like working software right up until someone reloads;
//   * the MCP and recency lookups ignore the session id, so two conversations
//     in one host list each other's work;
//   * a load that installs nothing, or an install that overwrites live
//     evidence, leaves the fallback present but useless.
//
// Each one is broken on purpose and the persistence suite is asked whether it
// noticed. A run where nothing failed means nothing was tested.
//
// The two failure modes this repo's mutation scripts have hit are handled the
// same way as in `mutate-session-store.mjs`: an anchor that no longer matches is
// its own outcome (fatal), and a missing tally is a crash rather than a
// surviving mutation — a suite that throws prints no `FAIL` row, so counting
// rows would call it a survivor.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))

/**
 * Write a file, retrying while the platform holds it.
 *
 * Windows returns `EBUSY`/`UNKNOWN` (`errno -4094`) when a watcher or indexer
 * has the file open for a moment. A plain `writeFileSync` throws, and that throw
 * lands inside the `finally` that restores the original — so the mutated source
 * stays on disk and the next run reads a file that is already wrong. A failed
 * mutate is a skipped mutation; a failed restore is a corrupted checkout.
 *
 * @param {string} path - the file to write.
 * @param {string} content - the exact bytes to write.
 */
function writeWithRetry(path, content) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.writeFileSync(path, content, 'utf8')
      return
    } catch (error) {
      if (attempt === 5) throw error
      const until = Date.now() + 60 * (attempt + 1)
      while (Date.now() < until) { /* wait out the transient lock */ }
    }
  }
}

function failures(output) {
  // Every suite has to have reported. A run that names several suites and reads
  // only the first tally would count a suite that crashed as one that passed —
  // the crash prints no tally, so the next suite's line answers for it. That is
  // the same masking this script already guards against for a single suite,
  // one level up.
  let failed = 0
  for (const suite of output.split('\u0000')) {
    const match = /(\d+) passed, (\d+) failed/.exec(suite)
    if (match === null) return -1
    failed += Number(match[2])
  }
  return failed
}

function run(suites) {
  const outputs = []
  for (const suite of suites) {
    try {
      outputs.push(execFileSync('node', [suite], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }))
    } catch (error) {
      // The suite exits non-zero when assertions fail, so its output is the
      // report either way. Only a missing tally (see `failures`) means it never
      // got there.
      outputs.push(`${error.stdout ?? ''}${error.stderr ?? ''}`)
    }
  }
  return outputs.join('\u0000')
}

const api = path.join(repo, 'packages', 'ui-evolve', 'lib', 'api.js')
const index = path.join(repo, 'packages', 'ui-evolve', 'lib', 'index.js')
const transcript = path.join(repo, 'packages', 'ui-evolve', 'lib', 'transcript.js')
const state = path.join(repo, 'packages', 'ui-evolve', 'lib', 'session-state.js')
const store = path.join(repo, 'packages', 'ui-evolve', 'lib', 'session-store.js')

const mutations = [
  {
    file: api,
    label: 'a restart finds nothing, because the panel never reads the disk',
    suites: ['test/persistence.test.mjs'],
    from: '  if (state === undefined || typeof state.load !== \'function\') return deps.transcripts.view(agentId)',
    to: '  if (state === undefined || typeof state.load !== \'function\') return deps.transcripts.view(agentId)\n  const inMemory = deps.transcripts.view(agentId)\n  if (inMemory !== undefined) return inMemory',
    why: 'The fallback is the feature. Without it the store is written and never read, and a panel opened after a restart answers "no completed turn yet" for a conversation with twenty. Answering from memory looks like a shortcut and is a hole: `record()` builds a transcript from the first event, so the read is skipped for the rest of the process.',
  },
  {
    file: api,
    label: 'the session is loaded but what it found is ignored',
    suites: ['test/persistence.test.mjs'],
    from: '  try {\n    await state.load(agentId)\n  } catch (error) {',
    to: '  await state.load(agentId)\n  return undefined\n  try {\n    await state.load(agentId)\n  } catch (error) {',
    why: '`load` installs the stored turn into the transcript store, so the view has to be read after it, not before and not skipped.',
  },
  {
    file: api,
    label: 'a storage fault takes the panel down with it',
    suites: ['test/api.test.mjs', 'test/persistence.test.mjs'],
    from: "  } catch (error) {\n    if (typeof deps.log === 'function') deps.log(`panel: could not read the stored state — ${error?.message ?? error}`)\n  }",
    to: "  } catch (error) {\n    throw error\n  }",
    why: 'A conversation that exists is not a failed panel because its cache could not be read. The route has to answer.',
  },
  {
    file: api,
    label: 'the MCP servers are read for no session in particular',
    suites: ['test/persistence.test.mjs'],
    from: "    mcp: describeMcp(typeof deps.mcpTools === 'function' ? deps.mcpTools(id) : new Set(), recency),",
    to: "    mcp: describeMcp(typeof deps.mcpTools === 'function' ? deps.mcpTools('') : new Set(), recency),",
    why: 'Before this work the lookup was process-wide; two conversations in one host listed each other\'s servers. The id is the fix.',
  },
  {
    file: api,
    label: 'the recency clock is read for no session in particular',
    suites: ['test/api.test.mjs', 'test/persistence.test.mjs'],
    from: "  const recency = typeof deps.recentUse === 'function' ? deps.recentUse(id) : undefined",
    to: "  const recency = typeof deps.recentUse === 'function' ? deps.recentUse('') : undefined",
    why: 'Recency is how the panel orders skills against MCP servers. Sharing one clock across sessions reorders one conversation by another\'s traffic.',
  },
  {
    file: index,
    label: 'a shutdown wipes every panel',
    suites: ['test/persistence.test.mjs'],
    from: '    void sessionState\n      .release(agentId)\n      .then(() => { transcripts.forget(agentId) }, () => { transcripts.forget(agentId) })',
    to: '    void sessionState.forget(agentId)',
    why: 'The host disposes every agent when it quits. Forgetting here deletes the file of every session on every exit — the exact failure the persistence work removes, wearing the shape of a cleanup.',
  },
  {
    file: index,
    label: 'the tool names are copied into the panel from nowhere',
    suites: ['test/persistence.test.mjs'],
    from: '      mcpTools(agentId) {\n        return sessionState.toolsSeen(agentId)\n      },',
    to: "      mcpTools(agentId) {\n        void agentId\n        return sessionState.toolsSeen('')\n      },",
    why: 'Per session is the whole point: a configured server that this conversation never reached must not appear in its card.',
  },
  {
    file: index,
    label: 'the skills a session loaded are read for no session in particular',
    suites: ['test/persistence.test.mjs'],
    from: '      skillsUsed(agentId) {\n        return sessionState.skillsUsed(agentId)\n      },',
    to: "      skillsUsed(agentId) {\n        void agentId\n        return sessionState.skillsUsed('')\n      },",
    why: '`describeSkills` filters the host registry by this map, so the wrong map lists the wrong conversation\'s skills.',
  },
  {
    file: index,
    label: 'a finished turn is not worth writing down',
    suites: ['test/persistence.test.mjs'],
    from: "    if (event?.type === 'turn/end') {\n      sessionState.rememberTurn(agentId)",
    to: "    if (event?.type === 'turn/end') {\n      if (false) sessionState.rememberTurn(agentId)",
    why: 'Skills and MCP calls alone leave the file a turn behind: the panel describes the turn that ended, and until it is written the card shows yesterday\'s summary beside today\'s traffic.',
  },
  {
    file: index,
    label: 'a skill load never reaches the session that loaded it',
    suites: ['test/persistence.test.mjs'],
    from: '    sessionState.rememberSkill(agentId, name, via)',
    to: '    if (false) sessionState.rememberSkill(agentId, name, via)',
    why: 'The gesture path and the tool path both funnel through here. A no-op here makes the skill card permanently empty while every other assertion still passes.',
  },
  {
    file: transcript,
    label: 'a stored turn is refused because this process has already seen events',
    suites: ['test/transcript.test.mjs', 'test/persistence.test.mjs'],
    from: '    if (existing.hydrated === true) return false\n    existing.hydrated = true\n    existing.turns += turns',
    to: '    if (existing.hydrated === true) return false\n    return false\n    existing.hydrated = true\n    existing.turns += turns',
    why: 'A file read takes milliseconds, and events arrive during it. Refusing the file because memory is no longer empty throws away the only fact memory cannot reconstruct — how many turns came before this process started — so the panel announces turn 1 for a conversation that had reached turn 8.',
  },
  {
    file: transcript,
    label: 'the turn that opened before the file was read keeps the number it invented',
    suites: ['test/transcript.test.mjs'],
    from: '    if (existing.turn !== undefined) existing.turn = existing.turns',
    to: '    if (false) existing.turn = existing.turns',
    why: 'The count and the open turn disagree after a restart unless the open turn is moved with it. Adding the stored turns without renumbering leaves `turns: 2` beside an open turn of `1`, and every later consumer of that number — `previous.turn`, the sweep record, each path window — files this turn under the one that had already finished. Nothing crashes and the card still draws; it just puts the work that just happened under the wrong turn.',
  },
  {
    file: transcript,
    label: 'the stored turn is dropped on the way in',
    suites: ['test/transcript.test.mjs', 'test/persistence.test.mjs'],
    from: '    transcript.previous = previous',
    to: '    transcript.previous = undefined',
    why: 'Installing a transcript with no `previous` gives `view()` a record that answers exactly like a session with no history — the fallback runs and proves nothing.',
  },
  {
    file: state,
    label: 'the recency clock forgets which session it belongs to',
    suites: ['test/session-state.test.mjs'],
    from: '  recency(sessionId) {\n    const entry = this.bySession.get(sessionId)',
    to: "  recency(sessionId) {\n    void sessionId\n    const entry = this.bySession.get('')",
    why: 'Recency is per session like everything else; one global clock orders two conversations against each other.',
  },
  {
    file: state,
    label: 'a session with nothing to say still gets a file',
    suites: ['test/session-state.test.mjs'],
    from: '    if (hasFacts(entry) === false) return undefined',
    to: '    if (false) return undefined',
    why: 'Every conversation that was ever opened would leave a file, and the pruner would carry them. Absence has to be recorded as absence.',
  },
  // ---- the three the first review found -------------------------------------
  {
    file: state,
    label: 'a write asks the transcript for its snapshot when it lands, not when the fact arrived',
    suites: ['test/session-state.test.mjs'],
    from: '    if (snapshot !== undefined) entry.snapshot = snapshot\n    // It has facts now, so it is no longer one of the records that can never be\n    // written and therefore never be pruned.\n    entry.empty = false',
    to: '    // It has facts now, so it is no longer one of the records that can never be\n    // written and therefore never be pruned.\n    entry.empty = false',
    why: 'Shutdown disposes the agent and drops the transcript before the in-flight write finishes, so asking again at write time turns a finished turn into "no turn yet" and replaces a good file with an empty one — silently, because an empty document is a legal document.',
  },
  {
    file: state,
    label: 'a session id that cannot be stored is loaded into memory anyway',
    suites: ['test/session-state.test.mjs'],
    from: '    if (this.store.pathFor(sessionId) === undefined) return false',
    to: '    if (false) return false',
    why: 'The panel route takes the session id from a query parameter. Each unsafe one becomes an entry that can never be written and never be pruned — `prune` only drops memory for ids the host calls archived — so any local process can grow that map without bound.',
  },
  {
    file: index,
    label: 'an archive list that cannot be read takes the whole sweep with it',
    suites: ['test/persistence.test.mjs'],
    from: '    try {\n      const archived = registry.archivedSessionIds\n      if (Array.isArray(archived)) sources.archived = () => archived\n    } catch {\n      // Nothing to add. The deletion check above still runs.\n    }',
    to: '    const archived = registry.archivedSessionIds\n    if (Array.isArray(archived)) sources.archived = () => archived',
    why: 'A cordis service is provided before its `init` resolves, so this getter can throw on a tick that otherwise works. Unguarded it escapes `setInterval` as an `uncaughtException`, and the session the host says it deleted keeps its file.',
  },
  // ---- the three the second review found ------------------------------------
  {
    file: state,
    label: 'a session read back from disk forgets the turn it just read',
    suites: ['test/session-state.test.mjs'],
    from: '      this.bySession.set(sessionId, { ...state, snapshot, timer: undefined, writing: undefined, dirty: false, loaded: true })',
    to: '      this.bySession.set(sessionId, { ...state, snapshot: undefined, timer: undefined, writing: undefined, dirty: false, loaded: true })',
    why: 'The write path no longer asks the transcript, it uses the captured snapshot. So a load that leaves it undefined means "open the panel, then shut down" writes an empty turn over a finished one — the panel describes the conversation as never having had a turn, and the poll that caused it looks like a read.',
  },
  {
    file: state,
    label: 'a well-formed id that was never a session lives in memory forever',
    suites: ['test/session-state.test.mjs'],
    from: '      if (entry.empty === true) this.bySession.delete(sessionId)',
    to: '      if (false) this.bySession.delete(sessionId)',
    why: 'A panel poll for a plausible id with no file installs an empty record so the next tick does not re-read the disk. That record has no facts, so it is never written and the store never sees it; without the sweep reclaiming it, any caller can grow that map without bound.',
  },
  // ---- the three the third review found ------------------------------------
  {
    file: state,
    label: 'a write that lands after its session was swept puts the file back',
    suites: ['test/session-state.test.mjs'],
    from: '        if (current === undefined) {',
    to: '        if (current === undefined) {\n          return',
    why: 'The sweep decides from the directory listing, so a write already in flight has no file for it to judge. Without the entry check the rename lands afterwards and recreates the file the sweep just deleted, and the recreated file outlives the next five minutes because the sweep is throttled.',
  },
  {
    file: state,
    label: 'a stored turn count is dropped unless a finished turn came with it',
    suites: ['test/session-state.test.mjs'],
    from: '    const snapshot = Number.isFinite(stored.turns) || isRecord(stored.previous)',
    to: '    const snapshot = isRecord(stored.previous)',
    why: 'An abandoned turn records a count and no previous. Reading it back with an undefined snapshot makes the next write drop the count, so a restart reports turn 0 for a conversation that had run several, and nothing anywhere says a field went missing.',
  },
  {
    file: state,
    label: 'a record that has just been given a fact is still treated as empty',
    suites: ['test/session-state.test.mjs'],
    from: '    entry.empty = false\n',
    to: '',
    why: 'Records made by a poll for an unknown id are reclaimed by every sweep. A fact arriving before that sweep has to make the record worth keeping, or the sweep discards a change that has not been written yet.',
  },
  {
    file: state,
    label: 'every entry is asked about, including the ones the sweep already judged',
    suites: ['test/session-state.test.mjs'],
    from: '      if (judged.has(sessionId)) continue\n',
    to: '',
    why: 'The store already asked the host about every id it found a file for. Asking again for those doubles the host round-trips per sweep and can contradict the answer the store acted on.',
  },
  {
    file: state,
    label: 'a sweep that never ran still asks the host about every entry',
    suites: ['test/session-state.test.mjs'],
    from: '    if (this.store.considered === undefined) return 0\n',
    to: '',
    why: 'The interval exists so a sweep is not run on every poll. Without this gate each poll would still consult the host once per in-memory session, which is the round-trip the throttle was there to avoid.',
  },
  // ---- the two the fourth review found -------------------------------------
  {
    file: state,
    label: 'a write that finds a newer record deletes what that record saved',
    suites: ['test/session-state.test.mjs'],
    from: '          current.dirty = true\n          return this.flush(sessionId)',
    to: '          await this.store.forget(sessionId)\n          return',
    why: 'An id that was swept and then reopened is not an id nobody owns. The older record lands, finds a different record in its place and deletes that record\'s file — the panel keeps showing facts the disk no longer has, and nothing makes it dirty again.',
  },
  {
    file: state,
    label: 'an empty record deletes a file that holds only a turn count',
    from: '      turns: found.value.turns,',
    to: '      turns: undefined,',
    suites: ['test/session-state.test.mjs'],
    why: 'A conversation whose turns were all abandoned has no finished turn, no skill and no tool — only a count. The orphan check used to judge emptiness by counters alone and unlinked that file on the way out, so every restart lost the turns since. The count is read from the document top level because `readState` keeps it outside the shape it returns.',
  },
  {
    file: state,
    label: 'an empty record deletes a file that holds a finished turn',
    from: '      previous: found.value.previous,',
    to: '      previous: undefined,',
    suites: ['test/session-state.test.mjs'],
    why: 'The record remembers an empty disk; the file may have gained a finished turn from another process since. Reading the turn from `readState` rather than from the document would make this guard undefined for every file — `readState` answers "what may this build use" and the turn sits at the top level with `turns` — so the guard would never fire and a session with work in it would be unlinked by a process that merely looked at it once.',
  },
  {
    file: state,
    label: 'a deletion is recorded at the end of the sweep instead of when it happens',
    suites: ['test/session-state.test.mjs'],
    from: '      onRemoved: (sessionId, reason) => {\n        // Only one of the two ways a file goes away says anything about the\n        // session.',
    to: '      onRemoved: (sessionId, reason) => {\n        return\n        // Only one of the two ways a file goes away says anything about the\n        // session.',
    why: 'The sweep awaits the host between ids. A write landing in that gap finds its record still in memory, takes it for still wanted and leaves the file the sweep already deleted — an orphan the next restart reads back as a live session.',
  },
  {
    file: state,
    label: 'a load installs its record over one that arrived while it read',
    suites: ['test/session-state.test.mjs'],
    from: '    const current = this.bySession.get(sessionId) ?? before',
    to: '    const current = before',
    why: 'The load awaits the disk, and an event landing in that window has already been recorded. Reading the record again after the await and merging into it is what keeps that fact; taking the pre-await value replaces the live record with a stale one, and with an empty one when the file was gone, so the next flush deletes the file the fact was just written to.',
  },
  {
    file: store,
    label: 'a file that cannot be opened is taken for an empty directory',
    from: "      if (error?.code === 'ENOENT') return { kind: 'absent' }\n      return { kind: 'foreign' }",
    to: "      return { kind: 'absent' }",
    suites: ['test/session-store.test.mjs'],
    why: 'ENOENT is the only answer that means nothing is stored. EACCES, EPERM, EBUSY, EISDIR all mean something is there and could not be read — which, for a caller about to delete, is the same answer as a foreign file. Reading them as absence deletes a file that merely could not be opened at that moment.',
  },
  {
    file: state,
    label: 'an empty record lets an in-flight write keep a pruned file alive',
    from: '      if (entry.empty === true) await this.dropIfOrphan(sessionId)',
    to: '      if (false) await this.dropIfOrphan(sessionId)',
    suites: ['test/session-state.test.mjs'],
    why: 'The panel polls with no interval of its own, so an empty record sitting in the gap between a sweep and a landing write is ordinary. Without the delete the file survives until the next sweep — up to a full prune interval — and every poll in that window reads a conversation that is gone back off disk.',
  },
  {
    file: store,
    label: 'the store deletes files without telling anyone',
    suites: ['test/session-state.test.mjs', 'test/session-store.test.mjs'],
    from: "      if (typeof sources.onRemoved === 'function') sources.onRemoved(id, reason)",
    to: '',
    why: 'Deleting the file is only half the decision. The caller keeps memory, and memory is what a landing write consults; with no notification the two disagree for a whole interval.',
  },
  {
    file: state,
    label: 'a record that has never read the disk writes over what is on it',
    suites: ['test/session-state.test.mjs', 'test/persistence.test.mjs'],
    from: '    if (entry.loaded !== true) {\n      await this.load(sessionId)',
    to: '    if (false) {\n      await this.load(sessionId)',
    why: 'Events arrive before the first poll after a restart, so the record that writes first is one that has never read. Skipping the read replaces every turn, skill and MCP server the file knew with the few seconds this process has seen, and nothing ever goes back for the rest.',
  },
  {
    file: state,
    label: 'a read of the disk throws away the facts that arrived while it read',
    suites: ['test/session-state.test.mjs'],
    from: '    if (before !== undefined && before.loaded === true) return false',
    to: '    if (before !== undefined) return false',
    why: 'A record made by the first event is not a reason to skip the disk; it is the case where the disk still knows more. Answering that it is already in memory leaves the history behind for good, which is what the merge exists to prevent.',
  },
  {
    file: state,
    label: 'a missing file is not allowed to be reclaimed by a sweep',
    suites: ['test/session-state.test.mjs'],
    from: '        const record = blankRecord()\n        record.empty = true\n        record.loaded = true',
    to: '        const record = blankRecord()\n        record.loaded = true',
    why: 'The empty flag is what lets a sweep reclaim a record that never became a file, and what licenses flush to delete one left behind by a record the sweep removed. Without it, every polled session id that was never a conversation stays in memory for the life of the process.',
  },
  {
    file: state,
    label: 'a session whose only fact is a finished turn is written and then deleted',
    suites: ['test/session-state.test.mjs'],
    from: '      if (hasFacts(current) === false) current.empty = true',
    to: '      if (current.skills.size === 0 && current.tools.size === 0 && current.sequence === 0) current.empty = true',
    why: 'This is the shape the bug had: `document` decides emptiness by whether there is a snapshot to write, while this decides it by counting skills and tools. A conversation that only talked has neither, so the record is marked empty, the sweeper evicts it, and the write that is already in flight finds no owner for the id and deletes the file it just saved.',
  },
  {
    file: state,
    label: 'two reads in the same tick each merge the file in',
    suites: ['test/session-state.test.mjs'],
    from: '    const pending = this.loading.get(sessionId)\n    if (pending !== undefined) return pending',
    to: '    const pending = this.loading.get(sessionId)\n    if (pending !== undefined && false) return pending',
    why: 'Every guard before this point is checked before an await, so both callers pass them. Without a shared promise each one merges the same file into the same record and shifts every counter again — the recency clock and `sequence` double, and the transcript is handed the same turn twice.',
  },
  {
    file: state,
    label: 'a load puts back the record a sweep removed',
    suites: ['test/session-state.test.mjs'],
    from: '      current.loaded = true\n      // No re-install here.',
    to: '      current.loaded = true\n      if (this.bySession.has(sessionId) === false) this.bySession.set(sessionId, current)\n      // No re-install here.',
    why: 'The sweep deletes the record while the read it is waiting behind is in flight. Re-installing it undoes the decision: `flush` re-reads the map, finds the record back, and writes the file the host said should not exist.',
  },
  {
    file: store,
    label: 'a cap counts the names it could date instead of the files it keeps',
    suites: ['test/session-store.test.mjs'],
    from: '    const excess = dated.length - this.maxFiles',
    to: '    const excess = survivors.length - this.maxFiles',
    why: 'The listing is what the cap measures, but only the stat-able names can be ordered, so the dated list is the shorter one. Subtracting the cap from that shorter list makes the count larger than the list itself, and `slice(0, excess)` past the end is the whole list — every conversation that could be dated is deleted, including the ones under the cap. It looks like a smaller number and acts like "delete everything".',
  },
  {
    file: state,
    label: 'a record that saw an empty disk deletes what another process wrote',
    suites: ['test/session-state.test.mjs'],
    from: '      if (entry.empty === true) await this.dropIfOrphan(sessionId)',
    to: '      if (entry.empty === true) await this.store.forget(sessionId)',
    why: '`empty` is a memory of what this process read, not a claim about the file as it stands now. Two hosts share the `plugin-data` directory, so the departure of the one that read nothing must not be the thing that decides the file is unwanted — that deletes the other process\'s work, and the panel it was written for.',
  },
  {
    file: state,
    label: 'the sweep decision is overruled by a file that a late write put there',
    suites: ['test/session-state.test.mjs'],
    from: '    if (this.condemned.has(sessionId)) {\n      await this.store.forget(sessionId)\n      return\n    }',
    to: '    if (false) {\n      await this.store.forget(sessionId)\n      return\n    }',
    why: 'The host said the session is gone; the file on disk was written by a write that was already in flight when it said so. Asking the file instead of remembering the decision lets that write speak for a session the host has already answered about, and the file comes back.',
  },
  {
    file: index,
    label: 'disposal drops the transcript only before the release it can lose',
    suites: ['test/persistence.test.mjs'],
    from: '      .then(() => { transcripts.forget(agentId) }, () => { transcripts.forget(agentId) })',
    to: '      .then(() => {}, () => {})',
    why: '`release` can await a read of the disk, and that read ends by handing the stored turn back to the transcript. Dropping only before it settles means the restore puts the closed session back, and it stays in memory for the life of the process — one entry per session the host ever opened.',
  },
  {
    file: state,
    label: 'a conversation that only counted turns never touches its file again',
    suites: ['test/session-state.test.mjs'],
    from: '  return Number.isFinite(facts.turns) && facts.turns > 0',
    to: '  return false',
    why: 'A count is the one fact that cannot be rebuilt from live events after a restart, and the panel prints it. Answering "nothing worth writing" for it means a session whose turns all ended early keeps the count it had when the process started and loses every turn since on the next restart — while the panel goes on showing a number, which is what makes it invisible.',
  },
  {
    file: state,
    label: 'the count written back is the one the record grabbed before the read',
    suites: ['test/session-state.test.mjs'],
    from: `    const record = this.bySession.get(sessionId)
    const counted = typeof this.snapshotOf === 'function' ? this.snapshotOf(sessionId) : undefined
    if (record !== undefined && counted !== undefined) record.snapshot = counted
`,
    to: '',
    why: 'The record takes a snapshot when a fact arrives, which is before the read that brings the turns from before the restart. Writing that one back moves the count backwards: the file says three turns for a conversation the panel shows eight of, and the next restart loses the difference.',
  },
]

// The originals, read once per file, so the interrupt path can restore from
// memory even if the loop never got the chance to.
const backups = new Map()
for (const file of new Set(mutations.map((mutation) => mutation.file))) {
  backups.set(file, fs.readFileSync(file, 'utf8'))
}

let killed = 0
const survived = []
const notApplied = []
const crashed = []

try {
  for (const mutation of mutations) {
    const original = fs.readFileSync(mutation.file, 'utf8')
    if (original.split(mutation.from).length - 1 !== 1) {
      notApplied.push(mutation.label)
      continue
    }
    try {
      writeWithRetry(mutation.file, original.replace(mutation.from, mutation.to))
      const failed = failures(run(mutation.suites))
      if (failed > 0) {
        killed += 1
        console.log(`KILLED      ${mutation.label}  (${failed} failed)`)
      } else if (failed === 0) {
        survived.push(mutation.label)
        console.log(`SURVIVED    ${mutation.label}`)
      } else {
        crashed.push(mutation.label)
        console.log(`CRASHED     ${mutation.label}`)
      }
    } finally {
      // Restored per mutation, not per run: a later anchor is read from disk, and
      // leaving one mutation in place would make every following run meaningless.
      writeWithRetry(mutation.file, original)
    }
  }
} finally {
  // Belt and braces. The per-mutation restore above covers the loop; this covers
  // an interrupt landing between the write and that restore.
  for (const file of new Set(mutations.map((mutation) => mutation.file))) {
    const backup = backups.get(file)
    if (backup !== undefined) writeWithRetry(file, backup)
  }
}

for (const mutation of mutations) {
  if (notApplied.includes(mutation.label)) console.log(`\nANCHOR MISSING  ${mutation.label}\n  ${mutation.why}`)
  if (survived.includes(mutation.label)) console.log(`\nUNCOVERED       ${mutation.label}\n  ${mutation.why}`)
  if (crashed.includes(mutation.label)) console.log(`\nCRASHED         ${mutation.label}\n  ${mutation.why}`)
}

const total = mutations.length
console.log(`\n${killed} killed, ${survived.length} survived, ${notApplied.length} not applied, ${crashed.length} crashed  (of ${total})`)
if (survived.length > 0 || notApplied.length > 0 || crashed.length > 0) process.exit(1)
