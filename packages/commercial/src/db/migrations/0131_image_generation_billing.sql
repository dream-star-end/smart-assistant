-- Fixed-price GPT Image billing. One successful output = 50 credits.
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_reason_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check CHECK (reason IN (
  'topup','chat','agent_chat','agent_subscription','refund','admin_adjust','promotion',
  'minimax_media','image_generation','subscription','subscription_expire','pack'
)) NOT VALID;
ALTER TABLE credit_ledger VALIDATE CONSTRAINT credit_ledger_reason_check;

CREATE TABLE IF NOT EXISTS image_generation_usage_records (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  container_id BIGINT REFERENCES agent_containers(id) ON DELETE SET NULL,
  request_id VARCHAR(128) NOT NULL,
  job_id VARCHAR(64),
  operation VARCHAR(24) NOT NULL CHECK (operation IN ('generation','edit','annotated_edit')),
  model VARCHAR(80) NOT NULL DEFAULT 'gpt-image-2',
  image_count INTEGER NOT NULL DEFAULT 1 CHECK (image_count = 1),
  unit_cost BIGINT NOT NULL DEFAULT 50 CHECK (unit_cost = 50),
  cost_credits BIGINT NOT NULL DEFAULT 50 CHECK (cost_credits = 50),
  status VARCHAR(24) NOT NULL CHECK (status IN ('reserved','success','failed')),
  ledger_id BIGINT REFERENCES credit_ledger(id) ON DELETE SET NULL,
  response_body BYTEA,
  response_content_type VARCHAR(120),
  response_expires_at TIMESTAMPTZ,
  input_hash BYTEA CHECK (input_hash IS NULL OR octet_length(input_hash) = 32),
  error_code VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, request_id),
  UNIQUE (job_id)
);
ALTER TABLE image_generation_usage_records ADD COLUMN IF NOT EXISTS input_hash BYTEA;
ALTER TABLE image_generation_usage_records
  DROP CONSTRAINT IF EXISTS image_generation_usage_records_input_hash_check;
ALTER TABLE image_generation_usage_records
  ADD CONSTRAINT image_generation_usage_records_input_hash_check
  CHECK (input_hash IS NULL OR octet_length(input_hash) = 32);
CREATE INDEX IF NOT EXISTS idx_image_usage_user_time ON image_generation_usage_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_usage_daily_success ON image_generation_usage_records(user_id, completed_at) WHERE status = 'success';
CREATE INDEX IF NOT EXISTS idx_image_usage_response_expiry ON image_generation_usage_records(response_expires_at)
  WHERE response_body IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_image_usage_one_inflight ON image_generation_usage_records(user_id)
  WHERE status = 'reserved';
