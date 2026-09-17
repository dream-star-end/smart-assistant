# QA · 复核 a11y-B 三条 + PermissionCard 交付（t-893 / t-894 / t-895 / t-875）

> 任务 t-1232 · 角色：测试 / QA（第二双眼睛）· 复核人：fable-5-1-23 起稿（复核态搭建、§1–§3 逐条定位、301 场景 CDP 复扫与对比、§6 两处修复 `77a93d9e1`；随名单换轮离队，报告未提交）→ **fable-5-1-35 接手收口**（§1–§3 file:line 全部按 HEAD 抽查复核、§4 独立逐条重做、§5 门结果复跑补齐、§5.5 截图、§5.6 修后复扫、提交推送）· 2026-09-17
> 被复核对象：a11y-shell（`feat/v5-selfhost-audit-a11y-shell@4930707cc`，shell#1–11）、a11y-mod-a（`…-a11y-mod-a@475e3e6c7`，P2 6 / P3 8 / 计划外 1 / QA nit 2）、a11y-mod-b（`…-a11y-mod-b@9710a3b24`，10 条 + 顺手 1 + 附录 L-11 / M-23）、permission-card（`…-permission-card@8a3179896`，PC-01–17）。
> 复核态：集成④已把四支全部 `--no-ff` 合入 integration，本轮直接从 integration **`b23955208`**（集成④ 12/12）切 `feat/v5-selfhost-audit-qa-a11y`，工作树 `wt\qa-a11y`，独立 `npm ci`；四支 tip 均为 HEAD 祖先（`git merge-base --is-ancestor` 逐支核）。
> 证据目录（仓库外）：`D:\code\test_project\test123\.audit-tmp\qa-a11y\`（`scan\` 301 场景 CDP 复扫、`scan-fix\` §6 修后 21 场景复扫、`compare-qa.mjs` / `compare-qa.txt`、`shots\` 74 张、`typecheck*.log`、`vitest-all.log` / `vitest-mr.log` / `vitest-fix-{red,green,head}.log`、`test-browser-2.log`、`shoot.log`、`scan-fix.log`、`run-chain.cmd`）。
> 利益申明：起稿人 fable-5-1-23 是 permission-card（t-875）的交付人，其原稿 §4 只做到「合入后回归复核」；接手人 fable-5-1-35 未参与四条交付中的任何一条，§4 已按 §1–§3 同一口径（每条声称 → HEAD file:line → 用例）独立重做，本报告四节均为独立第二双眼睛。

## 0. 结论

| 交付 | 关闭项 | ✅ | ◐ | ❌ | 结论 |
|---|---|---|---|---|---|
| t-893 a11y-shell | 11 | 11 | 0 | 0 | **通过**，复扫指标不倒退（§5.6） |
| t-894 a11y-mod-a | 14 + 计划外 1 + QA nit 2 = 17 | 16 | 1 | 0 | **通过**；计划外「查看」钮只补了高没补宽（38×44 仍被复扫命中），QA 直接修（§6 ①） |
| t-895 a11y-mod-b | 10 + 顺手 1 + 附录 2 = 13 | 13 | 0 | 0 | **通过** |
| t-875 permission-card | 17 | 17 | 0 | 0 | **通过**（合入后 17 条全部在位）；复扫新抓到 1 条本交付自己漏的触控项（`查看完整参数` summary 16px），QA 直接修（§6 ②） |

- 声称的代码改动 / 用例 / 场景**全部在复核态上定位到 file:line**（§1–§4 表）。
- 全局门：typecheck ✅、typecheck:preview ✅、web-react 全量单测 **301 / 302 文件绿、4127 例过**（唯一红的 `MessageRenderer.test.tsx` 是 `beforeAll` 10s 冷启超时 —— 集成①起记录在案的基线抖动，单独 `--hookTimeout=60000` 复跑 **152 / 152 绿**）、test:browser **`run.mjs` 68 / 68 全过 + `node --test` 70 / 73（3 红与基线 `210b9967` 记录逐条相同，见 §5）**、ui-preview 复核场景 **20 场景 74 张 0 失败 0 未打桩**、CDP 复扫 **共同 257 场景 0 回归**（cL 58→44、cD 81→69、t44 419→163、names 16→11、ax 3→1、tabBad 13→12；44 个新场景全部有基线外的小量命中，逐条归属见 §5.6）。
- 观察项（不阻断）：t-893 §5 列给 a11y-mod-a / a11y-mod-b 的 12 处跨模块同源项**没有一处落地**（两条 mod 任务的范围是 t-762 清单，交棒发生在它们并行开工之后）；复扫仍命中 `OrgSubscribeDialog`「当前」深色 2.82 等。全部登记在 §7，转 a11y-C 清扫（在跑），QA 不越界改。

方法：① 读四份交付文档的关闭表，把每条声称的改动、用例、场景在复核态上 grep / Read 到 file:line；② 复跑 typecheck / typecheck:preview / `npm test` 全量 / `test:browser`；③ 复用 t-762 的 `scan.mjs` 对复核态全部 301 场景做 CDP 复扫，用 `compare-qa.mjs` 与 t-893 报的 after（257 场景）逐场景比对；④ `shoot.mjs` 出复核场景截图逐张看。

## 1. t-893 · a11y-shell（shell 令牌 / 原语层，shell#1–11）

| # | 声称 | 结论 | 复核态 file:line 证据 | 用例 |
|---|---|---|---|---|
| shell#1 | 深色 `bg-accent` 上 `text-white` → `text-accent-fg`（6 处） | ✅ | `components/ChatHeader.tsx:416`、`settings/SubscriptionDialog.tsx:348`、`org/CreateOrgWizard.tsx:338 / :379`、`settings/PreferencesTab.tsx:289 / :345` | `ChatHeader.test.tsx` 断言 `text-accent-fg`（grep 命中 1） |
| shell#2 | 浅色 hljs 四组重定色 + `.dark` 逐选择器补齐 | ✅ | `styles.css:894`（`#963dbb`）`:896`（`#167547`）`:898`（`#925813`）`:900`（`#2d60c8`） | 视觉项；复扫 hljs 相关命中浅 / 深均 0（§5.6） |
| shell#3 | 五个语义前景压暗 | ✅ | `styles.css:133 / 140 / 143 / 145 / 147`（`#5a3fee` / `#bb202a` / `#157044` / `#8a5511` / `#0a58d8`，行内注释留 was 值与比值） | `designTokens.test` 随全量单测 |
| shell#4 | `--faint` 浅 `#64646f` / 深 `#92929b` | ✅ | `styles.css:132`、`:175` | 同上 |
| shell#5 | base 层 `::placeholder { color: var(--faint); opacity: 1 }` | ✅ | `styles.css:336-341` | — |
| shell#6 | `TimeAgo` → `<time dateTime>` + sr-only 绝对时间，不加 tabIndex | ✅ | `components/ui/TimeAgo.tsx:128-135` | `ui/dataDisplay.test.tsx`（`dateTime` / sr-only 断言，grep 命中 2） |
| shell#7 | `useScrollBodyTabbable` 条件化正文 tabIndex | ✅ | `components/ui/a11y.ts:30`、`ui/Modal.tsx:6, :149` | `ui/a11y.test.tsx`（grep 命中 6） |
| shell#8 | `revealFocusedElement` 挂 Modal / Sheet `onFocusCapture` | ✅ | `ui/a11y.ts:14`、`ui/Modal.tsx:163`、`ui/Sheet.tsx:6, :86` | 同上 |
| shell#9 | DropdownMenu / SegmentedControl 触屏 44px，Switch 命中伪元素 `-inset-y-3` | ✅ | `ui/DropdownMenu.tsx:37, :63`、`ui/SegmentedControl.tsx:28`、`ui/Switch.tsx:22` | `ui/formControls.test.tsx`（grep 命中 3）；复扫 Switch 44×40 / 菜单项 36px 组合全部清零（§5.6） |
| shell#10 | Toast 悬停 / 聚焦暂停 | ✅ | `ui/Toast.tsx:162-164` | `ui/Toast.test.tsx` |
| shell#11 | 白字压 `bg-danger` → `text-danger-fg` | ✅ | `ChatHeader.tsx:416`、`taskboard/TicketCard.tsx:170` | — |

