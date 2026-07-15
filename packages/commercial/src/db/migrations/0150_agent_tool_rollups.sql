-- 0150_agent_tool_rollups.sql
--
-- Privacy-safe Agent tool observability:
--   * one compact report per container/reporter interval, including empty
--     heartbeats used only for current-online-fleet coverage;
--   * normalized bounded counters, never raw commands/output/paths;
--   * schema-v3 failure metadata remains protected by the 0149 DB guard.

-- Failure rows can spend up to 24 hours in the container's durable queue.
-- Keep occurrence time separate from server receipt time so detail counts and
-- aggregate rollups use the same event-time window after delayed delivery.
ALTER TABLE agent_audit ADD COLUMN occurred_at TIMESTAMPTZ;
UPDATE agent_audit SET occurred_at = created_at WHERE occurred_at IS NULL;
ALTER TABLE agent_audit ALTER COLUMN occurred_at SET DEFAULT NOW();
ALTER TABLE agent_audit ALTER COLUMN occurred_at SET NOT NULL;
CREATE INDEX idx_agent_audit_occurred_at ON agent_audit(occurred_at DESC);

CREATE TABLE agent_tool_rollup_reports (
  report_id          TEXT PRIMARY KEY
                     CHECK (report_id ~ '^[0-9a-f]{32}$'),
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  container_id       BIGINT NOT NULL,
  reporter_run_id    TEXT NOT NULL
                     CHECK (reporter_run_id ~ '^[0-9a-f]{32}$'),
  sequence           INTEGER NOT NULL CHECK (sequence > 0),
  window_started_at  TIMESTAMPTZ NOT NULL,
  window_ended_at    TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_tool_rollup_window_valid CHECK (
    window_ended_at >= window_started_at
    AND window_ended_at - window_started_at <= INTERVAL '24 hours'
  ),
  CONSTRAINT agent_tool_rollup_run_sequence_unique
    UNIQUE (container_id, reporter_run_id, sequence)
);

CREATE INDEX idx_agent_tool_rollup_reports_window
  ON agent_tool_rollup_reports(window_ended_at DESC);
CREATE INDEX idx_agent_tool_rollup_reports_user_window
  ON agent_tool_rollup_reports(user_id, window_ended_at DESC);
CREATE INDEX idx_agent_tool_rollup_reports_current_run
  ON agent_tool_rollup_reports(container_id, window_ended_at DESC, reporter_run_id, sequence);

CREATE TABLE agent_tool_rollup_counts (
  report_id      TEXT NOT NULL REFERENCES agent_tool_rollup_reports(report_id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
  tool           TEXT NOT NULL CHECK (length(tool) BETWEEN 1 AND 128),
  outcome        TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  error_class    TEXT NOT NULL CHECK (error_class IN (
    'none', 'unknown_skill', 'command_not_found', 'not_executable',
    'file_not_found', 'permission_denied', 'edit_conflict', 'timeout',
    'cancelled', 'validation_error', 'rate_limited', 'service_unavailable',
    'network_error', 'process_exit', 'other'
  )),
  failure_kind   TEXT NOT NULL CHECK (failure_kind IN (
    'none', 'process_exit', 'timeout', 'cancelled', 'tool_error', 'external', 'unknown'
  )),
  call_count     INTEGER NOT NULL CHECK (call_count > 0 AND call_count <= 1000000),
  PRIMARY KEY (report_id, agent_id, tool, outcome, error_class, failure_kind),
  CONSTRAINT agent_tool_rollup_outcome_shape CHECK (
    (outcome = 'success' AND error_class = 'none' AND failure_kind = 'none')
    OR
    (outcome = 'failure' AND error_class <> 'none' AND failure_kind <> 'none')
  )
);

CREATE INDEX idx_agent_tool_rollup_counts_tool
  ON agent_tool_rollup_counts(tool, outcome);

-- Extend the 0149 privacy guard for schema-v3 bounded classes. This function
-- still removes legacy input previews and unconditionally nulls raw errors.
CREATE OR REPLACE FUNCTION agent_audit_privacy_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta JSONB;
  v_error_class TEXT;
BEGIN
  v_meta := CASE
    WHEN jsonb_typeof(NEW.input_meta) = 'object' THEN NEW.input_meta
    ELSE '{}'::jsonb
  END;
  v_error_class := v_meta->>'error_class';
  IF v_error_class IS NULL OR v_error_class NOT IN (
    'unknown_skill', 'command_not_found', 'not_executable', 'file_not_found',
    'permission_denied', 'edit_conflict', 'timeout', 'cancelled',
    'validation_error', 'rate_limited', 'service_unavailable', 'network_error',
    'process_exit', 'other'
  ) THEN
    v_error_class := CASE
      WHEN COALESCE(NEW.error_msg, '') ~* 'unknown skill' THEN 'unknown_skill'
      WHEN COALESCE(NEW.error_msg, '') ~* 'command not found|not recognized as (an internal|a) command' THEN 'command_not_found'
      WHEN COALESCE(NEW.error_msg, '') ~* 'cannot execute|not executable' THEN 'not_executable'
      WHEN COALESCE(NEW.error_msg, '') ~* 'old_string.*not found|string to replace.*not found|file (was|has been) modified' THEN 'edit_conflict'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mENOENT\M|no such file or directory|cannot find (the )?(file|path)' THEN 'file_not_found'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mEACCES\M|permission denied|operation not permitted' THEN 'permission_denied'
      WHEN COALESCE(NEW.error_msg, '') ~* 'timed? out|timeout|deadline exceeded' THEN 'timeout'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mabort(ed)?\M|cancelled|canceled' THEN 'cancelled'
      WHEN COALESCE(NEW.error_msg, '') ~* 'too many requests|rate.?limit|http[[:space:]]*429|status[[:space:]]*429' THEN 'rate_limited'
      WHEN COALESCE(NEW.error_msg, '') ~* 'service unavailable|bad gateway|http[[:space:]]*50[23]|status[[:space:]]*50[23]' THEN 'service_unavailable'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mECONN(REFUSED|RESET|ABORTED)\M|\mENOTFOUND\M|network error|fetch failed|socket hang up|\mDNS\M' THEN 'network_error'
      WHEN COALESCE(NEW.error_msg, '') ~* 'validation|invalid (input|argument|request)|schema error|bad request' THEN 'validation_error'
      ELSE 'other'
    END;
  END IF;
  NEW.input_meta := (v_meta - 'input_preview') || jsonb_build_object('error_class', v_error_class);
  NEW.error_msg := NULL;
  RETURN NEW;
END
$$;
