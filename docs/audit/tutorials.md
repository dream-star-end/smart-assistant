# A·tutorials 教程中心 · 审计报告

- 分支：`feat/v5-selfhost-audit-tutorials`（基线 `210b9967892b3624fb3984f69d2174e4a641b33d`）
- 阶段：A（审计，未改任何业务代码）→ B（修复，§6–§9；发现 37 / 已修 26 / 部分 6 / 遗留 5；P2 12/12 全修）
- 结论：**P1 × 0 / P2 × 12 / P3 × 25**，共 37 条。没有阻断主流程的故障：教程中心是只读为主的面，
  真正会"卡住"用户的是三件事——26 篇功能参考在导航里**没有入口**（只能从快速上手的链接绕进去）；
  精选作品详情里点「案例展厅」页签**没反应**；移动端搜索 / 分类筛选**没有任何可见反馈**。其余多为
  文案诚实性（"待采集"术语与图稿承诺互相打架）、表单校验、错误态与触控尺寸。另有两条会**挡住阶段 B
  验证**的环境 / 门禁问题（TU-36 / TU-37：Windows 下字节精确夹具与门禁脚本不可运行）。

---

## 1. 范围与文件清单

本轮覆盖 `packages/web-react` 的教程中心：`?panel=help` 打开的 Radix Dialog 及其五个视图——
案例展厅（精选作品 + 公开数据实作）、快速上手、功能参考（26 个能力 × 目录 / 分类 / 搜索 / 阅读进度 /
CTA 跳转）、案例脚本（12 条 + 详情 + 折叠的资料与方法 + 运行回放）、教程工作室（目录 / 详情 /
会话快照 / 手写投稿 / 我的发布 / 从当前会话生成）。

| 类别 | 文件 | 行数 |
|---|---|---|
| 面板壳 + 功能参考 + 案例脚本 + 快速上手 | `src/components/TutorialCenter.tsx` | 1719 |
| 案例展厅 / 公开数据实作详情 | `src/components/tutorials/CaseShowroom.tsx` | 125 |
| 精选作品（星球 / 三体）画廊与详情 | `src/components/tutorials/SignatureShowcases.tsx` | 60 |
| 案例卡图稿 | `src/components/tutorials/CaseArtwork.tsx`、`CaseFieldReportVisual.tsx` | 16 KB / 151 |
| 任务回放（示意步骤） | `src/components/tutorials/MissionReplay.tsx` | 536 |
| 真实轨迹回放（verified 案例） | `src/components/tutorials/TutorialReplay.tsx` | 485 |
| 教程工作室 | `src/components/tutorials/CommunityTutorials.tsx` | 614 |
| 会话快照详情 | `src/components/tutorials/SnapshotTutorialDetail.tsx` | 253 |
| 从当前会话生成 | `src/components/tutorials/PublishFromSessionDialog.tsx` | 302 |
| CTA 可用性 / 主线 / 进度 / 展厅数据 / 工作室逻辑 | `src/lib/tutorialActions.ts`、`tutorialJourneys.ts`、`tutorialProgress.ts`、`tutorialShowcase.ts`、`tutorialSignatureWorks.ts`、`tutorialStudio.ts`、`tutorialReplayContract.ts`、`tutorialCaseId.ts` | — |
| 目录数据（只读，受门禁保护） | `src/lib/tutorialCatalog.ts`（58 KB）、`tutorialCaseCatalog.ts`（94 KB） | — |
| 静态资产（只核对存在性） | `public/tutorials/**`（26 对 webp/webm、2 个 showcase、2 个 signature work、案例输入） | 86 个文件 |

对应的 `*.test.ts(x)`（9 个）随源文件归属，本轮只读不改。

**只读参照、不在本轮改动范围**：`App.tsx:1565-1735`（教程打开 / CTA 跳转 / 案例预填的接线）、
`hooks/useAppRoute.ts:142-230`（`?panel=help&topic|case|community=` 深链）——均归 shell；
`components/ui/**`（Button / IconButton 的触屏尺寸规则、DropdownMenu / ConfirmDialog / Skeleton /
Toast 原语）——归 shell；`scripts/check-v5-tutorials.ts`（教程防漂移门禁，阶段 B 改目录数据前必读，
见 §4 开头的约束）。

审计维度按 PLAYBOOK §5 的七项清单逐项过：UI/视觉、响应式/移动端、交互友好性、功能正确性、
可访问性、文案、代码质量。

---

## 2. 方法与证据

### 2.1 ui-preview 场景

新增 `browser-tests/ui-preview/scenes-tutorials.tsx`，27 个场景。面板挂在 Radix Dialog Portal 里，
`shoot.mjs` 裁到 `[role=dialog]`；面板内导航（页签 / 下拉 / 侧栏 / 搜索 / 折叠区）全部走**真实点击**：
`TutorialHost` 用本地 state 镜像 `App.tsx` 的接线，`AutoAct` 在挂载后按步骤点按钮 / 输入 / 滚动
（滚动只动 `main.tutorial-detail`，原因见 TU-23）。

| 场景 id | 内容 | 视口 |
|---|---|---|
| `tutorials-showroom` | 案例展厅默认视图（精选作品 hero + 公开数据实作卡） | desktop / mobile |
| `tutorials-signature-detail` | 精选作品详情（iframe 加载中态） | desktop / mobile |
| `tutorials-showcase-detail` / `-preview` | 公开数据实作详情（封面 + 下载区）/ 点「打开交互看板」 | desktop / mobile |
| `tutorials-quickstart` | 快速上手 6 步 | desktop / mobile |
| `tutorials-feature-detail` | 功能参考「对话入门」（侧栏目录 / 移动端分类 chips + 下拉） | desktop / mobile |
| `tutorials-feature-cta-disabled` | 「企业组织」非管理员，滚到页尾 CTA（禁用 + 原因） | desktop / mobile |
| `tutorials-help-menu-open` | 「帮助与创作」下拉展开态 | desktop / mobile |
| `tutorials-feature-search-hit` / `-empty` | 搜索「GitHub」命中 2 条 / 搜索「量子计算」无结果 | desktop / mobile |
| `tutorials-feature-category` | 按「账户与团队」筛选 | desktop / mobile |
| `tutorials-case-gallery` | 案例脚本总览（12 卡） | desktop / mobile |
| `tutorials-case-detail` / `-research` | 案例详情：编码 · SWE-bench（已登录）/ 科研 · 证据图谱（未登录） | desktop / mobile |
| `tutorials-case-detail-artifacts` | 滚到「先看成品」示意预览 | desktop / mobile |
| `tutorials-case-detail-methods` / `-replay` | 展开「案例资料与方法」/ 滚到「运行过程回放」 | desktop / mobile |
| `tutorials-studio-catalog` / `-empty` / `-error` | 工作室目录：3 条 + 加载更多 / 空态 / 502 | desktop / mobile |
| `tutorials-studio-detail` / `-snapshot` / `-snapshot-artifacts` | Markdown 教程详情 / 会话快照详情 / 滚到「成果」 | desktop / mobile |
| `tutorials-studio-submit` / `-mine` | 手写教程表单 / 我的发布（四种状态） | desktop / mobile |
| `tutorials-studio-publish-dialog` / `-gate-notice` | 从当前会话生成对话框 / 会话为空时的门禁提示 | desktop / mobile |

桩数据全部就地写死，**未改 `api-stub.ts`**（manifest `unmockedApi: []`）。离线 harness 对一切非
harness 请求回 204，所以 `/tutorials/**` 的封面、演示视频、iframe 在截图里都是各组件的 onError /
加载中兜底——截图记录的是"资源不可达时用户看到什么"；资源本体另行核对：`public/tutorials/` 下 26 对
`<id>.webp/.webm`、2 个 `showcase-covers/*.png`、`showcase-works/{planet,gravity}/{index.html,cover.png,source.zip,manifest.json}`、
2 个 `cases/*/showcase/{dashboard.html,report.md,derived.csv,metrics.json,manifest.json}` **全部存在**，
`check:tutorials` 门禁也校验它们的哈希与尺寸（§2.5）。

### 2.2 截图基线

```
D:\code\test_project\test123\.audit-tmp\tutorials\before\
```

108 张 PNG（27 场景 × desktop/mobile × light/dark），外加 `manifest.json`（`failures: []`、
`retried: []`、`unmockedApi: []`，`generatedAt 2026-09-16T12:12:39Z`）。复跑命令：

```powershell
cd d:\code\test_project\test123\wt\tutorials\packages\web-react
$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:OC_UI_SHOTS='D:\code\test_project\test123\.audit-tmp\tutorials\before'
$env:OC_UI_SCENES='tutorials'
node browser-tests\ui-preview\shoot.mjs
```

直接充当证据的几张：

- `tutorials-showroom--desktop--light.png` —— 导航只有「案例展厅 / 快速上手 / 帮助与创作▾」，
  26 篇功能参考没有入口（TU-01）；精选作品卡左上角透出封面图自带的「下一颗星球，由你定义。」
  幽灵字（TU-29）；底部 10px 白字 40% 透明度的免责声明几乎不可读（TU-12）。
- `tutorials-help-menu-open--desktop--light.png` —— 原生 `<details>` 下拉展开，点空白处不会关（TU-03）。
- `tutorials-feature-search-empty--mobile--light.png` 与 `tutorials-feature-search-hit--mobile--light.png` ——
  和 `tutorials-feature-detail--mobile--light.png` 除搜索框里的字外**逐像素相同**：移动端搜索既不显示
  结果数也不显示"没有匹配"（TU-04）。桌面版同一场景侧栏出现「没有匹配的教程」。
- `tutorials-feature-cta-disabled--desktop--light.png` —— 详情是「企业组织」（26 项里第 25 个），侧栏
  仍停在列表顶部，当前项在视口外（TU-18）；页尾 CTA 禁用并给出原因（这一点是对的）。
- `tutorials-case-gallery--*.png` —— 同屏三处「示例待真实运行采集」+ 标题「这些是待采集的任务脚本」，
  而第二张卡图稿写着「34 项复现测试通过 / 可核对成果」（TU-10）。
- `tutorials-case-detail--mobile--light.png` —— 图稿里的代码行 `cright[-right.shape[0]:, …]` 被下一行盖住（TU-30）；
  黄色横幅 + 徽章 + 图稿三种口径并存。
- `tutorials-case-detail-artifacts--*.png` —— 「先看成品 / 这些成果会直接交到你手里」下面是一张写死的
  柱状图 + 三个格式胶囊，不是本案例任何真实产物（TU-16）。
- `tutorials-case-detail-replay--mobile--light.png` —— 「运行过程回放」标题下橙色「示例待真实运行采集」
  再接一段「待真实运行采集。当前只展示…」，同一件事说三遍（TU-10）。
- `tutorials-studio-submit--desktop--light.png` —— 正文 textarea 的占位符里是字面 `\n\n`（TU-06）。
- `tutorials-studio-error--desktop--light.png` —— 红色「加载社区教程失败」下面同时显示「还没有匹配的教程 /
  你可以成为第一个分享这类经验的人」，且没有重试（TU-07）。
- `tutorials-studio-snapshot--desktop--light.png` —— 分类徽章是英文枚举 `coding`（TU-09）。
- `tutorials-studio-snapshot-artifacts--desktop--light.png` —— `text/markdown · 2048 B`、`text/html · 18042 B`
  原样字节数（TU-26）；`root-cause.md` 正文为空时只剩一条灰条（TU-35）。
- `tutorials-studio-mine--desktop--light.png` —— 「已上线」条目右上角一个 ghost「撤回」，单击即发（TU-08）。

