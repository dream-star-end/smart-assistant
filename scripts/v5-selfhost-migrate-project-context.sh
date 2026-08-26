#!/usr/bin/env bash
# Container/host entry for project-context migration. Dry-run default.
# Never deletes ~/.openclaude/projects wholesale.
set -euo pipefail
HOME_DIR="${OPENCLAUDE_HOME:-${HOME}/.openclaude}"
export OPENCLAUDE_HOME="$HOME_DIR"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec npx tsx "$ROOT/packages/commercial/scripts/migrate-project-context.ts" --home "$HOME_DIR" "$@"
