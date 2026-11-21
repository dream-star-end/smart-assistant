#!/usr/bin/env bash
# oc-lease.sh — agent 侧共享资源租约入口(selfhost Lease Center)。
#
# 用途:会话要用共享独占资源(当前只支持 deploy:selfhost)时,一次 register 后立即收口本回合;
# 等待、发车、结算全部由 v5-lease-worker.sh 在宿主侧完成,终态以面板评论(P1)/注入原会话(P2)送回。
# **不提供 wait 子命令**:阻塞等待是守护进程的事,不是会话的事。
#
# 用法:
#   oc-lease register --resource deploy:selfhost --mode ride --sha <40hex> [--ticket OCV5-xx] [--callback auto|none [--release-policy user-impact-only]] [--allow-inflight] [--owner TAG]
#   oc-lease status   [--resource R] [--id ID] [--json]
#   oc-lease cancel   --id ID [--owner TAG]
#   oc-lease train    list | resolve --id TR --as committed|failed --reason "..."
#
# 退出码: 0 成功/已上线无需登记;2 参数或前置不满足;3 拒绝(sha 未 push / 不在分支上 / 归属不符)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/v5-lease-lib.sh
source "$SCRIPT_DIR/v5-lease-lib.sh"

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

# 会话键:OC_SESSION_KEY 与 CCB OPENCLAUDE_SESSION_KEY 同源；只支持 webchat dm。
detect_session_key() {
  local sk="${OC_SESSION_KEY:-${OPENCLAUDE_SESSION_KEY:-}}"
  [[ -n "$sk" ]] || return 1
  [[ "$sk" =~ ^agent:[A-Za-z0-9_-]+:webchat:dm:[A-Za-z0-9_-]+$ ]] || return 1
  printf '%s\n' "$sk"
}

