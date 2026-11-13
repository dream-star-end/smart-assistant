#!/usr/bin/env python3
"""Test-only native protocol process. No production model seed or credential."""
import json, os, pathlib, sys
home = pathlib.Path(os.environ['CODEX_HOME'])
if '--version' in sys.argv:
    print('codex-cli 0.167.0'); sys.exit(0)
(home / 'fixture.pid').write_text(str(os.getpid()))
fixture = json.loads((home / 'fixture.json').read_text())
for line in sys.stdin:
    m = json.loads(line)
    if 'id' not in m:
        continue
    method = m['method']
    if method == 'initialize':
        result = {'userAgent': 'fixture/0.167.0'}
    elif method == 'account/read':
        result = {'account': fixture.get('account', {'type': 'chatgpt', 'email': home.name+'@example.test', 'planType': 'pro'})}
    elif method == 'model/list':
        cursor = m.get('params', {}).get('cursor')
        page = fixture['pages'][int(cursor or 0)]
        result = page
    else:
        print(json.dumps({'id': m['id'], 'error': {'code': -32601, 'message': 'not allowed'}}), flush=True); continue
    print(json.dumps({'id': m['id'], 'result': result}), flush=True)