### 2.3 Chromium 探针（仓外，`..\.audit-tmp\tutorials\probe-scroll.mjs`，不提交）

复用 ui-preview 的构建管线（esbuild + vite/tailwind production CSS + playwright-core Chromium），
量教程对话框的滚动容器归属，结果落盘 `..\.audit-tmp\tutorials\probe-scroll-result.json`：

| 场景 | 视口 | `[role=dialog]` scrollHeight / clientHeight | `main.tutorial-detail` scrollHeight / clientHeight | 撑出溢出的元素 |
|---|---|---|---|---|
| 案例脚本详情 | desktop 1440×900 | **1320 / 866**（overflow hidden，可被程序化滚动 454px） | 1957 / 750 | `<p class="sr-only">`（`position:absolute`，offsetParent = Dialog.Content） |
| 案例脚本详情 | mobile 390×844 | **2228 / 826**（可滚 1402px） | 3282 / 706 | 同上 |
| 功能参考详情 | desktop / mobile | 866 / 866、826 / 826（无溢出） | 1930 / 750、2382 / 606 | — |

- 对页尾 `<h2>` 调 `scrollIntoView({block:'start'})`：对话框自身 scrollTop 变为 454 / 626，
  **header + nav 被顶出视口**（`headerVisible: false`）——就是首轮 `tutorials-case-detail-methods` 截图
  头部消失的原因（TU-23）。
- 键盘 Tab 与 `button.focus()` 只滚 `main`，header 仍可见（`afterFocus.dialog.scrollTop = 0`）：这条目前
  是**潜伏缺陷**，浏览器查找（Ctrl+F）、第三方 / 未来的 `scrollIntoView` 都会踩到。
- 功能参考桌面态从对话框起点 Tab 到「回到功能位置」需要 **44 次**（侧栏 6 个分类 + 26 个主题全在正文之前），
  移动端 19 次（TU-24）。

### 2.4 代码核对（不需要浏览器就能确认的结论）

- `MissionReplay` 的渲染条件 `selectedCase.replay.status !== "pending_capture" && caseId ∈ {research-bike-demand, coding-swe-bench-fix}`
  （`TutorialCenter.tsx:264-268`）与门禁 `scripts/check-v5-tutorials.ts:1305-1306`
  （"观察记录不得替代公开 replay 验证状态"：有 `fieldReport` 的案例 `replay.status` 必须是 `pending_capture`）
  **互斥**——这 22 KB 组件在门禁绿的前提下永远渲染不到（TU-13）。当前 12 条案例 `replay` 全是
  `PENDING_REPLAY`（`tutorialCaseCatalog.ts:169-173`），`TutorialReplay` 的 verified 分支也无数据可走。
- `TUTORIAL_SCENARIO_PATHS`（5 条按场景的学习路径，`tutorialJourneys.ts:76-107`）有测试、无渲染；
  `CaseSidebar`（`TutorialCenter.tsx:600-674`）、`tutorialCaseMatches`（`:150-192`）同样只有定义（TU-14）。
- `Field required` 只画星号 + `aria-required`，"不做校验"（`components/ui/Field.tsx:35-36`）；
  `CommunityTutorialSubmit` 的 `Input/Textarea` 没传原生 `required`，`minLength` 对空值不生效（TU-05）。
- JSX 属性字符串不处理转义：`placeholder="# 要解决的问题\n\n## 准备…"`（`CommunityTutorials.tsx:499`）
  渲染出字面反斜杠 n（TU-06，截图证实）。
- 26 个 `focus` 目的地在 `src/` 里都能找到 `data-product-feature` 标记（Composer / Sidebar / ChatHeader /
  ModelSelector 等），CTA 跳转链路本身完整；唯一的洞是 `destination.kind === 'taskboard'` 不看
  `TASKBOARD_ENABLED`（TU-32）。
- 公开数据看板 `dashboard.html` 把数据内联在 `<script>const DATA=…`，不发 fetch，所以
  `sandbox="allow-scripts"`（opaque origin）下能正常渲染；但它里面的 `<a download>` 与 `target=_blank`
  在没有 `allow-downloads / allow-popups` 的沙箱里会被浏览器静默拦截（TU-28）。
- **Windows 工作树上两套字节精确校验都过不了，且都不是产品缺陷**：本机 git 全局 `core.autocrlf=true`、
  仓库没有 `.gitattributes`，`public/tutorials/**/*.html`、`tutorial-sync-history.jsonl` 等文本夹具检出后
  变成 CRLF（`git ls-files --eol` → `i/lf w/crlf`）。`w3c-did-minutes.html` 22724 B → 22988 B（+264 = 行数），
  `dashboard.html` 46712 → 46755；把 CRLF 还原成 LF 后字节数与 SHA-256 **逐位等于** catalog / manifest 里
  的值（`6c5978…`、`9b52d0…`）。用 `git -c core.autocrlf=false checkout` 重检这些文件后
  `tutorialShowcase.test.ts` 4/4 通过；但 `check:tutorials` 仍报全部 26 个能力「功能源 / 入口身份变化」——
  `collectMarkers()` 把 `relative(ROOT, file)` 的**反斜杠路径**直接喂进 `sourceHash / entryIdentityHash`
  （`scripts/check-v5-tutorials.ts:407-415`、`:1694-1709`），而 `tutorial-sync.json` 是在 POSIX 上生成的
  （TU-36 / TU-37）。

### 2.5 跑过的验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0 |
| 场景文件类型检查 | `npx tsc --noEmit --strict --jsx react-jsx --module ESNext --moduleResolution Bundler … src/vite-env.d.ts browser-tests/ui-preview/scenes-tutorials.tsx`（包 tsconfig 只 include `src`，场景文件不在默认 typecheck 内） | ✅ 0 错 |
| 代码风格 | `npx biome check --formatter-enabled=false browser-tests/ui-preview/scenes-tutorials.tsx` | ✅ 0 诊断（AutoAct 的挂载期 effect 用 `biome-ignore useExhaustiveDependencies` 显式标注） |
| 视觉基线 | `node browser-tests/ui-preview/shoot.mjs`（`OC_UI_SCENES=tutorials`） | ✅ 108 张全部成功，0 失败 0 重试 0 未打桩 |
| 滚动容器探针 | `node ..\.audit-tmp\tutorials\probe-scroll.mjs` | ✅ 结论见 §2.3 |
| 模块单测基线 | `npx vitest run src/components/TutorialCenter.test.tsx src/components/tutorials src/lib/tutorial{System,Journeys,Showcase,Studio,Api}.test.ts --maxWorkers=1` | 12 files / 82 tests：**80 ✅ 2 ❌**，两条失败都是 `tutorialShowcase.test.ts` 的字节 / SHA 校验，根因 CRLF（§2.4 末）；把 `public/tutorials` 以 LF 重检后该文件 **4/4 ✅**（`..\.audit-tmp\tutorials\vitest-{baseline,showcase-after-lf}.log`） |
| 教程同步门禁 | `npm run check:tutorials` | ❌ **本机不可运行**：先因 CRLF 报「输入资产字节或哈希不一致」「历史锚点不一致」，LF 重检后仍因反斜杠路径进哈希报全部 26 项漂移（TU-37）。阶段 B 在 WSL / Git Bash 或修掉路径归一化后再跑；`tutorial-sync.json` 与 history 文件**本轮未动** |

**未跑**（`NOT RUN`）：

- `npm test`（全量 web-react 单测）—— 阶段 A 未改业务代码与既有测试；阶段 B 必跑。
- `npm run test:browser` —— 教程中心不在 PLAYBOOK §3 的高频交互面内，且本轮未改那些面。
- 真后端：教程工作室的投稿 / 撤回 / 快照发布、`/api/tutorial-blobs` 内嵌成果、真实 iframe 作品的
  WebGL 表现——本机没有 v5 后端与容器，这些只经代码审阅 + 既有 `CommunityTutorials.test.tsx` /
  `PublishFromSessionDialog.test.tsx` / `SnapshotTutorialDetail.test.tsx` 的行为契约。
- 真机 iOS Safari —— 触控 / 聚焦缩放结论只经 Chromium 移动模拟。

### 2.6 阶段 A 提交与接手说明

- 提交：`docs/audit/tutorials.md`（本文）+ `browser-tests/ui-preview/scenes-tutorials.tsx`
  + `browser-tests/ui-preview/shoot.mjs`（见下），commit SHA 见 `complete_task` 的 deliverable。
- **`shoot.mjs` 的一处修补（上一手 fable-5-1-27 做的，本手复核后保留）**：把 bundle 内联进
  `<script>` 前做 HTML 脚本数据转义（`<!--` → `<\x21--`、`</script` → `<\/script`）。加入
  `scenes-tutorials` 后 esbuild 的模块顺序恰好让 `src/lib/thinkingText.ts` 的 `/<!--[\s\S]*$/` 正则先于
  `settings/ApiAccessTab.tsx` 注释里的 `<script` 出现，HTML 分词器进入 double-escaped 态，整段脚本静默不
  执行、`window.__ocScenes` 为 undefined、shoot 直接炸。这是共享测试基建文件（不在 §8 归属表内），
  改动只影响内联转义、语义不变；biome 对该文件的 2 条诊断（`:359 useTemplate`、`organizeImports`）
  是**存量**，不在本次改动行。已在 deliverable 里单独向指挥官说明。
- 上一手留下的 `..\.audit-tmp\tutorials\probe-harness.mjs`（HTML 分词器状态机探针）与
  `shoot-before.log` 一并保留在仓外目录；本手新增 `probe-scroll.mjs` / `probe-scroll-result.json`、
  `vitest-baseline.log`、`vitest-showcase-after-lf.log`、`check-tutorials.log`。
- 本工作树里 `public/tutorials/**` 与 `packages/web-react/tutorial-*.json{,l}` 已用
  `git -c core.autocrlf=false checkout` 重检为 LF（只影响工作树行尾，`git status` 无差异），阶段 B 的
  字节校验类测试在此基础上跑。

---

## 3. 问题清单

严重度：**P1** 功能不可用/数据错误/阻断主流程；**P2** 明显体验缺陷/一致性破坏/移动端不可用；
**P3** 打磨项。位置均在 `packages/web-react/src/` 下。

