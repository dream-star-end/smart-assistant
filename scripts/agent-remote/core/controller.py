#!/usr/bin/env python3
"""Unified generation-root node controller (`remote-driver-v4`).

Zero per-engine conditionals (`AC-6`): `launchSpec`, `decode`, `encode`, `probe`, and `usagePolicy`
come exclusively from the registered 5-duty driver, while this core owns:
- generation immutability & atomic `MANIFEST.json` / `STOPPING.json` fencing,
- `(node, engineId, profileId)` admission & memory gates (`core/resources.py`),
- systemd scope isolation (`MemoryMax`, `TasksMax=128`, `KillMode=control-group`),
- raw native stdout evidence journaling + master framing,
- strict stop proof (`bootId`, cgroup `dev/inode`, empty `cgroup.procs` & `populated 0`,
  optional root-scoped tmux check, and `AF_UNIX` `tool.sock` non-listening check).
"""
from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from core import resources  # noqa: E402
from core.canonical import remote_canonical_bytes, remote_canonical_sha256, strict_json  # noqa: E402
from core.contract import (  # noqa: E402
    ENGINE_ID_RE,
    GENERATION_RE,
    IDENT_RE,
    MAX_LINE_BYTES,
    PROFILE_ID_RE,
    PROTOCOL_VERSION,
    SHA256_RE,
    compute_core_digest,
    compute_probe_fingerprint,
    file_sha256,
    load_driver,
    need,
    validate_decode_batch,
    validate_encode_batch,
    validate_launch_spec,
    validate_model_snapshot,
)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def boot_id() -> str:
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def sync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_private(path: Path, limit: int = MAX_LINE_BYTES) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        need(
            stat.S_ISREG(st.st_mode)
            and st.st_uid == os.getuid()
            and st.st_nlink == 1
            and not (st.st_mode & 0o077)
            and 0 < st.st_size <= limit,
            "REMOTE_FILE_UNSAFE",
        )
        data = os.read(fd, limit + 1)
        need(len(data) == st.st_size, "REMOTE_FILE_CHANGED")
        return data
    finally:
        os.close(fd)


def record_exclusive(path: Path, value: Any, mode: int = 0o600) -> None:
    payload = value if isinstance(value, bytes) else remote_canonical_bytes(value)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as out:
        out.write(payload)
        out.flush()
        os.fsync(out.fileno())
    sync_dir(path.parent)


