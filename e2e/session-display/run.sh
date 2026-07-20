#!/usr/bin/env bash
# 会话展示 e2e runner:env 校验 → (可选)建 ssh 隧道 → 串行跑 → 汇总。
# 目标环境全部经 env 注入,零硬编码账号密码。
#
# 用法:
#   ./run.sh                      # 默认:隧道到 kl-hk 预发(18795),密码取自 kl-mirror
#   ./run.sh --grep @smoke        # 只跑部署门 smoke 子集(用例 1/2/4)
#   OC_E2E_SSH_HOST=kl-mirror OC_E2E_REMOTE_PORT=18790 ./run.sh   # 打生产 canary(自验用)
#   OC_E2E_BASE_URL=http://127.0.0.1:18790 ./run.sh              # 已有直达地址,不建隧道
#
# 关键 env(详见 README 环境矩阵):
#   OC_E2E_BASE_URL     直达 HTTP 根;设了就不建隧道
#   OC_E2E_SSH_HOST     隧道目标主机(默认 kl-hk)     OC_E2E_REMOTE_PORT  远端端口(默认 18795)
#   OC_E2E_PASSWORD     账号密码(优先);或 OC_E2E_PASSWORD_FILE(本地文件)
#   OC_E2E_PW_HOST      密码单一权威主机(默认 kl-mirror,经 ssh 读 v5-canary.password)
#   OC_E2E_EMAIL/MODEL/PG_URL/SECTION9 …  见 README
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '\033[36m[e2e]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[e2e] ERROR:\033[0m %s\n' "$*" >&2; exit 2; }

# ── 依赖校验 ─────────────────────────────────────────────────────────────────
command -v node >/dev/null || die "缺少 node"
[ -d node_modules/@playwright/test ] || die "playwright 未安装:先 (cd $(pwd) && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install)"

TUNNEL_PID=""
cleanup() { [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# ── 目标地址:直达 or ssh 隧道 ────────────────────────────────────────────────
if [ -n "${OC_E2E_BASE_URL:-}" ]; then
  log "直达目标:$OC_E2E_BASE_URL(不建隧道)"
else
  SSH_HOST="${OC_E2E_SSH_HOST:-kl-hk}"
  REMOTE_PORT="${OC_E2E_REMOTE_PORT:-18795}"
  LOCAL_PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p))})")"
  log "建隧道 127.0.0.1:${LOCAL_PORT} → ${SSH_HOST}:${REMOTE_PORT}"
  ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -o ConnectTimeout=10 \
    -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" "$SSH_HOST" &
  TUNNEL_PID=$!
  export OC_E2E_BASE_URL="http://127.0.0.1:${LOCAL_PORT}"
  # 隧道就绪轮询(不死 sleep):public/config 可达即就绪。
  for i in $(seq 1 40); do
    if curl -sf -m 3 "${OC_E2E_BASE_URL}/api/public/config" >/dev/null 2>&1; then break; fi
    kill -0 "$TUNNEL_PID" 2>/dev/null || die "ssh 隧道进程已退出(检查 ssh ${SSH_HOST} 是否可达)"
    [ "$i" = "40" ] && die "隧道就绪超时:${OC_E2E_BASE_URL} 不可达"
    sleep 0.5
  done
  log "隧道就绪:$OC_E2E_BASE_URL"
fi

# ── 密码:显式 > 本地文件 > ssh 读单一权威 ────────────────────────────────────
if [ -z "${OC_E2E_PASSWORD:-}" ]; then
  if [ -n "${OC_E2E_PASSWORD_FILE:-}" ] && [ -f "${OC_E2E_PASSWORD_FILE}" ]; then
    OC_E2E_PASSWORD="$(tr -d '\n' < "${OC_E2E_PASSWORD_FILE}")"
  else
    PW_HOST="${OC_E2E_PW_HOST:-kl-mirror}"
    PW_FILE="${OC_E2E_CANARY_PW_FILE:-/root/.secrets/v5-canary.password}"
    log "经 ssh ${PW_HOST} 读密码单一权威(${PW_FILE})"
    OC_E2E_PASSWORD="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$PW_HOST" "cat ${PW_FILE}" | tr -d '\n')" \
      || die "无法读取 canary 密码(ssh ${PW_HOST} ${PW_FILE})"
  fi
fi
[ -n "${OC_E2E_PASSWORD:-}" ] || die "OC_E2E_PASSWORD 为空:无法登录"
export OC_E2E_PASSWORD OC_E2E_BASE_URL

log "目标=${OC_E2E_BASE_URL}  账号=${OC_E2E_EMAIL:-v5-canary@claudeai.chat}  模型=${OC_E2E_MODEL:-gpt-5.6-sol}"
[ -n "${OC_E2E_PG_URL:-}" ] && log "direct-timeline DB 注入:已配置 OC_E2E_PG_URL" || log "direct-timeline DB 注入:未配置 → 用例 2/5 将 skip-with-reason"

# ── 串行跑(浏览器复用 ms-playwright 缓存,免下载)────────────────────────────
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
set +e
./node_modules/.bin/playwright test "$@"
RC=$?
set -e

echo
log "═══ 汇总 ═══"
if [ -f reports/results.json ]; then
  node -e '
    const r=require("./reports/results.json");
    let pass=0,fail=0,skip=0,flaky=0;
    const walk=(s)=>{(s.suites||[]).forEach(walk);(s.specs||[]).forEach(sp=>sp.tests.forEach(t=>{
      const st=t.results.at(-1)?.status; const ok=t.status;
      if(ok==="skipped")skip++; else if(ok==="expected")pass++; else if(ok==="flaky")flaky++; else fail++;
      const tag = ok==="skipped"?"SKIP":ok==="expected"?"PASS":ok==="flaky"?"FLAKY":"FAIL";
      const reason=t.results.at(-1)?.errors?.[0]?.message||t.annotations?.find(a=>a.type==="skip")?.description||"";
      console.log(`  [${tag}] ${sp.title}${reason?"  — "+String(reason).split("\n")[0].slice(0,120):""}`);
    }))};
    (r.suites||[]).forEach(walk);
    console.log(`\n  PASS=${pass} FAIL=${fail} SKIP=${skip} FLAKY=${flaky}`);
  ' 2>/dev/null || log "(无法解析 reports/results.json)"
fi
log "HTML 报告:reports/html/index.html  (npm run report 打开)"
exit $RC