| 编号 | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| TU-01 | `components/TutorialCenter.tsx:393-411`（nav）、`:370-385`（搜索框仅 `mode==="features"`）、`:237-246`（mode 推导） | 顶部导航只有「案例展厅 / 快速上手 / 帮助与创作▾（教程工作室 · 案例脚本）」，**26 篇功能参考没有任何入口**；进入功能参考只能靠快速上手里的「查看「对话入门」」链接、`App.openTutorial(id)` 或 `?topic=` 深链。一旦点了别的页签就回不去 | 教程中心最完整的内容（每个能力的步骤 / 示例 / CTA / 搜索）对从侧栏「帮助」进来的用户是隐藏的；搜索框也随之隐藏。见 `tutorials-showroom--*.png` | **P2** |
| TU-02 | `components/tutorials/CaseShowroom.tsx:38-42`（`activeWork` 本地 state）、`components/TutorialCenter.tsx:315-325`（`clearToBrowse` / `showShowroom`） | 精选作品（星球 / 三体）详情是 `CaseShowroom` 内部 state；`mode` 仍是 `showcase`。此时点导航「案例展厅」页签：`clearToBrowse("showcase")` 没有任何 state 变化，`CaseShowroom` 不重挂，**页面停在作品详情**。同时该详情不进 URL，刷新 / 分享回到展厅 | 主导航失效、与「公开数据实作」（走 `?case=`，可深链、可返回）行为不一致 | **P2** |
| TU-03 | `components/TutorialCenter.tsx:402-410` | 「帮助与创作」是原生 `<details>` + 绝对定位 `div`：无外点关闭、无 Esc 关闭、无 `aria-haspopup` / `role=menu` / 方向键；关闭只靠再点 summary 或点到菜单项。仓内已有 `components/ui/DropdownMenu` 原语 | 打开后悬在内容上方不消失；键盘 / 读屏拿不到菜单语义；与全站其它下拉不一致。见 `tutorials-help-menu-open--*.png` | **P2** |
| TU-04 | `components/TutorialCenter.tsx:443-460`（移动端 `<select>`）、`:455-457`（永不触发的「没有匹配教程」分支）、`:278-281`（`mobileFeatureOptions` 总含当前项）、`:1590`（侧栏 `hidden lg:flex`） | <lg 断点下搜索 / 分类筛选的唯一输出是 `<select>` 的 option 列表：命中 2 条或 0 条时页面**看不出任何变化**；空态文案「没有匹配教程」因为 `mobileFeatureOptions` 永远至少含当前项而**永不渲染** | 移动端搜索形同虚设。`tutorials-feature-search-{hit,empty}--mobile--light.png` 与 `tutorials-feature-detail--mobile--light.png` 除输入框文字外相同 | **P2** |
| TU-05 | `components/tutorials/CommunityTutorials.tsx:452-501`；`components/ui/Field.tsx:35-36` | 手写教程表单四个字段标了必填星号，但 `Input/Textarea` 没有原生 `required`，`Field` 明说"不做校验"；`minLength` 对空字符串不生效。空标题 / 空正文可直接提交，只能等服务端拒绝后看到一条泛化错误 | 表单校验缺失（PLAYBOOK §5.4） | **P2** |
| TU-06 | `components/tutorials/CommunityTutorials.tsx:499` | `placeholder="# 要解决的问题\n\n## 准备\n\n## 操作步骤\n\n## 如何核对结果"` 写在 JSX 属性字符串里，`\n` 不是转义 → 占位符显示字面 `\n\n` | 首屏可见的文案 bug。见 `tutorials-studio-submit--*.png` | **P2** |
| TU-07 | `components/tutorials/CommunityTutorials.tsx:106-126`（`loadCatalog`）、`:238-242`（错误 Alert）、`:319-325`（空态条件 `items.length===0 && !loading`） | 目录请求失败时 `items` 为空且 `loading=false` → 红色错误横幅与「还没有匹配的教程 / 你可以成为第一个分享这类经验的人」**同屏**；没有「重试」按钮（要靠再点「筛选」）；`openDetail` 复用同一个 `loading/error`，详情失败的错误也压在目录上 | 错误态误导 + 不可恢复（PLAYBOOK §5.3）。见 `tutorials-studio-error--*.png` | **P2** |
| TU-08 | `components/tutorials/CommunityTutorials.tsx:539-547`、`:582-586`；`lib/tutorialStudio.ts:126-128` | 「撤回」对 `draft / pending / approved` 三种状态都是**单击即发**，无确认、无 busy 态；撤回「已上线」教程会让它从公开目录下线，且状态机里没有撤回后恢复的路径。仓内有 `components/ui/ConfirmDialog` | 危险操作无确认（PLAYBOOK §5.3）。见 `tutorials-studio-mine--desktop--light.png` | **P2** |
| TU-09 | `components/tutorials/SnapshotTutorialDetail.tsx:93` | `<Badge tone="neutral">{item.category}</Badge>` 直出枚举 `research / coding / general`；同文件夹的 `CommunityTutorialDetailView` 与卡片用的是 `CATEGORY_LABEL[...]` | 英文开发者枚举泄漏（PLAYBOOK §5.6）。见 `tutorials-studio-snapshot--*.png` | **P2** |
| TU-10 | `lib/tutorialJourneys.ts:4`（`TUTORIAL_PENDING_CAPTURE_LABEL = "示例待真实运行采集"`）；`components/TutorialCenter.tsx:685-699`（hero「这些是待采集的任务脚本」）、`:709-711`（列表标题上方再一遍）、`:772`（每卡徽章）、`:862-866`（详情黄横幅）、`:1552-1556`（回放区再一遍）；`components/tutorials/CaseFieldReportVisual.tsx:24-26`（「案例演示」）、`:41-43`（「可核对成果」）、`:72-74`（「34 项复现测试通过」）、`:142-146`（「修复后 13 passed」）；`components/tutorials/MissionReplay.tsx:207-210` | "采集"是采集流水线的内部术语，用户不知道"待采集"意味着什么；同屏最多出现 3 次；而两张 fieldReport 案例的图稿同时写着「可核对成果 / 13 passed / 34 项通过」——**一边说"只是脚本"，一边亮出成绩** | 文案不可理解 + 诚实性口径互相打架（PLAYBOOK §5.6）。见 `tutorials-case-gallery--*.png`、`tutorials-case-detail--*.png`、`tutorials-case-detail-replay--mobile--light.png` | **P2** |
| TU-11 | `components/TutorialCenter.tsx:535-547`（`ViewTab` `py-2` ≈ 36px）、`:1686-1688`（`CategoryChip` `py-1.5` ≈ 30px）、`:1692`（`TopicList` 行 ≈ 40px）、`:445-450`（移动端 `<select>` `h-9` = 36px）、`:854-860`（「返回案例列表」文字按钮 ≈ 20px）；`components/tutorials/CaseShowroom.tsx:89`、`SignatureShowcases.tsx:48`、`CommunityTutorials.tsx:386-391`、`SnapshotTutorialDetail.tsx:85-90`（各返回按钮） | 教程中心自绘的页签 / 分类 chip / 目录行 / 返回按钮都不走设计系统 `Button` 的 `[@media(hover:none)]:min-h-11`（`components/ui/Button.tsx:53-54`）规则，触屏下命中区 20–40px | 移动端触控目标 < 44px（PLAYBOOK §5.2）。见各 `--mobile--` 截图 | **P2** |
| TU-12 | `components/tutorials/SignatureShowcases.tsx:34`（`text-[10px] text-white/40` on `#080e19`）、`:30`（`text-[10px]` kicker） | 精选作品的免责声明「原创代码实作 · 画面来自实际运行 · 非完整会话回放」是 10px、40% 白字压在深蓝黑底上，对比度约 3.3:1 | 这行字正是"别把它当成会话回放"的声明，却是整卡最不可读的一行；WCAG AA 正文要求 4.5:1（PLAYBOOK §5.1）。见 `tutorials-showroom--desktop--light.png` | **P2** |
| TU-13 | `components/TutorialCenter.tsx:264-268`（`showMissionReplay`）、`:482-488`；`components/tutorials/MissionReplay.tsx`（全文件 536 行）；`scripts/check-v5-tutorials.ts:1305-1306` | 渲染条件要求 `replay.status !== "pending_capture"`，门禁要求有 fieldReport 的案例必须是 `pending_capture` → **组件不可达**；它自己还硬编码「示例待真实运行采集 · 示意步骤 · 非真实轨迹」（`:207-210`），与"只对非 pending 案例显示"的意图自相矛盾 | 22 KB 死代码随 TutorialCenter 懒加载 chunk 一起发给用户；设计好的「五阶段任务回放」视图从未上线 | P3 |
| TU-14 | `components/TutorialCenter.tsx:600-674`（`CaseSidebar`）、`:150-192`（`tutorialCaseMatches`）、`:260`（`media` 未用）、`:455-457`（见 TU-04）；`lib/tutorialJourneys.ts:76-107`（`TUTORIAL_SCENARIO_PATHS`） | 案例侧栏（含分类计数、深链 href）、案例搜索匹配函数、5 条「按场景学习路径」都有实现 / 数据 / 测试，但没有任何渲染路径 | 死代码 + 已设计未落地的功能（PLAYBOOK §5.7）；也解释了 TU-15 | P3 |
| TU-15 | `components/TutorialCenter.tsx:676-734`（`CaseGallery`：12 卡一把梭）、`:701-704`（永不出现的空态） | 案例脚本总览没有分类（科研 5 / 编码 5 / 通用 2）筛选、没有搜索、没有按难度过滤；移动端 12 张全高卡片一列到底 | 找案例只能滚（PLAYBOOK §5.3）；任务书点名的"目录 / 分类 / 搜索"在案例这一侧缺席 | P3 |
| TU-16 | `components/TutorialCenter.tsx:1075-1089`（「先看成品 / 这些成果会直接交到你手里」）、`:1132-1222`（`ArtifactPreview`：写死的 `[42,68,54,88,72,96,78]` 柱状图、`$ run targeted-test` / `− failing behavior reproduced` 假终端） | 「成果预览」区渲染的是与案例无关的装饰数据，`role="img" aria-label="成果预览：…"` 还把它当真图播报；没有"示意"标注 | 与全模块反复强调的"不把示意冒充真实"背道而驰（PLAYBOOK §5.6）。见 `tutorials-case-detail-artifacts--*.png` | P3 |
| TU-17 | `components/TutorialCenter.tsx:238`（`browseView` 本地 state）、`:315-325`；`hooks/useAppRoute.ts:168-197`（只镜像 topic / case / community，shell 归属）；`App.tsx:3020-3022` | 「快速上手」「案例脚本」两个一级视图与精选作品详情都不进 URL：刷新 / 分享 / 浏览器后退全部回到展厅 | 深链不完整（PLAYBOOK §5.4）；需 shell 配合加 `view=` 参数，见 §4 | P3 |
| TU-18 | `components/TutorialCenter.tsx:1573-1604`（`FeatureSidebar`）、`:1690-1693`（`TopicList`）、`:269-277`（分类过滤） | 侧栏目录不会滚到当前教程（打开第 25 个「企业组织」时列表停在顶部）；按分类筛选后若当前教程不在该分类，列表里没有任何高亮，也不提示"当前正在看的不在筛选内" | 位置感丢失。见 `tutorials-feature-cta-disabled--desktop--light.png`、`tutorials-feature-category--desktop--light.png` | P3 |
| TU-19 | `components/TutorialCenter.tsx:292-294`（打开 900ms 即 `markTutorialRead`）；`lib/tutorialProgress.ts:35-51`；`components/TutorialCenter.tsx:558-596`（`QuickstartView` 无完成态） | 停留 0.9 秒就算「已读」，快速点过「接着了解」也全部打勾；没有总进度（如「已读 3/26」）；快速上手 6 步不显示哪些已完成 | 进度指示没有信息量（PLAYBOOK §5.3） | P3 |
| TU-20 | `components/TutorialCenter.tsx:304-313`（`copyText` `.catch(() => {})`）；`components/tutorials/SnapshotTutorialDetail.tsx:75-81`（`copyShare` 无 catch）；对照 `CaseShowroom.tsx:79-86` / `SignatureShowcases.tsx:46`（有失败提示） | 三套复制实现：一套失败静默、一套失败抛未处理 rejection、一套有失败文案；都不用 `components/ui/Toast` | 非安全上下文 / 权限拒绝时用户以为复制成功了 | P3 |
| TU-21 | `components/TutorialCenter.tsx:910-917`（`actionLabel === "登录后试用"` 字符串比较）、`:972-990`；`components/tutorials/CaseShowroom.tsx:56`、`:116-118`；`SignatureShowcases.tsx:55`；`MissionReplay.tsx:366-374`；`App.tsx:3117`（传入 `"登录后试用"`） | 同一动作五种 CTA 文案：「带着我的材料开始」「做一个我的版本」「做我的版本」「用我的材料开始」「登录后做我的版本」；登录态判断靠比较父组件传下来的**中文字面量** | 术语不统一（PLAYBOOK §5.6）；文案一改逻辑就断 | P3 |
| TU-22 | `components/TutorialCenter.tsx:804,912,1113,1117,1204,1212,1239,1312,1327,1330,1353,1382,1460,1463,1478,1481,1487,1502,1528,1531,1535,1547`；`components/tutorials/CaseFieldReportVisual.tsx:24,53,63,71,93,116,132,138,142`；`CaseArtwork.tsx:143,146`；`SignatureShowcases.tsx:30,34` | 大量 `text-[8px]`～`text-[10.5px]` 任意值字号（案例详情折叠区几乎全部正文是 10.5–11px，卡片指标标签 9.5px，图稿 8px） | 移动端可读性差、绕开 `text-micro/caption` 语义档位（shell 审计同类问题）；PLAYBOOK §5.1 | P3 |
| TU-23 | `components/TutorialCenter.tsx:1125-1127`（`<p className="sr-only" aria-live="polite">`）、`:461`（`<main>` 无 `relative`） | `sr-only` = `position:absolute`，最近的定位祖先是 `Dialog.Content`（`fixed`），于是这 1px 节点被放到 main 的滚动内容之外、对话框之下，把 `overflow-hidden` 的 Dialog.Content 撑出 454px（桌面）/ 1402px（移动）隐藏溢出；任何祖先级 `scrollIntoView` / 浏览器查找都会把 header + nav 顶出视口（探针 §2.3） | 潜伏布局缺陷；本轮首批截图已实际中招 | P3 |
| TU-24 | `components/TutorialCenter.tsx:535-547`（`ViewTab` 用 `aria-pressed` 充当页签）、`:1686-1688`（`CategoryChip` 无按压态）、`:753-823`、`CommunityTutorials.tsx:328-353`（整卡 `<button>` 里嵌 `h2/h3/ul/p` 块级元素）、`:256`（切视图只 `scrollTop=0`，焦点不动）；对照 `SignatureShowcases.tsx:45`（切详情会把焦点交给 `<h1 tabIndex=-1>`） | 页签没有 tablist/tab 语义；分类 chip 没有选中态语义；卡片按钮内容模型非法（读屏把整卡念成一个按钮名）；切换视图读屏无感知；桌面态到达正文前要 Tab 44 次、无"跳到内容" | 可访问性（PLAYBOOK §5.5） | P3 |
| TU-25 | `components/tutorials/CommunityTutorials.tsx:185-236`（hero 在所有子视图重复）、`:319-326` / `:512-556`（加载期无骨架）、`:369`（投稿成功只切到「我的发布」）、`:120`（「加载社区教程失败」） | 工作室每个子视图上方都顶着 ~120px（桌面）/ ~350px（移动）的 hero 卡；目录 / 我的发布加载时区域空白（`loading` 只体现在「筛选」按钮转圈）；投稿成功没有任何确认；「社区教程 / 教程工作室 / 探索教程」三种叫法 | 空间浪费、加载反馈弱、术语漂移（PLAYBOOK §5.1/5.3/5.6）。见 `tutorials-studio-snapshot--mobile--light.png` | P3 |
| TU-26 | `components/tutorials/PublishFromSessionDialog.tsx:288-290`（`{asset.sizeBytes} B`）、`:214`（hint 含 `htmlpreview`）；`SnapshotTutorialDetail.tsx:176-178`（`{artifact.bytes} B`）；`CommunityTutorials.tsx:597-599`（`toLocaleString` 带秒）；`TutorialCenter.tsx:1638`（「内容版本 8」） | `812000 B`、`18042 B` 原样字节；「提交于 2026/8/18 17:12:00」精确到秒；面向用户的提示里出现内部 kind 名 `htmlpreview`；详情页顶部的「内容版本 8」对用户没有含义。仓内已有 `lib/chat/download.formatBytes`（`TutorialReplay.tsx:4` 在用） | 文案 / 格式化（PLAYBOOK §5.6）。见 `tutorials-studio-snapshot-artifacts--*.png` | P3 |
| TU-27 | `components/tutorials/PublishFromSessionDialog.tsx:173-180` | 「提交快照审核」禁用条件是标题非空 && 摘要 ≥ 10 字 && 公开消息 > 0，但禁用时不说原因 | 用户对着灰按钮猜（PLAYBOOK §5.3）。见 `tutorials-studio-publish-dialog--*.png` | P3 |
| TU-28 | `components/tutorials/CaseShowroom.tsx:100`（`sandbox="allow-scripts"`、`h-[570px]`、`bg-[#f5f7fa]`）、`:96-97`；`SignatureShowcases.tsx:51`；`public/tutorials/cases/*/showcase/dashboard.html`（`<a download>`、`target=_blank` 外链） | 看板 iframe 沙箱没有 `allow-downloads` / `allow-popups`：看板内「下载可复算 CSV」「World Bank 来源」等点了没反应（外层页面另有同名下载链接兜住）；预览区固定 570px、硬编码浅色底，暗色主题下是一块白板；「打开交互看板」后封面立即消失只剩灰底 + 一行文字 | 静默失败 + 暗色不适配（PLAYBOOK §5.1/5.3）。见 `tutorials-showcase-detail-preview--desktop--*.png` | P3 |
| TU-29 | `components/tutorials/SignatureShowcases.tsx:26-28`；`public/tutorials/showcase-works/planet/cover.png` | 精选作品 hero 的封面图本身带有「下一颗星球，由你定义。」大字与参数面板，桌面态从左侧渐变里透出来，与卡片正文的标题重叠成"幽灵字" | 视觉噪音。见 `tutorials-showroom--desktop--*.png` 左上 | P3 |
| TU-30 | `components/tutorials/CaseFieldReportVisual.tsx:138-141`（`truncate` 代码行 + 固定高度容器） | 390px 下 `cright[-right.shape[0]:, -right.shape[1]:]` 与下一行 `− = 1` 重叠 / 被截 | 图稿在移动端破相。见 `tutorials-case-detail--mobile--light.png` | P3 |
| TU-31 | `lib/tutorialJourneys.ts:31-36`、`:50-54` | 快速上手第 1 步「发第一个任务」与第 4 步「看执行过程」都指向 `chat-basics`，用户点两次进同一篇 | 6 步主线实际只覆盖 5 篇；内容决策，见 §5 | P3 |
| TU-32 | `lib/tutorialActions.ts:61-71`；`App.tsx:1674-1679`（shell） | `resolveTutorialAction` 不知道 `TASKBOARD_ENABLED`；商业构建关掉任务面板时「任务面板」教程的 CTA 仍可点，点了只是关掉教程、什么都不发生 | selfhost 默认开启，只影响 `VITE_TASKBOARD_ENABLED=0` 的构建；需 shell 传一个布尔进 context | P3 |
| TU-33 | `components/TutorialCenter.tsx:375-381`（`text-body`）；对照 `CommunityTutorials.tsx:304`（`text-base md:text-sm`） | 顶部搜索框字号 < 16px，iOS Safari 聚焦会放大页面；工作室的搜索框已经按 16px 规避 | 移动端体验不一致（PLAYBOOK §5.2） | P3 |
| TU-34 | `components/TutorialCenter.tsx:685`、`:973`、`:1144`（`#07111f`）；`CaseShowroom.tsx:15`（`#f3f6ef`）、`:21`（`#102b29` / `#152442`）、`:100`（`#f5f7fa`）；`SignatureShowcases.tsx:10`、`:26`、`:50`（`#080e19` / `#101624`）；`MissionReplay.tsx:399`、`:451`（`#111827`）；`CaseFieldReportVisual.tsx:16` | 十余处硬编码色值绕开设计 token；深色 hero 在暗色主题下与背景几乎同色、失去卡片边界 | 主题一致性（PLAYBOOK §5.1）；见 `tutorials-case-gallery--desktop--dark.png` | P3 |
| TU-35 | `components/tutorials/SnapshotTutorialDetail.tsx:224-253`（`ReadonlyTextArtifact`） | 文本成果 `fetch` 成功但正文为空（如 204 / 空文件）时渲染一个空 `<pre>`，没有"内容为空"提示 | 边界态缺文案。见 `tutorials-studio-snapshot-artifacts--desktop--light.png` 的 `root-cause.md` 灰条 | P3 |
| TU-36 | 仓库根（无 `.gitattributes`）；`public/tutorials/cases/**/*.{html,json,csv,md}`、`packages/web-react/tutorial-sync*.json{,l}`、`tutorial-capture-provenance.json`；`lib/tutorialShowcase.test.ts:36-40`、`scripts/check-v5-tutorials.ts:1219-1221`、`:2043-2047` | 教程模块把"字节数 + SHA-256 逐位相等"当作证据契约，但这些文本夹具没有 `-text` / `eol=lf` 属性；Windows `core.autocrlf=true` 检出即 CRLF → 单测 2 条失败、门禁两处"不一致"（§2.4 末，已证明 LF 还原后逐位相等） | 阶段 B 交付前"模块 vitest 绿 + check:tutorials 绿"在 Windows 工作树上默认达不到；团队其它成员若碰这些测试同样中招 | P3 |
| TU-37 | `scripts/check-v5-tutorials.ts:405-415`（`relative(ROOT, file)`）、`:340-358`（`entryIdentityKey(file, …)`）、`:1694-1709`（进 `sourceHash / entryIdentityHash`） | 标记文件路径以本机分隔符进哈希（同文件里 `HISTORY_REPO_PATH` 已做了 `replaceAll("\\", "/")`，标记路径没做）→ Windows 上 26 个能力全部报「功能源 / 入口身份变化」，门禁无法作为本地校验工具使用 | 同上；也意味着任何在 Windows 上跑的 `tutorials:accept` 会写出与 CI 不一致的快照 | P3 |

