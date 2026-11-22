#!/usr/bin/env bash
# v5-selfhost-governance-gates.sh — Wave 1/2 只读秒级治理快门(OCV5-847/849/859)。
# 由 v5-selfhost-master-release-lib.sh source；在无 .git 的 pinned staging archive 中运行，
# 严格只读且强制封堵外部逃生环境变量(docs/V5_SELFHOST_PLAYBOOK.md §6.2 防线 3)。

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

# 在不可变 pinned staging archive 内执行 Wave 1/2 只读秒级治理快门：
# - 零写操作、零外部逃生口（强制 OC_TEST_RETRY_ENFORCE=1 / OC_PG_MIGRATION_BOSS_APPROVED=0 / BOSS_APPROVED_CHANGELOG=0）
# - 通过只读 GIT_DIR 对比 ${base_ref}...${full_sha}，兼容无 .git 目录与 detached HEAD
master_run_governance_fast_gates() { # <pinned-staging> <full-sha>
  local staging="$1" full_sha="$2" base_ref="" base_sha="" git_dir="" head_sha="" s changed_mig changed_cl
  local -a g=(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' git -C "$REPO_ROOT")
  local -a tsx_cmd=(npx --no-install tsx)
  if [[ -f "$staging/node_modules/tsx/dist/cli.mjs" ]]; then
    tsx_cmd=(node "$staging/node_modules/tsx/dist/cli.mjs")
  elif [[ -x "$staging/node_modules/.bin/tsx" ]]; then
    tsx_cmd=("$staging/node_modules/.bin/tsx")
  fi
  local -a fast_scripts=(
    scripts/check-docs-links.ts
    scripts/check-ui-hard-gates.ts
    scripts/check-no-silent-model-downgrade.ts
    scripts/check-v5-route-sync.ts
    scripts/check-feature-flags-ttl.ts
    scripts/check-schedulers.ts
    packages/commercial/scripts/lint-agent-containers-sql.ts
    scripts/check-v5-test-retries.ts
    scripts/check-integ-tiers.ts
    scripts/check-v5-e2e-selectors.ts
  )
  local -a pg_file_args=()

  mlog "── Wave 1/2 治理快门(只读/秒级, pinned staging @ ${full_sha:0:12}) ──"
  for s in "${fast_scripts[@]}"; do
    if [[ ! -f "$staging/$s" ]]; then
      mlog "✗ governance fast gate: 候选缺 $s"
      return 1
    fi
    if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" \
        GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" \
        OC_TEST_RETRY_ENFORCE=1 \
        "${tsx_cmd[@]}" "$s" ); then
      mlog "✗ pinned governance fast gate 失败: $s"
      return 1
    fi
  done

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
  mlog "  governance base_ref=$base_ref (${base_sha:0:12})"

  if [[ ! -f "$staging/scripts/check-rest-contract-compat.ts" ]]; then
    mlog "✗ governance fast gate: 候选缺 scripts/check-rest-contract-compat.ts"
    return 1
  fi
  if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" \
      GIT_DIR="$git_dir" \
      GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" \
      "${tsx_cmd[@]}" scripts/check-rest-contract-compat.ts --root "$staging" --base "$base_ref" ); then
    mlog "✗ pinned REST contract compat gate 失败 (base=$base_ref)"
    return 1
  fi

  if [[ ! -f "$staging/scripts/check-monotonic-baselines.ts" ]]; then
    mlog "✗ governance fast gate: 候选缺 scripts/check-monotonic-baselines.ts"
    return 1
  fi
  if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" \
      GIT_DIR="$git_dir" \
      GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" \
      "${tsx_cmd[@]}" scripts/check-monotonic-baselines.ts --root "$staging" --base "$base_ref" ); then
    mlog "✗ pinned monotonic baselines gate 失败 (base=$base_ref)"
    return 1
  fi

  if [[ ! -f "$staging/scripts/check-pg-migration-safety.ts" ]]; then
    mlog "✗ governance fast gate: 候选缺 scripts/check-pg-migration-safety.ts"
    return 1
  fi
  if ! changed_mig="$("${g[@]}" diff --name-only --diff-filter=AMR "${base_ref}...${full_sha}" -- 'packages/commercial/src/db/migrations/*.sql')"; then
    mlog "✗ governance fast gate: git diff ${base_ref}...${full_sha} 迁移清单失败"
    return 1
  fi
  while IFS= read -r s; do
    [[ -n "$s" && -f "$staging/$s" ]] || continue
    pg_file_args+=(--file "$staging/$s")
  done <<<"$changed_mig"
  if (( ${#pg_file_args[@]} > 0 )); then
    # 防线 3(docs/V5_SELFHOST_PLAYBOOK.md §6.2):自动列车显式强制 OC_PG_MIGRATION_BOSS_APPROVED=0，
    # 拒绝继承父环境逃生变量，与人工审批入口彻底隔离。
    if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" \
        OC_PG_MIGRATION_BOSS_APPROVED=0 \
        "${tsx_cmd[@]}" scripts/check-pg-migration-safety.ts --root "$staging" --no-squawk "${pg_file_args[@]}" ); then
      mlog "✗ pinned PG migration safety gate 失败 (base=$base_ref)"
      return 1
    fi
  else
    mlog "  [pg-migration-safety] ok: 0 changed migration file(s) (${base_sha:0:12}...${full_sha:0:12})"
  fi

  if [[ ! -f "$staging/scripts/check-changelog-guard.ts" ]]; then
    mlog "✗ governance fast gate: 候选缺 scripts/check-changelog-guard.ts"
    return 1
  fi
  head_sha="$("${g[@]}" rev-parse --verify HEAD 2>/dev/null || true)"
  if [[ "$head_sha" == "$full_sha" && "${ALLOW_DIRTY:-0}" != 1 && "${PLATFORM_FROM_HEAD:-0}" != 1 ]]; then
    if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" \
        GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" \
        BOSS_APPROVED_CHANGELOG=0 \
        "${tsx_cmd[@]}" scripts/check-changelog-guard.ts --root "$REPO_ROOT" --base "$base_ref" ); then
      mlog "✗ pinned changelog guard gate 失败 (base=$base_ref)"
      return 1
    fi
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

  tsum_note governanceFastGates "passed:${base_sha:0:12}" 2>/dev/null || :
  mlog "  ✓ Wave 1/2 治理快门全部通过 (base=$base_ref)"
}
