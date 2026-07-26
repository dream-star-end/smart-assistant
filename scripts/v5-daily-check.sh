#!/usr/bin/env bash
# v5 监控告警最小集 —— 日检 + 日报(roadmap P0.3)
#
# 干啥(简单粗暴,ops 极简):每天 09:00 北京时间(openclaude-v5-daily.timer)跑:
#   1. 计费突增:昨日(北京时间自然日)单用户 credits 消耗 > 该用户前 7 日日均 ×3
#      且绝对值 >2000 → 告警(共享 PG usage_records,status='success' 口径)
#   2. 免单率:昨日(零输出免单 + turn 级冲正退款)占成功计费笔数比 >20% → 告警
#        - 零输出免单:usage_records status='success' AND cost_credits=0 AND
#          output_tokens=0 AND 有 input/cache tokens(proxyBilling waivedNoOutput
#          落库形状;waive 标记只进日志不进库,这是库内能取到的最好近似,见文档局限)
#        - 冲正退款:credit_ledger reason='refund' AND ref_type='usage_record'
#          (billing/refund.ts 唯一写入形状),按 ref_id 去重计笔
#   3. GPT-5.6 缓存命中:按模型统计今日(北京时间 0 点至当前)成功 usage
#      records;达到样本门槛后按绝对低线/相对前三活跃日基线判断。
#   4. 日报正文(无告警也发):v5 近 24h 活跃用户数/会话数(sessions.db
#      client_sessions)、昨日错误日志行数、昨日计费笔数/总消耗
#
# 告警通道:同 v5-monitor.sh(站内信首选 + monitor 日志兜底)。
# 用法:bash scripts/v5-daily-check.sh [--dry-run]
# 详见 docs/V5_MONITORING.md。

set -uo pipefail

# ───────────────────────────────────────────────
# 常量(env 可覆盖 —— 仅为本机 mock 测试留口)
# ───────────────────────────────────────────────
# BOSS_UID 依据同 v5-monitor.sh:users.id=1(1193355375@qq.com,最早注册的 admin)。
BOSS_UID="${V5DAY_BOSS_UID:-1}"

ENV_FILE="${V5DAY_ENV_FILE:-/etc/openclaude/commercial-v5.env}"
LOG_FILE="${V5DAY_LOG_FILE:-/var/log/openclaude-v5-monitor.log}"
SESSIONS_DB="${V5DAY_SESSIONS_DB:-/root/.openclaude-v5/sessions.db}"
V5_LOG="${V5DAY_V5_LOG:-/var/log/openclaude-v5.log}"        # logrotate 每天 00:00(UTC)轮转
V5_LOG_YDAY="${V5DAY_V5_LOG_YDAY:-/var/log/openclaude-v5.log.1}"

SPIKE_ABS_MIN=2000     # 计费突增:昨日消耗绝对值下限(credits)
SPIKE_MULT=3           # 计费突增:昨日消耗 > 前 7 日日均 × 此倍数
WAIVE_PCT_MAX=20       # 免单率上限(%)
WAIVE_MIN_SAMPLES=10   # 昨日成功笔数低于此值不算免单率(小样本防误报,如 1/2=50%)
CACHE_SAMPLE_MIN_INPUT=5000000 # 当前/基线最低总输入量
CACHE_MIN_RECORDS=10           # 当前成功 usage records 最低样本数
CACHE_ABSOLUTE_LOW_BPS=7000    # 绝对低线:<70.00%
CACHE_REGRESSION_LOW_BPS=8500  # 回归线:<85.00%
CACHE_DROP_MIN_BPS=1500        # 相对三活跃日基线至少下降 15.00pp

cache_should_alert() { # records current_input current_bps baseline_input baseline_bps
  local records="$1" current_input="$2" current_bps="$3" baseline_input="$4" baseline_bps="$5"
  [ "$records" -ge "$CACHE_MIN_RECORDS" ] &&
    [ "$current_input" -ge "$CACHE_SAMPLE_MIN_INPUT" ] || return 1
  [ "$current_bps" -lt "$CACHE_ABSOLUTE_LOW_BPS" ] && return 0
  [ "$current_bps" -lt "$CACHE_REGRESSION_LOW_BPS" ] &&
    [ "$baseline_input" -ge "$CACHE_SAMPLE_MIN_INPUT" ] &&
    [ "$((baseline_bps - current_bps))" -ge "$CACHE_DROP_MIN_BPS" ]
}

