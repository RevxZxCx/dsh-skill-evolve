# 缺陷与教训

> **追加式**。修完一个缺陷就追加一条，不改旧的。每条都要写「为什么测试没抓到」——那是比缺陷本身更有用的部分。

| 编号 | 日期 | 一句话 | 为什么测试没抓到 |
|---|---|---|---|
| DEF-01 | 2026-10 | `writeSkill` 每次重写都把文件写坏（NUL 填充） | 只断言了内容含关键词，没断言字节干净 |
| DEF-02 | 2026-10 | 队列与账本的读-改-写有竞态 | 测试都是串行的 |
| DEF-03 | 2026-10 | `service('agents')` 读法抛错，检测器与反思路径同时失效 | 假宿主上属性存在，真宿主上抛错 |
| DEF-04 | 2026-10 | 证据闸门查错会话，跨会话批准必然失败 | 测试只测同会话 |
| DEF-05 | 2026-10 | `final: true` 仍强制要求重传证据 | 断言把错误行为写成了正确 |
| DEF-06 | 2026-10 | 提示永不退役，同一条重发 85 步 | 合成测试没有真实回合序列 |
| DEF-07 | 2026-10 | 批准时重算 stale，锁内调 `loadQueue()` 死锁 | 并发路径没测 |
| DEF-08 | 2026-10 | `findExistingSkill` 在上游丢掉生命周期字段 | 断言取错了数据源 |
| DEF-09 | 2026-10 | `POST /config` 被 `GET /config` 分支抢先 | 没有该路由的测试 |
| DEF-10 | 2026-10 | 所有写入路由不校验 `content-type` | 没有该路由的测试 |
| DEF-11 | 2026-10 | 同名候选删错行（`findByName` 优先 live） | 单行 fixture |
| DEF-12 | 2026-10 | 点行内按钮触发 blur，卡片关闭 | 测试直接调 `props.onClick()` |
| DEF-13 | 2026-10 | 卡片内部滚动关闭卡片 | 测试不滚动 |
| DEF-14 | 2026-10 | 窄视口详情卡压住列表按钮列 | 只断言盒子在视口内，不断言互不相交 |
| DEF-15 | 2026-10 | `panelHelp` 是空转的开关 | 断言只验它被保存与回显 |
| DEF-16 | 2026-10 | `lib/index.js` 变回 CRLF，两个变异静默失配 | 变异脚本报 `NOT APPLIED` 但被误读 |

---

## DEF-01 · `writeSkill` 把文件写坏

**现象**：每次改写一个已存在的技能文件，写出来的文件被 NUL 字节填满。

**根因**：打开文件时用了固定长度的写入路径，新内容比旧内容短时，尾部残留旧字节的填充。

**修法**：写到临时文件再 `rename`。

**为什么测试没抓到**：断言只检查"内容里包含这串关键词"——NUL 填充不影响关键词存在。**修完补的断言是 `rawBytes.includes(0) === false`，那是把"坏"本身写成断言。**

## DEF-02 · 读-改-写竞态

**现象**：并发时丢失写入；账本"声称 append-only"却会丢记录。

**根因**：`writeJson` 只保证"不写半个文件"，不保证一致性。跨 session 的交错读-改-写会让后一个 `rename` 发布一个早于另一写者的快照。`appendLedger` 原来是"读全量 + 拼一行 + rename"，两个并发写者读到相同原始字节，后到的 `rename` 把先到的记录抹掉。

**修法**：`Store.serialize()` promise 链；`mutateCandidates` / `mutateRegistry` / `*Within` 系列在锁内读改写；`appendLedger` 改成真 `O_APPEND`（`appendFile`），只在超 5MB 时才回退到"保留尾部"的重写。

**为什么测试没抓到**：所有测试都是串行调用的。

## DEF-03 · `service('agents')` 抛错，两条触发路径同时失效（最隐蔽的一个）

**现象**：插件加载正常、工具可调、所有测试绿，但真实会话里**从不触发任何提示或反思**。

**根因**：cordis 对**未声明的服务**在**属性读取本身**就抛错：

```js
const error = new Error(`cannot get property "${name}" without declaring it in inject`)
```

可选链救不了——不是"返回 undefined"，是抛。所以 `ctx.agents` 直接炸掉整个事件处理器，处理器被 `safe()` 包裹后异常不泄漏，于是**静默失效**。

**修法**：所有服务读取改走 `ctx.get(name)`；假宿主补 `get`。

