#!/usr/bin/env bash
# Behavioral checks for the egress/watch logrotate snippet.
# Force rotation is allowed only inside a /tmp fixture, and only through
# the installer --fixture-rotate guard. Real logs are stat'd, never truncated.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL="$SCRIPT_DIR/v5-selfhost-logrotate-egress-watch-install.sh"
TEMPLATE="$REPO_ROOT/deploy/v5-selfhost/logrotate.d/openclaude-v5-selfhost-egress-watch"
PATH_EGRESS="/var/log/openclaude-v5-selfhost-egress.log"
PATH_WATCH="/var/log/openclaude-v5-selfhost-watch.log"
PATH_MASTER="/var/log/openclaude-v5-selfhost.log"
PATH_CLOUD="/var/log/cloudflared-v5-selfhost.log"
DEST_NAME="openclaude-v5-selfhost-egress-watch"
LIVE_DEST="/etc/logrotate.d/$DEST_NAME"

if [[ $# -ne 0 ]]; then
  echo "this test takes no arguments" >&2
  exit 2
fi
for envname in OC_LOGROTATE_LOG OC_LOGROTATE_STATE LOGROTATE_CONFIG; do
  if [[ -n "${!envname:-}" ]]; then
    echo "refusing env $envname" >&2
    exit 2
  fi
done

pass=0
fail=0
ok() { printf 'PASS %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL %s\n' "$1" >&2; fail=$((fail + 1)); }
behavior() { printf 'BEHAVIOR %s=%s\n' "$1" "$2"; }

echo "RISK maxsize is checked when logrotate runs (timer daily AccuracySec=1h, plus cron.daily), not a realtime 200M cap."
echo "RISK copytruncate keeps the writer inode but can drop bytes written between copy and truncate. Not a lossless audit log."
echo "RISK delaycompress leaves the newest archive uncompressed. rotate 14 then deletes older archives."
echo "RISK this run does not install the host snippet, does not use logrotate -f on real logs, and does not restart services."

T="$(mktemp -d /tmp/ocv5-400-logrotate.XXXXXX)"
cleanup() {
  [[ -n "${writer:-}" ]] && kill "$writer" 2>/dev/null || true
  [[ -n "${cwriter:-}" ]] && kill "$cwriter" 2>/dev/null || true
  [[ -n "${pause_pid:-}" ]] && kill "$pause_pid" 2>/dev/null || true
  rm -rf -- "$T"
}
trap cleanup EXIT

snap_live() {
  python3 - "$1" <<'PY'
import hashlib, os, subprocess, sys
out = sys.argv[1]
grow = [
    "/var/log/openclaude-v5-selfhost-egress.log",
    "/var/log/openclaude-v5-selfhost-watch.log",
    "/var/log/openclaude-v5-selfhost.log",
    "/var/log/cloudflared-v5-selfhost.log",
]
frozen = [
    "/etc/logrotate.d/openclaude-v5-selfhost",
    "/var/lib/logrotate/status",
    "/opt/openclaude/v5-selfhost-watch/watch-disarmed",
    "/opt/openclaude/openclaude-v5-selfhost-releases/.manual-recovery-required",
]
lines = []
for path in grow:
    st = os.stat(path)
    lines.append(f"GROW {path} {st.st_ino} {st.st_size}")
for path in frozen:
    if not os.path.exists(path):
        lines.append(f"ABSENT {path}")
        continue
    st = os.stat(path)
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    lines.append(f"FROZEN {path} {st.st_ino} {st.st_size} {digest}")
siblings = []
for base in grow:
    directory = os.path.dirname(base)
    prefix = os.path.basename(base)
    for name in sorted(os.listdir(directory)):
        if name == prefix:
            continue
        if name.startswith(prefix + "."):
            siblings.append(os.path.join(directory, name))
for path in siblings:
    st = os.stat(path)
    lines.append(f"SIDE {path} {st.st_ino} {st.st_size}")
units = [
    "openclaude-v5-selfhost.service",
    "openclaude-v5-selfhost-egress.service",
    "openclaude-v5-selfhost-egress@A.service",
    "openclaude-v5-selfhost-egress@B.service",
    "openclaude-v5-selfhost-watch.service",
    "openclaude-v5-selfhost-watch.timer",
]
for unit in units:
    show = subprocess.check_output(
        ["systemctl", "show", "-p", "Id", "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", unit],
        text=True,
    )
    blob = " ".join(line.strip() for line in show.splitlines() if line.strip())
    lines.append(f"UNIT {blob}")
if os.path.exists("/etc/logrotate.d/openclaude-v5-selfhost-egress-watch"):
    lines.append("HOST_SNIPPET present")
else:
    lines.append("HOST_SNIPPET absent")
open(out, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
}

run_rc() {
  local dest="$1"
  shift
  set +e
  "$@" >"$dest.out" 2>"$dest.err"
  local rc=$?
  set -e
  printf '%s\n' "$rc" >"$dest.rc"
}

snap_live "$T/live.before"

run_rc "$T/check" "$INSTALL" --check-host-readonly
check_rc="$(cat "$T/check.rc")"
if [[ "$check_rc" == "0" ]] \
  && grep -qx 'DUPLICATE_EGRESS=0' "$T/check.out" \
  && grep -qx 'DUPLICATE_WATCH=0' "$T/check.out" \
  && grep -qx 'LIVE_DRY_RUN=0' "$T/check.out"; then
  ok "host readonly duplicate count is zero and logrotate -d exits 0"
  behavior host_duplicate_egress 0
  behavior host_duplicate_watch 0
  behavior live_dry_run 0
else
  bad "host readonly check rc=$check_rc"
  cat "$T/check.out" "$T/check.err" >&2 || true
fi

run_rc "$T/rootslash" "$INSTALL" --root / --template "$TEMPLATE"
if [[ "$(cat "$T/rootslash.rc")" == "2" ]] && grep -q 'REFUSE_HOST_ROOT' "$T/rootslash.err"; then
  ok "installer refuses --root /"
  behavior host_root_rejected 1
else
  bad "installer did not refuse --root /"
fi

bad_root="$(mktemp -d "$T/bad.XXXXXX")"
mkdir -p -- "$bad_root/etc/logrotate.d"
cat >"$bad_root/glob.conf" <<'EOF'
/var/log/openclaude-v5-selfhost-*.log {
    su root adm
    daily
    maxsize 200M
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
run_rc "$T/glob" "$INSTALL" --root "$bad_root" --template "$bad_root/glob.conf"
if [[ "$(cat "$T/glob.rc")" != "0" ]] && [[ ! -e "$bad_root/etc/logrotate.d/$DEST_NAME" ]]; then
  ok "glob template rejected and destination absent"
  behavior glob_rejected 1
else
  bad "glob template was installed"
fi

cp -a -- "$TEMPLATE" "$bad_root/post.conf"
cat >>"$bad_root/post.conf" <<'EOF'
    postrotate
        true
    endscript
EOF
run_rc "$T/post" "$INSTALL" --root "$bad_root" --template "$bad_root/post.conf"
if [[ "$(cat "$T/post.rc")" != "0" ]] && [[ ! -e "$bad_root/etc/logrotate.d/$DEST_NAME" ]]; then
  ok "postrotate template rejected"
  behavior postrotate_rejected 1
else
  bad "postrotate template was installed"
fi

cp -a -- "$TEMPLATE" "$bad_root/extra.conf"
sed -i "1a $PATH_MASTER" "$bad_root/extra.conf"
run_rc "$T/extra" "$INSTALL" --root "$bad_root" --template "$bad_root/extra.conf"
if [[ "$(cat "$T/extra.rc")" != "0" ]] && [[ ! -e "$bad_root/etc/logrotate.d/$DEST_NAME" ]]; then
  ok "third path rejected"
  behavior extra_path_rejected 1
else
  bad "third path was installed"
fi

dup_root="$(mktemp -d "$T/dup.XXXXXX")"
mkdir -p -- "$dup_root/etc/logrotate.d"
printf '%s {\n    missingok\n}\n' "$PATH_EGRESS" >"$dup_root/etc/logrotate.d/other"
run_rc "$T/dup" "$INSTALL" --root "$dup_root" --template "$TEMPLATE"
if [[ "$(cat "$T/dup.rc")" == "3" ]] \
  && grep -q '^DUPLICATE$' "$T/dup.err" \
  && [[ ! -e "$dup_root/etc/logrotate.d/$DEST_NAME" ]]; then
  ok "duplicate path rejected"
  behavior duplicate_rejected 1
else
  bad "duplicate path was not rejected rc=$(cat "$T/dup.rc")"
  cat "$T/dup.err" >&2 || true
fi

qroot="$(mktemp -d "$T/qdup.XXXXXX")"
mkdir -p -- "$qroot/etc/logrotate.d"
qfile="$qroot/etc/logrotate.d/existing"
cat >"$qfile" <<'EOF'
"/var/log/openclaude-v5-selfhost-egress.log" {
    su root adm
    missingok
}
EOF
printf 'include %s\n' "$qroot/etc/logrotate.d" >"$qroot/etc/logrotate.conf"
qsha="$(sha256sum "$qfile" | awk 'NR==1 {print $1}')"
run_rc "$T/qdup" "$INSTALL" --root "$qroot" --template "$TEMPLATE"
if [[ "$(cat "$T/qdup.rc")" == "3" ]] \
  && grep -qx '^DUPLICATE$' "$T/qdup.err" \
  && [[ ! -e "$qroot/etc/logrotate.d/$DEST_NAME" ]] \
  && [[ -z "$(find "$qroot" -name '*~' -print)" ]] \
  && [[ "$(sha256sum "$qfile" | awk 'NR==1 {print $1}')" == "$qsha" ]]; then
  ok "quoted duplicate rejected and the existing rule was not replaced"
  behavior quoted_duplicate_rejected 1
else
  bad "quoted duplicate was installed rc=$(cat "$T/qdup.rc")"
  cat "$T/qdup.out" "$T/qdup.err" >&2 || true
fi

collision_root="$(mktemp -d "$T/collision_dup.XXXXXX")"
mkdir -p -- "$collision_root/etc/logrotate.d"
collision_file="$collision_root/etc/logrotate.d/00-existing.conf"
cat >"$collision_file" <<'EOF'
"/var/log/openclaude-v5-selfhost-egress.log" {
    su root adm
    missingok
}
EOF
printf 'include %s\n' "$collision_root/etc/logrotate.d" >"$collision_root/etc/logrotate.conf"
collision_sha="$(sha256sum "$collision_file" | awk 'NR==1 {print $1}')"
run_rc "$T/collision_dup" "$INSTALL" --root "$collision_root" --template "$TEMPLATE"
if [[ "$(cat "$T/collision_dup.rc")" == "3" ]] \
  && grep -qx '^DUPLICATE$' "$T/collision_dup.err" \
  && [[ ! -e "$collision_root/etc/logrotate.d/$DEST_NAME" ]] \
  && [[ -z "$(find "$collision_root" -name '*~' -print)" ]] \
  && [[ "$(sha256sum "$collision_file" | awk 'NR==1 {print $1}')" == "$collision_sha" ]]; then
  ok "same-name 00-existing.conf quoted duplicate rejected and the existing rule was not replaced"
  behavior same_name_duplicate_rejected 1
else
  bad "same-name 00-existing.conf quoted duplicate was installed rc=$(cat "$T/collision_dup.rc")"
  cat "$T/collision_dup.out" "$T/collision_dup.err" >&2 || true
fi

groot="$(mktemp -d "$T/gdup.XXXXXX")"
mkdir -p -- "$groot/etc/logrotate.d"
gfile="$groot/etc/logrotate.d/existing"
cat >"$gfile" <<'EOF'
/var/log/openclaude-v5-selfhost-*.log {
    su root adm
    missingok
}
EOF
gsha="$(sha256sum "$gfile" | awk 'NR==1 {print $1}')"
run_rc "$T/gdup" "$INSTALL" --root "$groot" --template "$TEMPLATE"
if [[ "$(cat "$T/gdup.rc")" == "3" ]] \
  && grep -qx '^DUPLICATE$' "$T/gdup.err" \
  && [[ ! -e "$groot/etc/logrotate.d/$DEST_NAME" ]] \
  && [[ -z "$(find "$groot" -name '*~' -print)" ]] \
  && [[ "$(sha256sum "$gfile" | awk 'NR==1 {print $1}')" == "$gsha" ]]; then
  ok "overlapping glob rejected and the existing rule was not replaced"
  behavior glob_duplicate_rejected 1
else
  bad "glob duplicate was installed rc=$(cat "$T/gdup.rc")"
  cat "$T/gdup.out" "$T/gdup.err" >&2 || true
fi

sroot="$(mktemp -d "$T/slink.XXXXXX")"
elsewhere="$(mktemp -d "$T/elsewhere.XXXXXX")"
ln -s "$elsewhere" "$sroot/etc"
run_rc "$T/slink" "$INSTALL" --root "$sroot" --template "$TEMPLATE"
if [[ "$(cat "$T/slink.rc")" == "2" ]] \
  && grep -q 'REFUSE_ESCAPE' "$T/slink.err" \
  && [[ ! -e "$elsewhere/logrotate.d" ]] \
  && [[ ! -d "$sroot/var" ]] \
  && [[ -z "$(find "$sroot" "$elsewhere" -name '*~' -print)" ]]; then
  ok "symlink parent was refused before any directory was created outside"
  behavior symlink_parent_no_write 1
else
  bad "symlink parent wrote outside or was not refused rc=$(cat "$T/slink.rc")"
  cat "$T/slink.out" "$T/slink.err" >&2 || true
  ls -ld "$elsewhere" "$elsewhere/logrotate.d" "$sroot/etc" >&2 || true
fi

ok_root="$(mktemp -d "$T/ok.XXXXXX")"
run_rc "$T/inst" "$INSTALL" --root "$ok_root" --template "$TEMPLATE"
inst_dest="$ok_root/etc/logrotate.d/$DEST_NAME"
tmpl_sha="$(sha256sum "$TEMPLATE" | awk 'NR==1 {print $1}')"
inst_sha="$(sha256sum "$inst_dest" 2>/dev/null | awk 'NR==1 {print $1}')"
if [[ "$(cat "$T/inst.rc")" == "0" ]] \
  && [[ -f "$inst_dest" && ! -L "$inst_dest" ]] \
  && [[ "$inst_sha" == "$tmpl_sha" ]] \
  && grep -qx "SHA_AFTER=$tmpl_sha" "$T/inst.out" \
  && grep -qx 'SHA_BEFORE=none' "$T/inst.out" \
  && grep -qx 'BACKUP=none' "$T/inst.out" \
  && [[ -z "$(find "$ok_root/etc/logrotate.d" -name '*~' -print)" ]]; then
  ok "atomic install wrote only the final file with the template bytes"
  behavior atomic_install 1
else
  bad "atomic install mismatch"
  cat "$T/inst.out" "$T/inst.err" >&2 || true
fi

pause_root="$(mktemp -d "$T/pause.XXXXXX")"
pause_file="$T/pause.path"
OC_LOGROTATE_PAUSE_FILE="$pause_file" "$INSTALL" --root "$pause_root" --template "$TEMPLATE" >"$T/pause.out" 2>"$T/pause.err" &
pause_pid=$!
seen=0
for _ in $(seq 1 100); do
  [[ -s "$pause_file" ]] && { seen=1; break; }
  sleep 0.05
done
if [[ "$seen" != "1" ]]; then
  bad "installer did not expose the temp file"
  touch "$pause_file.go"
  wait "$pause_pid" || true
else
  tmp_path="$(cat "$pause_file")"
  base="$(basename -- "$tmp_path")"
  parent_conf="$T/pause.parent"
  printf 'su root adm\ninclude %s\n' "$(dirname -- "$tmp_path")" >"$parent_conf"
  include_out="$T/pause.include"
  logrotate -d -s "$T/pause.state" "$parent_conf" >"$include_out" 2>&1 || true
  if [[ "$base" == *~ ]] \
    && [[ "$(basename -- "$(dirname -- "$tmp_path")")" == "logrotate.d" ]] \
    && ! grep -F "reading config file $base" "$include_out" >/dev/null \
    && ! grep -F "reading config file $tmp_path" "$include_out" >/dev/null; then
    ok "same-directory temp ends with ~ and include skips it"
    behavior tilde_temp_skipped 1
  else
    bad "temp file was visible to include or not a tilde name: $tmp_path"
    cat "$include_out" >&2 || true
  fi
  touch "$pause_file.go"
  set +e
  wait "$pause_pid"
  pause_rc=$?
  set -e
  final="$pause_root/etc/logrotate.d/$DEST_NAME"
  printf 'include %s\n' "$(dirname -- "$final")" >"$T/pause.after.conf"
  logrotate -d -s "$T/pause.after.state" "$T/pause.after.conf" >"$T/pause.after.out" 2>&1 || true
  if [[ "$pause_rc" == "0" && ! -e "$tmp_path" && -f "$final" ]] \
    && grep -E "reading config file (.*/)?${DEST_NAME}\$" "$T/pause.after.out" >/dev/null; then
    ok "rename publishes the final name and removes the temp file"
    behavior atomic_rename_published 1
  else
    bad "rename did not publish the snippet rc=$pause_rc tmp_exists=$([[ -e $tmp_path ]] && echo yes || echo no) final=$([[ -f $final ]] && echo yes || echo no)"
    cat "$T/pause.after.out" >&2 || true
  fi
fi

run_rc "$T/inst2" "$INSTALL" --root "$ok_root" --template "$TEMPLATE"
backup_line="$(grep '^BACKUP=' "$T/inst2.out" || true)"
backup_path="${backup_line#BACKUP=}"
if [[ "$(cat "$T/inst2.rc")" == "0" ]] \
  && [[ "$backup_path" == "$ok_root/var/backups/openclaude-v5-selfhost-logrotate/"* ]] \
  && [[ -f "$backup_path" ]] \
  && [[ "$(sha256sum "$backup_path" | awk 'NR==1 {print $1}')" == "$tmpl_sha" ]] \
  && [[ "$(find "$ok_root/etc/logrotate.d" -type f | wc -l)" == "1" ]]; then
  ok "second install backs up outside logrotate.d"
  behavior backup_outside_include 1
else
  bad "second install backup was not outside the include directory"
  cat "$T/inst2.out" "$T/inst2.err" >&2 || true
fi

rewrite() {
  python3 - "$TEMPLATE" "$1" "$2" "$3" <<'PY'
import sys
src, dest, egress, watch = sys.argv[1:]
text = open(src, encoding="utf-8").read()
a = "/var/log/openclaude-v5-selfhost-egress.log"
b = "/var/log/openclaude-v5-selfhost-watch.log"
if text.count(a) != 1 or text.count(b) != 1:
    raise SystemExit("template path count")
text = "create\n" + text.replace(a, egress).replace(b, watch)
forbidden = (
    a, b,
    "/var/log/openclaude-v5-selfhost.log",
    "/var/log/cloudflared-v5-selfhost.log",
    "/etc/logrotate.d",
    "/var/lib/logrotate/status",
)
for item in forbidden:
    if item in text:
        raise SystemExit("rewrite still has " + item)
open(dest, "w", encoding="utf-8").write(text)
PY
}

rot="$T/rot"
mkdir -p -- "$rot"
egress="$rot/egress.log"
watch="$rot/watch.log"
decoy_m="$rot/openclaude-v5-selfhost.log"
decoy_c="$rot/cloudflared-v5-selfhost.log"
echo "decoy-master" >"$decoy_m"
echo "decoy-cloud" >"$decoy_c"
echo "W0" >"$watch"
watch_ino="$(stat -c %i "$watch")"
decoy_sha_before="$(sha256sum "$decoy_m" "$decoy_c" | sha256sum | awk 'NR==1 {print $1}')"
rewrite "$rot/rot.conf" "$egress" "$watch"
chmod 644 "$rot/rot.conf"

python3 - "$egress" "$rot/ready" "$rot/go" "$rot/release" <<'PY' &
import os, sys, time
path, ready, go, release = sys.argv[1:]
fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
os.write(fd, b"BEFORE\n")
os.fsync(fd)
open(ready, "w", encoding="utf-8").write(str(os.fstat(fd).st_ino) + "\n")
while not os.path.exists(go):
    time.sleep(0.02)
os.write(fd, b"AFTER\n")
os.fsync(fd)
open(ready, "a", encoding="utf-8").write(str(os.fstat(fd).st_ino) + "\n")
while not os.path.exists(release):
    time.sleep(0.02)
os.close(fd)
PY
writer=$!
for _ in $(seq 1 100); do
  [[ -s "$rot/ready" ]] && break
  sleep 0.05
done
fd_ino="$(awk 'NR==1 {print $1}' "$rot/ready")"
path_ino="$(stat -c %i "$egress")"
run_rc "$T/rot1" "$INSTALL" --fixture-rotate --config "$rot/rot.conf" --state "$rot/state" --fixture-root "$rot"
if [[ "$(cat "$T/rot1.rc")" == "0" && "$fd_ino" == "$path_ino" && "$(stat -c %i "$egress")" == "$path_ino" ]] \
  && grep -qx 'BEFORE' "$egress.1" \
  && [[ ! -s "$egress" ]] \
  && [[ ! -e "$egress.2.gz" ]] \
  && grep -qx 'W0' "$watch.1"; then
  ok "first copytruncate kept the inode and the pre-rotate line"
  behavior held_fd_inode_unchanged 1
  behavior before_in_rotated 1
else
  bad "first copytruncate mismatch inode=$path_ino fd=$fd_ino"
  ls -l "$rot" >&2 || true
fi
touch "$rot/go"
for _ in $(seq 1 100); do
  [[ "$(wc -l <"$rot/ready")" -ge 2 ]] && break
  sleep 0.05
done
fd_ino_after="$(awk 'NR==2 {print $1}' "$rot/ready")"
if [[ "$fd_ino_after" == "$path_ino" ]] && grep -qx 'AFTER' "$egress" && ! grep -qx 'AFTER' "$egress.1"; then
  ok "held fd append after rotate landed in the current file"
  behavior after_append_in_current 1
else
  bad "post-rotate append was not in the current file"
fi
echo "W1" >>"$watch"
run_rc "$T/rot2" "$INSTALL" --fixture-rotate --config "$rot/rot.conf" --state "$rot/state" --fixture-root "$rot"
if [[ "$(cat "$T/rot2.rc")" == "0" && "$(stat -c %i "$egress")" == "$path_ino" ]] \
  && grep -qx 'AFTER' "$egress.1" \
  && gzip -t "$egress.2.gz" \
  && gzip -dc "$egress.2.gz" | grep -qx 'BEFORE' \
  && ! gzip -t "$egress.1" >/dev/null 2>&1 \
  && gzip -t "$watch.2.gz" \
  && [[ "$(stat -c %i "$watch")" == "$watch_ino" ]] \
  && gzip -dc "$watch.2.gz" | grep -qx 'W0' \
  && grep -qx 'W1' "$watch.1"; then
  ok "second rotation compressed only the older archive"
  behavior delaycompress_log1_plain 1
  behavior delaycompress_log2_gz 1
  behavior watch_rotated 1
else
  bad "delaycompress mismatch"
  ls -l "$rot" >&2 || true
fi
touch "$rot/release"
wait "$writer"
decoy_sha_after="$(sha256sum "$decoy_m" "$decoy_c" | sha256sum | awk 'NR==1 {print $1}')"
if [[ "$decoy_sha_before" == "$decoy_sha_after" && ! -e "$decoy_m.1" && ! -e "$decoy_c.1" ]]; then
  ok "master and cloudflared decoys were not rotated"
  behavior decoy_untouched 2
else
  bad "decoy files changed"
fi

keep="$T/keep"
mkdir -p -- "$keep"
k_eg="$keep/egress.log"
k_wa="$keep/watch.log"
echo SEED >"$k_eg"
echo SEED >"$k_wa"
rewrite "$keep/keep.conf" "$k_eg" "$k_wa"
chmod 644 "$keep/keep.conf"
keep_ok=1
for n in $(seq 1 15); do
  echo "GEN$n" >>"$k_eg"
  echo "GEN$n" >>"$k_wa"
  run_rc "$T/keep$n" "$INSTALL" --fixture-rotate --config "$keep/keep.conf" --state "$keep/state" --fixture-root "$keep"
  if [[ "$(cat "$T/keep$n.rc")" != "0" ]]; then
    keep_ok=0
    break
  fi
done
k_count="$(find "$keep" -name 'egress.log.*' | wc -l)"
if [[ "$keep_ok" == "1" && "$k_count" == "14" && ! -e "$k_eg.15" && ! -e "$k_eg.15.gz" ]] \
  && [[ "$(cat "$k_eg.1")" == "GEN15" ]] \
  && [[ "$(gzip -dc "$k_eg.2.gz")" == "GEN14" ]] \
  && [[ "$(gzip -dc "$k_eg.14.gz")" == "GEN2" ]] \
  && ! gzip -dc "$k_eg".*.gz | grep -qx 'GEN1' \
  && [[ "$(find "$keep" -name 'watch.log.*' | wc -l)" == "14" ]]; then
  ok "fifteen rotations kept 14 archives and dropped the oldest"
  behavior rotate14_kept 14
  behavior oldest_dropped 1
else
  bad "retention mismatch count=$k_count"
  ls -l "$keep" >&2 || true
fi

edge="$T/edge"
mkdir -p -- "$edge"
echo FILLED >"$edge/filled.log"
: >"$edge/empty.log"
cat >"$edge/edge.conf" <<EOF
create
$edge/filled.log
$edge/empty.log
$edge/missing.log {
    su root adm
    daily
    maxsize 200M
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
chmod 644 "$edge/edge.conf"
run_rc "$T/edge" "$INSTALL" --fixture-rotate --config "$edge/edge.conf" --state "$edge/state" --fixture-root "$edge"
if [[ "$(cat "$T/edge.rc")" == "0" && -f "$edge/filled.log.1" && ! -e "$edge/empty.log.1" && ! -e "$edge/missing.log" ]]; then
  ok "missing file is ignored and an empty file is not rotated"
  behavior missingok_exit0 1
  behavior empty_not_rotated 1
else
  bad "missing/empty behavior mismatch"
  ls -l "$edge" >&2 || true
fi

create_dir="$T/create"
mkdir -p -- "$create_dir"
echo OLD >"$create_dir/create.log"
create_ino="$(stat -c %i "$create_dir/create.log")"
python3 - "$create_dir/create.log" "$create_dir/ready" "$create_dir/go" "$create_dir/release" <<'PY' &
import os, sys, time
path, ready, go, release = sys.argv[1:]
fd = os.open(path, os.O_WRONLY | os.O_APPEND)
open(ready, "w", encoding="utf-8").write(str(os.fstat(fd).st_ino))
while not os.path.exists(go):
    time.sleep(0.02)
os.write(fd, b"AFTER_CREATE\n")
os.fsync(fd)
while not os.path.exists(release):
    time.sleep(0.02)
os.close(fd)
PY
cwriter=$!
for _ in $(seq 1 100); do
  [[ -s "$create_dir/ready" ]] && break
  sleep 0.05
done
cat >"$create_dir/create.conf" <<EOF
$create_dir/create.log {
    daily
    rotate 2
    missingok
    notifempty
    create 0644 root root
}
EOF
chmod 644 "$create_dir/create.conf"
run_rc "$T/create" "$INSTALL" --fixture-rotate --config "$create_dir/create.conf" --state "$create_dir/state" --fixture-root "$create_dir"
touch "$create_dir/go"
for _ in $(seq 1 50); do
  grep -q 'AFTER_CREATE' "$create_dir/create.log.1" 2>/dev/null && break
  sleep 0.05
done
touch "$create_dir/release"
wait "$cwriter"
create_after="$(stat -c %i "$create_dir/create.log")"
if [[ "$(cat "$T/create.rc")" == "0" && "$create_after" != "$create_ino" ]] \
  && ! grep -q 'AFTER_CREATE' "$create_dir/create.log" \
  && grep -q 'AFTER_CREATE' "$create_dir/create.log.1"; then
  ok "create-without-copytruncate changes inode and keeps the new write in the archive"
  behavior create_control_inode_changed 1
else
  bad "create control did not show an inode change"
fi

badforce="$T/badforce"
mkdir -p -- "$badforce"
printf '%s {\n    missingok\n    notifempty\n}\n' "$PATH_EGRESS" >"$badforce/bad.conf"
chmod 644 "$badforce/bad.conf"
run_rc "$T/badforce" "$INSTALL" --fixture-rotate --config "$badforce/bad.conf" --state "$badforce/state" --fixture-root "$badforce"
if [[ "$(cat "$T/badforce.rc")" != "0" ]] \
  && [[ ! -e "$badforce/state" ]] \
  && grep -q 'REFUSE_REAL_PATH' "$T/badforce.err"; then
  ok "force rotate refused a config that names the real egress log"
  behavior real_path_force_rejected 1
else
  bad "real egress path was not refused"
  cat "$T/badforce.err" >&2 || true
fi

outside_log="$(mktemp "$T/outside-log.XXXXXX")"
printf 'OUTSIDE\n' >"$outside_log"
outside_bytes="$(stat -c %s "$outside_log")"
nest="$(mktemp -d "$T/nest.XXXXXX")"
printf 'INSIDE\n' >"$nest/inside.log"
cat >"$nest/nested.conf" <<EOF
$outside_log {
    su root adm
    missingok
    notifempty
    copytruncate
}
EOF
cat >"$nest/main.conf" <<EOF
$nest/inside.log {
    su root adm
    daily
    missingok
    notifempty
    copytruncate
}
include $nest/nested.conf
EOF
chmod 644 "$nest/main.conf" "$nest/nested.conf"
run_rc "$T/nest" "$INSTALL" --fixture-rotate --config "$nest/main.conf" --state "$nest/state" --fixture-root "$nest"
if [[ "$(cat "$T/nest.rc")" != "0" ]] \
  && grep -q 'REFUSE_INCLUDE' "$T/nest.err" \
  && [[ ! -e "$nest/state" ]] \
  && [[ ! -e "$outside_log.1" ]] \
  && [[ "$(stat -c %s "$outside_log")" == "$outside_bytes" ]] \
  && [[ "$(cat "$outside_log")" == "OUTSIDE" ]]; then
  ok "nested include was refused before logrotate and the outside log stayed intact"
  behavior nested_include_rejected 1
else
  bad "nested include escaped or was not refused rc=$(cat "$T/nest.rc")"
  cat "$T/nest.err" >&2 || true
  ls -l "$nest" "$outside_log" "$outside_log.1" >&2 || true
fi

state_fix="$(mktemp -d "$T/statefix.XXXXXX")"
state_target="$T/state-target-must-not-exist"
printf 'KEEP\n' >"$state_fix/a.log"
cat >"$state_fix/a.conf" <<EOF
$state_fix/a.log {
    missingok
    notifempty
    copytruncate
}
EOF
ln -s "$state_target" "$state_fix/state"
chmod 644 "$state_fix/a.conf"
run_rc "$T/statefix" "$INSTALL" --fixture-rotate --config "$state_fix/a.conf" --state "$state_fix/state" --fixture-root "$state_fix"
if [[ "$(cat "$T/statefix.rc")" != "0" ]] \
  && grep -q 'REFUSE_ESCAPE' "$T/statefix.err" \
  && [[ ! -e "$state_target" ]] \
  && [[ ! -e "$state_fix/a.log.1" ]]; then
  ok "state symlink was refused before logrotate created the outside target"
  behavior state_symlink_no_write 1
else
  bad "state symlink was followed rc=$(cat "$T/statefix.rc")"
  cat "$T/statefix.err" >&2 || true
  ls -l "$state_target" "$state_fix" >&2 || true
fi

snap_live "$T/live.after"
set +e
python3 - "$T/live.before" "$T/live.after" <<'PY'
import sys
before = open(sys.argv[1], encoding="utf-8").read().splitlines()
after = open(sys.argv[2], encoding="utf-8").read().splitlines()
bmap = {}
problems = []
for line in before:
    kind, _, rest = line.partition(" ")
    if kind == "GROW":
        path, ino, size = rest.rsplit(" ", 2)
        bmap[("GROW", path)] = (ino, int(size))
    elif kind == "FROZEN":
        path, ino, size, digest = rest.rsplit(" ", 3)
        bmap[("FROZEN", path)] = (ino, size, digest)
    elif kind == "ABSENT":
        bmap[("ABSENT", rest)] = True
    elif kind == "SIDE":
        path, ino, size = rest.rsplit(" ", 2)
        bmap[("SIDE", path)] = (ino, size)
    else:
        bmap[(kind, rest)] = True
seen_side = set()
for line in after:
    kind, _, rest = line.partition(" ")
    if kind == "GROW":
        path, ino, size = rest.rsplit(" ", 2)
        old = bmap.get(("GROW", path))
        if old is None or old[0] != ino or int(size) < old[1]:
            problems.append("grow " + path)
    elif kind == "FROZEN":
        path, ino, size, digest = rest.rsplit(" ", 3)
        if bmap.get(("FROZEN", path)) != (ino, size, digest):
            problems.append("frozen " + path)
    elif kind == "ABSENT":
        if ("ABSENT", rest) not in bmap:
            problems.append("appeared " + rest)
    elif kind == "SIDE":
        path, ino, size = rest.rsplit(" ", 2)
        seen_side.add(path)
        if bmap.get(("SIDE", path)) != (ino, size):
            problems.append("side " + path)
    elif kind == "UNIT":
        if ("UNIT", rest) not in bmap:
            problems.append("unit " + rest)
    elif kind == "HOST_SNIPPET":
        if ("HOST_SNIPPET", rest) not in bmap or rest != "absent":
            problems.append("host snippet " + rest)
for key, value in bmap.items():
    if key[0] == "SIDE" and key[1] not in seen_side:
        problems.append("side vanished " + key[1])
    if key[0] == "ABSENT" and f"ABSENT {key[1]}" not in after and f"FROZEN {key[1]}" not in "\n".join(after):
        # ABSENT lines are exact; a later FROZEN would already be a problem above.
        if not any(line == f"ABSENT {key[1]}" for line in after):
            problems.append("absent changed " + key[1])
if problems:
    print("\n".join(problems))
    raise SystemExit(1)
print("live-unchanged")
PY
live_cmp=$?
set -e
if [[ "$live_cmp" == "0" ]]; then
  ok "real logs, marker, status, units, and host snippet stayed unrotated"
  behavior live_guard 1
else
  bad "live guard failed"
  cat "$T/live.before" "$T/live.after" >&2 || true
fi

printf 'LOGROTATE_CASES pass=%s fail=%s\n' "$pass" "$fail"
if [[ "$fail" == "0" ]]; then
  echo LOGROTATE_TEST_ALL_PASS
else
  echo LOGROTATE_TEST_FAILED
  exit 1
fi
