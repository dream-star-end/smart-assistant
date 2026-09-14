# A·shell 应用壳层与设计系统 · 审计报告

- 分支：`feat/v5-selfhost-audit-shell`（基线 `210b9967892b3624fb3984f69d2174e4a641b33d`）
- 阶段：A（只审计，不改业务代码）
- 结论：**P1 × 1 / P2 × 8 / P3 × 11**，共 20 条。P1 是桌面端 `⌘K` 会把整页点死。

---

## 1. 范围与文件清单

本轮覆盖 `packages/web-react` 的应用壳层与设计系统底座，即「不属于任何一个业务面板、
但所有面板都踩在上面」的那一层。

| 类别 | 文件 |
|---|---|
| 应用壳 | `src/App.tsx`（4039 行）、`src/App.test.tsx`、`src/main.tsx`、`src/registerSW.ts`、`index.html`、`vite.config.ts` |
| 设计 token | `src/styles.css`（828 行）、`src/test/designTokens.test.ts` |
| 原语层 | `src/components/ui/**`（Alert / Avatar / Badge / Button / Card / Chip / ConfirmDialog / CopyChip / DescriptionList / DropdownMenu / Field / IconButton / Input / ListSkeleton / Modal / Pagination / Panel / Popover / Progress / ProjectScopeSelect / SegmentedControl / Select / Sheet / Skeleton / Spinner / StatCard / Switch / Tabs / Textarea / TimeAgo / Toast / Toolbar / Tooltip） |
| 壳层组件 | `src/components/{ChunkErrorBoundary,ThemeToggle,BrandMark,EmptyState,ErrorBanner,UpdateBanner}.tsx` |
| 壳层 hook | `src/hooks/{useAppRoute,useTheme}.ts` |
| 壳层 lib | `src/lib/{api,types,utils,productCapabilities,appUpdate,brand,hotkeys,clientFriction,firstScreenBudget,demo,identityCompat,incidentStore,implicitFeedback,collaborationConfig,forbidTaskboardEntryImport}.ts`、`src/workers/**` |

审计维度按 PLAYBOOK §5 的七项清单逐项过：UI/视觉、响应式/移动端、交互友好性、
功能正确性、可访问性、文案、代码质量。

**不在本轮范围**：各业务面板自身（messages / composer / sidebar / manage / market /
settings / taskboard / landing / media / tutorials 各有 owner）、`src/admin/**`、
需要改协议或后端才能修的问题。

---

## 2. 方法与证据

### 2.1 新增的 ui-preview 场景

新增 `browser-tests/ui-preview/scenes-shell.tsx`，6 个场景。这些界面在真机上要么藏在
条件分支深处（chunk 加载失败、横幅全开），要么根本不会同时出现，摆到静态页上才能
一次性比对明暗两套主题：

| 场景 id | 内容 | 视口 |
|---|---|---|
| `shell-global-banners` | 输入框上方的全局横幅栈（休眠 + 重连 + 更新 + 发送失败 + 输入框） | desktop / mobile |
| `shell-empty-state` | 空会话欢迎页（真 `EmptyState`） | desktop / mobile |
| `shell-chunk-error-stale` | `ChunkErrorBoundary` 的「已发布新版本」兜底屏 | desktop / mobile |
| `shell-chunk-error-generic` | `ChunkErrorBoundary` 的通用渲染错误兜底屏 | desktop |
| `shell-ui-kit` | 设计系统原语总览（Button / IconButton / Badge / Chip / Alert / 表单控件 / Progress / Skeleton / Spinner / 排版档位 / 语义前景色） | desktop / mobile |
| `shell-landing-tokens` | `.congjian-landing` 营销主题下的 info/success/warning/danger 四档对照 | desktop / mobile |

场景全部渲染真实组件 + 真 production CSS，数据是就地写死的桩，未新增 api-stub 条目
（`api: {}`，manifest 的 `unmockedApi` 为空）。

### 2.2 截图基线

```
D:\code\test_project\test123\.audit-tmp\shell\before\
```

22 张 PNG（6 场景 × desktop/mobile × light/dark，`shell-chunk-error-generic` 只出
desktop），外加 `manifest.json`。复跑命令：

```powershell
cd d:\code\test_project\test123\wt\shell\packages\web-react
$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:OC_UI_SHOTS='D:\code\test_project\test123\.audit-tmp\shell\before'
$env:OC_UI_SCENES='shell-'
node browser-tests\ui-preview\shoot.mjs
```

