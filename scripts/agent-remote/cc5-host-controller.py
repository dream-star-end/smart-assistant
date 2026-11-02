#!/usr/bin/env python3
"""Task-only packaging/SSH preparation. Never writes a user frame to Claude.

package runs on v5-dev; other roles run via python -c over approved SSH22.
Original five host/plugin sources stay unchanged. The approved fixed MCP profile
is installed separately. No dependency install, credentials or non-TUI CLI use.
"""
import ast
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time

TASK = 'AGENT-REMOTE-T1555U'
PINNED_MCP_SHA = '9738e246fc23dbf356335f4effacbbd12204180b981dd9996d62305f2fba2809'
PINNED_SOCKET_SHA = '6507522620d6aaea8657a5bb061b6d110206c1f27a453d048e6e7d7b9a616fde'
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
PINNED_CLI_SIZE = 328262000
PINNED_CLI_SHA = 'fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824'
PLUGIN = ('.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts', 'hooks/frames.ts')
SOURCE_FILES = ('host.py',) + tuple('mod/oc-bridge/' + name for name in PLUGIN)


def require(value, message):
    if not value:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(files):
    h = hashlib.sha256()
    for name, data in sorted(files.items()):
        h.update(name.encode() + b'\0' + str(len(data)).encode() + b'\0' + data)
    return h.hexdigest()


def task_root(value):
    root = Path(value)
    require(root.parent == Path('/home/box') and
            re.fullmatch(r'oc-agentremote-t1555u-[a-z0-9-]{16,40}', root.name), 'bad-task-root')
    require(os.getuid() != 0 and Path.home() == Path('/home/box'), 'requires-box-user-no-sudo')
    return root


def owner(root):
    st = root.lstat()
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and st.st_mode & 0o077 == 0,
            'unsafe-task-directory')
    info = json.loads((root / 'OWNER.json').read_text())
    require(info['task'] == TASK and info['root'] == str(root) and info['uid'] == os.getuid(),
            'wrong-task-owner')
    require(info['cwd'] in ('/home/box', str(root / 'work')), 'unsafe-task-cwd')
    return info


def check_sources(root, info):
    actual = {}
    for name in SOURCE_FILES:
        p = root / 'install' / name
        st = p.lstat()
        require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and
                st.st_mode & 0o777 == 0o400, 'unsafe-installed-source')
        data = p.read_bytes()
        require(sha(data) == info['hashes'][name], 'installed-source-hash-mismatch')
        actual[name] = data
    require(digest({name: actual['mod/oc-bridge/' + name] for name in PLUGIN}) == info['pluginDigest'],
            'installed-mod-digest-mismatch')
    return actual



def cli_identity(path):
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and
            st.st_mode & 0o777 == 0o500 and st.st_size == PINNED_CLI_SIZE, 'unsafe-private-cli')
    return {'dev': st.st_dev, 'inode': st.st_ino, 'uid': st.st_uid, 'size': st.st_size,
            'mode': stat.S_IMODE(st.st_mode), 'mtimeNs': st.st_mtime_ns, 'ctimeNs': st.st_ctime_ns}


def hash_cli(path):
    before = cli_identity(path)
    h = hashlib.sha256()
    with path.open('rb') as stream:
        first = stream.read(1024 * 1024)
        require(first[:6] == b'\x7fELF\x02\x01' and first[18:20] == b'\x3e\x00', 'wrong-cli-elf')
        h.update(first)
        for piece in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(piece)
    require(h.hexdigest() == PINNED_CLI_SHA and cli_identity(path) == before,
            'private-cli-hash-or-identity-mismatch')
    return before


def claude_executable(root, info, full_hash=False):
    selected = info.get('claudeExecutable', '/usr/bin/claude')
    if selected == '/usr/bin/claude':
        return selected
    path = root / 'bin/claude-2.1.316'
    require(selected == str(path), 'unexpected-cli-path')
    identity = hash_cli(path) if full_hash else cli_identity(path)
    require(identity == info.get('cliFileIdentity'), 'private-cli-identity-changed')
    return selected


