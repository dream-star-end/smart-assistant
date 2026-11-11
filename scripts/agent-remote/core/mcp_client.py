#!/usr/bin/env python3
"""Unified Fixed MCP stdio server (`remote-driver-v4`).

Spawned by any native CLI (`cc`, `codex`, or 3rd driver) as MCP server `ocbridge`.
Never executes tools locally; extracts correlation keys via `driver.decode('fixed_mcp', ...)`
and bridges over AF_UNIX `root/tool.sock`. Never retries unknown deliveries.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys
from typing import Any, Dict, Set, Tuple

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from core.canonical import (  # noqa: E402
    SAFE_INTEGER,
    remote_canonical_bytes,
    remote_canonical_sha256,
    strict_json,
)
from core.contract import load_driver, need, validate_decode_batch  # noqa: E402

MAX_FRAME = 8 * 1024 * 1024
MAX_REPLY = 163840
MAX_RESULT = 131072
MAX_ARGUMENTS = 98304
MAX_BODY = 196608
MAX_CATALOG = 1024 * 1024
TOOL_TIMEOUT = 720
SERVER = "ocbridge"
IDENTITY_KEYS = (
    "operationId",
    "runId",
    "generation",
    "profileId",
    "authEpoch",
    "nativeSessionId",
    "callId",
    "rpcId",
    "server",
    "name",
    "argsHash",
)


def emit(value: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def failure(ident: Any, code: int, message: str) -> None:
    emit({"jsonrpc": "2.0", "id": ident, "error": {"code": code, "message": message}})


def read_private(parent: Path, name: str, limit: int) -> bytes:
    fd = os.open(parent / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
            or info.st_mode & 0o077
            or not 0 < info.st_size <= limit
        ):
            raise ValueError("REMOTE_MCP_FILE_MODE_INVALID")
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = source.read(limit + 1)
        if len(data) != info.st_size:
            raise ValueError("REMOTE_MCP_FILE_CHANGED")
        return data
    finally:
        os.close(fd)


def private_dir(path: Path) -> None:
    info = path.lstat()
    need(
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == os.getuid()
        and not (info.st_mode & 0o077)
        and path.resolve() == path.absolute(),
        "REMOTE_MCP_DIR_UNSAFE",
    )


def read_config(root: Path) -> Dict[str, Any]:
    private_dir(root)
    config = strict_json(read_private(root, "client.json", 16384))
    need(isinstance(config, dict) and config.get("version") == 4, "REMOTE_MCP_CONFIG_INVALID")
    for key in (
        "driverId",
        "engineId",
        "operationId",
        "runId",
        "generation",
        "profileId",
        "authEpoch",
        "catalogSha256",
    ):
        need(isinstance(config.get(key), str) and 0 < len(config[key]) <= 128, "REMOTE_MCP_CONFIG_INVALID")
    need(
        isinstance(config.get("driverDigest"), str)
        and re.fullmatch(r"[a-f0-9]{64}", config["driverDigest"]) is not None,
        "REMOTE_MCP_CONFIG_INVALID",
    )
    return config


def read_catalog(root: Path, config: Dict[str, Any]) -> Dict[str, Any]:
    data = read_private(root, "tools.json", MAX_CATALOG)
    need(hashlib.sha256(data).hexdigest() == config["catalogSha256"], "REMOTE_MCP_CATALOG_HASH_MISMATCH")
    catalog = strict_json(data)
    need(
        isinstance(catalog, dict)
        and set(catalog.keys()) == {"tools"}
        and isinstance(catalog["tools"], list)
        and 1 <= len(catalog["tools"]) <= 128,
        "REMOTE_MCP_CATALOG_INVALID",
    )
    names: Set[str] = set()
    for tool in catalog["tools"]:
        need(
            isinstance(tool, dict)
            and set(tool.keys()) == {"name", "description", "inputSchema"}
            and isinstance(tool["name"], str)
            and re.fullmatch(r"[A-Za-z0-9_-]{1,48}", tool["name"])
            and tool["name"] not in names
            and isinstance(tool["description"], str)
            and isinstance(tool["inputSchema"], dict),
            "REMOTE_MCP_CATALOG_INVALID",
        )
        names.add(tool["name"])
    return catalog


def build_wire_request(
    root: Path,
    config: Dict[str, Any],
    catalog: Dict[str, Any],
    raw_line: bytes,
    driver_mod: Any,
) -> Dict[str, Any]:
    native_state: Dict[str, Any] = {}
    if isinstance(config.get("nativeSessionId"), str):
        native_state["sessionId"] = config["nativeSessionId"]
    # Also allow reading session state written by launch controller if nativeSessionId wasn't known pre-launch.
    session_hint_path = root / "NATIVE-SESSION.json"
    if "sessionId" not in native_state and session_hint_path.exists():
        hint = strict_json(read_private(root, "NATIVE-SESSION.json", 4096))
        if isinstance(hint, dict) and isinstance(hint.get("nativeSessionId"), str):
            native_state["sessionId"] = hint["nativeSessionId"]

    decoded = validate_decode_batch(
        driver_mod.decode("fixed_mcp", raw_line, native_state),
        channel="fixed_mcp",
        raw_frame_bytes=raw_line,
        frame_seq=1,
    )
    pending = decoded.get("pendingToolRequest")
    need(isinstance(pending, dict), "REMOTE_MCP_NO_TOOL_REQUEST")

    allowed_names = {tool["name"] for tool in catalog["tools"]}
    need(pending["name"] in allowed_names, "REMOTE_MCP_UNKNOWN_TOOL")
    arg_bytes = remote_canonical_bytes(pending["arguments"])
    need(len(arg_bytes) <= MAX_ARGUMENTS, "REMOTE_MCP_ARGUMENTS_TOO_LARGE")
    expected_hash = hashlib.sha256(arg_bytes).hexdigest()
    need(expected_hash == pending["argsHash"], "REMOTE_MCP_ARGS_HASH_MISMATCH")

    body: Dict[str, Any] = {
        "version": 4,
        "driverId": config["driverId"],
        "engineId": config["engineId"],
        "operationId": config["operationId"],
        "runId": config["runId"],
        "generation": config["generation"],
        "profileId": config["profileId"],
        "authEpoch": config["authEpoch"],
        "nativeSessionId": pending["nativeSessionId"],
        "callId": pending["callId"],
        "rpcId": pending["rpcId"],
        "server": SERVER,
        "name": pending["name"],
        "arguments": pending["arguments"],
        "argsHash": expected_hash,
    }
    if "nativeTurnId" in pending and pending["nativeTurnId"] is not None:
        body["nativeTurnId"] = pending["nativeTurnId"]
    return body


def validate_wire_response(value: Any, body: Dict[str, Any]) -> Dict[str, Any]:
    need(isinstance(value, dict) and value.get("version") == 4 and value.get("ok") is True, "REMOTE_MCP_RECEIPT_INVALID")
    for key in IDENTITY_KEYS:
        need(
            key in value and type(value[key]) is type(body[key]) and value[key] == body[key],
            "REMOTE_MCP_RECEIPT_IDENTITY_MISMATCH",
        )
    if "nativeTurnId" in body:
        need(value.get("nativeTurnId") == body["nativeTurnId"], "REMOTE_MCP_RECEIPT_TURN_MISMATCH")
    result = value.get("result")
    need(
        isinstance(result, dict)
        and set(result.keys()) == {"content", "isError"}
        and type(result["isError"]) is bool
        and isinstance(result["content"], list)
        and all(isinstance(x, dict) and isinstance(x.get("type"), str) for x in result["content"])
        and len(remote_canonical_bytes(result)) <= MAX_RESULT,
        "REMOTE_MCP_RESULT_INVALID",
    )
    return result


def call_tool_socket(root: Path, body: Dict[str, Any]) -> Dict[str, Any]:
    need(not (root / "STOPPING.json").exists(), "REMOTE_MCP_FENCED")
    sock_path = root / "tool.sock"
    info = sock_path.lstat()
    need(
        stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid() and not (info.st_mode & 0o077),
        "REMOTE_MCP_SOCKET_UNSAFE",
    )
    payload = remote_canonical_bytes(body)
    need(len(payload) <= MAX_BODY, "REMOTE_MCP_BODY_TOO_LARGE")

    conn = http.client.HTTPConnection("localhost", timeout=TOOL_TIMEOUT)
    conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.sock.settimeout(TOOL_TIMEOUT)
    try:
        conn.sock.connect(str(sock_path))
        conn.request(
            "POST",
            "/roundtrip",
            body=payload,
            headers={"Content-Type": "application/json", "Connection": "close"},
        )
        resp = conn.getresponse()
        raw = resp.read(MAX_REPLY + 1)
        need(resp.status == 200 and len(raw) <= MAX_REPLY, "REMOTE_MCP_DELIVERY_UNKNOWN")
        return validate_wire_response(strict_json(raw), body)
    finally:
        conn.close()


def main() -> int:
    need(len(sys.argv) == 2, "REMOTE_MCP_ARGS_INVALID")
    root = Path(sys.argv[1]).resolve()
    config = read_config(root)
    catalog = read_catalog(root, config)
    driver_mod, _, _ = load_driver(
        config["driverId"],
        registry_path=config.get("registryPath"),
        expected_digest=config["driverDigest"],
        allow_sandbox_override=str(root).startswith("/tmp/oc-drvtest-"),
    )

    seen_rpc: Set[Tuple[type, Any]] = set()
    seen_calls: Set[str] = set()

    while True:
        line = sys.stdin.buffer.readline(MAX_FRAME + 1)
        if not line:
            return 0
        need(len(line) <= MAX_FRAME and line.endswith(b"\n"), "REMOTE_MCP_FRAME_INVALID")
        request = strict_json(line)
        need(isinstance(request, dict), "REMOTE_MCP_REQUEST_INVALID")
        ident = request.get("id")
        method = request.get("method")
        if ident is None:
            continue
        need(
            isinstance(ident, (str, int))
            and not isinstance(ident, bool)
            and isinstance(method, str)
            and ((isinstance(ident, str) and 0 < len(ident) <= 256) or (type(ident) is int and abs(ident) <= SAFE_INTEGER)),
            "REMOTE_MCP_ID_INVALID",
        )
        rpc_key = (type(ident), ident)
        need(rpc_key not in seen_rpc and len(seen_rpc) < 10000, "REMOTE_MCP_DUPLICATE_RPC")
        seen_rpc.add(rpc_key)

        if method == "initialize":
            params = request.get("params")
            proto = params.get("protocolVersion", "2025-06-18") if isinstance(params, dict) else "2025-06-18"
            result: Dict[str, Any] = {
                "protocolVersion": proto,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "oc-remote-fixed-v4", "version": "4.0.0"},
            }
        elif method == "tools/list":
            result = catalog
        elif method in ("ping", "resources/list", "resources/templates/list"):
            result = (
                {"resources": []}
                if method == "resources/list"
                else {"resourceTemplates": []}
                if method == "resources/templates/list"
                else {}
            )
        elif method == "tools/call":
            try:
                wire_req = build_wire_request(root, config, catalog, line, driver_mod)
                need(wire_req["callId"] not in seen_calls, "REMOTE_MCP_DUPLICATE_CALL")
                seen_calls.add(wire_req["callId"])
                result = call_tool_socket(root, wire_req)
            except Exception:  # noqa: BLE001
                failure(ident, -32000, "Tool delivery unknown or rejected; never retry")
                return 1
        else:
            failure(ident, -32601, "Method not found")
            continue

        emit({"jsonrpc": "2.0", "id": ident, "result": result})


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        sys.stderr.write("REMOTE_FIXED_MCP_REJECTED\n")
        sys.exit(126)
