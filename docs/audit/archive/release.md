# 集成⑤预演 + 发布线 · 归档摘要（t-1503 / t-1279 / t-1598 / t-1455 已完成；t-1237 / t-1268 / t-1269 预留）

> 正文：[`docs/audit/RELEASE.md`](../RELEASE.md)（发布预演 + 运行手册，v2.2，t-1279 → t-1598 → t-1268 逐轮更新，随 integration `aeae1d72e` 带入）、[`docs/audit/INTEGRATION.md`](../INTEGRATION.md) 集成⑤段（t-1237，含 t-1503 预演与 t-1575 归因）。本文只做摘要与索引；**发布线三条任务（集成⑤ t-1237 / 发布准备 t-1268 / 发布执行 t-1269）在任务库尚未验收闭合**（09-18 20:49 账本：integ5 在跑、release-prep / release-deploy 阻塞、集成⑤ 全量门下半场 integ5-gate2 阻塞），§5–§7 只登记 `git` 可核的事实并留 TODO 字段，验收结论在归档阶段②填。
> 口径：预演分支一律**不合入** integration（结论以文档形式带入）；不可逆动作（push canonical、服务器 `--deploy`）按 d-1326 / d-1450 / d-1603 由指挥官代批；红线：个人版 `openclaude.service` / 18789 / Redis db0 不碰、不 force-push、d-26 禁 `fix(v5)`。

## 1. t-1279 · 发布预演 + 运行手册（fable-5-1-34 初稿 → fable-5-1-4 v2 / v2.1）

| 项 | 结论 |
|---|---|
| 初稿（09-17 04:xx，`feat/v5-selfhost-audit-release-rehearsal@c1fdc935e`） | canonical `feat/v5-selfhost@3b7c38b9d`（基线 `210b99678` 之后上游 6 提交：OCV5-220 顾问卡 / OCV5-223 Codex 1M 双胞胎）试合 integration 集成④ 源码态 `2d2b5cafc`：**7 处冲突**——4 个源码文件（`AgentPicker.tsx` / `tool/bodies.tsx` / `tool/bodyCards.test.tsx` / `tool/meta.ts`，取 canonical 语义、保留审计侧 `ui/Select` 等改动）+ 3 个 `tutorial-sync*` 生成物（`--ours` 后重新 accept），解法落地 `d02cc7c5d`；R2 canonical 自带 8 处旧测试文案漂移 → `c1fdc935e` 对齐（发布准备时 cherry-pick）；R3 canonical 侧 `check-v5-incident-regressions.ts` FAIL（proofPending 缺失，不阻断 selfhost `--deploy`）；R1 `build` ❌ 471.7KB（无 budget-fix） |
| v2（09-18 00:3x–01:0x） | canonical 又前进到 **`f1952819f`**（OCV5-225，含 DB 迁移 `0281_cursor_sand_usable_families.sql` + `ALTER … DROP CONSTRAINT` 破坏性 DDL）→ 追合 `c009a1c04` 零冲突（9 文件 +673/−18）；预合 budget-fix `65019b5dc` → `f6572abb6` **`build` ✅ 447.3KB / 余量 12.7KB**，无 budget-fix 对照 `c009a1c04` ❌ 471.9KB（「集成⑤ 不合 budget-fix 就发，服务器必死在 `build_master_release`」）；全门复跑（§1.3b）：typecheck / preview / `check:tutorials` / `lint:migration-order`（283 支 · requiredMigrations 161 条）/ `test:protocol` engineModels 14/14 / vitest 9 文件 295 例 / build / trailer 门 PASS 全绿；`cursorCliWrapper.test.ts` 55/57 为 Windows 假阳性（R9） |
| v2.1 服务器只读实测（09-18 00:56，`ssh -o BatchMode=yes root@38.55.252.217`，只 status / readlink / systemctl / curl / df / SELECT / `--status`） | 现网 live **已是 `rel-f1952819f-20260917-082520`**（`.complete.sourceCommit` = `f1952819f`，boss 09-17 08:25Z 人工 train，此前 4 次失败），工作树 HEAD = `f1952819f` 且干净；`schema_migrations` 已含 0280 / 0281，三条前置模型行 active+enabled → 本次发布迁移门预期 **`HAS_MIGRATION=0`，不需 `OC_V5_ALLOW_BREAKING_MIGRATION=1`**（只在回滚到 `rel-3b7c38b9d` 后再发或 canonical 再带迁移时复议）；磁盘 `/` 87%、余 26.6 GiB（≥ 8 GiB 门 S10 过）；master / egress slotA / 个人版全 active，18790 与 18789 `healthz` 200，无 open train。追平 integration `c97a750f8` → `31c3e15c3`（v2.1），分支 tip `a4452c7b6` |
| 手册结构（RELEASE.md） | §0 结论速览 R0–R9 → §1 预演与冲突解法 → §2 发布前置清单（代码侧 C1–C11、服务器侧硬门 S1–S14 + §2.2b 实测表、需服务器 / 用户的 U 项）→ §3 本地步骤（integration 合 canonical → 复跑门 → canonical `--ff-only` + push）→ §4 服务器命令序列（§4.0 就位与前值 → `--status` / `--smoke` 前值 → `--deploy --dry-run` → `--deploy` → `--smoke` / `--status` 后值 → §4.8 功能验证）→ §5 回滚（自动补偿 / 手动回 `rel-*` / 失败矩阵）→ §6 发布记录模板 → 附录 A–D |
| 边界 | 未推 canonical、未动 integration、服务器只读；试合只在预演分支。**不合入**（结论已由 v2.2 / t-1268 带进 RELEASE.md） |

