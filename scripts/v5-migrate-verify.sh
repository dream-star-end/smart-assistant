#!/usr/bin/env bash
# P0 只读核实:v3→v5 迁移前的现网 ground truth。零写入。在 kl-mirror 跑。
#
# 用法:
#   export $(grep -v '^#' /etc/openclaude/commercial.env | xargs)   # 取 DATABASE_URL
#   bash scripts/v5-migrate-verify.sh
#
# 输出:用户/余额/订阅分布、容器按 channel×host 分布、v3/v5 卷计数与命名样式、
#       迁移状态分布、self host uuid。用于判定 remote 通道是否首期必须、放量规模。
set -euo pipefail

: "${DATABASE_URL:?需要 DATABASE_URL(从 /etc/openclaude/commercial.env)}"

psql_ro() { psql "$DATABASE_URL" -X -A -F $'\t' --pset footer=off -c "$1"; }

echo "== 用户 / 余额 =="
psql_ro "SELECT count(*) AS users_total,
                count(*) FILTER (WHERE credits>0) AS with_wallet_credits,
                coalesce(sum(credits),0) AS total_wallet_credits
         FROM users WHERE status<>'deleted';"

echo; echo "== 订阅分布(有行=已访问过 v5 / 已 bootstrap)=="
psql_ro "SELECT plan_code, status, count(*),
                count(*) FILTER (WHERE period_credits>0) AS with_period
         FROM user_subscriptions GROUP BY 1,2 ORDER BY 1,2;" || echo "(user_subscriptions 不存在?检查 0096)"

echo; echo "== free_bootstrap_settled 分布(0100 已 apply 应=存量全 TRUE)=="
psql_ro "SELECT free_bootstrap_settled, count(*) FROM users WHERE status<>'deleted' GROUP BY 1;" \
  || echo "(free_bootstrap_settled 列不存在?检查 0100)"

echo; echo "== 迁移状态分布(v5_migration_status)=="
psql_ro "SELECT coalesce(v5_migration_status,'(null=纯v3)') AS status,
                count(*),
                count(*) FILTER (WHERE v5_migrated_at IS NOT NULL) AS on_v5
         FROM users WHERE status<>'deleted' GROUP BY 1 ORDER BY 1;" \
  || echo "(v5_migration_status 列不存在?检查 0099)"

echo; echo "== agent_containers 按 channel × state × host =="
psql_ro "SELECT runtime_channel, state, host_uuid, count(*)
         FROM agent_containers GROUP BY 1,2,3 ORDER BY 1,2,3;"

echo; echo "== self host uuid(compute_hosts name='self')=="
psql_ro "SELECT id AS self_host_uuid, name, status FROM compute_hosts WHERE name='self';"

if command -v docker >/dev/null 2>&1; then
  echo; echo "== docker 卷计数(本机)=="
  v3n=$(docker volume ls -q --filter name='^oc-v3-' | wc -l)
  v5n=$(docker volume ls -q --filter name='^oc-v5-' | wc -l)
  echo -e "oc-v3-* 卷数:\t$v3n"
  echo -e "oc-v5-* 卷数:\t$v5n"
  echo "-- oc-v3-data-* 样例(前 5)--"; docker volume ls -q --filter name='^oc-v3-data-' | head -5
else
  echo; echo "(本机无 docker CLI,跳过卷计数)"
fi

echo; echo "核实完毕。关注:v3 容器是否有 host_uuid ≠ self(→需 consolidate 或 remote 通道 P1)。"
