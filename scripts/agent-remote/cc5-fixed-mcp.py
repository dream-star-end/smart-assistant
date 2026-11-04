#!/usr/bin/env python3
"""Sole fixed MCP client for an interactive cc5 task. Never executes commands.

Run only as /usr/bin/python3 -I <pinned-script> <approved-task-root>.
The independent tool socket cannot admit a turn or control the original host.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys

MAX_FRAME = 8 * 1024 * 1024
MAX_REPLY = 163840
# Must stay equal to the gateway's CC5_TOOL_RESULT_MAX_BYTES (128 KiB).
MAX_RESULT = 131072
SAFE_INTEGER = 2**53 - 1
TOOLS = ('Read', 'Edit', 'Bash')
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
            or type(config["version"]) is not int or config["version"] != 2 or not isinstance(config["operationId"], str)
            or not UUID.fullmatch(config["operationId"]) or not isinstance(config["runId"], str)
            or not UUID.fullmatch(config["runId"])):
        raise ValueError("config-shape")
    return config


def valid_strings(value):
    if isinstance(value, str):
        value.encode('utf-8', errors='strict')
    elif isinstance(value, dict):
        for key, item in value.items():
            valid_strings(key)
            valid_strings(item)
    elif isinstance(value, list):
        for item in value:
            valid_strings(item)


def canonical(value):
    valid_strings(value)
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def tool_arguments(name, args):
    if name not in TOOLS or not isinstance(args, dict):
        raise ValueError('invalid-tool')
    required, optional = {
        'Read': ({'file_path'}, {'offset', 'limit'}),
        'Edit': ({'file_path', 'old_string', 'new_string'}, {'replace_all'}),
        'Bash': ({'command'}, {'description', 'timeout'}),
    }[name]
    if not required <= set(args) or not set(args) <= required | optional:
        raise ValueError('invalid-tool')
    for key, value in args.items():
        if key in ('offset', 'limit', 'timeout'):
            maximum = 30000 if key == 'timeout' else SAFE_INTEGER
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError('invalid-tool')
        elif key == 'replace_all':
            if type(value) is not bool:
                raise ValueError('invalid-tool')
        elif not isinstance(value, str) or ('\x00' in value) or (key in ('file_path', 'command') and not value):
            raise ValueError('invalid-tool')
    return hashlib.sha256(canonical(args)).hexdigest()


def validate_response(value, config, ident, tool_id, name, input_hash):
    required = {'version', 'ok', 'runId', 'operationId', 'rpcId', 'toolUseId', 'name', 'inputSha256', 'result'}
    if (not isinstance(value, dict) or not required <= set(value) or not set(value) <= required | {'receipt'}
            or type(value['version']) is not int or value['version'] != 2 or value['ok'] is not True
            or value['runId'] != config['runId'] or value['operationId'] != config['operationId']
            or type(value['rpcId']) is not type(ident) or value['rpcId'] != ident
            or value['toolUseId'] != tool_id or value['name'] != name or value['inputSha256'] != input_hash):
        raise ValueError('receipt-mismatch')
    result = value['result']
    if (not isinstance(result, dict) or set(result) != {'content', 'isError'}
            or type(result['isError']) is not bool or not isinstance(result['content'], list)
            or any(not isinstance(item, dict) or not isinstance(item.get('type'), str) or not item['type']
                   for item in result['content']) or len(canonical(result)) > MAX_RESULT):
        raise ValueError('result-mismatch')
    valid_strings(value)
    return result


def call_tool(root, config, ident, params):
    args = params.get("arguments")
    meta = params.get("_meta")
    tool_id = meta.get("claudecode/toolUseId") if isinstance(meta, dict) else None
    name = params.get('name')
    input_hash = tool_arguments(name, args)
    if (not isinstance(tool_id, str) or not 0 < len(tool_id.encode("utf-8", errors='strict')) <= 65536
            or ident == tool_id):
        raise ValueError("invalid-tool")
    path = root / "tool.sock"
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("socket-mode")
    body = json.dumps({"runId": config["runId"], "operationId": config["operationId"],
                       "rpcId": ident, "toolUseId": tool_id,
                       "name": 'mcp__ocbridge__' + name, "arguments": args, 'inputSha256': input_hash},
                      ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(body) > 131072:
        raise ValueError('invalid-tool')
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
        return validate_response(value, config, ident, tool_id, 'mcp__ocbridge__' + name, input_hash)
    finally:
        connection.close()


def main():
    if len(sys.argv) != 2:
        return 126
    root = Path(sys.argv[1])
    config = read_config(root)
    seen = set()
    seen_tools = set()
    while True:
        line = sys.stdin.buffer.readline(MAX_FRAME + 2)
        if not line:
            return 0
        if len(line) > MAX_FRAME or not line.endswith(b"\n"):
            return 126
        try:
            request = strict_json(line)
            valid_strings(request)
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
            properties = {
                'Read': {'file_path': {'type': 'string', 'minLength': 1}, 'offset': {'type': 'integer', 'minimum': 1, 'maximum': SAFE_INTEGER}, 'limit': {'type': 'integer', 'minimum': 1, 'maximum': SAFE_INTEGER}},
                'Edit': {'file_path': {'type': 'string', 'minLength': 1}, 'old_string': {'type': 'string'}, 'new_string': {'type': 'string'}, 'replace_all': {'type': 'boolean'}},
                'Bash': {'command': {'type': 'string', 'minLength': 1}, 'description': {'type': 'string'}, 'timeout': {'type': 'integer', 'minimum': 1, 'maximum': 30000}},
            }
            required = {'Read': ['file_path'], 'Edit': ['file_path', 'old_string', 'new_string'], 'Bash': ['command']}
            emit({'jsonrpc': '2.0', 'id': ident, 'result': {'tools': [
                {'name': name, 'description': name + ' in the authorized personal execution container.',
                 'inputSchema': {'type': 'object', 'properties': properties[name], 'required': required[name], 'additionalProperties': False}}
                for name in TOOLS]}})
        elif method == "tools/call":
            params = request.get("params")
            if not isinstance(params, dict):
                failure(ident, -32602, "Invalid tool call")
                continue
            try:
                tool_arguments(params.get('name'), params.get('arguments'))
                meta = params.get('_meta')
                tool_id = meta.get('claudecode/toolUseId') if isinstance(meta, dict) else None
                if (not isinstance(tool_id, str) or not 0 < len(tool_id.encode('utf-8', errors='strict')) <= 65536
                        or ident == tool_id or tool_id in seen_tools):
                    raise ValueError('invalid-tool')
            except (ValueError, UnicodeError):
                failure(ident, -32602, 'Invalid or repeated tool call')
                continue
            seen_tools.add(tool_id)
            try:
                result = call_tool(root, config, ident, params)
                emit({"jsonrpc": "2.0", "id": ident, "result": result})
            except (ValueError, OSError, http.client.HTTPException, RecursionError, UnicodeError):
                failure(ident, -32000, "Tool delivery unknown; worker stopped; never retry")
                return 1
        else:
            failure(ident, -32601, "Method not found")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, RecursionError):
        sys.stderr.write("CC5_FIXED_MCP_CONFIGURATION_REJECTED\n")
        sys.exit(126)
