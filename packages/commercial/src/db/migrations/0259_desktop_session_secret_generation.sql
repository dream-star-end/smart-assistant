-- 0259_desktop_session_secret_generation.sql
-- order-dependency: none (0258_cursor_opus_fable_context_1m 由 origin/feat/v5-aurora-rewrite 占用且尚未合入本分支;本迁移只给 agent_containers 加 generation 列,不依赖 0258 schema,可独立 apply。)
--
-- P1-IMPL-03: persistent token generation fence.
-- NOT NULL DEFAULT 0 is safe for existing docker and desktop rows.
-- Refresh/mint CAS: SELECT ... FOR UPDATE then UPDATE ... WHERE generation = old.

ALTER TABLE agent_containers
  ADD COLUMN IF NOT EXISTS session_secret_generation INTEGER NOT NULL DEFAULT 0;
