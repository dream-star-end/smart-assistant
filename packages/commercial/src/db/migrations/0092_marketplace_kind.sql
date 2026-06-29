-- 0092_marketplace_kind.sql
-- Generalize the skill marketplace into a kind-discriminated ARTIFACT marketplace
-- (skill | agent), per the v5 AI-market RFC (M2). Additive + backward compatible.
--
--   * listings.kind        — the authoritative artifact kind. Stored ONLY here;
--                            versions/installs learn the kind by joining the
--                            listing (no redundant copy → no drift). slug stays
--                            globally unique (the existing PK), so skill & agent
--                            never share a slug.
--   * versions.raw_artifact — the generic raw published text. For a skill this is
--                            == raw_skill_md; for an agent (M3) it is the agent
--                            manifest. Backfilled from raw_skill_md.
--   * versions.manifest    — structured per-kind metadata (agent: model/toolsets/
--                            skillDeps). NULL for skills.
--   * raw_skill_md becomes NULLABLE — agents have no SKILL.md and use raw_artifact;
--     skills continue to populate it, so the skill read path is unchanged.
--
-- Only the v5 instance reads these tables (v3 ships no marketplace code), so every
-- change here is invisible to v3 → zero v3 impact. Applied human-controlled with a
-- prior backup (AUTO_MIGRATE=0, DR=0).

ALTER TABLE marketplace_skill_listings
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'skill'
    CHECK (kind IN ('skill', 'agent'));

ALTER TABLE marketplace_skill_versions
  ADD COLUMN IF NOT EXISTS raw_artifact TEXT,
  ADD COLUMN IF NOT EXISTS manifest     JSONB;

-- backfill the generic artifact column from the existing skill column
UPDATE marketplace_skill_versions
   SET raw_artifact = raw_skill_md
 WHERE raw_artifact IS NULL;

ALTER TABLE marketplace_skill_versions
  ALTER COLUMN raw_artifact SET NOT NULL;

-- agents have no SKILL.md → allow NULL (skills still always set it)
ALTER TABLE marketplace_skill_versions
  ALTER COLUMN raw_skill_md DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mkt_listings_kind ON marketplace_skill_listings (kind);
