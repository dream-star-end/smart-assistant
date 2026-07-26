#!/usr/bin/env bash
# diff-known-failures.sh <tap-output-file> <known-failures-file> [upstream-exit-code]
#
# 基线失败集 diff 门。清单维护方法见 docs/V5_CI.md。
#
# ── 2026-07-26 门禁审计后的重写 ────────────────────────────────────────────────
# 旧版只做一件事:比对顶层 `^not ok` 名字集合与基线。实测(主干全绿 run
# 30190800591 的 commercial-unit TAP artifact)这有三个致命洞:
#
#   ① 判据只覆盖 19 个顶层名,而同一份 TAP 里 `# fail 61` / `# cancelled 39`,
#      嵌套 `not ok` 有 103 条 —— 61 个真实失败 + 39 个 cancelledByParent 全部
#      不进判据。灵敏度 19 / 4696。
#   ② 跑了一半也算绿:runner OOM / test-mutex 看门狗 kill(rc=124)/ 中途崩溃,
#      只要没冒出新的顶层失败名,门照样打印 PASS。
#   ③ infra-failure 分支是死代码:它要求 `upstream_exit != 0 && actual 为空`,
#      而基线保证 actual 恒有 19 行,那个分支永远走不到。
#
# 重写后的判据(任一不满足即红):
#   A. TAP 完整性 —— 必须有顶层 plan 行 `1..N`,且 N == 实际顶层测试点数;
#      必须有 `# tests / # pass / # fail / # cancelled / # skipped` 汇总行。
#      这一条堵死洞 ②:kill/OOM 的 TAP 尾部一定缺 plan 或缺汇总行。
#   B. `# skipped` 必须为 0 —— fixture 没起来时整套会静默 skip,
#      "全 skip 也算绿"是最典型的假绿。当前 CI 实测 skipped=0,现在就钉死。
#   C. `# fail` / `# cancelled` 不得超过 counts 基线(见 <baseline>.counts)。
#      这一条把灵敏度从 19 个顶层名提到 4696 个测试点,且不用改基线粒度。
#      低于基线 → warning 提示收紧。
#   D. 顶层新增失败(不在基线里)→ 红,同旧版。
#   E. 核心契约套件禁豁免:core-contract-suites.txt 里的名字一旦出现在基线里
#      → 直接红。这些套件各自对应一条用户当场能看见的事实,永远不许被豁免。
#   F. stale 条目(基线里本轮没失败的)→ CI 里红(修好了就删行,是硬要求);
#      本地默认降级为 warning,因为基线是**按 CI 环境**校准的(docker mock /
#      fixture 差异会让本地失败集与 CI 不同)。
#   G. upstream_exit != 0 一律红,除非 A–F 全部通过 —— 也就是"顶层失败集 ⊆ 基线
#      且 plan 完整且计数未超基线"。另外补一条:exit != 0 但 TAP 显示零失败零取消
#      → 非测试失败(退出钩子 / force-exit / 段错误),红。
#
# 严格档开关:CI=true 时默认严格(stale = 红,计数超标 = 红)。
#   本地想跑严格档:KNOWN_FAILURES_STRICT=1。
#   本地默认宽松档:stale 与计数只 warning;A/B/D/E/G 在两档下都是硬红
#   —— 那几条与环境无关(截断就是截断,全 skip 就是全 skip)。
#
# 提取规则(与清单生成命令保持一字不差,见 docs/V5_CI.md):
#   grep '^not ok' | sed 's/^not ok [0-9]* - //' | sort -u
# 注意:^not ok 只匹配列 0(顶层 test/suite),嵌套子测试是缩进的,不参与名字比较
#   —— 嵌套失败由判据 C 的计数上界兜住。
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <tap-output-file> <known-failures-file> [upstream-exit-code]" >&2
  exit 2
fi

tap_file="$1"
known_file="$2"
upstream_exit="${3:-}"

# counts 基线与核心契约清单默认与 known_file 同目录、同前缀。
known_dir="$(dirname "$known_file")"
known_stem="$(basename "$known_file" .txt)"
counts_file="${KNOWN_FAILURE_COUNTS:-$known_dir/$known_stem.counts}"
core_file="${CORE_CONTRACT_SUITES:-$known_dir/core-contract-suites.txt}"

# 严格档:CI 里默认开;本地默认关(基线按 CI 环境校准,见文件头 F)。
strict="${KNOWN_FAILURES_STRICT:-}"
if [[ -z "$strict" ]]; then
  if [[ "${CI:-}" == "true" || "${CI:-}" == "1" ]]; then strict=1; else strict=0; fi
fi

