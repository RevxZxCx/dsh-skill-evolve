# 09 · Qoder 产出文件机制逆向

本文是**只读逆向分析**，不是设计文档，也不是改造方案。它回答一个问题：

> Qoder 0.5.7 把一个会话产出的文件，从「记录」到「展示」再到「打开」，中间经过了哪些层、每层各有哪些字段和状态？

改造方案、以及哪些值得抄、哪些不该抄，见后续的 `10`（本文件不含任何建议动作）。

## 结论摘要

| 问题 | 答案 |
| --- | --- |
| 产出是一张独立卡片吗 | **不是。** 它是「任务监控 / Task Monitor」面板里的一个分组（`kind: "artifact"`），和「网页查阅」「技能与 MCP」「来源」「记忆」并列 |
| 会话末尾还有别的地方展示产出吗 | **有。** 助手每轮回复末尾另有一张「本轮产物」卡，是**另一套组件、另一个折叠阈值** |
| 产出的最小单位是什么 | 一条 highlight：`{ id, kind, origin, label, detail, target, messageId, toolUseId, evidenceId, turnId, timestamp }` |
| 去重靠什么 | `target` 的规范化字符串，不是文件名 |
| 文件「还在不在」怎么知道 | 独立的 `artifactFileStatusService`，四态 `checking / available / missing / invalid`，有合批、有并发上限、有文件变更订阅 |
| 文件「长什么样」怎么知道 | 独立的预览通道，返回 discriminated union：`thumbnail / document / spreadsheet / unavailable(reason) / idle / loading / failed` |
| 打开有几种去向 | **六种**：右侧栏、新窗口、内置浏览器、系统浏览器、默认应用、计划文件 |
| 主进程能逆到吗 | **部分。** 渲染层的协议面完整可读；主进程被压缩改名，只能确认服务存在与字段形状，拿不到实现细节 |

## 逆向对象与方法

### 版本与来源

| 项 | 值 |
| --- | --- |
| 产品 | Qoder |
| 版本 | `0.5.7` |
| commit | `73fe8d7343fbbbc3fb5ec665489082f6e4db0128` |
| Electron | `43.8.4` |
| buildNumber | `87859891` |
| buildTime | `2026-11-09T09:38:16.136Z` |
| 平台 | win32 x64 |
| 安装位置 | `F:\Qoder`（由 `%LOCALAPPDATA%\Qoder\Qoder Launcher\state.system.ini` 的 `installDir` 定位） |

### 怎么读到的

`resources/app.asar`（192 MB）按 asar 容器格式解包，不涉及解密：

1. 读文件头 16 字节，其中 `[12:16]` 是头部 JSON 的字节长度（小端 uint32）
2. `base = 16 + headerSize`，再按 4 字节对齐得到数据区起点
3. 头部 JSON 里每个条目带 `{ offset, size }`，`seek(base + offset)` 即得

抽出的关键产物：

| 文件 | 大小 | 内容 |
| --- | --- | --- |
| `out/renderer/assets/gtdG4YpP.js` | 16,067,876 B | 主渲染 bundle：全部 i18n 字典、任务监控面板、产出卡、预览渲染器 |
| `out/renderer/assets/BkeoGa4m.js` | 1,908,130 B | 多语言文案表（zh-CN / zh-HK / en / ko-KR 等） |
| `out/renderer/assets/DrWB3G97.js` | 7,281 B | `DiscussionSourcePreview` 弹窗，唯一独立成块的预览组件 |
| `out/main/electronMain.js` | 21,057,490 B | 主进程 bundle |

**读得懂的部分**：字符串字面量、i18n key、DOM 属性、React 组件结构、状态机分支、常量阈值。
**读不懂的部分**：函数名与变量名被压缩成 `t(63705)` / `v1` / `Hp0` 这类，且**没有 sourcemap**（`sourceMappingURL` 命中数为 0）。因此本文描述的组件名（`ha2`、`ma2`、`Tw0`、`xo1`）是**我在解包文件里的偏移与函数边界上给它们起的代号**，不是 Qoder 内部真实名字。

