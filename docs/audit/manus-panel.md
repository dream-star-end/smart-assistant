# manus-panel · M3-1 右侧「Agent 电脑」面板（F1.1–F1.6 + F2.2 + F2.5 面板侧 + F4）

| 项 | 值 |
|---|---|
| 任务 | t-2329（协同组「v5个人版agent会话界面改造」M3-1） |
| 分支 / 基线 | `feat/v5-selfhost-manus-panel` @ `839ad4420`（工作树 `wt/manus-panel`） |
| 日期 | 2026-09-20 |
| 作者 | fable-5-1-30 —— **指挥官兼执行人**（组内无在线 worker、spawn_session 忙；利益冲突已在 d-2327 声明，独立 QA 见 M4 t-2332） |
| 依据 | `PRD_MANUS_A.md` §5 F1 / F2.2 / F2.5 / F4、§7；`DESIGN_MANUS_A.md` §2–§8、§12–§14、§16–§17；`ACCEPTANCE_PLAN_MANUS_A.md` §2–§5 |

## 1. 文件级改动计划

### 1.1 新增文件（`packages/web-react/src/` 下）

| 路径 | 职责 | 关键导出 |
|---|---|---|
| `lib/chat/agentPanelFollow.ts` | 跟随 / 固定 / 步骤状态机（纯函数）+ 选择器 | `type AgentPanelMode = "hidden" \| "follow" \| "pinned"`；`type AgentPanelState = { mode; targetIndex; externalTarget: ToolLike \| null; turnStart; closedTurnStart: number \| null; openNonce }`；`topLevelToolIndices(messages, turnStart)`；`isRunningTool(m)`；`autoTargetIndex(messages, turnStart)`；`agentPanelReduce(state, action)`；`initialAgentPanelState()`；`stepInfo(state, messages) → { k, n, indices }` |
| `lib/agentPanelCollapsed.ts` | rail 偏好持久化 | `AGENT_PANEL_COLLAPSED_KEY = "oc_v5_agent_panel_collapsed"`、`readAgentPanelCollapsed()`、`writeAgentPanelCollapsed(v)` |
| `lib/chat/__fixtures__/agentComputer.ts` | vitest 与 ui-preview 共享假数据工厂（ACCEPTANCE §2.2） | `userMsg / assistantMsg / toolMsg / agentGroupMsg / todoWriteMsg / planMsg`；`TODOS_3_OF_7`、`TURN_RUNNING_7`、`TURN_SETTLED_5_OF_5`、`TURN_ABORTED_3_OF_5`、`TURN_DELIVERABLES`、`SESSION_3_TURNS_FILES`、`TURN_PLAIN_CHAT`、`TURN_LONG_200`（均为工厂函数，避免多次 render 共享同一对象引用） |
| `components/agentPanel/actionKind.ts` | 5 类动作类型映射（DESIGN §5），叠在 `tool/meta.ts` 之上 | `type ActionKind = "terminal" \| "file" \| "web" \| "search" \| "other"`；`resolveActionKind(name, input, output?) → { kind, label, icon, tone }` |
| `components/agentPanel/strings.ts` | 文案表 T-01…T-42 常量 | `AGENT_PANEL_STRINGS`（含模板函数 `railLabel(kind,k,n,status)`、`chipLabel(kind,k,n)`、`liveAnnounce(k,n,label)`、`stepLabel(k,n)`、`progressLabel(c,n,step)`） |
| `components/agentPanel/AgentPanel.tsx` | `AgentPanelContent`：A 面板栏 / B 动作栏 / C 进度行 / （可选）Tabs / 网页工具条 / 正文；aside 与 Sheet 共用 | `AgentPanelContent(props)`；`findContainerPreviewUrl(display)` |
| `components/agentPanel/AgentPanelChip.tsx` | 窄屏 chip（DESIGN §8.1） | `AgentPanelChip({ kind, k, n, status, onClick })` |
| `components/agentPanel/AgentPanelHost.tsx` | 组合：状态机 hook + 桌面 aside / rail + 窄屏 Sheet + chip（可 portal 到 `chipSlot`） | `useAgentPanelController(messages, sending, opts)`；`AgentPanelHost(props)`；`AgentPanelRail` |
| 对应测试 | `agentPanelFollow.test.ts`、`actionKind.test.ts`、`strings.test.ts`、`AgentPanel.test.tsx`、`AgentPanelHost.test.tsx` | 见 §1.6 |
| `browser-tests/ui-preview/scenes-agent-computer.tsx` | 场景 #1 #2 #3 #4 #9 #10 #11 #12 #13 #14 + before 场景 | `agentComputerScenes: Scene[]` |

