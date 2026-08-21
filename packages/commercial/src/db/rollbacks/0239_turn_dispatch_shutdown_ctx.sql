-- Manual compensation for 0239_turn_dispatch_shutdown_ctx.
ALTER TABLE turn_dispatches DROP COLUMN IF EXISTS shutdown_ctx;
