# v5 个人版（selfhost）发布预演 + 运行手册草稿（t-1279）

> 状态：**草稿 v2 · 预演分支 `feat/v5-selfhost-audit-release-rehearsal` @ `f6572abb6`**。本文件由发布预演任务 t-1279 产出（初稿 fable-5-1-34 @ `c1fdc935e`，09-17 04:xx；**09-18 00:3x 由 fable-5-1-4 接手复核并更新**），给 t-1268「发布准备」/ t-1269「发布执行」接棒。
> 边界（已守住）：**未推 canonical、未动 integration、未登录服务器**；试合只发生在预演分支；本机到 38.55.252.217 / 186.244.238.121 的 22 端口只拿到 SSH banner、密钥未授权，全部服务器步骤均为「照本宣科」而非实跑。
> 出处标注约定：`deploy-v5-selfhost.sh:L` = `scripts/deploy-v5-selfhost.sh` 行号；`master-lib:L` = `scripts/v5-selfhost-master-release-lib.sh` 行号；`AGENTS.md §…`、`hotfix-checklist Step …` = `docs/hotfix-deploy-checklist.md`；`PLAYBOOK §…` = `docs/V5_DEV_PLAYBOOK.md`。行号按预演分支 `c1fdc935e` 标注；`f6572abb6` 追合的三方（canonical `f1952819f`、budget-fix `65019b5dc`、integration `c97a750f8`）**都没碰 `scripts/**`**，行号仍然有效。
>
> **v2 相对初稿的变化（接棒先看这里）**：
> 1. **canonical 又前进了 1 提交**：`origin/feat/v5-selfhost` = `f1952819f`（OCV5-225，含 **DB 迁移 0281 + 破坏性 DDL**），发布口径从「纯前端、无迁移」变成「含迁移、需 `OC_V5_ALLOW_BREAKING_MIGRATION=1`」→ 新增 **R0**、C5/C10/C11、U7/U8、§4.0 只读 SQL 前置、§4.4/§4.5 HAS_MIGRATION=1 判据、§5.3 两行。
> 2. **integration 前进到 `c97a750f8`**（只多 1 条 docs 提交），§1.2 七处冲突与解法**原样适用**（实测 merge-tree 同集合）。
> 3. **R1 修复已就位**：budget-fix `65019b5dc`（t-1348）预合进预演分支后 `npm run build` ✅ 447.3KB / 余量 12.7KB；但它**尚未进 integration**，等集成⑤。
> 4. 全部门在 `f6572abb6` 上复跑一遍（§1.3b）：typecheck / typecheck:preview / check:tutorials / lint:migration-order / test:protocol(engineModels) / vitest 9 文件 295 用例 / build / trailer 门全绿；`cursorCliWrapper.test.ts` 55 红为 Windows 假阳性（R9）。

## 0. 结论速览（接棒先读）

| # | 级别 | 结论 | 谁来处理 |
|---|---|---|---|
| **R0** | **P1 必读（v2 新增）** | **canonical 已前进**：`origin/feat/v5-selfhost` = `f1952819f`（= `3b7c38b9d` + 1 提交 `feat(v5): wire Sand-usable Cursor families into the picker`，OCV5-225，boss 09-17 14:46，ff 关系）。对预演分支追合**零冲突**（`c009a1c04`，9 文件 +673/−18），但它把发布口径从「纯前端 + 无迁移」改成「**含 DB 迁移 + 破坏性 DDL**」：新增 `packages/commercial/src/db/migrations/0281_cursor_sand_usable_families.sql`（334 行，`order-dependency: 0280_cursor_haiku_45`）并登记进 `deploy/v5/release-metadata.json` requiredMigrations（第 162 条）；其 L248-249 `ALTER TABLE cursor_external_usage_audit DROP CONSTRAINT IF EXISTS …` 命中 selfhost 迁移门的 `ALTER … DROP` 分类（`sql_file_has_breaking_ddl` master-lib:756-775；`classify_pending_migration_file` :846-855 默认 `die`）→ **`--deploy` 与 `--deploy --dry-run` 都必须带 `OC_V5_ALLOW_BREAKING_MIGRATION=1`**，否则 STEP 3 就停（迁移文件头 L18-20 作者已写明「deploy with OC_V5_ALLOW_BREAKING_MIGRATION=1」）。HAS_MIGRATION 预期 0→1：STEP 6b 在翻转同一把锁内 `npx --no-install tsx packages/commercial/src/db/migrate.ts` 当场 apply（master-lib:1146-1158，`PGOPTIONS=-c openclaude.migration_profile=v5-selfhost`；deploy-v5-selfhost.sh:2598-2609），失败 → `cutover_compensate migration-apply`，不翻转、**不回滚 schema**。0281 自带三条 `RAISE EXCEPTION` 前置（L40-57：`cursor-grok-4.6-high` / `cursor-gemini-3.8-flash-high` / `cursor-haiku-4.5` 必须 active+enabled）——本机无法验证 selfhost DB，§4.0 新增只读 SQL。同提交还动了 `packages/protocol/src/engineModels.ts`（master + runtime-release 两轴，PLAYBOOK §4.1 :340/:342）、`packages/commercial/agent-sandbox/platform-runtime/bin/oc-cursor.sh`（platform bundle 轴，:343）、`.github/integ-tiers/nightly-4.txt`（CI）。subject 是 `feat(v5)`，trailer 门不受影响（复跑 PASS）。 | 指挥官：① 拍板是否以 `OC_V5_ALLOW_BREAKING_MIGRATION=1` 放行 0281（会打 ⚠ 写入日志，master-lib:850）；② 发布执行者先跑 §4.0 两条只读 SQL；③ §3 的 canonical 期望值按 `f1952819f` 核对，若再前进重做 §1.1 merge-tree。 |
| R1 | **P1 阻断 → 修复已就位，待集成⑤合入** | **integration 分支单独仍过不了生产构建**：`npm run build --workspace packages/web-react`（= `--deploy` 的 `build_frontend`，deploy-v5-selfhost.sh:1109-1128）在 vite `first-screen-budget` 插件处 fail。首屏闭包 gzip：基线 210b99678 = 455.9KB ✅ → canonical 3b7c38b9d = 456.4KB ✅ → **integration 2d2b5cafc = 471.4KB ❌**（超 460.0KB 预算 11.4KB）→ 预演 c1fdc935e = 471.7KB ❌；integration 现 HEAD `c97a750f8` 相对 2d2b5cafc 只多 1 条 docs 提交、`vite.config.ts` 未变，结论不变。增量在 main chunk +7.7KB、tapePayload +5.4KB、styles +1.3KB，是审计改动撑爆入口静态闭包，**与 canonical 提交无关**。**修复**：t-1348 已交付在 `feat/v5-selfhost-audit-budget-fix@65019b5dc`（`77e1f35dc` 把点开才需要的覆盖层改 `React.lazy` 移出入口静态闭包；阈值 471040 **未上调**），`git merge-base --is-ancestor 65019b5dc c97a750f8` = **否，尚未进 integration**（等集成⑤）。预演分支已预合（`f6572abb6`；对 c97a750f8 与 canonical 均零冲突，App.tsx 自动合并）并实跑 build → **✅ exit 0，built in 18.84s；首屏闭包 13 chunk gzip 447.3KB（458056 B），余量 12.7KB**（main 129.8 / tapePayload 123.2 / styles 77.6KB；比 budget-fix 自报的 445.5KB 多 1.8KB = canonical picker/protocol 增量）。 | 指挥官：集成⑤把 budget-fix 合进 integration 后**在 integration 上复跑 `npm run build`**（§3.2 C1），绿了才 ff canonical；此前服务器 `--deploy` 必死在 `build_master_release`（live 不动）。 |
| R2 | P2（canonical 自带） | canonical `7b2ae241d` 把勾选框文案改成「同时设为新对话的默认协作方式」，但 **未同步** `packages/web-react/src/App.test.tsx`（4 处）与 `browser-tests/ocv5-210-cas-identity.node-test.mjs`（4 处）仍查旧文案「同时作为新会话默认」→ canonical 自己的 web-react 单测 `App.test.tsx > stale CAS reread after logout…` 就是红的（纯 3b7c38b9d 检出上 grep 可证）。预演分支 `c1fdc935e` 已对齐 8 处。 | 合 canonical 时带上 `c1fdc935e`（或等价改动）。 |
| R3 | P2（canonical 自带） | `scripts/check-v5-incident-regressions.ts` 在纯 canonical 3b7c38b9d 上就 **FAIL**：`INC-20260915-ADVISOR-1M-DUP-PICKER: 没有 browser/live-e2e/deploy-gate 证据时必须写 proofPending{reason,since}`（规则 :306-315，基线 210b99678 起未变；数据是 canonical `3b7c38b9d` 新增的 incidents.json 条目，只登记了两条 unit 层回归）。**selfhost `--deploy` 不跑这道 TS 门**（只跑 bash trailer 门，见 R5），所以不阻断部署；但 CI `check:v5`（含 `check:v5:incidents`）会红。 | canonical 维护者：给该事故补 proof 层证据或写 `proofPending`（注意 `PROOF_PENDING_BASELINE = 11` 棘轮，:39）。 |
| R4 | 假阳性（本机） | `scripts/check-incident-ledger-superset.ts` 报 `baseline sha256 531fe1eb… != pin 59a3ceaf…`：本机 `core.autocrlf=true` 把工作树 `e2e/session-display/incident-ledger-baseline.json` 检出成 CRLF（626 个 CR），脚本按工作树文件哈希。仓库 blob 的 sha256 = pin `59a3ceaf…`（已复算）。Linux 服务器/CI 不受影响。 | 无需处理；Windows 成员别拿它当红灯。 |
| R5 | ✅ | **Incident trailer 发布前门 PASS**：`scripts/check-v5-fix-trailers.sh --repo . --head HEAD` → `✓ PASS: 起点 e490e22af2cf, 冻结 tip 18 条, 检查 45 条 fix(v5) 提交`（本机 git-bash + jq 1.7.1 实跑，24s）。base..HEAD 里 `fix(v5)` 只有 canonical 的 `7b2ae241d`（exact 映射 → INC-20260915-ADVISOR-CONSULT-CARD）与 `a6584a430`（Incident: INC-20260915-ADVISOR-1M-DUP-PICKER），审计 204 条提交全部 feat/refactor/style/test/docs/chore（决策 d-26）。 | — |
| R6 | ✅ | 试合门（c1fdc935e）：typecheck ✅ / typecheck:preview ✅ / check:tutorials ✅ / 受影响模块 vitest 7 文件 259 用例 ✅（含 App.test.tsx）；gateway `advisorMode.test.ts` 15/18，3 条失败全是 Windows 环境（symlink EPERM、POSIX 字面路径被 `path.join` 改成反斜杠），且 `packages/gateway` 在 HEAD 与 canonical **字节一致**（`git diff --stat 3b7c38b9d HEAD -- packages/gateway` 为空），不可能是合并回归；服务器/CI 复跑即可。**v2 复跑（f6572abb6，§1.3b）**：typecheck ✅ 66s / typecheck:preview ✅ / check:tutorials ✅ / `lint:migration-order` ✅（283 支迁移、requiredMigrations 161 条完整有序，0281 登记正确）/ `test:protocol` engineModels 14/14 ✅ / vitest 9 文件 **295/295** ✅ 102s（新增 budget-fix 触碰的 MarkdownImpl / chat·media 两文件）/ build ✅ / trailer 门 ✅ PASS（仍是 45 条 fix(v5)）。 | — |
| R9 | 假阳性（本机） | canonical f1952819f 改了 `packages/commercial/src/__tests__/cursorCliWrapper.test.ts`（30 行改动），本机 `npx tsx --test` 跑它 **55/57 红**：全部是 `spawnSync(f.wrapper, …)` 直接执行 `platform-runtime/bin/oc-cursor.sh`、以及 `spawnSync('test', ['!', '-e', …])` 这类 POSIX 调用在 Windows 上 `status=null`（断言 `null !== 0`），不是逻辑回归。 | Linux/CI 复跑 `test:commercial:unit`；Windows 成员别拿它当红灯。 |
| R7 | 注意 | 任务书里的服务器序列 `--preflight → --deploy → --smoke → --status`：**`--preflight` 是首装门**，在已 live 的实例上会按设计非 0 退出（`preflight_residue` 见到 `openclaude-v5-net` 网络即 die，deploy-v5-selfhost.sh:564-568；`preflight_ports_idle` 见到 18790/18892/18893 有人听即 die，:583-593）。更新发布的只读前置应当用 `--status` + `--smoke`（现网基线）+ `--deploy --dry-run`（计划 + `preflight_common` + 脏树判定 + trailer 门，不加锁不改，:400-409、:426）。 | 发布执行者按 §4 顺序走。 |
| R8 | 注意 | Lease Center：人工 `--deploy` 会自动登记 manual train，**若已有 open train 则拒绝**（deploy-v5-selfhost.sh:1350-1353）；`--lease-train` 路径要求工作树 HEAD 精确等于 `--target-sha`（:1333-1334）。发布前先 `scripts/oc-lease.sh status --resource deploy:selfhost`。 | 发布执行者。 |

