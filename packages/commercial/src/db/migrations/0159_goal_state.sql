-- 0159_goal_state — session 级平台权威 GoalState(编号已对生产 ledger 校准:0157/0158 已占用)

CREATE TABLE IF NOT EXISTS session_goals (
  session_id TEXT PRIMARY KEY REFERENCES client_sessions(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 8000),
  status TEXT NOT NULL CHECK (status IN ('active','paused','blocked','completed','cleared')),
  token_budget BIGINT CHECK (token_budget IS NULL OR token_budget > 0),
  credit_budget NUMERIC(78,0) CHECK (credit_budget IS NULL OR credit_budget > 0),
  state_revision BIGINT NOT NULL DEFAULT 1 CHECK (state_revision > 0),
  snapshot_revision BIGINT NOT NULL DEFAULT 1 CHECK (snapshot_revision > 0),
  active_elapsed_ms BIGINT NOT NULL DEFAULT 0 CHECK (active_elapsed_ms >= 0),
  active_started_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  engine_status TEXT,
  engine_tokens_used BIGINT CHECK (engine_tokens_used IS NULL OR engine_tokens_used >= 0),
  engine_time_used_seconds BIGINT CHECK (engine_time_used_seconds IS NULL OR engine_time_used_seconds >= 0),
  engine_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'active') = (active_started_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_session_goals_status_updated
  ON session_goals(status, updated_at DESC);

ALTER TABLE client_session_turn_tapes
  ADD COLUMN IF NOT EXISTS goal_id UUID,
  ADD COLUMN IF NOT EXISTS goal_state_revision BIGINT,
  ADD COLUMN IF NOT EXISTS goal_tokens_used BIGINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cstt_goal_revision_chk'
       AND conrelid = 'client_session_turn_tapes'::regclass
  ) THEN
    ALTER TABLE client_session_turn_tapes
      ADD CONSTRAINT cstt_goal_revision_chk CHECK (
        (goal_id IS NULL AND goal_state_revision IS NULL) OR
        (goal_id IS NOT NULL AND goal_state_revision IS NOT NULL AND goal_state_revision > 0)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cstt_goal_tokens_used_chk'
       AND conrelid = 'client_session_turn_tapes'::regclass
  ) THEN
    ALTER TABLE client_session_turn_tapes
      ADD CONSTRAINT cstt_goal_tokens_used_chk CHECK (goal_tokens_used >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cstt_goal_usage
  ON client_session_turn_tapes(session_id, user_id, goal_id)
  WHERE goal_id IS NOT NULL AND finalized_at IS NOT NULL;

-- Rollback (manual; only after the corresponding runtime/web release is gone):
-- DROP INDEX IF EXISTS idx_cstt_goal_usage;
-- ALTER TABLE client_session_turn_tapes DROP CONSTRAINT IF EXISTS cstt_goal_tokens_used_chk;
-- ALTER TABLE client_session_turn_tapes DROP CONSTRAINT IF EXISTS cstt_goal_revision_chk;
-- ALTER TABLE client_session_turn_tapes DROP COLUMN IF EXISTS goal_tokens_used;
-- ALTER TABLE client_session_turn_tapes DROP COLUMN IF EXISTS goal_state_revision;
-- ALTER TABLE client_session_turn_tapes DROP COLUMN IF EXISTS goal_id;
-- DROP TABLE IF EXISTS session_goals;
