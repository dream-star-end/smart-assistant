#!/usr/bin/env python3
"""Ancestor subreaper for the Box Claude supervisor (offline prototype).

P=keeper is the initial Exec process, W=stdout supervisor worker, C=Claude CLI.
If W disappears, P adopts C before it is reaped and may safely signal C's
numeric process group. No terminal proof is published by this prototype.
"""
import ctypes
import errno
import hashlib
import os
import re
import select
import signal
import stat
import subprocess
import sys
import time

PR_SET_PDEATHSIG = 1
PR_SET_CHILD_SUBREAPER = 36
SUPERVISOR_PATH = re.compile(r"^/tmp/ocv5-289-supervisor-([a-f0-9]{16})\.py$")


def verify_supervisor(path: str) -> bool:
    match = SUPERVISOR_PATH.fullmatch(path)
    if not match or os.path.realpath(path) != path:
        return False
    try:
        info = os.lstat(path)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size < 1
                or info.st_size > 32768):
            return False
        with open(path, "rb") as source:
            return hashlib.sha256(source.read()).hexdigest().startswith(match[1])
    except OSError:
        return False


def prctl(option: int, value: int) -> bool:
    libc = ctypes.CDLL(None, use_errno=True)
    return libc.prctl(option, value, 0, 0, 0) == 0


def worker_setup(keeper_pid: int) -> None:
    if not prctl(PR_SET_PDEATHSIG, signal.SIGKILL) or os.getppid() != keeper_pid:
        os._exit(126)


def adopted_unreaped(pid: int) -> bool:
    """True only if pid is now our child, alive or zombie, and not reaped."""
    try:
        os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        return True
    except ChildProcessError:
        return False
    except OSError as error:
        if error.errno == errno.ECHILD:
            return False
        raise


def stop_adopted_group(pid: int) -> bool:
    """Never use numeric PGID unless adoption keeps the leader unreaped."""
    if not adopted_unreaped(pid):
        return False
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            pass
        if sig == signal.SIGTERM:
            time.sleep(.1)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            got, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return False
        if got == pid:
            return True
        time.sleep(.02)
    return False


def read_report(fd: int, worker: subprocess.Popen, deadline: float) -> int | None:
    raw = b""
    while time.monotonic() < deadline and len(raw) <= 32:
        if worker.poll() is not None:
            return None
        ready, _, _ = select.select([fd], [], [], min(.1, deadline - time.monotonic()))
        if not ready:
            continue
        part = os.read(fd, 32 - len(raw) + 1)
        if not part:
            return None
        raw += part
        if b"\n" in raw:
            if not re.fullmatch(rb"[1-9][0-9]{0,9}\n", raw):
                return None
            return int(raw[:-1])
    return None


def main() -> int:
    if len(sys.argv) < 3 or not verify_supervisor(sys.argv[1]):
        return 126
    # WEXITED/WAITER identity requires zombies to remain waitable; never ignore
    # SIGCHLD or allow an asynchronous handler to reap children under us.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    if not prctl(PR_SET_CHILD_SUBREAPER, 1):
        return 126
    report_read, report_write = os.pipe()
    ack_read, ack_write = os.pipe()
    keeper_pid = os.getpid()
    env = { **os.environ, "OCV5_KEEPER_REPORT_FD": str(report_write),
        "OCV5_KEEPER_ACK_FD": str(ack_read) }
    try:
        worker = subprocess.Popen([sys.executable, sys.argv[1], *sys.argv[2:]],
            env=env, stdin=subprocess.DEVNULL, stdout=None, stderr=None,
            pass_fds=(report_write, ack_read), close_fds=True,
            preexec_fn=lambda: worker_setup(keeper_pid))
    except (OSError, subprocess.SubprocessError):
        for fd in (report_read, report_write, ack_read, ack_write):
            os.close(fd)
        return 126
    os.close(report_write)
    os.close(ack_read)
    # P must not hold model stdout/stderr open after W exits; reports use pipes.
    for stream_fd in (1, 2):
        try: os.close(stream_fd)
        except OSError: pass
    stopping = False

    def request_stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True
        try: worker.terminate()
        except ProcessLookupError: pass

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    cli_pid = None
    pidfd = None
    try:
        cli_pid = read_report(report_read, worker, time.monotonic() + 5)
        if cli_pid is None or stopping:
            worker.terminate()
        else:
            # W still owns unreaped C and waits for this ACK before opening its
            # existing execution gate. Opening pidfd here binds report identity.
            try:
                pidfd = os.pidfd_open(cli_pid, 0)
                if os.getpgid(cli_pid) != cli_pid:
                    raise OSError(errno.EINVAL, "CLI is not process-group leader")
                os.write(ack_write, b"K")
            except OSError:
                worker.terminate()
        os.close(ack_write)
        ack_write = -1
        try:
            worker.wait(timeout=140)
        except subprocess.TimeoutExpired:
            worker.terminate()
            try: worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                worker.kill(); worker.wait(timeout=5)
        code = worker.returncode
        if cli_pid is not None and adopted_unreaped(cli_pid):
            # W exited without reaping C. P is now its unique subreaper owner;
            # keep C unreaped until the final group signal has completed.
            stopped = stop_adopted_group(cli_pid)
            code = 125 if not stopped or code == 0 else code
        if cli_pid is None or pidfd is None:
            return 126
        return (128 - code) if code is not None and code < 0 else (code or 0)
    finally:
        os.close(report_read)
        if ack_write >= 0:
            os.close(ack_write)
        if pidfd is not None:
            os.close(pidfd)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError):
        sys.exit(126)