## 1. 预演：试合 canonical 6 提交

### 1.1 基点与复现命令

| 角色 | 引用 | SHA |
|---|---|---|
| 团队基线（主克隆只读参照，决策 d-24） | `feat/v5-selfhost`（本地） | `210b9967892b3624fb3984f69d2174e4a641b33d` |
| integration 本地 HEAD（**试合基点**；任务书备选基点 `36bb9a677`「集成③记录」是它的祖先） | `feat/v5-selfhost-ocv5-audit-ux` | `2d2b5cafcf865b099c6a74b73d51c34683b9428e` |
| canonical 上游 | `origin/feat/v5-selfhost` | `3b7c38b9d007bc9587f64e9a0f51d537a19c2839`（比基线多 6 提交，见附录 A） |
| 试合 merge commit（预演分支） | `d02cc7c5d`（parents = 2d2b5cafc, 3b7c38b9d） | `d02cc7c5d6bb00af3db09903f189d19bc3fa71ab` |
| 预演分支 v1 HEAD（merge + 测试文案对齐） | `feat/v5-selfhost-audit-release-rehearsal` | `c1fdc935e5047985f5d0aa3d1a2267139f08baa6` |
| **integration 本地 HEAD（v2 复核时；= 2d2b5cafc + 1 条 docs 提交 `c97a750f8 docs(v5): 集成④收尾…`）** | `feat/v5-selfhost-ocv5-audit-ux`（本地 == `origin/…-audit-ux`） | `c97a750f8707b4ec09983cd2326dd7d8697be7b8` |
| **canonical 上游（v2 复核时；= 3b7c38b9d + 1 提交，ff）** | `origin/feat/v5-selfhost` | `f1952819f8b9f515b97c1a68d2da413522047781` |
| 预演分支 v2 · 追合 canonical f1952819f（零冲突） | merge commit（parents = c1fdc935e, f1952819f） | `c009a1c04` |
| **预演分支 v2 HEAD · 预合 budget-fix 65019b5dc（零冲突，验证 R1）** | `feat/v5-selfhost-audit-release-rehearsal` | `f6572abb6` |

> v2 核对：`git diff --stat 2d2b5cafc c97a750f8 -- <§1.2 七个文件> packages/web-react/vite.config.ts` **为空** → `d02cc7c5d` 的解法对 c97a750f8 可原样复用；`git merge-tree --write-tree --name-only c97a750f8 3b7c38b9d` → 树 `ce7a98ba7` + **同样 7 个路径**（exit 1）；`git merge-tree --write-tree --name-only c1fdc935e f1952819f` → 树 `dbd3d42c4`，**无冲突**（exit 0）；`git merge-tree --write-tree --name-only c1fdc935e 65019b5dc` → 树 `e836c9b60`，无冲突（exit 0）。

不动工作树、只看冲突集合（git ≥ 2.38；本机 2.44 实跑，输出与真实 merge 一致）：

```powershell
cd d:\code\test_project\test123\v5-selfhost
git fetch origin feat/v5-selfhost
git rev-parse origin/feat/v5-selfhost                          # v2 实测 f1952819f；再前进就先看 git log 3b7c38b9d..origin/feat/v5-selfhost
git merge-tree --write-tree --name-only c97a750f8 origin/feat/v5-selfhost
# 期望：第一行是合成树 oid，随后 7 个冲突文件路径（§1.2，全在 packages/web-react），退出码 1
# f1952819f 相对 3b7c38b9d 的 9 个文件（migrations / protocol / platform-runtime / deploy 元数据 / .github / 两个测试）与 integration 无交集，不会新增冲突
```

真实试合（预演分支已做，重做用于复现）：

```powershell
cd d:\code\test_project\test123\v5-selfhost
git worktree add -b feat/v5-selfhost-audit-release-rehearsal-2 ..\wt\release-rehearsal-2 2d2b5cafc
cd ..\wt\release-rehearsal-2
git merge --no-ff 3b7c38b9d          # Automatic merge failed; 7 处 CONFLICT (content)
# 按 §1.2 解决 4 个源码文件；3 个 tutorial-sync* 先取 --ours，再 §1.2(5-7) 重新生成
git diff --name-only --diff-filter=U  # 应为空后再 commit
```

### 1.2 冲突清单与解法（7 处，已在 d02cc7c5d 落地，源码处均留有「合并取舍(发布预演 t-1279)」注释）

| # | 文件 | 双方各改了什么 | 采用的解法 |
|---|---|---|---|
| 1 | `packages/web-react/src/components/AgentPicker.tsx` | 审计 composer C-32（兜底文案去「一期/CCB」黑话）、C-33（裸 `<select>` → `ui/Select`）；canonical OCV5-220/223（已配置顾问不在目录时 value="" + 占位项 + 警示、兜底文案改常量、勾选框新文案） | 控件沿用 `ui/Select`（C-33），**语义取 canonical**：不在列表时不再静默回退到第一项，`value=''` + `placeholder` 「请重新选择顾问型号」+ 一行 `text-warning`；兜底文案改用 `collaborationConfig.ADVISOR_PARENT_BLOCK_REASON`（与 `sendCollabFields` 同源，C-32 诉求由常量兑现）；勾选框文案取 canonical「同时设为新对话的默认协作方式」 |
| 2 | `packages/web-react/src/components/tool/bodies.tsx`（consult_advisor 卡） | 审计 tools T-27（状态词人话化：settled→已结算等）；canonical OCV5-220（进行中/已结束两态、「问了什么」、人话时长、`advisorConsultStatusLabel`） | **整块取 canonical**；T-27 诉求由 `advisorConsultStatusLabel` 兑现（补 `timeout → 超时`）；`suppressOutput` 含 running / err |
| 3 | `packages/web-react/src/components/tool/bodyCards.test.tsx` | 双方都改同一 describe | 取 canonical 三条用例（含 incidents.json 登记的 assertion 锚点「进行中显示思考中+已用时+提问，不写未返回」），保留审计 T-27 断言「不出现 `failed` / `settled` 原词」 |
| 4 | `packages/web-react/src/components/tool/meta.ts`（mcpSummary） | 审计 T-28（未登记 op 不直显内部标识符，返回 ""）；canonical OCV5-220（consult_advisor 摘要 question→concern 压一行截 40 字，其余 `return op`） | consult_advisor 取 canonical 写法 + 审计侧 `prompt`/`goal` 兜底；`request_review`/`ask_user` 保留审计分支；未登记 op **返回 ""**（取审计，否则 `meta.test`「不直显内部标识符」会红） |
| 5 | `packages/web-react/tutorial-sync.json` | 生成物：审计侧 26 项能力快照多轮 accept；canonical 侧 advisor-mode contentVersion 3→4 | **不手工合**：`git checkout --ours` 三个生成物 → 合并源码后 `npm run check:tutorials`（报「教程同步快照已漂移：能力注册表变化 advisor-mode / 功能源变化 advisor-mode / 教程正文变化 advisor-mode」）→ `npm run tutorials:accept -- --note "发布预演 t-1279：接受 canonical OCV5-220 advisor-mode 文案 v4"` → `check:tutorials OK · 26 capabilities · 12 real-world cases · 26 media pairs` |
| 6 | `packages/web-react/tutorial-sync-history-head.json` | 同上 | 同上（accept 重写） |
| 7 | `packages/web-react/tutorial-sync-history.jsonl` | 双方各追加一行 | 同上；accept 后为审计侧 69 条 + 新第 70 条（canonical 那一行不保留——它描述的是 canonical 自己的快照状态，与合并后快照不一致） |

