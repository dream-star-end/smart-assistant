#!/usr/bin/env python3
"""One fixed bootstrap key, called only by the personal release publisher.

No credentials, env contents, arbitrary keys or commands cross this CLI.
Code/runtime rollback does not remove this key or any account/audit data.
"""
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys
import tempfile

ENV = Path('/etc/openclaude/commercial-v5-selfhost.env')
LOCK = Path('/run/openclaude-v5-selfhost/deploy.lock')
RELEASES = Path('/opt/openclaude/openclaude-v5-selfhost-releases')
POLICY = Path('deploy/v5-selfhost/cc5-bootstrap.json')
ADMIN = 'OC_SELFHOST_CC5_T1555U_ADMIN_CREATE_ENABLED'
MODEL = 'OC_SELFHOST_CC5_T1555U_ENABLED'
UID = 'OC_SELFHOST_CC5_T1555U_TEST_UID'


class Refused(Exception):
    """Only fixed, non-secret diagnostic strings may be used here."""


class OutcomeUncertain(Exception):
    """A rename was attempted; a failed acknowledgement is not no-effect proof."""


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def policy_enabled(release, source):
    require(re.fullmatch(r'[0-9a-f]{40}', source) is not None, 'invalid source identity')
    marker = json.loads((release / '.complete').read_text(), object_pairs_hook=unique_object)
    require(isinstance(marker, dict) and marker.get('sourceCommit') == source,
            'candidate source identity differs')
    policy = json.loads((release / POLICY).read_text(), object_pairs_hook=unique_object)
    require(isinstance(policy, dict) and set(policy) == {'adminCreateEnabled'}
            and type(policy['adminCreateEnabled']) is bool, 'invalid bootstrap policy')
    return policy['adminCreateEnabled']


def secure_path(path, owner=0, private=False):
    """Reject symlinks and writable ancestors, without opening env contents."""
    require(path.is_absolute() and '..' not in path.parts, 'invalid fixed path')
    for current in reversed([path, *path.parents]):
        info = current.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid in ({owner} if current == path else {0, owner}),
                'unexpected file identity')
        require(info.st_mode & 0o022 == 0, 'unsafe file permissions')
        if current != path:
            require(stat.S_ISDIR(info.st_mode), 'unexpected ancestor type')
    info = path.lstat()
    if private:
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_nlink == 1, 'unsafe private file')
    return info


def process_identity(pid, proc=Path('/proc')):
    raw = (proc / str(pid) / 'stat').read_text()
    tail = raw[raw.rfind(')') + 2:].split()
    return int(tail[1]), int(tail[19])


def lock_owned(caller, lock=LOCK, proc=Path('/proc'), owner=0):
    """Observe an already held lock; never acquire or reclaim one."""
    require(caller > 1, 'invalid publisher identity')
    lock_info = secure_path(lock, owner, private=True)
    secure_path(Path(str(lock) + '.holder'), owner, private=True)
    holder = Path(str(lock) + '.holder').read_text()
    pids = re.findall(r'(?:^|\s)pid=([0-9]+)(?=\s|$)', holder)
    ticks = re.findall(r'(?:^|\s)starttime=([0-9]+)(?=\s|$)', holder)
    require(len(pids) == len(ticks) == 1, 'invalid lock holder metadata')
    holder_pid, holder_ticks = int(pids[0]), int(ticks[0])
    chain = {}
    pid = os.getpid()
    for _ in range(128):
        if pid <= 1 or pid in chain:
            break
        parent, start = process_identity(pid, proc)
        chain[pid] = start
        pid = parent
    require(caller in chain and holder_pid in chain and chain[holder_pid] == holder_ticks,
            'lock holder is not the current publisher chain')
    # The holder must be caller itself or an ancestor, not an unrelated child.
    pid = caller
    for _ in range(128):
        if pid == holder_pid:
            break
        require(pid > 1, 'holder is not publisher ancestor')
        pid = process_identity(pid, proc)[0]
    else:
        raise Refused('publisher ancestry exceeded')
    identity = (lock_info.st_dev, lock_info.st_ino)
    own = os.fstat(8)
    require((own.st_dev, own.st_ino) == identity, 'inherited lock descriptor differs')
    for pid in {caller, holder_pid}:
        descriptor = proc / str(pid) / 'fd' / '8'
        info = descriptor.stat()
        require((info.st_dev, info.st_ino) == identity, 'publisher lock inode differs')
        fdinfo = (proc / str(pid) / 'fdinfo' / '8').read_text()
        require(re.search(r'^lock:\s+.*\bFLOCK\s+ADVISORY\s+WRITE\s+', fdinfo, re.M)
                is not None, 'publisher does not hold an exclusive flock')