复扫（§5.6）：t-893 报 after cL 58 / cD 81 / t44 419；复核态在同一 257 场景上 44 / 69 / 163，**无任何场景任一指标上升**。

## 2. t-894 · a11y-mod-a（settings / org / manage / market / sidebar）

| # | 声称 | 结论 | 复核态 file:line 证据 | 用例 |
|---|---|---|---|---|
| settings#1 P2 | QQ 推送 Switch `aria-labelledby` + `aria-describedby` | ✅ | `settings/QqBindingCard.tsx:160-161` | `QqBindingCard.test.tsx`「主动推送到 QQ」 |
| settings#2 P2 | 邀请邮箱 `aria-label="成员邮箱"` | ✅ | `org/MembersTab.tsx:508` | `MembersTab.test.tsx`（grep 命中 3） |
| settings#3 P2 | 「设置上限」触控档；停用行去整行 opacity，改 `border-dashed` + `text-muted` | ✅ | `settings/ApiKeysSection.tsx:944`（`border-dashed border-border-strong`）、`:1046`（`min-h-11 px-2`）；代码内无 `opacity-60`（仅 `:939` 注释提及旧值） | 复扫 `设置上限 52×15.9` / `已停用 2.35` 组合已清零 |
| manage#1 P2 | 标签「+N」钮 `min-h-11 min-w-11` | ✅ | `manage/SkillsPanel.tsx:430` | `SkillsPanel.test.tsx` |
| market#1 P2 | 拒绝理由输入框改本地 `useRejectReasonPrompt` + `Field label="拒绝原因"` | ✅ | `marketplace/ReviewPanel.tsx:52, :95, :213` | `ReviewPanel.test.tsx`（grep 命中 12） |
| sidebar#1 P2 | RepoPill 去 opacity 改 `text-muted` | ✅ | `github/RepoPill.tsx:68` 注释起的实色分层；代码内无 `opacity-*`（仅 `:68` 注释提及旧值） | `RepoPill.test.tsx`（grep 命中 3）；§5.5 `sidebar-repo-banner--mobile` 四态 pill 文字均实色 |
| manage#2 P3 | 折叠态 `aria-controls` 条件化 | ✅ | `manage/ProjectSkillOverlay.tsx:127`、`manage/SkillOptPanel.tsx:699` | `ProjectSkillOverlay.test.tsx` |
| manage#3 P3 | Cron 表达式 Tooltip 触发 `role="note"` + 44px | ✅ | `manage/CronPanel.tsx:536` | 复扫 4 组 `span 18px` 组合清零 |
| manage#4 P3 | 「重试」`min-h-11 min-w-11`；二维码链接 `min-h-11` | ✅ | `manage/IdentityManual.tsx:49`、`settings/ConnectorsTab.tsx:1888` | 复扫 `重试读取… 26×44` / `单独打开二维码 100×18` 清零 |
| market#2 P3 | 「我的发布」`aria-controls` 条件化 | ✅ | `marketplace/PublishPanel.tsx:2301`（`isOpen ? "my-publishes-list" : undefined`）、`:2315`（`<ul id="my-publishes-list">`；行号按 HEAD `77a93d9e1`，§6 ① 在前面加了 2 行） | `PublishPanel.test.tsx`（aria-controls 两态）；该折叠钮本身触屏 322×42 差 2px 属既有项 → §7 #6 |
| settings#5 P3 | FAQ summary / 反馈类别 chip / 充值金额 chip / 「含组队」钮 44px | ✅ | `ApiKeysSection.tsx:36-37`（`FAQ_SUMMARY_CLASS`）`:701 / 754 / 785 / 832`；`settings/FeedbackTab.tsx:295`；`org/OrgTopupDialog.tsx:235`；`settings/UsageTab.tsx:669` | 复扫 `¥ 100…` / `问题反馈` / `含组队…` / `手动配置 CC Switch` 组合清零 |
| settings#6 P3 | 「已禁用」改 `Badge tone="warning" size="sm"` | ✅ | `ApiKeysSection.tsx:981-982` | — |
| sidebar#2 P3 | RepoStatusBanner 状态词 / 错误原文去 opacity | ✅ | `github/RepoStatusBanner.tsx:59` 注释处；剩 `:55`（`aria-hidden` 图标）与 `:85`（关闭 IconButton `opacity-70`）为图标非文本，见 §7 观察 | 复扫 `RepoStatusBanner opacity-80` 组合清零 |
| sidebar#4 P3 | 空态「新建会话」`min-h-11 px-2`、「多选」`min-w-11` | ✅ | `Sidebar.tsx:669`、`:976` | 复扫 sidebar-mobile-drawer t44 2→0 |
| 计划外 | SubmitBar「查看」触控档 | **◐** | `marketplace/PublishPanel.tsx:328` 只有 `min-h-11 px-2`：复扫 `market-publish{,-validation,-list-mobile,-agent-mobile,-plugin-mobile}` **5 处仍命中 `button 38×44`**（高够了、宽只有 38）；展开态的「收起」（`:343`）连触控档都没补 | → §6 ① QA 直接修 |
| QA#1（t-1028 §6 #1） | BrowsePanel 分类区 `tabIndex` 只在窄屏给 | ✅ | `marketplace/BrowsePanel.tsx:73-85`（`useNarrowViewport`，`matchMedia` 有 typeof 护栏）、`:383` | `BrowsePanel.test.tsx`（grep `tabindex` 命中 2） |
| QA#2（t-1028 §6 #2） | 「检查更新」`<output aria-live>` 常驻 | ✅ | `SettingsCenter.tsx:586-590`（无条件渲染，只切文本） | `SettingsCenter.test.tsx`（`about-update-status` 命中 5） |

