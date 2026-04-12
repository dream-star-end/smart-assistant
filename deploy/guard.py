#!/usr/bin/env python3
"""
OpenClaude security guard — PreToolUse hook for CCB.

Called before Bash / Write / Edit / MultiEdit tool invocations.
Reads the tool call as JSON on stdin, emits a JSON decision on stdout.

Philosophy: default-allow, deny-list a narrow set of truly dangerous
operations. The allowlist would be impossible to enumerate for a
general-purpose assistant; a blocklist catches the handful of things
that would actually destroy the host or exfiltrate credentials.

Blocked categories:
  Bash:
    1. rm -rf of filesystem root or protected dirs
    2. System power control (shutdown, reboot, halt)
    3. Filesystem destruction (mkfs, dd to disk, wipefs, fdisk)
    4. Disabling own infrastructure (systemctl stop openclaude/cloudflared/ssh)
    5. Reading credential files (.env, *.key, authorized_keys, settings.json)
    6. Exfiltrating secrets via network (curl/wget with $API_KEY)
    7. Modifying SSH authorized_keys
    8. Persistence (crontab -e, writes to /etc/cron*, /etc/systemd/)
    9. Firewall changes (iptables/ufw/nft)
   10. User account manipulation (useradd/userdel/passwd)
   11. Fork bomb / resource exhaustion
   12. sudo / su escalation

  Write/Edit/MultiEdit:
    13. Writing to /etc/, /boot/, /usr/(bin|sbin|lib)/, /sys/, /proc/
    14. Writing to /root/.ssh/
    15. Writing to OpenClaude's own credential/config files

Everything else is allowed. Deliberately permissive for:
  - Reading most files (even in /root, /etc except explicit protect list)
  - Writing to /tmp, $HOME, project dirs
  - Network fetch of non-sensitive data
  - git operations
  - package manager ops (npm, apt-get install for new tools)
  - Running scripts
"""

import json
import os
import re
import sys
import time
import uuid


# ── Bash command denials ─────────────────────────────────────────────────
DENY_BASH_PATTERNS = [
    # rm -rf variants targeting dangerous roots
    (
        r"\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+(/\s*$|/\s|/\*|\s+/\s|--no-preserve-root)",
        "rm -rf filesystem root",
    ),
    (
        r"\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+(/etc|/boot|/root/\.ssh|/root/\.claude(\b|/)|/root/\.openclaude|/var/lib|/usr(/bin|/sbin|/lib|/lib64|/local)?|/lib(/|$)|/lib64|/sys|/proc)(\b|/|$)",
        "rm -rf of protected directory",
    ),
    # System power control
    (r"\b(shutdown|poweroff|halt|reboot|init\s+0|init\s+6)\b", "system power control"),
    # Filesystem destruction
    (r"\bmkfs(\.[a-z0-9]+)?\s", "mkfs (format filesystem)"),
    (r"\bdd\s+[^|;]*of=/dev/[sn][a-z]", "dd to raw disk device"),
    (r"\b(wipefs|fdisk|parted|sfdisk)\s", "disk partition tool"),
    # Disabling own infrastructure
    (
        r"systemctl\s+(stop|disable|mask|kill)\s+(openclaude|cloudflared|ssh|sshd|systemd-networkd|networking)(\.service)?",
        "disabling openclaude/network/ssh",
    ),
    # Credential file reads — very conservative, only the most common sensitive paths
    (
        r"\bcat\s+[^|;<>&\n]*(/\.env\b|/credentials(/|\b)|/authorized_keys\b|/id_rsa\b|/id_ed25519\b|/\.pgpass\b|/\.netrc\b|\.pem\s|\.key\s|/root/\.claude/settings\.json|/root/\.openclaude/openclaude\.json|/root/\.openclaude/credentials)",
        "reading credential/secret file",
    ),
    (
        r"\b(head|tail|less|more|xxd|od|strings)\s+[^|;<>&\n]*(/\.env\b|/authorized_keys\b|/id_rsa\b|/id_ed25519\b|/root/\.claude/settings\.json|/root/\.openclaude/openclaude\.json|/root/\.openclaude/credentials)",
        "reading credential/secret file",
    ),
    # Exfiltration via network with env credentials
    (
        r"(curl|wget|nc|ncat|netcat|socat|http|fetch)\s+[^|;<>&\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)",
        "exfiltrating env credential over network",
    ),
    (
        r"(curl|wget|nc|ncat|netcat|socat)\s+[^|;<>&\n]*(\.env|id_rsa|id_ed25519|authorized_keys|settings\.json|credentials)",
        "sending credential file over network",
    ),
    # SSH authorized_keys modification
    (r">>?\s*[^|;<>&\n]*authorized_keys", "modifying SSH authorized_keys"),
    (r"\bssh-keygen\s+.*-f\s+[^|;]*authorized_keys", "writing to authorized_keys via ssh-keygen"),
    # Persistence via cron / systemd
    (r"\bcrontab\s+(-e|-u|-r|-l\s+-u)", "crontab editing"),
    (r">>?\s*/etc/(crontab|cron\.|systemd/|rc\.local|profile\.d/|sudoers)", "writing to system persistence file"),
    (r">>?\s*/etc/(passwd|shadow|gshadow|sudoers)", "writing to auth file"),
    # Firewall changes
    (r"\b(iptables|ip6tables|ufw|firewalld|firewall-cmd|nft)\s+(-[A-Z]|--[a-z])", "firewall rule change"),
    # User account manipulation
    (r"\b(useradd|userdel|usermod|groupadd|groupdel|groupmod|passwd)\s+\w", "user/group account change"),
    # Fork bomb
    (r":\s*\(\s*\)\s*\{.*\|\s*:[\s&]", "fork bomb pattern"),
    # Privilege escalation — we're already root, but block just in case user lowers the account later
    (r"(^|[\s;&|])(sudo|doas)\s+(-[A-Z]|\w)", "sudo/doas privilege escalation"),
    # Kernel module manipulation
    (r"\b(insmod|rmmod|modprobe)\s+\w", "kernel module manipulation"),
    # BPF / ptrace
    (r"\bbpftool\s", "bpftool (kernel tracing)"),
    # Self-destruct of the openclaude install itself
    (r"\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+/opt/openclaude", "destroying OpenClaude install"),
]

