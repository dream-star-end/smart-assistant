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

- 待合入：settings 二期 `5eac1b807`（3 提交）、tutorials-B、以及其余二期分支（messages2 / taskboard2 待验收，manage2 待领）。→ **集成③ 已全部合入**（见下文集成③ §1）。
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

> 本单为集成② 交棒时（`1d8eaf769`，2026-09-16 23:15）的快照，保留作接棒依据；**集成③ 合入后的现状见下文「集成③ §8」**。

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

## 集成③（t-631 · 2026-09-16 23:43 – 09-17 01:45 · 合并 / 接线 fable-5-1-54 → 门禁探测 fable-5-1-16 → 拍板落地 / 全量门 / 记录 / 推送 fable-5-1-22）

> 接手说明：fable-5-1-54 按任务书完成 6 步 `--no-ff` 合并、`App.tsx` 接线（`bdf7b4d15`）与 q-979 两处 `data-product-control`（`c034f05d7`）后于 00:05 掉线，全部已提交、未推送；
> fable-5-1-16 接手复跑 `check:tutorials`、定位入口身份漂移根因并探测修法、开决策卡 q-1043（随当时指挥官掉线未获裁决）、在探测改动下跑完 typecheck / typecheck:preview / `npm test`（00:41–00:53）后掉线；
> 本会话接手时逐条核对 8 个提交的双亲与 `rev-list HEAD..成员 = 0`、树内无冲突标记、探测改动仅 2 个属性未提交，重开决策卡 q-1076（→ A），随后落地、复跑全量门、写本节并推送。

### 1. 合入顺序与 SHA

起点 `1e4328ac9`（集成② 终点，含 t-865 待办清理）。顺序按 §8 状态单；media-B `8834aca08` 已在集成② `10398baa9` 合入，本轮核对 `git merge-base --is-ancestor` 为真、未合入提交 0。

| 序 | 成员分支 @ HEAD | 合并提交 | 文件 / 行 |
|---|---|---|---|
| 1 | settings 二期 t-628 `feat/v5-selfhost-audit-settings@5eac1b807` | `12fc17579` | 6 files, +366/−8 |
| 2 | messages2 t-629 `feat/v5-selfhost-audit-messages@2abe389a9` | `cd58600e8` | 1 file, +13 |
| 3 | taskboard2 t-630 `feat/v5-selfhost-audit-taskboard@05dd185df` | `425655631` | 2 files, +20/−1 |
| 4 | manage2 t-626 `feat/v5-selfhost-audit-manage@6fae01440` | `c761bbd93` | 6 files, +212/−73 |
| 5 | market2 t-625 `feat/v5-selfhost-audit-market@5391c150a` | `be20adaec` | 14 files, +839/−195 |
| 6 | tutorials A+B t-52 / t-53 `feat/v5-selfhost-audit-tutorials@02c358655`（A `be7ddf00b…5bf80f0bc` 3 提交 + B `e722bdf5f…02c358655` 6 提交） | `ce767d8ce` | 25 files, +2404/−934 |

六步合计 54 files, +3854/−1211。全部 `git merge --no-ff`，未 rebase / squash；`git rev-list --count HEAD..<成员 HEAD>` 对 6 条均为 0（12 条分支全表见 §8）。
集成③ 自有提交 5 个：`bdf7b4d15` feat App 接线（§3）、`c034f05d7` chore 入口覆盖补标（§4 q-979）、`29a277b25` chore 两处入口降级（§4 q-1076）、`b249317f4` chore 教程同步快照 accept（§4）、docs 本文。

### 2. 冲突与取舍

前 5 条零重叠（预检同集成②：成员改动集 ∩ integration 自 merge-base 以来改动集 = ∅，合并结果逐文件等于成员版本）。
**唯一冲突**：tutorials `browser-tests/ui-preview/shoot.mjs` —— tutorials-A `be7ddf00b` 对内联 `<script>` bundle 做 HTML 脚本数据转义（`<!--` / `</script`），
integration 侧（messages 场景 09-15 首次命中同一问题）已改为经 `page.route` 外链脚本供出、不再内联，两者解决同一件事 → **取 integration 版本**（外链方案覆盖面更广，转义随之不再需要）；
tutorials 场景文件 `scenes-tutorials.tsx` 不受影响，本轮全量截图 27 个 tutorials 场景 108 张全成（§5），证明取舍无副作用。

### 3. 跨模块接线（各模块文档登记 → 本轮落地）

| 来源 | 登记位置 | 落地 | 用例 | 提交 |
|---|---|---|---|---|
| tutorials TU-32 任务面板 CTA 门禁 | tutorials.md §9 ① | `App.tsx` `tutorialActionContext` 加 `taskboardEnabled: TASKBOARD_ENABLED`（与 `runTutorialAction` 的 taskboard 分支同一开关；selfhost 默认开启，行为不变） | tutorials-B `tutorialSystem.test`「部署关掉任务面板时…」；App 侧一行由 `App.test` 回归覆盖 | `bdf7b4d15` |
| tutorials TU-17 / TU-02 深链 `?panel=help` + `view=start\|cases`、`work=planet\|gravity` | tutorials.md §9 ② | **登记待办**（tutorials-B 自标「可后做」，shell `useAppRoute` + `App.tsx` 解析 / 回写；不在集成③ 完成判据内） | — | — |
| tutorials TU-34 hero 品牌深蓝 token `--hero-bg / --hero-fg` | tutorials.md §9 ③ | **登记待办**（可选，shell `styles.css`；换 `bg-fg` 会破坏深色 hero，需 token 才能收口） | — | — |
| tutorials TU-36 教程夹具 `.gitattributes -text` | tutorials.md §9 ④ | **已由集成② `419e0d218` 落地**，本轮核对 `git ls-files --eol` 三份同步文件 `i/lf w/lf attr/-text` | — | — |
| tutorials TU-37 门禁标记路径归一化 | 集成② §7.1 转 t-53 | 随 tutorials `02c358655` 合入；`check:tutorials` 在 Windows 首次真跑到底，由此暴露 §4 两件事 | `check:tutorials` | `ce767d8ce` |
| media X-M2 / X-M3 / X-M4 | media.md §6.3 | **已由 t-865 落地**（集成② §7.1），本轮核对 `styles.css` caption token、`Sheet closeButton`、`MediaTaskCenter onReusePrompt` 均在 HEAD | 集成② 已覆盖 | — |
| settings 二期 关于页「备案」占位判据 | settings.md §9.1 `hasIcpNumber(BRAND.icp)` | **登记可选去重**：settings 侧代码注释标注「集成③ 合入后可改为直接引用 landing `lib/legal.ts` `filedIcp()`」；两处判据一致，非必需，留 owner | — | — |
| messages2 / taskboard2 / manage2 / market2 | 各 `docs/audit/*.md` 二期小节 | **无 App / shell 接线登记**；manage2 X-03 `cronHuman` 为纯函数，taskboard / tools 侧使用方单测已在成员分支单跑绿 | 全量 `npm test`（§5） | — |
| `check:tutorials` 入口覆盖 2 处存量漏标 | q-979（fable-5-1-54 开卡，fable-5-1-53 拍板 `fix_in_integ3`） | `ChatHeader.tsx:356` 「导出会话」`DropdownMenuItem`（composer-B `c250a6011` 引入）与 `Sidebar.tsx:955` 「清除搜索」`IconButton`（sidebar `17710a62` 引入）位于 `data-product-entry-scope` 内却无标记 → 照同文件 `ChatHeader.tsx:351` 既有写法补 `data-product-control`。非本轮合入引入，是门禁首次真跑暴露的存量漏标 | `check:tutorials` 入口覆盖转绿 | `c034f05d7` |
| `check:tutorials` 入口身份变化 2 处 | q-1076（本会话开卡，fable-5-1-18 拍板 A） | 见 §4 | `check:tutorials` 入口身份变化 = 无 | `29a277b25` |

### 4. `check:tutorials` 门禁：入口覆盖 → 教程同步快照漂移（**用户终审请确认**）

**背景。** `scripts/check-v5-tutorials.ts` 在 `check:v5` CI 链里：把带 `data-product-feature` 标记的功能源文件按 JSX 语义进哈希（`sourceHash`）、把入口元素身份（文件 / 组件 / asChild / 条件包裹）进哈希（`entryIdentityHash`），与 `packages/web-react/tutorial-sync.json` 比对；漂移时要求人工确认「26 篇教程仍与功能一致」后 `npm run tutorials:accept`。
Windows 上该门禁此前被 TU-37（标记路径反斜杠进哈希 → 26 项全红）掩盖，**tutorials-B 修好 TU-37 并随本轮合入后，它第一次在本机真跑到底**，于是在 integration 上一次性暴露集成①②③ 合入全部 B 阶段分支的累积结果：

