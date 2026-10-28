#!/usr/bin/env python3
"""P5: real SQLite/flock/process behavior, wholly inside a temporary workspace."""
import fcntl
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("priority", ROOT / "scripts/lib/test-train-priority.py")
PRIORITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PRIORITY)


class TrainPriority(unittest.TestCase):
    @contextmanager
    def database(self):
        # sqlite3.Connection's context manager commits but does NOT close.
        # Close deterministically: otherwise live WAL pages can repair the
        # deliberately corrupted main file and turn that fixture into a valid DB.
        db = sqlite3.connect(self.db)
        try:
            with db:
                yield db
        finally:
            db.close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="test-train-priority-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for rel in ("scripts/lib", "packages/web-react", "packages/gateway/src", "locks", "bin"):
            (self.root / rel).mkdir(parents=True)
        for rel in ("scripts/test-mutex.sh", "scripts/check-test-train-priority.sh",
                    "scripts/lib/test-train-priority.sh", "scripts/lib/test-train-priority.py"):
            shutil.copyfile(ROOT / rel, self.root / rel)
        self.db = self.root / "lease.db"
        # Use the real lease schema; just extract its DDL, never source/init a host DB.
        lib = (ROOT / "scripts/v5-lease-lib.sh").read_text()
        ddl = lib.split("<<'SQL'\n", 1)[1].split("\nSQL", 1)[0]
        with self.database() as db:
            db.executescript(ddl)
        self.deploy = self.root / "deploy.lock"
        self.deploy.touch()
        self.sentinel = self.root / "executed"
        self.env = {
            "PATH": os.environ["PATH"], "HOME": str(self.root),
            "OC_V5_LEASE_DB": str(self.db), "OC_V5_SELFHOST_DEPLOY_LOCK": str(self.deploy),
            "OC_TEST_MUTEX_LOCK_DIR": str(self.root / "locks"), "OC_TEST_MUTEX_TIMEOUT": "20",
            "TEST_SENTINEL": str(self.sentinel),
        }

    def train(self, status, pid=None, resource="deploy:selfhost"):
        with self.database() as db:
            db.execute("""INSERT INTO train(id,resource,target_sha,status,owner,executor_pid,created_at,updated_at)
                VALUES('tr-fixture', ?, ?, ?, 'fixture', ?, 'now','now')""", (resource, "a" * 40, status, pid))

    def lease(self, status, mode="drive", resource="deploy:selfhost"):
        with self.database() as db:
            db.execute("""INSERT INTO lease(id,resource,mode,status,owner,owner_uid,created_at,updated_at)
                VALUES('ls-fixture',?,?,?,'fixture','fixture','now','now')""", (resource, mode, status))

    def run_mutex(self, command='touch "$TEST_SENTINEL"', *args, env=None, family="fixture"):
        return subprocess.run(["bash", str(self.root / "scripts/test-mutex.sh"), family, command, *args],
                              cwd=self.root, env=env or self.env, text=True, capture_output=True, timeout=15)

    def lock(self, path):
        handle = open(path, "a+")
        self.addCleanup(handle.close)
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle

    def start(self, argv, log, env=None):
        output = open(log, "w+")
        self.addCleanup(output.close)
        proc = subprocess.Popen(argv, cwd=self.root, env=env or self.env,
                                stdout=output, stderr=output, start_new_session=True)
        def clean():
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, 9)
                    proc.wait(timeout=5)
        self.addCleanup(clean)
        return proc

    def until(self, condition, detail):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.02)
        self.fail(detail)

    def assert_refused(self, result, code=75):
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        self.assertIn("wait-for-trains.sh", result.stderr)
        self.assertFalse(self.sentinel.exists())
        self.assertFalse(any((self.root / "locks").glob("*.holder")))

    def test_all_open_train_states_refuse_before_lock_or_command(self):
        for state in ("planned", "building", "cutover", "recovery_required"):
            with self.subTest(state=state):
                with self.database() as db:
                    db.execute("DELETE FROM train")
                self.train(state)
                before = self.db.read_bytes()
                self.assert_refused(self.run_mutex())
                self.assertEqual(self.db.read_bytes(), before)
                self.assertEqual(list((self.root / "locks").iterdir()), [])

    def test_terminal_and_other_resource_trains_allow(self):
        for state, resource in (("committed", "deploy:selfhost"), ("failed", "deploy:selfhost"),
                                ("building", "deploy:other")):
            with self.subTest(state=state, resource=resource):
                with self.database() as db:
                    db.execute("DELETE FROM train")
                self.train(state, resource=resource)
                result = self.run_mutex("exit 17")
                self.assertEqual(result.returncode, 17, result.stderr)

    def test_granted_lease_blocks_but_queued_and_terminal_leases_allow(self):
        self.lease("granted")
        self.assert_refused(self.run_mutex())
        for state in ("registered", "done", "revoked", "cancelled", "failed", "satisfied"):
            with self.subTest(state=state):
                with self.database() as db:
                    db.execute("UPDATE lease SET status=?", (state,))
                result = self.run_mutex("exit 0")
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_default_state_absence_is_allowed_without_creating_it(self):
        missing = str(self.root / "absent.db")
        with patch.dict(os.environ, {}, clear=True), patch.object(PRIORITY, "DEFAULT_DB", missing):
            self.assertEqual(PRIORITY.read_state(), ([], []))
        self.assertFalse(Path(missing).exists())

    def test_configured_missing_corrupt_or_unsupported_state_fails_closed(self):
        missing = self.root / "missing.db"
        self.assert_refused(self.run_mutex(env={**self.env, "OC_V5_LEASE_DB": str(missing)}), 2)
        self.assertFalse(missing.exists())
        self.db.write_text("not SQLite")
        self.assert_refused(self.run_mutex(), 2)
        self.db.unlink()
        with self.database() as db:
            db.execute("CREATE TABLE wrong_schema(id)")
        self.assert_refused(self.run_mutex(), 2)

    def test_invalid_deploy_lock_paths_fail_closed(self):
        self.deploy.unlink()
        self.assert_refused(self.run_mutex(), 2)
        self.deploy.symlink_to(self.db)
        self.assert_refused(self.run_mutex(), 2)

    def test_held_deploy_lock_refuses_even_before_train_registration(self):
        self.lock(self.deploy)
        self.assert_refused(self.run_mutex())
        self.assertEqual(list((self.root / "locks").iterdir()), [])

    def test_admission_check_is_inside_short_shared_deploy_lock(self):
        ready, release = self.root / "admission-ready", self.root / "admission-release"
        # Pause the external state reader, at a real process boundary. A train
        # must not acquire its exclusive lock between this read and test admission.
        shim = self.root / "bin/python3"
        shim.write_text('#!/bin/bash\ntouch "$TEST_READY"\n'
                        'while [ ! -f "$TEST_RELEASE" ]; do sleep 0.02; done\n'
                        'exec /usr/bin/python3 "$@"\n')
        shim.chmod(0o755)
        env = {**self.env, "PATH": str(shim.parent) + ":" + self.env["PATH"],
               "TEST_READY": str(ready), "TEST_RELEASE": str(release)}
        log = self.root / "admission.log"
        proc = self.start(["bash", "scripts/test-mutex.sh", "fixture", "exit 0"], log, env)
        self.until(ready.exists, "admission reader not reached")
        with open(self.deploy) as fd:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        release.touch()
        self.assertEqual(proc.wait(timeout=8), 0, log.read_text())
        self.lock(self.deploy)

    def test_claimed_owner_environment_does_not_bypass(self):
        self.train("building", pid=os.getpid())
        self.assert_refused(self.run_mutex(env={**self.env, "CI": "true",
            "OC_V5_SELFHOST_DEPLOY_LOCK_HELD": "1", "OC_V5_LEASE_TRAIN_ID": "tr-fixture"}))

    def test_waiting_test_yields_to_train_without_waiting_for_test_holder(self):
        lock = self.root / "locks/oc-test-fixture.lock"
        handle = self.lock(lock)
        holder = Path(str(lock) + ".holder")
        holder.write_text("existing holder")
        log = self.root / "waiter.log"
        proc = self.start(["bash", "scripts/test-mutex.sh", "fixture", 'touch "$TEST_SENTINEL"'], log)
        self.until(lambda: "被占" in log.read_text(), "waiter did not reach family mutex")
        self.train("planned")
        self.assertEqual(proc.wait(timeout=8), 75, log.read_text())
        self.assertIn("wait-for-trains.sh", log.read_text())
        self.assertEqual(holder.read_text(), "existing holder")
        self.assertFalse(self.sentinel.exists())
        handle.close()

    def test_existing_holder_continues_and_does_not_hold_deploy_admission_lock(self):
        log = self.root / "holder.log"
        proc = self.start(["bash", "scripts/test-mutex.sh", "fixture",
            'touch "$TEST_SENTINEL"; while [ ! -f release ]; do sleep 0.05; done; exit 19'], log)
        self.until(self.sentinel.exists, "test command never started")
        # A train can take its exclusive lock while the admitted test finishes.
        deploy = self.lock(self.deploy)
        self.train("building")
        self.assertIsNone(proc.poll())
        denied = self.run_mutex("exit 99", family="second")
        self.assertEqual(denied.returncode, 75, denied.stderr)
        (self.root / "release").touch()
        self.assertEqual(proc.wait(timeout=8), 19, log.read_text())
        self.assertFalse((self.root / "locks/oc-test-fixture.lock.holder").exists())
        deploy.close()
        with self.database() as db:
            db.execute("UPDATE train SET status='committed'")
        self.assertEqual(self.run_mutex("exit 0").returncode, 0)

    def test_waiting_test_runs_after_family_lock_release(self):
        handle = self.lock(self.root / "locks/oc-test-fixture.lock")
        log = self.root / "released.log"
        proc = self.start(["bash", "scripts/test-mutex.sh", "fixture", 'touch "$TEST_SENTINEL"'], log)
        self.until(lambda: "被占" in log.read_text(), "waiter did not wait")
        handle.close()
        self.assertEqual(proc.wait(timeout=8), 0, log.read_text())
        self.assertTrue(self.sentinel.exists())

    def owner_launcher(self, variant="valid", command="exit 23"):
        script = self.root / "owner.py"
        script.write_text('''import fcntl, os, sqlite3, subprocess, sys, time
lock = os.environ["OC_V5_SELFHOST_DEPLOY_LOCK"]
variant = sys.argv[1]
if variant == "inherited":
    while os.getppid() == int(sys.argv[3]): time.sleep(0.02)
else:
    fd = os.open(lock, os.O_RDWR)
    os.dup2(fd, 8)
    fcntl.flock(8, fcntl.LOCK_EX)
if variant == "wrong-inode":
    os.dup2(8, 7)
    wrong = os.open(lock + ".wrong", os.O_CREAT | os.O_RDWR, 0o600)
    os.dup2(wrong, 8)
    fcntl.flock(8, fcntl.LOCK_EX)
elif variant == "no-flock":
    fcntl.flock(8, fcntl.LOCK_UN)
with sqlite3.connect(os.environ["OC_V5_LEASE_DB"]) as db:
    db.execute("UPDATE train SET executor_pid=?", (os.getpid(),))
if variant == "sibling":
    open("owner-ready", "w").close()
    while not os.path.exists("owner-release"): time.sleep(0.02)
    sys.exit(0)
# An intermediary that detaches the proof and passes only the fixture paths.
# Owner flags/train-id are absent, as in the real callback supervisor.
code = "import subprocess,sys; sys.exit(subprocess.run(sys.argv[1:], start_new_session=True).returncode)"
rc = subprocess.run([sys.executable, "-c", code, "bash", "scripts/test-mutex.sh",
                     "commercial-proof", sys.argv[2]], env=dict(os.environ)).returncode
if variant == "inherited": open("inherited-result", "w").write(str(rc))
sys.exit(rc)
''')
        return ["python3", str(script), variant, command]

    def test_proven_train_descendant_runs_with_detached_scrubbed_child(self):
        self.train("building")
        result = subprocess.run(self.owner_launcher(), env=self.env, cwd=self.root,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 23, result.stderr)

    def test_proven_train_accepts_worker_inherited_flock_after_worker_exit(self):
        self.train("building")
        owner = self.owner_launcher("inherited")
        worker = self.root / "worker.py"
        worker.write_text('''import fcntl,os,subprocess,sys
fd = os.open(os.environ["OC_V5_SELFHOST_DEPLOY_LOCK"], os.O_RDWR)
os.dup2(fd, 8)
fcntl.flock(8, fcntl.LOCK_EX)
subprocess.Popen([*sys.argv[1:], str(os.getpid())], pass_fds=(8,))
''')
        result = subprocess.run(["python3", str(worker), *owner], env=self.env, cwd=self.root,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "inherited-result").read_text(), "23", result.stderr)

    def test_ancestor_without_kernel_lock_or_with_wrong_inode_is_refused(self):
        self.train("building")
        for variant in ("wrong-inode", "no-flock"):
            with self.subTest(variant=variant):
                result = subprocess.run(self.owner_launcher(variant), env=self.env, cwd=self.root,
                                        capture_output=True, text=True, timeout=15)
                self.assert_refused(result)

    def test_sibling_cannot_borrow_live_train_owner_identity(self):
        self.train("building")
        log = self.root / "owner.log"
        proc = self.start(self.owner_launcher("sibling"), log)
        self.until((self.root / "owner-ready").exists, "owner not ready")
        self.assert_refused(self.run_mutex(family="commercial-proof"))
        (self.root / "owner-release").touch()
        self.assertEqual(proc.wait(timeout=8), 0, log.read_text())

    def test_train_proof_still_obeys_its_family_mutex(self):
        self.train("building")
        handle = self.lock(self.root / "locks/oc-test-commercial-proof.lock")
        log = self.root / "proof.log"
        proc = self.start(self.owner_launcher(), log)
        self.until(lambda: "被占" in log.read_text(), "train proof bypassed its mutex")
        self.assertIsNone(proc.poll())
        handle.close()
        self.assertEqual(proc.wait(timeout=8), 23, log.read_text())

    def test_arguments_exit_code_and_watchdog_are_preserved(self):
        result = self.run_mutex('printf "<%s>\\n" "$@"; exit 7', "a b", "$(touch injected)", "--reporter=dot")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["<a b>", "<$(touch injected)>", "<--reporter=dot>"])
        self.assertFalse((self.root / "injected").exists())
        result = self.run_mutex("exec sleep 30", env={**self.env, "OC_TEST_MUTEX_TIMEOUT": "0.2"})
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertFalse(any((self.root / "locks").glob("*.holder")))
        self.lock(self.root / "locks/oc-test-fixture.lock")  # no orphan retaining fd 9

    def test_no_lock_directory_fallback_still_checks_train_and_preserves_args(self):
        env = {**self.env, "OC_TEST_MUTEX_LOCK_DIR": str(self.root / "absent")}
        result = self.run_mutex('printf "%s" "$1"', "a b", env=env)
        self.assertEqual((result.returncode, result.stdout), (0, "a b"))
        self.train("building")
        self.assert_refused(self.run_mutex(env=env))

    def npm_fixture(self):
        package = json.loads((ROOT / "package.json").read_text())
        package["workspaces"] = ["packages/web-react"]
        (self.root / "package.json").write_text(json.dumps(package))
        shutil.copyfile(ROOT / "packages/web-react/package.json", self.root / "packages/web-react/package.json")
        binaries = self.root / "node_modules/.bin"
        binaries.mkdir(parents=True)
        for name in ("npx", "vitest"):
            binary = binaries / name
            binary.write_text('#!/usr/bin/env python3\nimport json,os,sys\n'
                              'open(os.environ["TEST_SENTINEL"], "w").write(json.dumps(sys.argv[1:]))\n')
            binary.chmod(0o755)

    def test_npm_root_and_workspace_entrypoints_refuse_before_test_binaries(self):
        self.npm_fixture()
        self.train("planned")
        for args in (["test"], ["run", "test:gateway"], ["run", "test:commercial"],
                     ["run", "test:commercial:unit"], ["run", "test:commercial:integ"],
                     ["run", "test:web-react"], ["test", "--workspace", "packages/web-react"]):
            with self.subTest(args=args):
                result = subprocess.run(["npm", *args], cwd=self.root, env=self.env,
                                        capture_output=True, text=True, timeout=15)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("wait-for-trains.sh", result.stderr)
                self.assertFalse(self.sentinel.exists())

    def test_web_react_npm_arguments_reach_vitest(self):
        self.npm_fixture()
        result = subprocess.run(["npm", "run", "test:web-react", "--", "a b.test.ts", "--reporter=dot"],
                                cwd=self.root, env=self.env, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(self.sentinel.read_text()), ["run", "a b.test.ts", "--reporter=dot"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
