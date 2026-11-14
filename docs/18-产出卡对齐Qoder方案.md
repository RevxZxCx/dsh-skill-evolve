# 18 · 产出卡对齐 Qoder 方案

本文件是 [09-Qoder产出文件机制逆向](./09-Qoder产出文件机制逆向.md) 与 [10-产出文件卡改造方案](./10-产出文件卡改造方案.md) 的替代执行方案。10 的结论是「只做 P0/P1/P2 三件小事」，本文件把它推翻到一个更大的范围：**整体产物逻辑向 Qoder 靠拢**，但仍以「我方现有能力」为边界。

## 结论摘要

| 维度 | 现在 | 改后 | 是否抄 Qoder |
| --- | --- | --- | --- |
| 数据模型 | `Map<path, seq>` | `Map<path, {seq, turn, at}>` | 部分（Qoder 有 `kind`/`target`/`origin`，我们只抄生命周期字段） |
| 文件消失 | 静默丢弃 | 三态 `available`/`missing`/`invalid`，行保留 | **是**，这是最重要的一条 |
| 行结构 | 36px 两行，无图标 | 28px 单行，带类型图标 | 是 |
| 折叠与总数 | 头部数人与徽标总数互相矛盾 | 头部说总数，按钮说「还剩几个」 | 是 |
| 行内动作 | 无 | 悬停出「复制绝对/相对路径」 | 部分（Qoder 有溢出菜单六项，我们只能做复制） |
| 空态 | 整卡不出现 | 仅在「写过但全被删」时出现 | 部分（Qoder 是永远出现） |
| 打开方式 | 一种 | 一种 | **否**（宿主只有一个入口） |
| 预览 | 无 | 无 | **否**（无宿主能力） |
| 存活订阅 | 8 秒轮询 | 8 秒轮询 | **否**（无事件源） |

三条硬边界没变：`packages/ui-evolve/lib/client.js:2875` 只有 `sidebarRight.openResource` 一个入口，没有新窗口/内置浏览器/系统应用；没有 `onWorkspaceFileChanged` 事件源；没有 HTML 预览栈。

## 一、差距的根本原因

Qoder 的一行代表**一个产出物**，它自带身份（`artifactId` = `path + "\0" + size` 的哈希）、类型（`kind`）、生命周期（四态）。本项目的一行代表**一次成功的 `fs.stat`**——`api.js:434` 的 `if (!info.isFile()) continue` 就是这句话的字面证据：不是文件的东西不配成为一行。

所以绝大多数差异都是从这一条派生的：

- 文件被删 → `stat` 抛错 → 这一行从来不存在 → 用户丢失信息
- 目录 → `isFile()` 为 false → 不显示（Qoder 用 `entryKind: 'directory'` 加文件夹图标）
- 没有类型 → 无法给图标，只能显示文件名加目录
- 没有产出时间 → 只能显示文件大小（`mtimeMs` 是文件时间，不是产出时间，混用会把 `touch` 当成产出）

方案的核心动作就是把数据模型从「路径 → 序号」扩成「路径 → 小记录」。

## 二、数据模型

### 2.1 存储形状

现在（`session-state.js:760-761`）：

```js
const paths = {}
for (const [file, at] of entry.paths) paths[file] = at
```

改后：

```js
const paths = {}
for (const [file, item] of entry.paths) paths[file] = { seq: item.seq, turn: item.turn, at: item.at }
```

内存里 `entry.paths` 是 `Map<string, { seq: number, turn: number | undefined, at: number | undefined }>`。

三个字段各自的理由：

- **`seq`**：现在的排序依据（`rememberPaths` 用 `++entry.sequence` 保证「最近在前」），改成对象后要显式带进去，否则排序会跟着存储形状一起丢。
- **`turn`**：**这是 10 号文档里 P1 那条缺口**。现在 `turn` 是个布尔值，由 `api.js:940` 用 `previous?.paths` 现算，进程重启后 `previous` 之前的所有轮次全部退化成「更早」。存了轮次号，折叠态的「本轮」在重启后仍然准确。
- **`at`**：写入时刻，与 `mtimeMs` 是两个不同的东西。`mtimeMs` 会被 `touch`、被构建流程改；`at` 是「这一轮确实碰过它」的证据。

### 2.2 版本迁移

