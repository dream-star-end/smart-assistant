# QA 复核五轮 · 归档摘要（t-1028 二期 P3 / t-1038 B 轮 P3 / t-1029 缺口补审 / t-1232 a11y-B + PermissionCard / t-1236 集成④ 终点）

> 正文：[`docs/audit/qa/QA-p3-tail.md`](../qa/QA-p3-tail.md)（t-1028）、[`docs/audit/qa/QA-b-p3.md`](../qa/QA-b-p3.md)（t-1038）、[`docs/audit/qa/qa-gap.md`](../qa/qa-gap.md)（t-1029），三支已随集成④ `4f93f6990` / `f605df89f` / `902ade6e8` 合入 integration；第四轮 t-1232 [`docs/audit/qa/QA-a11y.md`](../qa/QA-a11y.md)（分支 `feat/v5-selfhost-audit-qa-a11y@eed1f3989`）与第五轮 t-1236 [`docs/audit/qa/qa-integ4.md`](../qa/qa-integ4.md)（分支 `feat/v5-selfhost-audit-qa-integ4@31a8a92d6`）由集成⑤ `c701daac9` / `936d44e85` 合入（集成⑤ 任务 t-1237 在任务库尚未验收闭合，见 SUMMARY §4.3），见 §4 / §5。本文只做摘要与索引。
> 角色：测试 / QA「第二双眼睛」，对照被复核任务的验收标准逐项定位到 integration 代码行，复跑门禁，按 d-28 用截图台重出截图逐张看图；发现不合格项直接修（t-1029）或在任务书边界内移交（t-1038）。三轮核对态均为 integration `c034f05d7`（集成③ 6/6 之后、q-979 之后）。

## 1. t-1028 · 二期 P3 收尾复核（market2 t-625 / manage2 t-626 / sidebar2 t-627 / settings2 t-628）

| 任务 | 核对项 | ✅ | ❌ | 结论 |
|---|---|---|---|---|
| t-625 market2 | 10 条 P3 落地 + 3 条保持遗留 + 验证门 | 13 | 0 | 通过 |
| t-626 manage2 | §9 遗留 5 条处置 + X-03 + 验证门（`cronHuman` 另跑 23 组边界探针） | 6 | 0 | 通过 |
| t-627 sidebar2 | §6.2 遗留 6 条处置 + RepoPill 顺手项 + shell 接线闭环 + 验证门 | 7 | 0 | 通过 |
| t-628 settings2 | 遗留表 11 项处置（4 项落地）+ 验证门 | 11 | 0 | 通过 |

- ❌ 0；四条交付声称的代码 / 用例 / 场景在 integration HEAD 上全部存在且行为一致；biome 31 条诊断逐处 `git blame` 判定全部来自二期之前。
- 观察项 2（P3 nit，不改代码）→ 转 a11y-mod-a 已修（`beb48d930` / `4efc0fa35`）。
- 验证：四模块单测（manage 17 文件 / 214 例等）、typecheck、`typecheck:preview`、`test:browser`（`run.mjs` 68/68；`node --test` 70/73 基线）在合并后 integration 上复跑全绿；截图 45 场景 126 张。
- 分支 `feat/v5-selfhost-audit-qa-p3` @ `3e640a85d`（纯文档）。

## 2. t-1038 · B 轮 P3 修复交付复核（landing-B t-49 / media-B t-51 / tutorials-B t-53）

| | landing-B | media-B | tutorials-B |
|---|---|---|---|
| 修复记录 vs 代码 | 20 条 + X-01~03 逐条对上，**0 不符** | 27 条 + X-M1~M4 逐条对上，**1 不符**（M-23 性能半条文档写 ✅ 实为未做） | 37 条 + 追加①② 逐条对上，**0 不符** |
| P1 / P2 | P2 3/3 ✅ | P1 2/2 · P2 11/11 ✅ | P2 12/12 ✅ |
| 阶段 B 验证门复跑 | ✅ | ✅（含 `test:browser` T30） | ✅；`check:tutorials` 在核对态红 → q-1076 处置后 `b249317f4` 转绿 |
| 集成后回归 | 无 | 无 | 无 |

