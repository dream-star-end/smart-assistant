#!/usr/bin/env bash
# OCV5-391: commercial egress blue-green slots (port of selfhost 6db5df24e). Runs ON the
# production host; deploy-v5.sh streams it over ssh (`bash -s -- <cmd> …`), like the baseline guard.
#
#   active                 one line "<unit> <pid> <cwd>" for the egress process that serves new
#                          connections (legacy unit, or the active slot); nothing if none.
#   install <release-dir>  install the slot templates + sysctl from that release (idempotent).
#   flip [predrain-sec]    serve from the current pointer on a fresh slot: start the idle slot,
#                          wait for its private health, close the old slot's listener, stop its
#                          service in the background (it drains only its own streams). The first
#                          flip away from the legacy unit waits up to predrain-sec (default 600)
#                          for its in-flight streams, then stops it (the last blocking drain).
#   legacy                 back to the legacy single unit (rollback/emergency): close the slots'
#                          listeners, stop the slots, enable --now the legacy unit.
# Exit 0 on success; every failure leaves the serving process as it was, if any.
set -Eeuo pipefail
LEGACY=openclaude-v5-egress.service
SOCK_TPL=openclaude-v5-egress@.socket
SVC_TPL=openclaude-v5-egress@.service
SYSCTL=99-openclaude-v5-egress.sysctl.conf
BIND="${OC_EGRESS_SLOTS_BIND:-172.31.0.1}"; PORT="${OC_EGRESS_SLOTS_PORT:-18892}"   # overridable for the hermetic test only
STATS="http://$BIND:$PORT/internal/v5/egress-stats"
unit() { printf 'openclaude-v5-egress@%s.%s' "$1" "$2"; }   # <A|B> <socket|service>
private_port() { [[ "$1" == A ]] && echo 18898 || echo 18899; }
state() { systemctl is-active "$1" 2>/dev/null || true; }
die() { echo "✗ egress-slots: $*" >&2; exit 1; }

cmd_active() {
  local best="" best_t=-1 u t pid
  for u in "$LEGACY" "$(unit A service)" "$(unit B service)"; do
    [[ "$(state "$u")" == active ]] || continue
    t="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$u" 2>/dev/null || echo 0)"
    (( ${t:-0} > best_t )) && { best="$u"; best_t="${t:-0}"; }
  done
  [[ -n "$best" ]] || return 0
  pid="$(systemctl show -p MainPID --value "$best" 2>/dev/null || true)"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  printf '%s %s %s\n' "$best" "$pid" "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
}

cmd_install() {
  local rel="${1:?release dir}" f changed=0
  for f in "$SOCK_TPL" "$SVC_TPL"; do
    [[ -f "$rel/deploy/v5/$f" ]] || die "release lacks $f: $rel"
    if ! cmp -s "$rel/deploy/v5/$f" "/etc/systemd/system/$f"; then
      install -m 0644 "$rel/deploy/v5/$f" "/etc/systemd/system/$f"; changed=1
    fi
  done
  [[ -f "$rel/deploy/v5/$SYSCTL" ]] || die "release lacks $SYSCTL"
  install -m 0644 "$rel/deploy/v5/$SYSCTL" "/etc/sysctl.d/$SYSCTL"
  [[ "$(sysctl -n net.ipv4.tcp_migrate_req 2>/dev/null || echo 0)" == 1 ]] \
    || sysctl -w net.ipv4.tcp_migrate_req=1 >/dev/null || die "sysctl tcp_migrate_req=1 failed"
  (( changed )) && systemctl daemon-reload
  echo "  egress-slots: templates installed (changed=$changed), tcp_migrate_req=1"
}

wait_slot_ready() { # <A|B>
  local s="$1" body="" i
  for i in $(seq 1 90); do
    body="$(curl -fsS --max-time 3 "http://127.0.0.1:$(private_port "$s")/internal/v5/egress-slot-health" 2>/dev/null || true)"
    jq -e --arg s "$s" '.ok==true and .slot==$s and .listenMode=="sd_activation"' >/dev/null 2>&1 <<<"$body" && return 0
    sleep 1
  done
  echo "  ✗ egress slot $s private health not ready in 90s: ${body:0:200}" >&2
  return 1
}

wait_shared_port() { timeout 90 bash -c "until (exec 3<>/dev/tcp/$BIND/$PORT) 2>/dev/null; do sleep 1; done"; }

# A reuseport member held only by systemd (no node process accepting) is a black hole: the
# kernel keeps hashing new connections to it. Fail closed on any ss error or unparsable output.
assert_no_orphan_listener() {
  local out rc=0 line n=0
  out="$(ss -Hltnp "sport = :$PORT" 2>/dev/null)" || rc=$?
  (( rc == 0 )) || die "ss failed rc=$rc on :$PORT"
  [[ -n "${out//[$' \t\r\n']/}" ]] || die "ss shows no listener on :$PORT"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line//[$' \t\r']/}" ]] && continue
    grep -q '^LISTEN' <<<"$line" || die "unexpected ss line: $line"
    grep -Eq 'users:\((\([^)]*\),)*\("node",pid=[0-9]+' <<<"$line" || { ss -ltnp "sport = :$PORT" >&2 || true; die "listener on :$PORT without a node owner"; }
    n=$((n + 1))
  done <<<"$out"
  (( n >= 1 )) || die "no parsable listener on :$PORT"
}

