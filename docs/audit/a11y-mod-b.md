# a11y-B · media / messages / tools / taskboard / landing / composer 模块内修复（t-895，接 t-762）

> 上游：t-762「交互友好专项·键盘/焦点/无障碍走查」问题清单（仓库外 `D:\code\test_project\test123\.audit-tmp\a11y\DELIVERABLE.md`，
> 扫描 HEAD `419e0d218`）。本单只修其中**归属这六个模块、与 shell 令牌 / 原语无关**的条目；
> shell 层（faint / hljs / TimeAgo / Sheet 原语 / DropdownMenu 触控）归 t-893（a11y-shell），
> settings / org / manage / market / sidebar 归 t-894（a11y-mod-a）。
>
> 分支 `feat/v5-selfhost-audit-a11y-mod-b`，基线 = integration `be20adaec`（集成③ 5/6），之上 5 个代码提交 + 本文档。
> 提交 subject 均为 feat / style / docs(v5)，无 fix(v5)（d-26）。

- **统计：t-762 归属本单 10 条（P2 1 / P3 9）→ 修复 10 / 不修 0 / 遗留 0**；顺手 1 处（landing 折叠态 `aria-controls` 悬空引用，同 t-762 manage#2 口径）。验收通过后又接 QA t-1038 移交 2 条（landing L-11、media M-23）作附录提交，见文末「附录」。
- **接手说明**：原持有人随名单换轮离队，工作树里留下 11 个源码文件的未提交改动（覆盖全部 10 条）、无测试、无文档、无提交。
  fable-5-1-21 接手后：逐条对照 t-762 原文核对改法 → 补 3 个测试文件的用例 / 断言 → 跑全部验证门 → 出 before / after 量化与截图 → 按模块拆 5 个提交 → 本文档。
- 本单未改任何 `components/ui/**`、`App.tsx`、`styles.css`，未越界到其他模块自有组件。

---

## 1. 范围与文件清单

| 模块 | 改动文件（`packages/web-react/src/components/` 下） | t-762 条目 |
|---|---|---|
| media | `MediaTaskCenter.tsx`、`ImageAnnotationEditor.tsx` | media#1（P2）、media#2 |
| messages | `MessageRenderer.tsx`（+ `MessageRenderer.test.tsx`）、`chat/cards.tsx` | messages#1、messages#2 |
| tools | `tool/researchCards.tsx`（+ `tool/researchCards.test.tsx`） | tools#1 |
| taskboard | `taskboard/TicketTimeline.tsx` | taskboard#2 |
| landing | `Landing.tsx`（+ `Landing.test.tsx`）、`landing/DemoShowcase.tsx`、`AuthGate.tsx` | landing#1、landing#2 |
| composer | `ModelSelector.tsx`、`Composer.tsx` | composer#2、composer#3 |

触控尺寸一律用 `[@media(hover:none)]:…` 只在触屏生效，桌面视觉与尺寸零变化（IconButton / Card 原语既有约定）。

---

## 2. 逐条映射（t-762 编号 → 文件 → 改法 → 验证 → 提交）

