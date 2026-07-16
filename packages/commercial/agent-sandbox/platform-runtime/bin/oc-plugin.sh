#!/bin/sh
# oc-plugin — canonical in-container CLI for declarative-http, sandboxed-local and
# managed-browser Plugins. Credentials/browser state remain on the master; this
# wrapper sends only container identity + stdin JSON to /v3/plugins/*.
set -e
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocPluginCli.ts "$@"
