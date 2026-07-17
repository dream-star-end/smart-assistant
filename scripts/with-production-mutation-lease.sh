#!/usr/bin/env bash
# with-production-mutation-lease.sh — 人工运维包装器(RFC-v5-selfheal-batch1b §1.2 MAJOR4)。
#
# 非 deploy-v5.sh 的生产变更(人工 migration apply / env 同步 / systemd 单元安装或改动 /
# runtime image build+tag 切换等)也必须与自愈 host-action + deploy 互斥,否则"绝不冲突"不成立。
# 本包装器前台取得**同一把** kl-mirror production-mutation lease,持有整个命令执行期,命令退出/
# 中断即释放(kill 后台 ssh → 远端 flock 随通道关闭释放)。
#
# 用法:
#   scripts/with-production-mutation-lease.sh <cmd> [args...]
# 例:
#   scripts/with-production-mutation-lease.sh psql "$DATABASE_URL" -f migrations/0160_x.sql
#   scripts/with-production-mutation-lease.sh ssh kl-mirror 'systemctl daemon-reload'
#
# 锁与 deploy-v5.sh 的远端 lease 是同一路径(PRODUCTION_MUTATION_LOCK),故与部署/自愈天然互斥。
# 与本地 /var/lock/oc-v5-deploy.lock 正交:本包装器不碰本地部署锁(它保护的是 deploy-v5.sh
# 自身的多实例串行,人工变更不经 deploy-v5.sh)。紧急旁路:OC_V5_SKIP_MUTATION_LEASE=1(loud warning)。
set -euo pipefail

KL_HOST="${KL_HOST:-kl-mirror}"
PRODUCTION_MUTATION_LOCK="/run/openclaude-v5/production-mutation.lock"

[[ $# -ge 1 ]] || { echo "用法: with-production-mutation-lease.sh <cmd> [args...]" >&2; exit 2; }

if [[ "${OC_V5_SKIP_MUTATION_LEASE:-0}" == 1 ]]; then
  echo "⚠⚠⚠ WARNING: OC_V5_SKIP_MUTATION_LEASE=1 —— 跳过 kl-mirror PRODUCTION-MUTATION LEASE。" >&2
  echo "⚠⚠⚠ 本次人工变更不与部署/自愈 host-action 互斥。仅限 runbook 明确记载的紧急旁路。" >&2
  exec "$@"
fi

LEASE_PID=""
LEASE_OUT=""
cleanup() {
  local rc=$?
  trap - EXIT
  if [[ -n "$LEASE_PID" ]]; then
    kill "$LEASE_PID" 2>/dev/null || true
    wait "$LEASE_PID" 2>/dev/null || true
  fi
  [[ -n "$LEASE_OUT" ]] && rm -f "$LEASE_OUT"
  exit "$rc"
}
trap cleanup EXIT INT TERM

LEASE_OUT="$(mktemp "${TMPDIR:-/tmp}/oc-v5-manual-lease.XXXXXX")"
# 后台 ssh:远端 shell 自身持 flock。不能 exec sleep infinity:OpenSSH
# 断链时 sleep 可能被 PID 1 收养并永久保留 fd9。holder 每秒从 /proc
# 读取实时 PPid；sshd session parent 消失/reparent 后立即退出释放锁。
# 本 wrapper 没有 deploy lane 的 fencing meta/TTL；若前台被 SIGKILL、后台
# 本地 ssh 本身仍存活，lease 会继续持有到该 ssh 退出，这是既有运维边界。
REMOTE_HOLDER="mkdir -p -m 700 '$(dirname "$PRODUCTION_MUTATION_LOCK")' 2>/dev/null || true
exec 9>'$PRODUCTION_MUTATION_LOCK'
trap 'exit 0' HUP INT TERM
# 必须在可能阻塞的 flock 前快照 sshd session parent。若通道在等待锁时
# 断开，holder 随后被 PID 1 收养，取锁后会因 /proc PPid 不匹配而退出。
lease_parent=\"\$PPID\"
case \"\$lease_parent\" in ''|*[!0-9]*) exit 76 ;; esac
[ \"\$lease_parent\" -gt 1 ] || exit 76
kill -0 \"\$lease_parent\" 2>/dev/null || exit 76
flock -w 60 9 || exit 75
current_parent=\"\$(awk '/^PPid:/{print \$2; exit}' \"/proc/\$\$/status\" 2>/dev/null)\" || exit 76
case \"\$current_parent\" in ''|*[!0-9]*) exit 76 ;; esac
[ \"\$current_parent\" = \"\$lease_parent\" ] || exit 76
kill -0 \"\$lease_parent\" 2>/dev/null || exit 76
echo LEASED
while :; do
  current_parent=\"\$(awk '/^PPid:/{print \$2; exit}' \"/proc/\$\$/status\" 2>/dev/null)\" || exit 0
  case \"\$current_parent\" in ''|*[!0-9]*) exit 0 ;; esac
  [ \"\$current_parent\" = \"\$lease_parent\" ] || exit 0
  kill -0 \"\$lease_parent\" 2>/dev/null || exit 0
  sleep 1
done"
ssh "$KL_HOST" "$REMOTE_HOLDER" </dev/null >"$LEASE_OUT" 2>/dev/null &
LEASE_PID=$!

got=0 waited=0
while (( waited < 90 )); do
  if grep -q LEASED "$LEASE_OUT" 2>/dev/null; then got=1; break; fi
  kill -0 "$LEASE_PID" 2>/dev/null || break
  sleep 1; waited=$((waited + 1))
done

if [[ "$got" != 1 ]]; then
  echo "✗ 未取得 kl-mirror production-mutation lease(远端 flock -w 60 竞争超时 / ssh 失败 / 90s 无 LEASED)。" >&2
  echo "  可能有部署 / 自愈 host-action / 另一人工变更正持锁;稍后重试或核查 $KL_HOST:$PRODUCTION_MUTATION_LOCK。" >&2
  exit 3
fi

echo "  ✓ 持有 kl-mirror production-mutation lease(后台 ssh pid=$LEASE_PID),执行:$*" >&2
"$@"
