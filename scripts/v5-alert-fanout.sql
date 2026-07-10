-- v5 统一告警 outbox fan-out —— 系统 A(shell 监控)侧的单一 SQL 权威。
--
-- 被 scripts/v5-monitor.sh、scripts/v5-daily-check.sh、scripts/v5-alert-fail.sh
-- 三处 psql -f 复用。参数(psql -v,全部必传):
--   event_type  例 'ops.monitor_check_failed'
--   severity    'info' | 'warning' | 'critical'
--   dedupe_key  幂等键(idx_aao_dedupe_pending);建议 `${event_type}:${target}:${bucket}`
--   title       站内标题(调用方已截断/转义无关,psql :'...' 负责 SQL 字面量安全)
--   body        Markdown 正文
--   payload     一段 **合法 JSON 字符串**(调用方用 jq -nc 构造,保证转义安全)
--
-- ── 语义权威 ────────────────────────────────────────────────────────
-- 本 SQL 必须与 packages/commercial/src/admin/alertOutbox.ts 的
--   enqueueAlert() / channelSubscribes() / listDispatchableChannels()
--   + findActiveSilence() / matcherMatches()
-- **逐条对齐**(shell 无法 import TS,只能复刻;不允许出现第二套判定规则)。
-- 改动订阅 / 静默判定时,TS 与本文件必须同改。参照 v3 infra/health-smoke/insert-alert.sql。
--
-- 对齐点:
--   * 可投递通道 = enabled=TRUE AND activation_status IN ('active','pending')
--     (= listDispatchableChannels)。
--   * severity 门槛:event_severity_rank >= channel.severity_min_rank
--     (= channelSubscribes:SEVERITY_ORDER[event] >= SEVERITY_ORDER[min])。
--   * event_types 订阅:空数组 / 非 array(脏数据防御,同 TS COALESCE '[]'=全订阅)
--     视作"订阅全部";否则要求数组包含 event_type。用 CASE 而非 OR 短路,避免
--     planner 对非 array 值 pre-evaluate jsonb_array_length 报错(v3 Codex round2 教训)。
--   * 静默:命中任一活跃 silence(starts<=now<ends 且 matcher 匹配)→ status='suppressed'
--     (= enqueueAlert 的 silence 分支:仍落行,只是不投递)。matcher 逐维复刻
--     matcherMatches:event_type / severity 任一为 NULL(未设)= match any;本 shell 路径
--     无 rule_id,故 matcher 若显式带 rule_id 则永不匹配(rule_id 维度恒不满足)。
--   * ON CONFLICT (channel_id, dedupe_key) WHERE ...:同 enqueueAlert 幂等去重。
--
-- payload 用 :'payload'::jsonb:psql :'...' 先做 SQL 字面量转义,再 ::jsonb 解析;
-- 调用方保证传入的是 jq 产出的合法 JSON(URL/detail 里的引号/反斜杠不会破坏 JSON)。

INSERT INTO admin_alert_outbox (
  event_type, severity, dedupe_key, title, body, payload,
  channel_id, status, next_attempt_at
)
SELECT
  :'event_type',
  :'severity',
  :'dedupe_key',
  :'title',
  :'body',
  :'payload'::jsonb,
  c.id,
  CASE
    WHEN EXISTS (
      SELECT 1
        FROM admin_alert_silences s
       WHERE s.starts_at <= NOW()
         AND s.ends_at   >  NOW()
         AND (s.matcher->>'event_type' IS NULL OR s.matcher->>'event_type' = :'event_type')
         AND (s.matcher->>'severity'   IS NULL OR s.matcher->>'severity'   = :'severity')
         -- shell 路径无 rule_id;matcher 若要求 rule_id 则该维度恒不满足 → 不匹配。
         AND (s.matcher->>'rule_id'    IS NULL)
    ) THEN 'suppressed'
    ELSE 'pending'
  END,
  NOW()
FROM admin_alert_channels c
WHERE c.enabled = TRUE
  AND c.activation_status IN ('active', 'pending')
  -- severity 门槛:event_rank >= channel.severity_min_rank
  AND CASE :'severity'
        WHEN 'info' THEN 0 WHEN 'warning' THEN 1 WHEN 'critical' THEN 2 ELSE 0
      END
      >=
      CASE c.severity_min
        WHEN 'info' THEN 0 WHEN 'warning' THEN 1 WHEN 'critical' THEN 2 ELSE 0
      END
  -- event_types 订阅(空/非 array = 全订阅)
  AND CASE
        WHEN jsonb_typeof(c.event_types) <> 'array' THEN TRUE
        WHEN jsonb_array_length(c.event_types) = 0 THEN TRUE
        ELSE c.event_types ? :'event_type'
      END
ON CONFLICT (channel_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'failed')
  DO NOTHING;