### 边界与风险

- 本文是**行为规格**，不是可移植源码。按它重写是干净的；把它的代码直接搬进本项目则有著作权问题（Qoder 是商业闭源产品）。
- 主进程侧只做到「确认存在 + 字段形状」这一层。渲染层调的 `client.readArtifactStatusPath` / `client.readArtifactPreviewPath` 在主进程 bundle 里命中数为 0，是压缩改名所致，不能据此认定它们不存在。
- 少数结论依赖单点推断（例如按 `qv1=7` 判定卡片阈值），文中已逐条标注依据。

## 第一层：任务监控面板

### 分组枚举

产出不是全局唯一的展示位。它和另外四类内容共享一个叫「任务监控」的面板：

| `kind` | 中文标题 | 空态文案 |
| --- | --- | --- |
| `artifact` | 产出 | 暂无产出数据 :) |
| `browser` | 网页查阅 | 暂无网页查阅数据 :) |
| `runtime` | 技能与 MCP | 暂无技能与 MCP 数据 :) |
| `source` | 来源 | 暂无来源数据 :) |
| `memory` | 记忆 | 暂无记忆数据 :) |

i18n 前缀分别是 `chatSession.highlights.group.*` 与 `chatSession.highlights.emptyGroup.*`。面板本身：标题「任务监控」（`chatSession.highlights.title`），动作有「打开任务监控」「固定任务监控」「切换为 Floating 模式」。

### 分组过滤的两个不对称

面板的分组装配（`gtd.js` 偏移约 5,041,056，组件代号 `Tw0`）有一处**刻意的非对称**：

```js
b1 = ["runtime", "artifact", "browser", "source"]
  .filter((k) => sectionVisibility[k])
  .map((kind) => ({ kind, items: v1.filter((i) => i.kind === kind) }))
  .filter((g) =>
    g.items.length > 0 ||
    g.kind === "artifact" ||
    g.kind === "source" ||
    (g.kind === "runtime" && showSuggestion)
  )
```

`artifact` 与 `source` 即使**一条都没有也照常渲染**（显示空态文案），`browser` 与 `memory` 则完全没有条目时整组消失。`memory` 更进一步，走一条独立的 `E1 = v1.filter(i => i.kind === "memory")`，且仅在 `E1.length > 0 && sectionVisibility.memory` 时才渲染。

**这条不对称可以读出设计意图**：产出与来源是「我该看但可能没有」的类型，空态本身就是信息（说明这一轮确实没有产出，不是面板坏了）；网页查阅是「有才看」，空组只是噪音。

组内折叠阈值 `$l1 = 4`，展开按钮文案 `showMore: "查看更多（{{count}}）"` / `showLess: "收起"`。

## 第二层：产出条目（highlight）

### 数据模型

一条产出条目的字段全集：

```js
{
  id: string,
  kind: "artifact" | "browser" | "runtime" | "source" | "memory",
  origin: "automatic" | "manual",
  label: string,
  detail: string,          // 仅 browser / runtime 使用，作为次要文字
  target: {                // 判别的核心，见下
    type: "file" | "url" | "message" | "evidence",
    path?: string,
    entryKind?: "file" | "directory",
    url?: string,
    messageId?: string,
    evidenceId?: string
  },
  messageId: string,
  toolUseId: string,
  evidenceId: string,
  turnId: string,
  specArtifact: unknown,   // 计划文件专用
  planPreview: unknown,    // 计划文件专用，见下
  timestamp: number
}
```

`kind` 与 `target.type` 是**两个正交的维度**：`kind` 说的是「这条属于哪个分区」，`target.type` 说的是「点它会打开什么」。所以 `kind: "artifact"` 的条目，`target.type` 可以是 `file` 也可以是 `url`（例如产物是个网页）。

`origin` 区分自动与手动：手动加入的条（用户自己钉的）在行尾悬停时出现移除按钮（`chatSession.highlights.removeSource`），自动的不给删。

### 去重键

