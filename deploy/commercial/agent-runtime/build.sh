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

# T-52 起 ENTRYPOINT 是 tini → supervisor.sh → exec bun RPC server,
# 不再响应 `docker run IMG <cmd>` 的 CMD 语义(supervisor.sh 忽略参数)。
# smoke 检查统一走 `--entrypoint bash -c ...` 直接绕过 supervisor。
RUN_BASH=(docker run --rm --entrypoint bash "${IMAGE}" -c)

echo "[build] verify non-root user"
who=$("${RUN_BASH[@]}" 'whoami')
if [[ "${who}" != "agent" ]]; then
    echo "[build] FATAL: expected user=agent, got=${who}"
    exit 1
fi

echo "[build] verify bun / node present"
"${RUN_BASH[@]}" 'bun --version && node --version'

echo "[build] verify /root is writable by agent (matches T-50 home volume target)"
"${RUN_BASH[@]}" 'touch /root/.writetest && rm /root/.writetest && echo OK'

echo "[build] verify T-52 agent-rpc server file present + parseable"
# 只要文件在 + bun 可解析语法就够了:真正的 RPC 行为由
# packages/commercial/__tests__/wsAgent.test.ts + 未来 integ 覆盖。
"${RUN_BASH[@]}" '
    set -e
    test -f /usr/local/agent-rpc/server.ts
    # bun 的 transpiler 直接跑一遍,抓纯语法错;--target bun 保持与 runtime 一致
    bun build /usr/local/agent-rpc/server.ts --target=bun --outfile=/tmp/out.js >/dev/null 2>&1
    echo OK
'

echo "[build] verify supervisor.sh is valid bash"
"${RUN_BASH[@]}" 'bash -n /usr/local/bin/supervisor.sh && echo OK'

echo "[build] done: ${IMAGE}"
