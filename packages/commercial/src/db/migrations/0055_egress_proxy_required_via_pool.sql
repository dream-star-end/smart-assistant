-- 0055_egress_proxy_required_via_pool.sql
-- 决策(强约束 — boss 拍板):claude_accounts 必须通过 egress_proxies 池 (0052)
-- 引用代理。0010 加的 raw text 列锁死为 NULL。
--
-- 状态约束:
--   egress_proxy IS NULL  AND  egress_proxy_id IS NOT NULL
--
-- 兼容性:raw 列保留(避免破坏存量 backup restore 流程),仅靠 CHECK 强制
-- "必须 NULL"。
--
-- FK 行为变更:0053 的 ON DELETE SET NULL 与本次的 NOT NULL CHECK 互斥
-- (删池条目 → SET NULL → 违反 CHECK → 23514)。改成 ON DELETE RESTRICT,
-- 删被使用的池条目由 admin/egressProxies.deleteEgressProxy 显式预检并报
-- 409 PROXY_IN_USE,要求先把绑定的账号迁到其他池条目。
--
-- 前置条件:数据迁移脚本必须先跑完(scripts/migrate-account-egress-to-pool.ts),
-- 否则下面 DO $$ 块会 RAISE EXCEPTION 阻塞 migration。
-- 这是定意的"双保险":先 defensive guard 阻止半迁移状态,再 ADD CONSTRAINT。
--
-- 执行顺序(同 tx,按依赖):
--   1. guard (RAISE EXCEPTION on bad rows)
--   2. DROP/ADD FK ON DELETE RESTRICT — 把 referential action 调对再上 CHECK
--   3. ADD CHECK chk_account_uses_egress_pool
--
-- 表规模:< 100 row,ADD CONSTRAINT 全表扫无问题。

BEGIN;

DO $$
DECLARE
  bad_count INT;
BEGIN
  SELECT COUNT(*)::int INTO bad_count
  FROM claude_accounts
  WHERE egress_proxy IS NOT NULL OR egress_proxy_id IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      '0055: % rows still violate (egress_proxy IS NULL AND egress_proxy_id IS NOT NULL). '
      'Run scripts/migrate-account-egress-to-pool.ts on the live DB first.', bad_count;
  END IF;
END $$;

-- 0053 用未命名内联 FK,PG 默认名 = claude_accounts_egress_proxy_id_fkey。
-- IF EXISTS:避免 fork/restore 环境名字被手动改过时硬失败。
ALTER TABLE claude_accounts
  DROP CONSTRAINT IF EXISTS claude_accounts_egress_proxy_id_fkey;

ALTER TABLE claude_accounts
  ADD CONSTRAINT claude_accounts_egress_proxy_id_fkey
  FOREIGN KEY (egress_proxy_id) REFERENCES egress_proxies(id)
  ON DELETE RESTRICT;

ALTER TABLE claude_accounts
  ADD CONSTRAINT chk_account_uses_egress_pool
  CHECK (egress_proxy IS NULL AND egress_proxy_id IS NOT NULL);

COMMIT;
