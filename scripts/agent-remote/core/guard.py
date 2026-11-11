#!/usr/bin/env python3
"""Administrator-installed SSH forced-command guard (`remote-driver-v4`).

Config (`guard.json`, root-owned, mode 0644/0600, non-writable by group/other):
{
  "version": 4,
  "user": "<ssh_user>",
  "sourceIps": ["<master_ip>"],
  "sshPort": 22,
  "rootPrefix": "/home/<ssh_user>/oc-remotedrv-",
  "controllers": [{"path": "/opt/openclaude/remote-driver/<sha>/core/controller.py", "sha256": "<hex>"}]
}

New `provision`/`preflight`/`launch`/`tool-socket`/`probe` invocations must use `controllers[0]`.
`stop`/`fence-stop`/`prove-stopped` may also invoke older pinned entries in `controllers[1:]` so
in-flight generations can drain and stop safely across R1/R2 rollouts and rollbacks.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import stat
import sys
from typing import Any, Dict, List

ROLES = frozenset(
    {"provision", "preflight", "launch", "tool-socket", "stop", "fence-stop", "prove-stopped", "probe"}
)
DRAIN_ROLES = frozenset({"stop", "fence-stop", "prove-stopped"})


def require(value: Any) -> None:
    if not value:
        raise ValueError("REMOTE_SSH_COMMAND_REJECTED")


def quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def verified_argv(original: Any, config: Dict[str, Any]) -> List[str]:
    require(
        isinstance(original, str)
        and 0 < len(original) <= 4096
        and not any(ch in original for ch in ("\x00", "\r", "\n"))
    )
    args = shlex.split(original)
    require(len(args) == 6 and args[:3] == ["/usr/bin/python3", "-I", "-B"] and args[4] in ROLES)
    require(original == " ".join(quote(x) for x in args))
    require(re.fullmatch(re.escape(config["rootPrefix"]) + r"[a-z0-9-]{16,72}", args[5]))

    allowed = config["controllers"] if args[4] in DRAIN_ROLES else config["controllers"][:1]
    entry = next((x for x in allowed if x["path"] == args[3]), None)
    require(entry is not None)

    path = Path(args[3])
    require(path.resolve() == path)
    for parent in path.parents:
        st = parent.lstat()
        require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not (st.st_mode & 0o022))

    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        require(
            st.st_uid == 0
            and stat.S_ISREG(st.st_mode)
            and not (st.st_mode & 0o022)
            and st.st_nlink == 1
            and st.st_size <= 262144
        )
        require(hashlib.sha256(os.read(fd, 262145)).hexdigest() == entry["sha256"])
    finally:
        os.close(fd)
    return args


def main() -> None:
    require(len(sys.argv) == 1 and not any(os.isatty(x) for x in (0, 1, 2)))
    path = Path(__file__).resolve().with_suffix(".json")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        require(st.st_uid == 0 and stat.S_ISREG(st.st_mode) and not (st.st_mode & 0o022) and st.st_size <= 16384)
        config = json.loads(os.read(fd, 16385))
    finally:
        os.close(fd)

    require(
        set(config.keys()) == {"version", "user", "sourceIps", "sshPort", "rootPrefix", "controllers"}
        and config["version"] == 4
    )
    user = pwd.getpwuid(os.getuid())
    require(os.getuid() != 0 and os.geteuid() == os.getuid() and user.pw_name == config["user"])
    require(config["rootPrefix"] == user.pw_dir + "/oc-remotedrv-")
    require(isinstance(config["controllers"], list) and 1 <= len(config["controllers"]) <= 8)
    for item in config["controllers"]:
        require(set(item.keys()) == {"path", "sha256"} and re.fullmatch(r"[0-9a-f]{64}", item["sha256"]))
    require(not any(os.environ.get(x) for x in ("SSH_TTY", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "DISPLAY")))
    conn = os.environ.get("SSH_CONNECTION", "").split()
    require(len(conn) == 4 and conn[0] in config["sourceIps"] and conn[3] == str(config["sshPort"]))
    args = verified_argv(os.environ.get("SSH_ORIGINAL_COMMAND"), config)
    os.execve(
        args[0],
        args,
        {
            "HOME": user.pw_dir,
            "USER": user.pw_name,
            "LOGNAME": user.pw_name,
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "XDG_RUNTIME_DIR": "/run/user/" + str(os.getuid()),
        },
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError):
        sys.stderr.write("REMOTE_SSH_COMMAND_REJECTED\n")
        sys.exit(126)
