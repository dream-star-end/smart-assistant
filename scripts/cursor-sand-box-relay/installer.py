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
import subprocess
import sys
import uuid

MODULE = "ocv5-197-relay.cjs"
# Inspected native consumer. Unknown versions can stage, never actively restart.
SUPERVISOR_SHA256 = "a387f70a2134addc6a1f576b9a50589a2680d047daed15ecf7d102afc8f741c8"
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
        recorded = None
        if receipt.exists():
            recorded = json.loads(receipt.read_text()) if not receipt.is_symlink() else {}
            if recorded.get("moduleSha256") != expected_hash:
                fail("OPERATION_PAYLOAD_MISMATCH")
        before = host.read_bytes()
        previous_module = target.read_bytes() if target.exists() else None
        # The loaded old relay is not included in native health.isBusy. Publishing
        # backward-compatible source does not cancel its streams; restarting would.
        legacy = recorded.get("legacyRelay", True) if recorded else ("handleSandStreamRelay" in before.decode("utf-8") or previous_module is not None)
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
            result = {"hostBeforeSha256": digest(before), "hostAfterSha256": digest(after), "moduleSha256": expected_hash, "legacyRelay": legacy, "changed": before != after or previous_module != module}
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


def source_predates_process(host, identity):
    # Metadata only. A source changed since this PID started cannot prove which
    # hook that process loaded. Conservative whole-second margin for /proc btime.
    boot = next(int(line.split()[1]) for line in Path("/proc/stat").read_text().splitlines() if line.startswith("btime "))
    started = boot + int(identity) / os.sysconf("SC_CLK_TCK")
    return host.stat().st_mtime < started - 1


def queue_native_restart(host, mailbox, nonce, agent_id, module_hash, check_owner):
    """One fixed-ID native restart, no overwrite or replay after unknown delivery.

    This function has no signal/force/upgrade path. The supervisor, not this
    caller's old observation, performs the final local busy check after the
    maintenance Bot has ended. Intent-before-publish intentionally fails closed
    if interrupted in the cross-file window; natural restart still loads source.
    """
    mailbox = Path(mailbox)
    if mailbox.parent.is_symlink() or not mailbox.parent.is_dir():
        fail("SUPERVISOR_MAILBOX_INVALID")
    intent = Path(host).parent / (".oc-sand-restart-" + nonce + ".json")
    binding = {"id": nonce, "agentId": agent_id, "moduleSha256": module_hash}
    if intent.exists() or intent.is_symlink():
        if intent.is_symlink() or json.loads(intent.read_text()) != binding:
            fail("RESTART_INTENT_MISMATCH")
        return "restart-delivery-unknown"
    # Never inspect or replace another operation's command or its secrets.
    if mailbox.exists() or mailbox.is_symlink():
        fail("SUPERVISOR_COMMAND_BUSY")
    check_owner()
    write_new(intent, json.dumps(binding).encode())
    sync_dir(intent.parent)
    temporary = mailbox.parent / (".oc-restart-" + uuid.uuid4().hex + ".json")
    try:
        write_new(temporary, json.dumps({"id": nonce, "kind": "restart"}).encode())
        check_owner()
        # Atomic no-replace publication: consumer never sees a half-written JSON.
        # These are private mailbox files, not shared release/donor inodes.
        os.link(temporary, mailbox, follow_symlinks=False)
        sync_dir(mailbox.parent)
        return "restart-queued"
    except FileExistsError:
        return "restart-delivery-unknown"
    finally:
        temporary.unlink(missing_ok=True)


def apply_payload(payload, host=Path("/home/box/sand-host/host-main.cjs"),
                  supervisor=Path("/usr/local/bin/sand-supervisor.mjs"),
                  mailbox=Path("/tmp/sand-supervisor/command.json"),
                  identify=pid_identity, predates=source_predates_process):
    host, supervisor = Path(host), Path(supervisor)
    pid, agent_id = payload["expectedPid"], payload.get("agentId")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        fail("HOST_PID_INVALID")
    if not isinstance(agent_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", agent_id):
        fail("MAINTENANCE_AGENT_INVALID")
    identity = identify(pid, host.parent)
    loaded_source_known = predates(host, identity)
    def check():
        if identify(pid, host.parent) != identity:
            fail("HOST_PID_CHANGED")
    native_known = (not supervisor.is_symlink() and supervisor.is_file()
                    and supervisor.stat().st_size <= 1024 * 1024
                    and digest(supervisor.read_bytes()) == SUPERVISOR_SHA256)
    result = install(host, base64.b64decode(payload["moduleBase64"], validate=True), payload["moduleSha256"], payload["nonce"], check)
    check()
    phase = "awaiting-natural-restart"
    if not result["legacyRelay"] and loaded_source_known and native_known:
        if digest(host.read_bytes()) != result["hostAfterSha256"] or digest((host.parent / MODULE).read_bytes()) != payload["moduleSha256"]:
            fail("CONCURRENT_SOURCE_CHANGE")
        phase = queue_native_restart(host, mailbox, payload["nonce"], agent_id, payload["moduleSha256"], check)
    return {"ok": True, "phase": phase, **result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", required=True)
    args = parser.parse_args()
    payload = json.loads(sys.stdin.buffer.read(256 * 1024))
    print(json.dumps(apply_payload(payload)), flush=True)
    # Do not stop this Bot or any process. The caller observes a later capability.


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(json.dumps({"ok": False, "code": code}), flush=True)
        sys.exit(1)
