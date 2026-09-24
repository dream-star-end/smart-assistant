#!/usr/bin/env python3
"""OCV5-289 isolated process-lifetime prototype for Box claude -p.

The adapter, not an untrusted request, must choose argv. The supervisor keeps
the upstream process group bounded even if the Exec stream is abandoned.
"""
import argparse
import ctypes
import os
import select
import selectors
import signal
import subprocess
import sys
import time

PR_SET_PDEATHSIG = 1


def kill_group(pgid: int, sig: int) -> None:
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass


def watch_parent(fd: int, ack_fd: int, pgid: int) -> int:
    # A normal parent writes D. Parent SIGKILL closes the pipe: watcher kills
    # the whole CLI group, including same-group grandchildren.
    try:
        os.write(ack_fd, b"R")
        os.close(ack_fd)
        data = os.read(fd, 1)
        if data != b"D":
            kill_group(pgid, signal.SIGKILL)
        return 0
    finally:
        os.close(fd)


def child_setup(parent_pid: int) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
        os._exit(126)
    # Parent may die between fork and prctl. Do not start Claude in that case.
    if os.getppid() != parent_pid:
        os._exit(126)


def gated_exec(fd: int, command: list[str]) -> int:
    try:
        permission = os.read(fd, 1)
    finally:
        os.close(fd)
    if permission != b"G" or not command or not os.path.isabs(command[0]):
        return 126
    os.execv(command[0], command)
    return 126


def write_before_deadline(data: bytearray, deadline: float) -> bool:
    """Never let a disconnected Exec reader stall the supervisor indefinitely."""
    fd = sys.stdout.fileno()
    original = os.get_blocking(fd)
    os.set_blocking(fd, False)
    offset = 0
    try:
        while offset < len(data):
            if time.monotonic() >= deadline:
                return False
            try:
                offset += os.write(fd, data[offset:])
            except BlockingIOError:
                select.select([], [fd], [], min(0.1, max(0, deadline - time.monotonic())))
            except BrokenPipeError:
                return False
        return True
    finally:
        try:
            os.set_blocking(fd, original)
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--deadline", type=float, required=True)
    parser.add_argument("--kill-after", type=float, default=1.0)
    parser.add_argument("--max-output", type=int, default=262144)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if (not command or not (0 < args.deadline <= 120) or not (0 < args.kill_after <= 10)
            or not (0 < args.max_output <= 1048576)):
        return 126

    parent_pid = os.getpid()
    gate_read, gate_write = os.pipe()
    watch_read, watch_write = os.pipe()
    ack_read, ack_write = os.pipe()
    try:
        child = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--gated", str(gate_read), *command],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True,
            preexec_fn=lambda: child_setup(parent_pid), close_fds=True, pass_fds=(gate_read,),
        )
    except (OSError, subprocess.SubprocessError):
        for fd in (gate_read, gate_write, watch_read, watch_write, ack_read, ack_write):
            os.close(fd)
        return 126
    os.close(gate_read)
    if child_path := os.environ.get("OCV5_SUPERVISOR_TEST_CHILD_PID_FILE"):
        with open(child_path, "w", encoding="ascii") as child_file:
            child_file.write(str(child.pid))
    if prewatch_delay := os.environ.get("OCV5_SUPERVISOR_TEST_PRE_WATCH_DELAY"):
        time.sleep(min(float(prewatch_delay), 2.0))
    watcher = None
    try:
        watcher = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--watchdog", str(watch_read), str(ack_write), str(child.pid)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True, pass_fds=(watch_read, ack_write),
        )
        os.close(watch_read)
        os.close(ack_write)
        ready, _, _ = select.select([ack_read], [], [], 2.0)
        if not ready or os.read(ack_read, 1) != b"R":
            raise RuntimeError("WATCHER_NOT_READY")
        os.close(ack_read)
        os.write(gate_write, b"G")
        os.close(gate_write)
    except (OSError, subprocess.SubprocessError):
        kill_group(child.pid, signal.SIGKILL)
        child.wait()
        for fd in (gate_write, watch_read, watch_write, ack_read, ack_write):
            try:
                os.close(fd)
            except OSError:
                pass
        if watcher is not None:
            try: watcher.wait(timeout=2)
            except subprocess.TimeoutExpired: watcher.kill(); watcher.wait()
        return 126
    except RuntimeError:
        kill_group(child.pid, signal.SIGKILL)
        child.wait()
        for fd in (gate_write, watch_read, watch_write, ack_read, ack_write):
            try: os.close(fd)
            except OSError: pass
        if watcher is not None:
            try: watcher.wait(timeout=2)
            except subprocess.TimeoutExpired: watcher.kill(); watcher.wait()
        return 126
    if ready_path := os.environ.get("OCV5_SUPERVISOR_READY_FILE"):
        with open(ready_path, "w", encoding="ascii") as ready:
            ready.write(f"{child.pid} {watcher.pid}\n")

    stopped = False

    def request_stop(_signum: int, _frame: object) -> None:
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    selector = selectors.DefaultSelector()
    assert child.stdout is not None and child.stderr is not None
    selector.register(child.stdout, selectors.EVENT_READ, "stdout")
    selector.register(child.stderr, selectors.EVENT_READ, "stderr")
    deadline = time.monotonic() + args.deadline
    stdout = bytearray()
    stderr_bytes = 0
    reason = None
    try:
        while selector.get_map():
            if stopped:
                reason = 143
                break
            if time.monotonic() >= deadline:
                reason = 124
                break
            for key, _ in selector.select(timeout=min(0.1, max(0, deadline - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if key.data == "stdout":
                    stdout.extend(chunk)
                else:
                    stderr_bytes += len(chunk)
                if len(stdout) + stderr_bytes > args.max_output:
                    reason = 125
                    break
            if reason is not None:
                break
    except (OSError, ValueError):
        reason = 125
    finally:
        selector.close()
        # Keep the group leader unreaped while signalling. Its PID/PGID cannot
        # be recycled, and descendants that closed stdio are still killed.
        kill_group(child.pid, signal.SIGTERM)
        time.sleep(min(args.kill_after, 0.1) if reason is None else args.kill_after)
        kill_group(child.pid, signal.SIGKILL)
        # D means the entire process group was already signalled. Keep the
        # leader unreaped until watcher acknowledges exit so its PGID cannot
        # be recycled during the EOF-vs-D race.
        try:
            os.write(watch_write, b"D")
        except OSError:
            pass
        os.close(watch_write)
        try:
            watcher.wait(timeout=2)
        except subprocess.TimeoutExpired:
            watcher.kill()
            watcher.wait()
        child.wait()
    if reason is not None:
        return reason
    if child.returncode == 0 and not write_before_deadline(stdout, deadline):
        return 124
    return child.returncode or 0


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "--watchdog":
        sys.exit(watch_parent(int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])))
    if len(sys.argv) >= 4 and sys.argv[1] == "--gated":
        sys.exit(gated_exec(int(sys.argv[2]), sys.argv[3:]))
    sys.exit(main())
