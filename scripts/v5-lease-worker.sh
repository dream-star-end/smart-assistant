#!/usr/bin/env bash
# v5-lease-worker.sh — selfhost Lease Center 守护 tick(由 systemd timer 每 30s 拉起一次)。
#
# 每 tick 严格顺序(design-v2 §3.2):
#   1 单例 flock(双 worker 防线)
#   2 train 对账:非终态 train 无活 executor → 按 survivor 证据结算 / recovery_required
#   3 过期:granted 超 ack/heartbeat 且执行器确认退出 → revoked;ride 超 6h → 面板告警(不过期)
#   4 结算:live committed sha ⊇ want_sha → satisfied(同事务写 outbox)
#   5 发车:仅剩余 ride、无 open train、锁可取 → 固定 target_sha 起一班 deploy(锁 fd 继承给执行器)
#   6 投递 outbox(P1:ticket/log;P2:session)
#
# 任何 sqlite 写失败 → 本 tick 放弃该步骤,绝不授权/发车。网络与子进程都在事务外。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/v5-lease-lib.sh
source "$SCRIPT_DIR/v5-lease-lib.sh"

WORKER_LOCK="${OC_V5_LEASE_WORKER_LOCK:-/run/openclaude-v5-selfhost/lease-worker.lock}"
WORKER_LOG_DIR="${OC_V5_LEASE_LOG_DIR:-/opt/openclaude/tmp/lease-trains}"
DEPLOY_BIN="${OC_V5_LEASE_DEPLOY_BIN:-$LEASE_REPO_ROOT/scripts/deploy-v5-selfhost.sh}"
TASK_CLI="${OC_V5_LEASE_TASK_CLI:-}"            # 面板 CLI;空 → 自动探测 oc-task
CALLBACK_URL="${OC_V5_LEASE_CALLBACK_URL:-}"    # P2:http://127.0.0.1:18790/internal/v3/lease-callback
CALLBACK_SECRET_FILE="${OC_V5_LEASE_CALLBACK_SECRET_FILE:-/etc/openclaude/commercial-v5-selfhost.env}"
DRY="${OC_V5_LEASE_DRY:-0}"
RESOURCE="deploy:selfhost"
ACTOR="worker:$$"

wlog() { echo "$(lease_now) [lease-worker] $*"; }

# ---------- 1 单例 ----------
acquire_singleton() {
  mkdir -p "$(dirname "$WORKER_LOCK")" 2>/dev/null || true
  exec 212>"$WORKER_LOCK"
  flock -n 212 || { wlog "另一 worker 在跑,本 tick 退出"; exit 0; }
}

# ---------- 2 train 对账 ----------
train_evidence_json() { # <train_id>
  local live phase committed=0
  live="$(lease_live_rel_path)"
  phase=""
  if [[ -f "$LEASE_SURVIVOR_STATE" && ! -L "$LEASE_SURVIVOR_STATE" ]]; then
    phase="$(jq -er '.phase // empty' "$LEASE_SURVIVOR_STATE" 2>/dev/null || sed -n 's/^phase=//p' "$LEASE_SURVIVOR_STATE" 2>/dev/null | head -1)"
  fi
  [[ -f "$LEASE_SURVIVOR_COMMITTED" ]] && committed=1
  jq -cn --arg live "$live" --arg phase "${phase:-}" --argjson committed "$committed" \
    --arg log "$(train_field "$1" log_path)" \
    '{live:$live,survivor_phase:$phase,committed_marker:$committed,log:$log}'
}

