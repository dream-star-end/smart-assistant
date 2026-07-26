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
    echo "⏳ 当前发布项仍在执行:$active" >&2
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

usage() {
  cat <<'EOF'
Usage:
  v5-release-queue.sh submit --task T --branch B --sha SHA [--actor A]
  v5-release-queue.sh acquire --id ID --owner O
  v5-release-queue.sh wait --id ID --owner O [--timeout SECONDS]
  v5-release-queue.sh pin --id ID --sha CANONICAL_SHA --actor A
  v5-release-queue.sh assert [--id ID]
  v5-release-queue.sh finish --id ID --result deployed|not-deployed --reason R --actor A
  v5-release-queue.sh cancel --id ID --reason R --actor A
  v5-release-queue.sh abandon-active --id ID --result deployed|not-deployed --reason R --operator O
  v5-release-queue.sh status [--json]
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
    id=""; owner=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 ;;
        --owner) owner="${2:-}"; shift 2 ;;
        *) die "acquire 未知参数:$1" ;;
      esac
    done
    valid_id "$id" || die "非法 id:$id"
    valid_label "$owner" || die "非法 owner:$owner"
    with_queue_lock acquire_locked "$id" "$owner"
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
  status)
    json=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --json) json=1; shift ;;
        *) die "status 未知参数:$1" ;;
      esac
    done
    with_queue_lock status_locked "$json"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    die "未知命令:$command_name"
    ;;
esac
