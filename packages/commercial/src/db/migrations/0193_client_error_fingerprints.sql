-- 0193 — privacy-preserving browser runtime error clustering.
--
-- The browser keeps raw message/stack/path locally and sends only a bounded
-- error-name enum plus the first 16 hex chars of a versioned SHA-256 digest.
-- Both columns are nullable so old writers and rollback releases remain valid.

ALTER TABLE product_friction_events
  ADD COLUMN IF NOT EXISTS error_name VARCHAR(32),
  ADD COLUMN IF NOT EXISTS error_fingerprint CHAR(16);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'product_friction_events'::regclass
       AND conname = 'product_friction_events_error_name_check'
  ) THEN
    ALTER TABLE product_friction_events
      ADD CONSTRAINT product_friction_events_error_name_check
      CHECK (
        error_name IS NULL OR error_name IN (
          'error',
          'type_error',
          'range_error',
          'reference_error',
          'syntax_error',
          'uri_error',
          'eval_error',
          'aggregate_error',
          'dom_exception',
          'non_error'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'product_friction_events'::regclass
       AND conname = 'product_friction_events_error_fingerprint_check'
  ) THEN
    ALTER TABLE product_friction_events
      ADD CONSTRAINT product_friction_events_error_fingerprint_check
      CHECK (error_fingerprint IS NULL OR error_fingerprint ~ '^[a-f0-9]{16}$');
  END IF;
END
$$;

COMMENT ON COLUMN product_friction_events.error_name IS
  'Client-normalized runtime error class; never a raw exception name.';
COMMENT ON COLUMN product_friction_events.error_fingerprint IS
  'First 16 lowercase hex chars of browser-local oc-js-error-v1 SHA-256; no raw message, stack, path or URL.';
