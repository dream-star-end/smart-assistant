#!/usr/bin/env bash
# V5 candidate regression gate. The live matrix and identity are intentionally immutable:
#   Codex = gpt-5.6-luna; CCB = deepseek-v4-flash; account = v5-evals.
# The ordinary billable v5-canary smoke remains scripts/v5-smoke-turn-canary.mjs.
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '\033[36m[e2e]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[e2e] ERROR:\033[0m %s\n' "$*" >&2; exit 2; }
free_port() {
  node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p))})"
}

command -v node >/dev/null || die "缺少 node"
command -v psql >/dev/null || die "缺少 psql（candidate gate 不允许跳过 direct timeline）"
command -v openssl >/dev/null || die "缺少 openssl"
[ -d node_modules/@playwright/test ] || die "playwright 未安装:先 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install"
[ -z "${OC_E2E_MODEL:-}" ] || die "OC_E2E_MODEL 已废止；模型矩阵不可覆盖"

export OC_E2E_EMAIL="v5-evals@claudeai.chat"
export OC_E2E_REQUIRE_DIRECT_TIMELINE=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export CI=1

PIDS=()
cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

SSH_HOST="${OC_E2E_SSH_HOST:-kl-mirror}"
PW_HOST="${OC_E2E_PW_HOST:-kl-mirror}"

if [ -n "${OC_E2E_BASE_URL:-}" ]; then
  log "直达目标:${OC_E2E_BASE_URL}"
else
  REMOTE_PORT="${OC_E2E_REMOTE_PORT:-18795}"
  LOCAL_PORT="$(free_port)"
  log "建 HTTP 隧道 127.0.0.1:${LOCAL_PORT} → ${SSH_HOST}:127.0.0.1:${REMOTE_PORT}"
  ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -o ConnectTimeout=10 \
    -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" "$SSH_HOST" &
  PIDS+=("$!")
  export OC_E2E_BASE_URL="http://127.0.0.1:${LOCAL_PORT}"
fi

for i in $(seq 1 40); do
  if curl -sf -m 3 "${OC_E2E_BASE_URL}/api/public/config" >/dev/null 2>&1; then break; fi
  [ "$i" = 40 ] && die "目标就绪超时:${OC_E2E_BASE_URL}"
  sleep 0.5
done

if [ -z "${OC_E2E_PASSWORD:-}" ]; then
  if [ -n "${OC_E2E_PASSWORD_FILE:-}" ] && [ -f "$OC_E2E_PASSWORD_FILE" ]; then
    OC_E2E_PASSWORD="$(tr -d '\n' < "$OC_E2E_PASSWORD_FILE")"
  else
    PW_FILE="${OC_E2E_EVALS_PW_FILE:-/root/.secrets/v5-evals.password}"
    log "经 ssh ${PW_HOST} 读 v5-evals 密码单一权威"
    OC_E2E_PASSWORD="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$PW_HOST" "cat '$PW_FILE'" | tr -d '\n')" \
      || die "无法读取 ${PW_FILE}"
  fi
fi
[ -n "${OC_E2E_PASSWORD:-}" ] || die "OC_E2E_PASSWORD 为空"
export OC_E2E_PASSWORD OC_E2E_BASE_URL

if [ -z "${OC_E2E_PG_URL:-}" ]; then
  V5_ENV="${OC_E2E_REMOTE_ENV:-/etc/openclaude/commercial-v5.env}"
  DB_URL="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$PW_HOST" \
    "set -a; . '$V5_ENV'; printf '%s' \"\$DATABASE_URL\"")" || die "无法读取远端 DATABASE_URL"
  [ -n "$DB_URL" ] || die "远端 DATABASE_URL 为空"
  read -r DB_HOST DB_PORT < <(DB_URL="$DB_URL" node -e '
    const u=new URL(process.env.DB_URL); process.stdout.write(`${u.hostname} ${u.port||5432}`)
  ')
  PG_LOCAL_PORT="$(free_port)"
  log "建 PG 隧道 127.0.0.1:${PG_LOCAL_PORT} → ${PW_HOST}:${DB_HOST}:${DB_PORT}"
  ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -o ConnectTimeout=10 \
    -L "${PG_LOCAL_PORT}:${DB_HOST}:${DB_PORT}" "$PW_HOST" &
  PIDS+=("$!")
  export OC_E2E_PG_URL="$(DB_URL="$DB_URL" PG_LOCAL_PORT="$PG_LOCAL_PORT" node -e '
    const u=new URL(process.env.DB_URL); u.hostname="127.0.0.1"; u.port=process.env.PG_LOCAL_PORT;
    process.stdout.write(u.toString())
  ')"
fi

for i in $(seq 1 40); do
  if psql "$OC_E2E_PG_URL" -X -tAc 'SELECT 1' >/dev/null 2>&1; then break; fi
  [ "$i" = 40 ] && die "PG 隧道/连接就绪超时"
  sleep 0.5
done

if [ -z "${OC_E2E_SESSION_PREFIX:-}" ]; then
  export OC_E2E_SESSION_PREFIX="e2e-$(openssl rand -hex 12)-"
fi
[[ "$OC_E2E_SESSION_PREFIX" =~ ^e2e-[a-z0-9]+-$ ]] || die "OC_E2E_SESSION_PREFIX 非法"

MATRIX=(gpt-5.6-luna deepseek-v4-flash)
for model in "${MATRIX[@]}"; do
  export OC_E2E_MATRIX_MODEL="$model"
  key="${model//[^a-zA-Z0-9_-]/_}"
  rm -rf "reports/$key" "test-results/$key"
  log "运行固定矩阵模型=$model 目标=$OC_E2E_BASE_URL 身份=$OC_E2E_EMAIL"
  if ! ./node_modules/.bin/playwright test "$@"; then
    log "模型 $model 失败；立即停止矩阵，让 deploy-v5 在同一 mutation lease 内官方 abort"
    exit 1
  fi
  RESULTS_FILE="reports/$key/results.json" node -e '
    const r=require("./"+process.env.RESULTS_FILE); let pass=0,fail=0,skip=0,flaky=0;
    const walk=s=>{(s.suites||[]).forEach(walk);(s.specs||[]).forEach(sp=>sp.tests.forEach(t=>{
      if(t.status==="skipped")skip++; else if(t.status==="expected")pass++; else if(t.status==="flaky")flaky++; else fail++;
    }))}; (r.suites||[]).forEach(walk);
    console.log(`[e2e] ${process.env.RESULTS_FILE}: PASS=${pass} FAIL=${fail} SKIP=${skip} FLAKY=${flaky}`);
    if(fail||skip||flaky) process.exit(1);
  ' || die "$model 报告包含 FAIL/SKIP/FLAKY"
done

log "固定双模型矩阵全部通过（Luna/Codex + DeepSeek V4 Flash/CCB）"
