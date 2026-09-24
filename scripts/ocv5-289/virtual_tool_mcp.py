#!/usr/bin/env python3
"""OCV5-289 experimental Box-side MCP tool rendezvous; never executes tools."""
import json
import hashlib
import os
from pathlib import Path
import stat
import sys
import time


def emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def error(ident: object, code: int, message: str) -> None:
    emit({"jsonrpc": "2.0", "id": ident, "error": {"code": code, "message": message}})


def write_once(dir_fd: int, name: str, value: dict) -> None:
    raw = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    if len(raw) > 16384:
        raise ValueError("TOOL_FRAME_TOO_LARGE")
    tmp = f"{name}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
    try:
        offset = 0
        while offset < len(raw):
            count = os.write(fd, raw[offset:])
            if count <= 0:
                raise OSError("TOOL_WRITE_FAILED")
            offset += count
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.link(tmp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd, follow_symlinks=False)
        os.fsync(dir_fd)
    finally:
        os.unlink(tmp, dir_fd=dir_fd)


def read_result(dir_fd: int) -> dict | None:
    try:
        info = os.stat("result.json", dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 16384):
        raise ValueError("TOOL_RESULT_INVALID")
    fd = os.open("result.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
    try:
        raw = os.read(fd, 16385)
    finally:
        os.close(fd)
    if len(raw) > 16384:
        raise ValueError("TOOL_RESULT_TOO_LARGE")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("TOOL_RESULT_INVALID")
    return value


def meta_hashes(value: object) -> dict:
    if not isinstance(value, dict) or len(value) > 64:
        return {}
    return {str(key): hashlib.sha256(json.dumps(item, sort_keys=True,
                                           separators=(",", ":")).encode()).hexdigest()
            for key, item in value.items() if isinstance(key, str) and len(key) <= 128}


def main() -> int:
    if len(sys.argv) != 2:
        return 126
    directory = Path(sys.argv[1])
    if (directory.parent != Path("/tmp") or not directory.name.startswith("ocv5-289-tool-")
            or os.path.realpath(directory) != str(directory)):
        return 126
    dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(dir_fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o700):
            return 126
        called = False
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError()
            except (json.JSONDecodeError, ValueError):
                error(None, -32700, "Parse error")
                continue
            method = request.get("method")
            ident = request.get("id")
            if method == "notifications/initialized" or (isinstance(method, str) and method.startswith("notifications/")):
                continue
            if ident is None:
                continue
            if method == "initialize":
                params = request.get("params") or {}
                version = params.get("protocolVersion", "2025-06-18") if isinstance(params, dict) else "2025-06-18"
                emit({"jsonrpc": "2.0", "id": ident, "result": {
                    "protocolVersion": version, "capabilities": {"tools": {}},
                    "serverInfo": {"name": "ocv5-289-box-stub", "version": "1.0.0"}}})
            elif method == "ping":
                emit({"jsonrpc": "2.0", "id": ident, "result": {}})
            elif method == "tools/list":
                emit({"jsonrpc": "2.0", "id": ident, "result": {"tools": [{
                    "name": "local_echo", "description": "Test-only virtual local tool; never runs in Box.",
                    "inputSchema": {"type": "object", "properties": {"value": {"type": "string"}},
                                    "required": ["value"]}}]}})
            elif method == "tools/call":
                params = request.get("params")
                if (called or not isinstance(params, dict) or params.get("name") != "local_echo"
                        or params.get("arguments") != {"value": "ping"}):
                    error(ident, -32602, "Invalid tool call")
                    continue
                called = True
                try:
                    write_once(dir_fd, "pending.json", {"mcpRequestId": ident,
                                                        "name": "local_echo", "arguments": params["arguments"],
                                                        "requestKeys": sorted(request.keys()),
                                                        "paramKeys": sorted(params.keys()),
                                                        "requestMetaHashes": meta_hashes(request.get("_meta")),
                                                        "paramsMetaHashes": meta_hashes(params.get("_meta"))})
                    deadline = time.monotonic() + 30
                    result = None
                    while time.monotonic() < deadline:
                        result = read_result(dir_fd)
                        if result is not None:
                            break
                        time.sleep(.02)
                    if (not result or result.get("mcpRequestId") != ident
                            or not isinstance(result.get("modelToolUseId"), str)
                            or not isinstance(result.get("text"), str)):
                        raise ValueError("RESULT_MISMATCH")
                    emit({"jsonrpc": "2.0", "id": ident, "result": {
                        "content": [{"type": "text", "text": result["text"]}], "isError": False}})
                except (OSError, ValueError, json.JSONDecodeError):
                    error(ident, -32000, "Tool result unavailable")
            else:
                error(ident, -32601, "Method not found")
        return 0
    finally:
        os.close(dir_fd)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError):
        sys.exit(126)
