#!/usr/bin/env bash
# v5-lease-lib.sh — selfhost 共享资源租约中心(Lease Center)公共库。
#
# 被 oc-lease.sh(agent 入口)、v5-lease-worker.sh(守护)、deploy-v5-selfhost.sh(执行器)source。
# 设计:generated/ocv5-lease-center/design-v2.md(OCV5-131)。
#
# 原则:
#   - 所有写都在 BEGIN IMMEDIATE 短事务里;状态迁移与 outbox 插入同事务(不丢通知)。
#   - 网络/子进程调用一律放事务外。
#   - 超时判定只用 sqlite 的 strftime('now')(单一时钟源),不信任调用方时间。
#   - 本库不持 deploy.lock;发车方自己拿 flock 并传给执行器继承。
#
# 与商业版 v5-release-queue.sh 完全独立(不同 db、不同锁)。

[[ -n "${__OC_LEASE_LIB_LOADED:-}" ]] && return 0
__OC_LEASE_LIB_LOADED=1

LEASE_DB="${OC_V5_LEASE_DB:-/var/lib/openclaude-v5-selfhost/lease.db}"
LEASE_LOCK="${OC_V5_LEASE_LOCK:-/run/openclaude-v5-selfhost/lease-db.lock}"
LEASE_REPO_ROOT="${OC_V5_LEASE_REPO_ROOT:-/opt/openclaude/openclaude-v5-selfhost}"
LEASE_BRANCH="${OC_V5_LEASE_BRANCH:-feat/v5-selfhost}"
LEASE_LIVE_LINK="${OC_V5_LEASE_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}"
LEASE_SURVIVOR_STATE="${OC_V5_LEASE_SURVIVOR_STATE:-/run/openclaude-v5-selfhost/cutover-survivor.state}"
LEASE_SURVIVOR_COMMITTED="${OC_V5_LEASE_SURVIVOR_COMMITTED:-/run/openclaude-v5-selfhost/cutover-survivor.committed}"
LEASE_DEPLOY_LOCK="${OC_V5_SELFHOST_DEPLOY_LOCK:-/run/openclaude-v5-selfhost/deploy.lock}"
LEASE_CUTOVER_GRACE_FILE="${OC_V5_LEASE_CUTOVER_GRACE_FILE:-/run/openclaude-v5-selfhost/cutover-grace-until}"
LEASE_RIDE_ALERT_SECONDS="${OC_V5_LEASE_RIDE_ALERT_SECONDS:-21600}"      # ride 6h 未结算 → 面板告警(不过期)
LEASE_GRANT_ACK_SECONDS="${OC_V5_LEASE_GRANT_ACK_SECONDS:-600}"          # drive:granted 后 10min 内必须 heartbeat
LEASE_HEARTBEAT_STALE_SECONDS="${OC_V5_LEASE_HEARTBEAT_STALE_SECONDS:-180}"
LEASE_NOTIFY_DEADLINE_SECONDS="${OC_V5_LEASE_NOTIFY_DEADLINE_SECONDS:-86400}"
LEASE_TRAIN_PLANNED_STALE_SECONDS="${OC_V5_LEASE_TRAIN_PLANNED_STALE_SECONDS:-120}"  # planned 无 pid 超此 → failed

