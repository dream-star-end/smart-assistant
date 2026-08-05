import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


class SessionSupervisorTest(unittest.TestCase):
    def test_worker_activity_refreshes_deadline_before_expiry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release = root / "release"
            worker = release / "scripts/minimax_h3_worker/worker.py"
            worker.parent.mkdir(parents=True)
            worker.write_text(
                "import os, time\n"
                "from pathlib import Path\n"
                "Path(os.environ['H3_WORKER_STATE'], 'seen-supervisor-pid').write_text("
                "os.environ['H3_SESSION_SUPERVISOR_PID'])\n"
                "while True: time.sleep(1)\n"
            )
            state = root / "state"
            env = os.environ.copy()
            env.update({
                "SSH_CONNECTION": "127.0.0.1 1 127.0.0.1 2",
                "H3_WORKER_STATE": str(state),
                "H3_WORKER_RELEASE": str(release),
                "H3_SP_PYTHON": sys.executable,
            })
            supervisor = Path(__file__).with_name("session_supervisor.py")
            process = subprocess.Popen(
                [sys.executable, str(supervisor)],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                env=env,
            )
            try:
                process.stdin.write(b"lease\\n")
                process.stdin.flush()
                seen = state / "seen-supervisor-pid"
                for _ in range(50):
                    if seen.exists():
                        break
                    time.sleep(0.1)
                self.assertEqual(seen.read_text(), str(process.pid))
                time.sleep(11.5)
                self.assertIsNone(process.poll())
                os.kill(process.pid, signal.SIGUSR1)
                time.sleep(4.5)
                self.assertIsNone(process.poll())
                process.stdin.close()
                self.assertEqual(process.wait(timeout=15), 0)
                stderr = process.stderr.read().decode()
                process.stderr.close()
                self.assertIn("worker_activity_received signals=1", stderr)
                self.assertNotIn("heartbeat_timeout", stderr)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=15)


if __name__ == "__main__":
    unittest.main()
