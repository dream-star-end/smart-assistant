-- Telemetry closure for selfhost continuous iteration.
-- order-dependency: 0234_all_model_prices_half
--
-- Privacy boundary: every new central table stores bounded metadata/aggregates only.
-- Raw prompts, tool commands, tool outputs and assistant text are forbidden here.

ALTER TABLE turn_traces
  ADD COLUMN control_plane_release TEXT,
  ADD COLUMN control_plane_commit TEXT,
  ADD COLUMN runtime_release TEXT,
  ADD COLUMN runtime_source_commit TEXT,
  ADD COLUMN runtime_boot_hash TEXT,
  ADD COLUMN runtime_container_id BIGINT REFERENCES agent_containers(id) ON DELETE SET NULL,
  ADD COLUMN bundle_rev TEXT,
  ADD COLUMN client_build TEXT,
  ADD COLUMN first_visible_at TIMESTAMPTZ,
  ADD COLUMN first_visible_kind TEXT,
  ADD COLUMN runtime_total_ms BIGINT,
  ADD COLUMN runtime_tool_calls INTEGER,
  ADD COLUMN runtime_observed_at TIMESTAMPTZ;

ALTER TABLE turn_traces
  ADD CONSTRAINT turn_traces_control_plane_commit_shape
    CHECK (control_plane_commit IS NULL OR control_plane_commit ~ '^[0-9a-f]{7,40}$'),
  ADD CONSTRAINT turn_traces_runtime_source_commit_shape
    CHECK (runtime_source_commit IS NULL OR runtime_source_commit ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT turn_traces_runtime_boot_hash_shape
    CHECK (runtime_boot_hash IS NULL OR runtime_boot_hash ~ '^[0-9a-f]{12,64}$'),
  ADD CONSTRAINT turn_traces_version_field_lengths
    CHECK (
      length(COALESCE(control_plane_release, '')) <= 160
      AND length(COALESCE(runtime_release, '')) <= 160
      AND length(COALESCE(bundle_rev, '')) <= 64
      AND length(COALESCE(client_build, '')) <= 64
    ),
  ADD CONSTRAINT turn_traces_first_visible_kind_shape
    CHECK (first_visible_kind IS NULL OR first_visible_kind IN ('thinking','text','tool','agent','other')),
  ADD CONSTRAINT turn_traces_runtime_duration_nonnegative
    CHECK (runtime_total_ms IS NULL OR runtime_total_ms >= 0),
  ADD CONSTRAINT turn_traces_runtime_tool_calls_nonnegative
    CHECK (runtime_tool_calls IS NULL OR runtime_tool_calls >= 0);

CREATE INDEX idx_turn_traces_dispatch_version
  ON turn_traces(dispatch_id, control_plane_release, runtime_release)
  WHERE dispatch_id IS NOT NULL;
CREATE INDEX idx_turn_traces_created_versions
  ON turn_traces(created_at DESC)
  INCLUDE (control_plane_release, runtime_release, client_build);

ALTER TABLE response_rating
  ADD COLUMN dispatch_id UUID REFERENCES turn_dispatches(dispatch_id) ON DELETE SET NULL;
CREATE INDEX idx_response_rating_dispatch
  ON response_rating(dispatch_id) WHERE dispatch_id IS NOT NULL;

ALTER TABLE agent_audit
  ADD COLUMN trace_id TEXT,
  ADD COLUMN dispatch_id UUID REFERENCES turn_dispatches(dispatch_id) ON DELETE SET NULL;
CREATE INDEX idx_agent_audit_trace
  ON agent_audit(trace_id, occurred_at DESC) WHERE trace_id IS NOT NULL;
CREATE INDEX idx_agent_audit_dispatch
  ON agent_audit(dispatch_id, occurred_at DESC) WHERE dispatch_id IS NOT NULL;

ALTER TABLE agent_tool_rollup_counts
  ADD COLUMN total_duration_ms BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN max_duration_ms INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT agent_tool_rollup_duration_nonnegative
    CHECK (total_duration_ms >= 0 AND max_duration_ms >= 0);

CREATE TABLE turn_runtime_observations (
  event_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  container_id BIGINT REFERENCES agent_containers(id) ON DELETE SET NULL,
  trace_id TEXT,
  dispatch_id UUID REFERENCES turn_dispatches(dispatch_id) ON DELETE SET NULL,
  session_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT,
  runtime_release TEXT,
  runtime_source_commit TEXT,
  runtime_boot_hash TEXT,
  duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0),
  tool_calls INTEGER NOT NULL CHECK (tool_calls >= 0),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(event_id) BETWEEN 1 AND 128),
  CHECK (trace_id IS NULL OR length(trace_id) <= 128),
  CHECK (length(session_key) <= 512),
  CHECK (length(agent_id) <= 128),
  CHECK (model IS NULL OR length(model) <= 128),
  CHECK (runtime_release IS NULL OR length(runtime_release) <= 160),
  CHECK (runtime_source_commit IS NULL OR runtime_source_commit ~ '^[0-9a-f]{40}$'),
  CHECK (runtime_boot_hash IS NULL OR runtime_boot_hash ~ '^[0-9a-f]{12,64}$')
);
CREATE INDEX idx_turn_runtime_observations_trace
  ON turn_runtime_observations(trace_id, observed_at DESC) WHERE trace_id IS NOT NULL;
