#!/usr/bin/env python3
"""Read-only / isolated P0 node & driver survey CLI (`OCV5-749`, `AC-9`).

Outputs structured JSON with per-check `PASS | FAIL | UNVERIFIED` and authentic SHA-256 digests.
Safety invariants:
- Never reads or prints credential file contents (`auth.json`, `.credentials.json`, tokens).
- Never runs `pip install`, `claude login`, `codex login`, or mutates active user lanes.
- Uses `ControlMaster=no`, `ControlPath=none`, `BatchMode=yes`, `StrictHostKeyChecking=yes` for SSH.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional

ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from core.canonical import remote_canonical_sha256, strict_json  # noqa: E402
from core.contract import (  # noqa: E402
    compute_core_digest,
    compute_probe_fingerprint,
    file_sha256,
    load_driver,
    validate_decode_batch,
    validate_model_snapshot,
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def check_worker_ipc(driver_id: str, iterations: int = 25) -> Dict[str, Any]:
    worker_path = ROOT_DIR / "core" / "driver_worker.py"
    proc = subprocess.Popen(
        ["/usr/bin/python3", "-I", "-B", str(worker_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stdin is not None and proc.stdout is not None
    latencies_ms: List[float] = []
    try:
        t0 = time.perf_counter()
        proc.stdin.write(
            (json.dumps({"id": "info-1", "method": "info", "params": {"driverId": driver_id}}) + "\n").encode("utf-8")
        )
        proc.stdin.flush()
        info_line = proc.stdout.readline()
        cold_info_ms = round((time.perf_counter() - t0) * 1000.0, 3)
        info_resp = strict_json(info_line)
        if not info_resp.get("ok"):
            return {"status": "FAIL", "error": info_resp.get("error")}

        sample_frame = (
            json.dumps(
                {
                    "type": "stream_event",
                    "session_id": "11111111-2222-4333-8444-555555555555",
                    "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}},
                }
            )
            if driver_id == "cc"
            else json.dumps({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"delta": "ok"}})
        )
        for idx in range(iterations):
            start = time.perf_counter()
            req = {
                "id": f"dec-{idx}",
                "method": "decode",
                "params": {
                    "driverId": driver_id,
                    "channel": "native",
                    "frameSeq": idx + 1,
                    "rawFrame": sample_frame + "\n",
                    "nativeState": {"sessionId": "11111111-2222-4333-8444-555555555555"},
                },
            }
            proc.stdin.write((json.dumps(req, separators=(",", ":")) + "\n").encode("utf-8"))
            proc.stdin.flush()
            resp = strict_json(proc.stdout.readline())
            latencies_ms.append((time.perf_counter() - start) * 1000.0)
            if not resp.get("ok"):
                return {"status": "FAIL", "error": resp.get("error")}

        sorted_lat = sorted(latencies_ms)
        p95_idx = min(len(sorted_lat) - 1, int(round(0.95 * (len(sorted_lat) - 1))))
        p95 = round(sorted_lat[p95_idx], 3)
        return {
            "status": "PASS" if p95 <= 50.0 else "FAIL",
            "coldInfoMs": cold_info_ms,
            "p50Ms": round(statistics.median(sorted_lat), 3),
            "p95Ms": p95,
            "driverDigest": info_resp["result"]["driverDigest"],
            "coreDigest": info_resp["result"]["coreDigest"],
        }
    finally:
        proc.stdin.close()
        proc.stdout.close()
        if proc.stderr is not None:
            proc.stderr.close()
        proc.wait(timeout=5)


def check_mcp_correlation(driver_id: str) -> Dict[str, Any]:
    mod, _, _ = load_driver(driver_id)
    if driver_id == "cc":
        raw = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {
                    "name": "t0",
                    "arguments": {"path": "README.md"},
                    "_meta": {"claudecode/toolUseId": "toolu_01SurveyCheck"},
                },
            }
        ).encode("utf-8")
        state = {"sessionId": "11111111-2222-4333-8444-555555555555"}
        expected_call = "toolu_01SurveyCheck"
    else:
        raw = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 9,
                "method": "tools/call",
                "params": {
                    "name": "t0",
                    "arguments": {"path": "README.md"},
                    "_meta": {
                        "callId": "call_survey_01",
                        "threadId": "thr_survey_01",
                        "x-codex-turn-metadata": {"turn_id": "turn_survey_01"},
                    },
                },
            }
        ).encode("utf-8")
        state = {"sessionId": "thr_survey_01"}
        expected_call = "call_survey_01"

    decoded = validate_decode_batch(
        mod.decode("fixed_mcp", raw, state),
        channel="fixed_mcp",
        raw_frame_bytes=raw,
        frame_seq=1,
    )
    pending = decoded.get("pendingToolRequest") or {}
    expected_hash = remote_canonical_sha256({"path": "README.md"})
    ok = (
        pending.get("callId") == expected_call
        and pending.get("argsHash") == expected_hash
        and len(decoded["securityEvents"]) == 0
    )
    return {
        "status": "PASS" if ok else "FAIL",
        "callId": pending.get("callId"),
        "argsHash": pending.get("argsHash"),
    }


def _remote_node_script() -> str:
    return r"""
