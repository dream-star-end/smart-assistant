-- A message `_seq` cursor can describe inserts and in-place versions, but it
-- cannot describe absence (PUT deletion) or a projection-only mutation such
-- as lossless-tape waiver hydration. Pair incremental reads with this
-- server-owned revision; mismatch forces one full projection refresh.
ALTER TABLE client_sessions
  ADD COLUMN history_revision BIGINT NOT NULL DEFAULT 0
  CHECK (history_revision >= 0);

COMMENT ON COLUMN client_sessions.history_revision IS
  'Monotonic revision for history projection mutations not visible in the hot-row _seq stream';
