#!/usr/bin/env python3
"""Fixed selfhost host-log policy; install only from the cutover snapshot."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

HELPER = "scripts/v5-selfhost-host-log-policy.py"
MANIFEST = "deploy/v5-selfhost/host-log-policy.json"
SNIPPETS = ("openclaude-v5-selfhost", "openclaude-v5-selfhost-egress-watch")
LOGS = ("openclaude-v5-selfhost.log", "openclaude-v5-selfhost-egress.log")
BUNDLE_FILES = (HELPER, MANIFEST) + tuple("deploy/v5-selfhost/logrotate.d/" + n for n in SNIPPETS)
EXPECTED = {"schemaVersion": 1, "generation": 1, "logs": list(LOGS), "snippets": list(SNIPPETS)}
LOG_PATTERN = re.compile(r"^openclaude-v5-selfhost(?:-egress)?\.log(?:\.[0-9]+(?:\.gz)?)?$")
INSTALLED = {
    HELPER: "usr/local/lib/openclaude-v5-selfhost/host-log-policy.py",
    MANIFEST: "etc/openclaude/v5-selfhost-host-log-policy.json",
    **{"deploy/v5-selfhost/logrotate.d/" + n: "etc/logrotate.d/" + n for n in SNIPPETS},
}


def mapped(root, relative):
    path = root / relative
    if root != Path("/") and not path.resolve().is_relative_to(root):
        raise ValueError("fixture path escapes its private root")
    return path


def regular_bytes(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("policy file is not regular: " + str(path))
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def bundle_files(bundle):
    files = {name: regular_bytes(bundle / name) for name in BUNDLE_FILES}
    manifest = json.loads(files[MANIFEST])
    if not isinstance(manifest, dict):
        raise ValueError("host-log policy manifest must be an object")
    if (type(manifest.get("schemaVersion")) is not int
            or type(manifest.get("generation")) is not int or manifest != EXPECTED):
        raise ValueError("unsupported host-log policy manifest")
    return files


def config_bytes(data, root):
    if root == Path("/"):
        return data
    prefix = (str(mapped(root, "var/log")) + "/").encode()
    return re.sub(rb"""(^|[\s"'])/var/log/""",
                  lambda match: match.group(1) + prefix, data, flags=re.M)


@contextlib.contextmanager
def scan_logs(root):
    directory = mapped(root, "var/log")
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("log directory must be a real directory")
    records, invalid = [], []
    names = sorted(p.name for p in directory.iterdir() if LOG_PATTERN.fullmatch(p.name))
    missing = [n for n in LOGS if n not in names]
    try:
        for name in names:
            path = directory / name
            fd = None
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("not a regular log file")
                records.append((path, fd, info))
                fd = None
            except (OSError, ValueError):
                invalid.append({"path": str(path), "issue": "unreadable-symlink-or-nonregular"})
            finally:
                if fd is not None:
                    os.close(fd)
        yield records, missing, invalid
    finally:
        for _, fd, _ in records:
            os.close(fd)


def log_violations(records, missing, invalid, uid, gid):
    problems = list(invalid) + [{"path": n, "issue": "missing-current"} for n in missing]
    for path, fd, _ in records:
        info = os.fstat(fd)
        if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (uid, gid, 0o600):
            problems.append({"path": str(path), "issue": "expected-owner-and-mode-0600"})
    return problems


def repair_open_logs(root, records, missing, invalid, uid, gid):
    if invalid:
        raise ValueError("invalid log targets; no permissions changed")
    # Validate every existing identity before the first chmod or file creation.
    for path, _, before in records:
        now = path.stat(follow_symlinks=False)
        if (now.st_dev, now.st_ino) != (before.st_dev, before.st_ino) or now.st_uid != uid:
            raise ValueError("log identity/owner changed; no permissions changed")
    for _, fd, _ in records:
        os.fchown(fd, uid, gid)
        os.fchmod(fd, 0o600)
    for name in missing:
        path = mapped(root, "var/log/" + name)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.fchown(fd, uid, gid)
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)


def repair_logs(root):
    uid, gid = (0, 0) if root == Path("/") else (os.geteuid(), os.getegid())
    with scan_logs(root) as (records, missing, invalid):
        repair_open_logs(root, records, missing, invalid, uid, gid)


def expected_installed(files, root):
    return {mapped(root, target): config_bytes(files[name], root) if name.endswith(SNIPPETS) else files[name]
            for name, target in INSTALLED.items()}


def installed_violations(expected, uid, gid):
    problems = []
    for path, data in expected.items():
        try:
            info = path.lstat()
            if (not stat.S_ISREG(info.st_mode)
                    or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (uid, gid, 0o644)
                    or regular_bytes(path) != data):
                problems.append({"path": str(path), "issue": "installed-policy-drift"})
        except (OSError, ValueError):
            problems.append({"path": str(path), "issue": "missing-or-invalid-installed-policy"})
    return problems


