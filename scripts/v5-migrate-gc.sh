#!/usr/bin/env bash
# P6 收尾:GC 已迁移用户的 v3 卷(回滚窗过后回收磁盘)。默认 dry-run,须 --apply 才真删。
#
# 只处理:v5_migration_status='migrated' 且 v5_migrated_at < now()-<window> 的用户(已切且过观察窗)。
# 对每个这样的用户,删其 oc-v3-{data,proj,codex,userlocal,userconfig}-u<uid> 卷。
# v5 卷、PG 数据、未迁移/回滚用户一律不碰。
#
# 用法(在 kl-mirror):
#   export $(grep -v '^#' /etc/openclaude/commercial.env | xargs)
#   bash scripts/v5-migrate-gc.sh --older-than 7d            # dry-run(默认)
#   bash scripts/v5-migrate-gc.sh --older-than 7d --apply    # 真删
set -euo pipefail

: "${DATABASE_URL:?需要 DATABASE_URL}"
WINDOW="7d"; APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --older-than) WINDOW="$2"; shift 2;;
    --apply) APPLY=1; shift;;
    *) echo "unknown arg: $1"; exit 2;;
  esac
done
case "$WINDOW" in *d) INTERVAL="${WINDOW%d} days";; *h) INTERVAL="${WINDOW%h} hours";;
  *) echo "--older-than 需形如 7d / 24h"; exit 2;; esac

command -v docker >/dev/null 2>&1 || { echo "需要 docker CLI"; exit 2; }

echo "== GC 候选:migrated 且 v5_migrated_at < now() - interval '$INTERVAL' =="
UIDS=$(psql "$DATABASE_URL" -X -A -t -c \
  "SELECT id FROM users
    WHERE v5_migration_status='migrated'
      AND v5_migrated_at IS NOT NULL
      AND v5_migrated_at < now() - interval '$INTERVAL'
    ORDER BY id;")

[ -z "$UIDS" ] && { echo "无候选用户。"; exit 0; }
echo "候选用户数:$(echo "$UIDS" | wc -w)"
[ "$APPLY" -eq 1 ] && echo "!! --apply:将真删下列卷 !!" || echo "(dry-run:仅列出;加 --apply 真删)"

for uid in $UIDS; do
  for role in data proj codex userlocal userconfig; do
    vol="oc-v3-${role}-u${uid}"
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      if [ "$APPLY" -eq 1 ]; then
        # 防守:卷若正被容器占用,docker 会拒删(不强删)。
        if docker volume rm "$vol" >/dev/null 2>&1; then echo "  removed $vol"
        else echo "  SKIP(in-use/err) $vol"; fi
      else
        echo "  would remove $vol"
      fi
    fi
  done
done
echo "完成。"
