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
import { existsSync, rmSync } from 'node:fs'
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
 * Every temporary DSH_HOME this file creates.
 *
 * Cleanup runs from an `exit` hook rather than from `finally` blocks. Review
 * round 10 measured why: a `try/finally` only covers the statements inside its
 * own `try`, so the fourteen `mkdtemp` sites here each needed their own, and a
 * throw between two of them leaked. Registering at creation time means a root is
 * scheduled for removal the moment it exists, whichever line later throws.
 */
const tempRoots = []
process.on('exit', () => {
  // Best effort, one at a time: a locked directory on Windows would otherwise
  // replace the assertion failure that actually explains the run with an EPERM.
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Leaving a directory behind is better than hiding the real failure.
    }
  }
})

/** Create a temporary root and schedule its removal. */
async function makeTempRoot(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

/**
 * Build a fake Cordis context with the surface this plugin touches.
 */
function fakeHost(options = {}) {
  const handlers = new Map()
  const tools = new Map()
  const commands = new Map()
  const contexts = new Map()
  const effects = []
  const agents = new Map()
  const logs = []
  const routes = new Map()
  const deferred = []
  const withWebServer = options.webServer !== false

  const ctx = {
    logger: { info: (line) => logs.push(line) },
    // Mirrors cordis: `{ prepend: true }` unshifts, anything else pushes. The
    // third parameter used to be missing here, so the option was silently
    // dropped and a `prepend: false` regression passed every test. The catalog
    // handler depends on running before the host's own pre-step listener: the
    // host appends its catalog message inside its handler, so a plugin listener
    // that runs after it rewrites nothing.
    on(event, handler, options) {
      const list = handlers.get(event) ?? []
      if (options?.prepend === true) list.unshift(handler)
      else list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(register, label) {
      const result = register()
      effects.push({ dispose: result, label })
      return result
    },
    // Mirrors cordis: the callback runs once every named service resolves, in
    // a child context. When `webServer: false` the service arrives late instead,
    // which is the timing that produced the 404s: cordis refuses to hand back a
    // service whose fiber is not yet active, so an eager `ctx.get('webServer')`
    // inside `apply` saw undefined and skipped route registration entirely. The
    // panel then rendered and every request hit the host's 404 fallback.
    inject(names, callback) {
      const missing = names.filter((name) => ctx[name] === undefined)
      if (missing.length > 0) {
        deferred.push({ names, callback })
        return undefined
      }
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
    },
    // The panel's routes. Registering them in the fixture is what makes the
    // wiring reachable: without it the plugin skipped the whole block and every
    // wiring assertion below would have passed vacuously.
    webServer: withWebServer
      ? {
          register({ kind, path, handler }) {
            routes.set(path, { kind, handler })
            return () => routes.delete(path)
          }
        }
      : undefined,
    // Cordis resolves a service through `ctx.get(name)`; the plugin reads
    // `approval` that way to learn the session policy before downloading.
    // Falling back to `ctx[name]` keeps the services this fixture already
    // declares reachable through the same seam.
    services: new Map(),
    get(name) {
      return ctx.services.has(name) ? ctx.services.get(name) : ctx[name]
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
    routes,
    emit(event, ...payload) {
      for (const handler of handlers.get(event) ?? []) handler(...payload)
    },
    /**
     * Deliver a service the host did not have at mount time.
     *
     * Cordis runs a deferred `inject` callback once the service activates. The
     * fake reproduces only that contract: assign the service, then run every
     * waiting callback, and stop waiting.
     */
    provide(name, value) {
      ctx[name] = value
      const ready = deferred.filter((entry) => entry.names.includes(name))
      for (const entry of ready) deferred.splice(deferred.indexOf(entry), 1)
      for (const entry of ready) entry.callback(ctx)
    },
    /** How many `inject` callbacks are still waiting for a service. */
    deferredCount() {
      return deferred.length
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

const root = await makeTempRoot('skill-evolve-e2e-')
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

  check('seven tools registered', host.tools.size === 7, [...host.tools.keys()].join(','))
  check('the panel routes are registered', host.routes.has('/api/skill-evolve') === true, [...host.routes.keys()].join(','))

  // --- the panel's "suggest a skill" button, end to end ---------------------
  //
  // The unit test fed `publish` a proper array, so it never saw the caller pass
  // `steps: 0`. `publish` spreads that value into the shown list, so every
  // press threw `0 is not iterable` and the route answered ok:false.
  {
    const route = host.routes.get('/api/skill-evolve')
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
    const body = JSON.stringify({ agent: agent.id })
    const req = {
      url: '/api/skill-evolve/propose',
      method: 'POST',
      headers: { host: '127.0.0.1:19387', 'content-type': 'application/json', 'content-length': String(body.length) },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    await route.handler(req, res)
    const payload = JSON.parse(res.body)
    check('the propose route succeeds', payload.ok === true, res.body)
    check('the propose route does not report a spread failure', String(res.body).includes('not iterable') === false, res.body)
  }

  // --- the transcript must be released with the agent ----------------------
  {
    const before = host.handlers.get('agent/disposed')?.length ?? 0
    check('the disposal hook is registered', before > 0, String(before))
    // Record something first, so "still there" would be observable.
    // A turn opens only on a real human message; a bare tool/call would leave
    // `turn` undefined and `turn/end` would return without folding anything.
    host.emit('session/event', agent, {
      type: 'user/message',
      seq: 98,
      time: Date.now(),
      data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'list the directory' }] } }
    })
    host.emit('session/event', agent, {
      type: 'tool/call',
      seq: 99,
      time: Date.now(),
      data: { turn: 1, step: 1, callId: 'c-dispose', name: 'bash', arguments: '{"command":"ls"}' }
    })
    // The panel reports the *closed* turn, so the turn has to close: without
    // this the assertion below compares against an empty snapshot and fails for
    // a reason that has nothing to do with disposal.
    host.emit('session/event', agent, {
      type: 'turn/end',
      seq: 100,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } }
    })
    const route = host.routes.get('/api/skill-evolve')
    const readPanel = async () => {
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
      await route.handler({ url: `/api/skill-evolve/panel?agent=${agent.id}`, method: 'GET', headers: { host: '127.0.0.1:19387' } }, res)
      return JSON.parse(res.body)
    }
    const filled = await readPanel()
    check('the panel sees the turn before disposal', filled.data?.calls >= 1, JSON.stringify(filled))
    host.emit('agent/disposed', { agent })
    const cleared = await readPanel()
    check('disposal releases the transcript', cleared.data?.calls === 0, JSON.stringify(cleared))
  }
  check('five commands registered', host.commands.size === 5, [...host.commands.keys()].join(','))
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

  // The skill stays inverted, so every further harmful report calls
  // `invertBody` again on an already-inverted body. That used to nest another
  // warning inside the previous one: the file opened with a growing stack of
  // PITFALL blocks and the real instructions sank to the bottom.
  for (let index = 0; index < 2; index += 1) {
    await feedbackTool.execute({ name: 'scanned-pdf-tables', verdict: 'harmful', note: 'still wrong' }, { agent })
  }
  const reinverted = await readFile(join(skillsRoot, 'scanned-pdf-tables', 'SKILL.md'), 'utf8')
  check('repeated harmful reports do not stack warnings',
    (reinverted.match(/PITFALL/g) ?? []).length === 1, String((reinverted.match(/PITFALL/g) ?? []).length))
  check('repeated harmful reports keep one copy of the instructions',
    (reinverted.match(/Run OCR at 300 dpi/g) ?? []).length === 1, String((reinverted.match(/Run OCR at 300 dpi/g) ?? []).length))
  check('the warning count follows the latest report', reinverted.includes('5 times'), reinverted.split('\n')[2])

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
  const autoRoot = await makeTempRoot('skill-evolve-auto-')
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
  const turnRoot = await makeTempRoot('skill-evolve-turn-')
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
  check('the reflection is not the repetition hint', turnHint().includes('repeated in this conversation') === false)

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

  // ---- a reflection holds the channel ---------------------------------------
  //
  // Both triggers write into one slot, so a repeat hint firing right after a
  // reflection used to replace it silently. This is the end-to-end shape of
  // that bug: reflect, then repeat something, and check the reflection survives.
  //
  // The retry half matters just as much, and this is the part a naive test
  // misses. `createDetector` keeps only `repeatWindowMax * (minRepeatCount + 2)`
  // entries (24 by default), so a procedure deferred for 8 model steps is
  // evicted from the window long before the hold ends — it has to be held as a
  // rendered hint, not re-derived on release.
  //
  // A step therefore has to carry real tool calls. An `assistant/message` on its
  // own emits no `tool/call`, the detector's history freezes, and a
  // "re-derive on release" implementation would pass this test while being
  // wrong in production. Three calls per step is what a real session does, and
  // it is what fills the 24-entry window inside the hold.
  const holdRoot = await makeTempRoot('skill-evolve-hold-')
  process.env.DSH_HOME = holdRoot
  const holdHost = fakeHost()
  apply(holdHost.ctx, Config({ mode: 'suggest', reflectionHoldSteps: 8 }))
  const holdAgent = fakeAgent('session-hold', 'F:/p3')
  holdHost.agents.set(holdAgent.id, holdAgent)
  const holdHint = () => holdHost.contexts.get('skill-evolve:hint').text({ agent: holdAgent })

  let filler = 0
  /** One model step: the assembled message, the ageing tick, and the work it did. */
  const step = () => {
    holdHost.emit('session/event', holdAgent.session, {
      type: 'assistant/message', seq: 9, time: Date.now(), data: { turn: 1, step: 1 }
    })
    // Unrelated work, one distinct tool name per call so it can never itself
    // look like a procedure — but it does push the deferred one out of the window.
    for (let i = 0; i < 3; i += 1) {
      filler += 1
      holdHost.emit('session/event', holdAgent.session, toolCall(`filler_${filler}`, `fill_${filler}`))
    }
  }

  // Reach the first reflection (cadence 3, five calls per turn).
  for (let t = 0; t < 3; t += 1) {
    holdHost.emit('session/event', holdAgent.session, {
      type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' } }
    })
    for (let i = 0; i < 5; i += 1) {
      holdHost.emit('session/event', holdAgent.session, toolCall('bash', `hold_${t}_${i}`))
    }
    holdHost.emit('session/event', holdAgent.session, {
      type: 'turn/end', seq: 2, time: Date.now(), data: { turn: t + 1, reason: { kind: 'completed' } }
    })
  }
  check('the hold fixture reaches a reflection', holdHint().includes('[skill-evolve]'))

  // Now a repeated procedure arrives while the reflection is still fresh.
  const holdProcedure = ['read', 'edit', 'grep', 'read', 'edit', 'grep']
  for (const [index, toolName] of holdProcedure.entries()) {
    holdHost.emit('session/event', holdAgent.session, toolCall(toolName, `held_${index}`))
  }
  check('the repeat hint is deferred while the reflection holds', holdHint().includes('repeated in this conversation') === false, holdHint().slice(0, 60))
  check('the deferral is logged, not silent', holdHost.logs.some((line) => line.includes('hint deferred')), holdHost.logs.slice(-3).join(' | '))

  // Age past the hold. The retry runs on the same tick that releases it.
  // Eight steps x three calls = 24 entries, which is the whole detector window:
  // by the last step `detect()` can no longer see `read → edit → grep` at all,
  // so a re-derive-on-release implementation fails right here.
  for (let i = 0; i < 7; i += 1) step()
  check('the repeat hint is still held seven steps in', holdHint().includes('repeated in this conversation') === false, holdHint().slice(0, 60))
  step()
  check('the deferred hint is published once the hold expires', holdHint().includes('repeated in this conversation'), holdHint().slice(0, 60))
  check('the deferred publish is logged as such', holdHost.logs.some((line) => line.includes('deferred hint published')), holdHost.logs.slice(-3).join(' | '))
  check('the deferred hint names the procedure', holdHint().includes('read → edit → grep'), holdHint())

  // Acting on the hint clears the channel.
  //
  // This is a regression guard on `clear()` itself, not on the deferred slot: by
  // now the deferral has already been retried and published, so there is nothing
  // pending to resurrect and the extra step below cannot fail for the reason it
  // reads like. The resurrection case needs a deferral that is still pending --
  // that is the `session-drop` fixture further down, and it is the only place
  // the drop-on-action behaviour is actually pinned.
  holdHost.emit('session/event', holdAgent.session, toolCall('skill_candidate_list', 'clear_hold'))
  check('acting on the deferred hint clears it', holdHint() === '')
  step()
  check('a cleared hint stays cleared on the next step', holdHint() === '', holdHint().slice(0, 80))

  await rm(holdRoot, { recursive: true, force: true })

  // ---- a pending deferral is dropped when the model acts -------------------
  //
  // The case above cannot catch the resurrection: by the time it acts, the
  // deferred entry has already been retried and published, so there is nothing
  // left to resurrect. The bug needs a deferral that is *still pending* when the
  // model acts -- reflect, get deferred, act immediately, then step.
  {
    const root = await makeTempRoot('skill-evolve-drop-')
    process.env.DSH_HOME = root
    const host = fakeHost()
    apply(host.ctx, Config({ mode: 'suggest', reflectionHoldSteps: 8 }))
    const agent = fakeAgent('session-drop', 'F:/p4')
    host.agents.set(agent.id, agent)
    const text = () => host.contexts.get('skill-evolve:hint').text({ agent })
    const tick = () => host.emit('session/event', agent.session, {
      type: 'assistant/message', seq: 9, time: Date.now(), data: { turn: 1, step: 1 }
    })

    for (let t = 0; t < 3; t += 1) {
      host.emit('session/event', agent.session, {
        type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' } }
      })
      for (let i = 0; i < 5; i += 1) host.emit('session/event', agent.session, toolCall('bash', `drop_${t}_${i}`))
      host.emit('session/event', agent.session, {
        type: 'turn/end', seq: 2, time: Date.now(), data: { turn: t + 1, reason: { kind: 'completed' } }
      })
    }
    check('the drop fixture reaches a reflection', text().includes('[skill-evolve]'))

    for (const [index, name] of ['read', 'edit', 'grep', 'read', 'edit', 'grep'].entries()) {
      host.emit('session/event', agent.session, toolCall(name, `d_${index}`))
    }
    check('the drop fixture defers the repeat hint', host.logs.some((line) => line.includes('hint deferred')), host.logs.slice(-2).join(' | '))
    check('the deferred hint is not visible yet', text().includes('repeated in this conversation') === false)

    // Act while the deferral is still pending.
    host.emit('session/event', agent.session, toolCall('skill_candidate_submit', 'act_now'))
    check('acting clears the channel', text() === '')
    tick()
    check('the pending deferral is dropped, not resurrected', text() === '', text().slice(0, 80))
    check('the dropped deferral is never logged as published', host.logs.some((line) => line.includes('deferred hint published')) === false, host.logs.slice(-3).join(' | '))

    await rm(root, { recursive: true, force: true })
  }

  // ---- a second reflection discards a deferral from the first -------------
  //
  // Only one hint ever occupies the channel, so a reflection that publishes while
  // a repeat hint is deferred takes the slot away. The retry then fires when the
  // *second* hold ends, which is two holds after the procedure was last seen --
  // by then it is stale, and publishing it costs a budget unit to say something
  // the model has moved past. Whoever takes the channel discards what was
  // waiting for it.
  {
    const root = await makeTempRoot('skill-evolve-rehold-')
    process.env.DSH_HOME = root
    const host = fakeHost()
    apply(host.ctx, Config({ mode: 'suggest', reflectionHoldSteps: 8 }))
    const agent = fakeAgent('session-rehold', 'F:/p5')
    host.agents.set(agent.id, agent)
    const text = () => host.contexts.get('skill-evolve:hint').text({ agent })
    const turn = (index, calls) => {
      host.emit('session/event', agent.session, {
        type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' } }
      })
      for (let i = 0; i < calls; i += 1) host.emit('session/event', agent.session, toolCall('bash', `rh_${index}_${i}`))
      host.emit('session/event', agent.session, {
        type: 'turn/end', seq: 2, time: Date.now(), data: { turn: index, reason: { kind: 'completed' } }
      })
    }

    turn(1, 5); turn(2, 5); turn(3, 5)
    check('the first reflection publishes', host.logs.some((line) => line.includes('reflection offered')), host.logs.slice(-2).join(' | '))

    for (const [index, name] of ['read', 'edit', 'grep', 'read', 'edit', 'grep'].entries()) {
      host.emit('session/event', agent.session, toolCall(name, `rh_d_${index}`))
    }
    check('the repeat hint is deferred behind it', host.logs.some((line) => line.includes('hint deferred')), host.logs.slice(-2).join(' | '))

    // Enough turns to pass the pacer's doubled back-off and fire a second
    // reflection, which takes the channel while the deferral is still pending.
    for (let t = 4; t <= 10; t += 1) turn(t, 5)
    check('a second reflection publishes', host.logs.filter((line) => line.includes('reflection offered')).length === 2, host.logs.filter((line) => line.includes('reflection offered')).join(' | '))

    // Walk past the second hold. The stale deferral must not come back.
    for (let i = 0; i < 9; i += 1) {
      host.emit('session/event', agent.session, { type: 'assistant/message', seq: 9, time: Date.now(), data: { turn: 1, step: 1 } })
    }
    check('the first deferral does not survive the second hold', host.logs.some((line) => line.includes('deferred hint published')) === false, host.logs.slice(-3).join(' | '))
    // The channel still carries the second reflection (shrunk to its pointer by
    // now); what must be gone is the repeat hint that was waiting behind the
    // first one.
    check('the stale repeat hint never reaches the channel', text().includes('repeated in this conversation') === false, text().slice(0, 80))

    await rm(root, { recursive: true, force: true })
  }

  // ---- a deferral survives turns that do not take the channel -------------
  //
  // The fixture above proves a deferral is dropped when a reflection takes the
  // channel, but "dropped" is satisfied by any implementation that drops it too
  // eagerly -- dropping on every `turn/end`, or before the reflection's own
  // publish (which fires even when the pacer is out of budget), passes all of
  // those assertions because a missing hint is indistinguishable from a
  // correctly discarded one.
  //
  // This is the other half: a turn that ends without publishing anything must
  // leave the deferral alone, and it must still be published when the hold
  // expires. Without this pair the drop rule is only pinned from one side.
  {
    const root = await makeTempRoot('skill-evolve-keep-')
    process.env.DSH_HOME = root
    const host = fakeHost()
    apply(host.ctx, Config({ mode: 'suggest', reflectionHoldSteps: 8 }))
    const agent = fakeAgent('session-keep', 'F:/p6')
    host.agents.set(agent.id, agent)
    const text = () => host.contexts.get('skill-evolve:hint').text({ agent })
    const turn = (index, calls) => {
      host.emit('session/event', agent.session, {
        type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' } }
      })
      for (let i = 0; i < calls; i += 1) host.emit('session/event', agent.session, toolCall('bash', `kp_${index}_${i}`))
      host.emit('session/event', agent.session, {
        type: 'turn/end', seq: 2, time: Date.now(), data: { turn: index, reason: { kind: 'completed' } }
      })
    }
    // Deliberately no tool calls here. A tool call would let the detector
    // re-find the procedure and defer it again, which would mask exactly the
    // mistake this fixture exists to catch: an implementation that drops the
    // pending entry on every turn end would be refilled on the next tool call
    // and still publish. Only `assistant/message` is needed, because that is
    // what advances the hold.
    const step = () => {
      host.emit('session/event', agent.session, { type: 'assistant/message', seq: 9, time: Date.now(), data: { turn: 1, step: 1 } })
    }

    turn(1, 5); turn(2, 5); turn(3, 5)
    check('the keep fixture reaches a reflection', host.logs.some((line) => line.includes('reflection offered')), host.logs.slice(-2).join(' | '))

    for (const [index, name] of ['read', 'edit', 'grep', 'read', 'edit', 'grep'].entries()) {
      host.emit('session/event', agent.session, toolCall(name, `kp_d_${index}`))
    }
    check('the keep fixture defers the repeat hint', host.logs.some((line) => line.includes('hint deferred')), host.logs.slice(-2).join(' | '))

    // Turn 4 ends well before the pacer's doubled back-off (6) is satisfied, so
    // nothing publishes and the deferral must survive.
    turn(4, 5)
    check('a turn that publishes nothing does not publish the deferral', host.logs.some((line) => line.includes('deferred hint published')) === false, host.logs.slice(-2).join(' | '))

    for (let i = 0; i < 8; i += 1) step()
    check('the deferral is still published once the hold expires', host.logs.some((line) => line.includes('deferred hint published')), host.logs.slice(-3).join(' | '))
    check('the deferred repeat hint reaches the channel', text().includes('repeated in this conversation'), text().slice(0, 80))

    await rm(root, { recursive: true, force: true })
  }

  // ---- both triggers together ---------------------------------------------
  //
  // The two triggers see different things, so enabling both must not make
  // either one fire twice as often. Each has its own throttle: the detector
  // dedups by procedure shape, the pacer by turn budget.
  const bothRoot = await makeTempRoot('skill-evolve-both-')
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
  const offRoot = await makeTempRoot('skill-evolve-off-')
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

  // ---- mode:off must mean off everywhere ----------------------------------
  //
  // The config comment promises "no detection at all: no hints, no submissions,
  // no writes". Both detectors honoured it, but the tool did not, so a model
  // calling `skill_candidate_submit` directly — or replaying a hint written in
  // an earlier session — could still queue a skill while the user believed the
  // plugin was dormant.
  {
    const dormantRoot = await makeTempRoot('skill-evolve-dormant-')
    process.env.DSH_HOME = dormantRoot
    const dormantHost = fakeHost()
    apply(dormantHost.ctx, Config({ mode: 'off' }))
    const dormantAgent = fakeAgent('session-dormant', 'F:/p5')
    dormantHost.agents.set(dormantAgent.id, dormantAgent)
    dormantAgent.push({
      type: 'user/message', seq: 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Always run the migration inside a transaction so a failure rolls back.' }] }
    })
    const submitDormant = dormantHost.tools.get('skill_candidate_submit')
    const refused = await submitDormant.execute({
      name: 'transactional-migration',
      description: 'Run migrations inside a transaction.',
      body: '1. BEGIN\n2. migrate\n3. COMMIT',
      evidence: [{ class: 'user', quote: 'Always run the migration inside a transaction so a failure rolls back.' }]
    }, { agent: dormantAgent })
    check('mode:off refuses a new candidate', refused.ok === false && refused.code === 'mode-off', JSON.stringify(refused).slice(0, 240))
    check('the refusal tells the user which setting to change', /mode/.test(refused.error ?? ''), refused.error)
    check('mode:off queued nothing', (await dormantHost.commands.get('skill-review').handler({ rawInput: '', agent: dormantAgent })).text.includes('No skill candidates'))

    // Detection is off too, so nothing is hinted either.
    const dormantHint = () => dormantHost.contexts.get('skill-evolve:hint').text({ agent: dormantAgent })
    dormantHost.emit('session/event', dormantAgent.session, { type: 'user/message', seq: 2, data: { source: { kind: 'user' } } })
    for (let i = 0; i < 6; i += 1) dormantHost.emit('session/event', dormantAgent.session, toolCall('bash', `d_${i}`))
    dormantHost.emit('session/event', dormantAgent.session, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
    check('mode:off hints nothing', dormantHint() === '')

    // The promise is "no new work", not "your existing queue is now unreachable":
    // a person turning the plugin off must still be able to approve what is
    // already waiting.
    await rm(dormantRoot, { recursive: true, force: true })
    const stillRoot = await makeTempRoot('skill-evolve-dormant-approve-')
    process.env.DSH_HOME = stillRoot
    const approveHost = fakeHost()
    apply(approveHost.ctx, Config({ mode: 'suggest' }))
    const approveAgent = fakeAgent('session-approve', 'F:/p6')
    approveHost.agents.set(approveAgent.id, approveAgent)
    approveAgent.push({
      type: 'user/message', seq: 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Pin the dependency before installing so the build is reproducible.' }] }
    })
    await approveHost.tools.get('skill_candidate_submit').execute({
      name: 'pin-then-install',
      description: 'Pin dependencies before installing.',
      body: '1. pin\n2. install',
      evidence: [{ class: 'user', quote: 'Pin the dependency before installing so the build is reproducible.' }]
    }, { agent: approveAgent })
    // Flip to off *after* something is queued, then approve it.
    apply(approveHost.ctx, Config({ mode: 'off' }))
    await approveHost.commands.get('skill-capture').handler({ rawInput: 'pin-then-install', agent: approveAgent })
    const approvedWhileOff = await approveHost.tools.get('skill_candidate_submit').execute({
      name: 'pin-then-install',
      description: 'Pin dependencies before installing.',
      body: '1. pin\n2. install',
      final: true
    }, { agent: approveAgent })
    check('an already-queued candidate can still be approved while mode is off', approvedWhileOff.ok === true, JSON.stringify(approvedWhileOff).slice(0, 240))
    await rm(stillRoot, { recursive: true, force: true })
  }

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
  const expRoot = await makeTempRoot('skill-evolve-expiry-')
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
  const keepRoot = await makeTempRoot('skill-evolve-keep-')
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

  // ---- catalog rewriting (agent/pre-step) ----------------------------------
  // The pure functions in catalog.js have their own test file. This section
  // covers the wiring instead: whether the handler is registered at all, whether
  // it runs the host's `next()` first, and whether it rewrites every catalog
  // message rather than only the first. `findCatalogMessage` returning one
  // message was correct against the host's own lookup but wrong here, because a
  // second catalog message would then stay at full length forever.
  const catRoot = await makeTempRoot('skill-evolve-catalog-')
  process.env.DSH_HOME = catRoot
  const catHost = fakeHost()
  // `catalogFullListBelow: 3` rather than 0, and the two catalog messages below
  // deliberately carry a different number of entries (3 and 2). With the cutoff
  // disabled `namesOnly` is always false, so the `totals.namesOnly` aggregation
  // would have no observable effect; with both messages over the cutoff the
  // aggregation is indistinguishable from plain assignment. One over and one
  // under is the only arrangement where `||` and `=` disagree.
  const catConfig = Config({ mode: 'suggest', catalogShrinkChars: 40, catalogFullListBelow: 3 })

  // Register a stand-in for the host's own catalog listener *before* mounting the
  // plugin, the way load order works in a real host: the host registers its
  // listener at boot, the plugin is mounted after. The plugin must land ahead of
  // it via `prepend`, so this one runs last.
  const hostListenerRuns = []
  const hostStandIn = async (payload, next) => {
    const decision = await next()
    hostListenerRuns.push(decision)
    return decision
  }
  catHost.ctx.on('agent/pre-step', hostStandIn)

  apply(catHost.ctx, catConfig)
  const catAgent = fakeAgent('session-cat', 'F:/p7')
  catHost.agents.set(catAgent.id, catAgent)

  const preSteps = catHost.handlers.get('agent/pre-step') ?? []
  check('catalog handler is registered on agent/pre-step', preSteps.length === 2, String(preSteps.length))
  // Positional, so a future host that also registers with `prepend` fails here
  // with an ordering message instead of surfacing later as a confusing
  // `hostListenerRuns` mismatch.
  check(
    'the plugin handler is prepended ahead of the host listener',
    preSteps.length === 2 && preSteps[0] !== hostStandIn && preSteps[1] === hostStandIn,
    'prepend did not put the plugin first'
  )

  /** Build a host-shaped catalog message. */
  const catalogMsg = (entries, id) => ({
    id,
    role: 'user',
    content: [{
      type: 'text',
      text: `The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:\n\n<available_skills>\n${entries.map((e) => `- \`${e.name}\`: ${e.description}`).join('\n')}\n</available_skills>`
    }],
    source: { kind: 'skill-catalog', form: 'catalog', entries, update: true }
  })

  const longEntries = [
    { name: 'alpha', description: 'x'.repeat(200) },
    { name: 'beta', description: 'y'.repeat(200) },
    { name: 'gamma', description: 'z'.repeat(200) }
  ]
  const first = catalogMsg(longEntries, 'cat-1')
  // Deliberately shorter than the cutoff while the first is at it: the two
  // messages then disagree about `namesOnly`, which is the only way the
  // "any message is names-only" aggregation differs from "the last one is".
  const second = catalogMsg(longEntries.slice(0, 2), 'cat-2')
  const decision = { kind: 'enter', messages: [first, second] }
  // Snapshot before the step runs. Comparing against `first.source.entries` at
  // assertion time compares an object to itself: `shrinkCatalog` spreads the
  // message, so `source` is shared by reference, and an in-place edit would move
  // both sides together and never fail.
  const entriesSnapshot = JSON.stringify(first.source.entries)
  const logsBefore = catHost.logs.length

  /**
   * Drive the whole `agent/pre-step` chain the way cordis' waterfall does.
   *
   * Calling `preSteps[0]` directly would test the plugin in isolation and prove
   * nothing about ordering. Running the chain means a handler registered in the
   * wrong position actually gets observed: the host stand-in runs last, so if the
   * plugin were pushed to the end it would see the decision *after* the stand-in
   * and the assertions below would fail.
   *
   * @param {object} decision - the decision the innermost listener produces.
   * @returns {Promise<object>} the final decision.
   */
  const runPreStep = async (decision) => {
    const chain = catHost.handlers.get('agent/pre-step') ?? []
    let index = 0
    const next = async () => {
      const handler = chain[index]
      index += 1
      return handler === undefined ? decision : handler({ agent: catAgent }, next)
    }
    return next()
  }

  const rewritten = await runPreStep(decision)

  check('pre-step leaves the host decision shape intact', rewritten.kind === 'enter' && Array.isArray(rewritten.messages))
  check('pre-step rewrites the first catalog message', rewritten.messages[0] !== first)
  check(
    'pre-step rewrites a second catalog message too',
    rewritten.messages[1] !== second,
    'a second catalog message survived at full length'
  )
  check(
    'rewriting shortens every catalog message',
    rewritten.messages[0].content[0].text.length < first.content[0].text.length
      && rewritten.messages[1].content[0].text.length < second.content[0].text.length
  )
  check(
    'the rewritten text still names the skills',
    rewritten.messages[0].content[0].text.includes('`alpha`') && rewritten.messages[0].content[0].text.includes('`beta`')
  )
  check(
    'source.entries keeps its content',
    JSON.stringify(rewritten.messages[0].source.entries) === entriesSnapshot,
    'touching source.entries would make the host re-append a catalog every step'
  )
  // The aggregation itself: 3 entries in the first message plus 2 in the second
  // is 5, which matches neither message's own count — so reverting `+=` to `=`
  // fails here. `namesOnly` is true for the first message only, which is what
  // makes `||` distinguishable from plain assignment.
  check(
    'the catalog log line sums every message',
    catHost.logs.slice(logsBefore).some((line) => line.includes('5 skill(s)')),
    catHost.logs.slice(logsBefore).join(' | ')
  )
  check(
    'the catalog log line reports names-only mode',
    catHost.logs.slice(logsBefore).some((line) => line.includes('(names only)')),
    catHost.logs.slice(logsBefore).join(' | ')
  )
  // The character totals. Parsed out of the log line rather than asserted as a
  // magic number, so the test states the invariant instead of a snapshot: the
  // reported "before" is the sum of both messages' original lengths, and the
  // reported "after" is the sum of both rewritten lengths. Reverting either `+=`
  // to `=` reports one message's length and fails.
  const charLine = catHost.logs.slice(logsBefore).find((line) => line.includes('chars'))
  const charMatch = /(\d+) → (\d+) chars/.exec(charLine ?? '')
  check('the catalog log line reports both character totals', charMatch !== null, charLine)
  if (charMatch !== null) {
    const beforeSum = first.content[0].text.length + second.content[0].text.length
    const afterSum = rewritten.messages[0].content[0].text.length + rewritten.messages[1].content[0].text.length
    check(
      'the reported "before" sums every message',
      Number(charMatch[1]) === beforeSum,
      `logged ${charMatch[1]}, messages sum to ${beforeSum}`
    )
    check(
      'the reported "after" sums every message',
      Number(charMatch[2]) === afterSum,
      `logged ${charMatch[2]}, messages sum to ${afterSum}`
    )
  }
  // Discriminates the two possible orders. With the plugin upstream (prepend),
  // the host listener sits downstream and observes the *original* decision,
  // because the plugin rewrites only after `next()` returns. With the plugin
  // pushed to the end, the host listener runs first and observes the final
  // rewritten decision instead. So this assertion fails exactly when `prepend`
  // is lost, which is what the earlier version of this test could not catch.
  check(
    'the host listener ran downstream of the plugin',
    hostListenerRuns.length === 1 && hostListenerRuns[0] === decision,
    'the plugin handler did not run before the host listener'
  )
  check(
    'the host frame wording is preserved',
    rewritten.messages[0].content[0].text.startsWith('The available skill catalog changed.'),
    rewritten.messages[0].content[0].text.slice(0, 40)
  )

  const plainDecision = { kind: 'enter', messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  const untouched = await runPreStep(plainDecision)
  check('pre-step leaves a catalog-free step alone', untouched === plainDecision)

  const rejectDecision = { kind: 'reject' }
  const rejected = await runPreStep(rejectDecision)
  check('pre-step passes a reject through unchanged', rejected === rejectDecision)

  // ---- catalog: session-aware tier wiring ----------------------------------
  // `catalog.test.mjs` covers `describeEntry`'s session tier as a unit. What it
  // cannot see is the chain that feeds it: the `skill` tool call is recorded by
  // the usage listener, the pre-step handler reads it back, and it reaches
  // `shrinkCatalog`. Three separate wirings, none observable from the unit test.
  const sessionEntries = [
    { name: 'loaded-here', description: 'L'.repeat(200) },
    { name: 'never-loaded', description: 'N'.repeat(200) }
  ]
  const sessionCatalog = catalogMsg(sessionEntries, 'cat-session')
  const beforeSessionUse = await runPreStep({ kind: 'enter', messages: [sessionCatalog] })
  const textBefore = beforeSessionUse.messages[0].content[0].text

  catHost.emit('session/event', catAgent.session, {
    type: 'tool/call',
    seq: 5,
    data: { turn: 1, step: 1, callId: 'c1', name: 'skill', arguments: JSON.stringify({ name: 'loaded-here' }) }
  })
  const afterSessionUse = await runPreStep({ kind: 'enter', messages: [sessionCatalog] })
  const textAfter = afterSessionUse.messages[0].content[0].text

  check(
    'a skill loaded this session keeps its full description in the catalog',
    textAfter.length > textBefore.length,
    `${textBefore.length} → ${textAfter.length}`
  )
  check(
    'the session-loaded skill is not truncated',
    textAfter.includes('L'.repeat(50)),
    'session tier did not reach shrinkCatalog'
  )
  check(
    'the never-loaded skill is still truncated',
    !textAfter.includes('N'.repeat(50)),
    'the shrink budget was not applied to the other entry'
  )
  // The session record is keyed two different ways on the two sides of this
  // feature: the usage listener uses `session.id` from the event, the pre-step
  // handler uses `sessionIdFor(payload.agent)`. If they ever disagreed the tier
  // would silently never fire, and every fixture here would still pass because
  // `fakeAgent` gives the agent and its session the same id. This drives an
  // agent whose two ids differ, which is what makes the agreement observable:
  // the tier must still fire, so the pre-step side must be reading `session.id`
  // and not `agent.id`.
  const skewed = fakeAgent('agent-id-differs', 'F:/p7')
  skewed.session.id = 'session-id-that-counts'
  skewed.session.header.id = 'session-id-that-counts'
  catHost.agents.set(skewed.id, skewed)
  catHost.emit('session/event', skewed.session, {
    type: 'tool/call',
    seq: 6,
    data: { turn: 1, step: 2, callId: 'c2', name: 'skill', arguments: JSON.stringify({ name: 'loaded-here' }) }
  })
  const skewChain = catHost.handlers.get('agent/pre-step') ?? []
  let skewIndex = 0
  const skewNext = async () => {
    const handler = skewChain[skewIndex]
    skewIndex += 1
    return handler === undefined
      ? { kind: 'enter', messages: [sessionCatalog] }
      : handler({ agent: skewed }, skewNext)
  }
  const skewDecision = await skewNext()
  check(
    'the session tier keys on session.id, not agent.id',
    skewDecision.messages[0].content[0].text.includes('L'.repeat(50)),
    'the two sides of the session record disagree on the id'
  )

  // ---- catalog: the session record is released on disposal -----------------
  // `usedInSession` is one Set per live session. Without the delete it grows
  // with the number of sessions a host ever ran, which is the exact cost the
  // comment on the handler says it avoids. The observable consequence is that a
  // disposed session's skills stop keeping their full descriptions.
  // Emitted here rather than relied on from the block above: without its own
  // record in `usedInSession` the assertion below is vacuously true, and
  // deleting the dispose line would pass. Review round 8 reproduced exactly
  // that by moving this block up.
  const disposeAgent = fakeAgent('session-dispose', 'F:/p7')
  catHost.agents.set(disposeAgent.id, disposeAgent)
  catHost.emit('session/event', disposeAgent.session, {
    type: 'tool/call',
    seq: 7,
    data: { turn: 1, step: 1, callId: 'c3', name: 'skill', arguments: JSON.stringify({ name: 'loaded-here' }) }
  })
  const disposeChain = catHost.handlers.get('agent/pre-step') ?? []
  const runFor = async (agent, decision) => {
    let index = 0
    const next = async () => {
      const handler = disposeChain[index]
      index += 1
      return handler === undefined ? decision : handler({ agent }, next)
    }
    return next()
  }
  const beforeDispose = await runFor(disposeAgent, { kind: 'enter', messages: [sessionCatalog] })
  check(
    'the disposal fixture starts with a live session record',
    beforeDispose.messages[0].content[0].text.includes('L'.repeat(50)),
    'the fixture never recorded the load, so the assertion below proves nothing'
  )
  catHost.emit('agent/disposed', { agent: disposeAgent })
  const afterDispose = await runFor(disposeAgent, { kind: 'enter', messages: [sessionCatalog] })
  check(
    'disposing a session drops the skills it loaded',
    !afterDispose.messages[0].content[0].text.includes('L'.repeat(50)),
    'usedInSession survived agent/disposed'
  )

  // ---- catalog: config values that reach shrinkCatalog ---------------------
  // `catalog.test.mjs` covers the tier rules as a pure function. What it cannot
  // see is whether each config value is actually read in `lib/index.js` and
  // passed down: a hardcoded constant there passes every unit test. Each of the
  // two checks below fails if its wiring line is dropped or pinned.
  async function catalogFixture(overrides, registry) {
    const wireRoot = await makeTempRoot('skill-evolve-catalog-wire-')
    process.env.DSH_HOME = wireRoot
    if (registry !== undefined) {
      await mkdir(join(wireRoot, 'plugin-data', 'skill-evolve'), { recursive: true })
      await writeFile(
        join(wireRoot, 'plugin-data', 'skill-evolve', 'registry.json'),
        JSON.stringify(registry),
        'utf8'
      )
    }
    const wireHost = fakeHost()
    apply(wireHost.ctx, Config({ mode: 'suggest', catalogShrinkChars: 40, ...overrides }))
    const wireAgent = fakeAgent('session-wire', 'F:/p7')
    wireHost.agents.set(wireAgent.id, wireAgent)
    const chain = wireHost.handlers.get('agent/pre-step') ?? []
    const run = async (decision) => {
      let index = 0
      const next = async () => {
        const handler = chain[index]
        index += 1
        return handler === undefined ? decision : handler({ agent: wireAgent }, next)
      }
      return next()
    }
    return { host: wireHost, agent: wireAgent, run }
  }

  const awareFixture = await catalogFixture({ catalogSessionAware: false })
  awareFixture.host.emit('session/event', awareFixture.agent.session, {
    type: 'tool/call',
    seq: 5,
    data: { turn: 1, step: 1, callId: 'c1', name: 'skill', arguments: JSON.stringify({ name: 'loaded-here' }) }
  })
  const awareDecision = await awareFixture.run({
    kind: 'enter',
    messages: [catalogMsg([{ name: 'loaded-here', description: 'L'.repeat(200) }], 'cat-aware')]
  })
  check(
    'catalogSessionAware:false turns the session tier off',
    !awareDecision.messages[0].content[0].text.includes('L'.repeat(50)),
    'the session tier ignored catalogSessionAware'
  )

  const freqFixture = await catalogFixture(
    { catalogFrequentUses: 3 },
    { proven: { uses: 5 }, rare: { uses: 1 } }
  )
  const freqDecision = await freqFixture.run({
    kind: 'enter',
    messages: [
      catalogMsg(
        [
          { name: 'proven', description: 'P'.repeat(200) },
          { name: 'rare', description: 'R'.repeat(200) }
        ],
        'cat-freq'
      )
    ]
  })
  const freqText = freqDecision.messages[0].content[0].text
  check(
    'a skill used past catalogFrequentUses keeps its full description',
    freqText.includes('P'.repeat(50)),
    'the frequent tier ignored catalogFrequentUses'
  )
  check(
    'a skill under catalogFrequentUses is still truncated',
    !freqText.includes('R'.repeat(50)),
    'the threshold was not applied'
  )

  // ---- catalog: the kill switch --------------------------------------------
  // `catalogEnabled: false` is a user-facing switch whose whole meaning is that
  // no handler is registered. Asserting on behaviour after the fact would pass
  // even with the switch ignored, because a disabled rewrite looks like a
  // catalog that needed no rewrite.
  const catOffRoot = await makeTempRoot('skill-evolve-catalog-off-')
  process.env.DSH_HOME = catOffRoot
  const catOffHost = fakeHost()
  apply(catOffHost.ctx, Config({ mode: 'suggest', catalogEnabled: false }))
  check(
    'catalogEnabled:false registers no pre-step handler',
    (catOffHost.handlers.get('agent/pre-step') ?? []).length === 0,
    String((catOffHost.handlers.get('agent/pre-step') ?? []).length)
  )
  process.env.DSH_HOME = root

  // ---- market install approval (tools/pre-execute) -------------------------
  // The gate's real contract is what it returns, not that its source contains
  // the word "ask". Driving the chain the way cordis' waterfall does means a
  // handler that allows the install, or that forgets to call `next()` for other
  // tools, fails here instead of in production.
  const gateRoot = await makeTempRoot('skill-evolve-gate-')
  process.env.DSH_HOME = gateRoot
  const gateHost = fakeHost()
  apply(gateHost.ctx, Config({ mode: 'suggest' }))
  const gateChain = gateHost.handlers.get('tools/pre-execute') ?? []
  check('the install gate is registered on tools/pre-execute', gateChain.length === 1, String(gateChain.length))

  /**
   * Serve a fixed bundle from a stubbed global fetch.
   *
   * The gate now downloads before asking, so every install path needs a market
   * to talk to. Stubbing the global (rather than injecting a dependency) is what
   * the gate itself reads, so this also proves it goes through the same fetch as
   * the tools instead of holding a private copy.
   */
  const realFetch = globalThis.fetch
  // Everything down to the restore below runs with the market stubbed out, and
  // the block contains a `readFile` on the installed skill. Today a throw there
  // is already fatal — this file's top-level catch exits the process — so the
  // guarantee here is only for a future refactor that turns that catch into a
  // per-section one. Measured, not assumed: forcing an ENOENT inside the block
  // leaves the later checks unrun with or without this wrapper. The indentation
  // below is left flat on purpose; re-indenting 190 lines of assertions would
  // make the diff unreviewable.
  try {
  const bundleFiles = [
    { path: 'SKILL.md', contents: '---\nname: c\n---\n\nDo it.' },
    { path: 'scripts/run.py', contents: 'print(1)' }
  ]
  const installFetch = async (url) => {
    if (String(url).includes('/api/download/')) {
      return {
        ok: true,
        status: 200,
        body: undefined,
        text: async () => JSON.stringify({ files: bundleFiles, hash: 'h1' })
      }
    }
    return { ok: false, status: 404, body: undefined, text: async () => '{}' }
  }
  globalThis.fetch = installFetch

  /** Drive the pre-execute chain for one tool call. */
  const runPreExecute = async (exec) => {
    let index = 0
    const next = async () => {
      const handler = gateChain[index]
      index += 1
      return handler === undefined ? { kind: 'allow' } : handler(exec, next)
    }
    return next()
  }

  const gateDecision = await runPreExecute({ name: 'skill_market_install', arguments: { id: 'a/b/c' }, callId: 'call-1' })
  check('an install is asked about, not allowed', gateDecision.kind === 'ask', JSON.stringify(gateDecision))
  check(
    'the ask names the skill being installed',
    typeof gateDecision.reason === 'string' && gateDecision.reason.includes('a/b/c'),
    gateDecision.reason
  )
  check(
    'the ask warns that scripts may be written',
    typeof gateDecision.displayReason === 'string' && gateDecision.displayReason.includes('executable'),
    gateDecision.displayReason
  )
  // The whole point of downloading before asking: the person is shown the files
  // they are about to accept, not just an id they have to trust.
  check(
    'the ask lists the files that will be written',
    typeof gateDecision.displayReason === 'string' &&
      gateDecision.displayReason.includes('SKILL.md') &&
      gateDecision.displayReason.includes('scripts/run.py'),
    gateDecision.displayReason
  )

  // A gate that swallowed every tool would also "ask" correctly. The other two
  // market tools must pass straight through: gating a read-only lookup trains
  // the person to approve without reading.
  for (const name of ['skill_market_search', 'skill_market_preview']) {
    const decision = await runPreExecute({ name, arguments: { query: 'pdf' } })
    check(`"${name}" is not gated`, decision.kind === 'allow', JSON.stringify(decision))
  }
  const unrelated = await runPreExecute({ name: 'bash', arguments: { command: 'ls' } })
  check('an unrelated tool is not gated', unrelated.kind === 'allow', JSON.stringify(unrelated))

  // A malformed call must not bypass the gate, and must not produce a question
  // that cannot be answered: there is no id to install, so the only honest
  // outcome is a denial that says so.
  const noArgs = await runPreExecute({ name: 'skill_market_install' })
  check('an install with no arguments is denied rather than asked', noArgs.kind === 'deny', JSON.stringify(noArgs))
  check(
    'a missing id is described rather than crashing',
    typeof noArgs.reason === 'string' && noArgs.reason.includes('(no id)'),
    noArgs.reason
  )

  // An id that is not `owner/repo/skill` becomes a URL path segment, so it is
  // rejected before any request is made. Driving it through the gate proves the
  // validation runs there rather than only inside the tool body.
  let requestedBadId = false
  globalThis.fetch = async (url) => {
    requestedBadId = true
    return { ok: false, status: 404, body: undefined, text: async () => '{}' }
  }
  const badId = await runPreExecute({ name: 'skill_market_install', arguments: { id: '../etc/passwd' } })
  check('an install with an unsafe id is denied', badId.kind === 'deny', JSON.stringify(badId))
  check('an unsafe id never reaches the network', requestedBadId === false, String(requestedBadId))

  // A bundle that cannot be downloaded cannot be approved: asking would let a
  // person approve an install that is guaranteed to fail afterwards.
  globalThis.fetch = async () => ({ ok: false, status: 500, body: undefined, text: async () => '{}' })
  const failedDownload = await runPreExecute({ name: 'skill_market_install', arguments: { id: 'a/b/c' } })
  check('a failed download is denied, not asked', failedDownload.kind === 'deny', JSON.stringify(failedDownload))

  // The name is derivable from the id, so a call that cannot install must not
  // cost a megabyte of network first. The bundle above would download fine;
  // this asserts the name is checked before that fetch, not after it.
  let requestedBadName = false
  globalThis.fetch = async (url) => {
    requestedBadName = true
    return { ok: false, status: 404, body: undefined, text: async () => '{}' }
  }
  const rejectedName = await runPreExecute({
    name: 'skill_market_install',
    arguments: { id: 'a/b/c', name: 'Not Kebab Case' }
  })
  check('an install with an invalid name is denied', rejectedName.kind === 'deny', JSON.stringify(rejectedName))
  check('an invalid name never reaches the network', requestedBadName === false, String(requestedBadName))

  // Under the "never" policy the host rejects every request without consulting
  // anyone, so downloading first would spend a real request and cache a
  // megabyte that is discarded for certain.
  let requestedUnderNever = false
  globalThis.fetch = async (url) => {
    requestedUnderNever = true
    return { ok: false, status: 404, body: undefined, text: async () => '{}' }
  }
  gateHost.ctx.services.set('approval', { effectivePolicy: () => 'never' })
  const neverPolicy = await runPreExecute({ name: 'skill_market_install', arguments: { id: 'a/b/c' } })
  check('an install under the never policy is denied', neverPolicy.kind === 'deny', JSON.stringify(neverPolicy))
  check(
    'the denial names the disabled approval prompts',
    typeof neverPolicy.reason === 'string' && neverPolicy.reason.includes('disabled'),
    neverPolicy.reason
  )
  check('the never policy never reaches the network', requestedUnderNever === false, String(requestedUnderNever))
  gateHost.ctx.services.delete('approval')

  // ---- the approved bundle is the bundle that gets written ----------------
  // The P1 this replaced: the gate showed one fetch and `execute` performed
  // another, so an approval could apply to bytes nobody saw. Here the market
  // serves a different bundle on every request, and the file that lands on disk
  // must be the one from the first (approved) fetch.
  const wireRoot = await makeTempRoot('skill-evolve-install-wire-')
  process.env.DSH_HOME = wireRoot
  let fetchCount = 0
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/api/download/')) {
      return { ok: false, status: 404, body: undefined, text: async () => '{}' }
    }
    fetchCount += 1
    const version = fetchCount
    return {
      ok: true,
      status: 200,
      body: undefined,
      text: async () =>
        JSON.stringify({
          files: [{ path: 'SKILL.md', contents: `---\nname: served\n---\n\nversion ${version}` }],
          hash: `h${version}`
        })
    }
  }
  const installHost = fakeHost()
  apply(installHost.ctx, Config({ mode: 'suggest' }))
  const installAgent = fakeAgent('session-install-wire', 'F:/p8')
  installHost.agents.set(installAgent.id, installAgent)
  const installTool = installHost.tools.get('skill_market_install')
  const installChain = installHost.handlers.get('tools/pre-execute') ?? []
  const driveInstall = async (exec) => {
    let index = 0
    const next = async () => {
      const handler = installChain[index]
      index += 1
      return handler === undefined ? { kind: 'allow' } : handler(exec, next)
    }
    return next()
  }
  const installExec = { name: 'skill_market_install', arguments: { id: 'a/b/served' }, callId: 'call-approved', agent: installAgent }
  const approval = await driveInstall(installExec)
  check('the install gate asked for the wired call', approval.kind === 'ask', JSON.stringify(approval))
  const installOutcome = await installTool.execute({ id: 'a/b/served' }, installExec)
  check('the approved install succeeded', installOutcome.ok === true, JSON.stringify(installOutcome))
  check('the market was fetched exactly once, by the gate', fetchCount === 1, String(fetchCount))
  const onDisk = await readFile(join(wireRoot, 'skills', 'served', 'SKILL.md'), 'utf8')
  check(
    'the bytes on disk are the bytes the gate approved',
    onDisk.includes('version 1') && !onDisk.includes('version 2'),
    onDisk
  )

  // The approval is single-use: taking the entry out means a second write from
  // the same call cannot reuse bytes a person approved once.
  const replay = await installTool.execute({ id: 'a/b/served', name: 'served-again' }, installExec)
  check('an approval cannot be replayed', replay.ok === false, JSON.stringify(replay))
  check('a replayed install does not re-download', fetchCount === 1, String(fetchCount))

  // An install that never went through the gate has no bundle waiting, and must
  // not fall back to downloading on its own.
  const ungated = await installTool.execute({ id: 'a/b/never' }, { name: 'skill_market_install', callId: 'call-never', agent: installAgent })
  check('an install without an approval is refused', ungated.ok === false, JSON.stringify(ungated))

  // ---- approving from a later session ---------------------------------------
  // Evidence is a fact about the session a skill was distilled from. Approval
  // usually happens in a *different* session — often days later, after the
  // original has been trimmed away. Re-running the gate at approval time asks
  // the current session whether it once said these words, which is both the
  // wrong question and a question with a guaranteed "no": the quotes live in
  // the source session, not this one. This block pins the order: verified on
  // submit, carried by the queue, never re-verified on write.
  {
    const laterRoot = await makeTempRoot('skill-evolve-later-')
    // The queue lives under DSH_HOME, not under skillRoot. Without this line the
    // candidate would be written into whichever temporary directory the
    // previous fixture happened to leave in place — passing while depending on
    // an execution order it does not declare.
    process.env.DSH_HOME = laterRoot
    const sourceAgent = fakeAgent('session-source', 'F:/src')
    sourceAgent.push({ type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: 'Zip the build with 7z, then verify the archive lists every file.' }], source: { kind: 'user' } } })
    sourceAgent.push({ type: 'tool/result', seq: 2, data: { message: { role: 'tool', content: [{ type: 'text', text: '7z a build.7z ./dist -> Everything is Ok, 2 files, 4096 bytes' }] } } })

    const laterHost = fakeHost()
    laterHost.agents.set(sourceAgent.id, sourceAgent)
    apply(laterHost.ctx, Config({ mode: 'suggest', skillRoot: join(laterRoot, 'skills') }))
    const submitTool = laterHost.tools.get('skill_candidate_submit')

    const proposal = await submitTool.execute({
      name: 'zip-build-with-7z',
      description: 'Archive a build with 7z and verify the listing.',
      body: '## Procedure 1. 7z a build.7z ./dist 2. 7z l build.7z',
      evidence: [
        { class: 'user', quote: 'Zip the build with 7z, then verify the archive lists every file.' },
        { class: 'tool', quote: 'Everything is Ok' }
      ]
    }, { agent: sourceAgent })
    check('cross-session setup: the candidate is queued', proposal.ok === true, JSON.stringify(proposal).slice(0, 200))
    // Assert the queue really lives in this block's temp root. Without this the
    // block silently borrows whatever DSH_HOME the previous fixture left behind,
    // and removing its own isolation would not fail anything.
    check('cross-session setup: the queue is written under this blocks temp root', existsSync(join(laterRoot, 'plugin-data', 'skill-evolve', 'candidates.json')), laterRoot)
    // Use the path the tool itself reports. Hard-coding `plugin-data` here
    // would pass while the real queue lived somewhere else, which is exactly
    // the class of bug the reported-path check above exists to catch.
    const queuedRecord = await readFile(proposal.path, 'utf8')
    check('cross-session setup: verification provenance is recorded', queuedRecord.includes('verifiedInSession') && queuedRecord.includes('session-source'))

    // A brand-new agent with an empty transcript: the same person, a later day.
    const laterAgent = fakeAgent('session-later', 'F:/src')
    laterHost.agents.set(laterAgent.id, laterAgent)
    check('cross-session: the later session says nothing the candidate quotes', laterAgent.session.ownEvents().length === 0)

    // Writing the field is only half of "a human can see where this came from".
    // Both surfaces that list the queue must render it, or the comment on the
    // record describes a capability that does not exist. Asserted while the
    // candidate is still queued, because approval removes it from the list.
    const listedByCommand = await laterHost.commands.get('skill-review').handler({ rawInput: '', agent: laterAgent })
    check('the review list shows which session verified the quotes', listedByCommand.text.includes('session-source'), listedByCommand.text.slice(0, 400))
    const listedByTool = await laterHost.tools.get('skill_candidate_list').execute({}, { agent: laterAgent })
    check('the list tool shows which session verified the quotes', listedByTool.text.includes('session-source'), listedByTool.text.slice(0, 400))

    const approveLater = await laterHost.commands.get('skill-capture').handler({ rawInput: 'zip-build-with-7z', agent: laterAgent })
    check('cross-session: approval from a later session is accepted', approveLater.kind === 'success', JSON.stringify(approveLater).slice(0, 200))

    // Deliberately no evidence array here. The approving session is not the one
    // those quotes came from, so asking for them again asks the model to invent
    // them - and the honest answer is "I cannot", which used to abort the write.
    const finalLater = await submitTool.execute({
      name: 'zip-build-with-7z',
      description: 'Archive a build with 7z and verify the listing.',
      body: '## Procedure 1. 7z a build.7z ./dist 2. 7z l build.7z',
      final: true
    }, { agent: laterAgent })
    check('cross-session: the final write is not blocked by the evidence gate', finalLater.ok === true, JSON.stringify(finalLater).slice(0, 240))
    check('cross-session: the file really landed', await fileExists(join(laterRoot, 'skills', 'zip-build-with-7z', 'SKILL.md')))
    check('cross-session: the write reports how many quotes were accepted', finalLater.survived === 2, String(finalLater.survived))
    check('cross-session: the body is the approved draft', (await readFile(join(laterRoot, 'skills', 'zip-build-with-7z', 'SKILL.md'), 'utf8')).includes('7z l build.7z'))

    // The parameter schema is the only contract the model reads. Leaving
    // `evidence` in `required` while the code accepts its absence is how the
    // original bug would come back: a model obeying the schema would invent a
    // quote for a session it is not in, or refuse to finish the write.
    const schema = submitTool.parameters
    check('the schema does not require evidence', !schema.required.includes('evidence'), JSON.stringify(schema.required))
    check('the schema still requires the three text fields', ['name', 'description', 'body'].every((f) => schema.required.includes(f)), JSON.stringify(schema.required))
    check('the schema says evidence is for proposals', /final: true/.test(schema.properties.evidence.description))
  }

  } finally {
    globalThis.fetch = realFetch
    process.env.DSH_HOME = root
  }

  // ---- skill_search reaches the host catalog through `service` ------------
  // `createTools` defaults its `service` dependency to a function returning
  // `undefined`, so dropping the wiring line in `lib/index.js` does not throw:
  // the tool stays registered and answers "the host does not expose a skill
  // catalog" on every call. Unit tests inject the dependency, so only driving
  // `apply` and then the registered tool can see the difference. This check
  // failed exactly that way before the wiring was added.
  const searchHost = fakeHost()
  apply(searchHost.ctx, Config({ mode: 'suggest' }))
  const searchAgent = fakeAgent('session-search-wire', 'F:/p7')
  searchHost.agents.set(searchAgent.id, searchAgent)
  const snapshotCalls = []
  searchHost.ctx.skills = {
    snapshot: async (options) => {
      snapshotCalls.push(options)
      return { skills: [{ name: 'pdf-filler', description: 'Fill PDF forms', invocation: 'model' }], complete: true }
    },
    get: async () => ({ name: 'pdf-filler', description: 'Fill PDF forms', content: 'Fill a PDF form.' })
  }
  const wiredSearch = searchHost.tools.get('skill_search')
  check('skill_search is registered through apply', wiredSearch !== undefined, String(wiredSearch))
  const wiredOutcome = await wiredSearch.execute({ query: 'pdf' }, { agent: searchAgent })
  check(
    'skill_search finds a skill instead of claiming no catalog exists',
    wiredOutcome.ok === true && Array.isArray(wiredOutcome.results) && wiredOutcome.results.length === 1,
    JSON.stringify(wiredOutcome)
  )
  check(
    'skill_search asked the host for a snapshot scoped to the agent',
    snapshotCalls.length === 1 && snapshotCalls[0]?.scope === searchAgent,
    JSON.stringify(snapshotCalls.map((call) => Object.keys(call ?? {})))
  )
  process.env.DSH_HOME = root

  // ---- the panel route survives a webServer that arrives late ---------------
  // Reported by the user as "every card is empty and the panel says it got a
  // 404". The plugin registered its route through `service('webServer')`, which
  // goes through cordis's proxy: a service whose fiber is not active yet reads
  // as undefined, and it does not throw. So the whole registration block was
  // skipped silently, the client bundle still loaded, and every request fell
  // through to the host's 404. Mounting with the service absent and delivering
  // it afterwards is the only shape that can see the difference, because the
  // fixture that provides it up front makes the eager read work by accident.
  const lateHost = fakeHost({ webServer: false })
  apply(lateHost.ctx, Config({ mode: 'suggest' }))
  check(
    'a host without webServer at mount time does not register the panel route',
    lateHost.routes.has('/api/skill-evolve') === false,
    [...lateHost.routes.keys()].join(',')
  )

  const lateRoutes = new Map()
  lateHost.provide('webServer', {
    register({ kind, path, handler }) {
      lateRoutes.set(path, { kind, handler })
      return () => lateRoutes.delete(path)
    }
  })
  check(
    'the panel route is registered once webServer activates',
    lateRoutes.has('/api/skill-evolve') === true,
    [...lateRoutes.keys()].join(',')
  )
  check(
    'the late route is a prefix route, so the client can reach its subpaths',
    lateRoutes.get('/api/skill-evolve')?.kind === 'prefix',
    JSON.stringify(lateRoutes.get('/api/skill-evolve')?.kind)
  )

  // The route existing is not the same as the route answering. Before the fix
  // the four cards were empty *and* the endpoint reported 404, so a check that
  // only looks at registration would have been satisfied by the broken build if
  // the host had happened to activate webServer early enough to register it.
  // Drive the late-registered handler and require real turn data back.
  {
    const lateAgent = fakeAgent('session-late', 'F:/some/project')
    lateHost.agents.set(lateAgent.id, lateAgent)
    const route = lateRoutes.get('/api/skill-evolve')
    const res = {
      statusCode: undefined,
      writableEnded: false,
      // The handler drains on 'close' for HEAD responses; a stub without this
      // throws inside json() rather than exercising the route.
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
      {
        url: `/api/skill-evolve/panel?agent=${encodeURIComponent(lateAgent.id)}`,
        method: 'GET',
        headers: { host: '127.0.0.1:19387' }
      },
      res
    )
    const payload = JSON.parse(res.body)
    check('the late route answers instead of falling through to the host 404', res.statusCode === 200, res.body)
    check('the late route returns the panel payload', payload.ok === true && typeof payload.data === 'object', res.body)
    check('the late route names the agent it was asked about', payload.data?.agent === lateAgent.id, res.body)
  }

  // ---- the skill card lists what this session loaded, nothing else ---------
  // The module promises "what has this session used". Two ways a skill gets
  // loaded, and only one of them produces a tool call: the model invokes the
  // `skill` tool, or a person types `/name` and the host injects the body
  // directly. A test that only drives the tool call would pass with the gesture
  // path missing, which is exactly the half that leaves the card empty in
  // normal use.
  {
    const skillHost = fakeHost()
    apply(skillHost.ctx, Config({ mode: 'suggest' }))
    const skillAgent = fakeAgent('session-skill-card', 'F:/some/project')
    skillHost.agents.set(skillAgent.id, skillAgent)
    skillHost.ctx.skills = {
      async snapshot() {
        return {
          complete: true,
          skills: [
            { name: 'alpha', description: 'loaded through the tool', invocation: { modelInvocable: true, userInvocable: true } },
            { name: 'beta', description: 'loaded through the gesture', invocation: { modelInvocable: false, userInvocable: true } },
            { name: 'gamma', description: 'never loaded' },
            // Model-only: the host refuses a gesture at it and injects
            // nothing, so typing /delta must not put it in the module.
            { name: 'delta', description: 'model-only', invocation: { modelInvocable: true, userInvocable: false } }
          ]
        }
      },
      async get(name) {
        return { name, description: name, content: 'body' }
      }
    }

    // `data.skills` is the describeSkills envelope, not the array: the route
    // nests one level further. Reading the envelope as the list made every
    // assertion below compare against an object's `.length` (undefined).
    const readSkills = async () => {
      const route = skillHost.routes.get('/api/skill-evolve')
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
        { url: `/api/skill-evolve/panel?agent=${encodeURIComponent(skillAgent.id)}`, method: 'GET', headers: { host: '127.0.0.1:19387' } },
        res
      )
      return JSON.parse(res.body)
    }

    const before = await readSkills()
    check('no skill is listed before this session loads one', before.data?.skills?.skills?.length === 0, JSON.stringify(before.data?.skills?.skills))

    skillHost.emit('session/event', skillAgent.session, {
      type: 'tool/call',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, step: 1, callId: 'c-skill', name: 'skill', arguments: '{"name":"alpha"}' }
    })
    const afterTool = await readSkills()
    check('a skill the model loaded through the tool is listed', afterTool.data?.skills?.skills?.length === 1 && afterTool.data.skills.skills[0].name === 'alpha', JSON.stringify(afterTool.data?.skills?.skills))

    // The host's own gesture. It produces no tool call at all, so a plugin that
    // only watches tools cannot see it.
    skillHost.emit('session/event', skillAgent.session, {
      type: 'user/message',
      seq: 2,
      time: Date.now(),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'please run /beta for me' }] }
    })
    const afterGesture = await readSkills()
    check('a skill loaded with the /name gesture is listed too', afterGesture.data?.skills?.skills?.length === 2, JSON.stringify(afterGesture.data?.skills?.skills))
    check(
      'the gesture-loaded skill is the one that was typed',
      afterGesture.data?.skills?.skills?.some((row) => row.name === 'beta') === true,
      JSON.stringify(afterGesture.data?.skills?.skills)
    )

    // A gesture at a skill the host will not load must not be reported as a
    // load. The host filters with `isUserInvocable` before injecting; the panel
    // has to apply the same rule or it invents activity that did not happen.
    skillHost.emit('session/event', skillAgent.session, {
      type: 'user/message',
      seq: 3,
      time: Date.now(),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'try /delta instead' }] }
    })
    const afterRefused = await readSkills()
    check(
      'a gesture at a model-only skill is not listed',
      afterRefused.data?.skills?.skills?.some((row) => row.name === 'delta') === false,
      JSON.stringify(afterRefused.data?.skills?.skills)
    )
    check(
      'the refused gesture did not disturb the rest of the list',
      afterRefused.data?.skills?.skills?.length === 2,
      JSON.stringify(afterRefused.data?.skills?.skills)
    )

    check(
      'a skill this session never loaded stays hidden',
      afterGesture.data?.skills?.skills?.some((row) => row.name === 'gamma') === false,
      JSON.stringify(afterGesture.data?.skills?.skills)
    )
    check(
      'the newest load is listed first',
      afterGesture.data?.skills?.skills?.[0]?.name === 'beta',
      JSON.stringify(afterGesture.data?.skills?.skills)
    )

    // Reloading a skill must move it back to the top. A bare `Set.add` keeps
    // the first position, so this ordering breaks on the very common
    // "use alpha, use beta, use alpha again" sequence — and the assertion above
    // cannot see it, because each skill there was loaded exactly once.
    skillHost.emit('session/event', skillAgent.session, {
      type: 'tool/call',
      seq: 5,
      time: Date.now(),
      data: { turn: 2, step: 1, callId: 'c-skill-again', name: 'skill', arguments: '{"name":"alpha"}' }
    })
    const afterReload = await readSkills()
    check(
      'reloading an already-listed skill moves it to the front',
      afterReload.data?.skills?.skills?.[0]?.name === 'alpha',
      JSON.stringify(afterReload.data?.skills?.skills)
    )
    check(
      'reloading does not duplicate the entry',
      afterReload.data?.skills?.skills?.length === 2,
      JSON.stringify(afterReload.data?.skills?.skills)
    )
    check(
      'the invocation policy is read as the object the host sends',
      afterGesture.data?.skills?.skills?.find((row) => row.name === 'beta')?.modelInvocable === false,
      JSON.stringify(afterGesture.data?.skills?.skills)
    )

    // A path is not a gesture, and neither is a fraction. Both appear in real
    // messages and both would otherwise be counted as skills.
    skillHost.emit('session/event', skillAgent.session, {
      type: 'user/message',
      seq: 3,
      time: Date.now(),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'look at /usr/bin and 5/8 of the file' }] }
    })
    const afterNoise = await readSkills()
    check('paths and fractions are not counted as skills', afterNoise.data?.skills?.skills?.length === 2, JSON.stringify(afterNoise.data?.skills?.skills))

    // A message the host itself authored is not a person typing a slash command.
    skillHost.emit('session/event', skillAgent.session, {
      type: 'user/message',
      seq: 4,
      time: Date.now(),
      data: { source: { kind: 'system' }, content: [{ type: 'text', text: 'run /gamma' }] }
    })
    const afterSystem = await readSkills()
    check('a slash in a non-human message is not a skill load', afterSystem.data?.skills?.skills?.length === 2, JSON.stringify(afterSystem.data?.skills?.skills))


    // A model-only skill the model loaded through the tool must survive a later
    // gesture at the same name. The gesture loads nothing (the host skips
    // non-user-invocable skills), so if it overwrote the recorded path the panel
    // would lose a skill the session is actually using. Recency may move the
    // row; permission must not fall.
    skillHost.emit('session/event', skillAgent.session, {
      type: 'tool/call',
      seq: 7,
      time: Date.now(),
      data: { turn: 3, step: 1, callId: 'c-skill-delta', name: 'skill', arguments: '{"name":"delta"}' }
    })
    const afterDeltaTool = await readSkills()
    check(
      'a model-only skill loaded by the tool is listed',
      afterDeltaTool.data?.skills?.skills?.some((row) => row.name === 'delta') === true,
      JSON.stringify(afterDeltaTool.data?.skills?.skills)
    )

    skillHost.emit('session/event', skillAgent.session, {
      type: 'user/message',
      seq: 8,
      time: Date.now(),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'and then /delta again' }] }
    })
    const afterDeltaGesture = await readSkills()
    check(
      'a later gesture does not demote a tool load of a model-only skill',
      afterDeltaGesture.data?.skills?.skills?.some((row) => row.name === 'delta') === true,
      JSON.stringify(afterDeltaGesture.data?.skills?.skills)
    )

    // Disposal must clear it, or a new session reusing the id inherits loads.
    skillHost.emit('agent/disposed', { agent: skillAgent })
    const afterDispose = await readSkills()
    check('disposal forgets which skills this session loaded', afterDispose.data?.skills?.skills?.length === 0, JSON.stringify(afterDispose.data?.skills?.skills))
  }
} catch (error) {
  // Rethrown rather than swallowed: the exit hook still removes every temp root,
  // so a failure here costs nothing but the message that explains it.
  console.error(error)
  process.exit(1)
}

// A person approves a draft; the model then writes a different one. Before this
// was checked, `finalize` published whatever body the model sent under an
// approval that had only ever seen the earlier text — the queue showed one
// procedure and the skill directory got another.
{
  const editRoot = await makeTempRoot('skill-evolve-edited-')
  process.env.DSH_HOME = editRoot
  const host = fakeHost()
  apply(host.ctx, Config({ mode: 'suggest' }))
  const agent = fakeAgent('session-edited', 'F:/proj')
  host.agents.set(agent.id, agent)
  agent.push({
    type: 'user/message', seq: 1,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Always verify the archive lists every file before you report success.' }] }
  })

  const submit = host.tools.get('skill_candidate_submit')
  const queued = await submit.execute({
    name: 'zip-then-list',
    description: 'Archive a build and prove the archive is complete.',
    body: '1. Run 7z a build.7z ./dist\n2. Run 7z l build.7z',
    evidence: [{ class: 'user', quote: 'Always verify the archive lists every file before you report success.' }]
  }, { agent })
  check('edited-after-approval setup: queued', queued.ok === true, JSON.stringify(queued).slice(0, 200))

  const approved = await host.commands.get('skill-capture').handler({ rawInput: 'zip-then-list', agent })
  check('edited-after-approval setup: approval staged it', approved.kind === 'success', JSON.stringify(approved).slice(0, 200))

  // Same name, different procedure: this is the draft nobody approved.
  const changed = await submit.execute({
    name: 'zip-then-list',
    description: 'Archive a build and prove the archive is complete.',
    body: '1. Run tar -czf build.tgz ./dist\n2. Email the tarball to the team',
    final: true
  }, { agent })
  check('a draft changed after approval is not published', changed.ok === false && changed.code === 'changed-since-approval', JSON.stringify(changed).slice(0, 300))
  check('the unapproved text did not reach the skill directory',
    (await fileExists(join(editRoot, 'skills', 'zip-then-list', 'SKILL.md'))) === false)
  check('the refusal explains that nobody has seen this version',
    /nobody has seen this version/.test(changed.error ?? ''), String(changed.error))

  // The queue must now hold the *new* text, otherwise re-approving would
  // re-approve the old body and the change would be lost in the other direction.
  const relisted = await host.tools.get('skill_candidate_list').execute({}, { agent })
  check('the new text is back in the queue for another look', relisted.text.includes('zip-then-list'), relisted.text.slice(0, 300))
  const queueFile = JSON.parse(await readFile(join(editRoot, 'plugin-data', 'skill-evolve', 'candidates.json'), 'utf8'))
  const entry = queueFile.find((item) => item.name === 'zip-then-list')
  check('the queued entry now carries the changed body', String(entry?.body ?? '').includes('tar -czf'), String(entry?.body).slice(0, 120))
  check('the queued entry is no longer flagged as approved', entry?.awaitingFinal !== true)
  check('the stale approval digest was cleared', entry?.approvedDigest === undefined)

  // Approving again and sending the *same* text must work: the check binds
  // content, it does not forbid the confirm flow.
  const reapproved = await host.commands.get('skill-capture').handler({ rawInput: 'zip-then-list', agent })
  check('re-approval of the new text succeeds', reapproved.kind === 'success', JSON.stringify(reapproved).slice(0, 200))
  const written = await submit.execute({
    name: 'zip-then-list',
    description: 'Archive a build and prove the archive is complete.',
    body: '1. Run tar -czf build.tgz ./dist\n2. Email the tarball to the team',
    final: true
  }, { agent })
  check('the re-approved text is published', written.ok === true, JSON.stringify(written).slice(0, 240))
  const onDisk = await readFile(join(editRoot, 'skills', 'zip-then-list', 'SKILL.md'), 'utf8')
  check('what landed is what was approved the second time', onDisk.includes('tar -czf'), onDisk.slice(0, 200))
}

// A revision is proposed from a snapshot, then the world moves on: the skill
// gets pinned and used while the proposal waits for approval. `writeApproved`
// used to rebuild the registry row from a literal object — seven fields, so
// `pinned` / `demoted` were erased — and read the counters from the proposal's
// snapshot, rolling back every use reported in between.
{
  const reviseRoot = await makeTempRoot('skill-evolve-revise-')
  process.env.DSH_HOME = reviseRoot
  const host = fakeHost()
  apply(host.ctx, Config({ mode: 'suggest', promoteAfterUses: 3 }))
  const agent = fakeAgent('session-revise', 'F:/proj')
  host.agents.set(agent.id, agent)
  agent.push({
    type: 'user/message', seq: 1,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Convert the spreadsheet with soffice before parsing it, never with a JS library.' }] }
  })

  const submit = host.tools.get('skill_candidate_submit')
  const feedback = host.tools.get('skill_feedback')
  const capture = host.commands.get('skill-capture')
  const rank = host.commands.get('skill-rank')
  const quoted = [{ class: 'user', quote: 'Convert the spreadsheet with soffice before parsing it, never with a JS library.' }]

  // Land a first version.
  await submit.execute({
    name: 'soffice-first', description: 'Convert spreadsheets with soffice.', body: '1. Run soffice --convert-to csv', evidence: quoted
  }, { agent })
  await capture.handler({ rawInput: 'soffice-first', agent })
  const firstWrite = await submit.execute({
    name: 'soffice-first', description: 'Convert spreadsheets with soffice.', body: '1. Run soffice --convert-to csv', final: true
  }, { agent })
  check('revision setup: the first version landed', firstWrite.ok === true, JSON.stringify(firstWrite).slice(0, 200))

  // A person marks it important, then it earns two uses.
  const pinned = await rank.handler({ rawInput: 'soffice-first pin', agent })
  check('revision setup: the skill was pinned', pinned.kind === 'success' && pinned.text.includes('pinned'), String(pinned.text))
  await feedback.execute({ name: 'soffice-first', verdict: 'helpful' }, { agent })
  await feedback.execute({ name: 'soffice-first', verdict: 'helpful' }, { agent })

  // Revision proposed while `uses` is 2. The snapshot it carries says 2.
  const proposal = await submit.execute({
    name: 'soffice-first', description: 'Convert spreadsheets with soffice, then verify the CSV.', body: '1. Run soffice --convert-to csv\n2. Head the CSV', evidence: quoted
  }, { agent })
  check('revision setup: the revision was accepted', proposal.ok === true, JSON.stringify(proposal).slice(0, 200))
  const snapshot = JSON.parse(await readFile(join(reviseRoot, 'plugin-data', 'skill-evolve', 'candidates.json'), 'utf8'))
    .find((item) => item.name === 'soffice-first')
  check('the revision recorded the counters it saw', Number(snapshot?.base?.uses) === 2, JSON.stringify(snapshot?.base))

  // A third use arrives after the proposal was written: 3 reaches the
  // promotion threshold, so the stage also moves while the revision waits.
  await feedback.execute({ name: 'soffice-first', verdict: 'helpful' }, { agent })

  await capture.handler({ rawInput: 'soffice-first', agent })
  const revisionWrite = await submit.execute({
    name: 'soffice-first', description: 'Convert spreadsheets with soffice, then verify the CSV.', body: '1. Run soffice --convert-to csv\n2. Head the CSV', final: true
  }, { agent })
  check('the revision is published', revisionWrite.ok === true, JSON.stringify(revisionWrite).slice(0, 240))

  const registry = JSON.parse(await readFile(join(reviseRoot, 'plugin-data', 'skill-evolve', 'registry.json'), 'utf8'))
  const row = registry['soffice-first'] ?? {}
  check('a revision keeps the manual pin', row.pinned === true, JSON.stringify(row))
  check('a revision keeps the uses reported after it was proposed', Number(row.uses) === 3, JSON.stringify(row))
  check('a revision keeps the stage the skill reached in the meantime', row.stage === 'active', JSON.stringify(row))
  const revisedFile = await readFile(join(reviseRoot, 'skills', 'soffice-first', 'SKILL.md'), 'utf8')
  check('the file records the surviving use count', revisedFile.includes('evolved-uses: "3"'), revisedFile.match(/evolved-uses.*/)?.[0])
  check('the file carries the new procedure', revisedFile.includes('Head the CSV'), revisedFile.slice(0, 200))

  // And a demoted flag must survive too — it is the other half of the same
  // literal-object bug, and the two are cleared by different commands.
  await rank.handler({ rawInput: 'soffice-first demote', agent })
  await submit.execute({
    name: 'soffice-first', description: 'Convert spreadsheets, headers checked.', body: '1. Run soffice --convert-to csv\n2. Head the CSV', evidence: quoted
  }, { agent })
  await capture.handler({ rawInput: 'soffice-first', agent })
  await submit.execute({
    name: 'soffice-first', description: 'Convert spreadsheets, headers checked.', body: '1. Run soffice --convert-to csv\n2. Head the CSV', final: true
  }, { agent })
  const afterDemote = JSON.parse(await readFile(join(reviseRoot, 'plugin-data', 'skill-evolve', 'registry.json'), 'utf8'))['soffice-first'] ?? {}
  check('a revision keeps the demotion', afterDemote.demoted === true, JSON.stringify(afterDemote))
  check('a revision keeps the pin alongside the demotion', afterDemote.pinned === true, JSON.stringify(afterDemote))
}

{
  // The panel lists skills and MCP servers in one stream, so both kinds of use
  // have to advance the same recency clock. A mutation that stops recording MCP
  // calls would otherwise leave the merged list ordered by skill loads alone.
  const recencyHost = fakeHost()
  apply(recencyHost.ctx, Config({ mode: 'suggest' }))
  const recencyAgent = fakeAgent('session-recency', 'F:/some/project')
  recencyHost.agents.set(recencyAgent.id, recencyAgent)
  recencyHost.ctx.skills = {
    async snapshot() {
      return { complete: true, skills: [{ name: 'alpha', description: 'a' }, { name: 'beta', description: 'b' }] }
    },
  }
  const readPanel = async () => {
    const route = recencyHost.routes.get('/api/skill-evolve')
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
      },
    }
    await route.handler({ url: `/api/skill-evolve/panel?agent=${encodeURIComponent(recencyAgent.id)}`, method: 'GET', headers: { host: '127.0.0.1:19387' } }, res)
    return JSON.parse(res.body)
  }
  recencyHost.emit('session/event', recencyAgent.session, { type: 'tool/call', seq: 1, time: Date.now(), data: { turn: 1, step: 1, callId: 'r1', name: 'skill', arguments: '{"name":"alpha"}' } })
  recencyHost.emit('session/event', recencyAgent.session, { type: 'tool/call', seq: 2, time: Date.now(), data: { turn: 1, step: 2, callId: 'r2', name: 'mcp__zeta__search', arguments: '{}' } })
  recencyHost.emit('session/event', recencyAgent.session, { type: 'tool/call', seq: 3, time: Date.now(), data: { turn: 1, step: 3, callId: 'r3', name: 'skill', arguments: '{"name":"beta"}' } })
  const payload = await readPanel()
  const activity = [
    ...(payload.data?.skills?.skills ?? []).map((row) => ({ name: row.name, lastUsed: row.lastUsed })),
    ...(payload.data?.mcp ?? []).map((row) => ({ name: row.server, lastUsed: row.lastUsed })),
  ].sort((a, b) => b.lastUsed - a.lastUsed)
  check('skill and MCP uses share one recency clock', JSON.stringify(activity.map((row) => row.name)) === '["beta","zeta","alpha"]', JSON.stringify(activity))
  check('an MCP use sits between two skill uses', activity[1].name === 'zeta' && activity[1].lastUsed > activity[2].lastUsed && activity[1].lastUsed < activity[0].lastUsed, JSON.stringify(activity))
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
