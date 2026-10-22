/**
 * Process E: counting real loads of a managed skill.
 *
 * The host's `skill` tool is the only signal that a skill was actually used —
 * the catalog is read from memory, so no provider callback fires. This suite
 * drives the plugin through that event and checks three things that are easy
 * to get wrong in isolation:
 *
 * 1. The counter moves on a real load and on nothing else.
 * 2. A load of somebody else's skill is never counted, even when the name is
 *    spelled correctly and the file exists.
 * 3. Counting refreshes `validated`, so a well-used skill stops oscillating
 *    between `active` and `stale`.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'
import { readSkillFile, readState } from '../lib/skillfile.js'

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

function fakeHost() {
  const handlers = new Map()
  const tools = new Map()
  const commands = new Map()
  const contexts = new Map()
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
    effect(register) {
      return register()
    },
    inject(names, callback) {
      return names.every((name) => ctx[name] !== undefined) ? callback(ctx) : undefined
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
      roots: () => [...agents.values()].filter((agent) => agent.parent === undefined),
      get: (id) => agents.get(id)
    }
  }

  return {
    ctx,
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

function fakeAgent(id) {
  return {
    id,
    session: { id, header: { id, cwd: 'F:/some/project' }, ownEvents: () => [], snapshotEvents: () => [] }
  }
}

/**
 * Build a `tool/call` event the way the host really emits it: `arguments` is
 * the model's raw JSON text, not a parsed object.
 */
function skillCall(skillName, callId, { raw } = {}) {
  return {
    type: 'tool/call',
    seq: 1,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      callId,
      name: 'skill',
      arguments: raw ?? JSON.stringify({ name: skillName })
    }
  }
}

/**
 * Write a skill file the plugin owns, with an explicit lifecycle state.
 */
async function seedSkill(root, name, state, { owned = true } = {}) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  const marker = owned ? 'dsh-skill-evolve' : 'somebody-else'
  const lines = [
    '---',
    `name: "${name}"`,
    'description: "seeded for the usage suite"',
    ...(owned ? [`evolved-by: "${marker}"`] : []),
    ...(owned
      ? [
          `evolved-id: "${state.id}"`,
          `evolved-stage: "${state.stage}"`,
          `evolved-created: "${state.created}"`,
          `evolved-uses: "${state.uses}"`,
          `evolved-helpful: "${state.helpful ?? 0}"`,
          `evolved-harmful: "${state.harmful ?? 0}"`,
          `evolved-validated: "${state.validated}"`,
          'evolved-evidence: "seeded"'
        ]
      : []),
    '---',
    '',
    'Body for the usage suite.'
  ]
  await writeFile(join(directory, 'SKILL.md'), `${lines.join('\n')}\n`, 'utf8')
}

const base = await mkdtemp(join(tmpdir(), 'skill-evolve-usage-'))
process.env.DSH_HOME = base
const skillsRoot = join(base, 'skills')

console.log('usage — counting real loads')