合并后补一刀（`c1fdc935e`，见 R2）：`App.test.tsx` 4 处 + `browser-tests/ocv5-210-cas-identity.node-test.mjs` 4 处 `getByLabel(/同时作为新会话默认/)` → `/同时设为新对话的默认协作方式/`。这是 canonical 自带漂移，不是合并造成。

### 1.3 试合后门结果（预演 HEAD c1fdc935e；命令均在工作树根执行，另注明除外；日志见附录 C）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0 |
| ui-preview 场景类型 | `npm run typecheck:preview --workspace packages/web-react` | ✅ exit 0 |
| 教程同步门 | `npm run check:tutorials` | ✅ `check:tutorials OK · 26 capabilities · 12 real-world cases · 26 media pairs · 2390809 B` |
| 受影响模块 vitest（advisor / AgentPicker / ModelSelector / ChatHeader / 工具卡 / collaborationConfig / App） | `cd packages\web-react; npx vitest run src/components/AgentPicker.test.tsx src/components/ChatHeader.test.tsx src/components/ModelSelector.test.tsx src/components/tool/bodyCards.test.tsx src/components/tool/meta.test.ts src/lib/collaborationConfig.test.ts src/App.test.tsx --maxWorkers=1` | ✅ `Test Files 7 passed (7) · Tests 259 passed (259)` 46.7s |
| gateway advisor 单测 | `npx tsx --test packages/gateway/src/__tests__/advisorMode.test.ts` | ⚠ 15/18；失败 3 条 = Windows 环境（#3 `symlinkSync` EPERM；#7/#8 用 `join('/home/agent/...')` 得到反斜杠路径，授权路径匹配不上）。gateway 目录与 canonical 字节一致（R6）。**服务器/CI 复跑** |
| Incident trailer 门（`--deploy` 构建前 fail-closed，deploy-v5-selfhost.sh:1951-1972） | `bash scripts/check-v5-fix-trailers.sh --repo . --head HEAD` | ✅ PASS（R5） |
| 事故回归锁（CI `check:v5:incidents` 第一段） | `npx tsx scripts/check-v5-incident-regressions.ts` | ❌ canonical 自带（R3） |
| 事故账本超集门（CI `check:v5:incidents` 第二段） | `npx tsx scripts/check-incident-ledger-superset.ts` | ❌ 本机 CRLF 假阳性（R4） |
| **生产构建（`--deploy` 的 build_frontend 同款）** | `npm run build --workspace packages/web-react`（`tsc -b && vite build`，vite 8.1.3） | ❌ **first-screen-budget 超预算**（R1）：`首屏(index.html modulepreload 闭包,15 个 chunk)gzip 471.7KB 超过预算 460.0KB` |

首屏体量归因（同一 node_modules、同一口径逐基点实测；`main`/`tapePayload`/`styles` 三个 chunk 的变化解释了全部增量）：

| 基点 | 首屏闭包 gzip | 与预算 471040 B 的关系 | main | tapePayload | styles |
|---|---|---|---|---|---|
| 210b99678 基线 | 455.9KB（466880 B） | 余量 4.1KB | 131.7KB | 120.1KB | 73.8KB |
| 3b7c38b9d canonical | 456.4KB（467345 B） | 余量 3.6KB | 131.7KB | 120.5KB | 73.8KB |
| 2d2b5cafc integration | **471.4KB** | **超 11.4KB** | 139.4KB | 125.5KB | 75.1KB |
| c1fdc935e 预演 HEAD | **471.7KB** | **超 11.7KB** | 139.4KB | 125.8KB | 75.1KB |

> 基线本身只剩 4.1KB 余量（vite.config.ts:77-87 记录了 2026-09-10 那次上调到 471040 时「约 9KB 余量;仍不许把教程目录/admin 域量级的大模块静态接进入口」）。审计 B 轮往入口闭包塞了约 15.5KB gzip。**v2：t-1348 已选「拆动态 import」路线落地（`77e1f35dc`，阈值不动）**，见下表最后一行；**集成⑤合入后仍须在 integration 上复跑 `npm run build --workspace packages/web-react` 直到 exit 0**，否则 §4.5 必然失败。

| 基点（v2 追加） | 首屏闭包 gzip | 与预算 471040 B 的关系 | main | tapePayload | styles |
|---|---|---|---|---|---|
| f6572abb6 预演 v2 HEAD（c97a750f8 + f1952819f + 65019b5dc） | **447.3KB（458056 B）** | **余量 12.7KB** ✅ | 129.8KB | 123.2KB | 77.6KB |

### 1.3b v2 复跑（预演 HEAD `f6572abb6`；日志见附录 C `gates-head-2/`，脚本 `run-gates-head-2.ps1`）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ exit 0（66s） |
| ui-preview 场景类型 | `npm run typecheck:preview --workspace packages/web-react` | ✅ exit 0 |
| 教程同步门 | `npm run check:tutorials` | ✅ `check:tutorials OK · 26 capabilities · 12 real-world cases · 26 media pairs` |
| 迁移编号/登记门（canonical 新增 0281） | `npx tsx scripts/check-migration-order.ts`（= `lint:migration-order`） | ✅ `283 支迁移(其中 66 支在基线 0217 之后新增), requiredMigrations 161 条登记完整且有序` |
| protocol 单测（canonical 改 `engineModels.ts`） | `npx tsx --test packages/protocol/src/__tests__/engineModels.test.ts` | ✅ 14/14 |
| commercial 单测（canonical 改 `cursorCliWrapper.test.ts`） | `npx tsx --test --test-force-exit packages/commercial/src/__tests__/cursorCliWrapper.test.ts` | ❌ 55/57 · **Windows 假阳性**（R9），Linux 复跑 |
| 受影响模块 vitest（v1 的 7 文件 + budget-fix 触碰的 `MarkdownImpl.test.tsx`、`chat/media.test.tsx`） | `cd packages\web-react; npx vitest run … --maxWorkers=1` | ✅ `Test Files 9 passed (9) · Tests 295 passed (295)` 102s |
| **生产构建（R1 门）** | `npm run build --workspace packages/web-react` | ✅ **exit 0，`built in 18.84s`** |
| 首屏体量复算（仓库外脚本，同 vite 插件口径） | `node .audit-tmp\release-rehearsal\measure-first-screen.mjs packages\web-react\dist 471040` | ✅ `首屏闭包 13 个 chunk, gzip 合计 447.3KB (458056 B); 预算 460.0KB (471040 B); 余量 12.7KB` |
| Incident trailer 门 | `bash scripts/check-v5-fix-trailers.sh --repo . --head HEAD` | ✅ `PASS: 起点 e490e22af2cf, 冻结 tip 18 条, 检查 45 条 fix(v5) 提交`（f1952819f 是 feat(v5)，不入检查集） |
| 未跑 | `test:commercial:integ`（0281 的 `migration0281CursorSandUsableFamilies.integ.test.ts`、`migrate.integ.test.ts` 需要 PG）、`test:browser`、gateway 单测（v1 已证与 canonical 字节一致） | **NOT RUN**：本机无 PG / Linux 环境；CI 或服务器复跑（U5） |

### 1.4 canonical 自带问题（与本次合并无关，纯 3b7c38b9d 检出上复现）

1. R2：测试文案漂移 8 处 → canonical `App.test.tsx` 红。复现：`git worktree add --detach <tmp> 3b7c38b9d` 后 `Select-String -Path packages\web-react\src\App.test.tsx -Pattern '同时作为新会话默认'`（4 命中）；`AgentPicker.tsx:277` 已是新文案。
2. R3：`check-v5-incident-regressions.ts` FAIL。复现：同一临时检出里 `npx tsx scripts/check-v5-incident-regressions.ts` → `Error: [incident-regressions] INC-20260915-ADVISOR-1M-DUP-PICKER: 没有 browser/live-e2e/deploy-gate 证据时必须写 proofPending{reason,since}`（脚本 `fail()` 抛出即停，后面是否还有别的错误未知，补完这条要再跑一遍）。
3. **R0（v2）**：`f1952819f` 不是「问题」而是**发布口径变化**——带迁移 0281（含 `ALTER … DROP CONSTRAINT`，作者自注需 `OC_V5_ALLOW_BREAKING_MIGRATION=1`）。本机能验的：`lint:migration-order` ✅、`test:protocol` ✅、追合零冲突；本机验不了的：0281 在 selfhost DB 上的三条前置与 `schema_migrations` 现状（U7）、breaking DDL 放行的拍板（U8）。复现口径：`git show f1952819f --stat`、`git show f1952819f:deploy/v5/release-metadata.json | jq '.requiredMigrations[-1]'` → `0281_cursor_sand_usable_families`。

### 1.5 本机（Windows）假阳性汇总

