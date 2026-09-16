# QA·复核 B 轮 P3 修复交付（landing-B / media-B / tutorials-B）· t-1038

- 复核对象：t-49 landing-B、t-51 media-B、t-53 tutorials-B 三条阶段 B 交付，**以 integration 分支
  `feat/v5-selfhost-ocv5-audit-ux` @ `c034f05d7` 为核对态**（landing-B / media-B 已由集成② 合入，tutorials-B 由集成③ 6/6 合入；
  三条交付各自 §「修复记录」里声称的每一处改动都在这一态上逐条定位）。
- 复核工作树：`wt/qa-b-p3`，分支 `feat/v5-selfhost-audit-qa-b-p3`（自 `c034f05d7` 起）。角色：测试 / QA，不替开发写新功能。
- 方法（PLAYBOOK §3/§4 + d-28）：① 静态核对——把三份 `docs/audit/{landing,media,tutorials}.md` 修复记录表里每一条
  「改动」翻成可 `rg` 的断言，在 HEAD 上定位到 `file:line`；② 三模块全部 vitest + typecheck / typecheck:preview；③ biome lint
  对照基线 `210b9967`（临时 detached 工作树，已删）；④ 真浏览器门 `test:browser`；⑤ 教程门禁 `check:tutorials`
  （integration HEAD 与 tutorials-B 分支各跑一次）；⑥ ui-preview 截图台：三模块 70 场景 × desktop/mobile × light/dark = **258 张**
  → `D:\code\test_project\test123\.audit-tmp\qa-b-p3\integ\`（`failures: 0 / retried: 0 / unmockedApi: 0`），用 Read 逐张看了 30 张关键图
  （清单见 §7），并与各模块 `.audit-tmp\<slug>\before\` 同名图对照。

## 结论

| | landing-B（t-49） | media-B（t-51） | tutorials-B（t-53） |
|---|---|---|---|
| 修复记录 vs 代码 | 20 条 + X-01~03 逐条对上；**0 处不符** | 27 条 + X-M1~M4 逐条对上；**1 处不符（M-23 性能半条，文档写 ✅ 实为未做）** | 37 条 + 追加①② 逐条对上；**0 处不符** |
| P1 / P2 | P2 3/3 ✅ | P1 2/2、P2 11/11 ✅ | P2 12/12 ✅ |
| P3 处置与文档一致 | ✅（L-11 遗留理由已失效，见 §5-②） | ◐（M-23 勘误，见 §5-③） | ✅ |
| 阶段 B 验证门（typecheck / 模块 vitest / after 图） | ✅ 复跑全绿 | ✅ 复跑全绿（含 test:browser T30） | ✅ 复跑全绿；**但 integration HEAD 上 `check:tutorials` 红**，非本条引入（§5-①） |
| 集成后回归 | 无 | 无 | 无 |

**❌ / ⚠ 共 3 项**（§5）：① integration HEAD `check:tutorials` 红（集成漂移，归 tut-sync-2）；② landing L-11 遗留理由失效（可做了，
文件由 t-895 持锁 → 已移交）；③ media M-23 修复记录与代码不符（性能半条未做 → 文档已勘误 + 移交 t-895）。
**本轮代码改动 0 处**：三处唯一能动手的地方（`AuthGate.tsx` / `ImageAnnotationEditor.tsx`）此刻都由 t-895 a11y-B 持写锁在改，
按任务书边界「不碰 a11y-B 正在改的文件」只做移交；文档改动 3 个（本文 + `landing.md` §7.1 一行备注 + `media.md` M-23 行勘误与遗留补记）。

## 0. 验收标准（PLAYBOOK §6 阶段 B 口径，三条共用）

| 标准 | landing-B | media-B | tutorials-B | 证据 |
|---|---|---|---|---|
| P1 / P2 必修 | ✅ 3/3 | ✅ 13/13 | ✅ 12/12 | §1–§3 各行 |
| 每个改动配用例（逻辑改动 vitest；视觉改动 after 图） | ✅ 9 个 test 文件 88 例 | ✅ 8 个 test 文件 108 例 + 跨模块契约 `chat/media.test` 18 例 | ✅ 12 个 test 文件 95 例 | §4 vitest 30 文件 309 例 |
| typecheck 绿 | ✅ | ✅ | ✅ | `tsc -b` exit 0；`typecheck:preview` exit 0 |
| 改高频交互面须 `test:browser` 绿 | 未触碰（NOT RUN 理由成立） | ✅ run.mjs 68/68（T30 视频任务中心） | 未触碰 | §4 |
| after 截图 | ✅ 31 场景 | ✅ 11 场景 | ✅ 27 场景 | `.audit-tmp\qa-b-p3\integ\` |
| 「修复记录」「验证」两节写进 `docs/audit/<slug>.md` | ✅ §7/§8 | ✅ §6/§7/§8 | ✅ §6/§7/§8/§9 | 三份文档 |
| 模块门禁（tutorials 独有）`check:tutorials` 绿 | — | — | ✅ 分支 `02c358655` 绿；❌ integration HEAD 红 | §5-① |
| 提交 subject 不用 `fix(v5)`（d-26） | ✅ | ✅ | ✅ | `git log 210b9967..c034f05d7 --format=%s` 无 `fix(v5)` |

## 1. t-49 landing-B（20 条 + 3 跨模块）

位置省略 `packages/web-react/src/`；截图省略 `.audit-tmp\qa-b-p3\integ\`。

| 核对项 | 结论 | 证据（代码 / 用例 / 截图） | 处置 |
|---|---|---|---|
| L-01 三处 `text-white` → `text-primary-fg` | ✅ | `landing/Tutorials.tsx:149,168`、`landing/DemoShowcase.tsx:284`；两文件 `rg text-white` 0 命中；`Tutorials.test:31`、`DemoShowcase.test:56`；`landing-section-tutorials--desktop--light.png` 1/2/3 与「打开案例展厅 →」为深色墨字 | — |
| L-02 「联系合作」有邮箱才渲染 / 备案占位不渲染 | ✅ | `Landing.tsx:51,311-312,763-765,778`；`LegalPage.tsx:45,86`；`lib/legal.ts:28 filedIcp`；`lib/brand.ts:15` 已加 `contactEmail?`（值仍空，X-03 运营项）；`Landing.test:139,146`、`LegalPage.test:39`、`legal.test:40-51`；`landing-section-footer--desktop--light.png` 页脚无「联系合作」「备案信息更新中」 | — |
| L-03 窄屏折叠导航 | ✅ | `Landing.tsx:38 NAV_LINKS,356-358 aria-expanded/controls,373-378 min-h-11`；`Landing.test:81,117`；`landing-home--mobile--light.png` ☰、`landing-mobile-nav-open--mobile--light.png` 五锚点 + ✕ | — |
| L-04 法务标点全角 / 日期单字段 | ✅ | `lib/legal.ts` `rg "[\p{Han}][,;:][\p{Han}]"` 0 命中；`LegalPage.tsx:75`、`AuthGate.tsx:906` 「生效日期：」；`legal.test`、`LegalPage.test:19`、`AuthGate.test:683`；`legal-terms--mobile--dark.png`、`auth-legal-modal--mobile--light.png` | — |
| L-05 验证码占位符字距 | ✅ | `AuthGate.tsx:700-702 placeholder:tracking-normal`；`AuthGate.test:645`；`auth-verify--desktop--light.png` | — |
| L-06 CTA 文案两档 | ✅ | `Landing.tsx:353,411,728` 「免费开始」×3、`:645` 「开始使用，再去市场安装」；`rg 浏览智能体市场|开始使用从简|免费开始使用` 0 命中；`Landing.test:62` | — |
| L-07 首页主题切换窄屏收起 | ✅ | `Landing.tsx:341-342 hidden md:block`；`Landing.test:129`；`landing-home--mobile--light.png` 头部无主题钮 | — |
| L-08 ◐ Tab 条渐隐 / 答案撑位只在 md | ✅ 与文档一致 | `DemoShowcase.tsx:275 sm:hidden 渐隐,358 hidden md:block,366 md:absolute`；`DemoShowcase.test`；`landing-section-demo--mobile--light.png` 右缘渐隐可见，步骤时间线仍按固定行数预留（文档注明有意保留） | — |
| L-09 `PasswordInput` 显示 / 隐藏 | ✅ | `AuthGate.tsx:27-53`（`aria-pressed`、可及名带字段名）、`:529,624,638,812,826` 五处；`AuthGate.test:603-642` 3 例；`auth-register-password-shown--desktop--light.png` | — |
| L-10 配置未就绪按钮文案 | ✅ | `AuthGate.tsx:566` 「正在准备登录…」；`AuthGate.test:669` | — |
| L-11 ⏸ 占位符 = 标签 | ⚠ 遗留理由已失效 | `AuthGate.tsx:512,534,603` 仍 `placeholder="邮箱"/"密码"`；当初阻塞点 `App.test.tsx` 已改 `getByLabelText('邮箱'/'密码')`（:267-268,411-412,1695-1696,1829），仅 `:446/:478` 两条「登录表单已消失」否定断言还按占位符查；`browser-tests/**` 无依赖 | 见 §5-②：`AuthGate.tsx` 由 t-895 持锁 → 改法与用例清单已 `send_to` 移交；`landing.md` §7.1 已备注 |
| L-12 去掉 `token` | ✅ | `AuthGate.tsx:801`；`AuthGate.test:655` | — |
| L-13 登录页页脚卖点 | ✅ | `AuthGate.tsx:853`；`AuthGate.test:661`；`auth-verify--desktop--light.png` 页脚 | — |
| L-14 协议弹窗副标题不折行 | ✅ | 同 L-04；`auth-legal-modal--mobile--light.png` 「生效日期：2026-07-10」单行 | — |
| L-15 法务页自接主题 + `ThemeToggle` | ✅ | `LegalPage.tsx:3,6,44,67`；`LegalPage.test:27`；`legal-terms--mobile--dark.png` 右上角主题钮、暗色成立 | — |
| L-16 ◐ 登记页出口 | ✅ 与文档一致 | `DesktopEnrollPage.tsx:27-34 enrollNavigation,:46,:52 「请稍后再试」,:79,:130 返回首页,:134`；②「去设置解绑」未做（`:158` 注释说明网页端无设备管理页）；`DesktopEnrollPage.test:73,83`；`desktop-enroll-invalid--desktop--light.png`、`desktop-enroll-device-limit--mobile--light.png` | — |
| L-17 小字对比度 | ✅ | `Landing.tsx` `rg "#747970|#747a70|#777d73"` 0 命中，`#8b9086` 多处（`:426` 注释） | — |
| L-18 不报兜底价 | ✅ | `Landing.tsx:180,234`；`Landing.test:183,191,198` | — |
| L-19 复制暗示常驻 | ✅ | `landing/Tutorials.tsx:113-120`，`rg title="点击复制"` 0 命中；`Tutorials.test:44`；`landing-section-tutorials--desktop--light.png` 芯片右侧「复制」常驻 | — |
| L-20 Turnstile 占位 + 骨架 | ✅ | `TurnstileWidget.tsx:14,18-20,156-160`；`TurnstileWidget.test` 2 例；`auth-login-turnstile-fail--desktop--light.png` 失败态无空白 | — |
| X-01 法务页主题接线 | ✅ 由 L-15 自接 | 同 L-15 | shell 可选项 |
| X-02 `--grad-cta-fg` token | ⏸ 未补（如文档） | `rg grad-cta-fg` 0 命中；L-01 用 `text-primary-fg` 兜住 | shell 可选项 |
| X-03 备案号 / 联系邮箱 | ⏸ 运营项 | `lib/brand.ts:15` 字段已加、`:28 icp` 仍占位 → 页脚两项都不渲染（正确行为） | 运营填值 |
| 场景 | ✅ | `scenes-landing.tsx` 31 场景（`landing-mobile-nav-open` :203、`auth-register-password-shown` :271）；manifest 31/31 成功 | — |

## 2. t-51 media-B（27 条 + 4 跨模块）

| 核对项 | 结论 | 证据 | 处置 |
|---|---|---|---|
| M-01 调整大小页图永不出 | ✅ | `ImageResizeMode.tsx:96-100 loadedSrc / adoptLoadedImage,:217`，`rg setImgReady` 0 命中；`ImageResizeMode.test` 9 例；`media-image-resize--desktop--light.png` / `--mobile--dark.png` 主图完整（before 四张只有骨架） | — |
| M-02 评论模式 Esc 委托 | ✅ | `ImageCommentMode.tsx:64-76`（`escapeRef` 三分支）；`ImageViewer.tsx:266,487 onEscapeKeyDown`；`ImageResizeMode.tsx:105 busy 守卫`；`ImageViewer.test` 24 例 | — |
| M-03 X 走 `requestBack` + 确认层 | ✅ | `ImageCommentMode.tsx:160,228-229,386 alertdialog,392`；`ImageCommentMode.test` 12 例 | — |
| M-04 抽屉关闭钮 | ✅ | `MediaTaskCenter.tsx:476 IconButton aria-label="关闭视频任务" size="lg"`；X-M3 `ui/Sheet.tsx:50-90 closeButton/closeLabel` 亦已落地（本组件未重复挂）；`media-task-center--{desktop,mobile}--light.png` 右上 ✕ | — |
| M-05 开发者术语 | ✅ | `MediaTaskCenter.tsx:42 PHASE_LABEL,:71 phaseLabel,:84 ERROR_LABEL,:100 failureSummary,:112-121 apiCall 分状态文案,:212 「技术详情」,:517-518 rev→title`；`MediaTaskCenter.test` 14 例；before/after 对照 `media-task-center--desktop--light.png`：「已完成 · done」→「已完成」、「denoise_step」→「正在生成画面」、「wait_gpu」→「等待算力」、「rev 4」消失 | — |
| M-06 危险操作确认 + busy | ✅ | `MediaTaskCenter.tsx:16,334 useConfirm,:332,437-440 pendingPath,:723`；`run.mjs` T30（68/68 过） | — |
| M-07 容器预览 Esc / 关闭确认 | ✅ | `ContainerWebPreview.tsx:799 requestClose,:870,:889-894`；`ContainerWebPreview.test` 「M-07 …」用例过 | — |
| M-08 不拦 Tab | ✅ | `ContainerWebPreview.tsx:1176-1177`，`:1186` 「按 Tab 离开画面」 | — |
| M-09 触屏跟手滚动 | ✅ | `ContainerWebPreview.tsx:586-608`（`TOUCH_DRAG_SLOP`、50ms 节流、`flushTouchScroll` 增量 wheel） | — |
| M-10 `object-contain` + 视口重连 | ✅ | `ContainerWebPreview.tsx:382-416 visualViewport/orientationchange,:516 pointFromPointer,:1162-1163` | — |
| M-11 滑杆让位 | ✅ | `ImageAnnotationEditor.tsx:839 pl-14 … sm:px-16`；`media-annotation-editor--mobile--light.png` 滑杆与图无重叠 | — |
| M-12 底栏按钮提到模块顶层 | ✅ | `ImageAnnotationEditor.tsx:117 function ToolButton,:140 function RoundBtn` | — |
| M-13 `aria-disabled` + 点击提示 | ✅ | `ImageViewer.tsx:146-178,:467 「当前模型不支持图片评论」` | — |
| M-14 「更多」用 DropdownMenu | ✅ | `ImageViewer.tsx:42,563-596` | — |
| M-15 触屏命中区 | ✅ | `ImageCommentMode.tsx:230 X,:295-313 size-11 命中区包 size-7 圆点,:343,:370`；`ImageResizeMode.tsx:171,176` | — |
| M-16 轮询 `silent` 不抖 | ✅ | `MediaTaskCenter.tsx:338-372,:407,:429` | — |
| M-17 失败任务恢复入口 | ✅ 已升级为完整形态 | `MediaTaskCenter.tsx:221-249 CopyPromptButton / ReusePromptButton,:322 onReusePrompt,:704-705`；X-M4 `App.tsx:4047` 已接线 → 生产走「重新发起」；`media-task-center-unavailable--desktop--light.png` 无悬空「单段视频」标题 | — |
| M-18 progressbar / output / 字号档 | ✅ | `MediaTaskCenter.tsx:190,497,744`；`rg "text-\[12|text-\[13"` 0 命中 | — |
| M-19 断开态文案 + summary 44px | ✅ | `ContainerWebPreview.tsx:89,1487-1521`；X-M2 `styles.css:674-677` 已改 `var(--text-meta)` + `min-height: 44px`；`media-container-preview-error--mobile--light.png` | — |
| M-20 「加入」/ 胶囊只在 ready | ✅ | `ContainerWebPreview.tsx:1061-1063,:1090-1091`；`media-container-preview-loading--mobile--light.png` 顶部无胶囊 | — |
| M-21 ⌘/Ctrl+Enter / live nonce | ✅ | `ContainerWebPreview.tsx:162-165,:1442 \u200b,:1644` | — |
| M-22 鼠标唤出控件 | ✅ | `ContainerWebPreview.tsx:914-921`（`pointerType === 'mouse'`、250ms 节流）；`run.mjs` T16/T17 过 | — |
| M-23 textarea 自增高 / 选区扫描 | ❌ 文档不符（半条未做） | 自增高 ✅ `ImageAnnotationEditor.tsx:159-162,:934 max-h-28`；**性能半条未做**：`:667-670 selectionPresent = useMemo(() => hasSelection(mask), [revision])`，`:93-96 hasSelection` 仍每笔全量 `getImageData`；`rg selectionDirty` 在 integration 与 `feat/v5-selfhost-audit-media` 均 0 命中；提交 `2d75dbb45` 说明只列 textarea | 见 §5-③：`media.md` M-23 行已勘误为 ◐ 并补进 §8 遗留；文件由 t-895 持锁 → 改法已 `send_to` 移交 |
| M-24 去掉「每张 50 积分」 | ✅ | `ImageAnnotationEditor.tsx:801` 只剩「Image 2」，`rg "50 积分"` 0 命中；`media-annotation-editor--mobile--light.png` 顶栏 | — |
| M-25 ◐ 复制临时链接 | ✅ 与文档一致 | `ImageViewer.tsx:48,430,457,593` | 后端分享令牌 |
| M-26 键盘落点居中 / 扩展名 | ✅ | `ImageCommentMode.tsx:32-35,:105-107` | — |
| M-27 → X-M2 preview 字号 | ✅ 已由 shell 落地 | `styles.css:642-648 状态胶囊 var(--text-caption),:673-677`；余下 `:701` 11px 是 28px 锚点圆点内的序号，不在 M-27 口径 | — |
| X-M1 `chat/media.test` 契约 | ✅ | `components/chat/media.test.tsx:120-124` pointerDown + `menuitem`；vitest 18/18 | — |
| X-M3 Sheet `closeButton` | ✅ | `ui/Sheet.tsx:50-90` | — |
| X-M4 `onReusePrompt` | ✅ | `App.tsx:4047` | — |
| 场景 | ✅ | `scenes-media.tsx` 11 场景，manifest 11/11 成功 | — |

## 3. t-53 tutorials-B（37 条 + 追加 2 项）

| 核对项 | 结论 | 证据 | 处置 |
|---|---|---|---|
| TU-01 「功能参考」一级入口 | ✅ | `TutorialCenter.tsx:6 BookOpen,:264 lastTopicRef,:641 TutorialSearch`；`TutorialCenter.test` 「功能参考有一级入口…」过；`tutorials-showroom--desktop--light.png` 三页签 | — |
| TU-02 精选作品受控 | ✅ | `tutorials/CaseShowroom.tsx:20-21,50-57`；`CaseShowroom.test` 9 例；`TutorialCenter.test` 18 例 | 深链见 TU-17 |
| TU-03 帮助与创作 → DropdownMenu | ✅ | `TutorialCenter.tsx:431 modal={false},:444,:617 HelpMenuItem`；`tutorials-help-menu-open--mobile--light.png` 真菜单 | — |
| TU-04 移动端搜索有反馈 | ✅ | `TutorialCenter.tsx:485-487 「N 篇匹配」,:506 h-11`；`tutorials-feature-search-hit--mobile--light.png` 「2 篇匹配「GitHub」」+ 结果列表 | — |
| TU-05 / TU-06 表单校验 / 占位符换行 | ✅ | `tutorials/CommunityTutorials.tsx:455 communityTutorialDraftIssue,:477 noValidate,:491-533 required,:542` JS 字符串占位；`CommunityTutorials.test` 11 例；`tutorials-studio-submit--desktop--light.png` 占位符真换行、hint「至少 4 个字」 | — |
| TU-07 目录错误态 | ✅ | `CommunityTutorials.tsx:111-113 catalogError/detailError/loadedOnce,:336-348 重试 + ListSkeleton`；`tutorials-studio-error--desktop--light.png` 只有错误条 + 重试 | — |
| TU-08 撤回确认 | ✅ | `CommunityTutorials.tsx:566 useConfirm,:593-603 withdrawConsequence + toast` | — |
| TU-09 分类标签中文 | ✅ | `lib/tutorialStudio.ts:147-154 COMMUNITY_CATEGORY_LABEL / communityCategoryLabel`；`SnapshotTutorialDetail.tsx:100`；`tutorials-studio-snapshot--desktop--light.png` 「编码」 | — |
| TU-10 「待采集」口径 | ✅ | `lib/tutorialJourneys.ts:7` 「任务脚本 · 尚无真实运行记录」，`rg 采集` 只剩注释；`tutorials/CaseArtwork.tsx:117-127 pendingCapture`、`CaseFieldReportVisual.tsx:14-54`；`tutorials-case-gallery--desktop--light.png`、`tutorials-case-detail--mobile--light.png` 横幅只说一次 | — |
| TU-11 触控 44px | ✅ | `TutorialCenter.tsx:607 ViewTab,:632 HelpMenuItem,:714,:745,:1823 CategoryChip,:1828 TopicList` 全带 `[@media(hover:none)]:min-h-11`；六处「返回」走 `Button variant="ghost" size="sm"`（`CaseShowroom.tsx:109`、`SignatureShowcases.tsx:52`、`CommunityTutorials.tsx:421-423`、`SnapshotTutorialDetail.tsx:93-95`、`TutorialCenter.tsx:975`） | — |
| TU-12 免责声明可读 | ✅ | `SignatureShowcases.tsx:37 text-caption text-white/75,:32 text-micro`；`tutorials-showroom--desktop--light.png` | — |
| TU-13 删除 `MissionReplay` | ✅ | `components/tutorials/MissionReplay.tsx` 不存在；`rg MissionReplay components/ lib/` 0 命中 | — |
| TU-14 场景路径落地 / 死代码 | ✅ | `TutorialCenter.tsx:73 TUTORIAL_SCENARIO_PATHS,:728 「按场景学习」`；`rg CaseSidebar` 0 命中 | — |
| TU-15 案例分类 / 搜索 | ✅ | `TutorialCenter.tsx:159 tutorialCaseMatches,:800 fieldset 案例分类`；`tutorials-case-gallery--desktop--light.png` chips + 搜索 + 「12 / 12 条」 | — |
| TU-16 示意成果预览 | ✅ | `TutorialCenter.tsx:1205 「你会拿到这些成果」,:1261 「示意：」,:1273 「示意图 · 非本案例实际产物」` | — |
| TU-17 ⏸ 深链 `view=`/`work=` | ⏸ 与文档一致 | `hooks/useAppRoute.ts` / `App.tsx` `rg work=|parseTutorialView` 0 命中；`TutorialCenter` 亦未加受控 props | shell 待接 |
| TU-18 侧栏滚到当前项 | ✅ | `TutorialCenter.tsx:1698-1709`（容器 `scrollTop`，不用 `scrollIntoView`）,`:1732` 「正在看：…不在当前筛选内」 | — |
| TU-19 ◐ 已读打勾 / 计数 | ✅ 与文档一致 | `TutorialCenter.tsx:693,749 tutorialIsRead,:1713-1720 「已读 n/26」`；0.9s 判定未改（文档注明留待产品） | — |
| TU-20 ◐ 复制失败反馈 | ✅ 与文档一致 | `SnapshotTutorialDetail.tsx:81-86 try/catch + toast` | — |
| TU-21 ⏸ CTA 文案 | ⏸ 与文档一致 | — | 产品口径 |
| TU-22 任意字号收敛 | ✅ | `TutorialCenter.tsx`、`components/tutorials/**` `rg "text-\[(8|8.5|9|9.5|10|10.5|11)px\]"` 0 命中 | — |
| TU-23 `main` 加 `relative` | ✅ | `TutorialCenter.tsx:527 tutorial-detail relative` | — |
| TU-24 ◐ 语义 | ✅ 与文档一致 | `TutorialCenter.tsx:603 aria-current,:1218 aria-pressed,:485 <output>,:800 <fieldset>` | — |
| TU-25 工作室 hero / 骨架 / toast | ✅ | `CommunityTutorials.tsx:198-211 compactHero,:347,:617 ListSkeleton,:284,:401,:603 toast`；`tutorials-studio-submit--desktop--light.png` hero 收成一行 | — |
| TU-26 字节 / 时间 / 术语 | ✅ | `SnapshotTutorialDetail.tsx:3,183 formatBytes`；`PublishFromSessionDialog.tsx:2,298`；`CommunityTutorials.tsx:52 dateStyle medium + timeStyle short`；`rg htmlpreview` 0 命中；`tutorials-studio-mine--desktop--light.png` 「提交于 2026年8月18日 17:12」 | — |
| TU-27 发布按钮禁用原因 | ✅ | `PublishFromSessionDialog.tsx:63 snapshotSubmitIssue,:175 <output>` | — |
| TU-28 展厅 iframe 沙箱 / 预览区 | ✅ | `CaseShowroom.tsx:7,120-122 SHOWCASE_IFRAME_SANDBOX、h-[min(70dvh,570px)] bg-surface、Skeleton`；`SignatureShowcases.tsx:56-57`；`tutorialStudio.test` 21 例（含 `htmlEmbedSandboxIsSafe`） | — |
| TU-29 ◐ 幽灵字 | ✅ 与文档一致 | `SignatureShowcases.tsx:11-12 objectPosition 78%,:30 via-[#080e19]/97`；`tutorials-showroom--desktop--light.png` 左上仍隐约可见（封面资产自带） | 资产项 |
| TU-30 图稿代码行 | ✅ | `CaseFieldReportVisual.tsx:152 hidden break-all sm:block,:155 flex-wrap`；`tutorials-case-detail--mobile--light.png` 不再重叠 | — |
| TU-31 第 4 步改指「设定目标」 | ✅ | `lib/tutorialJourneys.ts:57 session-goal`；`tutorialJourneys.test` 5 例；`tutorials-quickstart--desktop--light.png` | — |
| TU-32 `taskboardEnabled` | ✅ 已接线 | `lib/tutorialActions.ts:13,75-79`；`App.tsx:1622 taskboardEnabled: TASKBOARD_ENABLED`（`bdf7b4d15`）；`tutorialSystem.test` 8 例 | — |
| TU-33 搜索框 16px | ✅ | `TutorialCenter.tsx` `text-base md:text-body` | — |
| TU-34 ⏸ 品牌深蓝 | ⏸ 与文档一致 | — | shell token |
| TU-35 空文本成果 | ✅ | `SnapshotTutorialDetail.tsx:255` | — |
| TU-36 `.gitattributes` | ✅ 已落地（集成②） | 仓根 `.gitattributes` 四行 `-text`；`git ls-files --eol` 三个夹具 `i/lf w/lf attr/-text`；`tutorialShowcase.test` 4/4 绿（本工作树未做任何手工 LF 还原） | — |
| TU-37 门禁路径归一化 | ✅ | `scripts/check-v5-tutorials.ts:410 relative(ROOT, file).replaceAll("\\", "/")`；tutorials-B 分支 `02c358655` 上 `check:tutorials OK · 26 capabilities · 12 real-world cases · 26 media pairs`（Windows 本机首次绿，此前 26 项全报漂移） | — |
| 追加① / 追加② | ✅ | 同 TU-37 / TU-22 | — |
| 场景 | ✅ | `scenes-tutorials.tsx` 27 场景，manifest 27/27 成功 | — |

## 4. 集成态验证（全部在 `wt/qa-b-p3` @ `c034f05d7`，日志在 `D:\code\test_project\test123\.audit-tmp\qa-b-p3\`）

| 项 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0 | `typecheck-1.log` |
| 场景 / 截图台类型检查 | `npm run typecheck:preview`（web-react） | ✅ exit 0（media-B 当时 NOT RUN，本轮补跑） | `typecheck-preview-1.log` |
| 三模块单测 | `npx vitest run <landing 8 + media 8 + chat/media.test + tutorials 12 + tutorialShowcase> --maxWorkers=1` | ✅ **30 文件 / 309 例全绿**（137s）：ContainerWebPreview 28、AuthGate 36、chat/media 18、ImageViewer 24、MediaTaskCenter 14、TutorialCenter 18、ImageAnnotationEditor 16、CommunityTutorials 11、tutorialStudio 21、Landing 16、ImageCommentMode 12、TutorialReplay 5、PublishFromSessionDialog 4、ImageResizeMode 9、DesktopEnrollPage 14、tutorialSystem 8、CaseShowroom 9、useContainerPreview 2、SnapshotTutorialDetail 2、DemoShowcase 4、tutorialApi 2、tutorialShowcase 4、SignatureShowcases 6、LegalPage 5、tutorialJourneys 5、legal 5、Tutorials 4、containerPreview 3、TurnstileWidget 2、gameDemoTranscript 2 | `vitest-modules-1.log` |
| 真浏览器门 | `OC_E2E_BROWSER=…chrome.exe npm run test:browser` | ◐ `run.mjs` **68/68 全过**（含 T16/T17 容器预览沉浸态、T30 视频任务中心、T38 社区教程）；`node --test` 87 例 **85 过 / 2 不过**，2 例全在 `cc-switch-ascii-name.node-test.mjs`（settings `ApiKeysSection`，media-B §7 与 integ1 已登记的基线红，主克隆同红），与三模块无关。`ocv5-185-qa` 需 `packages/web-react/node_modules/@openclaude/protocol` junction（Windows 无符号链接权限，仓外产物，已预建） | `test-browser-1.log`、`test-results-185\` |
| 代码风格 | `npx biome lint` 三模块 30 个改动文件（27 个基线已有 + 3 个新场景文件），对照 `210b9967` 临时工作树同文件 | ✅ **按「文件 × 规则」逐对比对无新增**：基线 52 → HEAD 41（AuthGate `noLabelWithoutControl` 9→5、DesktopEnrollPage `useSemanticElements` 2→1、DemoShowcase 4→1、TutorialCenter 4→2、ImageResizeMode 1→0，其余逐对相同；`scenes-*.tsx` 0） | `biome-lint-head.log`、`biome-lint-base.log` |
| 教程门禁（integration HEAD） | `npm run check:tutorials` | ❌ 「教程同步快照已漂移」：功能源变化 17 项（advisor-mode, agents, billing-usage, chat-basics, container-web-preview, feedback-support, files-media, github-repository, image-create-edit, inbox, marketplace-publishing, memory-auto-dream, models-reasoning, preferences, sessions-history, team-mode, voice-input），**入口身份变化 agents / chat-basics**；正文 / 媒体 / 案例 / 注册表均无变化 | `check-tutorials-1.log` |
| 教程门禁（tutorials-B 分支） | 同上，在 `wt/tutorials` @ `02c358655` | ✅ `OK · 26 capabilities · 12 real-world cases · 26 media pairs · 2390809 B` | `check-tutorials-on-tutorials-branch.log` |
| 视觉 | `OC_UI_SCENES=landing-,auth-,legal-,desktop-enroll,media-,tutorials OC_UI_SHOT_DELAY=1200 node browser-tests/ui-preview/shoot.mjs` | ✅ 70 场景（landing 31 / media 11 / tutorials 27 / shell-landing-tokens 1）× light/dark = 258 张，`failures: 0 / retried: 0 / unmockedApi: 0` | `integ\manifest.json`、`shoot-integ.log` |

## 5. ❌ / ⚠ 项处置

### ① integration HEAD `check:tutorials` 红 —— ❌ 集成漂移，非 tutorials-B 引入，本轮不修

- **事实**：tutorials-B 分支自身绿（§4），合入 integration 后红。漂移项全是「功能源 / 入口身份」哈希：17 个能力的 `data-product-feature`
  标记所在源文件被其它模块的 B 轮改动碰过；`agents` / `chat-basics` 的**入口身份**变化对应 composer-B「去授权入口」（`19799c0fe`）与
  `c034f05d7`「ChatHeader 导出会话项、Sidebar 清除搜索钮补 `data-product-control`」——标记集合本身变了，门禁要求同步教程正文并提版本，
  且明确「入口身份变化不可用 `--source-only`」。
- **为什么不在本轮修**：修法 = 补写 / 校对 agents、chat-basics 两篇教程正文 + 提 `contentVersion` + `npm run tutorials:accept -- --note`
  改写 `tutorial-sync.json` / history / head 三个受门禁保护的文件。这是内容决策 + 目录数据变更，正是待办池里 **tut-sync-2「tutorials·补写
  agents/chat-basics 正文（去授权/…）」** 这条活的定义，QA 角色不越权代做；也不能只 accept 不改正文（会把「去授权」前的旧正文当成同步）。
- **对验收的影响**：tutorials-B 自身的验收标准（分支上门禁绿）成立；**integ4「复跑全量门」前必须由 tut-sync-2 转绿**，否则全量门红。
  已 `send_to` 指挥官。

### ② landing L-11「占位符 = 标签」—— ⚠ 遗留理由已失效，可做；文件由 t-895 持锁 → 移交

- **事实**：landing-B 把 L-11 记为遗留的唯一理由是 shell 的 `App.test.tsx` 用 `getByPlaceholderText('邮箱'/'密码')` 锁着占位符。集成②
  已把这些查询全部改成 `getByLabelText`（`App.test.tsx:267-268,411-412,1695-1696,1829`），只剩 `:446/:478` 两条「登录后表单已消失」的否定断言
  还按占位符查（占位符一改就成空断言，应同批改 `queryByLabelText`）。`browser-tests/**` 无任何依赖。
- **改法（已备好并 `send_to` 持锁方 se-cd9dc32065fe020b / t-895）**：`AuthGate.tsx:512`、`:603` `placeholder="邮箱"` → `"name@example.com"`；
  `:534` 登录密码 `PasswordInput` 去掉 `placeholder="密码"`（已有 `aria-label` + 可见标签）；`:761` 「注册邮箱」是提示不是重复，可不动；
  `AuthGate.test.tsx` `getByPlaceholderText("邮箱")` ×7 / `("密码")` ×2 → `getByLabelText`（登录页密码框有 `aria-label="密码"`，注册页走 `htmlFor`，命中唯一）；
  `App.test.tsx:446/478` → `queryByLabelText('邮箱')`。
- **为什么不在本轮修**：`AuthGate.tsx` 此刻由 t-895 a11y-B（landing 在其范围内）持写锁「接手前任未提交改动」，任务书边界「不碰 a11y-B 正在改的文件」；
  在自己分支改同一文件只会给 integ4 制造冲突。`landing.md` §7.1 已备注。

### ③ media M-23「hasSelection 改为 selectionDirty」—— ❌ 修复记录与代码不符（P3 性能半条未做）→ 文档勘误 + 移交

- **事实**：`media.md` §6.1 M-23 写「✅ … `hasSelection` 改为维护 `selectionDirty`，只在 undo/redo/restore 后扫一次 mask」，但
  `ImageAnnotationEditor.tsx:667-670` 在 integration 与 media-B 分支上都仍是 `useMemo(() => !!maskRef.current && hasSelection(maskRef.current), [revision])`，
  `:93-96 hasSelection` 每次对整张 mask `getImageData` 全量扫描；`rg selectionDirty` 0 命中；提交 `2d75dbb45` 的说明也只列了 textarea 自增高。
  M-23 的 textarea 半条与用例属实。用户可感知影响：低端手机上每一笔抬手扫 ≤2.5M 像素（阶段 A 原判 P3）。
- **处置**：`media.md` M-23 行改为「◐（QA 勘误）」并在 §8 遗留补一行；改法（`useState` + 非 erase 笔直接置 true、erase / restore 后各扫一次、clear 置 false）
  已 `send_to` 持锁方 t-895。**不阻塞验收**（P3、且不是回归），但归档汇总时 media 的「修复 25 / 遗留 2」应按「修复 24 + 部分 1 / 遗留 3」计。
- **为什么不在本轮修**：`ImageAnnotationEditor.tsx` 同样由 t-895 持写锁（`check_paths` 硬证据）。

## 6. NOT RUN 与理由

- `npm test` 全量 web-react 单测：集成② / ③ 已各跑一遍（`.audit-tmp\integration\integ2-vitest-all.log`、`integ3-vitest-all*.log`），本轮只跑三模块
  30 文件（含跨模块契约 `chat/media.test`），全量门由 integ4 复跑。
- 真容器预览 ready 态 / 评论 / 触屏滚动 / 视口重连、真 Turnstile 挑战 / 邮件验证码 / 桌面深链、教程工作室真后端投稿 / 撤回：本机无 v5 后端、容器与桌面端，
  沿用三份文档的 vitest 契约 + `run.mjs` T16/T17/T30/T38 门。
- 真机 iOS Safari：以预览台 mobile 视口（390×844、touch）代替。
- `check:tutorials` 转绿后的复跑：等 tut-sync-2。

## 7. 附

### 7.1 逐张看过的截图（`.audit-tmp\qa-b-p3\integ\`，与各模块 `before\` 同名图对照）

landing（12）：`landing-section-tutorials--desktop--light`、`landing-home--mobile--light`、`landing-mobile-nav-open--mobile--light`、
`landing-section-footer--desktop--light`、`landing-section-demo--mobile--light`、`auth-verify--desktop--light`、`auth-register-password-shown--desktop--light`、
`auth-legal-modal--mobile--light`、`legal-terms--mobile--dark`、`desktop-enroll-invalid--desktop--light`、`auth-login-turnstile-fail--desktop--light`、
`desktop-enroll-device-limit--mobile--light`。
media（8）：`media-image-resize--desktop--light`、`media-image-resize--mobile--dark`、`media-annotation-editor--mobile--light`、`media-task-center--desktop--light`
（+ `.audit-tmp\media\before\` 同名图）、`media-task-center--mobile--light`、`media-task-center-unavailable--desktop--light`、`media-container-preview-loading--mobile--light`、
`media-container-preview-error--mobile--light`。
tutorials（10）：`tutorials-showroom--desktop--light`、`tutorials-help-menu-open--mobile--light`、`tutorials-feature-search-hit--mobile--light`、`tutorials-case-gallery--desktop--light`、
`tutorials-case-detail--mobile--light`、`tutorials-quickstart--desktop--light`、`tutorials-studio-submit--desktop--light`、`tutorials-studio-error--desktop--light`、
`tutorials-studio-mine--desktop--light`、`tutorials-studio-snapshot--desktop--light`。

### 7.2 本轮产物

- 仓内：本文；`docs/audit/landing.md` §7.1 L-11 行备注；`docs/audit/media.md` §6.1 M-23 行勘误 + §8 遗留一行。**未改任何业务代码 / 用例 / 场景。**
- 仓外 `D:\code\test_project\test123\.audit-tmp\qa-b-p3\`：`integ\`（258 PNG + manifest）、`shoot-integ.log`、`typecheck-1.log`、`typecheck-preview-1.log`、
  `vitest-modules-1.log`、`test-browser-1.log`、`test-results-185\`、`biome-lint-{head,base}.log`、`check-tutorials-1.log`、`check-tutorials-on-tutorials-branch.log`。
  基线对照用的 detached 工作树 `base-wt` 已 `git worktree remove`。
