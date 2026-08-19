# 收口与物化解耦：消灭「最新轮 agent 响应显示异常」

- 日期: 2026-08-19
- 实例: OpenClaude 新个人版 V5 自用（uid 3 admin 容器）
- 仓库: `/opt/openclaude/openclaude-v5-selfhost`，分支 `feat/v5-selfhost`，HEAD `92f468578`（与线上 `rel-92f468578` 一致）
- 范围: **rev2 设计 + 实现**。允许改代码、建迁移、跑测试、git commit。
- **禁止**: 部署、重启服务、对生产库 `openclaude_v5_selfhost` 做任何写操作（迁移只写文件，发布时才 apply）。
- 落地约束: 单机自用实例一次切；进程内定时器 + 作业表，不引入新中间件。

---


## rev2（方案审计 6 条 blocker，2026-08-19）

本文档与实现按下列修法对齐。**偏离 rev1 处以此节为准。**

### B1 财务闭环（原 Phase A 提前 ACK 会漏扣费/免单）

- Finalize 请求扩展可选 `settlement` envelope：`billingAnchorId`、`requestId`、`engineBillings[]`、`text`/`ts`/`errorCode`。**必须与同一 tape builder（`materializeLosslessTurn` / `losslessBillingAnchorId`）生成的 canonical anchor 一致。**
- Phase A **同事务**写入 `turn_tape_settlement_jobs`（kind=`billing`/`waiver`）+ 既有 `ensurePendingTurnWaiverInTransaction`。这才叫「可靠移交」。
- HTTP 200 / 删除 gateway finalize entry / 重试上限 **仅当** `settlementHandoff=true`（job 行已提交）。`TURN_TAPE_BILLING_PENDING` / `TURN_WAIVER_PENDING` **永不**计入 30 次上限。
- Phase B 物化后校验 `turn.billingAnchorId` 与 header/envelope 一致，`engineBillings` 与 job payload 一致（冲突则 job 失败可补跑，**不**改 visible_at）。
- 结算 worker 调现有 `settleCodexBilling` / `applyTurnWaiver`，带 fencing。

### B2 trigger 不得提前删 parts

- `trg_canonicalize_legacy_lossless_agent_group`（0151/0178）在 INSERT agent-group 时 `DELETE parts`。分批提交会把整卷 parts 删掉，worker 崩溃无法补跑。
- 0228 **改写**该函数：只规范化 `NEW.payload` / `content_sha256`，**不**删 parts。
- parts 只在物化 **最终 publish**（`materialization_status='complete'` 且全量 manifest 校验后）的同一事务删除。
- 集成测试：每批后强杀，重跑能从 parts 补齐 records。

### B3 records 发布门（禁止「有一条 record 就弃用 visible_head」）

- **已可见** = `visible_at IS NOT NULL`（旧行 backfill `visible_at=finalized_at`）。
- **已物化/可展开 records** = `materialization_status='complete'` **或**（兼容）`finalized_at IS NOT NULL`。
- `view='timeline'`（`readUnifiedTimelineTapeHeaders` 4768 / `readClientTimelinePageImpl` 5338）以及 full/partial/`hydrateTurnTapeMessages`/`readDirectTapeHeaders`：未发布 records 时 **始终**把热锚点 + `visible_head` 当一条 assistant，**不得**因 records 表出现第一行就切换。
- GET `/api/sessions` 浏览器默认 `view=timeline`，必须走这扇门。

### B4 tapeless fallback + fence + 晚到 tape

- 无 tape 时 `visible_head` 落在 `turn_dispatches.visible_head/visible_at`（不造违反 `part_count>0` 的假 tape）。
- 6h 硬顶 **先**写 `producer_fenced_at`（持久化 Stop/fence），再 `casToTerminal(interrupted)`。
- 晚到 tape 唯一策略：`producer_fenced_at IS NOT NULL` → `convergeDispatchOnFinalize` **不得**把 outcome 改成 completed；转 `manual_reconcile(late_tape_after_fence)`；内容仍物化可见；**不**自动 `settleCodexBilling`（job 标 `held`）。未 fence 的迟到 completed 仍走现有 `RESULT_RECOVERY_PENDING` 替换 / `not_accepted` late_tape 规则。

### B5 不改首片 `status` 语义

- **撤销 rev1 的 `status='open'`。** 首片 INSERT 仍写 gateway 申报的 terminal status（`completed|interrupted|crashed`），`sameLosslessTurnTapeHeader` 全等比较保留。
- 上传/可见/物化用独立列：`visible_at`、`materialization_status`。
- 测试：新代码写首片 → 模拟旧版本 `status` 全等校验 → 继续上传并 finalize。

### B6 materialization job fencing

- 认领照 `claimDueRecoveryJobs`：`queued` **或**（`leased` 且 `lease_until<now()`）；`FOR UPDATE SKIP LOCKED`；`lease_owner` + `lease_epoch+1` CAS。
- 长任务续租；`complete`/`fail`/`requeue` 全部 `WHERE lease_owner AND lease_epoch`。
- scheduler `stop()` **等待**在飞 tick（rev1 的 liveFrameMaintenance `stop` 不等，禁止照抄）。

### 锁序（suggestion）

权威顺序（与现网 publish 一致，Phase A / publish）：`lockTurnPersistenceKeys(turnKey)` → `lockTurnBillingKeys`（若商业 uid）→ `client_sessions FOR UPDATE` → `turn_dispatches FOR UPDATE`（converge）。`persistGatewayLiveFrame` 仍是 dispatch→tape，40P01/40001 最多重试 3 次（现网）。

### `finalized_at` 判据清单（suggestion）

| 用途 | 判据 |
|---|---|
| 终稿可读 / 时间线出现 assistant | `visible_at IS NOT NULL`（旧行：`finalized_at` backfill） |
| 展开 tape records / 删 parts / prune 帧 | `materialization_status='complete'` ∨ `finalized_at IS NOT NULL` |
| boot recovery `getTurnTapeStateByDispatch.state=finalized` | `visible_at IS NOT NULL` |
| sweeper parts 计数 | `WHERE (session_id,user_id,tape_id)` 三键，禁止只按 tape_id |


## 1. 问题陈述与事故清单

### 1.1 今天确诊（会话 `webmsz3o93liz36ps`）

Dispatch `04752b2e-895c-45b7-96d0-c3af43d4e2aa`（cmid `m-mszi6psv-fn-0zbf`，uid 3，model `gpt-5.6-sol`）:

