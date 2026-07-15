-- 0152 — Agent capability graph: typed requirements + provenance-aware bindings.
--
-- Public manifests call connector artifacts "plugins". Storage deliberately keeps
-- the historical kind value "connector"; every FK below therefore uses
-- (slug, kind), preventing a manifest kind typo from binding another artifact type.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'marketplace_skill_listings'::regclass
       AND conname = 'marketplace_listings_slug_kind_key'
  ) THEN
    ALTER TABLE marketplace_skill_listings
      ADD CONSTRAINT marketplace_listings_slug_kind_key UNIQUE (slug, kind);
  END IF;
END $$;

CREATE TABLE marketplace_capability_requirements (
  agent_version_id BIGINT NOT NULL
    REFERENCES marketplace_skill_versions(id) ON DELETE CASCADE,
  capability_slug TEXT NOT NULL,
  capability_kind TEXT NOT NULL CHECK (capability_kind IN ('skill', 'connector')),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_version_id, capability_slug, capability_kind),
  CONSTRAINT marketplace_requirement_capability_fk
    FOREIGN KEY (capability_slug, capability_kind)
    REFERENCES marketplace_skill_listings(slug, kind) ON DELETE CASCADE
);

CREATE INDEX marketplace_capability_requirements_slug_idx
  ON marketplace_capability_requirements(capability_slug, capability_kind);

-- Old source only understands Agent.manifest.skillDeps and its runtime reader
-- accepts an installed Agent when install.artifact_hash = version.artifact_hash.
-- A required Plugin cannot be represented in skillDeps, so keep a deterministic
-- mismatch in the legacy projection. New source recognizes this exact marker and
-- still evaluates the normalized readiness graph; a source rollback simply hides
-- the Agent instead of executing it without its required Plugin.
CREATE FUNCTION marketplace_required_plugin_legacy_gate_hash(canonical_hash TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT 'required-plugin-rollback-gate:' || canonical_hash
$$;

CREATE TABLE marketplace_agent_capability_bindings (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_slug TEXT NOT NULL
    CHECK (agent_slug ~ '^[A-Za-z0-9_-]+$'),
  capability_slug TEXT NOT NULL,
  capability_kind TEXT NOT NULL CHECK (capability_kind IN ('skill', 'connector')),
  source TEXT NOT NULL CHECK (source IN ('manual', 'agent_dependency')),
  source_agent_version_id BIGINT
    REFERENCES marketplace_skill_versions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, agent_slug, capability_slug, capability_kind, source),
  CONSTRAINT marketplace_binding_capability_fk
    FOREIGN KEY (capability_slug, capability_kind)
    REFERENCES marketplace_skill_listings(slug, kind) ON DELETE CASCADE,
  CONSTRAINT marketplace_binding_source_shape CHECK (
    (source = 'manual' AND source_agent_version_id IS NULL)
    OR
    (source = 'agent_dependency' AND source_agent_version_id IS NOT NULL)
  )
);

CREATE INDEX marketplace_agent_capability_bindings_capability_idx
  ON marketplace_agent_capability_bindings(user_id, capability_slug, capability_kind);
CREATE INDEX marketplace_agent_capability_bindings_agent_idx
  ON marketplace_agent_capability_bindings(user_id, agent_slug);

-- Historical Agent versions only had skillDeps. Prefer typed capabilities if a
-- partially rolled-forward row already contains them; otherwise project skillDeps.
WITH agent_refs AS (
  SELECT v.id AS agent_version_id,
         ref->>'slug' AS capability_slug,
         CASE ref->>'kind' WHEN 'plugin' THEN 'connector' ELSE 'skill' END AS capability_kind,
         CASE WHEN ref->>'optional' = 'true' THEN FALSE ELSE TRUE END AS required
    FROM marketplace_skill_versions v
    JOIN marketplace_skill_listings a ON a.slug = v.slug AND a.kind = 'agent'
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(v.manifest->'capabilities') = 'array'
           THEN v.manifest->'capabilities' ELSE '[]'::jsonb END
    ) ref
  UNION ALL
  SELECT v.id, dep.slug, 'skill', TRUE
    FROM marketplace_skill_versions v
    JOIN marketplace_skill_listings a ON a.slug = v.slug AND a.kind = 'agent'
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(v.manifest->'skillDeps') = 'array'
           THEN v.manifest->'skillDeps' ELSE '[]'::jsonb END
    ) dep(slug)
   WHERE jsonb_typeof(v.manifest->'capabilities') IS DISTINCT FROM 'array'
)
INSERT INTO marketplace_capability_requirements
  (agent_version_id, capability_slug, capability_kind, required)
