import base64
import copy
import importlib.util
import json
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'lib/v5-validation-receipt.py'
spec = importlib.util.spec_from_file_location('receipt', SCRIPT)
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


def sample():
    return dict(schemaVersion=1, executingDeploymentId='owner-1',
                scope=dict(profile='skip-grok', operationId='owner-1',
                           sourceSha='a' * 40, queueId='rq-20261103T000000Z-123456abcdef',
                           authorizationRef='explicit-user-scope'),
                phase='running', releaseUnderTest='/candidate',
                grokMatrix='SKIPPED', grokJourney='SKIPPED',
                deepseekMatrix='pending', deepseekJourney='pending')


class ReceiptTest(unittest.TestCase):
    def test_cannot_report_unrun_checks_as_passed(self):
        value = sample()
        value['phase'] = 'passed'
        with self.assertRaises(ValueError):
            receipt.validate(value, 'owner-1')

    def test_atomic_results_keep_original_scope_and_private_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'receipts'
            value = sample()
            receipt.persist(root, 'owner-1', value)
            result = root / 'owner-1.json'
            self.assertEqual(result.stat().st_mode & 0o777, 0o600)
            value.update(phase='passed', deepseekMatrix='passed', deepseekJourney='passed')
            receipt.persist(root, 'owner-1', value)
            self.assertEqual(json.loads(result.read_text()), value)
            changed = copy.deepcopy(value)
            changed['scope']['sourceSha'] = 'b' * 40
            with self.assertRaises(ValueError):
                receipt.persist(root, 'owner-1', changed)
            self.assertEqual(json.loads(result.read_text()), value)

    def test_symlink_receipt_and_wrong_owner_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'receipts'
            root.mkdir(mode=0o700)
            target = Path(tmp) / 'unrelated'
            target.write_text('preserve')
            (root / 'owner-1.json').symlink_to(target)
            with self.assertRaises(ValueError):
                receipt.persist(root, 'owner-1', sample())
            self.assertEqual(target.read_text(), 'preserve')
            with self.assertRaises(ValueError):
                receipt.validate(sample(), 'another-owner')

    @unittest.skipUnless(Path('/proc/self/fdinfo').exists(), 'real Linux flock verification')
    def test_cli_requires_real_owner_flock_and_rejects_wrong_admission(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lock = root / 'lock'
            child = r'''
import fcntl,json,os,sys,time
from pathlib import Path
p=Path(sys.argv[1]); fd=os.open(p,os.O_RDWR|os.O_CREAT,0o600)
if fd != 9: os.dup2(fd,9); os.close(fd)
fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)
m=Path(str(p)+'.meta')
m.write_text(json.dumps(dict(deploy_id='owner-1',remote_pid=os.getpid(),started_at=time.time(),ttl=30)))
m.chmod(0o600)
Path(str(p)+'.admission-nonce').write_text('own-admission')
print('ready',flush=True)
sys.stdin.read()
'''
            proc = subprocess.Popen([sys.executable, '-c', child, str(lock)],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            try:
                self.assertTrue(select.select([proc.stdout], [], [], 3)[0])
                self.assertEqual(proc.stdout.readline().strip(), 'ready')
                value = sample()
                encoded = base64.b64encode(json.dumps(value).encode()).decode()
                args = [sys.executable, str(SCRIPT), str(root / 'receipts'),
                        'owner-1', str(lock), 'own-admission', encoded]
                ran = subprocess.run(args, capture_output=True, text=True, timeout=4)
                self.assertEqual(ran.returncode, 0, ran.stderr)
                self.assertEqual(json.loads((root / 'receipts/owner-1.json').read_text()), value)
                args[-2] = 'wrong-admission'
                refused = subprocess.run(args, capture_output=True, text=True, timeout=4)
                self.assertNotEqual(refused.returncode, 0)
                self.assertIn('admission differs', refused.stderr)
            finally:
                proc.communicate(input='', timeout=3)


if __name__ == '__main__':
    unittest.main()