### 1.2 修改文件

| 路径 | 改哪里 | 怎么改 |
|---|---|---|
| `App.tsx` L432（`inspectTarget` state）、L775–779（切会话清空）、L2437–2441（`artifactInspect` open）、L3448（`ArtifactInspectActiveContext` value）、L3800–3819（composer-safe-b 内 HUD 之后）、L3952–3971（第三列 + Sheet） | 用 `useAgentPanelController(wsMessages, wsSending, { enabled: !boardOpen && !demo && !gated, sidebarWidth: collapsed ? 0 : sidebarWidth.width })` 取代 `inspectTarget`；`artifactInspect.open(t)` → `controller.pinMessage(t.message)`；Active context value = `controller.target`；切会话 / 进出看板 → `controller.reset()`；composer-safe-b 里放 `<div ref={chipSlotRef} className="md:hidden" />`；第三列位置渲染 `<AgentPanelHost controller={controller} chipSlot={chipSlot} onOpenPreview={setContainerPreviewUrl} />` |
| `InspectorPanel.tsx` | **不改** | 保留为旧入口（`tools-inspector` 场景、`InspectorPanel.test.tsx` 仍用它）；新面板复用其导出的 `inspectorCopyText`。AC1.6.1 因此零改动通过 |

### 1.3 状态机（对照 DESIGN §6.2）

k/n：`indices = topLevelToolIndices(messages, currentTurnStartIndex(messages))`（`role === "tool"` 的顶层行；agent-group 子块不是独立行，天然不计），`n = indices.length`，`k = indices.indexOf(targetIndex) + 1`；用下标不用 id（SURVEY B7）。`isRunningTool(m) = !m._completed && !m.error && !m.cancelled && !(m._timelineRecord && m._dispatchOutcome === "interrupted")`（与 `resolveToolStatus` 的运行中口径一致，纯函数版）。

| 事件（action） | hidden | follow | pinned |
|---|---|---|---|
| `sync(messages, sending)`：turnStart 变化（新 user 消息） | 清 `closedTurnStart`；有顶层 tool → follow(autoTarget) | 目标序列换到新 turn，`autoTarget` | → follow(autoTarget) |
| `sync`：同 turn，新顶层 tool | `closedTurnStart !== turnStart` → follow(autoTarget)（`openNonce` 不变 = 自动打开，不移焦） | 目标 = `autoTarget`（最近运行中，否则最后一条）；目标变化 → `announce` | 不动 |
| `sync`：turn 收口（sending false / 收口证据） | — | 保留目标，头部去「实时」 | 不动 |
| `pin(index)` / `pinMessage(message)`（点卡、点 chip、点产物预览） | → pinned，`openNonce++`（用户主动 → 移焦） | → pinned，`openNonce++` | 目标 = index，`openNonce++` |
| `step(±1)` / `←` `→` | — | → pinned，目标 ±1 | 目标 ±1，边界夹住 |
| `follow()` | — | — | → follow(autoTarget) |
| `close()` | — | → hidden，`closedTurnStart = turnStart` | 同左 |
| `reset()`（切会话 / 进出看板） | → 初始态 | 同左 | 同左 |

`externalTarget`：`pinMessage` 传入的对象不在顶层 tool 行里（agent-group 子块工具）时进入 pinned 且 `targetIndex = -1`，头部 k/n 隐藏、步进禁用，「回到最新」可用。

### 1.4 自动打开落点（★4）

`autoOpenExpanded = !readAgentPanelCollapsed() && (viewportWidth − sidebarWidthPx − asideWidthPx) ≥ 512`，其中 `asideWidthPx = clamp(320, 0.36 × viewportWidth, 544)`（与 `w-[clamp(20rem,36vw,34rem)]` 同值），`sidebarWidthPx` 由 App 传入（折叠为 0）。空间不足时自动打开为 rail **但不写偏好**；用户手动折叠 / 展开才写 `oc_v5_agent_panel_collapsed`。

