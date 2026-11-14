# 17 · 上一轮总结卡：开发 Spec

本文是 [`16-上一轮总结卡定稿方案.md`](./16-上一轮总结卡定稿方案.md) 的施工版。16 回答「做什么、为什么」，本文回答「改哪个文件的哪一行、接口长什么样、怎么证明改对了」。

**决策已定（用户 2026-11-12）：**

| # | 决策 | 影响 |
| --- | --- | --- |
| 1 | 摘要用**对话语言** | 新增「用户原话」进 prompt；`language` 从缓存键里消失 |
| 2 | 预生成按保守策略（面板打开过才跑） | `Summariser` 需要记录「这个会话被看过」 |
| 3 | 字数上限 300 | `MAX_SUMMARY_CHARS` 400 → 300 |
| 4 | P2 做，且重要 | 最高优先级，其余三项并行不冲突 |

---

## 一、决策 1 引出的两个必须一起改的东西

「用对话语言」听起来只是改一句提示词，实际不是。核实后有两个前置条件，**缺任何一个都会让这个决策变成空话**。

### 1.1 transcript 目前完全不记录用户说了什么

`packages/ui-evolve/lib/transcript.js:452-455`：

```js
if (type === 'user/message') {
  if (data?.source?.kind !== 'user') return
  this.for(agentId).beginTurn()
  return
}
```

只开了新回合，`data.content` **从未被读取**。而 `renderPromptBody`（`summarise.js:247-273`）送给模型的只有四样东西：工具调用统计、改过的文件、跑过的命令、助手原话。

**模型的输入里没有一个字是用户写的。** 所以「按对话语言写」这句话，模型无从执行——它只能从助手用的语言去猜，而助手用什么语言，本来就是它自己决定的。

**必须补：** 记录用户本回合的原话。见 §三 T-1、T-2。

### 1.2 语言进了缓存键，预生成才有意义

`summarise.js:472`：

```js
const key = `${agentId}:${summaryKey(snapshot.turn, body, spoken.length > 0 ? spoken : undefined)}`
```

现有设计里语言是键的一部分，理由写在注释里（切界面语言后不该继续读旧语言的摘要），这个理由是对的。

但**改成对话语言之后，语言不再是外部输入**——它就是 body 本身的一部分。同一个 body 必然同一种语言。所以：

- 语言从键里移除，**不等于**丢失了区分能力：body 变了键就变
- 而且这正好解掉 16 文 §5 决策 1 里那个矛盾：预生成时不必等面板提供语言，**`warm()` 可以完全无依赖地跑**

**结论：`summaryKey` 只保留 `(turn, body)`。** 这不是简化，是决策 1 让它变得多余。

> 顺带：`languageLine` / `languageName` / `LANGUAGE_NAMES` / `LANGUAGE_TAG` / `GENERIC_LANGUAGE_LINE` 这一整套会变成死代码，`api.js` 的 `langOf` 与 client 的 `hostLanguage()` 也失去用途。**一并删除**，不留「以防万一」的半截管道——留着的东西会被下一个人当成有效的，然后困惑为什么改了没反应。

---

## 二、接口契约（改完之后的准确形状）

### 2.1 `packages/ui-evolve/lib/summarise.js`

```js
const MAX_SUMMARY_CHARS = 300   // 原 400

// 新增一条输出卫生约束 + 一条语言规则
const INSTRUCTION = [
  ...existing sentences...,
  '',
  // 语言：从「界面语言」改为「对话语言」，措辞参考 Qoder recap 第 3 条
  'Write it in the language the user is writing in, not the language of the',
  'assistant text or of the commands.',
  '',
  // 输出卫生：原文只禁了列表，没禁前言
  'Do not write a preamble or a label such as "Summary:" — begin with the',
  'first sentence of the summary itself.',
].join(' ')
```

```js
/**
 * Render a transcript snapshot as the prompt body.
 *
 * The user's own words come first: the turn's intent is the user's, and
 * every other line here describes consequences. It is also the only signal
 * in the body that says which language to answer in.
 */
function renderPromptBody(snapshot) {
  ...
  const asked = typeof snapshot.asked === 'string' ? snapshot.asked.trim() : ''
  if (asked.length > 0) lines.push(`What the user asked:\n${asked}`)
  // 之后才是 Tool calls / Files edited / Last commands run / What the assistant said
}
```

```js
// 只有两个参数了
function summaryKey(turn, body) {
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16)
  return `${turn ?? '?'}:${digest}`
}
```

