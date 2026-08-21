#!/usr/bin/env bash
# 开机 oneshot:在 master/egress 之前校验 -live symlink。
# 纯 bash,不依赖 node/npx/tsx/网关。
# live 缺失、悬空、或目标没有合法 .complete → 从 worktree-current 恢复工作树 unit。
# 开机时只装 unit + daemon-reload,不 restart(由 systemd 接着拉起服务)。
set -euo pipefail

BOOT_LIVE="${BOOT_LIVE:-/opt/openclaude/openclaude-v5-selfhost-live}"
BOOT_RELEASES_ROOT="${BOOT_RELEASES_ROOT:-/opt/openclaude/openclaude-v5-selfhost-releases}"
BOOT_RESTORE="${BOOT_RESTORE:-/opt/openclaude/v5-selfhost-breakglass/restore-worktree-units.sh}"
BOOT_BACKUP_CURRENT="${BOOT_BACKUP_CURRENT:-/opt/openclaude/v5-selfhost-breakglass/unit-backups/worktree-current}"
BOOT_LOG="${BOOT_LOG:-/var/log/openclaude-v5-selfhost-boot-guard.log}"
BOOT_SYSTEMD_DIR="${BOOT_SYSTEMD_DIR:-/etc/systemd/system}"
BOOT_DO_RELOAD="${BOOT_DO_RELOAD:-1}"

blog() {
  local msg
  msg="$(date -u +%Y-%m-%dT%H:%M:%SZ) boot-guard: $*"
  mkdir -p "$(dirname -- "$BOOT_LOG")" 2>/dev/null || true
  echo "$msg" | tee -a "$BOOT_LOG" >/dev/null
  echo "$msg"
}

live_target_ok() {
  local target marker schema commit
  [[ -L "$BOOT_LIVE" ]] || return 1
  target="$(readlink -f -- "$BOOT_LIVE" 2>/dev/null || true)"
  [[ -n "$target" && -d "$target" && ! -L "$target" ]] || return 1
  case "$target" in
    "${BOOT_RELEASES_ROOT}"/rel-*) ;;
    *)
      blog "live 目标不在 releases 根下: $target"
      return 1
      ;;
  esac
  [[ "$target" != *.poisoned ]] || return 1
  marker="$target/.complete"
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  if command -v jq >/dev/null 2>&1; then
    schema="$(jq -er '.schemaVersion' "$marker" 2>/dev/null || true)"
    commit="$(jq -er '.sourceCommit' "$marker" 2>/dev/null || true)"
    [[ "$schema" == 2 ]] || return 1
    [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  fi
  printf '%s\n' "$target"
}

restore_worktree_units() {
  local extra=()
  [[ -x "$BOOT_RESTORE" ]] || {
    blog "缺恢复脚本 $BOOT_RESTORE"
    return 1
  }
  extra+=(--backup-dir "$BOOT_BACKUP_CURRENT" --systemd-dir "$BOOT_SYSTEMD_DIR" --no-restart --no-healthz)
  if [[ "$BOOT_DO_RELOAD" != 1 ]]; then
    extra+=(--no-reload)
  fi
  blog "恢复工作树 unit ← $BOOT_BACKUP_CURRENT systemd=$BOOT_SYSTEMD_DIR"
  bash "$BOOT_RESTORE" "${extra[@]}"
}

boot_once() {
  local target
  if target="$(live_target_ok)"; then
    blog "live ok → $target"
    return 0
  fi
  blog "live 缺失/悬空/无合法 .complete,准备恢复工作树 unit"
  restore_worktree_units
}

