#!/usr/bin/env python3
"""Offline positive and fail-closed checks for supervised structured stdin."""
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time

SUPERVISOR = str(Path(__file__).with_name("box_supervisor.py"))
BODY = b'{"type":"user","message":{"role":"user","content":"ping"}}\n'


def run_case(kind: str) -> tuple[int, bool, bytes, float]:
    directory = Path("/tmp") / ("ocv5-289-run-" + secrets.token_hex(12))
    os.mkdir(directory, 0o700)
    path = directory / "stdin.jsonl"
    marker = directory / "child.pid"
    try:
        if kind == "fifo":
            os.mkfifo(path, 0o600)
        elif kind == "symlink":
            target = directory / "target.jsonl"
            target.write_bytes(BODY)
            os.chmod(target, 0o600)
            path.symlink_to(target)
        else:
            with open(path, "xb") as out:
                out.write(BODY)
                if kind == "oversize":
                    out.truncate(8 * 1024 * 1024 + 1)
            os.chmod(path, 0o644 if kind == "mode" else 0o600)
        wanted = hashlib.sha256(BODY).hexdigest()
        if kind == "wrong_hash":
            wanted = "0" * 64
        command = [sys.executable, SUPERVISOR, "--deadline", "2", "--kill-after", "0.1",
                   "--max-output", "4096", "--stdin-file", str(path),
                   "--stdin-sha256", wanted, "--", sys.executable,
                   "-c", "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())"]
        started = time.monotonic()
        result = subprocess.run(command, capture_output=True, timeout=4,
                                env={**os.environ, "OCV5_SUPERVISOR_TEST_CHILD_PID_FILE": str(marker)})
        elapsed = time.monotonic() - started
        return result.returncode, marker.exists(), result.stdout, elapsed
    finally:
        shutil.rmtree(directory)


def main() -> int:
    good = run_case("good")
    assert good[0] == 0 and good[1] and good[2] == BODY, good
    outcomes = {}
    for kind in ("wrong_hash", "symlink", "fifo", "oversize", "mode"):
        result = run_case(kind)
        assert result[0] == 126 and not result[1] and not result[2], (kind, result)
        assert result[3] < 2, (kind, "pre-spawn rejection exceeded bound", result[3])
        outcomes[kind] = {"exit": result[0], "childSpawned": result[1]}
    for supplied in (("--stdin-file", "", "--stdin-sha256", ""),
                     ("--stdin-sha256", "")):
        marker = Path("/tmp") / ("ocv5-289-empty-" + secrets.token_hex(12) + ".pid")
        result = subprocess.run([sys.executable, SUPERVISOR, "--deadline", "1",
                                 *supplied, "--", sys.executable, "-c", "print('SHOULD_NOT_RUN')"],
                                capture_output=True, timeout=3,
                                env={**os.environ, "OCV5_SUPERVISOR_TEST_CHILD_PID_FILE": str(marker)})
        assert result.returncode == 126 and not result.stdout and not marker.exists(), result
        outcomes["empty_args_" + str(len(supplied))] = {"exit": result.returncode,
                                                    "childSpawned": False}
    print({"positive": {"exit": good[0], "stdinExact": good[2] == BODY},
           "negative": outcomes})
    return 0


if __name__ == "__main__":
    sys.exit(main())
