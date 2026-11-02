#!/usr/bin/env python3
"""Forced-command preparation; installing it or an authorized key is a separate action.

The administrator-owned authorized_keys command fixes --controller-sha256 and
--task-root. Never interpolate SSH_ORIGINAL_COMMAND into that command. The key
also requires from="38.55.252.217",restrict: this process can reject agent/X11/PTY
signals, but only sshd's key restrictions prevent independent forwarding channels.
Only the five Cc5SshHost runtime operations are accepted, not setup/inspection.
"""
import base64
import binascii
import hashlib
import ipaddress
import os
import pwd
import re
import shlex
import sys

SOURCE_IP = '38.55.252.217'
PYTHON = '/usr/bin/python3'
ROLES = frozenset(('launch', 'tool-socket', 'stop', 'stop-socket', 'prove-stopped'))
MAX_SOURCE_BYTES = 131072  # Same bound as Cc5SshHost's pinned controller file.
MAX_COMMAND_BYTES = 4 * ((MAX_SOURCE_BYTES + 2) // 3) + 4096
LOADER_PREFIX = "exec(compile(__import__('base64').b64decode('"
LOADER_SUFFIX = "'),'cc5-task-controller','exec'))"
ROOT = re.compile(r'/home/box/oc-agentremote-t1555u-[a-z0-9-]{16,40}\Z')
SHA256 = re.compile(r'[0-9a-f]{64}\Z')
SSH_ENV = frozenset(('SSH_ORIGINAL_COMMAND', 'SSH_CONNECTION', 'SSH_CLIENT'))


class GuardRejected(Exception):
    pass


def require(value):
    if not value:
        raise GuardRejected()


def fixed_config(argv):
    # These arguments originate only in the administrator-owned forced command,
    # never in SSH_ORIGINAL_COMMAND or a client-provided environment variable.
    require(len(argv) == 5 and argv[1] == '--controller-sha256' and argv[3] == '--task-root')
    digest, root = argv[2], argv[4]
    require(SHA256.fullmatch(digest) and ROOT.fullmatch(root))
    return digest, root


def quote(value):
    # Exact serialization used by packages/gateway/src/cc5SshHost.ts.
    return "'" + value.replace("'", "'\\''") + "'"


def verified_argv(original, digest, root):
    require(isinstance(original, str) and 0 < len(original) <= MAX_COMMAND_BYTES)
    require(not any(c in original for c in ('\0', '\r', '\n')))
    try:
        args = shlex.split(original, posix=True)
    except ValueError:
        raise GuardRejected() from None
    require(len(args) == 7 and args[:4] == [PYTHON, '-I', '-B', '-c'])
    require(args[5] in ROLES and args[6] == root)
    require(original == ' '.join(quote(arg) for arg in args))
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
    require(hashlib.sha256(source).hexdigest() == digest)
    # Build the invocation from verified bytes, never execute the incoming shell
    # string. The interpreter receives exactly the source whose digest was pinned.
    return [PYTHON, '-I', '-B', '-c',
            LOADER_PREFIX + base64.b64encode(source).decode('ascii') + LOADER_SUFFIX,
            args[5], root]


def checked_environment(environ, root):
    require(not any(os.isatty(fd) for fd in (0, 1, 2)))
    require(not any(environ.get(name) for name in ('SSH_TTY', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'DISPLAY')))
    require(not any(name.startswith('SSH_') and name not in SSH_ENV and value
                    for name, value in environ.items()))
    connection = environ.get('SSH_CONNECTION', '').split()
    require(len(connection) == 4 and connection[0] == SOURCE_IP and connection[3] == '22')
    require(re.fullmatch(r'[0-9]{1,5}', connection[1]) and 0 < int(connection[1]) <= 65535)
    try:
        ipaddress.ip_address(connection[2])
    except ValueError:
        raise GuardRejected() from None
    if 'SSH_CLIENT' in environ:
        require(environ['SSH_CLIENT'].split() == [connection[0], connection[1], '22'])
    uid = os.getuid()
    require(uid != 0 and os.geteuid() == uid)
    try:
        account = pwd.getpwuid(uid)
    except KeyError:
        raise GuardRejected() from None
    require(account.pw_name == 'box' and account.pw_dir == '/home/box')
    # No inherited locale, Python import path, dynamic loader, shell startup,
    # credential, or agent variables reach the controller.
    return {'HOME': '/home/box', 'USER': 'box', 'LOGNAME': 'box',
            'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
            'TMPDIR': root + '/tmp', 'TMUX_TMPDIR': root + '/tmux'}


def main():
    try:
        digest, root = fixed_config(sys.argv)
        environment = checked_environment(os.environ, root)
        args = verified_argv(os.environ.get('SSH_ORIGINAL_COMMAND'), digest, root)
        os.execve(PYTHON, args, environment)
    except (GuardRejected, OSError):
        # Do not reflect supplied command/source/environment or a traceback.
        sys.stderr.write('CC5_SSH_COMMAND_REJECTED\n')
        return 126
    return 126  # execve does not return on success.


if __name__ == '__main__':
    raise SystemExit(main())
