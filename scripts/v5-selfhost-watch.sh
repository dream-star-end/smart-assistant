#!/usr/bin/env bash
# OpenClaude V5 selfhost 看护。纯 bash+curl+jq(+python3 算 digest),禁止 npx/tsx。
# 脚本必须放在 /opt/openclaude/v5-selfhost-watch/,不随 git 工作树改动。
# 豁免用 cutover-grace-until 的绝对到期时间,不用 ActiveEnterTimestamp
# (Type=simple + RestartSec=5 的 crash loop 会不断刷新 ActiveEnter,导致看护永不动作)。
set -euo pipefail

WATCH_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${WATCH_SCRIPT_DIR}/watch.env" ]]; then
  # shellcheck disable=SC1091
  source "${WATCH_SCRIPT_DIR}/watch.env"
fi

WATCH_DRY="${WATCH_DRY:-1}"
WATCH_FAIL_THRESHOLD="${WATCH_FAIL_THRESHOLD:-5}"
WATCH_LOCK_TTL_SEC="${WATCH_LOCK_TTL_SEC:-3600}"
WATCH_MASTER_URL="${WATCH_MASTER_URL:-http://127.0.0.1:18790/healthz}"
WATCH_EGRESS_URL="${WATCH_EGRESS_URL:-http://172.31.0.1:18892/internal/v5/egress-health}"
WATCH_MASTER_UNIT="${WATCH_MASTER_UNIT:-openclaude-v5-selfhost.service}"
WATCH_EGRESS_UNIT="${WATCH_EGRESS_UNIT:-openclaude-v5-selfhost-egress.service}"
WATCH_LIVE="${WATCH_LIVE:-/opt/openclaude/openclaude-v5-selfhost-live}"
WATCH_RELEASES_ROOT="${WATCH_RELEASES_ROOT:-/opt/openclaude/openclaude-v5-selfhost-releases}"
WATCH_LOCK="${WATCH_LOCK:-/run/openclaude-v5-selfhost/deploy.lock}"
WATCH_MAINT="${WATCH_MAINT:-/run/openclaude-v5-selfhost/planned-maintenance}"
WATCH_GRACE="${WATCH_GRACE:-/run/openclaude-v5-selfhost/cutover-grace-until}"
WATCH_FAIL_COUNT="${WATCH_FAIL_COUNT:-/run/openclaude-v5-selfhost/health-fail-count}"
WATCH_RUN_DIR="${WATCH_RUN_DIR:-/run/openclaude-v5-selfhost}"
WATCH_DISARM="${WATCH_DISARM:-/opt/openclaude/v5-selfhost-watch/watch-disarmed}"
WATCH_LOG="${WATCH_LOG:-/var/log/openclaude-v5-selfhost-watch.log}"
WATCH_RESTORE="${WATCH_RESTORE:-/opt/openclaude/v5-selfhost-breakglass/restore-worktree-units.sh}"
WATCH_BACKUP_CURRENT="${WATCH_BACKUP_CURRENT:-/opt/openclaude/v5-selfhost-breakglass/unit-backups/worktree-current}"
WATCH_MANUAL_RECOVERY="${WATCH_MANUAL_RECOVERY:-/opt/openclaude/openclaude-v5-selfhost-releases/.manual-recovery-required}"
WATCH_NOW_OVERRIDE="${WATCH_NOW_OVERRIDE:-}"
WATCH_STUB_MASTER="${WATCH_STUB_MASTER:-}"
WATCH_STUB_EGRESS="${WATCH_STUB_EGRESS:-}"
WATCH_STUB_MASTER_BODY="${WATCH_STUB_MASTER_BODY:-}"
WATCH_STUB_UNIT_MASTER="${WATCH_STUB_UNIT_MASTER:-}"
WATCH_STUB_UNIT_EGRESS="${WATCH_STUB_UNIT_EGRESS:-}"
WATCH_STUB_PG="${WATCH_STUB_PG:-}"
WATCH_STUB_REDIS="${WATCH_STUB_REDIS:-}"
WATCH_STUB_DOCKER="${WATCH_STUB_DOCKER:-}"
WATCH_SKIP_ACTIONS="${WATCH_SKIP_ACTIONS:-0}"