cmd_register() {
  local resource="" mode="ride" sha="" ticket="" callback="auto" owner="" uid="${OC_USER_ID:-}"
  local release_policy="" requested_mode=legacy result_meta="" allow_inflight=0 requested_cutover=wait
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --allow-inflight) allow_inflight=1; requested_cutover=allow; shift ;;
      --release-policy)
        [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || lease_die '--release-policy 缺值'
        [[ -z "$release_policy" ]] || lease_die '--release-policy 不能重复'
        [[ "$2" == user-impact-only ]] || lease_die '非法 --release-policy'
        release_policy="$2"; requested_mode=user-impact-only; shift 2 ;;
      --resource) resource="${2:-}"; shift 2 ;;
      --mode) mode="${2:-}"; shift 2 ;;
      --sha) sha="${2:-}"; shift 2 ;;
      --ticket) ticket="${2:-}"; shift 2 ;;
      --callback) callback="${2:-}"; shift 2 ;;
      --owner) owner="${2:-}"; shift 2 ;;
      --uid) uid="${2:-}"; shift 2 ;;
      *) lease_die "register 未知参数:$1" ;;
    esac
  done
  lease_valid_resource "$resource" || lease_die "非法 --resource:$resource(例:deploy:selfhost)"
  [[ "$resource" == "deploy:selfhost" ]] || lease_die "P1 仅支持 deploy:selfhost;其它资源待 P4"
  [[ "$mode" == ride ]] || lease_die "P1 仅支持 --mode ride;drive 待 P3"
  lease_valid_sha "$sha" || lease_die "--sha 必须是 40 位小写 sha"
  [[ "$uid" =~ ^[1-9][0-9]{0,18}$ ]] || lease_die "缺少/非法 uid(OC_USER_ID 未注入,或用 --uid)"
  [[ "$callback" == auto || "$callback" == none ]] || lease_die "--callback 必须是 auto|none"
  [[ -z "$ticket" || "$ticket" =~ ^[A-Z0-9]+-[0-9]+$ ]] || lease_die "--ticket 格式应为 OCV5-123"
  local sk_tail="${OC_SESSION_KEY:-${OPENCLAUDE_SESSION_KEY:-}}"; sk_tail="${sk_tail##*:}"
  owner="${owner:-$sk_tail}"; owner="${owner:-uid$uid}"
  lease_valid_label "$owner" || lease_die "非法 owner:$owner"

  # 1) sha 必须已在远端分支上(未 push 的 commit 列车带不上)。
  local tip
  git -C "$LEASE_REPO_ROOT" fetch -q origin "$LEASE_BRANCH" 2>/dev/null || lease_warn "fetch origin/$LEASE_BRANCH 失败,按本地 remote-tracking 判断"
  tip="$(lease_remote_tip)" || lease_die "读不到 origin/$LEASE_BRANCH"
  if ! lease_sha_contained "$sha" "$tip"; then
    echo "✗ 拒绝登记:${sha:0:12} 不在 origin/$LEASE_BRANCH(tip ${tip:0:12})上。先 push/ff-merge 再来。" >&2
    exit 3
  fi

  if [[ -n "$release_policy" ]]; then
    [[ "$sha" == "$tip" ]] || lease_die 'release-policy 必须绑定当前完整 publisher tip SHA'
    result_meta="$(jq -cn --arg sha "$sha" '{request:{releasePolicy:{schema:1,mode:"user-impact-only",sourceSha:$sha}}}')" || lease_die 'policy request 创建失败'
  fi

  if [[ "$allow_inflight" == 1 ]]; then
    [[ "$sha" == "$tip" ]] || lease_die '--allow-inflight 必须绑定当前完整 publisher tip SHA'
    local base_meta="$result_meta"; [[ -n "$base_meta" ]] || base_meta='{}'
    result_meta="$(jq -cn --arg sha "$sha" --argjson base "$base_meta" '$base | .request.cutover={schema:1,sourceSha:$sha,allowInflight:true}')" || lease_die 'cutover request 创建失败'
  fi

  # 2) live 已含 → 不建 lease,直接告知。
  local live_sha
  if live_sha="$(lease_live_committed_sha)" && lease_sha_contained "$sha" "$live_sha"; then
    echo "✓ 已上线:live $(lease_live_rel_path) sourceCommit ${live_sha:0:12} 已包含 ${sha:0:7}。"
    echo "▶ 无需登记。直接做发布后只读核验(v5-selfhost-post-deploy-verify)并收口本单。"
    return 0
  fi

  # 3) 回调落点。
  local sk="" cb_note
  if [[ "$callback" == auto ]]; then
    if sk="$(detect_session_key)"; then
      local agent sid response code kind payload
      agent="${sk#agent:}"; agent="${agent%%:*}"; sid="${sk##*:}"
      payload="$(jq -cn --arg uid "$uid" --arg sid "$sid" --arg agent "$agent" '{uid:$uid,sessionId:$sid,agentId:$agent}')"
      response="$(lease_callback_post /validate "$payload" 2>&1)" || {
        echo "✗ 原会话回调未就绪，未登记: ${response:0:200}" >&2; exit 3;
      }
      code="${response##*$'\n'}"; response="${response%$'\n'*}"
      kind="$(printf '%s' "$response" | jq -r '.kind // empty' 2>/dev/null || true)"
      [[ "$code:$kind" == 200:validated ]] || {
        echo "✗ 原会话归属/回调校验失败(http=$code kind=${kind:-?})，未登记。" >&2; exit 3;
      }
      cb_note="回调:已校验归属，结果将唤醒原会话 $sk；不可投递时明确降级到面板 ${ticket:-无单}"
    else
      sk=""
      if [[ -n "$ticket" ]]; then
        cb_note="回调:当前引擎未注入 OC_SESSION_KEY,降级为面板评论 $ticket"
      else
        lease_die "无会话键且无 --ticket：请传真实会话上下文，或显式 --callback none 仅记日志"
      fi
    fi
  else
    cb_note="回调:none(不唤醒会话；${ticket:+面板评论 $ticket}${ticket:-仅 worker 日志/status})"
  fi

  # Registration and exact policy idempotency share one SQLite transaction.
