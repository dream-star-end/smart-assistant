#!/bin/bash
# 一键部署: 本地 commercial 仓库 → rsync 到 45.76.214.99(Vultr Tokyo)→ 重启 openclaude.service
#
# 用法: ./deploy-to-remote.sh
#
# 历史:
#   - 2026-04-18 之前: 38.55.134.227 / git pull 路径(其实跑不通,因为 38.55 出站不通,实际走 rsync)
#   - 2026-04-19: 整套迁到 Vultr Tokyo 45.76.214.99,新机器出站通,SSH 走 ed25519 key 免密。
#                改用 rsync 路径作为唯一真理,远端不再维护 git 仓库。

set -e

REMOTE_HOST="45.76.214.99"
REMOTE_USER="root"
REMOTE_REPO="/opt/openclaude/openclaude"
BRANCH="v2"
SERVICE="openclaude.service"
HEALTH_URL="http://127.0.0.1:18789/healthz"

cd "$(dirname "$0")"

# ---- 校验 ----

CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CUR_BRANCH" != "$BRANCH" ]; then
  echo "[ABORT] 当前分支是 $CUR_BRANCH, 期望 $BRANCH"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[ABORT] Working tree 有未提交改动,请先 commit 或 stash"
  git status --short
  exit 1
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10"

# ---- 本地 push (备份到 GitHub) ----

echo "=== [1/4] Push $BRANCH to origin (备份) ==="
git push origin "$BRANCH"
LOCAL_HEAD=$(git rev-parse HEAD)
echo "Local HEAD: $LOCAL_HEAD"

# ---- rsync 代码 (含 node_modules,排除 .git/dist/log) ----

echo ""
echo "=== [2/4] rsync to $REMOTE_HOST:$REMOTE_REPO/ ==="
rsync -a --delete \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='/dist' \
  --exclude='/data' \
  --exclude='.env' \
  -e "ssh $SSH_OPTS" \
  ./ "$REMOTE_USER@$REMOTE_HOST:$REMOTE_REPO/"
echo "rsync done"

# ---- 远程 restart ----

echo ""
echo "=== [3/4] Restart $SERVICE ==="
ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" bash -s <<REMOTE_SCRIPT
set -e
echo "--- restart $SERVICE ---"
systemctl restart "$SERVICE"
sleep 4
if systemctl is-active "$SERVICE" > /dev/null 2>&1; then
  echo "Service active"
else
  echo "[FAIL] Service not active"
  journalctl -u "$SERVICE" --no-pager -n 30
  exit 1
fi
REMOTE_SCRIPT

# ---- 健康检查 ----

echo ""
echo "=== [4/4] Health check ==="
HEALTH=$(ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "curl -s -m 5 $HEALTH_URL || true")
echo "Local healthz: $HEALTH"

PUBLIC=$(curl -sS -m 10 -o /dev/null -w "%{http_code}" https://claudeai.chat/healthz || echo "fail")
echo "Public https://claudeai.chat/healthz: HTTP $PUBLIC"

if [ -n "$HEALTH" ] && [ "$PUBLIC" = "200" ]; then
  echo ""
  echo "=== Deploy OK ==="
  echo "Branch:  $BRANCH @ $LOCAL_HEAD"
  echo "Remote:  $REMOTE_USER@$REMOTE_HOST:$REMOTE_REPO"
  echo "Service: $SERVICE"
else
  echo "[FAIL] Health check failed"
  exit 1
fi