### 1.5 a11y / 焦点

- 自动打开与自动跟随不移焦（`openNonce` 不变）；`pin*` 使 `openNonce++` → effect 把焦点移到 `[data-inspector-close]`，并记住 `returnFocus`；aside 卸载时归还。
- `aria-live="polite"` sr-only 区仅在 follow 模式目标变化时写 `T-09`；pinned / rail 不播报。
- `Esc` 沿用 InspectorPanel 规则（可编辑元素内且不在 aside 内时不抢；`defaultPrevented` 让位）；`←/→` 仅焦点在 aside 内且非可编辑元素时步进。
- aside `aria-labelledby` 指向 A 栏面板名 `T-01`；h2 = `meta.label`。

### 1.6 测试清单（文件::describe › it → AC）

- `agentPanelFollow.test.ts`：autoOpen › 首条顶层工具到达即打开并选最后一条运行中（1.1.1）；autoOpen › 无运行中则选最后一条已结束；autoOpen › 刷新后最后一条 running 自动打开（_timelineRecord 行）（F4-7）；follow › 追加顶层 tool 切换目标（1.1.2）；follow › 追加 agent-group 子工具不切换（1.1.2）；follow › turn 收口保留目标不关闭；pin › pin 后追加不切换（1.1.3）；pin › 回到最新恢复 follow（1.1.3）；close › 关闭后本 turn 新工具不再打开（1.1.4）；close › 新 user 消息后的工具重新打开（1.1.4）；steps › n 只数顶层 tool（1.3.3）；steps › prev/next 边界不越界（1.3.2）；边界 › 用户中止（interrupted）视为收口。
- `actionKind.test.ts`：resolveActionKind › 内置五样本 Bash/Edit/Read/WebSearch/未知 → terminal/file/file/search/other（1.2.1）；Bash heredoc 写文件 → file；oc-browser / oc-web → web；mcp__browser__* → web；browser_evaluate → terminal；oc-lit / Grep / Glob → search；oc-report / oc-pdf → file；记忆更新 → file；TodoWrite / Task → other；label › 五类文案与 T-30…34 一致（F4-4）。
- `AgentPanel.test.tsx`：头部 › h2=meta.label，状态徽标=resolveToolStatus；头部 › follow+running 显示「实时」/ pinned 显示「已固定」+「回到最新」/ follow+settled 无徽标；步进 › 3/7 → 下一步 4/7 且摘要切换（1.3.1）；步进 › k=1 上一步 disabled、k=n 下一步 disabled（1.3.2）；进度行 › 与 HUD c/n 恒等、无 todos 不渲染（2.2.1 / 2.5.1）；网页工具条 › 容器 loopback URL → 打开预览回调收到归一化 URL，https 外链无工具条（1.2.2）；文案 › 未知 MCP 名不出现在头部（F4-4）。
- `AgentPanelHost.test.tsx`：桌面 › 无点击渲染 aside，h2=工具标签，状态=运行中（1.1.1）；桌面 › 无 tool 不渲染 aside（1.1.5）；固定 › 点第 k 张卡后追加新工具目标不变且出现回到最新 / 点回到最新切回（1.1.3）；折叠 › 点折叠写 localStorage，重挂载以折叠态出现（1.4.1）；折叠 › rail 随新工具更新 k/n（1.4.2）；窄屏 › 进行中渲染 chip 且 min-h-11、点 chip 打开 Sheet 内容=当前目标（1.5.1）；窄屏 › 收口后 chip 不渲染（1.5.2）；a11y › aside aria-labelledby 指向存在元素、自动打开不移焦、手动打开焦点进关闭按钮、aria-live 只写一次（F4-2）。
- `strings.test.ts`：文案表快照（F4-4）。
- 存量必过：`InspectorPanel.test.tsx`、`ToolCard.test.tsx`（文件未改）。

### 1.7 场景（`scenes-agent-computer.tsx`，id 以 `agent-computer-` 开头，group `'工作区'`）

