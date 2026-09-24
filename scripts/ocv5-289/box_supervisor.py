#!/usr/bin/env python3
"""OCV5-289 isolated process-lifetime prototype for Box claude -p.

The adapter, not an untrusted request, must choose argv. The supervisor keeps
the upstream process group bounded even if the Exec stream is abandoned.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import re
import select
import selectors
import signal
import stat
import subprocess
import sys
import time

PR_SET_PDEATHSIG = 1
TOOL_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


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


class ToolEventPublisher:
    """Publish only one complete model tool_use before Claude exits."""

    def __init__(self, path: str):
        parent, name = os.path.split(path)
        directory = Path(parent)
        if (name != "event.json" or directory.parent != Path("/tmp")
                or not directory.name.startswith("ocv5-289-tool-")
                or os.path.realpath(parent) != parent):
            raise ValueError("TOOL_EVENT_PATH_INVALID")
        self.dir_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        info = os.fstat(self.dir_fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            os.close(self.dir_fd)
            raise ValueError("TOOL_EVENT_DIR_INVALID")
        try:
            os.stat(name, dir_fd=self.dir_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            os.close(self.dir_fd)
            raise ValueError("TOOL_EVENT_ALREADY_EXISTS")
        self.name = name
        self.line_buffer = bytearray()
        self.message_seq = 0
        self.message_open = False
        self.tool_starts = 0
        self.active: dict[tuple[int, int], dict[str, object]] = {}
        self.published = False

    def close(self) -> None:
        os.close(self.dir_fd)

    def feed(self, chunk: bytes) -> None:
        self.line_buffer.extend(chunk)
        while b"\n" in self.line_buffer:
            line, _, rest = self.line_buffer.partition(b"\n")
            self.line_buffer = bytearray(rest)
            if len(line) > 32768:
                raise ValueError("TOOL_EVENT_LINE_TOO_LARGE")
            if line.strip():
                self._record(json.loads(line))
        if len(self.line_buffer) > 32768:
            raise ValueError("TOOL_EVENT_LINE_TOO_LARGE")

    def finish(self) -> None:
        if self.line_buffer.strip():
            self._record(json.loads(self.line_buffer))
        if self.active or self.message_open:
            raise ValueError("TOOL_EVENT_INCOMPLETE")

    def _record(self, record: object) -> None:
        if not isinstance(record, dict):
            raise ValueError("TOOL_EVENT_FRAME_INVALID")
        if record.get("type") != "stream_event":
            return
        event = record.get("event")
        if not isinstance(event, dict):
            raise ValueError("TOOL_EVENT_FRAME_INVALID")
        kind = event.get("type")
        if kind == "message_start":
            if self.active or self.message_open:
                raise ValueError("TOOL_EVENT_INCOMPLETE")
            self.message_seq += 1
            self.message_open = True
            return
        if kind == "message_stop":
            if not self.message_open or self.active:
                raise ValueError("TOOL_EVENT_INCOMPLETE")
            self.message_open = False
            return
        index = event.get("index")
        if not isinstance(index, int) or index < 0:
            return  # message_delta/message_stop/ping have no block index
        if not self.message_open:
            raise ValueError("TOOL_EVENT_MESSAGE_REQUIRED")
        key = (self.message_seq, index)
        if kind == "content_block_start":
            block = event.get("content_block")
            if isinstance(block, dict) and block.get("type") == "tool_use":
                if self.tool_starts or self.published or key in self.active:
                    raise ValueError("TOOL_EVENT_DUPLICATE")
                self.tool_starts += 1
                ident, name = block.get("id"), block.get("name")
                if (not isinstance(ident, str) or not TOOL_ID.fullmatch(ident)
                        or not isinstance(name, str) or not TOOL_ID.fullmatch(name)):
                    raise ValueError("TOOL_EVENT_ID_INVALID")
                self.active[key] = {"id": ident, "name": name, "json": ""}
        elif kind == "content_block_delta":
            delta = event.get("delta")
            if isinstance(delta, dict) and delta.get("type") == "input_json_delta":
                current = self.active.get(key)
                part = delta.get("partial_json")
                if current is None or not isinstance(part, str):
                    raise ValueError("TOOL_EVENT_DELTA_INVALID")
                current["json"] = str(current["json"]) + part
                if len(str(current["json"]).encode()) > 16384:
                    raise ValueError("TOOL_EVENT_INPUT_TOO_LARGE")
        elif kind == "content_block_stop" and key in self.active:
            current = self.active.pop(key)
            payload = json.loads(str(current["json"]) or "{}")
            if not isinstance(payload, dict):
                raise ValueError("TOOL_EVENT_INPUT_INVALID")
            self._publish({"modelToolUseId": current["id"], "name": current["name"], "input": payload})

    def _publish(self, value: dict[str, object]) -> None:
        if self.published:
            raise ValueError("TOOL_EVENT_DUPLICATE")
        raw = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        tmp = f"event.{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.dir_fd)
        try:
            offset = 0
            while offset < len(raw):
                written = os.write(fd, raw[offset:])
                if written <= 0:
                    raise OSError("TOOL_EVENT_WRITE_FAILED")
                offset += written
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(tmp, self.name, src_dir_fd=self.dir_fd, dst_dir_fd=self.dir_fd, follow_symlinks=False)
            os.fsync(self.dir_fd)
        finally:
            os.unlink(tmp, dir_fd=self.dir_fd)
        self.published = True


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

    publisher = None
    if event_path := os.environ.get("OCV5_SUPERVISOR_TOOL_EVENT_FILE"):
        try:
            publisher = ToolEventPublisher(event_path)
        except (OSError, ValueError):
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
        if publisher is not None:
            publisher.close()
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
        if publisher is not None:
            publisher.close()
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
        if publisher is not None:
            publisher.close()
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
                    if publisher is not None:
                        publisher.feed(chunk)
                else:
                    stderr_bytes += len(chunk)
                if len(stdout) + stderr_bytes > args.max_output:
                    reason = 125
                    break
            if reason is not None:
                break
        if reason is None and publisher is not None:
            publisher.finish()
    except (OSError, ValueError, json.JSONDecodeError):
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
        if publisher is not None:
            publisher.close()
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