legacy_inflight() { curl -fsS --max-time 3 "$STATS" 2>/dev/null | jq -r '.inflight.total_current // empty' 2>/dev/null || true; }

cmd_flip() {
  local predrain="${1:-600}" cur="" target new_sock new_svc old_sock old_svc st left i
  [[ "$predrain" =~ ^[0-9]+$ ]] || die "predrain must be seconds"
  [[ -f "/etc/systemd/system/$SVC_TPL" && -f "/etc/systemd/system/$SOCK_TPL" ]] || die "slot templates not installed"
  [[ "$(sysctl -n net.ipv4.tcp_migrate_req 2>/dev/null || echo 0)" == 1 ]] || die "tcp_migrate_req is not 1"
  # Both slots active (an earlier flip was killed half way): stop the older one first.
  if [[ "$(state "$(unit A service)")" == active && "$(state "$(unit B service)")" == active ]]; then
    local ta tb older
    ta="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$(unit A service)")"
    tb="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$(unit B service)")"
    (( ${ta:-0} <= ${tb:-0} )) && older=A || older=B
    echo "  egress-slots: A and B both active, closing the older slot $older first" >&2
    systemctl stop --job-mode=ignore-dependencies "$(unit "$older" socket)"
    systemctl stop "$(unit "$older" service)"
  fi
  if [[ "$(state "$(unit A service)")" == active ]]; then cur=A; target=B
  elif [[ "$(state "$(unit B service)")" == active ]]; then cur=B; target=A
  else target=A; fi
  new_sock="$(unit "$target" socket)"; new_svc="$(unit "$target" service)"
  # One-time migration: the legacy unit holds a plain bind on the shared port. Wait (bounded) for
  # its in-flight streams to finish while it keeps serving, then stop it.
  st="$(state "$LEGACY")"
  if [[ "$st" == active || "$st" == activating || "$st" == deactivating ]]; then
    for (( i = 0; i < predrain; i += 5 )); do
      left="$(legacy_inflight)"
      [[ "$left" == 0 ]] && break
      echo "  egress-slots: legacy in-flight=${left:-?}, waiting (${i}s/${predrain}s)" >&2
      sleep 5
    done
    echo "  egress-slots: migrating legacy → slot $target (stopping $LEGACY, in-flight=${left:-?})" >&2
    systemctl stop "$LEGACY"
    systemctl disable "$LEGACY" >/dev/null 2>&1 || true
  fi
  st="$(state "$new_svc")"
  if [[ "$st" == deactivating ]]; then
    echo "  egress-slots: slot $target still draining, waiting for it to exit" >&2
    timeout 1900 bash -c "while [[ \"\$(systemctl is-active '$new_svc' 2>/dev/null)\" == deactivating ]]; do sleep 2; done" \
      || die "slot $target did not finish draining"
  fi
  echo "  egress-slots: starting slot $target${cur:+ (serving: $cur)}" >&2
  if ! systemctl start "$new_sock" || ! systemctl start "$new_svc" || ! wait_slot_ready "$target"; then
    tail -n 40 /var/log/openclaude-v5-egress.log >&2 || true
    systemctl stop --job-mode=ignore-dependencies "$new_sock" 2>/dev/null || true
    systemctl stop "$new_svc" 2>/dev/null || true
    die "slot $target failed to start; ${cur:+slot $cur still serving}"
  fi
  wait_shared_port || die "shared port not reachable after slot $target started"
  if [[ -n "$cur" ]]; then
    # Close the old listener first (ms), then stop the service without blocking (it drains).
    # Stopping both in one job would keep the old .socket until the drain ends: a black hole.
    old_sock="$(unit "$cur" socket)"; old_svc="$(unit "$cur" service)"
    systemctl stop --job-mode=ignore-dependencies "$old_sock"
    systemctl stop --no-block "$old_svc"
    systemctl disable "$old_sock" "$old_svc" >/dev/null 2>&1 || true
  fi
  systemctl enable "$new_sock" "$new_svc" >/dev/null 2>&1 || true
  wait_shared_port || die "shared port not reachable after closing slot ${cur:-none}"
  assert_no_orphan_listener
  echo "  ✓ egress-slots: serving from slot $target${cur:+, slot $cur draining in background}"
}

cmd_legacy() {
  local s
  for s in A B; do
    systemctl stop --job-mode=ignore-dependencies "$(unit "$s" socket)" 2>/dev/null || true
  done
  for s in A B; do
    systemctl stop "$(unit "$s" service)" 2>/dev/null || true
    systemctl disable "$(unit "$s" socket)" "$(unit "$s" service)" >/dev/null 2>&1 || true
  done
  systemctl enable --now "$LEGACY"
  systemctl restart "$LEGACY"
  wait_shared_port || die "legacy egress did not open :$PORT"
  echo "  ✓ egress-slots: legacy single unit serving"
}

case "${1:-}" in
  active) cmd_active ;;
  install) shift; cmd_install "$@" ;;
  flip) shift; cmd_flip "$@" ;;
  legacy) cmd_legacy ;;
  *) echo "usage: v5-egress-slots.sh active|install <rel>|flip [predrain-sec]|legacy" >&2; exit 2 ;;
esac
