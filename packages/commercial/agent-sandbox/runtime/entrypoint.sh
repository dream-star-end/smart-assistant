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

# ---- 3. 交棒 entrypoint.ts ----
# 用 tsx (个人版 devDep,npm ci 已装) 跑 .ts 入口,避免维护两份 isProviderManagedEnvVar 列表
cd /opt/openclaude
exec npx --no tsx /usr/local/lib/openclaude/entrypoint.ts
