#!/bin/bash
echo "=== System Resources ==="
free -h | head -3
echo "load: $(cat /proc/loadavg)"
echo "uptime: $(uptime -p)"

echo
echo "=== Process Memory (Top 10) ==="
ps -eo pid,rss,vsz,%mem,cmd --sort=-rss | head -12

echo
echo "=== OpenClaude processes ==="
ps -eo pid,ppid,rss,%mem,%cpu,etime,cmd | grep -E 'bun|tsx|openclaude|node.*gateway|playwright' | grep -v grep

echo
echo "=== MCP subprocess count ==="
echo "MCP processes: $(pgrep -f 'mcp-memory|playwright|minimax' | wc -l)"
echo "CCB bun processes: $(pgrep -f 'bun.*cli.tsx' | wc -l)"

echo
echo "=== File descriptor usage ==="
for PID in $(pgrep -f 'node.*gateway' | head -1); do
  echo "Gateway (PID=$PID): $(ls /proc/$PID/fd 2>/dev/null | wc -l) fds"
done
for PID in $(pgrep -f 'bun.*cli.tsx' | head -3); do
  echo "CCB (PID=$PID): $(ls /proc/$PID/fd 2>/dev/null | wc -l) fds"
done

echo
echo "=== Disk usage ==="
du -sh /root/.openclaude/ 2>/dev/null
du -sh /root/.openclaude/sessions.db* 2>/dev/null
du -sh /root/.openclaude/uploads/ 2>/dev/null
du -sh /root/.openclaude/agents/ 2>/dev/null
du -sh /var/log/openclaude.log 2>/dev/null

echo
echo "=== Network connections ==="
ss -s | head -5
echo "WS connections to 18789: $(ss -tnp | grep 18789 | grep ESTAB | wc -l)"

echo
echo "=== SQLite WAL size ==="
ls -lh /root/.openclaude/sessions.db* 2>/dev/null

echo
echo "=== Log file growth rate ==="
wc -l /var/log/openclaude.log 2>/dev/null
ls -lh /var/log/openclaude.log 2>/dev/null

echo
echo "=== Temp files ==="
du -sh /tmp/openclaude-* 2>/dev/null | head -10
echo "tmp dirs: $(ls -d /tmp/openclaude-* 2>/dev/null | wc -l)"
