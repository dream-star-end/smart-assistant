#!/usr/bin/env bash
# Rehearse or read-only-check the egress/watch logrotate snippet.
# Never uses logrotate -f. Never restarts a service. Refuses to write
# /etc/logrotate.d or --root /. Host install steps are in the sibling .md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_TEMPLATE="$REPO_ROOT/deploy/v5-selfhost/logrotate.d/openclaude-v5-selfhost-egress-watch"
DEST_NAME="openclaude-v5-selfhost-egress-watch"
PATH_EGRESS="/var/log/openclaude-v5-selfhost-egress.log"
PATH_WATCH="/var/log/openclaude-v5-selfhost-watch.log"

usage() {
  cat <<'EOF'
usage:
  v5-selfhost-logrotate-egress-watch-install.sh --check-host-readonly
  v5-selfhost-logrotate-egress-watch-install.sh --root <dir> [--template <file>]
  v5-selfhost-logrotate-egress-watch-install.sh --fixture-rotate \
      --config <file> --state <file> --fixture-root <dir>

--root / and any destination that resolves to /etc/logrotate.d are refused.
--fixture-rotate is the only logrotate -f entry point; it refuses real log paths.
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

python_paths() {
  python3 - "$1" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
paths = []
for raw in text.splitlines():
    line = raw.split("#", 1)[0].strip()
    if not line:
        continue
    if "{" in line:
        line = line.split("{", 1)[0].strip()
    if not line:
        continue
    for tok in line.split():
        if tok.startswith("/"):
            paths.append(tok)
sys.stdout.write("\n".join(paths))
PY
}

validate_template() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || die "TEMPLATE_NOT_FILE $file"
  python3 - "$file" "$PATH_EGRESS" "$PATH_WATCH" <<'PY'
import sys
path, egress, watch = sys.argv[1:]
text = open(path, encoding="utf-8").read()
if "\x00" in text:
    raise SystemExit("TEMPLATE_BINARY")
lines = []
paths = []
for raw in text.splitlines():
    code = raw.split("#", 1)[0].strip()
    if not code:
        continue
    head = code.split("{", 1)[0].strip()
    for tok in head.split():
        if tok.startswith("/"):
            paths.append(tok)
            if any(ch in tok for ch in "*?["):
                raise SystemExit("TEMPLATE_GLOB " + tok)
    if code.endswith("{") or code == "{":
        continue
    if code in {"}"}:
        continue
    # path-only lines are not directives
    if code.startswith("/"):
        continue
    lines.append(code)
banned = ("postrotate", "prerotate", "firstaction", "lastaction", "sharedscripts", "endscript", "truncate")
for line in lines:
    word = line.split()[0]
    if word in banned:
        raise SystemExit("TEMPLATE_BANNED " + word)
    if "systemctl" in line or "service " in line:
        raise SystemExit("TEMPLATE_SERVICE " + line)
need = [
    "su root adm",
    "daily",
    "maxsize 200M",
    "rotate 14",
    "compress",
    "delaycompress",
    "missingok",
    "notifempty",
    "copytruncate",
]
missing = [item for item in need if item not in lines]
if missing:
    raise SystemExit("TEMPLATE_MISSING " + ",".join(missing))
if paths != [egress, watch]:
    raise SystemExit("TEMPLATE_PATHS " + ",".join(paths))
PY
}

scan_duplicates() {
  # Prints "path<TAB>file" hits. Skip the destination file when given.
  local exclude="${1:-}"
  shift
  python3 - "$exclude" "$PATH_EGRESS" "$PATH_WATCH" "$@" <<'PY'
import os, sys
exclude = sys.argv[1]
wanted = set(sys.argv[2:4])
roots = sys.argv[4:]
skip_suffix = ("~", ".bak", ".disabled", ".rpmnew", ".rpmsave")

def consider(path):
    if not os.path.isfile(path):
        return
    if exclude and os.path.realpath(path) == exclude:
        return
    name = os.path.basename(path)
    if name.endswith(skip_suffix):
        return
    text = open(path, encoding="utf-8", errors="replace").read()
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if "{" in line:
            line = line.split("{", 1)[0].strip()
        for tok in line.split():
            if tok in wanted:
                sys.stdout.write(f"{tok}\t{path}\n")

for root in roots:
    if not root or not os.path.exists(root):
        continue
    if os.path.isfile(root):
        consider(root)
        continue
    if not os.path.isdir(root):
        continue
    for name in sorted(os.listdir(root)):
        consider(os.path.join(root, name))
PY
}

