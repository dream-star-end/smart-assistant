-- 0268_desktop_session_secret_generation.sql
-- order-dependency: 0267_turn_dispatches_agent_container
--
-- P1-IMPL-03: persistent token generation fence.
-- NOT NULL DEFAULT 0 is safe for existing docker and desktop rows.
-- Refresh/mint CAS: SELECT ... FOR UPDATE then UPDATE ... WHERE generation = old.

ALTER TABLE agent_containers
  ADD COLUMN IF NOT EXISTS session_secret_generation INTEGER NOT NULL DEFAULT 0;