cache_threshold_self_test() {
  cache_should_alert 10 5000000 6999 0 0 || return 1
  ! cache_should_alert 10 5000000 7000 0 0 || return 1
  cache_should_alert 10 5000000 8499 5000000 9999 || return 1
  ! cache_should_alert 10 5000000 8500 5000000 10000 || return 1
  cache_should_alert 10 5000000 8000 5000000 9500 || return 1
  ! cache_should_alert 10 5000000 8001 5000000 9500 || return 1
  ! cache_should_alert 9 5000000 1 5000000 10000 || return 1
  ! cache_should_alert 10 4999999 1 5000000 10000 || return 1
  ! cache_should_alert 10 5000000 8000 4999999 9500 || return 1
}

cache_boundary_self_test() {
  # SQL 使用相同的 Asia/Shanghai 当日零点公式。固定时刻确保边界不会
  # 被执行机器时区影响:2026-07-12 04:34:56Z → 当日 00:00 CST。
  local now_epoch=1783830896
  local start_epoch
  start_epoch="$(TZ=Asia/Shanghai date -d "$(TZ=Asia/Shanghai date -d "@${now_epoch}" '+%F 00:00:00')" +%s)"
  [ "$start_epoch" -eq 1783785600 ] || return 1
  [ "$start_epoch" -le "$now_epoch" ] || return 1
}

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
if [ "${1:-}" = "--self-test" ]; then
  cache_threshold_self_test && cache_boundary_self_test && \
    echo "v5-daily-check cache threshold/boundary self-test: PASS"
  exit $?
fi

ts() { TZ=Asia/Shanghai date '+%F %T'; }
log() { if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] $*"; else echo "$(ts) $*" >> "$LOG_FILE"; fi; }

REPORT_DATE="$(TZ=Asia/Shanghai date -d yesterday +%F)"     # 日报覆盖的自然日(北京时间)
DBURL="$(grep '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"

# 统一告警管道(方案 §2.3-2):除站内信外,psql 直插 admin_alert_outbox,恢复后
# dispatcher 补投企微。fan-out 判定复刻 enqueueAlert TS 语义,单一 SQL 权威见
# scripts/v5-alert-fanout.sql(与 v5-monitor.sh 同一文件)。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FANOUT_SQL="${V5DAY_FANOUT_SQL:-$SCRIPT_DIR/v5-alert-fanout.sql}"
HOSTFQDN="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo unknown)"

# fan-out 一个事件到 admin_alert_outbox;失败只记日志,不阻断。--dry-run 只打印。
#
# 投递结果如实回报(2026-07-26 P0,与 v5-monitor.sh 同构):共享 SQL 末尾打印
# `fanout targets=N inserted=N suppressed=N`。此前无论落几行都打印 FANOUT-OK,于是
# `ops.daily_report`(severity=info)撞上"唯一通道 severity_min=warning"这条恒假门槛,
# 建库至今在 admin_alert_outbox **0 行** —— 推送侧从来没有过一次"监控还活着"的心跳,
# 而日志天天显示成功。FANOUT_LAST_TARGETS 供调用方把这个事实写进日报正文。
FANOUT_LAST_TARGETS=""
fanout_alert() { # <event_type> <severity> <dedupe_key> <title> <body> <payload_json>
  FANOUT_LAST_TARGETS=""
  if [ "$DRY_RUN" = 1 ]; then log "FANOUT[dry] $1 sev=$2 dedupe=$3"; return 0; fi
  if [ -z "$DBURL" ]; then log "FANOUT-SKIP 读不到 DATABASE_URL($ENV_FILE) event=$1"; return 0; fi
  if [ ! -f "$FANOUT_SQL" ]; then log "FANOUT-SKIP 找不到 $FANOUT_SQL event=$1"; return 0; fi
  local out targets inserted
  if ! out="$(psql "$DBURL" -tAq -v ON_ERROR_STOP=1 \
       -v event_type="$1" -v severity="$2" -v dedupe_key="$3" \
       -v title="$4" -v body="$5" -v payload="$6" \
       -f "$FANOUT_SQL" 2>&1)"; then
    log "FANOUT-FAIL $1 sev=$2(outbox 未落,inbox/日志仍有留痕):$(printf '%s' "$out" | tr '\n' ' ' | head -c 160)"
    return 0
  fi
  targets="$(printf '%s' "$out" | sed -n 's/.*fanout targets=\([0-9]\{1,\}\).*/\1/p' | head -1)"
  inserted="$(printf '%s' "$out" | sed -n 's/.*inserted=\([0-9]\{1,\}\).*/\1/p' | head -1)"
  FANOUT_LAST_TARGETS="$targets"
  if [ -z "$targets" ]; then
    log "FANOUT-UNKNOWN $1 sev=$2 —— 共享 SQL 未回报投递计数(模板被改?):$(printf '%s' "$out" | tr '\n' ' ' | head -c 160)"
  elif [ "$targets" = 0 ]; then
    log "FANOUT-ZERO $1 sev=$2 —— 零通道订阅(severity 门槛/enabled/activation_status),推送侧收不到;站内信仍有留痕"
  elif [ "${inserted:-0}" = 0 ]; then
    log "FANOUT-DEDUP $1 sev=$2 targets=$targets(全部命中幂等去重,未新建行)"
  else
    log "FANOUT-OK $1 sev=$2 targets=$targets inserted=$inserted"
  fi
}

