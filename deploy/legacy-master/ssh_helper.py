#!/usr/bin/env python3
"""
Remote SSH/SFTP helper for OpenClaude deployment.

Commands:
  python ssh_helper.py run "cmd..."                 — run remote command, stream output
  python ssh_helper.py put <local> <remote>         — upload a single file
  python ssh_helper.py put_dir <local_dir> <remote> — upload a directory recursively

Reads SSH credentials from env:
  SSH_HOST, SSH_USER, SSH_PASS, SSH_PORT (default 22)
"""
import os
import sys
import stat
import posixpath
from pathlib import Path
import paramiko

# Force UTF-8 on Windows GBK console
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HOST = os.environ.get("SSH_HOST")
USER = os.environ.get("SSH_USER", "root")
PASS = os.environ.get("SSH_PASS")
PORT = int(os.environ.get("SSH_PORT", "22"))

if not HOST or not PASS:
    print("error: SSH_HOST and SSH_PASS env vars required", file=sys.stderr)
    sys.exit(2)


def connect():
    import time
    last_err = None
    for attempt in range(5):
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(
                HOST,
                port=PORT,
                username=USER,
                password=PASS,
                timeout=30,
                banner_timeout=60,
                auth_timeout=30,
                look_for_keys=False,
                allow_agent=False,
            )
            return client
        except Exception as e:
            last_err = e
            if attempt < 4:
                time.sleep(2 + attempt * 2)
    raise last_err


def cmd_run(cmd: str) -> int:
    client = connect()
    try:
        stdin, stdout, stderr = client.exec_command(cmd, get_pty=False, timeout=None)
        # stream interleaved
        chan = stdout.channel
        out_buf = b""
        err_buf = b""
        while True:
            if chan.recv_ready():
                data = chan.recv(4096)
                if data:
                    sys.stdout.write(data.decode(errors="replace"))
                    sys.stdout.flush()
            if chan.recv_stderr_ready():
                data = chan.recv_stderr(4096)
                if data:
                    sys.stderr.write(data.decode(errors="replace"))
                    sys.stderr.flush()
            if chan.exit_status_ready() and not chan.recv_ready() and not chan.recv_stderr_ready():
                break
        # drain
        while chan.recv_ready():
            sys.stdout.write(chan.recv(4096).decode(errors="replace"))
        while chan.recv_stderr_ready():
            sys.stderr.write(chan.recv_stderr(4096).decode(errors="replace"))
        rc = chan.recv_exit_status()
        return rc
    finally:
        client.close()


def sftp_mkdirs(sftp, remote_dir: str):
    # Use posixpath so we never get Windows-style path weirdness on remote paths
    remote_dir = remote_dir.replace("\\", "/")
    parts = []
    p = remote_dir.rstrip("/")
    while p and p != "/":
        parts.append(p)
        parent = posixpath.dirname(p)
        if parent == p:
            break
        p = parent
    for d in reversed(parts):
        try:
            sftp.stat(d)
        except (FileNotFoundError, IOError):
            try:
                sftp.mkdir(d)
            except IOError:
                pass


def cmd_put(local: str, remote: str) -> int:
    remote = remote.replace("\\", "/")
    client = connect()
    try:
        sftp = client.open_sftp()
        try:
            rdir = posixpath.dirname(remote)
            if rdir:
                sftp_mkdirs(sftp, rdir)
            sftp.put(local, remote)
            print(f"uploaded {local} -> {remote}")
        finally:
            sftp.close()
        return 0
    finally:
        client.close()


def cmd_put_dir(local_dir: str, remote_dir: str, exclude=None) -> int:
    exclude = set(exclude or {
        "node_modules", ".git", ".openclaude-test", "dist", ".DS_Store", ".venv", "__pycache__",
    })
    remote_dir = remote_dir.replace("\\", "/").rstrip("/")
    client = connect()
    try:
        sftp = client.open_sftp()
        try:
            sftp_mkdirs(sftp, remote_dir)
            local_root = Path(local_dir).resolve()
            count = 0
            for p in local_root.rglob("*"):
                rel = p.relative_to(local_root)
                parts = set(rel.parts)
                if parts & exclude:
                    continue
                rpath = remote_dir + "/" + "/".join(rel.parts)
                if p.is_dir():
                    try:
                        sftp.stat(rpath)
                    except (FileNotFoundError, IOError):
                        try:
                            sftp.mkdir(rpath)
                        except IOError:
                            pass
                elif p.is_file():
                    rparent = posixpath.dirname(rpath)
                    try:
                        sftp.stat(rparent)
                    except (FileNotFoundError, IOError):
                        sftp_mkdirs(sftp, rparent)
                    sftp.put(str(p), rpath)
                    count += 1
                    if count % 20 == 0:
                        print(f"  ... {count} files uploaded", flush=True)
            print(f"upload complete: {count} files -> {remote_dir}")
        finally:
            sftp.close()
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    op = sys.argv[1]
    if op == "run":
        sys.exit(cmd_run(" ".join(sys.argv[2:])))
    elif op == "put":
        sys.exit(cmd_put(sys.argv[2], sys.argv[3]))
    elif op == "put_dir":
        sys.exit(cmd_put_dir(sys.argv[2], sys.argv[3]))
    elif op == "get":
        remote = sys.argv[2].replace("\\", "/")
        local = sys.argv[3]
        client = connect()
        try:
            sftp = client.open_sftp()
            try:
                sftp.get(remote, local)
                print(f"downloaded {remote} -> {local}")
            finally:
                sftp.close()
        finally:
            client.close()
        sys.exit(0)
    else:
        print(__doc__)
        sys.exit(1)
