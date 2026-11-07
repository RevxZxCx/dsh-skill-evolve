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
| DEF-17 | 2026-10-30 | 旧会话、候选和设置响应覆盖新状态 | 测试全部立即返回，没有反向完成顺序 |
| DEF-18 | 2026-10-30 | 动态删除焦点按钮后 Tab 可逃出审核 modal | fake DOM 没有焦点模型，只测了 Escape |
| DEF-19 | 2026-10-30 | 矮视口下审核底部操作区被裁切 | 几何 sweep 没覆盖 modal 的内容高度与短视口 |
| DEF-20 | 2026-10-30 | 切换面板位置会清空已加载卡片 | 所有 bridge 通知都走同一个 loading 分支 |
| DEF-21 | 2026-10-30 | 后插入代码元素时等宽字体不更新 | observer 只监听属性，没有覆盖 childList |
| DEF-22 | 2026-10-30 | 关闭动画期间重新打开会被旧关闭定时器再次关闭 | 关闭延迟在 Modal 内部，父组件无法取消 |
| DEF-23 | 2026-10-30 | 侧向设置被拒绝后界面停留在被拒侧 | 位置立即写入 bridge，失败回滚只处理 config |
| DEF-24 | 2026-10-30 | 字体变量写回根节点会再次触发 observer | observer 监听根节点 style，而写入目标正是根节点 style |
| DEF-25 | 2026-11-03 | 面板引用了主题里不存在的别名，样式静默失效 | 主题 token 用了 `--dsw-*` 前缀，而真实名字是 `--dsw-alias-*` |
| DEF-26 | 2026-11-03 | 网格项不肯变窄，行内容溢出被裁 | `min-width:auto` 是 grid 默认值，必须显式写 `min-width:0`（假渲染器没有布局引擎，溢出只在真实浏览器成立） |
| DEF-27 | 2026-11-03 | 「上一轮」卡片被自身统计条撑高，总结正文没有高度上限 | 计数在正文下方另占一整块，正文没有 `max-height`；`scrollHeight` 在假渲染器里恒等于 `clientHeight` |
| DEF-28 | 2026-11-03 | 渐隐遮罩恒定渲染，没被截断的短摘要也被压暗 | 把「是否溢出」写成常量 `data-clipped='true'`，断言把缺陷固化成期望 |
| DEF-29 | 2026-11-03 | 卡片全空时设置弹窗被卸载，随后自行重新弹出 | 设置状态挂在卡片子树上，子树被条件渲染摘掉时一起消失 |
| DEF-30 | 2026-11-04 | `agent/disposed` 的载荷形状在拆分时被写错 | 从旧实现里抄了字段名，没有对着事件定义核一遍 |
| DEF-31 | 2026-11-04 | 客户端 bundle 的注册 id 必须是包名全称 | 名字看着像包名，但宿主按 `name` 精确匹配 |
| DEF-32 | 2026-11-06 | 头部空出一条：已删按钮的 `min-height` 留在三张卡上 | 假渲染器没有布局引擎，固定高度造成的空白不可观测 |
| DEF-33 | 2026-11-06 | hover 仍然展开卡片，与「点击才展开」的契约不符 | 断言写在 `data-expanded` 上，而它在 hover 与 click 两条路径上都能变 true |
| DEF-34 | 2026-11-06 | `EventSource` 遇到不可用响应会永久放弃重连，而轮询已被清掉 | 测试替身从不模拟「打开后永久失败」，只模拟过「打开」 |
| DEF-35 | 2026-11-06 | HEAD `/live` 落到 404，探活把存在的路由报成不存在 | 只给 `/panel` 写过 HEAD 断言，新路由上线时没人补 |
| DEF-36 | 2026-11-06 | 「开着的卡片能关掉」这条守卫静默空转了一轮 | 前提不成立时 `continue`，套件仍然全绿 |
| DEF-37 | 2026-11-06 | 测试桩 `setInterval` 返回 0，轮询被清与否不可观察 | 桩的目的只是「不让进程挂着」，返回值被当成无关紧要 |
| DEF-38 | 2026-11-06 | 两条 phase 变异是同一个变异，且 label 描述的效果与代码相反 | 只验证了「变异被杀」，没有验证「它杀的是哪条断言」 |
| DEF-39 | 2026-11-06 | README 说「按流重读 `/panel`」，而同一文件后文说「没有订阅、没有推送」 | 撤回流时只改了新增段落，没有回扫全文里的同义描述 |
| DEF-40 | 2026-11-06 | README 引用的 `D-74` 在决策记录里不存在 | 先写引用、打算稍后补记录，中间没有任何检查会因此变红 |
| DEF-41 | 2026-11-06 | 新写的状态文档里四个数字错了三个口径 | 数字是手工数出来的，没有把「产生它的那条命令」一并写下 |
| DEF-42 | 2026-11-06 | `git ls-files` 默认给中文路径加引号转义，`[ -f ]` 全落空，数出 100 而非 109 | 命令的输出格式被当成了「路径列表」 |
| DEF-43 | 2026-11-07 | 圆标带 `title`，但 `pointer-events:none` 让它永远不可能是命中目标，tooltip 无从弹出 | 惰性属性：读起来像功能，跑起来什么都不做 |
| DEF-44 | 2026-11-07 | 行为推翻了 D-69 的两条结论，README 改了而决策记录没补 | 改行为时只想起「描述现状的文档」，忘了「记录理由的文档」 |
| DEF-45 | 2026-11-07 | 只含产出路径的会话状态文件被 `dropIfOrphan` 当作孤儿删掉 | 新增字段时只改了「判据函数」，没改每个调用点传给它的事实 |
| DEF-46 | 2026-11-07 | 表外合法语言标签被静默丢弃，提示词里一句语言约束都没有 | 删掉一句旧提示时以为新代码覆盖了它，实际只覆盖了表内 11 种语言 |
| DEF-47 | 2026-11-07 | 中断的回合把上一轮的产出文件重复记为最新，自己改的却丢了 | 在「折叠当前轮」的调用之后读 `previous`，读到的是更早那一轮 |
| DEF-48 | 2026-11-07 | 表外语言与「无语言」共用同一个摘要缓存键 | 缓存键用了语言**名**，而提示词用的是语言**句** |
| DEF-49 | 2026-11-07 | 路径上限被 `load` 的合并分支绕过，重启间无界增长（200→400→600→800） | 上限只加在一条写入路径上，当成对数据的约束 |
| DEF-50 | 2026-11-07 | 锚点自检在数量不等时静默空转；语言断言被 `if` 包住 | 检查代码自己也需要被检查：布尔量恒真时断言看起来仍然通过 |
| DEF-51 | 2026-11-07 | 产出卡头部说「10 个文件」而列表只列 5 行，「全部 10 个」按钮在滚动区外看不见 | 把「显示全部」的入口放在列表末尾，于是截断提示与列表一起被截断 |

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