`STATE_VERSION = 1`（`session-state.js:60`），而 `readState:94` 是 `if (stored.state !== STATE_VERSION) return undefined` —— **直接升到 2 会丢弃所有既有会话的产出卡**。

所以不直接升，而是让读端同时接受两版：

```js
const STATE_VERSION = 2
const READABLE_VERSIONS = new Set([1, STATE_VERSION])
// readState 内：
if (READABLE_VERSIONS.has(stored.state) === false) return undefined
```

`paths` 载入时统一成对象形态：

```js
for (const [file, value] of Object.entries(stored.paths)) {
  const item = typeof value === 'number'
    ? { seq: value, turn: undefined, at: undefined }   // v1：只有一个位置
    : { seq: value?.seq, turn: value?.turn, at: value?.at }
  if (typeof item.seq !== 'number' || !Number.isFinite(item.seq)) continue
  paths.set(file, item)
}
```

写端只写 v2，于是文件在下一次 `schedule()` 落盘时自动升级。**不需要单独的迁移步骤，也不需要备份**——但需要一个测试钉住「v1 文件读进来是完整的老行为」。

反向兼容不做：老版本插件读到 v2 文件会在 `:94` 直接拒绝，退化成「这个会话没有历史」，与今天一个全新会话的观感相同。这是可接受的降级，写进注释。

### 2.3 三态

`statTouchedFiles`（`api.js:423`）现在两个分支都是「不 push」：

```js
if (!info.isFile()) continue           // :434
} catch {                              // :443
```

改后三种结果都 push：

| `stat` 结果 | 状态 | 依据 |
| --- | --- | --- |
| 成功且 `isFile()` | `available` | 现在也在 push |
| 抛 `ENOENT` / `ENOTDIR` | `missing` | 文件消失 |
| 成功但 `!isFile()` | `missing` | 那条路径上现在不是文件；对用户而言「我写的文件没了」 |
| 抛其他错误（`EACCES`、`EPERM`） | `invalid` | 存在但读不了 |

Qoder 是四态，多一个 `checking`。我们没有它，因为状态是**在同一次面板请求里同步 `stat` 出来的**，不存在「还没有答案」的中间态。**这不是简化，是结构差异**，写注释说明。

`missing` 与 `invalid` 的区别只看一件事：**用户能不能自己修**。`missing` 没有动作可做；`invalid` 有时是权限问题，值得说出来。

### 2.4 `filesSeen` 的返回形状

`session-state.js:660` 的 `pathsSeen(sessionId)` 现在返回 `string[]`。改成返回对象数组：

```js
pathsSeen(sessionId) {
  return [...entry.paths]
    .sort((a, b) => b[1].seq - a[1].seq)
    .map(([path, item]) => ({ path, turn: item.turn, at: item.at }))
}
```

两个调用点：`index.js:699`（`deps.filesSeen`）与 `api.js` 的 `remembered`。`api.js:927` 处要拆成路径数组喂给 `statTouchedFiles`，再按 `turn`/`at` 回填。

`fallback = newestFirstOf(previous?.paths ?? [], false)` 那条路不受影响——它读的是 transcript 快照里的字符串数组，与存储层无关。

## 三、行结构

### 3.1 单行化

现在（`client.js:381-386`）：

```css
.dsse-row{...min-height:36px;padding:5px 6px;...}
.dsse-name{display:block;...}      /* 第一行 */
.dsse-where{display:block;...}     /* 第二行 */
.dsse-size{flex:0 0 auto;...}
```

改成单行：`[图标 14px] [文件名] [目录，灰] [弹性] [大小]`，行高 28px，与 Qoder 的 `min-h-7` 一致。

**为什么单行更好**：4 条折叠行现在占 144px（36×4），单行后 112px。更重要的是带图标后扫读靠形状而不是读字。

**代价与补偿**：目录名从独占一行变成同行，空间紧张时先收缩它（`flex:0 1 auto;min-width:0`），文件名保持。完整路径仍在 `title` 里。

### 3.2 图标

**不抄 Qoder 的彩色文件图标。** Qoder 按扩展名逐一定制，一套完整彩色资源；那是它自己的设计语言（App 图标级的饱和度），放进我们这个面板会立刻显得像贴上去的贴纸。

我们照抄**自己已有的图标语法**——`client.js:1202-1218` 的 `Icon` 组件已经是这套语法，8 个图标全部遵守：

