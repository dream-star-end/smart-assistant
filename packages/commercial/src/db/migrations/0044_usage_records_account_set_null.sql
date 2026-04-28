-- 0044_usage_records_account_set_null.sql
-- 把 fk_usage_records_account 从 ON DELETE RESTRICT 改成 SET NULL,让 admin
-- "删除账号" 按钮能真删,历史 usage_records 保留 user_id/cost/request_id 等
-- 计费核心字段,account_id 置 NULL = "已删除账号"。
-- 依赖:0004(原 FK)、0002(usage_records.account_id 已 nullable)。
--
-- 锁策略:DROP+ADD 在同事务里会拿 usage_records 的 ACCESS EXCLUSIVE。当前
-- 表行数远小于 1k,validation 成本可接受,不会有显著阻塞窗口。lock_timeout=5s
-- 防极端竞争 — 5s 内拿不到锁就 abort,服务下次重启再 apply。
-- 未来表涨到百万行级别再调本 FK 时,改 NOT VALID + 独立 VALIDATE migration。

SET LOCAL lock_timeout = '5s';

ALTER TABLE usage_records
  DROP CONSTRAINT fk_usage_records_account;

ALTER TABLE usage_records
  ADD CONSTRAINT fk_usage_records_account
  FOREIGN KEY (account_id) REFERENCES claude_accounts(id) ON DELETE SET NULL;
