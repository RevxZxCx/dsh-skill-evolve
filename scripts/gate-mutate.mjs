#!/usr/bin/env node
/**
 * Mutation suite router & serial runner.
 *
 * Single source of truth mapping changed source files to the 11 mutation suites.
 *
 * Usage:
 *   node scripts/gate-mutate.mjs --list              # print all 11 suites & triggers
 *   node scripts/gate-mutate.mjs --changed           # run suites matching current git diff
 *   node scripts/gate-mutate.mjs --changed --dry-run # print matched suites without running
 *   node scripts/gate-mutate.mjs --all               # run all 11 suites serially
 *   node scripts/gate-mutate.mjs suggest guards      # run specific suites by substring
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const MUTATION_ROUTES = [
  {
    script: 'scripts/mutate-language-and-files.mjs',
    triggers: [
      /^packages\/ui-evolve\/lib\/(deliverable|summarise|transcript|api)\.js$/,
      /^scripts\/mutate-language-and-files\.mjs$/,
    ],
  },
  {
    script: 'scripts/mutate-checklist-panel.mjs',
    triggers: [
      /^packages\/ui-evolve\/lib\/(client|gutter)\.js$/,
      /^scripts\/mutate-checklist-panel\.mjs$/,
    ],
  },
  {
    script: 'scripts/mutate-persistence.mjs',
    triggers: [
      /^packages\/ui-evolve\/lib\/(session-state|session-store|index)\.js$/,
      /^scripts\/mutate-persistence\.mjs$/,
    ],
  },
  {
    script: 'scripts/mutate-speed.mjs',
    triggers: [
      /^packages\/ui-evolve\/lib\/(speed|api|client)\.js$/,
      /^scripts\/mutate-speed\.mjs$/,
    ],
  },
  {
    script: 'scripts/mutate-guards.mjs',
    triggers: [
      /^packages\/ui-evolve\/lib\/gutter\.js$/,
      /^scripts\/mutate-guards\.mjs$/,
    ],
  },
  {
    script: 'scripts/mutate-bundle.mjs',
    triggers: [
      /^packages\/ui-evolve\/lib\/(gutter|client)\.js$/,
      /^scripts\/mutate-bundle\.mjs$/,
    ],
  },
  {
    script: 'scripts/mutate-session-store.mjs',
    triggers: [
      /^packages\/ui-evolve\/lib\/session-store\.js$/,
      /^scripts\/mutate-session-store\.mjs$/,
    ],
  },
  {
    script: 'scripts/mutate-outcome.mjs',
    triggers: [
      /^packages\/core\/lib\/outcome\.js$/,
      /^packages\/skill-evolve\/lib\/index\.js$/,
      /^scripts\/mutate-outcome\.mjs$/,
    ],
  },
  {
    script: 'scripts/mutate-result-shape.mjs',
    triggers: [
      /^packages\/skill-evolve\/lib\/.*\.js$/,
      /^scripts\/mutate-result-shape\.mjs$/,
    ],
  },
  {
    script: 'scripts/mutate-suggest.mjs',
    triggers: [
      /^packages\/ui-evolve\/lib\/(suggest|transcript|summarise|api|client)\.js$/,
      /^scripts\/mutate-suggest\.mjs$/,
    ],
  },
  {
    script: 'test/mutate-panel.mjs',
    triggers: [
      /^packages\/ui-evolve\/lib\/(index|api)\.js$/,
      /^test\/mutate-panel\.mjs$/,
    ],
  },
]

function changedFiles() {
  const diff = spawnSync('git', ['-c', 'core.quotepath=false', 'diff', '--name-only', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  })
  const untracked = spawnSync(
    'git',
    ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  )
  const lines = `${diff.stdout ?? ''}\n${untracked.stdout ?? ''}`
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/\\/g, '/'))
    .filter(Boolean)
  return [...new Set(lines)]
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const listOnly = args.includes('--list')
  const runAll = args.includes('--all')
  const runChanged = args.includes('--changed')
  const filters = args.filter((a) => !a.startsWith('--'))

  if (listOnly || args.length === 0) {
    console.log(`Registered mutation suites (${MUTATION_ROUTES.length}):`)
    for (const route of MUTATION_ROUTES) {
      console.log(`  - ${route.script}`)
    }
    if (args.length === 0) {
      console.log('\nUse `--changed`, `--all`, or pass suite substrings (e.g. `suggest guards`).')
    }
    process.exit(0)
  }

  let selected = []
  if (runAll) {
    selected = MUTATION_ROUTES.map((r) => r.script)
  } else if (runChanged) {
    const files = changedFiles()
    selected = MUTATION_ROUTES
      .filter((route) => files.some((file) => route.triggers.some((re) => re.test(file))))
      .map((r) => r.script)
    console.log(`Changed files (${files.length}): ${files.slice(0, 12).join(', ')}${files.length > 12 ? ' ...' : ''}`)
  } else if (filters.length > 0) {
    selected = MUTATION_ROUTES
      .filter((r) => filters.some((f) => r.script.includes(f)))
      .map((r) => r.script)
  }

  if (selected.length === 0) {
    console.log('No mutation suites matched the selection.')
    process.exit(0)
  }

  console.log(`Selected mutation suites (${selected.length}):`)
  for (const s of selected) console.log(`  - ${s}`)
  if (dryRun) process.exit(0)

  for (const script of selected) {
    console.log(`\n=== [gate:mutate] node ${script} ===`)
    const res = spawnSync(process.execPath, [script], { cwd: root, stdio: 'inherit' })
    if ((res.status ?? 1) !== 0) {
      console.error(`\nFAIL [gate:mutate] ${script} exited with code ${res.status ?? 1}.`)
      process.exit(res.status ?? 1)
    }
  }

  console.log(`\nPASS [gate:mutate] all ${selected.length} selected mutation suites passed.`)
  process.exit(0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