去重函数（代号 `Ul1`）按 `target` 生成键，而不是按文件名：

```js
file:${target.path.replace(/\\/gu, "/")}
url:${target.url}
message:${target.messageId}
evidence:${target.evidenceId}
```

反斜杠统一成正斜杠再比较，因此 `F:\a\b` 与 `F:/a/b` 是同一条。

合并（代号 `Rx0`）先并入侧边会话（side chat）的产出，再用上述键去重。**先合并后去重**意味着同名文件在两个会话里出现时只留一条。

### 行渲染

- 高度 `min-h-7`，字号 `[12px]` / 行高 `[16px]`，hover 背景 `bg-fill-tertiary`
- `kind === "browser" || kind === "runtime"` 时，`label` 之后追加 `detail` 作次要文字
- **存活状态优先**：`useArtifactFileStatus(...) === "missing"` 时，标题加 `line-through` + `text-text-tertiary` + `cursor-default` + tooltip「文件已被删除或移动」；只有非 missing 才挂点击（`b = !!onOpen && !u`）

### 图标选择

按 `kind` 与 `target.type` 两级判定：

1. `kind === "runtime"`：`detail === "skill"` 用 skill 图标，否则用 runtime 图标
2. 否则看 `target.type`：
   - `url` → favicon（`getFaviconUrl` 失败降级 `getGoogleFaviconUrl`，再失败用地球图标）
   - `file` 且 `entryKind === "directory"` → 文件夹图标
   - `file` → 按扩展名的文件图标
   - 其他 → 通用图标

**favicon 的两级降级**值得单独记一笔：站点自己声明的 icon 拿不到时退到 Google 的 favicon 服务，再拿不到才用通用地球。这是「宁可显示一个可能过期的真图标，也不要显示一个抽象的通用图标」的取舍。

## 第三层：文件存活状态

### 这是一个独立服务

产出条目的标题要不要加删除线，不取决于记录时刻的状态，而取决于**此刻**的状态。这部分被抽成了独立服务（代号 `t$`）：

```js
observe(sessionId, path) -> { observable, dispose }
```

同一 `path` 的多个消费者共享一个 entry（`entry.consumers`），引用计数到 0 才释放。

### 四态

| 值 | 含义 |
| --- | --- |
| `checking` | 请求在途，还没有答案 |
| `available` | 读到了 |
| `missing` | 明确读不到（删除或移动） |
| `invalid` | 读到了但不合法 |

hook（代号 `MN1`）在拿不到服务时**回退到 `available`**，即「不知道就当它还在」——失败模式偏向「不误标删除」，而不是「不误显示可用」。

### 调度细节

- 改动用 `generation` 计数 + `queued` 集合 + 80ms 定时器合批
- **最多 4 个并发读**（`activeReads >= 4` 时 break）
- 订阅 `client.onWorkspaceFileChanged`，按文件名建索引，命中才 `invalidate`
- window focus 时**全量** invalidate

80ms 与并发 4 都是为了不让一个装着两百个文件的会话在渲染时把 IPC 打满。focus 全量 invalidate 则是因为文件可能在别的进程里被改动，切出去再回来是最便宜的重新对齐时机。

## 第四层：本轮产物卡

### 与面板是两个组件

会话末尾那张「本轮产物」卡（代号 `ha2`）和面板的产出分组**不是同一份代码**。最直接的证据是折叠阈值不同：

| 位置 | 常量 | 依据 |
| --- | --- | --- |
| 面板分组 | `$l1 = 4` | `gtd.js` 中 `$l1=\d` 匹配为 4 |
| 轮次卡 | `qv1 = 7` | `gtd.js` 偏移 11,157,797：`const Do = [[]], qv1 = 7;` |

轮次卡的渲染条件：每次助手回复末尾，`(!s1 || E) && ie.length > 0`。

### props

```js
ha2({
  sessionId, files, labels,
  onOpenFile, onPreviewFile, onRevealFile,
  onReadArtifactPreview, onOpenHtmlInBuiltInBrowser,
  onOpenInNewWindow, onOpenSpecArtifact,
  remoteExecution,          // executionTarget !== "local" || sideChat
  sessionFileAccessEnabled  // !sideChat && executionTarget !== "ssh" && !== "wsl"
})
```

