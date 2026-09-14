"""Opt-in real PID1/root files, NO consumer start or production unit mutation.
Harness prepends base64 OC206_FROZEN_UNIT_SOURCE from the exact checkout.
Only randomly named private unit/drop-in files are created. No network/model.
"""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

assert os.geteuid() == 0
m = {}; exec(compile(base64.b64decode(OC206_FROZEN_UNIT_SOURCE), '<frozen-effective-unit>', 'exec'), m)
root = Path(tempfile.mkdtemp(prefix='oc-206-startguard-test-effective-', dir='/run'))
name = 'oc-206-startguard-test-' + uuid.uuid4().hex + '.service'
unit = Path('/run/systemd/system') / name
timer_name = name.removesuffix('.service') + '.timer'
timer = Path('/run/systemd/system') / timer_name
drop = Path(str(unit) + '.d')
out = {'accepted': 0, 'denied': 0, 'consumerStarts': 0, 'cleanupComplete': False}
error = None


def ctl(*args):
    r = subprocess.run(['/usr/bin/systemctl', '--system', *args], capture_output=True, text=True, timeout=15)
    assert r.returncode == 0, 'private systemctl command failed'
    return r.stdout


def capture(): return m['_capture_effective_unit'](name, time.monotonic() + 8)


def deny():
    try: capture()
    except m['Unknown']:
        out['denied'] += 1
        return
    raise AssertionError('unverified loaded unit accepted')


try:
    env = root / 'base.env'; env.write_text('OPENCLAUDE_HOME=' + str(root / 'file-home') + '\n')
    unit.write_text('[Unit]\nConditionPathExists=' + str(root / 'never-start') + '\n[Service]\nUser=root\nWorkingDirectory=' + str(root) + '\nEnvironmentFile=' + str(env) + '\nEnvironment=OPENCLAUDE_HOME=' + str(root / 'inline-home') + '\nExecStart=/usr/bin/npx tsx packages/cli/src/index.ts gateway\n')
    drop.mkdir()
    final = drop / '20-paths.conf'
    final.write_text('[Service]\nEnvironment=OPENCLAUDE_DELEGATE_JOBS_DB=' + str(root / 'from-dropin.db') + '\n')
    # Keep the service loaded without starting its consumer. An unreferenced
    # inactive unit can be garbage-collected and reloaded from disk by show.
    # Even an interrupted test cannot start the consumer: its condition stays false.
    timer.write_text('[Unit]\nDescription=private effective-unit reference\n[Timer]\nOnActiveSec=1h\nUnit=' + name + '\n')
    ctl('daemon-reload')
    ctl('start', timer_name)
    first = capture()
    assert first['projection']['database'] == str(root / 'from-dropin.db')
    assert first['unitPlan']['environmentFiles'] == [{'path': str(env), 'optional': False}]
    assert len(first['inputs']) == 3
    out['accepted'] += 1
    # The real manager retains its old inline environment until daemon-reload.
    final.write_text('[Service]\nEnvironment=OPENCLAUDE_DELEGATE_JOBS_DB=' + str(root / 'changed.db') + '\n')
    deny()
    ctl('daemon-reload')
    assert capture()['projection']['database'] == str(root / 'changed.db')
    out['accepted'] += 1
    # Change actual loaded config between the two real systemctl reads.
    original = m['_show_effective']; calls = 0
    def raced(*args):
        global calls
        calls += 1
        if calls == 2:
            final.write_text('[Service]\nEnvironment=OPENCLAUDE_DELEGATE_JOBS_DB=' + str(root / 'raced.db') + '\n')
            ctl('daemon-reload')
        return original(*args)
    m['_show_effective'] = raced
    deny()
    m['_show_effective'] = original
    final.write_text('[Service]\nExecStart=\nExecStart=/bin/true\n')
    ctl('daemon-reload'); deny()
    assert ctl('show', name, '--property=MainPID', '--value').strip() == '0'
except BaseException as exc:
    error = type(exc).__name__; out['failure'] = error
finally:
    try:
        ctl('stop', timer_name)
        ctl('stop', name)
        shutil.rmtree(drop, ignore_errors=True); unit.unlink(missing_ok=True); timer.unlink(missing_ok=True)
        ctl('daemon-reload')
        assert ctl('show', name, '--property=LoadState', '--value').strip() == 'not-found'
        assert ctl('show', timer_name, '--property=LoadState', '--value').strip() == 'not-found'
        shutil.rmtree(root)
        out['cleanupComplete'] = not root.exists() and not unit.exists() and not drop.exists() and not timer.exists()
    except BaseException as exc:
        out['cleanupFailure'] = type(exc).__name__
print(json.dumps(out))
raise SystemExit(0 if error is None and out['accepted'] == 2 and out['denied'] == 3 and out['cleanupComplete'] else 1)
