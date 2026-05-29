-- 0075_account_groups.sql
-- Account-pool grouping for commercial v3.
-- V1 supports two concrete route families only:
--   - official_oauth + claude: existing Claude OAuth subscription accounts
--   - api_relay      + codex : OpenAI-compatible/Codex relay API keys
-- Priority is ascending: smaller number wins. Model binding is exact model_id.

CREATE TABLE account_groups (
  id          BIGSERIAL PRIMARY KEY,
  label       TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  kind        TEXT NOT NULL CHECK (kind IN ('official_oauth','api_relay')),
  provider    TEXT NOT NULL CHECK (provider IN ('claude','codex')),
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  priority    INTEGER NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'official_oauth' AND provider = 'claude') OR
    (kind = 'api_relay'      AND provider = 'codex')
  )
);

CREATE INDEX idx_account_groups_route
  ON account_groups(provider, kind, enabled, priority, id);

COMMENT ON TABLE account_groups IS
  'Commercial v3 account/API groups. V1 supports official_oauth+claude and api_relay+codex only.';
COMMENT ON COLUMN account_groups.priority IS
  'Ascending priority: smaller numbers are tried first; ties break by id ASC.';

CREATE TABLE account_group_models (
  group_id    BIGINT NOT NULL REFERENCES account_groups(id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL REFERENCES model_pricing(model_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, model_id)
);

CREATE INDEX idx_account_group_models_model
  ON account_group_models(model_id, group_id);

ALTER TABLE claude_accounts
  ADD COLUMN group_id BIGINT REFERENCES account_groups(id) ON DELETE SET NULL;

CREATE INDEX idx_claude_accounts_group_status
  ON claude_accounts(group_id, provider, status);

CREATE TABLE api_relay_credentials (
  id                        BIGSERIAL PRIMARY KEY,
  group_id                  BIGINT NOT NULL REFERENCES account_groups(id) ON DELETE CASCADE,
  label                     TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  base_url                  TEXT NOT NULL CHECK (base_url ~ '^https?://'),
  model_provider            TEXT NOT NULL CHECK (model_provider ~ '^[A-Za-z0-9_-]+$'),
  provider_name             TEXT,
  wire_api                  TEXT NOT NULL DEFAULT 'responses' CHECK (wire_api IN ('responses','chat')),
  preferred_auth_method     TEXT NOT NULL DEFAULT 'apikey' CHECK (preferred_auth_method IN ('apikey','chatgpt')),
  disable_response_storage  BOOLEAN NOT NULL DEFAULT TRUE,
  api_key_enc               BYTEA NOT NULL,
  api_key_nonce             BYTEA NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','cooldown')),
  health_score              INTEGER NOT NULL DEFAULT 100 CHECK (health_score >= 0 AND health_score <= 100),
  cooldown_until            TIMESTAMPTZ,
  last_used_at              TIMESTAMPTZ,
  last_error                TEXT,
  success_count             BIGINT NOT NULL DEFAULT 0,
  fail_count                BIGINT NOT NULL DEFAULT 0,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_relay_credentials_group_status
  ON api_relay_credentials(group_id, status, health_score DESC, id);

COMMENT ON TABLE api_relay_credentials IS
  'Encrypted API relay credentials for api_relay+codex account groups. Plaintext keys must never be serialized.';

CREATE TABLE codex_route_contexts (
  token_hash     TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  container_id   BIGINT NOT NULL REFERENCES agent_containers(id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id       TEXT NOT NULL REFERENCES model_pricing(model_id) ON DELETE RESTRICT,
  group_id       BIGINT NOT NULL REFERENCES account_groups(id) ON DELETE CASCADE,
  credential_id  BIGINT NOT NULL REFERENCES api_relay_credentials(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  last_used_at   TIMESTAMPTZ
);

CREATE INDEX idx_codex_route_contexts_lookup
  ON codex_route_contexts(container_id, user_id, expires_at)
  WHERE status = 'active';

-- Seed default groups. These do not alter model visibility/enabled flags.
INSERT INTO account_groups(label, kind, provider, enabled, priority)
VALUES
  ('默认 Claude 官方订阅', 'official_oauth', 'claude', TRUE, 100),
  ('默认 GPT 中转站',       'api_relay',      'codex',  FALSE, 100);

INSERT INTO account_group_models(group_id, model_id)
SELECT g.id, mp.model_id
  FROM account_groups g
  JOIN model_pricing mp ON mp.model_id LIKE 'claude-%'
 WHERE g.kind = 'official_oauth' AND g.provider = 'claude'
ON CONFLICT DO NOTHING;

INSERT INTO account_group_models(group_id, model_id)
SELECT g.id, mp.model_id
  FROM account_groups g
  JOIN model_pricing mp ON mp.model_id = 'gpt-5.5'
 WHERE g.kind = 'api_relay' AND g.provider = 'codex'
ON CONFLICT DO NOTHING;

UPDATE claude_accounts
   SET group_id = (
     SELECT id FROM account_groups
      WHERE kind = 'official_oauth' AND provider = 'claude'
      ORDER BY id LIMIT 1
   )
 WHERE provider = 'claude' AND group_id IS NULL;
