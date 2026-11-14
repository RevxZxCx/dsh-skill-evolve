# 19 · 产出文件采集缺口：ABC 三方案合并执行方案

> 状态：**S5、S5 补丁、S6、S6 补丁、S7 已完工并通过审查与真机验收**（2026-11-12 / 11-13 / 11-14）；S8 三路合并未开始。用户 2026-11-12 指令「ABC都要做，记录为后续的任务」。
> S7 的交付与偏差见 [`handover/01-status.md`](./handover/01-status.md) 的「2026-11-14 · S7」一节；审查与真机验收见同一文件的「2026-11-14 · S7 审查」一节与 [`handover/04-reviews.md`](./handover/04-reviews.md) 的 R-79。
> 前置：[`09`](./09-Qoder产出文件机制逆向.md)（Qoder 产出机制）、[`18`](./18-产出卡对齐Qoder方案.md)（产出卡改造总方案，S1/S2 已完工）
> 本文只回答一个问题：**脚本运行时写出的文件，怎么让产出卡知道。**
>
> **S6 落地记录见 [`handover/01-status.md`](./handover/01-status.md) 的「2026-11-13 · S6 补丁」一节**：真机验收失败证明纯 `git status` 不够（仓库在工作区下面、已提交的改动看不见），所以补了多根发现、worktree 识别与 `coverage: partial`（D-120/121/122）。本文 §五 的 A 方案是原始计划口径。
>
> **S5 落地记录见 [`handover/01-status.md`](./handover/01-status.md) 的「2026-11-12 · S5」一节**：工具名 `report_output_files`，读取点在 `transcript.js` 的 `noteCall`，不是 `execute`（D-111）。本文 §四 的 S5 行是计划口径，实际多了 10 条突变与一个新测试文件。

---

## 一、缺口是什么

### 1.1 现象

会话 `session-3df29447` 第 8 回合，模型被要求"创建八个文件，格式分别为代码、标记、样式、数据、文档、图片、压缩包、空底座"。

