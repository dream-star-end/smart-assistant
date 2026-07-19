-- 0174_selfheal_release_safety_fences
--
-- Close four fail-open edges in the Tier2 release path:
--   * approval is bound to one immutable pending_release event;
--   * frozen plan/manifest digests use the same sha256 shape on both hosts;
--   * every fuse epoch is remembered forever, so concurrent uncertainty and
--     delayed old callbacks cannot be lost or resurrected;
--   * the unsafe host-global disk cleanup opcode is retired.

ALTER TABLE selfheal_release_requests
  ADD COLUMN IF NOT EXISTS source_event_id BIGINT
    REFERENCES codex_repair_events(id) ON DELETE RESTRICT;

-- Upgrade bridge: bind pre-0174 requests to the latest matching reviewed event
-- that existed before the request was created. If legacy retries produced more
-- than one request for the same event, bind the newest ledger row; the event is
-- still permanently consumed and cannot be deployed again after the upgrade.
WITH matches AS (
  SELECT r.id AS request_row_id,
         (
           SELECT e.id
             FROM codex_repair_events e
            WHERE e.repair_id = r.repair_id
              AND e.kind = 'progress'
              AND e.detail->>'phase' = 'pending_release'
              AND e.detail->>'sha' = r.approved_sha
              AND (e.detail->>'baseSha') IS NOT DISTINCT FROM r.base_sha
              AND e.detail->>'deployPlanHash' = r.deploy_plan_hash
              AND e.detail->>'manifestHash' = r.manifest_hash
              AND r.deploy_plan_hash ~ '^[0-9a-f]{64}$'
              AND r.manifest_hash ~ '^[0-9a-f]{64}$'
              AND e.created_at <= r.created_at
            ORDER BY e.id DESC
            LIMIT 1
         ) AS source_event_id
    FROM selfheal_release_requests r
   WHERE r.source_event_id IS NULL
), ranked AS (
  SELECT request_row_id,
         source_event_id,
         ROW_NUMBER() OVER (PARTITION BY source_event_id ORDER BY request_row_id DESC) AS rank
    FROM matches
   WHERE source_event_id IS NOT NULL
)
UPDATE selfheal_release_requests r
   SET source_event_id = ranked.source_event_id
  FROM ranked
 WHERE r.id = ranked.request_row_id
   AND ranked.rank = 1;

CREATE UNIQUE INDEX IF NOT EXISTS ux_selfheal_release_source_event
  ON selfheal_release_requests(source_event_id)
  WHERE source_event_id IS NOT NULL;

ALTER TABLE selfheal_release_requests
  DROP CONSTRAINT IF EXISTS ck_selfheal_release_plan_hash_sha256,
  ADD CONSTRAINT ck_selfheal_release_plan_hash_sha256
    CHECK (
      source_event_id IS NULL OR
      (deploy_plan_hash IS NOT NULL AND deploy_plan_hash ~ '^[0-9a-f]{64}$')
    ),
  DROP CONSTRAINT IF EXISTS ck_selfheal_release_manifest_hash_sha256,
  ADD CONSTRAINT ck_selfheal_release_manifest_hash_sha256
    CHECK (
      source_event_id IS NULL OR
      (manifest_hash IS NOT NULL AND manifest_hash ~ '^[0-9a-f]{64}$')
    ),
  DROP CONSTRAINT IF EXISTS ck_selfheal_release_source_has_frozen_hashes,
  ADD CONSTRAINT ck_selfheal_release_source_has_frozen_hashes
    CHECK (
      source_event_id IS NULL OR
      (
        deploy_plan_hash IS NOT NULL AND
        manifest_hash IS NOT NULL AND
        deploy_plan_hash ~ '^[0-9a-f]{64}$' AND
        manifest_hash ~ '^[0-9a-f]{64}$'
      )
    );

