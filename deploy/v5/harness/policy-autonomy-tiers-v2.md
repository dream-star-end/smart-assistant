# V5 自用实例 · Harness 自进化分层自治策略 v2（两类极简人工审批 + A0/A1 分离 + L3 园艺微 PR）

> 生效范围：仅限个人版 V5 自用实例（`uid3`，`openclaude-v5-selfhost`，分支 `feat/v5-selfhost`）。
> 严禁触碰商业版分支 `feat/v5-aurora-rewrite` 与商业生产机 `kl-mirror`。
> 版本：v2.1（2026-11-27 精简人工审批策略，基于 OCV5-905 v2 升级）。

---

## 一、个人版人工审批降噪与白话清晰化原则（2026-11-27 升级）

个人版遵循「**在严格守恒 A0 元护栏与单调棘轮不变量的前提下，最大程度减少常规开发与发布的无谓人工审批；所有呈现给人拍板的审批单必须白话清晰、一键批准即自动续跑**」原则：

### 1. 审批界面两类白话风险标签（与底层 A0 保护范围解耦）
1. **用户体验可能下降（`riskCategory: "ux_degradation"`）**：
   - 破坏性或无法证明安全增量的数据库结构变更（`DESTRUCTIVE_DDL_LOCKED`，如 `DROP`/`TRUNCATE`/`DELETE FROM`/`ALTER COLUMN ... TYPE`/`RENAME`/无 `DEFAULT` 的 `NOT NULL` 列等）；
   - 放宽、抬升或删除单调基线/体验预算/豁免与架构边界（`budgets.json`、`context-eval-baseline.json`、`ui-static-baseline.json`、`layout-invariants-baseline.json`、`arch/modules.json` 新增 `allow`/`authorities`、`file-size` / `ai-smells` / `violations` 基线抬升等）；
   - 修改发布编排/宿主控制面、权限/契约核心、既有门禁执行器、跨家族看护员链与元裁判路径（A0 保护范围保持完整不可静默削弱）；
   - 触发连续异常回滚熔断后的恢复确认（`breaker_unlock`）。
2. **计费方式可能变化（`riskCategory: "billing_change"`）**：
   - 修改计费、模型套餐授权、价格展示、结算恢复与支付生产代码且存在真实运行时逻辑变更（默认保护 `packages/commercial/src/billing/**`、`packages/commercial/src/payment/**`、`packages/protocol/src/serviceTiers.ts`）。

### 2. 自动审批放行范围（`auto_pass` / `A1`）
- **常规业务功能、交互修复与测试**：不触及 A0 保护路径与破坏性 SQL 时全程自动审批放行；
- **严格只读/后置审计计费辅助文件**：仅限 `arch/a0-protected-paths.json` 中 `billingNonCoreAllowlist` 显式列明的 4 个零授权/零定价/零结算辅助文件（`apiKeyMessageAudit.ts`、`apiKeyUsageReport.ts`、`ledgerRowContext.ts`、`usageReport.ts`），个人版直接 `auto_pass`（审计记 `ok_auto_noncore_billing`）；其余全部计费/授权/支付文件默认受保护；
- **核心计费纯注释/类型改动**：计费/支付 TS 文件经 TypeScript AST 证明零运行时代码差异（仅注释或类型声明）直接 `auto_pass`（`semanticNoRuntimeBillingChange: true`），纯测试文件（`*.test.*` / `*.spec.*`）继续 `auto_pass`；
- **安全幂等 SQL 迁移**：除现有安全增量语句外，支持安全幂等的 `DO $$ ... $$` 块（条件仅允许严格受限的只读系统目录 `EXISTS`/`NOT EXISTS` 查询，内部全部为安全增量语句且不含任何破坏性子句）直接 `auto_pass`；
- **A1 单调收紧与声明式升级**：所有基线单调核减、新增 `check-*.ts` 门禁、`arch/modules.json` 拆分不扩权、合法固定 tag 的 `runtime-image-pin.json` 升级，全部自动放行；
- **物理红线不变**：商业分支 `feat/v5-aurora-rewrite` 继续保持永久 `absolute_reject`（`COMMERCIAL_BRANCH_HARD_LOCK`），不可任何方式创建或批准审批单；
- **审批单白话化与一键自动续跑**：所有提交给人拍板的审批单附带清晰白话字段 `riskCategory`、`whatChanged`、`whyNeedYou`、`recommendation`，主卡隐藏 git SHA/voucher/systemd 等内部黑话，点击批准后立即自动续跑并自动通知助手继续。

