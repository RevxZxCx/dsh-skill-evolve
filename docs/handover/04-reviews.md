# 审查日志

> **追加式**。每轮审查收敛后追加一条，不改旧的。审查的规矩来自用户（m06781）：**每次修改代码后都必须代码审查；针对审查意见做的修复必须再审查，多轮直到收敛。**

| 序号 | 日期 | 对象 | 结论 | 采纳 / 驳回 |
|---|---|---|---|---|
| R-01 | 2026-10 | 初版 13 模块 | 11 条，全部成立 | 11 / 0 |
| R-02 | 2026-10 | 双触发 + 三项差距 | 多轮，收敛 | 全部采纳 |
| R-03 | 2026-10 | 外部审查 F01–F12 | 10 条成立、2 条驳回 | 10 / 2 |
| R-04 | 2026-10 | 面板（右栏版） | 三轮收敛 | 全部采纳 |
| R-05 | 2026-10 | 浮层卡片 + 清单卡片 | 四轮收敛 | 12 / 0 |
| R-06 | 2026-10 | 技能加载后观察窗口（L1） | 四轮收敛 | 全部采纳 |
| R-07 | 2026-10-30 | 前端重构：三卡、审核 modal、宿主字体 | 两轮收敛 | 全部采纳 |

---

## R-01 · 初版 13 模块

11 条，全部成立。最严重的是 `writeSkill` 每次重写都把文件写坏（DEF-01），其余是竞态、TOCTOU、证据分档、`safe()` 包裹。

**采纳后固化**：每条缺陷都补了断言，其中 DEF-01 的断言是 `rawBytes.includes(0) === false`。

## R-02 · 双触发 + 三项差距

多轮。中途报了「推迟的发现在独占期结束后会再次上报」这个论证不成立——因为 `detect()` 每次从**完整历史**重算，但 `published` 集合已经记住了签名，所以推迟即丢失。补了 `deferred` 队列。

## R-03 · 外部审查 F01–F12（用户交付的文档）

十条成立并落地，**两条驳回**：

- **驳回「F02 的 digest 让模型无法改稿」**：不成立。`changed-since-approval` 正是设计意图——文本变了就退回队列再批一次。审查者把设计读成了缺陷。
- **驳回「F03 在修订分支补字段」**：位置错了。字段在上游 `findExistingSkill` 就丢了（DEF-08）。**症状出现的函数未必是数据丢失的函数。**

这一轮也是「三次测试自己错了」的来源：断言空真、`writeFile` 漏 `await`（表现为"大部分时候通过、偶尔失败"）、测试崩在断言之前（ENOENT 掩盖失败）。

## R-04 · 面板（右栏版）

三轮收敛，13/13 变异被杀。但这个版本随后**被用户否定**——它占用宿主右栏，与文件预览互斥。技术上是干净的，产品上是错的。

## R-05 · 浮层卡片 + 清单卡片（四轮）

这一轮的四轮值得单独记，因为它展示了「审出来的问题」如何逐层变深。

**第一轮（7 条）**：P1 是 confirm 模式下 staged 批准无提示且行会重新出现（卡片的"批准成功"是谎）；P2 是 `/candidates` 零覆盖、监听器清理不变量消失、「进入清单后保持打开」是恒真断言（`setTimeout` 落在真实事件循环，而断言只 await microtask）、行用 name 而非 id 标识。

**第二轮（5 条，全部实测成立）**：同名候选删错（DEF-11）、内部滚动关卡片（DEF-13）、blur 关卡片（DEF-12）、详情卡压列表（DEF-14）、`placeNear` 的 JSDoc 声称"不出屏"但只有水平方向成立。

**第三轮（7 条）**：`byIdThenName` 在 id 查不到时静默改投同名行（这是**上一轮修法的残留**——为了"兼容"而留的回退，本身就是缺陷）、变异脚本写死仓库路径、`avoid` 缺 `bottom` 时产出 `top: NaN`、锚点守卫只验 `left`/`top` 却依赖 `right`。

**第四轮（4 条）**：`lib/index.js` 又变回 CRLF 导致两个变异静默失配（DEF-16）、`approveCandidate` 的 JSDoc 与代码矛盾、README 写死变异数字、只带 id 的请求把 `skill: ""` 写进账本。

**第四轮之后自查还发现**：`panelHelp` 是空转开关（DEF-15）。

**收敛判据**：第四轮的产品代码零缺陷，剩下的全是注释/文档与换行状态。修完后三个变异套件归零、1722 断言全绿。

## R-06 · 技能加载后观察窗口（L1）

四轮。最重要的一条是 **[P1] `tool/result` 读错字段层级**：`lib/outcome.js` 从 `data` 顶层取 `callId`/`isError`，但宿主 `appendToolResult` 把它们放在 `data.result` 下面。所以观察窗口**永远看不到失败**，每个窗口都是 `no-error`——一个只会说好话的仪表。

这个缺陷同时存在于 `evidence.js` 与 `transcript.js`（同一个误读，三处同根因），一并修了。

**教训**：新模块读宿主事件时，形状必须**从真实日志核对**，不能从"另一个模块大概这么写"推断——那两个模块本身也错着。

