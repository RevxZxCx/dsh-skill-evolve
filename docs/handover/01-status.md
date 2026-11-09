# 状态路线图

> **追加式**。每节一次快照，不改旧的。最新一节永远在文件末尾。

| 日期 | 快照 | 一句话 |
|---|---|---|
| 2026-10-30 | 首次整理 | 22 个模块 11,939 行；1722 断言全绿；三个变异套件归零；清单卡片已推送 `051d8b6` |
| 2026-10-30 | 前端重构 | 三卡同屏、点击式候选审核、宿主字体实时同步；1734 断言全绿；26 个清单变异归零 |
| 2026-11-02 | ui-evolve 接手交接 | 六成员服务契约、三条硬契约、路由表、摘要路由优先级；1818 断言全绿 |
| 2026-11-03 | 上一轮卡片四项界面修正 | 去提炼按钮、头部基线对齐、五行截断、hover/点击展开；1873 断言全绿 |
| 2026-11-03 | 界面首轮审查修复 | 不可交互的卡片真的惰性；pin 属于它被按下的那一轮 |
| 2026-11-04 | 界面第二轮审查修复 | hover 也要带轮次；打开必须有测量背书 |
| 2026-11-04 | 界面第三轮审查修复 | 轮次标记在会话切换处清空，三个标记都不跨会话 |
| 2026-11-04 | 界面第四轮审查 | `PANEL_WIDTH` 注释被 sync 覆盖两次；D-30/D-31 |
| 2026-11-03 | 面板状态按会话持久化 | `session-store.js` + `session-state.js`；一会话一文件，覆盖写 |
| 2026-11-03 | 持久化首轮审查修复 | 关机竞态；两个可被撑大的入口 |
| 2026-11-03 | 持久化第二轮审查修复 | 一次「读」也能销毁历史 |
| 2026-11-03 | 持久化第三轮审查修复 | 清扫看不见的写，写看得见的清扫 |
| 2026-11-04 | 持久化第四轮审查修复 | 两个方向各修了一半 |
| 2026-11-04 | 持久化第五轮审查修复 | 一条记录的身份，不只在它是谁 |
| 2026-11-04 | 持久化第六轮审查 | 上一轮的修复删掉了别人的文件 |
| 2026-11-04 | 持久化第七轮审查 | 一次读不出两个答案（`inspect` 三态） |
| 2026-11-04 | 持久化第八轮审查修复 | 一次写入记得的必须是整段对话（合并语义） |
| 2026-11-04 | 持久化第九轮审查修复 | 同一个问题，两个回答者（`hasFacts`、单飞） |
| 2026-11-05 | 持久化第十轮审查修复 | 删掉别人的工作，和一个负数 |
| 2026-11-06 | 持久化第十一轮审查修复 | 谁的数字，谁的证据 |
| 2026-11-06 | 持久化第十二轮审查修复 | 谁有权相加（`viewOf` 读盘、回合数单一作者） |
| 2026-11-06 | 持久化第十三轮审查修复 | 抽出来的判据，要走过去的人用（`keepsDocument`） |
| 2026-11-06 | 界面六项需求 + 实时流 | 统计贴右、六行、点击才展开、加载提示、只在会话页显示；`LiveHub` + `/live` SSE，轮询降为 60 秒兜底；2355 断言全绿，五套变异 26/65/14/44/15 全杀 |
| 2026-11-06 | 撤回实时流 | 删 `LiveHub`/`/live`/`EventSource`，轮询恢复唯一通道恒定 8 秒；`settling` 照常显示（D-75）；2264 断言全绿，五套变异 68/11/14/44/15 全杀 |
| 2026-11-07 | 展开按钮改圆标 | 卡片内底边居中圆形图标按钮（D-76，不占布局）；展开后仍显示收起入口且不随指针消失（D-77）；chevron 方向随开合翻转；2277 断言全绿，五套变异 78/11/14/44/15 全杀 |
| 2026-11-07 | 总结语言 + 产出卡改累计 | 总结语言由宿主 `<html lang>` 指定（D-78）；产出卡改成会话累计（D-79），中断回合也记（D-80），上限三处收口（D-81）；2387 断言全绿，六套变异 81/21/44/15/14/11 全杀 |
| 2026-11-08 | 实时输出速度 | 新增 `GET|HEAD /speed` 与头部圆角速度徽章（D-86）；走 `agent/assistant-stream` 而非 `assistant/chunk`（D-83）；两秒滑动窗口 + 字符估算 + provider 计数校正（D-82/D-84/D-85）；徽章非 live region（D-87）；2525 断言全绿，七套变异 49/81/21/44/15/14/11 全杀 |
| 2026-11-09 | 徽章改常驻 | 徽章答过一次就常驻，空闲显示破折号而非 0（D-88）；`known` 跨会话保留、读数随会话清空（D-89）；2530 断言全绿，七套变异 50/81/21/44/15/14/11 全杀 |
| 2026-11-09 | 速度显示最近几次平均 | 停下来后显示最近五条消息的加权平均（D-90），与实时读数按 实时>linger>平均>破折号 的优先级共存；`averageOf` 删掉不可达守卫（DEF-61）；补「有窗口无平均」用例（DEF-62）；2566 断言全绿，七套变异 58/81/21/44/15/14/11 全杀 |

---

## 2026-10-30 · 首次整理

### 这个插件是什么

DSH 插件。在会话进行中观察，识别值得复用的流程，把候选技能排进队列，等人批准后写进 `~/.dsh/skills/`。它自己的 README 里写着「honest limits」一节，那里的话比这里更狠，需要判断价值时先读那一节。

### 现在真的能用的

以下每一项都有对应的真实证据，不是"代码写了"：

| 能力 | 证据 |
|---|---|
| 从真实会话里检测重复流程 | `test/replay.mjs` 跑过真实 `session.v4.jsonl.zstd`；阈值来自回放数据 |
| 双触发电机（结构重复 + 回合反思） | 两条路径各有独立测试；同一条 `service('agents')` bug 曾同时杀死两者 |
| 技能候选：提交、排队、批准、晋升、反转 | `test/index.test.mjs` 240 条走完整条链 |
| 证据闸门（四类引文、按角色分档、禁止模型自证） | `test/evidence.test.mjs` 46 条；插件自己的 7 个工具从所有 lane 排除 |
| 两段式批准（`approvalMode: 'confirm'`） | 批准只标队列，模型下一步写定稿；digest 绑定内容，改了就退回 |
| 候选过期（四条判据，只报告不删除） | `test/candidates.test.mjs` 52 条 |
| 技能目录压缩 + 关键词搜索 + skills.sh 市场 | `catalog` 98 / `search` 57 / `market` 92 条 |
| 加载后观察窗口（outcome） | `outcome` 53 + `outcome-wiring` 36 条 |
| 会话区内浮层卡片 + 待批准清单卡片 | 客户端 158 条；三个变异套件覆盖几何与卡片 |

### 当前数字

- 模块：22 个（`lib/*.js`），11,939 行。最大三个：`index.js` 2156、`client.js` 1962、`tools.js` 868。
- 测试：30 个套件、**1722 断言全绿**。`real-mount.test.mjs` 显示 0 passed 是因为未装 `@deepseek-ai/cordis` 而 **skip**，不是失败。
- 工具 7 个：`skill_candidate_list/submit`、`skill_feedback`、`skill_market_install/preview/search`、`skill_search`。
- 命令 5 个：`/skill-capture`、`/skill-feedback`、`/skill-rank`、`/skill-review`、`/skill-stats`。
- 配置 34 项（`node -e "import('./lib/config.js').then(m=>console.log(Object.keys(m.Config({}))))"` 可列出）。

### 真实数据现状（`~/.dsh/plugin-data/skill-evolve/`）

- `candidates.json`：**9 条候选**，其中 2 条 stale（`pyinstaller-pyarmor-exe-triage`、`windows-path-escape-corruption-audit`）。
- `registry.json`：**3 个技能**。`windows-source-edit-via-guarded-python` 已 active、uses 6；`windows-gguf-tts-audiocpp` 与 `stub-capability-mutation-testing` 仍 unverified。
- `ledger.jsonl`：31 行，`{propose:13, discard:1, approve-staged:3, approve:3, skill_used:9, active:2}`。
- `~/.dsh/skills/`：4 个（3 个本插件写的 + `distilly`，后者不是本插件产物）。

**注意**：`helpful`/`harmful` 在真实账本里全是 0。这不是"效果差"，是**从未被评价过**（not measured ≠ zero）。评估技能收益时不要把它读成零效果。

### 明确未做的

- **面板不能安装技能、不能写技能文件**。它能批准/忽略候选（走 `/skill-capture` 用的同一个 `approve()`），这是唯一写入口。
- **没有图形化的配置页**。所有配置在 DSH 的插件设置里，面板只暴露 5 个开关。
- **反思路径只发布过 1 次**（真实测量），且被重复提示覆盖。已加 `reflectionHoldSteps=8` 独占通道，但还没有第二次真实观测。
- **L2/L3 没做**：逐技能验收（需要改技能格式加 `evolved-verify`）与对照实验（需要隔离执行器，插件内做不到）。L1 观察窗口已落地。
- **`docs/handover/` 是本轮新建的**，此前所有决策与缺陷只散落在 `docs/05` 的 25 章修订记录里。

### 已知的脆弱点

1. **`lib/client.js` 靠 `sync-gutter.mjs` 从 `lib/gutter.js` 内联几何**。改了 `gutter.js` 忘了跑 sync，`test/gutter-drift.test.mjs` 必须失败——但它是**手写枚举**的，历史上两次漏了新函数（`placeTip`、`placeNear`）。新增导出函数时，要同时问"哪些守卫的名单里该加上它"。
2. **客户端改动需要重启宿主**才能被扫描到（`package.json` 变化不触发插件图重建）。
3. **行尾**：全仓是 LF，`.gitattributes` 是 `* text=auto eol=lf`。用 Python 文本模式写回会在 Windows 上造成整文件 CRLF，曾导致 `test/mutate-panel.mjs` 两个多行锚点静默失配、少测两个变异。
4. **`service(name)` 必须走 `ctx.get(name)`**。cordis 对未声明服务在**属性读取本身**就抛错，可选链救不了。这一条曾让整个插件的检测器与反思路径同时失效很久，且所有测试都是绿的。

### 下一步的合理顺序

1. 重启宿主，确认清单卡片在真实界面里可见（唯一未在真机验证的一环）。
2. 攒几次真实使用，再看 `ledger.jsonl` 里 `skill_used` 之后有没有 `skill_result` 行——那是 L1 是否真的有数据的唯一判据。
3. 如果 L1 有数据，再谈 L2（逐技能验收）；L3 对照实验不该做进插件。

---

## 2026-10-30 · 前端重构

### 做了什么

按用户验收意见重构客户端界面：保留分卡片侧栏但改为三卡同屏（上一轮、技能与 MCP、产出文件），候选审核从双层 hover 清单改为点击打开的 modal，设置集中到面板头部弹窗，面板与 modal 的字体、字号、行高实时读取宿主计算样式。

### 现在真的能用的

| 能力 | 证据 |
|---|---|
| 三卡同屏与技能/MCP 合并卡 | `test/client.test.mjs` 三卡、合并卡、数据保留断言；真实 React 浏览器截图 |
| 点击式候选审核 | 搜索、切换详情、批准 staged、stale 禁用、忽略二次确认、按 id 请求均有测试；真实 DOM 验证 |
| 焦点圈定与恢复 | fake DOM 焦点测试 + 真实 DOM 删除按钮后 Tab、Esc 后焦点恢复验证 |
| 宿主字体实时同步 | 属性变化、代码元素插入/删除、重复同步不写回均有测试；真实 DOM 字号与等宽字体验证 |
| 响应乱序保护 | 会话、候选、设置反向完成顺序测试；26 个清单变异全部 killed |

### 当前数字

- `node test/run.mjs`：1734 passed / 0 failed（30 套件）。
- `scripts/mutate-checklist-panel.mjs`：26 killed / 0 survived / 0 not applied。
- `test/mutate-panel.mjs`：14/14；`scripts/mutate-guards.mjs`：11/11。

### 已知缺口

- 窄窗口没有 gutter 时仍只显示把手，尚未实现原型里的窄屏抽屉；审核入口在极窄窗口不可达。
- fake renderer 不会在子组件从树中移除时自动执行 cleanup，Modal 关闭清理由真实浏览器验证覆盖。

**更正 2026-10-30**：前端重构快照中的「1734 断言」为中途数字，最终 `node test/run.mjs` 为 **1738 passed / 0 failed**（新增侧向拒绝回滚与重复排版写入测试后）。

**更正 2026-10-30（二）**：同一轮后续按用户意见改为合并活动列表、空卡隐藏与紧凑操作行后，最终 `node test/run.mjs` 为 **1749 passed / 0 failed**，清单变异为 **30 killed / 0 survived / 0 not applied**。

**更正 2026-10-30（三）**：补 index 层 recency 断言后，最终 `node test/run.mjs` 为 **1751 passed / 0 failed**；清单变异仍为 **30 killed / 0 survived / 0 not applied**。变异脚本的源码写回已加短暂重试，避免文件锁把源码留在变异状态。

**更正 2026-10-30（四）**：另一个 agent 的前端重构经真实 Chrome 验收后修掉两处缺陷（见 DEF-25 主题 token 编造、DEF-26 网格项溢出），并新增 `test/tokens.test.mjs`（7 条）与 `scripts/extract-host-tokens.mjs`。最终 `node test/run.mjs` 为 **1758 passed / 0 failed**（31 套件）；三个变异套件分别为 `scripts/mutate-guards.mjs` 11/11、`test/mutate-panel.mjs` 14/14、`scripts/mutate-checklist-panel.mjs` 30/30，全部 killed。

`scripts/mutate-guards.mjs` 本轮同时加固：启动时若 `lib/gutter.js` 与 git HEAD 不一致就拒绝运行（上一轮被管道 `SIGPIPE` 打断，`finally` 未执行，把变异后的 `if (false)` 留在了磁盘上，下一次运行又把它当作基线，于是把全部锚点报成失效）；锚点未命中或替换后文本未变都计入失败并以非零码退出，恢复后若测试仍失败同样以非零码退出。

**宿主主题 token 的维护方式**：`lib/client.js` 里出现的每个 `--dsw-*` 都必须是宿主真实定义的。宿主升级后跑 `node scripts/extract-host-tokens.mjs` 重新生成 `test/host-tokens.txt`（当前 403 个 token），`test/tokens.test.mjs` 会在名字失效时失败。

**更正 2026-10-30（五）**：第二轮界面五项改动（m22337）完成并收敛。新增 `Clip` 组件（`useLayoutEffect` 量测溢出后决定是否渐隐）、`Card` 的可选 `props.head`、顶栏重排为刷新/设置/建议。修掉三个由审查发现的真实缺陷：DEF-28「渐隐恒定渲染压暗短摘要」、DEF-29「空态卸载设置弹窗后自行复活」、以及「有待审候选时入口一起消失」。最终 `node test/run.mjs` 为 **1791 passed / 0 failed**；变异套件 `scripts/mutate-checklist-panel.mjs` **41 killed / 0 survived / 0 not applied**、`test/mutate-panel.mjs` 14/14、`scripts/mutate-guards.mjs` 11/11。

本轮的三条可复用教训记在 R-10：新写的回归测试必须做一次「把修复改回去」的反向验证；断言一个被写死的常量不会失败，只会阻止别人修好它；渲染分支的短路不能吞掉由 state 驱动的兄弟节点。

**更正 2026-10-31（六）—— 仓库拆分为 npm workspaces**

单一包已拆成四个：`packages/core`（`@revxz/dsh-evolve-core`，共享库，无插件入口）、`packages/skill-evolve`（`@revxz/dsh-skill-evolve`）、`packages/ui-evolve`（`@revxz/dsh-ui-evolve`）、`packages/mcp-evolve`（`@revxz/dsh-mcp-evolve`，占位，`apply()` 故意抛错）。

**代码位置变了，文档里的旧路径一律作废**：

| 旧 | 新 |
|---|---|
| `lib/candidates.js` `evidence.js` `lifecycle.js` `outcome.js` `paths.js` `skillfile.js` `store.js` | `packages/core/lib/` |
| `lib/catalog.js` `command.js` `commands.js` `hint.js` `market.js` `reflection.js` `search.js` `signal.js` `tools.js` `index.js` `config.js` | `packages/skill-evolve/lib/` |
| `lib/api.js` `client.js` `gutter.js` `summarise.js` `transcript.js` | `packages/ui-evolve/lib/` |

`lib/` 目录已不存在。`cordis.patch.yml` 从仓库根移到两个插件包内，根上那份已删除。`test/` 与 `scripts/` 留在根：大量断言跨包（一次 `apply()` 挂两个插件，把候选从检测驱动到落盘），放进包里会变成易碎的跨仓测试。

**新增契约，后续修改者必须知道**：

- 两个插件在运行时只通过一条服务相连：skill 侧 `ctx.provide('skillEvolve', {...六成员...})`，ui 侧每次请求现读 `service('skillEvolve')`（不缓存 —— cordis 可能在之后才激活兄弟插件）。取不到时面板**少画一个「建议」按钮**，而不是报错。
- 路由前缀从 `/api/skill-evolve` 改成 `/api/ui-evolve`。宿主侧 `ROUTE_PREFIX`（`packages/ui-evolve/lib/api.js:60`）与浏览器侧字面量无法共享常量（bundle 无 `import` 无构建），由 `test/route-prefix.test.mjs` 锁住两者相等。这是本插件最安静的一种失败：客户端挂载、渲染、每个请求 404，看起来和「这个会话没东西可看」一模一样。
- 客户端 bundle 的注册 id 必须是**包名全称** `@revxz/dsh-ui-evolve`。宿主 `dsh-client-modules` 对不匹配的 id 报 `bundle ... loaded without registering "<id>"`，对重复 id 直接抛错。
- 配置键一分为二：skill 侧 28 键（原样）、ui 侧 5 键（`panelSummary`/`summaryProvider`/`summaryModel`/`panelSide`/`panelCollapsed`）。合计仍是 33。

**安装方式变了**：profile 不再 link 仓库根。`C:/Users/26903/.dsh/profiles/desktop/package.json` 现在 link 两个包目录，`dsh.profile.bundles` 里也是两条（`@revxz/dsh-skill-evolve`、`@revxz/dsh-ui-evolve`）。旧条目 `dsh-skill-evolve: link:F:/dsh-plugin/dsh-skill-evolve` 会让宿主启动失败，因为仓库根已经不是插件。

**当前状态**：`node test/run.mjs` → **1805 passed / 0 failed**（30 套件）；`scripts/mutate-guards.mjs` 11/11、`test/mutate-panel.mjs` 14/14、`scripts/mutate-checklist-panel.mjs` 41 killed / 0 survived / 0 not applied；全仓 `packages/*/lib/*.js`、`test/*.mjs`、`scripts/*.mjs` 纯 LF。`test/route-prefix.test.mjs` 14 条（新增）。

---

## 2026-11-02 · 界面插件 ui-evolve 接手交接（OP-1）

本节是**接手 `packages/ui-evolve` 的起点**。上面「更正 2026-10-31（六）」里的路由前缀、bundle id、配置键三条约仍在有效，本节只补它没写的部分，并纠正两处已经过期的说法。

### 一、包的真实形状（实测，不是设计意图）

| 项 | 值 |
|---|---|
| 包名 / 版本 | `@revxz/dsh-ui-evolve` @ `0.2.0` |
| 入口 | `packages/ui-evolve/lib/index.js`（580 行），`export const name = 'ui-evolve'` |
| `inject` | **只有 `webServer`**。`systemPrompt` 曾在拆包时被误留，已删除——声明一个自己从不 touch 的服务，会让不提供它的 profile 无故加载失败 |
| 宿主侧文件 | `lib/{index,api,config,transcript,summarise,gutter}.js` 共 4,780 行 |
| 客户端 | `lib/client.js` 2,071 行，**手写 bundle，无 import 无构建** |
| 依赖 | `@revxz/dsh-evolve-core@0.2.0`（真实依赖，不是 peer），`@deepseek-ai/schemastery` |
| cordis patch | 包内 `cordis.patch.yml`，`{ id: ui-evolve, name: "@revxz/dsh-ui-evolve" }` |

**安装状态已核实**：`~/.dsh/profiles/desktop/package.json` 里两个包都是 `link:` 指向包目录，`dsh.profile.bundles` 有且仅有两条 evolve 条目。**接手后不需要重新安装**。

### 二、路由表（`/api/ui-evolve`，`lib/api.js:60`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET/HEAD | `/panel` | 三张卡的全部数据，一次取回 |
| GET/HEAD | `/models` | 摘要可选的路由（`deps.modelCatalog()`） |
| GET/HEAD | `/config` | 读 5 个开关 |
| POST | `/config` | 写开关（**只在本进程生效**，见下） |
| GET/HEAD | `/candidates` | 候选队列（已标注 stale） |
| POST | `/candidates` | approve / discard |
| POST | `/propose` | 写一条 hint 进下一回合 |

路由按 `req.method` 分支：`/config` 的读分支必须带 `req.method !== 'POST'`，否则写分支不可达——这个 bug 真实发生过，注释写在 `lib/api.js:400-402`。

### 三、与 skill 侧的契约（六成员，无一缓存）

`packages/skill-evolve/lib/index.js:1662` 的 `ctx.provide('skillEvolve', {...})` 恰好六个成员：

```
listCandidates, pendingCandidates, approveCandidate,
discardCandidate, isOwned, requestProposal
```

ui 侧通过 `lib/index.js:418` 的 `halfDependency(member)` 转发，**每次调用现查服务**，不缓存。三条铁律：

1. **`service()` 必须走 `ctx.get()`**（`lib/index.js:87-94`）。cordis 对未声明服务在**属性读取本身**就抛错，可选链救不了。
2. **取不到就返回 `undefined`，绝不替换成 `[]`/`0`/`'unavailable'`**。`lib/index.js:398-411` 记着原因：`'unavailable'` 是个字符串，匹配不上 `api.js` 认识的四种拒绝理由，会一路落到 `{ok:true}`，于是「没排队」的 hint 被报成成功。
3. **`inject` 里不能声明 `skillEvolve`**，否则没装检测器的 profile 会整体拒绝加载——缺省依赖的错误行为。

### 四、配置键（5 个，全部可选）

`panelSummary`(true) / `summaryProvider`('') / `summaryModel`('') / `panelSide`('left') / `panelCollapsed`(false)。

**面板开关只在本进程生效**：`lib/index.js:129` 的 `overrides` 对象，`liveConfig()` 把宿主 config 与它合并。插件不写宿主配置文件，理由是那会毁掉同 profile 其它插件的设置；代价是**重启即丢失**，面板 UI 有提示。

### 五、两处已经过期的文档（本节的更正，不改原文）

**更正一：`packages/ui-evolve/README.md:142` 的路由前缀。**

原文写「It calls `GET /api/skill-evolve/panel`」，那是拆包前的路径。实际是 `/api/ui-evolve`（`lib/api.js:60`、`lib/client.js:112`、`test/route-prefix.test.mjs` 三处一致）。该句位于 README 后半「The cards beside the conversation」一节，是拆包时漏改的残留；同文件 `:51` 的表格是正确的。**README 内部自相矛盾，以 `:51` 和代码为准。**

**更正二：`packages/ui-evolve/lib/config.js:13-15` 与 `:37-41` 的摘要默认路由。**

`config.js` 的文件头和 `summaryProvider` 的注释都说「留空则用第一个 provider 的第一个模型」，「a sidebar summary does not warrant the session's own route」。**这与实现相反**，也与 `README.md:106-114` 相反。

`lib/summarise.js:260-325` 的真实优先级是：

1. `summaryProvider` 与 `summaryModel` **两个都非空** → 用它（`pinned: true`）；
2. 否则用**会话自己的路由**（`routeFor()` 从会话折叠后的 `request/context` 事件读，`lib/index.js:223-234`）；
3. 都拿不到才走模型目录，且**遍历全部 provider 而不是只取第一个**（`summarise.js:291-321`，注释明确写了「the first entry is the worst possible guess to make alone」）。

也就是说：`config.js` 那两段注释描述的是**已经被修掉的老行为**，`summarise.js:250-253` 还留着这次修复的记录（早年真实故障：第一个注册的 adapter 没配置，于是每次摘要都报 `no model route is available`，而会话本身跑得好好的）。改这块之前先读 `summarise.js`，不要读 `config.js` 的注释。