## DEF-17 · 旧响应覆盖新会话、队列和设置

**现象**：会话 A 的慢面板请求可在会话 B 已渲染后覆盖成 A 的数据；重复打开候选队列有同类问题；快速修改两项设置时，较旧响应会回滚最新选择。

**根因**：三个异步写入点都没有请求代数或会话校验，所有响应都被当成最新结果应用。

**修法**：面板、候选和配置分别使用递增请求序号；面板同时核对捕获的 session 与当前 bridge session，候选关闭时使旧序号失效，设置只应用最新响应或回滚。补 A 慢 B 快及设置反向完成顺序测试。

**为什么测试没抓到**：路由全部同步 resolve，测试从未让旧请求最后返回。

## DEF-18 · 焦点按钮消失后 Tab 逃出 modal

**现象**：批准或忽略后，当前焦点按钮被禁用或删除，浏览器可把焦点移到 body；此时 Tab 会进入宿主页面。

**根因**：焦点圈定只处理焦点位于首尾控件的情况，没有处理焦点已在 dialog 外的情况。

**修法**：Tab 时先检查 `node.contains(document.activeElement)`，焦点在外则阻止默认行为并聚焦首/末控件。真实 DOM 验证删除按钮后的 Tab，fake DOM 也补首尾焦点及 Shift+Tab 环绕测试。

**为什么测试没抓到**：原 fake DOM 没有 `querySelectorAll`、`activeElement` 和 `focus()`，焦点代码实际没有运行。

## DEF-19 · 矮视口裁掉审核操作区

**现象**：视口高度不足时，dialog 有最大高度和 `overflow:hidden`，审核网格却保持 360px 最小高度，批准/忽略 footer 被裁出可见区域。

**根因**：网格最小高度优先于内部收缩，窄屏规则也没有取消它。

**修法**：网格改为视口派生高度且 `min-height:0`，候选列表与详情各自滚动；矮高度媒体规则压缩队列和头部、隐藏冗余 footer 说明。真实浏览器在 500px 高度确认 footer 完整可见。

**为什么测试没抓到**：旧 sweep 只覆盖旁侧弹层坐标，没有测量新 modal 的内容与 footer。

## DEF-20 · 面板位置切换清空三卡

**现象**：设置里切换左右侧后，已加载总结、技能和文件短暂变成 loading 或空数据；保存失败时可长期不恢复。

**根因**：Cards 对所有 bridge 通知都执行 `setState({status:'loading'})`，而位置变化并不需要重新取数。

**修法**：移除该订阅清空逻辑，只在 `sessionId` 真正变化时进入加载态；位置变化保留当前数据。补位置切换数据保留断言。

**为什么测试没抓到**：原测试只验证位置变化本身，没有同时断言已加载数据仍在。

## DEF-21 · 后插入代码元素时等宽字体不更新

**现象**：初始会话没有 `code/pre` 时面板使用正文字体充当等宽字体，之后插入代码元素仍不更新。

**根因**：字体 observer 只监听 class/style 等属性，代码节点插入和删除不会触发同步。

**修法**：仅对会话内容增加 `childList` + `subtree` 观察，并过滤出添加/删除 `code/pre` 或其祖先的变化；普通流式文本插入仍不写排版变量。真实 DOM 验证删除和插入代码后的字体变化。

**为什么测试没抓到**：原测试从已有代码元素开始，并手工调用 observer 回调，没有覆盖真实节点生命周期。

## DEF-22 · 关闭动画期间重新打开会被旧定时器关闭

**现象**：按 Escape 或遮罩关闭审核 modal 后，180ms 内再次点击入口，弹窗会在新打开后被旧关闭定时器再次关闭。

**根因**：关闭延迟由 Modal 内部持有，父组件重新打开时无法取消已排定的 `onClose`。

**修法**：审核和设置都使用递增 epoch 作为 Modal 的 key。重新打开会卸载旧 Modal 并清理其定时器，新 Modal 以干净状态挂载。真实浏览器验证关闭动画中重新打开后弹窗保持打开。

**为什么测试没抓到**：原测试按“关闭完成后再打开”的顺序操作，没有覆盖 180ms 窗口。

## DEF-23 · 侧向设置被拒绝后界面停留在被拒侧

**现象**：设置中切换面板位置时，bridge 立即切换；若保存被拒绝，卡片仍显示在被拒侧，与配置实际值不一致。

**根因**：侧向切换为了即时反馈直接写 bridge，而 `saveConfig` 失败只回滚 config，不回滚 bridge。

**修法**：保存失败或响应 `ok:false` 时，把 bridge 回滚到保存前的 `panelSide` 并通知；同时把 `ok:false` 的配置响应视为失败而不是静默接受。补拒绝路径断言。

**为什么测试没抓到**：原测试只覆盖保存成功路径。

## DEF-24 · 字体变量写回根节点会再次触发 observer

**现象**：字体 observer 监听 `documentElement` 的 style 属性，而同步函数把 `--dsse-font-*` 写回同一个 style，可能形成自我触发循环。

**根因**：写入目标与观察目标相同，且 `setProperty` 对相同值也会触发属性变更。

**修法**：写入前比较当前值，只有值变化才 `setProperty`；重复同步不再产生写入。补“重复同步不写回相同排版”断言和对应变异。

**为什么测试没抓到**：原字体测试只断言最终值，没有统计写入次数。

## DEF-25 · 面板引用了主题里不存在的别名

**现象**：真实 Chrome 渲染时「本插件」徽标蓝底蓝字，几乎不可读；技能名右侧的徽标被卡片裁掉，只剩一条蓝色残块。前者在浅色下还只是难看，后者在任何配色下都缺内容。

