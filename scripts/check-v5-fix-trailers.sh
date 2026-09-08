#!/usr/bin/env bash
# check-v5-fix-trailers.sh — Incident trailer 闭环门的**发布前**快检(纯 git + jq,毫秒级)。
#
# 为什么要有第二份实现:
#   scripts/check-v5-incident-regressions.ts 是这道门的权威(CI / 商业版 deploy-v5.sh 调),
#   但 selfhost 发布(deploy-v5-selfhost.sh)从不跑它 —— 于是坏 trailer 每次都是**上线之后**
#   才被 CI 发现,而已上线的源提交不可 amend,只能往 IMPORTED_TRAILER_HISTORY_TIPS 里再冻一条
#   已上线 tip(2026-09-08 已冻到第 18 条)。本脚本把「fix(v5) 触碰用户可见面 → 必带合法
#   Incident trailer」这一条抽出来,在 selfhost 构建三面制品**之前** fail-closed,让坏 trailer
#   在还能改的时候被拦住。
#
# 与 TS 门的规则逐条对齐(改一处必须同步改另一处;有单测交叉对拍):
#   · 起点 = marker 文件首次被 git 添加的 commit(运行时自算,不写死 SHA)
#   · 早于起点提交时间的 commit 不判(并行合入的旧提交,门当时不存在)
#   · IMPORTED_TRAILER_HISTORY_TIPS(从 TS 源码解析)的祖先不判(已上线不可改写)
#   · 只判 subject ^fix(v5) 且触碰 packages/{gateway,commercial,web-react,protocol,storage}/
#   · trailer 缺失 → 红(仅 aa583b70 exact emergency 例外,与 TS 一致)
#   · `Incident: none ...` → 必须在 incident-waivers.json 有 waiver 且未过期
#   · 否则必须匹配 ^INC-[0-9]{8}-[A-Z0-9-]{3,40}$ 且在 incidents.json 内且 lineage 含本 commit
#
# 本脚本**不**复算 incidents.json 的锚点/layer/runner 等重校验 —— 那些留给 TS 权威门;
# 这里只拦"这条 commit 的 trailer 本身合不合法"。
#
# 用法: scripts/check-v5-fix-trailers.sh [--repo <dir>] [--head <rev>] [--quiet]
# 退出码: 0 全部合规 / 1 有违规(stderr 逐条列出) / 2 环境不满足(非 git 仓 / 缺 jq / 门未生效)
set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEAD_REV="HEAD"
QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --head) HEAD_REV="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

MARKER="e2e/session-display/incident-trailer-enforced-from"
CHECKER="scripts/check-v5-incident-regressions.ts"
INCIDENTS="e2e/session-display/incidents.json"
WAIVERS="e2e/session-display/incident-waivers.json"
SURFACES=(packages/gateway/ packages/commercial/ packages/web-react/ packages/protocol/ packages/storage/)
INC_RE='^INC-[0-9]{8}-[A-Z0-9-]{3,40}$'
# 与 TS 门完全相同的唯一 exact emergency 例外(不可变 P0 containment)。
EMERGENCY_SHA="aa583b702d5e454801e90ff3c6b25df38e808a98"

g() { git -C "$REPO" "$@"; }
say() { [[ "$QUIET" == 1 ]] || echo "$*"; }
bad() { echo "✗ [fix-trailers] $*" >&2; }

command -v jq >/dev/null 2>&1 || { echo "[fix-trailers] 缺 jq" >&2; exit 2; }
g rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "[fix-trailers] $REPO 不是 git 仓库" >&2; exit 2; }
for f in "$MARKER" "$CHECKER" "$INCIDENTS" "$WAIVERS"; do
  g cat-file -e "$HEAD_REV:$f" 2>/dev/null || { echo "[fix-trailers] $HEAD_REV 缺 $f,门无法判定" >&2; exit 2; }
done

