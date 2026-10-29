# 状态路线图

> **追加式**。每节一次快照，不改旧的。最新一节永远在文件末尾。

| 日期 | 快照 | 一句话 |
|---|---|---|
| 2026-10-30 | 首次整理 | 22 个模块 11,939 行；1722 断言全绿；三个变异套件归零；清单卡片已推送 `051d8b6` |

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