lease_die() { echo "✗ $*" >&2; exit 2; }
lease_warn() { echo "⚠ $*" >&2; }
lease_need_tool() { command -v "$1" >/dev/null 2>&1 || lease_die "缺少必需命令:$1"; }
lease_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
lease_q() { printf "%s" "${1//\'/\'\'}"; }
lease_valid_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
lease_valid_id() { [[ "$1" =~ ^ls-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]]; }
lease_valid_train_id() { [[ "$1" =~ ^tr-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]]; }
lease_valid_label() { [[ -n "$1" && ${#1} -le 200 && "$1" =~ ^[A-Za-z0-9._/@:+-]+$ ]]; }
lease_valid_resource() { [[ "$1" =~ ^[a-z][a-z0-9-]*:[A-Za-z0-9._-]+$ ]]; }
lease_new_id() { printf '%s-%s-%s' "$1" "$(date -u +%Y%m%dT%H%M%SZ)" "$(openssl rand -hex 6)"; }

# transport_id 必须满足 protocol isClientMessageId ^[A-Za-z0-9_-]{1,128}$(冒号不行)。
lease_transport_id() { # <outbox-db-key>
  printf 'lsc-%s' "$(printf '%s' "$1" | sha256sum | cut -c1-24)"
}

lease_sql() { # 只读/单语句;带 busy_timeout
  sqlite3 -cmd '.timeout 5000' -noheader "$LEASE_DB" "$@"
}
lease_sql_json() {
  sqlite3 -cmd '.timeout 5000' -json "$LEASE_DB" "$@"
}
# 事务脚本从 stdin 读;失败返回非 0 且不做任何授权/发车。
lease_tx() {
  sqlite3 -cmd '.timeout 5000' "$LEASE_DB"
}

lease_init_db() {
  lease_need_tool sqlite3
  mkdir -p "$(dirname "$LEASE_DB")"
  sqlite3 "$LEASE_DB" >/dev/null <<'SQL'
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS lease (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  resource TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('ride','drive')),
  status TEXT NOT NULL CHECK(status IN ('registered','granted','satisfied','done','revoked','cancelled','failed')),
  epoch INTEGER NOT NULL DEFAULT 0,
  owner TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  callback_session_key TEXT,
  callback_agent_id TEXT NOT NULL DEFAULT 'main',
  want_sha TEXT,
  ticket_ref TEXT,
  grant_ack_until TEXT,
  heartbeat_at TEXT,
  notify_deadline TEXT,
  last_alert_at TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS lease_one_granted_per_resource
  ON lease(resource) WHERE status = 'granted';
CREATE INDEX IF NOT EXISTS lease_open ON lease(resource, status);

CREATE TABLE IF NOT EXISTS train (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  resource TEXT NOT NULL,
  target_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned','building','cutover','committed','failed','recovery_required')),
  owner TEXT NOT NULL,
  executor_pid INTEGER,
  rel_path TEXT,
  log_path TEXT,
  evidence_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS train_one_open_per_resource
  ON train(resource) WHERE status NOT IN ('committed','failed');

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  transport_id TEXT NOT NULL UNIQUE,
  lease_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('satisfied','granted','revoked','failed','alert','train_alert')),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('session','ticket','log')),
  target TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','delivered','fallback_ticket','expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  deadline TEXT,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id TEXT NOT NULL,
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
SQL
  chmod 600 "$LEASE_DB" 2>/dev/null || true
}

# 进程级互斥(与 sqlite 锁叠加,防多进程同时建表/迁移;fd 211)。
lease_with_lock() {
  mkdir -p "$(dirname "$LEASE_LOCK")" 2>/dev/null || true
  exec 211>"$LEASE_LOCK"
  flock -w 30 211 || lease_die "lease-db.lock 30s 内未取得"
  lease_init_db
  "$@"
  local rc=$?
  flock -u 211
  return $rc
}

lease_field() { # <id> <field>
  lease_sql "SELECT $2 FROM lease WHERE id='$(lease_q "$1")' LIMIT 1;"
}
train_field() { # <id> <field>
  lease_sql "SELECT $2 FROM train WHERE id='$(lease_q "$1")' LIMIT 1;"
}

# 事件行(在事务内调用者自行拼 SQL;这里给独立写法)。
lease_event_sql() { # <subject> <event> <actor> <detail>
  printf "INSERT INTO event(subject_id,event,actor,detail,created_at) VALUES('%s','%s','%s','%s','%s');" \
    "$(lease_q "$1")" "$(lease_q "$2")" "$(lease_q "$3")" "$(lease_q "$4")" "$(lease_now)"
}

# outbox 插入 SQL 片段(供同事务使用)。target_kind: session|ticket|log。
lease_outbox_sql() { # <db-key> <lease_id> <kind> <target_kind> <target> <body>
  local key="$1" tid
  tid="$(lease_transport_id "$key")"
  printf "INSERT OR IGNORE INTO outbox(id,transport_id,lease_id,kind,target_kind,target,body,status,attempts,next_attempt_at,deadline,created_at)
VALUES('%s','%s','%s','%s','%s','%s','%s','pending',0,strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ','now'),
       strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ','now','+%d seconds'),'%s');" \
    "$(lease_q "$key")" "$tid" "$(lease_q "$2")" "$(lease_q "$3")" "$(lease_q "$4")" \
    "$(lease_q "$5")" "$(lease_q "$6")" "$LEASE_NOTIFY_DEADLINE_SECONDS" "$(lease_now)"
}

# 决定某 lease 的回调落点:有 session key → session;否则有 ticket → ticket;否则 log。
lease_callback_target() { # <lease_id> → 打印 "kind\ttarget"
  local id="$1" sk tk
  sk="$(lease_field "$id" callback_session_key)"
  tk="$(lease_field "$id" ticket_ref)"
  if [[ -n "$sk" ]]; then printf 'session\t%s\n' "$sk"
  elif [[ -n "$tk" ]]; then printf 'ticket\t%s\n' "$tk"
  else printf 'log\t-\n'; fi
}

# ---------- 权威事实读取(只读) ----------

# live 当前 sourceCommit;survivor 未 committed 时返回空(不可据以结算)。
lease_live_committed_sha() {
  local live sha
  [[ -L "$LEASE_LIVE_LINK" ]] || return 1
  live="$(readlink -f -- "$LEASE_LIVE_LINK" 2>/dev/null || true)"
  [[ -n "$live" && -f "$live/.complete" ]] || return 1
  sha="$(jq -er '.sourceCommit | select(test("^[0-9a-f]{40}$"))' "$live/.complete" 2>/dev/null || true)"
  [[ -n "$sha" ]] || return 1
  # survivor 处于未提交 mutation 中(armed/pre-install/pre-mutation/mutating/...)→ 不结算。
  if [[ -f "$LEASE_SURVIVOR_STATE" && ! -L "$LEASE_SURVIVOR_STATE" ]]; then
    local phase
    phase="$(jq -er '.phase // empty' "$LEASE_SURVIVOR_STATE" 2>/dev/null || sed -n 's/^phase=//p' "$LEASE_SURVIVOR_STATE" 2>/dev/null | head -1)"
    case "${phase:-}" in
      ''|armed|pre-install|pre-mutation|smoked|committed) ;;
      *) return 1 ;;
    esac
  fi
  printf '%s\n' "$sha"
}

lease_live_rel_path() { readlink -f -- "$LEASE_LIVE_LINK" 2>/dev/null || true; }

# cutover grace 是否仍在窗口内。文件在每次切流后都会留着(watch.sh 用绝对到期时间),
# 内容 until=<epoch>;存在但已过期 = 不在窗口。无法解析时保守视为在窗口。
lease_in_cutover_grace() {
  [[ -f "$LEASE_CUTOVER_GRACE_FILE" && ! -L "$LEASE_CUTOVER_GRACE_FILE" ]] || return 1
  local until
  until="$(sed -n 's/^until=\([0-9]\{9,11\}\)$/\1/p' "$LEASE_CUTOVER_GRACE_FILE" 2>/dev/null | head -1)"
  [[ -n "$until" ]] || return 0
  (( $(date -u +%s) < until ))
}

# want 是否已包含在 base 中(祖先或相等)。
lease_sha_contained() { # <want> <base>
  git -C "$LEASE_REPO_ROOT" merge-base --is-ancestor "$1" "$2" 2>/dev/null
}

lease_remote_tip() {
  git -C "$LEASE_REPO_ROOT" rev-parse --verify -q "refs/remotes/origin/${LEASE_BRANCH}" 2>/dev/null
}

# 是否有真正的 deploy 执行器在跑。只认 argv 精确形态(argv[i] 以 deploy-v5-selfhost.sh 结尾且下一个是 --deploy/--cutover/--bootstrap),
# 不做 cmdline 子串匹配:否则任何 `bash -c "... deploy-v5-selfhost.sh --deploy ..."`(比如别的会话在 grep 日志)都会误判成在飞。
lease_deploy_process_running() {
  local p
  for p in /proc/[0-9]*; do
    [[ -r "$p/cmdline" ]] || continue
    local -a argv=(); mapfile -d '' -t argv <"$p/cmdline" 2>/dev/null || continue
    local i n=${#argv[@]}
    for (( i=0; i<n-1; i++ )); do
      case "${argv[i]}" in
        */deploy-v5-selfhost.sh|deploy-v5-selfhost.sh)
          case "${argv[i+1]}" in --deploy|--cutover|--bootstrap) return 0 ;; esac ;;
      esac
    done
  done
  return 1
}

# 僵尸(容器内无 reaper 时会出现)视为已死。
lease_pid_alive() {
  [[ -n "$1" && "$1" != 0 ]] || return 1     # kill -0 0 会打到整个进程组,必须挡掉
  kill -0 "$1" 2>/dev/null || return 1
  local st; st="$(awk '/^State:/{print $2}' "/proc/$1/status" 2>/dev/null || true)"
  [[ "$st" != Z ]]
}

# ---------- 回调正文模板(冻结进 outbox,零调查) ----------

lease_body_satisfied() { # <lease_id> <want_sha> <rel> <live_sha> <same_train_shas>
  cat <<EOF
🎫 lease $1(deploy:selfhost/ride)已满足 — 你的 ${2:0:7} 已在线
- live: $3
- sourceCommit: ${4:0:12}(survivor committed,smoke 已过)
- 本班同车: $5
- 容器 runtime 需下次 provision 才吃到(现网 idleSweep 关);容器侧生效请另走 recycle
下一步:按 v5-selfhost-post-deploy-verify 做只读核验 → 收口本单。**不要重新发布,不要再订 reminder。**
EOF
}

lease_body_failed() { # <lease_id> <reason> <evidence>
  cat <<EOF
🎫 lease $1(deploy:selfhost/ride)失败
- 原因: $2
- 证据: $3
下一步:读证据判断是列车本身失败(可重新 register 搭下一班)还是需人工恢复(train recovery_required,禁止自动重发)。
EOF
}

lease_body_alert() { # <lease_id> <age_h> <blocker>
  cat <<EOF
⏰ lease $1(deploy:selfhost/ride)已等待 ${2}h 未结算
- 阻塞: $3
- lease 不会过期,会继续等;如已不需要请 \`oc-lease cancel --id $1\`。
EOF
}

lease_body_train_alert() { # <train_id> <status> <reason>
  cat <<EOF
🚨 train $1 进入 $2
- 原因: $3
- 发车已暂停(open train 占位)。人工确认 survivor 状态后:\`oc-lease train resolve --id $1 --as committed|failed --reason ...\`
EOF
}
