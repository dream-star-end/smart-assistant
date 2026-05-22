# Phase 1 — Test Coverage Plan (audit synthesis + gap-fill)

> 状态: 草稿 v2 (2026-05-23,闭合 Codex 第 1 轮 4 FAIL + 1 NIT 后)
> 上游: `feedback_refactor_coverage_first.md` 内存规则要求重构前先用测试锁住行为不变量
> 下游: Phase 2 (R6.11 agent_migrations ledger TDD 建设) 起跑的硬门
>
> **v2 关键修订** (Codex round 1 反馈,全部接受):
> 1. `0019_v3_agent_migrations.sql` slot 已被 `0019_refresh_token_rotation.sql` 占用,改用 `0071_`(当前 migration tip = 0070)。docs/v3/02-DEVELOPMENT-PLAN.md:277 也提到 stale 0019,Phase 2 需同步更新
> 2. INV-1 从 ✅ 改为 ⚠️ — lint 只防「state filter near agent_containers」,gateway grep 是当前观测不是 test-locked invariant;追加 Phase 2 lint 升级的第 5 个 placeholder
> 3. Phase 2 改成真 TDD 序 — 每个子任务先红测后实施,删 2h「最后写测试」buckets
> 4. 10 个 baseline 失败分 3 类(不是 1 类) — 4 个 Phase 2-adjacent 在 Phase 1 修,1 个 (userChatBridge:399) 是真行为问题需 boss 决断,5 个真 stale 入 KNOWN-STALE
> 5. AINV-3 跨用户测试取消(已被 apiKeyIdentity.unit.test.ts:384,396 覆盖),AINV-4 保留窄范围
>
> **v3 关键修订** (Codex round 2 反馈,全部接受):
> 1. 02-DEVELOPMENT-PLAN.md 中的 `0019` active 引用还有 :277 / :806 / :1367 / :1869 四处(:2240 起为历史变更日志,保留),Phase 2 sub-task 2a 必须 sweep 全部 active references,不能只改 :277
> 2. INV-9 warm pool 测试不能既「Phase 2 不可 ship todo」又「延后到 warm pool 实装」 — 把 `v3PrewarmAckBarrier.test.ts` 从 Phase 2 gate 中显式 carve out 到 Phase 5(warm pool 落地时),`v3PrewarmAckBarrier.test.ts` 仍在 Phase 1 创建但不属 Phase 2 完工硬门
> 3. AINV-3 表内状态从 ⚠️ 改为 ✅(已被 `apiKeyIdentity.unit.test.ts:384,396` 锁定 — 成功路径返 row.userId),billing/auth 计数同步更新为 7 ✅ / 5 ⚠️ / 0 ❌
> 4. userChatBridge:399 框架不要呈两等价选项 — 现有证据(constant 定义 + 测试套件命名 + message handler 落 1009)偏向保 1009 为对外契约。Plan 改向 boss 推荐:**保留 maxPayload 作 enforcement,显式处理 protocol-layer oversize error 路径落 1009**,而不是让 boss 在「删 maxPayload」与「接受 1011」之间二选一
>
> **v4 关键修订** (Codex round 3 反馈,全部接受):
> 1. `02-DEVELOPMENT-PLAN.md:2047` 也是 active 引用(supervisor recovery pseudocode 注释「0019 迁移之前就遗留的 draining 行」)— 不是 :2240+ 的历史变更日志。Phase 2 2a sweep 列表补 :2047,与 :277 / :806 / :1367 / :1869 并列共 **5 处**
> 2. Billing/Auth section header 计数从「9 ✅ / 3 ⚠️ / 0 ❌」改为「7 ✅ / 5 ⚠️ / 0 ❌」 — 原 v1 写的 8/4 一开始就漏算了 AINV-6(标 ❌→⚠️ 应入 ⚠️ 列),v3 把 AINV-3 ⚠️→✅ 又加错增量;实际 ✅ 行 = BINV-1/2/4/6 + AINV-1/3/5 = 7,⚠️ 行 = BINV-3/5 + AINV-2/4/6 = 5

## 背景与重大重构判定

