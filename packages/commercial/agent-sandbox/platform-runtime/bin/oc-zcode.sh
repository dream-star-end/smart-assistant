#!/bin/sh
# oc-zcode — experimental community ZCode CLI launcher (zcode.cjs 0.15.0).
#
# This is NOT an official standalone CLI. Credentials stay in a root-only
# mount and never enter Docker Env, the image, argv, or logs. The hosted
# permission mode is locked to `yolo` (the only 0.15.0 unattended all-tools
# mode). There is no stdin ask path.
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

zcode_cjs=/opt/zcode-cli/versions/0.15.0/zcode.cjs
node_bin=/usr/local/bin/node
auth_file=/run/oc/zcode-auth/api-key
if [ -n "${OC_ZCODE_TEST_BIN:-}" ]; then
  zcode_cjs=$OC_ZCODE_TEST_BIN
  node_bin=""
fi
if [ -n "${OC_ZCODE_TEST_AUTH_FILE:-}" ]; then
  auth_file=$OC_ZCODE_TEST_AUTH_FILE
fi
if [ -n "${OC_ZCODE_TEST_NODE:-}" ]; then
  node_bin=$OC_ZCODE_TEST_NODE
fi

if [ -z "${OC_ZCODE_TEST_BIN:-}" ]; then
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

if [ -n "${OC_ZCODE_TEST_AUTH_FILE:-}" ]; then
  [ -f "$auth_file" ] || die "test credential file is missing"
  api_key=$(/bin/cat -- "$auth_file")
else
  /usr/bin/sudo -n /usr/bin/test -f "$auth_file" 2>/dev/null \
    || die "ZCode CLI is not enabled for this account"
  api_key=$(/usr/bin/sudo -n /bin/cat -- "$auth_file") \
    || die "ZCode credential mount is unreadable"
fi
[ -n "$api_key" ] || die "ZCode credential is malformed"
carriage_return=$(printf '\r')
case "$api_key" in
  *"
"*|*"$carriage_return"*)
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
# Key stays in env only. File config carries the provider/model pair required
# by 0.15.0 (`model.main`); do not write the secret into config.json.
printf '%s\n' "{\"model\":{\"main\":\"$upstream\"}}" > "$zcode_home/.zcode/cli/config.json"
/bin/chmod 0600 -- "$zcode_home/.zcode/cli/config.json"

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
set +e
if [ -n "$node_bin" ]; then
  HOME="$zcode_home" \
  ZCODE_API_KEY="$api_key" \
  ZCODE_MODEL="$upstream" \
  /usr/bin/setsid "$node_bin" "$zcode_cjs" "$@" < /dev/null &
else
  HOME="$zcode_home" \
  ZCODE_API_KEY="$api_key" \
  ZCODE_MODEL="$upstream" \
  /usr/bin/setsid "$zcode_cjs" "$@" < /dev/null &
fi
child_pid=$!
wait "$child_pid"
status=$?
set -e

api_key=""
exit "$status"
