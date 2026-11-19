# 23 · Qoder 任务监控侧栏的「产出」区：它到底怎么来的

> **这份文档纠正了 `docs/22` 的一个错误。**
> `docs/22` 查的是**会话主体**里的产出卡（`data-chat-turn-output-files`，组件 `ha2`），
> 而用户问的是**任务监控侧栏**的产出区域（`data-task-monitor-*`，组件 `Tw0` → `q41`）。
> 两者是不同的组件、不同的数据源、不同的分组语义。`docs/22` 关于 `ha2` 的部分是准确的，
> 但它不能用来回答侧栏的问题。用户 m25565 当场指出了这一点。
>
> 材料：`F:\dsh-plugin\_qoder_rev\`（Qoder 0.5.7 解包，`gtd.js` 16,167,633 字节，
> `main.js` 21,057,490 字节，字符串表 `_r_all_strings.txt`），以及之前几轮抽出的 i18n dump。

---

## 0. 一句话答案

**侧栏的「产出」不是一次文件扫描的结果，而是一份从对话投影出来的清单。**
主进程把 `(messages, artifacts)` 投影成 `highlights`，侧栏只负责把这批 items 按 `kind` 分组画出来。
它少而准，不是因为它过滤得好，而是因为**进入 `highlights` 的东西本来就经过了「这一轮发生了什么值得记的事」这道门**。

---

## 1. 三个形态，一个组件

侧栏有三种呈现方式，共用同一个主体组件 `Tw0`：

| 形态 | 标记 | 组件入口 |
| --- | --- | --- |
| 浮动卡片 / pinned 浮层 | `data-task-monitor-trigger`（入口按钮）、`data-task-monitor-pinned-panel` | `Pw0` → `x$` |
| 固定右栏 | `data-task-monitor-fixed-panel` | `kD1` → `x$` |

`x$`（偏移约 5,031,540）在拿到 `model.highlights` 之后渲染 `Tw0`；`displayMode` 取
`"floating"` / `"fixed"`，固定栏还会把 `className` 换成 `h-full min-h-0 px-3 pb-3 pt-2`。

**关键：三种形态读的是同一个 `chatSession.highlights`，没有「侧栏用一套、主体用另一套」的分裂。**
分裂发生在**侧栏 vs 会话主体**之间（见 §6）。

---

## 2. 分组：五个 kind，其中「产出」= `artifact`

`Tw0`（偏移 5,037,385）里的分组构造，逐字：

```js
const merged = Rx0(highlights.items, sideChatArtifacts)
const sections = ["runtime", "artifact", "browser", "source"]
  .filter((kind) => sectionVisibility[kind])
  .map((kind) => ({ kind, items: merged.filter((item) => item.kind === kind) }))
  .filter((section) =>
    section.items.length > 0 ||
    section.kind === "artifact" ||
    section.kind === "source" ||
    (section.kind === "runtime" && showSkillEvolutionSuggestion)
  )
const memoryItems = merged.filter((item) => item.kind === "memory")
const memorySection = Dw0(memoryItems)
```

读出来的四条规则：

1. **顺序是固定的**：`runtime`（技能与 MCP）→ `artifact`（产出）→ `browser`（网页查阅）→ `source`（来源），
   `memory`（记忆）单独走 `Dw0`。
2. **`artifact` 和 `source` 即使为空也保留分组** —— 空态本身是信息（「这一轮没有产出」也是结论）。
3. **`browser` 为空则整组消失**（`.filter` 的第一个条件不成立，后两个 `===` 也不成立）。
4. **`memory` 连空态都不给**：`Dw0(memoryItems)` 拿到空数组时自己决定不渲染。

组标题的文案（i18n `chatSession.highlights.group.*`）：

| kind | 文案 |
| --- | --- |
| `artifact` | **产出** |
| `browser` | 网页查阅 |
| `runtime` | 技能与 MCP |
| `source` | 来源 |
| `memory` | 记忆 |

空态文案：`暂无产出数据 :)`、`暂无网页查阅数据 :)`、`暂无技能与 MCP 数据 :)`、`暂无来源数据 :)`、`暂无记忆数据 :)`。

**这就是用户说的「产出区域」：`kind === "artifact"` 的那一组。**

---

## 3. 折叠：阈值是 5，且只有四种 kind 会折叠

```js
const folded = r1[section.kind] ?? false
const rest = (section.kind === "runtime" || section.kind === "artifact" ||
              section.kind === "browser" || section.kind === "memory")
  ? Math.max(0, section.items.length - $l1)
  : 0
