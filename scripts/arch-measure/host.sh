#!/usr/bin/env bash
# OCV5-540: plan §1.7 log locations/retention and §1.9 train history on the v5-dev host
# (appendix A.5/A.6). Read-only; prints unit output lines, logrotate settings and counts only.
# Usage (root on v5-dev): bash scripts/arch-measure/host.sh [--since 2026-10-13]
set -uo pipefail
SINCE="2026-10-13"
[[ "${1:-}" == --since ]] && SINCE="${2:?}"
LEASE_DB="${OC_V5_LEASE_DB:-/var/lib/openclaude-v5-selfhost/lease.db}"

echo "# §1.7 where master/egress write stdout/stderr (unit StandardOutput/StandardError)"
for u in openclaude-v5-selfhost.service openclaude-v5-selfhost-egress@A.service openclaude-v5-selfhost-egress@B.service; do
  systemctl cat "$u" 2>/dev/null | grep -E '^Standard(Output|Error)=' | sed "s/^/  $u: /"
done
echo "# §1.7 logrotate rules installed on the host vs in the repo"
for f in /etc/logrotate.d/openclaude-v5-selfhost*; do
  [[ -e "$f" ]] || continue
  echo "  $f: $(grep -oE '\b(daily|weekly|rotate [0-9]+|maxsize [0-9A-Za-z]+|compress|copytruncate|create)\b' "$f" | sort -u | tr '\n' ' ')"
done
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
echo "  repo: $(cd "$REPO" && git ls-files | grep -iE 'logrotate' | tr '\n' ' ')"
echo "# §1.7 oldest egress log line date (plan: 10-18)"
for f in $(ls -1 /var/log/openclaude-v5-selfhost-egress.log* 2>/dev/null | sort -V | tail -1); do
  (if [[ "$f" == *.gz ]]; then zcat "$f"; else cat "$f"; fi) 2>/dev/null | grep -oE '"ts":"[0-9-]{10}' | head -1 | sed 's/"ts":"/  /'
done
echo "# §1.7 journald disk usage"
journalctl --disk-usage 2>/dev/null | sed 's/^/  /'
echo "# §1.7 user container log driver (docker inspect LogConfig; plan: json-file, no max-size)"
docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^oc-v5-u[0-9]+$' | head -5 | while read -r c; do
  echo "  $c: $(docker inspect -f '{{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}} AutoRemove={{.HostConfig.AutoRemove}}' "$c")"
done
echo "# §1.9 trains since $SINCE from $LEASE_DB (status, count, minutes)"
if command -v sqlite3 >/dev/null && [[ -r "$LEASE_DB" ]]; then
  sqlite3 -readonly -separator ' ' "$LEASE_DB" "
    SELECT '  ' || status, count(*),
           CAST(round(sum((julianday(coalesce(finished_at, updated_at)) - julianday(coalesce(started_at, created_at))) * 1440)) AS INTEGER)
      FROM train WHERE resource = 'deploy:selfhost' AND created_at >= '$SINCE'
     GROUP BY status ORDER BY status;" 2>&1 | sed 's/^/ /'
else
  echo "  sqlite3 or $LEASE_DB not available"
fi
