-- Skill marketplace install ownership scope (v5): which agent(s) an installed
-- skill is materialized for. Existing installs default to the generalist.
ALTER TABLE marketplace_installs
  ADD COLUMN IF NOT EXISTS agent_ids JSONB NOT NULL DEFAULT '["main"]'::jsonb;

UPDATE marketplace_installs
   SET agent_ids = '["main"]'::jsonb
 WHERE jsonb_typeof(agent_ids) <> 'array'
    OR jsonb_array_length(agent_ids) = 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_marketplace_installs_agent_ids_nonempty'
  ) THEN
    ALTER TABLE marketplace_installs
      ADD CONSTRAINT ck_marketplace_installs_agent_ids_nonempty
      CHECK (jsonb_typeof(agent_ids) = 'array' AND jsonb_array_length(agent_ids) > 0);
  END IF;
END $$;
