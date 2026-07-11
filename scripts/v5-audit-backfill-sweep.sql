-- v5-audit-backfill-sweep.sql — 0129 审计整改的部署后尾扫(Codex R1 MAJOR#1)。
--
-- 为什么需要:v5 SOP 是"迁移先于新代码 apply"。0129 提交后、master 重启换新
-- binary 前的窗口里,旧代码仍会往 admin_audit 写旧格式行:
--   * blocked_route_bypass(应在 security_events)
--   * credits.adjust(应更名 user.credits.adjust)
-- schema_migrations 已记账,0129 不会重跑 → 这些残行会永久滞留。本脚本与 0129
-- §2 同语义、幂等(无残行时是 no-op),在 master 重启完成后执行一次即可。
--
-- 用法(deploy 完成后):
--   ssh kl-mirror 'DBURL=$(grep ^DATABASE_URL= /etc/openclaude/commercial-v5.env | cut -d= -f2-); \
--     psql "$DBURL" -v ON_ERROR_STOP=1 -f /tmp/v5-audit-backfill-sweep.sql'
-- (先 scp 本文件到目标机 /tmp。)

BEGIN;

DROP RULE IF EXISTS aa_admin_no_update ON admin_audit;
DROP RULE IF EXISTS aa_admin_no_delete ON admin_audit;

INSERT INTO security_events(type, actor_user_id, target, detail, ip, user_agent, created_at)
SELECT 'route_bypass', admin_id, target, COALESCE(after, '{}'::jsonb), ip, user_agent, created_at
  FROM admin_audit
 WHERE action = 'blocked_route_bypass';

DELETE FROM admin_audit WHERE action = 'blocked_route_bypass';

UPDATE admin_audit SET action = 'user.credits.adjust' WHERE action = 'credits.adjust';

CREATE RULE aa_admin_no_update AS ON UPDATE TO admin_audit DO INSTEAD NOTHING;
CREATE RULE aa_admin_no_delete AS ON DELETE TO admin_audit DO INSTEAD NOTHING;

COMMIT;
