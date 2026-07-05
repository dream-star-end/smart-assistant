#!/usr/bin/env bash
# commercial-unit-gate.sh — 跑 v5 商业 unit 套件并应用基线失败集 diff 门。
# CI 与本地共用同一入口:npm run test:commercial:unit:gate
#
# 前置:PG 测试 fixture(默认 postgres://test:test@127.0.0.1:55432/openclaude_test,
# 可用 TEST_DATABASE_URL 覆盖)。REQUIRE_TEST_DB=1 强制生效,防 DB 门控测试静默 skip。
# 见 docs/V5_CI.md。
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

tap_out="${TAP_OUT:-commercial-unit.tap}"
baseline="${KNOWN_FAILURES:-.github/known-failures/commercial-unit.txt}"

# 防静默 skip:商业测试的 DB 门控是 CI==='true' || REQUIRE_TEST_DB==='1',
# 本地跑 gate 时也强制开启 —— 没有 PG fixture 就应该红,而不是绿着骗人。
export REQUIRE_TEST_DB=1

echo "running: npm run test:commercial:unit (TAP -> $tap_out)"
npm run test:commercial:unit > "$tap_out" 2>&1
status=$?
echo "test runner exit: $status"

# 摘要可见性:把 TAP 汇总行打到 job log
grep -E '^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)' "$tap_out" || true

exec bash .github/scripts/diff-known-failures.sh "$tap_out" "$baseline" "$status"
