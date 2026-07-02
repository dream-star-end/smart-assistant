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
  mapfile -t skills < <(curl -sf "${auth[@]}" "$V5_BASE/api/skills" |
    python3 -c 'import sys,json;[print(s["name"]) for s in json.load(sys.stdin).get("skills",[])]')
fi

fail=0
for name in "${skills[@]}"; do
  evals=$(curl -sf "${auth[@]}" "$V5_BASE/api/skills/$name/evals" || echo '{}')
  cases=$(echo "$evals" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len((d.get("evals") or {}).get("cases",[])))' 2>/dev/null || echo 0)
  [ "$cases" -eq 0 ] && continue
  echo "== eval $name ($cases cases) =="
  runId=$(curl -sf -X POST "${auth[@]}" -H 'Content-Type: application/json' \
    "$V5_BASE/api/skills/$name/eval-run" -d '{"mode":"baseline"}' |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])') || { echo "  start failed"; fail=1; continue; }
  for _ in $(seq 1 120); do
    sleep 10
    st=$(curl -sf "${auth[@]}" "$V5_BASE/api/skill-eval/$runId" |
      python3 -c 'import sys,json;r=json.load(sys.stdin)["run"];print(r["status"], "|", (r.get("benchmark") or {}).get("verdict",""))')
    status="${st%% |*}"
    case "$status" in
      done) echo "  $st"; echo "$st" | grep -q "反而更差" && { echo "  REGRESSION"; fail=1; }; break ;;
      failed) echo "  FAILED: $st"; fail=1; break ;;
    esac
  done
done
exit $fail
