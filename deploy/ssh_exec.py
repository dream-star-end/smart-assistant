#!/usr/bin/env python3
"""Run a shell command on the VPS and print output."""
import sys
import paramiko

HOST = "45.32.41.166"
PORT = 2222
USER = "root"
PASSWORD = "w,A6%[pWNu3c2[7]"


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