| 事实 | 证据 |
|---|---|
| 引擎 13:50 CST 写完终稿 | live stream `dispatch:04752b2e-…:1` 745 帧，最后一帧 `outbound.turn_usage` @ 13:50:58；393 条 `outbound.message` 全部 `isFinal=false` |
| 终稿正文 351 字已在 live frames | 同 `messageId=srv-webmsz3o93liz36ps-main-t5-s0` 的 `blocks.kind=text` 共 167 chunk、351 字符，开头「**还没有完全上线。**」 |
| 收口卡在物化 | tape `01b7be1e…f3727c`：`status=completed`、`finalized_at=NULL`、`part_count=342`、`total_bytes=67052007`（parts 表 342 行 / 64MB）、records **0 行** |
| 物化撞 30s `statement_timeout` | 池级超时见 `packages/commercial/src/db/index.ts` 41–51 行；`stagePreparedLosslessTurnRecords`（`pgSessionsBackend.ts` 2614–2872）在 finalize 请求路径上把 parts 拼成 records；57014 被 `internalServerAuthored.ts` 2231–2254 / 2506 标成 `503 TURN_TAPE_RETRYABLE` |
| 容器侧无限重试 | `v3MasterRetryQueue.ts` 明文「Valid paid-turn entries have no age-based deletion」；退避 5s×2^n 封顶 5min，**无次数上限**。本事故 13:53 起已失败 26+ 次 |
| dispatch 永久 `accepted` | `outcome=NULL`、`terminal_at=NULL`、`lease_until=11:01:08+08`（扫描时已过期 5.5h+） |
| `turn_recovery_jobs` 全库 0 行 | 该表是 crash 后自动重跑，**不是** finalize 失败的回收器；lease 过期无人管 |
| GET `/api/sessions` 无本轮 assistant | 时间线只投影 `finalized_at IS NOT NULL AND billing_anchor_id IS NOT NULL`（`readDirectTapeHeaders` 3006 行同款过滤遍布 3977 / 4425 / 4789 / 5635） |
| 前端把已流出的回复抹掉 | live-frames 745 帧确实发给浏览器；但同会话已有 4 条 `projection_source=tape` 的历史流，`tapeProjectionVersion>0` → `hydrateDurableLiveFrameJournal`（`socket.ts` 3137–3271）走 `applyTapeProjection()` → `applyServerMessages` 无条件 `s._streamingAssistant = null`（3083 行） |
| 页脚也不转「回复中」 | GET sessions 不暴露 open dispatch；REST 对账后 `_sendingInFlight` 也没有终态帧（无 `isFinal:true`、dispatch 非 terminal，hello 回落不触发） |

**因果链（一句话）**: 引擎完成 ≠ 用户可见。可见性绑在「67MB lossless parts 同步物化成 records」上；物化被 30s 超时永久重试；读路径和前端对账都假设「没有 finalized tape = 这一轮不存在」。

### 1.2 历史同类（架构共性，必须一并杜绝）

1. **容器重建后永久「回复中」**: 终态通知只在进程内存环。后来 hello 回落查 PG（`userChatBridge.ts` 4454–4507）。前端 reducer **只认字面量** `turn_completed` / `interrupted`（`reducer.ts` 1403–1424），**不是** `turn_interrupted`。
2. **leftover `legacy:*` 与 `dispatch:*` 双轨**: 热路径已改为只读当前 open dispatch（`liveTurnFrames.ts` `OPEN_DISPATCH_STREAM_SQL` 39–47 行，rel-92f468578）。
3. **`client_notified` 对 completed 恒 false**: 不能当「用户没看到」的判据。`scanTerminalUnnotified`（`turnDispatchStore.ts` 562–575）只扫 `not_accepted` / `executed_error`。
4. **纪律**: 永久性失败不得进无限重试；「重启后好了」不算修复；红卡克制——部署/容器重启/正常打断默认不出红卡。

### 1.3 现有兜底为什么没接住今天这轮

`turnDispatchReconciler.runReconcileTick`（`turnDispatchReconciler.ts` 221–427）对 `accepted` 的处理：

- 每 tick 会 `getDispatchState`。容器若报 `sink_staged` / `terminal`（本事故正是「tape 已上传、finalize 在重试」），**只等、过 24h 才告警**（`SINK_WAIT_ALERT_MS`），**不收口**。
- `RESULT_RECOVERY_PENDING` 只在容器证明 `outcome=crashed` 时写入，且 **不**把已流出正文投影进 GET sessions。
- `accepted` 状态迁移还被 90min 地板挡住（`DEFAULT_ACCEPTED_STUCK_FLOOR_MS`）。本轮 lease 过期 5.5h 仍停在 `accepted`，与「sink 等待无 TTL」叠加。
- **liveness 不能看 `lease_until`**（本轮 11:01 就过期，引擎 13:50 才写完）。必须以 live frame 墙钟 / 容器进程为准。

---

## 2. 目标与非目标

### 2.1 目标

消灭「最新轮 agent 响应显示异常」这一整类问题，判定标准：

1. **引擎报完成（或 Stop/打断已确认）后数秒内**，刷新/重连/新开页都能看到终稿（或已流出的部分内容），输入框离开忙碌态。
2. **任何 dispatch 必须在有限时间内到达 `status=terminal`**，消灭永久 `accepted`。
3. 67MB 级 lossless 物化失败 **不得**挡住 1 和 2；物化可后补、可失败、可人工重跑。
4. 存量 `04752b2e` 有可脚本化修复路径（本文写清，**不在本阶段执行**）。

### 2.2 非目标（本期不做）

- 不引入 Redis 队列 / 新 worker 进程 / 对象存储。物化作业走 master 进程内 `leaderBundle` 定时器 + PG 作业表。
- 不改计费公式、不改 lossless 字节格式（format 2/3 仍由现有 `LOSSLESS_TURN_TAPE_RUNTIME_BATCHING` 管 n）。
- 不强制打开 runtime-event batching（那是降 n 的正交优化；本设计即使 n 很大也要先能显示）。
- 不做「单一会话状态权威投影」的完整改造（方向 3 给分级；本期只做防回归最小集）。
- 不把 live frames 当长期权威（仍按现有 maintenance 在 tape 投影后 prune）。

---

## 3. 方向 1：收口与物化解耦（必须做）

### 3.1 现状事务边界（问题所在）