两个布尔量把「远程执行」与「能不能碰本地文件系统」拆开了。SSH 与 WSL 目标下 `sessionFileAccessEnabled` 为 false，但 `remoteExecution` 仍可能是 false——两者不是同一个开关。

### 结构

- 外层 `section.mx-2`，`aria-label = labels.ariaLabel`（「本轮产物」）
- `p = files.length > 7`；折叠时 `files.slice(0, 7)`，隐藏数为 `files.length - visible.length`
- 展开按钮：`prefixIcon` 是个带 `rotate-180` 过渡的箭头，`aria-expanded`，文案 `showLess` / `showMore(count)`（「显示其余 N 个文件」/「收起文件」）
- DOM 标记：`data-chat-turn-output-files`、`data-chat-output-files-disclosure`

## 第五层：单个文件芯片

这是整套机制里最密的一层。一个芯片要同时决定：能不能点、点去哪、有没有别的打开方式、要不要查存活、要不要悬停预览。

### 判定顺序

```
N  = status === "missing"                       // 已删除
B  = !N && (!remote || !!canReadLocally)        // 可点击
A  = /\\.(?:pdf|pptx?|docx?|xlsx?)$/iu (filename)  // office / pdf
V  = kind !== "spec" && videoMime(filename)     // 视频
E  = !isSpecCard && (isPreviewable(file, remote) || V)  // 要不要订阅存活
```

即 **missing 一票否决点击**，而存活状态的订阅范围比点击范围更宽（`E` 不要求 `B`）。

### 悬停预览的五重条件

```js
vo1(absolutePath, enabled, loader)
// enabled = A && hovered && status !== "missing" && sessionFileAccessEnabled
//           && settings.previewer.hoverPreview !== "disabled"
// 返回 { status: "idle" | "loading" | "ready" | "failed", preview }
```

五个条件必须同时成立：**是 office/pdf、卡片正被悬停、文件未删除、能访问本地文件、设置里没关掉悬停预览**。缺一个就不发请求。这是「贵操作必须由明确的用户意图触发」的写法。

### 打开方式：六个去向

| mode | 文案 | 可用条件 |
| --- | --- | --- |
| `workspace` | 在右侧栏查看 | 总是 |
| `newWindow` | 新窗口查看 | 有 `artifactPreviewResourceClient` |
| `builtInBrowser` | 内置浏览器 | **仅 html**，且宿主有内置浏览器 |
| `systemBrowser` | 系统浏览器 | html 时**取代** `systemApplication` |
| `systemApplication` | 默认应用 | 非 html |
| spec | — | 计划文件走 `onOpenSpecArtifact` 这条独立路径 |

几点值得注意：

- 顺序来自设置 `assistantOutputFileOpenModeOrder`，用户可改
- **默认目标**（代号 `pa2`）：`default === "newWindow"` 取新窗口；否则 html 取内置浏览器；否则取右侧栏
- **按文件记忆**：`artifactFileOpenModes` 存在宿主配置里，键是文件路径。同一个 `.html` 上次选了新窗口，下次它默认就是新窗口。这解决了「枚举列表本身不会记住你的偏好」的问题
- **远程执行时收窄**：除 `workspace` / `newWindow` 外全部过滤掉；`builtInBrowser` 是有条件的例外（宿主有内置浏览器就保留）

### 点击分发

```js
Ca2(mode, { path, htmlOutput, ... }) {
  newWindow       -> onOpenInNewWindow()
  builtInBrowser  -> 仅 html 才走，否则忽略
  workspace       -> onPreviewFile(path).then(ok => { ok === false && onOpenFile(path) })
  otherwise       -> onOpenFile(path)
}
```

`workspace` 那条有个**降级**：侧栏预览失败（返回 `false`）时退回 `onOpenFile`。这是「预览是增强，不是唯一路径」的写法。

