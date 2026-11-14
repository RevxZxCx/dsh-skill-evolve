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
| DEF-51 | 2026-11-07 | 产出卡头部说「10 个文件」而列表只列 5 行，「全部 10 个」按钮在滚动区外看不见 | 把「显示全部」的入口放在列表末尾，于是截断提示与列表一起被截断。**已修 2026-11-10**（D-92/D-93），见文末补记 |
| DEF-52 | 2026-11-08 | 「实时速度」监听宿主从不派发的 `assistant/chunk`，真实通道是 `agent/assistant-stream` | 测试自己派发的事件证明不了宿主会派发它 |
| DEF-53 | 2026-11-08 | `outputTokens` 含推理 token 与工具参数，学到的比例被顶到上限 | 分子分母的构成必须一句话说清 |
| DEF-54 | 2026-11-08 | 中断的 attempt 不清累加量，下一次 settle 的分母翻倍 | 累加量与窗口是两个量，不能当做一个 |
| DEF-55 | 2026-11-08 | `settle` 用 `entryOf` 为从未流式输出的会话建条目，断言被 `||` 放过 | `||` 在断言里几乎总是可疑的 |
| DEF-56 | 2026-11-08 | 锚点数量下限表写成远低于实况的数字，检查强度被静默削弱 | 下限取「够用就行」，检查强度也是「够用就行」 |
| DEF-57 | 2026-11-09 | 速度徽章只在流式输出期间存在，用户看不到 | 只在事件发生时才存在的读数，等于要求用户恰好在那一秒看向那个角落 |
| DEF-58 | 2026-11-09 | 删 linger 代码时连带删掉 `setTick` 的 `useState`，4 秒定时器仍在调它 | 删一段逻辑时，它调用的状态声明也是这段逻辑的一部分 |
| DEF-59 | 2026-11-09 | 变异 `why` 描述的是另一条变异的行为 | `why` 是后续读者判断这条变异为何存在的唯一线索 |
| DEF-60 | 2026-11-09 | README 把「不画徽章」的宿主范围说窄了（漏掉 `ok:false`） | 判据写成「没有那条路由」时，实际判据往往是「一次都没成功答过」 |
| DEF-61 | 2026-11-09 | `averageOf` 的 `ms <= 0` 守卫不可达，与同一次改动删掉被遮蔽守卫的原则冲突 | 「不可达」要证明，不能凭直觉留一行当保险 |
| DEF-62 | 2026-11-09 | 「流式进行中但尚无 settle」这一状态没有任何断言，空样本守卫删掉也不报警 | 冷启动用例走的是另一条分支，覆盖不到「有窗口、无平均」 |
| DEF-63 | 2026-11-09 | 长轮询拿「请求到达时的读数」当比较基准，两次轮询之间发生的变化看不见 | 基准必须是调用方报上来的那个数，不是服务端此刻的数 |
| DEF-64 | 2026-11-09 | 长轮询到期后不是立刻重发，而是在响应回来之后再空等 27 秒，新回合落在窗口里就没人在听 | `schedule()` 在 `await` 之后运行，那里的数字不是余量而是死时间 |
| DEF-65 | 2026-11-09 | 实时读数只在非 active 分支装重绘定时器，生成中途的长挂起把最后一帧「现在」样式留在屏幕上 | 一个读数何时过期，与它是不是 active 无关 |
| DEF-66 | 2026-11-10 | 产出卡的每一行在所有宿主上都退化成纯文本：`openable` 在自己的 props 里找 opener，而 `Card` 从不接收它 | 判据读的是一个「这个名字看起来该有」的对象，而不是真正持有通道的那个闭包 |
| DEF-67 | 2026-11-10 | 「按编辑顺序、不按 mtime」的断言什么也没证明：fixture 的 `mtimeMs` 与数组顺序同向 | 测试数据把两个假说排成了同一个答案，证伪其中任何一个都得到相同输出 |
| DEF-69 | 2026-11-10 | 两个圆标共用同一条 `.dsse-expand` 规则，但 `div` 是 content-box、`button` 是 border-box，渲染外径差 2px（28 vs 26） | 共用一条规则不等于共用默认值；只比对规则文本的断言对两种盒模型都点头 |
| DEF-68 | 2026-11-10 | `scripts/mutate-checklist-panel.mjs` 从未被锚点下限表覆盖，坏了 9 个锚点也没人知道 | 它写路径字面量而表内循环靠常量解析目标，被跳过时退出码仍是 0 |
| DEF-70 | 2026-11-10 | `isNoisePath` 判断绝对路径的**全部祖先段**：工作区本身位于 `build/`、`dist/`、`target/` 等目录下时（CI 的 `/build/<repo>`、`D:\build\mine`、把输出目录当 workspace 打开），整卡文件都被判成生成文件，卡片一行不显示、头部写「0 个文件 · N 个生成」 | 判据回答的是「工作区里这个文件是不是产物」，代码却拿整条绝对路径去问，把工作区自己的名字也算进了证据 |
| DEF-71 | 2026-11-10 | 剥离工作区前缀时区分大小写：`cwd` 来自会话头、路径来自工具参数原文，两边都不规范化，Windows/macOS 上同一目录常有两种写法 → 剥离静默失败、退回全段判断，DEF-70 的症状重现 | 一个「尽力而为的规范化」如果只做了一半，失败是静默的，效果与完全没做相同 |
| DEF-72 | 2026-11-10 | 大小写折叠后仍用**原始串**按折叠后的长度切片：`İ`（U+0130）小写化后是一个码元变两个，切片位置多吃或少吃一个字符 → `node_modules/` 读成 `ode_modules/`（依赖被当成读者的作品）或 `xbuild` 尾巴 `build` 命中判据（源码被藏） | 折叠改变了长度，就不能拿折叠后的长度去切没折叠的串；比较与切片必须发生在同一个坐标系里 |
| DEF-73 | 2026-11-10 | 大小写断言的 `cwdFor` 写成 `process.platform === 'win32' ? dir.toUpperCase() : dir`，非 Windows 上两边大小写相同 → 断言恒真，对应变异在 Linux/macOS 上存活 | 一条只在某个平台才有内容的断言不是断言，是条件注释 |
| DEF-74 | 2026-11-12 | `this.log.warn` 不存在，catch 自己抛 `TypeError`，把要报告的失败升级成 unhandled rejection | 该路径只在 `run()` 自己抛错时到达，测 `warm` 的断言从未真的触发 rejection；`.warn` 语法合法，`node --check` 通过 |
| DEF-75 | 2026-11-12 | 粗体正则删掉中间的词（`**kwargs` + `**tested**` 被配成一对），数据丢失 | 全部断言只问「该清洗的清洗了」，没有一条问「不该清洗的是否原样保留」；docstring 还描述了一个没实现的守卫 |
| DEF-76 | 2026-11-12 | 附件块被序列化成 `[object Object]` 当作「用户说的话」写进 prompt | 夹具的 `human()` 一直只构造纯文本块，从未构造带附件的用户消息 |
| DEF-77 | 2026-11-12 | 修好的 P1 零覆盖：删掉新加的失败文案分支，2858 个断言仍全绿 | `summaryReasonText` 此前完全没有断言；修法是补 11 条断言 + 7 条突变，不是只改代码 |
| DEF-78 | 2026-11-12 | 夹具的用户消息形状错（写成助手的 `data.message.content`），生产代码反而对 | 两种形状共用 `content` 字段名，夹具错在与断言正交的维度上，于是能错多年而不失败 |
| DEF-88 | 2026-11-12 | `fileParts` 大小写敏感匹配，Windows 上整条绝对路径被当目录 | S2 |
| DEF-89 | 2026-11-12 | 行实际 32px，预留值按 28px 算，8 行只装得下 7 行 | S2 |
| DEF-90 | 2026-11-12 | 突变运行器在还原写失败时把变异留在源码里（5 处） | S2 |
| DEF-91 | 2026-11-12 | 给 `.dsse-row-icon` 加尺寸规则，把技能卡图标从 17px 悄悄压成 14px | S2 |
| DEF-79 | 2026-11-12 | 存储的轮次号压过本轮路径快照，「本轮」在重启后认错文件：`turnNow` 是本进程计数器（重启从 1 起），旧文件上的 `turn: 1` 被当成这一轮写的 | 只测了「没有快照时用存储号」，没有一条测「两者冲突时谁赢」；端到端复现要「跑完一回合再开面板」这个顺序 |
| DEF-80 | 2026-11-12 | `turn/end` 传的 `endedTurn` 完全没被固定：删掉第三参，268 个断言仍全绿 | `turn` 只写进会话文件、只在下一次开面板时才有可观察后果，而没有任何断言读那份文件里的 `turn` |
| DEF-81 | 2026-11-12 | `session-state.js` 的 `document()` 里 `for (const [file, entry] of entry.paths)` 与外层参数同名 → `ReferenceError: Cannot access 'entry' before initialization` | `node --check` 抓不到变量遮蔽；崩溃时套件不打 tally 行，运行器记为「无结果」而不是失败 |
| DEF-82 | 2026-11-12 | `client.js` 的行渲染出现**两个 `title:` 属性**，后者覆盖前者，缺失文件的「文件已被删除或移动」永远显示不出来 | 重复对象键在 JS 里合法，`node --check` 与「相邻重复行」扫描都不报错（两行不相邻）；断言只查 `data-status` 与右侧文案，没查 `title` |
| DEF-83 | 2026-11-12 | `const gone = status !== 'available'` 把任何未识别的状态都当「已消失」，于是那行没有原因、没有大小、没有删除线、不可点，却仍会 hover 高亮 | 三态断言只覆盖 `missing`/`invalid`/`available` 三个已知值，第四种值不在任何夹具里 |
| DEF-84 | 2026-11-12 | `rememberPaths` 里的 `const at = Date.now()` 绕过模块注入的时钟，同一份文档里 `paths[*].at` 与 `updated` 可能互相矛盾 | 注入时钟的既有断言只测 `updated`，新加的 `at` 没有一条断言查它的来源 |
| DEF-85 | 2026-11-12 | files-flags 测试块把夹具建在系统临时目录却沿用默认 `cwdFor: process.cwd()`，`isNoisePath` 剥不掉前缀、`Temp` 命中 `TEMP_DIRS`，该断言在 Windows 系统 temp 下恒失败 | 本地一直带 `TMPDIR=.tmp-test`（工作区内、不叫 `Temp`）跑，于是断言永远成立；一条断言的成立依赖环境变量，它就不是断言 |
| DEF-86 | 2026-11-12 | 新断言里出现 `files[1].status` / `seen[1].path` / `reloaded[0].turn`，归属能力被破坏时抛 `TypeError`、套件不打 tally，**被记为 CRASHED 而不是 KILLED** | 突变运行器靠 tally 行区分「发现」与「无法测试」，而 `check()` 里的直接下标解引用能把前者变成后者 |
| DEF-87 | 2026-11-12 | `test/client.test.mjs` 的三条 CSS 断言只读渲染出的样式表字符串，删掉选择器里的后代组合子（删除线视觉上彻底消失）仍然全绿 | 断言问的是「这段 CSS 文字存在吗」，而它想证明的是「删除线挂在名字元素上」 |
| DEF-92 | 2026-11 | `test/index.test.mjs` 把工具数钉死，第八个工具注册后全量套件红 | 断言本来就是为此存在的；但**它只钉数量不钉名字**，见 D-113 |
| DEF-93 | 2026-11 | 残留审计脚本对新文件静默跳过，打印了假的 `leftovers: 0` | 检查器的失败模式是「不报告」，而没有人给检查器本身写检查 |
| DEF-97 | 2026-11 | 两条突变锚点不唯一，脚本报 NOT APPLIED 而对应守卫其实从没被验证 | 突变套件只统计「杀了几条」，`not applied` 混在汇总行里，`of 73` 的差值没人算 |
| DEF-96 | 2026-11 | 测试直调被测函数，实现抛错时整份文件崩掉，报 CRASHED | 崩溃与失败在测试输出里都是「不绿」，但突变运行器把 CRASHED 单独计数，而没人核对那个数字 |
| DEF-95 | 2026-11 | 超限时返回 `too-many` 拒绝，而路径早已被记录 | 断言只问「超限有没有被拒」，没问「拒绝之后实际发生了什么」 |
| DEF-94 | 2026-11 | schema 的申报上限（50）大于卡片的容量（40），合法调用被静默截断 | 断言只问「schema 与代码是否一致」，两处都是 50 于是全绿；没有一条断言问**下游能不能装下** |
| DEF-98 | 2026-11-13 | `git-watch.js` 没有导出 `readChanges`，整包在 import 阶段就崩 | 已修 |
| DEF-99 | 2026-11-13 | `workspaceFor` 只认 agent 形状，事件流传 session → cwd 恒空，git 差分对每个会话静默失效 | 已修 |
| DEF-100 | 2026-11-13 | 文件系统预检被套在注入的 runner 上，10 条断言全红 | 已修 |

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


## DEF-52 · 「实时速度」监听了一个宿主从不派发的事件

**现象。** 面板头部的速度徽章在真实宿主里永远不出现；读数是空的，也没有任何错误。

**根因（在 `app.asar` 上核实）。** 第一版监听 `assistant/chunk` 并处理 `chunk.type ===
'text-delta'`。但宿主生产代码里 `append("assistant/chunk"` 出现 **0 次**，那 28 处命中全部
在 v1→v2 会话格式迁移的 codec 里，而 `RELEASED_V0_EVENT_DISPOSITIONS` 的 `retained` 明确把
它筛掉。真实通道是 `agent/assistant-stream`（payload `{ agent, frame }`）。

**为什么测试全绿。** 端到端测试自己 `host.emit('assistant/chunk', ...)`，于是它测的是
「我派发的那个事件会被处理」，不是「宿主会派发这个事件」。

**修法。** 改监听 `agent/assistant-stream`；`frame.type === 'chunk'` 且
`chunk.type === 'text-delta'` 才 push；`start` 时 `begin()`；`end` 忽略。

**教训。** 一个测试自己派发的事件，永远不能证明宿主会派发它。写监听之前先在宿主打包产物里
数一遍 `append(` 的次数——那个数字是 0 的通道，就是一个永远不会来的通道。

## DEF-53 · `outputTokens` 含推理 token，比例被放大到上限

**现象。** 一次重推理的回合之后，每条纯文本回复都显示成正常速度的四倍。

**根因。** `outputTokens` 是 `reasoningTokens` 的超集（宿主用量弹窗把它显示为「其中推理
N」），而分母只有 `text-delta` 累积。重度思考的回合比例被顶到 `RATIO_CEILING = 4`。

**修法。** settle 前减掉 `reasoningTokens`；`message.content` 含 `tool-call` 块时整条消息
跳过（工具参数同样计入 `outputTokens` 却从未作为文本流过）。

**教训。** 分子分母的构成必须能一句话说清；「同一条消息的 token」不等于「同一条消息的文本」。

## DEF-54 · 中断的 attempt 把污染留给下一次

**现象。** Esc 中断一轮之后，下一条干净消息的速度只有真值的四分之一，而且整场会话都偏小。

**根因。** `entry.message` 只在 `settle` 里清零，而中断走 `interruptedBlocks()` 分支，
provider 从未发过 `usage`，`settle` 根本不执行。残留的估算把下一次的分母翻倍，比例被压到
`RATIO_FLOOR = 0.25`。

**修法。** `start` frame 时 `speeds.begin(agentId)` 清累加量（保留窗口）。

**教训。** 「什么时候重置」有两个不同的量（累加量与窗口），当成一个量会让其中一个必然出错。

## DEF-55 · `settle` 为从未流式输出的会话建条目

