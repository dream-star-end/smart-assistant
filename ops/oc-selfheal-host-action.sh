#!/usr/bin/env bash
# oc-selfheal-host-action — kl-mirror 侧 Tier1 运维动作执行器(SSH forced-command)。
#
# 部署:kl-mirror:/usr/local/sbin/oc-selfheal-host-action(root:root 0755),
#       ~/.ssh/authorized_keys 用专用 selfheal-action key 配:
#         restrict,command="/usr/local/sbin/oc-selfheal-host-action" <pubkey>
#
# 信任模型(三层白名单的最外层):个人版 broker 是唯一的 condition→opcode 策略
# 权威;本执行器只认识**版本化、无参数**的 opcode,不认识 condition/policy。
# 命令来自 $SSH_ORIGINAL_COMMAND(forced-command 下客户端请求的命令串),必须
# 精确匹配下列 opcode 之一;任何参数/未知 opcode/shell 元字符一律拒绝。
# 三层取交集(master policy ∩ 个人版 exact map ∩ 本表),任一漂移 fail-closed。
#
# 输出:恒一行 JSON 到 stdout(broker 解析 receipt);exit code = 动作结果
#       (0=完成,非0=失败;拒绝类 opcode 用 64/65 区分)。
set -uo pipefail

OPCODE="${SSH_ORIGINAL_COMMAND:-${1:-}}"
EGRESS_UNIT="openclaude-v5-egress.service"
V5_ENV="${OC_SELFHEAL_V5_ENV:-/etc/openclaude/commercial-v5.env}"
MASTER_TOTAL_TIMEOUT="${OC_SELFHEAL_MASTER_TOTAL_TIMEOUT:-55}"
# Leave five seconds of transport/receipt margin inside the broker's 90s SSH
# deadline. This budget covers state reads + restart + both health proofs.
if [[ ! "$MASTER_TOTAL_TIMEOUT" =~ ^[1-9][0-9]?$ ]] || (( MASTER_TOTAL_TIMEOUT > 55 )); then
  MASTER_TOTAL_TIMEOUT=55
fi

