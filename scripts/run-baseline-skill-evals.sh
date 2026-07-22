#!/usr/bin/env bash
# run-baseline-skill-evals.sh — 平台 baseline 技能的评测回归(部署 checklist / CI 用)。
#
# 在独立 eval 账号的容器上,对**带 evals 的技能**逐个跑一轮 baseline 评测(with/without),
# 任何一项 verdict 为「有技能反而更差」或运行失败 → 非零退出(阻断发版)。
#
# 成本:跑在 eval 账号(平台自担),锁 deepseek-v4-pro;技能数 × 用例数 决定消耗。
# 用法:
#   V5_BASE=http://127.0.0.1:18790 EMAIL=v5-evals@claudeai.chat PASSWORD=... \
#     scripts/run-baseline-skill-evals.sh [skill1 skill2 ...]
#   不传技能名 = 遍历该账号可见技能里所有带 evals 的。
#   OC_EVAL_RESULTS_FILE=<path> 时,每个技能完成后追加一行机器可读 JSONL
#   {skill,runId,status,benchmark} —— 周期回归管道(v5-baseline-evals-weekly.sh)
#   靠它做历史对比,别改字段名。
set -euo pipefail

V5_BASE="${V5_BASE:-http://127.0.0.1:18790}"
EMAIL="${EMAIL:-v5-evals@claudeai.chat}"
MAX_POLLS="${OC_EVAL_MAX_POLLS:-360}" # 每 10s 一次；默认单技能最多等 60min
: "${PASSWORD:?PASSWORD required}"

append_result_stub() { # <skill> <runId> <status>
  [ -n "${OC_EVAL_RESULTS_FILE:-}" ] || return 0
  python3 - "$1" "$2" "$3" >> "$OC_EVAL_RESULTS_FILE" <<'PY'
import json, sys
print(json.dumps({"skill": sys.argv[1], "runId": sys.argv[2] or None,
                  "status": sys.argv[3], "benchmark": None}, ensure_ascii=False))
PY
}

