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

# Absolute paths keep executable resolution off the user-writable PATH, which
# means a tool missing from the runtime image turns into a silent 127 instead
# of a visible failure. Assert the whole set up front rather than discovering
# it inside an `|| true` cleanup path.
for required_tool in /usr/bin/sudo /usr/bin/test /bin/cat /usr/bin/mktemp \
  /bin/rm /bin/sleep /usr/bin/setsid /usr/bin/stat /usr/bin/id /bin/mkdir \
  /bin/cp /bin/chmod /bin/mv; do
  [ -x "$required_tool" ] || die "runtime image is missing $required_tool"
done

cursor_bin=/opt/cursor-agent/versions/2026.08.11-e8db854/cursor-agent
auth_file=/run/oc/cursor-auth/api-key
[ -x "$cursor_bin" ] || die "pinned Cursor Agent CLI is unavailable"
/usr/bin/sudo -n /usr/bin/test -f "$auth_file" 2>/dev/null \
  || die "Cursor CLI is not enabled for this account"

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

case "$model" in
  ""|cursor-grok-4.6-high|composer-2.5-fast|claude-opus-5-thinking-high|\
  claude-fable-5-thinking-high|cursor-grok-4.5-high) ;;
  *) die "model is not allowlisted" ;;
esac

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

# `kill` must stay the shell builtin. On Debian /bin/kill belongs to procps,
# which the runtime image does not install, so an absolute path silently exits
# 127 and `|| true` swallows it: the CLI would then survive Stop, keep holding
# the gateway's stdout pipe and hang the turn in "stopping" forever. A builtin
# also cannot be shadowed through PATH. dash's builtin rejects the `--`
# separator, so the negated process group id is passed directly.
cleanup() {
  # Cursor may return while a tool subprocess is still alive. Every process in
  # the session inherits CURSOR_API_KEY, so do not let descendants outlive the
  # one-shot wrapper on either normal completion or Stop.
  if [ -n "$child_pid" ] && kill -0 "-$child_pid" 2>/dev/null; then
    kill -TERM "-$child_pid" 2>/dev/null || true
    attempts=0
    while [ "$attempts" -lt 20 ] && kill -0 "-$child_pid" 2>/dev/null; do
      /bin/sleep 0.05
      attempts=$((attempts + 1))
    done
    kill -KILL "-$child_pid" 2>/dev/null || true
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
    kill -"$signal" "-$child_pid" 2>/dev/null || true
  fi
  exit "$code"
}

trap cleanup EXIT
trap 'forward_signal HUP 129' HUP
trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM

# The gateway may provide one adapter-owned Cursor MCP config. Copy it into
# this invocation's ephemeral HOME only after strict source validation. The
# source remains gateway-owned and is never removed by this wrapper.
mcp_config=${OPENCLAUDE_CURSOR_MCP_CONFIG:-}
mcp_approval=0
if [ -n "$mcp_config" ]; then
  case "$mcp_config" in /*) ;; *) die "MCP config path must be absolute" ;; esac
  [ ! -L "$mcp_config" ] || die "MCP config must not be a symlink"
  [ -f "$mcp_config" ] || die "MCP config must be a regular file"
  config_uid=$(/usr/bin/stat -c %u -- "$mcp_config" 2>/dev/null) \
    || die "MCP config metadata is unavailable"
  current_uid=$(/usr/bin/id -u) || die "current uid is unavailable"
  [ "$config_uid" = "$current_uid" ] || die "MCP config owner is invalid"
  config_mode=$(/usr/bin/stat -c %a -- "$mcp_config" 2>/dev/null) \
    || die "MCP config metadata is unavailable"
  [ "$config_mode" = "600" ] || die "MCP config mode must be 0600"
  /bin/mkdir -m 700 -- "$cursor_home/.cursor" \
    || die "cannot create ephemeral Cursor config directory"
  /bin/cp -- "$mcp_config" "$cursor_home/.cursor/mcp.json" \
    || die "cannot copy Cursor MCP config"
  /bin/chmod 600 -- "$cursor_home/.cursor/mcp.json" \
    || die "cannot secure Cursor MCP config"
  mcp_approval=1
fi
unset OPENCLAUDE_CURSOR_MCP_CONFIG

# Optional platform efficiency hooks.json. Fail-open: a bad/missing hooks
# file must never take down the Cursor session.
hooks_json=${OPENCLAUDE_CURSOR_HOOKS_JSON:-}
if [ -n "$hooks_json" ]; then
  hooks_ok=0
  case "$hooks_json" in /*) hooks_ok=1 ;; esac
  if [ "$hooks_ok" -eq 1 ] && [ ! -L "$hooks_json" ] && [ -f "$hooks_json" ]; then
    hooks_uid=$(/usr/bin/stat -c %u -- "$hooks_json" 2>/dev/null || echo "")
    current_uid=$(/usr/bin/id -u 2>/dev/null || echo "")
    hooks_mode=$(/usr/bin/stat -c %a -- "$hooks_json" 2>/dev/null || echo "")
    if [ -n "$hooks_uid" ] && [ "$hooks_uid" = "$current_uid" ] && [ "$hooks_mode" = "600" ]; then
      /bin/mkdir -m 700 -- "$cursor_home/.cursor" 2>/dev/null || true
      if [ -d "$cursor_home/.cursor" ]; then
        hooks_tmp="$cursor_home/.cursor/hooks.json.tmp"
        if /bin/cp -- "$hooks_json" "$hooks_tmp" \
          && /bin/chmod 600 -- "$hooks_tmp" \
          && /bin/mv -f -- "$hooks_tmp" "$cursor_home/.cursor/hooks.json"; then
          :
        else
          /bin/rm -f -- "$hooks_tmp" 2>/dev/null || true
          echo "[oc-efficiency-guard] fail-open: hooks.json install failed" >&2
        fi
      else
        echo "[oc-efficiency-guard] fail-open: cannot create Cursor config dir" >&2
      fi
    else
      echo "[oc-efficiency-guard] fail-open: hooks.json rejected (uid/mode)" >&2
    fi
  else
    echo "[oc-efficiency-guard] fail-open: hooks.json missing or not a regular file" >&2
  fi
fi
unset OPENCLAUDE_CURSOR_HOOKS_JSON

prompt=$1
shift
for word in "$@"; do
  prompt="$prompt $word"
done
set -- -p --trust --workspace "$workspace" \
  --output-format stream-json --stream-partial-output -- "$prompt"
[ "$mcp_approval" -eq 0 ] || set -- --approve-mcps "$@"
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