-- Rolling-upgrade / rollback fence for a pre-0174 admin writer. Old code omits
-- source_event_id; bind it in the database to the latest exact frozen
-- pending_release tuple. Missing/invalid identity fails closed, and the unique
-- index makes a second approval of that event a deterministic conflict.
CREATE OR REPLACE FUNCTION selfheal_bind_legacy_release_source_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  matched_event_id BIGINT;
BEGIN
  IF NEW.source_event_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.deploy_plan_hash IS NULL
     OR NEW.manifest_hash IS NULL
     OR NEW.deploy_plan_hash !~ '^[0-9a-f]{64}$'
     OR NEW.manifest_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'legacy release request lacks sha256 frozen identity'
      USING ERRCODE = '23514';
  END IF;
  SELECT e.id
    INTO matched_event_id
    FROM codex_repair_events e
   WHERE e.repair_id = NEW.repair_id
     AND e.kind = 'progress'
     AND e.detail->>'phase' = 'pending_release'
     AND e.detail->>'sha' = NEW.approved_sha
     AND (e.detail->>'baseSha') IS NOT DISTINCT FROM NEW.base_sha
     AND e.detail->>'deployPlanHash' = NEW.deploy_plan_hash
     AND e.detail->>'manifestHash' = NEW.manifest_hash
   ORDER BY e.id DESC
   LIMIT 1;
  IF matched_event_id IS NULL THEN
    RAISE EXCEPTION 'legacy release request has no exact pending_release source event'
      USING ERRCODE = '23514';
  END IF;
  NEW.source_event_id := matched_event_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_selfheal_bind_legacy_release_source_event
  ON selfheal_release_requests;
CREATE TRIGGER trg_selfheal_bind_legacy_release_source_event
BEFORE INSERT ON selfheal_release_requests
FOR EACH ROW
EXECUTE FUNCTION selfheal_bind_legacy_release_source_event();

ALTER TABLE selfheal_release_fuse
  DROP CONSTRAINT IF EXISTS ck_selfheal_release_fuse_engaged_epoch,
  ADD CONSTRAINT ck_selfheal_release_fuse_engaged_epoch
    CHECK (NOT engaged OR release_request_id IS NOT NULL);