fail_hard=0
note_fail() {
  echo "::error::$1" >&2
  fail_hard=1
}
# 严格档下是红,宽松档下只是 warning。
note_strict() {
  if [[ "$strict" == "1" ]]; then
    echo "::error::$1" >&2
    fail_hard=1
  else
    echo "::warning::$1(本地宽松档;CI 严格档下这是红)" >&2
  fi
}

for f in "$tap_file" "$known_file" "$counts_file" "$core_file"; do
  if [[ ! -f "$f" ]]; then
    echo "::error::required gate input not found: $f" >&2
    echo "  (counts 基线与核心契约清单都是门的一部分,删掉文件不等于跳过判据)" >&2
    exit 1
  fi
done

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

strip_comments() {
  grep -v -e '^[[:space:]]*$' -e '^#' "$1" || true
}

# ── 提取 ─────────────────────────────────────────────────────────────────────
# 实际失败集(顶层 not ok 的测试/套件名,去重排序)
{ grep '^not ok' "$tap_file" || true; } | sed 's/^not ok [0-9]* - //' | sort -u > "$workdir/actual"
# 基线(去掉空行与整行注释;TAP 名字里的 '#' 会被转义成 '\#',不会顶格出现)
strip_comments "$known_file" | sort -u > "$workdir/known"
strip_comments "$core_file" | sort -u > "$workdir/core"

total_points="$(grep -c -E '^(not )?ok [0-9]' "$tap_file" || true)"
: "${total_points:=0}"

# 汇总行 `# tests 4696` → 4696;取不到回显空串。
tap_summary() {
  sed -n "s/^# $1 \([0-9][0-9]*\)\$/\1/p" "$tap_file" | tail -n 1
}
# 顶层 plan 行 `1..N`(嵌套 plan 是缩进的,^ 锚定挡掉)。
plan_n="$(sed -n 's/^1\.\.\([0-9][0-9]*\)$/\1/p' "$tap_file" | tail -n 1)"

sum_tests="$(tap_summary tests)"
sum_pass="$(tap_summary pass)"
sum_fail="$(tap_summary fail)"
sum_cancelled="$(tap_summary cancelled)"
sum_skipped="$(tap_summary skipped)"

# counts 基线:`key = value` 纯文本,# 开头是注释。
counts_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)[[:space:]]*\$/\1/p" \
    "$counts_file" | tail -n 1
}
max_fail="$(counts_value fail_max)"
max_cancelled="$(counts_value cancelled_max)"

echo "== known-failures diff gate =="
echo "strict mode:                ${strict} (CI=${CI:-unset})"
echo "top-level test points:      $total_points (plan: ${plan_n:-<missing>})"
echo "TAP summary:                tests=${sum_tests:-?} pass=${sum_pass:-?} fail=${sum_fail:-?} cancelled=${sum_cancelled:-?} skipped=${sum_skipped:-?}"
echo "counts baseline:            fail_max=${max_fail:-<missing>} cancelled_max=${max_cancelled:-<missing>}"
echo "actual failing (top-level): $(wc -l < "$workdir/actual")"
echo "baseline entries:           $(wc -l < "$workdir/known")"

# ── A. TAP 完整性 ────────────────────────────────────────────────────────────
if [[ "$total_points" -eq 0 ]]; then
  note_fail "no TAP test points found in $tap_file — 套件根本没跑起来"
fi
if [[ -z "$plan_n" ]]; then
  note_fail "TAP 缺顶层 plan 行 \`1..N\`:$tap_file —— 进程在跑完前就没了(OOM / 看门狗 kill / 崩溃)。跑了一半不算绿。"
elif [[ "$plan_n" -ne "$total_points" ]]; then
  note_fail "TAP plan 与实际测试点数不符:plan=1..$plan_n,实际顶层测试点=$total_points —— 输出被截断或被并发写串了。"
fi
for key in tests pass fail cancelled skipped; do
  val_var="sum_$key"
  if [[ -z "${!val_var}" ]]; then
    note_fail "TAP 缺汇总行 \`# $key N\`:$tap_file —— 汇总行是 runner 正常收尾的证据,缺了就不能判绿。"
  fi
done

# ── B. skipped 必须为 0 ──────────────────────────────────────────────────────
if [[ -n "$sum_skipped" && "$sum_skipped" -ne 0 ]]; then
  note_fail "TAP 报告 # skipped $sum_skipped —— v5 门禁不接受任何 skip(fixture 没起来时整套会静默 skip,那是最典型的假绿)。把 skip 改成硬失败,或把用例真正跑起来。"
fi

