# shellcheck shell=bash
# OCV5-600: recognise the selfhost PG backup as the holder of the deploy lock.
#
# scripts/v5-selfhost-pg-backup.sh holds the selfhost deploy lock (shared) for its whole run and
# writes <lock>.backup with "pid=<pid> starttime=<proc starttime> tier=<tier> started=<iso>".
# deploy-v5-selfhost.sh acquire_selfhost_deploy_lock uses this to queue behind a running backup
# (outside its plain timeout) instead of timing out. Needs proc_starttime_of from the caller.

# selfhost_backup_lock_holder <lock>: the marker counts only when the pid is alive, its /proc
# starttime matches (PID reuse) and its cmdline is the backup script (stale or forged file).
# Prints the marker line and returns 0; returns 1 otherwise.
selfhost_backup_lock_holder() {
  local marker="${1}.backup" line pid st cur
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  line="$(head -n1 -- "$marker" 2>/dev/null)" || return 1
  [[ "$line" =~ ^pid=([0-9]+)\ starttime=([0-9]+)\  ]] || return 1
  pid="${BASH_REMATCH[1]}"; st="${BASH_REMATCH[2]}"
  cur="$(proc_starttime_of "$pid" 2>/dev/null)" || return 1
  [[ "$cur" == "$st" ]] || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'v5-selfhost-pg-backup\.sh' || return 1
  printf '%s' "$line"
}
