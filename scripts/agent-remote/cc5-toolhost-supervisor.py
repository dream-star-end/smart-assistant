#!/usr/bin/env python3
"""One UID-local ToolHost and its descendants; clean exit requires real ECHILD.

The command is fixed here, not supplied by an MCP/model request. No restarts.
The existing Box keeper supplies kernel child ownership and pidfd cleanup.
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time


def keeper_module():
    path = Path(__file__).resolve().parents[1] / 'ocv5-289/box_keeper.py'
    spec = importlib.util.spec_from_file_location('cc5_owned_children', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def supervise(command, proof_path, lifecycle_id):
    keeper = keeper_module()
    if not keeper.prctl(keeper.PR_SET_CHILD_SUBREAPER, 1):
        raise RuntimeError('CC5_TOOLHOST_SUBREAPER_UNAVAILABLE')
    stopping = False

    def stop(_sig, _frame):
        nonlocal stopping
        stopping = True

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    # The child inherits stdin/stdout, but is a dedicated process group. The
    # supervisor never competes for MCP stdin or writes to its stdout channel.
    child = subprocess.Popen(command, start_new_session=True)
    pidfd = os.pidfd_open(child.pid, 0)
    try:
        # waitid WNOWAIT deliberately retains our child fence until the last
        # numeric process-group signal, preventing PID/PGID reuse races.
        while not stopping:
            status = os.waitid(os.P_PIDFD, pidfd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if status is not None:
                break
            time.sleep(.02)
        if not keeper.stop_adopted_group(child.pid):
            raise RuntimeError('CC5_TOOLHOST_LEADER_EXIT_UNKNOWN')
        child.returncode = 0  # Already genuinely waited by stop_adopted_group.
        if not keeper.reap_adopted_after_last_signal():
            raise RuntimeError('CC5_TOOLHOST_DESCENDANT_EXIT_UNKNOWN')
        proof = {'version': 1, 'lifecycleId': lifecycle_id,
                 'supervisorPid': os.getpid(), 'localStopped': True}
        fd = os.open(proof_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as target:
            json.dump(proof, target, separators=(',', ':'))
            target.flush()
            os.fsync(target.fileno())
        parent = os.open(Path(proof_path).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        return 0
    finally:
        os.close(pidfd)


def main():
    if len(sys.argv) != 4 or not Path(sys.argv[1]).is_absolute():
        return 126
    node, proof_path, lifecycle_id = sys.argv[1:]
    directory = Path(proof_path).parent
    meta = directory.lstat()
    if (not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.getuid()
            or meta.st_mode & 0o077 or Path(proof_path).name != 'stopped.json'
            or len(lifecycle_id) != 36):
        return 126
    entry = Path(__file__).resolve().parents[2] / 'claude-code-best/dist/cli-node.js'
    command = [node, str(entry), 'mcp', 'serve', '--tool-allowlist', 'Read,Edit,Bash']
    return supervise(command, proof_path, lifecycle_id)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError):
        # No exception text, argv, environment or tool data on stderr.
        sys.stderr.write('CC5_TOOLHOST_STOP_OR_START_UNKNOWN\n')
        sys.exit(125)
