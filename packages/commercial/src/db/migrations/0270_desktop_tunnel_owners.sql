-- 0270_desktop_tunnel_owners.sql
-- order-dependency: none  (0269_cursor_usd_150_credits 仅存在于未 push 的 canonical worktree;本支从 origin/feat/v5-selfhost 82176f0b8 开、目录最高 0268。合入前若 0269 已进 tip,改回 0269_cursor_usd_150_credits)
--
-- W-05 桌面反向隧道 owner 目录(session affinity + fail-loud)。
-- 缺口 0269 被 feat/v5-selfhost 未推送的 Cursor Sand 150 credits/USD 迁移占号
-- (worktree openclaude-v5-selfhost)。先合并 apply 0269,再合本支。
--
-- Fail-loud:故意省略 IF NOT EXISTS。残留表会让 CREATE 失败,不会被 ledger 记成成功。
-- preflight 在表已存在时 RAISE,给出 runbook,且不会登记 schema_migrations。
--
-- Runbook(残留表):
--   1. DROP TABLE desktop_tunnel_owners;
--   2. 确认 schema_migrations 无 0270_desktop_tunnel_owners 后重跑 migrate。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'desktop_tunnel_owners'
       AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION '0270 fail-loud: desktop_tunnel_owners already exists. Runbook: DROP TABLE desktop_tunnel_owners; confirm schema_migrations has no 0270_desktop_tunnel_owners; re-run migrate. Do not insert into schema_migrations.';
  END IF;
END $$;

CREATE TABLE desktop_tunnel_owners (
  agent_container_id BIGINT PRIMARY KEY REFERENCES agent_containers(id) ON DELETE CASCADE,
  instance_id        TEXT NOT NULL,
  instance_addr      TEXT NOT NULL,
  attached_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generation         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX desktop_tunnel_owners_instance_id
  ON desktop_tunnel_owners (instance_id);

-- 4503 reason desktop_owned_elsewhere 必须能进审计表。inline CHECK 的默认名是
-- desktop_device_audit_event_check(0264 建表时未显式命名)。
ALTER TABLE desktop_device_audit DROP CONSTRAINT desktop_device_audit_event_check;
ALTER TABLE desktop_device_audit ADD CONSTRAINT desktop_device_audit_event_check
  CHECK (event IN (
    'enroll_start','enroll_confirm','enroll_finish','enroll_expire',
    'token_mint','token_refresh','token_revoke','device_revoke',
    'tunnel_up','tunnel_down','desktop_offline','desktop_owned_elsewhere',
    'token_device_mismatch','update_required','killswitch'
  ));