## R-07 · 前端重构（两轮）

**第一轮**：发现 3 个 P1 与 6 个 P2。P1 为会话/候选/设置响应乱序、焦点按钮删除后 Tab 逃出 modal、矮视口裁掉审核 footer。P2 包括侧向切换清空卡片、候选重复打开竞态、设置响应乱序、代码元素插入字体不更新、fake DOM 焦点与卸载生命周期不足、teardown 无覆盖。

**采纳与落地**：全部 P1 与可测试 P2 已修复，见 `03-defects.md` DEF-17 至 DEF-21。fake DOM 增加焦点与查询能力，Modal 关闭/重开使用 epoch key，短高度 CSS 改为视口派生。真实浏览器验证焦点恢复、删除按钮后 Tab、500px 高度 footer、代码元素插入字体。

**第二轮**：直接复审发现 3 个新边界：关闭动画中重开被旧定时器关闭、侧向保存被拒后 bridge 不回滚、字体变量写回根节点会再次触发 observer。全部修复并补测试/变异，见 DEF-22 至 DEF-24。

**收敛判据**：`node test/run.mjs` 1734 passed / 0 failed；`scripts/mutate-checklist-panel.mjs` 26/26 killed；另两个变异套件归零；真实 React 页面完成主要交互与截图验证。剩余已知缺口为窄窗口抽屉未实现，已记入状态文档。

## R-08 · 用户验收后的布局修订

用户验收真实实现后提出四点修订：技能与 MCP 不按分区而按最近使用合并排列并用图标区分；空内容卡片默认隐藏；顶部标题块删除，只保留刷新、待批、设置一排；「上一轮」提炼按钮下方提示删除。

**核实与落地**：合并排序需要跨类型最近使用时间，旧接口只有技能加载顺序与 MCP 首次出现顺序，因此新增单一 `recentUse` 时钟并由 `/panel` 输出 `lastUsed`。客户端合并排序、空卡隐藏、紧凑操作行和删除提示均已实现；补客户端、API 与接线测试，并为排序、recency 更新和空卡隐藏补变异。

**收敛判据**：`node test/run.mjs` 1749 passed / 0 failed；清单变异 30/30 killed；真实 React 页面确认新布局与既有弹窗交互未回归。

## R-09 · 另一个 agent 的前端重构验收：真实浏览器复核

用户要求验收一次由另一个 agent 完成的前端重构（三卡同屏、候选审核改 modal、面板字体跟随宿主、设置收进弹窗）。核对顺序：① 跑全部测试与三个变异套件对比文档声明；② `git diff --numstat` 验证交接文档仍是纯追加；③ 读改动；④ **在真实 Chrome 里渲染真实 bundle**。

**数字全部吻合**：`node test/run.mjs` 1751、`scripts/mutate-checklist-panel.mjs` 30 killed、`test/mutate-panel.mjs` 14/14、`scripts/mutate-guards.mjs` 11/11。交接文档四个文件删除行全为 0，符合 append-only 约定。

**交接文档声称做过真实浏览器验证，但仓库里没有任何证据**：无 png、无 devDependencies、`test/` 与 `scripts/` 里 `jsdom|happy-dom|playwright|puppeteer|chrome` 零命中，且 `test/client.test.mjs` 自己写明「几何是否对齐是浏览器事实，这层覆盖不到」。因此搭了 `F:/dsh-plugin/.research/render/` 渲染台（CDP 驱动 headless Chrome + 真实 bundle + fetch 桩）来补这一层。

**真实渲染结果**：两个 seat 均注册、无运行时错误；三卡几何正确且与 `.prose` 矩形无交叠；modal 打开后焦点自动落在搜索框。抓到两处真实缺陷（DEF-25 主题 token 编造、DEF-26 网格项溢出被裁），均已修复并在真实浏览器复验浅色与深色两种配色。

**方法学教训**：
- `--window-size` 不保证生效（实测 `window.innerWidth` 只有 762），必须再用 `Emulation.setDeviceMetricsOverride`。否则两侧没有 gutter，卡片会「正确地」不显示。
- CDP 消息必须发 `{id, method, params}`；写成 `{id, method: p}` 时 Chrome 回 `-32600`，症状是所有 `Runtime.evaluate` 恒返回 `undefined` 而不是报错。
- `[data-conversation-content]` 是整列宽，正文靠居中；把 content 元素本身设成正文宽度会让 gutter 读成 0。
- 预算与几何是声明值还是实测值要分清：`DETAIL_HEIGHT=300` 这类是预留上界，真实高度在布局前无从得知，因此不能用「实测值」的口径去描述它。

**收敛判据**：`node test/run.mjs` 1758 passed / 0 failed（新增 `test/tokens.test.mjs` 7 条）；`scripts/mutate-guards.mjs` 11/11、`test/mutate-panel.mjs` 14/14、`scripts/mutate-checklist-panel.mjs` 30/30 全部 killed；真实 Chrome 浅色/深色截图确认徽标可读（深色下对比度 4.39）、主按钮对比度 18.08、卡片正文 15.03。
