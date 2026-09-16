# a11y-B · shell 令牌 / 原语层修复（t-893）

- 分支：`feat/v5-selfhost-audit-a11y-shell`，**基点 = integration `feat/v5-selfhost-ocv5-audit-ux` @ `c034f05d7`**（本地 HEAD，含集成③ 6/6 合入；远端 integration 当时仍在 `1e4328ac9`，本分支比远端多出的只有集成③那 8 个提交，均是指挥官侧的合并/接线）。不是 `210b9967`：审的就是 integration，token 改动要在已合入的全量场景上验证。
- 依据：t-762「交互友好专项·键盘/焦点/无障碍走查」交付（`D:\code\test_project\test123\.audit-tmp\a11y\DELIVERABLE.md`、`report.md`、`results/*.json`），本条只收其中**根因在设计系统层**的 shell#1–#11；各模块内的非同源项（manage#1、market#1、settings#1–3、media#1 …）在 a11y-mod-a / a11y-mod-b 两条里做。
- 接手说明：前任 fable-5-1-58 已把 shell#1–#11 的代码改动分 8 个提交落地并推送（`d30ed780e`…`e62bdfb12`），掉线时缺的是：全量截图门、复扫指标、`test:browser` / 全量单测、本文档与交付。本轮（fable-5-1-20）复核了 8 个提交的 diff、跑完全部验证门、按复扫结果追加 1 个修正提交（`8986e7cd2`），然后成文交付。
- 结论：**shell#1–#11 全部 11 条有处置，11 条已修**（其中 #8 用「原语兜底」而非「强拆 header/body」，见 §2 说明）；两条 P2（#1、#2）落地并配用例。复扫 257 场景：浅色对比度 <4.5 文本命中 **356 → 58**，深色 **111 → 81**，移动端 44px 触控命中 **493 → 419**，无新增组合、无新增场景回归；全量截图 257 场景 / 854 张 failures = 0。

---

## 1. 逐条处置（shell#1–#11）