`finalizeLosslessTurnTape`（`pgSessionsBackend.ts` 6671–7448）今天是一条同步链：

```
isLosslessTurnTapeReadyForPreparation   # 只读 header+part 清单，便宜
→ acquireFinalizeMemoryAdmission        # 按 totalBytes*3 预留，67MB 会要 ~200MB
→ claimLosslessTurnTapeStorageFormat
→ prepareLosslessTurnTapeOutsideLocks   # 把 342 parts / 67MB 拼成 canonical JSON 并 parse
→ stagePreparedLosslessTurnRecords      # 128 条一批；每条 physical record ~6 条 SQL + 两份 BYTEA
→ withTx publish                        # 锁 session 行、写 billing_anchor 进热尾巴、
                                        # SET finalized_at=now()、DELETE parts、
                                        # convergeDispatchOnFinalize、reconcileLiveStreamWithFinalTape
```

Gateway `sessionManager.ts` 5515–5670：**在 `await persistence` 成功之前扣住 `pendingFinal`**，前端拿不到 `isFinal`。容器 `v3MasterRetryQueue` 对 503 无限重试。

第一片 part 的 `INSERT INTO client_session_turn_tapes`（`stageLosslessTurnTapePart` 6586 行附近）就把 `status` 写成 gateway 申报的 `completed`。所以 **`status=completed` 今天只表示「引擎打算把这轮标成 completed」**，不表示终稿可读。这是语义谎言，必须改。

### 3.2 新状态机

Tape header `status` CHECK **保持** `completed | interrupted | crashed`（rev2 B5：不改首片语义）。**没有 `status='open'`。** 可见性用 `visible_at`，物化用 `materialization_status`。

| status | 含义（rev2） | 终稿是否可读 |
|---|---|---|
| `completed` / `interrupted` / `crashed` | 引擎申报的终态种类（首片即写入，**不**表示已可见） | 仅当 `visible_at IS NOT NULL`（Phase A 或 sweeper tapeless fallback） |

不变量（应用层，事故行修完后再考虑加 CHECK）:

- `visible_at IS NOT NULL` ⇔ 终稿可读（GET sessions / timeline）；与 `status` 解耦
- 有 tape 时：`visible_at` 与 dispatch `status=terminal` + `outcome` 在 **同一小事务** 提交
- 无 tape 时：`visible_head` 落在 `turn_dispatches.visible_head/visible_at`（不造假 tape）
- `materialization_status` 与显示解耦

`finalized_at` **保留旧语义**（records 已物化、parts 已删、billing_anchor 完整）。旧读路径大量 `finalized_at IS NOT NULL AND billing_anchor_id IS NOT NULL`，不能偷偷改成「可见」。新读路径用 `visible_at`；旧行 backfill `visible_at = finalized_at`。

### 3.3 数据模型（迁移 `0228_turn_visible_finalize.sql`）

本仓库迁移机制：`packages/commercial/src/db/migrate.ts`。文件名 `NNNN_*.sql`，`schema_migrations.version` = 去 `.sql` 的文件名，按 lexical 顺序、每个文件独立事务、`pg_advisory_lock` 串行。当前库最新 `0227_zcode_engine`，**下一个号 `0228`**（允许跳号，但不允许回填小于 max applied 的号）。启动时 `npm run migrate:commercial` / master 启动自动 migrate。

#### 3.3.1 `client_session_turn_tapes` 加列

```sql
ALTER TABLE client_session_turn_tapes
  ADD COLUMN IF NOT EXISTS visible_at bigint,
  ADD COLUMN IF NOT EXISTS visible_head jsonb,
  ADD COLUMN IF NOT EXISTS materialization_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS materialization_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS materialization_error text,
  ADD COLUMN IF NOT EXISTS materialization_next_attempt_at timestamptz;

-- 存量：已经 finalize 的 = 可见且已物化
UPDATE client_session_turn_tapes
   SET visible_at = finalized_at,
       materialization_status = 'complete'
 WHERE finalized_at IS NOT NULL
   AND visible_at IS NULL;

-- 事故形态（completed + 未 finalize + 无 records）先标 pending，留给修复脚本
-- 不要加 “status 已终态 → visible_at NOT NULL” 的 CHECK，否则 04752b2e 会挡迁移。
-- **不改** status CHECK（rev2 B5：保持 completed|interrupted|crashed）。

ALTER TABLE client_session_turn_tapes
  ADD CONSTRAINT cstt_materialization_status_chk
  CHECK (materialization_status = ANY (ARRAY['pending','running','complete','failed']));
```

`visible_head` 形状（有界，禁止塞 lossless 原文）:

```json
{
  "role": "assistant",
  "text": "……终稿全文或已流出部分……",
  "ts": 1787118658203,
  "messageId": "srv-…",
  "clientMessageId": "m-mszi6psv-fn-0zbf",
  "errorCode": null,
  "usage": { "inputTokens": 0, "outputTokens": 0 }
}
```

文本上限建议 512KiB UTF-8；超长截断并打 `_truncated`（显示仍完整——超长正文继续靠 live frames / 后续 records）。本实例事故 351 字，远低于上限。

#### 3.3.2 作业表 `turn_tape_materialization_jobs`

不复用 `turn_recovery_jobs`（那是 crash→replay/checkpoint，语义完全不同）。按 `turn_recovery_jobs` 的租约风格新建：

```sql
CREATE TABLE turn_tape_materialization_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  user_id text NOT NULL,
  tape_id text NOT NULL,
  dispatch_id uuid,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status = ANY (ARRAY['queued','leased','complete','failed'])),
  attempt integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_epoch bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, user_id, tape_id)
);
CREATE INDEX idx_tape_mat_due ON turn_tape_materialization_jobs (next_attempt_at, created_at)
  WHERE status IN ('queued','leased');
```

FK 到 `client_session_turn_tapes (session_id, user_id, tape_id) ON DELETE CASCADE`。

#### 3.3.3 第一片 part 的 header

`stageLosslessTurnTapePart` 新建 header 时 **仍写 `request.status`**（`completed|interrupted|crashed`），与现网一致。`sameLosslessTurnTapeHeader` **保持 status 全等**。上传进度 / 可见 / 物化用独立列（`visible_at`、`materialization_status`），禁止用 `status='open'` 表达。

测试：新代码写首片（status=completed）→ 旧版本全等校验仍能继续传后续 parts 并 finalize。

