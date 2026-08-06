#!/usr/bin/env bash
set -euo pipefail

ROOT=/root/private_data/minimax-h3-v5-worker
ENV_FILE=/root/.secrets/openclaude-h3-worker.env

if [[ ! -s "$ENV_FILE" ]]; then
  echo "$ENV_FILE must define H3_WORKER_TOKEN before installing the service" >&2
  exit 1
fi
set -a
source "$ENV_FILE"
set +a
: "${H3_WORKER_TOKEN:?H3_WORKER_TOKEN is required}"

install -m 0644 "$ROOT/scripts/minimax_h3_worker/openclaude-h3-worker.service" \
  /etc/systemd/system/openclaude-h3-worker.service
systemctl daemon-reload
systemctl enable --now openclaude-h3-worker.service
systemctl is-active --quiet openclaude-h3-worker.service
curl -fsS -H "Authorization: Bearer $H3_WORKER_TOKEN" \
  http://127.0.0.1:8390/v1/health
