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
--fixture-rotate is the only logrotate -f entry point. It allows only the
directives used by the dedicated tests, and refuses include, scripts, and
real log paths. Path checks run before any mkdir, chmod, or copy.
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

# Read-only merged check. Returns 0, 3 (duplicate log entry), 2 (escape), or 1.
# scope "host" is one logrotate -d of /etc/logrotate.conf plus the candidate.
# A rehearsal root stages sibling snippets except the file being replaced, and
# drops logrotate.conf's include of that directory so reinstall is not a
# self-duplicate. The candidate must already be a private copy.
combined_debug() {
  local candidate="$1"
  local scope="$2"
  local state parent stage existing err rc python_rc
  state="$(mktemp)"
  parent="$(mktemp)"
  err="$(mktemp)"
  existing="$(mktemp)"
  stage=""
  if [[ "$scope" == "host" ]]; then
    printf 'include /etc/logrotate.conf\ninclude %s\n' "$candidate" >"$parent"
  else
    stage="$(mktemp -d)"
    set +e
    python3 - "$scope" "$stage" "$DEST_NAME" "$existing" >"$err" 2>&1 <<'PY'
import os, shutil, sys
root, stage, dest_name, existing = sys.argv[1:]
skip_suffix = ("~", ".bak", ".disabled", ".rpmnew", ".rpmsave")
dest_dir = os.path.join(root, "etc", "logrotate.d")
conf = os.path.join(root, "etc", "logrotate.conf")
if os.path.islink(dest_dir) or os.path.islink(conf):
    raise SystemExit("REFUSE_ESCAPE")
if os.path.isdir(dest_dir):
    for name in sorted(os.listdir(dest_dir)):
        if name == dest_name or name.endswith(skip_suffix):
            continue
        src = os.path.join(dest_dir, name)
        if os.path.islink(src):
            raise SystemExit("REFUSE_ESCAPE")
        if os.path.isfile(src):
            shutil.copy(src, os.path.join(stage, name))
if os.path.isfile(conf):
    kept = []
    for raw in open(conf, encoding="utf-8", errors="replace"):
        code = raw.split("#", 1)[0].strip()
        parts = code.split()
        if len(parts) >= 2 and parts[0] == "include" and os.path.realpath(parts[1]) == os.path.realpath(dest_dir):
            continue
        kept.append(raw)
    open(existing, "w", encoding="utf-8").writelines(kept)
PY
    python_rc=$?
    set -e
    if [[ "$python_rc" -ne 0 ]]; then
      cat "$err" >&2
      if grep -q 'REFUSE_ESCAPE' "$err"; then
        rm -rf -- "$stage"
        rm -f -- "$state" "$parent" "$existing" "$err"
        printf 'REFUSE_ESCAPE\n' >&2
        return 2
      fi
      rm -rf -- "$stage"
      rm -f -- "$state" "$parent" "$existing" "$err"
      return 1
    fi
    find "$stage" -type f -exec chown root:root {} + -exec chmod 644 {} +
    # Keep top-level defaults separate: no filename can overwrite a copied snippet.
    printf 'include %s\ninclude %s\ninclude %s\n' "$existing" "$stage" "$candidate" >"$parent"
  fi
  chown root:root "$parent" "$candidate" "$existing"
  chmod 644 "$parent" "$candidate" "$existing"
  set +e
  logrotate -d -s "$state" "$parent" >"$err" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    cat "$err" >&2
    if grep -q 'duplicate log entry' "$err"; then
      rc=3
    else
      rc=1
    fi
  fi
  if [[ -n "$stage" ]]; then
    rm -rf -- "$stage"
  fi
  rm -f -- "$state" "$parent" "$existing" "$err"
  return "$rc"
}