**现象。** 进程里每个产生过消息的 agent 都会在 meter 里留下一条空记录；`forget` 只清被
dispose 的会话。长时间运行时这是一张无界增长的表。

**根因。** `settle` 用了 `entryOf(agentId)`（惰性创建），而它需要的只是「有没有东西可除」。
断言还写了 `meter.sessions.size === 0 || meter.sessions.get('nothing').marks.length === 0`，
`||` 的后半句让这条断言无论如何都通过。

**修法。** 改用 `sessions.get(agentId)`，与 `begin` 一致；断言改成
`sessions.has('nothing') === false`，并加一条变异。

**教训。** `||` 在断言里几乎总是可疑的：它把「两种情况都算对」写成了一句，于是没有任何一种
情况被真正锁住。

## DEF-56 · 锚点数量下限表写成远低于实况的数字

**现象。** `test/mutations.test.mjs` 的 `for (const [name, expected] of ...)` 把
`mutate-speed.mjs` 写成 30、`mutate-persistence.mjs` 写成 30、
`mutate-language-and-files.mjs` 写成 10，而实况是 49 / 44 / 21；同一块的注释写「thirty-nine
anchors」。

**为什么危险。** 判据是 `anchors.length >= expected`，所以永远不会失败。成对删除一条
`from:` 与它的 `file:` 行时，`owners.length === anchors.length` 仍然成立、逐条 missing 检查
也无话可说——脚本静默丢掉十九条变异，这道检查照样通过。而它存在的理由正是防这个。

**修法。** 三处改成实况 21/49/44，注释里的「thirty-nine」改「forty-nine」，并写清为什么
下限不能取个舒服的圆整数。

**教训。** 下限写成「够用就行」的数字，等于把检查的强度也写成了「够用就行」。

## DEF-57 · 速度徽章只在流式输出期间存在，用户看不到

**现象。** 用户两次报告「目前在界面中没有看到对应的速度显示」，附截图：顶行只有刷新、齿轮、建议三个控件。

**排查。** 服务端与路由都正常——`curl /api/ui-evolve/speed` 无 `agent` 返回 `error.agent.missing`（证明新路由已加载），带 `agent` 返回 `{tokens:0,ms:0,tps:0,active:false}`。问题在客户端渲染门：`if (typeof shown !== 'number' || !Number.isFinite(shown) || shown <= 0) return null`，而空闲时 `tps` 恒为 0。截图那一刻那一轮早已结束，所以徽章不存在。

**根因。** 这不是 bug，是设计错误：第一版把徽章做成「只在有读数时出现，结束后再留四秒」。写它的时候想的是「不要把没在发生的事画出来」，漏掉的是「用户要看的正是刚才有多快」——而他打开面板时那四秒早就过去了。

**为什么测试没抓到。** 29 条断言全部通过，因为它们都在 `SpeedBadge` 已经渲染出来的世界里断言（`openPanel` 会先点开面板、让 `/speed` 答出 `active: true`）。「用户在一个空闲会话上打开面板会看到什么」没有被任何断言问过——事实上当时有一条断言是反过来的：`a zero reading draws nothing`。

**修法。** 新增 `known`（宿主成功答过一次），渲染门改成 `if (known === false) return null`；三态渲染 live / recent / idle，idle 显示淡化破折号。

**教训。** 「这个读数什么时候有价值」与「这个读数什么时候应该存在」是两个问题。断言写在功能已经可见的前提下，就检测不到「功能在真实的第一秒里不存在」。

## DEF-58 · 删 linger 代码时连带删掉 `setTick` 的 `useState`

**现象。** 自查时发现：重写渲染门、删掉旧的 `showTick`/`setTick` 声明之后，`repaint` 定时器里仍在调用 `setTick((count) => count + 1)`。真实空闲四秒后回调触发会抛 `setTick is not defined`。

**为什么全绿。** 389 条断言里没有一条真的让那个 4 秒定时器回调执行——测试用的是注入的时钟（`instance.clock.at`）直接跳到 4001ms 读渲染结果，而定时器的 `fn()` 从未被调用。定时器存在与否被断言了（`and a repaint is scheduled for when the grace period ends`），它回调时会不会炸没有。

**修法。** 把 `const [, setTick] = React.useState(0)` 加回来，并写清它为什么是负载的（linger 到点时没有别的东西会触发重绘，下一次轮询最远在十秒外）。

**教训。** 删一段逻辑时，它调用的状态声明也是这段逻辑的一部分。断言「定时器被安排了」不等于断言「定时器能跑」。

## DEF-59 · 变异 `why` 描述的是另一条变异的行为

**现象。** `a zero reading is shown as a number` 的 `why` 声称「最后一个真实数字留在屏幕上」。实际施加该变异后渲染的是 `0 tok/s`——真实数字被 0 替换，并没有留下。

**根因。** 写 `why` 时凭直觉补了一个「更有说服力」的后果，没有核对变异体的实际输出。真正的失败模式是「在本该表示没有输出时继续宣布一个速率」。

**修法。** `why` 重写为如实描述，并点名「保留旧数字」是 `the last number never expires` 那条变异的职责。

**教训。** `why` 是后续读者判断这条变异为何存在的唯一线索。写成另一条变异的行为，会让两个不同的防护看起来重叠，而重叠的防护会被合并或删除。

## DEF-60 · README 把「不画徽章」的宿主范围说窄了

**现象。** 第一版新措辞写「only a host with no `/speed` route at all … draws nothing」，但 `known` 的真实判据是「`ask()` 一次都没成功返回过」。宿主有这条路由、也答了请求、但返回 `200 {ok:false, code:'error.speed.absent'}`（缺少 `speedOf` 依赖）时，`unwrap()` 照样抛错，`known` 不置真，徽章同样不画。首次请求 500、返回非 JSON 也落在同一分支。

**为什么算缺陷。** 代码对了，文档说窄了。而这条文档描述的正是「为什么有些宿主看不到徽章」——读窄了的人会去查路由是否注册，而问题在依赖注入。

**修法。** 改成「Only a host that has never once answered draws nothing: no `/speed` route at all, a first request that failed, or a `200` carrying `ok: false` because that host cannot measure.」

**教训。** 判据写成「没有那条路由」时，实际判据往往是「一次都没成功答过」——路由存在不代表能干活。

## DEF-61 · `averageOf` 里留了一个不可达的守卫

**现象。** `averageOf` 在累加完样本后写 `if (ms <= 0) return null`。但每条样本的 `ms` 都是
`Math.max(MIN_SPAN_MS, ...)` 的结果，恒 ≥ 500，只要 `samples` 非空，累加必然大于 0。

**为什么是缺陷而不只是冗余。** 同一次改动在 `settle` 里删掉了四个被遮蔽的守卫，注释写的是「They are
gone rather than kept as decoration that reads like protection」。留下这一行，等于同一个文件里对同一件
事给出两种做法。

**检测手段的缺口。** 当时 `scripts/mutate-speed.mjs` 对 `averageOf` 没有任何锚点，所以「58/58 全杀」
并不覆盖这两条分支——删除第 299 行不会有任何测试变红。

**教训。** 判断一行可不可达要给出论证（这里是「`ms` 恒 ≥ `MIN_SPAN_MS`」），而不是凭「保险起见留着」。
留着的代价不是几个字节，是让下一个读代码的人以为这条路径真的会发生。

## DEF-62 · 「流式进行中但尚无 settle」没有断言

**现象。** `averageOf` 的 `samples.length === 0` 守卫被改成 `if (false)` 之后，整套测试仍然全绿。

**真因。** 冷启动那条用例走的是 `entry === undefined` 分支，根本没进 `averageOf`；而「有窗口、无平均」
这个状态——第一条消息正在流式输出、还没 settle——没有任何用例。

**修法。** `test/speed.test.mjs` 新增一块：`advance(100)` + `push` 之后断言
`midway.average === null` 且 `midway.active === true && midway.tokens > 0`。

**教训。** 「没有平均」有两个成因（没有条目 / 有窗口但没样本），只测其中一个，另一个的守卫就无法证伪。

## DEF-63 · 长轮询把「请求到达那一刻的读数」当成比较基准

**现象。** 第一次实现里 `speedWait` 只把 `after` 当作「调用方想要一次等待」的开关，比较基准是
`const started = deps.speedRevision(agentId)`——请求到达时服务端自己的读数。于是「两次 250ms 快轮询之间
revision 已经前进」这一类变化完全看不见。而一条回复恰好在这段间隙里落定，是**最常见**的情形而不是边界
情形：请求到达时 `started` 已经等于新值，服务端判定「没变化」，把它挂到下一个变化或 25 秒截止。

**后果。** 本次改动唯一要解决的那个症状原样保留：回复结束后，徽章要等满 25 秒才更新成「上一轮」的数字，
或者干脆停在上一条。用户读到的仍然是「只有生成时闪一下」。

**为什么 63 条变异全杀还是漏了它。** 唯一覆盖这条路径的用例，桩写成了自增计数器
（`speedRevision: () => { revisions += 1; return revisions }`）——每次调用都变，所以无论实现读不读 `after`，
第一次 tick 必然看到「变了」，用例恒通过。名字里写着「A revision that has already moved past」，实际测的是
「一个每次都在动的计数器会结束等待」。变异 `the wait treats every caller as behind` 也只覆盖了「是否等待」
这一半，`why` 里说的比较语义根本不存在。

**修法。** 比较基准换成调用方报的 `after`：

```js
  const moved = () => deps.speedRevision(agentId) !== after
  if (moved() === true) return Promise.resolve()
```

请求到达时若已经落后，立刻回答（这是最常见的情形，也是必须最快的那个）；否则循环比较 `moved()` 与截止
时间。用例侧把自增桩改成恒定 `9`，并补了反向的一条——「已经跟得上就一直挂着」——否则「立刻回答」也能
通过。变异改为两条：`the wait compares against the meter rather than the caller`（把基准换回 `started`）与
`a wait that starts up to date is answered anyway`（删掉提前返回）。

**教训。** 一个函数如果收了一个参数却只把它当布尔用，那么「参数生效」这件事就没有被任何东西验证过；
桩里凡是能被「每次调用都变」满足的断言，都无法区分「读了参数」与「没读参数」。


## DEF-64 · 长轮询到期后的空等被算成了余量

**现象。** 空闲时徽章的请求节奏约 52 秒一轮，其中 27 秒没有任何请求在监听。

**根因。** 下一次延迟写成 `SPEED_WAIT_MS + SPEED_SLOW_MS`，本意是「服务端 25 秒截止后再补 2 秒余量」。
但 `schedule()` 是在 `await call(...)` **返回之后**才执行的，所以那一刻 25 秒的挂起已经结束了，
这个表达式说的不是余量而是「再空等 27 秒」。一条回复只有三到八秒，落在这 27 秒里的概率接近一半，
`push` 推进的 `revision` 无人接收——正是这次改动要修的症状换了个位置重现。

**修法。** 用**上一请求实际挂了多久**决定下一次延迟：`const askedAt = Date.now()` 在请求前取，
`const heldFor = Date.now() - askedAt` 在响应后取。`heldFor >= SPEED_WAIT_MS / 2` 说明宿主真的会挂起，
那就 `schedule(0)` 立刻重发；瞬间返回说明宿主没等（旧版本、被代理吃掉、`after` 不被支持），
立刻重发就是自旋，于是退回空闲间隔。`SPEED_WAIT_MS` 的 JSDoc 重写为「既是契约，也是信号」。

**教训。** 一个延迟常量在**哪个时刻**被解读，决定它是「余量」还是「空档」。写在 `await` 之后的数字，
描述的是等待结束之后的时间，不是等待本身。

## DEF-65 · 只有非 active 的读数才装重绘定时器

**现象。** 生成中途出现超过 250ms 的无文本间隙时，徽章把最后一帧实时数字长期留在屏幕上，
而且仍是未调暗的「现在」样式。

**根因。** `next.active === true` 时直接 `schedule(SPEED_FAST_MS)` 并 `return`，
`repaint` 定时器只在非 active 分支里、且 `warm === true` 时才挂。改用长轮询之后，
这些间隙里的下一次请求会被服务端**挂住最长 25 秒**，这段时间既没有响应也没有重绘；
而 `heldFresh` 只在渲染时计算，没有别的东西会发现它已经过期。

**修法。** 把重绘臂提到 active 分支**之前**，对每一条读数都装（去掉 `warm === true &&` 这个前提）：

```js
            if (held.current.at !== 0) {
              if (repaint !== null) clearTimeout(repaint)
              repaint = setTimeout(() => { repaint = null; setTick((count) => count + 1) }, SPEED_LINGER_MS)
            }
            if (next?.active === true) {
              schedule(SPEED_FAST_MS)
              return
            }
```

**教训。** 「这个读数什么时候不再成立」与「这个读数是不是实时读数」是两个问题。
前者的答案决定了要不要装过期重绘，而后者的分支不应该是它的前提。
## DEF-66 · 每一行都不可点击：判据读错了 props

**现象。** 产出卡的每一行在真实宿主上都渲染成 `<div>`，没有任何点击行为，`title` 里也没有「点击在侧栏预览」。
`canPreview` 已正确发布、`openResource` 也已绑定。

**根因。** 行的 JSX 是在 `Cards` 里构造好再作为 `children` 传给 `Card` 的，因此那段闭包里的 `props` 是
**`Cards` 自己的 props**，而 `openable` 写成了 `typeof props.onOpenFile === 'function'`。`Card` 从不接收
`onOpenFile` 这个键（它只读 `onClick/clickable/expanded/expandHint/head/meta/title/children` 与两个鼠标
事件），于是这个判据恒为 `false`。

**修法。** 判据改成读真正持有通道的那一处：在 `openFile` 闭包旁边算出
`const canPreview = typeof openResource === 'function'`，行内用
`canPreview === true && typeof file.address === 'string' && file.address.length > 0`。

**为什么测试没抓到。** 这条断言是写完代码之后才补的，而补的时候我按「应该怎么写」去造 fixture（给每行
都塞了 `address`），恰好绕过了 `props` 这条错路。先写断言再写实现时那种「跑起来才发现根本没进这个分支」
的过程，才是唯一能拦住它的东西。

**教训。** 一个判据读的是**哪个对象**，比它读的是哪个字段更容易错。在 JSX 里把子树作为 `children` 传下去
时，子树里的 `props` 属于构造它的那个组件，不属于接收它的那个——「这个名字看起来该有」不是「它真的有」。

## DEF-67 · 顺序断言不可证伪：fixture 把两个假说排成了同一个答案

**现象。** 「按被编辑的顺序、最新在前，不按 mtime」这一组断言第一次跑就全绿；把实现改回
`files.slice().sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))` 之后**依然全绿**。

**根因。** fixture 的 7 个文件写作 `mtimeMs: 7000 - index * 1000`，于是数组第 0 项（`f1`）的 mtime 最大。
「不排序」与「按 mtime 降序」在这份数据上给出**同一个列表**，两种实现都能通过。

**修法。** `mtimeMs: index * 1000`——`f1` 最旧。现在数组顺序与 mtime 顺序相反，两个假说才给出不同答案。
改完之后同一条探针立刻杀掉 3 条断言（顺序、点击命中、展开后的顺序）。

**为什么测试没抓到。** 因为「抓到」需要测试数据能区分两个假说，而我按「看起来自然」的顺序造数据：
从小到大的递增最符合直觉，而那个直觉正好是错的那一边。

**教训。** 写「A 而不是 B」的断言时，第一步不是写断言，是问**这份数据上 A 与 B 会不会给出同一个答案**。
会，就先改数据。递增的 fixture 是默认值，而默认值往往恰好是错的那一边。

## DEF-68 · 一套变异从未被覆盖：路径字面量与常量表的错配

