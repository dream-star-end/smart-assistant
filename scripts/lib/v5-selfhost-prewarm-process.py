#!/usr/bin/env python3
"""Own one selfhost canary prewarm, including detached browser descendants."""
import ctypes
import os
from pathlib import Path
import signal
import sys
import time

GRACE_SECONDS = 5.0


def children():
    return [int(pid) for pid in Path(
        f"/proc/self/task/{os.getpid()}/children"
    ).read_text().split()]


def stop_child(pid, parent):
    # Pin before checking ownership: never signal an unrelated reused PID.
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        stat = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if pid != os.getpid() and int(stat[1]) == parent:
            signal.pidfd_send_signal(fd, signal.SIGTERM)
    except (FileNotFoundError, ProcessLookupError):
        pass
    finally:
        os.close(fd)


def supervise(parent, command):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "cannot own prewarm descendants")
    stopped = 0

    def cancel(signum, _frame):
        nonlocal stopped
        if stopped == 0:
            stopped = 128 + signum

    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, cancel)
    # Bind to the caller's identity, including parent loss during startup.
    if os.getppid() != parent or stopped:
        return stopped or 143
    leader = os.fork()
    if leader == 0:
        for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, signal.SIG_DFL)
        try:
            os.execvp(command[0], command)
        except OSError:
            os._exit(127)
    result = None
    closing_at = None
    terminated = set()
    while True:
        if os.getppid() != parent and stopped == 0:
            stopped = 143
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                pid = 0
            if pid == 0:
                break
            terminated.discard(pid)
            if pid == leader:
                code = os.waitstatus_to_exitcode(status)
                result = code if code >= 0 else 128 - code
        if stopped or result is not None:
            if closing_at is None:
                closing_at = time.monotonic()
            pending = children()
            if not pending:
                return stopped or result or 0
            force = time.monotonic() - closing_at >= GRACE_SECONDS
            for pid in pending:
                if force or pid not in terminated:
                    # Unreaped direct children cannot have their PIDs reused.
                    # Orphaned descendants become ours on the next iteration.
                    try:
                        os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    terminated.add(pid)
        time.sleep(0.02)


if __name__ == "__main__":
    if sys.argv[1] == "--stop":
        stop_child(int(sys.argv[2]), int(sys.argv[3]))
    else:
        sys.exit(supervise(int(sys.argv[1]), sys.argv[2:]))
