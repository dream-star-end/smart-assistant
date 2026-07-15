-- 0151 — recovery-aware product friction telemetry.
--
-- This table intentionally has no JSON/details/message/stack/URL/IP/UA column.
-- Values are bounded stable enums/identifiers only; the correlation seed is
-- SHA-256 hashed by the writer and never persisted verbatim.

ALTER TABLE request_finalize_journal
  ADD COLUMN IF NOT EXISTS failure_code TEXT
  CHECK (failure_code IN (
    'UNKNOWN', 'INVALID_REQUEST', 'RATE_LIMITED', 'UPSTREAM_UNAVAILABLE',
    'UPSTREAM_REJECTED', 'CLIENT_ABORT', 'STREAM_FAILED', 'BILLING_FAILED',
    'INTERNAL_ERROR', 'USER_CANCELLED'
  ));

UPDATE request_finalize_journal
   SET failure_code = 'UNKNOWN'
 WHERE state = 'aborted' AND failure_code IS NULL;

CREATE INDEX IF NOT EXISTS idx_rfj_model_terminal_time
  ON request_finalize_journal ((ctx->>'model'), state, created_at DESC)
  WHERE state IN ('committed', 'aborted');

-- Replace historical free-form Codex terminal text with one bounded product
-- code. The exact interrupt literal was emitted by every pre-0151 Codex
-- runtime; every other error remains a real engine failure. Raw text is
-- removed rather than copied into the new audit projection.
UPDATE usage_records
   SET price_snapshot = (price_snapshot - 'codex_error_reason') || jsonb_build_object(
     'codex_terminal_code',
     CASE
       WHEN price_snapshot->>'codex_terminal_code' IN ('USER_CANCELLED','CODEX_ERROR')
         THEN price_snapshot->>'codex_terminal_code'
       WHEN price_snapshot->>'codex_error_reason' = 'codex turn interrupted'
         THEN 'USER_CANCELLED'
       ELSE 'CODEX_ERROR'
     END
   )
 WHERE price_snapshot->>'codex_status'='error'
    OR price_snapshot ? 'codex_error_reason';

-- The old runtime can keep serving existing containers between online
-- migration and runtime activation. Canonicalize its legacy snapshot shape at
-- the database boundary so no rolling write retains raw text or loses user
-- cancellation semantics.
CREATE OR REPLACE FUNCTION canonicalize_legacy_codex_terminal_snapshot()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.price_snapshot->>'codex_status'='error'
     OR NEW.price_snapshot ? 'codex_error_reason'
  THEN
    NEW.price_snapshot := (NEW.price_snapshot - 'codex_error_reason') || jsonb_build_object(
      'codex_terminal_code',
      CASE
        WHEN NEW.price_snapshot->>'codex_terminal_code' IN ('USER_CANCELLED','CODEX_ERROR')
          THEN NEW.price_snapshot->>'codex_terminal_code'
        WHEN NEW.price_snapshot->>'codex_error_reason' = 'codex turn interrupted'
          THEN 'USER_CANCELLED'
        ELSE 'CODEX_ERROR'
      END
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_canonicalize_legacy_codex_terminal ON usage_records;
CREATE TRIGGER trg_canonicalize_legacy_codex_terminal
BEFORE INSERT OR UPDATE OF price_snapshot ON usage_records
FOR EACH ROW EXECUTE FUNCTION canonicalize_legacy_codex_terminal_snapshot();

-- Finalized lossless tapes written before 0151 duplicated the raw Codex
-- reason in the tape projection, agent-group materialized record, and source
-- parts.  Canonicalize the two authoritative projections, recompute the
-- record content hash, then remove source parts only for affected finalized
-- tapes (materialized records are already authoritative at that point).
CREATE OR REPLACE FUNCTION oc_0151_canonicalize_billing_array(value JSONB)
RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_agg(
      (item - 'errorReason') ||
      CASE
        WHEN item->>'status'='error' THEN jsonb_build_object(
          'terminalCode',
          CASE
            WHEN item->>'terminalCode' IN ('USER_CANCELLED','CODEX_ERROR')
              THEN item->>'terminalCode'
            WHEN item->>'errorReason'='codex turn interrupted'
              THEN 'USER_CANCELLED'
            ELSE 'CODEX_ERROR'
          END
        )
        ELSE '{}'::jsonb
      END
      ORDER BY ordinal
    ),
    '[]'::jsonb
  )
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(value)='array' THEN value ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS entries(item, ordinal)
$$;

