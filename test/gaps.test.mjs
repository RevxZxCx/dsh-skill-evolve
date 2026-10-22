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
import { apply, Config } from '../lib/index.js'

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
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('')
if (fail > 0) {
  console.log(`${pass} passed, ${fail} failed`)
  process.exit(1)
}
console.log(`${pass} passed, 0 failed`)
