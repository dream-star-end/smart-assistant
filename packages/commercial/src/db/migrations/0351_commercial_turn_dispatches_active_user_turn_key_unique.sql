-- no-transaction
-- order-dependency: 0350_commercial_three_layer_pool_unification
-- OCV5-898 (R2): Enforce database-level uniqueness for active (user_id, turn_key)
-- bindings on turn_dispatches so concurrent transactions can never bind the same
-- logical turn_key to two active dispatches.
-- Online CONCURRENTLY partial unique index: zero table-write lock, safe for rolling
-- upgrades and rollbacks (pre-0351 binaries unaffected).

-- compat: read-only pg_class/pg_index preflight checking only the new 0351 index name for indisvalid=false; mutates no schema or rows and is safe for pre-0351 binaries and rollbacks
DO $$
DECLARE
  invalid_name TEXT;
BEGIN
  SELECT c.relname
    INTO invalid_name
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.relname = 'idx_turn_dispatches_active_user_turn_key'
     AND NOT i.indisvalid
   LIMIT 1;
  IF invalid_name IS NOT NULL THEN
    RAISE EXCEPTION '0351 fail-loud: invalid index detected (%). Runbook: DROP INDEX CONCURRENTLY %; then re-run migrate. Do not insert into schema_migrations.', invalid_name, invalid_name;
  END IF;
END $$;

-- compat: online CONCURRENTLY partial unique index enforcing active (user_id, turn_key) uniqueness on turn_dispatches; zero table-write lock, safe for pre-0351 binaries and rollback drops only this index
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_turn_dispatches_active_user_turn_key
  ON turn_dispatches (user_id, turn_key)
  WHERE turn_key IS NOT NULL
    AND status IN ('admitted', 'accepted', 'rejecting');

-- compat: read-only pg_class/pg_index postflight verifying the new 0351 CONCURRENTLY unique index is valid; mutates no schema or rows and rollback drops only this index
DO $$
DECLARE
  ok BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'idx_turn_dispatches_active_user_turn_key'
       AND i.indisvalid
       AND i.indisunique
  ) INTO ok;
  IF NOT ok THEN
    RAISE EXCEPTION '0351 fail-loud: idx_turn_dispatches_active_user_turn_key missing or invalid after CREATE UNIQUE INDEX CONCURRENTLY';
  END IF;
END $$;
