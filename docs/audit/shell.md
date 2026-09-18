# A·shell 应用壳层与设计系统 · 审计报告

- 分支：`feat/v5-selfhost-audit-shell`（基线 `210b9967892b3624fb3984f69d2174e4a641b33d`）
- 阶段：A（审计，`de38a312c`）→ **B（修复，见 §6–§8）**
- 结论：**P1 × 1 / P2 × 8 / P3 × 11**，共 20 条。P1 是桌面端 `⌘K` 会把整页点死。
- 阶段 B 结果：**发现 20 / 修复 18 / 暂缓 2**（S-08 等用户拍板；S-20 只做了「顶距解耦」半条，
  「去掉 toast」等用户拍板）。P1/P2 除 S-08 外全部落地并配测试。

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

**指挥官裁决（阶段 B 开工前）**：① S-08 本轮暂缓不动；② S-14 做，44px 是本轮统一标准；
③ S-19 不改主 `tsconfig.json` 的 include，新增独立脚本 `typecheck:preview`，暴露的他人文件
错误不修、列进交付；④ S-20 「去掉 toast」先不动，`top-16` 与头部高度解耦那半可以做。

---

## 6. 修复记录

阶段 B 在同一分支上小步提交（`de38a312c..1da9a0f2b`，共 15 个 commit，subject 一律
`feat/refactor/style/test(v5)`，无 `fix(v5)`）。上一任（opus-5-2，已掉线）留下的未提交半成品
经逐文件 `git diff` 对照本文件 §4 逐条核对、补齐测试与遗漏项后按条目分组提交；本节按 S-xx 记录。

