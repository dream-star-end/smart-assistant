#!/usr/bin/env bash
# Install the dedicated same-site preview hostname route. The wildcard site is
# intentionally log-free because the first request carries a bootstrap ticket.
set -Eeuo pipefail

KL_HOST="${KL_HOST:-kl-mirror}"
CADDYFILE="/etc/caddy/Caddyfile"
SNIPPET="/etc/caddy/openclaude-v5-preview-host.caddy"
MODE="install"
case "${1:-}" in
  "") ;;
  --dry-run) MODE="dry-run" ;;
  --self-test) MODE="self-test" ;;
  --remove) MODE="remove" ;;
  *) echo "usage: $0 [--dry-run|--self-test|--remove]" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "usage: $0 [--dry-run|--self-test|--remove]" >&2; exit 2; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat >"$tmp" <<'CADDY'
# Managed by install-v5-preview-host.sh. Do not enable access logging here:
# the one-use bootstrap credential is carried in the initial query string.
http://*.claudeai.chat {
	@oc_preview_host expression `{http.request.host}.matches("^ocp-[0-9a-f]{32}\\.claudeai\\.chat$")`
	handle @oc_preview_host {
		# Deferred set semantics overwrite any same-named upstream response.
		header >X-OC-Preview-Route "v1"
		reverse_proxy localhost:18790 {
			header_up Host {host}
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto https
			stream_close_delay 5m
			lb_try_duration 15s
			lb_try_interval 250ms
		}
	}
	respond "preview host not found" 404
}
CADDY

if [[ "$MODE" == "dry-run" ]]; then
  echo "[dry-run] exact candidate self-test: valid Host marker/Host preservation/HTTP/WebSocket; invalid Host static 404"
  echo "[dry-run] transactional $MODE on $KL_HOST:$CADDYFILE with validate, reload, root health and rollback"
  exit 0
fi

remote_tmp="/tmp/openclaude-v5-preview-host.$$.caddy"
rsync -az "$tmp" "$KL_HOST:$remote_tmp"
ssh "$KL_HOST" bash -s -- "$CADDYFILE" "$SNIPPET" "$remote_tmp" "$MODE" <<'REMOTE'
set -Eeuo pipefail
caddyfile="$1"; snippet="$2"; candidate="$3"; mode="$4"
import_line="import $snippet"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
backup_caddy="$caddyfile.pre-v5-preview-host-$stamp"
backup_snippet="$snippet.pre-v5-preview-host-$stamp"
had_snippet=0; mutated=0; caddy_pid=''; upstream_pid=''

cleanup() {
  [[ -z "$caddy_pid" ]] || kill "$caddy_pid" >/dev/null 2>&1 || true
  [[ -z "$upstream_pid" ]] || kill "$upstream_pid" >/dev/null 2>&1 || true
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
    echo 'FATAL: preview-host install failed; previous Caddy config restored' >&2
  fi
  cleanup
  exit "$rc"
}
trap rollback ERR
trap cleanup EXIT

[[ -f "$caddyfile" ]] || { echo 'FATAL: Caddyfile missing' >&2; exit 1; }
[[ "$(grep -c '^http://claudeai\.chat[[:space:]]*{' "$caddyfile")" == 1 ]] || {
  echo 'FATAL: unexpected claudeai.chat site shape' >&2; exit 1;
}
grep -q 'reverse_proxy.*localhost:18790' "$caddyfile" || {
  echo 'FATAL: v5 upstream missing from claudeai.chat site' >&2; exit 1;
}
[[ "$(grep -c '^http://\*\.claudeai\.chat[[:space:]]*{' "$candidate")" == 1 ]] || {
  echo 'FATAL: invalid preview wildcard candidate' >&2; exit 1;
}
[[ "$(grep -Fc '@oc_preview_host expression `{http.request.host}.matches("^ocp-[0-9a-f]{32}\\.claudeai\\.chat$")`' "$candidate")" == 1 ]] || {
  echo 'FATAL: invalid preview host matcher' >&2; exit 1;
}
[[ "$(grep -c 'reverse_proxy localhost:18790' "$candidate")" == 1 ]] || {
  echo 'FATAL: invalid preview upstream' >&2; exit 1;
}
[[ "$(grep -c 'header >X-OC-Preview-Route "v1"' "$candidate")" == 1 ]] || {
  echo 'FATAL: preview route marker missing' >&2; exit 1;
}
if grep -Eq '^[[:space:]]*log([[:space:]]|\{)' "$candidate"; then
  echo 'FATAL: preview site must not enable access logging' >&2; exit 1
