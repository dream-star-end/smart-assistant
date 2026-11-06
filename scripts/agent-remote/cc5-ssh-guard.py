#!/usr/bin/env python3
"""Forced-command preparation; installing it or an authorized key is a separate action.

The administrator-owned authorized_keys command may pin one --task-root; otherwise each
command names its chat's task root inside the configured prefix. Everything
else that bounds the run — source addresses, sshd port, account, root prefix,
accepted controller digests, models and account directories — is read from the
read-only JSON next to this file, so no value in SSH_ORIGINAL_COMMAND or the client
environment can widen it. The key also requires from="<gateway>" and restrict: this
process can reject agent/X11/PTY signals, but only sshd's key restrictions prevent
independent forwarding channels.
Only the Cc5SshHost runtime operations plus the master's provision/reset are accepted,
not node setup or inspection.
"""
import base64
import binascii
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import stat
import sys

DEFAULT_CONFIG = Path(__file__).resolve().with_name('cc5-ssh-guard.json')
PYTHON = '/usr/bin/python3'
ROLES = frozenset(('launch', 'tool-socket', 'stop', 'stop-socket', 'prove-stopped', 'provision', 'reset'))
MAX_CONFIG_BYTES = 65536
MAX_SOURCE_BYTES = 131072  # Same bound as Cc5SshHost's pinned controller file.
MAX_COMMAND_BYTES = 4 * ((MAX_SOURCE_BYTES + 2) // 3) + 4096
LOADER_PREFIX = "exec(compile(__import__('base64').b64decode('"
LOADER_SUFFIX = "'),'cc5-task-controller','exec'))"
SHA256 = re.compile(r'[0-9a-f]{64}\Z')
USER = re.compile(r'[a-z_][a-z0-9_-]{0,31}\Z')
MODEL = re.compile(r'[a-z0-9][a-z0-9._-]{0,63}\Z')
PROFILE = re.compile(r'[a-z0-9][a-z0-9-]{0,31}\Z')
CONFIG_KEYS = frozenset(('version', 'sourceIps', 'user', 'home', 'sshPort', 'rootPrefix',
                         'controllerSha256', 'models', 'profiles'))
SSH_ENV = frozenset(('SSH_ORIGINAL_COMMAND', 'SSH_CONNECTION', 'SSH_CLIENT'))


class GuardRejected(Exception):
    pass


def require(value):
    if not value:
        raise GuardRejected()


def address(value):
    if not isinstance(value, str):
        return False
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def load_config(path=DEFAULT_CONFIG):
    """The guard's only trust root; installed read-only by the administrator."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid in (0, os.getuid()) and st.st_nlink == 1 and
                stat.S_IMODE(st.st_mode) & 0o022 == 0 and 0 < st.st_size <= MAX_CONFIG_BYTES)
        value = json.loads(os.read(fd, MAX_CONFIG_BYTES))
    finally:
        os.close(fd)
    require(isinstance(value, dict) and set(value) == CONFIG_KEYS and
            type(value['version']) is int and value['version'] == 1)
    require(isinstance(value['sourceIps'], list) and 0 < len(value['sourceIps']) <= 8 and
            all(address(entry) for entry in value['sourceIps']))
    require(isinstance(value['user'], str) and USER.fullmatch(value['user']) and value['user'] != 'root')
    home = value['home']
    require(isinstance(home, str) and home == '/home/' + value['user'])
    require(type(value['sshPort']) is int and 0 < value['sshPort'] <= 65535)
    prefix = value['rootPrefix']
    require(isinstance(prefix, str) and
            re.fullmatch(re.escape(home) + r'/oc-agentremote-[a-z0-9-]*', prefix))
    require(isinstance(value['controllerSha256'], list) and 0 < len(value['controllerSha256']) <= 8 and
            all(isinstance(entry, str) and SHA256.fullmatch(entry) for entry in value['controllerSha256']))
    require(isinstance(value['models'], list) and 0 < len(value['models']) <= 32 and
            all(isinstance(entry, str) and MODEL.fullmatch(entry) for entry in value['models']))
    require(isinstance(value['profiles'], list) and len(value['profiles']) <= 32 and
            all(isinstance(entry, str) and PROFILE.fullmatch(entry) for entry in value['profiles']))
    return value


def fixed_config(argv):
    # The administrator-owned forced command may pin one task root; without it the root
    # comes from the command and is bounded by the configured prefix (one task per chat).
    if len(argv) == 1:
        return None
    require(len(argv) == 3 and argv[1] == '--task-root')
    return argv[2]


def task_root(config, value):
    require(isinstance(value, str) and
            re.fullmatch(re.escape(config['rootPrefix']) + r'[a-z0-9-]{16,40}', value))
    return value


def quote(value):
    # Exact serialization used by packages/gateway/src/cc5SshHost.ts.
    return "'" + value.replace("'", "'\\''") + "'"


def launch_args(args, config):
    # Model and account directory travel as trailing launch arguments: they are part
    # of the session's identity, so the guard must see them before the CLI starts.
    require(len(args) >= 9)
    require(args[7] == '--model' and args[8] in config['models'])
    if len(args) == 9:
        return args[7:]
    require(args[9] == '--profile' and args[10] in config['profiles'])
    return args[7:]


def verified_argv(original, config, pinned_root):
    require(isinstance(original, str) and 0 < len(original) <= MAX_COMMAND_BYTES)
    require(not any(c in original for c in ('\0', '\r', '\n')))
    try:
        args = shlex.split(original, posix=True)
    except ValueError:
        raise GuardRejected() from None
    require(len(args) in (7, 9, 11) and args[:4] == [PYTHON, '-I', '-B', '-c'])
    root = task_root(config, args[6])
    require(args[5] in ROLES and (pinned_root is None or root == pinned_root))
    require(original == ' '.join(quote(arg) for arg in args))
    extra = launch_args(args, config) if args[5] == 'launch' else []
    require(len(args) == 7 + len(extra))
    loader = args[4]
    require(loader.startswith(LOADER_PREFIX) and loader.endswith(LOADER_SUFFIX))
    encoded = loader[len(LOADER_PREFIX):-len(LOADER_SUFFIX)]
    require(len(encoded) <= 4 * ((MAX_SOURCE_BYTES + 2) // 3))
    try:
        source = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise GuardRejected() from None
    require(0 < len(source) <= MAX_SOURCE_BYTES)
    require(base64.b64encode(source).decode('ascii') == encoded)
    require(hashlib.sha256(source).hexdigest() in config['controllerSha256'])
    # Build the invocation from verified bytes, never execute the incoming shell
    # string. The interpreter receives exactly a source whose digest was allowed.
    return [PYTHON, '-I', '-B', '-c',
            LOADER_PREFIX + base64.b64encode(source).decode('ascii') + LOADER_SUFFIX,
            args[5], root, *extra]


def checked_environment(environ, config, root):
    require(not any(os.isatty(fd) for fd in (0, 1, 2)))
    require(not any(environ.get(name) for name in ('SSH_TTY', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'DISPLAY')))
    require(not any(name.startswith('SSH_') and name not in SSH_ENV and value
                    for name, value in environ.items()))
    connection = environ.get('SSH_CONNECTION', '').split()
    port = str(config['sshPort'])
    require(len(connection) == 4 and connection[0] in config['sourceIps'] and connection[3] == port)
    require(re.fullmatch(r'[0-9]{1,5}', connection[1]) and 0 < int(connection[1]) <= 65535)
    require(address(connection[2]))
    if 'SSH_CLIENT' in environ:
        require(environ['SSH_CLIENT'].split() == [connection[0], connection[1], port])
    uid = os.getuid()
    require(uid != 0 and os.geteuid() == uid)
    try:
        account = pwd.getpwuid(uid)
    except KeyError:
        raise GuardRejected() from None
    require(account.pw_name == config['user'] and account.pw_dir == config['home'])
    # No inherited locale, Python import path, dynamic loader, shell startup,
    # credential, or agent variables reach the controller.
    return {'HOME': config['home'], 'USER': config['user'], 'LOGNAME': config['user'],
            'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
            'TMPDIR': root + '/tmp', 'TMUX_TMPDIR': root + '/tmux'}


def main():
    try:
        config = load_config()
        pinned = fixed_config(sys.argv)
        if pinned is not None:
            task_root(config, pinned)
        args = verified_argv(os.environ.get('SSH_ORIGINAL_COMMAND'), config, pinned)
        environment = checked_environment(os.environ, config, args[6])
        os.execve(PYTHON, args, environment)
    except (GuardRejected, OSError, ValueError):
        # Do not reflect supplied command/source/environment or a traceback.
        sys.stderr.write('CC5_SSH_COMMAND_REJECTED\n')
        return 126
    return 126  # execve does not return on success.


if __name__ == '__main__':
    raise SystemExit(main())