- R4 CRLF 哈希不符；R6 gateway 三条 POSIX/symlink 用例；R9 `cursorCliWrapper.test.ts` 55 条（spawnSync 直跑 `.sh` / POSIX `test`）。
- `npm ci` 后 `packages/cli/src/index.ts`、`packages/mcp-memory/src/index.ts` 显示 `M`（bin 行尾），`git diff` 无内容（TEAM_PLAYBOOK §7）。
- jq：本机无；trailer 门用 `.audit-tmp\release-rehearsal\jqbin\jq.exe`（jq-1.7.1，仓库外）+ Git for Windows bash 跑通。

## 2. 发布前置清单

### 2.1 代码 / 分支侧（发布执行前必须全绿）

| # | 前置 | 出处 | 本次状态 |
|---|---|---|---|
| C1 | canonical 目标 SHA 上 `npm run build --workspace packages/web-react` exit 0（first-screen-budget 过） | deploy-v5-selfhost.sh:1109-1128（构建失败 → `die "web-react 构建失败"`，live 不动） | ⚠ integration `c97a750f8` 单独 ❌（R1）；**integration + canonical f1952819f + budget-fix 65019b5dc（预演 f6572abb6）✅ 447.3KB / 余量 12.7KB**。集成⑤合入 budget-fix 后在 integration 上复跑（§3.2）|
| C2 | `scripts/check-v5-fix-trailers.sh --head <目标 SHA>` PASS | deploy-v5-selfhost.sh:1951-1972、:2013；`check-v5-fix-trailers.sh:24-26` 用法 | ✅ 在 c1fdc935e 上 PASS；integration 再动过后**重跑** |
| C3 | 目标 SHA 已在 `origin/feat/v5-selfhost` 上（服务器只 `git fetch` + ff） | `oc-lease.sh` register 阶段「sha 必须已在远端分支上」；PLAYBOOK §4.2 pinned SHA 须是 HEAD 或祖先 | 待 §3 |
| C4 | 提交 subject 无 `fix(v5)`（审计侧）；canonical 自带的两条 fix(v5) trailer 合法 | 决策 d-26；`check-v5-fix-trailers.sh:16-19` | ✅（R5） |
| C5 | **（v2 改写）** canonical `f1952819f` 带 `packages/commercial/src/db/migrations/0281_cursor_sand_usable_families.sql` 并登记 requiredMigrations → 服务器 STEP 3 迁移门**预期 HAS_MIGRATION=1**（DB 缺口 + live..候选 git diff 双判）；0281 含 `ALTER TABLE … DROP CONSTRAINT`（L248-249）→ `classify_pending_migration_file` 默认 `die`，**必须 `OC_V5_ALLOW_BREAKING_MIGRATION=1`**；apply 由 STEP 6b `run_migrations_from_release` 在翻转同一把锁内做，需 `$rel/node_modules`（build_master_release 产物自带）与 `/etc/openclaude/commercial-v5-selfhost.env` 的 DB URL | master-lib:756-775（breaking 分类）、:792-822（DB 缺口只读比对，`sudo -u postgres psql`）、:824-856（分类 + 放行开关）、:862-925（门主体）、:1146-1158（runner）；deploy-v5-selfhost.sh:2495-2505、:2598-2609 | ⚠ 审计侧仍无 migrations（`git diff --name-only 210b99678 c97a750f8 -- '**/migrations/**'` 为空）；canonical 侧 +1。本机 `lint:migration-order` ✅。放行与前置核对 → U7 / U8 |
| C10 | **（v2 新增）** `platform-runtime/bin/oc-cursor.sh` 有变 → `--deploy` 会重建 platform bundle；默认**拷工作树**，服务器工作树必须干净，否则加 `--allow-dirty --platform-from-head` | deploy-v5-selfhost.sh:30-36、:1982-1998；PLAYBOOK §4.1 :343 | 待服务器 `git status -sb`（§4.0） |
| C11 | **（v2 新增）** `packages/protocol/src/engineModels.ts` 有变 → master 进程 + runtime source release 两轴都要新制品；`--deploy` 一次构建三面已覆盖，无需额外动作 | PLAYBOOK §4.1 :340、:342；deploy-v5-selfhost.sh:2014-2022 | ✅ `test:protocol` engineModels 14/14；runtime-release 由 `build_runtime_release` 从 HEAD archive |
| C6 | 依赖未变（`package-lock.json` 无 diff）→ 不需要 `--force-npm-ci`；注意 `ensure_node_modules` 见到 `node_modules` 目录**就跳过 `npm ci`**（deploy-v5-selfhost.sh:1094-1107），若将来 lock 变了必须 `--force-npm-ci` | deploy-v5-selfhost.sh:437、:1094-1107 | ✅ 仅 `packages/web-react/package.json` 加了 `typecheck:preview` 脚本 |
| C7 | typecheck / typecheck:preview / check:tutorials / 受影响 vitest 全绿 | TEAM_PLAYBOOK §3 | ✅（§1.3） |
| C8 | CI `check:v5` 的 `check:v5:incidents` 红（R3）→ 需 canonical 侧补 proofPending 或真 proof；**不阻断 selfhost `--deploy`**，但 AGENTS.md 的「常规完成 = 测试实跑通过 + 部署 + smoke」口径下应视为待办 | AGENTS.md:13-16；root `package.json` `check:v5` | ⚠ 待 canonical 维护者 |
| C9 | 不碰 `changelog.json`、`apps/windows/**`、`deploy/**`（本次 diff 无） | TEAM_PLAYBOOK §7/§9；PLAYBOOK §4.1 manual-only globs | ✅ |

### 2.2 服务器侧硬门（脚本会自己判，这里列出让人先自查）

| # | 前置 | 出处 |
|---|---|---|
| S1 | 必须在 `/opt/openclaude/openclaude-v5-selfhost` 内执行（`REPO_ROOT` 精确匹配，否则 die） | deploy-v5-selfhost.sh:511-512 |
| S2 | 命令齐全：docker psql jq curl openssl rsync git ss systemctl iptables npm；`bun` 可执行（`/usr/local/bin/bun` 或 `OC_BUN_BIN`） | :595-607 |
| S3 | 仓内文件齐全：`setup-host-net.sh`、runtime lib、`runtime-src-excludes.txt`、platform-runtime 源、seed CLI、unit 模板 | :608-613 |
| S4 | `/etc/openclaude/secrets.env` 存在且含非空 `ARK_CODING_PLAN_KEY` | :535-539 |
| S5 | **个人版 `openclaude.service` active 且 `127.0.0.1:18789/healthz` = 200**（部署前后都查；红线：绝不 touch 个人版 / 18789 / `openclaude_personal_sessions` / Redis db0） | :13-14、:527-533、:1842 |
| S6 | runtime 镜像 `openclaude/openclaude-runtime:v5-cli-codex0153-grok105-zcode381-slim` 已在本机 docker（**脚本不 build 镜像**） | :89-92、:541-546 |
| S7 | `172.31.0.0/16` 未被其它 docker 网络占用 | :548-562、:617-619 |
| S8 | `--deploy` 专属：`/etc/openclaude/commercial-v5-selfhost.env` 存在；`openclaude-v5-net` 存在；live symlink `/opt/openclaude/openclaude-v5-selfhost-live` 存在（首次翻转已完成） | :1999-2004；master-lib:7-8 |
| S9 | 工作树干净，或明确 `--allow-dirty --platform-from-head`（三面语义：master live / runtime-release 永远 `git archive HEAD`；platform bundle 默认拷工作树） | :30-36、:439-443、:1934-1944、:1982-1998 |
| S10 | 根盘可用 ≥ 8GiB（冷装 ~1.8G + staging 峰值） | master-lib:420-431 |
| S11 | Lease Center 无 open train | :1350-1353；`scripts/oc-lease.sh status` |
| S12 | 发布锁 `/run/openclaude-v5-selfhost/deploy.lock`：写路径排队等锁默认 2400s（`OC_V5_SELFHOST_DEPLOY_LOCK_WAIT`） | :139-148、:400-409、:444-447 |
| S13 | `python3` 可用（仅迁移门分类 breaking DDL 时用；本次预期无迁移） | master-lib:756-758 |
| S14 | 生效面：`packages/gateway/**`（canonical advisorMode.ts / server.ts）= runtime source release 轴 → `--deploy` 从 HEAD `git archive` 构建 runtime-release 并写四元组；`packages/web-react/**` = master release 内 `dist`；`docs/**` / `scripts/**` 随 release 树走，无运行时效果 | PLAYBOOK §4.1 矩阵 :338-345；deploy-v5-selfhost.sh:27-29、:1454、:2021-2026 |

### 2.3 本机无法满足、需服务器或用户的项

