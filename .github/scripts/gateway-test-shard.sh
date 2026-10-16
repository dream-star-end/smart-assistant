#!/usr/bin/env bash
# gateway-test-shard.sh — run one CI shard of `npm run test:gateway` (OCV5-441).
#
# Same file set and runner flags as the npm script; the full run is over 90 minutes
# on one runner, so v5-selfhost-tests.yml splits it into two modulo partitions:
#   · idle K/N: idlePipeline*.integ.test.ts (PG + Redis + real CCB, 10-30 min each);
#   · unit K/N: every other gateway *.test.ts.
# Both are taken by index over a sorted list, so a newly added file always lands
# in some shard of its partition — nothing can drop out of CI silently.
#
# Usage: .github/scripts/gateway-test-shard.sh <unit|idle> <K>/<N> [--list]
set -euo pipefail

kind="${1:-}"; part="${2:-}"; list_only="${3:-}"
[[ "$kind" == unit || "$kind" == idle ]] || { echo "usage: $0 <unit|idle> <K>/<N> [--list]" >&2; exit 2; }
[[ "$part" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || { echo "bad shard '$part' (want K/N)" >&2; exit 2; }
k="${BASH_REMATCH[1]}"; n="${BASH_REMATCH[2]}"
(( k <= n )) || { echo "shard $k > $n" >&2; exit 2; }

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
idle_re='/idlePipeline[^/]*\.integ\.test\.ts$'
mapfile -t all < <(find packages/gateway/src -type f -name '*.test.ts' | LC_ALL=C sort)
if [[ "$kind" == idle ]]; then
  mapfile -t pool < <(printf '%s\n' "${all[@]}" | grep -E "$idle_re" || true)
else
  mapfile -t pool < <(printf '%s\n' "${all[@]}" | grep -Ev "$idle_re" || true)
fi
files=()
for i in "${!pool[@]}"; do
  (( i % n == k - 1 )) && files+=("${pool[$i]}")
done
(( ${#files[@]} > 0 )) || { echo "$kind $part selects no files (pool ${#pool[@]})" >&2; exit 1; }

echo "[gateway-shard] $kind $part: ${#files[@]} of ${#pool[@]} files (all ${#all[@]})"
if [[ "$list_only" == --list ]]; then printf '%s\n' "${files[@]}"; exit 0; fi
exec npx tsx --test --test-concurrency=1 "${files[@]}"
