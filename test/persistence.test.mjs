/**
 * The panel has to describe a conversation, not a process.
 *
 * Everything here mounts the real plugin halves against the fake host from
 * `index.test.mjs`'s shape, drives real `session/event` traffic through them,
 * and then reads the answer from the real route. What is under test is the
 * promise the persistence work makes:
 *
 *   * a session that this process has not seen still gets its panel — a
 *     restart, a reload, a panel opened on a conversation from yesterday;
 *   * two conversations in one host do not see each other's work;
 *   * the state file goes away when its session is archived, because that is
 *     what "does not accumulate forever" has to mean in practice;
 *   * and it does not go away when the host merely shuts down, which disposes
 *     every agent and would otherwise empty every panel.
 *
 * The last two are the pair that makes this work: a naive implementation gets
 * one by breaking the other.
 */
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyPanel, Config as PanelConfig } from '../packages/ui-evolve/lib/index.js'
import { SessionStore, VERSION } from '../packages/ui-evolve/lib/session-store.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

const tempRoots = []
process.on('exit', () => {
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A leftover directory is better than hiding the failure that explains the run.
    }
  }
})

async function makeTempRoot(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

/**
 * A fake host with only the surface the panel touches.
 *
 * Deliberately not a copy of `index.test.mjs`'s fixture: that one carries the
 * detector's tools, commands and prompt contexts, none of which the panel reads.
 * Keeping this one small means a change to the panel's dependencies shows up
 * here as a missing method rather than being shadowed by a fixture that happens
 * to provide it.
 */
function fakeHost(services = new Map()) {
  const handlers = new Map()
  const routes = new Map()
  const logs = []
  const deferred = []
  const effects = []
  const agents = new Map()

  const ctx = {
    logger: { info: (line) => logs.push(line) },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(register, label) {
      const result = register()
      effects.push({ dispose: result, label })
      return result
    },
    inject(names, callback) {
      const missing = names.filter((name) => ctx[name] === undefined)
      if (missing.length > 0) {
        deferred.push({ names, callback })
        return undefined
      }
      return callback(ctx)
    },
    webServer: {
      register({ kind, path, handler }) {
        routes.set(path, { kind, handler })
        return () => routes.delete(path)
      }
    },
    agents: {
      roots: () => [...agents.values()],
      get: (id) => agents.get(id)
    },
    // The host's registry. `describeSkills` filters this by what the session
    // used, so it has to actually contain the skills the tests load — an empty
    // registry lists nothing regardless of the traffic, and every skill
    // assertion below would pass for the wrong reason.
    skills: {
      async snapshot() {
        return {
          complete: true,
          skills: [
            { name: 'alpha', description: 'the first', invocation: { modelInvocable: true, userInvocable: true } },
            { name: 'beta', description: 'the second', invocation: { modelInvocable: true, userInvocable: true } }
          ]
        }
      },
      async get(name) {
        return { name, description: name, content: 'body' }
      }
    },
    services,
    get(name) {
      return services.has(name) ? services.get(name) : ctx[name]
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    }
  }

  return {
    ctx,
    handlers,
    routes,
    logs,
    agents,
    effects,
    /** Deliver an event to whatever is listening, the way the host does. */
    emit(event, ...payload) {
      for (const handler of handlers.get(event) ?? []) handler(...payload)
    },
    /** Answer one panel poll the way the client does. */
    async panel(agentId) {
      const route = routes.get('/api/ui-evolve')
      if (route === undefined) throw new Error('the panel route was never registered')
      const res = {
        statusCode: undefined,
        writableEnded: false,
        once() {
          return this
        },
        writeHead(code) {
          this.statusCode = code
          return this
        },
        end(body) {
          this.writableEnded = true
          this.body = body
          return this
        }
      }
      await route.handler(
        { url: `/api/ui-evolve/panel?agent=${encodeURIComponent(agentId)}`, method: 'GET', headers: { host: '127.0.0.1:19387' } },
        res
      )
      return JSON.parse(res.body)
    }
  }
}

/** One session's worth of work: a skill load, an MCP call, a finished turn. */
function fakeSession(id, cwd = 'F:/some/project') {
  return {
    id,
    session: { id, header: { id, cwd, version: 4, createdAt: Date.now(), isSeeded: false } }
  }
}

/**
 * Drive the three facts the panel persists.
 *
 * `turn` numbers the events so two sessions can be driven independently, and
 * the turn carries a `completed` reason because an abandoned turn deliberately
 * does not write `previous` — the panel describes turns that finished.
 */
function work(host, session, { skill, tool, said, turn = 1 }) {
  host.emit('session/event', session.session, {
    type: 'user/message',
    seq: turn * 10,
    time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }
  })
  if (skill !== undefined) {
    host.emit('session/event', session.session, {
      type: 'tool/call',
      seq: turn * 10 + 1,
      time: Date.now(),
      data: { turn, step: 1, callId: `c-skill-${turn}`, name: 'skill', arguments: JSON.stringify({ name: skill }) }
    })
  }
  if (tool !== undefined) {
    host.emit('session/event', session.session, {
      type: 'tool/call',
      seq: turn * 10 + 2,
      time: Date.now(),
      data: { turn, step: 1, callId: `c-mcp-${turn}`, name: tool, arguments: '{}' }
    })
  }
  if (said !== undefined) {
    host.emit('session/event', session.session, {
      type: 'assistant/message',
      seq: turn * 10 + 3,
      time: Date.now(),
      data: { message: { role: 'assistant', content: [{ type: 'text', text: said }] } }
    })
  }
  host.emit('session/event', session.session, {
    type: 'turn/end',
    seq: turn * 10 + 4,
    time: Date.now(),
    data: { turn, reason: { kind: 'completed' } }
  })
}

