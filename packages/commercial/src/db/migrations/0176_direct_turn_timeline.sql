-- 0176_direct_turn_timeline — browser history reads the immutable turn tape
-- directly.  The two former materialized/virtual message tables duplicated
-- user-visible content and could truncate or replace the real agent output.

ALTER TABLE client_session_turn_tapes
  ADD COLUMN IF NOT EXISTS client_message_id TEXT,
  ADD COLUMN IF NOT EXISTS continuation_of_turn_key TEXT,
  ADD COLUMN IF NOT EXISTS physical_record_count INTEGER NOT NULL DEFAULT 0
    CHECK (physical_record_count >= 0),
  ADD COLUMN IF NOT EXISTS logical_record_count INTEGER NOT NULL DEFAULT 0
    CHECK (logical_record_count >= 0),
  ADD COLUMN IF NOT EXISTS record_payload_bytes BIGINT NOT NULL DEFAULT 0
    CHECK (record_payload_bytes >= 0);

-- Existing finalized tapes get exact immutable-record metadata once.  New
-- finalizers maintain these columns in the same transaction as the records.
WITH record_totals AS (
  SELECT session_id, user_id, tape_id,
         COUNT(*)::integer AS physical_record_count,
         COALESCE(SUM(octet_length(payload)), 0)::bigint AS record_payload_bytes
    FROM client_session_turn_tape_records
   GROUP BY session_id, user_id, tape_id
)
UPDATE client_session_turn_tapes t
   SET physical_record_count = totals.physical_record_count,
       record_payload_bytes = totals.record_payload_bytes
  FROM record_totals totals
 WHERE totals.session_id=t.session_id
   AND totals.user_id=t.user_id
   AND totals.tape_id=t.tape_id;

UPDATE client_session_turn_tapes t
   SET client_message_id=d.client_message_id
  FROM turn_dispatches d
 WHERE d.dispatch_id=t.dispatch_id
   AND t.client_message_id IS NULL;

-- The hot-row anchor already carries the exact logical count.  Fall back to
-- the physical count only for rolling legacy rows that predate that marker.
UPDATE client_session_turn_tapes t
   SET logical_record_count = COALESCE(
         (
           SELECT CASE
                    WHEN (candidate.value->>'_turnTapeLogicalRecordCount') ~ '^[0-9]+$'
                    THEN (candidate.value->>'_turnTapeLogicalRecordCount')::integer
                    ELSE NULL
                  END
             FROM (
               SELECT hot.value
                 FROM client_sessions cs
                 CROSS JOIN LATERAL jsonb_array_elements(cs.messages::jsonb) AS hot(value)
                WHERE cs.id=t.session_id
                  AND cs.user_id=t.user_id
                  AND hot.value->>'_turnTapeId'=t.tape_id
               UNION ALL
               SELECT archived.value
                 FROM client_session_archive_chunks chunk
                 CROSS JOIN LATERAL jsonb_array_elements(chunk.messages::jsonb) AS archived(value)
                WHERE chunk.session_id=t.session_id
                  AND chunk.user_id=t.user_id
                  AND archived.value->>'_turnTapeId'=t.tape_id
             ) AS candidate
            LIMIT 1
         ),
         t.physical_record_count
       )
 WHERE t.logical_record_count=0;

-- Preserve every currently visible verified failure before the application
-- stops reading its former virtual-message row.  The browser now reads this
-- durable dispatch state directly and renders it as a typed status record,
-- never assistant output.
UPDATE turn_dispatches d
   SET client_notified=TRUE,
       failure_code=COALESCE(d.failure_code, p.error_code)
  FROM turn_dispatch_error_projections p
 WHERE p.dispatch_id=d.dispatch_id
   AND p.revoked_at IS NULL
   AND d.status='terminal'
   AND d.outcome IN ('not_accepted','executed_error');

-- Do not DROP the two legacy tables in the same release that removes their
-- readers/writers.  deploy-v5 applies migrations while the predecessor can
-- still be serving, and that predecessor accesses both tables.  They remain
-- inert rollback compatibility storage only; the new runtime never reads or
-- writes them.  A later migration may remove them after the rollback floor has
-- advanced past every projection-based release.
COMMENT ON TABLE tape_chat_projection IS
  'Legacy rollback-only storage. Direct timeline releases never read or write this table.';
COMMENT ON TABLE turn_dispatch_error_projections IS
  'Legacy rollback-only storage. Direct timeline releases never read or write this table.';

COMMENT ON COLUMN client_session_turn_tapes.physical_record_count IS
  'Exact immutable physical record count, maintained by tape finalization.';
COMMENT ON COLUMN client_session_turn_tapes.logical_record_count IS
  'Exact logical record count after runtime-batch expansion.';
COMMENT ON COLUMN client_session_turn_tapes.record_payload_bytes IS
  'Exact sum of post-redaction immutable record payload bytes.';
