#!/usr/bin/env bash
# v5-selfhost-master-release-lib.sh — 阶段 1:只建不可变 master release,不切 live。
# 由 deploy-v5-selfhost.sh source。禁止在已有 rel-* 里 npm ci;半成品永不叫 rel-*。
# 日志一律 stderr,避免将来落入命令替换。

# 独立于 runtime-releases。不要跟 /var/lib/openclaude-v5-selfhost/runtime-releases 混用。
MASTER_RELEASES_ROOT="${MASTER_RELEASES_ROOT:-/opt/openclaude/openclaude-v5-selfhost-releases}"
MASTER_LIVE_LINK="${MASTER_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}"
MASTER_RELEASE_COMPLETE_SCHEMA_VERSION=2
MASTER_STAGING="${MASTER_STAGING:-}"
BUILT_MASTER_RELEASE="${BUILT_MASTER_RELEASE:-}"
MASTER_DEPS_MODE="${MASTER_DEPS_MODE:-}"
MASTER_DEPS_ELAPSED_S="${MASTER_DEPS_ELAPSED_S:-}"
MASTER_FRONTEND_ELAPSED_S="${MASTER_FRONTEND_ELAPSED_S:-}"
BREAKGLASS_ROOT="${BREAKGLASS_ROOT:-/opt/openclaude/v5-selfhost-breakglass}"
CUTOVER_GRACE_FILE="${CUTOVER_GRACE_FILE:-/run/openclaude-v5-selfhost/cutover-grace-until}"
CUTOVER_GRACE_SEC="${CUTOVER_GRACE_SEC:-90}"
CUTOVER_HAS_MIGRATION="${CUTOVER_HAS_MIGRATION:-0}"
CUTOVER_MIGRATION_FILES="${CUTOVER_MIGRATION_FILES:-}"

mlog() { echo "$*" >&2; }

