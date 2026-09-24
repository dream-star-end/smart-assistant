#!/usr/bin/env python3
"""Ancestor subreaper for the Box Claude supervisor (offline prototype).

P=keeper is the initial Exec process, W=stdout supervisor worker, C=Claude CLI.
If W disappears, P adopts C before it is reaped and may safely signal C's
numeric process group. No terminal proof is published by this prototype.
"""
import ctypes
import errno
import hashlib
import json
import math
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
PROOF_DIR = re.compile(r"^/tmp/ocv5-289-proof-([a-f0-9]{24})$")
EPOCH = re.compile(r"^[a-f0-9]{32}$")


def extract_proof_args(argv: list[str]) -> tuple[list[str], str | None, str | None]:
    """Keep proof options out of the worker's strict supervisor argv."""
    args = list(argv)
    separator = args.index("--") if "--" in args else len(args)
    proof_dir = epoch = None
    for option in ("--proof-dir", "--lease-epoch"):
        found = [i for i in range(separator) if args[i] == option]
        if len(found) > 1 or (found and found[0] + 1 >= separator):
            raise ValueError("PROOF_ARGS_INVALID")
        if found:
            index = found[0]
            value = args[index + 1]
            if option == "--proof-dir": proof_dir = value
            else: epoch = value
            del args[index:index + 2]
            separator -= 2
    if (proof_dir is None) != (epoch is None):
        raise ValueError("PROOF_ARGS_INVALID")
    if proof_dir is not None and (not PROOF_DIR.fullmatch(proof_dir)
            or not EPOCH.fullmatch(epoch or "")):
        raise ValueError("PROOF_ARGS_INVALID")
    return args, proof_dir, epoch


def publish_terminal(proof_dir: str, epoch: str, cli_pid: int, reason: str) -> None:
    """Publish only after the keeper has reaped every adopted descendant."""
    info = os.lstat(proof_dir)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError("PROOF_DIR_INVALID")
    name = "terminal.json"
    directory = os.open(proof_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        content = (json.dumps({"runNonce": PROOF_DIR.fullmatch(proof_dir)[1],
            "leaseEpoch": epoch, "keeperPid": os.getpid(), "cliPid": cli_pid,
            "reason": reason, "revision": 1}, sort_keys=True,
            separators=(",", ":")) + "\n").encode("ascii")
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600, dir_fd=directory)
        try:
            written = 0
            while written < len(content):
                written += os.write(fd, content[written:])
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(directory)
    finally:
        os.close(directory)


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


def reap_adopted_after_last_signal() -> bool:
    """Bounded cleanup only *after* the CLI leader can no longer be signalled."""
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        try:
            child_pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if child_pid == 0:
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


def startup_budget(argv: list[str]) -> float:
    options = argv[:argv.index("--")] if "--" in argv else argv
    raw = None
    for index, token in enumerate(options):
        if token == "--deadline":
            raw = options[index + 1] if index + 1 < len(options) else None
        elif token.startswith("--deadline="):
            raw = token.split("=", 1)[1]
    try:
        value = float(raw)
        if math.isfinite(value) and 0 < value <= 120:
            return min(5.0, value)
    except (TypeError, ValueError):
        pass
    return 5.0


def main() -> int:
    keeper_started = time.monotonic()
    if len(sys.argv) < 3 or not verify_supervisor(sys.argv[1]):
        return 126
    try:
        worker_args, proof_dir, epoch = extract_proof_args(sys.argv[2:])
        if proof_dir is not None:
            os.mkdir(proof_dir, 0o700)
    except (OSError, ValueError):
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
        worker = subprocess.Popen([sys.executable, sys.argv[1], *worker_args],
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
        startup_until = keeper_started + startup_budget(worker_args)
        cli_pid = read_report(report_read, worker, startup_until)
        if cli_pid is None or stopping:
            try: worker.terminate()
            except ProcessLookupError: pass
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
        adopted_stopped = False
        if cli_pid is not None and adopted_unreaped(cli_pid):
            # W exited without reaping C. P is now its unique subreaper owner;
            # keep C unreaped until the final group signal has completed.
            stopped = stop_adopted_group(cli_pid)
            adopted_stopped = stopped
            code = 125 if not stopped or code == 0 else code
        all_reaped = reap_adopted_after_last_signal()
        if not all_reaped:
            code = 125
        if cli_pid is None or pidfd is None:
            return 124 if time.monotonic() >= startup_until else 126
        if proof_dir is not None and all_reaped and (worker.returncode == 0 or adopted_stopped):
            try:
                publish_terminal(proof_dir, epoch, cli_pid,
                    "worker_complete" if worker.returncode == 0 else "keeper_stopped")
            except (OSError, ValueError):
                # The marker is mandatory once requested: no success without
                # durable terminal evidence, even though the CLI may be gone.
                return 125
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
