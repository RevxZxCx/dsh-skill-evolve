# 补充调研：开源 agent 与 Hermes 的技能自进化

> 本文修正 [`01-调研报告.md`](./01-调研报告.md) 与 [`02-可行性分析.md`](./02-可行性分析.md) 中的两处判断。
> 结论先行：**我之前的矩阵漏了最重要的一行——Hermes Agent。它不是"有插件能做"，而是宿主原生就做完了整套。**

---

## 一、先回答"只有商业 agent 有吗"

**不是。** 之前的矩阵给人一种"只有 Qoder / CowAgent 这类商业产品才有"的印象，这是取样偏差——我当时按 `dsh` 关键词搜生态，漏掉了不带 DSH 关键词的主流体。

实际分布：

| 类别 | 谁 | 有没有 |
|---|---|---|
| 商业 IDE | Qoder（Skill evolution）、Cursor（Rules）、Claude Code（Skills + `/learn`） | 有，但 Cursor 主要是手写规则，不是自动提炼 |
| **开源 agent 框架** | **Hermes Agent**、GenericAgent、CowAgent、OpenViking | **有，而且 Hermes 最完整** |
| 研究/评测工具 | `alibaba/skill-up`、`MemTensor/skills-vote`、`ouroboros` | 有，但定位是"评测/治理"不是"agent 自己长技能" |
| DSH 插件 | `dsh-memory-evolve`、两个 forge、`dsh-skill-hub` | 有，但都是把上面那套做个简化版 |

---

## 二、Hermes Agent（★256k）——宿主原生实现，最完整的参考

`NousResearch/hermes-agent` 自我描述是 "The agent with a built-in learning loop"。**技能自进化是它的核心特性，不是插件。**

### 2.1 技能管理工具 `skill_manage`

六个 action，全部由 agent 自己调用：

| action | 用途 | 关键参数 |
|---|---|---|
| `create` | 新建技能 | `name`, `content`(完整 SKILL.md), `category` |
| `patch` | 定向修补（**首选**） | `name`, `old_string`, `new_string` |
| `patch` + `content` | 整体重写 | `name`, `content` |
| `delete` | 删除 | `name` |
| `write_file` | 加附属文件 | `name`, `file_path`, `file_content` |
| `remove_file` | 删附属文件 | `name`, `file_path` |

**设计细节值得抄**：每个 action 有**独立的文本槽位**——`content` 只属于 create/整体重写，`new_string` 只属于 patch，`file_content` 只属于 write_file。**跨槽位携带参数（比如 create 带 `file_content`）会在批次应用前被拒绝**，错误信息会指出"你的文本放错了键，该放到哪"。这是为了让文法约束的本地后端永远不会生成畸形调用。

### 2.2 什么时候写（系统提示词里明确要求）

Hermes 的系统提示词要求 agent 用 `skill_manage` 记录非平凡工作流，覆盖三种情形：

1. **摸索出值得重复的多步流程**
2. **踩了错误/死路之后找到了可行路径**
3. **用户纠正了它的做法**

> 注意第 2、3 条。**失败和被纠正比成功更有沉淀价值**——这是我在其他方案里没看到的明确表述。

### 2.3 "记教训，不记流水账"（原文）

> it captures **lessons, not logs**: a pitfall is a generalizable rule plus one clause of *why* (the mechanism), attached to the step it affects, stated once. **Incident narration, PR or issue numbers, dates, and quoted chat are not skill content**; the rule has to stand without the story behind it.

**逐字对照**：事件叙述、PR/issue 编号、日期、引用的聊天记录 **都不算技能内容**。规则必须脱离故事独立成立。

> 这条直接解决了我之前提的"节点只导航"问题，且表达更精确：不是"要指向原文"，而是**"故事性内容一律不进技能"**。

### 2.4 后台自省（background review）

技能自进化有两层触发：
1. **前台**：agent 在回话过程中调 `skill_manage`
2. **后台**：每回合结束后跑一次 background review，可以 `suggest` 或 `stage` 技能修改

后台 review **跑在独立的 prompt cache 里的 fork 上，不碰活跃对话**。

### 2.5 写入闸门 `skills.write_approval`

