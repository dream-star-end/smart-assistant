#!/usr/bin/env bash
# P0 flavor identity (OCV5-20 §2.7). Same schema/rules as
# packages/commercial/src/flavor/flavor-rules.json + assertFlavor.ts.
# Production identity: artifact manifest + real hostname + effector realpath.
# CLI flags are test injection only; OC_FLAVOR_* env is never an identity source.
#
# Usage:
#   assert_flavor_identity [--manifest P] [--hostname H] [--root R] ...
#   assert_allows <effect> [...]
#   write_flavor_manifest <dest-dir> <flavor> <sourceCommit>   # sourced from deploy builders only
#   assert_commercial_cutover [--root CANDIDATE]
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
fi

FLAVOR_MANIFEST_NAME="flavor.manifest.json"
SELFHOST_DB_NAME="openclaude_v5_selfhost"
FLAVOR_RESOLVED=""
FLAVOR_MANIFEST_PATH=""
FLAVOR_ARG_MANIFEST=""
FLAVOR_ARG_HOSTNAME=""
FLAVOR_ARG_ROOT=""
FLAVOR_ARG_DB=""
FLAVOR_ARG_PROFILE=""
FLAVOR_ARG_DOCKERENV=""
FLAVOR_ARG_SIDECAR="0"
FLAVOR_ARG_GENERATION=""
FLAVOR_ARG_REQUIRED=0
FLAVOR_ARG_EFFECTOR=""
FLAVOR_ARG_SKIP_LIVE=0

flavor_die() {
  echo "[flavor-identity] $*" >&2
  return 1
}

flavor_here() {
  ( cd "$(dirname "${BASH_SOURCE[0]}")" && pwd )
}

flavor_rules_path() {
  local here dir
  here="$(flavor_here)"
  # Co-located (scripts/lib + breakglass), bundle etc-codex (json cannot live in
  # bin/ — hotcfg peels only .sh/.py and selfcheck requires bin names bare),
  # then repo trees from scripts/lib or platform-runtime/bin.
  for dir in \
    "$here" \
    "$here/../etc-codex" \
    "$here/../../packages/commercial/src/flavor" \
    "$here/../../../src/flavor"; do
    if [[ -f "$dir/flavor-rules.json" ]]; then
      printf '%s' "$(cd "$dir" && pwd)/flavor-rules.json"
      return 0
    fi
  done
  flavor_die "flavor-rules.json not found"
  return 1
}

flavor_parse_args() {
  FLAVOR_ARG_MANIFEST=""
  FLAVOR_ARG_HOSTNAME=""
  FLAVOR_ARG_ROOT=""
  FLAVOR_ARG_DB=""
  FLAVOR_ARG_PROFILE=""
  FLAVOR_ARG_DOCKERENV=""
  FLAVOR_ARG_SIDECAR="0"
  FLAVOR_ARG_GENERATION=""
  FLAVOR_ARG_REQUIRED=0
  FLAVOR_ARG_EFFECTOR=""
  FLAVOR_ARG_SKIP_LIVE=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --manifest) FLAVOR_ARG_MANIFEST="${2:-}"; shift 2 ;;
      --hostname) FLAVOR_ARG_HOSTNAME="${2:-}"; shift 2 ;;
      --root) FLAVOR_ARG_ROOT="${2:-}"; shift 2 ;;
      --db) FLAVOR_ARG_DB="${2:-}"; shift 2 ;;
      --profile) FLAVOR_ARG_PROFILE="${2:-}"; shift 2 ;;
      --dockerenv) FLAVOR_ARG_DOCKERENV="${2:-}"; shift 2 ;;
      --sidecar) FLAVOR_ARG_SIDECAR="${2:-}"; shift 2 ;;
      --generation) FLAVOR_ARG_GENERATION="${2:-}"; shift 2 ;;
      --effector) FLAVOR_ARG_EFFECTOR="${2:-}"; shift 2 ;;
      --required) FLAVOR_ARG_REQUIRED=1; shift ;;
      --skip-live-probes) FLAVOR_ARG_SKIP_LIVE=1; shift ;;
      --) shift; break ;;
      -*) flavor_die "unknown flag $1"; return 1 ;;
      *) break ;;
    esac
  done
}

