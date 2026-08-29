#!/usr/bin/env bash
# DRAFT ONLY — not installed into /opt/openclaude/harness-gate/retention/.
# Human approval required before the reviewer binary consumes this case.
# CASE_ID=07-tool-failure-error-msg
set -euo pipefail
CASE_ID='07-tool-failure-error-msg'

if [[ -z "${DATABASE_URL:-}" ]]; then
  printf '{"case":"%s","result":"FAIL","details":"DATABASE_URL missing"}\n' "$CASE_ID"
  exit 1
fi

read -r n_fail n_empty < <(psql "$DATABASE_URL" -At -F ' ' -c "
SELECT
  count(*) FILTER (WHERE success = false AND occurred_at > now() - interval '2 hours') AS n_fail,
  count(*) FILTER (WHERE success = false AND occurred_at > now() - interval '2 hours'
                   AND coalesce(btrim(error_msg),'') = '') AS n_empty
FROM agent_audit;
")

def=$(psql "$DATABASE_URL" -At -c "SELECT pg_get_functiondef('agent_audit_privacy_guard'::regproc)")
if [[ "$def" != *tool_failed:empty_output* || "$def" != *char_length* ]]; then
  printf '{"case":"%s","result":"FAIL","details":"privacy_guard missing sentinel or char_length"}\n' "$CASE_ID"
  exit 1
fi
if [[ "$def" == *'NEW.error_msg := NULL;'* ]]; then
  printf '{"case":"%s","result":"FAIL","details":"privacy_guard still nulls error_msg"}\n' "$CASE_ID"
  exit 1
fi

if [[ "${n_empty}" != "0" ]]; then
  printf '{"case":"%s","result":"FAIL","details":"n_empty=%s n_fail=%s"}\n' "$CASE_ID" "$n_empty" "$n_fail"
  exit 1
fi

if [[ "${n_fail}" == "0" ]]; then
  printf '{"case":"%s","result":"PASS","details":"no_sample"}\n' "$CASE_ID"
  exit 0
fi

printf '{"case":"%s","result":"PASS","details":"n_fail=%s n_empty=0"}\n' "$CASE_ID" "$n_fail"
