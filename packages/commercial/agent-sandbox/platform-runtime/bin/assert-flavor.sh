#!/usr/bin/env bash
# P0 flavor identity (OCV5-20 §2.7). Same schema/rules as
# packages/commercial/src/flavor/assertFlavor.ts. Missing manifest = skip so
# current artifacts keep working until the first pack that writes
# flavor.manifest.json.
#
# Usage (source or exec):
#   assert_flavor_identity
#   assert_allows selfhost-cursor-egress|selfhost-unit-install|selfhost-pricing|selfhost-migrate-profile
#   write_flavor_manifest <dest-dir> <flavor> <sourceCommit>
#   assert_commercial_cutover
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
fi

FLAVOR_MANIFEST_SCHEMA=1
FLAVOR_MANIFEST_NAME="flavor.manifest.json"
SELFHOST_DB_NAME="openclaude_v5_selfhost"

flavor_die() {
  echo "[flavor-identity] $*" >&2
  return 1
}

flavor_builder_for() {
  case "$1" in
    selfhost) echo "deploy-v5-selfhost.sh" ;;
    commercial) echo "deploy-v5.sh" ;;
    *) flavor_die "flavor must be commercial|selfhost, got $1"; return 1 ;;
  esac
}

flavor_env_set() {
  local key="$1"
  [ -n "${!key:-}" ]
}

flavor_pgoptions_selfhost() {
  [[ "${PGOPTIONS:-}" =~ openclaude\.migration_profile[[:space:]]*=[[:space:]]*v5-selfhost([[:space:]]|$) ]]
}

flavor_elevating_signals() {
  local hits=""
  local key
  for key in OC_SELFHOST_ENGINE_LOCAL_TURNS SELFHOST_CURSOR_EGRESS OC_SELFHOST_CURSOR_EGRESS; do
    if flavor_env_set "$key"; then
      hits="${hits:+$hits,}$key"
    fi
  done
  if flavor_pgoptions_selfhost; then
    hits="${hits:+$hits,}PGOPTIONS=v5-selfhost"
  fi
  if [[ "${OC_FLAVOR_SIDECAR_18992:-0}" == 1 ]]; then
    hits="${hits:+$hits,}sidecar-18992"
  fi
  printf '%s' "$hits"
}

