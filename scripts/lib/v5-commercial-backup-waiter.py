#!/usr/bin/env python3
"""Keep the body leader unreaped until its entire owned process group is stopped."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def start(pid):
    return Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]


def terminate(signum, _frame):
    raise SystemExit(128 + signum)


for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, terminate)

script, directory, parent, parent_start = sys.argv[1:]
if os.getppid() != int(parent) or start(parent) != parent_start:
    sys.exit(1)
state = Path(directory)
child = None
try:
    env = dict(os.environ, V5CB_WAITER_PID=str(os.getpid()))
    child = subprocess.Popen(
        ["bash", script, "__body", directory, str(os.getpid()), start(os.getpid()), parent, parent_start],
        start_new_session=True, pass_fds=(9,), env=env,
    )
    (state / "body.new").write_text(f"{child.pid} {start(child.pid)}\n")
    os.replace(state / "body.new", state / "body")
    # poll()/wait()/communicate() would reap the leader too early. WNOWAIT keeps
    # its PID/PGID reserved even when a killed body has surviving dump children.
    while os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
        time.sleep(0.05)
finally:
    if child is not None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        result = child.wait()
if child is not None:
    sys.exit(result if result >= 0 else 128 - result)
