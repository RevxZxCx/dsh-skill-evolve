---
id: R-20261127-codex
date: 2026-11-27
type: review
status: applied
title: R-126 建议形状规则的评审——8 条全部成立，其中 4 条是真缺陷
packages: [ui-evolve]
baseline: 4477 passed / 0 failed（suggest 273/0、mutations 55/0、mutate-suggest 104/104）
pending_verify: 无
---

# 2026-11-27 · R-126

## 范围

`.review/r126-codex-rules.diff`（462 行），只读 delta：`suggest.js` 的
`withCheapestThinking` 与五条形状规则、`test/suggest.test.mjs` 的夹具与预期、
`scripts/mutate-suggest.mjs` 的新增锚点。评审员：`reviewer-engine`、`reviewer-tests-server`。

## 结论

8 条全部成立，无驳回。其中 4 条是代码缺陷，4 条是测试强度不足。

最严重的两条都是「规则写对了方向、漏了形状」：

1. **`QUESTION_OR_SHOUT` 没有要求句末** —— 在任何位置命中 `?`/`!`，于是
   `Replace != with !==`、`Use the ?. operator`、`!important` 全被丢。因为一行需要两条，
   丢掉两条就是整行消失，读者看到的是「这一轮没有建议」，而不是「少了一条」。
2. **黑名单对原始文本求值** —— `EVALUATIVE` / `NOT_AN_ANSWER` 锚在 `$`，而结尾句号是
   字符串的一部分，于是 `Done.`、`Looks good.`、`No suggestion.` 因「礼貌地加了句号」
   而全部逃过。五条规则里有两条被一个句号击败。

## 两条被明确驳回的猜测

- 「返回模型自己的 id 可能仍然触发 `INVALID_MODEL_REASONING`」——不成立：id 逐字来自宿主
  自己那份菜单，查表只是小写化。
- 「关思考可能没到线上」——不成立：`configure` 的返回值经 `call.config` 进
  `call.stream`，夹具与断言读的就是这条链。

## 教训

1. **一个正则的命中位置，和它匹配什么同样重要**。`[?！]` 与 `[?！](?=\s|$)` 是两条
   完全不同的产品规则。
2. **对「原形」求值与对「成品」求值要选清楚**。黑名单想判的是芯片最后长什么样，就必须
   在剥掉结尾标点之后判。
3. **评审员推翻自己的假设也是产出**。这一轮两名评审员各写了一段「这条不成立」，
   省掉了我两次无用的改动。
4. 我这一轮**误删了一条既有断言**（`ONE action per suggestion`），是评审员 grep 出来的。
   改大块测试时应当先记下被删块里的每一条 `check`，改完逐条回点。
