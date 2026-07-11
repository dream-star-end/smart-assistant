-- 0129_audit_overhaul — 审计体系整改批:语义三分层 + 存量搬运 + 索引对齐。
--
-- 背景(2026-07-11 全面评审):一张"审计"皮下混了三类东西——
--   * admin_audit 79% 是网关自动写入的 blocked_route_bypass 安全事件(1301/1657),
--     人类管理员操作留痕被系统噪音刷屏;
--   * compute_host_audit 84% 是每 5 分钟一次的 health.snapshot 心跳 + promote 空转
--     tick(14.1 万行 / 122MB),遥测混进审计表无界增长。
-- 本迁移做三分层的存储面:操作审计(admin_audit,永久)/ 安全事件(security_events,
-- 新表,有 retention)/ 运维遥测(退出审计表——快照态在 compute_hosts 行上,代码侧
-- 只审计 transition/promote 实际动作)。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0128 惯例);migration
--   runner 自带 BEGIN/COMMIT + schema_migrations 记账,本文件不写事务控制。
--   本迁移会 DELETE compute_host_audit 存量心跳行(≈14 万行)——一次性,数据无审计
--   价值(纯周期遥测,快照态已在 compute_hosts 列上),回收 ≈120MB。
--   ⚠ 在线切换尾扫(Codex R1 MAJOR#1):apply 到 master 重启换新 binary 之间的窗口,
--   旧代码仍会写 blocked_route_bypass / credits.adjust 旧格式行;部署完成后必须跑一次
--   scripts/v5-audit-backfill-sweep.sql(同语义幂等尾扫)收残行。

-- ── 1. security_events:系统安全事件流 ─────────────────────────────────
-- actor_user_id 不加 FK:安全事件的触发者可能是已删除用户/未认证请求,事件作为
-- 历史信号独立留存(与 marketplace_skill_usage_events 的 slug 同理)。
-- 保留策略:180 天,由 auditRetentionSweeper 统一裁剪(见 admin/auditRetention.ts)。
CREATE TABLE IF NOT EXISTS security_events (
  id            BIGSERIAL   PRIMARY KEY,
  -- 类型注册在 admin/securityEvents.ts SECURITY_EVENT_TYPES(与 auditActions 同治理)
  type          TEXT        NOT NULL,
  actor_user_id BIGINT,
  target        TEXT,
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip            INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- keyset 分页按 id;type 过滤 + id 倒序是唯一查询形态。created_at 单列给 retention 删除。
CREATE INDEX IF NOT EXISTS idx_se_type_id ON security_events(type, id DESC);
CREATE INDEX IF NOT EXISTS idx_se_created ON security_events(created_at);

-- ── 2. admin_audit 存量整形(需要临时拆 append-only RULE)───────────────
-- aa_admin_no_update/no_delete 会把 UPDATE/DELETE 静默吞掉(DO INSTEAD NOTHING),
-- 先 DROP 再操作,结尾原样重建。本窗口内的两个改动都是"迁移即记录"的受控整形:
--   (a) blocked_route_bypass 整体搬到 security_events(它从来不是管理员操作);
--   (b) credits.adjust → user.credits.adjust(action 枚举化统一命名,与
--       org.credits.adjust 对称;语义/内容不变,只改标签)。
DROP RULE IF EXISTS aa_admin_no_update ON admin_audit;
DROP RULE IF EXISTS aa_admin_no_delete ON admin_audit;

INSERT INTO security_events(type, actor_user_id, target, detail, ip, user_agent, created_at)
SELECT 'route_bypass',
       admin_id,
       target,
       COALESCE(after, '{}'::jsonb),
       ip,
       user_agent,
       created_at
  FROM admin_audit
 WHERE action = 'blocked_route_bypass';

DELETE FROM admin_audit WHERE action = 'blocked_route_bypass';

UPDATE admin_audit SET action = 'user.credits.adjust' WHERE action = 'credits.adjust';

CREATE RULE aa_admin_no_update AS ON UPDATE TO admin_audit DO INSTEAD NOTHING;
CREATE RULE aa_admin_no_delete AS ON DELETE TO admin_audit DO INSTEAD NOTHING;

-- ── 3. compute_host_audit 存量遥测清理 ─────────────────────────────────
-- health.snapshot(11.9 万行)/ image.promote.tick(2.1 万行)是周期遥测非审计;
-- 代码侧同批停写(queries.ts 不再每快照写行;imagePromote 只在实际变更时写
-- image.promote.apply)。health.transition / quarantine.* / image.loaded 等真实
-- 状态迁移行保留。
DELETE FROM compute_host_audit WHERE operation IN ('health.snapshot', 'image.promote.tick');

-- ── 4. 索引对齐 ────────────────────────────────────────────────────────
-- 评审发现的错配:list 查询 ORDER BY id DESC + keyset id<before,而旧复合索引尾列
-- 是 created_at;action 过滤是前缀 LIKE,普通 btree 服务不了 pattern 匹配。
-- admin_audit 行数小(整形后 ~350),这是随枚举化顺手做的卫生项,不是性能急救。
DROP INDEX IF EXISTS idx_aa_admin_admin_time;
DROP INDEX IF EXISTS idx_aa_admin_action_time;
CREATE INDEX IF NOT EXISTS idx_aa_admin_admin_id ON admin_audit(admin_id, id DESC);
-- text_pattern_ops:服务 action LIKE 'prefix%'(listAdminAudit 已从 ILIKE 改 LIKE,
-- action 枚举全小写,入参先 toLowerCase)。
CREATE INDEX IF NOT EXISTS idx_aa_admin_action_pattern ON admin_audit(action text_pattern_ops);
-- target 精确过滤(展示面新增);部分索引跳过 NULL。
CREATE INDEX IF NOT EXISTS idx_aa_admin_target ON admin_audit(target, id DESC) WHERE target IS NOT NULL;
-- 时间范围过滤(展示面新增)。admin_audit 永久保留,不用于 retention。
CREATE INDEX IF NOT EXISTS idx_aa_admin_created ON admin_audit(created_at);

-- agent_audit:retention 删除按 created_at 扫——已有 (user_id,created_at)/(tool,created_at)
-- 复合索引都带前导列,加单列索引给 sweeper。
CREATE INDEX IF NOT EXISTS idx_aa_agent_created ON agent_audit(created_at);