/** The panel's own state directory for a given DSH_HOME. */
function stateDir(root) {
  return join(root, 'plugin-data', 'skill-evolve', 'sessions')
}

/**
 * Wait for a write that was scheduled behind the coalescing delay.
 *
 * The delay is what keeps a burst of events from becoming a burst of writes, so
 * a test that read the file immediately would be reading it before the plugin
 * had decided to write it. Polling the file is more honest than assuming a
 * particular timer duration.
 */
async function waitForFile(path, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

console.log('persistence — the panel describes a conversation, not a process')

// ---------------------------------------------------------------------------
// A second host, on the same DSH_HOME, sees the first host's session
// ---------------------------------------------------------------------------

{
  const root = await makeTempRoot('dsse-persist-restart-')
  process.env.DSH_HOME = root

  const first = fakeHost()
  applyPanel(first.ctx, PanelConfig({ panelSummary: false }))
  check('the first host registered its route', first.routes.has('/api/ui-evolve') === true)

  const session = fakeSession('session-restart-me')
  first.agents.set(session.id, session)
  work(first, session, { skill: 'alpha', tool: 'mcp__zeta__lookup', said: 'I looked the thing up and it was fine.' })

  const path = join(stateDir(root), `${session.id}.json`)
  const written = await waitForFile(path)
  check('a finished turn writes the session down', written, `no file at ${path}`)

  // Read it with the store rather than by hand: the file's shape is the store's
  // contract, and a test that hard-codes field names would keep passing after
  // the shape and the reader had both changed.
  const store = new SessionStore({ root: stateDir(root) })
  const stored = await store.read(session.id)
  check('the stored file names the session it describes', stored?.session === session.id, JSON.stringify(stored)?.slice(0, 200))
  check('the stored file carries the finished turn', stored?.previous?.turn === 1, JSON.stringify(stored?.previous)?.slice(0, 200))
  check('the stored file carries the skill the session loaded', stored?.skills?.alpha?.via === 'tool', JSON.stringify(stored?.skills))
  check('the stored file carries the MCP server the session reached', stored?.servers?.zeta !== undefined, JSON.stringify(stored?.servers))
  check('the stored file carries the whole MCP tool name', stored?.tools?.includes('mcp__zeta__lookup') === true, JSON.stringify(stored?.tools))

  // The restart. A second plugin instance on the same home has no memory of the
  // first one's events — exactly what a host restart looks like from here.
  const second = fakeHost()
  applyPanel(second.ctx, PanelConfig({ panelSummary: false }))
  const reloaded = await second.panel(session.id)

  check('a fresh host still answers for the session', reloaded.ok === true, JSON.stringify(reloaded)?.slice(0, 200))
  check('the reloaded panel names the turn that finished', reloaded.data?.turn === 1, JSON.stringify(reloaded.data)?.slice(0, 200))
  check('the reloaded panel counts the calls the session made', reloaded.data?.calls === 2, JSON.stringify(reloaded.data?.calls))
  check(
    'the reloaded panel lists the skill the session loaded',
    reloaded.data?.skills?.skills?.some((row) => row.name === 'alpha') === true,
    JSON.stringify(reloaded.data?.skills?.skills)
  )
  check(
    'the reloaded panel lists the MCP server the session reached',
    (reloaded.data?.mcp ?? []).some((row) => row.server === 'zeta') === true,
    JSON.stringify(reloaded.data?.mcp)
  )

  // The second host answers a second time from memory, not from disk. This is
  // not a style preference: reading the file on every poll would be one read per
  // second per open panel, and the load is what the store's design assumes does
  // not happen twice.
  const again = await second.panel(session.id)
  check('a second poll agrees with the first', again.data?.turn === reloaded.data?.turn, JSON.stringify(again.data?.turn))
}

// ---------------------------------------------------------------------------
// An event that arrives before the first poll does not erase the history
// ---------------------------------------------------------------------------

{
  // The host replays a session's events before anything asks for the panel, so
  // on a restart the first thing the accumulators see is a fact — not a poll.
  // That fact creates a record, and a record that answered "already in memory,
  // nothing to read" would leave everything the file knew behind for good: the
  // next write replaces the document with the few seconds this process has seen.
  //
  // The file here is a whole conversation: seven turns, two skills, an MCP tool
  // and a finished turn to summarise. The new process sees one skill. Both have
  // to be on disk afterwards, in that order.
  const home = await makeTempRoot('dsse-persist-race-')
  process.env.DSH_HOME = home
  const root = stateDir(home)
  const seed = new SessionStore({ root })
  await seed.write('session-restarted', {
    version: VERSION,
    session: 'session-restarted',
    state: 1,
    turns: 7,
    previous: { turn: 7, calls: 3, failed: 0, paths: [], commands: [], said: 'the turn before the restart', tools: [] },
    skills: { alpha: { via: 'tool', at: 1 }, beta: { via: 'gesture', at: 2 } },
    tools: ['mcp__github__search'],
    servers: { github: 2 },
    sequence: 2,
  })

  // A fresh host, same state directory: this is the restart.
  const host = fakeHost()
  applyPanel(host.ctx, PanelConfig({ panelSummary: false }))
  const session = fakeSession('session-restarted', 'F:/work')
  const before = (await seed.inspect('session-restarted')).value
  check('the seed file describes a conversation', before?.turns === 7, JSON.stringify(before?.turns))

  // The event lands first — nothing has polled yet.
  work(host, session, { skill: 'gamma', said: 'this is the new turn', turn: 8 })

  // The file is already there, so waiting for it to exist would wait for
  // nothing. What has to arrive is the rewrite, and the write is coalesced
  // behind a delay — poll the content, not the path.
  let after = before
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    after = (await seed.inspect('session-restarted')).value
    if (after?.skills?.gamma !== undefined) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  check('the history the file already had is still there', after?.skills?.alpha?.via === 'tool' && after?.skills?.beta?.via === 'gesture', Object.keys(after?.skills ?? {}).join(','))
  check('and the tool it named is still there', Array.isArray(after?.tools) && after.tools.includes('mcp__github__search') === true, JSON.stringify(after?.tools))
  // The count is the one fact the merge cannot take from events: this process
  // began counting at zero, so a live count of 1 and a stored count of 7 are
  // two halves of the same number. Adding them is the only reading that does
  // not throw away either side, and writing the live one alone made the panel
  // announce turn 1 for a conversation that had reached turn 8.
  check('and the turn count is the whole conversation', after?.turns === 8, JSON.stringify(after?.turns))
  check('and the finished turn is the one that just finished', after?.previous?.said === 'this is the new turn', JSON.stringify(after?.previous?.said))
  check('and the skill this process saw is there too', after?.skills?.gamma !== undefined, Object.keys(after?.skills ?? {}).join(','))

  // The panel reads the same document, so it has to print the same count. This
  // is what the person sees: before the fix it said "turn 1" for a session
  // whose file said seven.
  const panel = await host.panel('session-restarted')
  check('the panel counts the turns before the restart too', panel.data?.turn === 8, JSON.stringify(panel.data?.turn))
  const listed = panel.data?.skills?.skills ?? []
  check('the panel lists the skill the previous process loaded', listed.some((row) => row.name === 'alpha') === true, JSON.stringify(listed.map((row) => row.name)))
}


// ---------------------------------------------------------------------------
// A panel polled before the turn ends still sees the history
// ---------------------------------------------------------------------------

{
  // The window this covers is the ordinary one: the host replays a session's
  // events, the person opens the panel, and nothing has finished yet. `record()`
  // builds a transcript from the first event, so a read answered from memory
  // never happened — the panel showed turn 1 for a conversation that had reached
  // seven, and kept doing it until some later turn ended.
  //
  // `load()` is what knows the disk still needs reading, and it is asked
  // unconditionally now. Nothing here waits for a write: the file is seeded and
  // only the read is under test.
  const root = await makeTempRoot('dsse-persist-early-')
  process.env.DSH_HOME = root
  const seed = new SessionStore({ root: stateDir(root) })
  await seed.write('session-early', {
    version: VERSION,
    session: 'session-early',
    state: 1,
    turns: 7,
    previous: {
      turn: 7,
      calls: 4,
      failed: 0,
      paths: [],
      commands: ['npm test'],
      said: 'the turn before the restart',
      tools: []
    },
    skills: { alpha: { via: 'tool', at: 1 } },
    tools: [],
    servers: {},
    sequence: 1
  })

  const host = fakeHost()
  applyPanel(host.ctx, PanelConfig({ panelSummary: false }))
  const session = fakeSession('session-early', 'F:/work')
  host.agents.set(session.id, session)

  // One event, no finished turn, no write — this is the moment someone looks.
  host.emit('session/event', session.session, {
    type: 'user/message',
    seq: 70,
    time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'what happened so far?' }] }
  })

  const panel = await host.panel('session-early')
  // Seven from the file, plus the turn this event just opened. A count of one
  // here is the failure this test exists for.
  check('the panel counts the turns the file holds', panel.data?.turn === 8, JSON.stringify(panel.data?.turn))
  const listed = panel.data?.skills?.skills ?? []
  check('and it lists the skill loaded before the restart', listed.some((row) => row.name === 'alpha') === true, JSON.stringify(listed.map((row) => row.name)))
}

