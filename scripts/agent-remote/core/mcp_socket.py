#!/usr/bin/env python3
"""Unified AF_UNIX `tool.sock` SSH stdio bridge (`remote-driver-v4`).

Persists durable `tool-attempts/<sha256(callId)>.attempt.json` (`O_CREAT|O_EXCL` + fsync)
BEFORE emitting the first SSH byte to master, so disconnects never replay side effects.
"""
from __future__ import annotations

import base64
import hashlib
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import select
import socket
import stat
import struct
import sys
import time
from typing import Any, BinaryIO, Dict, Optional, Set, Tuple

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from core.canonical import remote_canonical_bytes, strict_json  # noqa: E402
from core.contract import need  # noqa: E402
from core.mcp_client import (  # noqa: E402
    MAX_BODY,
    MAX_REPLY,
    TOOL_TIMEOUT,
    read_catalog,
    read_config,
    read_private,
    validate_wire_response,
)

MAX_FRAME = 262144


def sync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_record(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())
    sync_dir(path.parent)


def emit_frame(sink: BinaryIO, value: Dict[str, Any]) -> None:
    data = json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n"
    need(len(data) <= MAX_FRAME, "REMOTE_SOCKET_FRAME_TOO_LARGE")
    sink.write(data)
    sink.flush()


