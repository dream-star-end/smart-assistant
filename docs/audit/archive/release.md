# 集成⑤预演 + 发布线 · 归档摘要（t-1503 / t-1279 / t-1598 / t-1455 已完成；t-1237 / t-1268 / t-1269 预留）

> 正文：[`docs/audit/RELEASE.md`](../RELEASE.md)（发布预演 + 运行手册，v2.2，t-1279 → t-1598 → t-1268 逐轮更新，随 integration `aeae1d72e` 带入）、[`docs/audit/INTEGRATION.md`](../INTEGRATION.md) 集成⑤段（t-1237，含 t-1503 预演与 t-1575 归因）。本文只做摘要与索引；**发布线三条任务（集成⑤ t-1237 / 发布准备 t-1268 / 发布执行 t-1269）在任务库尚未验收闭合**（09-18 20:49 账本：integ5 在跑、release-prep / release-deploy 阻塞、集成⑤ 全量门下半场 integ5-gate2 阻塞；21:4x 指挥官把 t-1237 改版为「集成⑤收尾 = 合 canonical `97f128d2b` + 完整全量门 + INTEGRATION / RELEASE v2.3 + push integration」），§5–§7 只登记 `git` / 服务器只读实测可核的事实并留 TODO 字段，验收结论在归档阶段②填。
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
| 09-18 02:0x（d-1603 ③ / d-1832 ⑤） | **76%**（登记为 t-1455 结果） | d-1603 / d-1832 |
| **09-18 13:34Z = 21:34 UTC+8（本摘要作者 SSH 只读实测，指挥官临时指令）** | `/dev/vda1` 194G 用 148G 余 **46G（77%）**，`/opt/openclaude` 45.9 GiB free；`du -x --max-depth=1 /`：/var 109G（`docker system df`：volumes 32 个 62.09GB · images 3 个 10.91GB 可回收 2.16GB · build cache 8.73GB）· /opt 20G · /usr 7.2G · /root 5.0G · /home 3.2G；`journalctl --disk-usage` 282.7M；releases：`rel-3b7c38b9d-20260915-073032` 1.7G（**已不是 `.prev-release`**）· `rel-f1952819f-20260917-082520` 219M（= 现 `.prev-release`，回滚点，留）· `rel-97f128d2b-20260918-113828` 219M（当日首次尝试残留）· `rel-97f128d2b-20260918-120201` 219M（**live**） | 记忆 mem-1895；原始输出本机 `%TEMP%\t897\precheck-out.txt` |

- 结论：发布前置 S10（≥ 8 GiB）满足；≤ 85% 目标达（现值 **77%**，09-18 13:34Z；比 d-1603 登记的 76% 多 1 个点 = 当日 Sand 组两次 release 构建 ≈ 440M）。**清理明细缺**：`recall`（t-1455 / 磁盘 / rel- / v3-dev-sg / fable-5-1-6）无 t-1455 清理记录，任务库不回正文——不编；可推断的只有「94% → 76%」区间内 09-17 4 次失败 train 的 `rel-f1952819f-20260917-{064741,071018,072935,074953}`（v2.1 观察到 ≈ 724M）已不在目录里。若发布前要再清（非必需）：`rel-3b7c38b9d-…` 1.7G + `rel-97f128d2b-…-113828` 219M ≈ 1.9G、非 runtime 的 docker 镜像 ≈ 2.16GB、journal ≈ 0.2G，合计 ≈ 4.3G，交指挥官裁决，本单未动。任务库 disk-prep（t-1330，持有人离线）按 d-1832 ⑤ 不再补人，df 复核并入 t-1269 序列。

## 5. 【预留 · 阶段②填】t-1237 · 集成⑤（合并 / 门 / 记录 / 推送）

已核到的 `git` 事实（09-18 21:xx，integration `aeae1d72e`；执行 fable-5-1-4 代执行 01:45–02:15，INTEGRATION.md 集成⑤段 `9103ce7b4`）：

