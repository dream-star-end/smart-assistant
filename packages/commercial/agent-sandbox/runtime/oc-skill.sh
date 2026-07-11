#!/bin/sh
# oc-skill — in-container CLI for AI-driven, conversation-triggered skill training /
# eval-case generation. Thin wrapper → gateway tsx entry, which talks to THIS
# container's own gateway over loopback (/internal/v3/skill-local/*). See the
# `skill-management` baseline skill for usage + the four discipline rules.
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocSkillCli.ts "$@"
