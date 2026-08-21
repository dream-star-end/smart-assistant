#!/usr/bin/env bash
# v5-change-route.sh — 把变更集映射到该走的发布 lane。
#
# 输入:git 工作树(默认本仓库)。输出:每条文件的 class + 一条总 lane。
# 识别不出 → unknown,exit 2(fail-closed,人工判断)。
# 不部署、不抢锁、不 SSH。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/v5-hot-config-lib.sh
source "$HERE/v5-hot-config-lib.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/v5-change-route.sh [--repo PATH] [--base SHA]

把当前变更集映射到发布 lane(不部署):
  deploy            完整 deploy-v5.sh
  deploy-with-dist  deploy-v5.sh --with-dist(代码+前端同一 release)
  with-dist         仅前端生效面: --with-dist 或 --dist
  admin-catalog     admin catalog API / --publish-luna / --hide-luna;JSON 另需重建 platform bundle
  live-env          持 production-mutation lease 写 /etc/openclaude/commercial-v5.env
  no-deploy         文档 / V5 不会发布的 changelog
  mixed             多条互不包含的操作面,需拆开做
  unknown           识别不出,人工判断

--hot-config 是安全带:会打印本顾问再拒绝部署。日常请直接跑本脚本。
EOF
}

die() { echo "✗ $*" >&2; exit 2; }

# 单 class → 建议动作(不是总 lane)
action_for_class() {
  case "$1" in
    frontend) printf '%s\n' "with-dist: deploy-v5.sh --with-dist 或 --dist" ;;
    source) printf '%s\n' "deploy: deploy-v5.sh(含前端再加 --with-dist)" ;;
    changelog) printf '%s\n' "no-deploy: V5 不把 changelog.json 拷到 HOME;改 OPENCLAUDE_HOME 或走 V3" ;;
    catalog-bundle) printf '%s\n' "admin-catalog: admin catalog API / --publish-luna / --hide-luna;改 JSON 要重建 platform bundle" ;;
    env-template) printf '%s\n' "live-env: 持 lease 写 /etc/openclaude/commercial-v5.env(remote_env_set)" ;;
    docs) printf '%s\n' "no-deploy: 文档不是部署产物" ;;
    *) printf '%s\n' "unknown: 没有读取点证据,人工判断" ;;
  esac
}

pick_route() {
  local has_unknown=0 has_source=0 has_frontend=0 has_catalog=0 has_env=0
  local has_changelog=0 has_docs=0
  local c
  for c in "$@"; do
    case "$c" in
      unknown) has_unknown=1 ;;
      source) has_source=1 ;;
      frontend) has_frontend=1 ;;
      catalog-bundle) has_catalog=1 ;;
      env-template) has_env=1 ;;
      changelog) has_changelog=1 ;;
      docs) has_docs=1 ;;
    esac
  done
  if [[ "$has_unknown" == 1 ]]; then
    printf '%s\n' unknown
    return 0
  fi
  local ops=0
  [[ "$has_source" == 1 || "$has_frontend" == 1 ]] && ops=$((ops + 1))
  [[ "$has_catalog" == 1 ]] && ops=$((ops + 1))
  [[ "$has_env" == 1 ]] && ops=$((ops + 1))
  if [[ "$ops" -gt 1 ]]; then
    printf '%s\n' mixed
    return 0
  fi
  if [[ "$has_source" == 1 && "$has_frontend" == 1 ]]; then
    printf '%s\n' deploy-with-dist
    return 0
  fi
  if [[ "$has_source" == 1 ]]; then
    printf '%s\n' deploy
    return 0
  fi
  if [[ "$has_frontend" == 1 ]]; then
    printf '%s\n' with-dist
    return 0
  fi
  if [[ "$has_catalog" == 1 ]]; then
    printf '%s\n' admin-catalog
    return 0
  fi
  if [[ "$has_env" == 1 ]]; then
    printf '%s\n' live-env
    return 0
  fi
  if [[ "$has_changelog" == 1 || "$has_docs" == 1 ]]; then
    printf '%s\n' no-deploy
    return 0
  fi
  printf '%s\n' unknown
}

route_how() {
  case "$1" in
    deploy) printf '%s\n' "bash scripts/deploy-v5.sh" ;;
    deploy-with-dist) printf '%s\n' "bash scripts/deploy-v5.sh --with-dist" ;;
    with-dist) printf '%s\n' "bash scripts/deploy-v5.sh --with-dist   # 或 --dist 若只动前端" ;;
    admin-catalog) printf '%s\n' "admin /api/admin/model-catalog 或 deploy-v5.sh --publish-luna / --hide-luna" ;;
    live-env) printf '%s\n' "持 production-mutation lease 写 /etc/openclaude/commercial-v5.env" ;;
    no-deploy) printf '%s\n' "不要走生产写 lane" ;;
    mixed) printf '%s\n' "拆开做:代码/前端走 deploy,catalog 走 admin API,密钥走 live env" ;;
    *) printf '%s\n' "人工判断后再选 lane;不要用 --hot-config 假装发布" ;;
  esac
}

REPO="${OC_V5_HOT_CONFIG_REPO_ROOT:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --base) OC_V5_HOT_CONFIG_BASE_SHA="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    -*) die "未知参数:$1" ;;
    *) die "多余参数:$1" ;;
  esac
done

if [[ -n "$REPO" ]]; then
  export OC_V5_HOT_CONFIG_REPO_ROOT="$REPO"
fi
root="$(hot_config_repo_root)"
[[ -d "$root/.git" || -f "$root/.git" ]] || die "需要 git 工作树:$root"

base="$(hot_config_resolve_base "$root")" || exit 2
changed="$(hot_config_list_changed "$root" "$base" || true)"
if [[ -z "${changed//[$'\n']/}" ]]; then
  echo "✗ 变更集为空(相对 $(git -C "$root" rev-parse --short "$base"))。空 diff 用 --smoke,不要部署。" >&2
  exit 2
fi

echo "══ v5-change-route repo=$root base=$(git -C "$root" rev-parse --short "$base") ══"
echo "FILE                                     CLASS            ACTION"
echo "---------------------------------------- ---------------- ------"

classes=()
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  class="$(hot_config_classify "$f")"
  classes+=("$class")
  printf '%-40s %-16s %s\n' "$f" "$class" "$(action_for_class "$class")"
done <<<"$changed"

route="$(pick_route "${classes[@]}")"
echo ""
echo "route: $route"
echo "how:   $(route_how "$route")"
echo "note:  --hot-config 是安全带(打印本表后拒绝部署)。本脚本只顾问、不写生产。"

if [[ "$route" == unknown || "$route" == mixed ]]; then
  echo "✗ fail-closed:route=$route,需要人工拆分或补读取点证据。" >&2
  exit 2
fi
exit 0
