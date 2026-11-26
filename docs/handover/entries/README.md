# 分片交接条目（`docs/handover/entries/`）

本目录替代旧的单文件追加模式，解决多 Agent 并行开发时在 `01-status.md`–`04-reviews.md` 头部索引表与末尾同时产生 Git 合并冲突的问题。

## 规则

1. **一件事一个文件，只增不改**：已落盘的条目不修改原文；需要更正或推翻时新建一条条目并在 frontmatter 中标注 `supersedes`。
2. **命名格式**：`YYYY-MM-DD-<type>-<short-slug>.md`
   - `<type>`：`status` | `decision` | `defect` | `review`
   - 多个 Agent 同一天写同类型条目时，用不同的 `<short-slug>` 避免文件名碰撞。
3. **写完必须刷新活跃视图**：运行 `npm run handover:build`，自动更新 `docs/handover/ACTIVE-STATE.md` 与 `docs/handover/ACTIVE-DECISIONS.md`（由 `npm run gate:fast` 校验是否同步）。

## Frontmatter 模板

```yaml
---
id: D-255                 # 或 DEF-210 / R-124 / S-20261126
date: 2026-11-26
type: decision            # status | decision | defect | review
status: active            # active | superseded | closed | pending_live_verify
title: 一句话总结
packages: [docs, scripts] # 可选
baseline: 4379 passed / 0 failed  # type=status 时建议填写
pending_verify: 需重启宿主后运行 npm run verify:live  # 有未闭环真机验收时填写
---
```