fi

# Exercise the exact candidate on isolated listeners before touching live
# config. A mock upstream deliberately forges the marker so Caddy must replace,
# not append, it. Its upgrade response also exposes the forwarded Host.
cat >"$work/upstream.mjs" <<'NODE'
import http from 'node:http'
const server = http.createServer((req, res) => {
  res.setHeader('X-OC-Preview-Route', 'upstream-forged')
  res.end(`preview-upstream:${req.headers.host ?? ''}`)
})
server.on('upgrade', (req, socket) => {
  socket.end(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    `X-Upstream-Host: ${req.headers.host ?? ''}\r\n\r\n`,
  )
})
server.listen(18798, '127.0.0.1')
NODE
node "$work/upstream.mjs" >"$work/upstream.log" 2>&1 & upstream_pid=$!
{
  printf '{\n\tadmin off\n\tauto_https off\n}\n'
  sed \
    -e 's#^http://\*\.claudeai\.chat {$#:18797 {#' \
    -e 's#reverse_proxy localhost:18790#reverse_proxy 127.0.0.1:18798#' \
    -e '/^:18797 {/a\	bind 127.0.0.1' \
    "$candidate"
} >"$work/Caddyfile"
caddy validate --config "$work/Caddyfile" --adapter caddyfile >/dev/null
caddy run --config "$work/Caddyfile" --adapter caddyfile >"$work/caddy.log" 2>&1 & caddy_pid=$!
sleep 1
valid="ocp-0123456789abcdef0123456789abcdef.claudeai.chat"
code="$(curl -sS -D "$work/valid.headers" -o "$work/valid.body" -w '%{http_code}' -H "Host: $valid" http://127.0.0.1:18797/probe)"
[[ "$code" == 200 && "$(cat "$work/valid.body")" == "preview-upstream:$valid" ]] || {
  echo 'FATAL: valid preview HTTP route/Host preservation failed' >&2; exit 1;
}
[[ "$(grep -ic '^X-OC-Preview-Route: v1' "$work/valid.headers")" == 1 ]] || {
  echo 'FATAL: preview route marker was not set exactly once' >&2; exit 1;
}
grep -qi '^X-OC-Preview-Route: upstream-forged' "$work/valid.headers" && {
  echo 'FATAL: upstream forged preview route marker survived' >&2; exit 1;
}
for invalid in ocp-short.claudeai.chat status.claudeai.chat; do
  code="$(curl -sS -D "$work/invalid.headers" -o "$work/invalid.body" -w '%{http_code}' -H "Host: $invalid" http://127.0.0.1:18797/)"
  [[ "$code" == 404 && "$(cat "$work/invalid.body")" == 'preview host not found' ]] || {
    echo 'FATAL: invalid wildcard host did not fail closed' >&2; exit 1;
  }
  ! grep -qi '^X-OC-Preview-Route:' "$work/invalid.headers" || {
    echo 'FATAL: invalid wildcard host received route marker' >&2; exit 1;
  }
done
python3 - "$valid" <<'PY'
import socket, sys
host = sys.argv[1]
s = socket.create_connection(('127.0.0.1', 18797), timeout=3)
s.sendall((f'GET /hmr HTTP/1.1\r\nHost: {host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n').encode())
data = b''
while len(data) < 8192:
    chunk = s.recv(8192)
    if not chunk: break
    data += chunk