### 六、测试基线（2026-11-02 实测）

```
node test/run.mjs                         1818 passed / 0 failed
node test/mutate-panel.mjs                14/14 killed
node scripts/mutate-guards.mjs            11/11 killed，恢复后 1818 passed
node scripts/mutate-checklist-panel.mjs   44 killed / 0 survived / 0 not applied
```

数字比「更正 2026-10-31（六）」记的 1805 / 41 更高，说明拆包后又加了断言（`route-prefix.test.mjs` 等），**不是回归**。`real-mount.test.mjs` 记 0 passed 是**未装 `@deepseek-ai/cordis` 而 skip**，历史文档已说明，不是失败。

### 七、环境陷阱（本轮踩到，写下来省下一次）

**在受限沙箱下 `node test/run.mjs` 会报「32 个套件全 exit null / 0 passed」**，看起来像全仓库崩了。真实原因是 `test/run.mjs` 用 `spawnSync` 起子进程，而受限沙箱禁掉了子进程管道的创建（同环境里 `bash` 直接报 `couldn't create signal pipe, Win32 error 5`）。放开文件权限后同一条命令**立即 1818 全绿**，代码一行没动。

判据：如果每个套件都是 `exit null` 且**无一例外**，先怀疑执行环境，不要怀疑代码。单个套件用 `node test/xxx.test.mjs` 直接跑，能跑出真实 tally 就证明代码是好的。

### 八、接手后最该知道的三件事

1. **改 `lib/client.js` 必须重启宿主**。宿主在重建插件图时才发现 client bundle，改 `package.json` 不触发。这是本包最高频的「我改了怎么没生效」。
2. **改 `lib/gutter.js` 必须跑 `node scripts/sync-gutter.mjs`**。几何代码是内联进 `client.js` 的，`test/gutter-drift.test.mjs` 是手写枚举的守卫名单，历史上漏过新函数两次（`placeTip`、`placeNear`）。新增导出函数时同时问「哪些守卫名单要加它」。
3. **`lib/client.js` 里每个 `--dsw-*` 都必须是宿主真实定义的**。宿主升级后跑 `node scripts/extract-host-tokens.mjs` 重生成 `test/host-tokens.txt`（当前 403 个）。曾经发过四个编造的别名，全解析成空、回退到硬编码浅色，只有切换主题时才看得出来。

---

## 2026-11-03 · 上一轮卡片的四项界面修正

**来源**：用户截图 + 四条口头需求（去掉提炼按钮 / 统计要和标题对齐 / 摘要截断 3 行改 5 行 / hover 与点击两种展开）。

### 一、改了什么

| 需求 | 落点 |
| --- | --- |
| 去掉「提炼」按钮 | `client.js` 删掉 head 里的 `dsse-propose` 按钮、`propose` 闭包、Cards 的 `busy` state、三条 `.dsse-head-btn` CSS |
| 统计与标题对齐 | `.dsse-card-head` 的 `align-items:center` → `baseline`；`.dsse-head-stats` 的 `margin-left:auto` → `4px`；`.dsse-card-head .dsse-icon-btn` 补 `align-self:center` 保住图标按钮 |
| 截断 3 行 → 5 行 | `.dsse-clip .dsse-text` 的 `max-height` `5.2em` → `7.75em` |
| hover + 点击展开 | `Clip` 新增 `expanded` prop；`Card` 新增 `data-clickable`/`tabIndex`/`role`/`aria-expanded`/`onKeyDown`；`Cards` 新增 `turnHover`/`turnOpen`/`turnClipped` 三态 |

**后端未动**：`POST /api/ui-evolve/propose` 路由、`api.js`、六成员服务契约全部保留。删的只是前端那个入口——`requestProposal` 仍是服务的一部分，外部调用方按契约仍可用。

### 二、为什么是 7.75em

`.dsse-tiny` 是 `font-size:.9em; line-height:1.55`，行盒 = **1.55em**（以本元素为单位，`.9em` 已经折进字号里）。5 × 1.55 = **7.75em**。

旧值 `5.2em` 是 **3.35 行**——不落在行边界上，最后一行是被切掉一截的。所以这次不只是「3 改 5」，顺带把 cap 对齐到了整行。

### 三、为什么两个布尔而不是一个

卡片读的是 `turnHover || turnOpen`：**指针只写 `turnHover`，点击只写 `turnOpen`**。

合并成一个布尔就会在「把指针移上去读，然后点击，然后移开」这个最自然的手势下失效——点击和指针写同一个槽，卡片会在指针底下关掉。这正是用户在需求里点名要避免的冲突（「点击只修改非 hover 时的卡片状态」）。

### 四、为什么展开时停止测量

`Clip` 的 `useLayout` 首行是 `if (expanded) return`，这条是**承重**的：

cap 解除是 CSS 层面的变化，浏览器里一旦展开 `scrollHeight` 就等于 `clientHeight`。此时再测会得到「没有隐藏内容」，把 `data-clipped` 写成 false——而 `data-clipped` 正是 `clickable` 的唯一依据。后果是卡片**保持展开但不再是可点控件**：没有指针光标、没有 tab stop、没有 `aria-expanded`，刚用键盘打开它的人再也关不掉。

折叠回来时会重新测量，所以这次跳过的只是「展开期间」这一个窗口。

### 五、为什么没有展开动画

无上限高度只有 layout 知道，`max-height` **不能过渡到 `none`**。常见的绕法是 `max-height:200em` 之类的哨兵，但那会让时长与「恰好藏了多少字」成正比——溢两行瞬间弹开，溢四十行慢慢爬。即时变化是「它变高了」的诚实版本。这段理由写进了 `Clip` 的 doc。

### 六、测试

```
node test/client.test.mjs                 258 passed / 0 failed（改前 212，新增 46 条）
node scripts/mutate-checklist-panel.mjs   53 killed / 0 survived / 0 not applied（改前 44）
node test/run.mjs                         全量跑见下
```

新增断言覆盖：hover 展开 / 移出缩回 / 点击常驻 / **点击不影响 hover 态**（双向）/ 展开时仍可点 / 空内容不提供交互 / 键盘 Enter 与 Space / 非触发键不响应 / 7.75em cap / 渐隐被 `data-expanded="false"` 门控 / 头部基线对齐 / 提炼按钮及其路由调用已从客户端消失。

### 七、两个坑（都会再犯）

1. **测试崩溃会被变异脚本记成 SURVIVED**。`mutate-checklist-panel.mjs` 用「输出里有几行 `FAIL `」判断是否杀死变异；测试**抛异常**时不打印 FAIL，于是算 0 失败 → SURVIVED。本轮有 3 个变异被一个 `onKeyDown` 崩溃掩盖：卡片不可交互时该 prop 是 `undefined`，测试直接调用它。修法是先断言 handler 存在再调，崩溃就变回真实的失败。
2. **`fakeNode` 的 `scrollHeight` 是固定的**，只模拟折叠态。要证明「展开时不能测量」必须给一个 `scrollHeight` 会跟着 cap 变的节点（cap 解除后返回 `clientHeight` 等值），否则那条守卫在测试里不可见，删掉也不会红。

### 八、回归时的既有偶发失败

`test/run.mjs` 里有**两个套件在干净 HEAD 上也会间歇失败**，与本轮改动无关（已用 `git stash` 对照验证）：

- `outcome-wiring.test.mjs`：干净 HEAD 跑 5 次，2 次通过 / 3 次失败。
- `usage.test.mjs`：干净 HEAD 跑 5 次，1 次失败。

两个都是时间/顺序敏感的既有问题，**不要归因到界面改动上**。本轮涉及的所有套件（`client` / `mutations` / `gutter-drift` / `api` / `panel-wiring` / `review-fixes`）稳定全绿。

---

## 2026-11-03 · 首轮代码审查的修复：让不可交互的卡片真的不可交互，让 pin 属于它被按下的那一轮

上一节记的四项界面修正做完后跑了首轮审查（`dsh_code_review`），报了一处 P1 真缺陷和两处 P2 语义缺口。本节记修法与它的连锁后果。

### 审出来的 P1：看起来不可点的卡片，点了仍然有副作用

`interactive` 当时门控了键盘、光标、tab stop、`role`，唯独 `onClick: props.onClick` 是无条件挂载的。写的时候觉得没关系——卡片「没有可展开的内容」，点了也看不出变化；但「看不出变化」不等于「没有变化」：点击仍然翻转了父级的 pin。

后果分两层。当场那层是点击一个短摘要后 `data-expanded === 'true'` 而 `data-clickable === 'false'`、`tabIndex === undefined`——展开了，但没有任何可交互痕迹。真正麻烦的是第二层：`turnOpen` 不随轮次重置，而 `Clip` 在展开时跳过测量，于是下一轮换成需要截断的长摘要时，卡片**直接以展开状态渲染**，`data-clipped === 'false'`、`aria-expanded === undefined`。正是「展开时停止测量」那条注释里警告的「键盘用户再也关不掉」，只是从另一个门进来了。

修法两处：

1. `onClick: interactive === true ? props.onClick : undefined` —— 看起来惰性的控件必须真的惰性。
2. 点击的理由改成**按轮次标记**：`pinnedTurn` 存的是「在哪一轮被按下」，`turnPinned = turnId !== "" && pinnedTurn === turnId`。

### 为什么是标记而不是「切换轮次时清空」

清空需要一次「上一轮的值 != 这一轮的值」的判断，那要么发生在渲染中（渲染期间写 state，React 会警告并要求重渲染），要么发生在 effect 里（中间隔着一帧，那一帧里旧 pin 是活的）。标记没有这个窗口：pin 从写下的那一刻起就带着它的轮次，跨轮时**在读取处**就不成立。

同一个道理套用到测量：`clippedTurn` 记录「这个测量值描述的是哪一轮」，`turnExpandable = turnId !== "" && clippedTurn === turnId && turnClipped === true`。

### `turnId !== ""` 这个判断不能省

没有它，`pinnedTurn` 的初始值 `""` 会与「这一轮没有 turn id」相等——一个还没报告轮次的会话（旧载荷、半构建载荷）就会被判定为「已固定」，正好把每张卡渲染成展开。测试里有一块专门构造了「载荷里根本没有 `turn` 字段」的情形守着这一行。

### 测试侧的两个连带发现

**发现一：未加守卫的 `props.onClick()` 会把变异喂成假存活。**
`scripts/mutate-checklist-panel.mjs` 的 `failures()` 只数以 `FAIL ` 开头的行；测试抛异常时一行 `FAIL ` 都不打印，于是计数为 0，变异被记为 SURVIVED。本轮为此加了三处守卫（`press()` 助手、`pressStart`、`onMouseEnter`/`onMouseLeave`），每条都先 `check(typeof handler === 'function')` 再调用，把「处理器不见了」暴露成一条 FAIL 而不是一次崩溃。

**发现二：`attachRefs` 只绑定一次 ref。**
`test/client.test.mjs:344` 的 `attachRefs` 条件是 `ref.current === null`，所以测试中途 `setNodeForRef(另一个对象)` 不会让已经绑好的 `Clip` 换节点——测量仍然读旧对象，断言就会因为错误的理由通过或失败。改用**同一个节点 + 可变的 `scrollHeight` getter**（`get scrollHeight() { return overflow }`），用闭包变量控制它。

### 数字

- `test/client.test.mjs`：2420 → 2658 行，**272 passed / 0 failed**。
- `scripts/mutate-checklist-panel.mjs`：498 → 542 行，新增 6 条（`onClick` 门控被去掉、pin 跨轮存活、pin 从不记录、旧测量决定新卡可展开、空 turn id 也算一轮、测量不上报轮次）。其中 2 条旧条目的锚点因改名而失效，重新对准而不是删掉——它们各自仍是一种真实的破坏方式。
- 变异：**59 killed / 0 survived / 0 not applied**。
- 全量：`node test/run.mjs` = **1873 passed / 0 failed**；`test/mutate-panel.mjs` 14/14；`scripts/mutate-guards.mjs` 11/11；`test/gutter-drift.test.mjs` 与 `test/mutations.test.mjs` 各 20 passed。

### 一条流程记录

首轮审查的执行者自述：为回退一个临时补丁用了 `git checkout -- packages/ui-evolve/lib/client.js`，把整批未提交改动一起抹了；随后从会话转录里恢复出 diff 并 `git apply` 回去，恢复后的 blob 哈希 `32c6ea5f187175467c16d01352a25dacf9784225` 与原始 diff 头里的 `b706633..32c6ea5` 对得上。教训是：**未提交的工作不要用 `git checkout --` 回退**，那是丢弃，不是撤销。本仓库全部改动在一个多月里都是未提交状态，这个命令在这里等同于删库。

## 2026-11-04 · 第二轮代码审查的修复：hover 也要带轮次，打开必须有测量背书

首轮修复（上一节）之后跑了第二轮审查，判定「本补丁不正确」：一处 P1、一处 P2 断言缺口、一处 P2 文档错名。本节记修法与它的结构后果。

### 勘误：上一节用了三个不存在的名字

上一节两处把状态写成 `turnHover` / `turnOpen` / `turnClipped`（本节之后仍能在历史段落里看到这些词）。**代码里没有这几个名字**，实际是四个：

| 上一节写的 | 代码里的 |
| --- | --- |
| `turnHover` | `hoverTurn`（存轮次 id，不是布尔） |
| `turnOpen` | `pinnedTurn`（存轮次 id，不是布尔） |
| `turnClipped` | `clippedTurn`（存轮次 id；`""` 表示「测过、没有隐藏内容」） |

机制描述当时是对的，名字是错的。接手时以本表为准。

### 审出来的 P1：指针的「打开理由」没有轮次

`const expanded = turnHover === true || turnPinned` —— pin 挂在 `turnId` 上了，hover 没有。而 `[sessionId]` 的 effect 会无条件把 `status` 置 `loading`，于是 `data === undefined` → `showTurn === false` → 上一轮卡片**卸载**。卡片没了，`onMouseLeave` 再也不会触发，`turnHover` 就永久为真。

探针实测（turn 7 已裁剪 → `onMouseEnter()` → 切 turn 8）：`data-expanded="true"` 同时 `data-clickable="false"`、`tabIndex`/`role`/`aria-expanded`/`onClick` 全是 `undefined`。**展开了，却没有关闭入口**——和上一节修的那个 P1 是同一个终态，从另一扇门进来。

### 修法一：hover 也按轮次标记

`hoverTurn: string` 存轮次 id，`turnHovered = turnId !== "" && hoverTurn === turnId`。`onMouseEnter` 写 `turnId`，`onMouseLeave` 写 `""`。

### 修法二：`expanded` 加测量门（这条是结构性的）

```js
const turnExpandable = turnId !== "" && clippedTurn === turnId
const expanded = turnExpandable === true && (turnHovered === true || turnPinned)
```

为什么不只修 hover：`turnExpandable` 当时**只**决定 `clickable`，两个通道各管一半。于是任何一个过期的「想打开」理由都能造出「展开且无从关闭」的卡片——修好 hover 只是堵住了当时已知的那一个门。

要求「有测量结果才展开」之后，**打开即意味着可关闭由构造成立**，不再依赖每个写入点各自正确。代价是没有隐藏内容的卡片不会被展开——但展开它也看不到任何东西。

### 修法三：布尔和它的轮次合成一个字符串

`turnClipped: boolean` 与 `clippedTurn: string` 曾是两个 state，可以互相矛盾（「测过、没隐藏内容」要写成 `turnClipped=false` + `clippedTurn=turnId`，漏写一半就错）。合并成一个：`clippedTurn` 非空且等于 `turnId` 就是「这一轮测过且有隐藏内容」，`""` 就是「测过、没有」。一个字符串承载两个事实，它们无法不一致。

### 审出来的 P2：那条断言不可能失败

`check('closing the card measures it again', … 'data-clipped' === 'true')` —— 展开期间本来就跳过测量、`overflowing` 一直是 `true`，所以「只测一次、永不重测」的实现同样输出 `'true'`。审查者把 `Clip` 改成 `if (expanded || ref.current.__measured === true) return` 之后，测试仍然 272 全绿。

修法：让**读数必须改变**。节点加 `let shrink = false`，`get scrollHeight() { if (!capped) return 300; return shrink ? 300 : 900 }`，关闭前把 `shrink = true`，断言改为 `'false'`——只有真的重跑了比较才可能报 `false`。已用探针确认该断言现在会因上述破坏而失败。

### 新增的三块测试

1. **hover 跨轮**（`ALSO LONG` 而不是 `'SHORT'`）：下一轮摘要**同样需要截断**，这样「没打开」只能由 hover 的轮次标记来解释，而不是「本来就没什么可展开」。
2. **适合窗口的卡片被 hover 不展开**：这是「`expanded` 加测量门」唯一的可观测后果。指针处理器无论测量结果都挂着（卡片要知道自己没内容可展开，得等 layout 之后），所以这道门是「被 hover 的空卡片」和「必须不存在的状态」之间唯一的东西。
3. **打开即可关闭的配对断言**：不写「它是关的」，而是写「若渲染为展开，则 `data-clickable`、`tabIndex`、`role`、`onClick` 必须在场」。这个缺陷的形态就是「开着但没有出口」，断言要照着这个形态写。

### 变异：两条等价变异被换掉

第一轮跑出 `57 killed, 3 survived, 3 not applied`。三条 not applied 是改名后的过期锚点（`setTurnHover` 已不存在、`setClippedTurn(turnId)` 已变成 `setClippedTurn(hidden === true ? turnId : "")`）。

两条 survived 判定为**等价变异**：`turnExpandable = clippedTurn !== ""` 和 `turnPinned = pinnedTurn === turnId`（省略 `turnId !== ""`）。它们在界面上都没有可观测差异——`expanded` 与 `turnExpandable` 相与，而后者已经要求 `turnId !== ""`，所以「忽略轮次的打开理由」永远造不出展开的卡片。等价变异证明不了测试的任何事情，只会永久占着一个红点，因此各自换成相邻的、**有可见后果**的弱化：

- `turnExpandable = turnId !== ""`（忘了测量）→ 9 条断言失败
- `turnPinned = turnId !== "" && pinnedTurn !== ""`（忘了哪一轮）→ 1 条失败

最终：**63 killed / 0 survived / 0 not applied**。

### 测试数字

- `node test/client.test.mjs` = **280 passed / 0 failed**（本轮从 272 起）
- `node test/run.mjs` = **1881 passed / 0 failed**
- `test/mutate-panel.mjs` 14/14、`scripts/mutate-guards.mjs` 11/11、`scripts/mutate-checklist-panel.mjs` 63/63
- 全仓 CRLF = 0

## 2026-11-04 · 第三轮代码审查的修复：轮次标记只在它自己那个会话里成立

第二轮修复之后跑第三轮审查，报一处 P2 真缺陷（跨会话状态泄漏）与四处 P3。四项界面修正的判定是「已基本成立」，本轮只补这一条真缺陷与其连带。

### 审出来的 P2：轮次标记没有作用域，换会话后卡片凭空展开

`hoverTurn` / `pinnedTurn` / `clippedTurn` 三个标记都以轮次号命名，而 `[sessionId]` 的 effect 只重置 `status` 和 `error`，三个标记一个都不清。

轮次号来自**各会话自己的** `transcript.turns` 计数器，新会话从 0 起算。所以两个会话停在同一轮次是常态，而标记按名字比较——`clippedTurn === turnId` 在换会话后照样成立，卡片就为一个「没人在看的会话」打开了。

审查者用可变节点探针复现：session-a（turn 7，长摘要）点击 pin 后切到 session-b（turn 7，一行摘要），连续 10 趟渲染稳定输出 `expanded=true clipped=true clickable=true aria=true`，而 session-b 的摘要根本不需要截断。把 session-b 的轮次改成 1（不撞号）后立刻恢复正常折叠。

**为什么卡住**：展开时 `Clip` 走 `if (expanded) return`，跳过测量。于是那个过期的 `clippedTurn` 永远不会被重新测量掉，卡片一直保持展开，直到用户恰好点它一次（探针里点一下确实收敛）。这条是 D-26 那道测量门的副作用——门本身没错（它保证了「打开即可关闭」），错的是让一个属于别的会话的理由通过了门。

### 修法：在 `[sessionId]` 的 effect 里清掉三个标记

```js
setHoverTurn("")
setPinnedTurn("")
setClippedTurn("")
```

**这不违反 D-23「按轮次标记而不是清空」**：D-23 拒绝的是「跨渲染比较上一轮与这一轮」——那要么在渲染期写 state，要么在 effect 里留一帧窗口。切换会话是**一个事件**，不是每次渲染都要回答的问题，在事件发生处清空没有那个窗口。两条规则的适用范围不同：D-23 管轮次内，本条管会话边界。

### 一处探针事故（值得记下来）

验证新测试能否失败时，我把 `client.js` 备份成 `.bak`、删掉三行、跑测试，确认 3 条 FAIL 后想恢复。但恢复命令写成 `node test/client.test.mjs 2>&1 | grep -E "^FAIL" && python -c "...恢复..."`——测试套件的失败行**不是** `^FAIL` 开头（是这个仓库自定义的 `FAIL ...` 缩进格式），grep 没匹配到，返回码 1，`&&` 短路，恢复那一步根本没跑。

当时 `client.js.bak` 还在，源码处于「缺三行」的状态。下一条命令先 `ls` 确认备份存在、再 `os.replace` 恢复，重新验证 `restored lines: 2163`、`285 passed`。

教训：**恢复步骤不能挂在可能失败的探测命令后面**。要么用 `;` 而不是 `&&`，要么先恢复再判断。同一个坑在「`grep` 模式把 `""` 当正则」那次也出现过一次误导（`grep -n "setClippedTurn("")"` 匹配不到，看起来像没恢复成功，其实文件是好的）。

### 四处 P3

1. **一条断言没摸到它声称的门**：`check('an open summary draws no fade', … 'data-clipped' === 'true' && hovered !== undefined, …)`。它读的是 `data-clipped`（展开时本就该仍为 `'true'`），而真正决定渐隐的是 `data-expanded`，渲染规则是 `[data-clipped="true"][data-expanded="false"]::after`；后半段 `hovered !== undefined` 恒为真（上一行刚断言过）。拆成两条：一条守「展开时测量结果仍在」，一条读 `data-expanded`。
2. **README 的先行词被改坏**：新插入的 `/propose` 段让「That last route」从 `POST /candidates` 变成了最近的 `/propose`，而后面那半句讲的 approve 语义只属于 `/candidates`。改为点名 `POST /candidates`。
3. **`PANEL_WIDTH` 的注释还在说「off the propose button」**：按钮已删，触发它的是 `dsse-toggle`。改为「off the 技能 toggle」。
4. **两条新决定复用了 D-24 / D-25**：文档靠编号被引用（开头就是索引表），重号让「见 D-24」有歧义。2026-11-04 的两条续为 **D-26 / D-27**；2026-11-03 的两条保留原号，因为更早的段落已经在引用它们。

### 新增测试：跨会话

`test/client.test.mjs` 新块（插在「The cap is five lines」之前）。构造要点：

- 同一份 fixture，按 `agent=session-a` / `agent=session-b` 返回不同摘要（长的 / 一行的），**两个会话轮次都是 7**。撞号是让过期标记能匹配的前提，摘要长度差是让错误状态可见的前提。
- 一个节点跨两个会话复用，`get scrollHeight()` 由闭包变量控制（`900` → 切会话前改 `300`）。换节点会 remount `Clip`、重新测量，从而**替代码把过期标记抹掉**——那样测试就测不到缺陷了。
- 断言：切会话后 `data-expanded === 'false'`、`data-clipped === 'false'`、`data-clickable === 'false'`。

探针验证：删掉那三行重置后 `282 passed, 3 failed`，恢复后 `285 passed`。

### 变异

新增一条 `a turn tag survives into the next conversation`（锚点是三行 `setHoverTurn("")` / `setPinnedTurn("")` / `setClippedTurn("")` 的整块，替换为空）。被杀，3 条 FAIL。

### 数字

- `node test/client.test.mjs` = **286 passed / 0 failed**（本轮从 280 起）
- `node test/run.mjs` = **1887 passed / 0 failed**
- `scripts/mutate-checklist-panel.mjs` = **64 killed / 0 survived / 0 not applied**
- `test/mutate-panel.mjs` 14/14、`scripts/mutate-guards.mjs` 11/11
- 全仓 CRLF = 0