**现象。** `scripts/mutate-checklist-panel.mjs` 里有 **9 个坏锚点**（数组写法让解析器漏数一条并错位配对、
同一个守卫在 try 与 catch 各出现一次导致一次改两处、反斜杠少转义一层、`statTouchedFiles` 换签名后过期），
而 `node test/mutations.test.mjs` 一直是绿的。

**根因。** 该表的循环靠 `const xxx = path.join(repo, ...)` 常量把「脚本名」映射到「目标文件」，而
`mutate-checklist-panel.mjs` 的 `file:` 行写的是**路径字面量**（`file: 'packages/ui-evolve/lib/client.js'`）。
把它塞进原表会让每个 owner 都「unresolved」，于是当初就没有塞——而**没有被塞进去的检查，和没有这个检查
是一样的**，退出码不会因此变成 1。

**修法。** `test/mutations.test.mjs` 里单独加一段专查这个脚本：owners 用
`/^\s{4}file: ([^\n]+),$/gm` 取字面量并去掉引号，逐条 `split(anchor.from).length - 1` 判 missing / ambiguous，
并断言 `anchors.length >= 99`（与失败文案共用同一个 `minimum` 常量，见 R-63）。另外把
`scripts/mutate-checklist-panel.mjs:267` 的 `from: [...].join` 写法改成反引号模板串——解析器只认字符串
字面量，数组形式会被静默漏数。

**为什么测试没抓到。** 检查表本身是手写的白名单，而白名单的失败模式永远是「漏了一个」，不是「多了一个」；
漏掉的那一项不产生任何输出。数字下限能防它悄悄变少，但**前提是这个脚本已经被列进表里**。

**教训。** 「所有 X 都检查过了」这句话，只有当检查的枚举来源不是人手写的时候才可信。手写的白名单必须
有一条断言去问「这份名单完整吗」，否则它描述的是一年前的仓库。

## DEF-51 · 补记：修法（2026-11-10）

**修法。** 出口移出被裁剪的列表：折叠 4 行（`FOLDED_FILES`），按钮住在列表的**兄弟**节点 `.dsse-foot` 里，
展开时才给列表 `max-height + overflow-y:auto`（D-93）。同时列表顺序改由数据源决定、不再按 mtime 重排
（D-92），头部在展开态从 `N 个文件` 改成 `全部 N 个`。

**为什么不是方案 3（不截断）。** 侧栏里还有另外两张卡；一张不截断的产出卡会把它们推到两屏之外，而用户
此刻可能正在看那两张里的某一张。方案 2 让卡片高度稳定、出口永远可见，代价是卡内第二个滚动条——那个代价
只在用户明确要求「看全部」之后才发生。

**验证。** `test/client.test.mjs` 覆盖折叠 4 行、顺序、按钮位置、展开后滚动、收起回路；变异 99 条全杀，
其中 `the output card folds at five rows again`、`the way out is never drawn at all`、
`a row opens the first file instead of its own` 分别盯住折叠数、出口是否被画、以及「点哪行开哪个文件」。
按钮位置的断言是 `and it is not inside the list it reveals` 与 `and it sits below the list`，后者直接比较
`dsse-card-body` 里两个子节点的下标。

---

## DEF-69 · 两个圆标同一条规则、两个直径

`width: 26px` 加 `border: 1px` 不是「26px 的圆」。两种元素的默认盒模型不同：`div` 是
`content-box`（26px 是内容盒，边框在外面，外径 28px），`button` 是浏览器 UA 样式表给的
`border-box`（26px 已含边框，外径 26px）。同一条声明在两张卡上渲染出两个直径，而这轮改动的
全部目的就是让它们看起来是同一个东西。

判据错在哪：我当时写的断言是「两张卡共用同一条 `.dsse-expand` 规则」，而共用规则这件事
本身是对的——错的是**共用一条声明不等于渲染出同一个结果**。mock renderer 不做布局，所以
任何「读规则文本」的断言对两种 `box-sizing` 都点头；要发现它必须在真实浏览器里量，或者
像现在这样，把「盒模型必须写死」本身当成一条断言。

修法：共享规则 `.dsse-expand{box-sizing:border-box;...}`。写在 `.dsse-expand-action` 上只让
按钮迁就 `div`，`div` 那边仍旧 28px。

**教训。** 两个元素标签不同，默认值就不同；共性必须显式写死，不能指望继承。而「复用同一条
规则」只是复用的**一半**——复用的完整条件是「同一条规则 + 同样的默认值」。

## DEF-70 · 判据看了整条路径，于是工作区自己的名字成了证据

**现象。** 工作区位于一个叫 `build`、`dist`、`out`、`target`、`coverage`、`venv` 或 `.idea` 的目录
下面时（CI 检出到 `/build/<repo>`、开发者的项目放在 `D:\build\mine`、或者干脆把输出目录当 workspace
打开），产出卡显示「0 个文件 · N 个生成」并且一行都不画。文件都在，判据把它们全部归进了「生成」。

**真因。** `isNoisePath(path)` 收的是绝对路径，切段之后用「任何一段是生成目录名」判定：

```js
const segments = normalized.split('/').filter((segment) => segment.length > 0)
if (segments.slice(0, -1).some((segment) => GENERATED_DIRS.has(segment))) return true
```

工作区在 `F:/build/proj` 时，`F:/build/proj/src/app.js` 的目录段是 `['F:', 'build', 'proj', 'src']`，
`build` 在里面，于是 `src/app.js` 被判定为生成文件。判据本身没有错——它回答的是「这条路径上任何一级
是不是生成目录」；错的是**这个问题的范围**：读者问的是「工作区里这个文件是不是构建产物」，工作区
自己的名字根本不该进证据。

**修法。** `isNoisePath(path, cwd)`：先剥掉 `cwd` 前缀，再对剩下的相对部分切段。

```js
const root = typeof cwd === 'string' && cwd.length > 0 ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
const scoped = root.length > 0 && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
const segments = scoped.split('/').filter((segment) => segment.length > 0)
```

剥离不掉时（路径在工作区外）退回整条路径——这是对的：工作区外的文件本来就没有「工作区内的位置」
可言，按完整路径判断至少和 `.gitignore` 的直觉一致。

**回归断言。** 工作区建在 `<tmp>/build/project`，里面放 `src/app.js` 与 `node_modules/lib/index.js`，
断言前者 `noise === false`、后者 `noise === true`。探针：把 `const scoped = ...` 改成
`const scoped = normalized` → 235 passed / 1 failed。

**教训。** 一个函数收了一个参数却用来「限定问题的范围」，那么这个范围本身必须被断言覆盖——否则
参数传与不传、传什么，都不会有人发现。这也是审查说的那句话：**判据的适用域是判据的一部分**。

## DEF-71 · 一半的规范化比没有更糟

**现象。** DEF-70 修完之后，在 Windows 上仍能复现同样的症状：卡片显示「0 个文件 · N 个生成」。
但只在 `cwd` 与实际文件路径**大小写不一致**时出现。

**真因。** 剥离前缀用的是严格比较：

```js
normalized.startsWith(`${root}/`)
```

`cwd` 来自会话头（宿主记录的路径），文件路径来自工具参数原文（模型写进 `str_replace` 的字符串），
**两边都不做规范化**。Windows 与 macOS 的文件系统不区分大小写，所以两边经常是同一个目录的两种写法
（`F:/Work/proj` 与 `f:/work/proj`），严格比较失败 → `scoped` 退回整条绝对路径 → DEF-70 的症状重现。

**修法。** 两侧都 `toLowerCase()` 后比较（并且切片也走折叠串，见 DEF-72）。

**回归断言。** 同一块 fixture 里多加一次读面板，`cwdFor: () => dir.toUpperCase()`——把 `cwd` 传成
全大写、文件路径保持原样。断言 `files[0].noise === false`。探针：去掉 `toLowerCase()` → 236 passed /
1 failed，失败项正是这条。

**教训。** 「尽力而为的规范化」如果只做了一半（比较时折叠、切片时不折叠，或者这里折叠、那里不折叠），
它的失败模式是**静默的**：前缀剥不掉时函数不会报错，它只是悄悄地退回到上一次修好的那个错误答案。
凡是「匹配不上就退回默认行为」的分支，都必须有一条断言专门走那条分支。

## DEF-72 · 折叠改变了长度，就不能拿折叠后的长度去切原串

**现象。** 比较与切片用了两个坐标系：`normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)`
判定命中，然后 `normalized.slice(root.length + 1)` 在原串上切。绝大多数路径上两者一致；含
`İ`（U+0130，土耳其语大写 i 带点）的路径上不一致，因为 `'İ'.toLowerCase()` 是 `'i̇'`——**两个码元**。

**后果是双向的。** 多切一个字符：`.../node_modules/a.js` 剥掉前缀后得到 `ode_modules/a.js`，判据
匹配不上 → 依赖被当成读者自己的作品列出来（本该藏的没藏）。少切一个字符：工作区名叫 `xbuild` 时
余下串的首段变成 `build`，恰好命中 `GENERATED_DIRS` → 真实的源码文件被藏起来（本该显示的没显示）。
审查用探针验证了两种方向：`delta = 1` 时 `scoped` 是 `"/src/app.js"`（多切），反向是 `"rc/app.js"`（少切）。

**修法。** 整个余下路径都在折叠串上切：

```js
const folded = normalized.toLowerCase()
const foldedRoot = root.toLowerCase()
const scoped = foldedRoot.length > 0 && folded.startsWith(`${foldedRoot}/`) ? folded.slice(foldedRoot.length + 1) : folded
```

代价为零：下面每一处比较（`GENERATED_DIRS.has` / `GENERATED_FILES.has(name.toLowerCase())` /
`endsWith`）本来就不区分大小写，折叠整段不丢失任何信息。

**回归断言。** 把 `isNoisePath` 从 `api.js` 导出，直接对它做两条断言：`isNoisePath('/W/İ/node_modules/a.js', '/w/i̇')`
必须是 `true`（路径带短形、`cwd` 带长形，折叠后前缀六个码元而原串只有五个，按折叠长度切原串会吃掉 `n`），
以及同一工作区里的 `src/a.js` 必须是 `false`。放在 `readPanel` 层的断言做不到这一点：构造一个
「`stat` 能通过但两处大小写不同」的真实目录，比直接测纯函数难得多，而**这个缺陷恰恰藏在纯函数里**。

**教训。** 「先规范化再比较」是一个整体动作：**比较、切片、后续一切取值，都必须发生在同一个坐标系里**。
只折叠比较不折叠切片，等于引入了两套坐标系，而差异只在少数输入上显现——正是最难被普通用例发现的那类。

## DEF-73 · 只在某个平台才有内容的断言不是断言

**现象。** DEF-71 的回归断言写的是：

```js
cwdFor: () => (process.platform === 'win32' ? dir.toUpperCase() : dir)
```

在 Windows 上有效。在 Linux/macOS 上 `dir.toUpperCase()` 不会被调用，`cwd` 与路径大小写完全相同，
前缀比较必然成功——**断言与 `api.js` 的大小写处理无关，恒真**。审查实测：在非 Windows 上把
`api.js` 改回大小写敏感，结果仍是 237 passed / 0 failed，对应变异存活。

**修法。** 去掉平台判断，`cwdFor: () => dir.toUpperCase()`。这在任何平台都安全：`cwd` 在这个测试里
只进入字符串比较（`isNoisePath` 与 `resourceAddress`），真正 `stat` 用的是未改动过的绝对 `source`，
所以把 `cwd` 全大写不会导致文件找不到。审查实测改完后 237 passed。

**教训。** 写「平台相关」的测试分支之前，先问它**保护的到底是什么**。这里想保护的是「两侧写法不同
时仍能剥离前缀」，那是一个纯粹的字符串性质，与运行平台无关；把平台判断混进来，只是让断言在自己的
开发机上通过。**如果一条断言在某个环境里恒为真，它在那个环境里就不是覆盖，是噪音。**

## DEF-74 · 报错的地方自己报了个错

**现象。** `warm()` 的 catch 处理器写 `this.log.warn('the warm-up summary failed ...', error)`。
`log` 在每个调用方都是**裸函数**（`index.js:72` 是 `const log = (...parts) => {...}`，`api.js` 的类型是
`(message: string) => void`），它没有 `.warn`。所以这个 catch 一旦执行就抛
`TypeError: this.log.warn is not a function`，把「记录一次摘要失败」升级成 **unhandled rejection**。

**触发。** 面板被打开过一次（`viewed` 里有这个会话），之后任意一个 `summarise` 拒绝的回合。

**为什么测试没抓到。** 三处原因叠加：①`warm` 的这条路径**只在 `run()` 自己抛错时**才走到——`run()`
内部 catch 覆盖了所有它能存活的失败，所以正常失败根本不进这个 catch；②测 `warm` 的那几条断言用
的是「不抛、调用次数对」，从未让它真的触发 rejection；③`this.log.warn` 在语法上完全合法，
`node --check` 与任何类型检查都过。

**修法。** 改成 `this.log(\`the warm-up summary failed outside its own handler: ${error?.message ?? error}\`)`。

**教训。** 一个 catch 处理器是代码里**最难被测试覆盖**的部分，因为进入它需要先制造一个它本来要
处理的事故。所以 catch 里只该做**确定不会失败的事**——调用一个已知形状的裸函数、写一个字段。
任何「看起来像 logger API」的猜测（`.warn` / `.error` / `.debug`）都是在赌。

## DEF-75 · 清洗器删掉了中间的词

**现象。** `tidy()` 的粗体正则 `\*\*([^\n*]+)\*\*` 没有任何边界检查，会把**不是一对**的两颗星配起来：

| 输入 | 输出 |
|---|---|
| `Added **kwargs support and **tested** the path.` | `Added kwargs support and tested** the path.` |
| `The rule is x ** 2 plus **/*.md.` | `The rule is x  2 plus /*.md.` |
| `Passed **kwargs through to **the loader**.` | `Passed kwargs through to the loader**.` |

中间那些词**直接消失**。这不是外观问题，是数据丢失。

**为什么测试没抓到。** `tidy` 的原始断言全是「该清洗的被清洗了」（`**bold**` → `bold`），没有一条
问「不该清洗的是否原样保留」。而 `**kwargs` 这种输入在任何 Python 会话里都会出现。

**另一个更值得记的点：docstring 当时写的是错的。** 原注释说「`2 * 3` 需要空格，所以模式已要求两侧
有空格」——但**模式只要求两颗星相邻**，从未要求两侧空格。注释描述了一个没实现的守卫，于是下一个
读代码的人（包括写它的我）会以为已经安全。

**修法。** 两段守卫：先数 `**` 出现次数，**只有恰好两对（4 个）时才尝试清洗**；清洗时要求内侧非空白
（`(?=\S)…(?<=\S)`）。理由：两对星标意味着源码本身有歧义，段落级规则分不清强调与运算符/glob，
**留下标记只是外观瑕疵，删掉中间的词是数据丢失**。

## DEF-76 · 附件会被序列化成 `[object Object]` 当作「用户说的话」

**现象。** 读用户原话时如果直接对 content 数组做 `String(content)` 或 `JSON.stringify`，图片、文件、
运行时上下文这些块会变成 `[object Object]` —— 而它会被 prompt 当作**这个人问的问题**引用。

**为什么测试没抓到。** 测试夹具的 `human()` 一直只构造纯文本块，从未构造带附件的用户消息。
这个夹具的错误还连带着掩盖了另一个更严重的问题（见 DEF-78）：夹具里用户消息的形状是错的。

**修法。** `readUserText(content)` 只取 `block.type === 'text'` 的块，其余 `continue`。**跳过而非
序列化**：摘要引用 `[object Object]` 比引用空更糟——前者会让模型以为用户发了一段乱码。

补的断言里有一条直接守这件事：`asked.includes('[object') === false`。

