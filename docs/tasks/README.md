# 多 Agent 任务交接单（`docs/tasks/`）

本目录用于承载**正在进行中（In-Flight）的任务上下文**，解决多 Agent 接力或并行协作时「做到哪一步、改了哪些文件、跑过哪些检查、下一步做什么」信息散落的问题。

## 什么时候建任务单

- 预计跨会话或跨 Agent 接力（例如：规划 Agent → 实现 Agent → 审查 Agent → 集成验收 Agent）。
- 需要多个 Agent 并行改动仓库的不同模块。
- 命中 [`docs/27-开发与集成手册.md`](../27-开发与集成手册.md) §7 的新功能或跨包重构。

单人单轮 10 分钟内即可闭环的微小修复无需建任务单。

## 生命周期

1. **创建**：复制 [`_template.md`](./_template.md) 为 `<YYYY-MM-DD>-<slug>.md`，填好目标、文件边界（`scope_files` / `forbidden_files`）与 Q4 验收判据。
2. **流转**：每次阶段切换或交接前，更新顶部 `status`、`stage`、`owner`，勾选 `Verification Matrix`，并在 `Handoff Note` 写清下一个 Agent 接手后的第一条动作。
3. **审查**：审查发现的结构化清单（`[P0|P1|P2|P3]`）可记录在同一任务单的 `## Review Findings` 或同前缀 `<task>-review.md`。
4. **结项**：任务全部通过门禁与真机验收后：
   - 将需要长期留存的状态/决策/缺陷/审查结论沉淀为 `docs/handover/entries/` 下的分片条目；
   - 运行 `npm run handover:build` 刷新活跃视图；
   - 将任务单 `status` 改为 `done`（或移入 `docs/tasks/archive/`）。
