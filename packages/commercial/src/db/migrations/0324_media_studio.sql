-- order-dependency: 0323_turn_dispatches_trace_id
-- Merge order: 0323 (turn_dispatches.trace_id, OCV5-599, commercial PR #1066) must be merged and applied
-- first: migrate.ts refuses a later 0323 once 0324 has run (out-of-order), and this declaration makes a
-- run without 0323 fail closed before anything is applied. 0322_minimax_voices sorts before 0323.
-- 0324_media_studio.sql (commercial; OCV5-591, media studio OCV5-586)
-- Media studio: a project turns a brief into shots / lines / music, generates takes through the
-- existing provider ledgers (Image 2, Muse, MiniMax, Grok) and composes a final cut. The studio's own
-- charges (compose, music) go through studio_charges with ledger reason 'media_studio'.
-- Data model and invariants: docs/ocv5-591-media-studio-backend-plan.md §2–§6.
--   * studio_tasks is a lease+epoch queue (same shape as turn tape jobs); exec_request_id is the
--     stable execution identity every provider call is keyed on, so a re-claimed task never pays twice.
--   * Blobs are content-addressed and owned by nobody; ownership is studio_blob_refs. A write takes
--     an expiring hold first (studio_quota_holds) and settles 'site' / 'u:<id>' usage afterwards.
-- Retention: studio_events 180 days (AUDIT_RETENTION_POLICIES); everything else is user-owned data
-- removed with the user (FK cascade) or by the studio GC (unadopted takes, soft-deleted projects).
-- Rollback: db/rollbacks/0324_media_studio.sql.

-- compat: additive tables and a widened CHECK; old binaries never read or write them
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

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_reason_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check CHECK (reason IN (
  'topup','chat','agent_chat','agent_subscription','refund','admin_adjust','promotion',
  'minimax_media','image_generation','subscription','subscription_expire','pack','muse_media',
  'media_studio'
)) NOT VALID;
ALTER TABLE credit_ledger VALIDATE CONSTRAINT credit_ledger_reason_check;
