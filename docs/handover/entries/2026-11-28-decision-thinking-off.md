---
id: D-20261128-thinking
date: 2026-11-28
type: decision
status: active
title: 关思考 = 一个 effort 都不传；方言由 profile 的 compat 决定，而 settings.yaml 是产物
packages: [ui-evolve, docs]
---

# D-20261128-thinking · 关掉建议调用的思考

冻结台账里的细节：`D-267`（关掉 = 不要那个字段）、`D-270`（`DISABLE_EFFORTS` 唯一名单，
后被废弃）、`D-271`（插件永不传 effort、方言由 profile 决定）；缺陷链 `DEF-213`、
`DEF-215`、`DEF-216`。

## 决定

1. **插件侧一个 `reasoningEffort` 都不传**，包括读作「off」的 id。所有方言里
   「开」都写成真值 effort（`enable_thinking: !!effort`、`thinking: {type:"enabled"}`），
   连 `off` 这个 id 也会被当成开——「挑一个最便宜的档」这个思路本身是错的。
2. **方言由 profile 声明**：`~/.dsh/profiles/desktop/cordis.patch.yml` 的
   `llm-pi-ai.config.providers.magpie.compat.thinkingFormat: qwen-chat-template`。
   它在没声明 off 档时也无条件发 `chat_template_kwargs.enable_thinking=false`；
   `deepseek` 方言在 `off === null` 时**一个参数都不发**，等于没说。
3. **不手改 `~/.dsh/settings.yaml`。** 它是宿主启动时从 `cordis.patch.yml` 渲染出的
   产物，每次启动重写；改它等于给下次启动准备一次撤销。

## 代价

- 换机器或换 provider，要重新在 profile 里声明 `compat`，否则思考又会开。
- 部分模型关掉思考后质量下降；本功能只要「像人打的一句话」，可接受。

## 实测

网关侧同一 prompt：`thinking:{type:"disabled"}` 664 ms / 0 思考 token / 2 条；
不发该字段 25 921 ms / 700 思考 token / 0 条。宿主整链路：回合结束后 **967 ms**
出现三条芯片（改造前 12–31 秒且常常一条都没有）。
