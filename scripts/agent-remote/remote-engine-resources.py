#!/usr/bin/env python3
"""Node resource admission, shared by cc/codex/probes; never owns login credentials.

A claim reserves the hard maxima of ALL its scopes until stop is proven. A fixed node budget bounds every admitted hard maximum; MemAvailable is only an additional
current-pressure gate, never combined with differently timed scope residency readings. One short node
lock prevents simultaneous startups spending the same physical memory; logical pools are separate.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

MIB = 1024 * 1024
MEMORY_ERROR = 'REMOTE_NODE_MEMORY_EXHAUSTED'


def need(ok):
    if not ok: raise RuntimeError('REMOTE_RESOURCE_STATE_UNKNOWN')


def settings():
    path = Path('/etc/openclaude/remote-engine-resources.json')
    if not path.exists(): return {}
    st = path.lstat()
    need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1 and not st.st_mode & 0o022)
    return json.loads(path.read_text())


def option(name, default):
    return os.environ.get('OC_REMOTE_' + name, settings().get(name, default))


def config(engine):
    need(engine in ('cc', 'codex'))
    prefix = engine.upper() + '_'
    values = {'slice': str(option(prefix + 'SLICE', 'oc-' + engine + '.slice')),
              'max': int(option(prefix + 'MEMORY_MAX', 1536 * MIB)),
              'tasks': int(option(prefix + 'TASKS_MAX', 768)),
              'app': int(option(prefix + 'APP_MEMORY', (448 if engine == 'codex' else 640) * MIB)),
              'socket': int(option(prefix + 'SOCKET_MEMORY', 32 * MIB)),
              'headroom': int(option('HEADROOM', 192 * MIB))}
    need(re.fullmatch(r'oc-[a-z0-9-]+\.slice', values['slice']) and all(
        v > 0 for k, v in values.items() if k != 'slice'))
    return values


def run(*args):
    return subprocess.run(args, env={'PATH': '/usr/bin:/bin', 'HOME': str(Path.home()),
        'XDG_RUNTIME_DIR': '/run/user/' + str(os.getuid())}, text=True, capture_output=True, timeout=10)


def systemctl(*args): return run('/usr/bin/systemctl', '--user', *args)


def state(unit):
    r = systemctl('show', unit, '--property=LoadState,ActiveState,FragmentPath,ControlGroup,MemoryMax,MemoryCurrent,TasksMax')
    need(r.returncode == 0)
    return dict(line.split('=', 1) for line in r.stdout.splitlines() if '=' in line)


def atomic(path, value):
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(value); out.flush(); os.fsync(out.fileno())
        os.replace(tmp, path)
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(dfd)
        finally: os.close(dfd)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def directory():
    p = Path(str(option('RESOURCE_ROOT', str(Path.home() / '.oc-remote-resources'))))
    p.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = p.lstat()
    need(stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o077
         and p.resolve() == p.absolute())
    return p


@contextlib.contextmanager
def locked():
    fd = os.open(directory() / 'admission.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1 and not st.st_mode & 0o077)
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally: os.close(fd)


def boot(): return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def record_path(key): return directory() / (hashlib.sha256(key.encode()).hexdigest() + '.json')


def records():
    rows = []
    for p in directory().glob('*.json'):
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            st = os.fstat(fd)
            need(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1
                 and not st.st_mode & 0o077 and 0 < st.st_size < 16384)
            r = json.loads(os.read(fd, 16384))
        finally: os.close(fd)
        need(r.get('version') == 1 and isinstance(r.get('scopes'), dict))
        if r['boot'] == boot(): rows.append(r)
    return rows


def ensure_slice(engine):
    c = config(engine); current = state(c['slice'])
    if current.get('LoadState') == 'loaded' and (current.get('ActiveState') == 'active' or current.get('FragmentPath')):
        # Never shrink a live slice or silently accept a stale, unlimited unit.
        need(current.get('MemoryMax') == str(c['max']) and current.get('TasksMax') == str(c['tasks']))
    else:
        path = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'systemd/user' / c['slice']
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        need(not path.exists() and not path.is_symlink())
        atomic(path, '[Unit]\nDescription=OpenClaude remote '+engine+'\n[Slice]\nMemoryMax='+str(c['max'])+'\nTasksMax='+str(c['tasks'])+'\n')
        need(systemctl('daemon-reload').returncode == 0)
    need(systemctl('start', c['slice']).returncode == 0)
    current = state(c['slice'])
    need(current.get('ActiveState') == 'active' and current.get('MemoryMax') == str(c['max'])
         and current.get('TasksMax') == str(c['tasks']))
    return c


def available():
    for line in Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'): return int(line.split()[1]) * 1024
    raise RuntimeError('REMOTE_RESOURCE_STATE_UNKNOWN')


def memory_used(unit):
    s = state(unit)
    if s.get('ActiveState') in ('inactive', 'failed') and not s.get('ControlGroup'): return 0
    need(s.get('MemoryCurrent', '').isdigit())
    return int(s['MemoryCurrent'])


def snapshot(engine, scopes, rows):
    c = config(engine)
    budget = sum(scopes.values())
    total = next(int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines()
                 if line.startswith('MemTotal:'))
    # 2 GiB measured node: ~650 MiB non-engine usage; reserve at least 768 MiB for OS/sshd/control
    # and 192 MiB extra headroom. This is a static bound: a resident lane freeing/reallocating
    # memory between telemetry reads cannot manufacture new physical capacity.
    node_budget = min(int(option('NODE_MEMORY_BUDGET', max(0,total-768*MIB))),total)
    node_committed = sum(sum(r['scopes'].values()) for r in rows)
    engine_rows = [r for r in rows if r['engine'] == engine]
    engine_committed = sum(sum(r['scopes'].values()) for r in engine_rows)
    engine_tasks = sum(len(r['scopes'])*128 for r in engine_rows)
    current = memory_used(c['slice'])
    free = available()
    ok = (node_committed + budget + c['headroom'] <= node_budget
          and engine_committed + budget + c['headroom'] <= c['max']
          and current + budget + c['headroom'] <= c['max']
          and free >= budget + c['headroom'])
    tasks_ok = engine_tasks + len(scopes)*128 <= c['tasks']
    code = MEMORY_ERROR if not ok else ('REMOTE_NODE_TASKS_EXHAUSTED' if not tasks_ok else None)
    return {'memoryOk':ok and tasks_ok,'code':code,
            'activeSessions':sum(r['kind']=='lane' for r in engine_rows),
            'nodeBudgetBytes':node_budget,'committedBytes':node_committed,'newBudgetBytes':budget,
            'memAvailableBytes':free,'sliceMemoryCurrent':current}


class MemoryExhausted(RuntimeError):
    def __init__(self, status):
        super().__init__(status['code'])
        self.status = status


def admit(key, engine, profile, scopes, kind='lane'):
    need(scopes and all(re.fullmatch(r'oc-[a-z0-9-]+\.scope', u) and type(b) is int and b > 0 for u, b in scopes.items()))
    with locked():
        ensure_slice(engine)
        rows = records()
        existing = next((r for r in rows if r['key'] == key), None)
        if existing:
            need(existing['engine'] == engine and existing['profile'] == profile and existing['scopes'] == scopes)
            return existing  # Same generation's socket/app share one reservation.
        if kind == 'lane':
            cap = int(option(engine.upper() + '_PROFILE_MAX_LANES', 5))
            need(sum(r['kind'] == 'lane' and r['engine'] == engine and r['profile'] == profile for r in rows) < cap)
        status = snapshot(engine, scopes, rows)
        if not status['memoryOk']: raise MemoryExhausted(status)
        row = {'version': 1, 'key': key, 'engine': engine, 'profile': profile, 'kind': kind,
               'scopes': scopes, 'boot': boot()}
        atomic(record_path(key), json.dumps(row, sort_keys=True))
        return row


def preflight(engine):
    with locked():
        c = ensure_slice(engine)
        return snapshot(engine, {'preview-app': c['app'], 'preview-socket': c['socket']}, records())


def release(key):
    """Caller must fence late launches first; unknown scope state retains the entire claim."""
    with locked():
        row = next((r for r in records() if r['key'] == key), None)
        if not row: return
        for unit in row['scopes']:
            s = state(unit)
            need(s.get('ActiveState') in ('inactive', 'failed') and not s.get('ControlGroup'))
        record_path(key).unlink()
        fd = os.open(directory(), os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)


def stop(key):
    # Controllers fence late starts under their task lock before calling this.
    with locked():
        row = next((r for r in records() if r['key'] == key), None)
        if not row: return
        for unit in row['scopes']:
            st = state(unit)
            if st.get('ActiveState') in ('inactive','failed') and not st.get('ControlGroup'): continue
            need(systemctl('stop',unit).returncode == 0)


def attach_self(engine, unit, memory):
    """Move the controller into a bounded scope BEFORE native CLI/host exec; PID stays unchanged."""
    c = config(engine)
    r = run('/usr/bin/busctl', '--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
            'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))', unit, 'fail', '5',
            'PIDs', 'au', '1', str(os.getpid()), 'Slice', 's', c['slice'], 'MemoryMax', 't', str(memory),
            'TasksMax', 't', '128', 'KillMode', 's', 'control-group', '0')
    need(r.returncode == 0)
    s = state(unit)
    need(s.get('ActiveState') == 'active' and s.get('MemoryMax') == str(memory)
         and s.get('ControlGroup') in [line.split(':', 2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines()])