// ---------------------------------------------------------------------------
// A turn that ends is a reason to write, on its own
// ---------------------------------------------------------------------------

{
  // The panel exists to describe the turn that finished. A session that only
  // talked — no skill, no MCP tool — leaves nothing else to trigger a write, so
  // if the end of a turn is not itself a reason, that conversation comes back
  // empty after a restart. It is also the common case, not the corner one.
  const root = await makeTempRoot('dsse-persist-talk-')
  process.env.DSH_HOME = root

  const host = fakeHost()
  applyPanel(host.ctx, PanelConfig({ panelSummary: false }))
  const session = fakeSession('session-just-talked')
  host.agents.set(session.id, session)
  work(host, session, { said: 'I read the file and it was fine.' })

  const path = join(stateDir(root), `${session.id}.json`)
  check('a turn that finished on its own is written down', await waitForFile(path), `no file at ${path}`)

  const store = new SessionStore({ root: stateDir(root) })
  const stored = await store.read(session.id)
  check('the file carries the finished turn with nothing else in it', stored?.previous?.turn === 1, JSON.stringify(stored)?.slice(0, 200))

  const second = fakeHost()
  applyPanel(second.ctx, PanelConfig({ panelSummary: false }))
  const reloaded = await second.panel(session.id)
  check('and a restart still finds the turn', reloaded.data?.turn === 1, JSON.stringify(reloaded.data?.turn))
}

