-- 0106_model_capacity.sql
-- 运维页容量面(0105 增补,2026-07-06):
-- 1) provider_ops.concurrency_limit —— 服务商并发上限(订阅规格手填,如火山 Plan 的并发配额;
--    仅展示/利用率计算用,不做请求期强制 —— 扩容依据语义,非限流器)。
-- 2) usage_records 补 (model, created_at) 索引:运维页 24h/7d per-model 用量聚合走它
--    (原索引只有 (user_id, created_at),按模型聚合会全扫 7 天窗)。

ALTER TABLE provider_ops
  ADD COLUMN concurrency_limit INTEGER CHECK (concurrency_limit > 0);

CREATE INDEX idx_ur_model_time ON usage_records (model, created_at DESC);
