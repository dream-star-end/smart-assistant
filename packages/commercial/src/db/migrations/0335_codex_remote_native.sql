-- order-dependency: 0334_users_registration_ip
-- OCV5-746. Additive readers first; no Codex offer/readiness is enabled here.
-- Apply 0334 before this file in a release. Test fixtures may execute this DDL in isolation.
-- Existing CC rows, receipts and hashes are not rewritten. Unknown bindings retain their slots.
-- compat: the new node column defaults to 1, satisfying its CHECK; old node inserts omit it.
ALTER TABLE remote_agent_nodes ADD COLUMN shared_active_cap INTEGER NOT NULL DEFAULT 1 CHECK(shared_active_cap BETWEEN 1 AND 64);
ALTER TABLE remote_agent_profiles
  ADD COLUMN probe_snapshot JSONB,
  ADD COLUMN execution_manifest JSONB,
  ADD COLUMN execution_ready BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN auth_epoch TEXT;
-- compat: old binding writes omit the new fields; engine defaults to cc and satisfies the new CHECK, with all existing encodings unchanged.
ALTER TABLE remote_agent_bindings
  ADD COLUMN engine TEXT NOT NULL DEFAULT 'cc' CHECK (engine IN ('cc','codex')),
  ADD COLUMN backend_kind TEXT NOT NULL DEFAULT 'cc5-interactive-v1',
  ADD COLUMN auth_epoch TEXT,
  ADD COLUMN manifest_sha256 TEXT,
  ADD COLUMN recovery_spec JSONB,
  ADD COLUMN remote_start_attempted BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN no_host_effect_proven BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_remote_bindings_occupied_node ON remote_agent_bindings(node_id) WHERE state <> 'released';
CREATE INDEX idx_remote_bindings_history ON remote_agent_bindings(uid,session_key,engine,updated_at DESC);

-- Financial evidence is retained for the same lifetime as its journal/usage. No TTL deletion:
-- an unknown turn is not proof that an effect or charge did not occur.
CREATE TABLE remote_native_threads (
  uid BIGINT NOT NULL, operation_id UUID NOT NULL, native_thread_id TEXT NOT NULL,
  profile_id TEXT NOT NULL, auth_epoch TEXT NOT NULL, upstream_model TEXT NOT NULL,
  total JSONB NOT NULL, last_native_turn_id TEXT, pending_request_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(uid,operation_id,native_thread_id),
  CHECK(jsonb_typeof(total)='object')
);
CREATE TABLE remote_native_turns (
  uid BIGINT NOT NULL, operation_id UUID NOT NULL, native_thread_id TEXT NOT NULL,
  native_turn_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  receipt_sha256 TEXT NOT NULL CHECK(receipt_sha256 ~ '^[a-f0-9]{64}$'),
  receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(uid,operation_id,native_thread_id,native_turn_id),
  FOREIGN KEY(uid,operation_id,native_thread_id) REFERENCES remote_native_threads(uid,operation_id,native_thread_id)
);
