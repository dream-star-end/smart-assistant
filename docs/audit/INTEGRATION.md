# v5 个人版审计 · integration 分支集成记录

> 分支 `feat/v5-selfhost-ocv5-audit-ux`（基线 `210b9967`）。本文件按集成轮次追加；每轮记录合入的成员分支、冲突取舍、跨模块接线、全量门结果与已知基线失败。
> 命令均在主克隆 `d:\code\test_project\test123\v5-selfhost` 执行；日志与截图在仓库外 `D:\code\test_project\test123\.audit-tmp\integration\`。

## 集成①（t-399 · 2026-09-16 02:10–02:45 · fable-5-1-21）

### 1. 合入顺序与 SHA

起点 `e6f73dd99`（已含 shell-B：`de38a312c…39697560b` + ui-preview 截图台外链 bundle）。

| 序 | 成员分支 @ HEAD | 合并提交 | 文件 / 行 |
|---|---|---|---|
| 1 | sidebar-B `feat/v5-selfhost-audit-sidebar@ef872e91a` | `3cff04c85` | 42 files, +3490/−361 |
| 2 | manage-B `feat/v5-selfhost-audit-manage@af79d7b05` | `09a13a472` | 30 files, +3647/−364 |
| 3 | taskboard-B `feat/v5-selfhost-audit-taskboard@0b06f7ce5` | `bf8188def` | 23 files, +4566/−1549 |
| 4 | messages-B `feat/v5-selfhost-audit-messages@d2f84063d` | `985b3ae57` | 28 files, +2152/−127 |

全部 `git merge --no-ff`，未 rebase / squash 成员分支；`git branch --contains <成员 HEAD>` 均包含 integration。

### 2. 冲突与取舍

**零冲突。** 合并前预检（`git diff --name-only <merge-base>..HEAD` ∩ 成员分支改动集）：sidebar / manage / taskboard 与 integration 无重叠文件；messages 仅与 `browser-tests/ui-preview/shoot.mjs` 重叠（messages 分支的 `901cc3a06` 与 integration 上的 `e6f73dd99` 是同一处「截图台改外链 bundle」改动），三方合并自动收敛。`browser-tests/run.mjs`（sidebar 改 T41 断言、messages 新增 T68）与 `cases.json`（messages 新增 T68）互不相交，自动合并；`test:browser` 复跑时 run.mjs 的「用例清单 = 实际 T 集合」自检通过（T1–T68 全部 ok）。

### 3. 跨模块接线（各模块文档登记 → 本轮落地）

| 来源 | 登记位置 | 落地 | 提交 |
|---|---|---|---|
| sidebar-B S-05 键盘调宽 | sidebar.md §6.2 | `App.tsx` `sidebarProps` 加 `onResizeKeyDown: sidebarWidth.onResizeKeyDown` | `678fe9d38` |
| sidebar-B S-06 抽屉关闭读屏名 | sidebar.md §6.2、shell.md §8.1 | 移动端 `Sheet` 内 `<Sidebar collapseLabel="关闭导航">`；桌面内联侧栏不动 | `678fe9d38` |
| sidebar-B S-08 加载更早会话失败重试 | shell.md §8.1 | `useSessionList` 解构 `loadMoreError` 并传入 `sidebarProps` | `678fe9d38` |
| sidebar-B UUS-01 通知落点 | sidebar.md §6.2 | `useUnreadSessions({ …, onNotificationOpen: selectSession })` | `678fe9d38` |
| sidebar-B ST-01 空标题统一 | sidebar.md §6.2 | `hooks/useChatSocket.ts` `ensureServerSession` 标题回退改 `EMPTY_SESSION_TITLE`（新对话） | `09d15400f` |
| taskboard-B T-20 `BoardViewParam` 的 `inbox/backlog` 类型 | taskboard.md §6 | **不接**：`useAppRoute.ts` 注释声明保留旧调用兼容，类型无功能影响；taskboard 侧死分支已删 | — |
| manage-B X-01 `useProjectScope` 作用域竞态 | manage.md §6 | **已由 sidebar-B 落地**（`ef872e91a` hydrated 守卫），随 sidebar 合入 | — |
| messages-B M-16 `Composer.tsx:487` 品牌名 | messages.md §3 | 归 composer-B（t-35 任务书已带），集成②处理 | — |
| market-A K-24 / X-01 `onRequireLogin` | market.md §6 | market-B 加可选 prop 后，集成②在 `App.tsx` 接一行 | — |

### 4. 随成员契约更新的既有用例（`1ae92b831`）

| 用例 | 变化 | 原因 |
|---|---|---|
| `src/App.test.tsx`「login … enters workspace」 | `getByText('暂无会话')` → `getByTestId('sidebar-empty-all')` 含「还没有会话」 | sidebar-B S-13 把零会话零项目的侧栏改成一块引导空态；`App.test` 属 shell，sidebar-B 不能越界改 |
| `browser-tests/cost-authority.node-test.mjs` | `getByText(/今天已跑/)` → `getByTestId('board-settings-usage')`；「1 次有用量但无金额」与不出现 `$0` 的 provenance 断言原样保留 | taskboard-B 把护栏设置用量行改成 `DescriptionList`（今天已执行 / 正在执行 / 今日花费），文案不再是单行「今天已跑」。基线工作树（wt\composer）该用例 ok，合入后 TimeoutError，改选择器后单跑 ok（4s） |

### 5. 全量门结果

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0（32s） |
| web-react 全量单测 | `cd packages\web-react; npm test`（`vitest run`，585s） | 288 文件：285 通过 / 3 失败 → ① `src/lib/tutorialShowcase.test.ts` 2 例 **基线**（autocrlf 字节数，见 §6）；② `src/App.test.tsx` 1 例 → 本轮 `1ae92b831` 修正后单跑 ✅；③ `src/components/MessageRenderer.test.tsx` `beforeAll` 10s 超时 → 全量并行时的已知偶发（用例自注），与 App.test 一起单跑 ✅ 2 文件 / 197 例。日志 `vitest-all.log` |
| 真浏览器门 | `$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser`（146s） | `run.mjs` 组件门 **T1–T68 全部 ok**（含 sidebar T41 中文单位、messages T68 触屏折叠）。随后 `node --test` 16 文件 73 例：69 通过 / 4 失败 → `cc-switch-ascii-name`（**基线**）、`ocv5-185-qa`（**基线**，文件级 + 用例级各计 1）、`cost-authority`（本轮 `1ae92b831` 修正后单跑 ✅）。日志 `test-browser.log` |
| ui-preview 全量截图 | `OC_UI_SHOTS=…\integration\shots node browser-tests\ui-preview\shoot.mjs`（不设 `OC_UI_SCENES`，228s） | ✅ **118 场景 / 350 张，failures=0，retried=0**；`unmockedApi` = `listCronChannels`、`listProjectAssets`（与 manage-A 基线相同，属可选桩）。日志 `shoot-all.log`，图 `shots\` |

### 6. 已知基线失败（与本轮改动无关，成员交付里已逐条报备）

| 项 | 现象 | 判据 |
|---|---|---|
| `src/lib/tutorialShowcase.test.ts` 2 例 | `public/tutorials/**/showcase/dashboard.html` 期望 46712 字节，磁盘 46755（43 个 CRLF） | 本机 `core.autocrlf=true`；未改动的主克隆同样失败（settings-B / messages-B / manage-B 均复现）；tutorials 归属 |
| `browser-tests/cc-switch-ascii-name.node-test.mjs` | ApiKeysSection 模型 id 断言 `gemini-3.8-flash` vs `sonnet-5` | 未改动的主克隆同样失败（sidebar-B / messages-B 报备） |
| `browser-tests/ocv5-185-qa.node-test.mjs` | `git diff --exit-code` / Windows symlink EPERM | 环境（工作树脏 / 权限），基线同样失败 |
| `MessageRenderer.test.tsx` `beforeAll` 超时 | 全量并行首个 transform 偶发超 10s | 用例自注；单跑绿 |

### 7. 遗留 / 集成②范围

- 待合入：settings-B（`5bce50f48`，已验收）、composer-B（t-35）、media-B（t-51）、market-B（t-47）、tools-B（t-45）、landing / tutorials 两轮、补丁①（t-426）。
- 集成②需接线：market `onRequireLogin`（App.tsx 一行）、composer-B 可能新增的 `AgentPicker onOpenPluginAuth` 等可选 prop。
- 合入 canonical `feat/v5-selfhost` 与 Lease Center 发布需要 v5-dev 通道，本轮不做（决策 d-24）。

## 集成②（t-624 · 2026-09-16 21:15–23:10 · 合并 fable-5-1-40 → 接线 / 门 / 记录 fable-5-1-52）

> 接手说明：fable-5-1-40 完成 7 步合并并写好 `App.tsx` / `brand.ts` 接线（未提交）后掉线；本会话接手时先核对了 7 个合并提交的双亲、
> 工作树无冲突标记、以及「成员侧改动集 ∩ 合并结果 ≠ 成员版本 ⇒ integration 侧必同时改过该文件」（逐文件脚本核对，**无丢改动**），再继续。

### 1. 合入顺序与 SHA

起点 `43b7cd3a4`（集成① 终点）。合入顺序按任务书，media-B / sidebar 二期为指挥官补充。

| 序 | 成员分支 @ HEAD | 合并提交 | 文件 / 行 |
|---|---|---|---|
| 1 | settings-B + 补丁① `feat/v5-selfhost-audit-settings@c0efc9c91` | `5e5ed6925` | 49 files, +3394/−958 |
| 2 | tools-B `feat/v5-selfhost-audit-tools@d65c6741e` | `6fa690d7e` | 29 files, +3906/−521 |
| 3 | market-B `feat/v5-selfhost-audit-market@1fb99bfcc` | `ab765669a` | 14 files, +1109/−51 |
| 4 | landing-B `feat/v5-selfhost-audit-landing@b97adb3fb` | `6201518b2` | 18 files, +1604/−175 |
| 5 | media-B `feat/v5-selfhost-audit-media@8834aca08` | `10398baa9` | 15 files, +2651/−246 |
| 6 | sidebar 二期 `feat/v5-selfhost-audit-sidebar@25c775295` | `b41e804ac` | 5 files, +144/−10 |
| 7 | composer-B `feat/v5-selfhost-audit-composer@70d3db8b3` | `ae0b0cb64` | 23 files, +2528/−334 |

全部 `git merge --no-ff`，未 rebase / squash；`git rev-list --count HEAD..<成员 HEAD>` 对 7 条均为 0。
settings 分支在合入后又推进 3 个提交（`8b2636e94` feat / `c5070e1ee` docs / `5eac1b807` docs = 二期 t-628，已验收），按任务书留给集成③再合一次。
集成② 自有提交 5 个：`19799c0fe` feat 接线、`f7c08f3eb` test 契约用例、`419e0d218` chore `.gitattributes`、`2a6492774` test 复跑修正、docs 本文。

### 2. 冲突与取舍

**零手工冲突。** 唯一三方合并文件是 `browser-tests/run.mjs`（tools / media / composer 三条分支各自追加了真浏览器用例，
与 integration 上 sidebar / messages 的改动互不相交），三次均由 git 自动收敛；`test:browser` 的 run.mjs「用例清单 = 实际 T 集合」自检见 §5。
`App.tsx` 在 7 条分支里都没被成员改动（各模块只加可选 prop、把接线登记给集成），因此没有出现任务书预估的 composer 冲突。

### 3. 跨模块接线（各模块文档登记 → 本轮落地）

| 来源 | 登记位置 | 落地 | 用例 | 提交 |
|---|---|---|---|---|
| market K-24 / X-01 未登录「去登录」 | market.md §9 | `App.tsx` `<MarketplaceCenter onRequireLogin>`：关市场 + `setAuthMode("login")` + `setView("app")`，demo 分支回 `/`（与同文件 `<ManageCenter>` 契约一致） | market-B `MarketplaceCenter.test`（K-24 回调）；App 侧为同款一行，由 `App.test` 47 例回归覆盖 | `19799c0fe` |
| tools T-18 详情面板 ↔ 源卡片选中态 | tools.md §8、`tool/context.ts:95` | `ArtifactInspectContext.Provider` 内再包 `<ArtifactInspectActiveContext.Provider value={inspectTarget?.message ?? null}>` | tools-B `tool/context` / `ToolCard` 用例（选中态描边） | `19799c0fe` |
| composer C-06 未就绪智能体「去授权」 | composer.md §9 | `<AgentPicker onOpenPluginAuth>`：关选择器、`setManageAutoAuthorizePluginSlug(a.needsAuthorization?.[0] ?? null)`、`openManage("connectors")`；demo 下不传。`ManageTab` 无 `"plugins"`，「插件」页 id 即 `connectors`，与市场 `onOpenConnectors` 同一条路 | composer-B `AgentPicker.test`「传入 onOpenPluginAuth 时渲染去授权」 | `19799c0fe` |
| composer §9 RepoPill 未绑定态 `min-w-0 truncate` | composer.md §9 | **已由 sidebar 二期 `297ad8c94` 做**（含 `github/RepoPill.test` 2 例），随分支合入，集成② 未重复 | — | — |
| composer 排队气泡 `status=queued` / C-32 团队卡文案 | composer.md §8 §9 | **登记待办**：queued 是 messages 侧时间线新状态（非接线）；C-32 需同批改 `App.test.tsx` 7 处 + `ocv5-210-*.node-test.mjs` 5 个真浏览器用例，超出「≤30 分钟配用例」口径 | — | — |
| sidebar-B S-05 / S-06 / S-08 / UUS-01 | sidebar.md §6.2、shell.md §8.1 | **集成① `678fe9d38` 已接**；本轮核对 `App.tsx` 现行 `loadMoreError`（解构 + `sidebarProps`）、`onResizeKeyDown`、移动端 `collapseLabel="关闭导航"`、`onNotificationOpen: selectSession` 均在 | 集成① 已覆盖 | — |
| landing L-02 「联系合作」邮箱 | landing.md §7 | `lib/brand.ts` 抽出 `Brand` 类型、加可选 `contactEmail?: string`（不填值，页脚只在填入后渲染） | typecheck；landing-B `Landing.test` | `19799c0fe` |
| landing L-11 登录页占位符被 `App.test` 锁定 | landing.md §7 | `App.test.tsx` 4 处 `getByPlaceholderText('邮箱' / '密码')` → `getByLabelText`（含 1 处 `findBy`）；`AuthGate` 不动（邮箱有包裹式 `<label>`、密码有 `aria-label`） | `App.test` 47/47 | `f7c08f3eb` |
| media X-M1 「更多」菜单用例契约 | media.md §6.3 | `chat/media.test.tsx`「点击缩略图 → 打开全屏查看器」改 `pointerDown` 开 Radix DropdownMenu、`findByRole("menuitem")`、Esc 关菜单后再点「关闭预览」（与 `ImageViewer.test` 同写法） | 该用例本身（合入后全量红 1 例 → 绿） | `f7c08f3eb` |
| media X-M2 / X-M3 / X-M4 | media.md §6.3 | **登记待办**（shell 侧 `styles.css` 字号档、`Sheet` 可选 `closeButton`、`MediaTaskCenter onReusePrompt`），不在集成② 范围 | — | — |
| settings-B SET-12 窄屏分区短名 | `SettingsCenter.tsx` `narrowLabel` | `browser-tests/run.mjs` T42：390 宫格按 `narrowLabel` 取 tab，「账户与计费」→「账户」（1440 竖导航仍全名，无需改）。首轮 `test:browser` T42 在此超时，且因 Dialog 没关、视口停在 390 连带 T45 / T49 失败（复跑见 §5） | T42 本身 | `2a6492774` |
| market 场景 `import './scenes-market.tsx'` | `typecheck:preview` | **不能去后缀**：`shoot.mjs` 的 `ui-preview-scene-groups` 插件用 `onResolve({ filter: /(^|\/)scenes-(manage|market)$/ })` 把**无后缀**的 `./scenes-market` 劫持成分组虚拟模块 `oc-scene-group:market`（只导出 `modules`），带 `.tsx` 后缀才会落到真实文件。本轮先去后缀（`f7c08f3eb`）→ 全量截图构建报 `No matching export … "marketScenes"`，随即还原（`2a6492774`）。TS5097 两处（manage / market 同款）登记为 `typecheck:preview` 基线；要消红应在预览 tsconfig 开 `allowImportingTsExtensions`（仅类型检查、`noEmit`），归 shell | 全量截图构建 | `f7c08f3eb` → `2a6492774` |

### 4. `.gitattributes`（`419e0d218`）

仓根新增（按 `wt/tutorials/docs/audit/tutorials.md` TU-36 建议的四条模式）：

```gitattributes
packages/web-react/public/tutorials/** -text
packages/web-react/tutorial-sync*.json -text
packages/web-react/tutorial-sync-history.jsonl -text
packages/web-react/tutorial-capture-provenance.json -text
```

索引本就是 LF（`git ls-files --eol` → `i/lf`），`git add --renormalize` 对索引零变化；主克隆把 22 个受影响文本夹具删掉后 `git checkout --` 重检 → `w/lf`。
`src/lib/tutorialShowcase.test.ts` 4/4 转绿（集成① 登记的基线失败 ① 撤销）。其它 Windows 工作树只需同样重检一次这几条路径。
TU-37（`scripts/check-v5-tutorials.ts` 标记路径反斜杠进哈希）是脚本修复，归 tutorials-B。

### 5. 全量门结果

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0 |
| 预览台类型检查 | `npm run typecheck:preview --workspace packages/web-react` | 3 红，均登记基线：`scenes-manage-audit.tsx(54,30)` / `scenes-market-audit.tsx(20,30)` TS5097（`.tsx` 后缀是 `shoot.mjs` 分组插件要求的写法，见 §3 末行；集成① 时只有 manage 一处）、`scenes-taskboard.tsx(163,5)` TS2322 `"close"`（taskboard 归属） |
| web-react 全量单测 | `cd packages\web-react; npm test`（`vitest run`，609s） | ✅ **297 文件 / 4161 例全部通过，0 失败**。集成① 的三处基线 / 偶发（tutorialShowcase 字节断言、App.test 契约、MessageRenderer `beforeAll` 超时）本轮均未出现。日志 `integ2-vitest-all.log` |
| 真浏览器门 | `$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser` | 首跑（`integ2-test-browser.log`）`run.mjs` 65/68：T42 在 390 找「账户与计费」tab 超时（settings-B SET-12 短名，§3），Dialog 未关、视口停 390 → T45 / T49 连带失败；`&&` 链未进 `node --test`。改 T42（`2a6492774`）复跑（`integ2-test-browser-2.log`）：`run.mjs` **T1–T68 全部 ok**（自检「清单 68 条全部执行」）；`node --test` 16 文件 73 例：70 通过 / 3 失败 → `cc-switch-ascii-name`（**基线**）、`ocv5-185-qa`（文件级 + 用例级各计 1，`symlink` EPERM）→ 按指挥官口径在 `packages/web-react/node_modules/@openclaude/protocol` 建 junction（环境项，不入库）后单跑 **15/15 ✅**（`integ2-ocv5-185-rerun.log`）。集成① 需单跑的 `cost-authority` 本轮全量即过 |
| ui-preview 全量截图 | `OC_UI_SHOTS=…\integration\shots-integ2 node browser-tests\ui-preview\shoot.mjs`（不设 `OC_UI_SCENES`，488s） | ✅ **227 场景 / 734 张，failures=0，retried=0**（集成① 为 118 / 350；新增 settings / landing / media / composer / tools / market-audit 等场景组）；`unmockedApi` = `listCronChannels`、`listProjectAssets`（与集成① 相同，可选桩）。首次构建因 `f7c08f3eb` 去掉 market 场景 import 后缀而失败（§3 末行），还原后重跑。日志 `integ2-shoot-all.log`，图 `shots-integ2\` |
| 代码风格 | `npx biome lint` 本轮触碰 6 文件 | 与 HEAD 版本逐条对照：既有 20 条（`App.tsx` `useExhaustiveDependencies` ×14、`media.test.tsx` `noDelete` / `noCommaOperator` ×3、`run.mjs` ×3）**新增 0 条**；`App.test.tsx` / `brand.ts` / `scenes-market-audit.tsx` 0 条 |

接线前的定向回归（`integ2-vitest-targeted.log`）：`tutorialShowcase` / `media.test` / `AgentPicker.test` / `MarketplaceCenter.test` / `App.test` 5 文件 89 例，
其中 `App.test`「authenticated send goes through the real WS engine」一次 15s 超时（紧接 typecheck 之后跑、jsdom 冷启动），单跑 47/47 绿（`integ2-vitest-apptest-rerun.log`），全量再跑亦绿 → 记为负载偶发。

### 6. 已知基线失败（本轮更新）

| 项 | 现象 | 状态 |
|---|---|---|
| `src/lib/tutorialShowcase.test.ts` 2 例 | CRLF 字节数 | ✅ **已解除**：`.gitattributes` 后转绿（§4） |
| `browser-tests/cc-switch-ascii-name.node-test.mjs` | 模型 id 断言 `gemini-3.8-flash` vs `sonnet-5` | 基线（见 §5 真浏览器门） |
| `browser-tests/ocv5-185-qa.node-test.mjs` | Windows 无符号链接权限 `symlink` EPERM（用例自身容忍 EEXIST） | 环境项：在 `packages/web-react/node_modules/@openclaude/protocol` 预建 junction → `packages/protocol` 后 15/15 绿；无 junction 的机器仍 EPERM |
| `MessageRenderer.test.tsx` `beforeAll` 超时 | 全量并行偶发 | 本轮未复现 |
| `App.test.tsx`「authenticated send…」15s 超时 | 定向跑紧随 typecheck 时偶发 1 次 | 负载偶发，单跑 / 全量均绿 |
| `typecheck:preview` 3 红 | §5 | 基线：TS5097 ×2 由 `shoot.mjs` 分组插件的 import 写法决定（消红方案见 §3 末行，归 shell）；TS2322 ×1 归 taskboard owner |

### 7. 遗留 / 集成③ 范围

- 待合入：settings 二期 `5eac1b807`（3 提交）、tutorials-B、以及其余二期分支（messages2 / taskboard2 待验收，manage2 待领）。
- 待接线 / 待办（原登记：composer 排队气泡 `status=queued`、C-32 团队卡文案、media X-M2 / X-M3 / X-M4、`typecheck:preview` 消红、TU-37）→ **已由 t-865 逐条处置，见 §7.1**。
- 合入 canonical `feat/v5-selfhost` 与 Lease Center 发布需要 v5-dev 通道，本轮不做（决策 d-24）。
- 各成员分支的合入状态单见 §8。

#### 7.1 集成待办清理（t-865 · fable-5-1-52 · 2026-09-16 23:10–23:35，从 `2b23a31a7` 线性提交）

| 待办 | 处置 | 提交 / 证据 |
|---|---|---|
| `typecheck:preview` TS5097 ×2（`scenes-manage-audit.tsx` / `scenes-market-audit.tsx` import 带 `.tsx`） | ✅ **已修**：`tsconfig.browser-tests.json` 开 `allowImportingTsExtensions`（已是 `noEmit`，仅类型检查）；`.tsx` 后缀是 `shoot.mjs` 分组插件契约，场景文件不动 | `e0f53688a`；`typecheck:preview` 只剩 TS2322 ×1；`OC_UI_SCENES=media-container-preview` 截图构建 8 张全成 |
| `typecheck:preview` TS2322 `scenes-taskboard.tsx(163,5)` `"close"` | ⏳ **等集成③**：taskboard2 分支 `05dd185df` 上 `onSuccess` 已全部为 `advance` / `wait_human`（`git show` 核对），合入后自消，未重做 | — |
| composer 排队气泡 `status=queued`（messages） | ✅ **核对已具备，无需接线**：`chat/cards.tsx` `UserCard` 的 `USER_STATUS_LABEL.queued = "排队中"`，`lib/chat/socket.ts` busy 排队路径把 `userMsg.status` 置 `queued`（`:5148`），Composer C-02「排队发送」→ 时间线用户气泡直接显示「排队中」；`cards.test`「排队中」用例既有 | `cards.test` 绿（本轮 batch 150 例） |
| composer C-32 团队卡文案（shell + QA） | ✅ **已修**：`AgentPicker` 副标题「队长切 Astra …」→「队长切换为 {`DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME`} 并委派已安装智能体」（与下方说明 / ModelSelector 同源常量）；同批 `App.test.tsx` 7 处 + `ocv5-210-{advisor-ui,advisor-app,advisor-dual-app,advisor-cold-retry,cas-identity}` 9 处匹配器 `/队长切 Astra/` → `/队长切换为/`（只改选择器文本） | `d4b061e37`；`App.test` 47/47；`test:browser` `run.mjs` 68/68 + `node --test` 87 例仅 `cc-switch` 基线红（4 个 advisor 用例全过）；`cas-identity` 单跑 1/1；`composer-agent-picker` 4 张截图核对 390px 一行放下 |
| media X-M2 `styles.css` preview 字号 | ✅ **已修**：状态胶囊 10px → `var(--text-caption)`；工具坞标签 / 提示条 / 次级按钮 / 错误详情 / 状态说明手抄 11px → caption token；`.preview-error-details summary` 11px/32px → `var(--text-meta)`/44px | `a3af53970`；`designTokens.test` / `ContainerWebPreview.test` 绿；`media-container-preview-*` 8 张（`t865-shots\`） |
| media X-M3 `Sheet` 可选关闭钮 | ✅ **原语已加**（opt-in，存量零变化）：`closeButton?: boolean` + `closeLabel?: string`，右上 `IconButton` 走 Radix Close。各抽屉是否开启留 owner：`InboxDialog`（sidebar）、`ConnectorsTab` 抽屉（settings）、taskboard `PanelSheet` / `TicketDrawer` / `TaskboardView`（taskboard，t-630 在跑不动）；`MediaTaskCenter` 已自带可后续切换 | `bae5a8673`；新增 `ui/Sheet.test.tsx` 3 例 |
| media X-M4 `MediaTaskCenter onReusePrompt` | ✅ **已修**：组件加可选 `onReusePrompt`，接线后失败任务「复制提示词」升级为「重新发起」；`App.tsx` 关任务中心 + `setComposerPrefill`（与教程 starterPrompt 同路） | `7d5573a92`；`MediaTaskCenter.test` +1（14/14）；`App.test` 47/47 |
| tutorials TU-37 门禁脚本路径归一化 | ↗ **已转 t-53**（tutorials-B 在跑；持有人不可见，经指挥官 fable-5-1-53 `send_to` 转交，修法与验证口径已附），本任务不碰教程中心目录 | — |

验证（主克隆，日志 `t865-*.log`）：`typecheck` ✅；`typecheck:preview` 1 红 = TS2322 等集成③；受影响 vitest `Sheet` / `ContainerWebPreview` / `designTokens` / `cards` 150 例 + `MediaTaskCenter` / `AgentPicker` / `App.test` 73 例 ✅；`biome lint` 触碰 8 文件新增 0 条（`App.tsx` 14 条 `useExhaustiveDependencies` 为基线）；`test:browser` 见上表 C-32 行；截图 `media-container-preview` 8 张 + `composer-agent-picker` 4 张。未跑：全量 `npm test`（本轮改动面已被定向用例覆盖，全量留给集成③ 合入后一并跑）。

### 8. 分支合入状态单（指挥官要求 · 集成③ 照单接棒）

按 `git merge-base <分支> HEAD` 与 `git rev-list --count HEAD..<分支>` 现算于 integration `1d8eaf769`（2026-09-16 23:15）；12 条分支远端 = 本地。

| 模块分支 `feat/v5-selfhost-audit-*` | 已合入到（合并提交） | 分支现 HEAD | 未合入提交 | 对应任务 / 状态 |
|---|---|---|---|---|
| shell | `39697560b`（集成① 起点 `e6f73dd99` 已含） | `39697560b` | 0 | shell-B 已合 |
| sidebar | `25c775295`（集成② `b41e804ac`；sidebar-B `ef872e91a` 由集成① `3cff04c85`） | `25c775295` | 0 | sidebar-B t-37 / 二期 t-627 已合 |
| tools | `d65c6741e`（集成② `6fa690d7e`） | `d65c6741e` | 0 | tools-B t-45 已合 |
| landing | `b97adb3fb`（集成② `6201518b2`） | `b97adb3fb` | 0 | landing-B t-49 已合 |
| media | `8834aca08`（集成② `10398baa9`） | `8834aca08` | 0 | media-B t-51 已合 |
| composer | `70d3db8b3`（集成② `ae0b0cb64`） | `70d3db8b3` | 0 | composer-B t-35 已合 |
| settings | `c0efc9c91`（集成② `5e5ed6925`） | `5eac1b807` | **3** | 二期 t-628 **已验收** → 集成③ 待合 |
| messages | `d2f84063d`（集成① `985b3ae57`） | `2abe389a9` | **1** | messages2 t-629 待验收 → 集成③ 待合 |
| taskboard | `0b06f7ce5`（集成① `bf8188def`） | `05dd185df` | **2** | taskboard2 t-630 待验收 → 集成③ 待合 |
| manage | `af79d7b05`（集成① `09a13a472`） | `6fae01440` | **3** | manage2 t-626 分支已有新提交（进行中）→ 集成③ 以验收结果为准 |
| market | `1fb99bfcc`（集成② `ab765669a`） | `5391c150a` | **5** | market2 t-625 分支已有新提交（进行中，曾阻塞）→ 集成③ 以验收结果为准 |
| tutorials | 基线 `210b99678`（**从未合入**） | `d6eb6ef35` | **5** | tutorials-A t-52 已验收 3 提交（`be7ddf00b` 改 `browser-tests/ui-preview` 内联 bundle 转义，harness 共享文件；`5023c70fd` 27 个场景；`5bf80f0bc` 报告）+ tutorials-B t-53 进行中 → 集成③ 待合 |

集成③ 顺序建议：settings（已验收）→ messages2 / taskboard2 / manage2 / market2 按验收先后 → tutorials（A+B 一起；`be7ddf00b` 与 integration 上的截图台外链 bundle 改动同文件，留意三方合并）。每合一条跑 typecheck；合完复跑 §5 四道门，`.gitattributes` 已在，教程夹具不再需要手工重检。
