#!/bin/sh
# oc-browser — per-Agent launcher for the pinned official Playwright CLI.
#
# Agent path: browser Skill -> Bash -> playwright-cli. There is no custom
# browser command translation and no @playwright/mcp stdio transport. Keep the
# stable oc-browser name for product cards while isolating official CLI state.
set -eu

SELF="$(readlink -f "$0")"
# Bundle revision pin invariant shared by platform-runtime tools.
SELF_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

die() {
  echo "oc-browser: $*" >&2
  exit 2
}

is_positive_integer() {
  case "$1" in
    ''|*[!0-9]*|0) return 1 ;;
    *) return 0 ;;
  esac
}

reap_idle_session() {
  state_dir="$1"
  lock_file="$2"
  activity_file="$3"
  pid_file="$4"
  browser_home="$5"
  cache_home="$6"
  session_name="$7"
  idle_seconds="$8"
  poll_seconds="$9"
  cli_bin="${10}"
  config_file="${11}"

  while sleep "$poll_seconds"; do
    exec 9>"$lock_file"
    flock -x 9
    if [ ! -f "$activity_file" ]; then
      if [ "$(cat "$pid_file" 2>/dev/null || true)" = "$$" ]; then rm -f "$pid_file"; fi
      flock -u 9
      exec 9>&-
      exit 0
    fi
    pending_live=0
    for pending in "$state_dir"/pending.*; do
      [ -e "$pending" ] || continue
      pending_pid="${pending##*.}"
      if is_positive_integer "$pending_pid" && kill -0 "$pending_pid" 2>/dev/null; then
        pending_live=1
      else
        rm -f "$pending"
      fi
    done
    if [ "$pending_live" -eq 1 ]; then
      flock -u 9
      exec 9>&-
      continue
    fi
    now="$(date +%s)"
    last="$(stat -c %Y "$activity_file" 2>/dev/null || echo 0)"
    if [ $((now - last)) -lt "$idle_seconds" ]; then
      flock -u 9
      exec 9>&-
      continue
    fi

    # Keep the reaper lock, but never leak FD9 into the official CLI daemon or
    # Chromium descendants; otherwise all future calls would deadlock.
    (
      cd "$browser_home"
      unset PLAYWRIGHT_MCP_CDP_ENDPOINT PLAYWRIGHT_MCP_CDP_HEADERS \
        PLAYWRIGHT_MCP_CDP_TIMEOUT PLAYWRIGHT_MCP_EXTENSION \
        PLAYWRIGHT_MCP_STORAGE_STATE PLAYWRIGHT_MCP_USER_DATA_DIR
      XDG_CACHE_HOME="$cache_home" PLAYWRIGHT_CLI_SESSION="$session_name" \
        PLAYWRIGHT_MCP_CONFIG="$config_file" \
        "$cli_bin" close 9>&- >/dev/null 2>&1 || true
    )
    rm -f "$activity_file"
    if [ "$(cat "$pid_file" 2>/dev/null || true)" = "$$" ]; then rm -f "$pid_file"; fi
    rmdir "$state_dir" 2>/dev/null || true
    flock -u 9
    exec 9>&-
    exit 0
  done
}

# Private detached entry used only by this launcher.
if [ "${1:-}" = "__openclaude_reap" ]; then
  [ "$#" -eq 12 ] || exit 2
  shift
  reap_idle_session "$@"
  exit 0
fi

raw_agent_id="${OPENCLAUDE_AGENT_ID:-${OC_AGENT_ID:-}}"
[ -n "$(printf '%s' "$raw_agent_id" | tr -d '[:space:]')" ] \
  || die "Agent identity is unavailable"
agent_prefix="$(printf '%s' "$raw_agent_id" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-32)"
[ -n "$agent_prefix" ] || agent_prefix=agent
agent_hash="$(printf '%s' "$raw_agent_id" | sha256sum | cut -c1-16)"
agent_key="${agent_prefix}-${agent_hash}"