`reject_finalized_lossless_tape_part` 触发器仍看 `finalized_at`（物化完成后才拒新 part）。Phase A **不得**删 parts。parts 只在最终 publish 事务删除。

### 3.4 Phase A：小而原子的可见性事务（同步，ACK 网关）

入口仍是 `POST /internal/v3/server-authored-message` `action:finalize` → `internalServerAuthored.ts` 2359 → `finalizeLosslessTurnTape`。拆成两个函数：

1. `commitVisibleLosslessTurnPhaseA`（请求路径小事务）
2. 同事务 `enqueueMaterializationJob` + `enqueueSettlementJob(billing/waiver)`（不跑 67MB）
3. 请求末尾仍可尝试同步 `settleCodexBilling` / `applyTurnWaiver`；失败时若 job 已移交仍 HTTP 200

**Phase A 事务内容（禁止包含 parts 扫描拼 JSON / records INSERT）**:

```
BEGIN
  lockTurnPersistenceKeys + lockTurnBillingKeys     -- 与现网 publish 同序（见锁序）
  SELECT session FOR UPDATE
  SELECT tape FOR UPDATE                             -- 必须 parts 到齐（COUNT+size 校验，不读 payload）
  校验 header 与 request 全等（含 status；rev2 B5 不改首片语义）
  写入：
    -- 不改 status
    visible_at = now_ms()
    visible_head = $compact                          -- settlement envelope / live-frames 聚合
    billing_anchor_id = canonical losslessBillingAnchorId
    client_message_id = 从 dispatch 回填
    engine_billings 若 settlement 已带则写入
  把 billing_anchor 行 append 进 client_sessions.messages（tapeAnchor + visible_head.text）
  bump history_revision + timeline_generation
  INSERT materialization job ON CONFLICT DO NOTHING
  INSERT settlement jobs (billing / waiver)          -- 财务可靠移交；fenced → status=held
  ensurePendingTurnWaiverInTransaction（若有 waiveReason）
  convergeDispatchOnFinalize                         -- fenced 迟到 tape → manual_reconcile，不自动 settle
COMMIT
```

返回值：`applied: "finalized"` = 终稿可见 + dispatch 终态（不要求 records）。`settlementHandoff: true` = 财务 job 已落库。幂等：`visible_at IS NOT NULL` 仍返回 finalized/idempotent 且 `settlementHandoff`。

Gateway：HTTP 200 / `ackDurable` 删盘上 entry / 30 次上限 **仅当** `settlementHandoff=true`。`TURN_TAPE_BILLING_PENDING` / `TURN_WAIVER_PENDING` **永不**计入上限。物化失败不再挡这条队列。

`isTransientTurnTapeStorageError`：Phase A 仍对 57014 回 503（小事务几乎不该超时；若超时说明锁争用，重试合理）。Phase B 的失败 **不**经这条 HTTP。

#### 终稿从哪来（按优先级，Phase A 不得读 67MB parts）

1. **Gateway 在 finalize 请求里带 compact `settlement` envelope**（首选，rev2 B1）。同一 tape builder 公式：`billingAnchorId`（`losslessBillingAnchorId`）、`requestId`、`engineBillings[]`、`text`/`ts`/`errorCode`。旧容器不带此字段 → 走 2；Phase B 校验 envelope 与物化结果一致。
2. **从当前 dispatch 的 live frames 聚合**（master 侧、有界 SQL）。本事故可复现：

```sql
SELECT string_agg(b->>'text', '' ORDER BY f.record_id)
FROM client_session_live_frames f
CROSS JOIN LATERAL jsonb_array_elements(
  convert_from(f.payload,'UTF8')::jsonb->'blocks') b
WHERE f.stream_key = 'dispatch:' || $dispatch_id || ':1'
  AND convert_from(f.payload,'UTF8')::jsonb->>'type' = 'outbound.message'
  AND b->>'kind' = 'text';
```

   只聚合 `kind=text`；thinking/tool 仍留给 records。LIMIT 防护：超过 512KiB 截断。
3. 两者都空（纯工具轮 / 引擎没流出正文）：`visible_head.text=""`，dispatch 仍终态化；UI 按现有空轮规则，不造空气泡。

钱安全：Phase A 写 usage 以 gateway 上报为准（与今日 publish 用 tape 解析结果可能有细差）。物化完成后用 tape 内 `engine_billings` **覆盖** header（幂等）。有 usage_records 的结算路径不改；本设计不把物化失败当成未计费。

### 3.5 Phase B：异步物化（永不挡显示）

#### 专用连接

`packages/commercial/src/db/index.ts` 的主池 `statement_timeout=30s`、`idle_in_transaction_session_timeout=60s` **保持不动**（防 N+1 卡死池）。新增：

```ts
createPool({
  max: 2,
  statementTimeoutMs: 120_000,
  idleTimeoutMillis: 30_000,
  // PoolConfig 里同步提高 idle_in_transaction，否则 60s 会掐断批次事务
})
```

`application_name=openclaude-tape-materialize`。只给物化 worker 用。单测继续断言主池 30s（`db.integ.test.ts` 174 行）。

每条批次事务开头再 `SET LOCAL statement_timeout = '120s'`（双保险，避免被 startup 参数以外的 SET 覆盖）。

#### Worker

挂 `leaderBundle` shared，抄 `startLiveFrameMaintenanceScheduler`（`index.ts` 5424–5452）的接线方式：

- 文件：`packages/commercial/src/db/tapeJobScheduler.ts`（新；`stop()` 等待在飞 tick）
- 默认 interval 5s，env `COMMERCIAL_TAPE_MATERIALIZATION_INTERVAL_MS`，下限 1s
- `runOnStart: true`
- `COMMERCIAL_TAPE_MATERIALIZATION_DISABLED=1` 可关（应急）

Tick：

```
SELECT job FOR UPDATE SKIP LOCKED WHERE status IN ('queued','leased') AND next_attempt_at <= now() LIMIT 1
→ SET leased, attempt+=1
→ 调现有 prepareLosslessTurnTapeOutsideLocks + stagePreparedLosslessTurnRecords
   但：
   - 用物化池
   - 批次按 max(32 records, 4MB visible_payload) 切，替代仅按 128 条
     （保留 LOSSLESS_TURN_RECORD_STAGE_BATCH_SIZE=128 作为上限）
   - 每批独立 COMMIT
→ 全部 ordinal 的 model_sidecar_complete=TRUE 后，跑「publish 的后半段」：
     SET finalized_at=now(), physical/logical counts, DELETE parts,
     materialization_status='complete', job status=complete
→ 失败：attempt < 8 → queued, next_attempt_at = now()+backoff
         attempt >= 8 → job failed, tape.materialization_status='failed'
         打结构化日志 + 可选 admin alert，**不**回 503、**不**改 dispatch、**不**清 visible_at
```