```js
class Summariser {
  constructor({ llm, config, log }) {
    ...
    /** @type {Set<string>} sessions whose panel has been opened at least once. */
    this.viewed = new Set()
  }

  /** Record that someone opened the panel for this session. */
  markViewed(agentId) { this.viewed.add(agentId) }

  /**
   * Start a summary for a turn that has already finished, without waiting.
   * ...
   */
  warm({ agentId, snapshot, sessionRoute }) {
    if (valueOf(this.config)?.panelSummary !== true) return
    if (!this.viewed.has(agentId)) return   // 决策 2：没被看过的会话不花钱
    void this.summarise({ agentId, snapshot, sessionRoute }).catch(() => {})
  }

  async summarise({ agentId, snapshot, signal, sessionRoute }) {
    // language 参数删除；其余逻辑不变
  }
}
```

**成功返回体加一个字段：**

```js
{ enabled: true, text, at, model, pinned }   // at: number，毫秒时间戳
```

`at` 在 `run()` 里写缓存时取值，**缓存命中时必须返回缓存里的 `at`**（`summarise.js:474`），不能返回 `Date.now()`——否则 P1 显示的时间每刷新一次就变，「更新于」这个信息等于没有。

### 2.2 `packages/ui-evolve/lib/transcript.js`

```js
class Transcript {
  constructor() {
    ...
    /** @type {string} the human message that opened this turn; '' between turns. */
    this.asked = ''
  }

  beginTurn(index, asked = '') {   // 新增第二参数
    this.turns = ...
    this.calls.clear()
    this.paths = []
    this.commands = []
    this.said = []
    this.asked = asked
    this.turn = this.turns
  }

  snapshot() {
    return {
      turn, calls, failed, paths, commands, said, tools,
      asked: this.asked.slice(0, MAX_ASKED_CHARS),   // 新字段
    }
  }
}
```

`MAX_ASKED_CHARS = 600`（与 `renderPromptBody` 里单条消息的截断口径一致；用户一句话极少超过这个长度，超了说明是粘了一大段代码，那也不该进 prompt）。

`endTurn()` 里被放弃的回合（`reason.kind !== 'completed'`）已有清空分支，**记得把 `asked` 一起清掉**——否则下一回合会带着上一回合的提问。

`record()` 改为：

```js
if (type === 'user/message') {
  if (data?.source?.kind !== 'user') return
  this.for(agentId).beginTurn(undefined, readUserText(data.content))
  return
}
```

新增 `readUserText(content)`：从 content 块数组里取 `type === 'text'` 的 `text` 拼接；非数组或空则返回 `''`。与现有 `noteText` 的取值方式保持一致，避免对宿主的结构做二次假设。

`@returns` 与 export 列表同步更新（新增 `readUserText`、`MAX_ASKED_CHARS`）。

### 2.3 `packages/ui-evolve/lib/api.js`

- `readPanel`：`deps.summariser.markViewed?.(id)`（**在任何 `panelSummary` 判断之前**，因为「看过了」和「开着摘要」是两件事）；`summarise({...})` 调用去掉 `language` 参数
- 返回体透传 `summary.at`
- 删除 `langOf` 与 `readPanel(deps, agentId, lang)` 的第三个参数；`api.js:637` 的调用点同步改

### 2.4 `packages/ui-evolve/lib/client.js`

三处改动，**互不依赖，可分批提交**。

**(a) P0 失败文案中文化** — 改 `summaryText`（`client.js:2131-2135`）：

```js
const SUMMARY_REASONS = [
  [/^the turn left nothing/, '这一轮没有留下可总结的内容'],
  [/^turned off/, '摘要已在设置里关闭'],
  [/^no completed turn yet/, '还没有结束的回合'],
  [/^no model service available/, '没有可用的模型服务'],
  [/^no model route is available/, '没有可用的模型线路'],
  [/^the model call failed/, '模型调用失败'],
  [/^the summary call failed/, '摘要请求失败'],
  [/^the model returned nothing/, '模型没有返回内容'],
  [/^the summary call timed out/, '摘要请求超时，稍后再看'],
  [/^open a conversation first/, '先打开一个会话'],
]
```

匹配用**前缀正则**而不是全等：`reason` 有 `the model call failed: ${message}` 这种带后缀的形态，全等永远命中不了。未知 `reason` 落到「暂无摘要」，**英文原文放进 `title` 属性**供排查（不要丢掉诊断信息）。

**(b) P1 更新时间** — 卡片 `head`（`client.js:2378-2388`）末尾追加：

```js
summary?.at ? jsx('span', { className: 'dsse-head-stat dsse-head-time', title: new Date(summary.at).toLocaleString(), children: relativeTime(summary.at) }) : null
```

`relativeTime(ms)` 用 `Intl.RelativeTimeFormat`：< 60s → `刚刚`；< 60min → `N 分钟前`；< 24h → `N 小时前`；否则 `toLocaleDateString()`。理由同 `summarise.js` 原来的 `LANGUAGE_NAMES` 注释——手写复数与语序在中文之外全错。