| 编号 | 严重度 | 状态 | 改了哪些文件 | 怎么改 | commit |
|---|---|---|---|---|---|
| S-01 | **P1** | ✅ 修复 | `src/App.tsx`、`src/App.test.tsx` | `⌘K` 的 search 分支按 `isMdViewport` 分流：桌面只 `setCollapsed(false)` 展开内联侧栏并聚焦搜索框，窄屏才 `setMobileNavOpen(true)`；effect 依赖补 `isMdViewport`。`useMdViewport` 走 `useSyncExternalStore` 同步读 `matchMedia`，首帧即正确（§4 的风险点已核实）。App.test 补桌面（断言 `body.style.pointerEvents !== "none"`、搜索框拿到焦点、无 `dialog`）与窄屏（抽屉打开且含 `[data-sidebar-search]`）两例。未另加 ui-preview 场景：静态页无法呈现 `pointer-events` 锁死，jsdom 用例已直接断言该状态。 | `561b3aeb5` |
| S-02 | P2 | ✅ 修复 | `src/lib/hotkeys.ts`、`src/lib/hotkeys.test.ts`、`src/App.tsx` | `resolveGlobalHotkey` 的 `opts` 增 `dialogOpen`，Esc 分支 `sending && !dialogOpen` 才返回 `"stop"`；新增 `isDialogLayerOpen(doc)`（选择器 `[role="dialog"],[role="alertdialog"],[role="menu"]`，比 §4 计划多纳入 DropdownMenu），App 的 Esc effect 在事件时刻调用。测试 +2 例（含 toast 的 `alert`/`status` 不算弹层）。 | `274e11c85`、`561b3aeb5` |
| S-03 | P2 | ✅ 修复 | `src/styles.css`、`src/components/ui/Button.tsx`、`src/test/designTokens.test.ts` | 新增 `--danger-fg` / `--color-danger-fg`：浅色 `#ffffff`（5.09:1），暗色 `#15151c`（≈6:1）；Button `danger` 变体 `text-white → text-danger-fg`。designTokens.test 新增 `FILL_PAIRS` 契约（primary/accent/danger 各配其 `-fg` ≥ 4.5:1）。after 图 `shell-ui-kit--desktop--dark`：「删除」按钮由白字改深字。 | `ee8b65b25` |
| S-04 | P2 | ✅ 修复 | `src/styles.css` | `.congjian-landing` 补 `--danger: #ff8d80` / `--danger-soft: rgba(255,141,128,.12)` / `--danger-fg: #0a0b09` 及三条 `--color-*` 双写，与 success/warning 同亮度带。after 图 `shell-landing-tokens--desktop--light`：四档同一亮度带。 | `ee8b65b25` |
| S-05 | P2 | ✅ 修复 | `src/test/designTokens.test.ts`、`src/styles.css` | `THEMES` 加入 `.congjian-landing`；`tokensOf` 兼容 `rgba()`、跳过 `--color-*` 双写；新增「token 键集合一致」用例（漏写即红）。放开守卫后营销主题 `--faint` 立即转红，`#777d73 → #8a9086`。`.preview-shell` 未纳入（见 §8）。 | `ee8b65b25` |
| S-06 | P2 | ✅ 修复 | 新增 `src/lib/bannerStack.ts`(+test)、`src/App.tsx`、`browser-tests/ui-preview/scenes-shell.tsx` | `resolveBanners(active, expanded)` 纯函数：优先级 `error > connection > dormant > update > cost`，同屏最多 2 条，其余折叠成「还有 N 条提示」，可展开 / 收起（`canCollapse`）。App 把五条横幅的显隐统一交给它，渲染顺序即优先级；`UpdateBanner` 的可见性另订一份 governor 只为计入条数。折叠条是「一行文字 + 行内切换键」（不走 Alert 的 `action` 槽——该槽在 `<sm` 整行换到第二行，after 第一版就是这样两行）。测试 8 例。after 图 `shell-global-banners--mobile-*`：横幅栈由 ~560px 降到 ~390px，error 恒在最上。 | `bc280a16f`、`561b3aeb5`、`df7b2be2d`、`1da9a0f2b` |
| S-07 | P2 | ✅ 修复 | `src/components/ui/Alert.tsx`、`src/components/ui/surfaces.test.tsx` | 新增 `live?: "assertive" \| "polite" \| "off"`，默认按 tone 推导：danger/warning → `role="alert"`，info/success → `role="status"`；`"off"` 不进 live region（折叠条用）。视觉类名零变化。测试 4 例。全量 `npm test` 未因 role 变化出现任何回归。 | `1cf118526` |
| S-08 | P2 | ⏸ 暂缓 | — | 指挥官裁决本轮不动：与 2026-07-02「后退 = 上一个会话」定头交叉，等用户拍板。见 §8。 | — |
| S-09 | P2 | ✅ 修复 | `src/components/EmptyState.tsx`(+test)、`src/components/ChunkErrorBoundary.tsx`(+test) | 「为这次会话设定目标」→ `Button variant="link" size="sm"`（触屏 `min-h-11` 兜底，视觉仍是文字链接）；兜底屏「刷新」→ `Button variant="primary" size="md" shape="pill"`，`autoFocus` 透传保留。ChunkErrorBoundary.test 重写为 `alertdialog` / `button` 契约（含 autofocus、`location.reload` 调用），并保留原有 `isChunkLoadError` 各文案用例。 | `e5fdf2f78`、`67d540809` |
| S-10 | P3 | ✅ 修复 | `src/components/EmptyState.tsx`(+test) | `<h1>` → `<h2>`，文档唯一 h1 留给 App 的 sr-only 会话标题。测试断言 EmptyState 内无 level-1 heading。 | `67d540809` |
| S-11 | P3 | ✅ 修复 | `index.html`、`src/hooks/useTheme.ts`(+test) | 内联脚本两个分支都写 `theme-color`，取值与 `useTheme` 的 `THEME_COLOR`（`#0c0c11` / `#fafafb`）同一对；`useTheme.test` 读 `index.html` 把两处字面量钉在同一条断言里。 | `8ee43e008` |
| S-12 | P3 | ✅ 修复 | `src/hooks/useTheme.ts`(+test)、`index.html` | `parseTheme` 只认三值、脏值回落 `system`（内联脚本同口径）；`storage` 事件跨标签同步；`localStorage` 读写包 try/catch。测试 5 例。 | `8ee43e008` |
| S-13 | P3 | ✅ 修复 | `src/components/UpdateBanner.tsx`、新增 `UpdateBanner.test.tsx` | 半角逗号 → 全角；「立即刷新」「稍后」→ `Button`（link / ghost）放进 Alert `action` 槽，删掉手写 `flex-wrap`。测试 2 例。 | `895db90e1` |
| S-14 | P3 | ✅ 修复 | `src/components/ui/Chip.tsx`、`selection.test.tsx` | `[@media(hover:none)]:min-h-9 → min-h-11`。**跨模块影响**：触屏下 manage / market 筛选条约高 8px，由指挥官转告 owner。after 图 `shell-ui-kit--mobile-*`：Chip 与 Button 同高。 | `65b781271` |
| S-15 | P3 | ✅ 修复 | `src/components/EmptyState.tsx`(+test) | 起步语卡片补 `type="button"`；任意字号按 §4 结论留给排版档位专项。 | `67d540809` |
| S-16 | P3 | ✅ 修复 | 新增 `src/lib/prefetchPolicy.ts`(+test)、`src/App.tsx` | `shouldPrefetchCenters(conn)`：`saveData` 或 `effectiveType ∈ {slow-2g, 2g}` → 不预取；API 缺席 → 照常。`readNetworkInformation` 兼容 moz/webkit 前缀。测试 4 例。 | `f20597d54`、`561b3aeb5` |
| S-17 | P3 | ✅ 修复 | `src/components/ui/Sheet.tsx`、`surfaces.test.tsx` | `bottom` 变体加 `overflow-y-auto overscroll-contain`。测试 2 例（right 变体不受影响）。双滚动条目测见 §7。 | `1cf118526` |
| S-18 | P3 | ✅ 修复 | `src/components/ChunkErrorBoundary.tsx` | `text-[13px] → text-body`（像素等价，after 图与 before 一致）。 | `e5fdf2f78` |
| S-19 | P3 | ✅ 修复 | 新增 `tsconfig.browser-tests.json`、`package.json` | 按裁决不动主 `include`；独立 tsconfig 只 include `browser-tests/ui-preview/**`，新增脚本 `npm run typecheck:preview`。**首次运行暴露 `scenes-taskboard.tsx` 3 处存量错误**（见 §8），本轮不修。 | `75ba343cd` |
| S-20 | P3 | ◐ 半条 | `src/components/ui/Toast.tsx`、`src/styles.css`、新增 `Toast.test.tsx` | 只做「解耦」半条：`top-16 → top-[var(--oc-toast-top,4rem)]`，变量在 `styles.css` 单点定义（= ChatHeader `min-h-14` + 0.5rem）。「去掉主题切换 toast」按裁决不动。Toast.test 钉住类名 + 变量定义，并锁定 error→alert / 其余→status。 | `8c2e580e2` |

