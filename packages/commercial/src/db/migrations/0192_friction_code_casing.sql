-- 0192 — align product friction code casing with the browser contract.
--
-- 0151 constrained `code` to uppercase while POST /api/client-errors accepts
-- bounded lower/mixed-case semantic codes. Valid reports therefore reached the
-- INSERT and failed the CHECK. This is rolling-compatible: old writers keep
-- writing uppercase codes, while current writers may persist lowercase codes.

ALTER TABLE product_friction_events
  DROP CONSTRAINT IF EXISTS product_friction_events_code_check;

ALTER TABLE product_friction_events
  ADD CONSTRAINT product_friction_events_code_check
  CHECK (code ~ '^[A-Za-z0-9_]{1,64}$');
