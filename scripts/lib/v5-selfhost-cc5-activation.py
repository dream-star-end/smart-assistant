#!/usr/bin/env python3
"""Fixed selfhost CC5 two-key activation; no credentials or generic env interface.

The CLI has only production paths. Fixtureable Paths/Carrier are internal test
ports. A durable receipt precedes every env replacement; the private index is
only its locator. An unacknowledged replacement remains a hold until a genuine
publisher explicitly restores the selected keys. It never restores a whole env.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass

ENABLED = 'OC_SELFHOST_CC5_T1555U_ENABLED'
UID = 'OC_SELFHOST_CC5_T1555U_TEST_UID'
KEYS = (ENABLED, UID)
MODEL = 'box-claude-sonnet-5'
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'[0-9a-f]{64}')
TRAIN = re.compile(r'tr-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}')
SESSION = re.compile(r'agent:[A-Za-z0-9_-]{1,64}:webchat:dm:[A-Za-z0-9_-]{8,50}')
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
TERMINAL = {'committed', 'reverted'}
PHASES = {'prepared', 'attempted', 'applied', 'reverting', 'reverted', 'committed', 'unknown'}
WATCH_GUARD = b'# CC5 activation mutation guard v1'


class Refused(Exception):
    pass


class Unknown(Refused):
    pass


def require(value, reason='fixed activation precondition failed'):
    if not value:
        raise Refused(reason)


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def decode(data):
    return json.loads(data.decode('utf-8'), object_pairs_hook=unique)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def secure(path, owner, private=False, directory=False):
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts)
    for entry in reversed((path, *path.parents)):
        st = entry.lstat()
        require(not stat.S_ISLNK(st.st_mode) and st.st_uid in {0, owner})
        require(st.st_mode & 0o022 == 0, 'unsafe path permissions')
        if entry != path or directory:
            require(stat.S_ISDIR(st.st_mode))
    st = path.lstat()
    require(st.st_uid == owner)
    if directory:
        if private:
            require(stat.S_IMODE(st.st_mode) == 0o700)
    else:
        require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1)
        if private:
            require(stat.S_IMODE(st.st_mode) == 0o600)
    return st


def identity(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_nlink,
            st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def read_private(path, owner):
    original = secure(path, owner, private=True)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(identity(os.fstat(fd)) == identity(original))
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(1024 * 1024 + 1)
        require(len(data) <= 1024 * 1024 and identity(os.fstat(fd)) == identity(original))
        require(identity(Path(path).lstat()) == identity(original))
        return data, original
    finally:
        os.close(fd)


def absent(path):
    try:
        Path(path).lstat()
    except FileNotFoundError:
        # A missing parent is absence, but a symlink/damaged existing parent is
        # checked separately before any write or index lookup.
        return True
    return False


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, data, guard, owner, expected=None):
    secure(Path(path).parent, owner, directory=True)
    guard()
    fd, temporary = tempfile.mkstemp(prefix='.cc5-activation-', dir=Path(path).parent)
    attempted = False
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            fd = None
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        guard()
        if expected is not None:
            require(identity(Path(path).lstat()) == identity(expected), 'file changed before replace')
        elif not absent(path):
            secure(path, owner, private=True)
        attempted = True
        os.replace(temporary, path)
        sync_dir(Path(path).parent)
    except OSError as error:
        if attempted:
            raise Unknown('replacement acknowledgement unknown') from error
        raise
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def process_identity(pid, proc=Path('/proc')):
    text = (proc / str(pid) / 'stat').read_text()
    tail = text[text.rfind(')') + 2:].split()
    return int(tail[1]), tail[19]


def lock_owned(caller, lock, owner):
    require(caller > 1)
    st = secure(lock, owner, private=True)
    holder_data, _ = read_private(Path(str(lock) + '.holder'), owner)
    holder = holder_data.decode('utf-8')
    pids = re.findall(r'(?:^|\s)pid=([0-9]+)(?=\s|$)', holder)
    starts = re.findall(r'(?:^|\s)starttime=([0-9]+)(?=\s|$)', holder)
    require(len(pids) == len(starts) == 1)
    holder_pid, holder_start = int(pids[0]), starts[0]
    chain = {}
    pid = os.getpid()
    for _ in range(128):
        if pid <= 1 or pid in chain:
            break
        parent, started = process_identity(pid)
        chain[pid] = started
        pid = parent
    require(caller in chain and chain.get(holder_pid) == holder_start)
    pid = caller
    for _ in range(128):
        if pid == holder_pid:
            break
        require(pid > 1)
        pid = process_identity(pid)[0]
    else:
        raise Refused('publisher ancestry exceeded')
    expected = (st.st_dev, st.st_ino)
    require((os.fstat(8).st_dev, os.fstat(8).st_ino) == expected)
    for pid in {caller, holder_pid}:
        fd = Path('/proc') / str(pid) / 'fd/8'
        got = fd.stat()
        require((got.st_dev, got.st_ino) == expected)
        found = False
        for line in (Path('/proc') / str(pid) / 'fdinfo/8').read_text().splitlines():
            fields = line.split()
            if (len(fields) == 9 and fields[0] == 'lock:' and
                    fields[2:5] == ['FLOCK', 'ADVISORY', 'WRITE'] and
                    fields[6].rsplit(':', 1)[-1] == str(st.st_ino) and fields[7:] == ['0', 'EOF']):
                found = True
        require(found, 'actual publisher exclusive flock missing')
    require(process_identity(holder_pid)[1] == holder_start)


def watch_readers(watch, installed_identity):
    """Observe old Bash fd255 readers; never signal or acquire their authority."""
    require(sys.platform == 'linux' and Path('/proc').is_dir(), 'watch reader state unavailable')
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        descriptor = process / 'fd/255'
        try:
            target = os.readlink(descriptor)
            if target.removesuffix(' (deleted)') != str(watch):
                continue
            _, started = process_identity(int(process.name))
            st = descriptor.stat()
            require((st.st_dev, st.st_ino) == installed_identity, 'retired watch reader remains')
            require(process_identity(int(process.name))[1] == started, 'watch reader identity changed')
        except (FileNotFoundError, ProcessLookupError):
            continue  # Reliable absence: that reader has exited.


@dataclass(frozen=True)
class Paths:
    env: Path = Path('/etc/openclaude/commercial-v5-selfhost.env')
    request: Path = Path('/opt/openclaude/cc5-t1555u/activation-request.json')
    metadata: Path = Path('/opt/openclaude/cc5-t1555u/deployment.json')
    index: Path = Path('/opt/openclaude/cc5-t1555u/activation-index.json')
    releases: Path = Path('/opt/openclaude/openclaude-v5-selfhost-releases')
    backups: Path = Path('/opt/openclaude/v5-selfhost-breakglass/unit-backups')
    history: Path = Path('/etc/openclaude/runtime-tuple-selfhost.history')
    live: Path = Path('/opt/openclaude/openclaude-v5-selfhost-live')
    lock: Path = Path('/run/openclaude-v5-selfhost/deploy.lock')
    watch: Path = Path('/opt/openclaude/v5-selfhost-watch/watch.sh')
    library: Path = Path(__file__).absolute().parents[1] / 'v5-runtime-release-lib.sh'
    owner: int = 0


def env_lines(text):
    # EnvironmentFile assignments are separated by LF. Python splitlines also
    # splits VT/NEL/Unicode separators, which are ordinary bytes inside a value.
    parts = text.split('\n')
    return [part + '\n' for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def key_state(data):
    text = data.decode('utf-8')
    require('\x00' not in text and '\r' not in text)
    state = {key: {'present': False, 'value': None, 'line': None} for key in KEYS}
    # Conservatively refuse systemd continuation/escape syntax: it can turn an
    # apparent independent assignment into part of another logical value.
    require('\\' not in text, 'ambiguous env continuation')
    for line in env_lines(text):
        stripped = line.strip(' \t\n')
        if not stripped or stripped.startswith(('#', ';')):
            continue
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)', stripped)
        require(match is not None, 'ambiguous env assignment')
        key, value = match.groups()
        value = value.strip(' \t')
        if value.startswith(('"', "'")):
            quote = value[0]
            require(len(value) >= 2 and value[-1] == quote and value.count(quote) == 2)
            value = value[1:-1]
        else:
            require('"' not in value and "'" not in value)
        if key not in KEYS:
            continue
        require(not state[key]['present'], 'duplicate selected env key')
        state[key] = {'present': True, 'value': value, 'line': line}
    return state


def semantic(state):
    return {key: (state[key]['present'], state[key]['value']) for key in KEYS}


def patch(data, state):
    key_state(data)
    kept = []
    for line in env_lines(data.decode('utf-8')):
        match = re.match(r'^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=', line)
        if not match or match[1] not in KEYS:
            kept.append(line)
    # Prepend our assignments so an unrelated final line without LF is kept
    # byte-for-byte. Selected assignment position is not an env semantic.
    text = ''
    selected = [state[key]['line'] for key in KEYS if state[key]['present']]
    for line in selected:
        text += line if line.endswith('\n') else line + '\n'
    text += ''.join(kept)
    result = text.encode('utf-8')
    require(semantic(key_state(result)) == semantic(state))
    return result


class Carrier:
    def __init__(self, paths=Paths(), guard=None, reader_probe=None):
        self.p = paths
        self.guard_override = guard
        self.reader_probe = reader_probe or watch_readers

    def owner(self, caller):
        if self.guard_override is not None:
            self.guard_override()
        else:
            require(os.geteuid() == 0 and socket.gethostname() == 'v3-dev-sg')
            lock_owned(int(caller), self.p.lock, self.p.owner)

    def json_file(self, path):
        data, _ = read_private(path, self.p.owner)
        return decode(data), data

    def release_ref(self, rel):
        rel = Path(rel)
        require(rel.parent == self.p.releases and re.fullmatch(r'rel-[A-Za-z0-9-]+', rel.name))
        return rel

    def release(self, rel, source=None):
        rel = self.release_ref(rel)
        secure(rel, self.p.owner, directory=True)
        marker = rel / '.complete'
        secure(marker, self.p.owner)
        metadata = decode(marker.read_bytes())
        require(isinstance(metadata, dict) and isinstance(metadata.get('sourceCommit'), str) and
                SHA.fullmatch(metadata['sourceCommit']))
        if source is not None:
            require(SHA.fullmatch(source) and metadata['sourceCommit'] == source)
        return str(rel)

    def receipt_path(self, backup):
        backup = Path(backup)
        require(backup.parent == self.p.backups and re.fullmatch(r'pre-cutover-[0-9]{8}-[0-9]{6}', backup.name))
        secure(backup, self.p.owner, directory=True)
        return backup / 'cc5-activation.json'

    def validate_state(self, state):
        require(isinstance(state, dict) and set(state) == set(KEYS))
        for key in KEYS:
            entry = state[key]
            require(isinstance(entry, dict) and set(entry) == {'present', 'value', 'line'} and type(entry['present']) is bool)
            if not entry['present']:
                require(entry['value'] is None and entry['line'] is None)
            else:
                require(isinstance(entry['value'], str) and isinstance(entry['line'], str))
                parsed = key_state(entry['line'].encode())
                require(parsed[key] == entry and sum(int(parsed[k]['present']) for k in KEYS) == 1)

    def receipt(self, path):
        path = Path(path)
        require(path == self.receipt_path(path.parent))
        value, _ = self.json_file(path)
        required = {'schema', 'kind', 'train', 'source', 'candidate', 'previousMaster', 'requestSha256',
                    'metadataSha256', 'before', 'after', 'previousReceipt', 'phase', 'historyBeforeSha256', 'commit'}
        require(isinstance(value, dict) and set(value) == required and value['schema'] == 1)
        require(value['kind'] in {'activate', 'rollback'} and TRAIN.fullmatch(value['train']) and
                SHA.fullmatch(value['source']) and value['phase'] in PHASES)
        # A committed origin can outlive GC of its release tree. Its protected
        # immutable receipt remains a valid locator; new writes/finalize still
        # validate their real current candidate, source and predecessor.
        self.release_ref(value['candidate'])
        self.release_ref(value['previousMaster'])
        require(all(DIGEST.fullmatch(value[k]) for k in ('requestSha256', 'metadataSha256', 'historyBeforeSha256')))
        if value['previousReceipt'] is not None:
            previous = Path(value['previousReceipt'])
            require(previous == self.receipt_path(previous.parent) and previous != path)
        if value['phase'] == 'committed':
            commit = value['commit']
            require(isinstance(commit, dict) and set(commit) == {'seq', 'checksum', 'lineSha256'} and
                    type(commit['seq']) is int and commit['seq'] > 0 and
                    all(isinstance(commit[k], str) and DIGEST.fullmatch(commit[k]) for k in ('checksum', 'lineSha256')))
        else:
            require(value['commit'] is None)
        self.validate_state(value['before'])
        self.validate_state(value['after'])
        return value

    def indexed(self):
        if absent(self.p.index):
            # Check existing private parent before treating absence as NOOP.
            if not absent(self.p.index.parent):
                secure(self.p.index.parent, self.p.owner, private=True, directory=True)
            return None, None
        secure(self.p.index.parent, self.p.owner, private=True, directory=True)
        index, _ = self.json_file(self.p.index)
        require(isinstance(index, dict) and set(index) == {'schema', 'receipt'} and index['schema'] == 1)
        path = Path(index['receipt'])
        return path, self.receipt(path)

    def selected(self):
        data, st = read_private(self.p.env, self.p.owner)
        return key_state(data), data, st

    def effective(self, receipt):
        seen = set()
        for _ in range(32):
            if receipt is None or receipt['phase'] != 'reverted':
                return receipt
            previous = receipt['previousReceipt']
            if previous is None:
                return None
            require(previous not in seen, 'receipt cycle')
            seen.add(previous)
            receipt = self.receipt(previous)
            require(receipt['phase'] in TERMINAL)
        raise Refused('receipt ancestry exceeded')

    def same(self, state):
        return semantic(self.selected()[0]) == semantic(state)

    def save(self, path, value, caller):
        data = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
        atomic(path, data, lambda: self.owner(caller), self.p.owner)

    def opt_in(self):
        if absent(self.p.request):
            if not absent(self.p.request.parent):
                secure(self.p.request.parent, self.p.owner, private=True, directory=True)
            return None
        secure(self.p.request.parent, self.p.owner, private=True, directory=True)
        request, request_bytes = self.json_file(self.p.request)
        require(isinstance(request, dict) and request.get('schema') == 1 and type(request.get('enabled')) is bool)
        if request['enabled'] is False:
            require(set(request) == {'schema', 'enabled'})
            return None
        require(set(request) == {'schema', 'enabled', 'testUid', 'scope', 'deploymentSha256'})
        uid = request['testUid']
        require(isinstance(uid, str) and re.fullmatch(r'[1-9][0-9]{0,18}', uid) and int(uid) <= 9223372036854775807)
        scope = request['scope']
        require(isinstance(scope, dict) and set(scope) == {'canonicalModel', 'sessionKey'} and
                scope['canonicalModel'] == MODEL and isinstance(scope['sessionKey'], str) and SESSION.fullmatch(scope['sessionKey']))
        require(isinstance(request['deploymentSha256'], str) and DIGEST.fullmatch(request['deploymentSha256']))
        metadata, metadata_bytes = self.json_file(self.p.metadata)
        require(digest(metadata_bytes) == request['deploymentSha256'])
        require(isinstance(metadata, dict) and set(metadata) == {'version', 'task', 'testUid', 'user', 'taskRoot', 'profile', 'scope'} and
                metadata['version'] == 2 and metadata['task'] == 'AGENT-REMOTE-T1555U' and metadata['testUid'] == uid and metadata['scope'] == scope)
        user = metadata['user']
        require(isinstance(user, str) and re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', user) and user != 'root')
        require(isinstance(metadata['taskRoot'], str) and re.fullmatch(
            r'/home/' + re.escape(user) + r'/oc-agentremote-t1555u-[a-z0-9-]{16,40}', metadata['taskRoot']))
        profile = metadata['profile']
        require(isinstance(profile, dict) and set(profile) == {'operationId', 'runId'} and
                all(isinstance(profile[k], str) and UUID.fullmatch(profile[k]) for k in profile))
        return request, digest(request_bytes), digest(metadata_bytes)

    def history_bytes(self):
        if absent(self.p.history):
            return b''
        secure(self.p.history, self.p.owner)
        return self.p.history.read_bytes()

    def history_tail(self, receipt, before=False):
        data = self.history_bytes()
        require(data.endswith(b'\n') and bool(data.strip()), 'history tail incomplete')
        lines = data.splitlines(keepends=True)
        require(digest(b''.join(lines[:-1])) == receipt['historyBeforeSha256'] if not before else True)
        secure(self.p.library, self.p.owner)
        result = subprocess.run(['/bin/bash', '-c', 'source "$1"; oc_hotcfg__history_verify_line "$2"',
                                 'cc5-history', str(self.p.library), lines[-1].decode().rstrip('\n')],
                                env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'},
                                capture_output=True, timeout=15, check=False)
        require(result.returncode == 0, 'official history checksum rejected')
        entry = decode(result.stdout)
        require(entry['schemaVer'] == 3 and entry['transitionKind'] == 'joint' and not entry.get('preState', False))
        if not before:
            require(entry['masterRelease'] == receipt['candidate'] and entry['previousMasterRelease'] == receipt['previousMaster'])
        return entry, digest(lines[-1])

    def watch_source(self, release):
        trusted = Path(release) / 'scripts/v5-selfhost-watch.sh'
        st = secure(trusted, self.p.owner)
        fd = os.open(trusted, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            require(identity(os.fstat(fd)) == identity(st))
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                data = stream.read()
            require(identity(os.fstat(fd)) == identity(st) and identity(trusted.lstat()) == identity(st))
            return data
        finally:
            os.close(fd)

    def trusted_watch(self, kind, candidate, previous):
        # Rollback to an old unguarded release may later be inverted. Only a
        # securely read, definitely marker-less predecessor allows candidate
        # selection; a missing/unreadable/changed predecessor remains a HOLD.
        if kind == 'rollback' and WATCH_GUARD in self.watch_source(previous).split(b'\n'):
            return previous
        return candidate

    def watch_ready(self, release):
        expected = self.watch_source(release)
        require(WATCH_GUARD in expected.split(b'\n'), 'trusted watch lacks activation guard')
        st = secure(self.p.watch, self.p.owner)
        fd = os.open(self.p.watch, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            require(identity(os.fstat(fd)) == identity(st))
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                require(stream.read() == expected, 'installed watch differs from trusted release')
            require(identity(os.fstat(fd)) == identity(st) and identity(self.p.watch.lstat()) == identity(st))
        finally:
            os.close(fd)
        self.reader_probe(self.p.watch, (st.st_dev, st.st_ino))

    def start(self, action, rel, source, train, backup, caller, previous):
        index_path, current = self.indexed()
        request = None if action == 'rollback' else self.opt_in()
        if current is None and request is None:
            return 'noop'
        self.owner(caller)
        require(TRAIN.fullmatch(train))
        rel = self.release(rel, source)
        previous = self.release(previous)
        path = self.receipt_path(backup)
        if not absent(path):
            own = self.receipt(path)
            require((own['train'], own['source'], own['candidate'], own['previousMaster']) == (train, source, rel, previous))
            require(own['kind'] == ('rollback' if action == 'rollback' else 'activate'))
            if action == 'apply':
                require(request is not None or own['phase'] == 'committed', 'pending activation request disappeared')
                if request is not None:
                    require((own['requestSha256'], own['metadataSha256']) == request[1:])
            require(index_path == path or (own['phase'] == 'prepared' and own['previousReceipt'] == (str(index_path) if index_path else None)))
            if index_path != path:
                require(current is None or current['phase'] in TERMINAL)
                self.save(self.p.index, {'schema': 1, 'receipt': str(path)}, caller)
            return self.apply_receipt(path, own, caller)
        if current is not None:
            require(current['phase'] in TERMINAL, 'unresolved activation blocks new operation')
            expected = current['before'] if current['phase'] == 'reverted' else current['after']
            require(self.same(expected), 'selected keys differ from terminal receipt')
        if action == 'rollback':
            boundary = self.effective(current)
            if boundary is None or boundary['phase'] != 'committed' or (previous, rel) != (boundary['candidate'], boundary['previousMaster']):
                return 'noop'
            # The controller has already proven official one-step history. Read
            # its same protected tail via the existing verifier, never git ancestry.
            tail, _ = self.history_tail(boundary, before=True)
            require(tail['masterRelease'] == previous and tail['previousMasterRelease'] == rel)
            after = boundary['before']
            request_sha, metadata_sha = boundary['requestSha256'], boundary['metadataSha256']
        else:
            active = self.effective(current)
            if active is not None:
                if request is not None:
                    require((active['requestSha256'], active['metadataSha256']) == request[1:])
                return 'already-configured'
            if request is None:
                return 'noop'
            after = {ENABLED: {'present': True, 'value': '1', 'line': ENABLED + '=1\n'},
                     UID: {'present': True, 'value': request[0]['testUid'], 'line': UID + '=' + request[0]['testUid'] + '\n'}}
            request_sha, metadata_sha = request[1:]
        before = self.selected()[0]
        self.watch_ready(self.trusted_watch(action, rel, previous))
        receipt = {'schema': 1, 'kind': 'rollback' if action == 'rollback' else 'activate', 'train': train,
                   'source': source, 'candidate': rel, 'previousMaster': previous,
                   'requestSha256': request_sha, 'metadataSha256': metadata_sha,
                   'before': before, 'after': after, 'previousReceipt': str(index_path) if index_path else None,
                   'phase': 'prepared', 'historyBeforeSha256': digest(self.history_bytes()), 'commit': None}
        self.save(path, receipt, caller)
        # Env is never touched until both the receipt and its locator are durable.
        self.save(self.p.index, {'schema': 1, 'receipt': str(path)}, caller)
        return self.apply_receipt(path, receipt, caller)

    def apply_receipt(self, path, receipt, caller):
        if receipt['phase'] in {'applied', 'committed'}:
            require(self.same(receipt['after']))
            return 'already-applied'
        require(receipt['phase'] == 'prepared', 'uncertain/reverted apply is not replayed')
        trusted_watch = self.trusted_watch(receipt['kind'], receipt['candidate'], receipt['previousMaster'])
        self.watch_ready(trusted_watch)
        state, data, st = self.selected()
        require(semantic(state) == semantic(receipt['before']))
        receipt['phase'] = 'attempted'
        self.save(path, receipt, caller)
        try:
            def write_guard():
                self.owner(caller)
                self.watch_ready(trusted_watch)
            atomic(self.p.env, patch(data, receipt['after']), write_guard, self.p.owner, st)
            require(self.same(receipt['after']))
            receipt['phase'] = 'applied'
            self.save(path, receipt, caller)
        except (OSError, Refused):
            receipt['phase'] = 'unknown'
            try:
                self.save(path, receipt, caller)
            except (OSError, Refused):
                pass
            raise Unknown('selected replacement outcome requires explicit restore')
        return 'applied'

    def local(self, backup, train):
        if not backup:
            return None, None
        path = self.receipt_path(backup)
        if absent(path):
            return None, None
        receipt = self.receipt(path)
        require(receipt['train'] == train)
        indexed, _ = self.indexed()
        require(indexed == path, 'operation is not the current indexed receipt')
        return path, receipt

    def revert(self, backup, train, caller):
        self.owner(caller)
        path, receipt = self.local(backup, train)
        if receipt is None:
            self.guard()
            return 'noop'
        require(receipt['phase'] != 'committed', 'committed activation needs an inverse rollback receipt')
        state, data, st = self.selected()
        require(semantic(state) in (semantic(receipt['before']), semantic(receipt['after'])), 'third selected state')
        if receipt['phase'] == 'reverted':
            require(semantic(state) == semantic(receipt['before']))
            return 'already-reverted'
        receipt['phase'] = 'reverting'
        self.save(path, receipt, caller)
        try:
            if semantic(state) != semantic(receipt['before']):
                atomic(self.p.env, patch(data, receipt['before']), lambda: self.owner(caller), self.p.owner, st)
            require(self.same(receipt['before']))
            receipt['phase'] = 'reverted'
            self.save(path, receipt, caller)
        except (OSError, Refused):
            raise Unknown('restore not durably acknowledged')
        return 'reverted'

    def finalize(self, backup, train, caller):
        self.owner(caller)
        if backup:
            path, receipt = self.local(backup, train)
        else:
            # Same-operation official resume has no in-memory backup directory.
            # The fixed locator may recover only that train's exact receipt;
            # a foreign pending operation must still fail the global guard.
            path, receipt = self.indexed()
            if receipt is not None and receipt['train'] != train:
                path, receipt = None, None
        if receipt is None:
            self.guard()
            return 'noop'
        require(receipt['phase'] in {'applied', 'committed'} and self.same(receipt['after']))
        self.release(receipt['candidate'], receipt['source'])
        require(str(self.p.live.resolve(strict=True)) == receipt['candidate'])
        entry, tail_sha = self.history_tail(receipt)
        commit = {'seq': entry['seq'], 'checksum': entry['checksum'], 'lineSha256': tail_sha}
        if receipt['phase'] == 'committed':
            require(receipt['commit'] == commit)
            return 'already-committed'
        receipt['phase'], receipt['commit'] = 'committed', commit
        self.save(path, receipt, caller)
        return 'committed'

    def check_restart(self, backup, train, caller, direction):
        self.owner(caller)
        require(direction in {'before', 'after'})
        _, receipt = self.local(backup, train)
        if receipt is None:
            self.guard()
            if direction == 'after':
                _, current = self.indexed()
                require(current is not None or self.opt_in() is None, 'activation has no applied receipt')
            return 'proven'
        phases = {'reverted'} if direction == 'before' else {'applied', 'committed'}
        require(receipt['phase'] in phases and self.same(receipt[direction]), 'restart selected state not proven')
        return 'proven'

    def guard(self):
        _, receipt = self.indexed()
        if receipt is None:
            return 'clear'
        require(receipt['phase'] in TERMINAL, 'unresolved activation holds recovery')
        require(self.same(receipt['before'] if receipt['phase'] == 'reverted' else receipt['after']))
        return 'clear'

    def discover(self):
        path, receipt = self.indexed()
        if receipt is None:
            return {'schema': 1, 'state': 'absent'}
        return {'schema': 1, 'state': receipt['phase'], 'receipt': str(path), 'train': receipt['train'],
                'source': receipt['source'], 'targetMaster': receipt['candidate'], 'beforeMaster': receipt['previousMaster']}


def main(argv):
    carrier = Carrier()
    require(bool(argv))
    action, args = argv[0], argv[1:]
    if action in {'apply', 'rollback'}:
        require(len(args) == 6)
        result = carrier.start(action, *args)
    elif action in {'revert', 'finalize'}:
        require(len(args) == 3)
        result = getattr(carrier, action)(*args)
    elif action == 'check-restart':
        require(len(args) == 4)
        result = carrier.check_restart(*args)
    elif action in {'guard', 'discover'}:
        require(not args)
        result = getattr(carrier, action)()
    else:
        raise Refused('unknown fixed action')
    if isinstance(result, dict):
        print(json.dumps(result, separators=(',', ':')))
    else:
        print('CC5_ACTIVATION ' + result)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (Refused, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        # Never expose env/JSON data, exception strings, UID, session or secrets.
        print('CC5_ACTIVATION HOLD: fixed identity, owner, receipt or selected-state proof failed', file=sys.stderr)
        sys.exit(79)
