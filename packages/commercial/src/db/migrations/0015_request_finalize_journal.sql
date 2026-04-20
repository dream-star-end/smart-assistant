-- 0015 request_finalize_journal
--
-- 见 docs/v3/02-DEVELOPMENT-PLAN.md §7 计费规约 / R5b finalizer 二阶段 / R4 reconciler
--
-- 背景:
--   v3 chat 路径 = 内部代理收到容器请求 → preCheck 软预扣 → 上游 fetch + stream →
--   single-shot finalizer 结算。finalizer 是关键不变量:同一 request_id 必须只结算一次,
--   即使中途 supervisor crash / network drop / 容器 SIGKILL。
--
--   v2 单实例只在内存 once-flag,崩了就漏单。v3 落 PG journal,reconciler 每 30s 扫
--   stuck-finalizing 行重跑 → committed/aborted 终态。R4 codex F1 闭合的核心机制。
--
-- 状态机:
--   inflight    — 请求开始,preCheck 通过,正在跑上游 fetch + stream(可能仍未发完一个 chunk)
--   finalizing  — stream 收尾,正在执行扣费 + usage_records INSERT(可能崩在 BEGIN/COMMIT 之间)
--   committed   — finalizer 完成,credit_ledger + usage_records 已落
--   aborted     — finalizer 失败/客户端断/上游 5xx 等(usage_records.status='error',无扣费)
--
--   reconciler 30s 扫:state='inflight' 且 updated_at < now()-30s → 拉 journal 完整 ctx 重跑;
--                       state='finalizing' 且 updated_at < now()-30s → 同上,UNIQUE 约束保幂等
--
-- 7d cron GC:
--   committed/aborted 行 7 天后清理(磁盘),avg row ~200 bytes × 1M req/月 = 200MB/月 算账。
--
-- 注意:
--   - request_id 全局 UNIQUE(不像 usage_records 是 (user_id, request_id) UNIQUE):
--     finalizer journal 的 request_id 由内部 generator 保证唯一(不接受客户端透传),
--     不存在跨用户重复风险。
--   - ctx JSONB 包含 finalizer 重跑所需全部上下文(model, user_id, container_id,
--     preCheck 软预扣 amount, prompt token estimate),崩重启后恢复 finalizer 状态机。
--   - 不写 prompt body(隐私 + 体积)。

CREATE TABLE request_finalize_journal (
  request_id     TEXT PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  container_id   BIGINT REFERENCES agent_containers(id) ON DELETE SET NULL,
  state          TEXT NOT NULL DEFAULT 'inflight'
                 CHECK (state IN ('inflight', 'finalizing', 'committed', 'aborted')),
  ctx            JSONB NOT NULL,
  precheck_credits  BIGINT NOT NULL,
  final_credits     BIGINT,
  ledger_id      BIGINT REFERENCES credit_ledger(id),
  usage_id       BIGINT REFERENCES usage_records(id),
  error_msg      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- reconciler 30s 周期:扫 stuck inflight/finalizing 行
CREATE INDEX idx_rfj_stuck
  ON request_finalize_journal(state, updated_at)
  WHERE state IN ('inflight', 'finalizing');

-- 7d cron GC:扫 committed/aborted 老行
CREATE INDEX idx_rfj_gc
  ON request_finalize_journal(updated_at)
  WHERE state IN ('committed', 'aborted');

-- per-user 时间序(admin 后台查用户最近请求)
CREATE INDEX idx_rfj_user_time
  ON request_finalize_journal(user_id, created_at DESC);

COMMENT ON TABLE request_finalize_journal IS
  'V3 §7 R4/R5b: persistent journal for the chat request finalizer. '
  'reconciler 30s scans stuck inflight/finalizing and replays; '
  '7d cron drops committed/aborted rows.';

COMMENT ON COLUMN request_finalize_journal.ctx IS
  'JSON: { model, user_id, container_id, prompt_token_estimate, ... }. '
  'Sufficient context for finalizer replay after supervisor crash. '
  'NEVER includes prompt/response body (privacy + size).';

COMMENT ON COLUMN request_finalize_journal.precheck_credits IS
  'Credits soft-debited at preCheck (worst-case max_tokens * output_per_mtok * multiplier). '
  'On commit: refund (precheck - final). On abort: refund full precheck.';