退避：5s × 2^(attempt-1)，封顶 5min（与 retry queue 同数量级，但有上限）。

`stagePreparedLosslessTurnRecords` 已按 `(msg_id OR ordinal)` 幂等跳过（2614 后半）。重跑安全。

永久失败：`materialization_failed`。人工/定时补跑 = `UPDATE job SET status='queued', attempt=0, next_attempt_at=now()`。显示不受影响。

#### 读路径在 records=0 时怎么画终稿

`hydrateTurnTapeMessages`（3317+）今日在 `header` 存在但 rows 长度对不上时 **throw**。改为：

- `visible_at IS NOT NULL` 且 records 空：返回 `visible_head` 投影成一条 assistant（`_source=server`，`_turnTapeId` 在，`_turnTapeComplete=true`，`_materializationPending=true`）
- records 开始出现后走原 hydrate；`visible_head` 只做兜底
- `readDirectTapeHeaders` 等过滤从 `finalized_at IS NOT NULL AND billing_anchor_id IS NOT NULL` 改为：

```
(t.visible_at IS NOT NULL OR t.finalized_at IS NOT NULL)
AND t.billing_anchor_id IS NOT NULL
```

（backfill 后旧行两条都有；新行 Phase A 就有 `visible_at`+`billing_anchor_id`）

`getTurnTapeStateByDispatch`（6509+）：`state=finalized` 改为看 `visible_at`（gateway boot recovery 才能在物化完成前承认「这轮已经结束」）。否则容器会把已显示的一轮又当 `partial` 去 recovery。

### 3.6 失败语义汇总

| 失败点 | HTTP / 队列 | 用户面 | dispatch | 物化 |
|---|---|---|---|---|
| parts 未齐就 finalize | `incomplete`，网关继续传 part | 仍「回复中」（openDispatch） | accepted | 无 |
| Phase A 锁/超时 | 503 RETRYABLE，网关有界重试（见下） | 不变 | 不变 | 无 |
| Phase A 成功、Phase B 超时 | 无 HTTP；作业退避 | **终稿已可见** | terminal | 重试 |
| Phase B 8 次仍失败 | 无 HTTP；job=failed | 终稿仍可见，过程卡/工具卡可能缺 | terminal | 可补跑 |
| 不可变冲突（sha 不对） | 409 CONFLICT，**停止**网关重试 | 走方向 2 sweeper：按 live frames 收口 | terminal 或 interrupted | 不物化 |

**网关重试上限（rev2 B1）**: `v3MasterRetryQueue` 对 Phase A 的 503 保留退避；**仅当** `settlementHandoff=true` 且 `attempts >= 30` 后 quarantine 并停止热重传。`TURN_TAPE_BILLING_PENDING` / `TURN_WAIVER_PENDING` **永不**计入上限。永久性 409 已是停。显示不依赖这条队列——方向 2 会收尸。

---

## 4. 方向 2：终态 sweeper（必须做）

扩展现有 `runReconcileTick`，**不**新建进程。插在 ⓪ sessionGone 之后、② accepted 的 90min 门 **之前**。新分支名字：`closeVisibleOrphans`。

### 4.1 扫描集

```sql
SELECT d.*, t.tape_id, t.status AS tape_status, t.visible_at, t.part_count,
       t.finalized_at,
       (SELECT count(*) FROM client_session_turn_tape_parts p
         WHERE p.tape_id=t.tape_id) AS parts_rows,
       (SELECT max(f.created_at) FROM client_session_live_frames f
         JOIN client_session_live_streams s ON s.stream_key=f.stream_key
        WHERE s.dispatch_id=d.dispatch_id) AS last_frame_at
FROM turn_dispatches d
LEFT JOIN client_session_turn_tapes t ON t.dispatch_id=d.dispatch_id
WHERE d.status IN ('admitted','accepted','rejecting');
```

liveness = `last_frame_at`（无帧则 `accepted_at`）。**禁止用 `lease_until`。**

### 4.2 决策表

| 条件 | 动作 | 红卡 |
|---|---|---|
| `visible_at` 已有但 dispatch 仍 open | 只跑 `convergeDispatchOnFinalize` + hello 同款 nudge | 否 |
| parts 到齐（`parts_rows=part_count`）且 last_frame 后 **≥ 2min** 无新帧，且最近帧是 `turn_usage` / 无错误 | 服务端代做 Phase A：从 live frames 聚 text，`status=completed` | 否 |
| parts 到齐、last_frame 后 ≥ 2min，但有 error 块 / 容器报 interrupted | Phase A `interrupted` | 否（克制） |
| parts 不齐或根本无 tape，last_frame 后 **≥ 15min** 且容器 `absent` / `getDispatchState` 不可达 / 无进程 | `casToTerminal(interrupted)`，`visible_head` = 已流出 text（可空） | 否。部署打断走现有 `service_restart` 清扫，不落 ⚠️ |
| 同上但用户点过 Stop（journal/terminalCode `USER_CANCELLED`） | `interrupted`，部分内容可见 | 否 |
| last_frame 后 ≥ 15min 且容器仍报 `running` | **不动**（长任务，cursor 常见）；只打 15min 求证失败告警（已有 `ACCEPTED_UNREACHABLE_ALERT_MS`） | 否 |
| 任何 open dispatch **age ≥ 6h** 且 last_frame 后 ≥ 15min | 强制 `interrupted` + 部分内容可见 + admin alert | 否。这是「有限时间到达终态」的硬顶，替代 7d 只读告警 |

2min / 15min / 6h 做成常量，env 只允许放大（与 `resolveDispatchStuckThresholdMs` 同模式）。自用实例默认即可。

90min `stuckMs` 门 **保留给钱安全的 not_accepted/manual_reconcile**，不再挡显示收口。

### 4.3 收口后推前端

复用两处现成通道，注意字面量：

1. `nudgeClient`（`index.ts` 5528）今天推 `meta.reconcile="turn_state_unknown"`（`isFinal:false`），前端 **不清发送态**。Phase A / sweeper 成功后改为与 hello 回落相同的帧（`userChatBridge.ts` 4473–4495）：