| 规则 | 值 | 出处 |
| --- | --- | --- |
| 画布 | `viewBox="0 0 24 24"` | `:1203` 起全部一致 |
| 填充 | `fill:none` | `.dsse-icon{...fill:none;...}`（`:347`） |
| 描边 | `stroke:currentColor` | 同上 |
| 线宽 | `stroke-width:1.7` | 同上 |
| 端点 | `stroke-linecap:round;stroke-linejoin:round` | 同上 |
| 颜色 | 继承文字色，行内用 `label-tertiary` | `var(--dsw-alias-label-tertiary,#8b92a1)` |

所以文件图标**是线稿**，不是色块；**只有一种颜色**，跟着行走；形状复用现有图标语汇（圆角矩形 + 内部记号）。尺寸 14px（`width:14px;height:14px` 覆盖 `.dsse-icon` 的 17px），因为它在 28px 行里，17px 会挤压文字。

按扩展名分 8 个桶，每桶一个线稿形状（圆角矩形为共同底座，内部记号区分）：

| 桶 | 扩展名 | 内部记号 |
| --- | --- | --- |
| `code` | js mjs cjs ts tsx jsx py rb go rs java kt c h cpp hpp cs php swift sh ps1 lua sql | 左右两个尖括号 `<>` |
| `markup` | html htm vue svelte xml svg | 一个直角标签 `</` |
| `style` | css scss sass less | 一条波浪线（曲线笔触） |
| `data` | json yaml yml toml ini env csv | 三条横线（表格） |
| `doc` | md txt rst pdf | 三条长短不一的横线（段落） |
| `image` | png jpg jpeg gif webp ico bmp | 小山 + 太阳点 |
| `archive` | zip tar gz 7z rar | 中间一条拉链线 |
| `file` | 其余 | 空底座（无记号） |

**不按扩展名做专属图标**：`Icon` 组件是手写 bundle，每加一个图标都是要维护的一条 SVG 路径；8 个桶覆盖的是「一眼看出这是代码、是图、还是文档」，而**这张卡要回答的是「我改了哪些文件」，不是「这是个什么程序的文件」**。Qoder 需要精确到语言是因为它的产出格里还混着网页和记忆；我们这一列全是文件。

引入方式：新增 `function FileIcon(props)`（与 `Icon` 并列），只负责 `extension → 桶` 的判定与渲染，`extOf(path)` 从 `splitPath` 的 `name` 上取最后一个 `.` 之后的部分并小写。**不改 `Icon`**——它的 `switch` 链已经是面板控件图标，混进 8 个文件类型会让那条链变成两个不相干的列表。

未知扩展名与无扩展名一律落 `file` 桶：**猜错比不猜更糟**——把一个 `.db` 画成数据库图标，而它其实是二进制垃圾时，图标在替我们撒谎。


### 3.3 缺失行的样式

```
data-missing="true"
  color: tertiary
  .dsse-name: line-through
  cursor: default
  不可点击（openable 为 false）
  title: <完整路径>\n文件已被删除或移动
  右侧不显示大小，显示「已删除」
```

`invalid` 用同一套结构，tooltip 换成「文件存在但无法读取」。

### 3.4 缺失行进不进折叠态

**建议：进。** 理由变了——10 号文档里我原本建议不进，那是把折叠态当成「这一轮做成了什么」。但它实际回答的是「这一轮做了什么」，**写了又删也是这一轮做的事**。

而且不进会制造一个无法解释的数字：一轮写了 3 个文件、删掉 1 个，头部说「3 个文件」（来自 `turnFiles`），列表只有 2 行，用户没有任何办法理解那 1 个去哪了。

代价是极端情况下面板四条全是删除线。这是诚实的呈现，不是缺陷。

## 四、折叠与计数

现在（`client.js:2161-2165`、`:2519-2525`）：

```
折叠态 meta:  3 个文件 · 2 个生成
折叠态徽标:   展开全部 5 个
```

两个数字都对，但它们回答的是不同问题却没说是哪个，读起来像矛盾（`DEF-51` 那个缺陷的遗留）。

改成 Qoder 的分工：

| 位置 | 内容 | 谁回答什么 |
| --- | --- | --- |
| 头部 `meta` | `5 个文件`（会话总数，含生成） | 「这个会话产出过多少」 |
| 徽标（折叠时） | `显示其余 2 个` | 「屏幕上少了几个」 |
| 徽标（展开时） | `收起文件` | — |

