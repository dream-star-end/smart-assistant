-- 0203_admin_ops_outreach — additive admin operations/outreach truth fields.
--
-- Forward-only rules:
--   * every new column is nullable; historical rows are not guessed/backfilled;
--   * feedback traffic_class is a write-time snapshot for authenticated users only;
--   * inbox audience rows are immutable send-time snapshots for messages created
--     after this migration. Historical messages remain explicitly unavailable;
--   * product-friction entity_slug is populated only by new authoritative events.

ALTER TABLE feedback
  ADD COLUMN traffic_class TEXT
    CHECK (traffic_class IN ('production_user','internal_admin','synthetic_canary','e2e')),
  ADD COLUMN assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN priority TEXT
    CHECK (priority IN ('low','normal','high','urgent')),
  ADD COLUMN resolution TEXT;

CREATE INDEX idx_feedback_traffic_status_created
  ON feedback(traffic_class,status,created_at DESC,id DESC)
  WHERE traffic_class IS NOT NULL;

ALTER TABLE auto_dream_platform_findings
  ADD COLUMN owner TEXT CHECK (owner IS NULL OR char_length(owner) BETWEEN 1 AND 128);

CREATE TABLE inbox_message_audience_snapshots (
  message_id BIGINT NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id,user_id)
);

CREATE INDEX idx_inbox_audience_snapshot_user
  ON inbox_message_audience_snapshots(user_id,message_id DESC);

ALTER TABLE inbox_messages ADD COLUMN audience_snapshotted_at TIMESTAMPTZ;

COMMENT ON TABLE inbox_message_audience_snapshots IS
  'Immutable send-time audience membership for post-0203 inbox messages. Historical messages are intentionally not backfilled.';

CREATE FUNCTION capture_inbox_message_audience()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.audience='user' THEN
    INSERT INTO inbox_message_audience_snapshots(message_id,user_id)
    VALUES (NEW.id,NEW.user_id);
  ELSE
    INSERT INTO inbox_message_audience_snapshots(message_id,user_id)
    SELECT NEW.id,u.id FROM users u
     WHERE u.status='active' AND u.created_at<=NEW.created_at;
  END IF;
  UPDATE inbox_messages SET audience_snapshotted_at=NOW() WHERE id=NEW.id;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_capture_inbox_message_audience
AFTER INSERT ON inbox_messages
FOR EACH ROW EXECUTE FUNCTION capture_inbox_message_audience();

ALTER TABLE product_friction_events
  ADD COLUMN entity_slug VARCHAR(128)
    CHECK (entity_slug IS NULL OR entity_slug ~ '^[a-z0-9][a-z0-9._-]{0,127}$');

CREATE INDEX idx_product_friction_marketplace_journey
  ON product_friction_events(user_id,entity_slug,stage,created_at DESC)
  WHERE surface='marketplace' AND user_id IS NOT NULL AND entity_slug IS NOT NULL;
