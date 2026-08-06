#!/usr/bin/env python3
"""SSH-session supervisor for the SCNet H3 worker.

The notebook container has no systemd and a read-only cgroup v2 mount.  This
process therefore acts as a child subreaper, consumes an explicit stdin lease,
and tears down every exact descendant before releasing its singleton lock.
"""

from __future__ import annotations

import ctypes
import errno
import fcntl
import os
import select
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


PR_SET_CHILD_SUBREAPER = 36
HEARTBEAT_TIMEOUT_SECONDS = 15
TERM_GRACE_SECONDS = 10
KILL_GRACE_SECONDS = 10
RESTART_DELAY_SECONDS = 5

STATE_ROOT = Path(os.environ.get("H3_WORKER_STATE", "/root/openclaude-h3-worker")).resolve()
WORKTREE = Path(
    os.environ.get("H3_WORKER_RELEASE", "/root/private_data/minimax-h3-v5-worker")
).resolve()
PYTHON = Path(os.environ.get("H3_SP_PYTHON", "/root/minimax-h3-runtime/venv/bin/python")).resolve()
WORKER = (WORKTREE / "scripts/minimax_h3_worker/worker.py").resolve()
OWNED_SCRIPTS = {
    str(WORKER),
    str((WORKTREE / "scripts/minimax_h3_sp/coordinator.py").resolve()),
    str((WORKTREE / "scripts/minimax_h3_sp/run_rank.py").resolve()),
    str((WORKTREE / "scripts/minimax_h3_sp/start.sh").resolve()),
    str((WORKTREE / "scripts/minimax_h3_sp/stop.sh").resolve()),
}


@dataclass(frozen=True)
class Proc:
    pid: int
    ppid: int
    starttime: int
    uid: int
    argv: tuple[str, ...]


def log(message: str) -> None:
    print(f"H3_SUPERVISOR {message}", file=sys.stderr, flush=True)


def enable_subreaper() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def read_proc(pid: int) -> Proc | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_bytes()
        end = raw.rfind(b") ")
        if end < 0:
            return None
        fields = raw[end + 2 :].split()
        if len(fields) < 20 or fields[0] in {b"Z", b"X", b"x"}:
            return None
        ppid = int(fields[1])
        starttime = int(fields[19])
        uid = os.stat(f"/proc/{pid}").st_uid
        argv = tuple(
            value.decode("utf-8", "surrogateescape")
            for value in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
            if value
        )
        return Proc(pid=pid, ppid=ppid, starttime=starttime, uid=uid, argv=argv)
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError, OSError):
        return None


def snapshot() -> dict[int, Proc]:
    result: dict[int, Proc] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        proc = read_proc(int(entry.name))
        if proc is not None:
            result[proc.pid] = proc
    return result


def descendants(procs: dict[int, Proc], roots: set[int]) -> dict[int, Proc]:
    found: dict[int, Proc] = {}
    frontier = set(roots)
    while frontier:
        children = {
            pid: proc
            for pid, proc in procs.items()
            if proc.ppid in frontier and pid not in found and pid not in roots
        }
        found.update(children)
        frontier = set(children)
    return found


def path_within_state(value: str) -> bool:
    if not value.startswith("/"):
        return False
    try:
        return os.path.commonpath((str(STATE_ROOT / "attempts"), value)) == str(
            STATE_ROOT / "attempts"
        )
    except ValueError:
        return False


def production_owned(proc: Proc) -> bool:
    if proc.uid != 0 or not proc.argv:
        return False
    executable = Path(proc.argv[0]).name
    python_scripts = OWNED_SCRIPTS - {
        str((WORKTREE / "scripts/minimax_h3_sp/start.sh").resolve()),
        str((WORKTREE / "scripts/minimax_h3_sp/stop.sh").resolve()),
    }
    shell_scripts = OWNED_SCRIPTS - python_scripts
    if executable.startswith("python") and any(value in python_scripts for value in proc.argv[1:]):
        return True
    if executable in {"bash", "sh"} and any(value in shell_scripts for value in proc.argv[1:]):
        return True
    return executable == "ffmpeg" and any(path_within_state(value) for value in proc.argv[1:])


def exact_signal(proc: Proc, sig: signal.Signals) -> None:
    current = read_proc(proc.pid)
    if current is None or current.starttime != proc.starttime:
        return
    try:
        os.kill(proc.pid, sig)
    except ProcessLookupError:
        pass


def reap_children() -> None:
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def cleanup_processes(*, include_owned_orphans: bool) -> None:
    phase_started = time.monotonic()
    sig = signal.SIGTERM
    empty_samples = 0
    while True:
        reap_children()
        procs = snapshot()
        roots = {os.getpid()}
        if include_owned_orphans:
            roots.update(pid for pid, proc in procs.items() if production_owned(proc))
        targets = descendants(procs, roots)
        if include_owned_orphans:
            targets.update(
                (pid, proc) for pid, proc in procs.items() if production_owned(proc)
            )
        targets.pop(os.getpid(), None)
        if not targets:
            empty_samples += 1
            if empty_samples >= 3:
                return
        else:
            empty_samples = 0
            for proc in sorted(targets.values(), key=lambda item: item.pid, reverse=True):
                exact_signal(proc, sig)

        elapsed = time.monotonic() - phase_started
        if sig == signal.SIGTERM and elapsed >= TERM_GRACE_SECONDS:
            sig = signal.SIGKILL
            phase_started = time.monotonic()
        elif sig == signal.SIGKILL and elapsed >= KILL_GRACE_SECONDS:
            identities = ",".join(
                f"{proc.pid}:{proc.starttime}" for proc in sorted(targets.values(), key=lambda item: item.pid)
            )
            raise RuntimeError(f"H3 descendants survived SIGKILL: {identities}")
        time.sleep(0.2)