reconcile_trains() {
  local rows id st pid created target
  rows="$(lease_sql "SELECT id||'|'||status||'|'||COALESCE(executor_pid,'')||'|'||created_at||'|'||target_sha
                       FROM train WHERE resource='$RESOURCE' AND status NOT IN ('committed','failed','recovery_required');")"
  [[ -n "$rows" ]] || return 0
  while IFS='|' read -r id st pid created target; do
    [[ -n "$id" ]] || continue
    if lease_pid_alive "$pid"; then
      continue   # 执行器活着,不动
    fi
    local live_sha ev
    ev="$(train_evidence_json "$id")"
    if [[ "$st" == planned && -z "$pid" ]]; then
      # spawn 前崩溃:planned 超时 → failed(不重发,下 tick 重新规划新 train)
      local stale
      stale="$(lease_sql "SELECT CASE WHEN '$created' < strftime('%Y-%m-%dT%H:%M:%SZ','now','-${LEASE_TRAIN_PLANNED_STALE_SECONDS} seconds') THEN 1 ELSE 0 END;")"
      [[ "$stale" == 1 ]] || continue
      finish_train "$id" failed "planned 超 ${LEASE_TRAIN_PLANNED_STALE_SECONDS}s 无执行器(spawn 前崩溃)" "$ev"
      continue
    fi
    # 执行器已死,看权威证据
    if live_sha="$(lease_live_committed_sha)" && lease_sha_contained "$target" "$live_sha" && [[ "$live_sha" == "$target" ]]; then
      finish_train "$id" committed "执行器退出;live committed sourceCommit=$live_sha 等于 target(对账结算)" "$ev"
    elif live_sha="$(lease_live_committed_sha)"; then
      finish_train "$id" failed "执行器退出;live committed 但 sourceCommit=${live_sha:0:12} ≠ target ${target:0:12}(本班未上线)" "$ev"
    else
      # survivor 处于未提交 mutation,或 live 不可读 → 需人工
      finish_train "$id" recovery_required "执行器退出且 survivor 非 committed(uncommitted mutation / 宿主重启丢证据)。禁止自动重发。" "$ev"
      enqueue_train_alert "$id" recovery_required "执行器 pid=${pid:-?} 已退;survivor 证据 $ev"
    fi
  done <<<"$rows"
}

finish_train() { # <id> <status> <reason> <evidence_json>
  local now; now="$(lease_now)"
  lease_tx <<SQL || { wlog "finish_train $1 写失败,放弃"; return 1; }
BEGIN IMMEDIATE;
UPDATE train SET status='$2', reason='$(lease_q "$3")', evidence_json='$(lease_q "$4")',
       rel_path=$( [[ "$2" == committed ]] && printf "'%s'" "$(lease_q "$(lease_live_rel_path)")" || printf 'rel_path' ),
       finished_at='$now', updated_at='$now'
 WHERE id='$1' AND status NOT IN ('committed','failed');
$(lease_event_sql "$1" "train-$2" "$ACTOR" "$3")
COMMIT;
SQL
  wlog "train $1 → $2: $3"
}

enqueue_train_alert() { # <train_id> <status> <reason>
  local body key="train:$1:$2"
  body="$(lease_body_train_alert "$1" "$2" "$3")"
  # train 告警没有 lease 归属,投到最近一条 open ride 的 ticket(有则),否则 log。
  local tk
  tk="$(lease_sql "SELECT ticket_ref FROM lease WHERE resource='$RESOURCE' AND status='registered' AND ticket_ref IS NOT NULL ORDER BY seq DESC LIMIT 1;")"
  lease_tx <<SQL || true
BEGIN IMMEDIATE;
$(lease_outbox_sql "$key" "$1" train_alert "$( [[ -n "$tk" ]] && echo ticket || echo log )" "${tk:--}" "$body")
COMMIT;
SQL
}