生成文件的数量不再进头部，但它有专门的组标签（`生成文件`），展开可见——**过滤仍然可发现**。

## 五、行内动作

### 5.1 结构问题（已实施）

原先一行是一个 `<button>`（`client.js:2548`，后来漂移到 `:2768`）。按钮里放按钮是非法 HTML，这也是 Qoder 的 `origin === 'manual'` 移除按钮要绝对定位的原因。

已改成：

```
div.dsse-row                       (position:relative，定位上下文)
  button.dsse-row-open             (flex:1，整块可点，含图标+名称+目录+大小)
  div.dsse-row-actions             (position:absolute;right:4px，叠在尺寸上)
    button.dsse-row-copy           (复制绝对路径)
    button.dsse-row-copy           (复制相对路径，工作区外不渲染)
```

与计划的两点差异，都是实施时才发现的约束：

1. **动作层不是一个按钮，是一层两个按钮。** 最后做的是两项动作而不是一项，`dsse-row-more` 这个名字会误导后来的人以为它是个菜单入口。
2. **动作层绝对定位，不参与 flex 布局。** 起因是 `.dsse-files[data-open="true"]{max-height:245px;overflow-y:auto}` —— 浮到行外的菜单会被这个滚动容器裁掉。同一手法把按钮叠在尺寸上，因此不需要为看不见的控件预留宽度，每个文件名也不会因为多了两个动作而变短。
3. **悬停时尺寸用 `visibility:hidden` 隐藏，不用 `display:none`。** 后者会让尺寸失去槽位，名字在指针移到行上的一瞬间变宽，看起来像在跳。

两个兄弟按钮都键盘可达，`data-actions="false"` 的行（无剪贴板）根本不渲染动作层，`:hover` 也就无从触发。**这是加任何一个行内动作的前提**，所以排在图标之前做。

### 5.2 只做「复制路径」

Qoder 的溢出菜单有六项：四种打开方式、在文件管理器中显示、复制绝对路径、复制相对路径。我们只有后两项有对应能力（`navigator.clipboard.writeText`）。

不抄「在文件管理器中显示」——需要宿主 shell 能力，`shell.overlay` 拿不到。

不抄「四种打开方式」——`client.js:2875` 只有一个 `openResource`，做菜单就是做假按钮。

复制分两项：绝对路径、相对路径（相对会话 `cwd`，`api.js` 已有 `cwd`，需要在返回体里带上）。失败时不弹 toast（没有 toast 设施），用按钮的 `title` 临时改成「复制失败」并 1.5 秒后复原。

实施补充三条：

1. **`navigator.clipboard` 不存在就不画按钮。** 它只在 secure context 里存在，而这个面板正是走 loopback 明文 http，所以「没有剪贴板」是常态而不是边界。一个做不到自己工作的控件比没有更糟。
2. **相对路径与 `fileParts` 是两个函数，不是一个。** `fileParts` 回答「怎么显示」，工作区外会退回最后几段；相对路径回答「文件在哪」，工作区外没有答案 —— 编一个就会把 `../../elsewhere.ts` 写进剪贴板，所以返回 `undefined` 让第二个按钮消失。大小写按 Windows 的规矩折叠，切片用原串。
3. **`writeText` 返回 `undefined` 视为成功。** 它有返回值的形态是 Promise，但替身可以不返回；把「没有 promise」当失败会让一个能用的剪贴板在测试里看起来是坏的。

## 六、空态

现在 `showFiles = ordered.length > 0`（`client.js:2338`），没有文件整张卡不出现。Qoder 的 `artifact` 组永远出现。

**建议不做 Qoder 那样永远出现**：它的产出是十三个分组之一，空着不显眼；我们的卡就是整个面板，每开一个新会话先摆一张「暂无产出文件」是纯噪音。

**但有一种情况该显示**：这个会话写过文件、现在全都不在了（全被删，或全被移走）。这时沉默就是丢失信息。

判定条件：`ordered.length > 0 && ordered.every(f => f.missing === true)` → 卡片照常渲染（行是删除线），不额外加空态文案。**实际上这一条不需要新代码**——2.3 与 3.4 做完之后，全缺失的会话自然显示四条删除线。所以空态这项**取消**，不单独做。

