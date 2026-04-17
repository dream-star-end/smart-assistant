-- 0009 chat idempotency
-- 问题:ensureRequestId() 允许客户端透传 x-request-id。客户端 retry/replay 时,
-- 同一 request_id 会让 debitChatSuccess 跑两次 —— FOR UPDATE 只保证同用户串行,
-- 不保证幂等,导致重复扣费 + 重复流水 + 重复 usage_records。
--
-- 修复:在库层加 request 级唯一约束,让重复 INSERT 撞 23505,应用层 catch 后
-- 回读原记录,幂等返回。
--
-- 为什么用 PARTIAL UNIQUE INDEX 而不是 UNIQUE CONSTRAINT on (ref_type, ref_id):
--   ref_type='topup' / 'admin_adjust' / 'refund' 等路径可能根本不填 ref_id,
--   ledger_id 为 NULL 或同 admin 操作 batch 写多条也合理。幂等约束只覆盖
--   chat / agent_chat 两种请求写流水的情况。
--
-- usage_records.request_id 按每次请求必 UNIQUE,所有 mode 都强制单条。

-- 1) credit_ledger: 请求维度的幂等索引。只对 reason IN ('chat','agent_chat')
--    且 ref_type='request' 的记录做唯一化;这是 debitChatSuccess 写入的唯一形态。
CREATE UNIQUE INDEX uniq_cl_request_chat
  ON credit_ledger(user_id, ref_type, ref_id)
  WHERE reason IN ('chat', 'agent_chat') AND ref_type = 'request' AND ref_id IS NOT NULL;

-- 2) usage_records: 全局 request_id 唯一(success / billing_failed / error 任何状态都只能有一条)
ALTER TABLE usage_records ADD CONSTRAINT uniq_ur_request UNIQUE (request_id);

-- 注意:现存重复数据会让 ADD CONSTRAINT 失败。生产首次部署前需清理 —— 但 v2 是
-- 新部署,没有历史数据,直接加约束即可。如果部署到含数据的环境,需要先 dedup:
--   DELETE FROM usage_records a USING usage_records b
--    WHERE a.id > b.id AND a.request_id = b.request_id;
