"""Real local supervisor red/green for a legitimate 1.1 MB tool echo."""
from pathlib import Path
import subprocess
import sys
import unittest

SUPERVISOR = Path(__file__).with_name("box_supervisor.py")
WRITER = 'import sys;sys.stdout.write("x"*1100000)'


class SupervisorOutputBudgetTest(unittest.TestCase):
    def run_writer(self, limit: int) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run([
            sys.executable, "-I", str(SUPERVISOR), "--deadline", "10",
            "--max-output", str(limit), "--", sys.executable, "-I", "-c", WRITER,
        ], capture_output=True, timeout=15)

    def test_large_echo_no_longer_truncates_or_exits_unknown(self) -> None:
        before = self.run_writer(1_048_576)
        self.assertEqual(before.returncode, 125)
        self.assertEqual(len(before.stdout), 1_048_576)
        after = self.run_writer(64 * 1024 * 1024)
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertEqual(len(after.stdout), 1_100_000)
        self.assertEqual(after.stderr, b"")


if __name__ == "__main__":
    unittest.main()
