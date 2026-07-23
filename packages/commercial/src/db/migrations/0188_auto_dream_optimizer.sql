-- Auto-Dream V2: anonymous platform findings + idempotent master-owned actions.
-- Existing V1 users remain on the legacy preference until they accept the V2
-- consent. The separate auto_optimizer_enabled JSON preference is intentionally
-- unknown to old runtimes, while V2 enablement sets auto_dream_enabled=false.

UPDATE system_settings
   SET value = '"gpt-5.6-terra"'::jsonb,
       updated_at = NOW()
 WHERE key = 'auto_dream_model';

CREATE TABLE auto_dream_platform_findings (
  id BIGSERIAL PRIMARY KEY,
  fingerprint CHAR(64) NOT NULL UNIQUE,
  taxonomy TEXT NOT NULL CHECK (taxonomy IN (
    'capability_gap', 'usability_friction', 'reliability', 'performance',
    'privacy', 'billing', 'documentation', 'skill_quality', 'plugin_ecosystem'
  )),
  capability_id TEXT NOT NULL CHECK (capability_id ~ '^[a-z0-9][a-z0-9._-]{0,95}$'),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  problem TEXT NOT NULL CHECK (char_length(problem) BETWEEN 1 AND 500),
  impact TEXT NOT NULL CHECK (char_length(impact) BETWEEN 1 AND 500),
  recommendation TEXT NOT NULL CHECK (char_length(recommendation) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'triaged', 'planned', 'resolved', 'dismissed')),
  occurrence_count BIGINT NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
  affected_user_count BIGINT NOT NULL DEFAULT 1 CHECK (affected_user_count >= 1),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_model TEXT NOT NULL,
  last_run_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_auto_dream_platform_findings_status_seen
  ON auto_dream_platform_findings(status, last_seen_at DESC);
CREATE INDEX idx_auto_dream_platform_findings_capability
  ON auto_dream_platform_findings(capability_id, last_seen_at DESC);

CREATE TABLE auto_dream_platform_finding_occurrences (
  finding_id BIGINT NOT NULL REFERENCES auto_dream_platform_findings(id) ON DELETE CASCADE,
  subject_hash CHAR(64) NOT NULL,
  run_id UUID NOT NULL,
  agent_hash CHAR(64) NOT NULL,
  signal_count INTEGER NOT NULL CHECK (signal_count BETWEEN 1 AND 1000000),
  evidence_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (finding_id, subject_hash, run_id)
);

CREATE INDEX idx_auto_dream_platform_occurrences_subject
  ON auto_dream_platform_finding_occurrences(subject_hash, created_at DESC);

CREATE TABLE auto_dream_action_receipts (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_id CHAR(32) NOT NULL,
  action_hash CHAR(64) NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'applied', 'conflict')),
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, proposal_id)
);

COMMENT ON TABLE auto_dream_platform_findings IS
  'Deduplicated anonymous Auto-Dream V2 platform improvement findings. Never stores raw conversation/log/tool content or direct user identifiers.';
COMMENT ON TABLE auto_dream_platform_finding_occurrences IS
  'Anonymous aggregation membership keyed only by a service-secret HMAC; never stores user_id or another direct user identifier.';
