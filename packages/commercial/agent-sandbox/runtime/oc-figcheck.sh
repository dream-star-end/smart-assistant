#!/bin/sh
# oc-figcheck — 出图质量门 + vision 回看闭环(确定性检查 + MiniMax-M3 审图 →
# PASS/WARN/FAIL + 问题清单)。让 agent 看到自己刚画的图并自纠,取代"开环盲画"。
# 见 scientific-figures baseline skill。薄封装 → gateway tsx 入口。
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocFigCheckCli.ts "$@"