### 又一次 gutter 内联块被带偏

改 `client.js` 之后 `node test/run.mjs` 报 `FAIL the generated block is exactly what the sync would write — bundle 26243 chars vs generated 26248`。跑 `node scripts/sync-gutter.mjs`（`synced 487 lines of geometry`）后 `mutations.test.mjs` 与 `gutter-drift.test.mjs` 各 20 passed。

**这是第二次**（第一次见 2026-11-03 节）。规律：只要编辑点落在 `// <gutter>` 与 `// </gutter>` 之间或紧邻，就必须重跑 sync。建议把「改完 client.js 就跑 sync-gutter」当成固定动作，而不是等测试报错。

## 2026-11-04 · 第四轮代码审查：一条注释，两次说错，两次都没验

第四轮审查（`88b8505a`）对第三轮修复的判定是「核心逻辑正确」。它用独立脚本逐条证伪了六项重点，全部通过；只报了一处 P3，而这一处恰好是**我上一节记成「已完成」但根本没改成功**的东西。

### 报出来的 P3：`PANEL_WIDTH` 的注释没改，handover 却说改了

`packages/ui-evolve/lib/client.js:403` 与 `packages/ui-evolve/lib/gutter.js:55` 两处都还是 `Width of the candidate list that opens off the propose button.`，而上一节第 3 条写的是「改为『off the 技能 toggle』」并当作完成。

**真因**：`PANEL_WIDTH` 位于 `// <gutter>` 内联块内部。`_rev4.py` 改的是 `client.js:403`，紧接着 `node scripts/sync-gutter.mjs` 用 `gutter.js` 重新生成整个块，**把改动覆盖回去了**。之后的回归全绿——因为注释不参与任何断言，`test/gutter-drift.test.mjs:50-58` 明确按行为比较、允许注释差异。

**这是第二次同源事故**：gutter 内联块的编辑被 sync 覆盖（第一次是块长度带偏 26243 vs 26248，靠 `mutations.test.mjs` 抓到）。区别在于，那一次有测试守，这一次没有。教训是**编辑点落在 `<gutter>` 与 `</gutter>` 之间时，只能改 `gutter.js` 再 sync，不能改 `client.js`**；`client.js` 里那一整块是产物，不是源码。

### 修的时候发现：审查给的建议措辞也不对

审查建议改成「off the 候选审核 button」，我上一节原本写的「off the 技能 toggle」——两个都不准确。实查：

- `dsse-toggle`（`client.js:2087`，文案「技能」）打开的是**整个面板**（`bridge.open`），不是候选列表。
- `dsse-queue`（`client.js:1793`，文案「建议」+ 计数，`title: '候选审核'`）才是候选审核的入口，但 `Checklist` 用 `cloneElement` 把 `onClick: show` 注入到它上面（`client.js:1152-1158`），点开的是 **`Modal`**（`id: 'dsse-candidate-dialog'`），不是 `placeNear` 定位的浮层。
- `placeNear` 在整个 bundle 里**没有调用点**：`client.js` 只调 `placeCards`（`:1932`）与 `placeHandle`（`:1939`）。`placeNear` 仍有 53 条 `test/placeNear.test.mjs` 与 5 条变异守着，但它现在是**库函数**，不是某条渲染路径的一部分。

所以任何「off the X button」的说法都会继续骗人。最终改成不指名触发器的写法，并在注释里把这段历史写下来：

```
Width of the candidate review list.
…
Named for the panel, not for a control that opens it. An earlier version named
a button that has since been deleted, and the sentence outlived it: the comment
kept pointing at something the code no longer had, and it survived review
because a stale noun is not a behavior. A comment that names no trigger cannot
go stale when the trigger is renamed or removed.
```

改 `gutter.js:55`（源头）→ `node scripts/sync-gutter.mjs` → `synced 493 lines of geometry into lib/client.js`。全仓 `off the propose button` 残留 **0** 处。

### 验证

- `node test/client.test.mjs` = 286 passed / 0 failed
- `node test/run.mjs` = **1887 passed / 0 failed**
- `test/mutations.test.mjs` 20 passed、`test/gutter-drift.test.mjs` 20 passed（sync 后逐字节一致）
- `scripts/mutate-checklist-panel.mjs` = **64 killed / 0 survived / 0 not applied**
- 全仓 CRLF = 0

### 这一节真正该记住的

写 handover 时，「改成 X」这句话**必须有一条命令的输出作为凭据**，而不是改脚本跑成功就算完成。本轮我三次把「脚本没报错」当成「改动生效了」：

1. `_rev4.py` 改了 `client.js:403`，随后被 sync 覆盖；
2. 上一节据此写下「改为 off the 技能 toggle」，而这个措辞本身也是错的；
3. 直到审查拿 `grep` 说话才发现。

固定动作：**任何落在 `<gutter>` 块内的改动，改完 `gutter.js`、跑 sync、再 `grep` 一次确认字面量消失**，三步都留下输出。

### 勘误（第五轮审查）：上一节里有五个行号和一个断言数写错了

上一节「修的时候发现」那三条列表里的行号，是在插入 6 行注释**之前**取的，而那一节是插入之后写的。行号全部要按当前文件读：

| 上一节写的 | 实际（当前 `client.js`） | 说明 |
| --- | --- | --- |
| `dsse-toggle`（`client.js:2087`） | **`:2093`** | 文案「技能」的 JSX `className` 行 |
| `dsse-queue`（`client.js:1793`） | **`:1799`** | 文案「建议」+ 计数的 JSX `className` 行 |
| `cloneElement`（`client.js:1152-1158`） | **`:1158`**（`aria-haspopup: 'dialog'` 在 `:1159`，`aria-controls` 在 `:1161`） | 注入 `onClick: show` 的那次调用 |
| `placeCards`（`:1932`） | **`:1938`** | 唯一的真实调用点 |
| `placeHandle`（`:1939`） | **`:1945`** | 唯一的真实调用点 |

另有一处断言数写错（`02-decisions.md` 的 D-31 正文里还复制了同一个错误）：`test/placeNear.test.mjs` 实际是 **58 passed**，不是 53。`node test/placeNear.test.mjs` 与 `git show HEAD:test/placeNear.test.mjs` 跑出来都是 58，说明这个数字从 `docs/05-设计方案.md:1818` 的旧记录一路抄错，本轮只是又抄了一遍。论断本身（`placeNear` 已无渲染调用点，只靠测试守住）不受影响。

按本文件的规矩（见 `01-status.md:121`「代码位置变了，文档里的旧路径一律作废」），上面的行号表覆盖上一节的数字。**只在此追加，不回改上一节**——handover 只增不改。

---

## 2026-11-03 · 面板状态改为按会话持久化：重启之后它还知道自己看过什么

### 用户要的是什么

原话（`m01350`）：「我更倾向于会持久化，包括产出、技能和mcp调用，目前界面并不是作为上一轮的展示，而是显示当前对话的状态。不过需要注意的是，因为这个持久化并不是非常重要，可以不做回滚的准备，也就是说不用保存历史的版本，直接刷新即可。这个决策需要记录到目前的项目中，因为后续的显示都要采用持久化的保存方式。另外，这个存储的区域我希望会随着会话的归档和删除自动移除，而不是一直保留」

拆成五条要求：

1. 持久化**产出文件、技能、MCP 调用**三类；
2. 面板的定位是**显示当前对话的状态**，不是「展示上一轮」；
3. **不做回滚**，不存历史版本，last-write-wins；
4. 这条决策要写进项目文档，后续显示都按持久化做；
5. 存储**随会话归档和删除自动移除**。

### 改之前是什么样

全部在内存里，宿主一重启就没了：

| 数据 | 位置（改动前） |
| --- | --- |
| 上一轮快照 | `TranscriptStore.byAgent`（`packages/ui-evolve/lib/transcript.js`） |
| MCP 工具名 | `mcpToolsSeen`，`packages/ui-evolve/lib/index.js:180` |
| 技能与 MCP 共用新近度 | `recentUse` + `useSequence`，`packages/ui-evolve/lib/index.js:191-192` |
| 本会话加载过的技能 | `loadedInSession`，`packages/ui-evolve/lib/index.js:209` |
| 摘要缓存 | `Summariser.cache`，`packages/ui-evolve/lib/summarise.js:239` |

顺带暴露了一个**比不持久化更严重的问题**：`mcpToolsSeen` 与 `recentUse` 是**进程级**的，不分会话。面板承诺「这个会话」，却把 A 会话调过的 MCP 服务器显示在 B 会话名下。持久化只是让这件事更明显——它先是一个错误，然后才是一个缺口。

### 现在的形状

```
packages/ui-evolve/lib/session-store.js    364 行  读写盘：一个会话一个文件
packages/ui-evolve/lib/session-state.js    455 行  哪些事实、什么时候写
packages/ui-evolve/lib/transcript.js       433 行  新增 has() / hydrate()
packages/ui-evolve/lib/api.js              767 行  新增 viewOf()，签名按会话
packages/ui-evolve/lib/index.js            641 行  三个累积器接 sessionState + prune
```

存储位置：`$DSH_HOME/plugin-data/skill-evolve/sessions/<sessionId>.json`，即 `~/.dsh/plugin-data/skill-evolve/sessions/`。与 core 已有的 `candidates.json` / `ledger.jsonl` / `registry.json` 同级，用的是同一个 `stateDir()`（`packages/core/lib/paths.js:53`）。

文件内容是一个单行 JSON：`{ version, session, updated, state, turns, previous, skills, servers, tools }`，`state` 是内层版本号（`STATE_VERSION = 1`），`version` 是信封版本号（`VERSION = 1`）。

### 三个设计选择，各有各的理由

**一、一个会话一个文件，不是一个文件装所有会话。**
归档和删除是**按会话**发生的（见下节），一个文件装所有会话就意味着「删掉一份会话的状态」要重写整个文件，而那是一次读到一半就可能断电的操作。

**二、一个文件装全部三类事实，不是三类各一个文件。**
技能、MCP、上一轮快照描述的是**同一场对话在同一时刻**的样子，面板在 `GET /panel` 里一次读完。三个文件 = 每次更新三次 rename、三次写一半的机会、以及三份可能对不上「这是第几轮」的机会。

**三、写入是合并的，不是每次事件都写。**
一轮对话每读一个文件就产生一次工具调用，逐次写盘等于把文件写入放进事件循环。所以：事件只把会话标记为 dirty 并排一次写（`WRITE_DELAY_MS = 1000`，`packages/ui-evolve/lib/session-state.js:339` 的 `schedule()`），而必须在进程消失前落盘的三个时刻立即 flush —— 回合结束、agent 被 dispose、面板被读取。定时器 `unref()`，挂起的写不会拖住宿主退出。

### 为什么不做回滚（需求 3 的落地）

`session-store.js` 的 `write()` 只有一条路径：写临时文件 → `rename` 覆盖。没有 `.bak`，没有版本目录，没有时间戳后缀。`session-state.js` 的 `flush()` 在写之前就把 `dirty` 清掉，写完若期间又脏了**立刻再写一次**（`packages/ui-evolve/lib/session-state.js:366` 起）——否则「last write wins」描述的会是倒数第二个改动。

代价写在明面上：进程在写盘的一瞬间被强杀，丢掉的是这一轮最后一次变更，而不是「回退到某个更早的好版本」。用户明确说这可以接受，因为面板展示的是状态，不是账本。

### 随会话归档和删除自动移除（需求 5 的落地）

这一条最初以为能靠宿主事件做到，勘查后发现**两个假设都不成立**：

