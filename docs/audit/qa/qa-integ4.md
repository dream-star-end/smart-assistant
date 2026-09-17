# QA · 集成④ 最终 HEAD 独立复核（t-1236）

- 复核对象：integration 分支 `feat/v5-selfhost-ocv5-audit-ux` 最终 HEAD `c97a750f8`（源码态 `2d2b5cafc`，其后仅 docs 提交），即 `docs/audit/INTEGRATION.md` 集成④段落（§5 全量门 / §7 待办 / §8 状态单）登记的对象。
- 复核基线：工作树 `wt\qa-integ4`，分支 `feat/v5-selfhost-audit-qa-integ4` = `c97a750f8`（fable-5-1-1 建树并 `npm ci`；本报告是该分支相对 `c97a750f8` 的唯一改动，不碰 integration / canonical）。
- 角色：测试 / QA（第二双眼睛）。执行人分工（指挥官 fable-5-1-4 01:12 口径，原执行人 fable-5-1-1 离线）：三道门独立实跑 = fable-5-1-3（t-1567）；截图抽样 + §8 状态单 = fable-5-1-3（t-1524，主克隆只读）；§8 状态单二次复算、source-only 登记核对、报告合成与关单 = fable-5-1-6（本文作者）。角色与任务书打架处：任务书要求「QA 本人在复核工作树复跑三道门」，实际按指挥官安排由同组 QA 成员分工执行、各自留日志——此处点出，不隐去。
- **结论：可进集成⑤，阻断项 0。** 三道门在 `c97a750f8` 独立实跑与集成④ §5 登记逐条一致（typecheck ✅ / vitest 302 文件 · 4279 例 · 0 失败 ✅ / test:browser `run.mjs` 68 全过 + `node --test` 87 例 85/2，唯二红 = `cc-switch-ascii-name` ×2 基线；附加 typecheck:preview ✅、check:tutorials ✅；build ❌ 仅已知 R1 471.4KB > 460.0KB，数值逐个相同）；截图抽样 13 场景 / 52 张新增阻断 0；§8 状态单 24/24 与 git 事实一致；source-only 登记与 history 一致；P1 0 / P2 0。集成⑤必修：B-1 首屏 gzip（budget-fix `65019b5dc`）与 B-2 leftover-tut 引入的 `useAppRoute` chunk 膨胀（§6）。

## 0. 范围与被检 SHA

| 引用 | SHA | 说明 |
|---|---|---|
| integration HEAD（被检） | `c97a750f8` | `docs(v5): 集成④收尾 · INTEGRATION.md 集成④段落补全 …`（t-896） |
| integration 源码态 | `2d2b5cafc` | `chore(v5): tutorials 同步快照 source-only 接受 …（q-1227）`，其后到 `c97a750f8` 只有 docs |
| 复核分支 | `feat/v5-selfhost-audit-qa-integ4` @ `c97a750f8` + 本报告 | `wt\qa-integ4` |
| canonical（远端） | `feat/v5-selfhost` = `f1952819f` | 与 INTEGRATION.md §7「canonical 已前进」一致（t-1524 `ls-remote` 00:53） |

## 1. 方法与日志路径

