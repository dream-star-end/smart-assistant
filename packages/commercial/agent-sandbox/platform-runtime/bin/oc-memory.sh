#!/bin/sh
# oc-memory — 容器内长期记忆 CLI(Recall + Archival)。薄 wrapper → 预编译 CJS
# (复用 memoryTools 核心,与旧 MCP handler 同源)。取代常驻 openclaude_memory MCP 里的
# session_search / archival_* 工具 —— 常驻 stdio 传输脆弱(被 console 污染 / 崩溃即死 →
# codex 死等 turn 被掐),一次性进程无传输可死。memdir 范式后 Core 记忆改为直接 Write/Edit
# 写 MEMORY.md 索引 + memory/*.md 文件,`memory` 子命令已退役(调用只打印迁移提示)。
# cron / skill 仍留 MCP。Cursor 同步委派走本 CLI 的 delegate / request-review / delegate-wait。
#
# 快路径:release/image 构建期把 ocMemoryCli.ts 打成 packages/mcp-memory/dist/oc-memory.cjs,
# 本壳 exec /usr/local/bin/node(镜像自带,约几十 ms)。产物不能放进 platform bundle:
# bundle 扩展名白名单无 .js/.cjs,且 native addon 必须从 /opt/openclaude/node_modules 解析。
# dist 缺失(旧 release / 本地未 build)回落历史 npx+tsx,行为不变、冷启动仍贵。
set -e
# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# help-fast-path: stdout usage + exit 0; do not start tsx/node/network.
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  cat <<'EOF'
usage:
  oc-memory core-search "<query>" [--limit N] [--offset N]
  oc-memory session-search "<query>" [--limit N] [--agent-id ID] [--summarize]
  oc-memory archival-add "<text>" [--tags a,b,c]
  oc-memory archival-search "<query>" [--limit N]
  oc-memory archival-delete <id>
  oc-memory delegate-wait <jobId> [<jobId>...]
  oc-memory delegate --goal "<text>" [--agent-id ID] [--model SLUG] [--context "..."] [--effort low|medium|high] [--toolsets a,b] [--resume-session-key KEY]
  oc-memory request-review --draft "<text>" [--revision-note "..."] [--resume-session-key KEY]
EOF
  exit 0
fi

cd /opt/openclaude
BUNDLE="/opt/openclaude/packages/mcp-memory/dist/oc-memory.cjs"
if [ -f "$BUNDLE" ]; then
  exec /usr/local/bin/node "$BUNDLE" "$@"
fi
exec npx --no-install tsx packages/mcp-memory/src/ocMemoryCli.ts "$@"
