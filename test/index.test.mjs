/**
 * End-to-end test: mount the plugin against a fake host and drive it through
 * one complete cycle.
 *
 * The fake mirrors the host's real contracts (several were read from the
 * asar): events arrive as `session/event(session, event)`, tools register
 * plain objects, commands must return `{kind, text}`, and a prompt context
 * whose `text` resolves to `''` is dropped.
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

/**
 * Build a fake Cordis context with the surface this plugin touches.
 */
function fakeHost() {
  const handlers = new Map()
  const tools = new Map()
  const commands = new Map()
  const contexts = new Map()
  const effects = []
  const agents = new Map()
  const logs = []

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
    // Mirrors cordis: the callback runs once every named service resolves, in
    // a child context. The fake host has all of them at mount time.
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
        if (!/^[a-z][a-z0-9_-]*$/.test(command.name)) throw new Error(`bad command name ${command.name}`)
        if (typeof command.description !== 'string' || command.description.trim().length === 0) throw new Error('command needs description')
        if (typeof command.handler !== 'function') throw new Error('command needs handler')
        commands.set(command.name, command)
        return () => commands.delete(command.name)
      }
    },
    systemPrompt: {
      context(entry) {
        if (!Number.isFinite(entry.order)) throw new TypeError('order must be finite')
        contexts.set(entry.name, entry)
        return () => contexts.delete(entry.name)
      }
    },
    agents: {
      roots: () => [...agents.values()].filter((agent) => agent.parent === undefined),
      get: (id) => agents.get(id)
    }
  }

  return {
    ctx,
    handlers,
    tools,
    commands,
    contexts,
    agents,
    logs,
    emit(event, ...payload) {
      for (const handler of handlers.get(event) ?? []) handler(...payload)
    }
  }
}

/**
 * Build a fake agent holding a session with a transcript and a cwd.
 */
function fakeAgent(id, cwd) {
  const events = []
  const agent = {
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
  return agent
}

/**
 * Build a tool/call event the way the host really emits it.
 */
function toolCall(toolName, callId) {
  return {
    type: 'tool/call',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, callId, name: toolName, arguments: '{}' }
  }
}

const root = await mkdtemp(join(tmpdir(), 'skill-evolve-e2e-'))
process.env.DSH_HOME = root
const skillsRoot = join(root, 'skills')

console.log('index.js — end to end')

