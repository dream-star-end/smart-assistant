#!/usr/bin/env python3
"""Focused own-tree admission proofs; run through rf-heavy on the shared host."""

import importlib.util
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/lib/v5-selfhost-load-budget.py"
SHELL = ROOT / "scripts/lib/v5-selfhost-load-budget.sh"
spec = importlib.util.spec_from_file_location("selfhost_load_budget", HELPER)
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)


def stat(pid, parent, start, state="S"):
    # comm deliberately contains spaces/parentheses, so splitting the full row fails.
    fields = [state, str(parent)] + ["0"] * 17 + [str(start)]
    return f"{pid} (fixture (task)) " + " ".join(fields) + "\n"


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="oc-load-budget-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.proc = self.dir / "proc"
        (self.proc / "sys/kernel/random").mkdir(parents=True)
        (self.proc / "sys/kernel/random/boot_id").write_text("fixture-boot")
        self.process(100, 1, 1000)
        self.tree = budget.ProcessTree(self.proc, 100, 1000, "fixture-boot")

    def process(self, pid, parent, start, states=("S",)):
        path = self.proc / str(pid)
        if isinstance(states, str):
            states = (states,)
        (path / "task").mkdir(parents=True, exist_ok=True)
        (path / "stat").write_text(stat(pid, parent, start, states[0]))
        for index, state in enumerate(states):
            tid = pid + index
            thread = path / "task" / str(tid)
            thread.mkdir(exist_ok=True)
            (thread / "stat").write_text(stat(tid, parent, start + index, state))

    def test_own_children_grandchildren_and_thread_states(self):
        self.process(200, 100, 2000, ("S", "R", "D", "R"))
        self.process(300, 200, 3000, "R")
        self.process(400, 1, 4000, "R")
        self.assertEqual(self.tree.sample(), (4, 1))
        self.assertIn((300, 3000), self.tree.owned)
        self.assertNotIn((400, 4000), self.tree.owned)

    def test_observer_is_owned_but_cannot_manufacture_own_credit(self):
        self.process(200, 100, 2000, "R")
        tree = budget.ProcessTree(self.proc, 100, 1000, "fixture-boot", observer_pid=200)
        self.assertEqual(tree.sample(), (0, 0))
        self.assertIn((200, 2000), tree.owned)

    def test_external_sleeping_leader_has_nine_runnable_threads(self):
        self.process(400, 1, 4000, ("S",) + ("R",) * 9)
        self.assertEqual(self.tree.sample(), (0, 9))
        self.assertEqual(budget.effective_load(2, 1.5, 1, 9), 9)

    def test_observed_orphan_and_its_children_stay_owned(self):
        self.process(200, 100, 2000, "R")
        self.tree.sample()
        self.process(200, 1, 2000, "R")
        self.process(300, 200, 3000, "R")
        self.process(400, 1, 4000, "R")  # Never proven a descendant: remains external.
        self.assertEqual(self.tree.sample(), (2, 1))

    def test_reused_owned_pid_does_not_exclude_external_work(self):
        self.process(200, 100, 2000, "R")
        self.tree.sample()
        self.process(200, 1, 9999, "R")
        self.assertEqual(self.tree.sample(), (0, 1))
        self.assertNotIn((200, 9999), self.tree.owned)

    def test_root_reuse_boot_change_and_permission_failure_reject_sample(self):
        self.process(100, 1, 9999)
        with self.assertRaises(budget.InvalidSample):
            self.tree.sample()
        self.process(100, 1, 1000)
        (self.proc / "sys/kernel/random/boot_id").write_text("different-boot")
        with self.assertRaises(budget.InvalidSample):
            self.tree.sample()
        (self.proc / "sys/kernel/random/boot_id").write_text("fixture-boot")
        self.process(400, 1, 4000, "R")
        original = budget.proc_stat
        def unreadable(path):
            if "/400/" in str(path):
                raise PermissionError("external task cannot be silently omitted")
            return original(path)
        with patch.object(budget, "proc_stat", side_effect=unreadable):
            with self.assertRaises(PermissionError):
                self.tree.sample()

    def snapshot(self, **changes):
        self.process(500, 100, 5000)
        state = {"schema": 1, "rootPid": 100, "rootStart": 1000,
                 "boot": "fixture-boot", "samplerPid": 500, "samplerStart": 5000,
                 "at": 100.0, "own": 10.0, "external": 2.0, "externalNow": 1}
        state.update(changes)
        path = self.dir / "snapshot.json"
        budget.write_state(path, state)
        return path

    def read(self, path, raw=12.0, now=101.0):
        return budget.read_budget(self.proc, 100, 1000, "fixture-boot", path, raw, now)

    def test_snapshot_identity_freshness_and_numbers(self):
        self.assertEqual(self.read(self.snapshot()), 2)
        for change in [{"at": 97}, {"at": 102}, {"boot": "old-boot"},
                       {"rootStart": 9999}, {"samplerStart": 9999},
                       {"own": math.nan}, {"external": -1}, {"externalNow": True}]:
            with self.subTest(change=change):
                with self.assertRaises((budget.InvalidSample, ValueError)):
                    self.read(self.snapshot(**change))
        with self.assertRaises(FileNotFoundError):
            self.read(self.dir / "missing")
        bad = self.dir / "bad"
        bad.write_text("{broken")
        with self.assertRaises(ValueError):
            self.read(bad)
        path = self.snapshot()
        (self.proc / "500/stat").unlink()
        with self.assertRaises(FileNotFoundError):
            self.read(path)

    def test_shell_fallback_and_raw_scaling(self):
        lib = (ROOT / "scripts/v5-selfhost-master-release-lib.sh").read_text()
        function = lambda name: re.search(r"^" + name + r"\(\) \{[^\n]*\n[\s\S]*?^\}", lib, re.M)[0]
        load = self.dir / "loadavg"
        load.write_text("12.00 0 0 1/1 1\n")
        path = self.snapshot(at=time.monotonic())
        script = f'''
set -euo pipefail
source {str(SHELL)!r}
{function("master_gate_load1")}
{function("master_gate_load_scale")}
{function("master_gate_busy_reason")}
{function("master_gate_wait_host_idle")}
MASTER_GATE_LOADAVG={str(load)!r}
MASTER_GATE_PROC_ROOT={str(self.proc)!r}
MASTER_BOX_GATE_LOAD_MAX=8
MASTER_GATE_LOAD_SCALE_MAX=3
MASTER_GATE_LOAD_BUDGET_DIR={str(path.parent)!r}
MASTER_GATE_LOAD_BUDGET_ROOT=100
MASTER_GATE_LOAD_BUDGET_ROOT_START=1000
MASTER_GATE_LOAD_BUDGET_BOOT=fixture-boot
MASTER_GATE_ADMISSION_BUDGET=0
MASTER_GATE_TEST_LOCK_DIR={str(self.dir)!r}
MASTER_GATE_IDLE_TIMEOUT_S=0
tsum_note() {{ :; }}
mlog() {{ :; }}
master_gate_wait_host_idle fixture
[[ "$(master_gate_load1)" == 12.00 ]]
MASTER_GATE_ADMISSION_BUDGET=1
[[ "$(master_gate_load1)" == 2.000000 ]]
[[ "$(master_gate_load_scale)" == 1.50 ]]
rm {str(path)!r}
[[ "$(master_gate_load1)" == 12.00 ]]
echo malformed >"$MASTER_GATE_LOADAVG"
[[ -z "$(master_gate_load1)" ]]
'''
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


