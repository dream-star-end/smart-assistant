-- 0193: route serving-master process/health incidents to a deterministic,
-- parameter-free Tier1 action. Activation remains an explicit production step:
-- both policies stay auto_repair=FALSE until the personal executor and the
-- kl-mirror forced-command wrapper advertise the exact opcode and each condition
-- has passed its own supervised fault injection.

BEGIN;

DO $$
DECLARE
  v_rows INTEGER;
BEGIN
  UPDATE incident_policies
     SET auto_repair = FALSE,
         execution_class = 'tier1',
         action_opcode = 'restart-v5-active-master-v1',
         updated_at = NOW()
   WHERE match_kind = 'prefix'
     AND match_key IN ('ops.monitor:svc_v5', 'ops.monitor:http_v5');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 2 THEN
    RAISE EXCEPTION
      '0193 expected exactly 2 active-master policies, updated %', v_rows;
  END IF;
END
$$;

COMMIT;