- 共 84 条修复记录核对；⚠ 3 项均已处置 / 有去向：① `check:tutorials` 红 → 集成③ q-1076 → A（`29a277b25` / `b249317f4`）；② landing L-11 遗留理由失效（可做了）→ 移交 t-895 附录 `6236dfb08`；③ media M-23 文档与代码不符 → `media.md` 勘误 + 移交 t-895 附录 `986f72b2f` / `85a7aea54`。
- 本轮代码改动 0（可动手的两个文件当时由 t-895 持锁）；文档改动 3（本文 + `landing.md` §7.1 备注 + `media.md` M-23 勘误与遗留补记）。
- 验证：三模块 vitest + typecheck / `typecheck:preview`、biome 对照基线、`test:browser`、`check:tutorials`（integration 与 tutorials 分支各一次）、截图 70 场景 258 张（看了 30 张关键图）。
- 分支 `feat/v5-selfhost-audit-qa-b-p3` @ `0ac949b2e`（`d1b2bbaa8` 报告 · `3cee09477` 按指挥官意见改写 `check:tutorials` 处置 · `0ac949b2e` 三项去向口径对齐）。

## 3. t-1029 · 缺口补审交付复核（hud t-836 / kp-automation t-838 / misc-p3 t-839 / 集成待办 t-865）

- 复核基线：`c034f05d7` + 三条专项分支干净合入（`0bdc40afc` / `fe35506a1` / `010b532ee`），工作树 `wt\qa-gap`。
- **核对 61 项：✅ 59 / ❌ 2，两处 ❌ 已在本分支修复并验证**：
  - ❌1 t-836：`typecheck:preview` 红 TS2353（`scenes-hud.tsx:199` 字面量多写 `estimated`；hud 交付只跑了 `typecheck`）→ `747596782` test(v5) 改 `LiveTurnTokenUsageSnapshot` 类型常量，运行时零变化，修后 0 错（taskboard TS2322 亦随集成③ 自消）。
  - ❌2 t-838 KP-14：`busyKey` 单值 + `if (busy) return`，切第一条时第二条开关看似可用但点击被静默丢弃 → `1db992620` refactor(v5) `busyKeys` 集合门控 + 用例补「第一条在飞时点第二条真的发请求」（修前 1 failed / 9 passed，修后 70/70）。
- t-839 12 项、t-865 9 项全 ✅：`MarkdownImpl` 记忆化闭包审读无陈旧依赖；t-865 各项（`allowImportingTsExtensions`、`USER_STATUS_LABEL.queued`、`AgentPicker` 展示名常量、`styles.css` caption token、`Sheet closeButton`、`MediaTaskCenter onReusePrompt`、TU-37 随 tutorials 合入）在 HEAD 逐项定位。
- 验证：typecheck ✅；`typecheck:preview` ✅（修后）；vitest HUD 4 文件 55 例 / KP 2 文件 70 例 / misc 8 文件 167 例（`MessageRenderer.test` 首跑 beforeAll 超时属 INTEGRATION §6 已知偶发，单跑 150/150）/ t-865 5 文件 115 例；biome 3 文件 0；`test:browser` `run.mjs` 68/68、`node --test` 70/73（基线）；截图 hud 40 + kp 56 + misc 24 = 120 张 failures 0，关键图逐张 Read。
- 已确认仍开放的遗留：H-18 `App.tsx:3745` `onStop` 一行接线（shell）、H-12 / H-20、D-02 余项 / D-08、OG-05 / OG-09。
- 分支 `feat/v5-selfhost-audit-qa-gap` @ `c1734aac6`（`747596782` `1db992620` 代码；`c06947a0c` `c1734aac6` 文档，含 §7「QA 直接修复」）。

## 4. t-1232 · a11y-B 三条 + PermissionCard 交付复核（t-893 / t-894 / t-895 / t-875）

