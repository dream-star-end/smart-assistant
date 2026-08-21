#!/usr/bin/env bash
# 应急恢复:把 v5-selfhost master+egress 的 systemd unit 恢复成「工作树 WD」备份,
# daemon-reload,按现网顺序重启(先 egress 再 master),并校验复合健康。
#
# 用途:首次切 live 失败、看护二级兜底、或任何「live symlink/新 unit 把网关打挂、
# 容器内 AI 也救不了」的场合。本脚本不依赖 git 工作树、不依赖 node/npx/tsx、
# 不依赖网关还活着。root 可重复跑(幂等)。
#
# 备份不存在时明确失败,绝不静默装一份错的 unit。
# 写 unit:同文件系统临时文件 → 校验 → fsync → rename。准备失败不碰现有 unit。
# 最终成功必须: master active + healthz ok+controlPlane+leader,
#              egress active + egress-health ok。
# 达不到则非 0 退出,打印「unit 已恢复但健康未确认」,禁止打印总成功。
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/openclaude/v5-selfhost-breakglass/unit-backups/worktree-current}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
MASTER_UNIT="openclaude-v5-selfhost.service"
EGRESS_UNIT="openclaude-v5-selfhost-egress.service"
MASTER_PORT="${MASTER_PORT:-18790}"
EGRESS_BIND="${EGRESS_BIND:-172.31.0.1}"
EGRESS_PORT="${EGRESS_PORT:-18892}"
MASTER_HEALTH_URL="${MASTER_HEALTH_URL:-http://127.0.0.1:${MASTER_PORT}/healthz}"
EGRESS_HEALTH_URL="${EGRESS_HEALTH_URL:-http://${EGRESS_BIND}:${EGRESS_PORT}/internal/v5/egress-health}"
DO_RELOAD=1
DO_RESTART=1
DO_HEALTHZ=1
UNITS_RESTORED=0

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
  默认路径的最终成功仍要求复合健康全绿;达不到则非 0,不打印总成功。

  恢复完成后请人工收尾看护状态(本脚本不自动清):
    rm -f /run/openclaude-v5-selfhost/cutover-grace-until \
          /run/openclaude-v5-selfhost/health-fail-count \
          /opt/openclaude/openclaude-v5-selfhost-releases/.manual-recovery-required \
          /opt/openclaude/v5-selfhost-watch/watch-disarmed
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

TXN="$SYSTEMD_DIR/.openclaude-v5-selfhost-restore.txn"
MASTER_TMP=""
EGRESS_TMP=""

restore_fsync() {
  python3 - "$1" <<'PY'
import os, sys
p = sys.argv[1]
fd = os.open(p, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

write_txn() {
  local phase="$1"
  printf 'phase=%s\nmaster_tmp=%s\negress_tmp=%s\nwritten=%s\n' \
    "$phase" "${MASTER_TMP:-}" "${EGRESS_TMP:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"$TXN"
  restore_fsync "$TXN" || true
}

# 把 src 写到同文件系统临时文件并 fsync。失败则删临时文件,不碰 dest。
prepare_unit_tmp() { # <src> <dest> → stdout tmp
  local src="$1" dest="$2" tmp
  tmp="${dest}.v5restore-tmp.$$"
  rm -f -- "$tmp"
  if ! python3 - "$src" "$tmp" <<'PY'; then
import os, sys
src, dst = sys.argv[1], sys.argv[2]
try:
    with open(src, "rb") as fh:
        data = fh.read()
    if not data:
        raise SystemExit("empty source unit")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    fd = os.open(dst, flags, 0o644)
    try:
        written = 0
        while written < len(data):
            n = os.write(fd, data[written:])
            if n <= 0:
                raise OSError("short write")
            written += n
        os.fsync(fd)
    finally:
        os.close(fd)
except Exception:
    try:
        os.unlink(dst)
    except OSError:
        pass
    raise
PY
    rm -f -- "$tmp"
    return 1
  fi
  [[ -f "$tmp" && ! -L "$tmp" ]] || { rm -f -- "$tmp"; return 1; }
  [[ "$(stat -c '%s' -- "$tmp")" -gt 0 ]] || { rm -f -- "$tmp"; return 1; }
  grep -q '^WorkingDirectory=' "$tmp" || { rm -f -- "$tmp"; return 1; }
  grep -q '^ExecStart=' "$tmp" || { rm -f -- "$tmp"; return 1; }
  printf '%s\n' "$tmp"
}

abort_prepare() {
  rm -f -- "${MASTER_TMP:-}" "${EGRESS_TMP:-}"
  rm -f -- "$TXN"
}

# 中途被 kill 后重跑:prepared/committing 则完成 rename;preparing 则丢弃临时文件。
complete_or_abort_txn() {
  local phase mt et
  [[ -f "$TXN" ]] || return 0
  phase="$(awk -F= '/^phase=/{print $2; exit}' "$TXN" || true)"
  mt="$(awk -F= '/^master_tmp=/{print $2; exit}' "$TXN" || true)"
  et="$(awk -F= '/^egress_tmp=/{print $2; exit}' "$TXN" || true)"
  case "$phase" in
    prepared|committing)
      if [[ -n "$mt" && -f "$mt" ]]; then
        mv -f -- "$mt" "$SYSTEMD_DIR/$MASTER_UNIT" || return 1
      fi
      if [[ -n "$et" && -f "$et" ]]; then
        mv -f -- "$et" "$SYSTEMD_DIR/$EGRESS_UNIT" || return 1
      fi
      restore_fsync "$SYSTEMD_DIR" || true
      rm -f -- "$TXN"
      UNITS_RESTORED=1
      ;;
    *)
      rm -f -- "${mt:-}" "${et:-}"
      rm -f -- "$TXN"
      ;;
  esac
}

