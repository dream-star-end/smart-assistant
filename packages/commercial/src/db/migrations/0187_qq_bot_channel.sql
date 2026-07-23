-- One platform-owned QQ Official Bot, with per-user OpenID binding.
--
-- The migration is additive so the previous stable release can keep running
-- unchanged after it is applied.  QQ credentials and binding-code HMAC keys
-- remain in the authoritative V5 environment; no secret is stored here.

CREATE TABLE qq_bot_bindings (
  user_id              BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bot_openid           TEXT NOT NULL UNIQUE,
  binding_version      TEXT NOT NULL UNIQUE,
  bound_at             BIGINT NOT NULL,
  last_interaction_at  BIGINT NOT NULL,
  CONSTRAINT qqb_openid_chk CHECK (length(bot_openid) BETWEEN 1 AND 256),
  CONSTRAINT qqb_version_chk CHECK (binding_version ~ '^[0-9a-f]{32}$'),
  CONSTRAINT qqb_bound_at_chk CHECK (bound_at > 0),
  CONSTRAINT qqb_last_interaction_chk CHECK (last_interaction_at > 0)
);

CREATE TABLE qq_bind_tokens (
  user_id      BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_mac    BYTEA NOT NULL UNIQUE,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  CONSTRAINT qqbt_token_mac_chk CHECK (octet_length(token_mac) = 32),
  CONSTRAINT qqbt_created_at_chk CHECK (created_at > 0),
  CONSTRAINT qqbt_expires_at_chk CHECK (expires_at > created_at)
);

-- Persisted per-OpenID sliding windows prevent online binding-code
-- enumeration across master restarts.  Only a keyed digest of OpenID is kept.
CREATE TABLE qq_bind_attempts (
  openid_mac         BYTEA PRIMARY KEY,
  window_started_at  BIGINT NOT NULL,
  attempts           INT NOT NULL,
  updated_at         BIGINT NOT NULL,
  CONSTRAINT qqba_openid_mac_chk CHECK (octet_length(openid_mac) = 32),
  CONSTRAINT qqba_window_chk CHECK (window_started_at > 0),
  CONSTRAINT qqba_attempts_chk CHECK (attempts BETWEEN 0 AND 1000),
  CONSTRAINT qqba_updated_at_chk CHECK (updated_at > 0)
);

CREATE TABLE qq_session_pointer (
  user_id             BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_session_id  TEXT NOT NULL,
  current_agent_id    TEXT,
  updated_at          BIGINT NOT NULL,
  CONSTRAINT qqsp_session_chk CHECK (current_session_id ~ '^wsess-[0-9a-f]{16}$'),
  CONSTRAINT qqsp_agent_chk CHECK (
    current_agent_id IS NULL OR current_agent_id ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  CONSTRAINT qqsp_updated_at_chk CHECK (updated_at > 0)
);

CREATE INDEX idx_qqsp_current_session ON qq_session_pointer(current_session_id);

CREATE TABLE qq_running_sessions (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  agent_id      TEXT,
  started_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (user_id, session_id, run_id),
  CONSTRAINT qqrs_session_chk CHECK (session_id ~ '^wsess-[0-9a-f]{16}$'),
  CONSTRAINT qqrs_run_chk CHECK (length(run_id) BETWEEN 1 AND 128),
  CONSTRAINT qqrs_agent_chk CHECK (
    agent_id IS NULL OR agent_id ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  CONSTRAINT qqrs_started_at_chk CHECK (started_at > 0),
  CONSTRAINT qqrs_updated_at_chk CHECK (updated_at > 0)
);

CREATE INDEX idx_qqrs_user_started
  ON qq_running_sessions(user_id, started_at DESC);

-- Durable delivery queue.  There is deliberately no terminal "failed"
-- state or age/attempt deletion policy: once an internal caller receives
-- queued/pending, the payload remains retryable until QQ accepts it or the
-- user unbinds.  binding_version fences an old queue from a later rebind.
CREATE TABLE qq_outbox (
  id                 BIGSERIAL PRIMARY KEY,
  delivery_id        TEXT NOT NULL,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  binding_version     TEXT NOT NULL,
  target_openid       TEXT NOT NULL,
  session_id          TEXT,
  kind                TEXT NOT NULL,
  payload             JSONB NOT NULL,
  next_chunk          INT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'queued',
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  next_attempt_at     BIGINT NOT NULL,
  locked_at           BIGINT,
  sent_at             BIGINT,
  cancelled_at        BIGINT,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  CONSTRAINT qqo_delivery_id_chk CHECK (delivery_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT qqo_binding_version_chk CHECK (binding_version ~ '^[0-9a-f]{32}$'),
  CONSTRAINT qqo_openid_chk CHECK (length(target_openid) BETWEEN 1 AND 256),
  CONSTRAINT qqo_session_chk CHECK (
    session_id IS NULL OR session_id ~ '^wsess-[0-9a-f]{16}$'
  ),
  CONSTRAINT qqo_kind_chk CHECK (kind IN ('reply','proactive')),
  CONSTRAINT qqo_next_chunk_chk CHECK (next_chunk >= 0),
  CONSTRAINT qqo_status_chk CHECK (status IN ('queued','sending','sent','cancelled')),
  CONSTRAINT qqo_attempts_chk CHECK (attempts >= 0),
  CONSTRAINT qqo_last_error_chk CHECK (last_error IS NULL OR length(last_error) <= 1000),
  CONSTRAINT qqo_time_chk CHECK (
    next_attempt_at > 0 AND created_at > 0 AND updated_at > 0
  ),
  CONSTRAINT qqo_sent_consistency_chk CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT qqo_cancelled_consistency_chk CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  ),
  CONSTRAINT qqo_user_delivery_unique UNIQUE (user_id, delivery_id)
);

CREATE INDEX idx_qqo_drain
  ON qq_outbox(next_attempt_at, created_at, id)
  WHERE status = 'queued';
CREATE INDEX idx_qqo_sending
  ON qq_outbox(locked_at)
  WHERE status = 'sending';
CREATE INDEX idx_qqo_user_pending
  ON qq_outbox(user_id, status, created_at);

COMMENT ON TABLE qq_bot_bindings IS
  'Per-user binding to the single platform QQ Official Bot. OpenID is bot-scoped; binding_version fences queued deliveries across unbind/rebind.';
COMMENT ON TABLE qq_outbox IS
  'Lossless QQ reply/proactive queue. No silent terminal-failure or age/attempt deletion; unbind explicitly cancels old binding_version rows.';
