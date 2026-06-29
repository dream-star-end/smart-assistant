#!/bin/sh
# oc-cite — in-container CLI for citation grounding (identifier verify / retraction /
# BibTeX·GB-T7714·APA formatting). Thin wrapper → gateway tsx entry (talks to master
# /v3/research/cite/* with the container token). See the `oc-cite` baseline skill.
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocCiteCli.ts "$@"