CSS 加一条 `.dsse-head-time{color:var(--dsw-alias-label-quaternary,#aeb4c0);font-variant-numeric:tabular-nums}`（放在 `.dsse-head-stat b` 之后，`client.js:304` 附近）。

**边界：`at` 缺失时整段不渲染**，不要显示「刚刚」冒充。

**(c) 删除语言管道** — `hostLanguage()`（`client.js:216-222`）与 `client.js:1940-1941` 的 `&lang=` 拼接一并删除。**先 grep 确认无其他调用点**。

---

## 三、改动清单（按施工顺序）

顺序经过设计：T-1/T-2 是 T-3 的前置，T-4 依赖 T-3 的返回体，T-5 独立。

| # | 文件 | 改动 | 依赖 |
| --- | --- | --- | --- |
| **T-1** | `transcript.js` | `asked` 字段、`beginTurn(index, asked)`、`readUserText`、`snapshot().asked`、`endTurn` 清空 | — |
| **T-2** | `summarise.js` | `renderPromptBody` 首行加用户原话；`INSTRUCTION` 补语言 + 前言两条；删语言命名整套 | T-1 |
| **T-3** | `summarise.js` | `summaryKey(turn, body)` 两参数；`summarise()` 去 `language`；`MAX_SUMMARY_CHARS=300`；返回体加 `at`；新增 `tidy()`；新增 `viewed` / `markViewed` / `warm` | T-2 |
| **T-4** | `api.js` | `markViewed` 调用、去 `lang`、透传 `at`、删 `langOf` | T-3 |
| **T-5** | `index.js` | `turn/end` 分支追加 `warm()` | T-3 |
| **T-6** | `client.js` | P0 文案表、P1 时间、删 `hostLanguage` | T-4 |
| **T-7** | `test/*.mjs` | 见 §四 | 全部 |

### T-5 的落点必须精确

`packages/ui-evolve/lib/index.js:346-372` 现有结构：

```js
const ended = event?.type === 'turn/end' ? transcripts.view(agentId)?.current?.paths : undefined
transcripts.record(agentId, event)
if (event?.type === 'turn/end') {
  sessionState.rememberTurn(agentId)
  if (ended !== undefined) sessionState.rememberPaths(agentId, ended)
}
```

**三处顺序都是硬约束，不要「顺手整理」：**

1. `ended` 必须在 `record()` **之前**读——`endTurn` 会清空 `current`，之后读就没了
2. `previous` 必须在 `record()` **之后**读——折进去之后它才等于「刚结束的那一轮」
3. `warm()` 必须在这两者**之后**——它读的是 `previous`

```js
if (event?.type === 'turn/end') {
  sessionState.rememberTurn(agentId)
  if (ended !== undefined) sessionState.rememberPaths(agentId, ended)
  // The turn is over and its content can no longer change, so the summary
  // can be written now instead of when someone opens the panel. Not awaited:
  // a summary is not worth delaying the event pipeline for, and every failure
  // path inside returns a value rather than throwing.
  const finished = transcripts.view(agentId)?.previous
  if (finished !== undefined) summariser.warm({ agentId, snapshot: finished, sessionRoute: routeFor(agentId) })
}
```

**被放弃的回合要注意**：`endTurn` 在 `reason.kind !== 'completed'` 时清空并返回，**不设置 `previous`**。所以此时 `previous` 仍是再上一个回合，`warm()` 会对它重复调用一次——缓存命中，零成本，可以接受；但**不要为此加判断逻辑**，那会让「刚结束的回合」和「上一回合」两个概念在代码里混起来。

---

## 四、测试计划

现有 42 个测试文件，其中 `summarise.test.mjs`（~700 行）、`client.test.mjs`、`transcript.test.mjs`、`api.test.mjs`、`index.test.mjs` 都会被改动波及。

### 4.1 必须改的现有断言

| 文件 | 断言 | 为什么必须改 |
| --- | --- | --- |
| `summarise.test.mjs:182` | `summaryKey(3,'abc','Chinese') !== summaryKey(3,'abc','Japanese')` | 语言不再是键的一部分，三参数版已不存在 |
| `summarise.test.mjs:186-225` | `languageName` / `languageLine` 全部 20 余条 | 这组函数被删除 |
| `summarise.test.mjs:466` | `'Write it in Simplified Chinese'` 出现在 prompt 里 | 不再传界面语言 |
| `summarise.test.mjs:693` | `result.text.length === MAX_SUMMARY_CHARS` | 用常量，随常量变成 300 自动通过（**不要硬编码 400**） |
| `client.test.mjs` | 卡片 head 只有三个统计 | 多了时间（`at` 缺失时不渲染，多数用例不受影响） |
| `api.test.mjs` | `readPanel` 签名 / `?lang=` | 参数删除 |

### 4.2 必须新增的断言

