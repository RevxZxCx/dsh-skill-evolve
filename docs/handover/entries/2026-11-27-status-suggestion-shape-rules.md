---
id: S-20261127-shape
date: 2026-11-27
type: status
status: pending_live_verify
title: 建议的措辞改成「一个人会打进输入框的形状」，并关掉推理模型的思考
packages: [ui-evolve]
baseline: 4477 passed / 0 failed（suggest 273/0、client 1081/0、api 429/0、mutations 55/0、mutate-suggest 104/104 全杀、perf 退出 0）
pending_verify: 重启宿主后确认芯片不再以句号结尾、不再出现「我来…」「Done.」，且推理模型的建议在数秒内到达
---

# 2026-11-27 · 建议要像人打进去的字

## 改了什么

`packages/ui-evolve/lib/suggest.js` 四处：

1. **关思考**（见 `D-20261127-efforts`）：`withCheapestThinking` 按数组查 id，优先 `none`。
2. **形状规则**（取自 OpenAI Codex 的 `filter_next_prompt_suggestion`，openai/codex#24126，
   该功能后来在 #48621 被整体删除）：

```js
const QUESTION_OR_SHOUT = /[?？！!](?=\s|$)/
const TRAILING_TERMINATOR = /[.。]+$/
const INNER_SENTENCE_END = /[。！？]|(?<![?!.])[.!?](?=\s)/
const ASSISTANT_VOICE = /^(?:let me|let's|i'll|i will|i'm|here's|here is|happy to)(?![a-z])/i
const ASSISTANT_VOICE_CJK = /^(?:我来|我会|我将|让我|我先|以下|这里)/
const EVALUATIVE = /^(?:looks good|looks great|sounds good|thanks|thank you)(?![a-z])|^(?:好的|谢谢|辛苦了)/i
const NOT_AN_ANSWER = /^(?:done|no suggestion|none|null|n\/a|stay silent|silence)$/i
```

3. `isProseNotAStep` 在 `firstAction` 之前把「散文/旁白/道谢/拒答」整条丢掉，
   `stripTerminator` 在最后剥掉结尾标点。
4. `INSTRUCTION` 加一条：先加工这一轮刚产出的东西（缩短、重排、排序、应用、扩展或改其中
   一处），开新话题是最后手段。

## 与 Codex 的自觉偏离

Codex 的规则是「以句号结尾即丢弃」。本机回复几乎都带结尾标点，照抄会让功能整体空掉。
所以这里**只剥句号**，只有当「去掉结尾标点后还有另一个句末标点」时才整条丢弃——
两句就是散文，正是用户反对的东西。

**行为变化**：过去两句式答案会被救成第一句（`clipSentence` 的句末分支），现在整条丢弃，
因为散文的第一句通常是在描述过去（「`The bug is fixed.`」），而不是下一步。

## 评审改掉的四处（R-126）

两名评审员共 8 条，全部成立：

| 级别 | 问题 | 修法 |
| --- | --- | --- |
| P2 | `QUESTION_OR_SHOUT` 在任何位置命中 `?`/`!`，`Replace != with !==`、`!important`、`?.` 全被丢；而一行需要两条，丢两条等于整行消失 | 加 `(?=\s|$)`，只认句末的问号/感叹号 |
| P2 | 口吻黑名单和拒答名单锚在 `$`，所以 `Done.`、`Looks good.`、`No suggestion.` 因为结尾句号逃过全部五条规则 | 一律对 `stripTerminator(text)` 后的 `bare` 求值 |
| P3 | `INNER_SENTENCE_END` 的 `(?=\s)` 把 `e.g. ` 当句末，与注释相反 | 注释改成承认这个代价；另加 `(?<![?!.])`，否则 `?.` 会被读成句末 |
| P3 | `stripTerminator` 把 `Wait...` 剥成 `Wait..` | `TRAILING_TERMINATOR` 改成 `[.。]+$` |
| P2 | 测试侧：`^` 锚点其实没被测到（样本里根本没有口吻词，或口吻词在位置 0） | 换成 `Then let me know the result` / `先跑测试，我来看看结果` |
| P2 | 测试侧：这一轮**误删**了 `ONE action per suggestion` 的唯一断言 | 补回断言 + 补一条突变锚点 |
| P3 | 没有「菜单存在但一个 id 都不认识」的夹具 | 加 `[{id:'high'},{id:'max'}]`，断言不请求任何 effort |
| P3 | 黑名单的中文分支与 8 个拒答词里多数没有样本 | 补 `谢谢` / `done` / `None` / `disable` 别名 |

## 数字

- `test/suggest.test.mjs` 239 → **273 passed / 0 failed**
- `scripts/mutate-suggest.mjs` 92 → **104**，实跑 **104 killed / 0 survived / 0 crashed**
- 全量 `gate:fast` **4477 passed / 0 failed**，perf 六条过、退出 0

## 没有做的事

- 没有换输入源（Codex 喂整条线程历史压到 4096 tokens，我们仍喂 `renderPromptBody` 的
  六段散文 4000 字符）。换它要动 perf 预算，另开一轮。
- 没有把 `SUGGEST_MAX_TOKENS` 降到 Codex 那样的 32：这里的模型是推理模型，思考会把
  32 个 token 全吃掉，实测过。
- 没有抄 `has_unpaired_tool_flow`：我们的 transcript 里工具调用已经配平成计数。
