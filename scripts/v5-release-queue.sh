#!/usr/bin/env bash
# Durable FIFO for V5 development releases.
#
# The queue owns the complete protected-merge -> canary -> validation -> finalize
# lifecycle.  deploy-v5.sh still owns command-level serialization; this queue
# prevents a later development task from merging or deploying through an earlier
# task's rollout window.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${OC_V5_RELEASE_QUEUE_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
QUEUE_DB="${OC_V5_RELEASE_QUEUE_DB:-/var/lib/openclaude-v5/development-release-queue.db}"
QUEUE_LOCK="${OC_V5_RELEASE_QUEUE_LOCK:-/var/lock/oc-v5-release-queue.lock}"
DEPLOY_LOCK="${OC_V5_DEPLOY_LOCK_FILE:-/var/lock/oc-v5-deploy.lock}"
KL_HOST="${KL_HOST:-kl-mirror}"
V5_ENV="${V5_ENV:-/etc/openclaude/commercial-v5.env}"
REMOTE_RELEASES_ROOT="${OC_V5_REMOTE_RELEASES_ROOT:-/opt/openclaude/openclaude-v5-releases}"
MUTATION_MARKER="${OC_V5_MUTATION_LANE_MARKER:-$REMOTE_RELEASES_ROOT/.mutation-lane-inflight}"
RECOVERY_MARKER="${OC_V5_DEPLOY_RECOVERY_MARKER:-$REMOTE_RELEASES_ROOT/.manual-recovery-required}"
REMOTE_MUTATION_LOCK="/run/openclaude-v5/production-mutation.lock"
REMOTE_MANUAL_LEASE_PROOF="${REMOTE_MUTATION_LOCK}.manual-holder"
LEASE_WRAPPER="${OC_V5_RELEASE_QUEUE_LEASE_WRAPPER:-$SCRIPT_DIR/with-production-mutation-lease.sh}"
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
QUEUE_RUN_DIR="${OC_V5_RELEASE_QUEUE_RUN_DIR:-/var/run/openclaude-v5/release-queue}"
HEARTBEAT_INTERVAL="${OC_V5_HEARTBEAT_INTERVAL:-30}"
HEARTBEAT_MAX_SECONDS="${OC_V5_HEARTBEAT_MAX_SECONDS:-14400}"
HEARTBEAT_STALE_SECONDS="${OC_V5_HEARTBEAT_STALE_SECONDS:-180}"

die() {
  echo "✗ $*" >&2
  exit 2
}

need_tool() {
  command -v "$1" >/dev/null 2>&1 || die "缺少必需命令:$1"
}

sql_quote() {
  local value="$1"
  printf "%s" "${value//\'/\'\'}"
}

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

valid_id() {
  [[ "$1" =~ ^rq-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]]
}