CREATE INDEX idx_turn_runtime_observations_dispatch
  ON turn_runtime_observations(dispatch_id, observed_at DESC) WHERE dispatch_id IS NOT NULL;
CREATE INDEX idx_turn_runtime_observations_user_time
  ON turn_runtime_observations(user_id, observed_at DESC);

CREATE TABLE turn_upstream_performance (
  request_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  dispatch_id UUID REFERENCES turn_dispatches(dispatch_id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  ttft_ms INTEGER,
  stream_ms INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','error','aborted')),
  control_plane_release TEXT,
  control_plane_commit TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(request_id) BETWEEN 1 AND 128),
  CHECK (length(model) BETWEEN 1 AND 128),
  CHECK (ttft_ms IS NULL OR ttft_ms >= 0),
  CHECK (stream_ms IS NULL OR stream_ms >= 0),
  CHECK (control_plane_commit IS NULL OR control_plane_commit ~ '^[0-9a-f]{7,40}$')
);
CREATE INDEX idx_turn_upstream_performance_dispatch
  ON turn_upstream_performance(dispatch_id, observed_at DESC) WHERE dispatch_id IS NOT NULL;
CREATE INDEX idx_turn_upstream_performance_model_time
  ON turn_upstream_performance(model, observed_at DESC);

-- Absolute per-process snapshots, not additive delivery batches. Retrying after an
-- uncertain COMMIT overwrites the same primary key and cannot double-count.
CREATE TABLE telemetry_metric_rollups (
  process_run_id UUID NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  instance_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  component TEXT NOT NULL CHECK (component IN ('master','egress')),
  control_plane_release TEXT,
  control_plane_commit TEXT,
  metric TEXT NOT NULL,
  labels_hash CHAR(64) NOT NULL CHECK (labels_hash ~ '^[0-9a-f]{64}$'),
  labels JSONB NOT NULL CHECK (jsonb_typeof(labels) = 'object'),
  histogram_bounds DOUBLE PRECISION[],
  histogram_counts BIGINT[],
  sample_count BIGINT NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  sample_sum DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (sample_sum >= 0),
  sample_min DOUBLE PRECISION,
  sample_max DOUBLE PRECISION,
  counter_value BIGINT NOT NULL DEFAULT 0 CHECK (counter_value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (process_run_id, bucket_start, metric, labels_hash),
  CHECK (
    (histogram_bounds IS NULL AND histogram_counts IS NULL)
    OR (
      histogram_bounds IS NOT NULL
      AND histogram_counts IS NOT NULL
      AND cardinality(histogram_counts) = cardinality(histogram_bounds) + 1
      AND sample_count = histogram_counts[cardinality(histogram_counts)]
    )
  ),
  CHECK (sample_min IS NULL OR sample_min >= 0),
  CHECK (sample_max IS NULL OR sample_max >= 0),
  CHECK (sample_min IS NULL OR sample_max IS NULL OR sample_min <= sample_max)
);
CREATE INDEX idx_telemetry_metric_rollups_metric_time
  ON telemetry_metric_rollups(metric, bucket_start DESC);
CREATE INDEX idx_telemetry_metric_rollups_release_time
  ON telemetry_metric_rollups(control_plane_release, bucket_start DESC);

CREATE TABLE response_rating_nudges (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  session_id TEXT,
  trace_id TEXT,
  dispatch_id UUID REFERENCES turn_dispatches(dispatch_id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('exposed','rated','dismissed')),
  sample_bucket SMALLINT NOT NULL CHECK (sample_bucket BETWEEN 0 AND 9),
  client_build TEXT,
  exposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rated_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, message_id),
  CHECK (length(message_id) BETWEEN 1 AND 256),
  CHECK (session_id IS NULL OR length(session_id) <= 128),
  CHECK (trace_id IS NULL OR length(trace_id) <= 128),
  CHECK (client_build IS NULL OR length(client_build) <= 64),
  CHECK ((state <> 'rated') OR rated_at IS NOT NULL),
  CHECK ((state <> 'dismissed') OR dismissed_at IS NOT NULL)
);
CREATE INDEX idx_response_rating_nudges_user_time
  ON response_rating_nudges(user_id, exposed_at DESC);

