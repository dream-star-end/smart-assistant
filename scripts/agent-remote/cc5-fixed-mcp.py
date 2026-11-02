#!/usr/bin/env python3
"""Sole fixed MCP client for an interactive cc5 task. Never executes commands.

Run only as /usr/bin/python3 -I <pinned-script> <approved-task-root>.
The independent tool socket cannot admit a turn or control the original host.
"""
import http.client
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys

MAX_FRAME = 8 * 1024 * 1024
MAX_REPLY = 131072
ROOT = re.compile(r"/home/box/oc-agentremote-t1555u-[a-z0-9-]{16,80}\Z")
UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")


def strict_json(value):
    def pairs(items):
        result = {}
        for key, val in items:
            if key in result:
                raise ValueError("duplicate")
            result[key] = val
        return result
    return json.loads(value, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("constant")))


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def failure(ident, code, message):
    emit({"jsonrpc": "2.0", "id": ident, "error": {"code": code, "message": message}})


def read_config(root):
    if not ROOT.fullmatch(str(root)):
        raise ValueError("root")
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("root-mode")
    parent = root / "cprofile"
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("profile-mode")
    fd = os.open(parent / "client.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077 or not 0 < info.st_size <= 4096):
            raise ValueError("config-mode")
        with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as source:
            config = strict_json(source.read(4097))
    finally:
        os.close(fd)
    if (not isinstance(config, dict) or set(config) != {"version", "operationId", "runId"}
            or config["version"] != 1 or not isinstance(config["operationId"], str)
            or not UUID.fullmatch(config["operationId"]) or not isinstance(config["runId"], str)
            or not UUID.fullmatch(config["runId"])):
        raise ValueError("config-shape")
    return config


def roundtrip(root, config, ident, params):
    args = params.get("arguments")
    meta = params.get("_meta")
    tool_id = meta.get("claudecode/toolUseId") if isinstance(meta, dict) else None
    if (params.get("name") != "roundtrip" or args != {"operationId": config["operationId"]}
            or not isinstance(tool_id, str) or not 0 < len(tool_id.encode("utf-8")) <= 65536
            or ident == tool_id):
        raise ValueError("invalid-tool")
    path = root / "tool.sock"
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("socket-mode")
    body = json.dumps({"runId": config["runId"], "operationId": config["operationId"],
                       "rpcId": ident, "toolUseId": tool_id,
                       "name": "mcp__ocbridge__roundtrip", "arguments": args},
                      separators=(",", ":")).encode("utf-8")
    connection = http.client.HTTPConnection("localhost", timeout=45)
    connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.sock.settimeout(45)
    try:
        connection.sock.connect(str(path))
        # This connection only uses AF_UNIX. No proxy, DNS, TCP or retries.
        connection.request("POST", "/roundtrip", body=body,
                           headers={"Content-Type": "application/json", "Connection": "close"})
        response = connection.getresponse()
        data = response.read(MAX_REPLY + 1)
        if response.status != 200 or len(data) > MAX_REPLY:
            raise ValueError("delivery-unknown")
        value = strict_json(data)
        if (not isinstance(value, dict) or value.get("ok") is not True
                or type(value.get("rpcId")) is not type(ident) or value.get("rpcId") != ident
                or value.get("toolUseId") != tool_id or value.get("operationId") != config["operationId"]
                or not isinstance(value.get("receipt"), dict) or value["receipt"].get("exitCode") != 0
                or isinstance(value["receipt"].get("exitCode"), bool)
                or value["receipt"].get("operationId") != config["operationId"]
                or value["receipt"].get("toolUseId") != tool_id
                or type(value["receipt"].get("rpcId")) is not type(ident)
                or value["receipt"].get("rpcId") != ident
                or not isinstance(value["receipt"].get("dockerId"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", value["receipt"]["dockerId"])):
            raise ValueError("receipt-mismatch")
        return {"content": [{"type": "text", "text": json.dumps(value["receipt"], ensure_ascii=True)}],
                "isError": False}
    finally:
        connection.close()


def main():
    if len(sys.argv) != 2:
        return 126
    root = Path(sys.argv[1])
    config = read_config(root)
    seen = set()
    attempted = False
    while True:
        line = sys.stdin.buffer.readline(MAX_FRAME + 2)
        if not line:
            return 0
        if len(line) > MAX_FRAME or not line.endswith(b"\n"):
            return 126
        try:
            request = strict_json(line)
        except (ValueError, RecursionError, UnicodeError):
            failure(None, -32700, "Parse error")
            continue
        if not isinstance(request, dict):
            failure(None, -32600, "Invalid request")
            continue
        ident, method = request.get("id"), request.get("method")
        if ident is None:
            continue
        if (request.get("jsonrpc") != "2.0" or not isinstance(method, str)
                or isinstance(ident, bool) or not isinstance(ident, (str, int))
                or (isinstance(ident, str) and not 0 < len(ident) <= 256)
                or (isinstance(ident, int) and abs(ident) > 2**53 - 1)):
            failure(None, -32600, "Invalid request")
            continue
        key = (type(ident), ident)
        if key in seen or len(seen) >= 10000:
            failure(ident, -32600, "Repeated request")
            continue
        seen.add(key)
        if method == "initialize":
            params = request.get("params")
            version = params.get("protocolVersion", "2025-06-18") if isinstance(params, dict) else "2025-06-18"
            emit({"jsonrpc": "2.0", "id": ident, "result": {"protocolVersion": version,
                  "capabilities": {"tools": {}}, "serverInfo": {"name": "cc5-t1555u", "version": "1.0.0"}}})
        elif method == "ping":
            emit({"jsonrpc": "2.0", "id": ident, "result": {}})
        elif method == "tools/list":
            emit({"jsonrpc": "2.0", "id": ident, "result": {"tools": [{"name": "roundtrip",
                  "description": "Run the one approved proof in the personal execution container; returns real file/hash/exit receipt.",
                  "inputSchema": {"type": "object", "properties": {"operationId": {
                      "type": "string", "const": config["operationId"]}},
                      "required": ["operationId"], "additionalProperties": False}}]}})
        elif method == "tools/call":
            if attempted:
                failure(ident, -32000, "Operation already attempted; never retry unknown delivery")
                continue
            params = request.get("params")
            if not isinstance(params, dict):
                failure(ident, -32602, "Invalid tool call")
                continue
            # Burn before network effect, including rejected or lost ACK.
            attempted = True
            try:
                result = roundtrip(root, config, ident, params)
                emit({"jsonrpc": "2.0", "id": ident, "result": result})
            except (ValueError, OSError, http.client.HTTPException, RecursionError):
                failure(ident, -32000, "Fixed operation failed or delivery unknown; do not retry")
        else:
            failure(ident, -32601, "Method not found")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, RecursionError):
        sys.stderr.write("CC5_FIXED_MCP_CONFIGURATION_REJECTED\n")
        sys.exit(126)
