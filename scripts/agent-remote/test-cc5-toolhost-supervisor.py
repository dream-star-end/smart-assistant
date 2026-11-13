#!/usr/bin/env python3
"""The tool host runs the fixed full-profile command and reaps escaped children."""
import importlib.util
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


def load_supervisor():
    source = Path(__file__).with_name('cc5-toolhost-supervisor.py').resolve()
    spec = importlib.util.spec_from_file_location('cc5_toolhost_supervisor', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ToolHostCommand(unittest.TestCase):
    def test_supervisor_runs_the_full_profile_host_command(self):
        module = load_supervisor()
        node = '/opt/node/bin/node'
        entry = Path('/srv/openclaude/claude-code-best/dist/cli-node.js')
        profile = '/run/user/1000/cc5/host-profile.json'
        self.assertEqual(
            module.command_for(node, entry, profile),
            [node, str(entry), 'mcp', 'serve', '--tool-profile', 'full',
             '--host-profile', profile])

    def test_main_rejects_incomplete_or_relative_arguments_before_spawning(self):
        module = load_supervisor()
        with tempfile.TemporaryDirectory(prefix='cc5-argv-') as temporary:
            root = Path(temporary)
            proof, profile = root / 'stopped.json', root / 'host-profile.json'
            lifecycle = str(uuid.uuid4())
            node = str(Path(sys.executable).resolve())

            def main_with(*argv):
                previous = sys.argv
                sys.argv = ['cc5-toolhost-supervisor.py', *argv]
                try:
                    return module.main()
                finally:
                    sys.argv = previous

            for argv in [
                (),
                (node,),
                (node, str(proof)),
                (node, str(proof), lifecycle),
                ('node', str(proof), lifecycle, str(profile)),
                (node, str(root / 'proof.json'), lifecycle, str(profile)),
                (node, str(proof), 'not-a-lifecycle', str(profile)),
                (node, str(proof), lifecycle, 'relative-profile.json'),
                (node, str(proof), lifecycle, str(profile), 'extra'),
            ]:
                with self.subTest(argv=argv):
                    self.assertEqual(main_with(*argv), 126)


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