local id now receipt selected_id inserted lp_views
id="$(lease_new_id ls)"; now="$(lease_now)"
lp_views="$(lease_policy_views_sql "$resource")" || lease_die 'policy SQL准备失败'
receipt="$(lease_tx <<SQL
.bail on
BEGIN IMMEDIATE;
$lp_views
$(lease_inflight_views_sql)
INSERT INTO _lp_guard SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM _li_open WHERE inflight_mode<>'$requested_cutover') THEN 1 ELSE 0 END;
-- Reject malformed/same-SHA mixed mode before either insertion or idempotent return.
INSERT INTO _lp_guard SELECT CASE WHEN NOT EXISTS (
 SELECT 1 FROM _lp_open WHERE want_sha='$sha' AND policy_mode<>'$requested_mode'
) THEN 1 ELSE 0 END;
CREATE TEMP TABLE _lp_existing AS SELECT id,owner_uid FROM _lp_open
 WHERE want_sha='$sha' AND owner='$(lease_q "$owner")';
INSERT INTO _lp_guard SELECT CASE WHEN
 (SELECT count(*) FROM _lp_existing)<=1 AND NOT EXISTS (
  SELECT 1 FROM _lp_existing WHERE owner_uid<>'$(lease_q "$uid")'
 ) THEN 1 ELSE 0 END;
-- New explicit request cannot retrofit a running train. Identical existing request
-- remains a pure idempotent return and does not change callbacks or binding.
INSERT INTO _lp_guard SELECT CASE WHEN ('$requested_mode'='legacy' AND '$requested_cutover'='wait')
 OR EXISTS(SELECT 1 FROM _lp_existing)
 OR NOT EXISTS(SELECT 1 FROM train WHERE resource='$(lease_q "$resource")'
               AND status NOT IN ('committed','failed')) THEN 1 ELSE 0 END;
CREATE TEMP TABLE _lp_registration AS SELECT
 COALESCE((SELECT id FROM _lp_existing),'$id') AS id,
 NOT EXISTS(SELECT 1 FROM _lp_existing) AS inserted;
INSERT INTO lease(id,resource,mode,status,owner,owner_uid,callback_session_key,want_sha,
 ticket_ref,notify_deadline,result_json,created_at,updated_at)
SELECT '$id','$(lease_q "$resource")','$mode','registered','$(lease_q "$owner")',
 '$(lease_q "$uid")',
 $( [[ -n "$sk" ]] && printf "'%s'" "$(lease_q "$sk")" || printf NULL ),
 '$sha',$( [[ -n "$ticket" ]] && printf "'%s'" "$(lease_q "$ticket")" || printf NULL ),
 strftime('%Y-%m-%dT%H:%M:%SZ','now','+${LEASE_NOTIFY_DEADLINE_SECONDS} seconds'),
 $( [[ -n "$result_meta" ]] && printf "'%s'" "$(lease_q "$result_meta")" || printf NULL ),
 '$now','$now' WHERE (SELECT inserted FROM _lp_registration)=1;
INSERT INTO event(subject_id,event,actor,detail,created_at)
 SELECT '$id','registered','$(lease_q "$owner")',
 'resource=$(lease_q "$resource") sha=$sha policy=$requested_mode allow_inflight=$allow_inflight ticket=$(lease_q "$ticket")',
 '$now' WHERE (SELECT inserted FROM _lp_registration)=1;
COMMIT;
SELECT json_object('id',id,'inserted',inserted) FROM _lp_registration;
SQL
)" || lease_die '登记拒绝: request 不一致、混合 policy、迟到绑定或元数据/事务失败'
selected_id="$(jq -er '.id' <<<"$receipt")" || lease_die '非法登记 receipt'
inserted="$(jq -er '.inserted|tostring' <<<"$receipt")" || lease_die '非法登记 receipt'
if [[ "$inserted" == 0 ]]; then
 echo "= 已存在登记 $selected_id(同 sha/同 owner/同 policy),不重复建。"
 echo '▶ 结果沿原回调送达，不改回调归属。'
 return 0