## DEF-77 · 修好的 bug 没有任何断言守着它

**现象。** 第一轮审查报了一条 P1：`client.js` 的失败文案映射写 `the model call failed`，但
`run()` 主失败路径实际发的是 `the summary call failed: ${message}`（`summarise.js:554`）。于是
**401、过期 key、网络错误这些用户最常撞上的失败，全部显示「暂无摘要」**。修法是在映射表里加一条分支。

**为什么这条单独记一条缺陷。** 因为它修完之后，**`summaryReasonText` 仍然是零覆盖**——
2858 个断言全绿，而把那条新加的分支删掉，测试也全绿。也就是说这个修复**没有任何东西拦着它复发**。
审查实测：删掉 `the summary call failed` 分支 → 4 failed（只有补了断言之后）；在补断言之前，是 0 failed。

**修法（两层）。** ①新增 11 条 reason 的逐条断言；②在突变脚本里补 7 条突变，专门覆盖本轮修的
每一处——包括这条（`the failure copy matches a phrase the summariser never says`）。
**做完之后 2861 断言 + 30 条突变全杀。做之前 2858 断言全绿、突变套件对这个 bug 无反应。**

**教训。** 「修了一个 bug」和「这个 bug 不会再回来」是两件事。前者改代码，后者要**同时**留下一条
会失败的断言和一个会杀掉修复的突变。只做前者的修复，在下一次重构里和没修过的代码没有区别。

## DEF-78 · 测试夹具的用户消息形状是错的，而生产代码是对的

**现象。** 解压真实存档 `C:\Users\26903\.dsh\sessions\--F-dsh-plugin--\session-7012802f-...\session.v4.jsonl.zstd`
（1.2 亿字符）核对后确认：

| 事件 | 真实形状 | 正文在哪 |
|---|---|---|
| `user/message` | `data = { id, role, source, content }` | **`data.content`** |
| `assistant/message` | `data = { message, step, stream, turn, usage }` | `data.message.content` |
| `turn/end` | `data = { reason, turn }` | — |
| DEF-101 | 2026-11-13 | 断言在测「代码能跑通」，不在测「那条路被走到过」 | 新增的 `rememberSweep` 也会写盘，遮住了被禁用的那一处 |
| DEF-102 | 2026-11-14 | 重启后的第一轮被编号成第 1 轮 | 合并落盘计数时没有动已经打开的那一轮 |
| DEF-103 | 2026-11-14 | 两套突变并行跑，互相把对方还原成自己的备份 | 还原成功但内容是别人写的变异体；删除型变异无法被残留审计判为残留 |
| DEF-104 | 2026-11-14 | 两个 bracket 的 finish 在取基线前检查 cwd | cwd 为空时基线留在 Map，下一轮从上一轮的起点算 |
| DEF-105 | 2026-11-14 | scanReading 零覆盖，其突变 SURVIVED | truncated→partial 的翻译无人观察；第一次修还修错了位置 |
| DEF-106 | 2026-11-14 | 遍历器的目录过滤在生产路径上从未被传，`isGeneratedDirectory` 零调用点 | 每条测试都注入了 `skipDirectory`，只证明了「钩子会被问到」，没证明「生产传了」 |
| DEF-107 | 2026-11-14 | coverage 扩成三态后，三处 `=== 'partial'` 单值判断把它打回两态 | 新词 `none` 没有任何断言要求它活到面板；写到面板那条端到端断言是修之前才补的 |
| DEF-108 | 2026-11-14 | 三条新突变首轮 SURVIVED，因为断言只测了其中一种状态 | 非仓库分支只断言「没有忽略项」、合并块缺第三种路径、`source` 从写入到读回零断言 |
| DEF-109 | 2026-11-14 | 突变脚本崩溃时变异体留在源码里（第二次） | 脚本用 `text=True` 跑 node，GBK 解码失败抛异常，还原分支没走到 |
| DEF-110 | 2026-11-14 | S8 的走查剪掉了 `dist/`，而 `dist/` 正是它要补的盲区 | 所有断言都注入 `ignored`/`changes`/`scan`，没有一个让真 git 与真文件系统同时回答；注入的 `ignored` 直接返回「被忽略的路径」，从不问走查是否看得见它们 |
| DEF-111 | 2026-11-14 | 记下的来源活不过一个回合，被下一次重记抹成未知 | 写侧只在「有具名来源」时写值，读侧守卫因此永不触发；「没有具名来源的重记」这个最常见的路径没有任何断言 |
| DEF-112 | 2026-11-14 | 多根工作区里 `check-ignore` 整批失效，连答对的那些也一起丢 | 假 `run` 永远单根，测试从未构造「两个仓库同批」，也从未构造「退出码非 0 但 stdout 有内容」 |
| DEF-113 | 2026-11-14 | 一次 EPIPE 让整个宿主进程退出 | 假 `run` 的 `stdin` 是桩对象，结构上产生不了 `error` 事件；真实用例喂的输入都远小于 71KB 阈值 |
| DEF-114 | 2026-11-14 | 删除隔离副本时顺着 junction 删掉 29 个真实源文件 | 不是代码缺陷而是清理手法缺陷；没有任何自动化会在删除前检查 junction |
| DEF-115 | 2026-11-14 | 测试临时目录建在仓库里，多仓库测试其实从未发生 | 断言只看返回值形状，没有一条观察「发现了几个根」；单根与多根在返回值上可以完全一样 |
| DEF-116 | 2026-11-14 | 手写 PATH 让 node 启动即崩，四个变异被误报 KILLED | 变异判据只看「失败数非零」，不区分断言失败与进程没起来 |
| DEF-117 | 2026-11-14 | 先 `delete` 再 `set` 是死代码，而注释描述了一个不存在的机制 | 顺序由 `seq` 排序决定，删掉那行没有任何可观察变化；「没有变化」被当成了「这行无害」 |
| DEF-118 | 2026-11-14 | 晚到的旧回合声称覆盖了新回合的声称 | 所有 sweep 断言都在同一回合号内写入，没有一条构造「回合 2 之后再来一次回合 1」 |
| DEF-119 | 2026-11-14 | 两条断言恒为真，`known` 与 `repository` 的存在侧零覆盖 | 断言写的是「默认值是多少」而不是「什么情况下会变」；非默认值只活在测试自己的手写字面量里 |
| DEF-120 | 2026-11-14 | 审查单元的 diff 头部认错文件，`git apply --check` 直接失败 | 重组 diff 时复用了前一单元的头部；审查者靠读内容认出来，没有任何检查过「能否 apply」 |
| DEF-121 | 2026-11-14 | 十条 CSS 断言对着空字符串跑了整整一轮，全绿 | 断言读 `instance.styles`，而该字段要等模块 `apply` 并渲染过一次才有内容；没人先断言「表里确实有内容」 |
| DEF-122 | 2026-11-14 | 断言里按下标取按钮，按钮缺失时抛异常，整个套件没有 tally 行 | 只想到「断言失败」这一种红，没想到「断言崩了」在突变 runner 里是另一个判定（CRASHED），于是缺陷伪装成工具问题 |
| DEF-123 | 2026-11-14 | 1.5 秒的复制反馈定时器在面板关闭后仍在跑 | 它挂在 ref 上，不出现在渲染树里，也不经过任何已有的 cleanup；写的时候只想着「1.5 秒后复原」这一件事 |
| DEF-124 | 2026-11-14 | 「复制反馈已清零」的断言读的是另一颗按钮，删掉清零逻辑也全绿 | pending 的定时器属于「相对」槽位，断言读 `[0]`（绝对）；绝对按钮的定时器在那次 settle 里已被清掉，静息文案恒为 `绝对` |
| DEF-125 | 2026-11-14 | 十二条 CSS 断言只校验选择器存在，不校验声明体 | 用的是 `sheet.includes('.dsse-row[data-actions="true"]:hover .dsse-row-actions{')` 这类前缀匹配；规则体被改空时前缀仍在 |
| DEF-126 | 2026-11-14 | 变异条目的 `to` 少了 `return` 与收尾 `}`，套件在打印 tally 前崩溃，被记成 CRASHED | 我按「改一行」的直觉拼 `to`，没意识到它是整块语法结构的一部分；CRASHED 与 KILLED 是不同判定，前者看起来像工具问题 |
| DEF-127 | 2026-11-14 | 再按一次复制按钮关不掉菜单，只闪一下就回来 | 测试替身给的 `target` 是 `{dataset:{dsseCopy:"true"}}`，而真实浏览器给的是 `<path>`；没有人把 mousedown 与随后的 click 串起来观察 |
| DEF-128 | 2026-11-14 | 键盘聚焦时 22px 透明按钮压在文件大小上，读作 `1.2 ⊗B` | mock renderer 不做布局，没有一条断言检查两个盒子是否重叠；CSS 断言只看规则文本在不在 |
| DEF-129 | 2026-11-14 | 「点在菜单内部」这条分支零覆盖，把判断换成常量也全绿 | 默认 fixture 的 `frame` 没有 `contains` 键，`fakeNode.contains` 恒为 false，那条路径从未被走到 |
| DEF-130 | 2026-11-14 | 选完菜单项后焦点落到 body，没有任何断言 | 断言只检查「菜单消失了」，没人问过焦点去了哪里；`frame.onFocus` 这条唯一通道从未被使用 |
| DEF-131 | 2026-11-14 | 突变表里有一条完全重复的条目，有效变异体比计数少一 | 计数只数条数不查内容；两处 label/from/to/why 一字不差也能各自成立 |
| DEF-132 | 2026-11-14 | 改一行 CSS 后突变锚点变成 NOT APPLIED，看起来像通过 | 突变锚点引用整行样式，样式一改锚点就落空；NOT APPLIED 与 KILLED 在汇总里都只是「不是 survived」 |

而测试夹具里的 `human()` 构造的是 `data.message.content`（助手那种形状）。**生产代码
`transcript.js` 读的是 `data?.content`，本来是对的**；`packages/core/lib/evidence.js:288` 与
`ui-evolve/lib/index.js:431` 也读 `data.content`，三处一致。

**为什么这个错误能活这么久。** 因为**两种形状共享 `content` 这个字段名**——夹具写错了形状，
被测代码读的字段却恰好还在（`data.message.content` 里的 `content` 也存在于 `data.message` 之下，
而夹具同时把正文放在了 `data.content` 能读到的地方，或断言只检查了「有东西」而非「是这句话」）。
一个夹具能错多年而不失败，通常是因为它**错在了与断言正交的那个维度上**。

**修法。** 修 5 处夹具（`test/transcript.test.mjs` 的 `human()` / `runtimeContext()` / `toolResult()`、
`test/index.test.mjs`、`test/panel-wiring.test.mjs:346`），并在 `human()` 上加了 doc 注释记录这次核对
与「两个形状共有一个字段名正是夹具能错多年的原因」。

**教训。** **夹具应该来自真实数据，不能来自对数据形状的猜测。** 这个仓库有真实会话存档可用
（`session.v4.jsonl.zstd`），任何时候怀疑事件形状，解压一份比读代码快、也比读代码准。

## DEF-79 · 存储的轮次号压过路径快照，「本轮」在重启后认错文件

**症状。** 重启后先跑完一回合、再打开面板时，一个几小时前写过的文件会被标成「本轮改过」。
反方向也错：存储的轮次号与新快照冲突时存储号获胜，把快照刚列出的文件否决掉。

**根因。** `turnNow` 来自 `previous.turn`，是**本进程的计数器**（`transcript.js` 重启后从 1 起）；
`session-state` 里的 `turn` 戳来自写它的那个进程。两个进程的 `1` 不是同一个 `1`。
我把「存储号」当成更可信的一方，因为它更持久——**但持久不等于正确**。

**为什么测试没抓到。** 我只测了「文档里没有轮次号时退回快照」这一条路径。真正出问题的用例需要
「快照非空 **且** 存储号与快照冲突」，而默认夹具里两者永远由同一次 `turn/end` 产生，不会冲突。
审查者用 `paths [{brand-new.js,1},{old.js,1},{newer.js,7}]` + `turnNow=1` + `turnPaths={brand-new.js}`
端到端复现，那才是真实的重启形状。

**修法。** 快照优先，存储号只作 fallback。补 4 条断言：冲突时快照赢、快照列出的文件是本轮、
无快照时用存储号、存储号匹配时仍标本轮。

## DEF-80 · `turn/end` 传的轮次号完全没被固定

**症状。** 把 `rememberPaths(agentId, ended, endedTurn)` 的第三个参数删掉，`268 passed, 0 failed`。

**根因。** `turn` 写进会话文件后，唯一的可观察后果是「下一次开面板时本轮/更早分组对不对」，
而没有任何断言读过那份文件里的 `turn` 字段。它是纯新增数据，谁都没在看。

**为什么测试没抓到。** 三态与顺序的断言都只经过 `readPanel`，而 `readPanel` 的夹具自己构造
`previous`，绕过了持久化的 `turn`。**「数据写对了」和「数据被人用了」是两件事**——我测了后者的形状，
却没有一条测前者真的存在。

**修法。** `test/persistence.test.mjs` 新增一块：两个回合各写一个文件 → 等会话文件落盘 →
读 JSON 断言 `paths[late].turn === 2 && paths[early].turn === 1`。同时补一条突变
`the turn a file was written in never leaves the transcript`（`mutate-language-and-files.mjs`，
`file: index`），验证删掉参数会让这条断言变红。**这条缺陷是我自己用突变发现的，不是审查者报的。**

## DEF-81 · `document()` 里的变量与外层参数同名

**症状。** `session-state.js:832` 抛 `ReferenceError: Cannot access 'entry' before initialization`，
`persistence.test.mjs` 与 `session-state.test.mjs` 两个文件直接崩。

**为什么测试没抓到。** 抓到了——是测试发现的。这里记的是**工具链抓不到**：`node --check` 只解析语法，
同名变量遮蔽是运行时错误。

**教训。** 它发生在「测试文件崩溃」这一层：崩掉时不打 tally 行，运行器把整轮记为「无结果」，
这会掩盖同一轮里真正的 FAIL。这条与 DEF-86 是同一种伤害。

## DEF-82 · 两个 `title:` 属性，后一个覆盖前一个

**症状。** 行渲染里新增的 `title: note === '' ? ... : ...` 之后还留着一行旧的 `title: ...`。
缺失文件的「文件已被删除或移动」永远显示不出来，因为旧值把新值盖掉了。

**为什么测试没抓到。** 重复对象键在 JavaScript 里**合法**（后者生效，不报错），`node --check` 通过；
「相邻重复行」扫描也漏过，因为两行中间隔着 `onClick`。断言只查了 `data-status` 与右侧文案，
没有一条读 `title`。

**教训。** 手写 bundle 里多写一行合法但错误的属性，类型检查与语法检查都抓不到。
**凡是有「同一个属性的两个来源」的地方，都要有一条断言读最终值。**

## DEF-83 · 未知状态被当成「已消失」

**症状。** Host 发来第四种状态（如 `{status:'moved'}`）时，那行没有原因、没有大小、没有删除线、
不可点，却仍会在 hover 时高亮——一条死行。

**为什么测试没抓到。** 夹具只构造 `available`/`missing`/`invalid` 三个已知值。
**三态断言证明了三个值各自正确，没有证明第四个值被安全处理。**

**修法。** `const gone = status === 'missing' || status === 'invalid'`，注释写明「宁可当可用，
也不做一条死行」。

## DEF-84 · 路径时间戳绕过注入时钟

**症状。** `rememberPaths` 里的 `const at = Date.now()` 用真实墙钟，而同一份文档的 `updated`
走 `this.now()`。一份文档里两个时间来源。

**为什么测试没抓到。** 注入时钟的既有断言只测 `updated`，新加的 `at` 没有任何断言查它的来源。

