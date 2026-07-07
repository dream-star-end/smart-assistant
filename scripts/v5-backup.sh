#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OpenClaude v5(Aurora 商业版)权威数据本机备份 —— 幂等,供 systemd timer 每日触发。
#
# 背景(2026-07-07 P0 数据面审计):kl-mirror 的 openclaude-v3-backup.sh 只备 v3 路径,
# v5 的会话历史 / 运行时配置 / secrets 全无自动备份 —— 单点磁盘故障即全体会话历史丢失。
# 本脚本补齐 v5 侧「文件级」权威数据:
#   1. $V5_HOME/sessions.db      —— 全体客户端会话历史(sqlite,WAL 下用 `.backup` 热备,
#                                   不锁写、拿到一致快照;直接 cp 在 WAL 活跃时可能拷到
#                                   撕裂状态)。
#   2. $V5_HOME/openclaude.json  —— v5 运行时主配置(若存在)
#   3. $V5_HOME/cron.yaml        —— v5 定时任务定义(若存在)
#   4. $V5_ENV_FILE              —— commercial-v5.env(含 secrets;备份目录 700/文件 600)
#
# **不在本脚本范围**:
#   - openclaude_commercial 这类 PG 库 —— 已由 infra/pg-backup-pull 的 pg_dump timer 覆盖。
#   - r7 GCS 卷备份接 scheduler —— 涉及 commercial 包(gcsBackupBroker),见交付报告"待办"。
#
# 设计对齐 infra/pg-backup-pull/pg-backup-openclaude.sh:
#   - set -euo pipefail + umask 077(产物创建瞬间即 600,不靠后置 chmod)
#   - 先 rotate 再写(磁盘紧张时先腾空间)
#   - 原子:staging 到 *.partial 目录,成功后 mv 晋升为成品(失败不留半截污染 rotate)
#   - flock 由 systemd ExecStart 层兜(防 timer Persistent 回放 / 手工触发 / 长跑重叠)
#
# 可配置(全部 env 覆盖,默认适配 kl-mirror v5 master 现状):
#   V5_HOME               v5 运行时数据目录        (默认 /root/.openclaude-v5)
#   V5_ENV_FILE           commercial env 文件      (默认 /etc/openclaude/commercial-v5.env)
#   V5_BACKUP_DIR         本机备份根目录            (默认 /var/backups/openclaude-v5)
#   V5_BACKUP_RETAIN_DAYS 本机保留天数              (默认 14)
#   V5_BACKUP_REMOTE      可选 rsync 目标(user@host:/path);**默认空 = 只本地**
#   V5_BACKUP_LOG         日志文件                  (默认 /var/log/openclaude-v5-backup.log)
#
# 手动干跑(不部署、不影响线上):
#   V5_BACKUP_DIR=/tmp/v5bk V5_ENV_FILE=/dev/null bash scripts/v5-backup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
umask 077

V5_HOME=${V5_HOME:-/root/.openclaude-v5}
V5_ENV_FILE=${V5_ENV_FILE:-/etc/openclaude/commercial-v5.env}
V5_BACKUP_DIR=${V5_BACKUP_DIR:-/var/backups/openclaude-v5}
V5_BACKUP_RETAIN_DAYS=${V5_BACKUP_RETAIN_DAYS:-14}
V5_BACKUP_REMOTE=${V5_BACKUP_REMOTE:-}
V5_BACKUP_LOG=${V5_BACKUP_LOG:-/var/log/openclaude-v5-backup.log}

TS=$(date -u +%Y%m%d-%H%M%SZ)
FINAL_DIR="$V5_BACKUP_DIR/v5-$TS"
STAGE_DIR="$FINAL_DIR.partial"

# 备份根目录权限锁死(幂等)。700 因含 secrets(env)+ 全体会话历史。
install -d -m 700 "$V5_BACKUP_DIR"
# 日志文件权限锁死 —— 创建时 600,幂等修正(从老版本升级时 644 → 600)。
if [ ! -e "$V5_BACKUP_LOG" ]; then install -m 600 /dev/null "$V5_BACKUP_LOG"; fi
chmod 600 "$V5_BACKUP_LOG" 2>/dev/null || true

