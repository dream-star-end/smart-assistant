-- ═══════════════════════════════════════════════════════════════════════
-- 0135 — v5 自愈体系收尾批:suppression(H1b)+ capability 防重放(M2)
--        + webhook nonce 落库(M3)+ condition key 域对齐(B1)
-- ═══════════════════════════════════════════════════════════════════════
-- ADDITIVE + 幂等(可重复 apply):ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT
-- EXISTS / ON CONFLICT DO NOTHING / 带谓词 UPDATE / CREATE OR REPLACE FUNCTION。
--
-- 配套(不在本文件):0136_selfheal_writer_guard.sql 是**独立迁移**,apply 有双重门
-- (新 master 上线 + 回滚池核对),本文件可先行在线 apply。

-- ─────────────────────────────────────────────────────────────────────
-- 1. suppression 三列(H1b:operator 压制,直至 condition 真实恢复)
-- ─────────────────────────────────────────────────────────────────────
-- 列域划分:检测列(firing/mode/level/snapshot/observed_at/seq/rev/occurrence)
-- = write_alert_condition 专写;operator 列(acked* + suppressed_*)= 应用直写。
-- 0136 writer-guard trigger 按此划分放行。
ALTER TABLE admin_alert_rule_state
  ADD COLUMN IF NOT EXISTS suppressed_until_clear BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS suppressed_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suppressed_by          TEXT;

-- ─────────────────────────────────────────────────────────────────────
-- 2. write_alert_condition(基于 0134 版全量誊写,两处增量)
-- ─────────────────────────────────────────────────────────────────────
-- 增量 a(H1b):firing 真翻转 **true→false** 时自动清 suppression 三列——
--   压制是"直到真实恢复"的 tombstone,恢复后新一轮故障必须重新告警。
-- 增量 b(M1 前置):函数体入口 set_config('oc.selfheal_condition_writer','1',true),
--   每个 RETURN 前复位 ''——为 0136 writer-guard trigger 提供"function 上下文"标记。
--   0136 未 apply 时该 GUC 无消费者,纯 no-op。
-- 0134 三加固原样保留:①advisory lock 串行化同 key 写者 ②乱序旧观测 no-op
-- ③未来时间 clamp(LEAST(...,NOW()))。
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
  v_prev_obs_at TIMESTAMPTZ;
  -- (0134-3) 未来时间 clamp:绝不接受晚于 NOW() 的观测(防错误时钟污染 freshness fence)。
  v_obs_at      TIMESTAMPTZ := LEAST(COALESCE(p_observed_at, NOW()), NOW());
  v_level       TEXT        := COALESCE(p_level, 'warning');
BEGIN
  -- (0134-1) 事务级 advisory lock 串行化同 condition_key 的所有写者。COMMIT 自动释放。
  PERFORM pg_advisory_xact_lock(hashtext(p_condition_key)::BIGINT);
  -- (0136 前置) 单写权威标记:trigger 据此放行本函数内的 INSERT/UPDATE。
  PERFORM set_config('oc.selfheal_condition_writer', '1', true);

  SELECT firing, level, condition_rev, observed_at
    INTO v_prev_firing, v_prev_level, v_rev, v_prev_obs_at
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
    PERFORM set_config('oc.selfheal_condition_writer', '', true);
    RETURN QUERY SELECT FALSE, p_firing, (CASE WHEN p_firing THEN 1 ELSE 0 END)::BIGINT;
    RETURN;
  END IF;

  -- (0134-2) 乱序旧观测:本次 observed_at 早于已记录的 → 丢弃(no-op)。
  IF v_prev_obs_at IS NOT NULL AND v_obs_at < v_prev_obs_at THEN
    PERFORM set_config('oc.selfheal_condition_writer', '', true);
    RETURN QUERY SELECT v_prev_firing, FALSE, v_rev;
    RETURN;
  END IF;

  IF v_prev_firing = p_firing THEN
    -- 同 phase:刷新观测;level 变则 condition_rev++。suppression 不动(仍 firing 期间压制持续)。
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
    PERFORM set_config('oc.selfheal_condition_writer', '', true);
    RETURN QUERY SELECT v_prev_firing, FALSE, v_rev;
    RETURN;
  END IF;

  -- firing 真翻转:清 ack + condition_rev++;true→false 额外自动清 suppression(H1b)。
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
    acked_by         = NULL,
    suppressed_until_clear = CASE WHEN p_firing THEN suppressed_until_clear ELSE FALSE END,
    suppressed_at          = CASE WHEN p_firing THEN suppressed_at          ELSE NULL  END,
    suppressed_by          = CASE WHEN p_firing THEN suppressed_by          ELSE NULL  END
  WHERE rule_id = p_condition_key;
  PERFORM set_config('oc.selfheal_condition_writer', '', true);
  RETURN QUERY SELECT v_prev_firing, TRUE, v_rev;
