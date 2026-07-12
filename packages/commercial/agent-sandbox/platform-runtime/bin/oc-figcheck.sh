#!/bin/sh
# oc-figcheck — 出图质量门 + vision 回看闭环(确定性检查 + MiniMax-M3 审图 →
# PASS/WARN/FAIL + 问题清单)。让 agent 看到自己刚画的图并自纠,取代"开环盲画"。
# 见 scientific-figures baseline skill。薄封装 → gateway tsx 入口。
set -e
# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocFigCheckCli.ts "$@"
