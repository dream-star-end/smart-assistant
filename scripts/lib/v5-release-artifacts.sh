#!/usr/bin/env bash
# Definition-only artifact integrity helpers. Loaded by deploy-v5.sh in place.

# 对 release 全树（含 node_modules/dist、常规文件 mode 与 symlink 原始 target）做稳定
# SHA-256；只排除根 `.complete` 本身，避免 marker 自引用。函数既可本地自测，也会通过
# `declare -f` 原样流到 kl-mirror，build/verify 共用一份算法，禁止双实现漂移。
release_artifact_digest() { # <absolute-release-root>
  local root="$1"
  [[ -d "$root" && ! -L "$root" ]] || {
    echo "FATAL: release artifact root 非真实目录:$root" >&2
    return 1
  }
  # One Python walker avoids spawning ~4 processes per file (the old shell
  # manifest took >90 s on the 38k-file production release). Length-prefixed
  # byte fields cover arbitrary path/symlink bytes without TSV ambiguity; file,
  # directory and symlink type/mode/uid/gid are all bound. Root .complete alone
  # is excluded to avoid self-reference.
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

# A per-entry check alone misses a new/deleted path after the directory was
# scanned or after that directory's own hash step. Re-snapshot the entire tree
# and compare the exact path/type/identity set plus the release root identity.
root_after, entries_after = snapshot_tree()
before_signature = [(rel, before) for rel, _absolute, before in entries]
after_signature = [(rel, after) for rel, _absolute, after in entries_after]
if root_after != root_before or after_signature != before_signature:
    raise RuntimeError("release tree changed during digest")

print(digest.hexdigest())
PY
}