SELECT DISTINCT r.agent_version_id, r.capability_slug, r.capability_kind, r.required
  FROM agent_refs r
  JOIN marketplace_skill_listings c
    ON c.slug = r.capability_slug AND c.kind = r.capability_kind
 WHERE r.capability_slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'
ON CONFLICT DO NOTHING;

-- Cover partially rolled-forward rows before the compatibility trigger exists.
-- This is intentionally permanent for the rollback window: even an authorized
-- required-Plugin Agent stays hidden from old source, while new source can admit
-- it after checking the complete graph on every runtime projection.
UPDATE marketplace_installs i
   SET artifact_hash = marketplace_required_plugin_legacy_gate_hash(v.artifact_hash)
  FROM marketplace_skill_versions v, marketplace_skill_listings l
 WHERE i.version_id = v.id
   AND i.slug = l.slug
   AND l.kind = 'agent'
   AND i.uninstalled_at IS NULL
   AND EXISTS (
     SELECT 1 FROM marketplace_capability_requirements r
      WHERE r.agent_version_id = i.version_id
        AND r.capability_kind = 'connector'
        AND r.required
   );

-- Existing install.agent_ids mix explicit user choices with legacy Agent
-- skillDeps that the old installer merged into the same JSON cache. A scope that
-- exactly matches an installed Agent's pinned requirement is inferred legacy
-- dependency provenance and must not also become manual; otherwise uninstalling
-- that Agent would leave a ghost assignment behind. Other scopes remain manual.
INSERT INTO marketplace_agent_capability_bindings
  (user_id, agent_slug, capability_slug, capability_kind, source, source_agent_version_id)
SELECT DISTINCT i.user_id, aid.agent_slug, i.slug, l.kind, 'manual', NULL::bigint
  FROM marketplace_installs i
  JOIN marketplace_skill_listings l ON l.slug = i.slug AND l.kind IN ('skill', 'connector')
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(i.agent_ids) = 'array' THEN i.agent_ids ELSE '["main"]'::jsonb END
  ) aid(agent_slug)
 WHERE i.uninstalled_at IS NULL
   AND aid.agent_slug ~ '^[A-Za-z0-9_-]+$'
   AND NOT EXISTS (
     SELECT 1
       FROM marketplace_installs ai
       JOIN marketplace_skill_listings al
         ON al.slug = ai.slug AND al.kind = 'agent'
       JOIN marketplace_capability_requirements ar
         ON ar.agent_version_id = ai.version_id
        AND ar.capability_slug = i.slug
        AND ar.capability_kind = l.kind
      WHERE ai.user_id = i.user_id
        AND ai.uninstalled_at IS NULL
        AND ai.slug = aid.agent_slug
   )
ON CONFLICT DO NOTHING;

-- An installed Agent expresses desired composition even if an old best-effort
-- installer failed to create one of the dependency install rows. Readiness will
-- report that missing artifact rather than silently claiming success.
INSERT INTO marketplace_agent_capability_bindings
  (user_id, agent_slug, capability_slug, capability_kind, source, source_agent_version_id)
SELECT i.user_id, i.slug, r.capability_slug, r.capability_kind,
       'agent_dependency', i.version_id
  FROM marketplace_installs i
  JOIN marketplace_skill_listings a ON a.slug = i.slug AND a.kind = 'agent'
  JOIN marketplace_capability_requirements r ON r.agent_version_id = i.version_id
 WHERE i.uninstalled_at IS NULL
ON CONFLICT (user_id, agent_slug, capability_slug, capability_kind, source)
DO UPDATE SET source_agent_version_id = EXCLUDED.source_agent_version_id;

-- Defensive fallback for malformed historical scopes. Every active capability
-- install must keep a non-empty legacy projection so a source rollback cannot
-- reinterpret [] as the default "main" scope.
INSERT INTO marketplace_agent_capability_bindings
  (user_id, agent_slug, capability_slug, capability_kind, source, source_agent_version_id)