直接充当证据的几张：

- `shell-global-banners--mobile--light.png` —— 390×844 下横幅栈吃掉约 560px，对话区
  只剩顶部三分之一（S-06）。
- `shell-landing-tokens--desktop--light.png` —— danger 一行的亮度明显不属于营销主题
  那套色，info/success/warning 三行是亮绿/亮琥珀/亮青，danger 是暗红（S-04）。
- `shell-ui-kit--desktop--dark.png` —— 暗色下「删除」按钮是浅红底 + 白字（S-03）。
- `shell-ui-kit--mobile--light.png` —— 触屏下 Button/IconButton 都升到 44px，
  Chip 停在 36px，一排对比一眼可见（S-14）。
- `shell-empty-state--mobile--light.png` —— 「为这次会话设定目标」是 11px 纯文字链接，
  命中区远低于 44px（S-09）。

### 2.3 跑过的验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿 |
| 代码风格 | `npx biome check browser-tests/ui-preview/scenes-shell.tsx` | ✅ 绿 |
| 视觉基线 | `node browser-tests/ui-preview/shoot.mjs` | ✅ 22 张全部成功，0 失败 0 重试 |
| S-01 取证 | 一次性 jsdom 探针（已删除，不提交） | 见下 |

S-01 的取证脚本挂载一个与 `App.tsx:3368` 同构的 `md:hidden` Sheet 并读取 DOM：

```
[audit] before open, body.pointerEvents = ""
[audit] after open,  body.pointerEvents = "none"
[audit] after open,  sibling aria-hidden = "true"
```

即：抽屉一开，`<body>` 的指针事件被 Radix 的 `DismissableLayer` 关掉、其余内容被
`aria-hidden`，而抽屉本身在桌面断点是 `display:none`。

**未跑**（`NOT RUN`）：

- `npm test`（全量 web-react 单测）—— 阶段 A 未改任何业务代码与既有测试，
  跑全量对本轮结论不增加信息；阶段 B 改代码时必跑。
- `npm run test:browser` —— 同上，且本轮未触碰 Composer/消息/工具卡/侧栏交互面。
- 真机 iOS Safari —— 本机网络受限，safe-area / visualViewport 相关结论（S-11）
  只经代码审阅与 Chromium 移动模拟，未在真 iOS 上复核。

---

## 3. 问题清单

严重度：**P1** 功能不可用/阻断主流程；**P2** 明显体验缺陷/一致性破坏/移动端不可用；
**P3** 打磨项。