{
  echo
  echo "=== $(date -u +%FT%TZ) v5-backup start → $FINAL_DIR ==="

  # ── 1) 先 rotate 再写 —— 磁盘紧张时先释放空间 ──────────────────────────────
  # 过期成品目录(按 mtime)。
  find "$V5_BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'v5-*' \
    ! -name '*.partial' -mtime +"$V5_BACKUP_RETAIN_DAYS" -print -exec rm -rf {} +
  # 上次意外遗留的 .partial(超 1 天)。
  find "$V5_BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'v5-*.partial' \
    -mtime +1 -print -exec rm -rf {} +

  # ── 2) 空间预检:剩余 < 500MB 直接放弃(sessions.db 可达数百 MB)──────────
  AVAIL=$(df -P "$V5_BACKUP_DIR" | awk 'NR==2{print $4}')
  if [ "${AVAIL:-0}" -lt 512000 ]; then
    echo "FAIL: disk available ${AVAIL}KB < 500MB threshold" >&2
    exit 3
  fi

  install -d -m 700 "$STAGE_DIR"
  BACKED_UP=0

  # ── 3) sessions.db 热备(WAL 安全,不锁写)───────────────────────────────
  DB="$V5_HOME/sessions.db"
  if [ -f "$DB" ]; then
    if ! command -v sqlite3 >/dev/null 2>&1; then
      echo "FAIL: sqlite3 not found — cannot hot-backup $DB" >&2
      exit 4
    fi
    # `.backup` 走 sqlite online backup API:即使 WAL 活跃 / 有并发写,也拿到一致快照,
    # 不 block writer。直接 cp 在 checkpoint 之间可能拷到 db + 未合并 -wal 的撕裂对。
    if sqlite3 "$DB" ".backup '$STAGE_DIR/sessions.db'"; then
      # 完整性自检:坏快照不晋升为成品。
      if sqlite3 "$STAGE_DIR/sessions.db" 'PRAGMA integrity_check;' | head -1 | grep -qx 'ok'; then
        chmod 600 "$STAGE_DIR/sessions.db"
        SIZE=$(stat -c%s "$STAGE_DIR/sessions.db")
        echo "  sessions.db → $SIZE bytes (integrity_check ok)"
        BACKED_UP=$((BACKED_UP + 1))
      else
        echo "FAIL: sessions.db backup failed integrity_check" >&2
        exit 5
      fi
    else
      echo "FAIL: sqlite3 .backup of $DB failed" >&2
      exit 5
    fi
  else
    echo "  WARN: $DB not found — skipping (v5 未安装 / 尚未产生会话?)"
  fi

  # ── 4) 运行时配置 + secrets(存在才备,缺失只 warn)─────────────────────
  for f in "$V5_HOME/openclaude.json" "$V5_HOME/cron.yaml" "$V5_ENV_FILE"; do
    if [ -f "$f" ]; then
      install -m 600 "$f" "$STAGE_DIR/$(basename "$f")"
      echo "  $(basename "$f") → copied"
      BACKED_UP=$((BACKED_UP + 1))
    else
      echo "  WARN: $f not found — skipping"
    fi
  done

  # 一件都没备到 = 大概率路径配置错(而非"本来就没数据")→ 非零退出让 timer OnFailure 告警。
  if [ "$BACKED_UP" -eq 0 ]; then
    echo "FAIL: nothing was backed up (check V5_HOME / V5_ENV_FILE paths)" >&2
    rm -rf "$STAGE_DIR"
    exit 6
  fi

  # 记一个清单便于 DR 时核对(内容非敏感:文件名 + 大小)。
  ( cd "$STAGE_DIR" && ls -l ) > "$STAGE_DIR/MANIFEST.txt" || true

  # ── 5) 原子晋升 ─────────────────────────────────────────────────────────
  mv -f "$STAGE_DIR" "$FINAL_DIR"
  echo "  promoted → $FINAL_DIR ($BACKED_UP items)"

  # ── 6) 可选异机 rsync(默认空 = 只本地)────────────────────────────────
  if [ -n "$V5_BACKUP_REMOTE" ]; then
    if command -v rsync >/dev/null 2>&1; then
      echo "  rsync → $V5_BACKUP_REMOTE"
      # -a 保权限/时间;--mkpath 自动建远端目录(新版 rsync);失败不吞(备份本地成功,
      # 异机推送失败仍需告警但不回滚本地成品)。
      if rsync -a --mkpath "$FINAL_DIR" "$V5_BACKUP_REMOTE/"; then
        echo "  rsync ok"
      else
        echo "WARN: rsync to $V5_BACKUP_REMOTE failed (local backup intact)" >&2
      fi
    else
      echo "WARN: V5_BACKUP_REMOTE set but rsync not installed — skipped" >&2
    fi
  fi

  echo '--- current v5 backups ---'
  ls -lhtd "$V5_BACKUP_DIR"/v5-* 2>/dev/null | head -20 || true
  echo "=== v5-backup end ==="
} >> "$V5_BACKUP_LOG" 2>&1