emit() { # emit <outcome> <exit_code> <detail-json>
  printf '{"opcode":"%s","outcome":"%s","exit":%s,"detail":%s,"at":"%s"}\n' \
    "$OPCODE" "$1" "$2" "${3:-null}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# ── 互斥正确性来源 = production-mutation lease(flock,见 acquire_mutation_lease)──
# 批1b 起,每个 mutating opcode 执行前对 /run/openclaude-v5/production-mutation.lock
# 取非阻塞 flock(见下方 acquire_mutation_lease),与 deploy-v5.sh 的远端写 lane 争用
# **同一把锁**;跨部署/自愈的互斥正确性由该 lease 保证——自愈的 ssh 动作现在会被
# 正在收尾的 deploy 持锁挡下(下面旧注释担心的"ssh 动作拦不住它"已由 lease 根治)。
# 因此下面的 maintenance marker 检查**回归本职:只做告警隔离**(RFC §1.2),不再承担
# 互斥正确性,仅作为过渡冗余保留(marker TTL 180s 早于 lease 建立/收尾更久那段边缘
# 窗口的双保险/灰度期便于观测)。
#
# ── 与正常部署/开发的协调(过渡冗余:marker 告警隔离)──────────────────
# 第一道闸在 monitor:planned-maintenance 窗口内的 check 不投影 condition,自愈
# 根本不会被派单。但 marker TTL 只有 180s,而部署收尾/失败/回滚可能更久:那个
# 边缘窗口里 monitor 会重新写 firing,自愈就可能和正在收尾的部署**抢着重启同一
# 个服务**(自愈的 ssh 动作不走 sg 本机的 deploy 锁,拦不住它)。
# 因此 marker 活跃期内**任何 opcode 一律让路**——自愈延迟一轮
# (monitor 2min tick)无害,真故障下一轮会再被探到。
MAINT_MARKER="${OC_SELFHEAL_MAINT_MARKER:-/run/openclaude-v5/planned-maintenance.json}"
maintenance_active() {
  [ -f "$MAINT_MARKER" ] || return 1
  local schema deadline now
  schema="$(jq -r '.schema // 0' "$MAINT_MARKER" 2>/dev/null || echo 0)"
  [ "$schema" = 2 ] || return 1
  deadline="$(jq -r '.deadline // 0' "$MAINT_MARKER" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  [ "$deadline" -gt "$now" ] 2>/dev/null
}
stand_down_if_maintenance() { # 退出码 66 = 为部署让路(与 64/65 同属"未获准执行"族)
  maintenance_active || return 0
  local mode target
  mode="$(jq -r '.mode // "?"' "$MAINT_MARKER" 2>/dev/null || echo '?')"
  target="$(jq -r '.target_commit // "?"' "$MAINT_MARKER" 2>/dev/null | cut -c1-12)"
  emit rejected 66 "$(printf '{"reason":"planned maintenance active - standing down for deploy","mode":"%s","target":"%s"}' "$mode" "$target")"
  exit 66
}

# ── production-mutation lease(批1b:跨部署/自愈互斥的**唯一正确性来源**)────────
# 在 mutating opcode 执行前取非阻塞 flock,持有到进程退出(fd 9 一直开着 = 一直持有,
# 绝不 flock -u)。与 deploy-v5.sh 的远端写 lane 争用同一把锁——deploy 持锁时自愈让路。
# lease 目录可能尚不存在 → best-effort 创建;无法创建/打开锁 = fail-closed → rejected 66
#(绝不在无 lease 的情况下继续执行 opcode)。busy 与 marker 让路同族,统一用 exit 66。
acquire_mutation_lease() {
  local dir="/run/openclaude-v5"
  local lease="${OC_SELFHEAL_MUTATION_LEASE:-$dir/production-mutation.lock}"
  mkdir -p "$dir" 2>/dev/null || true
  # exec 的重定向失败在 `if !` 条件里会被捕获(返回非零),不会让脚本静默退出;
  # 因此这里能 fail-closed 地 emit 后再 exit,而不是被 redirect error 直接掐断。
  if ! exec 9>"$lease"; then
    emit rejected 66 "$(printf '{"reason":"cannot open production-mutation lease (fail-closed)","lease":"%s"}' "$lease")"
    exit 66
  fi
  if ! flock -n 9; then
    emit rejected 66 "$(printf '{"reason":"production-mutation lease busy: deploy/mutation in progress","lease":"%s"}' "$lease")"
    exit 66
  fi
}

MASTER_ACTION_DEADLINE=0
start_master_action_budget() {
  MASTER_ACTION_DEADLINE=$(( $(date +%s) + MASTER_TOTAL_TIMEOUT ))
}

remaining_master_seconds() {
  local remaining=$(( MASTER_ACTION_DEADLINE - $(date +%s) ))
  (( remaining > 0 )) || return 1
  printf '%s\n' "$remaining"
}

bounded_master_command() { # <per-command-cap-seconds> <command...>
  local cap="$1" remaining
  shift
  remaining="$(remaining_master_seconds)" || return 124
  (( remaining < cap )) && cap="$remaining"
  timeout --signal=TERM "$cap" "$@"
}

reject_master_action() { # <reason>
  emit rejected 66 "$(printf '{"reason":"%s"}' "$1")"
  exit 66
}

read_stable_active_master() {
  [ -r "$V5_ENV" ] || reject_master_action "v5 env unreadable"

  local row rc phase active candidate extra dburl
  dburl="$(
    set -a
    # shellcheck disable=SC1090
    . "$V5_ENV"
    set +a
    printf '%s' "${DATABASE_URL:-}"
  )"
  [ -n "$dburl" ] || reject_master_action "DATABASE_URL missing"
  row="$(bounded_master_command 5 psql "$dburl" -X -v ON_ERROR_STOP=1 -tA -F '|' -c \
    "SELECT phase,active_slot,COALESCE(candidate_slot,'') FROM deploy_state WHERE singleton=true")"
  rc=$?
  [ "$rc" -eq 0 ] || reject_master_action "deploy_state query failed"
  [[ -n "$row" && "$row" != *$'\n'* ]] || reject_master_action "deploy_state row count invalid"

  IFS='|' read -r phase active candidate extra <<<"$row"
  [[ -z "${extra:-}" && "$phase" == stable && -z "$candidate" ]] \
    || reject_master_action "deploy_state is not stable without candidate"
  case "$active" in
    A)
      MASTER_SLOT=A
      MASTER_UNIT="openclaude-v5.service"
      MASTER_HEALTH_URL="http://127.0.0.1:18790/healthz"
      ;;
    B)
      MASTER_SLOT=B
      MASTER_UNIT="openclaude-v5-b.service"
      MASTER_HEALTH_URL="http://127.0.0.1:18795/healthz"
      ;;
    *)
      reject_master_action "deploy_state active_slot invalid"
      ;;
  esac
}

read_master_unit_state() {
  local raw rc load active sub
  raw="$(bounded_master_command 5 systemctl show --no-pager \
    --property=LoadState --property=ActiveState --property=SubState "$MASTER_UNIT" 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] || reject_master_action "systemd unit state query failed"
  if [ "$(printf '%s\n' "$raw" | grep -c '^LoadState=')" -ne 1 ] \
    || [ "$(printf '%s\n' "$raw" | grep -c '^ActiveState=')" -ne 1 ] \
    || [ "$(printf '%s\n' "$raw" | grep -c '^SubState=')" -ne 1 ]; then
    reject_master_action "systemd unit state response invalid"
  fi
  load="$(printf '%s\n' "$raw" | sed -n 's/^LoadState=//p')"
  active="$(printf '%s\n' "$raw" | sed -n 's/^ActiveState=//p')"
  sub="$(printf '%s\n' "$raw" | sed -n 's/^SubState=//p')"
  case "$load:$active:$sub" in
    loaded:active:*)
      MASTER_UNIT_ACTION=noop
      ;;
    loaded:inactive:dead|loaded:failed:failed)
      MASTER_UNIT_ACTION=restart
      ;;
    *)
      reject_master_action "systemd unit state is not safely restartable"
      ;;
  esac
}