计划外顺手处理（均记入上表对应行）：`isDialogLayerOpen` 纳入 `role="menu"`；`useTheme`
的 `localStorage` 读写包 try/catch；`UpdateBanner` / `EmptyState` / `ChunkErrorBoundary` 三个
测试文件在上一任重写时删掉的存量用例（MAIN_AGENT starters、兜底卡、`isChunkLoadError` 各文案、
「正常渲染子树」）已补回，避免覆盖倒退。`--warning` 作填充（§5 末行）核实后**不需要** `--warning-fg`：
仓内 `bg-warning` 全部是状态点 / 进度条，无文字压在上面。

## 7. 验证

全部在工作树 `d:\code\test_project\test123\wt\shell` 内跑，HEAD = `1da9a0f2b`。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿（半成品接手时、S-20 后、S-06 单行修正后各跑一次） |
| ui-preview 场景类型检查（S-19 新增） | `cd packages\web-react; npm run typecheck:preview` | ⚠️ `scenes-shell.tsx` 0 错；`scenes-taskboard.tsx` 3 错（他人存量，见 §8） |
| shell 模块单测 | `npx vitest run src/App.test.tsx src/components/{ChunkErrorBoundary,EmptyState,UpdateBanner}.test.tsx src/components/ui src/hooks src/lib/{hotkeys,bannerStack,prefetchPolicy}.test.ts src/test/designTokens.test.ts --maxWorkers=1` | ✅ 32 文件 / 315 用例全绿（含 Toast.test 与补回的存量用例） |
| App.test（S-06 单行修正后复跑） | `npx vitest run src/App.test.tsx --maxWorkers=1` | ✅ 47/47 |
| 全量 web-react 单测 | `cd packages\web-react; npm test` | ✅ 278 文件 / 3608 用例通过；**2 文件失败均为本机环境基线，与本分支无关**：① `src/lib/tutorialShowcase.test.ts` 2 例 —— 断言 `public/tutorials/.../dashboard.html` 字节数与 SHA-256，本机 git `core.autocrlf=true` 检出时把 LF 换成 CRLF（46712 → 46755 字节），在未改动的主克隆 `v5-selfhost` 上复跑**同样失败**；② `src/components/MessageRenderer.test.tsx` `beforeAll` 10s 超时（该文件注释自述「全量并行时首次 import 偶尔耗尽」，且当时 typecheck / biome 在并行跑），**单跑 147/147 全绿** |
| 真浏览器交互门（App.tsx / 快捷键 / 横幅属高频面） | `cd packages\web-react; $env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser` | 见下方「test:browser」一行 |
| 代码风格 | `npx biome lint <本轮全部改动文件>` | ✅ 新增 lint 诊断 0：`App.tsx` 14 条 `useExhaustiveDependencies` 与主克隆基线**逐条相同**（只是行号平移），其余文件 0 条。`biome format` 在本机对**任何**已检出文件都报「整文件重排」（`core.autocrlf` 把工作副本变成 CRLF，与 biome 默认 LF 冲突，未改动的 `Badge.tsx` 同样报错），故对 CRLF 文件只跑 lint；本轮**新建**的 LF 文件（bannerStack / prefetchPolicy / useTheme.test / UpdateBanner.test / Toast.test / ChunkErrorBoundary.test / EmptyState.test）`biome format` 全绿 |
| after 截图 | `OC_UI_SHOTS=...\.audit-tmp\shell\after; OC_UI_SCENES='shell-'; node browser-tests\ui-preview\shoot.mjs` | ✅ 22 张全部成功（S-06 单行修正后 `shell-global-banners` 4 张重出）。逐张 Read 对照 before：`shell-global-banners--mobile-*` 横幅栈 ~560px → ~390px、error 置顶、折叠条一行；`shell-ui-kit--desktop--dark` 「删除」白字 → 深字；`shell-landing-tokens--*` danger 行进入同一亮度带、danger 按钮深字；`shell-ui-kit--mobile-*` Chip 升到 44px 与 Button 同高；`shell-empty-state` / `shell-chunk-error-*` 视觉与 before 一致（S-09/S-18 是命中区与字号档位的结构改动，像素等价） |

