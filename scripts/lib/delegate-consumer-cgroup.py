#!/usr/bin/env python3
"""Read-only cgroup-v2 subtree emptiness evidence, NOT a writer barrier.

Callers must stop original provisioning/writers and retain the original deploy
lock/phase. A missing or replaced group is unknown; parent exit is not emptiness.
No kill, freeze, stop, restart or filesystem mutation is performed here.
"""
import os
from pathlib import Path
import stat

ROOT = Path('/sys/fs/cgroup')


class Unknown(Exception):
    pass


def require(value):
    if not value: raise Unknown('unverifiable_cgroup')


def _bounded(path):
    with open(path, 'r', encoding='ascii') as f: data = f.read(65537)
    require(len(data) <= 65536)
    return data


def _mount():
    rows = [row.split() for row in _bounded('/proc/self/mountinfo').splitlines()]
    found = [row for row in rows if len(row) > 6 and row[4] == str(ROOT)]
    require(len(found) == 1)
    row = found[0]; split = row.index('-')
    require(row[split + 1] == 'cgroup2')
    dev = ROOT.stat().st_dev
    require(row[2] == f'{os.major(dev)}:{os.minor(dev)}')
    return dev


def _identity(cgroup):
    require(isinstance(cgroup, str) and '\x00' not in cgroup)
    path = Path(cgroup)
    require(path.is_absolute() and str(path) == cgroup and '..' not in path.parts and path != Path('/'))
    dev = _mount(); at = ROOT; identity = []
    for part in path.parts[1:]:
        at /= part; item = at.lstat()
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == 0 and not item.st_mode & 0o022)
        require(item.st_dev == dev)
        identity.append([item.st_dev, item.st_ino])
    return at, identity


def capture_cgroup(cgroup):
    try:
        require(os.geteuid() == 0)
        path, identity = _identity(cgroup)
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            item = os.fstat(fd)
            require([item.st_dev, item.st_ino] == identity[-1])
            event_fd = os.open('cgroup.events', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try:
                raw = os.read(event_fd, 4097)
                require(len(raw) <= 4096)
            finally:
                os.close(event_fd)
            values = {}
            for line in raw.decode('ascii').splitlines():
                key, value = line.split()
                require(key not in values)
                values[key] = value
            require(values.get('populated') in ('0', '1'))
            require(_identity(cgroup)[1] == identity)
            return {'cgroup': cgroup, 'identity': identity, 'populated': values['populated'] == '1'}
        finally:
            os.close(fd)
    except (OSError, UnicodeError, ValueError, TypeError, IndexError):
        raise Unknown('unverifiable_cgroup') from None


def verify_quiescent(proof):
    try:
        current = capture_cgroup(proof['cgroup'])
        require(current['identity'] == proof['identity'] and not current['populated'])
        return current
    except (TypeError, KeyError):
        raise Unknown('unverifiable_cgroup') from None
