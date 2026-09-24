"""Offline keeper/worker/CLI lifecycle tests; only kill own test processes."""
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).parent
KEEPER = HERE / "box_keeper.py"
SUPERVISOR = HERE / "box_supervisor.py"


class KeeperTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="ocv5-289-keeper-"))
        raw = SUPERVISOR.read_bytes() + f"\n# keeper-test-{secrets.token_hex(8)}\n".encode()
        digest = hashlib.sha256(raw).hexdigest()[:16]
        self.staged = Path("/tmp") / f"ocv5-289-supervisor-{digest}.py"
        self.staged.write_bytes(raw)
        self.staged.chmod(0o600)
        self.processes = []

    def tearDown(self) -> None:
        for proc in self.processes:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=3)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None:
                    stream.close()
        shutil.rmtree(self.tmp)
        # Content-addressed stage is reused by tests; remove only our hash.
        self.staged.unlink(missing_ok=True)

    def command(self, code: str) -> list[str]:
        return [sys.executable, str(KEEPER), str(self.staged), "--deadline", "8",
                "--kill-after", ".1", "--max-output", "262144", "--",
                sys.executable, "-c", code]

    def start(self, code: str, env: dict | None = None) -> subprocess.Popen:
        proc = subprocess.Popen(self.command(code), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env={**os.environ, **(env or {})})
        self.processes.append(proc)
        return proc

    def await_file(self, file: Path) -> None:
        until = time.monotonic() + 4
        while time.monotonic() < until and not file.exists():
            time.sleep(.01)
        self.assertTrue(file.exists(), f"{file.name} absent")

    def test_normal_stdout_and_nonzero_status_are_preserved(self) -> None:
        ok = self.start('print("keeper-ok")')
        out, err = ok.communicate(timeout=12)
        self.assertEqual((ok.returncode, out, err), (0, b"keeper-ok\n", b""))
        bad = self.start('import sys;sys.exit(7)')
        out, _ = bad.communicate(timeout=12)
        self.assertEqual((bad.returncode, out), (7, b""))

    def test_worker_sigkill_adopts_and_stops_cli_without_recycled_pgid(self) -> None:
        ready = self.tmp / "ready"
        proc = self.start('import time;time.sleep(30)',
                          {"OCV5_SUPERVISOR_READY_FILE": str(ready)})
        self.await_file(ready)
        cli_pid, _watchdog_pid = map(int, ready.read_text().split())
        children_file = Path(f"/proc/{proc.pid}/task/{proc.pid}/children")
        workers = [int(x) for x in children_file.read_text().split()]
        self.assertEqual(len(workers), 1)
        os.kill(workers[0], signal.SIGKILL)
        proc.communicate(timeout=12)
        self.assertEqual(proc.returncode, 137)
        # CLI leader may briefly be a zombie until keeper reaps it; after
        # keeper exits it must not remain a runnable process.
        try:
            status = Path(f"/proc/{cli_pid}/stat").read_text()
            self.assertIn(status.split(") ", 1)[1][0], "ZX")
        except FileNotFoundError:
            pass

    def test_report_missing_before_gate_fails_closed(self) -> None:
        child_file = self.tmp / "child"
        proc = self.start('import time;time.sleep(30)', {
            "OCV5_SUPERVISOR_TEST_CHILD_PID_FILE": str(child_file),
            "OCV5_SUPERVISOR_TEST_PRE_WATCH_DELAY": "2" })
        self.await_file(child_file)
        workers = [int(x) for x in Path(
            f"/proc/{proc.pid}/task/{proc.pid}/children").read_text().split()]
        self.assertEqual(len(workers), 1)
        os.kill(workers[0], signal.SIGKILL)
        proc.communicate(timeout=12)
        self.assertEqual(proc.returncode, 126)


if __name__ == "__main__":
    unittest.main()
