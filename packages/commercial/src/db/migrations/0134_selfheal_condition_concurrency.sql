-- ═══════════════════════════════════════════════════════════════════════
-- 0134 — write_alert_condition 并发/时序加固(Codex v5 审计 H3)
-- ═══════════════════════════════════════════════════════════════════════
-- 修三处 0133 原函数的并发/时序缺陷,CREATE OR REPLACE(不改已应用的 0133):
--
--   1. 并发首插丢观测:两事务同时首写同一 key 都 SELECT NOT FOUND → 一个 INSERT 成功,
--      另一个抛 23505,观测丢失。→ 函数入口取 **事务级 advisory lock**(按 condition_key
--      hash)串行化同 key 的所有写者:第二个写者拿到锁后 SELECT 已能 FOUND,走 UPDATE 路径。
--
--   2. 旧观测覆盖新:探测 A(observed_at=t1)阻塞,探测 B(t2>t1)先写,A 后写把较新的
--      健康状态回退。原函数无条件 observed_at=v_obs_at,不看时序。→ FOUND 后若本次 observed_at
--      **早于**已记录 observed_at(乱序旧观测)→ **no-op**(返当前态,不动 firing/level/seq)。
--
--   3. 未来时间穿越:调用方任意 p_observed_at 无上限,错误时钟可污染 verification freshness
--      fence(observed_at > verify_after)。→ v_obs_at 钳到 NOW()(不接受未来观测)。
--
-- 语义在锁+时序保护下与 0133 一致(同 phase 刷新 seq++ / level 变 rev++ / 翻转清 ack rev++ /
-- latched 累加)。首插路径不变(advisory lock 已消除并发首插竞态)。

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
  -- (3) 未来时间 clamp:绝不接受晚于 NOW() 的观测(防错误时钟污染 freshness fence)。
  v_obs_at      TIMESTAMPTZ := LEAST(COALESCE(p_observed_at, NOW()), NOW());
  v_level       TEXT        := COALESCE(p_level, 'warning');
BEGIN
  -- (1) 事务级 advisory lock 串行化同 condition_key 的所有写者:消除并发首插 23505 与
  --     观测交错。COMMIT 时自动释放。
  PERFORM pg_advisory_xact_lock(hashtext(p_condition_key)::BIGINT);

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
    RETURN QUERY SELECT FALSE, p_firing, (CASE WHEN p_firing THEN 1 ELSE 0 END)::BIGINT;
    RETURN;
  END IF;

  -- (2) 乱序旧观测:本次 observed_at 早于已记录的 → 丢弃(no-op),绝不把较新的健康状态回退。
  --     不动 firing/level/observed_at,也不 bump observation_seq。
  IF v_prev_obs_at IS NOT NULL AND v_obs_at < v_prev_obs_at THEN
    RETURN QUERY SELECT v_prev_firing, FALSE, v_rev;
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