**test:browser**（HEAD `1da9a0f2b`，Chrome 153）：`browser-tests/run.mjs` **67/67 全过**（含 T40
390px 失败轮、T41 密度 token、T20 harness 存活等与横幅 / 壳层相关的用例）；随后的 16 个
`node --test` 契约文件 **73 例中 70 过、3 不过**，不过的 3 条全部来自同一个套件
`cc-switch-ascii-name.node-test.mjs`（settings 的 ApiKeysSection：等不到「还没有 API Key」文案 +
`haikuModel` 期望 `gemini-3.8-flash` 实际 `sonnet-5`），在**未改动的主克隆 `v5-selfhost` 上单跑同样
2/2 失败**，是基线问题、归 settings owner，与本分支无关。其余 chat-navigation / find-in-session /
goal-start / draft-auth / composer-draft / human-wait-resume / owner-fence / identity-manual /
cost-authority / ocv5-185 / ocv5-210 系列全绿。

**未跑 / 未验（`NOT RUN`）**：

- S-17 的「贴底 Sheet 与调用方自带滚动容器是否叠出双滚动条」未在真浏览器目测：`shell-*` 场景
  不覆盖 InspectorPanel 的窄屏抽屉；`overflow-y-auto` 只在内容溢出 85dvh 时生效，调用方自带
  `min-h-0 flex-1 overflow-y-auto` 时外层不会溢出，逻辑上不叠。建议 tools owner 在其场景里看一眼。