| 项 | 执行人 / 任务 | 现场 | 日志 / 产物（均在仓库外 `D:\code\test_project\test123\.audit-tmp\qa-integ4\`，PNG 不入库） |
|---|---|---|---|
| 三道门：`typecheck` / `npm test`（web-react 全量）/ `test:browser`，附加 `typecheck:preview` / `check:tutorials` / `build` | fable-5-1-3 · t-1567（代 t-1512）· 01:15–01:26 | 主克隆 `v5-selfhost` @ `c97a750f8`，只读（`t1567-status-{before,after,after2}.txt` 逐字一致；`t1567-head.txt`） | `qa-integ4-report.md`（汇总）、`t1567-summary.txt`（每门 exit + 耗时）、`t1567-typecheck.log`、`t1567-typecheck-preview.log`、`t1567-vitest-full.log`、`t1567-test-browser.log`、`t1567-check-tutorials.log`、`t1567-build.log`；对照：fable-5-1-1 在 `wt\qa-integ4` 00:53 的 `test-browser.log` / `typecheck.log` |
| ui-preview 截图抽样（13 场景 / 14 id / 52 张） | fable-5-1-3 · t-1524 | 主克隆 `v5-selfhost` @ `c97a750f8`，只读（`git status --porcelain` 前后一致） | `shots\*.png` + `manifest.json`、`shoot.log`、`shots-review.md`、`qa-integ4-status-{before,after}.txt` |
| §8 状态单 24 条 + 待集成⑤ 8 条复算 | fable-5-1-3 · t-1524 | 主克隆，只读 git 查询；远端以 `git ls-remote --heads origin`（00:53，437 refs）为准 | `status-check.md`、`ls-remote-heads.txt` |
| §8 状态单二次复算（独立于 t-1524） | fable-5-1-6 · t-1236 | `wt\qa-integ4` @ `c97a750f8`，01:3x | 见 §3（命令与逐条结果就地列出） |
| source-only accept 登记核对（q-1076 / q-1227） | fable-5-1-6 · t-1236 | `wt\qa-integ4` `packages/web-react/tutorial-sync-history.jsonl` | 见 §5 |

## 2. 三道门结果（独立实跑 · t-1567）

执行：fable-5-1-3（t-1567）在主克隆 `c97a750f8` 只读实跑，源码态与集成④登记的 `2d2b5cafc` 相同（其后仅 docs 提交）。「集成④ 登记」列摘自 INTEGRATION.md §5 与「收尾复跑」表。本文作者抽核了 `t1567-summary.txt`（六门 exit / 耗时）、`t1567-vitest-full.log` 尾部（`Test Files 302 passed (302)` / `Tests 4279 passed (4279)` / `EXIT=0`）、`t1567-test-browser.log`（`browser-tests: 68 全过(清单 68 条全部执行)`；`# tests 87 / # pass 85 / # fail 2`；唯一 `not ok 1 - CC Switch ASCII provider name …`）、`t1567-build.log`（`first-screen-budget … gzip 471.4KB 超过预算 460.0KB`），与报告数字一致。

