# HUD · 任务列表 / 后台子任务 · 审计报告（A→B 同人合一）

- 任务：t-836「HUD·任务列表/后台子任务 审计+修复（G-1/G-2）」，补齐覆盖复查 t-760 的缺口 G-1 / G-2
- 分支：`feat/v5-selfhost-audit-hud`（基线 `210b9967892b3624fb3984f69d2174e4a641b33d`）
- 阶段：A（审计，§1–§5）→ B（修复，§6–§8）
- 结论：**P1 × 0 / P2 × 7 / P3 × 13**，共 20 条。没有阻断主流程的故障：两枚 HUD 的三态状态机（在飞 / 刷新后仍在飞 / 收口隐藏）经得起读，
  已有单测锁住。真正伤用户的是四件事——后台任务**失败原因不显示**（终态摘要只在 completed 才渲染）；折叠态在 390px 宽下
  **摘要被挤没、计时被截成「00:0」**；全部结束后折叠头部只剩一个语义不明的「后台任务 0/3」；以及两处可达性硬伤
  （`aria-hidden` 的可点击 chevron、键盘焦点环被 `overflow-hidden` 容器裁掉）。

## 1. 范围与文件清单

| 面 | 文件（`packages/web-react/src/`） | 行数 | 说明 |
|---|---|---|---|
| 任务列表 HUD | `components/chat/PinnedTaskTracker.tsx` | 221 | 钉在输入框上方；`extractLatestTodos` 从当前 turn 提取 TodoWrite / plan steps；展开 → 3s 自动折叠 → 手动锁定 |
| 后台子任务 HUD | `components/chat/PinnedDelegateTracker.tsx` | 241 | 钉住 inflight-delegates 投影；running / queued / 终态；「知道了」逐条 dismiss、「停止本轮」 |
| 数据 hook | `hooks/useInflightDelegates.ts` | 132 | 进会话拉一次，有非终态项每 15s 轮询；30 分钟 recency 门；dismiss 仅内存 |
| 读模型 | `lib/chat/inflightDelegates.ts` | 165 | 协议 `InflightDelegateSurface` 归一化 + 与时间线 agent-group 合并 |
| 既有单测 | `PinnedTaskTracker.test.tsx` / `PinnedDelegateTracker.test.tsx` / `useInflightDelegates.test.ts` / `inflightDelegates.test.ts` | — | 状态机与读模型已有覆盖；**无一条 aria / 键盘 / 移动端用例** |
| 接线（只读参照，shell 归属，不改） | `App.tsx` L3680–3693 | — | `composer-safe-b` 容器内：PinnedTaskTracker → PinnedDelegateTracker → 审批槽 → 横幅栈 → Composer |

不在范围：`components/ui/**` 原语（shell）、`components/chat/tokenUsage.tsx`（messages，HUD 头部的 `TokenUsageBadge`）、协议包 `InflightDelegateSurface` 字段。

## 2. 方法与证据

1. 通读四个源文件与四个测试文件；对照 App.tsx 接线读 props 契约（`active=wsSending`、`settled=currentTurnSettled(wsMessages)`、`onStop=stopTurn`）。
2. 新增 ui-preview 场景 `browser-tests/ui-preview/scenes-hud.tsx`（10 个场景：任务列表 展开 / 折叠 / 12 条长文案 / 刷新后钉住；后台任务 运行展开 / 运行折叠 / 全部结束展开 / 全部结束折叠；两枚同时折叠 / 同时展开），
   底部挂真 `Composer` 还原层叠。HUD 不走 api，场景直接喂 props；折叠态由场景包装器挂载后点一次切换按钮取得（组件 3s 才自动折叠）。
