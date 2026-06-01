-- 0077_minimax_m3_and_media_billing.sql
-- MiniMax Token Plan 接入：MiniMax-M3 文本路由 + 多模态媒体计费审计。
--
-- 价格口径：boss 2026-06-02 指定“按原价算”，并给的是中文 MiniMax 按量计费页
-- https://platform.minimaxi.com/docs/guides/pricing-paygo 。该页单位是人民币：
--   MiniMax-M3 标准档(<=512k input tokens) 原价 input ¥4.20/M、output ¥16.80/M、
--   cache read ¥0.84/M；7 天限时五折不采用。>512k 档“限时限量/联系销售”，
--   平台代码不开放该档。
--
-- model_pricing 单位沿 0007/0057：人民币“分”/Mtok，multiplier=1.000 表示按原价。

INSERT INTO model_pricing (
  model_id, display_name,
  input_per_mtok, output_per_mtok,
  cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, visibility
) VALUES (
  'MiniMax-M3', 'MiniMax M3 (512k)',
  420, 1680, 84, 0,
  1.000, TRUE, 130, 'admin'
)
ON CONFLICT (model_id) DO UPDATE
   SET display_name          = EXCLUDED.display_name,
       input_per_mtok        = EXCLUDED.input_per_mtok,
       output_per_mtok       = EXCLUDED.output_per_mtok,
       cache_read_per_mtok   = EXCLUDED.cache_read_per_mtok,
       cache_write_per_mtok  = EXCLUDED.cache_write_per_mtok,
       multiplier            = EXCLUDED.multiplier,
       enabled               = TRUE,
       sort_order            = EXCLUDED.sort_order,
       visibility            = EXCLUDED.visibility,
       updated_at            = NOW();

-- 扩展 credit_ledger.reason 白名单，给 MiniMax 媒体(语音/视频/图像/音乐/歌词)
-- 统一记账。约束名在 PG 默认会是 credit_ledger_reason_check；这里动态查找，避免
-- 环境中约束名因历史 restore/drift 不一致导致 migration 失败。
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
    FROM pg_constraint
   WHERE conrelid = 'credit_ledger'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%reason IN%'
   LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE credit_ledger DROP CONSTRAINT %I', constraint_name);
  END IF;

  ALTER TABLE credit_ledger
    ADD CONSTRAINT credit_ledger_reason_check
    CHECK (reason IN (
      'topup','chat','agent_chat','agent_subscription',
      'refund','admin_adjust','promotion','minimax_media'
    ));
END $$;

-- MiniMax 媒体调用审计表。与 usage_records 分开：媒体不是 token SSE,没有四维 token
-- usage；但仍需要 per-request 幂等、价格快照、上游 trace/task/file id、输出文件元信息。
CREATE TABLE IF NOT EXISTS minimax_media_usage_records (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  container_id   BIGINT REFERENCES agent_containers(id) ON DELETE SET NULL,
  request_id     TEXT NOT NULL,
  operation      TEXT NOT NULL CHECK (operation IN (
                   'image','speech','voice_design','voice_clone',
                   'video','music','lyrics'
                 )),
  model          TEXT NOT NULL,
  units          JSONB NOT NULL,
  price_snapshot JSONB NOT NULL,
  cost_credits   BIGINT NOT NULL,
  ledger_id      BIGINT REFERENCES credit_ledger(id),
  upstream_trace_id TEXT,
  upstream_task_id  TEXT,
  upstream_file_id  TEXT,
  output_meta    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL CHECK (status IN ('success','billing_failed','error')),
  error_msg      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_mmur_user_time
  ON minimax_media_usage_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mmur_container_time
  ON minimax_media_usage_records(container_id, created_at DESC)
  WHERE container_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mmur_operation_time
  ON minimax_media_usage_records(operation, created_at DESC);