mkdir -p -- "$SYSTEMD_DIR"
complete_or_abort_txn

if [[ "$UNITS_RESTORED" != 1 ]]; then
  write_txn preparing
  MASTER_TMP="$(prepare_unit_tmp "$MASTER_SRC" "$SYSTEMD_DIR/$MASTER_UNIT")" \
    || { abort_prepare; die "准备 master unit 临时文件失败。现有 unit 未改动。"; }
  EGRESS_TMP="$(prepare_unit_tmp "$EGRESS_SRC" "$SYSTEMD_DIR/$EGRESS_UNIT")" \
    || { abort_prepare; die "准备 egress unit 临时文件失败。现有 unit 未改动。"; }
  assert_worktree_wd "$MASTER_TMP"
  assert_worktree_wd "$EGRESS_TMP"
  write_txn prepared
  write_txn committing
  mv -f -- "$MASTER_TMP" "$SYSTEMD_DIR/$MASTER_UNIT" \
    || { die "rename master unit 失败。查 $TXN 后重跑本脚本。"; }
  MASTER_TMP=""
  mv -f -- "$EGRESS_TMP" "$SYSTEMD_DIR/$EGRESS_UNIT" \
    || { die "rename egress unit 失败。查 $TXN 后重跑本脚本。"; }
  EGRESS_TMP=""
  restore_fsync "$SYSTEMD_DIR" || true
  rm -f -- "$TXN"
  UNITS_RESTORED=1
fi
log "✓ 已从 $BACKUP_REAL 安装 $MASTER_UNIT 与 $EGRESS_UNIT → $SYSTEMD_DIR"

if [[ "$DO_RELOAD" == 1 ]]; then
  systemctl daemon-reload
  log "✓ daemon-reload"
else
  log "· 跳过 daemon-reload (--no-reload)"
fi

RESTART_OK=1
if [[ "$DO_RESTART" == 1 ]]; then
  # 严禁通配 openclaude*。只点名这两个 unit,不碰个人版 18789。
  if systemctl restart "$EGRESS_UNIT"; then
    log "✓ restart $EGRESS_UNIT"
  else
    log "✗ restart $EGRESS_UNIT 失败"
    RESTART_OK=0
  fi
  if timeout 90 bash -c "until (exec 3<>/dev/tcp/${EGRESS_BIND}/${EGRESS_PORT}) 2>/dev/null; do sleep 1; done"; then
    log "✓ egress ${EGRESS_BIND}:${EGRESS_PORT} 可连"
  else
    log "✗ egress 端口 90s 内未就绪"
    RESTART_OK=0
  fi
  if systemctl restart "$MASTER_UNIT"; then
    log "✓ restart $MASTER_UNIT"
  else
    log "✗ restart $MASTER_UNIT 失败"
    RESTART_OK=0
  fi
else
  log "· 跳过 restart (--no-restart)"
fi

health_unconfirmed() {
  log "✗ unit 已恢复但健康未确认 backup=$BACKUP_REAL"
  log "人工收尾: rm -f /run/openclaude-v5-selfhost/cutover-grace-until /run/openclaude-v5-selfhost/health-fail-count /opt/openclaude/openclaude-v5-selfhost-releases/.manual-recovery-required /opt/openclaude/v5-selfhost-watch/watch-disarmed"
  exit 1
}

if [[ "$DO_HEALTHZ" != 1 ]]; then
  log "· 跳过 healthz (--no-healthz);unit 文件已恢复,未验证健康"
  exit 0
fi

if [[ "$DO_RESTART" == 1 && "$RESTART_OK" != 1 ]]; then
  health_unconfirmed
fi

if [[ "$DO_RESTART" == 1 ]]; then
  if ! systemctl is-active --quiet "$MASTER_UNIT"; then
    log "✗ $MASTER_UNIT 未 active"
    health_unconfirmed
  fi
  if ! systemctl is-active --quiet "$EGRESS_UNIT"; then
    log "✗ $EGRESS_UNIT 未 active"
    health_unconfirmed
  fi
fi

if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  log "⚠ jq/curl 缺失,unit 已恢复但无法确认健康"
  health_unconfirmed
fi

sleep 2
log "── healthz ──"
HZ="$(curl -sS --max-time 5 "$MASTER_HEALTH_URL" 2>/dev/null || true)"
if ! echo "$HZ" | jq -e '.ok==true and .runtime.controlPlaneEnabled==true and .runtime.leadership.state=="leader"' >/dev/null 2>&1; then
  log "✗ master healthz 未绿: $(echo "$HZ" | jq -c '{ok,runtime:(.runtime|{controlPlaneEnabled,leadership})}' 2>/dev/null || echo "${HZ:0:200}")"
  health_unconfirmed
fi
log "✓ healthz ok + controlPlaneEnabled + leadership=leader"

EG="$(curl -sS --max-time 5 "$EGRESS_HEALTH_URL" 2>/dev/null || true)"
if ! echo "$EG" | jq -e '.ok==true' >/dev/null 2>&1; then
  log "✗ egress-health 未绿: ${EG:0:200}"
  health_unconfirmed
fi
log "✓ egress-health ok"

log "✓ restore-worktree-units 完成 backup=$BACKUP_REAL"
log "人工收尾(本次不自动做): rm -f /run/openclaude-v5-selfhost/cutover-grace-until /run/openclaude-v5-selfhost/health-fail-count /opt/openclaude/openclaude-v5-selfhost-releases/.manual-recovery-required /opt/openclaude/v5-selfhost-watch/watch-disarmed"