ALERTS=()   # 告警行(有则 level=warning)
INFOS=()    # 日报正文行

# ───────────────────────────────────────────────
# 1. 计费突增(昨日 vs 前 7 日日均;北京时间自然日边界,索引友好)
# ───────────────────────────────────────────────
run_billing_checks() {
  if [ -z "$DBURL" ]; then
    ALERTS+=("日检取数失败:读不到 DATABASE_URL($ENV_FILE)"); return
  fi
  local spikes
  spikes="$(psql "$DBURL" -At -F'|' -v ON_ERROR_STOP=1 \
      -v abs_min="$SPIKE_ABS_MIN" -v mult="$SPIKE_MULT" <<'SQL' 2>&1
WITH b AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - interval '1 day') AT TIME ZONE 'Asia/Shanghai' AS y0,
         date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS y1
), yday AS (
  SELECT ur.user_id, SUM(ur.cost_credits) AS spent
    FROM usage_records ur, b
   WHERE ur.status = 'success' AND ur.created_at >= b.y0 AND ur.created_at < b.y1
   GROUP BY ur.user_id
), prior AS (
  SELECT ur.user_id, SUM(ur.cost_credits) / 7.0 AS daily_avg
    FROM usage_records ur, b
   WHERE ur.status = 'success' AND ur.created_at >= b.y0 - interval '7 days' AND ur.created_at < b.y0
   GROUP BY ur.user_id
)
SELECT y.user_id, u.email, y.spent, COALESCE(p.daily_avg, 0)::bigint
  FROM yday y JOIN users u ON u.id = y.user_id
  LEFT JOIN prior p ON p.user_id = y.user_id
 WHERE y.spent > :abs_min::bigint
   AND y.spent::numeric > COALESCE(p.daily_avg, 0) * :mult::numeric
 ORDER BY y.spent DESC;
SQL
  )" || { ALERTS+=("计费突增查询失败:$(echo "$spikes" | head -c 200)"); return; }
  if [ -n "$spikes" ]; then
    while IFS='|' read -r uid email spent avg; do
      [ -z "$uid" ] && continue
      ALERTS+=("计费突增:用户 ${uid}(${email})昨日消耗 ${spent} credits,前 7 日日均 ${avg}(阈值:>${SPIKE_ABS_MIN} 且 >均值×${SPIKE_MULT})")
    done <<< "$spikes"
  fi

  # ── 2. 免单率 + 昨日计费总量(同一次取数) ──
  local stats total waived refunded spent_total
  stats="$(psql "$DBURL" -At -F'|' -v ON_ERROR_STOP=1 <<'SQL' 2>&1
