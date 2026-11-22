#!/usr/bin/env bash
# Commercial deploy-v5.sh local input-digest gate cache & frontend tsbuildinfo helpers.
# Evidence only: any cache error or miss runs the original gate. Never inherit acceptance
# across invocations. Loaded by scripts/deploy-v5.sh in place.

COMMERCIAL_GATE_CACHE_READY=0
COMMERCIAL_GATE_PLAN_FILE=""
COMMERCIAL_GATE_CACHE_SHA=""

commercial_gate_cache_reset() {
  COMMERCIAL_GATE_CACHE_READY=0
  COMMERCIAL_GATE_PLAN_FILE=""
  COMMERCIAL_GATE_CACHE_SHA=""
}

commercial_gate_cache_helper_path() {
  local src="${BASH_SOURCE[0]:-}" dir=""
  if [[ -n "$src" && -f "$(dirname -- "$src")/v5-commercial-local-gate-cache.py" ]]; then
    dir="$(cd "$(dirname -- "$src")" && pwd)"
    printf '%s/v5-commercial-local-gate-cache.py' "$dir"
    return 0
  fi
  if [[ -n "${SCRIPT_DIR:-}" && -f "$SCRIPT_DIR/lib/v5-commercial-local-gate-cache.py" ]]; then
    printf '%s/lib/v5-commercial-local-gate-cache.py' "$SCRIPT_DIR"
    return 0
  fi
  return 1
}

commercial_resolve_master_bun_id() {
  # Match exact Bun lookup in packages/gateway/src/__tests__/cc5BashTimeoutProof.test.ts:38-56:
  # first existing path in [OC_BUN_BIN, BUN_BIN, ...PATH/bun, /usr/local/bin/bun,
  # /usr/bin/bun, ~/.local/bin/bun, ~/.bun/bin/bun]. Never skip an existing non-executable
  # candidate (fail-closed to empty -> cache miss).
  local -a cands=()
  local dir="" cand="" ver="" real=""
  [[ -n "${OC_BUN_BIN:-}" ]] && cands+=("$OC_BUN_BIN")
  [[ -n "${BUN_BIN:-}" ]] && cands+=("$BUN_BIN")
  local IFS=':'
  for dir in ${PATH:-}; do
    [[ -n "$dir" ]] && cands+=("${dir}/bun")
  done
  unset IFS
  cands+=("/usr/local/bin/bun" "/usr/bin/bun")
  [[ -n "${HOME:-}" ]] && cands+=("${HOME}/.local/bin/bun" "${HOME}/.bun/bin/bun")
  for cand in "${cands[@]}"; do
    [[ -e "$cand" ]] || continue
    if [[ -x "$cand" ]] && ver="$("$cand" --version 2>/dev/null)" && [[ -n "$ver" ]]; then
      real="$(readlink -f -- "$cand" 2>/dev/null || printf '%s' "$cand")"
      printf '%s:%s' "$real" "$ver"
      return 0
    fi
    return 1
  done
  return 1
}

commercial_resolve_codex_bun_id() {
  # Match exact Bun lookup in scripts/check-v5-codex-late-stop-proof.sh:6-8:
  # command -v bun -> fallback $HOME/.bun/bin/bun. Never consult OC_BUN_BIN/BUN_BIN.
  local cand="" ver="" real=""
  cand="$(command -v bun 2>/dev/null || true)"
  [[ -n "$cand" ]] || cand="${HOME:+${HOME}/.bun/bin/bun}"
  if [[ -n "$cand" && -x "$cand" ]] && ver="$("$cand" --version 2>/dev/null)" && [[ -n "$ver" ]]; then
    real="$(readlink -f -- "$cand" 2>/dev/null || printf '%s' "$cand")"
    printf '%s:%s' "$real" "$ver"
    return 0
  fi
  return 1
}