**摘要内容**
- 用户原话进入 prompt：`snapshot.asked = 'donne-moi le total'` → 发出的 prompt 含 `What the user asked:` 与该句
- 用户原话被截断到 `MAX_ASKED_CHARS`
- `asked` 为空时**不输出** `What the user asked:` 这一行（否则 prompt 里出现一个空标签）
- 同一 turn、同一 body、不同 `?lang=` → **只调一次模型**（这是决策 1 的核心收益，必须钉住）

**输出卫生（`tidy`）**
- ` ```js\n...\n``` ` 围栏被剥掉，内容保留
- `Summary: 这一轮……` → 前缀被删，`这一轮` 保留
- `**粗体**` → `粗体`
- **`my_file.py` 的下划线必须保留**（这是不抄 Qoder `replace(/[*_`#]+/gu,"")` 的理由，必须有断言守着，否则下一个人「简化」时不会知道）
- `MAX_SUMMARY_CHARS + 200` 字符输入 → 输出长度恰为 `MAX_SUMMARY_CHARS`

**预生成**
- `panelSummary: true` + 面板被打开过 + `turn/end` → `stream` 被调用一次（**且不等待**：断言事件处理函数同步返回）
- `panelSummary: true` + 面板**从未**打开 → `stream` 调用 0 次
- `panelSummary: false` → 0 次
- 预生成之后再请求面板 → **0 次新调用**，且返回 `cached: true`
- 预生成抛错（`streamThrows`）→ 事件处理函数不抛，`turn/end` 之后的逻辑照常执行

**更新时间**
- 缓存命中返回的 `at` 与首次计算时相同（**同一 turn 调两次，`at` 相等**）
- `at` 缺失时卡片不渲染时间节点

### 4.3 突变测试

仓库已有 `test/mutations.test.mjs` 与 `scripts/mutate-checklist-panel.mjs`，且本会话有 `stub-capability-mutation-testing` 技能。**P0 与 P2 各自至少一个突变**，证明断言真的会红：

| 突变 | 应失败的断言 |
| --- | --- |
| `warm()` 加 `await` | 「不等待」那条 |
| `warm()` 去掉 `viewed` 判断 | 「面板从未打开 → 0 次」那条 |
| `summaryKey` 把 body 从哈希里去掉 | 「不同 body 不同键」那条 |
| P0 映射表改成空表 | 「正文含中文、不含英文」那条 |
| `tidy` 里加回 `replace(/[*_`#]+/gu,"")` | 「`my_file.py` 保留下划线」那条 |

---

## 五、验收（人工，跑一遍）

1. `npm test` 全绿（`node test/run.mjs`）
2. 起宿主，开一个会话，**不打开面板**跑完一轮 → 宿主日志无 `skill-evolve-panel-summary` 调用
3. 打开面板 → 有调用，等待秒级；关掉再打开 → 秒开
4. 跑完第二轮后**立即**打开面板 → 秒开（这就是 P2 要的效果）
5. 面板上一轮卡显示「刚刚」；等 6 分钟重开 → 「6 分钟前」，**且数字只增不减**
6. 断开模型配置后打开面板 → 正文是中文句子，鼠标悬停能看到英文原文
7. 用中文提问、助手用英文回答的会话 → 摘要仍是中文

第 7 条是决策 1 的唯一直接验证，**不要跳过**。

---

## 六、风险

| 风险 | 判断 | 处置 |
| --- | --- | --- |
| 客户端 bundle 必须重启宿主才生效 | 既定事实（`lib/client.js` 是手写 bundle，无构建步骤） | 验收前重启，不要拿旧界面下的现象判断改动没生效 |
| `warm()` 让「每轮都花钱」 | 决策 2 已把它限制在「被看过的会话」，且 `summarise` 有 64 条 LRU + inflight 去重 | 观察一周日志，看 `cached:false` 的比例 |
| 删语言管道时漏改调用点 | `hostLanguage` / `langOf` 的调用点少但分散在 client 与 api | 每次删除前 grep 该标识符，确认 0 处残留 |
| 用户原话里含 prompt 注入 | 已经处理：body 包在 `<transcript>` 里并由 `defuseMarkers` 转义闭合标签 | 新加的 `What the user asked:` **必须在 `<transcript>` 内**，不要提到外面 |
| `asked` 让 prompt 超预算 | `MAX_INPUT_CHARS = 6000` 是硬截断 | 断言：含 600 字 `asked` 时 body 长度仍 ≤ 6000 |

最后一条容易被忽略：新字段加在 body 前面，而 `renderPromptBody` 结尾才 `.slice(0, MAX_INPUT_CHARS)`——**截断会先砍掉助手原话而不是用户原话**。这恰好是对的（用户意图比助手措辞更该保留），但要有断言把它固定下来，否则下一个人调整行顺序时会无意中反转优先级。
