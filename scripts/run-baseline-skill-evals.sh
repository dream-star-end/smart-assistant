#!/usr/bin/env bash
# run-baseline-skill-evals.sh — 平台 baseline 技能的评测回归(部署 checklist / CI 用)。
#
# 在 canary 账号的容器上,对**带 evals 的技能**逐个跑一轮 baseline 评测(with/without),
# 任何一项 verdict 为「有技能反而更差」或运行失败 → 非零退出(阻断发版)。
#
# 成本:跑在 canary 账号(平台自担),锁 deepseek-v4-pro;技能数 × 用例数 决定消耗。
# 用法:
#   V5_BASE=http://127.0.0.1:18790 EMAIL=v5-canary@claudeai.chat PASSWORD=... \
#     scripts/run-baseline-skill-evals.sh [skill1 skill2 ...]
#   不传技能名 = 遍历该账号可见技能里所有带 evals 的。
#   OC_EVAL_RESULTS_FILE=<path> 时,每个技能完成后追加一行机器可读 JSONL
#   {skill,runId,status,benchmark} —— 周期回归管道(v5-baseline-evals-weekly.sh)
#   靠它做历史对比,别改字段名。
set -euo pipefail

V5_BASE="${V5_BASE:-http://127.0.0.1:18790}"
EMAIL="${EMAIL:-v5-canary@claudeai.chat}"
: "${PASSWORD:?PASSWORD required}"

TOK=$(curl -sf -X POST "$V5_BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"turnstile_token\":\"x\"}" |
  python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

auth=(-H "Authorization: Bearer $TOK")

skills=("$@")
if [ ${#skills[@]} -eq 0 ]; then
  # 默认清单 = 平台 baseline 里带 evals 的技能(从仓库树枚举 —— /api/skills 是
  # 用户管理面,有意不枚举平台技能) + 该账号自建的用户技能。
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  BASELINE_SKILLS_DIR="$SCRIPT_DIR/../packages/commercial/agent-sandbox/ccb-baseline/skills"
  if [ -d "$BASELINE_SKILLS_DIR" ]; then
    while IFS= read -r f; do
      skills+=("$(basename "$(dirname "$(dirname "$f")")")")
    done < <(find "$BASELINE_SKILLS_DIR" -mindepth 3 -maxdepth 3 -name evals.json -path '*/evals/*' | sort)
  fi
  mapfile -t user_skills < <(curl -sf "${auth[@]}" "$V5_BASE/api/skills" |
    python3 -c 'import sys,json;[print(s["name"]) for s in json.load(sys.stdin).get("skills",[])]')
  skills+=("${user_skills[@]}")
fi
[ ${#skills[@]} -gt 0 ] || { echo "no skills to evaluate"; exit 0; }

fail=0
for name in "${skills[@]}"; do
  # 取 evals 必须区分"确认无 evals"与"取数失败"(容器冷启动的代理瞬态 5xx 曾把
  # web-context 静默跳过):失败重试,重试耗尽计 fail 而不是当作无用例跳过。
  evals=""
  for attempt in 1 2 3; do
    evals=$(curl -sf "${auth[@]}" "$V5_BASE/api/skills/$name/evals") && break
    evals=""
    [ "$attempt" -lt 3 ] && sleep 15
  done
  if [ -z "$evals" ]; then
    echo "== eval $name: FETCH FAILED (evals GET 3 次均失败,非'无 evals')"
    fail=1
    continue
  fi
  cases=$(echo "$evals" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len((d.get("evals") or {}).get("cases",[])))' 2>/dev/null || echo 0)
  [ "$cases" -eq 0 ] && continue
  echo "== eval $name ($cases cases) =="
  runId=$(curl -sf -X POST "${auth[@]}" -H 'Content-Type: application/json' \
    "$V5_BASE/api/skills/$name/eval-run" -d '{"mode":"baseline"}' |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])') || { echo "  start failed"; fail=1; continue; }
  final_status=""
  for _ in $(seq 1 120); do
    sleep 10
    st=$(curl -sf "${auth[@]}" "$V5_BASE/api/skill-eval/$runId" |
      python3 -c 'import sys,json;r=json.load(sys.stdin)["run"];print(r["status"], "|", (r.get("benchmark") or {}).get("verdict",""))')
    status="${st%% |*}"
    case "$status" in
      done) echo "  $st"; echo "$st" | grep -q "反而更差" && { echo "  REGRESSION"; fail=1; }; final_status=done; break ;;
      failed) echo "  FAILED: $st"; fail=1; final_status=failed; break ;;
    esac
  done
  [ -n "$final_status" ] || { echo "  TIMEOUT (20min 未终态)"; fail=1; final_status=timeout; }
  if [ -n "${OC_EVAL_RESULTS_FILE:-}" ]; then
    curl -sf "${auth[@]}" "$V5_BASE/api/skill-eval/$runId" |
      python3 -c 'import sys,json;r=json.load(sys.stdin)["run"];print(json.dumps({"skill":sys.argv[1],"runId":r.get("runId"),"status":r.get("status"),"benchmark":r.get("benchmark")},ensure_ascii=False))' "$name" \
      >> "$OC_EVAL_RESULTS_FILE" ||
      printf '{"skill":"%s","runId":"%s","status":"%s","benchmark":null}\n' "$name" "$runId" "$final_status" >> "$OC_EVAL_RESULTS_FILE"
  fi
done
exit $fail
