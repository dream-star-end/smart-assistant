#!/usr/bin/env python3
"""Bound one advisory command and its process group without an inherited pipe."""
import math
import os
import re
import signal
import subprocess
import sys
import tempfile
import time


def duration(value):
    match = re.fullmatch(r'(\d+(?:\.\d*)?|\.\d+)([smhd]?)', value)
    if not match:
        raise ValueError('invalid duration')
    seconds = float(match[1]) * {'': 1, 's': 1, 'm': 60, 'h': 3600, 'd': 86400}[match[2]]
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError('duration must be finite and positive')
    return seconds


def group_signal(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def exited(pid):
    # Keep the leader unreaped until group cleanup: its PGID cannot be reused.
    return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def main():
    try:
        timeout, grace = map(duration, sys.argv[1:3])
        if len(sys.argv) < 4:
            return 125
    except (ValueError, TypeError):
        return 125
    proc = None
    interrupted = False
    group_cleaned = False

    def interrupt(_signum, _frame):
        nonlocal interrupted
        interrupted = True

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    # Only this helper inherits the shell's command-substitution pipe. Descendants
    # write to an anonymous file, so no survivor can keep that pipe open.
    with tempfile.TemporaryFile() as output:
        try:
            proc = subprocess.Popen(sys.argv[3:], start_new_session=True,
                                    stdin=subprocess.DEVNULL, stdout=output,
                                    stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + timeout
            while not interrupted and not exited(proc.pid) and time.monotonic() < deadline:
                time.sleep(min(0.02, max(0, deadline - time.monotonic())))
            timed_out = interrupted or not exited(proc.pid)
            if timed_out:
                group_signal(proc.pid, signal.SIGTERM)
                kill_at = time.monotonic() + grace
                while time.monotonic() < kill_at:
                    time.sleep(min(0.02, max(0, kill_at - time.monotonic())))
            # Also clean descendants when the leader exited before the deadline.
            group_signal(proc.pid, signal.SIGKILL)
            group_cleaned = True
            code = proc.wait(timeout=1)
            if timed_out:
                return 124
            output.seek(0)
            while chunk := output.read(65536):
                sys.stdout.buffer.write(chunk)
            return code if code >= 0 else 128 - code
        except FileNotFoundError:
            return 127
        except (OSError, subprocess.TimeoutExpired):
            return 126
        finally:
            if proc is not None and not group_cleaned:
                group_signal(proc.pid, signal.SIGKILL)
                try:
                    proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass


if __name__ == '__main__':
    sys.exit(main())
