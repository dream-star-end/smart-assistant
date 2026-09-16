# QA · 缺口补审交付复核（t-1029）

- 复核对象：t-836 HUD 任务列表 / 后台子任务（G-1/G-2）、t-838 知识星球自动回复面板（G-3）、t-839 杂项 P3（G-4 `?demo=1` / G-5 optionsGroup）、t-865 集成待办清理（INTEGRATION §7.1）。
- 复核基线：工作树 `wt\qa-gap`，分支 `feat/v5-selfhost-audit-qa-gap` = integration `c034f05d7`（集成③ 6/6 之后）+ 三条交付分支干净合入（`0bdc40afc` hud@b1f06f8f5 → `fe35506a1` kp-automation@b0fd16dad → `010b532ee` misc-p3@c834dffa1，无冲突标记）。t-865 的改动已在 integration 上，直接核。
- 角色：测试 / QA（第二双眼睛）。方法：对照各交付文档 §修复记录 / §验证逐项读代码 diff、复跑门禁与用例、按 d-28 用 ui-preview 截图台重出三组截图逐张看图（截图仓外：`D:\code\test_project\test123\.audit-tmp\qa-gap\shots\{hud,kp,misc}\`，manifest 三组 `failures 0 / unmockedApi 0`）。
- **结论：核对 61 项，✅ 59 / ❌ 2；两处 ❌ 均已在本分支修复并验证**（§1.18 typecheck:preview 红、§2.14 KP-14 忙态单键）。未发现回归；已声明的遗留项仍开放（§5）。

## 1. t-836 · HUD 任务列表 / 后台子任务（G-1/G-2）

来源：`docs/audit/hud.md` §6–§8。代码：`components/chat/PinnedTaskTracker.tsx` / `PinnedDelegateTracker.tsx`、`hooks/useInflightDelegates.ts`、`browser-tests/ui-preview/scenes-hud.tsx`、`browser-tests/run.mjs`（T61 一行）。

| # | 核对项 | 结论 | 证据 | 处置 |
|---|---|---|---|---|
| 1.1 | H-01 失败 / 取消 / 被终止的终态同样显示原因，失败用 danger 色 | ✅ | `PinnedDelegateTracker.tsx:114`（`summary = terminal ? firstLine(resultSummary)`）、`:135`；`shots\hud\hud-delegate-running--desktop--light.png` 失败行下有红色原因 | — |
| 1.2 | H-02 折叠摘要 390px 可读：状态标 → 名字（窄屏隐藏）→ 目标 truncate → 计时移出 truncate | ✅ | `:268-285`；`hud-delegate-collapsed--mobile--light.png`：「后台任务 3 进行中 ◌ 复核 PinnedDe… ˄ 停止」，目标文本可读、无「00:0」半截计时 | — |
| 1.3 | H-03 头部计数「N 进行中 / N 已结束」，全部结束时摘要回退到最近终态 | ✅ | `:177`、`:248-249`；`hud-delegate-terminal-collapsed--mobile--dark.png`：「后台任务 3 已结束 ✓ 跑 typec… 全部知道了」 | — |
| 1.4 | H-04 头部只有一个 `aria-expanded` 按钮，无 `aria-hidden` 的可点 chevron | ✅ | `:255-293` 单 `<button>`，chevron 为 `aria-hidden` 图标；用例「H-04/05/08/09 头部只有一个切换按钮」 | — |
| 1.5 | H-05 焦点环 inset（外层 `overflow-hidden` 不再裁掉） | ✅ | `PinnedTaskTracker.tsx:35-36` `HUD_TOGGLE_CLS`，两枚 HUD 共用 | — |
| 1.6 | H-06 列表高度 `min(13rem,30dvh)`，窄屏 `min(9rem,30dvh)` | ✅ | `:43-44` `HUD_LIST_CLS`；`hud-stack-expanded--mobile--light.png` 两枚同时展开约占 48% 视口（y≈380–870/1024） | — |
| 1.7 | H-07 queued 空心圆、paused 暂停标，状态标带 `role=img` + `title` + `aria-label` | ✅ | `PinnedDelegateTracker.tsx:84-101`；截图排队项为空心圆；用例「H-07 排队中不转圈、有状态可读名」 | — |
| 1.8 | H-08 `useId` 列表 id，`aria-controls` 只在展开时输出 | ✅ | `:225`、`:259`；`PinnedTaskTracker.tsx:230`、`:249` | — |
| 1.9 | H-09 `sr-only`「展开/折叠任务列表」「展开/折叠后台任务列表」 | ✅ | `:266`；`PinnedTaskTracker.tsx:257` | — |
| 1.10 | H-10 头部「任务列表 N/M」与 inline 卡同名；`run.mjs` T61 断言同步 | ✅ | `PinnedTaskTracker.tsx:259`；`git diff c034f05d7 HEAD -- browser-tests/run.mjs` 仅 1 行；`hud-task-collapsed--desktop--light.png` | — |
| 1.11 | H-11 自动折叠以 `visible` 为门，不再依赖 `active` | ✅ | `PinnedTaskTracker.tsx:223-227`；用例「H-11 刷新后仍在飞同样 3s 自动折叠」 | — |
| 1.12 | H-12 半修：起点 `min(首次观察, updatedAt)`、`title` 注明、超 1h 显示 `h:mm:ss` | ✅（与声明一致） | `:30-37`、`:210-223`、`:280` | 精确起点仍需协议 `startedAt`（§5） |
| 1.13 | H-13 无运行项且终态 ≥2 → 「全部知道了」逐个 `onDismiss` | ✅ | `:234-236`、`:311-324`；截图 1.3 | — |
| 1.14 | H-14 `dismissed` 按会话持久化到 sessionStorage（上限 64、读写 try/catch、换会话回灌） | ✅ | `useInflightDelegates.ts:35-81`、`:98-104`、`:153-155`；用例「dismissed 持久化」3 例 | — |
| 1.15 | H-15 `visibilitychange` 回到前台立即 `pull` | ✅ | `useInflightDelegates.ts:177-184` | — |
| 1.16 | H-16 删 `TodoRow.compact` 死参 | ✅ | `PinnedTaskTracker.tsx:138` 签名只剩 `{ t }` | — |
| 1.17 | H-17 列表溢出底部渐隐，滚到底消失（`useHudListOverflow`） | ✅ | `PinnedTaskTracker.tsx:46-74`；`hud-task-long--mobile--dark.png` / `hud-delegate-running--desktop--light.png` 末行渐隐 | — |
| 1.18 | **门禁：`typecheck:preview`**（S-19 起 ui-preview 场景独立类型检查；t-865 刚把它消到只剩 taskboard 一处等集成③） | **❌** | 复核基线上 `npm run typecheck:preview` **红**：`scenes-hud.tsx(199,49) TS2353` —— 给 `PinnedTaskTracker.tokenUsage`（协议 `TurnTokenUsageSnapshot`）的字面量多了 `estimated`（该字段只在 `LiveTurnTokenUsageSnapshot` 上）。hud 分支自身即红（`git show b1f06f8f5:…scenes-hud.tsx` L195 同写法），交付 §7 只跑了 `typecheck`（`tsc -b` 不含 browser-tests）。日志 `.audit-tmp\qa-gap\typecheck-preview.log` | **已修** `747596782`：改为带类型常量 `ESTIMATED_USAGE: LiveTurnTokenUsageSnapshot` 传入，运行时零变化（徽标仍显示「约1.28m token」，`hud-task-long--*` 截图同）。修后 `typecheck:preview` **0 错**（集成③ 合入 taskboard2 后 TS2322 也已自消） |
| 1.19 | 模块单测 | ✅ | `PinnedTaskTracker.test` / `PinnedDelegateTracker.test` / `useInflightDelegates.test` / `inflightDelegates.test`：4 文件 / **55 例全过**（与交付一致） | — |
| 1.20 | 遗留 H-18「停止本轮」父轮结束仍显示（shell 接线） | 仍开放（非本次 ❌） | integration `App.tsx:3745` 仍 `onStop={stopTurn}` 无条件传 | 归 shell / integ4：`onStop={wsSending ? stopTurn : undefined}`（§5） |

## 2. t-838 · 知识星球自动回复面板（G-3）

来源：`docs/audit/kp-automation.md` §5–§6。代码：`components/settings/KnowledgePlanetAutomationPanel.tsx`（+ `.test.tsx`）、`browser-tests/ui-preview/scenes-kp-automation.tsx`。截图 `shots\kp\`（`OC_UI_SHOT_DELAY=1800`）。

| # | 核对项 | 结论 | 证据 | 处置 |
|---|---|---|---|---|
| 2.1 | KP-01（P1）同意弹层就地报错：客户端 `validateAccountLimit` 1–30 整数先拦并聚焦；服务端拒绝落弹层内 `consentError` | ✅ | `:200-209`、`:358-385`、`:762-797`；用例 KP-01（越界不发请求 + 弹层内可见错误）；`kp-automation-consent--desktop--light.png` 上限字段带标签与范围提示 | — |
| 2.2 | KP-02 规则行改 `CardRow`：主名单行截断、操作区窄屏落第二行右对齐、状态收成 Badge | ✅ | `:637-688`；`kp-automation-list--mobile--light.png` 主名整行可读，开关 / 编辑 / 删除在卡片第二行右侧，徽章「运行中 / 已停用 / 已暂停：…」 | — |
| 2.3 | KP-03 加载失败 Alert 带标题 + 「重试」 | ✅ | `:512-526`；用例 KP-03 | — |
| 2.4 | KP-04 运行记录：状态 Badge + 规则名（已删标注）+ 主题 id + `TimeAgo` + 原因行；summary 带计数 | ✅ | `:695-733`；`kp-automation-runs--desktop--light.png`；用例 KP-04 | — |
| 2.5 | KP-05 星球选项 `aria-pressed`，方框 `aria-hidden`，`<fieldset>` + `sr-only legend` | ✅ | `:896-897`、`:930`、`:941-942`；用例 KP-05/06 | — |
| 2.6 | KP-06 已选星球芯片改 `Chip`，整枚可点、`aria-label="移除 X"` | ✅ | `:970-982`；`kp-automation-validation--mobile--light.png` 药丸芯片 | — |
| 2.7 | KP-07 字段级校验：`{field,error}`、`aria-invalid` + 红描边 + 聚焦滚入，范围 hint 常驻，一改即撤 | ✅ | `:157-198`、`:215-222`、`:414-431`、`:536-540`；`Field` 原语自动接 `aria-describedby`（`ui/Field.tsx:53-78`）；用例 KP-07；截图 2.6 中规则名称字段红描边、错误紧挨保存键 | — |
| 2.8 | KP-08 空态 `EmptyState` + CTA；总开关关着时标题旁说明 | ✅ | `:529-533`、`:612-628`；`kp-automation-off--mobile--dark.png`「先开启上方总开关，再添加规则。」+ 空态图标 / 标题 / 说明；用例 KP-08 | — |
| 2.9 | KP-09 字号收编语义档（`text-[11px]` / `text-[12px]` / `text-micro` 清零） | ✅ | `grep -n "text-\[1[0-9]px\]\|text-micro"` 面板文件 0 命中 | — |
| 2.10 | KP-10 / 11 / 12 / 16 文案 | ✅ | `:574`（写入能力指向「插件账号里」）、`:484`（全角问号）、`:809-810`（编辑态描述）、`:741`（去「自动计费」）；用例 KP-10/11 | — |
| 2.11 | KP-13 选择器宽度跟触发器；「全选可用」 | ✅ | `:856`、`:882`；`kp-automation-new-picker--mobile--light.png` 选择器不探出弹层 | — |
| 2.12 | KP-15 `!available` 时 info Alert 解释总开关不可用 | ✅ | `:578-582` | — |
| 2.13 | KP-17 触发范围改 `ui/Select`，`Field htmlFor` 连线 | ✅ | `:1028-1040`；用例 KP-07 `getByLabelText` 可达 | — |
| 2.14 | **KP-14 分键忙态「只锁正在操作的那一处」**；保存 / 删除 / 开启 toast；切换失败 toast 带重试 | **❌（半落地）** | toast 与 `loading` 都在；但 `busyKey` 是**单值**，`toggleRule` / `deleteRule` / `saveRule` 开头 `if (busy) return`（`busy = busyKey !== null`）：切第一条时第二条开关**看着可用**（`disabled` 只看本行），点下去被静默丢弃 —— 受控 `Switch` 不翻、无 toast、无 loading，正是 KP-01 那类「点了没反应」。交付用例只断言了 `second toBeEnabled()`，没点它 | **已修** `1db992620`：`busyKey` → `busyKeys: ReadonlySet<string>`，`isBusy / beginBusy / endBusy` 按键门控；toggle 与 delete 互斥只限同一行；`控制 / save` 各自成键；`添加规则` 仍在任何写操作期间禁用。用例 KP-14 追加断言：第一条在飞时点第二条 → `patch` 第二次调用（`rule_2 {enabled:true}`）。修后面板 + `ConnectorsTab` 2 文件 **70 例全过**，`biome lint` 0 |
| 2.15 | 模块单测 | ✅ | `KnowledgePlanetAutomationPanel.test` + `ConnectorsTab.test`：2 文件 / 70 例全过（`ConnectorsTab` 2 例直接驱动本面板新建 / 编辑弹层） | — |
| 2.16 | 不修项 KP-18 / KP-19 / 弹层形态 / Checkbox 原语 | ✅（理由成立） | 与 market K-27、shell 口径一致 | — |

## 3. t-839 · 杂项 P3（G-4 `?demo=1` / G-5 optionsGroup）

来源：`docs/audit/misc-p3.md` §3–§5。代码：`lib/demo.ts`（+test）、`components/Message.tsx`、`components/optionsGroup.tsx`（+test）、`components/RichBlocks.tsx`、`components/MarkdownImpl.tsx`、`scenes-misc-p3.tsx`。截图 `shots\misc\`（`OC_UI_SHOT_DELAY=1800`）。

| # | 核对项 | 结论 | 证据 | 处置 |
|---|---|---|---|---|
| 3.1 | D-01 `demoReply` 模型名与 `DEMO_MODELS[0]` 同源 | ✅ | `demo.ts` `DEMO_DEFAULT_MODEL_NAME` / `demoReply(text, modelName = …)`；`demo.test.ts` | — |
| 3.2 | D-02 `messageCount` 与 fixture 对齐（s1=2，其余 0）；`DEMO_MESSAGES_BY_SESSION` | ✅ | `demo.ts` diff；`demo.test.ts` | 余项（App `onDemoSelect` 一行）归 shell（§5） |
| 3.3 | D-03 每条 demo 会话补 `createdAt`（早于 `updatedAt`） | ✅ | `demo.ts` `epoch()`；typecheck 绿说明 `Session.createdAt` 类型对上 | — |
| 3.4 | D-05 `OptionsGroupProvider live={!!streaming}` 与 `chat/cards` 同口径 | ✅ | `Message.tsx:75-77` | — |
| 3.5 | D-06 流式三点改 `<output aria-live="polite" aria-label="正在生成回复">`，装饰点 `aria-hidden` | ✅ | `Message.tsx:84-88` | — |
| 3.6 | OG-01（P2）注册改 `useLayoutEffect`；点击时刻读 `store.getSnapshot().grouped` | ✅ | `RichBlocks.tsx` diff（`useLayoutEffect`、`groupedNow()` 用于 `choose` / `confirmMulti`）；`misc-options-partial--desktop--light.png`：三题均聚合、页脚「已作答 2 / 3 题 —— 未答的 1 题会标为「未答」一并发出」，无隐式发送 | — |
| 3.7 | OG-02（P2）`MarkdownImpl.components` `useMemo`（deps `signMedia / blockImages / readOnly`，`live` 走 ref）；`Snapshot.grouped = count>=2 ∥ live ∥ answered>=1` | ✅ | `MarkdownImpl.tsx:306-425` —— 审读闭包：除三项依赖与 `liveRef` 外只引用模块级组件 / 常量，无陈旧闭包；`optionsGroup.tsx` `isOptionsGrouped`；`misc-options-live-ended-pending--desktop--light.png` 流式结束后高亮与页脚保留、可发送；用例「live 翻转前后选项按钮同一 DOM 节点」 | — |
| 3.8 | OG-03 / 06 / 07 页脚文案与 live region；OG-04 发送键走 `ui/Button variant=accent` | ✅ | `optionsGroup.tsx` diff；截图 3.6 页脚 `<output>` + accent 按钮；`misc-options-sent--*` | — |
| 3.9 | 不修 / 设计项 D-04、D-09、OG-05、OG-08 | ✅（理由成立） | OG-05 被 8 处断言与历史数据锁定，单独立项合理 | — |
| 3.10 | 越界改动（RichBlocks / MarkdownImpl）已知会、拿锁 | ✅ | 文档 §0 声明；无 `App.tsx` / `components/ui` 改动（`git diff --stat` 22 文件内无） | — |
| 3.11 | 相关单测（含 messages 使用方回归） | ✅ | `optionsGroup.test` / `demo.test` / `RichBlocks.test` / `MarkdownImpl.test` / `Markdown.test` / `cards.test` / `MessageRenderer.test` / `App.test`：**167 例过**；`MessageRenderer.test` 首跑 `beforeAll` 10s 超时（150 例 skipped）—— 与 INTEGRATION §6 已知「全量并行偶发」同款，**单跑 150/150 全过**（日志 `vitest-messagerenderer.log`） | 记为环境偶发，不计 ❌ |
| 3.12 | 真浏览器门（改到消息面） | ✅ | 本工作树 `npm run test:browser`：`run.mjs` **68/68 ok**；`node --test` 见 §6 | — |

## 4. t-865 · 集成待办清理（INTEGRATION §7.1）

来源：`docs/audit/INTEGRATION.md` §7.1。在 integration `c034f05d7` 上逐行核。

| # | 待办 | 结论 | 证据 | 处置 |
|---|---|---|---|---|
| 4.1 | `typecheck:preview` TS5097 ×2 → `allowImportingTsExtensions` | ✅ | `packages/web-react/tsconfig.browser-tests.json` 含 `"allowImportingTsExtensions": true`；本轮 `typecheck:preview` 无 TS5097 | — |
| 4.2 | TS2322 `scenes-taskboard.tsx` 等集成③自消 | ✅ | taskboard2 `05dd185df` 已由 `425655631` 合入；本轮（修 1.18 后）`typecheck:preview` **0 错** | — |
| 4.3 | composer 排队气泡 `status=queued` 已具备 | ✅ | `chat/cards.tsx:439` `queued: "排队中"`、`:522` 状态分支 | — |
| 4.4 | C-32 团队卡副标题用 `DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME` | ✅ | `AgentPicker.tsx:224`；`AgentPicker.test` / `App.test` 在 t865 批次通过 | — |
| 4.5 | media X-M2 preview 字号收编 caption / meta token，summary 44px | ✅ | `styles.css:674-677` `.preview-error-details summary { min-height:44px; font-size: var(--text-meta) }`；余下 `font-size: 11px` 仅 `.preview-anchor-dot`（28px 圆点内的序号，图标性质，不在 X-M2 清单）与 `.markdown-table-hint`（messages） | 可接受，不计 ❌ |
| 4.6 | media X-M3 `Sheet` 可选 `closeButton / closeLabel`（opt-in） | ✅ | `ui/Sheet.tsx:50-51`、`:65-67`；`ui/Sheet.test.tsx` 3 例过 | 各抽屉是否开启仍留 owner（原文已声明） |
| 4.7 | media X-M4 `MediaTaskCenter.onReusePrompt` + App 接线 | ✅ | `MediaTaskCenter.tsx:312-322`；`App.tsx:4047` `onReusePrompt={…}`；`MediaTaskCenter.test` 14 例过 | — |
| 4.8 | TU-37 转 t-53 | ✅ | tutorials `02c358655`「门禁标记路径归一化」已由 `ce767d8ce` 合入 integration | — |
| 4.9 | 受影响用例 | ✅ | `Sheet` / `MediaTaskCenter` / `AgentPicker` / `ContainerWebPreview` / `designTokens`：5 文件 / **115 例全过** | — |

## 5. 遗留（复核确认仍开放，均为原交付已声明、归属明确的跨模块项）

| 项 | 归属 | 现状 |
|---|---|---|
| H-18 父轮结束后「停止本轮」仍显示 | shell（`App.tsx:3745`） | `onStop={stopTurn}` 仍无条件传；一行 `wsSending ? stopTurn : undefined` 即可，建议 integ4 / archive 登记 |
| H-12 计时精确起点 | 需后端 `startedAt` | 前端半修到位 |
| H-20 `TokenUsageBadge` 流式重放入场动画 / `--faint` 对比度 | messages / shell | 未动 |
| D-02 余项 demo 其余会话 `onDemoSelect` | shell（`App.tsx` `onDemoSelect`） | `DEMO_MESSAGES_BY_SESSION` 已备好，App 未接 |
| D-08 demo 交互块未说明原因、OG-05 半角标点、OG-09 发送失败无恢复 | shell + messages | 未动 |
| KP-18 / KP-19 | settings | 不修（理由成立） |

## 6. 验证（均在 `wt\qa-gap`，修复提交后）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0（修前亦绿） |
| 场景类型检查 | `cd packages\web-react; npm run typecheck:preview` | 修前 ❌ TS2353 ×1（1.18）→ **修后 ✅ 0 错** |
| HUD 单测 | `npx vitest run src/components/chat/PinnedTaskTracker.test.tsx src/components/chat/PinnedDelegateTracker.test.tsx src/hooks/useInflightDelegates.test.ts src/lib/chat/inflightDelegates.test.ts --maxWorkers=1` | ✅ 4 文件 / 55 例 |
| KP 单测 | `npx vitest run src/components/settings/KnowledgePlanetAutomationPanel.test.tsx src/components/settings/ConnectorsTab.test.tsx --maxWorkers=1` | ✅ 2 文件 / 70 例（含 KP-14 新增断言，修前该断言会红） |
| misc-p3 单测 | `npx vitest run src/components/optionsGroup.test.tsx src/lib/demo.test.ts src/components/RichBlocks.test.tsx src/components/MarkdownImpl.test.tsx src/components/Markdown.test.tsx src/components/chat/cards.test.tsx src/components/MessageRenderer.test.tsx src/App.test.tsx --maxWorkers=1` | ✅ 167 例；`MessageRenderer.test` 首跑 hook 超时 → 单跑 ✅ 150/150（INTEGRATION §6 已知偶发） |
| t-865 单测 | `npx vitest run src/components/ui/Sheet.test.tsx src/components/MediaTaskCenter.test.tsx src/components/AgentPicker.test.tsx src/components/ContainerWebPreview.test.tsx src/test/designTokens.test.ts --maxWorkers=1` | ✅ 5 文件 / 115 例 |
| 代码风格 | `npx biome lint <本轮 3 个改动文件>` | ✅ 0 诊断 |
| 真浏览器门 | `cd packages\web-react; $env:OC_E2E_BROWSER='…chrome.exe'; npm run test:browser` | `run.mjs` ✅ 68/68；`node --test`：见下行 |
| 视觉 | `OC_UI_SCENES=hud- / kp-automation / misc-`（后两组 `OC_UI_SHOT_DELAY=1800`）`node browser-tests\ui-preview\shoot.mjs` → `.audit-tmp\qa-gap\shots\{hud,kp,misc}` | ✅ 40 + 56 + 24 = 120 张，三组 `failures 0 / unmockedApi 0`；关键图逐张 Read，对照见 §1–§3「证据」列 |

`node --test`（`test:browser` 后半段）：73 例 **70 过 / 3 失败**，三处均为基线 / 环境既有、与四条交付无关：`cc-switch-ascii-name` ×2（settings `ApiKeysSection` 模型 id 断言 `expected 'gemini-3.8-flash' / actual 'sonnet-5'`，INTEGRATION §6 基线）、`ocv5-185-qa` ×1（Windows `symlinkSync` EPERM `packages/protocol → node_modules/@openclaude/protocol`，环境项，集成②口径预建 junction 后可绿）。日志 `.audit-tmp\qa-gap\test-browser.log`。

**NOT RUN**：全量 `npm test`（改动面已被上述 20 个测试文件覆盖，全量门留 integ4 合入后统一跑）；`.audit-tmp` 截图不入库；真机 iOS Safari。

## 7. 本分支改动（供 integ4 合入）

| 提交 | 文件 | 内容 |
|---|---|---|
| `747596782` `test(v5)` | `browser-tests/ui-preview/scenes-hud.tsx` | 1.18：估算用量改 `ESTIMATED_USAGE: LiveTurnTokenUsageSnapshot` 常量，消 TS2353 |
| `1db992620` `refactor(v5)` | `src/components/settings/KnowledgePlanetAutomationPanel.tsx`、`.test.tsx` | 2.14：`busyKeys` 集合门控 + 用例补「第一条在飞时第二条点击真的发请求」 |
| 本文 `docs(v5)` | `docs/audit/qa/qa-gap.md` | 复核报告 |

合入提示：本分支 = integration `c034f05d7` + hud / kp-automation / misc-p3 三条分支 + 上述提交；三条分支本身尚未合入 integration（集成④范围），整支 fast-forward 合入即可同时带上它们，或按分支单独 cherry 上述三个提交。
