-- Rollback for 0348_commercial_pending_browser_handoffs.sql (OCV5-832 / OCV5-856)

DROP INDEX IF EXISTS idx_pending_browser_handoffs_user_status;
DROP TABLE IF EXISTS pending_browser_handoffs;
