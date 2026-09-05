#!/bin/sh
# oc-docxcheck — 薄壳转发 oc-docx check（skill / 肌肉记忆）。
# 实现全在 oc-docx.py；本文件不复制 zip/render。
set -e
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  if [ -f "$DIR/oc-docx.py" ]; then
    exec python3 "$DIR/oc-docx.py" check --help
  fi
  exec python3 "$DIR/oc-docx" check --help
fi
if [ -f "$DIR/oc-docx.py" ]; then
  exec python3 "$DIR/oc-docx.py" check "$@"
fi
exec python3 "$DIR/oc-docx" check "$@"