## 3. t-895 · a11y-mod-b（media / messages / tools / taskboard / landing / composer）

| # | 声称 | 结论 | 复核态 file:line 证据 | 用例 |
|---|---|---|---|---|
| media#1 P2 | MediaTaskCenter 拆 `shrink-0` header + `min-h-0 flex-1 overflow-y-auto` body | ✅ | `MediaTaskCenter.tsx:455-487`（注释 + 结构） | `MediaTaskCenter.test` 25 例随全量；复扫 media-task-center t44 1→0 |
| media#2 P3 | 「技术详情」summary `py-3.5`；圈选编辑器关闭钮 `size-11` | ✅ | `MediaTaskCenter.tsx:213`、`ImageAnnotationEditor.tsx:804` | 复扫 `FailureNote summary 293×16` / `关闭图片编辑器 40×40` 清零 |
| messages#1 P3 | 查找条关闭后焦点归位（记录来处 / 只在掉到 body 时还回） | ✅ | `MessageRenderer.tsx:1258-1284` | `MessageRenderer.test.tsx` +2（grep 「查找条 / 焦点」命中 6） |
| messages#2 P3 | ReqIdChip 44px；「查看请求信息」summary `py-3.5` | ✅ | `chat/cards.tsx:221`、`:844` | 复扫 `ReqIdChip 70×20` / `查看请求信息 85×16` 清零 |
| tools#1 P3 | researchCards Chip / ArtifactPreviewLink 44px | ✅ | `tool/researchCards.tsx:212`、`:545` | `researchCards.test.tsx` 类名契约（grep 命中 2） |
| taskboard#2 P3 | 「系统活动」钮 44px；快照 summary `py-3.5` | ✅ | `taskboard/TicketTimeline.tsx:201`、`:136` | 复扫 taskboard-ticket-drawer t44 2→0 |
| landing#1 P3 | 菜单钮 `menuButtonRef` Esc 归位；`aria-controls` 条件化 | ✅ | `Landing.tsx:316, :325, :364-367, :377` | `Landing.test.tsx`（grep 「打开导航 / aria-controls」命中 7） |
| landing#2 P3 | 页脚 `FOOTER_LINK_CLS`、FAQ summary、演示 chip、AuthGate `TOUCH_TEXT_BTN`、checkbox `size-5` | ✅ | `Landing.tsx:302, :755-774`；`landing/DemoShowcase.tsx:262, :430`；`AuthGate.tsx:21, :448, :531, :583, :663, :685, :731, :790` | 复扫 landing 11 场景 t44 各 18→0、auth-* 2→0（§5.6） |
| composer#2 P3 | 锁定行 `text-faint opacity-80` → `text-muted` + sr-only「（需升级解锁）」 | ✅ | `ModelSelector.tsx:432-434`、`:461-463` | 复扫 composer-model-menu cL 5→0、cD 4→0 |
| composer#3 P3 | 会话目标 chip 44px | ✅ | `Composer.tsx:512` | 复扫 composer-loaded / composer-busy t44 2→0 |
| 顺手 | landing 折叠态 `aria-controls` 悬空 | ✅ | `Landing.tsx:367` | 同 landing#1 |
| 附录 L-11 | AuthGate 邮箱占位符改示例格式、密码框去同词占位 | ✅ | `AuthGate.tsx:520, :611`（`name@example.com`）；文件内无 `placeholder="密码"` | `AuthGate.test.tsx`（grep 命中 2） |
| 附录 M-23 | `selectionPresent` 改 `useState`，只在需要时扫 mask | ✅ | `ImageAnnotationEditor.tsx:336, :435, :458, :490, :535, :666, :682-685` | `ImageAnnotationEditor.test.tsx`（`getImageData` / 「已选中区域」命中 17） |

