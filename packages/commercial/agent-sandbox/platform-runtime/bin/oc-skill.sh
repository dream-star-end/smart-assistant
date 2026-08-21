#!/bin/sh
# oc-skill — in-container CLI for AI-driven, conversation-triggered skill training /
# eval-case generation. Thin wrapper → gateway tsx entry, which talks to THIS
# container's own gateway over loopback (/internal/v3/skill-local/*). See the
# `skill-management` baseline skill for usage + the four discipline rules.
set -e
# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# help-fast-path: stdout usage + exit 0; do not start tsx/node/network.
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  cat <<'EOF'
usage: oc-skill <train|train-status|evals-generate|evals-gen-status> ...
EOF
  exit 0
fi

cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocSkillCli.ts "$@"
