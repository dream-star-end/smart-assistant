-- 0027 — 超管 /users tab R2 专用索引
--
-- R2 Codex 审查 H3:listUsersWithStats 的 topup 子查询
--   SELECT user_id, SUM(delta) FROM credit_ledger
--   WHERE user_id = ANY($1::bigint[]) AND reason = 'topup' AND delta > 0
-- 在 200 个重度用户下:
--   - (user_id, created_at) idx_cl_user_time 先按 user 扫全 ledger 再 filter reason
--   - (reason, created_at) idx_cl_reason 先扫全站 topup 再 filter user_id
-- 两者都不是最优。加 partial index 让它"只看本页用户的 topup 行"。
--
-- 大小控制:只索引 reason='topup' AND delta > 0 的行,比全表索引小 1-2 个数量级。
--
-- 幂等:IF NOT EXISTS。

CREATE INDEX IF NOT EXISTS idx_cl_user_topup
  ON credit_ledger (user_id)
  WHERE reason = 'topup' AND delta > 0;
