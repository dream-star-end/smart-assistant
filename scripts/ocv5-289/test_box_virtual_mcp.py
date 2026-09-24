"""Offline multi-tool virtual MCP tests; no Box account or paid model call."""
import hashlib
import base64
import json
import os
from pathlib import Path
import secrets
import select
import subprocess
import sys
import time
import unittest

SCRIPT = Path(__file__).with_name("box_virtual_mcp.py")


def compact(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode()


class VirtualMcpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path("/tmp") / ("ocv5-289-run-" + secrets.token_hex(12))
        self.directory.mkdir(mode=0o700)
        raw = compact({"tools": [{"name": "t0", "description": "Synthetic local tool",
                                  "inputSchema": {"type": "object", "properties": {
                                      "value": {"type": "string"}}}}]})
        self.catalog = self.directory / "tool-catalog.json"
        self.catalog.write_bytes(raw)
        self.catalog.chmod(0o600)
        self.hash = hashlib.sha256(raw).hexdigest()
        self.child = None

    def tearDown(self) -> None:
        if self.child is not None:
            self.child.terminate()
            try:
                self.child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.child.kill(); self.child.wait(timeout=2)
            for stream in (self.child.stdin, self.child.stdout, self.child.stderr):
                if stream is not None:
                    stream.close()
        for entry in self.directory.iterdir():
            entry.unlink()
        self.directory.rmdir()

    def start(self, catalog_hash: str | None = None, wait: int = 3) -> None:
        self.child = subprocess.Popen([sys.executable, str(SCRIPT), str(self.directory),
                                       catalog_hash or self.hash, str(wait)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True, bufsize=1)

    def send(self, ident: int, method: str, params: dict | None = None) -> None:
        assert self.child and self.child.stdin
        self.child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": ident,
                                           "method": method, "params": params or {}}) + "\n")
        self.child.stdin.flush()

    def read(self, timeout: float = 2) -> dict:
        assert self.child and self.child.stdout
        ready, _, _ = select.select([self.child.stdout], [], [], timeout)
        self.assertTrue(ready, "MCP response timed out")
        return json.loads(self.child.stdout.readline())

    def await_file(self, name: str, timeout: float = 2) -> dict:
        path = self.directory / name
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not path.exists():
            time.sleep(.01)
        self.assertTrue(path.exists(), f"{name} not published")
        return json.loads(path.read_text())

    def result(self, model_id: str, request_id: int, text: str) -> None:
        path = self.directory / f"result.{model_id}.json"
        raw = compact({"version": 1, "modelToolUseId": model_id,
                       "mcpRequestId": request_id,
                       "content": [{"type": "text", "text": text}], "isError": False})
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, raw); os.fsync(fd)
        finally:
            os.close(fd)

    def call(self, request_id: int, model_id: str) -> None:
        self.send(request_id, "tools/call", {"name": "t0", "arguments": {"value": "same"},
                 "_meta": {"claudecode/toolUseId": model_id}})

    def test_same_tool_same_arguments_parallel_results_bind_by_model_id(self) -> None:
        self.start()
        self.send(1, "initialize", {"protocolVersion": "2025-06-18"})
        self.assertEqual(self.read()["result"]["protocolVersion"], "2025-06-18")
        self.send(2, "tools/list")
        self.assertEqual(self.read()["result"]["tools"][0]["name"], "t0")
        first, second = "toolu_parallel_a", "toolu_parallel_b"
        self.call(11, first)
        self.call(12, second)
        pending_a = self.await_file(f"pending.{first}.json")
        pending_b = self.await_file(f"pending.{second}.json")
        self.assertEqual(pending_a["arguments"], pending_b["arguments"])
        self.assertEqual(pending_a["mcpRequestId"], 11)
        self.assertEqual(pending_b["mcpRequestId"], 12)
        self.result(second, 12, "local-second")
        self.result(first, 11, "local-first")
        responses = {row["id"]: row for row in (self.read(), self.read())}
        self.assertEqual(responses[11]["result"]["content"][0]["text"], "local-first")
        self.assertEqual(responses[12]["result"]["content"][0]["text"], "local-second")

    def test_missing_metadata_duplicate_id_and_mismatched_result_fail(self) -> None:
        self.start(wait=1)
        self.send(3, "tools/call", {"name": "t0", "arguments": {"value": "same"}})
        self.assertEqual(self.read()["error"]["code"], -32602)
        ident = "toolu_single_abc"
        self.call(4, ident)
        self.await_file(f"pending.{ident}.json")
        self.call(5, ident)
        self.assertEqual(self.read()["error"]["code"], -32602)
        self.result(ident, 99, "wrong-request")
        self.assertEqual(self.read(2)["error"]["code"], -32000)
        self.assertEqual(len(list(self.directory.glob(f"pending.{ident}.json"))), 1)

    def test_wrong_catalog_hash_refuses_start(self) -> None:
        self.start("0" * 64)
        self.assertEqual(self.child.wait(timeout=2), 126)
        self.assertEqual(list(self.directory.glob("pending.*.json")), [])

    def test_result_image_is_forwarded_without_box_tool_execution(self) -> None:
        self.start()
        ident = "toolu_image_abc"
        self.call(20, ident)
        self.await_file(f"pending.{ident}.json")
        image = base64.b64encode(b"synthetic-image-bytes").decode()
        raw = compact({"version": 1, "modelToolUseId": ident, "mcpRequestId": 20,
                       "content": [{"type": "image", "data": image,
                                    "mimeType": "image/png"}], "isError": False})
        path = self.directory / f"result.{ident}.json"
        path.write_bytes(raw); path.chmod(0o600)
        response = self.read()
        self.assertEqual(response["id"], 20)
        self.assertEqual(response["result"]["content"][0]["data"], image)

    def test_symlink_and_fifo_result_entries_fail_without_hanging(self) -> None:
        for kind in ("symlink", "fifo"):
            with self.subTest(kind=kind):
                if self.child is not None:
                    self.child.terminate(); self.child.wait(timeout=2)
                    for stream in (self.child.stdin, self.child.stdout, self.child.stderr):
                        if stream is not None:
                            stream.close()
                    self.child = None
                self.start()
                ident = f"toolu_bad_{kind}"
                self.call(30, ident)
                self.await_file(f"pending.{ident}.json")
                path = self.directory / f"result.{ident}.json"
                if kind == "symlink":
                    path.symlink_to("/dev/null")
                else:
                    os.mkfifo(path, 0o600)
                self.assertEqual(self.read(timeout=1)["error"]["code"], -32000)


if __name__ == "__main__":
    unittest.main()