logrotate_debug() {
  local conf="$1"
  local state rc
  state="$(mktemp)"
  set +e
  logrotate -d -s "$state" "$conf" >/dev/null
  rc=$?
  set -e
  rm -f -- "$state"
  [[ "$rc" -eq 0 ]]
}

mode=""
root=""
template=""
fix_config=""
fix_state=""
fix_root=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-host-readonly)
      mode="check"
      shift
      ;;
    --root)
      root="${2:-}"
      mode="${mode:-install}"
      shift 2
      ;;
    --template)
      template="${2:-}"
      shift 2
      ;;
    --fixture-rotate)
      mode="fixture"
      shift
      ;;
    --config)
      fix_config="${2:-}"
      shift 2
      ;;
    --state)
      fix_state="${2:-}"
      shift 2
      ;;
    --fixture-root)
      fix_root="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown arg: $1"
      ;;
  esac
done

if [[ "$mode" == "check" ]]; then
  hits="$(scan_duplicates "" /etc/logrotate.conf /etc/logrotate.d || true)"
  egress_n=0
  watch_n=0
  if [[ -n "$hits" ]]; then
    egress_n="$(printf '%s\n' "$hits" | awk -F '\t' -v p="$PATH_EGRESS" '$1==p {n++} END {print n+0}')"
    watch_n="$(printf '%s\n' "$hits" | awk -F '\t' -v p="$PATH_WATCH" '$1==p {n++} END {print n+0}')"
    printf '%s\n' "$hits" >&2
  fi
  printf 'DUPLICATE_EGRESS=%s\n' "$egress_n"
  printf 'DUPLICATE_WATCH=%s\n' "$watch_n"
  state="$(mktemp)"
  set +e
  logrotate -d -s "$state" /etc/logrotate.conf >/dev/null
  dry_rc=$?
  set -e
  rm -f -- "$state"
  printf 'LIVE_DRY_RUN=%s\n' "$dry_rc"
  if [[ "$egress_n" != "0" || "$watch_n" != "0" ]]; then
    exit 4
  fi
  [[ "$dry_rc" -eq 0 ]]
  exit 0
fi

