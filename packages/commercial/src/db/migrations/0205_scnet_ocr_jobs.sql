-- 0205_scnet_ocr_jobs.sql
-- Durable tenant-bound job state for the managed SCNet document parsing API.
-- Result bytes live in the master-owned OC_OCR_RESULT_DIR; PostgreSQL is the
-- authority for cancellation, completion publication and retention.

CREATE TABLE ocr_jobs (
  id                  TEXT PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_task_id    TEXT UNIQUE,
  status              TEXT NOT NULL DEFAULT 'submitting'
                      CHECK (status IN ('submitting','queued','running','completed','failed','cancelled')),
  phase               TEXT NOT NULL DEFAULT 'submitting',
  filename            TEXT NOT NULL,
  content_type        TEXT NOT NULL,
  size_bytes          BIGINT NOT NULL CHECK (size_bytes >= 0),
  pages_total         INTEGER CHECK (pages_total IS NULL OR pages_total >= 0),
  markdown_path       TEXT,
  jsonl_path          TEXT,
  error_code          TEXT,
  error_message       TEXT,
  cancel_requested_at TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, id),
  CHECK ((status = 'completed') =
    (pages_total IS NOT NULL AND markdown_path IS NOT NULL AND jsonl_path IS NOT NULL))
);

CREATE INDEX idx_ocr_jobs_user_created
  ON ocr_jobs (user_id, created_at DESC, id DESC);
CREATE INDEX idx_ocr_jobs_expiry
  ON ocr_jobs (expires_at, id)
  WHERE expires_at IS NOT NULL;