| 编号 | 级别 | 状态 | 文件 | 改法 | 验证 | 提交 |
|---|---|---|---|---|---|---|
| media#1 | **P2** | ✅ | `MediaTaskCenter.tsx` | Sheet `className` 去掉 `overflow-y-auto`；内部拆成 `flex min-h-0 flex-1 flex-col` → `shrink-0` header（刷新 / 关闭在此）+ `min-h-0 flex-1 overflow-y-auto` body（同 Modal 结构）。Radix FocusScope 末尾 Tab 回绕用 `focus({preventScroll})` 落回「刷新」时，header 不随内容滚动、始终在视口内 | 复现脚本 `..\.audit-tmp\a11y-mod-b\verify-media.mjs`（改自 t-762 的 `verify-media.mjs`，一路 Tab 到第二次命中「刷新」）：**before**（主克隆）`RESULT: FAIL y=-432 inViewport=false` → **after**（本分支）`RESULT: PASS y=24 h=32 inViewport=true`（日志 `verify-media-{before,after}.log`，截图 `shots\{before,after}--media-task-center--tab-wrap-刷新.png`）。`MediaTaskCenter.test` 既有 25 例全绿；after 截图 `media-task-center--{desktop,mobile}--*` 与 before 逐像素一致（内边距从外层挪到 header / body） | `e0bd0b1aa` |
| media#2 | P3 | ✅ | `MediaTaskCenter.tsx`、`ImageAnnotationEditor.tsx` | `FailureNote`「技术详情」summary `[@media(hover:none)]:py-3.5`；圈选编辑器关闭钮 `[@media(hover:none)]:size-11` | 量化（§3.6）：summary 15.9 → 43.9px，关闭钮 40 → 44px；桌面不变 | `e0bd0b1aa` |
| messages#1 | P3 | ✅ | `MessageRenderer.tsx` | 查找条是自研路径（非 Radix，无 returnFocus）。在 `find` 由空转有值的**那次渲染**里记下 `document.activeElement`（Input 的 `autoFocus` 在提交阶段抢焦点，`useEffect` 里已经晚了）；`find` 置空的 effect 里，若焦点确实掉到 `<body>` 才 `focus({preventScroll:true})` 还回去；用户已把焦点点到别处则不抢。全部在 `MessageList`/find 内解，**未改 App.tsx / ChatHeader 入口** | `MessageRenderer.test` +2：① 入口按钮 → 打开查找条（焦点在 Input）→ 关闭 → 焦点回入口；② 关闭前焦点已在别处 → 不抢回。既有「会话内查找」用例与 `browser-tests/find-in-session.node-test.mjs` 全绿 | `f92a830cb` |
| messages#2 | P3 | ✅ | `chat/cards.tsx` | `ReqIdChip` `[@media(hover:none)]:min-h-11 px-3`；`AssistantCard`「查看请求信息」summary `[@media(hover:none)]:py-3.5` | 量化：胶囊 19.9 → 44px，summary 16 → 44px；桌面不变。`cards.test` 全绿 | `f92a830cb` |
| tools#1 | P3 | ✅ | `tool/researchCards.tsx` | `Chip` 外层 `<a>` 加 `items-center` + `[@media(hover:none)]:min-h-11`（Badge 视觉不变）；`ArtifactPreviewLink` `[@media(hover:none)]:min-h-11 px-3` | ui-preview 无研究卡场景（`tools-bodies` 不含 oc-* 卡），`researchCards.test` 在「oc-browser open」「oc-pdf 产物卡」两例上断言类名契约；52 例全绿 | `e79731e69` |
| taskboard#2 | P3 | ✅ | `taskboard/TicketTimeline.tsx` | 「系统活动（N）」按钮 `[@media(hover:none)]:min-h-11`；「执行时的项目信息快照」summary `[@media(hover:none)]:py-3.5` | 量化：按钮 18 → 44px，summary 15.9 → 43.9px；`taskboard/**` 单测全绿 | `e79731e69` |
| landing#1 | P3 | ✅ | `Landing.tsx` | 菜单 `IconButton` 挂 `menuButtonRef`，Esc 关闭时 `menuButtonRef.current?.focus()`；顺手把折叠态 `aria-controls` 改为 `menuOpen ? 'landing-mobile-nav' : undefined`（不再指向未渲染节点） | `Landing.test` 既有 Esc 用例补断言：焦点在菜单链接上按 Esc → `<nav>` 卸载 → `activeElement` 为「打开导航」按钮；折叠态无 `aria-controls` | `97bb230a7` |
| landing#2 | P3 | ✅ | `Landing.tsx`、`landing/DemoShowcase.tsx`、`AuthGate.tsx` | 页脚链接 / 备案链接 `FOOTER_LINK_CLS`（hover:none 下 `flex min-h-11 items-center`，列 `gap-y` 同时收 0）；FAQ summary `min-h-11`；演示场景 chip 与「免费试一句」`min-h-11`；AuthGate 6 处行内文字按钮抽 `TOUCH_TEXT_BTN`（`inline-flex min-h-11 items-center px-2`）；同意条款 checkbox `size-5` + label 行 `min-h-11 items-center` | 量化：页脚 18.8 → 44、FAQ 28 → 44、chip 34.1 → 44、「免费试一句」32.1 → 44、文字按钮 18–20.1 → 44、checkbox 13 → 20、label 行 20 → 44；桌面全部不变。`Landing.test` / `DemoShowcase.test` / `AuthGate.test` 全绿 | `97bb230a7` |
| composer#2 | P3 | ✅ | `ModelSelector.tsx` | 两处锁定行 `text-faint opacity-80` → `text-muted`（浅色 3.34 / 深色 3.66 → muted 实色 ≥ 7:1），状态由锁图标 + `sr-only`「（需升级解锁）」表达；`CostMark` 不再被 opacity 叠压 | 量化：锁定 menuitem `rgb(111,111,123) opacity 0.8` → `rgb(81,81,92) opacity 1`；after `composer-model-menu--desktop--light` 「Fable 5.1 ×12.0」明显加深、「GLM-5 Air 暂不可用」（真 disabled）仍为 faint。`ModelSelector.test` 全绿 | `4d92ca179` |
| composer#3 | P3 | ✅ | `Composer.tsx` | 会话目标 chip `[@media(hover:none)]:min-h-11 px-3.5` | 量化：28 → 44px；桌面 28px 不变。`Composer*.test` 全绿 | `4d92ca179` |

