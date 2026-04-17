#!/usr/bin/env bash
# ------------------------------------------------------------
# agent-runtime 容器内 supervisor
# ------------------------------------------------------------
# 职责(T-52 实装版):
#   1. 起真 agent RPC server(`bun run /usr/local/agent-rpc/server.ts`)
#      监听 /var/run/agent-rpc/agent.sock,由 supervisor.ts 层 bind-mount 暴给 host
#   2. 捕获 SIGTERM / SIGINT → 靠 `exec` 直接把信号交给 bun 进程,不额外包一层
#      tini 作为 PID 1 负责回收僵尸、转发信号
#   3. stdout 写容器日志,便于 `docker logs` 排查
#
# 约束:
#   - 必须非 root 跑(dockerfile 的 USER agent:agent 已经保证)
#   - 不要尝试 writable / 特权操作:根 fs 是 readonly,只有 /workspace /root /tmp 可写
#   - /var/run/agent-rpc 必须是 rw(由 T-52 supervisor 层 bind-mount);若没挂
#     agent.sock 会写到容器内 tmpfs(不被 host 看见,dev 本地跑时可接受)
# ------------------------------------------------------------

set -euo pipefail

# ---------- boot banner ----------
# OC_UID 由 T-50 supervisor 注入(格式 `OC_UID=42`);未注入时记 "unknown"
uid_info="${OC_UID:-unknown}"
printf '[agent-runtime] boot uid=%s pid=%d\n' "$uid_info" "$$"
printf '[agent-runtime] node=%s bun=%s\n' \
    "$(node --version 2>/dev/null || echo 'n/a')" \
    "$(bun --version 2>/dev/null || echo 'n/a')"

# ---------- sanity: RPC dir writable ----------
# 若 bind-mount 漏了,agent 身份仍然应能看到挂载点(Dockerfile 已 chown 给 agent)。
# 只是提示性地 mkdir -p + 权限调整 —— 容器内 /var/run 通常不可写,但 /var/run/agent-rpc
# 本身是 mount point 下的子目录,挂进来后可写。
mkdir -p /var/run/agent-rpc 2>/dev/null || true
if [[ ! -w /var/run/agent-rpc ]]; then
    printf '[agent-runtime] WARN /var/run/agent-rpc not writable — RPC socket will fail to bind\n' >&2
fi

# ---------- exec bun RPC server ----------
# exec 让 bun 进程直接接管 PID(父是 tini),SIGTERM 走 tini → bun 自己处理。
# 不再需要 trap + BLOCKER_PID 的壳——bun RPC 脚本里有自己的 SIGTERM handler
# 做优雅关闭(close server + 清 socket + exit 0)。
printf '[agent-runtime] exec agent RPC server\n'
exec bun run /usr/local/agent-rpc/server.ts
