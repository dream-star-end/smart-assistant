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
JOURNAL_VACUUM="500M"

emit() { # emit <outcome> <exit_code> <detail-json>
  printf '{"opcode":"%s","outcome":"%s","exit":%s,"detail":%s,"at":"%s"}\n' \
    "$OPCODE" "$1" "$2" "${3:-null}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# opcode 必须是单 token 版本化标识,禁一切参数/空格/元字符。
if [[ ! "$OPCODE" =~ ^[a-z0-9-]+$ ]]; then
  emit rejected 64 '{"reason":"opcode must be a single versioned token, no args"}'
  exit 64
fi

case "$OPCODE" in
  capabilities-v1)
    # 三层交集握手:本执行器支持的 opcode 清单(broker 启动/首用时核对)。
    emit ok 0 '{"capabilities":["restart-v5-egress-v1","clean-v5-disk-v1"]}'
    exit 0
    ;;

  restart-v5-egress-v1)
    out="$(systemctl restart "$EGRESS_UNIT" 2>&1)"; rc=$?
    if [ "$rc" -eq 0 ]; then
      emit completed 0 "$(printf '{"unit":"%s"}' "$EGRESS_UNIT")"
      exit 0
    fi
    esc="$(printf '%s' "$out" | tail -c 400 | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')"
    emit failed "$rc" "$(printf '{"unit":"%s","stderr":"%s"}' "$EGRESS_UNIT" "$esc")"
    exit "$rc"
    ;;

  clean-v5-disk-v1)
    # 固定步骤、固定上限,绝不接受调用方参数。docker 只 prune 对象(NEVER
    # --volumes:卷含真实数据是红线);journal 定量回收。
    d_out="$(docker system prune -f 2>&1)"; d_rc=$?
    j_out="$(journalctl --vacuum-size="$JOURNAL_VACUUM" 2>&1)"; j_rc=$?
    if [ "$d_rc" -eq 0 ] && [ "$j_rc" -eq 0 ]; then
      recl="$(printf '%s' "$d_out" | grep -oE 'Total reclaimed space: .*' | tail -1 | sed 's/"/\\"/g')"
      emit completed 0 "$(printf '{"docker":"%s","journal_vacuum":"%s"}' "${recl:-0}" "$JOURNAL_VACUUM")"
      exit 0
    fi
    emit failed 1 "$(printf '{"docker_rc":%s,"journal_rc":%s}' "$d_rc" "$j_rc")"
    exit 1
    ;;

  *)
    emit rejected 65 '{"reason":"unknown opcode"}'
    exit 65
    ;;
esac