- 真机 iOS Safari 仍未复核（本机网络受限，同阶段 A）。

## 8. 遗留

| 项 | 类型 | 说明 / 下一步 |
|---|---|---|
| **S-08 面板不进历史栈** | P2 · 暂缓 | 指挥官裁决本轮不动。与 2026-07-02「后退 = 上一个会话」定头交叉，需用户拍板「面板是否应占历史栈」后再按 §4 方案做（`pushState` + `history.state.ocPanel` 标记 + `useAppRoute.test`）。 |
| **S-20 去掉主题切换 toast** | P3 · 暂缓 | 产品口味判断，等用户拍板。`top-16` 解耦那半已做。 |
| `.preview-shell` 未纳入对比度守卫 | S-05 余项 | 该块用 `--preview-*` 前缀且 `surface` 是半透明 `rgba`，要先定义「合成到哪个底上」才有意义；`designTokens.test.ts` 的 `THEMES` 注释已写明。建议单列小任务。 |
| `scenes-taskboard.tsx` 3 处类型错误 | S-19 暴露 · 他人文件 | `npm run typecheck:preview` 报：`(40,3)` / `(68,3)` `PipelineStage` 缺 `model`；`(115,5)` `"close"` 不在 `"advance" \| "wait_human" \| "stay"`。归 **taskboard owner（fable-5-1-23）**，由指挥官分派。清完后可把 `typecheck:preview` 串进 `typecheck` 脚本。 |
| Chip 44px 对 manage / market 筛选条的影响 | S-14 跨模块 | 触屏下筛选行约高 8px。需 **manage owner（fable-5-1-20）/ market owner（fable-5-1-19）** 在各自 after 图里确认无换行 / 溢出。 |
| `EmptyState` 的 `text-[26px]` / `text-[15px]` / `text-[14px]` | S-15 余项 | 按 §5 结论等排版档位专项统一收敛，本轮不新增 token。 |
| 本机 `core.autocrlf=true` 带来的两处环境噪音 | 环境 | ① `tutorialShowcase.test.ts` 字节 / SHA 断言在 Windows 检出下必红（主克隆同样红）；② `biome format` 对所有 CRLF 工作副本报整文件重排。都不是代码问题；若要在 Windows 上让它们绿，需仓库加 `.gitattributes`（`*.html text eol=lf` 等）—— 属仓库级约定，本轮不动。 |

### 8.1 待 integration 接线（其他模块对 `App.tsx` 的跨归属需求）

这些 prop 由对方分支新增，本分支基于基线**没有它们的类型**，在 `wt\shell` 里接会让 typecheck 转红；
按指挥官指示只在此登记，合入 integration 分支 `feat/v5-selfhost-ocv5-audit-ux` 时由指挥官顺手接。
行号以本分支 HEAD `d2f21dd18` 的 `App.tsx` 为准。