WITH b AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - interval '1 day') AT TIME ZONE 'Asia/Shanghai' AS y0,
         date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS y1
)
SELECT
  (SELECT COUNT(*) FROM usage_records ur, b
    WHERE ur.status = 'success' AND ur.created_at >= b.y0 AND ur.created_at < b.y1),
  (SELECT COUNT(*) FROM usage_records ur, b
    WHERE ur.status = 'success' AND ur.created_at >= b.y0 AND ur.created_at < b.y1
      AND ur.cost_credits = 0 AND ur.output_tokens = 0
      AND (ur.input_tokens > 0 OR ur.cache_read_tokens > 0 OR ur.cache_write_tokens > 0)),
  (SELECT COUNT(DISTINCT cl.ref_id) FROM credit_ledger cl, b
    WHERE cl.reason = 'refund' AND cl.ref_type = 'usage_record'
      AND cl.created_at >= b.y0 AND cl.created_at < b.y1),
  (SELECT COALESCE(SUM(ur.cost_credits), 0) FROM usage_records ur, b
    WHERE ur.status = 'success' AND ur.created_at >= b.y0 AND ur.created_at < b.y1);
SQL
  )" || { ALERTS+=("免单率查询失败:$(echo "$stats" | head -c 200)"); return; }
  IFS='|' read -r total waived refunded spent_total <<< "$stats"
  case "$total" in ''|*[!0-9]*) ALERTS+=("免单率查询输出异常:$(echo "$stats" | head -c 200)"); return;; esac

  INFOS+=("昨日计费:成功 ${total} 笔,总消耗 ${spent_total} credits(v3+v5 共库口径)")
  INFOS+=("昨日免单:零输出免单 ${waived} 笔 + 冲正退款 ${refunded} 笔")
  if [ "$total" -ge "$WAIVE_MIN_SAMPLES" ]; then
    local pct
    pct=$(( (waived + refunded) * 100 / total ))
    INFOS+=("免单率 ${pct}%(阈值 ${WAIVE_PCT_MAX}%)")
    if [ "$pct" -gt "$WAIVE_PCT_MAX" ]; then
      ALERTS+=("免单率过高:昨日 ${pct}%((${waived}+${refunded})/${total}),说明上游 hang/超时面扩大或计费口径出问题")
    fi
  else
    INFOS+=("免单率:样本不足(${total} < ${WAIVE_MIN_SAMPLES}),跳过判定")
  fi

  # ── 3. GPT-5.6 今日缓存命中率(按模型 + 三活跃日基线 + 集中度) ──
  # usage_records.input_tokens 是非缓存输入,因此总输入 = input + cache_read;
  # cache_write 不属于本次读取命中率分母。COUNT(*) 是成功 usage records,不是 turn 数。
  local cache_rows
  if cache_rows="$(psql "$DBURL" -At -F'|' -v ON_ERROR_STOP=1 <<'SQL' 2>&1
