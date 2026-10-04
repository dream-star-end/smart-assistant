#!/usr/bin/env bash
# Source inside the actual remote fd9 holder, never as a substitute for flock.
# The same nonce + PG admission fence is consumed by all official write lanes.
# Fresh epoch seconds via bash printf. Never date(1) and never a cached shell clock.
# The output name must not be a local of this function. Non-integer fails closed.
v5_mutation_admission_now() {
  local now_target="$1" now_value=""
  case "$now_target" in
    now_target|now_value) return 78 ;;
  esac
  [[ "$now_target" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 78
  printf -v "$now_target" '%s' ''
  printf -v now_value '%(%s)T' -1 || return 78
  [[ "$now_value" =~ ^[0-9]+$ ]] || return 78
  printf -v "$now_target" '%s' "$now_value"
}

# Parse one /proc status document from stdin. Exactly one ASCII PPid.
# Missing, duplicate, or non-digit clears the caller variable and fails closed.
v5_mutation_admission_ppid_from_status() {
  local ppid_target="$1" ppid_line="" ppid_value="" ppid_seen=0
  case "$ppid_target" in
    ppid_target|ppid_line|ppid_value|ppid_seen) return 78 ;;
  esac
  [[ "$ppid_target" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 78
  printf -v "$ppid_target" '%s' ''
  while IFS= read -r ppid_line || [[ -n "$ppid_line" ]]; do
    [[ "$ppid_line" == PPid:* ]] || continue
    ppid_value="${ppid_line#PPid:}"
    ppid_value="${ppid_value#"${ppid_value%%[![:space:]]*}"}"
    ppid_value="${ppid_value%"${ppid_value##*[![:space:]]}"}"
    if (( ppid_seen >= 1 )); then
      printf -v "$ppid_target" '%s' ''
      return 78
    fi
    ppid_seen=1
    if [[ ! "$ppid_value" =~ ^[0-9]+$ ]]; then
      printf -v "$ppid_target" '%s' ''
      return 78
    fi
    printf -v "$ppid_target" '%s' "$ppid_value"
  done
  if (( ppid_seen != 1 )); then
    printf -v "$ppid_target" '%s' ''
    return 78
  fi
}

# Fresh kernel PPid of this shell. No awk, no cache, no process substitution.
v5_mutation_admission_ppid() {
  local ppid_target="$1"
  case "$ppid_target" in
    ppid_target) return 78 ;;
  esac
  [[ "$ppid_target" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 78
  printf -v "$ppid_target" '%s' ''
  [[ -r "/proc/$$/status" && ! -L "/proc/$$/status" ]] || return 78
  v5_mutation_admission_ppid_from_status "$ppid_target" <"/proc/$$/status" || {
    printf -v "$ppid_target" '%s' ''
    return 78
  }
}

v5_mutation_admission() { # nonce-path nonce env-file lease-start lease-ttl parent-pid
  local proof="$1" nonce="$2" env_file="$3" start="$4" ttl="$5" expected_parent="$6"
  local now remaining budget state child rc=0 current_parent identity owner_start lock_identity
  # Read bash EUID. Do not fork id(1) and do not assign EUID.
  [[ "$EUID" == 0 && "$nonce" =~ ^[0-9a-f]{32}$ ]] || return 77
  [[ "$start" =~ ^[0-9]+$ && "$ttl" =~ ^[1-9][0-9]*$ && "$expected_parent" =~ ^[1-9][0-9]*$ ]] || return 77
  [[ -f "$env_file" && ! -L "$env_file" ]] || { echo "admission: pre-provision complete V5 env before bootstrap" >&2; return 77; }
  [[ "$(stat -c '%u:%a' "$env_file")" == "0:600" ]] || { echo "admission: V5 env must be root-owned 0600" >&2; return 77; }
  [[ -e "/proc/$$/fd/9" ]] || return 77
  # Do not delete this proof on holder death. Every successor MUST replace it
  # under the common OS flock before entering the common PG barrier.
  umask 077
  printf '%s\n' "$nonce" >"$proof.tmp.$$" && chmod 600 "$proof.tmp.$$" &&
    mv -f "$proof.tmp.$$" "$proof" || { rm -f "$proof.tmp.$$"; return 77; }
  now=""
  v5_mutation_admission_now now || return 78
  remaining=$(( start + ttl - now ))
  (( remaining > 1 )) || return 78
  budget=$(( remaining - 1 )); (( budget <= 20 )) || budget=20
  state="$(mktemp -d "${proof}.probe.XXXXXX")" || return 77
  owner_start="$(awk '{sub(/^.*\) /,""); print $20}' "/proc/$$/stat")" || { rm -rf "$state"; return 77; }
  [[ "$owner_start" =~ ^[1-9][0-9]*$ ]] || { rm -rf "$state"; return 77; }
  lock_identity="$(stat -Lc '%d:%i' "/proc/$$/fd/9")" || { rm -rf "$state"; return 77; }
  # The PG/timeout descendants must not inherit fd9, including during connect
  # stalls or SIGKILL of this holder. Only this shell owns the OS lease.
  (
    exec 9>&-
    exec setsid timeout --signal=KILL --kill-after=1 "${budget}s" bash -c '
      set -euo pipefail
      env_file="$1"; budget="$2"; identity_state="$3"
      set -a; . "$env_file"; set +a
      : "${DATABASE_URL:?}" "${MODEL_AUTHORITY_DEPLOY_DATABASE_URL:?}" "${MODEL_CATALOG_ADMIN_DATABASE_URL:?}" "${OC_EGRESS_SECRET:?}"
      # Bind all role connections to one explicit libpq TCP endpoint. URI query
      # overrides/multi-host/service defaults could otherwise use another lock manager.
      python3 - "$DATABASE_URL" "$MODEL_AUTHORITY_DEPLOY_DATABASE_URL" "$MODEL_CATALOG_ADMIN_DATABASE_URL" <<PYEND
import sys
from urllib.parse import urlsplit, parse_qsl
try:
    endpoints = []
    for dsn in sys.argv[1:]:
        uri = urlsplit(dsn)
        if uri.scheme not in ("postgres", "postgresql") or not uri.hostname or uri.port is None:
            raise ValueError("explicit TCP URI required")
        if "," in uri.netloc or "/" in uri.hostname or not uri.path.strip("/"):
            raise ValueError("single host/database required")
        blocked = {"host", "hostaddr", "port", "service", "servicefile", "dbname"}
        if any(k.lower() in blocked for k, _ in parse_qsl(uri.query, keep_blank_values=True)):
            raise ValueError("endpoint override")
        endpoints.append((uri.hostname.lower(), uri.port))
    if len(set(endpoints)) != 1:
        raise ValueError("endpoint mismatch")
except Exception:
    print("admission: explicit common PG TCP endpoint required", file=sys.stderr)
    sys.exit(79)
PYEND
      export PGCONNECT_TIMEOUT=2
      export PGOPTIONS="-c statement_timeout=$((budget * 1000)) -c lock_timeout=$((budget * 1000))"
      identity_sql="SELECT json_build_object('"'"'clusterId'"'"', system_identifier::text, '"'"'database'"'"', current_database(), '"'"'databaseOid'"'"', (SELECT oid::text FROM pg_database WHERE datname=current_database()), '"'"'serverAddress'"'"', inet_server_addr()::text, '"'"'serverPort'"'"', inet_server_port(), '"'"'postmasterEpoch'"'"', extract(epoch FROM pg_postmaster_start_time())::text, '"'"'inRecovery'"'"', pg_is_in_recovery())::text FROM pg_control_system()"
      # Explicit deploy-role connection; no DATABASE_URL/v3/default fallback.
      primary="$(psql "$MODEL_AUTHORITY_DEPLOY_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "BEGIN; $identity_sql; SELECT pg_advisory_xact_lock(hashtextextended('"'"'openclaude:v5:production-mutation-admission:v1'"'"',0)); COMMIT;" | sed '"'"'/^[[:space:]]*$/d'"'"')"
      # The common deploy transaction MUST complete before these two read-only
      # role probes start. Both stay in this supervised timeout process group.
      psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$identity_sql" >"$identity_state/gateway.identity" &
      gateway_pid=$!
      psql "$MODEL_CATALOG_ADMIN_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$identity_sql" >"$identity_state/admin.identity" &
      admin_pid=$!
      # Always reap BOTH exact probes, including one-error/other-blocked paths.
      # set -e must not abandon a live sibling after the first failed wait.
      role_rc=0
      wait "$gateway_pid" || role_rc=$?
      wait "$admin_pid" || role_rc=$?
      (( role_rc == 0 )) || exit 79
      identities=("$primary" "$(<"$identity_state/gateway.identity")" "$(<"$identity_state/admin.identity")")
      # One strict decoder for all three actual role results. Unknown fields
      # remain in typed comparison; false must never compare equal to zero.
      python3 - "${identities[@]}" <<PYIDENTITY
# V5_IDENTITY_NORMALIZER_BEGIN
import sys, json, re
from decimal import Decimal
def invalid_constant(value):
    raise ValueError("non-JSON constant")
def canonical(value):
    if value is None: return ("null",)
    if isinstance(value, bool): return ("boolean", value)
    if isinstance(value, Decimal): return ("number", value)
    if isinstance(value, str): return ("string", value)
    if isinstance(value, list): return ("array", tuple(canonical(v) for v in value))
    if isinstance(value, dict): return ("object", tuple((k, canonical(value[k])) for k in sorted(value)))
    raise ValueError("non-JSON type")
def identity(raw):
    value = json.loads(raw, parse_int=Decimal, parse_float=Decimal, parse_constant=invalid_constant)
    if not isinstance(value, dict): raise ValueError("identity must be an object")
    for key in ("clusterId", "databaseOid"):
        if not isinstance(value.get(key), str) or not re.fullmatch("[0-9]+", value[key]):
            raise ValueError("invalid identity digits")
    for key in ("database", "serverAddress", "postmasterEpoch"):
        if not isinstance(value.get(key), str): raise ValueError("invalid identity text")
    if not isinstance(value.get("serverPort"), Decimal): raise ValueError("invalid identity port")
    if value.get("inRecovery") is not False: raise ValueError("recovery must be false")
    return canonical(value)
try:
    if len(sys.argv) != 4: raise ValueError("three role identities required")
    rows = [identity(raw) for raw in sys.argv[1:]]
    if any(row != rows[0] for row in rows[1:]): raise ValueError("identity mismatch")
except Exception:
    print("admission: PG cluster/database identity invalid or mismatched", file=sys.stderr)
    sys.exit(79)
print(sys.argv[1].strip())
# V5_IDENTITY_NORMALIZER_END
PYIDENTITY
    ' admission "$env_file" "$budget" "$state"
  ) >"$state/identity" 2>"$state/error" &
  child=$!
  # Supervise acquisition itself, not just the post-LEASED lifetime.
  while kill -0 "$child" 2>/dev/null; do
    current_parent=""
    v5_mutation_admission_ppid current_parent || current_parent=""
    now=""
    v5_mutation_admission_now now || now=""
    if [[ "$current_parent" != "$expected_parent" ]] || ! kill -0 "$expected_parent" 2>/dev/null ||
        [[ ! "$now" =~ ^[0-9]+$ ]] || (( now - start >= ttl )); then
      kill -KILL -- "-$child" 2>/dev/null || kill -KILL "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
      rm -rf "$state"
      return 78
    fi
    sleep 0.05
  done
  wait "$child" || rc=$?
  if (( rc != 0 )); then
    # Do not echo psql errors: connection strings and passwords are not evidence.
    echo "admission: PG barrier/identity failed (exit=$rc)" >&2
    rm -rf "$state"; return 79
  fi
  now=""
  v5_mutation_admission_now now || now=""
  current_parent=""
  v5_mutation_admission_ppid current_parent || current_parent=""
  if [[ "$current_parent" != "$expected_parent" ]] || ! kill -0 "$expected_parent" 2>/dev/null ||
      [[ ! "$now" =~ ^[0-9]+$ ]] || (( now - start >= ttl )) || [[ "$(cat "$proof" 2>/dev/null)" != "$nonce" ]]; then
    rm -rf "$state"; return 78
  fi
  identity="$(jq -ce --arg nonce "$nonce" --argjson pid "$$" --arg start "$owner_start" --arg lock "$lock_identity" --argjson expiry "$((start+ttl))"     '. + {schema:1,nonce:$nonce,holderPid:$pid,holderStart:$start,lockDevIno:$lock,expiresAt:$expiry}' "$state/identity")" ||
    { rm -rf "$state"; return 79; }
  printf '%s\n' "$identity" >"$proof.db.tmp.$$" && chmod 600 "$proof.db.tmp.$$" &&
    mv -f "$proof.db.tmp.$$" "$proof.db" || { rm -rf "$state"; return 77; }
  rm -rf "$state"
}