def check_policy(root, files):
    uid, gid = (0, 0) if root == Path("/") else (os.geteuid(), os.getegid())
    with scan_logs(root) as (records, missing, invalid):
        problems = log_violations(records, missing, invalid, uid, gid)
        count = len(records)
    problems += installed_violations(expected_installed(files, root), uid, gid)
    return {"status": "FAIL" if problems else "PASS", "logFiles": count, "violations": problems}


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def dry_run_view(root, files, attempt):
    view = attempt / "view"
    directory = view / "logrotate.d"
    directory.mkdir(parents=True, mode=0o700)
    original = mapped(root, "etc/logrotate.d")
    for source in original.iterdir():
        if source.name not in SNIPPETS and source.is_file():
            write_private(directory / source.name, config_bytes(regular_bytes(source), root))
    for name in SNIPPETS:
        write_private(directory / name, config_bytes(files["deploy/v5-selfhost/logrotate.d/" + name], root))
    config = regular_bytes(mapped(root, "etc/logrotate.conf")).decode()
    config, count = re.subn(r"(?m)^\s*include\s+/etc/logrotate\.d/?\s*$",
                           "include " + str(directory), config)
    if count != 1:
        raise ValueError("expected one global logrotate.d include")
    write_private(view / "logrotate.conf", config.encode())
    with (attempt / "logrotate-debug.log").open("xb") as output:
        os.fchmod(output.fileno(), 0o600)
        result = subprocess.run(["logrotate", "--debug", "--state", "/dev/null",
                                 str(view / "logrotate.conf")], stdout=output,
                                stderr=subprocess.STDOUT, timeout=30)
    if result.returncode:
        raise ValueError("global logrotate dry-run rejected policy; see evidence directory")


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def install_file(path, data, uid, gid):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    # Snippet staging stays outside logrotate.d, so a concurrent reader sees
    # either complete installed file, never an unfinished extra snippet.
    staging = path.parent.parent if path.parent.name == "logrotate.d" else path.parent
    fd, temporary = tempfile.mkstemp(prefix=".ocv5-log-policy-", dir=staging)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fchown(stream.fileno(), uid, gid)
        os.fchmod(stream.fileno(), 0o644)
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fsync_directory(path.parent)
    if staging != path.parent:
        fsync_directory(staging)


def install_policy(root, files, evidence):
    if root == Path("/") and os.geteuid() != 0:
        raise ValueError("production installation requires root")
    evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
    attempt = Path(tempfile.mkdtemp(prefix="install-", dir=evidence))
    expected = expected_installed(files, root)
    previous = {}
    # Prevalidate installed paths too, without following any symlink.
    for path in expected:
        if path.exists() or path.is_symlink():
            previous[path] = regular_bytes(path)
    uid, gid = (0, 0) if root == Path("/") else (os.geteuid(), os.getegid())
    with scan_logs(root) as (records, missing, invalid):
        if invalid or any(info.st_uid != uid for _, _, info in records):
            raise ValueError("invalid log identity; no installation performed")
        dry_run_view(root, files, attempt)
        backup = attempt / "backup"
        backup.mkdir(mode=0o700)
        for path, data in previous.items():
            write_private(backup / path.name, data)
        repair_open_logs(root, records, missing, invalid, uid, gid)
        for path, data in expected.items():
            install_file(path, data, uid, gid)
    result = check_policy(root, files)
    result["evidenceDir"] = str(attempt)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["validate", "check", "install"])
    parser.add_argument("--bundle-root", type=Path, required=True)
    parser.add_argument("--fixture-root", type=Path)
    parser.add_argument("--fixture-only", action="store_true")
    parser.add_argument("--evidence-dir", type=Path)
    args = parser.parse_args()
    if bool(args.fixture_root) != args.fixture_only:
        parser.error("fixture root and fixture-only must be supplied together")
    root = args.fixture_root.resolve() if args.fixture_root else Path("/")
    if args.fixture_only and root == Path("/"):
        parser.error("fixture root must be private, never /")
    if args.fixture_only and args.evidence_dir and not args.evidence_dir.resolve().is_relative_to(root):
        parser.error("fixture evidence must stay in its private root")
    try:
        files = bundle_files(args.bundle_root)
        if args.mode == "validate":
            result = {"status": "PASS", "generation": 1, "bundleFiles": len(files)}
        elif args.mode == "check":
            result = check_policy(root, files)
        else:
            if not args.evidence_dir:
                parser.error("installation requires a persistent evidence directory")
            result = install_policy(root, files, args.evidence_dir)
        print(json.dumps(result))
        return 0 if result["status"] == "PASS" else 1
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "FAIL", "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