CREATE TABLE IF NOT EXISTS selfheal_release_fuse_epochs (
  release_request_id TEXT PRIMARY KEY,
  reason TEXT,
  engaged_at TIMESTAMPTZ NOT NULL,
  engaged_by TEXT NOT NULL,
  cleared_at TIMESTAMPTZ,
  cleared_by TEXT,
  clear_reason TEXT,
  personal_ack_at TIMESTAMPTZ,
  CONSTRAINT ck_selfheal_release_fuse_epoch_clear_pair CHECK (
    (cleared_at IS NULL AND cleared_by IS NULL) OR
    (cleared_at IS NOT NULL AND cleared_by IS NOT NULL)
  ),
  CONSTRAINT ck_selfheal_release_fuse_epoch_ack_after_clear CHECK (
    personal_ack_at IS NULL OR cleared_at IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS idx_selfheal_release_fuse_epochs_pending
  ON selfheal_release_fuse_epochs(engaged_at, release_request_id)
  WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_selfheal_release_fuse_epochs_converge
  ON selfheal_release_fuse_epochs(cleared_at, release_request_id)
  WHERE cleared_at IS NOT NULL AND personal_ack_at IS NULL;

-- The migration runner wraps this file in one transaction. Block callback
-- inserts from the historical scan until the capture trigger below is active;
-- otherwise an old-runtime event could commit between backfill and CREATE
-- TRIGGER and disappear from both mechanisms.
LOCK TABLE codex_repair_events IN SHARE ROW EXCLUSIVE MODE;

-- Upgrade bridge: pre-0174 stored only the current/most recently cleared epoch
-- on the singleton. Materialize it before any new callback can run.
INSERT INTO selfheal_release_fuse_epochs
  (release_request_id, reason, engaged_at, engaged_by,
   cleared_at, cleared_by, clear_reason, personal_ack_at)
SELECT release_request_id,
       reason,
       COALESCE(engaged_at, cleared_at, NOW()),
       COALESCE(engaged_by, 'migration:0174'),
       CASE WHEN engaged THEN NULL ELSE cleared_at END,
       CASE WHEN engaged THEN NULL ELSE COALESCE(cleared_by, 'migration:0174') END,
       CASE WHEN engaged THEN NULL ELSE 'backfilled from pre-0174 release fuse' END,
       CASE WHEN engaged THEN NULL ELSE personal_ack_at END
  FROM selfheal_release_fuse
 WHERE release_request_id IS NOT NULL
   AND (engaged = TRUE OR cleared_at IS NOT NULL)
ON CONFLICT (release_request_id) DO NOTHING;

-- Backfill uncertainty that the old singleton could not represent: a second
-- deploy_unknown while another epoch was already engaged, plus a deployed
-- receipt whose canonical push remained pending. This also closes upgrades
-- from a release where the personal fuse was engaged but V5 had no mirror.
WITH uncertainty_events AS (
  SELECT DISTINCT ON (e.detail->>'releaseRequestId')
         e.detail->>'releaseRequestId' AS release_request_id,
         CASE
           WHEN e.detail->>'releasePhase' = 'deployed'
             THEN 'canonical_push_pending'
           ELSE COALESCE(e.detail->>'reason', 'deploy_unknown')
         END AS reason,
         e.created_at,
         CASE
           WHEN e.detail->>'releasePhase' = 'deployed'
             THEN 'migration:canonical_push_pending'
           ELSE 'migration:deploy_unknown_event'
         END AS engaged_by
    FROM codex_repair_events e
   WHERE (e.detail->>'releaseRequestId') ~ '^[A-Za-z0-9_-]{1,128}$'
     AND (
       e.detail->>'releasePhase' = 'deploy_unknown'
       OR (
         e.detail->>'releasePhase' = 'deployed'
         AND e.detail->>'canonicalPush' = 'pending'
       )
     )
   ORDER BY e.detail->>'releaseRequestId', e.id ASC
)
INSERT INTO selfheal_release_fuse_epochs
  (release_request_id, reason, engaged_at, engaged_by)
SELECT release_request_id, reason, created_at, engaged_by
  FROM uncertainty_events
ON CONFLICT (release_request_id) DO NOTHING;

-- The singleton is now only the oldest pending epoch projected for UI/gates.
WITH next_epoch AS (
  SELECT release_request_id, reason, engaged_at, engaged_by
    FROM selfheal_release_fuse_epochs
   WHERE cleared_at IS NULL
   ORDER BY engaged_at ASC, release_request_id ASC
   LIMIT 1
)
UPDATE selfheal_release_fuse f
   SET engaged = TRUE,
       reason = n.reason,
       release_request_id = n.release_request_id,
       engaged_at = n.engaged_at,
       engaged_by = n.engaged_by,
       cleared_at = NULL,
       cleared_by = NULL,
       personal_ack_at = NULL
  FROM next_epoch n
 WHERE f.id = 1;

-- Backward-compatible rolling-upgrade bridge. A pre-0174 runtime can still
-- append callback events after this migration commits. The trigger serializes
-- on the singleton first (same singleton→epoch lock order as the new runtime),
-- durably captures every uncertainty epoch, and repairs the UI projection. It
-- intentionally never reopens an already-cleared epoch.
CREATE OR REPLACE FUNCTION selfheal_capture_legacy_release_fuse_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  rrid TEXT := NEW.detail->>'releaseRequestId';
  phase TEXT := NEW.detail->>'releasePhase';
  epoch_reason TEXT;
  epoch_by TEXT;
  next_epoch RECORD;
  cleared_epoch RECORD;
BEGIN
  IF rrid IS NULL OR rrid !~ '^[A-Za-z0-9_-]{1,128}$' THEN
    RETURN NEW;
  END IF;
  IF phase = 'deploy_unknown' THEN
    epoch_reason := COALESCE(NEW.detail->>'reason', 'deploy_unknown');
    epoch_by := 'callback:legacy_deploy_unknown_event';
  ELSIF phase = 'deployed' AND NEW.detail->>'canonicalPush' = 'pending' THEN
    epoch_reason := 'canonical_push_pending';
    epoch_by := 'callback:legacy_canonical_push_pending';
  ELSE
    RETURN NEW;
  END IF;

  PERFORM 1 FROM selfheal_release_fuse WHERE id = 1 FOR UPDATE;
  INSERT INTO selfheal_release_fuse_epochs
    (release_request_id, reason, engaged_at, engaged_by)
  VALUES (rrid, epoch_reason, NEW.created_at, epoch_by)
  ON CONFLICT (release_request_id) DO NOTHING;

  SELECT release_request_id, reason, engaged_at, engaged_by
    INTO next_epoch
    FROM selfheal_release_fuse_epochs
   WHERE cleared_at IS NULL
   ORDER BY engaged_at ASC, release_request_id ASC
   LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    UPDATE selfheal_release_fuse
       SET engaged = TRUE,
           reason = next_epoch.reason,
           release_request_id = next_epoch.release_request_id,
           engaged_at = next_epoch.engaged_at,
           engaged_by = next_epoch.engaged_by,
           cleared_at = NULL,
           cleared_by = NULL,
           personal_ack_at = NULL
     WHERE id = 1;
    RETURN NEW;
  END IF;

  SELECT reason, engaged_at, engaged_by, cleared_at, cleared_by, personal_ack_at
    INTO cleared_epoch
    FROM selfheal_release_fuse_epochs
   WHERE release_request_id = rrid
     AND cleared_at IS NOT NULL;
  IF FOUND THEN
    UPDATE selfheal_release_fuse
       SET engaged = FALSE,
           reason = cleared_epoch.reason,
           release_request_id = rrid,
           engaged_at = cleared_epoch.engaged_at,
           engaged_by = cleared_epoch.engaged_by,
           cleared_at = cleared_epoch.cleared_at,
           cleared_by = cleared_epoch.cleared_by,
           personal_ack_at = cleared_epoch.personal_ack_at
     WHERE id = 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_selfheal_capture_legacy_release_fuse_event
  ON codex_repair_events;
CREATE TRIGGER trg_selfheal_capture_legacy_release_fuse_event
AFTER INSERT ON codex_repair_events
FOR EACH ROW
EXECUTE FUNCTION selfheal_capture_legacy_release_fuse_event();

-- A pre-0174 clear writes only the singleton. Mirror that write into the epoch
-- ledger and immediately promote the next pending epoch. This trigger also
-- prevents an old delayed callback from projecting a tombstoned epoch again.
CREATE OR REPLACE FUNCTION selfheal_mirror_legacy_release_fuse_singleton()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  next_epoch RECORD;
  cleared_epoch RECORD;
BEGIN
  -- Projection repair below updates the singleton once more; do not recurse.
  IF pg_trigger_depth() > 1 OR NEW.release_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.engaged THEN
    INSERT INTO selfheal_release_fuse_epochs
      (release_request_id, reason, engaged_at, engaged_by)
    VALUES (
      NEW.release_request_id,
      NEW.reason,
      COALESCE(NEW.engaged_at, NOW()),
      COALESCE(NEW.engaged_by, 'legacy:pre-0174')
    )
    ON CONFLICT (release_request_id) DO NOTHING;
  ELSIF NEW.cleared_at IS NOT NULL THEN
    INSERT INTO selfheal_release_fuse_epochs
      (release_request_id, reason, engaged_at, engaged_by,
       cleared_at, cleared_by, clear_reason, personal_ack_at)
    VALUES (
      NEW.release_request_id,
      NEW.reason,
      COALESCE(NEW.engaged_at, NEW.cleared_at),
      COALESCE(NEW.engaged_by, 'legacy:pre-0174'),
      NEW.cleared_at,
      COALESCE(NEW.cleared_by, 'legacy:pre-0174'),
      'mirrored from pre-0174 release fuse clear',
      NEW.personal_ack_at
    )
    ON CONFLICT (release_request_id) DO UPDATE
      SET cleared_at = COALESCE(selfheal_release_fuse_epochs.cleared_at, EXCLUDED.cleared_at),
          cleared_by = COALESCE(selfheal_release_fuse_epochs.cleared_by, EXCLUDED.cleared_by),
          clear_reason = COALESCE(selfheal_release_fuse_epochs.clear_reason, EXCLUDED.clear_reason),
          personal_ack_at = COALESCE(
            selfheal_release_fuse_epochs.personal_ack_at,
            EXCLUDED.personal_ack_at
          );
  END IF;

  SELECT release_request_id, reason, engaged_at, engaged_by
    INTO next_epoch
    FROM selfheal_release_fuse_epochs
   WHERE cleared_at IS NULL
   ORDER BY engaged_at ASC, release_request_id ASC
   LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    UPDATE selfheal_release_fuse
       SET engaged = TRUE,
           reason = next_epoch.reason,
           release_request_id = next_epoch.release_request_id,
           engaged_at = next_epoch.engaged_at,
           engaged_by = next_epoch.engaged_by,
           cleared_at = NULL,
           cleared_by = NULL,
           personal_ack_at = NULL
     WHERE id = 1;
    RETURN NEW;
  END IF;

  SELECT reason, engaged_at, engaged_by, cleared_at, cleared_by, personal_ack_at
    INTO cleared_epoch
    FROM selfheal_release_fuse_epochs
   WHERE release_request_id = NEW.release_request_id
     AND cleared_at IS NOT NULL;
  IF FOUND THEN
    UPDATE selfheal_release_fuse
       SET engaged = FALSE,
           reason = cleared_epoch.reason,
           release_request_id = NEW.release_request_id,
           engaged_at = cleared_epoch.engaged_at,
           engaged_by = cleared_epoch.engaged_by,
           cleared_at = cleared_epoch.cleared_at,
           cleared_by = cleared_epoch.cleared_by,
           personal_ack_at = cleared_epoch.personal_ack_at
     WHERE id = 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_selfheal_mirror_legacy_release_fuse_singleton
  ON selfheal_release_fuse;
CREATE TRIGGER trg_selfheal_mirror_legacy_release_fuse_singleton
AFTER UPDATE ON selfheal_release_fuse
FOR EACH ROW
EXECUTE FUNCTION selfheal_mirror_legacy_release_fuse_singleton();

-- 0156 accidentally preserved the 0133 auto_repair=TRUE seed while routing
-- disk pressure to a host-global docker/journald cleanup. Keep detection on,
-- but make repair manual until a genuinely V5-scoped v2 action exists.
UPDATE incident_policies
   SET auto_repair = FALSE,
       execution_class = 'tier2',
       action_opcode = NULL,
       repair_hint = '只读诊断 V5 release/runtime 占用；禁止 docker system prune、journald vacuum 或任何 host-global cleanup；由人工制定 V5-scoped 清理方案。',
       updated_at = NOW()
 WHERE match_key = 'ops.monitor:disk';

ALTER TABLE incident_policies
  DROP CONSTRAINT IF EXISTS ck_incident_policy_disk_manual_only,
  ADD CONSTRAINT ck_incident_policy_disk_manual_only
    CHECK (
      match_key <> 'ops.monitor:disk' OR
      (auto_repair = FALSE AND execution_class = 'tier2' AND action_opcode IS NULL)
    );
