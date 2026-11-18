/**
 * Tests for the three gaps this plugin shipped without at first:
 *
 * 1. revising an existing skill instead of only creating new ones,
 * 2. candidates that go stale before anybody looks at them,
 * 3. approval as a two-step handshake rather than an instant write.
 *
 * These run end to end against a fake host because the interesting failures
 * live in the wiring, not in the pure rules — `candidates.test.mjs` already
 * covers the rules themselves.
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../packages/skill-evolve/lib/index.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/**
 * A fake host exposing only the surface this plugin touches, plus a
 * `sessionQuery` whose `listSessions` can be swapped per scenario.
 */
function fakeHost(options = {}) {
  const handlers = new Map()
  const tools = new Map()
  const commands = new Map()
  const contexts = new Map()
  const agents = new Map()
  const sessions = new Set(options.sessions ?? [])

  const ctx = {
    logger: { info: () => {} },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(register) {
      return register()
    },
    provide(name, value) {
      const scope = { [name]: value }
      Object.assign(ctx, scope)
      return () => {
        delete ctx[name]
      }
    },
    inject(names, callback) {
      const missing = names.filter((name) => ctx[name] === undefined)
      if (missing.length > 0) return undefined
      return callback(ctx)
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      }
    },
    commands: {
      register(command) {
        commands.set(command.name, command)
        return () => commands.delete(command.name)
      }
    },
    systemPrompt: {
      context(entry) {
        contexts.set(entry.name, entry)
        return () => contexts.delete(entry.name)
      }
    },
    agents: {
      roots: () => [...agents.values()],
      get: (id) => agents.get(id)
    },
    sessionQuery: {
      listSessions: async () => [...sessions].map((id) => ({ header: { id }, live: true, persisted: true }))
    }
  }

  return {
    ctx,
    tools,
    commands,
    contexts,
    agents,
    emit(event, ...payload) {
      for (const handler of handlers.get(event) ?? []) handler(...payload)
    }
  }
}

function fakeAgent(id, cwd) {
  const events = []
  return {
    id,
    session: {
      id,
      header: { id, cwd, version: 4, createdAt: Date.now(), isSeeded: false },
      ownEvents: () => events,
      snapshotEvents: () => events,
      log: events
    },
    push(event) {
      events.push(event)
      return event
    }
  }
}

console.log('gaps.js — revisions, staleness, two-step approval')

const root = await mkdtemp(join(tmpdir(), 'skill-evolve-gaps-'))
process.env.DSH_HOME = root
const skillsRoot = join(root, 'skills')

