/**
 * Mount the real plugin under the real cordis, because a fake host cannot catch
 * this class of bug.
 *
 * Reading a service the plugin never declared in `inject` throws on the
 * *property read*:
 *
 *     cannot get property "agents" without inject
 *
 * The plugin used to read `ctx.agents?.get?.(agentId)` directly. Optional
 * chaining does not help — the proxy throws before `?.` is reached — and
 * `safe()` swallowed the exception, so every `tool/call` handler returned on its
 * first line. The plugin mounted, its tools answered, and no hint ever reached
 * the model. Every assertion in the other test files passed while this was true,
 * because their fake context defines `agents` as an ordinary property and so
 * never throws.
 *
 * Skips when `@deepseek-ai/cordis` is not installed, so the suite still runs in a
 * checkout without peer dependencies. Point `DSH_CORDIS_ENTRY` at a cordis entry
 * to run it anyway.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const candidates = [
  process.env.DSH_CORDIS_ENTRY,
  join(process.cwd(), 'node_modules/@deepseek-ai/cordis/lib/index.js')
].filter((entry) => typeof entry === 'string' && entry.length > 0)

const entry = candidates.find((candidate) => existsSync(candidate))

console.log('real-mount.test.mjs — the plugin under the real cordis')

if (entry === undefined) {
  console.log('  skip  @deepseek-ai/cordis is not installed (set DSH_CORDIS_ENTRY to run this test)')
  console.log('\n0 passed, 0 failed (1 skipped)')
  process.exit(0)
}

const { Context, Service } = await import(pathToFileURL(entry).href)
const { Config } = await import('../lib/config.js')
const { apply, inject } = await import('../lib/index.js')

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + label)
  } else {
    failed += 1
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

class SystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
    this.contexts = new Map()
  }

  context(entry) {
    this.contexts.set(entry.name, entry)
    return () => this.contexts.delete(entry.name)
  }

  section() {
    return () => {}
  }
}

class Tools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.registry = new Map()
  }

  register(tool) {
    this.registry.set(tool.name, tool)
    return () => this.registry.delete(tool.name)
  }
}

// Deliberately absent: `agents`, `sessionQuery`, `commands`. A real host provides
// them, but they are exactly the names this plugin never declares, so the point
// of this mount is that detection must not depend on them.
const root = new Context()
root.plugin(SystemPrompt)
root.plugin(Tools)

root.plugin({
  name: 'skill-evolve',
  inject,
  apply(ctx) {
    apply(ctx, Config({ mode: 'suggest', minRepeatCount: 2, minWindow: 3 }))
  }
})

await new Promise((resolve) => setTimeout(resolve, 120))

const systemPrompt = root.get('systemPrompt')
check('the plugin mounts under real cordis', systemPrompt !== undefined)
check('the hint context is registered', systemPrompt?.contexts.has('skill-evolve:hint') === true)
check('the tools are registered', root.get('tools')?.registry.size > 0)

const session = { id: 'session-real-1', header: { id: 'session-real-1', cwd: process.cwd() } }
const call = (name, index) => ({
  type: 'tool/call',
  seq: index,
  time: Date.now(),
  data: { turn: 1, step: index, callId: 'c' + index, name, arguments: '{}' }
})

const sequence = ['read', 'edit', 'bash', 'grep', 'read', 'edit', 'bash', 'grep']
let thrown
try {
  sequence.forEach((name, index) => root.emit('session/event', session, call(name, index)))
} catch (error) {
  thrown = error
}

check('emitting tool calls does not throw', thrown === undefined, thrown?.message)

const hint = systemPrompt?.contexts.get('skill-evolve:hint')
const rendered = hint === undefined ? '' : hint.text({ agent: { id: 'session-real-1' } })
check('detection publishes a hint without an agents service', rendered.length > 0, 'rendered ' + rendered.length + ' chars')

// Expiry under the real event bus. `assistant/message` is a plain event, so the
// plugin has to be listening on the same bus the host emits on — the fake host
// in index.test.mjs can only prove the handler body works, not that it is
// wired to the bus the host actually uses.
const message = (index) => ({
  type: 'assistant/message',
  seq: index,
  time: Date.now(),
  data: { turn: 1, step: index, message: { role: 'assistant', content: [] } }
})
for (let index = 0; index < 8; index += 1) root.emit('session/event', session, message(100 + index))
const afterExpiry = hint === undefined ? '' : hint.text({ agent: { id: 'session-real-1' } })
check('a silent hint retires under the real event bus', afterExpiry === '', 'rendered ' + afterExpiry.length + ' chars')

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