boot_selftest() {
  local base systemd_dir backup live releases restore_stub
  base="$(mktemp -d /tmp/v5-selfhost-boot-guard-selftest.XXXXXX)"
  echo "BOOT_SELFTEST_DIR=$base"
  systemd_dir="$base/systemd"
  backup="$base/backup"
  live="$base/live"
  releases="$base/releases"
  restore_stub="$base/restore-stub.sh"
  mkdir -p -- "$systemd_dir" "$backup" "$releases/rel-good-20260818-000000"
  cat >"$backup/openclaude-v5-selfhost.service" <<'EOF'
[Service]
WorkingDirectory=/opt/openclaude/openclaude-v5-selfhost
ExecStart=/bin/true
EOF
  cat >"$backup/openclaude-v5-selfhost-egress.service" <<'EOF'
[Service]
WorkingDirectory=/opt/openclaude/openclaude-v5-selfhost
ExecStart=/bin/true
EOF
  printf '{"schemaVersion":2,"sourceCommit":"%s","builtAt":"20260818-000000","metadataSha256":"%s","artifactSha256":"%s"}\n' \
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" \
    >"$releases/rel-good-20260818-000000/.complete"

  cat >"$restore_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "RESTORE_STUB $*"
printf 'restored\n' >>"${BOOT_SELFTEST_MARK}"
EOF
  chmod 0755 "$restore_stub"

  export BOOT_LIVE="$live"
  export BOOT_RELEASES_ROOT="$releases"
  export BOOT_RESTORE="$restore_stub"
  export BOOT_BACKUP_CURRENT="$backup"
  export BOOT_LOG="$base/boot.log"
  export BOOT_SYSTEMD_DIR="$systemd_dir"
  export BOOT_DO_RELOAD=0
  export BOOT_SELFTEST_MARK="$base/restored"

  echo "===== boot-guard 场景1: live 完好 → 不恢复 ====="
  ln -sfn -- "$releases/rel-good-20260818-000000" "$live"
  rm -f -- "$BOOT_SELFTEST_MARK"
  boot_once
  if [[ -f "$BOOT_SELFTEST_MARK" ]]; then
    echo "FAIL 场景1 误恢复"
    return 1
  fi
  echo "PASS 场景1: live ok 不动作"

  echo "===== boot-guard 场景2: live 缺失 → 恢复 ====="
  rm -f -- "$live"
  rm -f -- "$BOOT_SELFTEST_MARK"
  boot_once
  [[ -f "$BOOT_SELFTEST_MARK" ]] || { echo "FAIL 场景2 未恢复"; return 1; }
  echo "PASS 场景2: live 缺失 → 恢复"

  echo "===== boot-guard 场景3: live 悬空 → 恢复 ====="
  ln -sfn -- "$releases/rel-missing-nope" "$live"
  rm -f -- "$BOOT_SELFTEST_MARK"
  boot_once
  [[ -f "$BOOT_SELFTEST_MARK" ]] || { echo "FAIL 场景3 未恢复"; return 1; }
  echo "PASS 场景3: 悬空 live → 恢复"

  echo "===== boot-guard 场景4: 目标无 .complete → 恢复 ====="
  mkdir -p -- "$releases/rel-nocomplete-20260818-000000"
  ln -sfn -- "$releases/rel-nocomplete-20260818-000000" "$live"
  rm -f -- "$BOOT_SELFTEST_MARK"
  boot_once
  [[ -f "$BOOT_SELFTEST_MARK" ]] || { echo "FAIL 场景4 未恢复"; return 1; }
  echo "PASS 场景4: 无 .complete → 恢复"

  echo "===== boot-guard 场景5: .poisoned 目标 → 恢复 ====="
  mkdir -p -- "$releases/rel-bad-20260818-000000.poisoned"
  printf '{"schemaVersion":2,"sourceCommit":"%s","builtAt":"20260818-000000","metadataSha256":"%s","artifactSha256":"%s"}\n' \
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" \
    >"$releases/rel-bad-20260818-000000.poisoned/.complete"
  ln -sfn -- "$releases/rel-bad-20260818-000000.poisoned" "$live"
  rm -f -- "$BOOT_SELFTEST_MARK"
  boot_once
  [[ -f "$BOOT_SELFTEST_MARK" ]] || { echo "FAIL 场景5 未恢复"; return 1; }
  echo "PASS 场景5: poisoned 目标 → 恢复"

  echo "BOOT_SELFTEST_ALL_PASS"
  echo "log=$BOOT_LOG"
}

usage() {
  cat <<'EOF'
用法: v5-selfhost-boot-guard.sh [--selftest]
  默认: 校验 -live,不满足则恢复工作树 unit(--no-restart/--no-healthz)。
  --selftest: 假目录,不碰真 unit / 真 symlink。
EOF
}

main() {
  case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    --selftest) boot_selftest ;;
    "") boot_once ;;
    *)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "${1:-}"
fi