---

## 4. 修复计划

每条：改哪些文件 / 怎么改 / 补什么测试 / 预计风险。阶段 B 在同一工作树 `wt/tutorials` 上做，
只碰归属文件；跨模块的三处（TU-17 路由、TU-32 App 接线、TU-34 新 token）见备注。

**先说门禁约束**（`scripts/check-v5-tutorials.ts`，阶段 B 每次改 `lib/tutorial*Catalog.ts` 前再读一遍）：

- `TUTORIAL_TOPICS` 正文、`TUTORIAL_CASES` 全文（含 `replay` 状态）都进 `tutorial-sync.json` 的 contentHash；
  改任何一个字都要同步提高该条 `contentVersion` 并跑 `npm run tutorials:accept -- --note "<说明>"`
  （会改写 `tutorial-sync.json`、追加 `tutorial-sync-history.jsonl`、更新 `-head.json`，三者随代码提交）。
- `PRODUCT_CAPABILITIES`（标题 / 别名 / 分类 / CTA / requirements）变化要求同时更新教程正文或媒体并提版本
  ——**本计划不碰注册表**。
- `TUTORIAL_PENDING_CAPTURE_LABEL`、`TUTORIAL_QUICKSTART`、`TUTORIAL_SCENARIO_PATHS`（`tutorialJourneys.ts`）
  不在哈希内，可自由改；但 `tutorialJourneys.test.ts` 会校验它们引用的 topicId 存在。
- 有 `fieldReport` 的案例 `replay.status` 必须保持 `pending_capture`（`:1305-1306`）——所以 TU-13 的
  解法只能是删组件或改渲染条件，不能改数据。
- 阶段 B 交付前 `npm run check:tutorials` 必须绿。

### TU-01 功能参考入口 · P2

