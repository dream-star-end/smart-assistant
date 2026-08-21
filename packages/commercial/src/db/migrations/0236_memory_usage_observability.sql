-- 0236_memory_usage_observability — privacy-minimized memory operations and daily rollups.
-- order-dependency: 0235_telemetry_iteration_closure
-- No prompts, memory bodies, excerpts, raw queries or raw session keys cross the container boundary.

CREATE TABLE memory_usage_events (
  event_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  container_id BIGINT REFERENCES agent_containers(id) ON DELETE SET NULL,
  session_hash TEXT,
  agent_id TEXT NOT NULL,
  turn_index INTEGER,
  operation TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  policy_reason TEXT,
  retrieval_mode TEXT,
  result_count INTEGER,
  latency_ms INTEGER NOT NULL,
  query_hash TEXT,
  query_chars INTEGER,
  top_match_hash TEXT,
  freshness_gap BOOLEAN,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(event_id) BETWEEN 1 AND 128),
  CHECK (session_hash IS NULL OR session_hash ~ '^[0-9a-f]{64}$'),
  CHECK (length(agent_id) BETWEEN 1 AND 128),
  CHECK (turn_index IS NULL OR turn_index >= 1),
  CHECK (operation IN (
    'index_injected','core_search','core_read','core_write','core_update','core_delete',
    'profile_write','session_search','archival_add','archival_search','archival_delete',
    'auto_add','auto_skip','auto_refuse'
  )),
  CHECK (memory_type IN ('core','profile','recall','archival','system')),
  CHECK (outcome IN ('hit','no_match','success','denied','error','skipped')),
  CHECK (policy_reason IS NULL OR length(policy_reason) <= 64),
  CHECK (retrieval_mode IS NULL OR retrieval_mode IN ('lexical','semantic','hybrid','bm25','none')),
  CHECK (result_count IS NULL OR result_count >= 0),
  CHECK (latency_ms >= 0),
  CHECK (query_hash IS NULL OR query_hash ~ '^[0-9a-f]{64}$'),
  CHECK (query_chars IS NULL OR query_chars >= 0),
  CHECK (top_match_hash IS NULL OR top_match_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_memory_usage_user_time ON memory_usage_events(user_id, observed_at DESC);
CREATE INDEX idx_memory_usage_operation_time ON memory_usage_events(operation, observed_at DESC);
CREATE INDEX idx_memory_usage_freshness_gap
  ON memory_usage_events(user_id, observed_at DESC) WHERE freshness_gap IS TRUE;

CREATE VIEW memory_usage_daily AS
SELECT
  date_trunc('day', observed_at) AS bucket_start,
  user_id,
  agent_id,
  operation,
  memory_type,
  outcome,
  retrieval_mode,
  COALESCE(freshness_gap, FALSE) AS freshness_gap,
  COUNT(*)::BIGINT AS events,
  COUNT(DISTINCT session_hash)::BIGINT AS sessions,
  COUNT(DISTINCT CONCAT(session_hash, ':', turn_index)) FILTER
    (WHERE freshness_gap IS TRUE)::BIGINT AS freshness_gap_turns,
  SUM(COALESCE(result_count, 0))::BIGINT AS results,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::DOUBLE PRECISION AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::DOUBLE PRECISION AS p95_ms
FROM memory_usage_events
GROUP BY 1,2,3,4,5,6,7,8;

COMMENT ON TABLE memory_usage_events IS
  'Privacy-minimized memory telemetry. Raw prompts, raw queries, memory content and session keys are forbidden.';
COMMENT ON VIEW memory_usage_daily IS
  'Daily central rollup for memory adoption, retrieval quality, latency and freshness-gap shadow signals.';
