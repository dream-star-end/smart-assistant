#!/usr/bin/env bash
# diff-known-failures.sh <tap-output-file> <known-failures-file> [upstream-exit-code]
#
# 基线失败集 diff 门:比较 node:test TAP 输出中的顶层失败集合与已知存量失败清单,
# 只有「新增失败」才让 CI 变红;基线里已登记的存量失败不刷屏、不拦截。
# 清单维护方法见 docs/V5_CI.md。
#
# 提取规则(与清单生成命令保持一字不差,见 docs/V5_CI.md):
#   grep '^not ok' | sed 's/^not ok [0-9]* - //' | sort -u
# 注意:^not ok 只匹配列 0(顶层 test/suite),嵌套子测试是缩进的,不参与比较。
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <tap-output-file> <known-failures-file> [upstream-exit-code]" >&2
  exit 2
fi

tap_file="$1"
known_file="$2"
upstream_exit="${3:-}"

if [[ ! -f "$tap_file" ]]; then
  echo "::error::TAP output file not found: $tap_file" >&2
  exit 1
fi
if [[ ! -f "$known_file" ]]; then
  echo "::error::known-failures baseline not found: $known_file" >&2
  exit 1
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# 实际失败集(顶层 not ok 的测试/套件名,去重排序)
grep '^not ok' "$tap_file" | sed 's/^not ok [0-9]* - //' | sort -u > "$workdir/actual" || true
# 基线(去掉空行与整行注释;TAP 名字里的 '#' 会被转义成 '\#',不会顶格出现)
grep -v -e '^[[:space:]]*$' -e '^#' "$known_file" | sort -u > "$workdir/known" || true

# 健壮性:TAP 里一个测试点都没有 → 套件根本没跑起来,直接红
total_points="$(grep -c -E '^(not )?ok [0-9]' "$tap_file" || true)"
if [[ "$total_points" -eq 0 ]]; then
  echo "::error::no TAP test points found in $tap_file — test run crashed before producing results" >&2
  exit 1
fi

new_failures="$(comm -13 "$workdir/known" "$workdir/actual")"
stale_entries="$(comm -23 "$workdir/known" "$workdir/actual")"
known_still_failing="$(comm -12 "$workdir/known" "$workdir/actual")"

echo "== known-failures diff gate =="
echo "top-level test points: $total_points"
echo "actual failing (top-level): $(wc -l < "$workdir/actual")"
echo "baseline entries:           $(wc -l < "$workdir/known")"
echo "known & still failing:      $(printf '%s' "$known_still_failing" | grep -c . || true)"

if [[ -n "$stale_entries" ]]; then
  echo ""
  echo "::warning::baseline entries that did NOT fail this run — if a fix landed, delete these lines from $known_file (flaky entries may legitimately come and go):"
  printf '%s\n' "$stale_entries" | sed 's/^/  [stale?] /'
fi

if [[ -n "$new_failures" ]]; then
  echo ""
  echo "::error::NEW test failures (not in $known_file):"
  printf '%s\n' "$new_failures" | sed 's/^/  [NEW] /'
  echo ""
  echo "Fix the regression, or (only for pre-existing failures newly exposed by env changes) add the exact line to $known_file with justification. See docs/V5_CI.md."
  exit 1
fi

# 没有新增失败,但如果上游 exit code 非 0 且实际失败集为空 → 非测试失败类崩溃,红
if [[ -n "$upstream_exit" && "$upstream_exit" != "0" ]]; then
  if [[ ! -s "$workdir/actual" ]]; then
    echo "::error::test runner exited $upstream_exit but no top-level 'not ok' found — infrastructure failure, inspect TAP output" >&2
    exit 1
  fi
fi

echo ""
echo "PASS: no new failures beyond baseline."
