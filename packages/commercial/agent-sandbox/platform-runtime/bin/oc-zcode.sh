#!/bin/sh
# oc-zcode — experimental community ZCode CLI launcher (zcode.cjs 0.16.3).
#
# This is NOT an official standalone CLI. The real Coding Plan key never
# enters this wrapper, argv, logs, or yolo child env. Hosted turns receive
# a short-lived loopback relay URL + opaque token from OpenClaude.
set -eu

die() {
  echo "oc-zcode: $*" >&2
  exit 2
}

usage() {
  cat <<'EOF'
usage: oc-zcode --prompt TEXT --json --mode yolo --no-color --cwd DIR [--resume sess_...]

Experimental community ZCode CLI wrapper. Authentication, model, permission
mode and output format are managed by OpenClaude.
EOF
}

for required_tool in /usr/bin/test /bin/cat /usr/bin/mktemp /bin/rm /bin/mkdir \
  /bin/chmod /usr/bin/id /usr/bin/stat /usr/bin/setsid; do
  [ -x "$required_tool" ] || die "runtime image is missing $required_tool"
done

test_bin=${OC_ZCODE_TEST_BIN:-}
test_auth=${OC_ZCODE_TEST_AUTH_FILE:-}
test_node=${OC_ZCODE_TEST_NODE:-}
test_mode=0
if [ -n "$test_bin" ] || [ -n "$test_auth" ] || [ -n "$test_node" ]; then
  test_mode=1
fi

if [ "$test_mode" -eq 1 ]; then
  [ -n "$test_bin" ] && [ -n "$test_auth" ] \
    || die "test hook requires OC_ZCODE_TEST_BIN and OC_ZCODE_TEST_AUTH_FILE together"
  case "$test_auth" in
    /run/oc/zcode-auth|/run/oc/zcode-auth/*)
      die "test auth must not use the production credential path"
      ;;
  esac
  zcode_cjs=$test_bin
  node_bin=$test_node
  auth_file=$test_auth
else
  zcode_cjs=/opt/zcode-cli/versions/0.16.3/zcode.cjs
  node_bin=/usr/local/bin/node
  auth_file=""
  [ -f "$zcode_cjs" ] || die "experimental community CLI is not installed"
  [ -x "$node_bin" ] || die "node 22 is required to run zcode.cjs 0.16.3"
fi

prompt=""
mode=""
json=0
nocolor=0
cwd=""
resume=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prompt)
      [ "$#" -ge 2 ] || die "--prompt requires a value"
      prompt=$2
      shift 2
      ;;
    --prompt=*)
      prompt=${1#--prompt=}
      shift
      ;;
    --json)
      json=1
      shift
      ;;
    --no-color)
      nocolor=1
      shift
      ;;
    --mode)
      [ "$#" -ge 2 ] || die "--mode requires yolo"
      mode=$2
      shift 2
      ;;
    --mode=*)
      mode=${1#--mode=}
      shift
      ;;
    --cwd)
      [ "$#" -ge 2 ] || die "--cwd requires a value"
      cwd=$2
      shift 2
      ;;
    --cwd=*)
      cwd=${1#--cwd=}
      shift
      ;;
    --resume)
      [ "$#" -ge 2 ] || die "--resume requires a session id"
      resume=$2
      shift 2
      ;;
    --resume=*)
      resume=${1#--resume=}
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --model|--model=*|--force|--login|--logout|--no-browser|-c|--continue|--attach|--attach=*|--settings|--settings=*|--max-turns|--max-turns=*|--permission-mode|--permission-mode=*)
      die "authentication, model, attach and interactive controls are managed by OpenClaude"
      ;;
    -*)
      die "unsupported option: $1"
      ;;
    *)
      die "unexpected argument"
      ;;
  esac
done

[ -n "$prompt" ] || die "a prompt is required"
[ "$json" -eq 1 ] || die "--json is required"
[ "$nocolor" -eq 1 ] || die "--no-color is required"
[ -n "$cwd" ] && [ -d "$cwd" ] || die "--cwd must be an existing directory"
case "$mode" in
  ""|yolo) mode=yolo ;;
  *) die "hosted permission mode is locked to yolo" ;;
esac
if [ -n "$resume" ]; then
  case "$resume" in
    sess_*) ;;
    *) die "resume id must be a sess_… value" ;;
  esac
fi

upstream=${OC_ZCODE_UPSTREAM_MODEL:-zai-coding-plan/glm-5.3}
case "$upstream" in
  zai-coding-plan/glm-5.3) ;;
  *) die "upstream model is not allowlisted" ;;
esac
provider=${upstream%%/*}

relay_base=${OC_ZCODE_RELAY_BASE_URL:-}
relay_token=${OC_ZCODE_RELAY_TOKEN:-}

if [ "$test_mode" -eq 1 ]; then
  [ -f "$auth_file" ] || die "test credential file is missing"
  api_key=$(tr -d '\r\n' < "$auth_file")
  [ -n "$relay_base" ] || relay_base="http://127.0.0.1:9/internal/v5/zcode-relay/route/test"
else
  [ -n "$relay_base" ] || die "ZCode relay is not configured"
  [ -n "$relay_token" ] || die "ZCode relay is not configured"
  case "$relay_token" in
    *[!0-9a-f]*|"" ) die "ZCode relay token is malformed" ;;
  esac
  token_len=$(printf '%s' "$relay_token" | wc -c)
  [ "$token_len" -eq 64 ] || die "ZCode relay token is malformed"
  case "$relay_base" in
    http://127.0.0.1:*/internal/v5/zcode-relay/route/*) ;;
    *) die "ZCode relay URL is not an internal loopback route" ;;
  esac
  api_key=$relay_token
fi
[ -n "$api_key" ] || die "ZCode credential is malformed"
carriage_return=$(printf '\r')
backtick=$(printf '\140')
case "$api_key" in
  *"
"*|*"$carriage_return"*|*\"*|*"\\"*|*"\$"*|*"$backtick"*)
    die "ZCode credential is malformed"
    ;;
esac

umask 077
zcode_home=$(/usr/bin/mktemp -d /tmp/openclaude-zcode.XXXXXXXX) \
  || die "cannot create ephemeral ZCode state"
child_pid=""

cleanup() {
  if [ -n "$child_pid" ] && kill -0 "-$child_pid" 2>/dev/null; then
    kill -TERM "-$child_pid" 2>/dev/null || true
    kill -KILL "-$child_pid" 2>/dev/null || true
  fi
  if [ -n "$child_pid" ]; then
    wait "$child_pid" 2>/dev/null || true
  fi
  /bin/rm -rf -- "$zcode_home"
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

/bin/mkdir -p -m 0700 -- "$zcode_home/.zcode/cli" \
  || die "cannot create ephemeral ZCode config directory"
# 0.16.3 xCt copies provider.options.baseURL/apiKey onto the model ref.
# loadOptionalSetting prefers that config string over ANTHROPIC_BASE_URL, and
# the Anthropic SDK posts ${baseURL}/messages. Egress only matches
# .../route/<token>/v1/messages, so both config and env must already end in /v1.
# Values are the opaque loopback relay token/URL, never the Coding Plan key.
anthropic_base=$relay_base
while [ -n "$anthropic_base" ] && [ "$anthropic_base" != "${anthropic_base%/}" ]; do
  anthropic_base=${anthropic_base%/}
done
case "$anthropic_base" in
  */v1) ;;
  *) anthropic_base="$anthropic_base/v1" ;;