# ── C. 计数基线 ──────────────────────────────────────────────────────────────
if [[ -z "$max_fail" || -z "$max_cancelled" ]]; then
  note_fail "counts 基线 $counts_file 缺 fail_max / cancelled_max —— 格式见该文件头。"
else
  if [[ -n "$sum_fail" && "$sum_fail" -gt "$max_fail" ]]; then
    note_strict "失败测试点数上升:# fail $sum_fail > 基线 fail_max $max_fail($counts_file)。顶层名字可能没变,但基线套件内部多了 $((sum_fail - max_fail)) 个失败 —— 这正是旧门看不见的那一类回归。"
  fi
  if [[ -n "$sum_cancelled" && "$sum_cancelled" -gt "$max_cancelled" ]]; then
    note_strict "取消(cancelledByParent)测试点数上升:# cancelled $sum_cancelled > 基线 cancelled_max $max_cancelled($counts_file)。父套件挂得更早了,大片用例根本没执行。"
  fi
  if [[ -n "$sum_fail" && "$sum_fail" -lt "$max_fail" ]]; then
    echo "::warning::# fail $sum_fail < 基线 fail_max $max_fail —— 修好了就把 $counts_file 的 fail_max 收到 $sum_fail,否则这点收益马上会被下一次回归吃掉。"
  fi
  if [[ -n "$sum_cancelled" && "$sum_cancelled" -lt "$max_cancelled" ]]; then
    echo "::warning::# cancelled $sum_cancelled < 基线 cancelled_max $max_cancelled —— 同上,把 cancelled_max 收到 $sum_cancelled。"
  fi
fi

# ── E. 核心契约禁豁免 ────────────────────────────────────────────────────────
# 基线条目形如 `<suite> — <case>`;命中判据 = 完全相等,或以 `<suite> ` 开头。
forbidden=""
while IFS= read -r core_name; do
  [[ -z "$core_name" ]] && continue
  while IFS= read -r baseline_name; do
    [[ -z "$baseline_name" ]] && continue
    if [[ "$baseline_name" == "$core_name" || "$baseline_name" == "$core_name "* ]]; then
      forbidden+="  [FORBIDDEN] $baseline_name  (核心契约:$core_name)"$'\n'
    fi
  done < "$workdir/known"
done < "$workdir/core"
if [[ -n "$forbidden" ]]; then
  echo "" >&2
  note_fail "核心契约套件出现在 known-failures 基线里 —— 这些套件禁止豁免(判据见 $core_file):"
  printf '%s' "$forbidden" >&2
  echo "  修好它,或者证明该名字不该在核心契约清单里,连同理由一起改 $core_file。" >&2
fi

# ── D/F. 顶层失败集 diff ─────────────────────────────────────────────────────
new_failures="$(comm -13 "$workdir/known" "$workdir/actual" || true)"
stale_entries="$(comm -23 "$workdir/known" "$workdir/actual" || true)"
known_still_failing="$(comm -12 "$workdir/known" "$workdir/actual" || true)"
echo "known & still failing:      $(printf '%s' "$known_still_failing" | grep -c . || true)"

if [[ -n "$new_failures" ]]; then
  echo "" >&2
  note_fail "NEW test failures (not in $known_file):"
  printf '%s\n' "$new_failures" | sed 's/^/  [NEW] /' >&2
  echo "  Fix the regression, or (only for pre-existing failures newly exposed by env changes) add the exact line to $known_file with justification. See docs/V5_CI.md." >&2
fi

if [[ -n "$stale_entries" ]]; then
  echo "" >&2
  note_strict "基线里这些条目本轮没有失败 —— 修好了就把行删掉,这是硬要求(留着 = 给未来的真回归预留豁免):"
  printf '%s\n' "$stale_entries" | sed 's/^/  [STALE] /' >&2
fi

# ── G. upstream exit ─────────────────────────────────────────────────────────
if [[ -n "$upstream_exit" && "$upstream_exit" != "0" ]]; then
  if [[ "${sum_fail:-0}" -eq 0 && "${sum_cancelled:-0}" -eq 0 && ! -s "$workdir/actual" ]]; then
    note_fail "test runner exited $upstream_exit 但 TAP 显示零失败零取消 —— 这不是测试失败,是 runner 层面的问题(退出钩子 / force-exit / 段错误 / 信号)。"
  fi
  # 其余情况:非零退出是"基线里那些已知失败"造成的,由上面 A–F 各条负责裁定。
fi

if [[ "$fail_hard" != "0" ]]; then
  echo "" >&2
  echo "FAIL: known-failures gate rejected this run." >&2
  exit 1
fi

echo ""
echo "PASS: no new failures beyond baseline, TAP complete, counts within baseline."