- **文件**：`TutorialCenter.tsx`
- **改法**：nav 增加第三个 `ViewTab`「功能参考」（图标 `BookOpen`），`onClick={() => onTopicChange(DEFAULT_TUTORIAL_TOPIC)}`
  （`DEFAULT_TUTORIAL_TOPIC` 已导出，`:1719`）；`active={mode === "features"}`。搜索框保持只在功能参考
  显示，但把它从 header 移到 nav 右侧（与页签同一行），移动端折成 nav 下方一行（与分类 chips 合并为一条工具栏）。
- **测试**：`TutorialCenter.test.tsx` 补：① 默认打开（无 topicId）能看到「功能参考」页签，点击后回调
  `onTopicChange(DEFAULT_TUTORIAL_TOPIC)`；② 从功能参考点「案例展厅」再点「功能参考」能回到上次主题
  （App 侧 `tutorialTopic` 保留，这里只断言回调参数）。after 截图 `tutorials-showroom--*.png` nav 三页签。
- **风险**：低；只加入口，不改 mode 推导。

### TU-02 精选作品详情：页签失效 + 不可深链 · P2

- **文件**：`TutorialCenter.tsx`、`CaseShowroom.tsx`
- **改法**：把 `activeWork` 提升到 `TutorialCenter`（`const [signatureWork, setSignatureWork] = useState<SignatureWork['id'] | null>(null)`），
  `clearToBrowse` 里一并置空；`CaseShowroom` 改为受控（`activeWorkId` + `onSelectWork` props）。
  header 标题在作品详情下显示作品名而不是「案例展厅」。深链（`?work=planet`）需要 shell 的
  `useAppRoute` 加参数，本阶段先做"页签能回来"，深链作为 §4 末的 shell 请求。
- **测试**：`CaseShowroom.test.tsx` 补：点「探索这颗星球」后再触发 `onBack`/外部 `activeWorkId=null` 回画廊；
  `TutorialCenter.test.tsx` 补：进入作品详情后点「案例展厅」页签回到画廊（断言 `SignatureGallery` 的 `<h1>` 出现）。
- **风险**：低；`SignatureGallery` 的焦点恢复逻辑（`restoreFocusWorkId`）保留。

### TU-03 「帮助与创作」下拉 · P2

- **文件**：`TutorialCenter.tsx`
- **改法**：用 `components/ui/DropdownMenu`（Radix 封装，已被 Composer / 侧栏使用）替换 `<details>`：
  trigger 是 `Button variant="ghost" size="sm"` + `ChevronDown`，两个 `DropdownMenuItem`（教程工作室 / 案例脚本）
  带图标；当前视图对应项加 `aria-current`/勾。移动端触屏 `min-h-11`。
- **测试**：`TutorialCenter.test.tsx` 补：打开菜单 → Esc 关闭；打开 → 选「案例脚本」→ `mode` 变为 cases
  （断言 CaseGallery 标题）。after 截图 `tutorials-help-menu-open--*.png`。
- **风险**：低；如 `DropdownMenu` 在 Dialog 内 Portal 层级有问题，回退为 Radix `Popover`（ui 也有）。

### TU-04 移动端搜索 / 筛选零反馈 · P2

- **文件**：`TutorialCenter.tsx`
- **改法**：<lg 下 `<select>` 上方 / 内部显示结果计数：有查询或分类时渲染一行「N 篇匹配」；
  `filteredFeatures.length === 0` 时渲染「没有匹配的教程，换个关键词试试。」并给 `<select>` 一个
  `disabled` 的占位 option；删掉永不触发的 `:455-457` 分支。更彻底的做法（推荐）：查询非空时把
  `<select>` 换成一个可点的结果列表（复用 `TopicList`，`lg:hidden`），点选后收起。
- **测试**：`TutorialCenter.test.tsx` 补两例（`matchMedia` mock 为窄屏或直接断言 `lg:hidden` 容器内文案）：
  搜索无结果 → 出现空态文案；搜索命中 → 出现「2 篇匹配」。after 截图 `tutorials-feature-search-{hit,empty}--mobile--*.png`。
- **风险**：低。

### TU-05 / TU-06 / TU-27 手写教程 & 发布对话框表单 · P2 / P2 / P3

- **文件**：`CommunityTutorials.tsx`、`PublishFromSessionDialog.tsx`
- **改法**：
  1. `Input/Textarea` 传原生 `required`，提交前 `form.reportValidity()`；提交按钮在 `title.length<4 || summary.length<10 || body.length<40` 时 `disabled` 并在旁边给一行原因（"标题至少 4 字…"）。
  2. `placeholder={"# 要解决的问题\n\n## 准备\n\n## 操作步骤\n\n## 如何核对结果"}`（JS 字符串）。
  3. `PublishFromSessionDialog` 主按钮禁用时在 footer 左侧显示原因（缺标题 / 摘要不足 10 字 / 没有可公开消息）。
- **测试**：`CommunityTutorials.test.tsx` 补：空表单提交 → `api.submitCommunityTutorial` 未被调用、出现提示；
  `PublishFromSessionDialog.test.tsx` 补：摘要 5 字时显示原因文案。
- **风险**：低。

### TU-07 / TU-25 工作室目录：错误态、骨架、术语 · P2 / P3

- **文件**：`CommunityTutorials.tsx`
- **改法**：拆 `catalogError` / `detailError` 两个 state；错误时**不渲染空态**，`Alert tone="danger"` 里放
  「重试」`Button`（调 `loadCatalog(null,false)`）；加载中用 `components/ui/ListSkeleton`（目录 4 卡、我的发布 3 条）；
  投稿 / 撤回成功用 `useToast` 提示；统一叫「教程工作室」（错误文案「加载教程工作室目录失败」）；
  hero 在 `view !== 'catalog' || selected` 时收成一行工具栏（标题 + 四个按钮，去掉两行说明）。
- **测试**：`CommunityTutorials.test.tsx` 补：502 → 出现「重试」、不出现「还没有匹配的教程」；点重试 → 再次请求。
- **风险**：低；`api-stub` 场景 `tutorials-studio-error` 直接复拍。

### TU-08 撤回确认 · P2

- **文件**：`CommunityTutorials.tsx`
- **改法**：`withdraw` 前弹 `components/ui/ConfirmDialog`（标题「撤回这份教程？」，正文按状态区分：
  已上线 → "会从公开目录下线，重新发布需再次审核"；待审核 → "会退出审核队列"）；确认后按钮进入 `loading`。
- **测试**：补：点「撤回」不直接调 API；确认后调用且刷新列表；取消不调用。
- **风险**：低。

### TU-09 快照分类标签 · P2

- **文件**：`SnapshotTutorialDetail.tsx`、`lib/tutorialStudio.ts`
- **改法**：把 `CATEGORY_LABEL` 从 `CommunityTutorials.tsx` 挪到 `lib/tutorialStudio.ts` 导出（`communityCategoryLabel(id)`），
  两处引用；`SnapshotTutorialDetail.tsx:93` 改用它。
- **测试**：`SnapshotTutorialDetail.test.tsx` 补：`category:'coding'` 渲染「编码」。
- **风险**：无。

### TU-10 "待采集"口径统一 · P2

- **文件**：`lib/tutorialJourneys.ts`、`TutorialCenter.tsx`、`CaseFieldReportVisual.tsx`、`CaseArtwork.tsx`
- **改法**：
  1. `TUTORIAL_PENDING_CAPTURE_LABEL` 改为用户语言，例如「任务脚本 · 尚无真实运行记录」；hero 标题
     「这些是待采集的任务脚本」→「这些是任务脚本，还没有真实运行记录」，副标题保留"只当参考、不当成品"。
  2. 同屏只出现一次：卡片保留徽章，删 `:709-711` 的列表标题上方重复；详情页保留黄横幅，删徽章重复；
     回放区（`:1552-1556`）只留一段说明，删橙色标签行。
  3. 图稿：`CaseFieldReportVisual` 的「可核对成果」在 `replay.status==='pending_capture'` 时改为
     「观察记录 · 非平台验证」；「案例演示」→「示意图稿」。指标数字来自 `fieldReport`（真实观察），保留但
     加上述限定词。`MissionReplay` 的硬编码标签随 TU-13 一起处理。
  4. `PENDING_REPLAY.disclosure` 不动（门禁要求含"尚未完成三次独立运行"）。
- **测试**：`TutorialCenter.test.tsx` 现有对 `TUTORIAL_PENDING_CAPTURE_LABEL` 的断言按新文案更新；
  补：案例详情页该文案只出现一次（`getAllByText(...).length === 1`）。跑 `npm run check:tutorials`
  确认没碰到哈希内容。
- **风险**：中低——文案属产品口径，建议指挥官过目一版措辞；技术上无风险。

### TU-11 / TU-33 触控尺寸与搜索框字号 · P2 / P3

- **文件**：`TutorialCenter.tsx`、`CaseShowroom.tsx`、`SignatureShowcases.tsx`、`CommunityTutorials.tsx`、`SnapshotTutorialDetail.tsx`
- **改法**：`ViewTab` / `CategoryChip` / `TopicList` 行 / 各「返回」按钮统一加 `[@media(hover:none)]:min-h-11`
  （与 `Button.tsx:53-54` 同款）；移动端 `<select>` `h-9` → `h-11`；返回按钮改用 `Button variant="ghost" size="sm"`
  （自带触屏规则）；顶部搜索 `<input>` 加 `text-base md:text-sm`。
- **测试**：视觉——after 截图逐张对照 mobile；`TutorialCenter.test.tsx` 断言 class 无意义，不补。
- **风险**：低；桌面态零变化（规则只在 `hover:none` 生效）。

### TU-12 免责声明可读性 · P2

- **文件**：`SignatureShowcases.tsx`
- **改法**：`:34` → `text-caption text-white/75`；`:30` kicker → `text-micro sm:text-xs`。
- **测试**：after 截图 `tutorials-showroom--desktop--*.png`；对比度用 token 值复算 ≥ 4.5:1。
- **风险**：无。

### TU-13 / TU-14 死代码与未落地设计 · P3

- **文件**：`TutorialCenter.tsx`、`components/tutorials/MissionReplay.tsx`、`lib/tutorialJourneys.ts`
- **改法**（默认方案，见 §5 的决策点）：删除 `MissionReplay.tsx` 与 `:264-268 / :482-488` 的分支、删 `CaseSidebar`、
  `media`（`:260`）、`:455-457`；`tutorialCaseMatches` 保留并在 TU-15 里接线；`TUTORIAL_SCENARIO_PATHS`
  在 `QuickstartView` 底部渲染为「按场景学习」5 张卡（每卡列 4 个 topic 链接），让这份数据兑现。
- **测试**：`tutorialJourneys.test.ts` 现有约束不变；`TutorialCenter.test.tsx` 补：快速上手页出现 5 条场景路径、点击链接调 `onTopicChange`。
  删组件后 `npm run typecheck` + 模块 vitest 绿。
- **风险**：低；`MissionReplay` 没有测试引用（grep 确认只被 `TutorialCenter.tsx` import）。

### TU-15 案例脚本分类 / 搜索 · P3

- **文件**：`TutorialCenter.tsx`
- **改法**：`mode === "cases" && !selectedCase` 时显示 header 搜索框（复用现有 `query`，占位「搜索案例」），
  `CaseGallery` 上方一行 `CategoryChip`（全部 / 科研 / 编码 / 通用，复用 `CASE_CATEGORIES`），
  `items = TUTORIAL_CASES.filter(category).filter(tutorialCaseMatches(query))`；空态复用 `:701-704`。