flavor_find_release_root() {
  local dir
  dir="$(cd "${1:-.}" && pwd)"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if [[ -f "$dir/$FLAVOR_MANIFEST_NAME" || -f "$dir/.complete" || -f "$dir/MANIFEST.json" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    local parent
    parent="$(dirname "$dir")"
    [[ "$parent" == "$dir" ]] && break
    dir="$parent"
  done
  return 1
}

flavor_read_generation() {
  local root="$1"
  python3 - "$root" "$FLAVOR_MANIFEST_NAME" <<'PY'
import json, os, sys
root, name = sys.argv[1], sys.argv[2]
for fn in (name, ".complete", "MANIFEST.json"):
    path = os.path.join(root, fn)
    if not os.path.isfile(path):
        continue
    try:
        obj = json.load(open(path, encoding="utf-8"))
    except Exception:
        continue
    gen = obj.get("guardGeneration", obj.get("flavorGuardGeneration"))
    if isinstance(gen, int) and not isinstance(gen, bool) and gen >= 1:
        print(gen)
        sys.exit(0)
sys.exit(1)
PY
}

flavor_parse_manifest() {
  local file="$1"
  local rules
  rules="$(flavor_rules_path)" || return 1
  python3 - "$file" "$rules" <<'PY'
import json, re, sys
path, rules_path = sys.argv[1], sys.argv[2]
rules = json.load(open(rules_path, encoding="utf-8"))
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
need = list(rules["requiredFields"])
missing = [k for k in need if k not in obj]
if missing:
    sys.stderr.write(f"[flavor-identity] {path} missing fields: {', '.join(missing)}\n")
    sys.exit(1)
schema = obj.get("schema")
if type(schema) is not int or schema != rules["schema"]:
    sys.stderr.write(f"[flavor-identity] {path} schema must be integer {rules['schema']}, got {json.dumps(schema)}\n")
    sys.exit(1)
flavor = obj.get("flavor")
if flavor not in ("commercial", "selfhost"):
    sys.stderr.write(f"[flavor-identity] {path} flavor must be commercial|selfhost\n")
    sys.exit(1)
commit = obj.get("sourceCommit")
if not isinstance(commit, str) or not re.match(rules["sourceCommitPattern"], commit):
    sys.stderr.write(f"[flavor-identity] {path} sourceCommit must be a full 40-hex SHA\n")
    sys.exit(1)
want_builder = rules["builders"][flavor]
if obj.get("builder") != want_builder:
    sys.stderr.write(
        f"[flavor-identity] {path} cross-write refused: flavor={flavor} requires builder={want_builder}, got {obj.get('builder')}\n"
    )
    sys.exit(1)
gen = obj.get("guardGeneration")
if type(gen) is not int or gen != rules["guardGeneration"]:
    sys.stderr.write(f"[flavor-identity] {path} guardGeneration must be integer {rules['guardGeneration']}, got {json.dumps(gen)}\n")
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

flavor_url_selfhost_profile() {
  python3 - "${DATABASE_URL:-}" <<'PY'
import sys, urllib.parse
url = sys.argv[1]
if "openclaude.migration_profile" in urllib.parse.unquote(url) and "v5-selfhost" in urllib.parse.unquote(url):
    sys.exit(0)
sys.exit(1)
PY
}

flavor_elevating_signals() {
  local hits=""
  [[ "${OC_SELFHOST_ENGINE_LOCAL_TURNS:-}" == 1 ]] && hits="${hits:+$hits,}OC_SELFHOST_ENGINE_LOCAL_TURNS"
  [[ "${SELFHOST_CURSOR_EGRESS:-}" == 1 ]] && hits="${hits:+$hits,}SELFHOST_CURSOR_EGRESS"
  [[ "${OC_SELFHOST_CURSOR_EGRESS:-}" == 1 ]] && hits="${hits:+$hits,}OC_SELFHOST_CURSOR_EGRESS"
  if [[ "${PGOPTIONS:-}" =~ openclaude\.migration_profile[[:space:]]*=[[:space:]]*v5-selfhost([[:space:]]|$) ]]; then
    hits="${hits:+$hits,}PGOPTIONS=v5-selfhost"
  fi
  if [[ -n "${DATABASE_URL:-}" ]] && flavor_url_selfhost_profile; then
    hits="${hits:+$hits,}DATABASE_URL options=v5-selfhost"
  fi
  if [[ "${FLAVOR_ARG_SIDECAR}" == 1 ]]; then
    hits="${hits:+$hits,}sidecar-18992"
  fi
  if [[ "${FLAVOR_ARG_PROFILE}" == "v5-selfhost" ]]; then
    hits="${hits:+$hits,}session-profile=v5-selfhost"
  fi
  printf '%s' "$hits"
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
  flavor_parse_args "$@" || return 1
  local start="${FLAVOR_ARG_EFFECTOR:-${FLAVOR_ARG_ROOT:-$(flavor_here)}}"
  local release_root=""
  release_root="$(flavor_find_release_root "$start" 2>/dev/null || true)"
  local generation=""
  if [[ -n "${FLAVOR_ARG_GENERATION}" ]]; then
    generation="$FLAVOR_ARG_GENERATION"
  elif [[ -n "$release_root" ]]; then
    generation="$(flavor_read_generation "$release_root" 2>/dev/null || true)"
  fi
  local required="$FLAVOR_ARG_REQUIRED"
  if [[ -n "$generation" && "$generation" -ge 1 ]]; then
    required=1
  fi
  local manifest_path=""
  if [[ -n "$FLAVOR_ARG_MANIFEST" ]]; then
    if [[ -f "$FLAVOR_ARG_MANIFEST" ]]; then
      manifest_path="$FLAVOR_ARG_MANIFEST"
    fi
  elif [[ -n "$release_root" && -f "$release_root/$FLAVOR_MANIFEST_NAME" ]]; then
    manifest_path="$release_root/$FLAVOR_MANIFEST_NAME"
  fi
  if [[ -z "$manifest_path" ]]; then
    if [[ "$required" == 1 ]]; then
      flavor_die "flavor.manifest.json missing (guardGeneration=${generation:-required})"
      return 1
    fi
    echo "[flavor-identity] skip: no flavor.manifest.json (legacy artifact)" >&2
    FLAVOR_RESOLVED=""
    return 0
  fi
  local parsed flavor
  parsed="$(flavor_parse_manifest "$manifest_path")" || return 1
  flavor="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["flavor"])' <<<"$parsed")"
  FLAVOR_EXPECTED_HOSTS="$(python3 -c 'import json,sys; print("\n".join(json.loads(sys.stdin.read())["expectedHosts"]))' <<<"$parsed")"
  FLAVOR_EXPECTED_ROOTS="$(python3 -c 'import json,sys; print("\n".join(json.loads(sys.stdin.read())["expectedRoots"]))' <<<"$parsed")"
  FLAVOR_EXPECTED_DBS="$(python3 -c 'import json,sys; print("\n".join(json.loads(sys.stdin.read())["expectedDbNames"]))' <<<"$parsed")"
  export FLAVOR_RESOLVED="$flavor"
  export FLAVOR_MANIFEST_PATH="$manifest_path"
  local hostname="${FLAVOR_ARG_HOSTNAME:-$(hostname)}"
  local install_root="${FLAVOR_ARG_ROOT:-${release_root:-$start}}"
  local dockerenv=0
  if [[ "${FLAVOR_ARG_DOCKERENV}" == 1 ]]; then dockerenv=1
  elif [[ "${FLAVOR_ARG_DOCKERENV}" == 0 ]]; then dockerenv=0
  elif [[ -e /.dockerenv ]]; then dockerenv=1
  fi
  flavor_root_ok "$install_root" || flavor_die "install root ${install_root} is not under expectedRoots"
  local host_ok=0
  if python3 - "$hostname" "${FLAVOR_EXPECTED_HOSTS}" <<'PY'
import sys
sys.exit(0 if sys.argv[1] in sys.argv[2].split("\n") else 1)
PY
  then
    host_ok=0
  else
    host_ok=1
  fi
  if [[ "$host_ok" -ne 0 ]]; then
    if [[ "$dockerenv" -eq 1 ]]; then
      if [[ "$flavor" == "selfhost" && ( "$hostname" == "kl-mirror" || "$hostname" == "ser135234097086" || "$hostname" == "cj-volc-gz" ) ]]; then
        flavor_die "container hostname ${hostname} belongs to the other flavor (manifest=${flavor})"
        return 1
      fi
      if [[ "$flavor" == "commercial" && "$hostname" == "v3-dev-sg" ]]; then
        flavor_die "container hostname ${hostname} belongs to the other flavor (manifest=${flavor})"
        return 1
      fi
    else
      flavor_die "hostname ${hostname} is not in expectedHosts"
      return 1
    fi
  fi
  local elevating
  elevating="$(flavor_elevating_signals)"
  if [[ "$flavor" == "commercial" && -n "$elevating" ]]; then
    flavor_die "commercial identity cannot be upgraded by ${elevating}"
    return 1
  fi
  if [[ -n "${FLAVOR_ARG_DB}" ]]; then
    flavor_db_ok "$flavor" "$FLAVOR_ARG_DB" || return 1
  fi
  echo "[flavor-identity] ok flavor=${flavor} manifest=${manifest_path}" >&2
  return 0
}

assert_allows() {
  local effect="${1:-}"
  shift || true
  [[ -n "$effect" ]] || flavor_die "assert_allows requires an effect"
  assert_flavor_identity "$@" || return 1
  if [[ -z "${FLAVOR_RESOLVED:-}" ]]; then
    return 0
  fi
  if [[ "$FLAVOR_RESOLVED" != "selfhost" ]]; then
    flavor_die "effect ${effect} is forbidden for flavor=${FLAVOR_RESOLVED}"
    return 1
  fi
  if [[ "$effect" == "selfhost-cursor-egress" ]]; then
    if [[ "${SELFHOST_CURSOR_EGRESS:-}" != 1 && "${OC_SELFHOST_CURSOR_EGRESS:-}" != 1 ]]; then
      flavor_die "selfhost-cursor-egress requires SELFHOST_CURSOR_EGRESS=1"
      return 1
    fi
  fi
  return 0
}

flavor_realpath() {
  local p="${1:-}"
  [[ -n "$p" && -e "$p" ]] || return 1
  if command -v realpath >/dev/null 2>&1; then
    realpath -e "$p" 2>/dev/null || return 1
    return 0
  fi
  readlink -f "$p" 2>/dev/null || return 1
}

# Mint is allowed only when a BASH_SOURCE frame realpath-equals one of the two
# official builder scripts next to this helper (scripts/deploy-v5.sh or
# scripts/deploy-v5-selfhost.sh). Same-basename copies under /tmp are refused.
flavor_official_builder_path() {
  local name="${1:-}" here scripts candidate
  [[ "$name" == "deploy-v5.sh" || "$name" == "deploy-v5-selfhost.sh" ]] || return 1
  here="$(flavor_here)" || return 1
  [[ "$(basename "$here")" == "lib" ]] || return 1
  scripts="$(cd "$here/.." && pwd)" || return 1
  [[ "$(basename "$scripts")" == "scripts" ]] || return 1
  candidate="$scripts/$name"
  [[ -f "$candidate" ]] || return 1
  flavor_realpath "$candidate"
}

flavor_writer_caller() {
  local i caller official_selfhost official_commercial
  official_selfhost="$(flavor_official_builder_path deploy-v5-selfhost.sh || true)"
  official_commercial="$(flavor_official_builder_path deploy-v5.sh || true)"
  for ((i=1; i<${#BASH_SOURCE[@]}; i++)); do
    caller="$(flavor_realpath "${BASH_SOURCE[$i]}" 2>/dev/null || true)"
    [[ -n "$caller" ]] || continue
    if [[ -n "$official_selfhost" && "$caller" == "$official_selfhost" ]]; then
      printf '%s' "deploy-v5-selfhost.sh"
      return 0
    fi
    if [[ -n "$official_commercial" && "$caller" == "$official_commercial" ]]; then
      printf '%s' "deploy-v5.sh"
      return 0
    fi
  done
  return 1
}

write_flavor_manifest() {
  local dest="${1:-}" flavor="${2:-}" commit="${3:-}"
  [[ -n "$dest" && -n "$flavor" && -n "$commit" ]] \
    || flavor_die "write_flavor_manifest <dest-dir> <flavor> <sourceCommit>"
  local caller=""
  caller="$(flavor_writer_caller || true)"
  if [[ "$caller" == "deploy-v5.sh" && "$flavor" != "commercial" ]]; then
    flavor_die "cross-write refused: $caller cannot write flavor=${flavor}"
    return 1
  fi
  if [[ "$caller" == "deploy-v5-selfhost.sh" && "$flavor" != "selfhost" ]]; then
    flavor_die "cross-write refused: $caller cannot write flavor=${flavor}"
    return 1
  fi
  if [[ "$caller" != "deploy-v5.sh" && "$caller" != "deploy-v5-selfhost.sh" ]]; then
    flavor_die "write_flavor_manifest is builder-only (caller=${caller:-unofficial})"
    return 1
  fi
  local builder hosts roots dbs
  if [[ "$flavor" == "selfhost" ]]; then
    builder="deploy-v5-selfhost.sh"
    hosts='["v3-dev-sg"]'
    roots='["/opt/openclaude/openclaude-v5-selfhost"]'
    dbs='["openclaude_v5_selfhost"]'
  else
    builder="deploy-v5.sh"
    hosts='["kl-mirror","ser135234097086","cj-volc-gz"]'
    roots='["/opt/openclaude/openclaude-v5","/opt/openclaude/openclaude-v5-b"]'
    dbs='["openclaude"]'
  fi
  mkdir -p "$dest"
  local tmp
  tmp="$(mktemp "$dest/${FLAVOR_MANIFEST_NAME}.XXXXXX")"
  jq -n \
    --argjson schema 1 \
    --argjson guardGeneration 1 \
    --arg flavor "$flavor" \
    --arg sourceCommit "$commit" \
    --arg builder "$builder" \
    --argjson expectedHosts "$hosts" \
    --argjson expectedRoots "$roots" \
    --argjson expectedDbNames "$dbs" \
    '{schema:$schema,flavor:$flavor,sourceCommit:$sourceCommit,builder:$builder,
      expectedHosts:$expectedHosts,expectedRoots:$expectedRoots,expectedDbNames:$expectedDbNames,
      guardGeneration:$guardGeneration}' \
    >"$tmp"
  flavor_parse_manifest "$tmp" >/dev/null \
    || { rm -f "$tmp"; flavor_die "wrote invalid flavor.manifest.json"; return 1; }
  mv -f "$tmp" "$dest/${FLAVOR_MANIFEST_NAME}"
  chmod 0644 "$dest/${FLAVOR_MANIFEST_NAME}"
  echo "[flavor-identity] wrote $dest/${FLAVOR_MANIFEST_NAME} flavor=${flavor}" >&2
}

# Probe execution failure is fail-closed. A command that exists but exits
# nonzero is not treated as "no match" / empty state.
flavor_run_probe() {
  local label="${1:-probe}"
  shift || true
  local out rc=0
  out="$("$@" 2>/dev/null)" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    flavor_die "commercial cutover: ${label} probe failed (rc=${rc})"
    return 1
  fi
  printf '%s' "$out"
  return 0
}

assert_commercial_cutover() {
  flavor_parse_args "$@" || return 1
  local candidate="${FLAVOR_ARG_ROOT:-${PWD}}"
  local generation=""
  if [[ -n "${FLAVOR_ARG_GENERATION}" ]]; then
    generation="$FLAVOR_ARG_GENERATION"
  elif [[ -d "$candidate" ]]; then
    generation="$(flavor_read_generation "$candidate" 2>/dev/null || true)"
  fi
  local manifest="${candidate}/${FLAVOR_MANIFEST_NAME}"
  if [[ ! -f "$manifest" && ( -z "$generation" || "$generation" -lt 1 ) ]]; then
    echo "[flavor-identity] cutover skip: no ${FLAVOR_MANIFEST_NAME} in ${candidate}" >&2
    return 0
  fi
  local identity_root="/opt/openclaude/openclaude-v5"
  case "${FLAVOR_ARG_ROOT:-}" in
    /opt/openclaude/openclaude-v5-b|/opt/openclaude/openclaude-v5-b/*) identity_root="/opt/openclaude/openclaude-v5-b" ;;
  esac
  assert_flavor_identity --manifest "$manifest" --root "$identity_root" \
    --hostname "${FLAVOR_ARG_HOSTNAME:-$(hostname)}" --generation "${generation:-1}" --required \
    || return 1
  if [[ "${FLAVOR_RESOLVED:-}" != "commercial" ]]; then
    flavor_die "commercial cutover requires flavor=commercial, got ${FLAVOR_RESOLVED:-unknown}"
    return 1
  fi
  local env_file="${V5_ENV:-/etc/openclaude/commercial-v5.env}"
  if [[ -f "$env_file" ]]; then
    if grep -Eq '^[[:space:]]*OC_SELFHOST_ENGINE_LOCAL_TURNS=1([[:space:]]|$)' "$env_file"; then
      flavor_die "commercial cutover: $env_file sets OC_SELFHOST_ENGINE_LOCAL_TURNS=1"
      return 1
    fi
    if grep -Eq 'openclaude\.migration_profile[[:space:]]*=[[:space:]]*v5-selfhost' "$env_file"; then
      flavor_die "commercial cutover: $env_file contains v5-selfhost profile"
      return 1
    fi
  fi
  if [[ "$FLAVOR_ARG_SKIP_LIVE" == 1 ]]; then
    echo "[flavor-identity] commercial cutover ok (live probes skipped)" >&2
    return 0
  fi
  local unit="openclaude-v5-selfhost-cursor-proxy.service"
  command -v systemctl >/dev/null 2>&1 || { flavor_die "commercial cutover: systemctl missing"; return 1; }
  command -v ss >/dev/null 2>&1 || { flavor_die "commercial cutover: ss missing"; return 1; }
  if ! command -v iptables >/dev/null 2>&1 && ! command -v nft >/dev/null 2>&1; then
    flavor_die "commercial cutover: iptables/nft missing"
    return 1
  fi
  local fragment state active ss_out ipt_out nft_out
  fragment="$(flavor_run_probe systemctl systemctl show -p FragmentPath --value "$unit")" || return 1
  state="$(flavor_run_probe systemctl systemctl show -p UnitFileState --value "$unit")" || return 1
  active="$(flavor_run_probe systemctl systemctl show -p ActiveState --value "$unit")" || return 1
  if [[ -n "$fragment" && "$fragment" != "" ]]; then
    flavor_die "commercial cutover: ${unit} is installed (FragmentPath=$fragment)"
    return 1
  fi
  case "$state" in
    enabled|enabled-runtime|linked|alias)
      flavor_die "commercial cutover: ${unit} UnitFileState=$state"
      return 1 ;;
  esac
  case "$active" in
    active|activating)
      flavor_die "commercial cutover: ${unit} ActiveState=$active"
      return 1 ;;
  esac
  ss_out="$(flavor_run_probe ss ss -ltn)" || return 1
  if grep -Eq '(:18992)\b' <<<"$ss_out"; then
    flavor_die "commercial cutover: 18992 is listening"
    return 1
  fi
  if command -v iptables >/dev/null 2>&1; then
    ipt_out="$(flavor_run_probe iptables iptables -S)" || return 1
    if grep -Eiq '18992' <<<"$ipt_out"; then
      flavor_die "commercial cutover: iptables mentions 18992"
      return 1
    fi
  fi
  if command -v nft >/dev/null 2>&1; then
    nft_out="$(flavor_run_probe nft nft list ruleset)" || return 1
    if grep -Eiq '18992' <<<"$nft_out"; then
      flavor_die "commercial cutover: nft mentions 18992"
      return 1
    fi
  fi
  if [[ -e /run/oc/cursor-auth/.https-proxy ]]; then
    flavor_die "commercial cutover: cursor 18992 sidecar exists"
    return 1
  fi
  echo "[flavor-identity] commercial cutover ok" >&2
}

assert_commercial_flavor_activation() {
  local candidate="${1:-}"
  [[ -n "$candidate" ]] || flavor_die "assert_commercial_flavor_activation requires a candidate path"
  assert_commercial_cutover --root "$candidate"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  cmd="${1:-identity}"
  shift || true
  case "$cmd" in
    identity) assert_flavor_identity "$@" ;;
    allows) assert_allows "$@" ;;
    cutover-commercial) assert_commercial_cutover "$@" ;;
    write)
      echo "usage: write_flavor_manifest is not a public command; only deploy-v5.sh / deploy-v5-selfhost.sh may mint manifests" >&2
      exit 2
      ;;
    *)
      echo "usage: assert-flavor.sh identity|allows <effect>|cutover-commercial" >&2
      exit 2
      ;;
  esac
fi