## DEF-85 · 一条断言依赖它跑在哪台机器的哪个目录

**症状。** `test/api.test.mjs` 的 files-flags 块把夹具建在系统临时目录，却沿用 `deps()` 默认的
`cwdFor: () => process.cwd()`。`isNoisePath` 剥不掉不匹配的前缀、退回逐段判断，`Temp` 命中 `TEMP_DIRS`，
断言拿到 `noise: true` 而它期望 `false`。在 Windows 的系统 temp 下基线直接红，
连带把 `mutate-language-and-files.mjs` 的 `BASELINE FAILED` 守卫也触发。

**为什么测试没抓到。** 它没被抓到，是因为**我一直带着 `TMPDIR=.tmp-test` 跑**（工作区内的目录，
不叫 `Temp`），断言于是永远成立。审查者用系统 temp 跑一次就露了。

**教训。** **一条断言的成立如果依赖环境变量，它就不是断言。** 修法是显式声明 `cwdFor: () => dir`，
让夹具与工作区的关系成为测试的一部分；修完后带不带 `TMPDIR` 都是 264/0。

## DEF-86 · 新断言把「被发现」变成「无法测试」

**症状。** 三条突变报 CRASHED 而非 KILLED：`files[1].status`、`seen[1].path`、`reloaded[0].turn`
在归属能力被破坏时抛 `TypeError`，套件在打印 `N passed, N failed` 之前就死了。

**为什么测试没抓到。** 这不是测试没抓到，是**测试自己的失败方式错了一档**：崩掉等于放弃诊断，
会把「这里有断言」和「这里什么都不测」在报告里变成同一个样子。

**修法。** 全部改成可选链，并把 `invalid is not missing` 从「不等于 undefined 且不等于 missing」
改成直接断言具体值。修后三条全部 KILLED。

**教训。** 任何 `check(...)` 里出现 `x[0].field` 都可能把「被发现」变成「无法测试」。

## DEF-87 · CSS 断言只问「这段文字在不在」

**症状。** 三条断言读渲染出的样式表源码字符串，把选择器 `.dsse-row[data-status="missing"] .dsse-name`
的后代组合子去掉（删除线视觉上彻底消失），594 个断言仍全绿。

**为什么测试没抓到。** 断言问的是「这段 CSS 文字存在吗」，而它想证明的是「删除线挂在名字元素上」。

**修法。** 新增两条结构断言：`the deleted row still carries its own name element`
（`byClass(row, 'dsse-name').length === 1`）与 `and the row element is not the name element`
（行自身 className 不含 `dsse-name`）。两条一起，后代组合子被删掉就会红。
另外给「行不存在」与「行存在但属性对」两类断言都加了存在性前置，避免可选链吞掉要证明的失败。


## DEF-88 · `fileParts` 大小写敏感匹配，Windows 上整条绝对路径被当目录

`packages/ui-evolve/lib/client.js` 的 `fileParts` 原来写
`normal.startsWith(prefix) === true`。Windows 文件系统不区分大小写，而两侧来源不同：
workspace 来自 `agent?.session?.header?.cwd`（`index.js` 的 `workspaceFor`），
文件路径来自工具调用记录。`C:\Work\src\a.ts` 配 `C:\work` 就匹配失败，
落回退分支，把 `C:/work` 整段当成目录显示在文件名旁边。

**为什么测试没抓到**：三条目录断言都用了同一个大小写的夹具（`/work` 配
`/work/src/...`）。断言是对的，夹具太一致 —— 它们证明了「相同大小写时对」，
而这个缺陷只在混合大小写时出现。修法是两侧 `toLowerCase()` 比较、原串切片，
并加三条用小写 cwd 配大写路径的断言，加一条把比较改回严格形式的突变。

## DEF-89 · 行实际 32px，预留值按 28px 算，8 行只装得下 7 行

`FILE_LIST_MAX_PX` 与 `.dsse-row` 是一对必须同时成立的数字，但只有前者被断言。
`.dsse-row` 少了 `box-sizing:border-box`，`min-height:28px` 之上再加
`padding:2px 6px` 就是 32px。

**为什么测试没抓到**：`max-height` 断言原本用 `\d+`，任何数字都过 —— 它证明了
「有个高度」而不是「高度是这个」。先把断言收紧成字面 `245px`，再补
`a row measures what the reservation assumes` 钉住 `border-box`，
最后加一条删掉 `box-sizing` 的突变。这样两个数字互相绑定，改任一个都会红。

## DEF-90 · 突变运行器在还原写失败时把变异留在源码里

`scripts/mutate-*.mjs` 的模式是「备份 → 就地改源码 → 跑测试 → 还原」。在 Windows 上
目标文件会被监视进程瞬时占用，写盘抛 `errno -4094` / `code UNKNOWN`；抛错位置正好
落在还原分支的 `try` 里，于是**变异后的源码留在磁盘上**。一轮下来五处：三个在
`client.js`（关闭动画、候选过滤、徽标点击），一个在 `session-state.js`（空记录永不
清理），一个在 `summarise.js`（语言约束段落）。

**为什么测试没抓到**：这不是被测代码的缺陷，是工具把自己的输出留在现场。它看起来
像「测试通过了」，因为那一轮跑的正是变异后的代码。真正的信号是全量套件在下一轮
才红，而那时改动者已经不记得自己跑过突变。

修法三层：①`mutate-checklist-panel.mjs` 的写盘重试本身写错成
`new Date.now() + 200`（`Date.now()` 是数字不是构造器），一进重试就
`TypeError: Date.now is not a constructor` —— 保护机制先坏，改为 `Date.now() + 200`；
②`mutate-language-and-files.mjs` 与 `mutate-persistence.mjs` 加
`writeWithRetry(path, content)`（6 次尝试、`60 * (attempt + 1)` ms 退避），替换全部
`fs.writeFileSync`，含 `finally` 里的兜底恢复；③新增 `_edit/audit_leftovers.py`：
解析每个突变数组，逐条查源码里 `from` 的命中数，`from` 为 0 而 `to` ≥ 1 判
`LEFT MUTATED`。**每次跑完突变必须跑它，0 才算跑完。**

## DEF-91 · 给 `.dsse-row-icon` 加尺寸规则，把技能卡图标从 17px 悄悄压成 14px

**现象**：S2 之后，面板上「技能与 MCP」卡里的技能图标变小了一圈。没有报错，没有断言变红，
视觉上也不刺眼——只是它和上一轮截图不一样了。

**根因**：S2 给新的文件图标定尺寸时，写的是 `.dsse-row-icon{width:14px;height:14px;...}`。
这个类名确实出现在 `client.js` 里，但它**从来没有任何 CSS 规则**——它只是技能卡
`jsx('span', { className: 'dsse-row-icon', 'data-kind': item.kind, children: jsx(Icon, { name: item.kind }) })`
的包裹元素，真实尺寸由 `.dsse-icon`（17px）决定。新规则一加，包裹元素的 14px 就把
里面的 svg 压住了。

**为什么测试没抓到**：`client.test.mjs` 里有断言检查 `.dsse-icon` 的规则文本，
但没有一条断言问「技能卡的图标最终渲染成多大」。尺寸是 CSS 级联的结果，而这个级联
跨越了两个互不相识的规则块（`.dsse-row-icon` 与 `.dsse-icon`），只读单条规则的断言
看不见它们的关系。这和 DEF-87 是同一个毛病：**断言问的是「这段文字在不在」，
而它想证的是「渲染出来是什么」。**

**修法**：删掉那条规则（`.dsse-icon` 会重新接管尺寸），并在原处留一行注释
`dsse-row-icon deliberately has no rule`；新图标改用独立类名 `.dsse-fileicon`。

## DEF-92 · 工具数量断言让全量套件变红

**症状。** 加完 `report_output_files` 后 `test/index.test.mjs` 报 `1 failed`：`seven tools registered skill_candidate_submit,...,report_output_files`。全量套件因此从 3010 变成 3009/1，突变脚本第一步就 `BASELINE FAILED`。

**判断：这是断言正确工作了。** 它挡住的是「一个工具悄悄不再被注册」——面板照常渲染、卡片照常从 `edit` 调用填、唯一的症状是某些文件消失。改断言时把数量改成 8，并**另加一条名字断言**，因为数量相等不能排除「删一个加一个」。

### 为什么测试没抓到

它抓到了。这条记在这里是因为它揭示了一个结构性缺口：断言只钉数量时，两个互不相关的工具可以一进一出而全部断言保持绿色。D-113 是补齐。

## DEF-93 · 残留审计脚本对新文件静默跳过

**症状。** `_edit/audit_leftovers.py` 报 `leftovers: 0`，而它其实一条新变异都没检查。

**怎么发现的。** 没有靠读代码，靠**主动注入**：我手动把 `if (recorded.length > MAX_REPORTED_PATHS) {` 改成 `if (false) {`，再跑审计，它仍然说 `leftovers: 0`。那一刻才知道这个数字是假的。

**两处根因，先后暴露：**

1. `FILES` 是手写字典（五个旧文件），`transcript` 与 `report` 不在里面。解析失败后代码执行 `if not f: continue`——**静默跳过**。
2. 修了第 1 处之后仍然报 0，因为另一边 `entries()` 里手写的别名桩不含新别名，探针 `node` 进程抛 `ReferenceError: transcript is not defined`，`entries()` 捕获后 `return []`——**又一次静默**。

**修法。** 两处硬编码都改成从脚本自身解析（`const <alias> = path.join(repo, ...)` 正则），并且：

- 解析不出目标不再跳过，计入 `unresolved` 并打印；
- `unresolved > 0` 时以退出码 2 结束，不是 0。

**复验方式写进流程：** 每次跑完突变，除了看 `leftovers: 0`，还要能证明它抓得住——本轮用一次真实注入确认（`leftovers: 2`），恢复后回到 0。

### 为什么测试没抓到

审计脚本不在测试套件里，它是手动跑的一次性工具，而**没有人给检查器本身写检查**。这已经不是第一次：DEF-90 是同一个脚本的「还原失败却没人知道」，这次是「检查失败却报干净」。两次的共同点是脚本用**静默跳过**表达「这条我不管」，而调用方把它读成「这条没问题」。

**教训：** 一个一次性诊断工具的错误比被测代码的错误更贵——被测代码错了，测试会红；工具错了，它签发的是通行证。

## DEF-94 · schema 的申报上限大于卡片容量

**症状。** `report-tool.js` 的 `maxItems: MAX_REPORTED_PATHS` 是 50，`transcript.js:462` 的 `slice(0, 40)` 是 40。一条完全合规的五十条申报，前四十条进卡、后十条消失，而工具回答「50 条已记录」。

**根因。** 两个模块各自定义了自己的上限，谁都没错，合起来错。这是审查者（r5c）读出来的，不是测试红出来的。

**修法。** `MAX_CARD_PATHS = 40` 定义一次，`MAX_REPORTED_PATHS = MAX_CARD_PATHS`。见 D-115。

### 为什么测试没抓到

`test/report-tool.test.mjs:68` 有一条 `the schema states the same cap the code enforces`，它断言 `maxItems === MAX_REPORTED_PATHS`——**两处都是 50，所以它一直是绿的**。这条断言问的是「写下来的两个数是否一致」，而真正的问题在第三个地方（卡片容量）。**一致性断言只能守住它自己圈住的那两个点。**

---

## DEF-95 · 拒绝一个已经发生的事实

**症状。** 超限申报返回 `{ ok: false, code: 'too-many' }`，错误信息劝模型「拆成几次调用」。而实际上前 50 条路径在 `execute` 被调用之前就已经由 `tool/call` 事件读进 `this.paths`/`this.declared` 了。

**根因。** 把「校验」写在了「采集」的下游，却用校验的结果去描述采集。采集先发生，校验无法撤销它。

**修法。** 改成 `{ ok: true, recorded: kept.length, dropped }`，把事实说出来。见 D-116。

### 为什么测试没抓到

那条断言写的是 `one path over the cap is refused`——它把「拒绝」当成了正确行为。**断言把缺陷写成了规范**，这是本项目第二次出现同一形状的问题（DEF-05 也是这个）。

---

## DEF-96 · 直调测试让 CRASHED 冒充「测不出」

**症状。** 把 `if (!Array.isArray(list)) return []` 弱化成 `if (list === undefined) return []`，突变结果是 `CRASHED` 而不是 `KILLED`——因为 `readPresentedPaths({ files: {} })` 抛 `TypeError: list is not iterable`，整份测试文件崩掉，一条断言都没跑完。

**根因。** 断言写成 `check('...', readPresentedPaths({ files: {} }).length === 0)`——**被测函数在 `check` 之前就执行了**，它一抛，`check` 根本没被调用。

**修法。** 加 `survives(fn)` 包一层 `try/catch`，抛错时返回 `{ threw: true, error }` 并让断言失败。同样的回归现在是一条普通红灯。

### 为什么测试没抓到

按仓库约定 `CRASHED` 要归零，但它是**运行器**的计数器，不是断言的结论。断言从未表达「这个调用可以抛错」或「它不该抛错」——它只是没能在抛错时做出判断。**一个连断言都没跑完的测试，在汇总行里和一条干净的测试长得一样。**

---

## DEF-97 · 两条突变锚点不唯一，守卫从未被验证

**症状。** 突变套件报 `NOT APPLIED anchor is not unique`，两条：一条锚在 `for (const declared of readPathListArgument(...)) this.paths.push(...)`（代码已改成 `this.declared`），一条锚在 `if (!Array.isArray(list)) return []`（`readPathListArgument` 与 `readPresentedPaths` 各有一份）。

**根因。** 新写的 `readPresentedPaths` 与旧的 `readPathListArgument` 结构相似，锚点自然撞车。而汇总行 `70 killed ... (of 73)` 里那 3 条的差额，没人去看。

**修法。** 锚点带上唯一上文：`this.declared.push` vs `this.paths.push`；`const list = bag.files` 只存在于 `readPresentedPaths`。

### 为什么测试没抓到

这里该问的是「为什么**突变套件**没喊」。它喊了，但喊在行尾，而汇总行是绿的。**一个把失败混在汇总数字里的检查器，和 DEF-93 那个签发假通行证的脚本是同一个毛病**：调用方只读最后一行。

---

## DEF-98 · 一个只在计划里存在的导出

**症状**：`node test/index.test.mjs` 直接以

```
SyntaxError: The requested module './git-watch.js' does not provide an export named 'readChanges'
```

退出。不是某条断言红了，是**整个模块图加载失败**。

**根因**：`index.js` 里写了 `import { GitWatch, readChanges } from './git-watch.js'`，而 `git-watch.js` 只 `export class GitWatch`。`readChanges` 是我在方案里描述过、却没落进代码的那一半——适配 `(cwd) => Promise<string[]>` 接口的函数。

**为什么测试没抓到**：抓到了，而且抓得很彻底。ESM 的具名导入在链接阶段就校验，所以这不是一条漏网的断言，是一次加载期崩溃。记在这里是因为它花的时间值得记住：**在改调用方之前，先确认被调用方真的有那个名字**。`node --check` 只看单文件语法，看不见跨模块的导出表。

**修法**：在 `git-watch.js` 里加 `export function readChanges(cwd) { return changedFiles({ cwd }) }`，并把它放在具名导出而非内联 lambda，好让 `apply` 里的接缝读作「注入这个，或者用真的那个」。

---

## DEF-99 · 复用一个函数，却没看它接受什么形状

**症状**：接线完成、`git-watch.test.mjs` 19/0、`git-changes.test.mjs` 42/0 全绿，而端到端测试两条断言红：

```
FAIL the bracket reads the workspace the session runs in []
FAIL and reads it again when the turn ends 0
```

