#!/bin/bash
# Fail-closed production proof for the private OCR worker and its owning tunnel.
set -euo pipefail

KL_HOST="${KL_HOST:-kl-mirror}"
STABILITY_SECONDS="${OC_OCR_STABILITY_SECONDS:-12}"
[[ "$STABILITY_SECONDS" =~ ^[0-9]+$ && "$STABILITY_SECONDS" -ge 1 && "$STABILITY_SECONDS" -le 60 ]] || {
  echo "OCR worker stability window must be 1..60 seconds" >&2
  exit 2
}

ssh "$KL_HOST" bash -s -- "$STABILITY_SECONDS" <<'REMOTE'
set -euo pipefail
stability_seconds=$1
unit=openclaude-v5-ocr-tunnel.service
commercial_env=/etc/openclaude/commercial-v5.env
tunnel_env=/etc/openclaude/v5-ocr-tunnel.env

[[ -r "$commercial_env" && -r "$tunnel_env" ]] || {
  echo "OCR worker environment is unavailable" >&2
  exit 1
}
set -a
source "$commercial_env"
source "$tunnel_env"
set +a
: "${OC_OCR_WORKER_URL:?}"
: "${OC_OCR_WORKER_TOKEN:?}"
: "${OC_OCR_WORKER_EXPECTED_RELEASE:?}"
: "${OC_OCR_SSH_HOST:?}"
: "${OC_OCR_SSH_PORT:?}"
: "${OC_OCR_SSH_IDENTITY:?}"
: "${OC_OCR_SSH_KNOWN_HOSTS:?}"

ssh_args=(
  -T -p "$OC_OCR_SSH_PORT" -i "$OC_OCR_SSH_IDENTITY"
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$OC_OCR_SSH_KNOWN_HOSTS"
)

assert_ready() {
  local body
  body=$(curl -fsS --max-time 5 \
    -H "Authorization: Bearer $OC_OCR_WORKER_TOKEN" \
    "$OC_OCR_WORKER_URL/ready") || {
      echo "OCR worker /ready is unavailable" >&2
      return 1
    }
  jq -e --arg release "$OC_OCR_WORKER_EXPECTED_RELEASE" \
    '.ready == true and .protocol_major == 1 and .release == $release' \
    <<<"$body" >/dev/null || {
      echo "OCR worker /ready release or protocol mismatch" >&2
      return 1
    }
}

assert_owned_supervisor() {
  local census total orphan
  census=$(ssh "${ssh_args[@]}" "root@$OC_OCR_SSH_HOST" \
    "ps -eo pid=,ppid=,pgid=,args= | awk '\$1 == \$3 && \$4 == \"/bin/bash\" && \$5 ~ /^\\/opt\\/openclaude-ocr-worker\\/(current|releases\\/[^/]+)\\/run-supervisor\\.sh\$/ && NF == 5 { total++; if (\$2 == 1) orphan++ } END { print total+0, orphan+0 }'") || {
      echo "OCR worker supervisor census failed" >&2
      return 1
    }
  read -r total orphan <<<"$census"
  [[ "$total" == 1 && "$orphan" == 0 ]] || {
    echo "OCR worker supervisor ownership invalid(total=$total orphan=$orphan)" >&2
    return 1
  }
}

systemctl is-active --quiet "$unit" || {
  echo "OCR worker tunnel is not active" >&2
  exit 1
}
before_pid=$(systemctl show "$unit" -p MainPID --value)
before_restarts=$(systemctl show "$unit" -p NRestarts --value)
[[ "$before_pid" =~ ^[1-9][0-9]*$ && "$before_restarts" =~ ^[0-9]+$ ]] || {
  echo "OCR worker tunnel identity is invalid" >&2
  exit 1
}
assert_ready
assert_owned_supervisor

sleep "$stability_seconds"

systemctl is-active --quiet "$unit" || {
  echo "OCR worker tunnel exited during smoke" >&2
  exit 1
}
after_pid=$(systemctl show "$unit" -p MainPID --value)
after_restarts=$(systemctl show "$unit" -p NRestarts --value)
[[ "$after_pid" == "$before_pid" && "$after_restarts" == "$before_restarts" ]] || {
  echo "OCR worker tunnel stability drifted during smoke" >&2
  exit 1
}
assert_ready
assert_owned_supervisor
printf 'OCR worker ready: release=%s tunnel_pid=%s restarts=%s\n' \
  "$OC_OCR_WORKER_EXPECTED_RELEASE" "$after_pid" "$after_restarts"
REMOTE