# 远端只读 probe：物理边界、marker schema、目录名、VERSION、metadata digest 与全树
# artifact digest 一次核完。stdout 是内部 TSV，不承载人类日志。
release_marker_probe() { # <release-dir>
  local reldir="$1"
  {
    declare -f release_artifact_digest
    cat <<'REMOTE'
set -Eeuo pipefail
reldir="$1"; releases_root="$2"; schema="$3"
root_real="$(readlink -f -- "$releases_root")"
dir_real="$(readlink -f -- "$reldir")"
[[ -n "$root_real" && -n "$dir_real" && "$dir_real" == "$reldir" \
  && "$(dirname -- "$dir_real")" == "$root_real" && -d "$dir_real" && ! -L "$dir_real" ]] || {
  echo "FATAL: release 不是真实 releases-root 直系目录:$reldir" >&2; exit 1;
}
marker="$reldir/.complete"; metadata="$reldir/deploy/v5/release-metadata.json"; version="$reldir/VERSION.json"
[[ -f "$marker" && ! -L "$marker" && -f "$metadata" && ! -L "$metadata" \
  && -f "$version" && ! -L "$version" ]] || {
  echo "FATAL: release marker/metadata/VERSION 缺失或为 symlink:$reldir" >&2; exit 1;
}
read -r root_uid root_gid root_mode < <(stat -Lc '%u %g %a' -- "$reldir")
read -r marker_uid marker_gid marker_mode < <(stat -Lc '%u %g %a' -- "$marker")
[[ "$root_uid" == 0 && "$root_gid" == 0 && $((8#$root_mode & 8#22)) -eq 0 ]] || {
  echo "FATAL: release root ownership/mode 不可信:$reldir uid=$root_uid gid=$root_gid mode=$root_mode" >&2; exit 1;
}
[[ "$marker_uid" == 0 && "$marker_gid" == 0 \
  && ( "$marker_mode" == 644 || "$marker_mode" == 444 ) ]] || {
  echo "FATAL: release marker ownership/mode 不可信:$marker uid=$marker_uid gid=$marker_gid mode=$marker_mode" >&2; exit 1;
}
kind="$(jq -er --argjson schema "$schema" '
  if (.schemaVersion == $schema) then "strong"
  elif (has("schemaVersion") | not) then "legacy"
  else error("unsupported release marker schema") end
' "$marker")" || exit 1
base="$(basename -- "$reldir")"
version_commit="$(jq -er '.commit | select(type == "string")' "$version")" || exit 1
if [[ "$kind" == strong ]]; then
  row="$(jq -er --argjson schema "$schema" '
    if (((["artifactSha256","builtAt","metadataSha256","schemaVersion","sourceCommit"] - keys) | length) == 0
      and ((keys - ["artifactSha256","baselineManifestSha256","builtAt","distReuse","flavorGuardGeneration","metadataSha256","schemaVersion","sourceCommit"]) | length) == 0
      and .schemaVersion == $schema
      and (.sourceCommit | type == "string" and test("^[0-9a-f]{40}$"))
      and (.builtAt | type == "string" and test("^[0-9]{8}-[0-9]{6}$"))
      and (.metadataSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.artifactSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and ((has("baselineManifestSha256") | not)
        or (.baselineManifestSha256 | type == "string" and test("^[0-9a-f]{64}$")))
      and ((has("distReuse") | not)
        or ((.distReuse | type == "object")
          and (.distReuse.fromRelease | type == "string" and startswith("/"))
          and (.distReuse.fromSourceCommit | type == "string" and test("^[0-9a-f]{40}$"))
          and (.distReuse.comparedPaths | type == "array" and length > 0))))
    then [.sourceCommit,.builtAt,.metadataSha256,.artifactSha256] | @tsv
    else error("invalid strong release marker") end
  ' "$marker")" || exit 1
  IFS=$'\t' read -r source_commit built_at metadata_want artifact_want <<<"$row"
  stem="${base#rel-}"; stem="${stem%-migrated}"; suffix="-$built_at"
  [[ "$base" == rel-* && "$stem" == *"$suffix" ]] || {
    echo "FATAL: strong marker builtAt 与 release dirname 不一致:$base" >&2; exit 1;
  }
  short="${stem%"$suffix"}"
  [[ "$short" =~ ^[0-9a-f]{7,40}$ && "$source_commit" == "$short"* \
    && "$version_commit" == "$short" ]] || {
    echo "FATAL: strong marker sourceCommit/dirname/VERSION 不一致:$base" >&2; exit 1;
  }
  metadata_have="$(sha256sum -- "$metadata" | cut -d' ' -f1)"
  [[ "$metadata_have" == "$metadata_want" ]] || {
    echo "FATAL: release metadata digest mismatch:$reldir" >&2; exit 1;
  }
  artifact_have="$(release_artifact_digest "$reldir")"
  [[ "$artifact_have" == "$artifact_want" ]] || {
    echo "FATAL: release artifact digest mismatch:$reldir" >&2; exit 1;
  }
  if jq -e '.baselineManifestSha256 | type == "string"' "$marker" >/dev/null; then
    manifest="$reldir/.baseline-manifest.json"
    [[ -f "$manifest" && ! -L "$manifest" ]] || {
      echo "FATAL: baselineManifestSha256 present but .baseline-manifest.json missing:$reldir" >&2; exit 1;
    }
    manifest_want="$(jq -er '.baselineManifestSha256' "$marker")"
    manifest_have="$(sha256sum -- "$manifest" | cut -d' ' -f1)"
    [[ "$manifest_have" == "$manifest_want" ]] || {
      echo "FATAL: baseline manifest digest mismatch:$reldir" >&2; exit 1;
    }
  fi
  printf 'strong\t%s\t%s\t%s\t%s\n' "$source_commit" "$short" "$built_at" "$artifact_want"
else
  row="$(jq -er '
    if (((keys | sort) == (["builtAt","sha"] | sort)
        or (keys | sort) == (["builtAt","migrated","sha"] | sort))
      and (.sha | type == "string" and test("^[0-9a-f]{7,40}$"))
      and (.builtAt | type == "string" and test("^[0-9]{8}-[0-9]{6}$"))
      and ((has("migrated") | not) or .migrated == true))
    then [.sha,.builtAt] | @tsv else error("invalid legacy release marker") end
  ' "$marker")" || exit 1
  IFS=$'\t' read -r short built_at <<<"$row"
  [[ "$base" == "rel-$short-$built_at" || "$base" == "rel-$short-$built_at-migrated" ]] || {
    echo "FATAL: legacy marker sha/builtAt 与 release dirname 不一致:$base" >&2; exit 1;
  }
  [[ "$version_commit" == "$short" ]] || {
    echo "FATAL: legacy marker 与 VERSION.commit 不一致:$base" >&2; exit 1;
  }
  artifact_have="$(release_artifact_digest "$reldir")"
  [[ "$artifact_have" =~ ^[0-9a-f]{64}$ ]] || exit 1
  # Keep probe columns uniform:kind,source identity,dirname short,builtAt,artifact.
  # Legacy has no full source identity, so its validated short SHA occupies both
  # identity columns until the caller resolves it against trusted git objects.
  printf 'legacy\t%s\t%s\t%s\t%s\n' "$short" "$short" "$built_at" "$artifact_have"
fi
REMOTE
  } | ssh "$KL_HOST" bash -s -- "$reldir" "$RELEASES_ROOT" "$RELEASE_COMPLETE_SCHEMA_VERSION"
}

assert_release_metadata_matches_commit() { # <release-dir> <full-commit>
  local reldir="$1" full="$2"
  [[ "$full" =~ ^[0-9a-f]{40}$ ]] || return 1
  git -C "$REPO_ROOT" cat-file -e "${full}^{commit}" 2>/dev/null || {
    echo "✗ release sourceCommit 不在本地 trusted git object store:$full" >&2; return 1;
  }
  if ! git -C "$REPO_ROOT" show "${full}:deploy/v5/release-metadata.json" \
      | ssh "$KL_HOST" "cmp - '$reldir/deploy/v5/release-metadata.json'"; then
    echo "✗ release-metadata 原始字节不等于 trusted git $full:$reldir" >&2
    return 1
  fi
}

assert_release_marker() { # <release-dir> [master|egress legacy trust scope]
  local reldir="$1" trust_scope="${2:-master}" probe kind source short built artifact
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 验证 release strong marker/full sourceCommit/metadata+artifact digest:$reldir"
    return 0
  fi
  probe="$(release_marker_probe "$reldir")" || {
    echo "✗ release 完整标记校验失败:$reldir" >&2; return 1;
  }
  IFS=$'\t' read -r kind source short built artifact <<<"$probe"
  case "$kind" in
    strong)
      assert_release_metadata_matches_commit "$reldir" "$source" || return 1
      ;;
    legacy)
      local trusted_path trusted_source trusted_artifact
      case "$trust_scope" in
        master)
          trusted_path="$TRUSTED_LEGACY_PREDECESSOR"
          trusted_source="$TRUSTED_LEGACY_SOURCE_COMMIT"
          trusted_artifact="$TRUSTED_LEGACY_ARTIFACT_SHA256"
          ;;
        egress)
          trusted_path="$TRUSTED_LEGACY_EGRESS_PREDECESSOR"
          trusted_source="$TRUSTED_LEGACY_EGRESS_SOURCE_COMMIT"
          trusted_artifact="$TRUSTED_LEGACY_EGRESS_ARTIFACT_SHA256"
          ;;
        *) echo "✗ legacy release trust scope 非法:$trust_scope" >&2; return 1 ;;
      esac
      [[ -n "$trusted_path" && "$reldir" == "$trusted_path" \
        && "$trusted_source" =~ ^[0-9a-f]{40}$ && "$trusted_source" == "$source"* \
        && "$trusted_artifact" =~ ^[0-9a-f]{64}$ && "$artifact" == "$trusted_artifact" ]] || {
        echo "✗ generic legacy .complete 非本 invocation 精确捕获且制品未变的 $trust_scope predecessor，拒绝:$reldir" >&2
        return 1
      }
      assert_release_metadata_matches_commit "$reldir" "$trusted_source" || return 1
      ;;
    *) echo "✗ release marker probe 返回非法 kind:${kind:-<empty>}" >&2; return 1 ;;
  esac
  echo "  ✓ release marker 校验通过(kind=$kind path=$reldir)"
}

