-- 0145 — retire legacy incident lifecycle messages from the user inbox.
--
-- Incident rows remain the internal operations ledger. User-visible recovery
-- notices now have a separate, fail-closed approval path and must never be
-- reconstructed from the legacy incident inbox channel.

DELETE FROM inbox_messages
 WHERE source_type = 'incident';
