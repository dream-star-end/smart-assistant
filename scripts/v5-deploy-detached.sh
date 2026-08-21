#!/usr/bin/env bash
# Keep the local deploy-v5.sh controller alive when the initiating Web/agent
# session ends. This wrapper is not a production-mutation owner; deploy-v5.sh's
# remote flock and fencing metadata remain authoritative.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_PREFIX="openclaude-v5-deploy-"
STABLE_PATH="/root/.bun/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/v5-deploy-detached.sh start -- [deploy-v5.sh args...]
  scripts/v5-deploy-detached.sh status <unit.service>
  scripts/v5-deploy-detached.sh wait <unit.service>

There is intentionally no stop/kill command. Use deploy_state plus the official
deploy-v5.sh --abort/--rollback/--recover path after proving mutation ownership.
EOF
}

die() {
  echo "✗ $*" >&2
  exit 2
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "缺少必需命令:$1"
}

validate_unit() {
  local unit="$1"
  [[ "$unit" =~ ^${UNIT_PREFIX}[a-z0-9-]+\.service$ ]] \
    || die "非法 V5 deploy unit:$unit"
}

require_loaded_unit() {
  local unit="$1" load_state
  load_state="$(systemctl show "$unit" --property=LoadState --value 2>/dev/null)" \
    || die "无法读取 detached deploy unit:$unit"
  [[ "$load_state" == "loaded" ]] \
    || die "找不到 detached deploy unit:$unit (LoadState=${load_state:-unknown})"
}

active_runner_exists() {
  systemctl list-units --type=service \
    --state=activating,active,reloading,deactivating \
    --no-legend --plain "${UNIT_PREFIX}*.service" 2>/dev/null \
    | grep -q '[^[:space:]]'
}

add_optional_env() { # <array-name> <env-key>
  local -n target="$1"
  local key="$2" value
  value="${!key-}"
  if [[ -n "$value" ]]; then
    target+=("--setenv=${key}=${value}")
  fi
}

start_run() {
  [[ "${1-}" == "--" ]] || die "start 后必须用 -- 分隔 deploy-v5.sh 参数"
  shift

  require_tool git
  require_tool systemctl
  require_tool systemd-run

  local branch dirty sha mode stamp unit
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  [[ "$branch" == "feat/v5-aurora-rewrite" ]] \
    || die "只允许从 V5 canonical feat/v5-aurora-rewrite 发起(当前=$branch)"
  dirty="$(git -C "$REPO_ROOT" status --porcelain)"
  [[ -z "$dirty" ]] || die "V5 canonical 非 clean，拒绝 detached deploy"
  active_runner_exists && die "已有 detached V5 deploy unit 正在运行；保持只读并先查 status"

  sha="$(git -C "$REPO_ROOT" rev-parse --short=8 HEAD)"
  mode="${1:---deploy}"
  mode="${mode#--}"
  mode="${mode%%=*}"
  mode="$(printf '%s' "$mode" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
  [[ -n "$mode" ]] || mode="deploy"
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  unit="${UNIT_PREFIX}${stamp}-${sha}-${mode}.service"

  local -a runner=(
    systemd-run
    --quiet
    "--unit=$unit"
    --property=Type=exec
    --property=KillMode=control-group
    --property=RemainAfterExit=yes
    "--property=WorkingDirectory=$REPO_ROOT"
    --setenv=HOME=/root
    --setenv=XDG_CONFIG_HOME=/root/.config
    --setenv=XDG_CACHE_HOME=/root/.cache
    --setenv=GH_CONFIG_DIR=/root/.config/gh
    "--setenv=PATH=$STABLE_PATH"
  )
  add_optional_env runner OC_V5_RELEASE_QUEUE_ID
  add_optional_env runner KL_HOST
  add_optional_env runner ALLOW_ANY_BRANCH
  add_optional_env runner V5_ENV
  add_optional_env runner CADDY_HTTP_PORT
  add_optional_env runner OC_V5_BASELINE_REMOUNT_TIMEOUT_SECONDS

  runner+=(/usr/bin/bash "$SCRIPT_DIR/deploy-v5.sh" "$@")
  "${runner[@]}"

  # stdout is deliberately machine-capturable: UNIT=$(... start -- --canary)
  printf '%s\n' "$unit"
}

show_status() {
  local unit="$1"
  validate_unit "$unit"
  require_tool systemctl
  require_tool journalctl
  require_loaded_unit "$unit"
  systemctl show "$unit" --no-pager \
    --property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus
  journalctl -u "$unit" -n "${OC_V5_DEPLOY_JOURNAL_LINES:-80}" --no-pager
}

wait_run() {
  local unit="$1" state substate status
  validate_unit "$unit"
  require_tool systemctl
  require_loaded_unit "$unit"
  while :; do
    state="$(systemctl show "$unit" --property=ActiveState --value 2>/dev/null)" \
      || die "找不到 detached deploy unit:$unit"
    case "$state" in
      inactive|failed) break ;;
      active)
        substate="$(systemctl show "$unit" --property=SubState --value 2>/dev/null)" \
          || die "无法读取 detached deploy unit 子状态:$unit"
        [[ "$substate" == "exited" ]] && break
        [[ "$substate" == "running" ]] \
          || die "detached deploy unit 子状态非法:$unit state=$state/$substate"
        sleep 2
        ;;
      activating|reloading|deactivating) sleep 2 ;;
      *) die "detached deploy unit 状态非法:$unit state=$state" ;;
    esac
  done
  status="$(systemctl show "$unit" --property=ExecMainStatus --value)"
  [[ "$status" =~ ^[0-9]+$ ]] || die "无法读取 ExecMainStatus:$unit"
  show_status "$unit"
  systemctl stop "$unit" >/dev/null 2>&1 \
    || echo "! 已完成的 detached deploy unit 清理失败:$unit" >&2
  (( status <= 255 )) || status=1
  exit "$status"
}

case "${1-}" in
  start)
    shift
    start_run "$@"
    ;;
  status)
    [[ $# == 2 ]] || { usage; exit 2; }
    show_status "$2"
    ;;
  wait)
    [[ $# == 2 ]] || { usage; exit 2; }
    wait_run "$2"
    ;;
  *)
    usage
    exit 2
    ;;
esac