### 溢出菜单

`moreActions` 按钮展开，菜单项依次为：

1. 其余打开方式（`da2` / `oa2` / `na2`）
2. 分隔线
3. 「在文件管理器中显示」（`revealFile`）
4. 「复制绝对路径」(`copyAbsolutePath`)
5. 「复制相对路径」(`copyRelativePath`)

复制失败用 toast 报 `copyPathFailed`（「复制路径失败」）。**远程执行时整块不渲染**（`localFileActions === false`）——因为远程路径在本机没有意义。

### 计划文件卡

`kind === "spec"` 的产物走另一套渲染（代号 `X92`）：`h-44 w-[200px]` 的卡片，`role="button"`（且仅在有 `onOpenSpecArtifact` 时），`planPreview.lines.slice(0, 4)` 作预览，标题缺失时回退到 `filename`。已删除态：边框 `border-border-error/50`、`opacity-60`、标题 `line-through`、tooltip 用 `deletedTooltip`。

## 第六层：预览

### 预览弹窗

`DiscussionSourcePreview`（`DrWB3G97.js`，组件代号 `oe`）是一个**同时服务文件与网页**的弹窗：

- 视图模式 `useState("preview")`，可在 `preview` / `source` 间切换
- 尺寸 `h-[min(640px,80vh)]`
- 内容优先序：`imageDataUrl` → `artifactPreview` → `url` → 纯文本 / `body`
- 类型标签：`url ? "WEB" : ext.toUpperCase()`

**只有两种内容配得到视图切换器**：markdown，以及 `artifactPreview.kind === "html"`。其余内容要么没有「源码」可言（图片），要么源码没有意义（表格）。

### 状态机

| 条件 | 态 |
| --- | --- |
| `url` 存在但 `!validUrl` | `error`（`discussion.sidebar.invalidSourceUrl`） |
| `!url && canPreview === false` | `unsupported`（`discussion.sidebar.noPreview`） |
| 有内容 | `ready` |
| 其余 | `empty`（同 `noPreview`） |

```js
canPreview = fileContent && !imageDataUrl && !artifactPreview
             && ext !== "markdown" && ext !== "text"
```

`url` 校验要求 http/https 且**不含 user/password**——`https://user:pass@host/` 这种带凭据的 URL 被显式拒绝，避免把凭据渲染进 iframe。

### 网页源的降级链

`url` 类型的源有三层：

1. `prepare` 一个浏览器会话 → `availability !== "unsupported"` 就 `navigate` 进去
2. `availability === "unsupported"` 时尝试 **Figma embed**：要求 https、无端口、无凭据、hostname ∈ `{www.figma.com, figma.com, embed.figma.com}`，且 pathname 匹配 `^/(?:community/file|design|file|proto|board|slides|deck)/[^/]+(/|$)`；`.figma.site` 域名直接用，否则改写 host 为 `embed.figma.com` 并附 `embed-host=qoder`
3. 都不行则退成静态浏览器表面：reload 按钮 + 提示 + 外链，`allowFullScreen` iframe

第 2 层的 hostname 白名单和 pathname 正则都是**硬编码的具体站点**，说明这是为一个已知合作方写的特例，不是通用机制。这点不值得学。

### HTML 预览的消毒

这是整套机制里安全要求最高的一段：

```js
DOMPurify.sanitize(html, {
  WHOLE_DOCUMENT: true,
  ALLOW_DATA_ATTR: false,
  SANITIZE_DOM: true,
  SANITIZE_NAMED_PROPS: true,
  KEEP_CONTENT: true,
  FORBID_TAGS: [applet, base, embed, form, frame, frameset, iframe, input,
                link, meta, object, portal, script, select, textarea],
  FORBID_ATTR: [action, background, cite, codebase, data, formaction, href,
                ping, poster, srcdoc, srcset, usemap, xlink:href]
})
```

消毒之后还有两步：

