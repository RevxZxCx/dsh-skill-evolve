// Tests for the four findings fixed after code review.
//
// P0 (runner timeout) lives in runner.test.mjs; F02/F03/P3 here.
import { join } from 'node:path'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { apply, Config } from '../lib/index.js'

let pass = 0
let fail = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    pass += 1
    return
  }
  fail += 1
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

/**
 * A fake agent that replays recorded events.
 *
 * The shape matters: the evidence gate reads `agent.session.ownEvents()`, so an
 * agent without a `session` object silently yields an empty event stream and
 * every quote is rejected as unfindable.
 */
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
    },
    all: () => events
  }
}

/**
 * Build a `user` message event carrying `text`, the way the host records it.
 */
function userSaid(text, seq = 1) {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: { content: [{ type: 'text', text }] }
  }
}

/**
 * A minimal host: the services this plugin reaches for.
 */
function fakeHost() {
  const tools = new Map()
  const commands = new Map()
  const contexts = []
  const agents = new Map()
  const handlers = new Map()
  const deferred = []
  const routes = []
  const ctx = {
    tools: { register: (tool) => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    commands: { register: (command) => (commands.set(command.name, command), () => commands.delete(command.name)) },
    systemPrompt: { context: (entry) => (contexts.push(entry), () => {}) },
    // The panel's only way in. `register` records the handler so a test can
    // drive a real request through it instead of reaching past the HTTP layer.
    webServer: { register: (route) => (routes.push(route), () => {}) },
    get: (name) => (name === 'agents' ? { get: (id) => agents.get(id) } : undefined),
    // Mirrors cordis: the callback runs once every named service resolves. A
    // missing service defers instead of failing, which is the timing that made
    // the panel register no routes on a cold start.
    inject(names, callback) {
      const missing = names.filter((name) => ctx[name] === undefined)
      if (missing.length > 0) {
        deferred.push({ names, callback })
        return undefined
      }
      return callback(ctx)
    },
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
  }
  return {
    ctx,
    tools,
    commands,
    contexts,
    agents,
    handlers,
    routes,
    emit(event, session, payload) {
      for (const handler of handlers.get(event) ?? []) handler(session, payload)
    }
  }
}

async function makeRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  process.env.DSH_HOME = root
  return root
}

/**
 * Drive one POST through a registered panel route.
 *
 * The request shape mirrors what the browser sends: a loopback `host` header
 * (the origin check reads it) and a JSON content type (the body reader insists
 * on it). Calling the route handler directly, rather than reaching for an inner
 * function, is deliberate — it is the same path the button takes.
 */
async function post(route, path, payload) {
  const body = JSON.stringify(payload)
  const req = {
    url: path,
    method: 'POST',
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    }
  }
  const res = {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writableEnded: false,
    destroyed: false,
    once() {
      return res
    },
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
      return res
    },
    end(text) {
      res.body = text === undefined ? undefined : JSON.parse(text)
      res.writableEnded = true
      return res
    }
  }
  await route.handler(req, res)
  return res
}

// --- F02: a second finalize must not write the file again -----------------
//
// Before the critical section, both callers read the queue, both saw
// `awaitingFinal === true`, both matched the digest and both wrote. The queue
// filter only made the second removal fail, which is after the write.
{
  const root = await makeRoot('skill-evolve-finalize-race-')
  const host = fakeHost()
  apply(host.ctx, Config({ mode: 'suggest' }))
  const agent = fakeAgent('session-race', 'F:/proj')
  host.agents.set(agent.id, agent)
  agent.push({
    type: 'user/message',
    seq: 1,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Always run the linter before you claim the build is green.' }] }
  })

  const submit = host.tools.get('skill_candidate_submit')
  const capture = host.commands.get('skill-capture')
  const quote = [{ class: 'user', quote: 'Always run the linter before you claim the build is green.' }]
  await submit.execute({
    name: 'lint-before-green',
    description: 'Run the linter before reporting a green build.',
    body: '1. Run the linter\n2. Read its exit code',
    evidence: quote
  }, { agent })
  await capture.handler({ rawInput: 'lint-before-green', agent })

  // Two finals in flight at once, with the same approved text.
  const finalInput = {
    name: 'lint-before-green',
    description: 'Run the linter before reporting a green build.',
    body: '1. Run the linter\n2. Read its exit code',
    final: true
  }
  const [first, second] = await Promise.all([
    submit.execute(finalInput, { agent }),
    submit.execute(finalInput, { agent })
  ])
  const succeeded = [first, second].filter((result) => result.ok === true)
  check('only one concurrent finalize publishes', succeeded.length === 1, JSON.stringify([first.code, second.code]))
  check('the loser reports that the candidate is gone', [first, second].some((result) => result.ok === false && result.code === 'not-pending'), JSON.stringify([first.code, second.code]))

  const ledger = await readFile(join(root, 'plugin-data', 'skill-evolve', 'ledger.jsonl'), 'utf8')
  const approvals = ledger.trim().split('\n').filter((line) => line.includes('"action":"approve"'))
  check('the ledger records one approval, not two', approvals.length === 1, String(approvals.length))
}

