#!/usr/bin/env python3
"""Bounded, read-only Linux host/cgroup sampler; no control-plane actions."""
import argparse
import datetime as dt
import heapq
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid

MEMINFO = frozenset("MemTotal MemFree MemAvailable Buffers Cached SwapCached Active Inactive Active(anon) Inactive(anon) Active(file) Inactive(file) Unevictable Mlocked SwapTotal SwapFree Dirty Writeback AnonPages Mapped Shmem Slab SReclaimable SUnreclaim KernelStack PageTables CommitLimit Committed_AS".split())
VMSTAT = frozenset("oom_kill pgfault pgmajfault pswpin pswpout pgscan_kswapd pgscan_direct pgsteal_kswapd pgsteal_direct allocstall_dma allocstall_dma32 allocstall_normal allocstall_movable compact_stall compact_fail compact_success".split())
EVENTS = frozenset("low high max oom oom_kill oom_group_kill".split())
SWAP_EVENTS = frozenset("high max fail".split())
MEMORY_STAT_COUNTERS = frozenset("workingset_refault_anon workingset_refault_file workingset_activate_anon workingset_activate_file workingset_restore_anon workingset_restore_file workingset_nodereclaim pgfault pgmajfault pgrefill pgscan pgsteal pgactivate pgdeactivate pglazyfree pglazyfreed thp_fault_alloc thp_collapse_alloc".split())
MEMORY_STAT = MEMORY_STAT_COUNTERS | frozenset("anon file kernel kernel_stack pagetables sec_pagetables percpu sock vmalloc shmem zswap zswapped file_mapped file_dirty file_writeback swapcached anon_thp file_thp shmem_thp inactive_anon active_anon inactive_file active_file unevictable slab_reclaimable slab_unreclaimable slab".split())
TRAIN = re.compile(r"oc-v5-lease-train-[A-Za-z0-9_.:@-]{1,180}\.service\Z")
LOG_NAME = re.compile(r"host-memory-(\d{8}T\d{6}Z)-[0-9a-f]{12}\.jsonl\Z")
DEFAULT_LOG_DIR = "/var/log/openclaude-v5-selfhost/host-memory"


def utc(timestamp):
    return dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).isoformat()


def record_bytes(record, limit=65536):
    """Bound serialization too: never emit an oversized payload or exception text."""
    parts, size = [], 1
    try:
        for piece in json.JSONEncoder(separators=(",", ":"), allow_nan=False).iterencode(record):
            raw = piece.encode("utf-8")
            size += len(raw)
            if size > limit:
                raise OverflowError
            parts.append(raw)
        return b"".join(parts) + b"\n"
    except Exception as exc:
        name = "RecordTooLarge" if isinstance(exc, OverflowError) else type(exc).__name__
        return (json.dumps({"schema": 1, "error": {"type": name, "metric": "record"}},
                           separators=(",", ":")) + "\n").encode()


