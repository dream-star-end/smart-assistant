# messages · 消息渲染与会话时间线 — 阶段 A 审计

- 任务：t-32「A·messages 消息渲染与时间线审计」（v5 个人版审计优化协同组）
- 分支：`feat/v5-selfhost-audit-messages`（基线 `210b9967892b3624fb3984f69d2174e4a641b33d`）
- 阶段 A 约定：**不改业务代码**；本文档 + 新增 ui-preview 场景 + 截图台修复为唯一改动。
- 严重度口径（TEAM_PLAYBOOK §5）：P1 功能不可用/数据错误/阻断主流程；P2 明显体验缺陷/一致性破坏/移动端不可用；P3 打磨项。

## 1. 范围与文件清单

归属（均在 `packages/web-react/src/`）：

| 分组 | 文件 | 体量 | 审计方式 |
|---|---|---|---|
| 渲染入口 | `components/MessageRenderer.tsx`（MessageRenderer + MessageList：分派、合并 thinking/team、首屏尾窗 80 条、画窗、历史分页按钮、查找条、待回答 dock、回到底部） | 102 KB | 全文通读 + 真组件截图 |
| 非工具卡 | `components/chat/cards.tsx`（UserCard / AssistantCard / ThinkingCard / TurnStatusCard / PlanCard / GoalCard / DelegateProgressCard / SystemCard / MessageActions / MetaRow） | 50 KB | 全文通读 + 截图 |
| 边界 | `components/MessageBoundary.tsx`、`components/SessionTimelineBoundary.tsx`、`components/Message.tsx`（demo 通道） | — | 通读 |
| Markdown | `components/Markdown.tsx`（lazy 边界 + 纯文本兜底）、`components/MarkdownImpl.tsx`（react-markdown / gfm / katex / highlight / 媒体内嵌 / 表格）、`components/CodeBlock.tsx`、`components/RichBlocks.tsx`（mermaid / chart / options / html 预览） | 42 KB | 全文通读 + 截图 |
| chat 子组件 | `components/chat/{AgentGroupCard,TeamPanel,PermissionCard,ResponseRating,MessageFeedbackDialog,TurnActivity,HistorySkeleton,GeneratingPlaceholderCard,tokenUsage,turnSegment,archivePaging,stickToBottom,wheelFence,findInSession,media,…}` | 340 KB | 重点文件通读，其余按引用抽查 |
| 状态机 / 持久化 | `lib/chat/{model,render,pure,reducer,socket,order,timelinePaint,timelineBlankProbe,…}.ts`、`lib/persist.ts`、`lib/thinkingText.ts`、`hooks/{useChatSocket,useMdViewport}.ts`、`lib/timeline/**` | 900 KB | 读 model/render/thinkingText 全文；socket/reducer/persist/useChatSocket 按「重连 / 离线 / 多标签 / 落盘」关键路径定点阅读；结合既有测试与 browser-tests cases.json 判读 |
| 既有真浏览器门 | `browser-tests/run.mjs` 头注 + `cases.json`（T5–T11、T18、T21、T29、T31–T32、T36、T39–T40、T43–T46、T48–T49、T52–T67 覆盖本模块） | — | 通读用例清单，修复计划据此标注需新增用例 |

不在本轮范围：`components/ToolCard.tsx`、`components/tool/**`（tools 模块，见 §6）；`App.tsx` 中的空态/骨架/错误态分派（shell 模块，只读参考）。

## 2. 方法与证据

### 2.1 视觉证据（ui-preview 截图台）

- 新增场景文件：`packages/web-react/browser-tests/ui-preview/scenes-messages.tsx`（7 个场景，直接给真实 `MessageList` 喂 reducer 已消化的 `ChatMessage[]`，desktop/mobile × light/dark 共 28 张）：
  - `messages-timeline-rich`：完整历史（用户行 + 引用、思考折叠、Bash 工具卡、富 Markdown 正文含标题/列表/表格/引用/宽代码块/行内码/链接、MetaRow、评价行、计划卡、目标卡、委派卡、系统卡、截断续写 banner、历史分页按钮）
  - `messages-thinking-live`：思考卡实时展开 + 本轮活动指示
  - `messages-assistant-streaming`：正文流式光标 + 运行中工具卡 + 已完成思考折叠
  - `messages-error-states`：发送失败重试 / 已停止（部分回答）/ 消息未开始处理 / 免费额度耗尽 / 上下文超限 / 内部错误 + 查看请求信息 / 委派失败 / 模型繁忙（重试 + 切换模型）/ 会话级软提示 / 尾部加载骨架
  - `messages-ask-user-question`：AskUserQuestion 弹窗（单选 + 多选）+ 已解析权限卡
  - `messages-find-toolbar`：会话内查找条 + 待回答 dock
  - `messages-scroll-window`：120 条长会话、真实滚动容器、首屏尾窗 + 查看更早 + 回到底部按钮
