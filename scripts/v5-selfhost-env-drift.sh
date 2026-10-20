#!/usr/bin/env bash
# 个人版 master env 键漂移检查(OCV5-535,FINDINGS DEP-7)。只比键名,永远不读出、不打印任何值。
#
# 用法: v5-selfhost-env-drift.sh [--env FILE] [--template FILE] [--quiet]
#   --env       现网 env(默认 /etc/openclaude/commercial-v5-selfhost.env)
#   --template  键清单(默认 本仓库 deploy/v5-selfhost/commercial-v5-selfhost.env.template)
# 输出: 每个问题一行 `MISSING <KEY>` / `UNDECLARED <KEY>`,末行 `ENV_DRIFT missing=N undeclared=M`。
# 退出: 0 无 MISSING(UNDECLARED 只告警);1 有 @required 键缺失;2 用法或文件不可读。
set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="/etc/openclaude/commercial-v5-selfhost.env"
template="$SCRIPT_DIR/../deploy/v5-selfhost/commercial-v5-selfhost.env.template"
quiet=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) env_file="${2:?--env FILE}"; shift 2 ;;
    --template) template="${2:?--template FILE}"; shift 2 ;;
    --quiet) quiet=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -r "$env_file" ]] || { echo "env 不可读: $env_file" >&2; exit 2; }
[[ -r "$template" ]] || { echo "模板不可读: $template" >&2; exit 2; }

# 只取键名;值从不离开解析器。按 systemd EnvironmentFile 的语义切逻辑行:引号里的值可以跨行,
# 行尾反斜杠续行;跨出来的那些物理行属于上一个值,绝不能当成键(否则会把值的一部分打进日志)。
keys_of() {
  python3 - "$1" <<'PY' | sort -u
import re, sys
assign = re.compile(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$')
quote = None
cont = False
for line in open(sys.argv[1], encoding="utf-8", errors="replace").read().split("\n"):
    if quote:
        j = 0
        while j < len(line):
            c = line[j]
            if c == "\\" and quote == '"':
                j += 2
                continue
            if c == quote:
                quote = None
                break
            j += 1
        continue
    if cont:
        cont = line.endswith("\\")
        continue
    m = assign.match(line)
    if not m:
        continue
    print(m.group(1))
    val, j, q = m.group(2), 0, None
    while j < len(val):
        c = val[j]
        if q is None:
            if c in "\"'":
                q = c
            elif c == "#" and (j == 0 or val[j - 1].isspace()):
                break
            elif c == "\\":
                j += 1
        elif c == "\\" and q == '"':
            j += 1
        elif c == q:
            q = None
        j += 1
    if q:
        quote = q
    elif val.endswith("\\"):
        cont = True
PY
}

declared="$(keys_of "$template")"
required="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=.*#.*@required' "$template" | sed -E 's/=.*//' | sort -u)"
patterns="$(sed -nE 's/^#[[:space:]]*@allow-pattern[[:space:]]+//p' "$template" | tr ' ' '\n' | sed '/^$/d')"
live="$(keys_of "$env_file")"

missing=0
undeclared=0
while IFS= read -r k; do
  [[ -n "$k" ]] || continue
  grep -qxF -- "$k" <<<"$live" && continue
  missing=$((missing + 1))
  echo "MISSING $k"
done <<<"$required"
while IFS= read -r k; do
  [[ -n "$k" ]] || continue
  grep -qxF -- "$k" <<<"$declared" && continue
  matched=0
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    # shellcheck disable=SC2053  # $p 是 glob 规则,故意不加引号
    if [[ "$k" == $p ]]; then matched=1; break; fi
  done <<<"$patterns"
  [[ "$matched" == 1 ]] && continue
  undeclared=$((undeclared + 1))
  [[ "$quiet" == 1 ]] || echo "UNDECLARED $k"
done <<<"$live"
echo "ENV_DRIFT missing=$missing undeclared=$undeclared"
[[ "$missing" == 0 ]]