3. before 截图：`OC_UI_SCENES=hud- node browser-tests/ui-preview/shoot.mjs` → `D:\code\test_project\test123\.audit-tmp\hud\before\`，
   10 场景 × desktop 1440 / mobile 390 × light / dark = **40 张，manifest failures 0，unmockedApi 0**。用 Read 逐张看图。
4. 按 PLAYBOOK §5 七项清单逐条过：视觉 / 响应式 / 交互反馈 / 功能正确性 / 可访问性 / 文案 / 代码质量。

关键证据图（before）：

- `hud-stack-expanded--mobile--light.png`：两枚 HUD 同时展开，从 y≈330 到 y≈920（1024 高的缩略）—— 约 **60% 视口**被 HUD 占掉，后台任务列表末行被 `max-h-52` 齐切。
- `hud-delegate-collapsed--mobile--light.png`：折叠头部只剩「后台任务 3/5 ◌ 质量审查员 00:0 停止本轮 ˄」—— 目标文本完全看不到，计时被截半。
- `hud-delegate-terminal-collapsed--mobile--dark.png`：全部结束后折叠 → 「后台任务 0/3」+ chevron，零信息。
- `hud-delegate-running--desktop--light.png`：失败行「× coding-assistant 在主克隆里直接改代码」后面没有任何原因；排队项与运行项同为旋转图标。
- `hud-task-long--mobile--dark.png`：12 条时列表被 `max-h-52` 切在第 6 条中间，无滚动提示。

## 3. 问题清单

编号 H-xx；位置为基线 `210b9967` 行号。严重度按 PLAYBOOK §5：P1 阻断 / P2 明显体验缺陷 / P3 打磨。

| # | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| H-01 | `PinnedDelegateTracker.tsx:67`（`summary = state === "completed" ? … : ""`） | 终态摘要只在 completed 渲染；failed / cancelled / killed_by_cutover 的 `resultSummary`（失败原因）被丢掉 | 用户只看到一个 ×，不知道后台任务为什么失败、下一步该怎么办 | **P2** |
| H-02 | `PinnedDelegateTracker.tsx:199-213` | 折叠摘要：`inline-flex` 里名字 `shrink-0` + 计时 `shrink-0`，外层 `truncate`；390px 下目标文本被挤到 0 宽，计时「00:12」被裁成「00:0」（截图 `hud-delegate-collapsed--mobile`） | 折叠态在手机上等于没有摘要 | **P2** |
| H-03 | `PinnedDelegateTracker.tsx:121-124, 196-198` | 无运行项时 `latestRunning=null` → 折叠头部只剩「后台任务 0/3」；分子「live」/ 分母「visible」的语义没有任何文案解释，全部结束时显示 0/3 像出了错 | 后台任务结束后（这是 HUD 的核心场景）折叠态给不出任何结果信号 | **P2** |
| H-04 | `PinnedDelegateTracker.tsx:231-243` | 第二枚 chevron 是 `<button tabIndex={-1} aria-hidden>`：`aria-hidden` 元素内含可点击控件（axe `aria-hidden-focus` 违规），且与主切换按钮重复 | 读屏用户不可达、鼠标用户两处点击行为相同、DOM 里多一个假按钮 | **P2** |
| H-05 | `PinnedTaskTracker.tsx:190-197`、`PinnedDelegateTracker.tsx:186-193` | 切换按钮无 `focus-visible` 样式；外层 `overflow-hidden rounded-lg` 会把浏览器默认 outline（画在盒外）裁掉 | 键盘 Tab 到 HUD 头部**看不到焦点** | **P2** |
| H-06 | `PinnedTaskTracker.tsx:227`、`PinnedDelegateTracker.tsx:248`（`max-h-52`） | 展开列表固定 208px 上限；两枚同时展开在 390×844 吃掉约 60% 视口，横屏手机（高 390）直接盖住对话区 | 移动端展开态挤走对话区，横屏几乎不可用 | **P2** |
| H-07 | `PinnedDelegateTracker.tsx:47-55`（`StatusMark`） | `queued` / `paused_for_cutover` 与 `running` 用同一个旋转图标 | 排队中 / 因切换暂停的任务看起来「在跑」，等不到进度也不知道为什么 | **P2** |
| H-08 | `PinnedTaskTracker.tsx:196`、`PinnedDelegateTracker.tsx:192` | `aria-controls` 指向条件渲染的列表 id，折叠时悬空；id 是固定字面量（多实例重复） | 读屏关系错误；未来多实例 id 冲突 | P3 |
| H-09 | 同上两处按钮 | 切换按钮没有明确可读名：读屏只听到「任务 2/5 正在审计… 12.5k」，不知道这是「展开/折叠」什么 | 可达性文案缺失 | P3 |
| H-10 | `PinnedTaskTracker.tsx:201` | 头部写「任务 2/5」，inline 工具卡（`tool/meta.ts:72`）叫「任务列表」，文件头也叫「任务列表」HUD | 同一概念两个叫法 | P3 |
| H-11 | `PinnedTaskTracker.tsx:173`（`if (!active …) return`） | 自动折叠只在 `active` 时启动；「刷新后仍在飞」态（active=false、settled=false）HUD 可见却永久展开 | 三态之二与在飞态行为不一致，刷新后一直占位 | P3 |
| H-12 | `PinnedDelegateTracker.tsx:154-166, 175-178` | 计时起点 = 本页首次看到该项的时间；协议无 `startedAt`，刷新后计时从 00:00 重来 | 「已运行 00:05」对跑了 10 分钟的任务是误导 | P3 |
| H-13 | `PinnedDelegateTracker.tsx:92-105` | 多条终态只能逐条「知道了」，没有一键清除 | 5 条终态要点 5 次 | P3 |
| H-14 | `useInflightDelegates.ts:46, 60-66` | `dismissed` 只在内存；刷新后 30 分钟 recency 窗内的终态项全部复活 | 「知道了」不算数 | P3 |
| H-15 | `useInflightDelegates.ts:112-120` | 轮询在页面隐藏时跳过，回到前台不立即拉，最长滞后 15s | 切回标签页看到的是旧状态 | P3 |
| H-16 | `PinnedTaskTracker.tsx:93-98` | `TodoRow` 的 `compact` 形参两分支都是 `text-body`（死代码） | 代码质量 | P3 |
| H-17 | 两处列表 `overflow-y-auto` | 溢出无任何滚动提示，末行被齐切（截图 `hud-task-long--mobile`） | 用户不知道下面还有 | P3 |
| H-18 | `PinnedDelegateTracker.tsx:216-230` | `hasRunning && onStop` 即显示「停止本轮」，但组件不知道父轮是否已结束；父轮结束后 `stopTurn` 无可停之物 | 按了没反应 | P3（跨模块，需 shell 传 prop） |
| H-19 | `PinnedTaskTracker.tsx:160-168` | 任务集**文案微调**（数量不变）也重置 `userTouched` 并重展开 | 用户明确折叠后被反复弹开 | P3（设计取舍） |
| H-20 | `chat/tokenUsage.tsx:189-190`（messages）；`styles.css` `--faint`（shell） | ① `TokenUsageBadge` `key=totalTokens + animate-in`，流式期间头部徽标反复淡入；② 暗色下 `text-faint` 删除线文本对比度 ≈ 3.9:1 | 视觉噪音 / 弱对比（已完成项刻意弱化，可接受） | P3（跨模块备注） |

## 4. 修复计划

| # | 改哪些文件 | 怎么改 | 补什么测试 | 风险 |
|---|---|---|---|---|
| H-01 | `PinnedDelegateTracker.tsx` | 所有终态都渲染 `firstLine(resultSummary)`；failed / cancelled / killed 用 `text-danger` | `PinnedDelegateTracker.test`：failed 显示原因 | 低 |
| H-02 | 同上 | 折叠摘要改成 flex 行：状态标 `shrink-0` → 名字 `hidden sm:inline` → 目标 `min-w-0 flex-1 truncate` → 计时 `shrink-0`（移出 truncate 容器） | after 截图 `hud-delegate-collapsed--mobile` | 低 |
| H-03 | 同上 | 折叠摘要回退到最近终态项（按 updatedAt）；头部计数改为「N 进行中」/「N 已结束」 | 终态折叠头部显示最近结果；计数文案 | 低（改文案，更新既有断言） |
| H-04 | 同上 | 删掉独立 chevron 按钮，chevron 作为主切换按钮末尾的装饰 `span aria-hidden` | 头部只有一个 `aria-expanded` 按钮 | 低 |
| H-05 | 两枚 HUD | 切换按钮 `outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`（inset 不被裁） | 断言 class 含 `focus-visible:ring-inset` | 低 |
| H-06 | 两枚 HUD | `max-h-52` → `max-h-[min(13rem,30dvh)]`：桌面不变，短视口按 30% 视口封顶 | after 截图 `hud-stack-expanded--mobile` | 低 |
| H-07 | `PinnedDelegateTracker.tsx` | `StatusMark`：queued → 空心圆 `text-faint`，paused_for_cutover → `Pause` `text-warning`，均带 `title` / `aria-label` | queued 不出现 `animate-spin` | 低 |
| H-08 | 两枚 HUD | `useId()` 生成列表 id；`aria-controls` 只在展开时输出 | 折叠时无 `aria-controls` | 低 |
| H-09 | 两枚 HUD | 按钮内加 `sr-only`「展开/折叠任务列表」「展开/折叠后台任务列表」 | `getByRole("button", {name: /任务列表/})` | 低 |
| H-10 | `PinnedTaskTracker.tsx` | 头部改「任务列表 2/5」 | 更新既有断言 | 低 |
| H-11 | `PinnedTaskTracker.tsx` | 自动折叠计时器改以「HUD 可见」为门（有未完成项且未收口），不再依赖 `active` | 刷新后钉住态 3s 后也折叠 | 低（新任务集 / 新 turn 仍会重展开，既有用例锁住） |
| H-12 | `PinnedDelegateTracker.tsx` | 起点取 `min(首次观察, updatedAt)`；计时加 `title`「自本页观察起」；协议补 `startedAt` 记「需后端配合」 | — | 低 |
| H-13 | 同上 | 无运行项且终态 ≥ 2 时头部给「全部知道了」（逐个调 `onDismiss`，不改 App 接线） | 点击后 onDismiss 被调 N 次 | 低 |
| H-14 | `useInflightDelegates.ts` | `dismissed` 按 sessionId 持久化到 `sessionStorage`（`oc_inflight_dismissed:<sid>`），读写都 try/catch | `useInflightDelegates.test`：持久化读写纯函数 | 低 |
| H-15 | 同上 | `visibilitychange` 回到 visible 且 `shouldPoll` 时立即 `pull` | — | 低 |
| H-16 | `PinnedTaskTracker.tsx` | 删 `compact` | — | 无 |
| H-17 | 两枚 HUD | 列表 ref 量 `scrollHeight - clientHeight - scrollTop > 4` → 加底部渐隐 `mask-image`；滚到底自动消失 | — | 低 |

## 5. 建议不修 / 暂缓项

| 项 | 理由 |
|---|---|
| H-18「停止本轮」在父轮已结束时仍显示 | 组件需要一个 `turnActive` 之类的 prop 才能判断，接线在 `App.tsx`（shell 归属，本任务边界明令不改）。记入 §8 遗留，交集成③ / shell 二期：`onStop={wsSending ? stopTurn : undefined}` 一行即可。 |
| H-19 任务集文案微调也重展开 | 文件头写明「任务集首次出现 / 变化时展开全部」是 boss 拍板的交互；agent 改写任务文案通常伴随语义变化，弹开一次再 3s 折叠可接受。保留，不改。 |
| H-20 ① `TokenUsageBadge` 流式反复淡入 | `chat/tokenUsage.tsx` 归 messages；messages-B 已收口，记跨模块备注供 messages 二期。 |
| H-20 ② `text-faint` 暗色对比度 | 设计 token 归 shell；已完成项刻意弱化，且 inline TodoWrite 卡同款，不单独动。 |
| H-12 计时不精确 | 前端只能取「本页观察」与 `updatedAt` 的较早者；要准需协议 `InflightDelegateSurface` 补 `startedAt`（需后端配合）。 |
