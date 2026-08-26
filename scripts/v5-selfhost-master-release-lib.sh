#!/usr/bin/env bash
# v5-selfhost-master-release-lib.sh — 阶段 1:只建不可变 master release,不切 live。
# 由 deploy-v5-selfhost.sh source。禁止在已有 rel-* 里 npm ci;半成品永不叫 rel-*。
# 日志一律 stderr,避免将来落入命令替换。

# 独立于 runtime-releases。不要跟 /var/lib/openclaude-v5-selfhost/runtime-releases 混用。
MASTER_RELEASES_ROOT="${MASTER_RELEASES_ROOT:-/opt/openclaude/openclaude-v5-selfhost-releases}"
MASTER_LIVE_LINK="${MASTER_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}"
MASTER_RELEASE_COMPLETE_SCHEMA_VERSION=2
# 内部变量无条件清空,不继承环境。继承的 MASTER_STAGING 曾让 --status 的 EXIT
# 无边界 rm -rf 任意目录(含 git 工作树 / 仍被 bind 的 release)。
MASTER_STAGING=""
MASTER_STAGING_DEV=""
MASTER_STAGING_INO=""
BUILT_MASTER_RELEASE="${BUILT_MASTER_RELEASE:-}"
MASTER_DEPS_MODE="${MASTER_DEPS_MODE:-}"
MASTER_DEPS_ELAPSED_S="${MASTER_DEPS_ELAPSED_S:-}"
MASTER_FRONTEND_ELAPSED_S="${MASTER_FRONTEND_ELAPSED_S:-}"
BREAKGLASS_ROOT="${BREAKGLASS_ROOT:-/opt/openclaude/v5-selfhost-breakglass}"
CUTOVER_GRACE_FILE="${CUTOVER_GRACE_FILE:-/run/openclaude-v5-selfhost/cutover-grace-until}"
CUTOVER_GRACE_SEC="${CUTOVER_GRACE_SEC:-90}"
CUTOVER_HAS_MIGRATION="${CUTOVER_HAS_MIGRATION:-0}"
CUTOVER_MIGRATION_FILES="${CUTOVER_MIGRATION_FILES:-}"
CUTOVER_UNIT_SNAP="${CUTOVER_UNIT_SNAP:-}"
SURVIVOR_STATE="${SURVIVOR_STATE:-/run/openclaude-v5-selfhost/cutover-survivor.state}"
SURVIVOR_COMMITTED="${SURVIVOR_COMMITTED:-/run/openclaude-v5-selfhost/cutover-survivor.committed}"

mlog() { echo "$*" >&2; }

# 只允许删除「本进程创建、仍是同一 inode」的 ${MASTER_RELEASES_ROOT}/.staging-*。
# 任何规范化失败 / 越界 / inode 漂移 → 拒绝 rm。
cleanup_master_staging() {
  local candidate canon root_canon parent parent_dev root_dev st_dev st_ino
  local live_canon worktree_canon
  candidate="${MASTER_STAGING:-}"
  MASTER_STAGING=""
  if [[ -z "$candidate" ]]; then
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  if [[ ! -d "$candidate" ]]; then
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  canon="$(readlink -f -- "$candidate" 2>/dev/null || true)"
  root_canon="$(readlink -f -- "$MASTER_RELEASES_ROOT" 2>/dev/null || true)"
  if [[ -z "$canon" || -z "$root_canon" || ! -d "$canon" || ! -d "$root_canon" ]]; then
    mlog "cleanup: 无法规范化 staging/releases root,拒绝 rm candidate=$candidate"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  case "$canon" in
    "${root_canon}"/.staging-*) ;;
    *)
      mlog "cleanup: 拒绝 rm 非 ${root_canon}/.staging-* 路径: $canon"
      MASTER_STAGING_DEV=""
      MASTER_STAGING_INO=""
      return 0
      ;;
  esac
  if [[ "$canon" == "$root_canon" ]]; then
    mlog "cleanup: 拒绝 rm releases root"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  live_canon="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
  worktree_canon="$(readlink -f -- "${REPO_ROOT:-}" 2>/dev/null || true)"
  if [[ -n "$live_canon" && "$canon" == "$live_canon" ]]; then
    mlog "cleanup: 拒绝 rm live 目标 $canon"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  if [[ -n "$worktree_canon" && "$canon" == "$worktree_canon" ]]; then
    mlog "cleanup: 拒绝 rm 工作树 $canon"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  parent="$(dirname -- "$canon")"
  if [[ "$parent" != "$root_canon" ]]; then
    mlog "cleanup: parent=$parent 不是 releases root,拒绝 rm"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  parent_dev="$(stat -c '%d' -- "$parent" 2>/dev/null || true)"
  root_dev="$(stat -c '%d' -- "$root_canon" 2>/dev/null || true)"
  if [[ -z "$parent_dev" || "$parent_dev" != "$root_dev" ]]; then
    mlog "cleanup: parent/dev 与 releases root 不一致,拒绝 rm"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  st_dev="$(stat -c '%d' -- "$canon" 2>/dev/null || true)"
  st_ino="$(stat -c '%i' -- "$canon" 2>/dev/null || true)"
  if [[ -n "${MASTER_STAGING_DEV:-}" && -n "${MASTER_STAGING_INO:-}" ]]; then
    if [[ "$st_dev" != "$MASTER_STAGING_DEV" || "$st_ino" != "$MASTER_STAGING_INO" ]]; then
      mlog "cleanup: inode/dev 与创建时不一致,拒绝 rm (now=$st_dev:$st_ino want=$MASTER_STAGING_DEV:$MASTER_STAGING_INO)"
      MASTER_STAGING_DEV=""
      MASTER_STAGING_INO=""
      return 0
    fi
  fi
  mlog "  清理未完成的 staging: $canon"
  rm -rf -- "$canon"
  MASTER_STAGING_DEV=""
  MASTER_STAGING_INO=""
}

# 商业版 release_artifact_digest 的本地化抄本(无 SSH)。.complete 不计入。
release_artifact_digest() { # <absolute-release-root>
  local root="$1"
  [[ -d "$root" && ! -L "$root" ]] || {
    echo "FATAL: release artifact root 非真实目录:$root" >&2
    return 1
  }
  python3 - "$root" <<'PY'
import hashlib
import os
import stat
import sys

root = os.fsencode(os.path.abspath(sys.argv[1]))
if not os.path.isdir(root) or os.path.islink(root):
    raise SystemExit("FATAL: release artifact root is not a real directory")

def identity(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid,
            st.st_size, st.st_mtime_ns, st.st_ctime_ns)

def snapshot_tree():
    root_stat = os.lstat(root)
    if not stat.S_ISDIR(root_stat.st_mode):
        raise RuntimeError("release artifact root changed type")
    rows = []

    def collect(directory, prefix=b""):
        with os.scandir(directory) as scan:
            for entry in scan:
                name = entry.name
                rel = name if not prefix else prefix + b"/" + name
                if rel == b".complete":
                    continue
                st = entry.stat(follow_symlinks=False)
                mode = st.st_mode
                if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode)):
                    raise RuntimeError(f"non-regular release entry: {os.fsdecode(rel)!r}")
                rows.append((rel, entry.path, identity(st)))
                if stat.S_ISDIR(mode):
                    collect(entry.path, rel)

    collect(root)
    rows.sort(key=lambda item: item[0])
    return identity(root_stat), rows

