# OpenClaude V5 Selfhost 零看码可视化自治治理控制面与一键审批卡实施计划（OCV5-914）

- **制定日期**：2026-11-27
- **关联工单**：`OCV5-914`（承接 `OCV5-903` / `OCV5-906` 宿主物理 4 总闸）
- **适用边界（硬红线）**：
  - **仅限个人版 V5 selfhost**（`flavor === "selfhost"` 且 `uid === 3` + `requireAdminVerifyDb` 真人浏览器登录态鉴权）；
  - **商业版严格 fail-closed 零存在性泄漏**：`deps.selfhostGovernance` 在商业版恒为 `undefined`，所有 `/api/admin/governance/*` 路由硬拒 `403/404`；管理后台 `adminPages` 默认严格保持 28 个商业通用页，仅对 `uid === 3` 在会话挂载时探测一次，未确认启用前深链 `#tab=governance` 直接回落 `dashboard` 绝不挂载治理页壳；对话审批卡与 Markdown 降级对商业/未授权用户仅呈现完全中性文案，零泄漏「个人版/自治治理/管理员」存在性；严格零触碰 `feat/v5-aurora-rewrite`。
- **与在途工单零交集**：不触碰 `OCV5-912`（`githubMergedPrEquivalence.ts` / `check-a0-monotonic.ts` / `v5-selfhost-governance-gates.sh`）及 `OCV5-913`（商业同步）。

## 一、背景与要解决的两个核心缺口

1. **「看不懂代码 diff」却被目录级硬锁高频打断**：
   - `arch/a0-protected-paths.json` 已界定真正的账本/定价/扣费核心文件，但 `oc-governor.sh` 旧实现采用整目录粗匹配，导致纯测试或纯 TS 类型注解变更也被拦成 `BILLING_CORE_LOCKED`。
   - 拦截报错只给文件路径与 bash 命令，非程序员决策者无法判断真实业务风险。
2. **「没有可视化拍板生效入口」**：
   - 宿主物理 4 总闸（全局模式、A0 审批、爆破半径凭证、熔断解锁）仅有 CLI，管理后台和对话流均无可视化操作台与一键审批卡，逼用户 SSH 敲命令。

## 二、总体架构（四层零看码闭环）

### 层 1：宿主总闸语义降噪与单写入者待拍板队列（`scripts/harness-gate/oc-governor.sh` + `scripts/lib/v5-selfhost-train-guards.sh`）
- **互斥三分类 + 极保守降噪（严守红线不松动）**：
  - `check-blast-radius` 显式输出互斥分类 `classification: "absolute_reject" | "human_review_required" | "auto_pass"`，全链路（`v5-selfhost-train-guards.sh` → `check-blast-radius` → `record-pending-approval` → `decide-pending-approval` → `issue-blast-voucher`）采用无损 `--files-nul`/`--files-json` 传输（保留含逗号/空格路径，显式拒绝 `\n`/`\r`/`\0`）；省略 `--base-ref` 时统一解析精确 `baseSha = ${sha}^` 同时传入 AST 与 Steward 校验（无法解析基线或分支、或 `git show` 读 SQL 失败一律 fail-closed）。
  - **永不放行（`absolute_reject`）**：商业分支 `feat/v5-aurora-rewrite`，永不建单、永不可批。
  - **人工审批硬锁（`human_review_required`）**：SQL 迁移先剥离注释与字面量，仅当每条非空语句均命中安全增量白名单（`CREATE TABLE IF NOT EXISTS` / `CREATE [UNIQUE] INDEX [CONCURRENTLY] IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN [IF NOT EXISTS]` / `COMMENT ON` / `BEGIN` / `COMMIT` / `SET LOCAL`）才放行，其余含 `DROP`/`TRUNCATE`/`DELETE`/`ALTER ... TYPE`/`DO $$` 或未识别 SQL 均保守判 `DESTRUCTIVE_DDL_LOCKED`；核心计费文件（含 `ledger`/`pricing`/`persistedBillingPricing`/`calculator`/`spend`/`refund`/`preCheck` 及 `*Wallet*`/`*Credit*`/`*Settle*`/`*Cost*`/`*Price*`/`*Rate*`/`*Quota*`）、`payment/` 生产代码及任何非核心计费文件的运行时逻辑变更，100% 必须人工审批签发精确绑定的凭证。
  - **纯测试与极保守纯类型/注释自动降噪（`auto_pass`）**：严格匹配 `packages/commercial/src/{billing,payment}/` 下的 `.test`/`.spec` 测试文件免锁；剩余非核心 `billing/` 辅助文件仅当经 TS AST 证实零运行时代码变更且通过强制 `.hmac-key`（零退化 SHA-256）+ 权威 `verifyArchStewardReceipt(requireHmac: true)`（精确绑定 `headSha`/`baseSha`）跨家族独立审计校验时方可 `auto_pass`。