wlog() {
  local msg
  msg="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  mkdir -p "$(dirname -- "$WATCH_LOG")" 2>/dev/null || true
  echo "$msg" | tee -a "$WATCH_LOG" >/dev/null
  echo "$msg"
}

watch_now() {
  if [[ -n "$WATCH_NOW_OVERRIDE" ]]; then
    printf '%s\n' "$WATCH_NOW_OVERRIDE"
  else
    date +%s
  fi
}

is_true_dry() {
  [[ "$WATCH_DRY" == "1" || "$WATCH_DRY" == "true" || "$WATCH_DRY" == "yes" ]]
}

pid_alive() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -d "/proc/${pid}" ]]
}

parse_kv_file() {
  local file="$1" key="$2" line
  [[ -f "$file" && ! -L "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "${key}="*)
        printf '%s\n' "${line#${key}=}"
        return 0
        ;;
    esac
  done <"$file"
  return 1
}

# 活且未过期的发布锁才豁免。死 pid / 过期 started / 无 holder → 不当豁免。
lock_is_live_exemption() {
  local lock="$WATCH_LOCK" holder pid started started_epoch now age fuser_pids
  [[ -f "$lock" && ! -L "$lock" ]] || return 1
  holder="${lock}.holder"
  pid=""
  started=""
  if [[ -f "$holder" && ! -L "$holder" ]]; then
    pid="$(sed -n 's/^pid=\([0-9][0-9]*\).*/\1/p' "$holder" | head -n1 || true)"
    started="$(sed -n 's/.*started=\([^[:space:]]*\).*/\1/p' "$holder" | head -n1 || true)"
  fi
  fuser_pids="$(fuser "$lock" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//' || true)"
  now="$(watch_now)"
  if [[ -n "$started" ]]; then
    started_epoch="$(date -d "$started" +%s 2>/dev/null || echo "")"
  else
    started_epoch="$(stat -c '%Y' "$lock" 2>/dev/null || echo "")"
  fi
  if [[ -z "$started_epoch" || ! "$started_epoch" =~ ^[0-9]+$ ]]; then
    wlog "WARN lock 时间戳不可解析,不当豁免 lock=$lock"
    return 1
  fi
  age=$((now - started_epoch))
  if (( age < 0 )); then
    age=0
  fi
  if (( age > WATCH_LOCK_TTL_SEC )); then
    wlog "WARN lock 过期 age=${age}s ttl=${WATCH_LOCK_TTL_SEC}s 不当豁免"
    return 1
  fi
  if [[ -n "$pid" ]] && pid_alive "$pid"; then
    return 0
  fi
  if [[ -n "$fuser_pids" ]]; then
    local p
    for p in $fuser_pids; do
      if pid_alive "$p"; then
        return 0
      fi
    done
  fi
  wlog "WARN lock 无活 pid 不当豁免 holder_pid=${pid:-none} fuser=${fuser_pids:-none}"
  return 1
}

maint_is_live_exemption() {
  local until_ts owner now
  [[ -f "$WATCH_MAINT" && ! -L "$WATCH_MAINT" ]] || return 1
  until_ts="$(parse_kv_file "$WATCH_MAINT" until || true)"
  owner="$(parse_kv_file "$WATCH_MAINT" owner || true)"
  now="$(watch_now)"
  if [[ ! "$until_ts" =~ ^[0-9]+$ ]] || (( now >= until_ts )); then
    wlog "WARN 维护标记过期或无 until=,忽略并删除 $WATCH_MAINT"
    if [[ "$WATCH_SKIP_ACTIONS" != 1 ]]; then
      rm -f -- "$WATCH_MAINT"
    fi
    return 1
  fi
  if [[ -n "$owner" ]] && ! pid_alive "$owner"; then
    wlog "WARN 维护标记 owner=$owner 已死,忽略并删除"
    if [[ "$WATCH_SKIP_ACTIONS" != 1 ]]; then
      rm -f -- "$WATCH_MAINT"
    fi
    return 1
  fi
  return 0
}

in_cutover_grace() {
  local until_ts now
  [[ -f "$WATCH_GRACE" && ! -L "$WATCH_GRACE" ]] || return 1
  until_ts="$(parse_kv_file "$WATCH_GRACE" until || true)"
  [[ "$until_ts" =~ ^[0-9]+$ ]] || return 1
  now="$(watch_now)"
  (( now < until_ts ))
}

read_fail_count() {
  local n
  n="$(cat "$WATCH_FAIL_COUNT" 2>/dev/null || echo 0)"
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  printf '%s\n' "$n"
}

write_fail_count() {
  local n="$1" dir
  dir="$(dirname -- "$WATCH_FAIL_COUNT")"
  mkdir -p -- "$dir"
  printf '%s\n' "$n" >"$WATCH_FAIL_COUNT"
}

unit_is_active() {
  local unit="$1" stub st
  case "$unit" in
    "$WATCH_MASTER_UNIT") stub="$WATCH_STUB_UNIT_MASTER" ;;
    "$WATCH_EGRESS_UNIT") stub="$WATCH_STUB_UNIT_EGRESS" ;;
    *) stub="" ;;
  esac
  if [[ -n "$stub" ]]; then
    [[ "$stub" == "active" ]]
    return
  fi
  st="$(systemctl is-active "$unit" 2>/dev/null || true)"
  [[ "$st" == "active" ]]
}

