# 任务面板（taskboard）审计 · 阶段 A

- 模块：任务面板（`packages/web-react/src/components/taskboard/**`、`src/lib/{taskboard,taskboardFeature}.ts`）
- 分支：`feat/v5-selfhost-audit-taskboard`（基线 `210b9967892b3624fb3984f69d2174e4a641b33d`）
- 作业口径：工作区根目录 `TEAM_PLAYBOOK.md` §5 清单、§6 阶段 A
- 结论：**P1 × 2、P2 × 14、P3 × 14**，共 30 条。阶段 A 未改任何业务代码，只新增/重写了 ui-preview 场景文件与本文档。

---

## 1. 范围与文件清单

| 文件 | 行数 | 职责 | 备注 |
|---|---|---|---|
| `components/taskboard/TaskboardView.tsx` | 897 | 面板壳：顶栏、任务/成本/周报分区、看板/列表切换、新建单据、单据操作与移动、抽屉挂载 | 主入口 |
| `components/taskboard/useTaskboard.ts` | 820 | 数据层 hook：首屏加载、后台对账（60s 轮询 + 可见性）、乐观更新、分页、增删改 | 竞态集中地 |
| `components/taskboard/BoardColumns.tsx` | 443 | 看板列（积压 / 待确认 / 阶段列）、拖拽落点、移动端阶段导航 | |
| `components/taskboard/TicketCard.tsx` | 201 | 工单卡片（看板紧凑态 / 列表卡片态） | |
| `components/taskboard/TicketListView.tsx` | 282 | 列表：桌面表格 / 移动卡片、筛选、分页 | |
| `components/taskboard/TicketDrawer.tsx` | 519 | 单据抽屉：正文、改需求、操作、评论、时间线 | owner fence 已有专项测试 |
| `components/taskboard/TicketTimeline.tsx` | 224 | 讨论 / 系统活动（run、activity） | |
| `components/taskboard/ticketMove.ts` | 87 | 移动语义与文案 | 纯函数 |
| `components/taskboard/StageSettings.tsx` | 1090 | 流水线配置抽屉：流水线增改、阶段增改排序、阶段编辑表单 | 最长表单 |
| `components/taskboard/ProjectSettings.tsx` | 607 | 项目新建/编辑/归档、工作区、项目上下文、项目记忆 | |
| `components/taskboard/BoardSettingsPanel.tsx` | 292 | 护栏设置（并发/上限/成本/静默/急停） | |
| `components/taskboard/TemplateLibrary.tsx` | 248 | 流水线模板库（内置/自定义、套用/删除） | |
| `components/taskboard/CostStatsView.tsx` | 239 | 成本统计 | |
| `components/taskboard/CostCoverageBlock.tsx` | 35 | 成本覆盖度文案块 | |
| `components/taskboard/WeeklyReportView.tsx` | 242 | 周报 | |
| `lib/taskboard.ts` | 1611 | 类型、枚举标签、错误码映射、展示辅助、`/api/board` 客户端 | 与 gateway domain 锁步 |
| `lib/taskboardFeature.ts` | 9 | 构建期开关 | 无问题 |
| 测试：`taskboard.test.tsx`、`boardMove.test.tsx`、`m4Board.test.tsx`、`ownerFence*.test.tsx`、`costLegacyFallback.test.tsx`、`ProjectSettings.test.tsx`、`lib/taskboardFeature.test.ts` | — | 9 个文件 101 用例，基线全绿 | |

**只读参照（非本模块归属，但直接决定任务面板行为）**：`hooks/useProjectScope.tsx`、`lib/projectScope.ts`（sidebar）、`hooks/useAppRoute.ts`、`components/ui/{Sheet,Tabs,Select,Card,Button,IconButton,ConfirmDialog}.tsx`（shell）、`App.tsx` L3329–3456 的接线。

---

## 2. 方法与证据

### 2.1 视觉截图（主要证据）

