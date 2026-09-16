# permission-card · 会话内权限审批卡 未决态审批交互 专审 + 修复（PC-xx）

> 任务 t-875（t-837 的重开）· 流程 A→B 同人合一 · 分支 `feat/v5-selfhost-audit-permission-card`（基于 `210b9967`）
> 执行：fable-5-1-56（建场景、出 before、PC-01…PC-15 代码与用例，未提交即离线）→ fable-5-1-52（未留下改动）→ **fable-5-1-23 接手收口**（本文、PC-03 / PC-16 / PC-17、卡头分组修正、既有用例同步、复跑验证、提交推送）。
> 背景：t-760 覆盖复查指出 messages-A（t-32）的 `ask-user-question` 场景只含「已解析权限卡」，未决态（待决 / 批准中 / 拒绝 / 超时 / 多卡并发 / 键盘 / 移动端）无人审过。
> 证据目录（仓库外，PNG 不入库）：`D:\code\test_project\test123\.audit-tmp\permission-card\{before,after-2}\` + `*.log`。

## 0. t-837 声称项核对表（指挥官补发任务书首节）

t-837 在任务库的交付记录异常（assignee 为「派活回执」），需先核它声称的改动是否真落地。核对口径：integration `feat/v5-selfhost-ocv5-audit-ux @ c034f05d7` 与基线 `210b9967`、`docs/audit/**`、全部本地分支。

| 核对项 | 结论 | 证据 |
|---|---|---|
| integration 上 `PermissionCard.tsx` / `PermissionCard.test.tsx` 是否有 t-837 的改动 | **无** —— 与基线逐字节相同 | `git log --oneline 210b9967..c034f05d7 -- packages/web-react/src/components/chat/PermissionCard.tsx packages/web-react/src/components/chat/PermissionCard.test.tsx` 为空；`git diff --stat 210b9967 c034f05d7 -- <同两文件>` 为空 |
| `docs/audit/**` 是否有 PermissionCard 专审文档或 PC-xx 条目 | **无** | `git grep -n -E "PermissionCard\|权限卡\|PC-[0-9]{2}" c034f05d7 -- docs/audit` 仅命中 `messages.md:18`（文件清单）与 `:33`（`messages-ask-user-question` 场景「已解析权限卡」，即 t-760 指出的薄弱点本身）；`git grep -n "t-837" c034f05d7 -- docs` 为空 |
| 是否有任何分支含 t-837 的提交 | **无** —— 触碰 `PermissionCard.tsx` 的提交只有基线以前的历史与本轮 `2ceeff88f` | `git log --all --oneline -- packages/web-react/src/components/chat/PermissionCard.tsx` |
| t-837 原持有人留下了什么 | 仅 `wt\permission-card` 工作树内的**未提交**改动（`PermissionCard.tsx` +211/−27、`PermissionCard.test.tsx` +181/−1、未跟踪 `scenes-permission-card.tsx`）与 `.audit-tmp\permission-card\{before,after}` 截图、4 份 vitest 日志；无文档、无提交、未 push | `git status` / 导出记录 `fable-5-1-56-2026-09-16-15-12-30.md`（记录截止于领到 t-837 的任务书，之后的改动只在工作树里） |

结论：**t-837 没有任何声称项落地到 integration，无可核之「声称」**；其工作树里的半成品即本轮 §4 里标注「fable-5-1-56 完成未提交」的 PC-01 / 02 / 04–15，已由本人逐行走读核对（每条改动与其注释、用例一致，且 70 例单测绿）后收口提交，见 §4 与 §5。

## 1. 范围与文件清单

| 文件 | 角色 | 本轮 |
|---|---|---|
| `packages/web-react/src/components/chat/PermissionCard.tsx` | 时间线卡 + 三种审批框（普通 / AskUserQuestion / ExitPlanMode）+ `PermissionPromptHost` 弹框宿主 + 待答入口条 | **改**（PC-01…PC-17） |
| `packages/web-react/src/components/chat/PermissionCard.test.tsx` | 单测 | **改**（+13 例，1 例按 PC-02 契约改写） |
| `packages/web-react/src/components/MessageRenderer.test.tsx` | 时间线层单测（messages 归属） | **改 1 处断言**（PC-02 后题干同时在卡上可见，`getByText` 改为对话框内断言；拿锁后改，未动行为） |
| `packages/web-react/browser-tests/ui-preview/scenes-permission-card.tsx` | 预览台场景（新增 13 个） | **新增** |
| `packages/web-react/src/lib/chat/permissionPopupCoordinator.ts`、`permissionReconcile.ts` | 弹框单例协调器 / 对账 | **只读**，未改（任务书：改动需 `ask_decision`；本轮所有修复都在组件层完成，无需动协调器） |
| `packages/web-react/src/components/ui/Modal.tsx`、`Alert`、`Button` | 原语 | 只读 |

## 2. 方法与证据

- **代码走读**：`PermissionCard.tsx` 全文（卡头 / 待决摘要 / 内联动作 / 三种 modal / Host 的单例与 minimized 逻辑 / 过期 fail-safe），对照 `permissionPopupCoordinator.ts` 的 `shouldAutoOpenPermission / isPermissionUiDismissed / activeModalRequest` 语义核实多卡并发分支。
- **预览台**（d-28）：`scenes-permission-card.tsx` 直接给真实 `MessageList` 喂 reducer 已消化的 `ChatMessage[]`，走生产同款链路（时间线卡由 `MessageRenderer` 以 `renderMode="card"` 渲染，弹框由 `PermissionPromptHost` 托管；页面给同名 `#pending-approval-bar-slot` 让待答入口落到顶部）。13 场景 × desktop/mobile × light/dark：
  `pending-modal`（活提问自动弹普通审批框）/ `pending-dismissed`（关掉后：卡 + 待答入口）/ `approving`（批准中）/ `settled`（允许 / 拒绝 / 超时 / 断连 / 崩溃 / 本轮停止 / 问答已提交 / 跳过 / 计划已确认 / 已受理 共 10 张卡）/ `expired`（历史 TTL 孤儿 + 绝对到期）/ `expired-live`（活提问过期 fail-safe，本轮新增）/ `multi-pending-modal`（三卡并发只开一框）/ `multi-pending-cards`（三卡全关后）/ `ask-single` / `ask-multi`（三题：多选 / 单选 / 带预览）/ `exit-plan` / `input-loading`（题干截断）/ `urgent`（剩 90 秒）。
  before：`before\`（改代码前用旧组件出，12 场景 48 张，`failures: []`）；after：`after-2\`（终版代码，13 场景 52 张，`failures: []`、`retried: []`、`unmockedApi: []`）。用 Read 逐张看：`multi-pending-cards--mobile--{light,dark}`、`ask-multi--mobile--light`、`expired-live--mobile--light`、`approving--desktop--light`、`pending-dismissed--mobile--light`。
- **单测**：`PermissionCard.test.tsx` 新增 describe「未决态专审(PC-xx · t-875)」13 例；`MessageRenderer.test.tsx` 1 例按新契约改写。
- **真浏览器门**：`npm run test:browser`（权限卡属主流程阻断点，见 §5）。
- 弹框协调器有跨挂载的进程内记忆（已展示 / 已关掉），场景每次 `render()` 先 `resetPermissionAutoOpenMemory()` 并给活提问新 `requestId`，否则第二个视口 / 主题不再自动弹 —— 写场景时踩到，记在文件头注释里。

## 3. 问题清单

严重度按 PLAYBOOK §5：P1 阻断 / P2 明显缺陷或移动端不可用 / P3 打磨。

| 编号 | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| PC-01 | 卡头 `flex items-center` 一行四段 | 390px 下「退出计划模式」标题被压成竖排四字、工具片截成半个字、倒计时挤出 | 移动端未决卡不可读 | **P2** |
| PC-02 | 待决卡正文 | 待决 / 批准中 / 过期的卡只有标题与状态，看不到智能体要做什么（命令 / 文件 / 题干），必须打开审批框才知道；历史里的过期卡永远看不到 | 决策信息缺失，多卡并发时无法区分 | **P2** |
| PC-03 | 活提问过期 fail-safe | 本机时钟判过期后卡头写「已过期」，下面却挂着可点的「审批 / 拒绝」（时钟偏差 fail-safe），两句自相矛盾、无解释 | 用户不知道该不该点 | P3 |
| PC-04 | `PermissionPromptHost.minimized` | A 自动弹出后用户点了 B 卡的「审批」，A 的弹框被单例收掉但没记 dismissed；答完 B 后 A 已「展示过」不再自动弹，也没有待答入口 —— 只剩时间线里一张静默的卡，轮次一直卡着 | 主流程阻断（多卡并发） | **P2** |
| PC-05 | 卡头状态 `<span>` | 等待审批 → 正在提交 → 已允许 的状态切换对读屏静默 | a11y | P3 |
| PC-06 | 倒计时文案 | detached `ask_user` 24h 上界显示「约 1440 分钟内有效」 | 文案 | P3 |
| PC-07 | 临期倒计时 | 剩余 < 2 分钟只靠 `text-warning` 变色 | 色盲 / 暗色下不可辨 | P3 |
| PC-08 | 内联「拒绝」`variant="ghost"` | 不可撤销动作长得像一段灰字，与「审批」主按钮不成对 | 误触 / 可发现性 | P3 |
| PC-09 | ExitPlan 卡内计划预览 `max-h-28 overflow-hidden` | 一刀切断，看不出下面还有内容 | 视觉 | P3 |
| PC-10 | 待答入口条 | 多卡并发时只说「智能体在等你确认」，不知道不止一条 | 信息缺失 | P3 |
| PC-11 | 待答入口条 | 正文「智能体在等你确认 · 打开」与右侧按钮「打开」重复 | 文案 | P3 |
| PC-12 | AskUserQuestion 选项组 | 每个选项都是独立 Tab 停靠点，三题十二项要按十二次 Tab；`radiogroup` 无方向键、无 Home/End | 键盘 a11y（WAI-ARIA radio 模式缺失） | **P2** |
| PC-13 | AskUserQuestion 校验 | 未答就提交只给一圈红边 + 一行小字，不播报、不移焦点、长表单里看不见；作答后红边不消失 | 表单 a11y / 可恢复性 | **P2** |
| PC-14 | AskUserQuestion 多题 | 底部只写「共 N 题」，滚到中间不知道答到第几题 | 引导 | P3 |
| PC-15 | 「其他」输入框 | 回车不提交，要再去找底部按钮 | 键盘效率 | P3 |
| PC-16 | 批准中（`_controlPending`） | 按钮已收走，只剩「正在提交…」灰字 + 与等待态同一枚静止时钟，看不出还在动 | 反馈 | P3 |
| PC-17 | ExitPlanMode 卡头 | 标题「退出计划模式」+ 工具片「退出计划模式」连写两遍，窄屏还要为它折行 | 冗余 | P3 |

统计：17 条 = P2 5（PC-01 / 02 / 04 / 12 / 13）· P3 12。P1 0：待决 → 允许 / 拒绝 → 结清的主链路本身可用；未决态弹框的单例、dismissed 记忆、过期判据、只读 surface、题干截断取回都有既有用例锁定，走读未发现数据错误。

### 3.1 指挥官补发任务书的审计面 · 逐项结论

| 审计面 | 结论 | 证据 / 处置 |
|---|---|---|
| 允许 / 拒绝按钮可用态 | ✅ 待决且未提交时可用；`_controlPending`（批准中）、`readOnly`、已结清、题干截断中一律不渲染动作按钮，不是 disabled 灰按钮而是收走（避免「能看不能点」） | `PermissionCard.tsx` `canAnswer = !resolved && !pending && !readOnly && (!expired \|\| livePrompt) && !inputTruncated`；既有用例「只读 surface…」「题干截断…」+ PC-16 用例 |
| 「记住选择」 | 不适用 —— 组件、协调器、`inbound.permission_response` 协议均无「记住 / 总是允许」语义，前端不能凭空造 | `socket.ts respondPermission` payload 只有 `behavior / message / updatedInput` |
| 提交中 loading / disabled | ✅ 点「允许 / 拒绝」后 `respondPermission` **同步**置 `_controlPending = true`，卡头切「正在提交…」+ 旋转 loader（PC-16），按钮与弹框同帧收走；Master 回执 `applied` 后 `_resolved / _behavior` 落定 | `socket.ts:5954-5957`、`:5581-5586`；after 图 `approving--*` |
| 防重复点击 | ✅ 两层：UI 层按钮随 `_controlPending` 消失；socket 层 `controlId = stableControlId("permission", requestId:behavior)` 已在队列即 `return`，同一请求同一动作幂等 | `socket.ts:5941-5942` |
| 失败重试 | ✅ 由持久化控制队列兜底：控制项落 `_pendingControls`，断线 / 刷新后重放并恢复 `_controlPending`（卡仍显「正在提交…」），无需用户重点；缺的是「长时间无回执」的超时提示，属状态机范围，见 §6 遗留 | `socket.ts:3798-3803`（重放恢复）、`enqueueControl` 重试 |
| 卡片出现时焦点去向 | ✅ 活提问自动弹框：Radix `Modal` 打开即把焦点圈进对话框（首个可聚焦元素）；关掉后归位到打开它的「审批」按钮（用户手动打开时）；自动弹出无触发元素 → 落回 `body`，见 §6 遗留（需 shell 决定归位目标） | `ui/Modal.tsx` FocusScope；PC-04 用例断言弹框开合 |
| Tab 顺序 | ✅ 卡：审批 → 拒绝（同一行、DOM 顺序）；普通弹框：关闭 → 参数详情 `<details>` → 拒绝 → 允许；问答弹框：每题一个 Tab 停靠（roving，PC-12）→ 其他输入框（选中时）→ 暂不回答 → 提交 | PC-12 用例断言 `tabindex` 0/-1 分布 |
| Esc / Enter | ✅ Esc 关弹框 = 只关 UI（记 dismissed，出待答入口条，不批准不拒绝）；Enter 在按钮上按原生语义触发；「其他」输入框 Enter 直接提交（PC-15）；方向键 / Home / End 在选项组内移动（PC-12） | 既有用例「关闭只关 UI，不批准不拒绝，卡片可重开」「用户关掉问答后重挂不再自动弹，手动回答仍可用」+ PC-10/11、PC-12、PC-15 用例 |
| aria：role | ✅ 弹框 `role=dialog` + `aria-labelledby` 标题（「工具权限请求 / 用户问答 / 退出计划模式」）；选项组 `radiogroup` / `group` + `aria-label=题干`；选项 `role=radio/checkbox` + `aria-checked`；卡头状态 `<output>`（PC-05）；校验提示 `role=alert` + `aria-describedby`（PC-13） | PC-04 / 05 / 12 / 13 用例按 role 查询 |
| aria-live | ✅ 状态切换 polite（`<output>`）；校验错误 assertive（`role=alert`）；待答入口条是 `Alert tone=warning`（原语 `role=alert`，插入即播报「智能体在等你确认」） | 同上；`ui/Alert.tsx:76` |
| 按钮名称 | ✅ 「审批 / 回答 / 审阅计划」「拒绝」「允许」「继续规划 / 按此计划执行」「暂不回答，让它继续」「提交」「打开」；卸载 / 关闭走原语 `aria-label="关闭"`；「其他答案」输入框显式 `aria-label` | 用例均按 `getByRole("button", { name })` 查询 |
| 超时 | ✅ 卡头倒计时（PC-06 / 07）；到点：Host 以精确 deadline 定时器重算，卡退出 `pending` → 弹框卸载、入口条消失，卡显「已过期」；服务端 `permission_settled{timeout}` 到达后转「审批超时，已自动拒绝」。活提问误判过期的 fail-safe 补了说明（PC-03） | 既有「finite deadline countdown…」用例；`settled` 场景「超时」卡 |
| 撤回（`user_stop` / 断连 / 崩溃） | ✅ 结清原因逐条有中文：本轮已停止 / 连接断开 / 进程异常 / 请求已处理 / 已受理（尚未确认执行） | `settledReasonLabel`；`settled` 场景 10 张卡 |
| 会话切换 | ✅ Host 的弹框 `key=${sessionId}:${requestId}`，切会话即卸载并 `yieldActiveModal`，另一会话的待决卡按自己的 dismissed / displayed 记忆决定是否弹 | 既有用例「PermissionPromptHost … sessionId」（`PermissionCard.test.tsx:850` 附近） |
| 多卡同时未决互不干扰 | ✅ 单例弹框：同一时刻只开一个；关掉 A 自动补 B；A 被 B 顶掉后不再静默（PC-04）；入口条标出总数（PC-10）；三卡各自的倒计时 / 摘要独立 | PC-04 / PC-10 用例；`multi-pending-*` 场景 |
| 移动端 | ✅ 三种弹框 `mobile="sheet"` 贴底；选项 / 按钮 ≥ 44px；卡头 390px 可换行（PC-01）；命令摘要 `break-all` 不横滚 | `*--mobile--*` 24 张 |
| 深浅色 | ✅ 全部走 token（`text-warning / text-accent / bg-surface` 等），暗色下临期 / 拒绝 / 渐隐层均成立 | `*--dark.png` 26 张，Read 核对 `multi-pending-cards--mobile--dark` |

## 4. 修复记录（A→B 合一，逐条）

全部在组件层，未改 `permissionPopupCoordinator.ts` / `permissionReconcile.ts` / socket 状态机 / ui 原语 / App 壳层。

| 编号 | 改动（`PermissionCard.tsx`） | 用例（`PermissionCard.test.tsx` 除注明外） | 证据 |
|---|---|---|---|
| PC-01 | 卡头容器 `flex-wrap gap-y-1`；标题与状态 `whitespace-nowrap`，工具片 `min-w-0 max-w-full` 内部截断；**状态 + 倒计时包成一组 `ml-auto flex-wrap justify-end`**，挤不下时整组换行仍右对齐（接手时发现倒计时单独掉到左下角，已修正） | 视觉项，由 after 图证明 | `after-2\permission-card-multi-pending-cards--mobile--light.png`：「退出计划模式」横排、工具片完整；before 同名图竖排 |
| PC-02 | 新增 `compactRequestSummary()`（命令 > 文件 > 地址 > 内容 > meta 摘要，与 `PermissionInputSummary` 同一优先级）；待决普通卡露出一行 `$ 命令`（`line-clamp-2`）/「文件 / 地址 / 内容 / 操作」行；问答卡露出第一题题干 + 「共 N 题」；已结清、ExitPlan、题干截断中不显示 | 「PC-02 待决权限卡露出命令摘要…」；既有「题干截断取回」用例改为 `getAllByText(...).length > 0`；`MessageRenderer.test.tsx`「AskUserQuestion → 答题框」改为 `within(dialog)` 断言 | 同上图三张卡各带摘要 |
| PC-03 | `expired && livePrompt && canAnswer` 时补一行说明「按本机时间已超过等待时限；若智能体仍在等待（时钟可能有偏差），仍可作答。」（`data-testid="permission-expired-failsafe"`）；历史过期卡（`!livePrompt`）仍是「提问已过期，无法再作答」 | 「PC-03 活提问过期 fail-safe…」 | `after-2\permission-card-expired-live--mobile--light.png`（新增场景） |
| PC-04 | `PermissionPromptHost` 的 `minimized` 兜底从「仅 dismissed」扩为「dismissed **或** 活提问（`sending` / recovery turn）」：被顶掉的活提问在没有弹框在开时一定有待答入口条 | 「PC-04 被顶掉的活提问在另一条答完后仍有待答入口，不会静默」（A 自动弹 → `reopenPermissionUi(B)` → B 结清 → bar 指向 A → 点「打开」弹回 A，`onRespond` 未被误调） | — |
| PC-05 | 卡头状态 `<span>` → `<output>`（隐含 `role=status`，polite 播报） | 「PC-05 卡头状态是 status 区域…」 | — |
| PC-06 | 新增导出 `formatPermissionRemaining()`：≥ 90 分钟按「约 N 小时内有效」 | 「PC-06 剩余时长 ≥ 90 分钟按小时说…」×5 断言 | after 图 ExitPlan 卡「约 24 小时内有效」 |
| PC-07 | 临期加 `AlertTriangle` 图标 + `font-medium` + `title="即将过期，请尽快处理"` | 既有「finite deadline countdown」用例仍断言 `text-warning` | `after-2\permission-card-urgent--*` |
| PC-08 | 内联「拒绝」`ghost` → `secondary`（描边按钮，触屏 44px 由 Button 原语兜底） | 视觉项 | after 图「审批 / 拒绝」成对 |
| PC-09 | 计划预览容器 `relative` + 底部 `h-10 bg-gradient-to-t from-surface` 渐隐层（`aria-hidden`） | 视觉项 | after 图 ExitPlan 卡底部渐隐 |
| PC-10 | `PendingApprovalBar` 加 `count`，Host 传 `pending.length`：> 1 时「智能体在等你确认 · 共 N 项待处理」 | 「PC-10/11 待答入口…」 | after 图顶部条「共 3 项待处理」 |
| PC-11 | 正文去掉「· 打开」 | 同上 | 同上 |
| PC-12 | 选项组 `onKeyDown`：↑↓←→ 在选项间移动焦点，单选题移动即选中，Home / End 到首末；单选题 roving tabindex（已选项 / 无选择时首项 `tabIndex=0`，其余 `-1`），多选题按 checkbox 惯例各自可 Tab | 「PC-12 单选题方向键…」「PC-12 多选题方向键只移焦点不改勾选…」 | — |
| PC-13 | 出错题 `role="alert"` 提示 + `aria-describedby` 挂到选项组；`useEffect` 把焦点送到该题第一个选项并 `scrollIntoView`；用户一动作即清除错误 | 「PC-13 未答就提交…」 | — |
| PC-14 | 多题时每题右上角「i / N」（与 header 同一行） | PC-13 用例末尾断言「1 / 2」「2 / 2」 | `after-2\permission-card-ask-multi--mobile--light.png` |
| PC-15 | 「其他」输入框 Enter → `submit()` | 「PC-15 「其他」输入框回车即提交」 | — |
| PC-16 | `_controlPending` 时状态图标换 `LoaderCircle animate-spin text-accent`（与 HUD 同款），等待态仍是静止时钟 | 「PC-16 批准中：状态图标换成旋转 loader…」 | `after-2\permission-card-approving--*` |
| PC-17 | `isExitPlan` 时不渲染工具片（标题已是同一句） | 「PC-17 ExitPlanMode 卡头不再连写两遍…」 | `after-2\permission-card-multi-pending-cards--mobile--dark.png` |

提交（本分支，subject 无 `fix(v5)`）：`3f2c40ad9` test(v5) 截图台外链 bundle（前任带入，与 messages 分支同一修正）· `292ed1bad` test(v5) 预览台 13 场景 · `2ceeff88f` feat(v5) 组件 + 用例 · 文档见本次 docs 提交。接手说明：PC-01 / 02 / 04–15 的代码与用例为 fable-5-1-56 在工作树里完成但未提交的改动，本人逐行走读核对后原样保留（仅 PC-01 补了分组右对齐），并补 PC-03 / 16 / 17、`expired-live` 场景与 `MessageRenderer.test` 同步；fable-5-1-52 的导出记录里无本活改动。

## 5. 验证

均在 `wt\permission-card`（`npm ci` 已装，`node_modules\@openclaude\protocol` 指向本工作树 `packages\protocol`）。

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0（`typecheck.log`） |
| 组件单测 | `npx vitest run src/components/chat/PermissionCard.test.tsx --maxWorkers=1` | ✅ **70 例全绿**（基线 57 → +13；`vitest-4-pc.log`） |
| 时间线层单测 | `npx vitest run src/components/MessageRenderer.test.tsx --maxWorkers=1 --hookTimeout=60000` | ✅ **147 例全绿**（接手时 1 例因 PC-02 题干双份而红，改为对话框内断言后过；`--hookTimeout` 只为绕开该文件 `beforeAll` 冷启抖动 —— 集成①记录里的已知基线现象；`vitest-5-mr.log`） |
| chat 目录单测 | `npx vitest run src/components/chat src/lib/chat --maxWorkers=1` | ✅ **60 文件 / 1274 例全绿**（`vitest-6-chat.log`） |
| 代码风格 | `npx biome lint` 三个改动文件 + HEAD 版本对照 | ✅ `PermissionCard.tsx` 11 条诊断与 HEAD 版本逐条相同（`useExhaustiveDependencies` ×5、`noArrayIndexKey` ×2、`useSemanticElements` / `noAutofocus` / `useNumberNamespace` / `suppressions/unused` 各 1，行号后移、代码未触碰）；`PermissionCard.test.tsx`、`scenes-permission-card.tsx` 0 条 → **新增 0** |
| 预览台场景类型检查 | 基线无 `typecheck:preview` 脚本；借 integration `c034f05d7` 的 `tsconfig.browser-tests.json` 临时放进包目录跑 `npx tsc -p tsconfig.browser-tests.json`（跑完即删，未提交） | ◐ `browser-tests/ui-preview/**` **0 错误**（含新场景）；20 条错误全部落在 `../protocol/src/*`（BigInt 字面量 / Set 迭代需 ES2020）与 `@types/request`，是基线分支 `tsconfig.json` 缺 integration 后续 target / 引用调整所致，与场景无关；合入后由集成④ 的 `npm run typecheck:preview` 全量门覆盖（`typecheck-preview.log`） |
| 真浏览器门 | `$env:OC_E2E_BROWSER=<Chrome>; npm run test:browser` | ✅ `run.mjs` **T1–T67 全部 ok、0 not ok**（含 T13 工具卡触控 / 键盘、T15 活动 turn 中 Ask UI 移动端点选提交、T57 permission live-units、T25 390×844 整页）；`node --test` 73 条 **70 pass / 3 fail**，3 条与基线 `210b9967` 记录逐条相同（`cc-switch-ascii-name` ×2：等待超时 + 期望 `gemini-3.8-flash` 实得 `sonnet-5`，settings 归属；`OCV5-185` Windows 未开发者模式 `symlink EPERM`），非本轮引入（`test-browser.log`） |
| 视觉 before / after | `OC_UI_SCENES=permission-card OC_UI_SHOT_DELAY=900 node browser-tests/ui-preview/shoot.mjs` | ✅ before 12 场景 48 张 / after-2 13 场景 52 张，两轮 `failures: []`、`retried: []`、`unmockedApi: []`（`before-shoot.log`、`after-2-shoot.log`） |

after 对照要点（同名 PNG，`before\` ↔ `after-2\`）：
- `multi-pending-cards--mobile--*`：顶部条「智能体在等你确认 · 打开」→「… · 共 3 项待处理」；三张卡各露出 `$ sed -i …` / 第一题题干 / 计划预览渐隐；「退出计划模式」从竖排四字变一行且无重复工具片；「约 1440 分钟内有效」→「约 24 小时内有效」；「拒绝」从灰字变描边按钮。
- `ask-multi--mobile--*`：每题右上角 1 / 3、2 / 3、3 / 3；选项行高 ≥ 44px 不变；底部「提交」「暂不回答，让它继续」不变。
- `expired-live--mobile--light`（新增）：卡头「已过期」、正文命令摘要、审批 / 拒绝按钮、说明行四段齐全，不自动弹框、无待答入口条（服务端判定已不在等）。
- `approving--*`：状态行「正在提交…」前为旋转 loader（截图为静帧），无按钮、无弹框。
- `pending-modal--mobile--*` / `ask-single--mobile--*` / `exit-plan--mobile--*`：三种弹框均为贴底 sheet，按钮触控高度足；桌面居中，与 before 一致（未改弹框布局）。

**NOT RUN**：`npm test` 全量（改动限于 `PermissionCard.tsx` + 两份用例 + 场景；chat 目录与时间线层单测已单跑，全量门交集成④）；真机 iOS Safari；读屏实机（`<output>` / `role=alert` / roving tabindex 按 WAI-ARIA 模式实现，jsdom 断言了角色与 tabindex 契约）。

## 6. 不修 / 遗留 / 观察

| 项 | 处置 | 理由 / 归属 |
|---|---|---|
| 内联「拒绝」无二次确认 | 不修（既有交互约定） | 拒绝只是让智能体换路，不是删数据；审批框里的「拒绝」同语义也无确认；最常见的「不是这个」多一次确认反而拖慢主流程。PC-08 已把它从灰字改成成对的描边按钮，降低误触 |
| 自动弹出的弹框关闭后焦点落回 `document.body` | ⏸ 遗留（需 shell） | 自动弹出的弹框没有触发元素，Radix 关闭时无处归位；合理落点是 Composer 输入框或对应时间线卡，两者都在 `App` / `MessageList` 层，`PermissionCard` 触不到且时间线卡可能已被虚拟化卸载。`Modal` 已暴露 `onCloseAutoFocus`，接线一行即可 |
| 「正在提交…」无超时 / 重试 | ⏸ 遗留（协调器 / socket 状态机） | Master 不回执时卡会一直停在批准中；重试或超时回滚属 `lib/chat` 状态机，任务书边界外，未开卡 |
| 「已跳过」的问答卡不再展示题目 | 不修 | 结清后正文只对「已提交」展示问答对；跳过时保留题目意义不大，且与 before 一致 |
| 待答入口条整条 `onClick` 但不可键盘聚焦 | 不修 | 内置「打开」按钮是键盘入口；整条可点只是触屏加大命中面 |

## 7. 跨模块发现

- `MessageRenderer.test.tsx`（messages 归属）1 处断言随 PC-02 契约改写（`within(dialog)`），未改行为；改前拿到写锁（原持有人 t-895 到期释放后）。
- 预览台 `#pending-approval-bar-slot` 由 App 顶栏提供，场景里自备同名插槽；无需 App 改动。
