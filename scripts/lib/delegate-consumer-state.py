#!/usr/bin/env python3
"""Persistent consumer fields of the original selfhost survivor transition.

The original deploy FD8 is the sole mutation owner. This is NOT a start permit,
compatibility oracle, second lease, or recovery executor. The /run state remains
a legacy projection; once enrolled, this release-side record is authoritative.
Every enrolled write needs the live original holder AND its inherited locked
open description. A fresh process may read an interrupted record without making
it safe to resume. The caller must rebuild inventory/quiescence before recovery.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

spec = importlib.util.spec_from_file_location('consumer_lock_owner', Path(__file__).with_name('delegate-consumer-lock-owner.py'))
lock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lock)

MAX_BYTES = 32768
BASE_KEYS = {'phase', 'executor_pid', 'backup_dir', 'armed_at'}
V1_KEYS = BASE_KEYS | {'consumer_version', 'consumer_epoch', 'consumer_phase', 'consumer_owner', 'consumer_revision'}
KEYS = V1_KEYS | {'consumer_intent'}


class Unknown(Exception):
    pass


def require(value):
    if not value:
        raise Unknown('unverifiable_consumer_transition')


def _identity(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_nlink, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def _directory(path):
    """Walk physical root-owned parents using pinned directory FDs, no links."""
    p = Path(path)
    require(os.geteuid() == 0 and p.is_absolute() and str(p) == path and '..' not in p.parts)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in p.parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = nxt
            info = os.fstat(fd)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _parent(path):
    p = Path(path)
    require(p.is_absolute() and str(p) == path and p.name not in {'', '.', '..'} and '..' not in p.parts)
    return _directory(str(p.parent)), p.name


def _same_parent(path, fd):
    second, _ = _parent(path)
    try:
        a, b = os.fstat(fd), os.fstat(second)
        require((a.st_dev, a.st_ino) == (b.st_dev, b.st_ino))
    finally:
        os.close(second)


def _read_at(fd, name, optional=False):
    try:
        file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        if optional:
            return None
        raise
    try:
        before = os.fstat(file)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1 and not before.st_mode & 0o022)
        require(before.st_size <= MAX_BYTES)
        raw = os.read(file, MAX_BYTES + 1)
        require(len(raw) <= MAX_BYTES and _identity(before) == _identity(os.fstat(file)))
        require(_identity(before) == _identity(os.stat(name, dir_fd=fd, follow_symlinks=False)))
        return raw
    finally:
        os.close(file)


def _decode(raw, enrolled):
    require(raw and len(raw) <= MAX_BYTES)
    values = {}
    for line in raw.decode('utf-8').splitlines():
        key, sep, value = line.partition('=')
        require(sep and key not in values and key in (KEYS if enrolled else BASE_KEYS) and value and '\x00' not in value)
        values[key] = value
    if enrolled:
        version = values.get('consumer_version')
        require(version in {'1', '2'})
        require(set(values) == (V1_KEYS if version == '1' else KEYS))
    else:
        require(set(values) == BASE_KEYS)
    require(re.fullmatch(r'[a-z0-9-]{1,64}', values['phase']))
    require(re.fullmatch(r'[1-9][0-9]{0,12}', values['executor_pid']))
    require(Path(values['backup_dir']).is_absolute())
    if enrolled:
        require(re.fullmatch(r'[0-9a-f]{32}', values['consumer_epoch']))
        # This layer cannot assert start-authorized/committed on the strength of
        # phase text. Those require the forthcoming actual caller proof.
        require(values['consumer_phase'] in {'quiescing', 'manual'})
        require(re.fullmatch(r'0|[1-9][0-9]{0,12}', values['consumer_revision']))
        owner = json.loads(values['consumer_owner'])
        require(isinstance(owner, dict) and owner.get('pid') == int(values['executor_pid']))
        if values['consumer_version'] == '2':
            _validate_intent(json.loads(values['consumer_intent']))
    return values


def _encode(values):
    raw = ''.join(f'{key}={value}\n' for key, value in values.items()).encode('utf-8')
    _decode(raw, True)
    return raw


def _owner(proof):
    lock.verify_holder(proof)
    # A random root child with a caller-supplied PID is not the deploy writer.
    # Only the inherited FD8's kernel FLOCK WRITE proves this command belongs
    # to the live holder's open-file-description. No HELD environment bypass.
    ours = lock.capture_holder(proof['lockPath'], os.getpid(), proof['fd'])
    require(ours['identity'] == proof['identity'] and ours['bootId'] == proof['bootId'])


def _replace(path, fd, name, expected, values, proof):
    raw = _encode(values)
    tmp = '.' + name + '.tmp.' + uuid.uuid4().hex
    file = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=fd)
    try:
        try:
            offset = 0
            while offset < len(raw):
                count = os.write(file, raw[offset:])
                require(count > 0)
                offset += count
            os.fsync(file)
        finally:
            os.close(file)
        _owner(proof)
        _same_parent(path, fd)
        require(_read_at(fd, name, optional=True) == expected)
        os.replace(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
        _same_parent(path, fd)
        require(_read_at(fd, name) == raw)
    finally:
        try:
            os.unlink(tmp, dir_fd=fd)
        except FileNotFoundError:
            pass


def read(path):
    fd, name = _parent(path)
    try:
        result = _decode(_read_at(fd, name), True)
        _same_parent(path, fd)
        return result
    finally:
        os.close(fd)


def _validate_intent(intent):
    require(isinstance(intent, dict) and set(intent) == {'schema', 'sha256', 'descriptor'})
    require(type(intent['schema']) is int and intent['schema'] == 1)
    descriptor = intent['descriptor']
    require(isinstance(descriptor, dict) and set(descriptor) == {'current', 'candidate', 'required'})
    require(type(descriptor['required']) is int and descriptor['required'] in {1, 2})
    for key in ('current', 'candidate'):
        value = descriptor[key]
        require(isinstance(value, dict) and set(value) == {'master', 'runtime', 'tuple', 'unit', 'database'})
        require(all(isinstance(value[k], dict) for k in ('master', 'runtime', 'tuple', 'unit')))
        require(isinstance(value['database'], str) and Path(value['database']).is_absolute())
    raw = json.dumps(descriptor, sort_keys=True, separators=(',', ':')).encode()
    require(len(raw) <= 16384 and hashlib.sha256(raw).hexdigest() == intent['sha256'])


def begin(path, legacy, lock_path, pid, *, intent=None):
    """Enroll the original armed transition, denying starts until real proof.

    Existing durable records are never erased/re-enrolled by --arm. A future
    takeover/commit caller must reconcile them under the same real deploy lock.
    """
    require(path != legacy)
    proof = lock.capture_holder(lock_path, pid, 8)
    _owner(proof)
    oldfd, oldname = _parent(legacy)
    try:
        values = _decode(_read_at(oldfd, oldname), False)
        _same_parent(legacy, oldfd)
    finally:
        os.close(oldfd)
    require(values['phase'] == 'armed' and int(values['executor_pid']) == pid)
    values.update(consumer_version='1', consumer_epoch=uuid.uuid4().hex,
                  consumer_phase='quiescing', consumer_owner=json.dumps(proof, separators=(',', ':')),
                  consumer_revision='0')
    if intent is not None:
        # Intent binds the verified selected sources/tuple, NOT permission to
        # stop/start/commit. Only the in-process trusted caller supplies this;
        # the legacy CLI has no JSON/--verified bypass for it.
        _validate_intent(intent)
        values['consumer_version'] = '2'
        values['consumer_intent'] = json.dumps(intent, sort_keys=True, separators=(',', ':'))
    fd, name = _parent(path)
    try:
        require(_read_at(fd, name, optional=True) is None)
        _replace(path, fd, name, None, values, proof)
    finally:
        os.close(fd)
    return values


def update_phase(path, phase):
    require(re.fullmatch(r'[a-z0-9-]{1,64}', phase))
    fd, name = _parent(path)
    try:
        old = _read_at(fd, name)
        values = _decode(old, True)
        proof = json.loads(values['consumer_owner'])
        _owner(proof)
        # Preserve every consumer binding; updating an ordinary phase cannot
        # turn compatibility unknown into authorization or durable commitment.
        require(phase != 'committed')
        values['phase'] = phase
        values['consumer_revision'] = str(int(values['consumer_revision']) + 1)
        _replace(path, fd, name, old, values, proof)
        return values
    finally:
        os.close(fd)


def mark_manual(path):
    """Persist uncertain stop progress; never convert it into a start permit."""
    fd, name = _parent(path)
    try:
        old = _read_at(fd, name)
        values = _decode(old, True)
        proof = json.loads(values['consumer_owner'])
        _owner(proof)
        values['consumer_phase'] = 'manual'
        values['phase'] = 'consumer-stop-failed'
        values['consumer_revision'] = str(int(values['consumer_revision']) + 1)
        _replace(path, fd, name, old, values, proof)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['begin', 'phase', 'read'])
    parser.add_argument('--state', required=True)
    parser.add_argument('--legacy')
    parser.add_argument('--lock')
    parser.add_argument('--pid', type=int)
    parser.add_argument('--phase')
    parser.add_argument('--key', choices=sorted(KEYS))
    args = parser.parse_args()
    try:
        if args.command == 'begin':
            require(args.legacy and args.lock and args.pid)
            value = begin(args.state, args.legacy, args.lock, args.pid)
        elif args.command == 'phase':
            require(args.phase)
            value = update_phase(args.state, args.phase)
        else:
            value = read(args.state)
        if args.key:
            print(value[args.key])
    except (Unknown, lock.Unknown, OSError, ValueError, TypeError, KeyError, UnicodeError):
        print('consumer transition unknown; no mutation/start permission', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
