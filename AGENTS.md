# AGENTS.md

本仓库是 DeepSeek Harness 插件套件（`core` / `skill-evolve` / `ui-evolve` / `mcp-evolve`）。所有 AI Agent（主会话、子 Agent、审查 Agent）在修改任何代码或文档前，先按本文件完成冷启动。

## 1. 冷启动（必须按顺序，约 1 分钟）

```bash
git status                              # 确认工作区干净，不覆盖其他 Agent 的未提交改动
npm run gate:fast                       # 建立当前基线（单测 + 契约 + 文档 + 视图 + 性能预算）
```

然后只读以下**活跃视图**（不要通读历史文件）：
1. [`docs/handover/ACTIVE-STATE.md`](docs/handover/ACTIVE-STATE.md) —— 当前最新基线、未闭环真机验收项、活跃任务单。
2. [`docs/tasks/`](docs/tasks/README.md) —— 若本次属于接力/协作任务，先读对应任务交接单。
3. [`docs/27-开发与集成手册.md`](docs/27-开发与集成手册.md) —— 唯一权威操作手册（集成、十步流程、硬约束、注册点表）。

## 2. 按任务定位文档（不要加载无关目录）

| 你的任务 | 先读什么 |
| --- | --- |
| 新建功能（非修 bug） | `docs/27-开发与集成手册.md` §7（先答 Q1–Q4 与注册点表） |
| 修 Bug（复现、定因、防回归） | `docs/27-开发与集成手册.md` §8（先走 B1–B5，再走 §2 十步） |
| 改 `/panel`、状态文件、SSE、轮询、摘要或 `MAX_*` | `docs/28-性能审查手册.md` + `node scripts/perf-budget.mjs` |
| 改 `skill-evolve` / `ui-evolve` / `core` | 对应包的 `packages/<pkg>/README.md` |
| 查当前生效的架构决策 | `docs/handover/ACTIVE-DECISIONS.md`（历史见 `02-decisions.md`） |
| 查历史调研、逆向、旧方案 | `docs/00-文档索引.md`（按状态栏按需翻阅，勿全量加载） |

## 3. 硬红线（违反会直接导致故障或审查退回）

1. **禁止手改 `packages/ui-evolve/lib/client.js` 中的内联几何块**：几何唯一源码是 `packages/ui-evolve/lib/gutter.js`，改完必须跑 `npm run sync`。
2. **禁止修改既有历史记录**：`docs/01`–`26` 与 `docs/handover/01`–`04` 历史台账只读/只增不改；新交接记录一律在 `docs/handover/entries/` 新建分片文件，再运行 `npm run handover:build`。
3. **禁止盲目 `git add -A`**：提交前用 `git status` 核对并显式 `git add <文件列表>`，严禁提交 `.tmp-*`、`.review/`、`.research/`、`.pair-url` 等临时产物。
4. **改任何 `lib/*.js` 必须重启宿主才能真机验收**：主进程 ESM 缓存不会热更新；重启后用 `npm run verify:live` 验证 `/panel` 返回 200 且含新字段。
5. **每次代码修改必须经受影响变异套件与代码审查**：用 `npm run gate:mutate -- --changed` 跑变异，审查遵循 `bounded-diff-code-review`（P3 只记不修，复核只喂 delta）。

## 4. 多 Agent 协作与交接协议

- **声明范围**：中大型或多 Agent 协作任务，先在 `docs/tasks/` 基于 `_template.md` 建交接单，写明 `scope_files`（允许改动的文件）与 `forbidden_files`，避免并行踩文件。
- **零冲突台账**：需要记录状态、决策（D）、缺陷（DEF）或审查（R）时，在 `docs/handover/entries/` 新建独立文件（`YYYY-MM-DD-<type>-<slug>.md`），然后运行 `npm run handover:build` 刷新 `ACTIVE-STATE.md` 与 `ACTIVE-DECISIONS.md`。
- **交接必写**：交接给下一个 Agent 前，更新任务单的 `stage`、`Verification Matrix` 与 `Handoff Note`（明确下一步第一条命令与未解阻塞）。

## 5. 常用门禁命令

```bash
npm run gate:fast                 # 全量单测 + 文档/注册点/锚点/视图校验 + 性能预算
npm run gate:mutate -- --changed  # 按 git diff 自动挑选并串行运行受影响的变异套件
npm run handover:build            # 从 docs/handover/entries/ 重建活跃视图
npm run verify:live               # 签发本机 cookie 并校验活宿主 /api/ui-evolve/panel
```
