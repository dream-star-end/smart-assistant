# 审计 · sidebar（侧栏 / 会话管理 / 项目 / 站内信 / GitHub 绑定）

- 任务：t-36「A·sidebar 侧栏/会话/项目/站内信/GitHub 审计」（阶段 A，未改业务代码）；t-37「B·sidebar 修复」（阶段 B，见 §6 / §7）
- 分支：`feat/v5-selfhost-audit-sidebar`（基线 `210b9967`）
- 审计人：fable-5-1-19 · 2026-09-15；阶段 B 接手收尾：fable-5-1-25 · 2026-09-16
- 口径：`TEAM_PLAYBOOK.md` §5 七项清单 + 严重度 P1/P2/P3

## 1. 范围与文件清单

全部位于 `packages/web-react/src/`：

| 分类 | 文件 | 审计重点 |
|---|---|---|
| 侧栏主体 | `components/Sidebar.tsx` | 头部 / 新建 split / 搜索 / 多选 / 分组拍平 / 拖拽 / 账号菜单 / 底栏 |
| 侧栏子件 | `components/sidebar/{SessionRow,ProjectRow,BatchBar,VirtualList,highlight}.tsx`、`components/sidebar/{flattenItems,runningOrder,compactDuration,constants}.ts` | 行布局与触控尺寸、菜单、批量条、虚拟列表、拍平规则 |
| 状态点 | `components/SessionStatusDot.tsx`、`lib/sessionStatus.ts` | 运行 / 未读 / 出错 / 服务重启 四态 |
| 项目 | `components/ProjectSettingsDialog.tsx`、`components/ProjectAssetsPanel.tsx`、`hooks/{useChatProjects,useProjectAssets,useProjectScope}.ts(x)`、`lib/projectScope.ts` | 项目设置表单、看板绑定、资产上传 / 注入、项目范围 |
| 站内信 | `components/InboxDialog.tsx`、`hooks/useInbox.ts`、`lib/inboxLevels.ts` | 右侧抽屉、Tab、手风琴、分页、已读 |
| GitHub | `components/github/{GithubRepoModal,RepoPill,RepoStatusBanner}.tsx`、`hooks/useRepoBinding.ts`、`lib/github.ts` | 账号关联、选仓选分支、克隆状态横幅、pill |
| 会话数据层 | `hooks/{useSessionList,useUnreadSessions}.ts` | 列表合并 / 重命名 / 删除 / 归档 / 批量 / 分页 / 搜索 / 未读 |
| 布局与持久化 | `hooks/{useSidebarWidth,useDelayedConnBanner}.ts`、`lib/{sidebarCollapsed,sessionTitle}.ts` | 拖拽宽度、折叠态、连接横幅延迟、标题回退 |

只读参照（归属 shell，不改）：`App.tsx` L3241-3311（`sidebarProps`）、L3336-3427（桌面内联侧栏 + 移动端 `Sheet` 抽屉）、L3920-3978（三个对话框接线）。

## 2. 方法与证据

### 2.1 代码走读
逐文件通读上表全部源码；对照 `Sidebar.test.tsx` / `flattenItems.test.ts` / `useSessionList.test.tsx` 确认哪些行为是有意为之（例如「会话行恒单行、不显示 `lastMessagePreview`」有单测锁定，不列为问题）。

### 2.2 视觉预览台（主要证据）
新增场景文件 `packages/web-react/browser-tests/ui-preview/scenes-sidebar.tsx`（12 个场景，随本分支提交；`api-stub.ts` 未改动，假数据全部走场景表 `api`）：

| 场景 id | 内容 | 视口 |
|---|---|---|
| `sidebar-overview` | 置顶 / 3 个项目（含空项目、折叠且有运行中）/ 未分类 / 四种状态点 / 已归档展开 | desktop |
| `sidebar-mobile-drawer` | `Sheet` 内联侧栏（对齐 App 移动端抽屉） | mobile |
| `sidebar-empty` | 新用户空态 | desktop |
| `sidebar-search` | 输入「部署」：标题命中 + 消息内容匹配（AutoDrive 驱动真实 input 事件） | desktop |
| `sidebar-multiselect` | 点「多选」并勾选 2 条 → BatchBar | desktop |
| `sidebar-narrow-min` | 宽度 220px（`SIDEBAR_WIDTH_MIN`）+ 多选条 | desktop |
| `sidebar-project-settings` | 项目设置 · 设置 Tab | desktop + mobile |
| `sidebar-project-assets` | 未分组资产面板（4 条资产：已注入 PDF / 会话产出图 / 无大小 md / zip） | desktop + mobile |
| `sidebar-inbox` | 站内信 5 条（四个级别 + 图片 + 图表标记），自动展开第 1 条 | desktop + mobile |
| `sidebar-github-linked` | 已关联账号 + 5 个仓库（含超长名）+ 自动选中首仓 → 分支列 | desktop + mobile |
| `sidebar-github-unlinked` | 未关联账号 | desktop |
| `sidebar-repo-banner` | `RepoStatusBanner` 4 态 + `RepoPill` 4 态 | desktop + mobile |

跑法与结果：

```powershell
cd packages\web-react
$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:OC_UI_SHOTS='D:\code\test_project\test123\.audit-tmp\sidebar\before'
$env:OC_UI_SCENES='sidebar-'; $env:OC_UI_SHOT_DELAY='900'
node browser-tests\ui-preview\shoot.mjs
# → 34 张 / 12 场景 × 2 主题，全部成功；failures=[] retried=[] unmockedApi=[]
```

