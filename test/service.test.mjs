/**
 * Regression: a service this plugin reads but did not declare in `inject` must
 * degrade one check, not silently disable detection.
 *
 * `apply()` used to read `ctx.agents` directly. Cordis throws
 * `cannot get property "agents" without inject` on the *property read itself*,
 * and `safe()` swallowed it, so every `tool/call` returned at the first line of
 * the handler. The plugin loaded, its tools worked, and no hint was ever
 * published — invisible to the other 74 assertions in `index.test.mjs` because
 * their fake host provides `agents` unconditionally.
 *
 * This test builds the hostile shape instead: a context that throws on any
 * undeclared property, exactly as cordis does.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'skill-evolve-svc-'))
process.env.DSH_HOME = root

const { Config } = await import('../lib/config.js')
const { apply } = await import('../lib/index.js')

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

/**
 * Build a context whose undeclared services throw, like cordis' proxy handler.
 *
 * @param {string[]} declared - the names this plugin is allowed to read.
 * @returns {object} the fake host.
 */
function hostileHost(declared) {
  const handlers = new Map()
  const tools = new Map()
  const contexts = new Map()
  const logs = []
  const throwFor = []

  const base = {
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
    get(name) {
      if (name in base) return base[name]
      if (declared.includes(name)) {
        // Declared but this fake host provides nothing for it.
        return undefined
      }
      throwFor.push(name + ':get')
      throw new Error('cannot get property "' + name + '" without inject')
    },
    inject(names, callback) {
      const missing = names.filter((name) => declared.includes(name) === false)
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
      register() {
        return () => {}
      }
    },
    systemPrompt: {
      context(entry) {
        contexts.set(entry.name, entry)
        return () => contexts.delete(entry.name)
      }
    }
  }

  const ctx = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop)
      if (prop in target) return Reflect.get(target, prop)
      if (declared.includes(prop)) return undefined
      throwFor.push(prop)
      throw new Error(`cannot get property "${prop}" without inject`)
    }
  })

  return {
    ctx,
    handlers,
    tools,
    contexts,
    logs,
    throwFor,
    emit(event, ...payload) {
      for (const handler of handlers.get(event) ?? []) handler(...payload)
    }
  }
}

console.log('service probe — undeclared services must not disable detection')

{
  const host = hostileHost(['tools', 'systemPrompt'])

  let mounted
  try {
    apply(host.ctx, Config({ mode: 'suggest', minRepeatCount: 2, minWindow: 3 }))
    mounted = true
  } catch (error) {
    mounted = false
    check('apply survives an undeclared service', false, error?.message)
  }
  if (mounted) check('apply survives an undeclared service', true)

  const session = { id: 'session-probe-1', header: { id: 'session-probe-1', cwd: root } }
  const call = (name, id) => ({
    type: 'tool/call',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, callId: id, name, arguments: '{}' }
  })

  const sequence = ['read', 'edit', 'bash', 'grep', 'read', 'edit', 'bash']
  sequence.forEach((name, index) => host.emit('session/event', session, call(name, 'call-' + index)))

  const hint = host.contexts.get('skill-evolve:hint')
  check('the hint context is registered', hint !== undefined)
  const rendered = hint === undefined ? '' : hint.text({ agent: { id: 'session-probe-1' } })
  check('detection still runs without the agents service', rendered.length > 0, 'rendered length ' + rendered.length + '; throwFor=' + host.throwFor.join(','))

  const errors = host.logs.filter((line) => line.includes('ignored'))
  check('no handler swallowed an exception', errors.length === 0, errors.join(' / '))
}

{
  const host = hostileHost(['tools', 'systemPrompt', 'agents'])
  const session = { id: 'session-probe-2', header: { id: 'session-probe-2', cwd: root } }
  const call = (name, id) => ({
    type: 'tool/call',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, callId: id, name, arguments: '{}' }
  })
  apply(host.ctx, Config({ mode: 'suggest', minRepeatCount: 2, minWindow: 3 }))
  const sequence = ['read', 'edit', 'bash', 'grep', 'read', 'edit', 'bash']
  sequence.forEach((name, index) => host.emit('session/event', session, call(name, 'c-' + index)))
  const hint = host.contexts.get('skill-evolve:hint')
  const rendered = hint === undefined ? '' : hint.text({ agent: { id: 'session-probe-2' } })
  check('a host that does declare agents also works', rendered.length > 0)
}

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
