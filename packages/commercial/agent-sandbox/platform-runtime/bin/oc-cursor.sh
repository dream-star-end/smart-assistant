#!/bin/sh
# oc-cursor — account-scoped launcher for the pinned official Cursor Agent CLI.
#
# This is deliberately a one-shot print-mode tool rather than a V5 model
# engine. The host credential is mounted only into the explicitly authorized
# user's container and never enters Docker Env, the image, or the repository.
#
# Multi-key pool: the host may provision interchangeable Cursor API keys as
# additional `api-key.<N>` files (N >= 2, canonical decimal, no leading zeros)
# inside the same root-only auth directory. `api-key` stays mandatory — the
# supervisor's mount validation gates on it, so an absent primary means the
# credential mount itself never happened. Non-canonical extra names are
# ignored. The primary `api-key` is the preferred key: every turn uses it
# while it works, extras are failover only (see the slot-selection comment
# below). The slot used for a turn is announced on stderr as an index only;
# key values are never printed.
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
for required_tool in /usr/bin/sudo /usr/bin/test /bin/cat /bin/ls \
  /usr/bin/mktemp /bin/rm /bin/sleep /usr/bin/setsid /usr/bin/stat \
  /usr/bin/id /bin/mkdir /bin/cp /bin/chmod /bin/mv /bin/date /bin/ln \
  /usr/bin/cut /usr/bin/find /usr/bin/mkfifo /usr/bin/sha256sum \
  /usr/bin/tail /usr/bin/tee; do
  [ -x "$required_tool" ] || die "runtime image is missing $required_tool"
done

cursor_bin=/opt/cursor-agent/versions/2026.08.11-e8db854/cursor-agent
auth_file=/run/oc/cursor-auth/api-key
[ -x "$cursor_bin" ] || die "pinned Cursor Agent CLI is unavailable"
/usr/bin/sudo -n /usr/bin/test -f "$auth_file" 2>/dev/null \
  || die "Cursor CLI is not enabled for this account"