def atomic_write(path: Path, value: Any, mode: int = 0o600) -> None:
    payload = value if isinstance(value, bytes) else remote_canonical_bytes(value)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as out:
            out.write(payload)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        sync_dir(path.parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def ensure_private_dir(path: Path, create: bool = False, mode: int = 0o700) -> None:
    if create:
        path.mkdir(mode=mode, parents=False, exist_ok=False)
    st = path.lstat()
    need(
        stat.S_ISDIR(st.st_mode)
        and st.st_uid == os.getuid()
        and not (st.st_mode & 0o077)
        and path.resolve() == path.absolute(),
        "REMOTE_DIR_UNSAFE",
    )


def validate_task_root(value: str) -> Path:
    root = Path(value)
    home = Path.home()
    normal = root.parent == home and re.fullmatch(r"oc-remotedrv-[a-z0-9-]{16,72}", root.name)
    sandbox = (
        str(root).startswith("/tmp/oc-drvtest-")
        and len(root.parts) >= 4
        and re.fullmatch(r"run-[a-z0-9-]{4,64}", root.name)
    )
    need(((normal and os.getuid() != 0) or sandbox) and root.absolute() == root, "REMOTE_TASK_ROOT_INVALID")
    return root


def lock_nb(path: Path) -> int:
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    st = os.fstat(fd)
    if not (stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1 and not (st.st_mode & 0o077)):
        os.close(fd)
        raise ValueError("REMOTE_LOCK_UNSAFE")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise ValueError("REMOTE_LANE_BUSY") from None
    return fd


def lock_wait(path: Path) -> int:
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    st = os.fstat(fd)
    if not (stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1 and not (st.st_mode & 0o077)):
        os.close(fd)
        raise ValueError("REMOTE_LOCK_UNSAFE")
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def creation_lock(root: Path) -> int:
    root.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    return lock_wait(root.parent / ("." + root.name + ".create.lock"))


def read_manifest(root: Path) -> Dict[str, Any]:
    ensure_private_dir(root)
    m = strict_json(read_private(root / "MANIFEST.json", 65536))
    need(
        isinstance(m, dict)
        and m.get("version") == PROTOCOL_VERSION
        and m.get("root") == str(root)
        and isinstance(m.get("driverId"), str)
        and ENGINE_ID_RE.fullmatch(m["driverId"])
        and isinstance(m.get("engineId"), str)
        and ENGINE_ID_RE.fullmatch(m["engineId"])
        and isinstance(m.get("operationId"), str)
        and IDENT_RE.fullmatch(m["operationId"])
        and isinstance(m.get("runId"), str)
        and IDENT_RE.fullmatch(m["runId"])
        and isinstance(m.get("generation"), str)
        and GENERATION_RE.fullmatch(m["generation"])
        and isinstance(m.get("profileId"), str)
        and PROFILE_ID_RE.fullmatch(m["profileId"])
        and isinstance(m.get("authEpoch"), str)
        and IDENT_RE.fullmatch(m["authEpoch"])
        and isinstance(m.get("model"), str)
        and IDENT_RE.fullmatch(m["model"])
        and isinstance(m.get("driverDigest"), str)
        and SHA256_RE.fullmatch(m["driverDigest"])
        and isinstance(m.get("coreDigest"), str)
        and SHA256_RE.fullmatch(m["coreDigest"]),
        "REMOTE_MANIFEST_INVALID",
    )
    if m.get("nativeSessionId") is not None:
        need(isinstance(m["nativeSessionId"], str) and IDENT_RE.fullmatch(m["nativeSessionId"]), "REMOTE_MANIFEST_INVALID")
    if m.get("maxConcurrentLanes") is not None:
        need(type(m["maxConcurrentLanes"]) is int and m["maxConcurrentLanes"] > 0, "REMOTE_MANIFEST_INVALID")
    if m.get("maxSliceMemoryBytes") is not None:
        need(type(m["maxSliceMemoryBytes"]) is int and m["maxSliceMemoryBytes"] > 0, "REMOTE_MANIFEST_INVALID")
    if m.get("registryPath") is not None:
        need(
            str(root).startswith("/tmp/oc-drvtest-") and isinstance(m["registryPath"], str),
            "REMOTE_REGISTRY_OVERRIDE_FORBIDDEN",
        )
    return m


def binding_fields(m: Dict[str, Any]) -> Dict[str, str]:
    return {
        k: m[k]
        for k in ("driverId", "engineId", "operationId", "runId", "generation", "profileId", "authEpoch")
    }


def scope_name(root: Path, m: Dict[str, Any], role: str) -> str:
    digest = remote_canonical_sha256([str(root), binding_fields(m), role])[:28]
    return f"oc-{m['engineId']}-{role}-{digest}.scope"


def apply_folder_trust(ft: Dict[str, Any]) -> None:
    target = Path(ft["claudeJsonPath"])
    lock_dir = target.parent / (target.name + ".lock")
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    for _ in range(100):
        try:
            lock_dir.mkdir(mode=0o700)
            break
        except FileExistsError:
            time.sleep(0.05)
    else:
        raise ValueError("REMOTE_FOLDER_TRUST_LOCK_BUSY")
    try:
        cfg = json.loads(target.read_text()) if target.exists() else {}
        proj = cfg.setdefault("projects", {}).setdefault(ft["cwd"], {})
        if proj.get("hasTrustDialogAccepted") is True:
            return
        proj["hasTrustDialogAccepted"] = True
        atomic_write(target, (json.dumps(cfg, indent=2) + "\n").encode("utf-8"), mode=0o600)
    finally:
        lock_dir.rmdir()


def publish_manifest(root: Path, m: Dict[str, Any]) -> None:
    need(not (root / "MANIFEST.json").exists() and not (root / "MANIFEST.json").is_symlink(), "REMOTE_MANIFEST_EXISTS")
    atomic_write(root / "MANIFEST.json", m, mode=0o600)


def provision(root: Path) -> None:
    ctrl = creation_lock(root)
    try:
        need(not root.exists() and not root.is_symlink(), "REMOTE_ROOT_ALREADY_EXISTS")
        line = sys.stdin.buffer.readline(8 * 1024 * 1024 + 1)
        need(len(line) <= 8 * 1024 * 1024 and line.endswith(b"\n"), "REMOTE_PROVISION_PACKET_OVERFLOW")
        packet = strict_json(line)
        need(
            isinstance(packet, dict)
            and {"manifest", "tools", "driverContext", "verifiedProbe"} <= set(packet.keys())
            and set(packet.keys()) <= {"manifest", "tools", "driverContext", "verifiedProbe", "registryPath"},
            "REMOTE_PROVISION_PACKET_INVALID",
        )
        m = packet["manifest"]
        need(isinstance(m, dict) and m.get("root") == str(root), "REMOTE_MANIFEST_INVALID")
        reg_path = packet.get("registryPath")
        sandbox = str(root).startswith("/tmp/oc-drvtest-")
        if reg_path is not None:
            need(sandbox, "REMOTE_REGISTRY_OVERRIDE_FORBIDDEN")
            m = {**m, "registryPath": str(reg_path)}

        driver_mod, meta, actual_driver_digest = load_driver(
            m["driverId"],
            registry_path=reg_path,
            expected_digest=m.get("driverDigest"),
            allow_sandbox_override=sandbox,
        )
        actual_core_digest = compute_core_digest()
        need(
            meta["engineId"] == m.get("engineId")
            and actual_driver_digest == m.get("driverDigest")
            and actual_core_digest == m.get("coreDigest"),
            "REMOTE_DRIVER_OR_CORE_DIGEST_MISMATCH",
        )

        ensure_private_dir(root, create=True, mode=0o700)
        publish_manifest(root, m)
        m = read_manifest(root)

        for sub in ("home", "tmp", "observations", "tool-attempts"):
            ensure_private_dir(root / sub, create=True, mode=0o700)
        ensure_private_dir(root / "cwd", create=True, mode=0o700)

        driver_ctx = {
            **(packet["driverContext"] if isinstance(packet["driverContext"], dict) else {}),
            "root": str(root),
            "mcpClientPath": str((Path(__file__).resolve().parent / "mcp_client.py").resolve()),
            "operationId": m["operationId"],
            "runId": m["runId"],
            "generation": m["generation"],
            "profileId": m["profileId"],
            "authEpoch": m["authEpoch"],
            "model": m["model"],
            "nativeSessionId": m.get("nativeSessionId"),
            "tools": packet["tools"],
        }
        spec = validate_launch_spec(driver_mod.launch_spec(driver_ctx, packet["verifiedProbe"]), root)

        for rel_dir in spec["dirs"]:
            target_dir = root / rel_dir
            target_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            ensure_private_dir(target_dir)

        for rel_file, fspec in spec["files"].items():
            target_file = root / rel_file
            target_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fbytes = (
                base64.b64decode(fspec["contentB64"], validate=True)
                if "contentB64" in fspec
                else fspec["content"].encode("utf-8", errors="strict")
            )
            fmode = int(fspec.get("mode", 0o400))
            need(fmode in (0o400, 0o500, 0o600), "REMOTE_LAUNCH_FILE_MODE_INVALID")
            record_exclusive(target_file, fbytes, mode=fmode)

        record_exclusive(root / "tools.json", packet["tools"], mode=0o400)
        tools_sha = sha(read_private(root / "tools.json"))
        raw_dctx = packet["driverContext"] if isinstance(packet["driverContext"], dict) else {}
        disable_wal_fault = raw_dctx.get("testFaultDisableAttemptWal") is True
        bypass_admit_fault = raw_dctx.get("testFaultBypassAdmit") is True
        if disable_wal_fault or bypass_admit_fault:
            need(sandbox, "REMOTE_FAULT_INJECTION_SANDBOX_ONLY")
        client_cfg: Dict[str, Any] = {
            "version": PROTOCOL_VERSION,
            **binding_fields(m),
            "driverDigest": m["driverDigest"],
            "catalogSha256": tools_sha,
            "requireNodeObservation": bool(meta.get("requireNodeObservation", False)),
        }
        if disable_wal_fault:
            client_cfg["testFaultDisableAttemptWal"] = True
        if bypass_admit_fault:
            record_exclusive(root / "SANDBOX-FAULT.json", {"testFaultBypassAdmit": True}, mode=0o400)
        if m.get("nativeSessionId"):
            client_cfg["nativeSessionId"] = m["nativeSessionId"]
            if not (root / "NATIVE-SESSION.json").exists():
                record_exclusive(root / "NATIVE-SESSION.json", {"nativeSessionId": m["nativeSessionId"]}, mode=0o600)
        if reg_path is not None:
            client_cfg["registryPath"] = str(reg_path)
        record_exclusive(root / "client.json", client_cfg, mode=0o400)

        # Validate catalog right away via unified mcp_client.
        from core.mcp_client import read_catalog, read_config as read_mcp_cfg

        read_catalog(root, read_mcp_cfg(root))

        record_exclusive(root / "LAUNCH.json", spec, mode=0o400)
        record_exclusive(
            root / "PROVISIONED.json",
            {
                "version": PROTOCOL_VERSION,
                **binding_fields(m),
                "manifestSha256": sha(read_private(root / "MANIFEST.json")),
                "launchSha256": sha(read_private(root / "LAUNCH.json")),
            },
            mode=0o400,
        )
        print(
            json.dumps({"version": PROTOCOL_VERSION, "kind": "provisioned", **binding_fields(m)}, separators=(",", ":")),
            flush=True,
        )
    finally:
        os.close(ctrl)


def verify_provisioned_spec(root: Path, m: Dict[str, Any]) -> Dict[str, Any]:
    prov = strict_json(read_private(root / "PROVISIONED.json"))
    need(
        prov.get("manifestSha256") == sha(read_private(root / "MANIFEST.json"))
        and prov.get("launchSha256") == sha(read_private(root / "LAUNCH.json")),
        "REMOTE_PROVISION_TAMPERED",
    )
    spec = strict_json(read_private(root / "LAUNCH.json"))
    sandbox = str(root).startswith("/tmp/oc-drvtest-")
    _, meta, actual_driver_digest = load_driver(
        m["driverId"],
        registry_path=m.get("registryPath"),
        expected_digest=m["driverDigest"],
        allow_sandbox_override=sandbox,
    )
    need(
        meta["engineId"] == m["engineId"]
        and actual_driver_digest == m["driverDigest"]
        and compute_core_digest() == m["coreDigest"],
        "REMOTE_DRIVER_OR_CORE_DIGEST_MISMATCH",
    )
    for art_path_str, expected_sha in (spec.get("artifactDigests") or {}).items():
        actual = file_sha256(Path(art_path_str).resolve())
        need(actual == expected_sha, "REMOTE_CLI_OR_BRIDGE_HASH_MISMATCH")
    return spec


def lane_admission(root: Path, m: Dict[str, Any]) -> Dict[str, Any]:
    sandbox = str(root).startswith("/tmp/oc-drvtest-")
    bypass_admit = False
    if (root / "SANDBOX-FAULT.json").exists():
        need(sandbox, "REMOTE_FAULT_INJECTION_SANDBOX_ONLY")
        fcfg = strict_json(read_private(root / "SANDBOX-FAULT.json"))
        bypass_admit = isinstance(fcfg, dict) and fcfg.get("testFaultBypassAdmit") is True
    c = resources.config(m["engineId"], registry_path=m.get("registryPath"), allow_sandbox_override=sandbox)
    scopes = {
        scope_name(root, m, "app"): c["app"],
        scope_name(root, m, "socket"): c["socket"],
    }
    return resources.admit(
        str(root),
        m["engineId"],
        m["profileId"],
        scopes,
        kind="lane",
        master_max_lanes=m.get("maxConcurrentLanes"),
        master_max_memory_bytes=m.get("maxSliceMemoryBytes"),
        registry_path=m.get("registryPath"),
        allow_sandbox_override=sandbox,
        test_fault_bypass_admit=bypass_admit,
    )


def start_scope_process(
    root: Path,
    role: str,
    m: Dict[str, Any],
    **streams: Any,
) -> subprocess.Popen[bytes]:
    ctrl = lock_wait(root / "CONTROL.lock")
    try:
        need(not (root / "STOPPING.json").exists(), "REMOTE_FENCED")
        unit = scope_name(root, m, role)
        record_exclusive(root / f"{role.upper()}-STARTING.json", {"unit": unit, "bootId": boot_id(), **binding_fields(m)})
        sandbox = str(root).startswith("/tmp/oc-drvtest-")
        c = resources.config(m["engineId"], registry_path=m.get("registryPath"), allow_sandbox_override=sandbox)
        worker_argv = ["/usr/bin/python3", "-I", "-B", str(Path(__file__).resolve()), "_worker", str(root), role]
        fake_dir = resources._fake_systemd_dir()

        if fake_dir is not None:
            env = {
                "HOME": str(Path.home()),
                "PATH": "/usr/bin:/bin",
                "LANG": "C.UTF-8",
                **{k: v for k, v in os.environ.items() if k.startswith("OC_REMOTE_")},
            }
            proc = subprocess.Popen(worker_argv, cwd=root, env=env, start_new_session=True, **streams)
            cg_dir = fake_dir / ("cgroup-" + unit)
            resources.register_fake_scope(unit, c["slice"], c[role], proc.pid, cg_dir)
            st = cg_dir.stat()
            record_exclusive(
                root / f"{role.upper()}-SCOPE.json",
                {
                    "unit": unit,
                    "bootId": boot_id(),
                    **binding_fields(m),
                    "cgroup": f"/user.slice/{c['slice']}/{unit}",
                    "cgroupPath": str(cg_dir),
                    "pgid": proc.pid,
                    "dev": st.st_dev,
                    "inode": st.st_ino,
                },
            )
            record_exclusive(root / f"{role.upper()}-ADMITTED.json", {"unit": unit, **binding_fields(m)})
            return proc

        cmd = [
            "/usr/bin/systemd-run",
            "--user",
            "--scope",
            "--quiet",
            "--unit",
            unit,
            "-p",
            "Slice=" + c["slice"],
            "-p",
            "MemoryMax=" + str(c[role]),
            "-p",
            "TasksMax=128",
            "-p",
            "KillMode=control-group",
            "--",
            "/usr/bin/env",
            "-i",
            f"HOME={Path.home()}",
            "PATH=/usr/bin:/bin",
            "LANG=C.UTF-8",
            *worker_argv,
        ]
        proc = subprocess.Popen(
            cmd,
            cwd=root,
            env={"PATH": "/usr/bin:/bin", "XDG_RUNTIME_DIR": "/run/user/" + str(os.getuid())},
            **streams,
        )
        try:
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                st_map = resources.state(unit)
                group = st_map.get("ControlGroup")
                if group and st_map.get("ActiveState") == "active":
                    cg_path = Path("/sys/fs/cgroup" + group)
                    st = cg_path.stat()
                    record_exclusive(
                        root / f"{role.upper()}-SCOPE.json",
                        {
                            "unit": unit,
                            "bootId": boot_id(),
                            **binding_fields(m),
                            "cgroup": group,
                            "cgroupPath": str(cg_path),
                            "dev": st.st_dev,
                            "inode": st.st_ino,
                        },
                    )
                    record_exclusive(root / f"{role.upper()}-ADMITTED.json", {"unit": unit, **binding_fields(m)})
                    return proc
                if proc.poll() is not None:
                    break
                time.sleep(0.03)
            raise ValueError("REMOTE_SCOPE_START_UNKNOWN")
        except BaseException:
            resources.stop_unit(unit)
            proc.wait(timeout=8)
            raise
    finally:
        os.close(ctrl)


def worker_entry(root: Path, role: str) -> int:
    m = read_manifest(root)
    need(role in ("app", "socket"), "REMOTE_WORKER_ROLE_INVALID")
    deadline = time.monotonic() + 12.0
    while not (root / f"{role.upper()}-ADMITTED.json").exists():
        need(time.monotonic() < deadline and not (root / "STOPPING.json").exists(), "REMOTE_WORKER_ADMIT_TIMEOUT")
        time.sleep(0.02)
    need(not (root / "STOPPING.json").exists(), "REMOTE_FENCED")
    saved = strict_json(read_private(root / f"{role.upper()}-SCOPE.json", 32768))
    need(saved["bootId"] == boot_id(), "REMOTE_BOOT_MISMATCH")
    if resources._fake_systemd_dir() is None:
        actual_cg = Path("/proc/self/cgroup").read_text().strip()
        need(actual_cg == "0::" + saved["cgroup"], "REMOTE_CGROUP_ESCAPE_DETECTED")

    spec = verify_provisioned_spec(root, m)
    if role == "app" and spec.get("folderTrust"):
        apply_folder_trust(spec["folderTrust"])
    os.chdir(spec["cwd"])
    if role == "app":
        os.execve(spec["argv"][0], spec["argv"], spec["environment"])
    sock_script = str((Path(__file__).resolve().parent / "mcp_socket.py").resolve())
    sock_env = {
        "HOME": str(Path.home()),
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "TMPDIR": str(root / "tmp"),
    }
    os.execve("/usr/bin/python3", ["/usr/bin/python3", "-I", "-B", sock_script, str(root)], sock_env)
    return 126


def fence_stopping(root: Path, m: Dict[str, Any]) -> None:
    stop_path = root / "STOPPING.json"
    if not stop_path.exists():
        try:
            record_exclusive(stop_path, {"version": PROTOCOL_VERSION, **binding_fields(m)})
        except FileExistsError:
            pass


def fence_unprovisioned(root: Path, expected: Dict[str, Any]) -> Dict[str, Any]:
    ctrl = creation_lock(root)
    try:
        if not root.exists():
            ensure_private_dir(root, create=True)
            sync_dir(root.parent)
        ensure_private_dir(root)
        if not (root / "MANIFEST.json").exists():
            need(
                not any((root / f"{r}-STARTING.json").exists() for r in ("APP", "SOCKET")),
                "REMOTE_UNPROVISIONED_RACE",
            )
            publish_manifest(root, expected)
        m = read_manifest(root)
        for k, v in binding_fields(expected).items():
            need(m.get(k) == v, "REMOTE_FENCE_MANIFEST_MISMATCH")
        fence_stopping(root, m)
        return m
    finally:
        os.close(ctrl)


def _stop_tmux_checks(root: Path) -> None:
    if (root / "LAUNCH.json").exists():
        spec = strict_json(read_private(root / "LAUNCH.json"))
        sc = spec.get("stopChecks")
        if isinstance(sc, dict) and Path(sc["tmuxTmpDir"]).exists():
            subprocess.run(
                ["tmux", "-L", sc["tmuxSocketLabel"], "kill-server"],
                env={"PATH": "/usr/bin:/bin", "TMUX_TMPDIR": sc["tmuxTmpDir"]},
                capture_output=True,
                timeout=5,
            )


def _stop_role_scope(root: Path, role: str) -> None:
    start_file = root / f"{role.upper()}-STARTING.json"
    if start_file.exists():
        data = strict_json(read_private(start_file))
        need(data["bootId"] == boot_id(), "REMOTE_STOP_UNKNOWN")
        scope_file = root / f"{role.upper()}-SCOPE.json"
        if scope_file.exists():
            sdata = strict_json(read_private(scope_file))
            pgid = sdata.get("pgid")
            if isinstance(pgid, int) and pgid > 1:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        resources.stop_unit(data["unit"])


def stop_app_scope_only(root: Path) -> None:
    _stop_tmux_checks(root)
    _stop_role_scope(root, "app")


def stop_scopes(root: Path, m: Dict[str, Any]) -> None:
    ctrl = lock_wait(root / "CONTROL.lock")
    try:
        fence_stopping(root, m)
    finally:
        os.close(ctrl)

    _stop_tmux_checks(root)
    for role in ("app", "socket"):
        _stop_role_scope(root, role)


def _prove_role_stopped(root: Path, m: Dict[str, Any], role: str) -> Optional[Dict[str, Any]]:
    wfd = lock_nb(root / f"{role.upper()}-WRITER.lock")
    os.close(wfd)
    if not (root / f"{role.upper()}-STARTING.json").exists():
        return None
    data = strict_json(read_private(root / f"{role.upper()}-SCOPE.json", 32768))
    need(
        data["bootId"] == boot_id() and all(data.get(k) == v for k, v in binding_fields(m).items()),
        "REMOTE_STOP_UNKNOWN",
    )
    pgid = data.get("pgid")
    if isinstance(pgid, int) and pgid > 1:
        try:
            os.killpg(pgid, 0)
            raise ValueError("REMOTE_STOP_PROCESS_STILL_ALIVE")
        except ProcessLookupError:
            pass
    st_map = resources.state(data["unit"])
    need(
        st_map.get("ActiveState") in ("inactive", "failed") and not st_map.get("ControlGroup"),
        "REMOTE_STOP_UNKNOWN",
    )
    cg_path = Path(data["cgroupPath"])
    if cg_path.exists():
        st = cg_path.stat()
        need((st.st_dev, st.st_ino) == (data["dev"], data["inode"]), "REMOTE_STOP_CGROUP_REPLACED")
        need(
            not (cg_path / "cgroup.procs").read_text().strip()
            and "populated 0" in (cg_path / "cgroup.events").read_text(),
            "REMOTE_STOP_CGROUP_POPULATED",
        )
    wfd = lock_nb(root / f"{role.upper()}-WRITER.lock")
    os.close(wfd)
    return {**data, "populated": 0, "domainRemoved": not cg_path.exists()}


def _prove_tmux_stopped(root: Path) -> None:
    if (root / "LAUNCH.json").exists():
        spec = strict_json(read_private(root / "LAUNCH.json"))
        sc = spec.get("stopChecks")
        if isinstance(sc, dict) and Path(sc["tmuxTmpDir"]).exists():
            for sess in sc["sessions"]:
                r = subprocess.run(
                    ["tmux", "-L", sc["tmuxSocketLabel"], "has-session", "-t", "=" + sess],
                    env={"PATH": "/usr/bin:/bin", "TMUX_TMPDIR": sc["tmuxTmpDir"]},
                    capture_output=True,
                    timeout=5,
                )
                need(r.returncode != 0, "REMOTE_STOP_TMUX_SESSION_ALIVE")


def prove_stopped(root: Path, m: Dict[str, Any]) -> Dict[str, Any]:
    details: List[Dict[str, Any]] = []
    need((root / "STOPPING.json").exists(), "REMOTE_STOP_UNKNOWN")

    for role in ("app", "socket"):
        proved = _prove_role_stopped(root, m, role)
        if proved is not None:
            details.append(proved)

    _prove_tmux_stopped(root)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(0.5)
    try:
        sock.connect(str(root / "tool.sock"))
        raise ValueError("REMOTE_STOP_SOCKET_STILL_LISTENING")
    except (FileNotFoundError, ConnectionRefusedError):
        pass
    finally:
        sock.close()

    return {
        "version": PROTOCOL_VERSION,
        **binding_fields(m),
        "bootId": boot_id(),
        "remoteStopped": True,
        "scopes": details,
    }


def _clean_tree_rw(target: Path) -> None:
    if not target.exists() and not target.is_symlink():
        return
    need(not target.is_symlink(), "REMOTE_CLEAN_SYMLINK_FORBIDDEN")
    for cur_root, dirnames, filenames in os.walk(target):
        cur_p = Path(cur_root)
        try:
            cur_p.chmod(0o700)
        except OSError:
            pass
        for d in dirnames:
            dp = cur_p / d
            if not dp.is_symlink():
                try:
                    dp.chmod(0o700)
                except OSError:
                    pass
        for f in filenames:
            fp = cur_p / f
            if not fp.is_symlink():
                try:
                    fp.chmod(0o600)
                except OSError:
                    pass
    shutil.rmtree(target)


def recycle_app(root: Path, m: Dict[str, Any]) -> Dict[str, Any]:
    ctrl = lock_wait(root / "CONTROL.lock")
    try:
        need(not (root / "STOPPING.json").exists(), "REMOTE_FENCED")
        if not (root / "APP-STARTING.json").exists() and not (root / "APP-RECYCLING.json").exists():
            return {
                "version": PROTOCOL_VERSION,
                **binding_fields(m),
                "kind": "app-recycled",
                "bootId": boot_id(),
                "appStopped": True,
                "noHostEffect": True,
                "scopes": [],
            }
        atomic_write(
            root / "APP-RECYCLING.json",
            {"version": PROTOCOL_VERSION, "bootId": boot_id(), **binding_fields(m)},
            mode=0o600,
        )
    finally:
        os.close(ctrl)

    stop_app_scope_only(root)
    deadline = time.monotonic() + 10.0
    proved_scope: Optional[Dict[str, Any]] = None
    while True:
        try:
            proved_scope = _prove_role_stopped(root, m, "app")
            _prove_tmux_stopped(root)
            wfd_probe = lock_nb(root / "APP-WRITER.lock")
            os.close(wfd_probe)
            break
        except Exception:  # noqa: BLE001
            if time.monotonic() >= deadline:
                raise ValueError("REMOTE_APP_RECYCLE_STOP_UNKNOWN") from None
            time.sleep(0.05)

    ctrl = lock_wait(root / "CONTROL.lock")
    try:
        wfd = lock_nb(root / "APP-WRITER.lock")
        try:
            need(not (root / "STOPPING.json").exists(), "REMOTE_FENCED")
            _clean_tree_rw(root / "run")
            for fname in ("APP-ADMITTED.json", "APP-SCOPE.json", "APP-STARTING.json", "APP-RECYCLING.json"):
                (root / fname).unlink(missing_ok=True)
            sync_dir(root)
        finally:
            os.close(wfd)
    finally:
        os.close(ctrl)

    return {
        "version": PROTOCOL_VERSION,
        **binding_fields(m),
        "kind": "app-recycled",
        "bootId": boot_id(),
        "appStopped": True,
        "scopes": [proved_scope] if proved_scope is not None else [],
    }


def reprovision_app(root: Path, m: Dict[str, Any]) -> None:
    ctrl = lock_wait(root / "CONTROL.lock")
    try:
        wfd = lock_nb(root / "APP-WRITER.lock")
        try:
            need(not (root / "STOPPING.json").exists(), "REMOTE_FENCED")
            need(
                (root / "PROVISIONED.json").exists()
                and not (root / "APP-STARTING.json").exists()
                and not (root / "APP-RECYCLING.json").exists(),
                "REMOTE_REPROVISION_INVALID_STATE",
            )
            line = sys.stdin.buffer.readline(8 * 1024 * 1024 + 1)
            need(len(line) <= 8 * 1024 * 1024 and line.endswith(b"\n"), "REMOTE_PROVISION_PACKET_OVERFLOW")
            packet = strict_json(line)
            need(
                isinstance(packet, dict)
                and {"manifest", "tools", "driverContext", "verifiedProbe"} <= set(packet.keys())
                and set(packet.keys()) <= {"manifest", "tools", "driverContext", "verifiedProbe", "registryPath"},
                "REMOTE_PROVISION_PACKET_INVALID",
            )
            pm = packet["manifest"]
            need(
                isinstance(pm, dict)
                and pm.get("root") == str(root)
                and binding_fields(pm) == binding_fields(m),
                "REMOTE_MANIFEST_INVALID",
            )
            existing_tools = strict_json(read_private(root / "tools.json"))
            need(
                remote_canonical_sha256(packet["tools"]) == remote_canonical_sha256(existing_tools),
                "REMOTE_CATALOG_DRIFT_ON_LANE",
            )
            reg_path = packet.get("registryPath")
            sandbox = str(root).startswith("/tmp/oc-drvtest-")
            if reg_path is not None:
                need(sandbox, "REMOTE_REGISTRY_OVERRIDE_FORBIDDEN")
            driver_mod, meta, actual_driver_digest = load_driver(
                m["driverId"],
                registry_path=reg_path if reg_path is not None else m.get("registryPath"),
                expected_digest=m["driverDigest"],
                allow_sandbox_override=sandbox,
            )
            need(
                meta["engineId"] == m["engineId"]
                and actual_driver_digest == m["driverDigest"]
                and compute_core_digest() == m["coreDigest"],
                "REMOTE_DRIVER_OR_CORE_DIGEST_MISMATCH",
            )
            raw_dctx = packet["driverContext"] if isinstance(packet["driverContext"], dict) else {}
            resolved_native_session = raw_dctx.get("nativeSessionId") or m.get("nativeSessionId")
            driver_ctx = {
                **raw_dctx,
                "root": str(root),
                "mcpClientPath": str((Path(__file__).resolve().parent / "mcp_client.py").resolve()),
                "operationId": m["operationId"],
                "runId": m["runId"],
                "generation": m["generation"],
                "profileId": m["profileId"],
                "authEpoch": m["authEpoch"],
                "model": m["model"],
                "nativeSessionId": resolved_native_session,
                "tools": packet["tools"],
            }
            spec = validate_launch_spec(driver_mod.launch_spec(driver_ctx, packet["verifiedProbe"]), root)
            for rel_dir in spec["dirs"]:
                target_dir = root / rel_dir
                target_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
                ensure_private_dir(target_dir)
            for rel_file, fspec in spec["files"].items():
                target_file = root / rel_file
                target_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                fbytes = (
                    base64.b64decode(fspec["contentB64"], validate=True)
                    if "contentB64" in fspec
                    else fspec["content"].encode("utf-8", errors="strict")
                )
                fmode = int(fspec.get("mode", 0o400))
                need(fmode in (0o400, 0o500, 0o600), "REMOTE_LAUNCH_FILE_MODE_INVALID")
                atomic_write(target_file, fbytes, mode=fmode)

            if isinstance(resolved_native_session, str) and resolved_native_session and resolved_native_session != "new":
                atomic_write(
                    root / "NATIVE-SESSION.json",
                    {"nativeSessionId": resolved_native_session},
                    mode=0o600,
                )
                cur_client = strict_json(read_private(root / "client.json"))
                if cur_client.get("nativeSessionId") != resolved_native_session:
                    cur_client["nativeSessionId"] = resolved_native_session
                    atomic_write(root / "client.json", cur_client, mode=0o400)

            atomic_write(root / "LAUNCH.json", spec, mode=0o400)
            atomic_write(
                root / "PROVISIONED.json",
                {
                    "version": PROTOCOL_VERSION,
                    **binding_fields(m),
                    "manifestSha256": sha(read_private(root / "MANIFEST.json")),
                    "launchSha256": sha(read_private(root / "LAUNCH.json")),
                },
                mode=0o400,
            )
            print(
                json.dumps(
                    {"version": PROTOCOL_VERSION, "kind": "reprovisioned", **binding_fields(m)},
                    separators=(",", ":"),
                ),
                flush=True,
            )
        finally:
            os.close(wfd)
    finally:
        os.close(ctrl)


def launch_role(root: Path, m: Dict[str, Any]) -> None:
    wfd = lock_nb(root / "APP-WRITER.lock")
    proc: Optional[subprocess.Popen[bytes]] = None
    seq = 0

    def emit(kind: str, **payload: Any) -> None:
        nonlocal seq
        seq += 1
        print(
            json.dumps(
                {"version": PROTOCOL_VERSION, **binding_fields(m), "kind": kind, "seq": seq, **payload},
                separators=(",", ":"),
            ),
            flush=True,
        )

    try:
        need(
            not (root / "STOPPING.json").exists() and not (root / "APP-STARTING.json").exists(),
            "REMOTE_LAUNCH_ALREADY_USED",
        )
        sandbox = str(root).startswith("/tmp/oc-drvtest-")
        driver_mod, _, _ = load_driver(
            m["driverId"],
            registry_path=m.get("registryPath"),
            expected_digest=m["driverDigest"],
            allow_sandbox_override=sandbox,
        )
        spec = verify_provisioned_spec(root, m)
        admitted = lane_admission(root, m)
        proc = start_scope_process(
            root,
            "app",
            m,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        emit(
            "ready",
            policySha256=spec["policySha256"],
            argvSha256=spec["argvSha256"],
            capDrift=bool(admitted.get("capDrift", False)),
        )

        native_state: Dict[str, Any] = {"expectedModel": m["model"], "operationId": m["operationId"]}
        if m.get("nativeSessionId"):
            native_state["sessionId"] = m["nativeSessionId"]
        elif (root / "NATIVE-SESSION.json").exists():
            hint = strict_json(read_private(root / "NATIVE-SESSION.json", 4096))
            if isinstance(hint, dict) and isinstance(hint.get("nativeSessionId"), str):
                native_state["sessionId"] = hint["nativeSessionId"]
        native_seq = 0

        sel = selectors.DefaultSelector()
        assert proc.stdout is not None and proc.stderr is not None and proc.stdin is not None
        sel.register(sys.stdin.buffer, selectors.EVENT_READ, "input")
        sel.register(proc.stdout, selectors.EVENT_READ, "stdout")
        sel.register(proc.stderr, selectors.EVENT_READ, "stderr")
        buffers: Dict[str, bytes] = {"input": b"", "stdout": b""}
        running = True
        try:
            while running:
                if (root / "STOPPING.json").exists() or (root / "APP-RECYCLING.json").exists():
                    break
                for key, _ in sel.select(0.5):
                    chan = key.data
                    data = os.read(key.fd, 65536)
                    if not data:
                        if chan == "stderr":
                            sel.unregister(key.fileobj)
                            continue
                        need(not buffers[chan], "REMOTE_TRUNCATED_FRAME")
                        running = False
                        break
                    if chan == "stderr":
                        emit("stderr", bytes=len(data), sha256=sha(data))
                        continue
                    buffers[chan] += data
                    need(len(buffers[chan]) <= MAX_LINE_BYTES, "REMOTE_FRAME_OVERFLOW")
                    while b"\n" in buffers[chan]:
                        raw_line, buffers[chan] = buffers[chan].split(b"\n", 1)
                        if not raw_line:
                            continue
                        if chan == "input":
                            msg = strict_json(raw_line)
                            need(
                                isinstance(msg, dict)
                                and msg.get("kind") == "command"
                                and isinstance(msg.get("command"), dict),
                                "REMOTE_STDIN_ENVELOPE_INVALID",
                            )
                            cmd_obj = msg["command"]
                            encoded = validate_encode_batch(
                                driver_mod.encode(cmd_obj, dict(native_state)),
                                cmd_obj,
                            )
                            native_state = encoded["nextNativeState"]
                            for out_line in encoded["lines"]:
                                proc.stdin.write(out_line.encode("utf-8", errors="strict") + b"\n")
                            if encoded["lines"]:
                                proc.stdin.flush()
                        else:
                            native_seq += 1
                            raw_with_nl = raw_line + b"\n"
                            decoded = validate_decode_batch(
                                driver_mod.decode("native", raw_with_nl, dict(native_state)),
                                channel="native",
                                raw_frame_bytes=raw_with_nl,
                                frame_seq=native_seq,
                            )
                            native_state = decoded["nextNativeState"]
                            sess_id = native_state.get("sessionId")
                            if isinstance(sess_id, str) and not (root / "NATIVE-SESSION.json").exists():
                                atomic_write(root / "NATIVE-SESSION.json", {"nativeSessionId": sess_id})

                            for ev in decoded["securityEvents"]:
                                if ev["kind"] == "disallowedItem":
                                    raise ValueError(f"REMOTE_DISALLOWED_ITEM:{ev['reason']}")
                                if ev["kind"] == "toolCallObserved" and ev["phase"] == "started":
                                    need(isinstance(sess_id, str), "REMOTE_TOOL_WITHOUT_SESSION")
                                    obs_doc: Dict[str, Any] = {
                                        "operationId": m["operationId"],
                                        "runId": m["runId"],
                                        "generation": m["generation"],
                                        "nativeSessionId": sess_id,
                                        "callId": ev["callId"],
                                        "name": ev["name"],
                                        "argsHash": ev["argsHash"],
                                    }
                                    if native_state.get("activeTurnId"):
                                        obs_doc["nativeTurnId"] = native_state["activeTurnId"]
                                    obs_file = root / "observations" / (sha(ev["callId"].encode("utf-8")) + ".json")
                                    if not obs_file.exists():
                                        record_exclusive(obs_file, obs_doc)

                            with open(root / "native.jsonl", "ab", buffering=0) as journal:
                                journal.write(raw_with_nl)
                                os.fsync(journal.fileno())
                            emit(
                                "stdout",
                                frameSeq=native_seq,
                                frameSha256=sha(raw_with_nl),
                                rawB64=base64.b64encode(raw_with_nl).decode("ascii"),
                            )
        finally:
            sel.close()
    except resources.MemoryExhausted as exc:
        emit("error", code=str(exc), activeSessions=exc.status["activeSessions"], admission=exc.status)
        raise
    except resources.ProfileCapacityExhausted as exc:
        emit("error", code=str(exc), cap=exc.cap, capDrift=exc.cap_drift)
        raise
    except Exception as exc:  # noqa: BLE001
        code = str(exc).split(":", 1)[0]
        emit("error", code=code if re.fullmatch(r"REMOTE_[A-Z0-9_]+", code) else "REMOTE_NODE_POLICY_REJECTED")
        raise
    finally:
        try:
            if (root / "APP-RECYCLING.json").exists() and not (root / "STOPPING.json").exists():
                stop_app_scope_only(root)
            else:
                stop_scopes(root, m)
            if proc is not None:
                proc.wait(timeout=10)
        finally:
            if proc is not None:
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    if stream is not None:
                        stream.close()
            os.close(wfd)


def _run_probe_step_cmd(
    cmd: List[str],
    *,
    cwd: Path,
    env: Dict[str, str],
    stdin_lines: List[str],
    timeout_sec: float,
    interactive_jsonrpc: bool,
) -> tuple[int, bytes]:
    if not interactive_jsonrpc:
        stdin_payload = "".join(line_s + "\n" for line_s in stdin_lines).encode("utf-8")
        completed = subprocess.run(
            cmd,
            cwd=cwd,
            env=env,
            input=stdin_payload,
            capture_output=True,
            timeout=timeout_sec,
        )
        return completed.returncode, completed.stdout

    deadline = time.monotonic() + timeout_sec
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0,
    )
    assert proc.stdin is not None and proc.stdout is not None
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    out_bytes = bytearray()
    line_buf = b""
    try:
        for line_s in stdin_lines:
            msg = strict_json(line_s)
            proc.stdin.write((line_s + "\n").encode("utf-8"))
            if isinstance(msg, dict) and "id" in msg:
                expected_id = msg["id"]
                matched = False
                while time.monotonic() < deadline:
                    while b"\n" in line_buf:
                        raw_ln, line_buf = line_buf.split(b"\n", 1)
                        if not raw_ln.strip():
                            continue
                        frame = strict_json(raw_ln)
                        if isinstance(frame, dict) and frame.get("id") == expected_id:
                            matched = True
                            break
                    if matched:
                        break
                    rem = max(0.0, deadline - time.monotonic())
                    if not sel.select(rem):
                        break
                    chunk = os.read(proc.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    out_bytes.extend(chunk)
                    line_buf += chunk
                    need(len(out_bytes) <= 8 * 1024 * 1024, "REMOTE_PROBE_OUTPUT_TOO_LARGE")
                need(matched, "REMOTE_PROBE_RPC_TIMEOUT_OR_EOF")
        try:
            proc.stdin.close()
        except OSError:
            pass
        drain_until = min(deadline, time.monotonic() + 2.0)
        while proc.poll() is None and time.monotonic() < drain_until:
            if sel.select(max(0.0, min(0.1, drain_until - time.monotonic()))):
                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk:
                    break
                out_bytes.extend(chunk)
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=1.0)
        return proc.returncode or 0, bytes(out_bytes)
    finally:
        sel.close()
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def probe_role(root: Path) -> None:
    line = sys.stdin.buffer.readline(262144 + 1)
    need(0 < len(line) <= 262144 and line.endswith(b"\n"), "REMOTE_PROBE_REQUEST_INVALID")
    req = strict_json(line)
    need(
        isinstance(req, dict)
        and isinstance(req.get("driverId"), str)
        and isinstance(req.get("profileId"), str)
        and PROFILE_ID_RE.fullmatch(req["profileId"]),
        "REMOTE_PROBE_REQUEST_INVALID",
    )
    reg_path = req.get("registryPath")
    sandbox = str(root).startswith("/tmp/oc-drvtest-")
    driver_mod, meta, driver_digest = load_driver(
        req["driverId"],
        registry_path=reg_path,
        allow_sandbox_override=sandbox,
    )
    core_digest = compute_core_digest()

    created_root = not root.exists()
    ensure_private_dir(root, create=created_root, mode=0o700)
    probe_cwd = root / "probe-cwd"
    probe_cwd.mkdir(mode=0o500, exist_ok=True)
    probe_tmp = root / "probe-tmp"
    probe_tmp.mkdir(mode=0o700, exist_ok=True)

    c = resources.config(meta["engineId"], registry_path=reg_path, allow_sandbox_override=sandbox)
    unit = f"oc-{meta['engineId']}-probe-{sha(str(root).encode())[:24]}.scope"
    claim_key = f"probe:{unit}"

    resources.admit(
        claim_key,
        meta["engineId"],
        req["profileId"],
        {unit: c["probe"]},
        kind="probe",
        registry_path=reg_path,
        allow_sandbox_override=sandbox,
    )
    try:
        ctx = {
            **(req.get("context") if isinstance(req.get("context"), dict) else {}),
            "probeRoot": str(root),
            "probeCwd": str(probe_cwd),
            "probeTmp": str(probe_tmp),
        }
        prev: Optional[Dict[str, Any]] = None
        for _step_idx in range(8):
            res = driver_mod.probe(ctx, prev)
            need(isinstance(res, dict) and res.get("kind") in ("step", "snapshot"), "REMOTE_PROBE_INVALID")
            if res["kind"] == "snapshot":
                snap = validate_model_snapshot(res)
                policy_sha = res.get("policySha256")
                need(
                    isinstance(policy_sha, str) and re.fullmatch(r"[a-f0-9]{64}", policy_sha) is not None,
                    "REMOTE_PROBE_MISSING_POLICY_SHA256",
                )
                fp = compute_probe_fingerprint(
                    snap,
                    driver_digest=driver_digest,
                    core_digest=core_digest,
                    policy_sha256=policy_sha,
                )
                print(
                    json.dumps(
                        {
                            "version": PROTOCOL_VERSION,
                            "kind": "probe-result",
                            "snapshot": snap,
                            "driverDigest": driver_digest,
                            "coreDigest": core_digest,
                            "probeFingerprint": fp,
                        },
                        separators=(",", ":"),
                    ),
                    flush=True,
                )
                return

            if "nextProbeState" in res:
                ctx = {**ctx, "_probeState": res["nextProbeState"]}
            step = res["step"]
            argv = step["argv"]
            need(isinstance(argv, list) and len(argv) >= 1 and Path(argv[0]).is_absolute(), "REMOTE_PROBE_ARGV_INVALID")
            env = {
                "HOME": str(Path.home()),
                "PATH": "/usr/bin:/bin:/usr/local/bin",
                "LANG": "C.UTF-8",
                "TMPDIR": str(probe_tmp),
                **(step.get("environment") or {}),
            }
            for env_k in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"):
                env_val = env.get(env_k)
                if isinstance(env_val, str) and env_val.startswith(str(probe_tmp)):
                    Path(env_val).mkdir(mode=0o700, parents=True, exist_ok=True)
            stdin_lines = [str(line_s) for line_s in (step.get("stdinLines") or [])]
            interactive_rpc = bool(step.get("interactiveJsonRpc"))
            timeout_sec = float(step.get("timeoutSec", 15))
            if resources._fake_systemd_dir() is None:
                cmd = [
                    "/usr/bin/systemd-run",
                    "--user",
                    "--scope",
                    "--quiet",
                    "--unit",
                    unit,
                    "-p",
                    "Slice=" + c["slice"],
                    "-p",
                    "MemoryMax=" + str(c["probe"]),
                    "-p",
                    "TasksMax=96",
                    "-p",
                    "KillMode=control-group",
                    "--",
                    "/usr/bin/env",
                    "-i",
                    *[f"{k}={v}" for k, v in env.items()],
                    *argv,
                ]
                step_rc, step_stdout = _run_probe_step_cmd(
                    cmd,
                    cwd=probe_cwd,
                    env={"PATH": "/usr/bin:/bin", "XDG_RUNTIME_DIR": "/run/user/" + str(os.getuid())},
                    stdin_lines=stdin_lines,
                    timeout_sec=timeout_sec,
                    interactive_jsonrpc=interactive_rpc,
                )
                resources.stop_unit(unit)
            else:
                step_rc, step_stdout = _run_probe_step_cmd(
                    argv,
                    cwd=probe_cwd,
                    env=env,
                    stdin_lines=stdin_lines,
                    timeout_sec=timeout_sec,
                    interactive_jsonrpc=interactive_rpc,
                )
                resources.stop_unit(unit)

            artifact_hashes: Dict[str, str] = {}
            for key_name, target_p in (step.get("hashFiles") or {}).items():
                artifact_hashes[key_name] = file_sha256(Path(target_p).resolve())
            prev = {
                "returncode": step_rc,
                "stdoutLines": step_stdout.decode("utf-8", errors="replace").splitlines(),
                "stdoutSha256": sha(step_stdout),
                "artifactHashes": artifact_hashes,
            }
        raise ValueError("REMOTE_PROBE_STEP_LIMIT_EXCEEDED")
    finally:
        resources.stop_unit(unit)
        resources.release(claim_key)
        if created_root and root.exists():
            try:
                probe_cwd.chmod(0o700)
            except OSError:
                pass
            shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    need(len(sys.argv) in (3, 4), "REMOTE_CONTROLLER_ARGS_INVALID")
    role = sys.argv[1]
    root = validate_task_root(sys.argv[2])

    if role == "provision":
        need(len(sys.argv) == 3, "REMOTE_CONTROLLER_ARGS_INVALID")
        provision(root)
        return 0

    if role == "probe":
        need(len(sys.argv) == 3, "REMOTE_CONTROLLER_ARGS_INVALID")
        probe_role(root)
        return 0

    if role == "preflight":
        need(len(sys.argv) == 3, "REMOTE_CONTROLLER_ARGS_INVALID")
        line = sys.stdin.buffer.readline(4096)
        req = strict_json(line) if line else {}
        engine_id = req.get("engineId") or read_manifest(root)["engineId"]
        sandbox = str(root).startswith("/tmp/oc-drvtest-")
        bypass_admit = req.get("testFaultBypassAdmit") is True
        if bypass_admit:
            need(sandbox, "REMOTE_FAULT_INJECTION_SANDBOX_ONLY")
        status = resources.preflight(
            engine_id,
            registry_path=req.get("registryPath"),
            allow_sandbox_override=sandbox,
            test_fault_bypass_admit=bypass_admit,
        )
        print(
            json.dumps({"version": PROTOCOL_VERSION, "engineId": engine_id, "kind": "preflight", **status}, separators=(",", ":")),
            flush=True,
        )
        return 0

    if role == "fence-stop":
        line = sys.stdin.buffer.readline(32769)
        need(len(line) <= 32768 and line.endswith(b"\n"), "REMOTE_FENCE_INPUT_INVALID")
        expected = strict_json(line)
        need(isinstance(expected, dict), "REMOTE_FENCE_INPUT_INVALID")
        fence_unprovisioned(root, expected)

    m = read_manifest(root)
    if role == "_worker":
        need(len(sys.argv) == 4, "REMOTE_CONTROLLER_ARGS_INVALID")
        return worker_entry(root, sys.argv[3])

    need(len(sys.argv) == 3, "REMOTE_CONTROLLER_ARGS_INVALID")
    if role == "recycle-app":
        result = recycle_app(root, m)
        print(json.dumps(result, separators=(",", ":")), flush=True)
        return 0

    if role == "reprovision-app":
        reprovision_app(root, m)
        return 0

    if role == "launch":
        launch_role(root, m)
        return 0

    if role == "tool-socket":
        wfd = lock_nb(root / "SOCKET-WRITER.lock")
        try:
            need(
                not (root / "STOPPING.json").exists() and not (root / "SOCKET-STARTING.json").exists(),
                "REMOTE_SOCKET_ALREADY_USED",
            )
            verify_provisioned_spec(root, m)
            lane_admission(root, m)
            p = start_scope_process(
                root,
                "socket",
                m,
                stdin=sys.stdin.buffer,
                stdout=sys.stdout.buffer,
                stderr=sys.stderr.buffer,
            )
            rc = p.wait()
            need(rc == 0, "REMOTE_SOCKET_EXIT_UNKNOWN")
            return 0
        finally:
            os.close(wfd)

    if role in ("stop", "fence-stop", "prove-stopped"):
        if role in ("stop", "fence-stop"):
            stop_scopes(root, m)
        deadline = time.monotonic() + 10.0
        while True:
            try:
                result = prove_stopped(root, m)
                break
            except Exception:  # noqa: BLE001
                if time.monotonic() >= deadline:
                    raise ValueError("REMOTE_STOP_UNKNOWN") from None
                time.sleep(0.1)
        resources.release(str(root))
        print(json.dumps(result, separators=(",", ":")), flush=True)
        return 0

    raise ValueError("REMOTE_CONTROLLER_ROLE_INVALID")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        sys.exit(main())
    except resources.MemoryExhausted as exc:
        print(
            json.dumps(
                {
                    "version": PROTOCOL_VERSION,
                    "kind": "error",
                    "code": str(exc),
                    "activeSessions": exc.status["activeSessions"],
                    "admission": exc.status,
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
        sys.stderr.write("REMOTE_NODE_REJECTED_OR_STOP_UNKNOWN\n")
        sys.exit(126)
    except Exception:  # noqa: BLE001
        sys.stderr.write("REMOTE_NODE_REJECTED_OR_STOP_UNKNOWN\n")
        sys.exit(126)
