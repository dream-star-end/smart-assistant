#!/usr/bin/env bash
# 应急恢复:把 v5-selfhost master+egress 的 systemd unit 恢复成「工作树 WD」备份,
# daemon-reload,按现网顺序重启(先 egress 再 master),并打印 healthz。
#
# 用途:首次切 live 失败、看护二级兜底、或任何「live symlink/新 unit 把网关打挂、
# 容器内 AI 也救不了」的场合。本脚本不依赖 git 工作树、不依赖 node/npx/tsx、
# 不依赖网关还活着。root 可重复跑(幂等)。
#
# 备份不存在时明确失败,绝不静默装一份错的 unit。
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/openclaude/v5-selfhost-breakglass/unit-backups/worktree-current}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
MASTER_UNIT="openclaude-v5-selfhost.service"
EGRESS_UNIT="openclaude-v5-selfhost-egress.service"
MASTER_PORT="${MASTER_PORT:-18790}"
EGRESS_BIND="${EGRESS_BIND:-172.31.0.1}"
EGRESS_PORT="${EGRESS_PORT:-18892}"
DO_RELOAD=1
DO_RESTART=1
DO_HEALTHZ=1

die() {
  echo "✗ $*" >&2
  exit 1
}

log() { echo "$*"; }

usage() {
  cat <<'EOF'
用法: restore-worktree-units.sh [--backup-dir DIR] [--systemd-dir DIR]
                                [--no-reload] [--no-restart] [--no-healthz]

  默认备份: /opt/openclaude/v5-selfhost-breakglass/unit-backups/worktree-current
  默认安装到: /etc/systemd/system (只覆盖 master 与 egress 两个 unit 名)

  --no-reload / --no-restart / --no-healthz  给演练/假目录用,不碰真服务。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir)
      [[ $# -ge 2 ]] || die "缺 --backup-dir 参数"
      BACKUP_DIR="$2"
      shift 2
      ;;
    --systemd-dir)
      [[ $# -ge 2 ]] || die "缺 --systemd-dir 参数"
      SYSTEMD_DIR="$2"
      shift 2
      ;;
    --no-reload) DO_RELOAD=0; shift ;;
    --no-restart) DO_RESTART=0; shift ;;
    --no-healthz) DO_HEALTHZ=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ "$BACKUP_DIR" == /* ]] || die "备份目录必须是绝对路径: $BACKUP_DIR"
[[ "$SYSTEMD_DIR" == /* ]] || die "systemd 目录必须是绝对路径: $SYSTEMD_DIR"
[[ -L "$BACKUP_DIR" || -d "$BACKUP_DIR" ]] || die "备份目录不存在: $BACKUP_DIR
补救: 确认 /opt/openclaude/v5-selfhost-breakglass/unit-backups/ 下有 worktree-* 副本。"

# 解析 symlink(worktree-current → 带时间戳的目录)
if [[ -L "$BACKUP_DIR" ]]; then
  BACKUP_REAL="$(readlink -f -- "$BACKUP_DIR" || true)"
  [[ -n "$BACKUP_REAL" && -d "$BACKUP_REAL" ]] || die "备份 symlink 悬空: $BACKUP_DIR"
else
  BACKUP_REAL="$BACKUP_DIR"
fi

MASTER_SRC="$BACKUP_REAL/$MASTER_UNIT"
EGRESS_SRC="$BACKUP_REAL/$EGRESS_UNIT"
[[ -f "$MASTER_SRC" && ! -L "$MASTER_SRC" ]] || die "备份缺普通文件 $MASTER_SRC"
[[ -f "$EGRESS_SRC" && ! -L "$EGRESS_SRC" ]] || die "备份缺普通文件 $EGRESS_SRC"

# 拒绝把 live WD 的 unit 当「工作树恢复」装回去。
assert_worktree_wd() {
  local f="$1" wd
  wd="$(awk -F= '/^WorkingDirectory=/{print $2; exit}' "$f")"
  [[ -n "$wd" ]] || die "$f 没有 WorkingDirectory"
  case "$wd" in
    *-live)
      die "$f WorkingDirectory=$wd 以 -live 结尾,这不是工作树备份。拒绝装回去。"
      ;;
    /opt/openclaude/openclaude-v5-selfhost)
      return 0
      ;;
    *)
      die "$f WorkingDirectory=$wd 不是预期的工作树路径。"
      ;;
  esac
}

assert_worktree_wd "$MASTER_SRC"
assert_worktree_wd "$EGRESS_SRC"

mkdir -p -- "$SYSTEMD_DIR"
install -m 0644 "$MASTER_SRC" "$SYSTEMD_DIR/$MASTER_UNIT"
install -m 0644 "$EGRESS_SRC" "$SYSTEMD_DIR/$EGRESS_UNIT"
log "✓ 已从 $BACKUP_REAL 安装 $MASTER_UNIT 与 $EGRESS_UNIT → $SYSTEMD_DIR"

if [[ "$DO_RELOAD" == 1 ]]; then
  systemctl daemon-reload
  log "✓ daemon-reload"
else
  log "· 跳过 daemon-reload (--no-reload)"
fi

if [[ "$DO_RESTART" == 1 ]]; then
  # 严禁通配 openclaude*。只点名这两个 unit,不碰个人版 18789。
  systemctl restart "$EGRESS_UNIT"
  log "✓ restart $EGRESS_UNIT"
  if timeout 90 bash -c "until (exec 3<>/dev/tcp/${EGRESS_BIND}/${EGRESS_PORT}) 2>/dev/null; do sleep 1; done"; then
    log "✓ egress ${EGRESS_BIND}:${EGRESS_PORT} 可连"
  else
    log "⚠ egress 端口 90s 内未就绪,仍继续 restart master"
  fi
  systemctl restart "$MASTER_UNIT"
  log "✓ restart $MASTER_UNIT"
else
  log "· 跳过 restart (--no-restart)"
fi

if [[ "$DO_HEALTHZ" == 1 ]]; then
  sleep 2
  log "── healthz ──"
  curl -sS --max-time 5 "http://127.0.0.1:${MASTER_PORT}/healthz" \
    | jq -c '{ok,runtime:(.runtime|{controlPlaneEnabled,leadership})}' \
    || log "⚠ 读 healthz 失败(网关可能仍在起;unit 已恢复工作树 WD)"
else
  log "· 跳过 healthz (--no-healthz)"
fi

log "✓ restore-worktree-units 完成 backup=$BACKUP_REAL"