**根因**：`lib/client.js` 引用 9 个 `--dsw-*` 变量，其中 4 个宿主主题从未定义：`--dsw-alias-bg-brand`、`--dsw-alias-label-brand`、`--dsw-alias-border-brand`、`--dsw-alias-border-secondary`。名字是照着手写 fixture 里的假 token 抄的，不是从宿主样式表读出来的，所以每次取用都落到旁边硬编码的浅色回退值上。浅色模式下回退值看起来合理，深色模式下就会维持浅色。

**修法**：按语义换成主题真实定义的别名 —— 背景用 `--dsw-alias-state-business-tertiary`，淡色面上的文字用 `--dsw-alias-state-business-primary`，品牌填充用 `--dsw-alias-brand-primary`，填充上的文字用 `--dsw-alias-label-primary-foreground`，发丝线用 `--dsw-alias-border-l2`。注意 `--dsw-alias-brand-primary` 与 `--dsw-alias-brand-text` 解析到同一颜色，同时用作背景与文字会让文字不可见。

**为什么测试没抓到**：既有测试全部断言结构与交互，没有任何一条检查 token 名字是否真实存在。假 DOM 里也没有样式表，`getComputedStyle` 拿不到值，这条路径只有真实浏览器能暴露。新增 `test/tokens.test.mjs` 与 `scripts/extract-host-tokens.mjs` 把它变成可回归的：从 asar 里解出主题定义的 403 个 token 写进 `test/host-tokens.txt`，测试断言 bundle 引用的每一个都在这份清单里，且四个已废弃的名字不得复现。变异（改回 `--dsw-alias-border-secondary`）会同时失败两条断言。

## DEF-26 · 网格项不肯变窄，行内容溢出被裁

**现象**：真实 Chrome 里技能行右侧的徽标看不见。溢出审计报告 `.dsse-card` / `.dsse-card-body` / `.dsse-list` / `.dsse-name` 四层 `scrollWidth > clientWidth`。

**根因**：`.dsse-list{display:grid;gap:3px}`。网格项的 `min-width` 默认是 `auto`，它不会窄于内容，所以 `.dsse-row` 撑破容器；`.dsse-row-main{flex:1;min-width:0}` 只约束了内部 flex 子项，没有约束网格项本身。

**修法**：`.dsse-row` 规则加 `min-width:0`。修复后 `.dsse-list` 与卡片层级溢出归零，只剩 `.dsse-name` 的两条 —— 那是 `text-overflow:ellipsis` 的正常工作，不是缺陷。

**为什么测试没抓到**：假渲染器没有布局引擎，`scrollWidth`/`clientWidth` 全为 0，溢出审计只可能在真实浏览器成立。`test/client.test.mjs` 开头就声明「几何是否对齐是浏览器事实」。

---

## DEF-27 「上一轮」卡片被自身的统计条撑高，总结正文没有高度上限

**现象**（用户 m22337 报告）：卡片占用的垂直空间太大，标题栏里显示的「轮次/调用/失败」与卡片正文下方的统计块重复；一段长总结会把整张卡撑满，把下面两张卡挤出视野。

**根因**：两张分开的表。标题栏只显示轮次文字，三个计数在正文下方另占一整块（`.dsse-facts` 三列网格）；总结正文没有任何高度约束，长度完全由模型输出决定。

**修法**：
1. 三个计数与提炼按钮移进标题栏（`Card` 新增可选 `props.head`，自定义头与原来的 `meta` 回退互斥），删掉 `.dsse-facts` 整块与 `dsse-btn-full`。
2. `.dsse-text` 加 `max-height:5.2em`，底部加 34px 渐变遮罩。

**为什么测试没抓到**：假渲染器没有布局引擎，`scrollHeight`/`clientHeight` 恒相等，「卡片有多高」这件事在旧套件里根本不可观测；旧断言只检查「有没有这个节点」。

## DEF-28 渐隐遮罩恒定渲染，把没被截断的短摘要也压暗

**现象**：`data-clipped` 被硬编码为 `'true'`，于是 34px 的渐变层对每一条摘要都生效。一两行的短摘要比渐变层本身还矮，下半截被白色渐变盖住，看起来像文字淡出了但后面什么都没有。

**根因**：把「是否溢出」当成常量而不是测量结果。CSS 里 `max-height:5.2em` 与 `::after` 共用同一个选择器，两者被绑在一起。

**修法**：新增 `Clip` 组件，用 `useLayoutEffect` 比较 `scrollHeight` 与 `clientHeight` 再设置 `data-clipped`。用 layout effect 而非 passive effect，是因为后者在浏览器已经绘制之后才运行，每次首帧都会闪一下「已截断但还没有渐隐」。

**为什么测试没抓到**：断言写的是 `data-clipped === 'true'`，而它就是那个恒定值 —— 一条把缺陷固化成期望的断言。修法是把假节点的 `scrollHeight` 与 `clientHeight` 分开（`overflowHeight` 参数），并写两条相反的用例：溢出必须 `true`、不溢出必须 `false`。

## DEF-29 卡片全空时设置弹窗被卸载，随后自行重新弹出

**现象**：打开设置后切换会话（或后台刷新期间卡片变空），弹窗消失；等新会话的数据到达、卡片重新画出来，弹窗又自己冒出来 —— 用户没有再做任何操作。

**根因**：`if (hasAnyCard === false && error === '') return null` 把整个返回树吞掉，而设置弹窗 `settings` 是同一棵树里的兄弟节点（`settings,` 在 cards 数组末尾）。弹窗由 `settingsOpen` 状态驱动，DOM 被卸载但状态仍是 `true`，下一次渲染就复活。

**修法**：空态返回 `settings` 而不是 `null`。顶栏与卡片不渲染，弹窗保留。同时 `hasAnyCard` 纳入 `pendingCandidates > 0`：那个按钮是面板里通往候选审核的唯一入口，队列里有活时把它藏掉等于让工作不可达。

**为什么测试没抓到**：空态断言只检查「没有 rail」，设置弹窗的存活从未被断言；而「能不能打开弹窗」与「弹窗会不会被别的东西带走」是两件事。

## DEF-30 `agent/disposed` 的载荷形状在拆分时被写错

