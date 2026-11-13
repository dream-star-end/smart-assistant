#!/usr/bin/env python3
"""Content-addressed `remote-driver-v4` node bundle installer (`OCV5-749`).

Installs `/opt/openclaude/remote-driver/<controllerSha256>/{core,drivers}` additively alongside
any existing v1/v3 bundles (`cc5-interactive-v1`, `codex-app-server-v1`) without modifying
existing bundles, active `/home/box/.oc-remote-resources` records, or existing
`/home/box/.ssh/authorized_keys` entries.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
from typing import Any, Dict, List

AGENT_REMOTE_DIR = Path(__file__).resolve().parent
if str(AGENT_REMOTE_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_REMOTE_DIR))

from core.contract import compute_core_digest, file_sha256, load_registry  # noqa: E402

KEY_COMMENT = "oc-rpool-v4"
PRODUCTION_DRIVERS = ("cc", "codex")


def build_bundle_payload(ssh_user: str, source_ips: List[str], ssh_port: int) -> Dict[str, Any]:
    core_dir = AGENT_REMOTE_DIR / "core"
    drivers_dir = AGENT_REMOTE_DIR / "drivers"
    controller_path = core_dir / "controller.py"
    controller_sha = file_sha256(controller_path)
    core_digest = compute_core_digest(core_dir)

    reg_raw = json.loads((drivers_dir / "registry.json").read_text(encoding="utf-8"))
    prod_drivers = {
        k: v for k, v in (reg_raw.get("drivers") or {}).items() if k in PRODUCTION_DRIVERS
    }
    if set(prod_drivers.keys()) != set(PRODUCTION_DRIVERS):
        raise RuntimeError(f"Missing production drivers in registry.json: {list(prod_drivers.keys())}")
    prod_registry_bytes = (
        json.dumps({"version": 4, "drivers": prod_drivers}, indent=2) + "\n"
    ).encode("utf-8")

    files_b64: Dict[str, Dict[str, Any]] = {}
    for py_file in sorted(core_dir.glob("*.py")):
        if py_file.is_file() and not py_file.is_symlink():
            files_b64[f"core/{py_file.name}"] = {
                "b64": base64.b64encode(py_file.read_bytes()).decode("ascii"),
                "mode": 0o755,
            }
    for drv_name in PRODUCTION_DRIVERS:
        drv_file = drivers_dir / f"{drv_name}.py"
        files_b64[f"drivers/{drv_file.name}"] = {
            "b64": base64.b64encode(drv_file.read_bytes()).decode("ascii"),
            "mode": 0o755,
        }
    files_b64["drivers/registry.json"] = {
        "b64": base64.b64encode(prod_registry_bytes).decode("ascii"),
        "mode": 0o644,
    }

    return {
        "controllerSha256": controller_sha,
        "coreDigest": core_digest,
        "sshUser": ssh_user,
        "sourceIps": source_ips,
        "sshPort": ssh_port,
        "files": files_b64,
    }


def ensure_host_exec_keydir(key_dir: Path, key_id: str) -> Dict[str, str]:
    if os.getuid() != 0:
        raise RuntimeError("--prepare-host-keys must run as root (uid 0)")
    key_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    os.chown(key_dir, 0, 0)
    os.chmod(key_dir, 0o755)

    exec_dir = key_dir / f"{key_id}-exec"
    exec_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(exec_dir, 0, 0)
    os.chmod(exec_dir, 0o700)

    master_priv = exec_dir / "v4_master_id_ed25519"
    master_pub = exec_dir / "v4_master_id_ed25519.pub"
    if not master_priv.exists():
        subprocess.run(
            [
                "/usr/bin/ssh-keygen",
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                KEY_COMMENT,
                "-f",
                str(master_priv),
            ],
            check=True,
        )
    os.chown(master_priv, 0, 0)
    os.chmod(master_priv, 0o600)
    os.chown(master_pub, 0, 0)
    os.chmod(master_pub, 0o644)

    priv_bytes = master_priv.read_bytes()
    pub_text = " ".join(master_pub.read_text(encoding="utf-8").strip().split()[:2]) + f" {KEY_COMMENT}"

    # Separate regular files (`st_nlink == 1`) per driverId as required by `sshTransport.ts`.
    for drv in PRODUCTION_DRIVERS:
        dst = exec_dir / f"v4_{drv}_id_ed25519"
        tmp = exec_dir / f".v4_{drv}_id_ed25519.tmp"
        if tmp.exists():
            tmp.unlink()
        tmp.write_bytes(priv_bytes)
        os.chown(tmp, 0, 0)
        os.chmod(tmp, 0o600)
        tmp.replace(dst)
        st = dst.lstat()
        if st.st_nlink != 1 or st.st_uid != 0 or (st.st_mode & 0o077):
            raise RuntimeError(f"Unsafe key file {dst}")

    known_hosts = exec_dir / "known_hosts"
    if not known_hosts.exists():
        known_hosts.write_text("", encoding="utf-8")
    os.chown(known_hosts, 0, 0)
    os.chmod(known_hosts, 0o644)

    return {
        "execDir": str(exec_dir),
        "publicKey": pub_text,
        "knownHostsPath": str(known_hosts),
        "ccKeyPath": str(exec_dir / "v4_cc_id_ed25519"),
        "codexKeyPath": str(exec_dir / "v4_codex_id_ed25519"),
    }


REMOTE_INSTALL_SCRIPT = r"""
import base64, hashlib, json, os, pathlib, pwd, stat, sys, tempfile

