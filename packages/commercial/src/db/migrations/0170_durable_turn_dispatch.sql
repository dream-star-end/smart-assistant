-- 0170_durable_turn_dispatch — 根治静默丢 turn(RFC-v5-durable-turn-dispatch §2)。
--
-- 权威源三对象之一:master turn_dispatches 是「逻辑 turn + 租约」的单一权威(gateway
-- durable inbox 管执行准入/去重,lossless tape+retry queue 管结果内容)。turn_traces 降级
-- 为纯 per-attempt 观测(记 dispatch_id/request_id 供展示,不参与任何判定)。
--
-- 不变量(见 RFC §1):I1 受理即拥有 / I2 at-most-once / I3 单一权威三对象 /
-- I4 reconcile 绑定身份 / I5 钱安全。
--
-- retention(登记在 admin/auditRetention.ts):
--   turn_dispatches:terminal 行 terminal_at + 90d 后可 GC;manual_reconcile 仅在
--     resolved_at 落表后计 90d(未收敛前豁免);open(admitted/accepted/rejecting)永不 GC,
--     open>7d 由 reconciler 告警;
--   turn_dispatch_error_projections:revoked 行 revoked_at + 90d;active(revoked_at IS NULL)
--     随 dispatch 生命周期(FK ON DELETE CASCADE,dispatch GC 时一并清)。

CREATE TABLE IF NOT EXISTS turn_dispatches (
  dispatch_id        UUID PRIMARY KEY,
  user_id            BIGINT NOT NULL,
  session_id         TEXT NOT NULL,
  client_message_id  TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  model              TEXT,
  -- sha256(text + sorted media refs):同逻辑键异 hash = immutable conflict(前端篡改重发)。
  request_hash       TEXT NOT NULL,
  -- 受理事务铸造的稳定计费 request id;attempt 稳定、lease 接管复用,永不重铸。
  billing_request_id TEXT NOT NULL,
  -- v1 恒 1,为未来 master 重派 outbox(登记债 §8)铺底。
  attempt_no         INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no >= 1),
  status             TEXT NOT NULL
                       CHECK (status IN ('admitted','accepted','rejecting','terminal','manual_reconcile')),
  outcome            TEXT
                       CHECK (outcome IN ('completed','interrupted','crashed','executed_error','not_accepted')),
  failure_code       TEXT,
  conflict_reason    TEXT,
  -- manual_reconcile 人工收敛:resolution/resolved_at 落表后该行才计入 GC 窗口。
  resolution         TEXT,
  resolved_at        TIMESTAMPTZ,
  -- 用户面是否已被告知本 dispatch 的终态(fail-visible 送达即置 true)。
  client_notified    BOOLEAN NOT NULL DEFAULT FALSE,
  -- 租约(epoch fence):owner_id = 当前持有 bridge;takeover 必 CAS lease_epoch++。
  owner_id           TEXT,
  lease_epoch        BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_until        TIMESTAMPTZ,
  -- 受理事务内记录的 user 消息行 _seq —— error projection 虚拟行排序键。
  anchor_seq         BIGINT,
  admitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at        TIMESTAMPTZ,
  terminal_at        TIMESTAMPTZ,
  last_attempt_at    TIMESTAMPTZ,
  UNIQUE (user_id, session_id, client_message_id),
  -- terminal 必带 outcome(否则终态无语义)。
  CONSTRAINT turn_dispatches_terminal_outcome_chk
    CHECK (status <> 'terminal' OR outcome IS NOT NULL),
  -- rejecting 是「正在向容器求证 tombstone」的中间态,尚未 terminal。
  CONSTRAINT turn_dispatches_rejecting_chk
    CHECK (status <> 'rejecting' OR terminal_at IS NULL),
  -- not_accepted 只能出现在 terminal(durable negative proof 才允许下此结论),或
  -- late tape 推翻后的 manual_reconcile(outcome 保留作证据,冲突已由 conflict_reason 记录)。
  CONSTRAINT turn_dispatches_not_accepted_chk
    CHECK (outcome <> 'not_accepted' OR status IN ('terminal','manual_reconcile')),
  -- manual_reconcile 必带原因(财务歧义/late tape/接管不一致三源)。
  CONSTRAINT turn_dispatches_manual_reason_chk
    CHECK (status <> 'manual_reconcile' OR conflict_reason IS NOT NULL)
);

-- reconciler 扫描面:只关心 open 三态,按 admitted_at 最旧优先。
CREATE INDEX IF NOT EXISTS idx_turn_dispatches_open
  ON turn_dispatches (admitted_at)
  WHERE status IN ('admitted','accepted','rejecting');

-- reconciler terminal-未通知分支扫描面(client_notified=false 的终态)。
CREATE INDEX IF NOT EXISTS idx_turn_dispatches_unnotified
  ON turn_dispatches (terminal_at)
  WHERE status = 'terminal' AND client_notified = FALSE;

-- CCB egress 结算侧按 billing_request_id 反查 dispatch 身份(dispatchId/attemptNo 不进签名
-- 票据,不动 protocol;egress 从 __oc_model_authority.billingRequestId 反查落 usage_records)。
-- billing_request_id 每 dispatch 行唯一(受理铸、同 dispatch 内 attempt 复用),用 UNIQUE 兜正确性。
CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_dispatches_billing_request
  ON turn_dispatches (billing_request_id);

COMMENT ON TABLE turn_dispatches IS
  'Durable turn dispatch authority (RFC-v5-durable-turn-dispatch §2). Logical turn + lease. Admitted in the same PG tx as the user message append; converged by tape finalize and the reconciler. turn_traces is pure observation and never authoritative.';

