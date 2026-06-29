#!/bin/sh
# oc-rank — deterministic candidate ranking (Elo from pairwise judgments) for
# tournament-debate / tree-search variant selection. See `research-tournament` skill.
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocRankCli.ts "$@"
