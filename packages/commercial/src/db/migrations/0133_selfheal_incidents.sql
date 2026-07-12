-- 0133 — v5 全链路自愈运维体系:检测状态权威 + incident 生命周期 + codex 修复账本
--
-- 设计权威:scratchpad/v5-selfheal-design-{v2,v3-delta,v4-delta,v5-final}.md(Codex 4 轮审 PASS)。
-- 本迁移 ADDITIVE-ONLY(部署窗口新旧 master 共存,禁 rename/禁改主键):
--   admin_alert_rule_state 保留物理表名与 rule_id 主键(其值 = condition_key),
--   仅 ADD COLUMN 泛化为通用检测状态表(alert_conditions 语义)。旧 master 只增列不受影响。
--
-- 架构:检测器(shell + TS)统一经 PG function write_alert_condition() 写 condition(单写权威),
--   incident 是 condition 的只读派生投影(reconciler 单向),outbox 告警继续独立投递。

-- ═══════════════════════════════════════════════════════════════════════
-- 1. admin_alert_rule_state → 通用检测状态(alert_conditions 语义)
-- ═══════════════════════════════════════════════════════════════════════
-- mode:  probe   = 可重复求值 level(monitor/provider/账号池),每次评估 upsert 当前值
--        latched = 可聚合成持续故障的 occurrence(如 oversized 按 kind/build)
--        spike   = 窗口聚合(如 payment.failure_spike)
-- 三级 rev 分离(消 update 风暴):
--   observation_seq — 每次 probe 观测 ++,仅供 verify freshness fence,不推送
--   condition_rev   — 仅 phase|level 语义变化 ++
ALTER TABLE admin_alert_rule_state
  ADD COLUMN IF NOT EXISTS mode             TEXT,
  ADD COLUMN IF NOT EXISTS level            TEXT,
  ADD COLUMN IF NOT EXISTS snapshot         JSONB,
  ADD COLUMN IF NOT EXISTS observed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS observation_seq  BIGINT,
  ADD COLUMN IF NOT EXISTS condition_rev    BIGINT,
  ADD COLUMN IF NOT EXISTS occurrence_count BIGINT,
  ADD COLUMN IF NOT EXISTS last_seen_at     TIMESTAMPTZ;

-- backfill 存量 polled rule 行(默认按 probe 语义)
UPDATE admin_alert_rule_state SET
  mode             = COALESCE(mode, 'probe'),
  snapshot         = COALESCE(snapshot, last_payload, '{}'::jsonb),
  level            = COALESCE(level, NULLIF(last_payload->>'severity',''), 'warning'),
  observed_at      = COALESCE(observed_at, last_evaluated_at, last_transition_at, NOW()),
  observation_seq  = COALESCE(observation_seq, 0),
  condition_rev    = COALESCE(condition_rev, 0),
  occurrence_count = COALESCE(occurrence_count, 0);

ALTER TABLE admin_alert_rule_state
  ALTER COLUMN mode            SET NOT NULL,
  ALTER COLUMN mode            SET DEFAULT 'probe',
  ALTER COLUMN snapshot        SET NOT NULL,
  ALTER COLUMN snapshot        SET DEFAULT '{}'::jsonb,
  ALTER COLUMN observed_at     SET NOT NULL,
  ALTER COLUMN observed_at     SET DEFAULT NOW(),
  ALTER COLUMN observation_seq SET NOT NULL,
  ALTER COLUMN observation_seq SET DEFAULT 0,
  ALTER COLUMN condition_rev   SET NOT NULL,
  ALTER COLUMN condition_rev   SET DEFAULT 0,
  ALTER COLUMN occurrence_count SET NOT NULL,
  ALTER COLUMN occurrence_count SET DEFAULT 0,
  ADD CONSTRAINT chk_ars_mode  CHECK (mode  IN ('probe','latched','spike')),
  ADD CONSTRAINT chk_ars_level CHECK (level IN ('info','warning','critical'));