| 编号 | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| S-01 | `src/App.tsx:2022-2031` + `src/App.tsx:3368-3375` + `src/components/ui/Sheet.tsx:58-68` | `⌘K/Ctrl+K` 的 search 分支无条件 `setMobileNavOpen(true)`，而该 Sheet 带 `md:hidden`。桌面断点下抽屉与遮罩都是 `display:none`，但 Radix 模态照常把 `<body>` 设成 `pointer-events:none`、其余内容设成 `aria-hidden="true"` | 桌面端按下 `⌘K` 后**整页鼠标点不动、读屏读不到**，看不见任何弹层，只有 Esc 能解。搜索框虽被 `focus()`，但焦点还会被 Radix FocusScope 往回拽 | **P1** |
| S-02 | `src/App.tsx:2979-2989`、`src/lib/hotkeys.ts:14` | Esc 有两个持有方：Radix 弹层的关闭，和挂在 `window` 上的 `stopTurn`。后者不判断此刻是否有弹层打开 | 生成中打开任意对话框后按 Esc 关闭，会**连带掐掉正在生成的这一轮**；从 S-01 的卡死状态里按 Esc 自救同样会掐掉生成 | P2 |
| S-03 | `src/components/ui/Button.tsx:47`、`src/styles.css:175` | `danger` 变体写死 `text-white`。暗色主题的 `--danger` 是**为前景用途调亮过**的 `#f0666e`，配白字实测 **3.07:1** | 暗色下所有破坏性按钮（删除会话/删除项目/解绑仓库…）文字不达 AA 4.5:1。`designTokens.test.ts` 只校验「语义色作前景」，唯一的填充用法不在守卫内 | P2 |
| S-04 | `src/styles.css:332-396` | `.congjian-landing` 就地重定义了 20 个语义 token（含编译后的 `--color-*` 双写），**唯独漏了 `--danger` / `--danger-soft`** | 营销壳内任何错误态会回落 `:root` 的浅色主题红，压在近黑画布上约 **3.9:1**；`--danger-soft`（8% alpha）在近黑底上几乎不可见。见 `shell-landing-tokens` 截图 | P2 |
| S-05 | `src/test/designTokens.test.ts:83-86`、`src/styles.css:345`、`src/styles.css:491-511` | 对比度契约只解析 `:root` 与 `.dark`。仓内实际有**四套**完整 token：另外两套是 `.congjian-landing` 与 `.preview-shell`，零守卫 | `.congjian-landing` 的 `--faint:#777d73` 实测 vs `--surface` **4.38:1**、vs `--elevated` **4.16:1**，均低于 AA。同类回归今后仍无人拦 | P2 |
| S-06 | `src/App.tsx:3676-3749` | 输入框上方的 `composer-safe-b` 容器里依次挂着 dormant 提示 / TurnCostReminder / 连接状态 / UpdateBanner / ErrorBanner，**彼此不互斥、无条数上限、无折叠** | 容器休眠 + 断线重连 + 有新版本 + 上一条发送失败同时成立时（都是常见组合），390×844 实测横幅吃掉 ~560px，对话区只剩顶部三分之一。见 `shell-global-banners--mobile-*` | P2 |
| S-07 | `src/components/ui/Alert.tsx:76` | `Alert` 原语无条件 `role="alert"`，该 role 隐含 `aria-live="assertive"` | 挂载即存在的静态说明（`tone="info"` 的「容器已休眠…」等）会被读屏当成打断式播报；S-06 那一屏一次性触发 4 条 assertive | P2 |
| S-08 | `src/hooks/useAppRoute.ts:373-380`（镜像）+ `:277-307`（popstate） | 打开设置/管理/市场/组织/教程只做 `replaceState`，不压历史栈 | 移动端系统返回手势**不会**只关面板：它会回到上一条历史（上一个会话），`onPopPanel` 顺手关掉面板 —— 一次返回同时「关面板」+「换会话」，用户丢失当前上下文 | P2 |
| S-09 | `src/components/EmptyState.tsx:52-60`、`src/components/ChunkErrorBoundary.tsx:67-76` | 「为这次会话设定目标」是 11px 裸 `<button>`，无触控靶兜底；`ChunkErrorBoundary` 全屏兜底屏上**唯一**的「刷新」按钮是裸 `<button>`（`py-2` + `text-body` ≈ 36px） | 触屏上都低于 44px 命中标准。后者尤其严重 —— 它是整页白屏的唯一出口，点不中等于没有出口 | P2 |
| S-10 | `src/App.tsx:3461`、`src/components/EmptyState.tsx:25` | App 为读屏定位渲染了 `<h1 class="sr-only">{会话标题}</h1>`，空会话时 `EmptyState` 又渲染一个可见 `<h1>{agent.name}</h1>` | 同一文档两个 h1，读屏的文档大纲出现两个并列一级标题，"当前在哪个会话"的定位反而被稀释 | P3 |
| S-11 | `index.html:6`、`index.html:18-29`、`src/hooks/useTheme.ts:15-17` | 静态 `theme-color` 写的是营销页黑 `#090a08`；首屏内联脚本**只在 dark 时**改写它；`useTheme` 挂载后又写 `#0c0c11`/`#fafafb` | 浅色主题用户直接进工作区（静默续期成功）时，状态栏/地址栏先是纯黑、hydrate 后才跳到近白；深色用户也要从 `#090a08` 跳到 `#0c0c11`。正是这段内联脚本本想消灭的那类闪烁 | P3 |
| S-12 | `src/hooks/useTheme.ts:6-8` | `(localStorage.getItem("oc_theme") as Theme) \|\| "system"` 不做取值校验，也没有 `storage` 事件跨标签同步 | 存进脏值（旧版本遗留/手工改）时 `classList.toggle("dark", false)` 强制浅色、忽略系统偏好，且 `ThemeToggle` 的 title 会渲染成「主题：undefined，点击切换到 undefined」；多标签页主题各走各的直到刷新 | P3 |
| S-13 | `src/components/UpdateBanner.tsx:19-33` | 文案「新版本已就绪**,**刷新页面即可更新。」用了半角逗号（全站中文文案用全角）；「立即刷新」「稍后」是裸 `<button>`，不走 `Button`/`IconButton` 原语 | 文案与全站不一致；两个动作没有触控靶兜底、没有 `focus-visible` 焦点环。移动端截图里「稍后」还会掉到第二行、左对齐到图标列下方，与「立即刷新」看着不像一组 | P3 |
| S-14 | `src/components/ui/Chip.tsx:17` | Chip 的触屏兜底是 `[@media(hover:none)]:min-h-9`（36px），而 Button/IconButton/Input/Textarea/Select 全是 44px | 同一批可点元素在触屏上两套命中标准；Chip 恰恰是筛选场景里最密集、最需要命中面积的那个。见 `shell-ui-kit--mobile-*` | P3 |
| S-15 | `src/components/EmptyState.tsx:25-27`、`:40-48` | 起步语卡片是 `<button>` 但没写 `type="button"`（全仓其余可点元素都显式写了）；标题/描述/卡片用 `text-[26px]`/`text-[15px]`/`text-[14px]` 任意值，不走 `styles.css` 的语义字号档位 | 前者是潜在的表单内误提交（当前不在 form 内，属隐患）；后者是 styles.css 注释里明确要收敛的那类任意值，欢迎页是新用户第一屏，字号漂移最显眼 | P3 |
| S-16 | `src/App.tsx:229-247` | `prefetchLazyCentersOnIdle` 在空闲期无条件预取 8 个懒块，没有 `navigator.connection.saveData` / `effectiveType` 判断 | `vite.config.ts` 的 460KB 首屏门只管**静态闭包**；弱网/省流量模式下用户仍会在后台下完全部中心。注释里「弱网下预取失败静默」说的是失败兜底，不是不发起 | P3 |
| S-17 | `src/components/ui/Sheet.tsx:27-28` | `side="bottom"` 给了 `max-h-[85dvh]`，但原语本身没有滚动容器（base 只有 `flex flex-col`） | 内容超过 85dvh 时直接裁掉且无法滚到 —— 当前调用方各自带了滚动容器所以没爆，但这是原语该保证的不变量，下一个调用方会踩 | P3 |
| S-18 | `src/components/ChunkErrorBoundary.tsx:62` | 同一个组件里第 59 行用 `text-title`、第 73 行用 `text-body`，中间第 62 行却是 `text-[13px]` 任意值 | 语义档位的收敛在这一处破了口；`text-[13px]` 恰好等于 `text-body`，改了也零视觉差 | P3 |
| S-19 | `packages/web-react/tsconfig.json:21` | `"include": ["src"]` —— `browser-tests/**`（含本轮新增的 ui-preview 场景）不在类型检查范围内 | `npm run typecheck` 绿不代表预览台场景类型正确；场景里写错 prop 只能等 `shoot.mjs` 运行期报错。本轮的 `Select onChange→onValueChange` 就是这么发现的 | P3 |
| S-20 | `src/components/ThemeToggle.tsx:43-46`、`src/components/ui/Toast.tsx:128` | 每次点击主题按钮都弹一条 toast；主题是三态循环，想从「浅色」回到「浅色」要点 3 次 = 弹 3 条。toast 轨道固定 `top-16`，与 ChatHeader 高度是两处各写各的 | 主题切换的结果（整页变色）本身就是最强反馈，再加 toast 属于冗余打扰；`top-16` 与真实头部高度解耦，头部一改高度 toast 就会压上去或悬空 | P3 |

