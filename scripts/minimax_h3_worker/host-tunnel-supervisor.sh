#!/bin/bash
set -euo pipefail

session_pid=
tunnel_pid=
cleanup() {
  set +e
  for pid in "$session_pid" "$tunnel_pid"; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -TERM -- "-$pid" 2>/dev/null
  done
  for pid in "$session_pid" "$tunnel_pid"; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] && wait "$pid" 2>/dev/null
  done
}
trap cleanup EXIT
trap 'exit 0' TERM INT HUP

setsid /bin/bash -c '
  set -o pipefail
  while printf "lease\n"; do sleep 5; done |
  exec /usr/bin/ssh -F /dev/null -T \
    -o BatchMode=yes -o IdentitiesOnly=yes \
    -o PreferredAuthentications=publickey \
    -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o ConnectTimeout=15 \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=/etc/openclaude/h3-worker-known_hosts \
    -o GlobalKnownHostsFile=/dev/null -o LogLevel=ERROR \
    -i /etc/openclaude/h3-worker-tunnel_ed25519 -p 10170 \
    h3tunnel@ssh.zzai.scnet.cn
' &
session_pid=$!

setsid /usr/bin/ssh -F /dev/null -N -T \
  -o BatchMode=yes -o IdentitiesOnly=yes \
  -o PreferredAuthentications=publickey \
  -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o ConnectTimeout=15 \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/etc/openclaude/h3-worker-known_hosts \
  -o GlobalKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -i /etc/openclaude/h3-worker-tunnel_ed25519 -p 10170 \
  -L 127.0.0.1:18390:127.0.0.1:8390 \
  h3tunnel@ssh.zzai.scnet.cn </dev/null &
tunnel_pid=$!

wait -n "$session_pid" "$tunnel_pid"
exit 1
