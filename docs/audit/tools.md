# tools 模块审计报告（阶段 A）· 工具卡 / 智能体过程 / 检查器

- 任务：t-44「A·tools 工具卡/智能体过程/检查器审计」
- 分支：`feat/v5-selfhost-audit-tools`（基线 `210b9967`）
- 角色：前端审计。阶段 A **未改任何业务代码**，只新增 ui-preview 场景与本文档。
- 严重度口径：P1 功能不可用/数据错误/阻断主流程；P2 明显体验缺陷/一致性破坏/移动端不可用；P3 打磨项。

## 1. 范围与文件清单

归属文件（`packages/web-react/src/` 下）：

| 文件 | 职责 | 行数 |
|---|---|---|
| `components/ToolCard.tsx` | 工具卡壳：表头（图标/标签/摘要/状态徽标/展开箭头/详情入口）、四态判定、默认展开语义 | 263 |
| `components/InspectorPanel.tsx` | 产物详情列（桌面第三列 aside / 移动端 Sheet 共用的 `InspectorPanelContent`）、复制全文、Escape 关闭 | 164 |
| `components/AgentAvatar.tsx` | 智能体头像：emoji / lucide 图标 / Sparkles 兜底 + 渐变底 | 38 |
| `components/tool/bodies.tsx` | 展开体二级分派：Bash/Edit/Read/Write/Grep/Glob/TodoWrite/WebFetch/WebSearch/Task、codex item、MCP（browser/media/vision/memory/scansci）、Generic 兜底 | 1421 |
| `components/tool/format.ts` | `ToolLike` 契约、输入解析、codex/ExecuteExtraTool 归一化、heredoc 写文件识别、ANSI 剥离 | 784 |
| `components/tool/grokDisplay.ts` | Grok 原生名/信封 → 产品名/输出的展示层归一化 | 269 |
| `components/tool/meta.ts` | 图标/标签/tone、oc-* CLI 检测、表头摘要 `toolSummary` | 730 |
| `components/tool/expandable.tsx` | 「截断 + 展开全部 / 继续显示 / 收起」原语（F4） | 154 |
| `components/tool/highlight.ts` / `lineDiff.ts` | hljs 惰性高亮；行级 LCS diff | 125 / 80 |
| `components/tool/researchCards.tsx` | oc-* CLI 专属卡（文献/引用/入库/片段/报告产物/排名/办公文档/市场/网页提取/识图/记忆/媒体/浏览器）+ `GenericOcCard` 兜底 | 1734 |
| `components/tool/connectorCards.tsx` | oc-connect / oc-plugin 写操作确认卡（human-in-the-loop） | 500 |
| `components/tool/taskApprovalCard.tsx` | 对话内任务单审批卡 | 285 |
| `components/tool/skillCards.tsx` / `memoryReminderCards.tsx` / `delegateFanoutCard.tsx` / `mcpResourceCards.tsx` / `releaseCards.tsx` | 记忆/技能/提醒/并行委派/MCP 资源/发布任务富卡 | — |
| `components/tool/context.ts` | `ToolCardActions` / `ChatInteraction` / `ArtifactInspect` / `ToolInspectOpen` / `ToolBodyFull` 五个 context | 100 |
| `components/tool/partialJson.ts` / `stripAnsi.ts` / `__fixtures__/sessionToolTexts.ts` | 纯函数与测试夹具 | — |
| 对应 `*.test.ts(x)` 共 19 个文件 | 现有单测 | 340 用例 |

接线面（不在本模块归属内、只读参照，问题记入 §3.8 跨模块）：`components/chat/toolCardSlot.tsx`（唯一接缝）、`components/chat/AgentGroupCard.tsx` + `delegateProcessList.tsx`（子代理过程内嵌 ToolCard）、`App.tsx:3805-3821`（InspectorPanel 桌面 aside / 移动 Sheet 切换）、`lib/cron.ts`（提醒卡的 cronHuman）。

## 2. 方法与证据

1. 通读上表全部源码与 19 个测试文件、`browser-tests/cases.json`（T6/T12/T13/T21/T36/T41 覆盖工具卡的 44px 触控、键盘展开、渐进加载、375px 不横溢、四态）与 `browser-tests/fixtures/turnReplay.ts`。
2. 新增 ui-preview 场景 `packages/web-react/browser-tests/ui-preview/scenes-tools.tsx`（6 个场景，全部 desktop+mobile）：
   - `tools-states` 四态 + 受阻 × 主要内置工具（默认折叠语义原样）；
   - `tools-bodies` 展开体（行级 diff/高亮/行数截断、长输出截断展开、终端块与 head 截断、heredoc 写文件、Grep 命中高亮与文件列表、Glob、WebSearch/WebFetch、TodoWrite、codex apply_patch update/delete/add）；
   - `tools-mcp` MCP/子代理/记忆/技能/委派/顾问/审批/论文/资源清单/延迟工具/通用兜底；
   - `tools-oc-cli` oc-* CLI 专属卡（文献/引用/报告产物/市场/浏览器/网页提取/委派运行中/历史检索/连接器确认/媒体/识图/任务单/Word/Excel/失败兜底）；
   - `tools-inspector` 检查器：≥768px 桌面第三列 vs 窄屏贴底 Sheet（与 App 的 `useMdViewport` 同分界）；
   - `tools-agent-avatar` AgentAvatar 三种来源 × 全站四档尺寸 + agent-group 运行中/完成/失败内嵌工具卡。
   完成态卡片默认折叠，`tools-bodies/mcp/oc-cli` 用场景内 `<ExpandAll>` 在挂载后把表头点开一次（等价用户逐张点开，不改组件语义）。媒体路径经场景内假签名映射到内联 SVG，让截图/生成图缩略图真实渲染。`api-stub.ts` 未改动（本模块不直接调 api）。
