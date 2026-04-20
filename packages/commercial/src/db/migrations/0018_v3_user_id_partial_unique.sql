-- 0018_v3_user_id_partial_unique.sql
--
-- 背景:
--   v2 (0005_init_agent.sql) 给 agent_containers.user_id 建了 `agent_containers_user_id_key`
--   UNIQUE CONSTRAINT — v2 模型每用户唯一一行长生命周期容器,user_id 全表唯一是对的。
--
--   v3 (0012_agent_containers_v3.sql) 把表改成 ephemeral 按量容器 + state machine
--   ('active' / 'vanished'),lifecycle 大致是:
--     - provisionV3Container → INSERT (..., state='active')
--     - tickIdleSweep / vanish 路径 → UPDATE state='vanished'(行保留作审计/journal FK)
--     - 同一 user_id 之后再 chat → 再来一次 INSERT state='active'
--   v3 期望「同一 user_id 历史多行 vanished + 当前最多一行 active」,
--   但全表 user_id UNIQUE 直接挡死第二次 INSERT,撞 23505 → bridge close 4503
--   "provisioning" → 前端永久 "已断线/排队中"。
--
--   现场证据:生产 oc-v3-u1 容器消失后(GCP 节点重启?docker GC?),DB 留 user_id=1 +
--   state='vanished' 一行;boss 再发消息,provisionV3Container 撞 unique 失败,
--   webchat 完全瘫。
--
-- 修法:
--   - DROP 老的 全表 user_id UNIQUE 约束(v2 leftover, v3 语义不对)
--   - 用 partial unique index `WHERE state='active'` 替代 — 保住「同一 user_id 同时
--     最多一个 active 容器」这条 v3 真正想要的不变量,同时允许多行 vanished 历史
--   - 与 0012 已建的 `uniq_ac_bound_ip_active` 风格对齐(同样 partial WHERE state='active')
--
-- v2 admin 影响:
--   v2 admin 列表查询不依赖此约束,只是 SELECT。约束删了不影响 admin 视图。
--
-- Reversibility:
--   理论可逆 (`ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (user_id)`),前提是表里不存在
--   同 user_id 多行 — 一旦 v3 路径跑过 vanish-reprovision 循环就有重复 user_id,
--   想回 v2 全表 unique 必须先清理掉 vanished 历史。**当作单向门处理**(同 0017 风格)。

ALTER TABLE agent_containers
  DROP CONSTRAINT IF EXISTS agent_containers_user_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ac_user_id_active
  ON agent_containers(user_id)
  WHERE state = 'active';
