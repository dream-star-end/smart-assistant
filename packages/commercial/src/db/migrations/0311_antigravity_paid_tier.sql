-- OCV5-516: server-observed paidTier and per-model availability/quota.
-- No credentials; nullable until the first normal background metadata refresh.
ALTER TABLE gemini_oauth_accounts ADD COLUMN paid_tier TEXT CHECK (paid_tier IS NULL OR char_length(paid_tier) BETWEEN 1 AND 120);
ALTER TABLE gemini_oauth_accounts ADD COLUMN tier_updated_at TIMESTAMPTZ;
ALTER TABLE gemini_oauth_accounts ADD COLUMN available_models JSONB CHECK (available_models IS NULL OR jsonb_typeof(available_models) = 'object');