- before 截图：`D:\code\test_project\test123\.audit-tmp\messages\before\*.png`（28 张 + `manifest.json`，`failures: []`，`unmockedApi: []`）；逐张用 Read 审阅，长图切片在 `before\crops\`。
- 命令：`cd packages\web-react; $env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'; $env:OC_UI_SHOTS='D:\code\test_project\test123\.audit-tmp\messages\before'; $env:OC_UI_SCENES='messages-'; node browser-tests\ui-preview\shoot.mjs` → exit 0。

### 2.2 截图台本身的两处修复（共享基础设施，已在本分支修改，需指挥官确认）

审计消息模块时截图台自身先后暴露两个问题，不修就拿不到任何本模块证据；两处改动都不影响既有场景的像素结果：

1. **内联 bundle 被 HTML 解析器吞掉 → 零场景**（`shoot.mjs`）。场景一旦拉进 Markdown 链路，bundle（14 MB）里同时出现 highlight.js 语言定义的 `"<!--|-->"` 和 react-dom 的 `"<script><\/script>"` 字面量；HTML 解析器在 `<!--` 后进入 script-data-escaped 态，真正的 `</script>` 闭合不了，整段脚本静默不执行，`window.__ocScenes` 恒 `undefined`（shoot 报 `Cannot read properties of undefined (reading 'filter')`）。修复：bundle 改经 `page.route` 以外链脚本供出（与字体资产同一条路）。
2. **移动视口 fullPage 截图期间 (hover:none) 仿真丢失**（`shoot.mjs`）。Playwright 在 `isMobile` 上下文做整页扫描时临时改写设备指标，期间 `matchMedia('(hover: none)')` 为 false；实测截图前动作条 `opacity=1 / 44px`，截图内与截图后 `opacity=0 / 28px`。结果是此前所有移动端整页图里 `[@media(hover:none)]` 驱动的 44px 触控尺寸与常显动作条都退回了桌面形态。修复：移动视口不再用 fullPage，改为把视口临时拉到文档高度后普通截图再还原（`setViewportSize` 保留 isMobile/hasTouch）；文档不超视口的场景（`#root` 固定 100dvh 的面板类）高度不变、像素不变。**其他模块此前出的移动端截图建议按新台子重出一遍再下触控结论。**

另：生产 `#root` 是 `position:fixed; height:100dvh; overflow:hidden`，整页截图只能截到首屏；本模块非滚动面场景在挂载期把 html/body/#root 放开成文档流滚动（`scenes-messages.tsx` 的 `Page` 壳），只影响截图几何，不改组件样式。

### 2.3 代码与测试

- 通读上表「全文通读」文件；`socket.ts`（278 KB）/ `reducer.ts`（147 KB）/ `persist.ts`（111 KB）/ `useChatSocket.ts`（54 KB）按 connect/onclose/离线 latch、hydration/flush、多标签、状态标签流转四条线定点阅读。
- 跑过：`node browser-tests\ui-preview\shoot.mjs`（28/28 成功）；`npm run typecheck --workspace packages/web-react`（见 §2.4）。未跑：vitest / test:browser（阶段 A 未改业务代码，NOT RUN）。
- 探针（仓库外 `.audit-tmp\messages\probe.mjs`）：用于定位上面两处截图台问题（打印 `__ocScenes`、`matchMedia`、动作条计算样式）。

### 2.4 验证摘要

- typecheck：见提交信息（阶段 A 只新增 `browser-tests/**` 与 `docs/**`，`browser-tests` 不进 `tsc -b`，typecheck 结果与基线一致）。
- 截图台：28 张全部成功，`manifest.json` 无失败、无未打桩 API。

