#!/bin/bash
python3 << 'PYEOF'
import json
with open('/root/.openclaude/openclaude.json') as f:
    c = json.load(f)
c['defaults']['permissionMode'] = 'acceptEdits'
with open('/root/.openclaude/openclaude.json', 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('defaults.permissionMode =', c['defaults']['permissionMode'])
PYEOF
