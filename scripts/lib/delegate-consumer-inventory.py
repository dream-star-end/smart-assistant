#!/usr/bin/env python3
"""Trusted local Docker inventory for the delegate transition caller.

No SQLite writes, stop/start operations or authorization decisions. The caller
must supply all parsed current/candidate/fallback master paths and establish the
real writer/provision barrier. Equal snapshots do NOT replace that barrier.
This module has no environment/CLI bypass for external inventory or commands.
"""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

MAX_ITEMS = 4096
MAX_BYTES = 32 * 1024 * 1024
DATA_NAME = re.compile(r"oc-v5-data-u([1-9][0-9]*)\Z")
CONTAINER_NAME = re.compile(r"/?oc-v5-u([1-9][0-9]*)\Z")
CHANNEL = "com.openclaude.runtime_channel"
MANAGED = "com.openclaude.v3.managed"
UID = "com.openclaude.v3.uid"
DATA_TARGET = "/home/agent/.openclaude"


class Unknown(Exception):
    """Never attach raw Docker/env output, paths or secrets to public errors."""


def require(value):
    if not value:
        raise Unknown("unverifiable_inventory")


def absolute(value):
    require(isinstance(value, str) and value and "\x00" not in value)
    path = Path(value)
    require(path.is_absolute() and ".." not in path.parts and str(path) == value)
    return path


def identity(value, *, directory=False, missing=False):
    """Bind every ancestor; never normalize through a symlink."""
    path = absolute(value)
    require(path != Path("/"))
    current = Path("/")
    chain = []
    for index, part in enumerate(path.parts[1:]):
        current /= part
        last = index == len(path.parts) - 2
        try:
            info = current.lstat()
        except FileNotFoundError:
            require(last and missing and not directory)
            return {"path": value, "chain": chain, "absent": True}
        require(stat.S_ISDIR(info.st_mode) if not last or directory else stat.S_ISREG(info.st_mode))
        chain.append([info.st_dev, info.st_ino])
    return {"path": value, "chain": chain, "absent": False}


def revalidate(proof):
    for anchor in proof["roots"]:
        require(identity(anchor["path"], directory=True) == anchor)
    for anchor in proof["databases"]:
        require(identity(anchor["path"], missing=anchor["absent"]) == anchor)


def path_environment(values):
    require(isinstance(values, list) and len(values) <= MAX_ITEMS)
    result = {}
    wanted = {"HOME", "OPENCLAUDE_HOME", "OPENCLAUDE_DELEGATE_JOBS_DB"}
    for entry in values:
        require(isinstance(entry, str) and "=" in entry)
        name, value = entry.split("=", 1)
        if name in wanted:
            require(name not in result)  # Ambiguous duplicate env keys are not defaults.
            result[name] = value
    return result