| # | 严重度 | 问题（t-762 原文要点） | 处置 | 改动 | 提交 |
|---|---|---|---|---|---|
| shell#1 | **P2** | 深色 `bg-accent` 上硬编码 `text-white` 2.82:1（ChatHeader HeaderCountBadge / SubscriptionDialog「当前」/ CreateOrgWizard 步骤圆点 / PreferencesTab「升级到 Max」） | **已修**：统一改走 `text-accent-fg`（浅色仍为白，深色取近黑 `#15151c`，vs `#9a8aff` 6.45:1）。复扫又抓到同文件两处漏网（CreateOrgWizard 套餐卡「已选」徽章、PreferencesTab 记忆整理图标块）一并改掉 | `components/ChatHeader.tsx`（+ `ChatHeader.test.tsx` 断言 `text-accent-fg` / `not text-white`）、`settings/SubscriptionDialog.tsx`、`org/CreateOrgWizard.tsx`（2 处）、`settings/PreferencesTab.tsx`（2 处） | `0557d6026`、`8986e7cd2` |
| shell#2 | **P2** | 浅色代码高亮 string/title `#1fa463` 3.1、number `#c2761b` 3.44、keyword `#a655c9` 4.26（波及 messages / tools / manage / taskboard 所有代码块与 diff） | **已修**：浅色四组重定为 keyword `#963dbb` / string `#167547` / number `#925813` / attr `#2d60c8`，在 `--code #fbfbfd`、白底、diff 增删行叠底（实测 `#f8ebed` / `#e8f0ed`）与 surface-2 `#ececef` 上全部 ≥4.8:1（留 0.3 余量）。复扫发现 `.dark` 只覆盖了每组前两三个选择器（literal / section / attribute / addition、symbol / bullet / link / deletion 漏了），浅色压深后深色代码块里这些 token 掉到 3.4–3.8 —— 深色档逐个补齐（深色四值在 `#0a0a0e` / `#1c1c25` 上 ≥7:1） | `styles.css` hljs 段 | `f953ad964`、`8986e7cd2` |
| shell#3 | P3 | 五个语义前景 vs `*-soft` 底叠在 surface-2 / hover / 侧栏灰底上只有 4.31–4.45 | **已修**：`--accent #6c54f0→#5a3fee`、`--danger #d52430→#bb202a`、`--success #187f4d→#157044`、`--warning #9e6213→#8a5511`、`--info #0c64f4→#0a58d8`（`*-soft` 与 `--accent-strong` 随之同步），口径改为「前景 vs soft@`#ececef` ≥4.5」：实测 4.67–4.73，vs 白底 6.1–6.3，填充块配白字 ≥6.1。色相/饱和度不变，只压明度 4–6% | `styles.css` 浅色 token 段 | `d30ed780e` |
| shell#4 | P3 | `--faint` 在选中行 `#e3e3e6` / hover / 侧栏底上 3.87–4.4 | **已修**：浅色 `#6f6f7b→#64646f`（vs `#e3e3e6` 4.56、白底 5.84）；深色 `#8a8a94→#92929b`（vs accent-soft@elevated 4.56、hover@surface 4.75、surface 6.41） | `styles.css` | `d30ed780e` |
| shell#5 | P3 | Input/Textarea placeholder 白底 3.42（Tailwind v4 preflight 把 `::placeholder` 定成 currentColor 50% 混色；`ui/Input` 走 `placeholder:text-faint` 不受影响，各模块手写 `<input>/<textarea>` 全掉回 preflight） | **已修**：base 层全站 `::placeholder { color: var(--faint); opacity: 1 }`（浅 5.8 / 深 5.9），utilities 层 `placeholder:*` 仍可覆盖 | `styles.css` @layer base | `15a5da49a` |
| shell#6 | P3 | `TimeAgo` 绝对时间只在 hover Tooltip 里，键盘 / 触屏 / 读屏拿不到（全站 70 处实例） | **已修**：渲染为 `<time dateTime={iso}>`，可见相对时间之外挂 sr-only 的「（绝对时间）」；**刻意不给触发器 tabIndex**（否则每张列表页多出几十个无操作停靠点）。用例断言标签 / datetime / sr-only 文案 / 无 tabindex | `components/ui/TimeAgo.tsx`、`ui/dataDisplay.test.tsx` | `2cfe3abfd` |
| shell#7 | P3 | Modal 正文滚动区不可聚焦，纯文本长内容（用户协议 2503px）键盘滚不动 | **已修**：新增 `useScrollBodyTabbable(ref, open)`，只在「正文确实溢出 且 没有可聚焦子孙」时给 body `tabIndex=0` + `focus-visible:ring-inset`（ResizeObserver + MutationObserver 跟随内容变化；放进一个按钮就自动撤掉，不多占停靠点） | `components/ui/Modal.tsx`、`ui/a11y.ts`、`ui/a11y.test.tsx` | `fa54040d2` |
| shell#8 | P3 | Radix FocusScope 回绕用 `focus({preventScroll:true})`，Sheet 整体滚动时首个焦点落到视口外（media#1 实测「刷新」rect.y = −432） | **已修（原语兜底，不强拆结构）**：新增 `revealFocusedElement`，挂在 Modal / Sheet 的 `Content.onFocusCapture` 上，目标越出 Content 可视矩形才 `scrollIntoView({block:'nearest'})`，已可见目标零副作用。**不**在 Sheet 原语里强拆固定 header + 滚动 body：Sheet 的 header 由各消费方自己渲染（MediaTaskCenter 直接给 Content 加 `overflow-y-auto`），原语层拆结构会改所有 Sheet 消费方的布局契约；MediaTaskCenter 自身的 header 固定化留给 media 模块（a11y-mod-b media#1） | `components/ui/Sheet.tsx`、`ui/Modal.tsx`、`ui/a11y.ts`（用例：越界滚回 / 可见不滚） | `fa54040d2` |
| shell#9 | P3 | 触屏下 DropdownMenu 菜单项 36px、SegmentedControl 36px、Switch 24px 高 | **已修**：DropdownMenuItem / SubTrigger 与 SegmentedControl 项补 `[@media(hover:none)]:min-h-11`（桌面零变化，与 IconButton / Chip 同一约定）；Switch 命中伪元素 `-inset-y-2.5→-inset-y-3`（包含块是 padding 边，border-2 内缩后 20 + 2×12 = 44px；原 40px 不达标，t-762 实测） | `components/ui/DropdownMenu.tsx`、`ui/SegmentedControl.tsx`、`ui/Switch.tsx`、`ui/formControls.test.tsx` | `acff6f0b7` |
| shell#10 | P3 | Toast 3.5s 自隐无「悬停 / 聚焦暂停」 | **已修**：自隐类 toast `onMouseEnter` / `onFocusCapture` 清计时器，`onMouseLeave` / `onBlurCapture`（焦点仍在提示内不算离开）重新计满 3.5s；error / 带动作的提示本就不自隐，不变。用例覆盖悬停暂停、离开重计、焦点在关闭键 ↔ 动作按钮间移动不重计 | `components/ui/Toast.tsx`、`ui/Toast.test.tsx` | `e62bdfb12` |
| shell#11 | P3 | 白字压 `bg-danger` 深色 3.07（ChatHeader danger 档角标、TicketCard「受阻」角标） | **已修**：改走 `text-danger-fg`（深色 `#15151c` vs `#f0666e` ≈6:1；浅色白 vs `#bb202a` 6.26） | `components/ChatHeader.tsx`、`taskboard/TicketCard.tsx` | `0557d6026` |

