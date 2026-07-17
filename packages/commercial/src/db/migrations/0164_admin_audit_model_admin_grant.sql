-- 0164 — model catalog admin 角色重新对齐 admin_audit 授权(止血批 A · A1)。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 事故(2026-07-16 起):/api/admin/model-catalog 的 POST 全部 500,
--   `permission denied for table admin_audit`。
--
-- 路径:admin/modelCatalogOps.ts 在 getModelCatalogAdminPool()(= openclaude_model_admin
--   角色,MODEL_CATALOG_ADMIN_DATABASE_URL)的事务内调 writeAdminAudit(admin/audit.ts),
--   该 action 注册为 mode='tx' → **审计写失败=业务回滚(fail-closed)**。
--   writeAdminAudit 执行的是 `INSERT INTO admin_audit(...) RETURNING id::text`,在
--   PostgreSQL 下需要 **三项** 权限,缺一即拒:
--     ① INSERT ON admin_audit                       —— 写入;
--     ② 列级 SELECT (id) ON admin_audit             —— RETURNING id 读回(易漏!);
--     ③ USAGE, SELECT ON SEQUENCE admin_audit_id_seq —— BIGSERIAL 默认值取号。
--
-- 权威源:这三项授权的**单一权威**是 fn_model_authority_grant_admin_role(p_role)
--   —— 0144 授 ① INSERT + ③ sequence;0154 补 ② 列级 SELECT (id)(RETURNING 的坑)。
--   两处都只经各自迁移尾部的 DO 块「role 存在则 PERFORM」落地。
--
-- 根因:openclaude_model_admin 的**实际授权与当前(0154 后)grant 函数漂移**。典型成因:
--   割接(CREATE ROLE openclaude_model_admin + 指 MODEL_CATALOG_ADMIN_DATABASE_URL,见
--   0144 文件尾 runbook)发生在 0154 apply **之后** → 0154 的 DO 块当时 role 不存在、空跑;
--   或割接时执行的是 0154 **之前**版本的 grant 函数(缺列级 SELECT (id))→ RETURNING id 被拒。
--   无论哪条路径,现网 role 都缺 ② 列级 SELECT (id),RETURNING 必挂。
--
-- 修法(根治 · 单一权威):role 存在时**重跑权威 grant 函数**,把角色权限重新对齐到当前
--   函数定义(此时函数已是 0154 后版本,天然含 ①②③)。
--     · 幂等:已授权 → 全 no-op;缺失 → 补齐(含 RETURNING 所需的列级 SELECT (id))。
--     · 自愈:随 grant 函数演进,不会再因「新增授权忘了补现网 role」复发(消除一整类漂移)。
--   **不写独立窄授权**(仅 GRANT INSERT + seq)的理由:
--     (a) admin_audit 授权集的权威在 grant 函数里,另起一份 = 第二套并行机制,函数一变即漂移
--         —— 那正是本次事故的同类根因;
--     (b) 窄授权若按「RETURNING 不需额外 SELECT」的直觉只给 INSERT + seq,反而修不好 ②
--         —— 而 ① INSERT + ③ seq 本就已被 0144 授过,真正缺的恰是 ② 列级 SELECT (id)。
--   role 不存在(尚未割接)→ DO 块空跑(同 0154 惯例);割接 runbook 负责建角色并首次授权。
--
-- 迁移语义:纯授权(additive / 幂等),不改表数据、不改任何 trigger/函数定义。
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0104-0163 惯例)。
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaude_model_admin') THEN
    -- 单一权威:重跑 = 把 role 对齐到 fn_model_authority_grant_admin_role 的当前定义
    -- (0154 后含 admin_audit 的 INSERT + 列级 SELECT(id) + 序列 USAGE)。全部 GRANT 幂等。
    PERFORM fn_model_authority_grant_admin_role('openclaude_model_admin');
  END IF;
END $$;
