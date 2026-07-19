#!/usr/bin/env bash
# diff-known-failures.sh <tap-output-file> <known-failures-file> [upstream-exit-code]
#
# 基线失败集 diff 门(2026-07-18 门禁审计批C:**测试点全路径粒度**):
# 比较 node:test TAP 输出中**所有层级**失败点的全路径集合与已知存量失败清单,
# 只有「新增失败」才让 CI 变红;基线里已登记的存量失败不刷屏、不拦截。
#
# 粒度升级动机:旧版只比较顶层 `^not ok` —— 基线内 suite 的内部新增子失败被
# 整体豁免(31 条顶层豁免 = CI 最大 fail-open)。现在:
#   · 提取 = 所有深度的 not ok,反向扫描按缩进建全路径("suiteA > sub2");
#   · 基线行 = 精确路径;`X > *` 结尾 = 通配 X 全部后代(仅限 flaky 套件,见清单头注);
#   · TAP 截断守卫:结尾必须有 `# tests N` 汇总行,否则视为 runner 中途崩溃 → 红
#     (防"崩溃前打出的失败恰好全在基线内"的窄边缘 fail-open)。
# 清单维护方法见 docs/V5_CI.md。
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

# 实际失败集:全深度 not ok 的**全路径**名(反向扫描——TAP 里父结果行在子结果行
# 之后,倒序后父先出现,用缩进层级栈拼 "父 > 子" 路径;TODO/SKIP 指令后缀剥除)。
# 与清单重生成命令保持一字不差(docs/V5_CI.md)。
tac "$tap_file" | awk '
/^( *)(not )?ok [0-9]+ - / {
  line=$0; indent=0
  while (substr(line, indent+1, 1) == " ") indent++
  name=line
  sub(/^ *(not )?ok [0-9]+ - /, "", name)
  sub(/ # (TODO|SKIP).*$/, "", name)
  # 路径归一化:tsx 多文件模式把测试文件的**绝对路径**当顶层测试名 —— 跨机器必失配,
  # 统一剥成仓库相对路径(packages/... scripts/... e2e/...)。
  sub(/^\/[^ ]*\/packages\//, "packages/", name)
  sub(/^\/[^ ]*\/scripts\//, "scripts/", name)
  sub(/^\/[^ ]*\/e2e\//, "e2e/", name)
  ctx[indent]=name
  if (line ~ /^ *not ok /) {
    path=name
    for (d=indent-4; d>=0; d-=4) { if (d in ctx) path=ctx[d] " > " path }
    print path
  }
}' | sort -u > "$workdir/actual" || true

# 基线:去空行/整行注释;拆成精确集与 glob 前缀集(`X > *` → 前缀 "X > ")。
grep -v -e '^[[:space:]]*$' -e '^#' "$known_file" | sort -u > "$workdir/known_all" || true
grep -v ' > \*$' "$workdir/known_all" > "$workdir/known_exact" || true
sed -n 's/ > \*$/ > /p' "$workdir/known_all" > "$workdir/known_globs" || true

# 健壮性①:TAP 里一个测试点都没有 → 套件根本没跑起来,直接红
total_points="$(grep -c -E '^ *(not )?ok [0-9]' "$tap_file" || true)"
if [[ "$total_points" -eq 0 ]]; then
  echo "::error::no TAP test points found in $tap_file — test run crashed before producing results" >&2
  exit 1
fi
# 健壮性②(截断守卫):node:test 正常收尾必打 `# tests N` 汇总。缺失 = runner 中途
# 崩溃/被杀——此时"已打出的失败恰好全在基线内"不能算 PASS(窄边缘 fail-open)。
if ! grep -q -E '^# tests [0-9]+' "$tap_file"; then
  echo "::error::TAP output has no final '# tests N' summary — runner crashed/killed mid-run, results incomplete" >&2
  exit 1
fi

# glob 匹配:actual 中命中任一 glob 前缀的行视为已豁免。
match_glob() { # <path> ;命中返回 0
  local p="$1" g
  while IFS= read -r g; do
    [[ -n "$g" && "$p" == "$g"* ]] && return 0
  done < "$workdir/known_globs"
  return 1
}

new_failures=""
while IFS= read -r p; do
  [[ -n "$p" ]] || continue
  grep -Fxq "$p" "$workdir/known_exact" && continue
  match_glob "$p" && continue
  new_failures+="$p"$'\n'
done < "$workdir/actual"
new_failures="${new_failures%$'\n'}"

stale_entries="$(comm -23 "$workdir/known_exact" "$workdir/actual")"
known_still_failing="$(comm -12 "$workdir/known_exact" "$workdir/actual")"

echo "== known-failures diff gate(测试点全路径粒度)=="
echo "TAP test points(all depths): $total_points"
echo "actual failing paths:        $(wc -l < "$workdir/actual")"
echo "baseline exact entries:      $(wc -l < "$workdir/known_exact")"
echo "baseline glob entries:       $(wc -l < "$workdir/known_globs")"
echo "known & still failing:       $(printf '%s' "$known_still_failing" | grep -c . || true)"

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
  echo "Fix the regression, or (only for pre-existing failures newly exposed by env changes) add the exact path line to $known_file with justification. See docs/V5_CI.md."
  exit 1
fi

# 没有新增失败,但如果上游 exit code 非 0 且实际失败集为空 → 非测试失败类崩溃,红
if [[ -n "$upstream_exit" && "$upstream_exit" != "0" ]]; then
  if [[ ! -s "$workdir/actual" ]]; then
    echo "::error::test runner exited $upstream_exit but no 'not ok' found — infrastructure failure, inspect TAP output" >&2
    exit 1
  fi
fi

echo ""
echo "PASS: no new failures beyond baseline."
