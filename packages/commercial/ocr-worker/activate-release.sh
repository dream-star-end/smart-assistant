#!/bin/bash
# Run on SCNet after a release directory has been copied completely.
# Usage: activate-release.sh <release>; rollback with --rollback.
set -euo pipefail
ROOT=/opt/openclaude-ocr-worker
if [[ "${1:-}" == "--rollback" ]]; then
  [[ -L "$ROOT/previous" ]] || { echo "no previous OCR worker release" >&2; exit 1; }
  target=$(readlink -f "$ROOT/previous")
else
  [[ $# -eq 1 ]] || { echo "usage: $0 <release>|--rollback" >&2; exit 2; }
  target=$(readlink -f "$ROOT/releases/$1")
  [[ "$target" == "$ROOT/releases/"* && -x "$target/run-supervisor.sh" ]] || { echo "invalid OCR worker release" >&2; exit 1; }
fi
if [[ -L "$ROOT/current" ]]; then
  ln -sfn "$(readlink -f "$ROOT/current")" "$ROOT/previous.new"
  mv -Tf "$ROOT/previous.new" "$ROOT/previous"
fi
ln -sfn "$target" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"
printf '%s\n' "$(basename "$target")"
