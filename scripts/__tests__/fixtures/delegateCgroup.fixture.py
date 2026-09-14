"""Opt-in real private systemd subtree/SQLite writer; no production services.
Harness prepends OC206_FROZEN_CGROUP_SOURCE from exact checkout. Writer is a
Python/SQLite fixture, not a platform CLI or schema12 consumer proof.
"""
import base64
import json
import os
from pathlib import Path
import select
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import time
import uuid

assert os.geteuid() == 0
m = {}; exec(compile(base64.b64decode(OC206_FROZEN_CGROUP_SOURCE), '<frozen-cgroup-reader>', 'exec'), m)
root = Path(tempfile.mkdtemp(prefix='oc-206-startguard-test-cgroup-', dir='/run'))
name = 'oc-206-startguard-test-' + uuid.uuid4().hex + '.service'
leaf = None; empty = None; child_pid = None; pid_fd = None
out = {'parentExited': False, 'lateDatabaseWritten': False, 'busyRejected': False,
       'emptyAccepted': False, 'missingRejected': False, 'replacedRejected': False, 'cleanupComplete': False}
error = None


def ctl(*args, check=True):
    r = subprocess.run(['/usr/bin/systemctl', '--system', *args], capture_output=True, text=True, timeout=10)
    if check: assert r.returncode == 0, 'private systemctl operation failed'
    return r.stdout.strip()


def waitfor(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate(): return
        time.sleep(0.03)
    raise AssertionError('private cgroup condition timed out')


try:
    worker = root / 'writer.py'
    worker.write_text('''import os,pathlib,sqlite3,sys,time
r=pathlib.Path(sys.argv[1])
pid=os.fork()
if pid:
 (r/'child.pid').write_text(str(pid))
 while not (r/'parent-exit').exists(): time.sleep(0.02)
 os._exit(0)
while True:
 if (r/'write-db').exists() and not (r/'wrote-db').exists():
  db=sqlite3.connect(str(r/'late.db'));db.execute('create table proof(value integer)');db.execute('insert into proof values(1)');db.commit();db.close();(r/'wrote-db').write_text('yes')
 time.sleep(0.02)
''')
    r = subprocess.run(['/usr/bin/systemd-run', '--quiet', '--unit=' + name,
        '--property=User=root', '--property=Type=simple', '--property=KillMode=process',
        '--property=RemainAfterExit=yes', '/usr/bin/python3', str(worker), str(root)],
        capture_output=True, text=True, timeout=10)
    assert r.returncode == 0
    waitfor(lambda: (root / 'child.pid').exists())
    child_pid = int((root / 'child.pid').read_text())
    pid_fd = os.pidfd_open(child_pid)
    cgroup = ctl('show', name, '--property=ControlGroup', '--value')
    assert cgroup.startswith('/system.slice/oc-206-startguard-test-')
    group = Path('/sys/fs/cgroup') / cgroup.lstrip('/')
    leaf = group / 'private-child'; leaf.mkdir()
    (leaf / 'cgroup.procs').write_text(str(child_pid))
    initial = m['capture_cgroup'](cgroup)
    assert initial['populated'] is True
    (root / 'parent-exit').touch()
    waitfor(lambda: ctl('show', name, '--property=MainPID', '--value') == '0')
    assert not (group / 'cgroup.procs').read_text().strip()
    out['parentExited'] = True
    (root / 'write-db').touch()
    waitfor(lambda: (root / 'wrote-db').exists())
    with sqlite3.connect('file:' + str(root / 'late.db') + '?mode=ro', uri=True) as db:
        assert db.execute('select value from proof').fetchone() == (1,)
    out['lateDatabaseWritten'] = True
    try: m['verify_quiescent'](initial)
    except m['Unknown']: out['busyRejected'] = True
    assert out['busyRejected'], 'parent exit cannot authorize while a child subtree still writes'
    # An explicitly retained private empty group proves the positive reader,
    # not that a stopped systemd group must remain allocated forever.
    empty = Path('/sys/fs/cgroup') / ('oc-206-startguard-test-empty-' + uuid.uuid4().hex)
    empty.mkdir()
    empty_proof = m['capture_cgroup']('/' + empty.name)
    assert not empty_proof['populated']
    assert not m['verify_quiescent'](empty_proof)['populated']
    out['emptyAccepted'] = True
    empty.rmdir()
    try: m['verify_quiescent'](empty_proof)
    except m['Unknown']: out['missingRejected'] = True
    assert out['missingRejected'], 'missing group is not a proven empty group'
    empty.mkdir()
    try: m['verify_quiescent'](empty_proof)
    except m['Unknown']: out['replacedRejected'] = True
    assert out['replacedRejected'], 'a new group cannot reuse old identity evidence'
except BaseException as exc:
    error = type(exc).__name__; out['failure'] = error
finally:
    try:
        # Kill the whole private subtree (not just the already-exited parent).
        ctl('kill', '--kill-whom=all', '--signal=SIGKILL', name, check=False)
        if pid_fd is not None:
            # Exact process handle remains safe even if a PID is subsequently reused.
            try: signal.pidfd_send_signal(pid_fd, signal.SIGKILL)
            except ProcessLookupError: pass
        ctl('stop', name, check=False)
        if leaf is not None and leaf.exists(): leaf.rmdir()
        if empty is not None and empty.exists(): empty.rmdir()
        ctl('reset-failed', name, check=False)
        if pid_fd is not None:
            assert select.select([pid_fd], [], [], 5)[0], 'private writer still alive'
            os.close(pid_fd); pid_fd = None
        shutil.rmtree(root)
        out['cleanupComplete'] = not root.exists() and (leaf is None or not leaf.exists()) and (empty is None or not empty.exists())
    except BaseException as exc:
        out['cleanupFailure'] = type(exc).__name__
print(json.dumps(out))
raise SystemExit(0 if error is None and all(out.values()) else 1)