| # | 项 | 说明 |
|---|---|---|
| U1 | SSH 到 v5-dev（38.55.252.217 / 186.244.238.121:22） | 本机拿到 banner 但密钥未授权（任务书明令不要尝试登录）。§4 全部由有通道的会话/用户执行。决策 d-24 亦如此约定。 |
| U2 | 推 canonical `origin/feat/v5-selfhost` | 决策 d-24：「合入 canonical 与 Lease Center 发布需要 v5-dev 访问,留给有服务器通道的会话/用户」；成员只推自己的分支。 |
| U3 | R1 修复 | 需指挥官拍板方案，shell owner 落地；不在 t-1279 边界（不改业务代码）。 |
| U4 | R3 修复 | canonical 侧 incidents.json 数据问题，非本组文件归属。 |
| U5 | gateway 单测、`check:v5:incidents`、`test:browser` 在 Linux 上的真结果 | 本机 Windows 假阳性/未跑；服务器或 CI 复跑。 |
| U6 | `--deploy --dry-run` 的真实计划输出、DB 缺口比对、磁盘/端口/unit 现状 | 只能在服务器上看。 |
| U7 | **（v2）0281 在 selfhost DB 上的前置**：`schema_migrations` 是否已有 `0280_cursor_haiku_45`、尚无 `0281_…`；`model_catalog`/`model_pricing` 里 `cursor-grok-4.6-high`、`cursor-gemini-3.8-flash-high`、`cursor-haiku-4.5` 是否 active+enabled（0281 L40-57 三条 `RAISE EXCEPTION`） | 只读 SQL 在 §4.0；不满足 → STEP 6b apply 失败 → `补偿: reason=migration-apply`，live 不动。注意早期 Cursor 家族迁移（0210/0220/0222/0247）按 `openclaude.migration_profile = 'v5-selfhost'` 分叉过，selfhost DB 的行状态不能想当然。 |
| U8 | **（v2）`OC_V5_ALLOW_BREAKING_MIGRATION=1` 的拍板**：0281 的 `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` 是换 CHECK（放宽 `cursor_external_usage_audit.model_id` 白名单），不是删表删列，作者已自注要放行；但放行会 ⚠ 写进部署日志（master-lib:850） | 指挥官按 d-1326/d-1450 代批或 `ask_decision`；发布执行者在 §4.4/§4.5 命令前加该 env。 |
| U9 | **（v2）`test:commercial:unit`（含 cursorCliWrapper）在 Linux 上的真结果** | 本机 Windows 假阳性（R9）；CI 或服务器复跑。 |

## 3. 本地步骤（canonical ff 与 push；由有通道者执行）

前提：集成⑤已把 budget-fix（`65019b5dc`）合进 integration 并在 integration 上 build 绿（C1）；integration 最终 HEAD 记为 `<INT>`。

```powershell
cd d:\code\test_project\test123\v5-selfhost
git fetch origin
git rev-parse origin/feat/v5-selfhost            # v2 实测 f1952819f…；若又前进了 → git log --stat f1952819f..origin/feat/v5-selfhost 看清新增面，回到 §1.1 用 merge-tree 重新看冲突集合
git merge-tree --write-tree --name-only <INT> origin/feat/v5-selfhost   # 冲突集合应仍是 §1.2 那 7 个（或子集）；f1952819f 的 9 个文件不会新增冲突（v2 实测）
```

3.1 让 integration 先吃下 canonical（在 integration 自己的工作树，指挥官操作；不要在预演分支上做）：

```powershell
git checkout feat/v5-selfhost-ocv5-audit-ux
git merge --no-ff origin/feat/v5-selfhost        # v2：= f1952819f，含 3b7c38b9d 全部内容
# 冲突：4 个源码文件若自 2d2b5cafc 起 integration 没再动过（v2 核对：到 c97a750f8 为止没动过），可直接复用预演解法：
git checkout d02cc7c5d -- packages/web-react/src/components/AgentPicker.tsx packages/web-react/src/components/tool/bodies.tsx packages/web-react/src/components/tool/bodyCards.test.tsx packages/web-react/src/components/tool/meta.ts
# （若 integration 后来又改过这四个文件 → 手工按 §1.2 取舍，别盲拷）
git checkout --ours -- packages/web-react/tutorial-sync.json packages/web-react/tutorial-sync-history-head.json packages/web-react/tutorial-sync-history.jsonl
git add -- packages/web-react/tutorial-sync.json packages/web-react/tutorial-sync-history-head.json packages/web-react/tutorial-sync-history.jsonl packages/web-react/src/components/AgentPicker.tsx packages/web-react/src/components/tool/bodies.tsx packages/web-react/src/components/tool/bodyCards.test.tsx packages/web-react/src/components/tool/meta.ts
npm run check:tutorials                          # 期望报 advisor-mode 漂移
npm run tutorials:accept -- --note "合入 canonical f1952819f：接受 OCV5-220 advisor-mode 文案 v4"
npm run check:tutorials                          # 期望 OK
git add -- packages/web-react/tutorial-sync.json packages/web-react/tutorial-sync-history-head.json packages/web-react/tutorial-sync-history.jsonl
git commit -m "merge(v5): 合入 canonical feat/v5-selfhost@f1952819f 到 integration（7 处冲突解法见 docs/audit/RELEASE.md §1.2；含 OCV5-225 迁移 0281）"
git cherry-pick c1fdc935e                        # R2：8 处测试文案对齐（若无冲突）
```

3.2 复跑门（全部 exit 0 才继续；v2 在预演 f6572abb6 上同口径全绿，见 §1.3b）：

```powershell
npm run typecheck --workspace packages/web-react
npm run typecheck:preview --workspace packages/web-react
npm run check:tutorials
npx tsx scripts/check-migration-order.ts         # v2：0281 登记/顺序门（期望「requiredMigrations … 登记完整且有序」）
npx tsx --test packages/protocol/src/__tests__/engineModels.test.ts   # v2：canonical 改了 engineModels.ts
cd packages\web-react; npx vitest run src/App.test.tsx src/components/AgentPicker.test.tsx src/components/tool src/components/MarkdownImpl.test.tsx src/components/chat/media.test.tsx --maxWorkers=1; cd ..\..
npm run build --workspace packages/web-react     # R1 门：必须绿（v2 预演态 447.3KB / 余量 12.7KB）
& 'C:\Program Files\Git\bin\bash.exe' -lc 'export PATH="/d/code/test_project/test123/.audit-tmp/release-rehearsal/jqbin:$PATH"; cd /d/code/test_project/test123/v5-selfhost && scripts/check-v5-fix-trailers.sh --repo . --head HEAD'
```

3.3 canonical 快进 + 推送（此时 integration 已包含 f1952819f，ff 一定成立；推之前再 `git fetch origin && git rev-parse origin/feat/v5-selfhost` 确认没有第三次前进）：

```powershell
git checkout feat/v5-selfhost
git merge --ff-only feat/v5-selfhost-ocv5-audit-ux
git rev-parse HEAD                                # 记为 <REL>，写进 §6 记录
git log --oneline -3
git push origin feat/v5-selfhost                  # 本机走代理（git 全局 http.proxy=127.0.0.1:7890，TEAM_PLAYBOOK §1）
git rev-parse origin/feat/v5-selfhost             # 必须 == <REL>
git push -u origin feat/v5-selfhost-ocv5-audit-ux # integration 分支也推上去做备份/评审入口
```

> 服务器侧若 `git fetch` 被代理掐断，用 `hotfix-checklist Step 3.2` 的写法：`env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy git fetch origin`。
> 推 canonical 本身**不会**触发部署：Lease Center 只对 `oc-lease register` 登记的搭车 sha 发车（`oc-lease.sh:2-12`）；人工发布走 §4。

## 4. 服务器命令序列（`/opt/openclaude/openclaude-v5-selfhost`，root）

每步都给「命令 → 预期输出 → 判据」。任何一步不满足判据就停，不要往下走。

### 4.0 就位与记录前值

```bash
cd /opt/openclaude/openclaude-v5-selfhost
git status -sb                      # 判据：分支 feat/v5-selfhost；干净。若有别人的脏文件 → §4.5 用 --allow-dirty --platform-from-head（deploy-v5-selfhost.sh:1982-1998）
git rev-parse HEAD                  # 记为 <OLD_HEAD>
readlink -f /opt/openclaude/openclaude-v5-selfhost-live          # 记为 <OLD_REL>（master-lib:8）
cat /opt/openclaude/openclaude-v5-selfhost-releases/.prev-release # 记为 <OLD_PREV>
jq -r .sourceCommit "$(readlink -f /opt/openclaude/openclaude-v5-selfhost-live)/.complete"   # 判据：== <OLD_HEAD>（live 与工作树对齐，否则先搞清为什么）
scripts/oc-lease.sh status --resource deploy:selfhost            # 判据：无 planned/building 的 open train（R8）
df -Pk /opt/openclaude | awk 'NR==2{print $4/1024/1024 " GiB free"}'  # 判据：≥ 8（S10）
# ── v2 新增：迁移 0281 只读前置（U7；两条都是 SELECT，不写盘）──
sudo -u postgres psql -X -d openclaude_v5_selfhost -tAc "SELECT version FROM schema_migrations WHERE version IN ('0280_cursor_haiku_45','0281_cursor_sand_usable_families') ORDER BY 1"
#   判据：只回 0280_cursor_haiku_45 → 0281 未 apply，§4.4/§4.5 预期 HAS_MIGRATION=1，需要 OC_V5_ALLOW_BREAKING_MIGRATION=1（U8）
#         两条都回 → 0281 已 apply（有人先跑过）；HAS_MIGRATION 仍会由 live..候选 git diff 判成 1、分类仍要求放行（master-lib:887-916），apply 阶段由 migrate.ts 按 schema_migrations 记账跳过（常规 runner 语义，本机未实跑验证）
#         连 0280 都没有 → 停：selfhost DB 落后于 canonical 3b7c38b9d 的 requiredMigrations，先搞清 live 是哪个 release
sudo -u postgres psql -X -d openclaude_v5_selfhost -tAc "SELECT c.model_id, c.state, p.enabled FROM model_catalog c JOIN model_pricing p USING (model_id) WHERE c.engine='cursor' AND c.model_id IN ('cursor-grok-4.6-high','cursor-gemini-3.8-flash-high','cursor-haiku-4.5') ORDER BY 1"
#   判据：3 行，state=active、enabled=t（0281 L40-57 三条 RAISE EXCEPTION 的前置）；缺任何一行 → STEP 6b 必败（补偿、不翻转），先停下问 canonical 维护者
```

### 4.1 `--status`（前）

