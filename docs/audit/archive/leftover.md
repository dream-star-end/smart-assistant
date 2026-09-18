# 集成④ 后遗留清扫 + 发布阻断修复 · 归档摘要（t-1234 / t-1235 / t-1348 / t-1575）

> 前三条是集成④（`2d2b5cafc` 源码态）之后、用户 09-17 授权（d-1450）下新开的任务，第四条 t-1575 是集成⑤预演（t-1503）暴露的首屏回归修复；四条均已验收、分支已推远端，并由集成⑤ 8 步合并带入 integration（`7cae5427f` / `c4a516697` / `ec09ed419` / `10e1348fb`；集成⑤ 任务 t-1237 在任务库尚未验收闭合，见 SUMMARY §4.3）。正文：[`docs/audit/leftover-shell.md`](../leftover-shell.md)（t-1234，分支 `feat/v5-selfhost-audit-leftover-shell@7e7c7e43b`）、[`docs/audit/tutorials.md`](../tutorials.md) §10（t-1235，分支 `-leftover-tut@69e18aa93`）、[`docs/audit/shell.md`](../shell.md) §9（t-1348，分支 `-budget-fix@65019b5dc`）、[`docs/audit/INTEGRATION.md`](../INTEGRATION.md) 集成⑤ §3（t-1575，分支 `-leftover-tut-budget@a947662bb`，无独立正文）。本文只做摘要与索引。
> 口径：四条都只做「本轮审计已登记、当时因缺原语 / 属跨模块接线 / 发布门禁才没做」的项或其引入的回归；无新增审计清单，计数并入原模块（market / settings / misc-p3 / tutorials / shell）。

## 1. t-1234 · 遗留清扫 shell / market / settings / App（fable-5-1-52 接手收口）

| 项 | 来源 | 结论 | 提交 |
|---|---|---|---|
| ① market K-27 审核面 / 发布页原生 checkbox | market.md §4 / §9；kp-automation 同口径 | ✅ shell 新增 `ui/Checkbox` 原语（保留原生 `<input type=checkbox>` + `appearance-none` 换视觉；`label` / `description` / `indeterminate` / `controlClassName`，触屏 `min-h-11`，无文字补 `min-w-11`，`data-ui="checkbox"`）；`ReviewPanel` 三处（「全选」mixed 由 prop 驱动、逐行「选择 {name}」、连接器验收确认）+ `PublishPanel` 工具集勾选卡接入；不加依赖、既有原语零改动 | `959735722` 原语 · `ffac63718` 接入 + 场景 `market-review-partial` · `dc404359b` 场景 `market-publish-agent-toolsets`（`ClickStep.scroll`） |
| ② settings 备案判据去重 | INTEGRATION 集成③ §7 待办；settings.md 关于页 | ✅ 删本地 `hasIcpNumber`，`AboutSection`「备案」行条件与展示值改取 `lib/legal` `filedIcp(BRAND.icp)`，与 landing 页脚 / 法务页同源；`SettingsCenter.test` 备案用例追加归一断言 | `74026e020` |
| ③ misc-p3 D-02 `onDemoSelect` 按 id 取 fixture | misc-p3.md §6 | ✅ 集成④ `4a2745283` 已接线（任务书明示不重做）；本轮补 `App.test`「demo 切换会话按 id 取 fixture：其余会话为空且不出历史骨架，切回 s1 恢复，`fetch` 零调用」 | `3aba642ca` |
| ③ misc-p3 D-08 demo 下交互块未说明原因 | misc-p3.md §6 | ✅ `tool/context.ts` `ChatInteraction.reason?: "demo"` + `chatInteractionUnavailableText()`；`RichBlocks` `OptionsBlock` 无 `sendUserText` 时按 reason 取「(演示模式仅供浏览,登录后可在真实会话中点选)」；`App.tsx` demo 分支 `{}` → `{ reason: "demo" }`（`App.tsx` 本轮只动这一处） | `3aba642ca` |