try {
  const evidence = [
    { class: 'user', quote: 'please use the 300 dpi OCR path for these scans' },
    { class: 'action', quote: 'bash pdftotext scanned.pdf' }
  ]

  // ---------------------------------------------------------------- seeding --
  const host = fakeHost({ sessions: ['session-one'] })
  apply(host.ctx, Config({ mode: 'suggest' }))
  const agent = fakeAgent('session-one', 'F:/project')
  host.agents.set(agent.id, agent)
  agent.push({ type: 'user/message', seq: 1, time: Date.now(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: evidence[0].quote }] } })
  agent.push({ type: 'tool/call', seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"pdftotext scanned.pdf"}' } })

  const submit = host.tools.get('skill_candidate_submit')
  const listTool = host.tools.get('skill_candidate_list')

  const first = await submit.execute({
    name: 'scanned-pdf-tables',
    description: 'Extract tables from scanned PDFs that have no text layer.',
    body: '## When to use\nScanned PDF.\n\n## Procedure\n1. OCR at 300 dpi.\n\n## Pitfalls\npdftotext returns nothing.',
    evidence
  }, { agent })
  check('the first proposal is a create', first.ok === true && first.kind === 'create', JSON.stringify(first).slice(0, 200))

  // ------------------------------------------------------- two-step approval --
  const staged = await host.commands.get('skill-capture').handler({ rawInput: 'scanned-pdf-tables', agent })
  check('approval is staged by default', staged.kind === 'success' && staged.text.includes('final version on its next step'), staged.text.slice(0, 200))
  check('staging writes nothing', await fileExists(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md')) === false)

  const premature = await submit.execute({
    name: 'elsewhere', description: 'x'.repeat(12), body: 'y', evidence, final: true
  }, { agent })
  check('a final write for an unknown candidate is refused', premature.ok === false && premature.code === 'not-pending', JSON.stringify(premature).slice(0, 200))

  const finalWrite = await submit.execute({
    name: 'scanned-pdf-tables',
    description: 'Extract tables from scanned PDFs that have no text layer.',
    body: '## When to use\nScanned PDF.\n\n## Procedure\n1. OCR at 300 dpi.\n\n## Pitfalls\npdftotext returns nothing.',
    evidence,
    final: true
  }, { agent })
  check('the final write lands after approval', finalWrite.ok === true && finalWrite.final === true, JSON.stringify(finalWrite).slice(0, 240))
  check('the file exists after the final write', await fileExists(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md')))

  const unapproved = await submit.execute({
    name: 'scanned-pdf-tables',
    description: 'second attempt without approval',
    body: 'b',
    evidence,
    final: true
  }, { agent })
  check('a final write without approval is refused', unapproved.ok === false, JSON.stringify(unapproved).slice(0, 200))

  // ------------------------------------------------------------ revisions --
  const revision = await submit.execute({
    name: 'scanned-pdf-tables',
    description: 'Extract tables from scanned PDFs, with the layout-first path.',
    body: '## When to use\nScanned PDF.\n\n## Procedure\n1. Layout detection first.\n2. Then OCR at 300 dpi.\n\n## Pitfalls\nOCR-first loses column boundaries.',
    evidence
  }, { agent })
  check('proposing over an owned skill is a revision, not a collision', revision.ok === true && revision.kind === 'update', JSON.stringify(revision).slice(0, 240))

  const queued = JSON.parse(await readFile(join(root, 'plugin-data', 'skill-evolve', 'candidates.json'), 'utf8'))
  const revisionEntry = queued.find((entry) => entry.name === 'scanned-pdf-tables')
  check('the revision records the base it was written against', typeof revisionEntry?.base?.digest === 'string', JSON.stringify(revisionEntry?.base).slice(0, 200))
  check('the base keeps the existing lifecycle record', revisionEntry?.base?.stage === 'unverified', String(revisionEntry?.base?.stage))

  const beforeUses = (await readFile(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md'), 'utf8')).match(/evolved-uses: "(\d+)"/)
  check('the seeded skill records zero uses', beforeUses?.[1] === '0', String(beforeUses?.[1]))

  const approveRevision = await host.commands.get('skill-capture').handler({ rawInput: 'scanned-pdf-tables', agent })
  check('a revision is approvable', approveRevision.kind === 'success', JSON.stringify(approveRevision).slice(0, 200))
  const finalRevision = await submit.execute({
    name: 'scanned-pdf-tables',
    description: 'Extract tables from scanned PDFs, with the layout-first path.',
    body: '## When to use\nScanned PDF.\n\n## Procedure\n1. Layout detection first.\n2. Then OCR at 300 dpi.\n\n## Pitfalls\nOCR-first loses column boundaries.',
    evidence,
    final: true
  }, { agent })
  check('the revision is written', finalRevision.ok === true && finalRevision.kind === 'update', JSON.stringify(finalRevision).slice(0, 240))

  const revised = await readFile(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md'), 'utf8')
  check('the revision replaced the body', revised.includes('Layout detection first'), revised.slice(0, 300))
  check('the revision kept the original id', revised.includes(revisionEntry.base.id) || revised.includes('evolved-id'), revised.slice(0, 300))

  // ------------------------------------------------------------ staleness --
  const staleHost = fakeHost({ sessions: ['session-two'] })
  apply(staleHost.ctx, Config({ mode: 'suggest', verifyCandidateSource: true }))
  const staleAgent = fakeAgent('session-two', 'F:/project')
  staleHost.agents.set(staleAgent.id, staleAgent)
  staleAgent.push({ type: 'user/message', seq: 1, time: Date.now(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'use 300 dpi and check the log' }] } })

  // A candidate whose session still exists can be approved.
  await staleHost.tools.get('skill_candidate_submit').execute({
    name: 'live-candidate', description: 'a candidate from this session', body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }]
  }, { agent: staleAgent })
  const liveReview = await staleHost.commands.get('skill-review').handler({ rawInput: '', agent: staleAgent })
  check('a fresh candidate is listed as approvable', liveReview.text.includes('live-candidate') && !liveReview.text.includes('stale candidate'), liveReview.text.slice(0, 300))

  // Forge one whose session is gone, as if it survived a cleanup.
  const queuePath = join(root, 'plugin-data', 'skill-evolve', 'candidates.json')
  const queue = JSON.parse(await readFile(queuePath, 'utf8'))
  queue.push({
    id: 'orphan-1',
    name: 'orphan-candidate',
    kind: 'create',
    description: 'proposed in a session that no longer exists',
    body: 'b',
    evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }],
    sessionId: 'session-deleted',
    workspace: 'F:/project',
    createdAt: new Date().toISOString(),
    source: 'model'
  })
  await writeFile(queuePath, JSON.stringify(queue, null, 2), 'utf8')

  const orphanedReview = await staleHost.commands.get('skill-review').handler({ rawInput: '', agent: staleAgent })
  check('a candidate from a dead session is flagged', orphanedReview.text.includes('no longer available'), orphanedReview.text.slice(0, 400))

  const orphanedApprove = await staleHost.commands.get('skill-capture').handler({ rawInput: 'orphan-candidate', agent: staleAgent })
  check('a stale candidate cannot be approved', orphanedApprove.kind === 'success' && orphanedApprove.text.includes('cannot be approved'), orphanedApprove.text.slice(0, 240))
  check('the stale refusal names the reason', orphanedApprove.text.includes('no longer available'), orphanedApprove.text.slice(0, 240))

  const orphanedFinal = await staleHost.tools.get('skill_candidate_submit').execute({
    name: 'orphan-candidate', description: 'd', body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }], final: true
  }, { agent: staleAgent })
  check('a final write to a stale candidate is refused', orphanedFinal.ok === false, JSON.stringify(orphanedFinal).slice(0, 240))

  // An expired candidate is refused even when its session is fine.
  const expired = JSON.parse(await readFile(queuePath, 'utf8'))
  expired.push({
    id: 'old-1',
    name: 'ancient-candidate',
    kind: 'create',
    description: 'proposed three months ago',
    body: 'b',
    evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }],
    sessionId: 'session-two',
    workspace: 'F:/project',
    createdAt: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
    source: 'model'
  })
  await writeFile(queuePath, JSON.stringify(expired, null, 2), 'utf8')
  const expiredEntry = JSON.parse(await readFile(queuePath, 'utf8')).find((entry) => entry.name === 'ancient-candidate')
  check('the expired candidate is seeded', expiredEntry !== undefined)

  const expiredReview = await staleHost.commands.get('skill-review').handler({ rawInput: '', agent: staleAgent })
  check('an old candidate is reported as expired', expiredReview.text.includes('ancient-candidate') && /day\(s\) ago/.test(expiredReview.text), expiredReview.text.slice(0, 400))

  // A candidate whose name got taken while it waited is refused.
  await mkdir(join(skillsRoot, 'taken-name'), { recursive: true })
  await writeFile(join(skillsRoot, 'taken-name', 'SKILL.md'), '---\nname: "taken-name"\ndescription: "appeared later"\n---\n\nbody\n', 'utf8')
  const takenQueue = JSON.parse(await readFile(queuePath, 'utf8'))
  takenQueue.push({
    id: 'taken-1',
    name: 'taken-name',
    kind: 'create',
    description: 'proposed before the name was taken',
    body: 'b',
    evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }],
    sessionId: 'session-two',
    workspace: 'F:/project',
    createdAt: new Date().toISOString(),
    source: 'model'
  })
  await writeFile(queuePath, JSON.stringify(takenQueue, null, 2), 'utf8')
  const takenReview = await staleHost.commands.get('skill-review').handler({ rawInput: '', agent: staleAgent })
  check('a candidate whose name was taken is flagged', takenReview.text.includes('taken-name') && takenReview.text.includes('exists now'), takenReview.text.slice(0, 400))

  // --------------------------------------------------------- direct mode --
  const directHost = fakeHost({ sessions: ['session-three'] })
  apply(directHost.ctx, Config({ mode: 'suggest', approvalMode: 'direct' }))
  const directAgent = fakeAgent('session-three', 'F:/project')
  directHost.agents.set(directAgent.id, directAgent)
  directAgent.push({ type: 'user/message', seq: 1, time: Date.now(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'always run the tests before committing here' }] } })

  await directHost.tools.get('skill_candidate_submit').execute({
    name: 'direct-write', description: 'a skill approved in one step', body: 'b', evidence: [{ class: 'user', quote: 'always run the tests before committing here' }]
  }, { agent: directAgent })
  const directApprove = await directHost.commands.get('skill-capture').handler({ rawInput: 'direct-write', agent: directAgent })
  check('direct mode approves in one step', directApprove.kind === 'success' && directApprove.text.includes('wrote'), directApprove.text.slice(0, 200))
  check('direct mode writes the file immediately', await fileExists(join(skillsRoot, 'direct-write', 'SKILL.md')))

  // ---------------------------------------------------------- queue caching --
  // Reading the queue used to list every session once per candidate. A fresh
  // plugin instance starts with a cold cache, so `listings` counts exactly the
  // reads that reached the host.
  let listings = 0
  const cacheHost = fakeHost({ sessions: ['session-two'] })
  const listSessions = cacheHost.ctx.sessionQuery.listSessions
  cacheHost.ctx.sessionQuery.listSessions = async () => {
    listings += 1
    return listSessions()
  }
  apply(cacheHost.ctx, Config({ mode: 'suggest', verifyCandidateSource: true }))
  const cacheAgent = fakeAgent('session-two', 'F:/project')
  cacheHost.agents.set(cacheAgent.id, cacheAgent)
  cacheAgent.push({ type: 'user/message', seq: 1, time: Date.now(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'use 300 dpi and check the log' }] } })

  for (const name of ['cache-a', 'cache-b', 'cache-c']) {
    await cacheHost.tools.get('skill_candidate_submit').execute({
      name, description: 'a candidate for the cache test', body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }]
    }, { agent: cacheAgent })
  }

  const cacheList = cacheHost.tools.get('skill_candidate_list')
  const quiet = listings
  const readOne = await cacheList.execute({}, { agent: cacheAgent })
  check('one read lists the sessions once, not once per candidate', listings - quiet === 1, `${listings - quiet} listing(s)`)
  check('the read still returns every candidate', /cache-c/.test(readOne.text) && /cache-a/.test(readOne.text), String(readOne.text).slice(0, 200))

  // The first read is allowed to miss the cache: it may have written verdicts,
  // and an answer computed against content that then changed is not reusable.
  // What matters is that a settled queue stops costing a listing per read.
  await cacheList.execute({}, { agent: cacheAgent })
  const settled = listings
  await cacheList.execute({}, { agent: cacheAgent })
  await cacheList.execute({}, { agent: cacheAgent })
  check('a settled queue costs one listing, not one per read', listings === settled, `${listings - settled} extra listing(s)`)

  // A candidate appended through the store invalidates immediately: the
  // revision is compared, not a timestamp, so no read may lag behind a write.
  const beforeWrite = listings
  await cacheHost.tools.get('skill_candidate_submit').execute({
    name: 'cache-d', description: 'appended after the cache filled', body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }]
  }, { agent: cacheAgent })
  const afterWrite = await cacheList.execute({}, { agent: cacheAgent })
  check('a write through the store invalidates the cached queue', listings > beforeWrite, 'no re-listing after a write')
  check('the appended candidate is visible', /cache-d/.test(afterWrite.text), String(afterWrite.text).slice(0, 200))

  // The one write path the revision cannot see: something outside this process
  // edits the file. The stamp catches it without a full re-read of the queue.
  const externalPath = join(root, 'plugin-data', 'skill-evolve', 'candidates.json')
  const external = JSON.parse(await readFile(externalPath, 'utf8'))
  external.push({
    id: 'external-1', name: 'external-candidate', kind: 'create', description: 'appended by something else',
    body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }],
    sessionId: 'session-two', workspace: 'F:/project', createdAt: new Date().toISOString(), source: 'model'
  })
  await writeFile(externalPath, JSON.stringify(external, null, 2), 'utf8')
  const afterExternal = await cacheList.execute({}, { agent: cacheAgent })
  check('a queue edited underneath the cache is noticed', /external-candidate/.test(afterExternal.text), String(afterExternal.text).slice(0, 200))

  // Three readers arriving together share one read. That is not an optimisation
  // for its own sake: the panel route, the badge and the dialog all ask within
  // a few hundred milliseconds, and without single-flight the second and third
  // queue behind the mutation lock to repeat work the first already did.
  //
  // The cache is invalidated first on purpose. Three readers hitting a warm
  // cache proves nothing about sharing — they would each be served from memory
  // — so the state has to be a genuine miss for all three at once.
  const racePath = join(root, 'plugin-data', 'skill-evolve', 'candidates.json')
  const raced = JSON.parse(await readFile(racePath, 'utf8'))
  raced.push({
    id: 'race-1', name: 'race-candidate', kind: 'create', description: 'appended to force a miss',
    body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }],
    sessionId: 'session-two', workspace: 'F:/project', createdAt: new Date().toISOString(), source: 'model'
  })
  await writeFile(racePath, JSON.stringify(raced, null, 2), 'utf8')
  const joined = listings
  const concurrent = await Promise.all([
    cacheList.execute({}, { agent: cacheAgent }),
    cacheList.execute({}, { agent: cacheAgent }),
    cacheList.execute({}, { agent: cacheAgent })
  ])
  // Exactly one, not "at most one". Zero means the invalidation above did not
  // land and all three readers were served from the pre-write cache -- which is
  // the failure this block was written to detect, and `<= 1` accepted it.
  check('concurrent readers share one listing', listings - joined === 1, `${listings - joined} listing(s) for three readers`)
  check('every concurrent reader gets an answer', concurrent.every((result) => typeof result?.text === 'string' && result.text.length > 0), JSON.stringify(concurrent.map((result) => typeof result?.text)))

  // The rows come out of the cache now, so a consumer that edits what it was
  // handed must not be editing the cache. The panel treats the rows it gets as
  // its own and has no reason to copy before touching them.
  //
  // A row that is actually stale is planted first. Every earlier candidate in this
  // queue is live, so the `stale` half of this check used to run against
  // `handed[0].stale === undefined` and never executed at all -- replacing the
  // `{ ...candidate.stale }` copy with the shared object left the whole block
  // green, which was only visible in the failure JSON.
  const stalePath = join(root, 'plugin-data', 'skill-evolve', 'candidates.json')
  const withStale = JSON.parse(await readFile(stalePath, 'utf8'))
  withStale.push({
    id: 'stale-1', name: 'stale-candidate', kind: 'create', description: 'its session is gone',
    body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }],
    sessionId: 'session-that-no-longer-exists', workspace: 'F:/project', createdAt: new Date().toISOString(), source: 'model'
  })
  await writeFile(stalePath, JSON.stringify(withStale, null, 2), 'utf8')

  // Read once before the read that gets tampered with: the first read after a file
  // change recomputes and writes verdicts back, so its answer is deliberately not
  // cached. Tampering with that answer proves nothing about the cache.
  await cacheHost.ctx.skillEvolve.listCandidates()
  const handed = await cacheHost.ctx.skillEvolve.listCandidates()
  const handedStaleAt = handed.findIndex((row) => row?.stale !== undefined && row?.stale !== null)
  const handedEvidenceAt = handed.findIndex((row) => Array.isArray(row?.evidence))
  check('a stale row is on hand to tamper with', handedStaleAt >= 0, JSON.stringify(handed.map((row) => row?.stale?.reason ?? null)))
  check('a row with evidence is on hand to tamper with', handedEvidenceAt >= 0, 'no evidence array in any row')
  const handedEvidence = handed[handedEvidenceAt]?.evidence
  if (Array.isArray(handedEvidence)) handedEvidence.push({ class: 'user', quote: 'appended by a consumer' })
  if (handedStaleAt >= 0) handed[handedStaleAt].stale.reason = 'tampered'
  const reread = await cacheHost.ctx.skillEvolve.listCandidates()
  const evidenceKept = handedEvidenceAt < 0 || (Array.isArray(reread[handedEvidenceAt]?.evidence) && reread[handedEvidenceAt].evidence.length === handedEvidence.length - 1)
  const staleKept = handedStaleAt < 0 || reread[handedStaleAt]?.stale?.reason !== 'tampered'
  check('a consumer editing the rows does not edit the cache', evidenceKept && staleKept, JSON.stringify({ evidence: reread[handedEvidenceAt]?.evidence?.length, stale: reread[handedStaleAt]?.stale?.reason }))

  // A listing that fails must not condemn anything: an outage is not evidence
  // that sixteen sessions were deleted.
  let failNext = true
  const outageHost = fakeHost({ sessions: ['session-two'] })
  const healthyList = outageHost.ctx.sessionQuery.listSessions
  outageHost.ctx.sessionQuery.listSessions = async () => {
    if (failNext) {
      failNext = false
      throw new Error('session listing unavailable')
    }
    return healthyList()
  }
  apply(outageHost.ctx, Config({ mode: 'suggest', verifyCandidateSource: true }))
  const outageAgent = fakeAgent('session-two', 'F:/project')
  outageHost.agents.set(outageAgent.id, outageAgent)
  outageAgent.push({ type: 'user/message', seq: 1, time: Date.now(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'use 300 dpi and check the log' }] } })
  await outageHost.tools.get('skill_candidate_submit').execute({
    name: 'outage-survivor', description: 'must not be condemned by an outage', body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }]
  }, { agent: outageAgent })
  const outageRead = await outageHost.tools.get('skill_candidate_list').execute({}, { agent: outageAgent })
  check('a failed listing does not mark candidates stale', /outage-survivor — .*verified in session-two/.test(outageRead.text), String(outageRead.text).slice(0, 300))

  // A listing that answers with something that is not a list is the same
  // situation as one that throws, and it has to be treated the same way: no
  // answer is not an answer. The bulk path ignores a non-array (so no set is
  // pre-resolved), which means the per-candidate fallback is what judges the
  // rows — and it has to bail out too, or the one moment the host is
  // misbehaving is the moment the queue decides every session is gone.
  let nonsenseCalls = 0
  const nonsenseHost = fakeHost({ sessions: ['session-two'] })
  // Every call answers with nonsense, not just the first: the guard that has
  // to hold is the per-candidate fallback, and a one-shot nonsense would be
  // repaired by the next call before that fallback ever ran.
  nonsenseHost.ctx.sessionQuery.listSessions = async () => {
    nonsenseCalls += 1
    return undefined
  }
  apply(nonsenseHost.ctx, Config({ mode: 'suggest', verifyCandidateSource: true }))
  const nonsenseAgent = fakeAgent('session-two', 'F:/project')
  nonsenseHost.agents.set(nonsenseAgent.id, nonsenseAgent)
  nonsenseAgent.push({ type: 'user/message', seq: 1, time: Date.now(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'use 300 dpi and check the log' }] } })
  await nonsenseHost.tools.get('skill_candidate_submit').execute({
    name: 'nonsense-survivor', description: 'must not be condemned by a nonsense listing', body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }]
  }, { agent: nonsenseAgent })
  const nonsenseRead = await nonsenseHost.tools.get('skill_candidate_list').execute({}, { agent: nonsenseAgent })
  check('a listing that answers with nonsense does not mark candidates stale', /nonsense-survivor — .*verified in session-two/.test(nonsenseRead.text), String(nonsenseRead.text).slice(0, 300))
  // The survivor above only means something if the nonsense was actually
  // produced: a build that never asked would also leave the row alive, and
  // that is the shape of assertion that stays green through the bug it names.
  check('the nonsense listing was really asked for', nonsenseCalls >= 1, `${nonsenseCalls} listing(s)`)

  // The approval path re-verifies its own candidate instead of trusting the
  // verdict the dialog was drawn from. The cache is what makes that necessary:
  // between the read that filled the dialog and the click that approves, the
  // queue can be served from memory while the fact the write depends on has
  // already moved.
  const driftHost = fakeHost({ sessions: ['session-two'] })
  apply(driftHost.ctx, Config({ mode: 'suggest', verifyCandidateSource: true }))
  const driftAgent = fakeAgent('session-two', 'F:/project')
  driftHost.agents.set(driftAgent.id, driftAgent)
  driftAgent.push({ type: 'user/message', seq: 1, time: Date.now(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'use 300 dpi and check the log' }] } })
  await driftHost.tools.get('skill_candidate_submit').execute({
    name: 'drift-candidate', description: 'approved after the ground moved', body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }]
  }, { agent: driftAgent })
  // Warm the cache twice: the first read may write verdicts, and a read that
  // wrote anything is deliberately not cached. Only the second read leaves an
  // answer in memory, which is the state this test is about.
  await driftHost.tools.get('skill_candidate_list').execute({}, { agent: driftAgent })
  await driftHost.tools.get('skill_candidate_list').execute({}, { agent: driftAgent })
  // The session disappears without anyone touching the candidate file.
  driftHost.ctx.sessionQuery.listSessions = async () => []
  // The command rejects rather than returning a refusal, so the assertion has
  // to read the rejection: what matters is that the approval did not go
  // through and that the reason names the thing that moved.
  let driftText = ''
  try {
    const refused = await driftHost.commands.get('skill-capture').handler({ rawInput: 'drift-candidate', agent: driftAgent })
    driftText = String(refused?.text ?? '')
  } catch (error) {
    driftText = String(error?.message ?? error)
  }
  check('an approval re-checks the session even when the queue was cached', /cannot be approved|cannot approve/.test(driftText), driftText.slice(0, 240))
  check('the re-check names the missing session', driftText.includes('no longer available'), driftText.slice(0, 240))

  // The same window has a second half that no queue guard covers: the skill
  // catalog is not `candidates.json`, so a skill appearing under this name
  // never touches the cache at all. Approving must not overwrite it.
  // `direct` and not the default `confirm`: under `confirm` an approval only
  // stages the candidate and writes nothing, so "the file was not overwritten"
  // would be true whether or not the re-check ran. Direct mode is where the
  // write actually happens, which is the only place the re-check can be seen.
  const takeoverHost = fakeHost({ sessions: ['session-two'] })
  apply(takeoverHost.ctx, Config({ mode: 'suggest', verifyCandidateSource: true, approvalMode: 'direct' }))
  const takeoverAgent = fakeAgent('session-two', 'F:/project')
  takeoverHost.agents.set(takeoverAgent.id, takeoverAgent)
  takeoverAgent.push({ type: 'user/message', seq: 1, time: Date.now(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'use 300 dpi and check the log' }] } })
  await takeoverHost.tools.get('skill_candidate_submit').execute({
    name: 'contested-name', description: 'proposed before the name was taken', body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }]
  }, { agent: takeoverAgent })
  await takeoverHost.tools.get('skill_candidate_list').execute({}, { agent: takeoverAgent })
  await takeoverHost.tools.get('skill_candidate_list').execute({}, { agent: takeoverAgent })
  await mkdir(join(skillsRoot, 'contested-name'), { recursive: true })
  await writeFile(join(skillsRoot, 'contested-name', 'SKILL.md'), '---\nname: "contested-name"\ndescription: "someone else wrote this"\n---\n\nnot ours\n', 'utf8')
  let takeoverText = ''
  try {
    const refused = await takeoverHost.commands.get('skill-capture').handler({ rawInput: 'contested-name', agent: takeoverAgent })
    takeoverText = String(refused?.text ?? '')
  } catch (error) {
    takeoverText = String(error?.message ?? error)
  }
  // Naming the reason, not just the refusal: the staged-success path also
  // prints "Approved ...", so a loose `/cannot approve/` alternation would
  // stay green on an unfixed build for the wrong reason. `exists now` is
  // `evaluateStaleness`'s own `name-taken` detail.
  check('an approval re-checks the name even when the queue was cached', /cannot be approved|cannot approve/.test(takeoverText) && /name taken/.test(takeoverText) && /exists now/.test(takeoverText), takeoverText.slice(0, 240))
  const survived = await readFile(join(skillsRoot, 'contested-name', 'SKILL.md'), 'utf8')
  check('the skill that took the name is not overwritten', survived.includes('not ours'), survived.slice(0, 200))

  // The re-check is only as good as what it is standing on. `probeSkill` used
  // to answer `{ exists: false }` for any read failure, so a skill file this
  // code could not parse read as "the name is free" and the approval wrote
  // over it -- the very overwrite the re-check exists to stop. A file with no
  // frontmatter is the cheapest real way to make the read fail for a reason
  // that is not ENOENT.
  const opaqueHost = fakeHost({ sessions: ['session-two'] })
  apply(opaqueHost.ctx, Config({ mode: 'suggest', verifyCandidateSource: true, approvalMode: 'direct' }))
  const opaqueAgent = fakeAgent('session-two', 'F:/project')
  opaqueHost.agents.set(opaqueAgent.id, opaqueAgent)
  opaqueAgent.push({ type: 'user/message', seq: 1, time: Date.now(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'use 300 dpi and check the log' }] } })
  await opaqueHost.tools.get('skill_candidate_submit').execute({
    name: 'opaque-name', description: 'proposed before an unreadable file appeared', body: 'b', evidence: [{ class: 'user', quote: 'use 300 dpi and check the log' }]
  }, { agent: opaqueAgent })
  await opaqueHost.tools.get('skill_candidate_list').execute({}, { agent: opaqueAgent })
  await opaqueHost.tools.get('skill_candidate_list').execute({}, { agent: opaqueAgent })
  await mkdir(join(skillsRoot, 'opaque-name'), { recursive: true })
  const opaquePath = join(skillsRoot, 'opaque-name', 'SKILL.md')
  await writeFile(opaquePath, 'no frontmatter, so this cannot be parsed\n', 'utf8')
  let opaqueText = ''
  try {
    const refused = await opaqueHost.commands.get('skill-capture').handler({ rawInput: 'opaque-name', agent: opaqueAgent })
    opaqueText = String(refused?.text ?? '')
  } catch (error) {
    opaqueText = String(error?.message ?? error)
  }
  check('an unreadable skill file stops the approval instead of reading as absent', /could not verify/.test(opaqueText), opaqueText.slice(0, 240))
  const opaqueSurvived = await readFile(opaquePath, 'utf8')
  check('the file the read could not parse is left alone', opaqueSurvived.includes('no frontmatter'), opaqueSurvived.slice(0, 200))
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('')
if (fail > 0) {
  console.log(`${pass} passed, ${fail} failed`)
  process.exit(1)
}
console.log(`${pass} passed, 0 failed`)