---

## 二、五层进化对象与 A0 / A1 元层解耦

| 层级 | 覆盖对象 | 自治度 | 强制硬门与宿主机裁判 |
|---|---|---|---|
| **L1 内容层** | `skills/`、`agents/*/memory`、prompt 片段 | 全自动（候选区 → 过门 → 合入） | skill evals + 6/6 行为保留集 + 防漂移 lint |
| **L2 配置层** | model catalog、`cron.yaml`（4 节拍内参数）、`agents.yaml`、tier 参数 | 全自动 | YAML/JSON schema 校验 + `check-cron-liveness.ts` + 6/6 保留集 + 自动回滚 |
| **L3 代码层 · 展示与园艺微 PR（白名单内）** | 纯展示组件 + **5 类受限园艺清债微 PR**（见第三节） | **全自动至 PR Auto-Merge 与搭车发布** | `verify-micro-pr-bounds.ts` + 单包测试 + 全套单调棘轮 + 外置宿主裁判 + 切流后保留集 |
| **L3 代码层 · 核心业务（T2 白名单外）** | 网关核心生命周期、协议/schema、非核心计费辅助、账号池、egress、发布脚本、Top-10 大文件 | **个人版全自动推进与放行**（不触及两类人工审批红线时免人工卡点） | 完整发布列车 + 跨家族 `Architecture Steward` 审计 + 切流后保留集 |
| **A1 自动放行层** | `deploy/v5/runtime-image-pin.json`（合法固定 tag）、新增 `check-*.ts` 门禁、所有单调基线收紧、模块拆分不扩权、4 个只读计费辅助、纯测试与零运行时差异 TS 改动 | **全自动放行** | `check-a0-monotonic.ts` + GitHub Required Checks 全绿 |
| **A0 人工审批层（完整不变量 + 两类白话标签）** | ① `billing-accounting-core`（计费/授权/定价/支付运行时改动）；② 体验回归冻结点/门禁执行器与基线放宽；③ 权限/契约核心、发布控制面、CI 工作流、既有门禁与元裁判/跨家族看护员链（严禁自主削弱） | **人工确认（白话审批单 + 一键自动续跑）+ 宿主机 root 签章** | 宿主机 `/opt/openclaude/harness-gate/bin/oc-governor` 审批回执或 CODEOWNER PR APPROVED |

---

## 三、L3 受限园艺微 PR 规则（Gardening Loop）

除 v1 原有的纯展示层（`packages/web-react/src/components/**` 纯视图与 adapter 格式化纯函数）外，**L3 新增「受限园艺清债微 PR」通道**，专门自动化偿还每周 `arch-health.json`（`magnetScore × ttlUrgency`）排出的高优技术债：

### 3.1 允许自动执行的 5 类园艺任务
1. `wheel-consolidation`：将散落在 `packages/gateway` / `packages/commercial` 非上帝文件中的重复工具函数（`sha256Hex`、`asRecord`、`isRecord`、`errMsg`、`sleep`、`atomicWriteJson`、`readBoundedJson`、`sendJson`）收敛至 `@openclaude/kernel` 单一权威导出；
2. `dead-code`：清理 `check-dead-code-weekly.ts` 与 30 天运行时遥测双重确认零引用的死导出/孤立模块；
3. `r2-export-star`：将模块 `index.ts` 中的 `export *` 通配桶展开为显式具名导出，单调核减 `arch/violations-baseline.json`；
4. `r3-env`：将业务模块散落的裸 `process.env.*` 收敛为配置注入，单调核减 `R3-env` 基线；
5. `strangler-extract`：对非 Top-10 超标/高耦合文件执行**绞杀者纯叶节点抽离**（严禁大爆炸重写）。

