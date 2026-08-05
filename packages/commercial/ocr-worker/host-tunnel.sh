#!/bin/bash
# Runs on the V5 host under systemd. Secrets/models stay in the root-owned
# remote env file; the SSH command only references its path.
set -euo pipefail
source /etc/openclaude/v5-ocr-tunnel.env
: "${OC_OCR_SSH_HOST:?}"
: "${OC_OCR_SSH_PORT:?}"
: "${OC_OCR_SSH_IDENTITY:?}"
: "${OC_OCR_SSH_KNOWN_HOSTS:?}"
: "${OC_OCR_LOCAL_PORT:=18960}"
: "${OC_OCR_REMOTE_PORT:=18960}"
exec /usr/bin/ssh \
  -T \
  -p "$OC_OCR_SSH_PORT" \
  -i "$OC_OCR_SSH_IDENTITY" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$OC_OCR_SSH_KNOWN_HOSTS" \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -L "127.0.0.1:${OC_OCR_LOCAL_PORT}:127.0.0.1:${OC_OCR_REMOTE_PORT}" \
  "root@${OC_OCR_SSH_HOST}" \
  "/bin/bash -lc 'set -a; source /opt/openclaude-ocr-worker/ocr-worker.env; set +a; exec /opt/openclaude-ocr-worker/current/run-supervisor.sh'"