capture_trusted_release_predecessor() { # [explicit-release-dir，仅供 hermetic test]
  local current="${1:-}" probe kind source short built artifact full
  [[ "$DRY" == 1 ]] && return 0
  if [[ -z "$current" ]]; then
    resolve_active_lane || return 1
    current="$(bg_current_release "$ACTIVE_SRC")"
  fi
  [[ -n "$current" ]] || { echo "✗ 无法在 mutation 前捕获 serving predecessor" >&2; return 1; }
  probe="$(release_marker_probe "$current")" || {
    echo "✗ serving predecessor marker/目录/VERSION 校验失败:$current" >&2; return 1;
  }
  IFS=$'\t' read -r kind source short built artifact <<<"$probe"
  CAPTURED_RELEASE_PREDECESSOR="$current"
  TRUSTED_LEGACY_PREDECESSOR=""; TRUSTED_LEGACY_SOURCE_COMMIT=""; TRUSTED_LEGACY_ARTIFACT_SHA256=""
  case "$kind" in
    strong)
      assert_release_metadata_matches_commit "$current" "$source" || return 1
      ;;
    legacy)
      full="$(git -C "$REPO_ROOT" rev-parse --verify "${source}^{commit}" 2>/dev/null || true)"
      [[ "$full" =~ ^[0-9a-f]{40}$ && "$full" == "$source"* ]] || {
        echo "✗ legacy predecessor short SHA 无法唯一解析为 trusted full commit:$source" >&2; return 1;
      }
      assert_release_metadata_matches_commit "$current" "$full" || return 1
      TRUSTED_LEGACY_PREDECESSOR="$current"
      TRUSTED_LEGACY_SOURCE_COMMIT="$full"
      TRUSTED_LEGACY_ARTIFACT_SHA256="$artifact"
      ;;
    *) echo "✗ serving predecessor marker kind 非法:${kind:-<empty>}" >&2; return 1 ;;
  esac
  echo "  ✓ 已在 deploy+mutation lock 内捕获 predecessor(kind=$kind path=$current)"
}

