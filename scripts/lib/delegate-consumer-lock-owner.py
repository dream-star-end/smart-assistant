#!/usr/bin/env python3
"""Read-only proof of the original root deploy holder's *open description* lock.

No acquisition, unlock, TTL, state writes or alternate lease. The caller must
bind this proof to its original transition/unit/target; it is not a start permit.
Do not trust HELD env flags or the helper PID printed by kernel FLOCK records.
"""
import os
from pathlib import Path
import re
import stat


class Unknown(Exception):
    pass


def require(value):
    if not value: raise Unknown('unverifiable_deploy_holder')


def _kernel_text(path):
    with open(path, 'r', encoding='utf-8') as stream: text = stream.read(65537)
    require(len(text) <= 65536)
    return text


def _process(pid):
    require(type(pid) is int and pid > 1)
    root = Path('/proc') / str(pid)
    status = _kernel_text(root / 'status')
    require(re.search(r'^Uid:\s+0\s+0\s+0\s+0\s*$', status, re.M))
    value = _kernel_text(root / 'stat')
    require(value.startswith(str(pid) + ' (') and ')' in value)
    fields = value[value.rfind(')') + 2:].split()
    require(len(fields) > 19 and fields[0] not in {'Z', 'X', 'x'})
    require(fields[19].isdigit())
    return int(fields[19])


def _lock_identity(value):
    require(isinstance(value, str) and '\x00' not in value)
    p = Path(value)
    require(p.is_absolute() and str(p) == value and '..' not in p.parts and p != Path('/'))
    current, ancestors = Path('/'), []
    for index, part in enumerate(p.parts[1:]):
        current /= part; info = current.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022)
        last = index == len(p.parts) - 2
        require(stat.S_ISREG(info.st_mode) if last else stat.S_ISDIR(info.st_mode))
        if last: require(info.st_nlink == 1)
        ancestors.append([info.st_dev, info.st_ino, info.st_mode])
    return ancestors


def capture_holder(lock_path, pid, fd=8):
    """Root-only exact pid/fd proof. Shared locks and other opens do not count."""
    try:
        require(os.geteuid() == 0 and type(fd) is int and 0 <= fd <= 65535)
        boot = _kernel_text('/proc/sys/kernel/random/boot_id').strip()
        require(re.fullmatch(r'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', boot))
        started = _process(pid)
        identity = _lock_identity(lock_path)
        file = os.stat(f'/proc/{pid}/fd/{fd}')  # Kernel fd symlink, never user path inference.
        require(stat.S_ISREG(file.st_mode) and [file.st_dev, file.st_ino, file.st_mode] == identity[-1])
        info = _kernel_text(f'/proc/{pid}/fdinfo/{fd}')
        locks = [line for line in info.splitlines() if line.startswith('lock:')]
        require(len(locks) == 1)
        match = re.fullmatch(r'lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+-?\d+\s+([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+)\s+0\s+EOF', locks[0])
        require(match is not None)
        require((int(match[1], 16), int(match[2], 16), int(match[3])) ==
                (os.major(file.st_dev), os.minor(file.st_dev), file.st_ino))
        # The FLOCK PID can be the already-exited util-linux helper. The lock
        # on this exact parent fdinfo identifies the shared open description.
        require(_process(pid) == started and _lock_identity(lock_path) == identity)
        return {'pid': pid, 'fd': fd, 'starttime': started, 'bootId': boot,
                'lockPath': lock_path, 'identity': identity}
    except (OSError, ValueError, TypeError, IndexError, UnicodeError):
        raise Unknown('unverifiable_deploy_holder') from None


def verify_holder(proof):
    try:
        require(isinstance(proof, dict))
        require(capture_holder(proof['lockPath'], proof['pid'], proof['fd']) == proof)
        return True
    except (KeyError, TypeError):
        raise Unknown('unverifiable_deploy_holder') from None
