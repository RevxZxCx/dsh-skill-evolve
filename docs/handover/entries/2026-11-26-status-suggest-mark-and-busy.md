---
id: S-20261126-suggest
date: 2026-11-26
type: status
status: pending_live_verify
title: 建议行首记号改为朝右绘制箭头，回合运行中不再显示建议与幽灵
packages: [ui-evolve]
baseline: 4434 passed / 0 failed（client 1074/0、suggest 239/0、api 429/0、mutations 55/0、mutate-suggest 87/87 全杀、perf 退出 0）
pending_verify: 重启宿主后确认箭头完整朝右、回合运行中两个界面都不出现
---

# 2026-11-26 · 建议行首记号与「回合在跑」门控

用户提出两处问题：截图中行首的回车记号被裁断，方向也不对（应朝右）；建议与输入框幽灵在回合运行中仍会显示。

## 一、行首记号：从字符改成绘制路径

原实现是 `children: "↵"`，配 `.dsse-suggest-enter{width:1.1em;...}`。两个缺陷都来自「用字体字形当图标」：

- **被裁断**：`↵` 由宿主解析到的字体排版，字形的上缘超出固定宽度的行盒，截图里只剩一个小钩、竖笔被切掉。
- **方向相反**：`↵` 是「回车键」的符号，钩向左。建议行在回答末尾、阅读方向从左到右，向左的钩读起来是反的。

改为内联 SVG：`viewBox="0 0 16 16"`，`stroke="currentColor"`，两条 path —— `M2.5 8h10`（横杆）与 `M8.5 4l4 4-4 4`（箭头，终点在 x+4，即更右侧）。CSS 改为 `width:14px;height:14px;display:inline-flex;...` 加 `.dsse-suggest-enter>svg{width:14px;height:14px;display:block;overflow:visible}`，颜色仍走 `--dsw-alias-label-tertiary`，hover 时变 `--dsw-alias-label-secondary`。绘制路径不依赖字体，也不会有基线或行盒裁切。

## 二、回合运行中不显示两个界面

**客户端看不见这件事**：`SubmitMachine.phase` 在消息交给宿主的那一刻回到 `plain`，并在此后整个回合里保持 `plain`（探针实测：`phase = "plain"` 的四处赋值分别在构造、`beginDetached`、`onSinkSettled`、`onAdjudicationFailed`）。宿主也没有任何 `aria-busy` / `data-*-busy` / `data-turn-open` 属性（探针零命中）。所以「回合在跑」只能由服务端判定。

**服务端判据**：`transcripts.view(agentId).current.turn` —— `endTurn` 会把它置 `undefined`（`packages/ui-evolve/lib/transcript.js:533/609/613`），所以 `current.turn !== undefined` 就表示有回合敞着。`suggestions()` 在读到 `previous` 之后、取 body 之前拦下：

```js
if (view?.current?.turn !== undefined) return { enabled: true, items: [], reason: 'a turn is running', busy: true }
```

**为什么带 `busy: true` 而不只给 reason**：客户端有一处「空答案重试一次」的补偿（DEF-202），处理的是回合结束瞬间转录仍在沉降的竞态。如果回合运行中的空答案与那次竞态长得一样，这一次重试就会被花在「回合还没结束」上，而真正的竞态发生时已经没有重试可用。`busy` 是显式字段，客户端据此跳过重试。

**客户端门控**：store 增 `busy: false`，`loadSuggest` 成功分支 `suggest.busy = data?.busy === true`，`resetSuggest` 复位；`SuggestChips` 与 `SuggestGhost` 的 `shown` 各加 `suggest.busy === false`；重试条件加 `&& suggest.busy === false`。

两个界面都拦，理由不同：芯片描述「屏幕上这段回答之后的下一步」，而回合进行中那段回答还在写；幽灵坐在读者可能要打断的输入框里，回合运行中把一句提示词放在那儿，读起来是「现在就打这句」。

## 测试

- `test/suggest.test.mjs` 231 → **239/0**：`viewWith()` 的 `current.turn` 改为 `undefined`（这正是 `endTurn` 留下的形状），新增 `viewRunning()`；四条断言锁「回合运行中不给建议 / 说明理由 / 不花钱 / 仍读作已启用」，两条锁 `busy === true` 与「回合结束后不再 busy」；「同样一轮关闭后会给出建议」放进独立作用域，因为它要花一次调用，而前一个块断言自己四条路径都没花。
- `test/client.test.mjs` 1071 → **1074/0**：`suggestRoute` 增 `busy: settings.busy === true`；新增块断言回合运行中「不画芯片行 / 不画幽灵 / 不装那只 15 秒重试定时器」。
- 行首记号三条断言重写：存在且是首个子节点、`svg.type === 'svg'` 且两条 path 且自身无文本、两条 path 的 `d` 逐字为 `M2.5 8h10` 与 `M8.5 4l4 4-4 4`（朝右由终点坐标保证）。
- `scripts/mutate-suggest.mjs` 85 → **87**：新增「回合运行中仍给建议」「运行中被报成普通空答案」两条；三处锚点因本次改动失效并修正（`↵` 字形锚点改锚 `className`、重试条件补 `busy`、两条新条目最初把 `file: engine`（套件数组）当路径写，静态校验报 `unresolved: engine,engine`）。
- `test/mutations.test.mjs:206` 期望 85 → **87**；`docs/27` 两处计数同步（§3 表格与 §7 注册表行）。

## 数字

全量 **4434 passed / 0 failed**；`mutate-suggest` **87 killed / 0 survived / 0 not applied / 0 crashed**；`perf-budget` 六条 ok、退出 0（payload-real 15,984 B / ceiling 63,324 B / elapsed 4.1 ms / state 41,941 B）。
