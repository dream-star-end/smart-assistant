-- order-dependency: none
-- OCV5-610: positive PG effect receipts. No executable arguments, credentials or model content.
CREATE TABLE IF NOT EXISTS system_action_receipts (
  action_id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK (operation_version > 0),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('user','admin')),
  result_json JSONB NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS system_action_receipts_owner ON system_action_receipts(user_id, committed_at);
-- compat: Only this new additive table is granted to the current migration owner; old objects are unchanged.
GRANT SELECT, INSERT ON system_action_receipts TO CURRENT_USER;
-- compat: Only this new additive table is hardened; application role is the same trusted owner used by the deployment migration.
REVOKE UPDATE, DELETE, TRUNCATE ON system_action_receipts FROM CURRENT_USER;
