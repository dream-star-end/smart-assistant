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

-- Lifetime budget: manual registrations never delete or reset this row.
CREATE TABLE IF NOT EXISTS train_auto_retry (
  resource TEXT NOT NULL,
  target_sha TEXT NOT NULL,
  source_train_id TEXT NOT NULL,
  source_sha TEXT NOT NULL,
  retry_train_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'running' CHECK(result IN ('running','committed','failed','recovery_required')),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY(resource,target_sha)
);
CREATE TABLE IF NOT EXISTS train_retry_alert (
  train_id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

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
# A context is a durable unresolved-operation barrier. Only reliable ENOENT
# clears it; damaged data, links, permissions and probe errors retain the hold.
lease_release_policy_held() {
  ! python3 - "${OC_V5_RELEASE_POLICY_CONTEXT:-/var/lib/openclaude-v5-selfhost/release-policy/unresolved.json}" <<'LP_PRESENCE'
import os,sys,pathlib
q=pathlib.PurePath(sys.argv[1])
if not q.is_absolute() or ".." in q.parts:sys.exit(2)
try:os.lstat(q)
except FileNotFoundError:sys.exit(0)
except OSError:sys.exit(1)
sys.exit(1)
LP_PRESENCE
}

lease_live_committed_sha() {
  lease_release_policy_held && return 1
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
  lease_policy_current_live_accepted "$sha" "$live" || return 1
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
下一步:读证据判断是列车本身失败(修复后 push 新 tip 再 register)还是现场问题(train recovery_required 由 autorecover 自动恢复、重跑,超限会开工单派给 AI)。
EOF
}

lease_body_alert() { # <lease_id> <age_h> <blocker>
  cat <<EOF
⏰ lease $1(deploy:selfhost/ride)已等待 ${2}h 未结算
- 阻塞: $3
- lease 不会过期,会继续等;如已不需要请 \`oc-lease cancel --id $1\`。
EOF
}

lease_body_ff_blocked() { # <repo> <head> <tip> <why>
  cat <<EOF
🚨 发版主工作树无法快进到 origin tip ${3:0:12}(HEAD ${2:0:12})
- 工作树: $1
- 原因: $4
- worker 只做 fast-forward,不会 reset/覆盖;本 tick 不发车。人工把工作树对齐后,下一个 tick 自动发车。
EOF
}

lease_body_train_alert() { # <train_id> <status> <reason>
  cat <<EOF
🚨 train $1 进入 $2
- 原因: $3
- 发车暂停(open train 占位)。autorecover(OCV5-420)确认现场稳定绿后自动结束本班并重跑;兜底失败或超时自动开工单派给 AI。无需人工。
EOF
}

# Session callback transport shared by registration validation and delivery.
# Never source the full secrets env or leak its contents into logs/argv.
lease_callback_post() { # <suffix: empty|/validate> <json>
  local url="${OC_V5_LEASE_CALLBACK_URL:-http://127.0.0.1:18894/internal/v3/lease-callback}" secret
  [[ "$url" =~ ^http://(127\.0\.0\.1|\[::1\]):[0-9]+/internal/v3/lease-callback$ ]] || {
    echo 'invalid callback URL (direct loopback control endpoint required)' >&2; return 2;
  }
  secret="$(sed -nE 's/^OC_LEASE_CALLBACK_SECRET="?([0-9a-f]{64})"?$/\1/p' "${OC_V5_LEASE_CALLBACK_SECRET_FILE:-/etc/openclaude/commercial-v5-selfhost.env}" 2>/dev/null | head -1)"
  [[ -n "$secret" ]] || { echo 'missing/invalid OC_LEASE_CALLBACK_SECRET (64 lowercase hex)' >&2; return 2; }
  printf '%s' "$2" | curl --noproxy '*' -sS -m 20 \
    --config <(printf 'header = "X-OC-Lease-Secret: %s"\n' "$secret") \
    -H 'Content-Type: application/json' -w '\n%{http_code}' --data-binary @- "$url$1"
}

# Selfhost-only, explicit exact-source permission to interrupt user turns.
lease_inflight_views_sql() {
  cat <<'SQL'
CREATE TEMP VIEW _li_open AS SELECT *, CASE
 WHEN json_type(doc,'$.request.cutover') IS NULL THEN 'wait'
 WHEN json_type(doc,'$.request.cutover')='object'
  AND json_type(doc,'$.request.cutover.schema')='integer'
  AND json_extract(doc,'$.request.cutover.schema')=1
  AND json_type(doc,'$.request.cutover.allowInflight')='true'
  AND json_type(doc,'$.request.cutover.sourceSha')='text'
  AND json_extract(doc,'$.request.cutover.sourceSha')=want_sha
  AND (SELECT count(*) FROM json_each(doc,'$.request.cutover'))=3
 THEN 'allow' ELSE 'invalid' END AS inflight_mode FROM _lp_open;
INSERT INTO _lp_guard SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM _li_open WHERE inflight_mode='invalid') THEN 1 ELSE 0 END;
SQL
}

lease_inflight_bind_sql() { # train_id target_sha actor; worker creation or locked executor adoption
  local iq tq aq nowq
  lease_valid_train_id "$1" && lease_valid_sha "$2" || return 2
  iq="$(lease_q "$1")"; tq="$(lease_q "$2")"; aq="$(lease_q "$3")"; nowq="$(lease_q "$(lease_now)")"
  lease_inflight_views_sql
  cat <<SQL
INSERT INTO _lp_guard SELECT CASE WHEN
 (SELECT count(*) FROM train WHERE id='$iq' AND resource='deploy:selfhost'
  AND target_sha='$tq' AND status IN ('planned','building'))=1 THEN 1 ELSE 0 END;
INSERT INTO _lp_guard SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM _li_open WHERE status='registered' AND inflight_mode='allow'
  AND want_sha<>'$tq') AND
 (SELECT count(DISTINCT inflight_mode) FROM _li_open WHERE status='registered')<=1
 THEN 1 ELSE 0 END;
CREATE TEMP TABLE _li_selected AS SELECT id,seq FROM _li_open
 WHERE status='registered' AND inflight_mode='allow';
CREATE TEMP TABLE _li_expected AS SELECT json_object('schema',1,'sourceSha','$tq',
 'allowInflight',json('true'),'leaseIds',json((SELECT json_group_array(id)
 FROM (SELECT id FROM _li_selected ORDER BY seq)))) AS doc
 WHERE EXISTS(SELECT 1 FROM _li_selected);
INSERT INTO _lp_guard SELECT CASE WHEN
 json_type(COALESCE(evidence_json,'{}'),'$.cutover') IS NULL OR
 (json_type(evidence_json,'$.cutover')='object' AND
  json(json_extract(evidence_json,'$.cutover'))=(SELECT json(doc) FROM _li_expected))
 THEN 1 ELSE 0 END FROM train WHERE id='$iq';
UPDATE train SET evidence_json=json_set(COALESCE(evidence_json,'{}'),'$.cutover',
 json((SELECT doc FROM _li_expected))) WHERE id='$iq'
 AND json_type(COALESCE(evidence_json,'{}'),'$.cutover') IS NULL
 AND EXISTS(SELECT 1 FROM _li_expected);
INSERT INTO event(subject_id,event,actor,detail,created_at)
 SELECT '$iq','cutover-inflight-allowed','$aq','--allow-inflight sha=$tq','$nowq'
 WHERE changes()=1;
SQL
}

lease_inflight_train_allowed() { # validate frozen snapshot and original requests; no writes
  local iq tq doc ids expected actual
  lease_valid_train_id "$1" && lease_valid_sha "$2" || return 1
  iq="$(lease_q "$1")"; tq="$(lease_q "$2")"
  doc="$(lease_sql "SELECT json_extract(evidence_json,'$.cutover') FROM train
   WHERE id='$iq' AND resource='deploy:selfhost' AND target_sha='$tq'
    AND status IN ('planned','building','smoked')
    AND json_type(evidence_json,'$.cutover.schema')='integer';")" || return 1
  [[ -n "$doc" ]] || return 1
  jq -e --arg sha "$2" '
   type=="object" and keys==["allowInflight","leaseIds","schema","sourceSha"]
   and .schema==1 and .allowInflight==true and .sourceSha==$sha
   and (.leaseIds|type)=="array" and (.leaseIds|length)>0
   and all(.leaseIds[];type=="string")
   and (.leaseIds|length)==(.leaseIds|unique|length)' <<<"$doc" >/dev/null || return 1
  ids="$(jq -c .leaseIds <<<"$doc")"; expected="$(jq -r '.leaseIds|length' <<<"$doc")"
  actual="$(lease_sql "SELECT count(*) FROM lease WHERE resource='deploy:selfhost'
   AND mode='ride' AND want_sha='$tq' AND status='registered'
   AND id IN (SELECT value FROM json_each('$(lease_q "$ids")'))
   AND json_type(result_json,'$.request.cutover')='object'
   AND json_type(result_json,'$.request.cutover.schema')='integer'
   AND json_extract(result_json,'$.request.cutover.schema')=1
   AND json_type(result_json,'$.request.cutover.allowInflight')='true'
   AND json_extract(result_json,'$.request.cutover.sourceSha')='$tq'
   AND (SELECT count(*) FROM json_each(result_json,'$.request.cutover'))=3;")" || return 1
  [[ "$actual" == "$expected" ]]
}

# Explicit per-target release policy transport, on existing JSON metadata.
lease_policy_views_sql() { # resource
  local resource_q; resource_q="$(lease_q "$1")"
  cat <<SQL
CREATE TEMP TABLE _lp_guard(ok INTEGER NOT NULL CHECK(ok=1));
CREATE TEMP VIEW _lp_open AS
WITH docs AS (
 SELECT seq,id,resource,mode,status,owner,owner_uid,want_sha,
        COALESCE(result_json,'{}') AS doc
 FROM lease WHERE resource='$resource_q' AND mode='ride'
   AND status IN ('registered','granted')
)
SELECT *, CASE
 WHEN json_valid(doc)<>1 THEN 'invalid'
 WHEN json_type(doc)<>'object' THEN 'invalid'
 WHEN json_type(doc,'$.request.releasePolicy') IS NULL THEN
   CASE WHEN json_type(doc,'$.releasePolicyBinding') IS NULL THEN 'legacy' ELSE 'invalid' END
 WHEN json_type(doc,'$.request.releasePolicy')='object'
  AND json_type(doc,'$.request.releasePolicy.schema')='integer'
  AND json_extract(doc,'$.request.releasePolicy.schema')=1
  AND json_type(doc,'$.request.releasePolicy.mode')='text'
  AND json_extract(doc,'$.request.releasePolicy.mode')='user-impact-only'
  AND json_type(doc,'$.request.releasePolicy.sourceSha')='text'
  AND json_extract(doc,'$.request.releasePolicy.sourceSha')=want_sha
  AND (SELECT count(*) FROM json_each(doc,'$.request.releasePolicy'))=3
  AND NOT EXISTS (SELECT 1 FROM json_each(doc,'$.request.releasePolicy')
                  WHERE key NOT IN ('schema','mode','sourceSha'))
 THEN 'user-impact-only' ELSE 'invalid' END AS policy_mode
FROM docs;
SQL
}

lease_policy_bind_sql() { # train_id target_sha actor; call AFTER row insert or for existing row
  local id="$1" target="$2" actor="$3" iq tq aq nowq
  lease_valid_train_id "$id" && lease_valid_sha "$target" || return 2
  iq="$(lease_q "$id")"; tq="$(lease_q "$target")"; aq="$(lease_q "$actor")"
  nowq="$(lease_q "$(lease_now)")"
  cat <<SQL
-- Current official train must still be mutable and bound to this exact source.
INSERT INTO _lp_guard SELECT CASE WHEN
 (SELECT count(*) FROM train WHERE id='$iq' AND resource='deploy:selfhost'
  AND target_sha='$tq' AND status IN ('planned','building'))=1 THEN 1 ELSE 0 END;
INSERT INTO _lp_guard SELECT CASE WHEN NOT EXISTS (
 SELECT 1 FROM _lp_open WHERE status='registered' AND policy_mode='invalid'
) THEN 1 ELSE 0 END;
-- Explicit requests may never fall through to legacy after tip advances.
INSERT INTO _lp_guard SELECT CASE WHEN NOT EXISTS (
 SELECT 1 FROM _lp_open WHERE status='registered'
  AND policy_mode='user-impact-only' AND want_sha<>'$tq'
) THEN 1 ELSE 0 END;
-- Same-SHA mixed policy can also arrive from an old registrar: recheck here.
INSERT INTO _lp_guard SELECT CASE WHEN NOT EXISTS (
 SELECT want_sha FROM _lp_open WHERE status='registered'
 GROUP BY want_sha HAVING count(DISTINCT policy_mode)>1
) THEN 1 ELSE 0 END;
CREATE TEMP TABLE _lp_selected AS SELECT * FROM _lp_open
 WHERE status='registered' AND policy_mode='user-impact-only' AND want_sha='$tq';
-- Immutable request and mutable consumption receipt are separate nodes.
INSERT INTO _lp_guard SELECT CASE WHEN NOT EXISTS (
 SELECT 1 FROM _lp_selected WHERE
  json_type(doc,'$.releasePolicyBinding') IS NOT NULL AND
  CASE WHEN json_type(doc,'$.releasePolicyBinding')='object'
    AND json_type(doc,'$.releasePolicyBinding.schema')='integer'
    AND json_extract(doc,'$.releasePolicyBinding.schema')=1
    AND json_type(doc,'$.releasePolicyBinding.trainId')='text'
    AND json_extract(doc,'$.releasePolicyBinding.trainId')='$iq'
    AND json_type(doc,'$.releasePolicyBinding.sourceSha')='text'
    AND json_extract(doc,'$.releasePolicyBinding.sourceSha')='$tq'
    AND (SELECT count(*) FROM json_each(doc,'$.releasePolicyBinding'))=3
    AND NOT EXISTS(SELECT 1 FROM json_each(doc,'$.releasePolicyBinding')
                   WHERE key NOT IN ('schema','trainId','sourceSha'))
  THEN 0 ELSE 1 END=1
) THEN 1 ELSE 0 END;
CREATE TEMP TABLE _lp_snapshot AS
 SELECT json_object('schema',1,'mode','user-impact-only','sourceSha','$tq',
                    'leaseIds',json((SELECT json_group_array(id)
                                   FROM (SELECT id FROM _lp_selected ORDER BY seq)))) AS doc
 WHERE EXISTS (SELECT 1 FROM _lp_selected);
-- Reject malformed existing metadata; do not silently overwrite it.
INSERT INTO _lp_guard SELECT CASE WHEN
 evidence_json IS NULL THEN 1
 WHEN json_valid(evidence_json)<>1 THEN 0
 WHEN json_type(evidence_json)='object' THEN 1 ELSE 0 END
 FROM train WHERE id='$iq';
CREATE TEMP TABLE _lp_previous AS SELECT
 json_type(COALESCE(evidence_json,'{}'),'$.releasePolicy') AS policy_type,
 json_extract(COALESCE(evidence_json,'{}'),'$.releasePolicy') AS doc
 FROM train WHERE id='$iq';
-- Existing frozen snapshot must match, not be replaced by a new request set.
INSERT INTO _lp_guard SELECT CASE WHEN
 (p.policy_type IS NULL AND NOT EXISTS(SELECT 1 FROM _lp_snapshot))
 OR (EXISTS(SELECT 1 FROM _lp_snapshot) AND (
   p.policy_type IS NULL OR (
    p.policy_type='object'
    AND json_type(p.doc,'$.schema')='integer'
    AND json_extract(p.doc,'$.schema')=1
    AND json_extract(p.doc,'$.mode')='user-impact-only'
    AND json_extract(p.doc,'$.sourceSha')='$tq'
    AND (SELECT count(*) FROM json_each(p.doc))=4
    AND NOT EXISTS(SELECT 1 FROM json_each(p.doc)
                   WHERE key NOT IN ('schema','mode','sourceSha','leaseIds'))
    AND json_type(p.doc,'$.leaseIds')='array'
    AND json(json_extract(p.doc,'$.leaseIds'))=
        json((SELECT json_extract(doc,'$.leaseIds') FROM _lp_snapshot))
   )
 )) THEN 1 ELSE 0 END FROM _lp_previous p;
UPDATE lease SET
 result_json=json_set(result_json,'$.releasePolicyBinding',
   json_object('schema',1,'trainId','$iq','sourceSha','$tq')),
 updated_at='$nowq' WHERE id IN (SELECT id FROM _lp_selected);
UPDATE train SET
 evidence_json=json_set(COALESCE(evidence_json,'{}'),'$.releasePolicy',
                       json((SELECT doc FROM _lp_snapshot))),
 updated_at='$nowq'
 WHERE id='$iq' AND EXISTS(SELECT 1 FROM _lp_snapshot);
INSERT INTO event(subject_id,event,actor,detail,created_at)
 SELECT '$iq','release-policy-bound','$aq','mode=user-impact-only sha=$tq','$nowq'
 WHERE EXISTS(SELECT 1 FROM _lp_snapshot)
 AND (SELECT policy_type FROM _lp_previous) IS NULL;
SQL
}

lease_json_object_merge_sql() { # column patch_json -> SQL expr; precompute/capture failure
 local column="$1" patch="$2" pq
 [[ "$column" == result_json || "$column" == evidence_json ]] || return 2
 jq -e 'type=="object"' <<<"$patch" >/dev/null || return 2
 pq="$(lease_q "$patch")"
 # Deliberately malformed json in invalid branch raises SQL error; .bail on rolls back.
 cat <<SQL
CASE WHEN $column IS NULL THEN json('$pq')
 WHEN json_valid($column)<>1 THEN json('!invalid-existing-metadata')
 WHEN json_type($column)<>'object' THEN json('!nonobject-existing-metadata')
 ELSE json_patch($column,json('$pq')) END
SQL
}

lease_policy_archive_accepted() { # train sha scope live_rel [ride_id]
  local train="$1" sha="$2" scope="$3" live_rel="$4" ride_id="${5:-}" libdir
  lease_valid_train_id "$train" && lease_valid_sha "$sha" || return 1
  [[ "$scope" == current || "$scope" == historical ]] || return 1
  [[ -z "$ride_id" ]] || lease_valid_id "$ride_id" || return 1
  libdir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || return 1
  python3 -B - "$libdir/lib/v5-release-policy.py" "$LEASE_DB" \
    "${OC_V5_RELEASE_POLICY_CONTEXT:-/var/lib/openclaude-v5-selfhost/release-policy/unresolved.json}" \
    "$train" "$sha" "$scope" "$live_rel" "$ride_id" <<'POLICY_ARCHIVE_ACCEPTED'
import hashlib,importlib.util,json,os,pathlib,sqlite3,stat,sys
helper,db,active_name,train,sha,scope,live_name,ride=sys.argv[1:]
try:
    spec=importlib.util.spec_from_file_location('v5_release_policy_reader',helper)
    p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
    active=pathlib.Path(active_name)
    p.absolute(str(active),'active context')
    def absent():
        # Only reliable ENOENT permits a reader through. Broken symlink,
        # permission failure, corrupt active file etc. all remain a barrier.
        try:active.lstat()
        except FileNotFoundError:return
        raise p.PolicyError('active intent still present')
    absent()
    con=sqlite3.connect(pathlib.Path(db).resolve().as_uri()+'?mode=ro',uri=True)
    con.row_factory=sqlite3.Row
    row=con.execute("SELECT * FROM train WHERE id=? AND resource='deploy:selfhost'",(train,)).fetchone()
    p.require(row is not None and row['target_sha']==sha and row['status']=='committed','train is not accepted')
    e=json.loads(row['evidence_json']);p.require(isinstance(e,dict),'train evidence is not an object')
    policy=e['releasePolicy'];owner=e['releasePolicyOwner'];expect=e['releasePolicyAcceptance']
    p.require(isinstance(policy,dict) and set(policy)=={'schema','mode','sourceSha','leaseIds'}
        and type(policy['schema']) is int and policy['schema']==1
        and policy['mode']=='user-impact-only' and policy['sourceSha']==sha
        and isinstance(policy['leaseIds'],list),'train policy differs')
    p.require(isinstance(owner,dict) and isinstance(owner.get('nonce'),str),'owner receipt missing')
    p.require(isinstance(expect,dict) and set(expect)=={'schema','operationId','candidateSha','nonce','targetStackSha256','resolution'}
        and type(expect['schema']) is int and expect['schema']==1
        and expect['operationId']==train and expect['candidateSha']==sha
        and expect['nonce']==owner['nonce'] and expect['resolution']=='forward','frozen expectation differs')
    p.digest(expect['targetStackSha256'],'expected target stack')
    if ride:
        r=con.execute("SELECT want_sha,result_json FROM lease WHERE id=? AND resource='deploy:selfhost' AND mode='ride'",(ride,)).fetchone()
        p.require(r is not None and r['want_sha']==sha and ride in policy['leaseIds'],'ride not consumed by this train')
        doc=json.loads(r['result_json']);b=doc['releasePolicyBinding'];request=doc['request']['releasePolicy']
        p.require(isinstance(request,dict) and set(request)=={'schema','mode','sourceSha'}
            and type(request['schema']) is int and request['schema']==1
            and request['mode']=='user-impact-only' and request['sourceSha']==sha,'explicit request changed')
        p.require(isinstance(b,dict) and set(b)=={'schema','trainId','sourceSha'}
            and type(b['schema']) is int and b['schema']==1
            and b['trainId']==train and b['sourceSha']==sha,'ride binding differs')
    # Fixed operation-bound path only: never glob, latest archive, or SHA search.
    archive=active.with_name(active.name+'.resolved.'+train+'.json')
    c=p.load(archive,train)
    p.require(c['edition']=='selfhost' and c['policy']=='user-impact-only'
        and c['candidateSha']==sha and c['owner']=={'deploymentId':train,'nonce':expect['nonce']}
        and c['phase']=='resolved' and c['resolution']=='forward','archive identity/direction differs')
    p.require(c['target'].get('sourceCommit')==sha
        and p.stack_digest(c['target'])==expect['targetStackSha256'],'target stack differs')
    o=c['observations']
    p.require(o.get('identity')=='exact' and o.get('service')=='usable'
        and o.get('allRequiredPassed') is True and o.get('lineageCoherent') is True
        and o.get('verifiedDirection')=='target'
        and o.get('verifiedStackSha256')==expect['targetStackSha256']
        and o.get('authority') in ('unobserved','applied','original','reverted'),'acceptance proof incomplete')
    if scope=='current':
        live=pathlib.Path(live_name).resolve(strict=True)
        p.require(str(live)==c['target']['masterRelease'] and row['rel_path']==str(live),'archive is not this live target')
        raw=(live/'.complete').read_bytes();manifest=json.loads(raw)
        p.require(manifest.get('sourceCommit')==sha
            and hashlib.sha256(raw).hexdigest()==c['target'].get('sourceDigest'),'live manifest differs')
    # Finish an unlink-after-ACK-loss cleanup without another database ACK cycle.
    # Recheck the exact file bytes loaded under the trusted private parent.
    fd=os.open(archive,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        p.require(stat.S_ISREG(info.st_mode) and info.st_uid==os.geteuid()
            and not info.st_mode&0o077 and info.st_size<=65536,'archive metadata changed')
        with os.fdopen(fd,'rb',closefd=False) as f:again=json.load(f)
        p.require(again==c,'archive changed during verification')
        os.fsync(fd)
    finally:os.close(fd)
    p.sync_directory(archive.parent)
    absent()
except Exception:
    # No manifest, nonce, env/tuple values or other users' content in logs.
    print('release-policy acceptance not verified',file=sys.stderr)
    sys.exit(1)
POLICY_ARCHIVE_ACCEPTED
}

# Add this NEW worker function. It selects a train record, never an archive.
# Current rel_path is authoritative when present. Fall back to latest exact
# target train only to prevent missing/broken policy metadata being legacy-green.
lease_policy_current_live_accepted() { # live_sha live_rel
  local sha="$1" rel="$2" row id policy_kind bound_count
  [[ -f "$LEASE_DB" ]] || return 0
  row="$(lease_sql_json "SELECT id,evidence_json,rel_path,
    EXISTS(SELECT 1 FROM lease l WHERE l.resource='deploy:selfhost' AND l.mode='ride'
      AND l.want_sha=train.target_sha AND CASE WHEN json_valid(l.result_json)
      THEN json_extract(l.result_json,'$.releasePolicyBinding.trainId')=train.id ELSE 0 END) AS bound_policy_ride
    FROM train
    WHERE resource='deploy:selfhost' AND target_sha='$(lease_q "$sha")'
    ORDER BY CASE WHEN rel_path='$(lease_q "$rel")' THEN 0 ELSE 1 END,seq DESC LIMIT 1;")" || return 1
  [[ "$row" == '[]' || -z "$row" ]] && return 0 # Existing legacy bootstrap.
  id="$(jq -er '.[0].id' <<<"$row")" || return 1
  policy_kind="$(jq -er '
    .[0] as $t | ($t.evidence_json // "{}" | fromjson) as $e |
    if ($e|type)!="object" then "invalid"
    elif $t.bound_policy_ride==1 or ($e|has("releasePolicy")) or ($e|has("releasePolicyAcceptance"))
      or ($e|has("releasePolicyOwner")) then "policy" else "legacy" end' <<<"$row")" || return 1
  bound_count="$(lease_sql "SELECT COUNT(*) FROM lease WHERE CASE WHEN json_valid(result_json) THEN json_extract(result_json,'$.releasePolicyBinding.trainId') ELSE NULL END='$(lease_q "$id")';")" || return 1
  [[ "$bound_count" == 0 ]] || policy_kind=policy
  case "$policy_kind" in
    legacy) return 0 ;;
    policy) lease_policy_archive_accepted "$id" "$sha" current "$rel" ;;
    *) return 1 ;;
  esac
}