## 七、分阶段

每阶段都可独立交付、独立审查（`bounded-diff-code-review`，单元 ≤200 行 / ≤3 文件）。

### S1 · 数据模型与三态（半天）

| 文件 | 改动 |
| --- | --- |
| `session-state.js` | `STATE_VERSION=2` + 双版本读；`paths` 值改对象；`rememberPaths` 增 `turn` 参；`pathsSeen` 返回对象数组；`trimPaths` 按 `seq` |
| `index.js` | `:371` 改调 `rememberPaths(agentId, ended, finished?.turn)`，`rememberPaths` 移到读 `finished` 之后（`ended` 仍在 `record` 之前读，顺序约束不变） |
| `api.js` | `statTouchedFiles` 产出 `missing`/`invalid`；`readPanel` 适配对象形状；返回体带 `cwd` |
| `client.js` | 缺失行不可点、删除线、tooltip、右侧「已删除」 |

**验收**：删掉一个已产出的文件，下一轮 8 秒轮询后该行仍在且是删除线；重启宿主后「本轮」分组仍然正确。

### S2 · 单行化与图标（半天）

`client.js` 一个文件：行 CSS、8 个图标、`splitPath` 用法调整。

**验收**：168px 最窄卡片下文件名不被目录名挤没；图标按扩展名正确分类；`node --check` 通过。

### S3 · 行内复制（✅ 已完工）

`client.js` 行结构重构 + 复制动作；`api.js` 返回体加 `cwd`（S1 已加，无需再补）。

`client.js` 新增 `relativePath(path, cwd)`、`Cards` 内 `clipboard`/`copied`/`copyTimer`/`copyPath`、行渲染整体替换；`test/client.test.mjs` 新增七组断言（无剪贴板、两项按钮都是兄弟、工作区外只剩一个、大小写不一致仍在工作区内、复制内容、抛异常与 reject 都显示失败、1.5 秒复原、CSS 十条）；`scripts/mutate-language-and-files.mjs` 新增六条突变。

**验收**：悬停出现复制按钮；键盘 Tab 可达；复制成功/失败的反馈可区分。

已经不止是断言覆盖，还用 CDP 在真实浏览器里验过（`_edit/s3_render.py`、`s3_tab_probe.py`、`s3_secure_probe.py`）：
真实指针悬停后读回 `{"actionsOpacity":"1","actionsPointer":"auto","sizeVisibility":"hidden","rowHeight":28}`；
键盘从 opener 按一次 Tab 落到复制按钮且动作层显形；焦点后 120ms 内 opacity 从 0 过渡到 1，不是焦点没生效。

**五个单元独立审查后修了 9 处**（R-84），其中两条是永远为真的断言：读错了按钮槽位（删掉整个清零逻辑也全绿）、
十二条 CSS 断言只校验选择器存在（规则体改空也全过）。另外修了 `İ` 折叠变长导致的切错位、行高亮≠可点区、
焦点下尺寸退出无障碍树、`aria-label` 不播报结果。

**最终**：`3413 passed / 0 failed`，语言突变 **129** 条全杀（锚点下限从 21 抬到 129 并自证），
persistence 45、checklist-panel 128 全杀，残留审计 0。

**一处被实测推翻的判断**：原注释与 D-141 都写着「面板走 loopback 明文 http，所以 `navigator.clipboard` 缺失，
大多数用户看不到复制按钮」。实测 `{"isSecureContext":true,"hasClipboard":true}` —— loopback 算 secure context，
按钮本来就画得出来。决策（没有剪贴板就整层不渲染）不变，被推翻的只是那条成本陈述。

### S4 · 折叠文案（十分钟）

`client.js` 的 `fileMeta` 与徽标 `label`。

**验收**：折叠态头部数字与徽标「还剩 N 个」相加等于总数。

## 八、明确不做

