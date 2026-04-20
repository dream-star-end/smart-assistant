#!/usr/bin/env bash
# v3 Phase 3A: openclaude-runtime container entrypoint (PID 2 under tini)
#
# 职责(本脚本极薄,核心逻辑在 entrypoint.ts):
#   1. 确认 supervisor 注入的 3 个 anthropic env 已就位(否则 fail closed)
#   2. 确保 CLAUDE_CONFIG_DIR 目标目录存在(supervisor --tmpfs 挂)
#   3. exec 到 entrypoint.ts —— 由它做 env scrubbing + spawn npm run gateway

set -euo pipefail

# ---- 1. 必要的 supervisor 注入校验 (fail closed) ----
for v in ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST; do
  if [ -z "${!v:-}" ]; then
    echo "[entrypoint] FATAL: env $v not set by supervisor (3 anthropic vars must be injected)" >&2
    exit 1
  fi
done

# ---- 2. CLAUDE_CONFIG_DIR 目录就绪 ----
# 生产: supervisor 已用 --tmpfs /run/oc/claude-config,本目录在 entrypoint 起跑前就在
# 本地 build smoke: 没有 tmpfs 时 fallback 到镜像里 root fs 的同路径
mkdir -p /run/oc/claude-config

# ---- 2.5. OPENCLAUDE_TRUST_BRIDGE_IP 必须由 v3 supervisor 显式注入 ----
# 该 env 触发 personal-version /ws 的 IP-based trust 旁路(/opt/openclaude/openclaude
# packages/gateway/src/server.ts 内 isFromBridge 分支)。如果在 entrypoint 这层兜默认值,
# 等于"任何能从 172.30.0.1 触达本容器 18789 的进程都免 token",镜像层面破坏 fail-closed。
# 因此:不兜默认。supervisor 没注入 = 旁路 noop = 桥接走不通(行为可观测、报错明确)。
# 见 v3supervisor.provisionV3Container 里 env 数组。
#
# 仅做诊断 echo,不 fail closed —— supervisor 即使忘了注,镜像仍能起到回退到普通 token 路径,
# 用户体验是"4503 starting"持续(bridge dial 拿不到授权),log 里有这条提示。
if [ -z "${OPENCLAUDE_TRUST_BRIDGE_IP:-}" ]; then
  echo "[entrypoint] notice: OPENCLAUDE_TRUST_BRIDGE_IP not set — bridge IP trust bypass disabled (token auth only)" >&2
fi

# ---- 3. 交棒 entrypoint.ts ----
# 用 tsx (个人版 devDep,npm ci 已装) 跑 .ts 入口,避免维护两份 isProviderManagedEnvVar 列表
cd /opt/openclaude
exec npx --no tsx /usr/local/lib/openclaude/entrypoint.ts
