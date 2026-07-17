#!/usr/bin/env bash
# v5-market-skill-eval.sh — 市场技能的平台实测复跑(审核者一键,agent 能力批债②首迭代)。
#
# 对**已上架(active)**的市场技能:用 canary 账号临时安装 → 跑一轮 baseline 评测
# (with/without,bundle 自带 evals)→ 打印平台实测通过率与 verdict → 若本来未安装则卸载
# 还原。用于核验发布者自报 benchmark 的可信度(详情页"发布者实测"徽章只是自报,平台
# 不背书;本脚本给审核者一个实测口径)。
#
# 边界(有意取舍,登记于 playbook 债表):
#   - 仅支持 active 上架版本 —— 安装口对 pending 版本 fail-closed(NOT_INSTALLABLE),
#     待审版本的预安装 sideload 是独立的安全面改造,不在本脚本内绕过。
#   - 实测结果仅输出到终端/退出码,不回写 DB(verified 徽章链路=后续批次)。
#
# 用法:
#   PASSWORD=$(cat /root/.secrets/v5-canary.password) \
#     scripts/v5-market-skill-eval.sh <slug>
#   退出码:0=技能有效/持平;1=有技能反而更差或运行失败;2=用法/前置错误(无 evals 等)。
set -uo pipefail

V5_BASE="${V5_BASE:-http://127.0.0.1:18790}"
EMAIL="${EMAIL:-v5-canary@claudeai.chat}"
: "${PASSWORD:?PASSWORD required}"
SLUG="${1:?usage: v5-market-skill-eval.sh <slug>}"

jqpy() { python3 -c "import sys,json;$1"; }

TOK=$(curl -sf -X POST "$V5_BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"turnstile_token\":\"x\"}" |
  jqpy 'print(json.load(sys.stdin)["access_token"])') || { echo "login failed"; exit 2; }
auth=(-H "Authorization: Bearer $TOK")

detail=$(curl -sf "${auth[@]}" "$V5_BASE/api/marketplace/$SLUG") || { echo "detail 404:$SLUG 不存在或未上架(pending 版本不支持,见脚本头注释)"; exit 2; }
versionId=$(echo "$detail" | jqpy 'print(json.load(sys.stdin)["detail"]["versionId"])')
displayName=$(echo "$detail" | jqpy 'print(json.load(sys.stdin)["detail"]["name"])')
kind=$(echo "$detail" | jqpy 'print(json.load(sys.stdin)["detail"].get("kind","skill"))')
[ "$kind" = "skill" ] || { echo "仅支持 kind=skill(当前:$kind)"; exit 2; }
# 技能技术名 = slug(发布管线钉死 frontmatter name===slug===hub 目录名);
# detail.name 是人向展示名(可为中文),不能用于 /api/skills/<name> 路径。
skillName="$SLUG"
echo "== $SLUG(《$displayName》, version=$versionId)"

was_installed=$(curl -sf "${auth[@]}" "$V5_BASE/api/marketplace/installed" |
  jqpy "print('yes' if any(i.get('slug')=='$SLUG' for i in json.load(sys.stdin).get('installed',[])) else 'no')" 2>/dev/null || echo unknown)

# 只有确知"原本已装"(was_installed=yes)才在 cleanup 里保留;no 或 unknown(探测失败)
# 且本批确实装过 → 一律卸载还原,避免探测失败时把技能泄漏留在 canary 上污染后续评测。
# installed_by_us 只在 install 成功后置 1:install 失败时 cleanup 不误删。
installed_by_us=0
cleanup() {
  if [ "$was_installed" != "yes" ] && [ "$installed_by_us" -eq 1 ]; then
    curl -sf -X DELETE "${auth[@]}" "$V5_BASE/api/marketplace/installed/$SLUG" >/dev/null 2>&1 \
      && echo "· 已卸载还原(canary 原本未安装/安装状态未知)" \
      || echo "· 卸载还原失败,请手工清理 canary 的 $SLUG"
  fi
}
trap cleanup EXIT

curl -sf -X POST "${auth[@]}" -H 'Content-Type: application/json' \
  "$V5_BASE/api/marketplace/install" -d "{\"versionId\":\"$versionId\"}" >/dev/null \
  || { echo "install 失败"; exit 2; }
installed_by_us=1
echo "· 已安装到 canary,等待 hub 同步…"

# 触发并等待容器 hub 同步:**同步触发点在技能列表读**(handleUserSkillsList →
# syncMarketplaceHubForManagement),evals GET 本身不触发 —— 每轮先打一次列表。
# evals GET 200 且非空 = 同步就位。容器冷启动最长等 ~2min。
evals=""
for _ in $(seq 1 8); do
  curl -sf "${auth[@]}" "$V5_BASE/api/skills" >/dev/null 2>&1 || true
  sleep 15
  evals=$(curl -sf "${auth[@]}" "$V5_BASE/api/skills/$skillName/evals") && {
    n=$(echo "$evals" | jqpy 'd=json.load(sys.stdin);print(len((d.get("evals") or {}).get("cases",[])))' 2>/dev/null || echo 0)
    [ "${n:-0}" -gt 0 ] && break
    evals=""
  }
done
[ -n "$evals" ] || { echo "该技能 bundle 未携带 evals(或 hub 同步未就位)—— 无法平台实测"; exit 2; }
n=$(echo "$evals" | jqpy 'd=json.load(sys.stdin);print(len((d.get("evals") or {}).get("cases",[])))')
echo "· evals 就位($n cases),启动评测"

runId=$(curl -sf -X POST "${auth[@]}" -H 'Content-Type: application/json' \
  "$V5_BASE/api/skills/$skillName/eval-run" -d '{"mode":"baseline"}' |
  jqpy 'print(json.load(sys.stdin)["runId"])') || { echo "eval-run 启动失败"; exit 1; }

for _ in $(seq 1 120); do
  sleep 10
  run=$(curl -sf "${auth[@]}" "$V5_BASE/api/skill-eval/$runId") || continue
  status=$(echo "$run" | jqpy 'print(json.load(sys.stdin)["run"]["status"])')
  case "$status" in
    done)
      RUN_JSON="$run" python3 <<'PY'
import json, os
r = json.loads(os.environ["RUN_JSON"])["run"]
b = r.get("benchmark") or {}
pr = b.get("passRate") or {}
fmt = lambda x: f"{round(x * 100)}%" if isinstance(x, (int, float)) else "-"
print(f"== 平台实测:without={fmt(pr.get('without'))} with={fmt(pr.get('with'))}")
print(f"   verdict: {b.get('verdict', '')}")
PY
      verdict=$(echo "$run" | jqpy 'r=json.load(sys.stdin)["run"];print((r.get("benchmark") or {}).get("verdict",""))')
      echo "$verdict" | grep -q "反而更差" && exit 1
      exit 0
      ;;
    failed) echo "== 评测运行失败"; exit 1 ;;
  esac
done
echo "== 超时(20min 未终态)"; exit 1
