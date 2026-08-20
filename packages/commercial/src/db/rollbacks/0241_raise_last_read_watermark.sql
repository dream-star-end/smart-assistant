-- Manual compensation for 0241_raise_last_read_watermark.
-- Restores the 0240 watermark (last_at). Cannot reconstruct unread-migrate zeros.
UPDATE client_sessions
   SET last_read_at = last_at
 WHERE last_at IS NOT NULL;
