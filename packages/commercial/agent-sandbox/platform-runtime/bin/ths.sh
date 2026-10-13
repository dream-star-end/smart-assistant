#!/bin/sh
# ths — 同花顺行情插件命令（OCV5-383）。经平台启动器：先查插件是否已在「管理中心 → 插件」停用，
# 再运行插件包里的 scripts/ths.py（/run/oc/claude-config/skills/ths/）。
exec "$(dirname "$(readlink -f "$0")")/plugin-exec" ths ths "$@"
