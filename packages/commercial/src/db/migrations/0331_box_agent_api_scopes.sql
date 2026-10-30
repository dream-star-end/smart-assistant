-- 0331: exact invocation generation and irreversible future-launch cancellation.
-- order-dependency: 0330_turn_lease_binding
-- compat: independent additive control table; legacy requests/journal/billing are unchanged.
-- Apply 0330_turn_lease_binding first in both release lanes.
CREATE TABLE box_agent_api_scopes (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container_id BIGINT NOT NULL REFERENCES agent_containers(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  root_session_id UUID NOT NULL,
  session_id UUID NOT NULL,
  agent_id TEXT NOT NULL CHECK (agent_id ~ '^[A-Za-z0-9._:-]{1,256}$'),
  turn_key TEXT NOT NULL CHECK (turn_key ~ '^[a-f0-9]{64}$'),
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT CHECK (cancel_reason IN ('explicit-stop','finish','owner-lost')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id,container_id,scope_id),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL))
);
CREATE INDEX idx_box_agent_api_scopes_session ON box_agent_api_scopes(user_id,session_id);
COMMENT ON TABLE box_agent_api_scopes IS
  'Non-financial invocation control. Cancellation fences future admission/launch only; never physical-run terminal evidence or capacity release.';
CREATE FUNCTION fn_guard_box_agent_api_scope_update() RETURNS TRIGGER LANGUAGE plpgsql AS $scope_guard$
BEGIN
  IF ROW(NEW.user_id,NEW.container_id,NEW.scope_id,NEW.root_session_id,NEW.session_id,NEW.agent_id,NEW.turn_key)
       IS DISTINCT FROM ROW(OLD.user_id,OLD.container_id,OLD.scope_id,OLD.root_session_id,OLD.session_id,OLD.agent_id,OLD.turn_key)
     OR (OLD.cancelled_at IS NOT NULL AND
       ROW(NEW.cancelled_at,NEW.cancel_reason) IS DISTINCT FROM ROW(OLD.cancelled_at,OLD.cancel_reason)) THEN
    RAISE EXCEPTION 'BOX_AGENT_SCOPE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$scope_guard$;
CREATE TRIGGER box_agent_api_scope_immutable BEFORE UPDATE ON box_agent_api_scopes
  FOR EACH ROW EXECUTE FUNCTION fn_guard_box_agent_api_scope_update();
GRANT SELECT, INSERT, UPDATE ON box_agent_api_scopes TO CURRENT_USER;

-- The deployed egress application may be separate from the migration owner.
-- compat: Grant only this new non-financial control table when the existing app role is present.
DO $scope_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='openclaude_app') THEN
    GRANT SELECT, INSERT, UPDATE ON box_agent_api_scopes TO openclaude_app;
    REVOKE DELETE, TRUNCATE ON box_agent_api_scopes FROM openclaude_app;
  END IF;
END
$scope_grant$;
