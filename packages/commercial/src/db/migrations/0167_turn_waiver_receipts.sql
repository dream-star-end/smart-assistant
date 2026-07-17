-- 0167 — exact turn waivers + targeted in-app receipts.
--
-- The historical refund path keyed a broad (engine session, start timestamp)
-- window.  It could include a later turn and could miss a settlement that
-- committed after the one-shot refund.  Persist the already-existing lossless
-- turn locators directly on usage_records and add a durable per-turn waiver
-- fence.  Billing settlement and waiver application serialize on the same
-- transaction advisory key in application code.

ALTER TABLE usage_records
  ADD COLUMN turn_key TEXT
    CHECK (turn_key IS NULL OR turn_key ~ '^[0-9a-f]{64}$'),
  ADD COLUMN parent_turn_key TEXT
    CHECK (parent_turn_key IS NULL OR parent_turn_key ~ '^[0-9a-f]{64}$');

-- The waiver decision is part of the immutable tape header.  Persisting it
-- here prevents an ACK-loss/idempotent finalize from adding or changing a
-- waiver after an ordinary terminal tape has already committed.
ALTER TABLE client_session_turn_tapes
  ADD COLUMN waive_reason TEXT
    CHECK (waive_reason IS NULL OR waive_reason IN (
      'idle_timeout', 'no_response',
      'platform_authority_expired', 'turn_limit'
    ));

CREATE INDEX idx_ur_user_turn_key
  ON usage_records (user_id, turn_key)
  WHERE turn_key IS NOT NULL;

CREATE INDEX idx_ur_user_parent_turn_key
  ON usage_records (user_id, parent_turn_key)
  WHERE parent_turn_key IS NOT NULL;

-- Backfill exact request→turn attribution from both durable states:
--   * requests not folded into a tape yet (pending_usage_patches), and
--   * requests already folded (turn_tape_cost_components + tape header).
-- Only an unambiguous mapping is applied; conflicting historical evidence is
-- left NULL for explicit operator investigation rather than guessed.
WITH raw_mapping AS (
  SELECT substring(p.user_id FROM 3)::bigint AS user_id,
         p.request_id,
         p.turn_key,
         p.parent_turn_key
    FROM pending_usage_patches p
   WHERE p.user_id ~ '^c:[1-9][0-9]*$'
     AND p.turn_key IS NOT NULL
  UNION ALL
  SELECT substring(c.user_id FROM 3)::bigint AS user_id,
         c.request_id,
         t.turn_key,
         t.parent_turn_key
    FROM turn_tape_cost_components c
    JOIN client_session_turn_tapes t
      ON t.user_id = c.user_id
     AND t.session_id = c.session_id
     AND t.tape_id = c.tape_id
   WHERE c.user_id ~ '^c:[1-9][0-9]*$'
), exact_mapping AS (
  SELECT user_id,
         request_id,
         MIN(turn_key) AS turn_key,
         MIN(parent_turn_key) AS parent_turn_key
    FROM raw_mapping
   GROUP BY user_id, request_id
  HAVING COUNT(DISTINCT turn_key) = 1
     AND COUNT(DISTINCT COALESCE(parent_turn_key, '')) = 1
)
UPDATE usage_records u
   SET turn_key = m.turn_key,
       parent_turn_key = m.parent_turn_key
  FROM exact_mapping m
 WHERE u.user_id = m.user_id
   AND u.request_id = m.request_id
   AND u.turn_key IS NULL;

CREATE TABLE turn_waivers (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  turn_key           TEXT NOT NULL CHECK (turn_key ~ '^[0-9a-f]{64}$'),
  reason             TEXT NOT NULL CHECK (reason IN (
                       'idle_timeout', 'no_response',
                       'platform_authority_expired', 'turn_limit'
                     )),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'applied')),
  refunded_credits   BIGINT NOT NULL DEFAULT 0 CHECK (refunded_credits >= 0),
  record_count       INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  inbox_message_id   BIGINT REFERENCES inbox_messages(id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at         TIMESTAMPTZ,
  UNIQUE (user_id, turn_key),
  CHECK (
    (status = 'pending' AND applied_at IS NULL AND inbox_message_id IS NULL)
    OR
    (status = 'applied' AND applied_at IS NOT NULL AND inbox_message_id IS NOT NULL)
  )
);

CREATE INDEX idx_turn_waivers_pending
  ON turn_waivers (created_at, id)
  WHERE status = 'pending';

COMMENT ON TABLE turn_waivers IS
  'Exact logical-turn billing fence. pending is committed atomically with terminal tape finalization; applied means same-owner reversal (active period bucket, otherwise owner wallet) and one targeted inbox receipt committed atomically.';