probe_master() {
  local body
  if [[ -n "$WATCH_STUB_MASTER" ]]; then
    [[ "$WATCH_STUB_MASTER" == "ok" ]] || return 1
    return 0
  fi
  body="$(curl -fsS --max-time 5 "$WATCH_MASTER_URL" 2>/dev/null || true)"
  WATCH_LAST_MASTER_BODY="$body"
  echo "$body" | jq -e '.ok==true' >/dev/null 2>&1
}

probe_egress() {
  local body
  if [[ -n "$WATCH_STUB_EGRESS" ]]; then
    [[ "$WATCH_STUB_EGRESS" == "ok" ]] || return 1
    return 0
  fi
  body="$(curl -fsS --max-time 5 "$WATCH_EGRESS_URL" 2>/dev/null || true)"
  echo "$body" | jq -e '.ok==true' >/dev/null 2>&1
}

dep_is_active() {
  local name="$1" stub="$2" st
  if [[ -n "$stub" ]]; then
    [[ "$stub" == "ok" || "$stub" == "active" ]]
    return
  fi
  st="$(systemctl is-active "$name" 2>/dev/null || true)"
  [[ "$st" == "active" ]]
}

# schema/env/外部依赖 → fail-loud,禁止自动回切。
classify_fail_loud() {
  local body="${WATCH_LAST_MASTER_BODY:-$WATCH_STUB_MASTER_BODY}"
  if ! dep_is_active postgresql.service "$WATCH_STUB_PG"; then
    printf '%s\n' "external-pg"
    return 0
  fi
  if ! dep_is_active redis-server.service "$WATCH_STUB_REDIS"; then
    printf '%s\n' "external-redis"
    return 0
  fi
  if ! dep_is_active docker.service "$WATCH_STUB_DOCKER"; then
    printf '%s\n' "external-docker"
    return 0
  fi
  if [[ -n "$body" ]]; then
    if echo "$body" | jq -e '.deps.pg? | tostring | test("ok"; "i") | not' >/dev/null 2>&1; then
      if echo "$body" | jq -e 'has("deps")' >/dev/null 2>&1; then
        local pg
        pg="$(echo "$body" | jq -er '.deps.pg // empty' 2>/dev/null || true)"
        if [[ -n "$pg" && "$pg" != "ok" ]]; then
          printf '%s\n' "deps-pg"
          return 0
        fi
      fi
    fi
    if echo "$body" | grep -Eiq 'schema_migrations|cannot find type|column .* does not exist|relation .* does not exist|migration'; then
      printf '%s\n' "schema"
      return 0
    fi
    if echo "$body" | grep -Eiq 'DATABASE_URL|JWT_SECRET|OPENCLAUDE_KMS|env .* missing|EACCES.*commercial-v5-selfhost.env'; then
      printf '%s\n' "env"
      return 0
    fi
  fi
  if [[ "${WATCH_STUB_FAIL_LOUD:-}" != "" ]]; then
    printf '%s\n' "$WATCH_STUB_FAIL_LOUD"
    return 0
  fi
  return 1
}

