#!/usr/bin/env python3
"""Fixture-only tests: no systemd, network, production log or process mutations."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
PROJECT = Path(__file__).resolve().parents[2]
SCRIPT = PROJECT / "scripts/v5-selfhost-host-memory.py"
SPEC = importlib.util.spec_from_file_location("host_memory", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
BOOT = "11111111-2222-3333-4444-555555555555"
TRAIN = "oc-v5-lease-train-20261102T000000Z-abcdef.service"


class Clock:
    def __init__(self):
        self.wall = dt.datetime(2026, 11, 2, tzinfo=dt.timezone.utc).timestamp()
        self.mono = 100.0

    def time(self):
        return self.wall

    def monotonic(self):
        return self.mono

    def advance(self, seconds):
        self.wall += seconds
        self.mono += seconds


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".host-memory-test-", dir=PROJECT)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.clock = Clock()
        self.put("proc/sys/kernel/random/boot_id", BOOT)
        self.put("proc/meminfo", "MemTotal: 16777216 kB\nMemAvailable: 8000000 kB\nSwapFree: 3000000 kB\nPRIVATE_UNKNOWN: 123 kB\n")
        self.put("proc/vmstat", "oom_kill 10\npgmajfault 100\nsecret_metric 99\n")
        for kind in ("memory", "cpu", "io"):
            self.put("proc/pressure/" + kind, "some avg10=0.50 avg60=0.20 avg300=0.10 total=1000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=20\n")
        for group in ("", "system.slice", "user.slice"):
            self.group(group)

    def put(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)
        return target

    def group(self, relative):
        path = "sys/fs/cgroup/" + relative.strip("/")
        for name in ("memory.current", "memory.peak", "memory.swap.current", "memory.swap.peak", "pids.current"):
            self.put(path + "/" + name, "42\n")
        for name in ("memory.high", "memory.max", "memory.swap.max", "pids.max"):
            self.put(path + "/" + name, "max\n")
        for name in ("memory.events", "memory.events.local"):
            self.put(path + "/" + name, "low 0\nhigh 1\nmax 0\noom 2\noom_kill 2\noom_group_kill 0\n")
        self.put(path + "/memory.swap.events", "high 0\nmax 0\nfail 0\n")
        self.put(path + "/memory.stat", "anon 1024\nfile 2048\nslab 256\npgfault 100\npgmajfault 5\nunknown_private_metric 9\n")
        self.put(path + "/pids.events", "max 0\n")
        self.put(path + "/memory.pressure", "some avg10=0.00 avg60=0.00 avg300=0.00 total=100\n")
        return self.root / path

    @staticmethod
    def proc_line(pid, start, rss=100, ppid=1, comm="node"):
        fields = ["S", str(ppid)] + ["0"] * 20
        fields[19], fields[21] = str(start), str(rss)
        return f"{pid} ({comm}) " + " ".join(fields) + "\n"

    def process(self, pid, start=500, rss=100):
        self.put(f"proc/{pid}/stat", self.proc_line(pid, start, rss))
        self.put(f"proc/{pid}/cgroup", "0::/system.slice/" + TRAIN + "\n")
        self.put(f"proc/{pid}/cmdline", "DO_NOT_READ_PRIVATE_COMMAND")
        self.put(f"proc/{pid}/environ", "DO_NOT_READ_PRIVATE_ENV")

    def sampler(self, **kwargs):
        return MODULE.Sampler(self.root, self.clock, **kwargs)

    @staticmethod
    def cg(record, path="/system.slice"):
        return next(group for group in record["cgroups"] if group["path"] == path)


class SamplingTests(Fixture):
    def test_whitelists_top16_and_read_only_process_surface(self):
        self.group("system.slice/" + TRAIN)
        for pid in range(30, 54):
            self.process(pid, rss=pid)
        sampler = self.sampler()
        original = sampler.read

        def guarded(path, *args, **kwargs):
            self.assertNotIn(Path(path).name, ("cmdline", "environ"))
            return original(path, *args, **kwargs)

        with mock.patch.object(sampler, "read", side_effect=guarded):
            result = sampler.sample()
        self.assertEqual(result["next_interval_seconds"], 1)
        self.assertEqual(result["boot_id"], BOOT)
        self.assertEqual(result["top_processes"][0]["pid"], 53)
        self.assertEqual(result["top_processes"][-1]["pid"], 38)
        self.assertEqual(len(result["top_processes"]), 16)
        self.assertEqual(result["top_processes"][0]["rss_bytes"], 53 * sampler.page_size)
        self.assertNotIn("PRIVATE_UNKNOWN", result["meminfo_kib"])
        self.assertNotIn("secret_metric", result["vmstat"])
        self.assertEqual(self.cg(result)["metrics"]["memory.stat"]["anon"], 1024)
        self.assertNotIn("unknown_private_metric", self.cg(result)["metrics"]["memory.stat"])
        self.assertNotIn("DO_NOT_READ", json.dumps(result))
        self.assertFalse(result["train_discovery"]["history_complete"])

    def test_counter_deltas_missing_permission_reset_and_boot_change(self):
        sampler = self.sampler()
        first = sampler.sample()
        self.assertIsNone(first["vmstat_deltas"]["oom_kill"])
        self.put("proc/vmstat", "oom_kill 12\npgmajfault 110\n")
        self.put("sys/fs/cgroup/system.slice/memory.events", "oom_kill 5\n")
        self.put("proc/pressure/memory", "some avg10=1.0 total=1100\n")
        second = sampler.sample()
        self.assertEqual(second["vmstat_deltas"]["oom_kill"], 2)
        self.assertEqual(self.cg(second)["deltas"]["memory.events.oom_kill"], 3)
        self.assertEqual(second["psi_deltas"]["memory.some.total"], 100)
        self.put("proc/vmstat", "oom_kill 1\n")
        self.put("sys/fs/cgroup/system.slice/memory.events", "oom_kill 1\n")
        reset = sampler.sample()
        self.assertIsNone(reset["vmstat_deltas"]["oom_kill"])
        self.assertIn("oom_kill", reset["vmstat_counter_resets"])
        self.assertIn("memory.events.oom_kill", self.cg(reset)["counter_resets"])
        event_path = self.root / "sys/fs/cgroup/system.slice/memory.events"
        event_path.unlink()
        absent = sampler.sample()
        self.assertIsNone(self.cg(absent)["metrics"]["memory.events"])
        self.put("sys/fs/cgroup/system.slice/memory.events", "oom_kill 8\n")
        restored = sampler.sample()
        self.assertIsNone(self.cg(restored)["deltas"]["memory.events.oom_kill"])
        original_open = open

        def permission(path, *args, **kwargs):
            if Path(path) == event_path:
                raise PermissionError("PRIVATE_ERROR_MUST_NOT_APPEAR")
            return original_open(path, *args, **kwargs)

        with mock.patch("builtins.open", side_effect=permission):
            denied = sampler.sample()
        self.assertIsNone(self.cg(denied)["metrics"]["memory.events"])
        self.assertNotIn("PRIVATE_ERROR", json.dumps(denied))
        self.put("proc/sys/kernel/random/boot_id", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        rebooted = sampler.sample()
        self.assertIsNone(rebooted["vmstat_deltas"]["oom_kill"])
        self.assertIsNone(self.cg(rebooted)["deltas"]["memory.events.oom_kill"])

    def test_recreated_cgroup_has_no_delta_from_previous_inode(self):
        sampler = self.sampler()
        sampler.sample()
        old = self.root / "sys/fs/cgroup/system.slice"
        old.rename(self.root / "retained-old-cgroup")
        self.group("system.slice")
        self.put("sys/fs/cgroup/system.slice/memory.events", "oom_kill 20\n")
        result = sampler.sample()
        self.assertIsNone(self.cg(result)["deltas"]["memory.events.oom_kill"])

    def test_pid_reuse_during_scan_discards_mixed_identity(self):
        self.process(42)
        sampler = self.sampler()
        original = sampler.read
        reads = 0

        def raced(path, *args, **kwargs):
            nonlocal reads
            if Path(path) == self.root / "proc/42/stat":
                reads += 1
                if reads == 2:
                    self.put("proc/42/stat", self.proc_line(42, 999, 999))
            return original(path, *args, **kwargs)

        with mock.patch.object(sampler, "read", side_effect=raced):
            result = sampler.sample()
        self.assertIsNone(result["top_processes"])
        self.assertFalse(result["process_discovery"]["current_scan_complete"])
        self.assertIn({"metric": "proc.identity", "type": "Changed"}, result["errors"])

    def test_proc_shortlist_reads_only_top16_cgroups_and_caches_snapshot(self):
        for pid in range(100, 132):
            self.process(pid, rss=pid)
        sampler = self.sampler()
        original = sampler.read
        reads = {"stat": 0, "cgroup": 0}

        def count(path, *args, **kwargs):
            path = Path(path)
            if path.parent.parent == self.root / "proc" and path.name in reads:
                reads[path.name] += 1
            return original(path, *args, **kwargs)

        with mock.patch.object(sampler, "read", side_effect=count):
            initial = sampler.sample()
            self.assertEqual(reads, {"stat": 48, "cgroup": 16})
            self.assertEqual(initial["top_processes"][0]["pid"], 131)
            self.process(100, rss=9999)
            self.put("proc/meminfo", "MemTotal: 16777216 kB\nMemAvailable: 7000000 kB\n")
            self.clock.advance(1)
            cached = sampler.sample()
            self.assertEqual(reads, {"stat": 48, "cgroup": 16})
            self.assertEqual(cached["top_processes"][0]["pid"], 131)
            self.assertTrue(cached["process_discovery"]["cached"])
            self.assertFalse(cached["process_discovery"]["scan_performed"])
            self.assertFalse(cached["process_discovery"]["current_scan_complete"])
            self.assertEqual(cached["process_discovery"]["age_seconds"], 1)
            self.assertIsNone(cached["process_discovery"]["pids_scanned"])
            self.assertEqual(cached["meminfo_kib"]["MemAvailable"], 7000000)
            self.clock.advance(59)
            refreshed = sampler.sample()
            self.assertEqual(refreshed["top_processes"][0]["pid"], 100)
            self.assertTrue(refreshed["process_discovery"]["refreshed"])
            self.assertEqual(refreshed["process_discovery"]["age_seconds"], 0)
            self.assertEqual(reads, {"stat": 96, "cgroup": 32})

    def test_expired_process_cache_is_unknown_until_a_successful_refresh(self):
        self.process(42)
        sampler = self.sampler()
        initial = sampler.sample()
        self.clock.advance(121)
        failure = ([], {"pids_scanned": 0, "current_scan_complete": False})
        with mock.patch.object(sampler, "processes", return_value=failure):
            expired = sampler.sample()
        self.assertIsNone(expired["top_processes"])
        self.assertTrue(expired["process_discovery"]["expired"])
        self.assertTrue(expired["process_discovery"]["scan_performed"])
        self.assertFalse(expired["process_discovery"]["refreshed"])
        self.assertEqual(expired["process_discovery"]["captured_monotonic"], initial["monotonic_seconds"])
        self.clock.advance(1)
        self.assertIsNone(sampler.sample()["top_processes"])
        self.clock.advance(59)
        recovered = sampler.sample()
        self.assertFalse(recovered["process_discovery"]["expired"])
        self.assertEqual(recovered["top_processes"][0]["pid"], 42)

    def test_full_discovery_delay_and_expiry_never_drop_known_train(self):
        sampler = self.sampler()
        sampler.sample()
        path = "user.slice/nested.slice/" + TRAIN
        self.group(path)
        self.clock.advance(1)
        delayed = sampler.sample()
        self.assertEqual(delayed["next_interval_seconds"], 10)
        self.assertEqual(delayed["train_discovery"]["known_units"], [])
        self.assertTrue(delayed["train_discovery"]["cached"])
        self.clock.advance(9)
        found = sampler.sample()
        self.assertEqual(found["next_interval_seconds"], 1)
        self.assertIn("/" + path, found["train_discovery"]["known_units"])
        self.put("sys/fs/cgroup/" + path + "/memory.current", "73\n")
        self.clock.advance(31)
        failure = ([], {"current_scan_complete": False, "history_complete": False, "directories_scanned": 0})
        with mock.patch.object(sampler, "train_groups", return_value=failure):
            expired = sampler.sample()
        self.assertIsNone(expired["train_discovery"]["observed_units"])
        self.assertTrue(expired["train_discovery"]["expired"])
        self.assertIn("/" + path, expired["train_discovery"]["known_units"])
        self.assertEqual(self.cg(expired, "/" + path)["metrics"]["memory.current"], 73)
        self.assertEqual(expired["next_interval_seconds"], 1)

    def test_known_train_permission_is_unknown_and_confirmed_removal_is_tombstone(self):
        train = self.group("system.slice/" + TRAIN)
        sampler = self.sampler()
        sampler.sample()
        original = Path.stat

        def denied(path, *args, **kwargs):
            if path == train:
                raise PermissionError("PRIVATE_ERROR_MUST_NOT_APPEAR")
            return original(path, *args, **kwargs)

        self.clock.advance(1)
        with mock.patch.object(Path, "stat", denied):
            unknown = sampler.sample()
        self.assertEqual(unknown["next_interval_seconds"], 1)
        self.assertEqual(self.cg(unknown, "/system.slice/" + TRAIN)["observation"], "unknown")
        self.assertIsNone(self.cg(unknown, "/system.slice/" + TRAIN)["metrics"])
        self.assertNotIn("PRIVATE_ERROR", json.dumps(unknown))
        train.rename(self.root / "removed-train")
        self.clock.advance(1)
        missing = sampler.sample()
        tombstone = self.cg(missing, "/system.slice/" + TRAIN)
        self.assertEqual(tombstone["observation"], "missing")
        self.assertIsNone(tombstone["identity"])
        self.assertIsNone(tombstone["metrics"])
        self.assertEqual(missing["next_interval_seconds"], 10)
        self.assertEqual(missing["train_discovery"]["known_units"], [])

    def test_boot_or_monotonic_reset_does_not_reuse_process_snapshot(self):
        self.process(42)
        sampler = self.sampler()
        sampler.sample()
        self.process(43, rss=900)
        self.clock.advance(1)
        self.put("proc/sys/kernel/random/boot_id", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        rebooted = sampler.sample()
        self.assertTrue(rebooted["process_discovery"]["refreshed"])
        self.assertEqual(rebooted["top_processes"][0]["pid"], 43)
        self.clock.mono -= 50
        reset = sampler.sample()
        self.assertTrue(reset["process_discovery"]["refreshed"])
        self.assertEqual(reset["process_discovery"]["age_seconds"], 0)

    def test_unavailable_cgroup_hierarchy_is_not_proof_known_train_disappeared(self):
        self.group("system.slice/" + TRAIN)
        sampler = self.sampler()
        sampler.sample()
        (self.root / "sys/fs/cgroup").rename(self.root / "unavailable-cgroup-mount")
        self.clock.advance(1)
        result = sampler.sample()
        self.assertEqual(result["next_interval_seconds"], 1)
        self.assertIn("/system.slice/" + TRAIN, result["train_discovery"]["known_units"])
        group = self.cg(result, "/system.slice/" + TRAIN)
        self.assertEqual(group["observation"], "unknown")
        self.assertIsNone(group["metrics"])

    def test_cadence_switches_and_bounded_scan_is_not_historical_proof(self):
        sampler = self.sampler()
        self.assertEqual(sampler.sample()["next_interval_seconds"], 10)
        train = self.group("system.slice/" + TRAIN)
        self.assertEqual(sampler.sample()["next_interval_seconds"], 1)
        train.rename(self.root / "inactive-train")
        self.assertEqual(sampler.sample()["next_interval_seconds"], 10)
        self.group("system.slice/" + TRAIN)
        limited = self.sampler(max_dirs=1).sample()
        self.assertFalse(limited["train_discovery"]["current_scan_complete"])
        self.assertFalse(limited["train_discovery"]["history_complete"])
        for pid in range(100, 110):
            self.process(pid)
        procs = self.sampler(max_pids=3).sample()
        self.assertEqual(procs["process_discovery"]["pids_scanned"], 3)
        self.assertFalse(procs["process_discovery"]["current_scan_complete"])

    def test_memory_flags_require_continuous_valid_time_and_never_act(self):
        self.put("proc/meminfo", "MemTotal: 16777216 kB\nMemAvailable: 500000 kB\n")
        self.put("proc/pressure/memory", "some avg10=11 total=1000\nfull avg10=2.2 total=20\n")
        sampler = self.sampler()
        initial = sampler.sample()
        self.assertFalse(initial["flags"]["memory_critical"])
        self.assertFalse(initial["flags"]["psi_some_avg10_ge_10_for_30s"])
        self.assertFalse(initial["flags"]["psi_full_avg10_ge_2_for_15s"])
        self.clock.advance(10)
        critical = sampler.sample()
        self.assertTrue(critical["flags"]["memory_critical"])
        self.assertFalse(critical["flags"]["memory_warning"])
        self.assertFalse(critical["flags"]["psi_full_avg10_ge_2_for_15s"])
        self.clock.advance(20)
        self.assertTrue(sampler.sample()["flags"]["memory_warning"])
        self.put("proc/meminfo", "MemTotal: 16777216 kB\n")
        self.assertFalse(sampler.sample()["flags"]["memory_warning"])
        self.put("proc/meminfo", "MemTotal: 16777216 kB\nMemAvailable: 500000 kB\n")
        restarted = sampler.sample()
        self.assertFalse(restarted["flags"]["memory_critical"])
        self.assertTrue(restarted["flags"]["psi_some_avg10_ge_10_for_30s"])
        self.assertTrue(restarted["flags"]["psi_full_avg10_ge_2_for_15s"])
        self.put("proc/pressure/memory", "some avg10=9 total=1010\n")
        cleared = sampler.sample()["flags"]
        self.assertFalse(cleared["psi_some_avg10_ge_10_for_30s"])
        self.assertIsNone(cleared["psi_full_avg10_ge_2_for_15s"])
        self.put("proc/pressure/memory", "some avg10=11 total=1020\nfull avg10=2.2 total=30\n")
        self.clock.advance(60)
        recovered = sampler.sample()["flags"]
        self.assertFalse(recovered["psi_some_avg10_ge_10_for_30s"])
        self.assertFalse(recovered["psi_full_avg10_ge_2_for_15s"])

    def test_memory_stat_gauges_and_counters_remain_distinct_and_unknown(self):
        sampler = self.sampler()
        first = self.cg(sampler.sample())
        self.assertNotIn("memory.stat.anon", first["deltas"])
        self.assertIsNone(first["deltas"]["memory.stat.pgfault"])
        path = "sys/fs/cgroup/system.slice/memory.stat"
        self.put(path, "anon 512\npgfault 104\npgmajfault 6\n")
        second = self.cg(sampler.sample())
        self.assertEqual(second["metrics"]["memory.stat"]["anon"], 512)
        self.assertEqual(second["deltas"]["memory.stat.pgfault"], 4)
        self.put(path, "pgfault 1\n")
        reset = self.cg(sampler.sample())
        self.assertIsNone(reset["deltas"]["memory.stat.pgfault"])
        self.assertIn("memory.stat.pgfault", reset["counter_resets"])
        (self.root / path).unlink()
        self.assertIsNone(self.cg(sampler.sample())["metrics"]["memory.stat"])

    def test_malformed_or_oversized_input_is_unknown_and_train_match_is_exact(self):
        self.group("system.slice/not-" + TRAIN)
        self.put("proc/meminfo", "PRIVATE_RAW_VALUE" * 1000)
        self.put("proc/pressure/memory", "some avg10=1.0 total=1.5\n")
        self.put("proc/sys/kernel/random/boot_id", "PRIVATE_IDENTITY_MUST_NOT_APPEAR")
        result = self.sampler().sample()
        self.assertEqual(result["next_interval_seconds"], 10)
        self.assertIsNone(result["meminfo_kib"])
        self.assertIsNone(result["boot_id"])
        self.assertIsNone(result["flags"]["memory_warning"])
        self.assertNotIn("total", result["psi"]["memory"]["some"])
        self.assertNotIn("PRIVATE_", json.dumps(result))


class LoggingTests(Fixture):
    def writer(self, **kwargs):
        writer = MODULE.SafeJSONLLog(self.root / "logs", self.clock, **kwargs)
        self.addCleanup(writer.close)
        return writer

    def test_modes_rotation_total_includes_active_and_ignores_unowned_names(self):
        self.put("logs/notes.txt", "KEEP")
        writer = self.writer(record_limit=256, file_bytes=512, max_bytes=650)
        for i in range(9):
            writer.write({"i": i, "value": "x" * 180})
            owned = list((self.root / "logs").glob("host-memory-*.jsonl"))
            self.assertLessEqual(sum(path.stat().st_size for path in owned), 650)
            self.assertTrue(all(path.stat().st_size <= 512 for path in owned))
        self.assertEqual((self.root / "logs/notes.txt").read_text(), "KEEP")
        self.assertEqual(stat.S_IMODE((self.root / "logs").stat().st_mode), 0o700)
        self.assertTrue(all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in owned))
        for path in owned:
            for line in path.read_text().splitlines():
                json.loads(line)

    def test_age_cap_rotates_and_expires_the_former_active_file(self):
        writer = self.writer(record_limit=256, file_bytes=512, max_bytes=1024)
        writer.write({"before": True})
        old = self.root / "logs" / writer.name
        self.clock.advance(8 * 86400)
        writer.write({"after": True})
        self.assertFalse(old.exists())
        self.assertEqual(len(list((self.root / "logs").glob("host-memory-*.jsonl"))), 1)

    def test_oversized_record_becomes_small_marker_without_payload(self):
        writer = self.writer(record_limit=256, file_bytes=512, max_bytes=1024)
        writer.write({"value": "PRIVATE_PAYLOAD" * 1000})
        raw = (self.root / "logs" / writer.name).read_bytes()
        self.assertLessEqual(len(raw), 256)
        self.assertNotIn(b"PRIVATE_PAYLOAD", raw)
        self.assertEqual(json.loads(raw)["error"], {"type": "RecordTooLarge", "metric": "record"})

    def test_directory_symlink_is_rejected_without_touching_target(self):
        target = self.root / "target"
        target.mkdir()
        (self.root / "linked").symlink_to(target, target_is_directory=True)
        with self.assertRaises((OSError, MODULE.LogSecurityError)):
            MODULE.SafeJSONLLog(self.root / "linked/nested", self.clock)
        self.assertEqual(list(target.iterdir()), [])

    def test_log_symlink_and_replaced_active_file_are_rejected(self):
        victim = self.put("victim", "KEEP_PRIVATE")
        writer = self.writer(record_limit=256, file_bytes=512, max_bytes=1024)
        writer.write({"first": 1})
        active = self.root / "logs" / writer.name
        active.unlink()
        active.symlink_to(victim)
        with self.assertRaises(MODULE.LogSecurityError):
            writer.write({"second": 2})
        self.assertEqual(victim.read_text(), "KEEP_PRIVATE")

    def test_foreign_matching_log_symlink_is_never_followed(self):
        victim = self.put("victim", "KEEP_PRIVATE")
        logdir = self.root / "logs"
        logdir.mkdir()
        (logdir / "host-memory-20261001T000000Z-aaaaaaaaaaaa.jsonl").symlink_to(victim)
        writer = self.writer()
        with self.assertRaises(MODULE.LogSecurityError):
            writer.write({"sample": 1})
        self.assertEqual(victim.read_text(), "KEEP_PRIVATE")

    def test_once_ignores_log_directory_and_has_no_fixture_writes(self):
        logdir = self.root / "must-not-exist"
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run([sys.executable, str(SCRIPT), "--once", "--log-dir", str(logdir)],
                                cwd=self.root, env=env, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLessEqual(len(result.stdout), 65536)
        self.assertEqual(json.loads(result.stdout)["schema"], 1)
        self.assertFalse(logdir.exists())


if __name__ == "__main__":
    unittest.main()
