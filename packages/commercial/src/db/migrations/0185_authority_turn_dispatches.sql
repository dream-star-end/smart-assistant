-- 0185 — bind lease-only CCB requests back to their durable dispatch.
--
-- Old runtime gateways intentionally forward only the signed TurnLease.  The lease already
-- contains authorityTurnId, but not billingRequestId, so the egress proxy otherwise loses the
-- durable dispatch identity for every CCB request.  This immutable auxiliary mapping stores no
-- prompt or response content and follows the dispatch retention lifecycle.

CREATE TABLE authority_turn_dispatches (
  authority_turn_id TEXT PRIMARY KEY
    CHECK (authority_turn_id ~ '^[0-9a-f]{32}$'),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  dispatch_model TEXT CHECK (dispatch_model IS NULL OR dispatch_model ~ '^[A-Za-z0-9._-]{1,64}$'),
  canonical_model TEXT NOT NULL CHECK (canonical_model ~ '^[A-Za-z0-9._-]{1,64}$'),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 256),
  dispatch_id UUID NOT NULL REFERENCES turn_dispatches(dispatch_id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dispatch_id,attempt_no)
);

CREATE INDEX idx_authority_turn_dispatches_created
  ON authority_turn_dispatches(created_at);

COMMENT ON TABLE authority_turn_dispatches IS
  'Immutable authorityTurnId to durable-dispatch binding for lease-only CCB billing attribution; no user content.';