统计：**11 / 11 已修，0 不修**。P2 两条（#1、#2）均落地并有用例 / 复扫证据。

---

## 2. 几处取舍（为什么这么修）

1. **token 压暗而不是另立 `-on-soft` 第二套前景**：shell 审计（S-05）已经把「基础色直接取达 AA 的深值」定成本仓约定；本轮只是把口径从「vs 白底 / vs soft@白底」推进到「vs soft@`#ececef`」。填充块配 `-fg` 白字对比度只增（≥6.1），`designTokens.test` 四套主题守卫仍全绿。视觉上 accent 更饱和一档（`#6c54f0→#5a3fee`），10 张对照图逐张看过，无观感回归（§4.4）。
2. **TimeAgo 不加 tabIndex**：走查建议给触发 span `tabIndex=0` 或用 `<time>`。前者会让 manage / taskboard / market 列表页每页多出 20–40 个「聚焦后什么都做不了」的停靠点，对键盘用户是更大的负担；`<time dateTime>` + sr-only 绝对时间让读屏拿到完整信息、机器拿到 ISO 时刻，鼠标继续走 Tooltip。
3. **Modal 正文 tabIndex 条件化**：无条件 `tabIndex=0` 会给每个弹层多一个停靠点。只在「溢出且无可聚焦子孙」时才进 Tab 序，与 ManageCenter / SettingsCenter 面板正文的既有做法一致。
4. **Sheet 不强拆 header/body**（见表 #8）。
5. **placeholder 收在 base 层**而不是逐个模块补 `placeholder:text-faint`：根因在 preflight，逐处补会永远补不完。

---

## 3. 复扫发现的回归与修正（第 1 轮复扫 → `8986e7cd2` → 第 2 轮复扫）

第 1 轮复扫（前任 8 个提交，HEAD `e62bdfb12`）：浅色 356 → 61、深色 111 → 86、t44 493 → 419；但逐场景对比出现 2 个场景 **深色命中上升**（`messages-timeline-rich` cD 0→1、`tools-bodies` cD 0→3），全部是 hljs：

- `.hljs-literal` / `.hljs-section` `#177b4a` 压在 `#0a0a0e` / `#121218` / `#15151c` 上 3.4–3.7、`.hljs-bullet` `#9c5f16` 3.82 —— `.dark` 覆盖漏了这些选择器，浅色值压深后反而在深色里变差。
- 浅色 `.hljs-keyword` / `.hljs-built_in` `#9d44c3` 在 diff 删除行叠底 `#f8ebed` 上 4.47（差一线；原值 3.84 也不达标，属「同一元素、底色 hex 随 danger token 变化」）。

修正（`8986e7cd2`）：`.dark` 逐个覆盖四组全部选择器；浅色四组再压一档到任一实测底色 ≥4.8。同一提交顺手改掉两处同文件漏网的 `bg-accent text-white`（CreateOrgWizard「已选」、PreferencesTab 图标块）。第 2 轮复扫结果见 §4.5。

---

## 4. 验证