// --- F03: an auto-mode revision keeps its lifecycle record ----------------
//
// In `mode: 'auto'` the plugin writes the skill itself, and the revision branch
// built its own state literal with four fields. Every auto edit therefore reset
// `helpful`, `harmful`, the id and the evidence — silently, because the file on
// disk is what the registry is rebuilt from.
{
  const root = await makeRoot('skill-evolve-auto-revise-')
  const host = fakeHost()
  apply(host.ctx, Config({ mode: 'auto', promoteAfterUses: 3 }))
  const agent = fakeAgent('session-auto', 'F:/proj')
  host.agents.set(agent.id, agent)
  const line = 'Always convert the spreadsheet with soffice, never with a JS library.'
  agent.push({
    type: 'user/message',
    seq: 1,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: line }] }
  })

  const submit = host.tools.get('skill_candidate_submit')
  const feedback = host.tools.get('skill_feedback')
  const quoted = [{ class: 'user', quote: line }]

  const created = await submit.execute({
    name: 'soffice-auto',
    description: 'Convert spreadsheets with soffice.',
    body: '1. Run soffice --convert-to csv',
    evidence: quoted
  }, { agent })
  check('auto setup: the skill was written', created.ok === true && created.autoWritten === true, JSON.stringify(created).slice(0, 200))

  await feedback.execute({ name: 'soffice-auto', verdict: 'helpful' }, { agent })
  await feedback.execute({ name: 'soffice-auto', verdict: 'helpful' }, { agent })
  const before = JSON.parse(await readFile(join(root, 'plugin-data', 'skill-evolve', 'registry.json'), 'utf8'))['soffice-auto'] ?? {}
  check('auto setup: two uses recorded', Number(before.uses) === 2, JSON.stringify(before))
  // Read the identity off the file, not the registry: the registry row is a
  // projection and does not carry `id`, so asking it would make the assertion
  // depend on a field that is never there.
  const fileBefore = await readFile(join(root, 'skills', 'soffice-auto', 'SKILL.md'), 'utf8')
  const idBefore = /evolved-id:\s*"?([0-9a-f-]+)"?/.exec(fileBefore)?.[1]

  // An auto revision arrives with the same name.
  const revised = await submit.execute({
    name: 'soffice-auto',
    description: 'Convert spreadsheets with soffice, then check the CSV.',
    body: '1. Run soffice --convert-to csv\n2. Head the CSV',
    evidence: quoted
  }, { agent })
  check('auto revision wrote the file', revised.ok === true, JSON.stringify(revised).slice(0, 200))

  const skillFile = await readFile(join(root, 'skills', 'soffice-auto', 'SKILL.md'), 'utf8')
  check('the auto revision keeps the use count in the file', /evolved-uses:\s*"?2"?/.test(skillFile), skillFile.match(/evolved-uses.*/)?.[0])
  check('the auto revision keeps the helpful count in the file', /evolved-helpful:\s*"?2"?/.test(skillFile), skillFile.match(/evolved-helpful.*/)?.[0])
  // `idBefore` must be a real value before comparing against it: an
  // `idBefore === undefined || ...` guard makes the assertion vacuous exactly
  // when the thing under test has already dropped the id, which is the state
  // the mutation creates. `=== undefined` alone is the honest check.
  check('auto setup: the file carried an identity to keep', typeof idBefore === 'string' && idBefore.length > 0, JSON.stringify(idBefore))
  check(
    'the auto revision keeps the identity',
    /evolved-id:\s*"?([0-9a-f-]+)"?/.exec(skillFile)?.[1] === idBefore,
    `${/evolved-id:\s*"?([0-9a-f-]+)"?/.exec(skillFile)?.[1]} vs ${idBefore}`
  )
  // The evidence field must survive as evidence, not be satisfied by the same
  // word appearing in the body — the body always mentions the tool, so
  // `includes('soffice')` proves nothing. Assert the frontmatter line itself.
  check(
    'the auto revision keeps the evidence field',
    /evolved-evidence:.*soffice/.test(skillFile),
    skillFile.match(/evolved-evidence.*/)?.[0] ?? '(no evolved-evidence line)'
  )

  const after = JSON.parse(await readFile(join(root, 'plugin-data', 'skill-evolve', 'registry.json'), 'utf8'))['soffice-auto'] ?? {}
  check('the registry still reports two uses after an auto revision', Number(after.uses) === 2, JSON.stringify(after))
  check('the registry still reports two helpful after an auto revision', Number(after.helpful) === 2, JSON.stringify(after))
}

