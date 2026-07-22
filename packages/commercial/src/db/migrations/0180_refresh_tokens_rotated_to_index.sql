-- no-transaction
-- refresh_tokens has a self-FK rotated_to_id ... ON DELETE SET NULL.  Without
-- a supporting index, deleting each expired target scans the full table while
-- applying the referential action; production retention hit statement_timeout.
-- CONCURRENTLY keeps authentication traffic available while the index is built.
-- Deliberately omit IF NOT EXISTS:an interrupted concurrent build can leave an
-- invalid same-name index, and silently skipping it would let the migration
-- ledger claim success while the FK still scans the table.  Retry must fail loud
-- until the operator verifies and drops that invalid index concurrently.
CREATE INDEX CONCURRENTLY idx_refresh_tokens_rotated_to_id
  ON refresh_tokens(rotated_to_id);
