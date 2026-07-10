#!/usr/bin/env bash
# v5 监控自监(方案 §2.3-3)—— 当 openclaude-v5-monitor.service /
# openclaude-v5-daily.service 自身 ExecStart 失败(脚本崩/超时/非 0 退出)时,
# 由各自的 `OnFailure=openclaude-v5-alert-fail@%n.service` 触发本脚本。
#
# 干啥:对失败的单元名($1 = %i,如 openclaude-v5-monitor.service)双写告警:
#   1. outbox fan-out(ops.monitor_check_failed / critical)→ 恢复后 dispatcher 补投企微
#   2. inbox_messages(uid=1,warning)→ 站内信兜底,不受 dispatcher 死活影响
# "监控挂了"本身是最该报的警,所以双落点,且绝不因单点失败静默。
#
# 用法(systemd 调):bash scripts/v5-alert-fail.sh <failed-unit-name>
# 手测:bash scripts/v5-alert-fail.sh openclaude-v5-monitor.service --dry-run

set -uo pipefail

UNIT="${1:-unknown.unit}"
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1

BOSS_UID="${V5FAIL_BOSS_UID:-1}"
ENV_FILE="${V5FAIL_ENV_FILE:-/etc/openclaude/commercial-v5.env}"
LOG_FILE="${V5FAIL_LOG_FILE:-/var/log/openclaude-v5-monitor.log}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FANOUT_SQL="${V5FAIL_FANOUT_SQL:-$SCRIPT_DIR/v5-alert-fanout.sql}"
HOSTFQDN="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo unknown)"
NOW="$(date +%s)"

ts() { TZ=Asia/Shanghai date '+%F %T'; }
log() { if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] $*"; else echo "$(ts) $*" >> "$LOG_FILE"; fi; }

DBURL="$(grep '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"

TITLE="[v5监控-自监] ${UNIT} 执行失败"
BODY="🚨 **监控单元 ${UNIT} 自身 ExecStart 失败**(崩溃/超时/非 0 退出)。"$'\n'
BODY+="监控探活可能已停摆,请立即在 kl-mirror 查:"$'\n'
BODY+="  journalctl -u ${UNIT} -n 50 --no-pager"$'\n\n'
BODY+="($(ts) 北京时间,host=${HOSTFQDN})"
# inbox CHECK:title ≤200 / body ≤16384 字符;iconv -c 兜底截断残字节
TITLE="$(echo "$TITLE" | head -c 190 | iconv -f UTF-8 -t UTF-8 -c)"
BODY="$(echo "$BODY" | head -c 16000 | iconv -f UTF-8 -t UTF-8 -c)"
DEDUPE="ops.monitor_check_failed:selfmon:${UNIT}:${NOW}"
PAYLOAD="$(jq -nc --arg u "$UNIT" --arg h "$HOSTFQDN" \
             '{source:"v5-alert-fail",unit:$u,severity:"critical",host:$h,kind:"self_monitor"}')"

log "SELF-MON $UNIT failed → 双写告警(outbox + inbox)"

# ── 1) outbox fan-out(critical)──
if [ "$DRY_RUN" = 1 ]; then
  log "FANOUT[dry] ops.monitor_check_failed sev=critical dedupe=$DEDUPE"
elif [ -z "$DBURL" ]; then
  log "FANOUT-SKIP 读不到 DATABASE_URL($ENV_FILE)"
elif [ ! -f "$FANOUT_SQL" ]; then
  log "FANOUT-SKIP 找不到 $FANOUT_SQL"
elif psql "$DBURL" -q -v ON_ERROR_STOP=1 \
      -v event_type="ops.monitor_check_failed" -v severity="critical" -v dedupe_key="$DEDUPE" \
      -v title="$TITLE" -v body="$BODY" -v payload="$PAYLOAD" \
      -f "$FANOUT_SQL" >/dev/null 2>&1; then
  log "FANOUT-OK ops.monitor_check_failed(自监)"
else
  log "FANOUT-FAIL ops.monitor_check_failed(自监;inbox/日志仍有留痕)"
fi

# ── 2) inbox_messages 兜底(uid=1,warning)──
if [ "$DRY_RUN" = 1 ]; then
  echo "── dry-run:将写 inbox ──"; echo "title: $TITLE"; echo "$BODY"
elif [ -z "$DBURL" ]; then
  log "INBOX-FAIL 读不到 DATABASE_URL,自监告警只落日志"
elif psql "$DBURL" -q -v ON_ERROR_STOP=1 \
      -v lvl="warning" -v title="$TITLE" -v body="$BODY" -v uid="$BOSS_UID" <<'SQL'
INSERT INTO inbox_messages (audience, user_id, title, body_md, level, created_by)
VALUES ('user', :'uid'::bigint, :'title', :'body', :'lvl', :'uid'::bigint);
SQL
then log "INBOX-SENT [warning] $TITLE"
else log "INBOX-FAIL 站内信 INSERT 失败(自监告警已在本日志留痕)"; fi

exit 0
