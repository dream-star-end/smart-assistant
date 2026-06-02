-- WeChat/iLink outbox transient backoff.
--
-- v1.0.256 fixed the immediate ret=-2 retry storm by breaking the worker tick,
-- but rows were still re-queued as immediately eligible.  Add an explicit
-- per-row retry time so the drain worker can back off transient iLink failures
-- without exhausting attempts in a tight loop.  The worker also uses this
-- column together with per-conversation head-of-line picking so a final answer
-- cannot outrun an older backed-off process row for the same WeChat session.

ALTER TABLE wechat_outbox
  ADD COLUMN IF NOT EXISTS next_attempt_at BIGINT;

ALTER TABLE wechat_outbox
  DROP CONSTRAINT IF EXISTS wox_next_attempt_at_chk,
  ADD CONSTRAINT wox_next_attempt_at_chk
    CHECK (next_attempt_at IS NULL OR next_attempt_at > 0);

CREATE INDEX IF NOT EXISTS idx_wox_drain_ready
  ON wechat_outbox(status, next_attempt_at, created_at, id)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_wox_conversation_pending
  ON wechat_outbox(binding_user_id, sender_id, session_id, created_at, id)
  WHERE status IN ('queued', 'sending');
