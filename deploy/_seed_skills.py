#!/usr/bin/env python3
"""Deploy seed skills to the VPS."""
import os
import sys
import paramiko

HOST = "45.32.41.166"
PORT = 2222
USER = "root"
PASSWORD = "w,A6%[pWNu3c2[7]"
REMOTE_SKILLS = "/root/.openclaude/agents/main/skills"
LOCAL_SEEDS = os.path.join(os.path.dirname(__file__), "seeds", "skills")

def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=20)
    sftp = client.open_sftp()

    # Ensure remote skills dir exists
    try:
        sftp.stat(REMOTE_SKILLS)
    except FileNotFoundError:
        stdin, stdout, stderr = client.exec_command(f"mkdir -p {REMOTE_SKILLS}")
        stdout.channel.recv_exit_status()

    uploaded = 0
    for skill_name in os.listdir(LOCAL_SEEDS):
        skill_dir = os.path.join(LOCAL_SEEDS, skill_name)
        if not os.path.isdir(skill_dir):
            continue
        skill_md = os.path.join(skill_dir, "SKILL.md")
        if not os.path.exists(skill_md):
            continue

        remote_dir = f"{REMOTE_SKILLS}/{skill_name}"
        remote_md = f"{remote_dir}/SKILL.md"

        # Create remote skill directory
        try:
            sftp.stat(remote_dir)
        except FileNotFoundError:
            stdin, stdout, stderr = client.exec_command(f"mkdir -p {remote_dir}")
            stdout.channel.recv_exit_status()

        sftp.put(skill_md, remote_md)
        st = sftp.stat(remote_md)
        print(f"[ok] {skill_name}/SKILL.md ({st.st_size} bytes)")
        uploaded += 1

    sftp.close()
    client.close()
    print(f"\n[done] {uploaded} skills deployed to {REMOTE_SKILLS}")

if __name__ == "__main__":
    main()