CREATE TABLE telemetry_readiness_evidence (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_ended_at TIMESTAMPTZ NOT NULL,
  ready BOOLEAN NOT NULL,
  metrics JSONB NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  blockers TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  control_plane_release TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (window_started_at < window_ended_at)
);
CREATE INDEX idx_telemetry_readiness_evidence_user_time
  ON telemetry_readiness_evidence(user_id, created_at DESC);

-- One privacy-safe query surface for release/model/tool/quality iteration.
CREATE VIEW turn_iteration_facts AS
SELECT
  d.dispatch_id,d.user_id,d.session_id,d.client_message_id,d.agent_id,d.model,
  d.status,d.outcome,d.failure_code,d.attempt_no,
  d.admitted_at,d.accepted_at,d.terminal_at,
  CASE WHEN d.accepted_at IS NULL THEN NULL
       ELSE GREATEST(0,EXTRACT(EPOCH FROM (d.accepted_at-d.admitted_at))*1000)::bigint END AS admission_ms,
  CASE WHEN t.first_visible_at IS NULL THEN NULL
       ELSE GREATEST(0,EXTRACT(EPOCH FROM (t.first_visible_at-d.admitted_at))*1000)::bigint END AS first_visible_ms,
  CASE WHEN d.terminal_at IS NULL THEN NULL
       ELSE GREATEST(0,EXTRACT(EPOCH FROM (d.terminal_at-d.admitted_at))*1000)::bigint END AS terminal_ms,
  t.trace_id,t.control_plane_release,t.control_plane_commit,t.runtime_source_commit,
  t.runtime_boot_hash,t.bundle_rev,t.client_build,t.first_visible_kind,
  t.runtime_total_ms,t.runtime_tool_calls,
  COALESCE(u.usage_records,0) AS usage_records,
  COALESCE(u.input_tokens,0) AS input_tokens,
  COALESCE(u.output_tokens,0) AS output_tokens,
  COALESCE(u.cache_read_tokens,0) AS cache_read_tokens,
  COALESCE(u.cost_credits,0) AS cost_credits,
  p.upstream_calls,p.upstream_ttft_p50_ms,p.upstream_stream_max_ms,
  COALESCE(r.explicit_up,0) AS explicit_up,
  COALESCE(r.explicit_down,0) AS explicit_down,
  COALESCE(r.implicit_down,0) AS implicit_down
FROM turn_dispatches d
LEFT JOIN LATERAL (
  SELECT * FROM turn_traces x WHERE x.dispatch_id=d.dispatch_id ORDER BY x.created_at LIMIT 1
) t ON TRUE
LEFT JOIN (
  SELECT dispatch_id,COUNT(*) AS usage_records,SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens,SUM(cache_read_tokens) AS cache_read_tokens,
         SUM(cost_credits) AS cost_credits
    FROM usage_records WHERE dispatch_id IS NOT NULL GROUP BY dispatch_id
) u ON u.dispatch_id=d.dispatch_id
LEFT JOIN (
  SELECT dispatch_id,COUNT(*) AS upstream_calls,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms)
           FILTER (WHERE ttft_ms IS NOT NULL) AS upstream_ttft_p50_ms,
         MAX(stream_ms) AS upstream_stream_max_ms
    FROM turn_upstream_performance WHERE dispatch_id IS NOT NULL GROUP BY dispatch_id
) p ON p.dispatch_id=d.dispatch_id
LEFT JOIN (
  SELECT dispatch_id,
         COUNT(*) FILTER (WHERE rating='up' AND NOT ('implicit'=ANY(tags))) AS explicit_up,
         COUNT(*) FILTER (WHERE rating='down' AND NOT ('implicit'=ANY(tags))) AS explicit_down,
         COUNT(*) FILTER (WHERE rating='down' AND 'implicit'=ANY(tags)) AS implicit_down
    FROM response_rating WHERE dispatch_id IS NOT NULL GROUP BY dispatch_id
) r ON r.dispatch_id=d.dispatch_id;
