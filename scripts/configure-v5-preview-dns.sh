#!/usr/bin/env bash
# Transactional Cloudflare DNS owner for the V5 same-site preview wildcard.
# This script never updates or replaces a pre-existing wildcard record.
set -Eeuo pipefail

MODE="${1:---status}"
SNAPSHOT_ARG="${2:-}"
case "$MODE" in
  --status|--apply|--dry-run) [[ $# -le 1 ]] || { echo "usage: $0 [--status|--apply|--dry-run|--rollback SNAPSHOT]" >&2; exit 2; } ;;
  --rollback) [[ $# == 2 ]] || { echo "usage: $0 --rollback SNAPSHOT" >&2; exit 2; } ;;
  *) echo "usage: $0 [--status|--apply|--dry-run|--rollback SNAPSHOT]" >&2; exit 2 ;;
esac

ZONE_NAME="claudeai.chat"
WILDCARD_NAME="*.claudeai.chat"
WILDCARD_CONTENT="claudeai.chat"
KEY_FILE="${OC_CLOUDFLARE_KEYS_FILE:-/root/.openclaude/.env.keys}"
SNAPSHOT_DIR="${OC_PREVIEW_DNS_SNAPSHOT_DIR:-/root/.openclaude/v5-dns-snapshots}"
KL_HOST="${KL_HOST:-kl-mirror}"
API="https://api.cloudflare.com/client/v4"
AUTH_CONFIG=""
CF_HTTP_CODE=""

if [[ "$MODE" == --dry-run ]]; then
  echo '[dry-run] verify token, claudeai.chat zone, DNS read and existing HTTP-origin-compatible SSL mode'
  echo '[dry-run] snapshot exact wildcard prestate; create only when absent; reject conflicting/existing non-equivalent state'
  echo '[dry-run] verify API, public DNS, trusted edge TLS and X-OC-Preview-Route marker; exact-ID rollback on failure'
  exit 0
fi

cleanup() { [[ -z "$AUTH_CONFIG" ]] || rm -f "$AUTH_CONFIG"; }
trap cleanup EXIT

read_key() {
  local key="$1" value
  [[ -f "$KEY_FILE" ]] || return 1
  value="$(grep -m1 -E "^${key}=" "$KEY_FILE" | cut -d= -f2- || true)"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then value="${value:1:${#value}-2}"; fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then value="${value:1:${#value}-2}"; fi
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

TOKEN="${CLOUDFLARE_API_TOKEN:-}"
ZONE_ID="${CLOUDFLARE_ZONE_ID_CLAUDEAI:-}"
[[ -n "$TOKEN" ]] || TOKEN="$(read_key CLOUDFLARE_API_TOKEN)" || {
  echo 'FATAL: Cloudflare API token missing' >&2; exit 1;
}
[[ -n "$ZONE_ID" ]] || ZONE_ID="$(read_key CLOUDFLARE_ZONE_ID_CLAUDEAI)" || {
  echo 'FATAL: claudeai.chat Cloudflare zone ID missing' >&2; exit 1;
}
[[ "$ZONE_ID" =~ ^[0-9a-f]{32}$ ]] || { echo 'FATAL: invalid Cloudflare zone ID shape' >&2; exit 1; }

AUTH_CONFIG="$(mktemp)"
chmod 600 "$AUTH_CONFIG"
printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$TOKEN" >"$AUTH_CONFIG"
unset TOKEN

cf_request() {
  local method="$1" path="$2" output="$3" payload="${4:-}"
  local args=(--silent --show-error --config "$AUTH_CONFIG" --request "$method" --output "$output" --write-out '%{http_code}')
  if [[ -n "$payload" ]]; then args+=(--data-binary "@$payload"); fi
  CF_HTTP_CODE="$(curl "${args[@]}" "$API$path")"
}

require_cf_success() {
  local file="$1" action="$2"
  if [[ "$CF_HTTP_CODE" != 2* ]] || ! jq -e '.success == true' "$file" >/dev/null 2>&1; then
    local code
    code="$(jq -r '.errors[0].code // "unknown"' "$file" 2>/dev/null || echo unknown)"
    echo "FATAL: Cloudflare $action failed (HTTP $CF_HTTP_CODE, code $code)" >&2
    return 1
  fi
}

preflight() {
  local dir="$1"
  local verify="$dir/token.json" zone="$dir/zone.json" ssl="$dir/ssl.json"
  cf_request GET /user/tokens/verify "$verify"
  require_cf_success "$verify" 'token verification'
  [[ "$(jq -r '.result.status // ""' "$verify")" == active ]] || {
    echo 'FATAL: Cloudflare token is not active' >&2; return 1;
  }
  cf_request GET "/zones/$ZONE_ID" "$zone"
  require_cf_success "$zone" 'zone lookup'
  [[ "$(jq -r '.result.name // ""' "$zone")" == "$ZONE_NAME" ]] || {
    echo 'FATAL: configured Cloudflare zone is not claudeai.chat' >&2; return 1;
  }
  [[ "$(jq -r '.result.status // ""' "$zone")" == active ]] || {
    echo 'FATAL: claudeai.chat Cloudflare zone is not active' >&2; return 1;
  }
  cf_request GET "/zones/$ZONE_ID/settings/ssl" "$ssl"
  require_cf_success "$ssl" 'SSL mode lookup'
  [[ "$(jq -r '.result.value // ""' "$ssl")" == flexible ]] || {
    echo 'FATAL: zone SSL mode is not compatible with the existing HTTP-only origin; no setting was changed' >&2
    return 1
  }
}

list_wildcard() {
  local output="$1"
  cf_request GET "/zones/$ZONE_ID/dns_records?name=%2A.claudeai.chat&per_page=100" "$output"
  require_cf_success "$output" 'wildcard DNS lookup'
  [[ "$(jq -r '.result_info.total_count // (.result | length)' "$output")" == "$(jq '.result | length' "$output")" ]] || {
    echo 'FATAL: wildcard DNS response was paginated unexpectedly' >&2; return 1;
  }
}

is_exact_desired_record() {
  local file="$1"
  jq -e --arg name "$WILDCARD_NAME" --arg content "$WILDCARD_CONTENT" '
    .result | length == 1 and
    .[0].type == "CNAME" and .[0].name == $name and .[0].content == $content and
    .[0].proxied == true and .[0].ttl == 1
  ' "$file" >/dev/null
}

verify_public_route() {
  local dir="$1" public_host deadline headers
  public_host="ocp-$(openssl rand -hex 16).claudeai.chat"
  deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if dig +short A "$public_host" | grep -q .; then
      headers="$dir/public.headers"
      if curl -sS -D "$headers" -o /dev/null --max-time 10 "https://$public_host/" &&
         [[ "$(grep -ic '^X-OC-Preview-Route: v1' "$headers")" == 1 ]]; then
        return 0
      fi
    fi
    sleep 3
  done
  echo 'FATAL: wildcard DNS/trusted edge TLS/preview route marker probe failed' >&2
  return 1
}

assert_origin_marker() {
  local probe
  probe="ocp-$(openssl rand -hex 16).claudeai.chat"
  ssh "$KL_HOST" bash -s -- "$probe" <<'REMOTE'
set -euo pipefail
probe="$1"; h="$(mktemp)"; trap 'rm -f "$h"' EXIT
curl -sS -D "$h" -o /dev/null --max-time 5 -H "Host: $probe" http://127.0.0.1/
[[ "$(grep -ic '^X-OC-Preview-Route: v1' "$h")" == 1 ]] || {
  echo 'FATAL: origin preview route marker missing' >&2; exit 1;
}
REMOTE
}

snapshot_path=""
rollback_needed=0

restore_snapshot() {
  local requested="$1" resolved dir work records state op expected_id matches id record response
  resolved="$(realpath "$requested")"
  dir="$(realpath "$SNAPSHOT_DIR")"
  [[ "$resolved" == "$dir"/* && -f "$resolved" ]] || {
    echo 'FATAL: rollback snapshot is outside the owned snapshot directory' >&2; return 1;
  }
  [[ "$(stat -c %u "$resolved")" == 0 && "$((8#$(stat -c %a "$resolved") & 8#077))" == 0 ]] || {
    echo 'FATAL: rollback snapshot must be root-owned and mode 0600 or stricter' >&2; return 1;
  }
  jq -e --arg zone "$ZONE_NAME" --arg name "$WILDCARD_NAME" '
    .schema == "openclaude-v5-preview-dns-v1" and .zone_name == $zone and
    .wildcard_name == $name and (.operation_id | test("^[0-9a-f]{32}$")) and
    (.pre_state == "absent" or .pre_state == "identical")
  ' "$resolved" >/dev/null || { echo 'FATAL: invalid rollback snapshot' >&2; return 1; }
  state="$(jq -r '.pre_state' "$resolved")"
  if [[ "$state" == identical ]]; then
    echo '✓ DNS snapshot made no mutation; rollback is a no-op'
    return 0
  fi
  op="$(jq -r '.operation_id' "$resolved")"
  expected_id="$(jq -r '.created_record_id // ""' "$resolved")"
  work="$(mktemp -d)"
  records="$work/records.json"
  list_wildcard "$records"
  if [[ -n "$expected_id" ]]; then
    matches="$(jq --arg id "$expected_id" '[.result[] | select(.id == $id)] | length' "$records")"
  else
    matches="$(jq --arg marker "OpenClaude V5 preview wildcard; op=$op" '[.result[] | select((.comment // "") == $marker)] | length' "$records")"
  fi
  if [[ "$matches" == 0 ]]; then
    [[ "$(jq '.result | length' "$records")" == 0 ]] || {
      rm -rf "$work"; echo 'FATAL: owned DNS record is absent but conflicting wildcard state exists' >&2; return 1;
    }
    rm -rf "$work"
    echo '✓ owned preview wildcard DNS record already absent'
    return 0
  fi
  [[ "$matches" == 1 ]] || { rm -rf "$work"; echo 'FATAL: ambiguous owned wildcard records' >&2; return 1; }
  if [[ -n "$expected_id" ]]; then
    record="$(jq -c --arg id "$expected_id" '.result[] | select(.id == $id)' "$records")"
  else
    record="$(jq -c --arg marker "OpenClaude V5 preview wildcard; op=$op" '.result[] | select((.comment // "") == $marker)' "$records")"
  fi
  jq -e --arg name "$WILDCARD_NAME" --arg content "$WILDCARD_CONTENT" --arg marker "OpenClaude V5 preview wildcard; op=$op" '
    .type == "CNAME" and .name == $name and .content == $content and
    .proxied == true and .ttl == 1 and (.comment // "") == $marker
  ' <<<"$record" >/dev/null || { rm -rf "$work"; echo 'FATAL: owned DNS record attributes drifted; refusing deletion' >&2; return 1; }
  id="$(jq -r '.id' <<<"$record")"
  response="$work/delete.json"
  cf_request DELETE "/zones/$ZONE_ID/dns_records/$id" "$response"
  require_cf_success "$response" 'owned wildcard deletion'
  list_wildcard "$records"
  [[ "$(jq '.result | length' "$records")" == 0 ]] || {
    rm -rf "$work"; echo 'FATAL: wildcard DNS prestate was not restored to absent' >&2; return 1;
  }
  rm -rf "$work"
  echo '✓ owned preview wildcard DNS record removed and absent prestate verified'
}

on_error() {
  local rc=$?
  trap - ERR
  if [[ "$rollback_needed" == 1 && -n "$snapshot_path" ]]; then
    echo 'WARN: DNS apply failed; rolling back the owned mutation' >&2
    restore_snapshot "$snapshot_path" || echo 'FATAL: automatic DNS rollback also failed' >&2
  fi
  exit "$rc"
}
trap on_error ERR

work="$(mktemp -d)"
trap 'rm -rf "$work"; cleanup' EXIT
preflight "$work"

if [[ "$MODE" == --rollback ]]; then
  restore_snapshot "$SNAPSHOT_ARG"
  exit 0
fi

records="$work/records.json"
list_wildcard "$records"
count="$(jq '.result | length' "$records")"
if [[ "$MODE" == --status ]]; then
  if [[ "$count" == 0 ]]; then state=absent
  elif is_exact_desired_record "$records"; then state=identical
  else state=conflict
  fi
  printf 'Cloudflare preflight OK; ssl_mode=flexible; wildcard_state=%s; record_count=%s\n' "$state" "$count"
  exit 0
fi

assert_origin_marker
if [[ "$count" != 0 ]] && ! is_exact_desired_record "$records"; then
  echo 'FATAL: wildcard DNS already exists with a conflicting or ambiguous state; no mutation made' >&2
  exit 1
fi

install -d -m 700 "$SNAPSHOT_DIR"
operation_id="$(openssl rand -hex 16)"
snapshot_path="$SNAPSHOT_DIR/preview-dns-$(date -u +%Y%m%dT%H%M%SZ)-$operation_id.json"
pre_state=absent
[[ "$count" == 0 ]] || pre_state=identical
jq -n \
  --arg schema openclaude-v5-preview-dns-v1 \
  --arg zone "$ZONE_NAME" --arg wildcard "$WILDCARD_NAME" --arg content "$WILDCARD_CONTENT" \
  --arg ssl flexible --arg state "$pre_state" --arg op "$operation_id" \
  --argjson raw "$(jq '.result' "$records")" '
  {
    schema:$schema, created_at:(now | todate), zone_name:$zone, wildcard_name:$wildcard,
    desired:{type:"CNAME",content:$content,proxied:true,ttl:1}, ssl_mode:$ssl,
    pre_state:$state, operation_id:$op, raw_records:$raw, owned_mutation:false
  }
' >"$snapshot_path.tmp"
chmod 600 "$snapshot_path.tmp"
mv "$snapshot_path.tmp" "$snapshot_path"

if [[ "$pre_state" == identical ]]; then
  verify_public_route "$work"
  echo "✓ preview wildcard DNS already exact and public TLS route verified; no mutation; snapshot=$snapshot_path"
  exit 0
fi

payload="$work/create.json"
jq -n --arg name "$WILDCARD_NAME" --arg content "$WILDCARD_CONTENT" \
  --arg comment "OpenClaude V5 preview wildcard; op=$operation_id" '
  {type:"CNAME",name:$name,content:$content,proxied:true,ttl:1,comment:$comment}
' >"$payload"
rollback_needed=1
response="$work/create-response.json"
cf_request POST "/zones/$ZONE_ID/dns_records" "$response" "$payload"
require_cf_success "$response" 'wildcard DNS creation'
created_id="$(jq -r '.result.id // ""' "$response")"
[[ "$created_id" =~ ^[0-9a-f]{32}$ ]] || { echo 'FATAL: Cloudflare returned an invalid record ID' >&2; exit 1; }
jq --arg id "$created_id" '.owned_mutation=true | .created_record_id=$id' "$snapshot_path" >"$snapshot_path.tmp"
chmod 600 "$snapshot_path.tmp"
mv "$snapshot_path.tmp" "$snapshot_path"

list_wildcard "$records"
if ! is_exact_desired_record "$records" ||
   [[ "$(jq -r '.result[0].id' "$records")" != "$created_id" ]]; then
  echo 'FATAL: created wildcard record did not round-trip exactly' >&2; exit 1;
fi

verify_public_route "$work"
rollback_needed=0
echo "✓ preview wildcard DNS created and public TLS route verified; snapshot=$snapshot_path"