**现象**：会话关闭后，面板上的技能列表与 transcript 留在屏幕上不消失。测试 `disposal releases the transcript`、`disposal forgets which skills this session loaded` 变红。

**根因**：宿主发的载荷是 `{ agent }`，检测器侧一直是 `safe('disposal', ({ agent }) => ...)`。新写的 `packages/ui-evolve/lib/index.js` 收的是裸 `agent`，于是 `agent?.session` 恒为 `undefined`，`agentId` 取不出来，函数第一行 `return` 掉。

**修法**：`const agent = payload?.agent ?? payload`，两种形状都接受。

**为什么测试没抓到**：不是没抓到——它抓到了，而且只有那两条断言变红。但这个缺陷值得记，因为它说明**拆分时复制的是函数的形状，不是函数的契约**。`({ agent }) => ...` 那个解构本身就是文档，我在新文件里省略它，等于省略了「宿主发什么」这条信息，而语法上完全合法。

## DEF-31 客户端 bundle 的注册 id 必须是包名全称

**现象**：拆包后如果只改 `package.json` 的 name 而不改 bundle 里的 `id`，宿主在模块加载期抛错。

**根因**：宿主 `dsh-client-modules` 的 `:709` 是 `throw new Error(\`client-modules: duplicate factory registration for "${registrationName}" ...\`)`，`:875` 是 `if (!this.factories.has(id)) throw new Error(\`client-modules: bundle ${url} loaded without registering "${id}" ...\`)`。注册 id 必须等于包名。

**修法**：`packages/ui-evolve/lib/client.js` 五处同步 —— `id: "@revxz/dsh-ui-evolve"`、`NS`、`PANEL_ID`、`TOGGLE_ID`，以及文件头注释。

**为什么测试没抓到**：`test/client.test.mjs` 里原本断言 `booted.captured.id === 'dsh-skill-evolve'`，拆包后这条断言会把旧名字固化下来——它会一直绿，直到有人在真实宿主里装上新包。**断言一个名字不会发现名字错了。** 已改为断言新全名；真正把契约钉住的是 `spec.registrant === NS` 那一类交叉断言。

## DEF-32 头部空出一条：已删按钮的 `min-height` 留在三张卡上

**现象**：用户报「上一轮标题的下方没有任何显示，却空出了一条」，并指出另外两张卡也有同样情况。

**根因**：`packages/ui-evolve/lib/client.js` 的 `.dsse-card-head` 上留着 `min-height:42px`。那是为「从本轮提炼」按钮定的高度，按钮删掉之后没人回头改这个数字。三张卡共用 `Card` 组件，一处遗留变成三处。

**修法**：删掉 `min-height`，`padding` 从 `9px 11px` 收到 `7px 11px`，头部高度回到由内容决定。

**为什么测试没抓到**：假渲染器没有布局引擎。`test/client.test.mjs` 开头就声明「几何是否对齐是浏览器事实」，套件能断言的是属性与结构，而这条缺陷整个存在于「高度」这一个浏览器事实里。修完之后加的是**源码断言**（`min-height:` 不得出现在 `.dsse-card-head` 里）——这是本仓库对纯样式缺陷的既有做法，它能抓到「有人又写回去」，抓不到「写了个看起来对但实际不对的数字」。

## DEF-33 hover 仍然展开卡片，与「点击才展开」的契约不符

**现象**：需求改成「hover 只提示、点击才展开」之后，把指针移到卡片上，卡片仍然展开。

**根因**：`expanded` 的定义还是 D-22 那版，写成 `turnExpandable === true && (turnHovered === true || turnPinned === true)`。改 hover 的**表现**（加提示条）很容易，改它**代表什么**要回到这个布尔上，而它藏在 `Cards` 的派生区，不在改样式时会看到的地方。

**修法**：`const expanded = turnExpandable === true && turnPinned === true`，另加 `turnHinted` 只负责提示。

**为什么测试没抓到**：这不是「测试没抓到」，是「测试也在按旧契约找证据」——既有断言检查 `data-expanded` 的取值，而旧实现下 hover 确实让它变 true，断言因此一直绿。真正抓到它的是**改完源码后重新跑一遍**：4 条断言（`hovering a clipped summary does not open it`、`and the offer says what the click will do`、`a hovered card still reports itself closed`、`and it does not open it`）立刻变红。教训是：**需求的语义变了，断言里对同一个属性的期望也要跟着变，而它们在同一个文件里**。已把 `expanded` 这行收进 `scripts/mutate-checklist-panel.mjs`。

## DEF-34 `EventSource` 遇到不可用响应会永久放弃重连，而轮询已被清掉

**现象**：第一版实时更新在 `open` 事件里 `clearInterval` 掉 8 秒轮询。插件重载期间 `/live` 短暂返回 404，流就此死掉，`error` 回调是空的，面板停在旧数字上直到人切会话。

**根因**：两件事叠在一起。一是把「流是正常路径」当成了「流覆盖了轮询覆盖的全部」；二是 `EventSource` 的重连语义有个不显眼的例外——网络中断会重连，**响应本身不可用（404、`content-type` 不是 `text/event-stream`）不会**，它直接 `CLOSED` 并放弃。

**修法**：`open` 时降频到 60 秒而不是删除（D-73）。同时查明第二层洞：`pendingCandidates` 读的是全局候选队列，而流只在本会话事件上 publish，所以即使流健康，别的会话写入候选也不通知这里——轮询不是备份，是唯一来源。

**为什么测试没抓到**：测试替身 `EventSourceStub` 只会 `fire('open')`、`fire('panel')`，从来没有「打开后永久失败」这个动作，也没有「流不说话但别处变了」这个场景。**替身能表达的失败模式只有作者想到的那些**，而这次没想到的是「流自己不报错地不工作」。修完之后 `client.test.mjs` 断言的是定时器被**换掉**而不是被**清掉**（`slow.length === 1 && slow[0].cleared === false`），并有一条「慢轮询仍然会去问面板」。

## DEF-35 HEAD `/live` 落到 404，探活把存在的路由报成不存在

**现象**：`curl -I /api/ui-evolve/live?agent=x` 返回 404，而 `GET` 同一路径是 200 的流。

