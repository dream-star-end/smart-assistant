#!/usr/bin/env python3
"""Task-only packaging/SSH preparation. Never writes a user frame to Claude.

package runs on v5-dev; other roles run via python -c over approved SSH22.
Only unchanged host/plugin sources are installed on cc5. No dependency install.
"""
import ast
import base64
from datetime import datetime, timezone
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
            re.fullmatch(r'oc-agentremote-t1555u-[a-z0-9-]{8,40}', root.name), 'bad-task-root')
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
    require(repo.name == 'ocv5-agentremote-p3-t1555u', 'requires-task-worktree')
    require(re.fullmatch(r'[a-z0-9-]{8,40}', run_id), 'bad-run-id')
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
            re.fullmatch(r'oc-ar-[a-z0-9-]{8,40}', packet['session']), 'unsafe-launch-config')
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


def proc(pid):
    p = Path('/proc') / str(pid)
    require(p.stat().st_uid == os.getuid(), 'wrong-process-uid')
    args = (p / 'cmdline').read_bytes().split(b'\0')
    args = [a.decode() for a in args if a]
    start = (p / 'stat').read_text().rsplit(')', 1)[1].split()[19]
    return args, start


def host_identity(root, info):
    pid = int((root / 'run/host.pid').read_text())
    args, start = proc(pid)
    require(args[1:] == [str(root / 'install/host.py'), str(root / 'run'), info['session'],
                         claude_executable(root, info), '--permission-mode', 'default'], 'wrong-host-process')
    return pid, start


def launch(root):
    info = owner(root)
    files = check_sources(root, info)
    require(not (root / 'run').exists(), 'runtime-already-exists')
    env = {'HOME': '/home/box', 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
           'TMPDIR': str(root / 'tmp'), 'TMUX_TMPDIR': str(root / 'tmux'),
           'OC_BOX_MOD_FILES': json.dumps({name: base64.b64encode(files['mod/oc-bridge/' + name]).decode()
                                           for name in PLUGIN}),
           'OC_BOX_MOD_SHA256': info['pluginDigest'], 'OC_BOX_READY_MS': '20000'}
    selected_cli = claude_executable(root, info, full_hash=True)
    os.chdir(info['cwd'])
    # fd0 is never read here: it belongs exclusively to the original host.
    os.execve(sys.executable, [sys.executable, str(root / 'install/host.py'), str(root / 'run'),
                              info['session'], selected_cli, '--permission-mode', 'default'], env)


def workspace(root):
    info = owner(root)
    check_sources(root, info)
    require(not (root / 'run').exists(), 'runtime-still-present')
    work = root / 'work'
    work.mkdir(mode=0o700)
    info['cwd'] = str(work)
    (root / 'OWNER.json').write_text(json.dumps(info, indent=2) + '\n')
    print(json.dumps({'kind': 'empty-task-workspace-selected', 'cwd': str(work)}))


