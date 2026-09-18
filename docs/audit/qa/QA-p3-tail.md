# QA · 二期 P3 收尾复核（market2 / manage2 / sidebar2 / settings2）

> 任务 t-1028 · 角色：测试 / QA（第二双眼睛）· 复核人：fable-5-1-23 · 2026-09-17
> 被复核对象：t-625 market2（`feat/v5-selfhost-audit-market@5391c150a`）、t-626 manage2（`…-manage@6fae01440`）、
> t-627 sidebar2（`…-sidebar@25c775295`）、t-628 settings2（`…-settings@5eac1b807`）。
> 复核基线：integration `feat/v5-selfhost-ocv5-audit-ux @ c034f05d7`（四条均已合入：sidebar2 在集成②，其余三条在集成③ 1/6、4/6、5/6），
> 工作树 `wt\qa-p3`（分支 `feat/v5-selfhost-audit-qa-p3`，从 `c034f05d7` 切出，独立 `npm ci`）。
> 证据目录（仓库外，PNG / 日志不入库）：`D:\code\test_project\test123\.audit-tmp\qa-p3\`（`shots\` 126 张、`vitest-*.log`、`typecheck*.log`、`biome-*.log`、`shoot.log`、`test-browser.log`）。

## 0. 结论

| 任务 | 核对项 | ✅ | ❌ | 结论 |
|---|---|---|---|---|
| t-625 market2 | 10 条 P3 落地 + 3 条保持遗留 + 验证门 | 13 | 0 | **通过** |
| t-626 manage2 | §9 遗留 5 条处置 + X-03 + 验证门 | 6 | 0 | **通过** |
| t-627 sidebar2 | §6.2 遗留 6 条处置 + RepoPill 顺手项 + shell 接线闭环 + 验证门 | 7 | 0 | **通过** |
| t-628 settings2 | 遗留表 11 项处置（4 项落地）+ 验证门 | 11 | 0 | **通过** |

- **❌ 项：0**。四条交付声称的代码改动、用例、场景文件在 integration HEAD 上**全部存在且行为与文档一致**；四个模块单测、typecheck、typecheck:preview、`test:browser` 在合并后的 integration 上复跑全绿（`test:browser` 的 3 条 `node --test` 失败与基线 `210b9967` 记录逐条相同，见 §5）。
- **观察项（P3 nit，不阻断，不改代码）：2 条**，都属 a11y-B 的清扫范围，已在 §6 写明改法，转 `a11y-mod-a`（settings / market 归属）。QA 未动业务文件，避免与待领的 a11y-B 三条撞文件。

复核方法：① 读四份审计正文的二期章节，把每条声称的改动定位到 integration 上的代码行；② 用 `git blame` 判定 biome 诊断是否由二期提交引入；③ 复跑各模块单测 / 全包 typecheck / 预览台类型检查 / 真浏览器门；④ 用 `browser-tests/ui-preview` 出 45 场景 × desktop/mobile × light/dark 截图，用 Read 逐张看关键场景；⑤ 对纯函数 `cronHuman` 另跑 23 组边界探针（`.audit-tmp\qa-p3\cron-probe.mjs`，仓库外）。

## 1. t-625 · market2（遗留 P3 收尾）

验收标准（据任务书与 `docs/audit/market.md` §10）：任务书列出的 10 条 P3（K-08/09/22/10/12/13/14/15/19/21）全部落地并配用例；K-23 按任务书保持不做；K-25 / K-27 保持遗留并写明原因；typecheck / 模块单测 / biome 不新增 / before-after 截图。

| 核对项 | 结论 | 证据 | 处置 |
|---|---|---|---|
| K-08 只剩「卸载」一个动作的行不再占 `CardRow` 操作槽，垃圾桶并进 meta 行右侧 | ✅ | 代码 `src/components/marketplace/InstalledPanel.tsx:297-299`（`uninstallOnly`）、`:347`（`ml-auto` 挂 meta 行）、`:355`（`actions` 置 `undefined`）；图 `shots\market-installed--desktop--light.png`「编程助手 Pro」行右侧只剩垃圾桶、无空操作槽；`market-installed-mobile--mobile--light.png` 窄屏同；用例 `InstalledPanel.test.tsx:123` | — |
| K-09 智能体就绪状态收成一枚徽章 + 一句注脚 | ✅ | `InstalledPanel.tsx:85-119` `agentReadinessSummary`（必需项定就绪、可选项作补充；`ready=false` 且无必需待办时退回 `items.length - readyCount` 兜底）；图 desktop：「科研调研员」→「必需能力已就绪 · 1 项可选 Plugin 待授权」+「1/2 项组合能力就绪」，「编程助手 Pro」→「1 项必需能力未就绪」；用例 `InstalledPanel.test.tsx:206` `test.each` ×3 | — |
| K-22 删与分组同名的 kind 徽章，slug 改 meta 行等宽小字（连接器行同步） | ✅ | `InstalledPanel.tsx:326-346`、连接器行 `:566`；图 desktop 各行无「智能体 / 技能」徽章，`research-scout` / `ppt-master` 等为等宽小字；用例 `InstalledPanel.test.tsx:86` | — |
| K-10 发布页「从我的技能导入」芯片用展示名，slug 进 aria-label / title；导入确认框同口径 | ✅ | `PublishPanel.tsx:29`（import `skillDisplayTitle`）、`:1156-1176`（芯片）、`:944`（确认框 `shownName`）；图 `market-publish-validation--mobile--light.png` 芯片为「PPT 一键成稿 / 周报生成器 / 三段式纪要 / SQL 慢查询优化 / 小红书母婴号每日长图」；用例 `PublishPanel.test.tsx:396` | — |
| K-12 桌面端分类筛选片换行不横滚，右缘渐隐仅移动端 | ✅ | `BrowsePanel.tsx:636`（`sm:flex-wrap sm:snap-none sm:overflow-x-visible`）、`:654`（渐隐 `sm:hidden`）、`:633`（aria-label「市场分类」）；图 `market-browse-skill--desktop--light.png` 九个分类片两行全可见、「未分类」落第二行、无渐隐；`--mobile--light.png` 仍横滚；用例 `BrowsePanel.test.tsx:98` | 见 §6 观察项 1（桌面端 `tabIndex=0` 多一个 Tab 停靠点，P3 nit，转 a11y-mod-a） |
| K-13 kill-switch 窄屏默认折叠成一行，`sm` 起全展开；slug 输入 placeholder 人话 | ✅ | `ReviewPanel.tsx:839-913` `RevokeBox`（`mobileOpen` + `aria-expanded` / `aria-controls={bodyId}`，正文 `max-sm:hidden`，切换钮 `sm:hidden`；正文常驻 DOM，IDREF 不悬空）、`:928` placeholder；图 `market-review-mobile--mobile--light.png` 折成「紧急下架已上架条目（kill-switch） 展开」一行，待审队列进首屏；`market-review--desktop--light.png` 全展开、无切换钮；用例 `ReviewPanel.test.tsx:275` | — |
| K-14 审核背书徽章解释 title → Tooltip（可聚焦触发器）+ 明文注脚；评分 / 实测徽章重复 title 撤掉；ReviewPanel「带 evals」「自报增益存疑」同 | ✅ | `DetailModal.tsx:885-897`（Tooltip + `tabIndex={0}`）、`:939-942`（注脚）、`:927-933`（评分徽章仅 `aria-label`，无 `title`）；图 `market-detail-plugin--desktop--light.png` 徽章行下「人工审核：已通过平台危险模式扫描与管理员人工审核。」；用例 `DetailModal.test.tsx:546`、`ReviewPanel.test.tsx:302` | — |
| K-15 「详细介绍」Markdown 标题层级不倒挂 | ✅ | `DetailModal.tsx:46-47` `HUMAN_MD_PROSE_CLASS`（Tailwind v4 `!` 后缀语法，`package.json` `tailwindcss ^4.3.0`，写法正确）、`:976-982` 容器；图 `market-detail-plugin--desktop--light.png`「它适合谁 / 授权范围」与段标题「详细介绍」同档、正文回到 text-body；用例 `DetailModal.test.tsx:567` | — |
| K-19 API 插件契约人话（authMode / 动作 id / effect） | ✅ | `src/lib/marketplace.ts:234-270`（`connectorAuthModeLabel` 九种映射、未知原样；`connectorActionLabel` 驼峰 / 下划线 / 点号拆词；`connectorActionEffectLabel` 未知按「写入」保守）、`DetailModal.tsx:1011-1028`；图 `market-detail-plugin--desktop--light.png`「认证方式：OAuth 授权登录」「search pages · 读取」「create page · 写入」；用例 `marketplace.test.ts:264` ×3、`DetailModal.test.tsx:581` | — |
| K-21 底栏缺项 > 3 折成「还差 N 项必填 · 查看」 | ✅ | `PublishPanel.tsx:291-371` `SubmitBar`（`MISSING_INLINE_MAX = 3`，`aria-expanded` 双态，可「收起」）；图 `market-publish-validation--mobile--light.png` 底栏「还差 6 项必填 · 查看」+ 失败原因共两行；用例 `PublishPanel.test.tsx:410` | — |
| K-23 保持不做（任务书明示） | ✅ | `market.md` §9 / §10 均写明依据（「已安装页是卸载唯一权威」既有决定） | — |
| K-25 / K-27 保持遗留并写明原因 | ✅ | `market.md` §9：需后端 offset / 需 shell Checkbox 原语 | — |
| 预览台场景 `market-detail-plugin` 随代码提交 | ✅ | `browser-tests/ui-preview/scenes-market-audit.tsx`（`git diff --name-only 1fb99bfcc 5391c150a` 含之）；本轮 shoot 出图 4 张、`failures: []` | — |

验证门复跑（integration 合并后）：模块单测 `npx vitest run src/components/marketplace src/components/MarketplaceCenter.test.tsx src/lib/marketplace.test.ts --maxWorkers=1` → **11 文件 / 152 例全绿**（与交付记录 152 一致；`vitest-market.log`）。biome：14 个改动文件 31 条诊断全部 `git blame` 到二期之前的提交（`7e20ef3c9` / `87d2e2024` / `fde553926` / `cdc11eb50` / `c7d6f87bf` / `ef47f8391`），**二期新增 0**（`biome-github.log` + §5 blame 表）。

## 2. t-626 · manage2（遗留 P3 收尾）

验收标准（据 `docs/audit/manage.md` §10）：§9 遗留表逐条处置——本模块归属内、不依赖后端 / shell 的项落地并配用例，其余保持遗留写明原因；跨模块转来的 X-03 落地；typecheck / 模块单测 / biome 不新增 / after 截图。

| 核对项 | 结论 | 证据 | 处置 |
|---|---|---|---|
| M-09 / M-18 / M-20 / M-21（`ConnectorsTab.tsx`）状态回指补丁①，manage 侧不重做 | ✅ | 补丁① `138accab4` 已在 integration；settings 模块单测含 `ConnectorsTab.test.tsx` 全绿（`vitest-settings.log`）；`manage.md` §10.1 只做状态回指、无重复改动（`git diff --name-only af79d7b05 6fae01440` 不含 `ConnectorsTab`） | — |
| M-12 余量：`SkillOptPanel.tsx` 用户可见文案全角化 | ✅ | 提交 `0a47b4948`；图 `shots\manage-skill-workbench-evals--desktop--light.png` hint「每行一条，例如：输出为英文且信息无遗漏 / 保留原文数字与单位」全角；`manage-skill-workbench-train-draft--desktop--light.png` 同批；用例 `SkillOptPanel.test.tsx` 17 例（含 4 处精确匹配同步）随 manage 套件绿 | — |
| M-17 导出 / 详情 保持遗留（需后端） | ✅ | `manage.md` §10.1 / §10.4 写明缺作者 / 年份 / 单文档接口 | — |
| X-01 作用域重置竞态 回指 integration（taskboard T-02） | ✅ | `src/hooks/useProjectScope.tsx` `hydrated` 已在 integration；`useProjectScope.test.tsx` 随 sidebar 套件绿（`vitest-sidebar.log`） | — |
| M-06 ③ `SkillSummary.sensitive` 保持遗留（需后端） | ✅ | `manage.md` §10.1 / §10.4；前端 `isSecretSkill` 兜底在 | — |
| X-03 `cronHuman` 支持周 / 时区间，巡检排程不再原样回显 | ✅ | `src/lib/cron.ts:33-39` `parseRange`（倒序 / 越界 → null）、`:47-60` `dowHuman`（区间 + 逗号混排）、`:77-100`（时段 × 分位形态）、`:106`（日与周同时限定回退原串）；图 `shots\manage-cron-range--desktop--light.png`「工作日巡检」读作「每周一至五 9–19 点每 30 分钟」；用例 `cron.test.ts:20-27` 等；**QA 边界探针 23 组**（`.audit-tmp\qa-p3\cron-probe.mjs`）：`0 9 * * 1-3,6`→「每周一至三、六 09:00」、`0 9-18 * * *`→「每天 9–18 点每小时第 0 分」、倒序 `5-1` / 越界 `7` `9-24` / 空档 `1-5,` `1,,3` / 单点区间 `9-9` / 日周同限 `0 9 1 * 1-5` / 分位列表 `0,30 9-18` **均回退原串不臆测**，既有形态（`每天 09:00` / `每月1日 09:00` / `6月15日 09:00` / `每天 每小时第 30 分`）输出不变 | — |

验证门复跑：`npx vitest run src/components/manage src/components/ManageCenter.test.tsx src/lib/cron.test.ts src/lib/connectors.test.ts src/lib/skillRunCost.test.ts src/lib/skillTrainReentry.test.ts --maxWorkers=1` → **17 文件 / 214 例全绿**（交付记录 212；+2 为合并后的 integration 既有用例，无失败；`vitest-manage.log`）。biome：`SkillOptPanel.tsx:247/321/333` 共 9 条 `useExhaustiveDependencies` 全部 blame 到 `b884fd42e` / `3033be96e`（二期前），`cron.ts` / `cron.test.ts` / `scenes-manage-audit.tsx` 0 条。

## 3. t-627 · sidebar2（遗留 P3 收尾）

验收标准（据 `docs/audit/sidebar.md` §8）：§6.2 遗留表逐条处置，sidebar 归属内可独立完成的项落地并配用例；跨模块项写明接线；顺手承接的 RepoPill 截断配用例；typecheck / 模块单测 / biome 不新增 / `test:browser` / after 截图。

| 核对项 | 结论 | 证据 | 处置 |
|---|---|---|---|
| S-14 无余额时账号副标题不再写死「多模型 · 计量计费」：有邮箱显邮箱、没有不渲染；有余额行为不变；账号菜单头部同规则 | ✅ | `src/components/Sidebar.tsx:543` `accountSubtitle`、`:559-570`（底栏 chip 三态）、`:1043-1047`（菜单头部）；图 `shots\sidebar-empty--desktop--light.png` 底栏「审计预览」下无副标题（场景用户无邮箱）；`sidebar-overview--desktop--light.png` 有余额时仍「余额 123.4万 …」；用例 `Sidebar.test.tsx:1591` describe「Sidebar S-14 无余额时的账号副标题」 | — |
| S-05 键盘调宽 App 接线 | ✅ 已闭环（integration） | `src/App.tsx:3355` `onResizeKeyDown: sidebarWidth.onResizeKeyDown`；`Sidebar.tsx:840-841` 把手 `tabIndex` / `onKeyDown` | 二期文档标「保持遗留、已登记集成②」，实际集成① `678fe9d38` 已接，无需再动 |
| S-06 抽屉关闭按钮读屏名 App 接线 | ✅ 已闭环（integration） | `App.tsx:3457` `collapseLabel="关闭导航"`；`Sidebar.tsx:865-866` | 同上 |
| UUS-01 通知落点 App 接线 | ✅ 已闭环（integration） | `App.tsx:724` `onNotificationOpen: selectSession`；`hooks/useUnreadSessions.ts:154-158, 292` | 同上 |
| ST-01 `useChatSocket` 空标题「新会话」→「新对话」 | ✅ 已闭环（integration） | `src/hooks/useChatSocket.ts:12, 526` 引用 `EMPTY_SESSION_TITLE`（`lib/sessionTitle.ts:6` = 「新对话」）；`src/` 下再无「新会话」字面量（grep） | 集成① `09d15400f` 已改 |
| `browser-tests/run.mjs` T41 断言 | ✅ | 本轮 `test:browser` T41「Codex 密度 token」ok（`test-browser.log`） | — |
| 顺手承接：`RepoPill` 未绑定态文案可收缩 | ✅ | `src/components/github/RepoPill.tsx:86` `min-w-0 truncate`（已绑定态 `:68` 同）；图 `shots\sidebar-repo-banner--mobile--light.png` REPOPILL 四态正常、未绑定 pill 完整显示；`sidebar-github-unlinked--desktop--light.png`；用例 `github/RepoPill.test.tsx` 2 例（随 sidebar 套件绿） | — |

验证门复跑：模块单测（`Sidebar` / `components/sidebar` / `ProjectSettingsDialog` / `ProjectAssetsPanel` / `InboxDialog` / `SessionStatusDot` / `components/github` / `useSessionList` / `useChatProjects` / `useSidebarWidth` / `useUnreadSessions` / `useRepoBinding` / `useProjectAssets` / `useProjectScope` / `useInbox` / `useDelayedConnBanner` / `sessionTitle` / `github` / `projectScope` / `sessionStatus` / `inboxLevels` / `sidebarCollapsed`，`--maxWorkers=1`）→ **23 文件 / 295 例全绿**（交付记录 22 / 290；多出的是本轮多纳入的 `useInbox` / `useDelayedConnBanner`；`vitest-sidebar.log`）。biome：`Sidebar.test.tsx:938 noDelete` blame `74e8df293`（阶段 B 前），`Sidebar.tsx` / `RepoPill.tsx` / `RepoPill.test.tsx` 0 条。`test:browser`：见 §5，侧栏相关 T25 / T41 / T43 ok。

## 4. t-628 · settings2（遗留 P3 收尾）

验收标准（据 `docs/audit/settings.md` §9）：§5 + §6.3 合成的遗留表 11 项逐条处置；本模块归属内、不依赖后端 / shell 可独立完成的项全部落地并配用例（≥ 80%）；其余写明归属；typecheck / 模块单测 / biome 不新增 / after 截图。

| 核对项 | 结论 | 证据 | 处置 |
|---|---|---|---|
| SET-42 ② 关于页「检查更新」：`fetchServerBuild()` no-store 拉 `/` 抠 `<meta name="oc-build">` 比对；同 → 已是最新；不同 → 「立即刷新」走 `appUpdate.reloadNow()`；失败 / 读不到各有说明；无构建号整行不渲染；不改 shell 文件 | ✅ | `src/components/SettingsCenter.tsx:508-523`（正则兼容两种属性顺序）、`:539-598` `UpdateCheckRow`（`alive` ref 防卸载后 setState；`checking` 时按钮 disabled）、`:645`；**生产链路核对**：`vite.config.ts:23-38` 构建时注入 `<meta name="oc-build" content="…">`，与正则形态一致；`public/sw.js:80-111` 非导航的同源 `GET /` 不在拦截分支（只拦 `navigate` 与 `/assets/*`）→ `cache: "no-store"` 真到网络，不会被 SW 离线壳顶掉；图 `shots\settings-about-update-check--desktop--light.png`「版本 9f3c2ab7e1d4」下「检查更新」按钮；`--mobile--dark.png` 按钮触控高度足；`workspace-settings-about--desktop--light.png`（无构建号）不出现；用例 `SettingsCenter.test.tsx:260-318` 6 例 | 见 §6 观察项 2（`<output aria-live>` 仅在有消息时挂载，P3 a11y nit，转 a11y-mod-a） |
| 关于页「备案」占位不渲染，真值自动出现 | ✅ | `SettingsCenter.tsx:504-506` `hasIcpNumber`（≥4 位数字）、`:622-627` 条件渲染；图 desktop / mobile 均无「备案」行（`brand.ts` 为占位）；用例 `SettingsCenter.test.tsx:243` | — |
| 会话用量「加载更多」按 `session_id` 去重，offset 按服务端原始行数推进 | ✅ | `src/components/settings/UsageTab.tsx:45-57` `appendSessionRows`（首屏 `:170` 与翻页 `:238` 都过它；`:171/:239` offset 用原始 `rows.length`；全重复页不会死循环，`hasMore` 仍取服务端）；图 `shots\settings-usage--desktop--light.png` 会话明细正常；用例 `UsageTab.test.tsx:491` 3 例 | 漏行仍需后端游标分页（文档已写明） |
| SET-14 免费用户可买加量包 判定关闭（无代码） | ✅ | `settings.md` §9.1 引 `packages/commercial/src/http/subscription.ts` `handleBuyPack` 的 `ensureFreeSubscription`；无改动需核 | — |
| SET-32 不修（有判据） | ✅ | `SubscriptionDialog.tsx` 轮询 effect 注释（B 阶段） | — |
| SET-09 / SET-10 需后端 | ✅ | §9.1 写明 `credits_per_yuan` / `PATCH /api/org` | — |
| `ConnectorsTab` / `KnowledgePlanetAutomationPanel` 目录迁移 跨模块 | ✅ | §9.1 写明由 manage owner 决定 | — |
| Auto-Dream 卡片文案 不修 | ✅ | 产品决策 | — |
| `ApiKeysSection` 深链含密钥 不修（协议如此） | ✅ | 页面已有「请勿分享」提示 | — |
| 备案号真值 / 联系邮箱 shell + 运营 | ✅ | 前端两处占位不渲染已就位 | — |
| 预览台场景 `settings-about-update-check`（`WithBuildMeta` 注入 / 卸载 meta，不污染同批场景） | ✅ | `browser-tests/ui-preview/scenes-settings.tsx`；本轮同批 `workspace-settings-about` 仍无构建号 → 注入确实随场景卸载 | — |

验证门复跑：`npx vitest run src/components/settings src/components/org src/components/payment src/components/SettingsCenter.test.tsx src/components/ChatGptProxyDialog.test.tsx src/components/OrgCenter.test.tsx src/components/charts.test.tsx src/lib/orgBilling.test.ts src/lib/pendingPayment.test.ts src/lib/plans.test.ts --maxWorkers=1` → **21 文件 / 269 例全绿**（与交付记录一致；`vitest-settings.log`）。biome：`SettingsCenter.tsx:237 noNoninteractiveTabindex`（blame `3ee28bad4`）、`UsageTab.tsx:161/186`（`075f21728` / `b6098b04f`）、`UsageTab.test.tsx:314-316 noDelete`（`87f54ecc3`）均二期前既有，**新增 0**。

## 5. 合并后全局验证（integration `c034f05d7`，工作树 `wt\qa-p3`）

| 门 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0 | `typecheck.log` |
| 预览台场景类型检查 | `npm run typecheck:preview --workspace packages/web-react` | ✅ exit 0（补丁① / 二期记录里的 2 处 integration 既有错误已被集成③ `e0f53688a` 消掉） | `typecheck-preview.log` |
| market 单测 | 见 §1 | ✅ 11 / 152 | `vitest-market.log` |
| manage 单测 | 见 §2 | ✅ 17 / 214 | `vitest-manage.log` |
| sidebar 单测 | 见 §3 | ✅ 23 / 295 | `vitest-sidebar.log` |
| settings 单测 | 见 §4 | ✅ 21 / 269 | `vitest-settings.log` |
| 代码风格 | `npx biome lint` 四条二期共 27 个改动文件（含用例与场景文件） | ✅ 31 条诊断 / 25 处位置，`git blame -L` 逐处判定**全部**来自二期之前的提交（无一落在 `1fb99bfcc..5391c150a` / `af79d7b05..6fae01440` / `ef872e91a..25c775295` / `c0efc9c91..5eac1b807` 共 13 个提交内）→ 二期新增 0 | `biome-summary.log`、`biome-github.log` |
| 真浏览器交互门 | `npm run test:browser`（`OC_E2E_BROWSER` 指向本机 Chrome） | ✅ `run.mjs` **T1–T68 共 68 条全部 ok**（含侧栏 T25 / T41 / T43、设置页 T42、教程 T38）；`node --test` 73 条 **70 pass / 3 fail**，3 条与基线 `210b9967` 及 sidebar-B / sidebar2 记录**逐条相同**：`cc-switch-ascii-name` ×2（等待超时 + 期望 `gemini-3.8-flash` 实得 `sonnet-5`，settings 归属、基线既有）、`OCV5-185`（Windows 未开发者模式 `symlink … EPERM`，环境限制）。非本轮四条交付引入 | `test-browser.log` |
| 视觉证据 | `OC_UI_SCENES='market-installed,market-publish,market-browse-skill,market-review,market-detail,manage-cron-range,manage-skill-workbench-evals,manage-skill-workbench-train-draft,sidebar-empty,sidebar-overview,sidebar-repo-banner,sidebar-github-unlinked,settings-about-update-check,workspace-settings-about,settings-usage'`，`OC_UI_SHOT_DELAY=900` | ✅ **45 场景 / 126 张**，`failures: []`、`retried: []`、`unmockedApi: []`；关键图已用 Read 逐张看（§1–§4 引用的 14 张） | `shoot.log`、`shots\manifest.json` |
| `cronHuman` 边界探针 | `node --experimental-strip-types .audit-tmp\qa-p3\cron-probe.mjs` | ✅ 23 组，翻译 12 组正确、回退 11 组均原串（§2） | 脚本在仓库外 |

**NOT RUN**：`npm test` 全量（四模块相关 72 文件 / 930 例已单跑绿，全量门由集成③ / 集成④ 统一跑；已知基线红 `tutorialShowcase` autocrlf 与本轮无关）；真机 iOS Safari；Tooltip hover 态截图（预览台静态挂载）；「检查更新」对真实服务端的比对（本地无后端，四分支由 `Response` 桩单测覆盖）。

## 6. 观察项（P3 nit · 不阻断 · 本轮不改代码）

QA 不动业务文件：两处都落在待领的 `a11y-mod-a`（settings / market 归属）将要清扫的文件里，先改会给对方制造冲突；改法已写清，交 a11y-mod-a 顺手做，或由模块 owner 决定不做。

| # | 位置 | 现象 | 建议改法 | 转交 |
|---|---|---|---|---|
| 1 | `src/components/marketplace/BrowsePanel.tsx:634-636`（K-12 副作用） | 分类片容器 `tabIndex={0}` 原为「横向滚动区必须可键盘聚焦 / 滚动」而设；K-12 后 `sm` 起改为换行、不再滚动，桌面端键盘用户多出一个无操作意义的 Tab 停靠点（带 `focus-visible` 环），biome-ignore 的理由在桌面端也不再成立 | `tabIndex` 只在 `(max-width: 639px)` 命中时给 `0`（仓内无通用 `useMediaQuery`，可参照 `hooks/useMdViewport.ts` 的 `matchMedia` 写法加一个窄屏判定；或去掉 `tabIndex`，只靠芯片按钮自身可聚焦 + 移动端触屏滚动） | a11y-mod-a（market） |
| 2 | `src/components/SettingsCenter.tsx:586-590`（SET-42 ② 新增） | `<output aria-live="polite">` 只在 `message` 非空时才挂载：首次点「检查更新」时 live region 与内容同帧插入，部分读屏（尤其 VoiceOver）不播报刚插入的 live 区域；后续状态变化能播 | `<output>` 常驻渲染（无消息时为空），只切换其文本内容 | a11y-mod-a（settings） |

## 7. 改动文件（本任务）

- `docs/audit/qa/QA-p3-tail.md`（本文件，新增）。未改任何业务代码、用例或场景文件；`.audit-tmp\qa-p3\` 下的截图、日志与探针脚本均在仓库外。
