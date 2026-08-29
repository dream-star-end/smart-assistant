#!/usr/bin/env bash
# Keep the systemd-less SCNet worker alive through a leased SSH session.
set -euo pipefail

: "${H3_WORKER_SSH_HOST:?H3_WORKER_SSH_HOST is required}"
: "${H3_WORKER_SSH_PORT:?H3_WORKER_SSH_PORT is required}"
: "${H3_WORKER_SSH_IDENTITY:?H3_WORKER_SSH_IDENTITY is required}"
: "${H3_WORKER_SSH_KNOWN_HOSTS:?H3_WORKER_SSH_KNOWN_HOSTS is required}"
: "${H3_REMOTE_WORKER_RELEASE:?H3_REMOTE_WORKER_RELEASE is required}"
: "${H3_REMOTE_ENGINE_RELEASE:?H3_REMOTE_ENGINE_RELEASE is required}"
: "${H3_REMOTE_MODEL_ROOT:?H3_REMOTE_MODEL_ROOT is required}"
heartbeat_seconds=${H3_WORKER_HEARTBEAT_SECONDS:-5}

[[ "$H3_WORKER_SSH_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "invalid SSH host" >&2; exit 2; }
[[ "$H3_WORKER_SSH_PORT" =~ ^[0-9]+$ ]] || { echo "invalid SSH port" >&2; exit 2; }
[[ "$H3_REMOTE_WORKER_RELEASE" =~ ^/opt/openclaude-h3-worker/releases/[0-9a-f]{40}$ ]] || {
  echo "worker release must be an exact immutable path" >&2
  exit 2
}
[[ "$H3_REMOTE_ENGINE_RELEASE" =~ ^/opt/openclaude-h3-engine/releases/[0-9a-f]{64}$ ]] || {
  echo "engine release must be an exact immutable path" >&2
  exit 2
}
[[ "$H3_REMOTE_MODEL_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "invalid model root" >&2; exit 2; }
[[ "$heartbeat_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "invalid heartbeat interval" >&2; exit 2; }
[[ -f "$H3_WORKER_SSH_IDENTITY" && -f "$H3_WORKER_SSH_KNOWN_HOSTS" ]] || {
  echo "SSH identity or known-hosts file is missing" >&2
  exit 1
}

printf -v release_q '%q' "$H3_REMOTE_WORKER_RELEASE"
printf -v engine_q '%q' "$H3_REMOTE_ENGINE_RELEASE"
printf -v model_q '%q' "$H3_REMOTE_MODEL_ROOT"
remote_command="set -a; . /root/.secrets/openclaude-h3-worker.env; set +a; exec env H3_WORKER_RELEASE=$release_q H3_SP_WORKTREE=$engine_q H3_SP_MODEL_ROOT=$model_q /root/minimax-h3-runtime/venv/bin/python $release_q/scripts/minimax_h3_worker/session_supervisor.py"

while :; do
  printf 'lease\n'
  sleep "$heartbeat_seconds"
done | exec ssh -T \
  -p "$H3_WORKER_SSH_PORT" \
  -i "$H3_WORKER_SSH_IDENTITY" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$H3_WORKER_SSH_KNOWN_HOSTS" \
  -o ServerAliveInterval=5 \
  -o ServerAliveCountMax=2 \
  "root@$H3_WORKER_SSH_HOST" "$remote_command"
