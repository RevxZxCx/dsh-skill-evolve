---
id: S-20261126
date: 2026-11-26
type: status
status: active
title: 完成面向多 Agent 协作的文档体系优化与自动化门禁脚本落地
packages: [docs, scripts, test]
baseline: 4391 passed / 0 failed（docs 57/0、registration 56/0、mutations 55/0、gate:fast 通过）
pending_verify: 2026-11-25 提示词建议改动（7b9df8b）仍待重启宿主后跑 npm run verify:live 复验
---

# 2026-11-26 · 多 Agent 文档体系优化与门禁脚本

- 新增根入口 `AGENTS.md`，明确冷启动顺序、文档路由、红线与多 Agent 协作协议。
- 瘦身 `docs/00-文档索引.md` 状态栏，消除千字流水单元格，恢复低 Token 路由表定位。
- 启用 `docs/handover/entries/` 分片追加模式 + `scripts/build-handover-views.mjs` 自动生成 `ACTIVE-STATE.md` 与 `ACTIVE-DECISIONS.md`。
- 新增 `docs/tasks/` 多 Agent 任务交接单模板与流转规范。
- 新增 `scripts/gate-fast.mjs`、`scripts/gate-mutate.mjs`（支持 `--changed` 按 diff 自动路由变异套件）、`scripts/verify-live.mjs`。
- 修正 `docs/27` §3 漏列的 `mutate-suggest.mjs`（10 → 11 套，与 §7 对齐）及 `docs/28` 两处数字漂移；`docs/27` §2 第 10 步移除危险的 `git add -A`。
- 扩展 `test/docs.test.mjs` 对上述全部不变量进行机械校验。