- **测试**：`TutorialCenter.test.tsx` 补：搜索「SWE-bench」只剩 1 卡；选「通用」剩 2 卡。
- **风险**：低。

### TU-16 示意成果预览 · P3

- **文件**：`TutorialCenter.tsx`
- **改法**：`ArtifactPreview` 顶栏加「示意图 · 非本案例实际产物」胶囊；删掉假终端里的
  `$ run targeted-test / − failing behavior reproduced / + root cause fixed` 三行，改为展示所选产物的
  `title / format / description` 大字卡；`role="img"` 的 `aria-label` 前缀改「示意：」。标题
  「这些成果会直接交到你手里」→「你会拿到这些成果」。
- **测试**：`TutorialCenter.test.tsx` 补：成果预览区含「示意」字样。
- **风险**：无。

### TU-17 快速上手 / 案例脚本 / 精选作品深链 · P3（需 shell 配合）

- **文件**：`TutorialCenter.tsx`（本模块）+ `hooks/useAppRoute.ts`、`App.tsx`（shell）
- **改法**：`TutorialCenter` 增加受控 props `view?: 'showcase'|'start'|'cases'` / `onViewChange` 与
  `signatureWorkId` / `onSignatureWorkChange`（TU-02 已把 state 提上来），保持现有非受控默认值以兼容
  ui-preview 与测试；shell 侧在 `withPanelParams` 增加 `view=` / `work=` 两个 query、`parseTutorialView` /
  `parseTutorialWork`、`onPopPanel` 反灌。本模块先做 props，shell 接线走 `send_to`。
- **测试**：`TutorialCenter.test.tsx` 补：传 `view="start"` 直接渲染快速上手；`useAppRoute.test.ts`（shell）补 round-trip。
- **风险**：低；未接线前行为与现状一致。

### TU-18 / TU-19 侧栏定位与进度 · P3

- **文件**：`TutorialCenter.tsx`、`lib/tutorialProgress.ts`
- **改法**：`FeatureSidebar` 的 `nav` 加 ref，`activeId` 变化时把当前行滚到可见（用容器 `scrollTop` 计算，
  **不要** `scrollIntoView`，见 TU-23）；筛选后当前项不在列表时在列表顶显示一行「正在看：xx（不在此分类）」。
  已读判定改为"停留 ≥ 8s 或滚到正文 60%"（`IntersectionObserver` 观察「接着了解」区块）；侧栏「全部功能」
  行右侧显示「已读 n/26」；快速上手步骤按 `tutorialIsRead(step.topicId)` 打勾。
- **测试**：`tutorialProgress` 逻辑不变；`TutorialCenter.test.tsx` 补：打开 1s 内不标已读、触发观察后标已读（mock IO）。
- **风险**：中低——已读语义变化会让老用户的"已读"暂时减少（仅影响勾号，不影响数据）。

### TU-20 / TU-21 复制反馈与 CTA 文案收口 · P3

- **文件**：`TutorialCenter.tsx`、`CaseShowroom.tsx`、`SignatureShowcases.tsx`、`SnapshotTutorialDetail.tsx`、`lib/tutorialActions.ts`
- **改法**：新增 `components/tutorials/useCopyText.ts`（一个 hook：`copy(text) → 'ok'|'failed'`，成功 / 失败都走
  `useToast`），四处替换。`lib/tutorialActions.ts` 增加 `caseCtaLabel(authenticated: boolean): string`
  与 `caseCtaHint(...)`，统一为「带着我的材料开始」/「登录后带着材料开始」；组件接收
  `requiresLogin: boolean` 而不是比较中文字面量（`App.tsx:3117` 的 `caseActionLabel="登录后试用"` 保留兼容，
  组件内部用 `requiresLogin ?? actionLabel === '登录后试用'` 过渡）。
- **测试**：`tutorialActions` 的新函数补单测；`CaseShowroom.test.tsx` / `SignatureShowcases.test.tsx` 的 CTA 文案断言更新。
- **风险**：低。

### TU-22 / TU-34 字号与色值 · P3

- **文件**：`TutorialCenter.tsx`、`CaseFieldReportVisual.tsx`、`CaseArtwork.tsx`、`SignatureShowcases.tsx`、`CaseShowroom.tsx`
- **改法**：`text-[8px]~[10.5px]` 一律抬到 `text-micro`（11px）/ `text-caption`；折叠区正文用 `text-meta`。
  硬编码色：深色 hero 用现有 token `bg-fg text-bg`（亮色下即深底浅字，暗色下自动反转）或 `bg-sidebar`；
  `#f3f6ef / #f5f7fa` → `bg-surface`。若要保留品牌深蓝，需 shell 在 `styles.css` 加 `--hero-bg` token（§5）。
- **测试**：视觉对照。
- **风险**：低；图稿类（`CaseFieldReportVisual`）字号抬高后要看 390px 不溢出（与 TU-30 一起调）。

### TU-23 sr-only 逃出滚动容器 · P3

- **文件**：`TutorialCenter.tsx`
- **改法**：`<main ref={detailRef} className="tutorial-detail relative …">` 加 `relative`，让 main 成为所有
  `absolute` 后代的包含块（同时兜住未来任何 `sr-only`）。
- **测试**：仓外 `probe-scroll.mjs` 复跑：案例详情 `dialog.scrollHeight === clientHeight`；
  `scrollIntoView({block:'start'})` 后 `headerVisible === true`。jsdom 无布局，不补单测。
- **风险**：无。

### TU-24 可访问性 · P3

- **文件**：`TutorialCenter.tsx`、`CommunityTutorials.tsx`
- **改法**：nav 页签改 `role="tablist"` / `role="tab" aria-selected`（或保留 button 但用 `aria-current="page"`，
  去掉 `aria-pressed`）；`CategoryChip` 加 `aria-pressed`；卡片改为 `<article>` + 标题内 `<button>`
  （或整卡 `<a href>` 用 `tutorialHref`，内容模型允许块级）；`mode` 变化时把焦点交给正文 `<h1 tabIndex=-1>`
  （复用 `SignatureDetail` 的写法）；侧栏前加一个 `sr-only focus:not-sr-only` 的「跳到正文」链接。
- **测试**：`TutorialCenter.test.tsx` 补：切到案例脚本后 `document.activeElement` 是 CaseGallery 的 h1。
- **风险**：低。

### TU-26 / TU-35 字节、时间、术语、空文本 · P3

- **文件**：`PublishFromSessionDialog.tsx`、`SnapshotTutorialDetail.tsx`、`CommunityTutorials.tsx`、`TutorialCenter.tsx`
- **改法**：字节用 `formatBytes`（`lib/chat/download`，messages 归属但只 import 已导出函数，不改它）；
  「提交于」用 `TimeAgo`（ui）或 `toLocaleDateString`；hint 去掉 `htmlpreview`；「内容版本 8」删除
  （或改为 `title` 属性）；`ReadonlyTextArtifact` 空文本时显示「文本成果为空」。
- **测试**：`SnapshotTutorialDetail.test.tsx` 补：`bytes: 18042` 渲染「17.6 KB」；空文本渲染提示。
- **风险**：无。

### TU-28 iframe 沙箱与预览区 · P3

- **文件**：`CaseShowroom.tsx`、`SignatureShowcases.tsx`
- **改法**：展厅两类 iframe（仓内静态资产，可信）`sandbox="allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox"`
  ——**不加** `allow-same-origin`；`HTML_EMBED_SANDBOX`（社区投稿，不可信）保持 `allow-scripts` 不动。
  预览区 `h-[570px] bg-[#f5f7fa]` → `h-[min(70dvh,570px)] bg-surface`，加载期用 `Skeleton` 铺满而不是一行灰字。
- **测试**：`CaseShowroom.test.tsx` 补：iframe `sandbox` 属性包含 `allow-downloads`、不含 `allow-same-origin`；
  `tutorialStudio.test.ts` 的 `htmlEmbedSandboxIsSafe` 断言不变。
- **风险**：低；`sandbox` 放宽只针对仓内构建产物。

### TU-29 / TU-30 图稿修补 · P3

- **文件**：`SignatureShowcases.tsx`、`CaseFieldReportVisual.tsx`（`cover.png` 归资产，不动）
- **改法**：hero 渐变 `from-[#080e19] via-[#080e19]/90` → `via-[#080e19]/97`，并给 `WorkCover` 加
  `object-position: 78% center`，把封面的文字区推出可见范围；`AstropyPatch` 代码行去掉 `truncate`，
  改为 `break-all` 并在 `<390px` 下隐藏第一行（`hidden sm:block`）。
- **测试**：after 截图。
- **风险**：无。

### TU-32 任务面板 CTA · P3（需 shell 配合）

- **文件**：`lib/tutorialActions.ts`（本模块）+ `App.tsx:1589-1600`（shell）
- **改法**：`TutorialActionContext` 增加 `taskboardEnabled?: boolean`；`resolveTutorialAction` 在
  `feature.destination.kind === 'taskboard' && context.taskboardEnabled === false` 时返回
  `{enabled:false, disabledReason:'当前部署未开启任务面板。'}`。App 侧传 `taskboardEnabled: TASKBOARD_ENABLED`
  ——`send_to` shell owner，一行改动。
- **测试**：`tutorialActions` 单测补两例。
- **风险**：无。

### TU-36 / TU-37 字节精确夹具与门禁的 Windows 可移植性 · P3

- **文件**：`scripts/check-v5-tutorials.ts`（任务书"允许改动"列表内）；仓库根 `.gitattributes`（不在归属表，需指挥官）
- **改法**：
  1. 门禁：`collectMarkers` 里 `const rel = relative(ROOT, file).replaceAll("\\", "/")`（与 `HISTORY_REPO_PATH`
     同款），`entryIdentityKey` 收到的即已归一化；读文本夹具时不做行尾归一化（契约就是字节精确，改的是路径不是内容）。
     改完在本机跑 `npm run check:tutorials` 应当直接绿（`tutorial-sync.json` 不需要 `accept`——POSIX 上生成的快照
     本来就是正斜杠）。
  2. `.gitattributes`（请指挥官加到 integration 分支根目录）：
     `packages/web-react/public/tutorials/** -text`、`packages/web-react/tutorial-sync*.json -text`、
     `packages/web-react/tutorial-sync-history.jsonl -text`、`packages/web-react/tutorial-capture-provenance.json -text`。
     加上后 Windows 检出即 LF，不再需要 §2.6 那步手工重检。
- **测试**：本机 `check:tutorials` 绿 + `tutorialShowcase.test.ts` 4/4；`scripts/check-v5-tutorials.test.ts`
  （若存在）补一例：Windows 风格路径经归一化后 `entryIdentityKey` 与 POSIX 相同。
- **风险**：低；哈希输入在 POSIX 上不变，CI 无感。

### 跨模块请求（阶段 B 开始时 `send_to`）

| 对象 | 文件 | 想要的改动 | 为什么 |
|---|---|---|---|
| shell owner | `hooks/useAppRoute.ts`、`App.tsx` | `?panel=help` 增加 `view=start\|cases` 与 `work=planet\|gravity` 两个参数并镜像 / 反灌 | TU-17 / TU-02 深链 |
| shell owner | `App.tsx:1589-1600` | `tutorialActionContext` 加 `taskboardEnabled: TASKBOARD_ENABLED` | TU-32 |
| shell owner | `styles.css` | （可选）`--hero-bg / --hero-fg` token | TU-34 保留品牌深蓝 |
| 指挥官 | 仓库根 `.gitattributes` | 教程夹具 `-text` | TU-36 |

---

## 5. 建议不修 / 暂缓项及理由