- 磁盘 `F:\test\test8\` 上确实有 8 个文件；
- 产出卡本轮只显示 4 个（`code.py` / `markup.html` / `styles.css` / `data.json`）；
- 展开「全部 9 个」后在「更早」组里也找不到另外 4 个（`doc.docx` / `image.png` / `archive.zip` / `empty.bin`）。

### 1.2 根因

`packages/ui-evolve/lib/transcript.js` 只有两条采集路：

| 路 | 位置 | 覆盖什么 |
| --- | --- | --- |
| 工具参数 | `transcript.js:318`，对 `EDIT_TOOLS` 调 `readPathArgument` | `write` / `edit` / `ops_write_file` 等工具**参数里**出现的路径 |
| 命令行重定向 | `transcript.js:319-332`，对 `SHELL_TOOLS` 调 `writtenPaths(command)` | `echo x > a.txt` 这类**命令行文本里**出现的路径 |

第 8 回合的实际情况：4 次 `write`（进卡）+ 1 次 `ops_bash` 执行 `F:\test\_mk8.py`（只进卡脚本自己的路径）。脚本**在运行时**用 python-docx / PIL / zipfile 写出了另外 4 个文件——既不是工具参数，也不在命令行文本里，两条路都不经过。

### 1.3 为什么这是设计而非 bug

现有采集逻辑对它是自洽的：产出卡回答的是"这次会话动过哪些路径"，而"动"的定义就是"工具有个参数写着它"。脚本内部的写操作对宿主完全不可见。**但这不满足用户预期**，因为用户看到的是磁盘上确实多出了文件。

---

## 二、Qoder 怎么解决的（逆向结论）

详见 [`09`](./09-Qoder产出文件机制逆向.md)，此处只列与缺口相关的三条：

| 通路 | 证据 | 说明 |
| --- | --- | --- |
| **git 差分** | `main.js` 内真实 shell 脚本：`git status --porcelain=v1 -z --untracked-files=all`、`git diff --cached --numstat -z`、`git diff --numstat -z` | 主通路。配套表 `turn_file_change_sets` / `turn_file_change_files` / `turn_file_change_patches` / `turn_file_change_blobs`，IPC `chatSessions.fileChanges.getPatch` / `getReview` / `undo` |
| **`present_files` 工具** | 工具名映射表 `iqx` 中 `present: {}, present_files: {}` 原样存在；描述串 `Deliver artifact files to the user.` | 补充通路。适用于 gitignore 的产物、工作区外文件、用户明确要展示的东西 |
| **`chat_session_highlights` 投影** | `projectHighlights` / `chatSessions.watchHighlights` / `chat_session_highlights` 表 | 采集结果先落这张表，再投影成面板上那 5 个分组 |

**关键点**：`chokidar` / `fs.watch` / `readdirp` / `glob(` / `fast-glob` / `globby` 在 `main.js` 里**全部 0 命中**。Qoder 不监听文件系统、不扫目录。它靠 git 知道"什么算变化"，靠工具知道"什么该展示"。

**未确认**：`Deliver artifact files to the user.` 与 `present_files` 的绑定关系是推断（字符串表索引需经 `R(a,x)` 偏移换算，各模块还有不同的局部包装函数，无法可靠推导）。

---

## 三、三方案对比

| | 做法 | 覆盖脚本写的文件 | 强项 | 短板 |
| --- | --- | --- | --- | --- |
| **A** | 回合结束跑 `git status --porcelain=v1 -z --untracked-files=all`，把这一轮新出现的路径纳入 | ✅ | 语义最准；gitignore 天然过滤噪音；不增加模型负担 | **只在 git 仓库里有效**；`npm install` 后可能一次多出几千行；非 git 工作区完全失效 |
| **B** | 回合开始记时刻，结束时遍历 cwd 收 `mtime > 开始时刻` 的文件 | ✅ | 不依赖 git；非 git 工作区也能用 | 大仓库 IO 开销高；需要三个上限（跳过生成目录、限制访问文件数、超限放弃）；本质是自己实现一个更差的 `git status` |
| **C** | 加一个「申报」工具，让模型主动说"这几个文件是我这轮的产出" | ✅ | 补 A/B 都覆盖不到的：gitignore 里但确实要展示的、工作区外的、临时生成后要留档的 | 依赖模型记得调；多一个工具要维护；模型不发就什么都没有 |

### 3.1 为什么不选单一方案

实测数据（用户当前测试环境 `F:\test`）：**不是 git 仓库**。

- 只做 A → 用户这个场景一条都补不上；
- 只做 C → 用户得重新跑一遍那个会话，且模型未必调；
- 只做 B → 能补上，但每次回合结束都要遍历整个 cwd，`F:\test` 这种堆了几百个文件的目录会明显拖慢。

**三者互补关系**：A 是主干（有 git 时最准最省），B 是 A 的兜底（无 git 时），C 是 A/B 的补充（要展示但不可见的东西）。

### 3.2 执行顺序

```
C（最便宜，先止血）
  ↓
A（主干，有 git 时最准）
  ↓
B（兜底，无 git 时）
```

**先 C 的理由**：它是三个里唯一不依赖工作区状态的。用户当前场景 `F:\test` 无 git，A 完全失效；B 要写遍历和上限，成本最高。C 只需要给模型一个工具 + 把返回值接进 `transcript.js` 的路径集合，半天能跑通，而且**立刻可验证**（让模型重跑一次那个八文件会话）。

**A 在 C 之后**的理由：A 会改变"什么算产出"的语义（从"工具参数里有它"变成"git 说它变了"），需要独立一轮验收。它也是唯一会引入新的失败模式的（非 git 工作区、超大 diff、子模块）。

**B 最后**的理由：B 的每一个设计决定都要靠 A 落地后的实测数据来定——扫描上限设多少、跳过哪些目录、超时多久。先写 B 等于凭空猜这三个数字。

---

## 四、C 方案细节（第一个做）

### 4.1 工具定义

新增到 `packages/skill-evolve/lib/tools.js`（与现有 `skill_candidate_submit` 等并列）：

| 项 | 值 |
| --- | --- |
| 名称 | `report_output_files` |
| 参数 | `paths: string[]`（必填，1–50 条）、`note?: string`（可选，一句话说明这批文件是什么） |
| 描述 | 告诉面板这一轮产出了哪些文件。用于脚本、构建、生成器写出的文件——那些没有通过 `write` / `edit` 工具写出、因而不在工具参数里的文件。 |
| 返回 | `{ ok: true, recorded: number, ignored: number }` |

**为什么叫 `report_` 而不是 `present_`**：`present` 在 Qoder 里意味着"给用户看"，会触发预览/交付链路；我们这里只是"记进账"，语义要更窄。名字窄一点，将来要加真正的 present（比如带预览的交付）时不会撞。

### 4.2 接入点

`packages/ui-evolve/lib/transcript.js` 的 `EDIT_TOOLS` 分支旁新增一条：

```js
// Reported files are the third way a path can enter the card. The first two
// read what the tool said; this one reads what the model said about tools that
// said nothing. Same set, so de-duplication and ordering already work.
if (REPORT_TOOLS.has(event.toolName)) { ... }
```

**必须复用的现有机制**（不要另建账）：

1. `readPathArgument` 的同款路径归一（相对路径 → 绝对，反斜杠 → 正斜杠）；
2. `this.paths` 集合——它是 `turn/end` 时 `rememberPaths` 的数据源；
3. `isNoisePath` 过滤——模型报了 `node_modules/x.js` 也不该进卡。

### 4.3 与「本轮」的关系

申报的文件必须**算作本轮**（`turn: true`）。理由：`report_output_files` 只会在回合内被调用，模型不会替上一轮申报。若它真的报了旧文件，那是模型的错，不是卡片该猜的事。

### 4.4 需要补的断言

| # | 断言 | 破坏方式 |
| --- | --- | --- |
| 1 | 申报一个路径后，`paths` 里有它 | 删掉 `REPORT_TOOLS` 分支 |
| 2 | 申报的相对路径被归一成绝对路径 | 去掉归一调用 |
| 3 | 申报的 `node_modules/x.js` 被记为 noise 而非 people | 跳过 `isNoisePath` |
| 4 | 同一路径既 `write` 又申报，只出现一次 | 去掉 Set 去重 |
| 5 | 参数缺 `paths` 时返回错误而不是崩 | 去掉校验 |
| 6 | 超过 50 条时截断并告知 | 去掉上限 |

---

## 五、A 方案细节（第二个做）

### 5.1 命令与解析

```
git -C <cwd> status --porcelain=v1 -z --untracked-files=all
```

`-z` 意味着以 NUL 分隔、且**路径不加引号**（普通模式下含空格的路径会被引号包起来，解析要处理转义；`-z` 免掉这一层）。

输出逐条格式：`XY <path>`，`XY` 是两字符状态码（`M ` 修改、`??` 未跟踪、`A ` 新增、` D` 删除、`R ` 重命名）。重命名在 `-z` 下是两条记录（旧路径、新路径）连在一起，需要按 `R` 状态码多读一条。

### 5.2 必须处理的边界

| 边界 | 处理 |
| --- | --- |
| 不是 git 仓库 | `git status` 退出码非 0 → **静默跳过**，不报错、不弹提示。这是合法答案，不是失败。 |
| `cwd` 不在仓库根 | `git -C <cwd>` 会正常向上找 `.git`，但输出的路径**相对仓库根**，不是相对 `cwd`。需要 `git rev-parse --show-toplevel` 换算。 |
| 命令超时 | 2 秒上限，超时放弃本轮 A 通路（B/C 仍在） |
| 输出过大 | 超过 2000 行放弃 A 通路——那说明这一轮动了整个仓库，列表没有意义 |
| `.git` 目录本身 | `git status` 不会列它，无需处理 |
| 子模块 | 默认输出子模块名一行，不递归。可接受 |

### 5.3 与 B/C 的合并

三条通路的结果汇到同一个集合，去重后一次性 `rememberPaths`。**顺序无关**——`seq` 才是排序依据。

### 5.4 需要补的断言

| # | 断言 |
| --- | --- |
| 1 | 非 git 目录 → 不抛错、不产生路径 |
| 2 | 单文件修改 → 出现且 `turn: true` |
| 3 | 未跟踪文件（`??`）→ 出现 |
| 4 | 重命名的两条记录 → 旧路径不出现、新路径出现 |
| 5 | 超时 → 放弃且不抛错 |
| 6 | 输出超 2000 行 → 放弃且不抛错 |
| 7 | 路径含空格 → 正确解析（`-z` 的意义） |

---

## 六、B 方案细节（第三个做）

### 6.1 做法

回合开始记 `t0 = Date.now()`（落在 `index.js` 的 `turn/start`）；回合结束遍历 `cwd`，收 `stat.mtimeMs > t0` 的文件。

### 6.2 三个上限（缺一不可）

| 上限 | 建议值 | 超限行为 |
| --- | --- | --- |
| 访问文件数 | 5000 | 到达即停止遍历，**保留已收集的**，并在返回体标记 `truncated: true` |
| 目录深度 | 8 | 超过不再下潜 |
| 总耗时 | 1500ms | 到时即停 |

### 6.3 必须跳过的

复用 `api.js` 现成的 `GENERATED_DIRS` / `TEMP_DIRS` / `scratchName` 规则，**不要新写一套**。理由写在 `api.js` 那段注释里：`node_modules` 一个目录就能有十万个文件，跳过它是 B 方案能不能用的前提。

### 6.4 与 mtime 的固有误差

`mtime` 不是"写于"的可靠证据：

- `git checkout` / `npm install` 会成批改 mtime；
- 某些编辑器保存时会先写临时文件再 rename（mtime 是新文件的）；
- 网络盘 / WSL 挂载的时间戳精度可能只有秒。

**因此 B 只做"补"，不做"主"**：它的结果与 A/C 合并后，若某个路径只被 B 发现，标记 `source: 'scan'`；若同时被 A 或 C 发现，则以后者为准。这不是为了追溯，而是为了将来排查"为什么这个文件会出现在卡上"时有据可查。

---

## 七、四阶段施工顺序

| 阶段 | 内容 | 预估 | 验收方式 |
| --- | --- | --- | --- |
| **S5** ✅ | C 方案：`report_output_files` 工具 + `transcript.js` 接入 + 读 `present` 的那次调用 + 六条断言（实交 71 条） | 半天 | 让模型重跑八文件会话，卡上出现 8 个 |
| **S6** ✅ | A 方案：`git status` 通路 + 回合夹逼（实交 68 条断言、7 条突变；**补丁后 85 条断言、14 条突变，含多根/worktree/coverage**） | 一天 | 在有 git 的仓库里改一个文件、跑一个脚本，两者都出现 |
| **S7** | B 方案：mtime 扫描 + 三个上限 + 断言 | 一天 | ✅ 已完工并通过审查（2026-11-14，实交 90 条断言 + 审查补的接缝断言，突变 101/45/128 全杀见 §7.1 与 §7.2）。真机验收已做：非 git 目录里跑脚本写三个文件，状态文件读到 `out3 hits: 3`，`.git` 与 `node_modules` 零条 |
| **S8** | 三路合并与来源标记 + 折叠文案收尾（原 S4） | 半天 | 头部计数与三组内容一致 |

**每阶段都要跑**：全量 `node test/run.mjs`、三套突变、`audit_leftovers.py`。

**S5 实际交付**（对本表计划口径的两处更正）：断言从六条变成 **71 条**（`test/transcript.test.mjs` 30 条 + 新文件 `test/report-tool.test.mjs` 41 条），突变 **17 条**，全量 **3039 passing / 0 failed**。

**S6 实际交付**（2026-11-13）：两个新模块而不是一个改动——`git-changes.js`（253 行，porcelain 解析 + 仓库上溯 + 集合差）与 `git-watch.js`（146 行，按会话的基线生命周期），`index.js` 加三处接线。断言 **68 条**（`test/git-changes.test.mjs` 42 + `test/git-watch.test.mjs` 19 + `test/index.test.mjs` 端到端 7），突变 **7 条**，全量 **3106 passing / 0 failed**。

与本表计划口径的三处偏差，都是实现时才发现必要的：

1. **不是「记录 `git status` 的集合」而是「回合开始与结束两次读数的差集」**（D-117）。`git status` 是累计的，照抄会把五轮以前的改动反复标成「本轮」。
2. **基线存 promise 不是数组**（D-118）。大仓库上 `git status` 可能比回合启动到首个工具调用的间隔还长，存数组要么阻塞要么竞态。
3. **还多修了一个真缺陷**：`workspaceFor` 原本只认 agent 形状，而事件流传的是 session，cwd 恒为空让整条链路从未运行过一次（DEF-99）。这条是端到端测试抓到的，两个单元测试各自全绿。

已知边界：**S6 对 `F:\test` 无效**（那个工作区不是 git 仓库）——这正是 S7 存在的理由，也是本表把 C 排在 A 前面的原因。

### 7.1 S7 实际交付（与本表口径的偏差）

- **断言 90 条**（计划未给数字）：`scan-changes.test.mjs` 42 + `scan-watch.test.mjs` 35 + `index.test.mjs` 端到端 13。
- **突变 13 条**，全部 KILLED；`mutate-language-and-files` 从 85 条增至 98 条。
- **噪声规则不是「复用」而是「上移」。** 计划写的是「复用 `api.js` 现成的 `GENERATED_DIRS` / `TEMP_DIRS` / `scratchName`」，但这些原本定义在 `isNoisePath` 函数体内部，遍历器根本调不到。实际做法是把它们提到模块级，并新增导出 `isGeneratedDirectory(segment)` 供遍历器逐层询问（D-125）。这不是重构洁癖：写第二份必然漂移，而漂移是静默的。
- **`>=` 而不是 `>`。** 计划写 `mtime > t0`。实测在一个文件系统时间片内开始并结束的回合，`>` 会漏掉全部文件，所以实现用 `>=`，代价是可能多收同片内的写入（保守方向）。
- **只在 git 无答案时采用。** 计划说「B 只做补，不做主」，实现把它落成一行：`fromGit.length > 0 ? fromGit : fromScan`。`mtime` 分不出「这轮写的」与「`git checkout` 重写的」，所以只要 git 有话说，扫描就闭嘴（D-124）。
- **三个上限同时生效，且截断要说出来。** 5000 条目 / 8 层 / 1500ms，任一到达即停并置 `truncated: true`，面板显示 `partial`。一个不承认自己停手的遍历，比不遍历更糟：它把「没读」说成「没有」。
- **`source: 'scan'` 标记未做**，属 S8。

**S6 补丁（2026-11-13，真机验收失败后补）**：用户在 `F:\test` 跑了 12 个回合，`git init` 建在 `F:\test\test8`，卡片上一个 git 文件都没有。两件事同时成立——`findRepositoryRoot` 只会**向上**找而仓库在**下面**；`git status` 只看得见未提交的改动而那一轮最后一条命令就是 `git commit`。补了三条：

1. **多根发现**：先向上找，找不到就列**一级**子目录里带 `.git` 的，上限 `MAX_CHILD_ROOTS = 20`（D-120）。
2. **worktree 识别**：一次 `rev-parse --show-toplevel --absolute-git-dir --git-common-dir`，前者与后者不等即 worktree；用 `--absolute-git-dir` 而不是 `--git-dir`，因为后者是相对 cwd 的路径（D-121）。
3. **`coverage` 字段**：任何一路读不出来就记 `partial`，并且写在「零文件就早退」之前——一个在只能半读的仓库里没有产出的回合，与一个确实什么都没产出的回合，`paths` 完全一样，区别只在 sweep 自己知道（D-122）。

至此断言 **58 条**（`git-changes` 42→58）+ `git-watch` 25，全量 **3146 passing / 0 failed**，突变 **85/44/128 全杀**。仍然**没有**在合格样本上真机验收过（工作区根即仓库根、改动保持未提交）。


**样本 B 与样本 C 已跑（2026-11-14，用户 m09864 要求补）**：上面那句「没有真机验收过」只对 S6 当时成立。多根与 worktree 现在有真实仓库的证据了——父目录非仓库 + 两个子仓库 → 两个根都读到、`coverage: complete`；worktree 的 `.git` 是文件、`--absolute-git-dir` 与 `--git-common-dir` 不等 → 判为 worktree，两个 checkout 的 `status` 互不泄漏。另测三个边界：损坏子仓库 → `partial`、22 个子仓库撞 20 上限 → `partial`、普通 checkout 的 `--git-common-dir` 在仓库根是相对路径 `.git`（不 `resolve` 会**在每个普通仓库上误报 worktree**，实测 naive 比较得 `true`、resolve 后得 `false`）。未发现新缺陷。明细见 [`handover/01-status.md`](./handover/01-status.md) 的「2026-11-14 · 样本 B 与样本 C」一节。

仍**未**覆盖的：真实宿主回合里这些路径被触发（需带工具调用的真机会话）、macOS/Linux 上的行为（`--git-common-dir` 的相对规则相同，但证据只来自一台 Windows）。

**S5 补丁（2026-11-12 同日）**：真机验收发现模型一次没调 `report_output_files`，只调了宿主的 `present`。于是补了读 `present` 的 `files[].path`（`PRESENT_TOOLS` / `readPresentedPaths`），并把申报路径与推断路径分开放（`declared` 在 `snapshot` 里排前面），容量收敛成唯一常量 `MAX_CARD_PATHS = 40`，超限改为如实汇报 `dropped` 而不是谎报拒绝。详见 [`handover/01-status.md`](./handover/01-status.md) 的「2026-11-12 · S5 补丁」一节与 R-74。

**「让模型重跑八文件会话，卡上出现 8 个」这条验收仍未完成**——第一次真机跑证明工具注册成功、但模型没调用它，补丁后还没有第二次真机跑。本轮全部验证都停在断言层。这个缺口记在 [`handover/04-reviews.md`](./handover/04-reviews.md) 的 R-73 / R-74「诚实的缺口」里，不假装已经验过。

---

## 八、明确不做

| 不做 | 理由 |
| --- | --- |
| 文件系统监听（`fs.watch` / `chokidar`） | Qoder 都不做。大仓库会炸，事件会重名漏报，且 Windows 上 `fs.watch` 的递归支持有历史缺陷 |
| 解析脚本内容（读 `.py` 猜它会写什么） | 等于自己写一个解释器，猜错比不猜更糟 |
| 内容哈希 `artifactId` | 已在 [`18`](./18-产出卡对齐Qoder方案.md) §八 说明：我们是路径身份，不是内容身份，改了不会变成另一个文件 |
| 云端上传 / `remoteControlArtifactService` | 宿主没有这个能力，做了就是假按钮 |
| 把 `git status` 的输出当 diff 展示 | 我们只需要路径，不需要行级内容。要 diff 是另一个功能 |

---

## 九、风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| A 在超大仓库里拖慢每回合收尾 | 每次回合结束多 0.1–2 秒 | 2 秒超时 + 2000 行上限，超了静默放弃 |
| B 在 `F:\test` 这类目录里扫太慢 | 同上 | 5000 文件 + 1500ms 双上限 |
| C 被模型滥用（每轮报一堆无关文件） | 卡变噪音 | 50 条上限 + 走 `isNoisePath` 过滤 + 描述里写清"只报这一轮真正产出的" |
| 三路合并后出现重复行 | 用户看到两行同名 | 合并时按归一化绝对路径去重，已有 `seen` Set 可复用 |
| 老状态文件（v1）没有 `source` 字段 | 读进来是 undefined | 已有双版本读机制，`source` 缺省不显示即可 |

---

## 十、与既有文档的关系

- 本文是 [`18`](./18-产出卡对齐Qoder方案.md) §七 施工表的**追加**，不替代 S1–S4；
- S4（折叠文案）并入本文 S8，因为三路合并会改变"本轮"的计数含义，两件事分开做会返工；
- [`09`](./09-Qoder产出文件机制逆向.md) 提供逆向依据，**不改写**；
- 落地后按 `docs/handover/` 规矩记录，本文状态改为「已完工」。

### 7.2 S7 审查之后又改了什么（2026-11-14）

四个审查者（s7a / s7b / s7c+s7d / s7e）里三个独立指向同一个 P0，值得在这里单列，
因为它是这张表**没有预见到的失败模式**：B 方案里「跳过生成目录」被当成了扫描器的
一个可选参数，而生产路径从来没传它。结果是非仓库工作区——这条通路存在的唯一理由——
上，预算先被 `.git` 与 `node_modules` 吃光，真正的产出反而不在结果里。

改了什么：

1. `scan-changes.js` 的 `skipDirectory` 默认值改为 `isGeneratedDirectory`（真正的接线）。
2. `isGeneratedDirectory` 收窄为只查 `GENERATED_DIRS`，不再套 `scratchName`——
   前导下划线规则是为临时**文件**写的，套在目录上会剪掉 Jekyll `_posts`、Hugo `_build` 这些源码。
3. `GENERATED_DIRS` 增加 `.git`（实测本仓库 `.git` 贡献 1167 条被扫、895 条进结果，占 23%）。
4. `scan-watch.js` 的空读改为每次新对象；reader 抛错从 `complete` 改为 `partial`。
5. coverage 从两词扩成三词 `complete` / `partial` / `none`，合并规则收敛到
   `packages/ui-evolve/lib/coverage.js` 的 `mergeCoverage` 一处。

新增断言：`test/scan-changes.test.mjs` 42→49、`test/scan-watch.test.mjs` 35→39、
`test/coverage.test.mjs` 新增 10 条。**关键的一条是「不注入」的那条**——
它走 `scanReading` 生产 reader，证明默认值真的接上了；把默认值改回去会让它立刻红。

真机对比（同一台机器，同样 5000 条预算）：

| | `.git` 条数 | `node_modules` 条数 | `out3/` 命中 |
|---|---|---|---|
| 补丁前（旧构建） | 唯一一条路径就是 `.git\index` | 吃满预算 | 0 |
| 补丁后 | 0 | 0 | 3 |
