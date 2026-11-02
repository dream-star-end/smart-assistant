#!/usr/bin/env python3
"""Fixed Unix MCP endpoint over ordinary SSH exec stdio; no SSH forwarding or TCP.

No model tool executes here. The only operation is relaying one fixed task RPC
and its real execution-container receipt. Unknown delivery is never retried.
"""
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
import types

PINNED_MCP_SHA = '9738e246fc23dbf356335f4effacbbd12204180b981dd9996d62305f2fba2809'
MAX_BODY = 131072
MAX_FRAME = 262144


def require(value):
    if not value:
        raise ValueError('CC5_MCP_SOCKET_REJECTED')


def emit(stream, value):
    data = json.dumps(value, separators=(',', ':')).encode() + b'\n'
    require(len(data) <= MAX_FRAME)
    stream.write(data)
    stream.flush()


def load_client(root):
    path = root / 'cprofile/cc5-fixed-mcp.py'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1
                and stat.S_IMODE(st.st_mode) == 0o400 and 0 < st.st_size <= 65536)
        data = os.read(fd, 65537)
        require(hashlib.sha256(data).hexdigest() == PINNED_MCP_SHA)
    finally:
        os.close(fd)
    client = types.ModuleType('fixed_cc5_mcp')
    client.__file__ = str(path)
    exec(compile(data, str(path), 'exec'), client.__dict__)  # Verified bytes, no reread or pycache.
    return client


def run(root, client, source, sink):
    config = client.read_config(root)
    path = root / 'tool.sock'
    require(len(os.fsencode(path)) <= 100 and not path.exists() and not path.is_symlink())
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    socket_identity = None
    attempted = False
    failed = False

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send_error(self, *args, **kwargs):
            self.send_response(403)
            self.send_header('Content-Length', '12')
            self.end_headers()
            self.wfile.write(b'{"ok":false}')

        def do_POST(self):
            nonlocal attempted, failed
            try:
                require(self.path == '/roundtrip' and not attempted and self.headers.get('Transfer-Encoding') is None)
                lengths = self.headers.get_all('Content-Length') or []
                require(len(lengths) == 1 and lengths[0].isdecimal() and 0 < int(lengths[0]) <= MAX_BODY)
                data = self.rfile.read(int(lengths[0]))
                require(len(data) == int(lengths[0]))
                body = client.strict_json(data)
                require(isinstance(body, dict) and set(body) == {'runId', 'operationId', 'rpcId', 'toolUseId', 'name', 'arguments'})
                ident = body['rpcId']
                require(body['runId'] == config['runId'] and body['operationId'] == config['operationId']
                        and body['name'] == 'mcp__ocbridge__roundtrip' and body['arguments'] == {'operationId': config['operationId']}
                        and type(ident) in (str, int) and (not isinstance(ident, str) or 0 < len(ident) <= 256)
                        and (not isinstance(ident, int) or abs(ident) <= 2**53 - 1)
                        and isinstance(body['toolUseId'], str) and 0 < len(body['toolUseId'].encode()) <= 65536
                        and ident != body['toolUseId'])
                attempted = True  # Burn and durably record before sending anything over SSH.
                fd = os.open(root / 'tool-socket-attempt.json', os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600)
                with os.fdopen(fd, 'wb') as record:
                    record.write(json.dumps({'version': 1, 'runId': config['runId'], 'operationId': config['operationId'],
                        'rpcId': ident, 'toolUseId': body['toolUseId']}).encode())
                    record.flush()
                    os.fsync(record.fileno())
                directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
                emit(sink, {'version': 1, 'kind': 'tool-request', 'seq': 1, 'body': base64.b64encode(data).decode()})
                line = source.readline(MAX_FRAME + 1)
                require(line.endswith(b'\n') and len(line) <= MAX_FRAME)
                response = client.strict_json(line)
                require(isinstance(response, dict) and set(response) == {'version', 'kind', 'seq', 'status', 'body'}
                        and type(response['version']) is int and response['version'] == 1
                        and response['kind'] == 'tool-response' and type(response['seq']) is int and response['seq'] == 1
                        and type(response['status']) is int and response['status'] == 200 and isinstance(response['body'], str))
                receipt_bytes = base64.b64decode(response['body'], validate=True)
                require(len(receipt_bytes) <= MAX_BODY)
                value = client.strict_json(receipt_bytes)
                require(isinstance(value, dict) and value.get('ok') is True
                        and type(value.get('rpcId')) is type(ident) and value['rpcId'] == ident
                        and value.get('toolUseId') == body['toolUseId'] and value.get('operationId') == config['operationId'])
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(receipt_bytes)))
                self.end_headers()
                self.wfile.write(receipt_bytes)
            except (OSError, ValueError, TypeError, KeyError, RecursionError):
                failed = attempted
                self.send_error()

    try:
        require(not (root / 'tool-socket-attempt.json').exists())
        listener.bind(str(path))
        os.chmod(path, 0o600)
        listener.listen(1)
        st = path.lstat()
        socket_identity = (st.st_dev, st.st_ino)
        fields = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()
        fd = os.open(root / 'MCP-SOCKET.json', os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as record:
            record.write(json.dumps({'version': 1, 'root': str(root), 'runId': config['runId'],
                'operationId': config['operationId'], 'pid': os.getpid(), 'startTicks': fields[19]}).encode())
            record.flush()
            os.fsync(record.fileno())
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        emit(sink, {'version': 1, 'kind': 'socket-ready', 'runId': config['runId'],
            'operationId': config['operationId'], 'pid': os.getpid(), 'startTicks': fields[19]})
        while not failed:
            readable, _, _ = select.select([listener, source], [], [])
            if source in readable:
                # Any unsolicited controller data is invalid. EOF is normal socket cleanup.
                require(source.readline(MAX_FRAME + 1) == b'')
                break
            connection, _ = listener.accept()
            try:
                _pid, uid, _gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                require(uid == os.getuid())
                connection.settimeout(45)
                Handler(connection, ('local-unix', 0), None)
            finally:
                connection.close()
        return 1 if failed else 0
    finally:
        listener.close()
        if socket_identity is not None:
            st = path.lstat()
            require(stat.S_ISSOCK(st.st_mode) and st.st_uid == os.getuid() and (st.st_dev, st.st_ino) == socket_identity)
            path.unlink()


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2)
        root = Path(sys.argv[1])
        sys.exit(run(root, load_client(root), sys.stdin.buffer, sys.stdout.buffer))
    except Exception:
        sys.stderr.write('CC5_MCP_SOCKET_FAILED_OR_UNKNOWN\n')
        sys.exit(1)
