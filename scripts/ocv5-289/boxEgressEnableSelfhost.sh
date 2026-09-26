#!/usr/bin/env bash
# OCV5-289 one-shot selfhost egress flag activation. Does not deploy or touch
# master/catalog/Box. Run only after an independent operator review.
set -Eeuo pipefail

expected=577ba459a2e42dbfe5aaf38e0c1d825ecf8363ad
canonical=/opt/openclaude/openclaude-v5-selfhost
live_link=/opt/openclaude/openclaude-v5-selfhost-live
env_file=/etc/openclaude/commercial-v5-selfhost.env
state_dir=/run/openclaude-v5-selfhost
backup="$state_dir/ocv5-289-egress-env-backup"
manual_marker="$state_dir/ocv5-289-egress-manual-recovery"
log() { printf 'OCV5-289 egress: %s\n' "$*"; }
fail() { log "FAIL $*" >&2; exit 1; }

[[ $(id -u) == 0 && $(hostname) == v3-dev-sg ]] || fail BOUNDARY
[[ ${OCV5_289_EGRESS_ENABLE_ACK:-} == 1 ]] || fail ACK_REQUIRED
[[ -z ${OC_V5_SELFHOST_LOCK_SELFTEST_SLEEP:-} ]] || fail LOCK_SELFTEST_FORBIDDEN
live=$(readlink -f -- "$live_link")
[[ "$live" == /opt/openclaude/openclaude-v5-selfhost-releases/rel-* ]] || fail LIVE_PATH
[[ $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sourceCommit)' "$live/.complete") == "$expected" ]] || fail LIVE_SHA
[[ $(git -C "$canonical" rev-parse HEAD) == "$expected" ]] || fail CANONICAL_SHA
for rel in scripts/deploy-v5-selfhost.sh scripts/lib/assert-flavor.sh \
  scripts/v5-runtime-release-lib.sh scripts/v5-selfhost-master-release-lib.sh; do
  cmp -s "$canonical/$rel" "$live/$rel" || fail "SOURCE_DRIFT $rel"
done
[[ -f "$env_file" && ! -L "$env_file" ]] || fail ENV_FILE
[[ ! -e "$backup" && ! -L "$backup" ]] || fail STALE_BACKUP
[[ ! -e "$manual_marker" && ! -L "$manual_marker" ]] || fail MANUAL_RECOVERY_PENDING

# The canonical path is required by the existing deploy script. The identical
# live copy is verified above; --status makes no mutation and defines the
# existing lock, health, and slot primitives without invoking --deploy.
unset OC_V5_SELFHOST_DEPLOY_LOCK_HELD OC_V5_SELFHOST_DEPLOY_LOCK
unset CUTOVER_UNIT_SNAP MASTER_RELEASES_ROOT MASTER_LIVE_LINK
unset OC_HOTCFG_PLATFORM_ROOT OC_HOTCFG_RELEASES_ROOT OC_HOTCFG_ENV_FILE OC_HOTCFG_HISTORY
export OC_V5_SELFHOST_DEPLOY_LOCK_WAIT=0
source "$canonical/scripts/deploy-v5-selfhost.sh" --status >/dev/null
acquire_selfhost_deploy_lock

[[ $(readlink -f -- "$live_link") == "$live" ]] || fail LIVE_MOVED
[[ $(systemctl is-active openclaude-v5-selfhost-egress@A.service) == active ]] || fail A_NOT_ACTIVE
[[ $(systemctl is-active openclaude-v5-selfhost-egress@A.socket) == active ]] || fail A_SOCKET_NOT_ACTIVE
[[ $(systemctl is-active openclaude-v5-selfhost-egress@B.service 2>/dev/null || :) == inactive ]] || fail B_NOT_INACTIVE
[[ $(systemctl is-active openclaude-v5-selfhost-egress@B.socket 2>/dev/null || :) == inactive ]] || fail B_SOCKET_NOT_INACTIVE
[[ $(systemctl is-active openclaude-v5-selfhost-egress.service 2>/dev/null || :) == inactive ]] || fail LEGACY_ACTIVE
[[ -z $(pgrep -af '[g]rok-native' || :) ]] || fail GROK_IN_FLIGHT
[[ -z $(pgrep -af '[d]eploy-v5-selfhost.sh --deploy|[d]eploy-v5-selfhost.sh --cutover' || :) ]] || fail DEPLOY_IN_FLIGHT
old_pid=$(systemctl show -p MainPID --value openclaude-v5-selfhost-egress@A.service)
master_pid=$(systemctl show -p MainPID --value openclaude-v5-selfhost.service)
[[ "$old_pid" =~ ^[1-9][0-9]+$ && $(readlink -f "/proc/$old_pid/cwd") == "$live" ]] || fail A_SOURCE
[[ "$master_pid" =~ ^[1-9][0-9]+$ ]] || fail MASTER_NOT_RUNNING
[[ $(curl -fsS --max-time 5 http://127.0.0.1:18898/internal/v5/egress-slot-health | jq -r '.ok,.slot,.listenMode' | paste -sd, -) == true,A,sd_activation ]] || fail A_HEALTH
[[ $(curl -fsS --max-time 5 http://172.31.0.1:18892/internal/v5/egress-health | jq -r '.slot,.listenMode' | paste -sd, -) == A,sd_activation ]] || fail SHARED_HEALTH

# Keep the exact previous bytes for rollback; reject a pre-existing backup
# rather than overwriting an interrupted operation's only recovery evidence.
python3 - "$env_file" "$backup" <<'PY'
import os, stat, sys
src, dst = sys.argv[1:]
st = os.lstat(src)
if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
    raise SystemExit('ENV_FILE_UNSAFE')
fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
try:
    data = os.read(fd, st.st_size + 1)
    if len(data) != st.st_size or os.fstat(fd).st_ino != st.st_ino:
        raise SystemExit('ENV_FILE_CHANGED')
finally: os.close(fd)
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
try:
    if os.write(fd, data) != len(data): raise SystemExit('BACKUP_SHORT_WRITE')
    os.fsync(fd)
finally: os.close(fd)
dirfd = os.open(os.path.dirname(dst), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
try: os.fsync(dirfd)
finally: os.close(dirfd)
PY
phase=backed_up
restore_env() {
  python3 - "$env_file" "$backup" <<'PY'
import os, stat, sys
dst, src = sys.argv[1:]
old = os.lstat(dst)
bak = os.lstat(src)
if not stat.S_ISREG(old.st_mode) or not stat.S_ISREG(bak.st_mode) or bak.st_uid != 0 or bak.st_mode & 0o077:
    raise SystemExit('ROLLBACK_ENV_UNSAFE')
with open(src, 'rb') as f: data=f.read()
tmp = dst + '.ocv5-289-restore-' + str(os.getpid())
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
try:
    if os.write(fd, data) != len(data): raise SystemExit('RESTORE_SHORT_WRITE')
    os.fchown(fd, old.st_uid, old.st_gid)
    os.fchmod(fd, stat.S_IMODE(old.st_mode)); os.fsync(fd)
finally: os.close(fd)
os.replace(tmp, dst)
dirfd = os.open(os.path.dirname(dst), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
try: os.fsync(dirfd)
finally: os.close(dirfd)
PY
}
cleanup_candidate() {
  # Requires=socket + After=socket: stop socket independently FIRST, never
  # include socket and service in the same systemd stop transaction.
  systemctl stop --job-mode=ignore-dependencies openclaude-v5-selfhost-egress@B.socket || return 1
  systemctl stop --no-block openclaude-v5-selfhost-egress@B.service || return 1
  systemctl disable openclaude-v5-selfhost-egress@B.socket openclaude-v5-selfhost-egress@B.service >/dev/null || return 1
}
mark_manual_recovery() {
  python3 - "$manual_marker" "$phase" "$expected" <<'PY'
import os, sys, time
path, phase, source = sys.argv[1:]
data = f'phase={phase} utc={time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())} live={source} catalog=staged\n'.encode()
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
try:
    if os.write(fd, data) != len(data): raise SystemExit('MARKER_SHORT_WRITE')
    os.fsync(fd)
finally: os.close(fd)
dirfd = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
try: os.fsync(dirfd)
finally: os.close(dirfd)
PY
  log "MANUAL_RECOVERY_REQUIRED marker=$manual_marker; catalog must remain staged" >&2
}
check_b_ready() {
  [[ $(systemctl is-active openclaude-v5-selfhost-egress@B.socket) == active \
     && $(systemctl is-active openclaude-v5-selfhost-egress@B.service) == active \
     && $(systemctl is-enabled openclaude-v5-selfhost-egress@B.socket) == enabled \
     && $(systemctl is-enabled openclaude-v5-selfhost-egress@B.service) == enabled ]] || return 1
  local pid
  pid=$(systemctl show -p MainPID --value openclaude-v5-selfhost-egress@B.service)
  [[ "$pid" == "$new_pid" && $(readlink -f "/proc/$pid/cwd") == "$live" ]] || return 1
  python3 - "$pid" <<'PY' || return 1
import sys
env = open('/proc/' + sys.argv[1] + '/environ', 'rb').read().split(b'\0')
assert b'OC_BOX_MODEL_API=1' in env and b'OC_BOX_TOOL_BRIDGE=1' in env, 'B_FLAGS_OFF'
PY
  [[ $(curl -fsS --max-time 5 http://127.0.0.1:18899/internal/v5/egress-slot-health \
      | jq -r '.ok,.slot,.listenMode' | paste -sd, -) == true,B,sd_activation ]] || return 1
}
check_b_serving() {
  check_b_ready || return 1
  [[ $(curl -fsS --max-time 5 http://172.31.0.1:18892/internal/v5/egress-health \
      | jq -r '.slot,.listenMode' | paste -sd, -) == B,sd_activation ]] || return 1
  [[ $(ss -Hltnp 'sport = :18892' | awk '$1=="LISTEN" {n++} END {print n+0}') == 1 ]] || return 1
}
on_exit() {
  rc=$?
  trap - EXIT
  if (( rc != 0 )); then
    if [[ ${phase:-} == backed_up || ${phase:-} == env_changed || ${phase:-} == candidate ]]; then
      local a_state a_rc=0
      a_state=$(systemctl is-active openclaude-v5-selfhost-egress@A.socket 2>/dev/null) || a_rc=$?
      if (( a_rc == 0 )) && [[ "$a_state" == active ]]; then
        cleanup_candidate || { log 'candidate cleanup failed'; mark_manual_recovery || :; }
        restore_env || { log 'env restore failed'; mark_manual_recovery || :; }
        [[ $(curl -fsS --max-time 5 http://172.31.0.1:18892/internal/v5/egress-health \
          | jq -r '.slot,.listenMode' | paste -sd, -) == A,sd_activation ]] \
          || { log 'A health proof failed'; mark_manual_recovery || :; }
      else
        log "A socket state unproven (rc=$a_rc state=${a_state:-?}); preserve both slots, no rollback" >&2
        mark_manual_recovery || :
      fi
    fi
    if [[ ${phase:-} == old_listener_closed ]]; then
      # Never restart A or restore the flags while B is already taking traffic.
      # Complete idempotent local state if possible; on any uncertainty leave
      # a durable fail-closed marker instead of calling the generic flip.
      if check_b_ready; then
        systemctl stop --no-block openclaude-v5-selfhost-egress@A.service || :
        systemctl disable openclaude-v5-selfhost-egress@A.socket openclaude-v5-selfhost-egress@A.service >/dev/null || :
        check_b_serving || log 'B serving proof failed' >&2
      else
        log 'B readiness unproven; preserve A service' >&2
      fi
      mark_manual_recovery || :
    fi
  fi
  cleanup_selfhost_deploy || :
  exit "$rc"
}
trap on_exit EXIT

python3 - "$env_file" <<'PY'
import os, stat, sys
path = sys.argv[1]
st = os.lstat(path)
with open(path, 'rb') as f: data = f.read()
lines = data.decode('utf-8').splitlines(keepends=True)
keys = ('OC_BOX_MODEL_API', 'OC_BOX_TOOL_BRIDGE')
for key in keys:
    matches = [i for i, line in enumerate(lines) if line.split('=', 1)[0].strip() == key]
    if len(matches) > 1: raise SystemExit('DUPLICATE_FLAG')
    if matches: lines[matches[0]] = key + '=1\n'
    else:
        if lines and not lines[-1].endswith('\n'): lines[-1] += '\n'
        lines.append(key + '=1\n')
tmp = path + '.ocv5-289-new-' + str(os.getpid())
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
try:
    out = ''.join(lines).encode('utf-8')
    if os.write(fd, out) != len(out): raise SystemExit('SHORT_WRITE')
    os.fchown(fd, st.st_uid, st.st_gid); os.fchmod(fd, stat.S_IMODE(st.st_mode)); os.fsync(fd)
finally: os.close(fd)
os.replace(tmp, path)
dirfd = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
try: os.fsync(dirfd)
finally: os.close(dirfd)
PY
phase=env_changed

systemctl start openclaude-v5-selfhost-egress@B.socket
phase=candidate
systemctl start openclaude-v5-selfhost-egress@B.service
egress_wait_slot_ready B
new_pid=$(systemctl show -p MainPID --value openclaude-v5-selfhost-egress@B.service)
[[ "$new_pid" =~ ^[1-9][0-9]+$ && $(readlink -f "/proc/$new_pid/cwd") == "$live" ]] || fail B_SOURCE
python3 - "$new_pid" <<'PY'
import sys
env = open('/proc/' + sys.argv[1] + '/environ', 'rb').read().split(b'\0')
assert b'OC_BOX_MODEL_API=1' in env and b'OC_BOX_TOOL_BRIDGE=1' in env, 'B_FLAGS_OFF'
PY
systemctl enable openclaude-v5-selfhost-egress@B.socket openclaude-v5-selfhost-egress@B.service >/dev/null
[[ $(systemctl is-enabled openclaude-v5-selfhost-egress@B.socket) == enabled \
   && $(systemctl is-enabled openclaude-v5-selfhost-egress@B.service) == enabled ]] || fail B_ENABLE

# Listener-first cutover. Once A's listener is closed, automatic rollback is
# intentionally forbidden: B is already known healthy, and the catalog is
# still staged. No ambiguous second flip or paid call is attempted here.
systemctl stop --job-mode=ignore-dependencies openclaude-v5-selfhost-egress@A.socket
phase=old_listener_closed
systemctl stop --no-block openclaude-v5-selfhost-egress@A.service
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if [[ $(ss -Hltnp 'sport = :18892' | awk '$1=="LISTEN" {n++} END {print n+0}') == 1 ]]; then break; fi
  sleep 1
done
egress_assert_no_orphan_listener
[[ $(ss -Hltnp 'sport = :18892' | awk '$1=="LISTEN" {n++} END {print n+0}') == 1 ]] || fail LISTENER_COUNT
[[ $(curl -fsS --max-time 5 http://172.31.0.1:18892/internal/v5/egress-health | jq -r '.slot,.listenMode' | paste -sd, -) == B,sd_activation ]] || fail NEW_SHARED_HEALTH
systemctl disable openclaude-v5-selfhost-egress@A.socket openclaude-v5-selfhost-egress@A.service >/dev/null
[[ $(systemctl show -p MainPID --value openclaude-v5-selfhost.service) == "$master_pid" ]] || fail MASTER_CHANGED
check_b_serving || fail B_NOT_SERVING
phase=complete
log "PASS B=$new_pid oldA=$old_pid live=$expected flags=1 catalog_untouched=true"
