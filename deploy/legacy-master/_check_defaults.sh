#!/bin/bash
python3 -c "
import json
c = json.load(open('/root/.openclaude/openclaude.json'))
print('defaults:', json.dumps(c.get('defaults',{}), indent=2))
"
