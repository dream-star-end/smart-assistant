-- 0183 — GPT-5.6 Luna hidden activation + auditable, model-scoped verification sponsorship.
--
-- Luna transport/runtime support already ships in both rollback releases.  This migration only
-- activates the existing exact staged descriptor, keeps it hidden, and grants the two dedicated
-- verification identities.  Public visibility is deliberately a separate post-finalize admin
-- action so an aborted candidate cannot leave an incompatible catalog visible to ordinary users.

DO $$
DECLARE
  luna_state TEXT;
  operator_id BIGINT;
  target RECORD;
BEGIN
  SELECT state INTO luna_state
    FROM model_catalog
   WHERE model_id = 'gpt-5.6-luna'
     AND state IN ('staged','active')
     AND engine = 'codex'
     AND provider_id = 'codex'
     AND upstream_model_id IS NULL
     AND context_window IS NULL
     AND capability_schema_version = 1
     AND capability_profile = '{
       "supports_vision": true,
       "reasoning": {
         "supported": ["low","medium","high","xhigh","max"],
         "codex_model_default": "medium"
       },
       "ccb": {"capability_zero": false, "supports_thinking": false}
     }'::jsonb;

  IF luna_state IS NULL THEN
    RAISE EXCEPTION '0183 requires the exact staged/active gpt-5.6-luna descriptor';
  END IF;
  IF luna_state = 'staged' THEN
    PERFORM fn_model_activate('gpt-5.6-luna', NULL);
  END IF;

  UPDATE model_pricing
     SET enabled = TRUE,
         default_effort = 'medium',
         visibility = 'hidden',
         lock_version = lock_version + 1,
         updated_at = NOW()
   WHERE model_id = 'gpt-5.6-luna';

  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing p
      JOIN model_catalog c ON c.model_id=p.model_id AND c.state='active'
     WHERE p.model_id='gpt-5.6-luna'
       AND p.enabled IS TRUE
       AND p.visibility='hidden'
       AND p.default_effort='medium'
       AND c.engine='codex'
       AND c.provider_id='codex'
  ) THEN
    RAISE EXCEPTION '0183 Luna hidden activation verification failed';
  END IF;

  SELECT id INTO operator_id FROM users WHERE role='admin' ORDER BY id LIMIT 1;

  FOR target IN
    SELECT id, email FROM users
     WHERE email IN ('v5-canary@claudeai.chat','v5-evals@claudeai.chat')
     ORDER BY email
  LOOP
    IF operator_id IS NULL THEN
      RAISE EXCEPTION '0183 requires an admin identity when a verification account exists';
    END IF;

    INSERT INTO model_visibility_grants(user_id,model_id,granted_by)
    VALUES (target.id,'gpt-5.6-luna',operator_id)
    ON CONFLICT (user_id,model_id) DO NOTHING;

    IF FOUND THEN
      INSERT INTO admin_audit(admin_id,action,target,before,after)
      VALUES (
        operator_id,
        'model_grant.add',
        'user:' || target.id::text || '/model:gpt-5.6-luna',
        NULL,
        jsonb_build_object(
          'user_id',target.id::text,
          'model_id','gpt-5.6-luna',
          'granted_by',operator_id::text,
          'source','migration:0183'
        )
      );
    END IF;
  END LOOP;

END $$;

CREATE TABLE verification_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_prefix TEXT NOT NULL UNIQUE
    CHECK (length(session_prefix) BETWEEN 24 AND 44 AND session_prefix ~ '^e2e-[a-z0-9]+-$'),
  allowed_models TEXT[] NOT NULL
    CHECK (allowed_models = ARRAY['deepseek-v4-flash','gpt-5.6-luna']::TEXT[]),
  expected_release TEXT NOT NULL CHECK (expected_release ~ '^/?.*rel-[A-Za-z0-9._-]+$'),
  expected_generation BIGINT NOT NULL CHECK (expected_generation >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','failed')),
  approval_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
  closed_at TIMESTAMPTZ,
  CHECK ((status='active' AND closed_at IS NULL) OR (status<>'active' AND closed_at IS NOT NULL))
);

CREATE INDEX idx_verification_runs_active_user
  ON verification_runs(user_id,expires_at) WHERE status='active';

CREATE TABLE verification_sponsored_requests (
  request_id TEXT PRIMARY KEY CHECK (request_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  run_id UUID NOT NULL REFERENCES verification_runs(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  model TEXT NOT NULL CHECK (model IN ('deepseek-v4-flash','gpt-5.6-luna')),
  session_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id,request_id)
);

ALTER TABLE usage_records
  ADD COLUMN verification_run_id UUID REFERENCES verification_runs(id) ON DELETE RESTRICT,
  ADD COLUMN would_have_cost_credits BIGINT CHECK (would_have_cost_credits >= 0),
  ADD CONSTRAINT usage_records_verification_pair_check CHECK (
    (verification_run_id IS NULL AND would_have_cost_credits IS NULL)
    OR
    (verification_run_id IS NOT NULL AND would_have_cost_credits IS NOT NULL AND cost_credits = 0)
  );

CREATE TABLE release_verification_evidence (
  release_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  run_id UUID NOT NULL REFERENCES verification_runs(id) ON DELETE RESTRICT,
  model_matrix TEXT[] NOT NULL
    CHECK (model_matrix = ARRAY['deepseek-v4-flash','gpt-5.6-luna']::TEXT[]),
  incident_manifest_sha256 TEXT NOT NULL CHECK (incident_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  result_sha256 TEXT NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  passed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (release_id,generation)
);

CREATE TABLE release_egress_transitions (
  release_id TEXT NOT NULL CHECK (release_id ~ '^/?.*rel-[A-Za-z0-9._-]+$'),
  generation BIGINT NOT NULL CHECK (generation >= 1),
  predecessor_release TEXT NOT NULL CHECK (predecessor_release ~ '^/?.*rel-[A-Za-z0-9._-]+$'),
  status TEXT NOT NULL CHECK (status IN ('testing','ready','active','rolled_back')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  PRIMARY KEY (release_id,generation),
  UNIQUE (generation),
  CHECK (
    (status='testing' AND ready_at IS NULL AND activated_at IS NULL)
    OR (status='ready' AND ready_at IS NOT NULL AND activated_at IS NULL)
    OR (status='active' AND ready_at IS NOT NULL AND activated_at IS NOT NULL)
    OR (status='rolled_back' AND activated_at IS NULL)
  )
);

COMMENT ON TABLE verification_runs IS
  'Short-lived, release-bound sponsorship for the dedicated V5 evaluation identity; never a customer entitlement.';
COMMENT ON COLUMN usage_records.would_have_cost_credits IS
  'Exact nominal cost retained when a verification sponsorship makes cost_credits zero.';
COMMENT ON TABLE release_egress_transitions IS
  'Durable egress handoff state: candidate tests new egress then restores predecessor; finalize/recover activates it only after master is stable.';