- **TU-13 的方案需要拍板**：`MissionReplay` 是删（默认，22 KB 死代码）还是改条件让它对两条
  `fieldReport` 案例显示（作为"观察记录回放"，并把它的标签从「示例待真实运行采集」改成「观察记录 · 非平台验证」）。
  产品上后者更有内容价值，但要重新校对它里面写死的 R² / RMSE / 13 passed 与 `fieldReport` 一致。
  阶段 B 开工前 `ask_decision`。
- **TU-31 快速上手第 1 / 4 步同指「对话入门」**：是内容决策——可把第 4 步改指「设定目标」或「任务面板」，
  也可合并两步；不在 UI 层拍板，列出供指挥官 / 用户选。
- **TU-34 品牌深蓝 hero**：现有 token 里没有等价色；要么接受 `bg-fg` 的自动反转，要么 shell 加 token。
  阶段 B 默认前者。
- **12 条案例全部 `pending_capture`、`TutorialReplay` verified 分支无数据**：这是采集流水线的进度问题
  （`tutorial-capture-provenance.json` / `check:tutorials` 那一套），不是前端缺陷；本轮只把口径讲清（TU-10），
  不伪造状态。
- **`shoot.mjs` 的 2 条存量 biome 诊断**（`useTemplate`、`organizeImports`）：不属于本模块，不顺手改，
  避免与其它分支冲突；已在 §2.6 说明。
- **教程演示视频 / 海报的内容质量**（26 对 webm/webp）：门禁校验哈希、尺寸、时长、去重与录制来源，
  本轮只核对存在性与兜底路径；画面内容是否过时属媒体重录范畴（`npm run tutorials:media`），不在 UI 审计内。
- **真后端行为**（投稿审核、快照隐私扫描、blob 内嵌）：无法在本机验证，相关组件只做了表单 / 状态 / 文案层面的审计。

---

## 6. 修复记录（阶段 B）

- 分支：`feat/v5-selfhost-audit-tutorials`（阶段 A 终点 `5bf80f0bc`）；执行：fable-5-1-54（t-53）。
- 接手说明：fable-5-1-35 21:33 自领后在工作树里留下了**未提交**的阶段 B 改动（`TutorialCenter.tsx` +412/−246、
  `CaseShowroom` / `CaseArtwork` / `CaseFieldReportVisual`，覆盖 TU-01/02/03/04/10/11/13/14/15/16/18/19/23/24/26/33
  的代码部分，无用例），22:09 掉线。本手逐条核对后**沿用**，补齐用例与文案常量（`TUTORIAL_PENDING_CAPTURE_LABEL`、
  `TutorialReplay` 回放区）、删除 `MissionReplay.tsx`、落地 TU-31，作为首个提交 `e722bdf5f`；其余三个提交是本手新做。
- §5 两个决策点按指挥官拍板落地：① `MissionReplay` 确认只被 `TutorialCenter` 引用且渲染条件不可达 → **删除**（22 KB）；
  ② 快速上手第 4 步「看执行过程」改指「设定目标」（`session-goal`；`TUTORIAL_QUICKSTART` 不在门禁哈希内，未动目录数据）。
  其余口径按「最小改动、可回退、不改既有交互约定」自定，见下表。

| 编号 | 严重度 | 状态 | 改动（`packages/web-react/src/` 下） | 用例 | 提交 |
|---|---|---|---|---|---|
| TU-01 | P2 | ✅ | `TutorialCenter.tsx`：nav 增「功能参考」页签（`BookOpen`），`lastTopicRef` 记住最近主题，再点回来是上次那篇；搜索框进 header（`TutorialSearch`），<lg 独占第二行 | `TutorialCenter.test`「功能参考有一级入口…」 | `e722bdf5f` |
| TU-02 | P2 | ✅ | 精选作品选中态上提到 `TutorialCenter`（`signatureWorkId`），`CaseShowroom` 受控（`activeWorkId` / `onActiveWorkChange`，不传退回内部 state）；`clearToBrowse` 一并清空；header 标题随作品。深链 `?work=` 见 §9 | `TutorialCenter.test`「精选作品详情受控…」、`CaseShowroom.test`「can be controlled by the parent」 | `e722bdf5f` |
| TU-03 | P2 | ✅ | 「帮助与创作」换 `ui/DropdownMenu`（`modal={false}`）+ `HelpMenuItem`（`aria-current`、勾、触屏 44px）；Esc / 外点 / 方向键由 Radix 提供 | `TutorialCenter.test`「…Esc 关闭、menuitem 语义」 | `e722bdf5f` |
| TU-04 | P2 | ✅ | <lg 有查询时把 `<select>` 换成结果列表（`nav[aria-label=搜索结果]` + `TopicList`，计数「N 篇匹配「q」」，点选清空查询）；分类筛选下给「「分类」下共 N 篇 / 没有教程」；`<select>` `h-11` + 16px；删掉永不触发的空态分支 | `TutorialCenter.test` ×2（命中计数 / 空态） | `e722bdf5f` |
| TU-05 | P2 | ✅ | `CommunityTutorials.tsx`：`communityTutorialDraftIssue`（标题 4 / 摘要 10 / 正文 40 字）前置到提交按钮（禁用 + `<output>` 旁注原因），`submit` 再拦一次；`Input/Textarea` 加 `required`，`form noValidate` 交给自家提示 | `CommunityTutorials.test`「空表单不能提交…」 | `d6eb6ef35` |
| TU-06 | P2 | ✅ | 正文 placeholder 改 JS 字符串，真正换行 | 同上（断言 placeholder 含 `\n\n## 准备`、不含字面 `\n`） | `d6eb6ef35` |
| TU-07 | P2 | ✅ | `catalogError` / `detailError` 分离；目录读失败渲染带「重试」的 `Alert tone=danger`，**不再**渲染空态；空态只在 `loadedOnce` 后出现；加载期 `ListSkeleton variant=card rows=4`（我的发布 `rows=3`） | `CommunityTutorials.test`「目录读失败时给「重试」…」 | `d6eb6ef35` |
| TU-08 | P2 | ✅ | 撤回先 `useConfirm`（标题「撤回这份教程？」，正文 `withdrawConsequence(status)` 按已上线 / 待审核 / 草稿区分，`danger`），确认后按钮 `loading`、其余禁用；成功 toast「已撤回」 | `CommunityTutorials.test` ×3（已上线确认后调用 / 取消不调用 / 草稿） | `d6eb6ef35` |
| TU-09 | P2 | ✅ | `CATEGORY_LABEL` 收口到 `lib/tutorialStudio.ts`（`COMMUNITY_CATEGORY_LABEL` / `communityCategoryLabel`），目录卡 / Markdown 详情 / 快照详情三处共用 | `SnapshotTutorialDetail.test`（「科研」且正文不含 `research`） | `d6eb6ef35` |
| TU-10 | P2 | ✅ | `TUTORIAL_PENDING_CAPTURE_LABEL` = 「任务脚本 · 尚无真实运行记录」；hero「这些是任务脚本，还没有真实运行记录」+「N 条脚本」胶囊；列表标题上方与详情卡头徽章删除，详情只留黄横幅一句；回放区只留 `TutorialReplay` 自己那段（文案改「这个案例还没有真实运行记录…」）；`CaseArtwork`/`CaseFieldReportVisual` 新增 `pendingCapture`：「案例演示」→「示意图稿」、「可核对成果」→「观察记录 · 非平台验证」、`aria-label` 注明数字来自人工观察记录 | `TutorialCenter.test`「…且详情页只说一次」、`TutorialReplay.test`、`tutorialJourneys.test`（文案不含「采集」） | `e722bdf5f` / `36ba6e6f0` |
| TU-11 | P2 | ✅ | `ViewTab` / `HelpMenuItem` / `CategoryChip` / `TopicList` 行 / 快速上手链接 `[@media(hover:none)]:min-h-11`；`<select>` `h-11`；六处「返回」按钮改 `Button variant=ghost size=sm`（`CaseDetail` / `ShowcaseDetail` / `SignatureDetail` / `CommunityTutorialDetailView` / `SnapshotTutorialDetail`） | 视觉（after mobile 逐张） | `e722bdf5f` / `d6eb6ef35` / `36ba6e6f0` |
| TU-12 | P2 | ✅ | `SignatureShowcases.tsx` 免责声明 `text-[10px] text-white/40` → `text-caption text-white/75`（`#080e19` 底上 ≈ 11.6:1）；kicker `text-micro` | 视觉 | `36ba6e6f0` |
| TU-13 | P3 | ✅ | 删除 `components/tutorials/MissionReplay.tsx` 与 `TutorialCenter` 里的 import / `showMissionReplay` 分支（拍板①） | typecheck + 模块 vitest | `e722bdf5f` |
| TU-14 | P3 | ✅ | 删 `CaseSidebar` / `media` / 永不触发分支；`TUTORIAL_SCENARIO_PATHS` 在快速上手底部渲染为 5 张「按场景学习」卡（每卡 4 个章节按钮，已读打勾） | `TutorialCenter.test`「快速上手底部兑现 5 条按场景学习路径」 | `e722bdf5f` |
| TU-15 | P3 | ✅ | `CaseGallery` 加分类 chip（`fieldset[aria-label=案例分类]`）+ 搜索框 + 「N / 12 条」计数；`tutorialCaseMatches` 接线；空态 `<output>` | `TutorialCenter.test`「案例脚本总览可按分类与关键词筛选」 | `e722bdf5f` |
| TU-16 | P3 | ✅ | `ArtifactPreview` 顶栏「示意图 · 非本案例实际产物」胶囊；假终端三行改为流程示意（复现 → 定位 → 修复 → 回归）；`aria-label` 前缀「示意：」；标题「你会拿到这些成果」 | `TutorialCenter.test`（含「示意图 · 非本案例实际产物」、`img[name^=示意：]`） | `e722bdf5f` |
| TU-17 | P3 | ⏸ | 需 shell `useAppRoute` 加 `view=` / `work=`；本模块受控 props 未先做（TU-02 已把 state 提到 `TutorialCenter`，接线成本已降到一层 props），见 §8 / §9 | — | — |
| TU-18 | P3 | ✅ | `FeatureSidebar` 目录 `nav` 加 ref，`activeId` 变化时用容器 `scrollTop` 把当前行滚进可见区（不 `scrollIntoView`）；筛选后当前项不在列表时顶部「正在看：xx（不在当前筛选内）」 | jsdom 无布局，提示行走 TU-04 用例路径 | `e722bdf5f` |
| TU-19 | P3 | ◐ | 快速上手步骤按 `tutorialIsRead` 打勾（绿底 ✓）；侧栏「全部功能」右侧「已读 n/26」。**未改**「停留 0.9s 即已读」的判定（涉及老用户已读数据口径，留待产品定） | 视觉 | `e722bdf5f` |
| TU-20 | P3 | ◐ | `SnapshotTutorialDetail` 分享链接复制加 `try/catch`，失败走 `useToast` error；`SignatureDetail` / `ShowcaseDetail` 既有失败文案保留。**未**抽成统一 hook | — | `d6eb6ef35` |
| TU-21 | P3 | ⏸ | CTA 五种文案与「登录后试用」字面量比较未收口：涉及 `App.tsx:3117` 传参与 3 个组件的用例 / 场景文案，属产品口径，见 §8 | — | — |
| TU-22 | P3 | ◐ | `ArtifactPreview` / `CaseFieldReportVisual` / `TutorialReplay` 的 8–11px 任意字号抬到 `text-micro` / `text-caption` / `text-meta`；`TutorialCenter` 折叠区其余 10.5px 未动（量大、需逐处看 390px） | 视觉（`tutorials-case-detail--mobile` 图稿不溢出） | `e722bdf5f` / `36ba6e6f0` |
| TU-23 | P3 | ✅ | `<main className="tutorial-detail relative …">` | 仓外探针未复跑（jsdom 无布局）；after 首批 108 张无一被顶出 header | `e722bdf5f` |
| TU-24 | P3 | ◐ | `ViewTab` `aria-pressed` → `aria-current=page`；`CategoryChip` / 侧栏分类 `aria-pressed`；状态播报统一 `<output>`；分类簇 `fieldset`。**未做**：卡片按钮内容模型（整卡 `<button>` 内嵌块级）、切视图焦点交接、「跳到正文」链接 | `TutorialCenter.test`（menuitem / status 断言） | `e722bdf5f` / `527a514e2` |
| TU-25 | P3 | ✅ | hero 在子视图 / 详情下收成一行工具栏（`compactHero`，h1 `sr-only` 保留语义）；目录 / 我的发布加载期 `ListSkeleton`；投稿 / 快照 / 撤回成功 `toast`；术语统一「教程工作室」「我的发布」 | `CommunityTutorials.test`（既有 8 例回归） | `d6eb6ef35` |
| TU-26 | P3 | ✅ | 字节走 `lib/chat/download.formatBytes`（快照成果 / 发布对话框成果）；「提交于」`dateStyle: medium` + `timeStyle: short`；hint 去 `htmlpreview`；「内容版本 N」收进 `data-content-version` | `SnapshotTutorialDetail.test` / `PublishFromSessionDialog.test` / `CommunityTutorials.test`（不含 `:ss`） | `e722bdf5f` / `d6eb6ef35` |
| TU-27 | P3 | ✅ | `snapshotSubmitIssue`（没有标题 / 摘要不足 10 字 / 无可公开消息）显示在 footer 左侧 `<output>`，主按钮据此禁用 | `PublishFromSessionDialog.test`「主按钮禁用时写明原因…」 | `d6eb6ef35` |
| TU-28 | P3 | ✅ | `SHOWCASE_IFRAME_SANDBOX`（`allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox`，**无** `allow-same-origin`）用于展厅两类 iframe；社区投稿 `HTML_EMBED_SANDBOX` 不动；预览区 `h-[min(70dvh,570px)] bg-surface`，加载期 `Skeleton` 铺满 | `CaseShowroom.test` / `SignatureShowcases.test`（沙箱含 downloads、不含 same-origin）、`tutorialStudio.test` `htmlEmbedSandboxIsSafe` 不变 | `36ba6e6f0` |
| TU-29 | P3 | ◐ | hero 渐变 `/90` → `/97`，封面 `object-position: 78% center`。after 桌面图里「下一颗星球，由你定义。」仍隐约可见（封面图自带大字，`cover.png` 归资产不动），已明显减弱 | 视觉 | `36ba6e6f0` |
| TU-30 | P3 | ✅ | `AstropyPatch` 上下文行 `hidden sm:block break-all`，徽章行 `flex-wrap`；390px 下不再重叠 | 视觉（`tutorials-case-detail--mobile`） | `36ba6e6f0` |
| TU-31 | P3 | ✅ | 第 4 步 `topicId` → `session-goal`，正文改「方向不对就暂停，改一改目标再继续」（拍板②） | `tutorialJourneys.test`「主线每一步指向不同章节」 | `e722bdf5f` |
| TU-32 | P3 | ◐ | `TutorialActionContext.taskboardEnabled?`；显式 `false` 时任务面板 CTA `enabled:false` +「当前部署未开启任务面板。」。App 侧 `taskboardEnabled: TASKBOARD_ENABLED` 一行交集成③（§9） | `tutorialSystem.test`「部署关掉任务面板时…」 | `36ba6e6f0` |
| TU-33 | P3 | ✅ | 顶部搜索 `text-base md:text-body` | — | `e722bdf5f` |
| TU-34 | P3 | ⏸ | 十余处品牌深蓝 `#07111f / #080e19 / #101624` 未换：改 `bg-fg` 会让 hero 在亮色下成纯黑、暗色下反转成浅底，与图稿 / 精选作品封面的深色调冲突；等 shell `--hero-bg` token（§9） | — | — |
| TU-35 | P3 | ✅ | `ReadonlyTextArtifact` 空文本 → 「这份文本成果内容为空。」 | — | `d6eb6ef35` |
| TU-36 | P3 | ⏸ | `.gitattributes` 归仓库根（集成② 已列入）；本工作树夹具此前已手工 LF 还原，`tutorialShowcase.test` 4/4 绿 | — | — |
| TU-37 | P3 | ⏸ | `scripts/check-v5-tutorials.ts` 路径归一化未做（任务书：Windows 下 `check:tutorials` 默认红，标 NOT RUN 不绕）；修法仍是 §4 那一行 `replaceAll("\\", "/")` | — | — |

