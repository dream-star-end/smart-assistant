#!/bin/bash
# 一键部署: 本地 push v2 → 远程 38.55.134.168 pull + 重启 openclaude.service
#
# 用法: ./deploy-to-remote.sh
#
# 前置条件:
#   - 本地已通过 git 提交所有改动(脚本会检查 working tree 是否干净)
#   - 本地对 GitHub 仓库有 push 权限(SSH key 已配置)
#   - sshpass 已安装(apt-get install -y sshpass)

set -e

REMOTE_HOST="38.55.134.168"
REMOTE_USER="root"
REMOTE_PASS="auejRWHA6997"
REMOTE_REPO="/opt/openclaude/openclaude"   # v2 线上部署目录(38.55 上不变)
BRANCH="v2"
SERVICE="openclaude.service"
HEALTH_URL="http://127.0.0.1:18789/healthz"

# ---- 校验 ----

cd "$(dirname "$0")"

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

if ! command -v sshpass >/dev/null 2>&1; then
  echo "[ABORT] 缺少 sshpass, 请先: apt-get install -y sshpass"
  exit 1
fi

# ---- 本地 push ----

echo "=== [1/3] Push $BRANCH to origin ==="
git push origin "$BRANCH"
LOCAL_HEAD=$(git rev-parse HEAD)
echo "Local HEAD: $LOCAL_HEAD"

# ---- 远程部署 ----

echo ""
echo "=== [2/3] Remote deploy on $REMOTE_HOST ==="

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

sshpass -p "$REMOTE_PASS" ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" bash -s <<REMOTE_SCRIPT
set -e
cd "$REMOTE_REPO"

echo "--- Pull $BRANCH ---"
git fetch origin "$BRANCH"
BEFORE=\$(git rev-parse HEAD)
git reset --hard origin/$BRANCH
AFTER=\$(git rev-parse HEAD)

if [ "\$BEFORE" = "\$AFTER" ]; then
  echo "Already up to date: \$AFTER"
else
  echo "Updated: \$BEFORE -> \$AFTER"
  git log --oneline "\$BEFORE..\$AFTER"
fi

echo ""
echo "--- Restart $SERVICE ---"
pkill -9 -f claude-code-best 2>/dev/null || true
sleep 1
systemctl restart "$SERVICE"
sleep 3

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
echo "=== [3/3] Health check ==="
HEALTH=$(sshpass -p "$REMOTE_PASS" ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "curl -s -m 5 $HEALTH_URL || true")
echo "Health: $HEALTH"

if [ -n "$HEALTH" ]; then
  echo ""
  echo "=== Deploy OK ==="
  echo "Branch:  $BRANCH @ $LOCAL_HEAD"
  echo "Remote:  $REMOTE_USER@$REMOTE_HOST:$REMOTE_REPO"
  echo "Service: $SERVICE"
else
  echo "[FAIL] Health check empty"
  exit 1
fi
