-- 0093_marketplace_raw_artifact_trigger.sql
-- Make 0092's `raw_artifact NOT NULL` backward/rollback-safe (Codex M2 BLOCKER#1).
--
-- 0092 added raw_artifact NOT NULL, but the pre-M2 (and any rolled-back) code path
-- writes only raw_skill_md, never raw_artifact → its INSERT would violate NOT NULL.
-- A column DEFAULT can't reference another column, so we use a BEFORE trigger that
-- backfills raw_artifact := raw_skill_md whenever raw_artifact is left NULL. M2/M3
-- code always sets raw_artifact explicitly, so the trigger is a no-op for them; it
-- only protects the old/rolled-back skill write path.

CREATE OR REPLACE FUNCTION mkt_fill_raw_artifact() RETURNS trigger AS $$
BEGIN
  IF NEW.raw_artifact IS NULL THEN
    NEW.raw_artifact := NEW.raw_skill_md;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mkt_fill_raw_artifact ON marketplace_skill_versions;
CREATE TRIGGER trg_mkt_fill_raw_artifact
  BEFORE INSERT OR UPDATE ON marketplace_skill_versions
  FOR EACH ROW EXECUTE FUNCTION mkt_fill_raw_artifact();