// --- F03 (second half): a blank field must not be mistaken for absent ------
//
// `readState` reports a missing frontmatter key as `''`, not `undefined`. The
// revision branch used `??`, so a blank id was treated as a value worth keeping
// and written back as an empty id — a skill that can never be matched to its own
// history again. This drives the branch with a file that genuinely lacks the
// field, which is the only shape that exposes the difference between `??` and
// `||`.
{
  const root = await makeRoot('skill-evolve-blank-id-')
  const host = fakeHost()
  apply(host.ctx, Config({ mode: 'auto' }))
  const agent = fakeAgent('session-blank', 'F:/proj')
  host.agents.set(agent.id, agent)
  const line = 'Always decode the log with zstd before reading it.'
  agent.push({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: line }] } })

  const submit = host.tools.get('skill_candidate_submit')
  const quoted = [{ class: 'user', quote: line }]
  await submit.execute({ name: 'zstd-first', description: 'Decode before reading.', body: '1. zstd -d', evidence: quoted }, { agent })

  // Strip the identity fields the way an older version of this plugin (or a
  // hand edit) would have left them, then force a revision through the same
  // path.
  //
  // The write must be awaited. Without it the revision races the strip and the
  // test is nondeterministic in the worst way: usually it reads the original
  // file and passes without ever exercising a blank field, and occasionally it
  // catches a half-written file, which `findExistingSkill` reports as
  // "no parsable frontmatter" and quietly turns into a fresh create.
  //
  // `stage` is deliberately not stripped. `renderSkillFile` drops empty values,
  // so a blank stage is written as an absent key and `readState` restores
  // `'unverified'` — a blank stage is indistinguishable from a missing one, and
  // asserting on it would test the fixture rather than the code. `id` and
  // `evidence` are different: both are non-empty strings in a healthy file, so
  // preserving a blank one destroys data that cannot be recovered.
  const path = join(root, 'skills', 'zstd-first', 'SKILL.md')
  const stripped = (await readFile(path, 'utf8'))
    .replace(/^evolved-id:.*$/m, 'evolved-id: ""')
    .replace(/^evolved-evidence:.*$/m, 'evolved-evidence: ""')
  await writeFile(path, stripped)

  // Prove the fixture is what the assertions assume before judging the result.
  const staged = await readFile(path, 'utf8')
  check('the strip left a blank id on disk', /^evolved-id: ""$/m.test(staged), staged.slice(0, 120))

  const revised = await submit.execute({
    name: 'zstd-first',
    description: 'Decode before reading.',
    body: '1. zstd -d\n2. Read the output',
    evidence: quoted
  }, { agent })
  check('the blank-fields revision was accepted', revised.ok === true, JSON.stringify(revised).slice(0, 200))

  const after = await readFile(path, 'utf8')
  const id = /evolved-id:\s*"?([0-9a-z-]+)"?/.exec(after)?.[1] ?? ''
  check('a blank id is replaced, not preserved', id.length > 0, `evolved-id is ${JSON.stringify(id)}`)
  const evidence = /evolved-evidence:\s*"?(.*?)"?\s*$/m.exec(after)?.[1] ?? ''
  check('blank evidence is replaced by the new quotes', evidence.includes('zstd'), `evolved-evidence is ${JSON.stringify(evidence)}`)
}

