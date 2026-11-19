# 22 · Qoder 产出卡的数据链：为什么它的文件少而准

> 起因：用户 m25297 说 ——
>
> 「qoder 的产出卡片跟踪的文件比较少，而且几乎都是我要查看和使用的，命中我的需求率比较高，
> 而我们的卡片设计中，展示的文件十分的多，虽然说我要查看使用的文件也在里面，但就是显得非常臃肿」
>
> 这不是抱怨，是一个可验证的观察。本文去代码里找**为什么**。
> 材料：`F:\dsh-plugin\_qoder_rev\`（Qoder 0.5.7 解包副本，主进程 `main.js` 21,057,490 字节，
> 渲染层 `gtd.js` 16,167,633 字节，字符串表 `_r_all_strings.txt` 66,183 条）。

---

## 0. 一句话答案

**Qoder 的两张卡各用一套数据，而这两套数据语义完全不同：**

| 卡 | 数据源 | 里面是什么 | 谁决定 |
| --- | --- | --- | --- |
| 产出文件（`ha2`） | `artifacts` | **模型主动交付的内容** | 模型调工具说「给你」 |
| 文件改动（`po1`，带 diff 预览） | `fileChangesSummary` | **这一回合改了哪些文件** | git 差分 |

**我们把这两件事合并成了一张卡**，所以「改过的」和「要给你的」混在一起。
读者要的是第二件，卡片给的是第一件的全部 —— 这就是臃肿的来源。

---

## 1. 证据：两条数据链完全独立

### 1.1 产出文件卡的数据链（renderer → 主进程）

renderer 侧的状态类 `T70`（构造于 `gtd.js` 约 3,558,000 偏移）：

```js
outputValue = O1("chatSession.outputFilesByTurn", new Map)
outputFilesByTurnObs = this.outputValue
failuresValue = O1("chatSession.turnArtifactFailures", new Map)
```

它的填充只有一个入口 —— `read()` 方法里的一行（`gtd.js` 约 3,567,900）：

```js
const c = await this.client.readChatSessionTurnArtifacts(i, t.turnId, o.signal)
...
t.files = c
```

IPC 方法名在字符串表里是 **`chatSessions.listTurnArtifacts`**（索引 39526）。

**关键点：它请求的是「某个 turnId 的 artifacts」，不是「工作区里变了什么」。**

### 1.2 卡片的渲染只做截断，不做筛选

```js
const Do = [[]], qv1 = 7
function ha2({ sessionId: e, files: t, labels: i, ... }) {
  const [m, f] = g.useState(!1)
  const p = t.length > qv1
  const v = p && !m ? t.slice(0, qv1) : t     // ← 唯一的「少」
  const x = t.length - v.length
  return s.jsx("section", {
    "data-chat-turn-output-files": !0,
    children: v.map(b => s.jsx(ma2, { file: b, ... }))
  })
}
```

`ha2` 是**纯展示组件**：它只把 `files` 切成前 7 个，多出来的显示「显示其余 N 个文件」（`showMore(count)`）。

**没有一处按目录名、扩展名、噪声规则过滤。** 上面的 `files` 有多少，就画多少（前 7 个 + 折叠）。

### 1.3 那 `files` 为什么本来就少？

因为它的来源是 `artifacts` —— 一个**由交付动作产生**的集合。它在主进程侧的语义证据：

- 工具名：**`present_files`**（字符串表索引 39537）
- 工具描述（索引 28020）：**`Deliver artifact files to the user.`**
- 条目字段（从 `N70` 的字节估算函数反推）：
  ```js
  { path, absolutePath, filename, typeLabel, rootId?, messageId }
  ```
  —— 注意 **`messageId`**：每个 artifact 都绑定在某条消息上，也就是「某次工具调用交付的那一批」。

一个文件要出现在产出卡里，必须**有过一次把它的路径交给 `present_files` 的动作**。仅仅被 `Edit`/`Write` 改过、或者被 bash 写过，进不了这个集合。

### 1.4 另外还有一条 `cloud-artifact` 支路

同一套 `outputFilesByTurnObs` 在云端会话里由另一个类填充（`gtd.js` 约 7,334,700）：

```js
outputFilesByTurnObs = ui(t => {
  ...
  for (const o of n.artifacts ?? []) {
    if (!o.turnId) continue
    const a = di(o.turnId)
    const c = o.filename.split(".").at(-1)
    const l = {
      path: o.id,
      absolutePath: o.id,
      filename: o.filename,
      typeLabel: c && c !== o.filename ? c.toUpperCase() : "",
      timestamp: o.createdAt ?? void 0,
    }
    r.set(a, [...(r.get(a) ?? []), l])
  }
  return r
})
```

同样是 `artifacts`，同样按 `turnId` 分组。两条路（本地 / 云端）语义一致。

---

## 2. 「文件改动」是另一张卡，不是这张

`gtd.js` 约 11,209,400 那一行：

```js
_ && _.items.length > 0 && !Ce ? s.jsx(po1, { className: "mx-2", summary: _ }) : null
```

`_` 是 props 里的 `fileChangesSummary`，`po1` 是它的组件（`gtd.js` 约 11,028,989），它渲染 **diff 预览**：
错误文案里有 `chatActivity.fileChanges.diffPreviewExpired`、`diffPreviewTooLarge`、`binaryDiff`。

**产出文件卡（`ha2`）和文件改动卡（`po1`）在同一层并列出现，但数据完全不交叉。**

我们的实现里，这两件事是同一张卡的两个分组（`fresh` / `earlier` / `stale` / `noise`）。

---

## 3. 我们有而 Qoder 没有的东西

| 能力 | Qoder | 我们 | 为什么要做 |
| --- | --- | --- | --- |
| 噪声判定（`node_modules`/`dist`/`_probe*`） | **无** | `api.js` 1,777 行 | 我们采的是「改过的所有文件」，噪声必须处理 |
| 相对路径补全（跟进 `cd`） | 不适用 | `shellpaths.js` 431 行 | 我们采 bash 重定向，Qoder 不采 |
| 存活状态四态 | 有（`checking`/`available`/`missing`/`invalid`） | 有（五态） | 两边都需要 |
| 按 turn 分组上限 | 7（`qv1`） | 8（`MAX_CARD_PATHS = 40` 采集上限 + `FOLDED_FILES = 4` 显示） | — |
| 内容快照 | `artifactId` 哈希 | 无（只记路径） | 我们明确不做 |

**这张表解释了我们多出来的 4,000 多行是怎么来的**：
我们选了一个信息量更大、也更难做的采集口径（「这一回合所有变化的文件」），
Qoder 选了一个信息量更小、但几乎不需要清洗的口径（「模型交给你的文件」）。

---

## 4. 结论：不是「过滤阈值太严」，是**口径选错了**

用户说「过滤噪声的门限太严格」，但代码看下来，问题不在阈值：

- 我们的卡片回答的是「**这一回合有哪些文件变了**」。这个问题在大工作区里，答案天然是几十到几百条。
- Qoder 的卡片回答的是「**这一回合模型给了你什么**」。这个问题的答案天然是个位数。

**同一个 UI 位置，两个不同的问题。** 只要我们还回答第一个问题，无论噪声规则怎么调，
都会比第二个问题显示的更多 —— 因为第一个问题的答案本来就更长。

---

## 5. 建议

### 5.1 短期（不需要改数据层）

**在现有卡上加一条「只看交付的」过滤**：
把 `report_output_files` 和宿主 `present` 声明的路径标记为 `delivered: true`，
头部主数字只数这些，其余进「其它改动」组。
这样不改变采集口径，也不删任何数据，只是把读者最想看的那个子集浮上来。

这正是 `docs/21` §7 P2 说的「只标不藏」的具体形式。

### 5.2 中期（口径拆分）

把一张卡拆成两张，对齐 Qoder：

| 新卡 | 数据源 | 行数预期 |
| --- | --- | --- |
| **交付的文件** | `delivered` 标记的路径 | 个位数 |
| **改动的文件** | 现有四路采集的全部 | 折叠显示 |

我们已经有全部数据，只需要在渲染层分两个组件读同一份 payload。
代价是卡片数量变多；收益是「我要用的」和「我改过的」不再互相稀释。

### 5.3 不建议

**不要照搬 Qoder 的采集口径**（只记交付动作）。
我们的 `git` 差分 + 目录走查是为了回答「你没交付但确实改了」，
这个能力在「我改完忘了告诉你」的场景里有价值 —— 只是它不该占据卡片的主位置。

---

## 5.4 一处必须纠正的说法：`origin` 不在产出卡上

我在 `docs/21` §7 P2 里写过「Qoder 的做法是标 `origin`、显示前 7 个」，
读代码后需要收窄：

- `origin` 字段属于**任务监控面板的行**（组件 `q41`，`data-task-monitor-file-missing`），
  它的取值是 `manual` 与 `automatic`（实测 `origin:"automatic"` 出现在视频卡
  `i$` 与技能进化建议 `sD1` 上）。
- **产出卡的两个组件 `ma2`（行）与 `ha2`（卡）里没有 `origin` 这个词**（实测 `indexOf` 为 -1）。

所以「Qoder 用 `origin` 标记自动产物」是真的，但它标的是**任务监控里的视频与技能建议**，
不是产出文件。产出卡少而准，靠的不是标记，而是**口径本身就是交付动作**。

这个区分重要，因为它决定了我们该抄哪一半：
抄「口径」要改采集层（重），抄「`origin` 标记」只能改展示层，而它解释不了 Qoder 为什么少。

## 6. 本文没有证明的事

- `artifacts` 记录的真实表名与写入时机（主进程侧被字符串表编码，未解出；只确认了 IPC 名
  `chatSessions.listTurnArtifacts` 与字段形状）。
- `present_files` 在本地模式下是否**每次都**产生 artifact（只确认了工具描述与
  `ma2` 渲染组件读取 `kind`/`origin` 字段，未追到主进程写入点）。
- Qoder 的 artifact 是否有「自动」来源（如 `Write` 工具隐式交付）。若存在，我们的差距比本文
  描述的更小。
- 用户实际看到的 Qoder 卡片条数（本文的全部结论来自代码，没有对真实 Qoder 会话计数）。