- **宿主唯一写入者 + per-ID `flock` 原子审批单与自愈对账**：
  - 全部审批单落 `/opt/openclaude/harness-gate/control/pending-approvals/<id>.json`（零 DB 迁移，root 持有，SHA-256 完整性校验，per-ID 排他 `flock` 防并发双签）。
  - `record-pending-approval` 对未过期单严格 create-only 幂等；对已过期旧单自动归档为 `${id}.expired-<ts>.json` 并以 `version+1` / `round+1` 原地重开新一轮 `pending`。
  - `decide-pending-approval` 预生成确定性 `pendingArtifactId`、落 `approving` 后同锁签发精确绑定 `sha`/`branch`/`files`/`approvalId` 的 `blast_voucher` 或逐文件 `--allowed-path` + `--publish-github-status`（校验 `.gh.json` 中 `publishedGithubStatus == true`）的 `a0_approval`；若上次崩溃停留在 `approving`，同锁或经 `reconcile-pending-approval` 核查磁盘产物自动推进 `approved`（复用绝不重签）/ 回退 `pending` / 标 `reconcile_required`。
  - `update-approval-resume` 支持 `--claim-from <csv>` 原子 CAS 抢占（冲突返 `RESUME_ALREADY_CLAIMED`）；`v5_selfhost_enforce_forward_cutover_guards` 硬核验 `OC_V5_EXPECTED_HEAD == sha`；显式传入 `--voucher` 时即使无敏感文件命中仍必验凭证 SHA/分支；`mode autonomous` 在 `breaker.tripped == true` 时硬拒 `BREAKER_TRIPPED_USE_UNLOCK`；`v5-selfhost-train-guards.sh` 仅在 `record-pending-approval` exit 0 时才输出审批单 ID 与控制台链接。

### 层 2：个人版专属 Human Admin 后端控制面（`packages/protocol/src/selfhostGovernance.ts` + `packages/commercial/src/admin/selfhostGovernance*.ts` + `packages/commercial/src/http/admin/governance.ts`）
- 共享 DTO 契约单真源置于 `@openclaude/protocol/selfhostGovernance`，消除前后端重复定义；env 路径配置经 L2 `runtimeCapabilities.ts` 读取并由 L6 `bootstrap/selfhostGovernanceBootstrap.ts` 仅对 selfhost 注入，SHA-256 完整性原语收口于 L2 `crypto/digest.ts`；业务服务零 `process.env`、零 shell 拼接、零直接写盘（审批决策全部委托宿主 `oc-governor decide-pending-approval` / `update-approval-resume`）。
- 严格真人浏览器管理员鉴权（`router.ts` 全局 `requireAdminVerifyDb` + `uid === 3` + `deps.selfhostGovernance`），容器 Agent 无法伪造；`audit.jsonl` 采用尾部 256 KiB fd 切片读取，审批目录扫描跳过 `.expired-*.json` 归档并限制上限；缺失 `mode.json` 与列车一致标 `uninitialized: true`（`autonomous`），损坏 `mode.json` 标 `corrupt: true` / `unknown` 红警，损坏 `breaker.json` 标 `readError: true`，缺失/N/A 驾驶舱指标输出 `unknown` 灰灯，绝不误报绿灯。
- 接口清单：
  - `GET /api/admin/governance/overview`（模式含 `corrupt`/`effectiveMode`/`uninitialized`、熔断卡含 `readError`、待拍板队列与实时 `systemctl show` unit 态对账、近期决策、4 信号驾驶舱摘要、宿主近期治理流水）
  - `GET /api/admin/governance/approvals/:id`（单张审批单实时权威态，含 unit 真实状态对账，供聊天审批卡拉取）
  - `POST /api/admin/governance/mode`（一键切换 `autonomous` / `debt_first` / `emergency_stop`；熔断态拒切 `autonomous` 返 409）
  - `POST /api/admin/governance/breaker/unlock`（填写 ≥8 字真实根因一键解锁熔断）
  - `POST /api/admin/governance/approvals/:id/decide`（透传乐观锁 `expectedVersion`/`expectedSha256` 及 A0 `--publish-github-status`，`await` 续跑防止锁提前释放，先经 `--claim-from` CAS 认领 `starting` 再核验 `git rev-parse HEAD === approval.sha` 与 `deploy.lock`，如实记录 `started` / `running` / `completed` / `failed` / `not_started_busy` / `head_moved`；冲突码统一映射 409 附最新权威审批单）
  - `POST /api/admin/governance/approvals/:id/resume`（对已 `approved` 且持有效凭证的失败/忙等单经 CAS 原子认领安全重触发版，绝不重复签发凭证；审计登记 `governance.approval.resume`）