| 门 | 命令（cwd） | 集成④ 登记（`2d2b5cafc`） | 复核实跑（t-1567，`c97a750f8`） | 一致？ / 差异解释 |
|---|---|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react`（仓库根） | ✅ exit 0 | ✅ exit 0（2s，`tsc -b` 增量缓存命中，非跳过；`t1567-typecheck.log`） | **一致** |
| 预览台类型检查（附加） | `npm run typecheck:preview --workspace packages/web-react` | ✅ exit 0（40s） | ✅ exit 0（30s，无缓存；`t1567-typecheck-preview.log`） | **一致** |
| 教程门禁（附加） | `npm run check:tutorials` | ✅ OK · 26 capabilities · 12 cases · 26 media pairs | ✅ OK · 26 · 12 · 26 · 2390809 B（`t1567-check-tutorials.log`） | **一致** |
| web-react 全量单测 | `npx vitest run --maxWorkers=2`（`packages\web-react`） | ✅ 302 文件 / 4279 例 / 0 失败（三次，`--maxWorkers=1`，683–901s） | ✅ **302 passed / 4279 passed / 0 failed**，无 timeout / retry（376s；`t1567-vitest-full.log`） | **一致**（文件数 / 用例数逐数相同；耗时差异只来自并发度） |
| 真浏览器门 | `$env:OC_E2E_BROWSER='…chrome.exe'; npm run test:browser`（仓库根） | `run.mjs` T1–T68 全 ok；`node --test` 87 例 85 过 / 2 失败 = `cc-switch-ascii-name` ×2（基线）；`ocv5-185-qa` 15/15 | `run.mjs` **68 全过（清单 68 条全部执行）**；`node --test` **87 例 85 / 2**，`not ok 1 - CC Switch ASCII provider name from real ApiKeysSection`（子测 `new key` / `existing key` = `cc-switch-ascii-name` ×2）；`ocv5-185-qa` ok（143s；`t1567-test-browser.log`） | **一致**。对照：fable-5-1-1 00:53 在新建 `wt\qa-integ4` 跑出 73 例 70/3，第 3 败 = `OCV5-185`（新工作树无 `@openclaude/protocol` junction，INTEGRATION §6 已登记的环境项），与代码无关 |
| 首屏 gzip 预算（附加，任务书 §6a 只登记） | `npm run build --workspace packages/web-react`（`tsc -b && vite build`） | ❌ 471.4KB > 460.0KB，15 chunk：main 139.4 / tapePayload 125.5 / styles 75.1 / react-vendor 55.3 / radix-vendor 29.9 / media 17.7 / lucide-vendor 17.7 / viewport-shared 2.9 | ❌ exit 1：`tsc -b` 绿 → rolldown-vite 5103 modules → `first-screen-budget` 拦下 **471.4KB > 460.0KB**，8 个大块数值逐个相同（`t1567-build.log`） | **一致**（R1 已知红复现，非新增；budget-fix `65019b5dc` 待集成⑤） |

红门登记（任务书 §3 口径）：① `cc-switch-ascii-name` ×2 —— 用例 `CC Switch ASCII provider name from real ApiKeysSection`（`new key` / `existing key`）；错误 = 「还没有 API Key」10s 超时 + 模型 id 断言 `gemini-3.8-flash` vs `sonnet-5`；可复现（集成①②③④ 四轮 + 本轮两次运行均同）；归因 = settings `ApiKeysSection` 契约基线，不属于集成④任一合入。② `build` R1 —— 归因 = 集成②起累计首屏体积，t-1348 已修。**新增红 0。** 未跑（任务书三道门不含）：biome lint、ui-preview 全量 301 场景、a11y 全量复扫 —— 均有集成④ §5 记录 + t-1524 / t-1344 侧面证据。

## 3. §8 状态单核对（24/24）

**t-1524（主克隆，00:52）与本文作者（`wt\qa-integ4`，01:3x）两次独立计算结果相同：24 条文档 SHA 全部 `git merge-base --is-ancestor <docSha> c97a750f8` exit 0；23 条分支 tip == 文档 SHA 且 `git rev-list --count c97a750f8..<分支> = 0`；唯一非 0 是 archive（tip `35e3ec7c9`，+1，纯文档，§8 原文已登记「待集成⑤」）；t-1524 另核 24 条远端 SHA（`ls-remote`）== 本地 tip。与 INTEGRATION.md 集成④ §8 一致，无漂移。**

| # | 分支 `feat/v5-selfhost-audit-*` | §8 文档 SHA | is-ancestor(doc) | 本地 tip | `rev-list c97a750f8..tip` | 远端 == 本地（t-1524） |
|---|---|---|---|---|---|---|
| 1 | shell | `39697560b` | 0 | `39697560b` | 0 | ✅ |
| 2 | sidebar | `25c775295` | 0 | `25c775295` | 0 | ✅ |
| 3 | tools | `d65c6741e` | 0 | `d65c6741e` | 0 | ✅ |
| 4 | landing | `b97adb3fb` | 0 | `b97adb3fb` | 0 | ✅ |
| 5 | media | `8834aca08` | 0 | `8834aca08` | 0 | ✅ |
| 6 | composer | `70d3db8b3` | 0 | `70d3db8b3` | 0 | ✅ |
| 7 | settings | `5eac1b807` | 0 | `5eac1b807` | 0 | ✅ |
| 8 | messages | `2abe389a9` | 0 | `2abe389a9` | 0 | ✅ |
| 9 | taskboard | `05dd185df` | 0 | `05dd185df` | 0 | ✅ |
| 10 | manage | `6fae01440` | 0 | `6fae01440` | 0 | ✅ |
| 11 | market | `5391c150a` | 0 | `5391c150a` | 0 | ✅ |
| 12 | tutorials | `02c358655` | 0 | `02c358655` | 0 | ✅ |
| 13 | hud | `b1f06f8f5` | 0 | `b1f06f8f5` | 0 | ✅ |
| 14 | kp-automation | `b0fd16dad` | 0 | `b0fd16dad` | 0 | ✅ |
| 15 | misc-p3 | `c834dffa1` | 0 | `c834dffa1` | 0 | ✅ |
| 16 | permission-card | `8a3179896` | 0 | `8a3179896` | 0 | ✅ |
| 17 | a11y-shell | `4930707cc` | 0 | `4930707cc` | 0 | ✅ |
| 18 | a11y-mod-a | `475e3e6c7` | 0 | `475e3e6c7` | 0 | ✅ |
| 19 | a11y-mod-b | `9710a3b24` | 0 | `9710a3b24` | 0 | ✅ |
| 20 | tut-sync-2 | `67b1494ea` | 0 | `67b1494ea` | 0 | ✅ |
| 21 | qa-gap | `c1734aac6` | 0 | `c1734aac6` | 0 | ✅ |
| 22 | qa-p3 | `3e640a85d` | 0 | `3e640a85d` | 0 | ✅ |
| 23 | qa-b-p3 | `0ac949b2e` | 0 | `0ac949b2e` | 0 | ✅ |
| 24 | archive | `a38a093bf` | 0 | `35e3ec7c9` | **1**（`35e3ec7c9` 纯文档，待集成⑤） | ✅ |

合入提交双亲：§8 所列集成④ 12 个合并提交（`2c1d659d2` hud … `b23955208` archive）均在 `c97a750f8` 祖先链内（上表 is-ancestor 为其充分条件：各分支 tip 可达 ⇒ 合并提交可达）。

**待集成⑤ 表（t-1524 现算，`c97a750f8..tip`）**：qa-a11y `eed1f3989` +2 · a11y-c tip **`c35fd00c6`** +18（已推远端；代码 HEAD 仍 `12275f27a`，比 §8 原表多 3 条纯文档 `361f59b1f` / `ea9348b2b` / `c35fd00c6`）· leftover-tut `69e18aa93` +3 · leftover-shell `7e7c7e43b` +6 · archive `35e3ec7c9` +1 · budget-fix `65019b5dc` +2（§8 原表未列，t-1348）→ 应合 6 条 / 32 提交（a11y-c 的 18 里含 5 条把已合入集成④分支 `--no-ff` 预合进 a11y-c 基线的合并提交，合入 integration 应零冲突）。**不合入**：integ4-rehearsal `522c24988` +8（远端无）、release-rehearsal tip 前进到 `6aed3bddf` +14（已推，预演分支）。integration 本地 `c97a750f8` == 远端。

## 4. 抽样截图结论（13 场景 / 14 id / 52 张 · t-1524）

- 出图：主克隆 `c97a750f8`，`OC_UI_SCENES` 指定 13 个精确 id，desktop 1440×900@2x / mobile 390×844@2x × light / dark；`manifest.json` failures 0、retried 0、unmockedApi []。52 张全部用 Read 工具逐张看过，按 PLAYBOOK §5：破版 / 390px 横向溢出 / 深色对比 / 触控 ≥44 / 焦点可见（截图台无焦点态，以 a11y 复扫为准）。像素判读拿不准的对比度全部回到 `c97a750f8` 源码 grep 核实。覆盖：集成④新增面 hud ×2 / kp-automation ×2 / misc-p3 ×1 / permission-card ×2 + a11y 改动面 composer ×2 / settings ×1 / org ×1 / workspace-chat ×1 / market ×1。

| # | 场景 id | 覆盖 | 结论 |
|---|---|---|---|
| 1 | `composer-loaded` | composer / tut-sync-2 | ✅ 无破版 / 无溢出；O-3 textarea 到 max-height 底边裁半行 |
| 2 | `composer-agent-picker` | tut-sync-2 AgentPicker | ✅ 布局；K-1「默认」徽章深色 4.11:1（a11y-c 已修待合）；K-5 复选框 <44（leftover-shell K-27 待合） |
| 3 | `hud-task-expanded` | hud | ✅ 无溢出；O-1 移动端列表 max-height 裁半行无渐隐 |
| 4 | `hud-delegate-running` | hud H-18 `onStop` 接线 | ✅ **H-18 生效**（wsSending 时「停止本轮」在位）；O-1 同上 |
| 5 | `kp-automation-list` | kp-automation | ✅ 全部通过（三色 soft 徽章深色可读、操作行 ≥44） |
| 6 | `kp-automation-new-picker` | kp-automation | ✅ 弹层本体通过；O-4（工具项）星球选择器 Popover 未入图 |
| 7 | `misc-options-partial` | misc-p3 optionsGroup / RichBlocks | ✅ 布局；K-2 深色已选项 ✓ 白字压 `#9a8aff` 2.82:1（`RichBlocks.tsx` HEAD 仍 `text-white`，a11y-c `59e66773f` 待合） |
| 8 | `permission-card-pending-modal` | permission-card | ✅ 布局 / 对比（允许键 `-fg` ✓）；K-4 移动端「查看完整参数」summary <44（qa-a11y `77a93d9e1` 待合） |
| 9 | `permission-card-multi-pending-cards` | permission-card-2 并发未决 | ✅ 无溢出；O-2 移动端命令块 `break-all` 拆词 |
| 10 | `settings-subscription-dialog` | a11y-shell #1 `-fg` | ✅ 全部通过（shell#1 修复在集成④已生效） |
| 11 | `org-subscribe-dialog` | org（a11y-mod-a） | ✅ 布局；K-3 深色「当前」徽章 `bg-accent text-white` 2.82:1（`OrgSubscribeDialog.tsx:173` 源码核实，a11y-c `b591e64b6` 待合） |
| 12 | `workspace-chat-density` | shell / sidebar / tools 密度 | ⚠ O-5 **场景构造问题非产品缺陷**：`scenes-workspace.tsx:45` 把 `<Sidebar>` 行内固定进 `flex h-screen` 且声明 mobile 视口，390px 主列被挤到 ~100px；真实 App 壳移动端走 Sheet 抽屉 |
| 13 | `market-review-detail` / `-mobile` | market（qa-b-p3） | ✅ 无溢出；禁用态低对比为全站例外（a11y-c §1 #12 已登记不修）；K-5 复选框 20px |

