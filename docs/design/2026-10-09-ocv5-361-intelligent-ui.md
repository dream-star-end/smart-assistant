# OCV5-361 个人版 Intelligent UI 设计

- 工单：OCV5-361。分支 `feat/v5-selfhost-ocv5-361-intelligent-ui`，基线 `ed951c49d`。
- 范围：只改个人版（`feat/v5-selfhost`），不碰商业版 Aurora 树。
- 操作者原话：「我想在v5个人版搞Intelligent UI，提供开关选项」。追加：「用的克制那条去掉」「跟管理中心没关系」「你不要加限制」「让cc3自由发挥」。

## 0. 目标与非目标

**目标**
- 模型可以在回答里自由混排原生交互组件：表格、图表、指标、步骤清单、对比卡、选择、计算器、提示框、分段标签、时间线、后续建议。前端校验后渲染为 React 原生组件，并随流式输出逐步出现。
- 用户在「设置 → 偏好」里有一个开关。
  - 开：系统提示里带组件协议，模型自由使用。
  - 关：系统提示里完全没有这一段（零额外 token），已有的组件消息渲染成普通 Markdown。
- 服务端有总开关，可以一键关掉。
- 不限制模型怎么用：不设组件数量上限，也不写「只在必要时使用」。下文的上限（行数、序列数等）只是防止渲染失控的技术护栏，不约束模型的使用意愿。

**非目标**
- 不做任意 HTML 或 JS 生成 UI。已有 `htmlpreview` 沙盒和 `mermaid` 图保持原样，协议里会告诉模型可以用它们。
- 不改商业版，不改管理中心。

## 1. 现状（决定方案的事实）

| 事实 | 位置 |
|---|---|
| Markdown 渲染在懒加载的 `MarkdownImpl`，fenced code 按语言分派富块（`mermaid` / `chart` / `options` / `html(preview)`），`components` 已记忆化，流式期富块不会重挂载 | `web-react/src/components/MarkdownImpl.tsx`、`RichBlocks.tsx` |
| `options` 块已有「点选 → 以用户身份发消息」和同消息多题聚合 | `RichBlocks.tsx` `OptionsBlock` + `optionsGroup` |
| 所有引擎（CCB / Codex / Grok / Cursor / Zcode）的系统提示都由 `buildPromptContext` 组装。Grok/Cursor/Zcode 每轮重组；CCB、Codex 在 runner 启动时组装 | `gateway/src/promptSlots.ts` 及各 adapter |
| 容器 gateway 在组装时 GET master `/internal/v3/platform-prompt-slots`（容器身份双因子认证），按白名单合并 master 算出的 slot | `promptSlots.ts fetchPlatformSlotsFromMaster`、`commercial/src/http/internalPlatformPromptSlots.ts` |
| 用户偏好存在 PG `user_preferences.prefs`（JSONB），由 zod strict 白名单校验，经 `GET/PATCH /api/me/preferences` 读写 | `commercial/src/user/preferences.ts` |
| 会话 key 形如 `agent:<aid>:<channel>:...`，Web 对话的 channel 是 `webchat` | gateway 各处 |

## 2. 协议

模型输出一个语言标记为 `ui` 的 fenced 代码块，块内是**单个 JSON 对象**，`type` 字段决定组件：

````
```ui
{"type":"table","title":"三款笔记本对比","columns":["型号",{"label":"重量","unit":"kg","align":"right"}],"rows":[["A",1.2],["B",1.4]],"source":"各厂商官网规格页，2026-10"}
```
````

- 选 fenced JSON 而不是 MCP 工具：任何模型都能输出，不依赖工具调用；CCB / Codex / Grok / Cursor 都适用；流式输出时前端拿得到增量；历史、导出、搜索里也是可读文本。
- 一个块一个组件。块外的 Markdown 照常写。
- `v` 字段可选，缺省为 1，留作以后升级。
- 解析时宽容：接受首尾空白，接受 JSON 后面多余的文字（会忽略）。未知 `type`、JSON 不合法、校验失败都走 §5 的降级，绝不让消息崩溃。

### 2.1 组件与 schema（v1）

`text` 类字段支持行内 Markdown（加粗、行内码、链接），不支持原始 HTML。