全部在 `wt\a11y-shell`（HEAD `8986e7cd2（代码 HEAD；本文档的 docs 提交紧随其后，最终 SHA 见 complete_task 交付）`）上跑；日志与产物在仓库外 `D:\code\test_project\test123\.audit-tmp\a11y-shell\`。

### 4.1 typecheck
`npm run typecheck --workspace packages/web-react` → ✅ exit 0（`typecheck.log`）。

### 4.2 vitest
- 受影响原语与消费方：`npx vitest run src/components/ui src/components/ChatHeader.test.tsx --maxWorkers=1` → ✅ 12 文件 / 103 例（`vitest-ui.log`）。新增用例：`ui/a11y.test.tsx`（4）、`ui/Toast.test.tsx`（+3）、`ui/dataDisplay.test.tsx`（+1）；更新：`ChatHeader.test.tsx`、`ui/formControls.test.tsx`。
- 全量 `npm test`（token / 原语改动影响面是全站，跑全量而不只跑模块）→ 299 文件 / 4220 例，首跑 298 / 4218 通过，2 败均在 `src/lib/tutorialShowcase.test.ts`（教程夹具字节数 / SHA-256 校验）—— 本工作树里 21 个标了 `-text` 的教程夹具仍是旧检出的 CRLF（工作树建立时 `.gitattributes` 尚未进历史，index 为 LF），与集成①登记的基线失败同源、与本分支改动无关；删掉这 21 个文件后 `git checkout --` 按属性重新检出（`git status` 仍干净、零代码改动），单跑 `tutorialShowcase.test.ts` → ✅ 4 / 4。合计 **299 / 299 文件、4220 / 4220 例绿**（`vitest-full.log`）。

### 4.3 test:browser
`npm run test:browser`（`test-browser.log`）→ 组件门 `run.mjs` **68 全过（清单 68 条全部执行）**；`node --test` 73 例 70 过 / 3 败，3 败与集成①②、QA t-759 登记的基线完全一致：`cc-switch-ascii-name` ×2（gemini-3.8-flash vs sonnet-5 契约，主克隆同样失败）、`OCV5-185 real dual Chromium permission QA` ×1（本机 shell 无符号链接权限，环境项）。无新增失败。该门在前任 HEAD `e62bdfb12` 与最终代码 HEAD `8986e7cd2` 上各跑一次（`test-browser.log` / `test-browser-final.log`），两次结果一致：68 全过 + 70 / 73（同 3 条基线；OCV5-185 的错误原文为 `EPERM: operation not permitted, symlink … packages\protocol`）。

### 4.4 全量截图门
`node browser-tests\ui-preview\shoot.mjs`（全部场景）→ `after\`：257 场景 / 854 张，**failures = 0**，retried = 0，unmockedApi = `listCronChannels` / `listProjectAssets`（与集成②全量门记录相同，非本轮引入）（`shoot-after.log`、`after\manifest.json`）。

逐张看图（before = integration @`c034f05d7` 主克隆出图 `before\`，after = 本分支 `after-typical\` / `after\`），浅色 5 + 深色 5：

| 主题 | 场景 | 看什么 | 结果 |
|---|---|---|---|
| 浅 | `shell-ui-kit` desktop | 五色 Badge / Alert / 按钮 / placeholder / Switch | 与 before 逐像素级一致，accent 略饱和，placeholder 略深；无布局变化 |
| 浅 | `messages-timeline-rich` desktop | 代码块 hljs 四色、TimeAgo「55 分钟前」 | 高亮色更深但仍可分辨四类 token；`<time>` 渲染无换行 / 尺寸变化 |
| 浅 | `taskboard-ticket-drawer-edit` desktop | 描述框 placeholder、「受阻」提示、danger 按钮 | 正常；danger 略深 |
| 浅 | `manage-connectors` desktop | warning / success / danger soft 徽章、faint 说明文字 | 徽章前景更清晰，底色无变化；无回归 |
| 浅 | `composer-model-menu` mobile | DropdownMenu 项 44px | 每项高度 36→44，列表随之变长、在滚动容器内可滚；无溢出 / 错位 |
| 深 | `shell-ui-kit` desktop | faint / 徽章 / 表单 | 与 before 一致，faint 略亮 |
| 深 | `settings-subscription-dialog` desktop | 「当前」徽章 | 由白字变近黑字压浅紫，可读性明显提升 |
| 深 | `org-center-wizard` desktop | 步骤圆点 active 态 | 「1」由白变近黑，其余无变化 |
| 深 | `media-task-center` desktop | Sheet header / warning 提示 / faint | 无变化（兜底逻辑不改渲染） |
| 深 | `sidebar-overview` desktop | 选中行时长 faint、徽章 | faint 略亮、可读；无布局变化 |
| 深（复扫修正后补看） | `messages-timeline-rich` desktop（`after\`） | 代码块 literal `undefined` / 关键字 / 数字 | literal 已回到深色绿 `#3dbe7e`（第 1 轮里掉成浅色档 `#177b4a` 3.7:1），四类 token 可分辨；其余无变化 |