CREATE TEMP TABLE oc_0151_legacy_tape_keys ON COMMIT DROP AS
SELECT DISTINCT t.session_id,t.user_id,t.tape_id
  FROM client_session_turn_tapes t
 WHERE t.finalized_at IS NOT NULL
   AND jsonb_typeof(t.engine_billings)='array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(t.engine_billings) AS billing
      WHERE billing ? 'errorReason'
   )
UNION
SELECT DISTINCT r.session_id,r.user_id,r.tape_id
  FROM client_session_turn_tape_records r
  JOIN client_session_turn_tapes t
    ON t.session_id=r.session_id AND t.user_id=r.user_id AND t.tape_id=r.tape_id
 CROSS JOIN LATERAL (
   SELECT convert_from(r.payload,'UTF8')::jsonb AS body
 ) decoded
 WHERE t.finalized_at IS NOT NULL
   AND r.role='agent-group'
   AND jsonb_typeof(decoded.body->'engineBillings')='array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(decoded.body->'engineBillings') AS billing
      WHERE billing ? 'errorReason'
   );

UPDATE client_session_turn_tapes t
   SET engine_billings=oc_0151_canonicalize_billing_array(t.engine_billings)
  FROM oc_0151_legacy_tape_keys legacy
 WHERE t.session_id=legacy.session_id AND t.user_id=legacy.user_id AND t.tape_id=legacy.tape_id;

WITH rewritten AS (
  SELECT r.session_id,r.user_id,r.tape_id,r.msg_id,
         jsonb_set(
           convert_from(r.payload,'UTF8')::jsonb,
           '{engineBillings}',
           oc_0151_canonicalize_billing_array(
             convert_from(r.payload,'UTF8')::jsonb->'engineBillings'
           )
         ) AS body
    FROM client_session_turn_tape_records r
    JOIN oc_0151_legacy_tape_keys legacy
      ON legacy.session_id=r.session_id AND legacy.user_id=r.user_id AND legacy.tape_id=r.tape_id
   WHERE r.role='agent-group'
     AND jsonb_typeof(convert_from(r.payload,'UTF8')::jsonb->'engineBillings')='array'
)
UPDATE client_session_turn_tape_records r
   SET payload=convert_to(rewritten.body::text,'UTF8'),
       content_sha256=encode(
         public.digest(convert_to(rewritten.body::text,'UTF8'),'sha256'),
         'hex'
       )
  FROM rewritten
 WHERE r.session_id=rewritten.session_id AND r.user_id=rewritten.user_id
   AND r.tape_id=rewritten.tape_id AND r.msg_id=rewritten.msg_id;

DELETE FROM client_session_turn_tape_parts p
 USING oc_0151_legacy_tape_keys legacy
 WHERE p.session_id=legacy.session_id AND p.user_id=legacy.user_id AND p.tape_id=legacy.tape_id;

DROP TABLE oc_0151_legacy_tape_keys;

-- Rolling-deploy compatibility for lossless tapes.  A pre-0151 master may
-- finish a tape after this migration commits but before the new runtime takes
-- traffic.  Protect every durable copy at the database boundary rather than
-- relying on a one-shot backfill:
--   * tape.engine_billings is canonicalized before insert/update;
--   * agent-group payload is canonicalized and re-hashed before storage;
--   * source parts containing the raw canonical turn are removed atomically;
--   * late retries cannot reinsert parts for an already-finalized tape.
CREATE OR REPLACE FUNCTION canonicalize_legacy_lossless_tape_header()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  canonical JSONB;
  had_raw BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(NEW.engine_billings)='array' THEN
    canonical := oc_0151_canonicalize_billing_array(NEW.engine_billings);
    had_raw := canonical IS DISTINCT FROM NEW.engine_billings;
    NEW.engine_billings := canonical;
  END IF;
  IF NEW.finalized_at IS NOT NULL AND had_raw THEN
    DELETE FROM client_session_turn_tape_parts
     WHERE session_id=NEW.session_id AND user_id=NEW.user_id AND tape_id=NEW.tape_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_canonicalize_legacy_lossless_tape_header
  ON client_session_turn_tapes;