## 4. t-875 · permission-card（PC-01–17，接手人独立逐条）

复核态 = HEAD `77a93d9e1`（§6 ② 在 `:233-235` 加了 2 行，以下行号已按 HEAD）。文件均在 `packages/web-react/src/components/chat/`，声称列摘自 `docs/audit/permission-card.md` §4。

| # | 声称（t-875 §4） | 结论 | 复核态 file:line 证据 | 用例（`PermissionCard.test.tsx`） |
|---|---|---|---|---|
| PC-01 P2 | 卡头 `flex-wrap gap-y-1`；标题 `whitespace-nowrap`；工具片 `min-w-0 max-w-full` 内部截断；状态 + 倒计时 `ml-auto flex-wrap justify-end` 成组 | ✅ | `PermissionCard.tsx:429`（`flex flex-wrap items-center gap-x-2.5 gap-y-1`）、`:433`、`:438-440`（`min-w-0 max-w-full` + `truncate`）、`:444` | 视觉项 → §5.5 `multi-pending-cards--mobile`：「退出计划模式」一行、状态 + 倒计时整组换行右对齐 |
| PC-02 P2 | `compactRequestSummary()`；待决卡露 `$ 命令` / 问答卡露首题 + 「共 N 题」；已结清 / ExitPlan / 截断中不显示 | ✅ | `:131-133`（函数，注释写明与 `PermissionInputSummary` 同优先级）、`:409-410`（`!resolved && !questions && !isExitPlan`）、`:468-481`（`!resolved && !isExitPlan && !inputTruncated`，`line-clamp-2`） | `:911` PC-02 |
| PC-03 P3 | 活提问过期 fail-safe 说明行 | ✅ | `:535`（`data-testid="permission-expired-failsafe"`） | `:1075` PC-03 |
| PC-04 P2 | Host `minimized` 兜底：dismissed **或** 活提问 | ✅ | `:714-719`（`pending.find(… isPermissionUiDismissed(id) \|\| isLive(message))`）、`:729-730`（`PendingApprovalBar count={pending.length}`） | `:976` PC-04 |
| PC-05 P3 | 卡头状态 `<span>` → `<output>` | ✅ | `:445-449` | `:959` PC-05 |
| PC-06 P3 | `formatPermissionRemaining()` ≥ 90 分钟按小时 | ✅ | `:123`（导出）、`:460`（调用） | `:944` PC-06（×5 断言） |
| PC-07 P3 | 临期 `AlertTriangle` + `font-medium` + `title` | ✅ | `:13`（import）、`:453-459`（`title="即将过期，请尽快处理"`、图标 `aria-hidden`） | 既有「finite deadline countdown」用例仍断言 `text-warning` |
| PC-08 P3 | 内联「拒绝」`ghost` → `secondary` | ✅ | `:509-512` | 视觉项 → §5.5：「审批」实心 + 「拒绝」描边成对 |
| PC-09 P3 | 计划预览底部渐隐层 | ✅ | `:548-551`（`h-10 bg-gradient-to-t from-surface to-transparent`，`pointer-events-none`） | 视觉项 → §5.5 |
| PC-10 P3 | 入口条 `count` > 1 时「共 N 项待处理」 | ✅ | `:659`、`:729` | `:964` PC-10/11 |
| PC-11 P3 | 正文去「· 打开」 | ✅ | `:658-659`（单条只剩「智能体在等你确认」） | 同上 |
| PC-12 P2 | 选项组 ↑↓←→ / Home / End；单选 roving tabindex，多选各自可 Tab | ✅ | `:941-954`（`onOptionsKeyDown`，`:946` 非方向键 / Home / End 直接 return）、`:1068`（挂到选项组）、`:1078` / `:1109`（`optionTabIndex`） | `:1000`、`:1022` PC-12 ×2 |
| PC-13 P2 | 出错题 `role="alert"` + `aria-describedby`；焦点送到首选项并 `scrollIntoView`；作答即清错 | ✅ | `:915-921`（`section.scrollIntoView?.({ block: "nearest" })`）、`:1067`（`aria-describedby={error === idx ? errorId : undefined}`）、`:1154`（`role="alert"`） | `:1045` PC-13 |
| PC-14 P3 | 多题每题「i / N」 | ✅ | `:1051-1057`（`{idx + 1} / {questions.length}`） | PC-13 用例末尾断言「1 / 2」「2 / 2」 |
| PC-15 P3 | 「其他」输入框 Enter → `submit()` | ✅ | `:1136-1140` | `:1152` PC-15 |
| PC-16 P3 | 批准中状态图标 `LoaderCircle animate-spin text-accent` | ✅ | `:384-387` | `:1098` PC-16 |
| PC-17 P3 | ExitPlan 不渲染工具片 | ✅ | `:436-437`（`!questions && !isExitPlan &&`） | `:1117` PC-17 |

