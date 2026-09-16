# 杂项 P3 · `?demo=1` 演示模式 + optionsGroup 多题聚合 · 轻审 + 修复（t-839，补 t-760 缺口 G-4 / G-5）

- 分支 `feat/v5-selfhost-audit-misc-p3`（基线 `210b9967`；开工先合入 integration `feat/v5-selfhost-ocv5-audit-ux @ 1d8eaf769`，让 `Message.tsx` / `RichBlocks.tsx` 等已合入改动成为本分支的基线，避免集成③再撞）。工作树 `wt\misc-p3`。
- 流程 A→B 同人合一，编号 `D-xx`（demo）/ `OG-xx`（optionsGroup）。严重度口径 TEAM_PLAYBOOK §5。
- 结论：**D 9 条（P3 9）/ OG 9 条（P2 2 · P3 7）**；修复 D 5 / OG 7，其余为不修（有判据）或壳层 / 后端遗留。
- 越界改动（均已 `send_to` 指挥官知会、拿锁）：`components/RichBlocks.tsx`（OptionsBlock 3 处小改）、`components/MarkdownImpl.tsx`（`components` 记忆化）。**未改 `App.tsx` 等壳层入口，未改 `components/ui`。**

## 1. 范围与文件清单

| 面 | 文件 | 归属 |
|---|---|---|
| demo 数据 | `src/lib/demo.ts`（+ 新增 `demo.test.ts`） | 本任务 |
| demo 渲染通道 | `src/components/Message.tsx` | 本任务 |
| 壳层 demo 分支（**只审不改**） | `src/App.tsx` 约 60 处 `demo ?` / `!demo &&`、`hooks/useSessionList.ts` | shell |
| 多题聚合 | `src/components/optionsGroup.tsx`（+ 新增 `optionsGroup.test.tsx`） | 本任务（归属表漏项，见 §7） |
| options 块本体 | `src/components/RichBlocks.tsx` `OptionsBlock` | messages（越界，已知会） |
| Markdown 渲染器 | `src/components/MarkdownImpl.tsx` | messages（越界，已知会） |
| 场景 | `browser-tests/ui-preview/scenes-misc-p3.tsx`（新增 7 场景） | 本任务 |

## 2. 方法与证据