# ── 起点:marker 首次添加的 commit(同一路径可能删后重加:取最早那次)──
start="$(g log --diff-filter=A --format=%H "$HEAD_REV" -- "$MARKER" | tail -n1)"
if [[ -z "$start" ]]; then
  echo "[fix-trailers] trailer 门尚未生效(marker 在 $HEAD_REV 历史里找不到添加记录),跳过" >&2
  exit 2
fi
if ! g merge-base --is-ancestor "$start" "$HEAD_REV" 2>/dev/null; then
  if [[ "$(g rev-parse --is-shallow-repository)" == "true" ]]; then
    echo "[fix-trailers] 浅克隆,起点 ${start:0:12} 不可达,跳过" >&2; exit 2
  fi
  echo "[fix-trailers] 起点 ${start:0:12} 不是 $HEAD_REV 的祖先 —— 门坏了(marker 被 rebase 冲掉?)" >&2
  exit 1
fi
anchor_ts="$(g log -1 --format=%ct "$start")"

# ── 冻结 tip:从 TS 权威源解析 IMPORTED_TRAILER_HISTORY_TIPS,只认其祖先 ──
mapfile -t frozen_tips < <(
  g show "$HEAD_REV:$CHECKER" \
    | sed -n '/const IMPORTED_TRAILER_HISTORY_TIPS = \[/,/\] as const/p' \
    | grep -oE '"[0-9a-f]{40}"' | tr -d '"'
)
reachable_tips=()
for t in "${frozen_tips[@]}"; do
  if g cat-file -e "${t}^{commit}" 2>/dev/null && g merge-base --is-ancestor "$t" "$HEAD_REV" 2>/dev/null; then
    reachable_tips+=("$t")
  else
    bad "冻结的 trailer import tip ${t:0:12} 不可达 $HEAD_REV,拒绝静默失效"
    exit 1
  fi
done
# 候选集一次算清:start..HEAD 里**不是**任何冻结 tip 祖先的提交 = `rev-list start..HEAD ^tip1 ^tip2 …`。
# 比逐条 merge-base(2198 提交 × 18 tip ≈ 4 万次 fork)快三个量级 —— 2026-09-09 实测前者 7 分钟,后者 <2 秒。
not_frozen_args=()
for t in "${reachable_tips[@]}"; do not_frozen_args+=("^$t"); done
declare -A candidate=()
while read -r s; do [[ -n "$s" ]] && candidate["$s"]=1; done < <(
  g rev-list --no-merges "${start}..${HEAD_REV}" "${not_frozen_args[@]}"
)
is_frozen() { [[ -z "${candidate[$1]+x}" ]]; }

# ── waivers / incidents 快照(取 HEAD_REV 版本,不吃工作区脏改)──
waivers_json="$(g show "$HEAD_REV:$WAIVERS")"
incidents_json="$(g show "$HEAD_REV:$INCIDENTS")"
[[ "$(jq -r '.schema' <<<"$waivers_json")" == "1" ]] || { bad "incident-waivers.json schema 必须是 1"; exit 1; }
today="$(date -u +%F)"