# ---------- 3 过期 / 告警 ----------
expire_and_alert() {
  # granted(P3 才会有)超时:仅在执行器确认退出且 deploy.lock 可取时 revoke。
  local rows id pid
  rows="$(lease_sql "SELECT id||'|'||COALESCE(json_extract(result_json,'$.executor_pid'),'') FROM lease
                     WHERE resource='$RESOURCE' AND status='granted'
                       AND ( (heartbeat_at IS NULL AND grant_ack_until < strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                          OR (heartbeat_at IS NOT NULL AND heartbeat_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-${LEASE_HEARTBEAT_STALE_SECONDS} seconds')) );")"
  while IFS='|' read -r id pid; do
    [[ -n "$id" ]] || continue
    if lease_pid_alive "$pid" || lease_deploy_process_running; then
      wlog "granted $id 超时但执行器仍在,保持 granted 并告警"
      enqueue_lease_outbox "$id" alert "$(lease_body_alert "$id" '?' 'granted 超时但执行器未退出,人工确认')"
      continue
    fi
    if ! ( exec 8>"$LEASE_DEPLOY_LOCK"; flock -n 8 ); then
      wlog "granted $id 超时但 deploy.lock 仍被持有,不 revoke"
      continue
    fi
    transition_with_outbox "$id" granted revoked "grant-ack/heartbeat 超时且执行器已退出" \
      "$(lease_body_failed "$id" "grant 超时被收回" "执行器无 pid、deploy.lock 空闲")"
  done <<<"$rows"

  # ride 6h 未结算 → 告警一次/6h(不过期)
  rows="$(lease_sql "SELECT id||'|'||created_at FROM lease
                     WHERE resource='$RESOURCE' AND status='registered' AND mode='ride'
                       AND created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-${LEASE_RIDE_ALERT_SECONDS} seconds')
                       AND (last_alert_at IS NULL OR last_alert_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-${LEASE_RIDE_ALERT_SECONDS} seconds'));")"
  local created age_h blocker
  while IFS='|' read -r id created; do
    [[ -n "$id" ]] || continue
    age_h="$(lease_sql "SELECT CAST((julianday('now')-julianday('$created'))*24 AS INTEGER);")"
    blocker="$(describe_blocker)"
    local key hour; hour="$(lease_sql "SELECT strftime('%Y%m%d%H','now');")"; key="lease:$id:alert:$hour"
    lease_tx <<SQL || continue
BEGIN IMMEDIATE;
UPDATE lease SET last_alert_at='$(lease_now)', updated_at='$(lease_now)' WHERE id='$id';
$(lease_outbox_sql "$key" "$id" alert "$(lease_callback_target "$id" | cut -f1)" "$(lease_callback_target "$id" | cut -f2)" "$(lease_body_alert "$id" "$age_h" "$blocker")")
COMMIT;
SQL
    wlog "ride $id 等待 ${age_h}h,已告警"
  done <<<"$rows"
}

describe_blocker() {
  local open
  open="$(lease_sql "SELECT id||'('||status||')' FROM train WHERE resource='$RESOURCE' AND status NOT IN ('committed','failed') LIMIT 1;")"
  if [[ -n "$open" ]]; then echo "open train $open"; return; fi
  if lease_deploy_process_running; then echo "外部 deploy-v5-selfhost.sh 进程在跑(非列车)"; return; fi
  if ! ( exec 8>"$LEASE_DEPLOY_LOCK"; flock -n 8 ) 2>/dev/null; then echo "deploy.lock 被外部持有"; return; fi
  if lease_in_cutover_grace; then echo "cutover grace 窗口"; return; fi
  echo "未知(worker 应已发车,请查 worker 日志)"
}

# 通用:CAS 状态迁移 + 同事务 outbox。
transition_with_outbox() { # <id> <from> <to> <detail> <body>
  local id="$1" from="$2" to="$3" detail="$4" body="$5" tk tt
  IFS=$'\t' read -r tk tt < <(lease_callback_target "$id")
  lease_tx <<SQL || { wlog "transition $id $from→$to 写失败"; return 1; }
BEGIN IMMEDIATE;
UPDATE lease SET status='$to', result_json='$(lease_q "$(jq -cn --arg d "$detail" '{detail:$d}')")', updated_at='$(lease_now)'
 WHERE id='$id' AND status='$from';
$(lease_outbox_sql "lease:$id:$to" "$id" "$to" "$tk" "$tt" "$body")
$(lease_event_sql "$id" "$to" "$ACTOR" "$detail")
COMMIT;
SQL
  wlog "lease $id $from→$to: $detail"
}

enqueue_lease_outbox() { # <id> <kind> <body>  (不改状态)
  local tk tt
  IFS=$'\t' read -r tk tt < <(lease_callback_target "$1")
  lease_tx <<SQL || true
BEGIN IMMEDIATE;
$(lease_outbox_sql "lease:$1:$2:$(lease_sql "SELECT strftime('%Y%m%d%H','now');")" "$1" "$2" "$tk" "$tt" "$3")
COMMIT;
SQL
}

# ---------- 4 结算 ----------
settle_rides() {
  local live_sha rel rows id want same
  live_sha="$(lease_live_committed_sha)" || { wlog "live 非 committed,本 tick 不结算"; return 0; }
  rel="$(lease_live_rel_path)"
  rows="$(lease_sql "SELECT id||'|'||want_sha FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride';")"
  [[ -n "$rows" ]] || return 0
  same="$(lease_sql "SELECT group_concat(substr(want_sha,1,7),' ') FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride';")"
  while IFS='|' read -r id want; do
    [[ -n "$id" ]] || continue
    if lease_sha_contained "$want" "$live_sha"; then
      transition_with_outbox "$id" registered satisfied "live=$rel sourceCommit=$live_sha ⊇ $want" \
        "$(lease_body_satisfied "$id" "$want" "$rel" "$live_sha" "$same")"
    fi
  done <<<"$rows"
}

# ---------- 5 发车 ----------
dispatch_train() {
  local pending open tip miss id now logf
  pending="$(lease_sql "SELECT COUNT(*) FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride';")"
  [[ "$pending" -gt 0 ]] || return 0
  open="$(lease_sql "SELECT id FROM train WHERE resource='$RESOURCE' AND status NOT IN ('committed','failed') LIMIT 1;")"
  [[ -z "$open" ]] || { wlog "有 open train $open,不发车"; return 0; }
  [[ -n "$(lease_sql "SELECT id FROM lease WHERE resource='$RESOURCE' AND status='granted' LIMIT 1;")" ]] && { wlog "有 granted drive,不发车"; return 0; }
  lease_deploy_process_running && { wlog "外部 deploy 进程在跑,不发车"; return 0; }
  lease_in_cutover_grace && { wlog "cutover grace 窗口,不发车"; return 0; }

  git -C "$LEASE_REPO_ROOT" fetch -q origin "$LEASE_BRANCH" 2>/dev/null || true
  tip="$(lease_remote_tip)" || { wlog "读不到 origin tip"; return 0; }
  # target 必须 ⊇ 所有 pending want_sha
  miss="$(lease_sql "SELECT want_sha FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride';" \
          | while read -r w; do lease_sha_contained "$w" "$tip" || echo "$w"; done)"
  [[ -z "$miss" ]] || { wlog "tip ${tip:0:12} 不含 pending sha: $miss;不发车"; return 0; }
  # 同一 target 上一班由执行器自己上报 failed(门禁/构建拒绝 = 确定性失败)→ 不自动重发
  # (2026-09-05 实测:0274 迁移门拒绝后 worker 每 15min 烧一班)。worker 对账判的 failed(planned 超时、执行器被外力杀)不受此限。
  # 在那班结束前登记的 ride 置 failed 并回调(design-v2 §2.2:train failed 且无法自动重发 → failed);
  # 之后新登记的 ride 是人工决定,允许再发一班。
  local lastf ftid ffin freason flog
  lastf="$(lease_sql -separator $'\t' "SELECT t.id,t.finished_at,COALESCE(t.reason,''),COALESCE(t.log_path,'') FROM train t
             WHERE t.resource='$RESOURCE' AND t.target_sha='$tip' AND t.status='failed'
               AND EXISTS (SELECT 1 FROM event e WHERE e.subject_id=t.id AND e.event='train-failed' AND e.actor LIKE 'deploy:%')
             ORDER BY t.seq DESC LIMIT 1;")"
  if [[ -n "$lastf" ]]; then
    IFS=$'\t' read -r ftid ffin freason flog <<<"$lastf"
    local rid
    while read -r rid; do
      [[ -n "$rid" ]] || continue
      transition_with_outbox "$rid" registered failed "train $ftid(target ${tip:0:12})failed,同 target 不自动重发" \
        "$(lease_body_failed "$rid" "列车 $ftid 失败: $freason" "${flog:-无日志}(target ${tip:0:12} 仍是分支 tip;修复后 push 新 tip 或人工放行后再 register)")"
    done < <(lease_sql "SELECT id FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride' AND created_at <= '$(lease_q "$ffin")';")
    pending="$(lease_sql "SELECT COUNT(*) FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride';")"
    [[ "$pending" -gt 0 ]] || { wlog "tip ${tip:0:12} 上一班 $ftid 已 failed 且无新 ride,不发车"; return 0; }
  fi
  # 宿主工作树 HEAD 必须等于 tip(deploy 脚本认工作树 HEAD;lease 列车只发已 push 的 tip)
  local head; head="$(git -C "$LEASE_REPO_ROOT" rev-parse HEAD)"
  [[ "$head" == "$tip" ]] || { wlog "工作树 HEAD ${head:0:12} ≠ origin tip ${tip:0:12};不发车(等 ff-merge/push 对齐)"; return 0; }

  # 取 deploy.lock(fd 8,与 deploy 脚本同一把;取到就持有并传给执行器继承)
  mkdir -p "$(dirname "$LEASE_DEPLOY_LOCK")" 2>/dev/null || true
  exec 8>"$LEASE_DEPLOY_LOCK"
  flock -n 8 || { wlog "deploy.lock 被持有,不发车"; exec 8>&-; return 0; }

  id="$(lease_new_id tr)"; now="$(lease_now)"
  mkdir -p "$WORKER_LOG_DIR"; logf="$WORKER_LOG_DIR/$id.log"
  # 先 insert(planned),再 spawn;唯一部分索引保证同 resource 只有一班 open。
  lease_tx <<SQL || { wlog "insert train 失败(可能并发已有 open),不发车"; exec 8>&-; return 0; }
BEGIN IMMEDIATE;
INSERT INTO train(id,resource,target_sha,status,owner,log_path,created_at,updated_at)
VALUES('$id','$RESOURCE','$tip','planned','$ACTOR','$(lease_q "$logf")','$now','$now');
$(lease_event_sql "$id" train-planned "$ACTOR" "target=$tip rides=$pending")
COMMIT;
SQL
  wlog "train $id planned target=${tip:0:12} rides=$pending → spawn deploy"
  if [[ "$DRY" == 1 ]]; then
    wlog "[dry] 不 spawn"; exec 8>&-; return 0
  fi
  # 执行器必须活得比本 tick 长。worker 由 systemd oneshot 拉起(KillMode=control-group),
  # 直接 setsid 的子进程仍在同一 cgroup,tick 结束即被收割(2026-09-05 实测:首三班 30s 内全死)。
  # 所以在 systemd 下用 systemd-run 起独立 transient unit;不在 systemd 下(selftest)退回 setsid。
  # 锁:transient unit 无法继承 fd 8 → 这里先释放,让执行器自己走脚本原生 flock 路径;
  # 双发防线仍是 train 唯一开放索引 + 本 tick 已确认锁空。
  local pid
  if [[ -n "${INVOCATION_ID:-}" ]] && command -v systemd-run >/dev/null 2>&1; then
    exec 8>&-
    local unit="oc-v5-lease-train-${id#tr-}"
    if ! systemd-run --quiet --collect --unit="$unit" --description="lease train $id → ${tip:0:12}" \
         --property=KillMode=process --property=TimeoutStopSec=35min \
         --setenv=OC_V5_LEASE_TRAIN_ID="$id" --setenv=OC_V5_LEASE_DB="$LEASE_DB" \
         --setenv=HOME=/root --setenv=PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
         --property=StandardOutput="file:$logf" --property=StandardError="file:$logf" \
         "$DEPLOY_BIN" --deploy --lease-train="$id" --target-sha="$tip" --allow-dirty --platform-from-head; then
      finish_train "$id" failed "systemd-run 启动失败" '{}'
      return 0
    fi
    # 拿 transient unit 主 pid(最多等 3s)
    local i; for i in 1 2 3 4 5 6; do
      pid="$(systemctl show -p MainPID --value "$unit.service" 2>/dev/null || true)"
      [[ -n "$pid" && "$pid" != 0 ]] && break; sleep 0.5
    done
    [[ -n "$pid" && "$pid" != 0 ]] || { wlog "拿不到 $unit MainPID(可能已秒退),交给对账"; pid=0; }
  else
    OC_V5_SELFHOST_DEPLOY_LOCK_HELD=1 OC_V5_LEASE_TRAIN_ID="$id" OC_V5_LEASE_DB="$LEASE_DB" \
      setsid nohup "$DEPLOY_BIN" --deploy --lease-train="$id" --target-sha="$tip" --allow-dirty --platform-from-head \
        >"$logf" 2>&1 </dev/null 8>&8 211>&- 212>&- &
    pid=$!
    exec 8>&-   # worker 放手;锁随执行器进程生命周期
  fi
  lease_tx <<SQL || wlog "写 executor_pid 失败(对账将按 planned 超时处理)"
BEGIN IMMEDIATE;
UPDATE train SET executor_pid=$pid, status='building', started_at='$(lease_now)', updated_at='$(lease_now)' WHERE id='$id' AND status='planned';
$(lease_event_sql "$id" train-spawned "$ACTOR" "pid=$pid log=$logf")
COMMIT;
SQL
  wlog "train $id spawned pid=$pid log=$logf"
}

# ---------- 6 投递 ----------
detect_task_cli() {
  [[ -n "$TASK_CLI" ]] && { echo "$TASK_CLI"; return; }
  for c in /home/agent/.local/bin/oc-task /usr/local/bin/oc-task; do [[ -x "$c" ]] && { echo "$c"; return; }; done
  command -v oc-task 2>/dev/null || true
}

deliver_outbox() {
  local rows id tid kind tkind target body attempts
  rows="$(lease_sql "SELECT id FROM outbox WHERE status='pending' AND next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now') ORDER BY created_at LIMIT 20;")"
  [[ -n "$rows" ]] || return 0
  local cli; cli="$(detect_task_cli)"
  while read -r id; do
    [[ -n "$id" ]] || continue
    IFS=$'\t' read -r tid kind tkind target attempts < <(lease_sql -separator $'\t' "SELECT transport_id,kind,target_kind,target,attempts FROM outbox WHERE id='$(lease_q "$id")';")
    body="$(lease_sql "SELECT body FROM outbox WHERE id='$(lease_q "$id")';")"
    # 过 deadline → expired + 一次日志告警
    if [[ "$(lease_sql "SELECT CASE WHEN deadline < strftime('%Y-%m-%dT%H:%M:%SZ','now') THEN 1 ELSE 0 END FROM outbox WHERE id='$(lease_q "$id")';")" == 1 ]]; then
      lease_tx <<SQL || true
BEGIN IMMEDIATE; UPDATE outbox SET status='expired', last_error='deadline' WHERE id='$(lease_q "$id")'; COMMIT;
SQL
      wlog "outbox $id 过 deadline → expired(target=$tkind:$target)"; continue
    fi
    case "$tkind" in
      session)
        if [[ -z "$CALLBACK_URL" ]]; then
          # P1:会话通道未启用 → 降级到 ticket(有)或 log
          local lid tk; lid="$(lease_sql "SELECT lease_id FROM outbox WHERE id='$(lease_q "$id")';")"
          tk="$(lease_field "$lid" ticket_ref)"
          if [[ -n "$tk" ]]; then
            lease_tx <<SQL || true
BEGIN IMMEDIATE; UPDATE outbox SET target_kind='ticket', target='$(lease_q "$tk")', last_error='session channel disabled (P1) → ticket' WHERE id='$(lease_q "$id")'; COMMIT;
SQL
            continue
          fi
          mark_delivered_log "$id" "$body"; continue
        fi
        deliver_session "$id" "$tid" "$target" "$body" "$attempts" ;;
      ticket) deliver_ticket "$id" "$tid" "$target" "$body" "$attempts" "$cli" ;;
      log) mark_delivered_log "$id" "$body" ;;
    esac
  done <<<"$rows"
}

mark_delivered_log() {
  wlog "outbox $1 (log) ↓"; printf '%s\n' "$2" | sed 's/^/    /'
  lease_tx <<SQL || true
BEGIN IMMEDIATE; UPDATE outbox SET status='delivered', delivered_at='$(lease_now)' WHERE id='$(lease_q "$1")'; COMMIT;
SQL
}

backoff_sql() { # <attempts> → seconds(30·2^n,上限 600)
  local n="$1" s
  (( n > 5 )) && n=5
  s=$(( 30 * (1 << n) )); (( s > 600 )) && s=600
  echo "$s"
}

deliver_ticket() { # <id> <tid> <ticket> <body> <attempts> <cli>
  local id="$1" tid="$2" ticket="$3" body="$4" attempts="$5" cli="$6" marked out
  [[ -n "$cli" ]] || { retry_later "$id" "$attempts" "oc-task CLI 不可用"; return; }
  marked="$(printf '%s\n\n<!-- lease-outbox %s -->' "$body" "$tid")"
  # 幂等:先查该 ticket 是否已有同 transport_id 的评论(写成功但响应丢失的情况)
  local existing
  existing="$(HOME=/home/agent "$cli" ticket get "$ticket" 2>/dev/null || true)"
  if [[ "$existing" == *"lease-outbox $tid"* ]]; then
    lease_tx <<SQL || true
BEGIN IMMEDIATE; UPDATE outbox SET status='delivered', delivered_at='$(lease_now)', last_error='already-present' WHERE id='$(lease_q "$id")'; COMMIT;
SQL
    wlog "outbox $id 面板已有同 transport_id 评论,标记 delivered"; return
  fi
  if out="$(HOME=/home/agent "$cli" ticket comment "$ticket" --body "$marked" 2>&1)"; then
    lease_tx <<SQL || true
BEGIN IMMEDIATE; UPDATE outbox SET status='delivered', delivered_at='$(lease_now)', attempts=attempts+1 WHERE id='$(lease_q "$id")'; COMMIT;
SQL
    wlog "outbox $id → ticket $ticket delivered"
  else
    retry_later "$id" "$attempts" "${out:0:200}"
  fi
}

deliver_session() { # <id> <tid> <session_key> <body> <attempts>   (P2)
  local id="$1" tid="$2" sk="$3" body="$4" attempts="$5" lid uid agent sid secret code resp
  lid="$(lease_sql "SELECT lease_id FROM outbox WHERE id='$(lease_q "$id")';")"
  uid="$(lease_field "$lid" owner_uid)"; agent="${sk#agent:}"; agent="${agent%%:*}"; sid="${sk##*:}"
  secret="$(sed -n 's/^OC_LEASE_CALLBACK_SECRET=//p' "$CALLBACK_SECRET_FILE" 2>/dev/null | head -1 | tr -d '"')"
  [[ -n "$secret" ]] || { retry_later "$id" "$attempts" "缺 OC_LEASE_CALLBACK_SECRET"; return; }
  resp="$(jq -cn --arg uid "$uid" --arg sid "$sid" --arg agent "$agent" --arg cmid "$tid" --arg text "$body" \
          '{uid:$uid,sessionId:$sid,agentId:$agent,clientMessageId:$cmid,text:$text}' \
        | curl -sS -m 20 -H "Content-Type: application/json" -H "X-OC-Lease-Secret: $secret" \
            -w '\n%{http_code}' --data-binary @- "$CALLBACK_URL" 2>&1)" || { retry_later "$id" "$attempts" "curl: ${resp:0:200}"; return; }
  code="${resp##*$'\n'}"; resp="${resp%$'\n'*}"
  local kind; kind="$(printf '%s' "$resp" | jq -r '.kind // empty' 2>/dev/null || true)"
  case "$code:$kind" in
    200:injected)
      lease_tx <<SQL || true
BEGIN IMMEDIATE; UPDATE outbox SET status='delivered', delivered_at='$(lease_now)', attempts=attempts+1 WHERE id='$(lease_q "$id")'; COMMIT;
SQL
      wlog "outbox $id → session $sid injected" ;;
    200:in_flight|409:*)
      # 会话在飞:不计 attempts,60s 后再试,直到 deadline
      lease_tx <<SQL || true