SELECT i.user_id, 'main', i.slug, l.kind, 'manual', NULL::bigint
  FROM marketplace_installs i
  JOIN marketplace_skill_listings l ON l.slug = i.slug
 WHERE i.uninstalled_at IS NULL
   AND l.kind IN ('skill', 'connector')
   AND NOT EXISTS (
     SELECT 1 FROM marketplace_agent_capability_bindings b
      WHERE b.user_id = i.user_id
        AND b.capability_slug = i.slug
        AND b.capability_kind = l.kind
   )
ON CONFLICT DO NOTHING;

UPDATE marketplace_installs i
   SET agent_ids = COALESCE((
     SELECT jsonb_agg(x.agent_slug ORDER BY x.agent_slug)
       FROM (
         SELECT DISTINCT b.agent_slug
           FROM marketplace_agent_capability_bindings b
          WHERE b.user_id = i.user_id
            AND b.capability_slug = i.slug
            AND b.capability_kind = l.kind
       ) x
   ), '["main"]'::jsonb)
  FROM marketplace_skill_listings l
 WHERE i.slug = l.slug AND i.uninstalled_at IS NULL
   AND l.kind IN ('skill', 'connector');

-- Compatibility projection for the online cutover and source rollback window.
-- The previous release only writes manifest.skillDeps and install.agent_ids. The
-- triggers below keep those legacy writes synchronized with the normalized graph.
-- New source marks its transactions with openclaude.capability_writer=normalized
-- and performs the richer provenance writes itself.
CREATE FUNCTION marketplace_sync_agent_version_requirements()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM marketplace_capability_requirements
   WHERE agent_version_id = NEW.id;

  IF NOT EXISTS (
    SELECT 1 FROM marketplace_skill_listings l
     WHERE l.slug = NEW.slug AND l.kind = 'agent'
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO marketplace_capability_requirements
    (agent_version_id, capability_slug, capability_kind, required)
  SELECT DISTINCT NEW.id, r.capability_slug, r.capability_kind, r.required
    FROM (
      SELECT ref->>'slug' AS capability_slug,
             CASE ref->>'kind' WHEN 'plugin' THEN 'connector' ELSE 'skill' END
               AS capability_kind,
             CASE WHEN ref->>'optional' = 'true' THEN FALSE ELSE TRUE END AS required
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(NEW.manifest->'capabilities') = 'array'
               THEN NEW.manifest->'capabilities' ELSE '[]'::jsonb END
        ) ref
      UNION ALL
      SELECT dep.slug, 'skill', TRUE
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(NEW.manifest->'skillDeps') = 'array'
               THEN NEW.manifest->'skillDeps' ELSE '[]'::jsonb END
        ) dep(slug)
       WHERE jsonb_typeof(NEW.manifest->'capabilities') IS DISTINCT FROM 'array'
    ) r
    JOIN marketplace_skill_listings c
      ON c.slug = r.capability_slug AND c.kind = r.capability_kind
   WHERE r.capability_slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'
  ON CONFLICT (agent_version_id, capability_slug, capability_kind)
  DO UPDATE SET required = EXCLUDED.required;
  RETURN NEW;
END $$;

CREATE TRIGGER marketplace_agent_version_requirements_insert
AFTER INSERT ON marketplace_skill_versions
FOR EACH ROW EXECUTE FUNCTION marketplace_sync_agent_version_requirements();

CREATE TRIGGER marketplace_agent_version_requirements_update
AFTER UPDATE OF manifest, slug ON marketplace_skill_versions
FOR EACH ROW EXECUTE FUNCTION marketplace_sync_agent_version_requirements();

-- Preserve the same old-readable fail-closed gate for both new and rolled-back
-- installers. This trigger deliberately does not honor capability_writer: the
-- normalized source needs the marker too so an emergency source rollback cannot
-- reactivate the Agent. New readers return the canonical version hash only after
-- recognizing this exact marker and applying readiness checks.
CREATE FUNCTION marketplace_guard_required_plugin_agent_install()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  canonical_hash TEXT;
BEGIN
  SELECT v.artifact_hash INTO canonical_hash
    FROM marketplace_skill_versions v
    JOIN marketplace_skill_listings l ON l.slug = v.slug AND l.kind = 'agent'
   WHERE v.id = NEW.version_id
     AND EXISTS (
       SELECT 1 FROM marketplace_capability_requirements r
        WHERE r.agent_version_id = v.id
          AND r.capability_kind = 'connector'
          AND r.required
     );

  IF canonical_hash IS NOT NULL THEN
    NEW.artifact_hash := marketplace_required_plugin_legacy_gate_hash(canonical_hash);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER marketplace_required_plugin_agent_install_guard
