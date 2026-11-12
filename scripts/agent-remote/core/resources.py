#!/usr/bin/env python3
"""Registry-driven node resource & memory admission (`remote-driver-v4`).

Generalized from `remote-engine-resources.py`:
- Zero hardcoded engine names: slice & memory defaults come from `drivers/registry.json`.
- Pool key is `(node, engineId, profileId)` using master's stable `profileId` (default cap 5).
- When master passes `master_max_lanes` and it differs from node config, enforces `min(node, master)`
  and reports `capDrift=True`.
- Supports isolated `/tmp` test systemd simulation (`OC_REMOTE_TEST_FAKE_SYSTEMD_DIR`) ONLY in non-root
  `/tmp` resource roots for hermetic conformance red/green verification; production uses real `systemctl --user`.
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from typing import Any, Dict, Iterator, List, Optional

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from core.contract import load_registry  # noqa: E402

MIB = 1024 * 1024
MEMORY_ERROR = "REMOTE_NODE_MEMORY_EXHAUSTED"
CAPACITY_ERROR = "REMOTE_NODE_PROFILE_CAPACITY_EXHAUSTED"


class MemoryExhausted(RuntimeError):
    def __init__(self, status: Dict[str, Any]) -> None:
        super().__init__(status["code"])
        self.status = status


class ProfileCapacityExhausted(RuntimeError):
    def __init__(self, engine: str, profile: str, cap: int, cap_drift: bool = False) -> None:
        super().__init__(CAPACITY_ERROR)
        self.engine = engine
        self.profile = profile
        self.cap = cap
        self.cap_drift = cap_drift


def need(ok: Any, code: str = "REMOTE_RESOURCE_STATE_UNKNOWN") -> None:
    if not ok:
        raise RuntimeError(code)


def settings() -> Dict[str, Any]:
    path = Path("/etc/openclaude/remote-engine-resources.json")
    if not path.exists():
        return {}
    st = path.lstat()
    need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1 and not (st.st_mode & 0o022))
    return json.loads(path.read_text())


def option(name: str, default: Any) -> Any:
    return os.environ.get("OC_REMOTE_" + name, settings().get(name, default))


def _sandbox_allowed() -> bool:
    raw_root = str(option("RESOURCE_ROOT", str(Path.home() / ".oc-remote-resources")))
    return raw_root.startswith("/tmp/oc-drvtest-")


def engine_meta(
    engine: str,
    registry_path: Optional[str] = None,
    *,
    allow_sandbox_override: Optional[bool] = None,
) -> Dict[str, Any]:
    allow = _sandbox_allowed() if allow_sandbox_override is None else allow_sandbox_override
    reg = load_registry(registry_path, allow_sandbox_override=allow)
    for entry in reg.values():
        if entry["engineId"] == engine:
            return entry
    raise RuntimeError("REMOTE_ENGINE_NOT_REGISTERED")


def config(
    engine: str,
    registry_path: Optional[str] = None,
    *,
    allow_sandbox_override: Optional[bool] = None,
) -> Dict[str, Any]:
    meta = engine_meta(engine, registry_path=registry_path, allow_sandbox_override=allow_sandbox_override)
    prefix = engine.upper().replace("-", "_") + "_"
    values = {
        "slice": str(option(prefix + "SLICE", meta["slice"])),
        "max": int(option(prefix + "MEMORY_MAX", meta["sliceMemoryMiB"] * MIB)),
        "tasks": int(option(prefix + "TASKS_MAX", meta["sliceTasksMax"])),
        "app": int(option(prefix + "APP_MEMORY", meta["appMemoryMiB"] * MIB)),
        "socket": int(option(prefix + "SOCKET_MEMORY", meta["socketMemoryMiB"] * MIB)),
        "probe": int(option(prefix + "PROBE_MEMORY", meta["probeMemoryMiB"] * MIB)),
        "headroom": int(option("HEADROOM", meta["headroomMiB"] * MIB)),
        "profileMaxLanes": int(option(prefix + "PROFILE_MAX_LANES", meta["profileMaxLanes"])),
    }
    need(
        re.fullmatch(r"oc-[a-z0-9_-]+\.slice", values["slice"])
        and all(v > 0 for k, v in values.items() if k != "slice")
    )
    return values


def directory() -> Path:
    p = Path(str(option("RESOURCE_ROOT", str(Path.home() / ".oc-remote-resources"))))
    p.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = p.lstat()
    need(
        stat.S_ISDIR(st.st_mode)
        and st.st_uid == os.getuid()
        and not (st.st_mode & 0o077)
        and p.resolve() == p.absolute()
    )
    return p


def _fake_systemd_dir() -> Optional[Path]:
    raw = os.environ.get("OC_REMOTE_TEST_FAKE_SYSTEMD_DIR")
    if not raw:
        return None
    res_root = str(directory())
    # Strict safety boundary: fake systemd is ONLY honored inside isolated `/tmp/oc-drvtest-*` (or non-root `/tmp/`) test sandboxes.
    need(
        res_root.startswith("/tmp/oc-drvtest-") or (os.getuid() != 0 and res_root.startswith("/tmp/")),
        "REMOTE_FAKE_SYSTEMD_FORBIDDEN",
    )
    d = Path(raw).resolve()
    d.mkdir(mode=0o700, parents=True, exist_ok=True)
    return d


def atomic(path: Path, value: str) -> None:
    fd, tmp = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "w") as out:
            out.write(value)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _run_host(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        env={
            "PATH": "/usr/bin:/bin",
            "HOME": str(Path.home()),
            "XDG_RUNTIME_DIR": "/run/user/" + str(os.getuid()),
        },
        text=True,
        capture_output=True,
        timeout=10,
    )


def systemctl(*args: str) -> subprocess.CompletedProcess[str]:
    return _run_host("/usr/bin/systemctl", "--user", *args)


def state(unit: str) -> Dict[str, str]:
    fake = _fake_systemd_dir()
    if fake is not None:
        unit_file = fake / (unit + ".json")
        if not unit_file.exists():
            return {
                "LoadState": "not-found",
                "ActiveState": "inactive",
                "FragmentPath": "",
                "ControlGroup": "",
                "MemoryMax": "infinity",
                "MemoryCurrent": "0",
                "TasksMax": "infinity",
            }
        return json.loads(unit_file.read_text())
    r = systemctl(
        "show",
        unit,
        "--property=LoadState,ActiveState,FragmentPath,ControlGroup,MemoryMax,MemoryCurrent,TasksMax",
    )
    need(r.returncode == 0)
    return dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)


@contextlib.contextmanager
def locked() -> Iterator[None]:
    fd = os.open(directory() / "admission.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        st = os.fstat(fd)
        need(
            stat.S_ISREG(st.st_mode)
            and st.st_uid == os.getuid()
            and st.st_nlink == 1
            and not (st.st_mode & 0o077)
        )
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def boot() -> str:
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def record_path(key: str) -> Path:
    return directory() / (hashlib.sha256(key.encode()).hexdigest() + ".json")


def records() -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for p in directory().glob("*.json"):
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            st = os.fstat(fd)
            need(
                stat.S_ISREG(st.st_mode)
                and st.st_uid == os.getuid()
                and st.st_nlink == 1
                and not (st.st_mode & 0o077)
                and 0 < st.st_size < 16384
            )
            r = json.loads(os.read(fd, 16384))
        finally:
            os.close(fd)
        need(r.get("version") in (1, 4) and isinstance(r.get("scopes"), dict))
        if r["boot"] == boot():
            rows.append(r)
    return rows


def ensure_slice(
    engine: str,
    registry_path: Optional[str] = None,
    *,
    allow_sandbox_override: Optional[bool] = None,
) -> Dict[str, Any]:
    c = config(engine, registry_path=registry_path, allow_sandbox_override=allow_sandbox_override)
    fake = _fake_systemd_dir()
    if fake is not None:
        unit_file = fake / (c["slice"] + ".json")
        if unit_file.exists():
            cur = json.loads(unit_file.read_text())
            need(cur.get("MemoryMax") == str(c["max"]) and cur.get("TasksMax") == str(c["tasks"]))
        else:
            atomic(
                unit_file,
                json.dumps(
                    {
                        "LoadState": "loaded",
                        "ActiveState": "active",
                        "FragmentPath": str(unit_file),
                        "ControlGroup": "/user.slice/" + c["slice"],
                        "MemoryMax": str(c["max"]),
                        "MemoryCurrent": "0",
                        "TasksMax": str(c["tasks"]),
                    }
                ),
            )
        return c

    current = state(c["slice"])
    if current.get("LoadState") == "loaded" and (
        current.get("ActiveState") == "active" or current.get("FragmentPath")
    ):
        need(current.get("MemoryMax") == str(c["max"]) and current.get("TasksMax") == str(c["tasks"]))
    else:
        path = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "systemd/user" / c["slice"]
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        need(not path.exists() and not path.is_symlink())
        atomic(
            path,
            "[Unit]\nDescription=OpenClaude remote "
            + engine
            + "\n[Slice]\nMemoryMax="
            + str(c["max"])
            + "\nTasksMax="
            + str(c["tasks"])
            + "\n",
        )
        need(systemctl("daemon-reload").returncode == 0)
    need(systemctl("start", c["slice"]).returncode == 0)
    current = state(c["slice"])
    need(
        current.get("ActiveState") == "active"
        and current.get("MemoryMax") == str(c["max"])
        and current.get("TasksMax") == str(c["tasks"])
    )
    return c


def available() -> int:
    fake = _fake_systemd_dir()
    if fake is not None and os.environ.get("OC_REMOTE_TEST_MEM_AVAILABLE_BYTES"):
        return int(os.environ["OC_REMOTE_TEST_MEM_AVAILABLE_BYTES"])
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("REMOTE_RESOURCE_STATE_UNKNOWN")


def memory_used(unit: str) -> int:
    s = state(unit)
    if s.get("ActiveState") in ("inactive", "failed") and not s.get("ControlGroup"):
        return 0
    need(s.get("MemoryCurrent", "").isdigit())
    return int(s["MemoryCurrent"])


def snapshot(
    engine: str,
    scopes: Dict[str, int],
    rows: List[Dict[str, Any]],
    registry_path: Optional[str] = None,
    *,
    master_max_memory_bytes: Optional[int] = None,
    allow_sandbox_override: Optional[bool] = None,
) -> Dict[str, Any]:
    c = config(engine, registry_path=registry_path, allow_sandbox_override=allow_sandbox_override)
    effective_slice_max = c["max"]
    if master_max_memory_bytes is not None:
        need(type(master_max_memory_bytes) is int and master_max_memory_bytes > 0)
        effective_slice_max = min(c["max"], master_max_memory_bytes)
    budget = sum(scopes.values())
    total = next(
        int(line.split()[1]) * 1024
        for line in Path("/proc/meminfo").read_text().splitlines()
        if line.startswith("MemTotal:")
    )
    node_budget = min(int(option("NODE_MEMORY_BUDGET", max(0, total - 768 * MIB))), total)
    node_committed = sum(sum(r["scopes"].values()) for r in rows)
    engine_rows = [r for r in rows if r["engine"] == engine]
    engine_committed = sum(sum(r["scopes"].values()) for r in engine_rows)
    engine_tasks = sum(len(r["scopes"]) * 128 for r in engine_rows)
    current = memory_used(c["slice"])
    free = available()
    ok = (
        node_committed + budget + c["headroom"] <= node_budget
        and engine_committed + budget + c["headroom"] <= effective_slice_max
        and current + budget + c["headroom"] <= effective_slice_max
        and free >= budget + c["headroom"]
    )
    tasks_ok = engine_tasks + len(scopes) * 128 <= c["tasks"]
    code = MEMORY_ERROR if not ok else ("REMOTE_NODE_TASKS_EXHAUSTED" if not tasks_ok else None)
    return {
        "memoryOk": ok and tasks_ok,
        "code": code,
        "activeSessions": sum(r["kind"] == "lane" for r in engine_rows),
        "nodeBudgetBytes": node_budget,
        "sliceMaxBytes": effective_slice_max,
        "committedBytes": node_committed,
        "newBudgetBytes": budget,
        "memAvailableBytes": free,
        "sliceMemoryCurrent": current,
    }


def admit(
    key: str,
    engine: str,
    profile: str,
    scopes: Dict[str, int],
    *,
    kind: str = "lane",
    master_max_lanes: Optional[int] = None,
    master_max_memory_bytes: Optional[int] = None,
    registry_path: Optional[str] = None,
    allow_sandbox_override: Optional[bool] = None,
    test_fault_bypass_admit: bool = False,
) -> Dict[str, Any]:
    if test_fault_bypass_admit:
        need(
            allow_sandbox_override is True and str(key).startswith("/tmp/oc-drvtest-"),
            "REMOTE_FAULT_INJECTION_SANDBOX_ONLY",
        )
    need(
        scopes
        and isinstance(profile, str)
        and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", profile)
        and all(
            re.fullmatch(r"oc-[a-z0-9_-]+\.scope", u) and type(b) is int and b > 0
            for u, b in scopes.items()
        )
    )
    with locked():
        c = ensure_slice(engine, registry_path=registry_path, allow_sandbox_override=allow_sandbox_override)
        rows = records()
        existing = next((r for r in rows if r["key"] == key), None)
        if existing:
            need(
                existing["engine"] == engine
                and existing["profile"] == profile
                and existing["scopes"] == scopes
            )
            return existing

        cap_drift = False
        if kind == "lane":
            node_cap = c["profileMaxLanes"]
            if master_max_lanes is not None:
                need(type(master_max_lanes) is int and master_max_lanes > 0)
                cap_drift = master_max_lanes != node_cap
                effective_cap = min(node_cap, master_max_lanes)
            else:
                effective_cap = node_cap
            active_in_pool = sum(
                r["kind"] == "lane" and r["engine"] == engine and r["profile"] == profile
                for r in rows
            )
            if active_in_pool >= effective_cap and not test_fault_bypass_admit:
                raise ProfileCapacityExhausted(engine, profile, effective_cap, cap_drift=cap_drift)

        status = snapshot(
            engine,
            scopes,
            rows,
            registry_path=registry_path,
            master_max_memory_bytes=master_max_memory_bytes,
            allow_sandbox_override=allow_sandbox_override,
        )
        if not status["memoryOk"] and not test_fault_bypass_admit:
            raise MemoryExhausted(status)
        row = {
            "version": 4,
            "key": key,
            "engine": engine,
            "profile": profile,
            "kind": kind,
            "scopes": scopes,
            "capDrift": cap_drift,
            "boot": boot(),
        }
        atomic(record_path(key), json.dumps(row, sort_keys=True))
        return row


def preflight(
    engine: str,
    registry_path: Optional[str] = None,
    *,
    allow_sandbox_override: Optional[bool] = None,
    test_fault_bypass_admit: bool = False,
) -> Dict[str, Any]:
    with locked():
        c = ensure_slice(engine, registry_path=registry_path, allow_sandbox_override=allow_sandbox_override)
        snap = snapshot(
            engine,
            {"preview-app": c["app"], "preview-socket": c["socket"]},
            records(),
            registry_path=registry_path,
            allow_sandbox_override=allow_sandbox_override,
        )
        if test_fault_bypass_admit:
            need(bool(allow_sandbox_override), "REMOTE_FAULT_INJECTION_SANDBOX_ONLY")
            snap = {**snap, "memoryOk": True, "code": None}
        return snap


def release(key: str) -> None:
    """Caller must fence late launches and prove stop first; active scopes retain the claim."""
    with locked():
        row = next((r for r in records() if r["key"] == key), None)
        if not row:
            return
        for unit in row["scopes"]:
            s = state(unit)
            need(s.get("ActiveState") in ("inactive", "failed") and not s.get("ControlGroup"))
        record_path(key).unlink()
        fd = os.open(directory(), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def stop_unit(unit: str) -> None:
    fake = _fake_systemd_dir()
    if fake is not None:
        unit_file = fake / (unit + ".json")
        if unit_file.exists():
            cur = json.loads(unit_file.read_text())
            pid = cur.get("MainPID")
            if isinstance(pid, int) and pid > 1:
                try:
                    os.killpg(pid, 9)
                except OSError:
                    pass
                try:
                    os.kill(pid, 9)
                except OSError:
                    pass
            cgroup_dir = cur.get("FakeCgroupDir")
            if isinstance(cgroup_dir, str) and Path(cgroup_dir).exists():
                (Path(cgroup_dir) / "cgroup.procs").write_text("")
                (Path(cgroup_dir) / "cgroup.events").write_text("populated 0\nfrozen 0\n")
            atomic(
                unit_file,
                json.dumps(
                    {
                        "LoadState": "not-found",
                        "ActiveState": "inactive",
                        "FragmentPath": "",
                        "ControlGroup": "",
                        "MemoryMax": cur.get("MemoryMax", "0"),
                        "MemoryCurrent": "0",
                        "TasksMax": "128",
                    }
                ),
            )
        return
    systemctl("kill", "--signal=KILL", "--kill-whom=all", unit)
    systemctl("stop", unit)
    st = state(unit)
    need(st.get("ActiveState") in ("inactive", "failed") and not st.get("ControlGroup"), "REMOTE_SCOPE_STOP_UNKNOWN")
    systemctl("reset-failed", unit)


def register_fake_scope(unit: str, slice_name: str, memory_max: int, pid: int, cgroup_dir: Path) -> None:
    fake = _fake_systemd_dir()
    need(fake is not None, "REMOTE_FAKE_SYSTEMD_DISABLED")
    cgroup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    (cgroup_dir / "cgroup.procs").write_text(f"{pid}\n")
    (cgroup_dir / "cgroup.events").write_text("populated 1\nfrozen 0\n")
    atomic(
        fake / (unit + ".json"),
        json.dumps(
            {
                "LoadState": "loaded",
                "ActiveState": "active",
                "SubState": "running",
                "FragmentPath": "",
                "ControlGroup": f"/user.slice/{slice_name}/{unit}",
                "FakeCgroupDir": str(cgroup_dir),
                "MainPID": pid,
                "MemoryMax": str(memory_max),
                "MemoryCurrent": str(min(memory_max, 16 * MIB)),
                "TasksMax": "128",
            }
        ),
    )
