#!/usr/bin/env bash
# M7/P1-10 — One-time bootstrap of the SSH-pull backup endpoint on a v3 VM.
#
# Run on the v3 VM as root. Idempotent.
#
# Inputs:
#   PULL_PUBKEY  — required, ed25519 public key from 45.32 (single line, ssh-ed25519 ...)
#   PULL_FROM_IP — required, source IP of 45.32 (for from= restriction in authorized_keys)
#
# What it does (idempotent):
#   1. useradd backup-pull (system, no home creation needed at /home/backup-pull,
#      but we create the .ssh dir ourselves)
#   2. install backup-pull-cmd (root:root 0755) and backup-pull-wrapper (backup-pull:backup-pull 0755)
#   3. install /etc/sudoers.d/backup-pull and visudo -cf check
#   4. install /home/backup-pull/.ssh/authorized_keys with from= and forced command
#   5. NOT touched here: pg-backup-openclaude.sh's runuser switch (separate script)
#
# Re-run safety: existing files diffed; user/sudoers/authorized_keys overwritten
# atomically (.tmp + mv).

set -euo pipefail
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2; exit 2
fi

if [ -z "${PULL_PUBKEY:-}" ] || [ -z "${PULL_FROM_IP:-}" ]; then
  cat >&2 <<USAGE
Usage:
  PULL_PUBKEY="ssh-ed25519 AAAA... 45.32-pull" \\
  PULL_FROM_IP="45.32.41.166" \\
  bash setup-v3-backup-pull.sh

Inputs:
  PULL_PUBKEY  — ed25519 pubkey from 45.32 backup-pull keypair
  PULL_FROM_IP — source IP for from= restriction

This script must run on the v3 commercial VM.
USAGE
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER_SRC="$SCRIPT_DIR/backup-pull-wrapper.sh"
HELPER_SRC="$SCRIPT_DIR/backup-pull-cmd.sh"

if [ ! -f "$WRAPPER_SRC" ] || [ ! -f "$HELPER_SRC" ]; then
  echo "missing source: $WRAPPER_SRC or $HELPER_SRC" >&2
  exit 3
fi

USER=backup-pull
HOME_DIR=/home/backup-pull

echo "[1/5] ensure system user $USER"
# Shell is /bin/bash (NOT /usr/sbin/nologin): nologin rejects SSH even when
# authorized_keys has a forced command. Security boundary is enforced by
# `restrict,command="..."` in authorized_keys + sudoers (not by login shell).
if id "$USER" >/dev/null 2>&1; then
  echo "      $USER exists, ensuring shell is /bin/bash"
  usermod --shell /bin/bash "$USER"
else
  useradd --system --shell /bin/bash --home-dir "$HOME_DIR" --create-home "$USER"
fi

# 防 useradd 老版本不创建 home
install -d -m 700 -o "$USER" -g "$USER" "$HOME_DIR"
install -d -m 700 -o "$USER" -g "$USER" "$HOME_DIR/.ssh"

echo "[2/5] install root helper /usr/local/bin/backup-pull-cmd (root:root 0755)"
install -m 0755 -o root -g root "$HELPER_SRC" /usr/local/bin/backup-pull-cmd

echo "[3/5] install wrapper /usr/local/bin/backup-pull-wrapper (root:root 0755)"
# Wrapper 是 SSH trust boundary 的一部分,backup-pull 用户只需 execute,不该有 write。
# Codex M7 code review BLOCKING #2.
install -m 0755 -o root -g root "$WRAPPER_SRC" /usr/local/bin/backup-pull-wrapper

echo "[4/5] install sudoers /etc/sudoers.d/backup-pull"
SUDO_TMP="$(mktemp /tmp/backup-pull-sudoers.XXXXXX)"
trap 'rm -f "$SUDO_TMP" 2>/dev/null || true' EXIT
cat > "$SUDO_TMP" <<'SUDOERS'
# M7/P1-10 — backup-pull user can run **only** the helper as root, no password.
# Wrapper passes verb as argv ($1 in helper); we do NOT keep SSH_ORIGINAL_COMMAND
# in env. Helper re-anchors validation.
backup-pull ALL=(root) NOPASSWD: /usr/local/bin/backup-pull-cmd
SUDOERS
chmod 0440 "$SUDO_TMP"
chown root:root "$SUDO_TMP"
visudo -cf "$SUDO_TMP" >/dev/null
mv -f "$SUDO_TMP" /etc/sudoers.d/backup-pull

echo "[5/5] install $HOME_DIR/.ssh/authorized_keys"
AK_TMP="$(mktemp "$HOME_DIR/.ssh/.authorized_keys.XXXXXX")"
chmod 600 "$AK_TMP"
chown "$USER:$USER" "$AK_TMP"
# from= IP restriction + restrict (no PTY/X11/agent/port-forward) + forced command
printf 'from="%s",restrict,command="/usr/local/bin/backup-pull-wrapper" %s\n' \
  "$PULL_FROM_IP" "$PULL_PUBKEY" > "$AK_TMP"
mv -f "$AK_TMP" "$HOME_DIR/.ssh/authorized_keys"

echo
echo "=== setup complete ==="
echo "From 45.32 verify with:"
echo "  ssh -i /root/.ssh/v3-backup-pull -o UserKnownHostsFile=/root/.ssh/known_hosts.v3-pull \\"
echo "      -o StrictHostKeyChecking=yes backup-pull@<v3-ip> info"