BEFORE INSERT OR UPDATE OF version_id, artifact_hash, uninstalled_at
ON marketplace_installs
FOR EACH ROW EXECUTE FUNCTION marketplace_guard_required_plugin_agent_install();

CREATE FUNCTION marketplace_sync_legacy_install_bindings()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  listing_kind TEXT;
  old_manual_agent_ids TEXT[];
BEGIN
  IF pg_trigger_depth() > 1
     OR current_setting('openclaude.capability_writer', TRUE) = 'normalized' THEN
    RETURN NEW;
  END IF;

  SELECT kind INTO listing_kind
    FROM marketplace_skill_listings WHERE slug = NEW.slug;

  IF listing_kind = 'agent' THEN
    DELETE FROM marketplace_agent_capability_bindings
     WHERE user_id = NEW.user_id
       AND agent_slug = NEW.slug
       AND source = 'agent_dependency';

    IF NEW.uninstalled_at IS NULL THEN
      INSERT INTO marketplace_agent_capability_bindings
        (user_id, agent_slug, capability_slug, capability_kind, source,
         source_agent_version_id)
      SELECT NEW.user_id, NEW.slug, r.capability_slug, r.capability_kind,
             'agent_dependency', NEW.version_id
        FROM marketplace_capability_requirements r
       WHERE r.agent_version_id = NEW.version_id
      ON CONFLICT (user_id, agent_slug, capability_slug, capability_kind, source)
      DO UPDATE SET source_agent_version_id = EXCLUDED.source_agent_version_id;
    END IF;
  ELSIF listing_kind IN ('skill', 'connector') THEN
    SELECT COALESCE(array_agg(agent_slug ORDER BY agent_slug), ARRAY[]::TEXT[])
      INTO old_manual_agent_ids
      FROM marketplace_agent_capability_bindings
     WHERE user_id = NEW.user_id
       AND capability_slug = NEW.slug
       AND capability_kind = listing_kind
       AND source = 'manual';

    IF NEW.uninstalled_at IS NULL THEN
      -- Keep manual provenance across the previous release's re-pin sequence
      -- (soft-delete old row, insert replacement in the same transaction). The
      -- soft-delete branch deliberately leaves these rows in place; the deferred
      -- reconcile trigger removes them at commit only when no active replacement
      -- exists. The insert can therefore distinguish a genuine manual+dependency
      -- dual binding from a dependency-only compatibility scope.
      DELETE FROM marketplace_agent_capability_bindings
       WHERE user_id = NEW.user_id
         AND capability_slug = NEW.slug
         AND capability_kind = listing_kind
         AND source = 'manual';

      INSERT INTO marketplace_agent_capability_bindings
        (user_id, agent_slug, capability_slug, capability_kind, source,
         source_agent_version_id)
      SELECT DISTINCT NEW.user_id, aid.agent_slug, NEW.slug, listing_kind,
             'manual', NULL::bigint
       FROM jsonb_array_elements_text(NEW.agent_ids) aid(agent_slug)
       WHERE aid.agent_slug ~ '^[A-Za-z0-9_-]+$'
         AND (
           aid.agent_slug = ANY(old_manual_agent_ids)
           OR NOT EXISTS (
             SELECT 1
               FROM marketplace_installs ai
               JOIN marketplace_skill_listings al
                 ON al.slug = ai.slug AND al.kind = 'agent'
               JOIN marketplace_capability_requirements ar
                 ON ar.agent_version_id = ai.version_id
                AND ar.capability_slug = NEW.slug
                AND ar.capability_kind = listing_kind
              WHERE ai.user_id = NEW.user_id
                AND ai.uninstalled_at IS NULL
                AND ai.slug = aid.agent_slug
           )
         )
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER marketplace_legacy_install_bindings
AFTER INSERT OR UPDATE OF agent_ids, uninstalled_at, version_id
ON marketplace_installs
FOR EACH ROW EXECUTE FUNCTION marketplace_sync_legacy_install_bindings();

