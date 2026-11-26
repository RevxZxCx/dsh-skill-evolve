---
id: D-255
date: 2026-11-26
type: decision
status: active
title: 交接台账改用按文件分片追加 + 自动生成活跃视图，并引入根级 AGENTS.md 与任务交接单
packages: [docs, scripts, test]
---

# D-255 · 多 Agent 文档体系升级：分片交接 + 活跃视图 + 自动门禁

## 背景

`docs/handover/01-status.md`–`04-reviews.md` 累计已超 20,600 行（约 1.73 MB），且每次提交都同时修改文件顶部索引表与文件末尾。多 Agent 在不同分支/worktree 并行开发时必然发生合并冲突与抢号；同时 `docs/00-文档索引.md` 状态栏膨胀到 36 KB，根目录缺少 AI 自动加载的 `AGENTS.md`，也缺少表示进行中任务状态的交接单。

## 决定

1. **新增根级 `AGENTS.md`**（≤ 120 行）：作为所有 AI Agent 冷启动自动读取的薄入口。
2. **冻结旧的 4 份单文件台账**：`01-status.md`–`04-reviews.md` 保持只读、不改写任何历史行；自 2026-11-26 起的新增状态/决策/缺陷/审查一律写入 `docs/handover/entries/YYYY-MM-DD-<type>-<slug>.md`（仍遵守只增不改）。
3. **自动生成活跃视图**：由 `scripts/build-handover-views.mjs` 生成 `ACTIVE-STATE.md` 与 `ACTIVE-DECISIONS.md`，并用 `--check` 纳入 `gate:fast` 门禁。
4. **新增 `docs/tasks/` 任务交接单**：承载多 Agent 接力/并行时的文件边界、验证矩阵与下一步动作。
5. **流程脚本化**：在 `package.json` 暴露 `gate:fast`、`gate:mutate`、`handover:build`、`verify:live`，并用 `test/docs.test.mjs` 守住新结构及 `docs/27` §3 与 §7 的变异表一致性。

## 被否决的替代方案

- **把 `01`–`04` 移动到 `archive/` 并重命名 `docs/27`/`28`**：会破坏仓库内上百处历史文档与测试里的相对链接；原地冻结 + 新增分片目录零破坏且保留完整可追溯性。
- **继续往 `01`–`04` 末尾追加**：无法解决多 Agent 并行写冲突与顶部索引表漏更问题。
