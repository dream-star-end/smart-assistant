-- order-dependency: 0347_commercial_perf_timeline_and_live_snapshot_indexes
-- OCV5-832 / OCV5-856 (B3): Durable PG backing store for `browser_handoff` pending decisions.
-- compat: purely additive table pending_browser_handoffs and index with openclaude_app DML grants; pre-0348 binaries ignore them and rollback leaves them inert or drops them cleanly.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS pending_browser_handoffs (
  id              TEXT        PRIMARY KEY,
  user_id         TEXT        NOT NULL,
  session_id      TEXT,
  title           TEXT        NOT NULL,
  url             TEXT        NOT NULL,
  reason          TEXT        NOT NULL,
  risk_level      TEXT        NOT NULL DEFAULT 'high',
  status          TEXT        NOT NULL DEFAULT 'pending',
  metadata_json   JSONB,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  resolved_at     TIMESTAMPTZ,
  CONSTRAINT pbh_id_chk         CHECK (length(id) BETWEEN 1 AND 128),
  CONSTRAINT pbh_user_id_chk    CHECK (length(user_id) BETWEEN 1 AND 64),
  CONSTRAINT pbh_risk_level_chk CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT pbh_status_chk     CHECK (status IN ('pending', 'approved', 'denied', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_pending_browser_handoffs_user_status
  ON pending_browser_handoffs (user_id, status, expires_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaude_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE pending_browser_handoffs
      TO openclaude_app;
  END IF;
END $$;