COOKIE_FILE="$(mktemp)"
chmod 600 "$COOKIE_FILE"
TOK=""
login() {
  TOK=$(curl -sf -b "$COOKIE_FILE" -c "$COOKIE_FILE" -X POST \
    "$V5_BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"turnstile_token\":\"x\"}" |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
}
cleanup() {
  curl -sf -b "$COOKIE_FILE" -X POST "$V5_BASE/api/auth/logout" \
    -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 || true
  rm -f "$COOKIE_FILE"
}
trap cleanup EXIT
login

auth=(-H "Authorization: Bearer $TOK")
refresh_auth() {
  local refreshed_tok
  if refreshed_tok=$(curl -sf -b "$COOKIE_FILE" -c "$COOKIE_FILE" -X POST \
    "$V5_BASE/api/auth/refresh" |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'); then
    TOK="$refreshed_tok"
    auth=(-H "Authorization: Bearer $TOK")
    echo "  AUTH REFRESHED"
    return 0
  fi
  echo "  AUTH REFRESH FAILED"
  return 1
}

benchmark_complete() {
  printf '%s' "$1" | python3 -c '
import json, math, sys
r = json.load(sys.stdin)["run"]
pr = (r.get("benchmark") or {}).get("passRate") or {}
ok = all(type(pr.get(arm)) in (int, float) and math.isfinite(pr[arm]) and 0 <= pr[arm] <= 1
         for arm in ("without", "with"))
sys.exit(0 if ok else 1)
' 2>/dev/null
}

# fail 早于默认清单枚举初始化:枚举阶段(用户技能拉取失败)也要能把它置 1,
# 且不能被后置的重复初始化清零(fail-closed)。
fail=0

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
  # 用户自建技能:进程替换 `mapfile < <(curl|python3)` 会吞掉 curl/python 的退出码,
  # 拉取失败时静默得到空数组 → 用户技能被悄悄漏评。落临时文件 + 显式校验退出码,
  # 失败重试一次;仍失败计 fail(不阻断已枚举的 baseline 平台技能评测,但整轮非零退出)。
  user_skills_file="$(mktemp)"
  fetched_user_skills=0
  for attempt in 1 2; do
    if curl -sf "${auth[@]}" "$V5_BASE/api/skills" |
         python3 -c 'import sys,json;[print(s["name"]) for s in json.load(sys.stdin).get("skills",[])]' \
         > "$user_skills_file"; then
      fetched_user_skills=1
      break
    fi
    [ "$attempt" -lt 2 ] && sleep 15
  done
  if [ "$fetched_user_skills" -eq 1 ]; then
    mapfile -t user_skills < "$user_skills_file"
    skills+=("${user_skills[@]}")
  else
    echo "== user-skills LIST FAILED (/api/skills 拉取 2 次均失败;本轮仅评测 baseline 平台技能,整轮非零退出)"
    fail=1
  fi
  rm -f "$user_skills_file"
fi
[ ${#skills[@]} -gt 0 ] || { echo "no skills to evaluate"; exit "$fail"; }

for name in "${skills[@]}"; do
  # 取 evals 必须区分"确认无 evals"与"取数失败"(容器冷启动的代理瞬态 5xx 曾把
  # web-context 静默跳过):失败重试,重试耗尽计 fail 而不是当作无用例跳过。
  evals=""
  for attempt in 1 2 3; do
    evals=$(curl -sf "${auth[@]}" "$V5_BASE/api/skills/$name/evals") && break
    evals=""
    refresh_auth || true
    [ "$attempt" -lt 3 ] && sleep 15
  done
  if [ -z "$evals" ]; then
    echo "== eval $name: FETCH FAILED (evals GET 3 次均失败,非'无 evals')"
    append_result_stub "$name" "" "fetch_failed"
    fail=1
    continue
  fi
  # parse 也要 fail-closed:只有"确认无 evals"(合法 JSON 且 cases==0)才允许跳过;取到了
  # 响应但解析不出(非法 JSON / 结构异常)不能静默当 0 用例漏评。python 成功输出数字,
  # 异常捕获后输出哨兵 PARSE_ERR;python 本身跑不起来(退出非零)也经 `|| cases=...` 归为哨兵。
  cases=$(printf '%s' "$evals" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print(len((d.get("evals") or {}).get("cases", [])))
except Exception:
    print("PARSE_ERR")
' 2>/dev/null) || cases="PARSE_ERR"
  if [ "$cases" = "PARSE_ERR" ]; then
    echo "== eval $name: PARSE FAILED (evals 响应非合法 JSON/结构异常,非'无 evals')"
    append_result_stub "$name" "" "parse_failed"
    fail=1
    continue
  fi
  [ "$cases" -eq 0 ] && continue
  echo "== eval $name ($cases cases) =="
  runId=""
  for attempt in 1 2; do
    if runId=$(curl -sf -X POST "${auth[@]}" -H 'Content-Type: application/json' \
      "$V5_BASE/api/skills/$name/eval-run" -d '{"mode":"baseline"}' |
      python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])'); then
      break
    fi
    runId=""
    refresh_auth || true
  done
  if [ -z "$runId" ]; then
    echo "  start failed"
    append_result_stub "$name" "" "start_failed"
    fail=1
    continue
  fi
  final_status=""
  run=""
  for _ in $(seq 1 "$MAX_POLLS"); do
    sleep 10
    if ! run=$(curl -sf "${auth[@]}" "$V5_BASE/api/skill-eval/$runId"); then
      echo "  POLL FAILED (HTTP/鉴权失败,刷新登录态后继续等待)"
      refresh_auth || true
      continue
    fi
    if ! st=$(printf '%s' "$run" |
      python3 -c 'import sys,json;r=json.load(sys.stdin)["run"];print(r["status"], "|", (r.get("benchmark") or {}).get("verdict",""))'); then
      echo "  POLL PARSE FAILED (瞬态响应异常,继续等待)"
      continue
    fi
    status="${st%% |*}"
    case "$status" in
      done)
        echo "  $st"
        if ! benchmark_complete "$run"; then
          echo "  INCOMPLETE BENCHMARK (without/with 两臂通过率不完整)"
          fail=1
        fi
        echo "$st" | grep -q "反而更差" && { echo "  REGRESSION"; fail=1; }
        final_status=done
        break
        ;;
      failed) echo "  FAILED: $st"; fail=1; final_status=failed; break ;;
    esac
  done
  [ -n "$final_status" ] || { echo "  TIMEOUT ($((MAX_POLLS * 10))s 未终态)"; fail=1; final_status=timeout; }
  if [ -n "${OC_EVAL_RESULTS_FILE:-}" ]; then
    if [ "$final_status" != "timeout" ] && [ -n "$run" ] && printf '%s' "$run" |
      python3 -c 'import sys,json;r=json.load(sys.stdin)["run"];print(json.dumps({"skill":sys.argv[1],"runId":r.get("runId"),"status":r.get("status"),"benchmark":r.get("benchmark")},ensure_ascii=False))' "$name" \
      >> "$OC_EVAL_RESULTS_FILE"; then
      :
    else
      append_result_stub "$name" "$runId" "$final_status"
    fi
  fi
done
exit $fail