CREATE TRIGGER trg_canonicalize_legacy_lossless_tape_header
BEFORE INSERT OR UPDATE OF engine_billings,finalized_at ON client_session_turn_tapes
FOR EACH ROW EXECUTE FUNCTION canonicalize_legacy_lossless_tape_header();

CREATE OR REPLACE FUNCTION canonicalize_legacy_lossless_agent_group()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  body JSONB;
  canonical JSONB;
BEGIN
  IF NEW.role<>'agent-group' THEN RETURN NEW; END IF;
  body := convert_from(NEW.payload,'UTF8')::jsonb;
  IF jsonb_typeof(body->'engineBillings')<>'array' THEN RETURN NEW; END IF;
  canonical := oc_0151_canonicalize_billing_array(body->'engineBillings');
  IF canonical IS NOT DISTINCT FROM body->'engineBillings' THEN RETURN NEW; END IF;

  body := jsonb_set(body,'{engineBillings}',canonical);
  NEW.payload := convert_to(body::text,'UTF8');
  NEW.content_sha256 := encode(public.digest(NEW.payload,'sha256'),'hex');

  -- Records are materialized in the same finalize transaction after all parts
  -- have already been validated/read. Deleting here is rollback-safe and
  -- closes the interval before the tape header's finalized_at update.
  DELETE FROM client_session_turn_tape_parts
   WHERE session_id=NEW.session_id AND user_id=NEW.user_id AND tape_id=NEW.tape_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_canonicalize_legacy_lossless_agent_group
  ON client_session_turn_tape_records;
CREATE TRIGGER trg_canonicalize_legacy_lossless_agent_group
BEFORE INSERT OR UPDATE OF payload,role ON client_session_turn_tape_records
FOR EACH ROW EXECUTE FUNCTION canonicalize_legacy_lossless_agent_group();

CREATE OR REPLACE FUNCTION reject_finalized_lossless_tape_part()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM client_session_turn_tapes t
     WHERE t.session_id=NEW.session_id AND t.user_id=NEW.user_id AND t.tape_id=NEW.tape_id
       AND t.finalized_at IS NOT NULL
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reject_finalized_lossless_tape_part
  ON client_session_turn_tape_parts;
CREATE TRIGGER trg_reject_finalized_lossless_tape_part
BEFORE INSERT OR UPDATE ON client_session_turn_tape_parts
FOR EACH ROW EXECUTE FUNCTION reject_finalized_lossless_tape_part();

-- Before producers wrote the explicit waived marker, a committed successful
-- model usage with zero output was the same no-response condition (normal
-- text/tool responses always carry output tokens). Restrict the backfill to
-- committed journal truth and exclude Codex error turns.
UPDATE usage_records ur
   SET price_snapshot = price_snapshot ||
       '{"waived":"no_output","waiver_source":"0151_legacy_zero_output"}'::jsonb
 WHERE ur.status='success'
   AND ur.output_tokens=0
   AND COALESCE(ur.price_snapshot->>'waived','')=''
   AND COALESCE(ur.price_snapshot->>'codex_status','success')<>'error'
   AND EXISTS (
     SELECT 1 FROM request_finalize_journal rfj
      WHERE rfj.usage_id=ur.id AND rfj.state='committed'
   );

ALTER TABLE image_generation_usage_records
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE image_generation_usage_records
  ALTER COLUMN attempt_count TYPE INTEGER,
  ALTER COLUMN attempt_count SET DEFAULT 0;

ALTER TABLE image_generation_usage_records
  DROP CONSTRAINT IF EXISTS image_generation_usage_records_attempt_count_check;
ALTER TABLE image_generation_usage_records
  ADD CONSTRAINT image_generation_usage_records_attempt_count_check
  CHECK (attempt_count BETWEEN 0 AND 1000000);

