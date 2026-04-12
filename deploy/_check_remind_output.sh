#!/bin/bash
echo "=== remind output content ==="
cat /root/.openclaude/cron/outputs/remind-mnue6clc-h35r-*.md

echo
echo "=== the cron job definition ==="
python3 -c "
import yaml
with open('/root/.openclaude/cron.yaml') as f:
    cfg = yaml.safe_load(f)
for j in cfg.get('jobs', []):
    if 'remind' in j['id']:
        import json
        print(json.dumps(j, indent=2, ensure_ascii=False))
"

echo
echo "=== lastActiveChannel state (from log) ==="
grep -i 'lastActive\|deliver\|broadcast' /var/log/openclaude.log | tail -5