- 附带声称：`scenes-permission-card.tsx` 13 场景 id 齐全（pending-modal / pending-dismissed / approving / settled / expired / expired-live / multi-pending-modal / multi-pending-cards / ask-single / ask-multi / exit-plan / input-loading / urgent），复扫 13 / 13 渲染成功（§5.6）；`MessageRenderer.test.tsx:701`「AskUserQuestion → 答题框」用例在位并随 `vitest-mr.log` 152 例绿；`lib/chat/permissionPopupCoordinator.ts` / `permissionReconcile.ts` 相对基线 `210b9967` **零 diff**（`git diff --stat` 为空），与文档「未改协调器」一致。
- 用例数：`PermissionCard.test.tsx` 现 71 例（t-875 交付 70 + §6 ② 新增 1），`vitest-fix-head.log`。

复扫新抓到（t-875 交付时预览台还没有这些场景可扫）：`permission-card-settled` t44 = 6、`permission-card-pending-modal` t44 = 1 —— 全部是 `PermissionInputSummary` 的 `<summary>查看完整参数</summary>`（296×16 / 348×16），触屏下只有一行字高；同一约定（`[@media(hover:none)]:py-3.5`）media#2 / messages#2 / taskboard#2 都补了，本交付漏了 → §6 ②。其余命中：`misc` 9–17 全部是消息动作栏 hover 才显的 `focusable-invisible` 按钮（复制 / 引用 / 编辑…），messages 既有项、扫描器本就不计入问题；`click` 1–2 为 Tooltip 触发器内部 onClick，同 a11y-mod-a manage#3 口径。