def run_socket_bridge(root: Path, source: BinaryIO, sink: BinaryIO) -> int:
    config = read_config(root)
    sock_path = root / "tool.sock"
    need(
        len(os.fsencode(sock_path)) <= 104 and not sock_path.exists() and not sock_path.is_symlink(),
        "REMOTE_SOCKET_PATH_INVALID",
    )
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    socket_identity: Optional[Tuple[int, int]] = None
    sequence = 0
    seen_rpc: Set[Tuple[type, Any]] = set()
    attempts = root / "tool-attempts"
    failed = False

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def send_error(self, *args: Any, **kwargs: Any) -> None:
            self.send_response(403)
            self.send_header("Content-Length", "12")
            self.end_headers()
            self.wfile.write(b'{"ok":false}')

        def do_POST(self) -> None:  # noqa: N802
            nonlocal sequence, failed
            dispatched = False
            try:
                need(self.path == "/roundtrip" and self.headers.get("Transfer-Encoding") is None, "REMOTE_SOCKET_HTTP_INVALID")
                lengths = self.headers.get_all("Content-Length") or []
                need(
                    len(lengths) == 1 and lengths[0].isdecimal() and 0 < int(lengths[0]) <= MAX_BODY,
                    "REMOTE_SOCKET_LENGTH_INVALID",
                )
                data = self.rfile.read(int(lengths[0]))
                need(len(data) == int(lengths[0]), "REMOTE_SOCKET_SHORT_READ")
                body = strict_json(data)
                need(isinstance(body, dict) and body.get("version") == 4, "REMOTE_SOCKET_BODY_INVALID")

                cur_cfg = read_config(root)
                catalog = read_catalog(root, cur_cfg)
                allowed_tools = {t["name"] for t in catalog["tools"]}
                for k in ("driverId", "engineId", "operationId", "runId", "generation", "profileId", "authEpoch"):
                    need(body.get(k) == cur_cfg[k], "REMOTE_SOCKET_BINDING_MISMATCH")
                need(
                    body.get("server") == "ocbridge" and body.get("name") in allowed_tools,
                    "REMOTE_SOCKET_TOOL_REJECTED",
                )
                ident = body["rpcId"]
                need(not (root / "STOPPING.json").exists(), "REMOTE_SOCKET_FENCED")

                call_key = hashlib.sha256(body["callId"].encode("utf-8")).hexdigest()
                if cur_cfg.get("requireNodeObservation", False):
                    obs_path = root / "observations" / (call_key + ".json")
                    deadline = time.monotonic() + 2.0
                    while not obs_path.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    obs = strict_json(read_private(obs_path.parent, obs_path.name, 16384))
                    for obs_field in ("operationId", "runId", "generation", "nativeSessionId", "callId", "name", "argsHash"):
                        need(obs.get(obs_field) == body.get(obs_field), "REMOTE_SOCKET_OBSERVATION_MISMATCH")
                    if "nativeTurnId" in body:
                        need(obs.get("nativeTurnId") == body["nativeTurnId"], "REMOTE_SOCKET_TURN_MISMATCH")

                attempt_file = attempts / (call_key + ".attempt.json")
                result_file = attempts / (call_key + ".result.json")
                # Disconnect result-only replay: if a previous round already persisted a proven result,
                # return it without re-dispatching; if `.attempt.json` exists without `.result.json`,
                # outcome is unknown -> fail closed (NEVER re-send effect!).
                if result_file.exists():
                    saved = read_private(attempts, result_file.name, MAX_REPLY)
                    validate_wire_response(strict_json(saved), body)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(saved)))
                    self.end_headers()
                    self.wfile.write(saved)
                    return

                need((type(ident), ident) not in seen_rpc and not attempt_file.exists() and sequence < 10000 and not (root / "STOPPING.json").exists(), "REMOTE_SOCKET_ATTEMPT_EXISTS")
                sequence += 1
                seen_rpc.add((type(ident), ident))
                dispatched = True
                durable_record(attempt_file, remote_canonical_bytes(body))

                emit_frame(
                    sink,
                    {
                        "version": 4,
                        "driverId": cur_cfg["driverId"],
                        "engineId": cur_cfg["engineId"],
                        "kind": "tool-request",
                        "seq": sequence,
                        "body": base64.b64encode(remote_canonical_bytes(body)).decode("ascii"),
                    },
                )
                line = source.readline(MAX_FRAME + 1)
                need(line.endswith(b"\n") and len(line) <= MAX_FRAME, "REMOTE_SOCKET_REPLY_INVALID")
                resp = strict_json(line)
                need(
                    isinstance(resp, dict)
                    and set(resp.keys()) == {"version", "driverId", "engineId", "kind", "seq", "status", "body"}
                    and resp["version"] == 4
                    and resp["driverId"] == cur_cfg["driverId"]
                    and resp["engineId"] == cur_cfg["engineId"]
                    and resp["kind"] == "tool-response"
                    and resp["seq"] == sequence
                    and resp["status"] == 200
                    and isinstance(resp["body"], str),
                    "REMOTE_SOCKET_REPLY_MISMATCH",
                )
                receipt_bytes = base64.b64decode(resp["body"], validate=True)
                need(len(receipt_bytes) <= MAX_REPLY, "REMOTE_SOCKET_RECEIPT_TOO_LARGE")
                validate_wire_response(strict_json(receipt_bytes), body)
                durable_record(result_file, receipt_bytes)

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(receipt_bytes)))
                self.end_headers()
                self.wfile.write(receipt_bytes)
            except Exception:  # noqa: BLE001
                failed = True
                self.send_error()

    try:
        if not attempts.exists() and not attempts.is_symlink():
            attempts.mkdir(mode=0o700)
            sync_dir(root)
        st = attempts.lstat()
        need(
            stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o700,
            "REMOTE_SOCKET_ATTEMPTS_UNSAFE",
        )
        listener.bind(str(sock_path))
        os.chmod(sock_path, 0o600)
        listener.listen(2)
        st = sock_path.lstat()
        socket_identity = (st.st_dev, st.st_ino)
        fields = Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()
        durable_record(
            root / "MCP-SOCKET.json",
            remote_canonical_bytes(
                {
                    "version": 4,
                    "root": str(root),
                    "driverId": config["driverId"],
                    "engineId": config["engineId"],
                    "runId": config["runId"],
                    "operationId": config["operationId"],
                    "generation": config["generation"],
                    "pid": os.getpid(),
                    "startTicks": fields[19],
                }
            ),
        )
        emit_frame(
            sink,
            {
                "version": 4,
                "driverId": config["driverId"],
                "engineId": config["engineId"],
                "generation": config["generation"],
                "kind": "socket-ready",
                "runId": config["runId"],
                "operationId": config["operationId"],
                "pid": os.getpid(),
                "startTicks": fields[19],
            },
        )
        while not failed:
            if (root / "STOPPING.json").exists():
                break
            readable, _, _ = select.select([listener, source], [], [], 0.5)
            if source in readable:
                need(source.readline(MAX_FRAME + 1) == b"", "REMOTE_SOCKET_UNSOLICITED_STDIN")
                break
            if listener in readable:
                conn, _ = listener.accept()
                try:
                    _pid, uid, _gid = struct.unpack(
                        "3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                    )
                    need(uid == os.getuid(), "REMOTE_SOCKET_PEER_UID_MISMATCH")
                    conn.settimeout(TOOL_TIMEOUT)
                    Handler(conn, ("local-unix", 0), None)
                finally:
                    conn.close()
        return 1 if failed else 0
    finally:
        listener.close()
        if socket_identity is not None and sock_path.exists():
            st = sock_path.lstat()
            if stat.S_ISSOCK(st.st_mode) and st.st_uid == os.getuid() and (st.st_dev, st.st_ino) == socket_identity:
                sock_path.unlink()


if __name__ == "__main__":
    try:
        need(len(sys.argv) == 2, "REMOTE_SOCKET_ARGS_INVALID")
        sys.exit(run_socket_bridge(Path(sys.argv[1]).resolve(), sys.stdin.buffer, sys.stdout.buffer))
    except Exception:  # noqa: BLE001
        sys.stderr.write("REMOTE_MCP_SOCKET_FAILED_OR_UNKNOWN\n")
        sys.exit(1)
