# a11y-B · settings / org / manage / market / sidebar 模块内修复（t-894）

- 任务：t-894「a11y-B·settings/org/manage/market/sidebar 模块内修复（t-762）」——把 t-762 横向无障碍走查中归属这五个模块、且**不依赖 shell 令牌/原语改动**的问题逐条落地。
- 分支：`feat/v5-selfhost-audit-a11y-mod-a`，基点 integration `feat/v5-selfhost-ocv5-audit-ux @ c034f05d7465570d7f6800cb23aabe4ae77ea02d`（集成③ 后 HEAD）。
- 执行：fable-5-1-57 起手（before 截图 + 全部代码改动，未提交即掉线），fable-5-1-17 接手核对、补测试 / 漏掉的 import、after 截图与 CDP 复扫、成文提交 · 2026-09-17。
- 依据：`D:\code\test_project\test123\.audit-tmp\a11y\DELIVERABLE.md`（t-762 清单，含 file:line / 复现场景 / 修法）与同目录 `report.md`（227 场景原始扫描汇总）。
- 口径：`TEAM_PLAYBOOK.md` §5 / §6 阶段 B；d-24 独立 worktree、d-26 提交 subject 规范、d-28 before/after 截图台。

## 1. 范围与文件

全部位于 `packages/web-react/src/components/`，均在任务书「允许改动」清单内；未碰 `styles.css`、`components/ui/**`、`App.tsx`、集成分支。

| 模块 | 改动文件 | 对应条目 |
|---|---|---|
| settings / org | `settings/QqBindingCard.tsx`(+test)、`org/MembersTab.tsx`(+test)、`settings/ApiKeysSection.tsx`、`settings/FeedbackTab.tsx`、`org/OrgTopupDialog.tsx`、`settings/UsageTab.tsx` | settings#1 #2 #3 #5 #6 |
| manage | `manage/SkillsPanel.tsx`(+test)、`manage/ProjectSkillOverlay.tsx`(+test)、`manage/SkillOptPanel.tsx`、`manage/CronPanel.tsx`、`manage/IdentityManual.tsx`、`settings/ConnectorsTab.tsx`（manage 连接器页复用的二维码链接） | manage#1 #2 #3 #4 |
| market | `marketplace/ReviewPanel.tsx`(+test)、`marketplace/PublishPanel.tsx`(+test) | market#1 #2 + 计划外 1 条 |
| sidebar | `github/RepoPill.tsx`(+test)、`github/RepoStatusBanner.tsx`、`Sidebar.tsx` | sidebar#1 #2 #4 |

## 2. 方法与证据

