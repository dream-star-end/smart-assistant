-- 0154 — model catalog admin 角色补 admin_audit RETURNING 所需的列级 SELECT。
--
-- 事故(2026-07-16 巡检):admin API 的 catalog switch 全量 500。writeAdminAudit 的
-- `INSERT ... RETURNING id` 在 PostgreSQL 里除 INSERT 外还需要被 RETURNING 的列的
-- SELECT 权限;0144 的 fn_model_authority_grant_admin_role 只授了 INSERT + sequence,
-- 缺 `SELECT (id)` → openclaude_model_admin 在审计写入处 permission denied,业务事务
-- 一并回滚(审计红线语义正确,但入口等于废掉)。
--
-- 修法(最小权限):列级 `GRANT SELECT (id)`,不开放整表读(审计正文对该窄角色不可见)。
-- 同时修函数本体,让未来重跑/新环境一次到位;生产 kl-mirror 已手工授权(2026-07-16),
-- 本迁移对其幂等。

CREATE OR REPLACE FUNCTION fn_model_authority_grant_admin_role(p_role TEXT) RETURNS VOID
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM fn_model_authority_grant_app_role(p_role);
  EXECUTE format('GRANT SELECT ON TABLE model_pricing, model_authority_deploy_state TO %I', p_role);
  EXECUTE format('GRANT INSERT ON TABLE admin_audit TO %I', p_role);
  -- RETURNING id 需要列级 SELECT(0154;整表 SELECT 故意不给 —— 该角色不许读审计正文)。
  EXECUTE format('GRANT SELECT (id) ON admin_audit TO %I', p_role);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE admin_audit_id_seq TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_stage_version(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, INTEGER, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_switch_version(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, INTEGER, BIGINT, INTEGER) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_activate(TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_disable(TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_activate_entry(BIGINT, INTEGER, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_disable_entry(BIGINT, INTEGER, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_retire_entry(BIGINT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_drop_staged(TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_alias_set(TEXT, TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_alias_remove(TEXT) TO %I', p_role);
END $$;

REVOKE ALL ON FUNCTION fn_model_authority_grant_admin_role(TEXT) FROM PUBLIC;

-- 已存在的 admin 角色就地补授权(角色名是安装期约定;不存在则跳过,新环境由
-- 安装 runbook 统一执行 grant 函数)。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaude_model_admin') THEN
    PERFORM fn_model_authority_grant_admin_role('openclaude_model_admin');
  END IF;
END $$;