`asked` 是空的——一个 `git` 读数都没发生。

**根因**：`workspaceFor(agent)` 的实现是 `agent?.session?.header?.cwd`。它原本只服务于一个调用点（`cwdFor(agentId)`，那个调用点传的是 `service('agents').get(id)`，确实是 agent）。而 git 接线有两处传的是**session**：

- `turn/start`：`workspaceFor(session)`
- `turn/end`：`const cwd = workspaceFor(session)`

session 的形状是 `{ id, header }`，没有 `.session`。于是 `agent?.session?.header?.cwd` 恒为 `undefined` → `''`。而 `GitWatch.start` 的第一条守卫就是 `if (typeof cwd !== 'string' || cwd.length === 0) return`——静默返回，不报错，不开基线。整条链路**从未运行过一次**。

**为什么测试没抓到**：单元测试各自都过了，因为它们各自喂的形状是对的：

- `git-watch.test.mjs` 直接传 `'F:/repo'`，绕过 `workspaceFor`。
- `git-changes.test.mjs` 直接传 `cwd`，同样绕过。
- `index.test.mjs` 里既有的面板测试用的是 `cwdFor`，那条路传 agent，是对的。

缺口在两者之间：**没有任何测试同时覆盖「事件流真的把 session 传进来」和「workspaceFor 真的读得出 cwd」**。而这类边界正是分离成两个包之后最容易漏的地方——单元测试各守一半，中间的接线没人守。

**修法**：`workspaceFor` 改为读两种形状，`subject?.session?.header?.cwd ?? subject?.header?.cwd`，并在注释里写清为什么两半会不一致。补一条突变（`the workspace is only read from an agent, never from a session`），它现在会杀死 3 条断言。

**教训**：一个返回空字符串的函数，和一个正确的函数，在类型上无法区分。凡是「拿不到就静默退化为空」的接缝，都必须有一条端到端断言证明它曾经拿到过。

---

## DEF-100 · 预检被套在了不该套的调用方上

**症状**：给 `changedFiles` 加了「先走文件系统、确认是仓库，再 spawn git」的预检之后，`test/git-changes.test.mjs` **10 条断言同时变红**。

**根因**：那 10 条用注入的 runner 描述一个**不在这块磁盘上**的仓库（`F:/big`、`F:/nowhere`）。预检先 `existsSync` 一看不存在，直接 `[]`，注入的 runner 一次都没被调用——它描述的场景被一个问题之外的原因挡掉了。

**为什么测试没抓到**：这次是测试抓到的，而且抓到得很干净。记在这里是因为它揭示了一条设计约束：**「这个路径存在吗」和「这个路径描述什么」是两个问题**。注入 runner 的调用方只在回答后者。

**修法**：`const injected = typeof options?.run === 'function'`，预检只在 `injected === false` 时执行。注释里写明理由。

**教训**：一个为了省开销而加的前置检查，会改变被检查代码的**语义**，而不只是它的速度。加预检时必须问：这个检查对每一种调用方都成立吗。

## DEF-101 · 断言在测「代码能跑通」，不在测「那条路被走到过」

**症状**：S6 补丁加完之后，`mutate-persistence.mjs` 里的 `a finished turn is not worth writing down`（把 `rememberTurn` 包进 `if (false)`）从 KILLED 变成 **SURVIVED**。此前一直是被杀的。

**根因**：`turn/end` 里新增的 `rememberSweep` 也会 `schedule()`，于是在正常路径上 `rememberTurn` 变成了「第二条写盘的路」。禁掉它，另一条路照写，磁盘上照样有文件，断言全绿。

**为什么 `rememberTurn` 仍然必要**：`rememberSweep` 在 `gitWatch.finish(...).then(...)` 里。`finish` 一旦挂起（网络盘上的 git、卡住的 `rev-parse`），那个 `.then` 永远不执行，而 `rememberTurn` 是同步的、必然发生的那一次。**所以存活不是假警报，它指出的是「这条断言没有把场景造出来」。**

**为什么第一次补的测试也没抓到**：我造的 fixture 让那个回合加载了 skill、调了 MCP 工具、编辑了文件——这三件事各自都会 `schedule()`，把被测的那一次完全遮住。**要观察的那次写盘，必须是没有别人能触发的场景。**

**修法**：在 `test/persistence.test.mjs` 末尾加一块 `a turn whose sweep hangs is still written down`，fixture 只有一句 assistant 发言（不加载 skill、不调工具、不编辑文件），reader 返回一个永不 resolve 的 promise，断言文件确实写出来、`previous.turn === 1`、`previous.said` 含那句话、且 `skills` 为空（证明没有别的来源触发过写盘）。

**第二个坑（同一个测试）**：第一版忘了发 `turn/start`。没有 `turn/start` 就没有基线，`finish` 拿到 `pending === undefined` 立刻返回 `nothing`，`.then` 立即执行并把 sweep 写了出去——「挂起」根本没发生，测试用真实行为证明了它想证伪的东西。**造「永不发生」的场景之前，先确认它本来会发生的那个前提确实成立了。**

**验证**：注入 `if (false)` 后该测试 **3 条失败**（「still written down」「names the turn」「keeps what the turn said」），恢复后 77/0；`mutate-persistence` 回到 **44 killed / 0 survived**。

**教训**：一条断言变绿有两种原因——代码正确，或者它走的那条路根本没被走到。前者是证据，后者是噪音，而两者在输出里长得一样。

## DEF-102 · 重启后的第一轮被编号成第 1 轮，而它其实是第 N 轮

**现象**：`C:\Users\26903\.dsh\plugin-data\skill-evolve\sessions\session-be2090ac-*.json`
在第二个回合结束后同时写着 `turns: 2`、`previous.turn: 1`、`sweep.turn: 1`。

**机制**：`SessionState.load()` 是异步的，`ctx.on('session/event')` 是同步回调。
宿主重启后第一条 `user/message` 先到，`transcripts.for(agentId)` 新建空 transcript
（`turns = 0`），`beginTurn(undefined)` 把它推到 1 并设 `this.turn = 1`。
读盘完成之后 `restore` 调 `hydrate`，`existing.turns += turns` 得到 2，
但 `existing.turn` 仍是 1。

**为什么测试没抓到**：`test/transcript.test.mjs` 里既有「先造 live 事件再 hydrate」的块，
也有「空 transcript 接受落盘数据」的块，但**没有一块同时断言 `turns` 与 `view().current.turn`**。
前者只断言 `turns` 的和，后者根本没有打开的轮。缺的那条断言是
「合并之后，正在进行的这一轮用的是哪个号」——一个两个块都没问的问题。

**修法**：`hydrate` 里 `if (existing.turn !== undefined) existing.turn = existing.turns`。
新增两块断言（共 6 条）：先开轮再 hydrate 时 `current.turn` 被改写、
`turn/end` 之后 `previous.turn` 与它一致、且不覆盖文件里那条 finished turn；
以及没有打开的轮时只取计数、不做编号。

**这一条属于哪一类**：与 DEF-101 同类——不是算错，是**某个数字有两个来源而没人对账**。
新增的突变 `the turn that opened before the file was read keeps the number it invented`
禁掉那一行，2 条断言失败。


## DEF-103 · 两套突变同时跑，各自把对方还原成了自己的备份

**现象**：`mutate-language-and-files.mjs` 与 `mutate-checklist-panel.mjs` 并行运行后，
`audit_leftovers.py` 报 2 处残留，全量套件 3 条断言红：

```
ANCHOR GONE   a missing file keeps its colour                    client.js  from=0 to=0
LEFT MUTATED  the decide route accepts any content type          api.js     from=0 to=1

packages/ui-evolve/lib/api.js:223   if (false) {                  ← 应为 declaredType.length > 0 && !isJson
packages/ui-evolve/lib/client.js   .dsse-row[data-status="missing"] .dsse-fileicon{...}  ← 整条被删
```

**机制**：每个突变脚本对每个条目做「读原文件 → 写变异体 → 跑测试 → 写回备份」。
两个脚本同时跑时，A 写着变异体、B 读到它当作自己的备份，随后 B 把那份变异体写回去——
**还原操作成功了，只是还原的是错误的内容**。两份「备份」互相覆盖，最后留下的既不是 A 的原始、
也不是 B 的原始。这与 DEF-90（还原写盘失败留下变异）是同一个设计的两面：
那个是「还原没发生」，这个是「还原发生了但内容已经被别人污染」。

**为什么审计没挡住**：`audit_leftovers.py` 检查的是「`from` 命中 0 而 `to` 命中 ≥1」。
`client.js` 那条 `to` 是空字符串（删除型变异），所以命中数恒为 0——它只能报
`ANCHOR GONE`，不能判 `LEFT MUTATED`。也就是说**删除型变异天然无法被这个审计判定为残留**，
只能靠「锚点消失了」这条弱信号间接发现。本次能发现，是因为顺带跑了全量套件。

**修法**：
1. `api.js` 的 `if (false)` 改回 `if (declaredType.length > 0 && !isJson)`。
2. `client.js` 补回 `.dsse-row[data-status="missing"] .dsse-fileicon,...{color:...tertiary}`
   ——这条规则的缺失同时说明**图标在已删除的行上不会褪色**，属视觉回归。
3. 三套突变改为**串行**执行（同一后台命令里 `node a; node b; node c`）。

**教训**：突变脚本不是幂等的，它们对同一批文件有写意图。
「跑得快一点」在这里换回来的是两次错误的备份还原，而且**还原操作本身不报错**。
串行跑完整套要几分钟，比事后判断哪一行被谁改坏便宜得多。


## DEF-104 · 基线在「用不上」的早退分支里没有被消费

**症状。** `ScanWatch.finish` 与 `GitWatch.finish` 都先检查 `cwd` 是不是非空字符串，
再取基线。`cwd` 为空时直接返回，基线留在 Map 里。

**后果。** 下一次 `turn/end` 会用上一轮的起点去算这一轮——把一个可能很长的区间
记成一件事。如果会话 id 被复用，区间可以跨越整个宿主 uptime。

**怎么发现的。** 不是读代码看出来的。`test/scan-watch.test.mjs` 里那条
`but the baseline is still consumed` 直接失败：

```
FAIL but the baseline is still consumed
29 passed, 1 failed
```

**为什么测试没抓到（在此修复之前）。** `git-watch.test.mjs` 有一条一模一样的
形状，但它从来没测过「`cwd` 为空时基线是否被消费」——它测的是「不读 workspace」，
而那次读取恰恰证明不了 Map 的状态。

**修法。** 两个 `finish` 都改成先 `get` + `delete`，再判断 `cwd` 与 reader。
顺带把注释改成解释**为什么**必须先取：一句「反正要消费」在代码里是看不出来的，
下一个人重排几个 `if` 就会把它改回去。

**教训。** 守卫的顺序本身就是一个决定。把「清理」写在使用之后的任何位置，
都会在某个早退分支上被跳过。

## DEF-105 · 一条翻译零覆盖，而它的突变说 SURVIVED

**症状。** `mutate-language-and-files` 报 `SURVIVED  a truncated walk is reported as
a complete answer`——把 `scanReading` 里 `found.truncated === true ? 'partial' :
'complete'` 换成常量 `'complete'`，全部套件照绿。

**根因。** 那道缝没有任何断言。`scan-watch.test.mjs` 的每条用例都注入 reader
（测的是 bracket 的生命周期），`scan-changes.test.mjs` 的每条用例都直调
`scanChanges`（测的是遍历）。夹在中间的 `scanReading`——唯一把 `truncated`
翻译成面板用词 `partial` 的地方——没人调用过。

**第一次修，修错了。** 我在 `scan-watch.test.mjs` 里加了断言，但写的是
`await scanChanges({ ..., maxEntries: 3 })` 然后断言 `budget.truncated === true`。
那断言的是**事实**，不是**那句话**：把翻译改坏，`scanChanges` 照样返回 `truncated`。
再跑，仍然 SURVIVED。修法是把预算参数透传进 `scanReading`（D-126），
断言它返回的 `coverage`。

**为什么测试没抓到（在这条断言之前）。** 两层测试各自完整，接缝处空白。
这与 DEF-99（`workspaceFor` 只认 agent 形状，两个单元各喂对形状）是同一种形状：
**两个绿的东西之间的那条线，没有人为它写过一句话。**

**教训。** 突变 SURVIVED 时，第一反应容易是「补个断言」；
要先问「我补的断言在测哪一层」。测下层的事实、改上层的一句话，两件事都叫「加了测试」，
但只有一件会让突变死掉。

## DEF-106 · 遍历器的目录过滤在生产路径上从未被传

**症状**：`scanReading` 调 `scanChanges({ cwd, since, ...budgets })`，从不传 `skipDirectory`。
`scan-changes.js` 的默认值是 `() => false`，所以生产遍历一个目录都不跳。
同一份文件里 `:77` 的注释却写着「The production value is `isGeneratedDirectory`」。

**为什么这是缺陷而不是配置**：`isGeneratedDirectory` 在 `api.js` 定义、在 `:1175` 导出，
**生产代码里零调用点**。审查者 `s7e` 的原话值得保留：
「the lift is correct and harmless; the abstraction it exposes is what's wrong,
and it is currently unreachable.」

**实测后果**：`node_modules` 里 6000 个文件 + 一个真正被编辑的 `src/real.js`，
扫描返回 4997 条全是依赖，真文件不在结果里；随后 `rememberPaths` 的 200 条上限
把剩下的位置也占满。在非仓库工作区——正是这条通路存在的理由——没有任何东西兜住。

**真机现场的同一件事**：让一个会话在非 git 目录里写三个文件，读它自己的状态文件：
```
sweep {'turn': 1, 'coverage': 'partial'}
stored paths: F:\dsh-plugin\dsh-skill-evolve\.git\index
```
唯一一条是 `.git/index`，三个真正写出来的文件一条都没有。补丁后同样的机器上
`scanChanges` 返回 `paths under .git: 0` / `outNodes: 0` / `out3 hits: 3`。

**为什么测试没抓到**：`test/scan-changes.test.mjs` 的每条断言都注入 `skipDirectory`，
`test/scan-watch.test.mjs` 也是。它们证明了「钩子会被问到」，而那正是唯一不需要证明的部分。
**要证明的是默认值，不是注入。** 修法因此不是补一条注入断言，而是
改默认值 + 写一条**不注入**的断言（走 `scanReading`，真的在临时目录里建一个 `node_modules`）。
注入验证确认它有效：把默认值改回 `() => false` → scan-changes 3 failed、scan-watch 2 failed。

**教训**：**一个可以被注入的接缝，它最危险的部分是默认值。**
注入让测试变容易，也让「生产没接线」永远不被发现——因为测试替生产做了那件事。

---

## DEF-107 · coverage 扩成三态后，三处单值判断把它打回两态

**症状**：新增 `none` 之后，三处代码写的是 `value?.coverage === 'partial' ? 'partial' : 'complete'`。
`none` 落进 else 分支，变成 `complete`。
更糟的是 `GitWatch.finish` 的合并：`before.coverage === 'partial' || after.coverage === 'partial' ? 'partial' : 'complete'`，
两端都是 `none` 时返回 `complete`。

**后果**：`none` 的原意是「没机会看」。变成 `complete` 之后，面板会告诉用户
「这一轮没有产出别的文件」，而真相是「这一轮没人检查过」。
它还覆盖掉上一轮的 `partial`——提醒单向变弱，且永不恢复。

**为什么测试没抓到**：`none` 是我在这一轮为了修 DEF-106 才引入的词，
当时没有任何断言跨过「存储 → 合并 → 面板」这条链。
**这一次的顺序是对的：先写端到端断言，它立刻红了。**
```
FAIL a bracket that never looked is not reported as clean {"turn":1,"coverage":"complete"}
```
那句 FAIL 就是缺陷的完整描述。