write_manual_recovery() {
  local reason="$1"
  mkdir -p -- "$(dirname -- "$WATCH_MANUAL_RECOVERY")"
  printf 'until=%s\nreason=%s\nwritten=%s\n' "$(watch_now)" "$reason" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"$WATCH_MANUAL_RECOVERY"
  wlog "FAIL-LOUD 已写 $WATCH_MANUAL_RECOVERY reason=$reason"
}

release_artifact_digest_watch() {
  local root="$1"
  python3 - "$root" <<'PY'
import hashlib
import os
import stat
import sys

root = os.fsencode(os.path.abspath(sys.argv[1]))
if not os.path.isdir(root) or os.path.islink(root):
    raise SystemExit("FATAL: release artifact root is not a real directory")

def identity(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid,
            st.st_size, st.st_mtime_ns, st.st_ctime_ns)

def snapshot_tree():
    root_stat = os.lstat(root)
    if not stat.S_ISDIR(root_stat.st_mode):
        raise RuntimeError("release artifact root changed type")
    rows = []

    def collect(directory, prefix=b""):
        with os.scandir(directory) as scan:
            for entry in scan:
                name = entry.name
                rel = name if not prefix else prefix + b"/" + name
                if rel == b".complete":
                    continue
                st = entry.stat(follow_symlinks=False)
                mode = st.st_mode
                if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode)):
                    raise RuntimeError("non-regular release entry: %s" % os.fsdecode(rel))
                rows.append((rel, entry.path, identity(st)))
                if stat.S_ISDIR(mode):
                    collect(entry.path, rel)

    collect(root)
    rows.sort(key=lambda item: item[0])
    return identity(root_stat), rows

root_before, entries = snapshot_tree()
digest = hashlib.sha256(b"openclaude-release-artifact-v2\0")

def field(value):
    if isinstance(value, str):
        value = value.encode("ascii")
    digest.update(len(value).to_bytes(8, "big"))
    digest.update(value)

root_stat = os.lstat(root)
if identity(root_stat) != root_before:
    raise RuntimeError("release artifact root changed before digest")
field(b"D")
field(b"")
field(str(stat.S_IMODE(root_stat.st_mode)))
field(str(root_stat.st_uid))
field(str(root_stat.st_gid))

for rel, absolute, before in entries:
    st = os.lstat(absolute)
    if identity(st) != before:
        raise RuntimeError("release entry changed during digest: %s" % os.fsdecode(rel))
    mode = st.st_mode
    kind = b"F" if stat.S_ISREG(mode) else b"D" if stat.S_ISDIR(mode) else b"L"
    field(kind)
    field(rel)
    field(str(stat.S_IMODE(mode)))
    field(str(st.st_uid))
    field(str(st.st_gid))
    if kind == b"F":
        field(str(st.st_size))
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(absolute, flags)
        if identity(os.fstat(fd)) != before:
            os.close(fd)
            raise RuntimeError("release file changed before open: %s" % os.fsdecode(rel))
        with os.fdopen(fd, "rb", buffering=1024 * 1024) as fh:
            while chunk := fh.read(1024 * 1024):
                digest.update(chunk)
            if identity(os.fstat(fh.fileno())) != before:
                raise RuntimeError("release file changed while open: %s" % os.fsdecode(rel))
    elif kind == b"L":
        field(os.readlink(absolute))
    if identity(os.lstat(absolute)) != before:
        raise RuntimeError("release entry changed while hashing: %s" % os.fsdecode(rel))

root_after, entries_after = snapshot_tree()
before_signature = [(rel, before) for rel, _absolute, before in entries]
after_signature = [(rel, after) for rel, _absolute, after in entries_after]
if root_after != root_before or after_signature != before_signature:
    raise RuntimeError("release tree changed during digest")
print(digest.hexdigest())
PY
}

prev_release_is_valid() {
  local prev marker expected got root
  prev="$(tr -d '[:space:]' <"${WATCH_RELEASES_ROOT}/.prev-release" 2>/dev/null || true)"
  [[ -n "$prev" && "$prev" != "none" && "$prev" != "NONE" ]] || return 1
  case "$prev" in
    "${WATCH_RELEASES_ROOT}"/rel-*) ;;
    *)
      wlog "WARN .prev-release 不在 releases 根下: $prev"
      return 1
      ;;
  esac
  [[ "$prev" != *.poisoned ]] || return 1
  [[ -d "$prev" && ! -L "$prev" ]] || return 1
  marker="$prev/.complete"
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  expected="$(jq -er '.artifactSha256' "$marker" 2>/dev/null || true)"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  root="$prev"
  got="$(release_artifact_digest_watch "$root")"
  [[ "$got" == "$expected" ]]
}

