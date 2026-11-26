#!/usr/bin/env bash
# v5-selfhost-governance-gates.sh — Wave 1/2 只读秒级治理快门 + 宿主机外置裁判(OCV5-847/849/859/904)。
# 由 v5-selfhost-master-release-lib.sh source；在无 .git 的 pinned staging archive 中运行，
# 严格只读、物理隔离裁判副本(禁止候选自裁)，并封堵外部逃生环境变量(docs/V5_SELFHOST_PLAYBOOK.md §6.2 防线 3)。

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

# ── OCV5-904 宿主机物理外置裁判(Host Pinned Referee)────────────────────────
# 权威裁判根优先级：
#   1. ${OC_V5_REFEREE_ROOT:-/opt/openclaude/harness-gate/referee} (root 只读外置镜像)
#   2. 已验证的 $MASTER_LIVE_LINK (有完整 .complete 且未 .poisoned)
#   3. 两者均不存在(首次自举/离线单测) → 返回空字符串，仅允许 [referee-bootstrap] 模式
# 严禁指向候选 $staging 目录自身；若外部裁判已安装但权限/属主被篡改则 fail-closed (rc=2)。
master_resolve_referee_root() { # <staging> → stdout referee_root_or_empty
  local staging="$1" staging_canon="" ext="${OC_V5_REFEREE_ROOT:-${MASTER_REFEREE_ROOT:-/opt/openclaude/harness-gate/referee}}"
  local cand="" uid="" mode="" live_sha=""
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
    if [[ "$(id -u)" == 0 && "$ext" == /opt/openclaude/* ]] || [[ "${OC_V5_REFEREE_REQUIRE_ROOT:-0}" == 1 ]]; then
      read -r uid mode < <(stat -Lc '%u %a' -- "$cand" 2>/dev/null || echo '999999 777')
      if [[ "$uid" != 0 ]] || (( (8#$mode & 8#022) != 0 )); then
        mlog "✗ [referee] 外置裁判根属主/权限不可信(uid=$uid mode=$mode, 要求 root 且非 group/other 可写): $cand"
        return 2
      fi
    fi
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

# 解析单个治理脚本来源：
#   stdout: "referee\t<abs>" | "bootstrap\t<abs>"
#   rc=0 命中; rc=1 裁判与候选均无此脚本; rc=3 均不支持所需能力标记(require_pat)
# 安全铁律：只要 referee 中已存在该脚本(且满足能力标记)，物理强制只跑 referee 副本！
master_referee_resolve_script() { # <ref-root-or-empty> <staging> <rel> [require-substr]
  local ref_root="$1" staging="$2" rel="$3" req_pat="${4:-}"
  local ref_has=0 stg_has=0
  if [[ -n "$ref_root" && -f "$ref_root/$rel" ]]; then ref_has=1; fi
  if [[ -f "$staging/$rel" ]]; then stg_has=1; fi

  if [[ "$ref_has" == 1 ]]; then
    if [[ -z "$req_pat" ]] || grep -qF -- "$req_pat" "$ref_root/$rel" 2>/dev/null; then
      printf 'referee\t%s\n' "$ref_root/$rel"
      return 0
    fi
    # 首滚能力自举：旧 referee 副本尚未引入新 CLI 标志(如 --enforce-commit)，但候选已引入
    if [[ "$stg_has" == 1 ]] && grep -qF -- "$req_pat" "$staging/$rel" 2>/dev/null; then
      printf 'bootstrap\t%s\n' "$staging/$rel"
      return 0
    fi
    return 3
  fi

  if [[ "$stg_has" == 1 ]]; then
    if [[ -n "$req_pat" ]] && ! grep -qF -- "$req_pat" "$staging/$rel" 2>/dev/null; then
      return 3
    fi
    printf 'bootstrap\t%s\n' "$staging/$rel"
    return 0
  fi

  return 1
}

# 在 $MASTER_GATE_TMPDIR 中构建只读隔离裁判执行视图(零污染 $staging / $ref_root)：
# - packages/docs/deploy/arch/.github/e2e/node_modules 等符号链向 $staging(被评候选代码与依赖)；
# - scripts/ 与 packages/commercial/scripts/ 中凡 referee 拥有的脚本与辅助库均复制自 $ref_root，
#   物理覆盖同名候选文件，确保 import.meta.url 相对解析与 tsx 依赖解析同时成立且候选无法篡改裁判！
# - 当传入 single_script_rel(如 scripts/check-biome-changed.sh)时，仅覆盖该单个裁判脚本，
#   保持 scripts/ 下其余待检 .ts/.sh 文件指向候选 $staging。
master_referee_build_exec_view() { # <ref-root-or-empty> <staging> <view-dir> [single-script-rel]
  local ref_root="$1" staging="$2" view_dir="$3" single_rel="${4:-}"
  python3 - "$ref_root" "$staging" "$view_dir" "$single_rel" <<'PY'
import os
from pathlib import Path
import shutil
import sys

ref_raw, staging_raw, view_raw, single_rel = sys.argv[1:5]
staging = Path(staging_raw).resolve()
view = Path(view_raw)
ref = Path(ref_raw).resolve() if ref_raw else None

if view.exists() or view.is_symlink():
    shutil.rmtree(view)
view.mkdir(parents=True, mode=0o700)

def symlink_entries(src_dir: Path, dst_dir: Path, skip: set[str]):
    dst_dir.mkdir(parents=True, exist_ok=True)
    if not src_dir.is_dir():
        return
    for ent in src_dir.iterdir():
        if ent.name in skip:
            continue
        os.symlink(ent, dst_dir / ent.name)

def overlay_referee_dir(ref_sub: Path, stg_sub: Path, dst_sub: Path):
    dst_sub.mkdir(parents=True, exist_ok=True)
    # 1. Seed candidate-only helpers (for bootstrap scripts that reference new lib modules)
    if stg_sub.is_dir():
        for root_str, dirs, files in os.walk(stg_sub, followlinks=False):
            dirs[:] = [d for d in dirs if d not in ("__tests__", "node_modules", ".git")]
            rel_dir = Path(root_str).relative_to(stg_sub)
            target_dir = dst_sub / rel_dir
            target_dir.mkdir(parents=True, exist_ok=True)
            for fname in files:
                src_f = Path(root_str) / fname
                dst_f = target_dir / fname
                if not dst_f.exists() and not dst_f.is_symlink():
                    os.symlink(src_f, dst_f)
    # 2. Physically overwrite with referee files (regular copied files, never symlinks to staging)
    if ref_sub and ref_sub.is_dir():
        for root_str, dirs, files in os.walk(ref_sub, followlinks=False):
            dirs[:] = [d for d in dirs if d not in ("__tests__", "node_modules", ".git")]
            rel_dir = Path(root_str).relative_to(ref_sub)
            target_dir = dst_sub / rel_dir
            target_dir.mkdir(parents=True, exist_ok=True)
            for fname in files:
                src_f = Path(root_str) / fname
                if src_f.is_symlink() or not src_f.is_file():
                    continue
                dst_f = target_dir / fname
                if dst_f.exists() or dst_f.is_symlink():
                    dst_f.unlink()
                shutil.copy2(src_f, dst_f)
                mode = os.stat(src_f).st_mode
                os.chmod(dst_f, 0o555 if (mode & 0o111) else 0o444)

if single_rel:
    symlink_entries(staging, view, {"scripts"})
    stg_scripts = staging / "scripts"
    dst_scripts = view / "scripts"
    dst_scripts.mkdir(parents=True, exist_ok=True)
    rel_p = Path(single_rel)
    target_name = rel_p.name if rel_p.parts[:1] == ("scripts",) and len(rel_p.parts) == 2 else ""
    symlink_entries(stg_scripts, dst_scripts, {target_name} if target_name else set())
    if ref and (ref / single_rel).is_file():
        dst_f = view / single_rel
        dst_f.parent.mkdir(parents=True, exist_ok=True)
        if dst_f.exists() or dst_f.is_symlink():
            dst_f.unlink()
        shutil.copy2(ref / single_rel, dst_f)
        os.chmod(dst_f, 0o555)
else:
    symlink_entries(staging, view, {"scripts", "packages"})
    # Mirror packages/, replacing only packages/commercial/scripts/ with referee overlay
    stg_pkgs = staging / "packages"
    if stg_pkgs.is_dir():
        symlink_entries(stg_pkgs, view / "packages", {"commercial"})
        stg_comm = stg_pkgs / "commercial"
        if stg_comm.is_dir():
            symlink_entries(stg_comm, view / "packages" / "commercial", {"scripts"})
            ref_comm_scripts = (ref / "packages" / "commercial" / "scripts") if ref else None
            overlay_referee_dir(ref_comm_scripts, stg_comm / "scripts", view / "packages" / "commercial" / "scripts")
    ref_scripts = (ref / "scripts") if ref else None
    overlay_referee_dir(ref_scripts, staging / "scripts", view / "scripts")
PY
}

# 供 build_master_release 内独立 job(如 master_job_architecture)获取裁判执行根目录。
# 保持调用方字面命令 `npx --no-install tsx scripts/check-architecture.ts` 不变(满足 parity 检查)，
# 同时物理保证执行的是外置裁判副本(仅在裁判无该脚本时打印 [referee-bootstrap] 回落 staging)。
master_referee_prepare_exec_root() { # <staging> <rel-script> → stdout exec_root
  local staging="$1" rel="$2" ref_root="" resolved="" mode="" view_dir="" tag=""
  ref_root="$(master_resolve_referee_root "$staging")" || return 1
  if ! resolved="$(master_referee_resolve_script "$ref_root" "$staging" "$rel")"; then
    mlog "✗ [referee] 裁判与候选均缺 $rel"
    return 1
  fi
  mode="${resolved%%$'\t'*}"
  if [[ "$mode" == referee ]]; then
    tag="$(printf '%s' "$rel" | tr '/.' '__')"
    view_dir="${MASTER_GATE_TMPDIR:-/tmp}/referee-job-${tag}-$$"
    master_referee_build_exec_view "$ref_root" "$staging" "$view_dir" || return 1
    mlog "  [referee] $rel -> pinned referee ($ref_root)"
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

# 统一执行单条治理门：物理优先 referee 副本；仅当 referee 缺失该新脚本时允许 bootstrap 并打审计日志。
_master_governance_run_gate() {
  # <ref_root> <ref_view> <staging> <rel> <runner:tsx|bash> <cwd> <git_dir_env> <work_tree_env> <req_pat> <optional:0|1> -- <args...>
  local ref_root="$1" ref_view="$2" staging="$3" rel="$4" runner="$5" run_cwd="$6"
  local env_git_dir="$7" env_work_tree="$8" req_pat="$9" optional="${10}"
  shift 10
  [[ "${1:-}" == "--" ]] && shift
  local resolved="" rc=0 mode="" script_exec=""
  resolved="$(master_referee_resolve_script "$ref_root" "$staging" "$rel" "$req_pat")" || rc=$?
  if (( rc == 3 )); then
    mlog "  [governance-compat] $rel 尚未支持 $req_pat，跳过首滚兼容门"
    return 0
  fi
  if (( rc != 0 )); then
    if [[ "$optional" == 1 ]]; then
      mlog "  [governance-optional] 未引入 $rel，跳过"
      return 0
    fi
    mlog "✗ governance fast gate: 候选缺 $rel"
    return 1
  fi
  mode="${resolved%%$'\t'*}"
  if [[ "$mode" == referee ]]; then
    script_exec="$ref_view/$rel"
    mlog "  [referee] $rel ($ref_root)"
  else
    script_exec="$staging/$rel"
    mlog "  [referee-bootstrap] $rel absent in referee (${ref_root:-none}); running candidate staging copy"
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
    "${cmd[@]}"
  ); then
    mlog "✗ pinned governance gate 失败 ($mode): $rel"
    return 1
  fi
}

# 在不可变 pinned staging archive 内执行 Wave 1/2 + OCV5-904 全量只读治理硬门：
# - 物理强制宿主机外置裁判(REFEREE_ROOT > MASTER_LIVE_LINK)；仅对 referee 中不存在的新脚本打印 [referee-bootstrap]
# - 零写操作、零外部逃生口（强制 OC_TEST_RETRY_ENFORCE=1 / OC_PG_MIGRATION_BOSS_APPROVED=0 / BOSS_APPROVED_CHANGELOG=0）
# - 通过只读 pinned gitdir 对比 ${base_ref}...${full_sha}，兼容无 .git 目录与 detached HEAD
master_run_governance_fast_gates() { # <pinned-staging> <full-sha>
  local staging="$1" full_sha="$2" base_ref="" base_sha="" git_dir="" head_sha=""
  local ref_root="" ref_view="" biome_view="" pinned_gitdir="" s changed_mig changed_cl
  local -a g=(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' git -C "$REPO_ROOT")
  local -a MASTER_GOV_TSX_CMD=(npx --no-install tsx)
  if [[ -f "$staging/node_modules/tsx/dist/cli.mjs" ]]; then
    MASTER_GOV_TSX_CMD=(node "$staging/node_modules/tsx/dist/cli.mjs")
  elif [[ -x "$staging/node_modules/.bin/tsx" ]]; then
    MASTER_GOV_TSX_CMD=("$staging/node_modules/.bin/tsx")
  fi
  local -a pg_file_args=()

  mlog "── Wave 1/2 治理快门(只读/物理外置裁判, pinned staging @ ${full_sha:0:12}) ──"
  ref_root="$(master_resolve_referee_root "$staging")" || {
    mlog "✗ governance fast gate: 外置裁判解析失败(fail-closed)"
    return 1
  }
  if [[ -n "$ref_root" ]]; then
    mlog "  [referee] authoritative root=$ref_root"
    ref_view="$MASTER_GATE_TMPDIR/referee-view-$$"
    master_referee_build_exec_view "$ref_root" "$staging" "$ref_view" || return 1
  else
    mlog "  [referee-bootstrap] no external referee or live release; bootstrap mode"
    ref_view="$staging"
  fi

  # ── Phase 1: 纯文件系统/静态快门 ──
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-docs-links.ts tsx "$staging" "" "" "" 0 -- --root "$staging" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-ui-hard-gates.ts tsx "$staging" "" "" "" 0 -- || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-no-silent-model-downgrade.ts tsx "$staging" "" "" "" 0 -- --root "$staging" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-v5-route-sync.ts tsx "$staging" "" "" "" 0 -- --root "$staging" || return 1
  # OCV5-904: 补上此前漏传的 --fail-on-expired，彻底拦截过期 feature flag！
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-feature-flags-ttl.ts tsx "$staging" "" "" "" 0 -- --root "$staging" --fail-on-expired || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-schedulers.ts tsx "$ref_view" "" "" "" 0 -- || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" packages/commercial/scripts/lint-agent-containers-sql.ts tsx "$ref_view" "" "" "" 0 -- || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-v5-test-retries.ts tsx "$staging" "" "" "" 0 -- --root "$staging" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-integ-tiers.ts tsx "$ref_view" "" "" "" 0 -- || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-v5-e2e-selectors.ts tsx "$ref_view" "" "" "" 0 -- || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-context-static.ts tsx "$ref_view" "" "" "" 0 -- --skip-sub-evals || return 1

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

  # ── Phase 3: Git 感知治理硬门(补齐 file-size-ratchet / gate-couplings / biome-changed)──
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-rest-contract-compat.ts tsx "$staging" "$git_dir" "" "" 0 -- --root "$staging" --base "$base_ref" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-monotonic-baselines.ts tsx "$staging" "$git_dir" "" "" 0 -- --root "$staging" --base "$base_ref" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-file-size-ratchet.ts tsx "$staging" "$pinned_gitdir" "$staging" "" 0 -- --base "$base_ref" --head "$full_sha" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-gate-couplings.ts tsx "$staging" "$pinned_gitdir" "$staging" "" 0 -- --root "$staging" --check || return 1

  # biome-changed: 单独构造单文件裁判视图，保证 scripts/ 下候选改动的 .ts 文件不被旧裁判副本遮蔽
  if [[ -n "$ref_root" && -f "$ref_root/scripts/check-biome-changed.sh" ]]; then
    biome_view="$MASTER_GATE_TMPDIR/referee-biome-view-$$"
    master_referee_build_exec_view "$ref_root" "$staging" "$biome_view" scripts/check-biome-changed.sh || return 1
  else
    biome_view="$staging"
  fi
  _master_governance_run_gate "$ref_root" "$biome_view" "$staging" scripts/check-biome-changed.sh bash "$staging" "$pinned_gitdir" "$staging" "" 0 -- --base "$base_ref" || return 1

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
    _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-pg-migration-safety.ts tsx "$staging" "" "" "" 0 -- --root "$staging" --no-squawk "${pg_file_args[@]}" || return 1
  else
    if ! master_referee_resolve_script "$ref_root" "$staging" scripts/check-pg-migration-safety.ts >/dev/null; then
      mlog "✗ governance fast gate: 候选缺 scripts/check-pg-migration-safety.ts"
      return 1
    fi
    mlog "  [pg-migration-safety] ok: 0 changed migration file(s) (${base_sha:0:12}...${full_sha:0:12})"
  fi

  # Changelog guard (防线 3: 强制 BOSS_APPROVED_CHANGELOG=0)
  if ! master_referee_resolve_script "$ref_root" "$staging" scripts/check-changelog-guard.ts >/dev/null; then
    mlog "✗ governance fast gate: 候选缺 scripts/check-changelog-guard.ts"
    return 1
  fi
  head_sha="$("${g[@]}" rev-parse --verify HEAD 2>/dev/null || true)"
  if [[ "$head_sha" == "$full_sha" && "${ALLOW_DIRTY:-0}" != 1 && "${PLATFORM_FROM_HEAD:-0}" != 1 ]]; then
    _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-changelog-guard.ts tsx "$staging" "" "" "" 0 -- --root "$REPO_ROOT" --base "$base_ref" || return 1
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

  # ── Phase 4: OCV5-904/905/906 新增治理棘轮门(若脚本存在即强制跑; 首次上线自动 [referee-bootstrap])──
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-a0-monotonic.ts tsx "$staging" "$pinned_gitdir" "$staging" "" 1 -- --base "$base_ref" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-ai-smells-ratchet.ts tsx "$staging" "$pinned_gitdir" "$staging" "" 1 -- --enforce || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-complexity-ratchet.ts tsx "$staging" "$pinned_gitdir" "$staging" "" 1 -- --enforce || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-clones-ratchet.ts tsx "$staging" "$pinned_gitdir" "$staging" "" 1 -- --enforce || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-cross-family-audit.ts tsx "$staging" "$pinned_gitdir" "$staging" "--enforce-commit" 1 -- --enforce-commit --root "$staging" --base "$base_ref" --head "$full_sha" || return 1
  _master_governance_run_gate "$ref_root" "$ref_view" "$staging" scripts/check-debt-ttl.ts tsx "$staging" "$pinned_gitdir" "$staging" "" 1 -- --enforce || return 1

  tsum_note governanceFastGates "passed:${base_sha:0:12}" 2>/dev/null || :
  mlog "  ✓ Wave 1/2 + OCV5-904 治理快门全部通过 (base=$base_ref, referee=${ref_root:-bootstrap})"
}
