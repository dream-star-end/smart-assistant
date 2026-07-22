CREATE TABLE provider_quota_blocks (
  provider_id TEXT PRIMARY KEY,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retry_at TIMESTAMPTZ NOT NULL,
  probe_lease_until TIMESTAMPTZ
);

COMMENT ON TABLE provider_quota_blocks IS
  'Exact upstream subscription-quota blocks; separate from heuristic provider health.';
