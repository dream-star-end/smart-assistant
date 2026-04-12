#!/bin/bash
echo "=== create a test remind job that fires in 1 minute ==="
TZ=Asia/Shanghai
NOW_M=$(TZ=Asia/Shanghai date '+%-M')
NOW_H=$(TZ=Asia/Shanghai date '+%-H')
# Next minute
NEXT_M=$(( (NOW_M + 1) % 60 ))
if [ $NEXT_M -eq 0 ]; then
  NEXT_H=$(( (NOW_H + 1) % 24 ))
else
  NEXT_H=$NOW_H
fi
NEXT_D=$(TZ=Asia/Shanghai date '+%-d')
NEXT_MON=$(TZ=Asia/Shanghai date '+%-m')
SCHEDULE="$NEXT_M $NEXT_H $NEXT_D $NEXT_MON *"
echo "current: $(TZ=Asia/Shanghai date '+%H:%M')"
echo "schedule: $SCHEDULE"

TOKEN=$(python3 -c "import json;c=json.load(open('/root/.openclaude/openclaude.json'));print(c.get('gateway',{}).get('accessToken',''))")
curl -sS "http://127.0.0.1:18789/api/cron" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"schedule\":\"$SCHEDULE\",\"prompt\":\"请直接输出以下提醒内容,不要添加任何额外文字:\\n\\n⏰ 提醒: 测试提醒推送\",\"deliver\":\"webchat\",\"oneshot\":true,\"label\":\"测试提醒\"}"

echo
echo "=== waiting 90 seconds for cron tick ==="
sleep 90

echo
echo "=== check logs ==="
grep -E 'remind|deliver|broadcast' /var/log/openclaude.log | tail -10

echo
echo "=== check output ==="
ls -lt /root/.openclaude/cron/outputs/ | head -3
cat /root/.openclaude/cron/outputs/remind-*-$(date -u '+%Y-%m-%d')*.md 2>/dev/null | tail -5