---

## 4. 修复计划

### S-01 ⌘K 在桌面打开移动抽屉 → 整页点死（P1，必修）

- **改**：`src/App.tsx`（search 分支）。
- **怎么改**：搜索分支不再无条件开抽屉，按视口分流 —— 桌面（`isMdViewport`，App 里
  已有该值）只 `setCollapsed(false)` 展开内联侧栏；窄屏才 `setMobileNavOpen(true)`。
  焦点查找逻辑保持不变（它本来就只挑可见的那个 `[data-sidebar-search]`）。
- **补测试**：
  1. `src/App.test.tsx` 加一例：桌面视口下派发 `⌘K`，断言 `document.body.style.pointerEvents`
     不为 `"none"`、且侧栏搜索框拿到焦点；
  2. 同文件加窄屏一例：断言抽屉打开。
  3. `browser-tests/ui-preview/scenes-shell.tsx` 加一个 `shell-mobile-drawer-on-desktop`
     场景留作视觉回归。
- **风险**：低。`isMdViewport` 在首帧可能还没落定，需确认 `useMdViewport` 的初值
  取自 `matchMedia` 同步读取而非 `false`，否则桌面首帧仍会走窄屏分支。

### S-02 Esc 双持有方（P2，必修）

- **改**：`src/App.tsx`（Esc effect）、`src/lib/hotkeys.ts`。
- **怎么改**：`resolveGlobalHotkey` 的 `opts` 增加 `dialogOpen?: boolean`，Esc 分支在
  `dialogOpen` 为真时返回 `null`（把「此刻 Esc 归谁」变成纯函数可测的判断）。App 侧用
  `document.querySelector('[role="dialog"],[role="alertdialog"]') !== null` 计算实参 ——
  Radix 弹层都带这两个 role，不必逐个面板维护布尔量。