CREATE TABLE IF NOT EXISTS turn_dispatch_error_projections (
  dispatch_id        UUID PRIMARY KEY REFERENCES turn_dispatches(dispatch_id) ON DELETE CASCADE,
  user_id            BIGINT NOT NULL,
  session_id         TEXT NOT NULL,
  client_message_id  TEXT NOT NULL,
  error_code         TEXT NOT NULL,
  -- 排序键与 user 行同 _seq;虚拟行 id = 'oc-dispatch-err:<dispatch_id>'。
  anchor_seq         BIGINT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- late true tape 到达 → 撤销该投影(钱安全:内容仍完整 materialize)。
  revoked_at         TIMESTAMPTZ
);

-- 读侧只投影 active(未撤销)行,按 (user_id, session_id) 拉。
CREATE INDEX IF NOT EXISTS idx_tdep_session
  ON turn_dispatch_error_projections (user_id, session_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE turn_dispatch_error_projections IS
  'User-visible dispatch-lost error rows (RFC §2.5). Rendered as an error card via a virtual message id; revoked (not deleted) when a late true tape lands so already-billed content is never dropped.';

-- 计费/执行/内容三面加 dispatch 身份列(全可选,老行/legacy 路径 NULL,回滚安全)。
-- request_finalize_journal:接管时严格比对 dispatch/attempt(RFC §2.2 / §7.7)。
ALTER TABLE request_finalize_journal
  ADD COLUMN IF NOT EXISTS dispatch_id UUID,
  ADD COLUMN IF NOT EXISTS attempt_no INTEGER;

-- usage_records:永久财务真相,dispatch 身份无 FK 永久保留值(RFC §2 / §7.10)。
ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS dispatch_id UUID,
  ADD COLUMN IF NOT EXISTS attempt_no INTEGER;

-- client_session_turn_tapes:tape header 承载 dispatch 身份,finalize 收敛读它(RFC §2.4)。
ALTER TABLE client_session_turn_tapes
  ADD COLUMN IF NOT EXISTS dispatch_id UUID,
  ADD COLUMN IF NOT EXISTS attempt_no INTEGER;

-- 容器 boot recovery 的 GET /internal/v3/turn-tape-state 按 dispatch 身份查 tape 三态。
CREATE INDEX IF NOT EXISTS idx_cstt_dispatch
  ON client_session_turn_tapes (dispatch_id, attempt_no)
  WHERE dispatch_id IS NOT NULL;

-- turn_traces:纯展示,记 dispatch_id/request_id 供运维一条 SQL 定位(不参与判定)。
ALTER TABLE turn_traces
  ADD COLUMN IF NOT EXISTS dispatch_id UUID,
  ADD COLUMN IF NOT EXISTS request_id TEXT;

-- ── 会话读物化投影(RFC §9)────────────────────────────────────────────────────
-- 只读缓存派生面:每卷 tape 的 chat 投影行(与今日水合产物同构的**内容行**,不含可变
-- cost/waiver —— 那些读时按 turn_tape_cost_components/turn_waivers 现算叠加,权威源不分裂)。
-- finalize 同事务写入(state='complete');存量卷惰性回填(building→complete/truncated 状态机)。
-- 投影行**绝不**参与 tape 完整性校验 / usage 结算 / dedup 写侧判定(RFC §9.2)。回滚安全:
-- 老 master 不读本表(新表白留);删表即回退全量水合。
CREATE TABLE IF NOT EXISTS tape_chat_projection (
  session_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  tape_id      TEXT NOT NULL,
  -- 该卷的 chat 内容投影行数组(逐记录 64KB 截断:截断处 `_truncated:true` + `_fullBytes`;
  -- 卷级超限尾截 + `_projectionTruncated`)。_seq/_orderSeq 不入库,读时按活体 anchor 现盖。
  rows         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- building = 分段回填半成品(读侧一律折叠,永不冒充完整);complete/truncated 才可展开。
  state        TEXT NOT NULL CHECK (state IN ('building','complete','truncated')),
  -- 完成证据(独立于 rows 行预算,B-§9-3):该卷终态 assistant/error 行的最小保真拷贝
  -- (id/_clientMessageId/status/_errorCode/text 截 4KB)。卷级尾截把 terminal 行截掉时,读侧
  -- (chat/engine dedup + 完成证据)从此列兜底;构建时无条件写(可为 null:该段尚未见终态行)。
  terminal_row JSONB,
  -- 分段回填游标(下一个待处理 record ordinal);单次 finalize / 单段回填后 CAS 推进。
  next_part    INTEGER NOT NULL DEFAULT 0,
  -- 构建时锚定的 tape 聚合 hash;漂移(tape 被重写)→ 作废重建。
  tape_sha256  TEXT NOT NULL,
  total_bytes  BIGINT NOT NULL DEFAULT 0,
  row_count    INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, user_id, tape_id)
);

-- 读侧:两阶段读第一阶段按 (session_id,user_id) 拉本会话所有已收敛投影的 header
-- (不带 rows —— 大 JSONB TOAST 出行,SELECT 不含 rows 列即不 detoast)。PK 前缀已覆盖
-- 点查 tape_id=ANY,此偏索引专服 building 卷的回填对账扫描(避让已收敛卷)。
CREATE INDEX IF NOT EXISTS idx_tape_chat_projection_building
  ON tape_chat_projection (session_id, user_id)
  WHERE state = 'building';

COMMENT ON TABLE tape_chat_projection IS
  'Read-only chat materialized projection per turn tape (RFC §9). Content rows only; volatile cost/waiver re-applied at read from the authoritative billing tables. Never authoritative for tape integrity, settlement, or dedup.';