- 产物（仓外 `.audit-tmp\release-rehearsal\`）：`merge-canonical*.log`、`gates-head-2\`、`measure-first-screen.mjs`（首屏体量复算脚本，同 vite 插件口径）、`jqbin\jq.exe`（trailer 门用）、服务器只读实测原始输出（附录 C）。

## 2. t-1503 · 集成⑤预演（fable-5-1-2，`feat/v5-selfhost-audit-integ5-rehearsal@b6b78e876`）

- 从集成④ 终点 `c97a750f8` 以 `rehearsal:` 合并试合 6 条待合分支（budget-fix → qa-a11y → leftover-shell → leftover-tut → a11y-c → archive）：合并点 `c1ef51a44` / `537595a1e` / `b6c56be2d` / `586131c42` / `6952c72ff` / `b6b78e876`；唯一冲突 `RichBlocks.test.tsx`（leftover-shell D-08 用例 ↔ a11y-C `text-accent-fg` 用例同位）→ 两条全保留，**集成⑤ 正式合入沿用同一解法**。
- 门：typecheck ✅；**`build` ❌ 475.2KB > 460.0KB**（budget-fix 单独 445.5KB）→ 指挥官逐合并点二分归因到 leftover-tut（`useAppRoute` chunk 1.7 → 30.7KB），立 **t-1575** 修复（[leftover.md](./leftover.md) §4）；纯预演树上 `check:tutorials` 报 `agents / billing-usage` 功能源漂移（与 t-1575 无关，集成⑤ 以 source-only accept 处置）。
- 分支未推远端、**不合入**；作用 = 给集成⑤ 提供合入顺序、冲突解法与首屏红的数值。产物 `.audit-tmp\release-rehearsal\bisect-integ5-first-screen.ps1`、`integ5-bisect\SUMMARY.txt`、`.audit-tmp\leftover-tut-budget\check-tutorials-pure-b6b78e876.log`。

## 3. t-1598 · 发布准备预演（fable-5-1-6，`feat/v5-selfhost-audit-release-prep-rehearsal@e75749dd0`，RELEASE.md v2.2 §3.1b）

- 现场 `wt\release-prep-rehearsal`：基点 `b6b78e876`（t-1503 预演树）+ t-1575 `a947662bb` + qa-integ4 `31a8a92d6` = **集成⑤预期树 `fc5c4f075`**（两次合入零冲突）→ `886afb00e` source-only accept `agents,billing-usage` → **`b96cb194f`** 试合 canonical `f1952819f`（parents `886afb00e` / `f1952819f`；**正式 release-prep 重放 `git checkout b96cb194f -- <4 文件>` 取此 SHA**）→ `addb87bd1` cherry-pick R2 `c1fdc935e` → 手册 v2.2 docs。
- 冲突集合与 t-1279 §1.2 **完全相同的 7 个路径**，无新增；两处口径变化：① `AgentPicker.tsx` 在集成⑤树上已叠 a11y-C「默认」徽章 3 行，解法从 `d02cc7c5d` 改为 `b96cb194f`（`git diff d02cc7c5d b96cb194f -- AgentPicker.tsx` = 仅那 3 行）；② **教程门两段式**——集成⑤树自身的 `agents / billing-usage` 功能源漂移必须在合 canonical **之前**用 `--source-only --ids agents,billing-usage` 接受（history 第 70 条），再合 canonical 只剩 `advisor-mode` 漂移用普通 accept（第 71 条）；合并树上一次 accept 两种模式都过不了（实测被拦 → `merge --abort` 重做）。
- 门（HEAD `addb87bd1`，`.audit-tmp\release-prep-rehearsal\run-gates.ps1` / `gates\SUMMARY.txt`）：typecheck ✅ 53s · preview ✅ 20s · `check:tutorials` ✅ 26 / 12 / 26 · `lint:migration-order` ✅ 283 支 · 161 条 · `test:protocol` 14/14 · vitest **27 文件 547 例** ✅ 147s · `build` ✅ 21.96s · 首屏 **13 chunk gzip 448.3KB（459061 B）≤ 460.0KB，余量 11.7KB**（比 v2 447.3KB 多 1.0KB = 集成⑤ 6 条 + t-1575 增量）· trailer 门 `PASS: 起点 e490e22af2cf, 冻结 tip 18 条, 检查 45 条 fix(v5) 提交`。**NOT RUN**：`test:browser`、gateway / commercial 单测（Windows 假阳性 R6 / R9）、`test:commercial:integ`（需 PG）→ 服务器 / CI 复跑。
- 验收判据：`--diff-filter=U` 为空 ✅ · 门全绿 ✅ · build ≤ 460KB ✅ · trailer PASS ✅ · 未碰 integration / canonical / 服务器 ✅。分支已推远端、**不合入**。

## 4. t-1455 · 发布前置 · v3-dev-sg 磁盘核查与安全清理

| 时点 | `/` 盘 | 出处 |
|---|---|---|
| 09-17 03:5x（d-1326） | 94%，余 14G → 列为发布风险，`--preflight` 前先核对空间与旧 release 清理 | d-1326 ③ |
| 09-18 00:56（RELEASE.md v2.1 §2.2b S10 只读实测） | `/dev/vda1` 194G 用 168G 余 27G（**87%**），`free_GiB=26.6` ≥ 8 门过；观察到 09-17 4 次失败 train 留下的 `rel-f1952819f-20260917-{064741,071018,072935,074953}` 各 181M ≈ 724M 可清，`rel-3b7c38b9d-20260915-073032` 1.5G 是 `.prev-release`（回滚点）**不可删** | RELEASE.md §2.2b S10 |
| 09-18 02:0x（d-1603 ③） | **76%**（登记为 t-1455 结果） | d-1603 |

- 结论：发布前置 S10（≥ 8 GiB）已满足；≤ 85% 目标按 d-1603 登记已达（76%）。**NOT RUN**（本摘要作者）：本机无服务器通道，未复核现值；清理动作明细（删了哪些、保留了什么）待指挥官提供 t-1455 交付摘要后在阶段② 补入。任务库另有 disk-prep（在跑，fable-5-1-34）/ disk-prep-2（已完成，代单）两条同题任务，以任务库为准。

## 5. 【预留 · 阶段②填】t-1237 · 集成⑤（合并 / 门 / 记录 / 推送）

已核到的 `git` 事实（09-18 21:xx，integration `aeae1d72e`；执行 fable-5-1-4 代执行 01:45–02:15，INTEGRATION.md 集成⑤段 `9103ce7b4`）：

| 项 | 事实 |
|---|---|
| 8 步 `--no-ff` 合并（起点 `c97a750f8`） | 1 budget-fix@`65019b5dc` → `ec09ed419` · 2 qa-a11y@`eed1f3989` → `c701daac9` · 3 leftover-shell@`7e7c7e43b` → `7cae5427f` · 4 leftover-tut@`69e18aa93` → `c4a516697` · 5 leftover-tut-budget@`a947662bb`（t-1575）→ `10e1348fb` · 6 a11y-c@`c35fd00c6` → `ecf912b88`（唯一冲突 `RichBlocks.test.tsx` 两条用例全保留）· 7 archive@`35e3ec7c9` → `b6da4ef8d` · 8 qa-integ4@`31a8a92d6` → `936d44e85`；`git diff --shortstat c97a750f8..` 八步 64 files, +2269/−292，43 提交；`rev-list --count HEAD..<成员 HEAD>` 8 条均 0 |
| accept / 记录 | `91358ce54` chore source-only accept `agents,billing-usage`（history 第 70 条，**待用户终审**）· `9103ce7b4` docs 集成⑤段并推送 integration |
| 全量门 · 上半场（源码态 `91358ce54`，`.audit-tmp\integration\integ5\GATES-SUMMARY.txt`） | typecheck ✅ · `typecheck:preview` ✅ · `check:tutorials` ✅ 26 / 12 / 26 · **`build` ✅ 13 chunk gzip 447.8KB（458555 B）< 460.0KB，余量 12.2KB**（集成④ 471.4KB ❌ 由 t-1348 + t-1575 转绿）· `npm test` **305 文件 / 4306 例全部通过**（集成④ 302 / 4279 → +3 文件 / +27 例）· `test:browser` `run.mjs` 68 全过 + `node --test` 87 例 85 / 2（`cc-switch-ascii-name` ×2 基线）· biome lint 新增 0（5 条 `format` 差异全在本轮新增文件，CRLF 判定，blob 为 LF） |
| 全量门 · 下半场 | ui-preview 全量截图（301+ 场景）+ a11y 复扫：**未跑**（集成⑤段 §5 末行「第二拍」；任务库 integ5-gate2 阻塞，等人裁决） |

- TODO（阶段②）：□ 下半场截图 / a11y 复扫结果（场景数 / 张数 / failures / 九项指标 vs 集成④）□ t-1237 验收结论与关单人 □ 集成⑤ 终点 HEAD（若 fable-5-1-35 在 `9103ce7b4` 之后再补 docs）□ 各模块摘要「待集成⑤」→「集成⑤ `<merge>`」全量翻转（SUMMARY §3 / archive/*.md）。

## 6. 【预留 · 阶段②填】t-1268 · 发布准备（integration 合 canonical + 门 + canonical ff / push）

已核到的 `git` 事实（RELEASE.md §3.1c，fable-5-1-6 接任指挥官后代执行 09-18 02:1x–02:2x）：

| 项 | 事实 |
|---|---|
| 提交链 | **`57ad2c823`** merge canonical `feat/v5-selfhost@f1952819f` 到 integration（parents `9103ce7b4` / `f1952819f`；7 处冲突按 §3.1b 逐字重放：`git checkout b96cb194f -- <4 文件>`、3 个 `tutorial-sync*` `--ours` 后普通 accept `advisor-mode`，history **第 71 条**）→ `04ba13b2e` cherry-pick R2 `c1fdc935e`（零冲突）→ **`aeae1d72e`** RELEASE.md v2.2 + §3.1c 带入 = `<INT>`（已推 origin，远端 = 本地） |
| 门（HEAD `04ba13b2e`，`.audit-tmp\release-deploy\run-gates-int.ps1` / `gates-int\`） | typecheck ✅ 29s · preview ✅ 17s · `check:tutorials` ✅ 26 / 12 / 26 · `lint:migration-order` ✅ 283 支 · 161 条 · `test:protocol` 14/14 · vitest **29 文件 583 例** ✅ 80s · `build` ✅ 5108 modules · 首屏 **13 chunk 448.3KB（459061 B）≤ 460.0KB，余量 11.7KB**（与 §3.1b 预演逐字节相同）· trailer ✅ PASS（起点 `e490e22af2cf`，冻结 tip 18，检查 45）· 树内无冲突标记。**NOT RUN**：`test:browser`、gateway / commercial 单测、commercial integ（服务器 / CI 复跑） |
| 未做 | §3.3 canonical `--ff-only` + push **未执行**（`git ls-remote` 09-18 21:xx：`origin/feat/v5-selfhost` = **`97f128d2b`** `feat(v5): send Cursor Sand Direct to api2 as 3.21.12 sand-desktop`，是 `f1952819f` 之后上游又 +1，integration 未含；`origin/feat/v5-selfhost-ocv5-audit-ux` = `aeae1d72e`）→ 发布准备需以 `97f128d2b` 重做 §1.1 `merge-tree` 冲突核对与 §3.2 门 |

- TODO（阶段②）：□ 合入 `97f128d2b`（或更新）的合并提交 / 冲突集合 / 门复跑 □ `<INT>` 终值与 `<REL>` □ canonical push 时间与 `git rev-parse origin/feat/v5-selfhost == <REL>` 核对 □ history 条数终值 □ t-1268 验收结论。

## 7. 【预留 · 阶段②填】t-1269 · 发布执行（服务器 `/opt/openclaude/openclaude-v5-selfhost`，root@38.55.252.217，RELEASE.md §4）

- 前置（已知）：live = `rel-f1952819f-20260917-082520`，0281 已 apply → 预期 `HAS_MIGRATION=0`；磁盘 76%（§4）；`--preflight` 是首装门，不在 live 实例上跑（d-1603 ④）；不可逆动作由指挥官代批（d-1326 / d-1603）。
- TODO（阶段②，按 RELEASE.md §6 发布记录模板逐项）：□ §4.0 前值（`<OLD_HEAD>` / `<OLD_REL>` / `<OLD_PREV>` / `<OLD_BUILD>` / runtime-release / platform bundle / lease / 磁盘）□ `git fetch` + `--ff-only` 到 `<REL>` □ `--status` / `--smoke` 前值 □ `--deploy --dry-run` 计划（HAS_MIGRATION 实值）□ `--deploy` 结果（`rel-<REL>-<ts>`、耗时、是否触发补偿）□ `--smoke` / `--status` 后值 □ §4.8 功能验证（浏览器 ≤ 10 分钟）□ 回滚点与 `.prev-release` □ t-1269 验收结论 □ 用户终审是否在发布前叫停（SUMMARY §7-7）。

## 8. 分支 / 状态

| 分支 | HEAD | 任务 | 远端 | 处置 |
|---|---|---|---|---|
| `feat/v5-selfhost-audit-release-rehearsal` | `a4452c7b6`（v2.1；初稿 `c1fdc935e`） | t-1279 | = 本地 | **不合入**（RELEASE.md 由 t-1268 `aeae1d72e` 带入 integration） |
| `feat/v5-selfhost-audit-integ5-rehearsal` | `b6b78e876` | t-1503 | 未推 | **不合入** |
| `feat/v5-selfhost-audit-release-prep-rehearsal` | `e75749dd0`（v2.2） | t-1598 | = 本地 | **不合入** |
| `feat/v5-selfhost-audit-leftover-tut-budget` | `a947662bb` | t-1575 | = 本地 | 集成⑤ 5/8 `10e1348fb` |
| `feat/v5-selfhost-ocv5-audit-ux`（integration） | **`aeae1d72e`** | t-1237 / t-1268 | = 本地 | 含集成⑤ 8 步 + canonical `f1952819f` + RELEASE.md v2.2；待 push canonical |
| `feat/v5-selfhost`（canonical，远端） | **`97f128d2b`**（`f1952819f` +1） | — | — | integration 未含，release-prep 需重核 |
