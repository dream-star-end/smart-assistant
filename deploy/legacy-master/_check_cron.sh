#!/bin/bash
echo "=== cron.yaml jobs ==="
cat /root/.openclaude/cron.yaml | grep -E 'id:|schedule:|enabled:|deliver:|oneshot:' | head -30

echo
echo "=== cron outputs (recent) ==="
ls -lt /root/.openclaude/cron/outputs/ 2>/dev/null | head -10

echo
echo "=== last-run.json ==="
cat /root/.openclaude/cron/last-run.json 2>/dev/null | python3 -c "
import sys,json,time
d = json.load(sys.stdin)
for k,v in d.items():
    ts = v * 60  # minute key → seconds
    age = (time.time() - ts) / 3600
    print(f'  {k}: last ran {age:.1f}h ago (minute_key={v})')
" 2>/dev/null || echo "(no last-run data)"

echo
echo "=== app log cron entries ==="
grep -i 'cron' /var/log/openclaude.log | tail -15

echo
echo "=== current time on server ==="
date '+%Y-%m-%d %H:%M:%S %Z'
TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S CST'

echo
echo "=== remind jobs (user-created) ==="
python3 -c "
import yaml
with open('/root/.openclaude/cron.yaml') as f:
    cfg = yaml.safe_load(f)
for j in cfg.get('jobs', []):
    if j.get('oneshot') or j['id'].startswith('remind'):
        print(f'  {j[\"id\"]}: schedule={j[\"schedule\"]} enabled={j.get(\"enabled\",True)} oneshot={j.get(\"oneshot\",False)} label={j.get(\"label\",\"\")}')
" 2>/dev/null
