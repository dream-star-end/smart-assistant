#!/usr/bin/env bash
# v5-hot-config-lib.sh — --hot-config 变更集白名单守卫。
#
# 只放行「确定会在运行时从本次 release 树读到、且不经过 dist/bundle」的路径。
# 2026-08-16 收敛：原先允许的 public/locales/changelog/catalog-json/env.overrides/md
# 经核对都不是这条语义（见报告「白名单收敛依据」）。当前 allow 集为空；
# --hot-config 的价值是拒绝静默空发布，不是放宽边界。
#
# 绕过必须 --hot-config-force + OC_V5_HOT_CONFIG_FORCE_REASON(≥8)，写审计日志。
set -euo pipefail

HOT_CONFIG_CANONICAL_REF="${OC_V5_HOT_CONFIG_BASE:-origin/feat/v5-aurora-rewrite}"
HOT_CONFIG_AUDIT_LOG="${OC_V5_HOT_CONFIG_AUDIT_LOG:-/var/log/openclaude-v5/hot-config-force.log}"

# 分类(deny 优先)。stdout=class: frontend|source|changelog|catalog-bundle|env-template|docs|unknown
hot_config_classify() {
  local f="$1"
  if [[ "$f" == packages/web-react || "$f" == packages/web-react/* ]]; then
    printf '%s\n' frontend
    return 0
  fi
  if [[ "$f" == */locales/* || "$f" == */i18n/* || "$f" == */locale/* \
    || "$f" == locales/* || "$f" == i18n/* || "$f" == locale/* ]]; then
    printf '%s\n' frontend
    return 0
  fi
  if [[ "$f" == package.json || "$f" == package-lock.json || "$f" == bun.lock \
    || "$f" == bun.lockb || "$f" == pnpm-lock.yaml || "$f" == yarn.lock \
    || "$f" == tsconfig.json || "$f" == tsconfig.base.json || "$f" == biome.json \
    || "$f" == bunfig.toml || "$f" == .github || "$f" == .github/* \
    || "$f" == */migrations/* || "$f" == *.sql \
    || "$f" == *.ts || "$f" == *.tsx || "$f" == *.js || "$f" == *.jsx \
    || "$f" == *.mjs || "$f" == *.cjs || "$f" == *.mts || "$f" == *.cts \
    || "$f" == scripts/select-gates.ts || "$f" == scripts/check-*.ts ]]; then
    printf '%s\n' source
    return 0
  fi
  if [[ "$f" == changelog.json ]]; then
    printf '%s\n' changelog
    return 0
  fi
  if [[ "$f" == *model-catalog*.json || "$f" == *modelCatalog*.json ]]; then
    printf '%s\n' catalog-bundle
    return 0
  fi
  if [[ "$f" == deploy/v5/commercial-v5.env.overrides \
    || "$f" == deploy/v5/*.env || "$f" == deploy/v5/*.env.* \
    || "$f" == *.env || "$f" == *.env.overrides ]]; then
    printf '%s\n' env-template
    return 0
  fi
  if [[ "$f" == *.md || "$f" == docs || "$f" == docs/* ]]; then
    printf '%s\n' docs
    return 0
  fi
  printf '%s\n' unknown
}

hot_config_is_denied() {
  local class
  class="$(hot_config_classify "$1")"
  [[ "$class" != allowed ]]
}

# 当前没有任何已证明「运行时读 release 树、且不经 dist/bundle」的路径。
# 要新增必须先在报告里写读取点证据，禁止凭感觉放行。
hot_config_is_allowed() {
  return 1
}

hot_config_reason_for_class() {
  case "$1" in
    frontend)
      printf '%s\n' "前端生效面(vite dist / Caddy 直服)。--hot-config 不重建 dist、继承上一版。请改用 --with-dist（或 --dist）。"
      ;;
    source)
      printf '%s\n' "源码/schema/迁移/lockfile。请改用完整 deploy；含前端时加 --with-dist。"
      ;;
    changelog)
      printf '%s\n' "changelog.json 由网关从 OPENCLAUDE_HOME 读盘(/api/changelog)，V5 deploy-v5.sh 不会把它 rsync 到 HOME（那是 V3 路径）。改仓库内该文件走 --hot-config 是静默空发布。"
      ;;
    catalog-bundle)
      printf '%s\n' "model-catalog JSON 是 platform bundle 叶子，运行时读 /run/oc/platform/current/etc-codex/…，不是 master release 树。上下线走 admin catalog/DB；改这份 JSON 要重建 platform bundle，不是 --hot-config。"
      ;;
    env-template)
      printf '%s\n' "commercial-v5.env.overrides 只在 bootstrap 且 live env 不存在时派生 /etc/openclaude/commercial-v5.env；增量部署明确不重生成。现网权威是 EnvironmentFile=该 live env。改密钥请持 lease 写 live env / remote_env_set。"
      ;;
    docs)
      printf '%s\n' "文档不参与部署产物，单独改 md 不要走生产写 lane。"
      ;;
    *)
      printf '%s\n' "未列入已证明的运行时配置面。--hot-config 只接受确定安全的那一小类（当前为空）。"
      ;;
  esac
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
  local root base changed denied allowed unknown f class
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
  local -A seen_class=()
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if hot_config_is_allowed "$f"; then
      allowed+="$f"$'\n'
      continue
    fi
    class="$(hot_config_classify "$f")"
    seen_class["$class"]=1
    denied+="$f"$'\t'"$class"$'\n'
  done <<<"$changed"

  echo "── hot-config 变更集(base=$(git -C "$root" rev-parse --short "$base"))──"
  if [[ -n "$allowed" ]]; then
    echo "  白名单:"
    printf '%s' "$allowed" | sed 's/^/    + /'
  fi
  if [[ -n "$denied" ]]; then
    echo "  拒绝:"
    while IFS=$'\t' read -r f class; do
      [[ -z "$f" ]] && continue
      echo "    ✗ $f  [$class]"
    done <<<"$denied"
    echo "✗ --hot-config 拒绝:变更集不是已证明的运行时热配置面。放行会造成绿灯空发布。" >&2
    for class in frontend source changelog catalog-bundle env-template docs unknown; do
      [[ -n "${seen_class[$class]:-}" ]] || continue
      echo "  · $class: $(hot_config_reason_for_class "$class")" >&2
    done
    echo "  不允许用开关静默绕过。若紧急放行:同时给 --hot-config-force 且导出 OC_V5_HOT_CONFIG_FORCE_REASON(≥8 字符)。" >&2
    if [[ "${HOT_CONFIG_FORCE:-0}" == 1 ]]; then
      local reason="${OC_V5_HOT_CONFIG_FORCE_REASON:-}"
      if [[ ${#reason} -lt 8 ]]; then
        echo "✗ --hot-config-force 缺少 OC_V5_HOT_CONFIG_FORCE_REASON(至少 8 个字符的审计理由)" >&2
        return 2
      fi
      local csv
      csv="$(printf '%s' "$denied" | awk -F'\t' 'NF{print $1}' | paste -sd, -)"
      hot_config_audit_force "$reason" "$root" "$csv"
      echo "⚠ hot-config force 已放行并记账。发布内容仍不重建 dist;前端/bundle/live-env 变更不会生效。"
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
