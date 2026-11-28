---
id: S-20261128-lifecycle
date: 2026-11-28
type: status
status: done
title: 建议的生存期 = 回合边界；过期只留幽灵；中断的回合什么都不画
packages: [ui-evolve]
baseline: 4590 passed / 0 failed
---

# 2026-11-28 · 生存期、幽灵与中断闸门

## 用户的裁决（m08055）

> 持久化的建议不需要存多条，我们只用显示针对上一轮给出的建议即可……有效期我认为不需要设置，实际的建议生存周期应该是上一轮对话完成，下一轮对话开始这中间这段时间。

落成三条：只持久化**一句**（给幽灵）、**没有时钟**、生存期 = 回合边界。

## 实现要点

- `client.js`：删 15 分钟 TTL 与 `armExpiry`；`forgetOffer()` 用于「新一轮开始」；`closeOffer()` 记住「刚关的是第几轮」并在 4 秒后放手（DEF-222）；`watchVisibility()` 在回前台时补一次刷新（并修掉「监听器从不移除」）。
- 服务端：缓存过期**不再重买**，改为 `stale: true` 返回（芯片不画、幽灵保留）；`offer` 写进 `session-state`（`document`/`keepsDocument`/`load`），重启后恢复。
- **DEF-221**：恢复的那句无条件 `stale: true`——它是给幽灵的，不是给芯片的。
- **DEF-214 + DEF-220**：`turn/end` 的 `reason.kind !== 'completed'` 时置 `interrupted`，路由在**缓存与模型调用之前**返回空 + `the last turn was interrupted`；这个标记必须穿过进程边界（`snapshotOf` → `document` → `keepsDocument` → `load` → `hydrate` 合并分支），否则闸门只在没重启时有效。
- **DEF-222**：回合边界与答案落地谁先到，两个顺序都有用例；`forgetOffer` 留给「开始」，`closedAt` 留给「结束」。

## 真机（2026-11-28 三次重启后）

- 重启后打开 9 行的会话：幽灵是存下的那句，9 条芯片全 `data-shown="false"`、0 项（DEF-221）。
- 正常一轮 23.2 s 结束，芯片 **967 ms** 后出现在最后一行、三条 `armed`、幽灵同步；4.6 s 后仍在（DEF-222 两个方向都成立）。
- 点停一轮后：`session-796ca485-….json` 出现 `interrupted: true`（`turns: 17`、`offer.turn: 16`）；重启后第 18 行无芯片无幽灵，路由 `{"items":[],"reason":"the last turn was interrupted","turn":16}`（DEF-220）。

## 决策

D-267（关思考=不要那个字段之外）之后的一串：D-272（测试替身必须执行 teardown）、D-273（**发现了就修，不写「已知问题」**；只有需要用户拍板才留待裁决）。D-273 的来源是用户 m11021「有问题为什么不修复？」。

## 代价（诚实记录）

- 「答案先到」那一半顺序里，旧行最多滞留 4 秒；两种顺序无法从客户端分辨，标记是猜，所以给它一个上限。
- 芯片与幽灵共享一次请求；幽灵在**空且静止**时才画，芯片不要求草稿为空。