默认 **false = 自由写**。设为 `true` 时：

> every `skill_manage` write (create/edit/patch/delete/write_file/remove_file) is **staged** instead of committed — a SKILL.md is too large to review inline, so **staging applies regardless of whether the write came from a foreground turn or the background review**.

暂存位置 `~/.hermes/pending/skills/`，**重启不丢**。审查命令：

```
/skills pending        # 列出暂存的写入 + 一行摘要
/skills diff <id>      # 完整 unified diff
/skills approve <id>   # 应用（或 all）
/skills reject <id>    # 丢弃（或 all）
/skills approval on    # 打开闸门并持久化
```

记忆写入有对称的 `memory.write_approval`。

> **关键判断**：这是**全审 / 全不审**的二元开关，**不是分级采纳**。所以我在 02 文档里提的 F4.4「分级采纳」**仍然是差异化点**。

### 2.6 Curator（策展人）—— 淘汰机制，我之前说"没人做"是错的

**这是最重要的修正。** 我原来在 01 文档里写"淘汰几乎全员缺失"、"没有人解决技能库长到 50 条以后怎么办"。**Hermes 解决了，而且是完整的生命周期治理。**

Curator 的定位（原文）：

> The curator is a background maintenance pass for agent-created skills. It tracks **how often each skill is viewed, used, and patched**, moves long-unused skills through **active → stale → archived** states, and periodically spawns a short auxiliary-model review that proposes consolidations or patches drift.
>
> It exists so that skills created via the self-improvement loop **don't pile up forever**. ... Without maintenance, you end up with dozens of narrow near-duplicates that pollute the catalog and waste tokens.

#### 两阶段运行

**阶段一：自动迁移（确定性，无 LLM 成本）**

| 阈值 | 默认 | 行为 |
|---|---|---|
| `stale_after_days` | 14 天未用 | 标记 `stale` |
| `archive_after_days` | 30 天未用 | 移到 `~/.hermes/skills/.archive/` |

**永不自动删除**——最坏结果是归档，可恢复。

细节值得抄：
- **Pinned 技能**和**被任何 cron job 引用的技能**（含已暂停/禁用的）**完全跳过**——防止一个慢的或暂停的定时任务把技能归档掉
- **从未用过的技能**（`use_count == 0`）有宽限期：不满 `stale_after_days` 岁数不归档。原文：**"Zero uses is absence of evidence, not proof the skill is disposable."**（零使用是缺乏证据，不是可丢弃的证明）
- **Hub 安装的技能永远豁免**
- `prune_builtins` 默认 false——因为"内置技能悄悄消失容易被误认为安装坏了"

**阶段二：LLM 整合（默认关闭）**

`curator.consolidate: true` 才开。跑一个 fork，能读任何技能（`skill_view`），逐条决定 keep / patch / 整合成"类级别伞技能"(umbrella) / archive（用 `skill_manage action=delete` 带 `absorbed_into` 目标）。

**为什么默认关**：每次跑要 50–100 次 API 调用，且对库做大范围结构性改动。

