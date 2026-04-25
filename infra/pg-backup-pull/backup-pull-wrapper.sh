#!/usr/bin/env bash
# M7/P1-10 — Forced-command wrapper for backup-pull SSH user.
#
# Authorized_keys: command="/usr/local/bin/backup-pull-wrapper" forces all SSH
# sessions for `backup-pull` to run this script regardless of what the client
# requested. The original client command is in $SSH_ORIGINAL_COMMAND.
#
# Job:
#   1. Strict whitelist of accepted SSH_ORIGINAL_COMMAND values
#   2. Pass the validated verb to root helper as argv (NOT env) so we don't
#      depend on sudo's env_keep behavior
#   3. exec sudo -n /usr/local/bin/backup-pull-cmd "$verb"
#
# Runs as: backup-pull user (system user, no shell)
# Exit codes: propagated from helper
set -euo pipefail
umask 077

cmd="${SSH_ORIGINAL_COMMAND:-}"

# Whitelist via bash glob (case pattern). Anchored by the case statement.
case "$cmd" in
  info)
    arg="info"
    ;;
  fetch=openclaude_commercial-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]Z.dump)
    # bash glob has matched: 8-digit YYYYMMDD - 6-digit HHMMSS Z .dump
    # No shell metacharacters can survive this match.
    arg="$cmd"
    ;;
  *)
    echo "ERR: denied" >&2
    exit 1
    ;;
esac

exec sudo -n /usr/local/bin/backup-pull-cmd "$arg"