// ---------------------------------------------------------------------------
// Disposal is not deletion
// ---------------------------------------------------------------------------

{
  const root = await makeTempRoot('dsse-persist-dispose-')
  process.env.DSH_HOME = root

  const host = fakeHost()
  applyPanel(host.ctx, PanelConfig({ panelSummary: false }))
  const session = fakeSession('session-disposed')
  host.agents.set(session.id, session)
  work(host, session, { skill: 'beta', said: 'Done.' })

  const path = join(stateDir(root), `${session.id}.json`)
  check('the disposal fixture wrote its file', await waitForFile(path), `no file at ${path}`)

  // The host disposes every agent on shutdown. If disposal deleted the file, a
  // restart would find nothing and the panel would be empty — the failure this
  // whole change exists to remove.
  host.emit('agent/disposed', { agent: session })
  await new Promise((resolve) => setTimeout(resolve, 120))

  check('disposal leaves the session file in place', existsSync(path) === true, `the file at ${path} was removed`)
  const afterDispose = await host.panel(session.id)
  check(
    'the panel still describes the disposed session',
    afterDispose.data?.skills?.skills?.some((row) => row.name === 'beta') === true,
    JSON.stringify(afterDispose.data?.skills?.skills)
  )
}

// ---------------------------------------------------------------------------
// Disposal leaves nothing behind in this process
// ---------------------------------------------------------------------------