```bash
scripts/deploy-v5-selfhost.sh --status
```
预期（deploy-v5-selfhost.sh:1847-1911）：`worktree:` / `HEAD:` / `live: …-live → <OLD_REL>` / `prev: <OLD_PREV>` / `env: … present mode=600|640` / `OC_RUNTIME_IMAGE=…slim` / `OC_RUNTIME_RELEASE=…` / `OC_PLATFORM_BUNDLE=…` / `unit master: active` / `unit egress: … serving=<slotA|slotB|legacy>` / `unit hostnet|ccb-proxy|sshgate: active` / `spa dist: present` / `.complete: present <sha>` / `personal: active` / `net: openclaude-v5-net 存在` / `pg: openclaude_v5_selfhost 存在` / `port 18790: listen · 18892: listen · 18789: listen`。
判据：master/egress/personal 全 active；live 非 MISSING/dangling；把整段输出贴进 §6。

### 4.2 `--smoke`（前 · 现网健康基线）

```bash
scripts/deploy-v5-selfhost.sh --smoke
```
预期（:1789-1845）：`✓ /healthz 200 + controlPlaneEnabled + leadership.state=leader` → `✓ GET / 返回 SPA index.html(oc-build=<hash> src=<OLD_REL>/packages/web-react/dist/index.html)` → SSH 规则断言 → `✓ 个人版 openclaude.service 仍 active 且 :18789 仍 200` → `✓ smoke 通过`。
判据：exit 0。**现网本来就不健康 → 先按 AGENTS.md「只读诊断边界」（:19-27）定位，不要拿发布当修复。**

### 4.3 关于 `--preflight`（R7）

```bash
scripts/deploy-v5-selfhost.sh --preflight   # 可跑，但在 live 实例上预期非 0
```
预期：走完 `preflight_common`（S2-S7）后在 `preflight_residue` 处 `✗ 发现 docker 网络 openclaude-v5-net。视为 V5 残留,拒绝自动 adopt/删除。…若这是本 selfhost 实例请改跑 --deploy。`（:566-568）。
判据：**这条 ✗ 是预期**；前面 `preflight_common` 若先 die（缺命令/密钥/镜像/个人版不 200/网段冲突）才是真问题。真正的更新前置用 §4.4。

### 4.4 `--deploy --dry-run`（只读计划）

```bash
git fetch origin feat/v5-selfhost
git rev-parse origin/feat/v5-selfhost        # 判据：== <REL>（§3.3）
git merge --ff-only origin/feat/v5-selfhost  # 判据：Fast-forward；HEAD == <REL>。拒绝 ff（本地有私提交）→ 停，先搞清是谁的提交
git rev-parse HEAD
OC_V5_ALLOW_BREAKING_MIGRATION=1 scripts/deploy-v5-selfhost.sh --deploy --dry-run   # v2：0281 含 ALTER…DROP CONSTRAINT，不带此 env 会在 STEP 3 die（U8 拍板后再加）
```
预期（:1974-2031，dry-run 不加锁 :404-405）：`══ v5 selfhost --deploy(…) ══` → `preflight_common` 静默通过 → `── 脏工作树三面语义 ──` → `── Incident trailer 门(HEAD=<REL 前 12>,构建前 fail-closed) ──` + `✓ [fix-trailers] PASS: …` → `── source=<REL> 构建三面制品(失败则 live 不动) ──` 各步 `[dry-run] …` → `── 进入 --cutover 翻转窗口 …` 的 `STEP 1..10 [dry-run]` 计划 → `✓ --cutover --dry-run 执行计划结束(未改 unit / 未切 symlink / 未重启 / 未迁库 / 未武装真 survivor)`。
判据：exit 0；trailer 门 PASS；**`STEP 3 迁移门`（v2 改写）预期打印 `迁移门: DB 缺口 HAS_MIGRATION=1 missing:` + `0281_cursor_sand_usable_families` → `⚠ 破坏性 DDL 被 OC_V5_ALLOW_BREAKING_MIGRATION=1 放行: packages/commercial/src/db/migrations/0281_cursor_sand_usable_families.sql (ALTER ... DROP)` → `✓ 迁移门: 分类通过(含 migration 时 apply 必须与翻转同一把锁、同一窗口)` → `HAS_MIGRATION=1 → apply 与翻转必须同一把锁、同一窗口` + `[dry-run] 对着 <rel> 跑 migration runner(失败则不翻转,不回滚 schema)`**（master-lib:874-885、:920-921；deploy-v5-selfhost.sh:2495-2502）。若打印的 missing 不止 0281、或出现 `迁移门: … 未列入 … requiredMigrations` / `命中破坏性 DDL(…)。默认拒绝` → 停：前者说明 selfhost DB 落后（U7 第三种情形），后者说明 env 没带上；若 HAS_MIGRATION=0，回头看 §4.0 第一条 SQL 是否两条都在。`工作区不干净` die → 决定是否加 `--allow-dirty --platform-from-head`（C10：oc-cursor.sh 有变，platform bundle 别吃脏树）。

### 4.5 `--deploy`（真发布；持锁；单次 15–30 分钟量级：vite + runtime + platform 三面构建 + 翻转）

```bash
OC_V5_ALLOW_BREAKING_MIGRATION=1 scripts/deploy-v5-selfhost.sh --deploy 2>&1 | tee /opt/openclaude/tmp/deploy-selfhost-$(date -u +%Y%m%dT%H%M%SZ).log
# 有别人的脏文件时：OC_V5_ALLOW_BREAKING_MIGRATION=1 scripts/deploy-v5-selfhost.sh --deploy --allow-dirty --platform-from-head
# v2：env 前缀是 0281 的 ALTER…DROP CONSTRAINT 分类放行（U8），只对本次含 0281 的发布有效；下次没有 breaking 迁移就不要带
```
预期顺序与判据（:1974-2031 → :2444-2700）：
1. `⚠ 人工发布已登记为 manual train tr-…`（:1362）。
2. `✓ [fix-trailers] PASS`；`── source=<REL> 构建三面制品 ──`；`✓ web-react dist oc-build=<NEW_BUILD>`（:1127，记下 `<NEW_BUILD>`）；`✓ master release=/opt/openclaude/openclaude-v5-selfhost-releases/rel-…`（:2019，记 `<NEW_REL>`）；runtime-release / platform bundle 构建完成。**这一段任何 die 都不会改现网**（:2014「失败则 live 不动」）。R1 若未修，就死在这里：`✗ web-react 构建失败。补救: 看上方 tsc/vite 输出…`。
3. `══ v5 selfhost --cutover DRY=0 JOINT=1 log=/opt/openclaude/tmp/cutover-<ts>.log ══`，STEP 1 持锁 → STEP 2 `✓ 静态门通过 <NEW_REL> sourceCommit=<REL 前 9> digest=…`、`✓ tsx 自检通过`、`unit snapshot=…` → **STEP 3 迁移门（v2）`DB 缺口 HAS_MIGRATION=1 missing: 0281_cursor_sand_usable_families` + `⚠ 破坏性 DDL 被 OC_V5_ALLOW_BREAKING_MIGRATION=1 放行` + `✓ 迁移门: 分类通过`** → STEP 4 `backup=<BREAKGLASS>/unit-backups/pre-cutover-<ts>` 与 `.prev-release=<OLD_REL>` → STEP 5 装 unit + `daemon-reload` → STEP 6 grace 标记 → **STEP 6b（v2）`含 migration: 当场 apply(与下一步翻转同一把锁、同一窗口)`：在 `<NEW_REL>` 里 `npx --no-install tsx packages/commercial/src/db/migrate.ts`（`COMMERCIAL_AUTO_MIGRATE=1`，`PGOPTIONS=-c openclaude.migration_profile=v5-selfhost`，master-lib:1146-1158），期望 migrate.ts 输出中 0281 applied；phase → `migrated`** → STEP 7 `原子挂 live symlink … → <NEW_REL>` → STEP 8 `joint: oc_hotcfg_activate_saga 写四元组 + restart + smoke` → `✓ --cutover 完成 live → <NEW_REL>` → `🎫 lease train tr-… → committed` → `✓ --deploy 完成 live → <NEW_REL>`。
4. 判据：最后两行必须同时出现；exit 0。出现 `补偿: reason=…` 即进入 §5.1 自动回滚路径，看它的一级/二级结论（**v2：`reason=migration-apply` = 0281 在 DB 上 RAISE EXCEPTION 或 runner 出错，live 未动、schema 未回滚（DO 块本身原子）→ 看 cutover 日志里 0281 的报错文案对照 U7**）；出现 `.manual-recovery-required` → §5.3。

### 4.6 `--smoke`（后）

```bash
scripts/deploy-v5-selfhost.sh --smoke
curl -fsS http://127.0.0.1:18790/healthz | jq '{ok, cp:.runtime.controlPlaneEnabled, leader:.runtime.leadership.state}'
curl -fsS http://127.0.0.1:18790/ | grep -o 'name="oc-build" content="[0-9a-f]*"'
```
判据：`✓ smoke 通过`；`oc-build` == `<NEW_BUILD>`（smoke 自己也会比对 live release dist，:1836-1839）；`{ok:true, cp:true, leader:"leader"}`；个人版 18789 仍 200。

### 4.7 `--status`（后）

```bash
scripts/deploy-v5-selfhost.sh --status
```
判据：`live: … → <NEW_REL>`；`prev: <OLD_REL>`；`.complete: present <REL>`；`OC_RUNTIME_RELEASE` 已变为新值（S14）；master/egress/personal 全 active。整段贴进 §6。

### 4.8 功能验证（浏览器，公网入口或隧道；≤10 分钟）

canonical 6 提交（OCV5-220/223）：
1. 顶栏智能体选择器 → 全能助手 → 「顾问」：顾问型号下拉**不再**出现 GPT-6-Astra/Sol/Terra/Luna 各两条（1M 双子已隐藏，a6584a430）。
2. 把顾问配成一个当前目录里没有的型号后重开选择器：显示「已配置的顾问 … 当前不可用，请重新选择。不会自动改成别的型号。」且下拉为空选占位（不静默回退第一项）。
3. 勾选框文案为「同时设为新对话的默认协作方式」。
4. 发起一次顾问咨询：工具卡进行中显示「顾问思考中 · 已用时 N 秒」+「问了什么」；结束后显示「顾问 <型号> · 已完成/失败 · <人话时长>」，不出现 `settled`/`failed` 原词。
5. 教程中心 → 顾问模式：正文为 v4（「只出主意的顾问」「目前只有 GLM、MiniMax 这类会话可以咨询」）。

