---
id: S-20261128-close-verified
date: 2026-11-28
type: status
status: done
title: 关闭三条已被后续真机验证取代的待闭环项
packages: [ui-evolve]
baseline: 4590 passed / 0 failed
supersedes: [2026-11-27-status-suggestion-shape-rules.md, 2026-11-27-defect-reasoning-efforts-dead-code.md, 2026-11-26-status-suggest-mark-and-busy.md]
---

## 为什么要写这一条

`ACTIVE-STATE.md` 的 §3「待闭环真机验收」从 2026-11-26 起只增不减：`scripts/build-handover-views.mjs` 只按
`status === 'pending_live_verify'` 或非空 `pending_verify` 收集，而 `entries/README.md` 里写的 `supersedes`
从来没有人实现。结果是三条**早已被后续真机验证覆盖**的旧项一直挂在待办里，读者会把它们当成还没做完的事。

生成器已改为：`supersedes` 里点名的文件或编号不再进 §3；`done` / `fixed` / `closed` / `applied` /
`verified` / `superseded` 这些状态即使写了 `pending_verify` 也不进 §3（一条「待验证」是对未来的承诺，
只有还开着的条目才配许）。

## 三条被关闭的项与证据

| 旧条目 | 它当时要求的事 | 关闭依据 |
| --- | --- | --- |
| `2026-11-27-status-suggestion-shape-rules.md` | 重启后确认芯片不以句号结尾、不出现「我来…」「Done.」、推理模型建议数秒内到达 | 形状规则已被**分区预算 + 预测口径**整体取代（`S-20261128-budgets`）：40 字符上限、叙述类整条丢弃、`{"suggestions":[]}` 允许弃权；2026-11-27/28 多次真机芯片为 7–13 字祈使句，无句号、无「我来」 |
| `2026-11-27-defect-reasoning-efforts-dead-code.md` | 重启后观察推理模型一次回合的建议耗时与 `finish` 原因 | 已由 `DEF-20261128-thinking` 整体接管：六种线上写法实测、`finish` 对象归一、方言改 `qwen-chat-template`、插件永不传 effort；真机回合结束后 **967 ms** 出芯片、思考 0 token |
| `2026-11-26-status-suggest-mark-and-busy.md` | 重启后确认箭头完整朝右、回合运行中两个界面都不出现 | 箭头已改为 SVG 绘制（`↵` 字形不再依赖字体）；「运行中不出现」在 2026-11-27/28 的真机中断与正常回合里各验一次，且已有 `closeOffer`/`forgetOffer` 两条边界与 4 条突变钉住 |

## 仍然开着的两条（不要误以为它们也关了）

- `2026-11-26-status-shared-model-label.md`：面板齿轮里的标签文案「摘要与建议模型」没在真机上逐字确认过。
- `2026-11-26-status-docs-optimization.md`：它要求跑一次 `npm run verify:live` 复验 `7b9df8b`，这条脚本此后没有再被当作验收口径使用，是否保留由后续决定。

两条都需要一次真机点击或一次脚本运行才能关，不属于「已经做完但忘了勾」。