master_health_ok() {
  local private public
  private="$(bounded_master_command 3 curl --noproxy '*' -fsS "$MASTER_HEALTH_URL" 2>/dev/null)" \
    || return 1
  printf '%s' "$private" | jq -e '.ok == true and .channel == "v5"' >/dev/null 2>&1 || return 1
  PRIVATE_HEALTH_OK=1
  public="$(bounded_master_command 3 curl --noproxy '*' -fsS -H 'Host: claudeai.chat' \
    'http://127.0.0.1/healthz' 2>/dev/null)" || return 1
  printf '%s' "$public" | jq -e '.ok == true and .channel == "v5"' >/dev/null 2>&1 || return 1
  PUBLIC_HEALTH_OK=1
}

# opcode 必须是单 token 版本化标识,禁一切参数/空格/元字符。
if [[ ! "$OPCODE" =~ ^[a-z0-9-]+$ ]]; then
  emit rejected 64 '{"reason":"opcode must be a single versioned token, no args"}'
  exit 64
fi

case "$OPCODE" in
  capabilities-v1)
    # 三层交集握手:本执行器支持的 opcode 清单(broker 启动/首用时核对)。
    emit ok 0 '{"capabilities":["restart-v5-egress-v1","ensure-v5-active-master-v1"]}'
    exit 0
    ;;

  restart-v5-egress-v1)
    stand_down_if_maintenance   # 过渡冗余告警隔离(互斥正确性来自下面的 lease)
    acquire_mutation_lease      # 持有 lease 直到进程退出,包住整个 opcode
    out="$(systemctl restart "$EGRESS_UNIT" 2>&1)"; rc=$?
    if [ "$rc" -eq 0 ]; then
      emit completed 0 "$(printf '{"unit":"%s"}' "$EGRESS_UNIT")"
      exit 0
    fi
    esc="$(printf '%s' "$out" | tail -c 400 | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')"
    emit failed "$rc" "$(printf '{"unit":"%s","stderr":"%s"}' "$EGRESS_UNIT" "$esc")"
    exit "$rc"
    ;;

  ensure-v5-active-master-v1)
    stand_down_if_maintenance
    acquire_mutation_lease
    start_master_action_budget
    # The active slot and exact systemd state are resolved only after taking the
    # same production-mutation lease as deploy-v5.sh. Active is a no-op: HTTP,
    # PG, and Redis failures are not process-crash evidence and never trigger a
    # blind restart. Only exact inactive/dead or failed/failed is restartable.
    read_stable_active_master
    read_master_unit_state
    if [ "$MASTER_UNIT_ACTION" = noop ]; then
      emit completed 0 "$(printf '{"action":"noop","slot":"%s","unit":"%s","reason":"unit active"}' \
        "$MASTER_SLOT" "$MASTER_UNIT")"
      exit 0
    fi

    out="$(bounded_master_command 15 systemctl restart "$MASTER_UNIT" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then
      diag="$(printf '%s' "$out" | tail -c 400 | tr '\n' ' ')"
      printf '[selfheal-host-action] restart %s failed rc=%s: %s\n' \
        "$MASTER_UNIT" "$rc" "$diag" >&2
      emit failed "$rc" "$(printf '{"action":"restart","slot":"%s","unit":"%s","reason":"restart failed"}' \
        "$MASTER_SLOT" "$MASTER_UNIT")"
      exit "$rc"
    fi

    PRIVATE_HEALTH_OK=0
    PUBLIC_HEALTH_OK=0
    while :; do
      if master_health_ok; then
        emit completed 0 "$(printf '{"action":"restart","slot":"%s","unit":"%s","privateHealth":true,"publicHealth":true}' \
          "$MASTER_SLOT" "$MASTER_UNIT")"
        exit 0
      fi
      remaining="$(remaining_master_seconds)" || break
      if (( remaining < 2 )); then sleep "$remaining"; else sleep 2; fi
    done
    private_health=false
    public_health=false
    [ "$PRIVATE_HEALTH_OK" -eq 1 ] && private_health=true
    [ "$PUBLIC_HEALTH_OK" -eq 1 ] && public_health=true
    emit failed 70 "$(printf '{"action":"restart","slot":"%s","unit":"%s","reason":"health timeout","privateHealth":%s,"publicHealth":%s}' \
      "$MASTER_SLOT" "$MASTER_UNIT" "$private_health" "$public_health")"
    exit 70
    ;;

  *)
    emit rejected 65 '{"reason":"unknown opcode"}'
    exit 65
    ;;
esac