```js
{
  type: "outbound.message",
  isFinal: true,
  meta: { reconcile: "turn_completed" | "interrupted", clientMessageId },
  blocks: [],
  clientMessageId,
  peer: { id: sessionId, kind: "dm" },
}
```

**禁止** `turn_interrupted`。`interrupted:'service_restart'` 只留给真重启清扫。

2. 用户不在线：终态已在 PG，下次 hello 的 `getDispatchByLogicalKey` 只认 `status==='terminal'`（已满足），会补同一帧。

reducer 1403–1424：命中后清 `_sendingInFlight` 并 `forceSync`。forceSync 此时能从 GET sessions 拉到 `visible_head`，不会再抹空。

---

## 5. 方向 3：读路径收敛

### 5.1 P0（本期必须，防回归最小集）

#### A. GET `/api/sessions/:id` 暴露 open dispatch

`gateway/src/server.ts` 约 4537+ 的 GET handler → `getClientSession` / `getClientSessionPartial`（`pgSessionsBackend.ts` 8348 / 8470）。`ClientSession`（`storage/src/sessionsDb.ts` 1587）和前端 `SessionDetail`（`web-react/src/lib/types.ts` 289）加：

```ts
openDispatch?: {
  dispatchId: string
  clientMessageId: string
  status: 'admitted' | 'accepted' | 'rejecting'
  acceptedAt: number | null
  lastFrameAt: number | null
  model?: string
}
```

查询：该 session 至多一行 open（现有 UNIQUE `(user_id, session_id, client_message_id)` + 一会话一在飞的产品约束）。无则省略字段。

前端：`openDispatch` 存在 ⇒ 页脚「回复中」，**不要**靠 `_streamingAssistant` 是否为空来猜。`openDispatch` 消失且 messages 里有对应 assistant ⇒ 正常完成。

#### B. 水合不得清空仍在飞的流式态

根因不在「tapeProjectionVersion 计数错误」，而在：**版本水位统计的是会话内所有 tape 投影流，历史轮也会让 version>0**。`hydrateDurableLiveFrameJournal`（`socket.ts` 3242–3271）于是对仍在飞的 cmid 调 `applyTapeProjection` → `applyServerMessages` 3083 无条件 `s._streamingAssistant = null`。

改两处（皮带 + 吊带）：

1. `hydrateDurableLiveFrameJournal`：若 `currentLiveOwners` 含 `sess._activeClientMessageId`，**跳过** `applyTapeProjection`。历史 tape 投影等本轮离开 `streamClientMessageIds` 再补拉。
2. `applyServerMessages`：若 `s._sendingInFlight && s._activeClientMessageId` 仍在「调用方传入的 live owners」里（给 applyServerMessages 加可选 `preserveClientMessageIds?: string[]`），不要把 `_streamingAssistant` 置 null。`useChatSocket.ts` 332–385 的 `applyTapeProjection` 闭包把 `page.streamClientMessageIds` 传进去。

契约测试锁死：`chat.test.ts` 已有 hydrate + tapeProjectionVersion 用例（4545+）。新增：

- 会话已有旧 tape 投影（version≥1）+ 当前 cmid 仍在 `streamClientMessageIds` + 本地已有 `_streamingAssistant` → hydrate 后正文仍在，且 `_sendingInFlight===true`。

### 5.2 P2（可只给路径，不强制本期做）

单一「会话当前状态」权威投影：

- 新 `GET /api/sessions/:id/state`（或把 detail 扩成 `{ messages, openDispatch, live: { cursor, owners } }`）
- 浏览器冷启动只打这一个；live-frames 仅增量
- 服务端在一个 REPEATABLE READ 快照里读 timeline + open dispatch + 当前 stream owners
- 工作量：gateway + commercial 投影 + 前端 `syncSession` 合并为一次；可与方向 1 的 `visible_head` 叠加
- 性价比：P0 已能消灭本类事故；P2 是减少双通道竞态的后续清理，单机自用可等下一轮

---

## 6. 迁移与兼容

- **双写 / 灰度**: 不需要。本实例单 master、单 uid 3、一次 `deploy-v5-selfhost.sh`。
- **滚动容器**: gateway 旧镜像不带 `visibleSnapshot` 字段 → Phase A 走 live-frames 聚合，协议字段可选。
- **旧 tape**: 迁移 backfill `visible_at=finalized_at`、`materialization_status=complete`。读路径 `visible_at OR finalized_at`。
- **事故行**: 迁移后仍是 `status=completed`（历史谎言）+ `visible_at=NULL` + `materialization_status=pending`。靠 §7 脚本修，**不要**让迁移失败。
- **回滚**: 列可留（additive）。代码回滚后旧 finalize 仍写 `finalized_at`；新列被忽略。作业表残留 `queued` 行无 worker 则不动，不破坏显示。
- **`probeSessionsDb`**: `pgSessionsBackend.ts` 7450+ 的列白名单要加上新列，否则启动探针失败。

回滚窗口（rev2 B5）：旧代码 `sameLosslessTurnTapeHeader` 要求 status 全等；rev2 **不改首片 status**，因此旧容器/旧 master 仍能继续上传并 finalize。

---

## 7. 存量修复方案（设计，不执行）

### 7.1 扫描结果（2026-08-19 约 16:36 CST，只读）

Open dispatch（`status IN ('admitted','accepted','rejecting')`）**2 行**：

| dispatch_id | session | 判定 |
|---|---|---|
| `04752b2e-895c-45b7-96d0-c3af43d4e2aa` | `webmsz3o93liz36ps` | **卡住**。accepted 5.6h，lease 过期 5.5h，last_frame=13:50:58，tape completed 未 finalize，342 parts / 0 records，745 live frames，recovery jobs 0 |
| `fc411a56-fd4c-4b29-b0ba-4f132d012c7b` | `webmszss3zzd24sud` | **本设计对话，活的**。last_frame 持续更新。不要收口 |

其它扫描：

- `finalized_at IS NULL` 的 tape：**1**（即上面那条 `01b7be1e…`）
- parts 仍在且 records=0 的 tape：**1**（同一条）
- `turn_recovery_jobs`：**0 行**（全库）

结论：除本设计会话外，**卡住的 dispatch 恰好 1 个**。

### 7.2 修复脚本步骤（以后执行；现在不要跑）

