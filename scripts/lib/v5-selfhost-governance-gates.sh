#!/usr/bin/env bash
# v5-selfhost-governance-gates.sh — Wave 1/2 只读秒级治理快门 + 宿主机外置裁判(OCV5-847/849/859/903/904)。
# 由 v5-selfhost-master-release-lib.sh source；在无 .git 的 pinned staging archive 中运行，
# 严格只读、物理隔离裁判执行链(零软链 $staging/packages、零借用 $staging/node_modules/.bin/tsx)、
# 支持 root 预装受审过渡裁判(TRANSITION_APPROVAL.json + MANIFEST.json + A0 批准收据)，
# 并封堵外部逃生环境变量(docs/V5_SELFHOST_PLAYBOOK.md §6.2 防线 3)。

MASTER_REFEREE_ROOT="${OC_V5_REFEREE_ROOT:-/opt/openclaude/harness-gate/referee}"

# 校验候选基线与目标 commit 的 merge-base：
# 必须存在共同祖先且 merge-base != full_sha（排除自身以及领先于 full_sha 的未来提交，
# 避免 `git diff base...full_sha` 退化为 `full_sha..full_sha` 空集）。
_master_governance_valid_merge_base() { # <cand-sha> <full-sha> → stdout 40-hex merge-base sha
  local cand_sha="$1" full_sha="$2" mb=""
  local -a g=(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' git -C "$REPO_ROOT")
  [[ -n "$cand_sha" && "$cand_sha" != "$full_sha" ]] || return 1
  mb="$("${g[@]}" merge-base "$cand_sha" "$full_sha" 2>/dev/null || true)"
  [[ "$mb" =~ ^[0-9a-f]{40}$ && "$mb" != "$full_sha" ]] || return 1
  printf '%s\n' "$mb"
}

# 解析本次候选 commit 的只读非自身对比基线（输出核验后的真实 merge-base 40-hex SHA）：
#   1. 显式 OC_V5_GOVERNANCE_BASE_REF（无效、等于自身或超前于 full_sha 均 fail-closed）
#   2. 当前 live release 的 .complete sourceCommit（有效且 merge-base != full_sha）
#   3. origin/feat/v5-selfhost（有效且 merge-base != full_sha）
#   4. 目标 commit 的父提交 ${full_sha}^
#   5. 孤立根提交无父提交时 fail-closed，拒绝空比较静默放行
master_resolve_governance_base_ref() { # <full-sha>
  local full_sha="$1" explicit="${OC_V5_GOVERNANCE_BASE_REF:-}"
  local explicit_sha="" live_root="" live_sha="" origin_sha="" parent_sha="" mb=""
  local -a g=(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' git -C "$REPO_ROOT")

  if [[ -n "$explicit" ]]; then
    explicit_sha="$("${g[@]}" rev-parse --verify --quiet "${explicit}^{commit}" 2>/dev/null || true)"
    if [[ -z "$explicit_sha" ]]; then
      mlog "✗ governance fast gate: OC_V5_GOVERNANCE_BASE_REF=$explicit 不是有效 commit"
      return 1
    fi
    mb="$(_master_governance_valid_merge_base "$explicit_sha" "$full_sha" || true)"
    if [[ -z "$mb" ]]; then
      mlog "✗ governance fast gate: OC_V5_GOVERNANCE_BASE_REF=$explicit 与目标 commit ${full_sha:0:12} 相同、无共同祖先或超前（merge-base 退化为空集），禁止空比较"
      return 1
    fi
    printf '%s\n' "$mb"
    return 0
  fi

  if [[ -L "${MASTER_LIVE_LINK:-}" ]]; then
    live_root="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
    if [[ -n "$live_root" && -f "$live_root/.complete" ]]; then
      live_sha="$(jq -er '.sourceCommit // empty' "$live_root/.complete" 2>/dev/null || true)"
      if [[ "$live_sha" =~ ^[0-9a-f]{40}$ ]] \
        && "${g[@]}" cat-file -e "${live_sha}^{commit}" 2>/dev/null; then
        mb="$(_master_governance_valid_merge_base "$live_sha" "$full_sha" || true)"
        if [[ -n "$mb" ]]; then
          printf '%s\n' "$mb"
          return 0
        fi
      fi
    fi
  fi

  origin_sha="$("${g[@]}" rev-parse --verify --quiet 'origin/feat/v5-selfhost^{commit}' 2>/dev/null || true)"
  if [[ -n "$origin_sha" ]]; then
    mb="$(_master_governance_valid_merge_base "$origin_sha" "$full_sha" || true)"
    if [[ -n "$mb" ]]; then
      printf '%s\n' "$mb"
      return 0
    fi
  fi

  parent_sha="$("${g[@]}" rev-parse --verify --quiet "${full_sha}^^{commit}" 2>/dev/null || true)"
  if [[ -n "$parent_sha" ]]; then
    mb="$(_master_governance_valid_merge_base "$parent_sha" "$full_sha" || true)"
    if [[ -n "$mb" ]]; then
      printf '%s\n' "$mb"
      return 0
    fi
  fi

  mlog "✗ governance fast gate: 无法为目标 commit ${full_sha:0:12} 解析非自身基线（无可用 live/origin 基线且无父提交），请显式传非自身 OC_V5_GOVERNANCE_BASE_REF"
  return 1
}

# ── OCV5-903 / OCV5-904 宿主机物理外置裁判 + 受信过渡裁判校验 ──────────────────
# 判断是否强制要求 root 属主：
# - 生产路径 /opt/openclaude/* 且当前 euid=0 时强制；或显式设置 OC_V5_REFEREE_REQUIRE_ROOT=1。
_master_referee_require_root() { # <path> → stdout "1" or "0"
  local p="${1:-}"
  if [[ "${OC_V5_REFEREE_REQUIRE_ROOT:-0}" == 1 ]] \
    || [[ "$(id -u)" == 0 && "$p" == /opt/openclaude/* ]]; then
    printf '1\n'
  else
    printf '0\n'
  fi
}

# 校验证外置裁判目录完整性：
#   1. 若存在 MANIFEST.json，验证 schemaVersion=1、所有文件 SHA-256 精确匹配且无未登记额外文件/符号链；
#   2. 若存在 TRANSITION_APPROVAL.json（root 预装的受信过渡裁判）：
#      - 必须是普通非符号链文件、非 group/other 可写、require_root=1 时 uid=0；
#      - schemaVersion=1, mode="transition-audited", targetSha == $full_sha（非匹配 SHA 严格拒用！）；
#      - MANIFEST.json 必须存在、完整性通过且将 TRANSITION_APPROVAL.json 纳入哈希清单；
#      - 关联 approvalFile 必须是普通非符号链文件、权限可信，且通过 A0 批准收据校验
#        （含规范载荷 sha/issuedAt/expiresAt/reason/allowedPaths 与可选 .hmac-key HMAC-SHA256）。
#   3. 若 MANIFEST.json 声明 mode="transition-audited" 但缺 TRANSITION_APPROVAL.json → fail-closed！
master_referee_verify_integrity() { # <ref-root> <full-sha> <require-root:0|1>
  local ref_root="$1" full_sha="${2:-}" require_root="${3:-0}"
  python3 - "$ref_root" "$full_sha" "$require_root" <<'PY'
import datetime as dt
import hashlib
import hmac
import json
import os
import pathlib
import re
import stat
import sys

ref_root = pathlib.Path(sys.argv[1])
full_sha = (sys.argv[2] or "").strip()
require_root = sys.argv[3] == "1"

SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
SHA64_RE = re.compile(r"^[0-9a-f]{64}$")

def fail(msg: str) -> None:
    print(f"✗ [referee] {msg}", file=sys.stderr)
    raise SystemExit(2)

def check_trusted_file(p: pathlib.Path, label: str, req_root: bool) -> os.stat_result:
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        fail(f"{label} 不存在: {p}")
    except OSError as exc:
        fail(f"无法读取 {label} 元数据 ({p}): {exc}")
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        fail(f"{label} 必须是普通文件(禁止 symlink): {p}")
    if (st.st_mode & 0o022) != 0:
        fail(f"{label} 禁止 group/other 可写 (mode={oct(st.st_mode & 0o777)}): {p}")
    if req_root and st.st_uid != 0:
        fail(f"{label} 必须属主为 root (uid={st.st_uid}): {p}")
    return st

def parse_iso_utc(raw: str, label: str) -> dt.datetime:
    if not isinstance(raw, str) or not raw.strip():
        fail(f"{label} 缺少有效 ISO 时间戳")
    s = raw.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(s)
    except ValueError as exc:
        fail(f"{label} 时间戳非法 ({raw!r}): {exc}")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)

def verify_a0_approval_file(approval_path: pathlib.Path, expected_sha: str, req_root: bool) -> None:
    if not approval_path.is_absolute():
        fail(f"TRANSITION_APPROVAL.approvalFile 必须是绝对路径: {approval_path}")
    check_trusted_file(approval_path, "A0 approvalFile", req_root)
    try:
        doc = json.loads(approval_path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"A0 approvalFile JSON 解析失败 ({approval_path}): {exc}")
    if not isinstance(doc, dict):
        fail("A0 approvalFile 必须是 JSON 对象")
    if doc.get("schemaVersion") != 1:
        fail(f"A0 approvalFile 不支持的 schemaVersion={doc.get('schemaVersion')!r}")
    sha = doc.get("sha") if isinstance(doc.get("sha"), str) else doc.get("headSha", "")
    if sha != expected_sha:
        fail(f"A0 approvalFile sha 不匹配 (expected={expected_sha}, got={sha!r})")
    reason = doc.get("reason")
    if not isinstance(reason, str) or len(reason.strip()) < 8:
        fail("A0 approvalFile reason 必须 >= 8 字符")
    issued_at = doc.get("issuedAt", "")
    expires_at = doc.get("expiresAt", "")
    issued_dt = parse_iso_utc(issued_at, "A0 approvalFile.issuedAt")
    expires_dt = parse_iso_utc(expires_at, "A0 approvalFile.expiresAt")
    if expires_dt <= issued_dt:
        fail("A0 approvalFile expiresAt 必须晚于 issuedAt")
    now_dt = dt.datetime.now(dt.timezone.utc)
    if expires_dt <= now_dt:
        fail(f"A0 approvalFile 已过期 (expiresAt={expires_at})")

    allowed_paths = doc.get("allowedPaths")
    if allowed_paths is not None:
        if (
            not isinstance(allowed_paths, list)
            or not allowed_paths
            or any(not isinstance(x, str) or not x.strip() for x in allowed_paths)
        ):
            fail("A0 approvalFile allowedPaths 必须是非空字符串数组")
        norm_paths = sorted(set(x.strip() for x in allowed_paths))
        ap_str = json.dumps(norm_paths, separators=(",", ":"), ensure_ascii=False)
    else:
        ap_str = "*"

    canonical = (
        f"a0-approval-v1\n"
        f"sha={sha}\n"
        f"issuedAt={issued_at}\n"
        f"expiresAt={expires_at}\n"
        f"reason={reason.strip()}\n"
        f"allowedPaths={ap_str}\n"
    ).encode("utf-8")

    digest_field = doc.get("sha256") if isinstance(doc.get("sha256"), str) else doc.get("digest", "")
    if not isinstance(digest_field, str) or not SHA64_RE.fullmatch(digest_field):
        fail("A0 approvalFile 缺有效 64-hex sha256 摘要")
    expected_sha256 = hashlib.sha256(canonical).hexdigest()
    if not hmac.compare_digest(digest_field.lower(), expected_sha256):
        fail("A0 approvalFile sha256 规范载荷校验失败(已篡改)")

    # 若控制面存在 .hmac-key（<dirname(approvalDir)>/.hmac-key），强制校检 hmacSha256 拒绝 plain sha256 降级
    hmac_key_candidates = [approval_path.parent.parent / ".hmac-key"]
    gov_root = os.environ.get("OC_GOVERNOR_ROOT", "").strip()
    if gov_root:
        gov_hmac = pathlib.Path(gov_root) / "control" / ".hmac-key"
        if gov_hmac not in hmac_key_candidates:
            hmac_key_candidates.append(gov_hmac)
    hmac_key_path = next((p for p in hmac_key_candidates if p.exists() or p.is_symlink()), None)
    if hmac_key_path is not None:
        st_k = check_trusted_file(hmac_key_path, "A0 .hmac-key", req_root)
        if (st_k.st_mode & 0o077) != 0:
            fail(f"A0 .hmac-key 必须为 0600 私有权限 (mode={oct(st_k.st_mode & 0o777)}): {hmac_key_path}")
        key_bytes = hmac_key_path.read_bytes().strip()
        if not key_bytes:
            fail(f"A0 .hmac-key 为空: {hmac_key_path}")
        got_hmac = doc.get("hmacSha256")
        if not isinstance(got_hmac, str) or not SHA64_RE.fullmatch(got_hmac):
            fail("存在 .hmac-key 时 A0 approvalFile 必须携带有效 hmacSha256 (拒绝 plain sha256 降级)")
        expected_hmac = hmac.new(key_bytes, canonical, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(got_hmac.lower(), expected_hmac):
            fail("A0 approvalFile hmacSha256 验签失败")

manifest_path = ref_root / "MANIFEST.json"
transition_path = ref_root / "TRANSITION_APPROVAL.json"
has_manifest = manifest_path.exists() or manifest_path.is_symlink()
has_transition = transition_path.exists() or transition_path.is_symlink()

manifest_doc = None
if has_manifest:
    check_trusted_file(manifest_path, "MANIFEST.json", require_root)
    try:
        manifest_doc = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"MANIFEST.json JSON 解析失败: {exc}")
    if not isinstance(manifest_doc, dict) or manifest_doc.get("schemaVersion") != 1:
        fail("MANIFEST.json 必须为 schemaVersion=1 JSON 对象")
    files_map = manifest_doc.get("files")
    if not isinstance(files_map, dict) or not files_map:
        fail("MANIFEST.json files 必须是非空映射")

    # 校验每个登记文件的真实 SHA-256，并禁止越出或未登记文件/符号链
    actual_files: set[str] = set()
    for root_str, dirs, files in os.walk(ref_root, followlinks=False):
        rel_root = pathlib.Path(root_str).relative_to(ref_root)
        # node_modules 允许作为受控依赖子树存在，不进 MANIFEST.json；其余禁止 symlink 目录
        kept_dirs = []
        for d in dirs:
            if rel_root == pathlib.Path(".") and d == "node_modules":
                continue
            dp = pathlib.Path(root_str) / d
            if dp.is_symlink():
                fail(f"裁判目录含未授权目录符号链: {dp.relative_to(ref_root).as_posix()}")
            kept_dirs.append(d)
        dirs[:] = kept_dirs
        for fname in files:
            fp = pathlib.Path(root_str) / fname
            rel = fp.relative_to(ref_root).as_posix()
            if rel == "MANIFEST.json":
                continue
            if fp.is_symlink() or not fp.is_file():
                fail(f"裁判目录含非法文件/符号链: {rel}")
            actual_files.add(rel)

    expected_keys = set(files_map.keys())
    missing = sorted(expected_keys - actual_files)
    extra = sorted(actual_files - expected_keys)
    if missing:
        fail(f"MANIFEST.json 缺少磁盘文件: {', '.join(missing[:5])}")
    if extra:
        fail(f"裁判目录存在未登记额外文件: {', '.join(extra[:5])}")

    for rel, expected_hash in files_map.items():
        if not isinstance(expected_hash, str) or not SHA64_RE.fullmatch(expected_hash):
            fail(f"MANIFEST.json 哈希格式非法: {rel}")
        fp = ref_root / rel
        actual_hash = hashlib.sha256(fp.read_bytes()).hexdigest()
        if not hmac.compare_digest(actual_hash, expected_hash.lower()):
            fail(f"MANIFEST.json SHA-256 不匹配(已篡改): {rel}")

if has_transition:
    check_trusted_file(transition_path, "TRANSITION_APPROVAL.json", require_root)
    if not has_manifest or manifest_doc is None:
        fail("受审过渡裁判缺少 MANIFEST.json，拒绝放行")
    if "TRANSITION_APPROVAL.json" not in manifest_doc.get("files", {}):
        fail("受审过渡裁判的 MANIFEST.json 未覆盖 TRANSITION_APPROVAL.json")
    try:
        tdoc = json.loads(transition_path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"TRANSITION_APPROVAL.json JSON 解析失败: {exc}")
    if not isinstance(tdoc, dict):
        fail("TRANSITION_APPROVAL.json 必须是 JSON 对象")
    if tdoc.get("schemaVersion") != 1:
        fail(f"TRANSITION_APPROVAL.json schemaVersion 无效: {tdoc.get('schemaVersion')!r}")
    if tdoc.get("mode") != "transition-audited":
        fail(f"TRANSITION_APPROVAL.json mode 必须为 transition-audited, got={tdoc.get('mode')!r}")
    target_sha = tdoc.get("targetSha")
    if not isinstance(target_sha, str) or not SHA40_RE.fullmatch(target_sha):
        fail(f"TRANSITION_APPROVAL.json targetSha 非法: {target_sha!r}")
    if not full_sha or not SHA40_RE.fullmatch(full_sha):
        fail(f"使用受审过渡裁判必须传入精确 40-hex candidate full_sha (got={full_sha!r})")
    if target_sha != full_sha:
        fail(
            f"受审过渡裁判仅绑定 targetSha={target_sha[:12]}，拒绝用于非匹配候选 {full_sha[:12]}！"
        )
    if manifest_doc.get("mode") not in (None, "transition-audited"):
        fail(f"MANIFEST.json mode 与过渡裁判冲突: {manifest_doc.get('mode')!r}")
    if manifest_doc.get("targetSha") is not None and manifest_doc.get("targetSha") != full_sha:
        fail(
            f"MANIFEST.json targetSha={manifest_doc.get('targetSha')!r} 与候选 {full_sha[:12]} 不匹配"
        )
    approval_file_raw = tdoc.get("approvalFile")
    if not isinstance(approval_file_raw, str) or not approval_file_raw.strip():
        fail("TRANSITION_APPROVAL.json 缺少 approvalFile")
    approval_path = pathlib.Path(approval_file_raw)
    verify_a0_approval_file(approval_path, full_sha, require_root)
    expected_app_sha = tdoc.get("approvalSha256")
    if expected_app_sha is not None:
        if not isinstance(expected_app_sha, str) or not SHA64_RE.fullmatch(expected_app_sha):
            fail("TRANSITION_APPROVAL.json approvalSha256 格式非法")
        actual_app_sha = hashlib.sha256(approval_path.read_bytes()).hexdigest()
        if not hmac.compare_digest(actual_app_sha, expected_app_sha.lower()):
            fail("TRANSITION_APPROVAL.json approvalSha256 与磁盘 A0 批准文件不匹配")
elif manifest_doc is not None:
    if manifest_doc.get("mode") == "transition-audited":
        fail("MANIFEST.json 声明 transition-audited 但缺少 TRANSITION_APPROVAL.json (疑似被剥离)")
PY
}

# 权威裁判根优先级：
#   1. ${OC_V5_REFEREE_ROOT:-/opt/openclaude/harness-gate/referee} (root 只读外置镜像 / 受审过渡裁判)
#   2. 已验证的 $MASTER_LIVE_LINK (有完整 .complete 且未 .poisoned)
#   3. 两者均不存在(首次自举/离线单测) → 返回空字符串，仅允许 [referee-bootstrap] 模式
# 严禁指向候选 $staging 目录自身；若外部裁判已安装但权限/属主/MANIFEST/TRANSITION_APPROVAL 校验失败则 fail-closed (rc=2)。
master_resolve_referee_root() { # <staging> [full-sha] → stdout referee_root_or_empty
  local staging="$1" full_sha="${2:-}" staging_canon=""
  local ext="${OC_V5_REFEREE_ROOT:-${MASTER_REFEREE_ROOT:-/opt/openclaude/harness-gate/referee}}"
  local cand="" uid="" mode="" live_sha="" req_root="0"
  staging_canon="$(readlink -f -- "$staging" 2>/dev/null || true)"

  if [[ -n "$ext" && ( -e "$ext" || -L "$ext" ) ]]; then
    cand="$(readlink -f -- "$ext" 2>/dev/null || true)"
    if [[ -z "$cand" || ! -d "$cand" || ! -d "$cand/scripts" ]]; then
      mlog "✗ [referee] 外置裁判根无效或缺少 scripts/: $ext (resolved=${cand:-<empty>})"
      return 2
    fi
    if [[ -n "$staging_canon" && ( "$cand" == "$staging_canon" || "$cand" == "$staging_canon"/* ) ]]; then
      mlog "✗ [referee] 拒绝指向候选 staging 内部的外置裁判根: $cand"
      return 2
    fi
    req_root="$(_master_referee_require_root "$ext")"
    read -r uid mode < <(stat -Lc '%u %a' -- "$cand" 2>/dev/null || echo '999999 777')
    if (( (8#$mode & 8#022) != 0 )) || [[ "$req_root" == 1 && "$uid" != 0 ]]; then
      mlog "✗ [referee] 外置裁判根属主/权限不可信(uid=$uid mode=$mode req_root=$req_root, 要求非 group/other 可写): $cand"
      return 2
    fi
    master_referee_verify_integrity "$cand" "$full_sha" "$req_root" || return 2
    printf '%s\n' "$cand"
    return 0
  fi

  if [[ -L "${MASTER_LIVE_LINK:-}" || -d "${MASTER_LIVE_LINK:-}" ]]; then
    cand="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
    if [[ -n "$cand" && -d "$cand/scripts" && -f "$cand/.complete" && ! -L "$cand/.complete" ]]; then
      if declare -F release_dir_is_poisoned >/dev/null 2>&1 && release_dir_is_poisoned "$cand"; then
        mlog "  [referee] 跳过已毒化的 live release: $cand"
      elif [[ -n "$staging_canon" && ( "$cand" == "$staging_canon" || "$cand" == "$staging_canon"/* ) ]]; then
        mlog "✗ [referee] 拒绝指向候选 staging 的 live link: $cand"
        return 2
      else
        live_sha="$(jq -er '.sourceCommit // empty' "$cand/.complete" 2>/dev/null || true)"
        if [[ "$live_sha" =~ ^[0-9a-f]{40}$ ]]; then
          printf '%s\n' "$cand"
          return 0
        fi
      fi
    fi
  fi

  printf '\n'
  return 0
}

# 解析可信裁判 node_modules（仅用于裁判进程 tsx / biome / typescript 依赖）：
# - 外置裁判模式 (ref_root 非空)：**绝不允许借用候选 $staging/node_modules！**
#   顺序：OC_V5_REFEREE_NODE_MODULES > $ref_root/node_modules > 已验证 $MASTER_LIVE_LINK/node_modules；
#   全部缺失或指向 $staging 内部则 fail-closed (rc=2)。
# - 纯初始自举模式 (ref_root 为空)：允许回落 $staging/node_modules。
master_resolve_referee_node_modules() { # <ref-root-or-empty> <staging> → stdout abs_node_modules
  local ref_root="$1" staging="$2"
  local staging_canon="" cand="" canon="" live_root="" live_sha="" req_root="0" uid="" mode=""
  staging_canon="$(readlink -f -- "$staging" 2>/dev/null || true)"

  _check_nm_cand() { # <dir> <allow-staging:0|1> <req-root:0|1>
    local d="$1" allow_stg="$2" rr="$3" c=""
    [[ -n "$d" && -d "$d" ]] || return 1
    c="$(readlink -f -- "$d" 2>/dev/null || true)"
    [[ -n "$c" && -d "$c" ]] || return 1
    if [[ ! -f "$c/tsx/dist/cli.mjs" && ! -x "$c/.bin/tsx" ]]; then
      return 1
    fi
    if [[ "$allow_stg" != 1 && -n "$staging_canon" && ( "$c" == "$staging_canon" || "$c" == "$staging_canon"/* ) ]]; then
      mlog "✗ [referee] 拒绝指向候选 staging 内部的裁判 node_modules: $c"
      return 2
    fi
    if [[ "$rr" == 1 ]]; then
      read -r uid mode < <(stat -Lc '%u %a' -- "$c" 2>/dev/null || echo '999999 777')
      if [[ "$uid" != 0 ]] || (( (8#$mode & 8#022) != 0 )); then
        mlog "✗ [referee] 裁判 node_modules 属主/权限不可信(uid=$uid mode=$mode): $c"
        return 2
      fi
    fi
    printf '%s\n' "$c"
    return 0
  }

  if [[ -n "$ref_root" ]]; then
    req_root="$(_master_referee_require_root "$ref_root")"
    local rc=0
    if [[ -n "${OC_V5_REFEREE_NODE_MODULES:-}" ]]; then
      canon="$(_check_nm_cand "$OC_V5_REFEREE_NODE_MODULES" 0 "$req_root")" && { printf '%s\n' "$canon"; return 0; } || rc=$?
      mlog "✗ [referee] OC_V5_REFEREE_NODE_MODULES 无效或不可信: $OC_V5_REFEREE_NODE_MODULES"
      return 2
    fi
    if [[ -e "$ref_root/node_modules" || -L "$ref_root/node_modules" ]]; then
      canon="$(_check_nm_cand "$ref_root/node_modules" 0 "$req_root")" && { printf '%s\n' "$canon"; return 0; } || rc=$?
      (( rc == 2 )) && return 2
    fi
    if [[ -L "${MASTER_LIVE_LINK:-}" || -d "${MASTER_LIVE_LINK:-}" ]]; then
      live_root="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
      if [[ -n "$live_root" && -f "$live_root/.complete" && ! -L "$live_root/.complete" ]]; then
        live_sha="$(jq -er '.sourceCommit // empty' "$live_root/.complete" 2>/dev/null || true)"
        if [[ "$live_sha" =~ ^[0-9a-f]{40}$ ]] && ! { declare -F release_dir_is_poisoned >/dev/null 2>&1 && release_dir_is_poisoned "$live_root"; }; then
          canon="$(_check_nm_cand "$live_root/node_modules" 0 0)" && { printf '%s\n' "$canon"; return 0; } || rc=$?
          (( rc == 2 )) && return 2
        fi
      fi
    fi
    mlog "✗ [referee] 找不到可信裁判 node_modules(严禁借用候选 \$staging/node_modules！请在 \$REFEREE_ROOT/node_modules 或 \$MASTER_LIVE_LINK/node_modules 预装 tsx)"
    return 2
  fi

  # 纯 bootstrap 模式(既无外置裁判也无 live release)
  if [[ -n "${OC_V5_REFEREE_NODE_MODULES:-}" ]]; then
    canon="$(_check_nm_cand "$OC_V5_REFEREE_NODE_MODULES" 1 0)" && { printf '%s\n' "$canon"; return 0; } || true
  fi
  canon="$(_check_nm_cand "$staging/node_modules" 1 0)" && { printf '%s\n' "$canon"; return 0; } || true
  mlog "✗ [referee-bootstrap] 缺少可执行 tsx 依赖: $staging/node_modules"
  return 2
}

# 解析单个治理脚本来源：
#   stdout: "referee\t<abs>" | "bootstrap\t<abs>"
#   rc=0 命中; rc=1 缺失; rc=3 裁判副本不支持所需能力标记(require_pat)
# 安全铁律(B1)：
#   - 只要外置裁判已启用 ($ref_root 非空)，绝不因旧裁判缺脚本/缺能力/失败而回落执行候选 $staging/$rel！
#   - 只有纯自举模式 ($ref_root 为空) 才允许运行候选 $staging/$rel ([referee-bootstrap])。
master_referee_resolve_script() { # <ref-root-or-empty> <staging> <rel> [require-substr]
  local ref_root="$1" staging="$2" rel="$3" req_pat="${4:-}"
  if [[ -n "$ref_root" ]]; then
    if [[ -f "$ref_root/$rel" && ! -L "$ref_root/$rel" ]]; then
      if [[ -z "$req_pat" ]] || grep -qF -- "$req_pat" "$ref_root/$rel" 2>/dev/null; then
        printf 'referee\t%s\n' "$ref_root/$rel"
        return 0
      fi
      # 旧裁判已存在该脚本但未包含新标志：绝不回落候选 $staging！返回 rc=3 由调用方决定 compat 或 fail-closed
      return 3
    fi
    return 1
  fi

  if [[ -f "$staging/$rel" ]]; then
    if [[ -n "$req_pat" ]] && ! grep -qF -- "$req_pat" "$staging/$rel" 2>/dev/null; then
      return 3
    fi
    printf 'bootstrap\t%s\n' "$staging/$rel"
    return 0
  fi
  return 1
}

# B4 纯净隔离裁判执行视图(零软链 $staging、零拷贝 $staging)：
# - 仅从 $ref_root 复制只读普通文件：scripts/、packages/commercial/scripts/、packages/protocol/、
#   .github/scripts/、package.json、tsconfig.json、biome.json；
# - 唯一允许的外部链接是 $view_dir/node_modules -> $ref_nm（已验证不可写、不在 $staging 内）；
# - 所有待扫描候选代码仅通过显式只读 `--root "$staging"` 数据参数传入，裁判进程零越出到 $staging 的可执行 import！
master_referee_build_exec_view() { # <ref-root> <view-dir> <ref-nm>
  local ref_root="$1" view_dir="$2" ref_nm="$3"
  python3 - "$ref_root" "$view_dir" "$ref_nm" <<'PY'
import os
from pathlib import Path
import shutil
import sys

ref_raw, view_raw, ref_nm_raw = sys.argv[1:4]
ref = Path(ref_raw).resolve()
view = Path(view_raw)
ref_nm = Path(ref_nm_raw).resolve()

if not ref.is_dir():
    raise SystemExit(f"referee root not found: {ref}")
if not ref_nm.is_dir():
    raise SystemExit(f"trusted referee node_modules not found: {ref_nm}")

if view.exists() or view.is_symlink():
    shutil.rmtree(view)
view.mkdir(parents=True, mode=0o700)

def copy_ro_tree(src_sub: Path, dst_sub: Path) -> None:
    if not src_sub.is_dir():
        return
    for root_str, dirs, files in os.walk(src_sub, followlinks=False):
        dirs[:] = [d for d in dirs if d not in ("__tests__", "node_modules", ".git", "dist", "dist-types")]
        rel_dir = Path(root_str).relative_to(src_sub)
        target_dir = dst_sub / rel_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        for fname in files:
            src_f = Path(root_str) / fname
            if src_f.is_symlink() or not src_f.is_file():
                continue
            dst_f = target_dir / fname
            shutil.copy2(src_f, dst_f)
            mode = os.stat(src_f).st_mode
            os.chmod(dst_f, 0o555 if (mode & 0o111) else 0o444)

def copy_ro_file(src_f: Path, dst_f: Path) -> None:
    if src_f.is_symlink() or not src_f.is_file():
        return
    dst_f.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_f, dst_f)
    mode = os.stat(src_f).st_mode
    os.chmod(dst_f, 0o555 if (mode & 0o111) else 0o444)

copy_ro_tree(ref / "scripts", view / "scripts")
copy_ro_tree(ref / "packages" / "commercial" / "scripts", view / "packages" / "commercial" / "scripts")
copy_ro_tree(ref / "packages" / "protocol" / "src", view / "packages" / "protocol" / "src")
copy_ro_file(ref / "packages" / "protocol" / "package.json", view / "packages" / "protocol" / "package.json")
copy_ro_tree(ref / ".github" / "scripts", view / ".github" / "scripts")

for root_file in ("package.json", "tsconfig.json", "biome.json"):
    copy_ro_file(ref / root_file, view / root_file)

os.symlink(ref_nm, view / "node_modules")
PY
}

# 专为行为上下文评测(check-context-static.ts)构造隔离视图：
# 仅在其真实动态 import 候选 promptSlots / intelligentUi 时使用；
# scripts/、packages/protocol/、node_modules 仍 100% 来自可信裁判，严禁链接 $staging/scripts 或 $staging/node_modules。
_master_referee_build_context_eval_view() { # <ref-root> <staging> <view-dir> <ref-nm>
  local ref_root="$1" staging="$2" view_dir="$3" ref_nm="$4"
  master_referee_build_exec_view "$ref_root" "$view_dir" "$ref_nm" || return 1
  python3 - "$staging" "$view_dir" <<'PY'
import os
from pathlib import Path
import sys

staging = Path(sys.argv[1]).resolve()
view = Path(sys.argv[2])

def link_if_exists(rel: str) -> None:
    src = staging / rel
    dst = view / rel
    if not src.exists() or dst.exists() or dst.is_symlink():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(src, dst)

for rel in (
    ".github/context-eval-baseline.json",
    "packages/gateway",
    "packages/storage",
    "packages/commercial/src",
    "packages/commercial/package.json",
    "docs",
):
    link_if_exists(rel)
PY
}

# 供 build_master_release 内独立 job(如 master_job_architecture)获取隔离裁判执行根目录。
# 保持调用方字面命令 `env -u ... npx --no-install tsx scripts/check-architecture.ts` 满足 parity 检查，
# 同时物理保证解释器与脚本 100% 源自外置裁判及其可信 node_modules(零借用 $staging)。
master_referee_prepare_exec_root() { # <staging> <rel-script> [full-sha] → stdout exec_root
  local staging="$1" rel="$2" full_sha="${3:-}" ref_root="" ref_nm="" resolved="" mode="" view_dir="" tag=""
  ref_root="$(master_resolve_referee_root "$staging" "$full_sha")" || return 1
  if ! resolved="$(master_referee_resolve_script "$ref_root" "$staging" "$rel")"; then
    mlog "✗ [referee] 裁判(${ref_root:-bootstrap})缺 $rel"
    return 1
  fi
  mode="${resolved%%$'\t'*}"
  if [[ "$mode" == referee ]]; then
    ref_nm="$(master_resolve_referee_node_modules "$ref_root" "$staging")" || return 1
    tag="$(printf '%s' "$rel" | tr '/.' '__')"
    view_dir="${MASTER_GATE_TMPDIR:-/tmp}/referee-job-${tag}-$$"
    master_referee_build_exec_view "$ref_root" "$view_dir" "$ref_nm" || return 1
    mlog "  [referee] $rel -> isolated referee ($ref_root, nm=$ref_nm)"
    printf '%s\n' "$view_dir"
    return 0
  fi
  mlog "  [referee-bootstrap] $rel absent in referee (${ref_root:-none}); running candidate staging copy"
  printf '%s\n' "$staging"
}

# 构建指向 $full_sha 的只读临时 gitdir(commondir 模式)，零污染 $staging 与 $REPO_ROOT，
# 让所有依赖 git ls-files / git diff / git merge-base 的门禁在无 .git 的 staging 内精确裁判 $full_sha。
_master_governance_prepare_pinned_git() { # <git-dir> <staging> <full-sha> <out-gitdir>
  local git_dir="$1" staging="$2" full_sha="$3" out_gitdir="$4" common_dir=""
  common_dir="$(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' \
    git --git-dir="$git_dir" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common_dir" && "$common_dir" != /* ]]; then
    common_dir="$(readlink -f -- "$git_dir/$common_dir" 2>/dev/null || true)"
  elif [[ -n "$common_dir" ]]; then
    common_dir="$(readlink -f -- "$common_dir" 2>/dev/null || true)"
  fi
  [[ -n "$common_dir" && -d "$common_dir" ]] || common_dir="$git_dir"
  rm -rf -- "$out_gitdir"
  mkdir -p -- "$out_gitdir"
  printf '%s\n' "$common_dir" >"$out_gitdir/commondir"
  printf '%s\n' "$full_sha" >"$out_gitdir/HEAD"
  printf '%s\n' "$staging/.git" >"$out_gitdir/gitdir"
  env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' \
    GIT_DIR="$out_gitdir" GIT_WORK_TREE="$staging" \
    git read-tree "$full_sha" >/dev/null
}

# 统一执行单条治理门：
# - 物理强制只跑隔离裁判副本（清理 NODE_OPTIONS / NODE_PATH / TSX_TSCONFIG_PATH）；
# - 解释器来自已验证可信裁判 node_modules (MASTER_GOV_TSX_CMD)，绝不借用 $staging/node_modules；
# - 外置裁判模式下绝不因失败或缺失而回落到候选 $staging！
_master_governance_run_gate() {
  # <ref_root> <ref_view> <staging> <rel> <runner:tsx|bash> <cwd> <git_dir_env> <work_tree_env> <req_pat> <optional:0|1> -- <args...>
  local ref_root="$1" ref_view="$2" staging="$3" rel="$4" runner="$5" run_cwd="$6"
  local env_git_dir="$7" env_work_tree="$8" req_pat="$9" optional="${10}"
  shift 10
  [[ "${1:-}" == "--" ]] && shift
  local resolved="" rc=0 mode="" script_exec=""
  resolved="$(master_referee_resolve_script "$ref_root" "$staging" "$rel" "$req_pat")" || rc=$?
  if (( rc == 3 )); then
    if [[ "$optional" == 1 ]]; then
      mlog "  [governance-compat] $rel 在裁判(${ref_root:-bootstrap})中尚未支持 $req_pat，跳过可选门(禁止回落候选)"
      return 0
    fi
    mlog "✗ governance fast gate: 裁判副本 $rel 缺少必需能力 $req_pat(禁止回落候选)"
    return 1
  fi
  if (( rc != 0 )); then
    if [[ "$optional" == 1 ]]; then
      if [[ -n "$ref_root" ]]; then
        mlog "  [referee-not-staged] 裁判($ref_root)尚未纳入可选门 $rel，跳过(禁止执行未审核候选脚本)"
      else
        mlog "  [governance-optional] 未引入 $rel，跳过"
      fi
      return 0
    fi
    mlog "✗ governance fast gate: ${ref_root:+外置裁判($ref_root)}${ref_root:-候选}缺必需门禁 $rel"
    return 1
  fi
  mode="${resolved%%$'\t'*}"
  if [[ "$mode" == referee ]]; then
    script_exec="$ref_view/$rel"
    mlog "  [referee] $rel ($ref_root)"
  else
    script_exec="$staging/$rel"
    mlog "  [referee-bootstrap] $rel (bootstrap mode, no external referee/live release)"
  fi
  local -a cmd=()
  if [[ "$runner" == bash ]]; then
    cmd=(bash "$script_exec" "$@")
  else
    cmd=("${MASTER_GOV_TSX_CMD[@]}" "$script_exec" "$@")
  fi
  if ! (
    cd "$run_cwd"
    export TMPDIR="$MASTER_GATE_TMPDIR"
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*"
    export OC_TEST_RETRY_ENFORCE=1
    export OC_PG_MIGRATION_BOSS_APPROVED=0
    export BOSS_APPROVED_CHANGELOG=0
    if [[ -n "$env_git_dir" ]]; then export GIT_DIR="$env_git_dir"; fi
    if [[ -n "$env_work_tree" ]]; then export GIT_WORK_TREE="$env_work_tree"; fi
    env -u NODE_OPTIONS -u NODE_PATH -u TSX_TSCONFIG_PATH -u npm_config_node_options "${cmd[@]}"
  ); then
    mlog "✗ pinned governance gate 失败 ($mode): $rel"
    return 1
  fi
}

# 在不可变 pinned staging archive 内执行 Wave 1/2 + OCV5-903/904 全量只读治理硬门：
# - 物理强制宿主机外置裁判(REFEREE_ROOT > MASTER_LIVE_LINK)，并验证 MANIFEST.json / TRANSITION_APPROVAL.json；
# - 裁判整条执行链完全隔离：tsx/biome/scripts/packages/protocol 100% 源自可信裁判环境，候选 $staging 仅作 --root 只读数据传入；
# - 零写操作、零外部逃生口（强制 OC_TEST_RETRY_ENFORCE=1 / OC_PG_MIGRATION_BOSS_APPROVED=0 / BOSS_APPROVED_CHANGELOG=0）。
master_run_governance_fast_gates() { # <pinned-staging> <full-sha>
  local staging="$1" full_sha="$2" base_ref="" base_sha="" git_dir="" head_sha=""
  local ref_root="" ref_nm="" ref_view="" ctx_view="" pinned_gitdir="" s changed_mig changed_cl
  local ref_biome="" fs_script="" debt_script=""
  local -a g=(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' git -C "$REPO_ROOT")
  local -a MASTER_GOV_TSX_CMD=()
  local -a pg_file_args=() fs_args=() debt_args=() biome_args=()

  mlog "── Wave 1/2 治理快门(只读/隔离外置裁判, pinned staging @ ${full_sha:0:12}) ──"
  ref_root="$(master_resolve_referee_root "$staging" "$full_sha")" || {
    mlog "✗ governance fast gate: 外置裁判解析或完整性/过渡批准校验失败(fail-closed)"
    return 1
  }
  ref_nm="$(master_resolve_referee_node_modules "$ref_root" "$staging")" || {
    mlog "✗ governance fast gate: 无法解析可信裁判 node_modules(fail-closed)"
    return 1
  }
  if [[ -f "$ref_nm/tsx/dist/cli.mjs" ]]; then
    MASTER_GOV_TSX_CMD=(node "$ref_nm/tsx/dist/cli.mjs")
  elif [[ -x "$ref_nm/.bin/tsx" ]]; then
    MASTER_GOV_TSX_CMD=("$ref_nm/.bin/tsx")
  else
    mlog "✗ governance fast gate: 可信裁判 node_modules 缺少 tsx ($ref_nm)"
    return 1
  fi
  if [[ -x "$ref_nm/.bin/biome" ]]; then
    ref_biome="$ref_nm/.bin/biome"
  fi

  if [[ -n "$ref_root" ]]; then
    if [[ -f "$ref_root/TRANSITION_APPROVAL.json" ]]; then
      mlog "  [referee-transition] audited transition referee verified for ${full_sha:0:12} (root=$ref_root, nm=$ref_nm)"
    else
      mlog "  [referee] authoritative isolated root=$ref_root (nm=$ref_nm)"
    fi
    ref_view="$MASTER_GATE_TMPDIR/referee-view-$$"
    master_referee_build_exec_view "$ref_root" "$ref_view" "$ref_nm" || return 1
  else
    mlog "  [referee-bootstrap] no external referee or live release; bootstrap mode (nm=$ref_nm)"
    ref_view="$staging"
  fi

  # ── Phase 1: 纯文件系统/静态快门(全部显式传 --root "$staging" 只读数据根) ──
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-docs-links.ts tsx "$ref_view" "" "" "" 0 -- --root "$staging" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-ui-hard-gates.ts tsx "$ref_view" "" "" "" 0 -- --src "$staging/packages/web-react/src" --baseline "$staging/packages/web-react/ui-static-baseline.json" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-no-silent-model-downgrade.ts tsx "$ref_view" "" "" "" 0 -- --root "$staging" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-v5-route-sync.ts tsx "$ref_view" "" "" "" 0 -- --root "$staging" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-feature-flags-ttl.ts tsx "$ref_view" "" "" "" 0 -- --root "$staging" --fail-on-expired || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-schedulers.ts tsx "$ref_view" "" "" "" 0 -- --root "$staging" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" packages/commercial/scripts/lint-agent-containers-sql.ts tsx "$ref_view" "" "" "" 0 -- --root "$staging" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-v5-test-retries.ts tsx "$ref_view" "" "" "" 0 -- --root "$staging" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-integ-tiers.ts tsx "$ref_view" "" "" "" 0 -- --root "$staging" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-v5-e2e-selectors.ts tsx "$ref_view" "" "" "" 0 -- --root "$staging" || return 1

  # check-context-static.ts 为行为评测(动态 import 候选 promptSlots/intelligentUi)，单独构造最小行为视图，绝不污染静态 $ref_view
  ctx_view="$ref_view"
  if [[ -n "$ref_root" && -f "$ref_view/scripts/check-context-static.ts" ]] \
    && grep -qF 'packages/commercial/src/intelligentUi' "$ref_view/scripts/check-context-static.ts" 2>/dev/null; then
    ctx_view="$MASTER_GATE_TMPDIR/referee-ctx-view-$$"
    _master_referee_build_context_eval_view "$ref_root" "$staging" "$ctx_view" "$ref_nm" || return 1
  fi
  _master_governance_run_gate "$ref_root" "$ctx_view" "$staging" scripts/check-context-static.ts tsx "$ctx_view" "" "" "" 0 -- --skip-sub-evals || return 1

  # ── Phase 2: 解析非自身基线 + 只读 pinned gitdir ──
  base_ref="$(master_resolve_governance_base_ref "$full_sha")" || return 1
  base_sha="$("${g[@]}" rev-parse --verify --quiet "${base_ref}^{commit}" 2>/dev/null || true)"
  base_sha="$(_master_governance_valid_merge_base "$base_sha" "$full_sha" || true)"
  if [[ -z "$base_sha" ]]; then
    mlog "✗ governance fast gate: 解析出的基线无效、等于目标 commit 或超前导致 merge-base 退化 (base=$base_ref full=${full_sha:0:12})"
    return 1
  fi
  base_ref="$base_sha"
  git_dir="$("${g[@]}" rev-parse --absolute-git-dir 2>/dev/null || true)"
  if [[ -z "$git_dir" || ! -d "$git_dir" ]]; then
    mlog "✗ governance fast gate: 无法解析 REPO_ROOT=$REPO_ROOT 的 git-dir"
    return 1
  fi
  pinned_gitdir="$MASTER_GATE_TMPDIR/pinned-git-$$"
  _master_governance_prepare_pinned_git "$git_dir" "$staging" "$full_sha" "$pinned_gitdir" || {
    mlog "✗ governance fast gate: 构建只读 pinned gitdir 失败"
    return 1
  }
  mlog "  governance base_ref=$base_ref (${base_sha:0:12})"

  # ── Phase 3: Git 感知治理硬门(全部隔离在 $ref_view 运行、候选仅通过 --root "$staging" 传入)──
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-rest-contract-compat.ts tsx "$ref_view" "$git_dir" "" "" 0 -- --root "$staging" --base "$base_ref" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-monotonic-baselines.ts tsx "$ref_view" "$git_dir" "" "" 0 -- --root "$staging" --base "$base_ref" || return 1

  fs_script="${ref_root:+$ref_view/scripts/check-file-size-ratchet.ts}"
  [[ -n "$fs_script" ]] || fs_script="$staging/scripts/check-file-size-ratchet.ts"
  fs_args=(--base "$base_ref" --head "$full_sha")
  if [[ -f "$fs_script" ]] && grep -qF -- '--root' "$fs_script" 2>/dev/null; then
    fs_args=(--root "$staging" "${fs_args[@]}")
  fi
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-file-size-ratchet.ts tsx "$ref_view" "$pinned_gitdir" "$staging" "" 0 -- "${fs_args[@]}" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-gate-couplings.ts tsx "$ref_view" "$pinned_gitdir" "$staging" "" 0 -- --root "$staging" --check || return 1

  biome_args=(--root "$staging" --base "$base_ref")
  if [[ -n "$ref_biome" ]]; then
    biome_args+=(--biome-bin "$ref_biome")
  fi
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-biome-changed.sh bash "$ref_view" "$pinned_gitdir" "$staging" "" 0 -- "${biome_args[@]}" || return 1

  # PG migration safety (防线 3: 强制 OC_PG_MIGRATION_BOSS_APPROVED=0)
  if ! changed_mig="$("${g[@]}" diff --name-only --diff-filter=AMR "${base_ref}...${full_sha}" -- 'packages/commercial/src/db/migrations/*.sql')"; then
    mlog "✗ governance fast gate: git diff ${base_ref}...${full_sha} 迁移清单失败"
    return 1
  fi
  while IFS= read -r s; do
    [[ -n "$s" && -f "$staging/$s" ]] || continue
    pg_file_args+=(--file "$staging/$s")
  done <<<"$changed_mig"
  if (( ${#pg_file_args[@]} > 0 )); then
    _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-pg-migration-safety.ts tsx "$ref_view" "" "" "" 0 -- --root "$staging" --no-squawk "${pg_file_args[@]}" || return 1
  else
    if ! master_referee_resolve_script "$ref_root" "$staging" scripts/check-pg-migration-safety.ts >/dev/null; then
      mlog "✗ governance fast gate: ${ref_root:+外置裁判}${ref_root:-候选}缺 scripts/check-pg-migration-safety.ts"
      return 1
    fi
    mlog "  [pg-migration-safety] ok: 0 changed migration file(s) (${base_sha:0:12}...${full_sha:0:12})"
  fi

  # Changelog guard (防线 3: 强制 BOSS_APPROVED_CHANGELOG=0)
  if ! master_referee_resolve_script "$ref_root" "$staging" scripts/check-changelog-guard.ts >/dev/null; then
    mlog "✗ governance fast gate: ${ref_root:+外置裁判}${ref_root:-候选}缺 scripts/check-changelog-guard.ts"
    return 1
  fi
  head_sha="$("${g[@]}" rev-parse --verify HEAD 2>/dev/null || true)"
  if [[ "$head_sha" == "$full_sha" && "${ALLOW_DIRTY:-0}" != 1 && "${PLATFORM_FROM_HEAD:-0}" != 1 ]]; then
    _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-changelog-guard.ts tsx "$ref_view" "" "" "" 0 -- --root "$REPO_ROOT" --base "$base_ref" || return 1
  else
    if ! changed_cl="$("${g[@]}" diff --name-only "${base_ref}...${full_sha}" -- changelog.json)"; then
      mlog "✗ governance fast gate: git diff ${base_ref}...${full_sha} changelog.json 失败"
      return 1
    fi
    if [[ -n "$changed_cl" ]]; then
      mlog "✗ [GATE-ERROR] CHANGELOG-GUARD: changelog.json changed in ${base_sha:0:12}...${full_sha:0:12} (automated release train blocks unapproved changelog edits)"
      return 1
    else
      mlog "  [changelog-guard] ok: changelog.json untouched (${base_sha:0:12}...${full_sha:0:12})"
    fi
  fi

  # ── Phase 4: OCV5-904/905/906 治理棘轮门(全部显式 --root "$staging"；check-debt-ttl 传 --base/--head)──
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-a0-monotonic.ts tsx "$ref_view" "$pinned_gitdir" "$staging" "" 1 -- --root "$staging" --base "$base_ref" --head "$full_sha" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-ai-smells-ratchet.ts tsx "$ref_view" "$pinned_gitdir" "$staging" "" 1 -- --root "$staging" --enforce --base "$base_ref" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-complexity-ratchet.ts tsx "$ref_view" "$pinned_gitdir" "$staging" "" 1 -- --root "$staging" --enforce --base "$base_ref" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-clones-ratchet.ts tsx "$ref_view" "$pinned_gitdir" "$staging" "" 1 -- --root "$staging" --enforce --base "$base_ref" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-security-sast.ts tsx "$ref_view" "$pinned_gitdir" "$staging" "" 1 -- --root "$staging" --enforce --base "$base_ref" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-cross-family-audit.ts tsx "$ref_view" "$pinned_gitdir" "$staging" "--enforce-commit" 1 -- --enforce-commit --root "$staging" --base "$base_ref" --head "$full_sha" || return 1

  debt_script="${ref_root:+$ref_view/scripts/check-debt-ttl.ts}"
  [[ -n "$debt_script" ]] || debt_script="$staging/scripts/check-debt-ttl.ts"
  debt_args=(--root "$staging" --enforce)
  if [[ -f "$debt_script" ]] && grep -qF -- '--base' "$debt_script" 2>/dev/null; then
    debt_args+=(--base "$base_ref" --head "$full_sha")
  fi
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-debt-ttl.ts tsx "$ref_view" "$pinned_gitdir" "$staging" "" 1 -- "${debt_args[@]}" || return 1

  tsum_note governanceFastGates "passed:${base_sha:0:12}" 2>/dev/null || :
  mlog "  ✓ Wave 1/2 + OCV5-903/904 隔离治理快门全部通过 (base=$base_ref, referee=${ref_root:-bootstrap})"
}
