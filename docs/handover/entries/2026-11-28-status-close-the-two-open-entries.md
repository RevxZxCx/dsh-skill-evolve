---
id: S-20261128-close-open
date: 2026-11-28
type: status
status: done
title: 结清最后两条待验证条目：verify:live 能跑通，面板标签与说明行在真机上是新文案
packages: [docs, ui-evolve]
baseline: 4590 passed / 0 failed（docs 57/0、registration 56/0、mutations 55/0、mutate-suggest 141/141、gate:fast 通过）
supersedes:
  - 2026-11-26-status-docs-optimization.md
  - 2026-11-26-status-shared-model-label.md
---

# 结清最后两条待验证条目

这两条是 2026-11-26 写下的「以后要做」的承诺，一直挂在
`ACTIVE-STATE.md` §3 或记录正文里。今天把两件都做了，证据如下。

## 1. `npm run verify:live` 能跑通（原 `S-20261126` 的 pending）

它签一个宿主浏览器会话 cookie，去探运行中的 `/api/ui-evolve/*`。实测：

```
$ node scripts/verify-live.mjs
GET http://127.0.0.1:19387/api/ui-evolve/config -> HTTP 200
Top-level keys: ok, data

$ node scripts/verify-live.mjs --session session-796ca485-79b4-47f7-8ce1-3c530cac4613
GET http://127.0.0.1:19387/api/ui-evolve/panel?agent=session-796ca485-… -> HTTP 200
Top-level keys: ok, data
```

**一处需要写清楚的更正**：那条 pending 的原文是「2026-11-25 提示词建议改动
（`7b9df8b`）仍待重启宿主后跑 `verify:live` 复验」。`7b9df8b` 的那版提示词
（一句话、90 字符、强制 2–3 条）已在 2026-11-27 被分区预算与预测口径取代
（`e58587f`），所以「复验 `7b9df8b`」这个具体承诺已经不存在对象。真正要证明的
那件事——建议能在真机上出现、且延迟可接受——是在新提示词上验的：2026-11-28
的回合结束后 **967 ms** 出现三条芯片，中断回合不出芯片，重启后旧句只做幽灵。

所以这条的结论是：脚本本身可用（200），且它当初想验的功能已在新实现上验过。

## 2. 面板上的名字与说明行是真机上的新文案（原 `S-20261126-label` 的 pending）

在已配对的页面上点 `button[aria-label="面板设置"]`，读 DOM：

```
.dsse-setting-label  → ["每轮自动总结", "摘要与建议模型"]
该行文本 → "摘要与建议模型 两处共用一个模型：面板摘要与下一轮建议。默认沿用当前会话已验证的路由。跟随当前会话 此处修改立即生效，重启宿主后恢复。永久修改请前往插件设置。"
```

标签是「摘要与建议模型」，说明行讲了「两处共用一个模型」，与 `lib/client.js`
里的字符串逐字一致。**注意**：这条只能在真机上看，因为同一段文案在测试里是
用查询函数找的（`byClass(...).map(...)` 全量收集再匹配），测试能证明「树里有
这句话」，但不能证明「宿主把它渲染到了屏幕上」。

## 一条观察（不改，仅记录）

`verify:live` 目前只做「能不能通」的探针（打印 200 与顶层键），不校验载荷内容。
它适合当冒烟检查，不适合当验收口径——这也是为什么 11-27/28 的验收用的是页面
DOM 与路由 `reason` 字段，而不是这个脚本。若将来要它承担验收，得给它加断言参数。

## 结果

`ACTIVE-STATE.md` §3 现在应为空。本次只动文档，不动代码。