# ── File write path denials ──────────────────────────────────────────────
DENY_WRITE_PATH_PATTERNS = [
    r"^/etc(/|$)",
    r"^/boot(/|$)",
    r"^/usr/(bin|sbin|lib|lib64|local/bin|local/sbin)(/|$)",
    r"^/var/(lib|log/(auth\.log|secure))",
    r"^/root/\.ssh(/|$)",
    r"^/root/\.claude/settings\.json$",
    r"^/root/\.claude\.json$",
    r"^/root/\.openclaude/credentials(/|$)",
    r"^/root/\.openclaude/openclaude\.json$",
    r"^/lib(32|64)?(/|$)",
    r"^/sys(/|$)",
    r"^/proc(/|$)",
    r"^/dev/(sd|nvme|mmcblk|vd|xvd)[a-z]",
    r"/authorized_keys$",
    r"/id_rsa$",
    r"/id_ed25519$",
    r"/\.env$",
]


def deny(reason: str, detail: str = "") -> None:
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"openclaude-guard: {reason}"
            + (f" — {detail}" if detail else ""),
        },
    }
    print(json.dumps(out))
    sys.exit(0)


def allow(note: str = "") -> None:
    # Return explicit allow with the user's note so the agent knows it was approved
    if note:
        out = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": f"user approved: {note}",
            },
        }
        print(json.dumps(out))
    sys.exit(0)


def ask_user(
    tool_name: str,
    tool_input: dict,
    reason: str,
    detail: str,
    timeout_s: float = 180.0,
) -> None:
    """Write a pending request file the gateway will pick up, then poll for
    the decision file. Exits via deny() or allow().

    Only called when OPENCLAUDE_PENDING_DIR is set and points at a writable dir.
    For cron / non-interactive contexts the env is left unset and guard directly
    denies instead.
    """
    pending_dir = os.environ.get("OPENCLAUDE_PENDING_DIR", "").strip()
    agent_id = os.environ.get("OPENCLAUDE_AGENT_ID", "unknown")
    session_key = os.environ.get("OPENCLAUDE_SESSION_KEY", "")

    # No relay target — fall back to direct deny
    if not pending_dir:
        deny(reason, detail)
        return

    try:
        os.makedirs(pending_dir, exist_ok=True)
    except Exception:
        deny(reason, detail)
        return

    req_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    req_path = os.path.join(pending_dir, f"{req_id}.req.json")
    resp_path = os.path.join(pending_dir, f"{req_id}.resp.json")

    # Build a short human-readable summary for the UI
    if tool_name == "Bash":
        cmd = str(tool_input.get("command", ""))
        summary = cmd if len(cmd) <= 400 else cmd[:400] + "…"
    elif tool_name in ("Write", "Edit", "MultiEdit"):
        path = str(tool_input.get("file_path") or tool_input.get("path") or "")
        summary = path
    else:
        summary = json.dumps(tool_input)[:400]

    payload = {
        "reqId": req_id,
        "agentId": agent_id,
        "sessionKey": session_key,
        "toolName": tool_name,
        "toolInput": tool_input,
        "reason": reason,
        "detail": detail,
        "summary": summary,
        "ts": int(time.time() * 1000),
    }
    try:
        tmp_path = req_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.rename(tmp_path, req_path)
    except Exception:
        deny(reason, detail)
        return

    # Poll for the decision file
    deadline = time.time() + timeout_s
    decision = None
    user_note = ""
    while time.time() < deadline:
        if os.path.exists(resp_path):
            try:
                with open(resp_path, "r", encoding="utf-8") as f:
                    resp = json.load(f)
                decision = resp.get("decision", "deny")
                user_note = resp.get("note", "") or resp.get("reason", "")
                break
            except Exception:
                pass
        time.sleep(0.25)

    # Cleanup
    for p in (req_path, resp_path):
        try:
            os.remove(p)
        except OSError:
            pass

    if decision == "allow":
        allow(user_note or f"user approved {tool_name}")
    elif decision == "allow_always":
        # For now treat as one-time allow. Future: persist rule.
        allow((user_note or "user approved (remember in future)"))
    else:
        if decision is None:
            deny(f"timeout waiting for user decision ({reason})", detail)
        else:
            deny(
                f"user denied ({reason})" + (f": {user_note}" if user_note else ""),
                detail,
            )


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception as e:
        # Hook failure is non-fatal — let the tool run
        sys.stderr.write(f"guard: bad stdin json: {e}\n")
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input") or {}

    if tool_name == "Bash":
        cmd = str(tool_input.get("command", ""))
        for pattern, reason in DENY_BASH_PATTERNS:
            try:
                if re.search(pattern, cmd, re.IGNORECASE):
                    ask_user(tool_name, tool_input, reason, cmd[:180])
            except re.error:
                continue
    elif tool_name in ("Write", "Edit", "MultiEdit"):
        path = str(tool_input.get("file_path") or tool_input.get("path") or "")
        for pattern in DENY_WRITE_PATH_PATTERNS:
            try:
                if re.search(pattern, path):
                    ask_user(tool_name, tool_input, "writing to protected path", path)
            except re.error:
                continue

    allow()


if __name__ == "__main__":
    main()