`agent-computer-running`（#1，desktop+mobile）、`-pinned`（#2，AfterMount 点「上一步」×4）、`-plain-chat`（#3，desktop+mobile）、`-no-plan`（#4）、`-mobile-chip`（#9，mobile）、`-mobile-sheet`（#10，mobile，AfterMount 点 chip）、`-collapsed`（#11，render 前写偏好键）、`-kinds`（#12，5 个 AgentPanelContent 并排）、`-web-preview`（#13）、`-progress-row`（#14，AfterMount 点进度行）、`-long-turn`（#18 可选）、`-before-inspector`（§3.0 before，用旧 InspectorPanel）。舞台 `AgentComputerStage`：Sidebar（真组件）| main（ChatHeader → MessageList → HUD → chip 槽 → Composer）| `AgentPanelHost`。

### 1.8 风险与对策

1. **首屏预算极紧**：基线 448.3 KiB / 460.0 KiB，余量 11.7 KiB gzip（§2）。对策：只复用已在闭包内的 `ToolBody`、`ui/*`、lucide；strings 精简；不引入依赖；Tabs「文件」页签内容由 M3-3 以 `lazy` 提供；交付前复测 §2 脚本，超 8 KiB 增量即拆 lazy。
2. **与 M3-2 / M3-3 的接缝**：进度行需要 `TodoRow`（PinnedTaskTracker 未导出，且该文件归 M3-2）→ 本任务内写只读 `ProgressRow` 最小实现，注明待 M3-2 导出后合并；`FilesTab` 由 `filesTab` prop 注入，未注入时不渲染 Tabs。
3. **存量 InspectorPanel 测试**：不改该文件即零风险；App 不再引用它属预期（场景 tools-inspector 仍引用）。
4. **`_completed` 口径**：ChatSocket 就地 mutate 同一对象，reducer 每次 render 重新 `sync`，O(当前 turn 长度)；≥200 条工具仍为一次线性扫描。
5. **Radix Sheet 焦点陷阱**：Sheet 形态由 Radix 管焦点，`pin*` 的移焦 effect 只在 aside 形态执行。

### 1.9 与 DESIGN / ACCEPTANCE 的出入

- ACCEPTANCE §2.1 `AgentPanelHost` 的 `viewport` prop 与 §3.2「不硬编码 viewport」二选一 → 采用内部 `useMdViewport`（jsdom 测试用 `matchMedia` 桩切换）。
- DESIGN §4.3 进度行「复用 PinnedTaskTracker 的 TodoRow」→ TodoRow 未导出且文件归 M3-2，改为本任务内最小只读行（视觉同源：`Check` / `LoaderCircle` / `Circle` + 删除线）。
- ACCEPTANCE §3.1 一个 `scenes-agent-computer.tsx` 由三人共改 → 拆为三文件（本任务只写 panel 场景），id 前缀不变，`OC_UI_SCENES='agent-computer'` 一次全跑。
- `normalizeContainerPreviewUrl` 在 `@openclaude/protocol/containerPreview`（非 `lib/containerPreview.ts`），非 loopback 会 throw → 用 try/catch 包裹。

## 2. 基线门禁余量实测（未改代码，`npm run build --workspace packages/web-react`，2026-09-20 23:58）

- build 通过（27.5s，无 first-screen-budget 抛错）；`dist/assets/main-*.js` gzip 134.15 kB（vite 报告）。
- 首屏集合（`dist/index.html` 的 modulepreload + 入口 script，13 个文件，gzip level 9 求和，脚本 `.audit-tmp/manus-panel/first-screen-size.mjs`）：**459 061 bytes = 448.3 KiB**；预算 `FIRST_SCREEN_GZIP_BUDGET = 471 040` = 460.0 KiB；**余量 11.7 KiB**。前 4 项：main 133 120 / tapePayload 126 133 / styles 79 910 / react-vendor 56 591。
- 结论：本任务新增代码进入入口静态闭包，目标增量 ≤ 8 KiB gzip；「文件」页签与产物卡（M3-3）必须 lazy。这一条顶替已停摆的 A0d「门禁余量实测」。

## 3. 实现记录

（待填）

## 4. 验证

（待填）

## 5. 遗留

（待填）
