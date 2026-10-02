#!/usr/bin/env python3
"""No-Box business test: only one local synthetic read can return the marker."""
import json
import os
from pathlib import Path
import secrets
import subprocess


ROOT = Path(__file__).resolve().parents[2]
SERVER = Path(__file__).with_name("ccb_local_probe_mcp.py")
nonce = secrets.token_hex(12)
fixture = ROOT / f".ocv5-289-read-{nonce}.txt"
used = Path(str(fixture) + ".used")
marker = f"ocv5-289-local-{secrets.token_hex(12)}"


def rpc(method: str, ident: int, params=None) -> str:
    payload = {"jsonrpc": "2.0", "id": ident, "method": method}
    if params is not None:
        payload["params"] = params
    return json.dumps(payload) + "\n"


try:
    fd = os.open(fixture, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, (marker + "\n").encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    requests = "".join([
        rpc("initialize", 1, {"protocolVersion": "2025-06-18"}),
        rpc("tools/list", 2),
        rpc("tools/call", 3, {"name": "read_secret", "arguments": {}}),
        rpc("tools/call", 4, {"name": "read_secret", "arguments": {}}),
        rpc("tools/call", 5, {"name": "read_secret", "arguments": {"path": "/etc/passwd"}}),
    ])
    run = subprocess.run(["python3", "-I", str(SERVER), str(fixture)], input=requests,
                         text=True, capture_output=True, timeout=5, check=True)
    events = [json.loads(line) for line in run.stdout.splitlines()]
    assert len(events) == 5, events
    assert events[1]["result"]["tools"][0]["name"] == "read_secret"
    assert events[2]["result"]["content"][0]["text"] == marker
    assert events[3]["result"]["isError"] is True
    assert events[4]["error"]["code"] == -32602
    assert used.read_text() == "1\n"
    print("CCB_LOCAL_MCP_ONCE_PASS")
finally:
    used.unlink(missing_ok=True)
    fixture.unlink(missing_ok=True)
