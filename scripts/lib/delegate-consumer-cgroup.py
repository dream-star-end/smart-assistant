#!/usr/bin/env python3
"""Read-only cgroup-v2 subtree emptiness evidence, NOT a writer barrier.

Callers must stop original provisioning/writers and retain the original deploy
lock/phase. A missing or replaced group is unknown; parent exit is not emptiness.
No kill, freeze, stop, restart or filesystem mutation is performed here.
"""
import os
import errno
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


class PinnedCgroup:
    """A live kernel handle retained across a caller's actual stop operation.

    NOT a serialized empty-group assertion or authorization. On cgroup2,
    removal kills the kernfs node only after the group is unpopulated; a
    previously opened cgroup.events then returns ENODEV. A missing pathname
    alone, nlink, MainPID=0 or an unrecognized read error proves nothing.
    """
    def __init__(self, cgroup):
        require(os.geteuid() == 0)
        self.cgroup = cgroup
        self.path, self.identity = _identity(cgroup)
        self.fd = self.events = -1
        try:
            self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            info = os.fstat(self.fd)
            require([info.st_dev, info.st_ino] == self.identity[-1])
            self.events = os.open('cgroup.events', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.fd)
            self.event_identity = (os.fstat(self.events).st_dev, os.fstat(self.events).st_ino)
            self._read_events()  # Must be a LIVE readable cgroup at pin time.
            require(_identity(cgroup)[1] == self.identity)
        except BaseException:
            self.close()
            raise

    def close(self):
        for key in ('events', 'fd'):
            value = getattr(self, key, -1)
            if value >= 0:
                os.close(value)
                setattr(self, key, -1)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _read_events(self):
        require(self.fd >= 0 and self.events >= 0)
        info = os.fstat(self.events)
        require((info.st_dev, info.st_ino) == self.event_identity)
        os.lseek(self.events, 0, os.SEEK_SET)
        raw = os.read(self.events, 4097)
        require(len(raw) <= 4096)
        values = {}
        for line in raw.decode('ascii').splitlines():
            key, value = line.split()
            require(key not in values)
            values[key] = value
        require(values.get('populated') in ('0', '1'))
        return values['populated'] == '1'

    def verify_stopped(self):
        try:
            info = os.fstat(self.fd)
            require([info.st_dev, info.st_ino] == self.identity[-1] and _mount() == info.st_dev)
            try:
                populated = self._read_events()
            except OSError as exc:
                require(exc.errno == errno.ENODEV)
                # Only the exact last node may have disappeared; replaced
                # ancestors/pathnames cannot inherit this dead kernel handle.
                parent = str(Path(self.cgroup).parent)
                require(parent != '/' and _identity(parent)[1] == self.identity[:-1])
                try:
                    self.path.lstat()
                except FileNotFoundError:
                    pass
                else:
                    raise Unknown('cgroup_path_reused_after_stop')
                return {'cgroup': self.cgroup, 'identity': self.identity,
                        'kind': 'removed_after_live_pin'}
            require(not populated and _identity(self.cgroup)[1] == self.identity)
            return {'cgroup': self.cgroup, 'identity': self.identity, 'kind': 'retained_empty'}
        except (OSError, UnicodeError, ValueError, TypeError, IndexError):
            raise Unknown('unverifiable_stopped_cgroup') from None