def collect(volumes, containers, master_databases):
    """Internal structured adapter; production capture_local supplies Docker facts.

    master_databases is mandatory and intentionally not inferred from this
    process's HOME. Its caller must parse the actual unit/env authority first.
    """
    require(isinstance(volumes, list) and len(volumes) <= MAX_ITEMS)
    require(isinstance(containers, list) and len(containers) <= MAX_ITEMS)
    require(isinstance(master_databases, list) and 0 < len(master_databases) <= MAX_ITEMS)
    by_name, roots, databases, writers = {}, {}, {}, []
    seen_names = set()
    for volume in volumes:
        require(isinstance(volume, dict) and isinstance(volume.get("Name"), str))
        name = volume["Name"]
        require(name not in seen_names)
        seen_names.add(name)
        match = DATA_NAME.fullmatch(name)
        if not match:
            continue
        require(volume.get("Driver") == "local" and volume.get("Scope") == "local")
        # Docker local-driver mount options may mount remote/NFS or arbitrary data.
        require(volume.get("Options") in (None, {}))
        root = identity(volume.get("Mountpoint"), directory=True)
        require(root["path"] not in roots)  # Distinct named volumes cannot alias one root.
        roots[root["path"]] = root
        by_name[name] = root
        path = str(Path(root["path"]) / "delegate-jobs.db")
        databases[path] = identity(path, missing=True)

    seen_ids = set()
    for container in containers:
        require(isinstance(container, dict))
        config = container.get("Config") or {}
        labels = config.get("Labels") or {}
        mounts = container.get("Mounts") or []
        require(isinstance(labels, dict) and isinstance(mounts, list))
        name = container.get("Name", "")
        match = CONTAINER_NAME.fullmatch(name) if isinstance(name, str) else None
        touches_data = any(isinstance(m, dict) and m.get("Name") in by_name for m in mounts)
        if not (match or labels.get(CHANNEL) == "v5" or touches_data):
            continue
        require(match and labels.get(CHANNEL) == "v5" and labels.get(MANAGED) == "1")
        uid = match.group(1)
        require(labels.get(UID) == uid)
        cid = container.get("Id")
        require(isinstance(cid, str) and re.fullmatch(r"[a-f0-9]{64}", cid) and cid not in seen_ids)
        seen_ids.add(cid)
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", container.get("Image", "")))
        require(config.get("User") == "1000:1000")
        require(container.get("HostConfig", {}).get("RestartPolicy", {}).get("Name") == "no")
        data = [m for m in mounts if isinstance(m, dict) and m.get("Destination") == DATA_TARGET]
        require(len(data) == 1)
        mount = data[0]
        volume_name = "oc-v5-data-u" + uid
        require(volume_name in by_name)
        root = by_name[volume_name]
        require(mount.get("Type") == "volume" and mount.get("Name") == volume_name)
        require(mount.get("Source") == root["path"] and mount.get("RW") is True)
        env = path_environment(config.get("Env"))
        home = env.get("OPENCLAUDE_HOME", "").strip()
        if not home:
            require(env.get("HOME", "/home/agent") == "/home/agent")
            home = DATA_TARGET  # Exact original sandbox uid/home contract, not host HOME.
        db = env.get("OPENCLAUDE_DELEGATE_JOBS_DB", "").strip() or str(absolute(home) / "delegate-jobs.db")
        requested = absolute(db)
        # Only this proven data mount is supported. Another persistent override
        # is UNKNOWN, never omitted or mapped through an arbitrary bind.
        require(requested.is_relative_to(DATA_TARGET) and requested != Path(DATA_TARGET))
        for other in mounts:
            require(isinstance(other, dict))
            destination = absolute(other.get("Destination"))
            if other is not mount and requested.is_relative_to(destination):
                require(len(destination.parts) < len(Path(DATA_TARGET).parts))
        path = str(Path(root["path"]) / requested.relative_to(DATA_TARGET))
        databases[path] = identity(path, missing=True)
        state = container.get("State") or {}
        require(state.get("Status") in {"created", "running", "paused", "restarting", "removing", "exited", "dead"})
        require(isinstance(state.get("Pid"), int) and state["Pid"] >= 0)
        require(isinstance(state.get("StartedAt"), str))
        writers.append({"id": cid, "image": container["Image"], "state": state["Status"],
                        "pid": state["Pid"], "startedAt": state["StartedAt"], "volume": volume_name})

    for path in master_databases:
        databases[path] = identity(path, missing=True)
    require(len(databases) <= MAX_ITEMS)
    proof = {"schema": 1, "roots": sorted(roots.values(), key=lambda a: a["path"]),
             "databases": sorted(databases.values(), key=lambda a: a["path"]),
             "writers": sorted(writers, key=lambda a: a["id"])}
    revalidate(proof)
    return proof


def capture_local(master_databases, deadline):
    """Root-only bounded Docker reads. Not a whole-topology or quiescence proof."""
    require(os.geteuid() == 0)
    require(0 < deadline - time.monotonic() <= 30)

    def docker(args, as_json=False):
        remaining = deadline - time.monotonic()
        require(remaining > 0)
        try:
            result = subprocess.run(["/usr/bin/docker", "--host=unix:///var/run/docker.sock", *args],
                                    env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/"},
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    timeout=remaining, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Unknown("docker_unavailable") from None
        require(result.returncode == 0 and len(result.stdout) <= MAX_BYTES)
        try:
            return json.loads(result.stdout) if as_json else result.stdout.decode().splitlines()
        except (ValueError, UnicodeError):
            raise Unknown("invalid_docker_output") from None

    names = docker(["volume", "ls", "--quiet"])
    ids = docker(["container", "ls", "--all", "--quiet", "--no-trunc"])
    require(len(names) <= MAX_ITEMS and len(ids) <= MAX_ITEMS)
    require(len(names) == len(set(names)) and len(ids) == len(set(ids)))
    require(all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", n) for n in names))
    require(all(re.fullmatch(r"[a-f0-9]{64}", c) for c in ids))
    volumes = docker(["volume", "inspect", *names], True) if names else []
    containers = docker(["container", "inspect", *ids], True) if ids else []
    require(len(volumes) == len(names) and {v.get("Name") for v in volumes} == set(names))
    require(len(containers) == len(ids) and {c.get("Id") for c in containers} == set(ids))
    proof = collect(volumes, containers, master_databases)
    require(set(docker(["volume", "ls", "--quiet"])) == set(names))
    require(set(docker(["container", "ls", "--all", "--quiet", "--no-trunc"])) == set(ids))
    require(time.monotonic() < deadline)
    revalidate(proof)
    return proof