def secure_state_and_lock() -> int:
    STATE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = STATE_ROOT.stat()
    if info.st_uid != 0 or info.st_gid != 0:
        raise RuntimeError(f"unsafe state ownership or mode: {STATE_ROOT}")
    os.chmod(STATE_ROOT, 0o700)
    info = STATE_ROOT.stat()
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError(f"unable to seal state directory mode: {STATE_ROOT}")
    lock_path = STATE_ROOT / "session-supervisor.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
    os.fchmod(fd, 0o600)
    os.fchown(fd, 0, 0)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise RuntimeError("another H3 SSH session supervisor is active")
    return fd


def start_worker() -> subprocess.Popen[bytes]:
    if os.geteuid() != 0:
        raise RuntimeError("H3 worker supervisor must run as root")
    if not PYTHON.is_file() or not WORKER.is_file():
        raise RuntimeError("H3 worker Python or worker.py is missing")
    worker_env = os.environ.copy()
    worker_env["H3_SESSION_SUPERVISOR_PID"] = str(os.getpid())
    process = subprocess.Popen(
        [str(PYTHON), str(WORKER)],
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
        env=worker_env,
    )
    proc = read_proc(process.pid)
    if proc is None:
        raise RuntimeError("H3 worker exited during spawn")
    log(f"worker_started pid={proc.pid} starttime={proc.starttime}")
    return process


def main() -> int:
    if not os.environ.get("SSH_CONNECTION"):
        raise RuntimeError("supervisor requires a forced SSH session")
    enable_subreaper()
    lock_fd = secure_state_and_lock()
    stopping = False
    deadline = time.monotonic() + HEARTBEAT_TIMEOUT_SECONDS
    activity_seq = 0
    latest_activity_at = 0.0

    def request_stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    def worker_activity(_signum: int, _frame: object) -> None:
        nonlocal activity_seq, latest_activity_at
        activity_seq += 1
        latest_activity_at = time.monotonic()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGHUP, request_stop)
    signal.signal(signal.SIGUSR1, worker_activity)

    worker: subprocess.Popen[bytes] | None = None
    next_start_at = 0.0
    consumed_activity_seq = 0
    heartbeat_reads = 0
    heartbeat_bytes = 0
    last_heartbeat_at: float | None = None
    max_heartbeat_gap = 0.0
    poller = select.poll()
    poller.register(0, select.POLLIN | select.POLLHUP | select.POLLERR)
    try:
        cleanup_processes(include_owned_orphans=True)
        while not stopping:
            if activity_seq != consumed_activity_seq:
                observed_seq = activity_seq
                observed_at = latest_activity_at
                deadline = max(deadline, observed_at + HEARTBEAT_TIMEOUT_SECONDS)
                if consumed_activity_seq == 0:
                    log(f"worker_activity_received signals={observed_seq}")
                consumed_activity_seq = observed_seq

            now = time.monotonic()
            if worker is None and now >= next_start_at:
                worker = start_worker()
            if worker is not None and worker.poll() is not None:
                log(f"worker_exited rc={worker.returncode}; cleaning descendants before restart")
                worker = None
                cleanup_processes(include_owned_orphans=False)
                next_start_at = time.monotonic() + RESTART_DELAY_SECONDS

            if time.monotonic() >= deadline:
                log("heartbeat_timeout")
                stopping = True
                break
            events = poller.poll(1000)
            for _, event in events:
                if event & (select.POLLHUP | select.POLLERR):
                    stopping = True
                    break
                if event & select.POLLIN:
                    try:
                        payload = os.read(0, 4096)
                    except OSError as exc:
                        if exc.errno == errno.EINTR:
                            continue
                        raise
                    if not payload:
                        stopping = True
                        break
                    received_at = time.monotonic()
                    heartbeat_reads += 1
                    heartbeat_bytes += len(payload)
                    if last_heartbeat_at is None:
                        log(f"heartbeat_received reads=1 bytes={heartbeat_bytes}")
                    else:
                        gap = received_at - last_heartbeat_at
                        max_heartbeat_gap = max(max_heartbeat_gap, gap)
                        if heartbeat_reads % 12 == 0:
                            log(
                                f"heartbeat_received reads={heartbeat_reads} bytes={heartbeat_bytes} "
                                f"gap={gap:.3f}s max_gap={max_heartbeat_gap:.3f}s"
                            )
                    last_heartbeat_at = received_at
                    deadline = received_at + HEARTBEAT_TIMEOUT_SECONDS
        return 0
    finally:
        cleanup_processes(include_owned_orphans=False)
        os.close(lock_fd)
        log("session_stopped descendants=0")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BaseException as exc:
        log(f"fatal={type(exc).__name__}:{exc}")
        raise
