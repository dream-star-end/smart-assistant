#!/usr/bin/env python3
"""Run a local shell script on the VPS via SSH stdin."""
import sys
import io
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

HOST = "45.32.41.166"
PORT = 2222
USER = "root"
PASSWORD = "w,A6%[pWNu3c2[7]"


def main():
    script_path = sys.argv[1]
    with open(script_path, "rb") as f:
        script = f.read().decode("utf-8")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=20)

    stdin, stdout, stderr = client.exec_command("bash -s", get_pty=False)
    stdin.write(script)
    stdin.channel.shutdown_write()
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