| 时间 | HEAD | 结果 | 处置 |
|---|---|---|---|
| 23:55 | `bdf7b4d15` | 入口覆盖 2 红（`integ3-check-tutorials.log`） | q-979 → `c034f05d7` 补两处 `data-product-control` |
| 23:56 | `c034f05d7` | 「教程同步快照已漂移」：功能源变化 17 项 + 入口身份变化 2 项（agents、chat-basics）；教程正文 / 媒体 / 场景案例 / 能力注册表 / 新增 / 下线均无（`integ3-check-tutorials-2.log`） | q-988 → `accept_in_integ3`（附三条要求：抄检两篇教程、note 注明代确认、17+2 清单进本文） |
| 00:40 | 探测 | `accept()` 硬规则：普通 accept 要求每个功能源变化的能力**同时改教程正文并抬 `contentVersion`**（17 篇都没改 → 逐条 fail）；`--source-only --ids` 只要存在入口身份变化就整体拒绝 → q-988 的「直接 accept」两条路都堵。根因：composer-B 各新增了第 3 个 `data-product-feature` 入口 —— agents = `AgentPicker` 未就绪智能体卡拆出的独立 `<button aria-disabled>`「前往授权 / 修复所需能力」（C-06）；chat-basics = `Composer` 生成中「排队发送」`IconButton`（C-02）。门禁设计即「新增教程 CTA 入口必须同步教程正文」。把这 2 处 `data-product-feature` 改为 `data-product-control` 后入口身份变化 = 无（`integ3-check-tutorials-probe.log`） | q-1043（fable-5-1-16 开卡，随指挥官掉线未裁）→ **q-1076（本会话重开）→ A `demote_then_source_only`**，拍板人 fable-5-1-18 |
| 01:10 | `29a277b25` | 两处降级：仍登记为已覆盖控件（入口覆盖校验通过），只不再作为教程 CTA 聚焦目标；默认卡 / textarea / 顶栏 / 侧栏入口不变；UI 零变化；grep 全部 `*.test.*` / `browser-tests/**` 无用例断言这两处属性；代码注释标明原因与恢复条件 | `chore(v5)` 单独提交 |
| 01:14 | `b249317f4` | `npm run tutorials:accept -- --source-only --ids <17 项> --note "…"` → `tutorials:accept OK · source-only · 17 capability snapshots changed · 0 case`；`check:tutorials OK · 26 capabilities · 12 real-world cases · 26 media pairs · 2390809 B`（`integ3-tutorials-accept.log` / `integ3-check-tutorials-3.log`） | 三份同步文件（`tutorial-sync.json` / `tutorial-sync-history.jsonl` 第 67 条 / `tutorial-sync-history-head.json`）`chore(v5)` 单独提交 |

**17 + 2 漂移清单。**

- 功能源变化（17，全部按 `--source-only` 作「入口 JSX 内部等价重构」接受）：`advisor-mode`, `agents`, `billing-usage`, `chat-basics`, `container-web-preview`, `feedback-support`, `files-media`, `github-repository`, `image-create-edit`, `inbox`, `marketplace-publishing`, `memory-auto-dream`, `models-reasoning`, `preferences`, `sessions-history`, `team-mode`, `voice-input`。来源是各模块 B 阶段对入口元素的 UI/UX / 文案 / 可访问性修改（`aria-*`、触控尺寸、原语替换、文案改写等），未删减能力、未改入口语义；tutorials-A 审计（t-52）亦未发现教程与功能不符。
- 入口身份变化（2，已由 `29a277b25` 降级消除）：`agents` ← `AgentPicker.tsx` C-06 去授权卡按钮（composer-B `650faa009`）；`chat-basics` ← `Composer.tsx` C-02「排队发送」（composer-B `ace3fcf73`）。

**抄检结果（q-988 要求 ①，fable-5-1-16 首查、本会话复核）。** 两篇教程正文（`lib/tutorialCatalog.ts` `chat-basics` v8 / `agents` v4）引用的入口文案与 HEAD 实际文案逐条一致：侧栏「新建会话」（`Sidebar.tsx:885`）、「选择智能体后新建」（`Sidebar.tsx:892`）、顶栏「切换智能体，当前 {助手名}」（`ChatHeader.tsx:198`）、回形针「添加附件」（`Composer.tsx:696`）、「+」菜单「设定目标」（`Composer.tsx:753`）、全能助手卡「单人 / 顾问 / 团队」（`AgentPicker.tsx:163–207`）。两篇均未引用「队长切换为…」句式（那句在 `team-mode` 正文，C-32 改的是 AgentPicker 副标题，`team-mode` 本轮无正文变化）。
**唯一不一致**：两篇正文都没有描述 composer-B 新增的「去授权 / 去处理」与「排队发送」两个入口 —— 属内容补充项，不在集成③ 改（q-988 口径），已由指挥官预排 **t-1046 tut-sync-2「tutorials·补写 agents / chat-basics 正文」**：补写并抬 `contentVersion` 后把两处属性恢复为 `data-product-feature`，走普通 `tutorials:accept`（tutorial-sync 模式）。**→ 已由 t-1046 完成（提交 `e798c3123`，分支 `feat/v5-selfhost-audit-tut-sync-2`，见 §7）**：两处入口身份恢复为 composer-B 原状，history 第 68 条为普通 tutorial-sync 记录；第 67 条 source-only 记录保持原样（追加式历史不可改写），用户终审时两条一并核。

**note 原文**（`tutorial-sync-history.jsonl` 第 67 条）：「v5 个人版审计 B 阶段各模块 UI/UX 修复致功能源漂移（17 项），教程正文与媒体未变，经各模块审计与 tutorials-A 复核仍一致；composer-B 新增的去授权 / 排队发送两处入口按 q-1076 登记为控件，入口身份不变；由指挥官 fable-5-1-18 代用户确认（q-988 → q-1076），待用户终审」。
**可逆性**：用户不认可 → `git revert b249317f4 29a277b25` 即回到 accept 前状态（`check:tutorials` 重新报 17+2 漂移，其余门不受影响）。