waiver_for() { # <sha8> → json 或空
  jq -c --arg k "$1" '.waivers[] | select((.commit|.[0:8]) == $k)' <<<"$waivers_json" | head -n1
}
incident_by_id() { # <id> → json 或空
  jq -c --arg id "$1" '.incidents[] | select(.id == $id)' <<<"$incidents_json" | head -n1
}
incident_for_sha() { # <sha> → id 或空(按 rootFixCommit/coverageCommits 前缀匹配)
  jq -r --arg sha "$1" '
    .incidents[] | select(([.rootFixCommit] + (.coverageCommits // [])) | any(. as $c | $sha | startswith($c))) | .id
  ' <<<"$incidents_json" | head -n1
}

# ── 主循环:start..HEAD 非 merge 提交 ──
violations=0
checked=0
while IFS=$'\x1f' read -r -d $'\x1e' sha subject body committed_at || [[ -n "${sha:-}" ]]; do
  sha="${sha#$'\n'}"; [[ -n "$sha" ]] || continue
  [[ "$committed_at" -lt "$anchor_ts" ]] && continue
  is_frozen "$sha" && continue
  [[ "$subject" =~ ^fix\(v5\) ]] || continue
  touched="$(g show --format= --name-only "$sha")"
  hit=0
  for s in "${SURFACES[@]}"; do
    if grep -q "^$s" <<<"$touched"; then hit=1; break; fi
  done
  [[ "$hit" == 1 ]] || continue
  checked=$((checked + 1))
  sha8="${sha:0:8}"

  trailer="$(grep -E -m1 '^Incident:[[:space:]]*' <<<"$body" | sed -E 's/^Incident:[[:space:]]*//; s/[[:space:]]+$//' || true)"

  if [[ -z "$trailer" ]]; then
    w="$(waiver_for "$sha8")"
    inc_id="$(incident_for_sha "$sha")"
    inc_root="$(incident_by_id "$inc_id" 2>/dev/null | jq -r '.rootFixCommit // empty' 2>/dev/null || true)"
    if [[ "$sha" == "$EMERGENCY_SHA" && -n "$w" && "$(jq -r '.emergencyMissingTrailer // false' <<<"$w")" == "true" \
          && "$inc_id" == "INC-20260804-RETRY-ERROR-REDCARD" && "$inc_root" == "aa583b70" ]]; then
      exp="$(jq -r '.expiresAt' <<<"$w")"
      if [[ "$exp" < "$today" ]]; then bad "$sha8 的 emergency trailer waiver 已于 $exp 过期"; violations=$((violations + 1)); fi
      continue
    fi
    bad "$sha8 \"$subject\" 触碰用户可见面但缺 trailer:Incident: INC-YYYYMMDD-SLUG,或 Incident: none (<理由>) + waiver"
    violations=$((violations + 1)); continue
  fi

  if [[ "$trailer" =~ ^none([^A-Za-z0-9]|$) ]]; then
    w="$(waiver_for "$sha8")"
    if [[ -z "$w" ]]; then
      bad "$sha8 声明 Incident: none,但 $WAIVERS 里没有对应 waiver"; violations=$((violations + 1)); continue
    fi
    exp="$(jq -r '.expiresAt' <<<"$w")"
    if [[ "$exp" < "$today" ]]; then bad "$sha8 的 waiver 已于 $exp 过期"; violations=$((violations + 1)); fi
    continue
  fi

  if ! [[ "$trailer" =~ $INC_RE ]]; then
    bad "$sha8 \"$subject\" 的 Incident trailer 格式非法:$trailer(应为 INC-YYYYMMDD-SLUG,或 none (<理由>) + waiver)"
    violations=$((violations + 1)); continue
  fi
  inc="$(incident_by_id "$trailer")"
  if [[ -z "$inc" ]]; then
    bad "$sha8 指向的 $trailer 不在 $INCIDENTS 内(补登记后再合)"; violations=$((violations + 1)); continue
  fi
  if ! jq -e --arg sha "$sha" '([.rootFixCommit] + (.coverageCommits // [])) | any(. as $c | $sha | startswith($c))' <<<"$inc" >/dev/null; then
    bad "$sha8 声明 $trailer,但该事故的 rootFixCommit/coverageCommits 未包含本 commit"
    violations=$((violations + 1)); continue
  fi
done < <(g log --no-merges --format='%H%x1f%s%x1f%b%x1f%ct%x1e' "${start}..${HEAD_REV}" "${not_frozen_args[@]}")

if [[ "$violations" -gt 0 ]]; then
  echo "✗ [fix-trailers] $violations 条 fix(v5) 提交的 Incident trailer 不合规(共检 $checked 条)。修法:在源提交 trailer 写 Incident: INC-YYYYMMDD-SLUG 并登记 incidents.json;或 Incident: none (<理由>) + incident-waivers.json。已上线不可改写的提交才走 IMPORTED_TRAILER_HISTORY_TIPS 冻结。" >&2
  exit 1
fi
say "✓ [fix-trailers] PASS: 起点 ${start:0:12}, 冻结 tip ${#reachable_tips[@]} 条, 检查 $checked 条 fix(v5) 提交"
exit 0