| 来源 | 位置（本分支） | 改动 | 目的 |
|---|---|---|---|
| sidebar-B S-08（fable-5-1-13） | `App.tsx:630` 附近 `useSessionList({...})` 的返回值解构 | 多解构一项 `loadMoreError` | — |
| sidebar-B S-08（fable-5-1-13） | `App.tsx:3344` `sidebarProps` 内紧邻 `loadingMore: loadingMoreSessions,` | 加一行 `loadMoreError,` | 加载更早会话失败时侧栏底部显示「加载更早会话失败，点击重试」 |
| sidebar-B S-06（fable-5-1-13） | `App.tsx:3413-3441` 移动端抽屉 `<Sidebar … onCollapse={() => setMobileNavOpen(false)}` | 加 `collapseLabel="关闭导航"`（桌面内联侧栏 `App.tsx:3375-3400` 的 `onCollapse={() => setCollapsed(true)}` **不动**） | 抽屉里的折叠键读屏文案从「折叠侧栏」改为「关闭导航」 |

## 9. 发布阻断修复 · 首屏 gzip 预算超限（t-1348，2026-09-17）

分支 `feat/v5-selfhost-audit-budget-fix`（自 integration `2d2b5cafc` 切出，工作树 `wt\budget-fix`）。
指挥官拍板 **A 优先**（拆动态 import，目标 ≤455KB）、90 分钟不达标转 B（上调阈值）。
**结果：A 方案达标，`FIRST_SCREEN_GZIP_BUDGET = 471040` 不动。**

### 9.1 修前 / 修后（口径 = `vite.config.ts` first-screen-budget 插件：index.html modulepreload 闭包 gzip level 9 求和）

| 基点 | 首屏闭包 gzip | 与预算 460.0KB（471040 B）的关系 |
|---|---|---|
| 基线 `210b99678` | 455.9KB | 余 4.1KB（发布预演 t-1279 实测） |
| canonical `3b7c38b9d` | 456.4KB | 余 3.6KB（同上） |
| **integration `2d2b5cafc`（修前）** | **471.4KB** | **超 11.4KB，`npm run build` exit 1**（main 139.4 / tapePayload 125.5 / styles 75.1 / react-vendor 55.3 / radix-vendor 29.9 / media 17.7 / lucide-vendor 17.7 / viewport-shared 2.9 …，15 个 chunk） |
| **本分支（修后）** | **445.5KB（456204 B）** | **余 14.5KB，`npm run build` exit 0**；≤455KB 目标达成（main 129.0 / tapePayload 122.7 / styles 77.5 / react-vendor 55.3 / radix-vendor 29.9 / lucide-vendor 17.7 / media 5.1 / viewport-shared 2.9 …，13 个 chunk） |

净减 **25.9KB gzip**。归因方法：用 `sourcemap: "hidden"` 产出的 `.map` 把闭包内每个 chunk 的生成字节
按源文件归因（`@jridgewell/trace-mapping` 解码，按 chunk 的 gzip/raw 比例折算；脚本在仓库外
`.audit-tmp\budget-fix\attribute-first-screen.mjs`，不入库），再筛出「入口静态可达、但只有点开才需要」的模块。

### 9.2 拆分点（全部是覆盖层 / 点开才出现的面；**首屏可见组件一个都没 lazy**）