# Enumerate the credential pool. Only `api-key` and canonical `api-key.<N>`
# (N >= 2) names are eligible; everything else in the root-only directory is
# ignored. Slot 1 is always the primary file; extras follow `ls -1` order.
# `set -f` keeps pathname expansion off the unquoted iteration below — the
# auth directory is root-authored, but a stray glob-shaped entry must not
# resolve against workspace filenames.
auth_dir=${auth_file%/*}
set -f
key_names=""
key_count=0
auth_entries=$(/usr/bin/sudo -n /bin/ls -1 -- "$auth_dir" 2>/dev/null) \
  || auth_entries=""
for auth_entry in $auth_entries; do
  case "$auth_entry" in
    api-key)
      key_names="$key_names $auth_entry"
      key_count=$((key_count + 1))
      ;;
    api-key.*)
      key_suffix=${auth_entry#api-key.}
      case "$key_suffix" in
        ''|*[!0-9]*|0*|1) continue ;;
      esac
      key_names="$key_names $auth_entry"
      key_count=$((key_count + 1))
      ;;
  esac
done
set +f
[ "$key_count" -gt 0 ] || die "Cursor CLI is not enabled for this account"

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
  ""|cursor-grok-4.6-low|cursor-grok-4.6-low-fast|cursor-grok-4.6-medium|cursor-grok-4.6-medium-fast|\
  cursor-grok-4.6-high|cursor-grok-4.6-high-fast|cursor-grok-4.6-xhigh|cursor-grok-4.6-xhigh-fast|\
  composer-2.5|composer-2.5-fast|\
  claude-opus-5-thinking-low|claude-opus-5-thinking-low-fast|\
  claude-opus-5-thinking-medium|claude-opus-5-thinking-medium-fast|\
  claude-opus-5-thinking-high|claude-opus-5-thinking-high-fast|\
  claude-opus-5-thinking-xhigh|claude-opus-5-thinking-xhigh-fast|\
  claude-opus-5-thinking-max|claude-opus-5-thinking-max-fast|\
  claude-opus-4-8-thinking-low|claude-opus-4-8-thinking-low-fast|\
  claude-opus-4-8-thinking-medium|claude-opus-4-8-thinking-medium-fast|\
  claude-opus-4-8-thinking-high|claude-opus-4-8-thinking-high-fast|\
  claude-opus-4-8-thinking-xhigh|claude-opus-4-8-thinking-xhigh-fast|\
  claude-opus-4-8-thinking-max|claude-opus-4-8-thinking-max-fast|\
  claude-fable-5-thinking-low|claude-fable-5-thinking-medium|claude-fable-5-thinking-high|\
  claude-fable-5-thinking-xhigh|claude-fable-5-thinking-max|\
  cursor-grok-4.5-high) ;;
  *) die "model is not allowlisted" ;;
esac

workspace=$(pwd -P)
[ -d "$workspace" ] || die "current workspace is unavailable"

# The host source is root:root 0400/0600. The container agent has sudo by
# product design, but only the explicitly authorized user's container gets the
# bind mount. Never print the value or put it in argv.
#
# Slot selection: the primary (`api-key`) is the preferred key. Extras are
# failover only: a turn that fails for any reason on a slot — non-zero CLI
# exit, unreadable or malformed slot file — hands the NEXT turn to the
# following slot (with wraparound) and starts a cooldown. Successful turns
# never touch the state, so a healthy failover slot keeps serving until the
# cooldown elapses; the next turn after that probes the primary again. This
# prefers the primary without oscillating on every turn when it is down. The
# offset+cooldown state lives in the container (per-user, per-container
# lifetime; last writer wins under concurrent turns — acceptable, both keys
# are interchangeable). A single-key account keeps the byte-identical legacy
# path.
#
# Other Models (Opus and the rest) additionally skip slots marked
# `cursor_only` in `.quota-class`. That sidecar has no secrets. Cursor Models
# still see every active slot.
chosen_key_file=$auth_file
rotation_file=${OC_CURSOR_KEY_ROTATION_FILE:-/tmp/openclaude-cursor-key-rotation}
rotation_cooldown=600
rotation_idx=0
rotation_exp=0

cursor_family=other_models
case "$model" in
  ""|auto)
    cursor_family=cursor_models
    ;;
  cursor-grok-4.6-low|cursor-grok-4.6-low-fast|cursor-grok-4.6-medium|cursor-grok-4.6-medium-fast|\
  cursor-grok-4.6-high|cursor-grok-4.6-high-fast|cursor-grok-4.6-xhigh|cursor-grok-4.6-xhigh-fast|\
  composer-2.5|composer-2.5-fast|cursor-grok-4.5-high|cursor-grok-4.5-high-fast)
    cursor_family=cursor_models
    ;;
esac

eligible_names=$key_names
eligible_count=$key_count
if [ "$cursor_family" = "other_models" ]; then
  if /usr/bin/sudo -n /usr/bin/test -f "$auth_dir/.quota-class" 2>/dev/null \
    || /usr/bin/test -f "$auth_dir/.quota-class" 2>/dev/null; then
    sidecar_text=$(/usr/bin/sudo -n /bin/cat -- "$auth_dir/.quota-class" 2>/dev/null) \
      || sidecar_text=$(/bin/cat -- "$auth_dir/.quota-class" 2>/dev/null) \
      || sidecar_text=""
    eligible_names=""
    eligible_count=0
    for key_name in $key_names; do
      slot_class=unknown
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          ''|'#'*) continue ;;
        esac
        slot_name=${line%% *}
        slot_cls=${line#"$slot_name"}
        slot_cls=${slot_cls# }
        slot_cls=${slot_cls%% *}
        if [ "$slot_name" = "$key_name" ]; then
          case "$slot_cls" in
            unknown|other_ok|cursor_only) slot_class=$slot_cls ;;
          esac
        fi
      done <<SIDECAR
$sidecar_text
SIDECAR
      if [ "$slot_class" = "cursor_only" ]; then
        continue
      fi
      eligible_names="$eligible_names $key_name"
      eligible_count=$((eligible_count + 1))
    done
    if [ "$eligible_count" -eq 0 ]; then
      die "Cursor other-models quota unavailable"
    fi
  fi
fi

# Filtered Other Models must not keep serving a cursor_only primary.
if [ "$eligible_count" -ge 1 ]; then
  for key_name in $eligible_names; do
    chosen_key_file=$auth_dir/$key_name
    break
  done
fi

if [ "$eligible_count" -gt 1 ]; then
  rotation_state=$(/bin/cat -- "$rotation_file" 2>/dev/null) || rotation_state=""
  rotation_first=${rotation_state%% *}
  rotation_rest=${rotation_state#* }
  if [ "$rotation_rest" = "$rotation_state" ]; then rotation_rest=""; fi
  case "$rotation_first" in
    ''|*[!0-9]*) rotation_first=0 ;;
  esac
  case "$rotation_rest" in
    ''|*[!0-9]*) rotation_rest=0 ;;
  esac
  rotation_idx=$rotation_first
  rotation_exp=$rotation_rest
  if [ "$rotation_idx" -ge "$eligible_count" ]; then rotation_idx=0; fi
  # Cooldown elapsed (or legacy single-int state): return to the primary eligible.
  if [ "$rotation_idx" -gt 0 ] && [ "$(/bin/date +%s)" -ge "$rotation_exp" ]; then
    rotation_idx=0
  fi
  chosen_slot=$((rotation_idx + 1))
  slot_position=0
  for key_name in $eligible_names; do
    slot_position=$((slot_position + 1))
    if [ "$slot_position" -eq "$chosen_slot" ]; then
      chosen_key_file=$auth_dir/$key_name
      break
    fi
  done
  full_slot=0
  for key_name in $key_names; do
    full_slot=$((full_slot + 1))
    if [ "$auth_dir/$key_name" = "$chosen_key_file" ]; then
      echo "oc-cursor: using Cursor credential slot $full_slot/$key_count" >&2
      break
    fi
  done
fi

# Advance the eligible pool past the slot that just failed. No-op for
# single-eligible accounts, so their failure path stays byte-identical.
rotation_advance() {
  [ "$eligible_count" -gt 1 ] || return 0
  rotation_next=$((rotation_idx + 1))
  if [ "$rotation_next" -ge "$eligible_count" ]; then rotation_next=0; fi
  printf '%s %s\n' "$rotation_next" "$(( $(/bin/date +%s) + rotation_cooldown ))" \
    > "$rotation_file" 2>/dev/null || :
}
emit_slot_result() {
  _kind=$1
  _full=0
  for key_name in $key_names; do
    _full=$((_full + 1))
    if [ "$auth_dir/$key_name" = "$chosen_key_file" ]; then
      echo "oc-cursor: slot_result $_full $_kind" >&2
      return 0
    fi
  done
}

if ! api_key=$(/usr/bin/sudo -n /bin/cat -- "$chosen_key_file" 2>/dev/null); then
  emit_slot_result fail
  rotation_advance
  die "Cursor credential mount is unreadable"
fi
if [ -z "$api_key" ]; then
  emit_slot_result fail
  rotation_advance
  die "Cursor credential is malformed"
fi
carriage_return=$(printf '\r')
case "$api_key" in
  *"
"*|*"$carriage_return"*)
    emit_slot_result fail
    rotation_advance
    die "Cursor credential is malformed"
    ;;
esac

umask 077
cursor_home=$(/usr/bin/mktemp -d /tmp/openclaude-cursor.XXXXXXXX) \
  || die "cannot create ephemeral Cursor state"
child_pid=""
cursor_debug=0
debug_log=""
debug_fifo=""
tee_pid=""

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
  # Debug mode: the CLI's own debug logs live inside the ephemeral HOME and
  # would die with it. Salvage a bounded copy into the durable 0600 log before
  # removal. find does not follow symlinks; per-file cap keeps the log sane.
  if [ "${cursor_debug:-0}" = "1" ] && [ -n "${debug_log:-}" ] && [ ! -L "$debug_log" ]; then
    /usr/bin/find "$cursor_home" -maxdepth 6 -type f -name '*.log' 2>/dev/null \
      | while IFS= read -r cli_log; do
          printf '\n[oc-cursor] -- CLI log tail: %s --\n' "${cli_log#"$cursor_home"/}" \
            >> "$debug_log" 2>/dev/null || true
          /usr/bin/tail -c 1048576 -- "$cli_log" >> "$debug_log" 2>/dev/null || true
        done
  fi
  # tee is not in the CLI process group; if a stray descendant kept the fifo
  # write end open (or the CLI never opened it), terminate tee explicitly so
  # it can never outlive the wrapper.
  if [ -n "${tee_pid:-}" ] && kill -0 "$tee_pid" 2>/dev/null; then
    kill -TERM "$tee_pid" 2>/dev/null || true
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

# Durable Cursor chat store lives under OPENCLAUDE_HOME (outside the
# per-turn ephemeral HOME) so --resume can see store.db after HOME is
# destroyed. The path is derived here; callers cannot supply it.
chats_linked=0
oc_home=${OPENCLAUDE_HOME:-}
case "$oc_home" in
  /*)
    if [ -d "$oc_home" ]; then
      chats_dir="$oc_home/cursor-chats"
      /bin/mkdir -p -m 0700 -- "$chats_dir" \
        || die "cannot create durable Cursor chats directory"
      [ -d "$chats_dir" ] && [ ! -L "$chats_dir" ] \
        || die "durable Cursor chats directory is invalid"
      /bin/mkdir -p -- "$cursor_home/.config/cursor" \
        || die "cannot create ephemeral Cursor config directory"
      /bin/ln -s -- "$chats_dir" "$cursor_home/.config/cursor/chats" \
        || die "cannot link durable Cursor chats directory"
      chats_linked=1
    fi
    ;;
esac

resume_id=${OPENCLAUDE_CURSOR_RESUME_ID:-}
if [ -n "$resume_id" ]; then
  case "$resume_id" in
    [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F])
      [ "${#resume_id}" -eq 36 ] || die "invalid Cursor resume id"
      ;;
    *)
      die "invalid Cursor resume id"
      ;;
  esac
  [ "$chats_linked" -eq 1 ] || die "Cursor resume requires durable chats directory"
fi
unset OPENCLAUDE_CURSOR_RESUME_ID
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

# ── Optional CLI cold-start diagnostics (OPENCLAUDE_CURSOR_AGENT_DEBUG=1) ──
# Default OFF: behavior stays bit-identical to the historical wrapper. When
# ON, the pinned CLI keeps its own debug logging (CURSOR_AGENT_DISABLE_DEBUG_LOG
# is NOT set) and stderr is duplicated through a fifo+tee into a durable 0600
# log under OPENCLAUDE_HOME/logs/cursor-cli/, so 30-40s cold starts can be
# attributed (login/JWT vs cloud handshake vs MCP). Session key never enters
# the path (sha256 prefix only). 10MB single rotation + 7-day retention.
# Every validation failure fails OPEN to "no log" — it must never fail the
# turn, change the CLI exit status, or detach $child_pid from the CLI group.
if [ "${OPENCLAUDE_CURSOR_AGENT_DEBUG:-}" = "1" ] && [ -n "$oc_home" ] && [ -d "$oc_home" ]; then
  log_root="$oc_home/logs/cursor-cli"
  if /bin/mkdir -p -m 0700 -- "$log_root" 2>/dev/null \
    && [ -d "$log_root" ] && [ ! -L "$oc_home/logs" ] && [ ! -L "$log_root" ]; then
    /bin/chmod 0700 -- "$oc_home/logs" "$log_root" 2>/dev/null || true
    session_hash=$(printf '%s' "${OC_SESSION_KEY:-unknown}" \
      | /usr/bin/sha256sum 2>/dev/null | /usr/bin/cut -c1-16)
    if [ -n "$session_hash" ]; then
      debug_log="$log_root/cursor-cli-$session_hash.log"
      if [ ! -L "$debug_log" ]; then
        log_size=$(/usr/bin/stat -c %s -- "$debug_log" 2>/dev/null || echo 0)
        if [ "$log_size" -gt 10485760 ]; then
          /bin/mv -f -- "$debug_log" "$debug_log.1" 2>/dev/null || true
        fi
        /usr/bin/find "$log_root" -maxdepth 1 -type f -name 'cursor-cli-*.log*' \
          -mtime +7 -delete 2>/dev/null || true
        debug_fifo="$cursor_home/.oc-debug-stderr"
        if /usr/bin/mkfifo -m 0600 -- "$debug_fifo" 2>/dev/null; then
          if printf '\n[oc-cursor] ==== turn %s ====\n' \
            "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)" \
            >> "$debug_log" 2>/dev/null; then
            # tee is a wrapper child, NOT in the CLI process group: Stop kills
            # the group, the fifo write end closes, tee exits on EOF. stderr
            # keeps flowing to the gateway via >&2.
            /usr/bin/tee -a -- "$debug_log" < "$debug_fifo" >&2 &
            tee_pid=$!
            cursor_debug=1
          fi
        fi
      fi
    fi
  fi
fi
unset OPENCLAUDE_CURSOR_AGENT_DEBUG

prompt=$1
shift
for word in "$@"; do
  prompt="$prompt $word"
done
if [ -n "$resume_id" ]; then
  set -- -p --trust --workspace "$workspace" \
    --output-format stream-json --stream-partial-output \
    --resume "$resume_id" -- "$prompt"
else
  set -- -p --trust --workspace "$workspace" \
    --output-format stream-json --stream-partial-output -- "$prompt"
fi
[ "$mcp_approval" -eq 0 ] || set -- --approve-mcps "$@"
[ -z "$model" ] || set -- --model "$model" "$@"
[ -z "$mode" ] || set -- --mode "$mode" "$@"
[ "$force" -eq 0 ] || set -- --force "$@"

# setsid gives the CLI and every tool child one process group so Stop cannot
# leave a shell command running after the wrapper exits. HOME is per-call and
# deleted on every exit, including Cursor's generated auth.json/JWT state.
# The debug branch differs ONLY in (a) not disabling the CLI debug log and
# (b) redirecting stderr through the fifo tee — same setsid group, same $!,
# same exit-status propagation. No pipeline: `wait` still returns the CLI's
# own status.
set +e
if [ "$cursor_debug" -eq 1 ]; then
  HOME="$cursor_home" \
  XDG_CONFIG_HOME="$cursor_home/.config" \
  CURSOR_API_KEY="$api_key" \
  /usr/bin/setsid "$cursor_bin" "$@" 2> "$debug_fifo" &
else
  HOME="$cursor_home" \
  XDG_CONFIG_HOME="$cursor_home/.config" \
  CURSOR_AGENT_DISABLE_DEBUG_LOG=1 \
  CURSOR_API_KEY="$api_key" \
  /usr/bin/setsid "$cursor_bin" "$@" &
fi
child_pid=$!
wait "$child_pid"
status=$?
# Bounded drain for tee (≤2s): descendants killed by cleanup may still hold
# the fifo write end; never let a stuck tee hang the turn — cleanup TERMs it.
if [ -n "$tee_pid" ]; then
  attempts=0
  while [ "$attempts" -lt 40 ] && kill -0 "$tee_pid" 2>/dev/null; do
    /bin/sleep 0.05
    attempts=$((attempts + 1))
  done
fi
set -e

# A failed turn may be a quota/credential problem on the slot it used: hand
# the next turn to the following slot under cooldown. Signal-terminated
# turns (user Stop) exit through forward_signal and do not touch the state.
if [ "$status" -ne 0 ]; then
  emit_slot_result fail
  rotation_advance
else
  emit_slot_result ok
fi

# Shorten the lifetime of the shell copy before EXIT removes the temp HOME.
api_key=""
exit "$status"
