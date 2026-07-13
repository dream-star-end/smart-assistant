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

# TAP 产物默认落**进程隔离**路径:仓根固定名会被并发跑(多 agent / 多 worktree 共享树)
# 互相截断 → diff 阶段报假的 "infrastructure failure"(2026-07-12 并行 agent 实测踩中)。
# **坑**:worktree 里 `.git` 是**文件**不是目录,不能直接写 `.git/xxx`(Not a directory)——
# 必须用 `git rev-parse --git-dir` 拿真实 git dir(worktree 下会指向 .../worktrees/<name>)。
# CI 单跑不受影响;要固定路径显式传 TAP_OUT=。
_gitdir="$(git rev-parse --git-dir 2>/dev/null || echo "${TMPDIR:-/tmp}")"
tap_out="${TAP_OUT:-$_gitdir/commercial-unit.$$.tap}"
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
