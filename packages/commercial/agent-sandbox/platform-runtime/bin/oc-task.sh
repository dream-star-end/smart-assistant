#!/bin/sh
# oc-task — in-container CLI for the V5 taskboard. Thin wrapper → gateway tsx
# entry, which talks to THIS container's own gateway over loopback (/api/board/*).
# See the `manage-taskboard` baseline skill for usage + iron rules.
set -e
# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# help-fast-path: stdout usage + exit 0; do not start tsx/node/network.
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  cat <<'EOF'
usage: oc-task <project|ticket|relation|run> <subcommand> [flags]

project  list [--include-archived]
         create --key KEY --name NAME [--description TEXT] [--workspace PATH] [--labels a,b]
ticket   list [--project-id ID] [--status S] [--type T] [--priority P] [--assignee A]
              [--stage-id ID] [--label L] [--q Q] [--limit N] [--offset N]
         get <idOrIdent>
         create --project-id ID --type bug|feature|spike|chore --title TITLE
                [--body MD] [--priority P0-P3] [--severity S] [--labels a,b] [--assignee A]
         update <idOrIdent> --expected-version N [--title T] [--body MD] [--priority P]
                [--severity S] [--labels a,b] [--assignee A] [--blocked-reason R]
         claim <idOrIdent> --expected-version N [--owner agent:<id>]
         advance <idOrIdent> --expected-version N [--summary TEXT] [--output-md MD] [--run-id ID]
         block <idOrIdent> --expected-version N --reason TEXT
         comment <idOrIdent> --body MD [--run-id ID]
relation add <fromIdOrIdent> --to <toIdOrIdent> --kind parent|blocks|related
         remove <relationId>
run      list <ticketIdOrIdent> [--status S] [--stage-id ID] [--limit N] [--offset N]
         get <runId>

exit codes:
  0  success
  2  usage / bad arguments
  3  gateway unreachable or token/port missing
  4  API error (4xx/5xx except 409/423)
  5  version conflict (HTTP 409) — re-read then retry once
  6  lease held (HTTP 423) — someone else is running; retry is useless

identifier is server-generated. Never invent OCV5-<n>; only reuse values from get/list/create.
EOF
  exit 0
fi

cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocTaskCli.ts "$@"
