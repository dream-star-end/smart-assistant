#!/usr/bin/env python3
"""No Claude, network TCP or credentials. Real AF_UNIX MCP-client fixture only."""
import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import socketserver
import sys
import tempfile
import threading
import unittest
import uuid

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("cc5_fixed_mcp", Path(__file__).with_name("cc5-fixed-mcp.py"))
mcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mcp)


controller_spec = importlib.util.spec_from_file_location("cc5_controller", Path(__file__).with_name("cc5-host-controller.py"))
controller = importlib.util.module_from_spec(controller_spec)
controller_spec.loader.exec_module(controller)


class ProductionRoot(unittest.TestCase):
    def test_unpatched_root_rule_accepts_exactly_the_controller_task_roots_of_this_account(self):
        home = str(Path.home())
        run_id = "t20261106t1200z-abcdef0123456789"
        packaged = home + "/oc-agentremote-" + run_id  # Same shape package(run_id, home) emits.
        self.assertTrue(controller.NODE_ROOT.fullmatch(packaged) or not re.fullmatch(r"/home/[^/]+", home))
        self.assertTrue(mcp.ROOT.fullmatch(packaged))
        self.assertEqual(str(controller.task_root(packaged)), packaged)
        for bad in ("/home/someoneelse/oc-agentremote-" + run_id, home + "/oc-agentremote-short",
                    home + "/other-" + run_id, home + "/oc-agentremote-" + run_id + "/x"):
            with self.subTest(root=bad):
                self.assertFalse(mcp.ROOT.fullmatch(bad))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.cwd = Path.cwd()
        self.temp = tempfile.TemporaryDirectory(prefix="cc5-mcp-", dir=os.environ["TMPDIR"])
        os.chdir(self.temp.name)
        self.root = Path("r")
        self.root.mkdir(mode=0o700)
        (self.root / "cprofile").mkdir(mode=0o700)
        self.config = {"version": 2, "operationId": str(uuid.uuid4()), "runId": str(uuid.uuid4())}
        config_file = self.root / "cprofile/client.json"
        config_file.write_text(json.dumps(self.config))
        config_file.chmod(0o600)
        self.original_root = mcp.ROOT
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(os.chdir, self.cwd)
        self.addCleanup(setattr, mcp, 'ROOT', self.original_root)
        # Real production-root rejection is tested before selecting the private relative fixture.
        with self.assertRaises(ValueError):
            mcp.read_config(self.root)
        mcp.ROOT = re.compile(r"r\Z")
        self.calls = []
        self.response_mode = "ok"
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.assert_path = self.path
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fixture.calls.append(data)
                if fixture.response_mode == "disconnect":
                    self.close_connection = True
                    return
                rpc_id = data["rpcId"]
                result = {'content': [{'type': 'text', 'text': 'synthetic known result'}], 'isError': False}
                value = {"version": 2, "ok": True, 'runId': data['runId'], "operationId": data["operationId"],
                         "toolUseId": data["toolUseId"], "rpcId": rpc_id, 'name': data['name'],
                         'inputSha256': data['inputSha256'], 'result': result}
                if fixture.response_mode == "rpc-type-conflict":
                    value["rpcId"] = str(rpc_id)
                if fixture.response_mode == "invalid-is-error": result['isError'] = 0
                if fixture.response_mode == "hash-conflict": value['inputSha256'] = '0' * 64
                if fixture.response_mode == "known-tool-error": result['isError'] = True
                if fixture.response_mode == "image": result['content'] = [{'type': 'image', 'data': 'YQ==', 'mimeType': 'image/png'}]
                body = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

        self.server = Server(str(self.root / "tool.sock"), Handler)
        (self.root / "tool.sock").chmod(0o600)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        mcp.ROOT = self.original_root
        os.chdir(self.cwd)
        self.temp.cleanup()

    def params(self, **changed):
        value = {"name": "Read", "arguments": {'file_path': '资料.txt', 'limit': 5},
                 "_meta": {"claudecode/toolUseId": "toolu_observed"}}
        value.update(changed)
        return value

    def test_actual_unix_preserves_model_and_rpc_ids_separately(self):
        self.assertEqual(mcp.read_config(self.root), self.config)
        result = mcp.call_tool(self.root, self.config, 17, self.params())
        self.assertFalse(result["isError"])
        self.assertEqual(len(self.calls), 1)
        request = self.calls[0]
        self.assertEqual(request["rpcId"], 17)
        self.assertEqual(request["toolUseId"], "toolu_observed")
        self.assertEqual(request["runId"], self.config["runId"])
        self.assertEqual(request["name"], "mcp__ocbridge__Read")
        self.assertEqual(request['inputSha256'], mcp.hashlib.sha256('{"file_path":"资料.txt","limit":5}'.encode()).hexdigest())
        self.assertEqual(result['content'][0]['text'], 'synthetic known result')

    def test_missing_meta_same_ids_or_extra_command_never_reaches_socket(self):
        for ident, params in [(17, self.params(_meta={})),
                              ("toolu_observed", self.params()),
                              (17, self.params(arguments={'file_path': 'f', 'command': 'touch outside'})),
                              (17, self.params(name="roundtrip")),
                              (17, self.params(name='Bash', arguments={'command': 'pwd', 'run_in_background': False})),
                              (17, self.params(name='Bash', arguments={'command': 'pwd', 'timeout': 30001})),
                              (17, self.params(arguments={'file_path': '\ud800'})),
                              (17, self.params(arguments={'file_path': 'f', 'limit': 1.0}))]:
            with self.subTest(ident=ident, params=params), self.assertRaises(ValueError):
                mcp.call_tool(self.root, self.config, ident, params)
        self.assertEqual(self.calls, [])

    def test_response_type_or_terminal_conflict_is_not_success_and_never_retried(self):
        for mode in ["rpc-type-conflict", "invalid-is-error", 'hash-conflict']:
            self.response_mode = mode
            before = len(self.calls)
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                mcp.call_tool(self.root, self.config, 17, self.params())
            self.assertEqual(len(self.calls), before + 1)

    def test_disconnect_is_unknown_without_a_retry(self):
        self.response_mode = "disconnect"
        with self.assertRaises(http.client.RemoteDisconnected):
            mcp.call_tool(self.root, self.config, 17, self.params())
        self.assertEqual(len(self.calls), 1)

    def run_stdio(self, messages):
        wire = io.BytesIO(("\n".join(json.dumps(row) for row in messages) + "\n").encode())
        source = type("Input", (), {"buffer": wire})()
        old_stdin, old_argv = sys.stdin, sys.argv
        output = io.StringIO()
        try:
            sys.stdin = source
            sys.argv = ["fixture", str(self.root)]
            with contextlib.redirect_stdout(output): status = mcp.main()
        finally:
            sys.stdin, sys.argv = old_stdin, old_argv
        return status, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_actual_stdio_dispatch_lists_three_tools_and_allows_distinct_rpc_not_reused_tools(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": self.params()},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": self.params()},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": self.params(name='Edit',
                arguments={'file_path': 'f', 'old_string': 'a', 'new_string': 'b'}, _meta={'claudecode/toolUseId': 'toolu_second'})},
            {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": self.params(name='Bash',
                arguments={'command': 'pwd', 'timeout': 30000}, _meta={'claudecode/toolUseId': 'toolu_third'})},
        ]
        status, rows = self.run_stdio(messages)
        self.assertEqual(status, 0)
        self.assertEqual(rows[0]["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual([tool["name"] for tool in rows[1]["result"]["tools"]], ['Read', 'Edit', 'Bash'])
        self.assertEqual(rows[2]["id"], 3)
        self.assertFalse(rows[2]["result"]["isError"])
        self.assertEqual(rows[3]["id"], 4)
        self.assertEqual(rows[3]["error"]["code"], -32602)
        self.assertFalse(rows[4]['result']['isError'])
        self.assertFalse(rows[5]['result']['isError'])
        self.assertEqual([row['name'] for row in self.calls], ['mcp__ocbridge__Read', 'mcp__ocbridge__Edit', 'mcp__ocbridge__Bash'])

    def test_unknown_stops_stdio_before_another_distinct_tool_can_be_sent(self):
        self.response_mode = 'disconnect'
        status, rows = self.run_stdio([
            {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': self.params()},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': self.params(_meta={'claudecode/toolUseId': 'toolu_later'})},
        ])
        self.assertEqual(status, 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(self.calls), 1)

    def test_standard_image_content_and_known_tool_error_are_preserved(self):
        for mode in ('image', 'known-tool-error'):
            self.response_mode = mode
            result = mcp.call_tool(self.root, self.config, 17, self.params())
            self.assertEqual(result['isError'], mode == 'known-tool-error')
            self.assertEqual(result['content'][0]['type'], 'image' if mode == 'image' else 'text')


if __name__ == "__main__":
    unittest.main()