**根因**：路由分支写的是 `req.method === 'GET'`（这个限定本身是对的，见下），但方法白名单放行 HEAD，于是 HEAD 穿过 `/live` 分支、落到文件末尾的 `error.route.unknown`。同文件里 `/panel`、`/models`、`/config`、`/candidates` 都对 HEAD 回 200 空体。

**为什么 `=== 'GET'` 这个限定是对的**：上一版写的是 `!== 'POST'`，HEAD 因此会进 `streamLive`——写 SSE 头、注册订阅、挂 25 秒心跳、永不 `end()`，每个探活泄漏一个订阅直到 socket 超时。这是第一轮审查报的 P2，两件事必须分开处理：**不许进流，但也不许报不存在。**

**修法**：GET 走 `streamLive`；HEAD 单独一支，`json(res, 200, { ok: true, data: { stream: true } }, true)`（第四参 `headOnly` 表示只写头不写体）。

**为什么测试没抓到**：`/live` 是这一轮新增的路由，而 HEAD 的既有断言只写在 `/panel` 上（`test/api.test.mjs` 的 `a head request answers 200`）。**新路由不会自动继承别的路由的测试覆盖**——那条 HEAD 用例测的是 `/panel` 这个路径，不是「HEAD 一律 200」这条规则。已补 4 条断言（200 / 不流 / 不订阅 / 立即结束），变异脚本也加了两条（删掉 HEAD 分支、把 GET 放回 `!== 'POST'`）。

## DEF-36 「开着的卡片能关掉」这条守卫静默空转了一轮

**现象**：`test/client.test.mjs` 里有一段专门守「渲染成展开态的卡片一定有办法关掉」的循环，套件报全绿，但那几条 `check` 一次都没执行。

**根因**：循环前提是 `clip?.props?.['data-expanded'] === 'true'`，不满足就 `continue`。它构造的两棵树分别在「换了一轮」和「指针移上去」之后取——而在 hover 不再展开卡片之后，这两棵树都是**关着**的。2026-11-06 之前的 `expandPairs` 是真在跑的，因为当时 hover 会展开。

**为什么测试没抓到**：没有任何测试能抓到它。`continue` 让整个循环变成空转，而空转与通过在这套 harness 里长得一模一样：都只是一行 tally。这也是为什么变异脚本帮不上忙——空转的断言对任何变异都不敏感，它只会让所有变异都「存活」。

**修法**：把前提本身变成断言，不再跳过。现在是先 `pressCard(swapped)`（并 check 处理器存在）点开，再取两棵树（点击后、指针离开后），每棵树显式断言 `data-expanded === 'true'`，然后才断言可关闭性四要素。`client.test.mjs` 从 322 条增加到 327 条，多出来的 5 条就是原来从没跑过的那几条。

**探针**：把 `client.js` 的 `onClick: interactive === true ? props.onClick : undefined` 改成 `onClick: undefined` → 恰好这两条变红（`true/0/button/undefined`），303 passed / 24 failed。已收进 `scripts/mutate-checklist-panel.mjs`（第 65 条）。

**这条的普遍教训**：**带前提的断言必须让前提失败时也失败。** `continue`、`if (...) { check(...) }`、`?.` 链后面跟着的断言，全都有这个形状。本仓库另一处同类问题是变异脚本里「测试崩溃不打印 FAIL 行」——两者都是「没有输出」被当成了「没有问题」。

## DEF-37 测试桩 `setInterval` 返回 0，轮询被清与否不可观测

**现象**：写「流打开后轮询被清掉」这条断言时，套件报 3 failed，而源码是对的。

**根因**：`test/client.test.mjs` 的 `evaluate(...)` 里，`setInterval` 桩是 `() => 0`、`clearInterval` 是 `() => {}`。桩的原始目的只是「真实 interval 会让测试进程不退出」，返回值被当成无关紧要。于是 `instance.timers.find((row) => row.ms === 8000)` 永远是 `undefined`——**不是断言写错了，是这个行为在 harness 里根本不存在**。

**修法**：桩改成与 `setTimeout` 桩同构：记下 `{ fn, ms, handle, cleared }`，返回真实 handle；`clearInterval` 桩查表把 `cleared` 置真再真正清。`clearInterval` 的实参也一并记进 `timers`，供「清的是不是同一个 handle」这类断言使用。

**为什么测试没抓到**：这是测试基础设施的缺陷，不是产品的。它自己的失败表现很有误导性——3 条新断言全红，看起来像源码有问题。识别方法：**先确认待观测的行为在替身里有没有对应的可观测面**。`jest.useFakeTimers()` 之类的库替身会保留 handle，手写桩最容易省掉的就是这个。

**同类教训**（本仓库第 7 条）：`snapshotOf: () => live` 返回同一引用，让陈旧值永不显得陈旧；`attachRefs` 只绑一次，跨轮复用同一节点时必须用可变 getter 才能观察重测。都是「替身太省事」这一类。

## DEF-38 两条 phase 变异是同一个变异，且 label 描述的效果与代码相反

**现象**：给「只在真会话显示」补变异时加了三条，跑起来 68 条全杀，看起来覆盖很足。

**根因**：`client.js` 里 `const phase = place.phase ?? ""` 让 `phase` **永远是字符串**，
所以 `if (phase === undefined) return null` 等价于**删掉整个门控**——它与第三条
`if (phase === "nowhere") return null` 产生的失败断言集合逐字相同（都是既有的三条
launcher 断言），覆盖增量为零。更糟的是它的 label 写的是
「the cards are hidden on the launcher too」，描述的效果**恰好相反**：删掉门控之后
卡片在任何页面都不再隐藏。

**修法**：换成 `if (phase === "hero" || phase === "settling") return null`——它精确地
只杀死新增的 `a conversation being opened draws its cards`，正好守住 D-75 那条规则。

**为什么测试没抓到**：变异脚本只回答「这条变异有没有被杀死」，不回答「它杀的是哪条
断言」。两条变异被同一组断言杀死时，脚本报的是 `2 killed`，与「两条各自守着一件事」
完全无法区分。

**普遍教训**：**变异必须带一个「预期该由哪条断言杀死」的说明**，否则「全杀」只证明
测试有反应，不证明它们分别守住了不同的东西。这也是本仓库出现过的「全绿但没测到」系列之一：
DEF-36 是断言空转、DEF-37 是行为不可观察、这条是**变异重叠**，DEF-41 是**数字无出处**。