atomic_flip_live() {
  local target="$1" tmp
  tmp="${WATCH_LIVE}.watchlink.$$"
  rm -f -- "$tmp"
  ln -s -- "$target" "$tmp"
  mv -T -- "$tmp" "$WATCH_LIVE"
}

write_grace() {
  local until_ts
  until_ts=$(( $(watch_now) + ${WATCH_GRACE_SEC:-90} ))
  mkdir -p -- "$(dirname -- "$WATCH_GRACE")"
  printf 'until=%s\n' "$until_ts" >"$WATCH_GRACE"
}

tier1_rollback() {
  local prev
  prev="$(tr -d '[:space:]' <"${WATCH_RELEASES_ROOT}/.prev-release" 2>/dev/null || true)"
  if ! prev_release_is_valid; then
    wlog "tier1 无合法 prev release"
    return 1
  fi
  wlog "tier1 准备切 live -> $prev dry=$WATCH_DRY"
  if is_true_dry || [[ "$WATCH_SKIP_ACTIONS" == 1 ]]; then
    wlog "[dry] 不执行 ln/mv/restart"
    return 0
  fi
  write_grace
  atomic_flip_live "$prev"
  systemctl restart "$WATCH_EGRESS_UNIT"
  timeout 90 bash -c 'until (exec 3<>/dev/tcp/172.31.0.1/18892) 2>/dev/null; do sleep 1; done' || true
  systemctl restart "$WATCH_MASTER_UNIT"
  return 0
}

tier2_restore_units() {
  wlog "tier2 准备恢复备份 unit ← $WATCH_BACKUP_CURRENT dry=$WATCH_DRY"
  if [[ ! -d "$WATCH_BACKUP_CURRENT" ]]; then
    wlog "tier2 备份目录不存在"
    return 1
  fi
  if is_true_dry || [[ "$WATCH_SKIP_ACTIONS" == 1 ]]; then
    wlog "[dry] 不执行 restore-worktree-units.sh"
    return 0
  fi
  write_grace
  bash "$WATCH_RESTORE"
}

compound_green() {
  unit_is_active "$WATCH_MASTER_UNIT" \
    && unit_is_active "$WATCH_EGRESS_UNIT" \
    && probe_master \
    && probe_egress
}

