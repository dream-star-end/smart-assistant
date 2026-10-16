-- 0307 OCV5-415 P2: official Google Antigravity CLI engine (selfhost).
--
-- Deploy with OC_V5_ALLOW_BREAKING_MIGRATION=1: widening the model_catalog
-- engine CHECK drops and re-adds that one constraint (same pattern as
-- 0207/0208/0227). Nothing else here drops, renames or truncates.
--
-- 1. engine CHECK += 'antigravity'.
-- 2. gemini_oauth_accounts: Google AI subscription accounts (consumer OAuth)
--    for the Antigravity relay. Refresh/access tokens are AES-256-GCM
--    (loadKmsKey, same as claude_accounts.oauth_*_enc) and never leave the
--    master/egress process. State columns mirror the OCV5-424 shared pool
--    policy (status/cooldown_reason/backoff_level/next_probe_at/disabled_by)
--    so the gemini pool can adopt this table without another migration.
-- 3. antigravity_relay_usage: one row per metered upstream generate call,
--    written by the relay from the upstream usageMetadata. Turn settlement
--    sums these rows; the container never reports billable usage.
--    antigravity_turns: durable admission record so settlement does not
--    depend on the admitting bridge's memory.
-- 4. Staged catalog rows + disabled pricing rows. On selfhost Flash is public
--    and the Claude / GPT-OSS models are admin-only. In the commercial tree all
--    four are admin-only (user rule 2026-10-15: models a selfhost sync brings are
--    visible to admins only; commercialSyncedModelsAdminOnly.test.ts). Activation
--    is the normal admin catalog path after deploy (fn_model_catalog_guard: born staged).
-- Rollback: db/rollbacks/0307_antigravity_engine.sql.

DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='model_catalog'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%engine%' AND pg_get_constraintdef(oid) LIKE '%ccb%' LOOP
    EXECUTE format('ALTER TABLE model_catalog DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE model_catalog ADD CONSTRAINT model_catalog_engine_check
    CHECK (engine IN ('ccb','codex','grok','cursor','zcode','antigravity'));
END $$;

CREATE TABLE gemini_oauth_accounts (
  id                   BIGSERIAL PRIMARY KEY,
  label                TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  email                TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  auth_method          TEXT NOT NULL DEFAULT 'consumer' CHECK (auth_method = 'consumer'),
  refresh_token_enc    BYTEA NOT NULL,
  refresh_token_nonce  BYTEA NOT NULL,
  access_token_enc     BYTEA,
  access_token_nonce   BYTEA,
  access_expires_at    TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cooldown','disabled')),
  health_score         INTEGER NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  cooldown_until       TIMESTAMPTZ,
  cooldown_reason      TEXT CHECK (cooldown_reason IS NULL OR cooldown_reason IN ('rate_limited','quota','auth','credential','upstream')),
  backoff_level        SMALLINT NOT NULL DEFAULT 0 CHECK (backoff_level >= 0),
  next_probe_at        TIMESTAMPTZ,
  disabled_by          TEXT CHECK (disabled_by IS NULL OR disabled_by = 'admin'),
  success_count        BIGINT NOT NULL DEFAULT 0,
  fail_count           BIGINT NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_used_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gemini_oauth_accounts_email_unique UNIQUE (email),
  CONSTRAINT gemini_oauth_accounts_access_pair CHECK ((access_token_enc IS NULL) = (access_token_nonce IS NULL)),
  -- IS NOT NULL, not = 'admin': a NULL comparison would make the CHECK pass.
  CONSTRAINT gemini_oauth_accounts_disabled_by_admin CHECK (status <> 'disabled' OR disabled_by IS NOT NULL)
);
CREATE INDEX idx_gemini_oauth_accounts_status ON gemini_oauth_accounts(status, cooldown_until);

COMMENT ON TABLE gemini_oauth_accounts IS
  'OCV5-415 Google AI subscription accounts behind the Antigravity relay. Tokens encrypted with loadKmsKey; only the relay process decrypts them. status=disabled is admin intent only (disabled_by=admin); automatic failures become cooldowns that expire.';

CREATE TABLE antigravity_relay_usage (
  id                 BIGSERIAL PRIMARY KEY,
  -- One per forwarded upstream call; the relay's retried insert is idempotent on it.
  call_id            UUID NOT NULL UNIQUE,
  request_id         TEXT NOT NULL CHECK (request_id ~ '^[0-9a-f]{32}$'),
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_id         BIGINT REFERENCES gemini_oauth_accounts(id) ON DELETE SET NULL,
  route_model_id     TEXT NOT NULL CHECK (char_length(route_model_id) BETWEEN 1 AND 64),
  upstream_model     TEXT NOT NULL CHECK (char_length(upstream_model) BETWEEN 1 AND 128),
  request_type       TEXT CHECK (request_type IS NULL OR char_length(request_type) <= 32),
  status_code        INTEGER NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  prompt_tokens      BIGINT NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  candidates_tokens  BIGINT NOT NULL DEFAULT 0 CHECK (candidates_tokens >= 0),
  thoughts_tokens    BIGINT NOT NULL DEFAULT 0 CHECK (thoughts_tokens >= 0),
  cached_tokens      BIGINT NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_antigravity_relay_usage_request ON antigravity_relay_usage(request_id, user_id);
CREATE INDEX idx_antigravity_relay_usage_created ON antigravity_relay_usage(created_at);

CREATE TABLE antigravity_turns (
  request_id   TEXT PRIMARY KEY CHECK (request_id ~ '^[0-9a-f]{32}$'),
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  model_id     TEXT NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 64),
  session_id   TEXT,
  trace_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settling','settled','abandoned')),
  engine_status TEXT CHECK (engine_status IS NULL OR engine_status IN ('success','error','unavailable','unknown')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_antigravity_turns_pending ON antigravity_turns(user_id, created_at) WHERE status IN ('pending','settling');

COMMENT ON TABLE antigravity_turns IS
  'OCV5-415 durable admission record per Antigravity turn. Any bridge settles it from the terminal frame by (request_id, user_id); turns left pending past the route TTL are settled from relay usage on the user''s next admission.';

COMMENT ON TABLE antigravity_relay_usage IS
  'OCV5-415 per-call usageMetadata observed by the Antigravity relay (title generation included). Turn settlement sums rows by (request_id, user_id).';

INSERT INTO model_catalog(
  model_id, engine, provider_id, upstream_model_id, context_window,
  capability_profile, capability_schema_version, state
) VALUES
  ('antigravity-gemini-3.8-flash', 'antigravity', 'antigravity', 'gemini-3.8-flash', 1000000,
   '{"supports_vision":false,"reasoning":{"supported":["low","medium","high"],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
   1, 'staged'),
  ('antigravity-claude-sonnet-4.6', 'antigravity', 'antigravity', 'claude-sonnet-4-6', 200000,
   '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
   1, 'staged'),
  ('antigravity-claude-opus-4.6', 'antigravity', 'antigravity', 'claude-opus-4-6-thinking', 200000,
   '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
   1, 'staged'),
  ('antigravity-gpt-oss-120b', 'antigravity', 'antigravity', 'gpt-oss-120b-medium', 128000,
   '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
   1, 'staged');

INSERT INTO model_pricing(
  model_id, display_name,
  input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, visibility, extra_system_prompt, default_effort, lock_version
) VALUES
  ('antigravity-gemini-3.8-flash', 'Gemini 3.8 Flash (Antigravity)',
   120, 150, 5, 0, '1', FALSE,
   (SELECT COALESCE(MAX(sort_order),100)+1 FROM model_pricing), 'admin', NULL, 'medium', 0),
  ('antigravity-claude-sonnet-4.6', 'Claude Sonnet 4.6 (Antigravity)',
   150, 750, 15, 0, '2', FALSE,
   (SELECT COALESCE(MAX(sort_order),100)+2 FROM model_pricing), 'admin', NULL, NULL, 0),
  ('antigravity-claude-opus-4.6', 'Claude Opus 4.6 Thinking (Antigravity)',
   250, 1250, 25, 0, '2', FALSE,
   (SELECT COALESCE(MAX(sort_order),100)+3 FROM model_pricing), 'admin', NULL, NULL, 0),
  ('antigravity-gpt-oss-120b', 'GPT-OSS 120B (Antigravity)',
   120, 150, 5, 0, '1', FALSE,
   (SELECT COALESCE(MAX(sort_order),100)+4 FROM model_pricing), 'admin', NULL, NULL, 0);