ALTER TABLE image_generation_usage_records
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- Historical error_code was application-controlled but unconstrained. Collapse
-- it to the finite product taxonomy before exposing it to the admin API.
UPDATE image_generation_usage_records
   SET error_code = CASE
     WHEN error_code ~ '^[A-Z0-9_]{1,64}$' THEN error_code
     ELSE CASE LOWER(COALESCE(error_code, ''))
       WHEN 'stale_timeout' THEN 'IMAGE_STALE_TIMEOUT'
       WHEN 'precheck_failed' THEN 'IMAGE_PRECHECK_FAILED'
       WHEN 'route_unavailable' THEN 'IMAGE_ROUTE_UNAVAILABLE'
       WHEN 'account_unavailable' THEN 'IMAGE_ACCOUNT_UNAVAILABLE'
       WHEN 'egress_unavailable' THEN 'IMAGE_EGRESS_UNAVAILABLE'
       WHEN 'token_unavailable' THEN 'IMAGE_TOKEN_UNAVAILABLE'
       WHEN 'server_busy' THEN 'IMAGE_SERVER_BUSY'
       WHEN 'invalid_request' THEN 'IMAGE_INVALID_REQUEST'
       WHEN 'relay_failed' THEN 'IMAGE_RELAY_FAILED'
       WHEN '' THEN CASE WHEN status='failed' THEN 'IMAGE_LEGACY_FAILURE' ELSE NULL END
       ELSE 'IMAGE_LEGACY_FAILURE'
     END
   END
 WHERE error_code IS NOT NULL OR status='failed';

ALTER TABLE image_generation_usage_records
  DROP CONSTRAINT IF EXISTS image_generation_usage_records_error_code_check;
ALTER TABLE image_generation_usage_records
  ADD CONSTRAINT image_generation_usage_records_error_code_check
  CHECK (error_code IS NULL OR error_code ~ '^[A-Za-z0-9_]{1,64}$');

-- Rolling compatibility: the pre-0151 master writes a small set of lowercase
-- codes while it remains live during the online migration. Keep accepting the
-- bounded legacy wire shape; the new writer and all admin projections
-- canonicalize it to IMAGE_* uppercase. An uppercase-only CHECK here would
-- make the migration incompatible with the still-serving old process.

UPDATE image_generation_usage_records
   SET attempt_count=GREATEST(attempt_count,1),
       last_attempt_at=COALESCE(last_attempt_at,completed_at,updated_at)
 WHERE status='success' OR (status='failed' AND error_code='IMAGE_RELAY_FAILED');