fi
id="$selected_id"
  echo "✓ lease $id 已登记:$resource/$mode want=${sha:0:12} owner=$owner allow_inflight=$allow_inflight"
  echo "  $cb_note"
  echo "  当前: origin tip ${tip:0:12};live ${live_sha:-未知/未committed}"
  echo "▶ 请立即收口本回合。worker 每 30s 调度:锁空即发一班列车带上所有已登记 sha;结果将按上方实际回调落点送达；面板评论不等于原会话已唤醒。"
}

# Lifetime selfhost rates; running trains/retries do not enter terminal denominators.
lease_retry_metrics() {
  lease_sql "WITH t AS (
    SELECT count(*) terminal, sum(status='failed') failed FROM train
      WHERE resource='deploy:selfhost' AND status IN ('committed','failed')
  ), r AS (
    SELECT count(*) retries, coalesce(sum(result='committed'),0) succeeded,
      coalesce(sum(result IN ('failed','recovery_required')),0) failed,
      coalesce(sum(result='running'),0) pending FROM train_auto_retry
      WHERE resource='deploy:selfhost'
  ) SELECT json_object('terminalTrains',t.terminal,'failedTrains',coalesce(t.failed,0),
    'failureRate',1.0*t.failed/nullif(t.terminal,0),
    'retries',r.retries,'retrySucceeded',r.succeeded,'retryFailed',r.failed,
    'retryPending',r.pending,'retrySuccessRate',1.0*r.succeeded/nullif(r.succeeded+r.failed,0))
    FROM t,r;"
}

cmd_status() {
  local resource="" id="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --resource) resource="${2:-}"; shift 2 ;;
      --id) id="${2:-}"; shift 2 ;;
      --json) json=1; shift ;;
      *) lease_die "status 未知参数:$1" ;;
    esac
  done
  local where="1=1"
  [[ -n "$resource" ]] && where="$where AND resource='$(lease_q "$resource")'"
  [[ -n "$id" ]] && where="$where AND id='$(lease_q "$id")'"
  if [[ "$json" == 1 ]]; then
    echo '{"leases":'
    lease_sql_json "SELECT id,resource,mode,status,owner,substr(want_sha,1,12) want,ticket_ref,callback_session_key IS NOT NULL has_session_cb,created_at,updated_at,result_json FROM lease WHERE $where ORDER BY seq DESC LIMIT 50;" || echo '[]'
    echo ',"trains":'
    lease_sql_json "SELECT id,status,substr(target_sha,1,12) target,owner,executor_pid,rel_path,reason,created_at,finished_at FROM train ORDER BY seq DESC LIMIT 10;" || echo '[]'
    echo ',"outbox_pending":'
    lease_sql_json "SELECT id,kind,target_kind,target,attempts,next_attempt_at,last_error FROM outbox WHERE status='pending' ORDER BY created_at LIMIT 20;" || echo '[]'
    echo ',"auto_retry_metrics":'
    lease_retry_metrics
    echo ',"auto_retries":'
    lease_sql_json "SELECT target_sha,source_train_id,source_sha,retry_train_id,reason,result,created_at,finished_at FROM train_auto_retry WHERE resource='deploy:selfhost' ORDER BY created_at DESC LIMIT 20;"
    echo ',"retry_alerts":'
    lease_sql_json "SELECT train_id,owner_uid,reason,created_at,delivered_at,attempts,last_error FROM train_retry_alert ORDER BY created_at DESC LIMIT 20;"
    echo '}'
    return 0
  fi
  echo "── leases ──"
  lease_sql -header -column "SELECT id,mode,status,owner,substr(want_sha,1,10) want,ticket_ref tk,CASE WHEN callback_session_key IS NULL THEN '-' ELSE 'sess' END cb,updated_at FROM lease WHERE $where ORDER BY seq DESC LIMIT 30;"
  echo "── trains(最近 5)──"
  lease_sql -header -column "SELECT id,status,substr(target_sha,1,10) target,owner,executor_pid pid,reason,updated_at FROM train ORDER BY seq DESC LIMIT 5;"
  echo "── outbox pending ──"
  lease_sql -header -column "SELECT id,kind,target_kind,target,attempts,next_attempt_at,last_error FROM outbox WHERE status='pending' ORDER BY created_at LIMIT 10;"
  echo "── selfhost 自动重试(每 SHA 最多一次；全历史指标，rate 为 0–1) ──"
  lease_retry_metrics
  lease_sql -header -column "SELECT substr(target_sha,1,12) target,source_train_id,retry_train_id,reason,result FROM train_auto_retry WHERE resource='deploy:selfhost' ORDER BY created_at DESC LIMIT 10;"
  echo "── 停车站内告警(未投递持续保留) ──"
  lease_sql -header -column "SELECT train_id,owner_uid,reason,delivered_at,attempts,last_error FROM train_retry_alert ORDER BY created_at DESC LIMIT 10;"
  echo "── 权威事实 ──"
  echo "  origin tip : $(lease_remote_tip || echo ?)"
  echo "  live       : $(lease_live_rel_path) committed_sha=$(lease_live_committed_sha || echo '(未 committed / 不可结算)')"
  echo "  deploy proc: $(lease_deploy_process_running && echo running || echo none)"
}

