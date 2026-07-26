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
--
-- ── 投递结果回报(2026-07-26 P0:零通道静默丢弃)──────────────────────────────
-- 本文件最后一条语句在 stdout 打印一行机器可读结果:
--     fanout targets=<N> inserted=<N> suppressed=<N>
--   targets   = 通过"可投递 + severity 门槛 + event_types 订阅"筛选后的通道数;
--   inserted  = 真新建的 outbox 行数(ON CONFLICT 去重跳过的不计);
--   suppressed= 其中因活跃 silence 落 'suppressed' 的行数。
-- 为什么必须回报:`INSERT .. SELECT` 匹配 0 个通道时落 0 行,psql 依然退出 0 ——
-- 调用方原本一律打印 "FANOUT-OK",于是 `severity=info` 的事件(rank 0)遇上线上唯一
-- 通道 severity_min='warning'(rank 1)时**恒**为 0 行,却报成成功。实测后果:
-- `ops.daily_report` 与 `ops.monitor_recovered` 建库至今各 0 行 —— 心跳与全部恢复
-- 通知从未推送过,而日志里全是 FANOUT-OK。targets=0 现在是调用方能看见的事实:
-- v5-monitor.sh / v5-daily-check.sh 打印 `FANOUT-ZERO`,且日检把"心跳零投递"直接写进
-- 日报正文。让 info 心跳真正落到推送侧需要给至少一个通道配 severity_min='info'
-- ——那是运维动作(改 admin_alert_channels),不是本 SQL 该偷偷绕过的东西:绕过 =
-- 出现第二套路由规则,与本文件"逐条对齐 TS"的定位直接冲突。见 docs/V5_MONITORING.md。
--
-- 为什么**不**在这里补 TS enqueueAlert 的"零通道 → inbox 兜底":四个 shell 调用方
-- (v5-monitor.sh / v5-daily-check.sh / v5-alert-fail.sh / v5-baseline-evals-weekly.sh)
-- 都已经无条件直插 inbox_messages 写同一内容,送达不变量在调用方一侧已满足;SQL 再兜
-- 一次只会让每条告警在站内信里出现两遍(日报每天两条)。TS 侧需要兜底是因为它没有
-- 那条无条件 inbox 写。参数契约刻意保持不变(不新增必传 psql 变量),否则未同步的
-- 调用方会因 unset variable + ON_ERROR_STOP=1 直接失败。

WITH targets AS (
  SELECT c.id
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
), fanned AS (
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
    t.id,
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
  FROM targets t
  ON CONFLICT (channel_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'failed')
    DO NOTHING
  RETURNING status
)
SELECT 'fanout targets=' || (SELECT count(*) FROM targets)
    || ' inserted='      || (SELECT count(*) FROM fanned)
    || ' suppressed='    || (SELECT count(*) FROM fanned WHERE status = 'suppressed');
