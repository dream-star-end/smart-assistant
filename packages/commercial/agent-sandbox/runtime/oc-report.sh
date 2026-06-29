#!/bin/sh
# oc-report — in-container deterministic report renderer (ReportSchema + checked
# EvidenceManifest → Quarto/pandoc PDF/docx/HTML; engine guarantees sections/numbering/
# citations; unsupported claims red-flagged). See the `research-report` baseline skill.
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocReportCli.ts "$@"
