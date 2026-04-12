#!/usr/bin/env python3
"""Deploy a single file to the VPS and run a remote command."""
import os
import sys
import paramiko

HOST = "45.32.41.166"
PORT = 2222
USER = "root"
PASSWORD = "w,A6%[pWNu3c2[7]"


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