cleanup_master_staging() {
  if [[ -n "${MASTER_STAGING:-}" && -d "$MASTER_STAGING" ]]; then
    mlog "  清理未完成的 staging: $MASTER_STAGING"
    rm -rf -- "$MASTER_STAGING"
    MASTER_STAGING=""
  fi
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

  MASTER_STAGING="$staging"
  mkdir -p -- "$staging"
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

assert_unit_templates_live_wd() {
  local f wd
  for f in "${UNIT_DIR}/${V5_UNIT}" "${UNIT_DIR}/${V5_EGRESS_UNIT}"; do
    [[ -f "$f" ]] || die "缺 unit 模板: $f"
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

# 显式判定本批次是否含 migration;破坏性 DDL 默认拒绝。
# 设置 CUTOVER_HAS_MIGRATION / CUTOVER_MIGRATION_FILES。
gate_cutover_migrations() { # <rel>
  local rel="$1" from_commit to_commit changed f base hit meta
  CUTOVER_HAS_MIGRATION=0
  CUTOVER_MIGRATION_FILES=""
  to_commit="$(jq -er '.sourceCommit' "$rel/.complete")"
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    from_commit="$(jq -er '.sourceCommit' "$(readlink -f "$MASTER_LIVE_LINK")/.complete" 2>/dev/null || true)"
  fi
  if [[ -z "${from_commit:-}" && -f "${REPO_ROOT}/.complete" ]]; then
    from_commit="$(jq -er '.sourceCommit' "$REPO_ROOT/.complete")"
  fi
  if [[ -z "${from_commit:-}" ]]; then
    from_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  fi
  [[ "$from_commit" =~ ^[0-9a-f]{7,40}$ ]] || die "迁移门: from_commit 非法"
  [[ "$to_commit" =~ ^[0-9a-f]{40}$ ]] || die "迁移门: to_commit 非法"
  if [[ "$from_commit" == "$to_commit" ]]; then
    mlog "  迁移门: from==to ($to_commit),无 migration"
    return 0
  fi
  changed="$(git -C "$REPO_ROOT" diff --name-only "$from_commit" "$to_commit" -- '**/migrations/**' || true)"
  if [[ -z "$changed" ]]; then
    mlog "  迁移门: $from_commit..$to_commit 无 **/migrations/** 变更"
    return 0
  fi
  CUTOVER_HAS_MIGRATION=1
  CUTOVER_MIGRATION_FILES="$changed"
  mlog "  迁移门: HAS_MIGRATION=1 files:"
  mlog "$changed"
  meta="$rel/deploy/v5/release-metadata.json"
  [[ -f "$meta" ]] || die "迁移门: 缺 $meta"
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    case "$f" in
      packages/commercial/src/db/migrations/*.sql) ;;
      *)
        # claude-code-best 等其它 migrations 不走 commercial runner;仍记录但不当 requiredMigrations。
        mlog "  迁移门: 跳过非 commercial runner 路径 $f"
        continue
        ;;
    esac
    base="$(basename "$f" .sql)"
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
  done <<<"$changed"
  mlog "  ✓ 迁移门: 分类通过(含 migration 时 apply 必须与翻转同一把锁、同一窗口)"
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

atomic_flip_live_symlink() { # <target-abs-rel>
  local target="$1" tmp
  [[ "$target" == "$MASTER_RELEASES_ROOT"/rel-* ]] || die "live 目标不在 releases 根下: $target"
  [[ -d "$target" && ! -L "$target" ]] || die "live 目标不是普通目录: $target"
  tmp="${MASTER_LIVE_LINK}.newlink.$$"
  rm -f -- "$tmp"
  ln -s -- "$target" "$tmp"
  mv -T -- "$tmp" "$MASTER_LIVE_LINK"
}

write_prev_release_file() { # <path-or-none>
  local val="$1" tmp
  tmp="$MASTER_RELEASES_ROOT/.prev-release.tmp.$$"
  mkdir -p -- "$MASTER_RELEASES_ROOT"
  printf '%s\n' "$val" >"$tmp"
  mv -f -- "$tmp" "$MASTER_RELEASES_ROOT/.prev-release"
}

write_cutover_grace() {
  local until_ts
  until_ts=$(( $(date +%s) + CUTOVER_GRACE_SEC ))
  mkdir -p -- "$(dirname -- "$CUTOVER_GRACE_FILE")"
  printf 'until=%s\n' "$until_ts" >"$CUTOVER_GRACE_FILE"
}

backup_installed_units_for_cutover() { # stdout: backup dir
  local ts dest
  ts="$(date -u +%Y%m%d-%H%M%S)"
  dest="${BREAKGLASS_ROOT}/unit-backups/pre-cutover-${ts}"
  mkdir -p -- "$dest"
  cp -a -- "/etc/systemd/system/${V5_UNIT}" "$dest/"
  cp -a -- "/etc/systemd/system/${V5_EGRESS_UNIT}" "$dest/"
  cp -a -- "${UNIT_DIR}/${V5_UNIT}" "$dest/repo-${V5_UNIT}"
  cp -a -- "${UNIT_DIR}/${V5_EGRESS_UNIT}" "$dest/repo-${V5_EGRESS_UNIT}"
  printf 'backup=%s\ninstalled_master=%s\ninstalled_egress=%s\n' \
    "$dest" "/etc/systemd/system/${V5_UNIT}" "/etc/systemd/system/${V5_EGRESS_UNIT}" \
    >"$dest/MANIFEST.txt"
  local wd
  wd="$(unit_template_working_directory "/etc/systemd/system/${V5_UNIT}")"
  if [[ "$wd" != *-live ]]; then
    mkdir -p -- "${BREAKGLASS_ROOT}/unit-backups"
    ln -sfn -- "$dest" "${BREAKGLASS_ROOT}/unit-backups/worktree-current"
  fi
  printf '%s\n' "$dest"
}

dist_oc_build() { # <rel>
  grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$1/packages/web-react/dist/index.html" \
    | grep -o '[0-9a-f]\{8,32\}' | head -1
}

run_migrations_from_release() { # <rel>
  local rel="$1" url migration_pgoptions
  url="$(read_env_db_url)"
  assert_connected_db "$url"
  [[ -d "$rel/node_modules" ]] || die "release 无 node_modules,无法跑 migration"
  migration_pgoptions="${PGOPTIONS:+${PGOPTIONS} }-c openclaude.migration_profile=v5-selfhost"
  ( cd "$rel" && env PGOPTIONS="$migration_pgoptions" DATABASE_URL="$url" REDIS_URL="$REDIS_URL" \
      COMMERCIAL_ENABLED=1 COMMERCIAL_AUTO_MIGRATE=1 \
      npx --no-install tsx packages/commercial/src/db/migrate.ts ) \
    || die "对着 release 跑 migration 失败。不翻转。不回滚 schema。"
}