| # | 改动 | 文件 | 省下（gzip，估算） |
|---|---|---|---|
| 1 | 全屏图片查看器 `ImageViewer`（含 `ImageAnnotationEditor` 圈选编辑 / `ImageCommentMode` / `ImageResizeMode` 三模式）改 `React.lazy`：`ZoomableImage` 首次点开才挂载（挂载闸 `viewerMounted`，打开过后常驻，`open` 显隐语义同前），外套 `LazyBoundary`（chunk 拉取期空 fallback；发版后旧标签页拉不到旧 chunk → 「刷新」兜底）。缩略图 / 签名 / 下载 / 时间线渲染仍同步 | `components/chat/media.tsx` | ≈11.5KB（media chunk 17.7 → 5.1KB） |
| 2 | `App.tsx` 顶层圈选编辑器 `ImageAnnotationEditor` 改 `React.lazy` + 有 `source` 才挂载（编辑器自身 `!open` 即重置全部状态、无退场动画，条件挂载与常驻等价）；`ImageAnnotationSource` 改 `import type` | `App.tsx` | （与 #1 同一 chunk） |
| 3 | `InboxDialog` / `GithubRepoModal` / `MessageFeedbackDialog` / `ProjectSettingsDialog`（连带 `ProjectAssetsPanel`）改 `React.lazy`，渲染点用新增的 `useMountedOnce(open)` 挂载闸：首次 open 前不挂载（不下载），打开过后常驻，四个对话框此前的效果都以 `open` 门控、`!open` 即复位，行为等价；首开空窗铺与既有懒对话框同款的 `DialogFallback` | `App.tsx` | ≈10.2KB（Inbox 2.5 + inboxLevels 0.1 / GithubRepo 2.4 / Feedback 1.3 / ProjectSettings 2.0 + AssetsPanel 1.9） |
| 4 | 订阅弹窗的「预选意图 / 最近已付费」模块级状态下沉到新建 `lib/subscribeIntent.ts`；`chat/cards.tsx` 红卡改从 lib 取，`settings/SubscriptionDialog.tsx` 改为 import + re-export（`AccountTab` / 三个测试文件的既有引用零改动）。此前红卡（首屏同步渲染）静态引订阅弹窗，把弹窗 + `HupijiaoPaymentEntry` 支付入口一并钉进闭包 | 新增 `lib/subscribeIntent.ts`；`components/chat/cards.tsx`、`components/settings/SubscriptionDialog.tsx` | ≈4.6KB（SubscriptionDialog 2.2 + HupijiaoPaymentEntry chunk 2.4） |
| 5 | 项目色板 `PROJECT_COLORS` 下沉到新建 `lib/projectColors.ts`；侧栏 `ProjectRow` 改从 lib 取，`ProjectSettingsDialog` re-export（测试引用不变）。否则 #3 的 ProjectSettingsDialog 会被侧栏这条静态边拽回闭包 | 新增 `lib/projectColors.ts`；`components/sidebar/ProjectRow.tsx`、`components/ProjectSettingsDialog.tsx` | （使 #3 生效） |
| 6 | 空闲期预取清单加入 `ImageViewer` chunk（沿用 `prefetchLazyCentersOnIdle` 的 saveData / 2G 门控），时间线点图首开零延迟 | `App.tsx` | — |
| 7 | 测试适配：`media.test.tsx` 的 URL 桩改为**保留真构造器**的子类（旧写法 `{ ...URL, createObjectURL }` 让 vitest 解析动态 import 时 `new URL` 抛 "URL is not a constructor"，懒块一加载即进错误边界），开查看器后的断言改 `waitFor` / `findByRole`；`MarkdownImpl.test.tsx` 同理改 `waitFor` | `components/chat/media.test.tsx`、`components/MarkdownImpl.test.tsx` | — |
| 8 | 阈值注释补 2026-09-17 实测与取舵（数值不动） | `vite.config.ts` | — |

越界说明：#1 / #4 / #5 / #7 触及 messages（media / cards / MarkdownImpl.test）、settings（SubscriptionDialog）、
sidebar（ProjectRow）归属文件，均为「改一行 import / 抽一个常量 + re-export / 测试等待方式」的机械改动，
不改任何业务行为；任务书允许改动清单外的文件已在交付里点出，由集成⑤合入时一并过目。

### 9.3 验证（工作树 `wt\budget-fix`，2026-09-17）