1. 删除所有不匹配 `data:image/(png|jpeg|webp|gif);base64,` 的 `src`
2. 注入 CSP meta：
   ```
   default-src 'none'; script-src 'none'; style-src 'unsafe-inline';
   img-src data:; font-src 'none'; media-src 'none'; connect-src 'none';
   object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none';
   manifest-src 'none'; base-uri 'none'; form-action 'none'
   ```
   外层 iframe 用 `sandbox=""`（**空字符串，即全部禁用**）+ `referrerPolicy="no-referrer"`

`style-src 'unsafe-inline'` 是唯一放宽的一处——不放开的话几乎任何真实 HTML 产物都会失去样式，看起来像坏了。`img-src data:` 说明图片必须内联，不允许外链（外链=外泄）。

### 四态渲染器

预览内容本身是 discriminated union（代号 `xo1({ state, compact })`）：

| `status` / `kind` | 渲染 |
| --- | --- |
| `idle` | `null` |
| `loading` | 骨架屏（`previewLoading`「正在加载文件预览…」） |
| `failed` | `previewInvalid`「暂时无法读取文件预览。」 |
| `preview.kind === "unavailable"` | 按 `reason` 取 `previewUnavailable.${reason}` |
| `thumbnail` | 图片 |
| `document` | 段落数组 + 截断提示 |
| 其余 | spreadsheet：粘性表头「工作表：{{name}}」+ `min-w-full border-collapse text-[11px]` 表格 + 截断提示 |

`unavailable` 的 `reason` 五值：

| reason | 文案 |
| --- | --- |
| `empty` | 文件没有可预览内容。 |
| `invalid` | 文件已损坏或暂时无法读取。 |
| `missing` | 文件已被删除或移动。 |
| `tooLarge` | 文件过大，暂不支持内容预览。 |
| `unsupported` | 当前系统暂不支持该文件的缩略预览。 |

这五条把「为什么没内容」拆开了：空文件、坏了、没了、太大、不支持——每一种都对应不同的用户动作（换文件 / 修复 / 重新生成 / 用别的工具 / 换系统）。**合并成一句「无法预览」会抹掉这个区分。**

### 空图检测

缩略图可能是一张全透明的图，肉眼看到的是空白，但技术上「有图」。Qoder 用 32×32 采样来判：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `Bv1` | 32 | 采样边长 |
| `K92` | 16 | alpha 阈值，低于此的像素跳过 |
| `iW` | 8 | 通道极差阈值，任一通道极差 ≥ 8 才算「非空」 |

判定为空白后**回退到 document 预览**；document 也没有，才显示「文件没有可预览内容。」

### 打标

预览区带 `data-artifact-preview-kind`（`thumbnail` / `document` / `spreadsheet` / `unavailable`）与 `data-artifact-preview-reason`。这两个属性是给自动化测试与样式钩子用的，也是逆向时定位渲染分支最可靠的锚点。

## 第七层：宿主侧

### 渲染层调用的 API

| 调用 | 用途 |
| --- | --- |
| `client.readArtifactStatusPath(path, sessionId)` | 查存活状态 |
| `client.readArtifactPreviewPath(path, sessionId)` | 取预览数据 |

### 主进程侧能确认的

主进程 bundle 里**没有**这两个名字（命中数 0），但能确认这些服务存在：

- `artifactPreviewService`
- `filePreviewService`
- `videoPreviewService`
- `artifactResolver`
- `artifactProjection`（服务表里与 `remoteControlArtifactService` 并列）

字段形状方面，按出现次数排序的可见字段：

| 字段 | 命中 | 读到的形状 |
| --- | --- | --- |
| `artifacts` | 113 | 会话快照的一个键：`{ session, messages, artifacts, artifactsUnavailable, highlights, ... }`，另有一条 `onArtifactsChanged` 订阅 |
| `artifact` | 113 | 多义：既是产出物，也是「崩溃转储产物」「发布包产物」——**同一个词在三种语境里用**，逆向时必须按上下文区分 |
| `artifactRevision` | 2 | 与 `expiredAtEpochMs`、`cleanupFailureCode`、`artifactCount` 同处一个 side chat 快照 |
| `artifactHash` | 8 | 与 `declarationHash`、`credentialVersion` 一起被 schema 校验，是**整包校验**用途，不是单文件 |
| `artifactPreview` | 2 | 预览数据 |