- 复核态：integration `b23955208`（集成④ 12/12 之后），工作树 `wt\qa-a11y` 独立 `npm ci`；起稿 fable-5-1-23（permission-card 交付人，随名单换轮离队，报告未提交）→ **fable-5-1-35 接手**，§1–§3 file:line 全部按 HEAD 抽查复核、§4 permission-card 独立重做（利益申明：接手人未参与四条交付）。
- **核对 58 项：✅ 57 / ◐ 1 / ❌ 0，四条全部通过**：t-893 shell#1–11 11/11（`styles.css` token 行号、`ui/a11y.ts` / `Modal` / `Sheet` / `TimeAgo` / `Toast` 逐处定位）；t-894 14 + 计划外 1 + QA nit 2 = 17 → 16 ✅ / 1 ◐（计划外 SubmitBar「查看」只补 `min-h-11`，复扫 5 处仍 `38×44`）；t-895 10 + 顺手 1 + 附录 L-11 / M-23 = 13/13；t-875 PC-01…17 17/17（`permissionPopupCoordinator.ts` / `permissionReconcile.ts` 相对基线零 diff）。
- **QA 直接修 `77a93d9e1`**（`style(v5)`，4 文件 +27 −4）：① `PublishPanel` 「查看 / 收起」两钮 `[@media(hover:none)]:min-h-11 min-w-11 px-2`（`PublishPanel.test` K-21 用例补断言，修前红）；② `PermissionCard` `<summary>查看完整参数` `[@media(hover:none)]:py-3.5`（`PermissionCard.test` +1，71 例，修前红）。修后复扫 21 场景：`permission-card-settled` t44 6→0、`pending-modal` 1→0、`market-publish*` 4 场景各 1→0；其余指标与修前逐项相同。
- 验证：typecheck ✅、`typecheck:preview` ✅；全量 `npm test` 301/302 文件绿 4127 例（唯一红 `MessageRenderer.test` `beforeAll` 10s 冷启超时 = 基线抖动，单独 `--hookTimeout=60000` 复跑 152/152 绿 → 合计 302/302）；`test:browser` `run.mjs` 68/68、`node --test` 70/73（3 红与基线逐条相同：cc-switch ×2、ocv5-185 symlink EPERM）；截图 20 场景 74 张 failures 0，逐张 Read 9 张关键图；CDP 复扫 301 场景 0 渲染失败，共同 257 场景 vs t-893 after：cL 58→44、cD 81→69、t44 419→163、names 16→11、ax 3→1、tabBad 13→12，**逐场景回归 0**（a11y-mod-a / mod-b 修复在合入态量化成立）；`git merge-tree` 试合 integration `2d2b5cafc` 无冲突。
- 观察项 7 条（不阻断，QA 未越界改）：a11y-shell §5 同源项 12 处当时全部未落地 → 转 a11y-C（已处置，[a11y.md](./a11y.md) §6）；kp「从当前账号已加入的星球中选择」316×42、market `MyPublishes` 折叠钮 322×42（P3 nit，各归属 owner）；`RepoStatusBanner:85` 关闭钮 `opacity-70`（sidebar nit）；`ModelSelector` CostMark 深色 4.36 出现在禁用行（exempt）；读屏实机 NOT RUN 保持；建议集成⑤ 全量门沿用「全量 + `MessageRenderer.test` 单独 `--hookTimeout=60000` 复跑」两步口径。
- 分支 `feat/v5-selfhost-audit-qa-a11y` @ `eed1f3989`（`77a93d9e1` 代码 · `eed1f3989` 报告），远端 = 本地；集成⑤ 第 2 步 `c701daac9` 合入（5 files, +222/−4，零重叠）。

## 5. t-1236 · 集成④ 最终 HEAD `c97a750f8` 独立复核（含分工单 t-1512 → t-1567 三道门实跑、t-1524 截图抽样 + 状态单）

