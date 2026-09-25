"""Local Linux proof for detached keeper spool; not evidence about Box cgroup."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).parent
RUNNER = HERE / "box_detached_runner.py"


class DetachedRunnerTest(unittest.TestCase):
    def test_isolated_python_rejects_adjacent_standard_library_shadow(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ocv5-289-isolated-") as directory:
            root = Path(directory)
            (root / "hashlib.py").write_text("raise RuntimeError('shadow imported')\n")
            child = root / "child.py"
            child.write_text("import hashlib;print(hashlib.sha256(b'ok').hexdigest())\n")
            unsafe = subprocess.run([sys.executable, str(child)], cwd=root,
                                    capture_output=True, text=True, timeout=5)
            self.assertNotEqual(unsafe.returncode, 0)
            self.assertIn("shadow imported", unsafe.stderr)
            isolated = subprocess.run([sys.executable, "-I", str(child)], cwd=root,
                                      capture_output=True, text=True, timeout=5)
            self.assertEqual(isolated.returncode, 0, isolated.stderr)
            self.assertEqual(len(isolated.stdout.strip()), 64)

    def setUp(self) -> None:
        self.nonce = secrets.token_hex(12)
        self.run_dir = Path(f"/tmp/ocv5-289-run-{self.nonce}")
        self.proof_dir = Path(f"/tmp/ocv5-289-proof-{self.nonce}")
        self.run_dir.mkdir(mode=0o700)
        self.assets = []
        for kind in ("keeper", "supervisor"):
            raw = (HERE / f"box_{kind}.py").read_bytes() + f"\n# detached-test-{secrets.token_hex(8)}\n".encode()
            digest = hashlib.sha256(raw).hexdigest()[:16]
            asset = Path(f"/tmp/ocv5-289-{kind}-{digest}.py")
            asset.write_bytes(raw)
            asset.chmod(0o600)
            self.assets.append(asset)

    def tearDown(self) -> None:
        shutil.rmtree(self.run_dir, ignore_errors=True)
        shutil.rmtree(self.proof_dir, ignore_errors=True)
        for asset in self.assets:
            asset.unlink(missing_ok=True)

    def run_fixed(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(RUNNER), *map(str, args)],
                              capture_output=True, text=True, timeout=12)

    def test_detached_keeper_streams_after_launch_exec_and_proves_terminal(self) -> None:
        code = ('import sys,time;sys.stdout.write("first\\n");sys.stdout.flush();'
                'time.sleep(1);sys.stdout.write("second\\n");sys.stdout.flush()')
        options = ["--proof-dir", str(self.proof_dir), "--lease-epoch", "a" * 32,
                   "--deadline", "900", "--kill-after", ".1", "--max-output", "262144",
                   "--", sys.executable, "-c", code]
        args = [str(self.run_dir), str(self.assets[0]), str(self.assets[1]), *options]
        launch = self.run_fixed(*args)
        self.assertEqual((launch.returncode, launch.stdout.strip()), (0, "launched"),
                         launch.stderr)
        duplicate = self.run_fixed(*args)
        self.assertNotEqual(duplicate.returncode, 0, "same run cannot launch a second CLI")
        import base64
        observed = None
        until_first = time.monotonic() + 3
        while time.monotonic() < until_first:
            first = self.run_fixed("--read", str(self.run_dir), "0", "65536")
            self.assertEqual(first.returncode, 0, first.stderr)
            observed = json.loads(first.stdout)
            if b"first\n" in base64.b64decode(observed["data"]):
                break
            time.sleep(.05)
        self.assertIsNotNone(observed)
        self.assertIn(b"first\n", base64.b64decode(observed["data"]))
        self.assertFalse((self.proof_dir / "terminal.json").exists(),
                         "first delta must precede remote terminal")
        until = time.monotonic() + 10
        while not (self.proof_dir / "terminal.json").exists() and time.monotonic() < until:
            time.sleep(.05)
        self.assertTrue((self.proof_dir / "terminal.json").exists())
        marker = json.loads((self.proof_dir / "terminal.json").read_text())
        self.assertEqual((marker["runNonce"], marker["leaseEpoch"], marker["reason"]),
                         (self.nonce, "a" * 32, "worker_complete"))
        rest = self.run_fixed("--read", str(self.run_dir), str(observed["offset"]), "65536")
        self.assertEqual(rest.returncode, 0, rest.stderr)
        self.assertIn(b"second\n", base64.b64decode(json.loads(rest.stdout)["data"]))
        stdout = self.run_dir / "stdout.jsonl"
        held = self.run_dir / "stdout.saved"
        stdout.rename(held)
        stdout.symlink_to("/etc/passwd")
        try:
            denied = self.run_fixed("--read", str(self.run_dir), "0", "65536")
            self.assertNotEqual(denied.returncode, 0)
        finally:
            stdout.unlink()
            held.rename(stdout)

    def test_symlinked_run_directory_cannot_launch_or_redirect_spool(self) -> None:
        backup = Path(f"{self.run_dir}.backup")
        decoy = Path(f"{self.run_dir}.decoy")
        decoy.mkdir(mode=0o700)
        self.run_dir.rename(backup)
        self.run_dir.symlink_to(decoy)
        try:
            result = self.run_fixed(str(self.run_dir), str(self.assets[0]),
                str(self.assets[1]), "--proof-dir", str(self.proof_dir),
                "--lease-epoch", "a" * 32, "--deadline", "8",
                "--kill-after", ".1", "--max-output", "262144",
                "--", sys.executable, "-c", "print('do-not-run')")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(decoy.iterdir()), [])
        finally:
            self.run_dir.unlink()
            backup.rename(self.run_dir)
            decoy.rmdir()

    def test_deadline_above_detached_cap_fails_before_launch(self) -> None:
        rejected = self.run_fixed(str(self.run_dir), str(self.assets[0]),
            str(self.assets[1]), "--proof-dir", str(self.proof_dir),
            "--lease-epoch", "a" * 32, "--deadline", "901",
            "--kill-after", ".1", "--max-output", "262144",
            "--", sys.executable, "-c", "print('must-not-run')")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertFalse((self.run_dir / "stdout.jsonl").exists())

    def test_abbreviated_or_duplicate_deadline_fails_before_launch(self) -> None:
        for deadline_args in (["--deadline", "110", "--dead", "900"],
                              ["--deadline", "110", "--deadline", "900"]):
            with self.subTest(deadline_args=deadline_args):
                rejected = self.run_fixed(str(self.run_dir), str(self.assets[0]),
                    str(self.assets[1]), "--proof-dir", str(self.proof_dir),
                    "--lease-epoch", "a" * 32, *deadline_args,
                    "--kill-after", ".1", "--max-output", "262144",
                    "--", sys.executable, "-c", "print('must-not-run')")
                self.assertNotEqual(rejected.returncode, 0)
                self.assertFalse((self.run_dir / "stdout.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
