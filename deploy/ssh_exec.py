#!/usr/bin/env python3
"""Run a shell command on the VPS and print output."""
import os
import sys
from pathlib import Path

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
    cmd = sys.argv[1]
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=20)
    _, stdout, stderr = client.exec_command(cmd, get_pty=False)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    rc = stdout.channel.recv_exit_status()
    if out:
        sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    client.close()
    sys.exit(rc)


if __name__ == "__main__":
    main()