class Arithmetic(unittest.TestCase):
    def test_sustained_own_cpu_demand_can_admit_without_changing_threshold(self):
        estimate = budget.Estimate(2, 0)
        for second in range(1, 301):
            estimate.update(12, 2, second)
        effective = budget.effective_load(14, estimate.own, estimate.external, 2)
        self.assertLess(effective, 8)
        self.assertGreaterEqual(effective, 2)
        self.assertEqual(budget.effective_load(7.99, 0, 7.99, 1), 7.99)
        self.assertEqual(budget.effective_load(8, 0, 8, 1), 8)

    def test_startup_lag_external_history_and_all_external_work_remain_busy(self):
        estimate = budget.Estimate(8.5, 0)
        self.assertEqual(estimate.own, 0)
        self.assertEqual(budget.effective_load(8.5, estimate.own, estimate.external, 9), 9)
        self.assertEqual(budget.effective_load(14, 10, 9, 0), 9)
        for name in ("rf-heavy", "node --test", "npm run build"):
            with self.subTest(work=name):
                # Classification is identity-based: exterior workload names grant no exemption.
                self.assertEqual(budget.effective_load(14, 10, 8, 8), 8)

    def test_exited_own_and_external_history_decay_instead_of_disappearing(self):
        estimate = budget.Estimate(9, 0)
        estimate.update(12, 0, 1)
        own, external = estimate.own, estimate.external
        estimate.update(0, 0, 2)
        self.assertGreater(estimate.own, 0)
        self.assertLess(estimate.own, own)
        self.assertGreater(estimate.external, 8)
        self.assertLess(estimate.external, external)
        self.assertEqual(budget.effective_load(2, 100, 1, 0), 1)
        for now in (1, 0, 10):
            with self.subTest(now=now):
                with self.assertRaises(budget.InvalidSample):
                    budget.Estimate(1, 1).update(1, 1, now)


