#!/usr/bin/env python3
"""Task-only packaging/SSH preparation. Never writes a user frame to Claude.

package runs on v5-dev; other roles run via python -c over approved SSH22.
Only unchanged host/plugin sources are installed on cc5. No dependency install.
"""
import ast
import base64
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

TASK = 'AGENT-REMOTE-T1555U'
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


def tmux(root, *args):
    env = {'HOME': '/home/box', 'PATH': '/usr/bin:/bin', 'TMUX_TMPDIR': str(root / 'tmux')}
    return subprocess.run(['tmux', '-L', 'oc-box', *args], env=env, capture_output=True, text=True)


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
                         '/usr/bin/claude', '--permission-mode', 'default'], 'wrong-host-process')
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
    os.chdir(info['cwd'])
    # fd0 is never read here: it belongs exclusively to the original host.
    os.execve(sys.executable, [sys.executable, str(root / 'install/host.py'), str(root / 'run'),
                              info['session'], '/usr/bin/claude', '--permission-mode', 'default'], env)


def inspect(root):
    info = owner(root)
    check_sources(root, info)
    result = {'kind': 'ready-only-preparation-not-real-chat', 'root': str(root), 'session': info['session'],
              'runtimeExists': (root / 'run').exists(),
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
        known = {'/usr/bin/claude', '/usr/bin/node', 'node', 'claude', '--permission-mode', 'default',
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
            require(role in ('launch', 'inspect', 'stop', 'cleanup'), 'unknown-role')
            root = task_root(sys.argv[2])
            {'launch': launch, 'inspect': inspect, 'stop': stop, 'cleanup': cleanup}[role](root)
    except Exception as error:
        # No raw exception/argv/response could leak pane or credentials.
        label = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('CC5_PREP_ERROR ' + label, file=sys.stderr)
        sys.exit(1)