**为什么测试没抓到**：假宿主的 `ctx` 是普通对象，`ctx.agents` 存在且可读，永远不会抛。**测试环境的宽松恰好掩盖了真实环境的严格。**

**教训（本仓库最重要的一条）**：`safe()` 包裹处理器是对的（异常不该污染宿主 turn loop），但它会把"整条路径彻底死了"变成"什么都没发生"。**静默失效比崩溃更难查**，所以任何 `safe()` 包裹的路径都需要一条"真的会产生输出"的端到端断言。

## DEF-04 · 证据闸门查错了会话

**现象**：三条 live 候选全部卡在 `no-evidence`，跨会话批准 100% 失败。

**根因**：`skill_candidate_submit` 在 `final: true` 分支之前就跑 `runGate({evidence, lanes: lanesFromEvents(deps.eventsFor(agent))})`。候选来自**别的会话**（例如上一轮工作的会话），那些引文在当前会话里当然不存在。

**修法**：证据校验归属**提交阶段**，批准阶段只信候选自己存下的 `verifiedAt` / `verifiedInSession`。

**为什么测试没抓到**：所有测试都在同一个假会话里提交并批准。

**教训**：**校验的时机与数据的来源必须匹配。** 一条跨会话流动的数据，不能在终点用起点的规则重新验一遍。

## DEF-05 · `final: true` 仍强制重传证据

**现象**：模型批准一条已存好证据的候选时，报 `no-evidence: At least one evidence quote is required.`

**根因**：`final` 分支复用了提交分支的入参校验，而 `final` 的语义是"我按你的要求写定稿"，不是"我重新提交"。

**修法**：`final` 分支不再要求 `evidence`，只在候选本身没有存证时才要求。

**为什么测试没抓到**：**测试断言把错误行为写成了正确行为**（`check('final also requires evidence', ...)`）。这是最坏的一类——它让缺陷看起来是规格。

## DEF-06 · 提示永不退役

**现象**：真实会话里同一条提示被重发 85 步、67,212 字符，零次提交。

**根因**：模型有两条路径响应提示——提交，或"读完判断不值得"。第一条有代码清除文本；**第二条什么都没做**，所以提示一直重发。

**修法**：两级降级。`hintShrinkAfterSteps`（默认 8）后缩成一行摘要，`hintExpiresAfterSteps` 后退役。退役只停止重发文本，不撤销"已展示"标记，`skill_candidate_submit` 工具始终可用。

**为什么测试没抓到**：合成测试里"模型忽略提示"不会发生——测试要么提交要么不喂事件，没有真实回合序列。

**教训**：**提示的默认结局是"被忽略"，不是"被响应"。** 任何常驻文本都要设计它的退役路径。

## DEF-07 · 批准时重算 stale 造成死锁

**现象**：锁重构后两条测试卡住不返回。

**根因**：`finalizeWithin` 在 `store.serialize` 内调 `loadQueue()`，而 `loadQueue` 内部走 `store.mutateCandidates` → 又要拿同一把 `serialize` 锁。**队列不可重入。**

**修法**：新增 `mutateCandidatesWithin` / `mutateRegistryWithin` / `recordWithin` 系列，锁内调用它们而不是外层版本。

**为什么测试没抓到**：并发与嵌套路径没有测试。

**教训**：引入串行区时，必须同时引入"已持锁"版本的方法，否则每个内部调用都是一次潜在的自锁。

## DEF-08 · 修订时丢掉生命周期字段

**现象**：auto 模式下每次修订都把 `helpful`/`harmful`/`id`/`evidence` 清零。

**根因**：症状出现在修订分支，但字段在**上游** `findExistingSkill` 就丢了——它只回传 `{owned, path, body, stage, uses, created}`，`revision` 对象也只从这些字段构造。**在修订分支补字段无效。**

**修法**：`findExistingSkill` 与 `revision` 对象都补全字段。

**为什么测试没抓到**：断言取自 `registry.json` 的行（该行不带 `id`），所以 `idBefore === undefined || ...` 恒真；证据断言又被正文自身满足。**两条断言都是空真。**

**教训**：**症状出现的函数未必是数据丢失的函数。** 顺着"这个字段从哪来"往回查，而不是在出事的函数里打补丁。

## DEF-09 · `POST /config` 被 GET 分支抢先

**现象**：面板上的开关看起来生效了，实际没写入。

**根因**：路由分发只按路径匹配，`GET /config` 的分支先命中，`POST /config` 永远走不到。

**修法**：分发按方法 + 路径。

**为什么测试没抓到**：该路由当时没有任何测试。**新路由必须先有测试再加功能**，否则"看起来能用"就是全部证据。

