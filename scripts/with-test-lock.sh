#!/usr/bin/env bash
# 机器级 commercial 测试互斥锁 + 进程组清理。
#
# 根因(2026-07-10 事故): 本机所有 worktree 的 commercial 测试共享同一个 *_test PG 库,
# 测试用 TRUNCATE...CASCADE 重置 —— 多个会话/agent 并发跑时互相截断数据、等待表锁,
# 测试**挂死而非快速失败**;叠加 `timeout npx tsx` 只杀 npx 包装、tsx 派生的 node 子进程
# 成孤儿继续持有 PG 连接/端口,机器进入"中毒"状态,后续任何运行都会挂。
# 「双树 commercial 不可并发跑」此前只是 playbook 红线,无机制 enforcement,每个并行
# 会话都要各自撞一次坑 —— 本脚本把红线变成机制:后来者自动排队,而不是互相锁死。
#
# 用法: with-test-lock.sh <command...>
#   - flock 全局锁(/tmp/openclaude-commercial-tests.lock),已有运行则打印持锁者并等待;
#   - setsid 起独立进程组,退出(含被 TERM/超时)时整组清理,孤儿不再残留;
#   - 持锁进程死亡(含 SIGKILL)时 fd 关闭,flock 自动释放,无死锁残留。
set -uo pipefail

LOCK=/tmp/openclaude-commercial-tests.lock
exec 9>>"$LOCK"
if ! flock -n 9; then
  holder=$(cat "${LOCK}.holder" 2>/dev/null || echo "unknown")
  echo "[with-test-lock] 另一处 commercial 测试正在运行(${holder}),排队等待…" >&2
  flock 9
fi
echo "pid=$$ cwd=$(pwd) at=$(date -Is)" >"${LOCK}.holder"

# 独立进程组:wrapper 收到 TERM/INT 或正常退出时,整组(npx→tsx→node 全链)一起清,
# 消灭「timeout 杀了包装、node 孤儿抱锁不放」这一类残留。
# 用 set -m(作业控制)而非 setsid:setsid 在非组长场景会 fork,$! 不是真实的
# session/组长 pid,组杀会落空;set -m 下后台作业的 pgid 恒等于 $!,确定性成立。
set -m
"$@" &
child=$!
cleanup() {
  kill -TERM -- "-$child" 2>/dev/null
  sleep 1
  kill -KILL -- "-$child" 2>/dev/null
}
trap cleanup INT TERM
wait "$child"
rc=$?
cleanup
exit "$rc"
