#!/bin/sh
# oc-connect — in-container CLI for user-bound app connectors (webdav/imap/notion/github/feishu).
# Thin wrapper → gateway tsx entry (talks to master /v3/connectors/{list|call} with the
# container token; third-party credentials never enter the container). Write actions go
# through the propose-then-commit confirmation gate. See the `app-connectors` baseline skill.
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocConnectCli.ts "$@"
