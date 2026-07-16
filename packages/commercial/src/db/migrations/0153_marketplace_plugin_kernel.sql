-- 0153 — Marketplace Plugin kernel: immutable subtype, signature scheme and
-- catalog invalidation revision.
--
-- Rolling-deploy contract:
--   * the old source only knows kind='connector' and legacy connector signatures;
--   * while the old source is still serving, compatibility triggers fill
--     plugin_type='declarative-http' and signature_scheme='connector-v1';
--   * this release reads both connector-v1 and plugin-v2, but keeps writing v1.
--     A later release may enable the v2 writer only after this release is the
--     rollback floor.

-- ─── Listing subtype ───────────────────────────────────────────────────────

ALTER TABLE marketplace_skill_listings
  ADD COLUMN IF NOT EXISTS plugin_type TEXT;

CREATE OR REPLACE FUNCTION marketplace_fill_legacy_plugin_type()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'connector' AND NEW.plugin_type IS NULL THEN
    NEW.plugin_type := 'declarative-http';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS marketplace_fill_legacy_plugin_type_trg
  ON marketplace_skill_listings;
CREATE TRIGGER marketplace_fill_legacy_plugin_type_trg
BEFORE INSERT OR UPDATE OF kind, plugin_type
ON marketplace_skill_listings
FOR EACH ROW EXECUTE FUNCTION marketplace_fill_legacy_plugin_type();

UPDATE marketplace_skill_listings
   SET plugin_type = 'declarative-http'
 WHERE kind = 'connector' AND plugin_type IS NULL;

ALTER TABLE marketplace_skill_listings
  ADD CONSTRAINT marketplace_listing_plugin_type_shape
  CHECK (
    (kind = 'connector' AND plugin_type IN
      ('declarative-http', 'sandboxed-local', 'managed-browser'))
    OR
    (kind IN ('skill', 'agent') AND plugin_type IS NULL)
  ) NOT VALID;
ALTER TABLE marketplace_skill_listings
  VALIDATE CONSTRAINT marketplace_listing_plugin_type_shape;

CREATE OR REPLACE FUNCTION marketplace_listing_identity_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind IS DISTINCT FROM NEW.kind
     OR OLD.plugin_type IS DISTINCT FROM NEW.plugin_type THEN
    RAISE EXCEPTION 'marketplace listing kind/plugin_type is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS marketplace_listing_identity_immutable_trg
  ON marketplace_skill_listings;
CREATE TRIGGER marketplace_listing_identity_immutable_trg
BEFORE UPDATE OF kind, plugin_type
ON marketplace_skill_listings
FOR EACH ROW EXECUTE FUNCTION marketplace_listing_identity_immutable();

-- ─── Version signature scheme ─────────────────────────────────────────────

ALTER TABLE marketplace_skill_versions
  ADD COLUMN IF NOT EXISTS signature_scheme TEXT;

CREATE OR REPLACE FUNCTION marketplace_fill_legacy_signature_scheme()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  listing_kind TEXT;
  listing_plugin_type TEXT;
BEGIN
  IF NEW.signature IS NOT NULL AND NEW.signature_scheme IS NULL THEN
    SELECT kind, plugin_type
      INTO listing_kind, listing_plugin_type
      FROM marketplace_skill_listings
     WHERE slug = NEW.slug;
    IF listing_kind = 'connector' AND listing_plugin_type = 'declarative-http' THEN
      NEW.signature_scheme := 'connector-v1';
    ELSE
      RAISE EXCEPTION 'legacy connector signature is only valid for declarative-http plugins'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS marketplace_fill_legacy_signature_scheme_trg
  ON marketplace_skill_versions;
CREATE TRIGGER marketplace_fill_legacy_signature_scheme_trg
BEFORE INSERT OR UPDATE OF signature, signature_scheme
ON marketplace_skill_versions
FOR EACH ROW EXECUTE FUNCTION marketplace_fill_legacy_signature_scheme();

UPDATE marketplace_skill_versions v
   SET signature_scheme = 'connector-v1'
  FROM marketplace_skill_listings l
 WHERE l.slug = v.slug
   AND l.kind = 'connector'
   AND l.plugin_type = 'declarative-http'
   AND v.signature IS NOT NULL
   AND v.signature_scheme IS NULL;

ALTER TABLE marketplace_skill_versions
  ADD CONSTRAINT marketplace_version_signature_scheme_value
  CHECK (signature_scheme IS NULL OR signature_scheme IN ('connector-v1', 'plugin-v2'))
  NOT VALID;
ALTER TABLE marketplace_skill_versions
  VALIDATE CONSTRAINT marketplace_version_signature_scheme_value;

