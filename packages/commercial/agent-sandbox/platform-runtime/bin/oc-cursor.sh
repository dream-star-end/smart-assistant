#!/bin/sh
# oc-cursor — account-scoped launcher for the pinned official Cursor Agent CLI.
#
# This is deliberately a one-shot print-mode tool rather than a V5 model
# engine. The host credential is mounted only into the explicitly authorized
# user's container and never enters Docker Env, the image, or the repository.
set -eu

SELF_ROOT=$(/usr/bin/dirname "$(/usr/bin/readlink -f "$0")")
[ -d "$SELF_ROOT" ] || exit 2

die() {
  echo "oc-cursor: $*" >&2
  exit 2
}

usage() {
  cat <<'EOF'
usage: oc-cursor [--model MODEL] [--mode ask|plan] [--force] -- PROMPT...

Runs one pinned Cursor Agent CLI task in the current workspace and emits the
official stream-json event sequence unchanged.
EOF
}

cursor_bin=/opt/cursor-agent/versions/2026.08.11-e8db854/cursor-agent
auth_file=/run/oc/cursor-auth/api-key
[ -x "$cursor_bin" ] || die "pinned Cursor Agent CLI is unavailable"
[ -e "$auth_file" ] || die "Cursor CLI is not enabled for this account"

model=""
mode=""
force=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model)
      [ "$#" -ge 2 ] || die "--model requires a value"
      model=$2
      [ -n "$model" ] || die "--model requires a value"
      shift 2
      ;;
    --model=*)
      model=${1#--model=}
      [ -n "$model" ] || die "--model requires a value"
      shift
      ;;
    --mode)
      [ "$#" -ge 2 ] || die "--mode requires ask or plan"
      mode=$2
      case "$mode" in ask|plan) ;; *) die "--mode requires ask or plan" ;; esac
      shift 2
      ;;
    --mode=*)
      mode=${1#--mode=}
      case "$mode" in ask|plan) ;; *) die "--mode requires ask or plan" ;; esac
      shift
      ;;
    --force)
      force=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    --api-key|--api-key=*|-e|--endpoint|--endpoint=*|-H|--header|--header=*|\
    --output-format|--output-format=*|--workspace|--workspace=*|--trust|\
    --resume|--resume=*|--continue|-w|--worktree|--worktree=*|--add-dir|\
    --add-dir=*|--plugin-dir|--plugin-dir=*|--approve-mcps|--sandbox|--sandbox=*)
      die "authentication, endpoint, workspace, session and output controls are managed by OpenClaude"
      ;;
    -*)
      die "unsupported option: $1"
      ;;
    *)
      break
      ;;
  esac
done
[ "$#" -gt 0 ] || die "a prompt is required"

workspace=$(pwd -P)
[ -d "$workspace" ] || die "current workspace is unavailable"

# The host source is root:root 0400/0600. The container agent has sudo by
# product design, but only the explicitly authorized user's container gets the
# bind mount. Never print the value or put it in argv.
api_key=$(/usr/bin/sudo -n /bin/cat -- "$auth_file" 2>/dev/null) \
  || die "Cursor credential mount is unreadable"
[ -n "$api_key" ] || die "Cursor credential is malformed"
carriage_return=$(printf '\r')
case "$api_key" in
  *"
"*|*"$carriage_return"*) die "Cursor credential is malformed" ;;
esac

umask 077
cursor_home=$(/usr/bin/mktemp -d /tmp/openclaude-cursor.XXXXXXXX) \
  || die "cannot create ephemeral Cursor state"
child_pid=""

cleanup() {
  # Cursor may return while a tool subprocess is still alive. Every process in
  # the session inherits CURSOR_API_KEY, so do not let descendants outlive the
  # one-shot wrapper on either normal completion or Stop.
  if [ -n "$child_pid" ] && /bin/kill -0 -- "-$child_pid" 2>/dev/null; then
    /bin/kill -TERM -- "-$child_pid" 2>/dev/null || true
    attempts=0
    while [ "$attempts" -lt 20 ] && /bin/kill -0 -- "-$child_pid" 2>/dev/null; do
      /bin/sleep 0.05
      attempts=$((attempts + 1))
    done
    /bin/kill -KILL -- "-$child_pid" 2>/dev/null || true
  fi
  if [ -n "$child_pid" ]; then
    wait "$child_pid" 2>/dev/null || true
  fi
  /bin/rm -rf -- "$cursor_home"
}

forward_signal() {
  signal=$1
  code=$2
  trap - HUP INT TERM
  if [ -n "$child_pid" ]; then
    /bin/kill -"$signal" -- "-$child_pid" 2>/dev/null || true
  fi
  exit "$code"
}

trap cleanup EXIT
trap 'forward_signal HUP 129' HUP
trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM

prompt=$1
shift
for word in "$@"; do
  prompt="$prompt $word"
done
set -- -p --trust --workspace "$workspace" \
  --output-format stream-json --stream-partial-output -- "$prompt"
[ -z "$model" ] || set -- --model "$model" "$@"
[ -z "$mode" ] || set -- --mode "$mode" "$@"
[ "$force" -eq 0 ] || set -- --force "$@"

# setsid gives the CLI and every tool child one process group so Stop cannot
# leave a shell command running after the wrapper exits. HOME is per-call and
# deleted on every exit, including Cursor's generated auth.json/JWT state.
set +e
HOME="$cursor_home" \
XDG_CONFIG_HOME="$cursor_home/.config" \
CURSOR_AGENT_DISABLE_DEBUG_LOG=1 \
CURSOR_API_KEY="$api_key" \
/usr/bin/setsid "$cursor_bin" "$@" &
child_pid=$!
wait "$child_pid"
status=$?
set -e

# Shorten the lifetime of the shell copy before EXIT removes the temp HOME.
api_key=""
exit "$status"