计划外：

- 窄屏页签：390px 下「案例展厅 / 快速上手 / 功能参考」+「帮助与创作」放不下带图标版本，第三个页签被裁一半（after 首批
  `tutorials-feature-search-hit--mobile` 暴露）→ `ViewTab` 图标 `max-sm:hidden`、`px-2.5 sm:px-3`（`527a514e2`）。
- 截图台 `scenes-tutorials.tsx` 的 `clickByText`：Radix 触发器不响应 `click`，先发 `pointerdown` 再 `click`，并识别
  `[role=menuitem]`——否则所有经「帮助与创作」进入的场景都停在展厅（`527a514e2`）。
- biome `useSemanticElements`：7 处 `p/div[role=status]` → `<output>`、分类簇 `div[role=group]` → `fieldset`（`527a514e2`）。

## 7. 验证（阶段 B）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0（每次提交前各跑一次） |
| 模块单测 | `npx vitest run src/components/TutorialCenter.test.tsx src/components/tutorials src/lib/tutorial{Journeys,Studio,Api,System,Showcase}.test.ts --maxWorkers=1` | ✅ 12 文件 / 95 例全绿（阶段 A 基线 12 / 82，其中 `tutorialShowcase` 2 例因 autocrlf 红；本工作树夹具已 LF 还原后 4/4 绿）。新增 13 例：TutorialCenter +6、CaseShowroom +1、CommunityTutorials +3、PublishFromSessionDialog +1、tutorialJourneys +1、tutorialSystem +1；另 4 处既有断言按新文案 / 沙箱更新 |
| 代码风格 | `npx biome lint` 22 个改动文件（含删除前的对照） | ✅ 阶段 B 新增 0：`TutorialCenter.tsx` 4 → 2（去掉 2 条 `useKeyWithClickEvents`，余 1 `useExhaustiveDependencies` + 1 `noShadowRestrictedNames` 为基线）；`CommunityTutorials.tsx` 1（基线）；其余文件与基线逐条相同或 0；新增 / 重写的 `scenes-tutorials.tsx` 0 |
| 视觉 after | `OC_UI_SCENES=tutorials`、`OC_UI_SHOT_DELAY=900` → `D:\code\test_project\test123\.audit-tmp\tutorials\after\` | ✅ 27 场景 × desktop/mobile × light/dark = 108 张，`failures: []` / `retried: []` / `unmockedApi: []`（两轮：首轮暴露菜单场景与窄屏页签问题，修后复拍） |
| 门禁 | `npm run check:tutorials` | **NOT RUN**：未改 `lib/tutorial*Catalog.ts` 与 `public/tutorials` 数据（`TUTORIAL_QUICKSTART` / `TUTORIAL_PENDING_CAPTURE_LABEL` 不在哈希内）；Windows 下该门禁因 TU-37 默认红，任务书要求不绕 |
| 全量 / 浏览器门 | `npm test` / `npm run test:browser` | **NOT RUN**：改动限于 tutorials 归属 + `lib/tutorialStudio` / `tutorialActions` 纯函数；未触碰 Composer / 消息 / 工具卡 / 侧栏；全量门交集成③ |

after 对照（Read 逐张，`before/` ↔ `after/`）：

- `tutorials-showroom--desktop--light` —— nav 三页签（案例展厅 / 快速上手 / 功能参考）；免责声明由几乎不可读变为清晰可读；封面幽灵字明显减弱。
- `tutorials-help-menu-open--{desktop,mobile}--light` —— 真菜单（图标 + 两项），390px 下三页签完整不裁切。
- `tutorials-feature-search-hit--mobile--light` —— 「2 篇匹配「GitHub」」+ 两条结果直接列出（此前与未搜索时逐像素相同）。
- `tutorials-case-gallery--desktop--light` —— hero 改人话 + 「12 条脚本」；分类 chip + 搜索 + 「12 / 12 条」；卡片徽章「任务脚本 · 尚无真实运行记录」，图稿「示意图稿 / 观察记录 · 非平台验证」。
- `tutorials-case-detail--mobile--light` —— 横幅只说一次；图稿代码行不再重叠；「返回案例列表」为 Button。
- `tutorials-quickstart--desktop--light` —— 第 4 步指「设定目标」。
- `tutorials-studio-submit--desktop--light` —— hero 收成一行；占位符真正换行；hint 带最小字数。
- `tutorials-studio-error--desktop--light` —— 只有错误条 + 「重试」，不再与空态同屏。
- `tutorials-studio-mine--desktop--light` —— 「提交于 2026年8月18日 17:12」不带秒。
- `tutorials-studio-snapshot--desktop--light` —— 分类「编码」而非 `coding`。

## 8. 遗留

| 项 | 归属 / 原因 | 建议 |
|---|---|---|
| TU-17 深链 `view=` / `work=` | shell `useAppRoute` + `App.tsx` | 本模块 state 已上提，shell 接 `?panel=help&view=&work=` 后本模块只需把 `browseView` / `signatureWorkId` 改受控（一层 props） |
| TU-21 CTA 文案五种 + 字面量比较 | 产品口径 + `App.tsx:3117` 传参 | 统一「带着我的材料开始 / 登录后带着材料开始」并加 `requiresLogin` prop；需同批改 3 个组件用例与场景 |
| TU-34 品牌深蓝 hero | shell token | `styles.css` 加 `--hero-bg / --hero-fg` 后一次替换 |
| TU-19 已读判定 0.9s | 产品口径 | 改「停留 ≥ 8s 或滚到 60%」会让老用户已读勾号变少，先问再改 |
| TU-20 统一复制 hook | 打磨 | 三处复制反馈已各有失败出口，统一 hook 收益小 |
| TU-22 / TU-24 余量 | 打磨 | 折叠区 10.5px 字号、卡片内容模型、焦点交接、跳到正文 |
| TU-36 `.gitattributes` | 仓库根（集成②） | 已在集成② 清单 |
| TU-37 门禁路径归一化 | `scripts/check-v5-tutorials.ts` | 一行 `replaceAll("\\", "/")`，CI（POSIX）无感 |

## 9. 跨模块接线（给集成③ / owner）

| 对象 | 文件 | 改动 | 为什么 |
|---|---|---|---|
| shell | `App.tsx:1589-1600` `tutorialActionContext` | 加 `taskboardEnabled: TASKBOARD_ENABLED` 一行 | TU-32 本模块已支持，未接线前行为与现状一致（按开启处理） |
| shell | `hooks/useAppRoute.ts`、`App.tsx` | `?panel=help` 增 `view=start\|cases`、`work=planet\|gravity` 并镜像 / 反灌 | TU-17 / TU-02 深链 |
| shell | `styles.css` | （可选）`--hero-bg / --hero-fg` | TU-34 |
| 指挥官 | 仓库根 `.gitattributes` | 教程夹具 `-text` | TU-36 |
