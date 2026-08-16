#!/bin/sh
# oc-task — in-container CLI for the V5 taskboard. Thin wrapper → gateway tsx
# entry, which talks to THIS container's own gateway over loopback (/api/board/*).
# See the `manage-taskboard` baseline skill for usage + iron rules.
set -e
# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocTaskCli.ts "$@"