class Sampler:
    def __init__(self, root=Path("/"), clock=time, max_pids=512,
                 max_dirs=256, max_trains=24, scan_seconds=2.0):
        self.root, self.clock = Path(root), clock
        self.max_pids, self.max_dirs, self.max_trains = max_pids, max_dirs, max_trains
        self.scan_seconds = scan_seconds
        self.previous = {}
        self.threshold_since = {}
        self.last_boot = None
        self.last_monotonic = None
        self.known_trains = set()
        self.discovery_cache = self.process_cache = None
        self.discovery_attempt = self.process_attempt = None
        self.errors = []
        self.error_count = 0
        self.page_size = os.sysconf("SC_PAGE_SIZE")

    def error(self, metric, kind):
        self.error_count += 1
        if len(self.errors) < 48:
            self.errors.append({"metric": metric, "type": kind})

    def read(self, path, metric, limit=8192):
        try:
            with open(path, "rb") as stream:
                value = stream.read(limit + 1)
            if len(value) > limit:
                raise OverflowError
            return value.decode("ascii")
        except Exception as exc:
            self.error(metric, type(exc).__name__)
            return None

    def number(self, path, metric, allow_max=False):
        value = self.read(path, metric, 128)
        if value is None:
            return None
        value = value.strip()
        if allow_max and value == "max":
            return "max"
        if not value.isdigit() or len(value) > 24:
            self.error(metric, "InvalidNumber")
            return None
        return int(value)

    def numbers(self, path, allowed, metric):
        raw = self.read(path, metric)
        if raw is None:
            return None
        result = {}
        for line in raw.splitlines():
            columns = line.replace(":", " ", 1).split()
            if len(columns) >= 2 and columns[0] in allowed:
                if columns[1].isdigit() and len(columns[1]) <= 24:
                    result[columns[0]] = int(columns[1])
                else:
                    self.error(metric, "InvalidNumber")
        return result

    def pressure(self, path, metric):
        raw = self.read(path, metric, 2048)
        if raw is None:
            return None
        result = {}
        for line in raw.splitlines():
            columns = line.split()
            if not columns or columns[0] not in ("some", "full"):
                continue
            values = {}
            for item in columns[1:]:
                key, sep, value = item.partition("=")
                if not sep or key not in ("avg10", "avg60", "avg300", "total"):
                    continue
                pattern = r"\d{1,24}" if key == "total" else r"\d{1,24}(?:\.\d{1,8})?"
                if re.fullmatch(pattern, value):
                    values[key] = int(value) if key == "total" else float(value)
                else:
                    self.error(metric, "InvalidNumber")
            result[columns[0]] = values
        return result

    def delta(self, label, identity, counters):
        old_identity, old = self.previous.get(label, (None, {}))
        valid = identity is not None and old_identity == identity
        result, resets = {}, []
        for key, value in counters.items():
            before = old.get(key) if valid else None
            result[key] = value - before if before is not None and value >= before else None
            if before is not None and value < before:
                resets.append(key)
        if identity is not None:
            self.next_previous[label] = (identity, counters)
        return result, resets

    def train_groups(self, cgroot):
        queue, names, visited, complete = [(cgroot, 0)], [], 0, True
        deadline = self.clock.monotonic() + self.scan_seconds
        while queue:
            directory, depth = queue.pop(0)
            if visited >= self.max_dirs or self.clock.monotonic() > deadline:
                complete = False
                break
            visited += 1
            try:
                with os.scandir(directory) as entries:
                    for index, entry in enumerate(entries):
                        if index >= 1024:
                            complete = False
                            break
                        match = TRAIN.fullmatch(entry.name)
                        descend = depth < 3 and entry.name.endswith(".slice")
                        if not (match or descend) or not entry.is_dir(follow_symlinks=False):
                            continue
                        relative = Path(entry.path).relative_to(cgroot)
                        if len(str(relative)) > 512:
                            complete = False
                            continue
                        if match:
                            if len(names) < self.max_trains:
                                names.append("/" + str(relative))
                            else:
                                complete = False
                        if descend:
                            if len(queue) < self.max_dirs:
                                queue.append((Path(entry.path), depth + 1))
                            else:
                                complete = False
            except OSError as exc:
                self.error("cgroup.discovery", type(exc).__name__)
                complete = False
        return sorted(set(names)), {"current_scan_complete": complete,
                                   "history_complete": False, "directories_scanned": visited}

    def quick_trains(self, cgroot):
        """Cheap current check of the official default train slice only."""
        names, complete = [], True
        try:
            with os.scandir(cgroot / "system.slice") as entries:
                for index, entry in enumerate(entries):
                    if index >= 1024:
                        complete = False
                        break
                    if TRAIN.fullmatch(entry.name) and entry.is_dir(follow_symlinks=False):
                        if len(names) < self.max_trains:
                            names.append("/system.slice/" + entry.name)
                        else:
                            complete = False
        except OSError as exc:
            self.error("cgroup.quick_discovery", type(exc).__name__)
            complete = False
        return names, {"current_scan_complete": complete, "scope": "/system.slice"}

    @staticmethod
    def cached_snapshot(cache, now, ttl, attempted):
        age = max(0, now - cache["monotonic"]) if cache else None
        expired = cache is None or age > ttl
        refreshed = cache is not None and attempted and cache["monotonic"] == now
        info = dict(cache["info"]) if cache else {}
        info["last_scan_complete"] = info.pop("current_scan_complete", None)
        for key in ("pids_scanned", "directories_scanned"):
            if key in info:
                info["last_scan_" + key] = info[key]
                if not refreshed:
                    info[key] = None
        info.update(current_scan_complete=refreshed and info["last_scan_complete"] is True,
                    scan_performed=attempted, refreshed=refreshed, cached=cache is not None and not refreshed,
                    captured_utc=cache["utc"] if cache else None,
                    captured_monotonic=cache["monotonic"] if cache else None,
                    age_seconds=age, expired=expired, max_age_seconds=ttl)
        return None if expired else cache["data"], info

    def remember_trains(self, names):
        limited = False
        for name in names:
            if name in self.known_trains or len(self.known_trains) < self.max_trains:
                self.known_trains.add(name)
            else:
                limited = True
        return limited

    def cgroup(self, relative, boot):
        directory = self.root / "sys/fs/cgroup" / relative.lstrip("/")
        try:
            before = directory.stat(follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode):
                raise NotADirectoryError
        except OSError as exc:
            self.error("cgroup.identity", type(exc).__name__)
            return {"path": relative, "identity": None, "metrics": None, "deltas": None,
                    "observation": "missing" if isinstance(exc, FileNotFoundError) else "unknown"}
        metrics, counters = {}, {}
        for name in ("memory.current", "memory.peak", "memory.high", "memory.max",
                     "memory.swap.current", "memory.swap.peak", "memory.swap.max",
                     "pids.current", "pids.max"):
            metrics[name] = self.number(directory / name, "cgroup." + name,
                                        name.endswith(".max") or name == "memory.high")
        for name, allowed in (("memory.events", EVENTS), ("memory.events.local", EVENTS),
                              ("memory.swap.events", SWAP_EVENTS),
                              ("pids.events", frozenset(("max",)))):
            values = self.numbers(directory / name, allowed, "cgroup." + name)
            metrics[name] = values
            if values is not None:
                counters.update({name + "." + key: value for key, value in values.items()})
        memory_stat = self.numbers(directory / "memory.stat", MEMORY_STAT, "cgroup.memory.stat")
        metrics["memory.stat"] = memory_stat
        if memory_stat is not None:
            counters.update({"memory.stat." + key: value for key, value in memory_stat.items()
                             if key in MEMORY_STAT_COUNTERS})
        metrics["memory.pressure"] = self.pressure(directory / "memory.pressure", "cgroup.memory.pressure")
        for kind, values in (metrics["memory.pressure"] or {}).items():
            if "total" in values:
                counters["memory.pressure." + kind + ".total"] = values["total"]
        try:
            after = directory.stat(follow_symlinks=False)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise RuntimeError
        except Exception as exc:
            self.error("cgroup.identity", "Changed" if isinstance(exc, RuntimeError) else type(exc).__name__)
            return {"path": relative, "identity": None, "metrics": None, "deltas": None,
                    "observation": "unknown"}
        identity = (boot, before.st_dev, before.st_ino) if boot else None
        delta, resets = self.delta("cg:" + relative, identity, counters)
        return {"path": relative, "observation": "current", "identity": list(identity) if identity else None,
                "metrics": metrics, "deltas": delta, "counter_resets": resets}

    @staticmethod
    def proc_stat(raw):
        if raw is None or "(" not in raw or ")" not in raw:
            return None
        try:
            head, tail = raw.rsplit(")", 1)
            pid, comm = head.split("(", 1)
            fields = tail.split()
            values = {"pid": int(pid), "ppid": int(fields[1]),
                      "start_ticks": int(fields[19]), "rss_pages": int(fields[21]),
                      "comm": re.sub(r"[^A-Za-z0-9_.:-]", "_", comm)[:64]}
            return values if min(values["pid"], values["start_ticks"], values["rss_pages"]) >= 0 else None
        except (ValueError, IndexError):
            return None

    def processes(self):
        candidates, result, scanned, complete = [], [], 0, True
        deadline = self.clock.monotonic() + self.scan_seconds
        try:
            with os.scandir(self.root / "proc") as entries:
                for index, entry in enumerate(entries):
                    if index >= self.max_pids + 128 or scanned >= self.max_pids or self.clock.monotonic() > deadline:
                        complete = False
                        break
                    if not re.fullmatch(r"[0-9]{1,10}", entry.name):
                        continue
                    scanned += 1
                    first = self.proc_stat(self.read(entry.path + "/stat", "proc.stat", 4096))
                    if not first:
                        self.error("proc.stat", "Unavailable")
                        complete = False
                        continue
                    item = (first["rss_pages"], -first["pid"], first)
                    if len(candidates) < 16:
                        heapq.heappush(candidates, item)
                    elif item[:2] > candidates[0][:2]:
                        heapq.heapreplace(candidates, item)
        except OSError as exc:
            self.error("proc.discovery", type(exc).__name__)
            complete = False
        # Only the shortlisted identities incur cgroup reads and a second stat.
        for _, _, first in sorted(candidates, reverse=True):
            directory = self.root / "proc" / str(first["pid"])
            groups = self.read(directory / "cgroup", "proc.cgroup", 4096)
            second = self.proc_stat(self.read(directory / "stat", "proc.stat", 4096))
            if not second or (first["pid"], first["start_ticks"]) != (second["pid"], second["start_ticks"]):
                self.error("proc.identity", "Changed" if second else "Unavailable")
                complete = False
                continue
            cgroup = None
            if groups is not None:
                for line in groups.splitlines():
                    if line.startswith("0::/"):
                        candidate = line[3:]
                        if len(candidate) <= 512 and ".." not in Path(candidate).parts:
                            cgroup = candidate
            else:
                complete = False
            first["rss_bytes"] = first.pop("rss_pages") * self.page_size
            first["cgroup"] = cgroup
            result.append(first)
        return result, {"pids_scanned": scanned, "current_scan_complete": complete}

    def flags(self, meminfo, pressure, now):
        available = (meminfo or {}).get("MemAvailable")
        total = (meminfo or {}).get("MemTotal")
        result = {}
        for name, fraction, kib, duration in (("memory_warning", .15, 2 * 1024**2, 30),
                                               ("memory_critical", .08, 1024**2, 10)):
            condition = available is not None and total is not None and total > 0 and (available < fraction * total or available < kib)
            if condition:
                previous = self.threshold_since.get(name, now)
                since = previous if previous <= now else now
                self.threshold_since[name] = since
                result[name] = now - since >= duration
            else:
                self.threshold_since.pop(name, None)
                result[name] = False if available is not None and total is not None else None
        for level, threshold, duration in (("some", 10, 30), ("full", 2, 15)):
            value = (pressure or {}).get(level, {}).get("avg10")
            name = "psi_" + level + "_avg10_ge_" + str(threshold) + "_for_" + str(duration) + "s"
            if value is not None and value >= threshold:
                previous = self.threshold_since.get(name, now)
                since = previous if previous <= now else now
                self.threshold_since[name] = since
                result[name] = now - since >= duration
            else:
                self.threshold_since.pop(name, None)
                result[name] = False if value is not None else None
        return result

    def sample(self):
        self.errors, self.error_count, self.next_previous = [], 0, {}
        cpu_started = time.process_time()
        now, wall = self.clock.monotonic(), self.clock.time()
        boot = self.read(self.root / "proc/sys/kernel/random/boot_id", "boot_id", 64)
        boot = boot.strip() if boot is not None else None
        if boot is not None and not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", boot):
            self.error("boot_id", "InvalidIdentity")
            boot = None
        if boot != self.last_boot or (self.last_monotonic is not None and now < self.last_monotonic):
            self.threshold_since.clear()
            self.known_trains.clear()
            self.discovery_cache = self.process_cache = None
            self.discovery_attempt = self.process_attempt = None
            self.previous.clear()
        self.last_boot = boot
        self.last_monotonic = now
        meminfo = self.numbers(self.root / "proc/meminfo", MEMINFO, "meminfo")
        vmstat = self.numbers(self.root / "proc/vmstat", VMSTAT, "vmstat")
        pressure = {kind: self.pressure(self.root / ("proc/pressure/" + kind), "psi." + kind)
                    for kind in ("memory", "cpu", "io")}
        psi_counters = {kind + "." + level + ".total": values["total"]
                        for kind, levels in pressure.items() for level, values in (levels or {}).items()
                        if "total" in values}
        psi_delta, psi_resets = self.delta("psi", boot, psi_counters)
        delta, resets = self.delta("vmstat", boot, vmstat or {})
        cgroot = self.root / "sys/fs/cgroup"
        quick, quick_info = self.quick_trains(cgroot)
        tracking_limited = self.remember_trains(quick)
        discover = self.discovery_attempt is None or now - self.discovery_attempt >= 10
        if discover:
            self.discovery_attempt = now
            found, info = self.train_groups(cgroot)
            tracking_limited = self.remember_trains(found) or tracking_limited
            if found or info["current_scan_complete"]:
                self.discovery_cache = {"data": found, "info": info, "monotonic": now, "utc": utc(wall)}
        observed, discovery = self.cached_snapshot(self.discovery_cache, now, 30, discover)
        discovery.update(observed_units=observed, history_complete=False,
                         quick_scan=quick_info, tracking_limit_hit=tracking_limited,
                         full_scan_interval_seconds=10)
        cgroups = [self.cgroup(path, boot) for path in ["/", "/system.slice", "/user.slice", *sorted(self.known_trains)]]
        root_observed = cgroups[0]["observation"] == "current"
        for group in cgroups:
            if group["path"] in self.known_trains and group["observation"] == "missing":
                if root_observed:
                    self.known_trains.remove(group["path"])
                else:
                    # An inaccessible/unmounted hierarchy is not proof that a
                    # previously observed train disappeared.
                    group["observation"] = "unknown"
        discovery["known_units"] = sorted(self.known_trains)
        refresh_procs = self.process_attempt is None or now - self.process_attempt >= 60
        if refresh_procs:
            self.process_attempt = now
            found, info = self.processes()
            if found or info["current_scan_complete"]:
                self.process_cache = {"data": found, "info": info, "monotonic": now, "utc": utc(wall)}
        procs, proc_discovery = self.cached_snapshot(self.process_cache, now, 120, refresh_procs)
        proc_discovery["scan_interval_seconds"] = 60
        proc_discovery["pid_budget"] = self.max_pids
        self.previous = self.next_previous
        return {"schema": 1, "utc": utc(wall), "monotonic_seconds": now, "boot_id": boot,
                "sample_duration_seconds": max(0, self.clock.monotonic() - now),
                "sample_cpu_seconds": max(0, time.process_time() - cpu_started),
                "next_interval_seconds": 1 if self.known_trains else 10,
                "meminfo_kib": meminfo, "vmstat": vmstat, "vmstat_deltas": delta,
                "vmstat_counter_resets": resets, "psi": pressure,
                "psi_deltas": psi_delta, "psi_counter_resets": psi_resets,
                "cgroups": cgroups, "train_discovery": discovery,
                "top_processes": procs, "process_discovery": proc_discovery,
                "flags": self.flags(meminfo, pressure["memory"], now),
                "errors": self.errors, "error_count": self.error_count}


