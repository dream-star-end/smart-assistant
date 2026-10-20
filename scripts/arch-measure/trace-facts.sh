#!/usr/bin/env bash
# OCV5-540: plan §1.7 database facts (trace linkage and which tables carry trace_id), read-only.
# Usage (root on v5-dev): bash scripts/arch-measure/trace-facts.sh [env-file]
# The DSN is read from the env file into the environment, never printed; the session is
# read-only (default_transaction_read_only=on), so no statement here can write.
set -euo pipefail
ENV_FILE="${1:-/etc/openclaude/commercial-v5-selfhost.env}"
[[ -r "$ENV_FILE" ]] || { echo "cannot read $ENV_FILE" >&2; exit 2; }
DATABASE_URL="$(sed -nE 's/^DATABASE_URL=//p' "$ENV_FILE" | tail -1 | sed -E 's/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/')"
[[ -n "$DATABASE_URL" ]] || { echo "no DATABASE_URL in $ENV_FILE" >&2; exit 2; }
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000'
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
\echo '# §1.7 turn_traces.dispatch_id fill rate, last 7 days (plan: 1,828 / 1,843)'
SELECT count(*) AS traces, count(dispatch_id) AS with_dispatch
  FROM turn_traces WHERE created_at > now() - interval '7 days';
\echo '# §1.7 turn_traces.request_id = turn_dispatches.billing_request_id (plan: all)'
SELECT count(*) AS joined, count(*) FILTER (WHERE t.request_id = d.billing_request_id) AS equal
  FROM turn_traces t JOIN turn_dispatches d ON d.dispatch_id = t.dispatch_id
 WHERE t.created_at > now() - interval '7 days';
\echo '# §1.7 tables with a trace_id column (plan: none of turn_dispatches, usage_records, request_finalize_journal, turn_upstream_performance, admin_audit)'
SELECT t.table_name, bool_or(c.column_name = 'trace_id') AS has_trace_id
  FROM (VALUES ('turn_traces'), ('turn_dispatches'), ('usage_records'), ('request_finalize_journal'),
               ('turn_upstream_performance'), ('turn_runtime_observations'), ('admin_audit'),
               ('product_friction_events')) AS t(table_name)
  LEFT JOIN information_schema.columns c ON c.table_name = t.table_name AND c.table_schema = 'public'
 GROUP BY t.table_name ORDER BY t.table_name;
\echo '# §1.7 failure codes of the last 7 days and the latest SERVICE_RESTART (appendix A.3 drill start)'
SELECT status, failure_code, count(*) FROM turn_dispatches
 WHERE failure_code IS NOT NULL AND accepted_at > now() - interval '7 days'
 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10;
SELECT dispatch_id, status, accepted_at FROM turn_dispatches
 WHERE failure_code = 'SERVICE_RESTART' ORDER BY accepted_at DESC LIMIT 1;
SQL