- 工具：`packages/web-react/browser-tests/ui-preview/shoot.mjs`（真组件 + production CSS + Chromium），场景文件 **`browser-tests/ui-preview/scenes-taskboard.tsx`（本轮重写，随代码提交）**。
- 输出：`D:\code\test_project\test123\.audit-tmp\taskboard\before\`（仓库外），**16 个场景 × desktop/mobile × light/dark = 64 张 PNG** + `manifest.json`，全部逐张用 Read 看过。
- 命名：`<场景 id>--<desktop|mobile>--<light|dark>.png`。

| 场景 id | 内容 | 用于 |
|---|---|---|
| `taskboard-board-responsive` | 看板：积压 / 待确认 / 四个阶段列，10 条不同状态的单 | T-08 T-09 T-10 T-11 T-24 |
| `taskboard-list-responsive` | 列表：桌面表格 / 移动卡片 + 筛选 | T-04 T-09 T-13 |
| `taskboard-ticket-drawer` | 抽屉：Markdown 正文、操作、评论、讨论、系统活动展开 | T-05 T-06 T-07 T-18 |
| `taskboard-ticket-drawer-edit` | 抽屉「改需求」编辑态 | T-01（执行者显示裸 id）T-18 |
| `taskboard-create-form` | 新建单据：桌面内联 / 移动贴底抽屉 | T-01（顶栏无「管理项目」）T-26 |
| `taskboard-empty-columns` | 有阶段、无单据 | T-16 |
| `taskboard-no-pipeline` | 项目没有流水线列 | T-16 |
| `taskboard-scope-unselected` | 未选工作项目 | 对照 |
| `taskboard-scope-deeplink-reload` | 冷启只带 `?project=<工作项目>` | **T-02** |
| `taskboard-load-error` | 看板/列表接口 502 | **T-03** |
| `taskboard-stage-settings` | 流水线配置，展开「开发实现」编辑 | T-12 T-14 T-28 |
| `taskboard-template-library` | 模板库 | T-05 T-25 |
| `taskboard-board-settings` | 护栏设置 | T-14 T-22 |
| `taskboard-project-settings` | 编辑项目（工作区/上下文/记忆） | T-14 T-23 |
| `taskboard-cost-stats` | 成本统计（partial 覆盖） | T-14 T-21 |
| `taskboard-weekly-report` | 周报 | T-14 T-21 |

> 场景文件的重要变化：原来的两个场景**没有包 `ProjectScopeProvider`**，`useProjectScope()` 无 Provider 时恒为 `all`，因此过去的「任务面板」截图只有「请选择一个工作项目以查看看板」空态，看板本体从未入镜。新版每个场景包 Provider 并在项目列表到位后显式选中项目，面板/抽屉用 `AutoClick` 按 `data-testid` 点开；`taskboardApi` 走裸 `fetch`，api-stub 拦不到，故在每个场景 `render()` 里直接替换其方法。

### 2.2 代码走读

逐文件通读全部 17 个归属文件与上表只读参照；重点核对：状态机与竞态（`epoch` / `ownerGen` 门控）、URL/localStorage 持久化、错误分支落点、a11y 语义、文案术语。

### 2.3 跑过的验证（均在工作树 `d:\code\test_project\test123\wt\taskboard` 内）

| 命令 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ 绿 |
| `cd packages/web-react; npx vitest run src/components/taskboard src/lib/taskboardFeature.test.ts --maxWorkers=1` | ✅ 9 files / 101 tests passed（32s） |
| `npx biome check <taskboard 归属文件> browser-tests/ui-preview/scenes-taskboard.tsx` | 新场景文件 0 报错；存量文件 35 条报错中 34 条是 `format`（工作树 `core.autocrlf=true` 导致 CRLF 全文件差异，非代码问题），1 条存量 lint `ownerFence.review.test.tsx:354 useSingleVarDeclarator` |
| `node browser-tests/ui-preview/shoot.mjs`（`OC_UI_SCENES=taskboard`，`OC_UI_SHOT_DELAY=1400`） | ✅ 64/64 成功，0 渲染错误 |
| 临时复现用例（`zz-audit-race.tmp.test.tsx`，**已删除、不提交**） | 3/3 通过，分别复现 T-01 / T-02 / T-03，断言见下文各条「证据」 |

---

## 3. 问题清单

严重度：**P1** 功能不可用 / 数据错误 / 阻断主流程；**P2** 明显体验缺陷 / 一致性破坏 / 移动端不可用；**P3** 打磨项。
位置均为工作树内 `packages/web-react/` 下的相对路径。

### P1

| 编号 | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| **T-01** | `src/components/taskboard/useTaskboard.ts:322-382`（尤其 `:338`、`:376-379`）；`src/components/taskboard/TaskboardView.tsx:98-101`；`useTaskboard.ts:415-454` | 选中工作项目后同一 commit 里两个 effect 同时开跑：hook 内的 `loadInitial()`（`:384-413`）与 `TaskboardView` 的 `selectProject(lockedProjectId)`。`selectProject` 在 `:428` 把 `epoch` +1，`loadInitial` 在第一个 `await` 后 `isCurrent()` 为 false，于 `:338` 直接 `return`：已拿到的 **`projects` / `agents` 被丢弃**，其后的错误也因 `:376-379` 的 `isCurrent()` 守卫被吞。`selectProject` 只拉 board / backlog / list，不拉 projects / agents。 | 直到 60s 轮询或切标签页触发 `reconcile` 之前：① `board.projects` 为 null → 顶栏没有「管理项目/归档」入口（桌面无铅笔按钮、移动端「项目」图标变成「新建项目」）；② `agents` 为空 → 列表「执行者」筛选只有「全部执行者」、抽屉改需求的执行者下拉显示裸 `agent:coding-assistant`；③ 首屏加载失败被静默。**证据**：临时用例 A1（`listProjects` 被调 2 次、`getProjectBoard` 1 次、`listAgents` 1 次；`project-edit-open` 不存在、`project-create-open` 存在；执行者下拉 options 仅 `['']`；派发 `visibilitychange` 后两者才出现）；截图 `taskboard-create-form--desktop--light.png`（顶栏只有「新建项目」）、`taskboard-ticket-drawer-edit--desktop--light.png`（执行者显示 `agent:coding-assistant`）。 | **P1** |
| **T-02** | `src/hooks/useProjectScope.tsx:153-163`（配合 `:85`、`:88-106`）—— **sidebar 归属，需 owner 配合** | 冷启 URL 带 `?project=<工作项目 id>`（也是 `setToken(work.id)` 自己写进 URL / localStorage 的值）时，`workProjects` 尚未加载，`resolveProjectScope` 把找不到的 token 判成 `invalid`，effect 立即 `setToken('all')` 并把 URL 参数抹掉；项目列表到位后 scope 仍停在 `all`。App 中 `chatProjects` 也是异步到位，同样中招。 | **刷新页面 / 从书签打开 / 分享链接，看板范围必丢**，每次都要重新选项目；localStorage 里的记忆也被覆写成 `all`。任务面板是这个 scope 的主要消费者，周报 / 成本视图同样受影响。**证据**：临时用例 A2（`?project=work-project-1` → probe 文本 `all|all|`，`location.search === ''`）；截图 `taskboard-scope-deeplink-reload--*.png`（URL 带项目却显示「请选择一个工作项目以查看看板」）。 | **P1** |

### P2

| 编号 | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| **T-03** | `useTaskboard.ts:370-375`；`src/components/taskboard/BoardColumns.tsx:152-160`；`TaskboardView.tsx:719-729` | 看板接口失败：`loadInitial` 内层 catch 只 `setBoard(null); setTickets([])`（且被 T-01 抢跑时连这一步也到不了），`selectProject` 只 toast 一次。页面落在 BoardColumns 的「还没有流水线列 / 选一个项目后，单据会按当前流水线阶段分列」上，而项目明明已选。`board.error` 分支（`:719-729`，带「重试」）实际只在 `listProjects` 失败且未被抢跑时可达。 | 网络/网关故障时用户看到的是**错误的原因解释**，没有重试入口，toast 几秒后消失就再无线索。**证据**：临时用例 A3（`getProjectBoard` reject → 文本「还没有流水线列」存在，「任务面板加载失败」与「重试」不存在）；截图 `taskboard-load-error--*.png`。 | P2 |
| **T-04** | `src/components/taskboard/TicketListView.tsx:59-69`、`:98-108`；`useTaskboard.ts:69`；`src/lib/taskboard.ts:1048` | 列表默认 `status = 'backlog,ready,running,waiting_human,blocked'`（只看在途），但状态下拉没有对应选项 → React 回落显示第一项「**全部状态**」；同时 `activeFilters` 把它算作 1 个筛选：桌面默认就显示「清除筛选」、移动端按钮显示「筛选 1」却看不出是哪一个。点「清除筛选」后 status 被删掉，列表突然多出已完成/已取消的单，且**再也回不到默认视图**（没有「仅在途」选项）。 | 筛选状态与界面说的不一致；用户会误以为已经在看全部。**证据**：截图 `taskboard-list-responsive--desktop--light.png`（下拉「全部状态」+「清除筛选」，但 V5-107/108 终态单不在）、`--mobile--light.png`（「筛选 1」）。 | P2 |
| **T-05** | `src/components/taskboard/TicketDrawer.tsx:352-360`；`StageSettings.tsx:998-1004`；`TemplateLibrary.tsx:147-153`；`BoardSettingsPanel.tsx:158-164`；`ProjectSettings.tsx:217-225`；`TaskboardView.tsx:862-873`；原语 `src/components/ui/Sheet.tsx:39-83`（shell） | 任务面板的 6 个抽屉全部基于 `Sheet`，**没有任何关闭按钮**。桌面只能点遮罩 / Esc；移动端贴底抽屉 `max-h-[85dvh]`，可点的遮罩只剩顶部 15%，抓握条是纯视觉「不可拖拽」（Sheet.tsx:71-78 注释自述）。 | §5.2「抽屉/弹层在小屏的可关闭性」不达标；触屏没有 Esc。**证据**：`taskboard-ticket-drawer--mobile--light.png`、`taskboard-stage-settings--mobile--light.png` 等所有抽屉截图均无 ×。 | P2 |
| **T-06** | `TaskboardView.tsx:885`（`renderActions(selected, desktop ? 'full' : 'board')`）、`:355-362` | 移动端抽屉把状态操作按 **看板紧凑布局** 渲染：没有 primary 动作的单（如 running）只剩一个无文字的「···」图标按钮，「完成 / 受阻 / 取消」全藏在菜单里；waiting_human 单也只露出「通过」。 | 详情页是用户拍板的主场，主动作却被折叠成一个无标签图标。**证据**：`taskboard-ticket-drawer--mobile--light.png`（正文下方孤零零一个「···」）。 | P2 |
| **T-07** | `TaskboardView.tsx:315-331`、`:283-295`；`src/components/ui/ConfirmDialog.tsx:61-63`（默认 cancelText） | 「取消单据」这个终态操作在抽屉/菜单里的按钮文字只有「**取消**」，与「关闭抽屉/放弃编辑」同词；其确认框底部是 **[取消] [取消单据]** 两个按钮并排。另外「受阻」是状态名词被当动作按钮，而 prompt 标题却写「标记受阻」。 | 破坏性操作的可理解性，误触风险。**证据**：`taskboard-ticket-drawer--desktop--light.png`（红色「取消」按钮）。 | P2 |
| **T-08** | `src/lib/taskboard.ts:37-45`；`BoardColumns.tsx:215`、`:234`；`TaskboardView.tsx:527-543`、`:822-827` | 同一状态多套叫法：`backlog` 在列头/新建表单/空态叫「积压」「先放积压」，卡片徽章和列表叫「**待立项**」；`waiting_human` 列头叫「待确认」，徽章叫「**等我确认**」，操作叫「通过/打回」。 | §5.6 术语不统一，新用户建立不起状态心智。**证据**：`taskboard-board-responsive--desktop--light.png`（「积压」列里的卡片标「待立项」）。 | P2 |
| **T-09** | `src/components/taskboard/TicketCard.tsx:146-189`（执行者 `:164-172`、批准人 `:173-181`）；`TicketListView.tsx:241-251` | 卡片 meta 行把类型/优先级/状态徽章、执行者、批准人、时间、操作全塞进一行 `overflow-hidden`，390px 下执行者截成「codin…」、批准人截成「批…」；看板 288px 列宽下同样「coding-assist…」「批准人 ali…」。 | 移动端和看板上的关键信息不可读。**证据**：`taskboard-list-responsive--mobile--light.png`、`taskboard-board-responsive--desktop--light.png`。 | P2 |
| **T-10** | `TaskboardView.tsx:567-711`；标签 `:631`、`:640`、`:649`、`:653`；`:652` | 移动端首屏：标题行 → 项目下拉 + 4 个图标 → 分区 Tabs → 「列表 / 单据类型」独占一行 → 阶段导航 → 列头，**第一张卡片从 ~430/844px 才开始**；四个图标下的标签是 `text-[10px]`；「看板」标签对应的其实是「护栏设置」。 | 移动端一屏看不到内容；10px 不可读；标签误导。**证据**：`taskboard-board-responsive--mobile--light.png`。 | P2 |
| **T-11** | `BoardColumns.tsx:186-202` | 移动端阶段导航 chip 是裸 `<button>` `min-h-9`（36px），没有走 `Button` 原语的 `[@media(hover:none)]:min-h-11`。 | 触控靶 < 44px（§5.2）。 | P2 |
| **T-12** | `src/components/taskboard/StageSettings.tsx:919`（`key={\`${stage.id}:${dataGen}\`}`）、`:228-230`、`:582`、`:603-620`；`:998-1004` | 任何一次写操作（改名、上/下移、新增阶段、设默认）都 `reload()` → `dataGen++` → **所有已展开的阶段编辑器整体 remount，未保存的草稿全丢**；`StageEditor` 的 `useEffect([stage])` 也会在轮询式重载时重置草稿。抽屉 `onOpenChange={setOpen}` 关闭时没有未保存拦截。 | 20 个字段的长表单编辑到一半，点一下别的阶段的「上移」就归零。 | P2 |
| **T-13** | `TicketListView.tsx:144-151`（搜索）、`:117-124`（标签）；`useTaskboard.ts:476-498` | 搜索 / 标签输入 `onChange` 直接 `onQueryChange` → `applyListQuery` → **每个字符一次 `listTickets` 请求**，无 debounce；虽有 epoch 门控丢弃旧响应，但请求本身全发出去。 | 输入卡顿、后端压力；中文输入法组合期间尤甚。 | P2 |
| **T-14** | `CostStatsView.tsx:105-108`；`WeeklyReportView.tsx:102-104`；`ProjectSettings.tsx:293`、`:297-302`、`:464-472`、`:485-498`、`:534-536`；`StageSettings.tsx:302-305`、`:373-375`；`TicketTimeline.tsx:118-123`；`BoardSettingsPanel.tsx:177-184` | 面向用户的文案里大量开发者术语：「任务看板 tb_project 自身统计，不含模型用量 usage_records」「Cursor / Grok 等路由常把成本记成 0」「默认（OPENCLAUDE_DEFAULT_WORKSPACE / 进程 cwd）」「clone 就绪」「~/.openclaude/projects 不能当 cwd」「version 3 / {"kind":"default"}」「预览注入槽 / project.instructions · 1024B」「Agent 直接改 memory/*.md」「选项来自 GET /api/public/models」「快照 a3f9c1d2e4b5 · 启动 v2。仅审计、不可逐字重放」「参考费用 $1.2345（来源未证实）」。 | §5.6「无开发者术语泄漏」大面积不达标；成本页首句用户读不懂。**证据**：`taskboard-cost-stats--*.png`、`taskboard-project-settings--*.png`、`taskboard-stage-settings--*.png`。 | P2 |
| **T-15** | `TicketCard.tsx:72-100`、`:190-198` | 卡片容器 `role="button" tabIndex=0`，内部又嵌套真实 `<button>`（批准/更多操作），靠 `stopPropagation` 隔离点击；容器没有 accessible name，读屏会把整张卡（编号+标题+徽章+按钮文字）念成一个按钮。 | §5.5 语义：可交互控件嵌套，读屏与键盘用户混乱。 | P2 |
| **T-16** | `BoardColumns.tsx:226-230`、`:245-249`、`:270-274`、`:296-305`（`text-faint`）；`:154-158`；`TaskboardView.tsx:775-780`；`TicketListView.tsx:169-175` | ① 整个项目没有单据时，看板画 6 个大灰框，每框中央一行全站最低对比度的 `text-faint`，没有「新建第一条单据」入口；② 「还没有流水线列」的 hint 说「选一个项目后…」，但项目已选，真正的下一步是「流水线配置 / 套用模板」，没有按钮；③ 「还没有项目」无「新建项目」按钮；④ 项目零单据时列表显示「没有符合筛选的单据 / 换一个类型、状态…」，把空项目说成筛选问题。 | §5.3「空态是否给出下一步」不达标，且空态用了最低对比度。**证据**：`taskboard-empty-columns--*.png`、`taskboard-no-pipeline--*.png`。 | P2 |

### P3

| 编号 | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| **T-17** | `TaskboardView.tsx:672-683`；`TicketListView.tsx:152-164`（`:158`）、`:178-190`（`:188`）；`BoardColumns.tsx:205-212`；`TicketCard.tsx:110-120` | a11y 细节：① `Tabs idBase="taskboard-section"` 未传 `mountedPanels`、也没有任何 `taskboard-section-panel-*` 节点 → 选中 tab 的 `aria-controls` 悬空（Tabs.tsx:90-95 明确要求）；② 移动端「筛选」按钮收起时 `aria-controls` 指向未挂载节点；③ 表格操作列 `<th />` 为空；④ 看板滚动容器 `aria-label` 落在无 role 的 div 上；⑤ 类型图标 `<span aria-label>` 无 role。 | 读屏静默失败 / 冗余。 | P3 |
| **T-18** | `TicketDrawer.tsx:484-510`、`:368-414`、`:26-41` | ① 评论输入框排在「讨论」列表**上方**，先写后看；② 改需求表单四个控件无可见标签（只有 aria-label）；③ 正文 Markdown 的 `h2` 映射到 `text-title`，与单据标题同级甚至更醒目。 | 阅读顺序与层级不顺。**证据**：`taskboard-ticket-drawer--desktop--light.png`、`taskboard-ticket-drawer-edit--*.png`。 | P3 |
| **T-19** | `TaskboardView.tsx:207-210`；`useTaskboard.ts:722-726`；`src/lib/taskboard.ts:810`；`TaskboardView.tsx:341-354` | 版本冲突三套文案：「单据已被改动，请刷新看板后重试」（实际已自动 reconcile）/「单据已被更新，已刷新」/「单据已被其他人更新，已刷新最新内容」。另：一张卡任一操作 pending 时，`renderActions` 给**全部**按钮 `loading={busy}`，所有按钮一起转圈。 | 反馈不精准、文案不一致。 | P3 |
| **T-20** | `TaskboardView.tsx:456`、`:803-859`、`:112`；`src/hooks/useAppRoute.ts:43-44`、`:96`；`useTaskboard.ts:19-20`；`CostStatsView.tsx:47-51`、`:59`、`:64-66`；`WeeklyReportView.tsx:40-44`、`:50`、`:55-57`；`StageSettings.tsx:748-751` vs `:947-951` | 死代码：① `view === 'backlog' / 'inbox'` 两个分支与 `backlogTypeFilter` 状态从 URL 不可达（`parseBoardView` 把它们归一为 `list`，Tabs 也没有入口）；② `pickInitialProject` / `readLastProjectId` 只 import 不用；③ 成本/周报的 `projects` prop 与 `filterProject` 状态从未参与渲染或请求；④ `addStage` 里 `newStageKind === 'ai'` 守卫不可达（下拉已过滤 ai）。旧 ui-preview 场景从未渲染出看板（本轮已修）。 | 维护成本、误导后来者。 | P3 |
| **T-21** | `CostStatsView.tsx:138-140`、`:111-128`、`:151-152`、`:219-234`；`WeeklyReportView.tsx:132`、`:122-131`、`:106-135`、`:88-93` | ① 成本/周报工具栏里再放一个 `ProjectScopeSelect`，与顶栏那个绑定同一全局 scope，一屏两个项目选择器；② 「下一周」对未来周不禁用；③ 移动端「上一周 / 区间 / 下一周」被换行拆散；④ 刷新时无加载指示（只首屏骨架）；⑤ 成本页 StatCard 摆在分桶列表之后；⑥ 起止日期不校验 from > to。 | 打磨项。**证据**：`taskboard-weekly-report--mobile--light.png`、`taskboard-cost-stats--*.png`。 | P3 |
| **T-22** | `BoardSettingsPanel.tsx:199-201`、`:213-215`、`:100-109`、`:232-263`、`:264-284`、`:177-184` | ① 数字输入 `Number(e.target.value)`，清空即变 0；② `circuitBreakerThreshold / maxStageLoops / maxRunsPerTick` 从快照原样回传却没有任何输入项；③ 静默开始 = 结束不校验；④ 红色「急停巡检」紧贴「保存设置」；⑤ 用量行一句话塞 5 个数字。 | 打磨项。**证据**：`taskboard-board-settings--*.png`。 | P3 |
| **T-23** | `ProjectSettings.tsx:386-397`、`:588-601`；`TemplateLibrary.tsx:227-237` | 「归档」红色实心按钮紧贴「保存」；项目记忆「废弃」无二次确认（界面没有反向操作）；模板「删除」有确认（OK）。 | 危险操作位置与确认一致性。 | P3 |
| **T-24** | `BoardColumns.tsx:401-402`、`:279-291`；`TicketCard.tsx:155-163`、`:134-143` | 桌面 6 列固定 288px，1440px 视口下「体验验收」列整个在视口外，只有 12px 渐隐提示；阶段列内卡片仍带与列名重复的状态徽章；紧凑卡标题 `line-clamp-1` 只有 hover `title` 兜底，触屏无从看全。 | 桌面信息密度与可见性。**证据**：`taskboard-board-responsive--desktop--*.png`。 | P3 |
| **T-25** | `StageSettings.tsx:1002`；`TemplateLibrary.tsx:150`；`BoardSettingsPanel.tsx:161-163`；`ProjectSettings.tsx:222-224`（均 `side="right"`）vs `TicketDrawer.tsx:357`、`TaskboardView.tsx:868`（移动端 `bottom`） | 移动端四个配置抽屉是 92–96vw 的右侧抽屉，单据抽屉与新建表单是贴底抽屉；宽度 24rem / 36rem / 92vw / 96vw 各写各的。 | 同一面板内两套移动端弹层范式。 | P3 |
| **T-26** | `TaskboardView.tsx:466-563` | 桌面内联新建表单无标题、无可见字段标签（仅 placeholder），单选用原生 radio（与 Switch/Select 风格不一致）。 | 打磨项。**证据**：`taskboard-create-form--desktop--light.png`。 | P3 |
| **T-27** | `TicketDrawer.tsx:271-279`；`TicketTimeline.tsx:37-42` | 乐观评论的作者写死 `user:default`，提交瞬间显示「default · 人」，服务端返回后才换。 | 闪烁。 | P3 |
| **T-28** | `StageSettings.tsx:787-833`、`:872-916`（`:877-879`）、`:270-517`、`:505-516` | 移动端流水线头行换行（「收起」孤立一行）；阶段行按钮挤得名字只剩「需求…」「开…」；阶段编辑表单 20 个字段无分组，「保存阶段」在最底部且不吸底；新建 AI 阶段要先建人工再改类型（两步）。 | 长表单可用性。**证据**：`taskboard-stage-settings--mobile--light.png`。 | P3 |
| **T-29** | `TicketDrawer.tsx:469-481` | 「回到来源会话」在来源不可用时 `aria-disabled` + 半透明但仍可点，点了才 toast 解释。 | 应真正禁用并用 tooltip 说明。 | P3 |
| **T-30** | `TaskboardView.tsx:121-131`、`:885` | 深链 `?ticket=` 指向的单不在当前已加载列表（翻页之外/其他类型看板）时 `selected` 为 null，抽屉靠 `ticketRef` 自己拉详情能显示，但 `actions` 为 null，**没有任何状态操作**。 | 边界情况功能缺失。 | P3 |

---

## 4. 修复计划（阶段 B）

每条：改哪些文件 / 怎么改 / 补什么测试 / 预计风险。跨归属项已标注。

### T-01 首屏 projects/agents 丢失（P1）
- **文件**：`useTaskboard.ts`、`TaskboardView.tsx`
- **做法**：让「锁定项目」只有一条加载路径。方案：删掉 `TaskboardView.tsx:98-101` 的 `selectProject` effect，把 `lockedProjectId` 的变化完全交给 `useTaskboard` 的 `loadInitial`（它已经以 `initialOwner = lockedProjectIdRef.current` 为准）；`selectProject` 只保留给项目创建/归档后的显式切换。同时把 `loadInitial` 里 `setProjects / setAgents` 提到 `isCurrent()` 守卫**之前**（这两份数据与 epoch 无关，谁先到都可用），并让内层 catch 落到 `setError`（见 T-03）。
- **测试**：新增 vitest「锁定项目后一次加载即出现 `project-edit-open`、执行者下拉含 agent」「`listProjects` 只被 Provider + hook 各调一次、`getProjectBoard` 恰一次」；保留 `boardMove.test.tsx` / `taskboard.test.tsx` 现有用例全绿。
- **风险**：中。`selectProject` 还被 `createProject / archiveProject` 复用，需回归「新建项目自动切换」「归档后切到剩余项目」两条路径。

### T-02 冷启深链/持久化丢失（P1，需 sidebar owner）
- **文件**：`src/hooks/useProjectScope.tsx`（sidebar：fable-5-1-19）
- **做法**：`:153-163` 的回落条件加上「列表已到位」：`if (scope.invalid && !loading && token !== 'all')`；或在 `workProjects` 首次加载完成前不做 invalid 判定（用一个 `hydrated` ref）。阶段 B 开工时 `send_to` sidebar owner 说明「文件 / 改动 / 原因」，taskboard 侧补一条集成测试守住。
- **测试**：`taskboard.test.tsx` 新增「`?project=<work id>` 冷启 → 项目到位后 scope=work、URL 参数保留」；`projectScope.test.ts` 由 owner 补。
- **风险**：低（只推迟一次判定）；但要确认真的失效 token（项目被删）仍会回落。

### T-03 看板接口失败无错误态（P2）
- **文件**：`useTaskboard.ts`、`TaskboardView.tsx`、`BoardColumns.tsx`
- **做法**：`loadInitial` 内层 catch 与 `selectProject` 的 catch 都 `setError(taskboardErrorMessage(e, '加载看板失败'))`，让 `:719-729` 的错误 EmptyState（带重试）成为唯一落点；`BoardColumns` 的「还没有流水线列」文案改为「这个项目还没有 <类型> 流水线」+ 「去配置流水线 / 套用模板」按钮（见 T-16）。
- **测试**：临时用例 A3 反转为正式用例（reject → 出现「任务面板加载失败」与「重试」，点重试重新请求）。
- **风险**：低。

### T-04 默认在途筛选不可见（P2）
- **文件**：`TicketListView.tsx`、`useTaskboard.ts`、`lib/taskboard.ts`
- **做法**：状态下拉加一项「在途（默认）」value=`ACTIVE_LIST_STATUSES`，其余单状态保留，另加「全部（含已完成/取消）」value=`''` 走显式全量；`activeFilters` 不把默认值计入；「清除筛选」恢复为默认在途而不是删掉 status。
- **测试**：vitest：初始渲染下拉显示「在途」、无「清除筛选」；选「全部」后 total 变化；清除后回到在途。
- **风险**：低。注意 `query.status` 逗号串与后端契约不变。

### T-05 抽屉无关闭按钮（P2）
- **文件**：6 个面板文件（不动 `ui/Sheet.tsx`）。可选：`send_to` shell owner 建议给 `Sheet` 加 `closeButton` prop，本模块不等它。
- **做法**：每个抽屉头部 `<h2>` 右侧加 `IconButton aria-label="关闭"`（`X` 图标，`size="sm"`），点击调用各自 `onClose / setOpen(false)`；抽屉正文容器保持 `overflow-y-auto`，头部 `sticky top-0`。
- **测试**：每个面板补一条「点关闭按钮 → 抽屉消失」；`test:browser` 不涉及（非高频交互面）。
- **风险**：低。

### T-06 移动端抽屉主动作折叠（P2）
- **文件**：`TaskboardView.tsx`
- **做法**：抽屉内始终用 `renderActions(selected, 'full')`；移动端用 `flex-wrap` 两行排开，把「移动到…」单独做成一个带文字的 secondary 按钮（DropdownMenu trigger 带「移动到」文字），只在卡片紧凑态保留「···」。
- **测试**：vitest 窄屏（jsdom 默认非 md）下抽屉内可直接找到「完成」「标记受阻」「取消单据」按钮。
- **风险**：低。

### T-07 「取消」歧义（P2）
- **文件**：`TaskboardView.tsx`
- **做法**：按钮文案「取消」→「取消单据」，「受阻」→「标记受阻」；`confirm({...})` 传 `cancelText: '返回'`（或「先不取消」）避免 [取消][取消单据] 并排；「完成」确认框同理。
- **测试**：更新 `taskboard.test.tsx` 中按 name 查询按钮的用例（`ticket-cancel` / `ticket-block` testid 不变）。
- **风险**：低；`browser-tests` 若按文字定位需同步。

### T-08 状态术语统一（P2）
- **文件**：`lib/taskboard.ts`、`BoardColumns.tsx`、`TaskboardView.tsx`
- **做法**：以 `TICKET_STATUS_LABEL` 为唯一权威；决定 `backlog` 统一为「积压」（列头、表单、空态已用它，且更贴合「AI 不碰」的语义），`waiting_human` 统一为「待确认」；列头直接引用 `TICKET_STATUS_LABEL`。先 `ask_decision`（文案拍板，低）。
- **测试**：更新引用旧文案的用例（`taskboard.test.tsx`、`boardMove.test.tsx` 中的「待立项」「等我确认」）。
- **风险**：低，纯文案。

### T-09 卡片 meta 截断（P2）
- **文件**：`TicketCard.tsx`
- **做法**：meta 行改 `flex-wrap`，徽章一组、人员一组（执行者 / 批准人各带图标而不是「批准人 」前缀）、时间与操作靠右独立一行（`showUpdatedAt` 时）；`compact` 态只保留优先级 + 执行者，状态徽章在阶段列里隐藏（T-24）。
- **测试**：ui-preview `taskboard-board-responsive` / `taskboard-list-responsive` mobile 出 after 截图对照；vitest 断言 `ticket-assignee` 文本完整。
- **风险**：低。

### T-10 移动端顶栏密度（P2）
- **文件**：`TaskboardView.tsx`
- **做法**：① 4 个图标按钮收进一个「配置」DropdownMenu（项目 / 流水线 / 模板 / 护栏），移动端顶栏只剩菜单、项目下拉、新建；② 标签 `text-[10px]` 删除（菜单项自带文字）；③ 「列表/看板」切换与「单据类型」并入 Tabs 行右侧，移动端用 `ml-auto` 同行放不下时才换行；④ 「看板」→「护栏」。
- **测试**：after 截图对照（首张卡片顶边应 ≤ 300px）；vitest 菜单内可找到四个入口。
- **风险**：中。`data-testid`（`stage-settings-open` 等）要保留在菜单项上，`taskboard.test.tsx` 大量依赖它们。

### T-11 阶段导航触控靶（P2）
- **文件**：`BoardColumns.tsx`
- **做法**：chip 改用 `Button size="sm" shape="pill" variant={active ? 'accent' : 'secondary'}`，自动获得 `[@media(hover:none)]:min-h-11`。
- **测试**：after 截图；现有 `boardMove.test.tsx` 阶段导航用例回归。
- **风险**：低。

### T-12 阶段编辑草稿丢失（P2）
- **文件**：`StageSettings.tsx`
- **做法**：① `key` 只用 `stage.id`，去掉 `dataGen`；② `StageEditor` 内维护 `dirty`，`useEffect([stage])` 仅在 `!dirty` 或 `stage.updatedAt` 变化且用户确认时重置；③ `runWrite` 只 patch 受影响的 bundle 而非全量 reload；④ 抽屉 `onOpenChange` 在存在 dirty 编辑器时先 `confirm('有未保存的阶段修改，确定关闭？')`。
- **测试**：vitest：展开编辑改名字 → 点另一个阶段「上移」→ 输入框仍是改后的值；关闭抽屉弹确认。
- **风险**：中（reload 局部化要小心 ordinal 重排）。

### T-13 输入即请求（P2）
- **文件**：`TicketListView.tsx`（或 `useTaskboard.applyListQuery`）
- **做法**：搜索/标签输入本地 state 即时显示，`useDebounce(300ms)` 后再 `onQueryChange`；`compositionend` 前不发。
- **测试**：vitest fake timers：连输 3 字符只调 1 次 `listTickets`。
- **风险**：低。

### T-14 开发者术语（P2）
- **文件**：`CostStatsView.tsx`、`WeeklyReportView.tsx`、`ProjectSettings.tsx`、`StageSettings.tsx`、`TicketTimeline.tsx`、`BoardSettingsPanel.tsx`
- **做法**：逐条改写为用户语言，技术细节移到 `title`/折叠「详情」：成本页首句 →「这里只统计任务面板里 agent 执行的用量；部分模型路线不回传单价，金额仅供参考」；工作区选项 →「默认工作区 / 每个项目独立目录 / 指定容器内目录」+ 折叠说明；项目上下文 → 隐藏 `version` 与 JSON，改「工作区：默认」；「预览注入槽」→「预览 agent 将看到的项目信息」；模型 hint 删掉接口路径；run 快照行折叠到「详情」；「来源未证实」→ 沿用 protocol 标签但加 tooltip 解释。文案清单先 `ask_decision`（low）过一遍。
- **测试**：更新按文案查询的用例；`costLegacyFallback.test.tsx` 断言的钉死文案（`UNPRICED_ONLY_COPY` 等，属 protocol 契约）**不改**。
- **风险**：低；注意 `RECORDED_COST_LABELS` 来自 `@openclaude/protocol`，不在本模块改。

### T-15 卡片可交互嵌套（P2）
- **文件**：`TicketCard.tsx`
- **做法**：容器去掉 `role="button"/tabIndex`，改为标题包一层 `<button type="button" className="text-left">`（accessible name = 标题）承载打开动作与键盘；整卡点击仍可用（onClick 保留在容器上但不给语义）；拖拽属性留在容器。
- **测试**：vitest：`getByRole('button', { name: /移动端顶部操作区/ })` 可点开；操作按钮不再位于 button 角色内部（用 `within` 断言）。
- **风险**：低。

### T-16 空态下一步（P2）
- **文件**：`BoardColumns.tsx`、`TaskboardView.tsx`、`TicketListView.tsx`
- **做法**：① 项目零单据（columns 全空 + backlog/inbox 空）时看板整体渲染一个 `EmptyState`「还没有单据」+「新建单据」按钮，不画 6 个空列；单列空文案提到 `text-muted`；② 无流水线 → 「这个项目还没有『问题单』流水线」+「配置流水线」「套用模板」两个按钮（复用现有 open 状态，需把 `open` 提为受控或暴露 ref）；③ 「还没有项目」+「新建项目」按钮；④ 列表：`total === 0 && 无任何筛选` 时改「这个项目还没有单据」。
- **测试**：vitest 各空态文案与按钮存在；after 截图 `taskboard-empty-columns`、`taskboard-no-pipeline`。
- **风险**：低—中（②需要 StageSettings/TemplateLibrary 支持外部打开）。

### T-17 a11y 细节（P3）
- **文件**：`TaskboardView.tsx`、`TicketListView.tsx`、`BoardColumns.tsx`、`TicketCard.tsx`
- **做法**：Tabs 传 `mountedPanels={[sectionView]}` 并给内容容器 `id="taskboard-section-panel-<view>"` `role="tabpanel"`；筛选按钮收起时不落 `aria-controls`（或常挂 `hidden`）；`<th><span className="sr-only">操作</span></th>`；滚动容器加 `role="region"`；图标 span 去掉 `aria-label` 改 `aria-hidden`（类型已由徽章/表格列表达）。
- **测试**：复用 `test/ariaControls.ts` 不变量；vitest `getByRole('tabpanel')`。
- **风险**：低。

### T-18 抽屉结构（P3）
- **文件**：`TicketDrawer.tsx`
- **做法**：评论输入移到讨论列表之后（吸底或紧随）；编辑表单用 `Field label` 包裹；`TicketMarkdown` 里 `h1/h2 → text-section`、`h3 → text-body font-semibold`。
- **测试**：after 截图；`ownerFence*.test.tsx` 回归。
- **风险**：低。

### T-19 冲突文案与忙态（P3）
- **文件**：`TaskboardView.tsx`、`useTaskboard.ts`
- **做法**：三处统一为 `taskboardErrorMessage` 的「单据已被其他人更新，已刷新最新内容」；`renderActions` 记录 `pendingAction` testId，只让被点的按钮 `loading`，其余 `disabled`。
- **测试**：vitest 断言只有一个按钮 `aria-busy`。
- **风险**：低。

### T-20 死代码（P3）
- **文件**：`TaskboardView.tsx`、`useTaskboard.ts`、`CostStatsView.tsx`、`WeeklyReportView.tsx`、`StageSettings.tsx`
- **做法**：删除 `backlog/inbox` 视图分支与 `backlogTypeFilter`（`BoardViewParam` 类型保留兼容由 shell 决定，不动 `useAppRoute.ts`）；删未用 import；删 `projects` prop 与 `filterProject`；删不可达 AI 守卫。
- **测试**：typecheck + 现有用例。
- **风险**：低；`TaskboardView` 的 props 类型若被 App.tsx 引用（`projects` 不是 props，安全）。

### T-21 成本/周报打磨（P3）
- **文件**：`CostStatsView.tsx`、`WeeklyReportView.tsx`
- **做法**：去掉工具栏里的第二个 `ProjectScopeSelect`（顶栏已有）；「下一周」在 `toYmd >= 今天` 时禁用；上一周/区间/下一周包成一个 `shrink-0` 组；刷新时按钮 `loading` 且列表 `aria-busy`；StatCard 移到合计卡之后、分桶之前；`from > to` 时禁用刷新并提示。
- **测试**：vitest 下一周禁用、from>to 提示。
- **风险**：低。

### T-22 护栏设置打磨（P3）
- **文件**：`BoardSettingsPanel.tsx`
- **做法**：数字字段用字符串草稿（同 StageSettings 的做法）保存时再校验；补三个缺失字段的输入（熔断阈值 / 同阶段循环上限 / 每次巡检最多启动数）或明确从 patch 中去掉；静默开始=结束时提示「不静默」；「急停巡检」移到独立「紧急」小节并用 `variant="danger"` 描边而非实心；用量行拆成 `DescriptionList` 三行。
- **测试**：vitest 清空输入不变 0、保存校验。
- **风险**：低。

### T-23 危险操作位置与确认（P3）
- **文件**：`ProjectSettings.tsx`
- **做法**：「归档」移到表单底部独立「危险操作」区（`ml-auto`）；项目记忆「废弃」加 `confirm({ danger: true })`。
- **测试**：vitest 废弃需确认。
- **风险**：低。

### T-24 桌面看板密度（P3）
- **文件**：`BoardColumns.tsx`、`TicketCard.tsx`
- **做法**：列宽 `md:w-[clamp(15rem,calc((100%-5rem)/6),18rem)]` 让 6 列尽量在 1440 内排开，仍溢出时右侧渐隐加宽 + 「→」提示；阶段列内隐藏状态徽章（列名已表达），只对 `blocked` 保留；紧凑卡标题改 `line-clamp-2`。
- **测试**：after 截图。
- **风险**：低。

### T-25 移动端弹层范式统一（P3）
- **文件**：4 个配置抽屉
- **做法**：接受 `desktop` 判定（`useMdViewport`），移动端一律 `side="bottom"`，宽度常量统一到一处（`SHEET_W_WIDE = 'w-[36rem] max-w-[96vw]'`）。
- **测试**：after 截图。
- **风险**：低。

### T-26 新建表单（P3）
- **文件**：`TaskboardView.tsx`
- **做法**：桌面内联表单加标题「新建单据」与 `Field label`；单选改 `SegmentedControl`（ui 已有）；
- **测试**：after 截图；`ticket-create-*` testid 不变。
- **风险**：低。

### T-27 乐观评论作者（P3）
- **文件**：`TicketDrawer.tsx`
- **做法**：从 `auth.snapshot()` / props 取当前用户显示名，没有就显示「我」。
- **测试**：vitest 提交瞬间显示「我 · 人」。
- **风险**：低。

### T-28 流水线配置移动端与长表单（P3）
- **文件**：`StageSettings.tsx`
- **做法**：流水线头行改两行布局（名字 + 徽章 / 按钮组）；阶段行只保留「编辑」与拖柄，上下移收进编辑区；编辑表单分「基础 / 执行 / 巡检 / 流转」四个折叠段，「保存阶段」`sticky bottom-0`；新建阶段允许直接选 AI 并在建后自动展开编辑器。
- **测试**：after 截图；`taskboard.test.tsx` 中 StageSettings 用例回归。
- **风险**：中（结构改动大，分两个 commit）。

### T-29 来源会话按钮（P3）
- **文件**：`TicketDrawer.tsx`
- **做法**：`disabled={!originSessionId}` + `title="来源会话不在当前列表中"`。
- **测试**：vitest disabled 断言。
- **风险**：低。

### T-30 深链单据无操作（P3）
- **文件**：`TaskboardView.tsx`、`TicketDrawer.tsx`
- **做法**：`TicketDrawer` 拉到 `detail` 后通过 `onTicketUpdated` 回灌（已有）→ `replaceTicket` 会把它塞进 `tickets`，`selected` 随之非空；只需确认 `actions` 在 `selected` 变化后重算（现已如此），并在 detail 首次到达时主动调用一次 `onTicketUpdated(fresh.ticket)`（`:158-164` 处补一行）。
- **测试**：vitest 深链一张不在列表里的单 → 抽屉内出现操作按钮。
- **风险**：低。

### 执行顺序建议
1. T-01 → T-03 → T-02（先把数据层竞态与错误态修稳，T-02 同步 `send_to` sidebar owner）
2. T-04 / T-05 / T-06 / T-07 / T-08（列表与抽屉的可理解性）
3. T-10 / T-11 / T-09 / T-16（移动端与空态）
4. T-12 / T-13 / T-14 / T-15
5. P3 按量力顺序，做不完写进「遗留」

---

## 5. 建议不修 / 暂缓项及理由

| 项 | 理由 |
|---|---|
| 触屏拖拽移动单据 | HTML5 DnD 在触屏不可用是平台限制；现有「更多操作 → 移动到…」菜单已是键盘/触屏的等价路径。不引入拖拽库（新增依赖需 `ask_decision`，收益不抵成本）。 |
| `Sheet` 原语加关闭按钮 | shell 归属。本模块在各面板头部自加关闭按钮即可解决 T-05，不阻塞；顺带 `send_to` shell owner 建议原语层提供 `closeButton`。 |
| `cronHuman` 预览把 `*/30 9-19 * * 1-5` 原样回显 | `lib/cron.ts` 属 manage；只影响巡检表达式 hint 的可读性，转告 owner。 |
| `BoardViewParam` 里的 `inbox/backlog` 类型 | `useAppRoute.ts` 属 shell，注释已声明「仅保留旧调用兼容」；本模块只删自己的死分支（T-20）。 |
| `RECORDED_COST_LABELS`「来源未证实」等成本钉死文案 | 来自 `@openclaude/protocol`，`costLegacyFallback.test.tsx` 以它为契约；只在展示层加 tooltip 解释（T-14），不改标签本身。 |
| 60s 轮询改 WebSocket 推送 | 需后端配合，超出本轮范围；轮询 + 可见性触发在个人版可接受。 |
| 列表 200/页与后端上限 | `LIST_PAGE_SIZE` 与 HTTP/DB 上限锁步（`useTaskboard.ts:260-261` 注释），不动。 |
| 成本页图表化 | 属新功能而非缺陷；文本卡片可用。 |
| 存量文件的 biome `format` 差异 | 全部由工作树 `core.autocrlf=true` 的 CRLF 造成，非源码问题；阶段 B 提交时按精确文件 `git add`，git 会在提交时归一为 LF。 |

---

## 6. 修复记录（阶段 B）

- 分支：`feat/v5-selfhost-audit-taskboard`（在阶段 A 的 `6cdb31cdf` 之上）。commit：`42fc60a79` feat(v5) 业务代码 + 测试（21 个文件）、`fe787f009` test(v5) ui-preview 场景、本文档另起一条 docs(v5)。
- 接手说明：修复代码与本节逐条记录由 fable-5-1-23 完成，其会话在提交前掉线（工作树内 23 个文件未提交）；fable-5-1-19 接手 t-43 后未改业务代码，只做复核（typecheck / vitest / biome / 以当前代码全量重拍 after 截图，见 §7.2）、按文件精确 `git add` 分两条提交并推送、补本节与 §7.2。
- 结论：**P1 2 条：1 修复 + 1 转 sidebar owner（跨模块）；P2 14 条全部修复；P3 14 条中 12 条修复、2 条部分修复 / 暂缓**（T-28 部分、T-20 保留 shell 归属的类型）。
- 原则：只改 taskboard 归属文件；`ui/Sheet` 等原语一律不动；所有逻辑改动配 vitest，视觉改动以 after 截图对照。
- 新增文件：`components/taskboard/PanelSheet.tsx`（四个配置抽屉的统一外壳：桌面右侧 / 移动贴底、头部常驻标题 + 关闭、宽度只定义一次）、`components/taskboard/auditFixes.test.tsx`（本轮回归用例，按 T 编号组织）。

### 6.1 逐条记录

| 编号 | 状态 | 改动 | 测试 |
|---|---|---|---|
| **T-01** | 修复 | 删除 `TaskboardView` 里与 `loadInitial` 同 commit 抢跑的 `selectProject(lockedProjectId)` effect，锁定项目只剩 `useTaskboard.loadInitial` 一条加载路径；`loadInitial` 把 `setProjects / setAgents` 提到 `isCurrent()` 守卫之前（只受 `ownsLoading` 约束）；`selectProject` 只留给项目创建 / 归档后的显式切换。 | `auditFixes` T-01：`listProjects` 恰 2 次（Provider + hook）、`getProjectBoard` 恰 1 次、执行者筛选含具名 agent、无需对账即有「管理项目」入口；`taskboard.test` 建项目 / 归档回归。 |
| **T-02** | 转 sidebar | `useProjectScope.tsx:153-163` 归 sidebar；原 owner fable-5-1-19 不在组内，已 `send_to` 指挥官（消息 dm-mu2tr278-b4q8qf）附文件 / 改法 / 测试要求，请其转给 sidebar-B 认领者；换轮后 sidebar-B 由 fable-5-1-25（现任指挥官）持有，接手时已向其重发同一请求（dm-mu2wtqk7-yij14v）。taskboard 侧对照场景 `taskboard-scope-deeplink-reload` 保留，修后应直接画出看板。 | 由 sidebar 侧补 `projectScope` 用例；本轮 after 截图该场景仍为空态（预期，未修）。 |
| **T-03** | 修复 | `loadInitial` 内层 catch 与 `selectProject` 的 catch 都 `setError(taskboardErrorMessage(e, '加载看板失败'))`（后者只在仍是最新请求时），错误落到带「重试」的 EmptyState；`selectProject` 开始时 `setError(null)`。`BoardColumns` 无流水线文案改为「这个项目还没有 <类型> 流水线」+「配置流水线 / 套用模板」按钮。 | `auditFixes` T-03：502 → 「任务面板加载失败」+ 错误详情 + 重试 → 成功后画出看板；`getProjectBoard` 恰 2 次。 |
| **T-04** | 修复 | 状态下拉新增「在途（默认）」（value=`ACTIVE_LIST_STATUSES`）与「全部状态（含已完成 / 已取消）」（value=''）；`countActiveFilters` 不把默认值计入，「全部」计为 1 个筛选；「清除筛选」恢复到默认在途而不是删掉 status。 | `auditFixes` T-04；`taskboard.test` 移动端筛选用例更新（`筛选 2`、清除后带 status）。 |
| **T-05** | 修复 | 单据抽屉顶部常驻 `DrawerBar`（编号 + 关闭 ×，加载中也有）；四个配置抽屉统一走 `PanelSheet`（标题 + 关闭 ×，`*-close` testid）；新建单据贴底抽屉加关闭 ×；桌面内联新建表单加关闭 ×。未动 `ui/Sheet.tsx`。 | `auditFixes`：抽屉关闭回调、`stage-settings-close` / `template-library-close` / `project-edit-close` / `board-settings-close` 均关得掉。 |
| **T-06** | 修复 | 抽屉里 `renderActions(ticket, 'full')`（移动端不再退化成「···」），全部动作平铺成带文字按钮；「移动到…」单独做成带文字的 secondary 按钮（`ticket-move-menu`），紧凑「···」只留在看板 / 列表卡。 | `auditFixes` T-05/06/07：窄屏抽屉直接可见「完成」「取消单据」「标记受阻」，无 `ticket-more-actions`。 |
| **T-07** | 修复 | 「取消」→「取消单据」，「受阻」→「标记受阻」；确认框 `cancelText` 统一为「返回 / 先不移动 / 继续编辑」，不再 [取消][取消单据] 并排；完成确认按钮「标记完成」。 | 同上（断言确认框有「返回」与「取消单据」两个不同按钮）；`boardMove.test` 菜单项文案更新。 |
| **T-08** | 修复 | `TICKET_STATUS_LABEL` 为唯一权威：`backlog`「积压」、`waiting_human`「待确认」；终态改「已完成 / 已取消」，与动作词「完成 / 取消单据」区分（文案拍板：计划已写明取列头那套并经审批，本轮直接落地，见 §6.3）。 | `auditFixes` T-08。 |
| **T-09** | 修复 | `TicketCard` meta 重排：紧凑态只留优先级 + 执行者（带机器人图标，`min-w-0 flex-1` 不再被挤成「codin…」）；卡片态分徽章行 / 人员行（执行者、批准人各带图标 + sr-only 前缀）/ 时间 + 操作行。 | after 截图 `taskboard-board-responsive--*`、`taskboard-list-responsive--mobile--*`；`auditFixes` T-15 断言执行者全文。 |
| **T-10** | 修复 | 移动端顶栏：项目 / 流水线 / 模板 / 护栏四个入口收进一个「配置」DropdownMenu（`taskboard-config-menu`，菜单项保留原 testid），删掉 `text-[10px]` 短标签与误导的「看板」；四个面板改为受控打开（`open/onOpenChange`、`mode/onModeChange`、`hideTrigger`），只挂一份；「列表 / 看板」切换在窄屏只留图标、类型下拉 `w-24`，与 Tabs 同行。首张卡片顶边从 ~430px 提到 ~310px（390×844）。 | `taskboard.test`「窄屏配置入口」：无短标签、菜单五项带完整文字、菜单可开抽屉且抽屉可关；`m4Board.test` 建项目路径改走菜单。新增场景 `taskboard-mobile-config-menu`。 |
| **T-11** | 修复 | 阶段导航 chip 改 `Button size="sm" shape="pill"`，自动获得 `[@media(hover:none)]:min-h-11`。 | `boardMove.test` 阶段导航用例回归；after 截图。 |
| **T-12** | 修复 | `StageEditor` 用 `stage.id` 当 key（去掉 `dataGen`），自己维护 `baseline/dirty`：有未保存修改时重载不重置草稿，服务端另有改动则显示「刚被别处更新过」+「载入最新」；保存成功后采纳下一份服务端数据；`onDirtyChange` 上报给父级，关闭抽屉前有脏编辑器先 confirm（继续编辑 / 放弃修改并关闭）。 | `taskboard.test`：409 后草稿保留 + 载入最新；写操作重载后草稿不丢 + 关闭拦截。 |
| **T-13** | 修复 | 搜索 / 标签输入改本地草稿 + 300ms debounce（`LIST_QUERY_DEBOUNCE_MS`），`compositionstart/end` 期间不发。 | `auditFixes` T-13：连输 3 字符只发 1 次；IME 组合期间不发。 |
| **T-14** | 修复 | 成本 / 周报首句、护栏说明、项目工作区三种选项（「默认工作区 / 每个项目独立目录 / 指定容器内目录」+ 各自 hint）、路径校验文案、项目上下文（不再显示 `version` 与 JSON，注入槽名映射为「项目说明 / 项目记忆 / 实时 git 状态」+ 字节转 KB）、「预览注入槽」→「预览 agent 将看到的项目信息」、项目记忆说明、模型 hint 去掉接口路径、run 快照折叠进「执行时的项目信息快照」。`RECORDED_COST_LABELS` 钉死文案未改。 | `ProjectSettings.test` 更新为新文案且断言无 `cwd / OPENCLAUDE_DEFAULT_WORKSPACE`；`auditFixes` T-14/T-21 断言无 `tb_project / usage_records`。 |
| **T-15** | 修复 | 卡片容器去掉 `role="button"/tabIndex`；标题改为真按钮（accessible name = 标题，`data-drag-through` 让 `beginDrag` 放行）；类型图标 `aria-hidden`，紧凑态补 sr-only 类型文字。 | `auditFixes` T-15；`taskboard.test` 图标断言更新。 |
| **T-16** | 修复 | ① 有流水线、零单据 → 「还没有单据」+「新建第一条单据」，不画 6 个空列；② 无流水线 → 「这个项目还没有 X 流水线」+「配置流水线 / 套用模板」；③ 「还没有项目」+「新建项目」；④ 列表空态分「这个项目还没有单据 / 没有在途的单据 / 没有符合筛选的单据」三种，各给下一步；单列空文案提到 `text-muted`。 | `auditFixes` T-16 四条；after 截图 `taskboard-empty-columns--*`、`taskboard-no-pipeline--*`。 |
| **T-17** | 修复 | Tabs 传 `mountedPanels={[sectionView]}`，内容容器 `id=taskboard-section-panel-<view> role=tabpanel aria-labelledby`；筛选按钮收起时不落 `aria-controls`；表格操作列 `<th>` 补 sr-only「操作」；看板滚动容器改 `<section aria-label>`；类型图标 `aria-hidden`。 | `auditFixes` T-17 两条。 |
| **T-18** | 修复 | 评论输入区移到讨论列表之后（`TicketTimeline` 的 `composer` 插槽）；编辑表单四个控件用 `Field label`；正文 Markdown `h1/h2 → text-section`、`h3 → text-body`（`.prose h2` 是未分层样式，需带 `!`）。 | after 截图 `taskboard-ticket-drawer--*`、`taskboard-ticket-drawer-edit--*`；`ownerFence*.test` 回归。 |
| **T-19** | 修复 | 三处冲突文案统一为 `taskboardErrorMessage` 的「单据已被其他人更新，已刷新最新内容」；`pendingAction` 记录被点的按钮，只有它 `loading`，其余 `disabled`（含「移动到…」）。 | `auditFixes` T-19；`boardMove.test` 冲突文案更新。 |
| **T-20** | 修复（部分） | 删 `backlog / inbox` 视图分支与 `backlogTypeFilter`（旧值归一到列表）；删 `useTaskboard` 未用 import；删 `CostStatsView / WeeklyReportView` 的 `projects / projectId` prop 与 `filterProject`；删 `addStage` 不可达的 AI 守卫。`BoardViewParam` 的 `inbox/backlog` 类型属 shell，不动。 | typecheck；`boardMove.test` 删除依赖死视图的「积压 tab 类型筛选」用例（其覆盖的批准路径由「旧积压视图归到任务入口」用例保留）。 |
| **T-21** | 修复 | 去掉工具栏第二个 `ProjectScopeSelect`；「下一周」在周期已覆盖今天时禁用并 title 说明；上一周 / 区间 / 下一周包成一组；刷新按钮带 `loading`、容器 `aria-busy`；StatCard 移到合计之后、分桶之前；`from > to` 时 Field 报错并禁用刷新（不发请求）。 | `auditFixes` T-14/T-21 两条；`m4Board.test` 周报 / 成本用例回归。 |
| **T-22** | 修复 | 数字字段改字符串草稿（清空不变 0），保存时统一校验；补「每轮巡检最多启动 / 连续失败熔断 / 同一阶段最多打回次数」三个输入；静默开始 = 结束显示「不设静默时段」；「急停巡检」移到独立「紧急」区、描边红而非实心；用量拆成 `DescriptionList` 三行。 | `auditFixes` T-22；`costLegacyFallback.test` 改为断言整块用量。 |
| **T-23** | 修复 | 「归档」移到底部「危险操作」区（描边红）；项目记忆「废弃」加 `confirm({danger:true})`。 | `auditFixes` T-23。 |
| **T-24** | 修复 | 桌面列宽 `md:w-[clamp(14rem,calc((100%_-_5.75rem)/6),18rem)]`，1440 下六列排开；阶段列 / 积压列 / 待确认列内隐藏状态徽章（列名已表达），受阻保留；紧凑卡标题 `line-clamp-2`；右侧渐隐加宽并带「→」。 | after 截图 `taskboard-board-responsive--desktop--*`（「体验验收」列已在视口内）。 |
| **T-25** | 修复 | `PanelSheet` 按 `useMdViewport` 决定 `side`（桌面 right / 移动 bottom），宽度常量 `PANEL_SHEET_WIDTH` 只定义一次；与单据抽屉、新建表单同一范式。 | after 截图各面板 `--mobile--*`。 |
| **T-26** | 修复 | 桌面内联新建表单加标题「新建单据」+ 说明 + 关闭；类型 / 标题 / 正文用 `Field label`；「下一步」改 `SegmentedControl`（radiogroup）。 | `boardMove.test` 新建用例（radio 名称改「先放积压」）；after 截图 `taskboard-create-form--desktop--*`。 |
| **T-27** | 修复 | 乐观评论（`local-` 前缀）作者显示「我 · 人」+「发送中…」，回执到达后换成服务端作者。 | `auditFixes` T-27。 |
| **T-28** | 修复（部分） | 流水线头行拆两行（名字 + 徽章 / 按钮组，「改名」只在名字改动后可用，显示「N 站」）；阶段行名字 `min-w-[8rem]`，按钮组放不下整体换行右对齐；编辑表单分「基础 / 执行 / 巡检 / 流转」四个可折叠分组（执行仅 AI 展开、巡检仅启用时展开），「保存阶段」吸底并显示是否有改动；新建阶段后自动展开编辑。**暂缓**：直接新建 AI 阶段 —— 后端要求 AI 阶段绑定 agent（`buildStagePatch` 同一约束），改为在新建行下方说明两步流程；上 / 下移按钮保留在行内（避免改动 `m4Board.test` 的拖拽排序契约）。 | `taskboard.test` StageSettings 用例回归；after 截图 `taskboard-stage-settings--*`。 |
| **T-29** | 修复 | 「回到来源会话」`disabled={!originUsable}` + `title` 说明（巡检 sessionKey 也算不可用）。 | `taskboard.test` 来源会话用例改为断言 disabled + title。 |
| **T-30** | 修复 | `TicketDrawer` 新增只读回调 `onDetailLoaded`；`TaskboardView` 以 `detailTicket` 兜底算 `actions`（不走 `replaceTicket`，避免读路径 bump epoch 打断首屏加载）。 | `auditFixes` T-30。 |

### 6.2 计划外顺手修的

- `ProjectSettings` 编辑态头部的「新建项目」入口改到 `PanelSheet` 头部右侧（原来在滚动正文里）；桌面铅笔按钮 aria-label 由「编辑项目」统一为「管理项目」。
- 看板「移动到…」在抽屉里可用键盘打开并选择（Radix 菜单），与卡片上的「···」同一套 `runMove`。
- `WeeklyReportView` 失败 run 状态 `timeout / failed` 显示为中文「超时 / 失败」，分区标题「失败 run」→「失败的执行」。

### 6.3 需要指挥官知悉的取舍

- **T-08 文案**：计划写「先 `ask_decision`（低）」。计划本身已写明推荐值（「积压」「待确认」）并经审批，且按 §G 这属于能自行定、错了改一行即可的选择，故直接落地；顺带把终态改为「已完成 / 已取消」以与动作词区分。如需改回，只动 `lib/taskboard.ts` 的 `TICKET_STATUS_LABEL`。
- **T-12 与 409**：以前保存遇冲突 → 重读 → 本地编辑被静默丢掉；现在保留本地草稿并提示「刚被别处更新过，保存会覆盖」+「载入最新」。这是有意的行为变化，对应用例已更新。
- **T-20**：删掉的 `view='backlog'` 分支曾有一条专门用例（按类型筛选积压）；该视图从 URL 不可达（`parseBoardView` 归一为 list），用例随之删除，批准路径由「旧积压视图归到任务入口」用例继续覆盖。
- **存量 biome**：`lib/taskboard.ts` 与 `ProjectSettings.test.tsx` 各有 1 条阶段 A 前就存在的 `organizeImports` 排序提示（未在本轮触碰的 import 行），未改；`ownerFence.review.test.tsx:354` 存量 lint 同前。

---

## 7. 验证（阶段 B）

均在工作树 `d:\code\test_project\test123\wt\taskboard` 内执行。下表为 fable-5-1-23 修复完成时的结果；接手后以提交内容（`42fc60a79` + `fe787f009`）重跑的复核见 §7.2。

| 命令 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ 绿（exit 0） |
| `cd packages/web-react; npx vitest run src/components/taskboard src/lib/taskboardFeature.test.ts --maxWorkers=1` | ✅ **10 files / 124 tests passed**（阶段 A 基线 9 / 101：新增 `auditFixes.test.tsx` 23 条 + `taskboard.test.tsx` 1 条，删除 1 条死视图用例） |
| `npx biome check --formatter-enabled=false <本轮 22 个文件>` | 本轮改动文件 0 条新 lint；剩余 2 条为存量 `organizeImports`（`lib/taskboard.ts:1`、`ProjectSettings.test.tsx:5`，见 §6.3）；`format` 差异同阶段 A（CRLF），提交时由 git 归一 |
| `node browser-tests/ui-preview/shoot.mjs`（`OC_UI_SCENES=taskboard`，`OC_UI_SHOT_DELAY=1600`） | ✅ **17 场景 × desktop/mobile × light/dark = 66 张**，`failures=0`、`unmockedApi=0` |
| `npm run test:browser` | `NOT RUN`：任务面板不在作业手册 §3 列出的高频交互面（Composer / 消息 / 工具卡 / 侧栏）内，本轮未改这些面。 |

### 7.1 after 截图

- 目录：`D:\code\test_project\test123\.audit-tmp\taskboard\after\`（仓库外），命名同 before；新增场景 `taskboard-mobile-config-menu`（仅 mobile）。
- 重点对照（before → after）：
  - `taskboard-board-responsive--desktop`：6 列全部在 1440 视口内；卡片只剩优先级 + 执行者，受阻卡保留角标 + 徽章。
  - `taskboard-board-responsive--mobile`：首张卡片顶边 ~430px → ~310px；顶栏只剩项目下拉 + 「配置」，阶段 chip 为 44px 触控靶。
  - `taskboard-list-responsive--*`：状态下拉显示「在途（默认）」、默认无「清除筛选」；移动卡片人员行完整可读。
  - `taskboard-ticket-drawer--mobile`：顶部关闭 ×，动作平铺为「标记受阻 / 完成 / 取消单据 / 移动到…」，讨论在评论框之前。
  - `taskboard-create-form--desktop`：带标题、字段标签与分段选择。
  - `taskboard-empty-columns--*` / `taskboard-no-pipeline--*` / `taskboard-load-error--*`：三种空态 / 错误态各有下一步按钮。
  - `taskboard-stage-settings--mobile`、`taskboard-board-settings--mobile`、`taskboard-project-settings--mobile`、`taskboard-template-library--mobile`：贴底抽屉 + 关闭按钮 + 用户语言文案。
  - `taskboard-scope-deeplink-reload--*`：仍为空态（T-02 属 sidebar，待其修复后复拍）。

### 7.2 接手复核（fable-5-1-19，09-16 00:45–00:55）

接手时发现 8 个源文件 / 测试 / 场景的最后修改时间（00:36）晚于原 after 截图（00:14–00:20），且 `manifest.json` 只剩最后一批 7 个场景，故以提交内容全量重拍一遍 after，保证截图 = 提交代码。

| 命令 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ exit 0 |
| `cd packages/web-react; npx vitest run src/components/taskboard src/lib/taskboardFeature.test.ts --maxWorkers=1` | ✅ 10 files / 124 tests passed（38.4s） |
| `npx biome check --formatter-enabled=false <本轮 22 个 web-react 文件>` | 0 条新增；仅剩 §6.3 所述 2 条存量 `organizeImports`（`lib/taskboard.ts:1`、`ProjectSettings.test.tsx:5`），本轮未触碰这两行 |
| `node browser-tests/ui-preview/shoot.mjs`（`OC_UI_SCENES=taskboard`、`OC_UI_SHOT_DELAY=1600`，一次跑完） | ✅ 17 场景 × 主题 / 视口 = 66 张，`failures=0`、`retried=0`、`unmockedApi=0`；`manifest.json`（generatedAt 2026-09-15T16:53Z）现覆盖全部 17 场景 |
| `npm run test:browser` | `NOT RUN`，理由同上表 |
| 逐张抽看（Read） | `taskboard-board-responsive--desktop/mobile--light`、`taskboard-ticket-drawer--mobile--light`、`taskboard-load-error--desktop--light`、`taskboard-list-responsive--desktop--light`、`taskboard-mobile-config-menu--mobile--light`、`taskboard-stage-settings--mobile--light`、`taskboard-empty-columns--desktop--dark`：与 §7.1 重点对照描述一致（六列在 1440 内、移动端「配置」菜单、抽屉关闭 × 与平铺动作、错误态带重试、空态带下一步、状态下拉「在途（默认）」） |
| 改动范围 | `git status` 只含 taskboard 归属文件 + `browser-tests/ui-preview/scenes-taskboard.tsx` + 本文档；`packages/cli/src/index.ts`、`packages/mcp-memory/src/index.ts` 为 `npm ci` 行尾假改动（`git diff` 为空），未提交 |

---

## 8. 二期（t-630 · 09-16 · fable-5-1-35）· 遗留 P3 收尾

二期的口径是把「本模块归属内可独立完成、不依赖后端 / shell」的遗留落地。阶段 B 已把 P2 14/14、P3 12/14 修完，剩下的逐条复核如下：**可独立完成的只有 1 项（预览台场景的类型错误），已修；其余 2 项部分修复保持原判**。

| 项 | 二期处置 | 依据 |
|---|---|---|
| `scenes-taskboard.tsx:163` `onSuccess: 'close'` → TS2322（集成① 在 `typecheck:preview` 登记的 2 处既有错误之一） | **✅ 已修**（`cb6629bd1`）：末站闸门改 `onSuccess: 'wait_human'` | `lib/taskboard.ts:78` `ON_SUCCESS_ACTIONS = ['advance','wait_human','stay']`，`'close'` 不在枚举内；该站 `requireHumanAck: true`，语义就是「成功后转待我确认」。验证：`npx tsc -p tsconfig.browser-tests.json`（shell S-19 的配置，noEmit）在本工作树 **exit 0**；`after-2` 重拍 `taskboard-stage-settings` 4 张全部成功（`D:\code\test_project\test123\.audit-tmp\taskboard\after-2\`）。业务代码零改动 |
| T-20 `BoardViewParam` 的 `inbox/backlog` 类型 | ⏸ 保持部分修复 | `hooks/useAppRoute.ts` 归 shell；本模块死分支已在阶段 B 删净，剩余只是 shell 侧的类型收口 |
| T-28 直接新建 AI 阶段 | ⏸ 保持部分修复 | 后端要求 AI 阶段绑定 agent（`buildStagePatch` 同一约束），前端已把两步流程写进新建行说明；单步新建需后端放宽，不在前端范围 |
| T-02 项目范围深链冷启回落 all | ✅ 已由 sidebar-B 修复（`feat/v5-selfhost-audit-sidebar` `ef872e91a`「sidebar 项目范围深链冷启不再误判失效回落 all（taskboard 审计 T-02）」） | 修在 `useProjectScope`（sidebar 归属）；本分支未合入该提交，`taskboard-scope-deeplink-reload` 场景要在 integration 上复拍才会画出看板，建议归档时在 integration 上补一张 |
| §5 暂缓 9 项 | — 全部维持 | 触屏拖拽（平台限制）/ `Sheet` 关闭按钮（shell）/ `cronHuman`（manage）/ `RECORDED_COST_LABELS`（protocol 契约）/ 轮询改推送与列表分页（后端）/ 成本图表（新功能）/ biome format（CRLF），无一在本模块可独立落地 |

顺手清理：接手时工作树里有一次 `tsc` 误发射留下的 753 个未跟踪 `.js`（与 `.ts/.tsx` 同名、同一分钟生成，含 `src/components/taskboard/*.test.js`），会被 vitest 当测试文件重复收集，已按「有同名 TS 源 + 同一分钟 mtime」精确删除，未动任何被跟踪文件；`tsconfig.browser-tests.json`（shell S-19 的副本、noEmit）保留在工作树未提交，集成后由 shell 版本覆盖。

二期新增代码改动 0（仅场景 1 行 + 本节），遗留仍为 2 项部分修复（T-20 shell 类型、T-28 后端约束）。