{
  // `release` can await a read of the disk, and that read ends by handing the
  // stored turn back to the transcript — so a handler that drops the transcript
  // only before the release settles leaves the closed session in memory for the
  // life of the process, and the maps grow with every session the host opens.
  //
  // The arrangement matters. The file has to be on disk *before* this process
  // holds any fact about the session, so that the record has never read: a
  // record that already read never reads again, and its `release` never reaches
  // `restore`. That is the shape a restart has — a file from the last host, then
  // an event from this one — and it is the only shape in which the second half
  // of the disposal handler does anything.
  const root = await makeTempRoot('dsse-persist-memory-')
  process.env.DSH_HOME = root

  const seeded = new SessionStore({ root: stateDir(root) })
  await seeded.write('session-cleared', {
    version: VERSION,
    session: 'session-cleared',
    state: 1,
    turns: 9,
    previous: { turn: 9, calls: 2, failed: 0, paths: [], commands: [], said: 'from the process before this one', tools: [] },
    skills: {}, tools: [], servers: {}, sequence: 0
  })

  const host = fakeHost()
  applyPanel(host.ctx, PanelConfig({ panelSummary: false }))
  const session = fakeSession('session-cleared')
  host.agents.set(session.id, session)
  // One fact of our own, so the record exists and has something to write. It has
  // not read the disk yet: only a panel read or a write does that.
  host.emit('session/event', session.session, {
    type: 'tool/call',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, callId: 'c-own', name: 'skill', arguments: JSON.stringify({ name: 'gamma' }) }
  })

  host.emit('agent/disposed', { agent: session })
  await new Promise((resolve) => setTimeout(resolve, 200))
  await rm(join(stateDir(root), `${session.id}.json`), { force: true })

  const after = await host.panel(session.id)
  check('disposal leaves no turn in memory', after.data?.turn === 0, JSON.stringify(after.data?.turn))
  check('and no skill either', (after.data?.skills?.skills ?? []).length === 0, JSON.stringify(after.data?.skills?.skills))
  check('and no summary of the turn before this process', (after.data?.summary?.text ?? '') === '', JSON.stringify(after.data?.summary))
}

// ---------------------------------------------------------------------------
// Two conversations in one host do not see each other
// ---------------------------------------------------------------------------

{
  const root = await makeTempRoot('dsse-persist-isolation-')
  process.env.DSH_HOME = root

  const host = fakeHost()
  applyPanel(host.ctx, PanelConfig({ panelSummary: false }))
  const one = fakeSession('session-one')
  const two = fakeSession('session-two')
  host.agents.set(one.id, one)
  host.agents.set(two.id, two)

  work(host, one, { skill: 'alpha', tool: 'mcp__zeta__lookup', said: 'first.' })
  work(host, two, { skill: 'beta', tool: 'mcp__omega__fetch', said: 'second.' })

  // Both files, then read each panel. The write is per session, so a race
  // between the two sessions must not let one overwrite the other.
  check('session one wrote a file', await waitForFile(join(stateDir(root), `${one.id}.json`)), 'missing')
  check('session two wrote a file', await waitForFile(join(stateDir(root), `${two.id}.json`)), 'missing')

  const panelOne = await host.panel(one.id)
  const panelTwo = await host.panel(two.id)

  check(
    'session one lists only its own skill',
    panelOne.data?.skills?.skills?.length === 1 && panelOne.data.skills.skills[0].name === 'alpha',
    JSON.stringify(panelOne.data?.skills?.skills)
  )
  check(
    'session two lists only its own skill',
    panelTwo.data?.skills?.skills?.length === 1 && panelTwo.data.skills.skills[0].name === 'beta',
    JSON.stringify(panelTwo.data?.skills?.skills)
  )
  check(
    'session one lists only its own MCP server',
    JSON.stringify((panelOne.data?.mcp ?? []).map((row) => row.server)) === '["zeta"]',
    JSON.stringify(panelOne.data?.mcp)
  )
  check(
    'session two lists only its own MCP server',
    JSON.stringify((panelTwo.data?.mcp ?? []).map((row) => row.server)) === '["omega"]',
    JSON.stringify(panelTwo.data?.mcp)
  )
}