| type | 字段 | 交互 |
|---|---|---|
| `table` | `title?` `columns: (string \| {label, unit?, align?:"left"\|"right"})[]`（1–12 列）`rows: (string\|number\|null)[][]`（≤200 行）`source?` `note?` | 点表头排序（数字按数值）。移动端横滑，首列固定 |
| `chart` | `kind: "bar"\|"line"\|"area"\|"pie"` `title?` `labels: string[]`（≤60）`series: {name, values: number[]}[]`（≤6；pie 只取 1 个）`unit?` `x_label?` `y_label?` `stacked?` `source?` `note?` | SVG 原生绘制。点或聚焦数据点显示数值。「数据」按钮切换成表格（无障碍和可核对） |
| `stats` | `items: {label, value: number\|string, unit?, delta?, tone?:"up"\|"down"\|"neutral", basis?}[]`（1–8）`source?` | `basis` 显示在数字下方（数字从哪来） |
| `steps` | `title?` `checkable?: boolean` `items: {title, detail?, done?}[]`（1–30） | `checkable` 时可勾选，显示「已完成 2 / 5」。勾选状态按消息 id 存在本机 |
| `compare` | `title?` `items: {name, tag?, summary?, points?: string[], pros?: string[], cons?: string[], recommended?: boolean}[]`（2–6）`verdict?` | 移动端纵向排列，桌面并排（≥3 项时横滑） |
| `choice` | `question?` `multi?` `options: (string \| {label, desc?})[]`（1–12） | 复用现有 `OptionsBlock` 的发送和聚合逻辑 |
| `calculator` | `title?` `inputs: {id, label, kind?:"number"\|"slider"\|"select"\|"toggle", value, min?, max?, step?, unit?, options?: {label, value:number}[]}[]`（1–12）`outputs: {id, label, formula, unit?, format?:"number"\|"integer"\|"currency"\|"percent", decimals?, primary?}[]`（1–12）`assumptions?: string[]` `note?` | 改任何输入，所有输出立即重算。「公式」展开显示每个输出的公式和代入值。输出之间可以引用（按拓扑序，环则报错） |
| `callout` | `tone: "info"\|"tip"\|"warning"\|"danger"\|"success"` `title?` `body` | — |
| `tabs` | `tabs: {label, body}[]`（2–8，body 为 Markdown） | 分段控件，方向键切换，`role=tablist` |
| `timeline` | `items: {time, title, detail?}[]`（1–30） | — |
| `suggestions` | `items: string[]`（1–6） | 消息末尾的一排轻量按钮，点一下直接发出该句。和消息操作行分开（有上间距，样式不同） |

另外两种沿用现有能力，协议里会提到：图示用 `mermaid`，可运行的小工具或小游戏用 `htmlpreview`（`sandbox="allow-scripts"`，无同源）。

### 2.2 计算器公式语言

- 自写 Pratt 解析器，**不用 `eval` 或 `Function`**。
- 语法：数字、标识符（输入或输出的 id）、`+ - * / % ^`、括号、比较运算（`< <= > >= == !=`）、`&& || !`、`cond ? a : b`。
- 函数：`min max round(x, d?) floor ceil abs sqrt pow log ln exp if(c, a, b) clamp(x, lo, hi) pmt(rate, n, pv)`。`pmt` 用于贷款或月供，这类场景很常见。
- 公式长度上限 500 字符，AST 深度上限 64。除零、NaN、Infinity 显示「—」并注明原因。
- 公式原文永远可以展开查看（应对「计算器看起来比实际可信」的批评）。

## 3. 前端渲染

- 新目录 `web-react/src/components/iui/`：
  - `parse.ts`：围栏提取、宽容 JSON、半截 JSON 补全。
  - `schema.ts`：手写校验器，web-react 不引 zod。输出规范化后的 spec 或错误列表。
  - `formula.ts`
  - `toMarkdown.ts`：每种组件转 Markdown 或纯文本。
  - `IuiBlock.tsx`：分派、错误边界、复制按钮。
  - 各组件一个文件。
  - `context.ts`：`IntelligentUiContext {enabled}`。
- `MarkdownImpl` 的 `code` 分派里新增 `lang === "ui"` → `<IuiBlock code live readOnly>`。
- **开关关闭时**：`MarkdownImpl` 在交给 ReactMarkdown 之前，用 `uiFencesToMarkdown()` 把整段里的 `ui` 围栏换成等价 Markdown（表格转 GFM 表格，图表转数据表，计算器转输入、公式和当前结果，以此类推）。所以关闭后看到的是真正的 Markdown，不是一段 JSON。
- **复制和导出**：
  - 消息「复制」和会话「导出 Markdown」都过一遍 `uiFencesToMarkdown()`。
  - 每个组件右上角有一个安静的「复制」图标，复制该组件的 Markdown。
- **流式**：
  - 围栏未闭合时（`live`），先用半截 JSON 补全器解析出当前能确定的部分。
  - `type` 已知且宽松校验通过，就用流式模式渲染：表格行、图表点、步骤逐条出现，交互禁用。否则显示与该类型最终外形接近的骨架（固定最小高度，同一个外壳），尽量不产生跳动。
  - 围栏闭合后切到严格校验和交互模式。
  - 组件挂在同一个 code 节点位置，ReactMarkdown 重解析不会让它重挂载（现有 `components` 已记忆化）。
