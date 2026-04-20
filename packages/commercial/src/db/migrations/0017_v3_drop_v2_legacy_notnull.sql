-- 0017_v3_drop_v2_legacy_notnull.sql
--
-- 背景:
--   v2 (0005_init_agent.sql) 把 docker_name / workspace_volume / home_volume / image
--   都加成 NOT NULL — v2 模型每用户长期订阅容器,这些字段必填且语义清晰。
--
--   v3 (0012_agent_containers_v3.sql) 把 agent_containers 改造成 ephemeral 按量容器后,
--   provisionV3Container 只 INSERT (user_id, bound_ip, secret_hash, state, port, last_ws_activity)
--   —— 上述 4 个 v2 字段在 v3 路径下完全不写。运行时直接撞 23502 NOT NULL 违反,
--   bridge 端表现为 close 4503 reason="provisioning",前端永远在等"provisioning..."。
--
-- 为什么 drop NOT NULL 而不是改 supervisor 去填:
--   - 这些字段在 v3 ephemeral 模型里语义不存在(volume name 是 oc-v3-uX,容器名同理,
--     image 字段语义被 OC_RUNTIME_IMAGE env 取代),硬填 synthetic 值只会污染 admin 视图;
--   - v2 admin 查询(/api/admin/agent-containers v2 列表)继续可读,值变 NULL,UI 自行兜底
--     (或后续清理掉 v2 admin 入口 — Phase 5 计划项)。
--
-- v2 admin 操作端点(restart/stop/remove)对 v3 行(docker_name=NULL)会抛
-- V3RowNotSupportedError(见 admin/containers.ts lookupContainer),前端 admin UI
-- 拿到 400 + 文案"agent_container X is a v3 row"。Phase 5 上 v3 admin dispatch 之前
-- 是预期行为,不是回归。
--
-- Reversibility:DROP NOT NULL 本身可逆 (`ALTER ... SET NOT NULL`),但前提是表里
-- 没有真的 NULL。生产路径 v3 INSERT 会写 NULL,所以一旦上线就实际不可逆,得先
-- backfill / 删 v3 行 才能回滚到 v2 only 的 schema。**当作单向门处理**。
--
-- 注:0012 已经把 subscription_id 从 NOT NULL 放开。本迁移补完剩下 4 个。
ALTER TABLE agent_containers
  ALTER COLUMN docker_name DROP NOT NULL,
  ALTER COLUMN workspace_volume DROP NOT NULL,
  ALTER COLUMN home_volume DROP NOT NULL,
  ALTER COLUMN image DROP NOT NULL;
