-- order-dependency: 0336_commercial_muse_durable
-- OCV5-746: independent (node, engine, profile) lane pools, including unknown bindings.
-- Additive: old masters keep their old limits throughout the migration/deploy window.
-- Do not raise max_active_slots or shared_active_cap while old controllers are still running.
-- compat: the independent ceiling defaults to 5 and satisfies its CHECK; legacy columns and old writers are unchanged.
ALTER TABLE remote_agent_profiles
  ADD COLUMN IF NOT EXISTS max_concurrent_lanes INTEGER NOT NULL DEFAULT 5
    CHECK (max_concurrent_lanes BETWEEN 1 AND 64);
COMMENT ON COLUMN remote_agent_profiles.max_concurrent_lanes IS
  'OCV5-746: independent account lane ceiling; every non-released binding occupies one slot. Default 5. Node memory is a separate admission gate.';
-- Legacy node.max_active_slots/shared_active_cap and profile.max_active_slots remain for older
-- releases and the existing admin UI. New placeRemoteLane reads only max_concurrent_lanes.