req = json.loads(sys.stdin.read())
ctrl_sha = req["controllerSha256"]
ssh_user = req["sshUser"]
source_ips = req["sourceIps"]
ssh_port = int(req["sshPort"])
pubkey_line = req["publicKey"].strip()
files = req["files"]

assert os.getuid() == 0, "Remote installer must run as root"
pw = pwd.getpwnam(ssh_user)
user_home = pathlib.Path(pw.pw_dir)

base_root = pathlib.Path("/opt/openclaude/remote-driver")
bundle_root = base_root / ctrl_sha
for p in (pathlib.Path("/opt"), pathlib.Path("/opt/openclaude"), base_root, bundle_root, bundle_root / "core", bundle_root / "drivers"):
    p.mkdir(mode=0o755, parents=True, exist_ok=True)
    os.chown(p, 0, 0)
    os.chmod(p, 0o755)

for rel, spec in sorted(files.items()):
    dst = bundle_root / rel
    raw = base64.b64decode(spec["b64"], validate=True)
    fd, tmp_s = tempfile.mkstemp(prefix="." + dst.name + ".", dir=str(dst.parent))
    try:
        os.fchmod(fd, int(spec["mode"]))
        os.fchown(fd, 0, 0)
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_s, dst)
    finally:
        if os.path.exists(tmp_s):
            os.unlink(tmp_s)

actual_ctrl_sha = hashlib.sha256((bundle_root / "core/controller.py").read_bytes()).hexdigest()
assert actual_ctrl_sha == ctrl_sha, f"Controller sha mismatch: {actual_ctrl_sha} != {ctrl_sha}"

# Discover up to 7 older v4 controllers for drain/stop compatibility.
controllers = [{"path": str(bundle_root / "core/controller.py"), "sha256": ctrl_sha}]
for sibling in sorted(base_root.iterdir(), reverse=True):
    if sibling.name == ctrl_sha or not sibling.is_dir() or len(sibling.name) != 64:
        continue
    old_ctrl = sibling / "core/controller.py"
    if old_ctrl.is_file() and not old_ctrl.is_symlink():
        old_sha = hashlib.sha256(old_ctrl.read_bytes()).hexdigest()
        if old_sha == sibling.name:
            controllers.append({"path": str(old_ctrl), "sha256": old_sha})
    if len(controllers) >= 8:
        break

