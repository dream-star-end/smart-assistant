#!/usr/bin/env python3
"""Selfhost admission estimator; userspace samples are not exact kernel attribution.

Linux folds per-CPU R/D counts about every five seconds. We sample threads once
per second over the same 60-second window, retain external history and floor
admission by current external demand. Any unavailable evidence grants no credit.
"""

import argparse
import json
import math
import os
from pathlib import Path
import signal
import sys
import time

INTERVAL = 1.0
STALE_AFTER = 3.0


class InvalidSample(ValueError):
    pass


def proc_stat(path):
    text = Path(path).read_text()
    end = text.rfind(")")
    fields = text[end + 2:].split()
    pid = int(text[:text.index(" (")])
    if end < 0 or len(fields) < 20 or len(fields[0]) != 1:
        raise InvalidSample("malformed proc stat")
    return pid, int(fields[1]), int(fields[19]), fields[0]


def identity(proc, pid):
    row = proc_stat(proc / str(pid) / "stat")
    if row[0] != pid or row[3] in ("Z", "X"):
        raise InvalidSample("process identity unavailable")
    return row[2]


def boot_id(proc):
    value = (proc / "sys/kernel/random/boot_id").read_text().strip()
    if not value:
        raise InvalidSample("boot identity unavailable")
    return value


def finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidSample("invalid numeric sample")
    if not math.isfinite(value) or value < 0:
        raise InvalidSample("invalid numeric sample")
    return value


def raw_load(path):
    return finite(float(Path(path).read_text().split()[0]))


class ProcessTree:
    def __init__(self, proc, root_pid, root_start, boot, observer_pid=None):
        self.proc = Path(proc)
        self.root = (root_pid, root_start)
        self.boot = boot
        self.owned = {self.root}
        self.observer_pid = observer_pid

    def validate(self):
        if boot_id(self.proc) != self.boot or identity(self.proc, self.root[0]) != self.root[1]:
            raise InvalidSample("train root identity changed")

    def sample(self):
        self.validate()
        rows = {}
        for directory in self.proc.iterdir():
            if not directory.name.isdecimal():
                continue
            try:
                pid, parent, start, _ = proc_stat(directory / "stat")
                if pid != int(directory.name):
                    raise InvalidSample("proc PID mismatch")
                active = 0
                for task in (directory / "task").iterdir():
                    if not task.name.isdecimal():
                        continue
                    try:
                        thread = proc_stat(task / "stat")
                        if thread[0] != int(task.name):
                            raise InvalidSample("thread PID mismatch")
                        active += thread[3] in ("R", "D")
                    except FileNotFoundError:
                        pass  # A thread that exited during the scan cannot remain runnable.
                if proc_stat(directory / "stat")[:3] != (pid, parent, start):
                    raise InvalidSample("process identity/parent changed during scan")
                rows[pid] = (parent, start, active)
            except FileNotFoundError:
                pass  # Process exit races are normal; other read failures invalidate the scan.
        self.validate()
        if self.root[0] not in rows or rows[self.root[0]][1] != self.root[1]:
            raise InvalidSample("root absent from process scan")
        # Keep observed survivors owned after reparenting, but never across PID reuse.
        owned = {key for key in self.owned if key[0] in rows and rows[key[0]][1] == key[1]}
        while True:
            children = {(pid, row[1]) for pid, row in rows.items()
                        if row[0] in rows and (row[0], rows[row[0]][1]) in owned}
            added = children - owned
            if not added:
                break
            owned.update(added)
        self.owned = owned
        # The observer always sees itself runnable during a scan. Granting credit
        # for that snapshot bias would manufacture about one unit of own load.
        own = sum(row[2] for pid, row in rows.items()
                  if (pid, row[1]) in owned and pid != self.observer_pid)
        external = sum(row[2] for pid, row in rows.items() if (pid, row[1]) not in owned)
        return own, external


class Estimate:
    def __init__(self, raw, now):
        self.own = 0.0
        self.external = finite(raw)  # No pre-existing history is attributed to this train.
        self.at = finite(now)

    def update(self, own, external, now):
        dt = finite(now) - self.at
        if not 0 < dt <= STALE_AFTER:
            raise InvalidSample("sample clock/gap invalid")
        decay = math.exp(-dt / 60.0)
        self.own = decay * self.own + (1 - decay) * finite(own)
        self.external = decay * self.external + (1 - decay) * finite(external)
        self.at = now


def effective_load(raw, own, external, current_external):
    raw, own, external, current_external = map(finite, (raw, own, external, current_external))
    return max(raw - min(raw, own), external, current_external)


def write_state(path, state):
    temporary = path.with_name("snapshot.tmp")
    temporary.write_text(json.dumps(state, separators=(",", ":")))
    os.replace(temporary, path)


def read_budget(proc, root_pid, root_start, boot, path, raw, now=None):
    tree = ProcessTree(proc, root_pid, root_start, boot)
    tree.validate()
    state = json.loads(Path(path).read_text())
    if state["schema"] != 1 or state["rootPid"] != root_pid or state["rootStart"] != root_start or state["boot"] != boot:
        raise InvalidSample("snapshot identity differs")
    elapsed = (time.monotonic() if now is None else now) - finite(state["at"])
    if not 0 <= elapsed <= STALE_AFTER:
        raise InvalidSample("snapshot stale")
    if identity(Path(proc), state["samplerPid"]) != state["samplerStart"]:
        raise InvalidSample("sampler identity differs")
    result = effective_load(raw, state["own"], state["external"], state["externalNow"])
    tree.validate()
    return result


def run_sampler(args):
    # The sampler must never keep a deploy/artifact flock alive after owner loss.
    for fd in os.listdir("/proc/self/fd"):
        if int(fd) > 2:
            try:
                os.close(int(fd))
            except OSError:
                pass
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    tree = ProcessTree(args.proc, args.root_pid, args.root_start, args.boot, os.getpid())
    sampler_start = identity(args.proc, os.getpid())
    estimate = None
    while True:
        try:
            tree.validate()
        except (OSError, ValueError):
            return
        try:
            raw = raw_load(args.loadavg)
            own, external = tree.sample()
            now = time.monotonic()
            if estimate is None:
                estimate = Estimate(raw, now)
            else:
                estimate.update(own, external, now)
            write_state(args.state, {"schema": 1, "rootPid": args.root_pid,
                        "rootStart": args.root_start, "boot": args.boot,
                        "samplerPid": os.getpid(), "samplerStart": sampler_start,
                        "at": now, "own": estimate.own, "external": estimate.external,
                        "externalNow": external})
        except (OSError, ValueError, IndexError):
            # Never extend credit through a failed scan or a stopped sampler.
            args.state.unlink(missing_ok=True)
            estimate = None
        time.sleep(INTERVAL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("identity", "run", "read", "alive"))
    parser.add_argument("--proc", type=Path, default=Path("/proc"))
    parser.add_argument("--root-pid", type=int, required=True)
    parser.add_argument("--root-start", type=int)
    parser.add_argument("--boot")
    parser.add_argument("--loadavg", type=Path)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--raw", type=float)
    args = parser.parse_args()
    try:
        if args.action == "identity":
            print(identity(args.proc, args.root_pid), boot_id(args.proc))
        elif args.action == "alive":
            ProcessTree(args.proc, args.root_pid, args.root_start, args.boot).validate()
        elif args.action == "run":
            run_sampler(args)
        else:
            print(format(read_budget(args.proc, args.root_pid, args.root_start,
                                     args.boot, args.state, args.raw), ".6f"), end="")
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