3. 截图：`OC_UI_SCENES=tools node browser-tests/ui-preview/shoot.mjs` → `D:\code\test_project\test123\.audit-tmp\tools\before\`，**24 张**（6 场景 × desktop/mobile × light/dark），`manifest.json` 无 failures、无 unmockedApi。超长整页图另切分到 `before\crops\`（每 1800px 一块，另有 `zoom-*.png` 局部放大）逐张用 Read 审看。
   **截图台版本**：首轮用基线 shoot.mjs 出图后，按指挥官通告合并 integration `feat/v5-selfhost-ocv5-audit-ux @ e6f73dd99`（合并提交 `a139215c8`，含 messages-A 修的 shoot.mjs：移动视口不再 fullPage、`(hover:none)` 仿真在整页图里保留），用新台子**重出全部 24 张**覆盖 `before\`；旧台子那套留在 `before-oldharness\` 仅作对照。§3 里所有「触控 <44px」结论均以**新台子 mobile 图 + 源码里是否存在 `[@media(hover:none)]` 规则**双重核对：T-08 成立（新 mobile 图里卡内文字按钮仍是 16–24px，源码 `CONTROL_BTN_CLS`/`<summary>` 等确无 hover:none 规则）；表头与 `IconButton` 在新图中正确升到 44px，与旧结论一致，无需撤回。
4. 对可疑渲染用临时探针测试走**完整 ToolCard 路径**（非直接调 `researchToolCard`）取证，探针已删除，DOM 结论见 §3 编号 T-01。
5. 基线验证：`npm run typecheck --workspace packages/web-react` 绿；`npx vitest run src/components/tool src/components/ToolCard.test.tsx src/components/InspectorPanel.test.tsx --maxWorkers=1` → 19 files / 340 tests 全绿；合并 integration 后 `npm run typecheck:preview`（`tsc -p tsconfig.browser-tests.json`）对 `scenes-tools.tsx` **0 错误**（当前剩余 3 个错误全部在 `scenes-taskboard.tsx`，属 taskboard owner）；`npx biome check` 场景文件无报错。

## 3. 问题清单

统计：**P1 × 1 / P2 × 7 / P3 × 23**（另跨模块 4 条单列）。

### 3.1 功能正确性

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| T-01 | `tool/format.ts:326,328` → `tool/grokDisplay.ts:253-267`（`grokProductToolOutput` 121-159，尤其 141-150、152-155） | `normalizeGrokToolForDisplay` 对**所有**工具消息生效，不限 Grok 原生名：只要 `output` 是以 `{` 开头的 JSON 字符串且含 `output/stdout/stderr/content/text/markdown/body` 任一键，就把整段输出替换成该字段文本。oc-report 输出 `{output:"/…/report.pdf", references, coverage, warnings, qmd}` 被改写成只剩路径 → `researchCards.tsx:616 ArtifactCard` 拿不到 JSON，落到 `GenericOcCard` 只画一行路径；oc-task `--json`（含 `body`）只剩正文；oc-web `--json`（含 `markdown`）丢 `final_url/truncated`；普通 Bash 的 JSON stdout 含 `output` 键时用户看到的是字段值而非真实输出 | 报告/幻灯/海报产物卡（下载、预览、参考文献数、引用接地详情）**整体不可见**；任务单卡字段全丢；用户看到的输出 ≠ 工具真实返回。现有 `researchCards.test.tsx:231-278` 直接调 `researchToolCard`，绕过了归一化层，所以全绿仍漏 | **P1** | `before\tools-oc-cli--desktop--light.png`「研究报告」「任务单据」两卡；`before\crops\zoom-report.png`；探针 DOM：`<div class="rounded-lg px-3 py-2.5 bg-hover/70">…/home/agent/out/report.pdf</div>`（oc-report）、`正文文字`（oc-task）、`done`（plain Bash `{id,output,status}`） |
| T-02 | `ToolCard.tsx:138-143`（`errorFirstLine` 取输出首个非空行） | 错误输出是 JSON 时（Cursor shell 信封 `{"success":{"command"…`、oc-connect 确认触发 `{"oc_connect":{"type":"confirmation_required"…`、oc-memory 失败信封）表头摘要区直接显示原始 JSON | 表头是用户最先看到的一行，人机确认卡（安全关键）表头露出内部 JSON；移动端把命令摘要挤成 `n…`/`fe…` | P2 | `crops\zoom-error-cards.png`、`crops\zoom-error-mobile.png`、`tools-oc-cli--mobile--light.png` 调用应用连接卡、归档检索卡 |
| T-03 | `tool/bodies.tsx:239-324 BashBody`（261-273 只取 `out`/`bashTail`，未解信封）；对照 `researchCards.tsx:1117 cursorCliStreams` 只服务 oc-* | 非 oc-* 的 Bash 在 Cursor 引擎下输出是 `{success:{command,exitCode,stdout,stderr},isBackground}` 信封，展开体把整段 JSON 当终端输出渲染（`ToolCard.tsx:50-81` 已能识别该信封判失败，却没把 stdout/stderr 拆出来显示） | 最常见的终端卡在 Cursor 引擎下可读性差，报错要在 JSON 里找 `stderr` | P2 | `tools-states--desktop--light.png` 第 12 卡「终端 npm run… 未成功」 |
| T-04 | `InspectorPanel.tsx:32-48 inspectorCopyText` | 「复制全文」优先复制 `output`；Edit/Write 完成后 `output` 是 `The file has been updated.` 之类状态串，复制到的不是面板里展示的 diff/文件内容；`output` 为空才回退 `JSON.stringify(input)`（裸 JSON） | 面板主要用例（看全文 diff → 复制）拿到无用文本，且失败静默（50-71 catch 后无提示） | P2 | 代码路径；`tools-inspector--desktop--light.png` 面板展示的是 diff，复制得到的却是状态行 |
| T-05 | `InspectorPanel.tsx:86-88`（`hasError = !!tool.error`，无 `reportedError/isBlocked`）+ `:107`（错误显示中性「已结束」） | 同一条消息卡片判「未成功」/「受阻」（`ToolCard.tsx:114-119` 有 exitCode/markdown Error/oc-web blocked 三条启发式），面板却判「完成」；真 `error:true` 时面板又用中性徽标「已结束」而卡片用 danger「未成功」 | 卡片与面板状态互相矛盾；F1 口径（未成功而非已结束）未同步 | P2 | 代码路径（状态计算在两处各写一遍） |
| T-06 | `tool/meta.ts:585-586` | WebFetch 表头摘要 `url.slice(0,60)` 硬切无省略号：`…/pulls/1284` 显示成 `…/pulls/128` | 表头呈现一个**错误的 URL** | P3 | `crops\tools-bodies--desktop--light--part05.png` 网页抓取卡 |
| T-07 | `ToolCard.tsx:154` | 默认展开态只在挂载时求值一次；历史消息以「完成/折叠」挂载后若经归并变为 `error:true`，不会按 F1「未成功默认展开」 | 边界情形，错误详情多一次点击 | P3 | 代码路径 |

### 3.2 响应式 / 移动端 / 触控

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| T-08 | `tool/expandable.tsx:62-63 CONTROL_BTN_CLS`（text-xs，无高度）；`tool/bodies.tsx:222-231 / 380-390`（diff「展开全部」px-3 py-1）、`:149-164 DiffTruncationRow`、`:580-591 GrepFileList`；`researchCards.tsx:819`（市场「查看更多」min-h-8=32px）、`:1225 OutputDetails summary`（text-caption 11px）、`skillCards.tsx:296`、`delegateFanoutCard.tsx:87`、`researchCards.tsx:1030`（`<details><summary>` 全部 11px 文字）；`connectorCards.tsx:426-437`（「查看完整内容」text-meta 无高度） | 卡**内**所有文字型操作（展开全部/继续显示/收起、diff 展开、查看结果/技能正文/抽取全文/页面快照、查看更多、还有 N 个字段、查看完整内容）触控高度 16–24px；只有表头（`ToolCard.tsx:184 min-h-11`）与 `IconButton` 达 44px | §2 触控目标 ≥44px 在卡内系统性不达标；确认卡「查看完整内容」是安全操作前的必读入口 | P2 | `crops\tools-bodies--mobile--light--part02.png`（已截断/展开全部行）、`tools-mcp--mobile--light--part02.png`（查看结果）、`tools-oc-cli--mobile--light--part02.png`（查看抽取全文） |
| T-09 | `tool/bodies.tsx:56-70 Pre`（`max-h-80 overflow-auto`）与 `:312-322`；`expandable.tsx:141-148`；`bodies.tsx:540-545 GrepOutput` | 终端块/文件内容/Grep 输出在卡内是 320px 高的**嵌套滚动区**；BashBody 输出还完全没接 F4 展开原语（其他 body 都有「展开全部」），长输出只能在小窗里滚 | 移动端时间线内嵌套滚动容易劫持手势；终端是最高频工具却是唯一没有「展开全部」的体；bashTail 的 `… (head 已截断, 共 48213 字节)`（:294/:311）数字不分组、混用中英标点 | P2 | `crops\tools-bodies--desktop--light--part02.png` 终端卡（列表在 max-h 内被截）、`part03.png` mobile 终端 |
| T-10 | `tool/bodies.tsx:167-204 DiffRowView`（旧/新行号各 `w-9` + 符号 `w-5` = 92px 固定 gutter）+ `whitespace-pre-wrap` | 390px 下 diff 内容区只剩 ~230px，每行代码折成 2–3 行；全新增 diff（Write/add）左侧旧行号列整列为空仍占 36px | 移动端 diff 基本不可读；桌面全新增文件也浪费一列 | P3 | `crops\tools-bodies--mobile--light--part00.png`、`tools-inspector--mobile--light.png` |
| T-11 | `ToolCard.tsx:197-209`（标签 `max-w-[45%]` + 摘要/错误行都 `truncate`） | 有错误首行时摘要与错误同挤一行，390px 下各剩 3–5 个字（`…/compone… String to r…`）；`title={summary}` 悬停提示在触屏不可用，全文无处可看 | 移动端表头信息量归零 | P3 | `crops\zoom-error-mobile.png` |

### 3.3 UI / 视觉

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| T-12 | `tool/bodies.tsx:222-235`（截断时同时渲染「展开全部（共 N 行）」按钮和 `DiffTruncationRow`） | 无检查器时 `DiffTruncationRow`（:151）退化成纯文字「… (diff 过长，已截断)」，与上一行按钮语义重复，两行叠在一起 | 视觉噪音、语义重复 | P3 | `crops\tools-bodies--desktop--light--part01.png` 底部 |
| T-13 | `researchCards.tsx:185-203 Chip`（`rounded px-1.5 text-[11px] bg-danger/10`）vs `ui/Badge`（`rounded-full bg-danger-soft text-meta`） | 同一张卡里两套徽标：oc-* 富卡的直角 11px Chip 与表头/其它富卡的药丸 Badge 并存，tone 用 `/10` 透明度而非设计 token 的 `-soft` 对 | 一致性破坏、暗色下对比度不受 token 守卫 | P3 | `crops\tools-oc-cli--desktop--dark--part00.png` 文献/引用卡 |
| T-14 | `skillCards.tsx:164`、`memoryReminderCards.tsx:117`、`memoryReminderCards.tsx:233`（`rounded-xl border bg-elevated shadow-soft`）；`delegateFanoutCard.tsx:65-70`（`rounded-lg border bg-surface`，无阴影但同样是卡中卡） | 富卡条目在 ToolCard（已有边框 + 体区底色）内再套一层带边框/阴影的卡 → 三层嵌套「卡中卡」 | 视觉重、间距膨胀（每条目 padding 10px×2 + 边框 + 阴影） | P3 | `crops\tools-mcp--desktop--light--part01.png` |
| T-15 | `researchCards.tsx:164-183 CardShell` | 专属卡顶部再写一行小字标题（「文献检索」「图片生成」「委派子任务」…），与表头标签几乎同词 | 重复信息，M5 已弱化但仍占一行 | P3 | `crops\tools-oc-cli--desktop--light--part00.png` |
| T-16 | `tool/bodies.tsx:836` | codex imageGeneration 运行中状态行「图片生成中…」用 `StatusLine`（默认 text-success 绿色）表达**进行中** | 语义色错用：进行中 ≠ 成功 | P3 | `tools-states--desktop--light.png` 第 3 卡 |
| T-17 | `ToolCard.tsx:37-43` 与 `InspectorPanel.tsx:24-30` | `TONE_TILE` 图标底色表复制粘贴两份 | 改 tone 需同步两处，易漂移 | P3 | 代码路径 |

### 3.4 交互友好性

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| T-18 | `InspectorPanel.tsx:140-163`；`ToolCard.tsx:237-252` | 面板打开后源卡片没有任何「当前正在查看」的选中态；同一列多张卡时不知道面板对应哪一条 | 多卡场景定位成本高 | P3 | `tools-inspector--desktop--light.png` |
| T-19 | `InspectorPanel.tsx:50-71 CopyIconButton` | 剪贴板失败静默（catch 空）；成功只靠图标变 ✓ 1.5s，无 toast/sr 播报 | 失败无反馈 | P3 | 代码路径 |
| T-20 | `tool/bodies.tsx:1300-1312 TaskBody`（:1303-1305 标题即 `description`） | 子任务卡展开体第一行重复表头摘要（同一句 description） | 展开只多看到一行重复 | P3 | `crops\tools-mcp--desktop--light--part04.png` |
| T-21 | `researchCards.tsx:206-212 PartialNote` | 文案「完整结果见上方回答」——时间线里工具卡在前、回答在**后**，方向反了 | 误导 | P3 | 代码路径 |

### 3.5 可访问性

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| T-22 | `ToolCard.tsx:180`（`aria-label` 覆盖按钮可及名） | 表头按钮的可及名只剩「展开终端详情」，按钮内的摘要、状态徽标、`sr-only 运行中`（:213）都被 `aria-label` 覆盖，读屏拿不到「哪条命令、什么状态」 | 屏幕阅读器用户丢失卡片主要信息；状态变化（运行中→完成）也无 live 播报 | P2 | 代码路径（建议改 `aria-labelledby`/去掉 aria-label 保留可见文本，状态 Badge 加 `aria-live="polite"`） |
| T-23 | `tool/bodies.tsx:56-70 Pre`、`:540-545`、`expandable.tsx:141-148`（`overflow-auto` 无 `tabIndex`） | 可滚动区域不可聚焦，键盘用户无法滚动长输出 | 键盘不可达 | P3 | 代码路径 |
| T-24 | `InspectorPanel.tsx:92-129` | 面板无标题元素（标签是 `span`），打开时焦点不进面板、关闭时不归还到卡片入口按钮；`:147-154` 全局 Escape 监听会在用户于输入框按 Esc 取消输入法时关掉面板 | 焦点管理缺失（§5） | P3 | 代码路径 |
| T-25 | `AgentAvatar.tsx:15`（props 不含 name）、`:22-36`（无 `aria-hidden`/`role`，无 `overflow-hidden`），`:30`（emoji `fontSize = iconSize + 2`） | emoji 被读屏逐字朗读（与旁边名字重复）；多码点/宽 emoji 在不支持 ZWJ 的平台会溢出圆角框 | 冗余朗读；极端平台溢出 | P3 | `tools-agent-avatar--desktop--light.png`（本机 Windows 渲染正常，风险来自代码） |

### 3.6 文案

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| T-26 | `tool/meta.ts:571-584, 587-592` | 表头「读取文件 · 读取 …/path」「搜索内容 · 搜索 "x"」「搜索文件 · 搜索 pattern」「网页搜索 · 搜索 "q"」——摘要动词与标签动词重复 | 每张卡多两个字的噪音 | P3 | `tools-states--desktop--light.png` |
| T-27 | `tool/bodies.tsx:453, 484`（`StatusLine` 直显工具原始 output）、`:660, 672-679`（KvList 原始键 `url/prompt/query/allowed_domains`）、`:600`（`output_mode` 原词 `content`/`files_with_matches`）、`:868-870`（`tokens before/after/note`）、`:1071-1074`（`状态 settled`）、`:1305`（`等待后台命令 · call-7fc87448-14…` 内部 id） | 英文开发者术语/原始字段名/内部 id 泄漏到用户面 | §6 无开发者术语泄漏不达标 | P3 | `crops\tools-bodies--desktop--light--part04/05.png`、`tools-mcp--desktop--light--part02/03/04.png` |
| T-28 | `tool/meta.ts:440-474 ocCommandSummary`（oc-lit/oc-cite/oc-ingest/oc-litrag/oc-report/oc-docx… 落到 :473 `return ""`）、`:692`（openclaude-memory 未列 op 直接 `return op`） | 文献检索等卡表头没有摘要（查询词丢失）；consult_advisor 表头显示原始 `consult_advisor` | 折叠态无法区分多张同类卡 | P3 | `crops\tools-oc-cli--desktop--light--part00.png`、`tools-mcp--desktop--light--part02.png` |
| T-29 | `memoryReminderCards.tsx:241`（Badge「失败」）、`:186-203`（标题「创建提醒失败」+ desc 又是 `error: 创建提醒失败: …`） | 与 ToolCard F1 口径「未成功」不一致；错误文本重复两遍且带 `error:` 前缀 | 术语不统一 | P3 | `crops\tools-mcp--desktop--light--part02.png` |
| T-30 | `tool/bodies.tsx:460-461` | Read 元信息「行 1, 70 行」 | 语义含糊 | P3 | `crops\tools-bodies--desktop--light--part02.png` |

### 3.7 代码质量（影响可感知结果的）

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| T-31 | `tool/bodies.tsx:616-624 GlobBody`（全路径 `ExpandablePre`）vs `:562-594 GrepFileList`（`shortPath` + 图标列表） | 同为「文件列表」两种呈现 | 不一致 | P3 | `crops\tools-bodies--desktop--light--part04.png` |

### 3.8 跨模块（记录，不改；由 owner 处理）

| 编号 | 位置（owner） | 现象 | 严重度 |
|---|---|---|---|
| X-01 | `components/chat/delegateProcessList.tsx:132`（messages） | 委派过程窗口固定 `h-[min(420px,50vh)]`，只有 5 步时下方留出 ~200px 空白 | P2 |
| X-02 | `components/chat/AgentGroupCard.tsx:209-212`（messages） | agent-group 表头按钮无 `aria-expanded`；`:214` 图标底 `size-6` 与 ToolCard `size-7` 不一致 | P3 |
| X-03 | `lib/cron.ts cronHuman`（manage） | `0 8 * * 1-5` 未人话化，提醒卡显示两遍原始 cron | P3 |
| X-04 | `researchCards.test.tsx:231-278`（本模块，但根因 T-01 在归一化层） | 测试直接调 `researchToolCard`，未经 `normalizeToolForDisplay`，集成路径无人守 | 随 T-01 修 |

## 4. 修复计划（阶段 B）

每条：文件 / 做法 / 测试 / 风险。P1/P2 必修，P3 量力。

| 编号 | 文件 | 做法 | 测试 | 风险 |
|---|---|---|---|---|
| T-01 | `tool/format.ts:324-328`、`tool/grokDisplay.ts:253-267` | 归一化**只对 Grok 原生名**生效：`normalizeToolForDisplay` 先判 `grokProductToolName(name) !== name`（或 `GROK_PRODUCT_NAMES` 命中 / `mcp__` 双下划线形态），其余工具原样透传；`grokProductToolOutput` 对 `obj.output` 的解包限定在 Grok 信封形状（有 `exit_code`/`stdout`/`stderr` 并存或 `type:"mcp"`），单独一个 `output` 键不再触发 | `grokDisplay.test.ts` 补「非 Grok 名 + JSON 含 output 键 → 原样」；`ToolCard.test.tsx` 补 oc-report/oc-task/oc-web --json 经完整 ToolCard 路径出富卡；`researchCards.test.tsx` 至少一条改经 `<ToolCard>` | 中：需与 gateway `grokToolNormalize.ts` 对齐口径（展示层只修历史 tape）；先跑全部 web-react 单测 |
| T-02 | `ToolCard.tsx:138-143` | `errorFirstLine` 先经统一「错误摘要提取」：JSON → 取 `stderr`/`error.message`/`success.stderr`；`oc_connect` 确认触发 → 固定文案「待确认」；否则首行；长度 clamp 120 | `ToolCard.test.tsx`：Cursor 信封失败 → 表头显示 stderr 首行；oc-connect → 不出现 `{"oc_connect"` | 低 |
| T-03 | `tool/bodies.tsx BashBody:261-273`；把 `researchCards.tsx:1074-1138` 的信封工具抽到 `tool/shellEnvelope.ts` 共用 | BashBody 输出先 `cursorCliStreams` 解包：stdout 正常渲染、stderr 用 danger 行、非 0 exitCode 追加「退出码 N」 | `ToolCard.test.tsx` 现有「Cursor shell 信封 exitCode 非 0」用例加断言：不出现 `{"success"`，出现 stderr 文本 | 低 |
| T-04 | `InspectorPanel.tsx:32-48` | 按工具类型取文本：Edit → 新内容（或 unified diff 文本）、Write → content、Read/Bash/Grep → output、其余 → output 或格式化 input；失败走 `useToast` 提示 | `InspectorPanel.test.tsx` 「复制全文」用例改断言复制到 `line-120` 且不含 `The file has been updated.` | 低 |
| T-05 | 抽 `tool/status.ts`：`resolveToolStatus(display) → {kind, label, tone, errorFirstLine}`；`ToolCard.tsx:106-143` 与 `InspectorPanel.tsx:86-112` 共用 | 一处权威，面板错误徽标改「未成功」danger、支持「受阻」 | 新 `status.test.ts` + 面板用例：卡「受阻」→ 面板「受阻」 | 低 |
| T-08 | `tool/expandable.tsx:62`、`bodies.tsx` 各截断按钮、`researchCards.tsx:819/1225`、`skillCards.tsx:296`、`delegateFanoutCard.tsx:87`、`connectorCards.tsx:426` | 统一成一个 `InlineAction` 小原语（或复用 `ui/Button variant="link" size="sm"`，它已带 `[@media(hover:none)]:min-h-11`）；`<details><summary>` 加 `[@media(hover:none)]:min-h-11 flex items-center` | `ToolCard.test.tsx` 断言展开按钮 className 含 `min-h-11`；`test:browser` T13 已守表头，追加卡内按钮高度断言 | 低（桌面零变化） |
| T-09 | `tool/bodies.tsx:56-70, 312-322` | BashBody 输出改走 `ExpandablePre`（默认 2000 字 + 展开全部/继续显示），去掉 `Pre` 的 `max-h-80` 嵌套滚动；head 截断文案改「前 N KB 已省略」并 `toLocaleString` | `ToolCard.test.tsx` 补长终端输出「展开全部」用例 | 低 |
| T-22 | `ToolCard.tsx:175-181, 210-235` | 去掉 `aria-label`，改 `aria-labelledby` 指向标签+摘要 span，状态区包 `<span aria-live="polite">`；无 body 的 div 保持 | 现有用例中 `getByLabelText("展开读取文件详情")` 改为 `getByRole("button",{name:/读取文件/})` | 低 |
| T-06 | `tool/meta.ts:585-586` | `clipOneLine(url, 60)`（已有函数，带省略号） | `meta.test.ts` 补长 URL 用例 | 低 |
| T-10 | `bodies.tsx:167-204, 210-237` | 全新增/全删除 diff 隐藏空 gutter；`sm:` 以下只显示新行号列（`hidden sm:inline-block`），diff 容器改 `overflow-x-auto` + `whitespace-pre`（横滑代替折行，与 Markdown 代码块一致） | 现有 diff 用例不变 + 新增「全新增 diff 无旧行号列」 | 中：与 T25「宽内容要么放得下要么可横滑」一致，需 mobile 截图对照 |
| T-11 | `ToolCard.tsx:197-209` | 有 `errorFirstLine` 时 `sm:` 以下隐藏 summary；错误首行移到表头下方独立一行（`sm:` 以上保持同行） | 单测断言错误首行存在即可 | 低 |
| T-12 | `bodies.tsx:222-235, 380-393` | 无检查器时不渲染 `DiffTruncationRow`；有检查器时合并成一行「展开全部（共 N 行）· 在详情面板查看」 | `InspectorPanel.test.tsx` 现有截断行用例保持 | 低 |
| T-13 | `researchCards.tsx:185-203` | `Chip` 改为 `ui/Badge size="sm"` 的薄封装（tone 映射 ok→success / danger / muted→neutral），带 href 时包 `<a>` | `researchCards.test.tsx` 现有文本断言不变 | 低 |
| T-14 | `skillCards.tsx:164`、`memoryReminderCards.tsx:117,233`、`delegateFanoutCard.tsx:65-70` | 条目去 `shadow-soft` + `rounded-xl` → `rounded-lg border border-border/70 bg-surface`，padding 收到 `px-3 py-2` | 快照/视觉：after 截图对照 | 低 |
| T-15 | `researchCards.tsx:164-183` | `CardShell` 标题与表头标签相同时只保留 subtitle 徽标（右对齐一行） | 视觉对照 | 低 |
| T-16 | `bodies.tsx:836` | `StatusLine` 加 `tone` 参数（running → text-muted + Spinner） | 单测文本不变 | 低 |
| T-17 | 新 `tool/tone.ts` 导出 `TONE_TILE` | 两处改 import | typecheck | 低 |
| T-18 | `context.ts` `ArtifactInspect` 加 `activeMessage?`；`ToolCard.tsx:159-172` 命中时加 `ring-1 ring-accent/40`；`App.tsx` 传 `inspectTarget.message`（需 shell owner 一行接线） | 选中态 | `InspectorPanel.test.tsx` 补 provider 传 active → 卡有选中类 | 低（跨 App.tsx 一行，send_to shell owner） |
| T-19 | `InspectorPanel.tsx:50-71` | 复制成功/失败走 `useToast` | 单测 mock clipboard reject → toast 文案 | 低 |
| T-20 | `bodies.tsx:1300-1312` | 有 output 时不重复 title；无 output 才显示 | 现有 TaskOutput 用例保持 | 低 |
| T-21 | `researchCards.tsx:209` | 改「完整结果见下方回答」 | 文本断言 | 低 |
| T-23 | `bodies.tsx:56-70,540-545`、`expandable.tsx:141-148` | 滚动 `pre` 加 `tabIndex={0}` + `focus-visible:ring` | — | 低 |
| T-24 | `InspectorPanel.tsx:92-129,147-154` | 标题改 `<h2 id>` + `aria-labelledby`；打开时 `requestAnimationFrame` 聚焦关闭按钮，关闭时归还到触发按钮（`ArtifactInspect.open` 传入 `returnFocusTo`）；Escape 只在焦点位于面板内或 body 时生效 | `InspectorPanel.test.tsx` 补焦点归还 | 低 |
| T-25 | `AgentAvatar.tsx` | 加 `overflow-hidden leading-none`；props 增 `name?`：有则 `role="img" aria-label={name}`，否则 `aria-hidden` | 新增 `AgentAvatar.test.tsx` | 低（调用方可选传 name） |
| T-26 | `meta.ts:571-592` | Read/Grep/Glob/WebSearch 摘要去掉动词，只留对象 | `meta.test.ts` 更新断言 | 低 |
| T-27 | `bodies.tsx:453,484,600,660,672-679,868-870,1071-1074,1305` | 已知成功 output 映射中文（`The file has been updated.`→「已更新」…，未知保持原文但降为 faint）；KvList 键走一张中文标签表（url→地址、prompt→提示、query→查询…，未知键回退原键）；`output_mode` 映射「内容/文件」；tokens 数字 `toLocaleString`；`settled`→「已结算」；后台任务 id 不显示 | 单测更新 | 低 |
| T-28 | `meta.ts:440-474, 663-692` | oc-lit/oc-cite/oc-litrag/oc-ingest 摘要取首个引号参数或 `--query`；consult_advisor 摘要取 `question`；未知 op 走 `humanizeOp` | `meta.test.ts` | 低 |
| T-29 | `memoryReminderCards.tsx:186-203,241` | Badge 改「未成功」；desc 去 `error:` 前缀且与标题不同才显示 | 现有 `test.each` 用例调整断言 | 低 |
| T-30 | `bodies.tsx:460-461` | 「从第 N 行起，共 M 行」 | 文本断言 | 低 |
| T-31 | `bodies.tsx:616-624` | Glob 输出按行拆成 `GrepFileList` 同款列表（复用组件，改名 `FileList`） | 单测 | 低 |
| T-07 | `ToolCard.tsx:154` | `useEffect` 监听 `hasError` 从 false→true 时 `setOpen(true)`（用户已手动折叠过则不动） | 单测 rerender 用例 | 低 |
| X-01~X-03 | messages / manage owner | `send_to` 对应 owner，附本表 | — | — |

建议施工顺序：T-01 → T-05（含 T-02）→ T-03 → T-04 → T-08 → T-09 → T-22 → 其余 P3 按文件聚合一次改完。改到工具卡属高频交互面，交付前必跑 `npm run test:browser`（T6/T12/T13/T21/T36/T41）并出 after 截图对照。

## 5. 建议不修 / 暂缓项

| 项 | 理由 |
|---|---|
| 并行委派卡里的子任务名显示 `coding-assistant` 等 slug（`delegateFanoutCard.tsx:63`） | 名字来自 mcp-memory 聚合文本，前端无该会话可用的 agents 列表可映射；需后端在聚合文本里带 displayName（记「需后端配合」） |
| oc-* 富卡的 `Chip` 11px 字号本身 | 与 `text-caption`(11px) 同档，仅圆角/tone 不一致（已列 T-13），字号不动 |
| `ToolCard` 表头 `HeaderTag` 在流式期间 button/div 切换可能丢焦点 | 仅发生在「运行中且尚无 input」极短窗口，实测难触发，成本收益低 |
| `InspectorPanel` 桌面 aside 宽度 `clamp(20rem,36vw,34rem)` | 1440 下 518px 合理；<768 已切 Sheet，不需再调 |
| `GenericBody`/未知 MCP 的 KvList 保留原始键名 | 通用兜底本就用于未登记工具，无法预知语义，只做 T-27 的已知键中文化 |
| 表头 `title={summary}` 悬停提示 | 触屏无效但桌面有用，保留；移动端全文靠 T-11 的独立错误行 + 展开体 |

## 6. 修复记录（阶段 B）

- 任务：t-45「B·tools 工具卡/智能体过程/检查器修复」（原持有人 fable-5-1-23 施工，fable-5-1-33 → fable-5-1-37 接手收尾；工作树与分支沿用，未重建）。
- 分支 `feat/v5-selfhost-audit-tools`，基线 `210b9967` → 合 integration `e6f73dd99`（`a139215c8`）→ 阶段 B 三个代码提交：
  - `769596cec` feat(v5): tools T-01 Grok 输出归一化只对原生名与明确信封形状生效
  - `c5ee11db4` feat(v5): tools 工具卡/检查器阶段 B 修复(状态单一权威、信封解包、触控靶、a11y、文案)
  - `e569f9e66` test(v5): tools 浏览器门随表头可及名口径更新,T13 补卡内触控靶断言
- 新增源码：`tool/status.ts`（状态单一权威）、`tool/shellEnvelope.ts`（Cursor shell 信封解包）、`tool/inlineAction.tsx`（卡内文字操作原语）、`tool/tone.ts`（`TONE_TILE`）；新增测试：`tool/status.test.ts`、`tool/shellEnvelope.test.ts`、`AgentAvatar.test.tsx`。
- 统计：发现 31（P1 × 1 / P2 × 7 / P3 × 23）+ 跨模块 4；**修复 31 / 31**（P1、P2 全部修完，P3 全部修完）；遗留 0 条本模块问题，跨模块 4 条转 owner / 集成②（见 §8）。

### 6.1 逐条映射（编号 → 状态 → 改动 → 用例 → 提交）

| 编号 | 级别 | 状态 | 改动 | 用例 | 提交 |
|---|---|---|---|---|---|
| T-01 | P1 | ✅ | `grokDisplay.ts`：`normalizeGrokToolForDisplay` 只对 Grok 原生名（`GROK_PRODUCT_NAMES` / `mcp__` 形态）生效；`grokProductToolOutput` 对 `output` 的解包限定在 Grok 信封形状（`exit_code`/`stdout`/`stderr` 并存或 `type:"mcp"`、Vec<u8> 字节数组），单独一个 `output/body/markdown/content` 键不再触发 | `grokDisplay.test.ts`（非 Grok 名 + JSON 含 output/body/markdown/content → 原样；Grok 名 + 信封仍解）；`ToolCard.test.tsx`「T-01」组：oc-report `{output,references,coverage,warnings}` 经完整 ToolCard 出产物卡、oc-task `--json` 字段齐全、普通 Bash JSON stdout 原样、Grok 原生名 Vec<u8> 不回退 | `769596cec` |
| T-02 | P2 | ✅ | 新 `tool/status.ts` `errorSummaryLine`：`confirmation_required` → 「待确认」；Cursor/裸 shell 信封 → stderr 首行或「退出码 N」；其它 JSON → `error`/`error.message`/`message`/`reason`，认不出宁可空；文本 → 首个非标头行，剥 `error:` 前缀，夹 120 字 | `status.test.ts`；`ToolCard.test.tsx`（信封失败表头显示 stderr 首行、oc-connect 不出现 `{"oc_connect"`） | `c5ee11db4` |
| T-03 | P2 | ✅ | 新 `tool/shellEnvelope.ts`（从 `researchCards.tsx:1074-1138` 抽出 `isCursorShellEnvelope`/`cursorCliStreams`/`stripCommandEcho` 等）；`BashBody` 先 `parseShellEnvelope`：stdout 正常、stderr danger、非 0 退出码末行「退出码 N」，不再裸渲 JSON | `shellEnvelope.test.ts`（严格信封 / 裸 shell 结果 / 只带 stdout 键的普通 JSON 不解）；`ToolCard.test.tsx`（信封 exitCode≠0：不出现 `{"success"`，出现 stderr 文本） | `c5ee11db4` |
| T-04 | P2 | ✅ | `InspectorPanel.tsx` `inspectorCopyText` 按工具类型取面板实际展示正文：Edit → `diffLines` 文本 / codex `changes[].diff`；Write → `content`；Bash → `$ 命令` + 解信封后的 stdout/stderr；其余 → output，空才回退格式化 input | `InspectorPanel.test.tsx`「复制全文」：复制到 `line-120` 且不含 `The file has been updated.` | `c5ee11db4` |
| T-05 | P2 | ✅ | `tool/status.ts` `resolveToolStatus(display)` → `{kind,label,tone,hasError,isBlocked,isRunning,isCancelled,isConfirmation,errorFirstLine}`；`ToolCard.tsx` 与 `InspectorPanel.tsx` 都只消费它；面板错误徽标改「未成功」danger、支持「受阻」warning | `status.test.ts`（四态 + 受阻 + 取消 + 历史中断）；`InspectorPanel.test.tsx`（卡「受阻」→ 面板「受阻」、卡「未成功」→ 面板「未成功」） | `c5ee11db4` |
| T-06 | P3 | ✅ | `meta.ts` WebFetch 摘要改 `clipOneLine(url, 60)`（带省略号） | `meta.test.ts` 长 URL 用例 | `c5ee11db4` |
| T-07 | P3 | ✅ | `ToolCard.tsx` `useEffect` 监听 `hasError` false→true 时 `setOpen(true)`；用户手动折叠过（`userToggled`）则不动 | `ToolCard.test.tsx` rerender 用例 | `c5ee11db4` |
| T-08 | P2 | ✅ | 新 `tool/inlineAction.tsx`：`InlineAction`（`[@media(hover:none)]:min-h-11`，默认 stopPropagation）+ `INLINE_SUMMARY_CLS`（`<details><summary>` 用，hover:none 下 `py-3.5`）；替换 `expandable.tsx` 控制行、`bodies.tsx` diff 展开/文件列表展开、`researchCards.tsx` 「查看更多」「还有 N 个字段」「查看抽取全文」、`skillCards.tsx` / `delegateFanoutCard.tsx` / `bodies.tsx` 的 `<summary>`、`connectorCards.tsx` 「查看完整内容」；桌面渲染零变化 | `ToolCard.test.tsx`（展开按钮 className 含 `min-h-11`）；`browser-tests/run.mjs` T13 追加卡内按钮 ≥44px 断言 | `c5ee11db4`、`e569f9e66` |
| T-09 | P2 | ✅ | `BashBody` 输出改走 `useExpandableSlice`（2000 字 + 展开全部/继续显示/收起，按 stdout/stderr/退出码分段保色）；`ExpandablePre` 去掉 `max-h-80` 嵌套滚动；head 截断文案改「输出过长，已省略开头部分（共 N 字节）」`toLocaleString` | `ToolCard.test.tsx` 长终端输出「展开全部」用例 | `c5ee11db4` |
| T-10 | P3 | ✅ | `DiffRowView`：全新增/全删除 diff 隐藏空 gutter；`sm:` 以下只显示新行号列；diff 容器 `overflow-x-auto` + `whitespace-pre` 横滑代替折行，容器 `tabIndex=0` 可聚焦 | 既有 diff 用例不变；after mobile 截图对照（§7） | `c5ee11db4` |
| T-11 | P3 | ✅ | `ToolCard.tsx`：有 `errorFirstLine` 时 `sm:` 以下隐藏 summary，错误首行独立成表头下一行（`aria-hidden` 防重复），`sm:` 以上保持同行 | 既有错误首行断言；after mobile 截图 | `c5ee11db4` |
| T-12 | P3 | ✅ | `DiffTruncationRow` 合成一行「已显示前 N 行 · 展开全部（共 M 行）· 在详情面板查看全文」，不再叠一行「… (diff 过长，已截断)」 | `InspectorPanel.test.tsx` 截断行用例 | `c5ee11db4` |
| T-13 | P3 | ✅ | `researchCards.tsx` `Chip` 改为 `ui/Badge size="sm"` 薄封装（ok→success / danger / muted→neutral），带 href 包 `<a>` | `researchCards.test.tsx` 既有文本断言不变 | `c5ee11db4` |
| T-14 | P3 | ✅ | `skillCards.tsx` / `memoryReminderCards.tsx` / `delegateFanoutCard.tsx` 条目去 `shadow-soft`+`rounded-xl`，改 `rounded-lg border border-border/70 bg-surface px-3 py-2` | 视觉：after 截图 `tools-mcp` | `c5ee11db4` |
| T-15 | P3 | ✅ | `CardShell` 经 `ToolHeaderLabelContext` 拿表头标签，同词时只保留右对齐 subtitle 徽标 | 视觉：after 截图 `tools-oc-cli` | `c5ee11db4` |
| T-16 | P3 | ✅ | `StatusLine` 加 `tone`；codex imageGeneration 运行中改 `Spinner` + `text-muted` 行，不再用 success 绿 | 视觉：after 截图 `tools-states` 第 3 卡 | `c5ee11db4` |
| T-17 | P3 | ✅ | 新 `tool/tone.ts` 导出 `TONE_TILE`/`toneTileClass`，`ToolCard.tsx` 与 `InspectorPanel.tsx` 共用 | typecheck | `c5ee11db4` |
| T-18 | P3 | ✅（组件侧） | `context.ts` 新 `ArtifactInspectActiveContext` + `useArtifactInspectActive`；`ToolCard.tsx` 命中时 `ring-1 ring-accent/40`、入口按钮 `aria-pressed` | `InspectorPanel.test.tsx`（provider 传 active → 卡有选中类） | `c5ee11db4`；**App.tsx 一行接线待集成②**（§8） |
| T-19 | P3 | ✅ | `CopyIconButton` 成功/失败都走 `useToast`（「已复制全文」/「复制失败，请手动选中文本复制」） | `InspectorPanel.test.tsx`（clipboard reject → toast 文案） | `c5ee11db4` |
| T-20 | P3 | ✅ | `TaskBody` 有 output 时不重复 title | `bodyCards.test.tsx` | `c5ee11db4` |
| T-21 | P3 | ✅ | `PartialNote` 改「完整结果见下方回答」 | 文本 | `c5ee11db4` |
| T-22 | P2 | ✅ | `ToolCard.tsx` 去 `aria-label`，改 `aria-labelledby` 指向 标签+摘要+错误首行+状态 四段 id；状态区 `aria-live="polite"`（运行中 sr-only 播报） | `ToolCard.test.tsx` 改 `getByRole("button",{name:/读取文件/})`；`run.mjs` 浏览器门与 `scenes-tools.tsx` 随可及名口径更新 | `c5ee11db4`、`e569f9e66` |
| T-23 | P3 | ✅ | 仍带 `max-h`/`overflow` 的滚动区（diff 容器、技能正文、委派结果 `pre`）加 `tabIndex={0}` + `focus-visible:ring`；`ExpandablePre`/Grep 已无嵌套滚动区无需处理 | — | `c5ee11db4` |
| T-24 | P3 | ✅ | `InspectorPanel`：标题 `<h2 id>` + aside `aria-labelledby`；打开/换目标时 rAF 聚焦关闭按钮，卸载归还焦点；Escape 在焦点位于输入框/富文本且不在面板内时不抢，Radix 已 preventDefault 的 Escape 让位 | `InspectorPanel.test.tsx` 焦点归还 + Escape 用例 | `c5ee11db4` |
| T-25 | P3 | ✅ | `AgentAvatar` 加 `overflow-hidden leading-none`；props 增 `name?`：有则 `role="img" aria-label`，否则 `aria-hidden` | 新增 `AgentAvatar.test.tsx` | `c5ee11db4` |
| T-26 | P3 | ✅ | `meta.ts` Read/Grep/Glob/WebSearch 摘要去动词只留对象 | `meta.test.ts`；`ToolCard.test.tsx` | `c5ee11db4` |
| T-27 | P3 | ✅ | 已知成功 output 中文映射（`The file has been updated.`→「文件已更新」等，未知降 muted）；`KvList` 键走中文标签表，`output_mode` → 「匹配内容/匹配的文件」；tokens `toLocaleString`；`settled`→「已结算」；后台任务 id 不显示 | `bodyCards.test.tsx`；`ToolCard.test.tsx` | `c5ee11db4` |
| T-28 | P3 | ✅ | `meta.ts` oc-lit/oc-cite/oc-litrag/oc-ingest 摘要取首个引号参数或 `--query`；consult_advisor/request_review/ask_user 取 `question`；未知 op 走 `humanizeOp` | `meta.test.ts` | `c5ee11db4` |
| T-29 | P3 | ✅ | `memoryReminderCards.tsx` Badge 改「未成功」；desc 去 `error:` 前缀且与标题同句不重复 | `ToolCard.test.tsx`（`test.each` 调整） | `c5ee11db4` |
| T-30 | P3 | ✅ | Read 元信息改「从第 N 行起 · 读取 M 行」 | 文本；after 截图 | `c5ee11db4` |
| T-31 | P3 | ✅ | `GrepFileList` 改名 `FileList`，Glob 输出按行走同款文件列表（>N 条「展开全部（共 N 个文件）」） | `ToolCard.test.tsx` | `c5ee11db4` |

### 6.2 计划偏离说明

| 项 | 计划 | 实际 | 原因 |
|---|---|---|---|
| T-08 原语 | 「`InlineAction` 小原语或复用 `ui/Button variant="link"`」 | 新建模块内 `tool/inlineAction.tsx`，未动 `components/ui/**` | `ui/**` 属 shell 归属；`<summary>` 也不能换成 button，需要一份类名常量而非组件 |
| T-09 展开原语 | 「BashBody 改走 `ExpandablePre`」 | 改走底层 `useExpandableSlice` 自绘分段 | 要在同一段可展开文本里给 stderr / 退出码保留各自颜色，`ExpandablePre` 单色 `pre` 做不到 |
| T-16 | 「`StatusLine` 加 `tone`（running → muted + Spinner）」 | `StatusLine` 加了 `tone`；运行中另画一行 `Spinner` + 文案 | `StatusLine` 是纯文本行，Spinner 放进去要改所有调用方签名 |
| T-18 | 「App.tsx 传 `inspectTarget.message`（需 shell owner 一行接线）」 | 组件侧全部落地；App.tsx 未动 | 越界文件，按任务书写进「跨模块接线」交集成②（§8） |
| T-03 | 「抽到 `tool/shellEnvelope.ts` 共用」 | 同；`researchCards.tsx` 原地删掉私有实现改为 import，留注释指向新模块 | 与计划一致，记录以便追溯 |
| X-04 | 「`researchCards.test.tsx` 至少一条改经 `<ToolCard>`」 | 未改 `researchCards.test.tsx`，改在 `ToolCard.test.tsx` 新增「T-01」describe（4 例走完整 ToolCard → normalize → researchToolCard 路径） | 集成路径已有守卫，且 `researchCards.test.tsx` 的分派用例本就是单元级，混入渲染路径反而降低定位效率 |

## 7. 验证（阶段 B）

全部在工作树 `d:\code\test_project\test123\wt\tools` 跑（HEAD `e569f9e66` + 本文档）。

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ `tsc -b` 0 错误（23s） |
| 模块单测 | `cd packages\web-react; npx vitest run src/components/tool src/components/ToolCard.test.tsx src/components/InspectorPanel.test.tsx src/components/AgentAvatar.test.tsx --maxWorkers=1` | ✅ **22 files / 390 tests 全绿**（39s；阶段 A 基线 19 files / 340 tests → +3 文件 / +50 用例） |
| 真浏览器门 | `cd packages\web-react; $env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser` | `run.mjs` 组件门 **67/67 ok**（含工具卡 T6/T12/T13/T21/T36/T41，T13 已带卡内触控靶断言）。随后 `node --test` 16 文件 73 例：**70 通过 / 3 失败**，3 条全部在 `cc-switch-ascii-name.node-test.mjs`（settings 的 `ApiKeysSection`：等不到「还没有 API Key」文案 + 模型 id 断言 `gemini-3.8-flash` vs `sonnet-5`）。在**未改动的主克隆** `v5-selfhost`（integration `43b7cd3a4`）单跑同文件 → 0/2 通过，**基线失败**，`docs/audit/INTEGRATION.md` 已登记，与本模块无关。日志 `D:\code\test_project\test123\.audit-tmp\tools\test-browser.log` |
| 场景文件类型检查 | `npm run typecheck:preview` | `scenes-tools.tsx` **0 错误**；剩余 3 个错误全部在 `scenes-taskboard.tsx`（taskboard owner，与阶段 A 时相同） |
| 代码风格 | `npx biome check <阶段 B 改动的 28 个文件>` | 36 条诊断，**与 integration 基线上同一批文件的诊断逐条相同**（format ×20、organizeImports ×10、`noArrayIndexKey` ×3、`run.mjs` 的 `useTemplate` ×2 / `noDelete` ×1，仅行号平移）→ 阶段 B **新增 0 条**；新建的 7 个文件（`inlineAction.tsx`/`shellEnvelope.ts`/`status.ts`/`tone.ts` + 3 个测试）0 诊断。未对既有文件整文件重排以免 diff 噪音 |
| after 截图 | `$env:OC_UI_SHOTS='D:\code\test_project\test123\.audit-tmp\tools\after'; $env:OC_UI_SCENES='tools'; node browser-tests\ui-preview\shoot.mjs` | ✅ 24 张（6 场景 × desktop/mobile × light/dark）「全部成功」；亮色 12 张按 1800px 切到 `after\crops\` 与 `before\crops\` 逐张对照（下表） |

after / before 对照结论（用 Read 逐张看图）：

| 证据 | 对照 |
|---|---|
| `tools-states--desktop--light` part00 | T-16 图片生成运行中由绿字变 spinner + muted；T-26 「读取 …」「搜索 "x"」动词去除 |
| `tools-states--desktop--light` part01 / `--mobile` part01 | T-02 「终端 · 未成功」表头由 `{"success":{"command"…` 变 `browserType.launch: Executable doesn't exist…`；T-03 展开体由整段 JSON 变 stderr（danger）+「退出码 1」；T-11 mobile 错误首行独立成表头下一行，摘要不再被挤成 `n…` |
| `tools-oc-cli--desktop--light` part00 | **T-01** 「研究报告」卡由一行路径变完整产物卡（报告已生成 / 12 条参考文献 / 1 处未接地 / report.pdf 下载 + 预览 / report.qmd）；T-28 「文献检索 touch target size mobile」「引用铸造 10.1145/…」表头有了摘要；T-15 卡内重复小标题「文献检索」消失只留「3 篇」；T-13 徽标统一为药丸 Badge |
| `tools-bodies--mobile--light` part00 / part01 / part02 | T-10 390px diff 单行号列 + 横滑，全新增 diff 无空旧行号列；T-12 截断行合并为「已显示前 60 行 · 展开全部（共 96 行）」；T-08 「已截断 · 展开全部（共 5,432 字）」行在 hover:none 下撑到 44px；T-27 `The file has been updated.` → 「文件已更新」；T-30 「行 1, 70 行」→「从第 1 行起 · 读取 70 行」 |
| `tools-mcp--desktop--light` part01 | T-14 定时任务 / 技能条目由「圆角 xl + 阴影」卡中卡收成轻边框行，间距收紧 |
| `tools-inspector--desktop--light` | T-04/T-05 面板头「完成」徽标与卡一致，diff 全文渲染正常（复制全文取 diff 文本由单测守） |

## 8. 遗留

本模块归属文件内**无遗留问题**（31/31 已修）。以下为跨模块 / 需接线项，按任务书交集成②或对应 owner：

| 编号 | 位置（owner） | 状态 | 说明 |
|---|---|---|---|
| T-18 接线 | `App.tsx`（shell / 集成②） | ⏸ 待接线 | 在 `ArtifactInspectContext.Provider` 内再包一层 `<ArtifactInspectActiveContext.Provider value={inspectTarget?.message ?? null}>`（`tool/context.ts:95` 有注释）；不接线只是没有选中态描边，功能不受影响 |
| X-01 | `components/chat/delegateProcessList.tsx:132`（messages） | ⏸ 未修 | integration `43b7cd3a4` 上仍是 `h-[min(420px,50vh)]` 固定高，5 步时下方留白 ~200px（P2，建议 `max-h` 代替 `h`） |
| X-02 | `components/chat/AgentGroupCard.tsx:214,218`（messages） | ◐ 部分 | `aria-expanded` 已在 messages-B 加上；图标底 `size-6` 与 ToolCard `size-7` 仍不一致（P3，可不改） |
| X-03 | `lib/cron.ts cronHuman`（manage） | ⏸ 未修 | integration 上 `cronHuman` 仍不人话化 `0 8 * * 1-5` 的星期区间，提醒卡显示两遍原始 cron（P3） |
| 需后端配合 | `delegateFanoutCard.tsx:63` | — | 并行委派子任务名显示 slug（`coding-assistant`），需 mcp-memory 聚合文本带 displayName（§5 已列） |
