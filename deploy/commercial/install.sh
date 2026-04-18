#!/bin/bash
# ──────────────────────────────────────────────────────────────
# OpenClaude Commercial (v2) 一次性安装脚本 —— 38.55.134.227 专用
# ──────────────────────────────────────────────────────────────
# 前置(由 deploy-to-remote.sh 或 rsync 完成):
#   1) /opt/openclaude/openclaude/ 下有完整代码 + node_modules
#   2) agent-runtime 镜像已 docker load(或通过 build.sh 本地构建)
#
# 本脚本做的事:
#   - 建 postgres role + commercial DB
#   - 创 /etc/openclaude/commercial.env + 必填密钥(若不存在才生成,保证幂等)
#   - 创 agent sandbox 目录 / 网络 / seccomp 文件
#   - 装 systemd unit + daemon-reload + enable + restart
#   - 基本 smoke test
#
# 重复跑安全:所有步骤都检查"是否已存在",不破坏已配置。
# ──────────────────────────────────────────────────────────────
set -euo pipefail

REPO=/opt/openclaude/openclaude
ENV_FILE=/etc/openclaude/commercial.env
SECCOMP_SRC="${REPO}/deploy/commercial/agent-runtime/agent_seccomp.json"
SECCOMP_DST=/etc/openclaude/agent_seccomp.json
RPC_SOCKET_DIR=/var/run/openclaude-agent-rpc
AGENT_NETWORK=agent-net
AGENT_IMAGE=openclaude/agent-runtime:latest

log() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "必须 root 运行"
[ -d "$REPO" ]     || fail "$REPO 不存在,先同步代码"
[ -d "$REPO/node_modules" ] || fail "$REPO/node_modules 不存在,先 bun install"

# ── 1. Postgres: role + DB ──
log "配置 Postgres"
PG_PASS_FILE=/etc/openclaude/.pg_commercial_pass
if [ -s "$PG_PASS_FILE" ]; then
  PG_PASS=$(cat "$PG_PASS_FILE")
  log "  复用已有 PG 密码 ($PG_PASS_FILE)"
else
  mkdir -p /etc/openclaude
  PG_PASS=$(openssl rand -hex 24)
  umask 077
  echo -n "$PG_PASS" > "$PG_PASS_FILE"
  log "  生成新 PG 密码 → $PG_PASS_FILE"
fi

# role
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='openclaude'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE openclaude LOGIN PASSWORD '${PG_PASS}'"
sudo -u postgres psql -c "ALTER ROLE openclaude WITH PASSWORD '${PG_PASS}'" >/dev/null
# db
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='openclaude_commercial'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE openclaude_commercial OWNER openclaude"
log "  DB=openclaude_commercial role=openclaude OK"

# ── 2. Redis: 确认在跑 ──
log "检查 Redis"
systemctl is-active --quiet redis-server || fail "redis-server 未运行"
redis-cli PING | grep -q PONG || fail "redis 不响应"

# ── 3. /etc/openclaude/ + secrets ──
log "写 $ENV_FILE"
mkdir -p /etc/openclaude
if [ ! -f "$ENV_FILE" ]; then
  JWT_SECRET=$(openssl rand -hex 64)
  KMS_KEY=$(openssl rand -base64 32)
  cat > "$ENV_FILE" <<EOF
# ── 自动生成 $(date -Iseconds) —— 可手动编辑 ──
COMMERCIAL_ENABLED=1
DATABASE_URL=postgresql://openclaude:${PG_PASS}@127.0.0.1:5432/openclaude_commercial
REDIS_URL=redis://127.0.0.1:6379
COMMERCIAL_JWT_SECRET=${JWT_SECRET}
OPENCLAUDE_KMS_KEY=${KMS_KEY}
COMMERCIAL_BASE_URL=https://claudeai.chat
# Turnstile: bypass 模式先开。拿到真 secret 后替换:设 TURNSTILE_SECRET=... 并删除 TURNSTILE_TEST_BYPASS。
# 注意 schema 拒绝空字符串 —— 无值时整行要么删掉要么注释掉,不能留 = 后跟空。
TURNSTILE_TEST_BYPASS=1
# 虎皮椒三件套:要么全设,要么全删(schema superRefine)。占位时先注释:
# HUPIJIAO_APP_ID=xxx
# HUPIJIAO_APP_SECRET=xxx
# HUPIJIAO_CALLBACK_URL=https://claudeai.chat/api/payment/hupi/callback
# Agent sandbox
AGENT_IMAGE=${AGENT_IMAGE}
AGENT_NETWORK=${AGENT_NETWORK}
AGENT_PROXY_URL=http://127.0.0.1:8118
AGENT_SECCOMP_PATH=${SECCOMP_DST}
AGENT_RPC_SOCKET_DIR=${RPC_SOCKET_DIR}
EOF
  chmod 600 "$ENV_FILE"
  log "  $ENV_FILE 已生成"
else
  log "  $ENV_FILE 已存在,不覆盖"
fi

# ── 4. Agent sandbox 资源 ──
log "准备 Agent sandbox 资源"
cp "$SECCOMP_SRC" "$SECCOMP_DST"
chmod 644 "$SECCOMP_DST"
mkdir -p "$RPC_SOCKET_DIR"
chmod 700 "$RPC_SOCKET_DIR"
docker network inspect "$AGENT_NETWORK" >/dev/null 2>&1 \
  || docker network create --driver bridge "$AGENT_NETWORK"
docker image inspect "$AGENT_IMAGE" >/dev/null 2>&1 \
  || warn "Docker 镜像 $AGENT_IMAGE 不存在 —— 请 docker load < agent-runtime.tar(/api/agent/* 会 503 直到镜像就绪)"

# ── 5. systemd unit ──
log "安装 systemd unit"
install -m 644 "$REPO/deploy/commercial/openclaude-commercial.service" \
               /etc/systemd/system/openclaude.service
systemctl daemon-reload
systemctl enable openclaude.service >/dev/null 2>&1 || true
systemctl restart openclaude.service

# ── 6. smoke test ──
log "等待 5 秒让服务起来,然后探针"
sleep 5
systemctl is-active --quiet openclaude.service || fail "openclaude.service 没起来,journalctl -u openclaude -n 50"
HC=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/healthz || echo '---')
MC=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/api/public/models || echo '---')
PC=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/api/payment/plans || echo '---')
echo
echo "smoke:"
echo "  /healthz            → $HC  (期望 200)"
echo "  /api/public/models  → $MC  (期望 200;若 401 说明 commercial 未挂)"
echo "  /api/payment/plans  → $PC  (期望 200;若 401 同上)"

[ "$HC" = "200" ] && [ "$MC" = "200" ] && [ "$PC" = "200" ] \
  && log "上线完毕" \
  || fail "smoke 失败,检查日志: journalctl -u openclaude -n 100"