watch_once() {
  local count reason loud
  WATCH_LAST_MASTER_BODY=""

  if [[ -f "$WATCH_DISARM" ]]; then
    wlog "disarmed 标记存在,退出"
    return 0
  fi
  if [[ -f "$WATCH_MANUAL_RECOVERY" ]]; then
    wlog "manual-recovery-required 存在,拒绝自动回切"
    return 0
  fi
  if lock_is_live_exemption; then
    wlog "发布锁活且未过期,退出"
    return 0
  fi
  if maint_is_live_exemption; then
    wlog "维护窗口未到期,退出"
    return 0
  fi
  if in_cutover_grace; then
    wlog "cutover grace 未到期(绝对 until,不看 ActiveEnterTimestamp),退出"
    return 0
  fi

  if compound_green; then
    write_fail_count 0
    wlog "复合健康绿,清失败计数"
    return 0
  fi

  if loud="$(classify_fail_loud)"; then
    wlog "FAIL-LOUD class=$loud 不自动回切"
    write_manual_recovery "$loud"
    mkdir -p -- "$(dirname -- "$WATCH_DISARM")"
    printf 'reason=%s\n' "$loud" >"$WATCH_DISARM"
    return 0
  fi

  count="$(read_fail_count)"
  count=$((count + 1))
  write_fail_count "$count"
  wlog "复合健康红 count=$count/$WATCH_FAIL_THRESHOLD master_unit=$(unit_is_active "$WATCH_MASTER_UNIT" && echo active || echo down) egress_unit=$(unit_is_active "$WATCH_EGRESS_UNIT" && echo active || echo down)"

  if (( count < WATCH_FAIL_THRESHOLD )); then
    return 0
  fi

  wlog "达到阈值,进入两级兜底"
  if prev_release_is_valid; then
    if tier1_rollback; then
      sleep 3
      if [[ "$WATCH_SKIP_ACTIONS" == 1 ]] || is_true_dry || compound_green; then
        if is_true_dry || [[ "$WATCH_SKIP_ACTIONS" == 1 ]]; then
          wlog "tier1 dry 不计为转绿,不冻结(避免把演练当恢复)"
          return 0
        fi
        write_fail_count 0
        wlog "tier1 成功且转绿,冻结计数"
        return 0
      fi
      wlog "tier1 回切后仍红,进入 tier2"
    fi
  else
    wlog "无上一份合法 release,跳过 tier1 直接 tier2"
  fi

  if tier2_restore_units; then
    sleep 3
    if [[ "$WATCH_SKIP_ACTIONS" == 1 ]] || is_true_dry; then
      wlog "tier2 dry 完成"
      return 0
    fi
    if compound_green; then
      write_fail_count 0
      wlog "tier2 成功且转绿,冻结计数"
      return 0
    fi
  fi

  write_manual_recovery "tier1+tier2-failed"
  mkdir -p -- "$(dirname -- "$WATCH_DISARM")"
  printf 'reason=tier1+tier2-failed\n' >"$WATCH_DISARM"
  wlog "两级兜底仍红,已 disarm。需要人工跑应急恢复脚本。"
  return 1
}