flavor_find_manifest() {
  local candidate
  if [[ -n "${OC_FLAVOR_MANIFEST:-}" ]]; then
    printf '%s' "$OC_FLAVOR_MANIFEST"
    return 0
  fi
  for candidate in \
    "${PWD}/${FLAVOR_MANIFEST_NAME}" \
    "${OC_FLAVOR_INSTALL_ROOT:-}/${FLAVOR_MANIFEST_NAME}" \
    "${OC_RUNTIME_RELEASE:-}/${FLAVOR_MANIFEST_NAME}" \
    "${OC_PLATFORM_ROOT:-}/${FLAVOR_MANIFEST_NAME}"; do
    [[ "$candidate" == "/${FLAVOR_MANIFEST_NAME}" ]] && continue
    if [[ -f "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

flavor_parse_manifest() {
  local file="$1"
  python3 - "$file" "$FLAVOR_MANIFEST_SCHEMA" <<'PY'
import json, sys
path, schema = sys.argv[1], int(sys.argv[2])
try:
    raw = open(path, encoding="utf-8").read()
except FileNotFoundError:
    sys.stderr.write(f"[flavor-identity] manifest missing: {path}\n")
    sys.exit(1)
try:
    obj = json.loads(raw)
except json.JSONDecodeError:
    sys.stderr.write(f"[flavor-identity] manifest not JSON: {path}\n")
    sys.exit(1)
if not isinstance(obj, dict):
    sys.stderr.write(f"[flavor-identity] {path} is not a JSON object\n")
    sys.exit(1)
need = ["schema", "flavor", "sourceCommit", "builder", "expectedHosts", "expectedRoots", "expectedDbNames"]
missing = [k for k in need if k not in obj]
if missing:
    sys.stderr.write(f"[flavor-identity] {path} missing fields: {', '.join(missing)}\n")
    sys.exit(1)
if obj.get("schema") != schema:
    sys.stderr.write(f"[flavor-identity] {path} schema must be {schema}, got {obj.get('schema')}\n")
    sys.exit(1)
flavor = obj.get("flavor")
if flavor not in ("commercial", "selfhost"):
    sys.stderr.write(f"[flavor-identity] {path} flavor must be commercial|selfhost\n")
    sys.exit(1)
commit = obj.get("sourceCommit")
if not isinstance(commit, str) or len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
    sys.stderr.write(f"[flavor-identity] {path} sourceCommit must be a full 40-hex SHA\n")
    sys.exit(1)
want_builder = "deploy-v5-selfhost.sh" if flavor == "selfhost" else "deploy-v5.sh"
if obj.get("builder") != want_builder:
    sys.stderr.write(
        f"[flavor-identity] {path} cross-write refused: flavor={flavor} requires builder={want_builder}, got {obj.get('builder')}\n"
    )
    sys.exit(1)
for key in ("expectedHosts", "expectedRoots", "expectedDbNames"):
    val = obj.get(key)
    if not isinstance(val, list) or not val or any(not isinstance(x, str) or not x for x in val):
        sys.stderr.write(f"[flavor-identity] {path} {key} must be a non-empty string array\n")
        sys.exit(1)
json.dump(obj, sys.stdout)
PY
}

flavor_root_ok() {
  local install_root="$1"
  python3 - "$install_root" "${FLAVOR_EXPECTED_ROOTS:-}" <<'PY'
import os, sys
root = os.path.abspath(sys.argv[1])
expected = [os.path.abspath(x) for x in sys.argv[2].split("\n") if x]
for exp in expected:
    if root == exp or root == exp + "-live":
        sys.exit(0)
    if root.startswith(exp + "/") or root.startswith(exp + "-releases/") or root.startswith(exp + "-live/"):
        sys.exit(0)
sys.exit(1)
PY
}

flavor_host_ok() {
  local hostname="$1"
  python3 - "$hostname" "${FLAVOR_EXPECTED_HOSTS:-}" "${KL_HOST:-}" <<'PY'
import sys
host = sys.argv[1]
allowed = {x for x in sys.argv[2].split("\n") if x}
kl = sys.argv[3].strip()
if kl:
    allowed.add(kl)
sys.exit(0 if host in allowed else 1)
PY
}

flavor_db_ok() {
  local flavor="$1" db="$2"
  python3 - "$flavor" "$db" "$SELFHOST_DB_NAME" "${FLAVOR_EXPECTED_DBS:-}" <<'PY'
import sys
flavor, db, selfhost, expected_raw = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
expected = [x for x in expected_raw.split("\n") if x]
if flavor == "selfhost":
    if db != selfhost or db not in expected:
        sys.stderr.write(f"[flavor-identity] selfhost migrate db must be {selfhost}, got {db}\n")
        sys.exit(1)
    sys.exit(0)
if db == selfhost:
    sys.stderr.write(f"[flavor-identity] commercial migrate refuses selfhost db {selfhost}\n")
    sys.exit(1)
if db not in expected:
    sys.stderr.write(f"[flavor-identity] commercial db {db} not in expectedDbNames={','.join(expected)}\n")
    sys.exit(1)
PY
}

assert_flavor_identity() {
  local required="${OC_FLAVOR_GUARD_REQUIRED:-0}"
  local manifest_path=""
  if ! manifest_path="$(flavor_find_manifest)"; then
    if [[ "$required" == 1 ]]; then
      flavor_die "flavor.manifest.json missing (OC_FLAVOR_GUARD_REQUIRED=1)"
      return 1
    fi
    echo "[flavor-identity] skip: no flavor.manifest.json (legacy artifact)" >&2
    return 0
  fi
  if [[ ! -f "$manifest_path" ]]; then
    if [[ "$required" == 1 ]]; then
      flavor_die "flavor.manifest.json missing (OC_FLAVOR_GUARD_REQUIRED=1)"
      return 1
    fi
    echo "[flavor-identity] skip: no flavor.manifest.json (legacy artifact)" >&2
    return 0
  fi
  local parsed flavor builder
  parsed="$(flavor_parse_manifest "$manifest_path")" || return 1
  flavor="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["flavor"])' <<<"$parsed")"
  FLAVOR_EXPECTED_HOSTS="$(python3 -c 'import json,sys; print("\n".join(json.loads(sys.stdin.read())["expectedHosts"]))' <<<"$parsed")"
  FLAVOR_EXPECTED_ROOTS="$(python3 -c 'import json,sys; print("\n".join(json.loads(sys.stdin.read())["expectedRoots"]))' <<<"$parsed")"
  FLAVOR_EXPECTED_DBS="$(python3 -c 'import json,sys; print("\n".join(json.loads(sys.stdin.read())["expectedDbNames"]))' <<<"$parsed")"
  export FLAVOR_RESOLVED="$flavor"
  export FLAVOR_MANIFEST_PATH="$manifest_path"
  local hostname="${OC_FLAVOR_HOSTNAME:-$(hostname)}"
  local install_root="${OC_FLAVOR_INSTALL_ROOT:-${OC_RUNTIME_RELEASE:-$PWD}}"
  local dockerenv=0
  if [[ "${OC_FLAVOR_DOCKERENV:-}" == 1 ]]; then
    dockerenv=1
  elif [[ "${OC_FLAVOR_DOCKERENV:-}" == 0 ]]; then
    dockerenv=0
  elif [[ -e /.dockerenv ]]; then
    dockerenv=1
  fi
  if [[ "$dockerenv" -eq 0 ]]; then
    flavor_host_ok "$hostname" || flavor_die "hostname ${hostname} is not in expectedHosts"
  else
    if [[ "$flavor" == "selfhost" && ( "$hostname" == "kl-mirror" || "$hostname" == "ser135234097086" ) ]]; then
      flavor_die "container hostname ${hostname} belongs to the other flavor (manifest=${flavor})"
    fi
    if [[ "$flavor" == "commercial" && "$hostname" == "v3-dev-sg" ]]; then
      flavor_die "container hostname ${hostname} belongs to the other flavor (manifest=${flavor})"
    fi
  fi
  flavor_root_ok "$install_root" || flavor_die "install root ${install_root} is not under expectedRoots"
  local elevating
  elevating="$(flavor_elevating_signals)"
  if [[ "$flavor" == "commercial" && -n "$elevating" ]]; then
    flavor_die "commercial identity cannot be upgraded by ${elevating}"
  fi
  if [[ -n "${OC_FLAVOR_DB_NAME:-}" ]]; then
    flavor_db_ok "$flavor" "$OC_FLAVOR_DB_NAME" || return 1
  fi
  echo "[flavor-identity] ok flavor=${flavor} manifest=${manifest_path}" >&2
  return 0
}

assert_allows() {
  local effect="${1:-}"
  [[ -n "$effect" ]] || flavor_die "assert_allows requires an effect"
  assert_flavor_identity || return 1
  if [[ -z "${FLAVOR_RESOLVED:-}" ]]; then
    return 0
  fi
  if [[ "$FLAVOR_RESOLVED" != "selfhost" ]]; then
    flavor_die "effect ${effect} is forbidden for flavor=${FLAVOR_RESOLVED}"
    return 1
  fi
  if [[ "$effect" == "selfhost-cursor-egress" ]]; then
    if [[ -z "${SELFHOST_CURSOR_EGRESS:-}" && -z "${OC_SELFHOST_CURSOR_EGRESS:-}" ]]; then
      flavor_die "selfhost-cursor-egress requires SELFHOST_CURSOR_EGRESS=1"
      return 1
    fi
  fi
  return 0
}

write_flavor_manifest() {
  local dest="${1:-}" flavor="${2:-}" commit="${3:-}"
  local extra_hosts="${4:-}" extra_dbs="${5:-}"
  [[ -n "$dest" && -n "$flavor" && -n "$commit" ]] \
    || flavor_die "write_flavor_manifest <dest-dir> <flavor> <sourceCommit>"
  local builder
  builder="$(flavor_builder_for "$flavor")" || return 1
  local caller
  caller="$(basename "${FLAVOR_WRITE_BUILDER:-${0##*/}}")"
  if [[ "$caller" != "assert-flavor.sh" && "$caller" != "$builder" && "$caller" != "bash" && "$caller" != "-bash" ]]; then
    # When sourced, $0 is the caller script. Cross-write is fail-closed.
    if [[ "$caller" == "deploy-v5.sh" && "$flavor" != "commercial" ]]; then
      flavor_die "cross-write refused: $caller cannot write flavor=${flavor}"
      return 1
    fi
    if [[ "$caller" == "deploy-v5-selfhost.sh" && "$flavor" != "selfhost" ]]; then
      flavor_die "cross-write refused: $caller cannot write flavor=${flavor}"
      return 1
    fi
  fi
  local hosts roots dbs
  if [[ "$flavor" == "selfhost" ]]; then
    hosts='["v3-dev-sg"]'
    roots='["/opt/openclaude/openclaude-v5-selfhost"]'
    dbs='["openclaude_v5_selfhost"]'
  else
    hosts='["kl-mirror","ser135234097086"]'
    roots='["/opt/openclaude/openclaude-v5","/opt/openclaude/openclaude-v5-b"]'
    dbs='["openclaude"]'
  fi
  if [[ -n "$extra_hosts" ]]; then
    hosts="$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a += [x for x in sys.argv[2].split(",") if x and x not in a]; print(json.dumps(a))' "$hosts" "$extra_hosts")"
  fi
  if [[ -n "$extra_dbs" ]]; then
    dbs="$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a += [x for x in sys.argv[2].split(",") if x and x not in a]; print(json.dumps(a))' "$dbs" "$extra_dbs")"
  fi
  mkdir -p "$dest"
  local tmp
  tmp="$(mktemp "$dest/${FLAVOR_MANIFEST_NAME}.XXXXXX")"
  jq -n \
    --argjson schema "$FLAVOR_MANIFEST_SCHEMA" \
    --arg flavor "$flavor" \
    --arg sourceCommit "$commit" \
    --arg builder "$builder" \
    --argjson expectedHosts "$hosts" \
    --argjson expectedRoots "$roots" \
    --argjson expectedDbNames "$dbs" \
    '{schema:$schema,flavor:$flavor,sourceCommit:$sourceCommit,builder:$builder,
      expectedHosts:$expectedHosts,expectedRoots:$expectedRoots,expectedDbNames:$expectedDbNames}' \
    >"$tmp"
  flavor_parse_manifest "$tmp" >/dev/null \
    || { rm -f "$tmp"; flavor_die "wrote invalid flavor.manifest.json"; return 1; }
  mv -f "$tmp" "$dest/${FLAVOR_MANIFEST_NAME}"
  chmod 0644 "$dest/${FLAVOR_MANIFEST_NAME}"
  echo "[flavor-identity] wrote $dest/${FLAVOR_MANIFEST_NAME} flavor=${flavor}" >&2
}

assert_commercial_cutover() {
  # Production cutover assertions. Skip when the candidate has no flavor
  # manifest so current production behavior is unchanged.
  local candidate="${OC_FLAVOR_CUTOVER_ROOT:-${PWD}}"
  local manifest="${candidate}/${FLAVOR_MANIFEST_NAME}"
  if [[ ! -f "$manifest" ]]; then
    echo "[flavor-identity] cutover skip: no ${FLAVOR_MANIFEST_NAME} in ${candidate}" >&2
    return 0
  fi
  export OC_FLAVOR_MANIFEST="$manifest"
  export OC_FLAVOR_INSTALL_ROOT="${OC_FLAVOR_INSTALL_ROOT:-/opt/openclaude/openclaude-v5}"
  assert_flavor_identity || return 1
  if [[ "${FLAVOR_RESOLVED:-}" != "commercial" ]]; then
    flavor_die "commercial cutover requires flavor=commercial, got ${FLAVOR_RESOLVED:-unknown}"
    return 1
  fi
  if flavor_env_set OC_SELFHOST_ENGINE_LOCAL_TURNS || flavor_pgoptions_selfhost; then
    flavor_die "commercial cutover refuses OC_SELFHOST_* / v5-selfhost PGOPTIONS"
    return 1
  fi
  local unit="openclaude-v5-selfhost-cursor-proxy.service"
  if [[ -e "/etc/systemd/system/${unit}" ]]; then
    flavor_die "commercial cutover: ${unit} is installed under /etc/systemd/system"
    return 1
  fi
  if command -v systemctl >/dev/null 2>&1; then
    local enabled active
    enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    active="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [[ "$enabled" == "enabled" ]]; then
      flavor_die "commercial cutover: ${unit} is enabled"
      return 1
    fi
    if [[ "$active" == "active" ]]; then
      flavor_die "commercial cutover: ${unit} is active"
      return 1
    fi
  fi
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -Eq '(:18992)\b'; then
      flavor_die "commercial cutover: 18992 is listening"
      return 1
    fi
  fi
  if [[ -e /run/oc/cursor-auth/.https-proxy ]]; then
    flavor_die "commercial cutover: cursor 18992 sidecar exists"
    return 1
  fi
  echo "[flavor-identity] commercial cutover ok" >&2
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  cmd="${1:-identity}"
  shift || true
  case "$cmd" in
    identity) assert_flavor_identity "$@" ;;
    allows)
      assert_allows "$@"
      ;;
    write) write_flavor_manifest "$@" ;;
    cutover-commercial) assert_commercial_cutover "$@" ;;
    *)
      echo "usage: assert-flavor.sh identity|allows <effect>|write <dir> <flavor> <sha>|cutover-commercial" >&2
      exit 2
      ;;
  esac
fi