## DEF-39 README 的流描述自相矛盾

**现象**：撤回 SSE 后，`packages/ui-evolve/README.md:360` 仍写着
「it re-reads `/panel` when the stream says the conversation changed」，而同文件
新写的「How it learns: a timer」一节明说「There is no subscription and no server push」。

**根因**：撤回时只重写了**新增的那节**（`When the panel is shown, and how it learns`），
没有回扫全文里对同一条机制的**其他措辞**。这句话是 `c22ec9a` 引入的，撤回删掉了流
却没删它。

**修法**：改成「it re-reads `/panel` when the panel opens and on a timer thereafter」。

**普遍教训**：**描述同一机制的文字往往不止一处。** 删功能时，先 grep 该功能的**名词**
（`stream`、`EventSource`、`/live`），再 grep 它留下的**动词短语**（「按流重读」、
「被通知后刷新」）——后者不含任何可搜的技术名词，最容易漏。

## DEF-40 README 引用了不存在的决策编号

**现象**：README 写着「An event stream was tried here and removed (`D-74`)」，
而 `docs/handover/02-decisions.md` 最新只到 D-73，全仓库 `grep D-74` 只有这一处命中。

**根因**：先写引用、打算稍后补记录。中间没有任何东西会因为「引用了不存在的编号」而变红——
测试不读文档，变异脚本不读文档，代码审查只有人工读才发现。

**修法**：补上 D-74（撤回实时流及其理由）与 D-75（`settling` 照常显示），并把 D-70、D-73
标为「被 D-74 取代」。

**普遍教训**：**交叉引用是文档里唯一能被机器检查的东西**，但它没有被检查。
若要根治，应当在测试里加一条「`docs/` 与 README 里出现的 `D-xx` / `DEF-xx` / `R-xx`
编号必须在对应索引表里存在」——这条目前不存在，属于已知缺口。

## DEF-41 状态文档里四个数字错了三个口径

**现象**：撤回实时流那一节里写了四个数字：净减少 1506 行、100 个 git 追踪文件、
`record()` 五处 `return`、删掉三条流断言。第二轮审查逐个复核，**四个里错了三个口径**。

| 原写 | 实测 | 错在哪 |
|---|---|---|
| 1506 行（66/1572） | 11 files, **71/1576**，净减 1505 | 统计范围漏了 README 与变异脚本，但紧邻的表格覆盖 11 个文件 |
| 100 个 git 追踪文件 | `git -c core.quotepath=false ls-files` = **112**，磁盘上 **109** | 两个错叠在一起：标签把「磁盘上存在」写成了「git 追踪」（112 那个数），而 100 本身也不是磁盘数——`core.quotepath` 让 9 个中文路径落空，详见 DEF-42 |
| 五处 `return` | **8** 处（5 真 3 假） | 只数了 `return true`，没数 `return false` |
| 三条流断言 | **11** 条 `check` | 只数了一个 `{}` 块，没数整块 |

**为什么「100」要单独记一条**：它不是算错了四则运算，而是**命令输出的格式**骗过了眼睛
（`git ls-files` 默认给中文路径加引号转义），这一类另见 **DEF-42**。

**根因**：**数字是手工数出来的，产生它的命令没有写下来。** 四个数里有三个不是「算错」，
而是「不知道自己算的是哪一件事」——净减少按哪几棵子树算、`ls-files` 与磁盘文件数不是
一回事、`return` 有两种、`check` 分散在三个块里。因为没写口径，读者（和下一轮审查）
除了重新数一遍，没有任何办法判断它对不对。

**修法**：四个数字全部按实测改正，并在每一个后面写明它是哪条命令的输出。

**普遍教训**：**文档里每写一个数字，下一行就该是产生它的命令。** 这不是为了好看——
一条 `git diff --shortstat` 或 `grep -c` 能让下一个读者在三秒内复核完毕，而「凭记忆数的
1506」只能靠重新数一遍才能证伪。同一个道理适用于所有「我是照着记忆/印象写的」内容。

**这是本仓库「全绿但没测到」的第四种形态**：DEF-36 断言空转、DEF-37 行为不可观察、
DEF-38 变异重叠、这条是**数字无出处**。前三种都能让测试变红，这一种不能——它只在
有人愿意重新数一遍时才暴露。

## DEF-42 `git ls-files` 默认给中文路径加引号转义，`[ -f ]` 全落空

**现象**：统计「git 追踪且磁盘上存在」的文件数，写法是
`git ls-files | while IFS= read -r f; do [ -f "$f" ] && echo x; done | wc -l`，
结果是 **100**。而 `git ls-files | wc -l` 是 112，`git diff --name-status --diff-filter=D`
显示本轮删了 3 个，112 − 3 = **109**。两个算法差 9。

**根因**：`git ls-files` 默认 `core.quotepath=true`，会把非 ASCII 路径**加引号并转义成八进制**：

```
"docs/00-\346\226\207\346\241\243\347\264\242\345\274\225.md"
```

这 9 个全是 `docs/` 下的中文文件名（`00-文档索引.md` 之类）。`[ -f "$f" ]` 拿到的是
带引号的转义串，文件当然不存在，于是它们全被算成「已删除」。**转义后的字符串看起来
仍像一个路径**，这是它能骗过眼睛的原因。

**修法**：`git -c core.quotepath=false ls-files`，或在脚本里用 `-z` 配合 `read -d ''`。

**为什么它危险**：这条命令的输出**会被当成路径列表喂给后续操作**。这次的后果只是数错，
但如果同一写法出现在清理脚本里（`git ls-files | xargs rm`），它会对着 9 个不存在的
转义串操作，而人看着输出会以为「都处理过了」。**任何把 `git ls-files` 输出当路径用的地方，
都必须先关掉 quotepath。**

**同类教训**：命令的输出**格式**（引号、转义、颜色、分页）与它的**内容**是两件事。
`git ls-files`、`grep --color=always`、`ls` 的列格式都是这一类。
用输出去驱动下一步之前，先问它有没有「人类可读模式」默认开着。

## DEF-43 圆标带 `title`，但 `pointer-events:none` 让它永远不可能弹出

**现象**：`.dsse-expand` 改成圆标时，顺手给它加了 `title: props.expandHint`，
同时保留了让它「不是控件」的 `pointer-events:none`。