- **视觉**：
  - 沿用现有 token（`bg-surface`、`border-border`、`text-muted`、`accent`）。
  - 1px 边框，`rounded-lg`，不用渐变、阴影或 emoji。
  - 正文字号与 prose 一致（不放大）；数字用 `tabular-nums`。
  - 移动端（390px）优先。明暗主题都只用 token，不写死颜色。图表配色用一组低饱和、在明暗两种底色上都可辨的色板。
- **可信度**：
  - `table`、`chart`、`stats` 的 `source` 和 `note` 显示在组件底部。
  - `stats.basis` 显示在数字下方，计算器公式可展开。
  - 图表永远能切到原始数据表。
- **无障碍**：
  - 排序表头是 `<button>` 并带 `aria-sort`；图表用 `role="img"` 加 `aria-label` 摘要，另有数据表。
  - 分段标签按 WAI-ARIA tabs 实现。
  - 可点击元素在触屏上至少 44px 高（`min-h-11`）；全部可以用键盘操作。

## 4. 开关与服务端

### 4.1 用户偏好

- `user_preferences.prefs.intelligent_ui: boolean`，加进 `PreferencesSchema` 和 `PreferencesPatchSchema`。
- 不需要迁移（JSONB）。
- **默认开**（键不存在就视为开）。理由：
  1. 操作者主动要这个功能，个人版的使用者就是操作者本人。
  2. 关闭只要一次点击，关闭后零 token 开销，也不留残余。
  3. 默认关等于功能没人能看见，也就验证不了。

### 4.2 服务端总开关

- master env `OC_INTELLIGENT_UI`：缺省或 `1` 为启用；`0`、`off`、`false` 为禁用。
- 禁用时：
  1. platform-prompt-slots 不返回 `INTELLIGENT_UI`；
  2. `GET /api/me/preferences` 的响应带 `features: { intelligent_ui: false }`，前端把开关显示为「已由服务端关闭」且不可切换，渲染按关闭处理。
- 生效：改 env 并重启 master 服务。selfhost 的 master 是单进程，重启约 10 秒，属于运维动作，写进交接文件。

### 4.3 提示词 slot（模型无关）

- master 在 `internalPlatformPromptSlots` 里，用容器身份推出 uid，读这个用户的偏好。总开关开、偏好开（或未设）时返回 `{name: "INTELLIGENT_UI", content}`。
- 文案常量放在 `commercial/src/intelligentUi/prompt.ts`（个人版树内的包，不是商业版产品）。
- master 白名单加 `INTELLIGENT_UI`。
- gateway：
  - 白名单加 `INTELLIGENT_UI`。
  - 位置在 TOOLS 之后、MODEL_HINT 之前：它是静态协议，放靠前更利于缓存；模型补丁仍能覆盖它。
  - **只对 `webchat` 会话注入**。微信、QQ、cron、委派、子 agent、webhook、openai 兼容通道都不注入，否则用户会在微信里收到 JSON。
- 文案要点：
  - 协议：语言标记、单个 JSON、闭围栏独占一行。
  - 每种类型一行 schema。
  - 鼓励自由使用组件，不设上限。
  - 数字给出依据或来源，计算器公式要正确且写明假设。
  - 组件外仍然用文字把话说清楚，不要只丢一个组件。
  - 需要用户拍板才能继续时，仍然按平台已有的提问通道规则（AskUserQuestion / request_user_input / present_options）。`choice` 用于回答里的「下一步选哪个方向」。
- 目标长度约 1.5k token 以内。

### 4.4 开关对新回合立即生效

- **Grok / Cursor / Zcode**：每轮都重组系统提示，天然立即生效。
- **CCB / Codex**：系统提示在 runner 启动时固定。做法：
  - runner 记下启动时这一段是否注入（`promptIntelligentUi: boolean`）。
  - `sessionManager.submit` 在应用 effort/model 的同一把锁里，取当前期望值，与 runner 记录比对。不一致时并入已有的「effort/model/toolsets 变化 → shutdown → 本次 submit 自动以 resume 重启」路径。
  - 当前期望值的取法：缓存 5 秒，过期就同步拉一次 slots（master 在本机，超时 1 秒）。拉取失败视为「未知」，不重启。
  - 切换是低频动作，重启只发生在切换后的第一轮。

### 4.5 计费

slot 是系统提示的一部分，走正常的模型请求，由 egress/proxy 按 input 或 cache token 正常计费。验收时，同一模型开和关各跑一轮，对比 input token 差值约等于 slot 大小，并按 release-verify 第 9 节做三处对账。

## 5. 降级（任何情况都不让消息崩）