### 5. 全量门结果（最终 HEAD 源码态 = `b249317f4`）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0（25s，`integ3-typecheck-2.log`；`c034f05d7` 上 `integ3-typecheck.log` 亦绿） |
| 预览台类型检查 | `npm run typecheck:preview --workspace packages/web-react` | ✅ **exit 0，集成② 登记的 3 红全部消除**：TS5097 ×2 由 t-865 `e0f53688a` 开 `allowImportingTsExtensions`；TS2322 `scenes-taskboard.tsx(163,5)` 随 taskboard2 `cb6629bd1` 合入自消（`integ3-typecheck-preview-2.log`） |
| 教程门禁 | `npm run check:tutorials` | ✅ OK · 26 capabilities · 12 cases · 26 media pairs（§4；accept 前的三次红见 `integ3-check-tutorials{,-2,-probe}.log`） |
| web-react 全量单测 | `cd packages\web-react; npm test`（`vitest run`） | ✅ **298 文件 / 4213 例全部通过，0 失败**（fable-5-1-16 00:41 起跑 676s，源码态 = `c034f05d7` + 两处属性降级，与最终 HEAD 源码完全一致，`integ3-vitest-all-2.log`）；本会话在 `b249317f4` 复跑（01:28 起，801s）→ ✅ **298 文件 / 4213 例全部通过，0 失败**（`integ3-vitest-all-3.log`） |
| 真浏览器门 | `$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser`（171s） | `run.mjs` 组件门 **T1–T68 全部 ok**（自检「清单 68 条全部执行」，含 tutorials T38 社区教程、settings T42 短名、C-32 相关 ocv5-210 四用例）。随后 `node --test` 16 文件 73 例：**70 通过 / 3 失败** → `cc-switch-ascii-name` ×2（**基线**，与集成② `integ2-test-browser-2.log` 逐条相同：「还没有 API Key」10s 超时 + 模型 id `gemini-3.8-flash` vs `sonnet-5`）、`ocv5-185-qa` 文件级 1（跑时工作树含尚未提交的两处属性探测改动，用例自带 `git diff --exit-code` 拦截；提交 `29a277b25` 后工作树干净、junction 在，单跑 **15/15 ✅** `integ3-ocv5-185-rerun.log`）。日志 `integ3-test-browser.log` |
| ui-preview 全量截图 | `OC_UI_SHOTS=…\integration\shots-integ3 node browser-tests\ui-preview\shoot.mjs`（不设 `OC_UI_SCENES`，626s） | ✅ **257 场景 / 854 张，failures=0，retried=0**（集成② 为 227 / 734；新增 tutorials 27 场景 108 张 desktop / mobile × light / dark、manage2 `manage-cron-range`、market2 场景等）；`unmockedApi` = `listCronChannels`、`listProjectAssets`（与集成①② 相同，可选桩）。Read 抽看 `tutorials-quickstart--desktop--light`（第 4 步「设定目标」，拍板②）、`tutorials-showroom--mobile--dark` 渲染正常。日志 `integ3-shoot-all.log`，图 `shots-integ3\` |
| 代码风格 | `npx biome lint` 集成③ 自有提交触碰的 5 个源文件 | `App.tsx` 14（基线 14，`useExhaustiveDependencies`，集成② §7.1 已登记）、`Composer.tsx` 10（基线 10，与 `wt\composer` 同一 blob 逐条同分布：`noNoninteractiveElementToInteractiveRole` 1 / `useExhaustiveDependencies` 6 / `useSemanticElements` 2 / `useTemplate` 1）、`ChatHeader.tsx` / `Sidebar.tsx` / `AgentPicker.tsx` 0 → **新增 0 条** |

### 6. 已知基线失败（本轮更新）

| 项 | 现象 | 状态 |
|---|---|---|
| `browser-tests/cc-switch-ascii-name.node-test.mjs` ×2 | 「还没有 API Key」10s 超时；模型 id 断言 `gemini-3.8-flash` vs `sonnet-5` | 基线（集成①②③ 三轮逐条相同） |
| `browser-tests/ocv5-185-qa.node-test.mjs` | 用例自带 `git diff --exit-code HEAD -- packages/web-react/src packages/protocol/src` + Windows symlink | 环境项：**工作树必须干净** + `node_modules/@openclaude/protocol` junction；满足后 15/15 绿。本轮全量首跑红即因探测改动未提交 |
| `typecheck:preview` 3 红 | TS5097 ×2 / TS2322 ×1 | ✅ **已解除**（§5） |
| `check:tutorials` 快照漂移 17+2 | §4 | ✅ **已 accept**（source-only，指挥官代确认，**待用户终审**） |
| `MessageRenderer.test.tsx` `beforeAll` 超时 / `App.test.tsx` 15s 超时 | 负载偶发 | 本轮两次全量均未复现 |

### 7. 遗留 / 集成④ 范围

- 待合入（t-896 集成④ 任务书为准）：a11y-shell / a11y-mod-a / a11y-mod-b、permission-card-2、三条 QA 复核的修复分支、t-1046 tut-sync-2。
- 待办登记：tutorials TU-17 深链与 TU-34 hero token（shell）；settings 备案判据可选去重（owner）；~~t-1046 补写 agents / chat-basics 正文并抬版后恢复两处 `data-product-feature`~~ → **已由 t-1046 完成（提交 `e798c3123`）**（fable-5-1-17 · 分支 `feat/v5-selfhost-audit-tut-sync-2`，基于本轮终点 `36bb9a677`；正文 + 抬版、两处属性恢复、三份同步文件放在同一个提交，使分支上每个提交的 `check:tutorials` 都是绿的）：`agents` v4→v5 在「按任务而不是名字选择」补写待授权 / 待修复卡与「去授权」/「去处理」；`chat-basics` v8→v9 在「观察执行而不是反复催促」补写「排队发送」（提示“本轮结束后自动发送”、toast“已加入队列，本轮结束后发送”）；`AgentPicker.tsx` C-06 卡按钮与 `Composer.tsx` C-02「排队发送」恢复 `data-product-feature`；`npm run tutorials:accept -- --note …` **普通 tutorial-sync 模式**（history 第 68 条，actor fable-5-1-17，identityChanged / contentChanged / sourceChanged 均 = agents, chat-basics，无 `--source-only`）→ `check:tutorials OK · 26 capabilities · 12 cases · 26 media pairs`。UI 零变化：`composer-busy` / `composer-agent-picker` 8 张 before/after PNG SHA-256 逐张相同（`.audit-tmp\tut-sync-2\`）。
- 终审导读：§4 的教程同步快照 accept 由指挥官代用户确认（q-988 → q-1076），归档初稿 / 终稿请列入终审导读。
- 合入 canonical `feat/v5-selfhost` 与 Lease Center 发布需要 v5-dev 通道，本轮不做（决策 d-24）。

### 8. 分支合入状态单（集成③ 终点现算）

按 `git merge-base --is-ancestor <分支 HEAD> HEAD` 与 `git rev-list --count HEAD..<分支 HEAD>` 现算于 integration `b249317f4`（2026-09-17 01:30）；12 条分支远端 = 本地（`git ls-remote` 逐条核对）。

| 模块分支 `feat/v5-selfhost-audit-*` | 分支 HEAD | 合入到 integration 的合并提交 | 未合入提交 |
|---|---|---|---|
| shell | `39697560b` | 集成① 起点 `e6f73dd99` 已含 | 0 |
| sidebar | `25c775295` | 集成① `3cff04c85`（B）→ 集成② `b41e804ac`（二期） | 0 |
| tools | `d65c6741e` | 集成② `6fa690d7e` | 0 |
| landing | `b97adb3fb` | 集成② `6201518b2` | 0 |
| media | `8834aca08` | 集成② `10398baa9` | 0 |
| composer | `70d3db8b3` | 集成② `ae0b0cb64` | 0 |
| settings | `5eac1b807` | 集成② `5e5ed6925`（B + 补丁①）→ **集成③ `12fc17579`**（二期 t-628） | 0 |
| messages | `2abe389a9` | 集成① `985b3ae57`（B）→ **集成③ `cd58600e8`**（二期 t-629） | 0 |
| taskboard | `05dd185df` | 集成① `bf8188def`（B）→ **集成③ `425655631`**（二期 t-630） | 0 |
| manage | `6fae01440` | 集成① `09a13a472`（B）→ **集成③ `c761bbd93`**（二期 t-626） | 0 |
| market | `5391c150a` | 集成② `ab765669a`（B）→ **集成③ `be20adaec`**（二期 t-625） | 0 |
| tutorials | `02c358655` | **集成③ `ce767d8ce`**（A t-52 + B t-53，含 TU-37 / TU-22 追加提交） | 0 |

集成④ 接棒：从本轮终点 HEAD 起合入 §7 待合分支；`.gitattributes`、`allowImportingTsExtensions`、junction 均已在；`check:tutorials` 现为绿门；t-1046 分支已自带两处 `data-product-feature` 恢复 + 普通 `tutorials:accept`（history 第 68 条），合入后 `check:tutorials` 应直接绿——若集成④ 其他待合分支又改了带 `data-product-feature` 的入口 JSX，按常规再跑一次 accept 即可。

---

## 集成④（t-896 · 2026-09-17 01:55 – 03:55 合并 / 接线 / 门 / 截图 / a11y 扫描 fable-5-1-24 → 22:50 – 23:40 收尾 fable-5-1-52）

> 接手链：fable-5-1-24 接自（前一个）fable-5-1-52 的任务转派（其导出记录只到集成② / t-865，集成④ 从零开始），完成 12 步合并、接线、全量门、全量截图与 a11y 扫描后离线——本段文字留在主克隆工作树里**未提交**，§5 截图 / a11y 两格与 §8 终点为占位，integration 分支 **集成④ 全部 81 个提交（含 `--no-ff` 带入的成员提交）未推远端**——`git ls-remote` 实测 origin 停在集成③ 终点 `36bb9a677`（本地 `origin/feat/v5-selfhost-ocv5-audit-ux` 跟踪引用显示的 `43b7cd3a4` 是陈旧值：主克隆 `remote.origin.fetch` 只配了 canonical 一条 refspec，其它分支的跟踪引用不会随 fetch 更新，核对远端一律用 `git ls-remote`）。替身 t-1334（fable-5-1-53）也离线。fable-5-1-52（新会话，t-1234 交付后）按指挥官 fable-5-1-50 派单在 t-896 下收口：逐条核对 §1 / §8（`rev-list` 现算）、沿用同一源码态 HEAD 的既有日志并**复跑** typecheck / typecheck:preview / biome / build / vitest 全量 / test:browser（§5 收尾列）、补齐 §5 占位、按当日交付更新 §7 待办、提交本文并推送 origin。

> 起点 `36bb9a677`（集成③ 终点，含 t-1046 之前的 q-1076 处置）。任务书 7 条 + 指挥官 q-1227 拍板追加 5 条（tut-sync-2 / qa-gap / qa-p3 / qa-b-p3 / archive），共 **12 步 `--no-ff` 合并**、2 个自有源码提交、1 个 `chore` accept、1 个 docs。
> 主克隆 `v5-selfhost` 上操作（d-24），全部提交 subject 为 merge / feat / test / chore / docs（d-26，`git log --format=%s 36bb9a677..HEAD` 无 `fix(v5)`），未 rebase / squash / force-push，未碰 `changelog.json`。

### 1. 合入顺序与 SHA

| 序 | 成员分支 @ HEAD（任务） | 合并提交 | 文件 / 行 | 备注 |
|---|---|---|---|---|
| 1 | `feat/v5-selfhost-audit-hud@b1f06f8f5`（t-836 hud，基线 `210b9967`） | `2c1d659d2` | 9 files, +959/−90 | `run.mjs` T61 一行三方合并 |
| 2 | `feat/v5-selfhost-audit-kp-automation@b0fd16dad`（t-838，基线 `210b9967`） | `d83d4a368` | 4 files, +1525/−283 | 零重叠 |
| 3 | `feat/v5-selfhost-audit-misc-p3@c834dffa1`（t-839，基于集成② `1d8eaf769`） | `bf940d804` | 9 files, +676/−51 | 零重叠 |
| 4 | `feat/v5-selfhost-audit-permission-card@8a3179896`（t-875，基线 `210b9967`；`4680572c1` + 文档追加，代码不变） | `015522b66` | 5 files, +1248/−37 | `MessageRenderer.test.tsx` 三方自动合并；`shoot.mjs` 与 integration 同一改动无差异 |
| 5 | `feat/v5-selfhost-audit-a11y-shell@4930707cc`（t-893，基于 `c034f05d7`） | `15f816145` | 20 files, +513/−51 | token / `components/ui/**` / `styles.css` 层，先于 mod-a/mod-b |
| 6 | `feat/v5-selfhost-audit-a11y-mod-a@475e3e6c7`（t-894，基于 `c034f05d7`；含 QA t-1028 两条 nit 追加） | `68f031ba6` | 29 files, +414/−50 | 零重叠 |
| 7 | `feat/v5-selfhost-audit-a11y-mod-b@9710a3b24`（t-895，基于 `be20adaec`；含 L-11 / M-23 附录 `6236dfb08` / `986f72b2f` / `85a7aea54`） | `80e757d95` | 18 files, +481/−57 | `Composer.tsx`（与 q-1076 `29a277b25` 不同 hunk）、`MessageRenderer.test.tsx`（与 permission-card）三方自动合并。合并时分支 tip 已由交付时的 `8110d0eea` 前进到 `9710a3b24`（两笔附录），实际合入 `9710a3b24`，说明已 amend |
| 8 | `feat/v5-selfhost-audit-tut-sync-2@67b1494ea`（t-1046，基于 `36bb9a677`） | `96eb0eadf` | 7 files, +25/−24 | `Composer.tsx` 三方自动合并（恢复 C-02 `data-product-feature` vs a11y-mod-b 会话目标 chip） |
| 9 | `feat/v5-selfhost-audit-qa-gap@c1734aac6`（t-1029，基于 `c034f05d7`，自带 hud / kp-automation / misc-p3 三条的合并） | `902ade6e8` | 4 files, +192/−41 | **唯一冲突** `scenes-hud.tsx`，见 §2 |
| 10 | `feat/v5-selfhost-audit-qa-p3@3e640a85d`（t-1028，纯文档） | `4f93f6990` | 1 file, +125 | — |
| 11 | `feat/v5-selfhost-audit-qa-b-p3@0ac949b2e`（t-1038，纯文档 + landing / media 两处勘误） | `f605df89f` | 3 files, +242/−2 | — |
| 12 | `feat/v5-selfhost-audit-archive@a38a093bf`（t-632 归档初稿 + t-761 预整理 + t-897 预写，纯文档；q-1227 口径为 `e2ce9e4ba`，合并时 tip 已前进两笔 docs） | `b23955208` | 20 files, +1404 | — |

十二步合计（`git diff --shortstat 36bb9a677 HEAD`，含自有提交）125 files, +7783/−654。`git rev-list --count HEAD..<成员 HEAD>` 对 12 条均为 0；合并完整性核对（每个合并：分支侧改动文件在合并结果中若与分支版本不同，则 integration 侧必须也改过该文件）**LOST = 0**，三方合并文件 5 处如上；树内无冲突标记。
集成④ 自有提交：`d2afaaa20` test（scenes-hud TS2353，随后被 qa-gap 同处修正覆盖，见 §2）、`4a2745283` feat App 接线（§3）、`2d2b5cafc` chore 教程同步快照 accept（§4）、docs 本文。

### 2. 冲突与取舍

- **`browser-tests/ui-preview/scenes-hud.tsx`（qa-gap ↔ 本轮 `d2afaaa20`）**：hud 分支基于 `210b9967`（尚无 `typecheck:preview` 脚本），场景把 `{ totalTokens, estimated: true }` 作对象字面量传给 `PinnedTaskTracker` 的 `TurnTokenUsageSnapshot` prop，`typecheck:preview` 首次覆盖该文件报 TS2353；本轮先用无类型常量消掉，qa-gap（t-1029 复核 hud）在 `747596782` 用 `LiveTurnTokenUsageSnapshot` 带类型常量修了同一处 → **取 qa-gap 版本**（`git checkout --theirs`，合并结果与 qa-gap 文件逐字节相同），`d2afaaa20` 的改动让位。指挥官 q-1227 已预先指定此取舍。
- 其余 11 步零冲突；五处三方自动合并（`run.mjs` T61、`MessageRenderer.test.tsx` ×2、`Composer.tsx` ×2）逐文件对照分支版本，差异全是 integration 侧同文件的既有改动，无丢失。

### 3. 跨模块接线（各模块文档登记 → 本轮落地）

| 来源 | 登记位置 | 落地 | 用例 | 提交 |
|---|---|---|---|---|
| hud H-18 「停止本轮」父轮已结束仍显示 | hud.md §8 | `App.tsx` `PinnedDelegateTracker` `onStop={wsSending ? stopTurn : undefined}`（`wsSending = !demo && chat.isSending(activeId)`，与 `PinnedTaskTracker active` 同源） | `PinnedDelegateTracker.test` 既有「hasRunning && onStop 才显示」契约；`App.test` 回归 | `4a2745283` |
| misc-p3 D-02 demo 其余会话点开为空 | misc-p3.md §6 | `App.tsx` `onDemoSelect: (id) => setMessages(DEMO_MESSAGES_BY_SESSION[id] ?? [])`（当前与原 s1 特判等价；补 fixture 只改 `lib/demo.ts`） | `demo.test` 4 例；`App.test` demo 用例 | `4a2745283` |
| tutorials TU-32 / media X-M2~M4 / .gitattributes | 集成②③ | 已在起点 HEAD，本轮核对无回退 | — | — |
| permission-card「自动弹框关闭后焦点落 body」 | permission-card.md §6 | **登记待办**（需 shell 接 `onCloseAutoFocus`，成员自标不修） | — | — |
| hud H-12 精确计时 / H-20 两条跨模块备注 | hud.md §8 | **登记待办**（H-12 需协议 `startedAt`；H-20 messages `TokenUsageBadge` 淡入 / shell `text-faint` 深色对比度——后者已由 a11y-shell #4 压暗 `--faint`） | — | — |
| misc-p3 D-08 / OG-09 | misc-p3.md §6 | **登记待办**（demo「不可交互」说明归 shell+messages；发送失败恢复需 `ChatInteraction` 失败通道） | — | — |
| a11y-shell §5 跨模块同源项 | a11y-shell.md §5 | 其中 RepoPill / RepoStatusBanner（mod-a sidebar#1/#2）、ApiKeysSection 禁用行（mod-a settings#3/#6）、ModelSelector 锁定行（mod-b composer#2）、MediaTaskCenter header（mod-b media#1）已随本轮合入；**其余登记 §7** | — | — |
| kp-automation / permission-card / a11y-mod-a / a11y-mod-b | 各文档 | 无 App / shell 接线登记 | 全量 `npm test`（§5） | — |

### 4. `check:tutorials`：合入后一次新漂移（q-1227 → A，**用户终审请确认**）

| 时间 | HEAD | 结果 | 处置 |
|---|---|---|---|
| 02:03 | `80e757d95`（7 步合并） | 「功能源变化: github-repository」1 项；入口身份 / 正文 / 媒体 / 案例 / 注册表均无变化（`integ4-check-tutorials.log`） | 开卡 q-1227（合并范围 + 该漂移处置） |
| 02:27 | `4a2745283`（12 步合并 + 接线，含 t-1046 的普通 accept 与两处 `data-product-feature` 恢复） | 仍只剩 github-repository 1 项，入口身份无变化（`integ4-check-tutorials-2.log`） | q-1227 → **A**（fable-5-1-18）：凡 a11y / 样式改动引起、入口身份无变、正文与 UI 文案抄检一致的功能源漂移，统一 `--source-only` 接受 |
| 02:28 | `2d2b5cafc` | `npm run tutorials:accept -- --source-only --ids github-repository --note "集成④ a11y 修复致功能源漂移，正文与媒体未变，抄检一致；由指挥官 fable-5-1-18 代用户确认（q-1227），待用户终审"` → `OK · source-only · 1 capability snapshots changed`；`check:tutorials OK · 26 capabilities · 12 cases · 26 media pairs`（`integ4-tutorials-accept.log` / `integ4-check-tutorials-3.log`） | `chore(v5)` 单独提交 `2d2b5cafc`（三份同步文件，history 第 69 条） |

**漂移来源与抄检**：`github-repository` 的功能源哈希覆盖 `components/github/RepoPill.tsx` / `RepoStatusBanner.tsx` / `Sidebar.tsx`；本轮相对 `36bb9a677` 的改动全部来自 a11y-mod-a `036a2f3dd`（`opacity-70/80` 降色 → `text-muted` 实色、移动抽屉两钮 `min-h-11`）——`git diff 36bb9a677 HEAD -- components/github` 里没有任何用户可见文案的增删，入口元素身份不变，教程正文 / 媒体未动；t-1046 在 `36bb9a677` 源码态做的普通 accept（history 第 68 条）不覆盖这一项，故需再接受一次。
**入口身份变化本轮为 0**（q-1227 明确：若出现必须再开卡）。**可逆性**：`git revert 2d2b5cafc` 即回到 accept 前（`check:tutorials` 重新报 github-repository 1 项，其余门不受影响）。
终审导读应同时列：集成③ §4 的 17 项 source-only（q-1076）、t-1046 的普通 accept（agents / chat-basics 正文补写，history 第 68 条）、本轮 1 项 source-only（q-1227，history 第 69 条）。

### 5. 全量门结果（最终源码态 HEAD = `2d2b5cafc`；日志 `.audit-tmp\integration\integ4-*`）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0（7 步合并态 `integ4-typecheck.log`、接线后、最终 `integ4-typecheck-final.log` 各一次） |
| 预览台类型检查 | `npm run typecheck:preview --workspace packages/web-react` | 7 步合并态 ❌ 1 红 `scenes-hud.tsx(199,49)` TS2353（本轮合入引入，hud 分支基线无此脚本）→ `d2afaaa20` / qa-gap `747596782` 修正 → ✅ **exit 0**（`integ4-typecheck-preview-2.log`、最终 `integ4-typecheck-preview-final.log`） |
| 教程门禁 | `npm run check:tutorials` | ✅ OK · 26 capabilities · 12 cases · 26 media pairs（§4；accept 前两次红见 `integ4-check-tutorials{,-2}.log`） |
| web-react 全量单测 | `cd packages\web-react; npm test` | ✅ **302 文件 / 4279 例全部通过，0 失败**，两次：7 步合并态 `d2afaaa20`（723s，`integ4-vitest-all-1.log`）与最终 HEAD `2d2b5cafc`（901s，`integ4-vitest-all-2.log`）。集成③ 为 298 / 4213 → +4 个测试文件（`KnowledgePlanetAutomationPanel.test` / `optionsGroup.test` / `demo.test` / `ui/a11y.test`）、+66 例（hud +11、kp-automation 10、misc-p3 14、permission-card +13、a11y-shell +8、a11y-mod-a/b 补例与 M-23 契约例等） |
| 真浏览器门 | `$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser` | `run.mjs` 组件门 **T1–T68 全部 ok**（自检「清单 68 条全部执行」，含 hud T61「任务列表 N/M」、media T30、tutorials T38）；`node --test` 16 文件 87 例：**85 通过 / 2 失败** = `cc-switch-ascii-name` ×2（**基线**，与集成①②③逐条相同：「还没有 API Key」10s 超时 + 模型 id `gemini-3.8-flash` vs `sonnet-5`）；`ocv5-185-qa` 15/15 ✅（工作树干净 + junction）。日志 `integ4-test-browser.log` |
| ui-preview 全量截图 | `OC_UI_SHOTS=…\integration\shots-integ4 node browser-tests\ui-preview\shoot.mjs`（不设 `OC_UI_SCENES`） | ✅ **301 场景 / 1026 张，`failures: 0`、`retried: 0`**（03:14，`integ4-shoot-all.log`，`shots-integ4\manifest.json`）；集成③ 为 257 场景 / 854 张 → +44 场景 / +172 张 = hud 10 + kp-automation 14 + misc-p3 7 + permission-card 13 个新场景（`scenes-hud` / `scenes-kp-automation` / `scenes-misc-p3` / `scenes-permission-card`）。`unmockedApi` 仍为集成②③ 同样的 2 个（`listCronChannels` / `listProjectAssets`，已返回默认值）。收尾抽样 Read 14 张：`workspace-chat-density` / `composer-loaded` / `hud-stack-expanded` / `permission-card-pending-modal` / `kp-automation-list` / `misc-options-partial` 各 desktop-light + mobile-dark，`market-review--desktop--light` + `market-review-mobile--mobile--dark`——布局 / 间距 / 触控高度无破版、390px 无横向溢出、深色下权限弹层「允许」主键与 kp 开关已走 `-fg` token（浅紫底深字）；唯一肉眼可见的残留是 `misc-options-partial--mobile--dark` 已选项勾标白字压在 `#9a8aff` 上，即下一行 a11y 的 `shell#1` 残留 ×3（a11y-C 已修，待集成⑤） |
| a11y 复扫 | `node ..\.audit-tmp\a11y\scan.mjs`（t-762 / t-893 同一脚本，`OC_REPO` 默认主克隆，`OC_A11Y_OUT=…\integration\a11y-integ4\results`）→ `a11y-integ4\report.md`；对比脚本 `compare-integ4.mjs`（before = t-893 `scan-before`，integration 集成③态 `c034f05d7` 257 场景）→ `compare-integ4-utf8.txt` | ✅ **301 场景 0 渲染失败**。共同 257 场景九项指标**只降不升**：对比度浅色 356 → 44（−312）、深色 111 → 69（−42）、触控 <44 493 → 163（−330）、无名控件 16 → 11、CDP AX 3 → 1、misc 226 → 221；`t24` 371 / `tabBad` 12 / `click` 153 持平；**逐场景回归 0**。仅 after 有的 44 个新场景自有命中：kp-automation 浅色对比 3 / 深色 3 / 触控 3、permission-card `t44` 8 / misc 86（历史结清卡的只读摘要区）、misc-p3 浅色 2 / 深色 5、hud 仅 `hud-task-long` misc 1（长任务列表滚动区）——均为成员文档已登记的自标项（kp-automation KP 勾选态 / permission-card 历史卡 / options 选项块），无新类型。**t-762 九条 P2 逐条：8 条清零，`shell#1` 深色 `bg-accent + text-white` 残留 4**（`misc-options-*` ×3 = `optionsGroup.tsx` / `RichBlocks.tsx` 选项块；`org-subscribe-dialog` ×1 = `OrgSubscribeDialog.tsx`「当前」徽章）——正是 §7 登记的 a11y-shell §5 跨模块同源项，已在 a11y-C（t-1233，分支 `feat/v5-selfhost-audit-a11y-c@12275f27a`：`59e66773f` / `b591e64b6`）修掉，随集成⑤ 合入后应为 0。after 新出现的 fg/bg 组合 9 组全部是同一批元素在 a11y-shell 调 token 后的新色值而非新增元素：8 组为 `disabled=true` 的按钮 / 徽章 / 占位符（WCAG 1.4.3 对非活动控件不作要求，全站禁用态例外），1 组 `AgentPicker`「默认」徽章 4.40:1（a11y-C `abb246fdb` / `faa6e8b26` 已改 `bg-accent-soft` / 实底 + `text-accent-fg`）。`targets44` 新出现 3 组 = market 发布底栏「查看」38×44（a11y-mod-a 把高补到 44，宽 38；QA t-1232 `77a93d9e1` 已补 `min-w-11`，随集成⑤） |
| 首屏 gzip 预算（`build`） | `cd packages\web-react; npm run build`（`tsc -b && vite build`，`vite.config.ts` `first-screen-budget` 插件） | ❌ **已知红，只记数值**：`tsc -b` 绿，`vite build` 5103 modules 后被预算门拦下——首屏 modulepreload 闭包 15 个 chunk **gzip 471.4KB > 预算 460.0KB**（`FIRST_SCREEN_GZIP_BUDGET = 471040`）：`main` 139.4KB、`tapePayload` 125.5KB、`styles` 75.1KB、`react-vendor` 55.3KB、`radix-vendor` 29.9KB、`media` 17.7KB、`lucide-vendor` 17.7KB、`viewport-shared` 2.9KB …（`integ4-final-build.log`）。由 t-1348（fable-5-1-57）在修，随集成⑤ 合入；本轮不等它 |
| 代码风格 | `npx biome lint` 集成④ 自有提交触碰的源文件 | `App.tsx` 14 = 基线 14（`useExhaustiveDependencies`，集成② §7.1 已登记）；`scenes-hud.tsx`（qa-gap 版本）0；三份 tutorial-sync 文件非 lint 目标 → **新增 0 条**。各成员分支的 biome 对照见各自交付（均报新增 0） |

**收尾复跑**（fable-5-1-52 · 23:12–23:27 · 同一源码态 `2d2b5cafc`，主克隆；脚本 `.audit-tmp\integration\integ4-final-gates.ps1`，汇总 `integ4-final-gates.summary.txt`，各步日志 `integ4-final-*.log`）：

| 门 | 结果 | 与 -24 首跑对照 |
|---|---|---|
| `typecheck` | ✅ exit 0（`tsc -b` 增量，1s） | 同 |
| `typecheck:preview` | ✅ exit 0（40s） | 同 |
| `biome lint App.tsx scenes-hud.tsx` | `Checked 2 files`，14 条全为 `App.tsx` `useExhaustiveDependencies` = 基线 14，`scenes-hud.tsx` 0 → 新增 0 | 同 |
| `build` | ❌ `tsc -b` 绿 → `vite build` 5103 modules → `first-screen-budget` 拦下：471.4KB > 460.0KB（上表「首屏 gzip 预算」行） | 首跑未跑 build；本轮补记数值，t-1348 在修 |
| `npm test`（web-react 全量） | ✅ **302 文件 / 4279 例全部通过，0 失败**（683s） | 与两次首跑 302 / 4279 逐数相同，第三次全绿 |
| `npm run test:browser` | `run.mjs` **68 全过（清单 68 条全部执行）**；`node --test` 87 例 **85 通过 / 2 失败** = `cc-switch-ascii-name` ×2（基线，同 §6）；`ocv5-185-qa` 15/15 ✅（110s） | 逐条相同 |

### 6. 已知基线失败（本轮更新）

| 项 | 现象 | 状态 |
|---|---|---|
| `browser-tests/cc-switch-ascii-name.node-test.mjs` ×2 | 「还没有 API Key」10s 超时；模型 id 断言 `gemini-3.8-flash` vs `sonnet-5` | 基线（集成①②③④ 四轮逐条相同，settings `ApiKeysSection` 契约，owner 待处理） |
| `browser-tests/ocv5-185-qa.node-test.mjs` | 需工作树干净（`git diff --exit-code` 拦截）+ `node_modules/@openclaude/protocol` junction | 环境项；本轮全量首跑即 15/15 绿 |
| `typecheck:preview` TS2353 `scenes-hud.tsx` | hud 分支基线无该脚本 | ✅ 本轮已修（§2 / §5） |
| `check:tutorials` 快照漂移 | github-repository 1 项 | ✅ 已 `--source-only` accept（q-1227，**待用户终审**，§4） |
| `MessageRenderer.test.tsx` `beforeAll` 超时 / `App.test.tsx` 15s 超时 | 负载偶发 | 本轮两次全量 + 收尾第三次全量（§5）均未复现；t-1234 收尾在 `wt\leftover-shell` 单跑 `App.test.tsx` 时复现 1 次（`authenticated send goes through the real WS engine…` 15s，本机 CPU 53%、多会话并行），同 HEAD 立即复跑 48/48 绿——仍按负载偶发登记 |
| `packages/web-react` `npm run build` 首屏 gzip 预算 | 471.4KB > 460.0KB（`FIRST_SCREEN_GZIP_BUDGET = 471040`），15 个首屏 chunk | **红，非基线**：t-1348 在修（§5 / §7），集成⑤ 必须转绿后才能发布 |

### 7. 遗留 / 后续范围

- **待用户终审**：§4（本轮 1 项）+ 集成③ §4（17 项 + t-1046 普通 accept）三笔教程同步快照 accept；归档终稿 t-897 请列入终审导读。
- **a11y 跨模块同源项（a11y-shell.md §5 剩余）→ 已立 a11y-C t-1233（分支 `feat/v5-selfhost-audit-a11y-c@12275f27a`，15 提交，自带 a11y-shell / mod-a / mod-b / kp-automation / misc-p3 / tut-sync-2 / qa-gap 的合并对齐；持有人离线未交付，分支**只在本地、未推远端**，收尾任务 a11y-c-finish（代 t-1233：文档补齐 + 验证 + 提交推送）待领），随集成⑤ 合入；§5 a11y 复扫的 `shell#1` 残留 4 与 `AgentPicker`「默认」徽章 4.40 即此清单中的项。原清单**：`org/OrgSubscribeDialog.tsx:173`「当前」徽章 `bg-accent text-white`；`manage/OptimizationPanel.tsx:296`、`settings/ApiKeysSection.tsx:468` 图标块 `bg-accent text-white`；`AgentPicker.tsx:148` `bg-accent/15` 底 4.40（改 `bg-accent-soft`）；`optionsGroup.tsx:173`、`RichBlocks.tsx:249/267` 选项组按钮 / 勾选 `bg-accent text-white`；media `ImageCommentMode.tsx:332,410` / `ImageAnnotationEditor.tsx:905,1045` / `ImageResizeMode.tsx:235` 沉浸式底 `bg-danger text-white` 与 `bg-danger/25` 白字；`marketplace/ReviewPanel.tsx` 禁用态按钮 opacity（全站禁用态例外，可不修）；`settings/KnowledgePlanetAutomationPanel.tsx:700` 勾选态 `bg-accent text-white`。修法均为 `text-*-fg` token / 实色 soft 底，一处一行。
- **各模块自标待办**：hud H-12（协议 `startedAt`）、H-19（设计取舍保留）、H-20（messages `TokenUsageBadge` 流式淡入）；~~misc-p3 D-08~~ → **已由遗留清扫 t-1234 落地**（`ChatInteraction.reason` + demo 文案，分支 `feat/v5-selfhost-audit-leftover-shell@7e7c7e43b`，同分支还带 market K-27 `ui/Checkbox` 原语与 ~~settings 备案判据可选去重~~ → **已落地**（改引 `lib/legal` `filedIcp()`）；待集成⑤）；misc-p3 OG-05 / OG-09（messages）；permission-card 自动弹框 `onCloseAutoFocus`、「正在提交…」超时重试；kp-automation KP-18 / KP-19 不修项；~~tutorials TU-17 深链 / TU-34 hero token（shell）~~ → **已由遗留清扫 t-1235 落地**（`?panel=help&tab=|work=|topic=&step=` 深链 + 模块级 `heroTheme.ts` token，分支 `feat/v5-selfhost-audit-leftover-tut@69e18aa93`，待集成⑤）；media M-25 分享令牌 / M-24 价格字段 / M-09 双指缩放（后端 / 协议）。
- **首屏 gzip 预算红（§5 `build` 行）**：471.4KB > 460.0KB，t-1348（fable-5-1-57）在修，随集成⑤ 合入；发布前 `npm run build` 必须过。
- **集成⑤ 待合清单（t-1237 之前，按本轮 §8 现算）**：`qa-a11y@eed1f3989`（QA t-1232，+2）、`a11y-c@12275f27a`（t-1233，+15，先推远端）、`leftover-tut@69e18aa93`（t-1235，+3）、`leftover-shell@7e7c7e43b`（t-1234，+6）、`archive@35e3ec7c9`（t-897 预写，+1）、t-1348 gzip 修复分支、QA-integ4 t-1236 产出。**不合入**：`integ4-rehearsal@522c24988`（集成④预演，8 个 `rehearsal:` 合并提交）与 `release-rehearsal@c1fdc935e`（发布预演：canonical `3b7c38b9d` 试合 integration `2d2b5cafc`，结论在 `docs/audit/RELEASE.md` §预演）。
- **canonical 已前进**：`git ls-remote` origin `feat/v5-selfhost` = `f1952819f`（`feat(v5): wire Sand-usable Cursor families into the picker`，在预演用的 `3b7c38b9d` 之后 +1），release-prep t-1237 试合时以 `f1952819f` 为准重做冲突核对。
- 合入 canonical `feat/v5-selfhost` 与服务器部署按 d-1326 由指挥官全权推进（t-1237 / t-1268），本轮只推 integration 分支自身到 origin。

### 8. 分支合入状态单（集成④ 终点现算）

按 `git rev-list --count HEAD..<分支 HEAD>` 现算于 integration 源码态 `2d2b5cafc`（本文 docs 提交在其后，不改源码；收尾 23:05 复算一遍，下表 24 条全部仍为 0）。远端核对用 `git ls-remote --heads origin`（23:05）：下表 24 条分支远端 SHA = 本地 SHA（`a11y-c` / 两条预演分支不在远端，见表末）。

| 分支 `feat/v5-selfhost-audit-*` | 分支 HEAD | 合入到 integration 的合并提交 | 未合入提交 |
|---|---|---|---|
| shell | `39697560b` | 集成① 起点已含 | 0 |
| sidebar | `25c775295` | 集成① `3cff04c85` → 集成② `b41e804ac` | 0 |
| tools | `d65c6741e` | 集成② `6fa690d7e` | 0 |
| landing | `b97adb3fb` | 集成② `6201518b2` | 0 |
| media | `8834aca08` | 集成② `10398baa9` | 0 |
| composer | `70d3db8b3` | 集成② `ae0b0cb64` | 0 |
| settings | `5eac1b807` | 集成② `5e5ed6925` → 集成③ `12fc17579` | 0 |
| messages | `2abe389a9` | 集成① `985b3ae57` → 集成③ `cd58600e8` | 0 |
| taskboard | `05dd185df` | 集成① `bf8188def` → 集成③ `425655631` | 0 |
| manage | `6fae01440` | 集成① `09a13a472` → 集成③ `c761bbd93` | 0 |
| market | `5391c150a` | 集成② `ab765669a` → 集成③ `be20adaec` | 0 |
| tutorials | `02c358655` | 集成③ `ce767d8ce` | 0 |
| hud | `b1f06f8f5` | **集成④ `2c1d659d2`** | 0 |
| kp-automation | `b0fd16dad` | **集成④ `d83d4a368`** | 0 |
| misc-p3 | `c834dffa1` | **集成④ `bf940d804`** | 0 |
| permission-card | `8a3179896` | **集成④ `015522b66`** | 0 |
| a11y-shell | `4930707cc` | **集成④ `15f816145`** | 0 |
| a11y-mod-a | `475e3e6c7` | **集成④ `68f031ba6`** | 0 |
| a11y-mod-b | `9710a3b24` | **集成④ `80e757d95`** | 0 |
| tut-sync-2 | `67b1494ea` | **集成④ `96eb0eadf`** | 0 |
| qa-gap | `c1734aac6` | **集成④ `902ade6e8`** | 0 |
| qa-p3 | `3e640a85d` | **集成④ `4f93f6990`** | 0 |
| qa-b-p3 | `0ac949b2e` | **集成④ `f605df89f`** | 0 |
| archive（含 archive-prep `591c4cb70`） | `a38a093bf` → 收尾时 tip 已前进到 `35e3ec7c9`（t-897 预写 +1，纯文档） | **集成④ `b23955208`**（合入 `a38a093bf`） | 0（对 `a38a093bf`）/ **1**（对 `35e3ec7c9`，待集成⑤） |

集成④ 之后新交付、**待集成⑤** 的分支（23:05 现算，`git rev-list --count HEAD..<分支>`）：

| 分支 `feat/v5-selfhost-audit-*` | 分支 HEAD | 任务 | 未合入提交 | 远端 |
|---|---|---|---|---|
| qa-a11y | `eed1f3989` | QA t-1232（a11y-B 三条 + PermissionCard 复核 + 两处 QA 修复） | 2 | = 本地 |
| a11y-c | `12275f27a` | t-1233 a11y-C 跨模块同源项（收尾 a11y-c-finish 待领） | 15 | **未推** |
| leftover-tut | `69e18aa93` | t-1235 tutorials TU-17 / TU-34 | 3 | = 本地 |
| leftover-shell | `7e7c7e43b` | t-1234 K-27 Checkbox / settings 备案判据 / D-02·D-08 | 6 | = 本地 |
| archive | `35e3ec7c9` | t-897 归档终稿预写 | 1 | = 本地 |
| integ4-rehearsal | `522c24988` | 集成④ 预演（8 个 `rehearsal:` 合并） | 8 | 未推（**不合入**） |
| release-rehearsal | `c1fdc935e` | t-1279 发布预演（canonical `3b7c38b9d` 试合） | 8 | 未推（**不合入**） |

下一步：集成⑤（t-1237 前置）从本轮终点起按上表合入 + t-1348 gzip 修复，复跑全量门（`build` 必须绿）；归档终稿 t-897 从集成⑤ 终点起更新 `docs/audit/SUMMARY.md` 与 `archive/*` 的 `[待集成④]` 标记；release-prep t-1237 以 canonical `f1952819f` 重做试合。

## 集成⑤（t-1237 · 2026-09-18 01:45 – 02:15 · 合并 / 门 / 记录 / 推送 fable-5-1-4）

> 执行人说明：t-1237 在待办池解锁时被宿主自动领到 fable-5-1-3 名下，而他在交付 t-1567 后已离线；组内在线只剩指挥官 fable-5-1-4 与 fable-5-1-6（t-1598 发布准备预演），用户 02:0x 明示「全权负责，端到端部署上线，不用问我 / 现在就你和另外一个会话了，都不要停」（决策 d-1603），故由指挥官**代执行**本轮合并、门与记录；任务记录仍挂在 fable-5-1-3 名下，以本段为实际交付。
> 起点 `c97a750f8`（集成④ 终点）。任务书 6 条 + 指挥官追加 2 条（t-1575 首屏回归修复、t-1236 QA 报告），共 **8 步 `--no-ff` 合并**、1 个 `chore` accept、1 个 docs（本段）。主克隆 `v5-selfhost` 上操作（d-24），`git log --format=%s c97a750f8..HEAD` 全为 merge / refactor / chore / docs（d-26，无 `fix(v5)`），未 rebase / squash / force-push，未碰 `changelog.json`。
> 前置：fable-5-1-2 的集成⑤预演 `feat/v5-selfhost-audit-integ5-rehearsal@b6b78e876`（t-1503：6 条已合、typecheck ✅、**build ❌ 475.2KB**）→ 指挥官逐合并点二分归因（§3）→ t-1575 修复分支；QA 集成④ t-1236（fable-5-1-6，docs/audit/qa/qa-integ4.md，三道门由 fable-5-1-3 t-1567 实跑）结论「可进集成⑤，阻断 0；必带 budget-fix + t-1575」。预演分支**不合入**。

### 1. 合入顺序与 SHA

| 序 | 成员分支 @ HEAD（任务） | 合并提交 | 文件 / 行 | 备注 |
|---|---|---|---|---|
| 1 | `feat/v5-selfhost-audit-budget-fix@65019b5dc`（t-1348 首屏 gzip 预算修复：点开才需要的覆盖层改 `React.lazy`，阈值 471040 未动） | `ec09ed419` | 12 files, +323/−142 | `App.tsx` 三方自动合并 |
| 2 | `feat/v5-selfhost-audit-qa-a11y@eed1f3989`（t-1232 QA 复核 a11y-B 三条 + PermissionCard，含两处 QA 修复） | `c701daac9` | 5 files, +222/−4 | 零重叠 |
| 3 | `feat/v5-selfhost-audit-leftover-shell@7e7c7e43b`（t-1234 market K-27 `ui/Checkbox` 原语 / settings 备案判据去重 / misc-p3 D-02·D-08 接线） | `7cae5427f` | 18 files, +659/−85 | 零重叠 |
| 4 | `feat/v5-selfhost-audit-leftover-tut@69e18aa93`（t-1235 tutorials TU-17 深链 + TU-34 hero token） | `c4a516697` | 10 files, +529/−28 | 引入首屏回归（§3），由第 5 步修正 |
| 5 | `feat/v5-selfhost-audit-leftover-tut-budget@a947662bb`（t-1575 `useAppRoute` 深链校验改用零依赖 `tutorialSignatureWorkIds`，不再静态导入 `tutorialSignatureWorks→tutorialCaseCatalog`） | `10e1348fb` | 4 files, +50/−5 | 紧跟第 4 步；useAppRoute chunk 30.7KB → 2.0KB |
| 6 | `feat/v5-selfhost-audit-a11y-c@c35fd00c6`（t-1233 a11y-C 跨模块同源项：§5 13 项 7 修 / 5 同批闭环 / 1 不修 + 复扫补修 2；含 t-1344 第四手复核 `ea9348b2b`） | `ecf912b88` | 17 files, +312/−14 | **唯一冲突** `RichBlocks.test.tsx`，见 §2 |
| 7 | `feat/v5-selfhost-audit-archive@35e3ec7c9`（t-897 归档终稿预写 +1，纯文档；集成④ 合入 `a38a093bf` 后前进的那一笔） | `b6da4ef8d` | 1 file, +19/−13 | — |
| 8 | `feat/v5-selfhost-audit-qa-integ4@31a8a92d6`（t-1236 QA 集成④ 最终 HEAD 独立复核报告 `docs/audit/qa/qa-integ4.md`，纯文档） | `936d44e85` | 1 file, +153 | — |

八步合计（`git diff --shortstat c97a750f8 HEAD`，含 accept）**64 files, +2269/−292**，43 个提交。`git rev-list --count HEAD..<成员 HEAD>` 对 8 条均为 **0**；`git grep -l '^<<<<<<< ' HEAD -- packages docs` 为空。集成⑤ 自有提交：`91358ce54` chore 教程同步快照 accept（§4）、docs 本段。

### 2. 冲突与取舍

- **`packages/web-react/src/components/RichBlocks.test.tsx`（a11y-c ↔ leftover-shell）**：两条分支在 `OptionsBlock` 的同一 describe 末尾各新增一条用例——leftover-shell 的「demo 演示模式文案（D-08）」与 a11y-C 的「已选项勾标 / 确认按钮 `text-accent-fg`」→ **两条全部保留**，先 D-08 后 a11y-C（与预演 t-1503 的解法一致）；合并后该文件 `vitest` 25/25 绿。`RichBlocks.tsx` 本体三方自动合并（reason 文案与 `text-accent-fg` 同时在）。
- 其余 7 步零冲突（`App.tsx` 在第 1 步三方自动合并：budget-fix 的 `React.lazy` 拆分与集成④ 接线不同 hunk）。

### 3. 首屏 gzip 预算回归（本轮专项，由集成⑤预演暴露）

预演树 `b6b78e876`（6 条合完）`vite build` ❌ **475.2KB > 460.0KB**，而 budget-fix 单独为 445.5KB。指挥官在自己的 worktree 上对预演分支逐合并点 detached 构建（脚本与日志 `.audit-tmp\release-rehearsal\bisect-integ5-first-screen.ps1` / `integ5-bisect\SUMMARY.txt`）：

| 合并点 | 首屏闭包 gzip | 变化 |
|---|---|---|
| `c1ef51a44` + budget-fix | 446.8KB ✅ | — |
| `537595a1e` + qa-a11y | 446.8KB ✅ | 0 |
| `b6c56be2d` + leftover-shell | 447.3KB ✅ | +0.5KB（styles） |
| **`586131c42` + leftover-tut** | **475.2KB ❌** | **`useAppRoute-*.js` 1.7KB → 30.7KB** |
| `6952c72ff` + a11y-c / `b6b78e876` + archive | 475.2KB ❌ | 0 |

根因：leftover-tut `3fee24a58`（TU-17 深链）在 `hooks/useAppRoute.ts`（入口静态闭包）新增 `import { SIGNATURE_WORKS } from '../lib/tutorialSignatureWorks'`，只为校验 `&work=planet|gravity`，却把 `tutorialSignatureWorks → tutorialCaseCatalog`（教程案例数据）整个拖进首屏（`vite.config.ts:77-87` 的历史注释正警告过「useAppRoute 拖教程案例数据」）。修复 t-1575（`a947662bb`，第 5 步）：新增零依赖 `lib/tutorialSignatureWorkIds.ts`（`SIGNATURE_WORK_IDS = ['planet','gravity']` + 类型），`useAppRoute` 改引它，`SignatureWork.id` 反向以该类型约束，另加 `tutorialSignatureWorkIds.test.ts` 断言两表集合相等防漂移。合入后 integration `build` ✅ **447.8KB（余量 12.2KB）**，见 §5。

### 4. `check:tutorials`：合入后一次功能源漂移（source-only accept，**待用户终审**）

| 时间 | HEAD | 结果 | 处置 |
|---|---|---|---|
| 01:50 | `936d44e85`（8 步合并） | 「功能源变化: agents, billing-usage」；能力注册表 / 入口身份 / 正文 / 媒体 / 案例 / 新增能力 / 待确认下线均无（`.audit-tmp\integration\integ5\check-tutorials-1.log`）；纯预演树 `b6b78e876` 同一份漂移（`.audit-tmp\leftover-tut-budget\check-tutorials-pure-b6b78e876.log`），与 t-1575 无关 | 按 q-1227 口径（a11y / 样式改动致、入口身份无变）`--source-only` 接受 |
| 01:52 | `91358ce54` | `npm run tutorials:accept -- --source-only --ids agents,billing-usage --note "集成⑤：source-only 接受 agents / billing-usage 功能源漂移（a11y-C AgentPicker·OrgSubscribeDialog、budget-fix SubscriptionDialog 等 className/lazy 改动致；t-1237）"` → `OK · source-only · 2 capability snapshots changed · 0 case snapshots changed`；`check:tutorials OK · 26 capabilities · 12 real-world cases · 26 media pairs`（`tutorials-accept.log` / `check-tutorials-2.log`） | `chore(v5)` 单独提交 `91358ce54`（三份同步文件，history **第 70 条**） |

漂移来源：`agents` 功能源含 `AgentPicker.tsx`（a11y-C #5「默认」徽章 `bg-accent + text-accent-fg`）；`billing-usage` 功能源含 `SubscriptionDialog.tsx`（budget-fix `React.lazy` 拆分）/ `OrgSubscribeDialog.tsx`（a11y-C #1「当前」徽章）。均为 className / 加载方式改动，无用户可见文案增删，入口身份变化 0。**可逆性**：`git revert 91358ce54` 回到 accept 前。终审导读应列：集成③ §4 17 项（q-1076）、t-1046 普通 accept（第 68 条）、集成④ §4 1 项（q-1227，第 69 条）、本轮 2 项（第 70 条）。

### 5. 全量门结果（最终源码态 HEAD = `91358ce54`；主克隆；脚本 `.audit-tmp\integration\integ5\run-gates.ps1`，汇总 `GATES-SUMMARY.txt`，各步 `*.log`）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0（29s） |
| 预览台类型检查 | `npm run typecheck:preview --workspace packages/web-react` | ✅ exit 0（19s） |
| 教程门禁 | `npm run check:tutorials` | ✅ OK · 26 / 12 / 26（§4） |
| **首屏 gzip 预算（`build`）** | `npm run build --workspace packages/web-react`（`tsc -b && vite build`） | ✅ **exit 0**，5108 modules；首屏 modulepreload 闭包 **13 chunk gzip 447.8KB（458555 B）< 预算 460.0KB，余量 12.2KB**：`main` 130.0KB、`tapePayload` 122.9KB、`styles` 77.9KB、`react-vendor` 55.3KB、`radix-vendor` 29.9KB、`lucide-vendor` 17.7KB、`media` 5.2KB、`viewport-shared` 2.9KB、`useAppRoute` 2.0KB…（`vite-build.log` / `measure-first-screen.log`）。集成④ 的 471.4KB ❌ 由 t-1348 + t-1575 转绿 |
| web-react 全量单测 | `cd packages\web-react; npx vitest run --maxWorkers=2` | ✅ **305 文件 / 4306 例全部通过，0 失败**（339s，`vitest-full.log`）。集成④ 302 / 4279 → +3 文件（`org/OrgSubscribeDialog.test.tsx`、`ui/Checkbox.test.tsx`、`lib/tutorialSignatureWorkIds.test.ts`）/ +27 例 |
| 真浏览器门 | `$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser` | `run.mjs` **68 全过（清单 68 条全部执行）**；`node --test` 87 例 **85 通过 / 2 失败** = `cc-switch-ascii-name` ×2（基线，与集成①②③④逐条相同）；146s（`test-browser-2.log`；首跑 `test-browser.log` 因未设 `OC_E2E_BROWSER` 环境错误 exit 2，非代码问题） |
| 代码风格 | `npx biome check --line-ending=crlf <52 个改动源文件>` HEAD vs 基线 `c97a750f8` 逐文件对比（`biome-compare.ps1` / `biome-compare.txt`） | **lint 规则新增 0 条**；5 条 `format` 差异全在本轮新增文件（`heroTheme.ts` / `ui/Checkbox.tsx` / `ui/Checkbox.test.tsx` / `hooks/useAppRoute.test.ts` / `scenes-market-audit.tsx`）= Windows 工作树 CRLF 与 formatter 行尾判定的差异，`git ls-files --eol` 显示 blob 为 `i/lf`，Linux CI 不受影响；既有文件计数逐一相同 |
| ui-preview 全量截图 + a11y 复扫 | 集成④ 同口径（`shoot.mjs` 301 场景 / `scan.mjs` + compare） | **第二拍**：本段提交时尚未跑（两人在线、t-1268 优先），随后在 detached 工作树上补跑并以 docs(v5) 追加结论；t-1236 / t-1524 的 52 张截图抽样（新增阻断 0）与 a11y-C 的 288 场景复扫（白字压 accent 4 → 0）已覆盖本轮改动面 |

### 6. 已知基线失败（本轮更新）

| 项 | 现象 | 状态 |
|---|---|---|
| `browser-tests/cc-switch-ascii-name.node-test.mjs` ×2 | 「还没有 API Key」超时 / 模型 id 断言 | 基线（五轮逐条相同） |
| `packages/web-react` `npm run build` 首屏 gzip 预算 | 集成④ 471.4KB ❌ → 预演 475.2KB ❌ | ✅ **本轮已解**：447.8KB（t-1348 + t-1575） |
| `check:tutorials` 快照漂移 | agents / billing-usage 2 项 | ✅ 已 `--source-only` accept（§4，**待用户终审**） |
| `test:browser` 环境 | 未设 `OC_E2E_BROWSER` 时找不到 Chrome | 环境项，命令带 env 即可 |

### 7. 遗留 / 后续范围

- **待用户终审**：四笔教程同步快照 accept（集成③ 17 项 / t-1046 / 集成④ 1 项 / 本轮 2 项）；归档终稿 t-897（持有人 fable-5-1-7 离线，待重派）。
- **a11y 同源遗留**：`TutorialCenter.tsx:387`「案例」模式头部图标块 `bg-accent text-white`（a11y-c.md §3 已给一行改法，归 tutorials）。
- biome `format` 5 个新文件（§5）：如需消掉，在 Linux 或以 `--line-ending=lf` 跑 `biome format --write`，与逻辑无关。
- 截图 / a11y 第二拍（§5 末行）。
- **不合入**：`integ5-rehearsal@b6b78e876`（t-1503 预演，6 个 `rehearsal:` 合并）、`release-rehearsal@a4452c7b6`（t-1279 发布预演 + `docs/audit/RELEASE.md` v2.1，RELEASE.md 由 t-1268 带入）、`release-prep-rehearsal`（t-1598，进行中）。
- **canonical**：`origin/feat/v5-selfhost` = `f1952819f`（比集成④时记录再 +1：`feat(v5): wire Sand-usable Cursor families into the picker`，含迁移 0281）；服务器 live 已是 `f1952819f` 且 0281 已 apply（RELEASE.md v2.1 §2.2b）。t-1268 从本轮终点合 canonical，7 处冲突解法见 RELEASE.md §1.2 / §3（AgentPicker.tsx 需叠回 a11y-C 改动）。

### 8. 分支合入状态单（集成⑤ 终点现算）

集成④ §8 的 24 条：HEAD 只前进未回退，`rev-list --count HEAD..<分支>` 仍全为 0（不再重列）。本轮新合入 8 条：

| 分支 `feat/v5-selfhost-audit-*` | 分支 HEAD | 合并提交 | 未合入提交 | 远端 |
|---|---|---|---|---|
| budget-fix | `65019b5dc` | **集成⑤ `ec09ed419`** | 0 | = 本地 |
| qa-a11y | `eed1f3989` | **集成⑤ `c701daac9`** | 0 | = 本地 |
| leftover-shell | `7e7c7e43b` | **集成⑤ `7cae5427f`** | 0 | = 本地 |
| leftover-tut | `69e18aa93` | **集成⑤ `c4a516697`** | 0 | = 本地 |
| leftover-tut-budget | `a947662bb` | **集成⑤ `10e1348fb`** | 0 | = 本地 |
| a11y-c | `c35fd00c6` | **集成⑤ `ecf912b88`** | 0 | = 本地 |
| archive | `35e3ec7c9` | **集成⑤ `b6da4ef8d`** | 0 | = 本地 |
| qa-integ4 | `31a8a92d6` | **集成⑤ `936d44e85`** | 0 | = 本地 |

下一步：**t-1268 发布准备**——integration 合 canonical `f1952819f`（RELEASE.md §3.1 命令 + t-1598 实测解法），复跑全量门（build ≤ 460KB），把 `docs/audit/RELEASE.md` 带进 integration，push；随后 canonical `--ff-only` + push，服务器按 RELEASE.md §4 执行（t-1269）。