## 3. 问题清单

编号规则：M-xx。位置为基线 `210b9967` 的 file:line。

| 编号 | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| M-01 | `src/components/chat/cards.tsx:462-471`（UserCard「编辑」按钮无条件渲染，且不看 `readOnly`）；`components/tutorials/TutorialReplay.tsx:464-466`、`admin/pages/users/SessionViewerModal.tsx:471-473` 以 `cb={{}}` / 无 `onEditResend` + `readOnly` 挂载 | 教程回放、后台会话查看器等只读面里，每条用户消息仍出现可点的「编辑」图标，点击无任何反应；触屏设备上该按钮常显 | 只读面出现死按钮，误导用户「能改」；触屏上每条用户消息多占一行 | P2 |
| M-02 | `src/components/MarkdownImpl.tsx:158-180`（MarkdownTable）+ `src/styles.css:783,805-807`（`.prose{word-break:break-word}`、`.prose table{width:100%}`） | 390px 下表格被压进容器宽度，单元格内标识符被任意位置拆行（截图：`MessageRendere\nr.tsx`、`风\n险`），横向滚动区形同虚设；同时「表格可左右滑动查看更多」提示在表格并未溢出时也常显 | 移动端表格可读性差，提示文案与实际不符 | P2 |
| M-03 | `src/components/chat/cards.tsx:318`（MessageActions）、`:448`（UserCard 动作行）`[@media(hover:none)]:opacity-100` | 触屏设备上**每条**消息下方常显整排 44px 动作图标（助手 5 个、用户 3 个）+ 状态标签 + MetaRow；长会话里 1 行正文配 3 行 chrome（截图 `messages-scroll-window--mobile`），信息密度骤降 | 移动端浏览历史时噪音大、滚动距离翻倍 | P2 |
| M-04 | `src/components/chat/TurnActivity.tsx:148-151` | 活动指示行 `aria-live="polite"`，而文案含每秒变化的 `(Ns)` | 读屏用户在整轮生成期间每秒被朗读一次「主助手 思考中 (12s)」 | P2（可访问性） |
| M-05 | `src/components/MessageRenderer.tsx:2135`（footer `px-5 pb-8 pt-4`）嵌在 `:2350` 列表根（`px-5`）内 | 本轮活动指示、会话级软提示、尾部加载骨架比时间线内容多缩进 20px（截图 `messages-assistant-streaming--desktop`：footer 头像与助手头像不对齐；`messages-error-states`：info 卡右移） | 视觉对齐破坏，移动端更明显（40px 双内边距） | P3 |
| M-06 | `src/components/chat/cards.tsx:690-692`（AssistantCard 光标）、`:935-937`（ThinkingCard 光标） | 流式光标 `caret-blink` 是 Markdown 块级容器之后的兄弟节点，永远落在正文最后一行**下方**单独一行 | 「正在输入」的视觉落点与文字脱节（截图 `messages-assistant-streaming`、`messages-thinking-live`） | P3 |
| M-07 | `src/components/chat/AgentGroupCard.tsx:264-270`；`src/components/chat/cards.tsx:1091-1098`（DelegateProgressCard） | 折叠态结果摘要恒用绿色 ✓ 图标，即便徽记是「失败/超时」（截图 `messages-error-states--desktop` 第 3 片：「失败 · 61s」旁是绿勾 + 「修复失败:…」） | 终态语义自相矛盾 | P3 |
| M-08 | `src/components/chat/tokenUsage.tsx:170-197`（TokenUsageBadge） | 正文下方孤零零一个 `5.98k` / `1.42k`，无单位、无图标，仅 `title` 可解释 | 用户不知道这是什么数字；与 MetaRow 的「1,280 积分」分居两行 | P3 |
| M-09 | `src/components/chat/cards.tsx:411-446`（UserCard 状态标签） | 历史里每条用户消息下都常显「已回复」「已送达」 | 重复噪音；仅「发送中/排队中/发送失败」有信息量 | P3 |
| M-10 | `src/components/chat/cards.tsx:903-917`（ThinkingCard 头部按钮）；`AgentGroupCard.tsx:209-213` | 折叠开关无 `aria-expanded`（同文件 DelegateProgressCard、RuntimeEventCard 都有）；ThinkingCard 头部 `py-2` 触屏高约 36px | 读屏无法得知展开态；触控靶 <44px | P3 |
| M-11 | `src/components/MessageRenderer.tsx:2255-2270`（待回答 dock 按钮 `px-2.5 py-1 text-caption`）；`:397-405`、`:442-452`（原始记录展开按钮 `text-caption`） | 触屏下按钮高约 26–28px | 触控靶不达标 | P3 |
| M-12 | `src/components/RichBlocks.tsx:389-405`（HtmlPreview 全屏/看源码按钮 `p-1` / `px-2 py-0.5`）、`:233-259`（OptionsBlock 选项按钮 `px-3 py-2`，无 hover:none 加高）、`:276` | 触屏下按钮 ≈22–36px；选项因 `busy` 不可点时只有 `opacity-80`，无原因提示 | 触控靶不达标；交互卡不可点时用户不知为何 | P3 |
| M-13 | `src/components/chat/ResponseRating.tsx:89-101`（TagChip `py-1`） | 点踩后展开的标签 chip 触屏高约 28px | 触控靶不达标 | P3 |
| M-14 | `src/components/Markdown.tsx:69-70`（HtmlPreviewFallback 用 `bg-background` / `bg-muted/40` / `text-muted-foreground`） | 三个 class 在 `styles.css @theme` 中不存在（只有 `--color-bg/--color-muted/--color-fg`），chunk 未到达时的 HTML 预览兜底头部无底色、文字色继承 | lazy chunk 加载中 / 失败时视觉破碎 | P3 |
| M-15 | `src/components/chat/HistorySkeleton.tsx:123`（`text-foreground`） | 非本仓 token，「重新加载」按钮颜色回落到父级 `text-muted` | 动作按钮与说明文字同色，可发现性差 | P3 |
| M-16 | `src/components/chat/cards.tsx:389`（ReplyQuoteBlock 硬编码「从简」） | 品牌名写死，未走 `lib/brand.ts BRAND.name`（Composer.tsx:487 同样硬编码，归 composer） | 换品牌/白标时漏改 | P3 |
| M-17 | `src/components/chat/cards.tsx:1016`（GoalCard `${msg.timeUsedSeconds}s`） | 目标卡用时显示 `1260s` | 文案不友好，应「21 分钟」 | P3 |
| M-18 | `src/components/chat/cards.tsx:843-845`（MessageActions 门控 `!hasError`） | 用户主动停止 / 失败但已产出部分回答时，正文可见却没有复制/引用动作 | 用户想留存半截答案只能手动选中复制 | P3 |
| M-19 | `src/components/chat/cards.tsx:285`（SpeakButton `utterance.lang = "zh-CN"`） | 英文回答也用中文语音朗读 | 朗读体验差 | P3 |
| M-20 | `src/components/chat/cards.tsx:180-182`、`:203-205`；`CodeBlock.tsx:34-36` | 剪贴板写入失败静默吞掉 | 用户不知道复制失败（http 非安全上下文 / 权限被拒时必现） | P3 |
| M-21 | `src/components/MessageRenderer.tsx:2308,2325`（查找条上一处/下一处 `disabled={sending…}`） | 生成中不能在会话内跳转匹配 | 长回合期间查找功能半残；title 有解释 | P3 |
| M-22 | `src/components/Message.tsx:11-27,78-86`（demo 通道 UserMessage/AssistantMessage） | 动作条仅 hover 显示、无触屏兜底、无 `aria-label` 尺寸兜底；用户消息无复制 | demo 模式移动端不可用（仅影响 demo） | P3 |
| M-23 | `src/components/MessageRenderer.tsx:2415-2446`（回到底部按钮 `bottom-4 right-0`） | 移动端 44px 按钮叠在最后一行的状态标签/正文右侧（截图 `messages-scroll-window--mobile`） | 遮挡内容 | P3 |
| M-24 | `src/lib/chat/socket.ts:2035-2040`（`_liveStreamBroken` 注释「UI 提示」）；全仓无消费方 | 断流标记只被 reconcile 自己读写，UI 从不提示「实时流已断，正在对账」；恢复期唯一可见反馈是 `_recoveryStatus` 的「正在恢复实时内容…」 | 用户在 4s 对账窗口内看到的是「思考中 (Ns)」而非真实状态；死字段 | P3 |
| M-25 | `src/hooks/useChatSocket.ts:628-636,664-669`（`flushAll` 在 `visibilitychange hidden`/`pagehide` 时整会话覆盖写 IndexedDB） | 两个标签页开同一会话时，后台旧标签切回/关闭时会把**更旧**的会话快照写回同一 key（无版本比较）；下次 reload 先注水到旧快照，靠 REST server-wins 再纠正 | reload 后短暂出现旧内容再跳变（待复现；T19 只守 pending-dispatch journal，不守会话快照） | P3（待验证） |