import hashlib, json, os, pathlib, subprocess, sys, tempfile, time

req = json.loads(sys.stdin.read())
driver_id = req["driverId"]
cli_path = req["cliPath"]
home_dir = req.get("accountHome") or str(pathlib.Path.home())
codex_home = req.get("codexHome") or str(pathlib.Path.home() / ".codex")
uid = os.getuid()
xdg = f"/run/user/{uid}"

out = {"scopeContainment": {"status": "UNVERIFIED"}, "probeExecution": {"status": "UNVERIFIED"}}

# 1. Verify systemd --user scope containment (including tmux server containment for cc).
unit = f"oc-survey-{driver_id}-{os.getpid()}.scope"
with tempfile.TemporaryDirectory(prefix="oc-survey-") as tmpdir:
    tpath = pathlib.Path(tmpdir)
    tmux_dir = tpath / "tmux"
    tmux_dir.mkdir(mode=0o700)
    env_run = {"PATH": "/usr/bin:/bin", "XDG_RUNTIME_DIR": xdg, "HOME": home_dir}
    if driver_id == "cc":
        inner = [
            "/usr/bin/python3", "-I", "-B", "-c",
            "import os, subprocess, time; "
            "subprocess.run(['tmux','-L','oc-survey','new-session','-d','-s','s1','sleep','30'], check=True); "
            "time.sleep(30)",
        ]
        env_vars = [f"HOME={home_dir}", "PATH=/usr/bin:/bin", f"TMUX_TMPDIR={tmux_dir}"]
    else:
        inner = ["/bin/sleep", "30"]
        env_vars = [f"HOME={home_dir}", "PATH=/usr/bin:/bin"]

    cmd = [
        "/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--unit", unit,
        "-p", "MemoryMax=268435456", "-p", "TasksMax=64", "-p", "KillMode=control-group",
        "--", "/usr/bin/env", "-i", *env_vars, *inner,
    ]
    proc = subprocess.Popen(cmd, env=env_run, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        cg = ""
        for _ in range(40):
            r = subprocess.run(
                ["/usr/bin/systemctl", "--user", "show", unit, "--property=ActiveState,ControlGroup"],
                env=env_run, text=True, capture_output=True, timeout=5,
            )
            props = dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)
            if props.get("ActiveState") == "active" and props.get("ControlGroup"):
                cg = props["ControlGroup"]
                if driver_id == "cc":
                    chk = subprocess.run(
                        ["tmux", "-L", "oc-survey", "has-session", "-t", "=s1"],
                        env={"PATH": "/usr/bin:/bin", "TMUX_TMPDIR": str(tmux_dir)},
                        capture_output=True,
                    )
                    if chk.returncode == 0:
                        break
                else:
                    break
            time.sleep(0.1)
        cg_path = pathlib.Path("/sys/fs/cgroup" + cg) if cg else None
        procs_before = cg_path.joinpath("cgroup.procs").read_text().split() if (cg_path and cg_path.exists()) else []
        subprocess.run(["/usr/bin/systemctl", "--user", "kill", "--signal=KILL", "--kill-whom=all", unit], env=env_run, capture_output=True)
        subprocess.run(["/usr/bin/systemctl", "--user", "stop", unit], env=env_run, capture_output=True)
        proc.wait(timeout=5)
        r_after = subprocess.run(
            ["/usr/bin/systemctl", "--user", "show", unit, "--property=ActiveState,ControlGroup"],
            env=env_run, text=True, capture_output=True, timeout=5,
        )
        props_after = dict(l.split("=", 1) for l in r_after.stdout.splitlines() if "=" in l)
        tmux_dead = True
        if driver_id == "cc":
            chk2 = subprocess.run(
                ["tmux", "-L", "oc-survey", "has-session", "-t", "=s1"],
                env={"PATH": "/usr/bin:/bin", "TMUX_TMPDIR": str(tmux_dir)},
                capture_output=True,
            )
            tmux_dead = chk2.returncode != 0
        populated_zero = True
        if cg_path and cg_path.exists():
            populated_zero = (not cg_path.joinpath("cgroup.procs").read_text().strip()) and ("populated 0" in cg_path.joinpath("cgroup.events").read_text())
        ok_scope = bool(cg) and len(procs_before) >= (2 if driver_id == "cc" else 1) and props_after.get("ActiveState") in ("inactive", "failed") and tmux_dead and populated_zero
        out["scopeContainment"] = {
            "status": "PASS" if ok_scope else "FAIL",
            "cgroup": cg,
            "pidsInScopeBeforeStop": len(procs_before),
            "activeStateAfterStop": props_after.get("ActiveState"),
            "tmuxStopped": tmux_dead,
            "populatedZero": populated_zero,
        }
    finally:
        if proc.poll() is None:
            proc.kill()