PLAYBOOK §5 五项汇总：破版 产品侧 0（O-5 为场景构造）；390px 横向溢出 0；深色对比 新增 0（K-1/K-2/K-3 均 a11y-c 已修待合）；触控 新增 0（K-4/K-5 均已修待合）；焦点可见 不评（以 `.audit-tmp\a11y-c\t1344-scan` 288 场景 tabBad 无回归为准）。**与 INTEGRATION.md §5「ui-preview 全量截图」收尾抽样 14 张的结论一致（唯一肉眼残留 = `shell#1` 深色 `text-white` ×3 + org「当前」徽章，即 K-2 / K-3）。**

## 5. source-only accept 登记核对（q-1076 / q-1227）

`packages/web-react/tutorial-sync-history.jsonl` 共 **69 条**，与 INTEGRATION.md 集成③ §4 / 集成④ §4 的登记逐条对上：

| history 序号 | mode | 内容 | 登记处 | 一致？ |
|---|---|---|---|---|
| 67（2026-09-16T17:10Z） | `source-only` | 17 项（advisor-mode / agents / billing-usage / chat-basics / … / voice-input）「v5 个人版审计 B 阶段 UI/UX 修复致功能源漂移」，指挥官 fable-5-1-18 代确认（q-988 / q-1076），待用户终审 | 集成③ §4 | ✅ |
| 68（2026-09-16T17:53Z，actor fable-5-1-17） | `tutorial-sync`（普通 accept） | agents（v4→v5）/ chat-basics（v8→v9）正文补写 + 两处 `data-product-feature` 恢复（t-1046 tut-sync-2） | 集成③ §4 收口 / 集成④ §4 | ✅ |
| 69（2026-09-16T18:28Z） | `source-only` | `github-repository` 1 项「集成④ a11y 修复致功能源漂移，正文与媒体未变，抄检一致；由指挥官 fable-5-1-18 代用户确认（q-1227），待用户终审」；`identityChanged: []` | 集成④ §4（提交 `2d2b5cafc`） | ✅ |

