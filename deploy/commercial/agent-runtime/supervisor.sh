#!/usr/bin/env bash
# ------------------------------------------------------------
# agent-runtime 容器内 supervisor
# ------------------------------------------------------------
# 职责(现阶段 = MVP / T-51 占位):
#   1. 把容器保持在 running 状态,等待 T-52 的 RPC server 实现
#   2. 捕获 SIGTERM / SIGINT,干净退出(让 docker stop 在 5s 内就绪,而不是等
#      10s 强 SIGKILL)
#   3. 暴露简单的健康信息到 stdout,便于 `docker logs` 看到容器起没起来
#
# T-52 会把本脚本里的 "tail -f /dev/null" 换成 `exec bun run /usr/local/agent-rpc/server.ts`
# 之类启动真正的 agent RPC server,并监听 /var/run/agent-rpc.sock。
#
# 约束:
#   - 必须非 root 跑(dockerfile 的 USER agent:agent 已经保证)
#   - 不要尝试 writable / 特权操作:根 fs 是 readonly,只有 /workspace /root /tmp 可写
#   - SIGTERM 要快速返回;不要 sleep 长时间
# ------------------------------------------------------------

set -euo pipefail

# ---------- boot banner ----------
# OC_UID 由 T-50 supervisor 注入,格式 `OC_UID=42`
# 未注入(比如本地 `docker run` 测试)时记为 "unknown"
uid_info="${OC_UID:-unknown}"
printf '[agent-runtime] boot uid=%s pid=%d\n' "$uid_info" "$$"
printf '[agent-runtime] node=%s bun=%s\n' \
    "$(node --version 2>/dev/null || echo 'n/a')" \
    "$(bun --version 2>/dev/null || echo 'n/a')"

# ---------- signal handling ----------
# 这里 trap 用 "-" / "0" 都会匹配 exit,但 SIGTERM 是 15 号。写成名字形式更清楚。
shutdown() {
    printf '[agent-runtime] shutdown uid=%s signal=%s\n' "$uid_info" "${1:-TERM}"
    # 关掉持续阻塞的 tail 进程,让脚本自然退出。
    if [[ -n "${BLOCKER_PID:-}" ]] && kill -0 "$BLOCKER_PID" 2>/dev/null; then
        kill -TERM "$BLOCKER_PID" 2>/dev/null || true
        # 等最多 2s,别无限 wait 住 SIGTERM 链路
        for _ in 1 2 3 4; do
            kill -0 "$BLOCKER_PID" 2>/dev/null || break
            sleep 0.5
        done
    fi
    exit 0
}
trap 'shutdown TERM' TERM
trap 'shutdown INT'  INT

# ---------- main loop ----------
# MVP 占位:起一个会阻塞的进程让 PID 1(tini)有东西 wait,否则容器秒退。
# 用 `tail -f /dev/null` 而不是 `sleep infinity`,是因为后者在 busybox 里要单独
# 装,而 tail 在 node:22-slim 里本来就有。
printf '[agent-runtime] placeholder RPC server — replaced by real implementation in T-52\n'

tail -f /dev/null &
BLOCKER_PID=$!

# wait $BLOCKER_PID 会在 signal 到达时返回非 0;trap 已经处理了退出,这里 wait
# 只是主线程不立刻退。
wait "$BLOCKER_PID" || true
