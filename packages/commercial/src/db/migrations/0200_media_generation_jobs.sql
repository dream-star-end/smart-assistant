-- 0200_media_generation_jobs.sql
-- Durable MiniMax H3 jobs and minute-scale video projects.
-- PostgreSQL is the sole FIFO authority; the SCNet worker mirrors one fenced
-- attempt per resource class and never owns queue ordering.

CREATE TABLE media_generation_inputs (
  id             TEXT PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256         TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes     BIGINT NOT NULL CHECK (size_bytes >= 0),
  mime           TEXT NOT NULL,
  filename       TEXT NOT NULL,
  worker_filename TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('first_frame','last_frame','reference_image','clip','subtitle','music')),
  storage_path   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, id)
);

CREATE TABLE media_generation_jobs (
  id              TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  runtime_channel TEXT NOT NULL,
  session_id      TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('h3_generate','video_compose')),
  resource_class  TEXT NOT NULL CHECK (resource_class IN ('gpu-h3','cpu-compose')),
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','dispatching','running','reconnecting','completed','failed','canceled')),
  phase           TEXT NOT NULL DEFAULT 'queued',
  prompt          TEXT,
  options         JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_id      TEXT,
  fence_version   INTEGER NOT NULL DEFAULT 0 CHECK (fence_version >= 0),
  request_digest  TEXT,
  worker_staging_started_at TIMESTAMPTZ,
  submit_started_at TIMESTAMPTZ,
  current_step    INTEGER,
  total_steps     INTEGER,
  result_path     TEXT,
  result_sha256   TEXT,
  result_size     BIGINT,
  worker_ack_pending BOOLEAN NOT NULL DEFAULT FALSE,
  worker_acked_at TIMESTAMPTZ,
  error_code      TEXT,
  error_message   TEXT,
  cancel_requested_at TIMESTAMPTZ,
  locked_at       TIMESTAMPTZ,
  predecessor_job_id TEXT REFERENCES media_generation_jobs(id),
  predecessor_artifact_sha256 TEXT,
  project_rev_at_submit INTEGER,
  compose_manifest JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, request_id),
  UNIQUE (user_id, id)
);

CREATE TABLE video_projects (
  id              TEXT PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id      TEXT NOT NULL,
  title           TEXT NOT NULL,
  creation_contract JSONB NOT NULL,
  session_id      TEXT,
  input_ids       TEXT[] NOT NULL DEFAULT '{}',
  rev             INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  render_requested_at TIMESTAMPTZ,
  canceled_at     TIMESTAMPTZ,
  current_compose_job_id TEXT REFERENCES media_generation_jobs(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, request_id)
);

CREATE TABLE video_project_shots (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  prompt          TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds IN (5, 10, 15)),
  options         JSONB NOT NULL DEFAULT '{}'::jsonb,
  active_media_job_id TEXT REFERENCES media_generation_jobs(id),
  predecessor_shot_id TEXT REFERENCES video_project_shots(id),
  accepted_dependency_job_id TEXT REFERENCES media_generation_jobs(id),
  accepted_dependency_sha256 TEXT,
  stale_at        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, ordinal),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, project_id) REFERENCES video_projects(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, active_media_job_id) REFERENCES media_generation_jobs(user_id, id),
  FOREIGN KEY (user_id, predecessor_shot_id) REFERENCES video_project_shots(user_id, id),
  FOREIGN KEY (user_id, accepted_dependency_job_id) REFERENCES media_generation_jobs(user_id, id)
);

ALTER TABLE media_generation_jobs
  ADD COLUMN project_id TEXT REFERENCES video_projects(id),
  ADD COLUMN project_shot_id TEXT REFERENCES video_project_shots(id),
  ADD FOREIGN KEY (user_id, project_id) REFERENCES video_projects(user_id, id),
  ADD FOREIGN KEY (user_id, project_shot_id) REFERENCES video_project_shots(user_id, id),
  ADD FOREIGN KEY (user_id, predecessor_job_id) REFERENCES media_generation_jobs(user_id, id);

CREATE TABLE media_generation_job_inputs (
  job_id          TEXT NOT NULL REFERENCES media_generation_jobs(id) ON DELETE CASCADE,
  input_id        TEXT NOT NULL,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (job_id, ordinal),
  UNIQUE (job_id, input_id),
  FOREIGN KEY (user_id, job_id) REFERENCES media_generation_jobs(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, input_id) REFERENCES media_generation_inputs(user_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_media_generation_jobs_fifo
  ON media_generation_jobs (resource_class, created_at, id)
  WHERE status = 'queued';
CREATE INDEX idx_media_generation_jobs_active
  ON media_generation_jobs (resource_class, locked_at)
  WHERE status IN ('dispatching','running','reconnecting');
CREATE INDEX idx_media_generation_jobs_user
  ON media_generation_jobs (user_id, created_at DESC, id DESC);
CREATE INDEX idx_media_generation_jobs_project
  ON media_generation_jobs (project_id, project_shot_id, created_at DESC);
CREATE INDEX idx_media_generation_jobs_ack_pending
  ON media_generation_jobs (updated_at, id)
  WHERE worker_ack_pending;
CREATE INDEX idx_media_generation_inputs_user
  ON media_generation_inputs (user_id, created_at DESC);
CREATE INDEX idx_video_projects_user
  ON video_projects (user_id, updated_at DESC);
CREATE INDEX idx_video_project_shots_project
  ON video_project_shots (project_id, ordinal);
