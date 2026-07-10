#!/usr/bin/env bash
# test-mutex.sh — 跨 worktree 测试互斥(硬机制)。
#
# 背景(2026-07-10):两个并行会话各自 worktree 同时跑 commercial 测试,共享的
# octest PG(schema DROP/CREATE)与固定端口互相毒化,表现为测试无限挂死/随机失败,
# 极难与真回归区分(当天误诊 2 小时)。此前只有记忆条目"双树 commercial 不可并发跑"
# —— boss 裁决:并发安全必须写死在机制里,不靠会话记忆自觉。
#
# 用法:  scripts/test-mutex.sh <lock-name> '<command string>'
# 语义:  /var/lock/oc-test-<lock-name>.lock 上 flock 串行;锁被占时打印持有者
#        (pid/worktree/命令/起始时刻)并等待 ≤1800s,超时 fail-loud(exit 3)。
#        持有进程退出(含被杀)即自动放锁 —— flock 是内核级,无 stale lock 问题;
#        .holder 只是诊断信息,可能残留,以 flock 实际状态为准。
# CI:    GitHub runner 单树无并发,锁总是立即取得,零影响。
set -euo pipefail

name="${1:?usage: test-mutex.sh <lock-name> '<command>'}"
cmd="${2:?usage: test-mutex.sh <lock-name> '<command>'}"
lock="/var/lock/oc-test-${name}.lock"

exec 9>"$lock" 2>/dev/null || {
  # 无 /var/lock 写权限的环境(某些 CI 沙箱)降级为直接执行——单树环境本就无并发。
  echo "[test-mutex] 无法打开 $lock,视为单树环境直接执行" >&2
  exec bash -c "$cmd"
}

if ! flock -n 9; then
  echo "⏳ [test-mutex] 锁 ${name} 被占:$(cat "${lock}.holder" 2>/dev/null || echo '持有者未知')" >&2
  echo "   另一 worktree 正在跑同族测试(共享 octest PG/端口),等待释放(≤1800s)..." >&2
  flock -w 1800 9 || {
    echo "✗ [test-mutex] 1800s 未取得锁 ${name} —— 持有方测试可能挂死;核查 ${lock}.holder 与 'ps -eo pid,etime,cmd | grep tsx' 后处置" >&2
    exit 3
  }
fi
printf 'pid=%s tree=%s started=%s cmd=%s\n' "$$" "$PWD" "$(date -Is)" "$cmd" > "${lock}.holder"

# 进程组清理(2026-07-10 第二根因):`timeout npx tsx` 只杀 npx 包装,tsx 派生的 node
# 子进程成孤儿抱着 PG 连接/端口不放 → 机器"中毒"、锁被一直占。set -m 让整条命令跑在
# 独立进程组(pgid == $!,确定性;不用 setsid——非组长场景它会 fork,$! 不是真实组长,
# 组杀落空),wrapper 退出/被杀时整组 TERM→KILL,实测含孙进程零残留、退出码透传。
set -m
bash -c "$cmd" &
child=$!
cleanup() {
  # 组已消亡(正常退出的常态)→ 立即返回:不空等 1s,也不让失败的 kill 在 set -e 下
  # 中断 trap(那会把真实退出码吃成 1)。
  kill -TERM -- "-$child" 2>/dev/null || return 0
  sleep 1
  kill -KILL -- "-$child" 2>/dev/null || true
}
trap 'cleanup; rm -f "${lock}.holder"' EXIT INT TERM
wait "$child" && rc=0 || rc=$?
exit "$rc"
