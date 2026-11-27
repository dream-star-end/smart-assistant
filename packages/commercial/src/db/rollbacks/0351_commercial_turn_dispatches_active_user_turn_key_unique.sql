-- Rollback for 0351_commercial_turn_dispatches_active_user_turn_key_unique.sql (run outside transaction).

DROP INDEX CONCURRENTLY IF EXISTS idx_turn_dispatches_active_user_turn_key;