## 5. 全局验证（复核态 `b23955208` + §6 修复后）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0（`typecheck.log`） |
| 预览台场景类型检查 | `npm run typecheck:preview --workspace packages/web-react` | ✅ exit 0（`typecheck-preview.log`） |
| 全量单测 | `cd packages/web-react; npm test` | ◐→✅ `vitest-all.log`：**301 / 302 文件绿、4127 例过、152 skipped**；唯一红 `src/components/MessageRenderer.test.tsx` 为 `beforeAll` 冷启 `Hook timed out in 10000ms`（未跑到任何断言）—— 集成① / t-875 §5 均记录的基线抖动；单独复跑 `npx vitest run src/components/MessageRenderer.test.tsx --maxWorkers=1 --hookTimeout=60000` → **152 / 152 绿**（`vitest-mr.log`，77.8s）。合计 302 / 302 文件绿 |
| QA 修复的两文件单测 | `npx vitest run src/components/chat/PermissionCard.test.tsx src/components/marketplace/PublishPanel.test.tsx --maxWorkers=1` | ✅ 修前 **2 红 / 86 过**（`vitest-fix-red.log`：`PermissionCard.test.tsx:1145` 缺 `[@media(hover:none)]:py-3.5`、`PublishPanel.test.tsx:442` 缺 `min-w-11`）→ 修后 **88 / 88 绿**（`vitest-fix-green.log`）；HEAD `77a93d9e1` 再跑 **88 / 88 绿**（`vitest-fix-head.log`） |
| 真浏览器门 | `$env:OC_E2E_BROWSER=<Chrome 153>; npm run test:browser` | ◐ `test-browser-2.log`：`run.mjs` **68 / 68 全过**（清单 68 条全部执行，含 T13 工具卡触控、T15 Ask UI 移动端、T25 390×844 整页、T57 permission live-units、T68 390px 动作行 44px）；`node --test` **73 条 70 pass / 3 fail**，3 条与基线 `210b9967` 及 t-875 §5 记录**逐条相同**：`cc-switch-ascii-name` ×2（`getByText('还没有 API Key')` 等待超时；期望 `gemini-3.8-flash` 实得 `sonnet-5`，settings 归属）、`OCV5-185`（Windows 未开发者模式 `symlink EPERM`），均非四条交付引入。起稿人的 `test-browser.log` 在 `node --test` 中途截断（离队），本轮完整复跑 |
| 视觉 | `OC_UI_SCENES=<§5.5 清单> OC_UI_SHOT_DELAY=900 node browser-tests/ui-preview/shoot.mjs` → `shots\` | ✅ **20 场景 74 张，`failures: []`、`retried: []`、`unmockedApi: []`**（`shoot.log` / `shots\manifest.json`） |
| CDP 复扫 | `OC_REPO=wt/qa-a11y node .audit-tmp/a11y/scan.mjs`（全部 301 场景，桌面浅 / 深 + 移动） | ✅ 301 / 301 无渲染失败（`scan.log`）；对比见 §5.6 |
| CDP 复扫（§6 修后） | `OC_UI_SCENES=permission-card,market-publish OC_A11Y_OUT=scan-fix node scan.mjs` | ✅ 21 / 21（`scan-fix.log`）：`permission-card-settled` t44 **6→0**、`permission-card-pending-modal` t44 **1→0**、`market-publish{,-validation,-agent-mobile,-plugin-mobile}` t44 **各 1→0**、`market-publish-list-mobile` t44 **2→1**（剩的 1 是既有「我的发布」折叠钮 322×42，t-893 基线里已有，→ §7 #6）；13 个权限卡场景 cL / cD / names / ax / tabBad 全 0 |
| 试合并 | `git merge-tree --write-tree 2d2b5cafc HEAD`（integration 现 HEAD） | ✅ 无冲突（integration 在复核态 `b23955208` 之后只多 2 提交：`4a2745283` App 接线 hud / misc-p3、`2d2b5cafc` tutorials 同步快照，均不触及四条交付文件） |

### 5.5 截图逐张看（`shots\`）

清单（`OC_UI_SCENES`，子串匹配到 20 场景）：`permission-card-settled` / `permission-card-pending-modal` / `permission-card-multi-pending-cards`（§4 + §6 ②）、`market-publish-validation` / `market-publish-list-mobile`（§6 ①）、`shell-ui-kit`（shell#1–4、#9）、`composer-model-menu`（composer#2）、`landing-section-footer` / `landing-faq-open`（landing#2）、`auth-forgot`（L-11）、`settings-full-api-access`（settings#3 / #5 / #6）、`sidebar-repo-banner`（sidebar#1 / #2）、`media-task-center*`（media#1）、`manage-cron-range`（manage#3）、`messages-error-states`（messages#2）、`taskboard-ticket-drawer*`（taskboard#2）、`org-topup-dialog`（settings#5）。desktop / mobile × light / dark，Read 逐张看的结论：

| 图 | 看到的 | 对应项 |
|---|---|---|
| `permission-card-multi-pending-cards--mobile--light` | 顶部条「智能体在等你确认 · 共 3 项待处理」+「打开」；三张卡：权限请求卡「等待审批… · 约 30 分钟内有效」整组换到第二行右对齐、`$ sed -i …` 摘要两行截断、「审批」实心 + 「拒绝」描边成对；问答卡露出首题「贡献指南里的 PR 模板要保留英文原文对照吗？」；退出计划模式卡只有标题无重复工具片、「约 24 小时内有效」、计划预览底部渐隐。与 t-875 `after-2` 同名图一致，无回归 | PC-01 / 02 / 06 / 08 / 09 / 10 / 11 / 17 ✅ |
| `permission-card-settled--mobile--light` | 10 张已结清卡（允许 / 拒绝 / 超时 / 断连 / 崩溃 / 本轮停止 / 问答已提交 / 跳过 / 计划已确认 / 已受理）各带「查看完整参数」summary；summary 行上下留白已加大（§6 ② `py-3.5`），卡间距与桌面版一致，无溢出 | §6 ② ✅ |
| `market-publish-validation--mobile--light` | 底栏「还差 6 项必填 · 查看」，「查看」与「·」之间因 `min-w-11 px-2` 拉开，仍在一行；右侧「发布到市场」按钮、下方红字「请修正上方标记的字段后重新提交。」布局不变 | §6 ① ✅ |
| `composer-model-menu--mobile--dark` | 锁定行「Fable 5.1 ×12.0」带锁图标、文字为 muted 实色可读（不再 faint + opacity）；禁用行「GLM-5 Air 暂不可用」保持压暗（exempt，§5.6 ①） | composer#2 ✅ |
| `sidebar-repo-banner--mobile--light` | 横幅四态（准备中 / 正在克隆 / 已就绪 / 克隆失败 + `fatal: could not read Username`）状态词与错误原文均实色；「重试」独立描边按钮；RepoPill 四态 owner / 分支 / 状态实色 | sidebar#1 / #2 ✅ |
| `settings-full-api-access--mobile--light` | 密钥列表停用行为虚线描边 + 「已禁用」warning Badge，其余行正常；三把密钥 / 消耗统计 / 请求审计错误态整页无横向溢出 | settings#3 / #6 ✅ |
| `shell-ui-kit--mobile--dark` | Button 8 变体、3 尺寸 + 提交中 / 不可用 / 药丸、IconButton 6 变体、Badge 6 tone + chip 两态、Alert 各 tone 深色下文字全部可读；「删除」danger 底为深字（`text-danger-fg`）非白字 | shell#1 / #3 / #11 ✅ |
| `media-task-center--mobile--light` | 「视频任务」标题 + 刷新 / 关闭固定在头部，正文（长视频项目卡、单段视频）独立滚动；「保留旧结果」「重做」「取消项目」触控高度充足 | media#1 ✅ |
| `auth-forgot--mobile--light` | 找回密码页邮箱框占位符「注册邮箱」—— 与 L-11 交付文写明的「找回密码页『注册邮箱』是提示不是复读，保留」一致（登录 / 注册页才改 `name@example.com`，`AuthGate.tsx:520 / :611`） | L-11 ✅（无偏差） |

未逐张展开的其余图（landing 页脚 / FAQ、manage-cron-range、messages-error-states、taskboard-ticket-drawer*、org-topup-dialog、各桌面 / 深色版本）只核「渲染成功 + 无溢出 + 无空白」，74 / 74 通过，CDP 指标见 §5.6。

### 5.6 CDP 复扫对比（`compare-qa.txt`）

基线 = t-893 报的 after（`.audit-tmp\a11y-shell\scan-after`，257 场景）；复核态 = 本轮 `scan\`（301 场景；多出的 44 个是集成④之后才有的 hud / kp-automation / misc-options / permission-card 场景，无 t-893 基线，单列）。

| 指标（共同 257 场景） | t-893 after | 复核态 | 变化 |
|---|---|---|---|
| 浅色文本对比度 <4.5（cL） | 58 | 44 | −14 |
| 深色文本对比度 <4.5（cD） | 81 | 69 | −12 |
| 移动端 44px 触控命中（t44） | 419 | 163 | −256 |
| 桌面 24px 拥挤触控（t24） | 371 | 371 | 0 |
| 无名控件（names / ax） | 16 / 3 | 11 / 1 | −5 / −2 |
| Tab 走查异常（tabBad） | 13 | 12 | −1 |
| 渲染失败 | 0 | 0 | — |

- **逐场景回归（复核态任一指标 > t-893 after）：0 个**；改善 43 个场景（landing 11 场景 t44 各 18→0、auth 7 场景、composer-model-menu cL 5→0 / cD 4→0、settings-full-api-access cL 5→0 / cD 6→0 / t44 7→0、sidebar-repo-banner cL 7→0 / cD 5→0 …）—— 即 a11y-mod-a / mod-b 的修复在合入态上量化成立。
- 触控组合：t-893 after 98 组 → 51 组；清零 50 组（AuthGate 文字钮 / checkbox、DemoShowcase chip、Landing 页脚 `a 50×19` ×55、FAQ summary ×44、Cron Tooltip span、ApiKeysSection FAQ / 上限钮、FeedbackTab chip、OrgTopup 金额、UsageTab 含组队、ReqIdChip、FailureNote summary、关闭图片编辑器 40×40、IdentityManual 重试、SkillRow「+1」…）；**新出现 3 组**全是同一处：`SubmitBar 「查看」 button 38×44` ×5（→ §6 ①）。
- 对比度组合：浅色 25 → 16、深色 24 → 17，**无 NEW 组合**；剩余命中逐条归属：① 禁用控件（`#8a8a8d/#fff` 3.44「添加规则 / GLM-5 Air」×16、`#848489/#f2f2f6` 3.35 AuthGate 主按钮 ×42、RevokeBox「下架」/ Installed「卸载」disabled ×8、AgentScopePicker、AttachChip）—— WCAG 1.4.3 对 disabled 不作要求，t-762 亦未列问题；② 沉浸式媒体编辑器 `text-white/35~50`、`#999/#fff` 与容器预览黑底（t-762 各模块小节既有登记，不在四条范围）；③ **`OrgSubscribeDialog`「当前」`#ffffff/#9a8aff` 2.82（深色，文本）** 与 `AgentPicker`「默认」`bg-accent/15` 4.4（浅色）—— 正是 t-893 §5 交棒给 a11y-mod-a / composer 而未落地的项 → §7。
- 44 个新场景：hud 10 个全 0；kp-automation 14 个命中均为禁用按钮（「添加规则」3.44 / 「保存并启用 0 条规则」3.35，exempt）+ 1 枚 `从当前账号已加入的星球中选择 316×42`（差 2px，kp-automation 归属，§7）；misc-options 5 个命中为 optionsGroup 的 `bg-accent text-white` ✓ 勾（深色 2.82 / 2.34）与禁用「发送选择」—— 前者是 t-893 §5 交棒 mod-b 未落地项（§7）；permission-card 13 个见 §4。
- **§6 修后复扫（`scan-fix\`，HEAD `77a93d9e1`，21 场景）**：`permission-card-settled` t44 6→**0**（六枚 `查看完整参数 296×15.9` 全部消失）、`permission-card-pending-modal` t44 1→**0**；`market-publish` / `market-publish-validation` / `market-publish-agent-mobile` / `market-publish-plugin-mobile` t44 各 1→**0**（`SubmitBar 查看 38×44` 消失）、`market-publish-list-mobile` t44 2→**1**（消失的是「查看」，剩的 1 是 `MyPublishes` 折叠钮 `我的发布（6）… 322×42`，t-893 after 基线里就有，非本轮项 → §7 #6）。21 场景其余指标（cL / cD / t24 / names / ax / tabBad）与修前逐项相同，无新增命中 —— §6 两处修复在 CDP 口径上量化成立，且未带入回归。

## 6. QA 直接修复（同分支独立 commit）

| # | 位置 | 问题 | 修法 | 断言（修前红 / 修后绿） | 提交 |
|---|---|---|---|---|---|
| ① | `marketplace/PublishPanel.tsx:328-329`（「查看」）、`:344-345`（「收起」；HEAD 行号） | a11y-mod-a 计划外只补了 `min-h-11`，两个字宽 38px，复扫 5 处仍命中 `38×44`；展开态「收起」根本没补触控档 | 两钮同一副：`inline-flex items-center justify-center … [@media(hover:none)]:min-h-11 [@media(hover:none)]:min-w-11 [@media(hover:none)]:px-2`，桌面零变化 | `PublishPanel.test.tsx:442` K-21 用例补 `toHaveClass("[@media(hover:none)]:min-h-11", "[@media(hover:none)]:min-w-11")` ×2（查看 / 收起）—— 修前「查看」缺 `min-w-11`、「收起」两枚都缺 → 红（`vitest-fix-red.log`）；修后绿；修后复扫 5 处 `38×44` 全部消失（§5.6） | `77a93d9e1` |
| ② | `chat/PermissionCard.tsx:235`（`PermissionInputSummary` 的 `<summary>查看完整参数`；HEAD 行号） | 已结清卡 ×6 与普通审批框 ×1 复扫命中 16px 高触控靶，permission-card 交付漏用了 media#2 / messages#2 / taskboard#2 的同一约定 | `[@media(hover:none)]:py-3.5`，桌面零变化 | `PermissionCard.test.tsx:1137` 新增「QA t-1232 『查看完整参数』summary 触屏补 44px 高」（已结清卡 + 活提问审批框两处 `toHaveClass`）—— 修前红（`vitest-fix-red.log`）、修后绿；修后复扫 settled 6→0 / pending-modal 1→0（§5.6） | `77a93d9e1` |

提交 `77a93d9e1`（`style(v5): QA 复核 a11y-B · 发布底栏「查看 / 收起」触控靶补宽 min-w-11、权限卡「查看完整参数」summary 触屏补 44px 高（t-1232）`）：4 文件 +27 −4，subject 不含 `fix(v5)`（d-26）；接手人复核该提交 diff（`git show 77a93d9e1`）只含两处 `className`（「收起」同时补 `inline-flex items-center justify-center` 让 `min-w` 生效）、行内注释与对应断言，无其他改动。

## 7. 观察项（不阻断 · QA 未改 · 归属与一句修法）

| # | 位置 | 现象 | 归属 / 处置 |
|---|---|---|---|
| 1 | t-893 `a11y-shell.md` §5 整张「跨模块同源项」表（12 行） | 交棒给 a11y-mod-a / a11y-mod-b 的项**全部未落地**：两条 mod 任务以 t-762 清单为范围、与 t-893 并行开工，§5 是 t-893 复扫后才写的，没人接。复核态 grep 仍在：`org/OrgSubscribeDialog.tsx:173`「当前」`bg-accent text-white`（深色 2.82，**文本**，与 shell#1 同类，P2 级）、`manage/OptimizationPanel.tsx:296` / `settings/ApiKeysSection.tsx:476` 图标块 `text-white`（非文本 2.82 <3:1）、`components/AgentPicker.tsx:148`「默认」`bg-accent/15` 4.4、`components/RichBlocks.tsx:256, :274`（optionsGroup ✓ 勾 / 「发送选择」`text-white`，深色 2.82）、`ImageCommentMode.tsx:410` / `ImageAnnotationEditor.tsx:1057` `bg-danger text-white`（深色 3.07）、`settings/KnowledgePlanetAutomationPanel.tsx:960` 勾选态 `text-white` | **转 a11y-C 清扫（在跑）**：一律 `text-white → text-accent-fg / text-danger-fg`，`bg-accent/15 → bg-accent-soft`。QA 不越界改：任务书点名 a11y-C / 遗留清扫在跑、撞文件先对齐 |
| 2 | `settings/KnowledgePlanetAutomationPanel.tsx` 「从当前账号已加入的星球中选择」钮 | 触屏 316×42（差 2px） | kp-automation 归属 → 同上转 a11y-C |
| 3 | `github/RepoStatusBanner.tsx:85` 关闭 IconButton `opacity-70` | 图标控件降色，soft 底上非文本对比可能 <3:1（复扫按文本口径未计） | sidebar 归属，P3 nit；改 `text-muted` 实色即可 |
| 4 | `ModelSelector` CostMark `x0.5` 深色 `#575760/#1c1c25` 4.36 | 出现在**禁用**行「GLM-5 Air 暂不可用」内（opacity 合成色），exempt；mod-b 说的「白底 ≥4.5」是启用行 | 不处理，登记口径 |
| 5 | 全部 a11y-B 交付未跑真机读屏（NVDA / VoiceOver） | 三份文档均如实标 NOT RUN；可访问名以 CDP AX 树 + testing-library 名字算法双核 | 保持 NOT RUN，归档时统一注明 |
| 6 | `marketplace/PublishPanel.tsx:2296-2313` `MyPublishes` 折叠钮「我的发布（N）…」（`className` 在 `:2302`） | 触屏 322×42（`py-2.5`，差 2px）；t-893 after 基线里已有，a11y-mod-a market#2 只改了它的 `aria-controls`，触控档不在其声称范围 | market 归属，P3 nit；`py-2.5` → `[@media(hover:none)]:min-h-11` 一行即可。QA 不越界改（非四条交付的声称项），转 a11y-C / leftover-shell 顺手 |
| 7 | 起稿人 `test-browser.log` / `vitest-all.log` 的口径 | 全量单测在并行全量时 `MessageRenderer.test` 冷启超时属基线抖动（t-875 §5、集成①同样记录）；建议集成⑤ 全量门沿用「全量 + 该文件单独 `--hookTimeout=60000` 复跑」两步口径，不要把它当红 | 归档 / 集成时口径注明 |

