#!/usr/bin/env bash
# v5-selfhost-autorecover.sh — selfhost 发布线自动恢复(OCV5-420)。由 v5-lease-worker.sh source,
# 每 tick 调一次 autorecover_tick(依赖 worker 已加载的 lease lib、wlog、transition_with_outbox、task_cli)。
#
# 纯 AI 项目没有人会来 train resolve / watch.sh --rearm / 跑应急恢复,所以以前停下来等人的三处
# 都由这里接管:
#   · train recovery_required(中途被打断,或补偿本身失败)
#   · .manual-recovery-required(cutover 两级补偿失败、看护 FAIL-LOUD / 两级兜底失败)
#   · watch-disarmed(看护停用)
# 做法:
#   1 不抢:发布进程在跑 / cutover survivor 还在 / 上一个恢复动作没结束 → 本 tick 不动。
#   2 用已安装看护的 watch.sh --auto-recover 做事(持发布锁):稳定绿 → 归档标记;红 → 两级兜底。
#      动作经 systemd-run 异步跑,不占 worker tick;结果下一 tick 读。
#   3 兜底按退避:立即、5 分钟、15 分钟,共 3 次;之后每 15 分钟只探测(--probe-only)。
#   4 绿了才把 recovery_required 列车结成 failed(actor autorecover),同 tip 的搭车随后自动重发
#      (= 重跑被打断的列车)。同一 target 24h 内自动重跑超过 2 次 → 搭车直接失败回调给登记它的会话。
#   5 兜底用完仍红,或事件超过 30 分钟未恢复 → 开一张 P1 工单并批准开工,PatrolEngine 派给 AI。
#      之后恢复了,在工单上留言「已自愈」。
# 告警只做记录(alert.sh info/warning/critical),不阻塞任何一步。

AR_STATE_DIR="${OC_V5_AUTORECOVER_DIR:-/var/lib/openclaude-v5-selfhost-watch/autorecover}"
AR_WATCH_BIN="${OC_V5_AUTORECOVER_WATCH_BIN:-/opt/openclaude/v5-selfhost-watch/watch.sh}"
AR_ALERT_BIN="${OC_V5_AUTORECOVER_ALERT_BIN:-/opt/openclaude/v5-selfhost-watch/alert.sh}"
AR_MANUAL_RECOVERY="${OC_V5_AUTORECOVER_MANUAL_RECOVERY:-/opt/openclaude/openclaude-v5-selfhost-releases/.manual-recovery-required}"
AR_DISARM="${OC_V5_AUTORECOVER_DISARM:-/opt/openclaude/v5-selfhost-watch/watch-disarmed}"
AR_ACTION_UNIT="${OC_V5_AUTORECOVER_ACTION_UNIT:-openclaude-v5-selfhost-autorecover-action}"
AR_SURVIVOR_UNIT="${OC_V5_AUTORECOVER_SURVIVOR_UNIT:-openclaude-v5-selfhost-cutover-watch.service}"
AR_SYSTEMD_RUN="${OC_V5_AUTORECOVER_SYSTEMD_RUN:-systemd-run}"
AR_SYSTEMCTL="${OC_V5_AUTORECOVER_SYSTEMCTL:-systemctl}"
AR_RESTORE_MAX="${OC_V5_AUTORECOVER_RESTORE_MAX:-3}"
AR_BACKOFF_SEC="${OC_V5_AUTORECOVER_BACKOFF_SEC:-0 300 900}"
AR_PROBE_EVERY_SEC="${OC_V5_AUTORECOVER_PROBE_EVERY_SEC:-900}"
AR_ESCALATE_AFTER_SEC="${OC_V5_AUTORECOVER_ESCALATE_AFTER_SEC:-1800}"
AR_RERUN_MAX="${OC_V5_AUTORECOVER_RERUN_MAX:-2}"
AR_PROJECT_ID="${OC_V5_AUTORECOVER_PROJECT_ID:-852859fa-cf1d-481c-96fd-23f2966b8b5f}"
AR_TASK_UID="${OC_V5_AUTORECOVER_TASK_UID:-3}"
AR_ACTOR="autorecover"
AR_INCIDENT="$AR_STATE_DIR/incident.env"
AR_RESULT="$AR_STATE_DIR/action.result"

