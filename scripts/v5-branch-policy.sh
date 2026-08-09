#!/usr/bin/env bash

# Pure branch policy shared by deploy-v5.sh and its release-safety tests.
# Windows app branches are an installer release lane, never a V5 server deploy lane.
is_v5_windows_app_branch() {
  case "${1:-}" in
    */v5-windows-*) return 0 ;;
    *) return 1 ;;
  esac
}

assert_v5_deploy_branch_allowed() {
  local branch="${1:-?}"
  local allow_any="${2:-0}"

  if is_v5_windows_app_branch "$branch"; then
    echo "✗ Windows 应用分支 '$branch' 只能走 Windows installer release lane，拒绝 deploy-v5.sh。" >&2
    return 1
  fi
  if [[ "$branch" != feat/v5-* && "$allow_any" != "1" ]]; then
    echo "✗ 当前分支 '$branch' 不是 v5 分支(feat/v5-*)。拒绝部署(ALLOW_ANY_BRANCH=1 跳过)。" >&2
    return 1
  fi
}