## 8. 改动文件（本任务）

- `docs/audit/qa/QA-a11y.md`（本文，新增）
- `packages/web-react/src/components/marketplace/PublishPanel.tsx`、`PublishPanel.test.tsx`（§6 ①，`77a93d9e1`）
- `packages/web-react/src/components/chat/PermissionCard.tsx`、`PermissionCard.test.tsx`（§6 ②，`77a93d9e1`）
- 仓库外：`.audit-tmp\qa-a11y\`（复扫结果 `scan\` / `scan-fix\`、对比脚本、截图 `shots\`、全部日志、`run-chain.cmd` 验证链脚本）

## 9. 接手说明与集成提示

- 起稿人 fable-5-1-23 在 `77a93d9e1` 提交后离队，报告只留在工作树未提交、分支未 push；接手人 fable-5-1-35 在同一工作树 `wt\qa-a11y` 继续：未改任何业务代码，只补齐报告（§0 / §2 行号勘误 / §4 重做 / §5 / §5.5 / §5.6 / §7 #6–7 / 本节）并提交推送。§1–§3 的每一条 file:line 均由接手人按 HEAD 逐行抽读核对（`Get-Content` 定位到行），发现 3 处小勘误（market#2 行号 +2、settings#3 / sidebar#1 两处「文件内无 opacity」实为仅注释提及），已改；无一条结论需要翻转。
- 复核态基于 integration `b23955208`；integration 现 HEAD `2d2b5cafc` 只多 2 个与四条交付无关的提交，`git merge-tree` 试合无冲突（§5）。集成⑤ 合入本分支时应只带入 `77a93d9e1`（4 文件）+ 本报告提交。
- QA 结论**不变**：四条交付全部通过；§6 两处 QA 直接修复已在 CDP 与 vitest 两个口径上证明修前红 / 修后绿且无回归。