1. **before / after 截图**（d-28）：`browser-tests/ui-preview/shoot.mjs`，28 个场景 × desktop/mobile × light/dark = 各 90 张，落在仓库外 `D:\code\test_project\test123\.audit-tmp\a11y-mod-a\{before,after}\`，逐张对照。before 拍于基点 c034f05d7 未改代码时；after 拍于全部改动之后。场景：`manage-connectors-qr-waiting`、`manage-cron*`（7）、`manage-skills*`（7）、`market-publish-list(-mobile)`、`market-review-reject`、`org-center-members`、`org-topup-dialog`、`settings-feedback`、`settings-full-api-access`、`settings-preferences(-locked)`、`settings-usage(-empty)`、`sidebar-mobile-drawer`、`sidebar-repo-banner`。0 失败、0 重试，唯一未打桩 API `listCronChannels` 与 before 一致（`market-publish-list(-mobile)` 4 张在计划外「查看」钮修复后重拍过一次，`after\manifest.json` 记录的是这次补拍）。
2. **CDP 无障碍树复扫**：复用 t-762 的扫描器 `.audit-tmp\a11y\scan.mjs`（`OC_REPO` 指向本 worktree、`OC_A11Y_OUT` 独立目录），对上述 28 个场景 + `manage-skill-workbench-train-draft`（SkillOptPanel 用例折叠）+ `manage-memory*`（IdentityManual 重试钮）共 **40 个场景**跑 `Accessibility.getFullAXTree` 无名控件、aria 引用悬空、目标尺寸（移动 44px）、对比度与 Tab 走查。结果：`.audit-tmp\a11y-mod-a\a11y-after\{results\*.json,report.md,scan.log,scan-2.log}`。
3. **单测**：每条可断言的改动都有 vitest 锚定（可访问名用 testing-library 的 `getByRole(name)` / `toHaveAccessibleDescription` 计算，即 dom-accessibility-api 的名字算法），见 §5。

## 3. 逐条处置表

严重度沿用 t-762。「修法」列为实际落地写法；触控尺寸一律用 `[@media(hover:none)]:min-h-11`（IconButton / Card 既有约定），桌面 hover 可用时零变化。

### P2（6/6 全部落地）

| # | 位置 | 现象（t-762） | 修法 | 复扫证据 |
|---|---|---|---|---|
| settings#1 | `settings/QqBindingCard.tsx` 「主动推送到 QQ」Switch | CDP AX 树 name 为空，读屏只播「开关，已开启」 | 左侧标题 / 说明两行加 `useId` id，Switch `aria-labelledby` + `aria-describedby` 指向它们（不另抄一份文案） | AX 树 `switch name="主动推送到 QQ"`；`ax-unnamed-switch` 从 settings 消失；单测 `findByRole('switch',{name})` + `toHaveAccessibleDescription` |
| settings#2 | `org/MembersTab.tsx` 邀请邮箱 Input | 只有 `placeholder="成员邮箱"`，输入即消失、非可访问名 | `aria-label="成员邮箱"`（与右侧「邀请角色」同款） | `field-placeholder-only` 从 org-center-members 消失；单测 `getByRole('textbox',{name:'成员邮箱'})` 输入后仍可按名取到 |
| settings#3 | `settings/ApiKeysSection.tsx` ApiKeyRow | ①「设置上限 / 上限 N」行内钮触屏 16px 高；② 已禁用密钥整行 `opacity-60`，把仍可操作的开关 / 上限钮与「已停用 / 已用 0 积分」压到 2.35–2.92 | ① 钮 `inline-flex items-center` + 触控档 `min-h-11 px-2`；② 去掉整行 opacity，停用态只降非交互装饰：描边改 `border-dashed border-border-strong`、主名 `text-muted`，控件与状态文字保持实色 | target<44 里 `设置上限 52x15.9` 消失；contrast 里 `已停用 / 已用 0 积分 / efgh5678… 2.35(浅)/2.71(深)` 与 `设置上限 2.92` 全部消失 |
| manage#1 | `manage/SkillsPanel.tsx` 标签「+N」展开钮 | 移动端只有 11.8px 宽 | `inline-flex items-center justify-center px-0.5` + 触控档 `min-h-11 min-w-11` | target<44 里 `button "+1" 11.8x44` 消失（manage-skills-mobile）；单测断言两枚触控类 |
| market#1 | `marketplace/ReviewPanel.tsx` 拒绝理由输入框 | 只有 placeholder，无可访问名；输入后视觉上也没有标签 | 不再走 ui `usePrompt`（它渲染的 Input 无法命名），本地 `useRejectReasonPrompt`：`Modal` + `Field label="拒绝原因" required hint=…` + `Input`，交互与 usePrompt 一致（Enter 提交 / 空白不可提交 / Esc 取消）；弹层标题改「拒绝投稿」、说明文案从「理由」统一为「原因」，单条与批量共用 | AX 树 `textbox name="拒绝原因"`；`field-placeholder-only` 从 market 消失；单测：可见 label、`aria-required`、描述、空白禁提交、trim 后原样送 `adminMarketplaceReview(auth,"1","reject",…)`；after 截图 `market-review-reject--*` 可见常驻标签与说明 |
| sidebar#1 | `github/RepoPill.tsx` owner / 分支 / 状态段 | `opacity-70/80`，accent 字压在 accent-soft 底上浅色 2.70 / 深色 3.62 | 去 opacity，改 `text-muted` 实色分层（仓库名保持 accent 加粗） | contrast 里 `dream-star-end/ 2.70` 消失；单测断言 owner / 分支段 `text-muted` 且无 `opacity-*`；after 截图 `sidebar-repo-banner--desktop--light` 可见 owner 段变实色灰 |

### P3（8/8 每条有处置）

| # | 位置 | 现象 | 处置 | 复扫证据 |
|---|---|---|---|---|
| manage#2 | `manage/ProjectSkillOverlay.tsx`、`manage/SkillOptPanel.tsx`(EvalResultView) | 折叠态 `aria-controls` 指向未渲染节点 | 已修：`aria-controls={open ? id : undefined}`（照 SkillsPanel 既有写法） | `aria-ref-dangling` 在 manage-skills-workscope / manage-skill-workbench-train-draft 均消失；ProjectSkillOverlay 新增单测（折叠无属性、展开后 IDREF 可解析，`expectAriaControlsResolvable`） |
| manage#3 | `manage/CronPanel.tsx` Cron 表达式 Tooltip 触发 span | 可聚焦却无 role，读屏只听一段文字；触控高 18px | 已修：`role="note"` + `inline-flex items-center` + 触控档 `min-h-11`；aria-label 仍带人话 + 原串 | 移动端该 span 44px 高；扫描器现把它归到 `click-focusable-no-key-handler`——那是 Radix Tooltip 触发器自带的内部 onClick（点击收起气泡），不是用户操作，键盘用户聚焦即出提示，不再处理 |
| manage#4 | `manage/IdentityManual.tsx` 「重试」link 钮；`settings/ConnectorsTab.tsx` 「单独打开二维码」链接 | 26px 宽 / 18px 高 | 已修：重试钮触控档 `min-h-11 min-w-11`（`h-auto` 之前压掉了 Button 自带的触屏 min-h）；二维码链接 `min-h-11` + 补焦点环 | target<44 里 `重试读取本实例运行手册 26x44`（manage-memory）与二维码链接（manage-connectors-qr-waiting）均消失 |
| market#2 | `marketplace/PublishPanel.tsx` 「我的发布」折叠钮 | `aria-controls="my-publishes-list"` 悬空 | 已修：`aria-controls={isOpen ? "my-publishes-list" : undefined}`；新增单测覆盖折叠 / 展开两态 | `aria-ref-dangling` 从 market 消失 |
| settings#5 | `ApiKeysSection.tsx` 四组 FAQ `<summary>`；`settings/FeedbackTab.tsx` 类别 chip；`org/OrgTopupDialog.tsx` 金额 chip；`settings/UsageTab.tsx` 「含组队 N 积分」钮 | 触屏 16 / 32 / 28 / 22px 高 | 已修：统一触控档 `min-h-11`（summary 另加 `py-2`，抽成 `FAQ_SUMMARY_CLASS`；UsageTab 钮加 `px-3`） | settings-feedback / org-topup-dialog / settings-usage 的 target<44 归零；FAQ summary 四条从 settings-full-api-access 消失 |
| settings#6 | `ApiKeysSection.tsx` 深色「已禁用」黄徽章 3.32 | warning 前景压 warning-soft 再叠行级 opacity | 已修：改用 `Badge tone="warning" size="sm"` 原语 + 去掉行级 opacity（同 settings#3②） | 深色 3.32 消失；浅色现为 Badge 原语的 4.5（`ratio=4.5 need=4.5`，与全站 Badge 一致，属 shell#3 soft 底系列，由 a11y-shell 处理） |
| sidebar#2 | `github/RepoStatusBanner.tsx` 状态词与 git 错误原文 | `opacity-80`，浅色 3.13–3.43 | 已修：去 opacity，用容器实色 | 状态词 / 错误原文从 3.13–3.43 提到 4.31–4.34；剩余差距是 success / danger 前景压 soft 底的 token 问题（t-762 shell#3 原数 4.34 / 4.31），由 a11y-shell 处理 |
| sidebar#4 | `Sidebar.tsx` 移动抽屉空态「新建会话」文字钮、「多选」 | 16px 高 / 38px 宽 | 已修：「新建会话」`inline-flex items-center` + 触控档 `min-h-11 px-2`；「多选」补触控档 `min-w-11` | sidebar-mobile-drawer 的 target<44 归零 |

### 计划外顺手修（1 条，PLAYBOOK §6 B「小的顺手修并记录」）

| 位置 | 现象 | 处置 |
|---|---|---|
| `marketplace/PublishPanel.tsx` SubmitBar「还差 N 项必填 · 查看」的「查看」钮 | 复扫 market-publish-list-mobile 见 22×15.9px（K-21 折叠播报在 t-762 扫描之后才合入，故清单里没有） | 触控档 `min-h-11 px-2` + `inline-flex items-center`，桌面零变化 |

## 4. 复扫残留（均不在本条范围，逐项归属）

after 扫描 40 场景仍列出的问题，全部核对过来源：

- **shell 令牌 / 原语（→ a11y-shell t-893）**：Switch 44×24 触控高（shell#9，settings/org/manage 各处 Switch）；「升级到 Max」深色白字压 accent 2.82（shell#1）；Badge / StatusChip soft 底 4.49–4.5（shell#3：已暂停 / 已禁用 / 已达上限 / 余额不足 / 审核中 / 未通过 / 本实例运行手册 / RepoPill 仓库名 accent 4.35 / RepoStatusBanner success·danger 4.31–4.34）；`--faint` 灰底 3.87–4.21（shell#4：SessionRow 时长、侧栏搜索 placeholder）；TimeAgo `click-not-focusable`（shell#6）。
- **disabled 控件对比度**（发送邀请 / 创建 / 创建任务 / 保存 / 拒绝 / 发起充值 3.35–3.44）：WCAG 1.4.3 对禁用控件不作要求，t-762 亦未列为问题。
- **`control-unnamed` 两枚 Switch**（manage-skills-workscope-open 的 `project-skill-zsxq-publish`、settings-preferences 的一枚）：与 t-762 原报告 L240 / L446 完全相同，为页内自算名字算法对「`<label>` 包裹」的误报，CDP AX 树同场景 `ax:0`，t-762 已核实为通过项。
- **其他既有项**（非 t-762 清单）：SkillRow 卡片 41.5px、PreferencesTab「查看优化建议」32px、「我的发布」折叠钮 42px——均差 2–3px 且不在任务书内，不动。

## 5. 验证

| 项 | 命令 / 方式 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | 绿（接手时 ProjectSkillOverlay.test 漏 import `expectAriaControlsResolvable` 报 2 处 TS2304，已补） |
| 改动文件单测 | `npx vitest run` ProjectSkillOverlay / SkillsPanel / PublishPanel / ReviewPanel（4 文件 52 例）+ QqBindingCard / MembersTab / RepoPill（3 文件 11 例） | 全绿；新增 3 个用例、4 处断言 |
| 模块单测 | `npx vitest run src/components/{settings,org,manage,marketplace,github,sidebar} + Sidebar/SettingsCenter/OrgCenter/ManageCenter/MarketplaceCenter.test.tsx --maxWorkers=2` | 45 文件 / 613 例全绿，152s（`.audit-tmp\a11y-mod-a\vitest-modules.log`） |
| 代码风格 | `npx biome lint --max-diagnostics=500 <改动文件>` 与主克隆同 HEAD 对比 | 诊断集合完全一致（15 = 15），0 新增；`format` 差异为全仓既有（CRLF / 引号风格），基线同样报出 |
| 截图 | 28 场景 before / after 各 90 张 | 0 失败；关键对照：`sidebar-repo-banner--desktop--light`（owner/分支实色）、`market-review-reject--desktop--light`（常驻标签「拒绝原因 *」+ 说明）、`manage-skills-mobile--mobile--light`（「+1」命中区变宽）、`settings-full-api-access--desktop--dark`（停用行不再整体发灰、徽章走 Badge） |
| CDP 复扫 | `scan.mjs` 40 场景 | `ax` 无名控件 0 / 0 场景；`aria-ref-dangling` 0；Tab 走查 0 逃逸 0 缺焦点环；本条列出的 target<44 / contrast 条目全部消失（详见 §3 证据列） |
| test:browser | — | NOT RUN：未碰 Composer / 消息 / 工具卡 / 侧栏交互面（Sidebar 只改两枚按钮的触控类），任务书允许 |
| 真机 iOS / 读屏 | — | NOT RUN：本机无设备；可访问名以 CDP AX 树 + testing-library 名字算法双重核实 |

## 6. 遗留与交棒

- 本条 14 项 + 计划外 1 项全部关闭，无遗留。
- §4 中 shell 归属项已由 a11y-shell（t-893）在 `feat/v5-selfhost-audit-a11y-shell` 处理（shell#1/#6/#7/#8/#9/#10/#11 已见提交），shell#3 / #4 以其交付为准；合入后建议对 `sidebar-repo-banner`、`settings-full-api-access`、`org-center-members` 三个场景复扫一次确认 Badge / RepoStatusBanner 的 4.3–4.5 归零。
- `usePrompt`（`components/ui`）本身仍无法给输入框命名——若 shell 侧日后给它加 `label` 参数，ReviewPanel 的 `useRejectReasonPrompt` 可删掉换回。