入口身份变化本轮 0（第 69 条 `identityChanged` 为空，符合 q-1227「若出现必须再开卡」）。三笔 accept 均标「待用户终审」，归档终稿 t-897 的终审导读需同时列出（INTEGRATION.md §4 末段已写）。

## 6. 基线红核对（三条基线未新增）

| 项 | 集成④ 登记 | 复核（t-1567） | 结论 |
|---|---|---|---|
| `cc-switch-ascii-name.node-test.mjs` ×2（「还没有 API Key」10s 超时 + 模型 id `gemini-3.8-flash` vs `sonnet-5`） | 基线，集成①②③④ 逐条相同 | 复现同一对（`not ok 1` 子测 ×2），无其它 `not ok` | 基线未新增 ✅ |
| `ocv5-185-qa.node-test.mjs`（需干净工作树 + protocol junction） | 环境项，集成④ 15/15 ✅ | 主克隆 ok；fable-5-1-1 新建工作树 1 败（无 junction） | 环境项，与代码无关 ✅ |
| `MessageRenderer.test` `beforeAll` / `App.test` 15s 超时 | 负载偶发，集成④三次全量未复现 | 本轮全量 4279 例无 timeout / retry 记录 | 未复现 ✅ |
| `npm run build` 首屏 gzip 预算 | ❌ 471.4KB > 460.0KB（已知红，t-1348 `77e1f35dc` 修到 445.5KB，随集成⑤） | ❌ 471.4KB > 460.0KB，8 个大块数值逐个相同 | 已知红复现、非新增；集成⑤ `build` 必须转绿 |

