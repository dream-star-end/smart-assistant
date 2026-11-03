#!/usr/bin/env python3
"""Short Linux kernel regression: an escaped Bash-style child cannot write after Stop."""
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


@unittest.skipUnless(sys.platform == 'linux', 'Linux child/pidfd implementation')
class ToolHostStop(unittest.TestCase):
    def test_stop_reaps_escaped_child_before_clean_proof(self):
        source = Path(__file__).with_name('cc5-toolhost-supervisor.py').resolve()
        with tempfile.TemporaryDirectory(prefix='cc5-stop-') as temporary:
            root = Path(temporary)
            ready, marker, proof = root / 'ready', root / 'late-write', root / 'stopped.json'
            escaped = ('import os,time; from pathlib import Path; os.setsid(); '
                       f'Path({str(ready)!r}).write_text("ready"); time.sleep(.6); '
                       f'Path({str(marker)!r}).write_text("unsafe")')
            child_code = ('import subprocess,sys,time; '
                          f'subprocess.Popen([sys.executable,"-c",{escaped!r}]); time.sleep(30)')
            lifecycle = str(uuid.uuid4())
            loader = ('import importlib.util; '
                      f's=importlib.util.spec_from_file_location("supervisor",{str(source)!r}); '
                      'm=importlib.util.module_from_spec(s);s.loader.exec_module(m); '
                      f'raise SystemExit(m.supervise([{sys.executable!r},"-c",{child_code!r}],{str(proof)!r},{lifecycle!r}))')
            worker = subprocess.Popen([sys.executable, '-I', '-B', '-c', loader],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                until = time.monotonic() + 2
                while not ready.exists() and time.monotonic() < until:
                    if worker.poll() is not None:
                        self.fail('supervisor exited before real escaped child readiness')
                    time.sleep(.01)
                self.assertTrue(ready.exists())
                worker.send_signal(signal.SIGTERM)
                self.assertEqual(worker.wait(timeout=3), 0)
                record = json.loads(proof.read_text())
                self.assertEqual(record['lifecycleId'], lifecycle)
                self.assertEqual(record['supervisorPid'], worker.pid)
                self.assertTrue(record['localStopped'])
                time.sleep(.65)
                self.assertFalse(marker.exists(), 'escaped child wrote after Stop proof')
            finally:
                if worker.poll() is None:
                    worker.kill()
                    worker.wait(timeout=2)
                worker.stderr.close()


if __name__ == '__main__':
    unittest.main()
