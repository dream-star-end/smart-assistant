#!/usr/bin/env python3
"""Deploy a single file to the VPS and run a remote command."""
import os
import sys
from pathlib import Path

# Auto-load .env from deploy directory
_env_file = Path(__file__).parent / '.env'
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

import paramiko

HOST = os.environ.get("DEPLOY_HOST", "127.0.0.1")
PORT = int(os.environ.get("DEPLOY_PORT", "2222"))
USER = "root"
PASSWORD = os.environ["DEPLOY_PASSWORD"]


def main():
    local = sys.argv[1]
    remote = sys.argv[2]
    cmd = sys.argv[3] if len(sys.argv) > 3 else None

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=20)
    print(f"[ok] connected to {HOST}:{PORT}")

    sftp = client.open_sftp()
    sftp.put(local, remote)
    st = sftp.stat(remote)
    print(f"[ok] uploaded {local} -> {remote} ({st.st_size} bytes)")
    sftp.close()

    if cmd:
        print(f"[run] {cmd}")
        _, stdout, stderr = client.exec_command(cmd, get_pty=True)
        out = stdout.read().decode(errors="replace")
        err = stderr.read().decode(errors="replace")
        rc = stdout.channel.recv_exit_status()
        if out:
            print(out)
        if err:
            print("[stderr]", err)
        print(f"[rc] {rc}")

    client.close()


if __name__ == "__main__":
    main()