脚本建议放 `scripts/ops/repair-visible-turn.sh`，参数 `--dispatch 04752b2e-… --apply` / 默认 dry-run。**一次一个 dispatch。**

**Dry-run 校验（只读）**:

```sql
-- 1) dispatch 仍 open
SELECT status, outcome, terminal_at, lease_until
FROM turn_dispatches WHERE dispatch_id='04752b2e-895c-45b7-96d0-c3af43d4e2aa';
-- 期望: accepted, outcome NULL

-- 2) tape 形态
SELECT tape_id, status, finalized_at, part_count, physical_record_count, client_message_id
FROM client_session_turn_tapes
WHERE dispatch_id='04752b2e-895c-45b7-96d0-c3af43d4e2aa';
-- 期望: status=completed, finalized_at NULL, parts=342, records=0, client_message_id 可能为空

-- 3) 终稿可聚
SELECT length(string_agg(b->>'text','' ORDER BY f.record_id))
FROM client_session_live_frames f
JOIN client_session_live_streams s ON s.stream_key=f.stream_key
CROSS JOIN LATERAL jsonb_array_elements(convert_from(f.payload,'UTF8')::jsonb->'blocks') b
WHERE s.dispatch_id='04752b2e-895c-45b7-96d0-c3af43d4e2aa'
  AND convert_from(f.payload,'UTF8')::jsonb->>'type'='outbound.message'
  AND b->>'kind'='text';
-- 期望: 351
```

**Apply（代码落地后跑；若必须抢先修显示，可用「最小手工 Phase A」，仍等代码再物化）**:

单事务（伪 SQL，真实落地应走 `commitVisibleTurnCompletion` 以免绕过锁序）：

```sql
BEGIN;
SELECT 1 FROM turn_dispatches WHERE dispatch_id='04752b2e-895c-45b7-96d0-c3af43d4e2aa' FOR UPDATE;
SELECT 1 FROM client_sessions WHERE id='webmsz3o93liz36ps' AND user_id='c:3' FOR UPDATE;

-- 聚 visible_head（在事务外算好绑定 $head）
UPDATE client_session_turn_tapes
   SET visible_at = (extract(epoch from clock_timestamp())*1000)::bigint,
       visible_head = $head::jsonb,
       client_message_id = 'm-mszi6psv-fn-0zbf',
       billing_anchor_id = coalesce(billing_anchor_id, 'srv-repair-04752b2e'),
       materialization_status = 'pending'
 WHERE tape_id='01b7be1ea5f8082ebe12818e801cf83b5118089564366d6fe2b7be2e62f3727c'
   AND finalized_at IS NULL;

-- 热尾巴追加一条 server assistant（须走现有 spill/seq 逻辑；禁止手写损坏 messages JSON）
-- 因此 Apply 必须调用 backend API，不要纯 SQL splice。

UPDATE turn_dispatches
   SET status='terminal', outcome='completed',
       terminal_at=clock_timestamp(), client_notified=false
 WHERE dispatch_id='04752b2e-895c-45b7-96d0-c3af43d4e2aa'
   AND status IN ('admitted','accepted','rejecting');

UPDATE client_session_live_streams
   SET projection_source='tape',
       terminal_status='completed',
       tape_id='01b7be1ea5f8082ebe12818e801cf83b5118089564366d6fe2b7be2e62f3727c',
       updated_at=now()
 WHERE dispatch_id='04752b2e-895c-45b7-96d0-c3af43d4e2aa';

INSERT INTO turn_tape_materialization_jobs (session_id, user_id, tape_id, dispatch_id)
VALUES ('webmsz3o93liz36ps','c:3','01b7be1ea5f8082ebe12818e801cf83b5118089564366d6fe2b7be2e62f3727c',
        '04752b2e-895c-45b7-96d0-c3af43d4e2aa')
ON CONFLICT DO NOTHING;

COMMIT;
```

然后 nudge：`reconcile: "turn_completed"` + `clientMessageId: m-mszi6psv-fn-0zbf`。不要 `docker rm` uid3，不要重启当修复。

物化：worker 用专用池跑现有 `stagePreparedLosslessTurnRecords`；成功后 `finalized_at` 才有值、parts 才删。失败保留 parts（64MB 是终稿+过程的权威副本）。

**禁止**: 在无 `commitVisibleTurnCompletion` 的旧代码上强跑 finalize HTTP（会再次撞 30s 并继续无限重试）。

---

## 8. 测试计划

锁的产品不变量：**「终态可见性」——引擎完成或 sweeper 收口后，GET sessions 含终稿，前端不忙、不抹字。**

### 8.1 单测 / 集成（commercial）

| 用例 | 文件（现有可延伸） |
|---|---|
| Phase A 不 INSERT records 即 `applied=finalized`，GET/timeline 能读到 `visible_head` | `pgSessionsBackend.integ.test.ts`（已有大量 finalize 用例，1026+） |
| Phase A 后 `getTurnTapeStateByDispatch.state==='finalized'` | 同文件 `getTurnTapeStateByDispatch` |
| 主池仍 30s；物化池 120s | `db.integ.test.ts` 174 |
| 物化批次在 30s 主池上跑应失败、专用池成功（可注入 timeout） | 新 integ |
| 作业第 8 次失败 → `materialization_status=failed`，dispatch 仍 terminal，visible_at 仍在 | integ：kill-batch 后强制 failed |
| 分批物化每批后强杀，parts 仍在，可补跑 | `pgSessionsBackend.integ.test.ts` rev2 |
| 首片 status=completed 后旧全等上传 + finalize | 同（B5） |
| 57014 在 Phase A 仍 503 RETRYABLE；Phase B 不走 HTTP | `internalServerAuthored.test.ts` 548 |
| sweeper 三分支：代收口 / interrupted / 硬顶 fence | `visibleOrphan.test.ts` + `turnDispatchReconciler.test.ts` |
| job fencing + scheduler stop 等待在飞 tick | `tapeJobScheduler.test.ts` |
| `nudgeClient` 字面量 `turn_completed` / `interrupted` | 对一下 reducer 测试 |

### 8.2 前端契约

| 用例 | 文件 |
|---|---|
| `tapeProjectionVersion>0` 但在飞 cmid 仍是 live owner → **不**调用 applyTapeProjection；REST 对账不清 `_streamingAssistant` | `chat.test.ts` |
| `applyServerMessages` 带 `preserveClientMessageIds` 时保留 `_streamingAssistant` | `persist.test.ts` / `socket.ts` |
| `openDispatch` 使页脚「回复中」；字段消失 + 有 assistant 则停止 | 组件/reducer 测 |
| hello 回落只认 `turn_completed`/`interrupted`；`turn_interrupted` 不收口 | `durableTurnDispatch.test.ts` 430+ |