WITH b AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS c0,
         now() AS c1
), current_rows AS (
  SELECT ur.model, ur.user_id, ur.session_id,
         COALESCE(ur.input_tokens, 0) + COALESCE(ur.cache_read_tokens, 0) AS total_input,
         COALESCE(ur.cache_read_tokens, 0) AS cached_input
    FROM usage_records ur, b
   WHERE ur.status = 'success'
     AND ur.created_at >= b.c0 AND ur.created_at < b.c1
     AND ur.model LIKE 'gpt-5.6-%'
), per_model AS (
  SELECT ur.model,
         COUNT(*) AS records,
         SUM(ur.total_input) AS total_input,
         SUM(ur.cached_input) AS cached_input
    FROM current_rows ur
   GROUP BY ur.model
), user_rank AS (
  SELECT model, user_id, SUM(total_input) AS user_input,
         ROW_NUMBER() OVER (PARTITION BY model ORDER BY SUM(total_input) DESC, user_id) AS rn
    FROM current_rows GROUP BY model, user_id
), session_rank AS (
  SELECT model, LEFT(md5(session_id), 8) AS session_hash,
         SUM(total_input) AS session_input,
         ROW_NUMBER() OVER (
           PARTITION BY model ORDER BY SUM(total_input) DESC, session_id
         ) AS rn
    FROM current_rows
   WHERE session_id IS NOT NULL AND BTRIM(session_id) <> ''
   GROUP BY model, session_id
), prior_daily AS (
  SELECT ur.model, (ur.created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
         SUM(COALESCE(ur.input_tokens, 0) + COALESCE(ur.cache_read_tokens, 0)) AS total_input,
         SUM(COALESCE(ur.cache_read_tokens, 0)) AS cached_input
    FROM usage_records ur, b
   WHERE ur.status = 'success' AND ur.created_at < b.c0
     AND ur.model IN (SELECT model FROM per_model)
   GROUP BY ur.model, (ur.created_at AT TIME ZONE 'Asia/Shanghai')::date
  HAVING SUM(COALESCE(ur.input_tokens, 0) + COALESCE(ur.cache_read_tokens, 0)) > 0
), prior_ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY model ORDER BY day DESC) AS rn
    FROM prior_daily
), baseline AS (
  SELECT model, COUNT(*) AS days, SUM(total_input) AS total_input,
         SUM(cached_input) AS cached_input
    FROM prior_ranked WHERE rn <= 3 GROUP BY model
)
SELECT p.model, p.records, p.total_input, p.cached_input,
       CASE WHEN p.total_input > 0
            THEN FLOOR(p.cached_input * 10000.0 / p.total_input)::bigint
            ELSE 0 END AS hit_bps
     , COALESCE(bl.total_input, 0), COALESCE(bl.cached_input, 0)
     , CASE WHEN COALESCE(bl.total_input, 0) > 0
            THEN FLOOR(bl.cached_input * 10000.0 / bl.total_input)::bigint ELSE 0 END
     , COALESCE(bl.days, 0)
     , COALESCE(u.user_id::text, '-'), COALESCE(u.user_input, 0)
     , CASE WHEN p.total_input > 0
            THEN FLOOR(COALESCE(u.user_input, 0) * 10000.0 / p.total_input)::bigint ELSE 0 END
     , COALESCE(s.session_hash, '-'), COALESCE(s.session_input, 0)
     , CASE WHEN p.total_input > 0
            THEN FLOOR(COALESCE(s.session_input, 0) * 10000.0 / p.total_input)::bigint ELSE 0 END
  FROM per_model p
  LEFT JOIN baseline bl ON bl.model = p.model
  LEFT JOIN user_rank u ON u.model = p.model AND u.rn = 1
  LEFT JOIN session_rank s ON s.model = p.model AND s.rn = 1
 ORDER BY p.model;
SQL
  )"; then
    if [ -z "$cache_rows" ]; then
      INFOS+=("GPT-5.6 缓存:今日暂无成功 usage records")
    else
      while IFS='|' read -r model records total_input cached_input hit_bps \
          baseline_input baseline_cached baseline_bps baseline_days \
          top_uid top_user_input top_user_bps top_session top_session_input top_session_bps; do
        [ -z "$model" ] && continue
        if [[ ! "$records" =~ ^[0-9]+$ || ! "$total_input" =~ ^[0-9]+$ ||
              ! "$cached_input" =~ ^[0-9]+$ || ! "$hit_bps" =~ ^[0-9]+$ ||
              ! "$baseline_input" =~ ^[0-9]+$ || ! "$baseline_bps" =~ ^[0-9]+$ ||
              ! "$baseline_days" =~ ^[0-9]+$ || ! "$top_user_bps" =~ ^[0-9]+$ ||
              ! "$top_session_bps" =~ ^[0-9]+$ ]]; then
          ALERTS+=("GPT-5.6 缓存查询输出异常:$(echo "$model|$records|$total_input|$cached_input|$hit_bps" | head -c 200)")
          continue
        fi
        local hit_pct baseline_pct top_user_pct top_session_pct
        printf -v hit_pct '%d.%02d' "$((hit_bps / 100))" "$((hit_bps % 100))"
        printf -v baseline_pct '%d.%02d' "$((baseline_bps / 100))" "$((baseline_bps % 100))"
        printf -v top_user_pct '%d.%02d' "$((top_user_bps / 100))" "$((top_user_bps % 100))"
        printf -v top_session_pct '%d.%02d' "$((top_session_bps / 100))" "$((top_session_bps % 100))"
        INFOS+=("GPT-5.6 缓存 ${model}:命中 ${hit_pct}%,成功 records ${records},总输入 ${total_input},缓存输入 ${cached_input};前三活跃日基线 ${baseline_pct}%(${baseline_days} 日,总输入 ${baseline_input})")
        INFOS+=("GPT-5.6 集中度 ${model}:Top 用户 ${top_uid} 占 ${top_user_pct}%(${top_user_input});Top 会话 #${top_session} 占 ${top_session_pct}%(${top_session_input})")
        if cache_should_alert "$records" "$total_input" "$hit_bps" "$baseline_input" "$baseline_bps"; then
          ALERTS+=("GPT-5.6 缓存命中偏低:${model} 今日 ${hit_pct}%(基线 ${baseline_pct}%,缓存 ${cached_input}/总输入 ${total_input},成功 records ${records};规则:样本≥${CACHE_SAMPLE_MIN_INPUT}/${CACHE_MIN_RECORDS},绝对<70% 或 <85%且较基线下降≥15pp)")
        fi
      done <<< "$cache_rows"
    fi
  else
    ALERTS+=("GPT-5.6 缓存查询失败:$(echo "$cache_rows" | head -c 200)")
  fi
}