| 不做 | 理由 |
| --- | --- |
| 存活状态服务（`artifactFileStatusService` 那套） | 我们没有 `onWorkspaceFileChanged`，只能轮询；Qoder 的 80ms 合批 + 4 并发是为「几百个文件并发查」设计的，我们 `MAX_PATHS=200` 且只查当前卡片用到的 |
| 悬停预览 | 需要预览渲染栈（`xo1` 那套四态渲染器 + 缩略图生成），没有 |
| HTML 预览与消毒 | 需要 `DOMPurify` 级别的 sanitizer 与 iframe 沙箱；不做就等于没有 HTML 预览能力 |
| Figma embed | 单合作方的 hostname 白名单 |
| 六种打开方式 | 宿主只有一个 `openResource` |
| 内容哈希 `artifactId` | 我们按路径索引；`mtimeMs` + `bytes` 能回答「内容变了没」的绝大多数情况 |
| `origin: manual` | 没有「手动添加来源」这个交互，字段无法被填 |
| 计划文件卡 | 我们没有 spec 产物 |
| `kind: browser/source/memory` | 分别需要网页访问记录、来源引用、记忆系统 |
| 空态永远显示 | 见第六节 |

## 九、测试计划

### 9.1 必须新增

| 断言 | 为什么 |
| --- | --- |
| v1 文件读进来后 `pathsSeen` 仍是完整列表，且 `turn` 为 `undefined` | 钉住迁移不丢数据 |
| v2 写入后 `turn` 存活一次读-写-读往返 | 钉住重启后折叠态正确 |
| `stat` 抛 `ENOENT` 时产出 `missing: true` 而非消失 | S1 的核心 |
| `stat` 抛 `EACCES` 时产出 `invalid: true` 且与 `missing` 可区分 | 三态不能塌成两态 |
| 缺失行渲染为不可点击（`openable === false`） | 防止「看起来能点但点了没反应」 |
| 头部数字 + 徽标剩余数 = 总数 | S4 的唯一目的 |
| 复制按钮在 `focus-within` 下可见 | 键盘用户不能只有鼠标路径 |

### 9.2 必须新增的突变

每条都对应一个「改坏了测试仍全绿」的具体方式：

- `missing` 改成继续 `continue` → 缺失行消失测试必须失败
- `missing` 与 `invalid` 塌成同一个值 → 区分测试必须失败
- `turn` 不写入存储 → 往返测试必须失败
- `READABLE_VERSIONS` 只留 2 → v1 兼容测试必须失败
- 徽标剩余数改成总数 → 加法测试必须失败
- 缺失行 `openable` 恒为 true → 不可点击测试必须失败

## 十、风险

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 老版本插件读到 v2 文件 | 该会话产出卡归零 | 可接受，与全新会话观感一致；注释说明 |
| `missing` 行让面板变长 | 折叠态可能四条全是删除线 | 接受，这是真实状态；不做额外过滤 |
| 单行化后长目录名挤压文件名 | 可读性下降 | 目录名 `flex:0 1 auto;min-width:0` 先收缩；`title` 保留完整路径 |
| 行结构从单按钮改成双按钮 | 现有 `dsse-row-open` 相关测试与 CSS 选择器要跟着改 | S3 单独一个审查单元，改完跑全量 |
| `navigator.clipboard` 在非安全上下文不可用 | 复制按钮点了没反应 | 检测 `navigator.clipboard?.writeText` 不存在时**不渲染按钮**，而不是渲染一个坏按钮 |

## 十一、决策（2026-11-12 已定）

1. **S1 之后停一轮验收**：接受。三态是唯一会改变用户对「我改过什么」的理解的改动，S2/S3 是外观。S1 交付后由人看真实效果再决定后续。
2. **折叠态包含缺失行**（第 3.4 节）：接受。写了又删也是这一轮做的事；不进会制造无法解释的数字。
3. **复制路径（S3）做，但优先级最低**：接受。它是唯一不需要宿主新能力的行内动作，排在 S2 之后。理由是它解决的场景（不想手打长路径）发生频率低，而 `title` 提示已经能手动选中复制。
4. **图标（S2）做，且必须契合宿主样式**：按第 3.2 节执行——`FileIcon` 与 `Icon` 并列、24 网格线稿、`currentColor`、1.7 线宽、14px、8 桶共享底座、未识别落空底座。**不引入任何彩色或第三方图标资源。**

### 已被否决的两条（记下来防止以后重提）

- **不做 Qoder 式永远显示的空态**：它的产出是十三个分组之一，空着不显眼；我们的卡就是整个面板本身。S1 + 3.4 落地后，「写过但全被删」会自然显示删除线行，不需要空态代码。
- **不做「在文件管理器中显示」**：需要宿主 shell 能力，`shell.overlay` 拿不到。做不出来却放个按钮等于说谎。

