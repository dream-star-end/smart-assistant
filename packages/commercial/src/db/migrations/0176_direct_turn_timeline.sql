-- 0176_direct_turn_timeline — browser history reads the immutable turn tape
-- directly.  The two former materialized/virtual message tables duplicated
-- user-visible content and could truncate or replace the real agent output.

ALTER TABLE client_session_turn_tapes
  ADD COLUMN IF NOT EXISTS client_message_id TEXT,
  ADD COLUMN IF NOT EXISTS continuation_of_turn_key TEXT,
  ADD COLUMN IF NOT EXISTS physical_record_count INTEGER NOT NULL DEFAULT 0
    CHECK (physical_record_count >= 0),
  ADD COLUMN IF NOT EXISTS logical_record_count INTEGER NOT NULL DEFAULT 0
    CHECK (logical_record_count >= 0),
  ADD COLUMN IF NOT EXISTS record_payload_bytes BIGINT NOT NULL DEFAULT 0
    CHECK (record_payload_bytes >= 0),
  ADD COLUMN IF NOT EXISTS model_record_count INTEGER NOT NULL DEFAULT -1
    CHECK (model_record_count >= -1);

-- Deterministic, security-sanitized browser bytes.  This is not a chat
-- projection: every Agent field remains byte-complete by default, while known opaque
-- runner/account/config envelopes are absent by policy.  New finalizers write
-- it transactionally once; old rows are filled lazily on first explicit
-- record access.  Range reads can then use bytea substring without loading the
-- whole immutable record into Node memory for every 1 MiB transport chunk.
ALTER TABLE client_session_turn_tape_records
  ADD COLUMN IF NOT EXISTS visible_payload BYTEA,
  ADD COLUMN IF NOT EXISTS visible_content_sha256 TEXT
    CHECK (visible_content_sha256 IS NULL OR visible_content_sha256 ~ '^[0-9a-f]{64}$');

-- Private runner continuity sidecar. It is not a browser projection: the
-- browser still reads exact immutable tape bytes. Each row stores the complete
-- deterministic semantic text for one logical Agent record, so a finite model
-- window can scan newest-to-oldest and fetch only the exact suffix that fits
-- without loading gigabytes of older BYTEA into the master first.
CREATE TABLE IF NOT EXISTS client_session_turn_tape_model_records (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tape_id TEXT NOT NULL,
  physical_ordinal INTEGER NOT NULL CHECK (physical_ordinal >= 0),
  logical_ordinal INTEGER NOT NULL CHECK (logical_ordinal >= 0),
  msg_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','plan','goal','agent-group','error')),
  semantic_text TEXT NOT NULL,
  token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
  ts BIGINT,
  client_message_id TEXT,
  PRIMARY KEY (session_id,user_id,tape_id,physical_ordinal,logical_ordinal),
  FOREIGN KEY (session_id,user_id,tape_id)
    REFERENCES client_session_turn_tapes(session_id,user_id,tape_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_csttmr_reverse
  ON client_session_turn_tape_model_records
    (session_id,user_id,tape_id,physical_ordinal DESC,logical_ordinal DESC);

-- A user prompt can legitimately be much larger than the 4 MiB hot-session
-- row that protects the Node event loop. Store its exact immutable browser
-- record out-of-line and keep only a small locator in client_sessions.messages.
-- This is the same lazy-payload shape as Agent tape records, not a projection:
-- payload is the byte-exact user message JSON and text_payload is retained for
-- private model-continuity reads without reserializing or summarizing it.
CREATE TABLE IF NOT EXISTS client_session_user_payloads (
  session_id TEXT NOT NULL REFERENCES client_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  payload BYTEA NOT NULL,
  text_payload TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  payload_bytes BIGINT NOT NULL CHECK (payload_bytes > 0),
  model_token_estimate INTEGER CHECK (model_token_estimate IS NULL OR model_token_estimate >= 0),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (session_id, user_id, msg_id)
);

CREATE INDEX IF NOT EXISTS idx_csup_session_user
  ON client_session_user_payloads(session_id, user_id, created_at);

-- Do not synchronously backfill the immutable record table here. Production
-- already holds >1 GiB of records and deploy migrations run under a 30-second
-- statement timeout. New finalizers maintain these counters transactionally;
-- predecessor-race/legacy rows retain zero and are derived only for the tape(s)
-- on the requested lazy history page by the indexed runtime read path.

UPDATE client_session_turn_tapes t
   SET client_message_id=d.client_message_id
  FROM turn_dispatches d
 WHERE d.dispatch_id=t.dispatch_id
   AND t.client_message_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_cstt_completed_client_message
  ON client_session_turn_tapes(user_id, session_id, client_message_id)
  WHERE finalized_at IS NOT NULL
    AND status = 'completed'
    AND client_message_id IS NOT NULL;

-- Derive logical cardinality from the immutable records themselves.  Do not
-- cast client_sessions.messages to JSONB: that column intentionally stores
-- legal JSON text and production history contains escaped NUL (\u0000), which
-- PostgreSQL JSON accepts but JSONB rejects.  Runtime-batch records carry their
-- exact logical count in their own post-redaction immutable payload.

-- Preserve every currently visible verified failure before the application
-- stops reading its former virtual-message row.  The browser now reads this
-- durable dispatch state directly and renders it as a typed status record,
-- never assistant output.
UPDATE turn_dispatches d
   SET client_notified=TRUE,
       failure_code=COALESCE(d.failure_code, p.error_code)
  FROM turn_dispatch_error_projections p
 WHERE p.dispatch_id=d.dispatch_id
   AND p.revoked_at IS NULL
   AND d.status='terminal'
   AND d.outcome IN ('not_accepted','executed_error');

-- Do not DROP the two legacy tables in the same release that removes their
-- readers/writers.  deploy-v5 applies migrations while the predecessor can
-- still be serving, and that predecessor accesses both tables.  They remain
-- inert rollback compatibility storage only; the new runtime never reads or
-- writes them.  A later migration may remove them after the rollback floor has
-- advanced past every projection-based release.
COMMENT ON TABLE tape_chat_projection IS
  'Legacy rollback-only storage. Direct timeline releases never read or write this table.';
COMMENT ON TABLE turn_dispatch_error_projections IS
  'Legacy rollback-only storage. Direct timeline releases never read or write this table.';

COMMENT ON COLUMN client_session_turn_tapes.physical_record_count IS
  'Exact immutable physical record count, maintained by tape finalization.';
COMMENT ON COLUMN client_session_turn_tapes.logical_record_count IS
  'Exact logical record count after runtime-batch expansion.';
COMMENT ON COLUMN client_session_turn_tapes.record_payload_bytes IS
  'Exact sum of post-redaction immutable record payload bytes.';
COMMENT ON COLUMN client_session_turn_tape_records.visible_payload IS
  'Exact immutable user-visible record bytes after known private metadata is removed; never summarized or truncated.';
COMMENT ON COLUMN client_session_turn_tape_records.visible_content_sha256 IS
  'SHA-256 of visible_payload for byte-range reassembly verification.';
COMMENT ON COLUMN client_session_turn_tapes.model_record_count IS
  'Logical private model-continuity sidecar rows; -1 means a rolling predecessor tape needs lazy compatibility hydration.';
COMMENT ON TABLE client_session_turn_tape_model_records IS
  'Complete deterministic semantic text for finite-window newest-first model context reads; never used by browser history.';
COMMENT ON TABLE client_session_user_payloads IS
  'Exact immutable oversized user-message payloads; hot history stores lazy locators only.';
