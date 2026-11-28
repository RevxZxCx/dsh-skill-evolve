---
id: DEF-20261128-thinking
date: 2026-11-28
type: defect
status: fixed
title: 关思考的三层真相：efforts 是数组、方言缺 off 档时说关等于没说、settings.yaml 是产物
packages: [ui-evolve, docs]
baseline: 4590 passed / 0 failed
---

# 2026-11-28 · 建议调用一直没关掉思考

## 现象

真机芯片要么 21–31 秒才出现、要么 0 条，`reason` 写着 `finish: max-tokens`。三次重启都没好转，而我每次都以为「已经修好了」。

## 三层根因

1. **DEF-213** `withCheapestThinking` 把 `info.reasoning.efforts` 当成对象查键，而宿主给的是**数组**（`[{id,name}]`）——于是它从来没命中过任何一档，「关思考」是死代码。
2. **DEF-215** `finish` 是对象 `{kind:'max-tokens'}`，代码只认字符串（`typeof finish === 'string'`），**截断分支在真机从未执行**；「预算被思考吃光」被打成 `0 lines, 0 characters` 并按普通空答案记进一分钟失败记忆。另外 `withCheapestThinking` 只删回调里的 effort，宿主在回调之后定下的会话 effort 仍会进 `call.config`，而 deepseek 方言里**任何真值 effort 都是「开」**。
3. **DEF-216** `~/.dsh/settings.yaml` 是**产物**：宿主启动时把 `~/.dsh/profiles/desktop/cordis.patch.yml` 渲染成它（原文件改名为 `settings.yaml.imported`）。我改了产物，重启就被覆盖。而且 deepseek 方言在模型没声明 `off` 档时**一个思考参数都不发**：`thinkingLevelMap` 由声明式 `reasoningEfforts` 展开，未声明的档被钉成 `null`，于是 `off === null` 使 `thinking:{type:"disabled"}` 分支不成立。

## 修法

- 插件侧：`withCheapestThinking` 只做 `delete reasoningEffort`；`run()` 里 `options` 成形后再无条件 `delete options.reasoningEffort`（连读作 off 的 id 也不留——所有方言都把真值 effort 当开）。
- `finish` 归一成 `finishKind = typeof finish === 'string' ? finish : (finish?.kind ?? '')`，截断走失败而不是空答案。
- profile 侧：`cordis.patch.yml` 里 magpie 的 `compat.thinkingFormat` 从 `deepseek` 改成 `qwen-chat-template`——该方言无条件发 `chat_template_kwargs = {enable_thinking: !!effort, preserve_thinking: true}`，不需要模型声明 off 档。网关实测 294 ms / 0 思考 token。
- 决策：D-270（最初想「挑一个 off id」，错）、D-271（插件永不传 effort，方言由 profile 决定；代价是换机器要重新声明）。

## 真机

- 664 ms / 0 思考 / `finish: stop` / 2 条建议（对照：不发该字段 25 921 ms / 700 思考 / `finish: length` / 0 条，**39 倍**）。
- 宿主整链路：回合结束后 **523 ms** 芯片出现在屏幕上。

## 教训

- 一个能力有三档时，「选最便宜」与「关掉」是两件事，断言只查「缺了什么」不查「多了什么」就会漏掉后者。
- **改配置前先问这份配置是谁写的**：一个文件的修改时间等于进程启动时间，通常说明它是产物。
