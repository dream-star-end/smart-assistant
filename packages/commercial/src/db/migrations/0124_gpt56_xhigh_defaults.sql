-- 0124_gpt56_xhigh_defaults.sql
-- Product default change only: Sol and Terra default to xhigh; Luna and every
-- user's explicit preference remain untouched. This is backward-compatible
-- with the previous gateway because xhigh was already an accepted effort.

LOCK TABLE model_pricing IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  target_count INTEGER;
  updated_count INTEGER;
  luna_before TEXT;
BEGIN
  SELECT COUNT(*), MAX(default_effort) FILTER (WHERE model_id = 'gpt-5.6-luna')
    INTO target_count, luna_before
    FROM model_pricing
   WHERE model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
     AND display_name = CASE model_id
       WHEN 'gpt-5.6-sol' THEN 'GPT-5.6-Sol'
       WHEN 'gpt-5.6-terra' THEN 'GPT-5.6-Terra'
       WHEN 'gpt-5.6-luna' THEN 'GPT-5.6-Luna'
     END;

  IF target_count <> 3 THEN
    RAISE EXCEPTION '0124: expected the three exact GPT-5.6 model rows, got %', target_count;
  END IF;

  -- Hold the model rows while changing the two product defaults.
  PERFORM 1
    FROM model_pricing
   WHERE model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
   FOR UPDATE;

  UPDATE model_pricing
     SET default_effort = 'xhigh',
         lock_version = lock_version + 1,
         updated_at = NOW()
   WHERE model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra');
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  IF updated_count <> 2 THEN
    RAISE EXCEPTION '0124: expected exactly 2 defaults updated, got %', updated_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing
     WHERE model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra')
       AND default_effort IS DISTINCT FROM 'xhigh'
  ) THEN
    RAISE EXCEPTION '0124: Sol/Terra final default is not xhigh';
  END IF;

  IF (SELECT default_effort FROM model_pricing WHERE model_id = 'gpt-5.6-luna')
       IS DISTINCT FROM luna_before THEN
    RAISE EXCEPTION '0124: Luna default changed unexpectedly';
  END IF;

END $$;