| 项 | 命令 | 结果 |
|---|---|---|
| 生产构建（= `deploy-v5-selfhost.sh --deploy` 的 `build_frontend` 同款） | `npm run build --workspace packages/web-react` | ✅ exit 0；first-screen-budget 门 445.5KB ≤ 460.0KB（另用同口径「只报告不 fail」的临时配置复算 = 456204 B，与门一致） |
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿 |
| 触及模块单测 | `npx vitest run media / MarkdownImpl / ProjectSettingsDialog / cards / PaymentDialogs / AccountTab / InboxDialog / GithubRepoModal / MessageFeedbackDialog / ImageViewer / firstScreenBudget / components/sidebar` | ✅ 15 文件 / 303 用例（URL 桩修正后全绿） |
| 全量 web-react 单测 | `cd packages\web-react; npm test` | ✅ **302 文件 / 4279 用例全部通过**（10m41s） |
| 真浏览器交互门（时间线媒体 / 消息反馈弹窗 / 侧栏属高频面） | `$env:OC_E2E_BROWSER='…\chrome.exe'; npm run test:browser` | ✅ `browser-tests/run.mjs` **68/68**（含 T13 工具卡、T14 消息反馈弹窗焦点归还、T16/T17 全屏预览、T25/T68 390px）；`node --test` 契约 73 例 70 过 / 3 不过：① `cc-switch-ascii-name` 2 例 = 已知基线问题（settings ApiKeysSection，主克隆同样红，见 §7 与 RELEASE.md）；② `ocv5-185-qa` 1 例 = 该套件先 `git diff --exit-code HEAD -- packages/web-react/src` 要求工作树干净，当时改动尚未提交所致，**提交后单跑该文件复核见下一行** |
| `ocv5-185-qa` 复跑（代码提交 `77e1f35dc` 后） | `node --test browser-tests/ocv5-185-qa.node-test.mjs` | ✅ **15/15**（T1–T14 双 Chromium 权限 QA 全过。注：该套件 `ensureProtocolShim` 用 `symlinkSync` 建 `packages/web-react/node_modules/@openclaude/protocol`，Windows 无符号链接权限时报 EPERM，先手工建同路径 junction 即可，与代码无关） |
| 代码风格 | `npx biome check <本轮改动文件>`（与主克隆 `2d2b5cafc` 同文件逐条对照） | ✅ 新增 lint 诊断 0（`App.tsx` 14 条 `useExhaustiveDependencies`、`media.tsx` / `cards.tsx` 等的 a11y / format 诊断均为基线存量，行号平移）；新建的两个 LF 文件 `biome check` 0 诊断 |

**未跑 / 未验（`NOT RUN`）**：

- ui-preview before/after 截图：本轮零视觉改动（只改加载时序），未出图；`test:browser` 68 例已覆盖时间线 / 弹窗 / 390px 的真浏览器渲染。
- 慢网首开体感：懒块首开多一次 chunk 拉取（ImageViewer ≈7KB、对话框各 1–4KB gzip），已由空闲预取（查看器）与 `DialogFallback`（对话框）对冲，未在节流网络下实测。

### 9.4 遗留 / 后续可拆（供下一次逼近预算时取用）

| 候选 | 闭包内体量（gzip 估算） | 说明 |
|---|---|---|
| `components/tool/{researchCards,connectorCards,skillCards,memoryReminderCards,releaseCards,grokDisplay}` 等专项工具卡体 | ≈18KB | 走 `tool/bodies.tsx` 注册表按工具类型懒加载可再省一大块，但工具卡在带工具调用的会话里属首屏可见，需 tools owner 评估首帧回退占位 |
| `lib/taskboard.ts` | ≈3.3KB | 经 `useAppRoute`（`TICKET_TYPES` 常量）与 `useProjectScope`（`taskboardApi.listProjects`）静态进闭包；常量下沉 + 动态 import 即可拆 |
| `@openclaude/protocol` 运行时 + `@sinclair/typebox` | ≈30KB（styles chunk） | 客户端只用到 protocol 的少数常量 / 类型，但 barrel 把全部 TypeBox schema 构造一并带进来；要拆得改 `packages/protocol` 导出结构，超出本轮范围（PLAYBOOK §9） |
| `components/chat/PermissionCard` | ≈5.7KB | 只在有待决审批时渲染，可 lazy；但它是活动 turn 的高频交互面，本轮按「首屏可见组件不 lazy」保守不动 |
