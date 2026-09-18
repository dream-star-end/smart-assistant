# QA 复核三轮 · 归档摘要（t-1028 二期 P3 / t-1038 B 轮 P3 / t-1029 缺口补审）

> 正文：[`docs/audit/qa/QA-p3-tail.md`](../qa/QA-p3-tail.md)（t-1028）、[`docs/audit/qa/QA-b-p3.md`](../qa/QA-b-p3.md)（t-1038）、[`docs/audit/qa/qa-gap.md`](../qa/qa-gap.md)（t-1029），三支已随集成④ `4f93f6990` / `f605df89f` / `902ade6e8` 合入 integration；第四轮 t-1232 `docs/audit/qa/QA-a11y.md`（分支 `feat/v5-selfhost-audit-qa-a11y@eed1f3989`）待集成⑤，见 §4。本文只做摘要与索引。
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
- 分支 `feat/v5-selfhost-audit-qa-a11y` @ `eed1f3989`（`77a93d9e1` 代码 · `eed1f3989` 报告），远端 = 本地，待集成⑤（只带入 4 文件 + 报告）。

## 5. 分支 / 集成

| 分支 | HEAD | 内容 | 集成 |
|---|---|---|---|
| `feat/v5-selfhost-audit-qa-p3` | `3e640a85d` | `qa/QA-p3-tail.md` | ✅ 集成④ `4f93f6990`（1 file, +125） |
| `feat/v5-selfhost-audit-qa-b-p3` | `0ac949b2e` | `qa/QA-b-p3.md` + `landing.md` / `media.md` 勘误 | ✅ 集成④ `f605df89f`（3 files, +242/−2；与 a11y-mod-b 同文件未冲突） |
| `feat/v5-selfhost-audit-qa-gap` | `c1734aac6` | `qa/qa-gap.md` + 2 处修复 + hud / kp-automation / misc-p3 三支合并 | ✅ 集成④ `902ade6e8`（4 files, +192/−41；`scenes-hud.tsx` 唯一冲突取 qa-gap 版本 `747596782`，指挥官 q-1227 预先指定） |
| `feat/v5-selfhost-audit-qa-a11y` | `eed1f3989` | `qa/QA-a11y.md` + 2 处 QA 修复 `77a93d9e1`（`PublishPanel` / `PermissionCard` 各 + test） | 待集成⑤（+2，远端 = 本地） |