# Egress may intentionally lag the serving master by many releases. Capture its
# real process cwd under the same two locks, but grant this legacy pin only to
# egress activation/compensation; it is never a master rollback trust root.
capture_trusted_egress_predecessor() { # [explicit-release-dir，仅供 hermetic test]
  local current="${1:-}" probe kind source short built artifact full
  [[ "$DRY" == 1 ]] && return 0
  if [[ -z "$current" ]]; then
    current="$(egress_running_cwd)"
  fi
  [[ -n "$current" ]] || { echo "✗ 无法在 mutation 前捕获 egress predecessor" >&2; return 1; }
  probe="$(release_marker_probe "$current")" || {
    echo "✗ egress predecessor marker/目录/VERSION 校验失败:$current" >&2; return 1;
  }
  IFS=$'\t' read -r kind source short built artifact <<<"$probe"
  CAPTURED_EGRESS_PREDECESSOR="$current"
  TRUSTED_LEGACY_EGRESS_PREDECESSOR=""; TRUSTED_LEGACY_EGRESS_SOURCE_COMMIT=""
  TRUSTED_LEGACY_EGRESS_ARTIFACT_SHA256=""
  case "$kind" in
    strong)
      assert_release_metadata_matches_commit "$current" "$source" || return 1
      ;;
    legacy)
      full="$(git -C "$REPO_ROOT" rev-parse --verify "${source}^{commit}" 2>/dev/null || true)"
      [[ "$full" =~ ^[0-9a-f]{40}$ && "$full" == "$source"* ]] || {
        echo "✗ legacy egress predecessor short SHA 无法唯一解析:$source" >&2; return 1;
      }
      assert_release_metadata_matches_commit "$current" "$full" || return 1
      TRUSTED_LEGACY_EGRESS_PREDECESSOR="$current"
      TRUSTED_LEGACY_EGRESS_SOURCE_COMMIT="$full"
      TRUSTED_LEGACY_EGRESS_ARTIFACT_SHA256="$artifact"
      ;;
    *) echo "✗ egress predecessor marker kind 非法:${kind:-<empty>}" >&2; return 1 ;;
  esac
  echo "  ✓ 已在 deploy+mutation lock 内捕获 egress predecessor(kind=$kind path=$current)"
}