try {
  const host = fakeHost()
  // `suggest` (the default) rather than `auto`: a load must be counted whether
  // or not the plugin is allowed to write skills by itself.
  const config = Config({ mode: 'suggest', promoteAfterUses: 3, staleAfterDays: 90 })
  apply(host.ctx, config)
  const agent = fakeAgent('session-usage')
  host.agents.set(agent.id, agent)

  const now = new Date().toISOString()
  await seedSkill(skillsRoot, 'windows-gbk-encoding', {
    id: 'skill-gbk',
    stage: 'unverified',
    created: now,
    uses: 0,
    helpful: 0,
    harmful: 0,
    validated: now
  })

  const stateOf = async (name) => readState((await readSkillFile(join(skillsRoot, name, 'SKILL.md'))).data)
  const registryOf = async () =>
    JSON.parse(await readFile(join(base, 'plugin-data', 'skill-evolve', 'registry.json'), 'utf8'))
  const ledgerLines = async () => {
    const text = await readFile(join(base, 'plugin-data', 'skill-evolve', 'ledger.jsonl'), 'utf8')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }

  // ---- the happy path ------------------------------------------------------
  host.emit('session/event', agent.session, skillCall('windows-gbk-encoding', 'use_1'))
  await sleep(60)
  let registry = await registryOf()
  check('a load increments the registry counter', registry['windows-gbk-encoding']?.uses === 1, JSON.stringify(registry['windows-gbk-encoding']))
  let ledger = await ledgerLines()
  const useLines = ledger.filter((entry) => entry.action === 'skill_used')
  check('the load is written to the ledger', useLines.length === 1, String(useLines.length))
  check('the ledger line names the skill', useLines[0]?.skill === 'windows-gbk-encoding')
  check('the ledger line records the session', useLines[0]?.sessionId === 'session-usage')
  check('the registry keeps the stage unchanged', registry['windows-gbk-encoding']?.stage === 'unverified')

  // A second and third load reach the promotion threshold.
  host.emit('session/event', agent.session, skillCall('windows-gbk-encoding', 'use_2'))
  await sleep(60)
  host.emit('session/event', agent.session, skillCall('windows-gbk-encoding', 'use_3'))
  await sleep(120)
  registry = await registryOf()
  check('three loads accumulate', registry['windows-gbk-encoding']?.uses === 3, String(registry['windows-gbk-encoding']?.uses))
  check('three loads promote to active', registry['windows-gbk-encoding']?.stage === 'active', registry['windows-gbk-encoding']?.stage)
  const promotedState = await stateOf('windows-gbk-encoding')
  check('the promotion reaches the skill file', promotedState.stage === 'active', promotedState.stage)
  check('the file carries the new count', promotedState.uses === 3, String(promotedState.uses))
  check('the promotion keeps the skill id', promotedState.id === 'skill-gbk', promotedState.id)
  check('the promotion keeps the evidence', promotedState.evidence === 'seeded', promotedState.evidence)

  // ---- counting refreshes the validation clock ------------------------------
  const staleBefore = new Date(Date.now() - 200 * 86_400_000).toISOString()
  await seedSkill(skillsRoot, 'old-skill', {
    id: 'skill-old',
    stage: 'active',
    created: staleBefore,
    uses: 5,
    helpful: 5,
    harmful: 0,
    validated: staleBefore
  })
  host.emit('session/event', agent.session, skillCall('old-skill', 'use_old'))
  await sleep(120)
  const revived = await stateOf('old-skill')
  check('using a stale skill re-validates it', revived.validated !== staleBefore, revived.validated)
  check('the re-validated skill is active, not stale', revived.stage === 'active', revived.stage)

  // Using it again must not flip it back: this was the oscillation that a
  // counter increment without a validation refresh produced.
  host.emit('session/event', agent.session, skillCall('old-skill', 'use_old_2'))
  await sleep(120)
  const stillActive = await stateOf('old-skill')
  check('a second immediate use does not oscillate', stillActive.stage === 'active', stillActive.stage)

  // ---- names that must never count -----------------------------------------
  await seedSkill(skillsRoot, 'foreign-skill', { id: 'x', stage: 'unverified', created: now, uses: 0, validated: now }, { owned: false })
  host.emit('session/event', agent.session, skillCall('foreign-skill', 'use_foreign'))
  await sleep(80)
  const foreignUntouched = await readFile(join(skillsRoot, 'foreign-skill', 'SKILL.md'), 'utf8')
  check('a skill we do not own is never counted', foreignUntouched.includes('Body for the usage suite'))
  const afterForeign = await ledgerLines()
  check('no ledger line is written for a foreign skill', afterForeign.filter((entry) => entry.skill === 'foreign-skill').length === 0)

  host.emit('session/event', agent.session, skillCall('no-such-skill', 'use_missing'))
  await sleep(80)
  const afterMissing = await ledgerLines()
  check('an unknown name writes nothing', afterMissing.filter((entry) => entry.skill === 'no-such-skill').length === 0)

  // ---- malformed argument payloads -----------------------------------------
  const beforeMalformed = (await ledgerLines()).length
  host.emit('session/event', agent.session, skillCall('windows-gbk-encoding', 'bad_1', { raw: '{"name": "windows-gbk' }))
  host.emit('session/event', agent.session, skillCall('windows-gbk-encoding', 'bad_2', { raw: '[]' }))
  host.emit('session/event', agent.session, skillCall('windows-gbk-encoding', 'bad_3', { raw: '{}' }))
  host.emit('session/event', agent.session, skillCall('windows-gbk-encoding', 'bad_4', { raw: '"a string"' }))
  await sleep(120)
  const afterMalformed = (await ledgerLines()).length
  check('a truncated or shapeless argument is not a load', afterMalformed === beforeMalformed, `${beforeMalformed} → ${afterMalformed}`)

  // ---- a pre-parsed payload still counts (the host's PTC path) -------------
  const prepared = {
    type: 'tool/call',
    seq: 2,
    time: Date.now(),
    data: { turn: 1, step: 1, callId: 'ptc_1', name: 'skill', arguments: { name: 'windows-gbk-encoding' } }
  }
  const beforePrepared = (await registryOf())['windows-gbk-encoding'].uses
  host.emit('session/event', agent.session, prepared)
  await sleep(100)
  const afterPrepared = (await registryOf())['windows-gbk-encoding'].uses
  check('an already-parsed payload is still counted', afterPrepared === beforePrepared + 1, `${beforePrepared} → ${afterPrepared}`)

  // ---- other tools are ignored ---------------------------------------------
  const beforeOther = (await registryOf())['windows-gbk-encoding'].uses
  host.emit('session/event', agent.session, {
    type: 'tool/call',
    seq: 3,
    time: Date.now(),
    data: { turn: 1, step: 1, callId: 'other_1', name: 'bash', arguments: JSON.stringify({ name: 'windows-gbk-encoding' }) }
  })
  await sleep(80)
  const afterOther = (await registryOf())['windows-gbk-encoding'].uses
  check('a different tool with a name argument does not count', afterOther === beforeOther, `${beforeOther} → ${afterOther}`)

  // ---- a lost registry is rebuilt from the file -----------------------------
  await rm(join(base, 'plugin-data', 'skill-evolve', 'registry.json'), { force: true })
  host.emit('session/event', agent.session, skillCall('windows-gbk-encoding', 'use_rebuild'))
  await sleep(120)
  const rebuilt = await registryOf()
  check('a lost registry is rebuilt from the skill file', rebuilt['windows-gbk-encoding']?.uses === 5, String(rebuilt['windows-gbk-encoding']?.uses))
  check('the rebuilt entry keeps the stage', rebuilt['windows-gbk-encoding']?.stage === 'active', rebuilt['windows-gbk-encoding']?.stage)

  // ---- stats reflect the counter -------------------------------------------
  const stats = await host.commands.get('skill-stats').handler({ rawInput: '', agent })
  check('stats reports the use count', stats.kind === 'success' && /windows-gbk-encoding/.test(stats.text), stats.text.slice(0, 200))
} finally {
  await rm(base, { recursive: true, force: true })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
