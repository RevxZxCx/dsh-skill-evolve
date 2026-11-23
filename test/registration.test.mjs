#!/usr/bin/env node
/**
 * 注册点表（`docs/27-开发与集成手册.md` §7）与代码的一致性检查。
 *
 * ## 这张表为什么需要一个测试
 *
 * 一张「加功能要碰哪几处」的表，如果有人记得更新、没人检查，它会在两个月内
 * 变成一份关于过去的说明：代码里多了一条路由，表里还是六条，读者按表做工就会
 * 漏掉第七处 —— 而漏掉的那一处不会报错，只会让功能「有时候不生效」。这就是本
 * 仓库反复出现的同一种缺陷：**约定写在文档里，没有东西守着它**。
 *
 * 所以这里不登记名字。每一类注册点都由**代码自己**数出来，再要求 §7 的对应块
 * 与它逐字相等。于是：
 *
 *   - 新增一条路由、一个配置键、一个工具 → 本测试变红，报出缺的名字；
 *   - 红的时候**不要改判据**，去 §7 那张表加一行（失败信息里写了加法）；
 *   - 删掉一个注册点 → 同样变红，报出表里多出来的那一行。
 *
 * 本文件只在「出现一整族新的注册面」时才需要改：`KINDS` 与 `FAMILIES` 各加一
 * 项、§7 加一块。`FAMILIES` 那组检查专门负责这种情况 —— 它扫的是信号而不是名
 * 字，所以「一个新文件开始订阅宿主事件」也跑不掉（写这一段时它就抓到了
 * `packages/ui-evolve/lib/report-tool.js` 里那个没人登记的工具）。
 *
 * ## 它不保证什么
 *
 * 它保证表与代码同名同数，不保证**每一行写对了**（「这一处要同时改哪三个文件」
 * 是散文，测试读不懂）。那半边靠 §2 第 6 步的审查，以及把「这一行写错了会怎
 * 样」写进表里。
 *
 * 跑法：`node test/registration.test.mjs`；`--dump` 只打印发现到的名字。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const MANUAL = 'docs/27-开发与集成手册.md'
const INDEX = 'docs/00-文档索引.md'

let passed = 0
let failed = 0

function check(label, ok, detail) {
  if (ok === true) {
    passed += 1
    return
  }
  failed += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const unreadable = new Set()

/**
 * 读一个产品文件。
 *
 * 文件被改名或删掉时，原来的实现抛 ENOENT，进程退出码 1、一条 FAIL 都不打印——
 * 而「重构了文件布局」正是最需要这句加法指令的时刻。所以这里记下名字交给下面
 * 一条专门的检查，让 53 条里剩下的照常跑完。
 */
function read(relative) {
  try {
    return readFileSync(join(root, relative), 'utf8')
  } catch {
    unreadable.add(relative)
    return ''
  }
}

function unique(list) {
  return [...new Set(list)]
}

function namesIn(files, pattern) {
  const found = []
  for (const file of files) {
    for (const match of read(file).matchAll(pattern)) found.push(match[1])
  }
  return unique(found).sort()
}

function countIn(file, pattern) {
  return read(file).match(pattern)?.length ?? 0
}