valid_label() {
  [[ -n "$1" && ${#1} -le 200 && "$1" =~ ^[A-Za-z0-9._/@:+-]+$ ]]
}

valid_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

init_db_locked() {
  mkdir -p "$(dirname "$QUEUE_DB")"
  sqlite3 "$QUEUE_DB" >/dev/null <<'SQL'
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS release_queue_jobs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task TEXT NOT NULL,
  branch TEXT NOT NULL,
  requested_sha TEXT NOT NULL,
  canonical_sha TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','active','completed','cancelled','abandoned')),
  owner TEXT,
  result TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  pinned_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS release_queue_one_active
  ON release_queue_jobs(status) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS release_queue_one_inflight_revision
  ON release_queue_jobs(branch, requested_sha)
  WHERE status IN ('queued','active');
CREATE TABLE IF NOT EXISTS release_queue_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES release_queue_jobs(id)
);
SQL
  chmod 600 "$QUEUE_DB"
}

with_queue_lock() {
  mkdir -p "$(dirname "$QUEUE_LOCK")"
  exec 210>"$QUEUE_LOCK"
  flock 210
  init_db_locked
  "$@"
}

job_field_locked() {
  local id="$1" field="$2"
  sqlite3 -noheader "$QUEUE_DB" \
    "SELECT $field FROM release_queue_jobs WHERE id='$(sql_quote "$id")' LIMIT 1;"
}

submit_locked() {
  local task="$1" branch="$2" requested_sha="$3" actor="$4"
  local existing id created
  existing="$(sqlite3 -noheader "$QUEUE_DB" \
    "SELECT id FROM release_queue_jobs
       WHERE branch='$(sql_quote "$branch")'
         AND requested_sha='$(sql_quote "$requested_sha")'
         AND status IN ('queued','active')
       LIMIT 1;")"
  if [[ -n "$existing" ]]; then
    printf '%s\n' "$existing"
    return 0
  fi

  id="rq-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 6)"
  created="$(now_iso)"
  sqlite3 "$QUEUE_DB" <<SQL
BEGIN IMMEDIATE;
INSERT INTO release_queue_jobs
  (id, task, branch, requested_sha, status, created_at, updated_at)
VALUES
  ('$(sql_quote "$id")','$(sql_quote "$task")','$(sql_quote "$branch")',
   '$(sql_quote "$requested_sha")','queued','$(sql_quote "$created")','$(sql_quote "$created")');
INSERT INTO release_queue_events(job_id,event,actor,detail,created_at)
VALUES
  ('$(sql_quote "$id")','submitted','$(sql_quote "$actor")',
   'branch=$(sql_quote "$branch") requested_sha=$(sql_quote "$requested_sha")',
   '$(sql_quote "$created")');
COMMIT;
SQL
  printf '%s\n' "$id"
}

describe_blocking_active_locked() { # <blocking-id> <wanted-id>
  local blocking="$1" wanted="$2" owner updated age_line stale=0
  owner="$(job_field_locked "$blocking" owner)"
  updated="$(job_field_locked "$blocking" updated_at)"
  stale="$(sqlite3 -noheader "$QUEUE_DB" \
    "SELECT CASE WHEN updated_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-${HEARTBEAT_STALE_SECONDS} seconds')
                THEN 1 ELSE 0 END
       FROM release_queue_jobs WHERE id='$(sql_quote "$blocking")';")"
  echo "⏳ 当前发布项仍在执行:$blocking owner=${owner:-?} updated_at=${updated:-?} wanted=$wanted" >&2
  if [[ "$stale" == 1 ]]; then
    echo "⚠ 该 active 已陈旧(updated_at 超过 ${HEARTBEAT_STALE_SECONDS}s)。守护进程停了也不会自动 abandon；队列会一直堵到有人收口。" >&2
    echo "  发现: scripts/v5-release-queue.sh status" >&2
    echo "  处理: 联系 owner=${owner:-?} 跑 finish；或在生产 phase=stable / candidate 空 / marker 不在 后:" >&2
    echo "        scripts/v5-release-queue.sh abandon-active --id $blocking --result not-deployed --reason stale-ghost --operator \$USER" >&2
  fi
}

stale_foreign_active_locked() { # <wanted-id> → 0 if a different active job is stale
  local wanted="$1" row
  row="$(sqlite3 -noheader "$QUEUE_DB" \
    "SELECT id FROM release_queue_jobs
      WHERE status='active'
        AND id != '$(sql_quote "$wanted")'
        AND updated_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-${HEARTBEAT_STALE_SECONDS} seconds')
      LIMIT 1;")"
  [[ -n "$row" ]]
}

acquire_locked() {
  local id="$1" actor="$2" status active oldest created
  status="$(job_field_locked "$id" status)"
  [[ -n "$status" ]] || die "队列项不存在:$id"
  if [[ "$status" == active ]]; then
    [[ "$(job_field_locked "$id" owner)" == "$actor" ]] \
      || { echo "✗ 队列项已由其他 owner 激活:$id" >&2; return 75; }
    printf '%s\n' "$id"
    return 0
  fi
  [[ "$status" == queued ]] || die "队列项不可激活:$id status=$status"
  active="$(sqlite3 -noheader "$QUEUE_DB" \
    "SELECT id FROM release_queue_jobs WHERE status='active' LIMIT 1;")"
  [[ -z "$active" ]] || {
    describe_blocking_active_locked "$active" "$id"
    return 75
  }
  oldest="$(sqlite3 -noheader "$QUEUE_DB" \
    "SELECT id FROM release_queue_jobs WHERE status='queued' ORDER BY seq LIMIT 1;")"
  [[ "$oldest" == "$id" ]] || {
    echo "⏳ 尚未轮到 $id；队首=$oldest" >&2
    return 75
  }
  created="$(now_iso)"
  sqlite3 "$QUEUE_DB" <<SQL
BEGIN IMMEDIATE;
UPDATE release_queue_jobs
   SET status='active', owner='$(sql_quote "$actor")',
       activated_at='$(sql_quote "$created")', updated_at='$(sql_quote "$created")'
 WHERE id='$(sql_quote "$id")' AND status='queued';
INSERT INTO release_queue_events(job_id,event,actor,detail,created_at)
VALUES
  ('$(sql_quote "$id")','acquired','$(sql_quote "$actor")',NULL,'$(sql_quote "$created")');
COMMIT;
SQL
  printf '%s\n' "$id"
}

heartbeat_locked() {
  local id="$1" actor="$2" status owner created
  status="$(job_field_locked "$id" status)"
  [[ "$status" == active ]] || die "只有 active 队列项可 heartbeat:$id status=${status:-missing}"
  owner="$(job_field_locked "$id" owner)"
  [[ "$owner" == "$actor" ]] || die "heartbeat owner 不匹配:$id owner=${owner:-missing} actor=$actor"
  created="$(now_iso)"
  sqlite3 "$QUEUE_DB" <<SQL
BEGIN IMMEDIATE;
UPDATE release_queue_jobs
   SET updated_at='$(sql_quote "$created")'
 WHERE id='$(sql_quote "$id")'
   AND status='active'
   AND owner='$(sql_quote "$actor")';
INSERT INTO release_queue_events(job_id,event,actor,detail,created_at)
VALUES
  ('$(sql_quote "$id")','heartbeat','$(sql_quote "$actor")',NULL,'$(sql_quote "$created")');
COMMIT;
SQL
  printf '%s\n' "$id"
}

pin_locked() {
  local id="$1" canonical_sha="$2" actor="$3" status requested created
  status="$(job_field_locked "$id" status)"
  [[ "$status" == active ]] || die "只有 active 队列项可 pin:$id status=${status:-missing}"
  requested="$(job_field_locked "$id" requested_sha)"
  git -C "$REPO_ROOT" merge-base --is-ancestor "$requested" "$canonical_sha" \
    || die "requested_sha 不是 canonical merge SHA 的祖先:$requested -> $canonical_sha"
  [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$canonical_sha" ]] \
    || die "canonical HEAD 未精确位于待 pin SHA:$canonical_sha"
  created="$(now_iso)"
  sqlite3 "$QUEUE_DB" <<SQL
BEGIN IMMEDIATE;
UPDATE release_queue_jobs
   SET canonical_sha='$(sql_quote "$canonical_sha")',
       pinned_at='$(sql_quote "$created")', updated_at='$(sql_quote "$created")'
 WHERE id='$(sql_quote "$id")' AND status='active';
INSERT INTO release_queue_events(job_id,event,actor,detail,created_at)
VALUES
  ('$(sql_quote "$id")','pinned','$(sql_quote "$actor")',
   'canonical_sha=$(sql_quote "$canonical_sha")','$(sql_quote "$created")');
COMMIT;
SQL
  printf '%s\n' "$canonical_sha"
}

pinned_sha_locked() {
  local id="$1" status pinned
  status="$(job_field_locked "$id" status)"
  [[ "$status" == active ]] || die "发布队列项不是 active:$id status=${status:-missing}"
  pinned="$(job_field_locked "$id" canonical_sha)"
  valid_sha "$pinned" || die "发布队列项尚未 pin canonical SHA:$id"
  printf '%s\n' "$pinned"
}

assert_locked() {
  local id="$1" current status pinned
  status="$(job_field_locked "$id" status)"
  [[ "$status" == active ]] || die "发布队列项不是 active:$id status=${status:-missing}"
  pinned="$(job_field_locked "$id" canonical_sha)"
  valid_sha "$pinned" || die "发布队列项尚未 pin canonical SHA:$id"
  current="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  # 2026-07-26 角色分离:此前这里要求 HEAD 与 pinned **逐字节相等**,而
  # $REPO_ROOT 这棵树同时承担两个互相冲突的角色 ——
  #   (a) 所有会话共享、随 base 不断 fast-forward 的开发 canonical checkout;
  #   (b) 必须钉死在 pinned SHA 上的生产发布源。
  # 于是任何人在你 active 期间合入一个 PR,你的 job 就作废;而它占着唯一 active 槽,
  # 别人 acquire 恒返回 75 —— 双向死锁,今天已真实发生一次。
  #
  # 根治不是"每次靠人记得别 ff",而是把角色 (b) 从工作树活状态里摘出来:
  # 判据改为 **pinned 必须是当前 HEAD 的祖先**(证明它确实已合入 canonical),
  # 而"发哪个 commit"由 deploy 侧显式按 pinned 取源(git archive <pinned>,
  # 不读工作树),见 deploy-v5.sh 的 resolve_release_source_commit。
  # 这样开发树可以自由前进,而发布内容仍被 pin 钉死。
  if [[ "$current" != "$pinned" ]]; then
    git -C "$REPO_ROOT" merge-base --is-ancestor "$pinned" "$current" 2>/dev/null \
      || die "pinned SHA 不在 canonical 历史里:queue=$pinned current=$current(pin 错了,或该 commit 尚未合入/已被改写)"
    printf '  · canonical 已前进(HEAD=%s),pinned=%s 仍是其祖先;发布内容按 pinned 取源\n' \
      "${current:0:12}" "${pinned:0:12}"
  fi
  printf '✓ V5 release queue active=%s canonical_sha=%s\n' "$id" "$pinned"
}

finish_locked() {
  local id="$1" result="$2" reason="$3" actor="$4" status created
  status="$(job_field_locked "$id" status)"
  [[ "$status" == active ]] || die "只有 active 队列项可完成:$id status=${status:-missing}"
  [[ -n "$(job_field_locked "$id" canonical_sha)" ]] \
    || die "未 pin canonical SHA 的队列项不能完成:$id"
  created="$(now_iso)"
  sqlite3 "$QUEUE_DB" <<SQL
BEGIN IMMEDIATE;
UPDATE release_queue_jobs
   SET status='completed', result='$(sql_quote "$result")', reason='$(sql_quote "$reason")',
       finished_at='$(sql_quote "$created")', updated_at='$(sql_quote "$created")'
 WHERE id='$(sql_quote "$id")' AND status='active';
INSERT INTO release_queue_events(job_id,event,actor,detail,created_at)
VALUES
  ('$(sql_quote "$id")','completed','$(sql_quote "$actor")',
   'result=$(sql_quote "$result") reason=$(sql_quote "$reason")','$(sql_quote "$created")');
COMMIT;
SQL
}

cancel_locked() {
  local id="$1" reason="$2" actor="$3" status created
  status="$(job_field_locked "$id" status)"
  [[ "$status" == queued ]] || die "只允许取消 queued 队列项:$id status=${status:-missing}"
  created="$(now_iso)"
  sqlite3 "$QUEUE_DB" <<SQL
BEGIN IMMEDIATE;
UPDATE release_queue_jobs
   SET status='cancelled', reason='$(sql_quote "$reason")',
       finished_at='$(sql_quote "$created")', updated_at='$(sql_quote "$created")'
 WHERE id='$(sql_quote "$id")' AND status='queued';
INSERT INTO release_queue_events(job_id,event,actor,detail,created_at)
VALUES
  ('$(sql_quote "$id")','cancelled','$(sql_quote "$actor")',
   'reason=$(sql_quote "$reason")','$(sql_quote "$created")');
COMMIT;
SQL
}

verify_local_deploy_lock() {
  local fd="$1" fd_id lock_id
  [[ "$fd" =~ ^[0-9]+$ && -e "/proc/self/fd/$fd" ]] \
    || die "abandon internal 未继承本地 deploy lock fd"
  fd_id="$(stat -L -c '%d:%i' "/proc/self/fd/$fd" 2>/dev/null || true)"
  lock_id="$(stat -L -c '%d:%i' "$DEPLOY_LOCK" 2>/dev/null || true)"
  [[ -n "$fd_id" && "$fd_id" == "$lock_id" ]] \
    || die "abandon internal 的锁 fd 与真实 DEPLOY_LOCK 不是同一 inode"
  grep -Eq '^lock:.*FLOCK[[:space:]]+ADVISORY[[:space:]]+WRITE' "/proc/self/fdinfo/$fd" \
    || die "abandon internal 的本地 deploy lock fd 未持有 flock"
}

probe_safe_stable_state() {
  local nonce="${OC_V5_MANUAL_LEASE_NONCE:-}"
  local proof="${OC_V5_MANUAL_LEASE_PROOF:-}"
  [[ "$nonce" =~ ^[0-9a-f]{32}$ && "$proof" == "$REMOTE_MANUAL_LEASE_PROOF" ]] \
    || die "缺少官方 wrapper 注入的 exact manual lease proof"
  ssh "$KL_HOST" bash -s -- "$MUTATION_MARKER" "$RECOVERY_MARKER" "$V5_ENV" \
    "$REMOTE_MUTATION_LOCK" "$REMOTE_MANUAL_LEASE_PROOF" "$nonce" <<'REMOTE'
set -euo pipefail
mutation_marker="$1"; recovery_marker="$2"; env_file="$3"
mutation_lock="$4"; proof="$5"; nonce="$6"
[[ "$nonce" =~ ^[0-9a-f]{32}$ ]]
[[ "$(cat "$proof" 2>/dev/null || true)" == "$nonce" ]]
exec 8>"$mutation_lock"
if flock -n 8; then
  flock -u 8
  exit 76
fi
test ! -e "$mutation_marker"
test ! -e "$recovery_marker"
set -a
. "$env_file"
state="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAq -c \
  "SELECT phase || '|' || coalesce(candidate_slot::text,'') || '|' || coalesce(candidate_release,'')
     FROM deploy_state WHERE singleton=true;")"
[[ "$state" == 'stable||' ]]
REMOTE
}

abandon_internal_locked() {
  local id="$1" result="$2" reason="$3" actor="$4" status created
  status="$(job_field_locked "$id" status)"
  [[ "$status" == active ]] || die "只有 active 队列项可 abandon:$id status=${status:-missing}"
  probe_safe_stable_state \
    || die "生产状态未证明 stable/candidate empty/markers absent；active 保持不变"
  created="$(now_iso)"
  sqlite3 "$QUEUE_DB" <<SQL
BEGIN IMMEDIATE;
UPDATE release_queue_jobs
   SET status='abandoned', result='$(sql_quote "$result")', reason='$(sql_quote "$reason")',
       finished_at='$(sql_quote "$created")', updated_at='$(sql_quote "$created")'
 WHERE id='$(sql_quote "$id")' AND status='active';
INSERT INTO release_queue_events(job_id,event,actor,detail,created_at)
VALUES
  ('$(sql_quote "$id")','abandoned','$(sql_quote "$actor")',
   'result=$(sql_quote "$result") reason=$(sql_quote "$reason")','$(sql_quote "$created")');
COMMIT;
SQL
}

status_locked() {
  local json="$1" output
  if [[ "$json" == 1 ]]; then
    output="$(sqlite3 -json "$QUEUE_DB" \
      "SELECT seq,id,task,branch,requested_sha,canonical_sha,status,owner,result,reason,
              created_at,activated_at,pinned_at,finished_at,updated_at
         FROM release_queue_jobs
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, seq;")"
    printf '%s\n' "${output:-[]}"
  else
    sqlite3 -header -column "$QUEUE_DB" \
      "SELECT seq,id,task,branch,substr(requested_sha,1,12) AS requested,
              substr(coalesce(canonical_sha,''),1,12) AS canonical,status,owner,result
         FROM release_queue_jobs
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, seq;"
  fi
}


heartbeat_pidfile() { printf '%s/%s.heartbeat.pid\n' "$QUEUE_RUN_DIR" "$1"; }
heartbeat_logfile() { printf '%s/%s.heartbeat.log\n' "$QUEUE_RUN_DIR" "$1"; }
heartbeat_metafile() { printf '%s/%s.heartbeat.meta\n' "$QUEUE_RUN_DIR" "$1"; }

read_pidfile_pid() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  awk -F= '/^pid=/{print $2; exit}' "$file"
}

daemon_process_alive() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null
}

reap_heartbeat_pidfile() {
  local id="$1" file pid
  file="$(heartbeat_pidfile "$id")"
  [[ -f "$file" ]] || return 0
  pid="$(read_pidfile_pid "$file" || true)"
  if [[ -n "$pid" ]] && daemon_process_alive "$pid"; then
    return 1
  fi
  rm -f "$file" "$(heartbeat_metafile "$id")"
  return 0
}

stop_heartbeat_daemon() {
  local id="$1" owner="${2:-}" file pid meta_owner
  file="$(heartbeat_pidfile "$id")"
  if [[ ! -f "$file" ]]; then
    echo "  · heartbeat daemon 未运行:$id"
    return 0
  fi
  if [[ -n "$owner" ]]; then
    meta_owner="$(awk -F= '/^owner=/{print $2; exit}' "$file" 2>/dev/null || true)"
    if [[ -n "$meta_owner" && "$meta_owner" != "$owner" ]]; then
      die "heartbeat daemon owner 不匹配:$id owner=$meta_owner actor=$owner"
    fi
  fi
  pid="$(read_pidfile_pid "$file" || true)"
  if [[ -n "$pid" ]] && daemon_process_alive "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
      daemon_process_alive "$pid" || break
      sleep 0.2
    done
    if daemon_process_alive "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$file" "$(heartbeat_metafile "$id")"
  echo "✓ heartbeat daemon 已停止:$id"
}

status_heartbeat_daemon() {
  local id="$1" file pid alive=0
  file="$(heartbeat_pidfile "$id")"
  if [[ ! -f "$file" ]]; then
    echo "heartbeat-daemon id=$id state=absent"
    return 0
  fi
  pid="$(read_pidfile_pid "$file" || true)"
  if [[ -n "$pid" ]] && daemon_process_alive "$pid"; then
    alive=1
  fi
  echo "heartbeat-daemon id=$id state=$([[ "$alive" == 1 ]] && echo running || echo stale-pidfile) pid=${pid:-none}"
  cat "$file"
  if [[ "$alive" != 1 ]]; then
    echo "  · pidfile 残留但进程已死;跑 heartbeat-daemon reap 清理"
    return 1
  fi
  return 0
}

reap_all_heartbeat_orphans() {
  mkdir -p "$QUEUE_RUN_DIR"
  local f id n=0
  for f in "$QUEUE_RUN_DIR"/rq-*.heartbeat.pid; do
    [[ -e "$f" ]] || continue
    id="$(basename "$f" .heartbeat.pid)"
    if reap_heartbeat_pidfile "$id"; then
      echo "  · reaped orphan $id"
      n=$((n + 1))
    fi
  done
  echo "✓ reap 完成 orphan_pidfiles=$n"
}

start_heartbeat_daemon() {
  local id="$1" owner="$2"
  local interval="${3:-$HEARTBEAT_INTERVAL}"
  local max_seconds="${4:-$HEARTBEAT_MAX_SECONDS}"
  local file pid
  [[ "$interval" =~ ^[1-9][0-9]*$ ]] || die "heartbeat interval 必须是正整数秒"
  [[ "$max_seconds" =~ ^[1-9][0-9]*$ ]] || die "heartbeat max-seconds 必须是正整数秒"
  (( interval < 60 )) || die "heartbeat interval 必须 < 60(禁止前台级长 sleep;守护进程也保持短间隔)"
  mkdir -p "$QUEUE_RUN_DIR"
  file="$(heartbeat_pidfile "$id")"
  if [[ -f "$file" ]]; then
    pid="$(read_pidfile_pid "$file" || true)"
    if [[ -n "$pid" ]] && daemon_process_alive "$pid"; then
      local meta_owner
      meta_owner="$(awk -F= '/^owner=/{print $2; exit}' "$file" 2>/dev/null || true)"
      [[ "$meta_owner" == "$owner" ]] \
        || die "heartbeat daemon 已由其他 owner 运行:$id owner=$meta_owner"
      echo "✓ heartbeat daemon 已在运行:$id pid=$pid(幂等)"
      printf '%s\n' "$pid"
      return 0
    fi
    reap_heartbeat_pidfile "$id" || true
  fi

  local log
  log="$(heartbeat_logfile "$id")"
  # setsid+nohup:与发起 agent 的 session/turn 脱钩。agent turn 结束、SSH 断开
  # 都不会带走守护进程;发布仍可在后台跑。被 kill 后不再 heartbeat,租约靠
  # updated_at 陈旧(HEARTBEAT_STALE_SECONDS)被其他会话识别,不自动 abandon。
  setsid nohup env \
    OC_V5_RELEASE_QUEUE_DB="$QUEUE_DB" \
    OC_V5_RELEASE_QUEUE_LOCK="$QUEUE_LOCK" \
    OC_V5_RELEASE_QUEUE_REPO_ROOT="$REPO_ROOT" \
    OC_V5_RELEASE_QUEUE_RUN_DIR="$QUEUE_RUN_DIR" \
    "$SELF" __heartbeat-loop --id "$id" --owner "$owner" \
      --interval "$interval" --max-seconds "$max_seconds" \
      --pidfile "$file" --logfile "$log" \
    </dev/null >>"$log" 2>&1 &
  pid=$!
  # 短等 pidfile 落盘(守护进程自己写,含 pid/owner/pgid)。
  local i
  for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [[ -f "$file" ]] && daemon_process_alive "$(read_pidfile_pid "$file" || true)"; then
      echo "✓ heartbeat daemon 已启动:$id pid=$(read_pidfile_pid "$file") log=$log"
      printf '%s\n' "$(read_pidfile_pid "$file")"
      return 0
    fi
    sleep 0.1
  done
  die "heartbeat daemon 启动后未写出存活 pidfile:$id(见 $log)"
}

usage() {
  cat <<'EOF'
Usage:
  v5-release-queue.sh submit --task T --branch B --sha SHA [--actor A]
  v5-release-queue.sh acquire --id ID --owner O [--daemon] [--interval SECONDS]
  v5-release-queue.sh heartbeat --id ID --owner O
  v5-release-queue.sh heartbeat-daemon start --id ID --owner O [--interval SECONDS] [--max-seconds N]
  v5-release-queue.sh heartbeat-daemon stop --id ID [--owner O]
  v5-release-queue.sh heartbeat-daemon status --id ID
  v5-release-queue.sh heartbeat-daemon reap
  v5-release-queue.sh release --id ID --owner O
  v5-release-queue.sh wait --id ID --owner O [--timeout SECONDS]
  v5-release-queue.sh pin --id ID --sha CANONICAL_SHA --actor A
  v5-release-queue.sh assert [--id ID]
  v5-release-queue.sh finish --id ID --result deployed|not-deployed --reason R --actor A
  v5-release-queue.sh cancel --id ID --reason R --actor A
  v5-release-queue.sh abandon-active --id ID --result deployed|not-deployed --reason R --operator O
  v5-release-queue.sh status [--json]

Heartbeat daemon:
  acquire --daemon 在取得 active 后用 setsid+nohup 拉起后台续租。
  agent 只需 acquire 一次、finish/release 一次;中间不要写 while true。
  守护进程与发起 session 脱钩:agent turn 结束、发布还在跑时续租继续。
  进程被 kill / 到达 --max-seconds 后停止续租,updated_at 超过
  OC_V5_HEARTBEAT_STALE_SECONDS(默认 180s)即视为陈旧;不自动 abandon。
  release = 只停守护进程,队列项保持 active(把收尾交给后续 turn / finish)。
EOF
}

need_tool sqlite3
need_tool flock

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage >&2; exit 2; }
shift

