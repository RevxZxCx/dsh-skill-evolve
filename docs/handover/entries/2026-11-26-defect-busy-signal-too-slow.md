---
id: D-20261126-busy
date: 2026-11-26
type: defect
status: verified
title: 服务端的 busy 到得太晚，回合运行中两个界面照样显示
packages: [ui-evolve]
baseline: 4441 passed / 0 failed（client 1081/0、suggest 239/0、api 429/0、mutations 55/0、mutate-suggest 90/90 全杀、perf 退出 0）
pending_verify: 无（已于 2026-11-26 22:42 在 /pair-app 真机复验通过）
---

# 2026-11-26 · 「回合在跑」不能靠一次网络往返判断

## 现象

`32282c5` 已经实现了服务端判据：`view.current.turn !== undefined` 时返回
`{ enabled: true, items: [], reason: 'a turn is running', busy: true }`，客户端据此隐藏
芯片与幽灵，单元测试 239/0、1074/0 全绿。但真机上发一条消息后，两个界面**照样显示**
整整一个回合。

## 真机实测（决定性）

在 `/pair-app` 上每 350–400 ms 采样，发「数到 N，只输出数字」：

| 时刻 | 宿主主按钮 | 芯片行 | 幽灵 |
| --- | --- | --- | --- |
| 713.1 ms | `send` | 1 | 1 |
| 717.1 ms | **`stop`**（`aria-label=停止生成`） | 1 | 1 |
| 721.1 ms | `stop` | 1 | 1 |
| 227.4 s（另一轮） | — | 0 | 0 |

同一轮里手动请求 `/api/ui-evolve/suggestions`：

- 一次 **3125 ms** 返回，一次 **5017 ms** 返回；
- 其中一次返回的不是 `busy`，而是**缓存的旧建议**（`cached: true`）；
- `/panel` 超过 7 s 未返回，`/speed` 同样要数秒。

**结论：回合运行期间宿主极忙，任何一条走 `/api` 的往返都要 3–10 秒。** 用服务端的
`busy` 当唯一判据，等于让「该隐藏」这个消息和建议本身一起到达——到了也没有意义。
这不是门控写错，是判据选错了来源。

## 修法：改读宿主自己的按钮

宿主在消息交出去后 **0.5 秒内**把输入框主按钮从
`data-dsh-claude-control="send"` 换成 `"stop"`，回合结束时换回。这是页面上唯一
即时反映「回合在跑」的东西。

`packages/ui-evolve/lib/client.js`：

- `function turnRunning()` —— `document.querySelector('[data-dsh-claude-control="stop"]') !== null`。
  取不到 `document` 时返回 `false`（旧宿主、测试环境的行为与之前完全一致）。
- `function watchRunning()` —— 一只 `MutationObserver` 观察
  `document.documentElement` 的 `data-dsh-claude-control` 属性，**只在值真的变化时**
  `notifySuggest()`。两个槽位都会调用它，但 `runningWatch` 是模块级的，第二次是空操作：
  两只 observer 只会把同一次变化通知两遍。
- store 增 `running: false`；`resetSuggest` 里 `suggest.running = turnRunning()`（**重新读页面**，
  不是盲目置 `false`——会话切了，回合的状态属于页面不属于会话）。
- 两个界面的 `shown` 都加 `suggest.running === false`；卸载时 `runningWatch.disconnect()`。

**两条信号都保留**：页面信号即时但只在有 composer 时存在；服务端的 `busy` 慢但能在
没有渲染过 composer 的页面上活下来。任一为真就保持安静。

## 为什么测试没抓到

`test/client.test.mjs` 的 `documentStub.querySelector` 只认五个选择器，**没有一个返回过
`stop`**；`settings.stop` 这个概念根本不存在。于是「页面说回合在跑」这条门控在测试里
永远为 `false`，加了等于没加，而服务端那条 `busy` 的断言照样绿。

补上的测试（`client` 1074 → 1081）：

- `stop: true` 时芯片行与幽灵都不画，**且答案照常取回保存**（回合结束后要立刻能显示，
  不能为了隐藏而少买一次调用）；
- 页面只被**一只** observer 观察，`attributeFilter` 含 `data-dsh-claude-control`，
  目标是 `documentElement`；
- 两个槽位都挂载后仍是一只；
- `settings.stop` 改回 `false` 并 `trigger()` 后，芯片行与幽灵**都回来**。

## 教训

1. **判据要选「最快知道这件事的那一方」。** 同一事实有两个来源时，取延迟最短的那个：
   服务端的 `busy` 在真机上是 3–10 秒，宿主的按钮是 0.5 秒，差了两个数量级。
2. **测试替身必须能表达「这件事发生了」。** 一个永远返回 `null` 的选择器，会让整条
   门控在测试里静默失效，而所有断言仍然是绿的——这正是 DEF-191 的老毛病：判据朝着
   绿的方向失明。
3. **修完之后先跑突变，不要先跑全量。** 第一版补的幽灵断言没有挂输入卡片，幽灵因为
   「没有 placeholder」而隐藏，断言恒真，突变 `UNCOVERED` 才把它逼出来。

## 真机复验（2026-11-26 22:42，`/pair-app`，客户端 rev `69027385aeaa`）

用 `Page.addScriptToEvaluateOnNewDocument` 在宿主自己的 fetch 拦截器**之前**装桩，让
`/api/ui-evolve/suggestions` 返回三条固定建议（不花用户额度），然后发一条真消息，
每 700 ms 采样：

| `performance.now()` | `[data-dsh-claude-control="stop"]` | 芯片行 `data-shown` | 幽灵 |
| --- | --- | --- | --- |
| 54880–59154 | 1 | 0（0 项） | `false` |
| 61053–65324 | 0 | **1（3 项）** | **`true`** |

即：回合一开始（`stop` 出现）两个界面立刻消失，回合结束（`stop` 消失）立刻回来，
**没有那 3–5 秒的窗口**。同一次会话里芯片几何为 `margin-left: -16px; width: 712px`
（与输入卡片一致），行首三个记号均为 `viewBox="0 0 16 16"`、`overflow: visible`、
两条 path 的 `getBBox()` 是 `{x:2.5,y:8,w:10,h:0}` 与 `{x:8.5,y:4,w:4,h:8}`
—— 终点 x=12.5 朝右，全部在 viewBox 内。

## 复验时踩到的两个工具坑

1. **旧的 `/pair-app` 标签页会整页卡死**：`document.readyState` 与 `1+1` 都
   `Runtime.evaluate timed out`，`Page.reload` 也救不回来，而宿主本身
   `curl /api/pair/status` 只用了 3 ms。关掉该标签页、重开一个就正常。**遇到
   evaluate 全超时，先分清是宿主卡还是标签页卡，不要继续在同一个 target 上重试。**
2. **手工改 `data-dsh-claude-control` 验证不了门控**：该属性由 React 控制，`setAttribute`
   之后立刻被渲染改回（改完读到 `stop:0, send:1`）。要验证只能跑一次真实回合。
