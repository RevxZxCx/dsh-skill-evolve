---
id: S-20261128-closed
date: 2026-11-28
type: status
status: done
title: 下一轮建议这一阶段收尾：三项延期修复真机通过，文档审计修完，基线 4590/0
packages:
  - ui-evolve
baseline: 4590 passed / 0 failed；mutate-suggest 141 killed / 0 survived / 0 crashed；docs 57/0；registration 56/0；gate:fast PASS
supersedes:
  - 2026-11-28-status-region-budgets.md
  - 2026-11-28-status-lifecycle-and-gates.md
  - 2026-11-28-status-close-verified-pendings.md
  - 2026-11-28-status-close-the-two-open-entries.md
---

## 这一阶段结束了什么

「下一轮提示词建议 + 输入栏 Tab 补全」从设计到收尾走完：提示词改成区域预算与预测口径、思考真正关掉、建议生存期等于回合边界、中断回合不说话。三项此前被标成「缓」的修复在真机上验收通过：

| 项 | 真机证据 |
| --- | --- |
| 恢复句只做幽灵（DEF-221） | 重启后 9 条建议行全 `data-shown="false"`、0 项；幽灵一条、文本来自持久化那一句 |
| 回合边界与答案落地（DEF-222） | 回合 23.2 s 结束，芯片在结束后 **967 ms** 出现，4.6 s 后仍在该行 |
| 中断穿过进程边界（DEF-220） | 持久化文件出现 `interrupted: true`；重启后第 18 行无芯片、无幽灵；`/suggestions` 回 `the last turn was interrupted` |

文档审计另修五处（`be12537`）：手册里的变异判据改回 `===`、turnTail 登记行改为顺序认领、补 `/suggestions` 与区域预算两条硬约束、新增三条 decision 条目让活跃视图扫得到、§4 徽章不再对有 `supersedes` 的条目说谎。

## 仍然开着的（不是遗漏，是口径）

1. **命中率没有量化基线**：按 D-269 只做人工评估，理由是自动指标会被刷成好看的数字。若要更强收尾，办法是抽 8–10 轮逐条打分。
2. **没有截图证据**：`ego_screenshot` 与 `cdp('Page.captureScreenshot')` 在本机一律 `CDP request timed out`，真机证据只有 DOM 读数。
3. **关思考依赖 profile**：`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `compat.thinkingFormat: qwen-chat-template`；换机器或换 provider 要重新声明（D-20261128-thinking）。
4. **20 条技能候选待批准**：`C:\Users\26903\.dsh\plugin-data\skill-evolve\candidates.json`，与本功能无关。

## 冷启动该读什么

先读 `ACTIVE-STATE.md`（本条目就是它的「最近状态条目」），需要细节时按 §4 的表进 `entries/`；冻结台账只在追溯历史时读，其中 `DEF-210–222`、`D-263–273`、`R-124–126` 是 11-27/28 误加的，以 `2026-11-28-status-ledger-correction.md` 为准。