def patch_bytes(data):
    """Conservative single-line format; ambiguous systemd syntax fails closed."""
    text = data.decode('utf-8')
    require('\x00' not in text and '\r' not in text, 'unsupported env format')
    values = {}
    for line in text.split('\n'):
        stripped = line.strip(' \t')
        require('\\' not in line, 'env continuation or escape requires separate review')
        if not stripped or stripped[0] in '#;':
            continue
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)', stripped)
        require(match is not None, 'unsupported env assignment')
        key, value = match.groups()
        value = value.strip(' \t')
        if value and value[0] in '\"\'':
            quote = value[0]
            require(len(value) >= 2 and value[-1] == quote and value.count(quote) == 2,
                    'env multiline or compound quotes require separate review')
            value = value[1:-1]
        if key in (ADMIN, MODEL, UID):
            require(key not in values, 'duplicate task env key')
            values[key] = value
    require(UID not in values, 'test identity must remain absent')
    require(values.get(MODEL, '') in ('', '0', 'false'), 'remote model must remain off')
    if ADMIN in values:
        require(values[ADMIN] == '1', 'existing admin setting conflicts')
        return data
    separator = b'' if not data or data.endswith(b'\n') else b'\n'
    return data + separator + (ADMIN + '=1\n').encode()


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def apply_file(path, guard, owner=0):
    """Internal fixtureable writer. The production CLI always uses fixed ENV."""
    guard()
    original = secure_path(path, owner, private=True)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(file_identity(os.fstat(fd)) == file_identity(original), 'env identity changed')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read()
        require(file_identity(os.fstat(fd)) == file_identity(original), 'env changed while reading')
    finally:
        os.close(fd)
    updated = patch_bytes(data)
    if updated == data:
        return 'already-enabled'
    temp_fd, temporary = tempfile.mkstemp(prefix='.cc5-bootstrap-', dir=path.parent)
    attempted = False
    try:
        os.fchmod(temp_fd, 0o600)
        with os.fdopen(temp_fd, 'wb') as stream:
            temp_fd = None  # the stream owns and closes it before rename
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        guard()
        require(file_identity(path.lstat()) == file_identity(original), 'env changed before replace')
        attempted = True
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return 'enabled'
    except OSError as error:
        if attempted:
            raise OutcomeUncertain() from error
        raise Refused('env write failed before replacement') from error
    finally:
        if temp_fd is not None:
            os.close(temp_fd)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main():
    require(len(sys.argv) == 4, 'expected candidate, source and publisher PID')
    release, source, caller_text = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    require(caller_text.isdecimal(), 'invalid publisher PID')
    if not policy_enabled(release, source):
        print('CC5_BOOTSTRAP disabled')
        return
    require(socket.gethostname() == 'v3-dev-sg' and os.geteuid() == 0,
            'bootstrap is restricted to the personal publisher host')
    require(release.parent == RELEASES and re.fullmatch(r'rel-[A-Za-z0-9-]+', release.name),
            'unexpected personal candidate root')
    for path in (release, release / '.complete', release / POLICY, Path(__file__)):
        secure_path(path)
    require(Path(__file__).absolute() == release / 'scripts/lib/v5-selfhost-cc5-bootstrap.py',
            'helper is not from the candidate release')
    caller = int(caller_text)
    result = apply_file(ENV, lambda: lock_owned(caller))
    print('CC5_BOOTSTRAP ' + result)


if __name__ == '__main__':
    try:
        main()
    except OutcomeUncertain:
        print('CC5_BOOTSTRAP outcome uncertain after replacement attempt; inspect official state', file=sys.stderr)
        sys.exit(2)
    except (Refused, OSError, ValueError, TypeError, KeyError):
        # Do not render exception values: IO/JSON errors can quote env contents.
        print('CC5_BOOTSTRAP refused; fixed policy, identity, lock or env precondition failed', file=sys.stderr)
        sys.exit(1)
