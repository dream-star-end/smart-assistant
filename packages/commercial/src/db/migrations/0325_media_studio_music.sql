-- order-dependency: 0324_media_studio
-- 0325_media_studio_music.sql (commercial; OCV5-591 M1, media studio music sources)
-- Music sources under the studio provider registry (user decision 2026-10-23 14:11, MUSIC-PLAN):
--   * studio_music_catalog: the site-wide curated royalty-free library. Every row was verified by
--     hand: licence, attribution and a snapshot of the source page (evidence_sha) are stored with it.
--     Rows are retired (active = FALSE), never deleted while a project used them; projects keep the
--     licence snapshot copied into their music take.
--   * studio_user_tracks: a user's own music, reusable across projects, with the user's rights
--     statement. Its audio is held by an 'upload' blob ref whose ref_id is the track id.
-- Catalog audio and evidence belong to no user: the blob GC skips any sha the catalog references,
-- and the FKs below (ON DELETE RESTRICT) refuse to drop such a blob.
-- Retention: catalog rows are site data kept as licence evidence; user tracks are user-owned data
-- removed with the user (FK cascade).
-- Rollback: db/rollbacks/0325_media_studio_music.sql.

-- compat: additive tables; old binaries never read or write them
CREATE TABLE IF NOT EXISTS studio_music_catalog (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  artist TEXT NOT NULL CHECK (length(artist) BETWEEN 1 AND 200),
  source TEXT NOT NULL CHECK (source IN ('openverse','pixabay','incompetech','other')),
  source_track_id TEXT NOT NULL CHECK (length(source_track_id) BETWEEN 1 AND 200),
  landing_url TEXT NOT NULL CHECK (landing_url ~ '^https://' AND length(landing_url) <= 2000),
  license TEXT NOT NULL CHECK (license IN ('CC0-1.0','CC-BY-3.0','CC-BY-4.0','PIXABAY-CL')),
  license_url TEXT NOT NULL CHECK (license_url ~ '^https://' AND length(license_url) <= 2000),
  attribution_required BOOLEAN NOT NULL,
  attribution_text TEXT NOT NULL DEFAULT '' CHECK (length(attribution_text) <= 1000),
  duration_ms INT NOT NULL CHECK (duration_ms BETWEEN 1000 AND 1800000),
  bpm NUMERIC(5,1) CHECK (bpm IS NULL OR bpm BETWEEN 20 AND 300),
  musical_key TEXT CHECK (musical_key IS NULL OR length(musical_key) <= 8),
  moods TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(moods) <= 12),
  genres TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(genres) <= 12),
  vocals BOOLEAN NOT NULL DEFAULT FALSE,
  blob_sha TEXT NOT NULL REFERENCES studio_blobs(sha256) ON DELETE RESTRICT,
  mime TEXT NOT NULL CHECK (mime IN ('audio/mpeg','audio/wav','audio/ogg','audio/flac')),
  -- Snapshot (screenshot) of the source page as it read when the licence was verified.
  evidence_sha TEXT NOT NULL REFERENCES studio_blobs(sha256) ON DELETE RESTRICT,
  -- {licenseTextSeen, pageTitle, notes}: what the verifier read on the page, verbatim where short.
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  verified_at TIMESTAMPTZ NOT NULL,
  verified_by TEXT NOT NULL CHECK (length(verified_by) BETWEEN 1 AND 100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  retired_reason TEXT CHECK (retired_reason IS NULL OR length(retired_reason) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_track_id),
  CHECK (NOT attribution_required OR attribution_text <> ''),
  CHECK (license <> 'CC0-1.0' OR NOT attribution_required),
  CHECK (license NOT IN ('CC-BY-3.0','CC-BY-4.0') OR attribution_required),
  CHECK (active OR retired_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS studio_music_catalog_bpm_idx ON studio_music_catalog (active, bpm);
CREATE INDEX IF NOT EXISTS studio_music_catalog_moods_idx ON studio_music_catalog USING GIN (moods);
CREATE INDEX IF NOT EXISTS studio_music_catalog_genres_idx ON studio_music_catalog USING GIN (genres);
CREATE INDEX IF NOT EXISTS studio_music_catalog_blob_idx ON studio_music_catalog (blob_sha);
CREATE INDEX IF NOT EXISTS studio_music_catalog_evidence_idx ON studio_music_catalog (evidence_sha);

CREATE TABLE IF NOT EXISTS studio_user_tracks (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  blob_sha TEXT NOT NULL CHECK (blob_sha ~ '^[0-9a-f]{64}$'),
  mime TEXT NOT NULL CHECK (mime IN ('audio/mpeg','audio/wav')),
  duration_ms INT CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 1800000),
  bpm NUMERIC(5,1) CHECK (bpm IS NULL OR bpm BETWEEN 20 AND 300),
  -- {statement: 'own_or_licensed', acceptedAt, note?}: the uploader's statement, required.
  rights_statement JSONB NOT NULL
    CHECK (COALESCE(rights_statement->>'statement', '') = 'own_or_licensed'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS studio_user_tracks_user_idx ON studio_user_tracks (user_id, created_at DESC)
  WHERE deleted_at IS NULL;