-- ═══════════════════════════════════════════════════════════════════════
-- 2. write_alert_condition() — 单写权威(TS 与 shell 都只调它)
-- ═══════════════════════════════════════════════════════════════════════
-- 严格保持 transitionRuleState 现语义(alertOutbox.ts:757/770):
--   同 phase        → 刷新 snapshot/observed_at + observation_seq++;不清 ack、不动 last_transition_at
--   同 phase 且 level 变 → 额外 condition_rev++(触发 incident update)
--   firing 真翻转   → 更新 firing + last_transition_at=NOW + 清 ack + condition_rev++
--   latched         → occurrence_count += p_occurrence_delta,last_seen_at=NOW
-- 原子返回 previous_firing / transitioned / condition_rev。
CREATE OR REPLACE FUNCTION write_alert_condition(
  p_condition_key    TEXT,
  p_mode             TEXT,
  p_firing           BOOLEAN,
  p_level            TEXT,
  p_snapshot         JSONB,
  p_observed_at      TIMESTAMPTZ,
  p_dedupe_key       TEXT     DEFAULT NULL,
  p_occurrence_delta BIGINT   DEFAULT 0
) RETURNS TABLE (previous_firing BOOLEAN, transitioned BOOLEAN, out_condition_rev BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  v_prev_firing BOOLEAN;
  v_prev_level  TEXT;
  v_rev         BIGINT;
  v_obs_at      TIMESTAMPTZ := COALESCE(p_observed_at, NOW());
  v_level       TEXT        := COALESCE(p_level, 'warning');
BEGIN
  SELECT firing, level, condition_rev
    INTO v_prev_firing, v_prev_level, v_rev
    FROM admin_alert_rule_state
   WHERE rule_id = p_condition_key
   FOR UPDATE;

  IF NOT FOUND THEN
    v_prev_firing := FALSE;
    INSERT INTO admin_alert_rule_state(
      rule_id, firing, dedupe_key, mode, level, snapshot,
      last_transition_at, last_evaluated_at, observed_at,
      observation_seq, condition_rev, occurrence_count, last_seen_at, last_payload)
    VALUES (
      p_condition_key, p_firing, p_dedupe_key, p_mode, v_level, COALESCE(p_snapshot,'{}'::jsonb),
      CASE WHEN p_firing THEN NOW() END, NOW(), v_obs_at,
      1, CASE WHEN p_firing THEN 1 ELSE 0 END,
      GREATEST(p_occurrence_delta, 0),
      CASE WHEN p_occurrence_delta > 0 THEN NOW() END,
      COALESCE(p_snapshot,'{}'::jsonb));
    RETURN QUERY SELECT FALSE, p_firing, (CASE WHEN p_firing THEN 1 ELSE 0 END)::BIGINT;
    RETURN;
  END IF;

  IF v_prev_firing = p_firing THEN
    -- 同 phase:刷新观测;level 变则 condition_rev++
    v_rev := v_rev + CASE WHEN v_prev_level IS DISTINCT FROM v_level THEN 1 ELSE 0 END;
    UPDATE admin_alert_rule_state SET
      dedupe_key       = COALESCE(p_dedupe_key, dedupe_key),
      mode             = p_mode,
      level            = v_level,
      snapshot         = COALESCE(p_snapshot, snapshot),
      last_evaluated_at = NOW(),
      observed_at      = v_obs_at,
      observation_seq  = observation_seq + 1,
      condition_rev    = v_rev,
      occurrence_count = occurrence_count + GREATEST(p_occurrence_delta, 0),
      last_seen_at     = CASE WHEN p_occurrence_delta > 0 THEN NOW() ELSE last_seen_at END,
      last_payload     = COALESCE(p_snapshot, last_payload)
    WHERE rule_id = p_condition_key;
    RETURN QUERY SELECT v_prev_firing, FALSE, v_rev;
    RETURN;
  END IF;

  -- firing 真翻转:清 ack + condition_rev++
  v_rev := v_rev + 1;
  UPDATE admin_alert_rule_state SET
    firing           = p_firing,
    dedupe_key       = p_dedupe_key,
    mode             = p_mode,
    level            = v_level,
    snapshot         = COALESCE(p_snapshot, snapshot),
    last_transition_at = NOW(),
    last_evaluated_at = NOW(),
    observed_at      = v_obs_at,
    observation_seq  = observation_seq + 1,
    condition_rev    = v_rev,
    occurrence_count = occurrence_count + GREATEST(p_occurrence_delta, 0),
    last_seen_at     = CASE WHEN p_occurrence_delta > 0 THEN NOW() ELSE last_seen_at END,
    last_payload     = COALESCE(p_snapshot, last_payload),
    acked            = FALSE,
    acked_at         = NULL,
    acked_by         = NULL
  WHERE rule_id = p_condition_key;
  RETURN QUERY SELECT v_prev_firing, TRUE, v_rev;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. incident_policies — 用户可感事件 → 用户向文案/影响面/自愈策略(单一声明权威)
-- ═══════════════════════════════════════════════════════════════════════
-- match_kind: exact 优先,否则 longest-prefix,同长冲突由加载层 fail-fast。
CREATE TABLE incident_policies (
  id             BIGSERIAL PRIMARY KEY,
  match_kind     TEXT NOT NULL CHECK (match_kind IN ('exact','prefix')),
  match_key      TEXT NOT NULL,
  surface        TEXT NOT NULL DEFAULT 'global',
  audience       TEXT NOT NULL DEFAULT 'all'
                   CHECK (audience IN ('all','surface_cohort','user_ids')),
  resolve_mode   TEXT NOT NULL DEFAULT 'probe'
                   CHECK (resolve_mode IN ('probe','manual')),
  auto_repair    BOOLEAN NOT NULL DEFAULT FALSE,
  severity_floor TEXT NOT NULL DEFAULT 'warning'
                   CHECK (severity_floor IN ('info','warning','critical')),
  user_title     TEXT NOT NULL,
  user_message   TEXT NOT NULL,   -- 用户向正文模板(人话,不含内部排查细节)
  repair_hint    TEXT,            -- 给 codex 的结构化定位提示(不进用户视图)
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_kind, match_key)
);

