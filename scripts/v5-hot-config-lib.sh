#!/usr/bin/env bash
# v5-hot-config-lib.sh — --hot-config 变更集白名单守卫。
#
# 只允许「不产生代码 dist 变化」的路径进入热配置 lane。TS/JS 源码、schema、
# 迁移、lockfile、构建配置一律拒绝。绕过必须 --hot-config-force + 非空理由，
# 并写 durable 审计日志；没有理由的 force 直接失败。
#
# 可被 deploy-v5.sh source，也可独立执行:
#   bash scripts/v5-hot-config-lib.sh --check
#   bash scripts/v5-hot-config-lib.sh --list-changed
set -euo pipefail

HOT_CONFIG_CANONICAL_REF="${OC_V5_HOT_CONFIG_BASE:-origin/feat/v5-aurora-rewrite}"
HOT_CONFIG_AUDIT_LOG="${OC_V5_HOT_CONFIG_AUDIT_LOG:-/var/log/openclaude-v5/hot-config-force.log}"

hot_config_is_denied() {
  local f="$1"
  [[ "$f" == package.json || "$f" == package-lock.json || "$f" == bun.lock \
    || "$f" == bun.lockb || "$f" == pnpm-lock.yaml || "$f" == yarn.lock ]] && return 0
  [[ "$f" == tsconfig.json || "$f" == tsconfig.base.json || "$f" == biome.json \
    || "$f" == bunfig.toml ]] && return 0
  [[ "$f" == .github || "$f" == .github/* ]] && return 0
  [[ "$f" == */migrations/* || "$f" == *.sql ]] && return 0
  [[ "$f" == *.ts || "$f" == *.tsx || "$f" == *.js || "$f" == *.jsx \
    || "$f" == *.mjs || "$f" == *.cjs || "$f" == *.mts || "$f" == *.cts ]] && return 0
  [[ "$f" == scripts/select-gates.ts || "$f" == scripts/check-*.ts ]] && return 0
  return 1
}

hot_config_is_allowed() {
  local f="$1"
  [[ "$f" == deploy/v5/commercial-v5.env.overrides || "$f" == deploy/v5/*.env \
    || "$f" == deploy/v5/*.env.* ]] && return 0
  [[ "$f" == changelog.json ]] && return 0
  [[ "$f" == *model-catalog*.json || "$f" == *modelCatalog*.json ]] && return 0
  [[ "$f" == */locales/* || "$f" == */i18n/* || "$f" == */locale/* ]] && return 0
  if [[ "$f" == packages/web-react/public/* ]] \
    && [[ "$f" == *.svg || "$f" == *.png || "$f" == *.jpg || "$f" == *.jpeg \
      || "$f" == *.webp || "$f" == *.ico || "$f" == *.gif || "$f" == *.json ]]; then
    return 0
  fi
  [[ "$f" == docs/*.md || "$f" == docs/*/*.md || "$f" == deploy/v5/*.md || "$f" == *.md ]] && return 0
  return 1
}

hot_config_repo_root() {
  local root="${OC_V5_HOT_CONFIG_REPO_ROOT:-${REPO_ROOT:-}}"
  if [[ -z "$root" ]]; then
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    root="$(cd "$here/.." && pwd)"
  fi
  printf '%s\n' "$root"
}

hot_config_resolve_base() {
  local root="$1" ref sha
  if [[ -n "${OC_V5_HOT_CONFIG_BASE_SHA:-}" ]]; then
    sha="$(git -C "$root" rev-parse --verify "${OC_V5_HOT_CONFIG_BASE_SHA}^{commit}" 2>/dev/null || true)"
    [[ -n "$sha" ]] && { printf '%s\n' "$sha"; return 0; }
    echo "✗ --hot-config 基线不可解析:$OC_V5_HOT_CONFIG_BASE_SHA" >&2
    return 2
  fi
  for ref in "$HOT_CONFIG_CANONICAL_REF" origin/feat/v5-aurora-rewrite feat/v5-aurora-rewrite; do
    if git -C "$root" rev-parse --verify "$ref^{commit}" >/dev/null 2>&1; then
      git -C "$root" merge-base HEAD "$ref" 2>/dev/null && return 0
    fi
  done
  git -C "$root" rev-parse HEAD
}

# stdout: 变更路径,一行一个。
# 1) 相对 merge-base(canonical)...HEAD 的已提交 diff
# 2) 暂存 / 未暂存
# 3) 若 1+2 为空且 HEAD==base(刚合入 canonical 的典型形态),再看 tip 相对第一父
hot_config_list_changed() {
  local root="$1" base="$2" head listed
  head="$(git -C "$root" rev-parse HEAD)"
  listed="$(
    {
      if [[ "$base" != "$head" ]]; then
        git -C "$root" diff --name-only "$base"...HEAD
      fi
      git -C "$root" diff --name-only
      git -C "$root" diff --cached --name-only
    } | awk 'NF && !seen[$0]++'
  )"
  if [[ -z "${listed//[$'\n']/}" ]] && git -C "$root" rev-parse --verify 'HEAD^' >/dev/null 2>&1; then
    listed="$(git -C "$root" diff --name-only HEAD^ HEAD | awk 'NF && !seen[$0]++')"
  fi
  printf '%s\n' "$listed"
}

hot_config_audit_force() {
  local reason="$1" root="$2" denied_csv="$3"
  local ts actor line
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  actor="${USER:-unknown}"
  line="$ts actor=$actor tree=$root reason=$(printf '%s' "$reason" | tr '\n' ' ') denied=$denied_csv"
  mkdir -p "$(dirname "$HOT_CONFIG_AUDIT_LOG")" 2>/dev/null || true
  if ! printf '%s\n' "$line" >>"$HOT_CONFIG_AUDIT_LOG" 2>/dev/null; then
    local fallback="$root/.hot-config-force.audit.log"
    printf '%s\n' "$line" >>"$fallback"
    echo "  · hot-config force 审计写入 $fallback(默认 $HOT_CONFIG_AUDIT_LOG 不可写)"
  else
    echo "  · hot-config force 审计写入 $HOT_CONFIG_AUDIT_LOG"
  fi
  echo "  · AUDIT hot-config-force $line"
}

assert_hot_config_changeset() {
  local root base changed denied allowed unknown f
  root="$(hot_config_repo_root)"
  [[ -d "$root/.git" || -f "$root/.git" ]] || {
    echo "✗ --hot-config 需要 git 工作树:$root" >&2
    return 2
  }
  base="$(hot_config_resolve_base "$root")" || return 2
  changed="$(hot_config_list_changed "$root" "$base" || true)"
  if [[ -z "${changed//[$'\n']/}" ]]; then
    echo "✗ --hot-config 变更集为空(相对 $(git -C "$root" rev-parse --short "$base"))。空 diff 请用 --smoke,不要走写 lane。" >&2
    echo "  若刚合入 canonical 仍要按 tip commit 校验,设 OC_V5_HOT_CONFIG_BASE_SHA=<parent>。" >&2
    return 2
  fi

  denied=""; allowed=""; unknown=""
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if hot_config_is_denied "$f"; then
      denied+="$f"$'\n'
    elif hot_config_is_allowed "$f"; then
      allowed+="$f"$'\n'
    else
      unknown+="$f"$'\n'
    fi
  done <<<"$changed"

  echo "── hot-config 变更集(base=$(git -C "$root" rev-parse --short "$base"))──"
  if [[ -n "$allowed" ]]; then
    echo "  白名单:"
    printf '%s' "$allowed" | sed 's/^/    + /'
  fi
  if [[ -n "$denied$unknown" ]]; then
    echo "  拒绝:"
    printf '%s' "$denied$unknown" | sed 's/^/    ✗ /'
    echo "✗ --hot-config 拒绝:变更集含源码/schema/迁移/未知路径。请改用完整 deploy(--with-dist 如含前端)。" >&2
    echo "  不允许用开关静默绕过。若紧急放行:同时给 --hot-config-force 且导出 OC_V5_HOT_CONFIG_FORCE_REASON(≥8 字符)。" >&2
    if [[ "${HOT_CONFIG_FORCE:-0}" == 1 ]]; then
      local reason="${OC_V5_HOT_CONFIG_FORCE_REASON:-}"
      if [[ ${#reason} -lt 8 ]]; then
        echo "✗ --hot-config-force 缺少 OC_V5_HOT_CONFIG_FORCE_REASON(至少 8 个字符的审计理由)" >&2
        return 2
      fi
      local csv
      csv="$(printf '%s' "$denied$unknown" | awk 'NF' | paste -sd, -)"
      hot_config_audit_force "$reason" "$root" "$csv"
      echo "⚠ hot-config force 已放行并记账。发布内容仍不重建 dist;前端/协议变更不会生效。"
      return 0
    fi
    return 2
  fi
  echo "  ✓ 变更集全部落在 hot-config 白名单"
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    --check) assert_hot_config_changeset ;;
    --list-changed)
      root="$(hot_config_repo_root)"
      base="$(hot_config_resolve_base "$root")"
      hot_config_list_changed "$root" "$base"
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  v5-hot-config-lib.sh --check
  v5-hot-config-lib.sh --list-changed
EOF
      ;;
    *)
      echo "Usage: v5-hot-config-lib.sh --check | --list-changed" >&2
      exit 2
      ;;
  esac
fi
