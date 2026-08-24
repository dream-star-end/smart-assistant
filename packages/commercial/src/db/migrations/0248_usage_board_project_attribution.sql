-- 0248 — usage_records immutable board-project attribution
-- order-dependency: 0247_cursor_opus_48
-- Snapshot of WorkProject (tb_project.id) at settle time. Nullable.
-- Existing rows stay NULL = 未归类. Later session moves must not rewrite these columns.

ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS board_project_id TEXT DEFAULT NULL;

ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS board_project_source TEXT DEFAULT NULL;

ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS board_project_captured_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_ur_board_project
  ON usage_records (user_id, board_project_id)
  WHERE board_project_id IS NOT NULL;

COMMENT ON COLUMN usage_records.board_project_id IS
  'Immutable tb_project.id snapshot at settle. NULL = unattributed historical row.';
COMMENT ON COLUMN usage_records.board_project_source IS
  'session_bind | delegate_parent | explicit | migration_backfill';
COMMENT ON COLUMN usage_records.board_project_captured_at IS
  'Settle-time snapshot clock. Never rewritten when the session later moves.';
