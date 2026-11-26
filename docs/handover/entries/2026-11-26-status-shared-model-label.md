---
id: S-20261126-label
date: 2026-11-26
type: status
status: done
title: 模型设置项改名为「摘要与建议模型」，并修掉两处「只有摘要花钱」的过时说法
packages: [ui-evolve]
baseline: 4443 passed / 0 failed（client 1083/0、docs 57/0、registration 56/0、mutations 55/0、mutate-suggest 92/92 全杀、perf 退出 0）
pending_verify: 重启宿主后打开面板齿轮，确认标签显示「摘要与建议模型」，说明行为「两处共用一个模型：面板摘要与下一轮建议。默认沿用当前会话已验证的路由。」
---

# 模型设置项改名

## 为什么改

`summaryProvider` / `summaryModel` 这一对键现在服务**两个**花钱的调用：面板摘要
（`lib/summarise.js`）和下一轮建议（`lib/suggest.js` 的 `resolveRoute`）。界面标签
却还叫「总结模型」，说明行也只讲摘要。读者改这个下拉框时，看到的是一个功能的
名字，实际改的是两个——这正是「名字对了，句子错了」那一类（DEF-192）。

两个功能共用一对键是**有意的**，不是历史包袱：两者要的是同一件东西（便宜、快、
短提示词、旁路于对话之外），拆成两套设置会变成两个谁也分不清的开关，以及两处
在钉死失效时要改的地方。所以改的是文案，不是结构。

## 改了什么

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `packages/ui-evolve/lib/client.js:3643` | `总结模型` | `摘要与建议模型` |
| `packages/ui-evolve/lib/client.js:3644` | `默认沿用当前会话已验证的路由。` | `两处共用一个模型：面板摘要与下一轮建议。默认沿用当前会话已验证的路由。` |
| `packages/ui-evolve/lib/config.js` | `summaryProvider`/`summaryModel` 的 docstring 只讲摘要 | 补上「一对键服务两个功能」的理由，并说明键名沿用 summary 是因为摘要先出现 |
| `packages/ui-evolve/README.md:55-56` | 配置表只讲摘要 | 改成「共享给摘要与建议」 |
| `packages/ui-evolve/README.md:348` | 「the one part of this plugin that costs money」 | 改为「两处花钱的调用，各有自己的开关」 |

最后一行是顺手修的过时表述：建议功能上线后，「摘要 = 唯一花钱的部分」已经
不成立。同一句话在 `.research/panel_sec1.md:33` 也有一份，那是调研存档，按
AGENTS.md 不改历史记录。

## 测试

`test/client.test.mjs` 新增两条断言（在「The model picker」块内）：

- `the picker names both features that share the pair` —— 收集所有
  `dsse-setting-label` 的文本，要求存在一个同时含「摘要」与「建议」的标签。
  **第一次写成 `firstByClass` 是错的**：设置面板里有多个 `dsse-setting-label`，
  第一个是「每轮自动总结」，断言立刻失败（`FAIL ... — 每轮自动总结`）。改用
  `byClass(...).map(...)` 全量收集再匹配。
- `and the note says they share one model` —— `textOf(tree).includes('两处共用一个模型')`。

## 突变

`scripts/mutate-suggest.mjs` 90 → **92**，两条新锚点各锁一句话：

- `the model picker names only the summary again`（标签改回「总结模型」）
- `the note stops saying the two features share a model`（说明行改回只讲默认路由）

两条都 KILLED。`test/mutations.test.mjs:206` 期望 90 → 92；`docs/27` 两处计数
（:205 的表格行、:535 的分项行）同步改为 92 / 客户端 38。

## 没有做的事

- 没有新增 `suggestProvider` / `suggestModel`。用户明确倾向两者共用，理由也对。
  若将来真需要给建议单独钉一个更便宜的模型，那是新增两个配置键 + 在
  `resolveRoute` 里插一级 + 同步注册点表与 README，属于新功能而非文案修正。
- 没有改 `suggestionCount`（条数仍独立于模型设置）。