// --- P3: `off` refuses the panel's proposal too ---------------------------
//
// `off` already blocked the tool, the repeat detector and the reflection. The
// panel's propose button reached `hints.publish` directly and so was the one
// route that could still inject text into a session the user had switched off.
{
  const root = await makeRoot('skill-evolve-off-proposal-')
  const host = fakeHost()
  apply(host.ctx, Config({ mode: 'off' }))
  const agent = fakeAgent('session-off', 'F:/proj')
  host.agents.set(agent.id, agent)

  const route = host.routes.find((entry) => entry.path === '/api/skill-evolve')
  check('off setup: the panel route is registered', route !== undefined, JSON.stringify(host.routes.map((r) => r.path)))

  const res = await post(route, '/api/skill-evolve/propose', { agent: 'session-off', skill: 'anything' })
  check('off refuses the panel proposal', res.statusCode === 200 && res.body?.data?.ok === false, JSON.stringify(res.body))
  check(
    'off says why the proposal was refused',
    /set to off/.test(String(res.body?.data?.reason ?? '')),
    JSON.stringify(res.body?.data?.reason)
  )

  // And nothing reached the prompt. This is the assertion that matters: an
  // "ok:false" envelope with a live hint behind it would still cost the user.
  const context = host.contexts.find((entry) => entry.name === 'skill-evolve:hint')
  const rendered = context === undefined ? '' : context.text({ agent: { id: 'session-off' } })
  check('the hint context renders empty under off', rendered === '', JSON.stringify(rendered))

  // Standing guard against a fix that only special-cases this one route.
  void root
}

// --- P1: finalize recomputes staleness instead of trusting the disk --------
//
// `finalize` used to read the queue with `store.loadCandidates()`, which returns
// the snapshot as the last writer left it. `isLive` only asks whether a `stale`
// field is present, so a candidate that went stale *after* approval — here, the
// skill it revises was edited by hand — still looked live and was written,
// silently discarding the edit. The fix annotates the queue inside the same
// critical section; this test fails if that annotation is dropped again.
{
  const root = await makeRoot('skill-evolve-finalize-stale-')

  // First stage: `auto` writes the base skill for us, which is the only way to
  // get an owned file without re-implementing the writer here.
  const host = fakeHost()
  const config = Config({ mode: 'auto', approvalMode: 'confirm' })
  apply(host.ctx, config)
  const agent = fakeAgent('session-stale', 'F:/proj')
  host.agents.set(agent.id, agent)
  const line = 'Convert the spreadsheet with soffice before opening it in a library.'
  agent.push({
    type: 'user/message',
    seq: 1,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: line }] }
  })

  const submit = host.tools.get('skill_candidate_submit')
  const capture = host.commands.get('skill-capture')
  const quoted = [{ class: 'user', quote: line }]

  const created = await submit.execute({
    name: 'soffice-stale',
    description: 'Convert spreadsheets with soffice.',
    body: '1. Run soffice --convert-to csv',
    evidence: quoted
  }, { agent })
  check('stale setup: the base skill was written', created.ok === true && created.autoWritten === true, JSON.stringify(created).slice(0, 200))

  // From here on the plugin stages revisions instead of writing them, so the
  // approval below actually gates a write.
  config.mode = 'suggest'

  const staged = await submit.execute({
    name: 'soffice-stale',
    description: 'Convert spreadsheets with soffice.',
    body: '1. Run soffice --convert-to csv\n2. Check the row count afterwards',
    evidence: quoted
  }, { agent })
  check('stale setup: the revision was staged, not written', staged.ok === true && staged.kind === 'update', JSON.stringify(staged).slice(0, 200))

  await capture.handler({ rawInput: 'soffice-stale', agent })

  // Somebody edits the skill by hand between approval and finalisation. This is
  // the change the buggy code overwrote.
  const skillPath = join(root, 'skills', 'soffice-stale', 'SKILL.md')
  const before = await readFile(skillPath, 'utf8')
  const edited = before.replace(
    '1. Run soffice --convert-to csv',
    '1. Run soffice --convert-to csv\n2. Never open the file in a library first'
  )
  check('stale setup: the hand edit landed on disk', edited !== before, 'the body line was not found')
  await writeFile(skillPath, edited, 'utf8')

  const finalised = await submit.execute({
    name: 'soffice-stale',
    description: 'Convert spreadsheets with soffice.',
    body: '1. Run soffice --convert-to csv\n2. Check the row count afterwards',
    final: true
  }, { agent })

  check(
    'finalize refuses a candidate that went stale after approval',
    finalised.ok === false && finalised.code === 'stale',
    JSON.stringify(finalised).slice(0, 240)
  )
  const after = await readFile(skillPath, 'utf8')
  check('the hand edit survives the refused finalize', after.includes('Never open the file in a library first'), JSON.stringify(after.slice(0, 200)))
}