# 蓝绿前置:active slot 的 src 必须已是 symlink 布局且指向 RELEASES_ROOT 下的完整 release(否则先迁移)。
# $1=要校验的 src(默认 ACTIVE_SRC;传统 lane resolve_active_lane 后传 active slot 的 src)。
assert_bluegreen_layout() {
  local src="${1:-${ACTIVE_SRC:-$REMOTE_SRC}}"
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 断言蓝绿 symlink 布局(src=$src)"; return 0; }
  ssh "$KL_HOST" "set -e
    test -L '$src'
    t=\$(readlink -f '$src')
    case \"\$t\" in '$RELEASES_ROOT'/rel-*) : ;; *) echo '✗ $src symlink 未指向 RELEASES_ROOT/rel-*: '\"\$t\" >&2; exit 1 ;; esac
    test -f \"\$t/.complete\" || { echo '✗ current release 无 .complete 标记' >&2; exit 1; }" || {
    echo "✗ 蓝绿布局校验失败:$src 需为指向 RELEASES_ROOT/rel-* 完整 release 的 symlink。先在受控窗口跑:deploy-v5.sh --migrate-bluegreen" >&2
    exit 1
  }
}

# P0#4(Codex):offline cutover lane(stage/activate-staged/offline-recycle/prepare-offline-cutover)
# 仍按**实目录 in-place + mv 语义**操作 REMOTE_SRC,在 symlink 布局下会把 symlink 搬走/装回实目录、
# 破坏蓝绿不变量。该 lane 尚未适配蓝绿 → symlink 布局下 **fail-closed 拒绝**(不静默破坏)。
assert_not_bluegreen_for_cutover() {
  [[ "$DRY" == 1 ]] && return 0
  if ssh "$KL_HOST" "test -L '$REMOTE_SRC'"; then
    echo "✗ 蓝绿 symlink 布局下 offline cutover lane 尚未适配(会破坏布局)。该 lane 需单独迁移蓝绿(登记 playbook 债);当前 fail-closed 拒绝。" >&2
    exit 1
  fi
}

# 建不可变 release:**当前 shell 执行**(不走 command-substitution 子 shell,否则 errexit 被清、
# 失败被吞、DIST_BUILD_ID 丢,Codex P0#1),成功后**设全局 BUILT_RELEASE**,失败 return 1。
# 建到唯一 .staging-* → 完整性校验 → 写 .complete → **原子 mv -T 改名**为 rel-*(半成品永不落
# rel-* 命名空间,activate/rollback/GC 只认带 .complete 的目录,Codex P0#3)。sha 全程钉死一次
# 贯穿 archive/VERSION/dist(工作树必须干净=即该 sha,Codex P0#2)。
BUILT_RELEASE=""; BUILT_RELEASE_SOURCE_COMMIT=""