**为什么错**：`pointer-events:none` 把元素从命中测试里摘出去，浏览器不会为它
生成原生 tooltip。这行代码读起来是「悬停有提示」，实际上一次都不会触发。
它没有让任何断言变红——因为当时也没有断言 `title` 存在。

**发现方式**：审查逐条核对时问「这个属性在什么情况下会被真的用到」。

**修法**：删掉 `title`，注释改为解释为什么没有它；`aria-label` 与 `role="img"`
继续承担可访问名称（读屏不受影响）。

**教训**：**惰性属性比缺失属性更贵**——缺失会被测试或肉眼发现，惰性不会。
加一个属性前先问「它在什么条件下会被真正消费」，尤其是与
`pointer-events`、`display:none`、`visibility:hidden`、`aria-hidden` 这类
「让它不存在」的声明同处一个元素时。

## DEF-44 行为推翻了 D-69 的两条结论，README 改了而决策记录没补

**现象**：本轮把提示从「摘要下方一行字」改成「卡片内底边圆标」，并让展开态
显示收起文案。README 描述更新了，`docs/handover/02-decisions.md` 里 D-69 的
「代价一」（hover 增高 26px）与「代价二」（`'点击收起'` 不可达）仍原样保留，
索引表也仍把 D-69 标为完全生效。

**为什么严重**：D-69 的代价二是一句**明确的禁令**
（「简化成只有 `'点击展开全文'` 一种」）。下一个人照着它把三元改回去，正好是
变异 `an open card offers to open itself again` 要防的那个回归——而变异只能
抓住行为，抓不住「文档说这是对的」。

**修法**：按该文件开头的规矩，补 **D-76**（圆标不占布局，取代代价一）与
**D-77**（展开后仍显示收起入口，取代代价二），索引表 D-69 一行注明代价被取代。

**教训**：一个分支被判为「不可达」然后删掉时，要区分它是**逻辑上**不可达
（前提互斥，可以删）还是**当前设计**不想到达（删掉就是把设计决定藏进代码）。
后者必须留一条决策，否则没有地方能说明「为什么当初不想要它」。

## DEF-45 · 只含产出路径的会话状态文件被当作孤儿删除

**现象。** 一个只记录产出文件（`paths`）而不记录技能/MCP/总结的会话状态文件，在
某个进程释放会话时被删掉。

**复现。** 进程 A 轮询一个磁盘上还没有状态文件的会话 id → `readInto` 把内存记录标成
`empty` → 另一个写入方写下 `{"paths":{"src/a.js":7},"sequence":7}` → A 释放该会话时
`flush` 看到 `document()` 是 `undefined`，走 `dropIfOrphan` → 文件被删。

**根因。** `dropIfOrphan` 用一个 `keepsDocument({ skills, tools, previous, turns })` 判断
「这份文件还有没有内容」。D-79 给记录加了第五种事实 `paths`，`keepsDocument` 自己也加了
`paths` 判据，但**调用点没有把 `paths` 传进去**——于是函数拿到的是 `undefined`，判据
成立不了，文件被判成孤儿。

**修法。** 调用点补 `paths: stored.paths`。

**这里是「判据函数」与「它的调用点」的经典错位**：判据本身是对的、被测的、有断言的，
错的是有人问它的时候少说了一半事实。凡是「把一组事实交给一个函数判断」的地方，加事实就是
改所有调用点，而不是只改函数。

**断言的坑（写了两轮才算对）。** 第一版照抄相邻用例的结构，但 `rememberPaths` 之后会
`schedule()` 写盘，`stateB.flush` 之前必须先 `rememberPaths(['src/a.js'])` 再造那个状态，
否则测的是「文件还在不在」而不是「该不该删」。

## DEF-46 · 表外语言标签被静默丢弃

**现象。** 需求是「总结跟随宿主语言」。界面的 `lang` 是 `nl` 时，提示词里没有任何语言
指令——比改动之前还少，因为改动把 `INSTRUCTION` 里原有的那句
`in the language the user wrote in` 删掉了。

**根因。** `LANGUAGE_NAMES` 只收 11 种语言，`languageName` 对表外标签返回 `undefined`，
`languageLine` 因此返回 `''`；而旧那句已经被移除。代码注释当时写的是「unknown degrades
to the old best effort」——与实现不符，注释描述的是**意图**而不是行为。

**修法。** 三档：表内 → 具名句；表外但形态合法 → 通用兜底
`Write it in the language the user wrote in.`；形态非法/缺失 → 沉默。

**顺带发现的真缺陷。** 通用兜底一旦生效，`const wanted = clause.length > 0 ? '\n\n' + clause : ''`
与模板里紧跟的换行相叠会造出**三个连续换行**。这个缺陷以前看不见，因为到达那一行的
`clause` 永远是空串。

**教训。** 把一句模糊提示换成一条明确指令时，明确指令覆盖不到的分支就丢了原来那句。要按
「新指令的覆盖面 vs 旧提示的覆盖面」比较，而不是按「新代码比旧代码更具体」判断。

## DEF-47 · 中断的回合读错了轮次

**现象。** 一个被中断（`reason.kind !== 'completed'`）的回合里改过的文件没有出现在产出卡
上；同时更早那一轮改过的文件被逐条顶到列表最前，像是刚刚被编辑过。

**根因。** `Transcript.endTurn()` 在非 completed 时只清空当前轮（`calls`/`paths`/
`commands`/`said`/`turn`），**不改写 `previous`**。而 `index.js` 在
`transcripts.record(agentId, event)` **之后**读 `view.previous.paths`——中断轮此时读到的
是上一次**成功**回合的路径。于是：没碰过的文件拿到新 tick，真正改过的（`paths` 已清空）
永久丢失。

**修法。** 在 `record()` 之前读 `transcripts.view(agentId)?.current?.paths` 存进局部变量，
`record()` 之后交给 `rememberPaths`。

**为什么不能「只在 completed 时记」。** 一次中断的长任务里改的十几个文件会全部消失。
中断的回合仍然是发生过的工作：用户看不见它被总结（中断轮不生成总结），但文件确实改了。