END;
$$;

COMMENT ON FUNCTION write_alert_condition IS
  'v5 自愈:检测状态单写权威(0135:+suppression 自动清 + writer GUC 标记)。TS(writeCondition adapter)与 shell(v5-monitor.sh)都只调它。';

-- ─────────────────────────────────────────────────────────────────────
-- 3. condition key 域对齐(B1):exact seed → prefix(带谓词,幂等)
-- ─────────────────────────────────────────────────────────────────────
-- providerHealthScheduler 写 `health.provider_degraded:<id>`(per-provider);
-- internalServerAuthored 写 `system.session_oversized:<uid>`(per-user)。
-- 旧 `provider_health:*` condition 行成为无 policy 死行(良性,部署后可清)。
UPDATE incident_policies
   SET match_kind = 'prefix', match_key = 'health.provider_degraded:', updated_at = NOW()
 WHERE match_kind = 'exact' AND match_key = 'health.provider_degraded';

UPDATE incident_policies
   SET match_kind = 'prefix', match_key = 'system.session_oversized:', updated_at = NOW()
 WHERE match_kind = 'exact' AND match_key = 'system.session_oversized';

-- 补 seed:v5-monitor.sh 的 mem(warning,可自动修复:清理/重启泄漏进程)与
-- image(critical,tag 漂移起新容器会挂 —— 修复面在镜像/环境,不派 codex 自动改)。
INSERT INTO incident_policies
  (match_kind, match_key, surface, audience, resolve_mode, auto_repair, severity_floor, user_title, user_message, repair_hint) VALUES
  ('prefix','ops.monitor:mem',   'global','all','probe',TRUE, 'warning', '服务可能变慢','系统负载较高,响应可能变慢,工程师已在处理。','内存 available 低于阈值(v5-monitor check_mem),查 top 内存大户/泄漏进程,必要时重启泄漏进程'),
  ('prefix','ops.monitor:image', 'chat',  'all','probe',FALSE,'critical','AI 服务可能受影响','新对话可能暂时无法开始,工程师已在处理。','OC_RUNTIME_IMAGE tag 不在 docker images(漂移,起新容器会挂);核对 commercial-v5.env 与镜像构建记录')
ON CONFLICT (match_kind, match_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 4. capability 防重放账本(M2):done/failed 逐 jti 一次性消费
-- ─────────────────────────────────────────────────────────────────────
-- 消费(INSERT ON CONFLICT DO NOTHING)与 repair 状态 CAS + repair_event 同一
-- PG 事务:事务失败 jti 一并回滚,合法重试不被误 409;冲突 = 重放 → 409。
-- progress/ack 天然可重复,不记账。
CREATE TABLE IF NOT EXISTS selfheal_capability_uses (
  repair_id BIGINT NOT NULL,
  jti       TEXT   NOT NULL,
  action    TEXT   NOT NULL,
  used_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (repair_id, jti, action)
);

-- ─────────────────────────────────────────────────────────────────────
-- 5. webhook nonce 落库(M3):单 master 重启后重放窗口闭合
-- ─────────────────────────────────────────────────────────────────────
-- claim-capability 校验:sig 验过才 INSERT ON CONFLICT DO NOTHING 原子判重
-- (插不进 = 重放拒绝)。sweeper tick 顺手 DELETE seen_at < now()-10min
-- (ts 窗口 ±2min << 10min,保留余量)。
CREATE TABLE IF NOT EXISTS selfheal_webhook_nonces (
  nonce   TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