- 复核对象：integration 集成④ 终点 `c97a750f8`（源码态 `2d2b5cafc`），即 INTEGRATION.md 集成④ §5 / §7 / §8 登记的对象；工作树 `wt\qa-integ4`，分支 = `c97a750f8` + 报告一笔（不碰 integration / canonical）。
- 分工（指挥官 fable-5-1-4 01:12 口径，原执行人 fable-5-1-1 离线；报告 §0 已如实点出「任务书要求 QA 本人复跑三道门，实际由同组 QA 成员分工、各自留日志」）：三道门独立实跑 = fable-5-1-3 **t-1567**（代 t-1512，主克隆只读，01:15–01:26，`git status` 前后逐字一致）；截图抽样 + §8 状态单 = fable-5-1-3 **t-1524**；状态单二次复算 / source-only 登记核对 / 报告合成关单 = fable-5-1-6（t-1236）。
- **三道门 + 三道附加门与集成④ §5 登记逐条一致，新增红 0**：typecheck ✅ · `typecheck:preview` ✅ · `check:tutorials` ✅ 26 / 12 / 26 · vitest **302 文件 / 4279 例 / 0 失败**（`--maxWorkers=2` 376s，无 timeout / retry）· `test:browser` `run.mjs` 68 全过 + `node --test` 87 例 85 / 2（唯二红 = `cc-switch-ascii-name` ×2 基线；`ocv5-185-qa` ok）· `build` ❌ 471.4KB > 460.0KB（R1 已知红，8 个大块数值逐个相同，非新增）。对照：fable-5-1-1 00:53 在新建工作树 `node --test` 73 例 70/3，第 3 败 = `OCV5-185`（无 protocol junction 的环境项）。
- **§8 状态单 24/24 无漂移**（t-1524 与 t-1236 两次独立计算相同）：24 条文档 SHA `merge-base --is-ancestor c97a750f8` 全 0；23 条 tip == 文档 SHA 且 `rev-list --count` 0；唯一非 0 archive tip `35e3ec7c9` +1（纯文档，已登记）；24 条远端 == 本地。待集成⑤ 表复算：qa-a11y +2 · a11y-c `c35fd00c6` +18 · leftover-tut +3 · leftover-shell +6 · archive +1 · budget-fix +2 → 应合 6 条 / 32 提交；不合入 integ4-rehearsal +8、release-rehearsal（tip 前进到 `6aed3bddf`）。
- **截图抽样 13 场景 / 14 id / 52 张，新增阻断 0**（主克隆只读出图，`manifest` failures 0；52 张逐张 Read）：H-18 `onStop` 接线在 `hud-delegate-running` 生效；深色对比新增 0（K-1 `AgentPicker`「默认」徽章 4.11:1 / K-2 `RichBlocks` 勾标白字 2.82:1 / K-3 `OrgSubscribeDialog`「当前」徽章 2.82:1 = a11y-C 已修待合）；触控新增 0（K-4 PermissionCard summary / K-5 `ui/Checkbox` 20px = qa-a11y / leftover-shell 已修待合）；O-5 `workspace-chat-density` 390px 主列被挤是**场景构造问题**（`scenes-workspace.tsx:45` 把 `<Sidebar>` 行内固定并开 mobile 视口），非产品缺陷。
- source-only 登记核对：`tutorial-sync-history.jsonl` 69 条，第 67（q-1076 17 项 source-only）/ 68（t-1046 普通 accept）/ 69（q-1227 github-repository source-only，`identityChanged: []`）与集成③ §4 / 集成④ §4 逐条一致，入口身份变化 0。
- 问题清单：**P1 0 / P2 0 / P3 8**（K-1…K-5 已修待合 5 + O-1 hud 列表末行裁半行无渐隐 / O-2 permission-card 命令块 `break-all` 拆词 / O-3 Composer textarea 达 max-height 裁半行 观感 3，登记各 owner）+ 工具·场景项 2（O-4 kp 星球选择器 Popover 未入图 / O-5）+ 已知 2（B-1 首屏 gzip R1 = budget-fix；**B-2 集成⑤预演树 `b6b78e876` build 475.2KB，leftover-tut 把 `useAppRoute` chunk 1.7 → 30.7KB，集成⑤ 必修** → t-1575）。QA 直接修复 0。
- **结论：可进集成⑤，阻断项 0；集成⑤ 必带 budget-fix `65019b5dc`（B-1）+ t-1575（B-2），合入后 `build` 必须转绿；三笔教程 accept 随归档终稿交用户终审。**
- 产物（仓外 `.audit-tmp\qa-integ4\`）：`qa-integ4-report.md`、`t1567-summary.txt` + 六门日志 `t1567-*.log`、`shots\*.png` + `manifest.json` + `shots-review.md`、`status-check.md`、`ls-remote-heads.txt`。
- 分支 `feat/v5-selfhost-audit-qa-integ4` @ `31a8a92d6`（`c97a750f8` + 报告 1 笔），远端 = 本地；集成⑤ 第 8 步 `936d44e85` 合入（1 file, +153）。

## 6. 分支 / 集成

| 分支 | HEAD | 内容 | 集成 |
|---|---|---|---|
| `feat/v5-selfhost-audit-qa-p3` | `3e640a85d` | `qa/QA-p3-tail.md` | ✅ 集成④ `4f93f6990`（1 file, +125） |
| `feat/v5-selfhost-audit-qa-b-p3` | `0ac949b2e` | `qa/QA-b-p3.md` + `landing.md` / `media.md` 勘误 | ✅ 集成④ `f605df89f`（3 files, +242/−2；与 a11y-mod-b 同文件未冲突） |
| `feat/v5-selfhost-audit-qa-gap` | `c1734aac6` | `qa/qa-gap.md` + 2 处修复 + hud / kp-automation / misc-p3 三支合并 | ✅ 集成④ `902ade6e8`（4 files, +192/−41；`scenes-hud.tsx` 唯一冲突取 qa-gap 版本 `747596782`，指挥官 q-1227 预先指定） |
| `feat/v5-selfhost-audit-qa-a11y` | `eed1f3989` | `qa/QA-a11y.md` + 2 处 QA 修复 `77a93d9e1`（`PublishPanel` / `PermissionCard` 各 + test） | 集成⑤ 2/8 `c701daac9`（5 files, +222/−4；t-1237 任务未闭合，见 SUMMARY §4.3） |
| `feat/v5-selfhost-audit-qa-integ4` | `31a8a92d6` | `qa/qa-integ4.md`（t-1236；t-1512 / t-1524 / t-1567 分工产物在仓外 `.audit-tmp\qa-integ4\`） | 集成⑤ 8/8 `936d44e85`（1 file, +153；同上） |