主进程里有一段造产出物的代码（偏移约 14,000,000 附近）：

```js
const b = <revision前缀> + <hash>(n) + ""
const i = {
  artifactId: <id前缀> + <hash>(path + "\0" + size) + "",
  artifactRevision: b,
  resourceHandle: <id>(),
  format: conf[<...>],
  displayName: name,
  byteLength: n[size]
}
```

**`artifactId` 由 `path + "\0" + size` 哈希得出**，即它是**内容身份**而非路径身份——同一路径内容变了就是另一个 artifact。这解释了为什么渲染层可以拿它做缓存键。

### 宿主把产出物交给云端的路径

另一段（偏移约 13,700,000）显示，产出物会被作为附件上传：

```js
return PG({
  type: ...,
  session_id: sessionId,
  uuid: e,
  artifacts: artifacts.map((c) => ({
    path: c[path],
    ...(c[artifactId] ? { artifact_id: c[artifactId] } : {}),
    display_path: c[displayPath],
    name: c[name],
    size: c[size],
    ...
  }))
})
```

即 Qoder 的「产出」不只是本地视图，还会被投影到远端（there is a `remoteControlArtifactService`）。**这是它与本项目最根本的差异**：它的产出物有服务端身份，所以能跨设备、能被云端任务消费；本项目的产出只是本地一份路径清单。

## 与本项目现状的对照

本项目（`dsh-skill-evolve` v0.2.0，`packages/ui-evolve`）的产出卡当前实现：

| 位置 | 现状 |
| --- | --- |
| `packages/ui-evolve/lib/session-state.js:120` | `const paths = new Map()`，只存「路径 → 序号」 |
| `session-state.js:133-137` | 载入时按 `MAX_PATHS` 裁到最新 |
| `session-state.js:607` | `rememberPaths(sessionId, paths)`，`delete` + `set(++sequence)` 保持最近在前 |
| `session-state.js:660` | `pathsSeen(sessionId)` 返回倒序路径数组 |
| `packages/ui-evolve/lib/api.js:387` | `resourceAddress()` 生成 `dsh-resource://file/session/<id>/<relative>` |
| `api.js:423` | `statTouchedFiles()` 对每个候选 `stat`，不存在的**静默丢弃** |
| `client.js:65` | `const FOLDED_FILES = 4` |
| `client.js:2074-2101` | 三组：`fresh` / `earlier` / `noise`，折叠只画 `fresh.concat(earlier).slice(0, 4)` |
| `client.js:2421-2491` | 卡片渲染，行是 `button`（可预览时）或 `div` |

### 差距矩阵

| 维度 | Qoder | 本项目 | 差在哪 |
| --- | --- | --- | --- |
| 数据单位 | highlight（含 kind / origin / target / turnId / timestamp） | 路径字符串 | 没有类型、没有来源、没有轮次归属 |
| 版本与哈希 | `artifactRevision` / `artifactHash` / `artifactId`（内容身份） | 无 | 无法判断「这个文件还是上次那个吗」 |
| 存活状态 | 四态服务，合批 + 并发上限 + 变更订阅 | `stat` 时不存在就静默丢弃 | 删除后**直接消失**，用户看不到「它曾经在、现在没了」 |
| 分组维度 | 按 `kind` 分五个区，产出与来源强制常驻 | 按 `fresh` / `earlier` / `noise` 分三组 | 维度不同：Qoder 按内容类型，本项目按时间与噪声 |
| 折叠阈值 | 面板 4 / 轮次卡 7 | 4（对齐了面板） | 轮次卡那一层完全没有 |
| 打开去向 | 六种，可按文件记忆 | 一种（`openResource` 进侧栏） | 没有新窗口、没有内置浏览器、没有默认应用 |
| 预览 | 完整弹窗 + 四态渲染 + 消毒 | 无（交给宿主侧栏） | 本项目把预览整个外包给了宿主 |
| 空与失败 | 五值 `reason`，五种文案 | 无 | 没有「为什么没有」的表达 |
| 云端身份 | 有（`artifact_id` 上传） | 无 | 本地视图，不跨设备 |