case "$command_name" in
  submit)
    task=""; branch=""; sha=""; actor="${USER:-unknown}"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --task) task="${2:-}"; shift 2 ;;
        --branch) branch="${2:-}"; shift 2 ;;
        --sha) sha="${2:-}"; shift 2 ;;
        --actor) actor="${2:-}"; shift 2 ;;
        *) die "submit 未知参数:$1" ;;
      esac
    done
    valid_label "$task" || die "非法 task:$task"
    valid_label "$branch" || die "非法 branch:$branch"
    valid_label "$actor" || die "非法 actor:$actor"
    sha="$(git -C "$REPO_ROOT" rev-parse "$sha^{commit}" 2>/dev/null || true)"
    valid_sha "$sha" || die "sha 不是本仓库 commit"
    with_queue_lock submit_locked "$task" "$branch" "$sha" "$actor"
    ;;
  acquire)
    id=""; owner=""; daemon=0; interval="$HEARTBEAT_INTERVAL"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        --owner) owner="${2:-}"; shift 2 ;;
        --daemon) daemon=1; shift ;;
        --interval) interval="${2:-}"; shift 2 ;;
        *) die "acquire 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "非法 id:$id"
    valid_label "$owner" || die "非法 owner:$owner"
    with_queue_lock acquire_locked "$id" "$owner"
    if [[ "$daemon" == 1 ]]; then
      start_heartbeat_daemon "$id" "$owner" "$interval"
    fi
    ;;
  heartbeat)
    id=""; owner=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        --owner) owner="${2:-}"; shift 2 ;;
        *) die "heartbeat 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "非法 id:$id"
    valid_label "$owner" || die "非法 owner:$owner"
    with_queue_lock heartbeat_locked "$id" "$owner"
    ;;
  wait)
    id=""; owner=""; timeout=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        --owner) owner="${2:-}"; shift 2 ;;
        --timeout) timeout="${2:-}"; shift 2 ;;
        *) die "wait 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "非法 id:$id"
    valid_label "$owner" || die "非法 owner:$owner"
    [[ "$timeout" =~ ^[0-9]+$ ]] || die "timeout 必须是非负整数秒"
    started="$SECONDS"
    while true; do
      if with_queue_lock acquire_locked "$id" "$owner"; then
        break
      else
        rc=$?
      fi
      [[ "$rc" == 75 ]] || exit "$rc"
      # 别人的 active 已经陈旧:再 sleep 也等不来 finish。禁止把 wait 变成第二种 while true。
      if with_queue_lock stale_foreign_active_locked "$id"; then
        echo "✗ wait 拒绝空转:挡住 $id 的是陈旧幽灵 active,不会自动消失。见上方 abandon-active 提示。" >&2
        exit 75
      fi
      (( timeout == 0 || SECONDS - started < timeout )) || exit 75
      sleep 2
    done
    ;;
  pin)
    id=""; sha=""; actor=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        --sha) sha="${2:-}"; shift 2 ;;
        --actor) actor="${2:-}"; shift 2 ;;
        *) die "pin 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "非法 id:$id"
    valid_label "$actor" || die "非法 actor:$actor"
    sha="$(git -C "$REPO_ROOT" rev-parse "$sha^{commit}" 2>/dev/null || true)"
    valid_sha "$sha" || die "非法 canonical sha"
    with_queue_lock pin_locked "$id" "$sha" "$actor"
    ;;
  assert)
    id="${OC_V5_RELEASE_QUEUE_ID:-}"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        *) die "assert 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "缺少/非法 OC_V5_RELEASE_QUEUE_ID:$id"
    with_queue_lock assert_locked "$id"
    ;;
  pinned-sha)
    # 只读:回显该 job 的 pinned canonical SHA(deploy 用它决定"发哪个 commit")。
    # 与 assert 分开是因为 deploy 需要**取值**而不只是判定,且这里不做 HEAD 比较 ——
    # HEAD 是共享开发树的活状态,不该参与"发什么"的裁决。
    id="${OC_V5_RELEASE_QUEUE_ID:-}"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        *) die "pinned-sha 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "缺少/非法 OC_V5_RELEASE_QUEUE_ID:$id"
    with_queue_lock pinned_sha_locked "$id"
    ;;
  finish)
    id=""; result=""; reason=""; actor=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        --result) result="${2:-}"; shift 2 ;;
        --reason) reason="${2:-}"; shift 2 ;;
        --actor) actor="${2:-}"; shift 2 ;;
        *) die "finish 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "非法 id:$id"
    [[ "$result" == deployed || "$result" == not-deployed ]] || die "非法 result:$result"
    [[ -n "$reason" ]] || die "reason 不能为空"
    valid_label "$actor" || die "非法 actor:$actor"
    stop_heartbeat_daemon "$id" "$actor" || true
    with_queue_lock finish_locked "$id" "$result" "$reason" "$actor"
    ;;
  cancel)
    id=""; reason=""; actor=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        --reason) reason="${2:-}"; shift 2 ;;
        --actor) actor="${2:-}"; shift 2 ;;
        *) die "cancel 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "非法 id:$id"
    [[ -n "$reason" ]] || die "reason 不能为空"
    valid_label "$actor" || die "非法 actor:$actor"
    stop_heartbeat_daemon "$id" "$actor" || true
    with_queue_lock cancel_locked "$id" "$reason" "$actor"
    ;;
  abandon-active)
    id=""; result=""; reason=""; operator=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        --result) result="${2:-}"; shift 2 ;;
        --reason) reason="${2:-}"; shift 2 ;;
        --operator) operator="${2:-}"; shift 2 ;;
        *) die "abandon-active 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "非法 id:$id"
    [[ "$result" == deployed || "$result" == not-deployed ]] || die "非法 result:$result"
    [[ -n "$reason" ]] || die "reason 不能为空"
    valid_label "$operator" || die "非法 operator:$operator"
    [[ -x "$LEASE_WRAPPER" ]] || die "官方 production mutation lease wrapper 不可执行:$LEASE_WRAPPER"
    [[ "${OC_V5_SKIP_MUTATION_LEASE:-0}" != 1 ]] \
      || die "abandon-active 禁止 OC_V5_SKIP_MUTATION_LEASE=1；active 保持不变"
    stop_heartbeat_daemon "$id" "$operator" || true
    mkdir -p "$(dirname "$DEPLOY_LOCK")"
    exec 211>"$DEPLOY_LOCK"
    flock -w 900 211 || die "900s 未取得本地 deploy lock；active 保持不变"
    env -u OC_V5_SKIP_MUTATION_LEASE \
      OC_V5_RELEASE_QUEUE_INTERNAL=1 OC_V5_RELEASE_QUEUE_DEPLOY_LOCK_FD=211 \
      "$LEASE_WRAPPER" "$SELF" __abandon-internal "$id" "$result" "$reason" "$operator"
    ;;
  __abandon-internal)
    [[ "${OC_V5_RELEASE_QUEUE_INTERNAL:-0}" == 1 ]] || die "internal command 不允许直接调用"
    [[ $# == 4 ]] || die "internal 参数数量错误"
    verify_local_deploy_lock "${OC_V5_RELEASE_QUEUE_DEPLOY_LOCK_FD:-}"
    with_queue_lock abandon_internal_locked "$1" "$2" "$3" "$4"
    ;;
  release)
    id=""; owner=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        --owner) owner="${2:-}"; shift 2 ;;
        *) die "release 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "非法 id:$id"
    valid_label "$owner" || die "非法 owner:$owner"
    stop_heartbeat_daemon "$id" "$owner"
    echo "✓ release:heartbeat 已停,队列项 $id 仍保持原 status(收尾请 finish/abandon)"
    ;;
  heartbeat-daemon)
    sub="${1:-}"; shift || true
    case "$sub" in
      start)
        id=""; owner=""; interval="$HEARTBEAT_INTERVAL"; max_seconds="$HEARTBEAT_MAX_SECONDS"
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --id) id="${2:-}"; shift 2 ;;
            --owner) owner="${2:-}"; shift 2 ;;
            --interval) interval="${2:-}"; shift 2 ;;
            --max-seconds) max_seconds="${2:-}"; shift 2 ;;
            *) die "heartbeat-daemon start 未知参数:$1" ;;
          esac
        done
        valid_id "$id" || die "非法 id:$id"
        valid_label "$owner" || die "非法 owner:$owner"
        start_heartbeat_daemon "$id" "$owner" "$interval" "$max_seconds"
        ;;
      stop)
        id=""; owner=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --id) id="${2:-}"; shift 2 ;;
            --owner) owner="${2:-}"; shift 2 ;;
            *) die "heartbeat-daemon stop 未知参数:$1" ;;
          esac
        done
        valid_id "$id" || die "非法 id:$id"
        stop_heartbeat_daemon "$id" "$owner"
        ;;
      status)
        id=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --id) id="${2:-}"; shift 2 ;;
            *) die "heartbeat-daemon status 未知参数:$1" ;;
          esac
        done
        valid_id "$id" || die "非法 id:$id"
        status_heartbeat_daemon "$id"
        ;;
      reap)
        reap_all_heartbeat_orphans
        ;;
      *)
        die "heartbeat-daemon 未知子命令:${sub:-missing}(start|stop|status|reap)"
        ;;
    esac
    ;;
  __heartbeat-loop)
    id=""; owner=""; interval="$HEARTBEAT_INTERVAL"; max_seconds="$HEARTBEAT_MAX_SECONDS"
    pidfile=""; logfile=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        --owner) owner="${2:-}"; shift 2 ;;
        --interval) interval="${2:-}"; shift 2 ;;
        --max-seconds) max_seconds="${2:-}"; shift 2 ;;
        --pidfile) pidfile="${2:-}"; shift 2 ;;
        --logfile) logfile="${2:-}"; shift 2 ;;
        *) die "internal heartbeat-loop 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "非法 id:$id"
    valid_label "$owner" || die "非法 owner:$owner"
    [[ -n "$pidfile" ]] || die "internal heartbeat-loop 缺 --pidfile"
    mkdir -p "$(dirname "$pidfile")"
    # 先写 pidfile 再进入循环,让 start 能探测到存活。
    cat >"$pidfile" <<META