- **补测试**：`src/lib/hotkeys.test.ts` 加两例（`sending && dialogOpen` → null；
  `sending && !dialogOpen` → `"stop"`）。
- **风险**：低。唯一要确认的是 Toast 的 `role="alert"`/`role="status"` 不会误判成弹层
  （不会，两者都不是 dialog role）。

### S-03 暗色 danger 按钮 3.07:1（P2，必修）

- **改**：`src/styles.css`（新增 `--danger-fg` / `--color-danger-fg`，明暗各一档）、
  `src/components/ui/Button.tsx:47`（`text-white` → `text-danger-fg`）、
  `src/test/designTokens.test.ts`（新增「填充用法」契约）。
- **怎么改**：浅色 `--danger-fg: #ffffff`（维持现状，5.09:1）；暗色取近黑
  `#15151c`（与 `--accent-fg` 同族），配 `#f0666e` 实测约 **8.5:1**。命名与既有
  `--accent-fg` / `--primary-fg` 对齐，不引入新概念。
- **补测试**：`designTokens.test.ts` 加一组 `it.each(["danger"])`：
  `contrast(parseHex(t["danger-fg"]).rgb, parseHex(t.danger).rgb) >= 4.5`，
  并顺手把 `accent-fg vs accent`、`primary-fg vs primary` 一起纳入（同类风险）。
- **风险**：中。暗色破坏性按钮从「白字」变「深字」是可见视觉变更，需出 after 截图
  给指挥官过目；`shell-ui-kit` 场景已覆盖，before 图已在基线里。

### S-04 营销主题漏 `--danger`（P2，必修）

- **改**：`src/styles.css:332-396`。
- **怎么改**：在 `.congjian-landing` 块内补 `--danger` / `--danger-soft` 及编译后的
  `--color-danger` / `--color-danger-soft` 四条，取值向该主题的亮度基准靠（如
  `#ff8d80` 一类的暖红，与 `--success:#8de68f` / `--warning:#f6c66a` 同族亮度），
  并让它对 `--surface:#121410` 与 `--elevated:#171a15` 都过 4.5:1。
- **补测试**：并进 S-05 的参数化契约，营销主题一并纳入 `THEMES`。
- **风险**：低。该块只被 `Landing.tsx:290` 使用，影响面收敛在营销页。

### S-05 对比度契约只守两套主题（P2，必修）

- **改**：`src/test/designTokens.test.ts:83-86`。
- **怎么改**：`THEMES` 扩成四项，加 `{ name: "landing", selector: ".congjian-landing" }`
  与 `{ name: "preview", selector: ".preview-shell" }`。`.preview-shell` 的 token 前缀是
  `--preview-*` 且部分用 `rgba()`，需要给 `tokensOf` 加一个可选的前缀参数并让
  `parseHex` 容忍 `rgba()`（或先只纳入其中的十六进制项，`rgba` 项单列 TODO）。
  纳入后预计 `.congjian-landing --faint` 立即转红（4.38 / 4.16），一并调到达标值。
- **补测试**：本条本身就是测试；补一条「四套主题的 token 键集合一致」的断言，
  这样 S-04 那种「漏写一个 token」以后会被直接拦下，而不是靠人眼看截图。
- **风险**：中。放开守卫后可能连带暴露 `.preview-shell` 的存量不达标项；
  若数量超出本批预算，`.preview-shell` 可先 `it.skip` 并在文档记为遗留，
  但 `.congjian-landing` 必须当批修完。

### S-06 横幅栈无上限（P2，必修）