write_strong_release_marker_local() { # <release-root> <full-sha> <short-sha> <builtAt> <schema>
  local root="$1" full_sha="$2" short_sha="$3" built_at="$4" schema="$5"
  local metadata_sha artifact_sha marker_tmp root_uid root_gid root_mode marker_uid marker_gid marker_mode
  [[ "$full_sha" =~ ^[0-9a-f]{40}$ && "$short_sha" =~ ^[0-9a-f]{7,40}$ \
    && "$full_sha" == "$short_sha"* && "$built_at" =~ ^[0-9]{8}-[0-9]{6}$ \
    && "$schema" =~ ^[1-9][0-9]*$ ]] || {
    echo 'FATAL: strong release identity 参数非法' >&2; return 1;
  }
  [[ -d "$root" && ! -L "$root" ]] || { echo 'FATAL: strong release root 非法' >&2; return 1; }
  # Legacy real-directory migration may start from the historical 0775 root.
  # Normalize only the release root itself while stopped/staged, then prove the
  # trust anchor is root-owned and not group/other writable before hashing it.
  chown 0:0 -- "$root" || return 1
  chmod go-w -- "$root" || return 1
  read -r root_uid root_gid root_mode < <(stat -Lc '%u %g %a' -- "$root")
  [[ "$root_uid" == 0 && "$root_gid" == 0 && $((8#$root_mode & 8#22)) -eq 0 ]] || {
    echo "FATAL: strong release root ownership/mode 不可信:$root" >&2; return 1;
  }
  test -f "$root/package.json"
  test -d "$root/node_modules"
  test -f "$root/VERSION.json"
  test -f "$root/packages/web-react/dist/index.html"
  test -f "$root/deploy/v5/release-metadata.json"
  [[ "$(jq -er '.commit | select(type == "string")' "$root/VERSION.json")" == "$short_sha" ]] || {
    echo 'FATAL: VERSION.commit 与 pinned source short SHA 不一致' >&2; return 1;
  }
  metadata_sha="$(sha256sum -- "$root/deploy/v5/release-metadata.json" | cut -d' ' -f1)"
  artifact_sha="$(release_artifact_digest "$root")"
  [[ "$metadata_sha" =~ ^[0-9a-f]{64}$ && "$artifact_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  marker_tmp="${root}.complete.$$"
  local jq_args=(
    -n
    --argjson schemaVersion "$schema"
    --arg sourceCommit "$full_sha"
    --arg builtAt "$built_at"
    --arg metadataSha256 "$metadata_sha"
    --arg artifactSha256 "$artifact_sha"
    --argjson flavorGuardGeneration 1
  )
  local jq_prog='{schemaVersion:$schemaVersion,sourceCommit:$sourceCommit,builtAt:$builtAt,
      metadataSha256:$metadataSha256,artifactSha256:$artifactSha256,
      flavorGuardGeneration:$flavorGuardGeneration}'
  local baked_manifest="$root/.baseline-manifest.json" manifest_sha
  if [[ -e "$baked_manifest" ]]; then
    [[ -f "$baked_manifest" && ! -L "$baked_manifest" ]] || {
      echo "FATAL: .baseline-manifest.json 必须是常规文件:$baked_manifest" >&2; return 1;
    }
    manifest_sha="$(sha256sum -- "$baked_manifest" | cut -d' ' -f1)"
    [[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
    jq_args+=(--arg baselineManifestSha256 "$manifest_sha")
    jq_prog='{schemaVersion:$schemaVersion,sourceCommit:$sourceCommit,builtAt:$builtAt,
      metadataSha256:$metadataSha256,artifactSha256:$artifactSha256,
      flavorGuardGeneration:$flavorGuardGeneration,
      baselineManifestSha256:$baselineManifestSha256}'
  fi
  if ! jq "${jq_args[@]}" "$jq_prog" >"$marker_tmp"; then
    rm -f -- "$marker_tmp"
    return 1
  fi
  chmod 0644 "$marker_tmp" || { rm -f -- "$marker_tmp"; return 1; }
  chown 0:0 "$marker_tmp" || { rm -f -- "$marker_tmp"; return 1; }
  mv -f -- "$marker_tmp" "$root/.complete" || { rm -f -- "$marker_tmp"; return 1; }
  read -r marker_uid marker_gid marker_mode < <(stat -Lc '%u %g %a' -- "$root/.complete")
  [[ "$marker_uid" == 0 && "$marker_gid" == 0 && "$marker_mode" == 644 ]] || {
    echo "FATAL: strong release marker ownership/mode 不可信:$root/.complete" >&2; return 1;
  }
  # Re-hash after the marker is durably in place (the marker itself is excluded)
  # so a concurrent tree mutation between the first digest and publish cannot
  # create a self-consistent-looking marker that was never verified as a whole.
  [[ "$(release_artifact_digest "$root")" == "$artifact_sha" ]] || {
    echo "FATAL: strong release tree changed while publishing marker:$root" >&2; return 1;
  }
}

publish_strong_release() { # <staging> <final-dir> <full-sha> <short-sha> <builtAt>
  local staging="$1" reldir="$2" full_sha="$3" short_sha="$4" built_at="$5"
  {
    declare -f release_artifact_digest write_strong_release_marker_local
    cat <<'REMOTE'
set -Eeuo pipefail
staging="$1"; reldir="$2"; full_sha="$3"; short_sha="$4"; built_at="$5"; schema="$6"
[[ -d "$staging" && ! -L "$staging" && ! -e "$reldir" ]] || {
  echo 'FATAL: strong release staging/final path 非法' >&2; exit 1;
}
write_strong_release_marker_local "$staging" "$full_sha" "$short_sha" "$built_at" "$schema"
mv -T -- "$staging" "$reldir"
REMOTE
  } | ssh "$KL_HOST" bash -s -- \
    "$staging" "$reldir" "$full_sha" "$short_sha" "$built_at" "$RELEASE_COMPLETE_SCHEMA_VERSION"
}