# 2. Execute isolated probe step inside systemd scope without reading credential files.
cp = pathlib.Path(cli_path)
if not cp.is_file():
    out["probeExecution"] = {"status": "UNVERIFIED", "reason": f"CLI missing at {cli_path}"}
else:
    h = hashlib.sha256()
    with cp.open("rb") as f:
        for chunk in iter(lambda: f.read(262144), b""):
            h.update(chunk)
    cli_sha = h.hexdigest()
    native_path = req.get("nativePath") or cli_path
    np = pathlib.Path(native_path)
    nh = hashlib.sha256()
    if np.is_file():
        with np.open("rb") as f:
            for chunk in iter(lambda: f.read(262144), b""):
                nh.update(chunk)
    native_sha = nh.hexdigest() if np.is_file() else cli_sha

    step = req["probeStep"]
    p_unit = f"oc-survey-probe-{driver_id}-{os.getpid()}.scope"
    with tempfile.TemporaryDirectory(prefix="oc-survey-probe-") as pdir:
        pcwd = pathlib.Path(pdir) / "cwd"
        pcwd.mkdir(mode=0o500)
        ptmp = pathlib.Path(pdir) / "tmp"
        ptmp.mkdir(mode=0o700)
        step_env = {
            "HOME": home_dir,
            "PATH": "/usr/bin:/bin:/usr/local/bin",
            "LANG": "C.UTF-8",
            "TMPDIR": str(ptmp),
            **(step.get("environment") or {}),
        }
        p_cmd = [
            "/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--unit", p_unit,
            "-p", "MemoryMax=402653184", "-p", "TasksMax=96", "-p", "KillMode=control-group",
            "--", "/usr/bin/env", "-i", *[f"{k}={v}" for k, v in step_env.items()], *step["argv"],
        ]
        stdin_bytes = "".join(x + "\n" for x in (step.get("stdinLines") or [])).encode("utf-8")
        completed = subprocess.run(
            p_cmd, cwd=pcwd, env={"PATH": "/usr/bin:/bin", "XDG_RUNTIME_DIR": xdg},
            input=stdin_bytes, capture_output=True, timeout=float(step.get("timeoutSec", 20)),
        )
        subprocess.run(["/usr/bin/systemctl", "--user", "stop", p_unit], env={"PATH": "/usr/bin:/bin", "XDG_RUNTIME_DIR": xdg}, capture_output=True)
        out["probeExecution"] = {
            "status": "RAW",
            "returncode": completed.returncode,
            "stdoutB64": __import__("base64").b64encode(completed.stdout).decode("ascii"),
            "stdoutSha256": hashlib.sha256(completed.stdout).hexdigest(),
            "stderrBytes": len(completed.stderr),
            "stderrSha256": hashlib.sha256(completed.stderr).hexdigest(),
            "artifactHashes": {"cli": cli_sha, "native": native_sha},
        }