统计：P1 0 / P2 4（M-01～M-04）/ P3 21（M-05～M-25）。

## 4. 修复计划（阶段 B）

| 编号 | 改哪些文件 | 怎么改 | 补什么测试 | 风险 |
|---|---|---|---|---|
| M-01 | `chat/cards.tsx`（UserCard）、`MessageRenderer.tsx`（把 `readOnly` 透传给 UserCard/AssistantCard） | 「编辑」只在 `cb.onEditResend && !readOnly` 时渲染；「引用」同理；`readOnly` 下整条动作行只留「复制」 | `cards.test.tsx` 新增：无 `onEditResend` / `readOnly` 时不渲染编辑与引用；`MessageRenderer.test.tsx` 只读列表断言 | 低；教程/后台只读面回归靠 T38（教程）与 admin 视图人工点检 |
| M-02 | `MarkdownImpl.tsx`（MarkdownTable） | ① 表格 `className="!w-max !min-w-full !max-w-none"`（`.prose table{width:100%}` 特异性更高，需 important 变体）+ 单元格 `[&_td]:break-normal [&_th]:whitespace-nowrap`，让宽表在 `.markdown-table-region` 内横滑而不是拆词；② 提示改为挂载后 `scrollWidth > clientWidth` 才显示（ResizeObserver 或首帧测量），并在滚过后消失（已有） | `MarkdownImpl.test.tsx`：提示仅在溢出时渲染（mock 尺寸）；ui-preview 场景 `messages-timeline-rich` 出 after 图；T25 已守「宽表可横滑」，复跑 | 中：与 `styles.css`（shell）规则叠加，若 shell 同期改 `.prose table` 需对齐；只用组件内 class，不动 styles.css |
| M-03 | `chat/cards.tsx`（MessageActions、UserCard 动作行） | 触屏下默认只露 1 个「更多」(⋯) 44px 按钮，点击就地展开完整动作行（本地 state，600ms 内可再点收起）；桌面保持 hover 露出。最后一轮末条 assistant 保留常显「复制 + 重新生成」，历史行折叠 | `cards.test.tsx`：模拟 `matchMedia('(hover: none)')` 时默认只有「更多」，点击后动作齐全；新增 browser-tests 用例（390px 触屏受信点击展开 + 44px 断言）；场景 `messages-scroll-window` after 对照 | 中：改到高频交互面 → 必跑 `test:browser`（T18 引用、T14 反馈焦点归还依赖动作按钮） |
| M-04 | `chat/TurnActivity.tsx` | 外层容器去掉 `aria-live`；秒数 span 加 `aria-hidden`；新增一个 `sr-only` `aria-live="polite"` 节点只在**阶段文案**（不含秒数）变化时更新（用 `useEffect` 比较去掉 `(Ns)` 后的文本） | `turnActivity.test.tsx`：秒数 tick 不改变 live 区域文本；阶段切换才改变 | 低 |
| M-05 | `MessageRenderer.tsx`（footer） | footer 去掉 `px-5`（与列表根共用一份内边距），保留 `pb-8 pt-4`；`scrollParent===null` 的「正在准备会话…」与空列表早返回分支同样对齐 | `MessageRenderer.test.tsx` 快照/className 断言；after 截图（streaming / error-states） | 低 |
| M-06 | `chat/cards.tsx` | 光标改为通过 `Markdown` 的 `live` 属性在**最后一个块级元素末尾**内联注入（MarkdownImpl `components.p/li` 末节点追加 `<span class="caret-blink">`），或用 CSS `.prose.is-live > :last-child::after` 画光标；ThinkingCard 同款 | `MarkdownImpl.test.tsx`：live 时最后一个块内有光标节点；after 截图 | 中：需处理最后块是代码块/表格的情况（此时回退到块后换行） |
| M-07 | `chat/AgentGroupCard.tsx`、`chat/cards.tsx`（DelegateProgressCard） | 折叠摘要图标按 `agentTerminalStatus(m).tone` 选：success→Check、danger→X、warning→Clock，颜色跟 tone | `cards.test.tsx` / `TeamPanel.test.tsx` 补断言 | 低 |
| M-08 | `chat/tokenUsage.tsx`、`chat/cards.tsx` | Badge 文案改「5.98k token」（估算前缀「约」保留）；AssistantCard 把 TokenUsageBadge 并入 MetaRow 同一行（时间 · 积分 · token · 请求ID） | `tokenUsage.test.ts`、`cards.test.tsx` 文案断言；after 截图 | 低 |
| M-09 | `chat/cards.tsx`（UserCard） | 仅渲染 `sending/queued/error`；`sent/read/replied` 不再显示（或只在最后一条用户消息显示「已送达」） | `cards.test.tsx` 调整既有 status 断言 | 低；需确认无 browser-tests 依赖「已回复」文案（cases.json 无） |
| M-10 | `chat/cards.tsx`（ThinkingCard）、`chat/AgentGroupCard.tsx` | 头部按钮加 `aria-expanded={!collapsed}` + `aria-controls`；ThinkingCard 头部加 `[@media(hover:none)]:min-h-11` | `cards.test.tsx` 属性断言；T13 同类断言可参照新增「思考卡头部 ≥44px」 | 低 |
| M-11 | `MessageRenderer.tsx` | dock 按钮与「查看原始记录/继续显示」按钮加 `[@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3` | 现有测试不受影响；after 截图（find-toolbar 场景） | 低 |
| M-12 | `RichBlocks.tsx` | HtmlPreview 头部两个按钮改用 `IconButton size="xs"` / 加 hover:none 加高；OptionsBlock 选项按钮加 `[@media(hover:none)]:min-h-11`，`blockedByBusy` 时在卡底加一行「等待当前回合结束后可选择」 | `RichBlocks.test.tsx`（若无则新建）：busy 提示渲染；ui-preview 新增 `messages-options-block` 场景 | 低 |
| M-13 | `chat/ResponseRating.tsx` | TagChip 加 `[@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3.5` | 无逻辑变化；after 截图 | 低 |
| M-14 | `Markdown.tsx` | 换成本仓 token：`bg-surface` / `bg-hover` / `text-muted` | `Markdown.test.tsx` className 断言 | 低 |
| M-15 | `chat/HistorySkeleton.tsx` | `text-foreground` → `text-fg`，并改为 `Button variant="ghost" size="sm"` 或加下划线常显 | `historySkeleton.test.tsx` | 低 |
| M-16 | `chat/cards.tsx` | `BRAND.name` 替代字面量（Composer.tsx:487 同款问题 → send_to composer owner） | `cards.test.tsx` | 低 |
| M-17 | `chat/cards.tsx`（GoalCard） | 用 `lib/utils` 已有时长格式化（若无则新增 `formatDuration(seconds)`：<60s 显示秒，<60min 显示「N 分钟」，否则「N 小时 M 分」） | `cards.test.tsx` | 低 |
| M-18 | `chat/cards.tsx`（AssistantCard） | `hasError && presentedError.bodyText` 时也渲染精简动作行（复制 + 复制纯文本 + 引用），不含重新生成/反馈 | `cards.test.tsx` | 低 |
| M-19 | `chat/cards.tsx`（SpeakButton） | 按文本粗判：CJK 字符占比 <20% 用 `en-US`，否则 `zh-CN`；抽成 `lib/chat/pure.ts` 纯函数 | `pure` 单测 | 低 |
| M-20 | `chat/cards.tsx`、`CodeBlock.tsx` | catch 里用 `useToast`（harness 与生产 Provider 树均有）提示「复制失败，请手动选择文本」 | `cards.test.tsx` mock clipboard reject | 低 |
| M-21 | `MessageRenderer.tsx` | 生成中允许跳转但不 pin（跳到目标行后立刻释放 findPin，不与 stick-to-bottom 抢滚动） | `MessageRenderer.test.tsx` 查找用例扩展 | 中：与 T63/T66 滚动篱笆交互，需 `test:browser` |
| M-22 | `Message.tsx` | 动作条加 `[@media(hover:none)]:opacity-100`、CopyBtn 用 IconButton（已自带 44px）、UserMessage 加复制 | 无既有测试；demo 人工点检 | 低（仅 demo） |
| M-23 | `MessageRenderer.tsx` | 回到底部 dock 改 `bottom-4 right-4`（移动端）并给列表根尾部 `pb-16`，或按钮加半透明底 | after 截图（scroll-window mobile） | 低 |
| M-24 | `lib/chat/socket.ts`、`chat/TurnActivity.tsx` | 二选一：a) `reconcileVisibleAndInFlight` 期间把 `_recoveryStatus` 置为 `{kind:'waiting-service'}` 让既有「正在恢复实时内容…」文案接管；b) 删除 `_liveStreamBroken` 写入与注释。倾向 a | `socket` 既有 reconcile 单测扩展；T29/T46 复跑 | 中：状态机字段，需 owner（本模块）小步提交 |
| M-25 | `hooks/useChatSocket.ts`、`lib/persist.ts` | 先复现：两标签同会话，A 生成两轮后 B 切回再切走，reload A 观察是否先出旧快照。若复现：`putSession` 带 `updatedAt/_maxSeq` 比较，旧于库内版本则跳过写（persist 层纯函数 + 单测） | `persist.test.ts` 新增版本比较用例；browser-tests 新增双标签用例（参照 T19 harness） | 中：涉及持久层，先复现再动 |

