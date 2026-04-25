#!/usr/bin/env bash
# Critical#1 — daily backup of openclaude_commercial via pg_dump --format=custom.
# Runs as root via systemd timer; uses runuser -u postgres for peer auth.
# Keeps the last RETAIN_DAYS files; small DB (~10MB), trivial disk cost.
#
# 2026-04-22 Codex R1 IMPORTANT#4/#5 hardening:
#   - umask 077 保证 dump / log 在创建瞬间就是 600,不依赖后置 chmod 补救
#   - install -d -m 700 BACKUP_DIR(owner=postgres)避免目录 world-readable
#   - dump 到 *.part 后原子 mv → 成品,失败不留半截污染 rotate/pg_restore -l
#   - rotate 放在最前面(磁盘将满时先腾出空间,再写新 dump,避免因空间不足连跪)
#   - flock 由 systemd 层兜(ExecStart 带 /usr/bin/flock),脚本自己不依赖
#
# 2026-04-25 M7/P1-10 — sudo → runuser 切换:
#   - 在非交互 systemd 环境下,sudo 可能受 pam_limits / TTY 缺失干扰
#   - runuser 是 systemd 友好的身份切换原语
#   - 行为等价(都走 peer auth socket connect),无功能变化
set -euo pipefail
umask 077

BACKUP_DIR=/var/backups/postgres
RETAIN_DAYS=14
LOG=/var/log/pg-backup-openclaude.log
TS=$(date -u +%Y%m%d-%H%M%SZ)
OUT="$BACKUP_DIR/openclaude_commercial-$TS.dump"
PART="$OUT.part"

# 目录权限锁死(幂等)。owner=postgres 因为 pg_dump 写文件时以 postgres 身份。
install -d -m 700 -o postgres -g postgres "$BACKUP_DIR"
# 日志文件权限锁死 — 创建时 600,幂等修正(从老版本升级时 644 → 600)
if [ ! -e "$LOG" ]; then install -m 600 /dev/null "$LOG"; fi
chmod 600 "$LOG" 2>/dev/null || true

{
  echo
  echo "=== $(date -u +%FT%TZ) pg-backup start → $OUT ==="

  # 先 rotate 再写 — 磁盘紧张时先释放空间
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'openclaude_commercial-*.dump' \
    -mtime +$RETAIN_DAYS -print -delete
  # 清理上次意外遗留的 .part(超 1 天)
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'openclaude_commercial-*.dump.part' \
    -mtime +1 -print -delete

  # 空间预检:若剩余 < 200MB 直接放弃(上次 dump ~90KB,200MB 安全阈)
  AVAIL=$(df -P "$BACKUP_DIR" | awk 'NR==2{print $4}')
  if [ "${AVAIL:-0}" -lt 204800 ]; then
    echo "FAIL: disk available ${AVAIL}KB < 200MB threshold" >&2
    exit 3
  fi

  # --format=custom (binary, compressed, pg_restore -j parallel)
  # -Z 9 max compression (DB <10MB, CPU trivial)
  # --no-acl / --no-owner left OFF: we want ownership captured for DR
  runuser -u postgres -- pg_dump -Fc -Z 9 -d openclaude_commercial -f "$PART"
  # 权限再次确认(dump 本身以 postgres 身份写入,umask 077 已生效,这里兜底)
  chmod 600 "$PART"
  chown postgres:postgres "$PART"

  # Integrity check 在 .part 上做,失败则 dump 不晋升为正式成品
  if ! runuser -u postgres -- pg_restore -l "$PART" > /dev/null; then
    echo 'FAIL: pg_restore -l rejected the dump (stays as .part for inspection)' >&2
    exit 2
  fi

  # 原子晋升
  mv -f "$PART" "$OUT"

  SIZE=$(stat -c%s "$OUT")
  echo "written $SIZE bytes, pg_restore -l OK"

  echo '--- current backups ---'
  ls -lht "$BACKUP_DIR" | head -20
  echo "=== pg-backup end ==="
} >> "$LOG" 2>&1