- **before 截图目录**：`D:\code\test_project\test123\.audit-tmp\sidebar\before\`（34 张 PNG + `manifest.json` + `shoot-before.log`，仓库外，不入库）
- 每张 PNG 均用 Read 工具逐张看过；下文问题表「证据」列引用文件名。

### 2.3 静态检查
- `npx tsc --noEmit --strict … browser-tests/ui-preview/scenes-sidebar.tsx` → 0 错误（`tsconfig` 只 include `src`，故对场景文件单独跑）
- `npx biome check --write` 场景文件 → 通过
- `npm run typecheck --workspace packages/web-react` → 见 §2.4

### 2.4 本轮未跑 / 限制
- 未跑 vitest / `test:browser`：阶段 A 无业务代码改动，基线单测由阶段 B 交付前跑。
- `ProjectSettingsDialog`「绑定任务面板项目」下拉的**有数据态**未截到：`taskboardApi`（`lib/taskboard.ts`）直接 `fetch`，不经 `lib/api`，预览台的 api-stub 打不到桩（harness 把裸 fetch 兜成 204 → 会显示「看板列表加载失败」）。场景改为不传 `authSession` 以取干净表单；错误态本身由 §3 PS-01 覆盖。
- 拖拽（会话拖入项目、项目拖排序）与 pointer 拖宽是运行时交互，仅代码走读，未做真浏览器交互验证。

## 3. 问题清单

严重度：**P1** 功能不可用 / 数据错误 / 阻断主流程；**P2** 明显体验缺陷 / 一致性破坏 / 移动端不可用；**P3** 打磨项。
统计：**P1 × 0 · P2 × 12 · P3 × 26**（共 38 条）。

### 3.1 侧栏主体与会话行

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| S-01 | `Sidebar.tsx:76`、`:426-434`、`:522-554`；`sidebar/flattenItems.ts:126-136` | 所有文案为「暂无会话」的 hint 行都被抬高到 108px 并叠一个「新建会话」按钮——包括**每一个展开的空项目**。 | 有 2~3 个空项目时侧栏被大块 CTA 占满，真正的会话被推出视口；空项目的 CTA 与顶部「新建会话」/项目行「+」三重冗余。 | P2 | `sidebar-overview--desktop--light.png`（数据分析组），`sidebar-mobile-drawer--mobile--light.png` |
| S-02 | `Sidebar.tsx:248-258` | 「已归档」展开态按 `user.id` 从 localStorage 恢复，但拉取归档列表的 effect 是 mount-only（`[]`）。`user` 晚于侧栏挂载到位（刷新页面等 `/api/me`）时，展开态恢复为 true 却不触发 `onLoadArchived`。 | 「已归档」显示展开 + 计数 0 + 「没有已归档的会话」假空态，需手动折叠再展开。 | P3 | 代码走读 |
| S-03 | `Sidebar.tsx:436-439`、`:610-611`、`:623-634`；`hooks/useChatProjects.ts:228-262` | `emitReorder` 先写本地 `orderOverride` 再调 `onReorderProjects`，**丢弃返回的 Promise**。`reorderProjects` 失败时会回滚 hook 内 `projects` 并 `throw`，但 Sidebar 的 `orderOverride` 不回滚且 rejection 未捕获。 | 服务端失败后侧栏仍显示失败后的顺序（与数据层不一致，直到刷新）；控制台 Unhandled promise rejection。 | P2 | 代码走读 |
| S-04 | `Sidebar.tsx:503-519`；`ui/IconButton.tsx:28`（xs 触控态 `size-11`） | 「项目」分组标题行高固定 32px（`GROUP_HEADER_HEIGHT`）、`h2` 为 `h-full items-end`，但「新建项目」IconButton 在 `(hover:none)` 下变成 44px，溢出标题行、盖到上一行。 | 移动端「+」错位悬在「置顶」最后一条与「项目」标题之间，误触上一条会话。 | P2 | `sidebar-mobile-drawer--mobile--light.png`（y≈355 处「+」） |
| S-05 | `Sidebar.tsx:704-715`；`hooks/useSidebarWidth.ts:124-133` | 拖宽把手 `role="separator"` 无 `tabIndex`、无 `aria-valuenow/min/max`、无键盘处理；双击复位默认宽度无任何提示（无 `title`）。 | 键盘用户无法调宽；双击复位不可发现。WAI-ARIA separator 模式不完整。 | P3 | 代码走读 |
| S-06 | `Sidebar.tsx:727-738`；`App.tsx:3404`（只读） | 同一个按钮在桌面是「折叠侧栏」，在移动端抽屉里被 App 接成「关闭抽屉」，但 `aria-label` / 图标不变。 | 读屏用户在抽屉里听到「折叠侧栏」；视觉上 PanelLeftClose 语义也不对。 | P3 | `sidebar-mobile-drawer--mobile--light.png` 右上角 |
| S-07 | `Sidebar.tsx:801-824`；`sidebar/flattenItems.ts:75-100` | 搜索框无清除（×）按钮、非 `type="search"`、Escape 不清空；结果区无 `aria-live`。 | 搜索后要手动全选删除才能回到列表；读屏听不到「没有匹配的会话 / 正在搜索消息…」。 | P3 | `sidebar-search--desktop--light.png` |
| S-08 | `Sidebar.tsx:850`；`hooks/useSessionList.ts:766-799`（`:792-794`） | 滚到底加载更多失败时只 `console.warn` 并把 `hasMore` 置 false，UI 无任何提示。 | 用户以为「就这么多会话」，更早的会话永远拉不到，只能刷新。 | P2 | 代码走读 |
| S-09 | `Sidebar.tsx:480-499`、`:978-998`（`:993` 的 `width < 220` 恒为 false，`SIDEBAR_WIDTH_MIN`=220） | 底栏「余额 1,234,567 积分」在默认 268px 已截断为「余额 1,234,56…」；220px 时昵称只剩 1 个字、「案例」文字按钮却仍占位。 | 最窄宽度（设计允许的合法宽度）下账号区不可读；余额数字被截断有误读风险。 | P2 | `sidebar-overview--desktop--light.png` 底栏，`sidebar-narrow-min--desktop--light.png` |
| S-10 | `Sidebar.tsx:299-306`；`hooks/useSessionList.ts:834-840` | 标题本地搜索在「已归档」展开时包含归档会话，消息全文搜索硬编码 `includeArchived: false`。 | 同一搜索词，归档会话能按标题命中却永远搜不到其消息，规则不一致。 | P3 | 代码走读 |
| S-11 | `Sidebar.tsx:556-584`（搜索态复用 `SessionRow`）；`sidebar/highlight.tsx` | 消息命中的摘要有 `<mark>` 高亮，标题命中行不高亮命中词。 | 搜索结果两段视觉规则不一致，标题长时看不出为何命中。 | P3 | `sidebar-search--desktop--light.png` |
| S-12 | `Sidebar.tsx:263`、`:334-347`；`sidebar/flattenItems.ts:111-142`；`hooks/useChatProjects.ts:90-111` | 拍平只渲染 `projects` 列表里存在的项目；`projectId` 指向不在列表中的项目（`listChatProjects` 失败仅 `console.warn` 且**不重试**、或项目在他端被删）的会话既不在项目下也不进「未分类」。 | 项目列表请求一次失败 → 所有分组会话在整个会话期内**不可见**，无提示、无重试；已置顶的仍可见更显得随机。接近 P1，因需请求失败才触发定为 P2。 | P2 | 代码走读 |
| S-13 | `Sidebar.tsx:263`、`sidebar/flattenItems.ts:144-175` | 新用户零会话零项目时仍渲染「项目 +」「未分类 0」「已归档 0」骨架。 | 首屏空态像损坏的列表而不是引导；三处 0 计数无信息量。 | P3 | `sidebar-empty--desktop--light.png` |
| S-14 | `Sidebar.tsx:496`、`:875` | 无余额时账号区副标题写死「多模型 · 计量计费」。 | 个人版 / 自托管未接计费时出现商业化营销文案（需 product owner 确认，见 §5）。 | P3 | `sidebar-empty--desktop--light.png` 底栏 |
| SR-01 | `sidebar/SessionRow.tsx:69-72`、`:123-131`；`sidebar/compactDuration.ts:6-11` | 会话用时用 `25m / 3h / 2d` 英文缩写；完整起止时间只在 `title` 悬浮里。 | 中文界面混入英文单位；触屏无法看到起止时间。 | P3 | `sidebar-overview--desktop--light.png` |
| SR-02 | `sidebar/SessionRow.tsx:144` | 「更多」菜单 `onCloseAutoFocus` 一律 `preventDefault`。 | 键盘操作菜单后焦点掉到 body，Tab 序列从头开始。 | P3 | 代码走读 |
| SR-03 | `sidebar/SessionRow.tsx:145-187` | 同一菜单里「置顶 / 归档」带图标，「重命名 / 移动到项目 / 多选 / 删除」不带。 | 图标一致性破坏（§5-1）。 | P3 | 代码走读 |
| SR-04 | `sidebar/SessionRow.tsx:91-110`、`:84` | 多选态用复选框**替换**状态点，运行中 / 出错信息消失；项目内会话缩进只有 `pl-1`（4px），会话文字反而比项目名更靠左。 | 多选时无法据状态挑选（例如只归档已完成的）；层级视觉扁平。 | P3 | `sidebar-multiselect--desktop--light.png`、`sidebar-overview--desktop--light.png` |
| PR-01 | `sidebar/ProjectRow.tsx:129-140` | 折叠项目行的「运行中数」与「总数」相邻渲染，视觉上是「● 1 2」。 | 读成「12」；两个数含义靠 `title` 才能分辨。 | P3 | `sidebar-overview--desktop--light.png`（文档与部署） |
| PR-02 | `sidebar/ProjectRow.tsx:142-167` | 触控设备上「+」「…」两个按钮恒显且各占 44px，加上计数与运行徽标。 | 268px 抽屉里项目名只剩约 4 个汉字（「文档与…」）。 | P3 | `sidebar-mobile-drawer--mobile--light.png` |
| BB-01 | `sidebar/BatchBar.tsx:22-52` | 批量条 5 个元素 `flex-wrap`：268px 折成 2 行、220px 折成 3 行，且「取消」被挤到单独一行。 | 最窄宽度下批量条占 ~80px、操作次序混乱。 | P2 | `sidebar-multiselect--desktop--light.png`、`sidebar-narrow-min--desktop--light.png` |
| BB-02 | `sidebar/BatchBar.tsx:46-48` | 批量「删除」与「归档」同为 ghost 样式，无 destructive 语义。 | 危险操作与普通操作视觉等权（确认框在 hook 层有，但入口无警示）。 | P3 | 同上 |
| BB-03 | `sidebar/BatchBar.tsx:27-29`；`lib/types.ts:194` | `SessionBatchAction` 含 `unarchive`，且已归档会话可被多选，但批量条没有「取消归档」。 | 只能逐条取消归档；批量归档不可批量撤销。 | P3 | 代码走读 |
| SD-01 | `components/SessionStatusDot.tsx:26-33` | 状态点 6px（`size-1.5`），四态全靠颜色区分，文字仅 `title`/`aria-label`。 | 色弱用户与小屏难以分辨运行 / 未读 / 出错；6px 点在深色下对比不足。 | P3 | `sidebar-overview--desktop--dark.png` |

### 3.2 会话数据层

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| USL-01 | `hooks/useSessionList.ts:617-627` | 重命名：本地立刻改名，服务端 `patchSessionTitle` 失败被静默吞掉。 | 60s 轮询 server-wins 后标题「自己变回去」，用户无从知晓失败。 | P2 | 代码走读 |
| USL-02 | `hooks/useSessionList.ts:649-652` | 删除：`deleteSession` 失败静默（注释自认「reload 后会从 listSessions 复活」）。 | 删除后刷新会话复活，且本地 IndexedDB 副本已清，历史需重拉。 | P2 | 代码走读 |
| UCP-01 | `hooks/useChatProjects.ts:245-249`、`:251-256` | 项目排序对 N 个项目并发 N 个 PATCH，任一失败再并发 N 个回滚 PATCH。 | 中途部分成功时服务端顺序处于中间态；请求风暴。 | P3 | 代码走读 |
| UUS-01 | `hooks/useUnreadSessions.ts:110-121` | 系统通知 `onclick` 只 `close()`。 | 点通知不聚焦窗口、不打开对应会话，通知没有落点。 | P3 | 代码走读 |

### 3.3 项目设置与资产

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| PS-01 | `ProjectSettingsDialog.tsx:126-143` | 选择「绑定任务面板项目」后 effect 拉看板 context 并 **直接 `setInstructions` 覆盖**当前文本域。 | 用户已输入的自定义指令被无提示清掉 / 替换（数据丢失）。 | P2 | 代码走读 |
| PS-02 | `ProjectSettingsDialog.tsx:306-320` | 看板绑定用裸 `<select>` + 手写类名，仓内已有 `ui/Select.tsx`。 | 与设计系统其它下拉不一致；深色下依赖系统原生弹层样式。 | P3 | `sidebar-project-settings--desktop--dark.png` |
| PS-03 | `ProjectSettingsDialog.tsx:154-156` | 关闭（Esc / 遮罩 / 取消）无脏检查。 | 编辑中的名称 / 指令误触即丢。 | P3 | 代码走读 |
| PS-04 | `ProjectSettingsDialog.tsx:254-286` | 色板按钮 `size-8`（32px）无触控加大；390px 下 9 个色块换行后孤零零 1 个。 | 移动端触控目标 <44px；视觉断行。 | P3 | `sidebar-project-settings--mobile--light.png` |
| PS-05 | `ProjectSettingsDialog.tsx:20-29`、`:255-268` | 「墨」= `bg-primary` 在深色主题是白色、「灰」变浅灰；「无颜色」虚线圆在深色下几乎不可见。 | 颜色名称与所见相反；无颜色项对比度不足。 | P3 | `sidebar-project-settings--desktop--dark.png` |
| PS-06 | `ProjectSettingsDialog.tsx:323-341` | 指令 hint 与 `N / 4000` 计数落在文本域**下方**，默认高度下被 footer 遮住需滚动才见。 | 字数上限提示不可见；超限时只有保存按钮变灰无解释。 | P3 | `sidebar-project-settings--desktop--light.png`（底部被裁的一行灰字） |
| PS-07 | `ProjectSettingsDialog.tsx:160-186` | 绑定看板时先 `putProjectContext(expectedVersion)` 再 `onSave`，版本冲突与普通失败同报「保存项目设置失败」。 | 两端同时编辑时用户不知道是冲突还是网络问题，也没有「重新加载后再保存」的出口。 | P3 | 代码走读 |
| PA-01 | `ProjectAssetsPanel.tsx:78-90`；`AssetRow` `:244-248` | 文案「已注入 1/20」「已注入」徽标，描述「其索引会注入该项目下所有会话」。 | 「注入」是实现术语，用户语境应是「作为项目知识 / 已启用」。 | P3 | `sidebar-project-assets--desktop--light.png` |
| PA-02 | `ProjectAssetsPanel.tsx:339-345` | 下载中状态用文字「…」代替图标。 | 无进度也无 Spinner，看起来像卡住。 | P3 | 代码走读 |
| PA-03 | `ProjectAssetsPanel.tsx:157-201`；`hooks/useProjectAssets.ts:101-149` | 上传期间整块拖放区 `pointer-events-none`，多文件顺序上传无逐文件进度 / 计数。 | 批量上传大文件时只有「正在上传…」一行字，无法判断进度。 | P3 | 代码走读 |

### 3.4 站内信

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| IB-01 | `InboxDialog.tsx:494-499`（对照 `:60-90` `stripMarkdownSummary` 已剥注释） | 展开正文把 `body_md` 原样交给 `<Markdown>`，HTML 注释 `<!-- ob:xxx -->`（系统防重发 marker）被当文本渲染，`-->` 还被排成箭头「→」。 | 系统消息底部出现 `<!-- ob:release-2026-09 →` 一行开发者标记；摘要态剥了、展开态没剥，两态不一致。 | P2 | `sidebar-inbox--desktop--light.png`、`sidebar-inbox--mobile--light.png` |
| IB-02 | `InboxDialog.tsx:311-314`、`:505-525` | 列表区加载 / 错误 / 空态切换无 `aria-busy` / `aria-live`；骨架 `aria-hidden`。 | 读屏用户不知道在加载或已失败。 | P3 | 代码走读 |
| IB-03 | `InboxDialog.tsx:39-42`、`:301-308` | 「未读」Tab 不带数量。 | 未读数只在标题徽标里，切 Tab 前不知道有多少条。 | P3 | `sidebar-inbox--desktop--light.png` |

### 3.5 GitHub 仓库绑定

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| GH-01 | `github/GithubRepoModal.tsx:365`、`:367`、`:400-409`、`:437` | 两列 grid 与列容器缺 `min-w-0`；仓库名 `truncate` 挂在 span 上但父级可被内容撑开。仓库名超长时第一列按内容展开，第二列（分支）被 `overflow-hidden` **裁掉右侧**。 | 桌面端分支名被截、`default` 徽标与选中 ✓ 完全不可见；只要账号下有一个长仓库名就触发。 | P2 | `sidebar-github-linked--desktop--light.png`（右列被裁） |
| GH-02 | `github/GithubRepoModal.tsx:272-281` | 「确认绑定」在 `!sessionId`（草稿态，尚未发送首条消息）时禁用，但无任何提示。 | 用户从输入区 pill 打开、选好仓库分支却点不动，不知道要先发一条消息。 | P2 | 代码走读；`App.tsx:3971 sessionId={activeId}` |
| GH-03 | `github/GithubRepoModal.tsx:328-330` | 账号栏副标题直接输出 `link.scopes`（如 `repo,read:user`）。 | OAuth scope 原文泄漏给用户，无可读语义。 | P3 | `sidebar-github-linked--desktop--light.png` |
| GH-04 | `github/GithubRepoModal.tsx:374-379` | 搜索仓库 `Input` 只有 placeholder，无 `aria-label`。 | 读屏无名输入框。 | P3 | 代码走读 |
| GH-05 | `github/GithubRepoModal.tsx:401-409`、`:461-469` | 仓库 / 分支列表按钮无 `type="button"`、无 `aria-pressed`/`role="option"`。 | 选中态只对视觉用户可见；在 form 内会触发提交。 | P3 | 代码走读 |
| RB-01 | `github/RepoStatusBanner.tsx:46-49`、`:53-55` | 标签行 `truncate` + 状态文案 `shrink-0`；失败信息单行 `truncate` 无展开 / `title`。 | 390px 下仓库名只剩「dream-star-…」；克隆失败的关键信息被截断无法阅读。 | P3 | `sidebar-repo-banner--mobile--light.png`、`…--desktop--light.png` |
| RB-02 | `github/RepoStatusBanner.tsx:62-71` | 横幅关闭按钮 `p-0.5` + 14px 图标 ≈ 18px。 | 触控目标远小于 44px。 | P3 | 同上 |
| RB-03 | `github/RepoStatusBanner.tsx:33-34`；`hooks/useRepoBinding.ts:221-226` | 横幅无 `role="status"`；失败时 `toast` + 横幅双重提示。 | 状态变化读屏不播报；失败弹两处。 | P3 | 代码走读 |

### 3.6 文案

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| ST-01 | `lib/sessionTitle.ts:3`（另见 `hooks/useChatSocket.ts:524`，归属 messages） | 空标题回退「新会话」，侧栏 / 列表 / 搜索全部用「新对话」。 | 同一实体两个名字。 | P3 | 代码走读 |

## 4. 修复计划（阶段 B）

按严重度分批；每条给「改哪 / 怎么改 / 补什么测 / 风险」。涉及归属外文件的只列诉求、走 `send_to` owner。

### 4.1 P2（必修，12 条）

| 编号 | 改动文件 | 做法 | 测试 | 风险 |
|---|---|---|---|---|
| S-01 | `Sidebar.tsx`、`sidebar/flattenItems.ts` | 空项目 hint 恢复 36px 普通行，文案改「暂无会话 · 点 + 新建」；108px CTA 只保留在**整个列表为空**（`sessions.length===0`）的 `未分类` 空态。`flattenItems` 给 hint 增加 `variant: "empty-list" \| "empty-project"` 字段。 | `Sidebar.test.tsx`：两个空项目时 hint 高度 = 36；全空时仍有 CTA 按钮。更新 ui-preview after 截图。 | 低。现有测试若断言 108 需同步改。 |
| S-03 | `Sidebar.tsx` | `emitReorder` 改 async：`try { await onReorderProjects(ids) } catch { setOrderOverride(null) }`；`SidebarProps.onReorderProjects` 类型改为可返回 `Promise<void>`；projects prop 变化时清 `orderOverride`。 | `Sidebar.test.tsx`：reorder reject → 顺序回到 props 顺序、无 unhandled rejection。 | 低。 |
| S-04 | `Sidebar.tsx` | 「项目」header 的 IconButton 去掉触控放大（自定义 class 覆盖 `[@media(hover:none)]:size-7`）**或**把 `GROUP_HEADER_HEIGHT` 在 coarse pointer 下升到 44（拍平层已按 item.height 排 offsets，仅需 `useCoarsePointer()` 传入 flatten）。推荐后者：保 44px 触控。 | `flattenItems.test.ts` 新增 header 高度参数用例；after 截图 `sidebar-mobile-drawer`。 | 低。 |
| S-08 / USL-01 / USL-02 | `hooks/useSessionList.ts`、`Sidebar.tsx` | ① `loadMoreSessions` catch 里 `toast("加载更早会话失败", "error")` 且 **保留 `hasMore=true`** 允许重试；Sidebar 在 `loadingMore` 位增加错误行「加载失败，点击重试」（新增 prop `loadMoreError?: boolean`）。② 重命名：`patchSessionTitle` 失败回滚标题 + `toast("重命名失败，已恢复")`。③ 删除：`deleteSession` 失败 → toast「删除失败，刷新后会话仍在」并重新拉一次 `refreshSessionList`（不回填 IndexedDB，说明清楚）。 | `useSessionList.test.tsx`：三条失败路径各一条用例（断言 toast 与状态回滚）。 | 中：删除失败回滚涉及 socket 已 `removeSession`，不做完整回滚，只做告知 + 重拉。 |
| S-09 | `Sidebar.tsx` | 底栏改两段式：宽度 <260 隐藏「案例」文字并把余额缩成 `1.23M 积分` 风格（复用 `formatCredits` 增加 compact 选项，若无则本地实现）；昵称 `min-w-[4ch]`。删掉 `:993` 死条件。 | `Sidebar.test.tsx`：width=220 时余额文本不含省略号。after 截图 `sidebar-narrow-min`。 | 低。`formatCredits` 在 `lib/utils.ts`（shell 归属）——若需改签名走 `send_to opus-5-1`，否则在 Sidebar 内做 compact。 |
| S-12 | `Sidebar.tsx`、`hooks/useChatProjects.ts` | ① 拍平前把 `projectId` 不在 `projects` 内的会话归入「未分类」（`ungroupedGroups` 过滤改为 `!s.projectId \|\| !projectIdSet.has(s.projectId)`）。② `useChatProjects` 列表失败：`toast("项目列表加载失败")` + 暴露 `reloadProjects`，并在 60s 轮询里顺带重拉一次（复用 `useSessionList` 的可见性节奏，或独立 `setInterval`）。 | `Sidebar.test.tsx`：会话 projectId=未知 时出现在未分类；`useChatProjects.test.ts`：失败后重试成功回填。 | 低-中：轮询新增一个接口调用，频率与会话列表一致。 |
| BB-01 | `sidebar/BatchBar.tsx` | 改为两行固定布局：第一行「已选 N 条 ……… 取消」，第二行图标按钮组（归档 / 取消归档 / 移动 / 删除）用 `IconButton` + `title`，不再 `flex-wrap`。顺带 BB-02（删除用 `variant="danger"` 或 `text-danger`）、BB-03（选中集合含归档会话时显示「取消归档」）。 | `Sidebar.test.tsx` 现有 batch 用例（按 aria-label 取按钮）；after 截图 268 / 220 两档。 | 低。 |
| PS-01 | `ProjectSettingsDialog.tsx` | 切换看板项目时若 `instructions` 非空且与当前值不同，先 `useConfirm` 询问「用看板项目的指令覆盖当前内容？」；否则仅在文本域为空时回填。首次打开（`project.boardProjectId` 已绑）保持现行为。 | `ProjectSettingsDialog.test.tsx`：已输入指令 + 切看板 → 弹确认；取消保留原文。 | 低。 |
| IB-01 | `InboxDialog.tsx` | 新增 `stripHtmlComments(md)`（复用 `stripMarkdownSummary` 第一条正则）在 `<Markdown>` 前处理；同时导出供单测。 | `InboxDialog.test.tsx`：展开含 `<!-- ob:x -->` 的消息，DOM 文本不含 `ob:`。 | 极低。不改 `Markdown` 组件（messages 归属）。 |
| GH-01 | `github/GithubRepoModal.tsx` | grid 两列容器加 `min-w-0`；`li`/`button` 加 `min-w-0`；仓库名 span 已 `truncate` 即可生效。分支列 `pr-2` 保证徽标可见。 | `GithubRepoModal.test.tsx` 现有用例回归；after 截图 `sidebar-github-linked--desktop`（超长仓库名必须省略号、分支 ✓ 可见）。 | 极低。 |
| GH-02 | `github/GithubRepoModal.tsx` | `!sessionId` 时在 footer 左侧显示提示「先发送一条消息创建会话后再绑定」（`text-caption text-muted`），并给禁用按钮 `title` 同文案；账号栏保持可用以便先连账号。 | `GithubRepoModal.test.tsx`：`sessionId=undefined` 渲染提示文案。 | 低。 |

### 4.2 P3（量力而行，26 条）

| 编号 | 改动文件 | 做法 | 测试 |
|---|---|---|---|
| S-02 | `Sidebar.tsx` | 把 mount-only effect 改为依赖 `[archivedExpanded]` 首次为 true 时触发（用 ref 防重复）。 | `Sidebar.test.tsx`：user 晚到 + localStorage=1 → `onLoadArchived` 被调。 |
| S-05 | `Sidebar.tsx`、`hooks/useSidebarWidth.ts` | 把手加 `tabIndex=0`、`aria-valuenow/min/max`、`title="拖动调整宽度，双击复位"`；hook 暴露 `onResizeKeyDown`（←/→ ±16px，Home/End 最小/最大）。 | `useSidebarWidth.test.ts` 键盘用例。 |
| S-06 | `Sidebar.tsx` | 新增 prop `collapseLabel?: string`（默认「折叠侧栏」）；App 移动端传「关闭导航」——App 接线一行改动走 `send_to opus-5-1`，Sidebar 侧先落 prop。 | 快照用例。 |
| S-07 | `Sidebar.tsx` | `type="search"` + 有值时显示 × 清除按钮；Escape 清空；结果 hint 容器加 `role="status" aria-live="polite"`。 | `Sidebar.test.tsx`：Escape 清空、× 清空。 |
| S-10 | `hooks/useSessionList.ts`、`Sidebar.tsx` | `searchSessionMessages` 增加 `includeArchived` 参数，Sidebar 传 `archivedExpanded`。 | `useSessionList.test.tsx` 参数透传。 |
| S-11 | `sidebar/SessionRow.tsx`、`Sidebar.tsx` | `SessionRow` 增 `highlightQuery?: string`，标题用 `HighlightedText`。 | 快照。 |
| S-13 | `Sidebar.tsx`、`sidebar/flattenItems.ts` | `sessions.length===0 && projects.length===0` 时只渲染一个引导空态（EmptyState：说明 + 新建会话 + 新建项目），隐藏「未分类 / 已归档 0」。 | `flattenItems.test.ts` 全空用例。 |
| S-14 | `Sidebar.tsx` | 依 §5 决策：若确认个人版不展示计费，副标题改为用户邮箱或省略。 | — |
| SR-01 | `sidebar/compactDuration.ts`、`SessionRow.tsx` | 单位改「分 / 时 / 天」；`title` 之外为触屏加长按 / 点击弹 Tooltip（复用 `ui/Tooltip`）。 | `compactDuration.test.ts` 更新期望。 |
| SR-02 | `sidebar/SessionRow.tsx` | 仅在**鼠标**关闭时阻止焦点回归（`event.detail`/pointerType 判断），键盘关闭保留默认。 | 键盘用例。 |
| SR-03 | `sidebar/SessionRow.tsx` | 菜单项统一带 14px 图标（Pencil / FolderInput / CheckSquare / Trash2）。 | 快照。 |
| SR-04 | `sidebar/SessionRow.tsx` | 多选态复选框放在状态点**左侧**而非替换；项目内会话缩进改 `pl-4`。 | 快照 + after 截图。 |
| PR-01 | `sidebar/ProjectRow.tsx` | 运行徽标改「● 1 运行中」pill，或与总数用「1 / 2」分隔。 | 快照。 |
| PR-02 | `sidebar/ProjectRow.tsx` | 触控下「+」并入「…」菜单（菜单里已有「新建会话」），行尾只留一个按钮。 | `Sidebar.test.tsx` coarse pointer 用例。 |
| SD-01 | `SessionStatusDot.tsx` | 点放大到 8px；出错 / 服务重启用不同形状（三角 / 环）；文字 `sr-only` 而非仅 `title`。 | 快照。 |
| UCP-01 | `hooks/useChatProjects.ts` | 若后端支持批量 sortOrder 则改单请求；否则串行 `for…await` 并在失败点停止 + 回滚已改项。 | `useChatProjects.test.ts`。 |
| UUS-01 | `hooks/useUnreadSessions.ts` | `onclick` → `window.focus()` + 调用新增 `onNotificationOpen?(sessionId)` 回调（App 接 `selectSession`，一行接线走 shell owner）。 | 单测断言回调。 |
| PS-02 | `ProjectSettingsDialog.tsx` | 换 `ui/Select`。 | 现有用例回归。 |
| PS-03 | `ProjectSettingsDialog.tsx` | `dirty` 时关闭前 `useConfirm`。 | 用例。 |
| PS-04 | `ProjectSettingsDialog.tsx` | 色块 `size-9 [@media(hover:none)]:size-11`，间距 `gap-3`。 | after 截图 mobile。 |
| PS-05 | `ProjectSettingsDialog.tsx` | 「墨」改用固定深色 token（如 `bg-fg`）、「灰」用 `bg-muted`；「无颜色」边框改 `border-border-strong`。 | after 截图 dark。 |
| PS-06 | `ProjectSettingsDialog.tsx` | 计数并入 `Field` 的 label 右侧（`N / 4000` 与标签同行）。 | 快照。 |
| PS-07 | `ProjectSettingsDialog.tsx` | 捕获 409 / version 错误码 → 文案「看板指令已被他处修改，请重新打开后保存」。 | 用例。 |
| PA-01 / PA-02 / PA-03 | `ProjectAssetsPanel.tsx`、`hooks/useProjectAssets.ts` | 文案「已注入」→「项目知识 1/20」；下载中用 `Spinner`；上传暴露 `progress {done,total}` 显示「正在上传 2/5」。 | `ProjectAssetsPanel.test.tsx`。 |
| IB-02 / IB-03 | `InboxDialog.tsx` | 列表区 `aria-busy={loading}`、错误 / 空态容器 `role="status"`；Tab label「未读 (N)」。 | 用例。 |
| GH-03 / GH-04 / GH-05 | `github/GithubRepoModal.tsx` | scopes 映射成「可读写仓库 · 读取账号」；Input `aria-label="搜索仓库"`；列表用 `role="listbox"/"option"` + `aria-selected`，按钮加 `type="button"`。 | 用例。 |
| RB-01 / RB-02 / RB-03 | `github/RepoStatusBanner.tsx`、`hooks/useRepoBinding.ts` | 小屏改两行（标签 / 状态）；失败信息 `line-clamp-2` + `title`；关闭按钮换 `IconButton size="sm"`；容器 `role="status"`；失败态有横幅时不再 toast。 | after 截图 mobile。 |
| ST-01 | `lib/sessionTitle.ts` | 回退改「新对话」；`useChatSocket.ts:524` 同步改动 `send_to opus-5-3`。 | `sessionTitle.test.ts` 更新期望。 |

### 4.3 验证门（阶段 B 交付前）
- `npm run typecheck --workspace packages/web-react`
- `cd packages/web-react; npx vitest run src/components/Sidebar.test.tsx src/components/sidebar src/components/ProjectSettingsDialog.test.tsx src/components/ProjectAssetsPanel.test.tsx src/components/InboxDialog.test.tsx src/components/github src/hooks/useSessionList.test.tsx src/hooks/useChatProjects.test.ts --maxWorkers=1`
- 侧栏属高频交互面：`npm run test:browser`
- 同一组 12 个场景出 after 截图到 `.audit-tmp\sidebar\after`，逐张对照。

## 5. 建议不修 / 暂缓项及理由

| 项 | 理由 |
|---|---|
| 会话行不显示 `lastMessagePreview` | `Sidebar.test.tsx:897-915` 明确锁定「会话行恒单行」，属产品决策；本轮不改。 |
| S-14「多模型 · 计量计费」副标题 | 是否在个人版 / 自托管展示计费文案需 product owner 拍板（`data-product-feature=billing` 由能力开关控制，可能已按部署形态隐藏）。阶段 B 前用 `ask_decision` 确认，不确认则不动。 |
| `startLink` 直接 `window.location.href` 跳 OAuth（`GithubRepoModal.tsx:167-181`） | 跳转前未保存的草稿会丢，但改成 popup 涉及后端回调地址与 `authBroadcast`（landing 归属），收益小、面大，暂缓。 |
| `useSidebarWidth` 宽度全局而非按用户持久化 | 设备级偏好按设备存合理，不改。 |
| 拖拽（会话拖入项目 / 项目排序）在触屏禁用 | 已提供菜单「移动到项目 / 上移 / 下移」等价路径，符合设计；不引入触屏拖拽库。 |
| `InboxDialog` 自实现 `fmtRelativeTime` 与 `ui/TimeAgo` 重复 | 注释说明语义不同（今天 / 昨天 HH:mm），用户可感知结果正确，属 §5-7 不处理范围。 |
| `useDelayedConnBanner` 2s 延迟 | 走读符合 P3 RFC D6 设计（零闪烁、内容实时），无问题。 |
| `useProjectScope` / `lib/projectScope.ts` | 纯逻辑，单测覆盖完整（`projectScope.test.ts`），走读未发现用户可感知问题。 |
| 移动端抽屉本身（`App.tsx:3367-3427`） | `Sheet` 已带遮罩 / Escape / 焦点陷阱，宽度 268 / 82vw 合理；抽屉宿主属 shell 归属，本模块只改内联 Sidebar。 |
| 需后端配合 | UCP-01 若要单请求批量排序需新增 `PATCH /api/chat-projects/reorder`；GH-03 scope 可读映射若要精确需后端返回结构化 scopes。均记为「需后端配合」，前端先做保守方案。 |

## 6. 修复记录（阶段 B · t-37）

- 分支 `feat/v5-selfhost-audit-sidebar`，基线 `210b9967`；阶段 B 共 5 个提交（前三个由 fable-5-1-19 完成，后两个由接手的 fable-5-1-25 完成；他中途掉线时留下的未提交改动已核对、补类型后原样提交为第 4 个）。
- 提交 subject 一律 `feat(v5)`（决策 d-26），未触碰 changelog.json / apps/windows / 后端包。

| 提交 | 内容 | 覆盖编号 |
|---|---|---|
| `17710a62` | 空项目提示不再叠 CTA、排序失败回滚、触控标题行、底栏紧凑、未知项目归未分类；同批：归档展开态晚到恢复、折叠钮 `collapseLabel`、搜索框 ×/Escape/aria-live、标题命中高亮、菜单键盘关闭焦点回归、菜单项统一图标、中文用时单位、运行数 pill、触屏「+」并入菜单、状态点 8px + 出错描环、批量条两行固定 + 删除 danger + 取消归档 | S-01 S-02 S-03 S-04 S-06 S-07 S-09 S-11 S-12① SR-01 SR-02 SR-03 PR-01 PR-02 BB-01 BB-02 BB-03 SD-01 |
| `85588532` | 重命名 / 删除 / 加载更多失败不再静默（回滚 + toast + 可重试）；项目列表失败 toast + 可见时自动重试 + `reloadProjects` | S-08 USL-01 USL-02 S-12② |
| `8035d26a` | 看板指令覆盖先问、剥 `<!-- ob:xxx -->`、选仓列表 `min-w-0` 不再裁切、草稿态提示；同批：色块触控 44px、「墨/灰/无颜色」跨主题稳定、字数计数并入标签行、「注入」→「项目知识」、下载中 Spinner、站内信 aria-busy/status + 未读数、scope 可读化 + 搜索框 aria-label + listbox/option 语义、横幅两行 + IconButton 关闭 + role=status + 失败不再双提示 | PS-01 PS-04 PS-05 PS-06 PA-01 PA-02 IB-01 IB-02 IB-03 GH-01 GH-02 GH-03 GH-04 GH-05 RB-01 RB-02 RB-03 |
| `513c2f39` | 拖宽把手键盘可调（← → / Shift 大步 / Home End，aria-valuenow/min/max，title 说明双击复位）；消息搜索 `includeArchived` 跟随「已归档」展开；多选复选框放状态点左侧 + 项目内缩进 `pl-4`；看板指令 409 版本冲突单独文案；系统通知点开聚焦窗口 + `onNotificationOpen(sessionId)`，同会话通知按 tag 折叠 | S-05 S-10 SR-04 PS-07 UUS-01 |
| `bc3cef1c` | 零会话零项目只渲染一块引导空态（说明 + 新建会话 + 新建项目，`data-testid=sidebar-empty-all`），不再摆「项目 +」「未分类 0」骨架；看板绑定改用 `ui/Select`；关闭前脏检查（Esc / 遮罩 / 取消 → 「放弃未保存的修改？」，程序回填看板指令不算改动）；项目排序只 PATCH 变了的项目、串行写、失败点停下只回滚已改成功项；多文件上传 `uploadProgress` → 「正在上传 N/M 个文件…」+ Spinner + role=status；空标题回退统一「新对话」；`browser-tests/run.mjs` T41 断言会话用时改为中文单位（SR-01 后的契约，仅此一行） | S-13 PS-02 PS-03 UCP-01 PA-03 ST-01 |

### 6.1 与计划的偏离

| 编号 | 偏离 | 理由 |
|---|---|---|
| S-13 | 引导空态保留了「已归档」开关（计划写「隐藏未分类 / 已归档 0」） | 归档列表按需拉取，零活动会话时计数 0 不代表真没有；「已归档」开关是归档会话唯一入口，藏掉会让把全部会话归档的用户无路可走。「项目 +」「未分类 0」两处骨架已按计划隐藏。 |
| PS-03 | 用 `useConfirm` 二次确认而非直接阻止关闭 | 与仓内其它编辑器（SkillEditor 等）的「放弃修改」交互一致。 |
| UCP-01 | 前端串行写 + 只写变更项，未新增批量接口 | 计划已注明需后端配合的路径先走保守方案；本轮不碰后端包。 |
| ST-01 | 只改 `lib/sessionTitle.ts`（含导出 `EMPTY_SESSION_TITLE`） | `hooks/useChatSocket.ts:524` 属 messages 归属，见 §6.2。 |

### 6.1.1 承接的跨模块请求

| 来源 | 编号 | 改动 | 测试 |
|---|---|---|---|
| taskboard-B（fable-5-1-19 / fable-5-1-23） | T-02（P1） | `hooks/useProjectScope.tsx`：新增 `hydrated`（最近一次 `listProjects` **成功**）；找不到的 token 只在 `hydrated && !loading` 时才判真失效回落 `all`。列表未到位、请求失败、未登录三种情况保留 token——对外 `token` 经 `preferredScopeToken` 已是 `all`（UI fail-closed），但 URL `?project=` 与 localStorage 记忆原样保留，列表到位后自动命中；项目已删 / 已归档仍回落并清参数。 | 新增 `hooks/useProjectScope.test.tsx` 4 条（到位前保留 → 到位后 scope=work；真失效回落；请求失败不抹链接、下次成功命中；未登录不校验）；`lib/projectScope.test.ts`、`taskboard.test.tsx`（49）、`UsageTab.test.tsx` 回归绿。 |

### 6.2 遗留与跨模块接线（集成时处理）

| 项 | 状态 | 说明 |
|---|---|---|
| S-14「多模型 · 计量计费」副标题 | **未改**（P3） | 需 product owner 拍板个人版 / 自托管是否展示计费文案；侧栏侧未动，`data-product-feature=billing` 能力开关照旧。 |
| S-05 键盘调宽 | Sidebar / hook 已落，**App 未接** | `App.tsx` `sidebarProps` 需加一行 `onResizeKeyDown: sidebarWidth.onResizeKeyDown`（shell 归属）。接线前把手不进入 Tab 序列，功能对键盘用户仍不可用。 |
| S-06 抽屉关闭按钮读屏名 | Sidebar 已落 `collapseLabel` prop，**App 未接** | 移动端 `Sheet` 内联侧栏需传 `collapseLabel="关闭导航"`（shell 归属）。 |
| UUS-01 通知落点 | hook 已落，**App 未接** | `useUnreadSessions({ …, onNotificationOpen: selectSession })`（shell 归属）。未接线时点通知只聚焦窗口。 |
| ST-01 | `useChatSocket.ts:524` `title \|\| "新会话"` 待改「新对话」 | messages 归属，可在 messages-B 或集成时一行同步。 |
| `browser-tests/run.mjs` | 只改了 T41 一处断言 | 共享文件，合入 integration 时若与其它分支冲突，以「会话用时 `8分`」为准。 |

## 7. 验证（阶段 B 交付前 · 2026-09-16）

| 门 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | 绿（`tsc -b` 退出 0） |
| 模块 vitest（§4.3 清单 + `SessionStatusDot` / `useSidebarWidth` / `useUnreadSessions` / `useRepoBinding` / `useProjectAssets` / `sessionTitle` / `lib/github`，`--maxWorkers=1`） | **17 个文件 252 条全绿**；本轮每个逻辑改动都有对应用例（S-13 ×7、PS-02 ×1、PS-03 ×3、UCP-01 ×2、PA-03 ×2、ST-01 ×1；接手提交 S-05 ×3、S-10 ×2、SR-04 ×1、PS-07 ×1、UUS-01 ×1） |
| `npx biome lint`（本轮 14 个改动文件） | 无新增诊断；既有 6 条（`role="radio"` 色块、`noLabelWithoutControl`、`noDelete`、`useExhaustiveDependencies`）在改动前的 HEAD 上同样存在，未动。根 `biome.json` 的格式规则（单引号 / 无分号）与 web-react 既有风格不符，包内文件本来就不通过 `biome format`，不作为门。 |
| `npm run test:browser` · `run.mjs` | **67/67 ok**（第 2 次全量运行）。首次运行 T41 因 SR-01 把用时改成中文单位而失败，已把断言 `8m` → `8分`；T43「移动端首次上滑解除贴底」首次 not ok、重跑 ok，属消息区触控滚动用例、与侧栏无关。 |
| `npm run test:browser` · `node --test` 阶段 | 73 条：70 pass / 3 fail，**3 条在基线 `210b9967`（wt/media）上同样失败**，与本分支无关：① `cc-switch-ascii-name`（2 子测试：等待超时 + 期望 `gemini-3.8-flash` 实得 `sonnet-5`，settings 归属）；② `ocv5-185-qa`：Windows 下 `symlink packages/protocol → node_modules/@openclaude/protocol` EPERM（未开发者模式），环境限制。日志：`.audit-tmp\sidebar\after\test-browser.log`、`test-browser-2.log`。 |
| after 截图 | `D:\code\test_project\test123\.audit-tmp\sidebar\after\`：同一组 12 场景 × 2 主题 = 34 张 + `manifest.json` + `shoot-after.log`，`failures=[] unmockedApi=[]`。逐张对照要点：`sidebar-empty`（S-13 引导块替代三处 0 计数骨架）、`sidebar-project-settings` 明暗两版（PS-02 下拉与输入框同构、PS-04/05/06）、`sidebar-multiselect`（SR-04 复选框在状态点左侧、BB-01 两行批量条、BB-02 删除红色）、`sidebar-overview`（SR-04 缩进、PR-01 运行 pill、S-09 底栏 `余额 123.4万`）、`sidebar-narrow-min`（220px 批量条不再折 3 行）、`sidebar-mobile-drawer`（S-04「+」不再溢出）、`sidebar-inbox`（IB-01 无 `<!-- ob:` 残留、IB-03 未读数）、`sidebar-github-linked--desktop`（GH-01 超长仓库名省略号、分支 ✓ 可见）、`sidebar-repo-banner--mobile`（RB-01 两行）。 |
| 未跑 | 拖拽（会话拖入项目 / 项目排序）与键盘调宽仍未做真浏览器交互验证（NOT RUN）：ui-preview 只出静态截图，`run.mjs` 无对应用例；两者由 vitest 用例覆盖（S-03 回滚、UCP-01 串行、S-05 键盘）。 |

---

## 8. 二期 · 遗留 P3 收尾（t-627 · fable-5-1-38 · 2026-09-16）

> 指挥官口径：需产品拍板的项按「最小改动、可回退、不改既有交互约定」自行定并写明理由；App.tsx 接线已登记给集成②，不重复。
> 分支 `feat/v5-selfhost-audit-sidebar`，接 `ef872e91a` 之后：`297ad8c94`（代码）+ 本文档一条 docs 提交。

### 8.1 §6.2 遗留表逐条处置

| 项 | 归属 | 处置 | 说明 |
|---|---|---|---|
| S-14「多模型 · 计量计费」副标题 | sidebar ✅ **已修** | `Sidebar.tsx` 底栏账号 chip 与账号菜单头部：`credits != null` 仍显余额（底栏万/亿缩写、菜单完整数字，行为不变）；无余额时**有邮箱显邮箱、没有就不渲染这一行**，不再写死营销文案 | 自行拍板理由：① 商业化文案出现在个人版 / 自托管 / demo / 未登录四种不计费形态里是审计确认的问题，而「显示余额」这条既有约定一字未动；② 邮箱是账号区本就该有的身份信息，无新增能力开关判断、无新接口；③ 一处文案的替换，可回退。用例：`Sidebar.test.tsx`「S-14 无余额时的账号副标题」3 条（有余额 / 无余额有邮箱 / 无余额无邮箱与未登录 / 账号菜单同规则）。`data-product-feature=billing` 照旧 |
| S-05 键盘调宽 App 未接 | shell（App.tsx） | ⏸ 保持遗留 | `sidebarProps` 需加 `onResizeKeyDown: sidebarWidth.onResizeKeyDown` 一行；已登记给集成②，本轮不重复 |
| S-06 抽屉关闭按钮读屏名 App 未接 | shell（App.tsx） | ⏸ 保持遗留 | 移动端 `Sheet` 内联侧栏传 `collapseLabel="关闭导航"`；已登记给集成② |
| UUS-01 通知落点 App 未接 | shell（App.tsx） | ⏸ 保持遗留 | `useUnreadSessions({ …, onNotificationOpen: selectSession })`；已登记给集成②。未接线时点通知只聚焦窗口，功能不退化 |
| ST-01 `useChatSocket.ts:524` 「新会话」 | messages（`hooks/useChatSocket.ts`） | ⏸ 保持遗留 | 一行改「新对话」（可直接引用 `lib/sessionTitle.ts` 导出的 `EMPTY_SESSION_TITLE`），归 messages-B / 集成时同步 |
| `browser-tests/run.mjs` T41 断言 | 共享文件 | ✅ 无需再动 | 已随 `bc3cef1c0` 合入 integration，本轮复跑 T41 ok |

### 8.2 顺手承接（原登记给集成②，本轮已做，集成②不必重复）

| 项 | 改动 | 用例 |
|---|---|---|
| `components/github/RepoPill.tsx` 未绑定态文案不可收缩 | `<span className="whitespace-nowrap">关联 GitHub 仓库</span>` → `min-w-0 truncate`，完整文案仍在按钮 `title`。来源：composer 审计 `docs/audit/composer.md` §9（390px 生成中工具行被 pill 撑爆，composer 侧已按视口分流规避；pill 可收缩后 composer 可把 `<sm` 的 pill 并回工具行） | 新增 `github/RepoPill.test.tsx` 2 条（未绑定 class/title/onClick；已绑定 owner/repo 与 aria-label/title） |

### 8.3 §5 暂缓项复核（sidebar 归属内是否还有可独立落地的）

| 项 | 结论 |
|---|---|
| `startLink` 直接 `window.location.href` 跳 OAuth | 保持暂缓：改 popup 涉及后端回调地址与 `authBroadcast`（landing 归属），不是本模块可独立完成 |
| `useSidebarWidth` 按设备持久化 / 触屏禁用拖拽 / `useDelayedConnBanner` / `useProjectScope` / 会话行不显示 `lastMessagePreview` | 均为有意设计或有单测锁定的产品决策，不改 |
| `InboxDialog.fmtRelativeTime` 与 `ui/TimeAgo` 重复 | 用户可感知结果正确（今天 / 昨天 HH:mm 语义不同），§5-7 口径不处理 |
| UCP-01 批量排序接口 / GH-03 结构化 scopes | 需后端配合；前端保守方案已在阶段 B 落地（串行写 + 只写变更项；scope 可读映射） |

**统计**：§6.2 遗留 6 条 → sidebar 归属内可独立完成 1 条（S-14）**已修 1/1（100%）**；跨模块 4 条（S-05 / S-06 / UUS-01 → shell，ST-01 → messages）保持遗留并写明接线；1 条（run.mjs）已随合入闭环。另顺手完成集成②登记项 1 条（RepoPill 截断）。

### 8.4 验证（二期）

均在 `d:\code\test_project\test123\wt\sidebar`，代码 HEAD `297ad8c94`。

| 门 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | 绿 |
| 模块 vitest（`Sidebar` / `components/sidebar` / `ProjectSettingsDialog` / `ProjectAssetsPanel` / `InboxDialog` / `SessionStatusDot` / `components/github` / `useSessionList` / `useChatProjects` / `useSidebarWidth` / `useUnreadSessions` / `useRepoBinding` / `useProjectAssets` / `useProjectScope` / `sessionTitle` / `github` / `projectScope` / `sessionStatus` / `inboxLevels` / `sidebarCollapsed`，`--maxWorkers=1`） | 绿：**22 files / 290 tests**（阶段 B 17 files / 252 → 新增 `RepoPill.test.tsx` + S-14 用例） |
| `npx biome lint`（`Sidebar.tsx` `Sidebar.test.tsx` `RepoPill.tsx` `RepoPill.test.tsx`） | 新增代码 0 告警；`Sidebar.test.tsx:938` `noDelete` 为阶段 B 前既有，未动 |
| `npm run test:browser` | `run.mjs` **T1–T67 共 67 条全部 ok**（含侧栏 T41 密度 / T25 移动整页）；`node --test` 73 条 70 pass / 3 fail，3 条与阶段 B 记录相同、与本模块无关且基线既有（`cc-switch-ascii-name` ×2 settings 归属；`OCV5-185` Windows symlink EPERM）。日志 `.audit-tmp\sidebar\after-2\test-browser.log` |
| after-2 截图 | `D:\code\test_project\test123\.audit-tmp\sidebar\after-2\`：同一组 12 场景 × 2 主题 = 34 张 + `manifest.json`，`failures=[] unmockedApi=[]`。对照要点：`sidebar-empty--desktop`（S-14：底栏账号「审计预览」下不再有「多模型 · 计量计费」，场景用户无邮箱故只剩一行）；`sidebar-overview`（有余额时底栏仍「余额 123.4万 积分」，无变化）；`sidebar-repo-banner--mobile`（RepoPill 4 态视觉无变化，未绑定 pill 在充足空间下完整显示） |
