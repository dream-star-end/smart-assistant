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

-- 2) usage_records: 在 (user_id, request_id) 维度唯一。
--    为什么不做全局 UNIQUE(request_id):不同用户可能同时用同一 x-request-id
--    (客户端 UUID 冲突概率极低,但恶意客户端可以用对方的 request_id 试探)。
--    如果做全局唯一,一个用户的 replay 检查会用到另一个用户的记录 —— 要么撞约束
--    报错(体验差),要么漏查(debit.ts 的 existing 分支只按 request_id 查时会误返
--    别人的 ledger_id/balance_after 给当前用户,这是 Codex F1 指出的信息泄露)。
--    所有幂等/replay 查询路径都必须同时传 user_id 和 request_id。
ALTER TABLE usage_records ADD CONSTRAINT uniq_ur_user_request UNIQUE (user_id, request_id);

-- 注意:现存重复数据会让 ADD CONSTRAINT 失败。v2 是新部署无历史数据。若部署到含数据的环境:
--   DELETE FROM usage_records a USING usage_records b
--    WHERE a.id > b.id AND a.user_id = b.user_id AND a.request_id = b.request_id;