pid=$$
pgid=$$
id=$id
owner=$owner
interval=$interval
max_seconds=$max_seconds
started=$(now_iso)
META
    cleanup_loop() {
      rm -f "$pidfile"
      echo "$(now_iso) heartbeat-loop exit id=$id owner=$owner" >>"${logfile:-/dev/null}"
    }
    trap cleanup_loop EXIT
    trap 'exit 0' TERM INT
    deadline=$((SECONDS + max_seconds))
    while (( SECONDS < deadline )); do
      if ! with_queue_lock heartbeat_locked "$id" "$owner"; then
        echo "$(now_iso) heartbeat 停止:队列项不再 active 或 owner 不匹配" >>"${logfile:-/dev/null}"
        exit 0
      fi
      # 短睡;到点或被 signal 打断即退出。不用 sleep>=60,也不用 while true。
      remaining=$((deadline - SECONDS))
      (( remaining > 0 )) || break
      chunk="$interval"
      (( chunk <= remaining )) || chunk=$remaining
      sleep "$chunk" || true
    done
    echo "$(now_iso) heartbeat-loop 到达 max-seconds=$max_seconds,自然退出(租约将陈旧)" >>"${logfile:-/dev/null}"
    ;;
  status)
    json=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --json) json=1; shift ;;
        *) die "status 未知参数:$1" ;;
      esac
    done
    with_queue_lock status_locked "$json"
    if [[ "$json" != 1 ]]; then
      stale="$(sqlite3 -noheader "$QUEUE_DB"         "SELECT id FROM release_queue_jobs
          WHERE status='active'
            AND updated_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-${HEARTBEAT_STALE_SECONDS} seconds');" 2>/dev/null || true)"
      if [[ -n "$stale" ]]; then
        echo "⚠ stale active(updated_at > ${HEARTBEAT_STALE_SECONDS}s): $stale"
      fi
    fi
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    die "未知命令:$command_name"
    ;;
esac
