#!/bin/bash
python3 -c "
import json
c = json.load(open('/root/.openclaude/openclaude.json'))
print(c.get('gateway',{}).get('accessToken',''))
"