-- seed:首批覆盖已有明确 firing/resolved 语义的服务级用户可感故障
INSERT INTO incident_policies
  (match_kind, match_key, surface, audience, resolve_mode, auto_repair, severity_floor, user_title, user_message, repair_hint) VALUES
  ('prefix','ops.monitor:svc_v5',        'global','all','probe',TRUE, 'critical','服务短暂中断','我们正在紧急恢复服务,期间可能无法使用,请稍候片刻。','v5 master 进程 down,journalctl 查 openclaude-v5,先重启拉起'),
  ('prefix','ops.monitor:http_v5',       'global','all','probe',TRUE, 'critical','服务响应异常','部分请求可能失败,工程师已在处理,请稍后重试。','healthz 不 ok,深探 sessions.db,drill http 面'),
  ('prefix','ops.monitor:public_route',  'global','all','probe',TRUE, 'critical','网站访问异常','网站访问可能不稳定,我们正在修复。','公网路由/Caddy 面挂,查 install-v5-upstream'),
  ('prefix','ops.monitor:svc_egress',    'chat',  'all','probe',TRUE, 'critical','AI 回复暂时受影响','AI 对话可能延迟或失败,正在恢复中。','egress 进程 down,openclaude-v5-egress'),
  ('prefix','ops.monitor:http_egress',   'chat',  'all','probe',TRUE, 'critical','AI 回复暂时受影响','AI 对话可能延迟或失败,正在恢复中。','egress health 面异常'),
  ('prefix','ops.monitor:mail',          'global','all','probe',FALSE,'critical','邮件发送延迟','注册/找回密码验证码可能延迟,请稍后再试或联系客服。','[mail-resend-error],查 Resend key 双文件同步'),
  ('prefix','ops.monitor:disk',          'global','all','probe',TRUE, 'warning', '系统维护中','系统正在进行维护,少数功能可能受影响。','磁盘水位高,docker prune/日志轮转'),
  ('prefix','ops.monitor:pool',          'global','all','probe',TRUE, 'critical','系统繁忙','当前访问量较大,我们正在扩容,请稍候。','容器池暴涨,查僵尸容器'),
  ('exact', 'account_pool.all_down',     'chat',  'all','probe',FALSE,'critical','AI 服务暂时不可用','AI 对话暂时不可用,工程师正在紧急处理,给您带来不便非常抱歉。','账号池全挂,查 account-pool refresh/凭据'),
  ('exact', 'account_pool.low_capacity', 'chat',  'all','probe',FALSE,'warning', 'AI 服务可能拥挤','高峰期 AI 回复可能变慢,我们正在增补资源。','账号池容量告急'),
  ('exact', 'health.provider_degraded',  'chat',  'all','probe',TRUE, 'warning', 'AI 回复可能变慢','部分 AI 能力短暂波动,系统会自动切换,请稍候。','provider 降级,切换/降权'),
  ('exact', 'system.session_oversized',  'chat',  'user_ids','manual',FALSE,'warning','这条对话过长','当前会话内容已达上限,新回复可能无法保存,建议新开一个对话。','会话行 oversized 拒写,取证 internalServerAuthored'),
  ('exact', 'system.maintenance_on',     'global','all','manual',FALSE,'warning','系统维护中','我们正在进行系统维护,期间部分功能可能暂停,预计很快恢复。',NULL);

-- ═══════════════════════════════════════════════════════════════════════
-- 4. incidents — condition 的派生生命周期投影(open → repairing → resolved)
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE incidents (
  id              BIGSERIAL PRIMARY KEY,
  dedupe_key      TEXT NOT NULL,           -- = condition_key,同 key 至多一条未 resolved
  condition_key   TEXT NOT NULL,
  policy_id       BIGINT REFERENCES incident_policies(id),
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','repairing','resolved')),
  severity        TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  surface         TEXT NOT NULL DEFAULT 'global',
  audience        TEXT NOT NULL DEFAULT 'all',
  user_title      TEXT NOT NULL,
  user_message    TEXT NOT NULL,
  ops_detail      TEXT,                    -- 运维细节(仅 admin/企微),脱敏后
  rev             BIGINT NOT NULL DEFAULT 1,  -- 仅用户可见字段变化时 ++(前端幂等去重)
  resolve_source  TEXT CHECK (resolve_source IN ('probe','codex','admin','auto')),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);