def install_cli(root):
    info = owner(root)
    check_sources(root, info)
    require(info.get('claudeExecutable', '/usr/bin/claude') == '/usr/bin/claude', 'private-cli-already-selected')
    require(not (root / 'run').exists() and all(tmux(root, 'has-session', '-t', '=' + name).returncode != 0
            for name in (info['session'], info['session'] + '-setup')), 'task-must-be-stopped-for-cli-install')
    require(os.statvfs(root).f_bavail * os.statvfs(root).f_frsize > PINNED_CLI_SIZE + 1024 ** 3,
            'insufficient-private-cli-disk')
    directory = root / 'bin'
    directory.mkdir(mode=0o700)
    path = directory / 'claude-2.1.316'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o500)
    own = os.fstat(fd)
    published = False
    try:
        count = 0
        with os.fdopen(fd, 'wb') as out:
            while True:
                piece = sys.stdin.buffer.read(min(1024 * 1024, PINNED_CLI_SIZE + 1 - count))
                if not piece:
                    break
                count += len(piece)
                require(count <= PINNED_CLI_SIZE, 'private-cli-input-too-large')
                out.write(piece)
            require(count == PINNED_CLI_SIZE, 'private-cli-input-truncated')
            out.flush()
            os.fsync(out.fileno())
        identity = hash_cli(path)
        info.update({'claudeExecutable': str(path), 'cliFileIdentity': identity,
                     'cliSha256': PINNED_CLI_SHA})
        temp = root / 'OWNER.cli-install.json'
        with open(temp, 'x', opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
            json.dump(info, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        temp.replace(root / 'OWNER.json')
        published = True
        print(json.dumps({'kind': 'private-pinned-cli-installed-no-chat', 'path': str(path),
                          'sha256': PINNED_CLI_SHA, 'identity': identity, 'systemCliUnchanged': True}))
    finally:
        if not published:
            current = path.lstat()
            require((current.st_dev, current.st_ino) == (own.st_dev, own.st_ino),
                    'partial-cli-identity-changed-no-cleanup')
            path.unlink()
            directory.rmdir()


def package(run_id):
    repo = Path(__file__).resolve().parents[2]
    require(repo.name == 'ocv5-agentremote-cc5-web-t1555u', 'requires-task-worktree')
    require(re.fullmatch(r'[a-z0-9-]{16,40}', run_id), 'bad-run-id')
    src = repo / 'packages/gateway/box-bridge-mod'
    files = {'host.py': (src / 'host.py').read_bytes()}
    files.update({'mod/oc-bridge/' + name: (src / 'oc-bridge' / name).read_bytes() for name in PLUGIN})
    tap = next(n.value.value for n in ast.parse(files['host.py']).body if isinstance(n, ast.Assign)
               and any(isinstance(t, ast.Name) and t.id == 'TAP_SOURCE' for t in n.targets)).encode()
    packet = {'task': TASK, 'root': '/home/box/oc-agentremote-t1555u-' + run_id,
              'session': 'oc-ar-' + run_id, 'cwd': '/home/box',
              'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
              'pluginDigest': digest({name: files['mod/oc-bridge/' + name] for name in PLUGIN}),
              'tapSha256': sha(tap), 'hashes': {name: sha(data) for name, data in files.items()},
              'files': {name: base64.b64encode(data).decode() for name, data in files.items()}}
    print(json.dumps(packet))


def install():
    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    require(len(raw) <= 1024 * 1024, 'package-too-large')
    packet = json.loads(raw)
    require(packet['task'] == TASK and set(packet['files']) == set(SOURCE_FILES) and
            set(packet['hashes']) == set(SOURCE_FILES), 'unexpected-package-files')
    root = task_root(packet['root'])
    require(packet['cwd'] == '/home/box' and
            re.fullmatch(r'oc-ar-[a-z0-9-]{16,40}', packet['session']), 'unsafe-launch-config')
    require(max(len(str(root / x).encode()) for x in ('run/bridge.sock', 'exec.sock', 'tmux/tmux-1001/oc-box')) <= 100,
            'unix-socket-path-too-long')
    data = {name: base64.b64decode(encoded, validate=True) for name, encoded in packet['files'].items()}
    require(all(sha(value) == packet['hashes'][name] for name, value in data.items()), 'package-hash-mismatch')
    require(digest({name: data['mod/oc-bridge/' + name] for name in PLUGIN}) == packet['pluginDigest'],
            'package-mod-digest-mismatch')
    os.umask(0o077)
    root.mkdir(mode=0o700)
    info = {key: value for key, value in packet.items() if key != 'files'}
    info['uid'] = os.getuid()
    (root / 'OWNER.json').write_text(json.dumps(info, indent=2) + '\n')
    os.chmod(root / 'OWNER.json', 0o600)
    for name, value in data.items():
        p = root / 'install' / name
        p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
        with os.fdopen(fd, 'wb') as out:
            out.write(value)
    for name in ('tmux', 'tmp'):
        (root / name).mkdir(mode=0o700)
    check_sources(root, info)
    print(json.dumps({'kind': 'installed-only-no-chat', **info}))


def tmux(root, *args, timeout=None):
    env = {'HOME': '/home/box', 'PATH': '/usr/bin:/bin', 'TMUX_TMPDIR': str(root / 'tmux')}
    return subprocess.run(['tmux', '-L', 'oc-box', *args], env=env, capture_output=True, text=True, timeout=timeout)


def read_private(path, limit=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1 and
                stat.S_IMODE(st.st_mode) in (0o400, 0o600) and 0 < st.st_size <= limit,
                'unsafe-private-task-file')
        data = os.read(fd, limit + 1)
        require(len(data) == st.st_size, 'private-task-file-changed')
        return data
    finally:
        os.close(fd)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def profile_files(root, operation_id, run_id, script, socket_script):
    require(UUID.fullmatch(operation_id) and UUID.fullmatch(run_id), 'bad-profile-identity')
    require(sha(script) == PINNED_MCP_SHA and sha(socket_script) == PINNED_SOCKET_SHA, 'wrong-pinned-mcp-source')
    return {'cc5-fixed-mcp.py': script, 'cc5-mcp-socket.py': socket_script,
            'client.json': canonical({'version': 1, 'operationId': operation_id, 'runId': run_id}),
            'mcp.json': canonical({'mcpServers': {'ocbridge': {'command': '/usr/bin/python3',
                         'args': ['-I', str(root / 'cprofile/cc5-fixed-mcp.py'), str(root)]}}})}


def package_profile(root_text, operation_id, run_id):
    repo = Path(__file__).resolve().parents[2]
    require(repo.name == 'ocv5-agentremote-cc5-web-t1555u', 'requires-task-worktree')
    require(re.fullmatch(r'/home/box/oc-agentremote-t1555u-[a-z0-9-]{16,40}', root_text), 'bad-profile-root')
    script = (repo / 'scripts/agent-remote/cc5-fixed-mcp.py').read_bytes()
    socket_script = (repo / 'scripts/agent-remote/cc5-mcp-socket.py').read_bytes()
    profile_files(Path(root_text), operation_id, run_id, script, socket_script)
    print(json.dumps({'version': 1, 'operationId': operation_id, 'runId': run_id,
                      'script': base64.b64encode(script).decode(),
                      'socketScript': base64.b64encode(socket_script).decode()}))


def check_profile(root):
    directory = root / 'cprofile'
    st = directory.lstat()
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o700,
            'unsafe-profile-directory')
    info = json.loads(read_private(directory / 'PROFILE.json'))
    require(set(info) == {'version', 'task', 'root', 'operationId', 'runId', 'hashes'} and
            info['version'] == 1 and info['task'] == TASK and info['root'] == str(root),
            'wrong-profile-manifest')
    script = read_private(directory / 'cc5-fixed-mcp.py')
    files = profile_files(root, info['operationId'], info['runId'], script,
                          read_private(directory / 'cc5-mcp-socket.py'))
    require(all(stat.S_IMODE((directory / name).lstat().st_mode) == 0o400
                for name in (*files, 'PROFILE.json')), 'unsafe-profile-file-mode')
    require(set(directory.iterdir()) == {directory / name for name in (*files, 'PROFILE.json')},
            'unexpected-profile-files')
    require(info['hashes'] == {name: sha(data) for name, data in files.items()}, 'profile-hash-mismatch')
    for name, expected in files.items():
        require(read_private(directory / name) == expected, 'profile-content-mismatch')
    return info


def install_profile(root):
    info = owner(root)
    check_sources(root, info)
    require(claude_executable(root, info) == str(root / 'bin/claude-2.1.316'), 'requires-private-cli')
    require(not (root / 'run').exists() and all(tmux(root, 'has-session', '-t', '=' + name).returncode != 0
            for name in (info['session'], info['session'] + '-setup')), 'task-must-be-stopped-for-profile-install')
    raw = sys.stdin.buffer.read(65537)
    require(len(raw) <= 65536, 'profile-packet-too-large')
    packet = json.loads(raw)
    require(set(packet) == {'version', 'operationId', 'runId', 'script', 'socketScript'} and packet['version'] == 1,
            'wrong-profile-packet')
    files = profile_files(root, packet['operationId'], packet['runId'],
                          base64.b64decode(packet['script'], validate=True),
                          base64.b64decode(packet['socketScript'], validate=True))
    directory = root / 'cprofile'
    require(not directory.exists() and not directory.is_symlink(), 'profile-already-exists')
    stage = root / 'cprofile.partial'
    stage.mkdir(mode=0o700)
    info = {'version': 1, 'task': TASK, 'root': str(root), 'operationId': packet['operationId'],
            'runId': packet['runId'], 'hashes': {name: sha(data) for name, data in files.items()}}
    try:
        for name, data in {**files, 'PROFILE.json': canonical(info)}.items():
            fd = os.open(stage / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        stage.rename(directory)
        check_profile(root)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    print(json.dumps({'kind': 'fixed-mcp-profile-installed-no-cli-launch', **info}))


def profile_args(root, info):
    check_profile(root)
    require(info['cwd'] == str(root / 'work'), 'requires-approved-task-workdir')
    work = root / 'work'
    st = work.lstat()
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o700,
            'unsafe-task-workdir')
    cli = claude_executable(root, info)
    require(cli == str(root / 'bin/claude-2.1.316'), 'requires-private-cli')
    return [cli, '--permission-mode', 'default', '--model', 'claude-sonnet-5', '--tools', '',
            '--strict-mcp-config', '--mcp-config', str(root / 'cprofile/mcp.json'),
            '--setting-sources', '', '--disable-slash-commands', '--allowedTools', 'mcp__ocbridge__roundtrip']


def process_record(pid):
    return {'pid': pid, 'startTicks': proc(pid)[1]}


def descendants_of(pid):
    # Metadata only, never argv/environ of unrelated processes.
    rows = {}
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            if path.stat().st_uid == os.getuid():
                fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
                rows[int(path.name)] = (int(fields[1]), fields[19])
        except (OSError, ValueError, IndexError):
            continue
    selected = {pid}
    for _ in range(20):
        children = {child for child, (parent, _) in rows.items() if parent in selected}
        if children <= selected:
            break
        selected |= children
    return [{'pid': child, 'startTicks': rows[child][1]} for child in sorted(selected - {pid})]


def write_lifecycle(root, info, processes):
    path = root / 'LIFECYCLE.json'
    history = []
    launch_hash = processes.get('launchArgvHash')
    if path.exists():
        previous = json.loads(read_private(path))
        require(previous['version'] == 1 and previous['root'] == str(root) and
                previous['session'] == info['session'], 'wrong-previous-lifecycle-record')
        history = [previous['host'], previous['claude'], *previous['descendants']]
        launch_hash = launch_hash or previous.get('launchArgvHash')
    observed = {}
    for item in [*history, *processes['descendants']]:
        if item is None:
            continue
        require(type(item['pid']) is int and item['pid'] > 1 and str(item['startTicks']).isdecimal(),
                'bad-previous-lifecycle-process')
        observed[(item['pid'], item['startTicks'])] = {'pid': item['pid'], 'startTicks': item['startTicks']}
    processes = {**processes, 'descendants': list(observed.values()), 'launchArgvHash': launch_hash}
    data = canonical({'version': 1, 'root': str(root), 'session': info['session'], **processes})
    stage = root / 'LIFECYCLE.partial'
    fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    stage.replace(path)
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def prove_stopped(root, emit=True):
    info = owner(root)
    require(not (root / 'run').exists() and all(tmux(root, 'has-session', '-t', '=' + name).returncode != 0
            for name in (info['session'], info['session'] + '-setup')), 'task-runtime-or-session-present')
    record = json.loads(read_private(root / 'LIFECYCLE.json'))
    require(record['version'] == 1 and record['root'] == str(root) and record['session'] == info['session'],
            'wrong-lifecycle-record')
    additional = []
    socket_record = None
    if (root / 'MCP-SOCKET.json').exists():
        socket_record = json.loads(read_private(root / 'MCP-SOCKET.json'))
        profile = check_profile(root)
        require(socket_record['version'] == 1 and socket_record['root'] == str(root) and
                socket_record['runId'] == profile['runId'] and
                socket_record['operationId'] == profile['operationId'], 'wrong-mcp-socket-record')
        additional.append(socket_record)
    for item in [record['host'], record['claude'], *record['descendants'], *additional]:
        if item is None:
            continue
        require(type(item['pid']) is int and item['pid'] > 1 and str(item['startTicks']).isdecimal(),
                'bad-lifecycle-process')
        try:
            ticks = proc(item['pid'])[1]
        except FileNotFoundError:
            continue
        require(ticks != item['startTicks'], 'recorded-task-process-still-alive')
    if emit:
        print(json.dumps({'kind': 'verified-task-runtime-absent', 'remoteStopped': True,
                          'root': str(root), 'session': info['session'], 'processes': record,
                          'mcpSocketIdentity': socket_record}))


def proc(pid):
    p = Path('/proc') / str(pid)
    require(p.stat().st_uid == os.getuid(), 'wrong-process-uid')
    args = (p / 'cmdline').read_bytes().split(b'\0')
    require(args[-1] == b'', 'unterminated-process-argv')
    args = [a.decode() for a in args[:-1]]  # Internal empty arguments are security-significant.
    start = (p / 'stat').read_text().rsplit(')', 1)[1].split()[19]
    return args, start


def host_identity(root, info):
    lifecycle = None
    if (root / 'LIFECYCLE.json').exists():
        lifecycle = json.loads(read_private(root / 'LIFECYCLE.json'))
        require(lifecycle['version'] == 1 and lifecycle['root'] == str(root) and
                lifecycle['session'] == info['session'], 'wrong-host-lifecycle')
    if (root / 'run/host.pid').exists():
        pid = int((root / 'run/host.pid').read_text())
    else:
        require(lifecycle is not None, 'missing-host-identity')
        pid = lifecycle['host']['pid']
    require(type(pid) is int and pid > 1, 'invalid-host-pid')
    args, start = proc(pid)
    if lifecycle is not None:
        require(lifecycle['host'] == {'pid': pid, 'startTicks': start}, 'host-start-identity-changed')
    expected = [str(root / 'install/host.py'), str(root / 'run'), info['session'], *profile_args(root, info)]
    native_host = args[1:] == expected
    preexec = (lifecycle is not None and args[-2:] == ['launch', str(root)] and
               lifecycle.get('launchArgvHash') == sha(canonical(args)))
    require(native_host or preexec, 'wrong-host-process')
    return pid, start


@contextmanager
def control_lock(root):
    owner(root)
    fd = os.open(root / 'CONTROL.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1
                and stat.S_IMODE(st.st_mode) == 0o600, 'unsafe-task-control-lock')
        os.set_inheritable(fd, False)
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)  # Also closed atomically on successful exec; never inherited by host/tmux.