-- Reconcile at transaction end, not in the row trigger: the old installer updates
-- an Agent by soft-deleting one row and inserting its replacement in one transaction.
-- Deferral avoids briefly garbage-collecting dependencies between those two writes.
CREATE FUNCTION marketplace_reconcile_legacy_install_scopes()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('openclaude.capability_writer', TRUE) = 'normalized' THEN
    RETURN NULL;
  END IF;

  -- A legacy capability re-pin soft-deletes then reinserts. Row-level cleanup
  -- would erase manual provenance before the replacement sees the compatibility
  -- union, so cleanup is deferred until the transaction can prove no active
  -- replacement exists. True uninstalls still remove all manual bindings here.
  DELETE FROM marketplace_agent_capability_bindings b
   USING marketplace_skill_listings l
   WHERE b.user_id = NEW.user_id
     AND b.capability_slug = l.slug
     AND b.capability_kind = l.kind
     AND b.source = 'manual'
     AND l.kind IN ('skill', 'connector')
     AND NOT EXISTS (
       SELECT 1 FROM marketplace_installs i
        WHERE i.user_id = b.user_id
          AND i.slug = b.capability_slug
          AND i.uninstalled_at IS NULL
     );

  WITH scopes AS (
    SELECT x.user_id, x.capability_slug, x.capability_kind,
           jsonb_agg(x.agent_slug ORDER BY x.agent_slug) AS agent_ids
      FROM (
        SELECT DISTINCT b.user_id, b.capability_slug, b.capability_kind, b.agent_slug
          FROM marketplace_agent_capability_bindings b
         WHERE b.user_id = NEW.user_id
      ) x
     GROUP BY x.user_id, x.capability_slug, x.capability_kind
  )
  UPDATE marketplace_installs i
     SET agent_ids = scopes.agent_ids
    FROM marketplace_skill_listings l, scopes
   WHERE i.user_id = NEW.user_id
     AND i.slug = l.slug
     AND l.kind IN ('skill', 'connector')
     AND i.uninstalled_at IS NULL
     AND scopes.user_id = i.user_id
     AND scopes.capability_slug = i.slug
     AND scopes.capability_kind = l.kind
     AND i.agent_ids IS DISTINCT FROM scopes.agent_ids;

  -- Plugins are account-level entitlements. Retain them after the last Agent
  -- composition disappears so an existing authorized connection remains executable;
  -- direct Plugin uninstall already requires accounts to be unbound first.
  UPDATE marketplace_installs i
     SET agent_ids = '["main"]'::jsonb
    FROM marketplace_skill_listings l
   WHERE i.user_id = NEW.user_id
     AND i.slug = l.slug
     AND l.kind = 'connector'
     AND i.uninstalled_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM marketplace_agent_capability_bindings b
        WHERE b.user_id = i.user_id
          AND b.capability_slug = i.slug
          AND b.capability_kind = l.kind
     )
     AND i.agent_ids IS DISTINCT FROM '["main"]'::jsonb;

  -- Auto-installed Skills without any remaining manual/Agent provenance are
  -- soft-deleted (audit retained). This keeps the legacy non-empty scope invariant
  -- and makes a rollback reader safe instead of reactivating them for "main".
  UPDATE marketplace_installs i
     SET uninstalled_at = NOW()
    FROM marketplace_skill_listings l
   WHERE i.user_id = NEW.user_id
     AND i.slug = l.slug
     AND l.kind = 'skill'
     AND i.uninstalled_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM marketplace_agent_capability_bindings b
        WHERE b.user_id = i.user_id
          AND b.capability_slug = i.slug
          AND b.capability_kind = l.kind
     );

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER marketplace_legacy_install_scope_reconcile
AFTER INSERT OR UPDATE ON marketplace_installs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION marketplace_reconcile_legacy_install_scopes();

COMMENT ON TABLE marketplace_capability_requirements IS
  'Immutable typed Skill/Plugin requirements pinned to an Agent marketplace version.';
COMMENT ON TABLE marketplace_agent_capability_bindings IS
  'Composition/readiness metadata only; not a connector authorization boundary.';