ar_now() { if [[ -n "${AR_NOW_OVERRIDE:-}" ]]; then printf '%s' "$AR_NOW_OVERRIDE"; else date -u +%s; fi; }  # 覆盖只给测试
ar_log() { wlog "[autorecover] $*"; }

ar_get() { # <key>
  [[ -f "$AR_INCIDENT" ]] || return 0
  sed -n "s/^$1=//p" "$AR_INCIDENT" | tail -n1
}

ar_set() { # <key> <value>   原子改写 incident.env
  local tmp="$AR_INCIDENT.tmp.$$"
  { [[ -f "$AR_INCIDENT" ]] && grep -v "^$1=" "$AR_INCIDENT" || true; printf '%s=%s\n' "$1" "$2"; } >"$tmp"
  mv -f -- "$tmp" "$AR_INCIDENT"
}

ar_alert() { # <severity> <event> <message>   只记录,失败不影响恢复
  [[ -x "$AR_ALERT_BIN" ]] || return 0
  timeout 10 "$AR_ALERT_BIN" --event "$2" --severity "$1" --message "$3" >/dev/null 2>&1 || true
}

ar_backoff_for() { # <attempt-index 0..>
  local -a b; read -r -a b <<<"$AR_BACKOFF_SEC"
  if (( $1 < ${#b[@]} )); then printf '%s' "${b[$1]}"; else printf '%s' "${b[${#b[@]}-1]}"; fi
}

ar_unit_active() { [[ "$("$AR_SYSTEMCTL" is-active "$1" 2>/dev/null || true)" == active ]]; }

ar_recovery_trains() {
  lease_sql "SELECT id FROM train WHERE resource='$RESOURCE' AND status='recovery_required' ORDER BY seq;"
}

ar_incident_active() { # 输出原因列表;无事件则空
  local why="" t
  t="$(ar_recovery_trains)"
  [[ -n "$t" ]] && why="$why train:$(tr '\n' ',' <<<"$t" | sed 's/,$//')"
  [[ -e "$AR_MANUAL_RECOVERY" || -L "$AR_MANUAL_RECOVERY" ]] && why="$why manual-recovery"
  [[ -e "$AR_DISARM" || -L "$AR_DISARM" ]] && why="$why watch-disarmed"
  printf '%s' "${why# }"
}

# 绿之后把 recovery_required 列车结成 failed。worker 的「同 target 不重发」只认执行器自报的 train-failed,
# 这里的事件是 autorecover-resolved,所以搭车会自动重发 = 重跑被打断的列车;24h 内超过 AR_RERUN_MAX 次
# 就不再重跑,把在途搭车失败回调给登记它的会话 / 工单,并标记需要升级。
ar_resolve_trains() {
  local id target n rid detail
  while read -r id; do
    [[ -n "$id" ]] || continue
    target="$(train_field "$id" target_sha)"
    n="$(lease_sql "SELECT COUNT(*) FROM event e JOIN train t ON t.id=e.subject_id
           WHERE t.resource='$RESOURCE' AND t.target_sha='$(lease_q "$target")' AND e.event='autorecover-resolved'
             AND e.created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-86400 seconds');")"
    detail="autorecover: 复合健康已稳定绿,结束 recovery_required(第 $((n + 1)) 次,target ${target:0:12})"
    lease_tx <<SQL || { ar_log "train $id 结算写失败,下 tick 重试"; continue; }
BEGIN IMMEDIATE;
UPDATE train SET status='failed', reason='$(lease_q "$detail")', finished_at='$(lease_now)', updated_at='$(lease_now)'
 WHERE id='$(lease_q "$id")' AND status='recovery_required';
$(lease_event_sql "$id" autorecover-resolved "$AR_ACTOR" "$detail")
COMMIT;
SQL
    ar_log "train $id → failed($detail)"
    if (( n + 1 > AR_RERUN_MAX )); then
      while read -r rid; do
        [[ -n "$rid" ]] || continue
        transition_with_outbox "$rid" registered failed "target ${target:0:12} 自动重跑 $((n + 1)) 次仍未完成,停止重跑" \
          "$(lease_body_failed "$rid" "列车 $id 等同 target 已自动重跑 $((n + 1)) 次仍被打断/未完成" "autorecover 已开工单派给 AI;修复后 push 新 tip 再 register")"
      done < <(lease_sql "SELECT id FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride';")
      ar_set need_escalate "rerun-budget target=${target:0:12}"
    fi
  done < <(ar_recovery_trains)
}

ar_launch_action() { # <restore|probe-only>
  local arg="" mode="$1"
  [[ "$mode" == probe-only ]] && arg="--probe-only"
  if [[ ! -x "$AR_WATCH_BIN" ]]; then
    ar_log "缺已安装看护 $AR_WATCH_BIN,无法自动恢复"
    ar_set need_escalate "missing-watch"
    return 1
  fi
  rm -f -- "$AR_RESULT"
  # 结果写文件,下一 tick 读;transient unit 名唯一,天然防并发。
  "$AR_SYSTEMD_RUN" --unit="$AR_ACTION_UNIT" --collect --quiet \
    --property=Description='v5-selfhost autorecover action (OCV5-420)' \
    /bin/bash -c '"$1" --auto-recover $2 >"$3.log" 2>&1; rc=$?; printf "rc=%s\nout=%s\nat=%s\n" "$rc" "$(tail -n1 "$3.log")" "$(date -u +%s)" >"$3.tmp" && mv -f "$3.tmp" "$3"' \
    _ "$AR_WATCH_BIN" "$arg" "$AR_RESULT" >/dev/null 2>&1 \
    || { ar_log "systemd-run 启动恢复动作失败"; return 1; }
  ar_log "已启动恢复动作 mode=$mode"
}

ar_escalate() { # <why>
  local why="$1" title body out tid ver
  [[ -z "$(ar_get ticket)" ]] || return 0
  title="selfhost 自动恢复未收敛:$(ar_get reasons | cut -c1-80)"
  body="autorecover 自动升级(OCV5-420,无人值守)。

- 事件:$(ar_get id),开始 $(date -u -d "@$(ar_get started)" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || ar_get started)
- 触发:$(ar_get reasons)
- 升级原因:$why
- 已做:恢复动作 $(ar_get attempts) 次,最后结果 rc=$(ar_get last_rc) $(ar_get last_out)
- live:$(lease_live_rel_path)
- 现场:看护日志 /var/log/openclaude-v5-selfhost-watch.log;列车日志 /opt/openclaude/tmp/lease-trains/;cutover 日志 /opt/openclaude/tmp/cutover-*.log

autorecover 仍每 ${AR_PROBE_EVERY_SEC}s 探测一次,恢复后会在本单留言并自动归档标记、结束列车。请复现、定位、修复并走个人版发布。"
  if ! out="$(task_cli "$AR_TASK_UID" ticket create --project-id "$AR_PROJECT_ID" --type bug --priority P1 \
      --labels selfhost,release,autorecover --title "$title" --body "$body" 2>&1)"; then
    ar_log "升级开单失败(下 tick 重试): $(printf '%s' "$out" | tail -n1 | cut -c1-200)"
    return 1
  fi
  tid="$(jq -r '.ticket.identifier // empty' <<<"$out" 2>/dev/null || true)"
  ver="$(jq -r '.ticket.version // empty' <<<"$out" 2>/dev/null || true)"
  [[ -n "$tid" ]] || { ar_log "升级开单返回无 identifier"; return 1; }
  ar_set ticket "$tid"
  # 批准开工(backlog→ready,agent 可做);bug 首站是 AI 巡检站,PatrolEngine 会派给 AI。
  if [[ -n "$ver" ]] && task_cli "$AR_TASK_UID" ticket approve "$tid" --expected-version "$ver" --owner "agent:$AR_ACTOR" >/dev/null 2>&1; then
    ar_log "已升级 $tid 并批准开工"
  else
    ar_log "已升级 $tid(批准开工失败,留在待立项)"
  fi
  ar_alert critical autorecover_escalated "自动恢复未收敛,已开 $tid 派给 AI:$why"
}

ar_close_incident() {
  local tid
  tid="$(ar_get ticket)"
  if [[ -n "$tid" ]]; then
    task_cli "$AR_TASK_UID" ticket comment "$tid" --body "autorecover:事件 $(ar_get id) 已自愈(标记已归档、列车已结算),$(date -u +%Y-%m-%dT%H:%M:%SZ)。根因仍需按本单排查。" >/dev/null 2>&1 \
      || ar_log "自愈留言失败 $tid(不影响结束事件)"
  fi
  ar_alert info autorecover_closed "自动恢复事件 $(ar_get id) 已结束:$(ar_get reasons);动作 $(ar_get attempts) 次${tid:+;工单 $tid}"
  mkdir -p -- "$AR_STATE_DIR/history"
  mv -f -- "$AR_INCIDENT" "$AR_STATE_DIR/history/$(ar_get id 2>/dev/null || echo ar).env" 2>/dev/null || rm -f -- "$AR_INCIDENT"
  rm -f -- "$AR_RESULT"
  ar_log "事件结束"
}

# 测试隔离:lease.db 被改到别处(测试夹具)却没同时把 autorecover 状态目录改走,就什么都不做,
# 免得测试里造的 recovery_required 列车在宿主上触发真恢复动作。OC_V5_AUTORECOVER=off 显式关闭。
ar_enabled() {
  [[ "${OC_V5_AUTORECOVER:-on}" != off ]] || return 1
  if [[ "${LEASE_DB:-}" != /var/lib/openclaude-v5-selfhost/lease.db && -z "${OC_V5_AUTORECOVER_DIR:-}" ]]; then
    return 1
  fi
}

autorecover_tick() {
  local why now rc out attempts last mode delay
  ar_enabled || return 0
  mkdir -p -- "$AR_STATE_DIR" || return 0
  why="$(ar_incident_active)"
  if [[ -z "$why" ]]; then
    [[ -f "$AR_INCIDENT" ]] && ar_close_incident
    return 0
  fi
  now="$(ar_now)"
  if [[ ! -f "$AR_INCIDENT" ]]; then
    printf 'id=ar-%s\nstarted=%s\nattempts=0\nlast=0\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$now" >"$AR_INCIDENT"
    ar_log "新事件:$why"
    ar_alert warning autorecover_started "自动恢复接管:$why"
  fi
  ar_set reasons "$why"
  # 1 不抢
  if lease_deploy_process_running; then ar_log "发布在跑,等待"; return 0; fi
  if ar_unit_active "$AR_SURVIVOR_UNIT"; then ar_log "cutover survivor 仍在,等待"; return 0; fi
  if ar_unit_active "$AR_ACTION_UNIT.service"; then ar_log "上一个恢复动作仍在跑"; return 0; fi
  # 2 读上一个动作结果
  if [[ -f "$AR_RESULT" ]]; then
    rc="$(sed -n 's/^rc=//p' "$AR_RESULT" | head -n1)"
    out="$(sed -n 's/^out=//p' "$AR_RESULT" | head -n1)"
    rm -f -- "$AR_RESULT"
    ar_set last_rc "${rc:-?}"; ar_set last_out "$(printf '%s' "$out" | tr -cd '[:print:]' | cut -c1-120)"
    ar_log "恢复动作结果 rc=${rc:-?} $out"
    if [[ "$rc" == 0 ]]; then
      ar_resolve_trains
      [[ -n "$(ar_get need_escalate)" ]] && ar_escalate "$(ar_get need_escalate)"
      return 0   # 标记已由动作归档;下一 tick 若无事件即结束
    fi
    if [[ "$rc" == 75 ]]; then  # 现在不能动(锁/窗口),不计次数,下 tick 再来
      attempts="$(ar_get attempts)"; ar_set attempts "$(( ${attempts:-1} > 0 ? ${attempts:-1} - 1 : 0 ))"; ar_set last 0
      return 0
    fi
  fi
  # 3 升级判定
  attempts="$(ar_get attempts)"; attempts="${attempts:-0}"
  last="$(ar_get last)"; last="${last:-0}"
  if [[ -n "$(ar_get need_escalate)" ]]; then
    ar_escalate "$(ar_get need_escalate)"
  elif (( attempts >= AR_RESTORE_MAX )) && [[ "$(ar_get last_rc)" != 0 ]]; then
    ar_escalate "两级兜底已自动重试 $attempts 次仍未恢复"
  elif (( now - $(ar_get started) >= AR_ESCALATE_AFTER_SEC )); then
    ar_escalate "事件超过 ${AR_ESCALATE_AFTER_SEC}s 未恢复"
  fi
  # 4 退避后发下一次动作
  if (( attempts < AR_RESTORE_MAX )); then
    mode=restore; delay="$(ar_backoff_for "$attempts")"
  else
    mode=probe-only; delay="$AR_PROBE_EVERY_SEC"
  fi
  (( now - last >= delay )) || return 0
  if ar_launch_action "$mode"; then
    ar_set attempts "$((attempts + 1))"
    ar_set last "$now"
  fi
}
