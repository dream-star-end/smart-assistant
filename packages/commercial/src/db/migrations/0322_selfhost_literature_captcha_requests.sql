-- order-dependency: none  (selfhost copy of commercial 0316_commercial_literature_captcha_requests; additive, independent of 0320/0321)
-- OCV5-524: free plugin inference uses platform request quotas, never user wallet debits.
-- Reservations are counted even if the provider result/usage is unknown. No automatic refunds.
-- Additive: old binaries ignore this table. No service is activated by this migration.
CREATE TABLE literature_captcha_requests (
  request_id UUID PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  operation_key VARCHAR(128) NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9_-]{1,128}$'),
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'google')),
  model VARCHAR(128) NOT NULL CHECK (
    (provider = 'anthropic' AND model ~ '^(anthropic/)?claude-[a-z0-9.-]+$') OR
    (provider = 'google' AND model ~ '^(google/)?gemini-[a-z0-9.-]+$')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IN ('success','refused','invalid','http_error','network_error','cancelled')),
  input_tokens INTEGER CHECK (input_tokens BETWEEN 0 AND 2000000),
  output_tokens INTEGER CHECK (output_tokens BETWEEN 0 AND 2000000),
  cache_read_tokens INTEGER CHECK (cache_read_tokens BETWEEN 0 AND 2000000),
  cache_write_tokens INTEGER CHECK (cache_write_tokens BETWEEN 0 AND 2000000),
  thought_tokens INTEGER CHECK (thought_tokens BETWEEN 0 AND 2000000),
  total_tokens INTEGER CHECK (total_tokens BETWEEN 0 AND 8000000),
  CONSTRAINT literature_captcha_completion CHECK (
    (outcome IS NULL AND finished_at IS NULL AND num_nonnulls(input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, thought_tokens, total_tokens) = 0) OR
    (outcome IS NOT NULL AND finished_at IS NOT NULL AND num_nonnulls(input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, thought_tokens, total_tokens) IN (0,6))
  )
);
CREATE INDEX literature_captcha_created_idx ON literature_captcha_requests(created_at);
CREATE INDEX literature_captcha_user_created_idx ON literature_captcha_requests(user_id, created_at);
CREATE INDEX literature_captcha_operation_idx ON literature_captcha_requests(user_id, operation_key);
COMMENT ON TABLE literature_captcha_requests IS 'Platform expense only; no credentials, images, answers or user wallet charges. Unfinished reservations still consume quota.';