**集成⑤新事实（指挥官 fable-5-1-4 01:2x，供 t-1237 用，与本被检 HEAD 无关）**：集成⑤预演树 `b6b78e876` `npm run build` 红 **475.2KB**，二分归因到 leftover-tut `69e18aa93`（TU-17 深链）把 `useAppRoute` chunk 从 1.7KB 撑到 30.7KB gzip；集成④ `c97a750f8` 本身不含该分支，但集成⑤合入 leftover-tut 后即使带上 budget-fix（445.5KB）也需再修，**集成⑤必修项**。

## 7. 问题清单

| 编号 | 位置 | 现象 | 严重度 | 处置 |
|---|---|---|---|---|
| K-1 | `AgentPicker.tsx:148`（深色） | 「默认」徽章 `bg-accent/15 text-accent` 4.11:1 | P3 对比度 | 已修待合：a11y-c `abb246fdb` → `faa6e8b26` |
| K-2 | `RichBlocks.tsx:256/274`（深色） | 已选项 ✓ / 「确认选择」白字压 `#9a8aff` 2.82:1 | P3 对比度 | 已修待合：a11y-c `59e66773f` |
| K-3 | `OrgSubscribeDialog.tsx:173`（深色） | 「当前」徽章 `bg-accent text-white` 2.82:1 | P3 对比度 | 已修待合：a11y-c `b591e64b6` |
| K-4 | PermissionCard「查看完整参数」summary（移动） | 触屏行高 <44 | P3 触控 | 已修待合：qa-a11y `77a93d9e1` |
| K-5 | `ui/Checkbox` 原语（market 全选 / 行复选框、AgentPicker「同时作为新会话默认」） | 20px 命中区 <44 | P3 触控 | 已修待合：leftover-shell K-27 |
| O-1 | hud `PinnedTaskTracker` / `PinnedDelegateTracker` 列表（移动端；桌面 delegate 第 5 行同） | 到 max-height 后末行裁半行、无渐隐 / 滚动提示（H-17 渐隐在长列表场景生效，此处未触发？需 owner 核） | P3 观感 | 登记，hud owner 定夺（建议 8–12px 渐隐遮罩或整行吸附） |
| O-2 | permission-card 命令块（移动端） | `break-all` 把 `diff` 拆成 `d\|iff` | P3 观感 | 登记，permission-card owner（建议 `overflow-wrap:anywhere` 优先空格断） |
| O-3 | `Composer` textarea（桌面 / 移动） | 达 max-height 时底边裁半行字 | P3 观感 | 登记，composer owner（底部内边距或渐隐） |
| O-4 | `scenes-kp-automation.tsx` `kp-automation-new-picker` | 星球选择器 Popover 未入图 | 工具项（非产品） | 登记，场景加 clip 覆盖或 shoot.mjs 放宽裁切 |
| O-5 | `scenes-workspace.tsx:45,86` `workspace-chat-density` | 场景把 `<Sidebar>` 行内固定并开 mobile 视口，390px 主列被挤成 ~100px | 场景构造问题（非产品缺陷） | 登记，场景改 `viewports: ['desktop']` 或换 App 壳组合 |
| B-1 | `packages/web-react` `npm run build` | 首屏 gzip 471.4KB > 460.0KB | 已知红（任务书 §6a） | t-1348 `65019b5dc`（445.5KB）随集成⑤ |
| B-2 | 集成⑤预演树 `b6b78e876`（含 leftover-tut `69e18aa93`） | build 475.2KB，`useAppRoute` chunk 1.7→30.7KB gzip | 集成⑤阻断（非集成④） | t-1237 / leftover-tut owner 必修 |

