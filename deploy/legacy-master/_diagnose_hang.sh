#!/bin/bash
echo "=== service status ==="
systemctl is-active openclaude

echo
echo "=== bun processes ==="
ps aux | grep -E 'bun.*cli|bun.*dev' | grep -v grep | head -5

echo
echo "=== process memory/cpu ==="
ps -eo pid,ppid,%mem,%cpu,etime,cmd | grep -E 'bun|tsx|openclaude' | grep -v grep | head -10

echo
echo "=== last 40 log lines ==="
tail -40 /var/log/openclaude.log

echo
echo "=== system resources ==="
free -h | head -3
df -h / | tail -1
echo "load: $(cat /proc/loadavg)"

echo
echo "=== open file descriptors (top process) ==="
PID=$(pgrep -f 'bun.*cli.tsx' | head -1)
if [ -n "$PID" ]; then
  echo "PID=$PID fd_count=$(ls /proc/$PID/fd 2>/dev/null | wc -l)"
  ls /proc/$PID/fd 2>/dev/null | wc -l
fi

echo
echo "=== ws connections ==="
ss -s | head -5
ss -tnp | grep 18789 | wc -l
echo "ws clients connected: $(ss -tnp | grep 18789 | grep ESTAB | wc -l)"