if [[ "$mode" == "fixture" ]]; then
  [[ -n "$fix_config" && -n "$fix_state" && -n "$fix_root" ]] || die "FIXTURE_ARGS"
  [[ -d "$fix_root" && ! -L "$fix_root" ]] || die "FIXTURE_ROOT"
  root_real="$(realpath "$fix_root")"
  [[ "$root_real" != "/" ]] || die "REFUSE_HOST_ROOT"
  case "$root_real" in
    /tmp/*|/var/tmp/*) ;;
    *) die "FIXTURE_ROOT_NOT_TMP" ;;
  esac
  python3 - "$fix_config" "$fix_state" "$root_real" "$PATH_EGRESS" "$PATH_WATCH" <<'PY'
import os, sys
conf, state, root, egress, watch = sys.argv[1:]
forbidden = (
    egress,
    watch,
    "/var/log/openclaude-v5-selfhost.log",
    "/var/log/cloudflared-v5-selfhost.log",
    "/etc/logrotate.d",
    "/var/lib/logrotate/status",
)
def under(path):
    real = os.path.realpath(path)
    return real == root or real.startswith(root + os.sep)
if not under(conf):
    raise SystemExit("REFUSE_REAL_PATH conf")
state_dir = os.path.dirname(os.path.abspath(state))
if not under(state_dir):
    raise SystemExit("REFUSE_REAL_PATH state")
text = open(conf, encoding="utf-8").read()
for item in forbidden:
    if item in text:
        raise SystemExit("REFUSE_REAL_PATH " + item)
paths = []
for raw in text.splitlines():
    line = raw.split("#", 1)[0].strip()
    if not line:
        continue
    if "{" in line:
        line = line.split("{", 1)[0].strip()
    for tok in line.split():
        if tok.startswith("/"):
            paths.append(tok)
if not paths:
    raise SystemExit("REFUSE_REAL_PATH no-paths")
for tok in paths:
    if any(ch in tok for ch in "*?["):
        raise SystemExit("REFUSE_REAL_PATH glob")
    if not under(tok):
        raise SystemExit("REFUSE_REAL_PATH " + tok)
PY
  # Private state only. The config was proven to name nothing outside the fixture.
  logrotate -f -s "$fix_state" "$fix_config" >/dev/null
  printf 'FIXTURE_ROTATED=1\n'
  exit 0
fi

[[ "$mode" == "install" ]] || die "missing mode"
[[ -n "$root" ]] || die "missing --root"
template="${template:-$DEFAULT_TEMPLATE}"
[[ -d "$root" && ! -L "$root" ]] || die "ROOT_NOT_DIR"
root_real="$(realpath "$root")"
if [[ "$root_real" == "/" ]]; then
  printf 'REFUSE_HOST_ROOT\n' >&2
  exit 2
fi
case "$root_real" in
  /tmp/*|/var/tmp/*) ;;
  *)
    printf 'REFUSE_ROOT_NOT_TMP\n' >&2
    exit 2
    ;;
esac

validate_template "$template"
dest_dir="$root_real/etc/logrotate.d"
mkdir -p -- "$dest_dir"
chmod 755 "$dest_dir"
dest_dir_real="$(realpath "$dest_dir")"
if [[ "$dest_dir_real" == "/etc/logrotate.d" ]]; then
  printf 'REFUSE_LIVE_LOGROTATE_D\n' >&2
  exit 2
fi
case "$dest_dir_real" in
  "$root_real"/*) ;;
  *)
    printf 'REFUSE_ESCAPE\n' >&2
    exit 2
    ;;
esac

dest="$dest_dir_real/$DEST_NAME"
exclude=""
if [[ -e "$dest" ]]; then
  exclude="$(realpath "$dest")"
fi
scan_roots=()
if [[ -f "$root_real/etc/logrotate.conf" ]]; then
  scan_roots+=("$root_real/etc/logrotate.conf")
fi
scan_roots+=("$dest_dir_real")
hits="$(scan_duplicates "$exclude" "${scan_roots[@]}")"
if [[ -n "$hits" ]]; then
  printf '%s\n' "$hits" >&2
  printf 'DUPLICATE\n' >&2
  exit 3
fi

sha_before="none"
backup="none"
if [[ -f "$dest" && ! -L "$dest" ]]; then
  bak_dir="$root_real/var/backups/openclaude-v5-selfhost-logrotate"
  mkdir -p -- "$bak_dir"
  backup="$bak_dir/${DEST_NAME}.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a -- "$dest" "$backup"
  sha_before="$(sha256sum "$dest" | awk 'NR==1 {print $1}')"
fi

tmp="$(mktemp --suffix '~' -p "$dest_dir_real" "${DEST_NAME}.XXXXXX")"
trap 'rm -f -- "$tmp"' EXIT
cp -a -- "$template" "$tmp"
chown root:root "$tmp"
chmod 644 "$tmp"
if [[ -n "${OC_LOGROTATE_PAUSE_FILE:-}" ]]; then
  printf '%s\n' "$tmp" >"$OC_LOGROTATE_PAUSE_FILE"
  waited=0
  while [[ ! -f "${OC_LOGROTATE_PAUSE_FILE}.go" ]]; do
    sleep 0.05
    waited=$((waited + 1))
    if [[ "$waited" -gt 400 ]]; then
      printf 'PAUSE_TIMEOUT\n' >&2
      exit 1
    fi
  done
fi
if ! logrotate_debug "$tmp"; then
  printf 'SYNTAX_FAIL\n' >&2
  exit 1
fi
sha_after="$(sha256sum "$tmp" | awk 'NR==1 {print $1}')"
mv -T -- "$tmp" "$dest"
trap - EXIT
printf 'SHA_BEFORE=%s\n' "$sha_before"
printf 'SHA_AFTER=%s\n' "$sha_after"
printf 'BACKUP=%s\n' "$backup"
printf 'INSTALLED=%s\n' "$dest"
