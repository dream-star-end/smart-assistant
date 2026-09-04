-- no-transaction
-- 0266_drop_user_channel_active.sql
-- P1 桌面虚拟容器底座:drop 旧 uniq_ac_user_channel_active,让唯一性改由 0255 的
-- uniq_ac_user_channel_kind_active (user_id, runtime_channel, runtime_kind) WHERE active
-- 接管 → 同一 user 同 channel 可同时各有 1 个 docker active + 1 个 desktop active。
--
-- ⚠️ `-- no-transaction`:DROP INDEX CONCURRENTLY 不能在事务块内。
-- 本文件含 (a) 0091 式 preflight 断言 0255 索引 indisvalid,(b) DROP CONCURRENTLY。
-- migrate.ts 对 no-transaction 文件逐条裸执行,使 CONCURRENTLY 不与 DO 块同进隐式事务。
--
-- 【应用时机】= §2.6 全树 kind 过滤已部署之后(本分支 C2 同列车落地;本段无 desktop writer,
-- 即使提前 drop,现网也无法插入 desktop 行)。DR=0。
-- 回滚:重建 `CREATE UNIQUE INDEX CONCURRENTLY uniq_ac_user_channel_active
--       ON agent_containers(user_id, runtime_channel) WHERE state='active'`。
-- 幂等:IF EXISTS。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'uniq_ac_user_channel_kind_active'
       AND i.indisvalid
  ) THEN
    RAISE EXCEPTION '0256 preflight 失败:uniq_ac_user_channel_kind_active 缺失或 invalid —— 0255 必须先成功(否则 drop 旧索引后同 user 同 channel 双 kind 唯一性失守)。';
  END IF;
END $$;

DROP INDEX CONCURRENTLY IF EXISTS uniq_ac_user_channel_active;
