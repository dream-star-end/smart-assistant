#!/usr/bin/env bash
# tap-suite-gate.sh <npm-script> <known-failures-file> — 通用 TAP 基线门 wrapper。
# (2026-07-18 门禁审计批C:diff-known-failures.sh 机制的第二/三消费者——test:web 与
# test:commercial:integ——共用同一门,不复制机制。commercial-unit 仍走原
# commercial-unit-gate.sh 入口,语义不变。)
#
# 用法:npm run test:web:gate / npm run test:commercial:integ:gate(CI 与本地同一入口)。
set -uo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <npm-script> <known-failures-file>" >&2
  exit 2
fi
suite="$1"
baseline="$2"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# TAP 产物进程隔离(并发跑防互相截断);worktree 下 .git 是文件,必须 rev-parse 拿真实 git dir。
_gitdir="$(git rev-parse --git-dir 2>/dev/null || echo "${TMPDIR:-/tmp}")"
tap_out="${TAP_OUT:-$_gitdir/$(basename "$baseline" .txt).$$.tap}"

# 防静默 skip:commercial 族测试的 DB 门控由 REQUIRE_TEST_DB 强制生效(没有 PG fixture
# 就应该红,不能绿着骗人);非 commercial 套件不读此变量,设了无害。
export REQUIRE_TEST_DB=1

echo "running: npm run $suite (TAP -> $tap_out)"
npm run "$suite" > "$tap_out" 2>&1
status=$?
echo "test runner exit: $status"

grep -E '^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)' "$tap_out" || true

exec bash "$repo_root/.github/scripts/diff-known-failures.sh" "$tap_out" "$baseline" "$status"
