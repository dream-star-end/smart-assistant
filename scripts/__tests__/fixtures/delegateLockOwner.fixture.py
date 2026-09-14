"""Explicit root/private original deploy lock function + real Linux fdinfo.
Harness provides frozen module + exact original extracted lock functions in
OC206_FROZEN_LOCK_SOURCE / OC206_DEPLOY_LOCK_FUNCTIONS (base64). No real deploy.
"""
import base64
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile

assert os.geteuid() == 0
m = {}; exec(compile(base64.b64decode(OC206_FROZEN_LOCK_SOURCE), '<frozen-lock-owner>', 'exec'), m)
root = Path(tempfile.mkdtemp(prefix='oc-206-startguard-test-owner-', dir='/run'))
lock = root / 'deploy.lock'
functions = base64.b64decode(OC206_DEPLOY_LOCK_FUNCTIONS).decode()
script = '''set -euo pipefail
log() { :; }
die() { echo "$*" >&2; exit 1; }
SELFHOST_DEPLOY_LOCK_DIR="$1"
SELFHOST_DEPLOY_LOCK="$1/deploy.lock"
SELFHOST_DEPLOY_LOCK_WAIT=0
SELFHOST_DEPLOY_LOCK_POLL=1
''' + functions + '''
sleep 0.2
acquire_selfhost_deploy_lock
exec 7<>"$SELFHOST_DEPLOY_LOCK"
printf 'ready\\n'
while read -r action; do
  case "$action" in
    shared) flock -u 8; flock -s 8; printf 'shared\\n' ;;
    exclusive) flock -u 8; flock -x 8; printf 'exclusive\\n' ;;
    finish) exit 0 ;;
  esac
done
'''
child = None
out = {'accepted': 0, 'denied': 0, 'recordMatchesOwner': False, 'cleanupComplete': False}
error = None


def line():
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        assert selector.select(5), 'private holder readiness timeout'
        return child.stdout.readline().strip()


def deny(fn):
    try: fn()
    except m['Unknown']:
        out['denied'] += 1; return
    raise AssertionError('unowned or stale deploy lock accepted')


try:
    child = subprocess.Popen(['/bin/bash', '-c', script, 'private-deploy', str(root)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(root)})
    assert line() == 'ready'
    record = dict(part.split('=', 1) for part in Path(str(lock) + '.holder').read_text().split() if '=' in part)
    out['recordMatchesOwner'] = int(record['pid']) == child.pid and int(record['starttime']) == m['_process'](child.pid)
    assert out['recordMatchesOwner'], 'holder starttime must identify original bash, not its Python helper'
    proof = m['capture_holder'](str(lock), child.pid)
    assert m['verify_holder'](proof); out['accepted'] += 1
    deny(lambda: m['capture_holder'](str(lock), child.pid, 7))  # Same inode, different open description.
    deny(lambda: m['verify_holder']({**proof, 'starttime': proof['starttime'] + 1}))
    deny(lambda: m['verify_holder']({**proof, 'bootId': '00000000-0000-0000-0000-000000000000'}))
    child.stdin.write('shared\n'); child.stdin.flush(); assert line() == 'shared'
    deny(lambda: m['verify_holder'](proof))
    child.stdin.write('exclusive\n'); child.stdin.flush(); assert line() == 'exclusive'
    assert m['verify_holder'](proof); out['accepted'] += 1
    lock.rename(root / 'old.lock'); lock.touch(mode=0o600)
    deny(lambda: m['verify_holder'](proof))
    child.kill(); child.wait(timeout=5)
    deny(lambda: m['capture_holder'](str(root / 'old.lock'), child.pid))
except BaseException as exc:
    error = type(exc).__name__; out['failure'] = error
finally:
    if child is not None:
        if child.poll() is None: child.kill()
        child.wait(timeout=5)
        for pipe in (child.stdin, child.stdout, child.stderr): pipe.close()
    shutil.rmtree(root)
    out['cleanupComplete'] = not root.exists() and (child is None or child.returncode is not None)
print(json.dumps(out))
raise SystemExit(0 if error is None and out['accepted'] == 2 and out['denied'] == 6 and out['cleanupComplete'] else 1)
