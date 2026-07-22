-- 0184 — durable audit/debt fence for dx-declared V5 P0 containment releases.

CREATE TABLE emergency_containment_debts (
  incident_id TEXT PRIMARY KEY CHECK (incident_id ~ '^INC-[0-9]{8}-[A-Z0-9-]{3,40}$'),
  approval_ref TEXT NOT NULL CHECK (length(approval_ref) BETWEEN 8 AND 256),
  exact_commit TEXT NOT NULL CHECK (exact_commit ~ '^[0-9a-f]{40}$'),
  candidate_release TEXT,
  deploy_id TEXT NOT NULL CHECK (deploy_id ~ '^[0-9a-f]{24}$'),
  holder_identity TEXT NOT NULL,
  authorization_nonce_hash TEXT NOT NULL UNIQUE CHECK (authorization_nonce_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  protected_merge_sha TEXT CHECK (protected_merge_sha IS NULL OR protected_merge_sha ~ '^[0-9a-f]{40}$'),
  ci_evidence JSONB,
  CHECK (
    (status='open' AND closed_at IS NULL AND protected_merge_sha IS NULL AND ci_evidence IS NULL)
    OR
    (status='closed' AND closed_at IS NOT NULL AND protected_merge_sha IS NOT NULL AND ci_evidence IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_emergency_containment_one_open
  ON emergency_containment_debts((status)) WHERE status='open';

COMMENT ON TABLE emergency_containment_debts IS
  'One-shot P0 containment authorization and mandatory post-stability verification debt. Abort/rollback/recover remain allowed.';
