---
id: S-20261127-lifecycle
date: 2026-11-27
type: status
status: pending_live_verify
title: 建议的生存期改成回合边界，过期只留幽灵，并把那一句话写进状态文件
packages: [ui-evolve]
baseline: 4513 passed / 0 failed（client 1096/0、suggest 287/0、session-state 376/0、api 429/0、mutations 55/0、mutate-suggest 110/110 全杀、perf 退出 0）
pending_verify: 重启宿主后确认三件事——后台放一段时间再切回来自动出现建议；新一轮开始时旧建议先消失、新答案到达后再出现；同一回合重复打开不再二次购买，且重启后输入框幽灵仍在
---

# 2026-11-27 · 一条建议该活多久

## 用户口径（原话）

> 持久化的建议不需要存多条，我们只用显示针对上一轮给出的建议即可，之前的建议也不会重新搬出来再用。有效期我认为不需要设置，实际的建议生存周期应该是上一轮对话完成，下一轮对话开始这中间这段时间，这才是建议的真实使用时间。

这句话否掉了我先前的 15 分钟 TTL：**没有时钟**，生存期就是一个回合边界。

## 改了什么

### 1. 没有时钟，只有边界（`packages/ui-evolve/lib/client.js`）

删掉 `SUGGEST_MAX_AGE_MS`、`armExpiry()`、store 的 `expiry`，以及两处
`const fresh = suggest.at === 0 || Date.now() - suggest.at < SUGGEST_MAX_AGE_MS`。

新增 `forgetOffer()`，清 `items` / `used` / `at` / `turn` / `stale` / `loaded` / `again` /
`retried`，并 `clearTimeout(suggest.retry)`；`watchRunning()` 的 `read()` 在**两个边界**都调用它：

```js
        const next = turnRunning()
        if (next === suggest.running) return
        suggest.running = next
        forgetOffer()
        notifySuggest()
```

为什么结束那一刻也要清：回合结束后屏幕上那条回答已经不是「最后说的」，而它自己的建议要等流里的帧才到。在帧到之前继续画旧的，正是用户报的「新一轮里还显示上一轮建议」。

### 2. 回前台补一次刷新

新增 `watchVisibility()`，`visibilitychange` 且 `document.hidden === false` 时：重读 `turnRunning()`
（后台期间 observer 被冻住，值不能信），必要时 `forgetOffer()`，然后
`void loadSuggest(suggest.sessionId)`。两个槽位都调用，模块级 `visibilityWatch` 保证只注册一次。

### 3. 过期不再买第二次，降级成幽灵（`packages/ui-evolve/lib/suggest.js`）

原来「缓存过期 → `delete` → 重新调模型」，现在是：

```js
    if (cached !== undefined) {
      const stale = now - cached.at >= SUGGEST_TTL_MS
      return { enabled: true, items: cached.items, at: cached.at, cached: true, turn,
               ...(stale === true ? { stale: true } : {}) }
    }
```

`SUGGEST_TTL_MS` 的含义从「生命周期」降为「还算新鲜」。客户端芯片的 `shown` 加
`suggest.stale === false`，幽灵不加——于是过期后只剩输入栏那一句，这正是用户要的降级。

### 4. 只存一条（`packages/ui-evolve/lib/session-state.js` + 接线）

- `readOffer(raw)` 校验 `text` 非空、`at` / `turn` 有限；`readState()`、`blankRecord()`、
  `readInto()`、`document()`、`hasFacts()` 各加一处 `offer`。
- **`keepsDocument()` 必须加一条**：第一版我论证过「offer 一定伴随 previous，所以不必进保留判据」，
  测试立刻造出反例——一个只有幽灵、没有技能也没有交付文件的会话会被当成孤儿文件删掉。
- `rememberOffer()` 用 `this.entry(sessionId)` 而不是 `bySession.get(...)`：重启后记录还不存在，
  用 get 会静默丢弃（session-state 套件当时 5 条 FAIL）。
- `STATE_VERSION` **不 bump**：`session-state.js` 的注释写明加字段不需要。
- `Suggestor` 的构造函数改成接受 `stored` / `persist` 两个注入（让 `suggest.js` 不碰磁盘），
  `index.js` 接到 `sessionState.offerSeen` / `rememberOffer`；`run()` 成功后
  `this.persist(agent, { text: items[0], at, turn })`。

## 数字

- 全量 `4513 passed / 0 failed`；`client` 1096、`suggest` 287、`session-state` 376、
  `api` 429、`mutations` 55、`docs` 57、`registration` 56。
- `scripts/mutate-suggest.mjs` **110 条，实跑 110 killed / 0 survived / 0 crashed**。
- `scripts/perf-budget.mjs` 退出 0：payload-real 18,075 B / ceiling 60,911 B / elapsed 4 ms /
  state-file 41,941 B。

## 两处只有跑突变才暴露的东西

1. **两个突变是 CRASHED 而不是 KILLED**：`the last resort is not reached` 与
   `the sentence is never written down` 都死在测试夹具的 `written[0].offer` ——
   没有写盘时 `written` 为空，裸读把「没发生」变成 `TypeError`，套件连 tally 行都没打出来。
   改成 `written[0]?.offer` 后，两者都变成 9 条与 88 条干净的 FAIL。
2. **旧锚点会静默消失**：`suggest.js` 的缓存分支、`client.js` 的 `useEffect`、
   已删除的 `fresh` 两行，三条锚点在改完代码的当天就不再匹配。锚点不是测试，
   它不会自己告诉你它已经不在看着任何东西了——所以 `test/mutations.test.mjs` 的数字必须是 `===`。

## 没有的东西

- 没有给 `offer` 设任何有效期。一个会话放了三天再打开，那句幽灵仍在——按用户口径，它描述的是
  「上一轮结束后可以做什么」，只要没有新回合它就还没被回答。
- 没有回放多条历史建议。
- 没有在服务端记录这次调用的 effort / 耗时 / tokens（可观测性缺口仍在，见 `D-20261126-busy` 一节）。
