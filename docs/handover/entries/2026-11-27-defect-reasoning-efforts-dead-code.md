---
id: D-20261127-efforts
date: 2026-11-27
type: defect
status: fixed
title: 关思考的代码从未生效——宿主的 efforts 是数组，代码当对象查键
packages: [ui-evolve]
baseline: 4477 passed / 0 failed（suggest 273/0、mutations 55/0、mutate-suggest 104/104 全杀、perf 退出 0）
pending_verify: 需重启宿主后在 /pair-app 观察一次推理模型回合的建议耗时与 finish reason
---

# 2026-11-27 · 「把思考压到最低」这段代码从上线起就没跑过

## 现象

用户提出：推理模型生成建议时应当关掉思考，这样返回快，也不会把输出预算花在思考上。

查代码时发现，这段「压到最低思考」的逻辑（`withCheapestThinking`）从写进来的那天起
**一次都没有生效过**。

## 根因

宿主 `dsh-llm` 的 `info.reasoning.efforts` 是**数组**：

```js
// dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js
if (reasoning.efforts.length === 0) throw INVALID_MODEL_REASONING
efforts.map((effort) => ({ id: effort.id, name: effort.name, ... }))
```

真实菜单长这样（`dsh-our-free-model/vendor/channel-pack/pack.js` 的
`CLINE_REASONING_EFFORTS`）：

```js
[{ id: 'none', name: 'None' }, { id: 'low', name: 'Low' },
 { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Extra' }]
// 默认档 = 'high'
```

而旧代码是按**对象**查键的：

```js
if (Object.prototype.hasOwnProperty.call(efforts, wanted)) { … }
```

对数组来说 `hasOwnProperty(efforts, 'none')` 永远是 `false`，函数原样返回 `controls`，
于是每次建议调用都用模型的默认档（`high`）思考：慢，而且推理 token 会把输出预算吃光
（实测 `completion_tokens: 220, reasoning_tokens: 220, finish: length`、正文为空）。

## 修法

```js
const efforts = info?.reasoning?.efforts
if (!Array.isArray(efforts)) return controls
const byId = new Map()
for (const effort of efforts) {
  if (typeof effort?.id === 'string' && effort.id.length > 0) byId.set(effort.id.toLowerCase(), effort.id)
}
for (const wanted of ['none', 'off', 'disabled', 'disable', 'minimal', 'low']) {
  const exact = byId.get(wanted)
  if (exact !== undefined) return { ...controls, reasoningEffort: exact }
}
return controls
```

返回**模型自己的拼写**，因为宿主是精确比较 id 的；查表用小写键只是为了容忍 `Disabled`
这类大小写。菜单里一个都不认识时**原样返回**，绝不猜一个 id——那会被宿主判
`INVALID_MODEL_REASONING`。

## 为什么测试没抓到

`test/suggest.test.mjs` 的 `fakeLlm({ efforts })` 把 efforts 直接塞进
`{ reasoning: { efforts } }`，而那两条断言（「which is the low effort」「an off switch is
preferred to a small effort」）用的夹具是**对象**形状：

```js
fakeLlm({ efforts: { low: 'low' } })
```

**测试和实现共享了同一个错误形状**，所以 92 条突变、259 条断言全绿也没有一条能发现
这段是死代码。夹具改成数组之后，两条旧断言立刻变成「按数组查键」的新断言，并补了
`off` / `Disabled` / `Minimal` / `disable` 四种拼写、无 disable 项的菜单、以及「菜单存在
但一个都不认识」的菜单。

这是 DEF-204（`display:contents` 没有盒子，假父元素却有宽度）之后，
「替身必须复现它替的那个东西的物理性质」的第二次实证。

## 教训

1. **一个从来没生效过的分支，比一个写错的分支更难发现**：它不会崩、不会报错，测试还会
   因为夹具同错而一路绿。
2. **夹具与实现共享形状时，测试证明的是两者一致，不是两者都对**。写夹具时唯一的判据
   是「宿主真的会传这个形状吗」，而不是「我的代码期望什么形状」。
3. 用户报的「慢」和「输出超限」是同一个根因的两面；把「关思考」当成优化项会漏掉它是
   一个**缺陷**。
