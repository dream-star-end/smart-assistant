-- order-dependency: 0352_pending_browser_handoffs
-- OCV5-885 (P1-1): Privacy-safe observability for context compaction and prompt context decisions.
-- Additive migration; safe for rolling upgrades and rollbacks.
-- Privacy boundary: bounded metadata only; raw prompts, memory bodies, tool outputs are forbidden.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS context_eval_events (
  event_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container_id BIGINT REFERENCES agent_containers(id) ON DELETE SET NULL,
  trace_id TEXT,
  dispatch_id UUID REFERENCES turn_dispatches(dispatch_id) ON DELETE SET NULL,
  session_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  turn_index INTEGER,
  event_kind TEXT NOT NULL,
  engine TEXT,
  model TEXT,
  compaction_scope TEXT,
  compaction_strategy TEXT,
  before_bytes INTEGER,
  after_bytes INTEGER,
  before_tokens INTEGER,
  after_tokens INTEGER,
  dropped_entries INTEGER,
  decision TEXT,
  reason TEXT,
  changed_slots TEXT[],
  static_prefix_sha256 TEXT,
  total_bytes INTEGER,
  tokens_estimate INTEGER,
  degraded_steps TEXT[],
  runtime_source_commit TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(event_id) BETWEEN 1 AND 128),
  CHECK (trace_id IS NULL OR length(trace_id) <= 128),
  CHECK (length(session_key) BETWEEN 1 AND 512),
  CHECK (length(agent_id) BETWEEN 1 AND 128),
  CHECK (turn_index IS NULL OR turn_index >= 0),
  CHECK (event_kind IN ('context_compacted', 'prompt_context_decision')),
  CHECK (engine IS NULL OR length(engine) <= 64),
  CHECK (model IS NULL OR length(model) <= 128),
  CHECK (compaction_scope IS NULL OR length(compaction_scope) <= 64),
  CHECK (compaction_strategy IS NULL OR length(compaction_strategy) <= 64),
  CHECK (before_bytes IS NULL OR before_bytes >= 0),
  CHECK (after_bytes IS NULL OR after_bytes >= 0),
  CHECK (before_tokens IS NULL OR before_tokens >= 0),
  CHECK (after_tokens IS NULL OR after_tokens >= 0),
  CHECK (dropped_entries IS NULL OR dropped_entries >= 0),
  CHECK (decision IS NULL OR length(decision) <= 64),
  CHECK (reason IS NULL OR length(reason) <= 64),
  CHECK (changed_slots IS NULL OR cardinality(changed_slots) <= 32),
  CHECK (static_prefix_sha256 IS NULL OR static_prefix_sha256 ~ '^[0-9a-f]{12,64}$'),
  CHECK (total_bytes IS NULL OR total_bytes >= 0),
  CHECK (tokens_estimate IS NULL OR tokens_estimate >= 0),
  CHECK (degraded_steps IS NULL OR cardinality(degraded_steps) <= 32),
  CHECK (runtime_source_commit IS NULL OR length(runtime_source_commit) BETWEEN 7 AND 64)
);

CREATE INDEX IF NOT EXISTS idx_context_eval_events_user_time
  ON context_eval_events (user_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_eval_events_kind_time
  ON context_eval_events (event_kind, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_eval_events_trace_time
  ON context_eval_events (trace_id, observed_at DESC)
  WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_context_eval_events_commit_time
  ON context_eval_events (runtime_source_commit, observed_at DESC)
  WHERE runtime_source_commit IS NOT NULL;
