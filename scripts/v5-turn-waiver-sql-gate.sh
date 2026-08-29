#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_COMMIT="${OC_V5_TURN_WAIVER_SOURCE_COMMIT:-HEAD}"
KL_HOST="${KL_HOST:-kl-mirror}"
V5_ENV="${V5_ENV:-/etc/openclaude/commercial-v5.env}"
SOURCE_ONLY=0
if [[ "${1:-}" == "--source-only" ]]; then
  SOURCE_ONLY=1
  shift
fi
[[ $# -eq 0 ]] || { echo "usage: $0 [--source-only]" >&2; exit 2; }

refund_source="$(git -C "$REPO_ROOT" show "$SOURCE_COMMIT:packages/commercial/src/billing/refund.ts")"
grep -Fq "SELECT 'user',\$1::bigint,'本轮已自动免单'" <<<"$refund_source"
grep -Fq "'billing:user:' || (\$1::bigint)::text" <<<"$refund_source"

if [[ "$SOURCE_ONLY" == 1 ]]; then
  echo "✓ turn waiver SQL source gate passed(source=$SOURCE_COMMIT)"
  exit 0
fi

ssh "$KL_HOST" bash -s -- "$V5_ENV" <<'REMOTE'
set -euo pipefail
env_file="$1"
set -a
. "$env_file"
set +a
: "${DATABASE_URL:?DATABASE_URL missing}"

# PREPARE performs PostgreSQL parameter inference without executing the INSERT.
# The read-only transaction is an additional proof that this deploy gate cannot
# create a receipt or mutate billing data.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN READ ONLY;
PREPARE oc_v5_turn_waiver_receipt AS
INSERT INTO inbox_messages
  (audience,user_id,title,body_md,level,category,thread_key,created_by,notify_email,
   source_type,source_id,source_phase)
SELECT 'user',$1::bigint,'本轮已自动免单',$2,'notice','billing',
       'billing:user:' || ($1::bigint)::text,a.id,FALSE,
       'turn_waive',$3::bigint,'receipt'
  FROM (
    SELECT id FROM users
     WHERE role='admin' AND status='active'
     ORDER BY id ASC LIMIT 1
  ) a;
DEALLOCATE oc_v5_turn_waiver_receipt;
ROLLBACK;
SQL
REMOTE

echo "✓ turn waiver SQL parameter inference gate passed(source=$SOURCE_COMMIT)"