# Terminate one or more PID subtrees (SIGTERM -> wait -> SIGKILL -> wait) using /proc
# descendant enumeration so multi-layer subshells and reparented workers are fully dead
# before callers delete scratch directories.
commercial_kill_pid_tree() { # <pid> [pid...]
  (( $# > 0 )) || return 0
  PYTHONDONTWRITEBYTECODE=1 python3 - "$@" <<'PY' 2>/dev/null || true
import os
import signal
import sys
import time

roots = [int(a) for a in sys.argv[1:] if a.isdigit() and int(a) > 1]
if not roots:
    raise SystemExit(0)

self_pid = os.getpid()

def snapshot_children() -> dict[int, list[int]]:
    children: dict[int, list[int]] = {}
    try:
        entries = os.listdir("/proc")
    except OSError:
        return children
    for name in entries:
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            with open(f"/proc/{pid}/status", "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if line.startswith("PPid:"):
                        ppid = int(line.split(":", 1)[1].strip())
                        children.setdefault(ppid, []).append(pid)
                        break
        except OSError:
            continue
    return children

def is_alive(pid: int) -> bool:
    if pid <= 1 or pid == self_pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        with open(f"/proc/{pid}/status", "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.startswith("State:"):
                    return not line.split(":", 1)[1].strip().startswith("Z")
    except OSError:
        return False
    return True

def expand_seen(seen: set[int]) -> None:
    cmap = snapshot_children()
    queue = list(seen)
    while queue:
        cur = queue.pop()
        for ch in cmap.get(cur, ()):
            if ch != self_pid and ch not in seen:
                seen.add(ch)
                queue.append(ch)

seen: set[int] = set(roots)
expand_seen(seen)

def signal_all(sig: int) -> None:
    expand_seen(seen)
    for pid in list(seen):
        if pid != self_pid:
            try:
                os.kill(pid, sig)
            except OSError:
                pass

signal_all(signal.SIGTERM)
deadline = time.monotonic() + 1.5
while time.monotonic() < deadline:
    expand_seen(seen)
    if not any(is_alive(p) for p in seen):
        raise SystemExit(0)
    time.sleep(0.05)

signal_all(signal.SIGKILL)
kill_deadline = time.monotonic() + 2.0
while time.monotonic() < kill_deadline:
    expand_seen(seen)
    if not any(is_alive(p) for p in seen):
        raise SystemExit(0)
    time.sleep(0.05)
PY
  return 0
}

# Verify that every @openclaude/* workspace symlink inside <root>/node_modules resolves
# strictly inside <root>/packages/..., plus the cheap runtime dependency pre-checks
# (tsx loader + better-sqlite3 resolution from packages/gateway) matching
# scripts/check-v5-cron-submit-boundary.ts:verifyPinnedWorkspace. Runs unconditionally on
# every build_release invocation (~50ms) even when behavioral proof receipts hit.
commercial_verify_pinned_workspaces_local() { # <repo-or-staging-root>
  local root="$1"
  python3 - "$root" <<'PY' || return 1
import json
import os
import sys

root = os.path.realpath(sys.argv[1])
pkg_path = os.path.join(root, "package.json")
if not os.path.isfile(pkg_path):
    sys.stderr.write(f"FATAL: pinned workspace check: missing {pkg_path}\n")
    raise SystemExit(1)

with open(pkg_path, "r", encoding="utf-8") as fh:
    root_pkg = json.load(fh)

workspaces = root_pkg.get("workspaces") or []
expected = {}
for ws in workspaces:
    if not isinstance(ws, str) or "*" in ws:
        continue
    ws_dir = os.path.realpath(os.path.join(root, ws))
    if not (ws_dir == root or ws_dir.startswith(root + os.sep)):
        sys.stderr.write(f"FATAL: workspace dir escaped pinned tree: {ws} -> {ws_dir}\n")
        raise SystemExit(1)
    ws_pkg_file = os.path.join(ws_dir, "package.json")
    if not os.path.isfile(ws_pkg_file):
        sys.stderr.write(f"FATAL: missing workspace manifest: {ws_pkg_file}\n")
        raise SystemExit(1)
    with open(ws_pkg_file, "r", encoding="utf-8") as wfh:
        wdoc = json.load(wfh)
    name = wdoc.get("name")
    if isinstance(name, str) and name.startswith("@openclaude/"):
        expected[name.split("/", 1)[1]] = ws_dir

scope_dir = os.path.join(root, "node_modules", "@openclaude")
if not os.path.isdir(scope_dir):
    sys.stderr.write(f"FATAL: missing pinned @openclaude scope dir: {scope_dir}\n")
    raise SystemExit(1)

for short_name, want_dir in sorted(expected.items()):
    link_path = os.path.join(scope_dir, short_name)
    if not os.path.exists(link_path):
        sys.stderr.write(f"FATAL: missing @openclaude/{short_name} in {scope_dir}\n")
        raise SystemExit(1)
    actual_dir = os.path.realpath(link_path)
    if actual_dir != want_dir:
        sys.stderr.write(
            f"FATAL: @openclaude/{short_name} escaped pinned tree: actual={actual_dir} want={want_dir}\n"
        )
        raise SystemExit(1)

for entry in os.listdir(scope_dir):
    full = os.path.join(scope_dir, entry)
    actual = os.path.realpath(full)
    if not (actual == root or actual.startswith(root + os.sep)):
        sys.stderr.write(f"FATAL: @openclaude/{entry} escaped pinned tree: {actual} (root={root})\n")
        raise SystemExit(1)

tsx_loader = os.path.join(root, "node_modules", "tsx", "dist", "loader.mjs")
if not os.path.isfile(tsx_loader):
    sys.stderr.write(f"FATAL: tsx loader missing: {tsx_loader}\n")
    raise SystemExit(1)
tsx_real = os.path.realpath(tsx_loader)
if not tsx_real.startswith(root + os.sep):
    sys.stderr.write(f"FATAL: tsx loader escaped pinned tree: {tsx_real} (root={root})\n")
    raise SystemExit(1)
PY
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = fs.realpathSync(process.argv[1]);
const gwPkg = path.join(root, "packages", "gateway", "package.json");
if (!fs.existsSync(gwPkg)) {
  process.stderr.write(`FATAL: missing gateway package.json: ${gwPkg}\n`);
  process.exit(1);
}
const req = createRequire(gwPkg);
let sqlite;
try {
  sqlite = fs.realpathSync(req.resolve("better-sqlite3"));
} catch (err) {
  process.stderr.write(`FATAL: better-sqlite3 unreadable under ${process.execPath} ${process.version}: ${err.message}\n`);
  process.exit(1);
}
if (!sqlite.startsWith(root + path.sep)) {
  process.stderr.write(`FATAL: better-sqlite3 escaped pinned tree: ${sqlite} (root=${root})\n`);
  process.exit(1);
}
' "$root"
}

commercial_verify_pinned_workspaces_remote() { # <remote-staging-root>
  local staging="$1"
  {
    declare -f commercial_verify_pinned_workspaces_local
    printf 'commercial_verify_pinned_workspaces_local "$1"\n'
  } | ssh "$KL_HOST" bash -s -- "$staging"
}

commercial_gate_cache_prepare() { # <exact-sha> <work-tmpdir> <remote-node-ver>
  local sha="$1" tmpdir="$2" remote_node_ver="${3:-}" helper cache_dir plan_file
  local node_ver npm_ver py_ver master_bun_id="" codex_bun_id="" img_ref="" stats
  commercial_gate_cache_reset
  [[ "${OC_V5_COMMERCIAL_LOCAL_GATE_CACHE:-1}" == 1 ]] || return 0
  [[ "${DRY:-0}" != 1 ]] || return 0
  [[ -n "${REPO_ROOT:-}" && -n "$tmpdir" && -d "$tmpdir" ]] || return 0
  helper="$(commercial_gate_cache_helper_path)" || return 0
  git -C "$REPO_ROOT" cat-file -e "${sha}^{commit}" 2>/dev/null || return 0
  node_ver="$(node --version 2>/dev/null)" || return 0
  npm_ver="$(npm --version 2>/dev/null)" || return 0
  py_ver="$(python3 --version 2>/dev/null)" || return 0
  master_bun_id="$(commercial_resolve_master_bun_id 2>/dev/null || true)"
  codex_bun_id="$(commercial_resolve_codex_bun_id 2>/dev/null || true)"
  img_ref="${RUNTIME_IMAGE_REF:-${RUNTIME_IMAGE:-}}"
  cache_dir="${OC_V5_COMMERCIAL_GATE_CACHE_DIR:-/var/lib/openclaude-v5-commercial/gate-receipts}"
  plan_file="$tmpdir/commercial-gate-plan.json"
  if stats="$(PYTHONDONTWRITEBYTECODE=1 python3 "$helper" plan \
      "$cache_dir" "$REPO_ROOT" "$sha" "$plan_file" \
      "$node_ver" "$remote_node_ver" "$npm_ver" "$py_ver" \
      "$img_ref" "${RUNTIME_IMAGE_ID:-}" "$master_bun_id" "$codex_bun_id" \
      "${OC_V5_FORCE_LOCAL_GATES:-0}")"; then
    COMMERCIAL_GATE_CACHE_READY=1
    COMMERCIAL_GATE_PLAN_FILE="$plan_file"
    COMMERCIAL_GATE_CACHE_SHA="$sha"
    echo "  · commercial gate input-digest cache ready ($stats hits @ ${sha:0:12})" >&2
  else
    echo "  · commercial gate input-digest cache unavailable → running all proofs" >&2
  fi
  return 0
}

commercial_gate_cache_has() { # <gate-id> <exact-sha>
  local gate_id="$1" sha="$2" helper ref=""
  [[ "${COMMERCIAL_GATE_CACHE_READY:-0}" == 1 && "${COMMERCIAL_GATE_CACHE_SHA:-}" == "$sha" \
    && -n "${COMMERCIAL_GATE_PLAN_FILE:-}" ]] || return 1
  helper="$(commercial_gate_cache_helper_path)" || return 1
  if ref="$(PYTHONDONTWRITEBYTECODE=1 python3 "$helper" has "$COMMERCIAL_GATE_PLAN_FILE" "$sha" "$gate_id")"; then
    echo "  ✓ [$gate_id] reuse verified local input receipt ($ref)" >&2
    return 0
  fi
  return 1
}

commercial_gate_cache_record() { # <gate-id> <exact-sha>
  local gate_id="$1" sha="$2" helper
  [[ "${COMMERCIAL_GATE_CACHE_READY:-0}" == 1 && "${COMMERCIAL_GATE_CACHE_SHA:-}" == "$sha" \
    && -n "${COMMERCIAL_GATE_PLAN_FILE:-}" ]] || return 0
  helper="$(commercial_gate_cache_helper_path)" || return 0
  PYTHONDONTWRITEBYTECODE=1 python3 "$helper" record "$COMMERCIAL_GATE_PLAN_FILE" "$sha" "$gate_id" \
    || echo "  ⚠ [$gate_id] commercial gate receipt write skipped" >&2
  return 0
}

# Seed warm packages/web-react/tsconfig.tsbuildinfo into remote staging on KL_HOST.
# Mirrors selfhost OCV5-775 security contract: O_NOFOLLOW, per-component dir_fd trust
# check (owner == euid, not group/other writable), private inode copy with utime(0,0),
# atomic rename. Best-effort: failure cleanly falls back to cold tsc -b.
commercial_seed_remote_frontend_buildinfo() { # <staging> <current-release>
  local staging="$1" cur="${2:-}" cache_dir="${OC_V5_TSC_CACHE_DIR:-${RELEASES_ROOT}/.tsc-cache}"
  [[ "${OC_V5_FRONTEND_BUILDINFO_SEED:-1}" == 1 && "${DRY:-0}" != 1 ]] || return 0
  ssh "$KL_HOST" python3 - "$staging" "$cur" "$RELEASES_ROOT" "$cache_dir" <<'PY' || true
import os
from pathlib import Path
import shutil
import stat
import sys

staging, cur_rel, releases_root, cache_raw = sys.argv[1:5]
euid = os.geteuid()
MAX_BYTES = 64 * 1024 * 1024
O_DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
O_FILE_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)

def dir_stat_trusted(st: os.stat_result, allow_root_sticky: bool) -> bool:
    if not stat.S_ISDIR(st.st_mode):
        return False
    if st.st_uid == euid and (st.st_mode & 0o022) == 0:
        return True
    if allow_root_sticky and st.st_uid == 0:
        return (st.st_mode & 0o022) == 0 or (st.st_mode & stat.S_ISVTX) != 0
    return False

def open_trusted_dir_fd(raw_path: str, is_cache_path: bool, tail_strict_depth: int = 1) -> int | None:
    p = Path(raw_path)
    if not p.is_absolute() or ".." in p.parts or "." in p.parts:
        return None
    parts = p.parts[1:]
    strict_from = max(0, len(parts) - tail_strict_depth)
    try:
        fd = os.open("/", O_DIR_FLAGS)
    except OSError:
        return None
    try:
        allow_sticky_root = not (is_cache_path and euid == 0) and len(parts) > tail_strict_depth
        if not dir_stat_trusted(os.fstat(fd), allow_root_sticky=allow_sticky_root):
            os.close(fd)
            return None
        for idx, comp in enumerate(parts):
            allow_sticky = (not (is_cache_path and euid == 0)) and (idx < strict_from)
            nxt = os.open(comp, O_DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nxt
            if not dir_stat_trusted(os.fstat(fd), allow_root_sticky=allow_sticky):
                os.close(fd)
                return None
        return fd
    except OSError:
        os.close(fd)
        return None

def valid_file_stat(st: os.stat_result) -> bool:
    return (
        stat.S_ISREG(st.st_mode)
        and st.st_uid == euid
        and (st.st_mode & 0o022) == 0
        and 0 < st.st_size <= MAX_BYTES
    )

dest_fd = open_trusted_dir_fd(f"{staging}/packages/web-react", is_cache_path=False, tail_strict_depth=3)
if dest_fd is None:
    raise SystemExit(0)

open_fds: list[int] = []
candidates: list[tuple[int, int, int, str]] = []
try:
    def add_cand(dir_path: str, filename: str, prio: int, is_cache: bool, strict_depth: int) -> None:
        dfd = open_trusted_dir_fd(dir_path, is_cache_path=is_cache, tail_strict_depth=strict_depth)
        if dfd is None:
            return
        try:
            st = os.stat(filename, dir_fd=dfd, follow_symlinks=False)
        except OSError:
            os.close(dfd)
            return
        if not valid_file_stat(st):
            os.close(dfd)
            return
        open_fds.append(dfd)
        candidates.append((st.st_mtime_ns, prio, dfd, filename))

    if cache_raw:
        add_cand(cache_raw, "web-react.tsbuildinfo", prio=3, is_cache=True, strict_depth=1)
    if cur_rel:
        add_cand(f"{cur_rel}/packages/web-react", "tsconfig.tsbuildinfo", prio=2, is_cache=False, strict_depth=3)
    if releases_root:
        rr = Path(releases_root)
        if not rr.is_symlink() and rr.is_dir():
            rels: list[tuple[int, Path]] = []
            try:
                for entry in rr.iterdir():
                    if entry.name.startswith("rel-") and not entry.is_symlink() and entry.is_dir():
                        if (entry / ".complete").is_file() and not (entry / ".complete").is_symlink():
                            rels.append((entry.stat().st_mtime_ns, entry))
            except OSError:
                rels = []
            rels.sort(key=lambda x: x[0], reverse=True)
            for _mt, rpath in rels[:4]:
                add_cand(f"{rpath}/packages/web-react", "tsconfig.tsbuildinfo", prio=1, is_cache=False, strict_depth=3)

    for _mt, _prio, src_dfd, fname in sorted(candidates, key=lambda x: (x[0], x[1]), reverse=True):
        rfd = -1
        try:
            rfd = os.open(fname, O_FILE_FLAGS, dir_fd=src_dfd)
            if not valid_file_stat(os.fstat(rfd)):
                continue
            tmp_name = f".tsbuildinfo.seed-{os.urandom(8).hex()}"
            wfd = os.open(tmp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=dest_fd)
            try:
                with os.fdopen(rfd, "rb") as fin, os.fdopen(wfd, "wb") as fout:
                    rfd = -1
                    wfd = -1
                    shutil.copyfileobj(fin, fout, length=1024 * 1024)
                    fout.flush()
                    os.chmod(fout.fileno(), 0o644)
                    os.utime(fout.fileno(), (0, 0))
                os.rename(tmp_name, "tsconfig.tsbuildinfo", src_dir_fd=dest_fd, dst_dir_fd=dest_fd)
                sys.stderr.write(f"  · seeded warm frontend tsbuildinfo ({fname})\n")
                break
            except BaseException:
                if wfd >= 0:
                    os.close(wfd)
                try:
                    os.unlink(tmp_name, dir_fd=dest_fd)
                except OSError:
                    pass
                raise
        except OSError:
            continue
        finally:
            if rfd >= 0:
                os.close(rfd)
finally:
    for dfd in open_fds:
        os.close(dfd)
    os.close(dest_fd)
PY
}

commercial_save_remote_frontend_buildinfo() { # <staging>
  local staging="$1" cache_dir="${OC_V5_TSC_CACHE_DIR:-${RELEASES_ROOT}/.tsc-cache}"
  [[ "${OC_V5_FRONTEND_BUILDINFO_SEED:-1}" == 1 && "${DRY:-0}" != 1 ]] || return 0
  ssh "$KL_HOST" python3 - "$staging" "$cache_dir" <<'PY' || true
import os
from pathlib import Path
import shutil
import stat
import sys

staging, cache_raw = sys.argv[1:3]
euid = os.geteuid()
MAX_BYTES = 64 * 1024 * 1024
O_DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
O_FILE_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)

def dir_stat_trusted(st: os.stat_result, allow_root_sticky: bool) -> bool:
    if not stat.S_ISDIR(st.st_mode):
        return False
    if st.st_uid == euid and (st.st_mode & 0o022) == 0:
        return True
    if allow_root_sticky and st.st_uid == 0:
        return (st.st_mode & 0o022) == 0 or (st.st_mode & stat.S_ISVTX) != 0
    return False

def open_trusted_dir_fd(raw_path: str, create_last: bool, is_cache_path: bool, tail_strict_depth: int = 1) -> int:
    p = Path(raw_path)
    if not p.is_absolute() or ".." in p.parts or "." in p.parts:
        raise ValueError("non-canonical path")
    parts = p.parts[1:]
    strict_from = max(0, len(parts) - tail_strict_depth)
    dir_mode = 0o755 if euid == 0 else 0o700
    fd = os.open("/", O_DIR_FLAGS)
    try:
        allow_sticky_root = not (is_cache_path and euid == 0) and len(parts) > tail_strict_depth
        if not dir_stat_trusted(os.fstat(fd), allow_root_sticky=allow_sticky_root):
            raise ValueError("untrusted root")
        for idx, comp in enumerate(parts):
            allow_sticky = (not (is_cache_path and euid == 0)) and (idx < strict_from)
            if create_last and idx == len(parts) - 1:
                try:
                    os.mkdir(comp, dir_mode, dir_fd=fd)
                except FileExistsError:
                    pass
            nxt = os.open(comp, O_DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nxt
            if not dir_stat_trusted(os.fstat(fd), allow_root_sticky=allow_sticky):
                raise ValueError(f"untrusted dir: {comp}")
        return fd
    except BaseException:
        os.close(fd)
        raise

try:
    src_fd = open_trusted_dir_fd(f"{staging}/packages/web-react", False, False, 3)
except (OSError, ValueError):
    raise SystemExit(0)

rfd = -1
try:
    try:
        rfd = os.open("tsconfig.tsbuildinfo", O_FILE_FLAGS, dir_fd=src_fd)
    except OSError:
        raise SystemExit(0)
    st = os.fstat(rfd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != euid or (st.st_mode & 0o022) != 0 or st.st_size <= 0 or st.st_size > MAX_BYTES:
        raise SystemExit(0)
    cdir_fd = open_trusted_dir_fd(cache_raw, True, True, 1)
    try:
        file_mode = 0o644 if euid == 0 else 0o600
        tmp_name = f".web-react.tsbuildinfo.tmp-{os.urandom(8).hex()}"
        wfd = os.open(tmp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=cdir_fd)
        try:
            with os.fdopen(rfd, "rb") as fin, os.fdopen(wfd, "wb") as fout:
                rfd = -1
                wfd = -1
                shutil.copyfileobj(fin, fout, length=1024 * 1024)
                fout.flush()
                os.fsync(fout.fileno())
                os.chmod(fout.fileno(), file_mode)
            os.rename(tmp_name, "web-react.tsbuildinfo", src_dir_fd=cdir_fd, dst_dir_fd=cdir_fd)
        except BaseException:
            if wfd >= 0:
                os.close(wfd)
            try:
                os.unlink(tmp_name, dir_fd=cdir_fd)
            except OSError:
                pass
            raise
    finally:
        os.close(cdir_fd)
finally:
    if rfd >= 0:
        os.close(rfd)
    os.close(src_fd)
PY
}