// --- P3: whitespace in `whenToUse` is not a change the user approved -------
//
// The propose branch normalises `whenToUse` (trim, empty becomes absent) before
// computing the digest that approval is bound to. The final branch passed the
// raw string through, so a model that sent `"  "` or a trailing space produced
// a different digest and was told the draft had changed since approval, when
// the text it published was byte-identical.
{
  await makeRoot('skill-evolve-whentouse-')
  const host = fakeHost()
  apply(host.ctx, Config({ mode: 'suggest' }))
  const agent = fakeAgent('session-whentouse', 'F:/proj')
  host.agents.set(agent.id, agent)
  const line = 'Run the converter through the command line tool, not the library.'
  agent.push({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: line }] } })

  const submit = host.tools.get('skill_candidate_submit')
  const capture = host.commands.get('skill-capture')
  const quoted = [{ class: 'user', quote: line }]
  const draft = {
    name: 'converter-cli',
    description: 'Convert through the CLI.',
    body: '1. Run the tool',
    whenToUse: '  When a spreadsheet needs converting.  '
  }

  await submit.execute({ ...draft, evidence: quoted }, { agent })
  const approved = await capture.handler({ rawInput: 'converter-cli', agent })
  // The command handler reports `{kind, text}`, not `{ok}` — checking `ok` here
  // would be permanently true and would let every later assertion fail for a
  // misleading reason when the approval never happened at all.
  check('whenToUse setup: the candidate was approved', approved?.kind === 'success', JSON.stringify(approved).slice(0, 200))

  // Same padded string the model sent before. If the final branch does not
  // normalise it, the digest differs and this comes back as changed-since-approval.
  const finalised = await submit.execute({ ...draft, final: true }, { agent })
  check(
    'a padded whenToUse is not treated as a new draft',
    finalised.ok === true,
    JSON.stringify(finalised).slice(0, 240)
  )
  // Read defensively: when the assertion above fails the file was never
  // written, and an ENOENT here would abort the run before the failure is
  // reported — a test that crashes instead of failing hides its own regression.
  const written = await readFile(join(process.env.DSH_HOME, 'skills', 'converter-cli', 'SKILL.md'), 'utf8').catch(() => '')
  check('the padded whenToUse was stored trimmed', /when-to-use: "When a spreadsheet needs converting\."/.test(written), written.slice(0, 240))
}