| 情况 | 渲染 |
|---|---|
| JSON 不合法（已闭合） | 先尝试宽容修复（去掉尾逗号、补右括号）。仍失败就原样显示为代码块，顶部一行小字「组件内容无法解析，已按原文显示」 |
| 未知 `type` | 若有可识别的通用字段（`title`、`items`、`rows`），按 `toMarkdown` 的通用规则转文字；否则显示原文代码块 |
| 字段校验失败 | 能修正的就修正后渲染（截断超限项、丢弃非法行、数字字符串转数字），并在组件底部注明「部分内容已省略」；修不了就转 Markdown 或原文 |
| 渲染时异常 | 组件级错误边界接住，显示 `toMarkdown` 的结果 |
| 计算器公式错误 | 只有那个输出显示「—」加原因，其它输出正常 |
| 流式半截 | 先渲染已能确定的部分，否则显示骨架。围栏一直没闭合就按「JSON 不合法」处理 |
| 开关关闭、或总开关关闭 | 整段转 Markdown（§3） |
| 只读上下文（站内信、分享、历史预览） | 组件照常显示；choice 和 suggestions 不可点，计算器仍可在本地计算 |

## 6. 安全

- 没有新增代码执行面：组件全部用 React 文本节点渲染，行内 Markdown 走现有 react-markdown（无 rehype-raw），链接走现有 `a` 渲染器。
- 公式解析器不用 eval，有长度、深度和运算量上限。
- JSON 块上限 64 KB，超过就降级为原文。
- 勾选状态只存本机 localStorage，包在 try/catch 里，不上传。
- 偏好 PATCH 沿用现有鉴权和 zod strict 校验。总开关只能由服务端 env 改。
- slot 端点沿用容器身份双因子认证，uid 只从身份推出，不从 query 取。

## 7. 发布与回退

1. 合入 `feat/v5-selfhost`，按 `docs/02` 用 Lease Center 搭车发布（前端 dist、master、runtime 一次带上）。
2. 各部分何时生效：
   - 前端和 master（偏好、slot 下发）：发布后立即生效。
   - gateway 白名单、webchat 判定、重启判定：随 runtime release，要等**用户容器重建**（idleSweep 回收后，或用户同意后手工重建）。容器重建前，旧 gateway 会按白名单丢掉 `INTELLIGENT_UI`，结果等同关闭，不会出错。
3. 紧急关闭：在 selfhost master env 设 `OC_INTELLIGENT_UI=0` 并重启 master。不需要回滚代码。
4. 回滚代码时的注意点：旧版 `PreferencesSchema` 是 strict。库里有 `intelligent_ui` 键时，旧代码读偏好会整体返回 `{}`（主题、默认模型等偏好暂时失效）。回滚时同时执行 `UPDATE user_preferences SET prefs = prefs - 'intelligent_ui'`（先备份）。这一点写进交接文件。

## 8. 测试计划

- **单元（vitest，web-react）**：
  - `parse`：完整、半截、多余尾字、超长。
  - `schema`：每种类型的合法、非法、可修正样例。
  - `formula`：运算、优先级、函数、错误、环、上限，以及 eval 不可达。
  - `toMarkdown`：每种类型。
  - `uiFencesToMarkdown`：多块、半截块、非 ui 围栏不受影响。
- **渲染（vitest + testing-library）**：
  - 每个组件的渲染，以及交互：排序、勾选、切标签、计算器重算、choice 发送、suggestions 发送。
  - §5 表里的每一种降级。
  - 流式：同一块逐字增长，组件不重挂载，交互在闭合前禁用。
  - 开关开和关：同一段文本两种渲染；复制和导出得到 Markdown。
- **gateway（node test）**：白名单接受 `INTELLIGENT_UI`；非 webchat 会话不注入；slot 的位置；开关变化触发 runner 重启，不变不触发，拉取失败不重启。
- **commercial（unit）**：偏好 schema 接受和拒绝；slot 端点在总开关、偏好开、偏好关、偏好未设四种情况下的返回；`features` 字段。
- **全量**：`npm run test:web-react` 全绿；web-react typecheck；gateway 和 commercial 相关测试与基线对照。
- **真浏览器**：用 `browser-tests/ui-preview` 在 390px 和 1280px、明暗两种主题下截图，前后对比。
- **线上**：个人版真实多轮 canary，至少 2 个不同模型、隔 5 分钟续聊，并做扣费三处对账。另跑开和关两种状态，对比 token。

## 9. 与并行会话的协调

- cc3-admin-v4 改管理中心，cc3-selfhost-workspace 改消息操作行（OCV5-359）和产出预览（OCV5-358）。
- 本任务新增文件为主。改动的现有文件：`MarkdownImpl.tsx`（一处分派加预处理）、消息复制（一行包装）、`App.tsx`（提供 context、导出包装）、`settings/PreferencesTab.tsx`（一行开关）。
- 合入前对 canonical 最新 HEAD 做 rebase，冲突按对方的意图保留，测试重跑。
