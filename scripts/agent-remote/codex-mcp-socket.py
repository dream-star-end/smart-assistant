#!/usr/bin/env python3
"""Fixed Unix MCP endpoint over ordinary SSH exec stdio; no SSH forwarding or TCP.

No model tool executes here. The only operation is relaying closed task RPCs
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
import time

PINNED_MCP_SHA = 'eb27f0a14c1c6dcda98b009ae29e6800b39aeb8905894e0173a8477642e8ce3a'
MAX_BODY = 98304 + 65536 + 4096
MAX_FRAME = 262144


def require(value):
    if not value:
        raise ValueError('CODEX_MCP_SOCKET_REJECTED')


def emit(stream, value):
    data = json.dumps(value, separators=(',', ':')).encode() + b'\n'
    require(len(data) <= MAX_FRAME)
    stream.write(data)
    stream.flush()


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_record(path, data):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'wb') as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())
    sync_dir(path.parent)


def load_client(root):
    path = root / 'codex-fixed-mcp.py'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1
                and stat.S_IMODE(st.st_mode) == 0o400 and 0 < st.st_size <= 65536)
        data = os.read(fd, 65537)
        require(hashlib.sha256(data).hexdigest() == PINNED_MCP_SHA)
    finally:
        os.close(fd)
    client = types.ModuleType('fixed_codex_mcp')
    client.__file__ = str(path)
    exec(compile(data, str(path), 'exec'), client.__dict__)  # Verified bytes, no reread or pycache.
    return client


def run(root, client, source, sink):
    config = client.read_config(root)
    path = root / 'tool.sock'
    require(len(os.fsencode(path)) <= 100 and not path.exists() and not path.is_symlink())
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    socket_identity = None
    sequence = 0
    seen_rpc = set()
    attempts = root / 'tool-attempts'
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
            nonlocal sequence, failed
            dispatched = False
            try:
                require(self.path == '/roundtrip' and self.headers.get('Transfer-Encoding') is None)
                lengths = self.headers.get_all('Content-Length') or []
                require(len(lengths) == 1 and lengths[0].isdecimal() and 0 < int(lengths[0]) <= MAX_BODY)
                data = self.rfile.read(int(lengths[0]))
                require(len(data) == int(lengths[0]))
                body = client.strict_json(data)
                client.valid_strings(body)
                config = client.read_config(root)
                catalog = client.read_catalog(root)
                client.validate_request(body, config, catalog)
                ident = body['rpcId']
                input_hash = body['inputSha256']
                require((type(ident), ident) not in seen_rpc and not (root/'STOPPING.json').exists())
                key = hashlib.sha256(body['callId'].encode()).hexdigest()
                observation = root/'observations'/(key+'.json')
                end = time.monotonic()+2
                while not observation.exists() and time.monotonic()<end:
                    time.sleep(0.01)
                evidence = client.strict_json(client.read_private(observation.parent, observation.name, 16384))
                expected = {k:body[k] for k in client.IDENTITY if k != 'rpcId'}
                require(evidence == expected and not (root/'STOPPING.json').exists())
                require(not (attempts/(key+'.attempt.json')).exists() and sequence<10000)
                sequence += 1
                seen_rpc.add((type(ident), ident))
                # O_EXCL and file + directory fsync precede the first SSH byte.
                dispatched = True
                durable_record(attempts / (key + '.attempt.json'), client.canonical(body))
                emit(sink, {'version': 3, 'engine': 'codex', 'kind': 'tool-request', 'seq': sequence, 'body': base64.b64encode(data).decode()})
                line = source.readline(MAX_FRAME + 1)
                require(line.endswith(b'\n') and len(line) <= MAX_FRAME)
                response = client.strict_json(line)
                require(isinstance(response, dict) and set(response) == {'version', 'engine', 'kind', 'seq', 'status', 'body'}
                        and type(response['version']) is int and response['version'] == 3 and response['engine'] == 'codex'
                        and response['kind'] == 'tool-response' and type(response['seq']) is int and response['seq'] == sequence
                        and type(response['status']) is int and response['status'] == 200 and isinstance(response['body'], str))
                receipt_bytes = base64.b64decode(response['body'], validate=True)
                require(len(receipt_bytes) <= client.MAX_REPLY)
                value = client.strict_json(receipt_bytes)
                client.validate_response(value, body)
                durable_record(attempts / (key + '.result.json'), receipt_bytes)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(receipt_bytes)))
                self.end_headers()
                self.wfile.write(receipt_bytes)
            except (OSError, ValueError, TypeError, KeyError, RecursionError):
                failed = failed or dispatched
                self.send_error()

    try:
        # Kept across the task's start rounds: an attempt recorded by an earlier round still
        # forbids dispatching that tool use again after a resume.
        if not attempts.exists() and not attempts.is_symlink():
            attempts.mkdir(mode=0o700)
            sync_dir(root)
        st = attempts.lstat()
        require(stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o700)
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
        emit(sink, {'version': 3, 'engine': 'codex', 'generation': config['generation'], 'kind': 'socket-ready', 'runId': config['runId'],
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
                connection.settimeout(720)  # Same bound as cc5-fixed-mcp.py TOOL_TIMEOUT.
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
        sys.stderr.write('CODEX_MCP_SOCKET_FAILED_OR_UNKNOWN\n')
        sys.exit(1)
