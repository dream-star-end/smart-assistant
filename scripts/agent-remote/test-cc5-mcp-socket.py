#!/usr/bin/env python3
"""Real ordinary Python helper, AF_UNIX and stdio frames; no SSH, Claude or model."""
import base64
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import os
from pathlib import Path
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from uuid import uuid4

CLIENT = Path(__file__).with_name('cc5-fixed-mcp.py').resolve()
HELPER = Path(__file__).with_name('cc5-mcp-socket.py').resolve()
# Only the fixture imports and substitutes the existing client root policy;
# production has no option for this. First assert the original policy rejects it.
WRAPPER = '''import importlib.util,re,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('helper',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]);c=m.load_client(root)
try: c.read_config(root)
except ValueError: pass
else: raise AssertionError('original root policy unexpectedly accepted fixture')
c.ROOT=re.compile(re.escape(str(root))+r"\\Z")
sys.exit(m.run(root,c,sys.stdin.buffer,sys.stdout.buffer))
'''


class SocketBridge(unittest.TestCase):
    def fixture(self):
        root = Path(os.path.relpath(tempfile.mkdtemp(prefix='cc5-socket-', dir='.task-tmp'), os.getcwd()))
        (root / 'cprofile').mkdir(mode=0o700)
        shutil.copyfile(CLIENT, root / 'cprofile/cc5-fixed-mcp.py')
        (root / 'cprofile/cc5-fixed-mcp.py').chmod(0o400)
        config = {'version': 1, 'operationId': str(uuid4()), 'runId': str(uuid4())}
        (root / 'cprofile/client.json').write_text(json.dumps(config))
        (root / 'cprofile/client.json').chmod(0o400)
        child = subprocess.Popen([sys.executable, '-I', '-B', '-c', WRAPPER, str(HELPER), str(root)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        def cleanup():
            if child.poll() is None:
                child.stdin.close()
                try: child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.terminate(); child.wait(timeout=3)
            for stream in (child.stdin, child.stdout, child.stderr):
                if not stream.closed: stream.close()
        self.addCleanup(cleanup)
        ready = self.frame(child)
        self.assertEqual(ready['kind'], 'socket-ready')
        self.assertEqual(ready['operationId'], config['operationId'])
        self.assertEqual(ready['pid'], child.pid)
        return root, config, child

    def frame(self, child):
        self.assertTrue(select.select([child.stdout], [], [], 5)[0], 'bounded helper stdout wait')
        line = child.stdout.readline()
        self.assertTrue(line, 'fixture helper ended: ' + (child.stderr.read().decode() if not line else ''))
        return json.loads(line)

    def rpc(self, root, body):
        conn = http.client.HTTPConnection('localhost', timeout=5)
        conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.sock.settimeout(5)
        try:
            conn.sock.connect(str(root / 'tool.sock'))
            conn.request('POST', '/roundtrip', body=json.dumps(body), headers={'Content-Type': 'application/json'})
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def body(self, config):
        return {'runId': config['runId'], 'operationId': config['operationId'], 'rpcId': 17,
            'toolUseId': 'toolu_original', 'name': 'mcp__ocbridge__roundtrip',
            'arguments': {'operationId': config['operationId']}}

    def test_one_real_unix_request_preserves_bytes_and_ids_then_eof_cleans_only_own_socket(self):
        root, config, child = self.fixture()
        body = self.body(config)
        self.assertEqual((root / 'tool.sock').stat().st_mode & 0o777, 0o600)
        with ThreadPoolExecutor(max_workers=1) as executor:
            result = executor.submit(self.rpc, root, body)
            request = self.frame(child)
            self.assertEqual(request['seq'], 1)
            self.assertEqual(json.loads(base64.b64decode(request['body'])), body)
            receipt = {'ok': True, 'operationId': config['operationId'], 'rpcId': 17,
                'toolUseId': 'toolu_original', 'receipt': {'fixture': 'transport only, not a command receipt'}}
            exact = json.dumps(receipt, separators=(',', ':')).encode()
            child.stdin.write(json.dumps({'version': 1, 'kind': 'tool-response', 'seq': 1,
                'status': 200, 'body': base64.b64encode(exact).decode()}).encode() + b'\n')
            child.stdin.flush()
            self.assertEqual(result.result(timeout=5), (200, exact))
        self.assertTrue((root / 'tool-socket-attempt.json').exists())
        child.stdin.close(); child.wait(timeout=3)
        self.assertEqual(child.returncode, 0)
        self.assertFalse((root / 'tool.sock').exists())
        self.assertTrue((root / 'MCP-SOCKET.json').exists(), 'identity retained for independent exit proof')

    def test_eof_or_wrong_sequence_after_dispatch_never_retries(self):
        for case in ('eof', 'sequence'):
            with self.subTest(case=case):
                root, config, child = self.fixture()
                with ThreadPoolExecutor(max_workers=1) as executor:
                    result = executor.submit(self.rpc, root, self.body(config))
                    self.assertEqual(self.frame(child)['kind'], 'tool-request')
                    if case == 'eof': child.stdin.close()
                    else:
                        child.stdin.write(json.dumps({'version': 1, 'kind': 'tool-response', 'seq': 2,
                            'status': 200, 'body': ''}).encode() + b'\n')
                        child.stdin.flush()
                    self.assertNotEqual(result.result(timeout=5)[0], 200)
                child.wait(timeout=3)
                self.assertEqual(child.returncode, 1)
                self.assertTrue((root / 'tool-socket-attempt.json').exists())
                self.assertFalse((root / 'tool.sock').exists())
                self.assertEqual(child.stdout.read(), b'', 'no second tool dispatch')

    def test_wrong_rpc_id_type_is_rejected_before_attempt_or_ssh_frame(self):
        root, config, child = self.fixture()
        body = self.body(config); body['rpcId'] = True
        self.assertNotEqual(self.rpc(root, body)[0], 200)
        self.assertFalse((root / 'tool-socket-attempt.json').exists())
        child.stdin.close(); child.wait(timeout=3)
        self.assertEqual(child.returncode, 0)
        self.assertEqual(child.stdout.read(), b'')


if __name__ == '__main__': unittest.main()
