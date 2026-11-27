-- Rollback for 0350_commercial_three_layer_pool_unification.sql (OCV5-890 Wave 1A)

DROP INDEX IF EXISTS idx_model_logical_pool_bindings_lookup;
DROP TABLE IF EXISTS model_logical_pool_bindings;

DROP INDEX IF EXISTS idx_artifact_blob_uploads_tenant_status;
DROP TABLE IF EXISTS artifact_blob_uploads;

DROP INDEX IF EXISTS idx_artifact_blobs_tenant_kind;
DROP INDEX IF EXISTS idx_artifact_blobs_tenant_sha;
DROP TABLE IF EXISTS artifact_blobs;

DROP INDEX IF EXISTS idx_session_placement_migrations_session;
DROP INDEX IF EXISTS uidx_session_placement_migrations_inflight;
DROP TABLE IF EXISTS session_placement_migrations;

DROP INDEX IF EXISTS idx_session_rolling_checkpoints_pending;
DROP TABLE IF EXISTS session_rolling_checkpoints;

DROP INDEX IF EXISTS idx_session_engine_pointers_pool_state;
DROP TABLE IF EXISTS session_engine_pointers;