def mark_stopping(root):
    profile = check_profile(root)
    value = {'version': 1, 'root': str(root), 'operationId': profile['operationId'], 'runId': profile['runId']}
    path = root / 'STOPPING.json'
    if path.exists():
        require(json.loads(read_private(path)) == value, 'wrong-task-stop-marker')
        return
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(canonical(value))
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def launch(root):
    with control_lock(root):
        require(not (root / 'STOPPING.json').exists(), 'task-permanently-stopped')
        launch_locked(root)


def launch_locked(root):
    info = owner(root)
    if (root / 'LIFECYCLE.json').exists():
        prove_stopped(root, emit=False)  # A new launch cannot erase an unproved old writer.
    files = check_sources(root, info)
    require(not (root / 'run').exists(), 'runtime-already-exists')
    env = {'HOME': '/home/box', 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
           'TMPDIR': str(root / 'tmp'), 'TMUX_TMPDIR': str(root / 'tmux'),
           'OC_BOX_MOD_FILES': json.dumps({name: base64.b64encode(files['mod/oc-bridge/' + name]).decode()
                                           for name in PLUGIN}),
           'OC_BOX_MOD_SHA256': info['pluginDigest'], 'OC_BOX_READY_MS': '20000',
           # Same native guards as boxTextPlan.ts; these bound retries/output,
           # not the number of upstream requests or the platform monetary cost.
           'CLAUDE_CODE_MAX_RETRIES': '0', 'CLAUDE_CODE_DISABLE_REFUSAL_RETRY': '1',
           'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS': '0', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS': '1024',
           'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    claude_executable(root, info, full_hash=True)
    cli_args = profile_args(root, info)
    write_lifecycle(root, info, {'host': process_record(os.getpid()), 'claude': None, 'descendants': [],
                                'launchArgvHash': sha(canonical(proc(os.getpid())[0]))})
    os.chdir(info['cwd'])
    # fd0 is never read here: it belongs exclusively to the original host.
    os.execve(sys.executable, [sys.executable, str(root / 'install/host.py'), str(root / 'run'),
                              info['session'], *cli_args], env)


def tool_socket(root):
    with control_lock(root):
        require(not (root / 'STOPPING.json').exists(), 'task-permanently-stopped')
        tool_socket_locked(root)


def tool_socket_locked(root):
    info = owner(root)
    check_sources(root, info)
    profile_args(root, info)  # Includes all pinned profile contents/identity checks.
    env = {'HOME': '/home/box', 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TMPDIR': str(root / 'tmp')}
    script = str(root / 'cprofile/cc5-mcp-socket.py')
    os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-B', script, str(root)], env)


def workspace(root):
    info = owner(root)
    check_sources(root, info)
    require(not (root / 'run').exists(), 'runtime-still-present')
    work = root / 'work'
    work.mkdir(mode=0o700)
    info['cwd'] = str(work)
    (root / 'OWNER.json').write_text(json.dumps(info, indent=2) + '\n')
    print(json.dumps({'kind': 'empty-task-workspace-selected', 'cwd': str(work)}))


def inspect(root):
    info = owner(root)
    check_sources(root, info)
    result = {'kind': 'ready-only-preparation-not-real-chat', 'root': str(root), 'session': info['session'],
              'runtimeExists': (root / 'run').exists(), 'cwd': info['cwd'],
              'note': 'stdin byte count must be recorded by the controller; not inferred here'}
    if (root / 'run/host.pid').exists():
        pid, start = host_identity(root, info)
        result.update({'hostPid': pid, 'hostStartTicks': start})
    if (root / 'run/claude.pid').exists():
        pid = int((root / 'run/claude.pid').read_text())
        args, start = proc(pid)
        require(args == profile_args(root, info) + ['--plugin-dir', str(root / 'run/mod/oc-bridge')],
                'wrong-task-claude-profile')
        snapshot = subprocess.check_output(['ps', '-ww', '-o', 'pid,tty,args', '-p', str(pid)], text=True)
        require(re.search(r'\bpts/\d+\b', snapshot), 'claude-must-have-pts')
        result.update({'claudePid': pid, 'claudeStartTicks': start, 'taskArgv': args, 'ps': snapshot})
        write_lifecycle(root, info, {'host': process_record(result['hostPid']),
                                  'claude': process_record(pid), 'descendants': descendants_of(pid)})
        if (root / 'run/tap.py').exists():
            require(sha((root / 'run/tap.py').read_bytes()) == info['tapSha256'], 'runtime-tap-mismatch')
    pane = tmux(root, 'list-panes', '-t', '=' + info['session'], '-F', '#{pane_pid} #{pane_tty} #{pane_current_command}')
    result['taskPaneMetadata'] = pane.stdout.strip() if pane.returncode == 0 else None
    print(json.dumps(result))




def native_process_identity(pid):
    path = Path('/proc') / str(pid)
    require(path.stat().st_uid == os.getuid(), 'snapshot-wrong-process-uid')
    fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'ppid': int(fields[1]), 'pgrp': int(fields[2]),
            'session': int(fields[3]), 'ttyNumber': int(fields[4]), 'startTicks': fields[19]}


def snapshot(root):
    """One bounded evidence window, not proof of continuous/SDK absence or chat success."""
    info = owner(root)
    check_sources(root, info)
    host = host_identity(root, info)
    pid = int((root / 'run/claude.pid').read_text())
    task_args, start = proc(pid)
    begun = datetime.now(timezone.utc).isoformat()
    clock = time.monotonic()
    allowed = {claude_executable(root, info), '/usr/bin/claude', '/usr/bin/node', 'node', 'claude', '--permission-mode',
               'default', '--plugin-dir', str(root / 'run/mod/oc-bridge')}

    def safe_args(args):
        forbidden = ('-p', '--print', '--output-format', '--input-format', '--sdk', '--headless')
        require(bool(args) and not any(a in forbidden or 'stream-json' in a or
                a.startswith(tuple(x + '=' for x in forbidden)) for a in args),
                'snapshot-forbidden-claude-argv-no-output')
        require(all(a in allowed for a in args), 'snapshot-unknown-argv-no-output')

    def pane_identity():
        result = tmux(root, 'list-panes', '-t', '=' + info['session'],
                      '-F', '#{pane_id} #{pane_pid} #{pane_tty}', timeout=2)
        require(result.returncode == 0 and len(result.stdout.splitlines()) == 1,
                'snapshot-task-pane-unavailable')
        pane_id, pane_pid, tty = result.stdout.strip().split()
        require(re.fullmatch(r'%[0-9]+', pane_id) and pane_pid.isdecimal() and
                int(pane_pid) > 1 and re.fullmatch(r'/dev/pts/[0-9]+', tty),
                'snapshot-task-pane-not-pts')
        # Original host keeps an outer pane shell to write exit status; Claude
        # is its descendant, not the pane PID. Freeze both and their actual ancestry.
        chain = [native_process_identity(pid)]
        require(chain[0]['startTicks'] == start and chain[0]['ttyNumber'] != 0,
                'snapshot-task-process-without-tty')
        while chain[-1]['pid'] != int(pane_pid):
            parent = chain[-1]['ppid']
            require(len(chain) < 8 and parent > 1 and
                    parent not in {row['pid'] for row in chain}, 'snapshot-pane-not-ancestor')
            chain.append(native_process_identity(parent))
        require(all(row['ttyNumber'] == chain[0]['ttyNumber'] and
                    row['session'] == chain[0]['session'] for row in chain),
                'snapshot-pane-ancestry-tty-mismatch')
        return {'paneId': pane_id, 'panePid': int(pane_pid), 'tty': tty, 'ancestry': chain}

    require(task_args == profile_args(root, info) + ['--plugin-dir', str(root / 'run/mod/oc-bridge')],
            'snapshot-wrong-task-claude-profile')
    identity = pane_identity()
    # Enumerate names without exposing arbitrary process args or environments.
    listing = subprocess.check_output(['ps', '-eo', 'pid=,tty=,comm='], text=True, timeout=2)
    candidates = []
    for row in listing.splitlines():
        parts = row.split(None, 2)
        if len(parts) == 3 and re.fullmatch(r'claude(?:[.-].*)?', parts[2], re.IGNORECASE):
            candidates.append(int(parts[0]))
    require(pid in candidates, 'snapshot-task-not-in-native-claude-list')
    processes = []
    for candidate in sorted(set(candidates)):
        args, ticks = proc(candidate)
        if candidate == pid:
            require(args == task_args, 'snapshot-task-argv-changed')
        else:
            safe_args(args)  # The unrelated login keeps the original narrow no-profile rule.
        # Validate this exact ps text before it can be printed; do not trust an earlier argv.
        row = subprocess.check_output(['ps', '-ww', '-o', 'pid=,tty=,args=', '-p', str(candidate)],
                                      text=True, timeout=2).strip()
        fields = row.split(None, 2)
        require(len(fields) == 3 and fields[0] == str(candidate) and
                re.fullmatch(r'pts/[0-9]+', fields[1]), 'snapshot-native-claude-without-pts')
        # ps cannot represent empty arguments; the exact /proc argv array is authoritative.
        require(fields[2] == ' '.join(args), 'snapshot-ps-argv-raced-no-output')
        require(proc(candidate) == (args, ticks), 'snapshot-process-identity-changed')
        if candidate == pid:
            require('/dev/' + fields[1] == identity['tty'], 'snapshot-task-tty-changed')
        processes.append({'pid': candidate, 'startTicks': ticks, 'ps': row})
    captured = tmux(root, 'capture-pane', '-p', '-S', '-200', '-t', identity['paneId'], timeout=2)
    require(captured.returncode == 0, 'snapshot-capture-failed')
    pane = captured.stdout
    lower = pane.lower()
    require(not any(word in lower for word in ('usage credits', 'sign in', 'log in',
            'authentication', 'api key', 'access token', 'oauth', 'authorization:')) and
            not re.search(r'sk-(?:ant-|[A-Za-z0-9]{20})|eyJ[A-Za-z0-9_-]{20}', pane),
            'snapshot-account-or-sensitive-pane-no-output')
    require(pane_identity() == identity and proc(pid) == (task_args, start) and
            host_identity(root, info) == host, 'snapshot-task-identity-changed')
    elapsed = time.monotonic() - clock
    require(elapsed <= 5, 'snapshot-window-exceeded')
    print(json.dumps({'kind': 'single-interactive-evidence-window-not-web-acceptance',
                      'beganUtc': begun, 'endedUtc': datetime.now(timezone.utc).isoformat(),
                      'windowSeconds': elapsed, 'root': str(root), 'session': info['session'],
                      'taskPid': pid, 'taskStartTicks': start, 'taskArgv': task_args, 'taskPaneId': identity['paneId'],
                      'taskTty': identity['tty'], 'taskPaneProcessIdentity': identity, 'psColumns': 'pid tty args', 'claudeProcesses': processes,
                      'paneText': pane,
                      'scope': 'Recognizable native Claude process names in this window only; '
                               'not continuous monitoring or proof of arbitrary SDK absence.'}))


def stop(root):
    with control_lock(root):
        mark_stopping(root)
        stop_locked(root)


def stop_socket(root):
    with control_lock(root):
        mark_stopping(root)
        path = root / 'MCP-SOCKET.json'
        if not path.exists():
            print(json.dumps({'kind': 'mcp-identity-not-published-not-exit-proof'}))
            return
        record = json.loads(read_private(path))
        profile = check_profile(root)
        require(record['version'] == 1 and record['root'] == str(root) and
                record['runId'] == profile['runId'] and record['operationId'] == profile['operationId'],
                'wrong-stop-mcp-identity')
        pid, start = record['pid'], record['startTicks']
        require(type(pid) is int and pid > 1 and isinstance(start, str) and start.isdecimal(),
                'bad-stop-mcp-process')
        try:
            args, ticks = proc(pid)
        except FileNotFoundError:
            print(json.dumps({'kind': 'recorded-mcp-exited-needs-independent-proof'}))
            return
        require(ticks == start and args == ['/usr/bin/python3', '-I', '-B',
                str(root / 'cprofile/cc5-mcp-socket.py'), str(root)], 'wrong-stop-mcp-process')
        fd = os.pidfd_open(pid)
        try:
            require(proc(pid) == (args, start), 'mcp-process-identity-changed')
            signal.pidfd_send_signal(fd, signal.SIGTERM)
        finally:
            os.close(fd)
        print(json.dumps({'kind': 'sent-term-to-verified-mcp-socket', 'pid': pid, 'startTicks': start}))


def stop_locked(root):
    info = owner(root)
    if not (root / 'run').exists() and not (root / 'LIFECYCLE.json').exists():
        print(json.dumps({'kind': 'already-stopped', 'runtimeAbsent': True}))
        return
    try:
        pid, start = host_identity(root, info)
    except FileNotFoundError:
        require(not (root / 'run').exists(), 'dead-host-with-runtime-still-present')
        print(json.dumps({'kind': 'recorded-host-exited-still-needs-independent-proof'}))
        return
    claude_record = None
    descendants = []
    if (root / 'run/claude.pid').exists():
        claude_pid = int((root / 'run/claude.pid').read_text())
        require(proc(claude_pid)[0] == profile_args(root, info) +
                ['--plugin-dir', str(root / 'run/mod/oc-bridge')], 'wrong-stop-claude-profile')
        claude_record = process_record(claude_pid)
        descendants = descendants_of(claude_pid)
    write_lifecycle(root, info, {'host': process_record(pid), 'claude': claude_record,
                                'descendants': descendants})
    require(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'pidfd-support-required')
    fd = os.pidfd_open(pid)
    try:
        require(host_identity(root, info) == (pid, start), 'host-identity-changed')
        signal.pidfd_send_signal(fd, signal.SIGTERM)
    finally:
        os.close(fd)
    print(json.dumps({'kind': 'sent-term-to-verified-task-host', 'pid': pid, 'startTicks': start}))


def cleanup(root):
    info = owner(root)
    require(not (root / 'run').exists(), 'runtime-still-present')
    require(all(tmux(root, 'has-session', '-t', '=' + name).returncode != 0
                for name in (info['session'], info['session'] + '-setup')), 'task-session-still-present')
    if (root / 'LIFECYCLE.json').exists():
        prove_stopped(root, emit=False)
    shutil.rmtree(root)
    print(json.dumps({'kind': 'task-installation-removed', 'root': str(root), 'rootAbsent': not root.exists()}))


if __name__ == '__main__':
    try:
        role = sys.argv[1]
        if role == 'package':
            package(sys.argv[2])
        elif role == 'install':
            install()
        elif role == 'package-profile':
            package_profile(sys.argv[2], sys.argv[3], sys.argv[4])
        else:
            require(role in ('launch', 'workspace', 'inspect', 'snapshot', 'install-cli', 'install-profile', 'tool-socket', 'stop-socket', 'prove-stopped', 'stop', 'cleanup'), 'unknown-role')
            root = task_root(sys.argv[2])
            {'launch': launch, 'workspace': workspace, 'install-profile': install_profile, 'tool-socket': tool_socket, 'stop-socket': stop_socket, 'prove-stopped': prove_stopped,
             'inspect': inspect, 'snapshot': snapshot, 'install-cli': install_cli, 'stop': stop, 'cleanup': cleanup}[role](root)
    except Exception as error:
        # No raw exception/argv/response could leak pane or credentials.
        label = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('CC5_PREP_ERROR ' + label, file=sys.stderr)
        sys.exit(1)