### 3.2 四条机械硬红线（由 `scripts/gardening/verify-micro-pr-bounds.ts` 强制阻断）
每件 L3 园艺微 PR 必须同时满足：
1. **代码体量硬上限**：非基线代码变更 `netLoc <= 300`（且 `added <= 300`、`totalChurn = added + deleted <= 600`），优先净减行；
2. **爆炸半径硬上限**：非基线文件数 `touchedFiles <= 5`（仅 `wheel-consolidation` 纯机械 `import` 替换允许放宽至 `<= 8` 文件，混入任何非机械逻辑重写立即阻断）；
3. **断言与门禁神圣不可侵犯**：严禁删除/弱化既有测试断言、严禁加 `.skip/.only`、严禁触碰 A0 保护路径；
4. **基线严格单调下降**：所有基线零上涨，且至少一项治理基线严格下降（`minBaselineDelta < 0`）。

> **明确排除（仍需人工确认）**：破坏性数据库 DDL/migration、核心计费扣池与支付逻辑运行时变更、用户体验基线放宽。

---

## 四、单条 14 天隔离冷却 vs. 全局双重熔断（消除连坐死锁）

v1 中「单次候选门禁失败或回退导致全平台静默停摆 40 天」的连坐机制正式废止，升级为两级隔离机制（由 `scripts/gardening/run-gardening-dispatch.ts` 与宿主机 `oc-governor` 协同执行）：

1. **单条 14 天隔离冷却（Per-Item Cooldown）**：
   - 当某件园艺微 PR 在门禁、CI 或单次验证中失败/回退时，仅将该条目的唯一 `itemKey`（如 `wheel-consolidation:packages/gateway/src/foo.ts`）记入 `cooldown.json`，**单独冷却 14 天**；
   - 队列中其他互不相关的清债条目与日常 L1/L2 自进化正常推进，**绝不连坐冻结全平台**。
2. **全局熔断与自动 Debt-First 模式（Host Governor 物理接管）**：
   - **回滚熔断**：仅当 **7 天内生产真实回滚 `>= 2` 次** 时，触发全局熔断并生成 5 行根因卡（`breaker-card.md`），暂停自动合入直至人工执行 `oc-governor unlock-breaker`；
   - **返工率 / TTL 自动 Debt-First**：当近 14 天 `fix+bug` 返工提交占比连续超 `40%` 或债务 TTL 过期数超限时，切换至 `debt_first` 模式（阻断新 `feat(v5):` 提交，但**继续放行** `refactor/bug/chore` 清债微 PR，越乱越优先清债）；
   - **紧急停机**：`oc-governor mode emergency_stop` 时，`run-gardening-dispatch.ts` 与发布列车立即跳过一切自动派单与发车。

---

## 五、周度自治预算与 4 节拍巡检闭环

- **周度预算**：
  - L1 + L2 自动合入：`<= 10` 件/周；
  - L3 园艺微 PR：每周一由 `run-gardening-dispatch.ts` 自动从 `arch-health.json` 挑选未冷却的 Top `2–3` 件挂 `OCV5` 单（labels: `self-evolve,gardening,l3-micro-pr`）派发执行。
- **4 节拍防静默巡检**（详见 `deploy/v5/harness/cron-recommended-cadence.yaml`）：
  1. **小时级**：`butler-light`（宿主/容器健康 + `check-cron-liveness.ts` 检测任意 `enabled: true` 任务停跑 `> 2 × 周期` 即刻 `crit` 微信告警，彻底杜绝 9 周静默停摆）；
  2. **日级**：`daily-friction-triage`（每日 06:30 摩擦信号聚合 + 高置信 `OCV5` 提单 + 核心记忆去重）；
  3. **周级清债与驾驶舱**：`weekly-gardening-and-cockpit`（周一 08:00 产出 `arch-health.json` + 派发 2–3 件园艺微 PR + 推送 4 信号高管驾驶舱卡片）；
  4. **周级防漂移与保留集**：`weekly-antidrift-retention`（周一 09:30 跑宿主机 `run-gates.sh` 6/6 行为保留集 + 记忆归档裁剪 + 预算/熔断账本核验）。