- 用例：`ui/Checkbox.test.tsx` 新增 9 例；`ReviewPanel.test` +1（四处 `data-ui=checkbox`、三态 mixed）；`PublishPanel.test` +1（必选项已勾、禁用、不压暗）；`SettingsCenter.test` 追加断言；`App.test` +1；`RichBlocks.test` +1。
- 验证（HEAD `3aba642ca`，`.audit-tmp\leftover-shell*`）：typecheck ✅ · `typecheck:preview` ✅ 0 错 · 相关 6 文件 / 92 例 ✅ + `App.test` 48/48（第一次 47/48 为 INTEGRATION 已登记的 15s 负载偶发，同 HEAD 复跑绿）· biome 15 文件按「文件 × 规则」与 integration 同文件完全相同，新增 `Checkbox.tsx` / `.test.tsx` 0 条 · CDP AX 脚本 3 场景 × 2 视口 28 个 checkbox 全部 `role=checkbox` 有名、`mixed` 正确、移动端 14/14 label 高 44px · 截图 before 22 / after 30 张 failures 0，逐张对照：差异全是 checkbox 本体 13px → 16px 圆角描边；一处 `market-review--desktop` 第 4 枚徽章折到第二行（行首控件宽 3px 引起、`flex-wrap` 既定行为，接受）。**NOT RUN**：`npm test` 全量与 `test:browser`（未碰高频交互面，交集成⑤）、真机、真实 `?demo=1` 整页截图。
- 文档：`leftover-shell.md`（新增）+ `market.md` K-27、`misc-p3.md` D-02 / D-08 状态回写（`7e7c7e43b`）。
- 遗留：无。后续建议：`KnowledgePlanetAutomationPanel` 同意勾选换用 `ui/Checkbox`（manage / settings owner，需另出 before / after）；连接器验收确认框只在展开 API 插件行时出现，现有场景与 AX 扫描未覆盖到它（`ReviewPanel.test` 覆盖），要补图需新增展开 CRM 行的场景。
- 改动文件 18 / +659 −85：`ui/Checkbox.tsx`（新）`ui/Checkbox.test.tsx`（新）`ui/index.ts`、`marketplace/ReviewPanel.tsx` + test、`marketplace/PublishPanel.tsx` + test、`SettingsCenter.tsx` + test、`tool/context.ts`、`RichBlocks.tsx` + test、`App.tsx` + `App.test.tsx`、`scenes-market-audit.tsx`、`docs/audit/{leftover-shell,market,misc-p3}.md`。

## 2. t-1235 · 遗留清扫 tutorials TU-17 / TU-34（fable-5-1-17）

| 项 | 结论 | 提交 |
|---|---|---|
| TU-17 快速上手 / 案例脚本 / 精选作品 / 跟着做步骤不进 URL | ✅ `?panel=help&tab=start\|cases`、`&work=planet\|gravity`、`&topic=…&step=N` 三个参数进 URL 并可反灌（boot 解析、登出保留公开深链、popstate 反灌、关闭 / 换篇时清理）；`useAppRoute` 新增 `parseTutorialTab / Work / Step`，`withPanelParams` / `tutorialHref` 增可选 `extras`（旧调用方零改动）；`TutorialCenter` 增受控 `browseView` / `signatureWorkId` / `stepIndex` props（不传退回内部 state，既有 19 例与场景不改），App 两处挂载接线；目标步骤 `aria-current="step"` + 滚到顶 + 开场 `onOpenAutoFocus` 落焦。**命名取舍**：审计原文 `view=` 已被 `/board` 占用（`withBoardParams` 离开 board 会清掉），改 `tab=` 并加用例锁定互不干扰 | `3fee24a58`（+ `04006714f` 的受控 props 前置） |
| TU-34 十余处品牌深蓝 `#07111f / #080e19 / #101624` 写死 | ✅ 新增 `components/tutorials/heroTheme.ts` 模块级 token（Tailwind v4 任意属性把 `--hero-bg / --hero-fg / --hero-line` 声明在 hero 容器上：深蓝 / 薄荷 / 海军蓝三组，暗色抬亮一档 + 1px 描边），`TutorialCenter` ×3、`SignatureShowcases` ×5、`CaseShowroom` ×3、`CaseFieldReportVisual` ×1 共 12 处改走 `bg-(--hero-bg)` 等，`#f3f6ef` 衬底改 `bg-sidebar`；不再需要 shell 改 `styles.css`（日后收编只需把三个变量搬进 `@theme`）；`CaseArtwork.tsx` SVG 插画调色板是图稿内容，按原清单不动 | `04006714f` |