### 4.5 复扫指标（`scan.mjs`，257 场景，桌面浅/深 + 移动）
before = integration @`c034f05d7`（`scan-before\`），after = 本分支 HEAD（`scan-after\`）；对比脚本 `compare.mjs`，输出 `compare.txt`。

| 指标 | before | after | 变化 |
|---|---|---|---|
| 浅色文本对比度 <4.5 命中（cL） | 356 | 58 | −298（−84%） |
| 深色文本对比度 <4.5 命中（cD） | 111 | 81 | −30（−27%） |
| 移动端 44px 触控命中（t44） | 493 | 419 | −74（−15%） |
| 桌面 24px 拥挤触控命中（t24 crowded） | 0 | 0 | — |
| 无名控件（names / CDP ax） | 16 / 3 | 16 / 3 | 不在本条范围（模块项） |
| Tab 走查异常（tabBad） | 12 | 13 | +1 = Radix 焦点护栏 0×0 span 的计数抖动（见下），非真实问题；其余 12 条不在本条范围 |
| 渲染失败场景 | 0 | 0 | — |

- 对比度：after 的 fg/bg 组合浅色 91 → 25、深色 30 → 24；after 里「before 没有的组合」逐条核对，全部是**同一元素因 token 变化导致合成色 hex 平移**（opacity 降色的禁用行 / 锁定行、`bg-accent/15` 自定底、RepoPill / RepoStatusBanner 的 opacity 文本），每一条都对应 before 中一个已清零组合且比值持平或上升；**hljs 相关命中浅色 / 深色均为 0**（第 1 轮的 5 条深色 hljs 回归与 3 条 4.47 边缘命中已清）。
- 触控：after **无新增**尺寸组合；清零 5 组（DropdownMenu 项 36/38px ×17、Switch 44×40 ×55、SegmentedControl 68×36 ×2）。
- 逐场景：after 任一指标高于 before 的场景仅 1 个 —— `tutorials-help-menu-open` tabBad 1→2，多出的那一条是 Radix FocusScope 护栏 `<span>`（0×0、无类名、无可访问名）的计数抖动（第 1 轮复扫同场景 1→1），`report.mjs` 本就把 `focusable-invisible` 排除在问题外；**对比度与触控没有任何场景上升**。

---

## 5. 仍遗留 / 跨模块同源项（不在本条边界，逐条给 owner）

复扫 after 里剩下的对比度命中**没有一条根因在 token / 原语层**，全部是模块内写法（opacity 降色、`bg-accent/15` 自定底、沉浸式黑底上的 `text-white/xx`）。按任务边界不越界改，列给 a11y-mod-a / a11y-mod-b：

| 归属 | 文件:行 | 现象 | 一句修法 |
|---|---|---|---|
| org（a11y-mod-a） | `components/org/OrgSubscribeDialog.tsx:173` | 「当前」徽章 `bg-accent text-white`，深色 2.82（复扫 after 唯一剩下的白字压 accent 文本命中） | `text-white → text-accent-fg` |
| manage（a11y-mod-a） | `components/manage/OptimizationPanel.tsx:296` | 图标块 `bg-accent text-white`（非文本，深色 2.82 <3:1） | 同上 |
| settings（a11y-mod-a） | `components/settings/ApiKeysSection.tsx:468` | 图标块 `bg-accent text-white` | 同上 |
| settings（a11y-mod-a） | `ApiKeysSection.tsx:933`（整行 `opacity-60`）、`:1033`「设置上限」 | 已禁用密钥行整行降色 2.9 / 「已禁用」徽章 2.5（t-762 settings#3/#6） | 只降装饰、文字改 `text-muted` |
| composer（a11y-mod-a/b 视归属） | `components/AgentPicker.tsx:148` | `bg-accent/15 text-accent` 「默认」4.40 | 底改 `bg-accent-soft`（8%）即 ≥4.7 |
| composer | `components/ModelSelector.tsx:412-425`、`:76` | 锁定 / 不可用模型行靠 faint + opacity 降色（3.8–4.0；徽章 2.4） | t-762 composer#2：保留 `text-muted` 正文 + 图标表状态 |
| messages（a11y-mod-b） | `components/optionsGroup.tsx:173`、`components/RichBlocks.tsx:249,267` | 选项组「发送选择」按钮 / 勾选框 `bg-accent text-white` | `text-accent-fg` |
| media（a11y-mod-b） | `components/ImageCommentMode.tsx:332,410`、`ImageAnnotationEditor.tsx:905,1045`、`ImageResizeMode.tsx:235` | 沉浸式底上 `bg-danger text-white`（深色 3.07）与 `bg-danger/25` 白字 | `text-danger-fg`；`/25` 底改实色 soft |
| media（a11y-mod-b） | `MediaTaskCenter.tsx:436` | Sheet Content 自带 `overflow-y-auto`，header 随内容滚（media#1） | header `shrink-0` 固定 + body 滚动；本条已在 Sheet 原语兜底「越界滚回」，即便不拆也不再丢焦点 |
| sidebar（a11y-mod-a） | `components/github/RepoPill.tsx:69,72,76`、`RepoStatusBanner.tsx:59,66` | `opacity-70/80` 降色 2.5–4.0（sidebar#1/#2） | 去 opacity，用 `text-muted` / `text-danger` 实色 |
| market（a11y-mod-a） | `marketplace/ReviewPanel.tsx` RevokeBox「下架」、Installed「卸载」 | 禁用态按钮走 opacity（2.5） | Button 禁用态本就 `opacity-50`，属全站禁用态例外；如需可读改 `text-muted` 实色 |
| kp-automation（在跑任务文件，不碰） | `settings/KnowledgePlanetAutomationPanel.tsx:700` | 勾选态 `bg-accent text-white` | `text-accent-fg`，交该任务 owner |

其余 after 命中（沉浸式编辑器 `text-white/35~50`、AuthGate 深色 `#848489/#f2f2f6` 主按钮 3.35 ×42 等）与 before 完全相同，均为模块内既有项，已在 t-762 各模块小节登记。