guard_cfg = {
    "version": 4,
    "user": ssh_user,
    "sourceIps": source_ips,
    "sshPort": ssh_port,
    "rootPrefix": f"{user_home}/oc-remotedrv-",
    "controllers": controllers,
}
guard_json_path = bundle_root / "core/guard.json"
fd, tmp_g = tempfile.mkstemp(prefix=".guard.json.", dir=str(bundle_root / "core"))
try:
    os.fchmod(fd, 0o644)
    os.fchown(fd, 0, 0)
    with os.fdopen(fd, "wb") as f:
        f.write((json.dumps(guard_cfg, indent=2) + "\n").encode("utf-8"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_g, guard_json_path)
finally:
    if os.path.exists(tmp_g):
        os.unlink(tmp_g)

# Verify strict guard.py ownership/mode/nlink invariants on core/ and drivers/.
for bdir in (bundle_root / "core", bundle_root / "drivers"):
    bst = bdir.lstat()
    assert stat.S_ISDIR(bst.st_mode) and bst.st_uid == 0 and not (bst.st_mode & 0o022)
    for child in list(bdir.iterdir()):
        if child.name == "__pycache__":
            import shutil as _sh
            _sh.rmtree(child)
            continue
        cst = child.lstat()
        assert stat.S_ISREG(cst.st_mode) and cst.st_uid == 0 and cst.st_nlink == 1 and not (cst.st_mode & 0o022), f"Unsafe child {child}"

# Additive authorized_keys update: preserve ALL non-oc-rpool-v4 lines verbatim.
ssh_dir = user_home / ".ssh"
ssh_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chown(ssh_dir, pw.pw_uid, pw.pw_gid)
os.chmod(ssh_dir, 0o700)
ak_path = ssh_dir / "authorized_keys"
existing_lines = ak_path.read_text(encoding="utf-8").splitlines() if ak_path.exists() else []
preserved = [ln for ln in existing_lines if not ln.strip().endswith(" oc-rpool-v4")]
guard_py = str(bundle_root / "core/guard.py")
forced_line = (
    f'command="/usr/bin/python3 -I -B {guard_py}",'
    f"no-pty,no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc {pubkey_line}"
)
new_lines = [*preserved, forced_line]
fd, tmp_ak = tempfile.mkstemp(prefix=".authorized_keys.", dir=str(ssh_dir))
try:
    os.fchmod(fd, 0o600)
    os.fchown(fd, pw.pw_uid, pw.pw_gid)
    with os.fdopen(fd, "wb") as f:
        f.write(("\n".join(new_lines) + "\n").encode("utf-8"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_ak, ak_path)
finally:
    if os.path.exists(tmp_ak):
        os.unlink(tmp_ak)

host_ed25519_pub = pathlib.Path("/etc/ssh/ssh_host_ed25519_key.pub").read_text(encoding="utf-8").strip()
print(json.dumps({
    "ok": True,
    "bundleRoot": str(bundle_root),
    "controllerPath": str(bundle_root / "core/controller.py"),
    "guardPath": guard_py,
    "preservedAuthorizedKeyLines": len(preserved),
    "hostEd25519Pub": " ".join(host_ed25519_pub.split()[:2]),
}))
"""


def update_known_hosts(known_hosts_path: Path, host: str, port: int, host_ed25519_pub: str) -> str:
    host_entry_prefix = f"[{host}]:{port}" if port != 22 else host
    new_line = f"{host_entry_prefix} {host_ed25519_pub}"
    existing = known_hosts_path.read_text(encoding="utf-8").splitlines() if known_hosts_path.exists() else []
    kept = [
        ln
        for ln in existing
        if ln.strip() and not ln.startswith(f"{host_entry_prefix} ")
    ]
    kept.append(new_line)
    tmp = known_hosts_path.parent / ".known_hosts.tmp"
    if tmp.exists():
        tmp.unlink()
    tmp.write_text("\n".join(kept) + "\n", encoding="utf-8")
    os.chown(tmp, 0, 0)
    os.chmod(tmp, 0o644)
    tmp.replace(known_hosts_path)

    key_b64 = host_ed25519_pub.split()[1]
    digest_b64 = base64.b64encode(hashlib.sha256(base64.b64decode(key_b64)).digest()).decode("ascii").rstrip("=")
    return f"SHA256:{digest_b64}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Install additive remote-driver-v4 bundle onto a remote node.")
    parser.add_argument("--host", required=True, help="Target node SSH host/IP")
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--ssh-user", default="box")
    parser.add_argument("--source-ip", action="append", default=[], help="Allowed master client IP(s)")
    parser.add_argument("--key-dir", default="/etc/openclaude/remote-pool-keys")
    parser.add_argument("--key-id", default="rpoolv4")
    parser.add_argument("--public-key", default="", help="Explicit SSH public key if not preparing host keys locally")
    parser.add_argument("--prepare-host-keys", action="store_true", help="Create/verify root-owned v4 SSH keys locally")
    parser.add_argument(
        "--admin-ssh",
        required=True,
        help="Shell command prefix that executes root python3 on target node (e.g. 'ssh -i ... root@host')",
    )
    parser.add_argument("--use-sudo", action="store_true", help="Run remote installer via `sudo -n /usr/bin/python3 -I -B -`")
    parser.add_argument("--verify-engine", default="", help="Optional engineId (cc|codex) to preflight over v4 SSH guard")
    args = parser.parse_args()

    source_ips = args.source_ip or ["38.55.252.217"]
    key_info: Dict[str, str] = {}
    if args.prepare_host_keys:
        key_info = ensure_host_exec_keydir(Path(args.key_dir), args.key_id)
        pubkey = key_info["publicKey"]
    else:
        if not args.public_key:
            raise RuntimeError("Either --prepare-host-keys or --public-key is required")
        pubkey = args.public_key.strip()

    payload = build_bundle_payload(args.ssh_user, source_ips, args.port)
    payload["publicKey"] = pubkey

    remote_py = "sudo -n /usr/bin/python3 -I -B -c" if args.use_sudo else "/usr/bin/python3 -I -B -c"
    full_cmd = [*shlex.split(args.admin_ssh), f"{remote_py} {shlex.quote(REMOTE_INSTALL_SCRIPT)}"]
    proc = subprocess.run(
        full_cmd,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if proc.returncode != 0:
        sys.stderr.write(f"Remote install failed (rc={proc.returncode}):\n{proc.stderr}\n{proc.stdout}\n")
        return proc.returncode

    remote_res = json.loads(proc.stdout.strip().splitlines()[-1])
    host_fp = ""
    if args.prepare_host_keys:
        host_fp = update_known_hosts(
            Path(key_info["knownHostsPath"]),
            args.host,
            args.port,
            remote_res["hostEd25519Pub"],
        )

    preflight_res = None
    if args.verify_engine and args.prepare_host_keys:
        drv = args.verify_engine
        key_path = Path(args.key_dir) / f"{args.key_id}-exec" / f"v4_{drv}_id_ed25519"
        kh_path = Path(key_info["knownHostsPath"])
        ctrl_path = remote_res["controllerPath"]
        task_root = f"/home/{args.ssh_user}/oc-remotedrv-preflight-{drv}-installcheck0001"
        q = lambda s: "'" + s.replace("'", "'\\''") + "'"
        remote_cmd = " ".join(
            q(x)
            for x in ["/usr/bin/python3", "-I", "-B", ctrl_path, "preflight", task_root]
        )
        ssh_cmd = [
            "/usr/bin/ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            f"UserKnownHostsFile={kh_path}",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-T",
            "-p",
            str(args.port),
            "-i",
            str(key_path),
            f"{args.ssh_user}@{args.host}",
            remote_cmd,
        ]
        pf = subprocess.run(
            ssh_cmd,
            input=json.dumps({"engineId": drv}) + "\n",
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        if pf.returncode != 0:
            sys.stderr.write(f"v4 SSH guard preflight failed (rc={pf.returncode}): {pf.stderr} {pf.stdout}\n")
            return 5
        preflight_res = json.loads(pf.stdout.strip())

    reg = load_registry()
    print(
        json.dumps(
            {
                "ok": True,
                "host": args.host,
                "controllerSha256": payload["controllerSha256"],
                "coreDigest": payload["coreDigest"],
                "driverDigests": {
                    k: file_sha256(AGENT_REMOTE_DIR / reg[k]["module"]) for k in PRODUCTION_DRIVERS
                },
                "hostKeyFp": host_fp,
                "keyInfo": key_info,
                "remote": remote_res,
                "preflight": preflight_res,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