text = data.decode('latin1')
if not text.startswith('HTTP/1.1 101 '): raise SystemExit('websocket status was not 101')
if f'X-Upstream-Host: {host}\r\n'.lower() not in text.lower():
    raise SystemExit('websocket Host was not preserved')
PY
kill "$caddy_pid" "$upstream_pid" >/dev/null 2>&1 || true
wait "$caddy_pid" 2>/dev/null || true; wait "$upstream_pid" 2>/dev/null || true
caddy_pid=''; upstream_pid=''
if [[ "$mode" == self-test ]]; then
  echo '✓ preview wildcard exact-candidate HTTP/WebSocket self-test passed; live config not modified'
  exit 0
fi

imports="$(grep -Fxc "$import_line" "$caddyfile" || true)"
[[ "$imports" == 0 || "$imports" == 1 ]] || { echo 'FATAL: duplicate preview imports' >&2; exit 1; }
if grep -q '^http://\*\.claudeai\.chat[[:space:]]*{' "$caddyfile"; then
  echo 'FATAL: unmanaged wildcard preview site already exists in Caddyfile' >&2; exit 1
fi
if [[ "$imports" == 1 && ! -f "$snippet" ]]; then
  echo 'FATAL: preview import exists but snippet is missing' >&2; exit 1
fi
if [[ -f "$snippet" ]] && ! grep -q '^# Managed by install-v5-preview-host\.sh' "$snippet"; then
  echo 'FATAL: refusing to replace unmanaged preview snippet' >&2; exit 1
fi

if [[ "$mode" == remove && "$imports" == 0 ]]; then
  [[ ! -e "$snippet" ]] || { echo 'FATAL: managed snippet exists without import' >&2; exit 1; }
  echo '✓ preview wildcard Caddy route already absent'
  exit 0
fi

cp -a "$caddyfile" "$backup_caddy"
if [[ -f "$snippet" ]]; then cp -a "$snippet" "$backup_snippet"; had_snippet=1; fi
mutated=1
if [[ "$mode" == remove ]]; then
  grep -Fvx "$import_line" "$caddyfile" >"$caddyfile.tmp"
  chmod --reference="$caddyfile" "$caddyfile.tmp"
  chown --reference="$caddyfile" "$caddyfile.tmp"
  mv "$caddyfile.tmp" "$caddyfile"
  rm -f "$snippet"
else
  install -m 644 "$candidate" "$snippet.tmp"
  mv "$snippet.tmp" "$snippet"
  if [[ "$imports" == 0 ]]; then
    printf '\n%s\n' "$import_line" >>"$caddyfile"
  fi
fi
caddy validate --config "$caddyfile" --adapter caddyfile >/dev/null
systemctl reload caddy
body="$(curl -fsS --max-time 5 -H 'Host: claudeai.chat' http://127.0.0.1/healthz)"
jq -e '.ok == true and .channel == "v5"' <<<"$body" >/dev/null
if [[ "$mode" == install ]]; then
  live_host="ocp-fedcba9876543210fedcba9876543210.claudeai.chat"
  curl -sS -D "$work/live.headers" -o /dev/null --max-time 5 -H "Host: $live_host" http://127.0.0.1/
  [[ "$(grep -ic '^X-OC-Preview-Route: v1' "$work/live.headers")" == 1 ]] || {
    echo 'FATAL: live origin preview marker missing' >&2; exit 1;
  }
  code="$(curl -sS -D "$work/live-invalid.headers" -o "$work/live-invalid.body" -w '%{http_code}' --max-time 5 -H 'Host: ocp-short.claudeai.chat' http://127.0.0.1/)"
  [[ "$code" == 404 ]] && ! grep -qi '^X-OC-Preview-Route:' "$work/live-invalid.headers" || {
    echo 'FATAL: live invalid preview host did not fail closed' >&2; exit 1;
  }
fi
mutated=0
printf '✓ preview wildcard Caddy route %s; caddy_backup=%s' "$mode" "$backup_caddy"
if [[ "$had_snippet" == 1 ]]; then printf ' snippet_backup=%s' "$backup_snippet"; fi
printf '\n'
REMOTE
