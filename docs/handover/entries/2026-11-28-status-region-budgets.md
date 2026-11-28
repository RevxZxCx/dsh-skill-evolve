---
id: S-20261128-budgets
date: 2026-11-28
type: status
status: done
title: 建议的提示词改成分区预算：规则不计入、数据三区、预测口径、允许弃权
packages: [ui-evolve]
baseline: 4590 passed / 0 failed
---

# 2026-11-28 · 分区预算与预测口径

## 起点：用户对命中率的五条裁决（m08783）

1. 前置规则不计入数据预算，字数限制改成**按区域**的预算；
2. 用户输入改成多轮，超预算淘汰最旧的，并用提示词标明过去的轮次只是参考；
3. 模型输出不要整段塞入，只用「这一轮结束时汇报工作」的那一段；
4. 工具调用与文件编辑对建议没有帮助，不要喂；
5. 口径改成 Codex 式的「预测他们会打什么」，允许弃权，字数上限按实测。

## 落地的形状（`packages/ui-evolve/lib/suggest.js`）

- 规则区 13 条（`You predict what the person … will type next.`、`would they read it and think "that is what I was about to type"`、`about 10 to 24 Chinese characters or 2 to 12 words, and never more than 40 characters`），后面跟 `---`，再跟一句「以下全是数据」。
- 数据区三块：`<requests note="earlier requests, oldest first; background, not the thing to answer">` / `<latest_request>` / `<report note="what the last turn reported when it finished">`。
- 预算：`<latest_request>` 600、`<requests>` 合计 600 单条 200（历史环形缓冲，超了整条淘汰最旧，`MAX_EARLIER_ASKS = 24` 条是第二上限）、`<report>` 1200。规则不计入。
- 「汇报」= `transcript.js` 里该轮**最后一条**助手正文（`report` 字段），不是整轮叙述。
- 工具调用、编辑路径、命令**不再渲染**（实测它们的字符数占 60% 以上，而信息价值最低）。

## 40 字符是量出来的，不是拍的

真实 class 的 680px 行、文字区 642px：纯中文第 **44** 字出省略号（43 刚好），纯英文单词第 **80** 字符，中英混排 122 字符。所以「120 不会换行」只对混排成立；取 40 是唯一对三种都安全的数（用户 m08800 要求先测再定）。

## 三条缺陷（详见冻结台账 DEF-210/211/212）

- **DEF-210**：「必须两条」的配额一直在替后处理挡刀——`MIN_SUGGESTIONS` 从 2 降到 1 之后，`I cannot help with that`、`You could run the tests…` 这类句子会直接变成芯片。修法是补 `REFUSAL` 表与扩 `ASSISTANT_VOICE`，并让 `readSuggestionLines` 的「跨空行」判据不再借用 `MIN_SUGGESTIONS`。
- **DEF-211**：真机采样四次只两次服从 `JSON only`，其中一次是「已将 notetxt 的内容改为 hello world。」（叙述被当成下一步）。修法：`NARRATED_DONE` 表丢弃叙述，理由里带 `first:` 原文，规则区补「只回 JSON，不要前言/围栏/解释」。
- **DEF-212**：真机第一次给芯片时，`重命名为 add.js` 与 `把它改名成 add.js` 同时出现。修法：`sameOffer()` 只折叠「结尾文件名相同 + 两边都含重命名词」这一族——范围窄是刻意的，`运行 add.js` 与 `检查 add.js` 必须都留。

## 提交

`e58587f`（三分区 + 预测口径）、`fc272d7`（DEF-211）、`04f8fcc`（DEF-212）。数字：全量 4544 → 4552 → 4557；`mutate-suggest` 120 → 123 → 125。

## 没有的东西

没有新增配置键、没有新增路由、没有 turn 事件处理器；命中率仍按 D-269 只做人工评估。
