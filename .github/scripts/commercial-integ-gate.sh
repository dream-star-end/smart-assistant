#!/usr/bin/env bash
# commercial-integ-gate.sh <tier|shard> — 跑一个 integ 梯队/分片并判绿。
#
# 用法:
#   bash .github/scripts/commercial-integ-gate.sh pr         # 全部 pr-* 分片(本地串跑)
#   bash .github/scripts/commercial-integ-gate.sh pr-2       # 单片(CI matrix 用)
#   bash .github/scripts/commercial-integ-gate.sh nightly-4
#
# 梯队清单的单一权威在 .github/integ-tiers/,由 `npm run lint:integ-tiers` 守着
# "每个 *.integ.test.ts 必须属于某一梯队"。
#
# ── 判绿判据(刻意比 diff-known-failures.sh 严)───────────────────────────────
# diff-known-failures 的洞:它只比"失败集 ⊆ 基线",skip 掉的、根本没跑的、
# TAP plan 被截断的,它一律当绿。integ 层恰恰是最容易"静默不跑"的一层
# (2026-07-26 实测:坏连接串下 settleUsage.integ `# pass 0 / skipped 16`,EXITCODE=0),
# 照抄那套等于把 fail-open 换个地方复现。这里四条**同时**成立才算绿:
#
#   G1  失败集 ⊆ 基线            —— 无新增失败
#   G2  skipped == 0             —— 一个都不许静默跳过(fixture 缺失必须红)
#   G3  executed >= min-tests    —— 执行下界,防"把用例删了/only 掉让门变绿"
#   G4  TAP plan 行完整          —— `1..N` 存在且 N == 实际测试点数,防进程中途死掉
#
# 前置 fixture:PG(TEST_DATABASE_URL,默认 test:test@127.0.0.1:55432/openclaude_test)
#               Redis(TEST_REDIS_URL,默认 redis://127.0.0.1:56379/0)
# REQUIRE_TEST_DB=1 由本脚本强制导出 —— 与 commercial-unit-gate.sh 对齐。
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

target="${1:?usage: commercial-integ-gate.sh <tier|shard>  e.g. pr | pr-2 | nightly-4}"
tier_dir=".github/integ-tiers"

# 解析 target → 分片清单集合
shopt -s nullglob
if [[ "$target" == "pr" || "$target" == "nightly" ]]; then
  manifests=("$tier_dir/$target"-*.txt)
else
  manifests=("$tier_dir/$target.txt")
fi
shopt -u nullglob