---

## 6. 交付清单

- 分支 `feat/v5-selfhost-audit-a11y-shell` @ `8986e7cd2（代码 HEAD；本文档的 docs 提交紧随其后，最终 SHA 见 complete_task 交付）`（已 push，基点 `c034f05d7`），9 个提交（每项单独提交，无 `fix(v5)`，未碰 changelog.json）：
  1. `d30ed780e` style(v5): 语义色与 faint token 压暗（#3/#4）
  2. `f953ad964` style(v5): 浅色代码高亮四组达 4.5（#2）
  3. `15a5da49a` style(v5): 全站 `::placeholder` 收敛到 `--faint`（#5）
  4. `0557d6026` style(v5): 深色 accent/danger 填充块白字改 `-fg`（#1/#11）
  5. `2cfe3abfd` feat(v5): TimeAgo `<time dateTime>` + 读屏绝对时间（#6）
  6. `fa54040d2` feat(v5): Modal/Sheet 焦点回绕滚回 + 纯文本正文可聚焦（#7/#8）
  7. `acff6f0b7` style(v5): DropdownMenu/SegmentedControl/Switch 触屏 44px（#9）
  8. `e62bdfb12` feat(v5): Toast 悬停/聚焦暂停（#10）
  9. `8986e7cd2` style(v5): hljs 深色档补齐 + 浅色再压一档；两处同文件漏网 `-fg`（#2/#1 复扫修正）
- 改动文件（20 = 19 个代码 / 用例文件 + 本文档）：`packages/web-react/src/styles.css`；`components/ui/{a11y.ts(新), a11y.test.tsx(新), Modal.tsx, Sheet.tsx, TimeAgo.tsx, Toast.tsx, Toast.test.tsx, DropdownMenu.tsx, SegmentedControl.tsx, Switch.tsx, formControls.test.tsx, dataDisplay.test.tsx}`；`components/ChatHeader.tsx` + `ChatHeader.test.tsx`；`components/settings/{SubscriptionDialog,PreferencesTab}.tsx`；`components/org/CreateOrgWizard.tsx`；`components/taskboard/TicketCard.tsx`；`docs/audit/a11y-shell.md`（本文）。
- 未改：应用壳入口组件（App.tsx 等）、在跑任务文件（教程中心、HUD、权限卡、知识星球面板、demo/optionsGroup）、任何分支合入。
- 仓库外产物：`.audit-tmp\a11y-shell\{before, after-typical, after, scan-before, scan-after-r1, scan-after, compare.mjs, compare-r1.txt, compare.txt, typecheck.log, vitest-ui.log, vitest-full.log, test-browser.log, shoot-before.log, shoot-after-typical.log, shoot-after.log}`。
