#!/bin/sh
# oc-slides — in-container deterministic slide deck renderer
# (self-built Quarto pipeline; multi design-token theme; PresAesth soft checks).
# See the `research-slides` baseline skill for usage.
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocSlidesCli.ts "$@"