try {
  const host = fakeHost()
  const config = Config({ mode: 'suggest', minRepeatCount: 2, minWindow: 3, maxHintsPerSession: 4 })
  apply(host.ctx, config)

  const agent = fakeAgent('session-abc', 'F:/some/project')
  host.agents.set(agent.id, agent)
  // The transcript the evidence gate will search.
  agent.push({ type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: 'The PDF has no text layer, so pdftotext returns nothing. Use OCR instead.' }], source: { kind: 'user' } } })
  agent.push({ type: 'tool/result', seq: 2, data: { message: { role: 'tool', content: [{ type: 'text', text: 'ocr_scan.py --dpi 300 wrote 12 rows to table.csv' }] } } })

  check('three tools registered', host.tools.size === 3, [...host.tools.keys()].join(','))
  check('four commands registered', host.commands.size === 4, [...host.commands.keys()].join(','))
  check('hint context registered', host.contexts.has('skill-evolve:hint'))
  check('hint context order is 121', host.contexts.get('skill-evolve:hint')?.order === 121)
  check('hint starts empty', host.contexts.get('skill-evolve:hint').text({ agent }) === '')

  // ---- detection -----------------------------------------------------------
  const procedure = ['bash', 'read', 'edit', 'bash', 'read', 'edit']
  for (const [index, toolName] of procedure.entries()) {
    host.emit('session/event', agent.session, toolCall(toolName, `call_${index}`))
  }
  const hint = host.contexts.get('skill-evolve:hint').text({ agent })
  check('a repeated procedure produces a hint', hint.length > 0, hint.slice(0, 80))
  check('the hint names the tool chain', hint.includes('bash → read → edit'), hint)
  check('the hint points at the submit tool', hint.includes('skill_candidate_submit'))
  check('the hint asks for a verbatim quote', hint.includes('verbatim'))
  check('the hint names the dead-end rule', hint.toLowerCase().includes('failed'), hint)

  // A second reminder for the same procedure must not appear.
  for (const [index, toolName] of procedure.entries()) {
    host.emit('session/event', agent.session, toolCall(toolName, `again_${index}`))
  }
  check('the same procedure is only hinted once', host.logs.filter((line) => line.includes('hint published')).length === 1, String(host.logs.filter((line) => line.includes('hint published')).length))

  // A subagent must not receive hints.
  const sub = fakeAgent('session-sub', 'F:/some/project')
  sub.parent = agent
  host.agents.set(sub.id, sub)
  for (const [index, toolName] of procedure.entries()) {
    host.emit('session/event', sub.session, toolCall(toolName, `sub_${index}`))
  }
  check('subagents get no hint', host.contexts.get('skill-evolve:hint').text({ agent: sub }) === '')

  // ---- evidence gate -------------------------------------------------------
  const submit = host.tools.get('skill_candidate_submit')
  const goodEvidence = [
    { class: 'user', quote: 'The PDF has no text layer, so pdftotext returns nothing.' },
    { class: 'tool', quote: 'ocr_scan.py --dpi 300 wrote 12 rows to table.csv' }
  ]

  const fabricated = await submit.execute({
    name: 'scanned-pdf-tables',
    description: 'Extract tables from scanned PDFs that have no text layer.',
    body: '## When to use\nScanned PDF, no text layer.\n\n## Procedure\n1. Run OCR at 300 dpi.\n2. Parse rows.\n\n## Pitfalls\npdftotext returns nothing here; do not trust its empty output.',
    evidence: [{ class: 'user', quote: 'Please always use the OCR pipeline for these files.' }]
  }, { agent })
  check('an invented quote is rejected', fabricated.ok === false && fabricated.code === 'no-verified-evidence', JSON.stringify(fabricated).slice(0, 200))
  check('the rejection quotes the invented text back', fabricated.error.includes('Please always use the OCR pipeline'), fabricated.error.slice(0, 200))
  check('the rejection explains the rule', fabricated.error.includes('character for character'))

  const selfOnly = await submit.execute({
    name: 'scanned-pdf-tables',
    description: 'Extract tables from scanned PDFs.',
    body: 'Do the thing.',
    evidence: [{ class: 'self', quote: 'OCR at 300 dpi wrote 12 rows' }]
  }, { agent })
  check('self-only evidence cannot support a skill', selfOnly.ok === false && selfOnly.code === 'no-verified-evidence', JSON.stringify(selfOnly).slice(0, 160))

  const badName = await submit.execute({
    name: 'Not_A_Name', description: 'x'.repeat(10), body: 'y', evidence: goodEvidence
  }, { agent })
  check('a non-kebab name is rejected', badName.ok === false && badName.code === 'bad-name')

  const noEvidence = await submit.execute({
    name: 'ok-name', description: 'x'.repeat(10), body: 'y', evidence: []
  }, { agent })
  check('missing evidence is rejected', noEvidence.ok === false && noEvidence.code === 'no-evidence')

  const queued = await submit.execute({
    name: 'scanned-pdf-tables',
    description: 'Extract tables from scanned PDFs that have no text layer.',
    body: '## When to use\nScanned PDF, no text layer.\n\n## Procedure\n1. Run OCR at 300 dpi.\n2. Parse rows.\n\n## Pitfalls\npdftotext returns nothing here.',
    evidence: goodEvidence
  }, { agent })
  check('a real submission is queued', queued.ok === true && queued.autoWritten === false, JSON.stringify(queued).slice(0, 200))
  check('queueing reports verified quotes', queued.survived === 2, String(queued.survived))
  // The reported path is what the model quotes back to the user, so it has to
  // name a file that actually exists. A plausible-looking path under a
  // nonexistent directory is worse than no path at all.
  check('the reported queue path exists on disk', await fileExists(queued.path), String(queued.path))
  check('nothing was written on submit', await fileExists(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md')) === false)

  const duplicate = await submit.execute({
    name: 'scanned-pdf-tables', description: 'dupe', body: 'b', evidence: goodEvidence
  }, { agent })
  check('a duplicate candidate is refused', duplicate.ok === false && duplicate.code === 'already-pending')

  // ---- approval ------------------------------------------------------------
  const listed = await host.tools.get('skill_candidate_list').execute({}, { agent })
  check('the queue is listable', listed.text.includes('scanned-pdf-tables'), listed.text.slice(0, 120))

  const review = await host.commands.get('skill-review').handler({ rawInput: '', agent })
  check('the review command succeeds', review.kind === 'success', JSON.stringify(review).slice(0, 120))
  check('the review command shows the candidate', review.text.includes('scanned-pdf-tables'))

  const preview = await host.commands.get('skill-capture').handler({ rawInput: 'scanned-pdf-tables --preview', agent })
  check('preview returns the body without writing', preview.kind === 'success' && preview.text.includes('Run OCR at 300 dpi'))
  check('preview wrote nothing', await fileExists(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md')) === false)

  // The default approval mode is a two-step handshake: the human's yes is
  // recorded here, and the model writes the final body on its next step so it
  // can re-read the catalog first. Nothing lands in the skill directory yet.
  const approved = await host.commands.get('skill-capture').handler({ rawInput: 'scanned-pdf-tables', agent })
  check('approval succeeds', approved.kind === 'success', JSON.stringify(approved).slice(0, 200))
  check('approval stages rather than writes', approved.text.includes('final version on its next step'), approved.text.slice(0, 200))
  check('nothing is written by approval alone', await fileExists(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md')) === false)
  check('the queue still holds it until the final write', (await host.commands.get('skill-review').handler({ rawInput: '', agent })).text.includes('APPROVED'))

  const finalWrite = await host.tools.get('skill_candidate_submit').execute({
    name: 'scanned-pdf-tables',
    description: 'Extract tables from scanned PDFs that have no text layer.',
    body: '## When to use\nScanned PDF, no text layer.\n\n## Procedure\n1. Run OCR at 300 dpi.\n2. Parse rows.\n\n## Pitfalls\npdftotext returns nothing here.',
    evidence: goodEvidence,
    final: true
  }, { agent })
  check('the final write succeeds once approved', finalWrite.ok === true, JSON.stringify(finalWrite).slice(0, 240))
  check('the final write reports the file it wrote', finalWrite.final === true && typeof finalWrite.path === 'string')

  const written = await readFile(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md'), 'utf8')
  check('the skill file exists', written.includes('name: "scanned-pdf-tables"'), written.slice(0, 120))
  check('the file carries the ownership marker', written.includes('dsh-skill-evolve'), written.slice(0, 200))
  check('the file records stage unverified', written.includes('"unverified"'))
  check('the file records zero uses', written.includes('evolved-uses: "0"'))
  check('the queue was drained', (await host.commands.get('skill-review').handler({ rawInput: '', agent })).text.includes('No skill candidates'))

  // ---- ownership fence -----------------------------------------------------
  await mkdir(join(skillsRoot, 'hand-written'), { recursive: true })
  await writeFile(join(skillsRoot, 'hand-written', 'SKILL.md'), '---\nname: "hand-written"\ndescription: "written by a human"\n---\n\nDo not touch.\n', 'utf8')
  const collide = await host.tools.get('skill_candidate_submit').execute({
    name: 'hand-written', description: 'x', body: 'y', evidence: goodEvidence
  }, { agent })
  check('colliding with a hand-written skill is refused', collide.ok === false && collide.code === 'exists', JSON.stringify(collide).slice(0, 160))
  check('the refusal says it will not overwrite', collide.error.includes('never rewrites'), collide.error)

  const foreignFeedback = await host.tools.get('skill_feedback').execute({ name: 'hand-written', verdict: 'helpful' }, { agent })
  check('feedback on a foreign skill is refused', foreignFeedback.ok === false)

  // ---- lifecycle -----------------------------------------------------------
  const feedbackTool = host.tools.get('skill_feedback')
  for (let index = 0; index < 3; index += 1) {
    await feedbackTool.execute({ name: 'scanned-pdf-tables', verdict: 'helpful' }, { agent })
  }
  const promoted = await readFile(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md'), 'utf8')
  const promotedState = promoted.match(/evolved-stage: "([a-z]+)"/)
  check('three helpful reports promote to active', promotedState?.[1] === 'active', promotedState?.[1])
  check('uses accumulated in the file', promoted.includes('evolved-uses: "3"'), promoted.match(/evolved-uses.*/)?.[0])

  for (let index = 0; index < 3; index += 1) {
    await feedbackTool.execute({ name: 'scanned-pdf-tables', verdict: 'harmful', note: 'the OCR dpi was wrong for this file' }, { agent })
  }
  const inverted = await readFile(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md'), 'utf8')
  const invertedState = inverted.match(/evolved-stage: "([a-z]+)"/)
  check('three harmful reports invert the skill', invertedState?.[1] === 'inverted', invertedState?.[1])
  check('the inverted file opens with a warning', inverted.includes('PITFALL'), inverted.slice(0, 200))
  check('the inverted file keeps the original instructions', inverted.includes('Run OCR at 300 dpi'))
  check('the inverted file states the harmful count', inverted.includes('3 times'))

  // Every feedback report rewrote the same file. A `FileHandle` keeps its
  // offset after a read and `truncate(0)` does not rewind it, so writing the
  // new text used to leave `oldLength` NUL bytes in front of the frontmatter.
  // The file still parsed — the frontmatter scan starts at the first `---` —
  // which is exactly why this needs its own assertion instead of a parse check.
  const rawBytes = await readFile(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md'))
  check('rewriting a skill does not leave NUL padding', rawBytes.includes(0) === false, `first NUL at ${rawBytes.indexOf(0)}`)
  check('the rewritten file still starts with its frontmatter', rawBytes.subarray(0, 3).toString('utf8') === '---', rawBytes.subarray(0, 12).toString('utf8'))

  const stats = await host.commands.get('skill-stats').handler({ rawInput: '', agent })
  check('stats lists the managed skill', stats.kind === 'success' && stats.text.includes('scanned-pdf-tables'))
  check('stats shows the inverted stage', stats.text.includes('inverted'), stats.text)

  // ---- hint clearing -------------------------------------------------------
  host.emit('session/event', agent.session, toolCall('skill_candidate_list', 'clear_1'))
  check('acting on the hint clears it', host.contexts.get('skill-evolve:hint').text({ agent }) === '')

  // ---- command results are always well formed -----------------------------
  const badUsage = await host.commands.get('skill-capture').handler({ rawInput: '', agent })
  check('empty capture input returns a valid result', badUsage.kind === 'success' && badUsage.text.includes('Usage'))
  const missing = await host.commands.get('skill-capture').handler({ rawInput: 'no-such-thing', agent })
  check('unknown candidate returns a valid result', missing.kind === 'success' && missing.text.includes('No candidate'))
  const unknownFeedback = await host.commands.get('skill-feedback').handler({ rawInput: 'x', agent })
  check('bad feedback usage returns a valid result', unknownFeedback.kind === 'success' && unknownFeedback.text.includes('Usage'))
  const emptyStats = await host.commands.get('skill-stats').handler({ rawInput: '', agent })
  check('stats is always a valid result', emptyStats.kind === 'success')

  // ---- auto mode -----------------------------------------------------------
  const autoRoot = await mkdtemp(join(tmpdir(), 'skill-evolve-auto-'))
  process.env.DSH_HOME = autoRoot
  const autoHost = fakeHost()
  apply(autoHost.ctx, Config({ mode: 'auto' }))
  const autoAgent = fakeAgent('session-auto', 'F:/p')
  autoAgent.push({ type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: 'Always run the linter before committing here.' }], source: { kind: 'user' } } })
  const autoResult = await autoHost.tools.get('skill_candidate_submit').execute({
    name: 'lint-before-commit',
    description: 'Run the linter before committing.',
    body: '## Procedure\nRun pnpm lint before git commit.',
    evidence: [{ class: 'user', quote: 'Always run the linter before committing here.' }]
  }, { agent: autoAgent })
  check('auto mode writes on submit', autoResult.ok === true && autoResult.autoWritten === true, JSON.stringify(autoResult).slice(0, 160))
  check('auto mode really wrote the file', await fileExists(join(autoRoot, 'skills', 'lint-before-commit', 'SKILL.md')))
  await rm(autoRoot, { recursive: true, force: true })

  // ---- the turn trigger ----------------------------------------------------
  //
  // This is the Qoder-shaped half of the design: reflect at the end of a real
  // conversation turn, so that semantic lessons (a correction, a library
  // pitfall) can be captured even when no tool sequence ever repeats.
  const turnRoot = await mkdtemp(join(tmpdir(), 'skill-evolve-turn-'))
  process.env.DSH_HOME = turnRoot
  const turnHost = fakeHost()
  apply(turnHost.ctx, Config({ mode: 'suggest' }))
  const turnAgent = fakeAgent('session-turn', 'F:/p2')
  turnHost.agents.set(turnAgent.id, turnAgent)
  const turnHint = () => turnHost.contexts.get('skill-evolve:hint').text({ agent: turnAgent })

  /** Emit one human message plus `calls` tool calls. */
  const humanTurn = (calls) => {
    turnHost.emit('session/event', turnAgent.session, {
      type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' } }
    })
    for (let i = 0; i < calls; i += 1) {
      turnHost.emit('session/event', turnAgent.session, toolCall('bash', `turn_${i}_${Math.random()}`))
    }
  }
  const endTurn = (kind = 'completed') => {
    turnHost.emit('session/event', turnAgent.session, {
      type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind } }
    })
  }

  check('the turn hint starts empty', turnHint() === '')

  // Host-injected messages must not advance the cadence.
  for (let i = 0; i < 6; i += 1) {
    turnHost.emit('session/event', turnAgent.session, {
      type: 'user/message', seq: 1, data: { source: { kind: 'runtime-context' } }
    })
    turnHost.emit('session/event', turnAgent.session, toolCall('bash', `inj_${i}`))
  }
  endTurn()
  check('host-injected messages do not fire a reflection', turnHint() === '')

  // One real turn with plenty of work: still under cadence 3.
  humanTurn(5)
  endTurn()
  check('one real turn is under the cadence', turnHint() === '')

  // An aborted turn is not a moment to ask what was learned.
  humanTurn(5)
  endTurn('aborted')
  check('an aborted turn does not fire a reflection', turnHint() === '')

  // Third real turn, completed, with substance.
  humanTurn(5)
  endTurn()
  check('the third real turn fires a reflection', turnHint().includes('[skill-evolve]'))
  check('the reflection asks the three questions', turnHint().includes('Did the person correct me'))
  check('the reflection is not the repetition hint', turnHint().includes('repeated this session') === false)

  // Acting on the hint clears the visible text.
  turnHost.emit('session/event', turnAgent.session, toolCall('skill_candidate_list', 'clear_turn'))
  check('acting on the reflection clears it', turnHint() === '')

  // Cadence is measured from the last reflection, not from session start.
  // Cadence doubles after each reflection: 3 turns, then 6.
  for (let i = 0; i < 5; i += 1) {
    humanTurn(5)
    endTurn()
  }
  check('five turns are not enough for the second checkpoint', turnHint() === '')
  humanTurn(5)
  endTurn()
  check('six turns fire the second reflection', turnHint().includes('[skill-evolve]'))
  turnHost.emit('session/event', turnAgent.session, toolCall('skill_candidate_list', 'clear_turn2'))

  // The per-session budget is 2 by default, so twelve more turns fire nothing.
  for (let t = 0; t < 12; t += 1) {
    humanTurn(5)
    endTurn()
  }
  check('the reflection budget stops further checkpoints', turnHint() === '')

  await rm(turnRoot, { recursive: true, force: true })

  // ---- both triggers together ---------------------------------------------
  //
  // The two triggers see different things, so enabling both must not make
  // either one fire twice as often. Each has its own throttle: the detector
  // dedups by procedure shape, the pacer by turn budget.
  const bothRoot = await mkdtemp(join(tmpdir(), 'skill-evolve-both-'))
  process.env.DSH_HOME = bothRoot
  const bothHost = fakeHost()
  apply(bothHost.ctx, Config({ mode: 'suggest', triggers: ['turn', 'repeat'] }))
  const bothAgent = fakeAgent('session-both', 'F:/p3')
  bothHost.agents.set(bothAgent.id, bothAgent)
  const bothHint = () => bothHost.contexts.get('skill-evolve:hint').text({ agent: bothAgent })
  const send = (name, id) => bothHost.emit('session/event', bothAgent.session, toolCall(name, id))

  // A procedure repeats before any turn ends: the repeat trigger fires first.
  for (const name of ['read', 'grep', 'edit', 'read', 'grep', 'edit']) send(name, `p_${Math.random()}`)
  check('the repeat trigger still fires mid-turn', bothHint().includes('repeated in this conversation'), bothHint().slice(0, 80))
  send('skill_candidate_list', 'clear_both')
  check('clearing works for the repeat hint', bothHint() === '')

  // Now a real turn ends. The reflection must also be able to publish: the
  // repeat hint's steps are a different shape, so dedup must not swallow it.
  bothHost.emit('session/event', bothAgent.session, { type: 'user/message', seq: 1, data: { source: { kind: 'user' } } })
  for (let i = 0; i < 5; i += 1) send('bash', `b_${i}`)
  bothHost.emit('session/event', bothAgent.session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  check('the turn trigger can publish after a repeat hint', bothHint().includes('This turn is a checkpoint') || bothHint() === '', bothHint().slice(0, 80))

  await rm(bothRoot, { recursive: true, force: true })

  // ---- triggers can be turned off individually -----------------------------
  const offRoot = await mkdtemp(join(tmpdir(), 'skill-evolve-off-'))
  process.env.DSH_HOME = offRoot
  const offHost = fakeHost()
  apply(offHost.ctx, Config({ mode: 'suggest', triggers: ['repeat'] }))
  const offAgent = fakeAgent('session-off', 'F:/p4')
  offHost.agents.set(offAgent.id, offAgent)
  const offHint = () => offHost.contexts.get('skill-evolve:hint').text({ agent: offAgent })
  offHost.emit('session/event', offAgent.session, { type: 'user/message', seq: 1, data: { source: { kind: 'user' } } })
  for (let i = 0; i < 5; i += 1) offHost.emit('session/event', offAgent.session, toolCall('bash', `o_${i}`))
  offHost.emit('session/event', offAgent.session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  check('triggers:[repeat] disables the turn reflection', offHint() === '')
  await rm(offRoot, { recursive: true, force: true })

  // ---- a hint shrinks, and only then retires -------------------------------
  //
  // This is the fate the channel originally had no answer for. The model
  // neither submits nor dismisses, so nothing called `clear` and the text rode
  // along in every snapshot. Measured on a complete 44,931-event transcript:
  // 132 snapshots and 79,896 characters of hint text, one procedure riding
  // along for 106 consecutive steps.
  //
  // Deleting the text on a deadline was the first fix and it was wrong: that
  // same session eventually submitted a skill 412 steps in, from a model that
  // re-read the still-present hint. So the text degrades to a pointer that
  // still names the procedure, and retirement is a separate opt-in stage.
  const expRoot = await mkdtemp(join(tmpdir(), 'skill-evolve-expiry-'))
  process.env.DSH_HOME = expRoot
  const expHost = fakeHost()
  apply(expHost.ctx, Config({
    mode: 'suggest',
    minRepeatCount: 2,
    minWindow: 3,
    hintShrinkAfterSteps: 2,
    hintExpiresAfterSteps: 6
  }))
  const expAgent = fakeAgent('session-exp', 'F:/p5')
  expHost.agents.set(expAgent.id, expAgent)
  const expHint = () => expHost.contexts.get('skill-evolve:hint').text({ agent: expAgent })
  const expSend = (name, id) => expHost.emit('session/event', expAgent.session, toolCall(name, id))
  // One assistant message is one step of the model reading the prompt.
  const modelStep = () => expHost.emit('session/event', expAgent.session, {
    type: 'assistant/message',
    seq: 99,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }
  })

  for (const name of ['bash', 'read', 'edit', 'bash', 'read', 'edit']) expSend(name, `e_${Math.random()}`)
  const fullHint = expHint()
  check('the expiry fixture published a hint', fullHint.length > 0, fullHint.slice(0, 60))

  modelStep()
  check('a fresh hint keeps its full text', expHint() === fullHint)
  modelStep()
  const shrunk = expHint()
  check('an ageing hint degrades to a pointer', shrunk.length > 0 && shrunk.length < fullHint.length / 3,
    `${fullHint.length} -> ${shrunk.length}`)
  check('the pointer still names the procedure', shrunk.includes('bash'))
  check('the pointer still names the tool to call', shrunk.includes('skill_candidate_submit'))
  check('shrinking spends no extra budget', expHost.logs.filter((line) => line.includes('hint published')).length === 1)

  modelStep()
  modelStep()
  modelStep()
  check('a shrunk hint is still on offer below the retirement deadline', expHint() === shrunk)
  modelStep()
  check('a silent hint retires at its deadline', expHint() === '')
  check('retiring a hint spends no extra budget', expHost.logs.filter((line) => line.includes('hint published')).length === 1)

  // The tool stays available after expiry, and the procedure is not offered a
  // second time: expiry is a cost control, not a capability loss.
  for (const name of ['bash', 'read', 'edit', 'bash', 'read', 'edit']) expSend(name, `again_${Math.random()}`)
  check('an expired procedure is not re-offered', expHint() === '')
  check('expiry did not unregister the submit tool', expHost.tools.has('skill_candidate_submit'))
  await rm(expRoot, { recursive: true, force: true })

  // Shrinking must be switchable off on its own: the two stages are
  // independent knobs, and an operator may want the full text for the hint's
  // whole life without ever retiring it.
  const keepRoot = await mkdtemp(join(tmpdir(), 'skill-evolve-keep-'))
  process.env.DSH_HOME = keepRoot
  const keepHost = fakeHost()
  apply(keepHost.ctx, Config({
    mode: 'suggest',
    minRepeatCount: 2,
    minWindow: 3,
    hintShrinkAfterSteps: 0,
    hintExpiresAfterSteps: 0
  }))
  const keepAgent = fakeAgent('session-keep', 'F:/p6')
  keepHost.agents.set(keepAgent.id, keepAgent)
  const keepHint = () => keepHost.contexts.get('skill-evolve:hint').text({ agent: keepAgent })
  for (const name of ['bash', 'read', 'edit', 'bash', 'read', 'edit']) {
    keepHost.emit('session/event', keepAgent.session, toolCall(name, `k_${Math.random()}`))
  }
  const kept = keepHint()
  for (let i = 0; i < 200; i += 1) {
    keepHost.emit('session/event', keepAgent.session, {
      type: 'assistant/message',
      seq: 99,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } }
    })
  }
  check('both deadlines off keeps the full text forever', keepHint() === kept && kept.length > 0)
  await rm(keepRoot, { recursive: true, force: true })
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

/**
 * Whether a path exists.
 *
 * @param {string} path - the path.
 * @returns {Promise<boolean>} true when present.
 */
async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
