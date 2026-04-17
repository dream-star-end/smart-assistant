#!/usr/bin/env bash
# ------------------------------------------------------------
# 构建 openclaude/agent-runtime 镜像
# ------------------------------------------------------------
# 使用:
#     ./build.sh              # 构建 openclaude/agent-runtime:latest
#     TAG=v0.1 ./build.sh     # 指定 tag
#
# 构建环境要求:docker 20.10+ 且启用 buildx(T-80 部署脚本在 38.55 上会保证)。
# ------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")"

TAG="${TAG:-latest}"
IMAGE="openclaude/agent-runtime:${TAG}"

echo "[build] image=${IMAGE}"
docker build --pull -t "${IMAGE}" .

echo "[build] verify non-root user"
who=$(docker run --rm "${IMAGE}" whoami)
if [[ "${who}" != "agent" ]]; then
    echo "[build] FATAL: expected user=agent, got=${who}"
    exit 1
fi

echo "[build] verify bun present"
docker run --rm "${IMAGE}" bun --version

echo "[build] verify node present"
docker run --rm "${IMAGE}" node --version

echo "[build] verify /root is writable by agent (matches T-50 home volume target)"
docker run --rm "${IMAGE}" bash -c 'touch /root/.writetest && rm /root/.writetest && echo OK'

echo "[build] done: ${IMAGE}"