root_before, entries = snapshot_tree()
digest = hashlib.sha256(b"openclaude-release-artifact-v2\0")

def field(value):
    if isinstance(value, str):
        value = value.encode("ascii")
    digest.update(len(value).to_bytes(8, "big"))
    digest.update(value)

root_stat = os.lstat(root)
if identity(root_stat) != root_before:
    raise RuntimeError("release artifact root changed before digest")
field(b"D")
field(b"")
field(str(stat.S_IMODE(root_stat.st_mode)))
field(str(root_stat.st_uid))
field(str(root_stat.st_gid))

for rel, absolute, before in entries:
    st = os.lstat(absolute)
    if identity(st) != before:
        raise RuntimeError(f"release entry changed during digest: {os.fsdecode(rel)!r}")
    mode = st.st_mode
    kind = b"F" if stat.S_ISREG(mode) else b"D" if stat.S_ISDIR(mode) else b"L"
    field(kind)
    field(rel)
    field(str(stat.S_IMODE(mode)))
    field(str(st.st_uid))
    field(str(st.st_gid))
    if kind == b"F":
        field(str(st.st_size))
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(absolute, flags)
        if identity(os.fstat(fd)) != before:
            os.close(fd)
            raise RuntimeError(f"release file changed before open: {os.fsdecode(rel)!r}")
        with os.fdopen(fd, "rb", buffering=1024 * 1024) as fh:
            while chunk := fh.read(1024 * 1024):
                digest.update(chunk)
            if identity(os.fstat(fh.fileno())) != before:
                raise RuntimeError(f"release file changed while open: {os.fsdecode(rel)!r}")
    elif kind == b"L":
        field(os.readlink(absolute))
    if identity(os.lstat(absolute)) != before:
        raise RuntimeError(f"release entry changed while hashing: {os.fsdecode(rel)!r}")

root_after, entries_after = snapshot_tree()
before_signature = [(rel, before) for rel, _absolute, before in entries]
after_signature = [(rel, after) for rel, _absolute, after in entries_after]
if root_after != root_before or after_signature != before_signature:
    raise RuntimeError("release tree changed during digest")

print(digest.hexdigest())
PY
}

# 只收紧 nlink==1 的文件 + 子目录。禁止改共享 inode(会污染 donor / 工作树)。
# tsx 缓存写在 /tmp/tsx-${euid},不写 node_modules,0444 不会让 tsx 起不来。
# 保留原可执行位:nlink==1 且已有 +x 的文件用 0555,否则后续从该 rel 硬链 donor 时
# staging 内 tsc/vite 会 Permission denied。
harden_unique_release_tree() { # <staging-root>
  local root="$1"
  [[ -d "$root" && ! -L "$root" ]] || return 1
  chown 0:0 -- "$root" || return 1
  # 根目录先保持可写,以便随后落 .complete;子目录去写位。
  find "$root" -mindepth 1 -type d -print0 | xargs -0 -r chmod 0555
  find "$root" -type f -links 1 -perm /111 -print0 | xargs -0 -r chmod 0555
  find "$root" -type f -links 1 ! -perm /111 -print0 | xargs -0 -r chmod 0444
}

# 从已 harden 的 donor 硬链过来后,tsc/vite 可能是 0444。不能 chmod 共享 inode。
# 把不可执行的工具链文件拆成 staging 私有副本再 +x,donor 不变。
break_hardlink_restore_exec() { # <staging>
  local staging="$1"
  python3 - "$staging" <<'PY'
import os
import shutil
import stat
import sys

root = os.path.abspath(sys.argv[1])
broken = 0
scan_roots = [os.path.join(root, "node_modules")]
pkg = os.path.join(root, "packages")
if os.path.isdir(pkg):
    for name in os.listdir(pkg):
        cand = os.path.join(pkg, name, "node_modules")
        if os.path.isdir(cand):
            scan_roots.append(cand)
bin_dirs = []
for start in scan_roots:
    for dirpath, dirnames, _filenames in os.walk(start, followlinks=False):
        if os.path.basename(dirpath) == ".bin":
            bin_dirs.append(dirpath)
            dirnames[:] = []
for bdir in bin_dirs:
    try:
        names = os.listdir(bdir)
    except OSError:
        continue
    for name in names:
        path = os.path.join(bdir, name)
        try:
            real = os.path.realpath(path)
            st = os.stat(real)
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode):
            continue
        if st.st_mode & 0o111:
            continue
        tmp = real + ".exectmp.%d" % os.getpid()
        shutil.copy2(real, tmp)
        os.chmod(tmp, 0o0555)
        os.replace(tmp, real)
        broken += 1
sys.stderr.write("broke-hardlink-exec=%d bin_dirs=%d\n" % (broken, len(bin_dirs)))
PY
}