- 验证：typecheck / `typecheck:preview` 绿；`check:tutorials` OK · 26 capabilities · 12 cases · 26 media pairs（未改 `data-product-feature` 入口与正文，**无漂移、不需 accept**）；vitest App / `useAppRoute` / `TutorialCenter` / `components/tutorials` / `lib/tutorial*` 11 文件 132 例全绿（新增 6：`useAppRoute.test` +4、`TutorialCenter.test` +2）；biome 改动 8 文件 + 新增 1 文件诊断集合与基线一致，0 新增；截图 before / after 各 108 张（27 场景）0 失败——浅色 hero 与 before 肉眼一致，暗色 hero 卡从页面底色中分出边界；48 张不同中 7 个含 hero 场景为本项改动，其余为内嵌演示视频抓帧时刻差异。**NOT RUN**：`npm test` 全量、`test:browser`（未碰高频交互面）、真机。
- 文档：`tutorials.md` §3 TU-17 / TU-34 ⏸ → ✅、§8 / §9 划掉、新增 §10（`69e18aa93`）。
- 改动文件 10 / +529 −28：`hooks/useAppRoute.ts` + test、`App.tsx`、`TutorialCenter.tsx` + test、`tutorials/{heroTheme.ts（新）,CaseFieldReportVisual,CaseShowroom,SignatureShowcases}.tsx`、`docs/audit/tutorials.md`。
- 遗留：tutorials 仍 ⏸ 的只剩 TU-21（CTA 五种文案，产品口径）。

## 3. t-1348 · 发布阻断 · 首屏 gzip 预算超限修复（fable-5-1-57）

> 集成④ 终点 `npm run build` 被 `vite.config.ts` `first-screen-budget` 插件拦下：首屏 modulepreload 闭包 15 个 chunk gzip **471.4KB > 460.0KB**（`FIRST_SCREEN_GZIP_BUDGET = 471040`；基线 `210b9967` 455.9KB / canonical `3b7c38b9d` 456.4KB）。指挥官拍板 A 优先（拆动态 import，目标 ≤455KB），90 分钟不达标转 B（上调阈值）。**结果：A 达标，阈值不动。**