canonical 第 7 提交（OCV5-225，`f1952819f`，依赖 0281 已 apply）：
6. 型号选择器（Cursor 引擎）：Grok 4.6 家族对普通用户可见（visibility admin→public）；Composer 2.5 重新可选；出现 GPT-5.6 Luna（Sand）low/medium/high/xhigh/max × 普通/Fast 共 10 档；出现 Gemini 3.1 Pro 单档；**不出现** 1M 双子。
7. 服务器只读复核（可替代 6 的部分）：`sudo -u postgres psql -X -d openclaude_v5_selfhost -tAc "SELECT count(*) FROM model_catalog WHERE engine='cursor' AND model_id LIKE 'cursor-gpt-5.6-luna-%' AND state='active'"` → `10`（0281 L291 自检同口径）；`… "SELECT version FROM schema_migrations WHERE version='0281_cursor_sand_usable_families'"` → 1 行。

审计侧：按 `docs/audit/SUMMARY.md` 的模块清单抽查各模块的 P1 修复项各一条（尤其 shell / composer / messages 高频面），并硬刷新确认 `UpdateBanner` / 新 `oc-build` 已生效（SW 更新）。

## 5. 回滚

### 5.1 cutover 内自动补偿（不用人干预，但要看结论）

- 触发：STEP 5 之后任何一步失败 → `cutover_compensate <reason>`（:2231-2243）。
- 一级：`.prev-release` canonicalize + digest 复算 → 原子把 live symlink 切回 `<OLD_REL>` → 重启 egress/master → healthz 复合门（:2194-2209）。
- 二级：从本次 forensics 备份恢复 installed unit + daemon-reload + restart + 健康硬门（:2219-2222）。
- 两级都失败：写 `/opt/openclaude/openclaude-v5-selfhost-releases/.manual-recovery-required` 并大声退出（:2223-2228）→ §5.3。
- 幸存者：覆盖第一个 unit 前武装独立 `systemd-run` survivor（`/opt/openclaude/v5-selfhost-breakglass/cutover-survivor.sh`，:2119-2165）；executor 消失且 phase 未到 smoked/committed 时即使健康绿也二级恢复（:2666-2672 说明）。成功路径 `--disarm` 必须确认 committed marker（:2680-2683）。
- 迁移：本次预期无；即便有，`失败则不翻转,不回滚 schema`（:2601）。

### 5.2 手动回滚到上一个 rel-*（发布成功后才发现问题）

```bash
cd /opt/openclaude/openclaude-v5-selfhost
PREV=$(tr -d '[:space:]' </opt/openclaude/openclaude-v5-selfhost-releases/.prev-release); echo "$PREV"   # 判据：== <OLD_REL>，不是 none
PREV_SHA=$(jq -r .sourceCommit "$PREV/.complete"); echo "$PREV_SHA"                                        # 判据：== <OLD_HEAD>
# 静态门要求候选 sourceCommit == 工作树 HEAD（master-lib:691-712，expected 来自 cutover_expected_source_commit → source_commit = HEAD，deploy-v5-selfhost.sh:2434-2441、:1309-1311）
git checkout --detach "$PREV_SHA"
scripts/deploy-v5-selfhost.sh --cutover --release="$PREV" --dry-run    # 判据：STEP 2 静态门通过、STEP 3 HAS_MIGRATION=0、计划结束 exit 0
scripts/deploy-v5-selfhost.sh --cutover --release="$PREV"              # 判据：✓ --cutover 完成 live → <OLD_REL>
scripts/deploy-v5-selfhost.sh --smoke                                  # 判据：✓ smoke 通过；oc-build 回到旧值
scripts/deploy-v5-selfhost.sh --status                                 # 判据：live → <OLD_REL>；prev → <NEW_REL>
```
说明：`--cutover` 是「已有 rel-*、只翻转」的手动逃生入口，不重建制品（:23、:29、:423）；`--release=` 必须是绝对路径的普通目录且未被标 `.poisoned`（master-lib:930-937）。回滚后再回到分支：`git checkout feat/v5-selfhost`（下一次发布前 HEAD 必须重新对齐目标 SHA）。按 `hotfix-checklist` 应急规则：**rollback 已发布版本前先告诉 boss**（:165-172）。
**v2 · 迁移与回滚**：翻转回 `<OLD_REL>` **不会撤销 0281**（脚本任何路径都不回滚 schema，:2601）。0281 是加目录行 / 翻 visibility / 放宽 `cursor_external_usage_audit` 的 CHECK，旧 release（3b7c38b9d 代码）对多出来的目录行与更宽的 CHECK 应能兼容，但旧前端/protocol 不认识 `gpt-5.6-luna-sand` 等新 family——回滚后若选择器出现空白/未知型号项，属预期，不要再手工改 DB。回滚时 `--cutover --release=<OLD_REL>` 的 STEP 3 迁移门对旧 release 做 DB 缺口比对：旧 metadata 的 requiredMigrations 是 DB 的子集 → HAS_MIGRATION=0，不需要 `OC_V5_ALLOW_BREAKING_MIGRATION`。

### 5.3 失败处理矩阵

| 现象 | 含义 | 处置 |
|---|---|---|
| `✗ web-react 构建失败`（first-screen-budget）| R1 未修；live 未动 | 修 R1，回 §3.2 复跑 build，再来 |
| `Incident trailer 门拒绝发布(rc=1)` | 有 fix(v5) 提交 trailer 不合规；live 未动 | 按提示补 trailer / waiver；**`OC_V5_SKIP_TRAILER_GATE=1` 只给真止血**，会打 ⚠ 留痕且 CI 仍红（:1953-1956、:433-435） |
| `⚠ trailer 门不可判(rc=2)` | 缺 jq / marker 不可达 | 放行但人工核对 R5 结论 |
| **（v2）** `迁移门: packages/commercial/src/db/migrations/0281_… 命中破坏性 DDL(ALTER ... DROP)。默认拒绝。` | 没带 `OC_V5_ALLOW_BREAKING_MIGRATION=1`；STEP 3 die，live 未动（dry-run 与真发布都会撞） | U8 拍板后带 env 重跑 §4.4 → §4.5 |
| **（v2）** `迁移门: DB 缺口 HAS_MIGRATION=1 missing:` 列出 **不止** 0281 | selfhost DB 落后于 canonical 3b7c38b9d 的 requiredMigrations（live 不是 3b7c38b9d 或早先迁移没跑齐） | 停；§4.0 第一条 SQL + `--status` 看 live `.complete` 的 sourceCommit；别一次补多支迁移 |
| **（v2）** `补偿: reason=migration-apply` | 0281 在 DB 上 `RAISE EXCEPTION`（前置缺 grok-4.6-high / gemini-3.8-flash-high / haiku-4.5，或 Luna/Gemini 3.1 Pro 行已被人手工建过且漂移，L82/L175/L243）或 runner 报错；live 未翻、schema 未变 | 看 `/opt/openclaude/tmp/cutover-<ts>.log` 里 `0281 …` 文案；DB 现状按 U7 只读查；不要手工 `psql -f` 补跑（PLAYBOOK §4.5 人工 apply 须复刻 runner 记账，且这里 apply 与翻转要同窗口） |
| `Lease Center 有 open train tr-…(status),拒绝并行人工发布` | 有搭车列车在跑/卡着 | `scripts/oc-lease.sh status`；确认死车后 `scripts/oc-lease.sh train resolve --id <tr> --as failed --reason "…"`（`oc-lease.sh:12`），再发 |
| `工作区不干净` | 别人的未提交文件 | `--deploy --allow-dirty --platform-from-head`（三面都走已提交树） |
| 等锁超过 2400s | 另一发布进程持锁 | `ls -l /run/openclaude-v5-selfhost/`，找持有者 pid（:194-209 holder info）；不要手删锁 |
| `静态门: sourceCommit=… 与预期 … 不一致` | 工作树 HEAD ≠ 候选 release 的 sourceCommit | §5.2 先 `git checkout --detach <sha>` |
| `找不到 sourceCommit==HEAD(…) 的完整 master release` | `--cutover` 没给 `--release=` 且没有匹配 HEAD 的 rel-* | 给 `--release=`，或 `--build-master-only` 先建 |
| `补偿: reason=… ` 后 `一级回滚后复合健康通过` / `二级恢复且健康确认` | 自动回滚成功，现网回到 `<OLD_REL>` | 看 `/opt/openclaude/tmp/cutover-<ts>.log` 找 reason 根因，修完再发 |
| `.manual-recovery-required` 出现 | 两级补偿都失败 | 立即告知 boss；按 :2226-2227：从 `<BREAKGLASS>/unit-backups/pre-cutover-<本次>` 装 live unit + `daemon-reload` + restart，`cutover-survivor.sh --disarm`；`/opt/openclaude/v5-selfhost-breakglass/restore-worktree-units.sh` 是最后手段（:1924） |
| smoke 通过但 `GET / oc-build` ≠ 新 dist | live 没指到新 release 或 master 未重启 | `--status` 看 live；`systemctl restart openclaude-v5-selfhost.service` 后再 smoke（:1835、:1839 补救文案） |
| 个人版 18789 非 200 | 红线被碰或个人版自身故障 | 立停；`systemctl status openclaude.service`；这是发布前就该绿的（S5） |

## 6. 发布记录模板（每次发布复制一份追加到 `docs/audit/RELEASE.md` 末尾或 `docs/audit/archive/`）