**阶段 B 需新增/复跑的真浏览器用例**：M-03（新增 390px 触屏动作行展开）、M-02（复跑 T25）、M-21（复跑 T63/T66）、M-24（复跑 T29/T46）、M-01（复跑 T38）。改到 `cards.tsx` / `MessageRenderer.tsx` 属高频交互面，交付前必跑 `npm run test:browser` 全量。

## 5. 建议不修 / 暂缓项

| 项 | 理由 |
|---|---|
| 桌面端 hover 才露出动作条，为其预留的 ~34px 高度造成消息间「空一行」 | ChatGPT/Claude 同款范式，用户已习惯；改成叠层会引入布局抖动风险。仅在 M-03 触屏方案里顺带评估 |
| Markdown 数学公式（KaTeX）在预览台里无法验证 | `shoot.mjs` 以 `.css: empty` 打包，katex.min.css 不进预览 CSS，公式必然错位；这是截图台限制而非产品缺陷，代码路径（remark-math + rehype-katex + `.prose .katex-display` 横滑）已通读无异常。若后续要做视觉基线，需截图台把 node_modules 内 CSS 一并纳入 vite 构建 |
| `Message.tsx` demo 通道整体重构 | 仅 demo 模式使用，M-22 做最小兜底即可 |
| `MessageList` 的首屏尾窗 80 条 / 画窗 / 篱笆 / 锚点校正逻辑 | T8–T10、T43、T52–T54、T60、T63、T65–T66 已密集覆盖，本轮通读未发现新的用户可感知缺陷，不建议在审计优化轮里触碰 |
| socket/reducer/persist 内部重构（278 KB / 147 KB / 111 KB 单文件） | 纯内部结构问题，不影响用户可感知结果；且有 428 KB 的 `chat.test.ts` 与 60+ 真浏览器用例锁定行为，拆分风险收益比差 |
| 「表格可左右滑动」提示文案本身 | 归入 M-02 一并处理，不单列 |

## 6. 移交 tools 模块

本轮通读 `MessageRenderer` 对工具卡的委托（`ToolCardSlot`、TodoWrite 抑制、`codex:imageGeneration` 占位）未发现属于消息模块的缺陷。截图中工具卡（`终端 · rg … · 完成`）头部 44px、折叠交互正常（T13 已守）。仅一条备注请 tools 模块知悉：M-08 若把 TokenUsageBadge 改成带单位文案，`ToolCardSlot` 内同一 Badge 会同步变化，属预期。

## 7. 需后端配合

无。本轮问题全部可在前端修复。