Phase 0 docs hygiene 已 merge 到 `origin/v3` (e7422383)。在准备 Phase 2 (P0 #1 「agent_containers + agent_migrations 合并」) 时,我做了两份并行 audit:

1. **billing / auth** — 12 个 invariant (BINV-1..6 + AINV-1..6)
2. **agent-sandbox** — 10 个 invariant (INV-1..10) ,对应 R6.11 §13.3 / §14.2.4 / §14.2.6

**关键发现 (推翻原计划)**: agent-sandbox 的 R6.11 `agent_migrations` ledger **在代码里完全不存在**。grep 跨 `agent-sandbox/` 与 `compute-pool/` 零命中,只有 doc / changelog 提到。`v3idleSweep.ts:8,119` 与 `v3volumeGc.ts:198` 字面写着「MVP 没 agent_migrations 表」。**注意**:R6.11 design 提到的 `0019_v3_agent_migrations.sql` slot 已被 `0019_refresh_token_rotation.sql` 占用,所以即使将来落地也得改号 — 当前 migration tip = `0070_claude_accounts_account_uuid.sql`,Phase 2 ledger 将走 `0071_v3_agent_migrations.sql`(或更晚)。R6.11 是**已批准的前向设计**,不是「已落地」。

这把 Phase 2 的性质从「合并已有 FSM」改成「**按 R6.11 spec TDD 建设 ledger 子系统**」。Phase 1 的「重构前锁住行为」无法对 INV-3..10 应用(无行为可锁),只能对 INV-1 + 部分 INV-4 + 整个 billing/auth 维度做。

## Baseline 测试通过率 (origin/v3 HEAD = e7422383)

| 包 | 通过 | 失败 | 备注 |
|---|---|---|---|
| `packages/web` | 805 / 805 | 0 | ✅ |
| `packages/gateway` | 867 / 867 | 0 | ✅ |
| `packages/commercial` (unit) | 2108 / 2118 | 10 | 全部 pre-existing on origin/v3,Phase 0 未引入 |

10 个失败按根因聚类(详细位置见附录 A):

- **代码加新 volume 挂载,测试期望未更新 (4 个)** — `v3Supervisor.test.ts:560, 1270, 2497, 2523` 全部因为 production code 新加了 `codex-container-auth` + `ccb-ssh` 两个 mount,测试 Binds 期望仍是旧 5 条
- **行为已演化,测试断言旧值 (5 个)** — `rateLimit.test.ts:54,78` (EXPIRE call 时机), `userChatBridge.test.ts:399` (close code 1011 not 1009), `v3IdleSweep.test.ts:302` (error counter), `metricsV3_2I2.test.ts:263` (Prometheus structure)
- **代码改了限制,测试期望抛出但已不抛 (1 个)** — `anthropicProxy.test.ts:252` (64KB tools threshold)

**结论**: 这 10 个测试在锁「**过期实现细节**」,而非「**行为不变量**」。修它们不是 Phase 1 的核心目标,但作为「baseline 卫生」要单独处理 (Phase 1.5,可与 Codex 决定优先级)。

## Audit 结果汇总

### Billing / Auth (12 invariants — 7 ✅ / 5 ⚠️ / 0 ❌ ; v4 counts after Codex round 3)

| Invariant | Status | Locked by | Gap |
|---|---|---|---|
| **BINV-1** 计费用 BigInt,无浮点误差 | ✅ | `calculator.test.ts` + `ledger.integ.test.ts:187` FOR UPDATE 并发测试 | — |
| **BINV-2** balance>0 → reservation capped to balance; balance≤0 → 拒绝 | ✅ | `preCheckCap.integ.test.ts` boss scenario + drain-to-zero + concurrent cap 全覆盖 | — |
| **BINV-3** settleUsage 23505 幂等 | ⚠️ | `settleUsage.integ.test.ts:262` 顺序二次进入 OK | **缺并发并行 settle 测试** (两个 worker 同时 settle 同 request_id) |
| **BINV-4** credit_ledger append-only | ✅ | `ledger.integ.test.ts:214` PG RULE 强约束测试 | — |
| **BINV-5** preCheck 不查 agent_cost_overrides (cost multiplier 只在 finalize 应用) | ⚠️ | 隐式 (preCheck.ts 不 import agentMultiplier) | **缺负向测试**「preCheck path 不允许出现 agent_cost_overrides 查询」 |
| **BINV-6** agent 缺省 multiplier = "1.000" | ✅ | `agentMultiplier.test.ts` miss path | — |
| **AINV-1** argon2id 强 hash + verify 不抛 | ✅ | `passwords.test.ts` PHC + malformed-hash 不抛 | — |
| **AINV-2** JWT payload 只含 sub/role/iat/exp/jti — 无 credits 字段 | ⚠️ | tampered-payload test 覆盖 alg:none / HS512 拒绝 | **缺正向**「payload 不应含 credits / balance / 任何业务态字段」 |
| **AINV-3** API key 唯一绑定 user_id | ✅ | `apiKeyIdentity.unit.test.ts:384,396` 成功路径返 row.userId(策略接口无「请求 B」输入,无可构造攻击面) | — (v3 修正,Codex round 1 NIT) |
| **AINV-4** container token 不可越权访问 user-scope | ⚠️ | `containerIdentity.test.ts` parse + bad token | **缺**「container token 命中 user-only route → 403/拒绝」 |
| **AINV-5** Turnstile 校验在 register/login | ✅ | `login.integ + register.integ` TURNSTILE_FAILED 分支 | — |
| **AINV-6** rate-limit 配在 register/login/verify | ❌→⚠️ | rate-limit 在 `http/router.ts`,不在 `auth/*.ts`;`rateLimit.integ.test.ts` 测组件不测 wiring | **缺 integ wiring 测试** 但优先级低 (Phase 5) — rate-limit 本身在 router 层已 enforce,grep 可证 |

### Agent-Sandbox (10 invariants — 1 ✅ / 1 ⚠️ / 8 不存在)

| Invariant | Status | Locked by | Gap |
|---|---|---|---|
| **INV-1** gateway 路径只过 `supervisor.ensureRunning(uid)`,不直接 SELECT agent_containers | ⚠️ (架构层观察,无 test 锁) | `lintAgentContainersSql.test.ts` 只 enforce「state filter 在 agent_containers 5 行内」(`lint-agent-containers-sql.ts:10,119`),**不**校验「gateway 是否只走 ensureRunning」;`packages/gateway/src/` 当前 grep 0 hits 是**当前观测**,无 test 防回归 | Phase 2 必须落地 R6.11 FAIL2 要求的 caller-whitelist lint(`@oc-reader-entry` annotation + RECONCILER_WHITELIST)。预创建 placeholder file `lintCallerWhitelist.test.ts`(本 plan 1.B 第 5 个) |
| **INV-2** open migration 期间 docker start 单点归 reconciler | ❌ 不存在 | — | Phase 2 TDD 建设 |
| **INV-3** ensureRunning 见 open migration → 503 'migration_in_progress' | ❌ 不存在 | — | Phase 2 TDD |
| **INV-4** reuse predicate = active∨pending_apply ∧ NOT EXISTS(open migration) | ⚠️ (active 半截 locked) | `v3EnsureRunning.test.ts:370` + `v3Supervisor.test.ts:1256-1366` | NOT EXISTS 半截待 Phase 2 |
| **INV-5** ensureRunning SQL LEFT JOIN agent_migrations | ❌ 不存在 | — | Phase 2 TDD |
| **INV-6** agent_migrations.INSERT 在 phase='planned' (pickHost 后,任何 IO 前) | ❌ 不存在 | — | Phase 2 TDD |
| **INV-7** reconciler attached_route 恢复必须重发 routing ACK | ❌ 不存在 | — | Phase 2 TDD (高风险,易遗漏) |
| **INV-8** ⑥f 超时不回滚 state/host_id,只 force-rm 旧 paused | ❌ 不存在 | — | Phase 2 TDD |
| **INV-9** warm pool 消费需 ACK barrier | ❌ 不存在 (warm pool dormant) | — | Phase 2 TDD (延后到 warm pool 落地) |
| **INV-10** orphan sweep 处理 new_cid=NULL planned 行 | ❌ 反向 locked | `v3OrphanReconcile.test.ts:286` 现在写「NULL cid → skip」 | Phase 2 必须**翻转**这个测试 |

### Bug smell flags

- `v3Supervisor.test.ts:243-353` + `nodeScheduler.test.ts:208-275`: FakePool 用 ~15 个 regex matchers 卡 SQL 字面量。重构改列序 / CTE 改名会触发雪崩失败,但语义无变化。**已是 baseline 的 10 个失败的一部分**。Phase 2 必须先把这套 fixture 改成「按 SQL 语义匹配」或「真 PG」。
- `lintAgentContainersSql.test.ts:99` 锁常量 `STATE_WINDOW_LINES === 5`。锁的是 lint 实现细节,不是 invariant。Phase 2 升级 lint 到语义级时一并删。
- 11 个 audit 过的 agent-sandbox 测试文件**全部不使用 mock.module()**。这是好消息 — 不需要 unmask 任何被中和的断言。
- `lintAgentContainersSql.ts:5-9` 自承「R6.11 (b)(c)(d) 严格模式推迟到 P1 一并落地」 — 即现有 lint 只够防最显眼回归 (`SELECT FROM agent_containers WHERE user_id` 没有 state filter),不够 R6.11 FAIL2 要求的 caller-whitelist + open-migration predicate 校验。

## Phase 1 工作清单

### 1.A — Billing / Auth 4 个小补丁 (合计约 250 LOC,1 次 commit)

| # | 新增文件 / 编辑 | 锁的 invariant | 估计 LOC |
|---|---|---|---|
| 1 | `packages/commercial/src/__tests__/settleUsageConcurrent.integ.test.ts` (新) | BINV-3 并发幂等 | 90 |
| 2 | `packages/commercial/src/__tests__/preCheck.test.ts` (扩) | BINV-5 负向「preCheck 不调 agentMultiplier」 — 用 mock pool 计数,确认 preCheck 路径 0 次 SELECT FROM agent_cost_overrides | 40 |
| 3 | `packages/commercial/src/__tests__/jwt.test.ts` (扩) | AINV-2 正向「payload keys 严格白名单」(只允许 sub/role/iat/exp/jti) | 30 |
| 4 | `packages/commercial/src/__tests__/containerIdentity.test.ts` (扩) | AINV-4 窄: container token 命中 user-only route decision (`requiredRole='user'`) → 拒绝 | 40 |

**已取消的 AINV-3 cross-user 测试**: Codex round 1 NIT 指出 `apiKeyIdentity.unit.test.ts:384,396` 已覆盖「成功解析返 row.userId」,而新建测试想做的「key A 不可解析为 B」在 apiKeyIdentity 的接口上没有「请求 B」的输入路径(策略只返 row.userId),属于不存在的攻击面。**接受取消**。

**不做** AINV-6 rate-limit wiring 测试 — 放 Phase 5 一起做 router-level integ。

### 1.B — Agent-Sandbox placeholder files (合计约 80 LOC,1 次 commit)

为 Phase 2 TDD 做硬门:Phase 2 不允许 ship 这些文件还是 `test.todo` 的状态。**例外**:`v3PrewarmAckBarrier.test.ts`(INV-9)从硬门中 carve out,因为 warm pool 本身 dormant,Phase 2 不动它,转 real test 推迟到 Phase 5 与 warm pool 实装一起做。

| 文件 | 内容 |
|---|---|
| `packages/commercial/src/__tests__/v3MigrationLedger.test.ts` | `test.todo` × INV-3, INV-5, INV-6, INV-8 |
| `packages/commercial/src/__tests__/v3MigrationReconciler.test.ts` | `test.todo` × INV-2, INV-7, INV-10 |
| `packages/commercial/src/__tests__/v3EnsureRunningMigrationGuard.test.ts` | `test.todo` × INV-3, INV-4 (NOT EXISTS 半截) |
| `packages/commercial/src/__tests__/v3PrewarmAckBarrier.test.ts` | `test.todo` × INV-9 (延后到 warm pool 实装) |
| `packages/commercial/src/__tests__/lintCallerWhitelist.test.ts` (Codex v2 加) | `test.todo` × INV-1 升级 — RECONCILER_WHITELIST file-path 校验 + open-migration predicate 校验 |

每个 `test.todo` 描述具体行为期望,Phase 2 用同名 `test()` 替换 — TDD 红→绿。

### 1.C — Baseline 10 失败的分类处理 (Codex v2 重排)

不是 1 个类别 — 是 3 个,需要差异化处理:

**类 A: Phase 2-adjacent 必须 Phase 1 修 (4 个)** — Phase 2 会改这块代码,留着红测试会让 Phase 2 起跑就在已知红基线上,无法判断 Phase 2 自己是否引入回归。

| 测试 | 根因 | Phase 1 修法 |
|---|---|---|
| `v3Supervisor.test.ts:560` provisionV3Container | 代码新加 `codex-container-auth` + `ccb-ssh` 两 mount,test expected 仍 5 条 | expected list 加 2 项 |
| `v3Supervisor.test.ts:1270` getV3ContainerStatus active+running | test fixture 不满足新 CCB baseline 要求 | 用 `OC_V3_CCB_BASELINE_OPTIONAL=1` 或 mock baseline 满足 |
| `v3Supervisor.test.ts:2497` CCB baseline OPTIONAL | 同 #560 mount 增量 | expected list 加 2 项 |
| `v3Supervisor.test.ts:2523` CCB baseline full | 同 #560 mount 增量 | expected list 加 2 项 |

合计约 30 LOC 编辑,1 个 commit。

**类 B: 真行为问题需 boss 决断 (1 个)** — 不是 Phase 1 范围,但 plan 显式标出来,boss 决定如何处理。

| 测试 | 行为问题 |
|---|---|
| `userChatBridge.test.ts:399` container frame too big | 测试期望 close(1009),实际 close(1011)。根因:`userChatBridge.ts:657` `new WebSocketServer({ maxPayload: maxFrameBytes })` 让 ws 库在协议层先抛 error,触发 line 2474 `onError → close(INTERNAL=1011)`,绕过 line 2046 message handler 的 1009 路径。**仓内证据一致偏向保 1009**:`CLOSE_BRIDGE.TOO_BIG = 1009` 常量定义在 `userChatBridge.ts:90`、message handler 显式 close 1009 在 `:2046`、测试套件命名 `userChatBridge.test.ts:13` 与 expected `:388-399` 均围绕 1009。1011 是 enforcement 漏出来到 generic error handler,不是设计契约。**推荐方案给 boss**:保留 maxPayload 作为底层 enforcement,显式拦截 ws 协议层 oversize error(`containerWs.on('error', ...)` 内分流 `err.message` 含 "Max payload" 或检查 err code),转走 1009 路径;不删 maxPayload(还需要它防超大帧吃内存),也不改测试 expected。**Plan 不在 Phase 1 解决**(单独 ticket),挂 boss decision 列。 |

**类 C: 真 stale 与 ledger 无关 (5 个)** — 入 `docs/v3/KNOWN-STALE-TESTS.md`,Phase 5 收尾。

| 测试 | 根因 |
|---|---|
| `anthropicProxy.test.ts:252` tools 64KB → 413 | 阈值或拒绝条件改了 |
| `rateLimit.test.ts:54,78` EXPIRE call 时机 | 实现改为 every-call EXPIRE,test 期望旧 first-call only |
| `v3IdleSweep.test.ts:302` error counter | 累计逻辑改 |
| `metricsV3_2I2.test.ts:263` renderPrometheus 结构 | 输出格式改 |

### 1.D — Phase 2 计划重写 (Codex v2 改 TDD 序)

每个 sub-task 拆成 (red test) + (impl) **两个 commit**,中间允许 Codex review。Phase 2 推进规则:每对 commit 之间测试必须红→绿;不允许「先 impl 再补测试」。

| # | TDD 序对 | 备注 |
|---|---|---|
| 2a | (test) ledger schema 期望 — 测试以**最终 DB contract** 写(`runMigrations()` 后断言 `agent_migrations` 表存在 + phase CHECK + NULLABLE 列 + 两个 partial index),**不**预读 SQL 文件;红测在 `0071_` 落地前自然失败 → (impl) `0071_v3_agent_migrations.sql` migration(**不是 0019**,0019 已被 refresh_token_rotation 占用)。**Active spec sweep**:同一 commit 里把 `docs/v3/02-DEVELOPMENT-PLAN.md` 的**五处** active `0019` 引用全部改 `0071` — line 277(schema 表登记)/ 806(总览) / 1367(代码注释)/ 1869(表 DDL 章节)/ **2047(supervisor recovery pseudocode 注释「0019 迁移之前就遗留的 draining 行」,Codex v4 补)**,**保留** :2240 起的 R6.x 变更日志历史引用不动。partial index 必须随 schema 一并落:① `(phase, updated_at) WHERE phase NOT IN ('committed','rolled_back')` 服务 reconciler 周期扫描;② `(agent_container_id) WHERE phase NOT IN ('committed','rolled_back')` 服务 R6.11 ensureRunning reader 按 container_id 点查 | 不可逆 commit — schema 上 prod 后回退要 down migration |
| 2b | (test) ledger module 单元测试红 → (impl) `packages/commercial/src/agent-sandbox/migrations/` 子包 + planned 写入 / phase advance / commit / rollback | 源码可逆 |
| 2c | (test) `v3EnsureRunningMigrationGuard.test.ts` 4 个红测填实 → (impl) ensureRunning LEFT JOIN agent_migrations + 503 路径 | 影响热路径,本对必须 Codex 严审 |
| 2d | (test) `v3MigrationReconciler.test.ts` 3 个红测填实 → (impl) 新 `v3migrationReconciler.ts` 持有 docker start + routing ACK | 高风险 INV-7 ACK 重发是死角 |
| 2e | (test) `lintCallerWhitelist.test.ts` 红 → (impl) `lintAgentContainersSql.ts` 升 R6.11 FAIL2 语义级 + RECONCILER_WHITELIST file-path | INV-1 真正落锁 |
| 2f | (test) 在 `v3MigrationReconciler.test.ts` 中实装 INV-10 planned 兜底新测试(phase='planned' + ledger.new_container_internal_id IS NULL + age > migrateSec → markMigration('rolled_back') + paused_at unpause;agent_containers 不动) → (impl) `v3migrationReconciler.ts` planned-phase 兜底分支。**不**翻转 `v3OrphanReconcile.test.ts:286`(那是 v2 direction-B `agent_containers.container_internal_id IS NULL` 字段,与 R6.11 ledger 的 `agent_migrations.new_container_internal_id` 是两个独立字段两条独立 sweep);新 host docker create 残留交 §3H docker orphan(独立路径)兜底 | 新增 ledger 行为,Codex 重点看 docker 侧不出现 cleanup(那是另一条 sweep) |
| 2g | (test) `/api/agent/open` 404 + node-agent 路径 0 调用 → (impl) 源码删除 v2 dormant entry + `rollout-node-agent.ts` | Phase 0 已 archive 路径,本步删源 |
| ~~2h~~ | **删除** — INV-9 / `v3PrewarmAckBarrier.test.ts` 从 Phase 2 完工硬门中显式 carve out。Phase 2 不要求该文件转 real test;Phase 1 创建 todo 占位;真正实施(test → impl 红绿对)迁到 **Phase 5**(warm pool 落地时)。Codex round 2 FAIL #2 修正:避免「Phase 2 不可 ship todo」与「INV-9 延后」自相矛盾 | Phase 5 工作,不阻 Phase 2 完工 |

**反转点 (boss 不可逆步)**:2a schema migration 一旦 prod apply 不能直接回滚 — Phase 2 上 prod 前 boss 必须 review;2g v2 dormant 源删除可逆(git revert)但 Phase 0 已 archive,有相应 git 历史可参考。

每个子任务一个 commit pair,逐对 Codex review。

## 提交流程

1. ✅ 写完此 plan (本文件)
2. → **Codex review plan** (mandatory per CLAUDE.md)
3. → 按 Codex 反馈调整
4. → 实施 1.A + 1.B + 1.C 三个 commit
5. → **Codex review code diff**
6. → 修迭代到 PASS
7. → merge 到 `origin/v3`
8. → Phase 2 启动

## 附录 A — 10 个 pre-existing 失败测试详单

```
src/__tests__/anthropicProxy.test.ts:252        — 64KB tools threshold no longer throws
src/__tests__/rateLimit.test.ts:54              — EXPIRE call count expected 1 actual 5
src/__tests__/rateLimit.test.ts:78              — new window EXPIRE count expected 2 actual 6
src/__tests__/userChatBridge.test.ts:399        — frame too big close(1011) not (1009)
src/__tests__/v3IdleSweep.test.ts:302           — error counter expected 1 actual 2
src/__tests__/v3Supervisor.test.ts:560          — Binds expected 5 actual 7 (codex-auth + ccb-ssh 加)
src/__tests__/v3Supervisor.test.ts:1270         — getV3ContainerStatus 测试缺 CCB baseline fixture
src/__tests__/v3Supervisor.test.ts:2497         — Binds 5 vs 7 (CCB baseline optional 分支)
src/__tests__/v3Supervisor.test.ts:2523         — Binds 7 vs 9 (CCB baseline 齐全分支)
src/admin/__tests__/metricsV3_2I2.test.ts:263   — renderPrometheus 全局结构
```

git log 显示 `v3Supervisor.test.ts` 最近 5 commit 全是 v3 主线 (`d313fadb feat(v3): D2 全用户家目录持久化`、`8f564220 refactor(v3): per-host max_containers` 等) — 测试 expected 没跟上代码迭代,**不是** Phase 0 引入。
