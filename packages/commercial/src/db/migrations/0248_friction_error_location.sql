-- 0248 — bounded JS error location identifiers for client friction telemetry.
--
-- Keeps the 0151 invariant: still no raw message/stack/path/URL/IP/UA text.
-- The new columns are bounded identifiers only — error class name, bundle
-- basename, line/column, and a fingerprint derived from those same bounded
-- fields. Combined with client_build they resolve to an exact source location
-- through the release sourcemaps without persisting any user or page content.
-- Rationale: JS_ERROR rows were previously count-only and undiagnosable.

ALTER TABLE product_friction_events
  ADD COLUMN IF NOT EXISTS error_name VARCHAR(64)
    CHECK (error_name IS NULL OR error_name ~ '^[A-Za-z0-9_.$-]{1,64}$'),
  ADD COLUMN IF NOT EXISTS script_ref VARCHAR(120)
    CHECK (script_ref IS NULL OR script_ref ~ '^[A-Za-z0-9._-]{1,120}$'),
  ADD COLUMN IF NOT EXISTS line_no INTEGER
    CHECK (line_no IS NULL OR line_no BETWEEN 0 AND 10000000),
  ADD COLUMN IF NOT EXISTS col_no INTEGER
    CHECK (col_no IS NULL OR col_no BETWEEN 0 AND 10000000),
  ADD COLUMN IF NOT EXISTS error_fingerprint VARCHAR(16)
    CHECK (error_fingerprint IS NULL OR error_fingerprint ~ '^[a-f0-9]{1,16}$');

CREATE INDEX IF NOT EXISTS idx_product_friction_fingerprint_time
  ON product_friction_events (error_fingerprint, created_at DESC)
  WHERE error_fingerprint IS NOT NULL;

COMMENT ON TABLE product_friction_events IS
  'Bounded recovery-aware product telemetry. No raw request/response/tool text, stack, path, URL, IP or UA. Error location (0248) is bounded identifiers only: class name + bundle basename + line/col + derived fingerprint.';