### 层 3：管理中心「自治治理」可视化页面（`packages/web-react/src/admin/pages/governance/`）
- 在 `admin/registry.tsx` 保持默认 28 商业通用页不变，通过 `SELFHOST_GOVERNANCE_PAGE` + `getVisibleAdminGroups`/`getVisibleAdminPage` 按需注入；`AdminShell` 仅对 `uid === 3` 探测一次，商业版侧栏隐藏且深链回落 `dashboard`。
- 四大清晰区域（Clarvy Atelier 视觉规范，零终端黑话）：
  1. 顶部物理总闸模式开关（含 `uninitialized` 黄色提醒、`corrupt` 红警与熔断态联动禁用）与熔断状态条（含 `readError` 读取异常红警、5 行白话根因 + 空默认原因强制 ≥8 字解锁）；
  2. 「待你拍板」审批收件箱（4 盏安全灯含 `unknown` 灰灯 + 独立跨家族审计背书 + 一键批准/驳回 + `starting`/`running` 执行中禁用防重 + `failed`/`not_started_busy` 时「仅重触发版（复用已签凭证）」安全重试按钮 + `expired` 自动重开提示）；
  3. 4 信号健康驾驶舱可视化指标卡（支持 `unknown` 灰灯）；
  4. 宿主记录的近期治理操作流水（白话翻译）。

### 层 4：对话内原生一键治理审批卡（`governance_approval` IUI 卡片）
- 在 `packages/web-react/src/components/iui/` 注册 `governance_approval` 类型（严格字段白名单拒绝伪造风险结论，经 `WorkBlocks.tsx` 中 `React.lazy` 懒加载，主包首屏 +0 bytes；Markdown 降级零信任不回显模型 `title`/`subtitle`）。
- 仅凭 `approvalId` 向 Master 实时拉取权威审批单，对未登录/401/403/404 禁用态统一呈现中性提示「该操作卡片当前不可用」，零泄露功能存在性；维护请求世代锁与卸载取消，支持乐观锁决策与复用凭证安全续跑。

## 三、T2 审计与上线验收路径
1. 蜂群零交集并行开发（`governor-dev`、`backend-dev`、`admin-ui-dev`、`chat-iui-dev`）→ `integrator` 统一接线与全门自检；
2. T2 跨家族独立 `auditor`（`gpt-6.2-astra`）1+1 首审与复核关门；
3. 宿主同步安装升级版 `oc-governor`，基于用户 2026-11-27 明确授权签发精确 commit 的 A0 收据，经 PR/CI 绿灯合入 `feat/v5-selfhost` 并搭车上线验证。