path_stays_inside() {
  local path="$1"
  local cursor real
  case "$path" in
    "$root_real"|"$root_real"/*) ;;
    *)
      printf 'REFUSE_ESCAPE\n' >&2
      exit 2
      ;;
  esac
  cursor="$path"
  while [[ "$cursor" != "$root_real" && "$cursor" != "/" ]]; do
    if [[ -L "$cursor" ]]; then
      printf 'REFUSE_ESCAPE\n' >&2
      exit 2
    fi
    if [[ -e "$cursor" ]]; then
      real="$(realpath -- "$cursor")"
      case "$real" in
        "$root_real"|"$root_real"/*) ;;
        *)
          printf 'REFUSE_ESCAPE\n' >&2
          exit 2
          ;;
      esac
    fi
    cursor="$(dirname -- "$cursor")"
  done
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
  cand="$(mktemp)"
  cp -a -- "$DEFAULT_TEMPLATE" "$cand"
  chown root:root "$cand"
  chmod 644 "$cand"
  dry_rc=0
  combined_debug "$cand" host || dry_rc=$?
  rm -f -- "$cand"
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
import os, shlex, sys
conf, state, root, egress, watch = sys.argv[1:]
allowed = {
    "su", "daily", "maxsize", "rotate", "compress", "delaycompress",
    "missingok", "notifempty", "copytruncate", "create",
}
forbidden = (
    egress,
    watch,
    "/var/log/openclaude-v5-selfhost.log",
    "/var/log/cloudflared-v5-selfhost.log",
    "/etc/logrotate.d",
    "/var/lib/logrotate/status",
)

def boundary(path, label):
    cursor = os.path.abspath(path)
    while True:
        if os.path.islink(cursor):
            raise SystemExit("REFUSE_ESCAPE " + label)
        if cursor == root or cursor == "/":
            break
        parent = os.path.dirname(cursor)
        if parent == cursor:
            break
        cursor = parent
    real = os.path.realpath(path)
    if real != root and not real.startswith(root + os.sep):
        raise SystemExit("REFUSE_REAL_PATH " + label)

boundary(conf, "conf")
boundary(state, "state")
if not os.path.isfile(conf):
    raise SystemExit("REFUSE_REAL_PATH conf")
text = open(conf, encoding="utf-8").read()
for item in forbidden:
    if item in text:
        raise SystemExit("REFUSE_REAL_PATH " + item)
paths = []
for raw in text.splitlines():
    code = raw.split("#", 1)[0].strip()
    if not code:
        continue
    try:
        tokens = shlex.split(code, posix=True)
    except ValueError:
        raise SystemExit("REFUSE_DIRECTIVE quote")
    if not tokens:
        continue
    if tokens[-1] == "{":
        tokens = tokens[:-1]
    if not tokens or tokens in (["{"], ["}"]):
        continue
    if all(tok.startswith("/") for tok in tokens):
        for tok in tokens:
            if any(ch in tok for ch in "*?["):
                raise SystemExit("REFUSE_REAL_PATH glob")
            boundary(tok, tok)
        paths.extend(tokens)
        continue
    word = tokens[0]
    if word == "include":
        raise SystemExit("REFUSE_INCLUDE")
    if word not in allowed:
        raise SystemExit("REFUSE_DIRECTIVE " + word)
    for tok in tokens[1:]:
        if tok.startswith("/"):
            if any(ch in tok for ch in "*?["):
                raise SystemExit("REFUSE_REAL_PATH glob")
            boundary(tok, tok)
if not paths:
    raise SystemExit("REFUSE_REAL_PATH no-paths")
PY
  # Private state only. Include, scripts, and outside paths were refused above.
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
bak_dir="$root_real/var/backups/openclaude-v5-selfhost-logrotate"
# Boundary before the first mkdir, chmod, or copy. A symlink parent must not
# receive logrotate.d or the backup directory.
path_stays_inside "$dest_dir"
path_stays_inside "$bak_dir"
if [[ -L "$dest_dir" || -L "$bak_dir" || -L "$dest_dir/$DEST_NAME" ]]; then
  printf 'REFUSE_ESCAPE\n' >&2
  exit 2
fi
if [[ -d "$dest_dir" ]]; then
  dest_dir_real="$(realpath -- "$dest_dir")"
else
  dest_dir_real="$dest_dir"
fi
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
if [[ -e "$dest" && ! -L "$dest" ]]; then
  exclude="$(realpath -- "$dest")"
elif [[ -L "$dest" ]]; then
  printf 'REFUSE_ESCAPE\n' >&2
  exit 2
fi
scan_roots=()
if [[ -f "$root_real/etc/logrotate.conf" && ! -L "$root_real/etc/logrotate.conf" ]]; then
  scan_roots+=("$root_real/etc/logrotate.conf")
fi
if [[ -d "$dest_dir_real" && ! -L "$dest_dir_real" ]]; then
  scan_roots+=("$dest_dir_real")
fi
hits=""
if [[ "${#scan_roots[@]}" -gt 0 ]]; then
  hits="$(scan_duplicates "$exclude" "${scan_roots[@]}")"
fi
if [[ -n "$hits" ]]; then
  printf '%s\n' "$hits" >&2
  printf 'DUPLICATE\n' >&2
  exit 3
fi

cand="$(mktemp)"
cp -a -- "$template" "$cand"
chown root:root "$cand"
chmod 644 "$cand"
combined_rc=0
combined_debug "$cand" "$root_real" || combined_rc=$?
rm -f -- "$cand"
case "$combined_rc" in
  0) ;;
  2) exit 2 ;;
  3)
    printf 'DUPLICATE\n' >&2
    exit 3
    ;;
  *)
    printf 'COMBINED_FAIL\n' >&2
    exit 1
    ;;
esac

sha_before="none"
backup="none"
if [[ -f "$dest" && ! -L "$dest" ]]; then
  mkdir -p -- "$bak_dir"
  path_stays_inside "$bak_dir"
  bak_real="$(realpath -- "$bak_dir")"
  case "$bak_real" in
    "$root_real"/*) ;;
    *)
      printf 'REFUSE_ESCAPE\n' >&2
      exit 2
      ;;
  esac
  backup="$bak_real/${DEST_NAME}.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a -- "$dest" "$backup"
  sha_before="$(sha256sum "$dest" | awk 'NR==1 {print $1}')"
fi

mkdir -p -- "$dest_dir"
path_stays_inside "$dest_dir"
dest_dir_real="$(realpath -- "$dest_dir")"
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
chmod 755 "$dest_dir_real"
dest="$dest_dir_real/$DEST_NAME"

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
sha_after="$(sha256sum "$tmp" | awk 'NR==1 {print $1}')"
mv -T -- "$tmp" "$dest"
trap - EXIT
printf 'SHA_BEFORE=%s\n' "$sha_before"
printf 'SHA_AFTER=%s\n' "$sha_after"
printf 'BACKUP=%s\n' "$backup"
printf 'INSTALLED=%s\n' "$dest"