**整合的硬约束**：技能是一个**完整包**——如果它有 `references/`、`templates/`、`scripts/`、`assets/` 或相对链接，curator 必须三选一：保持独立 / 重新安置支撑文件并改写路径 / **整个包原样归档**。**绝不把 `SKILL.md` 单独拍平进另一个技能的 references/**。

#### 触发方式：按"不活跃"触发，不是 cron

同时满足两个条件才跑：
1. 距上次运行超过 `interval_hours`（默认 **168 = 7 天**）
2. agent 空闲超过 `min_idle_hours`（默认 **2 小时**）

检查时机：CLI 会话启动、gateway 日常维护、`hermes serve` 维护定时器。

**首跑行为**：全新安装时**不立即跑**，第一次观察只是把 `last_run_at` 设为"现在"，把首次真实运行推迟一整个 `interval_hours`。**给用户一整个周期去检查和 pin 重要技能，或干脆退出。**

> 这个"首跑延迟一整个周期"的设计**极其克制**。对比一下两个 forge"装完就开始写"的激进程度。

#### 备份与撤销

- 整合前自动打 tar.gz 快照到 `~/.hermes/skills/.curator_backups/<utc-iso>/`
- `hermes curator rollback` 一键回滚整次运行
- **回滚本身可逆**：替换前先打一个 `pre-rollback to <id>` 快照
- 默认 prune-only 运行**不**打快照（因为它只是把整个目录移进 `.archive/`，本身就是撤销手段）

#### 审计账本（这个尤其值得抄）

append-only JSONL 在 `~/.hermes/skills/.curator_ledger.jsonl`，**每一次技能变更**都记一条：

- `actor` — `curator`（后台 review / 自动迁移）/ `agent`（前台工具调用）/ `user`（CLI 命令）
- `action` — create, edit, patch, delete, write_file, remove_file, archive, restore, purge, rollback
- `evidence` — 删除意图（整合时是 `absorbed_into`，prune 时为空，以及是否走了可恢复归档）、触发会话 id
- `before`/`after` — 每文件 `{path, sha256}` 清单

**文件内容按 hash 内容寻址存储**（`~/.hermes/.curator_backups/blobs/`），一百条记录碰同一个未变文件只花一个 blob。

支持**单条撤销**：`hermes curator rollback <entry-id>` 只恢复那一次变更碰过的文件。因为前台删除也被记账，所以**硬删掉的技能也能从账本里复活**。

fail-closed：如果安全捕获写不进去，**什么都不改**。
但账本本身是遥测不是闸门——**记账失败时变更照样通过**。

#### 完整的 curator 命令面

```
hermes curator status/run/run --consolidate/run --background/run --dry-run
hermes curator backup / rollback [--list|--id <ts>|-y]
hermes curator pause / resume
hermes curator pin <skill> / unpin <skill>
hermes curator adopt <skill> / adopt --all-unmanaged / list-unmanaged
hermes curator restore <skill> / list-archived / archive <skill>
hermes curator prune [--days N]
hermes curator ledger [--skill <name>] [--limit 50]
hermes curator rollback <entry-id>
hermes curator purge [--days N] [--dry-run]
```

配置（`config.yaml` 的 `curator:` 段）：

```yaml
curator:
  enabled: true
  interval_hours: 168      # 7 天
  min_idle_hours: 2
  stale_after_days: 14
  archive_after_days: 30
  consolidate: false       # LLM 整合，opt-in
  prune_builtins: false    # 归档未用的内置技能，opt-in
  backup:
    enabled: true
    keep: 2
```

LLM review 可以走**更便宜的辅助模型**：`auxiliary.curator` 槽位（和 Vision / Compression / Session Search 同级），`provider: auto` 表示用主模型。

### 2.7 记忆系统（和技能明确分家）

| 文件 | 用途 | 字符上限 |
|---|---|---|
| `MEMORY.md` | agent 的私人笔记——环境事实、约定、学到的东西 | 2,200（约 800 token） |
| `USER.md` | 用户画像——偏好、沟通风格、期望 | 1,375（约 500 token） |

关键设计：
- **冻结快照**：系统提示词注入在**会话开始时捕获一次，中途永不改变**。这是为了保住 prefix cache。中途写记忆会立刻落盘，但**要到下个会话才出现在系统提示词里**；工具返回的永远是实时状态。
- **超限报错，不静默丢弃**：写入会超限时 `memory` 工具**返回错误**，agent 自己腾地方（同一回合内合并或删除条目）再重试。
- 条目用 `§` 分隔，header 显示使用率和字符数，**让 agent 自己知道容量**。
- **只允许一个 agent 用一个 Hermes home**：两个进程共享一个 home 会互相叠加出谁都没写过的状态。

> **"冻结快照 + 超限报错"这两条，直接印证了我在 02 文档里的两个判断**：注入内容不能变（否则击穿 cache）、静默失败是头号杀手。

### 2.8 `/learn` —— 把任何东西变成技能

不用手写 `SKILL.md`，`/learn` 接受任意可描述源：

```
/learn the REST client in ~/projects/acme-sdk, focus on auth + pagination
/learn https://docs.example.com/api/quickstart
/learn how I just deployed the staging server          # 刚才这轮对话
/learn filing an expense: open the portal, New > Expense, attach the receipt, submit
/learn ~/books/designing-data-intensive-applications.pdf   # 整本书 → 知识库技能
```

大纲来源大时（书、论文堆、大文档目录）**不塞进一个文件**，而是变成"知识库技能"。

> **`/learn how I just deployed the staging server` 这一条，就是你最初想要的"把这个对话存成技能"，而且是显式的、用户主动的。** 比自动提炼可控得多。

### 2.9 技能市场（带安全扫描）

- 内置安全扫描 + **可选** NVIDIA SkillEvaluator Tier 1 检查（PII 检测、unicode 走私检测、脚本 lint、许可证合规、SkillSpector 静态扫描）
- 安装走**隔离区(quarantine)**：扫描完整个包，把来源 URL、内容 hash、扫描器版本、发现项、时间戳记进 `skills/.hub/lock.json`
- 只复制 `SKILL.md` + 它**实际引用到的** `references/` / `templates/` / `scripts/` / `assets/` / `examples/` 文件，**未引用的仓库文件不复制**
- 就绪性检查：`incident-log-shape`（正文塞满 PR/issue 号）、`references-sprawl`（引用文件超 60 个）、`oversized-body`（正文超 ~24k 字符）。**只警告，从不阻止写入。**

> 这印证了我在 02 文档里的安全判断，而且 Hermes 的做法更彻底：**不是"不自动安装"，而是"装了也要扫描 + 记 hash + 只复制引用到的文件"**。

---

## 三、其他开源实现（补充进矩阵）

### `alibaba/skill-up`（★1263）—— 评测驱动的技能进化，**有 DSH 插件**

这不是"agent 自己长技能"，是**给技能写测试然后按测试结果改技能**。

核心循环：
1. 加/改一个回归 case
2. 跑基线（改技能之前）
3. 按观察到的失败改技能
4. 重跑同一个 case，看 `result.json` 里的逐 case 状态
5. 把前后报告留作证据

> **"看 case 状态而不是看进程退出码"**——这是区别"真改好了"和"跑完了"的关键。

支持 `rule_based` / `script` / `agent_judge` 三种判定策略，输出 Anthropic 兼容的 `grading.json` / `benchmark.json`，以及 JUnit XML 和 HTML 报告。多引擎：Qoder CLI、Claude Code、Codex、Qwen Code。

**`plugins/dsh-skill-up`（`@alibaba/dsh-skill-up`）** 是本机可用的 DSH 插件：

- 要求 **dsh 0.1.5-rc.2 或更新**（本机 0.2.1-rc.2 ✓），`skill-up` 在 PATH 上，`pnpm` 在 PATH 上
- **未发布到 npm**，只能从 checkout 打包或下 GitHub release 的 tgz
- 工具：`skill_up_validate`、`skill_up_run`（走 DSH 后台任务）、`skill_up_summary`、`skill_up_compare`
- 观察器（默认关）：只记录**显式调用的**或**通过 `skill` 工具成功加载的**技能，**绝不持久化推断出来的归因**
- 反馈采集：单技能回合完成后，**同一会话内 1 小时内的下一个用户回合**作为未分类的 follow-up 候选存起来——"捕获自然反馈，不需要用户知道 observation ID"
- 审查/批准流：`list_skill_observations`、`get_skill_observation`、`collect_skill_feedback`、`record_observation_feedback`、`link_observation_report`、`preview_observation_case`、`review_skill_observation`、`write_observation_case`
- **写入约束**：候选 case 写入需要**已批准的 observation**，**永不覆盖已有文件**，必须留在 workspace 内，`skill-up validate` 失败则回滚
- eval 参数**按 argv 数组传，不拼进 shell**；路径（含符号链接解析）限制在 workspace 内
- **不自己排期审查、不自己改技能**——需要外部调度器周期性发审查请求

> **这个插件的"观察器只记显式加载、写 case 需要批准、失败回滚"三条，是本次调研里工程严谨度最高的实现之一。** 但它做的是**改已有技能**，不是**从对话里造新技能**——所以它解决的是"技能质量"，不是"技能从哪来"。

### `MemTensor/skills-vote`（★305）—— 生命周期治理 + 归因

有 arXiv 论文（2605.18401）。发现了 **168 万个 `SKILL.md`**，其中 **79 万个**通过了 Anthropic 官方校验器。

它把技能当**受生命周期管理的制品**，四个环节连成一个环：
1. **收集与画像**（运行时依赖、质量、可验证性）
2. **任务前推荐**（不是加载一大坨静态列表，而是按需路由）
3. **任务后归因**（用轨迹、技能使用记录、验证器信号判断技能到底有没有起作用）
4. **演进**（基于有证据的归因去更新或新建技能）

> **第 3 步"归因"是整个调研里唯一正面回答"这个技能到底帮到我了吗"的实现。** 我在 02 文档里提的 F5.4 就指向这个，但 skills-vote 已经做成了方法论 + 论文。

现状：托管的 `skills-vote` 技能已发布；本地推荐 `skills-vote-local` 已发布；**本地归因与演进还在 roadmap 上没做完**。

### `NousResearch/hermes-agent-self-evolution`（★5540）—— DSPy + GEPA 进化技能

用 DSPy + GEPA（Genetic-Pareto Prompt Evolution）**进化技能文件、工具描述、系统提示词和代码**。不需要 GPU，全靠 API 调用，**每次优化运行约 $2–10**。

读执行轨迹来理解**为什么**失败（不只是失败了这个事实），然后提出针对性改动。

**五道护栏**（每个变体都必须过）：
1. 完整测试套件 100% 通过
2. 尺寸限制——技能 ≤15KB，工具描述 ≤500 字符
3. 缓存兼容——不允许对话中途变更
4. 语义保真——不得偏离原用途
5. **PR 审查——所有改动走人工审查，绝不直接 commit**

> 注意第 3 条"不允许对话中途变更"——**又一次独立印证了冻结快照 / 保护 prefix cache 这条原则**。三个完全不同的项目都撞上了同一条约束。

现状：Phase 1（技能文件）已实现；Phase 2-5（工具描述、系统提示词、工具实现代码、持续循环）均 **Planned**。

### 其他

- **`Q00/ouroboros`**（★6256）—— "Agent OS: the agent gets smarter on its own. We just hold the line: **Interview-gated, staged evaluation, budget...**"。门槛设计是 interview-gated（面谈式把关）。
- **`beita6969/ScienceClaw`**（★1018）—— "Verifiable program-level self-evolution"，技能和类型化 Operator 从 replay 中生长。可验证性是卖点。
- **`EvoMap/evolver`**（★8690）—— "Auditable evolution with Genes, Capsules, and Events"，可审计。
- **`Romanescu11/hermes-skill-factory`**（★556）—— 第三方的 Hermes 元技能。看你的工作流，检测模式，**在合适的时机问你**：

  ```
  🏭 SKILL FACTORY — New Skill Detected
  Proposed Skill:   python-env-setup
  Category:         software-development
  Generate: [A] SKILL.md  [B] plugin.py  [C] Both  [D] Skip
  ```

  这正是"**提炼完给人挑**"的形态，而且它会**同时生成 SKILL.md 和可执行的 plugin.py**（后者把技能变成 slash 命令）。

  > 注意它是**第三方技能**，不是 Hermes 官方实现——而且从 README 看它主要靠 `SKILL.md` 里的指令教模型"怎么观察和提议"，不是宿主级 hook。**这种做法的可靠性取决于模型是否照做。**

---

## 四、修正 01 文档的两处判断

### 修正一：淘汰机制不是空白

**原判断**（01 文档 §5）："淘汰（遗忘）几乎全员缺失。只有 Qoder 写了'建议过期要重新生成'、distill-kura 有证据门、ReMe 按日整理。**没有人解决'技能库长到 50 条以后怎么办'**。"

**修正**：**Hermes 的 Curator 完整解决了**——使用计数、active→stale→archived 三态、14/30 天阈值、pin 保护、cron 引用保护、零使用宽限期、审计账本、单条撤销、整树快照回滚。

所以 §6 里"**真正的差异化不在提炼，在淘汰**"、以及 02 文档里"**F4.4 + F5 是差异化点**"要改成：

- **淘汰机制有成熟参照了**，不再是无人的空白。自研的 F5 可以做，但**不再是首创，而是"在 DSH 上复刻 Hermes 的 curator"**。
- **仍然稀缺的只有两件**：
  1. **分级采纳**（F4.4）—— Hermes 是全审 / 全不审的二元开关，没有"低风险自动采纳、高风险人审"
  2. **归因**（F5.4）—— 只有 skills-vote 在做，且本地版还没做完。Hermes 有 `use_count` 但不判断"有没有用"

### 修正二：A 和 B 的实现水准被低估了

**原判断**（01 文档 §5）："A 和 B 不稀缺。十一个方案里十个都能做 A，七个能落 B。"

这个"不稀缺"是数量判断，但**质量差距极大**。Hermes 的实现里至少五条是其他方案没有的：

1. **"记教训不记流水账"** 的明确内容规范（事件叙述、PR 号、日期、引用聊天一律不进技能）
2. **每个 action 独立文本槽位** 的 schema 设计，跨槽位携带参数在批次应用前被拒
3. **后台 review 跑在独立 prompt cache 的 fork 上**，不碰活跃对话
4. **暂存的写入重启不丢**
5. **失败和被纠正比成功更值得沉淀**——系统提示词里明写

---

## 五、对"要不要自研"的影响

### 结论变化

| | 原结论 | 修正后 |
|---|---|---|
| A+B 有没有现成方案 | "有，但都是旧的/有硬伤" | **Hermes 是完整标杆实现**；DSH 上 `dsh-memory-evolve` 仍是可用参照 |
| 淘汰是不是差异化 | "是，全员缺失" | **不是首创，但 DSH 上没有**——复刻 Hermes curator 仍有价值 |
| C 外部检索是不是空白 | "DSH 上是真空" | **不变**。Hermes 有完整 Skills Hub，DSH 上仍缺模型可调用的版本 |
| 该不该自研 | "只做 A+B 不值得" | **不变，且更强**——因为标杆实现已经很清楚，自研就是"抄"，抄得比 memory-evolve 干净而已 |

### 新的建议：按 Hermes 的设计清单做，而不是从零想

如果要做，**不要重新设计**。照这张清单实现，每一项都有现成参照：

| 优先级 | 功能 | 参照 |
|---|---|---|
| P0 | `skill_manage` 六 action + 独立文本槽位 | Hermes §2.1 |
| P0 | "记教训不记流水账"的写入规范 | Hermes §2.3 |
| P0 | 暂存 + 批准/拒绝（`pending/` + approve/reject） | Hermes §2.5 |
| P0 | 冻结快照注入（**绝不注入会变的内容**） | Hermes §2.7 |
| P1 | 使用计数 + active→stale→archived | Hermes Curator §2.6 |
| P1 | 审计账本 + 单条撤销 | Hermes §2.6 |
| P1 | 模型可调用的外部检索（**DSH 上仍缺**） | Hermes Skills Hub §2.9 |
| P2 | 归因（这个技能帮到我了吗） | skills-vote §3 |
| P2 | LLM 整合成伞技能 | Hermes `consolidate` |

### 一个新增的判断

**Hermes 的"按不活跃触发 + 首跑延迟一整个周期"值得单独学。** 它和两个 forge "装完立刻开始写"形成鲜明对比。自动维护类功能的第一原则应该是**先证明不破坏，再证明有用**。

---

## 六、调研方法上的教训

这次漏掉 Hermes，原因是**搜索策略单一**：只按 `dsh` 关键词搜 DSH 生态，而技能自进化在主流 agent 框架里是宿主特性，不带 `dsh` 前缀。

**教训**：调研"某能力有没有人做"时，不能只搜**目标平台的生态**，必须先搜**通用领域**（这里是 `skill evolution` / `self-evolving agent`），再回到平台找移植。否则会得出"只有商业产品有"的错误印象，而实际上开源标杆就在那儿。

同时这轮还暴露一个问题：**GitHub API 按 stars 排序只给了头部**。Hermes（256k）、`ouroboros`(6256)、`hermes-agent-self-evolution`(5540) 都是靠换关键词（`hermes-agent`、`skill+evolution+agent`、`self-evolving+agent`）才捞出来的，单次搜索捞不全。