// --- P1: an approved revision never publishes a blank identity -------------
//
// `writeApprovedWithin` built the state for an update with `base.id ?? previous.id
// ?? candidate.id`. `readState` reports a missing frontmatter key as `''`, so a
// skill whose id was blanked (by an older version of this plugin, or by hand)
// kept `''` and the rewrite erased the identity for good. Strings use `||`;
// the counters keep `??` because `0` is a real count.
{
  const root = await makeRoot('skill-evolve-blank-approved-')

  // `auto` gives us an owned file to revise without re-implementing the writer.
  const host = fakeHost()
  const config = Config({ mode: 'auto' })
  apply(host.ctx, config)
  const agent = fakeAgent('session-approved', 'F:/proj')
  host.agents.set(agent.id, agent)
  const line = 'Check the exit code of the converter before reading its output.'
  agent.push({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: line }] } })

  const submit = host.tools.get('skill_candidate_submit')
  const capture = host.commands.get('skill-capture')
  const quoted = [{ class: 'user', quote: line }]
  const created = await submit.execute({
    name: 'converter-exit',
    description: 'Check the exit code.',
    body: '1. Run the converter',
    evidence: quoted
  }, { agent })
  check('approved-blank setup: the skill was written', created.ok === true && created.autoWritten === true, JSON.stringify(created).slice(0, 160))

  // Blank the identity *before* the revision is staged, so the digest the
  // approval binds to is the blanked file and the staleness check stays quiet.
  const path = join(root, 'skills', 'converter-exit', 'SKILL.md')
  const blanked = (await readFile(path, 'utf8')).replace(/^evolved-id:.*$/m, 'evolved-id: ""')
  await writeFile(path, blanked, 'utf8')
  check('approved-blank setup: the id is blank on disk', /^evolved-id: ""$/m.test(await readFile(path, 'utf8')), 'the strip did not apply')

  config.mode = 'suggest'
  const draft = { name: 'converter-exit', description: 'Check the exit code.', body: '1. Run the converter\n2. Read stderr' }
  const staged = await submit.execute({ ...draft, evidence: quoted }, { agent })
  check('approved-blank setup: the revision was staged', staged.ok === true && staged.kind === 'update', JSON.stringify(staged).slice(0, 200))
  await capture.handler({ rawInput: 'converter-exit', agent })

  const finalised = await submit.execute({ ...draft, final: true }, { agent })
  check('approved-blank: the finalize was accepted', finalised.ok === true, JSON.stringify(finalised).slice(0, 240))
  const after = await readFile(path, 'utf8')
  const id = /evolved-id:\s*"?([0-9a-z-]+)"?/.exec(after)?.[1] ?? ''
  check('approved-blank: the rewrite restored a non-blank id', id.length > 0, `evolved-id is ${JSON.stringify(id)}`)
}

// --- P3: clearing `whenToUse` at final time is a change, not a carry-over --
//
// After normalisation a blank `whenToUse` must stay `''` rather than collapse to
// `undefined`. `finalizeWithin` reads `undefined` as "the value the person
// approved", so folding an explicit clear into it writes the old hint back and
// still answers `ok: true` — a tool reporting success on a file it did not
// change. As `''` the digest moves and the draft goes back for a second look.
{
  await makeRoot('skill-evolve-whentouse-clear-')
  const host = fakeHost()
  apply(host.ctx, Config({ mode: 'suggest' }))
  const agent = fakeAgent('session-wtu-clear', 'F:/proj')
  host.agents.set(agent.id, agent)
  const line = 'Prefer the command line converter over the library binding.'
  agent.push({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: line }] } })

  const submit = host.tools.get('skill_candidate_submit')
  const capture = host.commands.get('skill-capture')
  const quoted = [{ class: 'user', quote: line }]
  const base = { name: 'cli-converter', description: 'Convert through the CLI.', body: '1. Run the tool', whenToUse: 'When converting a document.' }

  await submit.execute({ ...base, evidence: quoted }, { agent })
  const approved = await capture.handler({ rawInput: 'cli-converter', agent })
  check('clear setup: the candidate was approved', approved?.kind === 'success', JSON.stringify(approved).slice(0, 200))

  const cleared = await submit.execute({ ...base, whenToUse: '', final: true }, { agent })
  check(
    'an explicit clear goes back for approval instead of silently keeping the hint',
    cleared.ok === false && cleared.code === 'changed-since-approval',
    JSON.stringify(cleared).slice(0, 240)
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