def trust_prepare(root):
    info = owner(root)
    check_sources(root, info)
    work = root / 'work'
    require(info['cwd'] == str(work) and work.is_dir() and not work.is_symlink()
            and work.stat().st_uid == os.getuid() and work.stat().st_mode & 0o777 == 0o700
            and not any(work.iterdir()), 'requires-empty-task-workspace')
    require(not (root / 'run').exists(), 'host-guard-must-not-be-running')
    session = info['session'] + '-setup'
    require(tmux(root, 'has-session', '-t', '=' + session).returncode != 0, 'setup-already-exists')
    args = ['new-session', '-d', '-s', session, '-x', '200', '-y', '50', '-c', str(work), '--',
            'env', '-i', 'HOME=/home/box',
            'PATH=/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8',
            'TERM=xterm-256color', 'DISABLE_AUTOUPDATER=1', claude_executable(root, info, full_hash=True),
            '--permission-mode', 'default', '--plugin-dir', str(root / 'install/mod/oc-bridge')]
    require(tmux(root, *args).returncode == 0, 'setup-launch-failed')
    identity = None
    matched = False
    result = {'kind': 'native-trust-configuration-only', 'cwd': str(work), 'session': session,
              'chatFrames': 0, 'trustEnterKeys': 0, 'globalConfigReadOrEditedByHelper': False}
    try:
        for _ in range(60):
            meta = tmux(root, 'list-panes', '-t', '=' + session, '-F', '#{pane_id} #{pane_pid} #{pane_tty}')
            require(meta.returncode == 0, 'setup-exited-before-trust')
            pane_id, pid_text, tty = meta.stdout.strip().split()
            pid = int(pid_text)
            require(tty.startswith('/dev/pts/'), 'setup-must-have-pts')
            current = (pane_id, pid, proc(pid)[1], tty)
            if identity is None:
                identity = current
            require(current == identity, 'setup-identity-changed')
            require(os.readlink('/proc/' + str(pid) + '/cwd') == str(work), 'setup-cwd-changed')
            pane = tmux(root, 'capture-pane', '-p', '-t', pane_id).stdout
            pane = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', pane)
            selected = re.search(r'[❯>]\s*1[.)]\s*Yes, I trust this folder', pane)
            forbidden = any(x in pane.lower() for x in ('usage credits', 'sign in', 'log in'))
            require(not forbidden, 'account-menu-no-keys')
            own_paths = (str(work), '~/' + str(work.relative_to('/home/box')))
            if any(path in pane for path in own_paths) and selected:
                # This is only the trust dialog for this empty task directory; never a prompt.
                require((pane_id, pid, proc(pid)[1], tty) == identity, 'setup-identity-changed')
                require(tmux(root, 'send-keys', '-t', pane_id, 'Enter').returncode == 0,
                        'trust-key-failed')
                result.update({'trustEnterKeys': 1, 'taskPid': pid, 'taskTty': tty,
                               'matchedOwnPathAndSelectedTrustChoice': True})
                matched = True
                time.sleep(2)
                break
            time.sleep(0.2)
        require(matched, 'trust-dialog-not-matched-no-keys')
    finally:
        if tmux(root, 'has-session', '-t', '=' + session).returncode == 0:
            require(identity is not None, 'setup-identity-unavailable-no-kill')
            meta = tmux(root, 'list-panes', '-t', '=' + session, '-F', '#{pane_id} #{pane_pid} #{pane_tty}')
            pane_id, pid_text, tty = meta.stdout.strip().split()
            require((pane_id, int(pid_text), proc(int(pid_text))[1], tty) == identity,
                    'setup-identity-changed-no-kill')
            require(tmux(root, 'kill-session', '-t', '=' + session).returncode == 0,
                    'setup-stop-failed')
        result['setupSessionAbsent'] = tmux(root, 'has-session', '-t', '=' + session).returncode != 0
    print(json.dumps(result))


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
        forbidden = ('-p', '--print', '--output-format', '--input-format', '--sdk', '--headless')
        require(not any(a in forbidden or a.startswith(tuple(x + '=' for x in forbidden))
                        or 'stream-json' in a for a in args), 'forbidden-claude-argv')
        # No arbitrary argv reaches evidence: allow only our known launch args or a CLI process title.
        known = {claude_executable(root, info), '/usr/bin/claude', '/usr/bin/node', 'node', 'claude', '--permission-mode', 'default',
                 '--plugin-dir', str(root / 'run/mod/oc-bridge')}
        require(all(a in known for a in args), 'unknown-claude-argv-no-output')
        snapshot = subprocess.check_output(['ps', '-ww', '-o', 'pid,tty,args', '-p', str(pid)], text=True)
        require(re.search(r'\bpts/\d+\b', snapshot), 'claude-must-have-pts')
        result.update({'claudePid': pid, 'claudeStartTicks': start, 'ps': snapshot})
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

    safe_args(task_args)
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
        safe_args(args)
        # Validate this exact ps text before it can be printed; do not trust an earlier argv.
        row = subprocess.check_output(['ps', '-ww', '-o', 'pid=,tty=,args=', '-p', str(candidate)],
                                      text=True, timeout=2).strip()
        fields = row.split(None, 2)
        require(len(fields) == 3 and fields[0] == str(candidate) and
                re.fullmatch(r'pts/[0-9]+', fields[1]), 'snapshot-native-claude-without-pts')
        safe_args(fields[2].split())
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
                      'taskPid': pid, 'taskStartTicks': start, 'taskPaneId': identity['paneId'],
                      'taskTty': identity['tty'], 'taskPaneProcessIdentity': identity, 'psColumns': 'pid tty args', 'claudeProcesses': processes,
                      'paneText': pane,
                      'scope': 'Recognizable native Claude process names in this window only; '
                               'not continuous monitoring or proof of arbitrary SDK absence.'}))


def stop(root):
    info = owner(root)
    if not (root / 'run').exists():
        print(json.dumps({'kind': 'already-stopped', 'runtimeAbsent': True}))
        return
    pid, start = host_identity(root, info)
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
    require(tmux(root, 'has-session', '-t', '=' + info['session']).returncode != 0, 'task-session-still-present')
    shutil.rmtree(root)
    print(json.dumps({'kind': 'task-installation-removed', 'root': str(root), 'rootAbsent': not root.exists()}))


if __name__ == '__main__':
    try:
        role = sys.argv[1]
        if role == 'package':
            package(sys.argv[2])
        elif role == 'install':
            install()
        else:
            require(role in ('launch', 'workspace', 'trust-prepare', 'inspect', 'snapshot', 'install-cli', 'stop', 'cleanup'), 'unknown-role')
            root = task_root(sys.argv[2])
            {'launch': launch, 'workspace': workspace, 'trust-prepare': trust_prepare,
             'inspect': inspect, 'snapshot': snapshot, 'install-cli': install_cli, 'stop': stop, 'cleanup': cleanup}[role](root)
    except Exception as error:
        # No raw exception/argv/response could leak pane or credentials.
        label = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('CC5_PREP_ERROR ' + label, file=sys.stderr)
        sys.exit(1)