BEGIN IMMEDIATE; UPDATE outbox SET next_attempt_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','+60 seconds'), last_error='in_flight' WHERE id='$(lease_q "$id")'; COMMIT;
SQL
      ;;
    200:gone|404:*|410:*)
      local tk; tk="$(lease_field "$lid" ticket_ref)"
      if [[ -n "$tk" ]]; then
        lease_tx <<SQL || true
BEGIN IMMEDIATE; UPDATE outbox SET target_kind='ticket', target='$(lease_q "$tk")', status='pending', last_error='session gone → ticket', next_attempt_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id='$(lease_q "$id")'; COMMIT;
SQL
        wlog "outbox $id 会话已消失 → 转 ticket $tk"
      else
        lease_tx <<SQL || true
BEGIN IMMEDIATE; UPDATE outbox SET status='fallback_ticket', last_error='session gone, no ticket' WHERE id='$(lease_q "$id")'; COMMIT;
SQL
        wlog "outbox $id 会话已消失且无 ticket,正文↓"; printf '%s\n' "$body" | sed 's/^/    /'
      fi ;;
    *) retry_later "$id" "$attempts" "http=$code kind=${kind:-?} ${resp:0:160}" ;;
  esac
}

retry_later() { # <id> <attempts> <err>
  local s; s="$(backoff_sql "$2")"
  lease_tx <<SQL || true
BEGIN IMMEDIATE;
UPDATE outbox SET attempts=attempts+1, last_error='$(lease_q "$3")',
       next_attempt_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','+$s seconds') WHERE id='$(lease_q "$1")';
COMMIT;
SQL
  wlog "outbox $1 投递失败(attempt $(( $2 + 1 )),+${s}s): $3"
}

# ---------- main ----------
main() {
  lease_need_tool sqlite3; lease_need_tool git; lease_need_tool jq; lease_need_tool flock
  acquire_singleton
  lease_init_db
  reconcile_trains
  expire_and_alert
  settle_rides
  dispatch_train
  deliver_outbox
}
main "$@"
