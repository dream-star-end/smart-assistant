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


class Fixture(unittest.TestCase):
    def setUp(self):
        self.cwd = Path.cwd()
        self.temp = tempfile.TemporaryDirectory(prefix="cc5-mcp-", dir=os.environ["TMPDIR"])
        os.chdir(self.temp.name)
        self.root = Path("r")
        self.root.mkdir(mode=0o700)
        (self.root / "cprofile").mkdir(mode=0o700)
        self.config = {"version": 1, "operationId": str(uuid.uuid4()), "runId": str(uuid.uuid4())}
        config_file = self.root / "cprofile/client.json"
        config_file.write_text(json.dumps(self.config))
        config_file.chmod(0o600)
        self.original_root = mcp.ROOT
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
                receipt = {"exitCode": 0, "operationId": data["operationId"],
                           "toolUseId": data["toolUseId"], "rpcId": rpc_id, "dockerId": "a" * 64}
                value = {"ok": True, "operationId": data["operationId"], "toolUseId": data["toolUseId"],
                         "rpcId": rpc_id, "receipt": receipt}
                if fixture.response_mode == "rpc-type-conflict":
                    value["rpcId"] = str(rpc_id)
                if fixture.response_mode == "false-exit":
                    receipt["exitCode"] = False
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
        value = {"name": "roundtrip", "arguments": {"operationId": self.config["operationId"]},
                 "_meta": {"claudecode/toolUseId": "toolu_observed"}}
        value.update(changed)
        return value

    def test_actual_unix_preserves_model_and_rpc_ids_separately(self):
        self.assertEqual(mcp.read_config(self.root), self.config)
        result = mcp.roundtrip(self.root, self.config, 17, self.params())
        self.assertFalse(result["isError"])
        self.assertEqual(len(self.calls), 1)
        request = self.calls[0]
        self.assertEqual(request["rpcId"], 17)
        self.assertEqual(request["toolUseId"], "toolu_observed")
        self.assertEqual(request["runId"], self.config["runId"])
        self.assertEqual(request["name"], "mcp__ocbridge__roundtrip")
        self.assertEqual(json.loads(result["content"][0]["text"])["exitCode"], 0)

    def test_missing_meta_same_ids_or_extra_command_never_reaches_socket(self):
        for ident, params in [(17, self.params(_meta={})),
                              ("toolu_observed", self.params()),
                              (17, self.params(arguments={"operationId": self.config["operationId"], "command": "touch outside"})),
                              (17, self.params(name="Bash"))]:
            with self.subTest(ident=ident, params=params), self.assertRaises(ValueError):
                mcp.roundtrip(self.root, self.config, ident, params)
        self.assertEqual(self.calls, [])

    def test_response_type_or_terminal_conflict_is_not_success_and_never_retried(self):
        for mode in ["rpc-type-conflict", "false-exit"]:
            self.response_mode = mode
            before = len(self.calls)
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                mcp.roundtrip(self.root, self.config, 17, self.params())
            self.assertEqual(len(self.calls), before + 1)

    def test_disconnect_is_unknown_without_a_retry(self):
        self.response_mode = "disconnect"
        with self.assertRaises(http.client.RemoteDisconnected):
            mcp.roundtrip(self.root, self.config, 17, self.params())
        self.assertEqual(len(self.calls), 1)

    def test_actual_stdio_dispatch_lists_only_roundtrip_and_burns_the_single_attempt(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": self.params()},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": self.params()},
        ]
        wire = io.BytesIO(("\n".join(json.dumps(row) for row in messages) + "\n").encode())
        source = type("Input", (), {"buffer": wire})()
        old_stdin, old_argv = sys.stdin, sys.argv
        output = io.StringIO()
        try:
            sys.stdin = source
            sys.argv = ["fixture", str(self.root)]
            with contextlib.redirect_stdout(output):
                self.assertEqual(mcp.main(), 0)
        finally:
            sys.stdin, sys.argv = old_stdin, old_argv
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(rows[0]["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual([tool["name"] for tool in rows[1]["result"]["tools"]], ["roundtrip"])
        self.assertEqual(rows[2]["id"], 3)
        self.assertFalse(rows[2]["result"]["isError"])
        self.assertEqual(rows[3]["id"], 4)
        self.assertEqual(rows[3]["error"]["code"], -32000)
        self.assertEqual(len(self.calls), 1)


if __name__ == "__main__":
    unittest.main()
