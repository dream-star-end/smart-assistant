-- OCV5-763: forward-only selfhost compatibility for the frozen commercial schema.
-- order-dependency: 0339_remote_driver_core_v4
-- 0340_commercial_sync_compat belongs to the independent commercial migration history.
-- Do not import that migration, commercial catalog seeds, accounts, prices or user data.
-- compat: additive empty Studio tables and nullable Muse billing columns; widened ledger CHECK.
-- No Muse price is configured and Studio enablement is unchanged. DDL does not authorize charges.
-- Existing selfhost migration bytes/versions are immutable. Code rollback keeps new structures/data.
-- Scope explicitly approved in OCV5-763; production apply still needs official DDL gates.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- sync-section: 0319_commercial_muse_billing
-- compat: All new billing fields are nullable; legacy Muse inserts omit them and keep NULL, without any quote or charge.
ALTER TABLE muse_media_jobs
  -- The quote at admission: open jobs' quotes are summed for the balance check across both A/B slots.
  ADD COLUMN IF NOT EXISTS price_credits BIGINT CHECK (price_credits IS NULL OR price_credits >= 0),
  ADD COLUMN IF NOT EXISTS cost_credits BIGINT CHECK (cost_credits IS NULL OR cost_credits >= 0),
  ADD COLUMN IF NOT EXISTS debited_credits BIGINT CHECK (debited_credits IS NULL OR debited_credits >= 0),
  ADD COLUMN IF NOT EXISTS price_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS ledger_id BIGINT REFERENCES credit_ledger(id) ON DELETE SET NULL;

-- Only a succeeded job is ever charged.
-- compat: Replace the charge guard in this same transaction; no billing data is updated and all old NULL-cost rows stay valid.
ALTER TABLE muse_media_jobs DROP CONSTRAINT IF EXISTS muse_media_jobs_charge_only_succeeded;
-- compat: NULL cost remains valid for every old status; only succeeded jobs may carry a cost. Legacy writes are unchanged.
ALTER TABLE muse_media_jobs ADD CONSTRAINT muse_media_jobs_charge_only_succeeded
  CHECK (cost_credits IS NULL OR status = 'succeeded');

-- Site-wide daily counts (OC_MUSE_GLOBAL_*_PER_DAY).
CREATE INDEX IF NOT EXISTS muse_media_jobs_kind_queued_idx ON muse_media_jobs (kind, queued_at DESC);

-- compat: Transactional replacement only; the next CHECK retains all legacy reasons and adds the approved new reasons without editing rows.
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_reason_check;
-- compat: Strict superset of existing reason encodings; old readers and writers keep their existing values and no balances or ledger rows are changed.
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check CHECK (reason IN (
  'topup','chat','agent_chat','agent_subscription','refund','admin_adjust','promotion',
  'minimax_media','image_generation','subscription','subscription_expire','pack','muse_media'
)) NOT VALID;
-- compat: Validate the widened CHECK against existing rows; all legacy reason values remain accepted and invalid reasons remain rejected.
ALTER TABLE credit_ledger VALIDATE CONSTRAINT credit_ledger_reason_check;
-- end-sync-section: 0319_commercial_muse_billing