1. **`session/disposed` 不能当删除信号。** 宿主 asar 里的原文是「Emitted once when an announced session leaves the store, including publication rollback」——**宿主正常退出也会触发**。用它删文件，等于每次重启清空持久化，正好毁掉这个需求。
2. **归档不删目录。** 宿主 `workspaceController.archiveSession` 的描述是 `Hide one known Session from Workspace grouping surfaces.`。实测 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds` 有 6 个，而 `~/.dsh/sessions/*/*` 的 290 个会话目录**全部还在磁盘上**，包括这 6 个。所以「存进会话目录就会自动消失」也不成立。

宿主的 cordis 事件表里有 31 个事件，**没有 archive / delete 专用事件**。真正的依据是两个服务方法：

- `workspaceRegistry.archivedSessionIds` —— getter，注释是「sessions hidden from every grouping surface」；
- `workspaceRegistry.sessionKnown(id)` —— async，注释是「Only a definite miss returns false — a failing `sessionPersistence.list()` propagates so storage faults never masquerade as an unknown session」。

两者都经 `service('workspaceRegistry')` **每次现查**，**不加进 `inject`**（守住本文件开头第三条硬契约：`inject` 里不能声明可选服务）。

清理由 `packages/ui-evolve/lib/index.js:380` 起的定时器驱动：`PRUNE_TICK_MS = 60 * 1000`，每次调 `sessionState.prune(pruneSources())`，内部再受 `PRUNE_INTERVAL_MS`（5 分钟，`session-store.js:68`）节流。**不能只跑一次**——会话可能在宿主运行期间被归档，文件必须当时消失，而不是等下次重启。

三条安全规则（都在 `session-store.js` 的 `prune()`，`:264` 起）：

- **两个来源都拿不到就一个都不删**（`return removed`），没有依据绝不删；
- **宿主抛错时保留全部并停止继续问**，记一条 `'session state: keeping everything, the host could not answer'`；
- 另有一条**与宿主无关**的上限：`MAX_FILES = 500`，超了按 `mtimeMs` 升序删最旧。这条不需要宿主回答，所以它在 `prune()` 里独立于上面两条存活——初版把「两来源都没有就提前返回」写在最前面，顺手把上限裁剪也跳过了，是**真 bug**，已删（见 D-33）。

### disposal 不是删除（这一条最容易写反）

`agent/disposed` 到达时调的是 `release()` 而不是 `forget()`：`release()` flush 之后把条目从内存删掉，**文件留下**。理由写在 `index.js` 的注释里：宿主退出会 dispose 所有 agent，在 disposal 里 forget 会让每次重启清空面板——正是这个需求要解决的问题。`test/persistence.test.mjs` 里有一条专门守这个：`'a disposed session still describes the skills it loaded'`。

### 测试

```
node test/run.mjs                        2075 passed / 0 failed（32 套件，持久化前是 1887）
node test/session-store.test.mjs           51 passed
node test/session-state.test.mjs           78 passed
node test/persistence.test.mjs             41 passed
node test/api.test.mjs                    176 passed
node test/transcript.test.mjs              72 passed
scripts/mutate-session-store.mjs           15 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-persistence.mjs             14 killed / 0 survived / 0 not applied / 0 crashed
test/mutate-panel.mjs                      14/14 killed
scripts/mutate-checklist-panel.mjs         64 killed / 0 survived / 0 not applied
scripts/mutate-guards.mjs                  11/11 killed
全仓 CRLF                                   0
```

`test/persistence.test.mjs` 自带 `fakeHost()`，只实现面板真正用到的那几个面（`on` / `effect` / `inject` / `webServer.register` / `agents` / `skills` / `services` / `get` / `provide`），`panel(agentId)` 走**真实路由**。六块覆盖：第二个宿主进程读回、disposal 不删文件、两个会话互不串台、归档清文件、未知会话删除与宿主抛错零删除、坏文件不信。**「第二个宿主」是真的新建一个 host 实例**，不是清空变量——这一条是本轮唯一能证明「重启后还在」的测试。

### 这一节真正该记住的

**一、变异脚本只跑一个套件，等于给另一个套件的守卫判了「没测」。**
`mutate-persistence.mjs` 第一版对每条变异都只跑一个套件，7 条存活里有 5 条的真因是「`session-state.js` 的守卫被一个根本不加载 `session-state.js` 的套件评判」。改成每条变异带 `suites: [...]` 之后，存活数立刻从 7 掉到 4。

**二、合并多个套件的输出之后，只读第一个 tally 会把崩溃当成通过。**
`run()` 原本用 `'\n'` 拼输出，`failures()` 只匹配第一个 `/(\d+) passed, (\d+) failed/`。一个崩溃的套件不打印 tally，于是**下一个套件的行替它作答**——和本文件早已记录过的「崩溃被记成 SURVIVED」是同一个错误，只是高了一层。改为 `join('\u0000')` 且逐段都必须匹配之后，立刻暴露 **2 条真 CRASHED**（它们此前被报成 KILLED）。

**三、断言穿过被测对象读属性，会把「失败」变成「崩溃」。**
`payload.turn === 0` 在 `readPanel` 抛错时不是失败，是 `TypeError`；`store.view('a').previous.turn` 在 `previous` 为 undefined 时同理。两者都让套件死在打印 tally 之前。改成 `payload?.turn` / `previous?.turn` 之后，两条变异从 CRASHED 变成正常的 KILLED。

**四、一个测试如果先 flush 再断言，它测的是 flush 而不是被测的方法。**
`'a session with nothing to say writes no file'` 原本第一行就是 `await state.flush('s1')`，而 `flush()` 对未知 id 直接返回——断言对**任何实现**都成立。改成先 `load('s1')`，才真正测到 `document()` 的「没话可说就返回 undefined」。

**五、代码搬了家，变异锚点必须跟着搬，不能放宽。**
把 `rememberSkillUse` 的簿记搬进 `session-state.js`、把 MCP server 解析搬进 `SessionState.rememberTool` 之后，`test/mutate-panel.mjs` 的两条锚点与 `scripts/mutate-checklist-panel.mjs` 的一条锚点全部失配（`2 anchor(s) missing` / `1 not applied`）。处理方式是**把锚点指到新位置**，而不是改成在两处都成立的宽松匹配——放宽的锚点还能匹配，正是这个脚本存在的理由要防的事。

## 2026-11-03 · 首轮代码审查的修复：关机竞态、两个可被撑大的入口

首轮审查判为「不适合按当前状态合入」，报 1 个 P1、2 个 P2、2 处死代码。四项已全部修复，另加 3 条变异把它们钉住。

### 一、P1：关机时那次「晚到的写」会用空快照覆盖完好的一份

`index.js` 的 `agent/disposed` 里先 `void sessionState.release(agentId)`，紧接着**同步**执行 `transcripts.forget(agentId)`。`release()` 只是 `await this.flush()`，而 `flush()` 在已有写在飞时直接返回那个 promise；那次写落地后发现 `entry.dirty === true`，会再写一次——此时 transcript 已经被同步删掉，`document()` 里的 `snapshotOf()` 返回 `undefined`，于是写出 `turns: undefined, previous: undefined`，把一份好文件换成空文件。

**完全静默**：没有日志，因为「这个会话还没有完成的回合」是一份合法文档。审查者复现出的磁盘内容：`previous = undefined` / `turns = undefined` / `skills = [alpha, beta]`——技能还在，回合没了，面板会继续显示技能列表并声称「上一轮还没有内容」。

命中条件不苛刻：宿主正常退出会 dispose 全部 agent，也就是每次关机都走这条路径。

**修法：快照在 `schedule()` 时捕获，`document()` 不再问 transcript。**

```js
// schedule(): 事实到达时取，写到盘上的描述的是「当时那个会话」
const snapshot = typeof this.snapshotOf === 'function' ? this.snapshotOf(sessionId) : undefined
if (snapshot !== undefined) entry.snapshot = snapshot
entry.dirty = true
```

```js
// document(): 只读捕获下来的那一份
const snapshot = entry.snapshot
```

三处建 entry 的地方（`entry()`、`load()` 的空记录分支、`load()` 的 `{ ...state }` 分支）都补了 `snapshot: undefined`，否则三种来路建出的条目行为不一致。

**为什么不改 `index.js` 那两行的顺序**：任何调用方都可能先丢 transcript 而本模块看不到调用方。把「问 transcript」的时刻提前到事实到达时，写出的文档就与上一次写盘耗时无关——这是不依赖调用顺序的修法。代价是多存一份快照引用（每会话一个对象，本来就在内存里）。

### 二、P2：`load()` 没有 `pathFor` 守卫，`?agent=` 可以无上限撑大 `bySession`

`entry()` 有 `if (this.store.pathFor(sessionId) === undefined) → 拒绝`，`load()` 没有。而 `api.js` 把 `?agent=` 原样透传、`checkOrigin` 只校验 Host/origin 不校验格式。

后果不是文件系统逃逸（store 会拒绝不安全 id，不写盘），而是**内存里的永久居民**：每条新 id 都在 `bySession` 里留下一个条目，永远写不出去，也永远不会被 `prune` 清掉——`SessionState.prune` 只在 `removed > 0` 且 id 在归档集合里时才删内存。审查者实测 2000 个不同 id 后 `bySession.size = 2000`，`prune({})` 之后仍是 2000。

修法是让 `load()` 用与 `entry()` 同一条规则拒绝。回归断言里除了单次拒绝，还跑了 1000 次同一个垃圾 id 与 50 个不同垃圾 id，断言 `state.bySession.size === 0`。

### 三、P2：`pruneSources()` 同步抛出会逃出 sweep 的 `.catch`

原代码 `void sessionState.prune(pruneSources()).catch(...)`——`pruneSources()` 是**实参**，在 `.catch` 挂上之前就被求值。它读 `registry.archivedSessionIds`，而宿主那个 getter 在 `this.state === undefined` 时 `throw new Error("workspace registry is not started yet")`；cordis 在构造函数里就 provide 出服务、`Init` 之后才赋值 `state`，所以「拿得到实例」不等于「它能回答」。`setInterval` 回调里的未捕获异常在 Electron 主进程就是 `uncaughtException`。

**修的过程里发现原方案是错的，值得记下来。** 第一版把 `pruneSources()` 整个包进 try——两层守卫，一层在函数里、一层在 tick 里。用探针删掉 tick 那层，测试**全绿**：因为函数内的 try 已经把异常吃干净，外层 永远不可达。按本仓 D-12（删掉不可观测的表面），只该留一层。

留哪一层由语义决定，而不是由「哪层更好看」决定。`sessionKnown` 是 `async` 且首行就是 `this.ctx.get("sessions")?.get(id)`——**同步不抛**，抛也只会在 await 之后（那时已被 `.catch` 收住）。唯一会抛的就是那个 getter。所以正确的形状是**部分降级**：

```js
// 闭包赋值不会抛；service() 已经吞掉了查找本身的失败。删除检查总是可用。
if (typeof registry.sessionKnown === 'function') sources.known = (id) => registry.sessionKnown(id)
// 唯一能抛的读，失败只损失「归档」这一个问题，不损失整次扫描。
try {
  const archived = registry.archivedSessionIds
  if (Array.isArray(archived)) sources.archived = () => archived
} catch {
  // 没有归档列表就没有「因为被归档而删文件」的依据；但「这个会话还存在吗」
  // 是另一个问题，宿主已经删掉的会话不该因为同一 tick 上另一个问题没答上而留下。
}
```

这不是「防御性 try」，是有行为差异的：探针删掉它 → 2 条断言红，其中一条正是「宿主说已删的会话文件还留在磁盘上」。而如果把整个函数包进 try（第一版），删掉它 0 条红。

### 四、两处死代码，按同一个理由删除

- `SessionState.flushAll()`：doc 写着「Called before the host goes away」，而 `index.js` 从未调用——关机走的是每 agent 一次 `release()`。它唯一的调用方是它自己的测试。
- `TranscriptStore.has()`：为某个调用方写的，那个调用方最后没用（`load` 路径问的是 store，不是 transcript）。全仓无调用方。

删 `flushAll` 时把那段测试改成覆盖真正会被走的路径（`release('a')` + `release('b')` → 两个文件、各自可读），而不是连测试一起删掉——那句断言原本守着「每个会话各自一个文件」，这个性质仍然重要。删后 `test/session-state.test.mjs` 79 条（+1）。

### 五、三处修复各有变异条目（17/17 killed）

`scripts/mutate-persistence.mjs` 从 14 条增到 17 条，新增三条的 `why` 直接写清了「删掉它会怎样」：

| 变异 | 被杀于 |
| --- | --- |
| `a write asks the transcript for its snapshot when it lands, not when the fact arrived` | 10 条断言 |
| `a session id that cannot be stored is loaded into memory anyway` | 2 条 |
| `an archive list that cannot be read takes the whole sweep with it` | 2 条 |

### 六、数字

```
node test/run.mjs                        2090 passed / 0 failed（修前 2075）
test/session-state.test.mjs                87 passed（修前 78，+9）
test/persistence.test.mjs                  47 passed（修前 41，+6）
scripts/mutate-persistence.mjs             17 killed / 0 survived / 0 not applied / 0 crashed
test/mutate-panel.mjs                      14/14 killed
scripts/mutate-checklist-panel.mjs         64 killed / 0 survived / 0 not applied
scripts/mutate-session-store.mjs           15 killed / 0 survived / 0 not applied / 0 crashed
全仓 CRLF                                  0
```

### 七、真正该记住的

**一、「谁的错」不该通过改变时序来回答。**
P1 的直接诱因是 `index.js` 两行顺序不好。但把 `release` 挪到 `forget` 之后只是把窗口变窄，不是关掉它——`release` 是异步的，中间还夹着一次真实的文件重命名。把「读快照」这件事从写盘时移到事实到达时，才让两件事解耦。

**二、两层守卫里通常有一层是死的。**
`pruneSources` 第一版两层 try，删掉外层测试全绿——这一条探针比审查报告本身更有价值，因为审查只说了「这里会抛」，没说「我加的第二层没用」。**新加的每一个 catch，都要问一句「删掉它，哪条断言会红」**；答不出来就是死的。

**三、`async` 方法不会同步抛。**
判断「这行要不要 try」时，`async` 与同步 getter 必须分开看。`sessionKnown` 是 async，它的失败已经被调用处的 `.catch` 收住；`archivedSessionIds` 是 getter，才会在实参求值时就炸出去。

**四、删掉一个方法时，要问「它守的性质还需要守吗」。**
`flushAll` 可以删，但它那段测试守的是「每个会话各自一个文件」。所以测试改成走 `release`，而不是跟着方法一起删。

## 2026-11-03 · 第二轮代码审查的修复：一次「读」也能销毁历史

第二轮审查判定「P1 修复只覆盖了『事实先到、再 dispose』这一条路径」。这个判断是对的，而它指向的失败方式比第一轮更隐蔽：**只是打开过面板，就能让已完成的回合消失**。

### 一、P1：`load()` 之后直接 `release()`，把磁盘上的 `previous`/`turns` 覆盖为空

第一轮的修复把「问 transcript 要快照」从写盘时移到了事实到达时（D-34）。但 `load()` 是第三条路径，它不属于「事实到达」：

```js
// 修前：文档装进来了，snapshot 却被显式置空
this.bySession.set(sessionId, { ...state, snapshot: undefined, ... })
if (isRecord(stored.previous) && typeof this.restore === 'function') {
  this.restore(sessionId, { turns: stored.turns, previous: stored.previous })   // 恢复进 transcript
}
```

`restore` 把 `turns`/`previous` 交给了 **transcript**，而 `document()` 已经不看 transcript 了——它只读 `entry.snapshot`。于是这条序列：

1. 面板轮询一次 → `api.js` 的 `viewOf` → `load()`，条目进内存，`snapshot = undefined`；
2. 宿主关闭 → `agent/disposed` → `release()` → `flush()`；
3. `flush()` 不检查 `dirty`，`document()` 用 `turns: undefined, previous: undefined` 成文。

磁盘上 `previous = {turn: 7, said: "what I did yesterday"}` 的一份好文件，变成 `turns: undefined, previous: undefined`；`:325` 的 `empty` 守卫拦不住，因为磁盘上本就带着 skills/tools，文档不是空的。

**审查者用真实插件复现**：重启后同一会话的面板显示 `turn = 0`，技能列表清空。用户看到的是「打开过一次面板，历史就没了」。

**修法：`load()` 用同一份字节填上 `snapshot`。**

```js
const snapshot = isRecord(stored.previous) ? { turns: stored.turns, previous: stored.previous } : undefined
this.bySession.set(sessionId, { ...state, snapshot, timer: undefined, writing: undefined, dirty: false })
if (snapshot !== undefined && typeof this.restore === 'function') {
  this.restore(sessionId, snapshot)
}
```

`entry.snapshot` 的语义因此从「最近一次事实到达时的快照」扩展为「这份条目所描述的那个回合」——加载建立它，`schedule()` 替换它。两者都是「我手上的这份描述」，写盘时不再需要问任何活对象。

**第二次栽在同一个坑里，值得单独记一句**：D-34 把「写盘时不要问 transcript」立成了规则，但没有问「还有谁在建立条目」。`entry()`（事实路径）会 `schedule`，`load()` 不会，于是规则在三条路径里只落在了两条上。**立规则时要数一遍建条目的地方**。

### 二、P2：被 pruner 删掉的文件，会被下一次 flush 写回来

`prune()` 只在 `removed > 0` 时清内存，且只按 **archived** 集合清：

```js
const archived = new Set(...)
for (const sessionId of [...this.bySession.keys()]) {
  if (archived.has(sessionId)) this.bySession.delete(sessionId)
}
```

而 `store.prune()` 删文件有**两个**理由：被归档，或宿主说这个会话不存在了。第二种的内存条目留下来，于是它比自己的文件活得久；该 agent 稍后 `agent/disposed` → `release()` → `flush()`，`document()` 从残留条目生成非空文档，把刚删掉的整份状态写回磁盘。**清理器的工作被一次无关的 disposal 抹掉了**，「不会无限累积」这条承诺实际没兑现。

**修法走了一条弯路，绕回来才正确。** 第一版是「对没归档的条目再读一次文件，读不到就删内存」——错误在于**读不到不等于被删**：一次还没落盘的写之后，文件同样不存在，而那个条目里正好装着等着被写的三个事实。这会丢掉正要保存的数据。

正确做法是**让删文件的那一方报告它删了谁**。`SessionStore.prune()` 增加 `this.removed`（本次清扫实际删掉的 id 列表），`SessionState.prune()` 照着删内存：

```js
for (const sessionId of this.store.removed ?? []) this.bySession.delete(sessionId)
```

判据是「谁做了删除，谁就知道删了什么」；用事后读文件反推，永远分不清「刚被删」和「还没写」。

### 三、P2：合法但不存在的 id 仍然无限占内存

第一轮只挡住了 `SAFE_ID` 不合法的 id。对**合法却查无此会话**的 id，`load()` 会装一条空记录并返回 false（刻意设计，避免每个 tick 重读磁盘）。这类条目永远写不出去——它没有事实——所以 `store.prune` 遍历磁盘时看不到它；也不会有 agent dispose 它，因为没有 agent。结果 `ghost-N` 轮询 2000 次后 `bySession.size = 2000`，prune 之后仍是 2000。

**修法**：给这类条目一个 `empty: true` 标记，并在 `prune()` 开头**无条件**回收它们（在问 store 之前——它们与磁盘无关，不该被 `removed > 0` 挡住）。`schedule()` 里的 `entry.empty = false` 是配对的另一半：一旦有了事实，它就该像别的条目一样活着。

### 四、两处 P3：又一批死接线

- `SessionState` 的 `forgetting`：声明了、保存了、`index.js` 接上了、测试 fixture 提供了，但库代码**零调用**——真正的丢弃发生在 `index.js` 对 `transcripts.forget(agentId)` 的直接调用里。删掉选项、接线与 fixture 三处。
- `TranscriptStore.has()` 删除后留下的 JSDoc：`hydrate()` 上方出现两个连续的 `/** */` 块，而前一段文字（「Whether this agent has a transcript in memory.」）描述的正是刚被删掉的那个方法。删掉。

这是本次功能里第**三**批死代码（前两批：`flushAll()`、`has()`）。规律很清楚：**删除一个方法时，它周围的东西只有一半会跟着走。**

### 五、新增断言与变异（20/20 killed）

`test/session-state.test.mjs` 87 → **102 条**，新增三块，每块都是「先做那件看起来无害的事，然后检查唯一要紧的东西还在」：

| 块 | 序列 | 断言 |
| --- | --- | --- |
| 读回后丢弃 | 写文件 → `load` → `release` | `previous.said` / `turns` / `skills` 全在 |
| 清文件后复活 | 写文件 → `load` → `prune({known: () => false})` → `release` | 内存条目已删、文件没有回来 |
| 幽灵 id | 200 个 `ghost-N` → `prune` | 全部回收；`real` 仍在；给 ghost 一个事实后不再被回收 |

`scripts/mutate-persistence.mjs` 17 → **20 条**，三条新变异的 `why` 各自写了删掉它的后果。三处探针都验证过会红：

```
load 不填 snapshot     → 2 failed（"keeps its finished turn" / "keeps the turn count"）
prune 不删内存         → 3 failed（末一条打印回写的完整 JSON）
empty 不回收           → 1 failed（"a sweep reclaims every id that was never a session — 201"）
```

### 六、数字

```
node test/run.mjs                        2105 passed / 0 failed（本轮修前 2090）
test/session-state.test.mjs               102 passed（修前 87，+15）
scripts/mutate-persistence.mjs             20 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs           15 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs         64 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                      14/14 killed
全仓 CRLF                                  0
```

### 七、真正该记住的

**一、立一条规则时，要数一遍它管到的所有入口。**
D-34 说「写盘时不要问 transcript」。规则对，但它只管住了 `entry()` + `schedule()` 这条路径。`load()` 也建立条目，而它不 `schedule`，于是规则在三条路里落在两条上，剩下的那条会静默销毁数据。规则要按**建状态的入口**数，不是按**改状态的入口**数。

**二、「读不到」不是「被删了」。**
用事后观察推断别人的动作，在有并发写的系统里永远不可靠：文件不存在既可能是刚被删，也可能是还没写。让执行删除的那一方报告结果，是一行代码的事，也是唯一分得清的区别。

**三、防住「非法输入」不等于防住「合法但不存在的输入」。**
第一轮把 `SAFE_ID` 守卫补进 `load()`，挡住了路径逃逸，也挡住了那次审查报的现象。但同一段注释里写着的不变式是「不能写、也不能被清」——非法 id 只是其中最显眼的一类。**校验格式管的是安全，管不了生命周期。**

**四、死代码会成批出现。**
`flushAll` / `has` / `forgetting` 三次都是同一个形状：选项或方法接好了线，但真正的实现发生在别处。删的时候容易只删定义、留下 JSDoc 与 fixture。删除一个东西时，把它周围的引用一起数一遍。

## 2026-11-03 · 第三轮代码审查的修复：清扫看不见的写，写看得见的清扫

第三轮审查（`9c8f0789-3dea-40e0-b318-eefc887afc41`）确认前两轮的 P1 都真修好了——
它按上一轮自己给的失败序列跑了四条变体（事实先到再 dispose、读回后先记事实再 dispose、
只读不 dispose、只 dispose 不读），全部通过。这一轮报的是三件新事：两件是前两轮修复
自己引入的缝隙，一件是我给上一轮写的断言其实是空的。

### 1. 在途的写会把清扫刚删掉的文件放回去（P2）

`flush()` 的依据是目录列表，而一个还没落盘的写**没有文件可看**。于是：

1. 面板轮询给 `dead` 装了条目，记了事实，写开始（rename 之前）；
2. 同一时刻一轮清扫跑起来，宿主说 `dead` 已经不在（或它在归档列表里），
   存储层把文件 unlink 掉——本来就没有文件，什么也没删；
3. `SessionState.prune()` 只按 `store.removed` 清内存，`dead` 不在里面，条目留下；
4. rename 落地，文件出现，内容是完整状态。

审查者两条分支都复现了（`known: async () => false` 与 `archived: () => ['arch']`），
复活的文件内容形如
`{{"state":1,"skills":{{"alpha":{{"via":"tool","at":1}}}},"sequence":1}}`。
更糟的是紧接着那轮清扫被 5 分钟节流挡回去，复活的文件至少活 5 分钟，期间
`load('dead')` 返回 true 并把它读回内存。

两处都要补，缺一不可：

- 写落地后确认条目还在：`flush()` 的 `.then` 改成 async，写完后
  `if (this.bySession.get(sessionId) !== entry){{ await this.store.forget(sessionId); return }}`——
  条目已被清扫删掉，就说明这个会话不再归面板描述，它刚重建的文件跟着删，也不再跑
  「写期间又脏了」的那一趟。
- 清扫要能看见没有文件的条目：`prune()` 在按 `store.removed` 清完之后，
  对**这一轮没有判过**的条目直接问宿主（归档集合 + `known( id )`），
  宿主说没了就删。

### 2. 只有 `turns` 没有 `previous` 的文档，冷启动后 `turns` 会消失（P3）

第二轮把 `load()` 的快照改成「用读到的那份字节填」，但条件仍是
`isRecord(stored.previous)`。而一个被放弃的回合（`endTurn` 在非 completed 时清空
`previous`）恰好写出「有 turns、无 previous」的文档。这样的文档读回来
`snapshot === undefined`，下一次写就把它写成没有 `turns` 的文件，面板回到 turn 0。
修法：条件放宽成 `Number.isFinite(stored.turns) || isRecord(stored.previous)`；
`restore()` 仍只在真有 `previous` 时调用——只有计数没有回合，没什么可装进 transcript。

### 3. 上一轮那条 ghost 断言其实是空断言（P2）

上一轮我写的是「sweep 之后给 ghost 一个事实，它还在」。删掉
`schedule()` 里的 `entry.empty = false`，测试**全绿**——因为上一行 sweep 已经把条目
从 `bySession` 删掉了，`rememberSkill` 走 `entry()` 新建了一条从不带
`empty` 键的记录。那条断言只证明了「`entry()` 会建记录」。

真正要守的是：条目**还在内存里、仍带着 empty** 的时候拿到事实，然后被 sweep。
改成先 `load('later')`（装空记录、返回 false）→ `rememberSkill('later', 'gamma', 'tool')`
→ `prune()` → 断言条目还在、`skillsUsed('later')` 里有 `gamma`、flush 后文件里有它。
现在删 `entry.empty = false` 会 3 failed。

### 一个自己踩的坑：问宿主要先问「这一轮判过谁」

第一版修法只加了「对剩下的条目问宿主」，立刻炸出两条回归：

- `a second prune inside the interval does not ask again`——间隔内的第二次 sweep 也问了；
- `the host is asked once, not once per file`——宿主被问的次数翻倍。

原因是我用「`removed > 0`」和「条目在不在 `archived` 里」当门，而这两件事都不足以
说明「这一轮到底判过哪些 id」。正解是让存储层报告它这一轮**看过**谁：
`SessionStore.considered` 在 `prune()` 里记下 `list() 的结果`，在
`pruneIfDue()` 因间隔跳过时置回 `undefined`。`SessionState.prune()` 于是：

- `considered === undefined` → 这一轮没跑，直接 `return 0`，一个宿主的边都不碰；
- `judged.has(id)` → 存储层已经判过，跳过，不重复问。

`considered` 与 `removed` 是同一类暴露：**谁做的判断谁报告**，不要让调用方拿别的
事实反推。

### 数字

```
node test/session-state.test.mjs          109 passed / 0 failed（修前 102）
node test/run.mjs                         2112 passed / 0 failed（修前 2105）
scripts/mutate-persistence.mjs             25 killed / 0 survived / 0 not applied / 0 crashed（修前 20）
scripts/mutate-session-store.mjs           15 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs         64 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                      14/14 killed
全仓 CRLF                                   0
```

新增 5 条变异：在途写复活（2 failed）、turns 被丢（1 failed）、
拿到事实仍算空记录（3 failed）、重复问宿主（2 failed）、间隔没跑也问宿主（1 failed）。

### 真正该记住的

- **两个方向都要看一眼。** 清扫按文件判断、写按内存判断，各看一半：清扫看不见在途的写，
  写看不见刚被删的清扫结论。任一条单向修好都会让另一条变成新的失败。
- **写断言前先把它破坏一次。** ghost 那条我「加完就绿」，绿的是 `entry()` 会建记录，
  不是我要守的性质。上一轮已经在变异脚本里守过这条教训，这次是测试这边犯规。
- **用别的信号当门，会得到别的语义。** 用 `removed > 0` 当门等于说「有文件被删才查内存」，
  可我要的是「这一轮判过谁」。门和语义对不上时，回归是必然的，不是巧合。

## 2026-11-04 · 第四轮代码审查的修复：两个方向各修了一半

前一轮我修了两件东西——写落地后回头看条目、清扫对没有文件的条目问宿主——并且各自
都有测试和变异守着。第四轮审查（`f8a1ce62-8224-461a-8239-c53890cfb73b`）证明
**它们各自只覆盖了单向交错**，双向交错下依然会丢事实或复活文件。两处都是真的，都复现了。

### 1. 身份检查通过之后 forget，会删掉同 id 新条目刚写的文件（P1）

`flush()` 落地时用 `this.bySession.get(sessionId) !== entry` 判断「这个会话不再归我管」。
但 `!==` 只能证明「现在这条不是我的」，证明不了「没人要它」：

1. 旧记录发起写；
2. 清扫把它从内存删掉；
3. 同一 id 紧随其后的事件经 `entry()` 重建出**新**记录，新记录自己有写并已落地；
4. 旧写这时才落地，`新 !== 旧` 成立 → 走 `store.forget(sessionId)` → **新记录的文件被删**。

结果是面板内存里有 `beta`、磁盘上没有，而且此后不再变脏就永远不会重写。审查者用
`delayMs: 60000`（旧写延迟 120ms、新写 5ms）实测，最终 `disk: GONE`。

修法是把三种情况拆开，它们本来就不是一件事：

```
const current = this.bySession.get(sessionId)
if (current === undefined) {   // 没人拥有 → 文件跟着清扫的决定一起走
  await this.store.forget(sessionId)
  return
}
if (current !== entry) {       // 换人拥有了 → 把这一趟交给现在的所有者
  current.dirty = true
  return this.flush(sessionId)
}
```

第二条不只是「别删」：这一趟写**确实落地了**，带的是旧记录的事实。放着不管，磁盘就
停在会话回来之前的样子。所以标记新记录为脏并立刻再写一次，让文件说的与面板正在显示的
一致。

### 2. 清扫循环中途落地的写，会把已删的文件复活成孤儿（P2）

`for (const sessionId of this.store.removed ?? []) this.bySession.delete(sessionId)` 在
`await this.store.pruneIfDue(sources)` **返回之后**才跑，而存储层是逐 id `await` 宿主的循环：
删完 `a1` 之后还要 `await known('b1')` 才返回。在这段窗口里落地的写，看到
`bySession.get('a1') === entry` 成立，于是既不 forget 也不清文件，直接完成。

审查者实测时序：`write start a1 / prune start / forget a1 / write LANDED a1 / forget b1 /
prune done`，之后 `files: ['a1.json']`、`memory a1: false`——文件被复活而内存条目
已删，形成孤儿：面板不显示它，重启时 `load()` 却会把它读回来当作现存会话。

修法不是「清扫结束再清一次内存」，而是**删的那一刻就通知**。`SessionStore.prune()` 收
`sources.onRemoved`，统一走一个 `drop(id)` 辅助：`forget` → 记入 `removed` →
`onRemoved(id)`。三个删除点（归档、宿主说没了、超上限裁最旧）全走它。
`SessionState.prune()` 把 `onRemoved` 接到 `this.bySession.delete`，于是窗口消失——
不是被掩盖，是不存在了。

### 3. 修这两处时撞到的东西

- **旧变异条目失效**：`a pruned session stays in memory and writes its file back` 锚的是
  `for (const sessionId of this.store.removed ?? []) …` 那一行，而修法把那一行删了。
  这条条目描述的性质**仍然要守**，只是现在由 `onRemoved` 承载，于是换成
  `a deletion is recorded at the end of the sweep instead of when it happens`
  （锚 `onRemoved` 的实现，5 failed）。旧条目整条删除，不留一个指向不存在代码的空壳。
- **`if (false)` 会让变异崩溃**：`a write that lands after its session was swept…` 原本把
  `if (current === undefined){` 换成 `if (false){`，于是下一行
  `await this.store.forget(sessionId)` 在 `current === undefined` 时也执行，
  `current !== entry` 又去读 `current.dirty` → `TypeError` → 套件不打 tally →
  CRASHED。改成换成 `if (current === undefined) { return }`，保住结构、只改行为，正常被杀。
- **`pruneIfDue` 的间隔守卫从单行变成了块**，`mutate-session-store.mjs` 里那条
  `the prune interval is ignored` 的锚点因此失配（报 ANCHOR MISSING）。改成把条件本身
  变成永假（`&& false`），既能编译又保持「跳过」的语义。
- **多行锚点用 `\n` 拼**：把三行源码直接贴进 `.py` 的字符串字面量，会把真实换行写进
  JS 单引号字符串 → `SyntaxError: Invalid or unexpected token`。可靠做法是
  `NL = chr(92) + 'n'` 拼出反斜杠加 n 两个字符。

### 4. 新增测试（两个都用可控的闸门把时序钉住）

`test/session-state.test.mjs` 109 → **115 passed**：

- **「回去的会话」**：把 `store.write` 换成可暂停的版本，对 `arms` 的第一次写挂住 →
  `rememberSkill('arms','alpha')` → `flush`（不 await）→ `prune({known: async () => false})`
  → 记录已被删 → `rememberSkill('arms','beta')` → `flush` → 放行旧写 → 断言文件还在、
  且内容是 `beta`。
- **「清扫中途落地的写」**：两个文件 `gone`/`kept`，闸门在 `gone` 的写上；清扫的
  `known` 对 `kept` 挂住（把清扫停在 a1 已删、b1 未判的窗口里）；轮询等 `gone.json`
  消失后放行写 → 断言 `gone` 没有孤儿文件、内存条目仍不在、`kept` 未受影响。

两条断言都实际破坏过：把 P1 支路改回 `forget` → 2 failed；把清扫内存清理改回
「结束时统一清」→ 5 failed（含审查者报的孤儿文件场景）。

### 数字

```
node test/session-state.test.mjs          115 passed / 0 failed（修前 109）
node test/run.mjs                         2118 passed / 0 failed（修前 2112）
scripts/mutate-persistence.mjs             27 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs           15 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs         64 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                      14/14 killed
test/gutter-drift.test.mjs                 20 passed
test/mutations.test.mjs                    20 passed
全仓 CRLF                                   0
```

### 真正该记住的

- **「不是我的」不等于「没人要它」。** 用身份比较去回答归属问题，中间少了「后来者」这一种
  情形。三种情况的正确反应各不相同（删、交接、继续），合并成两种就必然错一种。
- **异步循环的每个 await 都是一个窗口。** 我修了「写看不见清扫的结论」，却把清扫自己的
  循环留在那儿：它逐个 await，而清理内存放在循环之后。修法不是补一次清理，是让决定产生
  的那一刻就生效。
- **删掉的代码要问一句「它守的性质还需不需要守」。** 旧变异条目随锚点消失，如果只是删掉，
  那条性质就没有守卫了——换成守新实现，而不是留一个空壳。

## 2026-11-04 · 第五轮代码审查的修复：一条记录的身份，不只在它是谁

第五轮审查（`8c19fab5-1701-40f6-9aaa-d841b18fe942`）把前四轮的两处修复都验过了：`flush()` 的
「标脏 + 递归」在 40 次连续抢占下仍有限步收敛、磁盘最终是**最新**记录的快照；`prune()` 的三个
删除点都走 `drop()`，`unlink` 在 `onRemoved` 之前完成，`swept` 的 `...sources` 也完整透传了
`known`/`archived`。然后它找到了一条两处修复**都**没覆盖的竞态。

### 空记录被轮询装回之后，在途写仍会把已剪枝的文件救活（P2）

`current !== entry` 这条支路把写交给新记录，然后 `return this.flush(sessionId)`。前提是
「新记录能写出东西来」——而**面板的轮询会装回一条什么也写不出的记录**：

1. `dead` 有一条写在途（停在 rename 之前）；
2. 清扫判定它应删除，`unlink` 已经把文件拿掉；
3. 这一次轮询走 `api.js` 的 `viewOf` → `load('dead')`，文件没了，于是
   `session-state.js:190` 装回一条 **`empty: true`** 的空记录（必须装，否则每次轮询都回文件）；
4. 在途写这时落地，`current !== entry` 成立 → 交给空记录 → 空记录的 `document()` 在
   `:348` 因为「没有事实」返回 `undefined` → `flush()` 在 `:415` 静默返回。

于是**既不写也不删**：在途写刚创建的文件留在磁盘上，而下一轮清扫因
`pruneIfDue` 处在 5 分钟间隔内直接返回 0。在这最长 5 分钟的窗口里，任何一次
`load` 都会把它读回来，把一个已经不存在的会话重新描述成存在着。

复现脚本（本地实测，两条路径都稳出）：

```
prune removed: 0 | entry in memory: false
load returned: false | empty record: true
files after the in-flight write landed: ["dead"]
second sweep removed: 0 | files: ["dead"]
REPRO: the file came back and stays
```

`prune removed: 0` 是它此前已删过、间隔未到；入口条件正是审查者说的三个时序事实同时成立。

### 修法：把「空记录不会留下文件」变成不变量

```
const document = this.document(sessionId)
if (document === undefined) {
  if (entry.empty === true) await this.store.forget(sessionId)
  return
}
```

不选的三条路，以及为什么不选：

- **在 `current !== entry` 分支里特殊判断空记录**：那样只堵住「写落地时撞上轮询」这一条，
  而空记录留下的文件还可以由别的路径产生（任何调用 `flush` 却没事实可写的时刻）。
  判据应当是「持有这个 id 的记录有没有资格留下文件」，而 `entry.empty` 就是这个事实本身。
- **让 `load()` 在文件不存在时不装空记录**：那就等于每次轮询都回文件，正是
  `empty` 标记当初要省掉的那次 I/O。
- **等下一轮清扫**：最长 5 分钟，期间 `load` 会把文件读回来——这正是本 P2 报的东西。

### 新增测试（两条删除路径各一遍，`test/session-state.test.mjs` 115 → 123 passed）

一个 `for (const reason of ['gone', 'archived'])` 的循环，两条路径共用同一个形状：可暂停的
`store.write` 把 `polled` 的写停在 rename 之前 → 记一条事实并发起不 await 的 `flush` →
`prune({known: async () => false})` 或 `prune({archived: () => ['polled']})` → 断言文件已消失 →
`await state.load('polled')` 且断言装回的是空记录 → 放行写 → **断言文件没有回来、目录里一个文件都没有**。

破坏验证：把 `entry.empty === true` 换成 `false` → **119 passed, 4 failed**，四条正是两条路径
各两条（`the file does not come back` 打印回写的完整 JSON，`and no file is left behind`
打印 `["polled"]`）。恢复后 sha256 一致，123 passed。

变异新增一条 `an empty record lets an in-flight write keep a pruned file alive`，被杀。
`scripts/mutate-persistence.mjs` 354 行，27 → **28 killed**。

### 数字

```
node test/session-state.test.mjs          123 passed / 0 failed（修前 115）
node test/run.mjs                         2126 passed / 0 failed（修前 2118）
scripts/mutate-persistence.mjs             28 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs           15 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs         64 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                      14/14 killed
全仓 CRLF                                   0
```

### 真正该记住的

- **一条记录的身份不只由「它是不是当前那条」决定，还由「它有没有资格留下痕迹」决定。**
  我前一轮把归属问题拆成了「没人要 / 换人了 / 还是我」三种，第三种对了，但对**新主人**
  只问了「是不是它」，没问「它能不能写」。空记录能拥有 id，却不能拥有文件。
- **面板的轮询是一个几乎无限的调用源。** 任何「只在某个少见时刻才装进来的状态」只要
  轮询能装，它就是常态，不是边角。判断窗口大小要用轮询的频率去算，不能用事件频率。
- **修复要落在不变量上，而不是落在被发现的那条路径上。** 审查给的复现是「写落地时撞上
  轮询」，但正确的修法在 `document() === undefined` 这一处，它同时也是别的原因导致空
  文档时的同一答案。

## 2026-11-04 · 第六轮代码审查：上一轮的修复删掉了别人的文件

第五轮那处修复（空文档 ⇒ 删文件）被第六轮判为**引入了新的数据丢失缺陷**。这一节记的是为什么一条
看起来只是"补一个 unlink"的条件，实际是一个会比它修的问题更坏的判断。

### 问题

`load()` 里 `readState(stored)` 返回 `undefined` 有两种完全不同的成因：

- `stored === undefined` —— 磁盘上真的没有这个文件；
- `readState(stored) === undefined` —— 文件在，但版本号、信封、JSON 完整性、内部 session 名里
  有一项被拒。

第五轮的修复把两者一起装进 `empty: true` 的记录，而那条记录现在有权删除。审查者用真实模块复现
四种形态（`state: 999` 未来版本、`version: 2` 未来信封、截断 JSON、body 里写着别的 session id），
每一种都走 `load()` → `release()`（即宿主的 `agent/disposed`），结果都是文件消失：

```
before: [future-state.json]   after: []
before: [future-envelope.json] after: []
```

真实路径是版本回滚。新构建把 `state` 升到 2，用户退回这个构建，这个构建读不懂，下一次关机就把
整个会话的技能与工具全删了。README 那句 "Disposal is not deletion … the file stays" 当场作废。

值得记的是**这不是我写了一条多余的条件**，而是两个不同事实共用一个表示。`empty` 的含义在第五轮
之前是"我看过了，什么也没有"，第五轮之后它同时意味着"我可以删掉这个 id 下的任何东西"。前者是观察，
后者是授权。

### 修法

不放宽 `flush()` 的删除条件（那会让第五轮的问题回来），而是在源头把两个事实分开：

- `SessionStore.exists(sessionId)`：`stat` 一下，只回答"有没有"，不回答"我能不能读"。`read` 的
  `undefined` 因此不再是删除的依据。
- `load()` 读完发现 `readState` 拒绝时，再问一次 `exists`。文件在，就装一条**没有 `empty` 键**的
  记录：它拥有这个 id（所以不会重复读盘），但 `document()` 对它返回 `undefined`（所以没有写会落到
  外来文件上），`flush()` 里那条删除也不适用。

只有"文件确实不存在"才标 `empty`，只有 `empty` 才有权删。

### 测试与探针

`test/session-state.test.mjs` 新增两块共 13 条断言：四种形态各断言 `load` 返回 false、记录不标
`empty`、`release` 后文件仍在且**字节未变**；另一半断言无文件时仍标 `empty`（ghost id 回收的依据）。

探针把 `exists` 守卫改成恒假，得到 8 条 FAIL 而不是崩溃：

```
FAIL future-state: the record that owns the id is not marked empty — true
FAIL future-state: the file is still there after shutdown — <missing: ENOENT>
...（四种形态各两条）
```

这里有个必须记下来的细节：断言最初写的是裸 `await readFile(...)`。修复被破坏时它抛 ENOENT，
套件**不打印任何 FAIL 行**就退出，而变异脚本只数 `FAIL ` 开头的行——于是"删掉别人的文件"会被记成
CRASHED 甚至通过。改成先把读取结果收进 `after = '<missing: CODE>'` 再 `check(after === body)` 之后，
破坏才变成可读的失败。这是本仓库第三次因为同一个原因把断言写成假守卫。

### 变异

新增两条，都被杀：

| 变异 | 杀的断言数 |
| --- | --- |
| `a file this build cannot read is deleted on the way out`（`exists` 守卫恒假） | 8 |
| `an unreadable file is treated as no file at all`（删除条件去掉 `empty` 门） | 4 |

第二条第一次报 `ANCHOR MISSING`，原因是锚点的缩进写成了 8 空格，而源码是 6 —— `if (entry.empty
=== true)` 在文件里出现两次（`flush` 里 6 格、`prune` 里 6 格但语义不同），必须先看 `grep -n ...
| cat -A` 的行尾确认缩进，不能凭记忆写。

### 数字

```
node test/session-state.test.mjs     136 passed / 0 failed
node test/run.mjs                   2139 passed / 0 failed
scripts/mutate-persistence.mjs        30 killed / 0 survived / 0 not applied / 0 crashed
全仓 CRLF                              0
```

### README 的两处修正

1. 原文说三个时刻会立即 flush，其中一个是 "the panel being read"。实际 `api.js` 只调 `load`，不调
   `flush`——轮询读盘不写盘。改成两个时刻，并写明轮询为什么不写。
2. 新增一段「A file this build cannot read is left alone」，把 `read` 的 `undefined` 覆盖两件事、
   以及为什么删除权只属于其中一件，写进用户可见的文档。

### 真正该记住的

1. **一个表示一旦被加上授权，就再也不只是观察。** `empty` 原本回答"有什么"，加上删除之后回答
   "能删什么"。给一个已有字段加能力时，要重新数一遍所有写它的地方。
2. **`undefined` 是最容易合流两个事实的返回值。** 每次用它，问一句"调用方会把它当成哪一种"。
3. **测试断言必须把异常变成值。** 本仓库已经因为裸 `readFile`/裸 `.props` 三次把崩溃错记成存活或
   通过。判据很简单：把修复破坏掉，应该看到 `FAIL`，不应该看到堆栈。

## 2026-11-04 · 第七轮代码审查：一次读不出两个答案

第六轮把「文件不存在」和「文件读不懂」分开，做法是**再问一次文件系统**（`exists()`）。第七轮证明
这个做法本身有两个洞，而且两个都是我自己在别的轮次已经写进注释里的话。

### P1：新加的 `await` 后面没有复查

`load()` 在 `read()` 之后有一次 `if (this.bySession.has(sessionId)) return false`，理由是「读盘期间
到达的事件不能被覆盖」。`exists()` 是第七次 `await`，后面没有第二次复查就无条件
`this.bySession.set(...)`。窗口内 `rememberSkill` 建好的记录被整条覆盖：

- 若 `exists()` 返回 false，覆盖成的是 `empty: true` 空记录，`document()` 随即返回 undefined，
  一秒后的 flush 走 `if (entry.empty === true) … forget()` 把刚写下的文件删掉；
- 用生产默认 `delayMs` 时表现更干脆——事实根本不再落盘。

审查者给出的复现是把 `store.exists` 包一层，在返回前调 `rememberSkill` 再等 60ms，实测
`file after release: <missing: ENOENT>`。

**这是同一类错误的第四次**：第一轮 P1（disposal 竞态）、第三轮 P2（在途写复活）、第五轮 P2（空记录
救活文件）、第七轮 P1，全部是「异步操作之间有个窗口，我在其中一端加了判断，另一端没加」。所以这次
不再补一行复查了事，而是把窗口消掉。

### P2：`read()` 与 `exists()` 是两次独立观测

TOCTOU 不只是「多装或少装一条记录」。sweep 删掉文件后、落盘中的写把文件重建，而 `read()` 落在重建
之前、`exists()` 落在之后时，装进来的是一条**没有 `empty` 键**的记录：`flush` 的删除门对它不生效，
`prune()` 开头的空记录清扫也不认它，于是那个已被判死的文件在整个进程生命周期里持续存在，每次轮询
都把它读回来描述一个已经消失的会话——正是第五轮那条变异想封住的窗口，从另一条分支漏了出来。

这一条**不能**靠 P1 的复查解决：该场景下窗口内本来就没有记录。

### 修法：让一次读同时回答两件事

`SessionStore.read()` 的 `undefined` 天生合流两个事实，任何「按返回值决定要不要删文件」的调用方
都会被它骗。新增 `inspect(sessionId)`，一次 `readFile` 给出三态：

| 结果 | 含义 | 谁有权删 |
| --- | --- | --- |
| `{ kind: 'absent' }` | 磁盘上确实没有 | 可以（文件本来就不存在） |
| `{ kind: 'present', value }` | 信封与身份都是我们的 | 按状态正常处理 |
| `{ kind: 'foreign' }` | 有文件，但这一版不读 | **不可以**，必须原样留着 |

`read()` 保留为 `inspect()` 的包装（`present` 才给文档），六处只关心「我能用什么」的调用方不受影响。
`exists()` 删除——它问的问题现在由 `inspect` 在同一次读里回答，留着就是邀请别人再犯一次 TOCTOU。

`foreign` 的判定从四处扩大到五处：**除 ENOENT 以外的所有读错误也归为 `foreign`**。EACCES、EPERM、
EBUSY、EISDIR 都意味着「有东西在那儿，只是现在打不开」，对准备删除的调用方来说这与外来文件同义。

`load()` 现在只有一个 `await`，复查仍然保留（它不是为 `inspect` 加的，而是为「任何 await 之后都要
复查」这条规则）。

### 测试与探针

`test/session-store.test.mjs` 59 passed（+8）：六种形态逐条断言 `inspect` 的三态判定（`future` /
`wrong-session` / `array` / `null` / `scalar` → `foreign`，`missing` → `absent`），一条可用文件返回
完整文档，一条**目录占位**制造 EISDIR 断言不被当作 absent。

`test/session-state.test.mjs` 144 passed（+8）：用包住 `store.inspect` 的方式把事实投递到 `await`
窗口的正中间，断言记录没被降级成 `empty`、事实还在、关机后文件仍在且含着那条事实；另一半断言
「refused 文件装无授权记录 / 缺失文件装有权记录 / 读错误不算空目录」三条并存。

探针两处都杀：

```
probe A（删掉 await 后的复查）→ 140 passed, 4 failed
  FAIL and the fact is still there — undefined
  FAIL and the record was not downgraded to empty — true
  FAIL and the shutdown kept the file the fact was written to — absent
probe B（读错误当 absent）→ 58 passed, 1 failed
  FAIL a file that cannot be opened is not reported as absent — {"kind":"absent"}
```

探针 B 第一次写成「替换 `store.inspect`」，结果 144 全绿——那只是把测试自己的替身改了，没碰
`session-store.js`。**验证存储层的判定必须改存储层**，否则测的是夹具。

### 变异

30 → 32 条，新增两条都被杀：

| 变异 | 杀的断言数 |
| --- | --- |
| `a load installs its record over one that arrived while it read` | 4 |
| `a file that cannot be opened is taken for an empty directory` | 1 |

旧锚点 `if (await this.store.exists(sessionId)) {` 已随 `exists` 消失，改成 `const empty = found.kind
=== 'absent'` 变 `const empty = true`（把删除权扩大到所有 refusal），仍然被杀。

### 数字

```
node test/session-store.test.mjs      59 passed / 0 failed
node test/session-state.test.mjs     144 passed / 0 failed
node test/run.mjs                   2155 passed / 0 failed
scripts/mutate-persistence.mjs        32 killed / 0 survived / 0 not applied / 0 crashed
全仓 CRLF                              0
```

### 真正该记住的

1. **每加一个 `await`，就要问「这之后世界变了没有」。** 这个仓库里四个 P1/P2 全是这一条。判据不是
   「我需要复查吗」，而是「这段代码里还有几个 await 后面没有复查」。
2. **两个问题用一次观测回答，比两个观测各自正确更强。** TOCTOU 不是要小心处理的风险，是「问了两次」
   这个形状本身的属性。
3. **验证某个层的判定，必须改那个层。** 替换测试替身只能证明测试的替身好用。

---

## 2026-11-04 · 第八轮代码审查的修复：一次写入记得的必须是整段对话

### 这轮报了什么

三份，按严重程度：

1. **[P1] 重启后事件先到、面板轮询后到，写盘把磁盘上的历史整段抹掉。** `load()`
   的第一行守卫是 `if (this.bySession.has(sessionId)) return false`——「内存里有记录就
   不读盘」。这个前提只对**读过盘**的记录成立。宿主重启后会先把会话事件重放一遍，
   而事件路径（`index.js` 的 `session/event`）从不调 `load()`，所以 `entry()` 先用第一条
   事件建出一条 `snapshot: undefined` 的记录，`load()` 从此永远不再读盘。写盘时
   `document()` 用它，于是磁盘上 7 个回合、两条技能、一个 MCP server 的文档被替换成
   这几秒钟看见的东西。
2. **[P2] `scripts/mutate-session-store.mjs` 三条锚点早已过期。** 上一轮把
   `return undefined` 改成了 `return { kind: 'foreign' }`，锚点没跟着改。真实输出是
   `12 killed, 0 survived, 3 not applied`，退出码 1——**我上一轮报告的「15 killed /
   0 survived」不成立**。审查者手工做出正确锚点后确认三个守卫都有测试覆盖，所以那
   三条测试是好的，坏的只是我的报告。
3. **[P2] `foreign` 文件的「永不覆写」只在首条事实之前成立。** `document()` 返回
   `undefined`（也就是不写）的条件是「没有技能、没有工具、没有 previous」——一旦这个
   会话有了自己的事实就不再成立，`flush()` 照常写盘，把外来文件覆盖成 `version: 1`。
   注释里那句 "no write lands on the foreign file" 是假的。

外加 **[P3]**：`load()` 的 foreign 分支与 present-but-unreadable 分支各内联了一份
记录字面量，与 `entry()` 那份重复。

### 怎么修的

**P1 换了一个不变式，不是补一条分支。** 旧规则「内存里有记录就不读盘」本身就是错
的；新规则是 **「没读过盘的记录不许写」**：记录上多一个 `loaded` 字段，`flush()` 在
写之前先 `await this.load()`，`load()` 自己负责把磁盘内容和内存事实**合并**。

`load()` 于是从「有记录就返回 false」改成分支合并：

- 只有 `before.loaded === true` 才提前返回（读过盘的记录才是权威的）；
- 读盘后再取一次记录（`const current = this.bySession.get(sessionId) ?? before`），
  读盘期间到达的事实不会被覆盖；
- `absent` 分支：无记录就装 `blankRecord()` 并标 `empty`；有记录只在完全没有事实时
  才补标 `empty`；
- `foreign` / body 不可用的分支：装一条**不带 `empty`** 的记录，文件留下；
- `present` 分支：无记录直接装；有记录则**合并**——把内存里知识的 `at` 全部按
  `state.sequence` 平移（两个进程的计数器各自从零开始，不能直接比较），磁盘的技能与
  server 只补内存没有的，`snapshot` 只在内存没有时才用文件的。

`flush()` 里那个 `await load` **必须放在清 timer 与认领 `writing` 之前**。第一版放在
`writing` 检查之后，立刻炸出 `FAIL concurrent flushes share one write — 2 writes`：
await 可能把 id 交给另一条记录，在旧记录上认领的 `writing` 会守错对象。

`blankRecord()` 收拢了四处重复的字面量（P3），顺带把 `loaded: false` 写在一处。

**P2（锚点）**：三条 `from`/`to` 按新代码重写，`15 killed / 0 survived / 0 not
applied`。

**P2（foreign）**：没有加锁，而是把注释改成真话，并用测试把两半都钉住——
「关机不动外来文件」（`load` + `release` 后字节不变，实测 UNCHANGED）与
「自己的事实终究覆盖它」（`rememberSkill` + `flush` 后 `state: 1`，实测 REWRITTEN）。
给这类记录加「永不覆写」会让这个会话的全部技能和工具在内存里待到那个读不懂的文件
消失为止，正是这个模块存在的理由的反面。

### 新增/重写的断言

- `test/session-state.test.mjs`：原来那条「a session already in memory is not
  reloaded / and its live state is untouched」**测的正是旧约定，而旧约定就是 bug**，
  整条重写成「a load merges into a record that already holds facts」，并补上
  「the live fact is still the newest」（平移后的 recency 仍然自洽）与「a record
  that has read is not read again」。新增「a shutdown leaves a file this build cannot
  read untouched / but a fact of its own does replace it / and the fact is in the
  file」。**150 passed**。
- `test/persistence.test.mjs`：新增「An event that arrives before the first poll does
  not erase the history」——先 seed 一份完整文档（7 回合 + 两条技能 + 一个 MCP server
  + 上一轮摘要），再用新宿主只跑一个事件（第 8 轮），断言历史技能、历史工具、本轮
  技能同时在盘上，且面板能列出上一进程加载的技能。**54 passed**。
- 这条测试踩了三个坑：`makeRoot` 实际叫 `makeTempRoot`；`VERSION` 没 import；
  最要命的是 `waitForFile` 在**文件已存在**时立刻返回，于是读到的是 seed 而不是新写
  ——改成就内容轮询。另一条断言「turns 没变少」也写错了：`turns` 是每进程计数器，
  重启后从 1 开始，它不是历史是否存活的证据；真正的证据是技能与工具。

### 探针

把 `load()` 的守卫改回 `if (before !== undefined) return false`，persistence 套件：

```
51 passed, 3 failed
  FAIL the history the file already had is still there — gamma
  FAIL and the tool it named is still there — []
  FAIL the panel lists the skill the previous process loaded — []
```

三条全部指向被抹掉的历史，正是 P1。恢复后 md5 一致、全绿。

### 数字

```
node test/run.mjs                        2168 passed / 0 failed
node test/persistence.test.mjs             54 passed / 0 failed
node test/session-state.test.mjs          150 passed / 0 failed
node test/session-store.test.mjs           59 passed / 0 failed
scripts/mutate-persistence.mjs             34 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs           15 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs         64 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                      14/14 killed
全仓 CRLF                                  0
node scripts/sync-gutter.mjs               幂等（连跑两次 client.js 的 md5 不变）
```

### 真正该记住的

1. **「内存里有」不是「内存里更新」。** 一个记录能不能免于读盘，取决于它读过没有，
   而不是它存在与否。凡是拿存在性代替新鲜度的地方，都要问一句「第一次是谁建的它」。
2. **基线数字要复跑，不要沿用。** 上一轮我报的 `15 killed / 0 survived` 在代码改动
   之后已经不成立，而我没有重跑就写进了 handover。锚点过期不会自己报错，它只会让
   变异「看起来还在」。
3. **注释里的绝对句（"no write lands…"）必须由测试兑现，否则它是下一个人的错误
   前提。** 这轮 P2 就是一句断言式的注释在代码演进后变成了假话。

## 2026-11-04 · 第九轮代码审查的修复：同一个问题，两个回答者

这一轮报的三处都是**并发窗口**，而且三处都能被真实链路触发，不需要构造不可能的时序。

### 这轮报了什么

**P1 · 只说过话的会话，文件会被自己那次 flush 删掉。**

`absent` 分支用「有没有技能、有没有工具、`sequence` 是不是 0」判断这条记录算不算有事实，
而 `document()` 用的是「有没有 `snapshot.previous`」。`rememberTurn()` 只写快照、不记技能和
工具，于是只聊过天没调过工具的会话被两处判成不同的答案：一方说空、一方说有内容。
实测 `FINAL: file = false, files on disk: []` —— 写出来的文件被自己在途写落地后删掉。
整个 `session-state.test.mjs` 里此前从没出现过 `rememberTurn`，所以这条路径没有读者。

**P2 · 清扫落在读盘窗口里时，被判定删除的会话会被复活。**

`flush()` 在 `await this.load()` 之后只处理了 `entry === undefined`，而 `load()` 自己在 `absent`
分支会把记录重新装回 `bySession`（四处 `if (this.bySession.has(...) === false) this.bySession.set(...)`）。
清扫刚删掉的 id 因此被撤销，放行后 `dead.json` 照样被写出来。

**P2 · 并发 `load()` 会把文件合并两次。**

`loaded` 守卫在 `await this.store.inspect()` **之前**求值，而 `loaded = true` 只在 await 之后设置，
两个并发调用都能通过。生产路径现成：面板每 8 秒轮询走 `api.js` 的 `viewOf`，与某次
`flush()` 内部的 `await this.load()` 重叠。种子 `sequence: 5` 加一条内存事实，一次合并应为 6，
实测 `sequence = 11`、`recency = [["skill:live",11],["skill:alpha",6]]`、`restore` 被调用两次。

### 怎么修的

1. **`hasFacts(entry)` 成为唯一判据**（模块级函数，`document()` 与 `absent` 分支共用）：
   `skills.size > 0 || tools.size > 0 || snapshot?.previous !== undefined`。
   同一道题有两个读者时，答案必须由同一个函数给出，否则两边迟早不一致。
2. **删掉四处「重新装回记录」**。清扫在 `onRemoved` 里删掉 id 就是一个决定，读盘是一小时后
   才回来的旧消息，没有资格撤销它。改为一行注释说明这里为什么不装回去。
3. **`restore` 调用加 `bySession.has` 守卫**，不再给已经不存在的记录装 transcript。
4. **单飞**：构造函数加 `this.loading = new Map()`；`load()` 拆成「守卫 + 共享 promise」和
   `readInto()`（真正的读盘与合并）。同 id 的第二个调用者拿到第一个的 promise，不是第二次合并。

### 新增的断言（`test/session-state.test.mjs`，150 → 166）

| 断言 | 钉住的性质 |
| --- | --- |
| `a session that only talked still gets a file` | `rememberTurn` 之后文件必须存在 |
| `and the turn it finished is in it` | 且 `previous.said` 在里面 |
| `a sweep keeps a record that only finished a turn` | 只结束过回合的记录不被当作空记录回收 |
| `the merge happened once, not once per caller` | 并发 `load()` 只合并一次（`sequence === 6`，两次会是 11/16） |
| `the sequence was shifted once` | `at` 不被平移两次 |
| `the turn was handed to the transcript once` | `restore` 只调用一次 |
| `and the write it waited behind does not put it back` | 清扫的删除不被读盘窗口撤销 |
| `and no file is left behind for it` | 放行后文件仍是空的 |

### 顺带修掉的测试自身缺陷（这轮的意外收获）

变异脚本 `mutate-persistence.mjs` 扩到 37 条后一直偶发 `CRASHED`，手工复现又稳定通过。
写了个循环跑 40 次，抓到 1 次：

```
TypeError: openGate is not a function
    at file:///.../test/session-state.test.mjs:720
```

根因在测试里：闸门的 resolver 是在**被测代码的 `store.write` 内部**才赋值的，
而释放闸门用的是 `setTimeout` 猜时间。写入还没到，`openGate` 还是 `undefined`。
这类抛错**不打印任何 FAIL 行**，于是被变异脚本记成 CRASHED —— 看起来像变异脚本的毛病。

修法两条：

1. 闸门在块开头就 `new Promise((resolve) => { openGate = resolve })`，不等被测代码。
2. 用 `waitFor(condition, timeoutMs)` 等条件成立，**超时返回 false 并打印 FAIL**，
   不再靠一个够长的 `setTimeout` 猜。

修完连跑 120 次：`{ ok: 120, bad: 0 }`（修前是 `{ ok: 118, bad: 2 }`）。

### 数字

```
node test/run.mjs                        2184 passed / 0 failed
node test/session-state.test.mjs          166 passed / 0 failed
node test/session-state.test.mjs ×120     120/120 clean
scripts/mutate-persistence.mjs             37 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs           15 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs         64 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                      14/14 mutations killed
全仓 CRLF                                  0（144 个文件扫描）
```

### 真正该记住的

1. **同一道题有两个读者时，把答案抽出来给两个人共用。** 这轮 P1 不是某个分支写错了，
   是两个分支各自回答了「这条记录算不算有内容」。抽成一个函数之后，它们不可能再不一致。
2. **一个「决定」不能被后到的旧消息撤销。** 清扫删 id 是在当时当地做出的判断，
   读盘窗口里回来的合并结果比它旧，所以 `load()` 没有资格把记录装回去。
3. **测试里的等待不能猜时长。** 闸门由被测代码释放，就不该用 `setTimeout` 等它——
   猜短了抛 TypeError（不打印 FAIL，被记成 CRASHED），猜长了整套慢下去。
   `waitFor(condition)` 把「没等到」变成一个能读懂的失败。

## 2026-11-05 · 第十轮代码审查的修复：删掉别人的工作，和一个负数

这一轮报了两条会**真实删除用户会话快照**的缺陷，外加一条内存泄漏和两条文档/死代码问题。
更要紧的是这一轮中间出过一次事故：写源码的脚本把 `session-store.js` 清成了 0 字节。
两件事都记在这里，因为它们的教训是同一个方向的。

### 报了什么

| 编号 | 位置 | 事实 |
| --- | --- | --- |
| P1 | `session-store.js` 的 prune 尾部 | `stat` 失败的条目被 `continue` 跳过，`dated.length` 可能小于 `survivors.length`；`dated.slice(0, dated.length - this.maxFiles)` 在 `dated.length < maxFiles` 时得到**负尾参**，`slice` 解释成「从末尾往回数」，语义整体反转——删的是最新、仍存在的文件。复现：498 个真实文件 + 5 个 stat 必失败的名字 → `removed: 496`，只剩 2 个文件（上限 500，本该 0 删除） |
| P1 | `session-state.js` 的 `flush` | `entry.empty` 只说明「我这侧读过盘、当时没事实」，不等于盘上现在没有。A `load(id)` → empty；B 写入 150 字节；A `release(id)` → 文件消失。两个宿主进程共用一个 `plugin-data` 是 `sequence` 平移本来就支持的场景 |
| P2 | `index.js` 的 `agent/disposed` | `void sessionState.release(agentId)` 之后立刻同步 `transcripts.forget`，而 `release → flush` 发现 `entry.loaded !== true` 会 `await load()`，`readInto` 末尾 `restore(...)` 把刚清掉的 transcript 装回来。探针：`transcripts.has after release settled: true` |
| P3 | `session-store.js` | `readJson(path)` 无调用点；`this.removed` 只写不读（真正被消费的是 `this.considered`） |
| P3 | `api.js` | `Assemble everything the panel draws.` 那段被本次插入的 `viewOf` 文档块挤走，`readPanel` 失去文档 |

### 怎么修的

1. **cap 按被衡量的那个列表算**：`const excess = survivors.length - this.maxFiles`，再 `for (const entry of dated.slice(0, excess))`。
   关键不是加 `Math.max(0, …)` 钳制，而是**减法要用 cap 实际衡量的那个数**——`dated` 会因为 stat 失败而更短，
   它是「能定出年龄的文件」，不是「要保留的文件」。钳制只是把错误藏起来。
2. **删盘前重新问文件**：`flush` 的 `document === undefined` 分支改成 `await this.dropIfOrphan(sessionId)`。
   它 `inspect` 一次，只在这几种情况下 unlink：`absent`；`present` 且文档里没有已完成回合、没有技能、没有工具。
   `foreign`（读不懂的文件）一律留着——那可能是用户能回去的旧版本写的。
3. **清扫的决定要留痕迹**：`dropIfOrphan` 开头先看 `this.condemned`。理由是修这一条时撞出来的：
   我把删除改成「问文件」，结果 `gone`/`archived` 两组用例变红——文件里正是**刚落地的写**，
   于是「有事实 → 保留」，把一个已判定消失的会话又救了回来。**文件在写落地之后无法替清扫发言**，
   所以 `prune` 在删每个 id 时把 `condemned.add(sessionId)` 记下来，那是宿主对**会话**的判断，不是对文件的观察。
4. **transcript 清两次**：dispose 时立即清一次（面板在 disposal 返回后马上被读，已关闭的会话不能在屏幕上多停一个异步回合），
   `release` 落定后再清一次（`restore` 可能把它装回来）。只推迟会让 `test/index.test.mjs` 的
   `disposal releases the transcript` 变红；只清一次会被 `restore` 撤销。
5. 死代码与 JSDoc 错位照审查意见清理。

### 新增的断言（全部用破坏探针确认会变红）

| 套件 | 断言 | 探针输出 |
| --- | --- | --- |
| `session-store` +4（59→63） | 不可 stat 的名字不打断 cap / 走的是最旧那个 / 负尾参不会保住本该删的 / 无空间的 cap 不留任何能定年龄的 | 负尾参 → `59 passed, 4 failed` |
| `session-state` +5（166→171，再 +3→174） | 第一个进程不删它没见过的 / 第二个进程记的技能还读得回 / 空盘仍被回收 / 只有已完成回合的文件不是孤儿 / 那个回合还在 | 退回 `store.forget` → `169 passed, 2 failed`；去掉回合守卫 → `172 passed, 2 failed` |
| `persistence` +3（54→57） | dispose 之后内存里没有那一轮 | `.then(() => {}, () => {})` → `56 passed, 1 failed`（`disposal leaves no turn in memory — 9`） |

`test/persistence.test.mjs` 那块有个**形状约束**必须写进注释：文件要在进程持有任何事实**之前**就在盘上，
记录才处于「从未读过盘」状态，`release` 才会真的 `await load()` 走到 `restore`。用 `work()` 驱动时
`waitForFile` 会先等文件出现，`entry.loaded` 已是 true，`release` 不再读盘——探针因此存活过一次。

### 事故：写源码的脚本把文件清成了 0 字节

`_r11.py` 的 `save()` 写 `open(path, 'w', encoding='utf-8', newline=NL)`，而 `NL` 是给 JS 字符串用的
两字符转义 `\` + `n`，不是合法的 newline 值 → `ValueError: illegal newline value: \n`。
但 **`open(path, 'w')` 在 `newline` 参数校验之前就已经清空文件**，所以异常抛出时
`packages/ui-evolve/lib/session-store.js` 已经是 0 字节，而这个文件从未被 git 跟踪过
（`git log --all` 空、`git ls-files` 空、`git stash list` 空）。

恢复路径与依据：

- 磁盘上两份副本都只有第五轮时代的形状（`.review-tmp/r5backup/.../session-store.js` 411 行，
  有 `readJson`/`this.removed`/负尾参；`.review-tmp/r3/bak/session-store.orig.js` 382 行），
  **都不含第七轮的 `inspect` 三态**。
- 靠 `test/session-store.test.mjs`（59 条断言，精确规定 `{ kind: 'absent' | 'foreign' | 'present' }`
  与六种文件形态的对应）、`scripts/mutate-session-store.mjs`（15 条逐字锚点）、
  `session-state.js` 的全部调用点、以及 `docs/handover` 的文字重建出 420 行，
  重建时把第十轮的两项修复一并写进去。
- 重建后 `session-store` 59 passed、`session-state` 166 passed、`persistence` 54 passed、
  `mutate-session-store` 15/15。

**新纪律**：源码一律用 `edit` / `write` 工具改，不再用 python 脚本写源码文件。
必须用脚本时，`save()` 要 (a) 先断言无 `\r`、(b) `newline=chr(10)`、(c) **先写 `.tmp` 再 `os.replace`**——
这样校验失败不会毁掉原文件。

### 数字

```
node test/run.mjs                          2199 passed / 0 failed
node test/session-store.test.mjs             63 passed / 0 failed
node test/session-state.test.mjs            174 passed / 0 failed
node test/persistence.test.mjs               57 passed / 0 failed
scripts/mutate-persistence.mjs               41 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs             15 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs           64 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                        14/14 mutations killed
test/mutations.test.mjs                      20 passed / 0 failed
全仓 CRLF                                    0
node scripts/sync-gutter.mjs                 幂等（连跑两次 client.js sha256 不变）
```

### 真正该记住的

1. **减法要减在 cap 实际衡量的那个数上。** `dated.length` 与 `survivors.length` 是两个数，
   用错一个就让 `slice` 的负数语义把「删最旧」变成「删最新」。`Math.max(0, …)` 只会让这个错误安静下来。
2. **文件不能替「决定」发言。** 一个已判定消失的会话，它的文件可能正是被这次删除触发的那次写刚建出来的。
   要记住的判断必须留在内存里（`condemned`），并且要在**做出判断的那一刻**记，不是事后读盘反推。
3. **写源码的脚本要能失败得不毁东西。** 先写 `.tmp` 再 `os.replace`；`open(path, 'w')` 在参数校验之前就已经清空文件。

---

## 2026-11-06 · 第十一轮代码审查的修复：谁的数字，谁的证据

审查 run `faa681ba-8c69-4518-abbf-309bb8c61e30`，判定「这份补丁不算正确」。
基线全部独立复跑一致，报出 2 P1 + 2 P2 + 3 P3。其中 cap 那条 P1 已在上一节结束时修掉，
本节记的是其余 1 P1 + 2 P2 + 2 P3。

### 报了什么

| 级别 | 问题 | 后果 |
| --- | --- | --- |
| P1 | 重启后第一个会话事件覆盖磁盘上的上一回合与回合数 | 面板宣布「第 1 轮」，而对话实际已到第 8 轮 |
| P2 | cap 裁掉活会话时连内存记录一起删、还盖上 `condemned` | 正在运行的会话丢失全部事实，下次写盘只剩碎片 |
| P2 | 合并时文件里的 `via:'tool'` 被内存里的 `gesture` 降级 | 模型专用技能从面板消失 |
| P3 | 两个写者的 `updated` 类型不一致（数字 / ISO 字符串） | 字段类型取决于最后是谁写的 |
| P3 | 只有回合计数、没有 finished turn 的文件读回后面板显示 0 | 上一轮被放弃的会话，计数凭空归零 |

### 怎么修的

**P1 分两半，两半都不是「谁覆盖谁」的问题。**

第一半在 `packages/ui-evolve/lib/transcript.js` 的 `hydrate()`：它原本在
`this.byAgent.has(agentId)` 时直接 `return false`，理由是「活事件比文件新」。
这个理由对 `previous` 成立，对**回合计数**不成立——本进程从零开始数，
磁盘上的 7 轮与内存里的 1 轮是两个跨度，只能相加，不能比较。改成合并：

```js
if (existing.hydrated === true) return false
existing.hydrated = true
existing.turns += turns
if (existing.previous === undefined) existing.previous = previous
```

`hydrated` 标志保证只加一次：`load()` 每个 id 只成功一次，但 `release → flush` 与
面板轮询可能各自走到这里，没有标志就会加两遍。

第二半在 `packages/ui-evolve/lib/session-state.js` 的 `readInto()` 合并分支：
原来只在 `current.snapshot === undefined` 时安装文件里的 snapshot，
而 `schedule()` 早已用 `snapshotOf()` 装了 `{ turns: 1, previous: undefined }`，
于是文件的回合数永远进不来。改成相加，并使 `previous` 取内存那一份：

```js
const mine = Number.isFinite(current.snapshot.turns) ? current.snapshot.turns : 0
const theirs = Number.isFinite(snapshot.turns) ? snapshot.turns : 0
const previous = current.snapshot.previous ?? snapshot.previous
current.snapshot = { turns: mine + theirs, previous }
```

**P2 的两半都是「把一个决定当成一个观察」。**

`cap` 裁剪与「宿主说这个会话没了」是同一次 `unlink`，但不是同一个判断。
只有后者说了会话的事；前者只说明目录变大了，那个会话可能正在运行。
所以 `SessionStore.prune` 的 `drop` 现在把原因传出去：

```js
const drop = async (id, reason) => {
  await this.forget(id)
  removed += 1
  if (typeof sources.onRemoved === 'function') sources.onRemoved(id, reason)
}
```

`session-state.js` 收到后只对 `'gone'` 清内存、盖章：

```js
onRemoved: (sessionId, reason) => {
  if (reason === 'cap') return
  this.bySession.delete(sessionId)
  this.condemned.add(sessionId)
},
```

`via` 那半修在合并循环里：内存已有同名技能时不再跳过，而是只在「文件说是 tool、
内存记的是 gesture」时把内存升级为 tool。反过来（文件 gesture、内存 tool）保持内存的，
因为 tool 是更强的证据，且这个字段本来就只单向移动。

**P3 两条都小**：`updated` 统一成 `new Date(this.now()).toISOString()`；
`restore` 的调用条件从 `isRecord(stored.previous)` 放宽为
`isRecord(stored.previous) || Number.isFinite(stored.turns)`，并且 `hydrate`
本身也接受「只有计数、没有 `previous`」的状态。

### 新增与改写的断言

| 文件 | 断言 |
| --- | --- |
| `test/persistence.test.mjs` | `and the turn count is the whole conversation`（`turns === 8`） |
| | `and the finished turn is the one that just finished` |
| | `the panel counts the turns before the restart too`（`panel.data.turn === 8`） |
| `test/transcript.test.mjs` | `a stored count is added to the count from live events` |
| | `and the sum is what the panel counts` / `and the stored turn is shown` / `and the count did not move` |
| `test/session-state.test.mjs` | `but the session whose file went is still remembered here` |
| | `and a fact after the cap still writes its file` / `and it remembered what it knew before the cap` |
| | `and the stronger route survived the merge` / `and the file was not downgraded` |
| | `the document carries a timestamp string` / `and it is the instant the clock reported` |
| | `a file holding only a turn count is read` / `and the count is handed to the transcript` |

原来那条 `and the document still names a turn` 写的是 `turns >= 1`——它正是放过 P1 的断言。
一个「至少 1」的下界在正确的实现和错误的实现里都成立，所以它什么都没测。

### 探针（五处破坏，全部被杀）

```
cap 守卫去掉            → 187 passed, 2 failed（[] / ["delta"]）
via 升级去掉            → 187 passed, 2 failed（gesture / {"via":"gesture","at":4}）
updated 改回数字         → 187 passed, 2 failed（number / 1700000000000）
restore 守卫收窄         → 188 passed, 1 failed（and the count is handed to the transcript）
hydrate 合并改成拒收      → transcript 72 passed, 4 failed；persistence 57 passed, 1 failed
```

第五个探针跨两个套件，这一点本身是信息：合并语义的后果在单元层和端到端层都可见。

### 变异

`scripts/mutate-persistence.mjs` 有 4 条锚点随修复失效，全部重新对准，其中两条要重写而不是改字符串：

- `a cap counts the names it could date instead of the files it keeps`——修复后
  `excess` 本来就等于 `dated.length - this.maxFiles`，按原来的锚点注入的是**等价代码**（存活）。
  正确写法是把 `excess` 改回取 `survivors.length`，那才是审查描述的错误。
- `a stored turn is refused because this process has already seen events`——锚点从
  `this.byAgent.has(agentId)` 换成新的三行合并块。
- `a deletion is recorded at the end of the sweep`——`onRemoved` 签字变了，且在函数体开头插
  `return` 而不是删掉整个对象成员：后者会留下语法错误，测试崩溃、一行 FAIL 不打印，被记成
  CRASHED 而不是 KILLED。
- `the store deletes files without telling anyone`——同步 `onRemoved(id, reason)`。

`scripts/mutate-session-store.mjs` 的 `the cap is ignored` 同样过期（`survivors.length > this.maxFiles`
已不存在），改成 `if (excess > 0) {`。

### 数字

```
node test/run.mjs                          2219 passed / 0 failed
node test/session-store.test.mjs             63 passed / 0 failed
node test/session-state.test.mjs            189 passed / 0 failed
node test/persistence.test.mjs               58 passed / 0 failed
node test/transcript.test.mjs                76 passed / 0 failed
scripts/mutate-persistence.mjs               41 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs             15 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs           64 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                        14/14 mutations killed
scripts/mutate-guards.mjs                    11/11 mutations killed
test/mutations.test.mjs                      20 passed / 0 failed
test/gutter-drift.test.mjs                   20 passed / 0 failed
全仓 CRLF                                    0（141 个文件）
```

### 真正该记住的

1. **「内存里有」和「文件里有」不总是竞争关系。** 回合计数是两个跨度，只能相加；
   技能与工具是两批事实，只能取并集；`previous` 才是真正的新旧之争。
   一个「谁更新」的规则套在所有字段上，就会有字段被静默丢掉。
2. **一次 unlink 可能是两个不同的判断。** 删除的**原因**决定了调用方该做什么，
   所以原因必须跟着通知走。只传 id 的通知逼调用方猜，猜错了就是删掉正在运行的会话。
3. **断言的下界要贴着契约写。** `turns >= 1` 在正确与错误的实现里都成立，
   于是它保护不了任何东西；`turns === 8` 才能分辨。写「至少」的时候要问：
   错误的实现会不会也满足它。
4. **等价变异是最难发现的一种失效。** 一条变异的 `from`/`to` 在重构后可能语义相同，
   于是它「存活」而代码是对的。判据不是「改动了字符」，是「改动了行为」。

## 2026-11-06 · 第十二轮代码审查的修复：谁有权相加

### 报了什么

四条都不是新功能，是三处「两个地方各自回答同一个问题」。

| # | 级别 | 症状 | 位置 |
| --- | --- | --- | --- |
| 1 | P1 | 重启后只要事件先到，面板就永远看不到历史 | `lib/api.js` 的 `viewOf` |
| 2 | P2 | 只有回合数的会话，新计数永远写不进文件 | `lib/session-state.js` 的 `hasFacts` |
| 3 | P2 | `release` 后重用同一实例，文件里的回合数翻倍 | `lib/session-state.js` 的 `readInto` |
| 4 | P3 | `restore` 的注释说 hydrate 会拒绝，而它已经不拒绝了 | `lib/index.js` |
| 5 | P3 | cap 变异条的 `why` 把失效机制写反 | `scripts/mutate-persistence.mjs` |

第 1 条是最贵的一条：`record()` 收到任何事件就建 Transcript，而宿主会先重放一个
会话的事件再有人打开面板——所以「内存里有记录」几乎总是成立，`load` 因此一次都不跑。
用户看到的是「重启后回合数从 7 退回 1」，而且会一直显示 1 直到这一轮结束。
已有的 race 用例漏掉它，是因为 `work()` 在同一轮里先发 `user/message` 再发 `turn/end`，
断言时 load 已经发生过了。

### 怎么修的

- `viewOf` 不再问「内存里有没有」，直接 `await state.load(agentId)`，再读内存视图。
  `load()` 自己用 `loaded` 保证只读一次盘，所以首次之后的每次轮询只是一次 map 查找。
- `hasFacts` 认 `Number.isFinite(entry.snapshot?.turns) && turns > 0`。
  一个只跑过早退回合的会话没有任何技能、没有工具、没有 finished turn，
  但它的回合数仍然是要显示的事实，也是重启后唯一无法从事件重建的事实。
- `readInto` 不再自己加 snapshot。回合数是 transcript 的，只有它能加，
  而且只加一次（`hydrated`）——所以合并完 `restore` 之后再问 transcript 要一份，
  写盘用那一份。这一改把「文件里的数」和「面板上的数」变成同一个来源。
- `lib/index.js` 的 `restore` 注释按 D-60 重写：不是拒绝，是合并一次。
- cap 变异条的 `why` 改成实际机制：`survivors.length >= dated.length`，变异只让
  `excess` 变大，`slice(0, excess)` 超出长度后退化为「删掉全部可定年龄的文件」。

### 新增断言（四组，全部探针证伪）

| 断言 | 探针（破坏后） |
| --- | --- |
| 只有回合数的会话也写盘，且写出它达到的那个数 | `hasFacts` 返回 false → **193 passed, 2 failed** |
| 重用同一实例再读，计数不翻倍，且两处一致 | 去掉 restore 后的重取 → **194 passed, 3 failed** |
| 记录抓到的旧 snapshot 不会写回文件 | 同上，`written?.turns === 3` 而不是 8 |
| 事件先到、还没 turn/end 就打开面板，仍看到历史 | `viewOf` 从内存提前返回 → **58 passed, 2 failed** |

第三组第一次写时探针**存活**：stub 的 `snapshotOf` 返回同一个对象，`restore` 改
`live.turns` 时记录里的 snapshot 跟着变，陈旧值永远不会显得陈旧。改成每次返回新对象
（真实 `index.js` 就是这样）之后才被杀。这是本仓库第三次踩「测试替身太好客」：
替身共享了它本该复制的东西。

### 一处等价变异，判明后不加测试

把「合并时不加 snapshot」改回「相加」仍然全绿——因为后面无条件重取会覆盖它。
那不是漏测，是那条分支已经没有可观测后果。留着它是因为顺序上仍需要
`current.snapshot` 在 `restore` 之前有个值（`document()` 可能在 `restore` 之前被调用）。

### 数字

```
node test/run.mjs                          2229 passed / 0 failed
node test/session-state.test.mjs            197 passed / 0 failed
node test/persistence.test.mjs               60 passed / 0 failed
node test/api.test.mjs                      176 passed / 0 failed
scripts/mutate-persistence.mjs               43 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs             15 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs           64 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                        14/14 mutations killed
scripts/mutate-guards.mjs                    11/11 mutations killed
全仓 CRLF                                    0（141 个文件）
node scripts/sync-gutter.mjs                 幂等（sha256 6a85366f…）
```

### 两个坑

1. **回归与变异脚本不能并行跑。** 变异脚本会把破坏后的源码写到 `lib/` 下再还原，
   并行运行的回归套件读到的是变异体：本次得到「2032 passed, 1 failed」和 6 条
   互不相干的失败（清扫后文件又回来、cap 挤掉的会话还在），单独跑同一套件是
   197 passed。判据：失败集中在「源码正在被临时改写」才说得通的那些断言上。
2. **变异锚点里的 `${...}` 与引号不能过 bash heredoc。** `from` 字段本身是 JS 字符串，
   里面既有反引号模板又有单引号，用 `python - <<PY` 写会在三层引号里被吃掉一层，
   报 `SyntaxError: Unexpected token 'function'`。改成写 `.py` 文件、按 `label:` 行
   定位、**整行替换**，并在写盘后用同一套解码规则把 `from` 反解回源码文本数一遍
   匹配次数（期望 1），才算敢跑。

### 真正该记住的

- **「内存里有」不是「内存里新」。** 一个从第一条事件就能建出来的对象，
  不能当作「不需要再读盘」的证据；判据必须问那个真正知道答案的东西（这里是 `loaded`）。
- **一个数只有一个作者。** 回合数相加如果 `session-state` 和 `transcript` 各做一次，
  面板和文件必然分叉；把相加留给唯一有资格的一方，另一方去问它要结果。
- **测试替身必须复制，不能共享。** 返回同一个可变对象，等于让被测代码改了替身也改了期望值，
  陈旧与新鲜就分不出来。

## 2026-11-06 · 第十三轮代码审查的修复：抽出来的判据，要走过去的人用

### 报了什么

一处 P2，一处 P3，都在上一轮我自己改过的地方。

| # | 级别 | 症状 | 位置 |
| --- | --- | --- | --- |
| 1 | P2 | 只有回合数的会话文件，会被自己进程的退出删掉 | `lib/session-state.js` 的 `dropIfOrphan` |
| 2 | P3 | D-65 没有声明取代 D-60，查 D-60 的人会读到与代码相反的绝对句 | `docs/handover/02-decisions.md` |

第 1 条是上一轮的直接后果：D-66 把 `turns > 0` 加进 `hasFacts`，但 `dropIfOrphan`
里还有第三份「空」的判据，它自己重数技能、工具和 `previous`，**不认回合数**。
于是 D-66 要保住的那类文件，被同一个模块的另一处当孤儿删掉。

触发条件是两个宿主进程共用一个 `plugin-data` 目录：A 先 `load` 到空盘（记录标成
`empty: true`），B 写下只有回合数的文件，A 退出时 `release → flush →
document() === undefined` 走进 `dropIfOrphan`，B 的文件消失。审查者用真实的
`SessionStore`/`SessionState`/`TranscriptStore` 复现了：A 退出后目录为空，重启后
回合数从 4 变 0，**而且没有日志**。

### 怎么修的

把判据抽成 `keepsDocument(facts)`，接四个事实：`skills`、`tools`、`previous`、`turns`。
两个读者各自映射形状，判断只有一份：

```js
function keepsDocument(facts) {
  if (facts.skills.size > 0 || facts.tools.size > 0) return true
  if (facts.previous !== undefined && facts.previous !== null) return true
  return Number.isFinite(facts.turns) && facts.turns > 0
}

function hasFacts(entry) {
  return keepsDocument({
    skills: entry.skills,
    tools: entry.tools,
    previous: entry.snapshot?.previous,
    turns: entry.snapshot?.turns,
  })
}
```

`dropIfOrphan` 里换成同一份调用的磁盘版（`previous` 与 `turns` 从文档顶层读，
`readState` 不返回它们）。注释里写清这是第三个读者、前两次分叉各造成什么后果。

### 新增断言（探针证伪）

两条，都是「两个进程 + 只有回合数」：

```
the first process reads an empty disk          loaded === false
the second process writes the count down       written?.turns === 4
a count is not an orphan                       files include counted.json
and the count survived the other process leaving   kept?.turns === 4
```

探针：把 `turns: found.value.turns` 改成 `turns: undefined` →
**199 passed, 2 failed**，正是后两条。源码还原后 sha256 = `123b3195…`。

### 一处「等价变异」，改成让判据互不遮挡

改完之后 `an empty record deletes a file that holds a finished turn` 这条变异变成
**等价变异**：真实文档里只要有 `previous` 就必然有 `turns > 0`，所以 `keepsDocument`
的前两条判据在磁盘侧互相遮挡，删掉 `previous` 那条时 `turns` 顶上，结果不变。

这不是漏测，是那条判据在当前形状下没有独立的观察面。处理方式不是删掉它，而是
让种子文件只带 `previous`、`turns: 0`——那就是它独自负责任的形状。改完这条变异
重新被杀（1 failed）。

同一条道理，`turns` 那条变异原本锚在 `hasFacts` 的旧实现上（已被映射函数取代），
锚点改到 `keepsDocument` 的返回行。

### 数字

```
node test/run.mjs                          2233 passed / 0 failed
node test/session-state.test.mjs            201 passed / 0 failed
scripts/mutate-persistence.mjs               44 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs             15 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs           64 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                        14/14 mutations killed
scripts/mutate-guards.mjs                    11/11 mutations killed
全仓 CRLF                                    0（141 个文件）
```

### 真正该记住的

- **「把判据抽出来」只对当时在场的读者成立。** 下一个读者出现时不会自动走到那份判据
  前面，它只会按自己看到的字段重数一遍。抽完之后要问：这个问题的答案现在有几个持有者？
- **等价变异不一定是漏测。** 也可能是两条判据在当前输入形状下互相遮挡。这时候该改
  的是输入形状，让它落到只有那条判据负责的区域——删掉判据只是把遮挡关系藏起来。
- **D-xx 的推翻要写「取代」。** 只描述新行为、不写旧编号，等于让下一个查旧条目的人
  读到一句与代码相反的话，而且没有任何线索。

### 勘误（第十四轮审查）：上一节的失败条数写错了

上一节「一处『等价变异』，改成让判据互不遮挡」的末尾写着：

> 改完这条变异重新被杀（1 failed）。

**实测是 2 failed。** 把 `dropIfOrphan` 里 `previous: found.value.previous,` 改成
`previous: undefined,` 之后，种子（`turns: 0` + 有 finished turn）的两条断言同时变红：

```
199 passed, 2 failed
  FAIL a file that holds only a finished turn is not an orphan — []
  and the turn it held is still there
```

原因正是那一节自己讲的道理：种子改成 `turns: 0` 之后，这个块里 `previous` 是唯一
判据，所以它同时支撑「文件还在」和「里面的回合还在」两条断言。写成 1 是我按上一版
种子的记忆写的，没有按当次运行的数字写——D-54 要求文档里的数字必须是当次运行的实数，
这里违反了一次。源码还原后 sha256 = `123b3195…`。

另删掉 `test/session-state.test.mjs` 里 talked 块声明却从未使用的 `stateB`：那个块的
「第二个进程」是直接 `storeB.write` 一份文档（因为本模块没有任何路径会产出「有 finished
turn 但没有计数」的文件），留一个活的 `SessionState` 会让读者以为两个块建模了相同的
进程模型，而只有 counted 块是这样。

### 勘误（第十五轮审查）：上一条勘误里的编号与归因都写错了

上一条勘误有两句话不成立，两处都是引用别处的规矩，引用时没有回去核对。

1. **编号错。** 原文把「文档里的数字必须是当次运行的实数」归给 **D-54**，但 D-54 是
   「『有没有内容』只有一个判据」，讲数字的是 **D-53**（变异锚点跟着代码走，报告的数字
   必须当场复跑）。D-54 恰好是这一轮改动的主角，把数字规矩挂在它名下，会让查 D-54 的人
   读到一条与主题无关的指控——而这一节末尾刚强调过 D 编号不能乱引。
2. **归因错。** 原文说写成 1 是「按上一版种子的记忆」，但上一节自己写着改种子之前那条
   变异是**等价变异**（即根本没被杀，实测 `201 passed, 0 failed`），所以「上一版的记忆」
   只可能给出 0。而该块两条断言完全由同一个判据耦合——文件被删则两条同红，文件保留则
   两条同绿——任何种子下都只能出 0 或 2。**1 只可能来自这个块还只有一条断言时的旧运行。**
   真实原因是我把旧运行的数字抄了过来，没有在改完之后重跑。这正是 D-53 说的那件事。

两处都只错在文字，代码与实测数字（199 passed, 2 failed）没有问题。

#### 第二处：talked 块的注释说过头了

同一个块里我写「本模块没有任何路径产出『有 finished turn 但没有计数』的文件」。这不成立：

`load()` 在 `packages/ui-evolve/lib/session-state.js` 里，只要 `turns` 或 `previous`
有一个存在就把两者原样塞进 `snapshot`，随后 `document()` / `flush()` 会一字不差写回。
实测（写一份 `turns: 0` + `previous` 且带哨兵字段的文档，`load` 后 `release`）：

```
turns: 0 | previous.said: kept | sentinel: undefined
rewritten: true
```

文件被重写、`turns` 仍是 0、`previous` 仍在，哨兵消失证明确实重写过。准确的说法是
**本模块不会从实时事件原创出这种形状**（计数只增，且 finished turn 就是结束那一轮的那份），
而不是「没有路径会写出它」。结论不变（该块仍需用 `storeB.write` 造种子），但绝对化的措辞
把一个可复现的反例留在了注释外。注释已按这个说法重写。

第十五轮的整体判定是「这批修改可以算正确」，三处均为文档与注释的表述精度，不影响行为。

---

## 2026-11-06 · 界面六项需求与实时流：把「猜」换成「被告知」

### 用户报的六件事

基础功能验证通过、重启不丢数据之后，用户在真实宿主里逐条看了界面，报回六条：

| # | 原话要点 | 落在哪 |
| --- | --- | --- |
| a | 上一轮卡片的「调用/命令/文件」统计应该贴右，不要紧挨标题 | `.dsse-head-stats` |
| b | 这些数字能不能实时更新（当时是 8 秒轮询） | `/live` + `LiveHub` |
| c | 标题下方什么都没有，却空出一条；另外两张卡也一样 | `.dsse-card-head` |
| d | 字体再小些、行数 5→6、**不要 hover 展开**，改成 hover 显示提示、点击才展开，触发域越大越好 | `Card` / `.dsse-expand` |
| e | 进对话区域时数据加载不全，加载时应该显示「正在加载」 | `Cards` 渲染门 |
| f | 卡片会出现在非会话页面，应该只在会话界面显示 | `data-content-phase` |

(a) 与上一轮的「统计紧挨标题」（`margin-left:4px`）相反，属于用户看到实物之后改主意，不是回归。

### 六条各自的根因

**(c) 是最有教育意义的一条**：`.dsse-card-head` 上写着 `min-height:42px`，那是为「从本轮提炼」按钮定的高度。按钮在前几轮被删掉，`min-height` 留了下来，于是标题行只剩一行字、下面空出约 40px。三张卡共用 `Card` 组件，一处遗留变成三处——用户说「其他两个卡片也有同样情况」时，原因是同一个。

**(d) 的难点不是加提示，是改语义**。`expanded` 原写成 `turnExpandable === true && (turnHovered === true || turnPinned === true)`，加一个提示条很容易，但 hover 仍然会展开。改完立刻有 4 条断言变红——它们检查的正是旧语义，说明既有测试**按旧契约在找证据**，不是没测到。

**(f) 先否定了一个想当然的判据**：「找得到 `[data-conversation-content]` 就是有会话」是恒真的，宿主在三种页面上都渲染那个元素。正解是读宿主自己在同一元素上发布的 `data-content-phase`（`active` / `settling` / `hero`）。

**(e) 是第二版**。历史上这个问题被修过一次，当时改成「加载期间什么都不画」——那走得太远：面板整个消失，人看到空洞却分不清是在加载还是没有内容。往前那版更糟：画一整列空卡片加 reading…，随后整体消失，是闪烁。第三版只在会画出空白的那一行位上多一行「正在加载…」，判据 `data === undefined` 用来区分「还没答」与「答了但确实空」。

**(b) 的做法是事件流**：服务端 `LiveHub` 在被消费的 `session/event` 之后 publish 一次，客户端 `EventSource` 订阅 `/api/ui-evolve/live?agent=<id>`。流里**没有载荷**，只有「这个会话动了」；内容仍由 `/panel` 唯一装配。`transcript.record()` 因此改成返回 boolean——宿主把每个事件都送进来，`session/token` 这类不会画出任何卡片的事件不该唤醒客户端。

### 四轮审查改了什么

| 轮 | 采纳 | 最值得记的一条 |
| --- | --- | --- |
| R-32 | 2 P2 + 5 P3 | HEAD 会进 SSE 分支并永不结束（每次探活泄漏一个订阅）；phase 变化没有独立触发源 |
| R-33 | 1 P2 + 1 P3 | 流打开后**永久停掉**兜底轮询，而 `EventSource` 对不可用响应会放弃重连、全局候选队列也没人管了 |
| R-34 | 1 P2 + 1 P3 | `openPairs` 的守卫在新交互下**静默空转了一整轮**，套件仍报 322 passed |
| R-35 | 0 | 收敛 |

**R-33 的第二层理由是我自己没想到的**：即使流健康也有洞——服务端只在本会话的事件上 publish，而 `/panel` 里的 `pendingCandidates` 读的是**全局**候选队列。别的会话写入候选时这里收不到任何通知，被删掉的轮询是它唯一的手段。所以修法不是「修好流的重连」，而是「降频到 60 秒、不删除」。

**R-34 是本轮最贵的一课**：那段循环注释声明它保护「渲染成展开态的卡片一定有办法关掉」，但前提 `data-expanded === 'true'` 在 hover 不再展开之后恒不成立，两棵树都是关的，几条 `check` 一次都没执行。把 `client.js` 换回 HEAD 版跑同一条探针，输出 `false` / `true`——**说明这是我把它改成空转的**。修法是把前提本身变成断言：先点开、再取两棵树、每棵显式断言 `data-expanded === 'true'`，然后才断言可关闭性四要素。`client.test.mjs` 从 322 涨到 327，多出来的就是原来从没跑过的那几条。

### 当前数字（2026-11-06 实测）

```
node test/run.mjs                   2355 passed / 0 failed
node test/client.test.mjs            327 passed / 0 failed
node test/live.test.mjs               70 passed / 0 failed   ← 新建
node test/persistence.test.mjs        71 passed / 0 failed
scripts/mutate-live.mjs               26 killed / 0 survived / 0 not applied / 0 crashed   ← 新建
scripts/mutate-checklist-panel.mjs    65 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                 14/14 killed
scripts/mutate-persistence.mjs        44 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs      15 killed / 0 survived / 0 not applied / 0 crashed
全仓 CRLF                             0（109 个 git 追踪文件，按字节扫）
sync-gutter 连跑两次                  client.js sha256 恒定
```

组件测试从 286 条涨到 327 条，全量从 2233 涨到 2355 条。

### 这一轮踩到并值得传下去的坑

1. **带前提的断言必须让前提失败时也失败。** `continue`、`if (...) { check(...) }`、`?.` 后面跟的断言都有这个形状。空转与通过在这套 harness 里长得一样，都只是一行 tally，而且它对任何变异都不敏感——只会让所有变异都「存活」。
2. **测试替身能表达的失败模式只有作者想到的那些。** `EventSourceStub` 只会 `fire('open')` / `fire('panel')`，从没有「打开后永久失败」这个动作，于是 DEF-34 那类缺陷在测试里不存在。
3. **测试桩太省事会掩盖行为。** `setInterval` 桩写成 `() => 0` 时，「轮询被清掉」这件事在 harness 里根本无法观察——不是断言写错，是行为不存在。桩必须保留 handle。
4. **判断「是 JSON 不是流」不能看响应头。** JSON 路径也调 `writeHead`。判据只能是「什么都没流出去」（`chunks.length === 0 && ended === true`）。
5. **探针必须改行为，不能改结构。** `new MutationObserver(() => {})` 能拿到干净的 1 failed；换成 `phaseObserver = null` 会崩在 `observe` 上，一行 tally 都不打印，被变异脚本记成 CRASHED。
6. **变异脚本要核对文件真的还原了。** `scripts/mutate-live.mjs` 每条之后重读文件比对原内容，不一致记 `CRASHED (file was not restored)`——这比一次失败严重，因为下一次运行读到的树已经不是被测的树。
7. **`git ls-files | xargs grep -lU $'\r'` 在这套 bash 下会把全部文件误报成 CRLF。** 只能用 Node 按字节扫。
8. **多行锚点用反引号模板串，不走 python。** 用 python `open(p,'w')` 写带 `\n` 的锚点时，heredoc 里的 `\n` 会变成真实换行，把字符串字面量拆断成 `SyntaxError`。这是本轮第二次踩。

### 下一步的合理顺序

1. **启动器页面的「显示/隐藏」开关**：现在 `hero` 时直接隐藏，若用户想要「新会话页也显示一个空的占位」，那是另一个决定，需要先问。
2. **`settling` 期间是否显示卡片**：目前只挡 `hero`，`settling` 照常显示。用户没提过，实测也没见到问题，但这是唯一没有被需求覆盖的一档。
3. **轮询 60 秒这个数字**：它买的是「流死掉之后面板仍会自愈」，代价是安静会话每分钟一次请求。若真实使用中发现候选队列更新太慢，应调这个常量而不是删掉轮询。

## 2026-11-06 · 撤回实时流：把「更快」收回成「更全」

### 用户的决定

> 那我决定放弃这个需求，你可以取消相关实现，不实时显示，我认为这样会占用资源，
> 实际体验并不好。现在开始将这三个待办全部进行处理

上一节（界面六项需求 + 实时流）刚给面板接上 SSE。这一节把它整个拆掉。

### 拆掉了什么

下表逐行对应 `git diff --name-status -- packages scripts test` 的 11 项，
行尾的 `+/-` 来自 `git diff --numstat -- packages scripts test`，合计 71 / 1576。

| 文件 | 动作 | +/- |
|---|---|---|
| `packages/ui-evolve/lib/live.js` | 删除（`LiveHub`，108 行） | −108 |
| `test/live.test.mjs` | 删除（519 行） | −519 |
| `scripts/mutate-live.mjs` | 删除（351 行） | −351 |
| `packages/ui-evolve/README.md` | 路由表去掉 `/live`；「How it learns」改成定时器并说明撤回理由；删掉「按流重读 `/panel`」那句 | +19 / −31 |
| `packages/ui-evolve/lib/api.js` | 删 `LIVE_PING_MS`、`streamLive()`、`/live` 的 GET 与 HEAD 两个分支、`deps.live` 的 JSDoc | −130 |
| `packages/ui-evolve/lib/index.js` | 删 `LiveHub` 导入、live 段、`publish()`；`session/event` 回到无条件 `transcripts.record()` | +1 / −40 |
| `packages/ui-evolve/lib/transcript.js` | `record()` 从返回 boolean 改回 void，八处 `return true/false`（5 真 3 假）清成裸 `return` | +7 / −16 |
| `packages/ui-evolve/lib/client.js` | 删 `IDLE_REFRESH_MS`、`openLive()`、`slowDown`/`stopPolling`；轮询回到 `const timer = setInterval(() => load(true), REFRESH_MS)` | +6 / −96 |
| `scripts/mutate-checklist-panel.mjs` | 补三条 phase 变异（`hero` 门控的三个方向），并修掉其中一条与另一条重叠的 | +21 |
| `test/client.test.mjs` | 删 `EventSourceStub`、`eventSources`、`evaluate` 的 `EventSource` 形参，以及整块流断言（11 条 `check`） | +17 / −118 |
| `test/persistence.test.mjs` | 删 `fakeHost().stream()` 与整块流端到端断言 | −167 |

撤回本身（`packages/`、`scripts/`、`test/` 三棵子树，README 也在其中）净减少 **1505 行**——`git diff --shortstat -- packages scripts test` 实测 11 个文件、71 insertions / 1576 deletions。四份 handover 的追加不计在内。

### 三条待办的处置

1. **启动器页**：保持隐藏，代码不改。
2. **`settling` 期间**：正常显示。补断言 `a conversation being opened draws its cards`，
   并写成 D-75——这是唯一没有被任何需求覆盖过的一档。
3. **60 秒轮询**：随流撤回而消解，`REFRESH_MS = 8000` 恢复为唯一恒定通道。

### 为什么撤回是对的（技术上）

流替面板做的事，比它拿走的少：

- 流只替**一个会话**说话，而 `pendingCandidates` 读的是**全局**候选队列。
- `files` 的 size/mtime 来自 `statTouchedFiles()` 的**现场 `stat`**，别的进程改文件
  不产生任何会话事件——这条通道本来就不由事件驱动，只是过去 8 秒一次的定时器顺带覆盖了它。
- 于是「让流当快路径」的真实代价是：**唯一覆盖这两件事的通道从 8 秒放慢到 60 秒**。
  这不是更新鲜，是更窄。D-73 承认了这一点（降频而非停止），D-74 把结论走完。

### 当前数字

```
node test/run.mjs                  2264 passed / 0 failed
node test/client.test.mjs           317 passed / 0 failed
node test/persistence.test.mjs       60 passed / 0 failed
scripts/mutate-checklist-panel.mjs   68 killed / 0 survived / 0 not applied
scripts/mutate-guards.mjs            11/11 killed
scripts/mutate-persistence.mjs       44 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs     15 killed / 0 survived / 0 not applied / 0 crashed
test/mutate-panel.mjs                14/14 killed
全仓 CRLF                            0（`git -c core.quotepath=false ls-files` 112 个，减掉本轮删掉的三项 = 磁盘上 109 个）
sync-gutter 连跑两次                 client.js sha256 不变（幂等）
```

### 本轮踩的坑

1. **`lines[N-1]` 才是第 N 行。** 三次按行号删除都靠 `print(repr())` 打首尾核对救回来；
   只靠 `awk`/心算会多删少删。删 `openLive` 时第一次就算错了边界（`lines[117]` 是 `}`、
   `lines[119]` 才是 `/**`）。
2. **删测试 helper 要数清收尾花括号。** 删 `fakeHost().stream()` 时多删了 `  }` 与 `}`，
   报 `SyntaxError: Unexpected identifier 'fakeSession'`。
3. **变异重叠不等于覆盖。** `phase === undefined` 与 `phase === "nowhere"` 是同一个变异
   （`place.phase ?? ""` 让 `phase` 永远不是 `undefined`），却被记成 `2 killed`。
   这是「全绿但没测到」的第三种形态（DEF-36 断言空转、DEF-37 行为不可观察、DEF-38 变异重叠；
   DEF-41 是本轮新增的第四种：数字无出处）。
4. **删功能要 grep 两次。** 先 grep 技术名词（`stream`/`EventSource`/`/live`），
   再 grep 它留下的**动词短语**（「按流重读」）——后者不含任何可搜的热词，最容易漏。
5. **交叉引用没有机器检查。** README 引用 `D-74` 时该编号并不存在，测试、
   变异、构建全都不会因此变红。
6. **`git ls-files` 默认给中文路径加引号转义。** 默认 `core.quotepath=true` 会把
   `docs/00-文档索引.md` 输出成带双引号的转义串——引号里面是 `\346\226\207` 这样的八进制字节，而不是汉字，
   于是 `git ls-files | while read f; do [ -f "$f" ] && echo x; done` 对这 9 个中文
   路径全部落空，112 数成 100。**把 `git ls-files` 的输出当路径用之前，先加
   `-c core.quotepath=false`**（详见 DEF-42）。

### 已知缺口（本轮未处理）

- `REFRESH_MS = 8000` 没有任何测试或变异覆盖。撤回让它成为唯一通道之后，这个常量
  更加无保护。
- README 的「Every route answers `HEAD` with a body-less 200」对 `/propose` 不成立
  （该路由只有 POST 分支，HEAD 落到 404）。这是 `c22ec9a` 就有的错误。
- 文档里的 `D-xx`/`DEF-xx`/`R-xx` 交叉引用没有测试守着。若要根治，应当在
  `test/` 下加一条「文档中出现的编号必须在对应索引表里存在」。

## 2026-11-07 · 展开按钮改圆标：把「一行字」换成「一个位置」

上一批的收尾是「撤回实时流」，六项界面需求里最后落地的是「点击才展开、hover
只提示」。提示当时是**卡片下方的一行整宽文字**，并因此在 D-69 里记下一条代价：
hover 进出会挂载/卸载它，卡片长高 26px。

### 用户的四条要求，逐条对应

| 用户原话 | 落地 |
|---|---|
| 「按钮是显示在卡片的内部的底部」 | `position:absolute` 挂在 `.dsse-card{position:relative}` 底边 |
| 「并且是圆形的」 | `border-radius:999px`，26×26 |
| 「用图标表示展开的」 | chevron `svg`（`d` 随开合翻转），不是文字 |
| 「按钮要居中显示」 | `left:50%;transform:translateX(-50%)` |
| 「展开后还要显示收起按钮」 | `turnHinted` 展开态无条件为真，文案 `点击收起全文` |
| 「不要挡住文字导致无法看全」 | 展开态 `.dsse-card-body{padding-bottom:44px}` |

### 三条实现的要点

1. **离开文档流，权衡就消失了。** D-69 的 26px 是在「遮住正在读的那行」与「把
   文字在指针下推走」之间挑一个便宜的。`position:absolute` 让两个都不发生。
2. **收起是唯一回路，不能挂在 hover 上。** `turnHinted` 从
   `turnPinned === false && turnHovered` 改成 `turnPinned === true || turnHovered`：
   折叠态仍要 hover（每张卡常亮一个「展开」是在喊还没发生的事），展开态无条件
   （读者最想找出口的时候，指针往往已经离开）。
3. **44px 的算术要能算出来。** 文件里没有 `box-sizing` 声明，默认 content-box，
   圆钮 26 + 2×1px = 28px，`bottom:8px` 使其顶端距内底边 36px，余 8px。审查
   独立复算了这一步。

### 两条 P3，都在文档侧

| 轮次 | 问题 | 处置 |
|---|---|---|
| R-40 | README 仍写「摘要下方居中一行」+「hover 增高 26px」 | 整段重写为三段（形状位置 / 不占布局 + 算术 / 为何无 `title`） |
| R-40 | `title: props.expandHint` 因 `pointer-events:none` 永不弹出 | 删掉，注释解释原因（DEF-43） |
| R-41 | 行为推翻 D-69 两条代价，决策记录没补 | 补 D-76、D-77，索引表 D-69 注明代价被取代（DEF-44） |

第二轮审查明确写「代码侧可以视为收敛」，第三条纯属记录滞后。**这与前一批 12 条
P3 里 11 条出在文档是同一个模式**：代码有断言和变异守着，文档没有。

### 当前数字（全部本轮实测）

```
node test/run.mjs                    2277 passed / 0 failed
node test/client.test.mjs             330 passed / 0 failed
scripts/mutate-checklist-panel.mjs     78 killed / 0 survived / 0 not applied
scripts/mutate-guards.mjs              11/11 killed（after restore: 2277 passed）
scripts/mutate-persistence.mjs         44 killed / 0 survived / 0 not applied
scripts/mutate-session-store.mjs       15 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                  14/14 killed
全仓 CRLF                              0（109 个 git 追踪文件，Node 按字节扫）
sync-gutter 连跑两次                   client.js sha256 恒为 bc752e36…
```

### 踩过的坑

1. **旧变异锚点会静默过期。** 把 `right:8px` 改成 `left:50%` 之后，
   `the expand button pushes the card taller when it appears` 的 `from` 不再命中，
   幸好脚本有 `NOT APPLIED` 兜底。**改样式的形状时，要同时 grep 变异脚本。**
2. **同一个视觉结果可以有不同的理由，锚点却只有一个写法。** `the chevron points
   down even when the card is open` 与 `an open card offers to open itself again`
   都必须各自唯一命中，改完要先数 `label:` 与 `grep -cF`。
3. **`git ls-files` 输出格式**（DEF-42）在这套 bash 下会因 `core.quotepath` 把中文
   路径转义，数文件数必须加 `-c core.quotepath=false`。

## 2026-11-07 · 总结语言与产出卡：把「猜」换成「被告知」，把「这一轮」换成「这个会话」

这一轮两条需求，一句话各自概括：

| 需求 | 用户原话 | 一句话 |
|---|---|---|
| 1 | 「总结有的时候会变成英文，你需要设置一个自动获取当前宿主语言，并且让总结为对应语言」 | 界面语言由宿主发布，别让模型从对话里猜 |
| 2a | 「技能和mcp显示的增量列表吗？…相当于会话的信息展示」 | 技能/MCP 卡**本来就是**会话累计，无需改动 |
| 2b | 「产出栏也不应该做成每一轮的产出显示，而是增量列表…修改已经在列表中的，就将顺序提前」 | 产出卡从「这一轮」改成「这个会话」，按最近修改排序 |

需求 2 的范围被用户在两轮之间澄清过（`m08413`）：「我只是做一个比喻，而不是现在要
更改上一轮卡片展示的逻辑，此需求不涉及上一轮卡片的内容修改，只修改技能和mcp卡片和
产出卡片」。所以这一轮**没有**改上一轮卡片的展示逻辑——只给它换了一个数字来源（见下）。

### 六条实现的要点

1. **语言只是被要求，不高明。** `document.documentElement.lang` → `?lang=` →
   `languageLine()` → 提示词。模型不再被要求「推断用户读什么语言」。
2. **中文分字形。** `zh-CN`/`zh-SG`/`zh` 简，`zh-TW`/`zh-HK`/`zh-MO`/`zh-Hant` 繁。
   只说 `Chinese` 会让模型任选，对只读一种字形的读者等于半个总结。
3. **表内 11 种，表外有别。** 封闭表而非透传：多写一句「用 ru 写」而读者读英文，等于
   把猜测还回去。表外但形态合法 → 通用兜底句，**不退化成沉默**（DEF-46）。
4. **缓存键用渲染后的句子，不用语言名。** 表外标签的 `languageName` 是 `undefined`，
   用它做键会让 `lang=nl` 与无 `lang` 共用缓存，而两者提示词不同（DEF-48）。
5. **产出卡的 `paths` 与 `skills`/`servers` 共用 `sequence` 时钟。** 三种事实都是
   「最近用过的排前面」，各自维护计数器只会让「最近」在两处含义不同。
6. **上一轮卡片的文件数改成单轮的 `turnFiles`。** 累计化之后，同格里 `calls`/`commands`
   仍是单轮数，文件数若跟着变成累计，三个数字看起来是一组而其中一个换了口径（R-42 第 3 条）。

### 四轮审查

| 轮次 | runId | findings | 采纳 / 驳回 |
|---|---|---|---|
| 第一轮 | `5bb8e058` | 3 P2 + 2 P3 | 5 / 0 |
| 第二轮 | `e76a5eb5` | 3 P2 + 3 P3 | 6 / 0 |
| 第三轮 | `b0074f63` | 1 P2 | 1 / 0 |
| 第四轮 | `b9bdb395` | 0 | 0 / 0 |

累计 **12 条，驳回 0**。第三轮的 P2 是这批里最值得记的一条：`MAX_PATHS` 的实现完全
正确，但只加在 `rememberPaths` 一条路径上，`load` 的合并分支能绕过它，重启间
200→400→600→800 无界增长（DEF-49、D-81）。

**这一批 12 条 finding 的分布与上一批相反。** 上一批（撤回实时流）11/12 出在文档；
这一批 6 条出在**新写的测试自己空转或测不出区别**，4 条出在**新字段与既有代码的接缝**，
2 条出在文档。代码主线从头到尾是对的，错的是它和周围东西的接口。

### 当前数字

```
node test/run.mjs                    2387 passed / 0 failed
node test/summarise.test.mjs          144 passed
node test/session-state.test.mjs      235 passed
node test/api.test.mjs                186 passed
node test/persistence.test.mjs         71 passed
node test/client.test.mjs             338 passed
scripts/mutate-checklist-panel.mjs     81 killed / 0 survived / 0 not applied
scripts/mutate-language-and-files.mjs  21 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-persistence.mjs         44 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-session-store.mjs       15 killed / 0 survived / 0 not applied / 0 crashed
test/mutate-panel.mjs                  14/14 killed
scripts/mutate-guards.mjs              11/11 killed（after restore: 2387 passed）
全仓 CRLF                              0（109 个 git 追踪文件）
sync-gutter 幂等                       client.js sha256 恒定
```

### 踩坑清单

1. **python 写含 `\n` 的 JS 字符串会把 `\n` 变成真实换行**（本轮踩了三次），
   写源码里的多行锚点必须用 `edit` 工具。`s.count(old) == 0` 通常就是转义问题。
2. **python 读写含中文的源码必须显式 `encoding='utf-8'`**，默认 GBK 会抛
   `UnicodeDecodeError`，而如果这个异常发生在变异脚本的写文件阶段，测试照常全绿、
   变异静默未应用——最危险的一种失败。
3. **探针必须改行为不改结构。** 把 `const spoken = languageLine(language)` 整体换成
   `languageName(language)` 会让 `.length` 在 `undefined` 上抛错、测试崩溃无 tally，
   等于什么也没证明。
4. **断言移出 `if` 之后要用 `?.` 调用。** 裸 `poll.fn()` 会把「fixture 变了」变成崩溃，
   变异脚本拿到无 tally 记成 SURVIVED——一条真实覆盖缺口被伪装成存活。
5. **改函数签名或把单行改成块，会让别的文件里的变异锚点静默过期。** 本轮
   `test/mutate-panel.mjs` 与 `mutate-persistence.mjs` 各有一条因此失效，靠
   `MISSING ANCHOR` / `NOT APPLIED` 发现。改完源码要重跑全部变异脚本。
6. **加一个上限时问的是「有没有第二条产生超限数据的路径」**，不是「写入的地方裁了没有」。
   `MAX_PATHS` 的漏洞在合并分支（DEF-49）。

## 2026-11-08 · 实时输出速度：给「还在动吗」一个数字

### 需求原话

| # | 用户原话（`m10153`） |
|---|---|
| 1 | 「我想要的是实时的速度计算，这样更能表现实际的输出表现」 |
| 2 | 「实际显示速度的区域在插件界面顶部的设置按钮和建议按钮中间，这一部分刚好是空着的」 |

前一轮问的是「DSH 的 tok/s 是平均还是实时」，答案是**整个会话的加权平均**
（`decodeTokens / decodeMs`，跨所有上报 usage 的步骤累加），到第二十轮时它主要在描述前十九
轮。这个需求要的是另一个问题的答案。

### 六条实现要点

1. **采集**（`packages/ui-evolve/lib/speed.js`，新增）：每个 `text-delta` 记
   `(时间, ceil(len/4))`，读数 = 两秒窗口内 token ÷ 窗口秒数；除数下限 500ms。
2. **校正**：`usage` 落地时把「provider 计数 ÷ 我们的估算」记成比例，上下限 0.25..4，应用到
   之后的估算上。分子分母都只算文本——减掉 `reasoningTokens`，带 `tool-call` 块的消息整条
   不参与（D-84）。
3. **通道**：监听 `agent/assistant-stream` 的 `chunk` frame，`text-delta` 才 push；
   `start` frame 清累加量但保留窗口（D-83/D-85）。`assistant/chunk` 是**不存在的通道**——
   宿主生产代码里 `append("assistant/chunk"` 出现 0 次，那 28 处命中全在 v1→v2 迁移 codec
   里，且被 `retained` 明确筛掉。
4. **路由**（`packages/ui-evolve/lib/api.js`）：新增 `GET|HEAD /api/ui-evolve/speed?agent=<id>`
   → `{ tokens, ms, tps, active }`；缺 agent 400 `error.agent.missing`；主机端无 meter 时
   200 `error.speed.absent`（旧宿主的一半不该让整页失败）。
5. **显示**（`packages/ui-evolve/lib/client.js`）：`SpeedBadge` 插在「面板设置」与「建议」
   之间；三档节拍 250 / 2000 / 10000ms（D-86）；窗口空后最后读数留 4 秒；切换会话立刻清空
   （React 复用同一实例，不清就会显示上一个会话的速度）；`aria-live="off"`（D-87）。
6. **格式**：`>= 10` 取整、否则一位小数，与宿主胶囊一致（在 `47.3` 和 `47` 之间闪是噪声）。

### 五轮审查

| 轮次 | runId | P1 | P2 | P3 | 采纳 | 驳回 |
|---|---|---|---|---|---|---|
| 第一轮 | `4ee7146b` | 1 | 2 | 3 | 6 | 0 |
| 第二轮 | `948259b7` | 0 | 2 | 2 | 4 | 0 |
| 第三轮 | `72dd8f31` | 0 | 0 | 5 | 5 | 0 |
| 第四轮 | `41069f73` | 0 | 1 | 1 | 2 | 0 |
| 第五轮 | `cc42adda` | 0 | 1 | 1 | 2 | 0 |
| **合计** | | **1** | **6** | **12** | **19** | **0** |

第一轮的 P1 是决定性的：代码没有一处写错，错的是「宿主会派发什么」这个前提，而 2531 条
断言全在我自己搭的世界里运行。后四轮几乎全部是「注释与常量、断言与实现之间的数字对不上」——
代码有一万条断言和六套变异守着，注释只有下一个读它的人。

### 当前数字

```
node test/run.mjs                      2525 passed / 0 failed
node test/speed.test.mjs                 49 passed / 0 failed
node test/client.test.mjs               384 passed / 0 failed
node test/api.test.mjs                  201 passed / 0 failed
node test/index.test.mjs                261 passed / 0 failed
node test/mutations.test.mjs             36 passed / 0 failed
scripts/mutate-speed.mjs                 49 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs       81 killed / 0 survived / 0 not applied
scripts/mutate-language-and-files.mjs    21 killed / 0 survived / 0 not applied
scripts/mutate-persistence.mjs           44 killed / 0 survived / 0 not applied
scripts/mutate-session-store.mjs         15 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                    14/14 killed
scripts/mutate-guards.mjs                11/11 killed
全仓 CRLF                                0（113 个文件，Node 按字节扫）
sync-gutter                              幂等（client.js sha256 不变）
```

### 五条踩坑

1. **测试自己派发的事件证明不了宿主会派发它。** 第一版监听 `assistant/chunk`，测试
   `emit` 它，于是全绿；真实宿主里那个通道的 `append` 次数是 0。写监听之前先在宿主打包产物
   里数一遍。这是本轮唯一一条 P1，也是最便宜能被机器发现的一条——如果当时问一句
   「这个事件的派发点在哪」。
2. **等价变异不要靠加测试消灭，要靠删冗余判据消灭。** `settle` 原有四个守卫，每个都被
   下游一行遮住，变异测试如实报成「存活」。正确处置是把四个合成一个，而不是给每个补一条
   自欺的断言。
3. **锚点自检的下限写成「够用就行」的数字，检查强度也就是「够用就行」。** 新写的
   `['mutate-speed.mjs', 30]` 实为 49，`>=` 永不失败；成对删掉十九条变异它照样通过。
4. **注释里的数字要和常量一起改。** 五轮里十二个 P3 有十一个出在注释： 「半秒一次」实为
   十秒、「十倍」实为四十倍、「四秒陈旧」实为八秒、「每秒五次」实为四次、「Two clocks」
   实为三档。改常量的那一刻是唯一会想起注释的时刻。
5. **`||` 在断言里几乎总是可疑的。** `sessions.size === 0 || marks.length === 0` 让一条断言
   在两种情况下都通过，于是没有一种情况被真正锁住；而它掩盖的正是「`settle` 为每个 agent
   建了一条空记录」。

## 2026-11-09 · 徽章改常驻：把「只在发生时存在」换成「一直在，说清此刻」

用户两次报告「界面中没有看到对应的速度显示」，附截图：顶行只有刷新、齿轮、建议。上一节
（2026-11-08）交付的徽章，在服务端、路由、断言、变异、五轮审查全部通过的情况下，**对用户
来说不存在**。

### 四条要求

| 用户原话 | 落点 |
|---|---|
| 「目前在界面中没有看到对应的速度按钮」 | 徽章改为常驻：`known` 记住宿主管答过一次，之后一直画 |
| 「目前在界面中没有看到对应的速度显示」 | 空闲时画淡化破折号 `—`，不画 `0 tok/s`，也不留旧数字 |
| （上一节的）「实时的速度计算」 | 三档节拍与两秒窗口不变（D-82/D-86） |
| （回归保护）旧宿主不显示 | 一次都没答过 `/speed` 的宿主仍什么都不画 |

### 六条实现要点

- **`known` 状态**（`client.js:1224`）：`ask()` 成功返回后 `setKnown(true)`；渲染门从
  「值必须 > 0」改成 `if (known === false) return null`。判据是「这台宿主能不能测速」，
  而不是「此刻有没有数字」。
- **三态渲染**：live（窗口里有字）/ recent（linger 内，最后一个真实读数）/ idle（测过但当前
  无输出）。三者都画，差别只在数字还是破折号（D-88）。
- **idle 显示 `—` 而不是 0**：`0 tok/s` 是一次测量，声称正在以零速率输出；空闲时真相是
  「没有输出」，没有速率可说（D-88）。
- **`known` 跨会话保留、`held`/`reading` 切会话清空**（D-89）：两个状态描述的是不同的东西
  ——「这台宿主」与「这个会话」。
- **补回 `setTick`**：删旧 linger 代码时把它的 `useState` 声明一并删了，而 4 秒重绘定时器仍在
  调用它（DEF-58）。
- **`dsse-speed-idle` 样式**：`min-width` 56 → 44px，`opacity:.7`，`color` 走 tertiary。

### 四轮审查

| 轮次 | runId | findings | 采纳 |
|---|---|---|---|
| 第一轮 | `abfe568f` | 1 P2 + 1 P3（锚点下限仍 49、变异 `why` 描述错） | 2 |
| 第二轮 | `96f8babf` | 1 P3（README 与 `@returns` 停在「四秒后消失」） | 1 |
| 第三轮 | `449f535d` | 1 P3（README 把「不画徽章」的宿主范围说窄） | 1 |
| 第四轮 | `75985db9` | 无 finding，收敛 | 0 |

合计 4 条全部采纳、0 驳回。**四条全部出在文档与变异元数据，没有一条是代码缺陷**——但第一轮
那条 P2 如果放过，`mutate-speed.mjs` 可以在少一条变异的情况下报全绿。

### 当前数字

```
node test/run.mjs                        2530 passed / 0 failed
node test/client.test.mjs                 389 passed / 0 failed
node test/mutations.test.mjs               36 passed / 0 failed
scripts/mutate-speed.mjs                   50 killed / 0 survived / 0 not applied / 0 crashed
scripts/mutate-checklist-panel.mjs         81 killed / 0 survived / 0 not applied
scripts/mutate-language-and-files.mjs      21 killed / 0 survived / 0 not applied
scripts/mutate-persistence.mjs             44 killed / 0 survived / 0 not applied
scripts/mutate-session-store.mjs           15 killed / 0 survived / 0 not applied
test/mutate-panel.mjs                      14/14 killed
scripts/mutate-guards.mjs                  11/11 killed
全仓 CRLF                                  0（113 个文件，Node 按字节扫）
sync-gutter                                幂等（client.js sha256 44497e1c…）
```

### 四条踩坑

1. **断言写在「功能已经可见」的前提下，检测不到「功能在真实的第一秒里不存在」。** 29 条
   徽章断言全部通过，因为它们都在徽章已经渲染出来的世界里断言；而「用户在一个空闲会话上
   打开面板会看到什么」没被问过，当时甚至有一条反过来的断言
   （`a zero reading draws nothing`）。这是本轮唯一的真缺陷，也是最贵的一条。
2. **删一段逻辑时，它调用的状态声明也是这段逻辑的一部分。** 删 linger 相关代码时把
   `setTick` 的 `useState` 一起删了，而 4 秒重绘定时器仍在调用它；测试用注入时钟直接跳读，
   从未真的让定时器回调执行，所以全绿（DEF-58）。
3. **`why` 是后续读者判断这条变异为何存在的唯一线索。** 写成另一条变异的行为，会让两个
   不同的防护看起来重叠，而重叠的防护会被合并或删除（DEF-59）。
4. **判据写成「没有那条路由」时，实际判据往往是「一次都没成功答过」。** 路由存在不代表
   能干活：`200 {ok:false}` 同样走 catch（DEF-60）。

### 两条下一步（不属于本轮）

- **DEF-51 仍待办**：产出卡头部说「10 个文件」而列表只列 5 行，「全部 10 个」按钮在侧栏
  滚动区外看不见。用户 2026-11-07 决定与产出卡后续需求一并处理。
- **`scripts/mutate-speed.mjs` 的两条 `NOT MUTATED`**：`estimateTokens` 的非字符串分支
  （唯一调用方传宿主已校验的 `chunk.text`）、徽标的 `title` 属性（装饰，`aria-label` 才是
  被断言的）。两者都写在脚本的 `known` 数组里。

## 2026-11-09 · 速度显示最近几次平均

**需求原话。** 「我认为应该显示最近几次流式输出的平均速度，并且常驻显示」

**为什么不是简单地把窗口拉长。** 两秒窗口答的是「现在多快」，它在回复结束时必然说不出话；把窗口拉长到
几十秒，得到的是一个既不是「现在」也不是「刚才」的数字。所以改成两个数字共存：流式中看实时，停下来看
最近五条的加权平均。

| 状态 | 显示 | 触发条件 |
| --- | --- | --- |
| 实时 | 两秒窗口的 tok/s | 窗口里有 text-delta |
| 刚落幕 | 最后那个窗口读数（保留 4 秒） | 窗口刚空、且四秒内有过读数 |
| 平均 | 最近 N 次（≤5）的加权平均 | 有 settle 过、且不在上面两种状态 |
| 空 | 破折号 | 从未有任何消息落定 |

**六条实现要点。**
- `speed.js`：entry 增加 `messageAt` 与 `samples`；`push` 在累加量为空时打时间戳（一条消息二十个 delta
  只得到一个起点）；`settle` 记 `{ tokens: outputTokens, ms: span }`，`span` 也取下限 `MIN_SPAN_MS`；
  裁剪到 `AVERAGE_SAMPLES = 5`；新增 `averageOf`（`Σtokens / Σms`）。
- `read()` 先算 `average` 再 `prune` 窗口，三条 return 都带 `average` 字段（无条目时是 `null`）。
- `client.js`：`shown` 的三元改成四级；`standing` 态加 `dsse-speed-average` 与「最近 N 次的平均输出速度」
  文案；CSS 稍微调暗，因为它在描述刚过去的时段。
- `begin` 删掉 `entry.messageAt = 0`——`push` 会补，那行删掉无人能观测。
- `averageOf` 删掉 `ms <= 0` 守卫（每条样本恒 ≥ `MIN_SPAN_MS`），与 `settle` 里删掉被遮蔽守卫同一原则。
- 变异：50 → 58 条，**八条全部是新增、一条未删**（`begin` 那条 `messageAt` 变异没有删除，只是 `to` 补了
  `return` 以免崩溃）：不裁剪样本、从最后一个 delta 计时、burst 消息的 `MIN_SPAN_MS` 下限、无文本 settle
  也记样本、`forget` 保留 ratios、加权改成算术平均、空样本守卫、average 抢在 held 之前。

**当前数字。** `node test/run.mjs` = 2566 passed / 0 failed；`speed.test.mjs` 72；`client.test.mjs` 402；
七套变异 58 / 81 / 21 / 44 / 15 / 14 / 11 全杀；全仓 CRLF 0；`sync-gutter` 幂等。

**五轮审查。** 代码自第一轮起就被判定正确（「patch 正确」「未发现阻塞性缺陷」），此后四轮一共只报出
1 个 P2 与 8 个 P3，**全部是文档、台账与注释**：`averageOf` 的不可达守卫（DEF-61）、「有窗口无平均」
没有断言（DEF-62）、变异计数与 R-54 范围数字、四态注释自相矛盾、`read()` 的 return 个数、R-54 缺
runId、R-57 缺 R-55 小节、「全文唯一」表述过宽。合计 **0 P1 / 1 P2 / 8 P3，采纳 9，驳回 0**（见
`04-reviews.md` 的 R-54…R-58 与五轮累计表）。**这一轮在这里停下**，理由写在 R-58：从第二轮起每一轮
finding 都只关于台账，而修一条台账问题又会产出一条新的台账问题（补 R-55 时漏填 runId、补 runId 时把
范围说成「全文」），因为「记录这一轮审查」这个动作本身不可能先于它记录的审查存在。

**四条踩坑。**
- 改 `read()` 的返回结构会让两条旧变异的锚点静默失效（`NOT APPLIED`），改返回体必须 grep 变异脚本。
- 一条变异把 `push` 放在守卫之后，于是永远不可达 → SURVIVED 其实是「这条变异不成立」，要写成
  「把 push 挪进守卫内」才可观测。
- `begin` 里 `entry.message = 0` 与 `settle` 里同名两行并排出现，锚点必须带上 `const startedAt` 才能唯一。
- 变异 `to` 里删掉一行却留下对已删变量的引用（`entry.messageAt = 0` 在 `this.sessions.delete` 之后）
  会让测试崩溃无 tally，被记成 CRASHED 而不是 KILLED。

**下一步。** 五条样本是进程内状态，重启后归零；若要跨重启保留，需要把 `samples` 写进 session state
（与 `paths` 同一套平移规则）。