# Reject every escape hatch that could create/control another session or attach
# to an external browser. Scan the complete argv, including after `--`.
for arg in "$@"; do
  case "$arg" in
    -s|-s*|--session|--session=*|--profile|--profile=*|--config|--config=*)
      die "session/profile/config overrides are managed by OpenClaude"
      ;;
  esac
done

command=""
for arg in "$@"; do
  [ -n "$command" ] && break
  case "$arg" in
    --json|--raw|--help|--version|-h|-v|--) ;;
    -*) ;;
    *) command="$arg" ;;
  esac
done
case "$command" in
  kill-all|close-all|attach|detach)
    die "command '$command' is unavailable in an isolated Agent browser"
    ;;
esac

browser_home="${OPENCLAUDE_HOME:-/home/agent/.openclaude}"
[ -d "$browser_home" ] || die "browser workspace is unavailable: $browser_home"
state_dir="/tmp/openclaude-playwright-cli/$agent_key"
cache_home="$state_dir/cache"
lock_file="$state_dir/activity.lock"
activity_file="$state_dir/activity"
pid_file="$state_dir/reaper.pid"
session_name=browser
cli_bin=/usr/local/bin/playwright-cli
[ -x "$cli_bin" ] || die "pinned Playwright CLI is unavailable"
config_file=/etc/openclaude/playwright-cli.config.json
[ -r "$config_file" ] || die "pinned Playwright CLI config is unavailable"

idle_seconds="${OPENCLAUDE_PLAYWRIGHT_CLI_IDLE_SECONDS:-1800}"
poll_seconds="${OPENCLAUDE_PLAYWRIGHT_CLI_POLL_SECONDS:-30}"
is_positive_integer "$idle_seconds" || die "invalid idle timeout"
is_positive_integer "$poll_seconds" || die "invalid reaper poll interval"

umask 077
mkdir -p "$cache_home"
track_activity=1
case "$command" in
  ''|list|close|delete-data) track_activity=0 ;;
esac
# Record a waiting command before it blocks on another browser action. The
# reaper's lock-protected second check will then preserve the active session.
if [ "$track_activity" -eq 1 ]; then touch "$activity_file"; fi
pending_file="$state_dir/pending.$$"
: >"$pending_file"
trap 'rm -f "$pending_file"' EXIT
trap 'exit 130' HUP INT TERM
exec 9>"$lock_file"
while ! flock -n 9; do
  if [ "$track_activity" -eq 1 ]; then touch "$activity_file"; fi
  sleep 1
done
rm -f "$pending_file"
if [ "$track_activity" -eq 1 ]; then touch "$activity_file"; fi

reaper_pid="$(cat "$pid_file" 2>/dev/null || true)"
if [ "$track_activity" -eq 1 ] && \
  { ! is_positive_integer "$reaper_pid" || ! kill -0 "$reaper_pid" 2>/dev/null; }; then
  # Register the singleton while holding the lock. 9>&- ensures the detached
  # child opens the lock independently instead of inheriting ownership.
  setsid "$SELF" __openclaude_reap \
    "$state_dir" "$lock_file" "$activity_file" "$pid_file" \
    "$browser_home" "$cache_home" "$session_name" \
    "$idle_seconds" "$poll_seconds" "$cli_bin" "$config_file" \
    9>&- </dev/null >/dev/null 2>&1 &
  printf '%s\n' "$!" >"$pid_file"
fi

set +e
(
  cd "$browser_home"
  unset PLAYWRIGHT_MCP_CDP_ENDPOINT PLAYWRIGHT_MCP_CDP_HEADERS \
    PLAYWRIGHT_MCP_CDP_TIMEOUT PLAYWRIGHT_MCP_EXTENSION \
    PLAYWRIGHT_MCP_STORAGE_STATE PLAYWRIGHT_MCP_USER_DATA_DIR
  XDG_CACHE_HOME="$cache_home" PLAYWRIGHT_CLI_SESSION="$session_name" \
    PLAYWRIGHT_MCP_CONFIG="$config_file" \
    "$cli_bin" "$@" 9>&-
)
status=$?
set -e

case "$command" in
  close|delete-data) rm -f "$activity_file" ;;
esac
flock -u 9
exec 9>&-
exit "$status"