-- 同 condition_key 至多一条活跃 incident(open/repairing)
CREATE UNIQUE INDEX ux_incidents_active_key
  ON incidents (dedupe_key) WHERE status <> 'resolved';
CREATE INDEX idx_incidents_status_id ON incidents (status, id DESC);
CREATE INDEX idx_incidents_opened   ON incidents (opened_at DESC);

-- ═══════════════════════════════════════════════════════════════════════
-- 5. codex_repairs — 修复任务账本(状态机 + 全局 singleflight)
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE codex_repairs (
  id            BIGSERIAL PRIMARY KEY,
  incident_id   BIGINT NOT NULL REFERENCES incidents(id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN (
                    'pending','dispatched','acked','running','verifying',
                    'succeeded','verification_failed','verification_inconclusive',
                    'failed','timeout',
                    'cancel_requested','cancelling','cancelled','cancel_failed','orphaned')),
  attempt       INT NOT NULL DEFAULT 1,
  tier          TEXT NOT NULL DEFAULT 'tier2' CHECK (tier IN ('tier1','tier2')),
  summary       TEXT,                       -- codex 一句话结论
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- commit sha/测试/部署面/耗时(脱敏)
  fail_reason   TEXT,
  verify_after  TIMESTAMPTZ,                -- = done_at,freshness fence:只更新的观测有裁决资格
  verify_deadline TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  acked_at      TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (incident_id, attempt)
);
-- 全局并发 1:全表至多一行处于活跃态(含 cancel 中间态,失联 fail-closed 占槽)
CREATE UNIQUE INDEX ux_repair_singleflight ON codex_repairs ((1)) WHERE status IN (
  'pending','dispatched','acked','running','verifying',
  'cancel_requested','cancelling');
CREATE INDEX idx_repairs_incident ON codex_repairs (incident_id, id DESC);

-- ═══════════════════════════════════════════════════════════════════════
-- 6. codex_repair_events — append-only 进度流(admin 时间线 + "正在做啥")
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE codex_repair_events (
  id          BIGSERIAL PRIMARY KEY,
  repair_id   BIGINT NOT NULL REFERENCES codex_repairs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
                'dispatched','ack','progress','verify','done','failed','timeout','cancel','note')),
  message     TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_repair_events_repair ON codex_repair_events (repair_id, id);

-- ═══════════════════════════════════════════════════════════════════════
-- 7. incident_deliveries — durable 投递 outbox(唯一键 incident+rev+channel)
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE incident_deliveries (
  id           BIGSERIAL PRIMARY KEY,
  incident_id  BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  incident_rev BIGINT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('ws','inbox')),
  phase        TEXT NOT NULL CHECK (phase IN ('opened','updated','resolved')),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  claimed_at   TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (incident_id, incident_rev, channel)
);
CREATE INDEX idx_deliveries_pending ON incident_deliveries (status, id) WHERE status = 'pending';

-- ═══════════════════════════════════════════════════════════════════════
-- 8. incident_recipients — open 时 materialize 的收件人快照(open/resolved 同一批)
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE incident_recipients (
  incident_id  BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL,
  PRIMARY KEY (incident_id, user_id)
);

-- ═══════════════════════════════════════════════════════════════════════
-- 9. inbox_messages 幂等:incident 投递去重(唯一键为最终防线,配合同事务写)
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE inbox_messages
  ADD COLUMN IF NOT EXISTS source_type  TEXT,
  ADD COLUMN IF NOT EXISTS source_id    BIGINT,
  ADD COLUMN IF NOT EXISTS source_phase TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_inbox_source
  ON inbox_messages (source_type, source_id, source_phase)
  WHERE source_type IS NOT NULL;

COMMENT ON FUNCTION write_alert_condition IS
  'v5 自愈:检测状态单写权威。TS(writeCondition adapter)与 shell(v5-monitor.sh)都只调它。保持 transitionRuleState 现语义 + 泛化 condition 字段。';
COMMENT ON TABLE incidents IS
  'v5 自愈:alert_conditions 的派生生命周期投影。ops-ledger 永久保留(见 auditRetention PERMANENT_OPS_LEDGER_TABLES),不进 admin_audit 合规域。';
