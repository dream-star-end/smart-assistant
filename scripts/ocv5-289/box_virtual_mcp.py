#!/usr/bin/env python3
"""OCV5-289 Box virtual MCP: expose OpenClaude tool schemas, never run tools.

One pending/result pair per *model* tool_use ID permits simultaneous calls of
the same tool with identical arguments without positional correlation. A held
Claude CLI waits here while OpenClaude's user container executes each tool.
Not a production route until the cross-HTTP journal/bridge is wired and audited.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import threading
import time

RUN_DIR = re.compile(r"^ocv5-289-run-[0-9a-f]{24}$")
TOOL_ID = re.compile(r"^toolu_[A-Za-z0-9_-]{1,120}$")
HASH = re.compile(r"^[a-f0-9]{64}$")
MAX_CATALOG = 1_048_576
MAX_TOOL_FRAME = 8 * 1024 * 1024
MAX_CALLS = 32
_stdout_lock = threading.Lock()


def strict_json(raw: bytes | str) -> object:
    def invalid_constant(_value: str) -> object:
        raise ValueError("BOX_MCP_JSON_INVALID")

    def unique_object(pairs: list[tuple[str, object]]) -> dict:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("BOX_MCP_JSON_DUPLICATE_KEY")
            result[key] = value
        return result

    return json.loads(raw, parse_constant=invalid_constant,
                      object_pairs_hook=unique_object)


def emit(value: dict) -> None:
    with _stdout_lock:
        sys.stdout.write(json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n")
        sys.stdout.flush()


def fail(ident: object, code: int, message: str) -> None:
    emit({"jsonrpc": "2.0", "id": ident, "error": {"code": code, "message": message}})


def verified_dir(path: str) -> int:
    directory = Path(path)
    if (directory.parent != Path("/tmp") or not RUN_DIR.fullmatch(directory.name)
            or os.path.realpath(path) != path):
        raise ValueError("BOX_MCP_DIR_INVALID")
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700):
        os.close(fd)
        raise ValueError("BOX_MCP_DIR_INVALID")
    return fd


def read_file(dir_fd: int, name: str, limit: int) -> bytes | None:
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
                     dir_fd=dir_fd)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or info.st_size < 1 or info.st_size > limit):
            raise ValueError("BOX_MCP_FILE_INVALID")
        raw = os.read(fd, limit + 1)
        if len(raw) != info.st_size:
            raise ValueError("BOX_MCP_FILE_INVALID")
        return raw
    finally:
        os.close(fd)


def write_once(dir_fd: int, name: str, value: dict) -> None:
    raw = (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode()
    if len(raw) > MAX_TOOL_FRAME:
        raise ValueError("BOX_MCP_FRAME_TOO_LARGE")
    temp = f"{name}.{os.getpid()}.{threading.get_ident()}.tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=dir_fd)
    try:
        offset = 0
        while offset < len(raw):
            written = os.write(fd, raw[offset:])
            if written <= 0:
                raise OSError("BOX_MCP_WRITE_FAILED")
            offset += written
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.link(temp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd,
                follow_symlinks=False)
        os.fsync(dir_fd)
    finally:
        os.unlink(temp, dir_fd=dir_fd)


def read_catalog(dir_fd: int, wanted_hash: str) -> list[dict]:
    if not HASH.fullmatch(wanted_hash):
        raise ValueError("BOX_MCP_CATALOG_HASH_INVALID")
    raw = read_file(dir_fd, "tool-catalog.json", MAX_CATALOG)
    if raw is None or hashlib.sha256(raw).hexdigest() != wanted_hash:
        raise ValueError("BOX_MCP_CATALOG_INVALID")
    value = strict_json(raw)
    tools = value.get("tools") if isinstance(value, dict) else None
    if (not isinstance(tools, list) or not 1 <= len(tools) <= 128
            or any(not isinstance(t, dict) or t.get("name") != f"t{i}"
                   or not isinstance(t.get("description"), str)
                   or not isinstance(t.get("inputSchema"), dict)
                   for i, t in enumerate(tools))):
        raise ValueError("BOX_MCP_CATALOG_INVALID")
    return tools


def valid_content(content: object) -> bool:
    if not isinstance(content, list) or len(content) > 64:
        return False
    for block in content:
        if not isinstance(block, dict):
            return False
        if block.get("type") == "text":
            if set(block) != {"type", "text"} or not isinstance(block.get("text"), str):
                return False
        elif block.get("type") == "image":
            if (set(block) != {"type", "data", "mimeType"}
                    or block.get("mimeType") not in ("image/png", "image/jpeg", "image/gif", "image/webp")
                    or not isinstance(block.get("data"), str)):
                return False
            try:
                if len(base64.b64decode(block["data"], validate=True)) > MAX_TOOL_FRAME:
                    return False
            except (ValueError, base64.binascii.Error):
                return False
        else:
            return False
    return True


def serve_call(dir_fd: int, ident: str | int, params: dict, model_id: str,
               deadline: float, on_done) -> None:
    try:
        write_once(dir_fd, f"pending.{model_id}.json", {
            "version": 1, "modelToolUseId": model_id, "mcpRequestId": ident,
            "name": params["name"], "arguments": params["arguments"]})
        result = None
        while time.monotonic() < deadline:
            raw = read_file(dir_fd, f"result.{model_id}.json", MAX_TOOL_FRAME)
            if raw is not None:
                result = strict_json(raw)
                break
            time.sleep(.02)
        if (not isinstance(result, dict) or set(result) != {
                "version", "modelToolUseId", "mcpRequestId", "content", "isError"}
                or result["version"] != 1 or result["modelToolUseId"] != model_id
                or result["mcpRequestId"] != ident or not isinstance(result["isError"], bool)
                or not valid_content(result["content"])):
            raise ValueError("BOX_MCP_RESULT_INVALID")
        emit({"jsonrpc": "2.0", "id": ident, "result": {
            "content": result["content"], "isError": result["isError"]}})
    except (OSError, ValueError, json.JSONDecodeError):
        fail(ident, -32000, "Tool result unavailable")
    finally:
        on_done(model_id)


def main() -> int:
    if len(sys.argv) != 4:
        return 126
    directory, catalog_hash, wait_raw = sys.argv[1:]
    try:
        wait_seconds = int(wait_raw)
        if not 1 <= wait_seconds <= 900:
            return 126
        dir_fd = verified_dir(directory)
        tools = read_catalog(dir_fd, catalog_hash)
    except (OSError, ValueError, json.JSONDecodeError):
        return 126
    aliases = {tool["name"] for tool in tools}
    active: set[str] = set()
    active_lock = threading.Lock()

    def done(model_id: str) -> None:
        with active_lock:
            active.discard(model_id)

    try:
        for line in sys.stdin:
            try:
                request = strict_json(line)
                if not isinstance(request, dict):
                    raise ValueError()
            except (ValueError, json.JSONDecodeError):
                fail(None, -32700, "Parse error")
                continue
            method, ident = request.get("method"), request.get("id")
            if method == "notifications/initialized" or (
                    isinstance(method, str) and method.startswith("notifications/")):
                continue
            if ident is None:
                continue
            if isinstance(ident, bool) or not isinstance(ident, (str, int)):
                fail(None, -32600, "Invalid request")
                continue
            if method == "initialize":
                params = request.get("params")
                version = params.get("protocolVersion", "2025-06-18") if isinstance(params, dict) else "2025-06-18"
                emit({"jsonrpc": "2.0", "id": ident, "result": {
                    "protocolVersion": version, "capabilities": {"tools": {}},
                    "serverInfo": {"name": "ocv5-box-virtual", "version": "1.0.0"}}})
            elif method == "ping":
                emit({"jsonrpc": "2.0", "id": ident, "result": {}})
            elif method == "tools/list":
                emit({"jsonrpc": "2.0", "id": ident, "result": {"tools": tools}})
            elif method == "tools/call":
                params = request.get("params")
                meta = params.get("_meta") if isinstance(params, dict) else None
                model_id = meta.get("claudecode/toolUseId") if isinstance(meta, dict) else None
                if (not isinstance(params, dict)
                        or not isinstance(params.get("name"), str)
                        or params["name"] not in aliases
                        or not isinstance(params.get("arguments"), dict)
                        or not isinstance(model_id, str) or not TOOL_ID.fullmatch(model_id)
                        or ident == model_id):
                    fail(ident, -32602, "Invalid tool call")
                    continue
                with active_lock:
                    if len(active) >= MAX_CALLS or model_id in active:
                        fail(ident, -32602, "Invalid tool call")
                        continue
                    active.add(model_id)
                thread = threading.Thread(target=serve_call,
                    args=(dir_fd, ident, params, model_id,
                          time.monotonic() + wait_seconds, done), daemon=True)
                try:
                    thread.start()
                except RuntimeError:
                    done(model_id)
                    fail(ident, -32000, "Tool unavailable")
            else:
                fail(ident, -32601, "Method not found")
        return 0
    finally:
        os.close(dir_fd)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError):
        sys.exit(126)