**探针。** 把 `?.current?.paths` 改回 `?.previous?.paths` → `67 passed, 4 failed`，其中
`an interrupted turn does not empty the card — [...\old.js]` 精确复现了审查描述的输出。

**教训。** 在有「折叠」语义的存储上，「读之前」与「读之后」不是风格问题，是数据问题。

## DEF-48 · 表外语言与「无语言」共用缓存键

**现象。** 同一轮次的总结，先请求 `lang=nl` 再请求不带 `lang`，第二次直接命中第一次的
缓存——而两次的提示词不同（前者带通用兜底句）。

**根因。** `const spoken = languageName(language)` 用于做键，而 `run()` 用的是
`languageLine(language)`。表外标签的 `languageName` 是 `undefined`，键因此与「不带 `lang`」
完全相同。

**修法。** 用渲染后**实际生效的句子**做键：`const spoken = languageLine(language)`，再
`summaryKey(turn, body, spoken.length > 0 ? spoken : undefined)`。
`summaryKey` 第三参的 JSDoc 从「语言名」改成「任何能区分两次提示词的东西」。

**探针的坑。** 第一版探针把 `const spoken = languageLine(language)` 整体换成
`languageName(language)`，导致 `.length` 在 `undefined` 上抛错、测试崩溃、一行 tally 都
不打印——**探针必须改行为不改结构**，否则什么也没证明。

**教训。** 缓存键要对着「真正决定输出的那个值」做，不是对着它的输入。

## DEF-49 · 路径上限被合并分支绕过

**现象。** 会话状态里的路径列表在重启之间无界增长：实测四次「事件先到、轮询后到」的
重启得到 200 → 400 → 600 → 800 条，而 `MAX_PATHS` 是 200。每次面板读取对每条记录做一次
`fs.stat`，八秒一次。

**根因。** `trimPaths` 唯一的调用点是 `rememberPaths`。`readState` 读盘不裁剪；
`load` 的合并分支把内存与文件两边相加后直接返回，越过上限无人收敛；关机时
`document()` 写的就是合并后的结果，于是下一次重启从一个更大的文件开始。

**修法。** 三处裁剪：`rememberPaths`（原有）、`load` 合并分支（在 tick 平移之后、`sequence`
赋值之前）、`readState`（按 tick 降序取前 200）。

**为什么合并分支里裁剪的位置有讲究。** 必须在 `shift` 之后：此时文件条目的 tick 全部
≤ shift，内存条目全部 ≥ shift+1，升序删除天然先删文件里最旧的，不会误删内存中较新的。
审查用 300 轮随机 fuzz 校验了四条不变量（容量、`sequence` ≥ 所有存活 tick、加载后内存
条目数 = min(加载前, 200)、文件 tick ≤ 内存 tick），无违例。

**为什么 `readState` 里裁剪不改 `sequence`。** `sequence` 单调递增且始终 ≥ 所有已发放的
tick，所以被裁条目的 tick 不可能大于 `sequence`，`shift` 计算不失真。

**教训。** 加一个上限时，要问的不是「写入的地方裁了没有」，而是「有没有第二条能产生超限
数据的路径」。这里的第二条是合并，第三条是读取旧文件。

## DEF-50 · 两处「检查代码自己空转」

**现象一。** `test/mutations.test.mjs` 里，逐条比对锚点的循环被包在
`if (owners.length === anchors.length) { … }` 里。数量不等时 `missing`/`ambiguous` 恒为 0，
两条 `check` 恒绿——而这正好是它们存在的场合（有人加了变异却忘了加锚点）。

**现象二。** `test/client.test.mjs` 里，读「改语言后下一次轮询带新语言」的断言被包在
`if (poll !== undefined && typeof poll.fn === 'function') { … }` 里。fixture 一变，它就
变成零条断言，套件仍然全绿。

**修法。** 现象一：数量不等本身记一次失败，循环无条件执行。现象二：断言移到 `if` 之外，
轮询句柄用 `poll?.fn?.()` 调用——**不能用裸 `poll.fn()`**，那会把「fixture 变了」变成
测试崩溃，而变异脚本把无 tally 记成 CRASHED/SURVIVED，等于把覆盖缺口伪装成通过。
缺句柄时断言本身失败，这才是想要的。

**教训。** 检查代码也需要被检查。判据是：**把被测对象改坏，这条 `check` 会不会变红？**
如果它可能被跳过、被 `continue`、被包在恒真条件里，答案就是不会。

## DEF-51 · 截断提示跟着被截断：头部说 10 个，列表只列 5 行，出口在滚动区外

**现象。** 产出卡片头部写「10 个文件」，卡片里只列出 5 行，第 5 行下面本该有一条
「全部 10 个」按钮把列表展开，但卡片已经伸到侧栏可视区之外——不滚动就看不到，
于是用户看到的是一张「说 10 个却只给 5 个、也没有任何解释」的卡。

**两个数字本身没错。** `client.js:1701-1702` 的 `ordered` 是全部（按 mtime 降序），
`shown = filesOpen ? ordered : ordered.slice(0, 5)`；`:1997` 的 `meta` 用的是
`ordered.length`（总数），`:2018` 的按钮判据是 `ordered.length > shown.length || filesOpen`。
截断与提示都在，只是提示的位置跟着列表一起被截断。

**为什么当初截断。** 不让一张卡把整块侧栏顶下去，让另外两张卡还在视野里。这个目标没错，
错的是把「出口」放在了需要滚动才能到达的地方——**截断的代价（看不到全部）和出口的位置
（要滚动才能看到全部）叠加起来，就把“最多 5 行”变成了“只有 5 行”**。

**待办（未修）。** 用户 2026-11-07 决定与后续产出卡新需求一并处理。三个候选方案：
1. 头部说清楚：`meta` 改成 `10 个文件 · 显示 5`。改动最小，但出口仍要自己找。
2. 把出口钉住：列表区独立滚动（`max-height` + `overflow-y:auto`），按钮固定在卡片底部。
   卡片高度稳定、出口永远可见，代价是卡内出现第二个滚动条。
3. 不截断：全部列出，让侧栏自己滚。

**教训。** 任何「只显示前 N 条」的列表，其「显示全部」的入口必须和列表**同时**可见；
把入口放在列表末尾，等于让截断提示与列表一起被截断。判断方法是问：**用户只看第一屏时，
他知不知道还有更多？**