- **改**：`src/App.tsx:3676-3749`；可能新增 `src/lib/bannerStack.ts`（纯函数）。
- **怎么改**：把「此刻该显示哪些横幅」抽成纯函数 `resolveBanners(state)`，定一条优先级
  （阻断性 > 可恢复错误 > 提示性：`chatError` > 连接状态 > dormant > 更新 > 成本提醒）
  并**同屏最多 2 条**，其余折叠成一行「还有 N 条提示」可展开。折叠条复用 `Alert`
  的 `action` 槽，不新造样式。
- **补测试**：`src/lib/bannerStack.test.ts` 覆盖「五条全开 → 取前 2 + 折叠条」
  「只有 1 条 → 不出折叠条」「错误恒在最上」；`scenes-shell.tsx` 的
  `shell-global-banners` 场景改成折叠后形态，出 after 图对比。
- **风险**：中。改的是主流程可见区，需确认折叠不会把「断线」这类必须立刻看见的
  状态藏起来 —— 所以优先级表要写进注释并被测试钉死。

### S-07 Alert 恒为 assertive（P2，必修）

- **改**：`src/components/ui/Alert.tsx:76`。
- **怎么改**：加 `live?: "assertive" | "polite" | "off"` 轴，默认按 tone 推导：
  `danger`/`warning` → `role="alert"`（保持现状）；`info`/`success` → `role="status"`
  （隐含 polite）。需要打断的调用方显式传 `live="assertive"`。
- **补测试**：`src/components/ui/surfaces.test.tsx` 加两例断言 role 随 tone 变化；
  并加一例「显式 live 覆盖默认」。
- **风险**：低。role 变化不影响视觉，存量 danger/warning 调用零行为变化。

### S-08 面板不进历史栈（P2，必修）

- **改**：`src/hooks/useAppRoute.ts:373-380`。
- **怎么改**：面板镜像从 `replaceState` 改成「打开时 `pushState`、关闭时
  `history.back()`（若栈顶正是本面板）否则 `replaceState`」。判据用 `history.state`
  里打一个 `{ ocPanel: <name> }` 标记，避免误吃用户的其它历史条目。
- **补测试**：`src/hooks/useAppRoute.test.ts`（若无则新建）覆盖「开面板压栈 →
  popstate 只关面板、不换会话」「连开两个面板 → 后退逐层关」「深链直接带 `?panel=`
  进入 → 后退回到 `/` 而非空栈」。
- **风险**：**高**。历史栈语义是 boss 2026-07-02 定夺过的（「后退 = 上一个会话」），
  改动会与那条约定交叉。**建议阶段 B 开工前先 `ask_decision` 确认**：面板是否应该
  占历史栈。若判定不改，本条转入「暂缓」并在文档写明。

### S-09 触控靶不足（P2，必修）

- **改**：`src/components/EmptyState.tsx:52-60`、`src/components/ChunkErrorBoundary.tsx:67-76`。
- **怎么改**：两处裸 `<button>` 换成 `ui` 原语 —— 目标链接用 `Button variant="link" size="sm"`
  （原语自带 `[@media(hover:none)]:min-h-11`），兜底刷新键用 `Button variant="primary" size="md"`。
  `ChunkErrorBoundary` 是 class 组件但 `Button` 是普通函数组件，直接用即可；
  `autoFocus` 通过 props 透传保留。
- **补测试**：`src/components/ChunkErrorBoundary.test.tsx`（若无则新建）断言兜底屏
  渲染出 `role="button"` 且带 `autofocus`；EmptyState 侧走 `shell-empty-state` 场景
  的 after 截图目测。
- **风险**：低。唯一要验的是 `ChunkErrorBoundary` 引入 `ui` 依赖后不会把原语层
  拖进某个不该有它的 chunk —— 该文件已被入口静态引用，原语层也在入口，无新增边。

### S-10 双 h1（P3）

- **改**：`src/components/EmptyState.tsx:25`。
- **怎么改**：`<h1>` → `<h2>`（欢迎页标题在语义上从属于当前会话），App 侧的 sr-only
  h1 保持不动（注释里写明它是读屏定位锚点）。
- **补测试**：`src/App.test.tsx` 已有「工作区 h1=0」类探针的注释痕迹，补一例
  「空会话时 `getAllByRole('heading', { level: 1 })` 长度为 1」。
- **风险**：低。字号由 className 决定，改标签零视觉差。

### S-11 theme-color 首帧闪烁（P3）

- **改**：`index.html:6`、`index.html:18-29`。
- **怎么改**：内联脚本改成**两个分支都写**：`tc.setAttribute("content", dark ? "#0c0c11" : "#fafafb")`，
  与 `useTheme.ts:15-17` 取同一对值。静态 meta 的默认值保持 `#090a08`
  （首屏是营销页时正确），脚本在任何情况下都会覆盖它。