const CONFIG_KEY = /^ {2,6}([A-Za-z][A-Za-z0-9_]*): (?:z\.|[A-Za-z_$][\w$]*\()/gmu
const TOOL_NAME = /^ +name: '([a-z_]+)'/gmu
const COMMAND_NAME = /^ +name: '([a-z-]+)'/gmu

/**
 * 一条正则两种用法：`matchAll` 要 `/g`，`.test` 不能带 `/g`。
 *
 * 带 `/g` 的正则 `test()` 会留下 `lastIndex`，下一个文件就从那个偏移开始找——
 * 一次命中会让紧跟其后的文件整个失明，而且失明与否取决于文件顺序与长度。
 * 所以扫文件时一律用这个函数，它给每条正则配一个无状态的双胞胎。
 */
const stateless = new Map()
function hits(signal, text) {
  let probe = stateless.get(signal)
  if (probe === undefined) {
    probe = signal.global === true ? new RegExp(signal.source, signal.flags.replace('g', '')) : signal
    stateless.set(signal, probe)
  }
  return probe.test(text) === true
}

/**
 * 每一类注册点：代码侧怎么数，§7 里哪一块必须与它相等。
 *
 * 名字从代码里数出来，所以「同类里多一个」不需要改本文件；只有「多一整族」
 * 才要动下面的 `FAMILIES`。
 */
const KINDS = [
  {
    id: 'routes',
    label: 'HTTP 路由',
    add: '在 `packages/ui-evolve/lib/api.js` 的 handler 里加一个 `path === `${ROUTE_PREFIX}/x`` 分支，并在 §7 的 routes 块加一行。',
    find: () => ({
      mode: 'names',
      values: namesIn(
        ['packages/ui-evolve/lib/api.js'],
        /path === `\$\{ROUTE_PREFIX\}\/([A-Za-z0-9-]+)`/gu,
      ),
    }),
  },
  {
    id: 'slots',
    label: '宿主槽位',
    add: '在 `packages/ui-evolve/lib/client.js` 的 apply 里加 `ctx.slots.inject("槽位名", () => ctx.slots.register(...))`，并在 §7 的 slots 块加一行。',
    find: () => ({
      mode: 'names',
      values: namesIn(['packages/ui-evolve/lib/client.js'], /ctx\.slots\.inject\("([^"]+)"/gu),
    }),
  },
  {
    id: 'host-events',
    label: '订阅的宿主事件',
    add: '在对应的 `lib/index.js` 里加 `ctx.on(\'事件名\', safe(\'名字\', …))`（源码里全是单引号，双引号同样被认到），并在 §7 的 host-events 块加一行。',
    find: () => ({
      mode: 'names',
      values: namesIn(
        ['packages/skill-evolve/lib/index.js', 'packages/ui-evolve/lib/index.js'],
        /ctx\.on\(\s*['"]([^'"]+)['"]/gu,
      ),
    }),
  },
  {
    id: 'bump-sites',
    label: '推帧点（`revisions.bump`）',
    add: '在 `packages/ui-evolve/lib/index.js` 里改载荷的那一处加 `revisions.bump(agentId)`，并把 §7 的 bump-sites 数字加一。',
    find: () => ({
      mode: 'count',
      value: countIn('packages/ui-evolve/lib/index.js', /revisions\.bump\(/gu),
    }),
  },
  {
    id: 'config-ui',
    label: '配置键（ui-evolve）',
    add: '在 `packages/ui-evolve/lib/config.js` 的 `Config` 里加一个带 `default()` 的键，写进 `packages/ui-evolve/README.md` 的配置表，并在 §7 的 config-ui 块加一行。',
    find: () => ({
      mode: 'names',
      values: namesIn(['packages/ui-evolve/lib/config.js'], CONFIG_KEY),
    }),
  },
  {
    id: 'config-skill',
    label: '配置键（skill-evolve）',
    add: '在 `packages/skill-evolve/lib/config.js` 的 `Config` 里加一个带 `default()` 的键，写进 `packages/skill-evolve/README.md` 的配置表，并在 §7 的 config-skill 块加一行。',
    find: () => ({
      mode: 'names',
      values: namesIn(['packages/skill-evolve/lib/config.js'], CONFIG_KEY),
    }),
  },
  {
    id: 'tools',
    label: '工具',
    add: '在工具定义数组里加一项（`packages/skill-evolve/lib/tools.js` 或 `packages/ui-evolve/lib/report-tool.js`），写进对应包 README 的工具表，并在 §7 的 tools 块加一行。',
    find: () => ({
      mode: 'names',
      values: namesIn(
        ['packages/skill-evolve/lib/tools.js', 'packages/ui-evolve/lib/report-tool.js'],
        TOOL_NAME,
      ),
    }),
  },
  {
    id: 'commands',
    label: '命令',
    add: '在 `packages/skill-evolve/lib/commands.js` 里加一项，写进包 README 的命令表，并在 §7 的 commands 块加一行。',
    find: () => ({
      mode: 'names',
      values: namesIn(['packages/skill-evolve/lib/commands.js'], COMMAND_NAME),
    }),
  },
  {
    id: 'bundle-id',
    label: '客户端 bundle id',
    alsoFrom: 'packages/ui-evolve/package.json 的 name',
    also: () => JSON.parse(read('packages/ui-evolve/package.json')).name,
    add: '改 `packages/ui-evolve/lib/client.js` 头部的 `id:` 时，它必须逐字等于包名，并同步 §7 的 bundle-id 块。',
    find: () => {
      const id = /^\s*id: "([^"]+)"/mu.exec(read('packages/ui-evolve/lib/client.js'))
      return { mode: 'value', value: id === null ? 'UNREADABLE' : id[1] }
    },
  },
  {
    id: 'state-version',
    label: '状态文件版本',
    add: '升版本时同时改 `READABLE_VERSIONS`、读侧门控与双向读测试，并同步 §7 的 state-version 块。',
    find: () => {
      const match = /const STATE_VERSION = (\d+)/u.exec(
        read('packages/ui-evolve/lib/session-state.js'),
      )
      return { mode: 'value', value: match === null ? 'UNREADABLE' : match[1] }
    },
  },
  {
    id: 'mutation-suites',
    label: '变异套件',
    add: '新增一套变异脚本时，把它加进 §3 的表、`test/mutations.test.mjs` 的期望计数与 §7 的 mutation-suites 块。',
    find: () => ({
      mode: 'names',
      values: [
        ...walk('scripts').filter((name) => /(^|\/)mutate-[^/]*\.mjs$/u.test(name)),
        ...walk('test').filter((name) => /(^|\/)mutate-[^/]*\.mjs$/u.test(name)),
      ].sort(),
    }),
  },
]

/**
 * 「这一族存在」的信号与它今天出现的文件。
 *
 * 与 `KINDS` 分成两张表，是因为一族可以对应两类（两个包的配置各是一类，但
 * 都是 `z.object`）；合成一张会让两类的文件集合互相干扰，第一次跑就红在彼此
 * 身上。
 */
const FAMILIES = [
  {
    id: 'routes',
    label: 'HTTP 路由',
    signal: /path === `\$\{ROUTE_PREFIX\}/u,
    files: ['packages/ui-evolve/lib/api.js'],
  },
  {
    id: 'slots',
    label: '宿主槽位',
    signal: /ctx\.slots\.inject\(/u,
    files: ['packages/ui-evolve/lib/client.js'],
  },
  {
    id: 'host-events',
    label: '订阅的宿主事件',
    signal: /ctx\.on\(\s*['"]/u,
    files: ['packages/skill-evolve/lib/index.js', 'packages/ui-evolve/lib/index.js'],
  },
  {
    id: 'bump-sites',
    label: '推帧点',
    signal: /revisions\.bump\(/u,
    files: ['packages/ui-evolve/lib/index.js'],
  },
  {
    id: 'config',
    label: '配置对象',
    signal: /z\.object\(/u,
    files: ['packages/skill-evolve/lib/config.js', 'packages/ui-evolve/lib/config.js'],
  },
  {
    id: 'tools',
    label: '工具定义',
    signal: TOOL_NAME,
    files: ['packages/skill-evolve/lib/tools.js', 'packages/ui-evolve/lib/report-tool.js'],
  },
  {
    id: 'commands',
    label: '命令定义',
    signal: COMMAND_NAME,
    files: ['packages/skill-evolve/lib/commands.js'],
  },
  {
    id: 'bundle',
    label: '客户端 bundle',
    signal: /__ModuleLoader__\.load\(/u,
    files: ['packages/ui-evolve/lib/client.js'],
  },
  {
    id: 'state',
    label: '状态文件版本',
    signal: /const STATE_VERSION = /u,
    files: ['packages/ui-evolve/lib/session-state.js'],
  },
]

const manual = read(MANUAL)
const dump = process.argv.includes('--dump')

function blockOf(id) {
  const open = `<!-- registration:${id} -->`
  const close = `<!-- /registration:${id} -->`
  const from = manual.lastIndexOf(open)
  const to = manual.lastIndexOf(close)
  if (from < 0 || to < 0 || to < from) return undefined
  return manual.slice(from + open.length, to)
}

function docNames(block) {
  return unique([...block.matchAll(/^\| `([^`]+)` \|/gmu)].map((match) => match[1])).sort()
}

function missing(names, from) {
  return names.filter((name) => from.includes(name) === false)
}

if (dump === true) {
  for (const kind of KINDS) {
    const found = kind.find()
    const shown = found.mode === 'names' ? found.values.join(' ') : String(found.value)
    console.log(`${kind.id}: ${shown}`)
  }
  process.exit(0)
}

for (const kind of KINDS) {
  const found = kind.find()
  const block = blockOf(kind.id)
  check(
    `§7 有 registration:${kind.id} 块`,
    block !== undefined,
    `在 ${MANUAL} 的 §7 加注释行 <!-- registration:${kind.id} --> … <!-- /registration:${kind.id} -->`,
  )
  if (block === undefined) continue

  if (found.mode === 'names') {
    check(
      `${kind.label}：代码侧数得出名字`,
      found.values.length > 0,
      '正则没命中任何东西——判据坏了，不是代码里没有',
    )
    const documented = docNames(block)
    const absent = missing(found.values, documented)
    const extra = missing(documented, found.values)
    check(
      `${kind.label}：${found.values.length} 条都写进了 §7`,
      absent.length === 0,
      absent.length === 0 ? undefined : `${absent.join(' / ')} 缺行。加法：${kind.add}`,
    )
    check(
      `${kind.label}：§7 没有多出来的行`,
      extra.length === 0,
      extra.length === 0
        ? undefined
        : `${extra.join(' / ')} 在代码里找不到（删了或改名了？）。删掉 §7 那一行，或把代码补回来。`,
    )
  } else if (found.mode === 'count') {
    const stated = /\*\*(\d+)\*\*/u.exec(block)
    check(`${kind.label}：§7 写了数字`, stated !== null, '块里要有一行 `共 **N** 处`')
    if (stated !== null) {
      check(
        `${kind.label}：代码 ${found.value} 处与 §7 的 ${stated[1]} 一致`,
        Number(stated[1]) === found.value,
        found.value > Number(stated[1])
          ? `少 ${found.value - Number(stated[1])} 处。加法：${kind.add}`
          : `多 ${Number(stated[1]) - found.value} 处，删掉表里那处。`,
      )
    }
  } else {
    check(
      `${kind.label}：${found.value} 写在 §7`,
      block.includes(`\`${found.value}\``) === true,
      `块里要出现 \`${found.value}\`（代码里现在的值是 ${found.value}）。${kind.add}`,
    )
    if (kind.also !== undefined) {
      const other = kind.also()
      check(
        `${kind.label}：§7 与 ${kind.alsoFrom} 一致`,
        other === found.value,
        `§7 写 ${found.value}，${kind.alsoFrom} 写 ${String(other)}——两边必须逐字相同`,
      )
    }
  }
}

/**
 * 新的一族注册面：扫信号，而不是扫名字。
 *
 * 上面那些检查保证「同类里多一个名字」会被看见；这一组保证「一类全新的东西出
 * 现在一个新文件里」也会被看见。它不试图穷举宿主给的每一族 API —— 做不到，那
 * 是 §7 让人自己回答「你碰的是不是这十一族之一」的理由。
 */
/**
 * 产品源码的每个文件，递归。
 *
 * 只扫 `lib` 顶层会漏掉 `lib/deep/x.js` 与 `lib/index.mjs`；漏掉的形态看不出
 * 「我没扫到」和「这里没有」的区别，所以递归到底并把 `src` 也算进来。
 */
function walk(relative) {
  const found = []
  let entries = []
  try {
    entries = readdirSync(join(root, relative), { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const next = `${relative}/${entry.name}`
    if (entry.isDirectory() === true) found.push(...walk(next))
    else if (/\.(?:js|mjs)$/u.test(entry.name) === true) found.push(next)
  }
  return found
}

const sourceFiles = []
const packageDirs = (() => {
  try {
    return readdirSync(join(root, 'packages'))
  } catch {
    unreadable.add('packages/')
    return []
  }
})()
for (const packageName of packageDirs) {
  for (const dir of ['lib', 'src']) {
    sourceFiles.push(...walk(`packages/${packageName}/${dir}`))
  }
}

check(
  '登记的每个产品文件都还在',
  unreadable.size === 0,
  unreadable.size === 0
    ? undefined
    : `${[...unreadable].sort().join(' / ')} 读不到。加法：把新路径写进 KINDS 里那条 find 的 files 与 FAMILIES 里对应那一项的 files；文件只是改名的话，改这两处即可。`,
)

for (const family of FAMILIES) {
  const seen = sourceFiles.filter((file) => hits(family.signal, read(file)) === true)
  const undeclared = seen.filter((file) => family.files.includes(file) === false)
  check(
    `${family.label}：只有登记过的文件出现这一族调用`,
    undeclared.length === 0,
    undeclared.length === 0
      ? undefined
      : `${undeclared.join(' / ')} 也出现了这一族调用。加法：把它加进 test/registration.test.mjs 的 FAMILIES 里 ${family.id} 的 files，在 KINDS 里确认它被数到，并在 §7 写清这个文件做什么。`,
  )
}

check(
  '§7 说明了这张表由谁守着',
  manual.includes('registration.test.mjs') === true,
  '维护约束段要写出测试文件名，否则读者不知道红了该看哪里',
)
check(
  '§7 写了「不是改判据」',
  manual.includes('不是改判据') === true,
  '维护约束要明说：红了是加行，不是放宽检查',
)
check(
  `${INDEX} 的「按目的进入」有加新功能一条`,
  read(INDEX).includes('新功能') === true &&
    read(INDEX).includes('27-开发与集成手册.md') === true &&
    read(INDEX).includes('§7') === true,
  '在 docs/00-文档索引.md 的按目的进入加一条指向 §7 的条目',
)
check(
  '§7 的四个问题都在',
  ['### Q1 · ', '### Q2 · ', '### Q3 · ', '### Q4 · '].every(
    (marker) => manual.includes(marker) === true,
  ),
  '§7 开头那四个问题缺一条；它们是「先想清楚再动手」的全部内容',
)
const firstStepAt = manual.indexOf('### 第 1 步')
check(
  `§2 的「### 第 1 步」标题还在`,
  firstStepAt > 0,
  '找不到这个标题，下面那条「§2 开头指向 §7」就失去意义了；改标题时同步改本文件',
)
const beforeFirstStep = firstStepAt < 0 ? '' : manual.slice(0, firstStepAt)
check(
  '§2 开头指向 §7',
  /新功能[^。]*§7/u.test(beforeFirstStep) === true,
  '在 §2 的导语里加一句：新功能先过 §7，再从第 1 步开始',
)

console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
