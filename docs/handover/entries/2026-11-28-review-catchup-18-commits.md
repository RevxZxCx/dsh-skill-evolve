---
id: R-20261128-catchup
date: 2026-11-28
type: review
status: applied
title: 18 个未评审提交的补审——派发全线失效，自审加一名独立评审共 8 条成立
packages: [ui-evolve, test, scripts, docs]
baseline: 4590 passed / 0 failed
---

# 2026-11-28 · 补审 `7b9df8b..HEAD`

## 范围

18 个提交（2026-11-26 → 11-28），48 文件 **+4355 / −429**；其中生产代码 13 文件 **+1895 / −200**（`client.js +334`、`suggest.js +501`、`transcript.js +92`、`session-state.js +92`、`mutate-suggest.mjs +485`、新脚本三个 +328）。

## 派发：逐层失效，最后靠自审 + 一名重派成功的独立评审

- `send_message` 唤醒 7 名既有队友全部 `failed before it finished`；
- `spawn_teammate` 报 `Team member limit 8 reached`；
- `workflow` 探针返回 `null`；
- 用户指出原因（m10776）：模型切换后旧子代理不可用，要求重新派发；`subagent` 重派三名仍失败，第四名 `36ee7859` 成功，只读 `packages/` 增量（1572 行）。

## 成立的 8 条

**自审（2 条 P2 + 1 条驳回）**

1. `watchVisibility()` 注册 `visibilitychange` 与 `focus` 却不存句柄，teardown 只断开 `runningWatch`；插件重载后旧实例的监听器要么泄漏、要么把新实例挡在 `visibilityWatch === true` 之后。
2. `test/client.test.mjs` 的 `ctx.effect` 替身写成 `return register()`，**丢掉 cleanup**，插件的 teardown 在所有用例里都是死代码（DEF-217）。修法：`ctxCleanups` + `disposePlugin()`，断言「卸载后 visibility/focus 监听器各 0 个」。
3. **被推翻**：`session-state.js` 的 `offerSeen()` 只读 `bySession.get`，看起来冷启动读不到持久化 offer。实测 `cold offerSeen: undefined`、`await second.load('s1')` 后拿得到；调用方 `/suggestions` 先走 `viewOf()`，而 `api.js` 的 `viewOf` 里已有 `await state.load(agentId)`。顺序由调用方保证。

**独立评审（`36ee7859`，4 条全部成立）**

4. **P1** `transcript.js` 的 `endTurn` 先 `rememberEarlierAsk` 再取快照，于是 `previous.asks` 含本回合请求——同一句既在 `<requests>`（标注「背景」）又在 `<latest_request>`，每个完成回合发两遍（DEF-218）。
5. **P2** `snapshotOf` 只存 `turns`/`previous`，`interrupted` 不落盘（DEF-220）。
6. **P2** `Fix the a ? b : c ternary` 被 `?` 整行杀掉；真凶是 `INNER_SENTENCE_END`，不是评审点的 `QUESTION_OR_SHOUT`（DEF-219）。
7. **P3** `MIN_SUGGESTIONS = 1` 后注释仍在论证「单条不画」。

## 修完之后的复查（用户 m11021）

第一版把第 5 条标成「缓」、把两处写进 `docs/29` §8.12 当「观察，未改」。用户问「有问题为什么不修复？」后三条全部落地：`interrupted` 穿过进程边界（DEF-220）、恢复句无条件 `stale`（DEF-221）、回合边界改成四秒标记（DEF-222），并把 `test/mutations.test.mjs` 里 `mutate-checklist-panel.mjs` 的 `>= 127` 改成精确 `141`。

## 编号更正

本轮的 R 号在冻结台账 `04-reviews.md` 里写成了 **R-126**，而 [`2026-11-27-review-126-suggestion-shape.md`](./2026-11-27-review-126-suggestion-shape.md) 已经用过 R-126（建议形状规则的评审）。**本文的 `R-20261128-catchup` 是这一轮的唯一规范编号**；冻结台账里的那两处 R-126 按只读历史保留，读到时以本条为准。

## 数字

全量 4575 → 4590；`mutate-suggest` 133 → 141（141/141 全杀）；`client` 1107、`suggest` 324、`transcript` 237、`session-state` 379；perf 退出 0。

## 教训

- 一条发现被标成「缓」，往往不是因为修复难，而是因为当时**没写出那句能让它变红的话**。四条突变存活正好说明了这一点。
- 派发失败不等于「没人能看」：先自审能抓到测试替身这一层，独立评审才能腾出手看语义层。
