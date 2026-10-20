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

# 只取键名;值从不离开解析器。逐字符移植 systemd src/basic/env-file.c 的状态机(PRE_KEY/KEY/PRE_VALUE/
# VALUE/VALUE_ESCAPE/单双引号/COMMENT),所以引号段、引号闭合后的再次引号、反斜杠续行、注释续行都与
# systemd 读这个文件时一致;值里的任何内容都不会被当成键。只输出合法变量名。
keys_of() {
  python3 - "$1" <<'PY' | sort -u
import re, sys
NEWLINE, COMMENTS, WS = "\n\r", "#;", " \t\n\r"
valid = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
# newline="": 保留原始 CR/LF;通用换行会把 CRLF 折成 LF,改变 systemd 的续行边界(Codex P1)
data = open(sys.argv[1], encoding="utf-8", errors="replace", newline="").read()
state, key = "PRE_KEY", ""
def emit():
    k = key.rstrip(" \t")
    if valid.match(k):
        print(k)
for c in data:
    if state == "PRE_KEY":
        if c in COMMENTS:
            state = "COMMENT"
        elif c not in WS:
            state, key = "KEY", c
    elif state == "KEY":
        if c in NEWLINE:
            state, key = "PRE_KEY", ""
        elif c == "=":
            state = "PRE_VALUE"
        else:
            key += c
    elif state == "PRE_VALUE":
        if c in NEWLINE:
            emit()
            state, key = "PRE_KEY", ""
        elif c == "'":
            state = "SINGLE_QUOTE_VALUE"
        elif c == '"':
            state = "DOUBLE_QUOTE_VALUE"
        elif c == "\\":
            state = "VALUE_ESCAPE"
        elif c not in WS:
            state = "VALUE"
    elif state == "VALUE":
        if c in NEWLINE:
            emit()
            state, key = "PRE_KEY", ""
        elif c == "\\":
            state = "VALUE_ESCAPE"
    elif state == "VALUE_ESCAPE":
        state = "VALUE"
    elif state == "SINGLE_QUOTE_VALUE":
        if c == "'":
            state = "PRE_VALUE"
    elif state == "DOUBLE_QUOTE_VALUE":
        if c == '"':
            state = "PRE_VALUE"
        elif c == "\\":
            state = "DOUBLE_QUOTE_VALUE_ESCAPE"
    elif state == "DOUBLE_QUOTE_VALUE_ESCAPE":
        state = "DOUBLE_QUOTE_VALUE"
    elif state == "COMMENT":
        if c == "\\":
            state = "COMMENT_ESCAPE"
        elif c in NEWLINE:
            state = "PRE_KEY"
    elif state == "COMMENT_ESCAPE":
        state = "COMMENT"
if state in ("PRE_VALUE", "VALUE", "VALUE_ESCAPE", "SINGLE_QUOTE_VALUE", "DOUBLE_QUOTE_VALUE", "DOUBLE_QUOTE_VALUE_ESCAPE"):
    emit()
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
