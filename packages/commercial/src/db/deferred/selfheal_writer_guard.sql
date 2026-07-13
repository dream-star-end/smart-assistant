-- ═══════════════════════════════════════════════════════════════════════
-- DEFERRED — v5 自愈体系(M1):admin_alert_rule_state 单写权威 DB 强制
-- ═══════════════════════════════════════════════════════════════════════
-- ⚠️⚠️ apply 双重门(R2 HIGH1)—— 本文件**只进仓,不随 0135 一起 apply**:
--   门① 新 master 已上线:write_alert_condition 0135 版(函数体带
--        set_config('oc.selfheal_condition_writer',…) 写者标记)已在生产生效;
--   门② 回滚池核对通过:hotcfg 回滚候选(deploy-v5.sh --rollback 的最近 N 个
--        release)**全部 ≥ selfheal 合并点**——不存在任何"直写检测列的旧 master"
--        还可能被回滚拉起。旧 master 直写会被本 trigger 拒绝 → 全告警链熔断。
--   两门都过后再复制回 migrations/，使用当时下一个可用版本号；在此之前登记
--   playbook §5 债表(触发条件=
--   回滚池核对通过)。requiredMigrations 在它用新版本 apply 之后的下一版 release
--   metadata 才登记(先登记会挡部署)。
--
-- 语义(反向白名单,R3 HIGH2):
--   - GUC oc.selfheal_condition_writer='1'(仅 write_alert_condition 函数体内设置)
--     → 放行(function 上下文)。
--   - 否则 UPDATE:除 operator 白名单列(acked/acked_at/acked_by/
--     suppressed_until_clear/suppressed_at/suppressed_by)外,**任何列**(含
--     rule_id 主键、未来新增列)不得直写——新列默认受保护(fail-closed)。
--   - 否则 INSERT:一律拒绝(首插必须经 function)。
-- 幂等:CREATE OR REPLACE + DROP TRIGGER IF EXISTS。

CREATE OR REPLACE FUNCTION guard_alert_condition_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- operator 直写白名单(ack 三列 + suppression 三列)。
  v_operator_cols TEXT[] := ARRAY[
    'acked','acked_at','acked_by',
    'suppressed_until_clear','suppressed_at','suppressed_by'
  ];
BEGIN
  -- function 上下文(write_alert_condition 设置的事务本地 GUC)→ 放行。
  IF current_setting('oc.selfheal_condition_writer', true) = '1' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'admin_alert_rule_state: INSERT must go through write_alert_condition() (selfheal single-writer, 0136)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 反向白名单:剔除 operator 列后 OLD/NEW 必须完全一致(检测列/主键/未来新列都受保护)。
  IF (to_jsonb(OLD) - v_operator_cols) IS DISTINCT FROM (to_jsonb(NEW) - v_operator_cols) THEN
    RAISE EXCEPTION 'admin_alert_rule_state: detection columns are single-writer — use write_alert_condition(); only operator columns (acked*/suppressed_*) may be written directly (0136)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_alert_condition_write ON admin_alert_rule_state;
CREATE TRIGGER trg_guard_alert_condition_write
  BEFORE INSERT OR UPDATE ON admin_alert_rule_state
  FOR EACH ROW EXECUTE FUNCTION guard_alert_condition_write();

COMMENT ON FUNCTION guard_alert_condition_write IS
  'v5 自愈 M1:admin_alert_rule_state 单写权威 OS 级强制。检测列仅 write_alert_condition(GUC 标记)可写;operator 列(acked*/suppressed_*)应用直写。apply 有双重门,见 0136 文件头。';
