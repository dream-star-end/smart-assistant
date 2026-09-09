#!/usr/bin/env python3
"""Deterministic owned-Box installer. No secrets, package install, or host upgrade."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import uuid

MODULE = "ocv5-197-relay.cjs"
OLD_ROUTE_KIND = '  const isSandStreamRelay = req.method === "POST" && url2.pathname === SAND_STREAM_RELAY_PATH;'
ROUTE_KIND = '  const isSandStreamRelay = (req.method === "POST" || req.method === "GET") && url2.pathname === SAND_STREAM_RELAY_PATH;'
HANDLE = "async function handleRequest(deps, req, res) {"
CLASSIFY = '  const isCommand = req.method === "POST" && url2.pathname.startsWith(`${GATEWAY_API_PREFIX}/`);'
GROUP = "  if (isEvents || isAvatar || isCommand || isPrepareUpgrade || isLocalExecRequests || isLocalExecResponses || isWebAuthnRequests || isWebAuthnResponses || isCookieOriginApprovalRequests || isCookieOriginApprovalResponses) {"
AUTH = '''    if (deps.authToken != null && !isAuthorized(req, deps.authToken)) {
      return respondError(res, 401, "unauthorized");
    }
    if (isPrepareUpgrade) {'''
SERVICE = '''      log: (message) => context2.host.log(message),
      credentials: context2.host.environment.auth
    });
    context2.onStop(() => service.dispose());'''
REGISTER = '''    registerSandStreamRelayAuth({
      getGrokBotToken: () => service.getGrokBotToken(),
      getMachineId: () => service.getMachineId(),
      backend
    });
    context2.onStop(() => {
      if (__sandStreamRelayAuth != null && __sandStreamRelayAuth.backend === backend) __sandStreamRelayAuth = null;
      service.dispose();
    });'''
HOOK = '''var SAND_STREAM_RELAY_PATH = "/sand-stream-relay/aiserver.v1.InferenceService/Stream";
var __sandStreamRelayAuth = null;
function registerSandStreamRelayAuth(auth2) { __sandStreamRelayAuth = auth2; }
var __ocv5Relay = null;
function handleSandStreamRelay(deps, req, res) {
  if (__ocv5Relay === null) __ocv5Relay = require("./ocv5-197-relay.cjs").createRelay({
    httpClient: createNodeHttpClient({ httpVersion: "1.1" }),
    authorize: isAuthorized,
    getAuth: () => __sandStreamRelayAuth,
    createChecksum: createCursorChecksum
  });
  return __ocv5Relay(deps, req, res);
}

'''
ROUTE = '''    if (isSandStreamRelay) {
      return handleSandStreamRelay(deps, req, res);
    }
'''


def fail(code):
    raise RuntimeError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def patch_source(source):
    if "handleSandStreamRelay" in source:
        old_hook = 'const __ocv5Relay = require("./ocv5-197-relay.cjs").createRelay({'
        old_body = 'function handleSandStreamRelay(deps, req, res) {\n  return __ocv5Relay(deps, req, res);\n}'
        owned = HOOK in source or (old_hook in source and old_body in source)
        if not owned or source.count(HANDLE) != 1 or REGISTER not in source or ROUTE not in source:
            fail("UNSUPPORTED_EXISTING_HOOK")
        # Add a GET-only capability route without changing the original auth gate.
        if source.count(OLD_ROUTE_KIND) == 1:
            return source.replace(OLD_ROUTE_KIND, ROUTE_KIND, 1)
        if source.count(ROUTE_KIND) != 1:
            fail("UNSUPPORTED_EXISTING_HOOK")
        return source
    for anchor in [HANDLE, CLASSIFY, GROUP, AUTH, SERVICE]:
        if source.count(anchor) != 1:
            fail("UNSUPPORTED_HOST_LAYOUT")
    for name in ["createNodeHttpClient", "isAuthorized", "createCursorChecksum"]:
        if not re.search(r"function " + name + r"\s*\(", source):
            fail("UNSUPPORTED_HOST_LAYOUT")
    source = source.replace(HANDLE, HOOK + HANDLE, 1)
    source = source.replace(CLASSIFY, CLASSIFY + '\n' + ROUTE_KIND, 1)
    source = source.replace(GROUP, GROUP.replace(") {", " || isSandStreamRelay) {"), 1)
    source = source.replace(AUTH, AUTH.replace("    if (isPrepareUpgrade) {", ROUTE + "    if (isPrepareUpgrade) {"), 1)
    source = source.replace(SERVICE, SERVICE.replace("    context2.onStop(() => service.dispose());", REGISTER), 1)
    return source


def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def backup(path, data):
    target = path.with_name(path.name + ".oc-backup-" + digest(data))
    if target.exists():
        if target.is_symlink() or target.read_bytes() != data:
            fail("BACKUP_MISMATCH")
    else:
        write_new(target, data)
        sync_dir(path.parent)


def install(host, module, expected_hash, nonce, check_owner=lambda: None):
    host = Path(host)
    if not re.fullmatch(r"[a-f0-9]{64}", expected_hash) or digest(module) != expected_hash:
        fail("MODULE_HASH_MISMATCH")
    if not re.fullmatch(r"oc-sand-[a-f0-9]{32}", nonce):
        fail("NONCE_INVALID")
    if host.is_symlink() or not host.is_file() or host.stat().st_size > 64 * 1024 * 1024:
        fail("HOST_PATH_INVALID")
    target = host.parent / MODULE
    if target.is_symlink() or (target.exists() and not target.is_file()):
        fail("MODULE_PATH_INVALID")
    lock_fd = os.open(host.parent / ".oc-sand-install.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "r+b") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("INSTALL_BUSY")
        check_owner()
        receipt = host.parent / (".oc-sand-receipt-" + nonce + ".json")
        if receipt.exists():
            if receipt.is_symlink() or json.loads(receipt.read_text()).get("moduleSha256") != expected_hash:
                fail("OPERATION_PAYLOAD_MISMATCH")
        before = host.read_bytes()
        previous_module = target.read_bytes() if target.exists() else None
        after = patch_source(before.decode("utf-8")).encode("utf-8")
        suffix = uuid.uuid4().hex
        module_next = host.parent / (".oc-module-" + suffix + ".cjs")
        host_next = host.parent / (".oc-host-" + suffix + ".cjs")
        try:
            write_new(module_next, module)
            write_new(host_next, after, host.stat().st_mode & 0o777)
            for candidate in [module_next, host_next]:
                result = subprocess.run(["node", "--check", str(candidate)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
                if result.returncode != 0:
                    fail("SYNTAX_CHECK_FAILED")
            check_owner()
            if host.read_bytes() != before or (target.read_bytes() if target.exists() else None) != previous_module:
                fail("CONCURRENT_SOURCE_CHANGE")
            backup(host, before)
            if previous_module is not None:
                backup(target, previous_module)
            os.replace(module_next, target)
            if after != before:
                os.replace(host_next, host)
            sync_dir(host.parent)
            result = {"hostBeforeSha256": digest(before), "hostAfterSha256": digest(after), "moduleSha256": expected_hash, "changed": before != after or previous_module != module}
            if not receipt.exists():
                write_new(receipt, json.dumps(result).encode())
                sync_dir(host.parent)
            return result
        finally:
            module_next.unlink(missing_ok=True)
            host_next.unlink(missing_ok=True)


def pid_identity(pid, directory):
    # Process metadata only: never inspect environ, cmdline, memory or credentials.
    if Path(os.readlink(f"/proc/{pid}/cwd")).resolve() != directory.resolve():
        fail("HOST_PID_MISMATCH")
    if not Path(os.readlink(f"/proc/{pid}/exe")).name.startswith("node"):
        fail("HOST_PID_MISMATCH")
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", required=True)
    args = parser.parse_args()
    payload = json.loads(sys.stdin.buffer.read(256 * 1024))
    host = Path("/home/box/sand-host/host-main.cjs")
    pid = payload["expectedPid"]
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        fail("HOST_PID_INVALID")
    identity = pid_identity(pid, host.parent)
    def check():
        if pid_identity(pid, host.parent) != identity:
            fail("HOST_PID_CHANGED")
    result = install(host, base64.b64decode(payload["moduleBase64"], validate=True), payload["moduleSha256"], payload["nonce"], check)
    check()
    print(json.dumps({"ok": True, "phase": "applied-before-reload", **result}), flush=True)
    os.kill(pid, signal.SIGTERM)
    # The caller must observe a new healthy process and the expected capability hash.


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(json.dumps({"ok": False, "code": code}), flush=True)
        sys.exit(1)