### 需要修正的一处既有判断

`docs/05-设计方案.md:1063` 记的是：

> 改造只对齐了 Qoder 的触发方式，没有对齐它的确认流程。

按本文的对照，这句话**低估了差距**。Qoder 的确认流程只是表象，真正的差异在**产出物本身有生命周期**：有版本、有哈希、有存活状态、有预览、有过期守卫、有云端身份。本项目的产出卡只有「改过哪些文件的清单」，没有「这个文件现在是什么状态」的表达。差距在数据模型层，不在交互层。

（`05` 按仓库规矩不改写，此处作为更正记录，一并指回原文。）

## 附录：i18n 文案清单

`chatActivity.outputFiles.*`：

| key | 中文 |
| --- | --- |
| `ariaLabel` | 本轮产物 |
| `showMore` | 显示其余 {{count}} 个文件 |
| `showLess` | 收起文件 |
| `openInNewWindow` | 新窗口查看 |
| `openInBuiltInBrowser` | 内置浏览器 |
| `openInSystemBrowser` | 系统浏览器 |
| `openInWorkspace` | 在右侧栏查看 |
| `openInSystemApplication` | 默认应用 |
| `planTypeLabel` | 计划文件 |
| `moreFileActions` | 更多文件操作 |
| `copyAbsolutePath` | 复制绝对路径 |
| `copyRelativePath` | 复制相对路径 |
| `copyPathFailed` | 复制路径失败 |
| `previewLoading` | 正在加载文件预览… |
| `previewInvalid` | 暂时无法读取文件预览。 |
| `thumbnailAlt` | 文件内容预览 |
| `sheetName` | 工作表：{{name}} |
| `previewTruncated` | 仅展示部分内容 |
| `previewUnavailable.empty` | 文件没有可预览内容。 |
| `previewUnavailable.invalid` | 文件已损坏或暂时无法读取。 |
| `previewUnavailable.missing` | 文件已被删除或移动。 |
| `previewUnavailable.tooLarge` | 文件过大，暂不支持内容预览。 |
| `previewUnavailable.unsupported` | 当前系统暂不支持该文件的缩略预览。 |

`chatSession.highlights.*`：`title`「任务监控」、`open`「打开任务监控」、`pin`「固定任务监控」、`switchToFloating`「切换为 Floating 模式」、`removeSource`（移除手动来源）、`group.*` 与 `emptyGroup.*` 见第一节。

## 附录：逆向时的可复现路径

解包脚本（Python，按 asar 格式）：

```python
import json, struct
path = r"F:\Qoder\resources\app.asar"
with open(path, "rb") as f:
    head = f.read(16)
    header_size = struct.unpack("<I", head[12:16])[0]
    header = json.loads(f.read(header_size).decode("utf-8"))
base = (16 + header_size + 3) // 4 * 4
# 遍历 header["files"]，读 (base + offset, size)
```

定位锚点（比函数名可靠，因为函数名被压缩）：

| 想找什么 | 搜什么 |
| --- | --- |
| 产出分组装配 | `kind==="artifact"`（渲染层 5 处，全在 `gtdG4YpP.js`） |
| 去重键 | `file:${` 附近，或 `replace(/\\/gu,"/")` |
| 存活四态 | `"checking"` 与 `"missing"` 同现处 |
| 预览四态 | `data-artifact-preview-kind` |
| 打开方式枚举 | `openInBuiltInBrowser` / `openInWorkspace` |
| 折叠阈值 | `qv1=7` / `$l1=4` |
| HTML 消毒 | `FORBID_TAGS` 或 `object-src 'none'` |

主进程侧则相反：**函数名全被压缩，只能搜字符串字面量与 IPC 通道名**。`readArtifactStatusPath` 在主进程里命中 0 即是此故。