print(json.dumps(out, separators=(",", ":")))
"""


def run_local_or_ssh_node_survey(driver_id: str, args: argparse.Namespace) -> Dict[str, Any]:
    mod, _, driver_digest = load_driver(driver_id)
    core_digest = compute_core_digest()
    cli_path = args.cli_path or ("/home/box/.oc-remote-cc/claude-2.1.316" if driver_id == "cc" else "/usr/bin/codex")
    native_path = args.native_path or (
        "/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex"
        if driver_id == "codex"
        else cli_path
    )
    account_home = args.account_home or "/home/box"
    codex_home = args.codex_home or "/home/box/.codex"

    if not args.ssh_host:
        cp = Path(cli_path)
        if not cp.is_file():
            return {
                "scopeContainment": {"status": "UNVERIFIED", "reason": "No --ssh-host and local node CLI absent"},
                "probe": {"status": "UNVERIFIED", "reason": f"CLI binary not present locally at {cli_path}"},
            }
        step_req = mod.probe(
            {
                "cliPath": str(cp),
                "nativePath": str(Path(native_path) if Path(native_path).is_file() else cp),
                "accountHome": account_home,
                "codexHome": codex_home,
                "systemCodexRoot": args.system_codex_root or "/etc/codex",
            },
            None,
        )["step"]
        with tempfile.TemporaryDirectory(prefix="oc-local-survey-") as pdir:
            completed = subprocess.run(
                step_req["argv"],
                cwd=pdir,
                env={
                    "HOME": account_home,
                    "PATH": "/usr/bin:/bin:/usr/local/bin",
                    "LANG": "C.UTF-8",
                    **(step_req.get("environment") or {}),
                },
                input="".join(x + "\n" for x in (step_req.get("stdinLines") or [])).encode("utf-8"),
                capture_output=True,
                timeout=float(step_req.get("timeoutSec", 18)),
            )
        hashes = {"cli": file_sha256(cp.resolve())}
        if Path(native_path).is_file():
            hashes["native"] = file_sha256(Path(native_path).resolve())
        else:
            hashes["native"] = hashes["cli"]
        prev = {
            "returncode": completed.returncode,
            "stdoutLines": completed.stdout.decode("utf-8", errors="replace").splitlines(),
            "stdoutSha256": sha256_bytes(completed.stdout),
            "artifactHashes": hashes,
        }
        final_res = mod.probe(
            {
                "cliPath": str(cp),
                "nativePath": str(Path(native_path) if Path(native_path).is_file() else cp),
                "accountHome": account_home,
                "codexHome": codex_home,
                "systemCodexRoot": args.system_codex_root or "/etc/codex",
            },
            prev,
        )
        snap = validate_model_snapshot(final_res)
        fp = compute_probe_fingerprint(
            snap,
            driver_digest=driver_digest,
            core_digest=core_digest,
            policy_sha256=str(final_res.get("policySha256") or snap["rawResponseSha256"]),
        )
        return {
            "scopeContainment": {"status": "UNVERIFIED", "reason": "Local non-SSH mode"},
            "probe": {"status": "PASS", "probeFingerprint": fp, "snapshot": snap},
        }

    # SSH mode: build step 1 without resolving remote paths on local filesystem.
    if driver_id == "cc":
        probe_step = {
            "argv": [
                cli_path,
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--tools",
                "",
                "--setting-sources",
                "",
            ],
            "stdinLines": [
                json.dumps(
                    {"type": "control_request", "request_id": "probe-init-1", "request": {"subtype": "initialize"}},
                    separators=(",", ":"),
                )
            ],
            "environment": {"HOME": account_home, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"},
            "timeoutSec": 20,
        }
    else:
        probe_step = {
            "argv": [cli_path, *mod._policy_args()],
            "stdinLines": [
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "clientInfo": {"name": "openclaude_probe_v4", "version": "1.0.0"},
                            "capabilities": {"experimentalApi": True},
                        },
                    },
                    separators=(",", ":"),
                ),
                json.dumps({"jsonrpc": "2.0", "method": "initialized", "params": {}}, separators=(",", ":")),
                json.dumps({"jsonrpc": "2.0", "id": 2, "method": "account/read", "params": {}}, separators=(",", ":")),
                json.dumps(
                    {"jsonrpc": "2.0", "id": 3, "method": "model/list", "params": {"limit": 100, "includeHidden": False}},
                    separators=(",", ":"),
                ),
            ],
            "environment": {"CODEX_HOME": codex_home},
            "timeoutSec": 20,
        }

    ssh_cmd = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=10",
        "-p",
        str(args.ssh_port),
    ]
    if args.ssh_key:
        ssh_cmd += ["-i", args.ssh_key, "-o", "IdentitiesOnly=yes"]
    if args.known_hosts:
        ssh_cmd += ["-o", f"UserKnownHostsFile={args.known_hosts}"]
    ssh_cmd += [f"{args.ssh_user}@{args.ssh_host}", "/usr/bin/python3", "-I", "-B", "-c", _remote_node_script()]

    payload = json.dumps(
        {
            "driverId": driver_id,
            "cliPath": cli_path,
            "nativePath": native_path,
            "accountHome": account_home,
            "codexHome": codex_home,
            "probeStep": probe_step,
        }
    ).encode("utf-8")
    completed = subprocess.run(ssh_cmd, input=payload, capture_output=True, timeout=45)
    if completed.returncode != 0:
        return {
            "scopeContainment": {"status": "FAIL", "sshExitCode": completed.returncode},
            "probe": {
                "status": "FAIL",
                "sshExitCode": completed.returncode,
                "stderrSha256": sha256_bytes(completed.stderr),
            },
        }
    remote_out = strict_json(completed.stdout)
    raw_exec = remote_out.get("probeExecution") or {}
    if raw_exec.get("status") != "RAW":
        return {"scopeContainment": remote_out.get("scopeContainment"), "probe": raw_exec}

    stdout_bytes = base64.b64decode(raw_exec["stdoutB64"], validate=True)
    # Feed real remote stdout into local driver.probe step 2 using temporary stub files only for Path.resolve() checks.
    with tempfile.TemporaryDirectory(prefix="oc-survey-parse-") as stub_dir:
        sdir = Path(stub_dir)
        stub_cli = sdir / "cli"
        stub_cli.write_bytes(b"stub")
        stub_codex_home = sdir / "codex-home"
        stub_codex_home.mkdir(mode=0o700)
        (stub_codex_home / "auth.json").write_text("{}", encoding="utf-8")
        prev = {
            "returncode": raw_exec["returncode"],
            "stdoutLines": stdout_bytes.decode("utf-8", errors="replace").splitlines(),
            "stdoutSha256": raw_exec["stdoutSha256"],
            "artifactHashes": raw_exec["artifactHashes"],
        }
        parsed = mod.probe(
            {
                "cliPath": str(stub_cli),
                "nativePath": str(stub_cli),
                "accountHome": str(sdir),
                "codexHome": str(stub_codex_home),
                "systemCodexRoot": str(sdir / "no-etc-codex"),
                "probeCwd": str(sdir),
            },
            prev,
        )
        snap = validate_model_snapshot(parsed)
        fp = compute_probe_fingerprint(
            snap,
            driver_digest=driver_digest,
            core_digest=core_digest,
            policy_sha256=str(parsed.get("policySha256") or snap["rawResponseSha256"]),
        )
        return {
            "scopeContainment": remote_out.get("scopeContainment"),
            "probe": {
                "status": "PASS",
                "probeFingerprint": fp,
                "snapshot": snap,
            },
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Remote pool 5-duty driver survey (OCV5-749)")
    parser.add_argument("--driver", choices=("cc", "codex", "all"), default="all")
    parser.add_argument("--ssh-host", default=None)
    parser.add_argument("--ssh-user", default="box")
    parser.add_argument("--ssh-port", type=int, default=22)
    parser.add_argument("--ssh-key", default=None)
    parser.add_argument("--known-hosts", default=None)
    parser.add_argument("--cli-path", default=None)
    parser.add_argument("--native-path", default=None)
    parser.add_argument("--account-home", default=None)
    parser.add_argument("--codex-home", default=None)
    parser.add_argument("--system-codex-root", default=None)
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    drivers = ["cc", "codex"] if args.driver == "all" else [args.driver]
    report: Dict[str, Any] = {
        "schemaVersion": 4,
        "surveyedAt": datetime.now(timezone.utc).isoformat(),
        "coreDigest": compute_core_digest(),
        "targetHost": args.ssh_host or "local",
        "drivers": {},
    }

    for drv in drivers:
        worker_res = check_worker_ipc(drv)
        mcp_res = check_mcp_correlation(drv)
        node_res = run_local_or_ssh_node_survey(drv, args)
        report["drivers"][drv] = {
            "workerIpc": worker_res,
            "mcpCorrelation": mcp_res,
            "scopeContainment": node_res["scopeContainment"],
            "probe": node_res["probe"],
        }

    encoded = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        out_path.write_text(encoded, encoding="utf-8")
    sys.stdout.write(encoded)
    return 0


if __name__ == "__main__":
    sys.exit(main())