if [[ ${#manifests[@]} -eq 0 || ! -f "${manifests[0]}" ]]; then
  echo "::error::unknown integ tier/shard '$target' — 可选:$(cd "$tier_dir" && ls *.txt | sed 's/\.txt$//' | tr '\n' ' ')" >&2
  exit 2
fi

# Aggregate targets must preserve each shard's own known-failure and count
# baseline. Running every file in one Node process also turns a shard-local
# timeout into an unrelated aggregate failure, so recurse into exact shards.
if [[ "$target" == "pr" || "$target" == "nightly" ]]; then
  for manifest in "${manifests[@]}"; do
    shard="$(basename "$manifest" .txt)"
    bash "${BASH_SOURCE[0]}" "$shard" || exit 1
  done
  echo ""
  echo "PASS: $target aggregate -- every shard passed its own G1-G4 contract"
  exit 0
fi

# 收集文件与 min-tests 下界(多片相加)
files=()
min_tests=0
for m in "${manifests[@]}"; do
  n="$(sed -n 's/^#[[:space:]]*min-tests:[[:space:]]*\([0-9]\+\)[[:space:]]*$/\1/p' "$m" | head -1)"
  if [[ -z "$n" ]]; then
    echo "::error::$m 缺 '# min-tests: N' 指令 —— 没有执行下界就没法证明用例真跑了" >&2
    exit 2
  fi
  min_tests=$(( min_tests + n ))
  while IFS= read -r line; do
    line="${line%%$'\r'}"
    [[ -z "${line// }" || "$line" == \#* ]] && continue
    if [[ ! -f "$line" ]]; then
      echo "::error::$m 登记的文件不存在:$line(跑 npm run lint:integ-tiers 收敛)" >&2
      exit 2
    fi
    files+=("$line")
  done < "$m"
done

if [[ ${#files[@]} -eq 0 ]]; then
  echo "::error::tier '$target' 解析出 0 个测试文件 —— 空跑必然假绿" >&2
  exit 2
fi

# TAP 产物走进程隔离路径(同 commercial-unit-gate.sh:worktree 下 .git 是文件,
# 必须用 git rev-parse --git-dir 拿真实 git dir)。
_gitdir="$(git rev-parse --git-dir 2>/dev/null || echo "${TMPDIR:-/tmp}")"
tap_out="${TAP_OUT:-$_gitdir/commercial-integ-$target.$$.tap}"
baseline="${KNOWN_FAILURES:-.github/known-failures/commercial-integ-$target.txt}"
if [[ ! -f "$baseline" ]]; then
  baseline="${KNOWN_FAILURES:-.github/known-failures/commercial-integ.txt}"
fi

# 防静默 skip:integ 的 DB 门控一律是 CI==='true' || REQUIRE_TEST_DB==='1'。
export REQUIRE_TEST_DB=1
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://test:test@127.0.0.1:55432/openclaude_test}"
export TEST_REDIS_URL="${TEST_REDIS_URL:-redis://127.0.0.1:56379/0}"

echo "== commercial-integ gate: $target =="
echo "shards:    ${manifests[*]}"
echo "files:     ${#files[@]}"
echo "min-tests: $min_tests"
echo "baseline:  $baseline"
echo "TAP ->     $tap_out"

# --test-force-exit:integ 里大量套件持 PG/Redis 连接,漏关就挂在 exit 上,
#   唯一兜底是 test-mutex 的看门狗超时 → 统一 exit 124,红的原因说不清。
# --test-timeout:node:test 默认 per-test timeout 是 Infinity,单个卡死的用例
#   会吃掉整个 job 预算(实测 blockedForUser.integ 单文件占用数分钟不出结果)。
# --test-concurrency=1:共享 PG fixture,并发跑会互相毒化。
cmd="npx tsx --test --test-force-exit --test-concurrency=1 --test-timeout=${OC_INTEG_TEST_TIMEOUT_MS:-180000} ${files[*]}"
bash scripts/test-mutex.sh commercial "$cmd" > "$tap_out" 2>&1
status=$?
echo "test runner exit: $status"

grep -E '^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)' "$tap_out" || true

# ── G4: TAP plan 完整 ────────────────────────────────────────────────────────
points="$(grep -c -E '^(not )?ok [0-9]' "$tap_out" || true)"
plan_line="$(grep -m1 -E '^1\.\.[0-9]+$' "$tap_out" || true)"
if [[ -z "$plan_line" ]]; then
  echo "::error::G4 FAIL — TAP 里没有 plan 行(1..N):测试进程在收尾前就死了。见 $tap_out" >&2
  tail -40 "$tap_out" >&2
  exit 1
fi
planned="${plan_line#1..}"
if [[ "$points" -ne "$planned" ]]; then
  echo "::error::G4 FAIL — TAP plan 声明 $planned 个顶层测试点,实际只有 $points 个:输出被截断/进程中途退出" >&2
  exit 1
fi

# ── G2: 零 skip ──────────────────────────────────────────────────────────────
# node:test 汇总行 `# skipped N`;另外顶层 `ok N - name # SKIP` 也算。
skipped="$(sed -n 's/^# skipped \([0-9]\+\)$/\1/p' "$tap_out" | tail -1)"
skipped="${skipped:-0}"
if [[ "$skipped" -ne 0 ]]; then
  echo "::error::G2 FAIL — $skipped 个用例被 skip。integ 层的 skip 几乎总是 fixture 缺失(PG/Redis/docker)," >&2
  echo "         而 fixture 缺失必须红:静默 skip 正是本层此前一年零执行的成因。被 skip 的:" >&2
  grep -E '# (SKIP|skip)' "$tap_out" | head -30 >&2
  exit 1
fi

# ── G3: 执行下界 ─────────────────────────────────────────────────────────────
# `# tests N` 是含子测试的总数,比顶层点数更能反映真实覆盖。
executed="$(sed -n 's/^# tests \([0-9]\+\)$/\1/p' "$tap_out" | tail -1)"
executed="${executed:-0}"
echo "executed (# tests): $executed  (min-tests floor: $min_tests)"
if [[ "$executed" -lt "$min_tests" ]]; then
  echo "::error::G3 FAIL — 只执行了 $executed 个用例,低于梯队声明的下界 $min_tests。" >&2
  echo "         要么有文件整体没跑起来(before hook 挂了),要么用例被删/被 --test-only 圈掉。" >&2
  echo "         如果是**有意**删用例,请同步下调对应 $tier_dir/*.txt 的 min-tests 并在 PR 里说明。" >&2
  exit 1
fi

# ── G1: 失败集 ⊆ 基线 ────────────────────────────────────────────────────────
if [[ ! -f "$baseline" ]]; then
  # 没有基线文件 = 零容忍(期望状态)。任何 not ok 都红。
  fails="$(grep -c '^not ok' "$tap_out" || true)"
  if [[ "$fails" -ne 0 ]]; then
    echo "::error::G1 FAIL — $fails 个顶层失败,且本梯队没有基线豁免文件($baseline):" >&2
    grep '^not ok' "$tap_out" | sed 's/^/  [FAIL] /' >&2
    exit 1
  fi
else
  bash .github/scripts/diff-known-failures.sh "$tap_out" "$baseline" "$status" || exit 1
fi

# runner 非零退出但没有 not ok → 基础设施故障
if [[ "$status" -ne 0 ]] && ! grep -q '^not ok' "$tap_out"; then
  echo "::error::test runner exited $status but no top-level 'not ok' — infrastructure failure,见 $tap_out" >&2
  tail -40 "$tap_out" >&2
  exit 1
fi

echo ""
echo "PASS: $target — G1 无新增失败 / G2 零 skip / G3 executed=$executed>=$min_tests / G4 plan 完整($planned)"