**修法**：不是打三处补丁，而是抽出 `packages/ui-evolve/lib/coverage.js` 的 `mergeCoverage`，
三个调用点改为问它，并给这个函数单独写 10 条断言（`test/coverage.test.mjs`）。
**三份相同逻辑能同时错，就能同时再错一次**——所以要让它只剩一份。

**教训**：给一个枚举加词，等于给**每一处比较**加一次机会。
加词之前先问：这个值在代码里有几个读者？如果答案是「我数不清」，
那先把它收敛成一次函数调用，再加词。

## DEF-108 · 三条突变 SURVIVED：断言看得见，实物看不见

**症状。** S8 新增 8 条突变，第一轮结果 `105 killed / 3 survived`。存活的三条不是代码写错，而是断言写得太窄：

1. `a workspace with no repository is answered as if it had one`——`ignoredPaths` 在没有仓库时返回 `repository: false`，测试只断言 `found.length === 0`。`repository: true` 与 `false` 在「没有忽略项」这个结论上**同值**，所以改坏了看不出来。
2. `the scan is asked even when git already answered`——合并块里走查给出的两个路径，一个会被 `ignored` 过滤掉、一个与 git 重叠，没有第三种「走查看到、又不被忽略」的路径。于是「先问哪些是 ignored 再丢」与「直接整份丢掉」产生同一张卡片。
3. `the bracket that found a file is not recorded`——`source` 从 `rememberPaths` 写到 `pathsSeen` 读回，中间**没有任何一条断言**。它被写成 `undefined` 也全绿。

**修法。** 三条都是补观察点，不是改代码：非仓库块改成断言 `answer.repository === false` 与 `answer.known === true`；合并块给走查加第三条路径 `C:/work/src/touched.ts`，并断言它**不在**卡上；`session-state.test.mjs` 新增一个块，写入 `'git'`/`'scan'`/一个不认识的词，断言前两个存活、第三个变 `undefined`，再 `flush` 后重新 `load`，断言存活的那个仍然在。

**为什么测试没抓到。** 因为断言的形状是「结果里没有这个」，而缺陷的形状是「两个不同的原因指向同一个结果」。`length === 0` 对「没有忽略项」和「问题不适用」都成立；`rows.length === 2` 对「正确分工」和「整份丢掉再补两条」都成立；`source` 根本没进任何断言，所以它是什么都行。这三条都是**同一个失败模式的不同实例**：观察点在结论上，不在原因上。

---

## DEF-109 · 突变脚本崩溃，变异体留在源码里（第二次）

**症状。** 给 S8 加突变时，`F:\dsh-plugin\_edit\add_s8_mutations.py` 跑完第一轮突变后崩了，`client.js` 里的 `blindNote` 渲染行消失（`grep -c "blindNote === '' ? null"` 得 0）。表现是后续测试全绿——因为那一行本来就只在有 caveat 时才画东西。

**根因。** 脚本用 `subprocess.run(..., capture_output=True, text=True)` 跑 node，node 输出里有非 UTF-8（其实是 GBK 能读到的）字节，`text=True` 让 `decode` 在 Python 侧抛 `UnicodeDecodeError: 'gbk' codec can't decode byte 0x94`，`proc.stdout` 变成 `None`，脚本在还原之前就退出了。变异体因此留在盘上。

**修法。** `capture_output=True` 保留，去掉 `text=True`，改成手动 `.decode('utf-8', 'replace')`；从 `_edit/client.s8.bak.js` 恢复源码；恢复后先 `grep` 确认那一行回来了再继续。

**为什么测试没抓到。** 因为测试根本不该抓这个——它测的是源码，而源码在那一刻真的坏了。抓到它的是**人眼**：`grep -c` 是我在脚本崩后主动跑的。这说明一件事：**任何「备份→改→测→还原」的脚本，都不能假设正常路径一定走得到还原那一步**。DEF-90 已经记过一次同样的机制爆炸（Windows 文件被占用导致还原写盘失败），这次是解码异常，下次可能是 Ctrl-C、可能是 OOM。正确的做法是让还原在 `finally` 里、并且让脚本在任何退出路径上都先做还原再做别的。本轮没有改脚本结构（时间不够且这是 `_edit/` 下的一次性脚本），但把「跑完突变必须先 `grep` 关键行 + 跑 `audit_leftovers.py`」写进了流程。

## DEF-110 · S8 的走查剪掉了 `dist/`，而 `dist/` 正是它要补的盲区

**症状。** S8 上线后，一个往 `.gitignore` 忽略目录里写产物的一轮，卡片上看不到那些产物——而 S8 的全部意义就是让它们出现。

**真机现场。** 真仓库 `s9repo`（`.gitignore` 含 `dist/` 与 `*.log`），脚本写 `dist/bundle.js`、`dist/app.log`、`src/extra.ts`，`git status --porcelain` 只报 `?? src/extra.ts`（`dist/` 两个文件 git 结构上看不见，符合预期）。直接跑三路生产函数：

```
git  paths   : ['F:/dsh-plugin/s9repo/src/extra.ts']
scan paths   : ['.gitignore', 'README.md', 'src/app.ts', 'src/extra.ts']
ignored      : []
```

走查连 `dist/` 都没进去。因为 `scanChanges` 的默认 `skipDirectory` 是 `isGeneratedDirectory`，而它的表里有 `dist`。

**为什么这是「沉默失败」而不是「少列几行」。** 两个盲区不重叠是 S8 的前提：git 看不见被忽略的，走查补那一块。当走查也剪掉 `dist/`，两个盲区变成同一个，而 `coverage` 仍然报 `complete`——没有任何东西会说「这一块我也没看」。S8 之前 git 至少还会说 `coverage: partial`（`node_modules` 之类），现在连那句都没有，因为走查自认为走完了。

**修法。** 见 D-132：拆出 `UNWALKABLE_DIRS` / `isUnwalkableDirectory`，只保留「不可能装着这一轮产出」的目录，`dist`/`build`/`out`/`target`/`coverage` 全部放行。修后同一套代码、同一个仓库输出六行、两个来源、重叠路径只出现一次。

**为什么测试没抓到。** 三层，每层都以「注入得太好」的方式失效：

1. **`ignored` 被注入。** `test/index.test.mjs` 的合并块里，`ignored` 是一个直接 `paths.filter(p => p.includes('/dist/'))` 的假函数。它假设「走查会报出 `dist/` 里的文件」，而这正是被证伪的那件事。断言于是观察到了正确的合并，却建立在一个不可能成立的前提上。
2. **`scan` 被注入。** 同一个块里 `scan` 是一串手写字面量，天然包含 `dist/bundle.js`。走查的过滤根本没参与。
3. **`scanChanges` 自己的测试注入了 `skipDirectory`。** `test/scan-changes.test.mjs` 里那条 `build output is skipped` 是显式传谓词的，它证明「传进去会被问」，同时**把 `dist` 被剪掉写成了规范**。改动默认值它不会变红——它测的是实现的一个用法，不是生产默认。

事后问了一个此前没问过的问题：**「S8 的默认值有没有被任何一条断言观察过？」** 答案是没有任何一条。S7 那次的 `skipDirectory` P0（DEF-106）是完全同形的第二次发作。两次都是「钩子存在、测试注入过、生产从不使用」，两次都是真机验收才发现。

**这次补的窟窿。** `scan-changes.test.mjs` 新增一个**不注入** `skipDirectory` 的块，断言 `dist`/`build`/`coverage` 都被走进去，另加一条「两个谓词对这几个目录必须给出不同答案」——防止有人日后以「去重」的名义把两张表合并。两条新突变：`the walk is handed the card filter instead of its own`、`the walk may enter a dependency tree`。第一条的第一版写成改 `scan-changes.js` 的默认值，结果 CRASHED（变异体引用了没导入的 `isGeneratedDirectory`），改成在 `api.js` 内部委托才成为有效的 KILLED。

## DEF-111 · 记下的来源活不过一个回合

**现象。** 第 N 轮由 git 分支记下的 `source: 'git'`，在第 N+1 轮变成 `undefined`，重启后仍然没有。实测：

```
after bracket: [{"path":"/w/a.ts","turn":5,"source":"git"}]
after fallback: [{"path":"/w/a.ts","turn":6}]
```

**原因。** `rememberPaths` 的第四参数 `source` 在 `origin === undefined` 时把整条记录写成 `source: undefined`，而 `turn/end` 每回合都会拿 `ended.paths` 重记整份表——那份表来自 transcript 的 report/present 声明，天然没有 bracket。

**为什么测试没抓到。** 三处同时失明：① 所有 `source` 断言都在**一次** `rememberPaths` 之后立刻读，从未写两次；② 读侧白名单（`source === 'git' || source === 'scan' ? ... : undefined`）零覆盖——因为写侧已经剥离非法值，经公共 API 永远走不到那个分支，而它唯一生效的场景是手改文档，恰恰没人测；③ `turn/end` 那条链路的断言看的是「行在不在」，不看 `source` 是不是还在。

**修法。** `const kept = origin === undefined && previous !== undefined ? previous.source : origin`。注入验证：改成 `const kept = origin` → `FAIL a later re-record keeps the bracket it already knew [{...turn:6...}]`。

## DEF-112 · 多根工作区里 `check-ignore` 整批失效

**现象。** 工作区里有 `repoA` 与 `repoB` 时，只问 `repoB` 的路径得到 `{ignored: [], known: false, repository: true}`；两个仓库各问一条也是空的。而 `repoA` 单独问是对的。

**原因。** 多根路径被拼成一批，`check-ignore` 固定跑在 `discovery.roots[0]`。别的根下的路径对 git 是「仓库外」，整批 `fatal: Invalid path` 退出 128。

**为什么测试没抓到。** 假 `run` 的 roots 来自 `injected` 分支，**永远单根**；同时没有任何用例构造「退出码 128 且 stdout 有内容」。真实 git 的形状（探针实测）是退出 128 但 stdout 里带着本仓库的命中——所以原实现 `code !== 0` 就 `break`，把已经答对的也一起丢了。

**修法。** 按 owner 分组、每组用自己那个根当 cwd（D-134）。注入验证：把 `run([...], root, ...)` 改成 `run([...], prefixes[0].root, ...)` → KILLED 3 failed。

**附带教训。** 这条最初 SURVIVED，原因不是代码对而是测试环境错：`TMPDIR` 指到 `dsh-skill-evolve/.tmp-test`，那个目录**在仓库里面**，`findRepositoryRoot` 向上找到外层仓库，`discoverRoots` 只返回一个根——多仓库测试根本没发生。见 DEF-115。

## DEF-113 · 一次 EPIPE 让整个宿主进程退出

**现象。** `await runGit(['check-ignore','--stdin','-z'], process.env.TEMP, 'p'.repeat(131072))` → 进程退出 1，`UNCAUGHT: EOF write EOF`。

**原因。** `child.stdin.end(input)` 没有 `child.stdin.on('error', () => {})`。git 提前退出时排队的写变成 EPIPE，而 EPIPE 在 Node 里是 `'error'` **事件**，没有监听器就是未捕获事件——整个进程退出，`execFile` 回调永不执行，`index.js` 里的 `try/catch` 完全看不到。

**为什么测试没抓到。** 假 `run` 的 `stdin` 是手写桩对象（`{ end() {} }`），结构上不可能产生 `'error'`；而真实 git 的测试用例喂的路径列表都远小于阈值（审查者测得约 71KB）。**`MAX_IGNORE_BATCH = 500` 条普通长度路径正好一个批次就够。**

**修法。** 一行 `child.stdin.on('error', () => {})`。已用一次性变异验证：删掉它 → 对应断言红。这是本轮唯一一条「会让用户正在用的会话消失」的缺陷，优先级高于其余全部。

## DEF-114 · 删除隔离副本时顺着 junction 删掉 29 个真实源文件

**现象。** `rm -rf .rvb` 之后 `git status` 显示 29 个 `D`（全部未暂存），`packages/ui-evolve/lib` 与 `packages/core/lib` 的源文件消失。

**原因。** 审查者建立的隔离副本 `.rvb` 里，`node_modules/@revxz/*` 是指回真实目录的 Windows junction。`rm -rf` 跟随 junction，删的是链接目标。

**为什么测试没抓到。** 这不是代码缺陷，是清理手法缺陷——没有任何自动化会在删除之前检查 junction。`.gitignore` 里的 `.review/` 拦不住 `.rvb`（它当时还没被忽略）。

**修法。** `git checkout -- .` 完整恢复（29 个文件，git 记得内容）；之后统一改用 `cmd /c "rmdir /s /q"`，cmd 的 `rmdir` 不跟随 junction。**规则写在这里：Windows 上删除任何可能含 junction 的目录，不能用 `rm -rf`。**

## DEF-115 · 测试临时目录建在仓库里，多仓库测试其实从未发生

**现象。** `fixed-root` 变异（把「每组用自己的根」改成「都用第一个根」）在正确的修复下本该被杀，实际 SURVIVED。

**原因。** `TMPDIR` 设在 `F:/dsh-plugin/dsh-skill-evolve/.tmp-test`。测试把仓库建在那里，`findRepositoryRoot` 向上走先遇到外层 `dsh-skill-evolve` 仓库，于是 `discoverRoots` 按「有上级仓库就不再找子仓库」返回单根——两个仓库从来没有被同时读过。

**为什么测试没抓到。** 断言只看 `ignoredPaths` 的返回值，而单根与多根在返回值形状上可以完全一样（如果被测路径都在同一个根下）。**没有任何断言观察「发现了几个根」**。

**修法。** `TMPDIR=F:/dsh-plugin/_tmp-test`（`F:/dsh-plugin` 实测不是仓库）。改后同一个变异立刻 KILLED（3 failed）。系统默认 temp 不可用：`EPERM: operation not permitted, mkdtemp ... errno -4048`。

## DEF-116 · 手写 PATH 让 node 启动即崩，四个变异被误报 KILLED

**现象。** 四个变异全部报 KILLED，但 stderr 里有 `InitializeOncePerProcessInternal`，测试一条都没有跑起来。

