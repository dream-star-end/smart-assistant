<<<<<<<< HEAD:packages/commercial/src/db/migrations/0165_prompt_queue.sql
-- 0165_prompt_queue — V5 durable prompt queue repository (P1, flag off)
========
-- 0166_prompt_queue — V5 durable prompt queue repository (P1, flag off)
>>>>>>>> origin/feat/v5-aurora-rewrite:packages/commercial/src/db/migrations/0166_prompt_queue.sql
--
-- PG is the durable authority. Runtime coordinators can only mutate through
-- the container-authenticated internal API; every write locks one head row.

CREATE TABLE IF NOT EXISTS prompt_queue_heads (
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_key VARCHAR(512) NOT NULL,
  client_session_id VARCHAR(128) NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  active_turn_id VARCHAR(64),
  active_item_id VARCHAR(128),
  active_trace_id VARCHAR(64),
  active_started_at TIMESTAMPTZ,
  steer_delivery VARCHAR(32),
  coordinator_epoch BIGINT NOT NULL DEFAULT 0 CHECK (coordinator_epoch >= 0),
  lease_owner VARCHAR(128),
  lease_until TIMESTAMPTZ,
  current_claim_token CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_user_id, session_key),
  CONSTRAINT prompt_queue_heads_owner_fields_chk CHECK (
    octet_length(session_key) BETWEEN 1 AND 512
    AND octet_length(client_session_id) BETWEEN 1 AND 128
    AND octet_length(agent_id) BETWEEN 1 AND 64
  ),
  CONSTRAINT prompt_queue_heads_active_chk CHECK (
    (active_turn_id IS NULL AND active_item_id IS NULL AND active_trace_id IS NULL
      AND active_started_at IS NULL AND steer_delivery IS NULL)
    OR
    (active_turn_id IS NOT NULL AND active_turn_id ~ '^[0-9a-f]{64}$' AND active_item_id IS NOT NULL
      AND active_started_at IS NOT NULL
      AND steer_delivery IN ('native','fork-native','turn-boundary'))
  ),
  CONSTRAINT prompt_queue_heads_lease_chk CHECK (
    (current_claim_token IS NULL AND lease_until IS NULL)
    OR (lease_owner IS NOT NULL AND current_claim_token IS NOT NULL
      AND current_claim_token ~ '^[0-9a-f]{64}$' AND lease_until IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS prompt_queue_items (
  owner_user_id BIGINT NOT NULL,
  session_key VARCHAR(512) NOT NULL,
  item_id VARCHAR(128) NOT NULL,
  client_message_id VARCHAR(128) NOT NULL,
  position INTEGER,
  state VARCHAR(32) NOT NULL,
  display_text VARCHAR(4096) NOT NULL DEFAULT '',
  content_json JSONB NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  content_bytes BIGINT NOT NULL CHECK (content_bytes >= 0),
  requested_execution JSONB NOT NULL,
  delivery_mode VARCHAR(32),
  expected_turn_id VARCHAR(64),
  delivery_idempotency_key VARCHAR(128),
  delivery_token CHAR(64),
  delivered_turn_id VARCHAR(64),
  engine_receipt JSONB,
  claim_token CHAR(64),
  claim_until TIMESTAMPTZ,
  blocked_reason_code VARCHAR(128),
  blocked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_user_id, session_key, item_id),
  CONSTRAINT prompt_queue_items_head_fk FOREIGN KEY (owner_user_id, session_key)
    REFERENCES prompt_queue_heads(owner_user_id, session_key) ON DELETE CASCADE,
  CONSTRAINT prompt_queue_items_position_uniq UNIQUE (owner_user_id, session_key, position)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT prompt_queue_items_state_chk CHECK (
    state IN ('queued','dispatch_claimed','active','steer_pending','delivery_unknown','blocked')
  ),
  CONSTRAINT prompt_queue_items_position_chk CHECK (
    (state IN ('queued','blocked') AND position IS NOT NULL AND position > 0)
    OR (state IN ('dispatch_claimed','active','steer_pending','delivery_unknown') AND position IS NULL)
  ),
  CONSTRAINT prompt_queue_items_blocked_chk CHECK (
    (state = 'blocked' AND blocked_reason_code IS NOT NULL AND blocked_at IS NOT NULL)
    OR (state <> 'blocked' AND blocked_reason_code IS NULL AND blocked_at IS NULL)
  ),
  CONSTRAINT prompt_queue_items_claim_chk CHECK (
    (state = 'dispatch_claimed' AND claim_token IS NOT NULL
      AND claim_token ~ '^[0-9a-f]{64}$' AND claim_until IS NOT NULL)
    OR (state <> 'dispatch_claimed' AND claim_token IS NULL AND claim_until IS NULL)
  ),
  CONSTRAINT prompt_queue_items_ids_chk CHECK (
    item_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND client_message_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT prompt_queue_items_wire_lengths_chk CHECK (
    (delivery_idempotency_key IS NULL OR octet_length(delivery_idempotency_key) BETWEEN 1 AND 128)
    AND (blocked_reason_code IS NULL OR octet_length(blocked_reason_code) BETWEEN 1 AND 128)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS prompt_queue_items_one_active_idx
  ON prompt_queue_items(owner_user_id, session_key) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS prompt_queue_items_one_claim_idx
  ON prompt_queue_items(owner_user_id, session_key) WHERE state = 'dispatch_claimed';
CREATE INDEX IF NOT EXISTS prompt_queue_items_waiting_idx
  ON prompt_queue_items(owner_user_id, session_key, position)
  WHERE position IS NOT NULL;
CREATE INDEX IF NOT EXISTS prompt_queue_items_claim_expiry_idx
  ON prompt_queue_items(claim_until) WHERE state = 'dispatch_claimed';

-- Cross-table active invariant cannot be expressed as a CHECK/FK alone:the
-- head points at an item while the item also carries state='active'. Deferred
-- constraint triggers let the store update both sides in either order inside
-- one transaction, then reject any inconsistent commit.
CREATE OR REPLACE FUNCTION prompt_queue_assert_active_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner BIGINT;
  v_session TEXT;
  v_head_count INTEGER;
  v_active_item TEXT;
  v_active_count INTEGER;
  v_matching_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_owner := OLD.owner_user_id;
    v_session := OLD.session_key;
  ELSE
    v_owner := NEW.owner_user_id;
    v_session := NEW.session_key;
  END IF;

  EXECUTE format(
    'SELECT COUNT(*)::integer,MAX(active_item_id) FROM %I.prompt_queue_heads WHERE owner_user_id=$1 AND session_key=$2',
    TG_TABLE_SCHEMA
  ) INTO v_head_count,v_active_item USING v_owner, v_session;

  EXECUTE format(
    'SELECT COUNT(*)::integer FROM %I.prompt_queue_items WHERE owner_user_id=$1 AND session_key=$2 AND state=''active''',
    TG_TABLE_SCHEMA
  ) INTO v_active_count USING v_owner, v_session;

  IF v_head_count = 0 THEN
    IF v_active_count <> 0 THEN
      RAISE EXCEPTION 'prompt queue active item exists without head'
        USING ERRCODE = '23514', CONSTRAINT = 'prompt_queue_active_consistency';
    END IF;
    RETURN NULL;
  END IF;

  IF v_active_item IS NULL THEN
    IF v_active_count <> 0 THEN
      RAISE EXCEPTION 'prompt queue active item exists while head is idle'
        USING ERRCODE = '23514', CONSTRAINT = 'prompt_queue_active_consistency';
    END IF;
    RETURN NULL;
  END IF;

  EXECUTE format(
    'SELECT COUNT(*)::integer FROM %I.prompt_queue_items WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3 AND state=''active''',
    TG_TABLE_SCHEMA
  ) INTO v_matching_count USING v_owner, v_session, v_active_item;
  IF v_active_count <> 1 OR v_matching_count <> 1 THEN
    RAISE EXCEPTION 'prompt queue head active item is missing or not active'
      USING ERRCODE = '23514', CONSTRAINT = 'prompt_queue_active_consistency';
  END IF;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname='prompt_queue_heads_active_consistency_trg'
       AND tgrelid='prompt_queue_heads'::regclass
  ) THEN
    EXECUTE 'CREATE CONSTRAINT TRIGGER prompt_queue_heads_active_consistency_trg
      AFTER INSERT OR UPDATE OR DELETE ON prompt_queue_heads
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION prompt_queue_assert_active_consistency()';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname='prompt_queue_items_active_consistency_trg'
       AND tgrelid='prompt_queue_items'::regclass
  ) THEN
    EXECUTE 'CREATE CONSTRAINT TRIGGER prompt_queue_items_active_consistency_trg
      AFTER INSERT OR UPDATE OR DELETE ON prompt_queue_items
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION prompt_queue_assert_active_consistency()';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS prompt_queue_item_attachments (
  owner_user_id BIGINT NOT NULL,
  session_key VARCHAR(512) NOT NULL,
  item_id VARCHAR(128) NOT NULL,
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('image','audio','video','file')),
  url VARCHAR(256) NOT NULL,
  mime_type VARCHAR(128),
  filename VARCHAR(512),
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  content_sha256 CHAR(64),
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  PRIMARY KEY (owner_user_id, session_key, item_id, ordinal),
  CONSTRAINT prompt_queue_attachments_item_fk FOREIGN KEY (owner_user_id, session_key, item_id)
    REFERENCES prompt_queue_items(owner_user_id, session_key, item_id) ON DELETE CASCADE,
  CONSTRAINT prompt_queue_attachments_url_chk CHECK (
    url ~ '^/api/media/[0-9a-f]{64}\.[A-Za-z0-9]{1,32}$'
  ),
  CONSTRAINT prompt_queue_attachments_sha_chk CHECK (
    content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT prompt_queue_attachments_lengths_chk CHECK (
    (mime_type IS NULL OR octet_length(mime_type) <= 128)
    AND (filename IS NULL OR octet_length(filename) <= 512)
  )
);

CREATE TABLE IF NOT EXISTS prompt_queue_mutations (
  owner_user_id BIGINT NOT NULL,
  session_key VARCHAR(512) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  operation VARCHAR(32) NOT NULL,
  request_sha256 CHAR(64) NOT NULL,
  item_id VARCHAR(128),
  outcome VARCHAR(32) NOT NULL,
  applied_version BIGINT,
  result_code VARCHAR(128),
  delivery_token CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_user_id, session_key, idempotency_key),
  CONSTRAINT prompt_queue_mutations_head_fk FOREIGN KEY (owner_user_id, session_key)
    REFERENCES prompt_queue_heads(owner_user_id, session_key) ON DELETE CASCADE,
  CONSTRAINT prompt_queue_mutations_operation_chk CHECK (
    operation IN ('enqueue','edit','delete','reorder','interject')
  ),
  CONSTRAINT prompt_queue_mutations_outcome_chk CHECK (
    outcome IN ('applied','version_conflict','turn_changed','delivery_pending','delivery_unknown','rejected')
  ),
  CONSTRAINT prompt_queue_mutations_hash_chk CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT prompt_queue_mutations_wire_lengths_chk CHECK (
    octet_length(idempotency_key) BETWEEN 1 AND 128
    AND (result_code IS NULL OR octet_length(result_code) BETWEEN 1 AND 128)
  ),
  CONSTRAINT prompt_queue_mutations_delivery_token_chk CHECK (
    delivery_token IS NULL OR delivery_token ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT prompt_queue_mutations_version_chk CHECK (applied_version IS NULL OR applied_version >= 0)
);

CREATE INDEX IF NOT EXISTS prompt_queue_mutations_retention_idx
  ON prompt_queue_mutations(created_at);