# ───────────────────────────────────────────────
# 4. v5 活跃度 + 错误日志(日报正文)
# ───────────────────────────────────────────────
run_activity_stats() {
  local row
  # 会话权威分流(RFC-v5-sessions-pg §5b):OC_SESSIONS_STORE=pg 割接后 client_sessions
  # 权威在 PG,继续查 SQLite 会静默报冻结旧数据。
  local _store
  _store="$(set -a; . /etc/openclaude/commercial-v5.env 2>/dev/null; printf '%s' "${OC_SESSIONS_STORE:-}")"
  if [[ "$_store" == "pg" ]]; then
    if row="$(psql "$(set -a; . /etc/openclaude/commercial-v5.env 2>/dev/null; printf '%s' "$DATABASE_URL")" -tA -c \
        "SELECT COUNT(DISTINCT user_id) || '|' || COUNT(*) FROM client_sessions
          WHERE deleted_at IS NULL
            AND last_at >= (EXTRACT(EPOCH FROM now())::BIGINT - 86400) * 1000;" 2>&1)"; then
      INFOS+=("v5 近 24h(PG):活跃用户 ${row%%|*},活跃会话 ${row##*|}")
    else
      ALERTS+=("PG client_sessions 取数失败:$(echo "$row" | head -c 200)")
    fi
    return
  fi
  if row="$(sqlite3 -readonly "$SESSIONS_DB" \
      "SELECT COUNT(DISTINCT user_id) || '|' || COUNT(*) FROM client_sessions
        WHERE deleted_at IS NULL
          AND last_at >= (CAST(strftime('%s','now') AS INTEGER) - 86400) * 1000;" 2>&1)"; then
    INFOS+=("v5 近 24h:活跃用户 ${row%%|*},活跃会话 ${row##*|}")
  else
    ALERTS+=("sessions.db 取数失败:$(echo "$row" | head -c 200)")
  fi

  # 日志按天 00:00(UTC)轮转:.log.1 = 昨日(UTC)全天,.log = 今日 0 点起。
  # 匹配 pino 的 "level":"error"(裸 ERROR 在该日志里不出现)。
  local e_yday=NA e_today=NA
  [ -f "$V5_LOG_YDAY" ] && e_yday="$(grep -c '"level":"error"' "$V5_LOG_YDAY" || true)"
  [ -f "$V5_LOG" ]      && e_today="$(grep -c '"level":"error"' "$V5_LOG" || true)"
  INFOS+=("v5 错误日志行:昨日(UTC)${e_yday},今日 0 点起 ${e_today}")
}

run_billing_checks
run_activity_stats

# ───────────────────────────────────────────────
# 组装日报(无告警也发)并发送
# ───────────────────────────────────────────────
if [ "${#ALERTS[@]}" -gt 0 ]; then
  LEVEL=warning; TITLE="[v5日报] ${REPORT_DATE} 有 ${#ALERTS[@]} 项告警"
else
  LEVEL=info; TITLE="[v5日报] ${REPORT_DATE} 一切正常"
fi
BODY="v5 日检(${REPORT_DATE},北京时间自然日):"$'\n'
if [ "${#ALERTS[@]}" -gt 0 ]; then
  BODY+=$'\n'"**告警:**"$'\n'
  for a in "${ALERTS[@]}"; do BODY+="- ⚠️ $a"$'\n'; done
fi
BODY+=$'\n'"**日报:**"$'\n'
for i in "${INFOS[@]}"; do BODY+="- $i"$'\n'; done
BODY+=$'\n'"(阈值与口径见 docs/V5_MONITORING.md)"
# inbox body CHECK ≤16384 字符;head -c 按字节截可能切半 CJK,iconv -c 丢掉尾部残字节
BODY="$(echo "$BODY" | head -c 16000 | iconv -f UTF-8 -t UTF-8 -c)"

