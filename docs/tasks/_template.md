---
id: task-YYYYMMDD-slug
title: <一句祈使句说清本次任务>
status: in_progress        # in_progress | in_review | awaiting_live_verify | blocked | done
stage: Step 1/10           # 对应 docs/27 §2 的十步
owner: <当前负责的 Agent 角色，如 impl-agent / review-agent / verify-agent>
updated: YYYY-MM-DD
scope_files:
  - packages/ui-evolve/lib/...
  - test/...
forbidden_files:
  - packages/core/**
---

# <任务标题>

## 1. 目标与验收判据（Q4）

- **问题 / 目标**：<当前行为是什么、要改成什么>
- **可验证判据**：<一句可验证的话 + 具体数字，例如：`/panel` 载荷 < 32 KB、某用例从失败变通过>
- **明确不做**：<本轮不碰的范围，防止范围膨胀>

## 2. 涉及注册点（docs/27 §7）

- [ ] 无新增注册点
- [ ] 涉及注册点：<列明具体族与名称，如 路由 `/suggestions`、配置键 `panelSuggestions`>

## 3. 验证矩阵（Verification Matrix）

- [ ] `npm run gate:fast`（基线：`<passed>/<failed>`，perf-budget：`<exit code>`）
- [ ] `npm run gate:mutate -- --changed`（受影响套件：`<套件名与杀伤数>`）
- [ ] `bounded-diff-code-review`（轮次与收敛结论）
- [ ] 宿主重启 + `npm run verify:live`（真机证据）
- [ ] 分片台账已写入 `docs/handover/entries/` 并运行 `npm run handover:build`

## 4. Handoff Note（给下一个 Agent）

- **已完成**：
  - ...
- **未完成 / 阻塞点**：
  - ...
- **下一步第一条动作**：
  - `<明确命令或文件位置>`