cmd_cancel() {
  local id="" owner="${OC_SESSION_KEY:-}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;;
      --owner) owner="${2:-}"; shift 2 ;;
      *) lease_die "cancel 未知参数:$1" ;;
    esac
  done
  lease_valid_id "$id" || lease_die "非法 id:$id"
  local st
  st="$(lease_field "$id" status)"; [[ -n "$st" ]] || lease_die "lease 不存在:$id"
  [[ "$st" == registered ]] || lease_die "只有 registered 可 cancel:$id status=$st(granted 请 release)"
  lease_tx <<SQL
BEGIN IMMEDIATE;
UPDATE lease SET status='cancelled', updated_at='$(lease_now)' WHERE id='$id' AND status='registered';
$(lease_event_sql "$id" cancelled "${owner:-cli}" "")
COMMIT;
SQL
  echo "✓ $id 已取消"
}

cmd_train() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    list)
      lease_sql -header -column "SELECT id,status,substr(target_sha,1,12) target,owner,executor_pid pid,rel_path,reason,created_at,finished_at FROM train ORDER BY seq DESC LIMIT 20;" ;;
    resolve)
      local id="" as="" reason="" actor="${OC_SESSION_KEY:-}"
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --id) id="${2:-}"; shift 2 ;;
          --as) as="${2:-}"; shift 2 ;;
          --reason) reason="${2:-}"; shift 2 ;;
          --actor) actor="${2:-}"; shift 2 ;;
          *) lease_die "train resolve 未知参数:$1" ;;
        esac
      done
      lease_valid_train_id "$id" || lease_die "非法 train id:$id"
      [[ "$as" == committed || "$as" == failed ]] || lease_die "--as 必须是 committed|failed"
      [[ -n "$reason" ]] || lease_die "--reason 必填(人工恢复必须留痕)"
      local st; st="$(train_field "$id" status)"; [[ -n "$st" ]] || lease_die "train 不存在:$id"
      [[ "$st" == recovery_required || "$st" == planned || "$st" == building || "$st" == cutover ]] \
        || lease_die "train 已终态:$id status=$st"
      lease_tx <<SQL
BEGIN IMMEDIATE;
UPDATE train SET status='$as', reason='$(lease_q "manual-resolve: $reason")', finished_at='$(lease_now)', updated_at='$(lease_now)' WHERE id='$id';
$(lease_event_sql "$id" "resolved-$as" "${actor:-cli}" "$reason")
COMMIT;
SQL
      echo "✓ train $id → $as(worker 下个 tick 据 live 权威事实结算 ride;committed 不等于自动 satisfied)" ;;
    *) usage ;;
  esac
}

main() {
  lease_need_tool sqlite3; lease_need_tool git; lease_need_tool jq; lease_need_tool openssl
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    register) lease_with_lock cmd_register "$@" ;;
    status) lease_init_db; cmd_status "$@" ;;
    cancel) lease_with_lock cmd_cancel "$@" ;;
    train) lease_with_lock cmd_train "$@" ;;
    -h|--help|help|'') usage ;;
    *) lease_die "未知子命令:$cmd(register|status|cancel|train)" ;;
  esac
}
main "$@"
