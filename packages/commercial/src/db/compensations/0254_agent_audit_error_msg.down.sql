-- 0254_agent_audit_error_msg.down.sql
-- MANUAL compensation. Not executed by migrate.ts (this file lives outside
-- packages/commercial/src/db/migrations/). Joint deploy still does not roll
-- back schema.
--
-- Preconditions (all required):
--   1. live symlink flipped to the previous release, OR OC_TOOL_FAILURE_AUDIT
--      unset in every user container
--   2. max(schema_migrations.version) = 0254_agent_audit_error_msg
--   3. operator already holds pg_advisory_lock(0x0cbe1e5a01)
--   4. operator confirms this down NULLs 0254-window error_msg and remaps
--      empty_output/task_not_found/task_dead → other
--
-- This file contains a leading DO block that RAISEs on drift, then a
-- transaction that restores the 0150 guard and CHECK.

DO $$
DECLARE
  v_max TEXT;
  v_target TEXT := '0254_agent_audit_error_msg';
BEGIN
  SELECT max(version) INTO v_max FROM schema_migrations;
  IF v_max IS DISTINCT FROM v_target THEN
    RAISE EXCEPTION 'compensation refused: max(schema_migrations)=%, expected %', v_max, v_target;
  END IF;
END $$;

BEGIN;

UPDATE agent_tool_rollup_counts
SET error_class = 'other'
WHERE error_class IN ('empty_output', 'task_not_found', 'task_dead');

ALTER TABLE agent_tool_rollup_counts
  DROP CONSTRAINT IF EXISTS agent_tool_rollup_counts_error_class_check;
ALTER TABLE agent_tool_rollup_counts
  ADD CONSTRAINT agent_tool_rollup_counts_error_class_check CHECK (error_class IN (
    'none', 'unknown_skill', 'command_not_found', 'not_executable',
    'file_not_found', 'permission_denied', 'edit_conflict', 'timeout',
    'cancelled', 'validation_error', 'rate_limited', 'service_unavailable',
    'network_error', 'process_exit', 'other'
  ));

CREATE OR REPLACE FUNCTION agent_audit_privacy_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta JSONB;
  v_error_class TEXT;
BEGIN
  v_meta := CASE
    WHEN jsonb_typeof(NEW.input_meta) = 'object' THEN NEW.input_meta
    ELSE '{}'::jsonb
  END;
  v_error_class := v_meta->>'error_class';
  IF v_error_class IS NULL OR v_error_class NOT IN (
    'unknown_skill', 'command_not_found', 'not_executable', 'file_not_found',
    'permission_denied', 'edit_conflict', 'timeout', 'cancelled',
    'validation_error', 'rate_limited', 'service_unavailable', 'network_error',
    'process_exit', 'other'
  ) THEN
    v_error_class := CASE
      WHEN COALESCE(NEW.error_msg, '') ~* 'unknown skill' THEN 'unknown_skill'
      WHEN COALESCE(NEW.error_msg, '') ~* 'command not found|not recognized as (an internal|a) command' THEN 'command_not_found'
      WHEN COALESCE(NEW.error_msg, '') ~* 'cannot execute|not executable' THEN 'not_executable'
      WHEN COALESCE(NEW.error_msg, '') ~* 'old_string.*not found|string to replace.*not found|file (was|has been) modified' THEN 'edit_conflict'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mENOENT\M|no such file or directory|cannot find (the )?(file|path)' THEN 'file_not_found'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mEACCES\M|permission denied|operation not permitted' THEN 'permission_denied'
      WHEN COALESCE(NEW.error_msg, '') ~* 'timed? out|timeout|deadline exceeded' THEN 'timeout'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mabort(ed)?\M|cancelled|canceled' THEN 'cancelled'
      WHEN COALESCE(NEW.error_msg, '') ~* 'too many requests|rate.?limit|http[[:space:]]*429|status[[:space:]]*429' THEN 'rate_limited'
      WHEN COALESCE(NEW.error_msg, '') ~* 'service unavailable|bad gateway|http[[:space:]]*50[23]|status[[:space:]]*50[23]' THEN 'service_unavailable'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mECONN(REFUSED|RESET|ABORTED)\M|\mENOTFOUND\M|network error|fetch failed|socket hang up|\mDNS\M' THEN 'network_error'
      WHEN COALESCE(NEW.error_msg, '') ~* 'validation|invalid (input|argument|request)|schema error|bad request' THEN 'validation_error'
      ELSE 'other'
    END;
  END IF;
  NEW.input_meta := (v_meta - 'input_preview') || jsonb_build_object('error_class', v_error_class);
  NEW.error_msg := NULL;
  RETURN NEW;
END
$$;

UPDATE agent_audit
SET error_msg = NULL
WHERE error_msg IS NOT NULL
  AND occurred_at >= (
    SELECT applied_at FROM schema_migrations WHERE version = '0254_agent_audit_error_msg'
  );

DELETE FROM schema_migrations WHERE version = '0254_agent_audit_error_msg';
COMMIT;