```markdown
### 发布记录 · <YYYY-MM-DD HH:MM UTC+8> · v5 个人版 selfhost

- 执行人 / 会话：
- 目标 SHA <REL>：`…`（origin/feat/v5-selfhost 同值 ✅/❌）
- 前值：<OLD_HEAD> `…` / <OLD_REL> `rel-…` / <OLD_PREV> `rel-…`
- 前置门（§2.1）：build ✅ · trailer ✅ · typecheck ✅ · typecheck:preview ✅ · check:tutorials ✅ · vitest ✅ · check:v5:incidents ✅/❌(说明)
- §4.0 oc-lease status：无 open train ✅ · 磁盘 <n> GiB ✅
- §4.0 迁移只读前置（v2）：schema_migrations 有 0280 / 无 0281 ✅ · 三条前置行 active+enabled ✅
- 迁移（v2）：HAS_MIGRATION=1 · `OC_V5_ALLOW_BREAKING_MIGRATION=1` 放行（U8 批准人 / 决策号：…）· STEP 6b 0281 applied ✅（cutover 日志行：…）
- §4.1 --status（前）：<粘贴>
- §4.2 --smoke（前）：✅ oc-build=<old>
- §4.4 --deploy --dry-run：✅ trailer PASS · HAS_MIGRATION=0 · 脏树：无/--allow-dirty --platform-from-head
- §4.5 --deploy：开始 <t0> 结束 <t1>；manual train `tr-…`；<NEW_REL> `rel-…`；<NEW_BUILD> `…`；结论 `✓ --deploy 完成 live → …` ✅/补偿(reason=…)
- §4.6 --smoke（后）：✅ oc-build=<new> · healthz ok/cp/leader ✅ · 个人版 200 ✅
- §4.7 --status（后）：<粘贴>
- §4.8 功能验证：1 ✅ 2 ✅ 3 ✅ 4 ✅ 5 ✅ · 审计抽查：<模块/条目>
- 回滚：未触发 / §5.1 自动(一级|二级) / §5.2 手动 → live 现为 `rel-…`
- 日志：/opt/openclaude/tmp/deploy-selfhost-<ts>.log · /opt/openclaude/tmp/cutover-<ts>.log
- 遗留：
```

## 附录 A · canonical 6 提交（210b99678..3b7c38b9d，27 文件 +366/−73）

| SHA | subject | 触碰面 |
|---|---|---|
| `7b2ae241d` | fix(v5): make advisor consult card and copy human-readable（trailer exact 映射 → INC-20260915-ADVISOR-CONSULT-CARD） | web-react（AgentPicker / ChatHeader / tool bodies·format·meta / collaborationConfig / productCapabilities / tutorialCatalog / browser-tests ocv5-210-*） |
| `ef9320eea` | chore(v5): merge OCV5-220 advisor UX | merge |
| `848bc9dcc` | chore(v5): register INC-20260915-ADVISOR-CONSULT-CARD for OCV5-220 | e2e/session-display/incidents.json |
| `7ee192f12` | chore(v5): merge OCV5-220 incident trailer mapping | scripts/check-v5-fix-trailers.sh、scripts/check-v5-incident-regressions.ts（exact 映射表） |
| `a6584a430` | fix(v5): hide Codex 1M twins from advisor picker（Incident: INC-20260915-ADVISOR-1M-DUP-PICKER） | packages/gateway（advisorMode.ts / server.ts / advisorMode.test.ts） |
| `3b7c38b9d` | chore(v5): register INC-20260915-ADVISOR-1M-DUP-PICKER for OCV5-223 | incidents.json（R3 出处） |
| **`f1952819f`（v2 新增，09-17 14:46，boss）** | feat(v5): wire Sand-usable Cursor families into the picker（OCV5-225；Grok 4.6 公开、Composer 2.5 重启、Haiku 4.5 审计 CHECK 放宽、新增 GPT-5.6 Luna Sand ×10 与 Gemini 3.1 Pro） | **`packages/commercial/src/db/migrations/0281_cursor_sand_usable_families.sql`（新，334 行，含 ALTER…DROP CONSTRAINT）**、`deploy/v5/release-metadata.json`（requiredMigrations +1）、`packages/protocol/src/engineModels.ts`（+117）、`packages/commercial/agent-sandbox/platform-runtime/bin/oc-cursor.sh`（+5）、`.github/integ-tiers/nightly-4.txt`、三个测试文件（含新增 `migration0281CursorSandUsableFamilies.integ.test.ts`）；9 文件 +673/−18 |

> v2 起 canonical 相对基线 210b99678 为 **7 提交**；本文其它处写「6 提交」的，均指初稿时点。

## 附录 B · 本次 integration 全量（210b99678..c1fdc935e：244 提交 / 206 非 merge）按生效面

| 位置 | 文件数 | 生效面（PLAYBOOK §4.1）| selfhost `--deploy` 行为 |
|---|---|---|---|
| `packages/web-react/**` | 360 | dist 静态资源 | master release 内 `staging vite` 构建（R1 门在此） |
| `docs/audit/**` | 43 | master 进程（文档，无运行时效果） | 随 release 树 |
| `packages/gateway/**` | 3（全部 canonical） | runtime source release | `build_runtime_release` 从 HEAD archive；新容器绑定新 release |
| `scripts/check-v5-{tutorials,incident-regressions}.ts`、`scripts/check-v5-fix-trailers.sh` | 3 | manual-only（CI/门脚本） | `fix-trailers.sh` 在 `--deploy` 时从工作树执行 |
| `e2e/session-display/incidents.json` | 1 | CI 证据账本 | 无运行时效果（R3） |
| `.gitattributes` | 1 | 检出行为（教程夹具 -text） | 无 |
| `packages/web-react/package.json` | 1 | 只加脚本，lock 未变 | 不需 `--force-npm-ci`（C6） |
| `**/migrations/**` | 0（审计侧）→ **1（canonical f1952819f：0281）** | RFC §3 manual / selfhost 迁移门 | **HAS_MIGRATION 预期 1**；需 `OC_V5_ALLOW_BREAKING_MIGRATION=1`（R0/C5） |
| `packages/protocol/**`（canonical f1952819f） | 2 | master 进程 + runtime source release | `--deploy` 两面都重建（C11） |
| `**/agent-sandbox/platform-runtime/**`（canonical f1952819f） | 1 | platform bundle | 默认拷工作树 → 服务器树要干净或 `--platform-from-head`（C10） |
| `deploy/v5/release-metadata.json`（canonical f1952819f） | 1 | release 元数据（requiredMigrations / capabilities） | 静态门要求存在且字节可信（master-lib:306-313、:717）；`oc-lease` / `--status` 读它 |
| `packages/web-react/**`（budget-fix 65019b5dc，v2 预合） | 11 | dist 静态资源 | 让 R1 门过（447.3KB）；正式以集成⑤合入为准 |

## 附录 C · 本机预演产物（仓库外，`D:\code\test_project\test123\.audit-tmp\release-rehearsal\`）

- `merge-1.log`（真实 merge 的 7 处 CONFLICT 输出）、`check-tutorials-1.log` / `tutorials-accept.log` / `check-tutorials-2.log`（§1.2 5-7 三步）、`app-test-failure.txt` / `grep-checkbox.txt`（R2 现场）、`canonical-trailers.txt`、`canonical-tutorial-diff.txt`、`incident-entry.json`。
- `gates-head/SUMMARY.txt` + 各门 `*.log`（§1.3 全部结果，HEAD c1fdc935e）；`gates-head/fix-trailers.log`（R5）；`gates-head/vite-build.log`（R1 现场）；`gates-head/first-screen-bisect.txt`（R1 归因四基点）。
- `canon-3b7c38b9d\`（纯 canonical 临时 detached worktree，用完 `git worktree remove` 清掉）；`jqbin\jq.exe`（jq-1.7.1）；`run-gates-head.ps1` / `bisect-first-screen.ps1` / `measure-first-screen.mjs`（复跑脚本）。
- **v2**：`gates-head-2/SUMMARY.txt` + 各门 `*.log`（§1.3b 全部结果，HEAD f6572abb6；`vite-build.log` 含 `built in 18.84s`、`measure-first-screen.log` 含 447.3KB 明细、`commercial-cursorCliWrapper.log` 为 R9 现场）；`run-gates-head-2.ps1`（复跑脚本，比 v1 多 lint:migration-order / test:protocol / cursorCliWrapper / build / 首屏复算 / trailer 门）。

## 附录 D · 相关文档对本手册的适用性

- `AGENTS.md`：§V5 部署红线（:4-17，「常规完成 = 测试实跑通过 + Codex 审计 PASS + 按生效面矩阵部署 + smoke 通过」）与 §诊断/生产写面边界（:19-27）直接适用；注意其 canonical `feat/v5-aurora-rewrite` 指的是商业版部署树，selfhost 的部署树是 `/opt/openclaude/openclaude-v5-selfhost` on `feat/v5-selfhost`。
- `docs/hotfix-deploy-checklist.md`：面向 v3 kl-mirror，命令不通用；可迁移的是 Step 3.2 代理下 git push 写法（:92-101）、Step 5「deploy 后立刻 smoke、主动验」（:140-152）、反模式（:155-163）与 boss 联络规则（:165-172：rollback / 断在线用户前先说）。
- `docs/selfheal/RELEASE_DRILLS.md`：Tier2 自愈放行→部署演练的追加式台账，只由 codex 修复会话在 release drill 时追加一行；**本次人工发布不要往里写**。
- `docs/V5_DEV_PLAYBOOK.md` §4.1 生效面矩阵（:323-347）用于分类（附录 B）；§4.2 的全局发布队列 / `--with-dist` 是商业版 `deploy-v5.sh` 的机制，selfhost 由 `--deploy` 一次构建三面 + joint 翻转替代（deploy-v5-selfhost.sh:27-29）。
