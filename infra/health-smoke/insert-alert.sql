-- M8.2 / P2-19 — health-smoke-v3 alert dispatch.
--
-- Called from health-smoke-v3-runner.sh via:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v dedupe_key=... -v body=... \
--     -v p_url=... -v p_checked_at=... -v p_host=... \
--     -f insert-alert.sql
--
-- Replicates listDispatchableChannels() + channelSubscribes() from
-- packages/commercial/src/admin/{alertChannels,alertOutbox}.ts in pure SQL,
-- because runner is a bash systemd unit (cannot import TS).
--
-- silence intentionally NOT replicated:
--   matcherMatches() in alertOutbox.ts is a multi-dimensional jsonb DSL;
--   double-implementing in SQL would drift. health-smoke is a "last-resort
--   liveness" alert — maintenance suppression should be `systemctl stop
--   health-smoke-v3.timer`, not admin UI silence. See plan v2 reply.
--
-- ON CONFLICT here is a defense-in-depth backstop; outage-level dedup is
-- primarily enforced by the marker file in the runner.
--
-- Codex M8.2 IMPORTANT#2: payload is built via jsonb_build_object so URL /
-- hostname can contain quotes/backslashes without producing invalid JSON.
-- psql :'name' quoting only sanitizes for SQL string literals, not JSON.

INSERT INTO admin_alert_outbox (
  event_type, severity, dedupe_key, title, body, payload,
  channel_id, status, next_attempt_at
)
SELECT
  'health.smoke_failed',
  'critical',
  :'dedupe_key',
  'health smoke failed (claudeai.chat)',
  :'body',
  jsonb_build_object(
    'url',        :'p_url',
    'checked_at', :'p_checked_at',
    'host',       :'p_host'
  ),
  c.id,
  'pending',
  NOW()
FROM admin_alert_channels c
WHERE c.enabled = TRUE
  AND c.activation_status IN ('active', 'pending')
  -- severity_min ≤ event severity (critical = 2)
  AND CASE c.severity_min
        WHEN 'info' THEN 0
        WHEN 'warning' THEN 1
        WHEN 'critical' THEN 2
      END <= 2
  -- event_types 必须是 array 才能用 jsonb_array_length / ?.
  -- Codex M8.2 IMPORTANT#1: schema 只有 NOT NULL 没 type 约束, 一条脏数据
  -- (object/string/null) 会让 INSERT 报错, runner 5min 死循环重试. 防御写法:
  -- 非 array 视作"全订阅"(treat as subscribe-all) — 跟应用层默认一致.
  --
  -- Codex M8.2 IMPORTANT (round 2): 用 CASE 而不是 OR 短路, 避免 planner
  -- 对 array 之外的值 pre-evaluate jsonb_array_length() 报错.
  AND CASE
        WHEN jsonb_typeof(c.event_types) <> 'array' THEN TRUE
        WHEN jsonb_array_length(c.event_types) = 0 THEN TRUE
        ELSE c.event_types ? 'health.smoke_failed'
      END
ON CONFLICT (channel_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'failed')
  DO NOTHING;
