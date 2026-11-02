#!/usr/bin/env python3
"""Opt-in synthetic cc5 proof, not a production tool/permission server.

The model receives only an operation UUID and this task's Unix socket path.
The execd credential stays on v5-dev. No caller may supply a command or URL.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import socketserver
import sys
import threading
import urllib.request
from urllib.parse import urlsplit


def require(value, message):
    if not value:
        raise ValueError(message)


def command_receipt(wire):
    frames = []
    for row in re.split(r"\r?\n\r?\n", wire.strip()):
        row = row.strip()
        if not row:
            continue
        if row.startswith("data:"):
            row = row[5:].strip()
        frames.append(json.loads(row))
    identifiers = [f.get("text") for f in frames if f.get("type") == "init"]
    terminal = [f for f in frames if f.get("type") in ("execution_complete", "error")]
    require(len(identifiers) == 1 and isinstance(identifiers[0], str), "missing-command-id")
    require(len(terminal) == 1, "missing-or-ambiguous-command-terminal")
    end = terminal[0]
    code = end.get("exit_code", (end.get("error") or {}).get("exit_code"))
    require(end["type"] == "execution_complete" and type(code) is int and code == 0,
            "command-did-not-succeed")
    stdout = "".join(f.get("text", "") for f in frames if f.get("type") == "stdout")
    stderr = "".join(f.get("text", "") for f in frames if f.get("type") == "stderr")
    return {"commandId": identifiers[0], "exitCode": code, "stdout": stdout, "stderr": stderr}


def serve(task_dir):
    require(os.environ.get("OC_AGENT_REMOTE_CC5_SMOKE") == "1", "cc5-smoke-disabled")
    repo = Path(__file__).resolve().parents[2]
    task = Path(task_dir).resolve(strict=True)
    require(repo.name == "ocv5-agentremote-p3-t1555u", "unexpected-task-worktree")
    require(task.parent == repo / ".task-tmp" and task.name.startswith("cc5-smoke-"),
            "unexpected-task-directory")
    state = json.loads((task / "state.json").read_text())
    op = state["operationId"]
    require(re.fullmatch(r"[0-9a-f-]{36}", op), "invalid-operation-id")
    marker = state["marker"]
    require(re.fullmatch(r"CC5_CONTAINER_[0-9a-f]{32}", marker), "invalid-marker")
    endpoint = urlsplit(state["endpoint"])
    require(endpoint.scheme == "http" and endpoint.hostname == "127.0.0.1"
            and endpoint.port and endpoint.path == "" and not endpoint.query
            and not endpoint.fragment and not endpoint.username and not endpoint.password,
            "endpoint-must-be-local-execd")
    fixture = state["fixture"]
    require(fixture == str(task / "world"), "invalid-fixture")
    credential = (task / "execd-test.env").read_text().strip()
    require(re.fullmatch(r"EXECD_ACCESS_TOKEN=[0-9a-f]{48}", credential), "invalid-test-credential")
    access = credential.split("=", 1)[1]
    # All command bytes come from this fixed fixture, never from the caller.
    command = (
        "set -eu; printf '%s\\n' '" + marker + "' > cc5-proof.txt; "
        "printf 'CONTENT='; cat cc5-proof.txt; "
        "printf 'CWD='; pwd; printf 'UID='; id -u; "
        "printf 'PIDNS='; readlink /proc/self/ns/pid; "
        "printf 'SHA256='; sha256sum cc5-proof.txt"
    )
    lock = threading.Lock()
    receipt = None
    attempted = False

    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, *_):
            pass

        def reply(self, status, value):
            data = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            nonlocal receipt, attempted
            try:
                require(self.path == "/roundtrip", "unknown-path")
                require(not self.headers.get("Transfer-Encoding"), "no-transfer-encoding")
                length = int(self.headers.get("Content-Length", "-1"))
                require(0 < length <= 1024, "invalid-body-length")
                body = self.rfile.read(length)
                require(len(body) == length, "incomplete-body")
                request = json.loads(body)
                require(request == {"operationId": op}, "unexpected-operation-or-fields")
                with lock:
                    if receipt is not None:
                        self.reply(200, receipt)
                        return
                    require(not attempted, "previous-attempt-unresolved-no-retry")
                    attempted = True
                    payload = json.dumps({"command": command, "cwd": fixture,
                                          "background": False, "timeout": 10000,
                                          "envs": {"TMPDIR": str(task / "tmp")}}).encode()
                    upstream = urllib.request.Request(
                        state["endpoint"] + "/command", payload,
                        {"Content-Type": "application/json", "X-EXECD-ACCESS-TOKEN": access},
                        method="POST")
                    # No system proxy environment or redirects may receive our synthetic token.
                    class NoRedirect(urllib.request.HTTPRedirectHandler):
                        def redirect_request(self, *_):
                            return None
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                    with opener.open(upstream, timeout=15) as response:
                        wire = response.read(1024 * 1024 + 1)
                    require(len(wire) <= 1024 * 1024, "command-output-too-large")
                    result = command_receipt(wire.decode("utf-8", errors="strict"))
                    expected_hash = hashlib.sha256((marker + "\n").encode()).hexdigest()
                    require("CONTENT=" + marker + "\n" in result["stdout"], "marker-mismatch")
                    require("CWD=" + fixture + "\n" in result["stdout"], "cwd-mismatch")
                    require("UID=65534\n" in result["stdout"], "uid-mismatch")
                    require("SHA256=" + expected_hash + "  cc5-proof.txt\n" in result["stdout"],
                            "hash-mismatch")
                    receipt = {"operationId": op, **result}
                    (task / "proxy-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
                    self.reply(200, receipt)
            except Exception:
                # Do not leak urllib headers, credentials, or opaque daemon errors.
                self.reply(409, {"error": "cc5-smoke-request-failed"})

    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True

    socket_dir = Path("/run") / ("oc-v5-agentremote-t1555u-" + op)
    require(socket_dir.is_dir() and socket_dir.stat().st_uid == os.getuid()
            and socket_dir.stat().st_mode & 0o077 == 0, "unsafe-socket-directory")
    socket_path = socket_dir / "proxy.sock"
    require(not socket_path.exists(), "socket-already-exists")
    with Server(str(socket_path), Handler) as server:
        os.chmod(socket_path, 0o600)
        (task / "proxy-ready").write_text("ready\n")
        server.serve_forever(poll_interval=0.2)


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2, "usage: cc5-smoke-proxy.py TASK_DIR")
        serve(sys.argv[1])
    except Exception as error:
        print("cc5-smoke-proxy: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
