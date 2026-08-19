#!/bin/sh
# oc-zcode — experimental community ZCode CLI launcher (zcode.cjs 0.15.0).
#
# This is NOT an official standalone CLI. Credentials stay in a root-only
# mount and never enter Docker Env, the image, argv, or logs. The hosted
# permission mode is locked to `yolo` (the only 0.15.0 unattended all-tools
# mode). There is no stdin ask path.
#
# Test hooks (OC_ZCODE_TEST_*) are hard-isolated from the production path:
# any test variable forces a complete test bin + test auth pair and never
# touches /run/oc/zcode-auth or sudo.
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
  [ -x /usr/bin/sudo ] || die "runtime image is missing /usr/bin/sudo"
  zcode_cjs=/opt/zcode-cli/versions/0.15.0/zcode.cjs
  node_bin=/usr/local/bin/node
  auth_file=/run/oc/zcode-auth/api-key
  [ -f "$zcode_cjs" ] || die "experimental community CLI is not installed"
  [ -x "$node_bin" ] || die "node 22 is required to run zcode.cjs 0.15.0"
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
    --model|--model=*|--force|--login|--logout|--no-browser|-c|--continue|--attach|--attach=*)
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

upstream=${OC_ZCODE_UPSTREAM_MODEL:-zai/glm-5.1}
case "$upstream" in
  zai/glm-5.1) ;;
  *) die "upstream model is not allowlisted" ;;
esac
provider=${upstream%%/*}

if [ "$test_mode" -eq 1 ]; then
  [ -f "$auth_file" ] || die "test credential file is missing"
  api_key=$(/bin/cat -- "$auth_file")
else
  /usr/bin/sudo -n /usr/bin/test -f "$auth_file" 2>/dev/null \
    || die "ZCode CLI is not enabled for this account"
  meta=$(/usr/bin/sudo -n /usr/bin/stat -c '%u %a' -- "$auth_file") \
    || die "ZCode credential mount is unreadable"
  owner=${meta%% *}
  mode_bits=${meta##* }
  [ "$owner" = "0" ] || die "ZCode credential owner is not root"
  case "$mode_bits" in
    400|600|0400|0600) ;;
    *) die "ZCode credential mode must be 0400 or 0600" ;;
  esac
  api_key=$(/usr/bin/sudo -n /bin/cat -- "$auth_file") \
    || die "ZCode credential mount is unreadable"
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
# 0.15.0 reads provider.<id>.options.apiKey from isolated HOME config.
# Never export the key into yolo or its tool children.
printf '%s\n' "{\"model\":{\"main\":\"$upstream\"},\"provider\":{\"$provider\":{\"options\":{\"apiKey\":\"$api_key\"}}}}" \
  > "$zcode_home/.zcode/cli/config.json"
/bin/chmod 0600 -- "$zcode_home/.zcode/cli/config.json"
api_key=""

storage_dir=""
oc_home=${OPENCLAUDE_HOME:-}
case "$oc_home" in
  /*)
    if [ -d "$oc_home" ]; then
      storage_dir="$oc_home/zcode-cli"
      /bin/mkdir -p -m 0700 -- "$storage_dir" \
        || die "cannot create durable ZCode storage directory"
    fi
    ;;
esac

set -- --prompt "$prompt" --json --mode yolo --no-color --cwd "$cwd"
[ -z "$resume" ] || set -- "$@" --resume "$resume"

if [ -n "$storage_dir" ]; then
  export ZCODE_STORAGE_DIR="$storage_dir"
fi
unset ZCODE_API_KEY
unset ZAI_API_KEY
unset ANTHROPIC_API_KEY
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
