#!/usr/bin/env python3
"""Owner-scoped detached keeper launch and bounded stdout spool read.

Offline primitive only. Actual Box process survival after Connect Exec closes
must be proven by the non-model operator probe before any production tool path.
"""
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time

RUN_DIR = re.compile(r"^/tmp/ocv5-289-run-([a-f0-9]{24})$")
ASSET = re.compile(r"^/tmp/ocv5-289-(keeper|supervisor)-([a-f0-9]{16})\.py$")
PROOF = re.compile(r"^/tmp/ocv5-289-proof-([a-f0-9]{24})$")
MAX_SPOOL = 8 * 1024 * 1024


def verified_dir(path: str) -> int:
    if not RUN_DIR.fullmatch(path) or os.path.realpath(path) != path:
        raise ValueError("RUN_DIR_INVALID")
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700):
        os.close(fd)
        raise ValueError("RUN_DIR_INVALID")
    return fd


def verified_asset(path: str, kind: str) -> None:
    match = ASSET.fullmatch(path)
    if not match or match[1] != kind or os.path.realpath(path) != path:
        raise ValueError("ASSET_INVALID")
    info = os.lstat(path)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600 or not 1 <= info.st_size <= 32768):
        raise ValueError("ASSET_INVALID")
    with open(path, "rb") as source:
        if hashlib.sha256(source.read()).hexdigest()[:16] != match[2]:
            raise ValueError("ASSET_INVALID")


def launch(argv: list[str]) -> int:
    if len(argv) < 10:
        return 126
    directory, keeper, supervisor, *options = argv
    nonce = RUN_DIR.fullmatch(directory)
    if not nonce:
        return 126
    try:
        verified_asset(keeper, "keeper")
        verified_asset(supervisor, "supervisor")
        if "--" not in options or options.index("--") == len(options) - 1:
            return 126
        command = options[options.index("--") + 1]
        if not os.path.isabs(command):
            return 126
        if ("--proof-dir" not in options or "--lease-epoch" not in options
                or "--deadline" not in options):
            return 126
        proof = options[options.index("--proof-dir") + 1]
        epoch = options[options.index("--lease-epoch") + 1]
        duration = float(options[options.index("--deadline") + 1])
        if (not PROOF.fullmatch(proof) or PROOF.fullmatch(proof)[1] != nonce[1]
                or not re.fullmatch(r"[a-f0-9]{32}", epoch)
                or not 1 <= duration <= 900):
            return 126
        directory_fd = verified_dir(directory)
    except (OSError, ValueError, IndexError):
        return 126
    try:
        out = os.open("stdout.jsonl", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                      0o600, dir_fd=directory_fd)
        try:
            err = os.open("stderr.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                          0o600, dir_fd=directory_fd)
            try:
                process = subprocess.Popen([sys.executable, keeper, supervisor, *options],
                    cwd=directory, env=os.environ.copy(), stdin=subprocess.DEVNULL,
                    stdout=out, stderr=err, start_new_session=True, close_fds=True)
            finally:
                os.close(err)
        finally:
            os.close(out)
        time.sleep(.15)
        if process.poll() is not None:
            return 125
        print("launched")
        return 0
    except (OSError, subprocess.SubprocessError):
        return 126
    finally:
        os.close(directory_fd)


def read_spool(argv: list[str]) -> int:
    if len(argv) != 3:
        return 126
    directory, offset_raw, limit_raw = argv
    try:
        offset, limit = int(offset_raw), int(limit_raw)
        if offset < 0 or offset > MAX_SPOOL or not 1 <= limit <= 65536:
            return 126
        directory_fd = verified_dir(directory)
    except (OSError, ValueError):
        return 126
    try:
        fd = os.open("stdout.jsonl", os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
                     dir_fd=directory_fd)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > MAX_SPOOL):
                return 126
            data = os.pread(fd, min(limit, MAX_SPOOL - offset), offset)
            print(json.dumps({"offset": offset + len(data),
                              "data": base64.b64encode(data).decode("ascii")},
                             separators=(",", ":")))
            return 0
        finally:
            os.close(fd)
    except OSError:
        return 126
    finally:
        os.close(directory_fd)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--read":
        sys.exit(read_spool(sys.argv[2:]))
    sys.exit(launch(sys.argv[1:]))