watch_selftest() {
  local base
  base="$(mktemp -d /tmp/v5-selfhost-watch-selftest.XXXXXX)"
  echo "SELFTEST_DIR=$base"
  export WATCH_DRY=1
  export WATCH_SKIP_ACTIONS=1
  export WATCH_LOG="$base/watch.log"
  export WATCH_RUN_DIR="$base/run"
  export WATCH_LOCK="$base/run/deploy.lock"
  export WATCH_MAINT="$base/run/planned-maintenance"
  export WATCH_GRACE="$base/run/cutover-grace-until"
  export WATCH_FAIL_COUNT="$base/run/health-fail-count"
  export WATCH_DISARM="$base/watch-disarmed"
  export WATCH_MANUAL_RECOVERY="$base/releases/.manual-recovery-required"
  export WATCH_RELEASES_ROOT="$base/releases"
  export WATCH_LIVE="$base/live"
  export WATCH_BACKUP_CURRENT="$base/backup"
  export WATCH_RESTORE="/bin/true"
  mkdir -p -- "$WATCH_RUN_DIR" "$WATCH_RELEASES_ROOT" "$WATCH_BACKUP_CURRENT"
  export WATCH_STUB_PG=ok WATCH_STUB_REDIS=ok WATCH_STUB_DOCKER=ok
  export WATCH_STUB_UNIT_MASTER=active WATCH_STUB_UNIT_EGRESS=active
  export WATCH_NOW_OVERRIDE=1000000000
  : >"$WATCH_LOCK"

  echo "===== 场景1: crash loop 刷 ActiveEnter 但 grace 已过期 → 必须计数 ====="
  # grace 到期;不写 ActiveEnter(看护本来就不读它)。master 红。
  printf 'until=999999990\n' >"$WATCH_GRACE"
  export WATCH_STUB_MASTER=fail WATCH_STUB_EGRESS=ok
  write_fail_count 0
  rm -f -- "$WATCH_DISARM" "$WATCH_MANUAL_RECOVERY"
  watch_once || true
  echo "fail_count=$(read_fail_count) (期望>=1)"
  [[ "$(read_fail_count)" -ge 1 ]] || { echo "FAIL 场景1 未计数"; return 1; }
  echo "PASS 场景1: grace 绝对到期后 crash loop 不能挡住看护"

  echo "===== 场景2: 锁过期不当豁免 ====="
  printf 'until=1\n' >"$WATCH_GRACE"
  printf 'pid=1 user=root tree=/x started=2000-01-01T00:00:00+00:00\n' >"${WATCH_LOCK}.holder"
  export WATCH_STUB_MASTER=fail
  write_fail_count 0
  watch_once || true
  echo "fail_count=$(read_fail_count) (期望>=1,锁过期仍探测)"
  [[ "$(read_fail_count)" -ge 1 ]] || { echo "FAIL 场景2"; return 1; }
  echo "PASS 场景2: 过期锁不当豁免"

  echo "===== 场景3: 活锁未过期 → 退出不清健康 ====="
  printf 'pid=%s user=root tree=/x started=%s\n' "$$" "$(date -Is)" >"${WATCH_LOCK}.holder"
  export WATCH_NOW_OVERRIDE=""
  write_fail_count 0
  watch_once
  echo "fail_count=$(read_fail_count) (期望0,不应探测)"
  [[ "$(read_fail_count)" == 0 ]] || { echo "FAIL 场景3"; return 1; }
  echo "PASS 场景3: 活锁豁免"
  export WATCH_NOW_OVERRIDE=1000000000
  rm -f -- "${WATCH_LOCK}.holder"

  echo "===== 场景4: egress 挂 master 活 → 计失败 ====="
  printf 'until=1\n' >"$WATCH_GRACE"
  export WATCH_STUB_MASTER=ok WATCH_STUB_EGRESS=fail
  write_fail_count 0
  watch_once || true
  echo "fail_count=$(read_fail_count) (期望>=1)"
  [[ "$(read_fail_count)" -ge 1 ]] || { echo "FAIL 场景4"; return 1; }
  echo "PASS 场景4: egress-only 下线会被发现"

  echo "===== 场景5: 无上一份 release 走二级 ====="
  export WATCH_STUB_MASTER=fail WATCH_STUB_EGRESS=fail
  write_fail_count 4
  rm -f -- "${WATCH_RELEASES_ROOT}/.prev-release"
  watch_once || true
  grep -F "跳过 tier1 直接 tier2" "$WATCH_LOG" >/dev/null
  grep -F "tier2" "$WATCH_LOG" >/dev/null
  echo "PASS 场景5: 无 prev → tier2"
  echo "相关日志:"
  grep -E 'tier1|tier2|无上一份' "$WATCH_LOG" | tail -n 8

  echo "===== 场景6: schema fail-loud 不回切 ====="
  write_fail_count 0
  rm -f -- "$WATCH_DISARM" "$WATCH_MANUAL_RECOVERY"
  export WATCH_STUB_MASTER=fail WATCH_STUB_EGRESS=ok
  export WATCH_STUB_FAIL_LOUD=schema
  watch_once || true
  [[ -f "$WATCH_MANUAL_RECOVERY" ]] || { echo "FAIL 场景6 未写 manual-recovery"; return 1; }
  [[ -f "$WATCH_DISARM" ]] || { echo "FAIL 场景6 未 disarm"; return 1; }
  echo "PASS 场景6: schema fail-loud"
  unset WATCH_STUB_FAIL_LOUD

  echo "===== 场景7: 活的 cutover grace 豁免(即使服务红) ====="
  rm -f -- "$WATCH_DISARM" "$WATCH_MANUAL_RECOVERY"
  write_fail_count 0
  printf 'until=1000000900\n' >"$WATCH_GRACE"
  export WATCH_STUB_MASTER=fail WATCH_STUB_EGRESS=fail
  watch_once
  [[ "$(read_fail_count)" == 0 ]] || { echo "FAIL 场景7"; return 1; }
  echo "PASS 场景7: grace until 绝对时间生效"

  echo "SELFTEST_ALL_PASS"
  echo "log=$WATCH_LOG"
  return 0
}

usage_watch() {
  cat <<'EOF'
用法: watch.sh [--once|--selftest]
  默认同 --once。WATCH_DRY=1(watch.env)时只记日志不真回切。
  切到真模式: 把 /opt/openclaude/v5-selfhost-watch/watch.env 里 WATCH_DRY=1 改成 0
  然后: systemctl daemon-reload && systemctl enable --now openclaude-v5-selfhost-watch.timer
EOF
}

main() {
  case "${1:-}" in
    -h|--help) usage_watch; exit 0 ;;
    --selftest) watch_selftest ;;
    --once|"") watch_once ;;
    *)
      echo "未知参数: $1" >&2
      usage_watch >&2
      exit 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "${1:-}"
fi