**原因。** 变异脚本自行拼了 `PATH`（含 `C:/Program Files/nodejs`），而这台机器真实的 node 在 `D:\Node_Js\`。node 启动即失败，失败数 > 0，脚本判定「变异被杀」。

**为什么测试没抓到。** 变异脚本的判据是「失败数 > 0」，不区分「断言失败」与「进程没起来」。**一个只数失败数的判据会把环境故障读成代码质量。**

**修法。** `ENV = dict(os.environ)` 继承再叠加 `TMPDIR/TMP/TEMP`，不重写 `PATH`。另外：KILLED 的判据应该看有没有 `passed, ` 这样的一行，而不是只看非零。

## DEF-117 · `delete` 之后再 `set` 是死代码，而注释描述了一个不存在的机制

**现象。** 删掉 `session-state.js` 的 `entry.paths.delete(file)` 这一行，`index` 303 条、`session-state` 290 条断言全绿。

**原因。** 那行注释说「Map 重复 set 保留原位置，所以必须先删再 set」。但 `pathsSeen` 是 `.sort((a, b) => b[1].seq - a[1].seq)` **显式按 `seq` 降序**，根本不依赖 Map 插入顺序。

**为什么测试没抓到。** 顺序由 `seq` 保证，删掉那行没有任何可观察变化；而「没有变化」被当成了「这行无害」，没人去问「那这行在做什么」。

**修法。** 删掉该行，注释改写为事实。同时补三条顺序断言（`two files are listed newest first` / `a re-edited file moves back to the top` / `and the list is still just those two`），让顺序这件事第一次被显式钉住。

## DEF-118 · 晚到的旧回合声称覆盖了新回合的声称

**现象。** 回合 2 记录 `complete` 之后，回合 1 的迟到 `none` 覆盖了它，卡片对新回合说了一句关于旧回合的话。

**原因。** `rememberSweep` 无条件 `entry.sweep = next`，而它在一次 `git check-ignore` 子进程 `await`（上限 2 秒）之后才被调用。这个窗口在 S8 之前是微秒级，新增的 `await` 把它放大到秒级。

**为什么测试没抓到。** 所有 sweep 断言都在同一个回合号内写入，没有一条构造「回合 2 之后再来一次回合 1」。

**修法。** 按 `previous.turn` 与 `stamp` 比较（D-137）。**第一版修错了**：写成 `stamp !== undefined && previous.turn > stamp`，让无号请求能覆盖有号，被新断言抓出 `FAIL a claim with no turn number yields to a numbered one — {"coverage":"none"}`。

## DEF-119 · 两条断言恒为真，`known` 与 `repository` 的生产侧零覆盖

**现象。** 删掉 `if (answer.code !== 1) known = false` 整行 → 78 条断言 **0 failed**。把成功路径的 `return { ..., repository: true }` 改成 `false` → 78 条仍全绿。全文件唯一一条 `repository === true` 断言来自早退分支。

**原因。** `known` 只在初始化时是 true、只在批次出错时置 false，而全文件没有能让批次出错的用例——断言测的其实是默认值。`repository` 的成功路径根本没有断言，三个早退分支各自翻转也没人发现。

**为什么测试没抓到。** 这是「假绿」的典型形状：断言名（`answered, not guessed`）描述的是意图，代码测的是默认值。**非默认值只活在测试自己的手写字面量里，产出侧零覆盖。**

**修法。** 补四类：批次出错（超时/ENOENT → `code === -1` → `known: false`）、21 个仓库撞 cap → `known === false` 且 `repository === true`、成功路径 `repository === true`、junction 经链接仍能分类。注入验证三条全红。

**这一条最值钱的判断来自审查者原话**：「没有重蹈『钩子存在、注入过、生产从不使用』的覆辙——消费端确实有测试。问题恰恰相反：**消费端有测试，生产端这三个字段的正确性几乎没有断言**。」

## DEF-120 · 审查单元的 diff 头部认错文件

**现象。** `.review/s8e2a-tests-merge.diff` 第一行是 `--- a/test/git-changes.test.mjs`，而内容来自 `test/index.test.mjs`；`git apply --check` 报 `corrupt patch at line 151`。同类问题也出现在 `s8e2b-tests-norepo.diff`。

**原因。** 我用脚本按 `@@` hunk 序号重组 diff，头部沿用了前一单元的 `--- a/` `+++ b/` 行。hunk 头声称 `+270` 行而实际只有 115 个 `+`，split 块的起始 `{` 整个缺失。

**为什么没抓到。** 审查者靠读内容自己认出了目标文件，所以结论仍然有效；但没有一个自动化检查过「这份 diff 能否 apply」。

**修法。** 记录规则：按 hunk 重组 diff 时，每个单元的头部必须按自己那份的目标文件重写；重组后立刻 `git apply --check`，不要等人读。

## DEF-121 · 十条 CSS 断言对着空字符串跑，全绿

`test/client.test.mjs` 里那组新断言检查样式表：`opacity:0` 在不在、`pointer-events:none` 配没配、`visibility:hidden` 用的是不是它、`:focus-within` 有没有、`display:none` 有没有被误加。

它们全部通过。而实际上 `instance.styles` 当时是**空的**：

```
styles=0 chars=0 hasAlpha=false
```

这个 bundle 的样式表是模块 `apply()` 时才注入的。断言块只做了 `instance.module.apply(instance.ctx)` 就往下读，但没渲染过任何东西，注入还没发生。

**为什么测试没抓到。** 十条断言里有六条是「字符串里有没有某个片段」。**对空字符串，`includes` 全部返回 false** —— 于是「不该有 `display:none`」这条**永远为真**，「该有 `opacity:0`」那条才该红却也没红，因为它们的写法把不存在当成了通过。一组只覆盖「没有什么」的断言，在空输入上是满分的。

`toLowerCase().includes()` 这类检查没有前置条件，它不会问「我看的是不是东西」。

**修法。** 先 `apply` → 渲染一次 `dsse-toggle` 并触发 `onClick` → `deepRender(seat('cards'))`，此时表里才有几万字符；再加一条守卫断言 `sheet.includes('dsse-row-copy')`，**用同一个函数证明这个字符串确实包含我关心的内容**。守卫红了，说明位置错了，而不是断言对了。

这条和 DEF-93（检查脚本对新文件静默跳过、打印假的 `leftovers: 0`）是同一个形状：**一个不能区分「干净」与「没跑」的检查器会签发通行证。**

## DEF-122 · 断言里按下标取元素，缺东西时崩掉整个套件

大小写那条断言写成：

```js
byClass(cased, 'dsse-row-copy')[1].props.onClick()
```

当相对路径按钮不该存在时（正是这条突变要制造的状态），`[1]` 是 `undefined`，`.props` 抛 `TypeError`，套件在打印 tally 行之前就退出。突变 runner 看到「没有 tally 行」，报的是 **CRASHED**，不是 KILLED。

**为什么测试没抓到。** 因为这不是「测试没抓到缺陷」，**这是测试自己是缺陷**。我写的时候只想到两种结局：断言绿、断言红。第三种是「断言没能跑完」，而它在工具侧有自己的名字和一个看起来像环境问题的样子 —— 我第一次看到 `CRASHED` 时先怀疑的是突变脚本。

**修法。** 先取数组，判长度，再决定是点它还是直接判失败：

```js
const casedButtons = byClass(cased, 'dsse-row-copy')
if (casedButtons.length === 2) { ...点击与断言... } else { check(..., false, 'no relative button to press') }
```

教训：**断言里读数组元素之前必须判长度**。缺了东西必须表现为「一条红的断言」，而不是「一个崩掉的进程」—— 前者说明产品坏了，后者看起来像工具坏了，而人会更愿意相信后者。

## DEF-123 · 复制反馈的定时器活过了面板

`copyPath` 成功后挂一个 `setTimeout(..., 1500)` 把按钮文案复原。定时器存在 `copyTimer` 这个 ref 里。

面板关闭时它不会被清掉：ref 不属于渲染树，没有任何 cleanup 会经过它。后果一个是 `setCopied` 写进一个已经不在的组件（在这个手写渲染器里是写进一个没人读的槽位），另一个是宿主真的要等 1.5 秒才释放那个定时器 —— 每次开合面板就多一个。

**为什么测试没抓到。** 因为断言只问了「1.5 秒后文案复原没有」，那是我唯一想过的行为。**同一个文件里 `closeTimer` 是有卸载清理的**（`:1490`，`useEffect` 的返回函数里 `clearTimeout`），我照着它写了 `copyTimer` 的创建却漏了它的销毁 —— 现成的范式就在上面几十行，而我要么没看见，要么看见了以为不适用。

这类缺陷的共性是：**它的证据不在功能路径上，在生命周期边界上**。测功能的人写功能测试，边界要单独想一次。

**修法。** 加 `React.useEffect(() => () => { if (copyTimer.current !== null) { clearTimeout(copyTimer.current); copyTimer.current = null } }, [])`，并补断言：点击后 `timers` 里恰有一条 1500ms 未清除的；`renderer.unmount()` 后它 `cleared === true`。

这条断言用**注入**验证过真的会红：把 cleanup 删掉后 `FAIL and closing the panel cancels the flash timer — [false]`。不注入就不知道它是不是又一条永远为真的断言（见 DEF-121）。

## DEF-124 · 断言读的是另一颗按钮

复制反馈的读取逻辑：`settle(true)` 设 `copied = {key, ok}`，立即 `setTimeout(..., 1500)` 在 1.5 秒后
把它清回 `undefined`。断言要证明「1.5 秒后复原」，于是先点一下、找到 pending 的定时器、
手动调它的 `fn()`、再读文案。

问题在「先点一下」那一行：点的是 `answeredButtons[1]`（「相对」槽位），
而断言读的是 `clearedButtons = byClass(row, 'dsse-row-copy')` 的 `[0]`（「绝对」）。
绝对按钮在那个回合里**从没被点过**，它的静息文案本来就是 `绝对`。于是这条断言在
「清零逻辑被整个删掉」的情况下依然通过。

修法是读同一个槽位，并输出整个数组以便失败时一眼看出是哪个：`clearedButtons[1] === '相对'
&& clearedButtons[0] === '绝对'`。

## DEF-125 · 十二条 CSS 断言只校验选择器存在

我把这类断言写成 `sheet.includes('\n    .dsse-row[data-actions="true"]:hover .dsse-row-actions{')`
—— 检查选择器后面紧跟一个左花括号。真实规则体是 `{opacity:1;pointer-events:auto}`。

把规则体改成 `{opacity:0}`，十二条断言**全部通过**：选择器还在，花括号还在，它们要检查的
是这个选择器**存在**，而不是它说了什么。讽刺的是我最担心的「整条规则被删掉」恰恰能被覆盖
（前缀没了），真正覆盖不到的是「规则还在但内容被改坏」——也就是更可能发生的那种破坏。

修法是让正则跨进花括号：`\{[^}]*opacity:1`、`\{[^}]*pointer-events:auto`。

## DEF-126 · CRASHED 不是 KILLED

给 `copyPath` 的同步 throw 分支补变异时，我把 `to` 拼成：

```
        } catch {
          settle(true)
```

只改了一行，看着没问题 —— 但 `from` 是四行（`} catch {` / `settle(false)` / `return` / `}`），
`to` 少了 `return` 和收尾的 `}`。变异体本身就是语法错误，套件在打印 tally 行之前就退出了，
runner 报 **CRASHED**，与「测试抓到了」的 KILLED 是不同判定。

一次 CRASHED 看着像环境问题或工具问题，很容易被当成噪声跳过；DEF-122 是同一天里第二次
因为同一类原因看到它。判断标准很简单：**变异体的 `from` 与 `to` 必须是同样形状的可运行代码**，
改的应该是语义而不是语法结构。修法是把四行整体复制、只替换其中一个调用。

## DEF-127 · 再按一次复制按钮关不掉菜单

现象：菜单打开后，再点一次复制图标，菜单闪一下又回来。只有点在 22px 盒子的 4px 边缘、让 `target` 正好是那个 `<button>` 时才能正常关闭。

链路：按钮唯一的子节点是图标（`svg > rect/path`），真实点击的 `target` 是 `<path>`，`target.dataset.dsseCopy` 是 `undefined` → 窗口的 `mousedown` 判定「点在菜单外」并 `setMenuFor(undefined)` → 同一轮里 `click` 读到旧闭包里 `open === true` → `setMenuFor(key)` 又设回打开。

无头 Chrome 真按下两次的读数（`_edit/r1_toggle_probe.py`）：

```
press 1 (open)           {"open": true, "renders": 2, "hitAtCenter": "path"}
press 2 on the icon      {"open": true, "renders": 4, "hitAtCenter": "path"}
press 3 on the border    {"open": false, "renders": 5}
```

`renders` 从 2 跳到 4 是「真的关了一次又开了一次」的指纹——如果它只是没响应，`renders` 会是 3。

修法：`onButton` 改成沿祖先链找 `target.closest('[data-dsse-copy="true"]')`，只有在没有 `closest` 时才退回读自身 `dataset`。

**为什么测试没抓到**：所有 fixture 给的事件都是 `{ target: { dataset: { dsseCopy: 'true' } } }`——一个真实浏览器永远不会产生的形状（`<path>` 没有 `dataset`）。更关键的是没有人把 `mousedown` 与随后的 `click` 串起来看结果，而缺陷恰好只在两件事**依次**发生时才出现。两个审查者对此判断相反（一个说会闪回来，一个说最终仍是关闭），只有真机能把这件事定下来。

## DEF-128 · 聚焦时 22px 透明按钮压在文件大小上

现象：键盘 Tab 到打开按钮，动作层显形，右侧读作 `1.2 ⊗B`——图标正压在 `KB` 上，两个语义都只剩一半。

成因是三件事的交点：显形规则含 `:focus-within`、隐藏尺寸的规则**故意**不含它（D-143）、而按钮本身 `background:transparent`。

修法：聚焦时给按钮不透明底色（D-149）。真机读数 `{"buttonBackground":"rgb(246, 247, 249)","sizeVisible":"visible","overlap":20}`。

**为什么测试没抓到**：mock renderer 不做布局，没有任何几何断言；CSS 断言只检查「某条规则里有 `visibility:hidden` 或 `opacity:0`」这类文本特征，而「两个盒子重叠 20px 且一个透明」根本不是一个能被文本断言描述的事实。这个缺陷是审查者用无头 Chrome 实测抓到的，我复现用的是同一手段。

## DEF-129 · 「点在菜单内部」这条分支零覆盖

`onDown` 里的 `const inside = node !== null && typeof node.contains === 'function' && node.contains(event?.target) === true` 三条件与，在默认 fixture 下 `node.contains` 恒为 false——因为 `settings.frame` 默认是 `{ left: 0, top: 0, width, height }`，**没有 `contains` 键**，`fakeNode` 于是把 `frame.contains ?? []` 当空列表。

所以把整段判断换成 `const inside = false` 也全绿。

修法：新开一个独立 fixture，`frame: { ..., contains: [insideTarget] }`，断言两条——`a press inside the menu leaves it open` 与 `and still closes on a press elsewhere`。

**为什么测试没抓到**：替身支持一件事（`frame.contains` 可传）不等于测试用了它。断言写的是「外部点击会关闭」，从没写过「内部点击不会关闭」——只测一半的布尔条件，另一半永远为真。

## DEF-130 · 选完菜单项后焦点落到 body

点菜单项后 `setMenuFor(undefined)` 让菜单消失，焦点随之落到 `document.body`。读屏用户按下去之后不知道自己在哪；`aria-label` 上的「已复制路径」也不会被播报（因为焦点不在那儿）。

修法：`copyRef`，菜单项 `onClick` 在关闭之后 `if (copyRef.current !== null) copyRef.current.focus()`。

**为什么测试没抓到**：突变 `choosing an entry drops focus on the floor`（把 `focus()` 换成自赋值）第一次跑就是 **SURVIVED**。补断言要用的通道一直存在——`test/client.test.mjs:90` 的 `focus: () => frame.onFocus?.()`——但从未被使用。补上之后同一条突变立刻被 KILLED。

## DEF-131 · 突变表里有完全重复的条目

`scripts/mutate-language-and-files.mjs` 里 `the panel asks for interface language again` 出现两次，label、`from`、`to`、`why` 一字不差。跑出来「143 killed」里有一对是同一个变异体跑了两遍。

修法：脚本按 `
  {
    file: client,` 切块、比对整块文本，删掉第二份。

**为什么测试没抓到**：突变测试检查的是「每条声明的锚点是否存在」，不检查「两条是否相同」。计数只会变多，不会报警。

## DEF-132 · 改一行 CSS 后突变锚点变成 NOT APPLIED

我把菜单的 `box-shadow` 从 `0 2px 8px rgba(15,17,21,.04)` 改成 `0 1px 3px rgba(15,17,21,.06)`，于是 `the menu opens as a popup over the list` 这条突变的 `from` 整行不再存在，runner 报 **NOT APPLIED**。

这不是通过，是「这条测试根本没跑」。汇总行里 NOT APPLIED 与 KILLED 都是「不是 survived」，很容易被当成绿。

**为什么测试没抓到**：锚点引用的是整行样式文本，任何一次样式微调都会让它落空。规则记进缺陷库：**改 CSS 整行之前，grep 突变表里是否有引用该行的 `from`；NOT APPLIED 必须当作红的处理**。