CREATE TABLE IF NOT EXISTS image_generation_attempts (
  id           BIGSERIAL PRIMARY KEY,
  usage_id     BIGINT NOT NULL REFERENCES image_generation_usage_records(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_no   INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 1000000),
  outcome      VARCHAR(16) NOT NULL CHECK (outcome IN ('pending','succeeded','failed','cancelled')),
  error_code   VARCHAR(64) CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (usage_id, attempt_no),
  CHECK (
    (outcome IN ('pending','succeeded') AND error_code IS NULL)
    OR (outcome IN ('failed','cancelled') AND error_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_image_attempts_time
  ON image_generation_attempts (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_attempts_user_time
  ON image_generation_attempts (user_id, started_at DESC);

-- One conservative synthetic attempt preserves pre-0151 journeys. New code
-- records every real upstream fetch exactly at its start.
INSERT INTO image_generation_attempts
  (usage_id,user_id,attempt_no,outcome,error_code,started_at,completed_at)
SELECT id,user_id,1,
       CASE WHEN status='success' THEN 'succeeded' ELSE 'failed' END,
       CASE WHEN status='success' THEN NULL ELSE COALESCE(error_code,'IMAGE_LEGACY_FAILURE') END,
       COALESCE(last_attempt_at,created_at),
       COALESCE(completed_at,updated_at)
  FROM image_generation_usage_records
 WHERE status='success' OR (status='failed' AND error_code='IMAGE_RELAY_FAILED')
ON CONFLICT (usage_id,attempt_no) DO NOTHING;

-- A request can already be reserved when 0151 is applied and then finish in
-- the still-serving pre-0151 process, which does not know about the attempts
-- table. Capture only terminal states that prove a real upstream fetch:
-- success, or the old relay_failed path. Preflight/route/invalid-request
-- failures deliberately remain at zero upstream attempts.
CREATE OR REPLACE FUNCTION capture_legacy_image_attempt_on_terminal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  terminal_outcome VARCHAR(16);
  terminal_error VARCHAR(64);
BEGIN
  IF OLD.status='reserved'
     AND NEW.status IN ('success','failed')
     AND NEW.attempt_count=0
     AND (
       NEW.status='success'
       OR LOWER(COALESCE(NEW.error_code,''))='relay_failed'
     )
     AND NOT EXISTS (
       SELECT 1 FROM image_generation_attempts a WHERE a.usage_id=NEW.id
     )
  THEN
    terminal_outcome := CASE WHEN NEW.status='success' THEN 'succeeded' ELSE 'failed' END;
    terminal_error := CASE WHEN NEW.status='success' THEN NULL ELSE 'IMAGE_RELAY_FAILED' END;
    NEW.attempt_count := 1;
    NEW.last_attempt_at := COALESCE(NEW.last_attempt_at,clock_timestamp());
    INSERT INTO image_generation_attempts
      (usage_id,user_id,attempt_no,outcome,error_code,started_at,completed_at)
    VALUES (
      NEW.id,NEW.user_id,1,terminal_outcome,terminal_error,
      COALESCE(OLD.updated_at,OLD.created_at,clock_timestamp()),
      COALESCE(NEW.completed_at,clock_timestamp())
    )
    ON CONFLICT (usage_id,attempt_no) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_capture_legacy_image_attempt ON image_generation_usage_records;
CREATE TRIGGER trg_capture_legacy_image_attempt
BEFORE UPDATE OF status,error_code ON image_generation_usage_records
FOR EACH ROW EXECUTE FUNCTION capture_legacy_image_attempt_on_terminal();

CREATE TABLE IF NOT EXISTS product_friction_events (
  event_key      CHAR(64) PRIMARY KEY,
  user_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  surface        VARCHAR(48) NOT NULL CHECK (surface ~ '^[a-z0-9_]{1,48}$'),
  stage          VARCHAR(48) NOT NULL CHECK (stage ~ '^[a-z0-9_]{1,48}$'),
  code           VARCHAR(64) NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,64}$'),
  outcome        VARCHAR(16) NOT NULL CHECK (outcome IN (
                   'pending', 'failed', 'recovered', 'succeeded', 'abandoned', 'cancelled'
                 )),
  attempts       SMALLINT NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 32),
  latency_ms     INTEGER CHECK (latency_ms BETWEEN 0 AND 86400000),
  model          VARCHAR(128),
  provider       VARCHAR(32),
  client_build   VARCHAR(64),
  browser_family VARCHAR(24),
  device_class   VARCHAR(16) CHECK (device_class IN ('desktop', 'mobile', 'tablet', 'unknown')),
  trace_id       VARCHAR(96),
  session_id     VARCHAR(96),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recovered_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_product_friction_time
  ON product_friction_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_friction_surface_time
  ON product_friction_events (surface, stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_friction_user_time
  ON product_friction_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

COMMENT ON TABLE product_friction_events IS
  'Bounded recovery-aware product telemetry. No raw request/response/tool text, stack, path, URL, IP or UA.';

-- Session deletion and repo selection share the same master PG. Keep the
-- workspace lifecycle in sync without coupling the generic storage package to
-- commercial GitHub code.
UPDATE github_session_workspaces g
   SET status='cleared', error_code='session_deleted', error_message=NULL,
       selection_version=selection_version+1, updated_at=NOW()
 WHERE status<>'cleared'
   AND EXISTS (
     SELECT 1 FROM client_sessions s
      WHERE s.id=g.session_id
        AND s.user_id='c:' || g.user_id::text
        AND s.deleted_at IS NOT NULL
   );

CREATE OR REPLACE FUNCTION clear_github_workspace_on_session_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE github_session_workspaces
       SET status='cleared', error_code='session_deleted', error_message=NULL,
           selection_version=selection_version+1, updated_at=NOW()
     WHERE session_id=NEW.id
       AND 'c:' || user_id::text=NEW.user_id
       AND status<>'cleared';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_clear_github_workspace_on_session_delete ON client_sessions;
CREATE TRIGGER trg_clear_github_workspace_on_session_delete
AFTER UPDATE OF deleted_at ON client_sessions
FOR EACH ROW EXECUTE FUNCTION clear_github_workspace_on_session_delete();

UPDATE github_session_workspaces
   SET status='failed', error_code='workspace_timeout', error_message=NULL, updated_at=NOW()
 WHERE status IN ('pending','cloning') AND updated_at < NOW()-interval '30 minutes';
