#!/usr/bin/env bash
# Idempotent provisioner for the ChatGPT TLS-impersonation sidecar venv.
#
# Creates a dedicated Python venv with curl_cffi (bundles a Chrome-JA3
# libcurl-impersonate) at a stable path so the gateway can supervise the
# sidecar. Safe to re-run: skips work that is already done.
#
#   bash packages/gateway/scripts/setup-chatgpt-tls-sidecar.sh
#
# Override the venv location / pinned version via env:
#   OPENCLAUDE_CHATGPT_TLS_VENV=/opt/openclaude/chatgpt-tls/venv
#   CURL_CFFI_VERSION=0.7.4
set -euo pipefail

VENV=${OPENCLAUDE_CHATGPT_TLS_VENV:-/opt/openclaude/chatgpt-tls/venv}
CURL_CFFI_VERSION=${CURL_CFFI_VERSION:-0.7.4}

mkdir -p "$(dirname "$VENV")"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "[setup] creating venv at $VENV"
  python3 -m venv "$VENV"
fi

echo "[setup] installing curl_cffi==$CURL_CFFI_VERSION"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet "curl_cffi==$CURL_CFFI_VERSION"

"$VENV/bin/python" - <<'PY'
from curl_cffi import requests
print("[setup] curl_cffi import OK; impersonate targets include 'chrome'")
PY

echo "[setup] venv ready: $VENV/bin/python"