esac
printf '%s\n' "{\"model\":{\"main\":\"$upstream\"},\"provider\":{\"$provider\":{\"kind\":\"anthropic\",\"name\":\"Z.AI Coding Plan\",\"options\":{\"apiKeyRequired\":true,\"baseURL\":\"$anthropic_base\",\"apiKey\":\"$api_key\"}}}}" \
  > "$zcode_home/.zcode/cli/config.json"
/bin/chmod 0600 -- "$zcode_home/.zcode/cli/config.json"
export ANTHROPIC_API_KEY="$api_key"
export ANTHROPIC_BASE_URL="$anthropic_base"
api_key=""
anthropic_base=""

# Durable CLI session store (sess_* files). Ephemeral HOME holds only the
# per-spawn config.json + opaque relay token and is deleted on EXIT.
# Hosted containers often have OPENCLAUDE_HOME empty; still pin storage to
# the per-user volume. Never follow a path we do not own, and never put
# secrets in this directory.
orig_home=${HOME:-}

try_storage_root() {
  dir=$1
  case "$dir" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$dir" in
    */..|*/../*|../*|..) return 1 ;;
  esac
  [ -d "$dir" ] || return 1
  [ ! -L "$dir" ] || return 1
  owner=$(/usr/bin/stat -c '%u' -- "$dir") || return 1
  me=$(/usr/bin/id -u)
  [ "$owner" = "$me" ]
}

storage_root=""
oc_home=${OPENCLAUDE_HOME:-}
if try_storage_root "$oc_home"; then
  storage_root=$oc_home
elif [ "$test_mode" -eq 0 ] && try_storage_root /home/agent/.openclaude; then
  storage_root=/home/agent/.openclaude
elif [ "$test_mode" -eq 1 ] && try_storage_root "${orig_home}/.openclaude"; then
  storage_root="${orig_home}/.openclaude"
fi

storage_dir=""
if [ -n "$storage_root" ]; then
  storage_dir="$storage_root/zcode-cli"
  /bin/mkdir -p -m 0700 -- "$storage_dir" \
    || die "cannot create durable ZCode storage directory"
  /bin/chmod 0700 -- "$storage_dir" \
    || die "cannot secure durable ZCode storage directory"
  try_storage_root "$storage_dir" \
    || die "durable ZCode storage directory is invalid"
  export ZCODE_STORAGE_DIR="$storage_dir"
elif [ "$test_mode" -eq 0 ]; then
  die "durable ZCode storage is unavailable"
fi

set -- --prompt "$prompt" --json --mode yolo --no-color --cwd "$cwd"
[ -z "$resume" ] || set -- "$@" --resume "$resume"
unset ZCODE_API_KEY
unset ZAI_API_KEY
unset ZAI_CODING_PLAN_KEY
unset ANTHROPIC_AUTH_TOKEN
unset OC_ZCODE_RELAY_TOKEN
unset OPENCLAUDE_V3_CONTAINER_TOKEN
export HOME="$zcode_home"
export ZCODE_MODEL="$upstream"
set +e
if [ -n "$node_bin" ]; then
  /usr/bin/setsid "$node_bin" "$zcode_cjs" "$@" < /dev/null &
else
  /usr/bin/setsid "$zcode_cjs" "$@" < /dev/null &
fi
child_pid=$!
wait "$child_pid"
status=$?
set -e

exit "$status"
