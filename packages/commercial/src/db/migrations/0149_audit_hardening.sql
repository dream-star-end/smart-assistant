-- 0149_audit_hardening.sql
--
-- 收口 2026-07-15 审计复查发现的历史隐私/语义/噪声：
--   * agent_audit 不再保留输入/输出预览，只留 hash + 有界错误分类；
--   * 两类 admin_audit 旧格式做受控标签整形；
--   * compute pool 启动完成/重复 self image.loaded 非状态迁移，从审计流移除。
-- migrate runner 会把本文件整体包在单一事务中；admin_audit 规则窗口另加表锁，
-- 任一 DML/规则验证失败都会连同 DROP RULE 一起回滚。

-- ── 1. agent 工具失败历史隐私清理 + 滚动升级 DB 兜底 ──────────────────
-- 旧 master 在新迁移生效、进程切换完成前仍可能发送 v1 预览。触发器让这段窗口
-- 也只落 hash/分类；新 master 同样经过此守卫，隐私不依赖单一应用层调用点。
CREATE OR REPLACE FUNCTION agent_audit_privacy_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta JSONB;
  v_error_class TEXT;
BEGIN
  v_meta := CASE
    WHEN jsonb_typeof(NEW.input_meta) = 'object' THEN NEW.input_meta
    ELSE '{}'::jsonb
  END;
  v_error_class := v_meta->>'error_class';
  IF v_error_class IS NULL OR v_error_class NOT IN (
    'unknown_skill', 'command_not_found', 'file_not_found', 'permission_denied',
    'timeout', 'cancelled', 'validation_error', 'rate_limited',
    'service_unavailable', 'network_error', 'other'
  ) THEN
    v_error_class := CASE
      WHEN COALESCE(NEW.error_msg, '') ~* 'unknown skill' THEN 'unknown_skill'
      WHEN COALESCE(NEW.error_msg, '') ~* 'command not found|not recognized as (an internal|a) command' THEN 'command_not_found'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mENOENT\M|no such file or directory|cannot find (the )?(file|path)' THEN 'file_not_found'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mEACCES\M|permission denied|operation not permitted' THEN 'permission_denied'
      WHEN COALESCE(NEW.error_msg, '') ~* 'timed? out|timeout|deadline exceeded' THEN 'timeout'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mabort(ed)?\M|cancelled|canceled' THEN 'cancelled'
      WHEN COALESCE(NEW.error_msg, '') ~* 'too many requests|rate.?limit|http[[:space:]]*429|status[[:space:]]*429' THEN 'rate_limited'
      WHEN COALESCE(NEW.error_msg, '') ~* 'service unavailable|bad gateway|http[[:space:]]*50[23]|status[[:space:]]*50[23]' THEN 'service_unavailable'
      WHEN COALESCE(NEW.error_msg, '') ~* '\mECONN(REFUSED|RESET|ABORTED)\M|\mENOTFOUND\M|network error|fetch failed|socket hang up|\mDNS\M' THEN 'network_error'
      WHEN COALESCE(NEW.error_msg, '') ~* 'validation|invalid (input|argument|request)|schema error|bad request' THEN 'validation_error'
      ELSE 'other'
    END;
  END IF;
  NEW.input_meta := (v_meta - 'input_preview') || jsonb_build_object('error_class', v_error_class);
  NEW.error_msg := NULL;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_agent_audit_privacy_guard ON agent_audit;
CREATE TRIGGER trg_agent_audit_privacy_guard
BEFORE INSERT OR UPDATE ON agent_audit
FOR EACH ROW EXECUTE FUNCTION agent_audit_privacy_guard();

-- 用一次受控 UPDATE 让 BEFORE UPDATE 守卫清理所有不合规历史行。
UPDATE agent_audit
   SET input_meta = input_meta,
       error_msg = error_msg
 WHERE input_meta ? 'input_preview'
    OR error_msg IS NOT NULL
    OR COALESCE(input_meta->>'error_class', '') NOT IN (
      'unknown_skill', 'command_not_found', 'file_not_found', 'permission_denied',
      'timeout', 'cancelled', 'validation_error', 'rate_limited',
      'service_unavailable', 'network_error', 'other'
    );

-- 2026-07-04 运维合成探针；完整固定指纹，禁止按 tool 名宽删。
DELETE FROM agent_audit
 WHERE id = 1
   AND user_id = 1
   AND session_id = 'smoke-session'
   AND tool = 'SmokeFailTool'
   AND input_meta->>'event_id' = 'smoke-toolfail-20260704T035926Z-17624'
   AND input_hash = '3f48d11458e37cd22c904295e44cb2e10fec3d19095046a0c9197efb3c5286c7'
   AND output_hash = '5a7b95680e4927822f251565ff1da4ea64c62a49f19a0177984ceeb5a741f17d'
   AND duration_ms = 7
   AND success = FALSE
   AND created_at = TIMESTAMPTZ '2026-07-04 03:59:27.74854+00';

-- ── 2. admin_audit 旧格式规范化（append-only 规则受控窗口）────────────
LOCK TABLE admin_audit IN ACCESS EXCLUSIVE MODE;
DROP RULE IF EXISTS aa_admin_no_update ON admin_audit;
DROP RULE IF EXISTS aa_admin_no_delete ON admin_audit;

UPDATE admin_audit
   SET target = 'feedback:' || target
 WHERE action = 'feedback.ack'
   AND target ~ '^[1-9][0-9]*$';

UPDATE admin_audit
   SET after = '{"removed":true}'::jsonb
 WHERE action = 'compute_host.remove'
   AND before IS NULL
   AND after IS NULL;

CREATE RULE aa_admin_no_update AS ON UPDATE TO admin_audit DO INSTEAD NOTHING;
CREATE RULE aa_admin_no_delete AS ON DELETE TO admin_audit DO INSTEAD NOTHING;

DO $$
BEGIN
  IF (
    SELECT COUNT(*)
      FROM pg_rewrite
     WHERE ev_class = 'admin_audit'::regclass
       AND rulename IN ('aa_admin_no_update', 'aa_admin_no_delete')
  ) <> 2 THEN
    RAISE EXCEPTION '0149: admin_audit append-only rules were not restored';
  END IF;
END
$$;

-- ── 3. compute host 审计去启动噪声 ────────────────────────────────────
DELETE FROM compute_host_audit WHERE operation = 'pool.init.done';

-- 只删 self host 上“紧邻、同 imageId、均来自 pool.init.self”的后一个条目。
-- 窗口覆盖该 host 的所有剩余 audit 行，所以任何真实操作都会切断重复 run。
WITH ordered AS (
  SELECT a.id,
         a.operation,
         a.detail,
         LAG(a.operation) OVER (PARTITION BY a.host_id ORDER BY a.ts, a.id) AS previous_operation,
         LAG(a.detail) OVER (PARTITION BY a.host_id ORDER BY a.ts, a.id) AS previous_detail
    FROM compute_host_audit a
    JOIN compute_hosts h ON h.id = a.host_id
   WHERE h.name = 'self'
), redundant AS (
  SELECT id
    FROM ordered
   WHERE operation = 'image.loaded'
     AND detail->>'source' = 'pool.init.self'
     AND NULLIF(detail->>'imageId', '') IS NOT NULL
     AND previous_operation = 'image.loaded'
     AND previous_detail->>'source' = 'pool.init.self'
     AND previous_detail->>'imageId' = detail->>'imageId'
)
DELETE FROM compute_host_audit a
 USING redundant r
 WHERE a.id = r.id;