class LogSecurityError(Exception):
    pass


class SafeJSONLLog:
    def __init__(self, directory=DEFAULT_LOG_DIR, clock=time, max_bytes=512 * 1024**2,
                 file_bytes=8 * 1024**2, record_limit=65536, days=7):
        if not 128 <= record_limit <= file_bytes <= max_bytes:
            raise ValueError("log_limits")
        self.clock, self.max_bytes, self.file_bytes = clock, max_bytes, file_bytes
        self.record_limit, self.max_age = record_limit, days * 86400
        self.fd, self.name = None, None
        self.dirfd = self.open_directory(Path(directory))

    @staticmethod
    def open_directory(path):
        path = path.absolute()
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in path.parts[1:]:
                if part in (".", ".."):
                    raise LogSecurityError
                try:
                    nextfd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except FileNotFoundError:
                    os.mkdir(part, 0o700, dir_fd=fd)
                    nextfd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = nextfd
            if os.fstat(fd).st_uid != os.geteuid():
                raise LogSecurityError
            os.fchmod(fd, 0o700)
            return fd
        except Exception:
            os.close(fd)
            raise

    @staticmethod
    def created(name):
        match = LOG_NAME.fullmatch(name)
        if not match:
            return None
        try:
            return dt.datetime.strptime(match[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc).timestamp()
        except ValueError:
            return None

    def entries(self):
        result = []
        with os.scandir(self.dirfd) as entries:
            for index, entry in enumerate(entries):
                if index >= 4096:
                    raise OverflowError
                created = self.created(entry.name)
                if created is None:
                    continue
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
                    raise LogSecurityError
                result.append((created, entry.name, info.st_size))
        return sorted(result)

    def rotate(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        stamp = dt.datetime.fromtimestamp(self.clock.time(), dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        for _ in range(8):
            name = "host-memory-" + stamp + "-" + uuid.uuid4().hex[:12] + ".jsonl"
            try:
                self.fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                  0o600, dir_fd=self.dirfd)
                os.fchmod(self.fd, 0o600)
                self.name = name
                return
            except FileExistsError:
                continue
        raise FileExistsError

    def prune(self, incoming):
        entries = self.entries()
        cutoff = self.clock.time() - self.max_age
        for created, name, _ in entries:
            if name != self.name and created < cutoff:
                os.unlink(name, dir_fd=self.dirfd)
        entries = self.entries()
        total = sum(size for _, _, size in entries)
        for _, name, size in entries:
            if total + incoming <= self.max_bytes:
                return
            if name != self.name:
                os.unlink(name, dir_fd=self.dirfd)
                total -= size
        if total + incoming > self.max_bytes:
            self.rotate()
            self.prune(incoming)

    def write(self, record):
        data = record_bytes(record, self.record_limit)
        if self.fd is None or os.fstat(self.fd).st_size + len(data) > self.file_bytes or self.created(self.name) < self.clock.time() - self.max_age:
            self.rotate()
        current = os.stat(self.name, dir_fd=self.dirfd, follow_symlinks=False)
        opened = os.fstat(self.fd)
        if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            raise LogSecurityError
        self.prune(len(data))
        while data:
            written = os.write(self.fd, data)
            if written <= 0:
                raise OSError
            data = data[written:]

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self.dirfd is not None:
            os.close(self.dirfd)
            self.dirfd = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="one bounded record on stdout; no filesystem writes")
    parser.add_argument("--log-dir", default=DEFAULT_LOG_DIR)
    args = parser.parse_args()
    writer = None
    try:
        sampler = Sampler()  # Fixture roots are deliberately not a production CLI option.
        if args.once:
            sys.stdout.buffer.write(record_bytes(sampler.sample()))
            return 0
        writer = SafeJSONLLog(args.log_dir)
        while True:
            started = time.monotonic()
            record = sampler.sample()
            writer.write(record)
            time.sleep(max(0, record["next_interval_seconds"] - (time.monotonic() - started)))
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(json.dumps({"error": {"type": type(exc).__name__, "metric": "collector"}}), file=sys.stderr)
        return 1
    finally:
        if writer is not None:
            writer.close()


if __name__ == "__main__":
    sys.exit(main())