class Integration(unittest.TestCase):
    def test_real_busy_grandchild_is_owned_but_busy_sibling_is_external(self):
        busy = "while True: pass"
        child_code = ("import subprocess,sys,time; "
                      f"p=subprocess.Popen([sys.executable,'-c',{busy!r}]); "
                      "print(p.pid,flush=True); time.sleep(30)")
        root_code = ("import subprocess,sys,time,json; "
                     f"p=subprocess.Popen([sys.executable,'-c',{child_code!r}],stdout=subprocess.PIPE,text=True); "
                     "grand=int(p.stdout.readline()); print(json.dumps([p.pid,grand]),flush=True); time.sleep(30)")
        root = subprocess.Popen([sys.executable, "-c", root_code], stdout=subprocess.PIPE,
                                text=True, start_new_session=True)
        exterior = subprocess.Popen([sys.executable, "-c", busy], start_new_session=True)
        try:
            child, grandchild = json.loads(root.stdout.readline())
            proc = Path("/proc")
            tree = budget.ProcessTree(proc, root.pid, budget.identity(proc, root.pid), budget.boot_id(proc))
            own, outside = tree.sample()
            self.assertIn((child, budget.identity(proc, child)), tree.owned)
            self.assertIn((grandchild, budget.identity(proc, grandchild)), tree.owned)
            self.assertNotIn((exterior.pid, budget.identity(proc, exterior.pid)), tree.owned)
            self.assertGreaterEqual(own, 1)
            self.assertGreaterEqual(outside, 1)
        finally:
            for process in (root, exterior):
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)
            root.stdout.close()

    def test_production_wiring_starts_before_work_and_cleans_up_after_drain(self):
        lib = (ROOT / "scripts/v5-selfhost-master-release-lib.sh").read_text()
        build = re.search(r"^build_master_release\(\) \{[^\n]*\n[\s\S]*?^\}", lib, re.M)[0]
        self.assertLess(build.index("[dry-run]"), build.index("master_gate_load_budget_start"))
        self.assertLess(build.index("master_gate_load_budget_start"), build.index("master_gate_wait_host_idle admission"))
        self.assertLess(build.index("master_gate_load_budget_start"), build.index('start_runtime_release_bg "$full_sha"'))
        deploy = (ROOT / "scripts/deploy-v5-selfhost.sh").read_text()
        cleanup = re.search(r"^cleanup_selfhost_deploy\(\) \{[^\n]*\n[\s\S]*?^\}", deploy, re.M)[0]
        self.assertLess(cleanup.index("reap_runtime_release_bg || true"), cleanup.index("master_gate_load_budget_stop"))
        self.assertLess(cleanup.index("reap_master_build_jobs"), cleanup.index("master_gate_load_budget_stop"))
        jobs = (ROOT / "scripts/lib/v5-selfhost-build-jobs.sh").read_text()
        self.assertIn("monitor=0 MASTER_GATE_ADMISSION_BUDGET=1", jobs)
        self.assertIn('reason="" MASTER_GATE_ADMISSION_BUDGET=1', lib)
        # Host-idle test mutex detection remains independent of load subtraction.
        busy = re.search(r"^master_gate_busy_reason\(\) \{[^\n]*\n[\s\S]*?^\}", lib, re.M)[0]
        self.assertIn('reasons+=("test-mutex:${name%.lock}")', busy)

    def test_inherited_state_is_cleared_and_sampler_lifecycle_is_private(self):
        with tempfile.TemporaryDirectory(prefix="oc-load-lifecycle-") as directory:
            script = f'''
set -euo pipefail
MASTER_GATE_LOAD_BUDGET_DIR=/must-not-be-used
MASTER_GATE_LOAD_BUDGET_ROOT=1
MASTER_GATE_ADMISSION_BUDGET=1
source {str(SHELL)!r}
[[ -z "$MASTER_GATE_LOAD_BUDGET_DIR" && -z "$MASTER_GATE_LOAD_BUDGET_ROOT" ]]
[[ "$MASTER_GATE_ADMISSION_BUDGET" == 0 ]]
MASTER_GATE_PROC_ROOT=/proc
MASTER_GATE_LOADAVG=/proc/loadavg
TMPDIR={directory!r}
exec 8>"$TMPDIR/lock"
flock -x 8
master_gate_load_budget_start
dir="$MASTER_GATE_LOAD_BUDGET_DIR"
pid="$MASTER_GATE_LOAD_BUDGET_PID"
[[ "$MASTER_GATE_LOAD_BUDGET_ROOT" == "$$" && -d "$dir" ]]
for attempt in {{1..60}}; do
  [[ ! -f "$dir/snapshot.json" ]] || break
  sleep .05
done
[[ -f "$dir/snapshot.json" ]]
exec 8>&-
flock -n "$TMPDIR/lock" true
master_gate_load_budget_start
[[ "$MASTER_GATE_LOAD_BUDGET_PID" == "$pid" ]]
master_gate_load_budget_stop
[[ ! -e "$dir" ]]
! kill -0 "$pid" 2>/dev/null
'''
            result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            # A failed post-spawn identity probe must not wait forever on a live child.
            failed_probe = script.replace('master_gate_load_budget_stop\n',
                                          'MASTER_GATE_LOAD_BUDGET_START=""\nmaster_gate_load_budget_stop\n')
            failed_probe = failed_probe.replace('! kill -0 "$pid" 2>/dev/null', 'printf "%s" "$pid"')
            result = subprocess.run(["bash", "-c", failed_probe], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            sampler_pid = int(result.stdout)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                try:
                    budget.identity(Path("/proc"), sampler_pid)
                except (OSError, ValueError):
                    break
                time.sleep(.05)
            else:
                self.fail("unverified sampler did not exit after root loss")


if __name__ == "__main__":
    unittest.main()