-- Cross-table shape cannot be expressed as a normal CHECK. This trigger also
-- prevents an old binary from rewriting plugin-v2 trust columns: the future v2
-- writer must opt into a marker bound to the current transaction id before its
-- atomic write. Binding the xid prevents a session-level SET from leaking
-- authorization through a pooled connection into a later transaction.
CREATE OR REPLACE FUNCTION marketplace_validate_signature_scheme()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  listing_kind TEXT;
  listing_plugin_type TEXT;
  trust_changed BOOLEAN;
BEGIN
  SELECT kind, plugin_type
    INTO listing_kind, listing_plugin_type
    FROM marketplace_skill_listings
   WHERE slug = NEW.slug;

  IF listing_kind IS NULL THEN
    RAISE EXCEPTION 'marketplace listing missing for signed version'
      USING ERRCODE = '23503';
  END IF;

  IF listing_kind <> 'connector' AND NEW.signature_scheme IS NOT NULL THEN
    RAISE EXCEPTION 'non-plugin marketplace version cannot have a plugin signature scheme'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.signature_scheme = 'connector-v1'
     AND (listing_kind <> 'connector' OR listing_plugin_type <> 'declarative-http') THEN
    RAISE EXCEPTION 'connector-v1 signature requires declarative-http plugin type'
      USING ERRCODE = '23514';
  END IF;

  IF listing_kind = 'connector' AND NEW.status = 'approved'
     AND NEW.signature_scheme IS NULL THEN
    RAISE EXCEPTION 'approved plugin version requires a signature scheme'
      USING ERRCODE = '23514';
  END IF;

  trust_changed := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    trust_changed :=
      OLD.exec_contract IS DISTINCT FROM NEW.exec_contract
      OR OLD.exec_contract_hash IS DISTINCT FROM NEW.exec_contract_hash
      OR OLD.compiler_version IS DISTINCT FROM NEW.compiler_version
      OR OLD.security_policy_version IS DISTINCT FROM NEW.security_policy_version
      OR OLD.signature IS DISTINCT FROM NEW.signature
      OR OLD.key_id IS DISTINCT FROM NEW.key_id
      OR OLD.signature_scheme IS DISTINCT FROM NEW.signature_scheme;
  END IF;

  IF NEW.signature_scheme = 'plugin-v2' AND trust_changed
     AND COALESCE(current_setting('openclaude.plugin_signature_writer', TRUE), '')
       <> ('plugin-v2:' || pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'plugin-v2 trust write requires explicit transaction writer gate'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS marketplace_validate_signature_scheme_trg
  ON marketplace_skill_versions;
CREATE CONSTRAINT TRIGGER marketplace_validate_signature_scheme_trg
AFTER INSERT OR UPDATE OF status, signature_scheme, exec_contract, exec_contract_hash,
  compiler_version, security_policy_version, signature, key_id
ON marketplace_skill_versions
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION marketplace_validate_signature_scheme();

-- ─── Opaque catalog invalidation revision ─────────────────────────────────
--
-- This is deliberately a change token, not an event counter. A single
-- transaction that mutates several rows may increment it several times; clients
-- only compare equality. Transaction rollback rolls back every increment.

CREATE TABLE IF NOT EXISTS marketplace_catalog_revision (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO marketplace_catalog_revision(singleton, revision)
VALUES (TRUE, 1)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION marketplace_bump_catalog_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE marketplace_catalog_revision
     SET revision = revision + 1,
         updated_at = NOW()
   WHERE singleton = TRUE;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS marketplace_listing_revision_trg
  ON marketplace_skill_listings;
CREATE TRIGGER marketplace_listing_revision_trg
AFTER INSERT OR UPDATE OR DELETE
ON marketplace_skill_listings
FOR EACH ROW EXECUTE FUNCTION marketplace_bump_catalog_revision();

DROP TRIGGER IF EXISTS marketplace_version_revision_trg
  ON marketplace_skill_versions;
CREATE TRIGGER marketplace_version_revision_trg
AFTER INSERT OR UPDATE OR DELETE
ON marketplace_skill_versions
FOR EACH ROW EXECUTE FUNCTION marketplace_bump_catalog_revision();

COMMENT ON COLUMN marketplace_skill_listings.plugin_type IS
  'Public Plugin subtype. Historical storage kind remains connector; immutable per listing.';
COMMENT ON COLUMN marketplace_skill_versions.signature_scheme IS
  'connector-v1 preserves historical signed bytes; plugin-v2 additionally binds plugin_type.';
COMMENT ON TABLE marketplace_catalog_revision IS
  'Opaque marketplace invalidation token; consumers compare only equality, never deltas.';