| 项 | 结论 |
|---|---|
| 修后 | **445.5KB（456204 B），余 14.5KB，`npm run build` exit 0**；净减 25.9KB gzip；13 个 chunk（main 129.0 / tapePayload 122.7 / styles 77.5 / react-vendor 55.3 / radix-vendor 29.9 / lucide-vendor 17.7 / media 5.1 …） |
| 归因方法 | `sourcemap: "hidden"` 产出 `.map`，用 `@jridgewell/trace-mapping` 把闭包内每个 chunk 的生成字节按源文件归因（脚本仓外 `.audit-tmp\budget-fix\attribute-first-screen.mjs`），筛「入口静态可达、但只有点开才需要」的模块 |
| 拆分点 8 处（**首屏可见组件一个都没 lazy**） | ① 全屏图片查看器 `ImageViewer`（含圈选 / 评论 / 缩放三模式）`React.lazy` + 首次点开才挂载（media chunk 17.7 → 5.1KB）② `App.tsx` 顶层 `ImageAnnotationEditor` lazy + 有 `source` 才挂载 ③ `InboxDialog` / `GithubRepoModal` / `MessageFeedbackDialog` / `ProjectSettingsDialog`（连带 `ProjectAssetsPanel`）lazy + 新增 `useMountedOnce(open)` 挂载闸（≈10.2KB）④ 订阅弹窗「预选意图 / 最近已付费」下沉到新建 `lib/subscribeIntent.ts`，红卡不再静态引订阅弹窗 + 支付入口（≈4.6KB）⑤ `PROJECT_COLORS` 下沉到新建 `lib/projectColors.ts`（使 ③ 生效）⑥ 空闲预取清单加入 `ImageViewer` chunk ⑦ 测试适配：`media.test` URL 桩改保留真构造器的子类、开查看器后断言改 `waitFor` / `findByRole`；`MarkdownImpl.test` 同理 ⑧ `vite.config.ts` 阈值注释补实测（数值不动） |
| 越界说明 | ① / ④ / ⑤ / ⑦ 触及 messages（`chat/media.tsx` / `cards.tsx` / `MarkdownImpl.test`）、settings（`SubscriptionDialog`）、sidebar（`ProjectRow`）归属文件，均为「改一行 import / 抽一个常量 + re-export / 测试等待方式」的机械改动，不改业务行为；已在交付点出，集成⑤ 合入时一并过目 |
| 验证（`wt\budget-fix`） | `npm run build` ✅ exit 0（= `deploy-v5-selfhost.sh --deploy` 的 `build_frontend` 同款）· typecheck ✅ · 触及模块单测 15 文件 / 303 例 ✅ · **全量 `npm test` 302 文件 / 4279 例全部通过**（10m41s）· `test:browser` `run.mjs` 68/68（含 T13 工具卡、T14 消息反馈弹窗焦点归还、T16/T17 全屏预览、T25/T68 390px），`node --test` 70/73 → 提交后 `ocv5-185-qa` 单跑 15/15，余 cc-switch ×2 基线 · biome 新增 0（新建两 LF 文件 0 诊断）。**NOT RUN**：ui-preview 截图（零视觉改动，只改加载时序）、慢网首开体感（懒块首开多一次 chunk 拉取，已由空闲预取 + `DialogFallback` 对冲，未在节流网络实测） |
| 后续可拆候选（供下次逼近预算） | 专项工具卡体 `tool/{researchCards,connectorCards,…}` ≈18KB（需 tools owner 评估首帧占位）· `lib/taskboard.ts` ≈3.3KB（常量下沉 + 动态 import）· `@openclaude/protocol` + `@sinclair/typebox` ≈30KB（要改 `packages/protocol` 导出结构，PLAYBOOK §9 范围外）· `PermissionCard` ≈5.7KB（活动 turn 高频面，保守不动） |

- 提交：`77e1f35dc` refactor（12 files, +323 −142）· `65019b5dc` docs（`shell.md` §9 +62 行）；分支 `feat/v5-selfhost-audit-budget-fix@65019b5dc`，远端 = 本地；集成⑤ 第 1 步 `ec09ed419` 合入（`App.tsx` 三方自动合并）。**发布前 `npm run build` 必须过，集成⑤ 合入本分支后复跑 build 是发布门**（INTEGRATION 集成④ §6 / §7）→ 集成⑤ 源码态 `91358ce54` 实测 ✅ 447.8KB（§4）。

## 4. t-1575 · 集成⑤阻断 · leftover-tut 深链把教程案例数据拖进首屏（指挥官二分归因 → 修复分支 `leftover-tut-budget`）

> 集成⑤预演 t-1503（fable-5-1-2，`feat/v5-selfhost-audit-integ5-rehearsal@b6b78e876`：6 条待合分支试合、typecheck ✅）`npm run build` ❌ **475.2KB > 460.0KB**，而 budget-fix 单独为 445.5KB。指挥官 fable-5-1-4 对预演分支逐合并点 detached 构建（脚本 / 日志 `.audit-tmp\release-rehearsal\bisect-integ5-first-screen.ps1`、`integ5-bisect\SUMMARY.txt`）：`c1ef51a44`+budget-fix 446.8KB ✅ → `537595a1e`+qa-a11y 446.8KB → `b6c56be2d`+leftover-shell 447.3KB → **`586131c42`+leftover-tut 475.2KB ❌（`useAppRoute-*.js` 1.7KB → 30.7KB gzip）** → `6952c72ff`+a11y-c / `b6b78e876`+archive 475.2KB。QA t-1236 同时把它登记为 B-2「集成⑤ 必修」。

