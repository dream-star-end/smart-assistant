"""Offline keeper/worker/CLI lifecycle tests; only kill own test processes."""
import hashlib
import ctypes
import json
import os
from pathlib import Path
import re
import runpy
import select
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
    def test_detached_worker_budget_uses_verified_deadline_not_old_140s(self) -> None:
        budget = runpy.run_path(str(KEEPER))["worker_budget"]
        self.assertEqual(budget(["--deadline", "900", "--", "echo"]), 930)
        self.assertEqual(budget(["--deadline", "901", "--", "echo"]), 140)

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="ocv5-289-keeper-"))
        raw = SUPERVISOR.read_bytes() + f"\n# keeper-test-{secrets.token_hex(8)}\n".encode()
        digest = hashlib.sha256(raw).hexdigest()[:16]
        self.staged = Path("/tmp") / f"ocv5-289-supervisor-{digest}.py"
        self.staged.write_bytes(raw)
        self.staged.chmod(0o600)
        self.processes = []
        self.proofs = []

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
        for proof in self.proofs:
            shutil.rmtree(proof, ignore_errors=True)

    def proof_args(self) -> tuple[list[str], Path, str]:
        nonce, epoch = secrets.token_hex(12), secrets.token_hex(16)
        proof = Path('/tmp') / f'ocv5-289-proof-{nonce}'
        self.proofs.append(proof)
        return ['--proof-dir', str(proof), '--lease-epoch', epoch], proof, epoch

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
        while time.monotonic() < until:
            try:
                raw = file.read_bytes()
                pattern = rb"^[1-9][0-9]* [1-9][0-9]*\n$" if file.name == "ready" \
                    else rb"^[1-9][0-9]*$"
                if re.fullmatch(pattern, raw):
                    return
            except FileNotFoundError:
                pass
            time.sleep(.01)
        self.fail(f"{file.name} complete PID frame absent")

    def test_normal_stdout_and_nonzero_status_are_preserved(self) -> None:
        ok = self.start('print("keeper-ok")')
        out, err = ok.communicate(timeout=12)
        self.assertEqual((ok.returncode, out, err), (0, b"keeper-ok\n", b""))
        bad = self.start('import sys;sys.exit(7)')
        out, _ = bad.communicate(timeout=12)
        self.assertEqual((bad.returncode, out), (7, b""))

    def test_terminal_marker_only_after_full_keeper_reap(self) -> None:
        options, proof, epoch = self.proof_args()
        command = self.command('print("done")')
        command[3:3] = options
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(proc)
        out, err = proc.communicate(timeout=12)
        self.assertEqual((proc.returncode, out, err), (0, b'done\n', b''))
        marker = proof / 'terminal.json'
        self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
        self.assertEqual(proof.stat().st_mode & 0o777, 0o700)
        result = json.loads(marker.read_text())
        self.assertEqual((result['runNonce'], result['leaseEpoch'], result['reason'],
                          result['revision']), (proof.name[-24:], epoch, 'worker_complete', 1))
        self.assertEqual(result['keeperPid'], proc.pid)

    def test_failed_cli_has_no_terminal_marker_without_worker_proof(self) -> None:
        options, proof, _ = self.proof_args()
        command = self.command('import sys;sys.exit(7)')
        command[3:3] = options
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(proc)
        proc.communicate(timeout=12)
        self.assertEqual(proc.returncode, 7)
        self.assertFalse((proof / 'terminal.json').exists())

    def test_escaped_descendant_blocks_terminal_proof(self) -> None:
        options, proof, _ = self.proof_args()
        escaped_file = self.tmp / 'escaped'
        code = ('import os,subprocess;'
                'p=subprocess.Popen(["/usr/bin/sleep","30"],start_new_session=True,'
                'stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);'
                'open(os.environ["KEEPER_ESCAPED_FILE"],"w").write(str(p.pid))')
        command = self.command(code)
        command[3:3] = options
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={**os.environ, 'KEEPER_ESCAPED_FILE': str(escaped_file)})
        self.processes.append(proc)
        try:
            self.await_file(escaped_file)
            proc.communicate(timeout=12)
            self.assertEqual(proc.returncode, 125)
            self.assertFalse((proof / 'terminal.json').exists())
        finally:
            if escaped_file.exists():
                try: os.kill(int(escaped_file.read_text()), signal.SIGKILL)
                except ProcessLookupError: pass

    def test_worker_sigkill_adopts_and_stops_cli_without_recycled_pgid(self) -> None:
        libc = ctypes.CDLL(None, use_errno=True)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0,
                         "test process must be subreaper to observe orphan zombies")
        ready = self.tmp / "ready"
        descendant = self.tmp / "descendant"
        options, proof, epoch = self.proof_args()
        code = ('import os,subprocess,time;'
                'p=subprocess.Popen(["/usr/bin/sleep","30"]);'
                'open(os.environ["KEEPER_TEST_DESCENDANT"],"w").write(str(p.pid));'
                'time.sleep(30)')
        try:
            command = self.command(code)
            command[3:3] = options
            proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={**os.environ, "OCV5_SUPERVISOR_READY_FILE": str(ready),
                     "KEEPER_TEST_DESCENDANT": str(descendant)})
            self.processes.append(proc)
            self.await_file(ready)
            self.await_file(descendant)
            cli_pid, watcher_pid = map(int, ready.read_text().split())
            descendant_pid = int(descendant.read_text())
            children_file = Path(f"/proc/{proc.pid}/task/{proc.pid}/children")
            workers = [int(x) for x in children_file.read_text().split()]
            self.assertEqual(len(workers), 1)
            os.kill(workers[0], signal.SIGKILL)
            proc.communicate(timeout=12)
            self.assertEqual(proc.returncode, 137)
            marker = json.loads((proof / 'terminal.json').read_text())
            self.assertEqual((marker['runNonce'], marker['leaseEpoch'], marker['reason']),
                             (proof.name[-24:], epoch, 'keeper_stopped'))
            # As the nearest living subreaper, T would inherit any C/watcher/
            # descendant left unreaped by P. ECHILD is the actual outcome;
            # merely allowing Z state would miss an ownership leak.
            with self.assertRaises(ChildProcessError):
                os.waitpid(-1, os.WNOHANG)
            for pid in (cli_pid, watcher_pid, descendant_pid):
                self.assertFalse(Path(f"/proc/{pid}").exists(),
                                 f"keeper left its own PID {pid} behind")
        finally:
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                    if pid == 0:
                        break
                except ChildProcessError:
                    break
            libc.prctl(36, 0, 0, 0, 0)

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

    def test_output_backpressure_cancel_is_prompt(self) -> None:
        proc = self.start('import os;os.write(1,b"x"*200000)')
        time.sleep(.5)  # leave parent stdout PIPE unread so W blocks in writer
        began = time.monotonic()
        proc.terminate()
        proc.wait(timeout=3)
        self.assertEqual(proc.returncode, 143)
        self.assertLess(time.monotonic() - began, 1.5)

    def test_first_stdout_is_visible_while_cli_is_still_running(self) -> None:
        release = self.tmp / "release"
        code = ('import os,sys,time;'
                'sys.stdout.write("first\\n");sys.stdout.flush();'
                'p=os.environ["KEEPER_TEST_RELEASE"];'
                '\nwhile not os.path.exists(p):time.sleep(.01)\n'
                'sys.stdout.write("second\\n");sys.stdout.flush()')
        proc = self.start(code, {"KEEPER_TEST_RELEASE": str(release)})
        try:
            ready, _, _ = select.select([proc.stdout], [], [], 2)
            self.assertTrue(ready, "supervisor buffered first delta until CLI exit")
            first = os.read(proc.stdout.fileno(), 256)
            self.assertEqual(first, b"first\n")
            self.assertIsNone(proc.poll(), "CLI/keeper must still be live")
        finally:
            release.write_text("go")
        rest, err = proc.communicate(timeout=10)
        self.assertEqual((proc.returncode, first + rest, err),
                         (0, b"first\nsecond\n", b""))

    def test_startup_deadline_fences_cli_before_execution_gate(self) -> None:
        for deadline_args in (["--deadline", ".2"], ["--deadline=.2"],
                              ["--deadline", "8", "--deadline=.2"]):
            with self.subTest(deadline_args=deadline_args):
                marker = self.tmp / ("would-have-executed-" + str(len(self.processes)))
                code = ('import os;open(os.environ["KEEPER_TEST_EXEC_MARKER"],"w").write("paid")')
                command = [sys.executable, str(KEEPER), str(self.staged), *deadline_args,
                           "--kill-after", ".1", "--max-output", "262144", "--",
                           sys.executable, "-c", code]
                began = time.monotonic()
                proc = subprocess.Popen(command, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env={**os.environ,
                                            "OCV5_SUPERVISOR_TEST_PRE_WATCH_DELAY": "1",
                                            "KEEPER_TEST_EXEC_MARKER": str(marker)})
                self.processes.append(proc)
                proc.communicate(timeout=4)
                self.assertEqual(proc.returncode, 124)
                self.assertLess(time.monotonic() - began, 1.5)
                self.assertFalse(marker.exists(), "CLI must not run after startup budget")


if __name__ == "__main__":
    unittest.main()