-- sync-section: 0324_media_studio
CREATE TABLE IF NOT EXISTS studio_projects (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 200),
  brief TEXT NOT NULL DEFAULT '' CHECK (length(brief) <= 4000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','planning','running','awaiting_user','composing','done','failed','paused','canceled'
  )),
  autonomy TEXT NOT NULL DEFAULT 'max' CHECK (autonomy IN ('max','confirm')),
  aspect TEXT NOT NULL DEFAULT '16:9' CHECK (aspect IN ('16:9','9:16','1:1')),
  fps INT NOT NULL DEFAULT 24 CHECK (fps BETWEEN 12 AND 60),
  target_sec INT NOT NULL DEFAULT 30 CHECK (target_sec BETWEEN 5 AND 600),
  budget_credits BIGINT NOT NULL DEFAULT 2000 CHECK (budget_credits >= 0),
  spent_credits BIGINT NOT NULL DEFAULT 0 CHECK (spent_credits >= 0),
  reserved_credits BIGINT NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  rev INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS studio_projects_user_idx
  ON studio_projects (user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS studio_projects_deleted_idx
  ON studio_projects (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS studio_assets (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('character','scene','style','voice','reference','upload')),
  name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 200),
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  descriptor TEXT NOT NULL DEFAULT '' CHECK (length(descriptor) <= 4000),
  blob_sha TEXT CHECK (blob_sha IS NULL OR blob_sha ~ '^[0-9a-f]{64}$'),
  voice_id TEXT CHECK (voice_id IS NULL OR length(voice_id) <= 128),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS studio_assets_project_idx ON studio_assets (project_id, kind);

CREATE TABLE IF NOT EXISTS studio_shots (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  ordinal INT NOT NULL CHECK (ordinal >= 0),
  spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','generating','qa','needs_user','ready','failed')),
  active_take_id UUID,
  CONSTRAINT studio_shots_ordinal_uq UNIQUE (project_id, ordinal) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE TABLE IF NOT EXISTS studio_lines (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  shot_id UUID REFERENCES studio_shots(id) ON DELETE SET NULL,
  ordinal INT NOT NULL CHECK (ordinal >= 0),
  speaker_asset_id UUID REFERENCES studio_assets(id) ON DELETE SET NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  emotion TEXT CHECK (emotion IS NULL OR length(emotion) <= 32),
  speed NUMERIC(3,2) CHECK (speed IS NULL OR speed BETWEEN 0.5 AND 2.0),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','generating','needs_user','ready','failed')),
  active_take_id UUID,
  CONSTRAINT studio_lines_ordinal_uq UNIQUE (project_id, ordinal) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE TABLE IF NOT EXISTS studio_takes (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('shot_frame','shot_video','line','music','bible','final')),
  owner_id UUID NOT NULL,
  version INT NOT NULL CHECK (version >= 1),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  model TEXT NOT NULL DEFAULT '' CHECK (length(model) <= 64),
  op TEXT NOT NULL CHECK (length(op) BETWEEN 1 AND 32),
  inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt TEXT CHECK (prompt IS NULL OR length(prompt) <= 8000),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  cost_credits BIGINT NOT NULL DEFAULT 0 CHECK (cost_credits >= 0),
  -- {table, id} pointing at the provider ledger row this take was charged through.
  provider_ref JSONB,
  qa JSONB,
  blob_sha TEXT CHECK (blob_sha IS NULL OR blob_sha ~ '^[0-9a-f]{64}$'),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  UNIQUE (owner_kind, owner_id, version)
);
CREATE INDEX IF NOT EXISTS studio_takes_project_idx ON studio_takes (project_id, created_at);
-- GC: unadopted finished takes older than 30 days.
CREATE INDEX IF NOT EXISTS studio_takes_finished_idx
  ON studio_takes (finished_at) WHERE finished_at IS NOT NULL AND blob_sha IS NOT NULL;

CREATE TABLE IF NOT EXISTS studio_annotations (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('shot','line','music','final','asset')),
  target_id UUID NOT NULL,
  take_id UUID REFERENCES studio_takes(id) ON DELETE SET NULL,
  author TEXT NOT NULL CHECK (author IN ('user','agent')),
  kind TEXT NOT NULL CHECK (kind IN ('point','box','brush','range','text')),
  t_start_ms INT CHECK (t_start_ms IS NULL OR t_start_ms >= 0),
  t_end_ms INT CHECK (t_end_ms IS NULL OR t_end_ms >= 0),
  geom JSONB,
  text TEXT NOT NULL DEFAULT '' CHECK (length(text) <= 1000),
  frame_blob_sha TEXT CHECK (frame_blob_sha IS NULL OR frame_blob_sha ~ '^[0-9a-f]{64}$'),
  interpretation JSONB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','applied','rejected')),
  applied_take_id UUID REFERENCES studio_takes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (t_start_ms IS NULL OR t_end_ms IS NULL OR t_end_ms >= t_start_ms)
);
CREATE INDEX IF NOT EXISTS studio_annotations_project_idx ON studio_annotations (project_id, created_at);

-- Activity log and push source. 180-day TTL via auditRetentionSweeper.
CREATE TABLE IF NOT EXISTS studio_events (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type TEXT NOT NULL CHECK (type ~ '^[a-z][a-z0-9_.]{0,63}$'),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS studio_events_project_idx ON studio_events (project_id, id);
CREATE INDEX IF NOT EXISTS studio_events_ts_idx ON studio_events (ts);

CREATE TABLE IF NOT EXISTS studio_tasks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{0,63}$'),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','done','failed','canceled')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_epoch INT NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  affinity TEXT CHECK (affinity IS NULL OR affinity IN ('muse')),
  affinity_deadline TIMESTAMPTZ,
  -- Stable execution identity (studio:<task id>); never changes across re-claims.
  exec_request_id TEXT NOT NULL UNIQUE CHECK (length(exec_request_id) BETWEEN 1 AND 128),
  provider_job_ref JSONB,
  reserved_credits BIGINT NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((affinity IS NULL) = (affinity_deadline IS NULL))
);
CREATE INDEX IF NOT EXISTS studio_tasks_due_idx
  ON studio_tasks (run_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS studio_tasks_lease_idx
  ON studio_tasks (lease_until) WHERE status = 'leased';
CREATE INDEX IF NOT EXISTS studio_tasks_project_idx ON studio_tasks (project_id, status);

-- Physical content, owned by nobody.
CREATE TABLE IF NOT EXISTS studio_blobs (
  sha256 TEXT PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  mime TEXT NOT NULL CHECK (mime ~ '^[a-z]+/[a-z0-9.+-]{1,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ownership: the same content may belong to several users / objects.
CREATE TABLE IF NOT EXISTS studio_blob_refs (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL REFERENCES studio_blobs(sha256) ON DELETE RESTRICT,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('take','asset','annotation','upload','final')),
  ref_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, sha256, ref_kind, ref_id)
);
CREATE INDEX IF NOT EXISTS studio_blob_refs_sha_idx ON studio_blob_refs (sha256);
CREATE INDEX IF NOT EXISTS studio_blob_refs_ref_idx ON studio_blob_refs (ref_kind, ref_id);

-- used_bytes: 'site' = physical bytes stored once; 'u:<id>' = distinct shas the user references.
CREATE TABLE IF NOT EXISTS studio_quota (
  scope TEXT PRIMARY KEY CHECK (scope = 'site' OR scope ~ '^u:[1-9][0-9]{0,18}$'),
  used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  limit_bytes BIGINT NOT NULL CHECK (limit_bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- In-flight write reservations. Reserved bytes are the sum of live holds rather than a counter, so
-- a process that dies mid-write cannot leak reservation forever: its hold simply expires.
CREATE TABLE IF NOT EXISTS studio_quota_holds (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bytes BIGINT NOT NULL CHECK (bytes > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS studio_quota_holds_user_idx ON studio_quota_holds (user_id, expires_at);
CREATE INDEX IF NOT EXISTS studio_quota_holds_expires_idx ON studio_quota_holds (expires_at);

-- LLM step outputs written before settlement so a re-claim settles without calling upstream again.
CREATE TABLE IF NOT EXISTS studio_step_results (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 128),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES studio_tasks(id) ON DELETE SET NULL,
  output JSONB NOT NULL,
  blob_sha TEXT CHECK (blob_sha IS NULL OR blob_sha ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Studio-owned charges (compose, music). One row per (user, request_id); ledger reason 'media_studio'.
CREATE TABLE IF NOT EXISTS studio_charges (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES studio_projects(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN ('compose','music')),
  cost_credits BIGINT NOT NULL CHECK (cost_credits >= 0),
  ledger_id BIGINT REFERENCES credit_ledger(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, request_id)
);

-- compat: Transactional replacement only; the next CHECK retains all legacy reasons and adds the approved new reasons without editing rows.
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_reason_check;
-- compat: Strict superset of existing reason encodings; old readers and writers keep their existing values and no balances or ledger rows are changed.
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check CHECK (reason IN (
  'topup','chat','agent_chat','agent_subscription','refund','admin_adjust','promotion',
  'minimax_media','image_generation','subscription','subscription_expire','pack','muse_media',
  'media_studio'
)) NOT VALID;
-- compat: Validate the widened CHECK against existing rows; all legacy reason values remain accepted and invalid reasons remain rejected.
ALTER TABLE credit_ledger VALIDATE CONSTRAINT credit_ledger_reason_check;
-- end-sync-section: 0324_media_studio

-- sync-section: 0329_media_studio_music
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
-- end-sync-section: 0329_media_studio_music