### 8.3 自用实例回归（发布后）

1. 短 cursor 轮：完成 2s 内输入框解锁，刷新仍见全文。
2. 人为把物化池关掉（env disable）再跑一轮：仍能见终稿；打开 worker 后 records 补齐、parts 消失。
3. 重连 / 新标签：hello 后不出现永久「回复中」。
4. Stop：部分内容保留，无 ⚠️（除非真 executed_error）。
5. 修 `04752b2e` 后：该会话详情出现 351 字终稿，dispatch terminal，live-frames 热路径不再把它当 open owner。

---

## 9. 发布计划

走 `scripts/deploy-v5-selfhost.sh --deploy`（工作树若脏：`--allow-dirty --platform-from-head`）。不要 `systemctl restart openclaude*` 通配。

建议切分（仍一次实例发布，但 commit 可拆，便于回滚阅读）：

1. 迁移 0228 + 类型/探针
2. Phase A + 读路径 `visible_at` + gateway compact snapshot + retry 上限
3. 物化 worker + 专用池
4. sweeper 分支 + nudge 字面量
5. 前端 hydrate/openDispatch
6. 修复脚本；**cutover 后**再 `--apply` 04752b2e

风险与回滚：

- 迁移 additive，回滚代码即可；作业表残留无害。
- 若 Phase A 有 bug 导致空 `visible_head` 却标 completed：sweeper 不会再动（已 terminal）。补救=用 live frames 重写 `visible_head`（脚本）。
- 物化 worker 跑飞：`COMMERCIAL_TAPE_MATERIALIZATION_DISABLED=1` + 主池不受影响。
- 不必重建 uid3 容器（gateway 协议字段可选）。若只发 master：旧容器仍靠 live-frames 聚合。
- 发布窗口本设计会话 `fc411a56` 是活轮，sweeper 15min 门不会误杀（last_frame 持续更新）。

---

## 10. 风险清单

1. **`status=completed` 旧行（事故）与新不变量冲突** — 迁移不加严 CHECK；先修数据。
2. **锁序** — Phase A 必须保持 session → turnKey → dispatch（与 `persistGatewayLiveFrame` / reconciler 相反序已靠 40P01 重试，见 `liveTurnFrames.ts` 148–164）。不要在 Phase A 里锁物化池连接。
3. **billing_anchor 提前生成** — request-id 映射、waiver、cost patch 今日挂在 finalize publish。Phase A 就要写 `server_authored_turn_anchor_map`（现 7228+），否则迟到 cost 对不上。测：Phase A 后立刻打 usage patch。
4. **`reconcileLiveStreamWithFinalTape` 在 records=0 时** — prune 已保证不删无 records 的帧；热 live-frames 会因 dispatch terminal 不再把该 cmid 放进 `streamClientMessageIds`。这是对的（改显示 GET sessions）。前端必须在 nudge/forceSync **之后**才清流式态，顺序已由 reducer 1422 `forceSync` 保证。
5. **visible_head 与 records 最终不一致** — 以 records 为准做一次覆盖投影（物化完成 bump `history_revision`）。351 字段级差可接受。
6. **长任务误杀** — 15min 门绑定「无新帧 **且** 容器非 running」。cursor 保活帧会刷新 `last_frame_at`。
7. **网关 retry 上限** — 30 次后停热重传，靠 sweeper 收口；若 Phase A 代码 bug 导致永远 409，显示仍靠方向 2。
8. **内存** — Phase B 仍可能一次 load 67MB（现有 `acquireFinalizeMemoryAdmission`）。单机可接受；worker 串行（`LIMIT 1`）避免两卷 67MB 并发。
9. **红卡克制** — sweeper 默认 interrupted/completed，不写 `executed_error` 除非容器明确 crashed 且无正文。部署打断继续 `service_restart` 带外清扫。
10. **「重启后好了」** — 本设计禁止把 master 重启当修法；回归用例含「disable worker 时仍可见」。

---

## 11. 关键代码索引（落地时对照）

| 点 | 位置 |
|---|---|
| 池 30s timeout | `packages/commercial/src/db/index.ts` 41–51 |
| part header 提前写 completed | `pgSessionsBackend.ts` `stageLosslessTurnTapePart` ~6586 |
| 物化循环 | `stagePreparedLosslessTurnRecords` 2614–2872，批次常量 2599 |
| finalize 同步链 | `finalizeLosslessTurnTape` 6671–7448 |
| dispatch 收敛 | `convergeDispatchOnFinalize` 938–1016 |
| 时间线可见过滤 | `readDirectTapeHeaders` 3006；同类 3977/4425/4789/5635 |
| GET session | `getClientSession` 8348；gateway `server.ts` ~4590 |
| live-frames 热路径 | `liveTurnFrames.ts` 39–47, 268–435 |
| 帧维护不删无 records | `liveFrameMaintenanceScheduler.ts` 1–20 |
| 57014 → 503 | `internalServerAuthored.ts` 2231–2254, 2506 |
| 无限重试 | `gateway/src/v3MasterRetryQueue.ts` 1–94, 347–362 |
| 扣 isFinal | `gateway/src/sessionManager.ts` 4519, 5515–5670 |
| hello 回落字面量 | `userChatBridge.ts` 4454–4507 |
| reconciler 90min/24h | `turnDispatchReconciler.ts` 46–56, 221–427 |
| 前端抹流式 | `web-react/.../socket.ts` 3083, 3137–3271；接线 `useChatSocket.ts` 332–385, 708–724 |
| reducer 字面量 | `reducer.ts` 1403–1424 |
| 迁移框架 | `packages/commercial/src/db/migrate.ts`；目录 `.../migrations/`；下一号 **0228** |
| 发布 | `scripts/deploy-v5-selfhost.sh` |

---

## 12. 建议实现顺序（一次发布内）

1. 0228 列 + 作业表 + probe
2. Phase A + 读路径 + gateway snapshot + retry 上限（此时新轮已能显示，即使物化仍慢）
3. 专用池 + worker
4. sweeper + nudge
5. 前端 P0
6. 修 04752b2e
7. 打开 worker 把 64MB parts 物化掉
