-- order-dependency: none
-- OCV5-704: remember the open turn's lossless turn key on the dispatch row so a
-- same-container tool charge can attribute without scanning the journal.
-- Additive, nullable, no backfill, no index. Old binaries never name the column.
-- Rows admitted before this migration stay NULL and are not guessed later.
-- compat: New nullable column. Existing rows and old writers stay NULL. The CHECK accepts NULL and only constrains a new 64-hex turn key. Old binaries never read or write the column. No backfill and no balance change.
ALTER TABLE turn_dispatches
  ADD COLUMN IF NOT EXISTS turn_key TEXT
  CHECK (turn_key IS NULL OR turn_key ~ '^[0-9a-f]{64}$');
COMMENT ON COLUMN turn_dispatches.turn_key IS
  'Lossless turn key of the open attempt, stamped by the first model admit. NULL until then and for rows admitted before 0332. Not a billing amount.';