统计：**新增阻断 0**；P1 0 / P2 0 / P3 8（K-1…K-5 已修待合 5 + O-1…O-3 观感 3）/ 工具·场景项 2（O-4 / O-5）/ 已知与集成⑤登记 2（B-1 / B-2）。QA 直接修复 0（本轮无一行级小修需求，未改业务代码）。

## 8. 结论

**可进集成⑤，阻断项 0。** 依据：§2 三道门（+ 三道附加门）在 `c97a750f8` 独立实跑与集成④ §5 登记逐条一致，新增红 0（唯二红 = `cc-switch-ascii-name` ×2 基线；build R1 已知红数值相同）；§3 状态单 24/24 无漂移（两次独立计算）；§4 截图抽样 52 张新增阻断 0、与集成④收尾抽样一致；§5 source-only 登记与 history 一致、入口身份变化 0；§6 三条基线红未新增；§7 P1 0 / P2 0。**集成⑤（t-1237）必带**：budget-fix `65019b5dc`（B-1）+ 对 leftover-tut `69e18aa93` 引入的 `useAppRoute` chunk 膨胀再修一处（B-2，指挥官二分归因，预演树 475.2KB），合入后 `npm run build` 必须转绿；三笔教程 accept（history 67 / 68 / 69）随归档终稿交用户终审。

## 9. 验证（本文作者本轮实际跑过）

| 项 | 命令（`wt\qa-integ4`） | 结果 |
|---|---|---|
| §8 状态单二次复算 | 24 组 `git merge-base --is-ancestor <docSha> c97a750f8`；`git rev-parse --short=9 feat/v5-selfhost-audit-<slug>`；`git rev-list --count c97a750f8..feat/v5-selfhost-audit-<slug>` | ✅ 24/24 exit 0；23 条 tip == 文档 SHA 且 0；archive tip `35e3ec7c9` / 1 |
| source-only 登记 | 读 `packages/web-react/tutorial-sync-history.jsonl`（69 条），核第 67 / 68 / 69 条 mode / note / identityChanged | ✅ 与集成③ §4、集成④ §4 一致 |
| 复核分支状态 | `git status --short`；`git branch --show-current` | 仅 `packages/cli/src/index.ts`、`packages/mcp-memory/src/index.ts` 两处 CRLF 假改动（PLAYBOOK §7，不 add）；分支 `feat/v5-selfhost-audit-qa-integ4` @ `c97a750f8` |

**NOT RUN（本文作者）**：三道门（由 fable-5-1-3 t-1567 在其现场实跑，§2 引用其日志）；ui-preview 出图（由 t-1524 实跑，§4 引用其产物）；`npm run build`（任务书 §6a 已知红只登记）。