| 项 | 结论 |
|---|---|
| 根因 | leftover-tut `3fee24a58`（TU-17 深链）在入口静态闭包 `hooks/useAppRoute.ts` 新增 `import { SIGNATURE_WORKS } from '../lib/tutorialSignatureWorks'`，只为校验 `&work=planet\|gravity`，却把 `tutorialSignatureWorks → tutorialCaseCatalog`（教程案例数据）整个拖进首屏（`vite.config.ts:77-87` 历史注释正警告过「useAppRoute 拖教程案例数据」） |
| 修法 | 新增零依赖 `lib/tutorialSignatureWorkIds.ts`（`SIGNATURE_WORK_IDS = ['planet','gravity']` + 类型），`useAppRoute` 改引它；`SignatureWork.id` 反向以该类型约束；新增 `tutorialSignatureWorkIds.test.ts` 断言两表集合相等防漂移。4 files, +50/−5，`useAppRoute` chunk 30.7KB → **2.0KB** |
| 验证 | 集成⑤ 第 5 步紧跟 leftover-tut 合入后 integration `build` ✅ **447.8KB（458555 B），余量 12.2KB**（INTEGRATION 集成⑤ §5）；`tutorialSignatureWorkIds.test.ts` 计入集成⑤ vitest 305 文件 / 4306 例全绿。**NOT RUN**（本摘要作者）：分支自跑门的日志未单列，以集成⑤ §5 合并树结果为准 |
| 顺带发现 | 集成⑤ 合完 7 条后 `check:tutorials` 报 `agents / billing-usage` 功能源漂移（a11y-C / budget-fix / leftover-shell 的 className / lazy 改动致，与 t-1575 无关）→ 集成⑤ 以 `--source-only` accept（`91358ce54`，history 第 70 条，**待用户终审**）；发布预演 t-1598 据此写下「教程门两段式」口径（RELEASE.md §3.1b） |

- 分支 `feat/v5-selfhost-audit-leftover-tut-budget@a947662bb`（`refactor(v5)` 1 笔，基于 leftover-tut `69e18aa93`），远端 = 本地；集成⑤ 第 5 步 `10e1348fb` 合入。

## 5. 分支 / 集成状态（09-18 00:3x 现算 → 09-18 21:xx 按 integration `aeae1d72e` 复核）

| 分支 `feat/v5-selfhost-audit-*` | HEAD | 任务 | 相对 `c97a750f8` 未合入（00:3x） | 集成⑤ 合并提交 | 相对 `aeae1d72e` 未合入（21:xx） | 远端 |
|---|---|---|---|---|---|---|
| leftover-shell | `7e7c7e43b` | t-1234 | 6（5 代码 + 1 docs） | 3/8 `7cae5427f`（18 files, +659/−85，零重叠） | 0 | = 本地 |
| leftover-tut | `69e18aa93` | t-1235 | 3（2 代码 + 1 docs） | 4/8 `c4a516697`（10 files, +529/−28；引入首屏回归，第 5 步修正） | 0 | = 本地 |
| leftover-tut-budget | `a947662bb` | t-1575 | 1（代码） | 5/8 `10e1348fb`（4 files, +50/−5） | 0 | = 本地 |
| budget-fix | `65019b5dc` | t-1348 | 2（1 代码 + 1 docs） | 1/8 `ec09ed419`（12 files, +323/−142；`App.tsx` 三方自动合并） | 0 | = 本地 |

四支基点：leftover-shell / budget-fix 基于集成④ 源码态 `2d2b5cafc`（零重叠预期，实测零冲突）；leftover-tut 基于 `tut-sync-2@67b1494ea`，leftover-tut-budget 基于 leftover-tut；`App.tsx` 在集成⑤ 第 1 步三方自动合并（budget-fix lazy 改造与集成④ 接线不同 hunk），其余步零冲突（集成⑤ 唯一冲突在 a11y-c 的 `RichBlocks.test.tsx`，两条用例全保留）。集成⑤ 任务 t-1237 的验收闭合与全量门下半场见 SUMMARY §4.3。
