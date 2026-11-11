#!/usr/bin/env python3
"""Unified Conformance Suite CLI entry point (`OCV5-749` `AC-1`, `AC-2`).

Usage:
  python3 scripts/agent-remote/conformance/run.py \
    --driver cc \
    --evidence /path/to/evidence-dir \
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
import shlex
import subprocess
import sys
from urllib.parse import urlparse

CONFORMANCE_DIR = Path(__file__).resolve().parent
REPO_ROOT = CONFORMANCE_DIR.parents[2]
RUNNER_TS = CONFORMANCE_DIR / "runner.ts"
TEST_MUTEX = REPO_ROOT / "scripts" / "test-mutex.sh"
TSX_BIN = REPO_ROOT / "node_modules" / ".bin" / "tsx"


def compute_suite_digest() -> str:
    h = hashlib.sha256()
    for name in ("fixtures.ts", "harness.ts", "runner.ts", "run.py"):
        p = CONFORMANCE_DIR / name
        h.update(name.encode("utf-8") + b"\0")
        h.update(hashlib.sha256(p.read_bytes()).digest())
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run OCV5-749 unified remote-driver-v4 conformance suite.")
    parser.add_argument("--driver", required=True, help="Registered driverId (e.g. cc, codex, example_echo)")
    parser.add_argument("--evidence", required=True, help="Output directory for JSON conformance evidence")
    parser.add_argument("--profile", default="", help="Optional profile name label")
    parser.add_argument("--groups", default="1,2,3,4,5,6,7", help="Comma-separated group numbers (default: 1..7)")
    parser.add_argument("--registry", default="", help="Optional path to drivers/registry.json")
    args = parser.parse_args()

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

    cmd_parts = [
        str(TSX_BIN),
        str(RUNNER_TS),
        "--driver",
        args.driver,
        "--evidence",
        str(evidence_dir),
        "--groups",
        args.groups,
    ]
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
    summary["suiteDigest"] = compute_suite_digest()
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    if (
        not summary.get("overallPassed")
        or not summary.get("allGreenPassed")
        or not summary.get("allRedControlsCaught")
        or summary.get("skippedCount") != 0
    ):
        sys.stderr.write("Conformance summary failed strict green+red / zero-skip invariants\n")
        return 4

    print(
        json.dumps(
            {
                "ok": True,
                "driverId": summary["driverId"],
                "groupsExecuted": summary["groupsExecuted"],
                "requirementsExecuted": summary["requirementsExecuted"],
                "skippedCount": summary["skippedCount"],
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
