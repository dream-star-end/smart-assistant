#!/usr/bin/env bash
# Install a narrow Caddy handle_errors fallback for v5 upstream connection
# failures. It does not match ordinary upstream HTTP status responses, so an
# application-generated 4xx/5xx passes through unchanged.
set -Eeuo pipefail

KL_HOST="${KL_HOST:-kl-mirror}"
CADDYFILE="/etc/caddy/Caddyfile"
SNIPPET="/etc/caddy/openclaude-v5-upstream-errors.caddy"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1
SELF_TEST=0
[[ "${1:-}" == "--self-test" ]] && SELF_TEST=1
[[ $# -le 1 ]] || { echo "usage: $0 [--dry-run|--self-test]" >&2; exit 2; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat >"$tmp" <<'CADDY'
# Managed by install-v5-upstream-errors.sh. reverse_proxy transport/dial
# failures enter handle_errors; normal application HTTP responses do not.
handle_errors {
	@v5_upstream_unavailable expression `{err.status_code} in [502, 503, 504]`
	handle @v5_upstream_unavailable {
		@v5_machine_path path /api/* /healthz /version /ws*
		handle @v5_machine_path {
			header Retry-After "5"
			header Content-Type "application/json; charset=utf-8"
			respond `{"error":"service_temporarily_unavailable","retry_after":5}` 503
		}
		header Retry-After "5"
		header Content-Type "text/html; charset=utf-8"
		respond `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>服务维护中</title><body><main style="font:16px system-ui;max-width:36rem;margin:15vh auto;padding:24px"><h1>服务暂时不可用</h1><p>系统正在恢复，请稍后重试。</p></main></body></html>` 503
	}
}
CADDY

if [[ "$DRY" == 1 ]]; then
  echo "[dry-run] strict-shape check $KL_HOST:$CADDYFILE"
  echo "[dry-run] alternate-port probes: app 418 passthrough, API/HTML/WS upstream failure => 503"
  echo "[dry-run] transactional install $SNIPPET + import, validate/reload/live smoke; rollback on any failure"
  exit 0
fi

remote_tmp="/tmp/openclaude-v5-upstream-errors.$$.caddy"
rsync -az "$tmp" "$KL_HOST:$remote_tmp"
ssh "$KL_HOST" bash -s -- "$CADDYFILE" "$SNIPPET" "$remote_tmp" "$SELF_TEST" <<'REMOTE'
set -Eeuo pipefail
caddyfile="$1"; snippet="$2"; candidate="$3"; self_test="$4"; import_line="import $snippet"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"; work="$(mktemp -d)"
backup_caddy="$caddyfile.pre-v5-errors-$stamp"
backup_snippet="$snippet.pre-v5-errors-$stamp"
had_snippet=0; mutated=0; probe_pid=''

cleanup() {
  [[ -z "$probe_pid" ]] || kill "$probe_pid" >/dev/null 2>&1 || true
  rm -rf "$work" "$candidate"
}
rollback() {
  local rc=$?
  trap - ERR
  if [[ "$mutated" == 1 ]]; then
    cp -a "$backup_caddy" "$caddyfile"
    if [[ "$had_snippet" == 1 ]]; then cp -a "$backup_snippet" "$snippet"; else rm -f "$snippet"; fi
    caddy validate --config "$caddyfile" --adapter caddyfile >/dev/null 2>&1 || true
    systemctl reload caddy >/dev/null 2>&1 || true
    curl -fsS --max-time 5 -H 'Host: claudeai.chat' http://127.0.0.1/healthz >/dev/null 2>&1 || true
    echo 'FATAL: install failed; previous Caddyfile/snippet restored and reload attempted' >&2
  fi
  cleanup
  exit "$rc"
}
trap rollback ERR
trap cleanup EXIT

[[ -f "$caddyfile" ]] || { echo 'FATAL: Caddyfile missing' >&2; exit 1; }
[[ "$(grep -c '^http://claudeai\.chat[[:space:]]*{' "$caddyfile")" == 1 ]] || { echo 'FATAL: unexpected claudeai.chat site shape' >&2; exit 1; }
site_start="$(grep -n '^http://claudeai\.chat[[:space:]]*{' "$caddyfile" | cut -d: -f1)"
site_end="$(awk -v start="$site_start" '
  NR < start { next }
  NR == start { depth=1; next }
  {
    line=$0; sub(/^[[:space:]]*/, "", line); sub(/[[:space:]]*$/, "", line)
    if (line ~ /\{$/) depth++
    if (line == "}") depth--
    if (depth == 0) { print NR; exit }
  }
' "$caddyfile")"
[[ "$site_end" =~ ^[0-9]+$ && "$site_end" -gt "$site_start" ]] || { echo 'FATAL: cannot locate claudeai.chat closing brace' >&2; exit 1; }
sed -n "${site_start},${site_end}p" "$caddyfile" | grep -q 'reverse_proxy.*localhost:18790' || { echo 'FATAL: v5 upstream missing from claudeai.chat site' >&2; exit 1; }
imports="$(grep -Fxc "$import_line" "$caddyfile" || true)"
[[ "$imports" == 0 || "$imports" == 1 ]] || { echo 'FATAL: duplicate managed imports' >&2; exit 1; }
if [[ "$imports" == 1 ]]; then
  import_at="$(grep -Fn "$import_line" "$caddyfile" | cut -d: -f1)"
  (( import_at > site_start && import_at < site_end )) || { echo 'FATAL: managed import exists outside claudeai.chat site' >&2; exit 1; }
fi

# Prove behavior with this exact candidate on an isolated listener before
# touching the live config. In particular, an application 418 must stay 418.
cat >"$work/Caddyfile" <<EOF
{
	admin off
	auto_https off
}
http://127.0.0.1:18797 {
	@app_error path /app-error
	respond @app_error "application error" 418
	reverse_proxy 127.0.0.1:9
	import $candidate
}
EOF
caddy validate --config "$work/Caddyfile" --adapter caddyfile >/dev/null
caddy run --config "$work/Caddyfile" --adapter caddyfile >"$work/caddy.log" 2>&1 & probe_pid=$!
sleep 1
app_code="$(curl -sS -o "$work/app.body" -w '%{http_code}' http://127.0.0.1:18797/app-error)"
[[ "$app_code" == 418 && "$(cat "$work/app.body")" == 'application error' ]] || { echo 'FATAL: app status passthrough probe failed' >&2; exit 1; }
api_code="$(curl -sS -D "$work/api.headers" -o "$work/api.body" -w '%{http_code}' http://127.0.0.1:18797/api/probe)"
[[ "$api_code" == 503 ]] && jq -e '.error == "service_temporarily_unavailable" and .retry_after == 5' "$work/api.body" >/dev/null || { echo 'FATAL: API 503 probe failed' >&2; exit 1; }
grep -qi '^Retry-After: 5' "$work/api.headers" || { echo 'FATAL: API Retry-After missing' >&2; exit 1; }
html_code="$(curl -sS -o "$work/html.body" -w '%{http_code}' http://127.0.0.1:18797/)"
[[ "$html_code" == 503 ]] && grep -q '服务暂时不可用' "$work/html.body" || { echo 'FATAL: HTML 503 probe failed' >&2; exit 1; }
ws_code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' http://127.0.0.1:18797/ws)"
[[ "$ws_code" == 503 ]] || { echo 'FATAL: websocket failure must be non-200' >&2; exit 1; }
kill "$probe_pid" >/dev/null 2>&1 || true; wait "$probe_pid" 2>/dev/null || true; probe_pid=''
if [[ "$self_test" == 1 ]]; then
  echo '✓ Caddy alternate-port self-test passed; live config not modified'
  exit 0
fi

cp -a "$caddyfile" "$backup_caddy"
if [[ -f "$snippet" ]]; then cp -a "$snippet" "$backup_snippet"; had_snippet=1; fi
mutated=1
install -m 644 "$candidate" "$snippet.tmp"
mv "$snippet.tmp" "$snippet"
if [[ "$imports" == 0 ]]; then
  awk -v line="$import_line" -v site_end="$site_end" \
    'NR == site_end { print "\t" line } { print }' "$caddyfile" >"$caddyfile.tmp"
  chmod --reference="$caddyfile" "$caddyfile.tmp"
  chown --reference="$caddyfile" "$caddyfile.tmp"
  mv "$caddyfile.tmp" "$caddyfile"
fi
caddy validate --config "$caddyfile" --adapter caddyfile >/dev/null
systemctl reload caddy
body="$(curl -fsS --max-time 5 -H 'Host: claudeai.chat' http://127.0.0.1/healthz)"
jq -e '.ok == true and .channel == "v5"' <<<"$body" >/dev/null
mutated=0
echo '✓ narrow v5 upstream-error 503 fallback installed; application statuses remain untouched'
REMOTE