write_strong_release_marker_local() { # <release-root> <full-sha> <short-sha> <builtAt> <schema>
  local root="$1" full_sha="$2" short_sha="$3" built_at="$4" schema="$5"
  local metadata_sha artifact_sha marker_tmp root_uid root_gid root_mode marker_uid marker_gid marker_mode
  [[ "$full_sha" =~ ^[0-9a-f]{40}$ && "$short_sha" =~ ^[0-9a-f]{7,40}$ \
    && "$full_sha" == "$short_sha"* && "$built_at" =~ ^[0-9]{8}-[0-9]{6}$ \
    && "$schema" =~ ^[1-9][0-9]*$ ]] || {
    echo 'FATAL: strong release identity 参数非法' >&2
    return 1
  }
  [[ -d "$root" && ! -L "$root" ]] || {
    echo 'FATAL: strong release root 非法' >&2
    return 1
  }
  chown 0:0 -- "$root" || return 1
  chmod go-w -- "$root" || return 1
  read -r root_uid root_gid root_mode < <(stat -Lc '%u %g %a' -- "$root")
  [[ "$root_uid" == 0 && "$root_gid" == 0 && $((8#$root_mode & 8#22)) -eq 0 ]] || {
    echo "FATAL: strong release root ownership/mode 不可信:$root" >&2
    return 1
  }
  test -f "$root/package.json"
  test -d "$root/node_modules"
  test -d "$root/node_modules/tsx"
  test -f "$root/VERSION.json"
  test -f "$root/packages/web-react/dist/index.html"
  test -f "$root/deploy/v5/release-metadata.json"
  grep -q 'name="oc-build"' "$root/packages/web-react/dist/index.html" \
    || { echo 'FATAL: dist/index.html 缺 oc-build meta' >&2; return 1; }
  [[ "$(jq -er '.commit | select(type == "string")' "$root/VERSION.json")" == "$short_sha" ]] || {
    echo 'FATAL: VERSION.commit 与 pinned source short SHA 不一致' >&2
    return 1
  }
  metadata_sha="$(sha256sum -- "$root/deploy/v5/release-metadata.json" | cut -d' ' -f1)"
  artifact_sha="$(release_artifact_digest "$root")"
  [[ "$metadata_sha" =~ ^[0-9a-f]{64}$ && "$artifact_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  marker_tmp="${root}.complete.$$"
  if ! jq -n \
    --argjson schemaVersion "$schema" \
    --arg sourceCommit "$full_sha" \
    --arg builtAt "$built_at" \
    --arg metadataSha256 "$metadata_sha" \
    --arg artifactSha256 "$artifact_sha" \
    '{schemaVersion:$schemaVersion,sourceCommit:$sourceCommit,builtAt:$builtAt,
      metadataSha256:$metadataSha256,artifactSha256:$artifactSha256}' >"$marker_tmp"; then
    rm -f -- "$marker_tmp"
    return 1
  fi
  chmod 0644 "$marker_tmp" || { rm -f -- "$marker_tmp"; return 1; }
  chown 0:0 "$marker_tmp" || { rm -f -- "$marker_tmp"; return 1; }
  mv -f -- "$marker_tmp" "$root/.complete" || { rm -f -- "$marker_tmp"; return 1; }
  read -r marker_uid marker_gid marker_mode < <(stat -Lc '%u %g %a' -- "$root/.complete")
  [[ "$marker_uid" == 0 && "$marker_gid" == 0 && "$marker_mode" == 644 ]] || {
    echo "FATAL: strong release marker ownership/mode 不可信:$root/.complete" >&2
    return 1
  }
  [[ "$(release_artifact_digest "$root")" == "$artifact_sha" ]] || {
    echo "FATAL: strong release tree changed while publishing marker:$root" >&2
    return 1
  }
}

release_dir_is_poisoned() { # <dir>
  local cand="$1"
  case "$cand" in
    *.poisoned) return 0 ;;
  esac
  [[ -e "$cand/.poisoned" || -e "${cand}.poisoned" ]]
}

# stdout 只打印 donor 绝对路径;找不到则 rc=1。日志走 stderr。
# 禁止用工作树当默认 donor(阶段 1 有毒 rel 就是这样来的);禁止 *.poisoned。
find_master_release_donor() { # <staging-lock>
  local staging_lock="$1" cand pinned
  [[ -f "$staging_lock" ]] || return 1
  if [[ "${FORCE_NPM_CI:-0}" == 1 ]]; then
    mlog "  --force-npm-ci:跳过硬链 donor"
    return 1
  fi
  pinned="${OC_V5_MASTER_DONOR:-}"
  if [[ -n "$pinned" ]]; then
    if release_dir_is_poisoned "$pinned"; then
      mlog "  拒绝有毒 donor pin: $pinned"
      return 1
    fi
    [[ -f "$pinned/.complete" && ! -L "$pinned/.complete" ]] || return 1
    [[ -d "$pinned/node_modules" && ! -L "$pinned/node_modules" ]] || return 1
    [[ -f "$pinned/package-lock.json" ]] || return 1
    if cmp -s "$staging_lock" "$pinned/package-lock.json"; then
      mlog "  donor=OC_V5_MASTER_DONOR $pinned"
      printf '%s\n' "$pinned"
      return 0
    fi
    mlog "  OC_V5_MASTER_DONOR lock 不匹配,忽略 $pinned"
  fi
  # 优先上一份合法 live(绝不用工作树、绝不用 .poisoned)。
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    cand="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
    if [[ -n "$cand" ]] && ! release_dir_is_poisoned "$cand" \
      && [[ -f "$cand/.complete" && ! -L "$cand/.complete" ]] \
      && [[ -d "$cand/node_modules" && ! -L "$cand/node_modules" ]] \
      && [[ -f "$cand/package-lock.json" ]] \
      && cmp -s "$staging_lock" "$cand/package-lock.json"; then
      mlog "  donor=live $cand"
      printf '%s\n' "$cand"
      return 0
    fi
    if [[ -n "$cand" ]]; then
      mlog "  live donor 不可用(缺 .complete / lock 不匹配 / poisoned),继续找其它完整 release"
    fi
  fi
  if [[ -d "$MASTER_RELEASES_ROOT" ]]; then
    while IFS= read -r cand; do
      [[ -n "$cand" ]] || continue
      if release_dir_is_poisoned "$cand"; then
        continue
      fi
      [[ -f "$cand/.complete" && ! -L "$cand/.complete" ]] || continue
      [[ -d "$cand/node_modules" && ! -L "$cand/node_modules" ]] || continue
      [[ -f "$cand/package-lock.json" ]] || continue
      if cmp -s "$staging_lock" "$cand/package-lock.json"; then
        mlog "  donor=已有 release $cand"
        printf '%s\n' "$cand"
        return 0
      fi
    done < <(find "$MASTER_RELEASES_ROOT" -mindepth 1 -maxdepth 1 -type d \
      -name 'rel-*' ! -name '*.poisoned' -printf '%T@\t%p\n' \
      | sort -nr | cut -f2-)
  fi
  if [[ "${OC_V5_ALLOW_WORKTREE_DONOR:-0}" == 1 ]] \
    && [[ -d "${REPO_ROOT:-}/node_modules" && -f "${REPO_ROOT:-}/package-lock.json" ]] \
    && cmp -s "$staging_lock" "$REPO_ROOT/package-lock.json"; then
    mlog "  donor=工作树 $REPO_ROOT (OC_V5_ALLOW_WORKTREE_DONOR=1;绝不 chmod 其共享 inode)"
    printf '%s\n' "$REPO_ROOT"
    return 0
  fi
  return 1
}

assert_master_releases_disk() {
  local parent avail_kb
  parent="$(dirname -- "$MASTER_RELEASES_ROOT")"
  mkdir -p -- "$parent"
  avail_kb="$(df -Pk -- "$parent" | awk 'NR==2 {print $4}')"
  [[ "$avail_kb" =~ ^[0-9]+$ ]] || die "无法读取磁盘剩余空间"
  # 一份冷装表观 ~1.8G + staging 峰值,留 8G 余量。
  if (( avail_kb < 8 * 1024 * 1024 )); then
    die "根盘可用 ${avail_kb}KiB < 8GiB,拒绝构建 master release。补救:先腾空间。"
  fi
}

write_master_version_json() { # <staging> <short-sha>
  local staging="$1" short_sha="$2" built_iso tmp
  built_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$staging/VERSION.json.tmp.$$"
  jq -n \
    --arg tag "v5-$short_sha" \
    --arg commit "$short_sha" \
    --arg channel "v5" \
    --arg builtAt "$built_iso" \
    '{tag:$tag,commit:$commit,channel:$channel,builtAt:$builtAt}' >"$tmp" \
    || { rm -f -- "$tmp"; return 1; }
  chmod 0644 "$tmp"
  chown 0:0 "$tmp"
  mv -f -- "$tmp" "$staging/VERSION.json"
}

# 构建一份可运行的 master release。不装 unit、不切 symlink、不迁库、不重启。
# 成功后 BUILT_MASTER_RELEASE 指向 rel-* 绝对路径。
build_master_release() {
  local full_sha short_sha ts staging reldir donor t0 t1 build_id
  BUILT_MASTER_RELEASE=""
  MASTER_DEPS_MODE=""
  MASTER_DEPS_ELAPSED_S=""
  MASTER_FRONTEND_ELAPSED_S=""

  full_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  [[ "$full_sha" =~ ^[0-9a-f]{40}$ ]] || die "HEAD 不是 40 位 hex: $full_sha"
  short_sha="$(git -C "$REPO_ROOT" rev-parse --short=9 "$full_sha")"
  ts="$(date -u +%Y%m%d-%H%M%S)"
  staging="$MASTER_RELEASES_ROOT/.staging-${short_sha}-$$-${ts}"
  reldir="$MASTER_RELEASES_ROOT/rel-${short_sha}-${ts}"

  mlog "── build_master_release staging→$reldir (pinned $short_sha) ──"
  if [[ "${DRY:-0}" == 1 ]]; then
    mlog "  [dry-run] git archive HEAD → $staging; 硬链或 npm ci; staging vite; .complete; mv -T → $reldir"
    BUILT_MASTER_RELEASE="$reldir"
    return 0
  fi

  assert_master_releases_disk
  command -v python3 >/dev/null 2>&1 || die "缺少 python3(算 artifact digest 需要)"
  command -v npm >/dev/null 2>&1 || die "缺少 npm"
  command -v jq >/dev/null 2>&1 || die "缺少 jq"
  [[ ! -e "$reldir" ]] || die "目标已存在,拒绝覆盖: $reldir"

  mkdir -p -- "$MASTER_RELEASES_ROOT"
  chown 0:0 -- "$MASTER_RELEASES_ROOT"
  chmod 0755 -- "$MASTER_RELEASES_ROOT"
  [[ -d "$MASTER_RELEASES_ROOT" && ! -L "$MASTER_RELEASES_ROOT" ]] \
    || die "MASTER_RELEASES_ROOT 必须是普通目录: $MASTER_RELEASES_ROOT"

  mkdir -p -- "$staging" || die "无法创建 staging $staging"
  MASTER_STAGING="$(readlink -f -- "$staging")"
  [[ -n "$MASTER_STAGING" && -d "$MASTER_STAGING" ]] || die "staging 规范化失败: $staging"
  MASTER_STAGING_DEV="$(stat -c '%d' -- "$MASTER_STAGING")"
  MASTER_STAGING_INO="$(stat -c '%i' -- "$MASTER_STAGING")"
  staging="$MASTER_STAGING"
  if ! git -C "$REPO_ROOT" archive --format=tar "$full_sha" | tar -x -C "$staging"; then
    cleanup_master_staging
    die "git archive/解包失败"
  fi
  [[ -f "$staging/package-lock.json" ]] || {
    cleanup_master_staging
    die "archive 后缺 package-lock.json"
  }
  [[ -f "$staging/deploy/v5/release-metadata.json" ]] || {
    cleanup_master_staging
    die "archive 后缺 deploy/v5/release-metadata.json"
  }

  t0="$(date +%s)"
  donor="$(find_master_release_donor "$staging/package-lock.json" || true)"
  if [[ -n "$donor" && -d "$donor/node_modules" ]]; then
    if ! cp -al -- "$donor/node_modules" "$staging/node_modules"; then
      cleanup_master_staging
      die "cp -al node_modules 失败(donor=$donor)"
    fi
    MASTER_DEPS_MODE="hardlink"
    mlog "  lock 未变 → 硬链复用 node_modules ← $donor"
    if ! break_hardlink_restore_exec "$staging"; then
      cleanup_master_staging
      die "拆硬链恢复 staging 可执行位失败(donor=$donor)"
    fi
  else
    mlog "  lock 变化/无 donor/--force-npm-ci → 在 staging 内 npm ci(绝不写 rel-*)"
    if ! ( cd "$staging" && npm ci --no-audit --no-fund ); then
      cleanup_master_staging
      die "staging npm ci 失败"
    fi
    MASTER_DEPS_MODE="npm-ci"
  fi
  t1="$(date +%s)"
  MASTER_DEPS_ELAPSED_S="$((t1 - t0))"
  mlog "  deps elapsed=${MASTER_DEPS_ELAPSED_S}s mode=$MASTER_DEPS_MODE"
  [[ -d "$staging/node_modules/tsx" ]] || {
    cleanup_master_staging
    die "staging 缺 node_modules/tsx"
  }

  t0="$(date +%s)"
  mlog "  web-react official build @ staging(不碰工作树 dist)"
  if ! ( cd "$staging" && NODE_OPTIONS='--max-old-space-size=4096' npm run build --workspace packages/web-react ); then
    cleanup_master_staging
    die "staging web-react 构建失败"
  fi
  t1="$(date +%s)"
  MASTER_FRONTEND_ELAPSED_S="$((t1 - t0))"
  mlog "  frontend elapsed=${MASTER_FRONTEND_ELAPSED_S}s"
  [[ -f "$staging/packages/web-react/dist/index.html" ]] || {
    cleanup_master_staging
    die "构建后缺 staging dist/index.html"
  }
  build_id="$(grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$staging/packages/web-react/dist/index.html" \
    | grep -o '[0-9a-f]\{8,32\}' | head -1 || true)"
  [[ -n "$build_id" ]] || {
    cleanup_master_staging
    die "staging dist/index.html 缺 oc-build meta"
  }
  mlog "  dist oc-build=$build_id"

  # openclaude-memory MCP server 预编译 CJS(dist/ 被 gitignore,git archive 不带产物,
  # 必须在 staging 构建;缺产物则引擎回落 tsx ~7s 冷启动路径,故 fail-loud)。
  if [[ -f "$staging/packages/mcp-memory/scripts/build-oc-memory-mcp.sh" ]]; then
    mlog "  build oc-memory MCP bundle @ staging"
    if ! ( cd "$staging" && bash packages/mcp-memory/scripts/build-oc-memory-mcp.sh ); then
      cleanup_master_staging
      die "staging oc-memory MCP bundle 构建失败"
    fi
    [[ -s "$staging/packages/mcp-memory/dist/oc-memory-mcp.cjs" ]] || {
      cleanup_master_staging
      die "构建后缺 staging packages/mcp-memory/dist/oc-memory-mcp.cjs"
    }
  fi

  # 构建期缓存不进 artifact。rm 只丢掉本树的目录项;硬链文件 nlink>1 时 donor 仍在。
  rm -rf -- \
    "$staging/node_modules/.vite" \
    "$staging/node_modules/.cache" \
    "$staging/packages/web-react/node_modules/.vite" \
    "$staging/packages/web-react/node_modules/.cache"

  if ! write_master_version_json "$staging" "$short_sha"; then
    cleanup_master_staging
    die "写 VERSION.json 失败"
  fi
  if ! harden_unique_release_tree "$staging"; then
    cleanup_master_staging
    die "harden unique files 失败"
  fi
  if ! write_strong_release_marker_local "$staging" "$full_sha" "$short_sha" "$ts" \
    "$MASTER_RELEASE_COMPLETE_SCHEMA_VERSION"; then
    cleanup_master_staging
    die "写 .complete / digest 失败"
  fi
  if ! mv -T -- "$staging" "$reldir"; then
    cleanup_master_staging
    die "mv -T staging→rel 失败"
  fi
  MASTER_STAGING=""
  MASTER_STAGING_DEV=""
  MASTER_STAGING_INO=""
  BUILT_MASTER_RELEASE="$reldir"
  mlog "  ✓ master release 就绪: $reldir deps=${MASTER_DEPS_MODE}/${MASTER_DEPS_ELAPSED_S}s frontend=${MASTER_FRONTEND_ELAPSED_S}s"
}

cmd_build_master_only() {
  log "══ v5 selfhost --build-master-only(只建不切) ══"
  [[ "$REPO_ROOT" == /opt/openclaude/openclaude-v5-selfhost ]] \
    || die "必须在 /opt/openclaude/openclaude-v5-selfhost 内执行"
  require_cmd git
  require_cmd npm
  require_cmd jq
  require_cmd python3
  require_cmd tar
  require_cmd find
  require_cmd sha256sum
  build_master_release
  [[ -n "$BUILT_MASTER_RELEASE" ]] || die "build_master_release 未设置 BUILT_MASTER_RELEASE"
  if [[ "${DRY:-0}" == 1 ]]; then
    log "✓ dry-run 结束(未落盘): $BUILT_MASTER_RELEASE"
    return 0
  fi
  [[ -f "$BUILT_MASTER_RELEASE/.complete" ]] || die "缺 .complete: $BUILT_MASTER_RELEASE"
  log "  path=$BUILT_MASTER_RELEASE"
  log "  sourceCommit=$(jq -er '.sourceCommit' "$BUILT_MASTER_RELEASE/.complete")"
  log "  depsMode=$MASTER_DEPS_MODE elapsed=${MASTER_DEPS_ELAPSED_S}s frontend=${MASTER_FRONTEND_ELAPSED_S}s"
  log "✓ build-master-only 完成(未改 unit / 未切 symlink / 未重启)"
}

# ── 阶段 2 静态门 + 不起 HTTP 的 tsx 自检 ────────────────────────────────

unit_template_working_directory() { # <unit-file>
  awk -F= '/^WorkingDirectory=/{print $2; exit}' "$1"
}

assert_unit_templates_live_wd() { # <dir-with-unit-files>
  local dir="${1:-}" f wd
  [[ -n "$dir" && -d "$dir" ]] \
    || die "assert_unit_templates_live_wd 必须传入目录(候选 release 内 deploy/v5-selfhost 或 snapshot),禁止默认读工作树"
  for f in "${dir}/${V5_UNIT}" "${dir}/${V5_EGRESS_UNIT}"; do
    [[ -f "$f" && ! -L "$f" ]] || die "缺 unit 模板普通文件: $f"
    wd="$(unit_template_working_directory "$f")"
    [[ "$wd" == *-live ]] || die "unit 模板 $f WorkingDirectory='$wd' 必须以 -live 结尾。禁止改回工作树。"
    [[ "$wd" == "$MASTER_LIVE_LINK" ]] \
      || die "unit 模板 $f WorkingDirectory='$wd' 必须等于 $MASTER_LIVE_LINK"
  done
}

assert_old_deploy_fail_closed() {
  die "仓库 master/egress unit 模板已改指 $MASTER_LIVE_LINK。旧 --$MODE 会装 live WD 但仍走 tuple-only+工作树 saga(审计 blocker 2)。已 fail-closed。
补救: 用 --cutover 完成不可分割翻转;或 --build-master-only 只建不切。禁止 --deploy/--bootstrap 直至 joint saga 合入。"
}

assert_master_release_static_gate() { # <rel> [expected-full-sha]
  local rel="$1" expected="${2:-}" marker schema commit built meta art got ver_commit root_uid root_gid root_mode
  [[ -d "$rel" && ! -L "$rel" ]] || die "静态门: release 不是普通目录: $rel"
  if release_dir_is_poisoned "$rel"; then
    die "静态门: 拒绝有毒 release: $rel"
  fi
  marker="$rel/.complete"
  [[ -f "$marker" && ! -L "$marker" ]] || die "静态门: 缺 .complete: $rel"
  schema="$(jq -er '.schemaVersion' "$marker")"
  commit="$(jq -er '.sourceCommit' "$marker")"
  built="$(jq -er '.builtAt' "$marker")"
  meta="$(jq -er '.metadataSha256' "$marker")"
  art="$(jq -er '.artifactSha256' "$marker")"
  [[ "$schema" == "$MASTER_RELEASE_COMPLETE_SCHEMA_VERSION" ]] \
    || die "静态门: schemaVersion=$schema 期望 $MASTER_RELEASE_COMPLETE_SCHEMA_VERSION"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "静态门: sourceCommit 不是 40 位 hex"
  [[ "$built" =~ ^[0-9]{8}-[0-9]{6}$ ]] || die "静态门: builtAt 非法: $built"
  [[ "$meta" =~ ^[0-9a-f]{64}$ && "$art" =~ ^[0-9a-f]{64}$ ]] \
    || die "静态门: digest 字段非法"
  if [[ -n "$expected" ]]; then
    [[ "$commit" == "$expected" ]] || die "静态门: sourceCommit=$commit 与预期 $expected 不一致"
  fi
  [[ -d "$rel/node_modules/tsx" ]] || die "静态门: 缺 node_modules/tsx"
  [[ -f "$rel/packages/web-react/dist/index.html" ]] || die "静态门: 缺 dist/index.html"
  grep -q 'name="oc-build"' "$rel/packages/web-react/dist/index.html" \
    || die "静态门: dist/index.html 缺 oc-build"
  [[ -f "$rel/deploy/v5/release-metadata.json" ]] || die "静态门: 缺 release-metadata.json"
  [[ -f "$rel/VERSION.json" ]] || die "静态门: 缺 VERSION.json"
  ver_commit="$(jq -er '.commit | select(type == "string")' "$rel/VERSION.json")"
  [[ "$commit" == "$ver_commit"* ]] || die "静态门: VERSION.commit=$ver_commit 不是 sourceCommit 前缀"
  read -r root_uid root_gid root_mode < <(stat -Lc '%u %g %a' -- "$rel")
  [[ "$root_uid" == 0 && "$root_gid" == 0 && $((8#$root_mode & 8#22)) -eq 0 ]] \
    || die "静态门: release 根 ownership/mode 不可信 uid=$root_uid gid=$root_gid mode=$root_mode"
  got="$(release_artifact_digest "$rel")"
  [[ "$got" == "$art" ]] || die "静态门: artifactSha256 复算不匹配 expected=$art got=$got"
  mlog "  ✓ 静态门通过 $rel sourceCommit=${commit:0:9} digest=${art:0:12}…"
}

# 不起 HTTP、不 import gateway/registerCommercial。只证明该树自带的 tsx 能跑,
# 并对入口文件做 --check(语法/transform,不执行 top-level)。
assert_master_release_tsx_selfcheck() { # <rel>
  local rel="$1" out
  [[ -d "$rel/node_modules/tsx" ]] || die "tsx 自检: 缺 $rel/node_modules/tsx"
  out="$(cd "$rel" && npx --no-install tsx -e 'console.log("tsx-ok")')"
  [[ "$out" == "tsx-ok" ]] || die "tsx 自检失败(期望 tsx-ok): $out"
  # 只 transform、不 import 入口(cli/src/index.ts 会 parseAsync, commercial 会连 PG)。
  # node --import tsx --check 在 Node 20 对 .ts 报 ERR_UNKNOWN_FILE_EXTENSION,不用。
  out="$(cd "$rel" && npx --no-install tsx -e '
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
for (const f of ["packages/cli/src/commands/gateway.ts", "packages/commercial/src/index.ts"]) {
  transformSync(readFileSync(f, "utf8"), { loader: "ts", format: "esm", target: "es2022" });
}
console.log("transform-ok");
')"
  [[ "$out" == "transform-ok" ]] || die "tsx transform 自检失败: $out"
  mlog "  ✓ tsx 自检通过(无 HTTP)"
}

sql_file_has_breaking_ddl() { # <sql-file> → rc 0 = breaking
  local f="$1"
  python3 - "$f" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8", errors="replace").read()
text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
text = re.sub(r"--.*?$", " ", text, flags=re.M)
if re.search(r"\bDROP\s+TABLE\b", text, re.I):
    print("DROP TABLE"); sys.exit(0)
if re.search(r"\bDROP\s+COLUMN\b", text, re.I):
    print("DROP COLUMN"); sys.exit(0)
if re.search(r"\bALTER\b[\s\S]{0,200}\bDROP\b", text, re.I):
    print("ALTER ... DROP"); sys.exit(0)
if re.search(r"\bRENAME\s+(TO|COLUMN|TABLE)\b", text, re.I):
    print("RENAME"); sys.exit(0)
if re.search(r"\bTRUNCATE\b", text, re.I):
    print("TRUNCATE"); sys.exit(0)
sys.exit(1)
PY
}

# git object 必须存在;diff 非 0 必须 fail-closed。禁止 || true 把坏 SHA 变成「无 migration」。
git_migration_name_diff() { # <from-commit> <to-commit>
  local from="$1" to="$2"
  [[ "$from" =~ ^[0-9a-f]{7,40}$ ]] || { mlog "迁移门: from 非法"; return 1; }
  [[ "$to" =~ ^[0-9a-f]{7,40}$ ]] || { mlog "迁移门: to 非法"; return 1; }
  git -C "$REPO_ROOT" cat-file -e "${from}^{commit}" \
    || { mlog "迁移门: from 不是存在的 commit: $from"; return 1; }
  git -C "$REPO_ROOT" cat-file -e "${to}^{commit}" \
    || { mlog "迁移门: to 不是存在的 commit: $to"; return 1; }
  git -C "$REPO_ROOT" diff --name-only "$from" "$to" -- '**/migrations/**'
}

# 只读比对 DB schema_migrations.version 与候选 requiredMigrations。不 apply。
# stdout: 缺失的 version 名,一行一个。查询失败 → rc 1。
read_required_migration_gap() { # <rel>
  local rel="$1" meta applied required
  meta="$rel/deploy/v5/release-metadata.json"
  [[ -f "$meta" ]] || { mlog "迁移门: 缺 $meta"; return 1; }
  if ! jq -e '.requiredMigrations | type == "array"' "$meta" >/dev/null 2>&1; then
    mlog "迁移门: requiredMigrations 不是数组(或字段缺失)。fail-closed。"
    return 1
  fi
  required="$(jq -er '.requiredMigrations[]' "$meta")" || {
    mlog "迁移门: 读取 requiredMigrations 失败"
    return 1
  }
  if ! command -v psql >/dev/null 2>&1; then
    mlog "迁移门: 缺 psql,无法只读查 schema_migrations"
    return 1
  fi
  if ! applied="$(sudo -u postgres psql -X -d "${PG_DB:-openclaude_v5_selfhost}" -tAc \
    "SELECT version FROM schema_migrations" 2>/dev/null)"; then
    mlog "迁移门: 只读查询 schema_migrations 失败(fail-closed)"
    return 1
  fi
  python3 - "$required" "$applied" <<'PY'
import sys
required = [x.strip() for x in sys.argv[1].splitlines() if x.strip()]
applied = set(x.strip() for x in sys.argv[2].splitlines() if x.strip())
missing = [x for x in required if x not in applied]
sys.stdout.write("\n".join(missing))
if missing:
    sys.stdout.write("\n")
PY
}

classify_pending_migration_file() { # <rel> <path-or-basename>
  local rel="$1" f="$2" base hit meta
  meta="$rel/deploy/v5/release-metadata.json"
  case "$f" in
    packages/commercial/src/db/migrations/*.sql)
      base="$(basename "$f" .sql)"
      ;;
    *.sql)
      base="$(basename "$f" .sql)"
      f="packages/commercial/src/db/migrations/${base}.sql"
      ;;
    *)
      if [[ "$f" == *_* && "$f" != */* ]]; then
        base="$f"
        f="packages/commercial/src/db/migrations/${base}.sql"
      else
        mlog "  迁移门: 跳过非 commercial runner 路径 $f"
        return 0
      fi
      ;;
  esac
  jq -e --arg n "$base" '.requiredMigrations | index($n) != null' "$meta" >/dev/null \
    || die "迁移门: $base 未列入 $meta requiredMigrations。拒绝 apply/翻转。"
  if [[ -f "$rel/$f" ]]; then
    if hit="$(sql_file_has_breaking_ddl "$rel/$f")"; then
      if [[ "${OC_V5_ALLOW_BREAKING_MIGRATION:-0}" == 1 ]]; then
        mlog "  ⚠ 破坏性 DDL 被 OC_V5_ALLOW_BREAKING_MIGRATION=1 放行: $f ($hit)"
      else
        die "迁移门: $f 命中破坏性 DDL($hit)。默认拒绝。确要放行设 OC_V5_ALLOW_BREAKING_MIGRATION=1(会写入日志)。"
      fi
    fi
  fi
}

# 显式判定本批次是否含 migration;破坏性 DDL 默认拒绝。
# 权威: DB schema_migrations 与候选 requiredMigrations 的缺口(不依赖工作树 .complete)。
# git diff 仅在存在 live 运行身份时做,且 fail-closed。
# 设置 CUTOVER_HAS_MIGRATION / CUTOVER_MIGRATION_FILES。
gate_cutover_migrations() { # <rel>
  local rel="$1" from_commit to_commit changed f gap live_root
  CUTOVER_HAS_MIGRATION=0
  CUTOVER_MIGRATION_FILES=""
  to_commit="$(jq -er '.sourceCommit' "$rel/.complete")"
  [[ "$to_commit" =~ ^[0-9a-f]{40}$ ]] || die "迁移门: to_commit 非法"
  git -C "$REPO_ROOT" cat-file -e "${to_commit}^{commit}" \
    || die "迁移门: to_commit 不是存在的 commit: $to_commit"

  if ! gap="$(read_required_migration_gap "$rel")"; then
    die "迁移门: requiredMigrations↔schema_migrations 缺口比对失败。fail-closed,不翻转。"
  fi
  if [[ -n "$gap" ]]; then
    CUTOVER_HAS_MIGRATION=1
    CUTOVER_MIGRATION_FILES="$gap"
    mlog "  迁移门: DB 缺口 HAS_MIGRATION=1 missing:"
    mlog "$gap"
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      classify_pending_migration_file "$rel" "$f"
    done <<<"$gap"
  else
    mlog "  迁移门: requiredMigrations 均已在 schema_migrations"
  fi

  from_commit=""
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    live_root="$(readlink -f "$MASTER_LIVE_LINK" 2>/dev/null || true)"
    if [[ -n "$live_root" && -f "$live_root/.complete" ]]; then
      from_commit="$(jq -er '.sourceCommit' "$live_root/.complete")"
    fi
  fi
  # 禁止把工作树 .complete 当运行证明。无 live 时只信 DB 缺口。
  if [[ -n "$from_commit" ]]; then
    [[ "$from_commit" =~ ^[0-9a-f]{40}$ ]] || die "迁移门: live sourceCommit 非法"
    git -C "$REPO_ROOT" cat-file -e "${from_commit}^{commit}" \
      || die "迁移门: live sourceCommit 不是存在的 commit: $from_commit"
    if ! changed="$(git_migration_name_diff "$from_commit" "$to_commit")"; then
      die "迁移门: git diff $from_commit..$to_commit 失败。fail-closed,禁止当成无 migration。"
    fi
    if [[ -n "$changed" ]]; then
      CUTOVER_HAS_MIGRATION=1
      if [[ -n "$CUTOVER_MIGRATION_FILES" ]]; then
        CUTOVER_MIGRATION_FILES="${CUTOVER_MIGRATION_FILES}"$'\n'"$changed"
      else
        CUTOVER_MIGRATION_FILES="$changed"
      fi
      mlog "  迁移门: live..候选 git diff 含 **/migrations/**"
      mlog "$changed"
      while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        classify_pending_migration_file "$rel" "$f"
      done <<<"$changed"
    fi
  else
    mlog "  迁移门: 无 live 运行身份,不以工作树 .complete 当 from;HAS_MIGRATION 只由 DB 缺口决定"
  fi

  if [[ "$CUTOVER_HAS_MIGRATION" == 1 ]]; then
    mlog "  ✓ 迁移门: 分类通过(含 migration 时 apply 必须与翻转同一把锁、同一窗口)"
  else
    mlog "  迁移门: HAS_MIGRATION=0"
  fi
}

resolve_cutover_release() { # uses CUTOVER_RELEASE / HEAD
  local head cand
  head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  if [[ -n "${CUTOVER_RELEASE:-}" ]]; then
    [[ "$CUTOVER_RELEASE" == /* ]] || die "--release 必须是绝对路径"
    [[ -d "$CUTOVER_RELEASE" && ! -L "$CUTOVER_RELEASE" ]] || die "--release 不是普通目录: $CUTOVER_RELEASE"
    if release_dir_is_poisoned "$CUTOVER_RELEASE"; then
      die "拒绝有毒 --release: $CUTOVER_RELEASE"
    fi
    printf '%s\n' "$CUTOVER_RELEASE"
    return 0
  fi
  [[ -d "$MASTER_RELEASES_ROOT" ]] || die "无 releases 根: $MASTER_RELEASES_ROOT"
  cand=""
  while IFS= read -r cand; do
    [[ -n "$cand" ]] || continue
    if release_dir_is_poisoned "$cand"; then
      continue
    fi
    [[ -f "$cand/.complete" ]] || continue
    if [[ "$(jq -er '.sourceCommit' "$cand/.complete" 2>/dev/null || true)" == "$head" ]]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done < <(find "$MASTER_RELEASES_ROOT" -mindepth 1 -maxdepth 1 -type d \
    -name 'rel-*' ! -name '*.poisoned' -printf '%T@\t%p\n' | sort -nr | cut -f2-)
  die "找不到 sourceCommit==HEAD($head) 的完整 master release。补救: 先 --build-master-only。"
}

atomic_flip_live_symlink() { # <target-abs-rel>  失败只 return,不 exit
  local target="$1" tmp
  [[ "$target" == "$MASTER_RELEASES_ROOT"/rel-* ]] || { mlog "live 目标不在 releases 根下: $target"; return 1; }
  [[ -d "$target" && ! -L "$target" ]] || { mlog "live 目标不是普通目录: $target"; return 1; }
  tmp="${MASTER_LIVE_LINK}.newlink.$$"
  rm -f -- "$tmp"
  ln -s -- "$target" "$tmp" || return 1
  if ! mv -T -- "$tmp" "$MASTER_LIVE_LINK"; then
    rm -f -- "$tmp"
    return 1
  fi
}

write_prev_release_file() { # <path-or-none>
  local val="$1" tmp
  tmp="$MASTER_RELEASES_ROOT/.prev-release.tmp.$$"
  mkdir -p -- "$MASTER_RELEASES_ROOT" || return 1
  printf '%s\n' "$val" >"$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -f -- "$tmp" "$MASTER_RELEASES_ROOT/.prev-release" || { rm -f -- "$tmp"; return 1; }
}

write_cutover_grace() {
  local until_ts
  until_ts=$(( $(date +%s) + CUTOVER_GRACE_SEC ))
  mkdir -p -- "$(dirname -- "$CUTOVER_GRACE_FILE")" || return 1
  printf 'until=%s\n' "$until_ts" >"$CUTOVER_GRACE_FILE" || return 1
}

# 一级回滚目标:canonicalize 真实路径、必须在 releases 根内、复算 strong digest。
canonicalize_prev_release() { # <raw> → stdout canon
  local raw="$1" canon root expected got
  [[ -n "$raw" && "$raw" != "none" && "$raw" != "NONE" ]] || return 1
  canon="$(readlink -f -- "$raw" 2>/dev/null || true)"
  [[ -n "$canon" && -d "$canon" && ! -L "$canon" ]] || return 1
  root="$(readlink -f -- "$MASTER_RELEASES_ROOT" 2>/dev/null || true)"
  [[ -n "$root" ]] || return 1
  case "$canon" in
    "${root}"/rel-*) ;;
    *)
      mlog "prev 不在 releases 根内: $canon"
      return 1
      ;;
  esac
  [[ "$canon" != *.poisoned ]] || return 1
  [[ -f "$canon/.complete" && ! -L "$canon/.complete" ]] || return 1
  expected="$(jq -er '.artifactSha256' "$canon/.complete" 2>/dev/null || true)"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  got="$(release_artifact_digest "$canon")" || return 1
  [[ "$got" == "$expected" ]] || { mlog "prev digest 复算不匹配 $canon"; return 1; }
  printf '%s\n' "$canon"
}

fsync_path() { # <file-or-dir>
  python3 - "$1" <<'PY'
import os, sys
p = sys.argv[1]
fd = os.open(p, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

# 从已过 digest 的候选 release 快照 unit 到 root-owned 临时目录。危险窗口只读这份。
snapshot_cutover_units_from_release() { # <rel> <out-var>
  local rel="$1" dest_var="$2" snap src_dir
  [[ "$dest_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  src_dir="$rel/deploy/v5-selfhost"
  [[ -d "$src_dir" ]] || { mlog "候选缺 $src_dir"; return 1; }
  assert_unit_templates_live_wd "$src_dir"
  snap="/run/openclaude-v5-selfhost/cutover-unit-snap.$$"
  rm -rf -- "$snap"
  mkdir -p -- "$snap" || return 1
  chmod 0700 -- "$snap" || return 1
  cp -a -- "$src_dir/${V5_UNIT}" "$snap/" || { rm -rf -- "$snap"; return 1; }
  cp -a -- "$src_dir/${V5_EGRESS_UNIT}" "$snap/" || { rm -rf -- "$snap"; return 1; }
  assert_unit_templates_live_wd "$snap"
  fsync_path "$snap/${V5_UNIT}" || { rm -rf -- "$snap"; return 1; }
  fsync_path "$snap/${V5_EGRESS_UNIT}" || { rm -rf -- "$snap"; return 1; }
  CUTOVER_UNIT_SNAP="$snap"
  printf -v "$dest_var" '%s' "$snap"
}

# 解析已验证的工作树 unit 备份(二级回滚目标)。不更新任何指针。
resolve_worktree_unit_backup() {
  local cur real wd_m wd_e
  cur="${BREAKGLASS_ROOT}/unit-backups/worktree-current"
  if [[ -L "$cur" ]]; then
    real="$(readlink -f -- "$cur" 2>/dev/null || true)"
  elif [[ -d "$cur" && ! -L "$cur" ]]; then
    real="$cur"
  else
    return 1
  fi
  [[ -n "$real" && -d "$real" && ! -L "$real" ]] || return 1
  [[ -f "$real/${V5_UNIT}" && ! -L "$real/${V5_UNIT}" ]] || return 1
  [[ -f "$real/${V5_EGRESS_UNIT}" && ! -L "$real/${V5_EGRESS_UNIT}" ]] || return 1
  [[ "$(stat -c '%s' -- "$real/${V5_UNIT}")" -gt 0 ]] || return 1
  [[ "$(stat -c '%s' -- "$real/${V5_EGRESS_UNIT}")" -gt 0 ]] || return 1
  wd_m="$(unit_template_working_directory "$real/${V5_UNIT}")"
  wd_e="$(unit_template_working_directory "$real/${V5_EGRESS_UNIT}")"
  [[ "$wd_m" == /opt/openclaude/openclaude-v5-selfhost ]] || return 1
  [[ "$wd_e" == /opt/openclaude/openclaude-v5-selfhost ]] || return 1
  grep -q '^ExecStart=' "$real/${V5_UNIT}" || return 1
  grep -q '^ExecStart=' "$real/${V5_EGRESS_UNIT}" || return 1
  printf '%s\n' "$real"
}

# caller-provided 输出变量,不用会清 errexit 的命令替换。
# 每个写步骤显式检查。首次(installed WD=工作树):校验后原子更新 worktree-current。
# 后续(installed WD=live):只写 forensics 快照,不覆盖 worktree-current;
# dest_var 返回已有的工作树备份,供二级回滚使用。
backup_installed_units_for_cutover() { # <out-var>
  local dest_var="$1" ts dest wd_m wd_e tmp_link wt
  [[ "$dest_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  ts="$(date -u +%Y%m%d-%H%M%S)" || return 1
  dest="${BREAKGLASS_ROOT}/unit-backups/pre-cutover-${ts}"
  mkdir -p -- "$dest" || return 1
  cp -a -- "/etc/systemd/system/${V5_UNIT}" "$dest/" || return 1
  cp -a -- "/etc/systemd/system/${V5_EGRESS_UNIT}" "$dest/" || return 1
  if [[ -n "${UNIT_DIR:-}" && -f "${UNIT_DIR}/${V5_UNIT}" ]]; then
    cp -a -- "${UNIT_DIR}/${V5_UNIT}" "$dest/repo-${V5_UNIT}" || return 1
    cp -a -- "${UNIT_DIR}/${V5_EGRESS_UNIT}" "$dest/repo-${V5_EGRESS_UNIT}" || return 1
  fi
  [[ -f "$dest/${V5_UNIT}" && ! -L "$dest/${V5_UNIT}" ]] || return 1
  [[ -f "$dest/${V5_EGRESS_UNIT}" && ! -L "$dest/${V5_EGRESS_UNIT}" ]] || return 1
  [[ "$(stat -c '%s' -- "$dest/${V5_UNIT}")" -gt 0 ]] || return 1
  [[ "$(stat -c '%s' -- "$dest/${V5_EGRESS_UNIT}")" -gt 0 ]] || return 1
  wd_m="$(unit_template_working_directory "$dest/${V5_UNIT}")"
  wd_e="$(unit_template_working_directory "$dest/${V5_EGRESS_UNIT}")"
  grep -q '^ExecStart=' "$dest/${V5_UNIT}" || return 1
  grep -q '^ExecStart=' "$dest/${V5_EGRESS_UNIT}" || return 1
  printf 'backup=%s\ninstalled_master=%s\ninstalled_egress=%s\nwd_master=%s\nwd_egress=%s\n' \
    "$dest" "/etc/systemd/system/${V5_UNIT}" "/etc/systemd/system/${V5_EGRESS_UNIT}" \
    "$wd_m" "$wd_e" \
    >"$dest/MANIFEST.txt" || return 1
  fsync_path "$dest/${V5_UNIT}" || return 1
  fsync_path "$dest/${V5_EGRESS_UNIT}" || return 1
  fsync_path "$dest/MANIFEST.txt" || return 1
  fsync_path "$dest" || return 1
  mkdir -p -- "${BREAKGLASS_ROOT}/unit-backups" || return 1

  if [[ "$wd_m" == /opt/openclaude/openclaude-v5-selfhost \
     && "$wd_e" == /opt/openclaude/openclaude-v5-selfhost ]]; then
    tmp_link="${BREAKGLASS_ROOT}/unit-backups/worktree-current.new.$$"
    ln -sfn -- "$dest" "$tmp_link" || return 1
    mv -Tf -- "$tmp_link" "${BREAKGLASS_ROOT}/unit-backups/worktree-current" || {
      rm -f -- "$tmp_link"
      return 1
    }
    printf -v "$dest_var" '%s' "$dest"
    return 0
  fi

  if [[ "$wd_m" == "$MASTER_LIVE_LINK" && "$wd_e" == "$MASTER_LIVE_LINK" ]]; then
    wt="$(resolve_worktree_unit_backup)" || {
      mlog "当前 unit 已是 live WD,但 worktree-current 缺失或不是工作树备份。二级回滚不可用。"
      return 1
    }
    mlog "  当前 unit 已是 live WD;forensics=$dest;二级回滚仍用工作树备份 $wt(不覆盖 worktree-current)"
    printf -v "$dest_var" '%s' "$wt"
    return 0
  fi

  mlog "backup: installed WD 既不是工作树也不是 live master='$wd_m' egress='$wd_e'"
  return 1
}

dist_oc_build() { # <rel>
  grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$1/packages/web-react/dist/index.html" \
    | grep -o '[0-9a-f]\{8,32\}' | head -1
}

run_migrations_from_release() { # <rel>  失败 return 1,不 exit(调用方走统一补偿)
  local rel="$1" url migration_pgoptions
  url="$(read_env_db_url)" || return 1
  assert_connected_db "$url" || return 1
  [[ -d "$rel/node_modules" ]] || { mlog "release 无 node_modules,无法跑 migration"; return 1; }
  migration_pgoptions="${PGOPTIONS:+${PGOPTIONS} }-c openclaude.migration_profile=v5-selfhost"
  if ! ( cd "$rel" && env PGOPTIONS="$migration_pgoptions" DATABASE_URL="$url" REDIS_URL="$REDIS_URL" \
      COMMERCIAL_ENABLED=1 COMMERCIAL_AUTO_MIGRATE=1 \
      npx --no-install tsx packages/commercial/src/db/migrate.ts ); then
    mlog "对着 release 跑 migration 失败。不翻转。不回滚 schema。"
    return 1
  fi
}

cleanup_cutover_unit_snap() {
  local snap="${CUTOVER_UNIT_SNAP:-}"
  CUTOVER_UNIT_SNAP=""
  [[ -n "$snap" ]] || return 0
  case "$snap" in
    /run/openclaude-v5-selfhost/cutover-unit-snap.*)
      rm -rf -- "$snap"
      ;;
  esac
}
