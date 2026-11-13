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
# A full tool set runs long commands and waits on user prompts; the container bounds a call at 11 minutes.
TOOL_TIMEOUT = 720
MAX_ARGUMENTS = 98304
# Arguments plus both ids plus framing, as the socket admits them.
MAX_BODY = MAX_ARGUMENTS + 65536 + 4096
MAX_CATALOG = 1024 * 1024
# Same task-root contract as the controller: a task directory directly in this node account's home.
ROOT = re.compile(re.escape(str(Path.home())) + r"/oc-agentremote-[a-z0-9][a-z0-9-]{14,59}\Z")
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


def read_private(parent, name, limit):
    fd = os.open(parent / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077 or not 0 < info.st_size <= limit):
            raise ValueError("file-mode")
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = source.read(limit + 1)
        if len(data) != info.st_size:
            raise ValueError("file-changed")
        return data
    finally:
        os.close(fd)


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
    config = strict_json(read_private(parent, "client.json", 4096).decode("utf-8"))
    if (not isinstance(config, dict) or set(config) != {"version", "operationId", "runId"}
            or type(config["version"]) is not int or config["version"] != 2 or not isinstance(config["operationId"], str)
            or not UUID.fullmatch(config["operationId"]) or not isinstance(config["runId"], str)
            or not UUID.fullmatch(config["runId"])):
        raise ValueError("config-shape")
    return config


def read_catalog(root):
    """The lane's catalog, whose exact bytes are pinned by the installed SESSION.json."""
    directory = root / "session"
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("session-mode")
    manifest = strict_json(read_private(directory, "SESSION.json", 4096).decode("utf-8"))
    if (not isinstance(manifest, dict)
            or set(manifest) != {"version", "task", "root", "catalogSha256", "promptSha256"}
            or type(manifest["version"]) is not int or manifest["version"] != 1
            or manifest["root"] != str(root) or not isinstance(manifest["task"], str)
            or not isinstance(manifest["catalogSha256"], str) or not isinstance(manifest["promptSha256"], str)):
        raise ValueError("session-shape")
    data = read_private(directory, "catalog.json", MAX_CATALOG)
    if hashlib.sha256(data).hexdigest() != manifest["catalogSha256"]:
        raise ValueError("catalog-hash")
    catalog = strict_json(data.decode("utf-8"))
    if (not isinstance(catalog, dict) or set(catalog) != {"tools"}
            or not isinstance(catalog["tools"], list) or not 1 <= len(catalog["tools"]) <= 128):
        raise ValueError("catalog-shape")
    names = set()
    for tool in catalog["tools"]:
        if (not isinstance(tool, dict) or set(tool) != {"name", "description", "inputSchema"}
                or not isinstance(tool["name"], str) or not tool["name"] or tool["name"] in names
                or not isinstance(tool["description"], str) or not isinstance(tool["inputSchema"], dict)):
            raise ValueError("catalog-shape")
        names.add(tool["name"])
    return catalog


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


SAFE_INTEGER = 2**53 - 1


def js_number(value):
    """ECMAScript Number::toString, the form the master hashes; Python repr has the same shortest digits."""
    if type(value) is int:
        if abs(value) > SAFE_INTEGER:
            raise ValueError('unsafe-integer')
        return str(value)
    if value != value or value in (float('inf'), float('-inf')):
        raise ValueError('non-finite')
    if value.is_integer() and abs(value) > SAFE_INTEGER:
        raise ValueError('unsafe-integer')  # The master cannot tell 1e21 from an integer and rejects both.
    if value == 0:
        return '0'
    text = repr(value)
    sign = '-' if text.startswith('-') else ''
    mantissa, _, exponent = text.lstrip('-').partition('e')
    whole, _, fraction = mantissa.partition('.')
    raw = whole + fraction
    lead = len(raw) - len(raw.lstrip('0'))
    digits = raw.lstrip('0').rstrip('0')
    n = len(whole) - lead + int(exponent or 0)
    k = len(digits)
    if k <= n <= 21:
        body = digits + '0' * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + '.' + digits[n:]
    elif -6 < n <= 0:
        body = '0.' + '0' * -n + digits
    else:
        e = n - 1
        body = (digits[0] + ('.' + digits[1:] if k > 1 else '') + 'e' + ('+' if e >= 0 else '-') + str(abs(e)))
    return sign + body


def canonical_text(value):
    if value is None:
        return 'null'
    if value is True or value is False:
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return '[' + ','.join(canonical_text(item) for item in value) + ']'
    if isinstance(value, dict):
        # str order is code point order, which equals the master's UTF-8 byte order.
        return '{' + ','.join(json.dumps(key, ensure_ascii=False) + ':' + canonical_text(value[key])
                              for key in sorted(value)) + '}'
    raise ValueError('not-json')


def canonical(value):
    """The wire's canonical JSON, shared with the master (packages/gateway/src/cc5NativeTool.ts)."""
    valid_strings(value)
    return canonical_text(value).encode('utf-8')


def tool_arguments(catalog, name, args):
    if (not isinstance(name, str) or not isinstance(args, dict)
            or name not in {tool["name"] for tool in catalog["tools"]}):
        raise ValueError('invalid-tool')
    body = canonical(args)  # Recursive sort_keys; the master hashes the same form.
    if len(body) > MAX_ARGUMENTS:
        raise ValueError('invalid-tool')
    return hashlib.sha256(body).hexdigest()


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


def call_tool(root, config, catalog, ident, params):
    args = params.get("arguments")
    meta = params.get("_meta")
    tool_id = meta.get("claudecode/toolUseId") if isinstance(meta, dict) else None
    name = params.get('name')
    input_hash = tool_arguments(catalog, name, args)
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
    if len(body) > MAX_BODY:
        raise ValueError('invalid-tool')
    connection = http.client.HTTPConnection("localhost", timeout=TOOL_TIMEOUT)
    connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.sock.settimeout(TOOL_TIMEOUT)
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
    catalog = read_catalog(root)
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
            emit({'jsonrpc': '2.0', 'id': ident, 'result': {'tools': [
                {'name': tool['name'], 'description': tool['description'],
                 'inputSchema': tool['inputSchema']} for tool in catalog['tools']]}})
        elif method == "tools/call":
            params = request.get("params")
            if not isinstance(params, dict):
                failure(ident, -32602, "Invalid tool call")
                continue
            try:
                tool_arguments(catalog, params.get('name'), params.get('arguments'))
                meta = params.get('_meta')
                tool_id = meta.get('claudecode/toolUseId') if isinstance(meta, dict) else None
                if (not isinstance(tool_id, str) or not 0 < len(tool_id.encode('utf-8', errors='strict')) <= 65536
                        or ident == tool_id or tool_id in seen_tools):
                    raise ValueError('invalid-tool')
            except (ValueError, UnicodeError, RecursionError):
                failure(ident, -32602, 'Invalid or repeated tool call')
                continue
            seen_tools.add(tool_id)
            try:
                result = call_tool(root, config, catalog, ident, params)
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