log "DAILY $TITLE"
for a in "${ALERTS[@]}"; do log "  ALERT $a"; done
for i in "${INFOS[@]}"; do log "  INFO  $i"; done

# ── 统一告警管道:outbox fan-out(方案 §2.3-2)──
# 恒发 ops.daily_report(info,完整日报);有异常再发 ops.daily_anomaly(warning,仅
# 异常明细)。分开两事件让 severity 路由正确:severity_min=warning 的通道只收异常,
# =info 的通道两者都收。与既有站内信(一条聚合消息)正交,不改 inbox 行为。
fanout_daily() {
  fanout_alert "ops.daily_report" "info" \
    "ops.daily_report:${REPORT_DATE}" \
    "[v5日报] ${REPORT_DATE} 运行日报" \
    "$BODY" \
    "$(jq -nc --arg d "$REPORT_DATE" --arg n "${#ALERTS[@]}" --arg h "$HOSTFQDN" \
         '{source:"v5-daily",report_date:$d,alerts_count:($n|tonumber),host:$h,kind:"report"}')"
  if [ "${#ALERTS[@]}" -gt 0 ]; then
    local anom="v5 日检异常(${REPORT_DATE},北京时间自然日):"$'\n'
    for a in "${ALERTS[@]}"; do anom+="- ⚠️ $a"$'\n'; done
    anom="$(echo "$anom" | head -c 16000 | iconv -f UTF-8 -t UTF-8 -c)"
    fanout_alert "ops.daily_anomaly" "warning" \
      "ops.daily_anomaly:${REPORT_DATE}" \
      "[v5日报] ${REPORT_DATE} 有 ${#ALERTS[@]} 项异常" \
      "$anom" \
      "$(jq -nc --arg d "$REPORT_DATE" --arg n "${#ALERTS[@]}" --arg h "$HOSTFQDN" \
           '{source:"v5-daily",report_date:$d,alerts_count:($n|tonumber),host:$h,kind:"anomaly"}')"
  fi
}
fanout_daily

# 心跳零投递如实写进日报正文(2026-07-26 P0)。日报正身就是"监控还活着"的正向心跳,
# 而它 severity=info,撞上"唯一可投递通道 severity_min=warning"这条恒假门槛时**推送侧
# 收不到任何东西**:值班侧因此无法用"心跳缺失"判断监控整体死亡。
# 这里刻意只做"如实陈述",不把心跳升级成 warning —— 把常规日报伪装成告警会训练值班
# 忽略 warning,代价比收益大。真正的修法是给至少一个通道配 severity_min='info'
# (运维动作,见 docs/V5_MONITORING.md);配好后本行自动消失。
if [ "${FANOUT_LAST_TARGETS:-}" = 0 ]; then
  BODY+=$'\n'"> ⚠️ 心跳未推送:本条日报(info)匹配到 **0** 个可投递通道 —— 推送侧没有任何正向心跳,监控整体死亡时无法靠\"心跳缺失\"察觉。修法:给一个 admin_alert_channels 通道配 severity_min='info'(见 docs/V5_MONITORING.md)。"$'\n'
  BODY="$(echo "$BODY" | head -c 16000 | iconv -f UTF-8 -t UTF-8 -c)"
  log "HEARTBEAT-NOT-PUSHED ops.daily_report 匹配 0 个通道(已写入日报正文)"
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "── dry-run:将发送站内信 ─────────────"
  echo "level: $LEVEL"; echo "title: $TITLE"; echo "$BODY"
  exit 0
fi

if [ -z "$DBURL" ]; then log "ALERT-FAIL 读不到 DATABASE_URL,日报只落日志"; exit 0; fi
if psql "$DBURL" -q -v ON_ERROR_STOP=1 \
    -v lvl="$LEVEL" -v title="$TITLE" -v body="$BODY" -v uid="$BOSS_UID" <<'SQL'
INSERT INTO inbox_messages (audience, user_id, title, body_md, level, created_by)
VALUES ('user', :'uid'::bigint, :'title', :'body', :'lvl', :'uid'::bigint);
SQL
then log "ALERT-SENT [$LEVEL] $TITLE"
else log "ALERT-FAIL 站内信 INSERT 失败(日报正文已在本日志留痕)"; fi
exit 0
