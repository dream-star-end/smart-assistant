#!/bin/sh
# oc-memory — 容器内长期记忆 CLI(Core / Recall / Archival 三层记忆)。薄 wrapper →
# mcp-memory tsx entry(复用 memoryTools 核心,与旧 MCP handler 同源)。取代常驻
# openclaude_memory MCP 里的 memory / session_search / archival_* 五个工具 —— 常驻
# stdio 传输脆弱(被 console 污染 / 崩溃即死 → codex 死等 turn 被掐),一次性进程无
# 传输可死。delegate / cron / skill 工具仍留 MCP。文档见 memory-management baseline skill。
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/mcp-memory/src/ocMemoryCli.ts "$@"