- 代码走读：上表全部文件；`App.tsx` 的 demo 分支按「demo 下被 `undefined` 关掉的能力 → 对应 UI 入口是否随之隐藏 / 文案是否自洽」逐条过。
- ui-preview 截图台（d-28）：新增 `scenes-misc-p3.tsx`，交互态用挂载期 `AutoAct` 按可见文本点按钮、`OC_UI_SHOT_DELAY=1800` 后截图。场景：`misc-demo-empty`、`misc-demo-stream`（desktop/mobile）、`misc-options-unanswered` / `-partial` / `-sent`（desktop/mobile）、`misc-options-live-single`、`misc-options-live-ended-pending`（desktop）。before / after 各 24 张：`D:\code\test_project\test123\.audit-tmp\misc-p3\{before,after}\`（仓外，不入库），逐张 Read 对照。
- 单测：新增 `optionsGroup.test.tsx`（10 例）、`demo.test.ts`（4 例）；既有 RichBlocks / cards / MarkdownImpl / Markdown / MessageRenderer / App 用例复跑。
- 真浏览器门 `npm run test:browser`（改到消息面）跑两轮（RichBlocks 改后、MarkdownImpl 改后）。

## 3. 问题清单与处置

### 3.1 D · `?demo=1` 演示模式

| 编号 | 位置 | 现象 | 严重度 | 处置 |
|---|---|---|---|---|
| D-01 | `lib/demo.ts` `demoReply` | 回复写死「将由 **MiniMax-M3** 等模型实时流式生成」，而 demo 默认选中的是 `DEMO_MODELS[0]`（GLM-5.3），选择器与回复文案打架 | P3 | ✅ `demoReply(text, modelName = DEMO_DEFAULT_MODEL_NAME)`，默认取 `DEMO_MODELS[0].display_name`；App 不改调用 |
| D-02 | `lib/demo.ts` `DEMO_SESSIONS` | `messageCount` 4/8/12/6/9/5 与 fixture 不符：s1 实际 2 条，s2–s6 点开是空会话却标着有消息；`App` 的历史骨架按 `knownMessageCount>0` 先画骨架再落空 | P3 | ✅ s1 → 2，其余 → 0（点开即空态、不再先出骨架）；新增 `DEMO_MESSAGES_BY_SESSION`（App `onDemoSelect` 可一行改为 `DEMO_MESSAGES_BY_SESSION[id] ?? []`，见 §6） |
| D-03 | `lib/demo.ts` `DEMO_SESSIONS` | 缺 `createdAt`（`Session.createdAt` 是侧栏用时起点），demo 会话行的用时位空 | P3 | ✅ 每条补 `createdAt`（相对当前时刻，早于 `updatedAt`） |
| D-04 | `lib/demo.ts` `DEMO_USER.displayName = "rqmn"` | 演示账号用了真人 handle，公开演示截图里语义不明 | P3 | — 不修：可能是有意的演示 / 营销口味，记给产品 |
| D-05 | `components/Message.tsx` `AssistantMessage` | `OptionsGroupProvider` 未传 `live`，与 `chat/cards.tsx` 契约不一致：demo 流式期 options 块会按非流式处理（demo 下 `ChatInteraction={}` 块本就不可交互，故无可见后果，但 demo 通道不该是唯一「流式也点击即发」的路径） | P3 | ✅ `live={!!streaming}` |
| D-06 | `components/Message.tsx` 流式三点 | 只有视觉动画，读屏拿不到「正在生成」状态 | P3 | ✅ 外层改 `<output aria-live="polite" aria-label="正在生成回复">`，装饰点 `aria-hidden` |
| D-07 | `App.tsx` demo 分支（只审） | `onOpenGoal` demo 下缺省 → 空会话页无「设定目标」链接；`image2Available / ratingsEnabled / mediaGateEnabled` 恒 false → 对应入口隐藏；`onRetrySend / onQuote / onContinueInterrupted` 缺省 → 卡片动作隐藏。逐条核对入口随能力一起消失，**自洽** | — | 只审无发现（截图 `misc-demo-empty` 佐证空态无目标链接） |
| D-08 | `App.tsx:2381` demo 下 `ChatInteractionContext` 为 `{}` | 回复里若出现 options / 交互块，块内文案是「(此会话中不可交互)」，没说明是因为演示模式 | P3 | ⏸ 遗留（shell）：建议 demo 下传 `{ sendUserText: undefined, reason: "demo" }` 或在 `RichBlocks` 文案区分（需 `ChatInteraction` 加字段，跨 messages） |
| D-09 | `components/Message.tsx` `UserMessage` | 气泡 `text-[15.5px]` 任意字号、`max-w-[78%]` | P3 | — 不修：shell S-15 口径「排版档位专项统一收敛，不为单点新增 token」 |

### 3.2 OG · optionsGroup 多题聚合

| 编号 | 位置 | 现象 | 严重度 | 处置 |
|---|---|---|---|---|
| OG-01 | `RichBlocks.tsx` `OptionsBlock` 注册走 `useEffect`；`grouped` 取渲染期快照 | commit 之后到 passive effect 之间，块已可点、分组还没数到它：此时点第一题会误走「单块点击即发」——**隐式发送一条「我选择:…」且该题不进聚合**。before 截图 `misc-options-partial`：三题消息第一题被单独发出（块显示「已选择:」、页脚只计 1/3） | **P2** | ✅ 注册改 `useLayoutEffect`；`choose / confirmMulti` 点击时刻直接读 `store.getSnapshot().grouped` 而非渲染期闭包 |
| OG-02 | `MarkdownImpl.tsx` `components={{…}}` 字面量 + `optionsGroup.tsx` `showFooter` | 流式期点选后流式结束（单块）：页脚消失、点选与高亮全部丢失（before 截图 `misc-options-live-ended-pending`）。根因两层：① `MarkdownImpl` 每次渲染新造 `components` 函数，React 视为新组件类型，`caret`/`live` 翻转那次重渲把 OptionsBlock（以及 HtmlPreview 等富块）**整个卸载重挂**，本地 `picked` 与分组注册全丢；② 即便不重挂，`showFooter` 只看 `live || count>=2`，单块 live 结束页脚也会收掉，块退回点击即发、用户在 live 期被禁止的那次发送再也发不出去 | **P2** | ✅ ① `components` 包 `useMemo`（deps `signMedia / blockImages / readOnly`），`live` 经 `liveRef` 读；② Snapshot 新增 `grouped = count>=2 \|\| live \|\| answered>=1`（`isOptionsGrouped`），Footer 与 OptionsBlock 同读这一字段 |
| OG-03 | `optionsGroup.tsx` 已发送文案 | 有未答题时仍说「已发送全部选择。」 | P3 | ✅ 「已发送全部选择（N 题未答，已一并标注）。」；全部作答仍是原句（既有 4 处 `/已发送全部选择/` 断言不动） |
| OG-04 | `optionsGroup.tsx` 发送键 | 裸 `<button>`：`text-white` 压 accent（shell S-03 已给 `--accent-fg`）、触屏无 44px 兜底、无 focus 环 | P3 | ✅ 走 `ui/Button variant="accent" size="sm"`（自带 `[@media(hover:none)]:min-h-11`） |
| OG-05 | `optionsGroup.tsx` / `RichBlocks.tsx` 发送文本 | 「我的选择:」「问题:答案」「(未答)」「我选择:」半角标点进用户消息 | P3 | — 不修：文本是用户消息内容契约，被 `cards.test` / `RichBlocks.test` / `persist.test` 8 处断言与既有会话数据锁定；改动需连带 messages 用例与历史数据口径，单独立项 |
| OG-06 | `optionsGroup.tsx` 页脚 | 「已作答 x/y」不是 live region；非流式 busy 时发送键禁用无原因 | P3 | ✅ 计数改 `<output aria-live="polite">`；busy 时提示「等待当前回合结束后可发送」+ 按钮 `title` |
| OG-07 | `optionsGroup.tsx` 页脚 | 已作答 ≥1 但仍有未答题时，没提示未答题会被标注发出 | P3 | ✅ 「未答的 N 题会标为「未答」一并发出」 |
| OG-08 | `RichBlocks.tsx` 非流式单块 | 点击即发（无确认） | — | 设计如此（正文头注释「保留最顺手的路径」），有回归用例锁定；不改 |
| OG-09 | `optionsGroup.tsx` `markSent()` 后 `sendUserText` 若失败 | 组已锁定、无恢复入口 | P3 | ⏸ 遗留：`sendUserText` 目前无返回值 / 失败通道（`ChatInteraction` 契约，messages），需先有失败回调再谈解锁 |

统计：D 9（修 5 · 不修 2 · 只审 1 · 遗留 1）；OG 9（修 7 · 设计不改 1 · 遗留 1）。P2 2/2 修复。

## 4. 修复记录

| 提交 | 内容 | 覆盖 |
|---|---|---|
| `5ce25612b` `feat(v5): optionsGroup 多题聚合 · 首帧点选不再隐式发送、流式结束点选不丢、页脚文案与可达性` | `optionsGroup.tsx`：Snapshot.grouped / `isOptionsGrouped`、页脚 Button 原语 + live region + 文案；`RichBlocks.tsx`：注册 `useLayoutEffect`、`grouped` 读快照、点击时刻读 store；`MarkdownImpl.tsx`：`components` `useMemo` + `liveRef`；新增 `optionsGroup.test.tsx` 10 例 | OG-01 OG-02 OG-03 OG-04 OG-06 OG-07 |
| `592ffcff5` `feat(v5): demo 演示模式 fixture 自洽与流式可达性 + 杂项 P3 审计场景` | `lib/demo.ts`：`demoReply` 模型名同源、`messageCount` 对齐 fixture、`createdAt`、`DEMO_MESSAGES_BY_SESSION` / `DEMO_DEFAULT_MODEL_NAME`；`Message.tsx`：`live` 透传、流式三点 `<output>`；新增 `demo.test.ts` 4 例；`scenes-misc-p3.tsx` 7 场景 | D-01 D-02 D-03 D-05 D-06 |

计划外：无。`MarkdownImpl` 记忆化顺带让 HtmlPreview 在流式结束时不再重建 iframe（既有 `HtmlPreview streaming throttle` 用例全绿）。

## 5. 验证

均在 `d:\code\test_project\test123\wt\misc-p3` 跑。

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ `tsc -b` 0 错 |
| 场景类型检查 | `npm run typecheck:preview` | `scenes-misc-p3.tsx` 0 错；剩余 3 错为他人存量（`scenes-manage-audit` / `scenes-market-audit` TS5097、`scenes-taskboard` TS2322，taskboard 二期已修但未合入） |
| 相关单测 | `npx vitest run src/components/optionsGroup.test.tsx src/lib/demo.test.ts src/components/RichBlocks.test.tsx src/components/MarkdownImpl.test.tsx src/components/Markdown.test.tsx src/components/chat/cards.test.tsx src/components/MessageRenderer.test.tsx --maxWorkers=1` | ✅ 7 文件 / 270 例全绿（含既有 options 聚合用例 12 例、`/已发送全部选择/` 4 处断言未动） |
| App demo 用例 | `npx vitest run src/App.test.tsx --maxWorkers=1`（与 RichBlocks / cards 同批） | ✅ 通过（`?demo=1` 零网络、⌘K 两例、`/desktop/enroll?demo=1` 特判） |
| 真浏览器门 | `$env:OC_E2E_BROWSER='…chrome.exe'; npm run test:browser`（两轮） | `run.mjs` **68 全过**；`node --test` 73 例 70 过，3 失败均为基线：`cc-switch-ascii-name` ×2（settings 基线）、`ocv5-185-qa`（`git diff --exit-code` 要求工作树干净 / Windows symlink，环境）。日志 `.audit-tmp\misc-p3\test-browser{,-2}.log` |
| 代码风格 | `npx biome lint <改动 9 文件>` | 新增诊断 0；`RichBlocks.tsx` 5 条与 integration 基线逐条相同（行号平移） |
| 视觉 | `OC_UI_SCENES=misc- OC_UI_SHOT_DELAY=1800 node browser-tests\ui-preview\shoot.mjs` | before / after 各 24 张全部成功（7 场景 × 主题 / 视口） |

after 对照（逐张 Read）：
- `misc-options-partial--desktop--light`：before 第一题「已选择:长期可维护」无高亮、页脚「已作答 0/3」（隐式发送 + 漏计）→ after 三块均在聚合模式，第一题高亮 + 「已选:…(可在下方发送选择)」，页脚「已作答 1/3 —— 未答的 2 题会标为「未答」一并发出」，发送键为 accent Button。
- `misc-options-live-ended-pending--desktop--light`：before 流式结束后页脚、高亮、提示全部消失 → after 高亮与「已选」保留、页脚「已作答 1/1」可发送、光标已收。
- `misc-options-sent--*`：before 「已发送全部选择。」→ after 「已发送全部选择（1 题未答，已一并标注）。」；第一题高亮恢复。
- `misc-demo-empty--*` / `misc-demo-stream--*`：与 before 一致（D-05 / D-06 为语义与可达性改动，静态图无差）。

**NOT RUN**：全量 `npm test`（改动限于 demo / Message / optionsGroup / RichBlocks / MarkdownImpl，其直接与间接使用方的 8 个测试文件已单跑绿；全量门交集成③统一跑）；真机 iOS Safari；真实 `?demo=1` 页面截图（截图台不挂整 App，demo 空态 / 消息流以真组件 + fixture 摆出）。

## 6. 遗留

| 项 | 归属 | 说明 |
|---|---|---|
| D-02 余项：demo 其余会话点开为空 | shell（`App.tsx:643` `onDemoSelect`） | 一行改为 `setMessages(DEMO_MESSAGES_BY_SESSION[id] ?? [])`；要让 s2–s6 有内容再往 `DEMO_MESSAGES_BY_SESSION` 补 fixture 并同步 `messageCount` |
| D-08 demo 下交互块「(此会话中不可交互)」未说明原因 | shell + messages | `ChatInteraction` 加 `reason` 或 demo 下专用文案 |
| OG-05 发送文本半角标点 | messages（单独立项） | 需同批改 `cards.test` / `RichBlocks.test` / `persist.test` 断言与历史数据口径 |
| OG-09 发送失败后组锁定无恢复 | messages | `ChatInteraction.sendUserText` 需失败通道 |
| D-04 `DEMO_USER.displayName="rqmn"` · D-09 气泡任意字号 | 产品 / 排版专项 | 不修，见 §3.1 |

## 7. 归属表勘误（PLAYBOOK §8 漏项，供归档）

| 文件 | 应归属 | 依据 |
|---|---|---|
| `src/components/optionsGroup.tsx`（+ `optionsGroup.test.tsx`） | **messages** | 只被 `chat/cards.tsx`、`Message.tsx`、`RichBlocks.tsx` 使用，是 options 块的消息级聚合层，随 `RichBlocks` / `lib/chat` 契约演进 |
| `src/components/chat/researchEvidence.tsx` | **tools** | 研究证据卡属于工具卡 / 智能体过程体系（`components/tool/researchCards.tsx` 同族），不在 messages 归属列表里 |
| `src/components/mathDelimiters.ts`（+ `.test.tsx`） | **messages** | `MarkdownImpl.normalizeMathDelimiters` 的纯函数，随 Markdown 渲染链路 |

另：`?demo=1` 路径涉及 `lib/demo.ts`（shell 表内）、`components/Message.tsx`（messages 表内）与 `App.tsx` 约 60 处分支（shell），审计时需两 owner 都在场；本轮按 t-839 契约合一处理。