- **补测试**：无法用 jsdom 覆盖内联脚本；改为在 `src/hooks/useTheme.ts` 旁加一条
  纯函数 `themeColorFor(dark: boolean)` 并让内联脚本与 hook 的取值写进同一条单测
  （脚本侧靠注释指向该函数，值漂移时测试会红）。
- **风险**：低。

### S-12 主题取值不校验 / 不跨标签同步（P3）

- **改**：`src/hooks/useTheme.ts:6-8`。
- **怎么改**：抽 `parseTheme(raw: string | null): Theme`，非三值之一一律回落 `"system"`；
  effect 内加 `window.addEventListener("storage", …)`，键为 `oc_theme` 时同步 setState。
- **补测试**：`src/hooks/useTheme.test.ts`（若无则新建）覆盖「脏值 → system」
  「storage 事件 → 状态跟随」。
- **风险**：低。

### S-13 UpdateBanner 文案与原语（P3）

- **改**：`src/components/UpdateBanner.tsx:19-33`。
- **怎么改**：半角逗号改全角；两个动作换成 `Button variant="link" size="sm"` 与
  `Button variant="ghost" size="sm"`，放进 `Alert` 的 `action` 槽（原语已负责窄屏换行
  与右对齐），删掉手写的 `flex flex-wrap`。
- **补测试**：`shell-global-banners` 场景的 after 截图；另加一例断言两个按钮可被
  `getByRole("button", { name: "立即刷新" })` 取到。
- **风险**：低。

### S-14 Chip 触控靶 36px（P3）

- **改**：`src/components/ui/Chip.tsx:17`。
- **怎么改**：`min-h-9` → `min-h-11`，与其余原语对齐。
- **补测试**：`src/components/ui/selection.test.tsx` 加一例断言类名含 `min-h-11`；
  `shell-ui-kit--mobile-*` 出 after 图。
- **风险**：中。Chip 用在密集筛选行里，加高 8px 会让若干面板的筛选条变高 ——
  **属于跨模块影响**，改前需 `send_to` manage / market owner 知会，或在
  `ask_decision` 里一并确认。

### S-15 EmptyState 任意值与 type（P3）

- **改**：`src/components/EmptyState.tsx:25-27`、`:40-48`。
- **怎么改**：起步语卡片补 `type="button"`；`text-[26px]`→ 保留（无对应语义档，
  属 styles.css 注释里点名"待单独定名"的区间，本批不动）、`text-[15px]`/`text-[14px]`
  → `text-title`(15px) / 新档或保留。**结论**：只补 `type="button"`，字号收敛留给
  排版档位专项，避免为一处像素差新增 token。
- **补测试**：`shell-empty-state` 场景 after 图。
- **风险**：低。

### S-16 空闲预取无网络判断（P3）

- **改**：`src/App.tsx:229-247`。
- **怎么改**：`prefetch` 执行前读 `navigator.connection`，`saveData === true` 或
  `effectiveType` 属于 `slow-2g|2g` 时直接 return（该 API 在 Safari 缺席，
  `?.` 取不到就照常预取，行为不退化）。
- **补测试**：把判断抽成纯函数 `shouldPrefetchCenters(conn)` 放 `src/lib/`，
  单测覆盖三种输入（无 connection / saveData / 2g）。
- **风险**：低。

### S-17 bottom Sheet 无滚动容器（P3）

- **改**：`src/components/ui/Sheet.tsx:27-28`。
- **怎么改**：`bottom` 变体加 `overflow-y-auto overscroll-contain`。
- **补测试**：`src/components/ui/surfaces.test.tsx` 加一例断言类名；另需目测
  `InspectorPanelContent` 在窄屏抽屉里不出现双滚动条（它自带滚动容器）。
- **风险**：中。可能与调用方自带的滚动容器叠成双滚动条，需在真浏览器里看一眼
  （`shell-*` 场景不覆盖，阶段 B 用 `test:browser` 或临时场景验）。

### S-18 ChunkErrorBoundary 任意字号（P3）

- **改**：`src/components/ChunkErrorBoundary.tsx:62`：`text-[13px]` → `text-body`。
- **补测试**：无（像素等价，`shell-chunk-error-*` 的 after 图与 before 应逐像素一致）。
- **风险**：无。

