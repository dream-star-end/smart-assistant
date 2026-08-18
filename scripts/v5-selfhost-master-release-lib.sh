#!/usr/bin/env bash
# v5-selfhost-master-release-lib.sh — 阶段 1:只建不可变 master release,不切 live。
# 由 deploy-v5-selfhost.sh source。禁止在已有 rel-* 里 npm ci;半成品永不叫 rel-*。
# 日志一律 stderr,避免将来落入命令替换。

# 独立于 runtime-releases。不要跟 /var/lib/openclaude-v5-selfhost/runtime-releases 混用。
MASTER_RELEASES_ROOT="${MASTER_RELEASES_ROOT:-/opt/openclaude/openclaude-v5-selfhost-releases}"
MASTER_RELEASE_COMPLETE_SCHEMA_VERSION=2
MASTER_STAGING="${MASTER_STAGING:-}"
BUILT_MASTER_RELEASE="${BUILT_MASTER_RELEASE:-}"
MASTER_DEPS_MODE="${MASTER_DEPS_MODE:-}"
MASTER_DEPS_ELAPSED_S="${MASTER_DEPS_ELAPSED_S:-}"
MASTER_FRONTEND_ELAPSED_S="${MASTER_FRONTEND_ELAPSED_S:-}"

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
harden_unique_release_tree() { # <staging-root>
  local root="$1"
  [[ -d "$root" && ! -L "$root" ]] || return 1
  chown 0:0 -- "$root" || return 1
  # 根目录先保持可写,以便随后落 .complete;子目录去写位。
  find "$root" -mindepth 1 -type d -print0 | xargs -0 -r chmod 0555
  find "$root" -type f -links 1 -print0 | xargs -0 -r chmod 0444
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

# stdout 只打印 donor 绝对路径;找不到则 rc=1。日志走 stderr。
find_master_release_donor() { # <staging-lock>
  local staging_lock="$1" cand
  [[ -f "$staging_lock" ]] || return 1
  if [[ "${FORCE_NPM_CI:-0}" == 1 ]]; then
    mlog "  --force-npm-ci:跳过硬链 donor"
    return 1
  fi
  if [[ -d "$MASTER_RELEASES_ROOT" ]]; then
    while IFS= read -r cand; do
      [[ -n "$cand" ]] || continue
      [[ -f "$cand/.complete" && ! -L "$cand/.complete" ]] || continue
      [[ -d "$cand/node_modules" && ! -L "$cand/node_modules" ]] || continue
      [[ -f "$cand/package-lock.json" ]] || continue
      if cmp -s "$staging_lock" "$cand/package-lock.json"; then
        mlog "  donor=已有 release $cand"
        printf '%s\n' "$cand"
        return 0
      fi
    done < <(find "$MASTER_RELEASES_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'rel-*' -printf '%T@\t%p\n' \
      | sort -nr | cut -f2-)
  fi
  if [[ -d "${REPO_ROOT:-}/node_modules" && -f "${REPO_ROOT:-}/package-lock.json" ]] \
    && cmp -s "$staging_lock" "$REPO_ROOT/package-lock.json"; then
    mlog "  donor=工作树 $REPO_ROOT (只硬链;绝不 chmod 其共享 inode)"
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
