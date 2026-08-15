-- 0209_cursor_multimodel_shared_credential.sql
-- Stage the exact non-GPT/non-Codex Cursor CLI model allowlist while the
-- compatible runtime becomes the production rollback floor. Activation and
-- user grants intentionally happen in 0210, after that first release.
-- The credential itself remains a root-only host mount and is never stored in
-- PostgreSQL. These grants do not confer credential membership.

INSERT INTO model_catalog (
  model_id, engine, provider_id, upstream_model_id, context_window,
  capability_profile, capability_schema_version, state
)
VALUES
  ('cursor-grok-4.6-high', 'cursor', 'cursor', 'cursor-grok-4.6-high', NULL,
   '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":true}}'::jsonb, 1, 'staged'),
  ('cursor-composer-2.5-fast', 'cursor', 'cursor', 'composer-2.5-fast', NULL,
   '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":true}}'::jsonb, 1, 'staged'),
  ('cursor-opus-5-high', 'cursor', 'cursor', 'claude-opus-5-thinking-high', NULL,
   '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":true}}'::jsonb, 1, 'staged'),
  ('cursor-fable-5-high', 'cursor', 'cursor', 'claude-fable-5-thinking-high', NULL,
   '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":true}}'::jsonb, 1, 'staged'),
  ('cursor-grok-4.5-high', 'cursor', 'cursor', 'cursor-grok-4.5-high', NULL,
   '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":true}}'::jsonb, 1, 'staged');

INSERT INTO model_pricing (
  model_id, display_name,
  input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, visibility, extra_system_prompt,
  default_effort, lock_version
)
VALUES
  ('cursor-grok-4.6-high', 'Cursor Grok 4.6 High', 0, 0, 0, 0, '1', FALSE,
   (SELECT sort_order+1 FROM model_pricing WHERE model_id='cursor-auto'), 'hidden', NULL, NULL, 0),
  ('cursor-composer-2.5-fast', 'Cursor Composer 2.5 Fast', 0, 0, 0, 0, '1', FALSE,
   (SELECT sort_order+2 FROM model_pricing WHERE model_id='cursor-auto'), 'hidden', NULL, NULL, 0),
  ('cursor-opus-5-high', 'Cursor Opus 5 High', 0, 0, 0, 0, '1', FALSE,
   (SELECT sort_order+3 FROM model_pricing WHERE model_id='cursor-auto'), 'hidden', NULL, NULL, 0),
  ('cursor-fable-5-high', 'Cursor Fable 5 High (Non-ZDR)', 0, 0, 0, 0, '1', FALSE,
   (SELECT sort_order+4 FROM model_pricing WHERE model_id='cursor-auto'), 'hidden', NULL, NULL, 0),
  ('cursor-grok-4.5-high', 'Cursor Grok 4.5 High', 0, 0, 0, 0, '1', FALSE,
   (SELECT sort_order+5 FROM model_pricing WHERE model_id='cursor-auto'), 'hidden', NULL, NULL, 0);

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'cursor_external_usage_audit'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%model_id%'
       AND pg_get_constraintdef(oid) LIKE '%cursor-auto%'
  LOOP
    EXECUTE format('ALTER TABLE cursor_external_usage_audit DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE cursor_external_usage_audit
    ADD CONSTRAINT cursor_external_usage_audit_model_id_check CHECK (model_id IN (
      'cursor-auto',
      'cursor-grok-4.6-high',
      'cursor-composer-2.5-fast',
      'cursor-opus-5-high',
      'cursor-fable-5-high',
      'cursor-grok-4.5-high'
    ));
END $$;

DO $$
DECLARE actual INTEGER;
BEGIN
  SELECT COUNT(*) INTO actual
    FROM model_catalog c
    JOIN model_pricing p ON p.model_id = c.model_id
   WHERE c.engine = 'cursor'
     AND c.provider_id = 'cursor'
     AND c.state = 'staged'
     AND c.context_window IS NULL
     AND p.enabled IS FALSE
     AND p.visibility = 'hidden'
     AND p.input_per_mtok = 0
     AND p.output_per_mtok = 0
     AND p.cache_read_per_mtok = 0
     AND p.cache_write_per_mtok = 0
     AND (c.model_id, c.upstream_model_id) IN (
       ('cursor-auto', NULL),
       ('cursor-grok-4.6-high', 'cursor-grok-4.6-high'),
       ('cursor-composer-2.5-fast', 'composer-2.5-fast'),
       ('cursor-opus-5-high', 'claude-opus-5-thinking-high'),
       ('cursor-fable-5-high', 'claude-fable-5-thinking-high'),
       ('cursor-grok-4.5-high', 'cursor-grok-4.5-high')
     );
  -- Row-value equality does not match the intentional NULL Auto mapping.
  IF actual <> 5 THEN
    RAISE EXCEPTION '0209 expected five staged Cursor upstream mappings, got %', actual;
  END IF;
END $$;