t-762 composer#3 一并点名的 `components/github/RepoPill.tsx`（28px）归 **sidebar**，不在本单六模块内，转 t-894（a11y-mod-a）——见 §5。

---

## 3. 验证

全部在 `d:\code\test_project\test123\wt\a11y-mod-b` 跑（09-17 01:05–01:30），日志与产物在仓库外 `D:\code\test_project\test123\.audit-tmp\a11y-mod-b\`。

### 3.1 类型检查

`npm run typecheck --workspace packages/web-react` → ✅ exit 0（`typecheck.log`）。

### 3.2 代码风格

`npx biome lint <11 个源码文件>` 与主克隆 `v5-selfhost` 同文件逐条比对（`文件 :: 规则`）：**54 / 54 完全一致，新增诊断 0**
（脚本产物 `%TEMP%\biome-{base,wt}.txt`）。`biome check` 的 format / organizeImports 报错为基线既有（web-react 这批文件本就不过 biome format 的引号 / 分号风格），沿用既有风格。

### 3.3 单测（vitest）

| 命令 | 结果 |
|---|---|
| `npx vitest run src/components/chat/cards.test.tsx src/components/chat/findInSession.test.ts src/components/landing/DemoShowcase.test.tsx src/components/tool/researchCards.test.tsx src/components/AuthGate.test.tsx src/components/Composer.test.tsx src/components/Composer.owner.test.tsx src/components/Composer.owner.review.test.tsx src/components/composerAttach.test.tsx src/components/ImageAnnotationEditor.test.tsx src/components/Landing.test.tsx src/components/MediaTaskCenter.test.tsx src/components/MessageRenderer.test.tsx src/components/ModelSelector.test.tsx src/components/taskboard --maxWorkers=1` | ✅ 23 文件 / 590 例全绿（`vitest-modules.log`；在补用例前跑） |
| `npx vitest run src/components/MessageRenderer.test.tsx src/components/Landing.test.tsx -t "会话内查找\|折叠菜单"` | ✅ 5 例（含新增 2 例 + 补断言 1 例）（`vitest-focus-return.log`） |
| `npx vitest run src/components/tool/researchCards.test.tsx` | ✅ 52 例（含补断言 2 处）（`vitest-researchCards.log`） |

新增 / 修改用例：`MessageRenderer.test` +2（查找条关闭焦点归还 / 不抢回）、`Landing.test` 补 3 条断言（Esc 后焦点回菜单按钮、折叠态无 aria-controls）、`researchCards.test` 补 2 条类名契约断言。无 `.only / .skip`。

### 3.4 真浏览器交互门

`$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser`

- 首跑（未提交前，`test-browser.log`）：`run.mjs` 组件门 **T1–T68 全部 ok**；`node --test` 73 例 70 过 / 3 不过：
  `cc-switch-ascii-name` ×2（**基线**，主克隆同红，INTEGRATION §5 登记）、`ocv5-185-qa` 文件级 1（该用例开头
  `git diff --exit-code HEAD -- packages/web-react/src` 要求工作树干净，未提交时必红，非产品问题）。
- 提交后复跑（`test-browser-2.log`）：结果见 §3.7 末尾。

### 3.5 media#1 复现脚本（Tab 回绕）

`verify-media.mjs media-task-center 刷新 60`，桌面 1440×900：

| 树 | 回绕后「刷新」rect | 判定 |
|---|---|---|
| before（主克隆 `c034f05d7`） | `y=-432 h=32 inViewport=false`，滚动容器是 Sheet content 自身（`fixed z-50 flex flex-col … overflow-y-auto`） | ❌ FAIL |
| after（本分支） | `y=24 h=32 inViewport=true`，滚动容器是 body（`min-h-0 flex-1 overflow-y-auto px-5 pb-5`） | ✅ PASS |

### 3.6 触控尺寸 / 降色量化（`measure-touch.mjs`）

在 ui-preview 场景里以移动触屏上下文（390×844，`isMobile + hasTouch`，实测 `(hover:none)=true`）与桌面上下文各量一遍目标元素高度（`measure-{before,after}.json`）：

| 条目 | 场景 · 元素 | 触屏 before → after | 桌面 before / after |
|---|---|---|---|
| messages#2 | `messages-error-states` · ReqIdChip | 19.9 → **44** | 19.9 / 19.9 |
| messages#2 | `messages-error-states` · 「查看请求信息」summary | 16 → **44** | 16 / 16 |
| taskboard#2 | `taskboard-ticket-drawer` · 「系统活动」按钮 | 18 → **44** | 18 / 18 |
| taskboard#2 | `taskboard-ticket-drawer` · 快照 summary | 15.9 → **43.9** | 15.9 / 15.9 |
| media#2 | `media-task-center` · 「技术详情」summary | 15.9 → **43.9** | 15.9 / 15.9 |
| media#2 | `media-annotation-editor` · 关闭钮 | 40 → **44** | 40 / 40 |
| landing#2 | `landing-home` · 页脚链接 ×5 | 18.8 → **44** | 18.8 / 18.8 |
| landing#2 | `landing-home` · 演示场景 chip ×7 | 34.1 → **44** | 34.1 / 34.1 |
| landing#2 | `landing-home` · 「免费试一句」 | 32.1 → **44** | 32.1 / 32.1 |
| landing#2 | `landing-faq-open` · FAQ summary ×4 | 28 → **44** | 28 / 28 |
| landing#2 | `auth-login` · 忘记密码 / 立即注册 | 18 / 20.1 → **44 / 44** | 18 / 20.1 不变 |
| landing#2 | `auth-register` · 去登录；checkbox；label 行 | 20.1 → **44**；13 → **20**；20 → **44** | 不变 |
| landing#2 | `auth-verify` · 重新发送验证码；`auth-forgot` · 返回登录 | 20.1 → **44**；20.1 → **44** | 不变 |
| composer#3 | `composer-loaded` · 会话目标 chip | 28 → **44** | 28 / 28 |
| composer#2 | `composer-model-menu` · 锁定 menuitem 颜色 | `rgb(111,111,123)` α0.8 → `rgb(81,81,92)` α1（两端一致） | 同左 |
| tools#1 | — | ui-preview 无研究卡场景，见 §2 用类名断言兜底 | — |

### 3.7 视觉对照（d-28）

`OC_UI_SCENES=media-task-center,media-annotation-editor,messages-error-states,messages-find-toolbar,composer-model-menu,composer-loaded,landing-home,landing-faq-open,landing-mobile-nav-open,auth-login,auth-register,auth-verify,auth-forgot,taskboard-ticket-drawer,tools-bodies`
→ before（主克隆）/ after（本分支）各 **84 张 / 24 场景 × 2 主题，`failures: [] retried: [] unmockedApi: []`**（`..\a11y-mod-b\{before,after}\`，`shoot-{before,after}.log`）。

逐张看过的差异（其余与 before 一致）：

- `media-task-center--{desktop,mobile}--*`：布局逐像素一致（内边距从整体容器挪到 header / body，滚动条只出现在 body）。
- `composer-model-menu--desktop--*`：「Fable 5.1 ×12.0」锁定行由淡灰加深到 muted；「GLM-5 Air 暂不可用」（真 disabled）保持 faint。
- `messages-error-states--mobile--*`：请求 ID 胶囊、「查看请求信息」行高变 44px，卡片其余不动。
- `landing-home--mobile--*` / `landing-faq-open--mobile--*` / `auth-*--mobile--*`：页脚每行、FAQ 每条、文字按钮与条款行撑到 44px，桌面四张与 before 一致。

**提交后 `test:browser` 复跑**：见文末「复跑记录」。

---

## 4. 未跑（NOT RUN）与原因

- 真机 iOS Safari / Android Chrome 触控——本机无真机，`(hover:none)` 以 Playwright `hasTouch + isMobile` 仿真为证。
- 读屏（NVDA / VoiceOver）实听「（需升级解锁）」——只经 `sr-only` 文本 + 既有 `ModelSelector.test` 查询未受影响为证。
- 全量 `npm test`（web-react 276 文件）——本单改动面均有模块级用例覆盖，全量门交集成④统一跑。

---

## 5. 跨模块 / 遗留（本单未动）

| 项 | 归属 | 说明 |
|---|---|---|
| `components/github/RepoPill.tsx` 28px（t-762 composer#3 一并点名） | sidebar → t-894（a11y-mod-a） | Composer 工具行复用 sidebar 的 RepoPill，不在本单六模块 |
| Sheet 原语层「回绕滚回可视区」（t-762 shell#8） | shell → t-893 已落（`fa54040d2`） | 与 media#1 互补：原语层兜底 + MediaTaskCenter 自身 header 固定，合入后两层都在 |
| `CostMark` `text-faint`（t-762 composer#2 提及 `:76`） | shell#4 `--faint` 压暗（t-893 `d30ed780e`）后在菜单白底 ≥ 4.5 | 锁定行去掉 opacity 后已不再叠压；不另改色 |
| `.audit-tmp\a11y-mod-b\verify-media.mjs` / `measure-touch.mjs` | 仓库外脚本，不入库 | 复跑方式：`$env:OC_REPO=<树>; $env:OC_TAG=before\|after; node <脚本>` |

---

## 复跑记录（提交后，HEAD `4d92ca179`）

| 项 | 结果 |
|---|---|
| `npm run test:browser`（`test-browser-2.log`） | `run.mjs` 组件门 **T1–T68 全部 ok**（含 T68 messages 触屏折叠、T30 视频任务中心）；`node --test` 16 文件 73 例：**70 过 / 3 不过** —— `cc-switch-ascii-name` ×2（基线）、`ocv5-185-qa` 用例级 1（`EPERM symlink packages/protocol`，Windows 无符号链接权限） |
| `ocv5-185-qa` 单跑（`ocv5-185-rerun.log`） | 按 INTEGRATION §5 口径在 `packages/web-react/node_modules/@openclaude/protocol` 建 junction（环境项，不入库）后 **15 / 15 ✅** |
| `cc-switch-ascii-name` 在**未改动的主克隆**单跑（`cc-switch-baseline-mainclone.log`） | 同样 0 / 2 ❌ —— 与 INTEGRATION §5 / media.md §7 登记一致，为基线失败（settings `ApiKeysSection` 模型 id 断言），与本单无关 |

结论：本单改动面上的全部门（typecheck / biome / 模块 vitest / `run.mjs` / `find-in-session` / `ocv5-185-qa`）全绿；唯一红项为登记在册的基线失败。

---

## 附录：接 QA t-1038 移交（t-895 验收通过后，指挥官 01:35 补录）

QA（fable-5-1-24）复核 landing-B / media-B 遗留时发现两条「遗留成立、阻塞已解除」的项，都落在本单持锁文件里，指挥官要求在同一分支补附录提交。**统计更新：修复 10 + 2 = 12。**

| 编号 | 级别 | 状态 | 文件 | 改法 | 验证 | 提交 |
|---|---|---|---|---|---|---|
| L-11（landing-B 遗留，接 QA t-1038 `QA-b-p3.md` §5 ②） | P3 | ✅ | `AuthGate.tsx`、`AuthGate.test.tsx`、`App.test.tsx`（shell，指挥官授权两行） | 原遗留理由「shell 的 `App.test.tsx` 用 `getByPlaceholderText('邮箱')` 锁着」已不成立（App.test 已改 `getByLabelText`）。登录 / 注册邮箱 `placeholder="邮箱"` → `"name@example.com"`（示例格式，不复读标签）；登录密码 `PasswordInput` 去掉 `placeholder="密码"`（可见标签 + `aria-label` 已给名）；找回密码页「注册邮箱」是提示不是复读，保留；注册页密码「至少 N 位」是规则提示，保留。`AuthGate.test` 的 `getByPlaceholderText("邮箱")` ×6 / `("密码")` ×2 → `getByLabelText`；`App.test.tsx:446/478` 两条「登录表单已消失」否定断言 `queryByPlaceholderText('邮箱')` → `queryByLabelText('邮箱')`（否则占位符一改就成空断言） | `AuthGate.test` +1（占位符为示例格式、密码框无同词占位符、注册页同样）；`AuthGate.test + Landing.test` 53 例 ✅；`App.test` 47 例 ✅；typecheck ✅；after 截图 `..\a11y-mod-b\after-L11\auth-{login,register,forgot}--*`（30 张 / 9 场景，0 失败）：邮箱框显示 `name@example.com`、密码框空占位，其余与 before 一致 | `6236dfb08` |
| M-23（media-B 文档记 ✅ 但未落地，接 QA t-1038 `QA-b-p3.md` §5 ③） | P3 性能 | ✅ | `ImageAnnotationEditor.tsx`、`ImageAnnotationEditor.test.tsx` | media.md §6.1 写的「hasSelection 改为维护 selectionDirty」在 `2d75dbb45` 里没做，`selectionPresent` 仍是 `useMemo(() => hasSelection(mask), [revision])`——每一笔抬手都对整张 mask `getImageData` 全量扫描。改为 `useState`：画笔抬手 → `true`（pointerDown 即落点，不扫）；**矩形 / 套索 / 擦除抬手 → 扫一次**（比 QA 建议的「非擦除一律 true」多守一层：矩形 / 套索可能拖出零面积，直接置 true 会让「发送」在空 mask 上可用）；撤销 / 重做 `restore` 后扫一次；清空 / 换图 / 卸载 → `false`。`revision` 只留 setter（撤销 / 重做按钮读 ref，需重渲染） | `ImageAnnotationEditor.test` +4：画笔落笔 `getImageData` 零调用且标题变「已选中区域」、撤销回空白快照后扫一次回「圈选要修改的区域」；矩形零面积抬手扫一次、不误报；**无选区变化的重渲染（改描述 / 缩放）不重算**（指挥官要求的契约用例）；清空回无选区不扫。既有 16 例不动，20 例 ✅；typecheck ✅ | `986f72b2f`（实现 + 3 例）、`85a7aea54`（+1 例） |

附录两笔的 `biome lint` 与主克隆同文件比对：11 / 11 一致，新增诊断 0（`biome-lint-appendix-{base,wt}.txt`）。
