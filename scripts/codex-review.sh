#!/usr/bin/env bash
# 统一的 Codex 审查调用(配合 AGENTS.md「Codex review rubric」)。
# 把范围(diff 基线)、轮次 N/M、上一轮 findings、已定设计决定拼进提示,以只读沙箱调用 codex exec。
# 只改审查的组织方式,不改任何门:CI / 事故证明 / fix-trailers / 发车预检照旧。
#
# 用法:
#   scripts/codex-review.sh --base <ref> --round <N> --max-rounds <M> -o <输出文件>
#        [--prev <上一轮输出文件>] [--decisions <已定设计决定文件>] [--focus "<一句话重点>"] [--print-prompt]
# 退出码:codex 原样;2 = 用法错误(含工作树不干净:先提交再审,审查期间树变了会卡住)。
set -euo pipefail

die() { echo "✗ $*" >&2; exit 2; }

base="" round="" max="" prev="" decisions="" focus="" out="" print_only=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) base="${2:-}"; shift 2 ;;
    --round) round="${2:-}"; shift 2 ;;
    --max-rounds) max="${2:-}"; shift 2 ;;
    --prev) prev="${2:-}"; shift 2 ;;
    --decisions) decisions="${2:-}"; shift 2 ;;
    --focus) focus="${2:-}"; shift 2 ;;
    -o) out="${2:-}"; shift 2 ;;
    --print-prompt) print_only=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done
[[ -n "$base" ]] || die "缺 --base"
[[ "$round" =~ ^[1-9]$ && "$max" =~ ^[1-3]$ ]] || die "--round 1-9、--max-rounds 1-3(rubric:小改动 1 轮,大改动最多 3 轮)"
(( round <= max )) || die "第 $round 轮已超过上限 $max:按 rubric 由发起方裁决并留痕,不再送审"
git rev-parse --verify --quiet "${base}^{commit}" >/dev/null || die "--base 不是可解析的提交: $base"
if (( round > 1 )); then
  [[ -s "$prev" ]] || die "第 $round 轮必须给 --prev(上一轮输出),rubric 要求轮次记忆"
fi
[[ -z "$decisions" || -s "$decisions" ]] || die "--decisions 文件不存在或为空: $decisions"
[[ "$print_only" == 1 || -n "$out" ]] || die "缺 -o 输出文件"
[[ "$print_only" == 1 || -z "$(git status --porcelain)" ]] || die "工作树不干净:先提交再审"

head_sha="$(git rev-parse HEAD)"
stat="$(git diff --shortstat "$base"...HEAD)"

prompt="$(
  echo "按仓库 AGENTS.md 的「Codex review rubric」审查。不要偏离它的范围、严重度和输出格式。"
  echo
  echo "范围:git diff $base...HEAD(HEAD=$head_sha;$stat)。只审这个 diff 与它直接影响的调用方。"
  echo "轮次:第 $round 轮 / 上限 $max。"
  [[ -n "$focus" ]] && echo "重点:$focus"
  if [[ -n "$decisions" ]]; then
    echo
    echo "已定设计决定(不要重提,除非能给出它导致 P0/P1 的具体复现):"
    cat "$decisions"
  fi
  if (( round > 1 )); then
    echo
    echo "上一轮结论(本轮只核对其中每条 P0/P1 是否真修好,并只在新增 diff 里找新的 P0/P1;不重审全部):"
    cat "$prev"
  fi
  echo
  echo "输出:没有 P0/P1 就只输出一行 APPROVED(可另起「非阻断:」);否则第一行 REQUEST_CHANGES,每条 [P0|P1] 文件:行 — 原因 — 复现。"
)"

if [[ "$print_only" == 1 ]]; then
  printf '%s\n' "$prompt"
  exit 0
fi
printf '%s\n' "$prompt" | codex exec -s read-only -o "$out" -
