-- Rollback for 0349_commercial_context_eval_observability.sql (OCV5-885 / OCV5-886)

DROP INDEX IF EXISTS idx_context_eval_events_commit_time;
DROP INDEX IF EXISTS idx_context_eval_events_trace_time;
DROP INDEX IF EXISTS idx_context_eval_events_kind_time;
DROP INDEX IF EXISTS idx_context_eval_events_user_time;
DROP TABLE IF EXISTS context_eval_events;
