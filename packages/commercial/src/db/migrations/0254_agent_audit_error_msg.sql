-- order-dependency: 0253_active_claude_proxy_uniqueness
-- 0254_agent_audit_error_msg.sql
--
-- Commercial next after requiredMigrations 0253_active_claude_proxy_uniqueness
-- (same number as selfhost 0254; canonical sequence, not a copy of desktop's
-- unmerged 0254_desktop_virtual_container).
--
-- Allowlist / sentinel error_msg on failed agent_audit rows (≤240 Unicode code
-- points) plus three new rollup error_class values. Same transaction:
--   1) expand agent_tool_rollup_counts.error_class CHECK by exactly +3
--      (DROP CONSTRAINT is breaking DDL; commercial apply is V5_DEV_PLAYBOOK
--      §4.5 under production mutation lease. Set
--      OC_V5_ALLOW_BREAKING_MIGRATION=1 only if the apply wrapper still
--      scans DROP CONSTRAINT; deploy-v5.sh itself does not auto-apply.)
--   2) replace agent_audit_privacy_guard
--   3) no other table-structure changes
--
-- Privacy runbook (manual compensation; joint deploy still does NOT roll back
-- schema). All of the following must hold before running
-- packages/commercial/src/db/compensations/0254_agent_audit_error_msg.down.sql:
--   1. live symlink flipped to the previous release, OR OC_TOOL_FAILURE_AUDIT
--      unset in every user container (reporter no-op)
--   2. max(schema_migrations.version) IS the 0254_agent_audit_error_msg
--      version (later migrations → refuse)
--   3. operator holds pg_advisory_lock(0x0cbe1e5a01) — same key as migrate.ts
--   4. operator confirms: this down NULLs error_msg written during 0254
--      (keyed by created_at / insert time, not occurred_at) and remaps the
--      three new rollup classes to 'other'
-- After down: pg_get_functiondef('agent_audit_privacy_guard') contains
--   NEW.error_msg := NULL; windowed error_msg IS NOT NULL count is 0.

-- 1) Expand rollup error_class CHECK by exactly +3.
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT c.conname INTO v_conname
    FROM pg_constraint c
   WHERE c.conrelid = 'agent_tool_rollup_counts'::regclass
     AND c.contype = 'c'
     AND (
       pg_get_constraintdef(c.oid) LIKE '%error_class IN%'
       OR pg_get_constraintdef(c.oid) LIKE '%error_class = ANY%'
     )
     AND pg_get_constraintdef(c.oid) NOT LIKE '%empty_output%'
   LIMIT 1;
  IF v_conname IS NULL THEN
    SELECT c.conname INTO v_conname
      FROM pg_constraint c
     WHERE c.conrelid = 'agent_tool_rollup_counts'::regclass
       AND c.conname = 'agent_tool_rollup_counts_error_class_check';
  END IF;
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE agent_tool_rollup_counts DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE agent_tool_rollup_counts
  ADD CONSTRAINT agent_tool_rollup_counts_error_class_check CHECK (error_class IN (
    'none', 'unknown_skill', 'command_not_found', 'not_executable',
    'file_not_found', 'permission_denied', 'edit_conflict', 'timeout',
    'cancelled', 'validation_error', 'rate_limited', 'service_unavailable',
    'network_error', 'process_exit', 'other',
    'empty_output', 'task_not_found', 'task_dead'
  ));

-- 2) Replace privacy guard: failed rows keep a sanitized/sentinel error_msg.
CREATE OR REPLACE FUNCTION agent_audit_privacy_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta JSONB;
  v_error_class TEXT;
  v_reason TEXT;
  v_msg TEXT;
  v_secret BOOLEAN;
