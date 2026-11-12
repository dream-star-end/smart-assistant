#!/usr/bin/env python3
"""Unified Conformance Suite CLI entry point (`OCV5-749` `AC-1`, `AC-2`).

Usage:
  python3 scripts/agent-remote/conformance/run.py \
    --driver cc \
    --evidence /path/to/evidence-dir \
    [--mode sandbox|live-node] \
    [--node-config /path/to/node-config.json] \
    [--profile <profile-name>] \
    [--groups 1,2,3,4,5,6,7] \
    [--registry /path/to/registry.json]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlparse

CONFORMANCE_DIR = Path(__file__).resolve().parent
REPO_ROOT = CONFORMANCE_DIR.parents[2]
RUNNER_TS = CONFORMANCE_DIR / "runner.ts"
TSX_BIN = REPO_ROOT / "node_modules" / ".bin" / "tsx"


def compute_suite_digest() -> str:
    h = hashlib.sha256()
    for name in ("fixtures.ts", "harness.ts", "runner.ts", "run.py"):
        p = CONFORMANCE_DIR / name
        h.update(name.encode("utf-8") + b"\0")
        h.update(hashlib.sha256(p.read_bytes()).digest())
    return h.hexdigest()


def compute_ts_core_digest() -> str:
    h = hashlib.sha256()
    for pkg_rel in (
        "packages/protocol/src",
        "packages/gateway/src",
        "packages/commercial/src",
    ):
        base = REPO_ROOT / pkg_rel
        for file_path in sorted(p for p in base.rglob("*") if p.is_file()):
            rel = file_path.relative_to(REPO_ROOT).as_posix()
            h.update(rel.encode("utf-8") + b"\0")
            h.update(hashlib.sha256(file_path.read_bytes()).digest())
    return h.hexdigest()


def read_git_provenance() -> tuple[str, bool]:
    try:
        head_proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=True,
        )
        status_proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=True,
        )
        return head_proc.stdout.strip(), (status_proc.stdout.strip() == "")
    except Exception:
        return "unmounted-worktree", False


def main() -> int:
    parser = argparse.ArgumentParser(description="Run OCV5-749 unified remote-driver-v4 conformance suite.")
    parser.add_argument("--driver", required=True, help="Registered driverId (e.g. cc, codex, example_echo)")
    parser.add_argument("--evidence", required=True, help="Output directory for JSON conformance evidence")
    parser.add_argument(
        "--mode",
        choices=("sandbox", "live-node"),
        default="sandbox",
        help="Execution mode: hermetic sandbox or live remote node over real SSH guard",
    )
    parser.add_argument("--node-config", default="", help="JSON config path required when --mode live-node")
    parser.add_argument("--profile", default="", help="Optional profile name label")
    parser.add_argument("--groups", default="1,2,3,4,5,6,7", help="Comma-separated group numbers (default: 1..7)")
    parser.add_argument("--registry", default="", help="Optional path to drivers/registry.json")
    args = parser.parse_args()

    if args.mode == "live-node" and not args.node_config:
        sys.stderr.write("--node-config <json> is required when --mode live-node\n")
        return 2

    evidence_dir = Path(args.evidence).resolve()
    evidence_dir.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env.setdefault("TEST_DATABASE_URL", "postgres://test:test@127.0.0.1:55432/openclaude_test")
    env.setdefault("TEST_REDIS_URL", "redis://127.0.0.1:56379")
    env["REQUIRE_TEST_DB"] = "1"

    parsed_db = urlparse(env["TEST_DATABASE_URL"])
    if not parsed_db.path.endswith("_test"):
        sys.stderr.write(f"Refusing non-test database URL: {parsed_db.path}\n")
        return 2

    suite_digest = compute_suite_digest()
    ts_core_digest = compute_ts_core_digest()
    git_head_sha, git_worktree_clean = read_git_provenance()
    if args.mode == "live-node" and not re.fullmatch(r"[0-9a-f]{40}", git_head_sha):
        sys.stderr.write(
            f"live-node mode requires a valid 40-hex git HEAD SHA (got {git_head_sha!r}); run on repo host.\n"
        )
        return 2

    cmd_parts = [
        str(TSX_BIN),
        str(RUNNER_TS),
        "--driver",
        args.driver,
        "--evidence",
        str(evidence_dir),
        "--mode",
        args.mode,
        "--groups",
        args.groups,
        "--suite-digest",
        suite_digest,
        "--git-head-sha",
        git_head_sha,
        "--git-worktree-clean",
        "true" if git_worktree_clean else "false",
        "--ts-core-digest",
        ts_core_digest,
    ]
    if args.node_config:
        cmd_parts.extend(["--node-config", str(Path(args.node_config).resolve())])
    if args.profile:
        cmd_parts.extend(["--profile", args.profile])
    if args.registry:
        cmd_parts.extend(["--registry", str(Path(args.registry).resolve())])

    completed = subprocess.run(
        cmd_parts,
        cwd=str(REPO_ROOT),
        env=env,
        check=False,
    )
    if completed.returncode != 0:
        sys.stderr.write(f"Conformance runner exited with code {completed.returncode}\n")
        return completed.returncode

    summary_path = evidence_dir / "summary.json"
    if not summary_path.is_file():
        sys.stderr.write("Missing summary.json after conformance run\n")
        return 3

    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    if summary.get("suiteDigest") != compute_suite_digest():
        sys.stderr.write("Conformance suiteDigest drifted during run\n")
        return 4
    if summary.get("tsCoreDigest") != compute_ts_core_digest():
        sys.stderr.write("Conformance tsCoreDigest drifted during run\n")
        return 4

    if (
        not summary.get("overallPassed")
        or not summary.get("allGreenPassed")
        or not summary.get("allRedControlsCaught")
        or summary.get("skippedCount") != 0
        or summary.get("unverifiedCount", 0) != 0
    ):
        sys.stderr.write("Conformance summary failed strict green+red / zero-skip / zero-unverified invariants\n")
        return 4

    print(
        json.dumps(
            {
                "ok": True,
                "driverId": summary["driverId"],
                "mode": summary["mode"],
                "targetHost": summary["targetHost"],
                "sshMode": summary["sshMode"],
                "groupsExecuted": summary["groupsExecuted"],
                "requirementsExecuted": summary["requirementsExecuted"],
                "skippedCount": summary["skippedCount"],
                "unverifiedCount": summary.get("unverifiedCount", 0),
                "suiteDigest": summary["suiteDigest"],
                "coreDigest": summary["coreDigest"],
                "driverDigest": summary["driverDigest"],
                "probeFingerprint": summary["probeFingerprint"],
                "evidenceSummary": str(summary_path),
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