## DEF-10 · 写入路由不校验 content-type

**现象**：`POST /candidates` 接受任意 content-type 的请求体。

**根因**：`checkOrigin()` 只查 host/origin/sec-fetch-site，`readJsonBody()` 只查长度与 JSON.parse。跨站 `<form enctype="text/plain">` 不受预检约束，`sec-fetch-site` 也并非所有浏览器都发送。

**修法**：`readJsonBody` 开头校验声明的类型必须是 `application/json` 或 `*+json`，否则 415。无 content-type 时仍解析（curl 与既有测试不受影响）。

**为什么测试没抓到**：没有该路由的测试——是补 `/candidates` 覆盖时**测试自己抓到的**。

## DEF-11 · 同名候选删错行

**现象**：面板上点一条 stale 候选的 ✕，删掉的是同名的 live 候选。

**根因**：客户端只发 `{name, action}`；宿主 `discardCandidate(name)` 走 `findByName`，其实现是 `matches.find(entry => entry.stale === undefined) ?? matches[0]`——**优先返回 live 行**。

**修法**：客户端发 `id`；宿主 `byIdThenName` 优先按 id；**id 查不到就是 miss，不回退名字**（回退本身就是缺陷，见 D-08）。

**为什么测试没抓到**：fixture 里每个名字只有一行。

## DEF-12 · 点行内按钮会关掉卡片

**现象**：confirm 模式下批准后，"已批准，等模型写出定稿"这句提示读不到。

**根因**：`onBlur: scheduleClose` 挂在 wrapper span 上，行内 ✓/✕ 是真 `<button>`，React 的 `onBlur` 走 focusout 冒泡 → 220ms 后关闭。

**修法**：`relatedTarget` 仍在卡内就返回。

**为什么测试没抓到**：测试直接调 `props.onClick()`，从不触发 focus 变化。

## DEF-13 · 卡片内部滚动关闭卡片

**现象**：候选超过屏幕能放的行数时，一滚动列表卡片就消失。

**根因**：`window.addEventListener('scroll', close, true)` 捕获任何元素的滚动。`.dsse-ck-body` 是 `overflow-y:auto`，`maxCandidates` 允许 50 条而 260px 只放得下约 7 行——内部滚动是常态。

**修法**：判断 `event.target.closest('.dsse-ck, .dsse-ck-detail')`，在里面就返回。

**为什么测试没抓到**：测试不滚动。

## DEF-14 · 详情卡压住列表的按钮列

**现象**：窄窗口下 hover 行看详情，就点不到该行的批准/忽略。

**根因**：`placeNear` 只把详情卡夹进视口，不避让列表。实测 `vw=768` 重叠 116px、`vw=900` 重叠 80px，`vw≥1440` 才完全不重叠。

**修法**：`placeNear` 新增 `avoid` 矩形，命中时改放另一侧、再上方、再下方。

**为什么测试没抓到**：`test/placeNear.test.mjs` 只断言每个盒子不出视口，**没有断言两者不相交**。断言"各自合法"不等于断言"彼此不冲突"。

## DEF-15 · `panelHelp` 是空转的开关

**现象**：配置项 `panelHelp` 被写进配置、被 API 返回、被 README 描述为"每张卡片标题下方的一行说明"，但**客户端从未读取它**，卡片里也没有任何说明文字行。

**修法**：删除（`config.js`、`api.js`、两个测试文件、README）。

**为什么测试没抓到**：`test/panel-wiring.test.mjs` 断言的是"它被保存并能回显"——那**确实**成立。没有断言问"读它的代码在哪"。

**教训**：**一个配置项的存在不等于它有作用。** 加配置时要有断言证明读的一侧存在；否则它只是一个让人以为自己关掉了什么的无害谎言。

## DEF-16 · CRLF 让变异静默失配

**现象**：`node test/mutate-panel.mjs` 报 `12/14`、exit=1，两个多行锚点 `MISSING ANCHOR`。

**根因**：`lib/index.js` 被 Python 文本模式 `open(...,'w')` 写回，Windows 上把 `\n` 悄悄变成 `\r\n`，而锚点用 `\n` 写。`test/mutate-panel.mjs` 不做事先归一化。

**修法**：二进制层 `raw.replace(b'\r\n', b'\n')` 后写回；全仓校验纯 LF。

**教训**：**"少测了两个变异"不会报错**。变异脚本必须先把"锚点命中"这件事本身断言掉，否则少测的表现是"看起来也全绿"。