// ---------------------------------------------------------------------------
// Archiving a session takes its file with it
// ---------------------------------------------------------------------------

{
  const root = await makeTempRoot('dsse-persist-archive-')
  process.env.DSH_HOME = root

  // The registry the pruner asks. `sessionKnown` answers true for both sessions
  // so the archive list is the only thing that can remove a file — otherwise a
  // passing test would not say which of the two answers did the work.
  const archived = []
  const services = new Map()
  services.set('workspaceRegistry', {
    archivedSessionIds: archived,
    async sessionKnown() {
      return true
    }
  })

  const host = fakeHost(services)
  applyPanel(host.ctx, PanelConfig({ panelSummary: false }))
  const kept = fakeSession('session-kept')
  const gone = fakeSession('session-archived')
  host.agents.set(kept.id, kept)
  host.agents.set(gone.id, gone)

  work(host, kept, { skill: 'alpha', said: 'kept.' })
  work(host, gone, { skill: 'beta', said: 'archived.' })

  const keptPath = join(stateDir(root), `${kept.id}.json`)
  const gonePath = join(stateDir(root), `${gone.id}.json`)
  check('the kept session wrote a file', await waitForFile(keptPath), 'missing')
  check('the archived session wrote a file', await waitForFile(gonePath), 'missing')

  // The pruner runs on the plugin's own timer, not on an event, because the host
  // announces neither an archive nor a delete. Waiting for the real interval
  // would make this test a minute long, so the state's sweep is reached through
  // the route's own dependency instead: a panel poll after archiving proves the
  // file's fate and the memory's fate agree.
  archived.push(gone.id)
  const store = new SessionStore({ root: stateDir(root) })
  const removed = await store.prune({
    known: (id) => services.get('workspaceRegistry').sessionKnown(id),
    archived: () => archived
  })
  check('the sweep removed exactly the archived session', removed === 1, String(removed))
  check('the archived session file is gone', existsSync(gonePath) === false, `the file at ${gonePath} survived`)
  check('the kept session file is still there', existsSync(keptPath) === true, `the file at ${keptPath} was removed`)

  // The kept session's panel still works after a sweep that touched the same
  // directory — the sweep must not have taken the surviving file with it.
  const panelKept = await host.panel(kept.id)
  check(
    'a sweep leaves the surviving session readable',
    panelKept.data?.skills?.skills?.some((row) => row.name === 'alpha') === true,
    JSON.stringify(panelKept.data?.skills?.skills)
  )
}

// ---------------------------------------------------------------------------
// A session the host does not know is removed; a host that cannot answer is not
// ---------------------------------------------------------------------------

