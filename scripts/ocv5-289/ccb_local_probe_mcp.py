#!/usr/bin/env python3
"""One-purpose MCP tool fixture in the OpenClaude user container.

The model cannot choose a path: the only tool reads one nonce-bound, owner-0600
synthetic file and records one local O_EXCL execution marker. Never deploy as a
general file-reading adapter. Invoke with Python -I.
"""

import json
import os
from pathlib import Path
import re
import stat
import sys

NAME = re.compile(r"^\.ocv5-289-read-[a-f0-9]{24}\.txt$")
MAX_LINE = 1_048_576
ROOT = Path(__file__).resolve().parents[2]


def emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stdout.flush()


def read_once(raw_path: str) -> str:
    path = Path(raw_path)
    if (not path.is_absolute() or path.parent != ROOT or not NAME.fullmatch(path.name)
            or os.path.realpath(raw_path) != raw_path):
        raise ValueError("FIXTURE_PATH_INVALID")
    fd = os.open(raw_path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or not 1 <= info.st_size <= 256):
            raise ValueError("FIXTURE_FILE_INVALID")
        raw = os.read(fd, 257)
        if len(raw) != info.st_size:
            raise ValueError("FIXTURE_FILE_INVALID")
    finally:
        os.close(fd)
    marker = raw.decode("utf-8", "strict").strip()
    if not re.fullmatch(r"ocv5-289-local-[a-f0-9]{24}", marker):
        raise ValueError("FIXTURE_CONTENT_INVALID")
    used = raw_path + ".used"
    marker_fd = os.open(used, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(marker_fd, b"1\n")
        os.fsync(marker_fd)
    finally:
        os.close(marker_fd)
    dir_fd = os.open(str(ROOT), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    return marker


def main() -> int:
    if len(sys.argv) != 2:
        return 126
    path = sys.argv[1]
    while line := sys.stdin.buffer.readline(MAX_LINE + 1):
        if len(line) > MAX_LINE:
            return 126
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
                continue
            method, ident = request.get("method"), request.get("id")
            if ident is None:
                continue
            if method == "initialize":
                params = request.get("params")
                version = params.get("protocolVersion", "2025-06-18") if isinstance(params, dict) else "2025-06-18"
                emit({"jsonrpc": "2.0", "id": ident, "result": {
                    "protocolVersion": version, "capabilities": {"tools": {}},
                    "serverInfo": {"name": "ocv5-local-fixture", "version": "1.0.0"}}})
            elif method == "ping":
                emit({"jsonrpc": "2.0", "id": ident, "result": {}})
            elif method == "tools/list":
                emit({"jsonrpc": "2.0", "id": ident, "result": {"tools": [{
                    "name": "read_secret",
                    "description": "Return the exact unpredictable synthetic token held only in this OpenClaude user container. No arguments.",
                    "inputSchema": {"type": "object", "properties": {},
                                    "additionalProperties": False}}]}})
            elif method == "tools/call":
                params = request.get("params")
                if (not isinstance(params, dict) or params.get("name") != "read_secret"
                        or params.get("arguments") != {}):
                    emit({"jsonrpc": "2.0", "id": ident, "error": {
                        "code": -32602, "message": "Invalid tool call"}})
                    continue
                try:
                    marker = read_once(path)
                    emit({"jsonrpc": "2.0", "id": ident, "result": {
                        "content": [{"type": "text", "text": marker}]}})
                except (OSError, UnicodeError, ValueError):
                    emit({"jsonrpc": "2.0", "id": ident, "result": {
                        "content": [{"type": "text", "text": "fixture unavailable"}],
                        "isError": True}})
            else:
                emit({"jsonrpc": "2.0", "id": ident, "error": {
                    "code": -32601, "message": "Method not found"}})
        except (UnicodeError, ValueError):
            emit({"jsonrpc": "2.0", "id": None, "error": {
                "code": -32700, "message": "Parse error"}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