BEGIN
  v_meta := CASE
    WHEN jsonb_typeof(NEW.input_meta) = 'object' THEN NEW.input_meta
    ELSE '{}'::jsonb
  END;

  IF NEW.success IS TRUE THEN
    NEW.input_meta := v_meta - 'input_preview';
    RETURN NEW;
  END IF;

  v_error_class := v_meta->>'error_class';
  IF v_error_class IS NULL OR v_error_class NOT IN (
    'unknown_skill', 'command_not_found', 'not_executable', 'file_not_found',
    'permission_denied', 'edit_conflict', 'timeout', 'cancelled',
    'validation_error', 'rate_limited', 'service_unavailable', 'network_error',
    'process_exit', 'other',
    'empty_output', 'task_not_found', 'task_dead'
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
      WHEN btrim(COALESCE(NEW.error_msg, '')) = '' THEN 'empty_output'
      WHEN COALESCE(NEW.error_msg, '') ~* '^No task found with ID:' THEN 'task_not_found'
      WHEN COALESCE(NEW.error_msg, '') ~* 'task (already )?(killed|exited|gone)' THEN 'task_dead'
      ELSE 'other'
    END;
  END IF;

  v_reason := v_meta->>'redacted_reason';
  IF v_reason IS NULL OR v_reason NOT IN (
    'empty', 'unmatched_template', 'secret_pattern', 'sanitize_uncertain'
  ) THEN
    v_reason := NULL;
  END IF;

  v_msg := btrim(COALESCE(NEW.error_msg, ''));
  v_secret := v_msg ~* 'BEGIN [A-Z ]*PRIVATE KEY'
           OR v_msg ~* 'BEGIN [A-Z ]+-----'
           OR v_msg ~* 'bearer '
           OR v_msg ~ 'sk-'
           OR v_msg ~ 'xai-'
           OR v_msg ~ 'ghp_'
           OR v_msg ~ 'github_pat_'
           OR v_msg ~* 'postgres(ql)?://'
           OR v_msg ~ 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
           OR v_msg ~* 'password\s*[:=]'
           OR v_msg ~* 'Authorization:';

  -- Fail-closed: home paths are always stripped, then only sentinels or
  -- SQL-provable allowlist templates may persist. Unknown text becomes the
  -- redacted sentinel — never raw dump.
  v_msg := regexp_replace(v_msg, '/home/[^/[:space:]]+', '/home/[user]', 'g');

  IF v_msg = '' THEN
    v_msg := 'tool_failed:empty_output';
    IF v_reason IS NULL THEN
      v_reason := 'empty';
    END IF;
  ELSIF v_secret THEN
    v_msg := 'tool_failed:redacted_output';
    v_reason := 'secret_pattern';
  ELSIF v_msg !~* '^(tool_failed:(empty_output|redacted_output))$'
    AND v_msg !~* 'unknown skill'
    AND v_msg !~* 'command not found|not recognized as (an internal|a) command'
    AND v_msg !~* 'cannot execute|not executable'
    AND v_msg !~* 'old_string.*not found|string to replace.*not found|file (was|has been) modified'
    AND v_msg !~* '\mENOENT\M|no such file or directory|cannot find (the )?(file|path)'
    AND v_msg !~* '\mEACCES\M|permission denied|operation not permitted'
    AND v_msg !~* 'timed? out|timeout|deadline exceeded'
    AND v_msg !~* '\mabort(ed)?\M|cancelled|canceled'
    AND v_msg !~* 'too many requests|rate.?limit|http[[:space:]]*429|status[[:space:]]*429'
    AND v_msg !~* 'service unavailable|bad gateway|http[[:space:]]*50[23]'
    AND v_msg !~* '\mECONN(REFUSED|RESET|ABORTED)\M|\mENOTFOUND\M|network error|fetch failed|socket hang up|\mDNS\M'
    AND v_msg !~* 'validation|invalid (input|argument|request)|schema error|bad request'
    AND v_msg !~* '^No task found with ID: [^[:space:]]+'
    AND v_msg !~* '^task [^[:space:]]+ already (completed|failed|killed|error)'
    AND v_msg !~* '^TaskOutput: empty failed output task_id=[^[:space:]]+ engine=(cursor|grok) status=[^[:space:]]+$'
    AND v_msg !~* '<retrieval_status>(not_found|already_terminal|timeout)</retrieval_status>'
  THEN
    v_msg := 'tool_failed:redacted_output';
    IF v_reason IS NULL THEN
      v_reason := 'unmatched_template';
    END IF;
  ELSIF char_length(v_msg) > 240 THEN
    v_msg := left(v_msg, 240);
  END IF;

  NEW.input_meta := (v_meta - 'input_preview' - 'redacted_reason')
    || jsonb_build_object('error_class', v_error_class);
  IF v_reason IS NOT NULL THEN
    NEW.input_meta := NEW.input_meta || jsonb_build_object('redacted_reason', v_reason);
  END IF;
  NEW.error_msg := v_msg;
  RETURN NEW;
END
$$;