const shown = folded || rest === 0 ? section.items : section.items.slice(0, $l1)
```

`$l1 = 5`（偏移 5,025,504，`"$",RD="size-3 shrink-0",$l1=5,_w0="task-monitor:memory-update-acknowledged:"`）。

- **每组默认只画 5 条**，多出来的显示「查看更多（{{count}}）」。
- **`source` 永远不折叠**（`rest` 恒为 `0`，`source` 被显式排除在四元组之外）。
- 折叠状态存在 `r1[kind]`，按组独立切换。

> 一处更正：我此前在别的文档里把侧栏折叠阈值记成 **4**。源码是 **5**。
> 会话主体那张卡（`ha2`）才是 **7**（`qv1 = 7`）。三个数字互不相同，别混。

---

## 4. 行组件 `q41`：它读哪些字段

`q41`（偏移 4,761,818）是侧栏**所有**分组的通用行，靠 `item.kind` 分支。它实际读取的：

| 字段 | 用途 |
| --- | --- |
| `item.id` | React key |
| `item.kind` | 分组已定，行内用于「是否显示 detail」「是否可移除」「图标」 |
| `item.label` | 主文本（`truncate`） |
| `item.detail` | 副文本，**只对 `browser` 和 `runtime` 渲染** |
| `item.target.type` | `file` / `url` / `message` / `evidence` |
| `item.target.path` | `type === 'file'` 时的路径 |
| `item.target.entryKind` | **`'directory'` 与 `'file'` 之分** |
| `item.origin` | **`"manual"` 才画移除按钮、才给 hover 底色** |
| `item.detail`（`runtime`） | `"skill"` / `"mcp…"` 前缀决定是否只读 |

几处值得单独记：

**4.1 侧栏能显示目录，会话主体的卡不能。**
`entryKind === 'directory'` 时图标换成 `data-task-monitor-item-icon="folder"`，点击走
`openChatSessionFile({ path, entryKind: "directory" })`。会话主体那张卡的条目结构里没有这个字段。

**4.2 存活状态只对「产出里的文件」查。**
```js
const missing = useFileStatus(
  sessionId,
  sessionFileStatusEnabled && item.kind === "artifact" &&
  item.target.type === "file" && item.target.entryKind !== "directory"
    ? item.target.path : null
) === "missing"
```
`missing` 时：主文本加 `line-through`、颜色转 `text-text-tertiary`、`aria-label` 变成
`"<label>: <previewUnavailable.missing>"`、行加 `data-task-monitor-file-missing`、`cursor-default`、
**不再可点**（`canOpen = !!onOpen && !missing`）。

注意 `useFileStatus` 的默认返回值是 **`"available"`**（拿不到服务时回退），偏向「不误标删除」。
这与我们在 `docs/09` 里记的 `t$` 服务行为一致。

**4.3 `origin === "manual"` 是一个真实存在的分支。**
只有在 `manual` 时，行尾才画那个 `opacity-0 group-hover:opacity-100` 的移除按钮，行也才有
`hover:bg-fill-tertiary`。**自动产生的条目（`automatic`）不可移除**。
`docs/22` 里说「`origin` 属于任务监控面板的行」是对的，但当时没给出它到底控制什么 —— 就是这两个。

**4.4 去重键。**
```js
function keyOf(item) {
  const t = item.target
  return t.type === "file" ? `file:${t.path.replace(/\\/gu, "/")}`
    : t.type === "url" ? `url:${t.url}`
    : t.type === "message" ? `message:${t.messageId}`
    : `evidence:${t.evidenceId}`
}
function merge(highlightItems, sideChatArtifacts) {
  const out = [...highlightItems]
  const seen = new Set(highlightItems
    .filter((i) => i.kind === "artifact" || i.kind === "memory")
    .map(keyOf))
  for (const item of sideChatArtifacts) {
    if (item.kind !== "artifact" && item.kind !== "memory") continue
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
```
**`file:${path.replace(/\\/g,"/")}`** —— 反斜杠归一后去重。这与我们 `client.js` 里的
`const key = \`file:${file.path}\`` 是同一个想法，但我们没有做**归一化**，
所以同一个文件用 `\` 和 `/` 两种写法各占一行（我们的 `docs/19` 里记过这个坑）。

---

## 5. 数据从哪来：一份投影，不是一次扫描

侧栏的 model 是 `chatSessionHighlightsService`（`n0("chatSessionHighlightsService")`，
类 `f$`，偏移约 4,899,025）。它持有的状态键是：

```js
modelValue = O1("chatSession.highlights", dI)   // dI = { sessionId, highlights, gitRepositories, developmentServers, isLoading, error }
```

填充路径：`open(sessionId)` → **`ensureHighlightsWatch(sessionId)`** → 拿 `{ snapshot }`
→ 写进 `modelValue`。关闭时 `releaseHighlightsWatch`。

**是「订阅 + 推送」，不是「面板每 N 秒拉一次」。** 主进程侧有一条 change publisher
（`main.js` 约 7,501,250）：`watch(highlights)` 的变化直接 `publish({ highlights })` 到渲染层。

而 `highlights` 在主进程里是**投影出来的**（`main.js` 约 8,294,432）：

```js
x = { ...x, conversation: { ...o, messages: i, artifacts: w,
      highlights: x[L(40448,49958)][L(30691,37682)](v[L(51223,61357)], i, w) } }
```

即 `project(previous, messages, artifacts)` —— **入参是「消息」和「产出物」，不是「文件系统」。**

`chat_session_highlights` 表（`_r_all_strings.txt` 19872 附近）：

```sql
session_id TEXT PRIMARY KEY,
identifier ..., title TEXT NOT NULL, description TEXT NOT NULL,
items_json TEXT NOT NULL,
projection_version INTEGER NOT NULL,
projected_message_sequence ...,
updated_at INTEGER NOT NULL,
FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
```

`items_json` 是整份 items 的序列化。有一条 `UPDATE chat_session_highlights SET projection_version = 0 WHERE session_id = ?`
（索引 9376）用来强制重投影。

**所以「产出」这一组的条目，是从对话内容投影出来的东西，不是从磁盘上扫出来的东西。**

---

## 6. 侧栏的「产出」和会话主体的「产出文件卡」不是一回事

| | 侧栏「产出」（`Tw0` → `q41`） | 会话主体产出卡（`ha2` → `ma2`） |
| --- | --- | --- |
| 数据源 | `chatSession.highlights` → `items_json` | `chatSession.outputFilesByTurn` → `artifacts` |
| 怎么算出来 | 主进程**投影** `(messages, artifacts)` | IPC `chatSessions.listTurnArtifacts(turnId)` |
| 分组 | 五组（产出/网页查阅/技能与 MCP/来源/记忆） | 一组，按 turn 分组 |
| 折叠阈值 | **5**（每组，`source` 不折叠） | **7**（整张卡） |
| 行组件 | `q41`（通用行） | `ma2`（只画文件） |
| 目录条目 | **支持**（`entryKind: 'directory'`） | 不支持 |
| `origin` | **读过**（`manual` 才可移除） | 零出现 |
| 存活状态 | 只对 `artifact` 的文件查，回退 `available` | 使用 `ma2` 内部的读取 |
| 空态 | `artifact`/`source` 保留组并显示空态 | 无行则不渲染 |

**用户看到的「产出区域」是左列。** 我上一版 `docs/22` 描述的是右列。

---

## 7. 那么，为什么它命中率高

现在可以正面回答了。三个原因，按贡献排序：

**7.1 入口是「对话」，不是「磁盘」。**
`highlights` 的投影入参是 `(messages, artifacts)`。一个文件要进「产出」组，必须在这一轮对话里
**被当成一件事说过**（模型交付了它、或它在某个 artifact 事件里出现）。
仅仅「被改过」不会进这个组 —— 改过的文件在侧栏的**环境信息 · 变更**那一区，与「产出」分开。

这和我们最根本的差异：**我们的卡片回答「这一回合磁盘上变了什么」，它回答「这一回合发生了什么值得记的事」。**
前者在活跃会话里天然是几十条，后者天然是个位数。

**7.2 五组把「文件」稀释到只剩五分之一的位置。**
侧栏不是「文件列表」，是「任务监控」—— 产出、网页查阅、技能与 MCP、来源、记忆。
用户在一屏里看到的是**五类东西各几条**，而不是**一类东西几十条**。
即使 `artifact` 组有 5 条，整块面板的认知负担也不是 5 个文件，是「这一轮有产出、有网页、有技能调用」。

**7.3 分组会「消失」，而消失是零成本的。**
`browser` 空则整组不见，`memory` 空连壳都不给。用户不会看到「网页查阅（0）」。
对照组：我们的卡片在没有产出时会显示「全部 N 个文件都是生成文件」—— 一个需要读者判断的句子。

---

## 8. 对我们的三条可执行结论

**8.1 把「交付」和「改动」拆开这件事，Qoder 在侧栏里也是拆开的**（`docs/22` 的结论在侧栏同样成立，
只是分成的地方不同：侧栏是「产出 vs 环境变更」，会话主体是「产出卡 vs 改动卡」）。
→ `docs/22` §5 的短期建议（`delivered` 标记 + 主数字只数交付）**依然成立**，而且现在有两个独立证据。

**8.2 我们缺的不是过滤，是「入口」。**
Qoder 的产出组之所以准，是因为进组要经过一次「投影」——那是一次有语义判断的转换。
我们的卡片没有这道门，四路采集（编辑工具 / bash / `report_output_files` / `present`）的结果
直接进同一个列表。→ 若要收窄，正确的位置是**采集之后、渲染之前加一道分级**，
而不是在渲染层继续调噪声规则（`docs/21` §7 P2 的「只标不藏」）。

**8.3 两个可以直接照抄的小东西**：
- 去重键归一化斜杠：`file:${path.replace(/\\/g, "/")}`（我们没做，会双行）。
- 空组策略按「这组的信息价值」分别定：`artifact`/`source` 留空态，`browser`/`memory` 整组消失。
  我们目前是一律留位，读者要多扫几个空组。

---

## 9. 本文没有证明的事

- `projection_version` 的**具体投影规则**（哪些 message 会变成 artifact item）没有解出：
  投影函数在主进程里被字符串表编码，`kind:"artifact"` 在 `gtd.js` 里零出现、在 `main.js` 里也搜不到字面量。
  本文确认的是**入参**（messages + artifacts）与**落库形状**（`items_json`），不是投影算法本身。
- 侧栏的 `artifacts` 与会话主体卡片的 `artifacts` 是否是**同一批数据**。两者字段形状不同
  （侧栏 item 有 `kind`/`label`/`detail`/`target`，主体卡片条目有 `path`/`absolutePath`/`filename`/`typeLabel`），
  但可能来自同一个上游。未追。
- `sectionVisibility` 的默认值（13 个分组名、全默认 true）此前已逆向过一次，本文未重新核对。
- 没有对真实 Qoder 会话计数「产出组通常有几条」—— 本文的全部结论来自源码与 i18n 资源。