| 项 | 事实 |
|---|---|
| 8 步 `--no-ff` 合并（起点 `c97a750f8`） | 1 budget-fix@`65019b5dc` → `ec09ed419` · 2 qa-a11y@`eed1f3989` → `c701daac9` · 3 leftover-shell@`7e7c7e43b` → `7cae5427f` · 4 leftover-tut@`69e18aa93` → `c4a516697` · 5 leftover-tut-budget@`a947662bb`（t-1575）→ `10e1348fb` · 6 a11y-c@`c35fd00c6` → `ecf912b88`（唯一冲突 `RichBlocks.test.tsx` 两条用例全保留）· 7 archive@`35e3ec7c9` → `b6da4ef8d` · 8 qa-integ4@`31a8a92d6` → `936d44e85`；`git diff --shortstat c97a750f8..` 八步 64 files, +2269/−292，43 提交；`rev-list --count HEAD..<成员 HEAD>` 8 条均 0 |
| accept / 记录 | `91358ce54` chore source-only accept `agents,billing-usage`（history 第 70 条，**待用户终审**）· `9103ce7b4` docs 集成⑤段并推送 integration |
| 全量门 · 上半场（源码态 `91358ce54`，`.audit-tmp\integration\integ5\GATES-SUMMARY.txt`） | typecheck ✅ · `typecheck:preview` ✅ · `check:tutorials` ✅ 26 / 12 / 26 · **`build` ✅ 13 chunk gzip 447.8KB（458555 B）< 460.0KB，余量 12.2KB**（集成④ 471.4KB ❌ 由 t-1348 + t-1575 转绿）· `npm test` **305 文件 / 4306 例全部通过**（集成④ 302 / 4279 → +3 文件 / +27 例）· `test:browser` `run.mjs` 68 全过 + `node --test` 87 例 85 / 2（`cc-switch-ascii-name` ×2 基线）· biome lint 新增 0（5 条 `format` 差异全在本轮新增文件，CRLF 判定，blob 为 LF） |
| 全量门 · 下半场 | ui-preview 全量截图 + a11y 复扫：集成⑤段 §5 末行标「第二拍」**未入 INTEGRATION.md**；仓外已有两份产物——fable-5-1-24 在 `wt\integ5-gate`（detached `aeae1d72e`）跑的 `.audit-tmp\integ5-rehearsal\gate-second-half.md`（t-1535，持有人超时未交付、未验收）与 fable-5-1-35 21:xx 在同一树复跑的 `.audit-tmp\integration\integ5-final\`（shots-integ5 / a11y / GATES-SUMMARY，在跑）；**数值以 fable-5-1-35 的交付为准，阶段② 回填** |
| 任务书改版（指挥官 fable-5-1-31 21:4x） | t-1237 改为「**集成⑤收尾** = integration 合 canonical **`97f128d2b`** + 完整全量门（含截图 + a11y 第二拍）+ INTEGRATION.md / RELEASE.md v2.3 + push integration」，执行 fable-5-1-35；之后再派 release-deploy。本机只读 `git merge-tree --write-tree aeae1d72e 97f128d2b` **无冲突**（§6） |

- TODO（阶段②）：□ 下半场截图 / a11y 复扫终值（场景数 / 张数 / failures / 九项指标 vs 集成④ 301 · 1026）□ 合 `97f128d2b` 后的门终值（build / vitest）与 INTEGRATION.md / RELEASE.md v2.3 提交 SHA □ t-1237 验收结论与关单人 □ 集成⑤收尾终点 HEAD □ 各模块摘要「待集成⑤」→「集成⑤ `<merge>`」全量翻转（SUMMARY §3 / archive/*.md）。

## 6. 【预留 · 阶段②填】t-1268 · 发布准备（integration 合 canonical + 门 + canonical ff / push）

已核到的 `git` 事实（RELEASE.md §3.1c，fable-5-1-6 接任指挥官后代执行 09-18 02:1x–02:2x）：

| 项 | 事实 |
|---|---|
| 提交链 | **`57ad2c823`** merge canonical `feat/v5-selfhost@f1952819f` 到 integration（parents `9103ce7b4` / `f1952819f`；7 处冲突按 §3.1b 逐字重放：`git checkout b96cb194f -- <4 文件>`、3 个 `tutorial-sync*` `--ours` 后普通 accept `advisor-mode`，history **第 71 条**）→ `04ba13b2e` cherry-pick R2 `c1fdc935e`（零冲突）→ **`aeae1d72e`** RELEASE.md v2.2 + §3.1c 带入 = `<INT>`（已推 origin，远端 = 本地） |
| 门（HEAD `04ba13b2e`，`.audit-tmp\release-deploy\run-gates-int.ps1` / `gates-int\`） | typecheck ✅ 29s · preview ✅ 17s · `check:tutorials` ✅ 26 / 12 / 26 · `lint:migration-order` ✅ 283 支 · 161 条 · `test:protocol` 14/14 · vitest **29 文件 583 例** ✅ 80s · `build` ✅ 5108 modules · 首屏 **13 chunk 448.3KB（459061 B）≤ 460.0KB，余量 11.7KB**（与 §3.1b 预演逐字节相同）· trailer ✅ PASS（起点 `e490e22af2cf`，冻结 tip 18，检查 45）· 树内无冲突标记。**NOT RUN**：`test:browser`、gateway / commercial 单测、commercial integ（服务器 / CI 复跑） |
| 未做 | §3.3 canonical `--ff-only` + push **未执行**（`git ls-remote` 09-18 21:xx：`origin/feat/v5-selfhost` = **`97f128d2b`** `feat(v5): send Cursor Sand Direct to api2 as 3.21.12 sand-desktop`（作者 agent，09-18 11:37Z；5 文件 +86/−3：`packages/gateway/src/engine/cursorSandRelay.ts` / `cursorSandAdapter.ts` / `index.ts` + `__tests__/cursorSandRelay.test.ts` + `scripts/check-v5-cursor-sand-inference.ts`；**无 migrations、不碰 web-react / release-metadata**），是 `f1952819f` 之后上游又 +1，integration 未含；`origin/feat/v5-selfhost-ocv5-audit-ux` = `aeae1d72e`）。本机只读 **`git merge-tree --write-tree aeae1d72e 97f128d2b` exit 0、无冲突路径** → 合入不需再解 §1.2 七处，`HAS_MIGRATION` 仍预期 0；按指挥官 21:4x 改版，这一步并入 t-1237 集成⑤收尾（fable-5-1-35） |
| 服务器侧对照（09-18 13:34Z 只读实测，§7） | **`97f128d2b` 已被另一组部署到服务器**：live = `rel-97f128d2b-20260918-120201`（12:02Z），工作树 HEAD = `97f128d2b`，`.prev-release` = `rel-f1952819f-20260917-082520` → 本组发布时 `git fetch` + `--ff-only` 到 `<REL>` 仍成立（`<REL>` 必为 `97f128d2b` 后代），但 RELEASE.md §4.0 前值（`<OLD_HEAD>` / `<OLD_REL>` / `<OLD_PREV>` / `OC_RUNTIME_RELEASE`）需按 §7 更新 |

- TODO（阶段②）：□ 合入 `97f128d2b`（或更新）的合并提交 / 门复跑 □ `<INT>` 终值与 `<REL>` □ canonical push 时间与 `git rev-parse origin/feat/v5-selfhost == <REL>` 核对 □ history 条数终值 □ t-1268 验收结论。

## 7. 【预留 · 阶段②填】t-1269 · 发布执行（服务器 `/opt/openclaude/openclaude-v5-selfhost`，root@38.55.252.217，RELEASE.md §4）

- 前置（**09-18 13:34Z = 21:34 UTC+8 只读实测**，`ssh -o BatchMode=yes root@38.55.252.217`，命令 = RELEASE.md §4.0 / §4.1 只读子集 + 指挥官指定的 df / du / docker / journalctl；未删未改未重启，未碰 `openclaude.service` / 18789 / Redis db0；原始输出本机 `%TEMP%\t897\precheck-out.txt`，摘要记忆 mem-1895）：

| 项 | 实测 | 判据 |
|---|---|---|
| SSH | 连上，hostname `v3-dev-sg`，up 3d 4h | ✅ |
| 磁盘 | `/` 77%，余 46G；`/opt/openclaude` 45.9 GiB free（§4） | ✅ S10 ≥ 8 GiB |
| 仓库 `/opt/openclaude/openclaude-v5-selfhost` | `git status --porcelain` 0 行（干净）；`feat/v5-selfhost...origin/feat/v5-selfhost`；**HEAD = `97f128d2b`**（`git log -3`：`97f128d2b` / `f1952819f` / `3b7c38b9d`）；remote origin = `github.com/dream-star-end/smart-assistant`；服务器本地 `origin/feat/v5-selfhost` = `97f128d2b` | ✅ 干净 → 不需 `--allow-dirty`；**基线已变**（d-1832 ⑤「仍在 f1952819f」过时） |
| live / prev | `readlink -f …-live` = `rel-97f128d2b-20260918-120201`，`.complete.sourceCommit` = `97f128d2b`（== HEAD）；`.prev-release` = `rel-f1952819f-20260917-082520`；另有 `rel-97f128d2b-20260918-113828`（首次尝试残留） | ✅ live 与工作树对齐；**回滚点现为 f1952819f 那一版** |
| 服务 | `systemctl is-active openclaude-v5-selfhost.service` = active；`127.0.0.1:18790/healthz` = 200 | ✅ |
| `deploy-v5-selfhost.sh --status`（只读） | HEAD `97f128d2b`；live / prev 同上；env `commercial-v5-selfhost.env` present mode=600；`OC_RUNTIME_IMAGE=…slim`；**`OC_RUNTIME_RELEASE=…/runtime-releases/rel-f6829c2e8271`**（v2.1 时 `rel-60955d1c847c`，已随当日发布更换）；`OC_PLATFORM_BUNDLE=…/bundles/0e4b6b137992`（不变）；unit master active；egress slotA=active / slotB=inactive / serving=slotA；hostnet / ccb-proxy / sshgate / tunnel active；`spa dist` / `.complete` MISSING（工作树指标，预期）；`OC_SESSIONS_STORE=pg`；net / pg 存在；18790 / 18892 listen | ✅ |
| Lease | `oc-lease.sh status --resource deploy:selfhost`：无 open train，`deploy proc: none`，权威事实 origin tip = live committed_sha = `97f128d2b` | ✅ S11 |
| 迁移 | `SELECT version FROM schema_migrations …` → `0280_cursor_haiku_45`、`0281_cursor_sand_usable_families` | ✅ U7；`97f128d2b` 不带 migrations → `HAS_MIGRATION` 仍预期 0 |

- **结论：部署前置就绪，阻断 0**；三处要按新基线调：① integration 先合 `97f128d2b`（§6，无冲突）；② §4.0 前值改 `<OLD_HEAD>` = `97f128d2b`、`<OLD_REL>` = `rel-97f128d2b-20260918-120201`、`<OLD_PREV>` = `rel-f1952819f-20260917-082520`、`OC_RUNTIME_RELEASE` = `rel-f6829c2e8271`；③ 同机另一组（Sand，d-1668）当日 12:02Z 刚发过 → 按 d-1832 ⑥ 不并发 deploy，`--deploy` 前再跑一次 `oc-lease status` 确认 `deploy proc: none` 并与该组对齐窗口。`--preflight` 是首装门不在 live 实例上跑（d-1603 ④ / d-1832 ⑥）；不可逆动作由指挥官代批。
- TODO（阶段②，按 RELEASE.md §6 发布记录模板逐项）：□ §4.0 前值（`<OLD_HEAD>` / `<OLD_REL>` / `<OLD_PREV>` / `<OLD_BUILD>` / runtime-release / platform bundle / lease / 磁盘）□ `git fetch` + `--ff-only` 到 `<REL>` □ `--status` / `--smoke` 前值 □ `--deploy --dry-run` 计划（HAS_MIGRATION 实值）□ `--deploy` 结果（`rel-<REL>-<ts>`、耗时、是否触发补偿）□ `--smoke` / `--status` 后值 □ §4.8 功能验证（浏览器 ≤ 10 分钟）□ 回滚点与 `.prev-release` □ t-1269 验收结论 □ 用户终审是否在发布前叫停（SUMMARY §7-7）。

## 8. 分支 / 状态

| 分支 | HEAD | 任务 | 远端 | 处置 |
|---|---|---|---|---|
| `feat/v5-selfhost-audit-release-rehearsal` | `a4452c7b6`（v2.1；初稿 `c1fdc935e`） | t-1279 | = 本地 | **不合入**（RELEASE.md 由 t-1268 `aeae1d72e` 带入 integration） |
| `feat/v5-selfhost-audit-integ5-rehearsal` | `b6b78e876` | t-1503 | 未推 | **不合入** |
| `feat/v5-selfhost-audit-release-prep-rehearsal` | `e75749dd0`（v2.2） | t-1598 | = 本地 | **不合入** |
| `feat/v5-selfhost-audit-leftover-tut-budget` | `a947662bb` | t-1575 | = 本地 | 集成⑤ 5/8 `10e1348fb` |
| `feat/v5-selfhost-ocv5-audit-ux`（integration） | **`aeae1d72e`** | t-1237 / t-1268 | = 本地 | 含集成⑤ 8 步 + canonical `f1952819f` + RELEASE.md v2.2；待合 `97f128d2b`（无冲突）+ 收尾门 + push canonical（t-1237 改版，fable-5-1-35） |
| `feat/v5-selfhost`（canonical，远端） | **`97f128d2b`**（`f1952819f` +1，gateway Sand 改动） | — | — | integration 未含；**服务器已在 09-18 12:02Z 部署此版**（live `rel-97f128d2b-20260918-120201`） |