{
  const root = await makeTempRoot('dsse-persist-unknown-')
  process.env.DSH_HOME = root
  const store = new SessionStore({ root: stateDir(root) })
  await mkdir(stateDir(root), { recursive: true })

  // Two sessions on disk that no live agent owns.
  await store.write('session-deleted', { state: 1, skills: {}, tools: [], servers: {}, sequence: 1 })
  await store.write('session-fine', { state: 1, skills: {}, tools: [], servers: {}, sequence: 1 })

  const removed = await store.prune({ known: async (id) => id === 'session-fine' })
  check('a session the host says is gone loses its file', removed === 1, String(removed))
  check('that file is really gone', existsSync(join(stateDir(root), 'session-deleted.json')) === false, 'still there')
  check('the session the host still knows keeps its file', existsSync(join(stateDir(root), 'session-fine.json')) === true, 'was removed')

  // A host that throws is not a host that said no. Deleting on a storage fault
  // would turn a transient error into permanent data loss.
  const before = (await readdir(stateDir(root))).filter((name) => name.endsWith('.json')).sort()
  const afterFault = await store.prune({
    known: async () => {
      throw new Error('storage unavailable')
    }
  })
  const after = (await readdir(stateDir(root))).filter((name) => name.endsWith('.json')).sort()
  check('a host fault removes nothing', afterFault === 0, String(afterFault))
  check('and every file is still in place', JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`)
}

// ---------------------------------------------------------------------------
// A stored file that cannot be believed is not believed
// ---------------------------------------------------------------------------

{
  const root = await makeTempRoot('dsse-persist-corrupt-')
  process.env.DSH_HOME = root
  const dir = stateDir(root)
  await mkdir(dir, { recursive: true })

  const host = fakeHost()
  applyPanel(host.ctx, PanelConfig({ panelSummary: false }))

  // A file that names a different session is the case this guards: a rename or a
  // copy would otherwise make one conversation's panel answer for another.
  await writeFile(join(dir, 'session-wrong.json'), `${JSON.stringify({ state: 1, session: 'somebody-else', previous: { turn: 9 } })}\n`, 'utf8')
  const wrong = await host.panel('session-wrong')
  check('a file naming another session is not used', wrong.data?.turn === 0, JSON.stringify(wrong.data?.turn))

  // Truncated JSON is what a crash during an older non-atomic write looked like.
  await writeFile(join(dir, 'session-broken.json'), '{"state":1,"skills":', 'utf8')
  const broken = await host.panel('session-broken')
  check('an unreadable file does not break the panel', broken.ok === true, JSON.stringify(broken).slice(0, 200))
  check('and it answers as an empty session', broken.data?.turn === 0, JSON.stringify(broken.data?.turn))

  // The write path itself must not be able to produce that: what lands is one
  // line of JSON, so a partially written file cannot be mistaken for a document.
  const store = new SessionStore({ root: dir })
  await store.write('session-clean', { state: 1, sequence: 1 })
  const raw = await readFile(join(dir, 'session-clean.json'), 'utf8')
  check('a written file is one line of JSON', raw.trimEnd().includes('\n') === false, JSON.stringify(raw).slice(0, 200))
  check('and it parses', JSON.parse(raw).session === 'session-clean', raw.slice(0, 200))
}

// ---------------------------------------------------------------------------
// A registry that is not ready yet must not take the sweep with it
// ---------------------------------------------------------------------------

{
  const root = await makeTempRoot('dsse-persist-unready-')
  process.env.DSH_HOME = root
  const dir = stateDir(root)
  await mkdir(dir, { recursive: true })

  const store = new SessionStore({ root: dir })
  await store.write('session-kept', { state: 1, skills: {}, tools: [], servers: {}, sequence: 1 })
  await store.write('session-deleted', { state: 1, skills: {}, tools: [], servers: {}, sequence: 1 })

  // A cordis service is provided before its `init` resolves, so a plugin that
  // starts early can hold a registry that exists but cannot answer yet. This is
  // that registry: every read of the archive list throws.
  const services = new Map()
  services.set('workspaceRegistry', {
    get archivedSessionIds() {
      throw new Error('workspace registry is not started yet')
    },
    async sessionKnown(id) {
      return id !== 'session-deleted'
    }
  })

  // The sweep is a one-minute timer. Waiting for it would make this test a
  // minute long, so the interval is captured instead: what is under test is what
  // the tick does, not how often it fires.
  const ticks = []
  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  globalThis.setInterval = (callback, ms) => {
    ticks.push({ callback, ms })
    // The plugin unrefs its timer and clears it on dispose; this stand-in does
    // neither, so it must not keep the event loop alive on its own.
    const timer = { id: undefined }
    return timer
  }
  const rejections = []
  const onRejection = (error) => rejections.push(error)
  process.on('unhandledRejection', onRejection)
  try {
    const host = fakeHost(services)
    applyPanel(host.ctx, PanelConfig({ panelSummary: false }))
    check('the panel registered a sweep', ticks.length === 1, String(ticks.length))
    check('and it waits a minute between sweeps', ticks[0]?.ms === 60 * 1000, String(ticks[0]?.ms))

    // A synchronous throw here is an uncaught exception in the host's main
    // process: `setInterval` callbacks have no caller to catch it.
    let threw = undefined
    try {
      ticks[0].callback()
    } catch (error) {
      threw = error
    }
    check('a registry that cannot answer does not throw out of the tick', threw === undefined, String(threw))

    // Let the sweep it started finish. The store's work here is one directory
    // listing and two unlinks, so this is a generous margin rather than a race
    // with a real deadline.
    await new Promise((resolve) => realSetTimeout(resolve, 200))
    check('and the sweep still removed the session the host says is gone', existsSync(join(dir, 'session-deleted.json')) === false, 'still there')
    check('while the one it still knows keeps its file', existsSync(join(dir, 'session-kept.json')) === true, 'was removed')
    check('and no rejection escaped the tick', rejections.length === 0, rejections.map(String).join('|'))
  } finally {
    globalThis.setInterval = realSetInterval
    process.off('unhandledRejection', onRejection)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
