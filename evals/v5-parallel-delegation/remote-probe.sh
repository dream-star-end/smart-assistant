#!/usr/bin/env bash
set -euo pipefail

# Runs on the V5 host. Its exact SHA-256 is frozen into the eval manifest.
# It emits authoritative, reviewable JSON instead of accepting arbitrary query
# commands from capture.mjs.

mode=${1:-}
uid=${2:-}
[[ "$uid" =~ ^[1-9][0-9]*$ ]] || { echo "invalid uid" >&2; exit 2; }
set -a
source /etc/openclaude/commercial-v5.env
set +a

case "$mode" in
  activity)
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -v uid="$uid" <<'SQL'
SELECT json_build_object(
  'user_id', :'uid'::bigint,
  'parents', count(*)::int
)::text
FROM turn_dispatches
WHERE user_id=:'uid'::bigint
  AND agent_id='main'
  AND status IN ('admitted','accepted','rejecting');
SQL
    ;;
  usage)
    peer=${3:-}
    [[ "$peer" =~ ^[A-Za-z0-9_-]{8,160}$ ]] || { echo "invalid peer" >&2; exit 2; }
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -v uid="$uid" -v peer="$peer" <<'SQL'
WITH tapes AS (
  SELECT * FROM client_session_turn_tapes
  WHERE user_id='c:' || :'uid' AND session_id=:'peer'
), matched AS (
  SELECT DISTINCT ur.*
  FROM usage_records ur
  WHERE ur.user_id=:'uid'::bigint AND (
    ur.request_id IN (
      SELECT tc.request_id
      FROM turn_tape_cost_components tc
      JOIN tapes t USING(user_id,session_id,tape_id,billing_anchor_id)
    )
    OR ur.parent_session_id=:'peer'
    OR ur.turn_key IN (SELECT turn_key FROM tapes)
    OR ur.parent_turn_key IN (SELECT turn_key FROM tapes)
  )
), receipts AS (
  SELECT coalesce(json_agg(json_build_object(
    'id',id::text,
    'request_id',request_id,
    'turn_key',turn_key,
    'parent_turn_key',parent_turn_key,
    'parent_session_id',parent_session_id,
    'mode',mode,
    'status',status,
    'tokens',(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens)::bigint,
    'cost_credits',cost_credits::bigint
  ) ORDER BY id),'[]'::json) AS value
  FROM matched
)
SELECT json_build_object(
  'user_id', :'uid'::bigint,
  'peer_id', :'peer',
  'tokens',coalesce(sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens),0)::bigint,
  'cost_credits',coalesce(sum(cost_credits),0)::bigint,
  'rows',count(*)::int,
  'child_rows',count(*) FILTER (WHERE mode='delegate')::int,
  'failed_rows',count(*) FILTER (WHERE status='error')::int,
  'pending_rows',count(*) FILTER (WHERE status NOT IN ('success','error'))::int,
  'receipts',(SELECT value FROM receipts)
)::text FROM matched;
SQL
    ;;
  binding)
    peer=${3:-}
    container=${4:-}
    [[ "$peer" =~ ^[A-Za-z0-9_-]{8,160}$ ]] || { echo "invalid peer" >&2; exit 2; }
    [[ "$container" =~ ^oc-v5-u[1-9][0-9]*$ ]] || { echo "invalid container" >&2; exit 2; }
    db_json=$(
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -v uid="$uid" -v peer="$peer" <<'SQL'
WITH d AS (
  SELECT dispatch_id::text,user_id,session_id
  FROM turn_dispatches
  WHERE user_id=:'uid'::bigint AND session_id=:'peer'
  ORDER BY admitted_at DESC LIMIT 1
), c AS (
  SELECT id::text,user_id,container_internal_id
  FROM agent_containers
  WHERE user_id=:'uid'::bigint AND state='active'
  ORDER BY id DESC LIMIT 1
)
SELECT json_build_object(
  'user_id',:'uid'::bigint,
  'peer_id',:'peer',
  'dispatch_id',d.dispatch_id,
  'dispatch_user_id',d.user_id,
  'dispatch_session_id',d.session_id,
  'agent_container_id',c.id,
  'container_internal_id',c.container_internal_id
)::text FROM d CROSS JOIN c;
SQL
    )
    [[ -n "$db_json" ]] || { echo "binding not found" >&2; exit 3; }
    inspect=$(docker inspect "$container")
    jq -nc --argjson db "$db_json" --argjson inspect "$inspect" \
      '$db + {docker_id:$inspect[0].Id,docker_name:($inspect[0].Name|ltrimstr("/"))}'
    ;;
  lane)
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT row_to_json(x)::text FROM (
  SELECT phase,generation::text,active_slot,candidate_slot,active_release,
         candidate_release,cohort_percent,lock_version::text,transition_step,
         operation_id
  FROM deploy_state WHERE singleton=true
) x;
SQL
    ;;
  freshness)
    started_at=${3:-}
    [[ "$started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || { echo "invalid started_at" >&2; exit 2; }
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At \
      -v uid="$uid" -v started_at="$started_at" <<'SQL'
SELECT json_build_object(
  'user_id', :'uid'::bigint,
  'container_started_at', :'started_at',
  'dispatches', (
    SELECT count(*)::int FROM turn_dispatches
    WHERE user_id=:'uid'::bigint
      AND agent_id='main'
      AND admitted_at >= :'started_at'::timestamptz
  ),
  'usage_rows', (
    SELECT count(*)::int FROM usage_records
    WHERE user_id=:'uid'::bigint AND created_at >= :'started_at'::timestamptz
  )
)::text;
SQL
    ;;
  sample)
    container=${3:-}
    [[ "$container" =~ ^oc-v5-u[1-9][0-9]*$ ]] || { echo "invalid container" >&2; exit 2; }
    parents=$("$0" activity "$uid")
    values=$(docker exec "$container" sh -lc '
      set -eu
      awk '\''$1=="usage_usec"{print "cpu_usec="$2}'\'' /sys/fs/cgroup/cpu.stat
      sed '\''s/^/memory_current=/'\'' /sys/fs/cgroup/memory.current
      sed '\''s/^/memory_max=/'\'' /sys/fs/cgroup/memory.max
      sed '\''s/^/memory_peak=/'\'' /sys/fs/cgroup/memory.peak
      sed '\''s/^/pids_current=/'\'' /sys/fs/cgroup/pids.current
      sed '\''s/^/pids_max=/'\'' /sys/fs/cgroup/pids.max
      sed '\''s/^/pids_peak=/'\'' /sys/fs/cgroup/pids.peak
      awk '\''$1=="oom"{print "memory_oom="$2} $1=="oom_kill"{print "memory_oom_kill="$2}'\'' /sys/fs/cgroup/memory.events
      awk '\''$1=="max"{print "pids_max_events="$2}'\'' /sys/fs/cgroup/pids.events
    ')
    jq -Rn --argjson activity "$parents" --arg values "$values" '
      reduce ($values|split("\n")[]|select(length>0)|split("=")) as $item
        ({activity:$activity}; .[$item[0]]=($item[1] | if .=="max" then "max" else tonumber end))
    '
    ;;
  *)
    echo "usage: remote-probe.sh activity <uid> | usage <uid> <peer> | binding <uid> <peer> <container> | lane <uid> | freshness <uid> <container-started-at> | sample <uid> <container>" >&2
    exit 2
    ;;
esac
