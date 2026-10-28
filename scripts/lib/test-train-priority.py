#!/usr/bin/env python3
"""Read-only selfhost test admission; never initialize the lease database.

The train/lease predicates match v5-lease-lib.sh's open-train index and granted
lease state. Registered rides are pending intent, not an executing train.
"""

import os
from contextlib import closing
from pathlib import Path
import sqlite3
import stat
import sys

DEFAULT_DB = "/var/lib/openclaude-v5-selfhost/lease.db"
DEFAULT_LOCK = "/run/openclaude-v5-selfhost/deploy.lock"
RETRY = "先运行 wait-for-trains.sh --self <会话名>，待 FREE 后重试。"


def local_file(path, explicit):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        if explicit:
            raise
        return None  # Ordinary CI/developer machines have no selfhost state.
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("state path must be a regular file")
    return info


def read_state():
    path = os.environ.get("OC_V5_LEASE_DB") or DEFAULT_DB
    if local_file(path, bool(os.environ.get("OC_V5_LEASE_DB"))) is None:
        return [], []
    # mode=ro refuses missing files; BEGIN keeps both reads in one snapshot.
    with closing(sqlite3.connect(Path(path).absolute().as_uri() + "?mode=ro", uri=True,
                                 timeout=5)) as db:
        db.execute("BEGIN")
        trains = db.execute("""
            SELECT id, status, executor_pid FROM train
            WHERE resource='deploy:selfhost' AND status NOT IN ('committed','failed')
        """).fetchall()
        grants = db.execute("""
            SELECT id FROM lease WHERE resource='deploy:selfhost' AND status='granted'
        """).fetchall()
    return trains, grants


def proc_identity(pid):
    text = Path(f"/proc/{pid}/stat").read_text()
    fields = text[text.rfind(")") + 2:].split()
    return int(fields[1]), fields[19]  # ppid, starttime (PID reuse fence)


def owns_train(trains, grants, lock_info):
    """Prove ancestry AND the executor's actual inherited exclusive flock.

    The callback proof scrubs env and detaches its child, but retains ancestry.
    Never trust HELD/train-id/owner environment claims or acquire/unlock fd 8.
    fdinfo records the OFD lock even when the worker originally acquired it.
    """
    if len(trains) != 1 or grants or lock_info is None:
        return False
    _, status, executor = trains[0]
    if status not in ("building", "cutover") or not isinstance(executor, int) or executor <= 1:
        return False
    try:
        ancestors = {}
        pid = os.getppid()
        while pid > 1 and pid not in ancestors:
            parent, started = proc_identity(pid)
            ancestors[pid] = started
            pid = parent
        if executor not in ancestors:
            return False
        fd = os.stat(f"/proc/{executor}/fd/8")
        if (fd.st_dev, fd.st_ino) != (lock_info.st_dev, lock_info.st_ino):
            return False
        for line in Path(f"/proc/{executor}/fdinfo/8").read_text().splitlines():
            fields = line.split()
            if (len(fields) == 9 and fields[0] == "lock:"
                    and fields[2:5] == ["FLOCK", "ADVISORY", "WRITE"]
                    and fields[6].rsplit(":", 1)[-1] == str(fd.st_ino)
                    and fields[7:] == ["0", "EOF"]):
                return proc_identity(executor)[1] == ancestors[executor]
    except (OSError, ValueError, IndexError):
        pass
    return False


def main():
    require_owner = sys.argv[1:] == ["--require-train-owner"]
    if sys.argv[1:] and not require_owner:
        return 2
    try:
        lock = os.environ.get("OC_V5_SELFHOST_DEPLOY_LOCK") or DEFAULT_LOCK
        lock_info = local_file(lock, bool(os.environ.get("OC_V5_SELFHOST_DEPLOY_LOCK")))
        trains, grants = read_state()
        if require_owner and owns_train(trains, grants, lock_info):
            return 0
        if require_owner or trains or grants:
            reason = (f"train={trains[0][0]}({trains[0][1]})" if trains else
                      f"lease={grants[0][0]}(granted)" if grants else "deploy.lock 被占用")
            print(f"[test-mutex] deploy:selfhost 优先，拒绝新测试：{reason}。{RETRY}", file=sys.stderr)
            return 75
        return 0
    except (OSError, sqlite3.Error, ValueError) as error:
        # Never dump env, SQL rows, credentials or production connection strings.
        print(f"[test-mutex] 无法确认 selfhost 列车状态 ({type(error).__name__})，"
              f"拒绝新测试。核查 lease DB / deploy.lock 后，{RETRY}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
