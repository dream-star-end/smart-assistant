-- no-transaction
-- 0091_agent_containers_runtime_channel_check.sql
-- P1d 加固(Codex 审计 重要#5 + 建议):
--   (a) preflight 断言 0089 的复合唯一索引 uniq_ac_user_channel_active 存在且 indisvalid。
--       —— 防"0089 CONCURRENTLY 失败留下 invalid 索引、0090 又 drop 了旧唯一索引"导致
--          同 user 同 channel 出现两条 active 的窗口。新环境若 0089 未真正生效,这里 fail loud。
--   (b) 给 runtime_channel 加 CHECK IN ('v3','v5') —— 防手工 SQL / 旧代码写出第三种 channel
--       值(代码侧 getRuntimeChannel() 已 fail-closed 校验,这是 DB 层兜底)。
--
-- 零影响模式:CHECK 用 NOT VALID 加(仅元数据级短锁,不全表扫)+ 单独 VALIDATE
-- (SHARE UPDATE EXCLUSIVE 锁,不阻塞 v3 读写,只与其它 DDL 互斥)。生产 ~2103 行,VALIDATE 亚秒级。
-- 幂等:约束/索引检查都用 IF (NOT) EXISTS;VALIDATE 对已 valid 约束是 no-op。

DO $$
BEGIN
  -- (a) preflight
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'uniq_ac_user_channel_active'
       AND i.indisvalid
  ) THEN
    RAISE EXCEPTION '0091 preflight 失败:uniq_ac_user_channel_active 缺失或 invalid —— 0089 必须先成功(否则同 user 同 channel 唯一性失守)。';
  END IF;

  -- (b) 幂等加 CHECK(NOT VALID,不阻塞)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_containers_runtime_channel_check'
  ) THEN
    ALTER TABLE agent_containers
      ADD CONSTRAINT agent_containers_runtime_channel_check
      CHECK (runtime_channel IN ('v3', 'v5')) NOT VALID;
  END IF;
END $$;

-- VALIDATE 在 DO 块外单独跑(SHARE UPDATE EXCLUSIVE,不阻塞 DML);对已 valid 约束 no-op。
ALTER TABLE agent_containers VALIDATE CONSTRAINT agent_containers_runtime_channel_check;