### S-19 browser-tests 不在类型检查内（P3）

- **改**：`packages/web-react/tsconfig.json:21`，或新增 `tsconfig.browser-tests.json`。
- **怎么改**：优先新增独立 tsconfig（`include: ["browser-tests"]`，
  `noEmit`，引用同一份 compilerOptions），在 `package.json` 的 `typecheck` 脚本里
  串一条 `tsc -p tsconfig.browser-tests.json`。**不**直接把 `browser-tests` 塞进
  主 `include` —— 那会把 `.mjs` 驱动脚本与 node 类型一起拖进浏览器编译单元。
- **补测试**：本条本身即测试基建；验收标准是「故意写错一个 prop → typecheck 转红」。
- **风险**：中。首次纳入可能一次性暴露若干存量场景文件的类型错误，
  这些文件分属多个 owner，**需先 `ask_decision`**：是本轮统一修，还是先
  `// @ts-nocheck` 挂起、由各 owner 逐个清。

### S-20 主题切换 toast 冗余（P3）

- **改**：`src/components/ThemeToggle.tsx:43-46`；`src/components/ui/Toast.tsx:128` 的
  `top-16` 抽成 CSS 变量。
- **怎么改**：去掉 `toast(...)` 调用 —— 整页换色本身就是反馈，`aria-label` 已经把
  当前态与下一态念给读屏用户；`top-16` 改成 `top-[var(--oc-toast-top,4rem)]`，
  由 ChatHeader 侧写入实际高度（或至少把 `4rem` 和头部高度放进同一处注释互指）。
- **补测试**：`src/components/ThemeToggle.test.tsx` 加一例断言点击后不产生
  `role="status"` 节点。
- **风险**：低；但「去掉 toast」是产品口味判断，**建议在阶段 B 交付时一并请指挥官确认**，
  而不是自行拍板。

---

## 5. 建议不修 / 暂缓项

| 项 | 理由 |
|---|---|
| **拆分 `App.tsx`（4039 行）** | 它确实过长，但当前结构是「一个组件持有全部跨域状态 + 大量 ref 规避 TDZ」，注释密度很高、每处取舍都有事故背景。拆分属于架构重构，风险面覆盖会话/鉴权/WS/路由全部主流程，与本轮「UI/UX 审计改进」的目标不匹配。建议单列任务、单独评审。 |
| **`Tooltip` 触屏不可达 / 无 `collisionPadding`** | Radix tooltip 在触屏上本就不响应 tap，仓内所有 `IconButton` 都同时给了 `aria-label`，信息没有丢失通道；碰撞内距在现有布局下未观察到溢出。属"理论缺陷、无实证"，不占本轮预算。 |
| **`.preview-shell` 那套 `--preview-*` token 收编进主 token 体系** | 它是刻意「恒深色、不随主题翻转」的独立设计（注释写明了理由），收编会破坏该意图。S-05 只把它纳入**对比度守卫**，不动它的独立性。 |
| **Service Worker 更新流程** | `registerSW.ts` 的注册条件、`updateViaCache:'none'` 与 `appUpdate` governor 的分工清晰，本轮未发现实际缺陷；且 SW 行为要在 https 真环境验证，本机网络受限（PLAYBOOK §1）无法取证。 |
| **`EmptyState` 的 `text-[26px]` 等任意字号** | `styles.css` 已明确记录 16px 及以上的标题区间「待单独定名（如 `--text-lead`）后再收敛」。为一处欢迎页新增 token 会开一个全站波及的口子，应等排版档位专项统一处理。见 S-15 的结论。 |
| **`--warning` 作填充时的对比度** | 与 S-03 同类（`bg-warning` + 白字），但仓内 `bg-warning` 实际调用极少且均为小面积角标。S-03 的 `--*-fg` 方案落地后顺手覆盖即可，不单列条目。 |

---

## 附：阶段 B 开工前需要拍板的事

1. **S-08**：面板是否应占浏览器历史栈？与 boss 2026-07-02「后退 = 上一个会话」的
   定夺有交叉，需确认后再动。
2. **S-14**：Chip 触控靶从 36px 提到 44px 会改变 manage / market 筛选条的高度，
   属跨模块可见变更，需知会对应 owner。
3. **S-19**：`browser-tests` 纳入类型检查后若暴露他人文件的存量错误，是统一修
   还是分派给各 owner。
4. **S-20**：去掉主题切换 toast 属产品口味判断，请指挥官确认。
