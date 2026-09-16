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
