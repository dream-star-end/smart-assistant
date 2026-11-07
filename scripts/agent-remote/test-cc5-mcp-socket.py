#!/usr/bin/env python3
"""Real ordinary Python helper, AF_UNIX and stdio frames; no SSH, Claude or model."""
import base64
from concurrent.futures import ThreadPoolExecutor
import http.client
import hashlib
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
CATALOG = {'tools': [
    {'name': 'Read', 'description': 'Read a file.', 'inputSchema': {'type': 'object'}},
    {'name': 'Edit', 'description': 'Edit a file.', 'inputSchema': {'type': 'object'}},
    {'name': 'Bash', 'description': 'Run a command.', 'inputSchema': {'type': 'object'}},
]}
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


@unittest.skipUnless(sys.platform.startswith('linux'), 'real SO_PEERCRED and /proc fixture requires Linux')
class SocketBridge(unittest.TestCase):
    def install_session(self, root):
        (root / 'session').mkdir(mode=0o700)
        catalog = json.dumps(CATALOG, separators=(',', ':'))
        prompt = b'fixture prompt\n'
        manifest = {'version': 1, 'task': 'AGENT-REMOTE-T1555U', 'root': str(root),
                    'catalogSha256': hashlib.sha256(catalog.encode()).hexdigest(),
                    'promptSha256': hashlib.sha256(prompt).hexdigest()}
        for name, data in (('catalog.json', catalog.encode()), ('prompt.md', prompt),
                           ('SESSION.json', json.dumps(manifest).encode())):
            (root / 'session' / name).write_bytes(data)
            (root / 'session' / name).chmod(0o400)

    def fixture(self, session=True):
        Path('.task-tmp').mkdir(exist_ok=True, mode=0o700)
        root = Path(os.path.relpath(tempfile.mkdtemp(prefix='cc5-socket-', dir='.task-tmp'), os.getcwd()))
        (root / 'cprofile').mkdir(mode=0o700)
        shutil.copyfile(CLIENT, root / 'cprofile/cc5-fixed-mcp.py')
        (root / 'cprofile/cc5-fixed-mcp.py').chmod(0o400)
        config = {'version': 2, 'operationId': str(uuid4()), 'runId': str(uuid4())}
        (root / 'cprofile/client.json').write_text(json.dumps(config))
        (root / 'cprofile/client.json').chmod(0o400)
        if session:
            self.install_session(root)
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        return (root, config, self.start(root, config))

    def start(self, root, config):
        child = subprocess.Popen([sys.executable, '-I', '-B', '-c', WRAPPER, str(HELPER), str(root)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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
        self.assertEqual(ready['version'], 2)
        return child

    def test_a_later_start_round_on_the_same_root_serves_new_tools_but_never_redispatches_old_ones(self):
        root, config, child = self.fixture()
        with ThreadPoolExecutor(max_workers=1) as executor:
            done = self.body(config, 'Read', 1, 'toolu_done')
            result = executor.submit(self.rpc, root, done)
            self.assertEqual(self.frame(child)['seq'], 1)
            exact = self.respond(child, done, 1)
            self.assertEqual(result.result(timeout=5), (200, exact))
            unknown = self.body(config, 'Bash', 2, 'toolu_unknown')
            result = executor.submit(self.rpc, root, unknown)
            self.assertEqual(self.frame(child)['seq'], 2)
            child.stdin.close()  # Round ends after dispatch: the Bash result is unknown.
            self.assertNotEqual(result.result(timeout=5)[0], 200)
        child.wait(timeout=3)
        (root / 'MCP-SOCKET.json').unlink()  # The controller's rotate drops the old round's identity.

        second = self.start(root, config)
        self.assertEqual(json.loads((root / 'MCP-SOCKET.json').read_text())['pid'], second.pid)
        with ThreadPoolExecutor(max_workers=1) as executor:
            for old in (done, unknown):
                self.assertNotEqual(self.rpc(root, {**old, 'rpcId': 50})[0], 200)
            self.assertFalse(select.select([second.stdout], [], [], 0)[0], 'old tool uses are never sent again')
            fresh = self.body(config, 'Edit', 3, 'toolu_fresh')
            result = executor.submit(self.rpc, root, fresh)
            self.assertEqual(self.frame(second)['seq'], 1)
            exact = self.respond(second, fresh, 1)
            self.assertEqual(result.result(timeout=5), (200, exact))
        second.stdin.close(); second.wait(timeout=3)
        self.assertEqual(second.returncode, 0)

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

    def body(self, config, tool='Read', ident=17, tool_id='toolu_original'):
        args = {'Read': {'file_path': '资料.txt'}, 'Edit': {'file_path': 'f', 'old_string': 'a', 'new_string': 'b'},
                'Bash': {'command': 'pwd', 'timeout': 30000}}[tool]
        return {'runId': config['runId'], 'operationId': config['operationId'], 'rpcId': ident,
            'toolUseId': tool_id, 'name': 'mcp__ocbridge__' + tool, 'arguments': args,
            'inputSha256': hashlib.sha256(json.dumps(args, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()}

    def respond(self, child, body, seq):
        receipt = {key: body[key] for key in ('runId', 'operationId', 'rpcId', 'toolUseId', 'name', 'inputSha256')}
        receipt.update({'version': 2, 'ok': True, 'result': {'content': [{'type': 'text', 'text': 'fixture result'}], 'isError': False}})
        exact = json.dumps(receipt, separators=(',', ':')).encode()
        child.stdin.write(json.dumps({'version': 2, 'kind': 'tool-response', 'seq': seq,
            'status': 200, 'body': base64.b64encode(exact).decode()}).encode() + b'\n')
        child.stdin.flush()
        return exact

    def test_three_real_unix_requests_preserve_bytes_ids_and_sequence_then_cleanup_only_socket(self):
        root, config, child = self.fixture()
        self.assertEqual((root / 'tool.sock').stat().st_mode & 0o777, 0o600)
        with ThreadPoolExecutor(max_workers=1) as executor:
            for seq, tool in enumerate(('Read', 'Edit', 'Bash'), 1):
                body = self.body(config, tool, seq + 16, 'toolu_' + str(seq))
                result = executor.submit(self.rpc, root, body)
                request = self.frame(child)
                self.assertEqual((request['version'], request['seq']), (2, seq))
                self.assertEqual(json.loads(base64.b64decode(request['body'])), body)
                exact = self.respond(child, body, seq)
                self.assertEqual(result.result(timeout=5), (200, exact))
                # Both RPC-ID and tool-ID duplication reject without another SSH frame.
                self.assertNotEqual(self.rpc(root, body)[0], 200)
                changed = {**body, 'rpcId': 100 + seq}
                self.assertNotEqual(self.rpc(root, changed)[0], 200)
                self.assertFalse(select.select([child.stdout], [], [], 0)[0])
        self.assertEqual(len(list((root / 'tool-attempts').glob('*.attempt.json'))), 3)
        self.assertEqual(len(list((root / 'tool-attempts').glob('*.result.json'))), 3)
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
                        child.stdin.write(json.dumps({'version': 2, 'kind': 'tool-response', 'seq': 2,
                            'status': 200, 'body': ''}).encode() + b'\n')
                        child.stdin.flush()
                    self.assertNotEqual(result.result(timeout=5)[0], 200)
                child.wait(timeout=3)
                self.assertEqual(child.returncode, 1)
                attempts = list((root / 'tool-attempts').glob('*.attempt.json'))
                self.assertEqual(len(attempts), 1)
                self.assertEqual(json.loads(attempts[0].read_text())['seq'], 1)
                self.assertEqual(list((root / 'tool-attempts').glob('*.result.json')), [])
                self.assertFalse((root / 'tool.sock').exists())
                self.assertEqual(child.stdout.read(), b'', 'no second tool dispatch')

    def test_a_round_starts_the_socket_before_the_lane_catalog_and_serves_it_once_installed(self):
        # Real round order: tool-socket, then session-profile, then launch.
        root, config, child = self.fixture(session=False)
        self.assertFalse((root / 'session').exists())
        self.assertNotEqual(self.rpc(root, self.body(config))[0], 200)
        self.assertFalse(select.select([child.stdout], [], [], 0)[0], 'no frame without a catalog')
        self.install_session(root)
        with ThreadPoolExecutor(max_workers=1) as executor:
            body = self.body(config, 'Edit', 7, 'toolu_after_install')
            result = executor.submit(self.rpc, root, body)
            self.assertEqual(self.frame(child)['seq'], 1)
            exact = self.respond(child, body, 1)
            self.assertEqual(result.result(timeout=5), (200, exact))
        child.stdin.close(); child.wait(timeout=3)
        self.assertEqual(child.returncode, 0)

    def test_wrong_rpc_id_type_is_rejected_before_attempt_or_ssh_frame(self):
        root, config, child = self.fixture()
        body = self.body(config); body['rpcId'] = True
        self.assertNotEqual(self.rpc(root, body)[0], 200)
        self.assertEqual(list((root / 'tool-attempts').iterdir()), [])
        child.stdin.close(); child.wait(timeout=3)
        self.assertEqual(child.returncode, 0)
        self.assertEqual(child.stdout.read(), b'')


if __name__ == '__main__': unittest.main()
